import { domainLabel, parsePersonKey } from '@/config/domains'
import { REPORT_TEMPLATE } from './report-toc'
import { shortDay8 } from './time'
import type { Report } from './report'

/**
 * 「人 × 指标」的行定义 —— **全项目唯一真源**（N-6）。
 *
 * 为什么要有这个模块：项目里有两处「把两份报告 / 几个人摆在一起看同一批数字」的界面 ——
 *   · 对比页 `utils/compare.ts`（双人深度对照，从报告页底部进入）
 *   · 监测工作台 `utils/workbench.ts`（跨人台账，列 = 我盯的那几个人）
 * 它们此前**各写了一套指标行**，于是同一个数字长了两个名字：`report.dynamics.length` 在对比页
 * 叫「报告内动态」、在工作台叫「近期动态」；`report.quotes.length` 一个叫「收录言论」、
 * 另一个叫「经典名言」。两套口径的结局必然是漂移成两个数字（改了一处忘了另一处），
 * 而用户看到的是「同一份报告的两个说法」—— 那是比少一行数字严重得多的问题。
 *
 * 所以这里的纪律：
 *   ① **行定义只有这一份**，两页各自只声明「我显示哪几行」（COMPARE_METRIC_KEYS /
 *      WORKBENCH_METRIC_KEYS），不再各写一遍标签与取值；
 *   ② **标签取自章节真源**（`utils/report-toc.ts#REPORT_TEMPLATE` 的 label）：指标就是
 *      「报告里那一段有几条」，报告页改了段名这里跟着改，**不允许手抄第二遍**
 *      （这正是「报告内动态 / 收录言论 / 履历节点」三个旧名字被换掉的原因）；
 *   ③ **取值只搬运已落库报告的既有字段**，不做跨人加减乘除 —— 一旦算出「综合分」，
 *      就等于平台替用户排了序，那是判断不是事实。
 */

/** 指标行定义（`value` 与 `text` 二选一：前者是数字行，后者是文本行） */
export interface MetricDef {
  key: string
  /** 展示名；章节类指标取自报告模板（见 tocLabel），非章节指标（领域 / 热度 / 报告生成）在此写死 */
  label: string
  /**
   * 单位后缀（例 ' 条'）。它不是装饰：同样一个 3，说「3 条」与说「热度 3」不是一件事，
   * 一张表里两种读数混着摆、又不标单位，读的人只能猜。热度 / 领域 / 报告生成不用（空 = 原样）。
   */
  unit?: string
  /** 取值：null = 这份报告给不出（例：老报告没有 coverage ⇒ 显示「—」） */
  value?: (r: Report | null) => number | null
  /** 文本指标（领域 / 报告生成）：给了它就不再走 value */
  text?: (r: Report | null, personKey: string) => string
  /**
   * 是否给「谁更高 / 谁更多」的方向。**只有热度**——它是唯一跨档可比较的量尺
   * （见 utils/report.ts#HEAT_COUNT_CAP 与 compare.ts#CompareMetric.higher 的说明）。
   */
  higher?: boolean
  /** 口径说明（表下小字，避免指标沦为玄学数字） */
  hint?: string
  /** 这一行永远要显示（整行全 0 也不判空，例：领域 / 报告生成） */
  always?: boolean
  /** 没生成报告也算得出这一格（领域来自 personKey，与缓存无关） */
  ofUncached?: boolean
}

/**
 * 章节名只从报告模板取。
 *
 * 取不到就返回空串而不是编一个名字：模板里把 id 改了、这里却印着旧标签，是最难发现的一类漂移
 * （用例钉住「四个章节指标的名字等于模板里的名字」，改 id 会当场红）。
 */
function tocLabel(id: string): string {
  return REPORT_TEMPLATE.find((s) => s.id === id)?.label ?? ''
}

/**
 * 全部指标行。**这里的顺序 = 表内顺序**（两页各自挑子集，但都不重排 —— 顺序变了就是让用户
 * 把同一张表重新找一遍）。
 */
export const METRIC_DEFS: MetricDef[] = [
  /* 领域来自 personKey，与缓存无关，所以没生成报告的人也照实标 —— 这一行永远有意义 */
  {
    key: 'domain',
    label: '领域',
    always: true,
    ofUncached: true,
    text: (_r, personKey) => {
      const parsed = parsePersonKey(personKey)
      return (parsed?.domain ? domainLabel(parsed.domain) : '') || '未标注'
    }
  },
  {
    key: 'heat',
    label: '热度',
    higher: true,
    value: (r) => (typeof r?.heat === 'number' && Number.isFinite(r.heat) ? r.heat : null),
    hint: '由近 30 天与近 7 天报道条数按固定公式算出（§1.6），同口径可直接比大小'
  },
  {
    key: 'news',
    label: '近 30 天报道',
    value: (r) => (r?.coverage ? r.coverage.items : null),
    hint: '检索窗口内抓到的素材条数（原样统计）。深度档会抓得更多，故与热度不同口径，只作参考、不判优劣'
  },
  {
    key: 'recent',
    label: '近 7 天报道',
    value: (r) => (r?.coverage ? r.coverage.recent : null),
    hint: '其中发布于最近 7 天的条数（原样统计）。热度只取前 20 条计算，故本行数值会大于等于热度口径'
  },
  { key: 'dynamics', label: tocLabel('sec-dynamics'), unit: ' 条', value: (r) => (r ? r.dynamics.length : null) },
  { key: 'quotes', label: tocLabel('sec-quotes'), unit: ' 条', value: (r) => (r ? r.quotes.length : null) },
  { key: 'timeline', label: tocLabel('sec-timeline'), unit: ' 条', value: (r) => (r ? r.timeline.length : null) },
  {
    key: 'controversies',
    label: tocLabel('sec-controversies'),
    unit: ' 条',
    value: (r) => (r ? (r.controversies ?? []).length : null)
  },
  { key: 'relations', label: tocLabel('sec-relations'), unit: ' 条', value: (r) => (r ? (r.relations ?? []).length : null) },
  { key: 'profile', label: tocLabel('sec-profile'), unit: ' 条', value: (r) => (r ? (r.profile ?? []).length : null) },
  {
    key: 'generated',
    label: '报告生成',
    always: true,
    text: (r) => shortDay8(String(r?.generatedAt ?? '')) || '—'
  }
]

/**
 * 对比页（双人深度对照）显示的行：曝光度 + 素材量。
 *
 * 与工作台那份清单**刻意不同**，但这是版面选择、不是第二套口径：对比页要把两个人的「被报道量」
 * 与「报告里各段的条数」摆在一起；工作台要的是「这个人身上有什么可写的东西」（争议 / 关系 /
 * 档案）与生成状态。同一行在两页的标签、取值、单位完全一致，因为都来自上面那份定义。
 */
export const COMPARE_METRIC_KEYS = ['heat', 'news', 'recent', 'dynamics', 'quotes', 'timeline']

/** 工作台（跨人台账）显示的行 */
export const WORKBENCH_METRIC_KEYS = [
  'domain',
  'heat',
  'dynamics',
  'controversies',
  'relations',
  'profile',
  'generated'
]

/** 按 key 取行定义 */
export function metricDef(key: string): MetricDef | undefined {
  return METRIC_DEFS.find((d) => d.key === key)
}

/** 按 key 列表取行定义（没登记的 key 直接跳过 —— 宁缺勿造） */
export function metricsOf(keys: string[]): MetricDef[] {
  return keys.map((k) => metricDef(k)).filter((d): d is MetricDef => !!d)
}

/** 这一行的数值（文本指标恒 null；非有限数当「给不出」） */
export function metricValue(def: MetricDef, report: Report | null): number | null {
  if (def.text) return null
  const v = def.value ? def.value(report) : null
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * 这一格给人看的字：数值行拼上单位，取不到时用调用方指定的占位。
 *
 * 占位由调用方给，是因为两句话**不是一件事**：对比页的「—」= 这份报告没这个数；
 * 工作台的「未生成」= 这个人还没报告（同一个占位会把两者混起来，见 workbench#NOT_GENERATED）。
 */
export function metricText(def: MetricDef, report: Report | null, personKey: string, missing = '—'): string {
  if (def.text) return def.text(report, personKey)
  const v = metricValue(def, report)
  return v === null ? missing : `${v}${def.unit ?? ''}`
}
