'use strict'

/**
 * payCallback 的售后模块 —— 退款写口 + 定时对账（P1-6 / P1-7，2026-10-09）。
 *
 * 为什么长在 payCallback 上，而不是新开一个云函数：
 * 本函数是全项目**唯一允许写会员数据的地方**（发货时双写 `memberships` 权威 + `users.membership` 镜像）。
 * 撤销会员同样是写会员数据 —— 换个地方写，这条不变量就只剩一半，「会员为什么变了」不再只有一个答案。
 * 顺带也不新增部署单元：对账挂在 payCallback 自己的定时触发器上（cloudbaserc.json 的 `payReconcile`）。
 *
 * 本模块做三件事 + 一个写口，全部**幂等、可重复跑**（对账的全部价值就在这里）：
 *   ① 补发货：`granting` 残留且已超出微信重试窗口 ⇒ 继续发货 + 置 `paid`（P1-7 前半）
 *   ② 补镜像：权威行与镜像行不一致 ⇒ **以权威覆盖镜像**（P1-7 后半）
 *   ③ 撤销：订单已 `refunded` 且未处理过 ⇒ 从会员有效期里扣掉这一单买的天数（P1-6）
 *   ④ `adminOp:'refund'`：运营写口，把订单置 `refunded`（能这么写订单的只有它）
 *
 * 四处边界（都是最容易做错的地方）：
 *   - ② 只能「以权威覆盖镜像」，**绝不能反方向**。users 是「仅创建者可读写」，端上能改自己那一行；
 *     反过来信镜像 = 承认端上自授的会员（A2 的全部意义就在于此）。因此「镜像有会员、权威行却不存在」
 *     这种（迁移期老会员的）形态本函数**故意不管** —— 那正是端上伪造会员的样子，无从分辨；
 *     它会在用户下次付款时经 payCallback 的分支 ② 补齐（那里有订单号可对，分辨得了）。
 *     反过来说：本函数做的是「把端上能改的那份拉回与权威一致」，跑得越勤，端上伪造的窗口越小。
 *   - ③ 只扣「这一单确实发过货」的天数（`granted_at` 有值，或权威行 `last_order_id` 命中这一单）。
 *     没发过货的退款单只改订单状态、不碰会员 —— 否则会连用户其它订单买的天数一起吞掉。
 *     扣减按 `max(now, 原有效期 - days)`：只退掉这一单的，不顺带把用户变成「从未是会员」。
 *   - ① 只碰超出微信重试窗口的 `granting`：让微信自己补优先（它更快，退避重试到 24 小时），
 *     对账只在它彻底放弃之后兜底。窗口取 30 分钟，与最长一次退避（3600 秒）同量级。
 *   - ④ 拒绝 `granting` 态的订单：那时候货发到一半，置 `refunded` 会和发货竞态
 *     （回调路径会把 `granting` 继续推到 `paid`），让运营等一轮再调，比写一段并发处理便宜。
 *
 * 依赖注入：本文件不 require wx-server-sdk（要能被 test/cases/09 用内存 DB 直接跑），
 * 与库、与发货逻辑有关的一切都由 index.js 传进来。
 */

/** 微信重试窗口：v2 通知的退避最长 3600 秒；窗口内的 `granting` 一律让微信自己补 */
const GRANTING_TIMEOUT_MS = 30 * 60 * 1000
/** 每轮最多处理多少单：一轮跑太久会撞云函数超时（payCallback 是 60 秒） */
const SCAN_LIMIT = 20
/** memberships 每轮最多扫多少行（与其它定时任务的 limit 100 同口径） */
const MIRROR_SCAN_LIMIT = 100
/** 权威行上「已撤销退款的订单号」名单保留多少条（真正的幂等判据在订单行的 refund_revoked_at，
 *  这个名单只用来自愈「扣了权威、还没写标记」那一段，留 20 条远够） */
const REFUND_LOG_MAX = 20

module.exports = function createAfterSales(deps) {
  const {
    db,
    log,
    tsOf,
    DAY_MS,
    readOrder,
    readMembership,
    writeMembership,
    writeMirror,
    grantMembership,
    markGranted,
    findUserRow
  } = deps

  const nowIso = () => new Date().toISOString()
  const msgOf = (err) => (err && err.message) || String(err)

  /* ─────────────────────── ③⑥ 撤销：一单退款扣一次天数 ─────────────────────── */

  /**
   * 撤销一单的会员天数。返回 `{ revoked, skipped }`；**只在真故障时抛错**（调用方各自决定怎么办）。
   * `skipped` 的取值同时是「为什么没扣」的说明，会写进订单行的 `refund_revoke_note`。
   *
   * 幂等靠**权威行里的 `refunded_orders` 名单**，而不是靠订单行的 `refund_revoked_at`：
   * 「扣权威」与「写订单标记」之间没有事务，若以标记去重，一次中途失败（比如 users 写不进去）
   * 就会让下一轮**再扣一次天数** —— 用户付过钱的天数被吃掉两遍，是本项目最不能接受的失败模式。
   * 名单与扣减写在同一次 set 里（`writeMembership` 是 upsert），于是「扣了」与「记了」必然同时发生；
   * 万一卡在扣完之后、写镜像之前，下一轮读到名单就会只补镜像、不再扣减。
   */
  async function revokeOrder(order) {
    const outTradeNo = String(order._id || '')
    const openid = order._openid
    const days = Number(order.days) || 0
    if (!outTradeNo || !openid) return { revoked: false, skipped: '订单缺 _id / _openid' }

    const auth = await readMembership(openid)
    /* 「确实发过货」的两个证据：订单侧留了 granted_at，或权威行记录的就是这一单。
       只有其中一个成立，才有天数可扣 —— 否则这单的 days 从来没有加到任何人头上。 */
    const shipped = Boolean(order.granted_at) || Boolean(auth && auth.last_order_id === outTradeNo)
    if (!shipped) return { revoked: false, skipped: '未发过货，无需扣减' }
    if (!auth) return { revoked: false, skipped: '权威行缺失' }

    const logged = Array.isArray(auth.refunded_orders) ? auth.refunded_orders : []
    const already = logged.indexOf(outTradeNo) >= 0
    let expiresAt = auth.expires_at

    if (!already) {
      if (days <= 0) return { revoked: false, skipped: '订单天数非法' }
      /* 扣减基数取**权威**的有效期（不信镜像：那是端上能改的一份），下限是现在 ——
         只退掉这一单买的天数，不顺带把用户变成「从未是会员」 */
      const base = tsOf(auth.expires_at)
      expiresAt = new Date(Math.max(Date.now(), base - days * DAY_MS)).toISOString()
      /* 先权威后镜像 —— 与发货同一个顺序、同一套理由：权威生效即「云端认的会员已经变了」 */
      await writeMembership(openid, {
        plan: auth.plan,
        expires_at: expiresAt,
        last_order_id: auth.last_order_id,
        refunded_orders: logged.concat([outTradeNo]).slice(-REFUND_LOG_MAX)
      })
      log(`退款撤销：订单 ${outTradeNo} openid=${openid} 扣 ${days} 天，有效期 ${auth.expires_at} → ${expiresAt}`)
    } else {
      log(`退款撤销：订单 ${outTradeNo} 已扣过（权威行 refunded_orders 命中），本次只补镜像`)
    }

    const row = await findUserRow(openid)
    if (row) {
      await writeMirror(row._id, openid, {
        plan: auth.plan,
        expires_at: expiresAt,
        last_order_id: auth.last_order_id
      })
    }

    return { revoked: !already, skipped: already ? '已扣过，本次只补镜像' : null, expires_at: expiresAt }
  }

  /**
   * 结清一单退款：撤销会员 + 在订单上留 `refund_revoked_at`。
   * 标记必须在**撤销成功或确认无需撤销**之后才写 —— 先写标记再撤销，失败那趟就永远不会重试了。
   */
  async function settleRefund(order) {
    const outTradeNo = String(order._id || '')
    const r = await revokeOrder(order)
    await db
      .collection('orders')
      .doc(outTradeNo)
      .update({ data: { refund_revoked_at: nowIso(), refund_revoke_note: r.skipped || null } })
    if (!r.revoked) log(`退款订单 ${outTradeNo} 无需扣减：${r.skipped}`)
    return r
  }

  /* ───────────────────────── ①②③ 对账：一轮扫三类残留 ───────────────────────── */

  /** ① granting 残留：付了钱、微信重试也放弃了、货还停在半路 */
  async function reconcileStaleGrants(summary) {
    const res = await db.collection('orders').where({ status: 'granting' }).limit(SCAN_LIMIT).get()
    for (const order of res.data || []) {
      if (!order || !order._id) continue
      const waited = Date.now() - tsOf(order.paid_at)
      if (waited < GRANTING_TIMEOUT_MS) {
        /* paid_at 缺失时 tsOf 给 0 ⇒ waited 极大 ⇒ 视为超时：畸形行更该被补，不该被放过 */
        summary.skipped.push(`${order._id}: 仍在微信重试窗口内`)
        continue
      }
      summary.granting++
      try {
        await grantMembership(order, order._id)
        await markGranted(order._id)
        summary.granted++
        log(`对账补发货：订单 ${order._id} 已推至 paid（原先停在 granting ${Math.round(waited / 60000)} 分钟）`)
      } catch (err) {
        /* 一条坏不拖垮整轮：下一轮还会扫到它（`granting` 没被改过） */
        summary.skipped.push(`${order._id}: ${msgOf(err)}`)
        log(`对账补发货失败（下一轮再试）：订单 ${order._id} —— ${msgOf(err)}`)
      }
    }
  }

  /** ② 镜像与权威不一致：以权威覆盖镜像（含「端上改了自己那一行」这种） */
  async function reconcileMirrors(summary) {
    const res = await db.collection('memberships').limit(MIRROR_SCAN_LIMIT).get()
    for (const auth of res.data || []) {
      const openid = auth && (auth._id || auth._openid)
      if (!openid) continue
      try {
        const row = await findUserRow(openid)
        if (!row) {
          summary.skipped.push(`镜像 ${openid}: 无 users 行`)
          continue
        }
        const m = row.membership || null
        const same =
          m &&
          m.plan === auth.plan &&
          m.expires_at === auth.expires_at &&
          m.last_order_id === auth.last_order_id
        if (same) continue
        await writeMirror(row._id, openid, {
          plan: auth.plan,
          expires_at: auth.expires_at,
          last_order_id: auth.last_order_id
        })
        summary.mirrors++
        log(`对账补镜像：openid=${openid}（权威 last_order_id=${auth.last_order_id}）`)
      } catch (err) {
        summary.skipped.push(`镜像 ${openid}: ${msgOf(err)}`)
        log(`对账补镜像失败（下一轮再试）：openid=${openid} —— ${msgOf(err)}`)
      }
    }
  }

  /** ③ 已退款但还没撤销过会员的订单 */
  async function reconcileRefunds(summary) {
    const res = await db.collection('orders').where({ status: 'refunded' }).limit(SCAN_LIMIT).get()
    for (const order of res.data || []) {
      if (!order || !order._id || order.refund_revoked_at) continue
      summary.refunded++
      try {
        const r = await settleRefund(order)
        if (r.revoked) summary.revoked++
      } catch (err) {
        summary.skipped.push(`退款 ${order._id}: ${msgOf(err)}`)
        log(`退款撤销失败（下一轮再试）：订单 ${order._id} —— ${msgOf(err)}`)
      }
    }
  }

  /**
   * 一轮对账（定时触发器 `payReconcile` 触发，或运营用 `adminOp:'reconcile'` 手动跑）。
   * 单类失败不影响其它两类：这里刻意**不**兜住整体异常 —— 三类各自的 for 里已经逐条兜住，
   * 真从外面抛出来的只可能是「整张表读不到」，那本该在日志里显眼一点。
   */
  async function reconcile() {
    const summary = {
      ok: true,
      at: nowIso(),
      granting: 0,
      granted: 0,
      mirrors: 0,
      refunded: 0,
      revoked: 0,
      skipped: []
    }
    await reconcileStaleGrants(summary)
    await reconcileMirrors(summary)
    await reconcileRefunds(summary)
    log(
      `对账完成：granting 候选 ${summary.granting} / 补发货 ${summary.granted}，` +
      `补镜像 ${summary.mirrors}，退款单 ${summary.refunded} / 撤销 ${summary.revoked}，` +
      `跳过 ${summary.skipped.length}`
    )
    return summary
  }

  /* ───────────────────────── ④ 运营写口：adminOp ───────────────────────── */

  /**
   * 把订单置 `refunded`。**不改会员** —— 撤销交给 settleRefund（幂等、失败可重跑、对账还能兜底）。
   *
   * 退款是「在微信商户平台退的钱」，业务侧唯一能拿到的信号就是人工告知；本写口就是把那句
   * 告知落成一个状态迁移。客服/运营在云开发控制台的「云端测试」里调：
   *   { "adminOp": "refund", "token": "<PAY_ADMIN_TOKEN>", "outTradeNo": "MR...", "reason": "用户申请退款" }
   */
  async function adminRefund(event) {
    const outTradeNo = String(event.outTradeNo || '')
    if (!outTradeNo) return { ok: false, error: '缺少 outTradeNo' }

    const order = await readOrder(outTradeNo)
    if (!order) return { ok: false, error: `订单不存在：${outTradeNo}` }
    if (order.status === 'refunded') return { ok: true, already: true, order: outTradeNo }
    if (order.status === 'granting') {
      return { ok: false, error: `订单 ${outTradeNo} 正在发货中（granting），请 1 分钟后重试` }
    }

    await db
      .collection('orders')
      .doc(outTradeNo)
      .update({
        data: {
          status: 'refunded',
          refunded_at: nowIso(),
          refund_reason: String(event.reason || '').slice(0, 200) || null
        }
      })
    log(`运营置退款：订单 ${outTradeNo}（原状态 ${order.status}）${event.reason ? `，原因：${event.reason}` : ''}`)

    try {
      const r = await settleRefund(Object.assign({}, order, { _id: outTradeNo }))
      return { ok: true, order: outTradeNo, revoked: r.revoked, note: r.skipped || null }
    } catch (err) {
      /* 订单已经置成 refunded 了，撤销失败不该让它看起来没生效：对账任务会重试这一单
         （`refund_revoked_at` 没写，它下轮还会被扫到） */
      log(`退款已置位，但撤销会员失败（留给对账重试）：订单 ${outTradeNo} —— ${msgOf(err)}`)
      return { ok: true, order: outTradeNo, revoked: false, note: `撤销失败，对账任务会重试：${msgOf(err)}` }
    }
  }

  /**
   * adminOp 总闸：口令闸门 + 分派。
   *
   * 口令语义与 dbInit 的 `DB_ADMIN_TOKEN` 完全一致：**未配置环境变量 ⇒ 一律拒绝**（fail closed）。
   * 「没配就放行」是最常见的一种自我安慰 —— 而运营口令通常恰恰是「忘了配」的那一项。
   * 调用方身份另有一道闸门（`exports.main` 的 callerGuard）：端上调用在这里连门都进不来。
   */
  async function handleAdminOp(event) {
    const op = String(event.adminOp || '')
    const required = process.env.PAY_ADMIN_TOKEN
    if (!required) {
      return { ok: false, error: '拒绝：未配置环境变量 PAY_ADMIN_TOKEN（运营写口一律拒绝）' }
    }
    if (String(event.token || '') !== required) {
      return { ok: false, error: '拒绝：event.token 与环境变量 PAY_ADMIN_TOKEN 不符' }
    }

    if (op === 'refund') return adminRefund(event)
    if (op === 'reconcile') return Object.assign({ manual: true }, await reconcile())
    return { ok: false, error: `未知 adminOp：${op}（支持 refund / reconcile）` }
  }

  return { handleAdminOp, reconcile, settleRefund }
}
