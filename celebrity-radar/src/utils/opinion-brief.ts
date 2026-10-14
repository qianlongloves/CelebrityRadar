import type { ImpactLevel, OpinionEntry } from './opinion-rank'
import { RISK_CATEGORIES, RISK_CATEGORY_LABEL } from './risk'
import type { RiskCategory } from './risk'

/**
 * 每日舆情简报（P10，2026-10-14）——把统一队列聚成**一张数字 + 图表的概览**。
 *
 * 为什么单独成纯函数：简报里的「风险类别分布 / 影响面分布 / 需回应计数」都是对同一条
 * 统一队列的聚合，规则要被单测逐条钉住、页面只负责渲染。这里不碰任何网络 / storage /
 * 云函数，输入输出都是普通对象；**遇到脏数据一律按 0 计，绝不抛错**（简报是辅助视图，
 * 数据缺失时少一根柱子即可，不能因它白屏）。
 *
 * 口径与合规边界（与 utils/opinion-rank.ts 同源）：
 *   · 只统计**已过滤存量条目**里已有的分级字段（category / level / response），不新增内容、
 *     不做倾向性猜测；没有字段的一律落「未评级 / 未知」，绝不拿标题去补一个级别。
 *   · 分级标签来自「报道里出现的表述类别」，不是平台对人和事的定性（简报区同样保留一句免责）。
 */

/** 图表里的一根柱子 / 一条横杠 */
export interface BriefBar {
  /** 稳定键（风险类别码 / 影响面档位），React key 用 */
  key: string
  /** 展示标签 */
  label: string
  /** 命中条数 */
  count: number
  /** 相对最大值（0~1），条形宽度 / 柱状高度按它换算百分比 */
  ratio: number
}

/** 每日舆情简报的聚合结果 */
export interface DailyBrief {
  /** 参与统计的队列条目总数（统一队列去重后） */
  total: number
  /** 有风险类别标注的条目数 */
  riskCount: number
  /** 风险类别分布（只含有命中的类别，按 utils/risk 的固定顺序） */
  categories: BriefBar[]
  /** 影响面分布（高 / 中 / 低 / 未评级，只含有条数的档） */
  impacts: BriefBar[]
  /** 建议回应的条目数 */
  respondCount: number
  /** 建议关注的条目数 */
  watchCount: number
}

/** 影响面在柱状图下的短标签（长标签「影响面高」太宽，柱下放不下） */
const IMPACT_SHORT: Record<ImpactLevel, string> = {
  high: '高',
  mid: '中',
  low: '低',
  unknown: '未评级'
}

/** 影响面展示顺序：高在前、未评级垫底（与 RISK_LEVEL_OF 的直觉一致） */
const IMPACT_ORDER: ImpactLevel[] = ['high', 'mid', 'low', 'unknown']

export function buildDailyBrief(entries: OpinionEntry[]): DailyBrief {
  const byCategory: Record<RiskCategory, number> = {
    judicial: 0,
    tax: 0,
    contract: 0,
    rights: 0,
    statement: 0
  }
  const byImpact: Record<ImpactLevel, number> = { high: 0, mid: 0, low: 0, unknown: 0 }
  let riskCount = 0
  let respondCount = 0
  let watchCount = 0

  for (const e of entries) {
    /*
     * 对 category / impact 都做「合法值白名单」防御：直接喂脏对象（绕过 buildOpinionQueue 归一）
     * 时也不会把 undefined 计数成 NaN（`byCategory[非法串]` 是 undefined，++ 会得到 NaN，污染整图）。
     * 正常数据流里 category 已被 asRiskCategory 归一、impact 已被 impactOf 归一，这里只兜底。
     */
    const cat = e.category
    if (cat && byCategory[cat] !== undefined) {
      byCategory[cat]++
      riskCount++
    }
    const imp = e.impact
    if (imp && byImpact[imp] !== undefined) {
      byImpact[imp]++
    }
    if (e.response === 'respond') respondCount++
    else if (e.response === 'watch') watchCount++
  }

  /* 条形 / 柱状的比例以「该组最大值」为满格：数量差异小时柱子也拉得开，而不是全挤成一条线 */
  const categoryMax = Math.max(...RISK_CATEGORIES.map((c) => byCategory[c]), 1)
  const categories: BriefBar[] = RISK_CATEGORIES.filter((c) => byCategory[c] > 0).map((c) => ({
    key: c,
    label: RISK_CATEGORY_LABEL[c],
    count: byCategory[c],
    ratio: byCategory[c] / categoryMax
  }))

  const impactMax = Math.max(...IMPACT_ORDER.map((k) => byImpact[k]), 1)
  const impacts: BriefBar[] = IMPACT_ORDER.filter((k) => byImpact[k] > 0).map((k) => ({
    key: k,
    label: IMPACT_SHORT[k],
    count: byImpact[k],
    ratio: byImpact[k] / impactMax
  }))

  return {
    total: entries.length,
    riskCount,
    categories,
    impacts,
    respondCount,
    watchCount
  }
}
