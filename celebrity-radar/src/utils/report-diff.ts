/**
 * N-9：报告版本「改了什么」的对比（2026-10-16）。
 *
 * 为什么要有它：`report_versions` 把被覆盖掉的旧版留着（S3-1 ③），历史版本页也已经能把它们
 * **并排**列出来 —— 但「并排列出版本」只是把两坨文字摆在一起，没有告诉用户**它们之间的差别**；
 * 而这一页真正要回答的问题只有一个：**这次改了什么**（危机公关前后的口径变了吗、热度判断有没有反转）。
 * 它同时是 N-2（报告更新回访）的技术前置：没有 N-9，「有变化」这句话就没有证据。
 *
 * ── 方向（先说清，否则所有文案都会读反）────────────────────────────────
 * `buildReportDiff(prev, next)`：**prev 是旧的那一版、next 是更新的一版**，产物回答的是
 * 「从 prev 变成 next，多了 / 少了什么」；页面上把 next 称作**新版**。
 * 时间戳若传反了本模块会按 `generatedAt` 自己摆正（同 `report-versions.ts#buildVersionList`
 * 自己再排一次序：不依赖调用方守规矩）—— 方向读反是这个视图唯一的灾难性错误。
 *
 * ── 只比「能稳定判同」的东西（本模块最核心的一条口径）──────────────────
 *   ① **条数**（数组长度）：每一节都比，且**与措辞无关** —— 模型再怎么改写都不改变条数；
 *   ② **具名条目**（新增 / 消失）：**只对键取自素材原样字段的节**开（动态的 url、时间线的
 *      日期|事件、档案的 label、关系的对方姓名、合作的品牌名、术语本身）。
 *      键若来自模型措辞（争议的议题、会员段的争点），逐字比对会**稳定地误报「全变了」**
 *      （同一个意思换个说法 = 一条新增 + 一条消失）—— 与 `package/report/index.tsx#computeDiff`
 *      拒绝按标题相似度判同是同一条理由。这类节只给条数，不给条目清单。
 *   ③ **叙述段给「旧 → 新」对照**（各自截断后并列）。这一条**故意**与 computeDiff 相反：
 *      那边刻意不看措辞（怕误报「全是新的」），而本视图存在的理由恰恰是「口径变了吗」——
 *      判断类字段的正文差异正是它要回答的东西。并列而不是只标一句「已改写」：
 *      只说「变了」等于逼用户自己去两版之间翻两遍。
 *
 * ── 三条不许越过的线 ──────────────────────────────────────────────────
 *   · **不做评价**：只说多了几条、少了哪条，绝不说哪一版更好 / 更准
 *     （同 `utils/workbench.ts` 的对比表：平台一旦替用户排序，他看到的就不是自己的判断了）。
 *   · **null 与 0 分开**：`null` = 这一版根本没有这一段（老报告没这个键 / 免费档不生成会员段），
 *     `0` = 有这一段、里面是空的。混成一个数，会把「当时还没向模型要这一段」说成「这一版是空的」。
 *   · **不新造第二条过滤口径**：本模块只比**调用方交来的**两份 Report。旧版正文必须经
 *     `utils/report-versions.ts#loadVersionReport`（内部走 `cache.ts#exposeReport`）取 ——
 *     拿未过滤的旧版来比，等于把会员段并排列给免费读者看（那条不变式的正题）。
 *
 * ⚠ 会员段的另一个易读错处：会员节**有没有内容**还取决于**那一版生成时是不是会员档刷新的**
 *   （免费档压根不请求那几段，见 utils/report.ts 的 MEMBER_HINT_REALTIME）。故某会员节某一侧
 *   为 `null` 时置 `memberUncertain` 并给一条 caveat，免得被读成「这次改动删掉了会员段」。
 *
 * ⚠ 节的 id / label / 档位 / 顺序**全部取自 `REPORT_TEMPLATE`**（一份真源），本文件只回答
 *   「这一节怎么比」。故模板增删一节时必须同步补 `SECTION_SPEC`
 *   —— 由 test/cases/64-report-diff.js 的「没有孤儿键、也没有漏掉的节」钉住。
 */

import { REPORT_TEMPLATE, type TocTier } from './report-toc'
import { RELATION_LABEL } from './report-export'
import { clipText, cleanText } from './text'
import type { Report } from './report'

/** 条目级差异一次最多列几条（超出并如实报总数，不静默丢 —— 同 S3-3「不许静默截断」） */
export const DIFF_ITEM_MAX = 4

/** 叙述对照每侧显示多少字（这一页是「看差异」，不是全文阅读器；全文在报告页） */
export const DIFF_PROSE_MAX = 46

/** 条目短文案截断长度（胶囊里的一行字） */
const ITEM_TEXT_MAX = 30

export interface DiffItem {
  /** 判同用的键（同键 = 同一条） */
  key: string
  /** 展示用短文案（已截断） */
  text: string
}

/** 一个方向上的差异条目；`hidden` = 超出 `DIFF_ITEM_MAX` 被折叠起来的条数 */
export interface DiffBucket {
  items: DiffItem[]
  hidden: number
  total: number
}

/** 一个模板节的差异（条数 + 可列时的条目清单） */
export interface DiffSectionRow {
  id: string
  label: string
  /** 档位（取自模板）：会员节的「有无」还受生成时的身份影响，见文件头 ⚠ */
  tier: TocTier
  /** 旧版这一节的条数；`null` = 旧版没有这一段（不是空段） */
  prevCount: number | null
  /** 新版这一节的条数；`null` = 新版没有这一段 */
  nextCount: number | null
  /** next − prev；任一为 `null` 时也为 `null`（**不知道**，不是 0） */
  delta: number | null
  /** 能不能列到条目级（false = 键来自模型措辞，只给条数，见文件头 ②） */
  listed: boolean
  /** 新版有、旧版没有 */
  added: DiffBucket
  /** 旧版有、新版没有 */
  removed: DiffBucket
  changed: boolean
}

/** 一段叙述（判断类正文）的对照 */
export interface DiffProseRow {
  id: string
  label: string
  /** 旧版 / 新版各自的开头（已截断）；某一侧没有时是空串 */
  prev: string
  next: string
  changed: boolean
}

export interface ReportDiff {
  /** 旧版 / 新版的生成时间（方向已摆正：`prevAt` 一定不晚于 `nextAt`） */
  prevAt: string
  nextAt: string
  heatPrev: number | null
  heatNext: number | null
  /** 全部模板节（含没变的）；页面只渲染 `changedSections`，全量留给用例与以后的可能 */
  sections: DiffSectionRow[]
  prose: DiffProseRow[]
  changedSections: DiffSectionRow[]
  changedProse: DiffProseRow[]
  /** 新增 / 消失条目总数（**含被折叠的**：这是事实，不是「显示的条数」） */
  addedTotal: number
  removedTotal: number
  /** 其中一版是降级简版（条目少不代表内容被删） */
  degraded: boolean
  /** 有会员节在某一侧为空 —— 可能只是那一版不是会员档生成的 */
  memberUncertain: boolean
}

/* ══════════════════════════ 小工具 ══════════════════════════ */

const timeOf = (iso: string | undefined | null): number | null => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? t : null
}

/** 判同前先归一：空白折叠 + 去首尾 + 小写（大小写与空格差异不算「另一条」） */
const norm = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().toLowerCase() : '')

/** 数组长度；字段不存在（老报告 / 免费档的会员段）返回 `null`，空数组返回 0 */
const len = (x: readonly unknown[] | undefined | null): number | null => (Array.isArray(x) ? x.length : null)

/** 去掉空文案、按 key 去重（同一条只算一次），顺序保持入参 */
function collect(rows: DiffItem[]): DiffItem[] {
  const seen = new Set<string>()
  const out: DiffItem[] = []
  for (const it of rows) {
    if (!it.text || seen.has(it.key)) continue
    seen.add(it.key)
    out.push(it)
  }
  return out
}

/** 截断成页面要的桶：条目数收敛在渲染层，但**总数如实报出** */
function cap(items: DiffItem[]): DiffBucket {
  return {
    items: items.slice(0, DIFF_ITEM_MAX),
    hidden: Math.max(0, items.length - DIFF_ITEM_MAX),
    total: items.length
  }
}

/** 两个方向各自的条目差（`added` = 新版有、旧版没有） */
function diffBuckets(prevItems: DiffItem[], nextItems: DiffItem[]): { added: DiffBucket; removed: DiffBucket } {
  const p = new Set(prevItems.map((i) => i.key))
  const n = new Set(nextItems.map((i) => i.key))
  return {
    added: cap(nextItems.filter((i) => !p.has(i.key))),
    removed: cap(prevItems.filter((i) => !n.has(i.key)))
  }
}

/* ══════════════════════════ 每节怎么比 ══════════════════════════ */

interface SectionSpec {
  /** 这一节的「条数」；`null` = 这一节不是条目型（叙述段 / 端上派生段），条数不可比 */
  count: (r: Report) => number | null
  /** 条目清单（仅在 `listed` 为 true 时被调用） */
  items: (r: Report) => DiffItem[]
  /** 能否列「新增 / 消失」的条目：键来自模型措辞时必须为 false（见文件头 ②） */
  listed: boolean
}

/** 不是条目型的节（叙述段 / 端上派生的段）：只占位，好让「模板有几节、本表就有几条」成立 */
const NOT_LIST: SectionSpec = { count: () => null, items: () => [], listed: false }

/**
 * 模板 id → 怎么比。**键必须与 `REPORT_TEMPLATE` 一一对应**（用例钉住孤儿键与漏项）。
 *
 * 非条目型的节也在这里显式列出（值取 `NOT_LIST`）而不是省略：省略会让「新增一节忘了接对比」
 * 与「这一节本来就不该比」长得一模一样 —— 前者会让新节在差异视图里凭空消失。
 */
const SECTION_SPEC: Record<string, SectionSpec> = {
  /* 人物速览：比的不是条数而是**素材收录量**（coverage.items）——
     它答的是「这次多读了多少素材」，正是「变化大不大」的总量刻度 */
  'sec-overview': {
    count: (r) => (r.coverage && typeof r.coverage.items === 'number' ? r.coverage.items : null),
    items: () => [],
    listed: false
  },
  /* 简介 / AI 解读：叙述段，正文对照在 PROSE_SPEC 里 */
  'sec-intro': NOT_LIST,
  'sec-verdict': NOT_LIST,
  /* 人物档案：label 是模型的字段名（「出生地」这类），比 value 稳，故拿它判同 */
  'sec-profile': {
    count: (r) => len(r.profile),
    listed: true,
    items: (r) => (r.profile ?? []).map((p) => ({ key: norm(p.label), text: clipText(p.label, ITEM_TEXT_MAX) }))
  },
  /* 人物关系：对方姓名判同；类别只作展示（标签真源在 report-export，不在这里另抄一份） */
  'sec-relations': {
    count: (r) => len(r.relations),
    listed: true,
    items: (r) =>
      (r.relations ?? []).map((x) => ({
        key: norm(x.name),
        text: clipText(`${x.name}（${RELATION_LABEL[x.relation] || x.relation}）`, ITEM_TEXT_MAX)
      }))
  },
  /* 商业速览：整段由端上从素材汇总派生（utils/commercial.ts），条数无意义 —— 只占位 */
  'sec-commercial': NOT_LIST,
  /* 商业合作：品牌名判同（合作方是具名实体，不随措辞漂移） */
  'sec-endorsement': {
    count: (r) => len(r.endorsements),
    listed: true,
    items: (r) => (r.endorsements ?? []).map((e) => ({ key: norm(e.brand), text: clipText(e.brand, ITEM_TEXT_MAX) }))
  },
  /* 近期动态：url 是**素材原样字段**，判同最稳（同 package/report 的 computeDiff）；
     模型偶发不给 url 时退回标题 —— 至少不会把两条不同动态算成同一条 */
  'sec-dynamics': {
    count: (r) => len(r.dynamics),
    listed: true,
    items: (r) =>
      (r.dynamics ?? []).map((d) => ({
        key: norm(d.url) ? `u:${norm(d.url)}` : `t:${norm(d.title)}`,
        text: clipText(d.title || d.summary, ITEM_TEXT_MAX)
      }))
  },
  /* 经典名言：键就是那句话本身（从素材原样抄来，不是模型自撰的措辞） */
  'sec-quotes': {
    count: (r) => len(r.quotes),
    listed: true,
    items: (r) => (r.quotes ?? []).map((q) => ({ key: norm(q.text), text: clipText(q.text, ITEM_TEXT_MAX) }))
  },
  'sec-analysis': NOT_LIST,
  /* 争议与回应：键只有「议题」这个模型写的短句，逐条比会稳定误报 → 只给条数 */
  'sec-controversies': { count: (r) => len(r.controversies), items: () => [], listed: false },
  /* 风险雷达：整段由端上从风险信号派生（utils/risk.ts），条数无意义 —— 只占位 */
  'sec-risk': NOT_LIST,
  /* 会员专享：条目只数信源分歧（conflicts）；memberNotes 是叙述段，在 PROSE_SPEC 里对照。
     争点（topic）是模型措辞 → 不给条目清单 */
  'sec-member': { count: (r) => len(r.conflicts), items: () => [], listed: false },
  /* 同领域坐标 / 企业关联：具名对象判同 */
  'sec-peers': {
    count: (r) => len(r.peers),
    listed: true,
    items: (r) => (r.peers ?? []).map((p) => ({ key: norm(p.name), text: clipText(p.name, ITEM_TEXT_MAX) }))
  },
  'sec-affiliation': {
    count: (r) => len(r.affiliations),
    listed: true,
    items: (r) => (r.affiliations ?? []).map((a) => ({ key: norm(a.name), text: clipText(a.name, ITEM_TEXT_MAX) }))
  },
  /* 立场与舆情：话题名与态度都是模型写的短句 → 只给条数 */
  'sec-stance': { count: (r) => len(r.stance), items: () => [], listed: false },
  /* 时间线：`日期|事件` 判同（同 computeDiff；事件措辞会漂，故日期一起进键） */
  'sec-timeline': {
    count: (r) => len(r.timeline),
    listed: true,
    items: (r) =>
      (r.timeline ?? []).map((t) => ({
        key: `${norm(t.date)}|${norm(t.event)}`,
        text: clipText(`${t.date} ${t.event}`, ITEM_TEXT_MAX)
      }))
  },
  /* 名词解释：术语本身就是键 */
  'sec-glossary': {
    count: (r) => len(r.glossary),
    listed: true,
    items: (r) => (r.glossary ?? []).map((g) => ({ key: norm(g.term), text: clipText(g.term, ITEM_TEXT_MAX) }))
  }
}

/* ══════════════════════════ 叙述段怎么对照 ══════════════════════════ */

interface ProseSpec {
  id: string
  /**
   * 行标签。**抄自报告页的卡片正文与行标签**（简介 / 行业定位 / 支持方 / 反对方 / 对比视角…），
   * 理由同 report-export 的 RELATION_LABEL：同一份数据在两处叫法不同，用户会以为是两回事。
   * 它是**字段级**标签而非节标签（节标签仍取自 REPORT_TEMPLATE）。
   */
  label: string
  get: (r: Report) => string
}

/** 三段合成一条：它们同属「言行一致」这一件事，拆三行等于把同一处改动说三遍 */
const consistencyText = (r: Report): string =>
  [r.consistency?.claim, r.consistency?.act, r.consistency?.gap].filter((s) => !!s).join('｜')

/**
 * 判断与叙述类正文。`changed` 用**完整正文**比、展示才截断：
 * 截断后再比会漏掉「前 46 字一样、后面改了」这种改动，读成「没变」是最不该出现的一类误报。
 */
const PROSE_SPEC: ProseSpec[] = [
  { id: 'intro', label: '简介', get: (r) => r.intro },
  { id: 'verdict-summary', label: 'AI 解读 · 结论', get: (r) => r.verdict?.summary ?? '' },
  { id: 'verdict-positioning', label: '行业定位', get: (r) => r.verdict?.positioning ?? '' },
  { id: 'reputation-positive', label: '支持方', get: (r) => r.reputation?.positive ?? '' },
  { id: 'reputation-negative', label: '反对方', get: (r) => r.reputation?.negative ?? '' },
  { id: 'consistency', label: '言行一致', get: consistencyText },
  { id: 'analysis', label: 'AI 点评', get: (r) => r.analysis },
  { id: 'member-compare', label: '对比视角', get: (r) => r.memberNotes?.compare ?? '' },
  { id: 'member-risk', label: '风险提示', get: (r) => r.memberNotes?.risk ?? '' }
]

/* ══════════════════════════ 主函数 ══════════════════════════ */

/**
 * 比对两版报告，回答「从 prev 变成 next 改了什么」。
 *
 * 返回 `null` = **算不出来**（任一版缺失，或两份不是同一个人）—— 调用方按「不出对比」处理。
 * ⚠ 这里刻意不抛错、也不给半截结果：一份指向**另一个人**的差异比没有差异糟得多
 *   （`cache.ts#getCachedReport` 在 key 查不到时会按姓名回退到另一行，那正是这种情形）。
 */
export function buildReportDiff(
  prevIn: Report | null | undefined,
  nextIn: Report | null | undefined
): ReportDiff | null {
  if (!prevIn || !nextIn) return null
  /* 比错人的对比没有意义，宁可不出（写入侧也会校验 report.personKey 与行一致） */
  if (String(prevIn.personKey || '') !== String(nextIn.personKey || '')) return null

  /* 方向自己摆正：`prev` 必须是旧的那一版（时间戳解析不出来时保持调用方给的顺序） */
  const pt = timeOf(prevIn.generatedAt)
  const nt = timeOf(nextIn.generatedAt)
  const [prev, next] = pt !== null && nt !== null && nt < pt ? [nextIn, prevIn] : [prevIn, nextIn]

  const sections: DiffSectionRow[] = REPORT_TEMPLATE.map((sec) => {
    const spec: SectionSpec | undefined = SECTION_SPEC[sec.id]
    const prevCount = spec ? spec.count(prev) : null
    const nextCount = spec ? spec.count(next) : null
    const listed = !!spec?.listed
    const prevItems = spec && listed ? collect(spec.items(prev)) : []
    const nextItems = spec && listed ? collect(spec.items(next)) : []
    const { added, removed } = diffBuckets(prevItems, nextItems)
    return {
      id: sec.id,
      label: sec.label,
      tier: sec.tier,
      prevCount,
      nextCount,
      /* 只在这一节两侧**都有**条数时才算得出差值；一侧为 null = 不知道，不是 0 */
      delta: prevCount !== null && nextCount !== null ? nextCount - prevCount : null,
      listed,
      added,
      removed,
      /* `null !== 数字` 也算变化：「这一版没有这一段」与「有 3 条」之间确实是改动 */
      changed: prevCount !== nextCount || added.total > 0 || removed.total > 0
    }
  })

  const prose: DiffProseRow[] = PROSE_SPEC.map((p) => {
    const a = cleanText(p.get(prev))
    const b = cleanText(p.get(next))
    return {
      id: p.id,
      label: p.label,
      prev: clipText(a, DIFF_PROSE_MAX),
      next: clipText(b, DIFF_PROSE_MAX),
      changed: a !== b
    }
  })

  const changedSections = sections.filter((s) => s.changed)
  const changedProse = prose.filter((p) => p.changed)

  return {
    prevAt: prev.generatedAt,
    nextAt: next.generatedAt,
    heatPrev: typeof prev.heat === 'number' ? prev.heat : null,
    heatNext: typeof next.heat === 'number' ? next.heat : null,
    sections,
    prose,
    changedSections,
    changedProse,
    addedTotal: changedSections.reduce((n, s) => n + s.added.total, 0),
    removedTotal: changedSections.reduce((n, s) => n + s.removed.total, 0),
    degraded: !!prev.degraded || !!next.degraded,
    /* 会员节的一侧为空：可能只是那一版不是会员档生成（免费档不请求这几段） */
    memberUncertain: changedSections.some((s) => s.tier === 'member' && (s.prevCount === null || s.nextCount === null))
  }
}

/* ══════════════════════════ 文案（页面只渲染、不拼） ══════════════════════════ */

/** 条目差异与叙述差异都没有 = 这一版和更新的一版一模一样（极罕见，但必须说得出口） */
export function diffIsEmpty(diff: ReportDiff | null): boolean {
  return !diff || (diff.changedSections.length === 0 && diff.changedProse.length === 0)
}

/** 一句话总览。分别报「条目」与「叙述」两个数：它们对用户是两件事（事实 vs 口径） */
export function diffSummaryText(diff: ReportDiff | null): string {
  if (!diff) return ''
  const parts: string[] = []
  if (diff.changedSections.length > 0) parts.push(`${diff.changedSections.length} 节的条目有增减`)
  if (diff.changedProse.length > 0) parts.push(`${diff.changedProse.length} 段叙述内容不同`)
  return parts.length > 0 ? parts.join('，') : '条目与叙述都没有变化'
}

/** 热度对照（两版都有数值才给：缺一侧时留白，不拿 0 冒充「没热度」） */
export function diffHeatText(diff: ReportDiff | null): string {
  if (!diff || diff.heatPrev === null || diff.heatNext === null) return ''
  return diff.heatPrev === diff.heatNext
    ? `热度 ${diff.heatPrev}，没有变化`
    : `热度 ${diff.heatPrev} → ${diff.heatNext}`
}

/** 一节的条数对照。四种情形分开说，尤其**不把「这一段本来就没有」说成「0 条」** */
export function diffCountText(row: DiffSectionRow): string {
  const a = row.prevCount
  const b = row.nextCount
  if (a === null && b === null) return ''
  if (a === null) return `这一版没有这一段，新版 ${b} 条`
  if (b === null) return `这一版 ${a} 条，新版没有这一段`
  if (a === b) return `${a} 条，没有增减`
  return `${a} → ${b} 条`
}

/** 折叠提示（不是会员墙：这里只是这一页放不下，点开报告页能看全量） */
export function diffMoreText(hidden: number): string {
  return hidden > 0 ? `还有 ${hidden} 条` : ''
}

/**
 * 必须与差异一起说出口的前提（否则用户会从差异里读出不存在的变化）。
 * 返回空数组 = 没有前提要交代。
 */
export function diffCaveats(diff: ReportDiff | null): string[] {
  if (!diff) return []
  const out: string[] = []
  if (diff.degraded) {
    out.push('其中一版是降级简版（结构化失败时只留一段提示），条目少不代表内容被删掉。')
  }
  if (diff.memberUncertain) {
    out.push('会员专属段落的那一侧为空，也可能只是那一版生成时不是会员档（免费生成不请求这几段）。')
  }
  return out
}
