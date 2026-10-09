import type { Report } from './report'

/**
 * 报告页目录（本轮）：把「这份报告**实际**呈现了哪些节」集中在这里算，页面只管渲染与跳转。
 *
 * 为什么单独立一个纯函数，而不是在页面里就地写一个数组：
 * 报告页的卡片已经从最初六段涨到十七节，其中一半是条件渲染（降级简版、老报告的字段缺失、
 * 端上聚合的门槛、会员态）。目录若与页面条件各写一份，**增删一段必然有一处对不上** ——
 * 要么目录里点得动、页面里没有这张卡（点了没反应），要么页面有卡、目录里找不到入口。
 * 这与 utils/member.ts#presentSections 是同一条理由：「哪些段落算专享」那种口径一旦散进页面，
 * 就会失控。放在这里还有一个直接好处：**可以被测试钉住**（见 test/cases/01-pure.js）。
 *
 * ⚠ 仍然要记住：条件与 pages/report/index.tsx 里卡片的外层条件是**平行**的两处。
 *   改任何一张卡的渲染条件，必须同步改这里，并跑 `报告目录 utils/report-toc` 那组用例。
 *   两边都有注释互相指路，别只改一处。
 *
 * 标签刻意比卡片标题短（「争议与回应」对应卡片上的「近期争议与回应」）：
 * 目录是胶囊条，标签长了排版就散；用户点进去看到全称不算落差。
 */
export interface TocSection {
  /** 锚点 id：页面卡片上的 `id` 属性必须与它一字不差（页面直接拿它拼 `#${id}` 跳转） */
  id: string
  label: string
}

export interface TocOptions {
  /** 当前是否会员：会员专享那一节只对会员渲染（免费用户整卡不出，见页面注释） */
  member: boolean
  /**
   * 「人物速览」那一节是否会出现。
   * 它的门槛在端上（要看素材覆盖范围算不算得出来），调用方算好再传进来：
   * 可见的充要条件是「不是降级简版，或有覆盖数据」。
   */
  hasOverview: boolean
}

export function buildReportToc(report: Report | null | undefined, opts: TocOptions): TocSection[] {
  if (!report) return []

  const list: TocSection[] = []
  const add = (id: string, label: string) => list.push({ id, label })

  /* 顺序 = pages/report/index.tsx 里卡片的渲染顺序 */
  if (opts.hasOverview) add('sec-overview', '人物速览')
  /* 简介：降级简版且没有 intro 时，空态卡与实体卡两个分支都不成立 */
  if (!report.degraded || report.intro) add('sec-intro', '简介')
  if (report.profile) add('sec-profile', '人物档案')
  if (report.relations) add('sec-relations', '关系图谱')
  /* 商业价值速览（第 0 期）：非降级简版恒出卡 —— 门槛只决定卡里是速览还是「缺什么」的说明，
     两种形态都是一张可读的卡，故目录里始终列它（utils/commercial.ts 的 ready 不参与这里） */
  if (!report.degraded) add('sec-commercial', '商业速览')
  if (!report.degraded) {
    add('sec-dynamics', '近期动态')
    add('sec-quotes', '经典名言')
  }
  /* AI 点评有三个分支（降级简版 / 无正文空态 / 实体），至少命中一个 → 始终在 */
  add('sec-analysis', 'AI 点评')
  if (report.controversies) add('sec-controversies', '争议与回应')
  if (!report.degraded) add('sec-risk', '风险雷达')
  if (opts.member && !report.degraded) add('sec-member', '会员专享')
  if (!report.degraded) {
    add('sec-stance', '立场与舆情')
    add('sec-cloud', '关键词云')
    add('sec-qtheme', '语录主题')
    add('sec-trend', '热度趋势')
    add('sec-timeline', '时间线')
  }
  if (report.watchlist) add('sec-watchlist', '后续关注')
  if (report.glossary) add('sec-glossary', '名词解释')

  return list
}
