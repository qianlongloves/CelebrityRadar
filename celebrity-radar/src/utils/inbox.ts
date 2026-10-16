import Taro from '@tarojs/taro'
import { diagLog } from './cloud-diagnostics'
import { listFollows } from './follows'
import { loadFollowWatches } from './watch'
import { loadAlerts } from './keyword-alert'
import { listPersonWatches, loadRiskSignals } from './risk-watch'
import { eventNewness, loadEventDigest, loadEventStatus } from './opinion-store'
import type { EventStatus } from './opinion-store'

/**
 * 站内触达收口（2026-10-13）：把「新内容」的口径收成**一处纯函数层**。
 *
 * ## 为什么要收口
 *
 * 订阅消息推送功能完整保留，只是当前部署环境未配置（个人主体 + 「机械电子产品」类目在公共模板库
 * 拿不到可用模板，见 src/config/public.ts / local.ts 的注释）。当前召回依赖**站内**：得让用户一眼
 * 看出「关注的东西有没有新东西」。此前项目里存在几套各不相同的「新」口径 ——
 * 关注流按每个人的 `hasNew`、关键词预警按每个词的 `seen_at`、事件按 `opinion_event_status.reads`、
 * 消息按本机已读记录。它们各自的判据其实同源（**时间可解析且晚于基线**），这里把它提炼出来，
 * 并给「没有天然基线」的模块（风险信号）补一份本机基线。
 *
 * ## 统一判据
 *
 *   一条内容算「新」 ⟺ 它的时间**可解析**、且**晚于**它对应的「上次查看时刻」。
 *   时间不可解析 → 不算新（算不出就不猜，与 utils/opinion-store#eventNewness 同口径）。
 *   基线缺失 / 不可解析 → 视作 0（一切有时间的内容都算新，与 utils/messages 的旧基线同口径）。
 *
 * ## 各模块的「上次查看时刻」从哪来（能不另造就不另造）
 *
 *   · 关注动态：每个人的 `followed_at`（复用 utils/watch 的 `hasNew`，关注那一刻就是基线）；
 *   · 关键词预警：每个词的 `keyword_watches.seen_at`（复用 utils/keyword-alert 的 `isNewItem`）；
 *   · 舆情事件：`opinion_event_status.reads`（复用 opinion-store，已读且无新进展 → 不算新）；
 *   · 风险信号：**没有天然基线**，故在本机 storage 记一份 `inbox:seen.risk`（本文件）。
 *     它只在这里出现一次、只服务于风险信号，不与上面三套既有状态冲突。
 *
 * ## 更新（「进入某模块即标记已看」或显式「全部已读」）
 *
 *   · 关注动态 / 关键词预警 / 事件：沿用各自既有的写入路径（关注、markAllSeen、markEventRead）；
 *   · 风险信号：进预警页（或舆情页「全部已读」）时把 `inbox:seen.risk` 推进到当前时刻。
 *
 * 本文件是**纯函数 + 本机 storage + 只读汇总**：不新增云函数、不新增集合、不发起任何检索 / 模型调用
 * （零新增上游成本）。所有函数对脏数据（缺失 / 不可解析 / 超上限 / 非数组）一律不抛。
 */

/** 站内内容模块。`event` 的「新」走 reads，其余走各自基线。 */
export type InboxModule = 'feed' | 'alert' | 'risk' | 'event'

/** 已知模块白名单：读写 storage / 汇总时只认它们，脏键一律丢弃 */
export const INBOX_MODULES: InboxModule[] = ['feed', 'alert', 'risk', 'event']

/** 本机「上次查看」键（**仅风险信号用**；其余模块复用既有基线，见文件头） */
export const INBOX_SEEN_KEY = 'inbox:seen'

/** 各模块的未读数 */
export interface InboxCounts {
  feed: number
  alert: number
  risk: number
  event: number
}

/** 一条内容的最小形状：只要一个能被 `Date.parse` 解析的时刻 + 它对应的基线时刻 */
export interface InboxEntry {
  /** 内容时间（ISO / 任意可解析串） */
  at?: string | null
  /** 该条对应的「上次查看时刻」（毫秒）；缺失 / 不可解析按 0（视为从未看过） */
  since?: number | null
}

/* ─────────────────────────── 纯判据 ─────────────────────────── */

/**
 * 一条内容是否「新于」某个时刻（统一判据，见文件头）。
 * 纯函数：任何输入都不抛。
 */
export function isNewSince(at: string | null | undefined, sinceMs: number | null | undefined): boolean {
  const t = Date.parse(String(at ?? ''))
  if (!Number.isFinite(t)) return false
  const base = Number.isFinite(sinceMs as number) ? (sinceMs as number) : 0
  return t > base
}

/**
 * 一批条目里「新」的条数。
 *
 * 脏数据（非数组 / null 元素 / 时间不可解析）一律跳过，绝不抛。
 * `limit` > 0 时只检查前 `limit` 条 —— 超大列表的护栏（**超上限不抛、不无界遍历**），
 * 与事件状态 map 的 300 条上限同一思路：宁可少算，也不让一次读数把端上拖住。
 */
export function countNew(entries: InboxEntry[] | null | undefined, limit = 0): number {
  if (!Array.isArray(entries)) return 0
  const cap = limit > 0 ? Math.min(entries.length, limit) : entries.length
  let n = 0
  for (let i = 0; i < cap; i++) {
    const e = entries[i]
    if (e && isNewSince(e.at, e.since)) n++
  }
  return n
}

/**
 * 事件维度的「新」：**复用 opinion_event_status.reads**（已读且无新进展 → 不算新），
 * 不另立一套事件已读。判据与舆情页事件卡上的角标同源（utils/opinion-store#eventNewness）。
 */
export function countNewEvents(
  events: Array<{ key?: string | null; at?: string | null }> | null | undefined,
  status: EventStatus | null | undefined,
  limit = 0
): number {
  if (!Array.isArray(events)) return 0
  const cap = limit > 0 ? Math.min(events.length, limit) : events.length
  let n = 0
  for (let i = 0; i < cap; i++) {
    const ev = events[i]
    if (!ev || typeof ev.key !== 'string' || !ev.key) continue
    if (eventNewness({ event_key: ev.key, last_at: String(ev.at ?? '') }, status) !== 'seen') n++
  }
  return n
}

/* ─────────────────────────── 各模块（薄适配，复用既有语义） ─────────────────────────── */

/** 关注动态：复用 utils/watch 的 `hasNew`（基线是每个人的 `followed_at`），只数「有变化」的人。 */
export function feedNewCount(
  watches: Record<string, { hasNew?: boolean } | null | undefined> | null | undefined
): number {
  if (!watches || typeof watches !== 'object') return 0
  let n = 0
  for (const w of Object.values(watches)) if (w && w.hasNew) n++
  return n
}

/** 关键词预警：复用 loadAlerts 已算好的每组 `newCount`（基线是每个词的 `seen_at`）。 */
export function alertNewCount(groups: Array<{ newCount?: number } | null | undefined> | null | undefined): number {
  if (!Array.isArray(groups)) return 0
  let n = 0
  for (const g of groups) {
    const c = g && g.newCount
    if (Number.isFinite(c)) n += Math.max(0, Math.trunc(c as number))
  }
  return n
}

/** 风险信号：相对本机「上次查看」基线 `inbox:seen.risk` 有几条新的。 */
export function riskNewCount(
  signals: Array<{ first_seen_at?: string | null } | null | undefined> | null | undefined,
  seenMs: number | null | undefined,
  limit = 0
): number {
  if (!Array.isArray(signals)) return 0
  const cap = limit > 0 ? Math.min(signals.length, limit) : signals.length
  let n = 0
  for (let i = 0; i < cap; i++) {
    const s = signals[i]
    if (s && isNewSince(s.first_seen_at, seenMs)) n++
  }
  return n
}

/** 跨模块求和：脏值按 0 计（负数 / NaN / 非数值一律归零），并给出合计。 */
export function summarizeInbox(
  partial: Partial<InboxCounts> | null | undefined
): InboxCounts & { total: number } {
  const p = partial ?? {}
  const num = (v: unknown): number => (Number.isFinite(v) ? Math.max(0, Math.trunc(v as number)) : 0)
  const feed = num(p.feed)
  const alert = num(p.alert)
  const risk = num(p.risk)
  const event = num(p.event)
  return { feed, alert, risk, event, total: feed + alert + risk + event }
}

/* ─────────────────────────── 本机「上次查看」存储 ─────────────────────────── */

/**
 * 读本机「上次查看时刻」（毫秒）。存储被写坏 / 缺键 / 值不可解析一律按「没有记录」处理。
 * 只认已知模块与正数毫秒，多出来的脏键直接丢弃。
 */
export function readInboxSeen(): Partial<Record<InboxModule, number>> {
  const out: Partial<Record<InboxModule, number>> = {}
  try {
    const raw = Taro.getStorageSync<string>(INBOX_SEEN_KEY)
    if (!raw) return out
    const obj: unknown = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return out
    const src = obj as Record<string, unknown>
    for (const m of INBOX_MODULES) {
      const v = src[m]
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
      if (Number.isFinite(n) && n > 0) out[m] = Math.trunc(n)
    }
  } catch {
    /* 存储坏掉最坏是「视为没有基线」，绝不会抛 */
    return {}
  }
  return out
}

/** 写回本机「上次查看时刻」：只落已知模块且为正数毫秒的项，避免脏键撑大。失败静默。 */
export function writeInboxSeen(map: Partial<Record<InboxModule, number>> | null | undefined): void {
  try {
    const clean: Record<string, number> = {}
    if (map && typeof map === 'object') {
      for (const m of INBOX_MODULES) {
        const v = map[m]
        if (Number.isFinite(v) && (v as number) > 0) clean[m] = Math.trunc(v as number)
      }
    }
    Taro.setStorageSync(INBOX_SEEN_KEY, JSON.stringify(clean))
  } catch {
    /* 静默：写不进去只是红点点不灭，不影响主流程 */
  }
}

/**
 * 把某模块的「上次查看时刻」推进到 `max(now, 传入的内容时刻)`。
 *
 * 取 max 而不是单纯的 now：内容时间可能因时钟差落在「现在」之后，只记 now 会让那条
 * 永远显得是「新」。传入时刻不可解析时退回 now。
 */
export function markModuleSeen(module: InboxModule, at?: string | number | Date | null): void {
  if (!INBOX_MODULES.includes(module)) return
  const now = Date.now()
  const t = at == null ? NaN : at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at)
  const stamp = Number.isFinite(t) ? Math.max(now, t as number) : now
  writeInboxSeen({ ...readInboxSeen(), [module]: stamp })
}

/** 清除本机「上次查看」记录（「清空我的数据」调用，与 messages / weekly 同一处理）。 */
export function clearInboxSeen(): void {
  try {
    Taro.removeStorageSync(INBOX_SEEN_KEY)
  } catch {
    /* 静默 */
  }
}

/* ─────────────────────────── 只读汇总（首页入口用） ─────────────────────────── */

/** 单模块读取失败只把它降级为 0，绝不拖垮整次汇总 */
async function safeCount(fn: () => Promise<number>, label: string): Promise<number> {
  try {
    return await fn()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'db', `inbox 汇总「${label}」读失败，按 0 处理：${msg}`)
    return 0
  }
}

/**
 * 汇总各模块「自上次查看以来的新内容条数」。
 *
 * 全部复用既有只读入口（follows / watch / keyword-alert / risk-watch / opinion-store），
 * **不发起任何检索或模型调用**（零新增上游成本）。四个模块各自 try/catch：
 * 任一读失败只把它算作 0（页面照常显示其它模块的角标），不会抛、不会让首页入口消失。
 *
 * @param opts.feed 是否统计关注动态（默认 true）。首页那枚「舆情」入口传 `false` ——
 *   关注更新归「消息中心（铃铛）」管，且 feed 的 `hasNew` 没有「清掉」的动作，
 *   并入角落角标会让红点永远熄不掉（见 pages/index 的用法），故它连这次读都不做。
 */
export async function loadInboxSummary(opts: { feed?: boolean } = {}): Promise<InboxCounts & { total: number }> {
  const seen = readInboxSeen()
  const includeFeed = opts.feed !== false

  const [feed, alert, risk, event] = await Promise.all([
    includeFeed
      ? safeCount(async () => {
          const rows = await listFollows()
          if (!rows.length) return 0
          return feedNewCount(await loadFollowWatches(rows))
        }, '关注动态')
      : Promise.resolve(0),
    safeCount(async () => alertNewCount((await loadAlerts()).groups), '关键词预警'),
    safeCount(async () => {
      const rows = await listPersonWatches()
      const keys = rows.map((r) => r.person_key).filter((k): k is string => !!k)
      if (!keys.length) return 0
      return riskNewCount(await loadRiskSignals(keys), seen.risk)
    }, '风险信号'),
    safeCount(async () => {
      /* 这里只要「身份 + 时间」两列，所以走投影读口（loadEventDigest）：
         用 loadStoredEvents 会把整条事件的成员 / 时间线 / 来源全拉回来，纯属白读 */
      const [rows, status] = await Promise.all([loadEventDigest(), loadEventStatus()])
      const events = (rows ?? []).map((r) => ({ key: r.event_key, at: r.last_at }))
      return countNewEvents(events, status)
    }, '舆情事件')
  ])

  return summarizeInbox({ feed, alert, risk, event })
}
