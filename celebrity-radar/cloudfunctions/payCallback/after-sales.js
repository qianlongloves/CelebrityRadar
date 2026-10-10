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
/**
 * 同一单最多自动补救几次（P2-24）。超过就只记日志、不再自动重试 —— 交给人工。
 *
 * 为什么需要「有界」：`where({ status:'granting' }).limit(20)` 取的是**前 20 个**，
 * 一条怎么都补不成功的坏单（比如 users 行被删了）会永远留在结果集里 ——
 * 每轮占一个名额、每轮重试一次，把 20 个名额慢慢吃光，后面的单再也进不来（队列饿死）。
 * 配合「按 reconcile_attempts 升序」取单，坏单每失败一次就往后排一点，最多 5 轮就沉到队尾。
 */
const MAX_RECONCILE_ATTEMPTS = 5
/**
 * memberships 每轮校验多少行（P2-23：按 mirror_checked_at 轮转，不是「每次都扫前 100 行」）。
 * 取 100 是因为一轮里每行都要多打一次 users 查询，行数再多容易撞云函数超时；靠轮转保证覆盖。
 */
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
    /*
     * P2-24：**按 reconcile_attempts 升序 + _id 升序**取单，而不是裸 limit(20)。
     * 裸 limit 的问题：`where({status:'granting'})` 是一个**不断有成员进出、但坏成员只进不出**的集合，
     * 不排序时取哪 20 条完全由存储顺序决定 —— 一条补不成功的坏单会长期占着名额并反复重试，
     * 把队列堵死（其余待补单永远排不进前 20）。排序后：没试过的单据最前，试得多的沉到后面。
     * 缺失 `reconcile_attempts` 的老行按 undefined 排最前 —— 正好是「优先补偿积压」。
     */
    const res = await db
      .collection('orders')
      .where({ status: 'granting' })
      .orderBy('reconcile_attempts', 'asc')
      .orderBy('_id', 'asc')
      .limit(SCAN_LIMIT)
      .get()
    for (const order of res.data || []) {
      if (!order || !order._id) continue
      const attempts = Number(order.reconcile_attempts) || 0
      if (attempts >= MAX_RECONCILE_ATTEMPTS) {
        /* 自动补救已到上限：不再重试、也不再让它占着名额，只留一条显眼的日志等人工 */
        summary.stuck++
        summary.skipped.push(`${order._id}: 自动补发货已试 ${attempts} 次仍未成功，转人工核查`)
        continue
      }
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
        /* 一条坏不拖垮整轮：下一轮还会扫到它（`granting` 没被改过），但要记一次失败次数，
           否则它会一直占着前 20 个名额，把后面的单饿死（见 MAX_RECONCILE_ATTEMPTS） */
        await bumpReconcileAttempts(order._id, attempts)
        summary.skipped.push(`${order._id}: ${msgOf(err)}`)
        log(`对账补发货失败（第 ${attempts + 1} 次，下一轮再试）：订单 ${order._id} —— ${msgOf(err)}`)
      }
    }
  }

  /**
   * 记一次自动补救失败（P2-24）。写失败只记日志、不改变本轮结论 ——
   * 它是「队列公平性」的元数据，丢一次至多多重试一轮，不该让它把整轮对账带崩。
   */
  async function bumpReconcileAttempts(outTradeNo, attempts) {
    try {
      await db
        .collection('orders')
        .doc(outTradeNo)
        .update({ data: { reconcile_attempts: attempts + 1 } })
    } catch (err) {
      log(`记录对账重试次数失败（不影响本轮）：订单 ${outTradeNo} —— ${msgOf(err)}`)
    }
  }

  /** ② 镜像与权威不一致：以权威覆盖镜像（含「端上改了自己那一行」这种） */
  async function reconcileMirrors(summary) {
    /*
     * P2-23：**按 mirror_checked_at 升序轮转**，而不是裸 `limit(100)`。
     *
     * 裸 limit 的问题不在「只取一批」，而在「每一轮都取同一批」：memberships 超过 100 行之后，
     * 第 101 个及以后的会员永远不会被校验，镜像漂移在那里永久保留 —— 而且日志一切正常，
     * 没有任何迹象表明「对账只覆盖了前 100 个人」。
     *
     * 游标就是权威行上的 `mirror_checked_at`（缺字段的行排最前，正好优先校验新发货的行）：
     * 本轮校验过的写入「现在」，下一轮自然排到队尾，于是 N 行数据最多 ⌈N / MIRROR_SCAN_LIMIT⌉ 轮
     * 一定全部轮到。**成败都写回**：失败的行若一直占着队首，就会把后面的行饿死（与 P2-24 同理）。
     */
    const res = await db
      .collection('memberships')
      .orderBy('mirror_checked_at', 'asc')
      .limit(MIRROR_SCAN_LIMIT)
      .get()

    const checked = []
    for (const auth of res.data || []) {
      const openid = auth && (auth._id || auth._openid)
      if (!openid) continue
      checked.push(openid)
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
        /*
         * P2-35：上面 `auth` 来自**批量快照**，而批量读到逐行写之间有真实的时间差（本轮最多 100 行）。
         * 这期间若有人刚发货或刚退款，权威的有效期已经变了，而我们拿快照里的旧值去覆盖镜像 ——
         * 于是镜像被写成一个「权威已经否掉」的有效期，用户端上看到的是错的会员状态。
         * 这种不一致会靠下一轮自愈，但下一轮是 ⌈N/100⌉ 轮之后，可能很久。
         *
         * 修法：**真要写之前再读一次权威**，以最新值为准。漂移是少数情况，所以这次额外读
         * 只发生在「已判定需要写」的时候，不改变正常路径的读放大。
         */
        const fresh = await readMembership(openid)
        if (!fresh) {
          summary.skipped.push(`镜像 ${openid}: 读回权威行时已消失，跳过本轮`)
          continue
        }
        const fm = row.membership || null
        const stillSame =
          fm && fm.plan === fresh.plan && fm.expires_at === fresh.expires_at && fm.last_order_id === fresh.last_order_id
        if (stillSame) continue
        await writeMirror(row._id, openid, {
          plan: fresh.plan,
          expires_at: fresh.expires_at,
          last_order_id: fresh.last_order_id
        })
        summary.mirrors++
        log(`对账补镜像：openid=${openid}（权威 last_order_id=${fresh.last_order_id}）`)
      } catch (err) {
        summary.skipped.push(`镜像 ${openid}: ${msgOf(err)}`)
        log(`对账补镜像失败（下一轮再试）：openid=${openid} —— ${msgOf(err)}`)
      }
    }

    /* 批量写回轮转游标（一次 update 覆盖本轮所有行，别逐行打 100 次往返）。
       注意这个字段是「对账进度」，不是会员数据 —— 它由 writeMembership 的整篇 set 自然清掉，
       所以每次发货/退款后那一行会重新排回队首再校验一次，正是我们想要的。 */
    if (!checked.length) return
    try {
      await db
        .collection('memberships')
        .where({ _id: db.command.in(checked) })
        .update({ data: { mirror_checked_at: nowIso() } })
    } catch (err) {
      summary.skipped.push(`镜像轮转游标写回失败：${msgOf(err)}`)
      log(`镜像轮转游标写回失败（下一轮会重复校验这一批）：${msgOf(err)}`)
    }
  }

  /** ③ 已退款但还没撤销过会员的订单 */
  async function reconcileRefunds(summary) {
    /*
     * P2-24（本类的问题比 ① 更严重）：撤销完成的单**不会离开** `status:'refunded'` 结果集 ——
     * 它只是被下面那个 `if (order.refund_revoked_at) continue` 跳过。于是裸
     * `where({status:'refunded'}).limit(20)` 的前 20 名，迟早会被「已撤销完的历史单」占满，
     * 此后**新的退款单一条也扫不到**（症状：退了款却不扣会员，日志里连一行都没有）。
     *
     * 修法：查询上就把已结清的单排除掉 —— 「待撤销」= `refund_revoked_at` 字段缺席**或**为 null
     * （老行不带这个字段、显式撤销过的写的是时间串、新建/中途的行可能是 null，三种都要覆盖）。
     * 再叠 ① 那套 attempts 升序（坏单下沉）与 _id 升序（先来先处理），与 ① 保持同一套排队规则。
     *
     * 注意**不要**改回「按 refund_revoked_at 升序取一批」：升序在真机上确实把缺席值排最前，
     * 但「缺席 vs 字符串」的大小比较在 JS 侧不是全序（null > 'x' 与 'x' > null 同时为假），
     * 排序结果会退化成「取决于原始顺序」—— 正确性不能建立在这种隐式排序上。
     */
    const _ = db.command
    const res = await db
      .collection('orders')
      .where(
        _.and([
          { status: 'refunded' },
          _.or([{ refund_revoked_at: _.exists(false) }, { refund_revoked_at: null }])
        ])
      )
      .orderBy('reconcile_attempts', 'asc')
      .orderBy('_id', 'asc')
      .limit(SCAN_LIMIT)
      .get()
    for (const order of res.data || []) {
      if (!order || !order._id || order.refund_revoked_at) continue
      const attempts = Number(order.reconcile_attempts) || 0
      if (attempts >= MAX_RECONCILE_ATTEMPTS) {
        summary.stuck++
        summary.skipped.push(`退款 ${order._id}: 自动撤销已试 ${attempts} 次仍未成功，转人工核查`)
        continue
      }
      summary.refunded++
      try {
        const r = await settleRefund(order)
        if (r.revoked) summary.revoked++
      } catch (err) {
        await bumpReconcileAttempts(order._id, attempts)
        summary.skipped.push(`退款 ${order._id}: ${msgOf(err)}`)
        log(`退款撤销失败（第 ${attempts + 1} 次，下一轮再试）：订单 ${order._id} —— ${msgOf(err)}`)
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
      /** 自动补救次数用尽的单（P2-24）：>0 就该有人去看一眼，别只看 skipped 的总数 */
      stuck: 0,
      skipped: []
    }
    await reconcileStaleGrants(summary)
    await reconcileMirrors(summary)
    await reconcileRefunds(summary)
    log(
      `对账完成：granting 候选 ${summary.granting} / 补发货 ${summary.granted}，` +
      `补镜像 ${summary.mirrors}，退款单 ${summary.refunded} / 撤销 ${summary.revoked}，` +
      `转人工 ${summary.stuck}，跳过 ${summary.skipped.length}`
    )
    if (summary.stuck > 0) {
      log(`⚠ 有 ${summary.stuck} 笔订单自动补救已达 ${MAX_RECONCILE_ATTEMPTS} 次上限，请人工核查（见 skipped 明细）`)
    }
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

  /* ───────────────────────── ⑤ 运营写口：手动发放会员 ───────────────────────── */

  /**
   * 手动发放会员（联调 / 人工补偿用）：不经过订单，直接给指定 openid 续 `days` 天。
   *
   * 为什么不新开一个云函数：写会员数据 = 写 `memberships` 权威 + 写 `users.membership` 镜像，
   * 本函数是全项目**唯一允许写会员数据的地方**（见 index.js 顶部）。手动发放同样要两处都写、
   * 值一致，于是复用 grantMembership 的 `base = max(now, 权威, 镜像)` 与 writeMembership /
   * writeMirror，不另起炉灶。
   *
   * last_order_id **保留权威行现有值**（若为首次发放则用 `manual:<时间>` 占位）：
   * 手动发放不该覆盖真实订单留在权威行上的发货凭据 —— 覆盖了，微信再重试那笔订单时
   * 「权威已记录这一单」判据就失效、会重发一遍天数。占位值只在从未有订单时才出现。
   * 手动发放可叠加：每次调用 = 在当前有效期的更晚者之上再 +days（与续费同一套口径）。
   */
  async function adminGrantMember(event) {
    const openid = String(event.openid || '').trim()
    const days = Number(event.days)
    const plan = String(event.plan || 'annual')
    if (!openid) return { ok: false, error: '缺少 openid' }
    if (!Number.isFinite(days) || days <= 0) return { ok: false, error: 'days 必须是正数（默认 365）' }

    const row = await findUserRow(openid)
    if (!row) return { ok: false, error: `找不到用户行：${openid}（该用户尚未登录过，先登录再发放）` }

    const auth = await readMembership(openid)
    const mirror = row.membership || null
    const base = Math.max(Date.now(), tsOf(auth && auth.expires_at), tsOf(mirror && mirror.expires_at))
    const expiresAt = new Date(base + days * DAY_MS).toISOString()
    const lastOrderId = (auth && auth.last_order_id) || `manual:${nowIso()}`

    await writeMembership(openid, {
      plan,
      expires_at: expiresAt,
      last_order_id: lastOrderId,
      refunded_orders: auth && auth.refunded_orders
    })
    await writeMirror(row._id, openid, { plan, expires_at: expiresAt, last_order_id: lastOrderId })

    log(`手动发放会员：openid=${openid} plan=${plan} days=${days} expires_at=${expiresAt}`)
    return { ok: true, openid, plan, days, expires_at: expiresAt }
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
    if (op === 'grantMember') return adminGrantMember(event)
    return { ok: false, error: `未知 adminOp：${op}（支持 refund / reconcile / grantMember）` }
  }

  return { handleAdminOp, reconcile, settleRefund }
}
