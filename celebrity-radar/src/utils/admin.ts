import { callCloudFunction } from './cloud'
import { diagLog } from './cloud-diagnostics'

/**
 * 超管运维台的端上通道（2026-10-18）。
 *
 * 全部动作打云函数 `adminConsole`，**鉴权在服务端**（openid 白名单 ADMIN_OPENIDS）：
 * 端上判断 `isAdmin` 只用于决定入口显不显示，绝不作为权限依据 —— 改包绕过页面判断，
 * 服务端照样会拒。
 *
 * 为什么单独一个云函数而不复用 adminOps：后者是控制台 / CLI 专用（口令 + 拒绝端上调用），
 * 两者的闸门语义相反，混在一起任何一侧的疏漏都会变成另一侧的突破口。
 */

export type AdminResult<T> = ({ ok: true } & T) | { ok: false; error: string }

/** 用户列表的一行（列表刻意不带配额计数：一页 20 行会变成上百次读，详情里再看） */
export interface AdminUserRow {
  openid: string
  nickname: string
  created_at: string
  last_seen_at: string | null
  plan: string
  expires_at: string | null
  /** 权威（memberships）判定：云端闸门读的就是它 */
  isMember: boolean
  /** 界面镜像（users.membership）是否也是会员 */
  mirrorActive: boolean
  /** 权威与镜像的有效期不一致 —— 界面与权限可能对不上 */
  mismatched: boolean
  /** 最近一次人工改会员的痕迹（谁在哪天动了什么） */
  lastAdminOp: { op: string; at: string; by: string; days?: number; reason?: string } | null
}

export interface AdminMeResult {
  openid: string
  isAdmin: boolean
  adminCount?: number
  /** 待核实的退款申请数（只有超管才查、才返回；非超管恒 0） */
  pendingRefunds?: number
  hint?: string
}

export interface AdminUserDetail {
  day: string
  found: boolean
  user: {
    openid: string
    nickname: string
    created_at: string
    last_seen_at: string | null
    settings_version?: number
    subscribe_ok?: boolean
    alert_ok?: boolean
    risk_ok?: boolean
  } | null
  authority: {
    plan?: string
    expires_at?: string
    last_order_id?: string
    refunded_orders?: string[]
    last_admin_op?: { op: string; at: string; by: string; days?: number; reason?: string } | null
    mirror_checked_at?: string | null
  } | null
  mirror: { plan?: string; expires_at?: string; updated_at?: string } | null
  isMember: boolean
  mirrorMatchesAuthority: boolean
  conclusion: string
  quotasToday: Record<string, number>
  abuseCallsToday: number
}

/** 会员价格的一档：`priceFen` 是**当前生效值**，`default*` 是构建期常量（用于「默认 ¥9.9」提示） */
export interface AdminPlanRow {
  id: string
  name: string
  days: number
  priceFen: number
  priceLabel: string
  badge: string
  defaultPriceFen: number
  defaultPriceLabel: string
  defaultBadge: string
}

export interface AdminPlanState {
  plans: AdminPlanRow[]
  /** `cloud` = 已被运维中心改过；`local` = 还在用构建期价格 */
  source: 'cloud' | 'local'
  updated_at: string | null
  updated_by: string | null
  note: string | null
}

export interface AdminVendor {
  key: string
  label: string
  channel: string
  ready: boolean
  enabled: boolean
}

export interface AdminVendorState {
  vendors: AdminVendor[]
  disabled: string[]
  updated_at: string | null
  updated_by: string | null
  note: string | null
}

/**
 * 统一调用口。
 *
 * 失败一律折成 `{ ok:false, error }`（不抛）：运维页每个动作都是「点一下、就地显示结果」，
 * 抛异常会让页面变成一堆 try/catch；而管理员需要的正是**原始错误文本**，
 * 所以这里不过 toUserMessage 那层（它会把技术串洗成人话，运维排障反而看不到症结）。
 */
async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<AdminResult<T>> {
  try {
    const res = (await callCloudFunction('adminConsole', Object.assign({ action }, payload))) as
      | (T & { ok?: boolean; error?: string })
      | null
    if (!res || typeof res !== 'object') {
      return { ok: false, error: '云端没有返回结果（adminConsole 可能尚未部署）' }
    }
    if (res.ok === true) return res as { ok: true } & T
    return { ok: false, error: res.error || '操作失败' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'db', `adminConsole ${action} 调用失败：${msg}`)
    if (/not found|FunctionName|-501000/i.test(msg)) {
      return { ok: false, error: '云函数 adminConsole 尚未部署：请在开发者工具里对 cloudfunctions/adminConsole 上传并部署' }
    }
    return { ok: false, error: msg }
  }
}

/** 我是谁：端上据此决定「运维中心」入口显不显示（服务端仍会独立鉴权） */
export function adminMe(): Promise<AdminResult<AdminMeResult>> {
  return call<AdminMeResult>('me')
}

/** 用户列表 / 搜索：关键词看起来像 openid 就精确匹配，否则按昵称模糊 */
export function adminListUsers(params: {
  keyword?: string
  page?: number
  pageSize?: number
}): Promise<AdminResult<{ users: AdminUserRow[]; total: number; page: number; pageSize: number }>> {
  return call('listUsers', {
    keyword: params.keyword || '',
    page: params.page ?? 0,
    pageSize: params.pageSize ?? 20
  })
}

/** 单个用户全景（权威 vs 镜像 / 今日配额 / 最近一次人工改会员） */
export function adminGetUser(openid: string): Promise<AdminResult<AdminUserDetail>> {
  return call<AdminUserDetail>('getUser', { openid })
}

/**
 * 发放 / 续期会员（天数为单位；代理到 payCallback，唯一写口不变）。
 *
 * `plan` 由天数**派生**、不由调用方随手写死（2026-10-18）：它只决定会员卡上显示哪一档，
 * 但显示「年度会员 · 剩 30 天」会让人以为买错了档。30 / 90 / 365 正是 PLANS 的三档，
 * 运维台的「+30 天 / +365 天」按钮与它对得上；其它天数按最近的档位归类。
 */
export function adminGrantMember(
  openid: string,
  days: number
): Promise<AdminResult<{ openid: string; plan?: string; days?: number; expires_at?: string }>> {
  const plan = days >= 365 ? 'annual' : days >= 90 ? 'quarterly' : 'monthly'
  return call('grantMember', { openid, days, plan })
}

/** 撤销会员（有效期收到此刻，不删行） */
export function adminRevokeMember(
  openid: string,
  reason = '运营手动撤销'
): Promise<AdminResult<{ openid: string; revoked: boolean; expires_at: string | null }>> {
  return call('revokeMember', { openid, reason })
}

/** 会员价格现状（云端覆盖值 + 构建期默认值 + 谁在哪天改的） */
export function adminListPlans(): Promise<AdminResult<AdminPlanState>> {
  return call<AdminPlanState>('plans')
}

/**
 * 改价：**三档一次提交**，金额单位是分。
 *
 * 为什么不允许只传一档：漏传的档位会被服务端按「没配」写回默认价 —— 运营以为只改了
 * 月卡，实际另外两档被重置。让调用方必须一次传全，是最省事故的做法（服务端也强制校验）。
 */
export function adminSetPlans(
  plans: Array<{ id: string; priceFen: number; badge: string }>,
  note = ''
): Promise<AdminResult<AdminPlanState>> {
  return call<AdminPlanState>('setPlans', { plans, note })
}

/** 厂商目录 + 停用清单 */
export function adminListVendors(): Promise<AdminResult<AdminVendorState>> {
  return call<AdminVendorState>('vendors')
}

/** 启用 / 停用某家厂商（服务端保证至少留一家） */
export function adminSetVendor(
  key: string,
  enabled: boolean,
  note = ''
): Promise<AdminResult<{ key: string; enabled: boolean; disabled: string[] }>> {
  return call('setVendor', { key, enabled, note })
}

/* ─────────── 退款核实（2026-10-22）：用户申请 → 超管核实 → 点击退款 ─────────── */

export type AdminRefundStatus = 'pending' | 'approved' | 'rejected'

/** 一条退款申请。`openidTail` 只给后 8 位：要对得上人，但列表不该把整串 openid 撒出来 */
export interface AdminRefundRow {
  id: string
  openidTail: string
  outTradeNo: string
  status: AdminRefundStatus
  reason: string
  plan: string
  /** 订单实付金额（分）—— 退款金额的上限 */
  amountFen: number
  days: number
  paidAt: string | null
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  decisionNote: string | null
  refundFee: number | null
  refundId: string | null
}

export interface AdminRefundList {
  rows: AdminRefundRow[]
  total: number
  /** 全站待办数（与筛选无关），用于 tab 红点 */
  pending: number
  page: number
  pageSize: number
  /** 集合还不存在时的提示（先把 dbInit sync 跑一遍） */
  note?: string
}

/**
 * 退款申请列表。
 *
 * `status:'pending'` = 「现在该我做什么」，`'all'` = 「上周那笔是谁批的」。
 * 两条口径分开取，混在一起两头都不好用（服务端也这么分）。
 */
export function adminRefundRequests(params: {
  status?: AdminRefundStatus | 'all'
  page?: number
  pageSize?: number
} = {}): Promise<AdminResult<AdminRefundList>> {
  return call<AdminRefundList>('refundRequests', {
    status: params.status || 'pending',
    page: params.page ?? 0,
    pageSize: params.pageSize ?? 20
  })
}

/**
 * 处理一条申请：`approve` = 核实后点退款，`reject` = 拒绝（必须写理由）。
 *
 * 金额单位是**分**；`fee` 省略表示全额退。真正的钱与订单状态在 payCallback，
 * 本函数只是把「申请单」那一侧的处理结果记下来 —— 所以 approve 成功后订单页会看到
 * 「已退款」，而订单状态由 payCallback 改，端上不碰。
 */
export function adminRefundDecide(
  id: string,
  decision: 'approve' | 'reject',
  opts: { note?: string; fee?: number; refundId?: string } = {}
): Promise<
  AdminResult<{
    status: AdminRefundStatus
    outTradeNo: string
    refundFee?: number
    refundId?: string | null
    revoked?: boolean
  }>
> {
  return call('refundDecide', {
    id,
    decision,
    note: opts.note || '',
    fee: opts.fee,
    refundId: opts.refundId || ''
  })
}
