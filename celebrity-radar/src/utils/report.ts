import { z } from 'zod'
import { NewsItem, heatValue } from './search'
import { FocusCode } from '@/config/filters'
import { chatJSON, chatText, ChatJSONResult } from './llm'
import { setCooldown } from './cooldown'
import { diagLog } from './cloud-diagnostics'
import { cleanText, clipText } from './text'
import {
  REPORT_BUDGET,
  REPORT_FIELD_LIMITS,
  REPORT_OUTPUT_BUDGET,
  REPORT_QUOTAS,
  REPORT_SOURCE
} from '../config/benefits'
/* 分批生成的**分组口径**取自报告模板（页面目录块用的同一份真源）：不另立一套分组 */
import { REPORT_TEMPLATE, TOC_GROUPS, TocGroupKey, groupNeedsLane } from './report-toc'

/**
 * AI 报告 Schema v2（§2.3）与生成/校验（附录 B）。
 * 不信任提示词：URL 白名单、来源标注、枚举值全部代码层强制。
 *
 * **生成是分多批的**（P0-B，2026-10-11）：按报告模板的四组各调一次模型、逐批合并
 * （规格见 BATCH_SPEC / REPORT_BATCHES，主流程见 buildReport）。所以下面「一份报告」的完整
 * 契约（LlmReportObject）与「一批」的契约（batchSchema）是两张表，都从 REPORT_FIELDS 派生。
 */

/**
 * 当前报告 Schema 版本（前置项，2026-10-09）。
 *
 * 为什么现在才加：第二批五段（人物档案 / 关系图谱 / 后续关注 / 名词解释 / 争议与回应）
 * 上线时，靠的是「键缺失就整卡不出」的逐字段判空（报告页里十来处 `report.x ?? []`）。
 * 再加三个方向的字段（见 `docs/commercial-audience-risk-plan.md` 五、前置项 1）会明显失控，
 * 所以先把版本号落到 `report_cache` 行上，后续才能按版本回答「这份报告该不该有这一段」。
 *
 * 数值口径：
 *   1 = 第一批（2026-10-06 之前落库：没有 `stance` / `controversies` / `profile` 这些键）
 *   2 = 当前形态（含第二批五段）
 *
 * ⚠ 老行没有这个字段，读取一律按 1 处理（`utils/cache.ts#reportSchemaVersion`）。
 *   **不要**用 dbInit 的 `def` 去回填：那会把第一批的老报告一起标成 2，版本号就废了。
 *   升级这一常量时必须同时想清楚「新客户端读到旧版本行怎么办」——只加字段不改行为才安全。
 */
export const REPORT_SCHEMA_VERSION = 2

/**
 * 一份报告至少要有的「实质条目」数（动态 + 语录 + 时间线）；数值在 config/benefits.ts
 * 的 REPORT_SOURCE.shortfallMinFacts。
 *
 * 门槛刻意压低（3 条）：它只为挡住「明显不是一份报告」的产物。因为不达标意味着
 * **不消耗用户次数**（见 utils/cache.ts 的计费点），用户可无限重试 —— 真正防滥用的
 * 是云函数 quotaGuard 的 ai_calls 日限（先自增、失败不退），这里再设高门槛只会把
 * 「模型偶尔少吐两段」也算成失败，用户反而不明所以。
 */
export const SHORTFALL_MIN_FACTS = REPORT_SOURCE.shortfallMinFacts

/**
 * 本次生成是否「够格交付」；`null` 表示达标，否则返回一句人话（进日志 / 页面提示）。
 *
 * 用途只有一个：决定这次要不要消耗用户的每日生成次数（2026-10-10）。
 * 写在报告层是因为「什么算一份报告」只有这套 schema 说得清；扣减点仍在 utils/cache.ts。
 *
 * 四道判断，从「根本没生成出来」到「生成出来了但不该收钱」：
 *   1. degraded —— 结构化输出两次失败，只剩一段纯文本，这不是报告；
 *   2. 简介 / AI 点评缺任一 —— 这两段是报告的骨架，缺了读起来就是残的；
 *   3. 实质条目 < SHORTFALL_MIN_FACTS —— 只有骨架没有事实，同样是残的；
 *   4. 会员档生成却没有任何专享段落（memberNotes / conflicts）—— 会员权益没兑现
 *      （检索不到素材是常见原因），这一份也不该收钱。免费读者不判这一条。
 *
 * ⚠ 刻意**不**判「人物档案 / 关系图谱 / 时间线」为空（P1，2026-10-10「达标判定与用户在意
 *   的东西对齐」）：这三节的素材来自**不限时间**的背景线，空了多半是这位人物的公开资料
 *   本来就少，判成失败只会让用户反复重试 —— 每次都不扣次数，但每次都拿不到东西，白等一场。
 *   它们的缺口改由 backgroundGaps 交给页面**说明**（不计费，也不劝重试）。
 */
export function reportShortfall(report: Report, member: boolean): string | null {
  return shortfallVerdict(report, member)?.reason ?? null
}

/**
 * 不达标的判定结果：`reason` 给日志与页面用，`retryable` 决定页面**劝不劝重试**。
 *
 * 为什么「不达标」还要再分一次「值不值得重试」（P2，2026-10-10「文案分流」）：
 * 页面此前对下面四条判定**共用同一句**「多为上游偶发抖动，重试通常就好」，可这句话对其中两条
 * **是错的** —— 「实质条目不足」与「会员档没有专享段落」的常见原因是**素材本身就不够**
 * （长尾人物近期报道本来就少；原注释自己写着「检索不到素材是常见原因」）。用户照着重试，
 * 每次都不扣次数、每次都不达标，白等一场，还会把「素材少」误解成「服务坏了」——
 * 与 backgroundGaps 踩的是同一个坑，故用同一套办法：**说清重试没用**。
 *
 * 判据一律取 `report.coverage.items`（端上按检索结果**原样统计**、不经模型改写，
 * 是这份报告里最可信的一个数）：素材条数本身就不到门槛时，重试只是把同一批素材再喂一遍，
 * 结果不会不同。
 *
 * degraded 与「缺简介 / 缺点评」两段骨架则**永远可重试**：那是模型少吐了一段，与素材多寡
 * 无关（素材再少，简介也写得出来；结构化输出失败更是纯粹的上游抖动）。
 */
function shortfallVerdict(
  report: Report,
  member: boolean
): { reason: string; retryable: boolean } | null {
  /*
   * 无素材兜底（C）判在最前：这份内容来自模型已有知识、没有素材支撑，**不达标是设计如此**，
   * 且重试不会有变化（检索侧已经试过全部源与全部档位：见 utils/search.ts#fetchNews 的降级
   * 阶梯与 aiProxy 的 Bing 兜底）。故给一句专门的话、并标成**不可重试** ——
   * 否则页面会劝用户白等一场（与「素材本身就不够」那类是同一个理由）。
   */
  if (report.knowledgeOnly) {
    return { reason: '本次未检索到公开素材，以下内容来自模型的已有知识、未经核实', retryable: false }
  }
  if (report.degraded) return { reason: '结构化输出失败，只拿到纯文本简版', retryable: true }
  if (!report.intro.trim()) return { reason: '没有简介正文', retryable: true }
  if (!report.analysis.trim()) return { reason: '没有 AI 点评正文', retryable: true }

  /*
   * 素材够不够门槛：不够 ⇒ 再试也是同一批素材（结构性缺失），劝重试是白等。
   * 取不到 coverage（老报告没有这个字段）时按 0 处理 ⇒ 不可重试：本函数只在「本次新生成」
   * 之后调用，那条路径上 coverage 必然有值（sanitizeReport 与降级分支都写了 buildCoverage），
   * 故这条兜底实际不可达；写成 0 只是不给用户一句兑现不了的空头承诺。
   */
  const enoughMaterial = (report.coverage?.items ?? 0) >= SHORTFALL_MIN_FACTS

  const facts = report.dynamics.length + report.quotes.length + report.timeline.length
  if (facts < SHORTFALL_MIN_FACTS) {
    return { reason: `实质条目不足（${facts}/${SHORTFALL_MIN_FACTS}）`, retryable: enoughMaterial }
  }

  if (member) {
    const own =
      (report.memberNotes?.compare.trim() ? 1 : 0) +
      (report.memberNotes?.risk.trim() ? 1 : 0) +
      (report.conflicts?.length ?? 0)
    if (own === 0) {
      return { reason: '会员档生成，但没有任何会员专享段落', retryable: enoughMaterial }
    }
  }

  return null
}

/**
 * 这次不达标「重试有没有意义」。页面据此选文案（劝重试 / 劝放弃），判据见 shortfallVerdict。
 * 达标时恒为 `false` —— 那时页面根本不会渲染那条提示。
 */
export function reportShortfallRetryable(report: Report, member: boolean): boolean {
  return shortfallVerdict(report, member)?.retryable === true
}

/**
 * 背景类段落**本次确实为空**的节名（人物档案 / 关系图谱 / 时间线）。
 *
 * 与 reportShortfall 的分工（P1，2026-10-10）：
 *   · reportShortfall = **计费门槛**：不达标就不扣次数；
 *   · 本函数 = **阅读提示**：这几节空了照样计费 —— 门槛刻意不含它们（理由见上方那条 ⚠）。
 *
 * 「本次确实为空」按**键在不在**判（同 sanitizeReport 的约定）：
 *   键不存在 = 本轮之前落库的老报告，整卡本来就走降级，不在这里提示；
 *   数组为空 = 本次确实没有 —— 才是这条提示要说的事。timeline 恒落库，为空同样算。
 *
 * 页面拿到的这句话与 shortfall 那句的火候完全不同：shortfall 是「重试通常就好」，
 * 这里是「本次已单独跑过人物背景线，仍为空说明公开资料本身缺少，重试不会有变化」。
 */
export function backgroundGaps(report: Report): string[] {
  if (report.degraded) return []
  const gaps: string[] = []
  if (report.profile && report.profile.length === 0) gaps.push('人物档案')
  if (report.relations && report.relations.length === 0) gaps.push('关系图谱')
  if (report.timeline.length === 0) gaps.push('时间线')
  return gaps
}

/**
 * 导读要旨：这份报告里**最值得先看到的那一句结论**（报告页把它放在首屏的速览卡里当导读）。
 *
 * 要解决的问题与「目录」不同：目录解决的是「15 节在哪儿」，而最有价值的一句话要滑过好几张卡
 * 才读到（AI 解读排在第 3 节、AI 点评排在第 8 节）。故把它提前到首屏。
 *
 * 取法（批 2 起，优先级自上而下）：
 *   · verdict.summary → 提示词第 16 条明确要的「整体结论」，定位就是导读；批 2 把「整体判断」
 *     这个职责从点评第一条挪到了 AI 解读，导读跟着它走；
 *   · analysisPoints[0] → 存量报告没有 verdict，仍取点评第一条（行为与从前一致）；
 *   · analysis 首句 → 更早的老报告只有整段点评；
 *   · 都没有 → 空串，调用方据此不渲染这条入口（宁可不出现，也不编一个数出来）。
 *
 * 降级简版返回空串：那种报告的「点评」是一整段抢救出来的纯文本，首句多半是「本次生成未能…」
 * 这类说明，不是判断。与 backgroundGaps 同一处理（降级时不谈缺口，也不谈判断）。
 */
export function reportGist(report: Report): string {
  if (report.degraded) return ''
  const verdictSummary = (report.verdict?.summary || '').trim()
  if (verdictSummary) return verdictSummary
  const point = (report.analysisPoints || []).map((p) => (p.point || '').trim()).filter(Boolean)[0]
  if (point) return point
  const text = (report.analysis || '').trim()
  if (!text) return ''
  return text.split(/[。！？!?；;\n]/)[0].trim() || text
}

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

/**
 * 报告的字段契约：**字段名 → 字段 schema**（heat 由本地计算，不由模型给）。
 *
 * 为什么要拆成一张「字段表」而不是像原先那样写成一个对象字面量：分批之后每次调用只要其中
 * 几个键，而**契约必须只有一份** —— 分成四份各写一遍类型是这类改造最容易坏的地方，
 * 而且坏起来不报错：zod 的非严格对象遇到未声明的键是**静默丢弃**（这正是下面 memberNotes
 * 那条注释反复强调的坑），漏声明的表现只是「某一批的字段在报告里凭空消失」。
 * 现在整体契约（LlmReportObject）与分批契约（batchSchema → pickFields）都从这张表里挑。
 */
const REPORT_FIELDS = {
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
  /* ⚠ 这里**刻意没有** sources：那片「来源清单」不再由模型产出，改由端上从报告里真正
     引用到的素材派生（见 sanitizeReport）。留在契约里就等于还在向模型要它 —— 而它恰是
     facts 批最大的一块输出、且规模随素材数增长（见提示词池里第 5 条删除处的注释）。 */
  /* 会员专属段落（O-11）：只有会员的提示词里会出现它，免费报告恒为 undefined。
     必须在 schema 里声明 —— zod 的非严格对象会把未声明的键**静默丢弃**。 */
  memberNotes: MemberNotesSchema.optional().catch(undefined),
  /* 信源分歧（本轮，会员专享）：同上，不声明就等于白要（会被 zod 静默丢掉） */
  conflicts: z.array(ConflictSchema).optional().catch(undefined),
  /* 第二批（免费可见）：五段结构化事实字段，随提示词一起要。
     同样必须先声明 —— zod 的非严格对象会把未声明的键静默丢弃。
     一律 .catch([]) 而不是 .default([])：模型把它们写成对象 / 字符串时也只是这一段为空，
     不该让整份报告在校验这一步失败（.catch 同时兜住键缺失，故不必再叠 .default）。 */
  profile: z.array(ProfileItemSchema).catch([]),
  relations: z.array(RelationSchema).catch([]),
  watchlist: z.array(WatchItemSchema).catch([]),
  glossary: z.array(GlossaryItemSchema).catch([]),
  controversies: z.array(ControversySchema).catch([]),
  /* 本系统的客观评价（批 2）：可选 —— 模型偶尔不给也不该让整份报告降级，故 .optional().catch */
  verdict: z
    .object({ summary: looseStr(), positioning: looseStr() })
    .optional()
    .catch(undefined),
  /* 口碑两极 / 言行一致度（批 2）：同 verdict，评价类、可选、不给不崩 */
  reputation: z
    .object({ positive: looseStr(), negative: looseStr() })
    .optional()
    .catch(undefined),
  consistency: z
    .object({ claim: looseStr(), act: looseStr(), gap: looseStr() })
    .optional()
    .catch(undefined)
}

/**
 * 把若干字段包成一次调用的解析契约：拒答分支 + 只含这些键的对象分支。
 * 拒答分支的 refused 刻意用 unknown 而不是 literal(false)：模型偶发写 "refused": "false" / 0 时，
 * literal 两处都不匹配 → 整份报告校验失败 → 降级。判「是不是拒答」只需看它是否全等 true
 * （见 isRefusedResult），值域校验不必要，也不必付整份报告的代价。
 */
const llmContract = (fields: Record<string, z.ZodTypeAny>) =>
  z.union([z.object({ refused: z.literal(true) }), z.object({ refused: z.unknown().optional(), ...fields })])

/** 按字段名挑出这批要的键；字段名写错就抛（见 pickFields 注释） */
function pickFields(fields: string[]): Record<string, z.ZodTypeAny> {
  const picked: Record<string, z.ZodTypeAny> = {}
  for (const field of fields) {
    const one = (REPORT_FIELDS as Record<string, z.ZodTypeAny>)[field]
    /* 抛而不是跳过：字段名写错（比如 analysisPoints 写成 analysisPoint）只会让那一批
       悄悄不产出该字段，页面上表现为「卡片消失」，很难追到是分批清单写错了 */
    if (!one) throw new Error(`报告分批出现未知字段：${field}（见 REPORT_FIELDS）`)
    picked[field] = one
  }
  return picked
}

/**
 * 整体契约：**全量字段**的一份对象 schema。
 * 分批生成（buildReport）实际按批解析（batchSchema），这份用于推导 LlmReport 类型
 * 与「整份报告」的形状自检（heat 由本地计算，不由模型给）。
 */
const LlmReportObject = z.object({ refused: z.unknown().optional(), ...REPORT_FIELDS })

export type LlmReport = z.infer<typeof LlmReportObject> & { refused?: boolean }

/** 拒答结果的显式类型守卫（联合窄化用） */
export function isRefusedResult(x: unknown): x is { refused: true } {
  const refused = typeof x === 'object' && x !== null ? (x as { refused?: unknown }).refused : undefined
  /* 兼收字符串 'true'：schema 里 refused 是宽容字段（见 llmContract 的注释），模型写成
     "refused": "true" 时不该被当成「没有拒答」—— 那会让一份本该拒答的报告变成一堆空卡片 */
  return refused === true || refused === 'true'
}

/** 一条点评：判断本身 + 依据（媒体名，或「据公开资料」） */
export interface AnalysisPoint {
  point: string
  basis: string
}

/**
 * 本系统的客观评价（批 2，2026-10-10）：一句话结论 + 行业定位。
 *
 * 与 facts 类字段（dynamics / profile / relations…）不同，它答的是「怎么看」而非「是什么」：
 * 允许在公开素材之上做归纳推断（对「仅基于素材」这条事实边界的一次有意识放宽），
 * 但**不得编造不存在的事实**。展示处必须配「仅供参考」免责声明。
 */
export interface Verdict {
  summary: string
  positioning: string
}

/**
 * 口碑两极（批 2）：大众/媒体对 TA 的两种声音。
 * 同 Verdict —— 评价/判断类字段，不带出处、允许归纳推断，展示处配免责。
 */
export interface Reputation {
  positive: string
  negative: string
}

/**
 * 言行一致度（批 2）：TA 公开说过的 vs 实际做过的。
 * 刻意设计成「陈述差异、不裁决对错」—— claim/act 是事实摘录，gap 只说「一致与否」，
 * 不给人品下结论（那会越出「客观评价」的边界）。
 */
export interface Consistency {
  claim: string
  act: string
  gap: string
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
  /* sources 不在这里：改由端上派生（见 REPORT_FIELDS 的同名说明与 sanitizeReport） */
  memberNotes?: { compare?: string; risk?: string }
  conflicts?: Array<{ topic?: string; a?: string; b?: string }>
  /* 第二批（免费可见）：宽松形态，字段可能缺失或非字符串，由 sanitize 内部归一 */
  profile?: Array<{ label?: string; value?: string; basis?: string }>
  relations?: Array<{ name?: string; relation?: string; note?: string; basis?: string }>
  watchlist?: Array<{ when?: string; what?: string; basis?: string }>
  glossary?: Array<{ term?: string; explain?: string }>
  controversies?: Array<{ topic?: string; claim?: string; response?: string; basis?: string }>
  verdict?: { summary?: string; positioning?: string }
  reputation?: { positive?: string; negative?: string }
  consistency?: { claim?: string; act?: string; gap?: string }
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
  /**
   * 本系统的客观评价（批 2，2026-10-10）：一句话结论 + 行业定位。
   * 可选 —— 改动前落库的老报告没有这个字段，UI 整卡不出。
   * 这是「评价/判断」而非「事实」，允许在公开素材之上做归纳推断（对「仅基于素材」这条
   * 事实边界的有意识放宽），但不得编造不存在的事实；展示处必须配「仅供参考」免责。
   */
  verdict?: Verdict
  /** 口碑两极（批 2）：评价类、可选、不带出处，展示处配免责。老报告没有此字段 */
  reputation?: Reputation
  /** 言行一致度（批 2）：陈述差异、不裁决对错。可选、不带出处，老报告没有此字段 */
  consistency?: Consistency
  disclaimer: string
  /** 生成时的关注侧重（发现页「关注」筛选，'all' = 六段完整） */
  focus?: FocusCode
  /** 降级标记：结构化生成失败后由纯文本降级产出（§5.4 用例 9），UI 呈现降级提示 */
  degraded?: true
  /**
   * 「无素材兜底」（C，2026-10-10）：**所有检索源与档位都没抓到内容**时，由模型的已有知识
   * 产出的简介 —— 与 degraded 是两回事，别混：
   *   · degraded      = 素材抓到了，但结构化输出失败 ⇒ 剩一段纯文本（**有素材**）；
   *   · knowledgeOnly = 素材**一条都没有** ⇒ 只给 intro，内容未经核实（**没素材**）。
   *
   * 只放 intro 是刻意的：profile 的契约是「每条都有素材出处、能回到一篇原文核对」
   * （见 ProfileItemSchema.basis 的注释），模型知识给不出出处，塞进去会毁掉那条契约。
   * 页面据此说明来源（文案见 shortfallVerdict），提示用户这不是检索结果。
   *
   * ⚠ 它**不进共享缓存**（见 utils/cache.ts 的 nonews 分支）：report_cache 是全站共享的一行，
   * 把一份没素材的内容写进去会污染之后所有读者的视图。
   */
  knowledgeOnly?: true
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

/*
 * ═════════════ 报告提示词（分批生成，P0-B 2026-10-11） ═════════════
 *
 * 原先是**一份** SYSTEM_REALTIME：一次调用要模型吐完 16 节 JSON。问题不在提示词写了什么，
 * 而在「一次要太多」这件事本身：
 *   ① 输出预算：max_tokens 是**整轮 completion** 的预算，推理模型的 reasoning_content 也算在里面。
 *      整份报告 JSON 一次吐完接近 1 万字（四批加起来，见 FIELD_OUTPUT_ESTIMATE），
 *      再被思考吃掉一截，必然撞上限；而**截断的 JSON 修不回来**（utils/llm.ts#parseModelJson
 *      刻意不补右括号），代价是整份 16 节全废、降级成一段纯文本。
 *      分批之后「每批吐多少」就是可算的了 —— 预算口径在 config/benefits.ts#REPORT_OUTPUT_BUDGET，
 *      逐批校验在 test/cases/20。
 *   ② 失败面：一次调用失败 = 整份报废；报告页本来就是按字段逐卡降级的，拆开之后失败只丢一组。
 *   ③ 可续跑：每批成功即落库（见 utils/cache.ts 的 saveReportParts），已付的 token 不作废。
 *
 * 分批的**分组口径不是新发明**：它就是报告模板的四组（utils/report-toc.ts#TOC_GROUPS，
 * 页面目录块用的同一份）。「哪一节属于哪一组」只有一处真源 —— REPORT_TEMPLATE，
 * 下面 REPORT_BATCHES 的 sectionIds 由它派生（测试核对两者一致）。
 *
 * 提示词的组织：正文**逐字未动**，只是按组切开 ——
 *   · SYSTEM_SHARED_REALTIME：每批都带的硬约束（角色 / 出处写法 / 第 1、14 条）；
 *   · REPORT_RULES_REALTIME：各条字段要求（条号写在字符串开头），分批时按组取用；
 *   · REPORT_BATCHES：每批负责哪些节、哪些字段、要不要背景素材、带不带会员补充。
 * **条号沿用原编号、不重排**（于是每批的编号是跳着的）：条文之间有多处「见第 16 条」
 * 「口径同第 16 条」这样的互相引用，重排会让这些引用全部错位；沿用编号也便于把新旧日志、
 * 新旧注释里的「第 N 条」直接对上。
 */

/** 全批共用的硬约束：角色 + 出处写法 + 第 1 条 + 第 14 条（免费与会员逐字节一致） */
const SYSTEM_SHARED_REALTIME = [
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
  /*
   * 第 14 条（敏感人物拒答）从下面那份要求池里**提到了这里**：它和 1 一样是全局条，
   * 拆批之后只要有**任何一批**返回 {"refused": true}，整份报告就按拒答处理（见 buildReport），
   * 所以它必须出现在每一批里，不能只挂在某一批上（挂在某一批 = 另外三批会照常写敏感内容）。
   */
  '14. 若素材显示该人物属政治、军事类敏感人物，仅返回 {"refused": true}。'
].join('\n')

/*
 * 各条字段要求池：**就是原来那份 SYSTEM_REALTIME 的正文，逐字未动**。
 * 分批时按条号取用（见 BATCH_SPEC.ruleIds 与 ruleLines()），共用条（1、14）已提到上面。
 * 为什么按条号取、而不是手抄成四份：这些条文里有大量互相引用与成段的取舍说明
 * （例如「见第 16 条」「口径同第 16 条」、watchlist 那条里对 timeline 边界的解释），
 * 抄成四份之后它们会各自漂移 —— 而提示词措辞漂移**不报错**，只会让模型少写一块内容。
 */
/**
 * 第 15 条里那个「本批要写的字段清单」的占位符：分批时替换成本批的字段（见 ruleFill）。
 * 必须定义在池**之前** —— 池里的模板字面量在模块初始化时就要读它，const 有 TDZ，放到后面会直接抛。
 */
const RULE_FIELDS_PLACEHOLDER = '__本批字段__'

const REPORT_RULES_REALTIME = [
  /*
   * intro 的写法原先**只出现在第 16 条的 JSON 格式里**（"intro":string），没有任何质量要求：
   * 它是全篇第一段、也是全篇唯一没有字数区间与内容骨架的段落，于是实测常出现「一句泛泛的
   * 身份介绍」或与下面各段重复的流水账。这里补一条与 profile 同规格的要求。
   */
  '2. intro：人物简介（**只写客观身份，不做评价判断**），2~3 句、共 80~150 字。第一句给身份定位（是谁、以什么身份或作品成名），第二句给近期在做什么（事实性的动作，如「在拍新片」「发了新专辑」，不是「处于上升期」这类判断），有第三句才补充最值得注意的客观事实。不要复述下面动态与点评的原话；**「值不值得关注」「什么级别」这类判断不写在这里**（那是 verdict 的职责，见第 16 条）。',
  /*
   * 事实段（dynamics / quotes / timeline）的**条数目标**是本次补上的，理由：
   * 这三段此前只声明了字段、没声明条数，而全项目有六处卡在它们的条数上 ——
   * 端上聚合的词云（≥2 条命中才成词、<4 个词整卡空态）、语录主题（≥4 条语录才聚类）、
   * 热度趋势（<3 个带日期条目不画线）、情绪条（按 dynamics 条数算比例）、风险雷达（从全篇字面挑），
   * 以及 buildReport 的达标判定（dynamics+quotes+timeline ≥ 3）。模型给两三条就收工，
   * 用户看到的不是「写得少」，而是**一整块卡片消失**。故给出与 profile / stance 同规格的区间。
   */
  `3. dynamics 每条字段：date(YYYY-MM-DD)、title、summary(一句摘要)、source(来源媒体名)、url(必须从素材 URL 原样复制)、sentiment(只能是 positive/neutral/negative)；素材里可确认的动态给 ${REPORT_QUOTAS.dynamicsMin}~${REPORT_QUOTAS.dynamicsMax} 条（素材充足时尽量给到 ${REPORT_QUOTAS.dynamicsTarget} 条），同一件事只写一条。`,
  `4. quotes 每条字段：text(名言原文)、context(出处场合/时间)、background(背景：这句话是在什么场合、什么背景下说的，1~2 句，须出自素材)、note(注解：这句话的含义 / 影响 / 争议，1~2 句，须出自素材，没有可说的就填空串)、source(素材 URL 或「据公开资料」)；background 与 note 合计不超过 100 字。素材里可确认的语录给 ${REPORT_QUOTAS.quotesMin}~${REPORT_QUOTAS.quotesMax} 条（素材充足时尽量给到 ${REPORT_QUOTAS.quotesTarget} 条）。`,
  /*
   * ⚠ 第 5 条（`sources 列出全部用到的素材：title + url`）**已删除**（2026-10-11），条号不再补位。
   * 原因三宗罪，任一都够：
   *   ① 它是 facts 批（最大的一批）里最大的一块输出，而且**规模不可静态封顶** —— 条数等于本次
   *      用到的素材数，随检索结果增长，预算算不出来（这正是「输出预算可校验」要拦的东西）；
   *   ② 内容 100% 是端上已知的（sanitize 本来就用素材自身的 title / url 覆盖模型给的）；
   *   ③ 让模型抄 N 条 URL，恰是提示词自己承认「走形率很高」的动作（见出处写法的注释）。
   * 现在那片清单由端上**从报告里真正引用到的素材**派生（见 sanitizeReport 的 sources 段）。
   */
  `6. analysisPoints：${REPORT_QUOTAS.analysisPointsMin}~${REPORT_FIELD_LIMITS.analysisPointMax} 条**各自独立、就具体事件或说法给出的判断**，每条字段：point(一句完整的判断，40 字内，以句号结尾)、basis(这条判断依据的素材 url，原样复制；素材里找不到出处的写「据公开资料」)。判断必须具体到人、事、时间或具体说法，禁止「风格独特」「备受关注」「引发讨论」这类换个人名也成立的套话；各条之间不要互相重复。**整体结论不写在这里**——那是 verdict.summary 的职责（见第 16 条），这里的每一条都是「某件事怎么看」，不是「TA 这个人整体怎么样」。`,
  `7. stance：${REPORT_QUOTAS.stanceMin}~${REPORT_QUOTAS.stanceMax} 个近期热点话题上的舆论态度，每条字段：topic(话题名，12 字内)、attitude(只能是 positive/neutral/negative/mixed)、note(一句话依据，须出自素材)；素材里确实没有任何可判断的舆论态度才留空数组。`,
  `8. timeline：素材中可确认的**已经发生**的关键事件(date + event)，给 ${REPORT_QUOTAS.timelineMin}~${REPORT_QUOTAS.timelineMax} 条（素材充足时尽量给到 ${REPORT_QUOTAS.timelineTarget} 条），同一件事只写一条；素材里确实没有可确认的事件才留空数组。**尚未发生**的未来节点（已公布的档期一类）不写在这里，写进 watchlist。`,
  /*
   * profile 的 label 收敛成「优先选常用字段」：此前完全自由发挥，于是同一个人的档案里
   * 出现「简介」「特点」「影响力」这类无信息量的字段名，且不同人物的档案彼此不可比
   * （A 写「出道时间」、B 写「成名时间」，读的人没法横向看）。注意措辞是「优先…才自拟」，
   * 不是白名单 —— 素材里真正重要的字段不在常用集里时，仍然要能写出来。
   */
  `9. profile：结构化人物档案 ${REPORT_QUOTAS.profileMin}~${REPORT_FIELD_LIMITS.profileMax} 条（尽量给到 ${REPORT_QUOTAS.profileTarget} 条），用来让人一眼看清「是谁」，每条字段：label(字段名，8 字内；优先从这几个常用字段里选：职业、出生年份、出生地、代表作、主要成就、所属机构、活跃领域 —— 都不合适才自拟)、value(40 字内)、basis(这条事实出自的素材，写法见开头「出处（basis）写法」)。**每条都必须能在素材里找到依据，找不到的整条不要写**；不要用常识去补全素材里没有的信息（那是编造，不是补充）。`,
  `10. relations：与本人有公开关系的人，最多 ${REPORT_FIELD_LIMITS.relationMax} 条，每条字段：name(对方姓名)、relation(只能是 cooperate/mentor/rival/other，依次表示合作、师承、对手、其他)、note(一句话说明这段关系，说不清就填空串)、basis(关系出自的素材，写法见开头)。关系必须是素材里**明确写到**的（同台合作、师徒、公开竞争等），不得由「同框」「同公司」「同时出现」推测；只有单方提及也不写。`,
  /*
   * watchlist 的 when 禁掉相对时间表述（「下月」「年底」）：报告是**长期共享缓存**，
   * 一份三个月前的报告里写「下月」，端上既不知道该折算成哪个月（它相对的是生成那一刻），
   * 也就无法做过期判定 —— 只能原样摆着，与页面顶部「N 天前生成」自相矛盾。
   * 只收绝对刻度后，端上才能标出「已过期」（见 utils/time.ts#isStampPast）。
   *
   * 同一条注释里把 timeline / watchlist 的边界也写死（本条第 2 句 + 第 8 条）：
   * **已经发生的进 timeline，尚未发生的进 watchlist**。此前只说了 watchlist 收"未来值得跟踪的"，
   * 没说"已经过去的不要写" —— 而素材是 30 天窗口的新闻，里面的日期天然带过去刻度
   * （「已于 X 日上映」这类回顾写法），模型分不清它相对"今天"是过去还是未来，于是把已经发生的
   * 事写进了「后续关注」，一份报告里两段互相打架（同一件事既是历史又是"未来"）。
   * 存量报告的数据已经落库，端上救不了（只能把两类过期分开标，见 pages/report/index.tsx）；
   * 这条边界的作用是让**新报告**不再产生这类条目。
   */
  `11. watchlist：未来值得跟踪的时间点或事件，只写素材里**已公布**的，最多 ${REPORT_FIELD_LIMITS.watchMax} 条，每条字段：when(已公布的时间刻度，只写**绝对时间**：能确定到日就写 YYYY-MM-DD、只到月就写 YYYY-MM（如 2026-11），**不要写「下月」「年底」这类相对说法**——报告会被长期复用，相对说法过一阵就连自己指哪个月都说不清，12 字内)、what(事件，40 字内)、basis(素材，写法见开头)。**只写尚未发生的**：素材里已公布、但时间已经过去的（已上映、已开播、已结束等）属于 timeline，不要写进这里。素材里确实没有已公布且尚未发生的时间点才留空数组（不得推测档期）。`,
  `12. glossary：本报告或素材里出现、普通读者可能不懂的行话或背景词（如文娱「番位」、财经「对赌」），最多 ${REPORT_FIELD_LIMITS.glossaryMax} 条，每条字段：term(词，10 字内)、explain(一句话解释，50 字内)。只解释确实出现过的词（确实没有这类词才留空数组）；解释用该词的通行含义即可（这一条答的是词义，不是关于本人的事实），不做褒贬评价。`,
  `13. controversies：近期公开争议与各方的回应，最多 ${REPORT_FIELD_LIMITS.controversyMax} 条，每条字段：topic(争议点，12 字内)、claim(争议内容，60 字内，**须写明发生时间**，时间要出自素材)、response(当事方或相关方的公开回应，40 字内；素材里没有公开回应就填空串)、basis(素材，写法见开头)。只写素材里确实存在的争议，只陈述、不评价、不裁决。`,
  /*
   * 「写满」这条是补上去的，它对应一类此前没被当成问题的失败：模板里每段都留了「素材不足
   * 则留空」的口子，而模型对这类口子的利用程度远超预期 —— 它会把「省事」读成「素材不足」，
   * 于是某些段整段为空。报告页对空段是不出卡的（见 index.tsx），用户看到的便是**整块卡片
   * 直接消失**，观感上就是「报告不全，会员免费都一样」。
   * 故这里把两个概念的边界写死：先尽力找，确实没有才留空；同时把第 1 条再钉一遍，
   * 免得这句被读成鼓励注水。
   */
  `15. 除「素材里确实没有」之外，**本批每一段都要给出内容**（${RULE_FIELDS_PLACEHOLDER} 都算）：先尽力在素材里找，确实找不到才留空数组。不许因为条数不好凑、懒得逐一核对就返回空数组 —— 用户看到的是一整块卡片直接消失，比少一条信息严重得多；但也不得为凑数编造（第 1 条）。`,
  /*
   * verdict / reputation / consistency 是批 2 的「本系统客观评价」三维。与事实字段不同：它们是
   * **评价/判断**，允许在素材事实之上做归纳推断（比如「处于事业上升期」「在同领域属头部」），
   * 这是对第 1 条「仅基于素材」的一次有意识放宽 —— 但放宽的只是「能不能下判断」，不是
   * 「能不能编事实」：判断里的时间、事件、数据仍必须真实来自素材，不得杜撰。展示处配免责。
   */
  '16. verdict：本系统基于公开信息给出的**客观评价**（仅供参考，不构成对 TA 本人的定性或裁决）：summary(一句话结论，60 字内、以句号结尾：TA 目前大致处于什么状态、值不值得关注，**这是全篇的导读句**，要具体到人、事或领域，禁止「值得关注」「备受关注」这类套话)、positioning(行业定位，60 字内：在同领域大致处于什么位置，可提对标人物；公开信息不足以判断就写「公开信息不足以判断」)。这是归纳推断，允许在素材事实之上做判断，但不得编造不存在的事实或数据。',
  '17. reputation 与 consistency（同为客观评价，口径同第 16 条）：reputation(口碑两极：positive 支持方/正面评价的核心观点 60 字内、negative 反对方/负面评价的核心观点 60 字内，两侧都要来自素材里的实际声音，某一侧素材里没有就写「素材里未见」)、consistency(言行一致度：claim 该人物公开表达过的立场或人设 40 字内、act 素材里与此相关的实际做法 40 字内、gap 客观说明两者是否一致 40 字内，只陈述差异、不裁决对错；素材不足以判断就整个字段留空)。',
]

/**
 * 按条号取要求（**找不到就抛**，不静默漏条）：条号写在字符串开头，如「3. dynamics 每条字段：…」。
 * 抛异常而不是返回空串是有意的 —— 漏掉一条要求不会报错，只会让模型少写一整块内容，
 * 而这种缺陷在页面上看不出来（卡片直接消失，看起来像「素材不足」），只能靠这里吵出来。
 * 与之配套的完整性检查见 test/cases/03：除 1、14 两条全局条外，每一条都必须被唯一一批认领。
 */
function ruleLines(ids: number[]): string[] {
  return ids.map((id) => {
    const hit = REPORT_RULES_REALTIME.find((rule) => rule.startsWith(`${id}.`))
    if (!hit) throw new Error(`报告提示词缺少第 ${id} 条：REPORT_RULES_REALTIME 里没有以「${id}.」开头的要求`)
    return hit
  })
}

/* ═════════════ 分批：每批 = 报告模板的一组（utils/report-toc.ts#TOC_GROUPS） ═════════════ */

/** 分批键 = 模板分组键（identity / facts / judgement / detail），不另立一套命名 */
export type ReportPartKey = TocGroupKey

interface BatchSpec {
  /** 本批要模型产出的字段（写进提示词第 15 / 18 条；测试核对「谁归哪批」也用它） */
  fields: string[]
  /** 本批认领的要求池条号（1、14 是全局条，已在 SYSTEM_SHARED_REALTIME 里） */
  ruleIds: number[]
  /** 本批的 JSON 格式行（原第 18 条的按批收窄版） */
  format: string
  /** 是否承载会员专属字段：MEMBER_HINT_REALTIME **只**追加在这一批上 */
  memberFields: boolean
}

export interface ReportBatch extends BatchSpec {
  key: ReportPartKey
  /** 本批负责的模板节 id（由 REPORT_TEMPLATE 的 group 派生，不手抄） */
  sectionIds: string[]
  /**
   * 是否给「人物背景资料」段（见 BACKGROUND_HEAD）—— 背景只喂「经历类」字段，不喂动态与争议。
   *
   * **由模板派生**（该组要不要 profile 检索路，见 utils/report-toc.ts#groupNeedsLane），
   * 不在这里手写：它是「素材从哪来」的一部分，与 SEARCH_LANES 是同一件事的两端 ——
   * 手写的那一版曾经需要「加一节档案 + 记得把这一批的 background 改成 true」两处同时改对。
   */
  background: boolean
}

/** 模板每一组包含哪些节 —— 从模板配置派生（测试会核对两边一致） */
const sectionIdsOf = (key: TocGroupKey): string[] =>
  REPORT_TEMPLATE.filter((section) => section.group === key).map((section) => section.id)

const BATCH_SPEC: Record<ReportPartKey, BatchSpec> = {
  /* 基本档案：简介 + 三维评价 + 档案 + 关系。这一组的判断字段（16/17）需要一个全局视角，
     故与简介、档案放在同一批里，让模型在同一段上下文里把「身份」与「评价」对齐。 */
  identity: {
    fields: ['intro', 'verdict', 'reputation', 'consistency', 'profile', 'relations'],
    ruleIds: [2, 9, 10, 16, 17],
    format:
      '18. 只输出 JSON，格式：{"intro":string,"verdict":{"summary":string,"positioning":string},"reputation":{"positive":string,"negative":string},"consistency":{"claim":string,"act":string,"gap":string},"profile":[],"relations":[]}。**只输出这几个键**：本批以外的字段一律不要出现（多写的键会被丢弃）。',
    memberFields: false
  },
  /* 事实：动态 + 语录。**不带背景段** —— BACKGROUND_HEAD 明确要求背景
     不要用来写 dynamics（背景是长期履历，容易被写成「动态」），
     这一条由模板的 facts.search 决定（不含 profile 路，见 REPORT_BATCHES）。
     这一批是**最大的一批**（动态 6 条 + 语录 5 条，见 FIELD_OUTPUT_ESTIMATE），而它同时握着
     达标判定（dynamics+quotes+timeline ≥ N）里的两条 ⇒ 单点。故它的输出规模有两道闸：
     ① 预算校验（用例 20）对它按「单点批」标准要求更严的余量；
     ② 曾是它最大一块的 sources 清单已改为端上派生（见提示词池第 5 条的删除注释）。 */
  facts: {
    fields: ['dynamics', 'quotes'],
    ruleIds: [3, 4],
    format:
      '18. 只输出 JSON，格式：{"dynamics":[],"quotes":[]}。**只输出这几个键**：本批以外的字段一律不要出现（多写的键会被丢弃）。',
    memberFields: false
  },
  /* 判断与风险：点评 + 立场 + 争议，外加会员的对比/风险/信源分歧（模板把 sec-member 归在这一组）。
     同样不带背景段：这一组要的是对**近期事件**的判断，背景线会诱导出「长期印象」式的点评。 */
  judgement: {
    fields: ['analysisPoints', 'stance', 'controversies'],
    ruleIds: [6, 7, 13],
    format:
      '18. 只输出 JSON，格式：{"analysisPoints":[],"stance":[],"controversies":[]}。**只输出这几个键**：本批以外的字段一律不要出现（多写的键会被丢弃）。',
    memberFields: true
  },
  /* 细节与延伸：时间线 + 后续关注 + 行话。时间线要靠背景段补早期经历（模板的 detail.search 含 profile 路）。 */
  detail: {
    fields: ['timeline', 'watchlist', 'glossary'],
    ruleIds: [8, 11, 12],
    format:
      '18. 只输出 JSON，格式：{"timeline":[],"watchlist":[],"glossary":[]}。**只输出这几个键**：本批以外的字段一律不要出现（多写的键会被丢弃）。',
    memberFields: false
  }
}

/**
 * 四批，顺序 = 模板 TOC_GROUPS 的顺序（也就是页面从上到下的顺序）：
 * 基本档案 → 事实 → 判断与风险 → 细节与延伸。
 * 顺序有意与模板一致，不为「把会员那批放最后」之类的理由重排：日志里四批的先后与
 * 用户看到的卡片顺序一致，出问题时能一眼对上用户反映的是哪一块。
 *
 * `background` 与 `sectionIds` 一样**从模板派生**（该组要不要 profile 检索路）：
 * 这两件事都是「模板说有哪几节 + 那几节的素材从哪来」，与提示词里的字段清单不是一回事，
 * 手写会与模板脱节（症状见 ReportBatch.background 的注释）。
 */
export const REPORT_BATCHES: ReportBatch[] = TOC_GROUPS.map((group) => ({
  key: group.key,
  sectionIds: sectionIdsOf(group.key),
  background: groupNeedsLane(group.key, 'profile'),
  ...BATCH_SPEC[group.key]
}))

/**
 * 承载会员段的那一批要额外产出的两个键（就是 MEMBER_HINT_REALTIME 里额外要的那两段）。
 * 与 BATCH_SPEC.judgement.fields 分开放：免费与会员共用同一份 BATCH_SPEC，
 * 「这次要不要会员段」是**本次调用**的属性（谁在生成），不是这一批的静态属性。
 */
const MEMBER_FIELDS = ['memberNotes', 'conflicts']

/**
 * 本批在这次调用下的**实际字段清单**：免费档 = 批的静态清单；会员档且本批承载会员段时追加两个会员键。
 * 只给解析契约与落库用（提示词里那两段由 MEMBER_HINT_REALTIME 末尾点名，理由见 buildReportSystem）。
 */
export function batchFields(batch: ReportBatch, member: boolean): string[] {
  return member && batch.memberFields ? [...batch.fields, ...MEMBER_FIELDS] : batch.fields
}

/**
 * 某一批的解析契约：**必须**比提示词多认这两个会员键（batchFields），否则 MEMBER_HINT_REALTIME 要来的
 * memberNotes / conflicts 会被 zod 的非严格对象静默丢弃（见 REPORT_FIELDS 注释）——
 * 「提示词要了却落不了库」正是这张字段表存在的意义。
 */
export function batchSchema(batch: ReportBatch, member: boolean): z.ZodTypeAny {
  return llmContract(pickFields(batchFields(batch, member)))
}

/**
 * 一条出处的估算规模（模型照抄素材 url 时的长度；写成媒体名时更短）—— 按大的算。
 * 全篇的出处字段都走这个数：basics 里的 basis、dynamics 的 url、quotes 的 source。
 */
const OUTPUT_EST_BASIS_CHARS = 80
/** JSON 结构开销：每个条目一对键名 + 引号 + 逗号（约 20 字），每批另有一层外壳（约 80 字） */
const OUTPUT_EST_ITEM_OVERHEAD_CHARS = 20
const OUTPUT_EST_BATCH_OVERHEAD_CHARS = 80

/**
 * **单批正文的可用预算**（token）：`chatMaxTokens × (1 − reasoningReserve)`。
 * 推理模型的思考同样计入 max_tokens，故不能拿整个 max_tokens 当正文的家底。
 */
export const OUTPUT_BUDGET_TOKENS = Math.floor(
  REPORT_OUTPUT_BUDGET.chatMaxTokens * (1 - REPORT_OUTPUT_BUDGET.reasoningReserve)
)

/**
 * 每个字段的**输出规模估算**（条数 × 每条字数）—— 「输出预算」这件事在端上的落点。
 *
 * 只有两个用处：test/cases/20 逐批求和后与 OUTPUT_BUDGET_TOKENS 比；以及改字段 / 放条数时
 * 先看一眼「这一动会把这批推到哪里」。为什么可以只靠「估算」：这里要拦的不是几十 token 的偏差，
 * 而是**量级** —— 某一批的正文是不是已经逼近 max_tokens（撞上的代价是整批截断，见
 * REPORT_OUTPUT_BUDGET 的注释）。故口径一律取**上界**：
 *   · 条数取提示词允许的上限（模型多写会被端上裁掉 = 白写，却照样花掉输出限额）；
 *   · 字数取提示词给的区间上界与 REPORT_FIELD_LIMITS 的裁剪线中**较大**者（两者刻意不同刻度，
 *     见 REPORT_QUOTAS 的注释）；
 *   · 保守取 1 字 ≈ 1 token（见 REPORT_OUTPUT_BUDGET.charsPerToken）。
 *
 * ⚠ 每加一个字段就要在这里补一行：用例 20 会检查「每一批的每个字段都有估算」，漏了即红
 *   （估算器把漏掉的字段记进 `unevaluated`，不会静默按 0 算）。这条检查真正拦的是
 *   **规模不可封顶的字段** —— 条数不能是「用到的素材数」这种没有上限的量
 *   （facts 批此前的 sources 清单就是这么被赶下架的，见提示词池第 5 条删除处的注释）。
 */
export const FIELD_OUTPUT_ESTIMATE: Record<string, { count: number; chars: number }> = {
  /* 基本档案（identity） */
  intro: { count: 1, chars: 150 }, // 第 2 条：2~3 句、80~150 字
  verdict: { count: 1, chars: 120 }, // 第 16 条：summary 60 + positioning 60
  reputation: { count: 1, chars: 120 }, // 第 17 条：正面 60 + 负面 60
  consistency: { count: 1, chars: 120 }, // 第 17 条：claim / act / gap 各 40
  profile: {
    count: REPORT_FIELD_LIMITS.profileMax, // 第 9 条：3~6 条
    chars:
      REPORT_FIELD_LIMITS.profileLabelChars +
      REPORT_FIELD_LIMITS.profileValueChars +
      OUTPUT_EST_BASIS_CHARS
  },
  relations: {
    count: REPORT_FIELD_LIMITS.relationMax, // 第 10 条：最多 5 条
    chars:
      REPORT_FIELD_LIMITS.relationNameChars +
      8 /* 关系词（「导演」）*/ +
      REPORT_FIELD_LIMITS.relationNoteChars +
      OUTPUT_EST_BASIS_CHARS
  },
  /* 事实（facts）—— 见 BATCH_SPEC.facts 的注释：最大的一批，且是达标判定的单点 */
  dynamics: {
    // 第 3 条：3~6 条，每条 date 10 + title 40 + summary 60 + source 12 + url + sentiment 8
    count: REPORT_QUOTAS.dynamicsMax,
    chars: 10 + 40 + 60 + 12 + OUTPUT_EST_BASIS_CHARS + 8
  },
  quotes: {
    // 第 4 条：2~5 条，每条原文 80 + 语境 30 + 背景/注解（quoteNoteChars）+ 出处
    count: REPORT_QUOTAS.quotesMax,
    chars: 80 + 30 + REPORT_FIELD_LIMITS.quoteNoteChars + OUTPUT_EST_BASIS_CHARS
  },
  /* 判断与风险（judgement） */
  analysisPoints: {
    // 第 6 条：3~4 条，每条判断（裁剪线 80，提示词 40 → 取大）+ 出处
    count: REPORT_FIELD_LIMITS.analysisPointMax,
    chars: REPORT_FIELD_LIMITS.analysisPointChars + OUTPUT_EST_BASIS_CHARS
  },
  stance: {
    // 第 7 条：2~4 条，每条话题 12 + 态度 10 + 说明 60（与 analysisPointChars 同档）
    count: REPORT_QUOTAS.stanceMax,
    chars: 12 + 10 + 60
  },
  controversies: {
    // 第 13 条：最多 3 条，每条争点 + 说法 + 回应 + 出处
    count: REPORT_FIELD_LIMITS.controversyMax,
    chars:
      REPORT_FIELD_LIMITS.controversyTopicChars +
      REPORT_FIELD_LIMITS.controversyClaimChars +
      REPORT_FIELD_LIMITS.controversyResponseChars +
      OUTPUT_EST_BASIS_CHARS
  },
  /* 会员段（只加在承载它的那一批上，见 batchFields） */
  memberNotes: { count: 1, chars: REPORT_FIELD_LIMITS.memberNoteChars * 2 }, // compare + risk 各一段
  conflicts: {
    count: REPORT_FIELD_LIMITS.conflictMax,
    chars:
      REPORT_FIELD_LIMITS.conflictTopicChars +
      REPORT_FIELD_LIMITS.conflictSideChars * 2
  },
  /* 细节与延伸（detail） */
  timeline: {
    // 第 8 条：3~8 条（裁剪线 8，提示词目标 5 → 取大），每条日期 + 事件
    count: REPORT_FIELD_LIMITS.timelineMax,
    chars: REPORT_FIELD_LIMITS.timelineDateChars + REPORT_FIELD_LIMITS.timelineEventChars
  },
  watchlist: {
    // 第 11 条：最多 4 条，每条时点 + 关注点 + 出处
    count: REPORT_FIELD_LIMITS.watchMax,
    chars:
      REPORT_FIELD_LIMITS.watchWhenChars +
      REPORT_FIELD_LIMITS.watchWhatChars +
      OUTPUT_EST_BASIS_CHARS
  },
  glossary: {
    // 第 12 条：最多 5 条，每条词 + 解释
    count: REPORT_FIELD_LIMITS.glossaryMax,
    chars: REPORT_FIELD_LIMITS.glossaryTermChars + REPORT_FIELD_LIMITS.glossaryExplainChars
  }
}

export interface BatchOutputEstimate {
  key: ReportPartKey
  /** 计入估算的字段（会员档含 memberNotes / conflicts） */
  fields: string[]
  /** 条目总数 */
  items: number
  /** 估算正文规模（字） */
  chars: number
  /** 估算 token（保守：1 字 ≈ 1 token） */
  tokens: number
  /** 占 OUTPUT_BUDGET_TOKENS 的比例：> 1 = 这一批可能撞 max_tokens 被整批截断 */
  ratio: number
  /** 没有估算表条目的字段（应为空；非空 = 预算算漏了，用例 20 会红） */
  unevaluated: string[]
}

/**
 * 按字段估算表把某一批的输出规模算出来（`member` = 这次是不是会员生成）。
 * 不参与请求，只为校验与「改字段前先看一眼」服务。
 */
export function estimateBatchOutput(batch: ReportBatch, member = false): BatchOutputEstimate {
  const fields = batchFields(batch, member)
  const unevaluated: string[] = []
  let items = 0
  let chars = OUTPUT_EST_BATCH_OVERHEAD_CHARS
  for (const field of fields) {
    const est = FIELD_OUTPUT_ESTIMATE[field]
    if (!est) {
      /* 不按 0 静默算：漏估算意味着预算少算了这一块，必须让用例看见 */
      unevaluated.push(field)
      continue
    }
    items += est.count
    chars += est.count * (est.chars + OUTPUT_EST_ITEM_OVERHEAD_CHARS)
  }
  const tokens = Math.ceil(chars / REPORT_OUTPUT_BUDGET.charsPerToken)
  return { key: batch.key, fields, items, chars, tokens, ratio: tokens / OUTPUT_BUDGET_TOKENS, unevaluated }
}

/**
 * 契约字段的键名清单（REPORT_FIELDS 未导出，这里是给用例看的只读视图）。
 * 用例 20 用它校验「批的字段并集 = 契约字段 − 降级专用字段」，即「模型要写的字段一处不差」。
 */
export const REPORT_FIELD_KEYS: string[] = Object.keys(REPORT_FIELDS)

/**
 * 不在任何一批里的字段：只走**降级简版**（SYSTEM_FALLBACK 那条纯文本路径，见 sanitizeReport）。
 * 除它以外的每个契约字段都必须被某一批认领 —— 否则就是「提示词里要了、没人负责写」。
 */
export const OFF_BATCH_FIELDS: string[] = ['analysis']

/**
 * 第 15 条（「写满」）的字段清单按批替换：只列本批要写的字段，免得模型照单去写别的分组的字段。
 * 池里那条留着占位符（RULE_FIELDS_PLACEHOLDER），文本仍只有一份。
 */
const ruleFill = (fields: string[]): string =>
  ruleLines([15])[0].replace(RULE_FIELDS_PLACEHOLDER, fields.join(' / '))

/**
 * 某一批的 system = 共用硬约束 + 本批范围 + 本批认领的要求 + 写满 + 本批 JSON 格式 + 补充要求。
 * 会员补充**只**追加在承载会员段的那一批（judgement）上：免费提示词逐字节不变（见 MEMBER_HINT_REALTIME）。
 */
export function buildReportSystem(batch: ReportBatch, focus: FocusCode, member: boolean): string {
  const group = TOC_GROUPS.find((item) => item.key === batch.key)
  /*
   * 这里刻意用**批的静态字段**（batch.fields）而不是 member 感知的 batchFields：
   * 会员段由末尾的 MEMBER_HINT_REALTIME 自己点名（「额外输出 memberNotes 与 conflicts」），
   * 若把这两个键塞进本批的字段清单（本段与第 15 条），会员的 system 就不再是
   * 「免费 system + 末尾追加」—— 那会让「免费提示词逐字节不变」这条硬约束只对未承载会员段的批成立，
   * 而对真正多付钱的会员批失效（这一条正是 MEMBER_HINT_REALTIME 注释里反复强调的）。
   * 解析契约另走 batchFields（见 batchSchema）：**必须**声明这两个键，否则 zod 会把它们静默丢弃。
   */
  const fields = batch.fields
  const head = [
    SYSTEM_SHARED_REALTIME,
    `本批只负责「${group ? group.label : batch.key}」这一组字段：${fields.join(' / ')}。其余分组由并行的另几次调用负责，**不要输出本批以外的字段**，也不要用空数组占位。`,
    ...ruleLines(batch.ruleIds),
    ruleFill(fields),
    batch.format
  ].join('\n')
  const hints = [
    /* 侧重（FOCUS_HINT_REALTIME）每一批都追加：它点名的是跨组的字段（dynamics / quotes /
       timeline…），只追加到某一批会让「侧重」在其余组里静默失效；它只有一两百字，四批都带也便宜。 */
    FOCUS_HINT_REALTIME[focus],
    member && batch.memberFields ? MEMBER_HINT_REALTIME : ''
  ].filter((hint) => hint !== '')
  return hints.length > 0 ? `${head}\n${hints.join('\n')}` : head
}

/**
 * 会员专属段落的补充提示（O-11）：**只追加在会员的 system 末尾**，免费提示词逐字节不变
 * （不给免费用户白付这两段的 token，也避免免费报告的 JSON 里出现空字段）。
 * 与 FOCUS_HINT_REALTIME 同一写法：补充要求叠在**承载会员段的那一批**（judgement）的 system 末尾，
 * 不另起一套提示词（见 buildReportSystem）。
 */
const MEMBER_HINT_REALTIME = [
  '会员补充要求：额外输出 memberNotes 与 conflicts（**无素材支撑就留空**，不得为了凑数而编）。',
  'memberNotes 含两段文字，两段都要**具体、可核对，禁止套话**。',
  'compare（与同领域其他公众人物的差异或相对位置，2~3 句）：比较对象**必须具名**（写清是谁，须出自素材）；差异必须落到**具体可核对的事实**（作品、奖项、数据、事件、路径），**禁止「行业新锐」「代表人物」「更有影响力」「值得关注」这类评价套话**。素材里没有可具名的比较对象时，改写「该名人的辨识度 / 独特点」，同样要落到素材里的具体事实；**写不出具体事实就填空串**（禁止用套话占位）。',
  'risk（**面向未来**的风险提示，即接下来值得留意什么；措辞中性、就事论事、不做人身评价）：必须落到素材里**已经出现的前兆**（如被调查、合作方解约、卷入诉讼、税务问题）并写清具体是什么，**禁止「注意合规风险」「注意舆情」「存在不确定因素」这类泛话**；**已经发生的争议与回应属于免费段 controversies，不要在这里复述**；**素材里没有可指认的前兆就填空串**。',
  `conflicts：素材之间**互相矛盾**的地方（同一件事两边说法不一致、关键数字对不上、一方否认另一方的说法），最多 ${REPORT_FIELD_LIMITS.conflictMax} 条，每条字段：topic(争点，12 字内)、a(一方说法，写清是哪家媒体、说了什么)、b(另一方说法，同 a)。两方都必须真实存在于素材中，不得自己想象一个对立面；素材里没有矛盾就留空数组。`,
  '格式追加：{"memberNotes":{"compare":string,"risk":string},"conflicts":[{"topic":string,"a":string,"b":string}]}'
].join('\n')

/** 降级纯文本提示词（结构化 JSON 两次失败后，§5.4 用例 9） */
const SYSTEM_FALLBACK = [
  '你是名人动态分析师。结构化生成暂时不可用，请用不超过 150 字的纯文本，',
  '基于已有知识客观概述该名人的身份与近期公开动向要点。',
  '要求：不编造具体日期与来源；不输出 JSON；措辞中性；若不确定的信息直接略过。'
].join('\n')

/**
 * 「无素材兜底」提示词（C，2026-10-10）—— 只在**所有源与档位都没抓到内容**时使用。
 *
 * 与上面 SYSTEM_FALLBACK 的区别：那条是「素材抓到了、但结构化失败」的抢救，
 * 这条是「素材一条都没有」时手里唯一还剩的东西。所以约束必须更紧：
 *   · 只用**稳定事实**（身份 / 职业 / 代表作 / 机构 / 出生年份 / 出生地）；
 *   · 不确定的一律留空 —— 这是它唯一的安全阀，宁可少写也不能写错；
 *   · **明令禁止日期、事件、动态、争议、言论**：那些会过时或记错，而本工具的价值恰恰建立在
 *     「只基于素材、不做推断」上，这条兜底不该成为编造的后门；
 *   · 产物由 buildKnowledgeFallback 打上 `knowledgeOnly` 标记，页面明说「未经核实」。
 */
const SYSTEM_KNOWLEDGE_FALLBACK = [
  '你是名人资料助手。本次**没有检索到任何公开素材**，只能使用你已有的知识作答。',
  '严格要求（按重要性排序）：',
  '1. 只写你**确定知道**的稳定事实：身份 / 职业 / 代表作 / 所属机构 / 出生年份 / 出生地。',
  '2. **不确定的一律留空**，不要猜、不要用「可能」「据传」来糊。宁可只写一句，也不要写错。',
  '3. **禁止写任何日期、事件、近期动态、争议、言论、评价** —— 它们会过时或记错。',
  '4. 只输出 JSON，不要任何解释：{"intro":string}',
  '5. intro 为 2~3 句、60~140 字；若你对这个人几乎一无所知，就返回 {"intro":""}。'
].join('\n')

/** 无素材兜底的返回结构：只收 intro —— profile 要出处，模型知识给不出（见 Report.knowledgeOnly） */
const KnowledgeFallbackSchema = z.object({ intro: looseStr() })

/**
 * 无素材兜底：所有检索源与档位都没抓到内容时，用模型的已有知识给一份**只含简介**的报告。
 *
 * 为什么只给 intro：`profile` 的契约是「每条都带素材出处、能回到一篇原文核对」
 * （见 ProfileItemSchema 的 basis 注释），而模型知识给不出出处 —— 塞进 profile 会毁掉那条
 * 契约。「每条都能核对」是这份报告的立身之本，不能为了「页面看起来满」而放弃。
 *
 * 返回 `ok:false` 表示这次兜底也没给出可用内容（模型对该人物确实没把握）：调用方据此照旧走
 * `nonews` 空态 —— **不会**给用户一份空壳报告。
 *
 * ⚠ 调用点见 utils/cache.ts 的 nonews 分支：**不写共享缓存、不消耗用户的生成次数**。
 */
export async function buildKnowledgeFallback(
  personKey: string,
  name: string,
  focus: FocusCode = 'all'
): Promise<ChatJSONResult<Report>> {
  const result = await chatJSON(SYSTEM_KNOWLEDGE_FALLBACK, `人物：${name}`, KnowledgeFallbackSchema)
  if (!result.ok) return result

  /* chatJSON 的返回被推断成宽类型，这里收敛一次（字段只有一个，不必为它再引一层类型别名） */
  const { intro: rawIntro } = result.data as { intro?: string }
  const intro = (rawIntro ?? '').trim()
  /* 空串 = 模型对这个人物确实没把握：这次兜底没有价值，交回上层走空态 */
  if (!intro) return { ok: false, error: '模型对该人物没有可用的既有资料', retryable: false }

  return {
    ok: true,
    data: {
      personKey,
      name,
      mode: 'realtime',
      generatedAt: new Date().toISOString(),
      heat: 0,
      intro,
      dynamics: [],
      quotes: [],
      analysis: '',
      timeline: [],
      sources: [],
      disclaimer: DISCLAIMER,
      focus,
      knowledgeOnly: true,
      /* 素材一条都没有：画像给全零，页面据此显示「本次未检索到素材」（而不是「检索失败」） */
      coverage: buildCoverage([])
    }
  }
}

/*
 * 下面这一组**长度与条数上限**的数值全部在 config/benefits.ts（REPORT_BUDGET /
 * REPORT_FIELD_LIMITS / REPORT_SOURCE），每条为什么取这个值也写在那里。
 * 这里只做转发，是为了让本文件下面上百处引用不必跟着改名 ——
 * 要调报告厚度 / 裁剪尺度，改真源那一份（改完跑 npm run config:sync）。
 */
const MAX_ITEM_CHARS = REPORT_BUDGET.maxItemChars
const MAX_USER_CHARS = REPORT_BUDGET.maxUserChars
const MAX_USER_CHARS_MEMBER = REPORT_BUDGET.maxUserCharsMember

const MEMBER_NOTE_CHARS = REPORT_FIELD_LIMITS.memberNoteChars
const QUOTE_NOTE_CHARS = REPORT_FIELD_LIMITS.quoteNoteChars

const ANALYSIS_POINT_CHARS = REPORT_FIELD_LIMITS.analysisPointChars
const ANALYSIS_POINT_MAX = REPORT_FIELD_LIMITS.analysisPointMax

const CONFLICT_TOPIC_CHARS = REPORT_FIELD_LIMITS.conflictTopicChars
const CONFLICT_SIDE_CHARS = REPORT_FIELD_LIMITS.conflictSideChars
const CONFLICT_MAX = REPORT_FIELD_LIMITS.conflictMax

/* ----- 第二批（免费可见的五段事实字段）：长度与条数上限 -----
 *
 * 这几段的共同点是「一段一条事实」，故各档上限都贴着「一条事实说清楚」的尺度定，
 * 与 stance.note（60 字）、analysisPoints（80 字）同一套克制：数值不同只是体裁不同，
 * 依据都是「超过就不再是一条，而是又变回一段综述」。 */
const PROFILE_MAX = REPORT_FIELD_LIMITS.profileMax
const PROFILE_LABEL_CHARS = REPORT_FIELD_LIMITS.profileLabelChars
const PROFILE_VALUE_CHARS = REPORT_FIELD_LIMITS.profileValueChars

const RELATION_MAX = REPORT_FIELD_LIMITS.relationMax
const RELATION_NAME_CHARS = REPORT_FIELD_LIMITS.relationNameChars
const RELATION_NOTE_CHARS = REPORT_FIELD_LIMITS.relationNoteChars

/* 时间线（P1，2026-10-11）：与 watchlist / glossary 同批产出（REPORT_BATCHES.detail），
 * 但落库口径单独一组 —— 它的 date 是端上「按年分块」的输入，夹进控制符会让年份判错，
 * 见 sanitizeReport 里 timeline 处的注释。 */
const TIMELINE_MAX = REPORT_FIELD_LIMITS.timelineMax
const TIMELINE_DATE_CHARS = REPORT_FIELD_LIMITS.timelineDateChars
const TIMELINE_EVENT_CHARS = REPORT_FIELD_LIMITS.timelineEventChars

const WATCH_MAX = REPORT_FIELD_LIMITS.watchMax
const WATCH_WHEN_CHARS = REPORT_FIELD_LIMITS.watchWhenChars
const WATCH_WHAT_CHARS = REPORT_FIELD_LIMITS.watchWhatChars

const GLOSSARY_MAX = REPORT_FIELD_LIMITS.glossaryMax
const GLOSSARY_TERM_CHARS = REPORT_FIELD_LIMITS.glossaryTermChars
const GLOSSARY_EXPLAIN_CHARS = REPORT_FIELD_LIMITS.glossaryExplainChars

const CONTROVERSY_MAX = REPORT_FIELD_LIMITS.controversyMax
const CONTROVERSY_TOPIC_CHARS = REPORT_FIELD_LIMITS.controversyTopicChars
const CONTROVERSY_CLAIM_CHARS = REPORT_FIELD_LIMITS.controversyClaimChars
const CONTROVERSY_RESPONSE_CHARS = REPORT_FIELD_LIMITS.controversyResponseChars

/* ===== 素材 → 提示词的选取（事件归组 + 分级保留） ===== */
const FULL_ITEM_COUNT = REPORT_SOURCE.fullItemCount
const BRIEF_ITEM_CHARS = REPORT_SOURCE.briefItemChars
const SAME_EVENT_RATIO = REPORT_SOURCE.sameEventRatio
const TITLE_MATCH_MIN_CHARS = REPORT_SOURCE.titleMatchMinChars
/* L1：句子级抽取与同源判重（数值真源同样在 config/benefits.ts#REPORT_SOURCE） */
const EXTRACT_MIN_CHARS = REPORT_SOURCE.extractMinChars
const RELEVANT_ITEM_CHARS = REPORT_SOURCE.relevantItemChars
const SAME_BODY_RATIO = REPORT_SOURCE.sameBodyRatio

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

/*
 * ═══ L0：素材正文的零语义损失精简（2026-10-10） ═══
 *
 * 目标：不删任何素材、不碰分级规则、不改提示词结构，只把「按字计费却对报告零贡献」的
 * 部分挡在提示词之外。三层优化里的第一层，风险必须为零 —— 报告是全局共享缓存。
 */

/**
 * 网页版面的样板行首词：博查的 content 是**整页正文的机器摘要**，尾部常挂着一批与新闻本身
 * 无关的样板文字（「责任编辑：张三」「原标题：…」「点击进入专题」「更多精彩内容请下载…」
 * 「版权声明」「相关推荐」）。它们对报告零贡献，却按字计费 —— 单条上限 1000 字时这类尾巴
 * 能吃掉一成以上的预算。
 */
const NOISE_LINE_HEADS = [
  '责任编辑',
  '责编',
  '编辑',
  '来源',
  '原标题',
  '本文来源',
  '文章出处',
  '版权声明',
  '免责声明',
  '特别声明',
  '未经授权',
  '转载请注明',
  '转载请',
  '点击查看',
  '点击进入',
  '点击阅读',
  '更多精彩',
  '更多内容',
  '相关推荐',
  '相关阅读',
  '延伸阅读',
  '猜你喜欢',
  '热门推荐',
  '扫码关注',
  '长按识别',
  '关注我们',
  '投稿邮箱'
]

/**
 * 单行是否「整行都是版面样板」。
 *
 * 判据刻意收得很紧：**行首命中词表 + 后接分隔符或空格 + 整行够短**。三者缺一即不判样板 ——
 * 「来源：新华社」是样板，而「来源不明的传闻在社交平台扩散」是正文本身。宽松匹配（只要行里
 * 出现「来源」就删）会把真新闻删掉，猜错的代价是往共享缓存里写坏内容。
 */
function isNoiseLine(line: string): boolean {
  const s = line.trim()
  if (s === '') return false
  for (const head of NOISE_LINE_HEADS) {
    if (!s.startsWith(head)) continue
    const tail = s.slice(head.length)
    if (/^[\s:：]/.test(tail) && s.length <= head.length + 40) return true
  }
  return false
}

/**
 * 剥离正文里的样板行。只做整行删除，不做行内裁剪 —— 「这句话有没有用」猜不出来，猜错就是坏内容
 * （与 utils/text 同一原则：只做确定性替换，不猜测内容）。
 *
 * 兜底：若剥离后一行不剩，判据在本条上明显失灵（正文恰好全是「编辑」「来源」开头的短句），
 * 原样返回 —— 宁可多带噪声，也不能让一条素材变成空正文。
 */
function pruneNewsBody(text: string): string {
  if (text === '') return text
  const lines = text.split('\n')
  const kept = lines.filter((line) => !isNoiseLine(line))
  if (kept.every((line) => line.trim() === '')) return text
  return kept.join('\n').trim()
}

/*
 * ═══ L1：正文的句子级抽取与同源判重（2026-10-10） ═══
 *
 * 全文条目是输入的大头（10 条 × 1000 字 ≈ 免费档预算的三分之二），而报告真正用得上的
 * 只是其中一部分句子。这一层做两件事，**只动正文、不动条数与出处**：
 *   · 抽取：首句（导语）必留，其余按信号（人名 / 引语 / 数字）挑**整句**，不足再按序补齐；
 *   · 判重：同事件组内与组代表几乎是同一篇稿的（通讯社供稿被多家转载），不再重复送正文片段。
 * 抽出来的一律是**原文切片** —— 不是模型改写、不是摘要生成，所以出处仍然对得上，
 * 「事实仅基于素材、每条可溯源」这条契约不受影响。
 */

/** 句子切分：句末标点 / 换行后断句，标点留在前一句里（不丢字符） */
const SENTENCE_END = '。！？；!?;\n'
/** 判重的可比长度：太短的正文算相似度没有意义（三五个字也可能「很像」），不参与判定 */
const SAME_BODY_MIN_CHARS = 100
/** 判重只比正文开头这一段：转载的差异通常在结尾的站点尾巴上，开头几乎逐字相同 */
const SAME_BODY_PROBE_CHARS = 400

/** 判重用的归一化正文：去样板行、去空白（标点保留 —— 标点是句子结构的证据） */
function normalizeBody(text: string): string {
  return pruneNewsBody(text).replace(/\s+/g, '')
}

/**
 * 切句：按码点遍历逐个字符判断，不用正则 lookbehind（老 iOS 的 JSCore 会让整个正则字面量
 * 编译失败，同 utils/text#dropLoneSurrogates 的取舍）。
 */
function splitSentences(text: string): string[] {
  const out: string[] = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (SENTENCE_END.indexOf(ch) >= 0) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf !== '') out.push(buf)
  return out.filter((s) => s.trim() !== '')
}

/**
 * 句子信号：含人名（+3，报告所有事实字段都围着这个人转）、含引号（+2，引语是 quotes 的原料）、
 * 含数字（+1，票房 / 档期 / 年份这类硬信息）。
 *
 * 刻意不给「长句加分」：长句多半是复述与背景铺垫，恰恰是压缩最该砍的部分。
 */
function sentenceScore(sentence: string, name: string): number {
  let score = 0
  if (name !== '' && sentence.includes(name)) score += 3
  if (/[「」『』“”‘’"']/.test(sentence)) score += 2
  if (/\d/.test(sentence)) score += 1
  return score
}

/**
 * 句子级抽取：保序、保原文，只决定「留哪几句」。
 *
 * 三处兜底都是「宁可少省，不可写坏」：
 *   · 短正文不抽（< extractMinChars）：省不下几个字，白担一层「看到的不是连续原文」的风险；
 *   · 切不出多句就原样返回（无标点的正文、或本来就只剩两句）：抽取在此条上失效，不动它；
 *   · 第二轮按序补齐到目标：信号不足时不能只留几句，句间上下文断掉后模型更容易读歪 ——
 *     补进来的同样是整句原文，只是不带信号。
 */
function extractRelevantBody(body: string, name: string): string {
  if (body.length <= EXTRACT_MIN_CHARS) return body
  const sentences = splitSentences(body)
  if (sentences.length <= 2) return body

  const target = Math.min(RELEVANT_ITEM_CHARS, body.length)
  const picked: boolean[] = new Array(sentences.length).fill(false)
  /* 首句是导语：时间 / 地点 / 事件一句话交代，删了它后面的句子就没有锚点 */
  picked[0] = true
  let used = sentences[0].length

  for (let i = 1; i < sentences.length && used < target; i++) {
    if (sentenceScore(sentences[i], name) === 0) continue
    picked[i] = true
    used += sentences[i].length
  }
  for (let i = 1; i < sentences.length && used < target; i++) {
    if (picked[i]) continue
    picked[i] = true
    used += sentences[i].length
  }
  /* 一句都没裁掉：省不出字符时返回原文，不制造无意义的差异 */
  if (used >= body.length) return body
  return sentences.filter((_, i) => picked[i]).join('')
}

/** 同源判重：两条正文在开头这 400 字里的字符二元组重合度（复用标题归组的 Dice） */
function isSameBody(a: string, b: string): boolean {
  if (a.length < SAME_BODY_MIN_CHARS || b.length < SAME_BODY_MIN_CHARS) return false
  return (
    dice(bigrams(a.slice(0, SAME_BODY_PROBE_CHARS)), bigrams(b.slice(0, SAME_BODY_PROBE_CHARS))) >=
    SAME_BODY_RATIO
  )
}

/** 素材段落（全文）：标题 / 来源 / url 前置，正文经 L1 抽取后随后 */
function fullItemText(n: NewsItem, name: string): string {
  const body = extractRelevantBody(pruneNewsBody(n.content), name)
  const content = body.length > MAX_ITEM_CHARS ? `${clipText(body, MAX_ITEM_CHARS)}…` : body
  return `- ${n.title}（${n.source}）${n.url}\n${content}`
}

/**
 * 素材段落（压缩）：标题 / 来源 / url 全部保留（引用与溯源不受影响），只把正文换成片段。
 * 「正文从略」四个字是给模型看的信号：这条的细节它并不掌握，不该据此展开叙述。
 *
 * 截断走 clipText 而非裸 slice：单条正文的上限是**按字算预算**的地方，裸 slice 按 UTF-16
 * 码元切会把 emoji / 生僻字切成半个字符，落进提示词后被模型照抄（同 utils/text 的口径）。
 *
 * `dropBody`（L1）：与组代表同一篇稿的转载条目只留出处行 —— 标记不变（仍是「正文从略」），
 * 所以条数与溯源完全不受影响，省掉的只是重复文字。
 */
function briefItemText(n: NewsItem, dropBody = false): string {
  const head = `- ${n.title}（${n.source}）${n.url}\n（正文从略）`
  if (dropBody) return head
  const flat = pruneNewsBody(n.content).replace(/\s+/g, ' ')
  const snippet = clipText(flat, BRIEF_ITEM_CHARS)
  return `${head}${snippet}${flat.length > BRIEF_ITEM_CHARS ? '…' : ''}`
}

/**
 * 背景资料段（P1，2026-10-10，配合 utils/search.ts#fetchBackground）。
 *
 * 为什么必须**单独成段**，而不是把两路素材混成一个数组：
 *   · dynamics（近期动态）是报告最核心的一节，判据就是「近期」。背景线的 freshness 是
 *     noLimit，混进同一份「素材」里，模型很容易把一条三年前的履历报道写成本周动态；
 *   · 分成两段，模型才看得见「哪些是背景、哪些是近期」，各归各的节。
 *
 * 严格程度：**整体进 / 整体不进**（不做逐条裁剪），条目超上限时丢尾部 —— 背景段是补充，
 * 宁缺毋滥；它的长度也从主线预算里扣掉（见 buildUserMessage），不让 user 消息冲破通道上限。
 */
const BACKGROUND_HEAD = [
  '人物背景资料（不限时间，可能较旧）：',
  '用途限定 —— 只用于 profile（人物档案）/ relations（关系图谱）/ timeline（经历履历）与 glossary；',
  '**不要**据此写 dynamics（近期动态）与 controversies（争议与回应）：那两段只认上面「素材」里的内容。',
  '出处的写法与上面一致：url 从下面各条原样复制。'
].join('\n')

/** 背景资料段的字数上限（约 12 条压缩条目）；这段长度从主线预算里扣，见 buildUserMessage */
const MAX_BACKGROUND_CHARS = 3000

/*
 * ═══ L2：素材按报告模板的用途分块（2026-10-10） ═══
 *
 * 模板里各节的「食性」不同：dynamics / timeline / analysisPoints / stance 吃事件与时间，
 * quotes / controversies 只吃原话。分成两块呈现，块头一句话点明用途，模型不必自己在一堆
 * 条目里翻找「哪条有原话」。分块只改**呈现顺序**，条数、出处、压缩标记一律不动。
 */
const DYNAMIC_HEAD =
  '【动态事件】以下条目含可确认的事件与时间（dynamics / timeline / analysisPoints / stance 取用）：'

/** 另一块：只放带得动引语的条目 */
const QUOTE_HEAD = '【言论表态】以下条目含可直接引用的原话（quotes / controversies 取用）：'

/**
 * 一条素材里是否有**可引用的原话**（L2 的归类判据）。
 *
 * 判据是「引号里夹着 10 个字以上」，而不是「正文里有引号」：新闻稿里的引号太常见
 * （「某某表示」几乎每段都有），只按「有引号」分类会让绝大多数条目涌进言论块，分块就白分了。
 */
const QUOTABLE_INLINE = /[「“"][^」”"]{10,}[」”"]/

function hasQuotableLine(content: string): boolean {
  return QUOTABLE_INLINE.test(content)
}

/** 背景素材 → 提示词里的一段；空数组返回空串，调用方据此不加那一段 */
function buildBackgroundText(background: NewsItem[]): string {
  if (background.length === 0) return ''
  const out = [BACKGROUND_HEAD]
  let used = BACKGROUND_HEAD.length
  let dropped = 0
  for (const n of background) {
    const line = briefItemText(n)
    if (used + line.length + 1 > MAX_BACKGROUND_CHARS) {
      dropped++
      continue
    }
    out.push(line)
    used += line.length + 1
  }
  if (dropped > 0) diagLog('warn', 'db', `背景资料超预算，${dropped} 条未进提示词`)
  return out.join('\n')
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
  member = false,
  background: NewsItem[] = []
): string {
  /* 背景段先定稿：它**整体**占位，长度从总预算里扣（见下方 budget），主线才不会把它顶穿通道上限 */
  const bg = buildBackgroundText(background)
  /*
   * 块头的长度同样先从总预算里扣（多扣 8 字余量）：块头是固定开销，不占素材的额度，
   * 否则 final 会比通道上限多出两个块头的长度 —— 「user ≤ 上限」是硬约束，不能靠巧合成立。
   */
  const sectionOverhead = DYNAMIC_HEAD.length + QUOTE_HEAD.length + 8
  const budget =
    (member ? MAX_USER_CHARS_MEMBER : MAX_USER_CHARS) - (bg ? bg.length + 1 : 0) - sectionOverhead
  const head = [
    `名人：${name}`,
    `关注侧重：${focus === 'all' ? '综合（六段完整）' : FOCUS_LABEL[focus]}`,
    '素材（按用途分组）：'
  ]

  /* 先分组分档、再按预算拼装：预算只在这一步起作用，避免边算边丢 */
  type Line = { text: string; quote: boolean }
  const full: Line[] = []
  const brief: Line[] = []
  groupByEvent(news).forEach((g, gi) => {
    /*
     * 同一事件的其余报道一律压缩：它是重复信息，最该给别的事件让位。
     * L1：其中「正文与组代表几乎是同一篇稿」的（通讯社供稿被多家转载）连片段也不再重复送出 ——
     * 标记与普通压缩条目完全一致（仍是「正文从略」），条数与溯源不受影响，省掉的只是重复文字。
     * L2：每条顺带记下它归属哪一块（含可引用原话 → 言论块），归类只看内容，不重排、不拆条。
     */
    const leadBody = normalizeBody(g.lead.content)
    g.rest.forEach((n) =>
      brief.push({
        text: briefItemText(n, isSameBody(leadBody, normalizeBody(n.content))),
        quote: hasQuotableLine(n.content)
      })
    )
    const quote = hasQuotableLine(g.lead.content)
    if (gi < FULL_ITEM_COUNT) full.push({ text: fullItemText(g.lead, name), quote })
    else brief.push({ text: briefItemText(g.lead), quote })
  })

  /* used 恒等于 join('\n') 之后的真实长度：每条多算一个换行符，因此判断时要把换行一起算进去 */
  let used = head.join('\n').length
  const kept: Line[] = []
  for (const line of full) {
    /* 首条无论如何保留：模型拿到空素材会凭空作答，比截断更糟（沿用改造前的兜底） */
    if (kept.length > 0 && used + line.text.length + 1 > budget) break
    kept.push(line)
    used += line.text.length + 1
  }
  let dropped = 0
  for (const line of brief) {
    if (used + line.text.length + 1 > budget) {
      dropped++
      continue
    }
    kept.push(line)
    used += line.text.length + 1
  }
  if (dropped > 0) {
    /* 只看日志的 warn（不抛错）：报告仍然生成，只是尾部条目没进提示词 */
    diagLog('warn', 'db', `素材超预算，${dropped} 条压缩条目未进提示词（${name}）`)
  }

  /*
   * 出块：块内保持原有先后（事件组的顺序即重要性顺序），只把两类条目分开 ——
   * 预算判定仍在上面完成，所以「装不下时丢尾部」的行为一字未变，只是丢的对象换成了块内尾部。
   * 空块不输出块头：素材里一条可引用原话都没有时，不该留一个空标题给模型。
   */
  const dyn = kept.filter((l) => !l.quote).map((l) => l.text)
  const quo = kept.filter((l) => l.quote).map((l) => l.text)
  const parts = [head.join('\n')]
  if (dyn.length > 0) parts.push(DYNAMIC_HEAD, dyn.join('\n'))
  if (quo.length > 0) parts.push(QUOTE_HEAD, quo.join('\n'))
  /* 背景段追加在最末：它是补充材料，被截断的永远是它后面没有的东西（上面那一步已扣掉它的额度） */
  if (bg !== '') parts.push(bg)
  const final = parts.join('\n')

  /*
   * 规模度量（L0，2026-10-10）：这一行是「输入过大」的仪表盘 —— 只读日志、不改行为。
   * 全文段通常吃掉总预算的六到七成，调 L1/L2 之前先读它，别凭感觉砍素材：
   *   · full 条数贴住 FULL_ITEM_COUNT（=10）且 user 贴住 budget ⇒ 预算已被全文段吃满；
   *   · dropped > 0 ⇒ 连压缩条目都放不下了，是最该压缩的一档。
   * 云开发控制台的日志按 'db' 归类，与素材超预算那条 warn 同一频道，便于对照。
   */
  const fullCount = kept.filter((l) => !l.text.includes('（正文从略）')).length
  diagLog(
    'info',
    'db',
    `报告提示词规模（${name}${member ? '·会员' : ''}）：素材 ${fullCount} 全文 / ${kept.length - fullCount} 压缩` +
      `（动态 ${dyn.length} / 言论 ${quo.length}）` +
      `${dropped > 0 ? ` / 丢弃 ${dropped}` : ''}，user ${final.length} 字（预算 ${budget}，背景 ${bg.length} 字）`
  )
  return final
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
 * 一批的产出：批键 + 这一批通过契约的字段（只含本批字段，不含 refused）。
 * 中间结果落库（opts.onPart）与最终合并都以它为最小单位。
 */
export interface ReportPart {
  key: ReportPartKey
  data: LlmReportFields
}

/**
 * 生成报告（基于实时素材，无素材时由 utils/cache.ts 直接进引导态、不调用本函数）。
 * 只负责调 LLM + 校验；缓存互斥与中间结果落库由调用方（utils/cache.ts）负责。
 *
 * **分批生成（P0-B）**：按报告模板的分组（utils/report-toc.ts#TOC_GROUPS）拆成多次调用，
 * 每批只产出自己那几节，逐批合并（见下方 REPORT_BATCHES 与 buildReportSystem）。为什么拆：
 *   · 一次要 16 节时，任一节写坏或 max_tokens 撞上限都会让**整份**报告降级成纯文本；
 *     拆开后**失败只丢一组**，其余组照常合并落库（每批成功即回调 opts.onPart）。
 *   · 每批字段少，模型更容易按要求写满，也更少把 token 花在推理上。
 * 代价是调用次数从 1 次变 4 次 —— 可接受：报告是全局共享缓存，生成一次全站复用。
 *
 * `opts.member`（O-11 深度模式）：决定「要不要多要两段会员专属文字」与 user 消息预算。
 * 会员态**由调用方传入**（cache.ts 已在配额检查那次读数里拿到），这里不再多读一次库。
 *
 * `opts.onPart`：每批成功后的回调，收到**迄今累计**的批次结果（调用方可据此落库中间结果）。
 * 落库失败一律不影响生成（回调里的异常被这里吞掉），因为「报告能不能出」优先于「中间结果存没存上」。
 */
export async function buildReport(
  personKey: string,
  name: string,
  news: NewsItem[],
  focus: FocusCode = 'all',
  opts: {
    member?: boolean
    background?: NewsItem[]
    onPart?: (parts: ReportPart[]) => void | Promise<void>
  } = {}
): Promise<ChatJSONResult<Report | { refused: true }>> {
  const member = opts.member === true
  /*
   * 背景素材（P1，2026-10-10）：与 news **分开**传 —— 它进 user 消息里单独的「人物背景资料」段，
   * 且**不参与**热度与报道画像（那两项必须只用近期素材，否则同一个人「被谁生成过」会改变热度，
   * 跨档就不可比了，见 sanitizeReport 里的 HEAT_COUNT_CAP 注释）。
   * 分批后按批次的 background（由模板派生，见 REPORT_BATCHES）决定哪几批带它
   * （见 batch.background ? background : []）。
   */
  const background = opts.background ?? []
  const merged: LlmReportFields = {}
  const parts: ReportPart[] = []
  let done = 0
  /* 记住最后一次失败，供「四批全败」时把原因如实交回上层（而不是只说「降级也失败了」） */
  let lastFail: { error: string; retryable?: boolean; kind?: string } | null = null

  for (const batch of REPORT_BATCHES) {
    const fields = batchFields(batch, member)
    const system = buildReportSystem(batch, focus, member)
    const user = buildUserMessage(name, news, focus, member, batch.background ? background : [])
    const result = await chatJSON(system, user, batchSchema(batch, member))

    if (!result.ok) {
      /*
       * 云端闸门拦下（kind='quota' / 'abuse'）与上游欠费（'upstream_quota'）时**立即中止、不降级**：
       * 后面几批打的是同一个上游 / 同一道闸门，必然同样被拒，继续跑只是白等三轮往返，
       * 还把「额度用完」记成「生成失败」。直接把云端文案交回上层（不换文案的理由见原注释：
       * 平台账户问题被说成「你的额度用完了」，用户去额度页一看是满的，只会来问客服）。
       */
      if (result.kind === 'quota' || result.kind === 'abuse' || result.kind === 'upstream_quota') {
        diagLog('warn', 'auth', `云端 / 上游拦下（${result.kind}），不降级走纯文本：${result.error}`)
        return { ok: false, error: result.error, retryable: false, kind: result.kind }
      }
      /*
       * 其余失败只丢这一组：它是「这一批写坏了 / 网络抖了」，与后面的批无因果关系，
       * 继续跑不是白花 —— 已成功的批照常合并，缺的那几节在报告页表现为对应卡片不出现。
       * 冷却不在这里设：单批失败说明不了上游整体不可用（可能只是这一批偶发抖动），部分成功
       * 照常落库，此时设冷却反而挡住用户补缺/刷新。只有「四批全败」才值得拦（见 done === 0 分支）。
       */
      diagLog('warn', 'auth', `报告分批失败（${batch.key}），该组留空：${result.error}`)
      lastFail = result
      continue
    }

    const data = result.data as Record<string, unknown>
    if (isRefusedResult(data)) {
      /* 任一批拒答 ⇒ 整份拒答：第 14 条是全局条（见 SYSTEM_SHARED_REALTIME），
         不能因为「另外三批照常写了」就把一份敏感人物的报告拼出来 */
      diagLog('info', 'auth', `报告 LLM 拒答：${personKey}（${batch.key}）`)
      return { ok: true, data: { refused: true } }
    }

    /* 逐字段搬进 merged：各批字段互不重叠（模板分组天然切分），且只搬本批契约声明的键
       —— data 里可能混有 refused 等非字段键，整体 Object.assign 会把它们也带进报告 */
    const part: LlmReportFields = {}
    for (const field of fields) {
      const value = data[field]
      if (value === undefined) continue
      ;(merged as Record<string, unknown>)[field] = value
      ;(part as Record<string, unknown>)[field] = value
    }
    done++

    /* 中间结果落库：每批成功即回调 —— 后面几批失败时，前面这几批的 token 不作废。
       回调异常一律吞掉：中间结果存不上不该让整次生成失败（最终 save 才是关键路径）。 */
    parts.push({ key: batch.key, data: part })
    if (opts.onPart) {
      try {
        await opts.onPart(parts.slice())
      } catch (err) {
        diagLog('warn', 'db', `报告中间结果落库失败（${batch.key}）：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (done === 0) {
    /* 四批全败 —— 与原单次路径同款抢救：纯文本简版（§5.4 用例 9），不再套结构化 Schema */
    diagLog('warn', 'auth', `报告分批全部失败，降级纯文本：${lastFail ? lastFail.error : '无可用批次'}`)
    /*
     * 冷却只在整份都失败时设：此时才说明上游整体不可用（网络 / 上游 5xx / 429 限流），
     * 拦的是「立即重试同样会失败」的白等；密钥无效、通道未配置这类用户修好应立即可用，
     * 不该被冷却拖 10 分钟。retryable 由 RETRYABLE_KINDS=['upstream','network'] 界定，
     * 与这里的「值得等待」口径一致。单批失败（部分成功）已在上方跳过冷却。
     */
    if (lastFail && (lastFail.retryable || /频繁|429/.test(lastFail.error))) setCooldown('llm')
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

  /*
   * 合并后的字段仍是「模型给的原始形状」（各批契约都用了 .catch() 宽容兜底，而 zod 的 ZodCatch
   * 为了让兜底接住任何输入，把类型的 Input 拓宽成了 unknown），运行时有 zod 保证、且 sanitizeReport
   * 对每个字段都是防御式读取（?? ''），故这条边界用一个显式断言收掉（理由同原单次路径）。
   */
  const report = sanitizeReport(personKey, name, merged, news, focus, { background })
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
 * 1. dynamics 的 url 必须 ∈ 素材 url 集合，否则剔除；sources 干脆不由模型给 ——
 *    它是端上从报告里真引用到的素材派生的（见「来源清单」那段），端上派的，自然条条对得上
 * 2. quotes.source 为素材 url 或「据公开资料」，否则剔除
 * 3. heat 由 §1.6 公式本地计算；sentiment 已由 zod 枚举保证
 * 4. memberNotes 是会员专属段落，两段皆空则整段不落库（免费报告恒无此字段）
 * 5. analysisPoints 的 basis 同第 3 条（换成媒体名），空判断剔除、超 4 条截断；
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
  focus: FocusCode = 'all',
  opts: { background?: NewsItem[] } = {}
): Report {
  /* 出处索引：本函数所有段落共用。它把「模型抄歪一点的 URL」「写成媒体名」都算作有效出处
     （理由见 buildSourceIndex）—— 逐字符全等会把明明确定、只是写法不同的出处判成没有出处，
     代价是整条事实消失，而用户看到的就是「报告少了一块」。 */
  /*
   * ⚠ 背景线素材**只进这个索引**（P1，2026-10-10）：档案 / 关系 / 时间线的 basis 允许指向它，
   * 否则「用背景资料写出来的档案」会因指不出近期素材而被整条剔除 —— 那等于白跑一路检索。
   * 而下面的热度与报道画像**仍然只用 news**：背景素材不限时间，混进去会让 coverage 的
   * items / latestAt 失真，也会让同一个人「被谁生成过」改变 heat（跨档不可比）。
   */
  const srcIndex = buildSourceIndex([...news, ...(opts.background ?? [])])

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
      /* title / summary 是段落级文本（提示词只要一句摘要，但字段本身无上限），故只净化不截断 */
      title: cleanText(d.title) || cleanText(hit.title),
      summary: cleanText(d.summary),
      source: cleanText(d.source) || cleanText(hit.source),
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
      /* text 是语录原文、报告的核心内容：只净化不截断（把一句名言截半，等于改了它） */
      text: cleanText(q.text),
      context: cleanText(q.context),
      /* 背景 / 注解：自由文本，照旧「去空 + 收敛长度」；空串保留（UI 按空串决定渲不渲染那一段） */
      background: clipText(q.background, QUOTE_NOTE_CHARS),
      note: clipText(q.note, QUOTE_NOTE_CHARS),
      /* 落库用素材里的原始 URL：quote-check 要靠这一串精确对上动态 / 来源清单，
         两边都换成素材原串才匹配得上（此前是模型抄来的那串，抄歪了就永远对不上） */
      source: hit ? hit.url : '据公开资料'
    })
  }
  /*
   * 来源清单（2026-10-11 改为**端上派生**）：此前是模型输出的一段
   * `sources: [{title, url}]`，三宗罪：① 它是 facts 批（最大的一批）里最大的一块输出，
   * 且条数随「用到的素材数」增长 —— 预算无法静态封顶；② 内容全是端上已知的（标题 / URL
   * 本来就得用素材自身的，见下面注释）；③ 让模型抄 N 条 URL，恰是提示词自己承认
   * 「走形率很高」的动作。
   *
   * 现在改成：把报告里**真的点回原文的引用位**（动态 url、语录 source、各处 basis）反查一遍素材，
   * 命中的列出。于是「引用 N 篇」变成端上可核对的真值（模型说它用了哪几条，不算数）——
   * 而且每条都保证能点开（命中的是素材自身的 URL）。
   *
   * 顺序按素材自身顺序（不按引用出现的先后）：这片清单的用处是「这篇报告建立在哪些报道上」，
   * 与封面「素材」段的顺序一致才读得顺；背景线素材也算 —— 它同样是本次引用的公开素材。
   */
  const citedRaw = [
    ...(llm.dynamics ?? []).map((d) => d.url),
    ...(llm.quotes ?? []).map((q) => q.source),
    ...(llm.analysisPoints ?? []).map((p) => p.basis),
    ...(llm.profile ?? []).map((p) => p.basis),
    ...(llm.relations ?? []).map((r) => r.basis),
    ...(llm.watchlist ?? []).map((w) => w.basis),
    ...(llm.controversies ?? []).map((c) => c.basis)
  ]
  const citedUrl = new Set<string>()
  for (const raw of citedRaw) {
    const hit = matchNewsOf(raw, srcIndex)
    if (hit) citedUrl.add(hit.url)
  }
  const sources: Report['sources'] = []
  const seenSource = new Set<string>()
  for (const n of [...news, ...(opts.background ?? [])]) {
    /* 同一篇素材被两条报道带回同一个 URL（检索源偶发）：引用位对得上，清单里只留一条 */
    if (!citedUrl.has(n.url) || seenSource.has(n.url)) continue
    seenSource.add(n.url)
    sources.push({ title: cleanText(n.title), url: n.url })
  }
  /*
   * 时间线（P1，2026-10-11 补）：此前它是整个 sanitize 里**唯一**既不净化也不限量的段落 ——
   * 连裸 slice 都没有，模型原文原样落库。两条具体危害：
   *   · date 会进端上的年份分块（timelineGroups 按前 4 位切年份）：夹进一个零宽或控制符，
   *     「这条属于哪一年」就会判错，时间线上多出一段无标题的乱序块；
   *   · event 无上限：模型偶发写成整段综述时，一行能把整屏撑满。
   * 口径与其余各段对齐：date 有明确长度上限（走 clipText），event 是段落级文本（同样 clipText，
   * 上限给到「一句话」），去空后截到 timelineMax 条。**不重排**：时间线是模型按素材给的，
   * 端上重排会打乱「同年内先后」这个模型唯一把握得住的信息。
   * ⚠ 去空是行为收紧（原实现会把 event 为空的条目落库成一行空白）；端上本来就按条目渲染，
   *   空行没有任何信息，只会让横幅多一截。
   */
  const timeline = (llm.timeline ?? [])
    .map((t) => ({
      date: clipText(t.date, TIMELINE_DATE_CHARS),
      event: clipText(t.event, TIMELINE_EVENT_CHARS)
    }))
    .filter((t) => t.date !== '' && t.event !== '')
    .slice(0, TIMELINE_MAX)
  /* 话题态度：topic / note 是自由文本，没有像 url 那样可白名单的锚点，
     只能做「去空 + 限条数 + 收敛长度」，因此它排在各段之后（见附录 B 的校验顺序） */
  /*
   * 文本落库口径（2026-10-10）：有长度上限的一律走 clipText（净化 + 按字形簇截断），段落级
   * 无上限的走 cleanText（只净化）。裸 slice 按 UTF-16 码元切，会把 emoji 与生僻字切成半个，
   * 落库即坏字符 —— 而报告是全局共享缓存，坏字符会被全站读到。详见 utils/text.ts。
   */
  const stance = (llm.stance ?? [])
    .map((s) => ({
      topic: cleanText(s.topic),
      attitude: normStance(s.attitude),
      note: clipText(s.note, 60)
    }))
    .filter((s) => s.topic !== '')
    .slice(0, 4)

  /* 这里的「剔除」只数**模型给的条数 − 落库条数**：sources 不在其中 —— 它已由端上派生
     （见上面的来源清单），模型没给过它，也就无所谓剔除 */
  let removed = 0
  removed += (llm.dynamics?.length ?? 0) - dynamics.length
  removed += (llm.quotes?.length ?? 0) - quotes.length
  if (removed > 0) {
    diagLog('warn', 'db', `白名单剔除 ${removed} 条（${personKey}）`)
  }

  /* 点评拆条（本轮）：basis 是 url 引用位，与 quotes.source 走同一套出处匹配（srcIndex） */
  const analysisPoints = (llm.analysisPoints ?? [])
    .map((p) => ({
      point: clipText(p.point, ANALYSIS_POINT_CHARS),
      basis: sourceNameOf(p.basis, srcIndex)
    }))
    .filter((p) => p.point !== '')
    .slice(0, ANALYSIS_POINT_MAX)
  /*
   * analysis 仍要落库，且必须与拆条内容一致：
   *   它是问答上下文（utils/qa.ts 读的是这个字符串）与老 UI / 分享文案的出口，
   *   拆条只是让它多了一份结构化形态，不能让它断供。
   * 各条已按提示词要求以句号结尾，拼装时补一次句号，兜住模型偶发的漏写。
   * 回落分支（降级简版的一整段文字）无长度上限，故只净化不截断。
   */
  const analysis =
    analysisPoints.length > 0
      ? analysisPoints.map((p) => (/[。！？!?]$/.test(p.point) ? p.point : `${p.point}。`)).join('')
      : cleanText(llm.analysis)

  /* 会员专属段落（O-11）：两段都空就整个字段不落库 —— UI 按「有没有这个字段」决定出不出一张卡 */
  const notes = llm.memberNotes
  const noteCompare = clipText(notes?.compare, MEMBER_NOTE_CHARS)
  const noteRisk = clipText(notes?.risk, MEMBER_NOTE_CHARS)
  const memberNotes = noteCompare !== '' || noteRisk !== '' ? { compare: noteCompare, risk: noteRisk } : undefined

  /*
   * 信源分歧（本轮，会员专享）：与 memberNotes 同一套「空则整段不落库」。
   * 缺任一侧的条目直接剔除 —— 模型偶尔会把「一方发声、另一方沉默」写成冲突，
   * 那不是分歧；报告只摆真正的两边对不上。
   */
  const conflicts = (llm.conflicts ?? [])
    .map((c) => ({
      topic: clipText(c.topic, CONFLICT_TOPIC_CHARS),
      a: clipText(c.a, CONFLICT_SIDE_CHARS),
      b: clipText(c.b, CONFLICT_SIDE_CHARS)
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
      label: clipText(p.label, PROFILE_LABEL_CHARS),
      value: clipText(p.value, PROFILE_VALUE_CHARS),
      basis: strictSourceOf(p.basis, srcIndex)
    }))
    .filter((p) => p.label !== '' && p.value !== '' && p.basis !== '')
    .slice(0, PROFILE_MAX)

  const relations = (llm.relations ?? [])
    .map((r) => ({
      name: clipText(r.name, RELATION_NAME_CHARS),
      relation: normRelation(r.relation),
      note: clipText(r.note, RELATION_NOTE_CHARS),
      basis: strictSourceOf(r.basis, srcIndex)
    }))
    .filter((r) => r.name !== '' && r.basis !== '')
    .slice(0, RELATION_MAX)

  const watchlist = (llm.watchlist ?? [])
    .map((w) => ({
      when: clipText(w.when, WATCH_WHEN_CHARS),
      what: clipText(w.what, WATCH_WHAT_CHARS),
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
      term: clipText(g.term, GLOSSARY_TERM_CHARS),
      explain: clipText(g.explain, GLOSSARY_EXPLAIN_CHARS)
    }))
    .filter((g) => g.term !== '' && g.explain !== '')
    .slice(0, GLOSSARY_MAX)

  /* 争议与回应：response 允许空串（素材里没有公开回应是常态），故它不进 filter 条件 */
  const controversies = (llm.controversies ?? [])
    .map((c) => ({
      topic: clipText(c.topic, CONTROVERSY_TOPIC_CHARS),
      claim: clipText(c.claim, CONTROVERSY_CLAIM_CHARS),
      response: clipText(c.response, CONTROVERSY_RESPONSE_CHARS),
      basis: strictSourceOf(c.basis, srcIndex)
    }))
    .filter((c) => c.topic !== '' && c.claim !== '' && c.basis !== '')
    .slice(0, CONTROVERSY_MAX)

  /*
   * 本系统的客观评价（批 2）：评价/判断类字段，**不带出处**（它答的是「怎么看」而非「是什么」，
   * 与 glossary 同一性质，只是更长）。只做「去空 + 收敛长度」；两段都空就不落库（UI 整卡不出，
   * 与 memberNotes 同一口径 —— 「没给评价」与「给了空评价」在呈现上无差别，都该不出卡）。
   */
  const verdictRaw = llm.verdict
  const verdictSummary = clipText(verdictRaw?.summary, 60)
  const verdictPositioning = clipText(verdictRaw?.positioning, 60)
  const verdict =
    verdictSummary !== '' || verdictPositioning !== ''
      ? { summary: verdictSummary, positioning: verdictPositioning }
      : undefined

  /* 口碑两极 / 言行一致度（批 2）：与 verdict 同一套「评价类、不带出处、去空 + 收敛长度」。
     口碑两极：两侧都空则整段不落库；言行一致度：claim/act/gap 三者都空则不落库。 */
  const reputationRaw = llm.reputation
  const reputationPositive = clipText(reputationRaw?.positive, 60)
  const reputationNegative = clipText(reputationRaw?.negative, 60)
  const reputation =
    reputationPositive !== '' || reputationNegative !== ''
      ? { positive: reputationPositive, negative: reputationNegative }
      : undefined

  const consistencyRaw = llm.consistency
  const consistencyClaim = clipText(consistencyRaw?.claim, 40)
  const consistencyAct = clipText(consistencyRaw?.act, 40)
  const consistencyGap = clipText(consistencyRaw?.gap, 40)
  const consistency =
    consistencyClaim !== '' || consistencyAct !== '' || consistencyGap !== ''
      ? { claim: consistencyClaim, act: consistencyAct, gap: consistencyGap }
      : undefined

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
    memberNotes: memberNotes ? 1 : 0,
    verdict: verdict ? 1 : 0,
    reputation: reputation ? 1 : 0,
    consistency: consistency ? 1 : 0
  })

  return {
    personKey,
    name,
    mode: 'realtime',
    generatedAt: new Date().toISOString(),
    heat,
    /* intro 是整篇报告的门面（也是分享卡片上的那段话），段落级无上限：只净化不截断 */
    intro: cleanText(llm.intro),
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
    ...(verdict ? { verdict } : {}),
    ...(reputation ? { reputation } : {}),
    ...(consistency ? { consistency } : {}),
    disclaimer: DISCLAIMER,
    focus,
    coverage: buildCoverage(news)
  }
}
