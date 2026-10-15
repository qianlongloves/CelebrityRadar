/**
 * 关注动态页的**视图模型**（纯函数，2026-10-15 重设计）。
 *
 * 为什么要把这些东西从页面里抠出来：
 *   重设计之前，「人物筛选 / 领域筛选 / 关键词匹配」三把筛子与分页切片全都长在
 *   `package/feed/index.tsx` 的渲染函数体里 —— 想验证「多选两位人物 + 近 7 天 + 关键词」
 *   叠加之后到底剩几条，只能把页面跑起来用肉眼看。抠成纯函数后，叠加规则可以在用例里
 *   逐条钉住（test/cases/46-feed-view.js），页面只负责「把结果画出来」。
 *
 * 三条不变量（改动本文件时逐条守住）：
 *   ① **筛选只做减法**：过滤结果里仍是原对象（不复制、不裁剪字段、不改组内顺序），
 *      页面因此可以拿它做分页切片的引用比对（见 feed/index.tsx 的 shown 集合）。
 *   ② **不静默丢信息**：任何把条目挡在门外的判断，都必须能被上层如实说出来 ——
 *      缺日期被时间档筛掉的条数见 `hiddenByRange`，同源报道被合并的条数见
 *      `dedupeFeedItems().merged`，页面两处都会显式提示。
 *   ③ **只认可核对的字段**：关键词只匹配 标题 / 摘要 / 人名，时间只认 `publishedDate`；
 *      一条读不出日期的动态**不会**被当成「今天」。
 */

import type { NewsItem } from './search'
import { dayKey8 } from './time'

/** 关注流条目：检索结果 + 它属于谁（页面归并时补齐，见 feed/index.tsx#load） */
export interface FeedEntry extends NewsItem {
  personKey: string
  personName: string
  /** 领域（自由短串，2026-10-12 领域自由化） */
  domain: string
}

/* ------------------------------ 筛选条件 ------------------------------ */

/**
 * 时间档位。
 *
 * 只有四档、且不含自定义区间：本页的数据是「关注的人最近这些动态」，条数以百计、
 * 时间跨度通常几周 —— 给一个起止日期选择器，用户每选一次都要面对「为什么空了」，
 * 而四档已经能回答「有没有新东西 / 这周发生了什么」。
 */
export type FeedRange = 'all' | 'today' | 'week' | 'month'

/** 筛选面板的三组条件：人物多选 / 领域多选 / 时间单档（默认全不设 = 不筛） */
export interface FeedFilter {
  persons: string[]
  domains: string[]
  range: FeedRange
}

/**
 * 「什么条件都没设」。
 *
 * ⚠ 它是**只读常量**：本文件所有更新函数都返回新对象，绝不原地改它。
 *   `filter.persons.push(x)` 这种写法会让「重置」失效（常量已经被改脏）。
 */
export const EMPTY_FILTER: FeedFilter = { persons: [], domains: [], range: 'all' }

/** 时间档位选项（面板渲染与文案的唯一来源，避免页面与用例各写一份） */
export const RANGE_OPTIONS: Array<{ value: FeedRange; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '近 7 天' },
  { value: 'month', label: '近 30 天' }
]

/** 档位 → 中文标签（不认识的值回落「全部时间」，不抛错） */
export function rangeLabel(range: FeedRange): string {
  return RANGE_OPTIONS.find((o) => o.value === range)?.label ?? '全部时间'
}

function isRange(value: unknown): value is FeedRange {
  return value === 'all' || value === 'today' || value === 'week' || value === 'month'
}

/** 容错归一：外部（本地缓存 / 路由参数）传进来的残缺对象一律收敛成合法筛选条件 */
export function normalizeFilter(input?: Partial<FeedFilter> | null): FeedFilter {
  const raw = input ?? {}
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string' && v !== '') : []
  return {
    persons: strings(raw.persons),
    domains: strings(raw.domains),
    range: isRange(raw.range) ? raw.range : 'all'
  }
}

/** 多选切换（纯函数：返回新数组，不改入参） */
export function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** 是否有任何条件生效 */
export function isFilterActive(filter: FeedFilter): boolean {
  return filter.persons.length > 0 || filter.domains.length > 0 || filter.range !== 'all'
}

/** 生效条件**个数**（筛选按钮上的角标；时间档算一个，与 chips 数量一致） */
export function filterCount(filter: FeedFilter): number {
  return filter.persons.length + filter.domains.length + (filter.range === 'all' ? 0 : 1)
}

/* ------------------------------ 时间口径 ------------------------------ */

/**
 * 距今几个**日历日**（UTC+8，与 dayKey8 同一日期段）；不可解析返回 null。
 *
 * 为什么按日历日而不是 24 小时差：用户说「今天」指的是日历日。一条昨晚 23:50 发布的动态，
 * 在今天 08:00 看仍是「今天」（差 8 小时），在 24 小时差的口径下却会被算成「近 7 天」里的
 * 另一档 —— 与页面上的日期标签自相矛盾。
 *
 * 返回 null 而不是 0：0 表示「今天」，把一条读不出日期的旧闻当成今天发布是编造。
 */
export function ageDays(date: string | undefined, now: number | Date = Date.now()): number | null {
  const key = dayKey8(String(date ?? ''))
  if (!key) return null
  const today = dayKey8(now)
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${key}T00:00:00Z`)) / 86400000)
}

/** 各档位的天数上界（不含） */
const RANGE_DAYS: Record<Exclude<FeedRange, 'all'>, number> = { today: 1, week: 7, month: 30 }

/**
 * 条目是否落在时间档位内。
 *
 * 两条边界：
 *   · **读不出日期 → 不算通过**（不猜）。被挡掉多少条由 `hiddenByRange` 如实报出，
 *     页面会写明「另有 N 条缺少日期」，而不是让它们无声消失。
 *   · **未来的时间（age < 0）→ 算通过**：上游偶尔给错年份，若因此被「近 7 天」筛掉，
 *     用户看到的是内容凭空少了，而我们没有任何解释。
 */
export function inRange(e: FeedEntry, range: FeedRange, now: number | Date = Date.now()): boolean {
  if (range === 'all') return true
  const age = ageDays(e.publishedDate, now)
  if (age === null) return false
  if (age < 0) return true
  return age < RANGE_DAYS[range]
}

/* ------------------------------ 过滤 ------------------------------ */

/**
 * 关键词匹配（标题 / 摘要 / 人名三处，忽略大小写）。
 *
 * 只碰这三处：它们都是**能在原文里逐字核对**的东西。若把 AI 生成的判断类文案也纳入搜索，
 * 用户会搜到一条「说某人有争议」的动态，却找不到原文依据 —— 本页不做这种事。
 */
export function matchQuery(e: FeedEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return `${e.title} ${e.content} ${e.personName}`.toLowerCase().includes(q)
}

/** 与「人物 / 领域 / 关键词」相符（**不含**时间档），时间档是唯一会把内容挡掉的筛子 */
function matchBase(e: FeedEntry, filter: FeedFilter, query: string): boolean {
  if (filter.persons.length > 0 && !filter.persons.includes(e.personKey)) return false
  if (filter.domains.length > 0 && !filter.domains.includes(e.domain)) return false
  return matchQuery(e, query)
}

/** 叠加全部条件（人物 ∧ 领域 ∧ 时间 ∧ 关键词），顺序即上面括注的顺序 */
export function applyFeedFilter(
  entries: FeedEntry[] | null | undefined,
  filter: FeedFilter,
  query: string,
  now: number | Date = Date.now()
): FeedEntry[] {
  const list = Array.isArray(entries) ? entries : []
  return list.filter((e) => matchBase(e, filter, query) && inRange(e, filter.range, now))
}

/**
 * 被时间档挡在门外、其余条件都相符的条目数（**都是读不出日期的那些**）。
 *
 * 页面拿它写一句「另有 N 条动态缺少发布日期，未计入「近 7 天」」——
 * 没有这句，用户只会觉得「我的动态怎么少了」。
 */
export function hiddenByRange(
  entries: FeedEntry[] | null | undefined,
  filter: FeedFilter,
  query: string,
  now: number | Date = Date.now()
): number {
  if (filter.range === 'all') return 0
  const list = Array.isArray(entries) ? entries : []
  return list.filter((e) => matchBase(e, filter, query) && ageDays(e.publishedDate, now) === null).length
}

/* ------------------------------ 去重与排序 ------------------------------ */

/** 按发布时间倒序；读不出日期的排最后（0 作时间戳，比任何真实时间都小） */
export function sortFeedByDate(a: FeedEntry, b: FeedEntry): number {
  const ta = a.publishedDate ? Date.parse(a.publishedDate) : 0
  const tb = b.publishedDate ? Date.parse(b.publishedDate) : 0
  return tb - ta
}

/**
 * 标题归一化：抹掉空白与常见分隔标点、转小写，用来判「是不是同一件事」。
 * 归一化后为空（原标题就是这个）时，调用方会跳过该条的去重 —— 见 dedupeFeedItems。
 */
function titleKey(title: string): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s·|｜\/\\\-—–_~:：,，。.、"'“”‘’()（）[\]【】!！?？+*#@]/g, '')
}

/** 去重结果：`merged` 是被合并掉的条数（页面要如实说出来，不能静默少几条） */
export interface DedupeResult {
  items: FeedEntry[]
  merged: number
}

/**
 * 同一人的**同一件事**只留一条（保留先出现的那条，调用方已按时间倒序 → 即最新的那条）。
 *
 * 为什么必须做：检索源对同一事件常有十多条转载（标题几乎一致、域名不同），
 * 关注一位名人的 10 条动态里可能有 6 条在说同一件事，列表看起来就是「刷屏」。
 *
 * 两条边界：
 *   · **标题为空 → 不去重**（无从判断是不是同一件事，宁可留两条也不合并掉一条真内容）；
 *   · 只按「同一人 + 同标题」判，跨人不合并 —— 两个人对同一事件的表态是两条信息，不是重复。
 */
export function dedupeFeedItems(entries: FeedEntry[] | null | undefined): DedupeResult {
  const list = Array.isArray(entries) ? entries : []
  const seen = new Set<string>()
  const items: FeedEntry[] = []
  let merged = 0
  for (const e of list) {
    const key = titleKey(e.title)
    if (key === '') {
      items.push(e)
      continue
    }
    const id = `${e.personKey}|${key}`
    if (seen.has(id)) {
      merged++
      continue
    }
    seen.add(id)
    items.push(e)
  }
  return { items, merged }
}

/* ------------------------------ 时间分组 ------------------------------ */

/** 时间分组：`items` 与入参同序（不重排），只做桶划分 */
export interface FeedGroup {
  key: 'today' | 'yesterday' | 'week' | 'older' | 'unknown'
  label: string
  items: FeedEntry[]
}

/**
 * 按「今天 / 昨天 / 近 7 天 / 更早 / 时间未知」分组，**空组不返回**。
 *
 * 为什么分组头值得占这个位置：动态流是不同人、不同来源混在一条时间线上的，
 * 没有分组时用户只能逐条去读右侧的日期胶囊才知道「哪些是新的」。
 * 分组头把「有没有新东西」提到了扫一眼就能回答的层级。
 */
export function groupFeedByDay(entries: FeedEntry[] | null | undefined, now: number | Date = Date.now()): FeedGroup[] {
  const list = Array.isArray(entries) ? entries : []
  const today: FeedEntry[] = []
  const yesterday: FeedEntry[] = []
  const week: FeedEntry[] = []
  const older: FeedEntry[] = []
  const unknown: FeedEntry[] = []

  for (const e of list) {
    const age = ageDays(e.publishedDate, now)
    if (age === null || age < 0) unknown.push(e)
    else if (age === 0) today.push(e)
    else if (age === 1) yesterday.push(e)
    else if (age < 7) week.push(e)
    else older.push(e)
  }

  const groups: FeedGroup[] = [
    { key: 'today', label: '今天', items: today },
    { key: 'yesterday', label: '昨天', items: yesterday },
    { key: 'week', label: '近 7 天', items: week },
    { key: 'older', label: '更早', items: older },
    { key: 'unknown', label: '时间未知', items: unknown }
  ]
  return groups.filter((g) => g.items.length > 0)
}

/* ------------------------------ 生效条件回显 ------------------------------ */

/**
 * 生效条件的最小描述（**不含中文标签**）。
 *
 * 标签由页面按当前上下文翻译（人物名要在 follows 里查、领域要用 domainLabel 翻），
 * 本模块因此不依赖任何配置表 —— 它只回答「现在生效了哪几项、按什么顺序排」。
 * 顺序 = 时间 → 领域 → 人物：与筛选面板里三组的排列一致，chips 行看起来才像面板的投影。
 */
export interface FilterChip {
  kind: 'range' | 'domain' | 'person'
  value: string
}

/** 生效条件（按 时间 → 领域 → 人物 排列），无条件时返回空数组 */
export function activeFilterChips(filter: FeedFilter): FilterChip[] {
  const chips: FilterChip[] = []
  if (filter.range !== 'all') chips.push({ kind: 'range', value: filter.range })
  for (const d of filter.domains) chips.push({ kind: 'domain', value: d })
  for (const p of filter.persons) chips.push({ kind: 'person', value: p })
  return chips
}

/** 单独摘掉一个 chip（chips 行上每个条件右边的 ×） */
export function removeChip(filter: FeedFilter, chip: FilterChip): FeedFilter {
  if (chip.kind === 'range') return { ...filter, range: 'all' }
  if (chip.kind === 'domain') return { ...filter, domains: filter.domains.filter((d) => d !== chip.value) }
  return { ...filter, persons: filter.persons.filter((p) => p !== chip.value) }
}

/* ------------------------------ 无结果时给出口 ------------------------------ */

/**
 * 筛到一条不剩时的**出路建议**：算出「松开哪一项能多看多少条」，挑收益最大的一条说出来。
 *
 * 为什么要算而不是写一句「试试别的条件」：本页的筛选是四层叠加的，用户点了几下之后
 * 往往已经忘了自己设过什么（时间档尤其容易忘）。直接告诉他「去掉「近 7 天」可多看 12 条」，
 * 他下一步点哪里就是明确的。
 *
 * 返回空串 = 不该给建议（本来就有结果，或数据源本来就是空的）。
 */
export function loosenHint(
  entries: FeedEntry[] | null | undefined,
  filter: FeedFilter,
  query: string,
  now: number | Date = Date.now()
): string {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return ''
  const countOf = (f: FeedFilter, q: string): number => applyFeedFilter(list, f, q, now).length
  if (countOf(filter, query) > 0) return ''

  const options: Array<{ label: string; count: number }> = []
  if (filter.range !== 'all') {
    options.push({ label: `去掉「${rangeLabel(filter.range)}」`, count: countOf({ ...filter, range: 'all' }, query) })
  }
  if (filter.domains.length > 0) {
    options.push({ label: '去掉领域筛选', count: countOf({ ...filter, domains: [] }, query) })
  }
  if (filter.persons.length > 0) {
    options.push({ label: '切回「全部人物」', count: countOf({ ...filter, persons: [] }, query) })
  }
  if (query.trim() !== '') {
    options.push({ label: '清空搜索词', count: countOf(filter, '') })
  }

  const best = options.filter((o) => o.count > 0).sort((a, b) => b.count - a.count)[0]
  if (!best) return '换个条件再试试'
  return `${best.label}可多看 ${best.count} 条`
}
