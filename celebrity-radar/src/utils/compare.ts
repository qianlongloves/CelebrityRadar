import { DOMAIN_META, DomainCode, parsePersonKey } from '@/config/domains'
import type { Report } from './report'
import { extractKeywords, KeywordItem } from './keywords'

/**
 * 两名人横向对比（M4-7，V2）—— 端上聚合实现。
 *
 * 与词云同一个理由：对比需要的是「把两份已落库报告摆在一起」，不需要语义推理。
 * 因此不新增报告 Schema 字段、不新增云函数、不消耗生成额度 —— 两个人的报告都是
 * 既有缓存的直接复用，进对比页只看缓存，缺哪份就明确提示去生成（由用户决定）。
 *
 * 一个刻意的克制：**不做优劣断言**。热度、报道量这类「曝光度」指标可以说谁高谁低，
 * 那是同一把尺子的读数；而「谁更成功 / 更受欢迎」不是这两份素材能支撑的结论，
 * 所以情绪结构、话题态度一律只并列展示，不给箭头、不给评语。
 */

/** 对比中的一方：全部字段都是已缓存报告的本地统计，不含任何新生成内容 */
export interface CompareSide {
  personKey: string
  name: string
  domain: DomainCode
  domainLabel: string
  generatedAt: string
  /** 降级报告（结构化失败后由纯文本兜底）：无动态 / 语录，对比表会标出来 */
  degraded: boolean
  /** 热度（§1.6 公式，0~100，同一把尺子，可直接比大小） */
  heat: number
  /** 检索窗口内报道素材数（= 热度公式的 N30）；老报告无 coverage 时为 null */
  newsCount: number | null
  /** 其中近 7 天的条数（= N7）；老报告无 coverage 时为 null */
  recentCount: number | null
  dynamics: number
  quotes: number
  timeline: number
  /** 情绪结构：dynamics[].sentiment 的本地计数 */
  sentiment: { positive: number; neutral: number; negative: number; total: number }
  /** 话题态度（老报告可能没有该字段） */
  stances: Array<{ topic: string; attitude: string; note: string }>
  /** 关键词云（复用 utils/keywords.ts，用于求「共同关注点」） */
  keywords: KeywordItem[]
}

/** 对照表的一行 */
export interface CompareMetric {
  key: string
  label: string
  /** 展示值（已格式化；数据缺失时为 '—'） */
  a: string
  b: string
  /**
   * 谁更高：仅「曝光度」类指标给方向（热度 / 报道量），
   * 条数类（动态 / 名言 / 履历）内容量取决于素材多少，多不代表好，一律为 null。
   */
  higher: 'a' | 'b' | null
  /** 口径说明（表下小字，避免指标沦为玄学数字） */
  hint?: string
}

/** 双方都提到的说法：横向对比里最有信息量的一格 */
export interface CommonTopic {
  word: string
  aCount: number
  bCount: number
}

export interface CompareResult {
  a: CompareSide
  b: CompareSide
  metrics: CompareMetric[]
  /** 双方都在讲的说法（关键词交集），按合计权重降序 */
  common: CommonTopic[]
  /** 只有 A / 只有 B 在讲的说法（各取前若干） */
  onlyA: KeywordItem[]
  onlyB: KeywordItem[]
}

/** 单侧独有的说法最多展示几个 */
const ONLY_LIMIT = 6
const COMMON_LIMIT = 6

function sideOf(report: Report): CompareSide {
  const parsed = parsePersonKey(report.personKey)
  const domain: DomainCode = parsed?.domain ?? 'other'
  const sentiment = { positive: 0, neutral: 0, negative: 0, total: report.dynamics.length }
  for (const d of report.dynamics) {
    if (d.sentiment === 'positive') sentiment.positive++
    else if (d.sentiment === 'negative') sentiment.negative++
    else sentiment.neutral++
  }
  return {
    personKey: report.personKey,
    name: report.name,
    domain,
    domainLabel: DOMAIN_META[domain]?.label ?? '其他',
    generatedAt: report.generatedAt,
    degraded: !!report.degraded,
    heat: report.heat,
    newsCount: report.coverage ? report.coverage.items : null,
    recentCount: report.coverage ? report.coverage.recent : null,
    dynamics: report.dynamics.length,
    quotes: report.quotes.length,
    timeline: report.timeline.length,
    sentiment,
    stances: (report.stance ?? []).map((s) => ({ topic: s.topic, attitude: s.attitude, note: s.note })),
    /* 对比口径：放宽素材命中数（跨人物交集稀疏）、收紧片段数（剔除标点截断的搭配） */
    keywords: extractKeywords(report, { limit: 24, minHits: 1, minRuns: 2 })
  }
}

/**
 * 两个说法是否指同一件事：完全相等或互为子串（「手机」与「旗舰手机」不该算两个主题）。
 *
 * 导出给主题知识库（utils/topic-digest.ts）复用 —— 「谁和谁是同一个话题」这件事
 * 必须全项目一个口径，否则对比页说两人有共同话题、主题页却说没有。
 */
export function sameTopic(x: string, y: string): boolean {
  return x === y || x.includes(y) || y.includes(x)
}

function pickCommon(sideA: CompareSide, sideB: CompareSide): {
  common: CommonTopic[]
  onlyA: KeywordItem[]
  onlyB: KeywordItem[]
} {
  const usedB = new Set<number>()
  const usedA = new Set<number>()
  const common: CommonTopic[] = []

  sideA.keywords.forEach((ka, ia) => {
    const ib = sideB.keywords.findIndex((kb, idx) => !usedB.has(idx) && sameTopic(ka.word, kb.word))
    if (ib >= 0) {
      usedA.add(ia)
      usedB.add(ib)
      /* 共同项统一取更短的那个说法：它更可能是双方共有的主题词本身，
         而不是某一方素材里的长搭配 */
      const kb = sideB.keywords[ib]
      common.push({
        word: ka.word.length <= kb.word.length ? ka.word : kb.word,
        aCount: ka.count,
        bCount: kb.count
      })
    }
  })

  /**
   * 独有词额外要一层「分量」筛选：宽松口径（minHits=1）是为了让交集能算出来，
   * 但单独摆出来的词若只被一条素材提过一次，就会是「发布」「持续爬坡」这类泛搭配。
   * 判据回到词云那一档 —— 至少两条素材讲过，或者是模型判定的话题。
   */
  const notable = (k: KeywordItem): boolean => k.count >= 2 || k.from === 'topic'

  common.sort((x, y) => y.aCount + y.bCount - (x.aCount + x.bCount))
  return {
    common: common.slice(0, COMMON_LIMIT),
    onlyA: sideA.keywords.filter((k, i) => !usedA.has(i) && notable(k)).slice(0, ONLY_LIMIT),
    onlyB: sideB.keywords.filter((k, i) => !usedB.has(i) && notable(k)).slice(0, ONLY_LIMIT)
  }
}

/**
 * 生成对比结果。纯函数：同一对报告必然得到同一结果，便于离线验证。
 */
export function buildComparison(a: Report, b: Report): CompareResult {
  const sideA = sideOf(a)
  const sideB = sideOf(b)

  const num = (v: number | null): string => (v === null ? '—' : String(v))
  const metrics: CompareMetric[] = [
    {
      key: 'heat',
      label: '热度',
      a: String(sideA.heat),
      b: String(sideB.heat),
      higher: sideA.heat === sideB.heat ? null : sideA.heat > sideB.heat ? 'a' : 'b',
      hint: '由近 30 天与近 7 天报道条数按固定公式算出（§1.6），同口径可直接比大小'
    },
    {
      key: 'news',
      label: '近 30 天报道',
      a: num(sideA.newsCount),
      b: num(sideB.newsCount),
      higher:
        sideA.newsCount === null || sideB.newsCount === null || sideA.newsCount === sideB.newsCount
          ? null
          : sideA.newsCount > sideB.newsCount
            ? 'a'
            : 'b',
      hint: '检索窗口内抓到的素材条数，即热度公式的输入本身'
    },
    {
      key: 'recent',
      label: '近 7 天报道',
      a: num(sideA.recentCount),
      b: num(sideB.recentCount),
      higher:
        sideA.recentCount === null ||
        sideB.recentCount === null ||
        sideA.recentCount === sideB.recentCount
          ? null
          : sideA.recentCount > sideB.recentCount
            ? 'a'
            : 'b',
      hint: '近期活跃度，热度公式里占四成权重'
    },
    { key: 'dynamics', label: '报告内动态', a: String(sideA.dynamics), b: String(sideB.dynamics), higher: null },
    { key: 'quotes', label: '收录言论', a: String(sideA.quotes), b: String(sideB.quotes), higher: null },
    { key: 'timeline', label: '履历节点', a: String(sideA.timeline), b: String(sideB.timeline), higher: null }
  ]

  const { common, onlyA, onlyB } = pickCommon(sideA, sideB)

  return { a: sideA, b: sideB, metrics, common, onlyA, onlyB }
}

/**
 * 一句话差异摘要 —— 只陈述可比出来的事实，不做「谁更成功」的判断。
 *
 * 热度差在 5 分以内视为接近：它由对数公式算出，几分之差在统计上就是噪声
 * （一条报道的出入即可造成），拿它宣布「谁更火」会误导人。
 */
export function describeComparison(result: CompareResult): string {
  const { a, b } = result
  const parts: string[] = []
  const gap = a.heat - b.heat

  if (Math.abs(gap) < 5) parts.push(`热度接近（${a.heat} : ${b.heat}）`)
  else parts.push(`${gap > 0 ? a.name : b.name} 的热度更靠前（${a.heat} : ${b.heat}）`)

  if (a.recentCount !== null && b.recentCount !== null && a.recentCount !== b.recentCount) {
    const more = a.recentCount > b.recentCount ? a : b
    parts.push(`近 7 天报道更密集的是 ${more.name}（${Math.max(a.recentCount, b.recentCount)} 篇）`)
  }

  if (result.common.length > 0) {
    parts.push(`共同被提及：${result.common.slice(0, 3).map((c) => c.word).join('、')}`)
  } else {
    parts.push('两份报告的报道主题没有明显重叠')
  }

  return parts.join('；')
}
