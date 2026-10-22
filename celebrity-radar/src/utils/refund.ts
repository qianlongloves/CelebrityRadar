/**
 * 退款申请（2026-10-22）：用户自己发起 → 超管在运维中心核实 → 点击退款。
 *
 * 这一层只做两件事：把「提交申请 / 读我的申请」包成一句人话的结果，以及**理由的前置校验**。
 * 三条口径（改之前先读）：
 *   1. **不改订单状态**：退款由超管在运维中心点，走 adminConsole → payCallback。
 *      端上提交的只是一条「待核实的申请」，订单仍是 paid，直到真正退完。
 *   2. **理由必填**：端上先挡一次只为省一次往返（云函数 refundApply 还会再挡一次，
 *      那一道才是真正的闸门 —— 端上的校验永远可以被绕过）。
 *   3. **读失败一律降级为空**：申请列表读不到不能让整页订单打不开（订单本身才是主内容）。
 */
import { callCloudFunction } from './cloud'

export type RefundStatus = 'pending' | 'approved' | 'rejected'

export interface RefundRequest {
  id: string
  outTradeNo: string
  status: RefundStatus
  reason: string
  createdAt: string
  decidedAt: string | null
  decisionNote: string | null
  refundFee: number | null
}

export const REFUND_REASON_MIN = 2
export const REFUND_REASON_MAX = 200

/** 理由校验：返回空串表示通过（文案与云函数 refundApply 保持一致） */
export function refundReasonError(reason: string): string {
  const text = (reason || '').trim()
  if (text.length < REFUND_REASON_MIN) return `请填写退款理由（至少 ${REFUND_REASON_MIN} 个字）`
  if (text.length > REFUND_REASON_MAX) return `退款理由最多 ${REFUND_REASON_MAX} 个字`
  return ''
}

export interface ApplyRefundResult {
  ok: boolean
  error?: string
  status?: RefundStatus
  /** true = 之前已经提交过（不是这次新写的），端上提示语气要不同 */
  already?: boolean
  hint?: string
}

/** 提交一条退款申请 */
export async function applyRefund(outTradeNo: string, reason: string): Promise<ApplyRefundResult> {
  try {
    const res = (await callCloudFunction('refundApply', {
      action: 'create',
      outTradeNo,
      reason: (reason || '').trim()
    })) as Record<string, unknown> | null
    if (!res || res.ok !== true) {
      return { ok: false, error: String((res && res.error) || '提交失败，请稍后重试') }
    }
    return {
      ok: true,
      status: String(res.status || '') as RefundStatus,
      already: res.already === true,
      hint: String(res.hint || '')
    }
  } catch (err) {
    return { ok: false, error: '网络异常，请稍后重试' }
  }
}

/** 我提交过的申请（按时间倒序）。读不到就返回空 —— 不能因为这一段让订单页打不开 */
export async function loadMyRefundRequests(): Promise<RefundRequest[]> {
  try {
    const res = (await callCloudFunction('refundApply', { action: 'my' })) as Record<string, unknown> | null
    if (!res || res.ok !== true || !Array.isArray(res.requests)) return []
    return (res.requests as Record<string, unknown>[])
      .map((raw) => ({
        id: String(raw.id || ''),
        outTradeNo: String(raw.outTradeNo || ''),
        status: String(raw.status || '') as RefundStatus,
        reason: String(raw.reason || ''),
        createdAt: String(raw.createdAt || ''),
        decidedAt: raw.decidedAt ? String(raw.decidedAt) : null,
        decisionNote: raw.decisionNote ? String(raw.decisionNote) : null,
        refundFee: typeof raw.refundFee === 'number' ? raw.refundFee : null
      }))
      .filter((r) => r.id !== '' && r.outTradeNo !== '')
  } catch (err) {
    return []
  }
}

/**
 * 订单号 → 最近一条申请。
 *
 * 输入已按 `created_at desc` 排好（refundApply.my），所以**第一条为准** —— 同一单理论上
 * 只有一条（`_id = rr_<outTradeNo>`），这里兜的是历史数据或将来放开重申请的情况。
 */
export function refundMapOf(rows: RefundRequest[]): Record<string, RefundRequest> {
  const map: Record<string, RefundRequest> = {}
  for (const r of rows) {
    if (r && r.outTradeNo && !map[r.outTradeNo]) map[r.outTradeNo] = r
  }
  return map
}
