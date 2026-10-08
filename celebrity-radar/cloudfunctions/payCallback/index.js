/**
 * payCallback —— 微信支付结果通知：校验金额 → 幂等落库 → 续期会员。
 *
 * 本函数由**微信服务器**回调（不是端上调用），因此在 `cloudbaserc.json` 里以
 * `functionName: 'payCallback'` 注册给 `payCreate` 的统一下单。CloudBase 已完成
 * 验签与解密，本函数只负责业务处理。
 *
 * 三处幂等 / 安全设计（支付链路上最容易出错的地方）：
 *   1. **金额必须与订单一致**：不等则**不发货**并标记 failed，留人工核对。
 *      回调里的金额不可信（可能被伪造 / 串单），订单里的金额才是我们写的。
 *   2. **订单状态条件更新抢占发货权**：`status: 'pending' → 'paid'`，`updated === 0`
 *      说明已被并发回调处理过，直接 ack，绝不二次发货。
 *   3. **发货侧再按 `membership.last_order_id` 去重**：两处保险。即便两个回调同时
 *      越过第 2 步，它们读到的旧 `expires_at` 相同 ⇒ 计算结果相同 ⇒ 写入同一个值，
 *      不会叠加成 730 天。
 *
 * 返回值语义：`{ errcode: 0 }` = 已收到、不再通知；非 0 = 让微信按退避策略重试。
 * 因此**只有内部故障（DB 异常、找不到用户行）才返回非 0** —— 重试是我们唯一的补偿通道；
 * 而「订单不存在」「金额不符」这类确定性异常返回 0，重试也无意义。
 *
 * ⚠ 本函数是唯一允许写 `users.membership` 的地方（端上只读，见 utils/pay.ts）。
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

/**
 * 发货：把会员有效期往后延 `order.days` 天。
 *
 * 续期而非覆盖 —— `base = max(now, 旧 expires_at)`，这样提前续费不会吃掉剩余天数。
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

  const m = row.membership || null
  if (m && m.last_order_id === outTradeNo) {
    log(`订单 ${outTradeNo} 已发货过（last_order_id 命中），跳过`)
    return
  }

  const old = Date.parse((m && m.expires_at) || '')
  const base = Math.max(Date.now(), Number.isFinite(old) ? old : 0)
  const expiresAt = new Date(base + days * DAY_MS).toISOString()

  const upd = await db.collection('users').doc(row._id).update({
    data: {
      membership: {
        plan: order.plan,
        expires_at: expiresAt,
        /* 幂等标记：同一订单只发一次货 */
        last_order_id: outTradeNo,
        updated_at: new Date().toISOString()
      }
    }
  })
  if (updatedOf(upd) === 0) throw new Error(`会员写入未生效（openid=${openid}，订单 ${outTradeNo}）`)

  log(`发货成功：openid=${openid} plan=${order.plan} days=${days} expires_at=${expiresAt}`)
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

    /* 抢占发货权：并发回调下只有一个能把它从 pending 改走 */
    const claim = await db
      .collection('orders')
      .where({ _id: outTradeNo, status: 'pending' })
      .update({
        data: {
          status: 'paid',
          paid_at: new Date().toISOString(),
          transaction_id: transactionId || null
        }
      })
    if (updatedOf(claim) === 0) return ack(`订单状态已被其它回调更新：${outTradeNo}`)

    await grantMembership(order, outTradeNo)
    return { errcode: 0, errmsg: 'OK' }
  } catch (err) {
    /* 返回非 0 → 微信重试；这是内部故障的唯一补偿通道 */
    const msg = err instanceof Error ? err.message : String(err)
    log(`处理失败（将触发重试）：${msg}`)
    return { errcode: -1, errmsg: `处理失败：${msg}` }
  }
}
