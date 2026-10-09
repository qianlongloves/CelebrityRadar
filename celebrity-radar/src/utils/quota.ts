import { table } from './db'
import { todayKey } from './time'
import { diagLog } from './cloud-diagnostics'
import { incrQuotaViaCloud } from './quota-guard'
import type { QuotaWaiveOptions } from './quota-guard'
import { GENERATE_QUOTA_DISABLED } from './debug'
import {
  FREE_DAILY_GENERATE_LIMIT,
  MEMBER_DAILY_GENERATE_LIMIT,
  dailyGenerateLimit,
  isMembershipActive,
  readMemberState
} from './member'
import type { GenerateQuotaRow } from '@/types/db'

/**
 * 报告生成配额（freemium 计费的免费层闸门，设计口径见 README § 计费）。
 *
 * 本文件只管**计数**；「谁该有多少额度」在 utils/member.ts（权益层），
 * 本文件所有限额都从那里取，不再自行判断会员状态或写死数字。
 *
 * 计费口径（与冷却、缓存严格区分，三者各管一件事）：
 *   - 冷却（cooldown.ts）：上游限流保护，拦「短时间重试风暴」；
 *   - 缓存（cache.ts）：同一人物全局只生成一次，命中零成本；
 *   - 配额（本文件）：拦「用户主动发起的真实生成」，按账号按日计数。
 *
 * 公平性原则：只对「成功拿到报告」的生成计数——
 *   缓存命中不计数（零成本）、生成失败不计数（用户没拿到东西）、
 *   LLM 拒答不计数（合规拦截不是用户过错）、
 *   「只升不降」拦下的刷新也不计数（交回的是缓存里更完整的那一版，用户没拿到新东西）。
 *   上游成本损失由冷却兜底。
 *
 * 会员「补齐」免计费（2026-10-09）：缓存里那版还不含会员段落时，会员这次生成实际是把
 * 共享缓存从免费档升到会员档，产出归全站所有，故不该扣他的每日次数。端上只**申请**，
 * 复核在云函数 `quotaGuard`（会员是否生效 + 那一行是否真的缺会员段落），复核不过照常计数。
 *
 * 计数已服务端化：优先走云函数 `quotaGuard` 原子自增（并发不丢数、日期取服务端、
 * 不可被改包篡改）；函数未部署时静默回退端上读-改-写。
 *
 * 会员链路：`users.membership` 只由云函数 `payCallback`（微信支付结果通知）写入，
 * 端上永不写该字段。下单链路见 utils/pay.ts；**未部署支付云函数 / 未配商户号时
 * 运行时恒为免费版**（`payCreate` 会返回 kind:'unconfigured'），不影响免费功能。
 */

/*
 * 兼容出口：限额常量与会员判定的**定义**已上移到权益层 utils/member.ts，
 * 这里只是把旧名字继续转出，既有引用（页面 / 周报 / 收藏）无需跟着改。
 */
export { FREE_DAILY_GENERATE_LIMIT, MEMBER_DAILY_GENERATE_LIMIT, isMembershipActive }

export interface GenerateQuotaSummary {
  /** 今日已成功生成次数 */
  used: number
  /** 今日上限（会员/免费版不同，取自 utils/member.ts 的权益表） */
  limit: number
  /** 剩余可发起次数 */
  remaining: number
  /** 是否还能发起生成 */
  allowed: boolean
  /** 会员是否生效中 */
  member: boolean
  /** 会员到期时间（ISO；非会员为 null），「我的」页展示有效期用 */
  expiresAt: string | null
  /** 距到期天数（向上取整；非会员 -1），会员卡展示「还剩几天」用 */
  daysLeft: number
}

async function readCount(userId: string): Promise<number> {
  const id = `${userId}#${todayKey()}`
  const { data, error } = await table('generate_quota').select('*').eq('id', id).maybeSingle()
  if (error) diagLog('warn', 'db', `generate_quota 读取失败：${error.message ?? error}`)
  return (data as GenerateQuotaRow | null)?.count ?? 0
}

/**
 * 查询配额（不消耗）：生成前的闸门检查 + 「我的」页展示共用。
 * 会员判定读 users 行失败时按免费版处理（保守，不放大免费额度）。
 */
export async function peekGenerateQuota(userId: string): Promise<GenerateQuotaSummary> {
  const state = await readMemberState()
  const limit = dailyGenerateLimit(state.member)
  const used = await readCount(userId)
  const realRemaining = Math.max(0, limit - used)
  return {
    used,
    limit,
    /*
     * 关闭闸门时把剩余次数固定报成满额：两个调用方（cache.ts / weekly.ts）只看 allowed，
     * 但「我的」页与周报页会直接渲染 remaining —— 照实返回会出现
     * 「剩余 0 次」却仍能一直生成的矛盾展示，反而更像故障。
     */
    remaining: GENERATE_QUOTA_DISABLED ? limit : realRemaining,
    allowed: GENERATE_QUOTA_DISABLED || realRemaining > 0,
    member: state.member,
    expiresAt: state.expiresAt,
    daysLeft: state.daysLeft
  }
}

/**
 * 消耗一次配额：仅在生成成功落库后调用（best-effort，计数失败不影响已生成的报告）。
 *
 * 优先由云函数原子自增；不可用时回退本地读-改-写（与 refresh_quota 同构，不做重试）。
 *
 * waive（P1，2026-10-09）：会员「补齐」共享缓存（缓存那版缺会员段落、他这次生成是替
 * 全站升级）本该免计费。端上只**申请**，复核在云函数 quotaGuard（会员是否生效 +
 * 目标那一行是否真的缺会员段）；复核不过就照常计数。
 * ⚠ 回退路径（函数未部署）**不认**这个申请 —— 端上无法自证身份，宁可多算一次，
 *   也不留下「改包即免次数」的口子（回退态本来就是过渡态，部署函数后即消除）。
 */
export async function consumeGenerateQuota(
  userId: string,
  waive?: QuotaWaiveOptions
): Promise<void> {
  const cloud = await incrQuotaViaCloud('generate', waive)
  if (cloud !== null) {
    if (cloud.waived) {
      diagLog('info', 'db', `会员补齐共享缓存，本次生成不计入配额：${waive?.target ?? ''}`)
    }
    return
  }

  const id = `${userId}#${todayKey()}`
  const count = await readCount(userId)
  if (count === 0) {
    const { error } = await table('generate_quota').insert({ id, count: 1 })
    if (error) diagLog('warn', 'db', `generate_quota 写入失败：${error.message ?? error}`)
    return
  }
  const { error } = await table('generate_quota').update({ count: count + 1 }).eq('id', id)
  if (error) diagLog('warn', 'db', `generate_quota 更新失败：${error.message ?? error}`)
}
