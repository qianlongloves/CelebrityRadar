import type { Report } from './report'

/**
 * 风险雷达（第 0 期，端上聚合）—— 报告页新卡的数据层。
 *
 * 这张卡只做一件事：**把报告已收录的素材里出现过的「司法 / 监管 / 解约 / 维权」类表述挑出来，
 * 逐条给出处**。不新增 Schema 字段、不新增云函数、不消耗生成额度，存量缓存立即生效。
 *
 * 三条刻意划死的边界（写在这里，避免后人把这张卡做成「风险评估」）：
 *
 *   1. **只做字面命中，不做语义判定**。命中即陈列，不判「这条算不算负面」，
 *      更不输出「风险等级 / 塌房概率」这类结论。平台的立场是：把素材里的表述指出来，
 *      是否构成问题由读者判断，并给出原文链接让读者自己核对。
 *   2. **宁可漏报，不可误报**。命中词前若紧邻否定词（「未被起诉」「否认解约」），
 *      整条不计入 —— 误报一条「起诉」，比漏掉十条更伤（同 utils/stats.ts 的
 *      「一条报道代表不了一家媒体的倾向」是同一个取舍）。
 *   3. **算不出就说算不出**。没有可扫描的条目时返回空结果，由页面出卡说明口径，
 *      而不是显示 0 条（「0 条」会被读成「查过了，很干净」）。
 *
 * 与 `memberNotes.risk` 的关系（用户最容易混的两处）：
 *   · 本卡 —— **已发生**的表述，事实，免费可见，每条能点回原文；
 *   · `memberNotes.risk` —— **面向未来**的判断，会员段，模型写的。
 * 二者不是同一条的两种说法，是「事实索引」与「前瞻判断」两层，禁止互相搬运内容。
 */

/** 类别：按「素材里出现的是哪一类表述」分组 —— 刻意不用「风险等级」措辞 */
export type RiskCategory = 'judicial' | 'tax' | 'contract' | 'rights' | 'statement'

/** 类别顺序：界面按此顺序展示分布标签（避免每个页面各排一份、两处顺序不一致） */
export const RISK_CATEGORIES: RiskCategory[] = ['judicial', 'tax', 'contract', 'rights', 'statement']

export const RISK_CATEGORY_LABEL: Record<RiskCategory, string> = {
  judicial: '司法监管',
  tax: '税务合规',
  contract: '商业合作',
  rights: '名誉维权',
  statement: '回应表态'
}

/** 信号来自报告的哪一段（界面用于说明「这条是从哪挑出来的」） */
export type RiskFrom = 'dynamics' | 'controversies' | 'quotes' | 'timeline'

export const RISK_FROM_LABEL: Record<RiskFrom, string> = {
  dynamics: '近期动态',
  controversies: '争议记录',
  quotes: '公开语录',
  timeline: '关键事件'
}

export interface RiskSignal {
  category: RiskCategory
  /** 命中的原词（界面按「出现『起诉』这类表述」措辞，不写「涉嫌」「疑似」） */
  keyword: string
  from: RiskFrom
  /** 素材原文（截断到 MAX_TEXT_CHARS） */
  text: string
  /** 出处：媒体名或依据（争议/语录没有 url，只能给依据文本） */
  source: string
  /** 原文链接，可点；无则空串 */
  url: string
  /** 该条目自带日期，无则空串 */
  date: string
}

export interface RiskScan {
  signals: RiskSignal[]
  /** 各类别命中条数（0 也给出，便于界面按类别展示分布） */
  byCategory: Record<RiskCategory, number>
  /** 收录到的条数（筛选前），用于「另有 N 条未列出」的诚实披露 */
  total: number
  /** 争议字段里没写回应的条数（素材里当事方没公开回应过是常态，这里只报事实） */
  unanswered: number
  /** 负面情绪条数与占比；无动态时为 null（区别于 0） */
  negative: number | null
  negativeShare: number | null
  /** 扫描过的条目数（口径说明：扫描了什么，读者才知道这张卡覆盖多大） */
  scanned: number
}

/**
 * 词表：全部是**可核对的事实类表述**，不含评价性词汇。
 *
 * 刻意不收「翻车 / 塌房 / 抵制 / 风波」这类：它们是评论者的判断，
 * 素材里出现也只能说明有人在评价，不能让平台借它给出「有风险」的暗示。
 * 同义词按「越具体越靠前」排列，命中取第一个（界面只展示一个原词，避免堆词）。
 */
export const RISK_TERMS: ReadonlyArray<{ word: string; category: RiskCategory }> = [
  { word: '偷税', category: 'tax' },
  { word: '逃税', category: 'tax' },
  { word: '漏税', category: 'tax' },
  { word: '补缴税款', category: 'tax' },
  { word: '税务稽查', category: 'tax' },
  { word: '起诉', category: 'judicial' },
  { word: '立案', category: 'judicial' },
  { word: '诉讼', category: 'judicial' },
  { word: '判决', category: 'judicial' },
  { word: '败诉', category: 'judicial' },
  { word: '庭审', category: 'judicial' },
  { word: '传唤', category: 'judicial' },
  { word: '拘留', category: 'judicial' },
  { word: '逮捕', category: 'judicial' },
  { word: '强制执行', category: 'judicial' },
  { word: '通报批评', category: 'judicial' },
  { word: '行政处罚', category: 'judicial' },
  { word: '罚款', category: 'judicial' },
  { word: '律师函', category: 'judicial' },
  { word: '调查', category: 'judicial' },
  { word: '解约', category: 'contract' },
  { word: '终止合作', category: 'contract' },
  { word: '停止合作', category: 'contract' },
  { word: '合作终止', category: 'contract' },
  { word: '代言取消', category: 'contract' },
  { word: '撤换', category: 'contract' },
  { word: '下架', category: 'contract' },
  { word: '索赔', category: 'contract' },
  { word: '违约', category: 'contract' },
  { word: '名誉权', category: 'rights' },
  { word: '肖像权', category: 'rights' },
  { word: '诽谤', category: 'rights' },
  { word: '造谣', category: 'rights' },
  { word: '侵权', category: 'rights' },
  { word: '维权', category: 'rights' },
  { word: '道歉', category: 'statement' },
  { word: '致歉', category: 'statement' },
  { word: '澄清', category: 'statement' },
  { word: '辟谣', category: 'statement' }
]

/**
 * 否定词：命中词前 NEG_WINDOW 个字符内出现即整条丢弃。
 *
 * 「未被起诉」「否认解约」这类表述在素材里很常见，按字面命中会全部变成假信号。
 * 这是一个**启发式**（不是语义理解），所以窗口取得小（6 字）—— 窗口一大就会把
 * 「团队否认，此前已被起诉」这种真有信号的长句一起吃掉。
 */
/* 导出以供一致性测试：云函数 riskWatch 复制了同一份词典与否定词表，
   test/cases/01-pure.js 会读云函数源码比对（见该用例），漂移会红 */
export const NEG_WORDS = ['未', '没', '无', '否认', '不实', '谣言', '造谣', '辟谣']
export const NEG_WINDOW = 6

/** 单条原文最多留这么多字：卡片是索引，不是全文阅读器 */
const MAX_TEXT_CHARS = 120
/** 最多列出这么多条，超出的在界面上如实说「另有 N 条」 */
export const MAX_SIGNALS = 12

interface ScannedItem {
  from: RiskFrom
  text: string
  source: string
  url: string
  date: string
}

/** 把报告四段素材摊平成可扫描的条目（每段给各自的出处字段） */
function collectItems(report: Report): ScannedItem[] {
  const items: ScannedItem[] = []

  for (const d of report.dynamics) {
    items.push({
      from: 'dynamics',
      text: `${d.title} ${d.summary}`,
      source: d.source,
      url: d.url,
      date: d.date
    })
  }
  for (const c of report.controversies ?? []) {
    /*
     * 争议段只有 basis（素材 url 或媒体名），没有独立的 url 字段 ——
     * 界面上这一条就点不动，只展示依据文本，不假装能给链接。
     */
    items.push({ from: 'controversies', text: `${c.topic} ${c.claim} ${c.response}`, source: c.basis, url: '', date: '' })
  }
  for (const q of report.quotes) {
    items.push({ from: 'quotes', text: `${q.text} ${q.context}`, source: q.source, url: '', date: '' })
  }
  for (const t of report.timeline) {
    items.push({ from: 'timeline', text: t.event, source: '', url: '', date: t.date })
  }

  return items
}

/** 字面命中：返回第一个未被否定的命中词，没有则 null */
function matchTerm(text: string): { word: string; category: RiskCategory } | null {
  for (const term of RISK_TERMS) {
    const at = text.indexOf(term.word)
    if (at < 0) continue
    const before = text.slice(Math.max(0, at - NEG_WINDOW), at)
    if (NEG_WORDS.some((n) => before.includes(n))) continue
    return term
  }
  return null
}

function clip(s: string): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}…` : t
}

/**
 * 扫描报告，产出风险信号清单。
 *
 * 排序：带日期的排前面（新的在前），无日期的按原始顺序跟在后面 ——
 * 时间线 / 动态自带日期，语录与争议没有，硬排序会把「日期都没有」的条目
 * 混进时间序列里，看起来像同一串事件（这是 utils/stats.ts 反复踩过的坑）。
 */
export function buildRiskSignals(report: Report): RiskScan {
  const items = collectItems(report)
  const byCategory = { judicial: 0, tax: 0, contract: 0, rights: 0, statement: 0 } as Record<RiskCategory, number>

  const hits: Array<RiskSignal & { dated: boolean }> = []
  for (const item of items) {
    const hit = matchTerm(item.text)
    if (!hit) continue
    byCategory[hit.category]++
    hits.push({
      category: hit.category,
      keyword: hit.word,
      from: item.from,
      text: clip(item.text),
      source: item.source,
      url: item.url,
      date: item.date,
      dated: /^\d{4}-\d{2}/.test(item.date)
    })
  }

  const dated = hits.filter((h) => h.dated).sort((a, b) => b.date.localeCompare(a.date))
  const undated = hits.filter((h) => !h.dated)
  const ordered = [...dated, ...undated].slice(0, MAX_SIGNALS)

  const total = report.dynamics.length
  const negative = total > 0 ? report.dynamics.filter((d) => d.sentiment === 'negative').length : null

  return {
    signals: ordered.map(({ dated: _dated, ...rest }) => rest),
    byCategory,
    total: hits.length,
    unanswered: (report.controversies ?? []).filter((c) => (c.response || '').trim() === '').length,
    negative,
    negativeShare: negative !== null && total > 0 ? negative / total : null,
    scanned: items.length
  }
}
