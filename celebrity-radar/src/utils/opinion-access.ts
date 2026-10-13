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

/* ────────────────── 概要卡按需加载（端上分片渲染，P6，2026-10-13） ────────────────── */

/**
 * **概要卡**首屏渲染条数（固定 3）—— 舆情页三张概要卡（事件 / 关注动态 / 关键词预警）**共用**。
 *
 * ⚠ **刻意不按会员档**：会员档的「全部」（`detailRows.member === null`）是给**明细**用的口径，
 *   安在**概要卡**上是**用错了位置** —— 概要数据都是**会累积**的：事件一轮聚类实测约 200 条；
 *   关注动态 = 关注人数 × 条目；关键词预警 = 各监测词的条目之和。若概要卡按明细口径放全，
 *   会员一进舆情页就会把整库一次性渲染出来，页面「内容过多」。故三张概要卡对免费 / 会员
 *   **一律**只放固定首屏若干条，其余靠 `overviewSlice` + 底部「加载更多」按需追加。
 *
 * ⚠ **口径变化（P6，2026-10-13）——「概要不分档」**：改完后舆情页三张概要卡对免费 / 会员
 *   **一视同仁**，于是**「明细条数」这一层分层在舆情页上不再体现**。这不是把分层删了 ——
 *   分层的**其余部分仍生效**：
 *     · 关注人数 / 关键词监控数 / 风险监控人数上限（`followGate` / `watchGate` / `personWatchGate`，P2）；
 *     · 事件**时间线页**的明细门禁（pages/event：免费 5 / 会员全部，走 `sliceDetail`）。
 *   换言之：概要不是明细，「明细分档」只作用在真正的明细页 / 时间线上（见 pages/event）。
 *   （用户已明确选择「概要不分档」，故**不给「加载更多」加免费封顶**。）
 */
export const EVENT_OVERVIEW_INITIAL = 3

/** 概要卡每次「加载更多」追加的条数（三张概要卡共用） */
export const EVENT_OVERVIEW_BATCH = 3

/** 概要卡分片结果：`rows` 是**累计**要渲染的行，`remaining` 是尚未渲染的剩余条数 */
export interface OverviewSlice<T> {
  /** 累计要渲染的行（`items.slice(0, shown)`，越界按总数截断） */
  rows: T[]
  /** 还没渲染出来的条数（`items.length - rows.length`） */
  remaining: number
  /** 是否还有更多（`remaining > 0`）—— 决定页面显示「加载更多」还是到底文案 */
  hasMore: boolean
}

/**
 * 概要卡「少渲染 + 按需追加」切片（**纯函数**，对任何输入都不抛）。
 *
 * 与 `sliceDetail` 的区别：`sliceDetail` 是**按会员档**截断明细（免费 / 会员两档）；本函数
 * **完全不涉及会员态** —— 它只回答「当前已渲染了 `shown` 条时，应渲染哪一段、还剩多少」，
 * 供页面实现「固定首屏 + 加载更多」，避免概要卡按明细口径把整库一次放全（这是本函数存在的理由）。
 *
 * 边界：空 / 非数组 → `rows: []`、`remaining: 0`、`hasMore: false`；
 * `shown` 非法（非正 / NaN）→ 退回一个批次；`batch` 非法 → 退回 `EVENT_OVERVIEW_BATCH`；
 * `shown` 超过总数时按总数截断（不会抛、不会多算）。
 */
export function overviewSlice<T>(
  items: T[] | null | undefined,
  shown: number,
  batch: number = EVENT_OVERVIEW_BATCH
): OverviewSlice<T> {
  const list = Array.isArray(items) ? items : []
  const step = Number.isFinite(batch) && batch > 0 ? Math.floor(batch) : EVENT_OVERVIEW_BATCH
  const want = Number.isFinite(shown) && shown > 0 ? Math.floor(shown) : step
  const rows = list.slice(0, Math.min(want, list.length))
  const remaining = list.length - rows.length
  return { rows, remaining, hasMore: remaining > 0 }
}

/* ─────────────────────────── 时间线分页（客户端分段渲染） ─────────────────────────── */

/**
 * 事件时间线**每页条数**（产品口径；真源在此，页面与用例共用）。
 *
 * ⚠ 分页只能是**客户端分段渲染**，不是服务端分页：时间线是**事件文档里的一个嵌套数组**
 *   （`opinion_events.timeline`），云数据库无法对嵌套数组做服务端分页 —— 一次 `loadStoredEvents`
 *   就把该事件整条取回，分页只是「按页切片渲染」。
 *   · 单事件条目在**几十条**（本值的一屏）量级时，这个做法完全够用；
 *   · 当单个事件的条目增长到**数百条**（例如 `timeline.length` 稳定超过 ~200）时，
 *     一次取回整条文档会明显变重（首屏变慢、单文档体积逼近上限），
 *     此时应改成像 `opinion_event_items` 那样**按 `event_key + 序号` 单独落一张集合**、
 *     用 `where(event_key).skip().limit()` 做**真分页**。**本轮不新建该集合**
 *     （现有事件的条目量远未到该规模，新建集合的跨会话一致性成本不值得）。
 */
export const TIMELINE_PAGE_SIZE = 10

/**
 * 关注动态页（`pages/feed`）**每页条数**（产品口径；真源在此，页面与用例共用）。
 *
 * ⚠ 与事件时间线是**同一取舍**：关注动态也是**一次取回全部**（`cache.ts#getFeedDetails`
 *   把全部关注人的 `feed_cache` 用一次 `in` 查询批量读回），云数据库无法对「跨多位关注人、
 *   已归并排序后的一维列表」做服务端分页 —— 分页只能是**客户端分段渲染**（按页切片）。
 *   · 关注动态 = 关注人数 × 每人约 10 条；关注十几位时总量在**一两百条**量级，本做法足够；
 *   · 当关注人数 × 每人条数增长到**数千条**（例如关注上百人）时，一次把全部人的 feed_cache
 *     取回会明显变重（首屏数据量、归并排序耗时都上来了），此时应改成像 `weekly.ts` 选人那样
 *     **按关注的人分批查询**（`where(person_key in […]).skip().limit()` 逐批取，边取边渲染）——
 *     即把分页维度从「条目」换成「人」。**本轮不这么做**：零新增云调用是硬约束，且现规模未到。
 *
 * 取 10 而非概要卡的 3：本页是「查看全部」之后的**完整页**，用户是带着「我要看全部」的预期进来的，
 * 一屏 10 张卡（约两屏内容）比 3 条更尊重这个预期；同时与事件时间线页取同一档，减少心智与代码分叉。
 */
export const FEED_PAGE_SIZE = 10

/**
 * 事件列表页（`pages/events`）**每页条数**（产品口径；真源在此，页面与用例共用）。
 *
 * ⚠ 与关注动态页 / 事件时间线页是**同一取舍**：事件列表的数据也是**一次取回全部** ——
 *   `opinion-store#loadStoredEvents` 一次读回 `opinion_events` 最近 `EVENT_READ_LIMIT` 条；
 *   库里取不到再回落端上 `buildOpinionEvents` 聚类。云数据库无法对「端上聚类后的一维事件列表」
 *   做服务端分页 —— 分页只能是**客户端分段渲染**（按页切片，复用 `pageSlice`）。
 *   · 事件一轮聚类实测约 200 条（见 `opinion-store#EVENT_READ_LIMIT` 的取值依据），本做法足够；
 *   · 当事件量增长到**数千条**（例如 `opinion_events` 稳定超过一两千）时，一次把整集合读回会
 *     明显变重（首屏数据量、端上聚类耗时都上来了），此时应改成像时间线明细那样**按
 *     `event_key` 落一张可 `skip().limit()` 的集合**、或让云函数支持按 `last_at` 游标翻页。
 *     **本轮不新建集合 / 不改云函数**（零新增云调用是硬约束，且现规模未到）。
 *
 * 取 10 而非概要卡的 3：本页是「查看全部事件」之后的**完整页**，用户带着「我要看全部」的预期进来；
 * 与关注动态页 `FEED_PAGE_SIZE`、事件时间线页 `TIMELINE_PAGE_SIZE` 取同一档（都是 10），
 * 减少心智与代码分叉。
 */
export const EVENTS_PAGE_SIZE = 10

/** 分页切片结果：`rows` 是「累计到第 page 页应渲染的行」（第 1..page 页，非单页） */
export interface PageSlice<T> {
  /** 累计渲染的行（`items.slice(0, page × pageSize)`） */
  rows: T[]
  /** 是否还有下一页（`page × pageSize < items.length`） */
  hasMore: boolean
  /** 当前页号（从 1 起；越界会被钳到 `[1, max(1, pageCount)]`） */
  page: number
  /** 总页数（空数据为 0） */
  pageCount: number
  /** 尚未渲染的条数（`items.length - rows.length`）—— 供「还有 N 条」文案 */
  remaining: number
}

/**
 * 分页切片（**纯函数**，对任何输入都不抛）：把一维数组按固定页长切成「累计行」。
 *
 * 为什么返回**累计**而不是单页：触底加载是「在后面追加」，页面只需渲染 `rows`、
 * 不必自己维护已加载数组的拼接 —— 页号变了、`rows` 自然变长。
 *
 * 边界：空 / 非数组 → `rows: []`、`hasMore: false`、`page: 1`、`pageCount: 0`；
 * 页号非正整数或超过总页数 → 钳到合法页（不会因为越界而少渲染最后一段）。
 */
export function pageSlice<T>(items: T[] | null | undefined, page: number, pageSize: number = TIMELINE_PAGE_SIZE): PageSlice<T> {
  const list = Array.isArray(items) ? items : []
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : TIMELINE_PAGE_SIZE
  const pageCount = Math.ceil(list.length / size)
  const want = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
  const cur = pageCount > 0 ? Math.min(want, pageCount) : 1
  const end = cur * size
  const rows = list.slice(0, end)
  return {
    rows,
    hasMore: end < list.length,
    page: cur,
    pageCount,
    remaining: list.length - rows.length
  }
}
