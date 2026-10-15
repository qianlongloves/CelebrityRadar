import { useAuth } from '@/stores/auth'
import { diagLog } from './cloud-diagnostics'
import { table } from './db'
import { compareOpinionOrder } from './opinion-rank'
import type { OpinionEvent, OpinionEventMember } from './opinion-events'
import type { OpinionEventRow, OpinionEventStatusRow } from '@/types/db'

/**
 * 舆情事件的**落库读取**与**个人状态**（P4，2026-10-13）。
 *
 * ## 分工（两张表，一共享一私有）
 *
 *   · `opinion_events`（全站共享、只读）：云函数 `opinionCluster` 定时读库聚类后写；
 *     端上**只读**（权限 `{"read": true, "write": false}`，同 report_cache / person_assets）。
 *     读库失败 / 集合为空 / 云函数没跑过 —— 都回落到本端聚类（见 resolveDisplayEvents），
 *     **绝不让事件卡空白或报错**。
 *   · `opinion_event_status`（每人一行，`_id = openid`，权限「仅创建者可读写」）：
 *     只放两项 —— **已读标记** 与 **跟进状态（含时间）**（产品明确锁定，不做备注、
 *     不做不感兴趣）。写只动这一行的两个 map，**绝不触碰 users 文档的任何字段**。
 *
 * ## 为什么状态另起一张表（而不是塞进 users 的一个子字段）
 *
 *   1. **不碰用户文档**：users 那一行住着昵称 / 头像 / settings / membership 镜像等一堆字段，
 *      任何「读-改-写」都有把别的字段写坏的风险；独立一行 + 独立集合把风险面收敛成 0。
 *   2. **权限最小**：状态是纯个人数据，用「仅创建者可读写」即可（端上直接写、云端不必介入），
 *      不必给它开任何云端写口。
 *   3. **可裁剪**：一张表一行 / 人，map 的条数上限与裁剪策略只落在一处（见 pruneStatus）。
 *   代价是每次读状态多一次查询 —— 但它与读事件并发发出（见页面），体感无差。
 *
 * ## 「新事件」判定规则（哪些是上次之后新出现的）
 *
 *   · 该 event_key **没有已读标记** → `new`（从没见过这件事）；
 *   · 有标记、且**最近一条报道时间 `last_at` 晚于上次已读时刻** → `update`（这件事有了新进展）；
 *   · 其余 → `seen`。
 *
 * ⚠ 刻意用 `last_at`（成员里最近一条报道的时间）而不是 `updated_at`：后者每轮重算都会前移
 *   （哪怕一条新报道都没有），用它会把老事件天天判成「新」。比较前两侧都解析成毫秒
 *   （媒体时间形态不一），任一不可解析即按 `seen`（算不出就不猜）。
 */

/** 事件集合（云函数写、端上只读） */
export const EVENT_TABLE = 'opinion_events'
/** 个人状态集合（`_id = openid`，端上读写自己那一行） */
export const STATUS_TABLE = 'opinion_event_status'

/** 一次读库最多取多少条事件（够铺满事件卡；超出部分靠排序取最近的）。与云函数单轮产出上限同量级 */
export const EVENT_READ_LIMIT = 200

/**
 * 状态 map 的**条数上限**（reads + follows 两个 map 的条目合计）。
 *
 * 为什么要有：事件会持续新增，若不设上限，一个长期用户的状态行会无限增大，
 * 最终撞上单文档体积上限、读写都变慢。取 300 的依据：它是「关注的人 + 监控词」
 * 能持续产出的事件量级的上界（每天新增通常个位数），300 条足够覆盖数月，
 * 超出时按「最近活跃」裁剪（见 pruneStatus），**不会**把刚标的状态裁掉。
 */
export const MAX_STATUS_ENTRIES = 300

/** 个人状态（内存形态）：两个 map，键是 event_key，值是 ISO 时刻 */
export interface EventStatus {
  reads: Record<string, string>
  follows: Record<string, string>
}

export function emptyStatus(): EventStatus {
  return { reads: {}, follows: {} }
}

/** 只保留值是非空字符串的条目（脏数据 / 历史形态一律忽略） */
function sanitizeMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val) out[k] = val
  }
  return out
}

/**
 * 裁剪状态到 `max` 条（默认 MAX_STATUS_ENTRIES）：按每个 key 的**最近活跃时刻**（reads / follows
 * 里较晚者）降序保留，超出者整键删除。纯函数，不改入参。
 */
export function pruneStatus(status: EventStatus | null | undefined, max: number = MAX_STATUS_ENTRIES): EventStatus {
  const reads = sanitizeMap(status && status.reads)
  const follows = sanitizeMap(status && status.follows)
  const total = Object.keys(reads).length + Object.keys(follows).length
  if (total <= max) return { reads, follows }

  const keys = [...new Set([...Object.keys(reads), ...Object.keys(follows)])]
  const latestOf = (k: string): number => {
    const a = Date.parse(reads[k] || '')
    const b = Date.parse(follows[k] || '')
    return Math.max(Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0)
  }
  keys.sort((a, b) => latestOf(b) - latestOf(a) || (a < b ? -1 : 1))

  const outReads: Record<string, string> = {}
  const outFollows: Record<string, string> = {}
  let kept = 0
  for (const k of keys) {
    const cost = (k in reads ? 1 : 0) + (k in follows ? 1 : 0)
    if (kept + cost > max) continue /* 放不下就整键丢弃（宁可少留，也不超上限） */
    if (k in reads) outReads[k] = reads[k]
    if (k in follows) outFollows[k] = follows[k]
    kept += cost
  }
  return { reads: outReads, follows: outFollows }
}

/**
 * 读**我自己的**状态（只查 `_id = 我的 openid` 那一行；写不到、也不读别人的）。
 * 未登录 / 读失败 → 空状态（页面照常工作，只是显示为「都没读过」）。
 */
export async function loadEventStatus(): Promise<EventStatus> {
  const userId = useAuth.getState().userId
  if (!userId) return emptyStatus()
  const { data, error } = await table(STATUS_TABLE).select('*').eq('id', userId).maybeSingle()
  if (error) {
    diagLog('warn', 'db', `${STATUS_TABLE} 读取失败：${error.message ?? error}`)
    return emptyStatus()
  }
  const row = data as OpinionEventStatusRow | null
  return { reads: sanitizeMap(row?.reads), follows: sanitizeMap(row?.follows) }
}

/** 写回状态（整行 upsert；`_id = openid`）。失败只记日志并返回 false —— 调用方据此回滚本地乐观态 */
async function saveStatus(status: EventStatus): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  const pruned = pruneStatus(status)
  const { error } = await table(STATUS_TABLE).upsert({
    id: userId,
    reads: pruned.reads,
    follows: pruned.follows,
    updated_at: new Date().toISOString()
  })
  if (error) {
    diagLog('warn', 'db', `${STATUS_TABLE} 写入失败：${error.message ?? error}`)
    return false
  }
  return true
}

/** 标记「已读」（记下当前时刻，供「有新进展」判定）。返回写库是否成功 */
export async function markEventRead(eventKey: string, now: Date = new Date()): Promise<boolean> {
  if (!eventKey) return false
  const cur = await loadEventStatus()
  return saveStatus({ ...cur, reads: { ...cur.reads, [eventKey]: now.toISOString() } })
}

/**
 * 批量标记「已读」（舆情页「全部已读」用）：一次读状态、一次写回，
 * 避免逐条 `markEventRead` 变成 N 次读-改-写。键去重、空键跳过，裁剪交给 saveStatus。
 * 返回写库是否成功；无有效键时视为「无事可做」，返回 true（调用方据此不报错）。
 */
export async function markEventsRead(eventKeys: string[], now: Date = new Date()): Promise<boolean> {
  const keys = [...new Set((Array.isArray(eventKeys) ? eventKeys : []).filter((k): k is string => typeof k === 'string' && !!k))]
  if (keys.length === 0) return true
  const cur = await loadEventStatus()
  const reads = { ...cur.reads }
  const iso = now.toISOString()
  for (const k of keys) reads[k] = iso
  return saveStatus({ ...cur, reads })
}

/** 设置 / 取消「跟进」（含时间）。返回写库是否成功 */
export async function setEventFollow(
  eventKey: string,
  follow: boolean,
  now: Date = new Date()
): Promise<boolean> {
  if (!eventKey) return false
  const cur = await loadEventStatus()
  const follows = { ...cur.follows }
  if (follow) follows[eventKey] = now.toISOString()
  else delete follows[eventKey]
  return saveStatus({ ...cur, follows })
}

/* ─────────────────────────── 读事件 + 展示转换 ─────────────────────────── */

/**
 * 读落库事件。**读失败返回 `null`**（与「集合为空返回 `[]`」区分开）：调用方据此决定回落本端聚类。
 */
export async function loadStoredEvents(): Promise<OpinionEventRow[] | null> {
  const { data, error } = await table(EVENT_TABLE)
    .select('*')
    .order('last_at', { ascending: false })
    .limit(EVENT_READ_LIMIT)
  if (error) {
    diagLog('warn', 'db', `${EVENT_TABLE} 读取失败，回落本端聚类：${error.message ?? error}`)
    return null
  }
  return (data as OpinionEventRow[]) ?? []
}

/** 「与我相关」现算：成员 label 直接命中，或标题 / 摘要正文里出现我盯的词 / 人名（与 opinion-rank#toEntry 同口径） */
function hitsOf(
  members: OpinionEventMember[],
  keywords: string[],
  watchNames: string[]
): { hitsKeyword: boolean; hitsFollow: boolean } {
  const hay = members.map((m) => `${m.title} ${m.summary}`).join(' ').toLowerCase()
  const has = (label: string | undefined, list: string[]): boolean =>
    !!label && list.includes(label)
  return {
    hitsKeyword: members.some((m) => has(m.label, keywords)) || keywords.some((k) => k && hay.includes(k.toLowerCase())),
    hitsFollow: members.some((m) => has(m.label, watchNames)) || watchNames.some((n) => n && hay.includes(n.toLowerCase()))
  }
}

/**
 * 落库事件 → 端上渲染用的事件（把 `OpinionEventRow` 补成 `OpinionEvent`）。
 * 补的只有「与我相关」两项（`hitsKeyword` / `hitsFollow`）—— 它们是按用户算的，存库事件不带。
 * 其余字段同名同义直接透传（端上不会出现两套字段名）。最后按 P1 统一口径排序。
 */
export function toDisplayEvents(
  rows: OpinionEventRow[],
  opts: { keywords?: string[]; watchNames?: string[] } = {}
): OpinionEvent[] {
  const keywords = (opts.keywords ?? []).filter(Boolean)
  const watchNames = (opts.watchNames ?? []).filter(Boolean)
  const out: OpinionEvent[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.event_key || !row.title) continue
    const members = Array.isArray(row.members) ? row.members : []
    const hits = hitsOf(members, keywords, watchNames)
    /* memberTotal 是 2026-10-16 才加的字段：老行没有它（undefined）⇒ 回落成员数（诚实的近似）。
       `> 0 才认` 而不是「是有限数就认」：万一某行被写成 0（历史回填 / 手改），
       事件卡会显示「0 条来源」—— 少报几条远好过报出一个不可能为 0 的 0。 */
    const rowTotal = Number.isFinite(row.memberTotal) ? (row.memberTotal as number) : 0
    out.push({
      id: row.event_key,
      key: row.event_key,
      objectKey: row.object_key || '',
      block: row.block,
      title: row.title,
      members,
      memberCount: Number.isFinite(row.memberCount) ? row.memberCount : members.length,
      /* memberTotal 是 2026-10-16 才加的字段：老行没有它 → 回落成员数。
         绝不回落成 0 —— 事件卡上**少报**来源数比多报更糟 */
      memberTotal: rowTotal > 0 ? rowTotal : members.length,
      timeline: Array.isArray(row.timeline) ? row.timeline : [],
      sources: Array.isArray(row.sources) ? row.sources : [],
      labels: Array.isArray(row.labels) ? row.labels : [],
      impact: row.impact,
      credibility: row.credibility,
      response: row.response,
      hitsKeyword: hits.hitsKeyword,
      hitsFollow: hits.hitsFollow,
      date: row.last_at || ''
    })
  }
  out.sort(compareOpinionOrder)
  return out
}

/**
 * 事件视角的取数：**落库优先、失败 / 空则回落本端聚类**。
 *
 * 这是「端上必须有降级」的落点 —— 云函数没跑过、集合空、读失败（`null`）三种情况都回落到
 * 页面传入的 `localEvents`（本端 `buildOpinionEvents` 的结果），页面始终有事件可渲染，
 * **不会空白、不报错**。返回 `source` 只为排障 / 用例断言，不参与渲染。
 *
 * `localEvents` 由调用方（页面）用 `buildOpinionEvents(opinionInput)` 现算后传入 ——
 * 本函数**不**自己 require 聚类层，免得「读库层」与「聚类层」互相耦合。
 */
export function resolveDisplayEvents(
  stored: OpinionEventRow[] | null,
  opts: { keywords?: string[]; watchNames?: string[] },
  localEvents: OpinionEvent[]
): { events: OpinionEvent[]; source: 'cloud' | 'local' } {
  if (stored && stored.length > 0) {
    const events = toDisplayEvents(stored, opts)
    if (events.length > 0) return { events, source: 'cloud' }
  }
  return { events: localEvents, source: 'local' }
}

/**
 * **按 event_key 定位单个事件**（事件时间线页用）：落库优先、**该键不在库里才回落本端聚类**。
 *
 * 与 `resolveDisplayEvents` 的区别：后者回答「整张事件列表用哪份数据」（只要库里有任意事件就用库），
 * 本函数回答「**这一件事**在哪」—— 库里**没有这一键**时（云函数当天还没跑、或该事件只在端上聚类出现）
 * 仍然会去本端聚类结果里找，而不是因为「库里有别的事件」就放弃。返回 `source` 只为排障 / 断言。
 *
 * 三档来源：`cloud`（库里命中该键）/ `local`（库里没有 → 本端聚类命中）/ `none`（两处都没有）。
 * `stored` 传 `null`（读失败）按「库里没有」处理，同样回落本端聚类。纯函数，对任何输入都不抛。
 */
export function resolveEventByKey(
  stored: OpinionEventRow[] | null,
  localEvents: OpinionEvent[],
  eventKey: string,
  opts: { keywords?: string[]; watchNames?: string[] } = {}
): { event: OpinionEvent | null; source: 'cloud' | 'local' | 'none' } {
  const key = typeof eventKey === 'string' ? eventKey : ''
  if (!key) return { event: null, source: 'none' }

  if (Array.isArray(stored)) {
    const rows = stored.filter((r) => r && r.event_key === key)
    if (rows.length > 0) {
      const events = toDisplayEvents(rows, opts)
      if (events.length > 0) return { event: events[0], source: 'cloud' }
    }
  }

  const local = (Array.isArray(localEvents) ? localEvents : []).find((e) => e && e.key === key)
  if (local) return { event: local, source: 'local' }
  return { event: null, source: 'none' }
}

/* ─────────────────────────── 「新事件」判定 ─────────────────────────── */

export type EventNewness = 'new' | 'update' | 'seen'

/**
 * 一条事件对我而言「新不新」（规则见文件头「新事件判定规则」）。
 * 输入取最小字段集：任何带 `event_key` / `last_at` 的行都够用。
 */
export function eventNewness(
  row: { event_key?: string; last_at?: string } | null | undefined,
  status: EventStatus | null | undefined
): EventNewness {
  const key = row && row.event_key
  if (!key) return 'seen'
  const readAt = status && status.reads ? status.reads[key] : undefined
  if (!readAt) return 'new'
  const last = Date.parse(String((row && row.last_at) || ''))
  const read = Date.parse(readAt)
  if (Number.isFinite(last) && Number.isFinite(read) && last > read) return 'update'
  return 'seen'
}

/** 新事件角标文案（'seen' 不出角标，返回空串） */
export function newnessLabel(n: EventNewness): string {
  if (n === 'new') return 'NEW'
  if (n === 'update') return '有新进展'
  return ''
}
