import { RISK_CATEGORY_LABEL } from './risk'
import type { RiskCategory } from './risk'

/**
 * 舆情判断层（P1，2026-10-13）——把舆情页三块概要（关注动态 / 本周周报 / 关键词预警）
 * 合成**一条统一队列**，并给每条补上「影响面 / 可信度 / 是否需回应」三类判断，
 * 再从中挑出「今日需要注意的 N 件事」。
 *
 * 为什么单独成文件、且必须是纯函数：
 *   判断规则（分级 / 排序 / 去重）要能被单测逐条钉住，页面只管取数与渲染。这里不碰任何
 *   网络 / storage / 云函数，输入输出都是普通对象；**遇到脏数据一律跳过该条，绝不抛错**
 *   —— 页面在数据缺失时也不能白屏。
 *
 * 合规红线（改本文件前先读，与产品硬要求同等重要）：
 *   1. **涉政涉军仍是拒答**：本层只对**已经过上游过滤**（报告生成时拒答、云端 contentCheck、
 *      端上 sensitive.ts 拦截）的存量条目做重排与打标，**不新增任何内容来源、不放开任何拦截**。
 *   2. **每条必须可追溯到来源与时间**：无来源的条目一律不进「今日要点」；来源缺失时显式写
 *      「来源未标注」，**绝不编一个来源**。
 *   3. **区分「报道 / 传闻」与「已确认的定论」**：可信度最高一级也只到「官方通报」
 *      （指来源是官方渠道的公开通报），**刻意不使用「已确认」**这种会被读成「平台已核实事实」
 *      的措辞；凡涉及事实一律按「报道」表述（见页面免责说明）。
 *   4. **算不出就说算不出**：现有字段不足以判断时，一律标「未评级 / 未知」，不给倾向性猜测
 *      （与 utils/risk.ts 的三条边界同一取舍）。
 */

/** 三块的来源标识（决定点击跳哪个完整页） */
export type OpinionBlock = 'feed' | 'weekly' | 'alert'

/**
 * 影响面。**只认信号里已有的级别字段**（RiskSignalRow.level，云端由「命中的是哪一类词」
 * 决定），没有该字段的条目一律 未评级 —— 不拿标题去猜严重性（那正是 risk.ts 边界 1 禁止的）。
 */
export type ImpactLevel = 'high' | 'mid' | 'low' | 'unknown'

export const IMPACT_LABEL: Record<ImpactLevel, string> = {
  high: '影响面高',
  mid: '影响面中',
  low: '影响面低',
  unknown: '影响面未评级'
}

/**
 * 可信度。依据**来源数量与来源类型**推导（规则见 credibilityOf）。最高一级是「官方通报」
 * 而非「已确认」，理由见文件头红线 3。
 */
export type CredTier = 'official' | 'multi' | 'single' | 'unknown'

export const CRED_LABEL: Record<CredTier, string> = {
  official: '官方通报',
  multi: '多方报道',
  single: '单一来源',
  unknown: '可信度未知'
}

/** 是否需回应（规则见 responseOf） */
export type ResponseNeed = 'respond' | 'watch' | 'none' | 'unknown'

export const RESPONSE_LABEL: Record<ResponseNeed, string> = {
  respond: '建议回应',
  watch: '建议关注',
  none: '无需回应',
  unknown: '是否需回应未知'
}

/**
 * 条目时间的口径（2026-10-16 新增）。
 *
 *   · 'published' —— 上游给的**媒体发布时间**（时间线要答的「谁在何时说的」，这个「何时」就该是它）；
 *   · 'seen'      —— **我们第一次扫到它的时刻**（`risk_signals` 的老行 / 上游没给发布时间时只能退回它）。
 *
 * 两处都真实且都该保留（判新旧必须用 `first_seen_at`：上游的「发布时间」可能是 3 天前甚至抓取时间），
 * 但**混进同一条时间线时必须让人读得出来** —— 否则「我们 10-16 扫到一条 10-10 的旧报道」会被读成
 * 「10-16 又有新进展」。故本字段只影响时间线的措辞（'seen' 写成「发现于」），
 * **不参与任何排序 / 去重 / 判定**；缺失（老数据、绝大多数来源）一律按发布时间看待。
 */
export type TimeBasis = 'published' | 'seen'

/**
 * 一条原始舆情（三块数据摊平后的公共形状）。
 *
 * 字段**全部可选**是刻意的：三块的存量数据各有缺失（feed 没有 url、预警条目可能没有日期、
 * 风险信号才带 category/level），把它声明成必填只会逼调用方去 `!` 断言，反而把「数据不足」
 * 藏起来。凡是缺的字段，判定层会显式回落到「未评级 / 未知」。
 */
export interface OpinionRawEntry {
  block?: OpinionBlock
  title?: string
  summary?: string
  /** 来源：媒体名 / 站点名；缺失时判定层按「无来源」处理 */
  source?: string
  /** 时间串（允许任意可被 Date.parse 解析的形态）；缺失时排序垫底 */
  date?: string
  /** 这条归属于哪个「我盯的人」（feed / weekly，或风险信号的名人） */
  person?: string
  /** 这条归属于哪个「我监控的词」（alert） */
  keyword?: string
  /**
   * 归属名人的稳定键（`名字#领域码`）。只有 feed 来源能可靠给出（`listFollows` 的 `person_key`），
   * 供「今日要点」里 feed 条目**精准跳转**到对应名人主页（`pages/profile`）用；其余来源没有该字段。
   */
  personKey?: string
  /** 风险信号自带类别；其余来源没有 */
  category?: RiskCategory
  /** 风险信号自带级别；其余来源没有 */
  level?: string
  /**
   * 这条的 `date` 属于哪种口径（见 TimeBasis）：只影响时间线的措辞（'seen' → 「发现于」），
   * 不参与排序 / 去重 / 判定；缺失（老数据、绝大多数来源）按媒体发布时间看待。
   */
  timeBasis?: TimeBasis
}

/** 判定层的输入：三块条目 + 我盯的词 / 人（用于「与我相关」排序） */
export interface OpinionInput {
  feed?: OpinionRawEntry[]
  weekly?: OpinionRawEntry[]
  alerts?: OpinionRawEntry[]
  /** 我监控中的关键词原文 */
  keywords?: string[]
  /**
   * 我主动盯上的人名：**关注的人 ∪ 风险监控的人**。
   *
   * 为什么把两者合并：需求里「与我相关」的第二档是「命中用户关注的人」，而本产品里
   * 「关注」与「监控风险」是两处入口、两套数据，但都是用户主动指定的对象。只认 follows
   * 会让「监控中的名人的风险信号」因为没有同时关注而掉到「其余」，与直觉相反。
   */
  watchNames?: string[]
}

/** 一条判定后的舆情（统一队列的元素） */
export interface OpinionEntry {
  id: string
  block: OpinionBlock
  title: string
  summary: string
  source: string
  date: string
  /** 展示用归属：人名或关键词（都缺时为空串） */
  label: string
  /** 本质归属的监控词（alert 里 keyword 归属才有；其余为空串）——用于「命中监控词」文案，与跳转身份一致 */
  keyword?: string
  /** 归属名人的稳定键（feed 来源才有；其余为空串）——今日要点精准跳转用 */
  personKey?: string
  impact: ImpactLevel
  credibility: CredTier
  response: ResponseNeed
  hitsKeyword: boolean
  hitsFollow: boolean
  category?: RiskCategory
  /** 归一后的级别（非法值一律 undefined） */
  level?: ImpactLevel
  /** 时间的口径（见 TimeBasis）；缺失表示按媒体发布时间看待 */
  timeBasis?: TimeBasis
  /** 同一事件合并进来的**去重来源数**（用于可信度展示） */
  sourceCount: number
  /** 为什么值得注意（今日要点用；为空串表示没有可说清的「值得注意」理由） */
  reason: string
}

/* ─────────────────────────── 基础工具 ─────────────────────────── */

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function normLevel(v: unknown): Exclude<ImpactLevel, 'unknown'> | undefined {
  return v === 'high' || v === 'mid' || v === 'low' ? v : undefined
}

function asRiskCategory(v: unknown): RiskCategory | undefined {
  return v === 'judicial' || v === 'tax' || v === 'contract' || v === 'rights' || v === 'statement'
    ? v
    : undefined
}

/** 去重且去掉空串的字符串列表（keys 为空/非法时返回 []，绝不抛错） */
function normList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    const s = asText(x)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/* ─────────────────────────── 三类判断 ─────────────────────────── */

/**
 * 影响面：只认已有的级别字段（high/mid/low），其余一律 未评级。
 * 不接受任何「按标题推断」的输入 —— 见文件头红线 4。
 */
export function impactOf(level: unknown): ImpactLevel {
  return normLevel(level) ?? 'unknown'
}

/**
 * 官方来源判定：**只看来源名里是否含官方标识词**。
 *
 * 这是一个**启发式**（不是对内容真实性的核实）：命中只代表「发布渠道像官方」，
 * 记最高一级可信度（官方通报），仍不等于平台核实过事实。
 */
const OFFICIAL_MARKERS: ReadonlyArray<string> = [
  '官方',
  '通报',
  '公安',
  '警方',
  '法院',
  '检察院',
  '市场监管',
  '税务',
  '海关',
  '网信',
  '证监会',
  '新闻办',
  '人民政府',
  '政府',
  '管理局',
  '卫健委',
  '纪委',
  '监察'
]

export function isOfficialSource(source: string): boolean {
  const s = asText(source)
  return !!s && OFFICIAL_MARKERS.some((m) => s.includes(m))
}

/**
 * 可信度推导规则（自上而下，命中即返回）：
 *   1. 没有任何来源         → 未知（无来源的条目，无法追溯，不进今日要点）；
 *   2. 含官方来源           → 官方通报；
 *   3. 去重来源数 ≥ 2        → 多方报道；
 *   4. 只有 1 个来源         → 单一来源。
 * 来源数取的是**同一事件合并后的去重来源**（见 buildOpinionQueue 的去重分组）。
 */
export function credibilityOf(sources: unknown[]): CredTier {
  const uniq = [...new Set((Array.isArray(sources) ? sources : []).map(asText).filter(Boolean))]
  if (uniq.length === 0) return 'unknown'
  if (uniq.some(isOfficialSource)) return 'official'
  return uniq.length >= 2 ? 'multi' : 'single'
}

/**
 * 是否需回应（自上而下，命中即返回）：
 *   1. 级别 high                  → 建议回应；
 *   2. 类别为 rights/statement    → 建议关注（名誉维权 / 回应表态这两类值得盯一眼）；
 *   3. 有类别或级别（其余情况）   → 无需回应；
 *   4. 两者都没有                 → 未知（数据不足，不猜）。
 */
export function responseOf(category: unknown, level: unknown): ResponseNeed {
  const lv = normLevel(level)
  const cat = asRiskCategory(category)
  if (lv === 'high') return 'respond'
  if (cat === 'rights' || cat === 'statement') return 'watch'
  if (cat || lv) return 'none'
  return 'unknown'
}

/* ─────────────────────────── 同事件去重 ─────────────────────────── */

/** 标题归一：去掉空白与标点，只留中日韩/字母/数字并转小写，用于去重比较 */
export function normalizeTitle(title: string): string {
  return asText(title)
    .replace(/[^\u3400-\u9fffa-zA-Z0-9]/g, '')
    .toLowerCase()
}

/** 互相包含判同事件的**最短**长度门槛：太短的标题（如「声明」）不能靠包含关系合并 */
export const DUP_MIN_CHARS = 8
/** 公共前缀判同事件的长度门槛 */
export const DUP_PREFIX_CHARS = 12

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * 同事件判定（去重用）：归一后满足其一即算同一条
 *   · 完全相同；或
 *   · 互相包含且**短的那个 ≥ DUP_MIN_CHARS**（覆盖「【重磅】关于X的声明」与「关于X的声明」）；或
 *   · 公共前缀 ≥ DUP_PREFIX_CHARS（覆盖「X事件最新进展：…」与「X事件最新进展」）。
 *
 * 刻意保守：**宁可少合并**（顶多多显示一条相似项），也不把两件不同的事并成一条
 * —— 并错会直接丢信息，且用户无从察觉（与 risk.ts「宁可漏报，不可误报」同一取舍）。
 */
export function sameEvent(a: string, b: string): boolean {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const min = Math.min(na.length, nb.length)
  if (min >= DUP_MIN_CHARS && (na.includes(nb) || nb.includes(na))) return true
  return commonPrefixLen(na, nb) >= DUP_PREFIX_CHARS
}

/* ─────────────────────────── 统一排序 ─────────────────────────── */

/** 影响面排序权重：高 > 中 > 低 > 未评级 */
const IMPACT_RANK: Record<ImpactLevel, number> = { high: 3, mid: 2, low: 1, unknown: 0 }
/** 需回应排序权重：建议回应 > 建议关注 > 其余（无需回应 / 未知同为 0，不靠猜抬高） */
const RESPONSE_RANK: Record<ResponseNeed, number> = { respond: 2, watch: 1, none: 0, unknown: 0 }

interface Ordered {
  e: OpinionEntry
  ord: number
}

function dateMs(date: string): number {
  const t = Date.parse(date)
  return Number.isFinite(t) ? t : 0
}

/**
 * 排序口径（**P1 统一队列与 P3 事件聚合共用同一份实现**，避免两处各写一套而漂移）。
 *
 * 只比较四档（不含「原始顺序」兜底那一档，那由调用方补）：
 *   1. 命中监控的关键词(2) > 命中关注/监控的人(1) > 其余(0)；
 *   2. 影响面高者优先（高>中>低>未评级）；
 *   3. 需回应者优先（建议回应>建议关注>其余）；
 *   4. 时间新者优先（不可解析的时间按最旧算，垫底）。
 *
 * 输入刻意收窄成「能排序的最小字段集」：`OpinionEntry` 与 `OpinionEvent` 都天然满足它，
 * 于是事件聚合可以对事件直接排序，不必再抄一遍权重表。
 */
export interface OpinionOrderKey {
  hitsKeyword?: boolean
  hitsFollow?: boolean
  impact: ImpactLevel
  response: ResponseNeed
  date: string
}

export function compareOpinionOrder(a: OpinionOrderKey, b: OpinionOrderKey): number {
  const ta = a.hitsKeyword ? 2 : a.hitsFollow ? 1 : 0
  const tb = b.hitsKeyword ? 2 : b.hitsFollow ? 1 : 0
  if (tb !== ta) return tb - ta
  const l = IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact]
  if (l !== 0) return l
  const r = RESPONSE_RANK[b.response] - RESPONSE_RANK[a.response]
  if (r !== 0) return r
  return dateMs(b.date) - dateMs(a.date)
}

/** 在 compareOpinionOrder 之上补「原始顺序」兜底：全相等时保持入参先后（稳定，不因同分抖动） */
function compareOrdered(a: Ordered, b: Ordered): number {
  const c = compareOpinionOrder(a.e, b.e)
  return c !== 0 ? c : a.ord - b.ord
}

/* ─────────────────────────── 组装 ─────────────────────────── */

function toEntry(raw: unknown, block: OpinionBlock, keywords: string[], watchNames: string[]): OpinionEntry | null {
  /* 脏数据（null / 字符串 / 数字 / 数组）一律跳过该条，不抛错 —— 页面在缺数据时也不能白屏 */
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  const title = asText(r.title)
  if (!title) return null /* 没有标题 = 无意义条目，跳过 */

  const summary = asText(r.summary)
  const source = asText(r.source)
  const date = asText(r.date)
  const person = asText(r.person)
  const keyword = asText(r.keyword)
  const personKey = asText(r.personKey)
  const category = asRiskCategory(r.category)
  const level = normLevel(r.level)
  /* 时间口径：只认两个合法值，其余（含缺失）一律 undefined = 按媒体发布时间看待 */
  const timeBasis: TimeBasis | undefined =
    r.timeBasis === 'published' || r.timeBasis === 'seen' ? (r.timeBasis as TimeBasis) : undefined

  /* 「与我相关」判定：归属字段直接判定 + 标题/摘要正文里出现我盯的词 / 人名。
     关键词命中优先于关注命中（见排序权重）。 */
  const hay = `${title} ${summary}`.toLowerCase()
  const hitsKeyword = !!keyword || keywords.some((k) => k && hay.includes(k.toLowerCase()))
  const hitsFollow = (!!person && watchNames.includes(person)) || watchNames.some((n) => n && hay.includes(n.toLowerCase()))

  const entry: OpinionEntry = {
    id: '',
    block,
    title,
    summary,
    source,
    date,
    label: person || keyword,
    keyword,
    personKey,
    impact: impactOf(level),
    credibility: credibilityOf([source]),
    response: responseOf(category, level),
    hitsKeyword,
    hitsFollow,
    category,
    level,
    sourceCount: source ? 1 : 0,
    reason: ''
  }
  /* 只在确有口径时才加键（时间线要写「发现于」才需要它）；避免给所有条目凭空多一个
     undefined 字段 —— 既让 deepEq 类断言变脆，也把「缺失」与「明确是发布时间」混为一谈 */
  if (timeBasis) entry.timeBasis = timeBasis
  return entry
}

function reasonOf(e: OpinionEntry): string {
  /*
   * 「为什么值得注意」的文案要跟**点击去向**一致，故只认条目的**本质归属**，不认 `hitsKeyword`
   * （后者含「标题/摘要正文恰好出现监控词」的松散命中，见 toEntry）。
   *
   * 反例（2026-10-14 修）：一条海来阿木的 feed 动态，标题里碰巧出现你监控的词「霍尔木兹海峡」，
   * `hitsKeyword` 会为真；若据此写「命中你的监控词」，而点击却按 feed 的 personKey 跳海来阿木主页，
   * 就出现「命中监控词却跳名人主页」的文不对题。改成按本质归属：只有真正的关键词预警（alert 且带
   * keyword）才说「命中你的监控词」；feed 动态一律是「来自你关注/监控的名人」，与跳转一致。
   */
  if (e.keyword) return '命中你的监控词'
  if (e.category) return `命中「${RISK_CATEGORY_LABEL[e.category]}」类风险词`
  if (e.hitsFollow) return '来自你关注/监控的名人'
  return ''
}

/**
 * 摊平三块条目 → 逐条生成判断信息（脏数据跳过），并记录入参序号用于稳定排序。
 * 三块的收集顺序固定为 feed → weekly → alert（与既有排序的兜底口径一致）。
 */
function collectOrdered(input: OpinionInput): Ordered[] {
  const keywords = normList(input.keywords)
  const watchNames = normList(input.watchNames)

  const ordered: Ordered[] = []
  let ord = 0
  const collect = (arr: unknown, block: OpinionBlock) => {
    if (!Array.isArray(arr)) return
    for (const item of arr) {
      const e = toEntry(item, block, keywords, watchNames)
      if (e) ordered.push({ e, ord: ord++ })
    }
  }
  collect(input.feed, 'feed')
  collect(input.weekly, 'weekly')
  collect(input.alerts, 'alert')
  return ordered
}

/** 同事件分组内部结构：组内成员 + 排序代表 + 整组去重来源 */
interface OrderedGroup {
  rows: Ordered[]
  representative: Ordered
  sources: string[]
}

/**
 * 按 `sameEvent` 去重分组，并算出每组的**排序代表**（组内按 compareOrdered 最靠前的那条）与
 * 整组去重来源。可信度用整组来源重算 —— 同事件的多个来源才算「多方报道」。
 *
 * ⚠ 这是 P1 去重与 P3 事件聚合的**唯一分组实现**：两处必须走同一条判据、同一套代表选取，
 *   否则会出现「排序认为是一条、时间线却分成两条」的漂移。
 */
function groupOrdered(ordered: Ordered[]): OrderedGroup[] {
  const groups: Ordered[][] = []
  for (const row of ordered) {
    const g = groups.find((grp) => sameEvent(grp[0].e.title, row.e.title))
    if (g) g.push(row)
    else groups.push([row])
  }

  return groups.map((g) => {
    let best = g[0]
    for (const row of g) if (compareOrdered(row, best) < 0) best = row

    const sources = g.map((m) => m.e.source).filter(Boolean)
    const uniq = [...new Set(sources)]
    const filedSource = best.e.source || sources[0] || ''
    const representative: Ordered = {
      e: {
        ...best.e,
        source: filedSource,
        credibility: credibilityOf(g.map((m) => m.e.source)),
        sourceCount: uniq.length
      },
      ord: best.ord
    }
    return { rows: g, representative, sources: uniq }
  })
}

/** 一个「同一事件」分组（P3 事件聚合的输入；成员保留各自来源 / 时间 / 判断） */
export interface OpinionGroup {
  /** 组内成员条目（含无来源者；组内顺序 = 入参顺序） */
  members: OpinionEntry[]
  /** 整组去重来源 */
  sources: string[]
  /** 排序代表：P1 去重后保留的那条（点击跳转 / 今日要点所用的块以它为准） */
  representative: OpinionEntry
}

/**
 * 分出「同一事件」的多来源分组（纯函数，脏数据跳过）。
 *
 * 这是 P1 去重内部那一步的**对外投影**：`buildOpinionQueue` 直接取每组的代表，
 * 而 P3 的事件聚合需要组内**全部成员**去拼时间线，两者共用同一分组，判据不会漂移。
 * 返回顺序 = 各组首次出现的顺序（未排序），由调用方决定怎么排。
 */
export function buildOpinionGroups(input: OpinionInput = {}): OpinionGroup[] {
  return groupOrdered(collectOrdered(input)).map((g) => ({
    members: g.rows.map((r) => r.e),
    sources: g.sources,
    representative: g.representative.e
  }))
}

/**
 * 合成统一队列（纯函数）：
 *   1. 三块条目摊平 → 逐条生成判断信息（脏数据跳过）；
 *   2. 按 sameEvent 去重分组，组内保留**排序最靠前**的那条为代表；
 *   3. 可信度用**整组的去重来源**算（同事件的多个来源才算「多方报道」）；
 *   4. 全队列按 compareOrdered 排序，编号并生成「为什么值得注意」。
 */
export function buildOpinionQueue(input: OpinionInput = {}): OpinionEntry[] {
  const reps = groupOrdered(collectOrdered(input)).map((g) => g.representative)
  reps.sort(compareOrdered)
  return reps.map((r, i) => ({ ...r.e, id: `${r.e.block}#${i}`, reason: reasonOf(r.e) }))
}

/** 今日要点最多几条 */
export const DAILY_FOCUS_MAX = 3

/**
 * 今日要点：从排序好的队列里取前 N（默认 3）条。硬门槛（宁缺毋滥，不凑数）：
 *   · **必须有来源** —— 无来源的条目不可追溯，一律不进（文件头红线 2）；
 *   · 必须「有真正需要你注意的依据」—— 命中监控词 / 命中风险类别 / 有风险级别，任一即可；
 *   · **刻意排除「仅命中关注的人」的普通动态** —— 这类动态已在「关注动态」卡呈现，再进
 *     今日要点只会与那张卡内容重合、且点了都跳 pages/feed，纯属重复。
 */
export function pickDailyFocus(queue: OpinionEntry[], limit: number = DAILY_FOCUS_MAX): OpinionEntry[] {
  if (!Array.isArray(queue) || limit <= 0) return []
  const out: OpinionEntry[] = []
  for (const e of queue) {
    if (!e || !e.source) continue
    if (!e.hitsKeyword && !e.category && e.impact === 'unknown') continue
    out.push(e)
    if (out.length >= limit) break
  }
  return out
}
