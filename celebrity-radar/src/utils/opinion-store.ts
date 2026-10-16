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
 *     放三项 —— **已读标记**、**跟进状态（含时间）**、**订阅对象（含时间，E1-②）**。
 *     三者都是「我这边的事实」，**没有一个是内容编辑**（产品锁定：不做备注、不做不感兴趣）。
 *     写只动这一行的这几个 map，**绝不触碰 users 文档的任何字段**。
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
 *
 * ## 「跟进」（follows）是什么（E1，2026-10-16）
 *
 *   跟进**不是第二套已读态**，而是「这件事的后续我要知道」这条订阅关系。写了 `follows[key]` 之后：
 *     · 云端日报（`cloudfunctions/notifyFollowUpdates`）把它当候选 —— 有新报道就提醒一次；
 *     · 舆情页的「全部已读」**跳过**它 —— 一键清屏不该把我明确盯上的那件事一起抹掉；
 *     · 站内另有「我盯的 N 条有新进展」计数（`utils/inbox#countFollowUpdates`）。
 *
 *   ⚠ 但**角标（`new` / `update` / `seen`）仍然只看 `reads`**，跟进既不推进基线、也不参与判定。
 *   理由是一条内容只能有**一个**「消掉」的动作，而两个基线各自前移会掉进两种错法：
 *     · 拿 follows 当基线（`last_at > follows` 即有进展）：用户「读完」推进的是 reads，角标不消 ——
 *       上次读过的进展会一直挂着，而挂着的角标是不会再让人点第二次的；
 *     · 让「点跟进」也推进基线：点下去那一瞬间就把当前的「有新进展」吃掉，用户明知还没读
 *       （他刚在列表里看到角标才点的跟进），这等于骗他。
 *   所以这里只让 `reads` 判角标；「跟进的东西不被批量清掉」交给**调用方**（markAllRead）决定，
 *   云端能不能打扰用户则另看「读完 / 已提醒 / 决定盯它」三个时刻（见云函数里的判定注释）。
 *
 * ## 「订阅对象」（subs）是什么（E1-②，2026-10-16）
 *
 *   跟进回答「**这一条**事件的后续我要知道」；订阅回答「**这个对象**（人 / 关键词）的后续事件我要看」。
 *   粒度差一层，所以 `subs` 的键是**对象标签文本**、不是 event_key，而 `reads` / `follows` 的键都是 event_key。
 *
 *   ⚠ 本文件只负责「**存**」（透传 + 整块写回），口径（归一化、匹配、上限、消费视图）全在
 *   `utils/event-subscribe.ts` —— 那些是产品语义，放这里会让「读库层」越界去解释事件内容。
 *   也正因两者键空间不同，`subs` **不占** `MAX_STATUS_ENTRIES` 的额度（见 pruneStatus 注释）。
 *
 *   ⚠ 订阅**不产生第二套角标**：订阅到的对象命中的事件，本来就在事件模块里参与 `new` / `update`
 *   判定。再给它算一个角标 = 同一件事在两个地方各提醒一次，用户读到的是「有两条新东西」。
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

/** 个人状态（内存形态）：三个 map，值是 ISO 时刻。`reads`/`follows` 的键是 event_key，`subs` 的键是订阅对象标签 */
export interface EventStatus {
  /** event_key → 已读时刻（ISO）：角标的**唯一**基线（见文件头「跟进」一节） */
  reads: Record<string, string>
  /** event_key → 跟进时刻（ISO）：订阅关系（云端日报候选 + 不被「全部已读」清掉），不参与角标判定 */
  follows: Record<string, string>
  /**
   * 订阅对象标签 → 订阅时刻（ISO），E1-②。
   * **键不是 event_key**（是「人 / 关键词」的标签文本），见 `types/db.ts#OpinionEventStatusRow`。
   * 可选：存量行没有这个字段，缺省 = 没订阅过任何对象。
   */
  subs?: Record<string, string>
}

export function emptyStatus(): EventStatus {
  return { reads: {}, follows: {}, subs: {} }
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
 *
 * ⚠ 只裁 `reads` / `follows`（两者键空间相同、都是 event_key，共用一个额度）；
 * `subs` **原样透传**、不参与这个额度 —— 订阅对象是显式动作、粒度更大、条数天然少，
 * 让它跟读事件抢额度会导致「多读几百条事件就把订阅静默挤掉」。
 * `subs` 自己的上限在 `utils/event-subscribe.ts#SUB_MAX`。
 */
export function pruneStatus(status: EventStatus | null | undefined, max: number = MAX_STATUS_ENTRIES): EventStatus {
  const reads = sanitizeMap(status && status.reads)
  const follows = sanitizeMap(status && status.follows)
  const subs = sanitizeMap(status && status.subs)
  const total = Object.keys(reads).length + Object.keys(follows).length
  if (total <= max) return { reads, follows, subs }

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
  return { reads: outReads, follows: outFollows, subs }
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
  return { reads: sanitizeMap(row?.reads), follows: sanitizeMap(row?.follows), subs: sanitizeMap(row?.subs) }
}

/**
 * 写回状态（整行 upsert；`_id = openid`）。失败只记日志并返回 false —— 调用方据此回滚本地乐观态。
 *
 * ⚠ **导出**给 `utils/event-subscribe.ts` 用：订阅对象（`subs`）与已读 / 跟进（`reads` / `follows`）
 * 共用同一行，必须走同一个写口 —— 否则两个模块各自「读-改-写」会互相把对方的字段覆盖回旧值。
 */
export async function saveEventStatus(status: EventStatus): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  const pruned = pruneStatus(status)
  const { error } = await table(STATUS_TABLE).upsert({
    id: userId,
    reads: pruned.reads,
    follows: pruned.follows,
    /* 整行覆盖（upsert = doc.set）：取消订阅后这里就是空对象，也必须照写，否则旧订阅在库里留着 */
    subs: pruned.subs ?? {},
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
  return saveEventStatus({ ...cur, reads: { ...cur.reads, [eventKey]: now.toISOString() } })
}

/**
 * 批量标记「已读」（舆情页「全部已读」用）：一次读状态、一次写回，
 * 避免逐条 `markEventRead` 变成 N 次读-改-写。键去重、空键跳过，裁剪交给 saveStatus。
 * 返回写库是否成功；无有效键时视为「无事可做」，返回 true（调用方据此不报错）。
 *
 * ⚠ 入参由**调用方**决定收哪些键：舆情页的「全部已读」会把**已跟进**的键排除掉
 * （一键清屏不该抹掉我明确盯上的那件事，见文件头「跟进」一节）。本函数自身不做这件事 ——
 * 「标已读」就是标已读，单条的 `markEventRead` 对已跟进的事件照样有效：用户真的读了，角标就该消。
 */
export async function markEventsRead(eventKeys: string[], now: Date = new Date()): Promise<boolean> {
  const keys = [...new Set((Array.isArray(eventKeys) ? eventKeys : []).filter((k): k is string => typeof k === 'string' && !!k))]
  if (keys.length === 0) return true
  const cur = await loadEventStatus()
  const reads = { ...cur.reads }
  const iso = now.toISOString()
  for (const k of keys) reads[k] = iso
  return saveEventStatus({ ...cur, reads })
}

/**
 * 设置 / 取消「跟进」（含时间）。返回写库是否成功。
 *
 * ⚠ 这一行**不只是端上自己看**（E1，2026-10-16）：云函数 `notifyFollowUpdates` 会以管理员身份
 * 读 `follows`，把跟进的事件当日报候选。也就是说本函数是**该订阅关系的唯一入口** ——
 * 别在别处「顺手」改这些键（撤回跟进 = 删键 = 从此不再提醒，语义要保证一致）。
 */
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
  return saveEventStatus({ ...cur, follows })
}

/* ─────────────────────────── 读事件 + 展示转换 ─────────────────────────── */

/**
 * 落库事件的**内存级 TTL 缓存**时长（毫秒）。
 *
 * 为什么要有这层缓存：读一次 `opinion_events` 要跨页取 `EVENT_READ_LIMIT`(200) 条 ——
 * 小程序端单页上限 20 ⇒ 10 次往返、约 500 KB。而**同一次启动里它会被读好几遍**：
 *   · 舆情页 `useDidShow`：首屏一次、从事件列表 / 事件详情返回各一次；
 *   · 事件列表页 `useDidShow`：首屏一次、从详情返回又一次。
 * 可这份数据几乎不变（云函数 `opinionCluster` 每天产出一轮，端上全程只读），
 * 于是「同一份数据在一次启动里被拉三遍」纯属白等，弱网下直接拖慢首屏。
 *
 * 取 60 秒的理由：足够覆盖「进列表 → 进详情 → 返回」这类秒级连续动作，
 * 又不至于让用户**手动**下拉刷新之后还长时间盯着旧数据 —— 何况下拉刷新会显式调
 * `invalidateStoredEvents()` 把缓存丢掉，不靠这个时长兜底（见该函数）。
 */
export const EVENT_CACHE_TTL = 60 * 1000

/** 缓存住的行（`null` = 还没有可用缓存 —— 读失败**不缓存**，见 loadStoredEvents） */
let cachedRows: OpinionEventRow[] | null = null
/** 缓存写入时刻（毫秒） */
let cachedAt = 0
/** 在途请求：同一次启动里的并发调用合并成一次读库（不再是「四块数据各拉一遍」） */
let inflight: Promise<OpinionEventRow[] | null> | null = null
/** 在途请求所属的世代（与 `generation` 不等即已作废，见下方 generation 注释） */
let inflightGen = -1
/**
 * 「缓存世代」：每次 `invalidateStoredEvents()` 自增。
 *
 * 为什么必须有它：invalidate 之后可能仍有**旧世代**的读在途（用户下拉刷新时，上一轮
 * 页面重入的十次往返可能还没跑完）。若不认世代，那一轮旧结果回来会把刚作废的缓存**又填回去**
 * —— 用户明明拉了一下刷新，看到的却还是刷新前那份数据。故：只有「发起时与落地时同世代」
 * 的结果才允许写缓存，且旧世代的在途请求不再被新调用复用（新的调用重新发一次读）。
 */
let generation = 0

/**
 * 丢掉落库事件缓存，让下一次 `loadStoredEvents()` 重新读库。
 *
 * 调用点只有「用户显式要求重取」那一处（事件列表页下拉刷新）。**不要在普通的页面重入
 * （`useDidShow`）里调它** —— 那等于把缓存又作废掉，白白多十次往返。
 */
export function invalidateStoredEvents(): void {
  cachedRows = null
  cachedAt = 0
  generation++
}

/**
 * 读落库事件。**读失败返回 `null`**（与「集合为空返回 `[]`」区分开）：调用方据此决定回落本端聚类。
 *
 * 带内存级 TTL 缓存（见 `EVENT_CACHE_TTL`），三条口径：
 *   · **TTL 内命中缓存直接返回**（不读库）—— 页面重入 / 多入口同用一份数据时省掉十次往返；
 *   · **读失败不写缓存**（`null` 不入缓存）：失败要能立刻重试，否则一次网络抖动会让整页
 *     在 TTL 内一直回落到本端聚类；
 *   · **空集合 `[]` 照常缓存**：云函数没跑过时「空」也是稳定事实，重复去读同样十次往返。
 * 并发调用（同一时刻多个入口各读一次）合并为**一次**读库请求（在途 promise 复用）。
 * 拿到的是**同一份数组引用**：调用方（页面）只读不写，别就地改它。
 */
export async function loadStoredEvents(): Promise<OpinionEventRow[] | null> {
  if (cachedRows !== null && Date.now() - cachedAt < EVENT_CACHE_TTL) return cachedRows
  /* 只复用**同世代**的在途请求：被 invalidate 作废的那一次不能拿来交差（见 generation 注释） */
  if (inflight && inflightGen === generation) return inflight

  const gen = generation
  const task = (async (): Promise<OpinionEventRow[] | null> => {
    const { data, error } = await table(EVENT_TABLE)
      .select('*')
      .order('last_at', { ascending: false })
      .limit(EVENT_READ_LIMIT)
    if (error) {
      diagLog('warn', 'db', `${EVENT_TABLE} 读取失败，回落本端聚类：${error.message ?? error}`)
      return null
    }
    return (data as OpinionEventRow[]) ?? []
  })()

  inflight = task
  inflightGen = gen
  const rows = await task
  /* 只清自己那一次（期间可能已被新一轮取代） */
  if (inflight === task) inflight = null
  /* 世代不符 = 期间被 invalidate 过：这份结果已经作废，交回调用方但**不许**写缓存 */
  if (rows !== null && gen === generation) {
    cachedRows = rows
    cachedAt = Date.now()
  }
  return rows
}

/**
 * 按 `event_key` 只读**这一条**（事件时间线页用）。
 *
 * 原先那一页调的是 `loadStoredEvents()`：为了定位 1 条事件，把最近 `EVENT_READ_LIMIT` 条全拉回来
 * 再 `filter` —— 进一次详情页要十次往返、几百 KB，而其中 199 条是白读的。
 * 事件身份本就是 `event_key`（唯一），把这个条件**下推到库里**：1 次请求、1 条文档。
 *
 * 口径与 `loadStoredEvents` 逐条对齐：读失败返回 `null`（调用方据此回落本端聚类），
 * 库里没有这一键返回 `[]`（不是失败）。`eventKey` 原样使用、不做 trim ——
 * 必须与 `resolveEventByKey` 的匹配口径完全一致（那边也是原样比较），否则会出现
 * 「按 key 查得到、拿结果去匹配又匹配不上」的错位。
 */
export async function loadStoredEventByKey(eventKey: string): Promise<OpinionEventRow[] | null> {
  const key = typeof eventKey === 'string' ? eventKey : ''
  if (!key) return []
  const { data, error } = await table(EVENT_TABLE)
    .select('*')
    .eq('event_key', key)
    .limit(1)
  if (error) {
    diagLog('warn', 'db', `${EVENT_TABLE} 按 event_key 读取失败，回落本端聚类：${error.message ?? error}`)
    return null
  }
  return (data as OpinionEventRow[]) ?? []
}

/**
 * 只读「身份 + 时间」两列（站内触达算「事件有没有新进展」用）。
 *
 * 为什么单独开一个读口：收件箱只需要 `event_key` 和 `last_at`，而 `loadStoredEvents` 会把整条
 * 事件（成员 ≤30 + 时间线 ≤30 + 来源列表）全拉回来 —— 单条实测约 2.8 KB，200 条要跨 10 页取、
 * 合计 500 KB 上下，而这些字段在算完一个计数之后就被丢掉了。投影之后每次请求只回两列。
 *
 * 失败返回 `null`（与 `loadStoredEvents` 同口径）：调用方按「没有事件」处理即可。
 */
export async function loadEventDigest(): Promise<Array<{ event_key: string; last_at: string }> | null> {
  const { data, error } = await table(EVENT_TABLE)
    .select('event_key,last_at')
    .order('last_at', { ascending: false })
    .limit(EVENT_READ_LIMIT)
  if (error) {
    diagLog('warn', 'db', `${EVENT_TABLE} 摘要读取失败：${error.message ?? error}`)
    return null
  }
  const rows = (data as Array<{ event_key?: unknown; last_at?: unknown }>) ?? []
  return rows
    .map((r) => ({ event_key: String(r?.event_key ?? ''), last_at: String(r?.last_at ?? '') }))
    .filter((r) => !!r.event_key)
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
