import { z } from 'zod'
import { NewsItem, heatValue } from './search'
import { FocusCode } from '@/config/filters'
import { chatJSON, chatText, ChatJSONResult } from './llm'
import { setCooldown } from './cooldown'
import { diagLog } from './cloud-diagnostics'

/**
 * AI 报告 Schema v2（§2.3）与生成/校验（附录 B）。
 * 不信任提示词：URL 白名单、来源标注、枚举值全部代码层强制。
 */

/**
 * 宽容字符串：类型不对（null / 数字 / 对象）时回落成空串，而不是让**整份报告**校验失败。
 *
 * 为什么值得单独写一个 helper：报告的契约是一个大对象 + 十个数组，而 zod 是「一处不合法、
 * 整份 parse 失败」。模型偶发的一个 `"summary": null`、`"profile": {}` 就是这么一处 ——
 * 它会让 chatJSON 两次都失败 → 整份降级成纯文本简版 → 用户看到「报告页一堆模块没了」，
 * 而日志里只有一句「输出未过校验」。一个字段的类型偏差，代价不该是整份报告。
 *
 * 故各字段一律「能读就读，读不了回落」：真正的值域把关交给 sanitizeReport
 * （它本来就在做去空、截断与出处白名单，且能容忍缺字段）。
 * .catch() 同时兜住「键缺失」与「类型错误」两种情况，因此不必再叠 .default()。
 */
const looseStr = (fallback = '') => z.string().catch(fallback)

const SentimentEnum = z.enum(['positive', 'neutral', 'negative'])

const DynamicSchema = z.object({
  date: looseStr(),
  title: looseStr(),
  summary: looseStr(),
  source: looseStr(),
  url: looseStr(),
  /* 枚举用 .catch 而不是 .default：模型写「正面」「Positive」时回落 neutral，
     而不是让整份报告在校验这一步直接失败（值域归一另有 normSentiment 一道） */
  sentiment: SentimentEnum.catch('neutral')
})

/**
 * 名言（本轮升级：背景 + 注解）。
 *
 * 原先只有 text / context 两个可读字段，context 里塞的是「出处场合/时间」——
 * 一句话孤零零摆在卡片上，用户既不知道它是在什么场合、什么背景下说的，也不知道该往哪核对。
 * 现在把「场合」与「含义」拆成三件互不重叠的事：
 *   · context —— 出处场合 / 时间（一行，永远展示）；
 *   · background —— 背景：说这句话的场合与前后事件，1~2 句（须出自素材）；
 *   · note —— 注解：这句话的含义 / 影响 / 争议，1~2 句（须出自素材，无则空串）。
 *
 * background / note 声明为 **optional**（而不是 default('')）是刻意的：报告是全局共享缓存，
 * 本轮之前落库的报告里根本没有这两个键，`.default('')` 会让类型系统谎称它们一定存在，
 * 从而掩盖「老缓存渲染时是 undefined」这个真实分支（同 Report.coverage 的处理）。
 * 新写入时由 sanitizeReport 统一归一成字符串。
 */
const QuoteSchema = z.object({
  text: looseStr(),
  context: looseStr(),
  background: z.string().optional().catch(undefined),
  note: z.string().optional().catch(undefined),
  source: looseStr('据公开资料')
})

const TimelineSchema = z.object({
  date: looseStr(),
  event: looseStr()
})

const SourceSchema = z.object({
  title: looseStr(),
  url: looseStr()
})

/**
 * 点评拆条（本轮升级）：把原先一段 200 字的 analysis 拆成 3~4 条**独立判断**，每条附「依据」。
 *
 * 为什么要拆：整段点评是模型最安全的选择 —— 四平八稳地把「风格 / 态度 / 热点」各说一句，
 * 不留破绽，但也读不出它到底读没读过素材。拆条之后每条都必须是一个具体判断，而 basis
 * 让「具体」变得可强制：模型必须指认这条判断出自哪篇素材（URL 原样复制），指不出来就只能写
 * 「据公开资料」—— sanitize 据此把依据换成媒体名，用户一眼能看出哪些判断真有出处。
 *
 * ⚠ basis 是 URL 的**引用位**，与 quotes.source 同一套白名单；落库前会被换成媒体名，
 * 页面上不出现裸 URL（见 sanitizeReport 的 sourceNameOf）。
 */
const AnalysisPointSchema = z.object({
  point: looseStr(),
  /** 素材 URL 原样复制；素材里找不到出处时写「据公开资料」 */
  basis: looseStr('据公开资料')
})

/** 话题态度倾向：比 sentiment 多一档「两极」—— 热点话题上的舆论常常是撕裂的，三值装不下 */
const StanceEnum = z.enum(['positive', 'neutral', 'negative', 'mixed'])

/**
 * 会员专属段落（O-11「质」权益第三步）：对比视角 + 风险提示。
 * （与之并列的「信源分歧」是本轮新增的会员段，结构不同故单列 ConflictSchema。）
 *
 * 它是**零上游成本**的那一项（不新增任何检索/调用，只在同一次生成的输出里多要两段文字），
 * 因此与 O-10 的模型分级一起构成本期就能交付的会员差异。
 * 两段都沿用报告的铁律「只基于素材」：无素材支撑时模型应给空串，sanitize 里空则整段不落库。
 */
const MemberNotesSchema = z.object({
  /** 与同领域其他公众人物的差异 / 相对位置 */
  compare: looseStr(),
  /** 近期需要留意的争议或风险（中性、就事论事） */
  risk: looseStr()
})
const StanceSchema = z.object({
  topic: looseStr(),
  attitude: StanceEnum.catch('neutral'),
  /** 一句话依据（自由文本，无法像 url 那样白名单校验，只在 sanitize 里收敛长度） */
  note: looseStr()
})

/**
 * 信源分歧（本轮新增，会员专享）：同一件事上两篇素材说法不一致时，把两边并排摆出来。
 *
 * 它是「专业分析」与「综述」的分水岭：综述会把互相矛盾的说法各自揉成一句中性话，
 * 读者什么也得不到；摆出来则让用户自己判断。而它对模型的要求反而更低 ——
 * 冲突是素材里的既有事实，模型只做归位、不做裁决，因此**不引入新的编造风险**。
 *
 * 与 memberNotes 同属「零上游成本」的会员差异（只在会员提示词里出现），故同样 optional。
 * a / b 必须都有值：只有一方在说话不叫分歧，由 sanitize 剔除（不是让模型硬凑对立面）。
 */
const ConflictSchema = z.object({
  /** 争点：两边不一致的那件事（12 字内） */
  topic: looseStr(),
  /** 一方说法（须含来源媒体名与具体内容） */
  a: looseStr(),
  /** 另一方说法（同上，与 a 相对） */
  b: looseStr()
})

/* ===== 第二批：结构化事实字段（人物档案 / 关系图谱 / 后续关注 / 名词解释 / 争议与回应） =====
 *
 * 这一批的共同点是**事实**而不是**判断**：它们回答 who（档案）、跟谁（关系）、
 * 接下来（后续关注）、什么意思（名词解释）、吵了什么（争议与回应）。
 * 与 analysisPoints / stance 那类模型判断不同，事实字段**没有出处就是编造** ——
 * 故除名词解释外全部强制带 basis（素材 url），由 sanitize 里的 strictSourceOf 卡死：
 * 编一个 url 出来不会得到一条假依据，而是让**整条被丢掉**。
 *
 * 名词解释刻意豁免出处要求：它解释的是「番位」「对赌」这类行话的通行含义（常识），
 * 不是关于本人的事实断言 —— 素材里不会有一段文字「定义」番位，硬要 basis 只会逼模型编。
 *
 * 五段全部进**免费**提示词（SYSTEM_REALTIME）：术语注解与近期争议对免费用户同样是核心信息
 * （见路线图「第二批」的注意栏），代价是每次生成多付这几段的 token，这是本批唯一的成本。
 * 老报告 JSON 里根本没有这些键，UI 一律整卡降级（同 Report.coverage 的处理）。
 */

/** 人物档案的一条：label(字段名) + value(值) + basis(素材 url，落库前换成媒体名) */
const ProfileItemSchema = z.object({
  label: looseStr(),
  value: looseStr(),
  /** 素材 url 原样复制。**这里没有「据公开资料」这个出口**：档案是事实，指不出出处就不该出现 */
  basis: looseStr()
})

/**
 * 关系类别：枚举而不是自由文本 —— 自由文本会让同一段关系在两次生成里叫「合作」「合作方」
 * 「合作伙伴」三个名字，UI 就再也给不出稳定标签。四档之外的一律归 other，不硬凑语义。
 */
const RelationKindEnum = z.enum(['cooperate', 'mentor', 'rival', 'other'])

const RelationSchema = z.object({
  /** 对方姓名 */
  name: looseStr(),
  /* 同上：模型写「合作」「亦师亦友」时回落 other（sanitize 的 normRelation 也会再归一一次），
     而不是让整份报告在这一条上直接失败 */
  relation: RelationKindEnum.catch('other'),
  /** 一句话说明这段关系；关系本身已由 relation 说清时可空串 */
  note: looseStr(),
  basis: looseStr()
})

/** 后续关注的一条：素材里**已公布**的时间点 + 事件 + 出处 */
const WatchItemSchema = z.object({
  when: looseStr(),
  what: looseStr(),
  basis: looseStr()
})

/**
 * 名词解释的一条：term + explain。**刻意不带 basis**（理由见本节顶部注释）——
 * 它豁免的只是「出处」，不豁免「只解释报告里确实出现的词」，后者由提示词约束。
 */
const GlossaryItemSchema = z.object({
  term: looseStr(),
  explain: looseStr()
})

/** 近期争议与回应的一条：争议点 + 争议内容 + 回应（可空串）+ 出处 */
const ControversySchema = z.object({
  topic: looseStr(),
  claim: looseStr(),
  /** 当事方 / 相关方的公开回应；素材里没有回应就空串，**不为凑格式编一句回应** */
  response: looseStr(),
  basis: looseStr()
})

/** LLM 输出契约（heat 由本地计算，不由模型给） */
const LlmReportSchema = z.union([
  z.object({ refused: z.literal(true) }),
  z.object({
    /* 这里刻意用 unknown 而不是 literal(false)：模型偶发写 "refused": "false" / 0 时，
       literal 两处都不匹配 → 整份报告校验失败 → 降级。判「是不是拒答」只需看它是否全等 true
       （见 isRefusedResult），值域校验不必要，也不必付整份报告的代价。 */
    refused: z.unknown().optional(),
    intro: looseStr(),
    dynamics: z.array(DynamicSchema).catch([]),
    quotes: z.array(QuoteSchema).catch([]),
    analysis: looseStr(),
    /* 点评拆条（本轮）：新提示词只请求它，analysis 由 sanitize 从各条拼出来。
       analysis 仍保留在契约里 —— 降级简版路径（SYSTEM_FALLBACK）产出的就是一整段文字，
       两条路共用同一个渲染出口（见 pages/report/index.tsx）。 */
    analysisPoints: z.array(AnalysisPointSchema).catch([]),
    stance: z.array(StanceSchema).catch([]),
    timeline: z.array(TimelineSchema).catch([]),
    sources: z.array(SourceSchema).catch([]),
    /* 会员专属段落（O-11）：只有会员的提示词里会出现它，免费报告恒为 undefined。
       必须在 schema 里声明 —— zod 的非严格对象会把未声明的键**静默丢弃**。 */
    memberNotes: MemberNotesSchema.optional().catch(undefined),
    /* 信源分歧（本轮，会员专享）：同上，不声明就等于白要（会被 zod 静默丢掉） */
    conflicts: z.array(ConflictSchema).optional().catch(undefined),
    /* 第二批（免费可见）：五段结构化事实字段，随 SYSTEM_REALTIME 一起要。
       同样必须先声明 —— zod 的非严格对象会把未声明的键静默丢弃。
       一律 .catch([]) 而不是 .default([])：模型把它们写成对象 / 字符串时也只是这一段为空，
       不该让整份报告在校验这一步失败（.catch 同时兜住键缺失，故不必再叠 .default）。 */
    profile: z.array(ProfileItemSchema).catch([]),
    relations: z.array(RelationSchema).catch([]),
    watchlist: z.array(WatchItemSchema).catch([]),
    glossary: z.array(GlossaryItemSchema).catch([]),
    controversies: z.array(ControversySchema).catch([])
  })
])

export type LlmReport = z.infer<typeof LlmReportSchema> & { refused?: boolean }

/** 拒答结果的显式类型守卫（联合窄化用） */
export function isRefusedResult(x: unknown): x is { refused: true } {
  const refused = typeof x === 'object' && x !== null ? (x as { refused?: unknown }).refused : undefined
  /* 兼收字符串 'true'：schema 里 refused 是宽容字段（见 LlmReportSchema 的注释），模型写成
     "refused": "true" 时不该被当成「没有拒答」—— 那会让一份本该拒答的报告变成一堆空卡片 */
  return refused === true || refused === 'true'
}

/** 一条点评：判断本身 + 依据（媒体名，或「据公开资料」） */
export interface AnalysisPoint {
  point: string
  basis: string
}

/** 一条信源分歧：争点 + 两边说法 */
export interface Conflict {
  topic: string
  a: string
  b: string
}

/** sanitizeReport 的输入形态（宽松：字段可能缺失，内部归一） */
export interface LlmReportFields {
  intro?: string
  dynamics?: Array<{ date?: string; title?: string; summary?: string; source?: string; url: string; sentiment?: string }>
  quotes?: Array<{ text: string; context?: string; background?: string; note?: string; source?: string }>
  analysis?: string
  analysisPoints?: Array<{ point?: string; basis?: string }>
  stance?: Array<{ topic?: string; attitude?: string; note?: string }>
  timeline?: Array<{ date?: string; event?: string }>
  sources?: Array<{ title?: string; url: string }>
  memberNotes?: { compare?: string; risk?: string }
  conflicts?: Array<{ topic?: string; a?: string; b?: string }>
  /* 第二批（免费可见）：宽松形态，字段可能缺失或非字符串，由 sanitize 内部归一 */
  profile?: Array<{ label?: string; value?: string; basis?: string }>
  relations?: Array<{ name?: string; relation?: string; note?: string; basis?: string }>
  watchlist?: Array<{ when?: string; what?: string; basis?: string }>
  glossary?: Array<{ term?: string; explain?: string }>
  controversies?: Array<{ topic?: string; claim?: string; response?: string; basis?: string }>
}

/** 完整报告（落库/渲染形态，§2.3 Schema v2） */
export interface Report {
  personKey: string
  name: string
  mode: 'realtime'
  generatedAt: string
  heat: number
  intro: string
  dynamics: Array<z.infer<typeof DynamicSchema>>
  quotes: Array<z.infer<typeof QuoteSchema>>
  analysis: string
  /**
   * 点评拆条（本轮升级）：3~4 条「判断 + 依据」。
   *
   * 可选 —— 改动前落库的老报告没有这个字段，UI 必须回落成 analysis 整段（见报告页渲染处）；
   * 有它时 analysis 也**仍有值**（sanitize 把各条拼成一段）：报告问答把 analysis 当作
   * 「模型的整体判断」喂进上下文（utils/qa.ts），拆条不能让它断供。
   */
  analysisPoints?: AnalysisPoint[]
  /**
   * 话题态度（M4-4 剩余项）：对 2~4 个近期热点话题的舆论倾向判断。
   * 可选 —— 改动前落库的老报告没有这个字段，UI 无该字段时只呈现情绪走向条。
   */
  stance?: Array<z.infer<typeof StanceSchema>>
  timeline: Array<z.infer<typeof TimelineSchema>>
  sources: Array<z.infer<typeof SourceSchema>>
  /**
   * 会员专属段落（O-11）：对比视角 + 风险提示。可选 —— 免费报告没有这个字段。
   *
   * ⚠ 有字段 ≠ 能看：报告是全局共享缓存，会员生成的那一份免费用户也会读到，
   * 故 UI 必须**同时**判会员态（见 pages/report/index.tsx 的渲染处）。
   * 与 conflicts 是两个独立可缺的字段（老会员报告只有这一段），UI 要各自判空。
   */
  memberNotes?: { compare: string; risk: string }
  /**
   * 信源分歧（本轮新增，会员专享）：素材之间互相矛盾的说法，最多 3 条。
   *
   * 与 memberNotes 同一套闸门：只在会员提示词里请求、免费报告恒无此字段，
   * 但报告是全局共享缓存，**UI 同样必须再判一次会员态**（两者在报告页共用一张卡）。
   */
  conflicts?: Conflict[]
  /**
   * 第二批（免费可见）：结构化人物档案 —— 一眼看清 who 的锚点，替代把身份信息全塞在
   * intro 那段散文里。每条都带 basis（媒体名），故每条都能回到一篇素材去核对。
   * 可选 —— 改动前落库的老报告没有这个键，UI 整卡不出。
   */
  profile?: Array<z.infer<typeof ProfileItemSchema>>
  /**
   * 第二批（免费可见）：关系图谱（合作者 / 师承 / 对手 / 其他）。
   * 关系必须明确写在素材里，不得由「同框」「同公司」推测 —— 出处不是真素材的条目不会落库。
   */
  relations?: Array<z.infer<typeof RelationSchema>>
  /** 第二批（免费可见）：后续关注 —— 素材里已公布的时间点 / 事件，把报告从「回顾」变成「可跟踪」 */
  watchlist?: Array<z.infer<typeof WatchItemSchema>>
  /** 第二批（免费可见）：名词解释 —— 报告里出现的行话与背景词（唯一不带出处的字段，理由见 Schema 注释） */
  glossary?: Array<z.infer<typeof GlossaryItemSchema>>
  /**
   * 第二批（免费可见）：近期争议与回应。刻意与会员段的 memberNotes.risk 分成两件事 ——
   * 这里记的是**已发生**的争议与公开回应（事实），risk 是**面向未来**的风险提示（判断）。
   */
  controversies?: Array<z.infer<typeof ControversySchema>>
  disclaimer: string
  /** 生成时的关注侧重（发现页「关注」筛选，'all' = 六段完整） */
  focus?: FocusCode
  /** 降级标记：结构化生成失败后由纯文本降级产出（§5.4 用例 9），UI 呈现降级提示 */
  degraded?: true
  /** 报道画像（博查素材的原样聚合，见 ReportCoverage）：改动前落库的老报告没有这个字段 */
  coverage?: ReportCoverage
}

/**
 * 报道画像：博查返回的素材聚合，全部字段原样统计、不经模型改写，因此可以当事实读。
 *
 * 存在的理由：报告页最显眼的数字是热度，而 §1.6 的公式（N30 占六成、N7 占四成）
 * 用户完全看不见 —— 热度因此成了一个无法验证的玄学数字。这里把公式的两个输入
 * 和素材本身的时间边界摆出来：热度可解释，素材覆盖哪一段时间也可核对。
 */
export interface ReportCoverage {
  /**
   * 检索窗口内博查返回的素材条数（**原样**，不截断）。
   * 注意：它是事实，不参与比较 —— 热度公式的 N30 另有一道上限（见 HEAT_COUNT_CAP），
   * 故深度模式（O-11）下它会比热度实际用到的条数多，两者刻意不必相等。
   */
  items: number
  /** 其中发布于最近 7 天的条数（同一口径：原样统计） */
  recent: number
  /** 素材发布时间的最早 / 最新（全都没有可解析日期时为 null） */
  firstAt: string | null
  latestAt: string | null
  /** 最新一条素材（标题 / 媒体 / 链接均为博查原值）：速览卡的「最新报道」一行用它 */
  latest?: { title: string; source: string; url: string }
}

export const DISCLAIMER = '内容由 AI 基于公开网络信息生成，仅供参考，不代表本平台立场。'

const SYSTEM_REALTIME = [
  '你是名人动态分析师。基于提供的真实新闻素材，为指定名人生成一份结构化报告。',
  '硬约束：',
  /*
   * 出处（basis）的写法单列一条前置，因为它出现在五处字段里，而原先的说法（「必须从素材 url
   * 原样复制」）在实践中太难做到：模型抄长 URL 的走形率很高，一旦差一个字符，整条事实就会在
   * sanitize 里被判成「无出处」而消失 —— 用户看到的就是「报告少了一块」。
   * 故把口径放宽到「抄不准就写媒体名」，与 sanitizeReport 的三层出处匹配（归一化 URL →
   * 媒体名 → 标题）严格对齐：提示词要求的，正是校验会放行的。唯一不放宽的是来源本身 ——
   * 必须是本次素材里出现过的，不得写素材之外的来源，也不得自己拼链接。
   */
  '出处（basis）写法：优先直接复制素材里的 url（整串照抄，不要改写、不要省略）。若那串字符太长、记不准，写该素材的媒体名（如「新华社」）同样算指认出处。两者都必须来自本次素材。',
  '1. 仅基于素材作答，不编造日期与来源。',
  '2. dynamics 每条字段：date(YYYY-MM-DD)、title、summary(一句摘要)、source(来源媒体名)、url(必须从素材 URL 原样复制)、sentiment(只能是 positive/neutral/negative)。',
  '3. quotes 每条字段：text(名言原文)、context(出处场合/时间)、background(背景：这句话是在什么场合、什么背景下说的，1~2 句，须出自素材)、note(注解：这句话的含义 / 影响 / 争议，1~2 句，须出自素材，没有可说的就填空串)、source(素材 URL 或「据公开资料」)；background 与 note 合计不超过 100 字。',
  '4. sources 列出全部用到的素材：title + url(原样复制)。',
  '5. analysisPoints：3~4 条各自独立的判断，每条字段：point(一句完整的判断，40 字内，以句号结尾)、basis(这条判断依据的素材 url，原样复制；素材里找不到出处的写「据公开资料」)。判断必须具体到人、事、时间或具体说法，禁止「风格独特」「备受关注」「引发讨论」这类换个人名也成立的套话；各条之间不要互相重复。',
  '6. stance：2~4 个近期热点话题上的舆论态度，每条字段：topic(话题名，12 字内)、attitude(只能是 positive/neutral/negative/mixed)、note(一句话依据，须出自素材)；素材里确实没有任何可判断的舆论态度才留空数组。',
  '7. timeline：素材中可确认的关键事件(date + event)；素材里确实没有可确认的事件才留空数组。',
  '8. profile：结构化人物档案 3~6 条（尽量给到 5 条），用来让人一眼看清「是谁」，每条字段：label(字段名，8 字内，如「职业」「出生年份」「代表作」「主要成就」)、value(40 字内)、basis(这条事实出自的素材，写法见开头「出处（basis）写法」)。**每条都必须能在素材里找到依据，找不到的整条不要写**；不要用常识去补全素材里没有的信息（那是编造，不是补充）。',
  '9. relations：与本人有公开关系的人，最多 5 条，每条字段：name(对方姓名)、relation(只能是 cooperate/mentor/rival/other，依次表示合作、师承、对手、其他)、note(一句话说明这段关系，说不清就填空串)、basis(关系出自的素材，写法见开头)。关系必须是素材里**明确写到**的（同台合作、师徒、公开竞争等），不得由「同框」「同公司」「同时出现」推测；只有单方提及也不写。',
  '10. watchlist：未来值得跟踪的时间点或事件，只写素材里**已公布**的，最多 4 条，每条字段：when(已公布的时间，如 2026-11 或「下月」，12 字内)、what(事件，40 字内)、basis(素材，写法见开头)。素材里确实没有公布任何时间点才留空数组（不得推测档期）。',
  '11. glossary：本报告或素材里出现、普通读者可能不懂的行话或背景词（如文娱「番位」、财经「对赌」），最多 5 条，每条字段：term(词，10 字内)、explain(一句话解释，50 字内)。只解释确实出现过的词（确实没有这类词才留空数组）；解释用该词的通行含义即可（这一条答的是词义，不是关于本人的事实），不做褒贬评价。',
  '12. controversies：近期公开争议与各方的回应，最多 3 条，每条字段：topic(争议点，12 字内)、claim(争议内容，60 字内)、response(当事方或相关方的公开回应，40 字内；素材里没有公开回应就填空串)、basis(素材，写法见开头)。只写素材里确实存在的争议，只陈述、不评价、不裁决。',
  '13. 若素材显示该人物属政治、军事类敏感人物，仅返回 {"refused": true}。',
  /*
   * 「写满」这条是补上去的，它对应一类此前没被当成问题的失败：模板里每段都留了「素材不足
   * 则留空」的口子，而模型对这类口子的利用程度远超预期 —— 它会把「省事」读成「素材不足」，
   * 于是某些段整段为空。报告页对空段是不出卡的（见 index.tsx），用户看到的便是**整块卡片
   * 直接消失**，观感上就是「报告不全，会员免费都一样」。
   * 故这里把两个概念的边界写死：先尽力找，确实没有才留空；同时把第 1 条再钉一遍，
   * 免得这句被读成鼓励注水。
   */
  '14. 除「素材里确实没有」之外，**每一段都要给出内容**（dynamics / quotes / analysisPoints / stance / timeline / sources / profile / relations / watchlist / glossary / controversies 都算）：先尽力在素材里找，确实找不到才留空数组。不许因为条数不好凑、懒得逐一核对就返回空数组 —— 用户看到的是一整块卡片直接消失，比少一条信息严重得多；但也不得为凑数编造（第 1 条）。',
  '15. 只输出 JSON，格式：{"intro":string,"dynamics":[],"quotes":[],"analysisPoints":[],"stance":[],"timeline":[],"sources":[],"profile":[],"relations":[],"watchlist":[],"glossary":[],"controversies":[]}'
].join('\n')

/**
 * 会员专属段落的补充提示（O-11）：**只追加在会员的 system 末尾**，免费提示词逐字节不变
 * （不给免费用户白付这两段的 token，也避免免费报告的 JSON 里出现空字段）。
 * 与 FOCUS_HINT_REALTIME 同一写法：补充要求叠在 SYSTEM_REALTIME 之后，不另起一套提示词。
 */
const MEMBER_HINT_REALTIME = [
  '会员补充要求：额外输出 memberNotes 与 conflicts（**无素材支撑就留空**，不得为了凑数而编）。',
  'memberNotes 含两段文字：compare —— 该名人与同领域其他公众人物的差异或相对位置，2~3 句，比较对象须出自素材并写清是谁；risk —— **面向未来**的风险提示（接下来值得留意什么），措辞中性、就事论事、不做人身评价；**已经发生的争议与回应属于免费段 controversies，不要在这里复述**；无则填空串。',
  'conflicts：素材之间**互相矛盾**的地方（同一件事两边说法不一致、关键数字对不上、一方否认另一方的说法），最多 3 条，每条字段：topic(争点，12 字内)、a(一方说法，写清是哪家媒体、说了什么)、b(另一方说法，同 a)。两方都必须真实存在于素材中，不得自己想象一个对立面；素材里没有矛盾就留空数组。',
  '格式追加：{"memberNotes":{"compare":string,"risk":string},"conflicts":[{"topic":string,"a":string,"b":string}]}'
].join('\n')

/** 降级纯文本提示词（结构化 JSON 两次失败后，§5.4 用例 9） */
const SYSTEM_FALLBACK = [
  '你是名人动态分析师。结构化生成暂时不可用，请用不超过 150 字的纯文本，',
  '基于已有知识客观概述该名人的身份与近期公开动向要点。',
  '要求：不编造具体日期与来源；不输出 JSON；措辞中性；若不确定的信息直接略过。'
].join('\n')

/**
 * 单条素材正文上限。博查开 summary:true 返回的是详细摘要，个别条目能到数千字，
 * 不设限时单条就能吃掉整个预算、把其余素材全挤掉。
 */
const MAX_ITEM_CHARS = 1000

/**
 * user 消息整体上限，取两级约束的小值再留余量：
 *   云函数侧 MAX_CHAT_CHARS = 24000（超了返回 badrequest「提示词过长」）；
 *   callFunction 链路侧官方建议大字段不超过 100KB（中文 UTF-8 3 字节/字，15000 字 ≈ 45KB）。
 * 15000 字叠加 system 提示词（约 600 字）后两端都不贴边。
 * 起因：素材不裁剪时请求体可超链路建议上限，callFunction 直接抛错，
 * 再被 chatViaPlatform 的 catch 合并成「平台通道未就绪」，表现为「配好了却生成失败」。
 */
const MAX_USER_CHARS = 15000

/**
 * 会员深度模式的 user 消息预算（O-11）：深度检索会多拿一倍素材，
 * 沿用 15000 字会把加厚的那部分**直接截掉**（等于花了检索钱却没用上）。
 * 放宽到 20000 后两级约束仍不贴边：
 *   云函数 MAX_CHAT_CHARS = 24000（本函数产出的 user + system 约 600 字，余量 3400）；
 *   callFunction 链路建议 100KB（20000 中文字 ≈ 60KB）。
 */
const MAX_USER_CHARS_MEMBER = 20000

/**
 * 会员专属段落的长度上限（O-11）：与 stance 的 note（60 字）同属「自由文本只能收敛长度」的一段，
 * 但它是 2~3 句的完整判断，60 字装不下，故单列一档。
 */
const MEMBER_NOTE_CHARS = 240

/**
 * 名言背景 / 注解的单段长度上限（本轮新增两段）。
 * 与 stance.note（60 字，一条判断依据）不同档：这里是 1~2 句的完整背景或含义，
 * 但又不能长成 memberNotes 那样的一段话 —— 名言卡本身已经很密，两段各 120 字是它的上限。
 * 与其它自由文本一样：没有可白名单的锚点，只能在 sanitize 里收敛长度。
 */
const QUOTE_NOTE_CHARS = 120

/**
 * 单条点评的长度上限（本轮新增）：与 stance.note（60 字）同档，都是一句话的判断。
 * 上限存在的意义是自己约束自己 —— 一条判断长到 120 字，它就不再是「一条判断」，
 * 而是又变回了被拆掉的那种整段综述。
 */
const ANALYSIS_POINT_CHARS = 80

/** 点评条数上限：再多就不再是点评，而是又一篇综述 */
const ANALYSIS_POINT_MAX = 4

/** 争点的长度上限（12 字内的短语，超出说明模型把「说法」写进了「争点」） */
const CONFLICT_TOPIC_CHARS = 24

/** 单侧说法的长度上限：要能装下一句完整的陈述（谁 + 说了什么），故比 stance.note 宽 */
const CONFLICT_SIDE_CHARS = 100

/** 分歧条数上限：报告只摆最关键的几处，摆满一屏反而没了重点 */
const CONFLICT_MAX = 3

/* ----- 第二批（免费可见的五段事实字段）：长度与条数上限 -----
 *
 * 这几段的共同点是「一段一条事实」，故各档上限都贴着「一条事实说清楚」的尺度定，
 * 与 stance.note（60 字）、analysisPoints（80 字）同一套克制：数值不同只是体裁不同，
 * 依据都是「超过就不再是一条，而是又变回一段综述」。 */

/** 人物档案条数：档案是「一眼看清 who」，超过 6 条就不再是一眼 */
const PROFILE_MAX = 6
/** 字段名上限（「出生年份」四个字，够用且能左右对齐成一列） */
const PROFILE_LABEL_CHARS = 8
/** 字段值上限 */
const PROFILE_VALUE_CHARS = 40

/** 关系条数：人-人维度只摆最主要的几段关系 */
const RELATION_MAX = 5
/** 对方姓名上限（中文姓名 2~4 字，留出艺名 / 组合名的余量） */
const RELATION_NAME_CHARS = 20
/** 关系说明上限 */
const RELATION_NOTE_CHARS = 40

/** 后续关注条数 */
const WATCH_MAX = 4
/** 时间点上限（「2026-11」「下月」这类已公布的刻度，不是日期格式） */
const WATCH_WHEN_CHARS = 12
/** 事件上限 */
const WATCH_WHAT_CHARS = 40

/** 名词解释条数：行话注解只是阅读辅助，摆满一屏就成了词典 */
const GLOSSARY_MAX = 5
const GLOSSARY_TERM_CHARS = 10
const GLOSSARY_EXPLAIN_CHARS = 50

/** 争议条数 */
const CONTROVERSY_MAX = 3
const CONTROVERSY_TOPIC_CHARS = 12
const CONTROVERSY_CLAIM_CHARS = 60
/** 单侧回应的长度上限：装得下一句「XX 已回应……」，与 conflicts 的单侧说法同档 */
const CONTROVERSY_RESPONSE_CHARS = 40

/* ===== 素材 → 提示词的选取（本轮升级：事件归组 + 分级保留） ===== */

/**
 * 给全文的素材**事件**数上限（注意数的是事件，不是条数）。
 * 之外的条目压成一行「参考条目」。
 *
 * 为什么要数事件：同一件事常有多家媒体报道（URL 不同 → mergeNews 的 url 去重认不出），
 * 条数口径下「一件事 5 篇」会一口气吃掉 5 个全文名额。按事件计，一件事只占一个名额，
 * 该事件的其余报道自动降到压缩档。
 */
const FULL_ITEM_COUNT = 10

/**
 * 压缩条目的摘要片段长度。只够让模型判断「这条讲的是什么」，不足以据此展开叙述 ——
 * 这是刻意的：压缩条目在提示词里被明确标为「正文从略」，模型不该拿它当全文用。
 */
const BRIEF_ITEM_CHARS = 160

/** 同一事件的判定阈值：标题字符二元组的 Dice 系数（见 groupByEvent） */
const SAME_EVENT_RATIO = 0.62

/**
 * 「basis 写的是素材标题」这一层匹配的最短长度（归一化后的字符数）。
 * 要求足够长是因为这一层用的是「一方包含另一方」：短串（如「新剧开播」）会在一堆不相关的
 * 标题里误命中，而误命的代价是给一条编造的事实配上了一条真出处 —— 比少一条严重得多。
 */
const TITLE_MATCH_MIN_CHARS = 8

/**
 * 标题归一化：只留中英文与数字。
 * 丢掉标点、空格，以及「|」「-」「—」之后的站点尾巴 —— 同一件事的标题差异几乎全在这类
 * 装饰上，不归一化时两个「明显是同一件事」的标题会算出很低的相似度。
 */
function normalizeTitle(title: string): string {
  return title
    .split(/[|｜\-—_]/)[0]
    .replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, '')
    .trim()
}

/** 字符二元组集合。中文没有分词依赖，二元组是对措辞差异最稳的免依赖近似 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Dice 系数：2|A∩B| / (|A|+|B|)。对短标题比 Jaccard 宽容，不易把同一件事判成两件 */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return (2 * inter) / (a.size + b.size)
}

/**
 * 把素材按「是否在讲同一件事」归组，首条为组代表，其余进 rest。
 *
 * 刻意**只归组、不合并正文**：一是不同媒体的说法本身就是信息（谁先报、谁在转述），
 * 合并正文等于替模型做了取舍；二是相似度判定必然有误判（「新片开机」与「新片杀青」
 * 的标题字符重合度很高，但显然是两件事）。归组只在预算紧张时体现为压缩，
 * 即便误判也只是把一条压短，信息一条不丢 —— 这是这套启发式的安全边界。
 *
 * 修的是改造前的真实损耗：那时「装不下就整条丢弃」，深度模式（会员）多付的那一倍检索
 * 常常有一半落在预算外，等于花了检索钱却没进提示词。
 */
function groupByEvent(news: NewsItem[]): Array<{ lead: NewsItem; rest: NewsItem[] }> {
  const groups: Array<{ lead: NewsItem; rest: NewsItem[]; keys: Set<string> }> = []
  for (const n of news) {
    const keys = bigrams(normalizeTitle(n.title))
    const hit = groups.find((g) => dice(g.keys, keys) >= SAME_EVENT_RATIO)
    if (hit) hit.rest.push(n)
    else groups.push({ lead: n, rest: [], keys })
  }
  return groups.map(({ lead, rest }) => ({ lead, rest }))
}

/** 素材段落（全文）：标题 / 来源 / url 前置，正文随后 */
function fullItemText(n: NewsItem): string {
  const content =
    n.content.length > MAX_ITEM_CHARS ? `${n.content.slice(0, MAX_ITEM_CHARS)}…` : n.content
  return `- ${n.title}（${n.source}）${n.url}\n${content}`
}

/**
 * 素材段落（压缩）：标题 / 来源 / url 全部保留（引用与溯源不受影响），只把正文换成片段。
 * 「正文从略」四个字是给模型看的信号：这条的细节它并不掌握，不该据此展开叙述。
 */
function briefItemText(n: NewsItem): string {
  const flat = n.content.replace(/\s+/g, ' ')
  const snippet = flat.slice(0, BRIEF_ITEM_CHARS)
  return `- ${n.title}（${n.source}）${n.url}\n（正文从略）${snippet}${flat.length > BRIEF_ITEM_CHARS ? '…' : ''}`
}

/**
 * 素材 → user 消息（附录 B）。按「事件归组 → 分级保留」拼装，总额不超通道上限。
 *
 * 与改造前的差别只有一处，但很关键：装不下时**降级**（压缩正文）而不是**丢弃**整条。
 * 预算仍可能不够（素材极多时），那时丢的也只是已经压到 160 字的尾部条目 ——
 * 是「最不重要的东西少了细节」，而不是「一半素材根本没进提示词」。
 */
function buildUserMessage(
  name: string,
  news: NewsItem[],
  focus: FocusCode,
  member = false
): string {
  const budget = member ? MAX_USER_CHARS_MEMBER : MAX_USER_CHARS
  const head = [
    `名人：${name}`,
    `关注侧重：${focus === 'all' ? '综合（六段完整）' : FOCUS_LABEL[focus]}`,
    '素材：'
  ]

  /* 先分组分档、再按预算拼装：预算只在这一步起作用，避免边算边丢 */
  const full: string[] = []
  const brief: string[] = []
  groupByEvent(news).forEach((g, gi) => {
    /* 同一事件的其余报道一律压缩：它是重复信息，最该给别的事件让位 */
    g.rest.forEach((n) => brief.push(briefItemText(n)))
    if (gi < FULL_ITEM_COUNT) full.push(fullItemText(g.lead))
    else brief.push(briefItemText(g.lead))
  })

  const out = [...head]
  /* used 恒等于 join('\n') 之后的真实长度：每条多算一个换行符，因此判断时要把换行一起算进去 */
  let used = head.join('\n').length
  for (const line of full) {
    /* 首条无论如何保留：模型拿到空素材会凭空作答，比截断更糟（沿用改造前的兜底） */
    if (out.length > head.length && used + line.length + 1 > budget) break
    out.push(line)
    used += line.length + 1
  }
  let dropped = 0
  for (const line of brief) {
    if (used + line.length + 1 > budget) {
      dropped++
      continue
    }
    out.push(line)
    used += line.length + 1
  }
  if (dropped > 0) {
    /* 只看日志的 warn（不抛错）：报告仍然生成，只是尾部条目没进提示词 */
    diagLog('warn', 'db', `素材超预算，${dropped} 条压缩条目未进提示词（${name}）`)
  }
  return out.join('\n')
}

/* ===== 发现页「关注」筛选 → 生成侧重（§2.3 六段中的可聚焦段） ===== */

const FOCUS_LABEL: Record<FocusCode, string> = {
  all: '综合',
  dynamics: '近期动态',
  quotes: '言论观点',
  timeline: '经历履历'
}

/** 有素材时，按侧重调整各段篇幅 */
const FOCUS_HINT_REALTIME: Record<FocusCode, string> = {
  all: '',
  dynamics:
    '补充要求（优先满足）：本次用户侧重「近期动态」，dynamics 不少于 3 条且优先最新事件，summary 写足信息量；quotes 仍至少给 1 条 —— 可精简，但不得为空（空段落会让报告页整块卡片消失）。',
  quotes:
    '补充要求（优先满足）：本次用户侧重「言论观点」，quotes 不少于 3 条并写清 context 出处场合与 background 背景；dynamics 仍至少给 3 条且 date 与 url 齐全 —— 折线图与情绪走势都以 dynamics 为数据源，少于 3 条这两张卡会整块消失，侧重只该改变篇幅，不该让模块不见了。',
  timeline:
    '补充要求（优先满足）：本次用户侧重「经历履历」，timeline 尽量补全可确认的关键节点，analysisPoints 需串联其成长与职业脉络；dynamics 仍至少给 3 条且 date 与 url 齐全（折线图与情绪走势都以它为数据源）。'
}

/**
 * 生成报告（基于实时素材，无素材时由 utils/cache.ts 直接进引导态、不调用本函数）。
 * 只负责调 LLM + 校验；缓存互斥由 utils/cache.ts 负责。
 *
 * `opts.member`（O-11 深度模式）：决定「要不要多要两段会员专属文字」与 user 消息预算。
 * 会员态**由调用方传入**（cache.ts 已在配额检查那次读数里拿到），这里不再多读一次库。
 */
export async function buildReport(
  personKey: string,
  name: string,
  news: NewsItem[],
  focus: FocusCode = 'all',
  opts: { member?: boolean } = {}
): Promise<ChatJSONResult<Report | { refused: true }>> {
  const member = opts.member === true
  /* 补充要求按序叠加：侧重在先、会员专属在后（后者是本轮新加的一层，不覆盖既有取舍） */
  const hints = [FOCUS_HINT_REALTIME[focus], member ? MEMBER_HINT_REALTIME : ''].filter(
    (h) => h !== ''
  )
  const system = hints.length > 0 ? `${SYSTEM_REALTIME}\n${hints.join('\n')}` : SYSTEM_REALTIME
  const user = buildUserMessage(name, news, focus, member)

  const result = await chatJSON(system, user, LlmReportSchema)
  if (!result.ok) {
    /*
     * 冷却只拦「值得等待」的失败（随用随查原则）：
     *   - retryable（网络 / 上游 5xx）：等一会儿可能真就好了；
     *   - 429 限流（文案含「频繁」）：上游明确要求等。
     * 密钥无效 / 额度不足 / 通道未配置这类错误，用户修好配置或换通道后应立即可用，
     * 设冷却只会造成「修好了还要白等 10 分钟」的糟糕体验。
     */
    const rateLimited = /频繁|429/.test(result.error)
    if (result.retryable || rateLimited) setCooldown('llm')
    // 降级：纯文本简版（§5.4 用例 9），不再套结构化 Schema
    diagLog('warn', 'auth', `报告结构化生成失败，降级纯文本：${result.error}`)
    const fallback = await chatText(SYSTEM_FALLBACK, `名人：${name}`)
    if (fallback.ok) {
      return {
        ok: true,
        data: {
          personKey,
          name,
          mode: 'realtime',
          generatedAt: new Date().toISOString(),
          heat: 0,
          intro: '',
          dynamics: [],
          quotes: [],
          analysis: fallback.text,
          timeline: [],
          sources: [],
          disclaimer: DISCLAIMER,
          focus,
          degraded: true,
          /* 素材确实抓到了（才走到这里），只是结构化失败：画像照给，别让用户以为一条都没检索到 */
          coverage: buildCoverage(news)
        }
      }
    }
    return { ok: false, error: fallback.error }
  }

  if (isRefusedResult(result.data)) {
    diagLog('info', 'auth', `报告 LLM 拒答：${personKey}`)
    return { ok: true, data: { refused: true } }
  }

  /*
   * 这里必须显式断言一次：上面各个字段都用了 .catch() 做宽容兜底，而 zod 的 ZodCatch 为了让
   * 兜底能接住任何输入，把类型的 Input 拓宽成了 unknown —— 于是一个含 .catch() 的 object 在
   * TS 眼里会整体退化成「每个字段都是 unknown」，union 的输出类型也跟着糊掉。
   * 运行时形状由 zod 保证（出参就是 LLM 给的对象，字段只多不少），且 sanitizeReport 对每个
   * 字段都是防御式读取（?? ''），所以这条边界用一个显式断言收掉，比为了类型好看而放弃
   * .catch() 的运行时宽容更划算 —— 前者只是少一层类型检查，后者是「一个 null 让整份报告降级」。
   */
  const report = sanitizeReport(personKey, name, result.data as LlmReportFields, news, focus)
  return { ok: true, data: report }
}

/**
 * 带可解析发布时间、且落在最近 days 天内的素材条数。
 *
 * 热度公式的 N7 与画像里的 recent 必须是同一个口径：两处各写一份，
 * 迟早出现「热度说近 7 天 4 篇、速览说近 7 天 3 篇」这种自己打自己的情况。
 */
function countWithinDays(news: NewsItem[], days: number): number {
  const since = Date.now() - days * 24 * 3600 * 1000
  return news.filter((n) => {
    if (!n.publishedDate) return false
    const t = Date.parse(n.publishedDate)
    return Number.isFinite(t) && t >= since
  }).length
}

/**
 * 热度统计的素材口径上限（§1.6 的 N30），与 utils/search.ts 的免费档单路检索上限同值。
 *
 * 为什么要截断：热度是**跨档可比较**的量尺 —— `report_cache` 全局一份（会员生成的报告
 * 免费用户也会读到），热门榜的回落分支还直接按 `heat` 排序。而深度模式（O-11）会把
 * 一次生成的素材从 ~18 条加到 ~40 条：直接拿 40 去算，同一个人「被谁生成过」
 * 就会改变它的热度（log 量级上约 +10 点），榜单等于被档位污染。
 * 故统计一律截到 20：**素材加厚只改变报告正文的信息量，不改变任何可比较的数字**。
 * 免费报告到不了 20（主线 10 + 支线 8），因此这条截断对现有行为零影响。
 *
 * 注意：coverage（报道画像）仍按**原样素材**统计 —— 它是事实、不参与比较，
 * 两者在深度报告上会差一截，这是刻意的（见 ReportCoverage 的注释）。
 */
const HEAT_COUNT_CAP = 20

/** 博查素材 → 报道画像（纯统计，不引入任何模型判断） */
function buildCoverage(news: NewsItem[]): ReportCoverage {
  const dated = news
    .map((n) => ({ n, t: n.publishedDate ? Date.parse(n.publishedDate) : NaN }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t)
  const first = dated[0]
  const last = dated[dated.length - 1]
  return {
    items: news.length,
    recent: countWithinDays(news, 7),
    firstAt: first ? new Date(first.t).toISOString() : null,
    latestAt: last ? new Date(last.t).toISOString() : null,
    /* 无一条带发布时间时不给 latest：拿检索结果的首条冒充「最新」属于编造 */
    latest: last ? { title: last.n.title, source: last.n.source, url: last.n.url } : undefined
  }
}

/**
 * 出处索引：把模型给的 basis 映射回素材（见 matchNewsOf）。
 *
 * 为什么需要这一层，而不是一句 `urlSet.has(u)`：模型抄 URL 的走形率相当高 —— 末尾带上中文句号、
 * 被引号或书名号包住、多一个 / 少一个尾斜杠、http 与 https 混用、丢了 # 之后那段、写成 &amp;。
 * 原先是**逐字符全等**，上面任何一处走形都让这条彻底消失：页面上的表现不是「依据不准」，而是
 * **整条档案 / 关系 / 后续关注 / 争议凭空少一条，甚至整段卡片不出**，日志里只有一句
 * 「事实字段无有效出处，剔除 N 条」。素材明明是有的，只是那串字符没抄准 ——
 * 「不确定就不呈现」这条规矩不该被用在「明明确定、只是写法不同」上。
 *
 * 于是改成三层匹配：归一化 URL → 媒体名 → 标题。命中任一层都算指出处，
 * 而**返回值永远取自素材本身**（媒体名 / 素材原始 URL），所以编造一个出处依然过不来。
 */
interface SourceIndex {
  /** 归一化 URL → 素材 */
  byUrl: Map<string, NewsItem>
  /** 媒体名 → 该家的一条代表素材（长名在前：同时含「新华社」与「新华」时该命中更完整的那个） */
  media: Array<{ name: string; item: NewsItem }>
  /** 归一化标题 → 素材 */
  titles: Array<{ key: string; item: NewsItem }>
}

/**
 * URL 归一：把「同一篇文章的几种写法」收敛成一个键。
 * 顺序有意如此 —— 先剥装饰与尾随标点、去锚点与查询串，再统一协议与 www，最后去尾斜杠。
 * 查询串整体丢弃（它多是渠道 / 分享参数）；代价是「仅靠 ?id= 区分的两篇文章」会被视为同一篇，
 * 这在新闻站点里罕见，换来的是「模型抄来的链接只要指向同一篇，就一定认得出来」。
 */
function normalizeUrl(raw: string): string {
  return (raw ?? '')
    .trim()
    /* 包裹装饰与尾随标点：模型很爱写「（https://…）」『https://…』，或让句号落在链接后面 */
    .replace(/^[「『【（(<"“”'`]+/, '')
    .replace(/[」』】）)>"“”'`。,，;；、]+$/, '')
    .replace(/&amp;/gi, '&')
    .replace(/[#?].*$/, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** 建一次索引，本次 sanitize 的所有段落共用（素材最多几十条，逐条建一遍即可） */
function buildSourceIndex(news: NewsItem[]): SourceIndex {
  const byUrl = new Map<string, NewsItem>()
  const mediaFirst = new Map<string, NewsItem>()
  const titles: Array<{ key: string; item: NewsItem }> = []
  for (const n of news) {
    const key = normalizeUrl(n.url)
    if (key !== '' && !byUrl.has(key)) byUrl.set(key, n)
    /* 单字媒体名不参与匹配：它对不上任何有用信息，却极易在长文本里误命中 */
    if (n.source && n.source.length >= 2 && !mediaFirst.has(n.source)) mediaFirst.set(n.source, n)
    const t = normalizeTitle(n.title ?? '')
    if (t.length >= TITLE_MATCH_MIN_CHARS) titles.push({ key: t, item: n })
  }
  const media = [...mediaFirst.entries()]
    .map(([name, item]) => ({ name, item }))
    .sort((a, b) => b.name.length - a.name.length)
  return { byUrl, media, titles }
}

/**
 * basis → 素材。命中顺序：归一化 URL → 媒体名 → 标题；都不中返回 null
 * （调用方按各自体裁处理空返回值：判断类收敛成「据公开资料」，事实类整条剔除）。
 */
function matchNewsOf(basis: string | undefined, index: SourceIndex): NewsItem | null {
  const raw = (basis ?? '').trim()
  if (raw === '' || raw === '据公开资料') return null
  const byUrl = index.byUrl.get(normalizeUrl(raw))
  if (byUrl) return byUrl
  /*
   * raw 看起来就是个链接（带协议头或 www.）却没匹配上：那是模型自己拼的 / 指向站外，
   * 到此为止 —— 一串 URL 里恰好含某个媒体名（或标题）不等于出处成立，再往下试等于给
   * 编造的链接开一道门。只有「写成媒体名 / 标题」的 basis 才走下面两层。
   */
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^www\./i.test(raw)) return null
  const byMedia = index.media.find((m) => raw.includes(m.name))
  if (byMedia) return byMedia.item
  const t = normalizeTitle(raw)
  if (t.length >= TITLE_MATCH_MIN_CHARS) {
    const byTitle = index.titles.find((x) => x.key.includes(t) || t.includes(x.key))
    if (byTitle) return byTitle.item
  }
  return null
}

/**
 * 判断类字段（analysisPoints）的 basis → 展示用的媒体名；指不出出处时收敛成「据公开资料」。
 *
 * 为什么这里留了兜底出口：点评是**判断**，「据公开资料」是一句诚实的「我找不到出处」，
 * 判断本身仍有价值（页面上「依据：据公开资料」一眼就能看出这条没链接可点）。
 */
function sourceNameOf(basis: string | undefined, index: SourceIndex): string {
  return matchNewsOf(basis, index)?.source || '据公开资料'
}

/**
 * 事实字段（档案 / 关系 / 后续关注 / 争议）的 basis → 媒体名，**指不出出处时返回空串**
 * （调用方据此整条剔除）。
 *
 * 与 sourceNameOf 只差这一步，这一差分在两个字段的体裁上：档案 / 关系 / 后续关注 / 争议全是
 * **关于本人的事实**，没有出处就等于编造 —— 退化成「据公开资料」会让一条凭空生成的事实
 * 看起来像一条有据可查的事实。故这里不给兜底出口：模型编一个出处不会换来一条假来源，
 * 只会让这条被丢掉。顺带把「媒体名为空」也当作无出处（无名来源对读者等于没有依据）。
 */
function strictSourceOf(basis: string | undefined, index: SourceIndex): string {
  return matchNewsOf(basis, index)?.source || ''
}

/**
 * 代码层强制校验（附录 B，不信任提示词）：
 * 1. dynamics/sources 的 url 必须 ∈ 素材 url 集合，否则剔除
 * 2. quotes.source 为素材 url 或「据公开资料」，否则剔除
 * 3. heat 由 §1.6 公式本地计算；sentiment 已由 zod 枚举保证
 * 4. memberNotes 是会员专属段落，两段皆空则整段不落库（免费报告恒无此字段）
 * 5. analysisPoints 的 basis 同第 2 条（换成媒体名），空判断剔除、超 4 条截断；
 *    analysis 由各条拼出 —— 拆条不改变 analysis 这个字符串的存在性（问答上下文要用）
 * 6. conflicts 是会员专享段落，缺任一侧的条目剔除（只有一方在说话不叫分歧）
 * 7. 第二批（profile / relations / watchlist / controversies）：basis 必须是**真素材**，
 *    指不出出处就整条剔除（事实字段没有「据公开资料」这个出口，理由见 strictSourceOf）；
 *    各段另有条数与长度上限；**空数组也落库**（区别于「键不存在」= 这份报告没要过这段，
 *    见返回值处的注释）。glossary 是唯一的例外（它是词义，不是事实断言）
 */
export function sanitizeReport(
  personKey: string,
  name: string,
  llm: LlmReportFields,
  news: NewsItem[],
  focus: FocusCode = 'all'
): Report {
  /* 出处索引：本函数所有段落共用。它把「模型抄歪一点的 URL」「写成媒体名」都算作有效出处
     （理由见 buildSourceIndex）—— 逐字符全等会把明明确定、只是写法不同的出处判成没有出处，
     代价是整条事实消失，而用户看到的就是「报告少了一块」。 */
  const srcIndex = buildSourceIndex(news)

  const normSentiment = (s?: string): 'positive' | 'neutral' | 'negative' =>
    s === 'positive' || s === 'negative' ? s : 'neutral'

  const normStance = (s?: string): 'positive' | 'neutral' | 'negative' | 'mixed' =>
    s === 'positive' || s === 'negative' || s === 'mixed' ? s : 'neutral'

  /* 关系类别归一：四档之外（含模型自造的词）一律 other —— 不硬把「亦师亦友」猜进某一档 */
  const normRelation = (r?: string): 'cooperate' | 'mentor' | 'rival' | 'other' =>
    r === 'cooperate' || r === 'mentor' || r === 'rival' ? r : 'other'

  /*
   * 动态：出处必须能对上素材（这是「动态」这个体裁的底线 —— 点不回原文就不是动态）。
   * 但比对走 srcIndex 而不是逐字符全等，且**落库用素材里的原始 URL**：模型抄来的链接
   * 差一个字符就 404，而点回去核对正是这条出处存在的意义。标题 / 媒体名缺失时用素材的。
   */
  const dynamics: Report['dynamics'] = []
  for (const d of llm.dynamics ?? []) {
    const hit = matchNewsOf(d.url, srcIndex)
    if (!hit) continue
    dynamics.push({
      date: d.date ?? '',
      title: d.title || hit.title,
      summary: d.summary ?? '',
      source: d.source || hit.source,
      url: hit.url,
      sentiment: normSentiment(d.sentiment)
    })
  }
  const quotes: Report['quotes'] = []
  for (const q of llm.quotes ?? []) {
    const raw = (q.source ?? '').trim()
    const hit = matchNewsOf(raw, srcIndex)
    /* 「声称有出处、却指不出是哪条素材」的整条不要 —— 与事实字段同一道闸门（一个编造的链接
       不该被当成出处）。自称「据公开资料」的留下：那是一句诚实的「我找不到出处」，
       与凭空说一个有出处不是一回事，而语录本身是核心内容，不该因此整段消失。 */
    if (raw !== '' && raw !== '据公开资料' && !hit) continue
    quotes.push({
      text: q.text,
      context: q.context ?? '',
      /* 背景 / 注解：自由文本，照旧「去空 + 收敛长度」；空串保留（UI 按空串决定渲不渲染那一段） */
      background: (q.background ?? '').trim().slice(0, QUOTE_NOTE_CHARS),
      note: (q.note ?? '').trim().slice(0, QUOTE_NOTE_CHARS),
      /* 落库用素材里的原始 URL：quote-check 要靠这一串精确对上动态 / 来源清单，
         两边都换成素材原串才匹配得上（此前是模型抄来的那串，抄歪了就永远对不上） */
      source: hit ? hit.url : '据公开资料'
    })
  }
  /* 来源清单：只收能对上素材的，且标题 / URL 以素材自身为准（这片清单的用处就是点回原文） */
  const sources: Report['sources'] = []
  const seenSourceUrl = new Set<string>()
  for (const s of llm.sources ?? []) {
    const hit = matchNewsOf(s.url, srcIndex) ?? matchNewsOf(s.title, srcIndex)
    if (!hit || seenSourceUrl.has(hit.url)) continue
    seenSourceUrl.add(hit.url)
    sources.push({ title: s.title || hit.title, url: hit.url })
  }
  const timeline = (llm.timeline ?? []).map((t) => ({ date: t.date ?? '', event: t.event ?? '' }))
  /* 话题态度：topic / note 是自由文本，没有像 url 那样可白名单的锚点，
     只能做「去空 + 限条数 + 收敛长度」，因此它排在各段之后（见附录 B 的校验顺序） */
  const stance = (llm.stance ?? [])
    .map((s) => ({
      topic: (s.topic ?? '').trim(),
      attitude: normStance(s.attitude),
      note: (s.note ?? '').trim().slice(0, 60)
    }))
    .filter((s) => s.topic !== '')
    .slice(0, 4)

  let removed = 0
  removed += (llm.dynamics?.length ?? 0) - dynamics.length
  removed += (llm.quotes?.length ?? 0) - quotes.length
  removed += (llm.sources?.length ?? 0) - sources.length
  if (removed > 0) {
    diagLog('warn', 'db', `白名单剔除 ${removed} 条（${personKey}）`)
  }

  /* 点评拆条（本轮）：basis 是 url 引用位，与 quotes.source 走同一套出处匹配（srcIndex） */
  const analysisPoints = (llm.analysisPoints ?? [])
    .map((p) => ({
      point: (p.point ?? '').trim().slice(0, ANALYSIS_POINT_CHARS),
      basis: sourceNameOf(p.basis, srcIndex)
    }))
    .filter((p) => p.point !== '')
    .slice(0, ANALYSIS_POINT_MAX)
  /*
   * analysis 仍要落库，且必须与拆条内容一致：
   *   它是问答上下文（utils/qa.ts 读的是这个字符串）与老 UI / 分享文案的出口，
   *   拆条只是让它多了一份结构化形态，不能让它断供。
   * 各条已按提示词要求以句号结尾，拼装时补一次句号，兜住模型偶发的漏写。
   */
  const analysis =
    analysisPoints.length > 0
      ? analysisPoints.map((p) => (/[。！？!?]$/.test(p.point) ? p.point : `${p.point}。`)).join('')
      : llm.analysis ?? ''

  /* 会员专属段落（O-11）：两段都空就整个字段不落库 —— UI 按「有没有这个字段」决定出不出一张卡 */
  const notes = llm.memberNotes
  const noteCompare = (notes?.compare ?? '').trim().slice(0, MEMBER_NOTE_CHARS)
  const noteRisk = (notes?.risk ?? '').trim().slice(0, MEMBER_NOTE_CHARS)
  const memberNotes = noteCompare !== '' || noteRisk !== '' ? { compare: noteCompare, risk: noteRisk } : undefined

  /*
   * 信源分歧（本轮，会员专享）：与 memberNotes 同一套「空则整段不落库」。
   * 缺任一侧的条目直接剔除 —— 模型偶尔会把「一方发声、另一方沉默」写成冲突，
   * 那不是分歧；报告只摆真正的两边对不上。
   */
  const conflicts = (llm.conflicts ?? [])
    .map((c) => ({
      topic: (c.topic ?? '').trim().slice(0, CONFLICT_TOPIC_CHARS),
      a: (c.a ?? '').trim().slice(0, CONFLICT_SIDE_CHARS),
      b: (c.b ?? '').trim().slice(0, CONFLICT_SIDE_CHARS)
    }))
    .filter((c) => c.topic !== '' && c.a !== '' && c.b !== '')
    .slice(0, CONFLICT_MAX)

  /*
   * 第二批（免费可见的五段事实字段）：四段的骨架完全一样 ——
   *   去空 + 收敛长度 → 用 strictSourceOf 求「必须为真素材」的出处 → 指不出出处就整条剔除 → 截条数。
   * 写成同一套而不是各写一遍，是因为「事实必须有出处」这条规矩只能有一处实现：
   * 任何一段漏掉 strictSourceOf，模型编的事实就会从那个口子进来。
   */
  const profile = (llm.profile ?? [])
    .map((p) => ({
      label: (p.label ?? '').trim().slice(0, PROFILE_LABEL_CHARS),
      value: (p.value ?? '').trim().slice(0, PROFILE_VALUE_CHARS),
      basis: strictSourceOf(p.basis, srcIndex)
    }))
    .filter((p) => p.label !== '' && p.value !== '' && p.basis !== '')
    .slice(0, PROFILE_MAX)

  const relations = (llm.relations ?? [])
    .map((r) => ({
      name: (r.name ?? '').trim().slice(0, RELATION_NAME_CHARS),
      relation: normRelation(r.relation),
      note: (r.note ?? '').trim().slice(0, RELATION_NOTE_CHARS),
      basis: strictSourceOf(r.basis, srcIndex)
    }))
    .filter((r) => r.name !== '' && r.basis !== '')
    .slice(0, RELATION_MAX)

  const watchlist = (llm.watchlist ?? [])
    .map((w) => ({
      when: (w.when ?? '').trim().slice(0, WATCH_WHEN_CHARS),
      what: (w.what ?? '').trim().slice(0, WATCH_WHAT_CHARS),
      basis: strictSourceOf(w.basis, srcIndex)
    }))
    .filter((w) => w.when !== '' && w.what !== '' && w.basis !== '')
    .slice(0, WATCH_MAX)

  /*
   * 名词解释：全项目**唯一不带出处**的模型段落（理由见 Schema 注释 —— 它答的是词义而不是
   * 关于本人的事实）。正因为少了出处这道闸门，它必须更短、更少：条数与字数都收得比其余四段紧。
   */
  const glossary = (llm.glossary ?? [])
    .map((g) => ({
      term: (g.term ?? '').trim().slice(0, GLOSSARY_TERM_CHARS),
      explain: (g.explain ?? '').trim().slice(0, GLOSSARY_EXPLAIN_CHARS)
    }))
    .filter((g) => g.term !== '' && g.explain !== '')
    .slice(0, GLOSSARY_MAX)

  /* 争议与回应：response 允许空串（素材里没有公开回应是常态），故它不进 filter 条件 */
  const controversies = (llm.controversies ?? [])
    .map((c) => ({
      topic: (c.topic ?? '').trim().slice(0, CONTROVERSY_TOPIC_CHARS),
      claim: (c.claim ?? '').trim().slice(0, CONTROVERSY_CLAIM_CHARS),
      response: (c.response ?? '').trim().slice(0, CONTROVERSY_RESPONSE_CHARS),
      basis: strictSourceOf(c.basis, srcIndex)
    }))
    .filter((c) => c.topic !== '' && c.claim !== '' && c.basis !== '')
    .slice(0, CONTROVERSY_MAX)

  /* 事实字段被剔除的条数单独记一笔：它是「不做推断」这道闸门在真实生成里生效的证据 */
  const factDropped =
    (llm.profile?.length ?? 0) -
    profile.length +
    ((llm.relations?.length ?? 0) - relations.length) +
    ((llm.watchlist?.length ?? 0) - watchlist.length) +
    ((llm.controversies?.length ?? 0) - controversies.length)
  if (factDropped > 0) {
    diagLog('warn', 'db', `事实字段无有效出处，剔除 ${factDropped} 条（${personKey}）`)
  }

  // 热度（§1.6）：N30 = 素材数（查询窗口 30 天，截到 HEAT_COUNT_CAP）；N7 = publishedDate 在 7 天内
  const statsNews = news.length > HEAT_COUNT_CAP ? news.slice(0, HEAT_COUNT_CAP) : news
  const n7 = countWithinDays(statsNews, 7)
  const heat = heatValue(statsNews.length, n7)

  /*
   * 落库前的「成段数」快照（诊断口径）。
   *
   * 报告是全局共享缓存，事后只能靠这条日志回答「这次到底是哪一段没内容」——
   * 用户反馈「报告不全」时，它把三种「空」区分开：
   *   · 这里计数为 0 → 模型这次没给（或给了但指不出出处，另见上面的剔除日志）；
   *   · 键不在 detail 里（老报告根本走不到这行）→ 这份报告生成时没要过这一段；
   *   · 数组非空但 UI 没渲染 → 那是呈现层的问题，与数据无关。
   * 条数放 detail（可结构化筛选），message 保持一句话，避免把诊断页刷满。
   */
  diagLog('info', 'db', `报告成段数（${personKey}）`, {
    dynamics: dynamics.length,
    quotes: quotes.length,
    sources: sources.length,
    timeline: timeline.length,
    stance: stance.length,
    analysisPoints: analysisPoints.length,
    profile: profile.length,
    relations: relations.length,
    watchlist: watchlist.length,
    glossary: glossary.length,
    controversies: controversies.length,
    conflicts: conflicts.length,
    memberNotes: memberNotes ? 1 : 0
  })

  return {
    personKey,
    name,
    mode: 'realtime',
    generatedAt: new Date().toISOString(),
    heat,
    intro: llm.intro ?? '',
    dynamics,
    quotes,
    analysis,
    ...(analysisPoints.length > 0 ? { analysisPoints } : {}),
    stance,
    timeline,
    sources,
    ...(memberNotes ? { memberNotes } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
    /*
     * 第二批五段：**空数组也落库**（2026-10-08 改）。
     *
     * 原先的口径是「空则不落库」，理由是「落空数组会让老报告与新报告在 UI 上出现两种空」。
     * 实践下来这个取舍错了方向：那两种「空」本来就是**两件不同的事** ——
     *   · 键不存在 = 这份报告生成时根本没要过这一段（老报告、降级简版）；
     *   · 键存在且为空 = 本次生成确认「素材里确实没有」。
     * 两者都存成「没有这个键」，UI 就只能整卡不出：用户看到某一块凭空消失，既分不清是本来
     * 没内容还是页面坏了，也无从判断该不该点「查看最新」重新生成 —— 而「本次确实没有」恰好是
     * 决定要不要重新生成的关键信息（素材每天都在变）。
     * 故改为一律落库：UI 用「键在不在」区分老报告（整卡降级，维持原约定不变），
     * 用「数组空不空」区分本次确实没有（出卡 + 写明原因）。
     */
    profile,
    relations,
    watchlist,
    glossary,
    controversies,
    disclaimer: DISCLAIMER,
    focus,
    coverage: buildCoverage(news)
  }
}
