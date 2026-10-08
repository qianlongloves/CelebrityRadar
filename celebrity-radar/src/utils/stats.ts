import dayjs from 'dayjs'
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
/** 只认模型契约里的 YYYY-MM-DD；其它形态不解析，宁可少一个点也不猜（同 utils/trend.ts） */
const DAY_RE = /^\d{4}-\d{2}-\d{2}/

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

/** 时间分桶的粒度：月（主页「时间分布」）/ 日（周报「近 7 天动态分布」） */
type BucketStep = 'month' | 'day'

/** 一条带日期的原始事实（动态 / 时间线 / 周报素材的通用形态） */
export interface DatedFact {
  /** 素材日期原文；不可解析即忽略（不猜） */
  date?: string
  /** 去重用的文本（同桶同一说法只计一次） */
  text?: string
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

/**
 * 来源分布。做一层轻量归并：互为子串的媒体名视为同一家 —— 模型从素材里抄站名，
 * 「新浪」与「新浪娱乐」会是两条，不合并时分布会碎成一地看不出主次
 * （与 utils/compare.ts 的 sameTopic 同一处理思路）。
 */
function buildSources(report: Report): SourceDistribution | null {
  const raw = new Map<string, number>()
  let unknown = 0
  for (const d of report.dynamics) {
    const label = (d.source || '').trim() || hostOf(d.url)
    if (!label) {
      unknown++
      continue
    }
    raw.set(label, (raw.get(label) ?? 0) + 1)
  }

  let total = 0
  raw.forEach((n) => {
    total += n
  })
  if (total < MIN_SOURCE_ITEMS) return null

  /* 高频优先归并：先由出现最多的写法占位，后续被它包含 / 包含它的写法并进来 */
  const merged = new Map<string, number>()
  const reps: string[] = []
  Array.from(raw.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .forEach(([name, count]) => {
      const rep = reps.find((r) => r.includes(name) || name.includes(r))
      if (rep) {
        merged.set(rep, (merged.get(rep) ?? 0) + count)
        return
      }
      reps.push(name)
      merged.set(name, count)
    })

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
 * 分桶核心（月 / 日通用）：把带日期的原始条目摊成一段连续的时间桶。
 *
 * 三条规矩与最初的月度分布完全一致，只是把「刻度」抽成了参数：
 *   1. 对齐到 anchor 所在桶，丢弃未来桶（脏数据）与窗口外的桶；
 *   2. 去重键 = 桶偏移 + 文本前缀 —— 同一件事只计一次，文本不同宁可多算也不误合并；
 *   3. 桶从最早有数据的桶数到最晚有数据的桶，右侧不留空柱。
 */
function bucketDistribution(
  anchor: dayjs.Dayjs,
  facts: DatedFact[],
  step: BucketStep,
  windowSize: number,
  minEvents: number
): TimeDistribution | null {
  const anchorStart = anchor.startOf(step)

  const seen = new Set<string>()
  const offsets: number[] = []
  for (const f of facts) {
    if (!DAY_RE.test(f.date ?? '')) continue
    const d = dayjs(f.date)
    if (!d.isValid()) continue
    const offset = d.startOf(step).diff(anchorStart, step)
    if (offset > 0 || offset <= -windowSize) continue
    const key = `${offset}|${(f.text ?? '').slice(0, 12)}`
    if (seen.has(key)) continue
    seen.add(key)
    offsets.push(offset)
  }
  if (offsets.length < minEvents) return null

  /* 窗口左端 = 最早有数据的桶，但不超过 windowSize 格；右端 = 最晚有数据的桶 */
  const end = Math.max(...offsets)
  const start = Math.max(end - (windowSize - 1), Math.min(...offsets))

  const bucket = new Map<number, number>()
  offsets.forEach((o) => bucket.set(o, (bucket.get(o) ?? 0) + 1))

  const items: TimeSlice[] = []
  for (let o = start; o <= end; o++) {
    const t = anchorStart.add(o, step)
    items.push({
      key: t.format(step === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'),
      label: step === 'month' ? t.month() + 1 : t.date(),
      count: bucket.get(o) ?? 0,
      ratio: 0
    })
  }
  const peak = items.reduce((max, it) => Math.max(max, it.count), 0)
  items.forEach((it) => {
    it.ratio = peak > 0 ? it.count / peak : 0
  })

  return { items, total: offsets.length, peak, from: items[0].key, to: items[items.length - 1].key }
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
    months: buildMonths(report)
  }
}
