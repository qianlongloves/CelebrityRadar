import {
  buildOpinionGroups,
  compareOpinionOrder,
  credibilityOf,
  isOfficialSource,
  normalizeTitle
} from './opinion-rank'
import type {
  CredTier,
  ImpactLevel,
  OpinionBlock,
  OpinionEntry,
  OpinionInput,
  ResponseNeed,
  TimeBasis
} from './opinion-rank'
import type { RiskCategory } from './risk'

/**
 * 舆情事件聚合与时间线归因（P3，2026-10-13）——把「同一件事的多条来源」聚成**一个事件**，
 * 并给出按时间正序的**时间线**（谁在何时说了什么、进展到哪一步）。
 *
 * ## 为什么放在端上、且必须是纯函数
 *
 * 舆情页三块数据本来就是端上已经取到的（`follows` + `cache#getFeedDetails`、`weekly`、
 * `keyword-alert`、`risk-watch`），所以聚类**零上游成本、可单测、可回滚**；而落库共享要额外
 * 论证「唯一对象成本」与跨会话一致性。故这里只做端上纯函数：不碰任何网络 / storage / 云函数，
 * 输入输出都是普通对象，**对任何输入都不抛错**（脏数据跳过该条）。
 *
 * ## 怎么复用 P1，避免两处判断漂移
 *
 * 事件的「是不是同一件事」与「排序顺序」**不另写一套规则**，直接复用 `utils/opinion-rank.ts`：
 *   · 标题归一 `normalizeTitle`（去空白标点、转小写）——事件标题选取用；
 *   · 同事件判据 `sameEvent`（完全相同 / 长标题互相包含 / 长公共前缀）——分组用；
 *   · 分组本身走 `buildOpinionGroups`（它是 P1 去重内部那一步的对外投影，与 `buildOpinionQueue`
 *     **共用同一份实现**，于是「排序认为是一条」与「时间线分成几条」永远一致）；
 *   · 分级推导 `credibilityOf`（整组去重来源）与排序口径 `compareOpinionOrder` 同样复用。
 *
 * ## 合规红线（改本文件前先读，与产品硬要求同等重要）
 *
 *   1. **涉政涉军仍是拒答**：本层只对**已经过上游过滤**的存量条目做聚类与归因，
 *      **不新增任何内容来源、不放开 / 不新增任何拦截**。
 *   2. **每条时间线条目必须带来源与时间**：无来源的条目**不进时间线**、也**不用来支撑
 *      「是否需回应」的判断**（只影响 `memberCount` 与「可能的最大影响面」）。来源缺失时
 *      用「来源未标注」显式标出，**绝不编一个来源**。
 *   3. **聚合 ≠ 认定**：事件标题与时间线只做「多条报道的归拢」，**不得**把多条报道写成
 *      「已证实」。可信度最高一级也只有「官方通报」（来源是官方渠道的公开通报），刻意不使用
 *      「已确认」这种会被读成「平台已核实事实」的措辞（与 opinion-rank.ts 文件头红线 3 同）。
 *      页面在事件卡上保留一句克制的轻量说明（见 pages/opinion/index.tsx）。
 *   4. **不混口径、区分来源性质**：时间线每条都带 `nature`（官方通报 / 媒体报道 / 来源未标注），
 *      避免把小道消息与官方通报混成一条而不加区分。
 *
 * ## 几个聚合规则的取舍
 *
 *   · **影响面取成员里最高**（不做平均）：影响面回答的是「这件事**可能**造成多大冲击」，
 *     是上界。「一件事只要有一个高风险维度，就整体按高风险对待」比平均更安全 —— 平均会把
 *     单条高风险稀释掉，让用户漏看，这和 P2「只拦新增、不删存量」的保守取向是同一种取舍。
 *   · **可信度按整组去重来源重算**：与 P1 的 `credibilityOf` 同一函数、同一口径，同事件的
 *     多个来源才算「多方报道」，不因为聚类而虚增。
 *   · **是否需回应取成员里最严的一档**：任一成员「建议回应」→ 整体建议回应；否则任一「建议关注」
 *     → 建议关注；否则任一「无需回应」→ 无需回应；否则未知。且只认**带来源**的成员（红线 2）。
 */

/* ─────────────────────────── 类型 ─────────────────────────── */

/**
 * 来源性质：按**发布渠道像不像官方**粗分（启发式，不是对内容真实性的核实）。
 * 与 `credibilityOf` 不同 —— 那条算的是「有几个来源 / 有没有官方渠道」，这条只回答
 * 「这一条来自什么性质的渠道」，供时间线逐条标注，避免把传闻与官方通报混为一条。
 */
export type SourceNature = 'official' | 'media' | 'unknown'

export const SOURCE_NATURE_LABEL: Record<SourceNature, string> = {
  official: '官方通报',
  media: '媒体报道',
  unknown: '来源未标注'
}

/**
 * 时间口径的展示措辞（见 TimeBasis）。
 *
 * **刻意只有 'seen' 有词、'published' 留空**：媒体发布时间是常态、不需要额外解释；
 * 只有「这个时间其实是**我们**第一次扫到它的时刻」才必须提醒读者，否则「我们 10-16 扫到
 * 一条 10-10 的旧报道」会被读成「10-16 又有新进展」。两个口径都标一遍反而像还有第三种东西。
 */
export const TIME_BASIS_LABEL: Record<TimeBasis, string> = {
  published: '',
  seen: '发现于'
}

/** 时间线上的一条：时间 + 来源 + 来源性质 + 一句话发生了什么（+ 谁） */
export interface TimelineItem {
  /** 时间串（原始字段，展示时再格式化） */
  date: string
  /** 来源（展示层用「来源未标注」兜底，这里只会是带来源的条目） */
  source: string
  /** 来源性质（官方通报 / 媒体报道 / 来源未标注） */
  nature: SourceNature
  /** 一句话发生了什么（取成员标题） */
  text: string
  block: OpinionBlock
  /** 这条归属于哪个「我盯的人 / 词」（都缺时为空串） */
  label: string
  /**
   * 时间口径（见 TimeBasis）：'seen' = 这是我们**第一次扫到**它的时刻、不是媒体发布时间，
   * 展示层据此写成「发现于」。缺失（老数据 / 绝大多数来源）按媒体发布时间看待。
   * 只对**需要提醒读者**的那一种加标记，不给每条都挂一个无意义字段。
   */
  timeBasis?: TimeBasis
}

/** 事件的一个成员条目（保留各自来源、时间、来源性质与判断） */
export interface OpinionEventMember {
  block: OpinionBlock
  title: string
  summary: string
  source: string
  date: string
  nature: SourceNature
  label: string
  impact: ImpactLevel
  response: ResponseNeed
  category?: RiskCategory
  level?: ImpactLevel
  /** 时间口径（见 TimeBasis）；缺失表示按媒体发布时间看待 */
  timeBasis?: TimeBasis
}

/** 聚合后的一个事件 */
export interface OpinionEvent {
  id: string
  /**
   * 稳定主题键（P4 落库，2026-10-13）——`eventKeyOf(objectKey, themeToken)` 的结果。
   * 端上用它作为「已读 / 跟进」状态的主键；云函数把它作为落库事件的 `_id`。
   * 规则见 themeTokenOf / objectKeyOf / eventKeyOf 的注释（**不能**用 `id`：`id` 是排序序号，
   * 成员一变就换号）。
   */
  key: string
  /** 对象键：事件归属的「谁 / 什么词」（取成员里出现最多的非空 label；都没有则空串） */
  objectKey: string
  /** 主块：取自排序代表（点击跳转 / 归属以它为准） */
  block: OpinionBlock
  /** 事件标题（从成员里选最合适的一条，规则见 pickEventTitle） */
  title: string
  /** 成员条目列表（含无来源者） */
  members: OpinionEventMember[]
  /** 保留在事件里的成员数（**恒等于 `members.length`**；云端可能已按 MAX_MEMBERS 截断过） */
  memberCount: number
  /**
   * 去重后的**真实**来源条数（≥ `memberCount`）。
   *
   * 事件卡上的「N 条来源」必须报这个：云端为控制单文档体积会把成员截到 30 条，
   * 若拿 `memberCount` 当来源数，一场有 80 篇报道的爆点事件会显示成「30 条来源」—— 那是假数字。
   * 端上本端聚类不截断成员，故这里恒等于 `memberCount`（两端字段同名同义，见 opinion-store）。
   */
  memberTotal: number
  /** 时间线：带来源且时间可解析的成员，按时间正序（红线 2） */
  timeline: TimelineItem[]
  /** 整组去重来源 */
  sources: string[]
  /** 事件级「谁」：成员归属去重（人名 / 关键词） */
  labels: string[]
  impact: ImpactLevel
  credibility: CredTier
  response: ResponseNeed
  hitsKeyword: boolean
  hitsFollow: boolean
  /** 最近一次活动的时间（排序 / 展示用；不可解析则为空串） */
  date: string
}

/* ─────────────────────────── 聚合常数 ─────────────────────────── */

/** 影响面强度（取最高用）：高 > 中 > 低 > 未评级 */
const IMPACT_RANK: Record<ImpactLevel, number> = { high: 3, mid: 2, low: 1, unknown: 0 }
/** 需回应严格度（取最严用）：建议回应 > 建议关注 > 无需回应 > 未知 */
const RESPONSE_STRICT: Record<ResponseNeed, number> = { respond: 3, watch: 2, none: 1, unknown: 0 }
/** 来源性质权威度（事件标题选取的次级排序用）：官方 > 媒体 > 未标注 */
const NATURE_RANK: Record<SourceNature, number> = { official: 2, media: 1, unknown: 0 }

/* ─────────────────────────── 基础工具 ─────────────────────────── */

function asText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** 解析时间串为毫秒；不可解析返回 null（用于「时间线上必须带时间」的过滤 + 正序排序） */
function parseMs(date: unknown): number | null {
  const s = asText(date)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** 时间排序权重：不可解析按最旧算（垫底） */
function dateRank(date: unknown): number {
  const ms = parseMs(date)
  return ms === null ? Number.NEGATIVE_INFINITY : ms
}

/** 来源性质：启发式，只看来源名里是否含官方标识词（复用 opinion-rank 的 isOfficialSource） */
export function sourceNatureOf(source: unknown): SourceNature {
  const s = asText(source)
  if (!s) return 'unknown'
  return isOfficialSource(s) ? 'official' : 'media'
}

/* ═══════════════ 事件身份：稳定主题键（P4 落库，2026-10-13）═══════════════ */

/**
 * ## 为什么需要「稳定主题键」
 *
 * 端上原来的 `id`（`event#0`、`event#1`…）只是**排序序号**：成员集合一变、排序一变就换号。
 * 一旦把它作为「用户已读 / 跟进」状态的主键，用户上次标过的已读下次就找不到对应事件了
 * —— 落库共享就白做了。故这里另设一把**跨会话、跨端稳定**的键 `event_key`。
 *
 * ## 生成规则（端云逐字同源，见下方各函数；云函数 opinionCluster 复制同一份）
 *
 *   `event_key = hashOf(objectKey + '#' + themeToken)`  （FNV-1a 32 位，十六进制）
 *
 *   · **对象键 `objectKey`** —— 事件归属的「谁 / 什么词」：取成员里出现次数最多的非空
 *     `label`（人名或关键词），并列时取字典序最小者（保证与成员顺序无关、可复现）。
 *     都没有 label 时为空串。把对象键掺进哈希，是为了让「不同人的同名报道」天然落在不同键上。
 *   · **主题核心词 `themeToken`** —— 见 `themeTokenOf`：取**日期最早**的那条成员的**归一化标题**。
 *     挑最早者而不是「最长 / 出现最多」，正是为了**稳定**（见下）。
 *
 * ## 硬要求：同一事件后续新增报道时，`event_key` 必须保持不变
 *
 * 只靠「按当前成员现算」做不到这一点（feed_cache 会被刷新、旧报道会被挤掉，最早那条可能消失）。
 * 两道保底一起用：
 *   1. **锚定最早报道**（本文件）：`themeTokenOf` 只认「日期最早」的那条 —— 后续新增的报道
 *      日期都不早于它，故**只加新报道（不回溯补更早的）时键天然不变**（用例已覆盖）；
 *   2. **沿用已落库的键**（云函数侧）：新一轮聚类若与某条**已存在事件**判为同一事件
 *      （成员标题两两 `sameEvent`），就**沿用它的 `event_key`**、只合并成员 / 重算时间线，
 *      绝不重新生成 —— 这样即便最早那条被缓存挤掉、或主题词漂移，用户的已读/跟进也不会丢。
 *
 * ## 冲突处理
 *
 *   · **同一件事被拆成两个键**：`sameEvent` 判据刻意保守（宁可少合并），若两篇报道的措辞
 *     够不着门槛就会分成两个事件、各持一键 —— 这是可接受的（顶多多一条），且当后续出现一条
 *     能把两者桥接起来的报道时，第 2 条保底会把它们并回同一条。**绝不为了合并而放宽判据**
 *     （并错会直接丢信息且用户无从察觉）。
 *   · **两件事撞同一个键**：理论上不同主题词 → 不同键；但哈希是 32 位、存在碰撞可能。
 *     云函数落库时若发现候选键已被一条**判为不同事件**的已存在事件占用，就依次尝试
 *     `键-2`、`键-3`… 直到找到一个空位或能判为同一事件的位置（见 opinionCluster 注释）。
 */

/** 归一化标题 → 稳定短哈希（FNV-1a 32 位；与 cloudfunctions/riskWatch 的 hashOf 同一算法） */
function hashOf(text: string): string {
  let h = 0x811c9dc5
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 锚点比较：日期更早者优先；同日（或都不可解析）取归一化标题字典序更小者（可复现） */
function anchorBetter(a: { title?: string; date?: string }, b: { title?: string; date?: string }): boolean {
  const am = parseMs(a && a.date)
  const bm = parseMs(b && b.date)
  /* 有日期的永远优先于无日期的（无日期者不参与锚定，避免它把主题词带偏） */
  if ((am === null) !== (bm === null)) return am !== null
  if (am !== null && bm !== null && am !== bm) return am < bm
  return normalizeTitle(String((a && a.title) || '')) < normalizeTitle(String((b && b.title) || ''))
}

/**
 * 主题核心词：成员里**日期最早**那条的归一化标题（同日取字典序更小者）。
 *
 * 为什么是「最早」而不是「最长 / 出现最多」：后者会随成员变化而变（后来一条更长的标题就改写了主题词），
 * 键也随之漂移；「最早」在「只往后加新报道」的前提下是**不变量**（新报道的日期不早于既有最早者）。
 */
export function themeTokenOf(members: unknown): string {
  const list = (Array.isArray(members) ? members : []).filter(
    (m): m is { title?: string; date?: string } => !!m && typeof m === 'object' && !!asText((m as { title?: unknown }).title)
  )
  if (!list.length) return ''
  let best = list[0]
  for (const m of list) if (anchorBetter(m, best)) best = m
  return normalizeTitle(String(best.title || ''))
}

/**
 * 对象键：成员里出现最多的非空 `label`（人名 / 关键词）；并列取字典序最小者（顺序无关、可复现）。
 * 都没有 label 时返回空串（此类事件只靠主题词区分）。
 */
export function objectKeyOf(members: unknown): string {
  const counts = new Map<string, number>()
  for (const m of Array.isArray(members) ? members : []) {
    const label = asText(m && (m as { label?: unknown }).label)
    if (label) counts.set(label, (counts.get(label) || 0) + 1)
  }
  let best = ''
  let bestN = 0
  for (const label of [...counts.keys()].sort()) {
    const n = counts.get(label) || 0
    if (n > bestN) {
      best = label
      bestN = n
    }
  }
  return best
}

/** 事件稳定键：`hashOf(objectKey#themeToken)`。空对象键 + 空主题词 → 稳定空键（几乎不会出现：无标题条目不产出事件） */
export function eventKeyOf(objectKey: string, themeToken: string): string {
  return hashOf(`${asText(objectKey)}#${asText(themeToken)}`)
}

/**
 * 是不是一个合法的 `event_key`（路由参数门禁，纯函数）。
 *
 * 形态：`hashOf` 产出的 **8 位十六进制**；云函数撞键时会在末尾加 `-2`、`-3`… 后缀
 * （见文件头「冲突处理」），故一并接受 `-N`。用途：事件时间线页从路由参数拿到的
 * `eventKey` 必须是这个形态，否则直接给空态、**不发起任何读库 / 聚类**（参数缺失 / 被篡改同理）。
 */
export function isValidEventKey(key: unknown): boolean {
  return typeof key === 'string' && /^[0-9a-f]{8}(-\d+)?$/.test(key)
}

/* ─────────────────────────── 事件标题选取 ─────────────────────────── */

/**
 * 事件标题选取规则（从成员条目里挑最合适的一条，不用模型改写、不新造标题）：
 *   1. **只从带来源的成员里选**（无来源的标题不可追溯，不作为事件的门面）；
 *      若全体都无来源，则退回全体成员（不因缺来源就没有标题）；
 *   2. 归一后**最长**的标题优先 —— 同事件里更长的标题信息更全
 *      （如「【重磅】关于X的声明」优于「关于X的声明」）；
 *   3. 长度相同 → 来源性质更权威者优先（官方 > 媒体 > 未标注）；
 *   4. 再相同 → 时间更新者优先；
 *   5. 仍相同 → 保持先出现者（稳定，不因同分抖动）。
 */
function titleBetter(a: OpinionEntry, b: OpinionEntry): boolean {
  const la = normalizeTitle(a.title).length
  const lb = normalizeTitle(b.title).length
  if (la !== lb) return la > lb
  const na = NATURE_RANK[sourceNatureOf(a.source)]
  const nb = NATURE_RANK[sourceNatureOf(b.source)]
  if (na !== nb) return na > nb
  const da = dateRank(a.date)
  const db = dateRank(b.date)
  return da > db
}

function pickEventTitle(members: OpinionEntry[]): string {
  const withSource = members.filter((m) => !!asText(m.source))
  const pool = withSource.length > 0 ? withSource : members
  let best = pool[0]
  for (const m of pool) if (titleBetter(m, best)) best = m
  return best.title
}

/* ─────────────────────────── 组装 ─────────────────────────── */

function toMember(e: OpinionEntry): OpinionEventMember {
  const member: OpinionEventMember = {
    block: e.block,
    title: e.title,
    summary: e.summary,
    source: e.source,
    date: e.date,
    nature: sourceNatureOf(e.source),
    label: e.label,
    impact: e.impact,
    response: e.response,
    category: e.category,
    level: e.level
  }
  /* 只在确有口径时才加键（见 TimeBasis 注释） */
  if (e.timeBasis) member.timeBasis = e.timeBasis
  return member
}

/**
 * 事件聚合（纯函数，对任何输入都不抛错）：把 `buildOpinionGroups` 的每个同事件分组
 * 压成一个 `OpinionEvent`，再按 P1 的排序口径（compareOpinionOrder）排出展示顺序。
 *
 * 分组、脏数据过滤、判断字段全部复用 P1；本函数只负责「组 → 事件」的最后一步聚合。
 */
export function buildOpinionEvents(input: OpinionInput = {}): OpinionEvent[] {
  let groups: ReturnType<typeof buildOpinionGroups>
  /* 纯函数对任何输入都不抛：万一上游给了意外形状，退回空事件而不是白屏 */
  try {
    groups = buildOpinionGroups(input)
  } catch {
    return []
  }

  const events: OpinionEvent[] = []
  for (const g of groups) {
    const members = g.members
    if (!Array.isArray(members) || members.length === 0) continue /* 成员为空不产出事件 */

    /* 影响面：所有成员取最高 */
    let impact: ImpactLevel = 'unknown'
    for (const m of members) if (IMPACT_RANK[m.impact] > IMPACT_RANK[impact]) impact = m.impact

    /* 时间线 + 需回应：只认**带来源**的成员（红线 2）。
       无来源者仍计入 memberCount / 影响面，但不进时间线、也不支撑「是否需回应」。 */
    let response: ResponseNeed = 'unknown'
    let hitsKeyword = false
    let hitsFollow = false
    const dated: Array<{ m: OpinionEntry; ms: number; i: number }> = []
    members.forEach((m, i) => {
      if (m.hitsKeyword) hitsKeyword = true
      if (m.hitsFollow) hitsFollow = true
      if (!asText(m.source)) return
      if (RESPONSE_STRICT[m.response] > RESPONSE_STRICT[response]) response = m.response
      const ms = parseMs(m.date)
      if (ms !== null) dated.push({ m, ms, i })
    })
    /* 时间正序；同刻按入参顺序（稳定） */
    dated.sort((a, b) => a.ms - b.ms || a.i - b.i)

    const timeline: TimelineItem[] = dated.map(({ m }) => {
      const node: TimelineItem = {
        date: m.date,
        source: m.source,
        nature: sourceNatureOf(m.source),
        text: m.title,
        block: m.block,
        label: m.label
      }
      /* 时间口径随条目透出（'seen' → 展示层写「发现于」）：端上回落的输入里，
         风险信号用的是 first_seen_at（我们扫到的时刻），其余是媒体发布时间 */
      if (m.timeBasis) node.timeBasis = m.timeBasis
      return node
    })

    const labels = [...new Set(members.map((m) => m.label).filter(Boolean))]
    const latest = dated.length ? dated[dated.length - 1].m.date : ''
    const objectKey = objectKeyOf(members)

    events.push({
      id: '',
      /* 稳定主题键：端上「已读 / 跟进」用它做主键，云函数落库用它做 _id（规则见上方注释） */
      key: eventKeyOf(objectKey, themeTokenOf(members)),
      objectKey,
      block: g.representative.block,
      title: pickEventTitle(members),
      members: members.map(toMember),
      memberCount: members.length,
      /* 端上本端聚类不截断成员，故真实来源数恒等于成员数（云端那个可能更大，见 OpinionEvent.memberTotal） */
      memberTotal: members.length,
      timeline,
      sources: g.sources,
      labels,
      impact,
      credibility: credibilityOf(g.sources),
      response,
      hitsKeyword,
      hitsFollow,
      date: latest
    })
  }

  /* 排序复用 P1 口径：与我相关（监控词 > 关注的人）→ 影响面 → 需回应 → 时间新者优先。
     同分保持分组出现的先后（Array#sort 稳定）。 */
  events.sort(compareOpinionOrder)
  return events.map((e, i) => ({ ...e, id: `event#${i}` }))
}
