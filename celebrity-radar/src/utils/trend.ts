import dayjs from 'dayjs'
import { parseDay } from './date'
import type { Report } from './report'

/**
 * 热度趋势（M4-6）：纯端上聚合，把报告里**带日期、可核对**的条目摊成一条折线
 * （默认近 30 天，材料稀疏时按下面的阶梯放宽到 60 / 90 / 180 天）。
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

/** 优先窗口（天）与分桶数：30 天 / 6 桶 = 5 天一格，看得出疏密又不至于全是空桶 */
const WINDOW_DAYS = 30
/**
 * 材料不够时的放宽阶梯（天）。**这是「整卡凭空消失」的修复**：
 * 原先只认 30 天，而热闹型名人（文娱、体育）的公开报道本就是一阵一阵的 ——
 * 报告里的动态若集中在 40~90 天前，30 天内一条不剩，卡片就无声无息地没了，
 * 读的人只会以为功能被删了。放宽窗口后，稀疏报告画出的是「更粗一格」的节奏，
 * 横轴刻度会跟着变（5 天 → 10/15/30 天一格），信息仍然可核对。
 * 上限 180 天：再往前翻，混进来的多半是履历类节点，与「近期热度」不是一回事，
 * 那种报告本就该不出这张卡。
 */
const WINDOW_STEPS = [WINDOW_DAYS, 60, 90, 180]
const MAX_WINDOW_DAYS = 180
const BUCKETS = 6
/** 少于 3 条就整卡不出：两个点连不成趋势，与词云（<4 词不出）同一取舍 */
const MIN_EVENTS = 3

/* 日期归一见 utils/date.ts：与主页「时间分布」、周报「逐日分布」共用一套解析规则 */

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
  /** 实际采用的观察窗口（天）：30 起，材料稀疏时按阶梯放宽到 60 / 90 / 180 */
  windowDays: number
  /** 单桶最多几条，纵轴上限 */
  peak: number
}

/**
 * 聚合出一份报告的趋势折线；条目不足或日期不可解析时返回 null（调用方整卡不渲染）。
 *
 * 窗口选择：默认先按 30 天试，条数不够就沿 WINDOW_STEPS 放宽，直到够 MIN_EVENTS 或触到
 * 180 天上限。**必须按「先宽后窄」的顺序试**，因为放宽窗口会改变分桶粒度 ——
 * 已经有 30 天数据的报告不该因为「60 天能装下更多点」而被降级成 10 天一格。
 *
 * `opts.days` 一旦显式给出，就只试这一个窗口、不再放宽（给对比/固定口径的场景用）。
 */
export function buildHeatTrend(
  report: Report,
  opts: { days?: number; buckets?: number } = {}
): HeatTrend | null {
  /* 基准日固定用报告的生成时间，而不是「现在」：同一份缓存报告任何时候打开都该画出同一条线 */
  const base = dayjs(report.generatedAt)
  if (!base.isValid()) return null

  const buckets = Math.max(1, Math.floor(opts.buckets ?? BUCKETS))
  const to = base.startOf('day')

  /* 去重键 = 日期 + 文本前缀：动态与时间线常记同一件事（同一天同一种说法），
     不去重会让同一事件在图上算两次；文本不同则视为两件事，宁可多算也不误合并。
     键用绝对日期而不是「距窗口起点的天数」—— 后者会随窗口放宽而变，同一个事件
     在不同窗口下算不算重复就不一致了。 */
  const seen = new Set<string>()
  const events: dayjs.Dayjs[] = []
  const collect = (date: string | undefined, text: string | undefined) => {
    const d = parseDay(date)
    if (!d) return
    const day = d.startOf('day')
    const key = `${day.format('YYYY-MM-DD')}|${(text ?? '').slice(0, 12)}`
    if (seen.has(key)) return
    seen.add(key)
    events.push(day)
  }
  report.dynamics.forEach((d) => collect(d.date, d.title !== '' ? d.title : d.summary))
  report.timeline.forEach((t) => collect(t.date, t.event))

  /* 全部去重条目（不设窗口）都不够 MIN_EVENTS 时，任何窗口都救不回来 —— 先挡掉这层 */
  if (events.length < MIN_EVENTS) return null

  /* 阶梯由窄到宽，取第一个够数的窗口；显式给出 opts.days 时只试它这一个 */
  const steps = opts.days
    ? [Math.max(2, Math.min(MAX_WINDOW_DAYS, Math.floor(opts.days)))]
    : WINDOW_STEPS
  let chosen: { days: number; offsets: number[] } | null = null
  for (const days of steps) {
    const from = to.subtract(days - 1, 'day')
    const offsets = events
      .map((d) => d.diff(from, 'day'))
      .filter((o) => o >= 0 && o < days)
    if (offsets.length >= MIN_EVENTS) {
      chosen = { days, offsets }
      break
    }
  }
  if (!chosen) return null

  const { days, offsets } = chosen
  const from = to.subtract(days - 1, 'day')
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
    windowDays: days,
    peak
  }
}
