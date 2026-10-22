/**
 * refundApply —— 用户自己发起退款申请（2026-10-22）
 *
 * 为什么要这个函数：退款此前只有「超管直接置退款」一条路（payCallback 的 adminOp:'refund'），
 * 用户那边**没有任何发起的口子** —— 想退款只能在群里 @ 管理员。结果是两边都缺证据：
 * 用户说不清「哪一单、什么时候、为什么」，管理员也没有一份待办清单可以照着核实。
 *
 * 本函数只做两件事，且**一个字都不改订单状态**：
 *   ① `create`：校验 → 落一条 refund_requests（status=pending）→ 等超管在运维中心核实
 *   ② `my`：我自己提交过的申请（订单页据此显示「待核实 / 已退款 / 已拒绝」）
 *
 * 真正「退钱 + 置 refunded + 撤销会员」仍由超管在运维中心点，链路是
 * adminConsole.refundDecide → payCallback adminOp:'refund' → 对账撤销会员。
 * 这里绝不代劳：能写订单状态的只有 payCallback 一处。
 *
 * 三条刻意的闸门：
 *   · **必须登录**（取 OPENID）：否则谁都能替任意订单提交申请；
 *   · **订单必须属于调用者**（比 `_openid`）：拿别人的订单号来申请，是本函数唯一能造成的越权；
 *   · **只有已付款的单可申请**（`paid`）：`pending` 是没付钱、`failed` 是没支付成功、
 *     `refunded` 是已经退过 —— 这三种都退不出钱，放进来只会给管理员制造无效待办。
 *     刻意**不放开 `granting`**：那是发货进行中的几秒窗口，adminRefund 本身就会拒它，
 *     让用户下拉刷新一下再申请，比让超管点到一个必然失败的单要好。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const COLLECTION = 'refund_requests'
const REASON_MIN = 2
const REASON_MAX = 200
/** 可以发起退款的订单状态（见文件头：只有「钱已经付了」才退得出来） */
const APPLICABLE = ['paid']
/** 一次最多回传多少条申请（订单页只展示最近的一批，够用且不会拉爆） */
const MY_LIMIT = 30

function str(v) {
  if (typeof v === 'string') return v.trim()
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

function nowIso() {
  return new Date().toISOString()
}

function ctxOpenid() {
  try {
    const ctx = cloud.getWXContext()
    return (ctx && ctx.OPENID) || ''
  } catch (err) {
    return ''
  }
}

/** 一单一申请：_id 由订单号派生，重复提交撞同一个 id，不会在待办里出现两条 */
function requestIdOf(outTradeNo) {
  return `rr_${outTradeNo}`
}

async function readDoc(collection, id) {
  try {
    const res = await db.collection(collection).doc(id).get()
    return (res && res.data) || null
  } catch (err) {
    /* 行不存在时 doc().get() 抛错，与「读失败」在这里不作区分：两种情况的安全动作一致 */
    return null
  }
}

/** 提交申请 */
async function create(e) {
  const openid = ctxOpenid()
  if (!openid) return { error: '请先登录后再申请退款' }

  const outTradeNo = str(e.outTradeNo)
  if (!outTradeNo) return { error: '需要 outTradeNo' }

  /* 理由必填且不能是空白：管理员的核实动作是「看着理由去查这一单」，
     没有理由的待办只能原样退回去，白跑一趟 */
  const reason = str(e.reason)
  if (reason.length < REASON_MIN) return { error: `请填写退款理由（至少 ${REASON_MIN} 个字）` }
  if (reason.length > REASON_MAX) return { error: `退款理由最多 ${REASON_MAX} 个字` }

  const order = await readDoc('orders', outTradeNo)
  if (!order) return { error: `找不到订单 ${outTradeNo}` }
  if (order._openid !== openid) {
    /* 不区分「不存在」与「不是你的」之外的信息：只回一句不能申请，不泄露这单归谁 */
    return { error: '这单不属于当前账号，无法申请退款' }
  }
  if (APPLICABLE.indexOf(order.status) < 0) {
    return {
      error:
        order.status === 'refunded'
          ? '这单已经退过款了'
          : `当前订单状态（${order.status}）不能申请退款：只有已支付成功的订单可以`
    }
  }

  const id = requestIdOf(outTradeNo)
  const exist = await readDoc(COLLECTION, id)
  if (exist) {
    if (exist.status === 'pending') {
      return { ok: true, id, status: 'pending', already: true, hint: '这笔申请已经在核实中，请耐心等待' }
    }
    if (exist.status === 'approved') {
      return { ok: true, id, status: 'approved', already: true, hint: '这单已经退款完成' }
    }
    /* 被拒绝过就不再自动受理：否则同一条理由可以无限次刷进待办队列，
       而管理员的拒绝理由用户根本没看。要再申请就走人工客服。 */
    return {
      error: `这单的退款申请已被拒绝${exist.decision_note ? `（${exist.decision_note}）` : ''}，如需再次申请请联系平台`
    }
  }

  await db.collection(COLLECTION).doc(id).set({
    data: {
      _openid: openid,
      out_trade_no: outTradeNo,
      status: 'pending',
      reason,
      /* 订单快照：超管处理一条待办时不必再查一次 orders，且这条申请能独立阅读
         （金额与时长是**申请当时**的值） */
      plan: str(order.plan),
      amount_fen: Number(order.amount_fen) || 0,
      days: Number(order.days) || 0,
      paid_at: str(order.paid_at) || null,
      order_status: str(order.status),
      created_at: nowIso(),
      decided_at: null,
      decided_by: null,
      decision_note: null,
      refund_fee: null,
      refund_id: null
    }
  })

  return {
    ok: true,
    id,
    status: 'pending',
    already: false,
    hint: '已提交，平台核实后会在这里更新结果'
  }
}

/** 我提交过的申请（订单页用） */
async function my() {
  const openid = ctxOpenid()
  if (!openid) return { requests: [] }

  const res = await db
    .collection(COLLECTION)
    .where({ _openid: openid })
    .orderBy('created_at', 'desc')
    .limit(MY_LIMIT)
    .get()

  const rows = res.data || []
  return {
    requests: rows.map((r) => ({
      id: r._id,
      outTradeNo: r.out_trade_no,
      status: r.status,
      reason: r.reason,
      createdAt: r.created_at,
      decidedAt: r.decided_at || null,
      decisionNote: r.decision_note || null,
      refundFee: typeof r.refund_fee === 'number' ? r.refund_fee : null
    }))
  }
}

exports.main = async (event) => {
  const e = event || {}
  const action = str(e.action) || 'create'

  try {
    if (action === 'my') {
      const out = await my()
      return Object.assign({ ok: true, action }, out)
    }
    if (action === 'create') {
      const out = await create(e)
      if (out && out.error) return { ok: false, action, error: out.error }
      return Object.assign({ ok: true, action }, out)
    }
    return { ok: false, action, error: `未知 action：${action}（支持 create / my）` }
  } catch (err) {
    return { ok: false, action, error: (err && err.message) || String(err) }
  }
}
