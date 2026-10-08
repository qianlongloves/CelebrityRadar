import dayjs from 'dayjs'
import type { Report } from './report'

/**
 * 热度趋势（M4-6）：纯端上聚合，把报告里**带日期、可核对**的条目摊成一条近 30 天折线。
 *
 * 口径为何是这些数据：Schema 不落素材的逐日分布（coverage 只有 N30 / N7 两个标量），
 * 端上能拿到的日期序列就是 dynamics.date 与 timeline.date —— 模型基于素材给出的日期，
 * 与「近期动态」「时间线」两张卡同源，读的人可以逐条对上，不存在凭空造出的点。
 * 所以这张卡画的是**公开信息节奏**（哪些时段更密），不是全量报道量，脚注里也这么写。
 *
 * 为何不扩 Schema 存逐日分布：报告是「一次生成、长期缓存」的资产，加字段等于让所有
 * 存量报告都看不到这张卡（除非逼用户再消耗一次生成额度）；端上聚合对新老报告一视同仁。
 *
 * 渲染不引图表库：主包硬限 2MB，词云是 CSS 标签墙、情绪条是 flex 比例条，折线同样用
 * View + transform 自绘（几何换算见 pages/report/index.tsx 的 trendGeometry）。
 */

/** 观察窗口（天）与分桶数：30 天 / 6 桶 = 5 天一格，看得出疏密又不至于全是空桶 */
const WINDOW_DAYS = 30
const BUCKETS = 6
/** 少于 3 条就整卡不出：两个点连不成趋势，与词云（<4 词不出）同一取舍 */
const MIN_EVENTS = 3
/** 只认模型契约里的 YYYY-MM-DD；其它形态（带时区、只到月份）一律不解析，宁可少一个点也不猜 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}/

export interface TrendPoint {
  /** 桶起始日（M/D），横轴刻度 */
  label: string
  /** 落在该桶内的条目数 */
  count: number
  /** count / peak，0~1，用于纵向定位 */
  ratio: number
  /** 桶中心在横轴上的比例，0~1 */
  x: number
}

export interface HeatTrend {
  points: TrendPoint[]
  /** 参与聚合的条目数（动态 + 时间线，去重后） */
  total: number
  /** 条目覆盖的天数（首末间隔 + 1） */
  spanDays: number
  /** 窗口起止（YYYY-MM-DD） */
  from: string
  to: string
  /** 单桶最多几条，纵轴上限 */
  peak: number
}

/**
 * 聚合出一份报告的趋势折线；条目不足或日期不可解析时返回 null（调用方整卡不渲染）。
 */
export function buildHeatTrend(
  report: Report,
  opts: { days?: number; buckets?: number } = {}
): HeatTrend | null {
  /* 基准日固定用报告的生成时间，而不是「现在」：同一份缓存报告任何时候打开都该画出同一条线 */
  const base = dayjs(report.generatedAt)
  if (!base.isValid()) return null

  const days = Math.max(2, Math.floor(opts.days ?? WINDOW_DAYS))
  const buckets = Math.max(1, Math.floor(opts.buckets ?? BUCKETS))
  const to = base.startOf('day')
  const from = to.subtract(days - 1, 'day')

  /* 去重键 = 距窗口起点的天数 + 文本前缀：动态与时间线常记同一件事（同一天同一种说法），
     不去重会让同一事件在图上算两次；文本不同则视为两件事，宁可多算也不误合并。 */
  const seen = new Set<string>()
  const offsets: number[] = []
  const collect = (date: string | undefined, text: string | undefined) => {
    if (!DAY_RE.test(date ?? '')) return
    const d = dayjs(date)
    if (!d.isValid()) return
    const offset = d.startOf('day').diff(from, 'day')
    if (offset < 0 || offset >= days) return
    const key = `${offset}|${(text ?? '').slice(0, 12)}`
    if (seen.has(key)) return
    seen.add(key)
    offsets.push(offset)
  }
  report.dynamics.forEach((d) => collect(d.date, d.title !== '' ? d.title : d.summary))
  report.timeline.forEach((t) => collect(t.date, t.event))

  if (offsets.length < MIN_EVENTS) return null

  const per = days / buckets
  const counts = new Array<number>(buckets).fill(0)
  offsets.forEach((o) => {
    counts[Math.min(buckets - 1, Math.floor(o / per))] += 1
  })

  const peak = Math.max(...counts)
  const points: TrendPoint[] = counts.map((count, i) => ({
    label: from.add(Math.round(i * per), 'day').format('M/D'),
    count,
    ratio: peak > 0 ? count / peak : 0,
    x: (i + 0.5) / buckets
  }))

  return {
    points,
    total: offsets.length,
    spanDays: Math.max(...offsets) - Math.min(...offsets) + 1,
    from: from.format('YYYY-MM-DD'),
    to: to.format('YYYY-MM-DD'),
    peak
  }
}
