import type { Report } from './report'

/**
 * 报告模板 + 目录（2026-10-10：目录升级成**模板**）。
 *
 * 此前这里只有「这份报告实际呈现了哪些节」这一个问题；现在它是两件事的第一性来源：
 *   1. **模板**：报告由哪些节组成、每节属于哪一档（`REPORT_TEMPLATE`）；
 *   2. **目录**：给定一份报告 + 读者身份，这一档实际看得到哪几节（`buildReportToc`）。
 * 免费与会员看的是同一份模板，差别只在「哪一档」—— 相关口径集中在这一个文件，
 * 页面、会员权益文案都从它取数，不各自再写一份名单。
 *
 * 为什么单独立一个纯函数，而不是在页面里就地写一个数组：
 * 报告页的卡片已经从最初六段涨到十五节（2026-10-10 撤销三张工具视图后），其中一部分是
 * 条件渲染（降级简版、老报告的字段缺失、端上聚合的门槛、会员档）。目录若与页面条件各写一份，
 * **增删一段必然有一处对不上** ——
 * 要么目录里点得动、页面里没有这张卡（点了没反应），要么页面有卡、目录里找不到入口。
 * 这与 utils/member.ts#presentSections 是同一条理由：「哪些段落算专享」那种口径一旦散进页面，
 * 就会失控。放在这里还有一个直接好处：**可以被测试钉住**（见 test/cases/01-pure.js）。
 *
 * ⚠ 仍然要记住：条件与 package/report/index.tsx 里卡片的外层条件是**平行**的两处。
 *   改任何一张卡的渲染条件，必须同步改这里，并跑 `报告目录 utils/report-toc` 那组用例。
 *   两边都有注释互相指路，别只改一处。
 *
 * 标签刻意比卡片标题短（「争议与回应」对应卡片上的「近期争议与回应」）：
 * 目录是胶囊条，标签长了排版就散；用户点进去看到全称不算落差。
 */

/** 档位：free = 免费用户与会员都看得到；member = 只有会员档才渲染的节 */
export type TocTier = 'free' | 'member'

export interface TocSection {
  /** 锚点 id：页面卡片上的 `id` 属性必须与它一字不差（页面直接拿它拼 `#${id}` 跳转） */
  id: string
  label: string
}

/**
 * 目录分组（2026-10-10 三改）：18 节平铺成一格格胶囊后，「人物速览」与「名词解释」并排、
 * 「AI 点评」与「热度趋势」相邻，读起来是一堆无序的词 —— 分组给它们一条阅读线索。
 *
 * 分组**不改顺序**，只是给相邻的几节贴同一张标签：页面仍按模板顺序渲染卡片，目录也仍是
 * 同一条顺序。若分组把顺序打乱（先列完所有组，某些组又跳回前面），点完「明细」里的时间线
 * 再看到「深度」的词云，目录就不再是导航了。故有一条硬约束：
 * **同一组在模板里必须是连续的一段** —— 由 01-pure.js「分组不得打断顺序」那条用例钉住。
 */
export type TocGroupKey = 'identity' | 'facts' | 'judgement' | 'detail'

export interface TocGroup {
  key: TocGroupKey
  /** 组标签：它不是一节，是给几节归类的行首小字，故比节标签更短 */
  label: string
  /**
   * 这一组的节从哪几路检索取素材（见 SEARCH_LANES）。
   *
   * 组内所有节共用同一批路：分组既决定「谁跟谁一起写」（生成，见 utils/report.ts 的
   * REPORT_BATCHES），也决定「素材从哪来」—— 两者同一份口径，才不会出现「模板加了
   * 一节、检索不知道该查什么」。
   */
  search: SearchLaneKey[]
}

/**
 * 检索路（2026-10-11）：报告要的**外部素材**分几路、每路怎么问博查。
 *
 * 为什么关键词写在这里，而不是 utils/search.ts：模板随时可能增减节（例如给「基本档案」组
 * 加一节「商业合作」），检索若仍只问「近期 新闻 动态 言论」，新节的素材压根没被查过 ——
 * 而页面上「没查」与「查了没有」长得一模一样（卡片直接不出现），只会被读成
 * 「这个人没有这些信息」。故把「哪几组要哪些素材、这些素材用什么词去问」与模板放在同一份
 * 真源里：检索层只按这里的声明发请求，**utils/search.ts 里不再出现任何关键词字面量**
 * （test/cases/19 钉住）。
 *
 * ⚠ 这里只管**素材需求**，不含成本取舍：社交路在免费档刻意不发（连请求都不发，
 *   见 utils/search.ts#fetchNews 的 socialCount: 0），那是档位策略，不是「不需要」。
 * ⚠ 检索层目前把这三条路各自接在**具体的发请求点**上（fetchNews 的阶梯与支线、
 *   fetchBackground），所以**新增一条路要同时在 utils/search.ts 接上** —— 只加声明不会
 *   自动多问一句。test/cases/19 有一条用例专门盯这件事：声明了却没人发，测试即红。
 * ⚠ 需求与「怎么用」的分工：`recent` 两路合并成的「素材」段**所有批都读**
 *   （判断也要建立在事实上），只有 `evergreen`（profile）那一段按组区分 ——
 *   见 utils/report.ts 里批次 `background` 的派生。
 */
export type SearchLaneKey = 'news' | 'social' | 'profile'

export interface SearchLane {
  /** 查询词后缀：与人名拼成 query（另有「只留人名」的降级档，见 utils/search.ts#fetchNews） */
  keywords: string
  /**
   * 这一路**要什么素材**（一句话，供「检索词规划」提示词逐路列给模型，见 utils/search-plan.ts）。
   *
   * 与 keywords 的分工：keywords 是**兜底句式**（模型给不出词时用它，且它仍是字面量唯一真源，
   * test/cases/19 钉住）；本字段是给人 / 模型读的**意图声明** —— 改一条路的含义先改这里。
   * ⚠ 别在这里原样抄 keywords：19 有一条断言「关键词字面量在 src 下只有一处」。
   */
  want: string
  /**
   * 时间语义：
   *   · recent    —— 「近期」语义，按 SEARCH_COUNTS.mainFreshnessLadderDays 逐档放宽
   *                  （动态 / 名言 / 争议 / 立场要的都是近期，混进旧闻比空着更糟）；
   *   · evergreen —— 不限时间（出生地、学历、履历不随时间变，窗口越窄越搜不到）。
   */
  freshness: 'recent' | 'evergreen'
  /** 限定站点白名单（过滤发生在博查服务端，不往 request 合法域名里加东西） */
  include?: string[]
}

/**
 * 三条路：近期主线、社交一手发声、人物背景线。
 *
 * 数值（条数、时间窗阶梯）在 config/benefits.ts 的 SEARCH_COUNTS；这里只有**问什么**。
 */
export const SEARCH_LANES: Record<SearchLaneKey, SearchLane> = {
  /* 主线：一份报告最核心的素材来源，「事实」与「判断」两组都靠它 */
  news: {
    keywords: '近期 新闻 动态 言论',
    freshness: 'recent',
    want: '近期的公开报道与动态：新闻报道、访谈、本人公开发言'
  },
  /*
   * 社交一手发声：单条 query 的排序权完全在上游 —— 门户转载的标题更「新闻体」，
   * 常把本人微博 / 知乎长文挤到十名开外，而名人的一手发声恰恰在后者。
   * 故补一路限定站点的检索把它们单独捞一遍（补充路，失败一律吞掉）。
   */
  social: {
    keywords: '近期 动态',
    freshness: 'recent',
    want: '本人在社交平台上的一手发声：微博、知乎、B站、小红书、抖音的原创内容',
    include: ['weibo.com', 'zhihu.com', 'bilibili.com', 'xiaohongshu.com', 'douyin.com']
  },
  /* 人物背景线：「人物档案 / 关系图谱 / 时间线」的素材不进新闻流，30 天窗里天然搜不到 */
  profile: {
    keywords: '个人资料 简介 出生地 学历 经历 企业关联 代表合作 商业合作',
    freshness: 'evergreen',
    want: '长期不随时间变的履历资料：出身、教育、职业经历、代表作品、商业合作'
  }
}

/**
 * 组的顺序 = 页面呈现顺序（与模板顺序一致）。`search` 的取舍：
 *   · 基本档案 / 细节与延伸要**履历**（档案、关系、时间线），故带 profile 路；
 *   · 事实 / 判断与风险要的是**近期**（动态、名言、争议、立场），只吃 news；
 *   · 事实与判断另需社交一手发声（名人的原话与动态常在社交站），故声明 social。
 */
export const TOC_GROUPS: TocGroup[] = [
  { key: 'identity', label: '基本档案', search: ['news', 'profile'] },
  { key: 'facts', label: '事实', search: ['news', 'social'] },
  { key: 'judgement', label: '判断与风险', search: ['news', 'social'] },
  { key: 'detail', label: '细节与延伸', search: ['news', 'profile'] }
]

/**
 * 这一组要不要某一路素材。目前唯一的运行时消费点是**批次的 `background`**
 * （utils/report.ts#REPORT_BATCHES）：带 profile 路的组才在 user 消息里拿到
 * 「人物背景资料」段 —— 这条此前手写在 BATCH_SPEC 上，模板一动就可能两边对不上。
 */
export function groupNeedsLane(key: TocGroupKey, lane: SearchLaneKey): boolean {
  return (TOC_GROUPS.find((g) => g.key === key)?.search ?? []).includes(lane)
}

export interface TocOptions {
  /** 当前是否会员：会员档的节（tier === 'member'）只对会员列出 / 渲染 */
  member: boolean
  /**
   * 「人物速览」那一节是否会出现。
   * 它的门槛在端上（要看素材覆盖范围算不算得出来），调用方算好再传进来：
   * 可见的充要条件是「不是降级简版，或有覆盖数据」。
   */
  hasOverview: boolean
}

/** 模板里的一节：目录条目 + 档位 + 可见性条件 */
export interface ReportTemplateSection {
  id: string
  label: string
  tier: TocTier
  /** 目录里归到哪一组（见 TOC_GROUPS；同组必须在模板里连续） */
  group: TocGroupKey
  /** 这一节在**给定报告**上会不会出现（与 pages/report 卡片的外层条件平行） */
  visible: (report: Report, opts: TocOptions) => boolean
  /**
   * 一句话说明（**可选**，只给「可聚焦节」写）：供 config/filters.ts 的「关注」筛选
   * 说明文案取数 —— 让筛选说明与模板同源，而不是在 filters 里再抄一份（改节 / 改名会漂移）。
   */
  desc?: string
}

/** 「不是降级简版」—— 大多数节的共同门槛（降级简版整份只剩警示条） */
const ready = (report: Report) => !report.degraded

/**
 * 报告模板（顺序 = package/report/index.tsx 里卡片的渲染顺序）。
 *
 * 分档口径（2026-10-12 调整；改档位要同时跑报告页、会员页与 01-pure 的用例）：
 *   · **免费档给「事实与主线判断」** —— 人物速览 / 简介 / AI 解读 / 人物档案 / 关系图谱 /
 *     近期动态 / 经典名言 / AI 点评 / 争议与回应 / 风险雷达 / 时间线。
 *     这批是报告的主体，也是别处的下游：时间线被周报的「动态时间线」用，风险雷达与风险监控
 *     同源 —— 抽掉任何一节都不只是「报告页少张卡」，故一律留在免费档。
 *   · **会员档给「延伸与专享解析」** —— 商业速览 / 商业合作 / 会员专享 / 同领域坐标 /
 *     立场与舆情 / 名词解释。
 *     2026-10-12 把「立场与舆情 / 名词解释」从免费档移入会员档（方案 A 轻量版）：
 *     它们答的是「大众怎么看」「这个词什么意思」，属延伸与解读而非核心事实。
 *     2026-10-12 另有：原会员档的「后续关注」被「商业合作与代言」取代 —— 后者要求
 *     「素材里已公布的未来时间点」，而素材窗口里几乎不含未来档期、实测多为空；
 *     具名的商业合作 / 代言素材里真有，且对用户更有用（见 utils/report.ts 规则 11）。
 *     **注意它们仍在免费批次里生成**（见 utils/report.ts 的 BATCH_SPEC）—— 本次只改呈现档位，
 *     不动生成：立场与舆情仍是对比页 / 话题速览 / 问答的素材来源，砍掉生成会让那些免费功能变弱。
 *     2026-10-10 起，原「分析视图」里的三张工具视图（关键词云 / 语录主题 / 热度趋势）已删除
 *     —— 它们回答的是「素材长什么样」而非「这个人怎么样」，与用户诉求不符。
 *
 * ⚠ 与提示词的关系：模板只决定**渲染哪几节**（以及免费读者看到哪些，见 pages/report 的
 *   `member` 门槛），不改变报告的生成本身 —— 报告仍是全局共享缓存（personKey 唯一键，
 *   免费/会员同读一份）。数据上**只对会员生成**的是 memberNotes / conflicts / peers / affiliations
 *   四段（见 utils/member.ts#stripMemberSections 与 utils/report.ts 的 MEMBER_HINT_REALTIME）。
 */
export const REPORT_TEMPLATE: ReportTemplateSection[] = [
  /* ── 基本档案：先回答「是谁」。
     商业速览（会员档）也归这一组 —— 它讲的是同一个人的商业面，位置又紧挨着关系图谱，
     正好构成连续的 identity 段（组必须连续，见 TOC_GROUPS 的说明）。 */
  { id: 'sec-overview', label: '人物速览', tier: 'free', group: 'identity', visible: (_r, o) => o.hasOverview },
  /* 简介：降级简版且没有 intro 时，空态卡与实体卡两个分支都不成立 */
  { id: 'sec-intro', label: '简介', tier: 'free', group: 'identity', visible: (r) => !r.degraded || !!r.intro },
  /* 本系统评价（批 2）：verdict / reputation / consistency 任一存在才出卡 —— 老报告没有这些字段，整卡不出 */
  { id: 'sec-verdict', label: 'AI 解读', tier: 'free', group: 'identity', visible: (r) => !!(r.verdict || r.reputation || r.consistency) },
  { id: 'sec-profile', label: '人物档案', tier: 'free', group: 'identity', visible: (r) => !!r.profile },
  { id: 'sec-relations', label: '关系图谱', tier: 'free', group: 'identity', visible: (r) => !!r.relations },
  /* 商业价值速览（第 0 期，会员档）：非降级简版恒出卡 —— 门槛只决定卡里是速览还是
     「缺什么」的说明，两种形态都是一张可读的卡，故目录里始终列它 */
  { id: 'sec-commercial', label: '商业速览', tier: 'member', group: 'identity', visible: ready },
  /* 商业合作与代言（2026-10-12，会员档）：取代原「后续关注」—— 具名品牌 / 合作方 + 类别 + 说明。
     与「商业速览」同属商业面，故同组紧邻；字段在免费批次（identity）生成，此处只对会员出卡。 */
  { id: 'sec-endorsement', label: '商业合作', tier: 'member', group: 'identity', visible: (r) => !!r.endorsements },
  /* ── 事实：素材原样统计出来的那两段（不掺模型判断），是下面「判断」的取材处 */
  { id: 'sec-dynamics', label: '近期动态', tier: 'free', group: 'facts', visible: ready, desc: '近期新闻、公开活动与事件' },
  { id: 'sec-quotes', label: '经典名言', tier: 'free', group: 'facts', visible: ready, desc: '公开表达、观点与金句' },
  /*
   * ── 判断与风险：AI 点评 / 争议 / 风险雷达 + 会员专享（它本身就是「对比视角 / 风险提示 /
   * 信源分歧」三条判断，位置紧接风险雷达，构成连续的 judgement 段）。
   */
  /* AI 点评有三个分支（降级简版 / 无正文空态 / 实体），至少命中一个 → 始终在 */
  { id: 'sec-analysis', label: 'AI 点评', tier: 'free', group: 'judgement', visible: () => true },
  /*
   * P2-13（2026-10-09）：条件从 `report.controversies` 改为 `!report.degraded` —— 卡片在
   * **缺这一段**时也会出现（说明「这一段缺数据 ≠ 确认没有争议」），目录若还按字段判，
   * 就会出现「页面有卡、目录里点不到」。与 sec-risk 同一口径，两条放在一起。
   */
  { id: 'sec-controversies', label: '争议与回应', tier: 'free', group: 'judgement', visible: ready },
  { id: 'sec-risk', label: '风险雷达', tier: 'free', group: 'judgement', visible: ready },
  { id: 'sec-member', label: '会员专享', tier: 'member', group: 'judgement', visible: ready },
  /*
   * 同领域坐标（会员档，2026-10-12 新增）：具名同行 + 具体差异。
   *
   * 与 sec-member 里的「对比视角」（memberNotes.compare）是**互补而非重复**：那一段是散文式
   * 判断，这一节是**结构化条目**（每条一个具名对象 + 一条可核对的差异），可扫读、可逐条核对。
   * 它与 sec-member 同组、紧邻，构成连续的 judgement 会员段；字段 peers 只在会员提示词里出现。
   */
  { id: 'sec-peers', label: '同领域坐标', tier: 'member', group: 'judgement', visible: ready },
  /*
   * 企业关联（会员档，2026-10-12 新增）：关联企业 / 合作方 / 参股 —— 人-机构维度的硬信息。
   * 与 sec-peers 同组、紧邻，构成连续的 judgement 会员段；字段 affiliations 只在会员提示词里出现
   * （见 utils/report.ts 的 MEMBER_HINT_REALTIME）。
   */
  { id: 'sec-affiliation', label: '企业关联', tier: 'member', group: 'judgement', visible: ready },
  /*
   * ── 立场与舆情（2026-10-12 起为会员档）：「大众怎么看 TA」本是判断类，故留在判断组。
   * 移入会员档只是**呈现**上不再给免费用户出卡；数据仍在免费批次里生成 ——
   * 它是对比页 / 话题速览 / 问答的上下文来源，砍掉生成会让那几个免费功能变弱
   * （见本文件顶部的分档口径说明）。
   * 2026-10-10 起撤销「深度视图」组：关键词云 / 语录主题 / 热度趋势三张工具视图已删除
   * （它们回答的是「素材长什么样」而非「这个人怎么样」，见 CHANGELOG 批 25）。
   */
  { id: 'sec-stance', label: '立场与舆情', tier: 'member', group: 'judgement', visible: ready },
  /* ── 细节与延伸：时间轴、看不懂的词 */
  { id: 'sec-timeline', label: '时间线', tier: 'free', group: 'detail', visible: ready, desc: '关键节点与成长脉络' },
  /* 名词解释（2026-10-12 移入会员档）：纯阅读辅助；数据仍在免费批次生成 */
  { id: 'sec-glossary', label: '名词解释', tier: 'member', group: 'detail', visible: (r) => !!r.glossary }
]

/** 模板总节数（**名义值**：不随某一份报告降级 / 缺字段而变，权益文案与目录提示取它） */
export const TEMPLATE_SIZE = REPORT_TEMPLATE.length

/** 会员档独有的节（顺序即页面顺序），权益文案与目录提示的唯一来源 */
export const MEMBER_ONLY_SECTIONS = REPORT_TEMPLATE.filter((s) => s.tier === 'member')

/** 会员档独有节数 */
export const MEMBER_TOC_COUNT = MEMBER_ONLY_SECTIONS.length

/** 免费档可见节数（名义值） */
export const FREE_TOC_COUNT = TEMPLATE_SIZE - MEMBER_TOC_COUNT

/** 会员档独有的节名（顺序即页面顺序） */
export function memberOnlyTocLabels(): string[] {
  return MEMBER_ONLY_SECTIONS.map((s) => s.label)
}

/**
 * 这一档实际要列出的**模板项**（含档位与分组）：先按档筛（免费档滤掉 member 节），
 * 再按报告内容滤。顺序 = 模板顺序 = 页面卡片顺序。
 *
 * `buildReportToc`（平铺）与 `buildReportTocGroups`（分组）都只从这里取材，
 * 于是「分好组再拍平」必然等于「平铺目录」—— 两个视图不会各说各话。
 */
function visibleSections(
  report: Report | null | undefined,
  opts: TocOptions
): ReportTemplateSection[] {
  if (!report) return []
  return REPORT_TEMPLATE.filter((s) => s.tier === 'free' || opts.member).filter((s) =>
    s.visible(report, opts)
  )
}

/** 这一档的目录（平铺）：页面顶部的「目录 · N 节」与测试都用它 */
export function buildReportToc(report: Report | null | undefined, opts: TocOptions): TocSection[] {
  return visibleSections(report, opts).map(({ id, label }) => ({ id, label }))
}

/** 目录的一个分组块：组标签 + 这一档在这一组里实际要列的节（空组不返回，不占一行标题） */
export interface TocGroupBlock {
  key: TocGroupKey
  label: string
  sections: TocSection[]
}

/**
 * 分好组的目录（页面的目录展开态渲染它）：把 `visibleSections` 按 `group` 切块，
 * **组内保持模板顺序**，组间按 `TOC_GROUPS` 顺序。
 *
 * 空组不返回：某一档的组只剩一节也算有（一节也要有组标签，否则那颗胶囊会孤零零挂在
 * 上一个组底下），但一节都没有的组连标题都不该出现 —— 标题行本身占 40rpx，空白组是纯浪费。
 */
export function buildReportTocGroups(
  report: Report | null | undefined,
  opts: TocOptions
): TocGroupBlock[] {
  const all = visibleSections(report, opts)
  return TOC_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    sections: all.filter((s) => s.group === g.key).map(({ id, label }) => ({ id, label }))
  })).filter((b) => b.sections.length > 0)
}

/**
 * 免费读者**看不到**的会员档节：目录底部那行「会员另含 N 节」用它。
 *
 * 按「会员会看到什么」来判（`visible` 用 `member: true` 求值），而不是按手里这份报告
 * 有没有对应字段 —— 免费读者拿到的 Report 里那些节**本来就被摘掉了**，
 * 从它自己算恒为空（同 utils/member.ts#presentLockedSections 的取舍）。
 * 会员传进来返回空数组（他自己就看得见，不需要这行提示）。
 */
export function lockedReportToc(
  report: Report | null | undefined,
  opts: TocOptions
): TocSection[] {
  if (!report || opts.member) return []
  return MEMBER_ONLY_SECTIONS.filter((s) => s.visible(report, { ...opts, member: true })).map(
    ({ id, label }) => ({ id, label })
  )
}
