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

/** 发放 / 续期会员（天数为单位；代理到 payCallback，唯一写口不变） */
export function adminGrantMember(
  openid: string,
  days: number,
  plan = 'annual'
): Promise<AdminResult<{ openid: string; days?: number; expires_at?: string }>> {
  return call('grantMember', { openid, days, plan })
}

/** 撤销会员（有效期收到此刻，不删行） */
export function adminRevokeMember(
  openid: string,
  reason = '运营手动撤销'
): Promise<AdminResult<{ openid: string; revoked: boolean; expires_at: string | null }>> {
  return call('revokeMember', { openid, reason })
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
