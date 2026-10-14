import { DOMAIN_CODES, DOMAIN_META, DomainCode } from './domains'
import { REPORT_TEMPLATE, TEMPLATE_SIZE } from '../utils/report-toc'

/**
 * 发现页搜索筛选条件（§2.1 M1 搜索入口）。
 * 1) 行业：限定领域码，作用于消歧（LLM 候选约束）与候选列表筛选；
 * 2) 关注：报告生成的侧重段落（§2.3 六段中的可聚焦段）。
 */

/** 关注方向码（'all' = 综合，完整报告输出） */
export type FocusCode = 'all' | 'dynamics' | 'quotes' | 'timeline'

/**
 * focus 码 → 报告模板里的节 id（模板真源见 utils/report-toc.ts#REPORT_TEMPLATE）。
 *
 * 这是「关注筛选」与「报告模板」之间**唯一的绑定点**：标签与顺序都从被绑定的那一节派生，
 * 不再各写一份字符串。此前两处硬编码、改名不报错（dynamics↔sec-dynamics / quotes↔sec-quotes /
 * timeline↔sec-timeline 全靠人工对齐）。
 * 'all' 不绑定单节（= 完整报告），故不在此表里。
 */
const FOCUS_SECTION_ID: Record<Exclude<FocusCode, 'all'>, string> = {
  dynamics: 'sec-dynamics',
  quotes: 'sec-quotes',
  timeline: 'sec-timeline'
}

/**
 * 取模板里某节的 label（同源派生）。绑定的节不存在时回落空串 —— 该漂移由
 * test/cases/01-pure.js「关注方向码/标签/顺序与报告模板同源」用例**立刻**拦下：
 * 改模板节 id 或删节，那条用例即红（不在这里抛错，否则会连带炸掉整个用例套件）。
 */
function sectionLabel(id: string): string {
  return REPORT_TEMPLATE.find((s) => s.id === id)?.label ?? ''
}

/** 取模板里某节的 desc（同源派生，见 report-toc.ts#ReportTemplateSection.desc）。 */
function sectionDesc(id: string): string {
  return REPORT_TEMPLATE.find((s) => s.id === id)?.desc ?? ''
}

/** focus 码在模板里的先后位置（绑定的节缺失时返回 -1，同样由那条一致性用例拦截） */
const templateIndex = (code: Exclude<FocusCode, 'all'>): number =>
  REPORT_TEMPLATE.findIndex((s) => s.id === FOCUS_SECTION_ID[code])

/** focus 码顺序 = 绑定节在模板中的先后顺序（'all' 固定在最前） */
const FOCUS_DIRECTIONS = (Object.keys(FOCUS_SECTION_ID) as Array<Exclude<FocusCode, 'all'>>).sort(
  (a, b) => templateIndex(a) - templateIndex(b)
)

export const FOCUS_CODES: FocusCode[] = ['all', ...FOCUS_DIRECTIONS]

export const FOCUS_META: Record<FocusCode, { label: string; short: string; desc: string }> = {
  /* 'all' 不绑定单节，节数从模板名义值 TEMPLATE_SIZE 派生（不再硬编码「六段」旧文案） */
  all: { label: '综合', short: '综合', desc: `完整报告 · 共 ${TEMPLATE_SIZE} 节` },
  /* label / desc 均取自模板对应节（同源）；short 是「关注筛选」自己的短标签，仍在此维护 */
  dynamics: { label: sectionLabel(FOCUS_SECTION_ID.dynamics), short: '动态', desc: sectionDesc(FOCUS_SECTION_ID.dynamics) },
  quotes: { label: sectionLabel(FOCUS_SECTION_ID.quotes), short: '言论', desc: sectionDesc(FOCUS_SECTION_ID.quotes) },
  timeline: { label: sectionLabel(FOCUS_SECTION_ID.timeline), short: '履历', desc: sectionDesc(FOCUS_SECTION_ID.timeline) }
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
  return `${d} · ${focus === 'all' ? '完整报告' : `侧重${FOCUS_META[focus].short}`}`
}

/**
 * 供一致性用例断言用的绑定表（focus 码 → 模板节 id）。
 * 与 FOCUS_SECTION_ID 同源；单独导出只是为了让测试能读到绑定关系（生产代码不必用它）。
 */
export const FOCUS_SECTION_BINDING: Readonly<Record<Exclude<FocusCode, 'all'>, string>> = FOCUS_SECTION_ID
