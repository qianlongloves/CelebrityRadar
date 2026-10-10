import dayjs from 'dayjs'
import { parseDay } from './date'
import type { Report } from './report'

/**
 * 名人主页「数据 Tab」（M2-4，V2）—— 纯端上聚合。
 *
 * 与词云（M4-5）/ 热度趋势（M4-6）/ 两人对比（M4-7）同一个取舍：这一屏要的是
 * 「把报告里已经落库的条目摊成可比的数字与分布」，不需要语义推理 —— 因此
 * 不新增 Schema 字段、不新增云函数、不消耗生成额度，**存量缓存立即生效**。
 *
 * 两条贯彻始终的规矩：
 *   1. 不做推断。所有数字都能在报告的「近期动态 / 语录 / 时间线」里逐条对上；
 *      算不出来的一律给 null，卡整块不出 —— 显示 0 或「暂无数据」是骗人。
 *   2. 老报告不歧视。2026-10-07 之前落库的报告没有 coverage 字段，曝光度卡
 *      退化为只显示热度 + 一句说明，而不是整页空白。
 *
 * 与报告页的分工：报告页的「热度趋势」「立场与舆情」是分析语境的读法，
 * 这里是同一批原始事实的集中面板；口径完全一致（同一份 dynamics / timeline，
 * 同一套情绪配色），不存在两处数字打架的可能。
 *
 * 这一屏的卡（按展示顺序）：曝光度 / 报道来源分布 / 来源×情绪 / 素材可信度 /
 * 情绪构成 / 情绪走势 / 时间分布。后四张里凡是要「交叉」的，都复用同一份来源归并
 * （mergeSources）与同一套分桶骨架（bucketize）—— 两处各算各的话，同一份报告会出现
 * 「来源家数对不上」「横轴月份对不上」这类最难解释的现象（同 utils/date.ts 的教训）。
 */

/** 来源条形最多几条，其余归并成「其他 N 家」 */
const SOURCE_TOP = 6
/** 可判定来源的条目少于这么多就不出分布卡：一两条连不成分布 */
const MIN_SOURCE_ITEMS = 3
/** 月度分布至少要有这么多条带日期的条目（与热度趋势 MIN_EVENTS = 3 同口径） */
const MIN_MONTH_EVENTS = 3
/** 逐日分布（周报）同一门槛：一两条连不成节奏 */
const MIN_DAY_EVENTS = 3
/** 月度窗口最多回看 12 个月 */
const MONTHS_WINDOW = 12
/**
 * 来源×情绪交叉里，一家来源至少要有这么多条才单列。
 *
 * 这是这张卡最要紧的门槛：**一条报道代表不了一家媒体的倾向**。若不设门槛，
 * 某家只被收录了 1 条的媒体会以「100% 负面」的姿态出现，读者据此得出的结论
 * 是错的 —— 而错的东西比没有更糟，故宁可不列（脚注如实说明有多少条未单列）。
 */
const MIN_TILT_PER_SOURCE = 2
/** 达到门槛的来源少于这么多家就不出交叉卡：只列一家没有对照可言 */
const MIN_TILT_FAMILIES = 2
/**
 * 情绪走势至少要有这么多个月的带日期条目。
 *
 * 与 MIN_MONTH_EVENTS 同口径取 3，但语义不同：这里要的是「跨月的变化」，
 * 故另外要求至少 2 个月有数据（见 buildSentimentTrend）—— 全落在一个月里
 * 只是一根柱子，看不出走势。
 */
const MIN_TREND_EVENTS = 3
/** 判定「同一事件」时比较的标题前缀长度（转载识别用） */
const TITLE_KEY_LEN = 12
/* 日期形态由 utils/date.ts 统一解析（与热度趋势同一套，见该文件的说明） */

/** 曝光度：热度公式的两个输入 + 素材的时间边界，全部来自可核对的事实 */
export interface ExposureStat {
  /** 热度（§1.6 公式，0~100） */
  heat: number
  /** 检索窗口内素材条数（= 热度公式的 N30）；老报告无 coverage 时为 null */
  items: number | null
  /** 其中近 7 天的条数（= N7）；老报告无 coverage 时为 null */
  recent: number | null
  /** 素材发布时间的最早 / 最新（归一为 YYYY-MM-DD）；无法解析时为 null */
  firstAt: string | null
  latestAt: string | null
  /** 报道画像是否可用（区分「没有数据」与「数据是 0」） */
  hasCoverage: boolean
}

export interface SourceSlice {
  name: string
  count: number
  /** count / peak，0~1，条形宽度 */
  ratio: number
}

/** 来源分布：dynamics 里逐条标注的媒体名统计，模型没给时回落 url 主机名 */
export interface SourceDistribution {
  items: SourceSlice[]
  /** 参与统计的条目数（来源可判定） */
  total: number
  /** 既无 source 又无可用主机名的条数，脚注里如实说明 */
  unknown: number
  /** 归并后的来源家数 */
  families: number
  /** Top N 之外的条数与家数 */
  others: number
  otherFamilies: number
}

export interface SentimentBreakdown {
  positive: number
  neutral: number
  negative: number
  total: number
}

/** 一家来源的情绪构成（来源×情绪交叉表的一行） */
export interface TiltSlice {
  name: string
  positive: number
  neutral: number
  negative: number
  total: number
  /**
   * 倾向净值 (positive - negative) / total，-1 ~ 1（负 = 偏负面）。
   *
   * 取名 tilt 而不是 stance：`dynamics[].sentiment` 标注的是**这一条报道的写法**，
   * 不是该媒体的编辑方针。UI 上必须按「倾向」措辞，不能写成「立场」——
   * 后者会读成「这家媒体就是反他的」，是个素材撑不住的结论。
   */
  tilt: number
}

/**
 * 来源 × 情绪：把「哪些来源在正面报道、哪些在质疑」摆出来。
 *
 * 与「报道来源分布」是同一批 dynamics 的两种切法，口径共用一个 mergeSources：
 * 前者看「谁在报」，后者看「怎么报」，两卡的家数必须一致。
 */
export interface SourceTilt {
  items: TiltSlice[]
  /** 可判定来源的条目数 */
  total: number
  /** 来源判不出的条目数（既无媒体名也无可用主机名），脚注里如实说明 */
  unknown: number
  /** 归并后的来源家数 */
  families: number
  /** 未单列的条目数（单家不足 MIN_TILT_PER_SOURCE 条，或排在 Top N 之外） */
  hidden: number
  /** 未单列的家数 */
  hiddenFamilies: number
}

/**
 * 素材可信度画像。
 *
 * 全部由端上数得出来（不依赖 coverage）：`.sources` 只给「谁在报」，
 * 这里回答的是「这些素材本身有多硬」—— 有几家独立信源、几件事、
 * 其中多少是同一件事被转来转去。读者据此判断整份报告的分量。
 */
export interface CredibilityProfile {
  /** 参与统计的条目数（= dynamics 条数） */
  total: number
  /** 可判定来源的条目数 */
  sourced: number
  /** 归并后的信源家数 */
  families: number
  /** 按标题归一后的独立事件数 */
  events: number
  /** 被 2 家及以上来源报道的事件数 */
  shared: number
  /** 重复报道的条目数 = total - events */
  repeated: number
  /** 重复率 repeated / total（0~1） */
  repeatRatio: number
  /** 首报：带日期条目里最早的一条（日期都不可解析时为 null，不猜） */
  first: { source: string; date: string; title: string } | null
}

/** 一个月的情绪构成（情绪走势的一根分层柱） */
export interface SentimentSlice {
  /** 月份 YYYY-MM */
  key: string
  /** 横轴刻度：月份数字 */
  label: number
  positive: number
  neutral: number
  negative: number
  total: number
  /** 柱高 = total / peak（0~1） */
  ratio: number
}

/**
 * 情绪走势：带日期的动态按月分层的情绪构成。
 *
 * 为什么不做「观点演化（把 stance 的话题对齐时间轴）」：`stance` 的字段是
 * topic / attitude / note，**没有日期**，硬要对齐只能拿话题名去正文里做字面匹配 ——
 * 那是推断，不是统计，与这一屏「每个数字都能逐条对上」的规矩冲突。
 * 换成按情绪分层之后，问的是同一件事（舆情随时间怎么变），但每个点都来自
 * dynamics 的 date 与 sentiment 两个已有字段，读者能逐条核对。
 */
export interface SentimentTrend {
  items: SentimentSlice[]
  /** 参与统计的带日期条目数（去重后） */
  total: number
  /** 单月最多条数（柱高基准） */
  peak: number
  /** 窗口起止（YYYY-MM） */
  from: string
  to: string
  /** 全窗口净倾向 (positive - negative) / total，-1 ~ 1 */
  tilt: number
}

/** 时间分桶的粒度：月（主页「时间分布」）/ 日（周报「近 7 天动态分布」） */
type BucketStep = 'month' | 'day'

/** 一条带日期的原始事实（动态 / 时间线 / 周报素材的通用形态） */
export interface DatedFact {
  /** 素材日期原文；不可解析即忽略（不猜） */
  date?: string
  /** 去重用的文本（同桶同一说法只计一次） */
  text?: string
  /** 情绪归类（只有「情绪走势」用它，其余分桶忽略）：取值同 dynamics[].sentiment */
  sentiment?: string
}

/** 一个时间桶（月 / 日同一套结构，只是刻度不同） */
export interface TimeSlice {
  /** 桶标识：月 = YYYY-MM，日 = YYYY-MM-DD */
  key: string
  /** 横轴刻度：月 = 月份数字（1~12），日 = 日数字（1~31） */
  label: number
  count: number
  /** count / peak，0~1，柱高 */
  ratio: number
}

/** 时间分布：把带日期的条目摊成一段连续的时间桶（月 / 日共用） */
export interface TimeDistribution {
  items: TimeSlice[]
  /** 参与聚合的条目数（去重后） */
  total: number
  peak: number
  /** 窗口起止（与 key 同格式） */
  from: string
  to: string
}

export interface ProfileStats {
  exposure: ExposureStat
  sources: SourceDistribution | null
  sentiment: SentimentBreakdown | null
  /** 近 12 个月的长周期节奏（与周报的逐日分布同一套结构，只是刻度不同） */
  months: TimeDistribution | null
  /** 来源×情绪交叉：谁在正面报道、谁在质疑（样本不足时为 null，整卡不出） */
  tilt: SourceTilt | null
  /** 素材可信度画像（可判定来源的条目不足时为 null） */
  credibility: CredibilityProfile | null
  /** 情绪走势：按月分层的情绪构成（跨月样本不足时为 null） */
  sentimentTrend: SentimentTrend | null
}

/** 博查 {url} 主机名（与 pages/report、pages/link-preview 的 hostOf 同款，各页私有） */
function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url || '')
  return m ? (m[1] ?? '').replace(/^www\./i, '') : ''
}

/** 素材时间原文 → YYYY-MM-DD；不可解析返回 null（不猜） */
function dayOf(v: string | null | undefined): string | null {
  if (!v) return null
  const d = dayjs(v)
  return d.isValid() ? d.format('YYYY-MM-DD') : null
}

function buildExposure(report: Report): ExposureStat {
  const c = report.coverage
  return {
    heat: report.heat,
    items: c ? c.items : null,
    recent: c ? c.recent : null,
    firstAt: c ? dayOf(c.firstAt) : null,
    latestAt: c ? dayOf(c.latestAt) : null,
    hasCoverage: !!c
  }
}

/** 条目来源名：模型标注的媒体名优先，缺失时回落 URL 主机名；都判不出返回空串 */
function sourceOf(d: { source?: string; url?: string }): string {
  return (d.source || '').trim() || hostOf(d.url || '')
}

/** 逐条动态的来源名（判不出的不进数组）；来源相关的几张卡共用这一趟收集 */
function collectSourceLabels(report: Report): string[] {
  const labels: string[] = []
  for (const d of report.dynamics) {
    const label = sourceOf(d)
    if (label) labels.push(label)
  }
  return labels
}

/**
 * 来源归并：互为子串的媒体名视为同一家 —— 模型从素材里抄站名，「新浪」与「新浪娱乐」
 * 会是两条，不合并时分布会碎成一地看不出主次（与 utils/compare.ts 的 sameTopic 同一思路）。
 *
 * 返回「原始写法 → 代表名」的完整映射（代表名取该组里出现最多的那个写法）。
 * 返回映射而不是合并后的计数，是因为来源×情绪也要用同一份归并 —— 它必须知道
 * **每条动态该并进哪一家**。两处各写一套的话，同一份报告会出现「来源分布说 5 家、
 * 交叉表说 6 家」这类对不上的数字。
 *
 * 实现按「高频优先占位」：先由出现最多的写法当代表，后续被它包含 / 包含它的写法并进来。
 */
function mergeSources(labels: string[]): Map<string, string> {
  const counts = new Map<string, number>()
  labels.forEach((l) => counts.set(l, (counts.get(l) ?? 0) + 1))

  const repOf = new Map<string, string>()
  const reps: string[] = []
  Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .forEach(([name]) => {
      const rep = reps.find((r) => r.includes(name) || name.includes(r))
      if (rep) {
        repOf.set(name, rep)
        return
      }
      reps.push(name)
      repOf.set(name, name)
    })
  return repOf
}

/**
 * 来源分布（谁在报）。做一层轻量归并，规则见 mergeSources。
 */
function buildSources(report: Report): SourceDistribution | null {
  const labels = collectSourceLabels(report)
  if (labels.length < MIN_SOURCE_ITEMS) return null

  const repOf = mergeSources(labels)
  const merged = new Map<string, number>()
  labels.forEach((l) => {
    const rep = repOf.get(l) ?? l
    merged.set(rep, (merged.get(rep) ?? 0) + 1)
  })

  const total = labels.length
  const unknown = report.dynamics.length - total
  const ranked = Array.from(merged.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const peak = ranked.length > 0 ? ranked[0][1] : 0
  const rest = ranked.slice(SOURCE_TOP)
  return {
    items: ranked
      .slice(0, SOURCE_TOP)
      .map(([name, count]) => ({ name, count, ratio: peak > 0 ? count / peak : 0 })),
    total,
    unknown,
    families: ranked.length,
    others: rest.reduce((sum, [, n]) => sum + n, 0),
    otherFamilies: rest.length
  }
}

function buildSentiment(report: Report): SentimentBreakdown | null {
  const total = report.dynamics.length
  if (total === 0) return null
  let positive = 0
  let negative = 0
  for (const d of report.dynamics) {
    if (d.sentiment === 'positive') positive++
    else if (d.sentiment === 'negative') negative++
  }
  return { positive, negative, neutral: total - positive - negative, total }
}

/**
 * 来源 × 情绪（怎么报）。
 *
 * 与「来源分布」同源同归并，只是把每条动态再按 sentiment 分一次组。
 * 门槛见 MIN_TILT_PER_SOURCE：**一条报道代表不了一家媒体的倾向** ——
 * 若把只有 1 条的来源也列出来，会出现「某媒体 100% 负面」这种由单篇报道
 * 造出来的假象，比不列更糟。未单列的条数与家数如实报到 hidden 里，脚注说明。
 */
function buildSourceTilt(report: Report): SourceTilt | null {
  const labels = collectSourceLabels(report)
  if (labels.length < MIN_SOURCE_ITEMS) return null

  const repOf = mergeSources(labels)
  const acc = new Map<string, TiltSlice>()
  for (const d of report.dynamics) {
    const label = sourceOf(d)
    if (!label) continue
    const name = repOf.get(label) ?? label
    const cur = acc.get(name) ?? { name, positive: 0, neutral: 0, negative: 0, total: 0, tilt: 0 }
    if (d.sentiment === 'positive') cur.positive++
    else if (d.sentiment === 'negative') cur.negative++
    else cur.neutral++
    cur.total++
    acc.set(name, cur)
  }

  const all = Array.from(acc.values())
  const shown = all
    .filter((s) => s.total >= MIN_TILT_PER_SOURCE)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  if (shown.length < MIN_TILT_FAMILIES) return null

  const items = shown.slice(0, SOURCE_TOP)
  items.forEach((s) => {
    /* 净值只用于排序与「全正面 / 全负面」这类可判定的事实标注，界面上不做词性判断 */
    s.tilt = (s.positive - s.negative) / s.total
  })

  return {
    items,
    total: labels.length,
    unknown: report.dynamics.length - labels.length,
    families: all.length,
    hidden: labels.length - items.reduce((n, s) => n + s.total, 0),
    hiddenFamilies: all.length - items.length
  }
}

/**
 * 标题归一：只留汉字与字母数字，取前 TITLE_KEY_LEN 字，作为「同一件事」的键。
 *
 * 用白名单而不是「去掉标点」：标点的种类穷举不完（全角半角、各种引号破折号），
 * 而标题里真正有信息量的就是一个连续的字串。这是启发式，脚注里如实写出口径 ——
 * 同一个思路见 utils/compare.ts 的 sameTopic。
 */
function titleKey(s: string): string {
  return s.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, TITLE_KEY_LEN)
}

/**
 * 素材可信度画像：回答「这些素材本身有多硬」。
 *
 * 三件事全部由端上数出来（不依赖 coverage，故老报告也有）：
 *   - **独立信源数**（families）：归并后的来源家数，与来源分布一致；
 *   - **独立事件数**（events）：按标题归一聚类，同一件事被多家转来转去只算一件；
 *   - **重复报道比**（repeatRatio）：`1 - events / total`，越高说明素材越是同一件事的回声。
 *
 * 「首报」取带日期条目里最早的一条。日期都不可解析时给 null 而不是取第一条 ——
 * 收录顺序不是时间顺序，拿它冒充首报就是编。
 */
function buildCredibility(report: Report): CredibilityProfile | null {
  /* 门槛看**可判定来源的条数**而不是动态总条数：total 只要求「有 3 条动态」，
     而这张卡的两个核心数字（独立信源数 families、重复报道比 repeatRatio）全都建立在
     「知道这条是谁报的」之上 —— 总条数够、来源全判不出的报告会出一张 sourced=0 的空卡。
     与来源分布卡（buildSources）同一判据，也正是 MIN_SOURCE_ITEMS 注释所写的口径。 */
  const labels = collectSourceLabels(report)
  if (labels.length < MIN_SOURCE_ITEMS) return null

  const total = report.dynamics.length
  const repOf = mergeSources(labels)
  const families = new Set(labels.map((l) => repOf.get(l) ?? l)).size

  /* 事件簇：键 → 报道它的来源集合。来源判不出的条目按「独立来源」计
     （用下标造一个唯一键），否则会把一堆未知来源误当成同一家在转载。 */
  const groups = new Map<string, Set<string>>()
  report.dynamics.forEach((d, i) => {
    const raw = (d.title || '').trim() || (d.summary || '').trim()
    const key = titleKey(raw) || `__anon-${i}`
    const label = sourceOf(d)
    const set = groups.get(key) ?? new Set<string>()
    set.add(label ? repOf.get(label) ?? label : `__unknown-${i}`)
    groups.set(key, set)
  })

  let shared = 0
  groups.forEach((set) => {
    if (set.size >= 2) shared++
  })

  let first: CredibilityProfile['first'] = null
  for (const d of report.dynamics) {
    const parsed = parseDay(d.date)
    if (!parsed) continue
    const date = parsed.format('YYYY-MM-DD')
    if (!first || date < first.date) {
      first = { source: sourceOf(d) || '来源未标注', date, title: d.title }
    }
  }

  const events = groups.size
  return {
    total,
    sourced: labels.length,
    families,
    events,
    shared,
    repeated: total - events,
    repeatRatio: total > 0 ? (total - events) / total : 0,
    first
  }
}

/** 分桶后的一个格子：键（YYYY-MM / YYYY-MM-DD）、横轴刻度与折叠结果 */
interface BucketCell<A> {
  key: string
  label: number
  value: A
}

/**
 * 分桶骨架（月 / 日通用）：把带日期的原始条目摊成一段连续的时间桶，逐桶交给 `reduce` 折叠。
 *
 * 三条规矩与最初的月度分布完全一致，只是把「刻度」抽成了参数：
 *   1. 对齐到 anchor 所在桶，丢弃未来桶（脏数据）与窗口外的桶；
 *   2. 去重键 = 桶偏移 + 文本前缀 —— 同一件事只计一次，文本不同宁可多算也不误合并；
 *   3. 桶从最早有数据的桶数到最晚有数据的桶，右侧不留空柱。
 *
 * 折叠下沉成参数，是为了让「情绪走势」在**同一套桶**上多统计三个维度（积极 / 中性 / 消极）。
 * 若给它另写一套分桶，迟早出现「时间分布与情绪走势的横轴对不上」——
 * 与 utils/date.ts 记的是同一个教训：同一件事只能有一处定义。
 */
function bucketize<A>(
  anchor: dayjs.Dayjs,
  facts: DatedFact[],
  step: BucketStep,
  windowSize: number,
  minEvents: number,
  reduce: (items: DatedFact[]) => A
): { cells: BucketCell<A>[]; total: number } | null {
  const anchorStart = anchor.startOf(step)

  const seen = new Set<string>()
  const byOffset = new Map<number, DatedFact[]>()
  let total = 0
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]
    const d = parseDay(f.date)
    if (!d) continue
    const offset = d.startOf(step).diff(anchorStart, step)
    if (offset > 0 || offset <= -windowSize) continue
    /* 文本为空时不能只靠 offset 做键：同一桶里所有「没标题也没摘要」的条目会共用一个键，
       被当成同一件事重复去重、只剩 1 条，条数直接少算（还可能把这张卡压到 minEvents 以下）。
       与 buildCredibility 里 `__anon-${i}` 同一处理：判不出身份就按独立事件计，宁多不误合。 */
    const text = (f.text ?? '').slice(0, 12)
    const key = text ? `${offset}|${text}` : `${offset}|#${i}`
    if (seen.has(key)) continue
    seen.add(key)
    const list = byOffset.get(offset) ?? []
    list.push(f)
    byOffset.set(offset, list)
    total++
  }
  if (total < minEvents) return null

  /* 窗口左端 = 最早有数据的桶，但不超过 windowSize 格；右端 = 最晚有数据的桶 */
  const offsets = Array.from(byOffset.keys())
  const end = Math.max(...offsets)
  const start = Math.max(end - (windowSize - 1), Math.min(...offsets))

  const cells: BucketCell<A>[] = []
  for (let o = start; o <= end; o++) {
    const t = anchorStart.add(o, step)
    cells.push({
      key: t.format(step === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'),
      label: step === 'month' ? t.month() + 1 : t.date(),
      value: reduce(byOffset.get(o) ?? [])
    })
  }
  return { cells, total }
}

/** 时间分布（逐桶数数）—— bucketize 的数数版，月 / 日共用 */
function bucketDistribution(
  anchor: dayjs.Dayjs,
  facts: DatedFact[],
  step: BucketStep,
  windowSize: number,
  minEvents: number
): TimeDistribution | null {
  const bucketed = bucketize(anchor, facts, step, windowSize, minEvents, (items) => items.length)
  if (!bucketed) return null

  const items: TimeSlice[] = bucketed.cells.map((c) => ({
    key: c.key,
    label: c.label,
    count: c.value,
    ratio: 0
  }))
  const peak = items.reduce((max, it) => Math.max(max, it.count), 0)
  items.forEach((it) => {
    it.ratio = peak > 0 ? it.count / peak : 0
  })

  return {
    items,
    total: bucketed.total,
    peak,
    from: items[0].key,
    to: items[items.length - 1].key
  }
}

/**
 * 情绪走势：带日期的动态按**月**分层后的情绪构成。
 *
 * 复用月度分布同一套桶、同一窗口（12 个月、锚定生成时间），所以**桶宽与锚点一致**，
 * 不会出现「同一屏里两张卡的月份错位」。注意两边数据源不同：月度分布还含时间线事件，
 * 这张卡只有动态 —— 故两卡的起止月份**可以不相等**，那是数据差异，不是口径差异。
 * 门槛比时间分布多一条：**至少两个月有数据** —— 全落在一个月里只是一根柱子，
 * 那叫构成，不叫走势（构成已由「情绪构成」那张卡回答）。少一个月的样本就整卡不出，
 * 而不是画一根孤零零的柱子供人误读。
 */
function buildSentimentTrend(report: Report): SentimentTrend | null {
  const base = dayjs(report.generatedAt)
  if (!base.isValid()) return null

  const facts: DatedFact[] = report.dynamics.map((d) => ({
    date: d.date,
    text: d.title !== '' ? d.title : d.summary,
    sentiment: d.sentiment
  }))

  const bucketed = bucketize(base, facts, 'month', MONTHS_WINDOW, MIN_TREND_EVENTS, (items) => {
    let positive = 0
    let negative = 0
    items.forEach((f) => {
      if (f.sentiment === 'positive') positive++
      else if (f.sentiment === 'negative') negative++
    })
    return { positive, negative, neutral: items.length - positive - negative, total: items.length }
  })
  if (!bucketed) return null
  if (bucketed.cells.filter((c) => c.value.total > 0).length < 2) return null

  const peak = bucketed.cells.reduce((max, c) => Math.max(max, c.value.total), 0)
  const items: SentimentSlice[] = bucketed.cells.map((c) => ({
    key: c.key,
    label: c.label,
    positive: c.value.positive,
    neutral: c.value.neutral,
    negative: c.value.negative,
    total: c.value.total,
    ratio: peak > 0 ? c.value.total / peak : 0
  }))

  let positive = 0
  let negative = 0
  items.forEach((s) => {
    positive += s.positive
    negative += s.negative
  })
  const total = bucketed.total
  return {
    items,
    total,
    peak,
    from: items[0].key,
    to: items[items.length - 1].key,
    tilt: total > 0 ? (positive - negative) / total : 0
  }
}

/**
 * 月度分布。基准月取报告的生成时间而不是「现在」：同一份缓存报告任何时候打开
 * 都该画出同一张图（与 utils/trend.ts 同一处理）。
 */
function buildMonths(report: Report): TimeDistribution | null {
  const base = dayjs(report.generatedAt)
  if (!base.isValid()) return null
  const facts: DatedFact[] = []
  report.dynamics.forEach((d) => facts.push({ date: d.date, text: d.title !== '' ? d.title : d.summary }))
  report.timeline.forEach((t) => facts.push({ date: t.date, text: t.event }))

  return bucketDistribution(base, facts, 'month', MONTHS_WINDOW, MIN_MONTH_EVENTS)
}

/**
 * 逐日分布（O-16② —— 主页「月度分布」同一套分桶复用到周报）。
 *
 * 周报窗口只有 7 天，按月分桶必然只剩一两根柱、看不出节奏；故复用同一套分桶
 * （对齐 / 去重 / 丢弃未来 / 峰值归一），只把刻度换成「日」，横轴就是本周逐日。
 * 锚点同月度分布：取**周报生成时间**，于是同一份缓存周报任何时候打开都是同一张图。
 */
export function buildDayDistribution(
  anchorISO: string,
  facts: DatedFact[],
  windowSize: number,
  minEvents = MIN_DAY_EVENTS
): TimeDistribution | null {
  const base = dayjs(anchorISO)
  if (!base.isValid()) return null
  return bucketDistribution(base, facts, 'day', windowSize, minEvents)
}

/** 数据 Tab 的全部聚合结果（纯函数：同一份报告必然得到同一结果） */
export function buildProfileStats(report: Report): ProfileStats {
  return {
    exposure: buildExposure(report),
    sources: buildSources(report),
    sentiment: buildSentiment(report),
    months: buildMonths(report),
    tilt: buildSourceTilt(report),
    credibility: buildCredibility(report),
    sentimentTrend: buildSentimentTrend(report)
  }
}
