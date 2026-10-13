import { OPINION_LIMITS } from '../config/benefits'

/**
 * 舆情功能的免费 / 会员分层**取用与门禁层**（P2，2026-10-13）。
 *
 * 数值的真源只有一个：`config/benefits.ts#OPINION_LIMITS`（改数值只改那里）。
 * 本文件只负责「怎么用」，全部是**纯函数**（不碰网络 / storage / 数据库），
 * 于是门禁判定能被单测逐条钉住，页面只负责渲染与跳转。
 *
 * ## 两条硬约束（使用者必须遵守，改本文件前先读）
 *
 * 1. **只拦新增，绝不删存量、绝不阻塞查看**：
 *    `followGate` / `watchGate` / `personWatchGate` 只回答「**还能不能再加一个**」，它们
 *    **不删除、不隐藏、不过滤**任何既有数据。已有用户可能已经关注了超过免费档的人、订阅了
 *    超过免费档的词、或监控了超过免费档的名人 —— 那些数据必须原样保留、照常可看可用
 *    （含取消/取关），超限的既有监控对象还必须**继续被云端每日扫描**。`sliceDetail` 只用于
 *    **页面展示截断**，绝不用于删数据。任何把上限用在「读列表 / 管理既有数据」上的写法都是错的。
 *
 * 2. **端上上限是体验层，不是安全边界**：
 *    关注列表与监控词是用户自己的数据、由端上直接写入（`follows` / `keyword_watches` 集合
 *    权限为「仅创建者可读写」），改包即可绕过这里的任何数值。所以真正的成本边界在云端：
 *    关键词监控的新增已由云函数 `keywordAlert` 按 `memberships`（权威会员表）分档校验数量
 *    （P4，2026-10-13 落地）；「监控某人」的新增同样已由云函数 `riskWatch` 按 `memberships`
 *    分档校验（同为写入路径 `action:'add'`，2026-10-13 落地）。别把本文件的判定当成闸门
 *    —— 这里只负责给用户一个提前提示。
 */

/** 关注人数上限：会员 > 免费。**只用于「能否再关注一个」，不用于删 / 藏已有数据** */
export function followLimit(isMember: boolean): number {
  return isMember ? OPINION_LIMITS.followCount.member : OPINION_LIMITS.followCount.free
}

/** 关键词监控数上限：会员 > 免费。只算 `keyword_watches` 里 type='keyword' 的行 */
export function watchLimit(isMember: boolean): number {
  return isMember ? OPINION_LIMITS.watchCount.member : OPINION_LIMITS.watchCount.free
}

/**
 * 「监控某人」（风险监控）人数上限：会员 > 免费。只算 `keyword_watches` 里 type='person' 的行。
 *
 * 与 `watchLimit`（关键词监控）是**两个独立维度**：一个盯词、一个盯人，各自计数、互不占用额度。
 */
export function personWatchLimit(isMember: boolean): number {
  return isMember ? OPINION_LIMITS.personWatchCount.member : OPINION_LIMITS.personWatchCount.free
}

/**
 * 舆情页每块明细可见条数。
 * 返回 `null` 表示**不截断**（会员档显示全部），调用方按「无上限」处理 —— 不要把它当成 0。
 */
export function detailLimit(isMember: boolean): number | null {
  return isMember ? OPINION_LIMITS.detailRows.member : OPINION_LIMITS.detailRows.free
}

/**
 * 「还能不能再加一个」的门禁判定结果。
 *
 * - `allowed` 为 false 只代表**不能继续新增**，不代表既有数据有问题；
 * - `over` 为 true 表示**存量已经超过上限**（历史数据，必须原样保留、照常可看可用）。
 *   两者要分开用：`allowed` 决定要不要拦下这一次新增，`over` 只是让页面如实说明现状。
 */
export interface AddGate {
  /** 当前已有数量 */
  current: number
  /** 当前身份对应的上限 */
  limit: number
  /** 还能不能再加一个（`current < limit`）—— 唯一决定「是否拦下新增」的标志 */
  allowed: boolean
  /** 存量是否已经超过上限（`current > limit`）—— 只用于如实说明，不触发任何删除 / 隐藏 */
  over: boolean
}

function gateOf(current: number, limit: number): AddGate {
  const n = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0
  return { current: n, limit, allowed: n < limit, over: n > limit }
}

/** 关注门禁：只决定「能否再关注一个」 */
export function followGate(current: number, isMember: boolean): AddGate {
  return gateOf(current, followLimit(isMember))
}

/** 关键词监控门禁：只决定「能否再订阅一个词」 */
export function watchGate(current: number, isMember: boolean): AddGate {
  return gateOf(current, watchLimit(isMember))
}

/** 「监控某人」门禁：只决定「能否再盯一个人」 */
export function personWatchGate(current: number, isMember: boolean): AddGate {
  return gateOf(current, personWatchLimit(isMember))
}

/** 能否再关注一个（`followGate(...).allowed` 的便捷读法） */
export function canAddFollow(current: number, isMember: boolean): boolean {
  return followGate(current, isMember).allowed
}

/** 能否再订阅一个监控词（`watchGate(...).allowed` 的便捷读法） */
export function canAddWatch(current: number, isMember: boolean): boolean {
  return watchGate(current, isMember).allowed
}

/** 能否再监控一位名人（`personWatchGate(...).allowed` 的便捷读法） */
export function canAddPersonWatch(current: number, isMember: boolean): boolean {
  return personWatchGate(current, isMember).allowed
}

/**
 * 截断舆情页某块的明细供展示：会员（上限为 null）返回**全部**且 `hidden: 0`。
 * 不截断时**返回原数组引用**（不产生拷贝）—— 绝大多数块长度够短，走这条快路径。
 *
 * ⚠ 这是**展示层**截断，只影响页面上画几条，不动数据、不删缓存；被隐藏的条数由 `hidden`
 * 带回，供页面渲染一行「会员可见全部 N 条 ›」的提示（不遮罩、不弹窗）。
 */
export function sliceDetail<T>(items: T[] | null | undefined, isMember: boolean): { rows: T[]; hidden: number } {
  const list = Array.isArray(items) ? items : []
  const limit = detailLimit(isMember)
  if (limit === null || list.length <= limit) return { rows: list, hidden: 0 }
  return { rows: list.slice(0, limit), hidden: list.length - limit }
}

/** 关注上限提示（免费档带升级引导；会员档只报事实） */
export function followLimitNote(isMember: boolean): string {
  if (isMember) return `最多可关注 ${OPINION_LIMITS.followCount.member} 人，取消一位后才能再加`
  return `免费版最多关注 ${OPINION_LIMITS.followCount.free} 人，开通会员可关注 ${OPINION_LIMITS.followCount.member} 人`
}

/** 关键词监控上限提示（免费档带升级引导；会员档只报事实） */
export function watchLimitNote(isMember: boolean): string {
  if (isMember) return `最多同时监测 ${OPINION_LIMITS.watchCount.member} 个词，先取消一个再加`
  return `免费版最多监测 ${OPINION_LIMITS.watchCount.free} 个词，开通会员可监测 ${OPINION_LIMITS.watchCount.member} 个`
}

/** 「监控某人」上限提示（免费档带升级引导；会员档只报事实）—— 与关键词监控同风格 */
export function personWatchLimitNote(isMember: boolean): string {
  if (isMember) return `最多同时监控 ${OPINION_LIMITS.personWatchCount.member} 个人，先取消一个再加`
  return `免费版最多监控 ${OPINION_LIMITS.personWatchCount.free} 个人，开通会员可监控 ${OPINION_LIMITS.personWatchCount.member} 个`
}

/** 舆情明细被截断时的那一行提示（不刺眼：列表底部一行，点了跳会员页） */
export function moreDetailNote(total: number): string {
  return `会员可见全部 ${total} 条 ›`
}
