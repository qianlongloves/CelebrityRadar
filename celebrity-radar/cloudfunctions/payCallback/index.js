/**
 * payCallback —— 微信支付结果通知：校验金额 → 幂等落库 → 续期会员。
 *
 * 本函数由**微信服务器**回调（不是端上调用），因此在 `cloudbaserc.json` 里以
 * `functionName: 'payCallback'` 注册给 `payCreate` 的统一下单。CloudBase 已完成
 * 验签与解密，本函数只负责业务处理。
 *
 * 五处幂等 / 安全设计（支付链路上最容易出错的地方）：
 *   1. **金额必须与订单一致**：不等则**不发货**并标记 failed，留人工核对。
 *      回调里的金额不可信（可能被伪造 / 串单），订单里的金额才是我们写的。
 *   2. **订单状态条件更新抢占发货权**：`status: 'pending' → 'granting'`，`updated === 0`
 *      说明已被并发回调处理过，重读一眼状态再决定（见第 3 点）。
 *   3. **`paid` 是「已发货」的终态，不是「已付款」**：`granting` 只在发货
 *      （会员权益写库）成功后才由 `markGranted` 推到 `paid`，且只对 `granting` 生效。
 *      于是残留的 `granting` 只有一个含义 —— 上一次回调发货中途失败，微信重试进来时会
 *      继续发货。这个区分是必需的：若抢占直接置 `paid`，而发货失败返回非 0 触发重试，
 *      重试会被「已 paid」判断 ack 掉 ⇒ 用户付了钱却永远拿不到会员（补偿通道被自己堵死）。
 *   4. **发货侧再按 `last_order_id` 去重，且是跨两处判**（见第 5 点）：两处保险。
 *      即便两个回调同时越过第 2 步，它们读到的旧 `expires_at` 相同 ⇒ 计算结果相同
 *      ⇒ 写入同一个值，不会叠加成 730 天。
 *   5. **会员权益落两处，权威与镜像分工明确（2026-10-09）**：
 *      `memberships`（_id = openid，客户端完全不可见）是**权威**，云端判会员一律读它；
 *      `users.membership` 降级为**端上读口的镜像**（端上界面读它，这次搬迁对端上零改动）。
 *      理由：users 是「仅创建者可读写」，端上能改自己那一行 —— 以它为准等于把会员身份
 *      交给客户端自证（自授会员 = 白用最贵模型 + 生成不计费）。详述见 grantMembership 上方。
 *
 * 返回值语义：`{ errcode: 0 }` = 已收到、不再通知；非 0 = 让微信按退避策略重试。
 * 因此**只有内部故障（DB 异常、找不到用户行）才返回非 0** —— 重试是我们唯一的补偿通道；
 * 而「订单不存在」「金额不符」这类确定性异常返回 0，重试也无意义。
 *
 * ⚠ 本函数是唯一允许写会员数据的地方：权威（memberships）与镜像（users.membership）
 *   都由它写，端上只读那份镜像（见 utils/pay.ts）。
 * 诊断依赖 `console.log`（进云函数日志）—— 回调的返回体格式由微信约定，装不下诊断信息。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const DAY_MS = 86400000

/** 回调字段名兼容 snake_case / camelCase（微信 v2 通知为 snake_case） */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function log(msg) {
  console.log(`[payCallback] ${msg}`)
}

/** ack：已收到、不再通知（detail 只进日志） */
function ack(detail) {
  log(`ack：${detail}`)
  return { errcode: 0, errmsg: 'OK' }
}

function updatedOf(res) {
  return (res && res.stats && res.stats.updated) || 0
}

async function readOrder(outTradeNo) {
  try {
    const res = await db.collection('orders').doc(outTradeNo).get()
    return res && res.data ? res.data : null
  } catch (err) {
    /* 行不存在时 doc().get() 直接抛错 */
    return null
  }
}

/** 解析 ISO 时间；非法 / 缺失给 0（参与 Math.max 时不会吃掉 Date.now()） */
function tsOf(v) {
  const t = Date.parse(v || '')
  return Number.isFinite(t) ? t : 0
}

/* ---------------- 会员权益的两个写入位（权威 + 镜像，2026-10-09） ----------------
 *
 * `memberships` 集合（_id = openid）= **服务端权威**，客户端完全不可见（ACL 见 dbInit/schema.js）。
 * 为什么权威不能继续放在 users.membership：那张表是「仅创建者可读写」，端上能改自己那一行，
 * 而云端有两处要拿会员身份做决策 —— aiProxy 的模型档位闸门与配额闸门、quotaGuard 的
 * 免计费复核。以端上可写的字段为准，改包者自授会员即可白用最贵那一档模型并让生成不计费。
 *
 * users.membership 保留为**镜像**：端上所有界面（会员卡 / 配额卡 / 档位展示）都读它，
 * 一处也没改，故这次搬迁对端上无感。镜像只是「给界面看的」，改它骗不到云端任何东西。
 *
 * 两处内容必须一致 —— 由 test/cases/06-pay-callback.js 的用例钉住。
 */

/** 读权威行：行不存在时 doc().get() 直接抛错，一律视为「没发过货」 */
async function readMembership(openid) {
  try {
    const res = await db.collection('memberships').doc(openid).get()
    return (res && res.data) || null
  } catch (err) {
    return null
  }
}

/** 写权威行：set = upsert（同一 openid 恒只有一行），重复进入写同一个值 */
async function writeMembership(openid, m) {
  await db
    .collection('memberships')
    .doc(openid)
    .set({
      data: {
        /* 显式写 _openid：云函数是管理员身份，不会像端上写入那样自动注入 */
        _openid: openid,
        plan: m.plan,
        expires_at: m.expires_at,
        last_order_id: m.last_order_id,
        updated_at: new Date().toISOString()
      }
    })
}

/** 写端上镜像（users.membership）：只给界面读；写不进去必须抛错让微信重试 */
async function writeMirror(rowId, openid, m) {
  const upd = await db
    .collection('users')
    .doc(rowId)
    .update({
      data: {
        membership: {
          plan: m.plan,
          expires_at: m.expires_at,
          /* 幂等标记：同一订单只发一次货 */
          last_order_id: m.last_order_id,
          updated_at: new Date().toISOString()
        }
      }
    })
  if (updatedOf(upd) === 0) throw new Error(`会员镜像写入未生效（openid=${openid}）`)
}

/**
 * 发货：把会员有效期往后延 `order.days` 天，先写权威、再写镜像。
 *
 * 续期而非覆盖 —— `base = max(now, 权威行 expires_at, 镜像行 expires_at)`。
 * 两处都取 max 是必需的：迁移期可能只有一处有值（老会员只有 users.membership，
 * 新会员两处都有），只读一处会把另一处更晚的有效期算短，等于吃掉用户已付的天数。
 *
 * 幂等按**订单号跨两处**判，而不是按某一处判：
 *   ① 权威行已记录这一单 ⇒ 只补镜像；
 *   ② 镜像行已记录这一单、权威行没有（迁移前发的货，或上次权威写成功而镜像失败的反向）
 *      ⇒ 只补权威。
 * 两条分支都**不重算天数**（重算就是叠加成双倍），且任一处缺失都会在下一趟补上 ——
 * 于是「发货成功但某一处写失败」不再需要人工介入，微信重试会自愈。
 *
 * 找不到用户行时**抛错**（返回非 0 让微信重试）：用户行理论上必然存在（下单前已登录），
 * 真缺失属异常，宁可重试也不静默吞掉一单。
 */
async function grantMembership(order, outTradeNo) {
  const openid = order._openid
  const days = Number(order.days) || 0
  if (!openid || days <= 0) {
    throw new Error(`订单 ${outTradeNo} 缺少 _openid 或 days，无法发货`)
  }

  const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
  const row = res && res.data && res.data[0]
  if (!row) throw new Error(`找不到用户行（openid=${openid}），订单 ${outTradeNo} 无法发货`)

  const plan = order.plan
  const auth = await readMembership(openid)
  const mirror = row.membership || null

  /* ① 权威行已记录这一单：只补镜像 */
  if (auth && auth.last_order_id === outTradeNo) {
    if (!mirror || mirror.last_order_id !== outTradeNo || mirror.expires_at !== auth.expires_at) {
      await writeMirror(row._id, openid, {
        plan: auth.plan || plan,
        expires_at: auth.expires_at,
        last_order_id: outTradeNo
      })
      log(`订单 ${outTradeNo} 权威行已有记录，本次只补齐端上镜像`)
    } else {
      log(`订单 ${outTradeNo} 已发货过（权威行 last_order_id 命中），跳过`)
    }
    return
  }

  /* ② 镜像行已记录这一单、权威行没有：补齐权威，不重算天数 */
  if (mirror && mirror.last_order_id === outTradeNo) {
    await writeMembership(openid, {
      plan: mirror.plan || plan,
      expires_at: mirror.expires_at,
      last_order_id: outTradeNo
    })
    log(`订单 ${outTradeNo} 已在端上镜像里（迁移前发的货），本次补齐权威行`)
    return
  }

  /* ③ 新发货：先权威（成功即真会员生效），再镜像（端上界面用） */
  const base = Math.max(
    Date.now(),
    tsOf(auth && auth.expires_at),
    tsOf(mirror && mirror.expires_at)
  )
  const expiresAt = new Date(base + days * DAY_MS).toISOString()

  await writeMembership(openid, { plan, expires_at: expiresAt, last_order_id: outTradeNo })
  await writeMirror(row._id, openid, { plan, expires_at: expiresAt, last_order_id: outTradeNo })

  log(`发货成功：openid=${openid} plan=${plan} days=${days} expires_at=${expiresAt}`)
}

/**
 * 发货完成：把订单从 `granting` 推到终态 `paid`。
 *
 * 只在 `granting` 时生效 —— 并发回调下另一个已经推到 paid，此时 updated 为 0，
 * 属正常情况（不是错误，故不抛错、不触发重试）。「付了钱但没拿到会员」的排查口径：
 * `granting` 残留（paid_at 有值、granted_at 为空、status 未到 paid）就是待补救的单。
 */
async function markGranted(outTradeNo) {
  const res = await db
    .collection('orders')
    .where({ _id: outTradeNo, status: 'granting' })
    .update({ data: { status: 'paid', granted_at: new Date().toISOString() } })
  if (updatedOf(res) === 0) {
    log(`订单 ${outTradeNo} 置 paid 未生效（已被并发回调置过或状态已变），忽略`)
  }
}

exports.main = async (event) => {
  const e = event || {}
  const returnCode = pick(e, ['returnCode', 'return_code'])
  const resultCode = pick(e, ['resultCode', 'result_code'])
  const outTradeNo = pick(e, ['outTradeNo', 'out_trade_no'])
  const totalFee = pick(e, ['totalFee', 'total_fee'])
  const transactionId = pick(e, ['transactionId', 'transaction_id'])

  if (!outTradeNo) return ack(`通知缺少 outTradeNo，忽略（returnCode=${returnCode}）`)

  /* 失败 / 关闭通知：不涉及发货，ack 掉即可，避免微信反复重试 */
  if ((returnCode && returnCode !== 'SUCCESS') || (resultCode && resultCode !== 'SUCCESS')) {
    return ack(`非成功通知（returnCode=${returnCode} resultCode=${resultCode}），忽略`)
  }

  try {
    const order = await readOrder(outTradeNo)
    if (!order) return ack(`订单不存在：${outTradeNo}（非本系统订单或已被清理）`)
    if (order.status === 'paid') return ack(`订单已处理：${outTradeNo}`)

    if (Number(totalFee) !== Number(order.amount_fen)) {
      await db.collection('orders').doc(outTradeNo).update({
        data: { status: 'failed', callback_fee: Number(totalFee) || null }
      })
      return ack(
        `金额不符：订单 ${order.amount_fen} 分 / 回调 ${totalFee} 分，订单 ${outTradeNo} 未发货，需人工核对`
      )
    }

    /* 抢占发货权：pending → granting。granting 只是「有人在发货」，不是终态 */
    const claim = await db
      .collection('orders')
      .where({ _id: outTradeNo, status: 'pending' })
      .update({
        data: {
          status: 'granting',
          paid_at: new Date().toISOString(),
          transaction_id: transactionId || null
        }
      })

    if (updatedOf(claim) === 0) {
      /* 没抢到 ⇒ 状态已被别的回调改走。必须重读最新状态再决定，不能一律 ack：
         - paid      已发货完成，ack；
         - failed / refunded  绝不发货，ack；
         - granting  上一次回调发货中途失败（返回非 0 让微信重试、重试进来的正是这一趟），
                     本次继续发货。grantMembership 按 last_order_id 去重，重复进入不叠加天数。 */
      const latest = await readOrder(outTradeNo)
      if (!latest) return ack(`订单在并发处理中被清理：${outTradeNo}`)
      if (latest.status === 'paid') return ack(`订单已处理：${outTradeNo}`)
      if (latest.status === 'failed' || latest.status === 'refunded') {
        return ack(`订单状态为 ${latest.status}，不发货：${outTradeNo}`)
      }
      log(`订单 ${outTradeNo} 处于 ${latest.status}（上次回调未发完货），本次重试继续发货`)
      await grantMembership(latest, outTradeNo)
      await markGranted(outTradeNo)
      return { errcode: 0, errmsg: 'OK' }
    }

    await grantMembership(order, outTradeNo)
    await markGranted(outTradeNo)
    return { errcode: 0, errmsg: 'OK' }
  } catch (err) {
    /* 返回非 0 → 微信重试；这是内部故障的唯一补偿通道 */
    const msg = err instanceof Error ? err.message : String(err)
    log(`处理失败（将触发重试）：${msg}`)
    return { errcode: -1, errmsg: `处理失败：${msg}` }
  }
}
