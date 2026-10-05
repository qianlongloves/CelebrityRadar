import { DOMAIN_CODES, DOMAIN_META, DomainCode } from './domains'

/**
 * 发现页搜索筛选条件（§2.1 M1 搜索入口）。
 * 1) 行业：限定领域码，作用于消歧（LLM 候选约束）与候选列表筛选；
 * 2) 关注：报告生成的侧重段落（§2.3 六段中的可聚焦段）。
 */

/** 关注方向码（'all' = 综合，六段完整输出） */
export type FocusCode = 'all' | 'dynamics' | 'quotes' | 'timeline'

export const FOCUS_CODES: FocusCode[] = ['all', 'dynamics', 'quotes', 'timeline']

export const FOCUS_META: Record<FocusCode, { label: string; short: string; desc: string }> = {
  all: { label: '综合', short: '综合', desc: '简介 · 动态 · 言论 · 履历 六段完整' },
  dynamics: { label: '近期动态', short: '动态', desc: '近期新闻、公开活动与事件' },
  quotes: { label: '言论观点', short: '言论', desc: '公开表达、观点与金句' },
  timeline: { label: '经历履历', short: '履历', desc: '关键节点与成长脉络' }
}

export function isFocusCode(v: string): v is FocusCode {
  return (FOCUS_CODES as string[]).includes(v)
}

/** 行业筛选项：'all' + 全部领域码 */
export type DomainFilterCode = DomainCode | 'all'

export const DOMAIN_FILTER_CODES: DomainFilterCode[] = ['all', ...DOMAIN_CODES]

export function domainFilterLabel(code: DomainFilterCode): string {
  return code === 'all' ? '全部' : DOMAIN_META[code].label
}

/** 条件摘要文案，如「科技 · 侧重动态」 */
export function summarizeFilters(domain: DomainFilterCode, focus: FocusCode): string {
  const d = domain === 'all' ? '全部行业' : DOMAIN_META[domain].label
  return `${d} · ${focus === 'all' ? '六段完整' : `侧重${FOCUS_META[focus].short}`}`
}
