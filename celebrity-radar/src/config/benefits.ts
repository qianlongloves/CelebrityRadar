/**
 * benefits.ts —— 会员权益与价格的**唯一真源**（改权益只改本文件）。
 *
 * ## 为什么要有这个文件
 *
 * 「谁能用多少、卖多少钱」原本散在三处：端上权益表（`utils/member.ts` 的 MEMBER_BENEFITS）、
 * 云端配额闸门（`aiProxy/quota.config.js` 的 QUOTA_POOLS）、服务端价格表
 * （`payCreate/index.js` 的 PLANS）。后果不是重复劳动，而是**漂移**：
 * 调额度时漏掉云函数那一份，用户看到「会员页说 30 次、实际拦在第 3 次」；
 * 改价时只改了云函数，端上离线兜底清单还印着旧价。两者都不会报错，只会静默错。
 *
 * 现在这些数值只在**本文件**写一次，两条路各自取用：
 *   - 端上：`utils/*` 直接 `import`（webpack 打包进小程序）
 *   - 云端：`npm run config:sync` 生成 `cloudfunctions/<fn>/benefits.config.js`
 *
 * ## 改权益的正确姿势（四步）
 *
 *   1. 改**本文件**（数值只在这里）
 *   2. `npm run config:sync` —— 把副本刷进各云函数目录
 *   3. `npm test` —— 用例会比对真源与云端副本，漏了第 2 步就红
 *   4. 部署受影响的云函数（端上随下次发版生效）
 *
 * ## 三条铁律
 *
 * 1. **自包含**：本文件**不得 import 任何模块**，只能由字面量组成。
 *    同步脚本在 node 里转译并执行它（见 `scripts/sync-config.js`），
 *    一旦出现 import / require，脚本会直接报错停下。
 * 2. **只放数据**：不放函数、不放 `Date.now()`、不放计算结果 —— 生成物是 JSON。
 *    派生值（如「档位天数表」）由使用处拿本文件的数据现算。
 * 3. **改完必须同步**：云函数各自独立打包上传（`cloudbaserc.json` 逐个声明），
 *    且云环境里**不能 require 端上的 TS**（`quotaGuard/index.js` 有注释说明），
 *    故副本是必需品，不是冗余。
 *
 * ## 什么**不**放这里
 *
 * 展示文案：`utils/member.ts` 的 `MEMBER_BENEFIT_POINTS`、`pages/member` 的权益对比表。
 * 它们是**措辞**，且大量引用 `utils/report-toc.ts` 的派生值（模板节数）——
 * 改了本文件的数值，那些文案会自动跟着变；只有想改「怎么说」时才动它们。
 */

/* ═══════════════════════════════════════════════════════════════════════════
 * 一、会员权益表（额度 / 冷却）
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 会员权益表：数值即策略本身，改这里即改策略。
 *
 * 分工（三层互不越界，见 utils/member.ts 文件头）：
 *   权益（本表）→ 价格（PLANS）→ 计数（云函数 quotaGuard）
 *
 * ⚠ 云端 `aiProxy/quota.config.js` 的 QUOTA_POOLS 由本表生成，
 *   `test/cases/07-cloud-authority.js` 会比对两侧，改一端就红。
 */
export const MEMBER_BENEFITS = {
  /**
   * 每日「主动生成报告 / 周报」次数上限（两者共用同一池计数）。
   * 只管主动生成：缓存命中的报告不计数，浏览已生成报告两种版本都不限次。
   */
  generatePerDay: { free: 3, member: 30 },

  /**
   * 每日「AI 提问」次数上限（与生成**不同池**：提问不吃生成额度，见 utils/qa.ts）。
   *
   * 免费额度比生成给得大方（生成一次要等 30 秒，提问只是追问），但必须设上限：
   * 每次提问都是一次真实的付费模型请求，同时这也是会员最有体感的一条权益。
   */
  askPerDay: { free: 5, member: 30 },

  /**
   * 每日「抓取关注动态」次数上限（下拉刷新与「抓取动态」按钮，含单人刷新）。
   *
   * ⚠ 2026-10-10 起**按档位分叉**：免费 10 / 会员 20。此前两版同额，理由是「它不是权益差异，
   * 而是一次刷新的上游成本闸门」—— 那条理由本身没变（单次刷新最多打
   * utils/cache.ts#FEED_REFRESH_MAX_PERSONS 路检索），改成分档是产品取舍：
   * 关注流是每天都会用的功能，把它做成会员的体感差异；免费档**保持 10 不动**，
   * 免费用户仍能看全自己关注的人有没有动静，只是要分几天刷。
   *
   * ⚠ **代价是一笔真实的开销**：这个数字直接乘在上游检索量上 —— 会员从 10 次/日
   *   （≈100 路检索）变成 20 次/日（≈200 路）。调它等于调成本预算，不只是调一个「次数」。
   *
   * ⚠ 判定链路是分档的，改这一项要三处一起看：
   *   · 云端 quotaGuard 的 judgeLimit：读 memberships 后按档返回 limit（**权威**）
   *   · 端上 utils/member.ts#dailyRefreshLimit：只在云函数不可用时兜底
   *   · 会员页的额度对比表与权益列表直接引用本表的两个值
   */
  refreshPerDay: { free: 10, member: 20 },

  /**
   * 免费档「重复生成」的提醒窗口（小时）：同一份报告生成后这段时间内再点刷新，
   * 确认弹窗会多提醒一句「内容大概不会有实质变化」。
   *
   * ⚠ 2026-10-10 起它**不再是限制**：原先窗口内点刷新会被直接拦下、交回旧版本，
   * 与「重新生成随时可用」直接冲突，故降级为提醒（判定仍由 utils/cache.ts#isFreeRefreshCooling 给）。
   * 留在权益表里是因为它仍**按身份分叉**（会员不弹这一句），与上面三条同一性质。
   */
  freeRefreshCooldownHours: 12

  /*
   * 2026-10-08 撤销：原 O-19 的 `hotBoardShown: { free: 6, member: 24 }` 已删除，热门榜
   * **全员可见全部位数**。撤销理由：热门榜是全项目唯一「不需要等待」的内容（静态种子 +
   * 每日 AI 榜，首屏零成本），它同时也是 FREE_FEATURES_NOTE 里那句「不买也能用」的样板；
   * 在用户最先看到的位置先撞一次付费墙，换来的转化远不抵「这也要钱」的印象损耗。
   * 若日后要恢复分档，须同时改三处：本表、`pages/index`（预览位数与底部那一行）、
   * `pages/member` 的权益对比表 —— 少改一处就会出现「说不分档但其实只给 6 位」。
   */
} as const

/**
 * 防滥用上限（次/日）：按**每一次真实付费调用**计，包含生成、提问与辅助调用。
 *
 * 与上面「产品额度」是两道不同的闸（详见 aiProxy/quota.config.js 文件头）：
 * 产品额度防「端云不同步」，本表防「解包改大上限随便调」——它的计数由云端在放行时
 * 就地原子自增（`ai_calls` 表），端上无法阻止。
 *
 * 取值依据（正常用户一天的调用量）：
 *   免费档 ~ 3 次生成（2026-10-11 起每次生成另带一次检索词规划）+ 5 次提问 + 若干消歧/选题 ≈ 13~18 次；
 *   会员档 ~ 30 次生成（同上，+30 次规划）+ 30 次提问（报告可能带一次纯文本降级）≈ 90~100 次。
 * 留 2 倍以上余量，于是正常用户碰不到，改包者最多也就花掉这些。
 *
 * ⚠ 以后再加「每次生成都发一次」的小请求（检索词规划就是这一类），都要回到这张表核对：
 *   它是**每生成 +N**，而生成额度也按次计，两者相乘会很快吃掉余量。
 */
export const ABUSE_LIMITS = { free: 40, member: 200 }

/**
 * 云端「单次检索」的结果条数上限（按会员档位钳制）。
 *
 * 端上 `utils/search.ts` 的 MAIN_COUNT / DEEP_MAIN_COUNT 等是**要几条**，
 * 本表是**云端最多给几条**——端上要 24 条而云端只放 20 条时，
 * 静默少掉的那几条不会报错，只让报告变薄，所以两者是不同性质的两个量。
 */
export const SEARCH_MAX = { free: 20, member: 40 }

/**
 * 单次对话请求的字符上限（云端通道硬顶）。
 *
 * 端上构造 user 消息时会按它留余量（utils/report.ts 的 MAX_USER_CHARS /
 * MAX_USER_CHARS_MEMBER）；云函数 aiProxy 超过即拒。
 * 改大要同步确认端上构造侧与模型上下文窗口都吃得下。
 */
export const MAX_CHAT_CHARS = 24000

/* ═══════════════════════════════════════════════════════════════════════════
 * 二、套餐（价格 / 天数）
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 套餐白名单（**唯一价格源**，2026-10-07 产品定稿）。
 *
 * 为什么价格必须在服务端：小程序包可解包，客户端传来的任何价格 / 时长都不可信。
 * 云函数 `payCreate` 下单时按 id 查本表，端上只用 `{ action:'plans' }` 把它拉回去渲染
 * —— 于是**改价只改本文件 + 同步 + 部署云函数，无需发版**。
 *
 * 字段口径（与 `src/utils/pay.ts` 的 MembershipPlan 一一对应）：
 *   priceFen   实付金额（分）—— 下单时即 `totalFee`，端上展示价也用它（整数，无浮点误差）
 *   priceLabel 展示价文案
 *   badge      角标（运营文案，空串 = 不显示）
 *   body       微信支付订单标题（**仅云函数使用**，不下发给端上）
 *
 * ⚠ id 是**持久化标识**：已经卖出去的订单、`memberships` 里的 plan、端上调试覆写的键
 *   都用它。改 id 等于让历史订单的套餐名对不上，只能新增、不能改名。
 * 档位差额：年卡折合 ¥5.7/月、季卡 ¥8.3/月，badge 即锚点。
 */
export const PLANS = [
  {
    id: 'monthly',
    name: '月度会员',
    days: 30,
    priceFen: 990,
    priceLabel: '¥9.9',
    badge: '',
    body: '名人雷达·月度会员'
  },
  {
    id: 'quarterly',
    name: '季度会员',
    days: 90,
    priceFen: 2500,
    priceLabel: '¥25',
    badge: '省 16%',
    body: '名人雷达·季度会员'
  },
  {
    id: 'annual',
    name: '年度会员',
    days: 365,
    priceFen: 6800,
    priceLabel: '¥68',
    badge: '最划算',
    body: '名人雷达·年度会员'
  }
] as const

/* ═══════════════════════════════════════════════════════════════════════════
 * 三、报告参数
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 素材 → 提示词的选取。这些数值决定「模型能看到多少」，也就是报告有多厚。
 *
 * ⚠ 报告是**长期共享缓存**（生成一次、长期复用），所以改这里只影响**之后新生成**的报告；
 *   已经缓存的那份不会自动重建（除非用户点「重新生成」）。调完建议手动生成一份看看效果。
 */
export const REPORT_SOURCE = {
  /**
   * 给全文的素材**事件**数上限（数的是事件，不是条数），之外的条目压成一行「参考条目」。
   *
   * 为什么要数事件：同一件事常有多家媒体报道（URL 不同 → 按 url 去重认不出来），
   * 条数口径下「一件事 5 篇」会一口气吃掉 5 个全文名额。按事件计，一件事只占一个。
   */
  fullItemCount: 10,

  /**
   * 「值得做句子级抽取」的最短正文（L1，2026-10-10）。低于这个长度直接原样送去 ——
   * 抽一次省不下几个字，却白多一层「模型看到的不是连续原文」的风险。
   */
  extractMinChars: 400,

  /**
   * 抽取后单条全文的**目标长度**（L1）：首句（导语）必留，其余只收带信号的句子
   * （含人名 / 带引号 / 含数字），信号不足时按序补足到这里为止。
   *
   * 为什么这一刀最值：全文条目是输入的大头（10 条 × maxItemChars 1000 = 一万字，
   * 吃掉免费档 15000 预算的三分之二），而新闻正文里的复述、背景铺垫、无关段落
   * 占了大半。抽的是**整句原文**（不是模型改写、不是摘要），句句仍可回到素材核对，
   * 所以「事实仅基于素材、每条可溯源」这条契约不受影响。
   */
  relevantItemChars: 500,

  /**
   * 压缩条目的摘要片段长度。只够让模型判断「这条讲的是什么」，不足以据此展开叙述 ——
   * 这是刻意的：压缩条目在提示词里被明确标为「正文从略」，模型不该拿它当全文用。
   */
  briefItemChars: 160,

  /**
   * 同一事件组内，「这条报道与组代表的正文重复度」达到这个 Dice 系数即判为转述同一篇稿
   * （L1，2026-10-10）：正文片段不再重复送出，只留标题 / 来源 / url。
   *
   * 判据用的是正文（不是标题）：标题判同已经把「同一件事」归了组，这里再判一次「同一篇稿」，
   * 针对的是通讯社供稿被多家转载（正文几乎逐字相同）那一类 —— 每条 160 字的片段乘以
   * 转载家数，是压缩档里最没信息量的那部分。
   */
  sameBodyRatio: 0.8,

  /** 同一事件的判定阈值：标题字符二元组的 Dice 系数（实现见 utils/report.ts#groupByEvent） */
  sameEventRatio: 0.62,

  /**
   * 「basis 写的是素材标题」这层匹配的最短长度（标题归一化后的字符数）。
   * 要求足够长是因为这层用的是「一方包含另一方」：短串（如「新剧开播」）会在一堆不相关的
   * 标题里误命中，而误命的代价是给一条编造的事实配上了真出处 —— 比少一条严重得多。
   */
  titleMatchMinChars: 8,

  /**
   * 报告判「素材不足」的事实条数下限（少于它即 shortfall）。
   *
   * ⚠ 端上另有多处**按条数卡渲染**（词云命中、语录主题、热度趋势、情绪条、风险雷达），
   *   它们各自的阈值不在这里（见 utils/keywords.ts 与 pages/report）；改本值不会同步影响它们。
   */
  shortfallMinFacts: 3
} as const

/**
 * 送进模型前的**字符预算** —— 三个数一起受三道约束，别只改其中一个：
 *   ① 云函数 `aiProxy` 的 MAX_CHAT_CHARS（即本文件上面的 MAX_CHAT_CHARS，超了直接拒）；
 *   ② `callFunction` 链路「大字段不超过 100KB」的建议（中文 UTF-8 3 字节/字）；
 *   ③ **模型上下文窗口**（最紧的一道，2026-10-11 补）：免费档走 hy3-preview，上下文窗口
 *      比会员档窄，叠加 system 提示词后「user 贴着前两道上限」也会在上游报「参数过大」——
 *      前两道（24000 字 / 100KB）离模型窗口还很远，真正的瓶颈是第 ③ 道。
 * 叠加 system 提示词后两端都不该贴边，否则症状是「配好了却生成失败」——
 * 超限时 callFunction 直接抛错，再被上层合并成一句「平台通道未就绪」，极难排查。
 * 故免费档压在 10000 字、会员档 16000 字：给 system（约 1~1.8k 字）与窗口余量留足空间。
 */
export const REPORT_BUDGET = {
  /** 单条素材正文上限：博查 summary:true 返回的是详细摘要，个别条目能到数千字，不设限时单条吃掉整个预算 */
  maxItemChars: 1000,

  /** 免费档 user 消息整体上限（10000 字 ≈ 30KB）：预留模型上下文窗口余量，避免「参数过大」 */
  maxUserChars: 10000,

  /** 会员深度档预算：深度检索多拿一倍素材，沿用免费档会把加厚那部分**直接截掉**（花了检索钱却没用上） */
  maxUserCharsMember: 16000
} as const

/**
 * 各事实字段的**长度与条数上限**（utils/report.ts#sanitizeReport 用）。
 *
 * 这一组是「自由文本只能收敛长度」的落点：模型给的长文本没有可白名单的锚点，
 * 端上只能按体裁裁到「一条事实说清楚」的尺度。数值不同只是体裁不同 ——
 * 超过上限它就不再是「一条」，而是又变回了被拆掉的那种整段综述。
 */
export const REPORT_FIELD_LIMITS = {
  /** 单条点评：与 stance.note 同档，都是一句话的判断 */
  analysisPointChars: 80,
  /** 点评条数（与提示词第 6 条要求的条数对应） */
  analysisPointMax: 4,

  /** 会员专属段落（对比视角 / 风险提示）：是 2~3 句的完整判断，装不上 60 字那档 */
  memberNoteChars: 240,
  /** 名言背景 / 注解：1~2 句的完整背景；名言卡本身已很密，这是它的上限 */
  quoteNoteChars: 120,

  /** 争点：12 字内的短语，超出说明模型把「说法」写进了「争点」 */
  conflictTopicChars: 24,
  /** 单侧说法：要装下一句完整陈述（谁 + 说了什么），故比 stance.note 宽 */
  conflictSideChars: 100,
  /** 分歧条数：只摆最关键的几处，摆满一屏反而没了重点 */
  conflictMax: 3,

  /**
   * 同领域坐标（会员段，2026-10-12）。只有**具名 + 具体差异**才算数（写不出就整条剔除），
   * 故条数刻意少：3 条足够给出坐标感，摆满就是排行榜，反而丢了「看这个人」的主线。
   */
  peerMax: 3,
  /** 对象姓名（与 relationNameChars 同档：中文姓名 2~4 字，留艺名 / 组合名的余量） */
  peerNameChars: 20,
  /** 具体差异：1~2 句，必须落到可核对的事实（作品 / 奖项 / 数据 / 路径），与 quoteNoteChars 同档 */
  peerGapChars: 120,

  /** 人物档案：超过 6 条就不再是「一眼看清 who」 */
  profileMax: 6,
  /** 字段名（「出生年份」四个字，够用且能左右对齐成一列） */
  profileLabelChars: 8,
  /** 字段值 */
  profileValueChars: 40,

  /** 关系：人-人维度只摆最主要的几段 */
  relationMax: 5,
  /** 对方姓名（中文姓名 2~4 字，留出艺名 / 组合名的余量） */
  relationNameChars: 20,
  /** 关系说明 */
  relationNoteChars: 40,

  /**
   * 关联企业 / 合作方 / 参股（会员专享，2026-10-12）：人-机构维度的硬信息，
   * 单独成段而不是并进 relationMax —— 它只在会员提示词里出现，故不占免费档批的预算。
   *
   * 为什么 4 条：本人**公开披露**的机构关系通常只有「创办或任职的公司 + 主要合作方 + 持股」
   * 两三条，给到 4 条既装得下、又不会摆成一张企业清单；量级与 peerMax(3) / endorseMax(3) 一致。
   * 字数复用 relation 那两档：名称 20 字（企业 / 品牌名可能比人名长，与 relationNameChars 同档），
   * 一句说明 40 字（可写职务或持股比例，与 relationNoteChars 同档）。
   */
  affiliationMax: 4,
  affiliationNameChars: 20,
  affiliationNoteChars: 40,

  /**
   * 时间线（P1，2026-10-11 补）：此前 timeline 是 sanitize 里**唯一**既不净化也不限量的段落，
   * 模型原文直接落进全站共享缓存。理由与其余各段一致 —— 自由文本没有可白名单的锚点，只能收敛长度。
   */
  timelineMax: 8,
  /** 日期：只该是 YYYY-MM-DD / YYYY-MM 这类刻度（10 字已满格）。它与 timelineMax 同值于
   *  REPORT_QUOTAS.timelineMax 的「条数上限」—— 提示词里给的是目标条数，这里是裁剪线 */
  timelineDateChars: 10,
  /** 事件：一句话说清「什么时候发生了什么」，与 endorse.note 同档 */
  timelineEventChars: 60,

  /**
   * 商业合作与代言（2026-10-12 取代原「后续关注」）：条目数上限。
   * 为什么取代 watchlist：它要求「素材里已公布的未来时间点」，而素材窗口只有约 30 天新闻、
   * 里面几乎不含未来档期 —— 实测多为空，对用户没有价值。商业合作与代言的品牌 / 合作方
   * 素材里真有，且是决策向的实体信息（与「商业价值速览」同一面）。
   */
  endorseMax: 3,
  /** 品牌 / 合作方名称（可能带子品牌或组合名，留出余量） */
  endorseBrandChars: 20,
  /** 一句说明（是什么合作、什么时候） */
  endorseNoteChars: 40,

  /** 名词解释：行话注解只是阅读辅助，摆满一屏就成了词典 */
  glossaryMax: 5,
  glossaryTermChars: 10,
  glossaryExplainChars: 50,

  /** 争议与回应 */
  controversyMax: 3,
  controversyTopicChars: 12,
  controversyClaimChars: 60,
  /** 单侧回应：装得下一句「XX 已回应……」，与 conflicts 的单侧说法同档 */
  controversyResponseChars: 40
} as const

/**
 * 提示词里给模型的**条数目标**（utils/report.ts 的第 3~13 条与会员补充段的 conflicts）。
 *
 * 为什么值得单列：这些条数不只是「写多少」的建议 —— 端上有六处**卡在条数上**
 * （词云 ≥2 条命中才成词、语录主题 ≥4 条、热度趋势 ≥3 条、情绪条按 dynamics 条数算比例、
 * 风险雷达从全篇字面挑，以及 buildReport 的达标判定 dynamics+quotes+timeline ≥ shortfallMinFacts）。
 * 模型给两三条就收工，用户看到的不是「写得少」，而是**一整块卡片直接消失**。
 *
 * ⚠ 与 REPORT_FIELD_LIMITS 的关系：条数的**上限**就是那边的裁剪上限（模型多给会被裁掉 ——
 *   白给），所以本表不重复写上限，需要上限的地方直接引用 REPORT_FIELD_LIMITS 的同名项
 *   （见 utils/report.ts 提示词里的 analysisPoints / profile / relations / endorsements /
 *   glossary / controversies / conflicts 七处）。
 *
 * ⚠ 与提示词里**字数上限**（「40 字内」这类）的关系：两者**不是同一个刻度**，刻意不共用 ——
 *   提示词写的是希望模型写的长度，REPORT_FIELD_LIMITS 是端上的兜底裁剪线，可以不同
 *   （例：点评 point 提示词要求 40 字内，裁剪线却是 80 字）。改一处不要顺手改另一处。
 */
export const REPORT_QUOTAS = {
  /** dynamics 条数：给「N~M 条」，素材充足时尽量给到 target */
  dynamicsMin: 3,
  dynamicsMax: 6,
  dynamicsTarget: 5,
  /*
   * ⚠ 「输出规模」这件事的落点不在这里，也不在 REPORT_FIELD_LIMITS，而在下面的
   *   REPORT_OUTPUT_BUDGET + utils/report.ts#FIELD_OUTPUT_ESTIMATE（test/cases/20 校验）。
   *   加字段 / 放条数之前先过一遍那份估算：区间放大 2 倍，撞 max_tokens 的概率不是 2 倍
   *   —— 撞上就是整批 JSON 截断（见那边注释），那一批的卡片全空。
   */

  /** quotes 条数 */
  quotesMin: 2,
  quotesMax: 5,
  quotesTarget: 4,

  /** analysisPoints 条数（上限 = REPORT_FIELD_LIMITS.analysisPointMax） */
  analysisPointsMin: 3,

  /** stance 条数 */
  stanceMin: 2,
  stanceMax: 4,

  /** timeline 条数 */
  timelineMin: 3,
  timelineMax: 8,
  timelineTarget: 5,

  /** profile 条数（上限 = REPORT_FIELD_LIMITS.profileMax） */
  profileMin: 3,
  profileTarget: 5,

  /** endorsements 条数目标（上限 = REPORT_FIELD_LIMITS.endorseMax）；素材充足时尽量给到 */
  endorseTarget: 2
} as const

/**
 * 单次调用的**输出预算**（分批生成，2026-10-11 补）。
 *
 * 为什么需要它：报告是长 JSON，撞上 max_tokens 的下场不是「少写一点」，而是**整批截断**
 * （JSON 解析失败 → 这一批的字段全空 → 页面上整块卡片直接消失，看起来像「素材不足」）。
 * 分批之后每一批的输出规模**是可以算出来的**（字段条数上限 × 每条字数 + JSON 开销），
 * 于是本表 + utils/report.ts#FIELD_OUTPUT_ESTIMATE 一起构成可静态校验的预算口径：
 *   · test/cases/20 逐批估一遍，超线即红（改字段 / 放条数时就该撞在这一关，而不是线上）；
 *   · 「预算」按 `chatMaxTokens × (1 − reasoningReserve)` 算，不是整个 max_tokens ——
 *     推理模型的思考（reasoning_content）同样计入 max_tokens（见 aiProxy 的 reasoningChars 日志）。
 *
 * ⚠ chatMaxTokens 的**真源在云端**（cloudfunctions/{aiProxy,hotBoardRefresh}/llm.config.js 的
 *   CHAT_MAX_TOKENS），本值是它的副本，由 test/cases/20 读那份文件核对 ——
 *   两边漂移的话，这里的「余量」就是假的（端上以为还有一半，云端其实只给一半）。
 */
export const REPORT_OUTPUT_BUDGET = {
  /** 与云端 CHAT_MAX_TOKENS 一致（用例 20 校验） */
  chatMaxTokens: 8192,
  /**
   * 推理「思考」可能吃掉的份额：报告是长 JSON，思考一旦吃掉大半限额，正文就会被截断，
   * 故单批正文的估算规模必须留在 `chatMaxTokens × (1 − 本值)` 以内。
   * 取 0.4 是一次有意留宽的取舍：宁可逼着我们把字段写短、把批拆细，也不赌「这次没思考」。
   */
  reasoningReserve: 0.4,
  /**
   * 换算口径：保守取 1 字 ≈ 1 token（中文大致就是 1 字 1 token，英文与 URL 更省），
   * 即估算出来的 token 数只会偏大 —— 校验宁可误报，也不要漏放一次截断。
   */
  charsPerToken: 1
} as const

/**
 * 检索厚度（utils/search.ts）。
 *
 * main / social 是**一次生成**的主线与社交支线，bg 是独立的人物背景线
 * （只捞不限时间的履历资料，关键词与时间语义见 utils/report-toc.ts#SEARCH_LANES 的 profile 路），
 * ask 是问答链路的补充检索。
 *
 * ⚠ 深度档（deep*）只在**报告生成路径**生效：报告是一次生成、长期缓存的资产，加厚一次长期受益；
 *   关注流刷新是每日多次的常态动作，放大等于常态成本翻倍而用户几乎无感。
 * ⚠ main + social 合起来要 ≤ SEARCH_MAX.member，否则「要了也拿不到」（云端按档位钳制）。
 */
export const SEARCH_COUNTS = {
  /** 单次检索的重试次数 */
  maxAttempts: 3,
  /** 端上「要多少条」的上限：取两档中大的那个，真正按身份钳住的是云函数 */
  maxResultsCap: 40,

  /** 主线默认条数（免费口径，与改造前一致） */
  mainCount: 10,

  /**
   * 主线检索的**时间窗阶梯**（天）：一档抓空就试下一档（实现见 utils/search.ts#fetchNews）。
   *
   * 为什么需要：冷门 / 低产名人的报道常是「半年内有过、近 30 天没有」—— 单档配置下直接
   * 空手而归，用户看到「暂未检索到公开信息」。对**付费**用户尤其不可接受：他买的就是「查得到」。
   * ⚠ 只放宽到「年内」为止（`freshnessOf(365)` = oneYear）：`dynamics` 要的是近期动态，
   *   `noLimit` 会把年代久远的事件混成「近期」，那比空着更糟（与背景线用 noLimit 是两回事，
   *   那条只捞履历、不进 dynamics）。
   * 成本：只有上一档为空时才发下一档，正常人物仍是 1 次调用；最坏几次见下方 planWordsPerLane。
   */
  mainFreshnessLadderDays: [30, 365],

  /**
   * 检索词规划：**模型每路最多被采纳几个词**（实现见 utils/search-plan.ts）。
   *
   * 它直接决定最坏检索次数 —— 查询阶梯是「模型词（≤本值）→ 模板句式 → 只留人名」：
   *   主线 `本值 + mainFreshnessLadderDays.length`，社交 / 背景 `本值 + 1`。
   * 取 2 是两头的取舍：给模型一点发挥余地，又别为一次抓空多买两轮检索
   * （正常人物第一档就命中，这部分成本只在长尾人物上才发生）。
   */
  planWordsPerLane: 2,
  /** 社交支线：够补齐社交维度即可，不为支线付主线的检索成本 */
  socialCount: 8,
  /** 会员深度档：24 + 16 正好吃满 MEMBER_SEARCH_MAX(40)，不越界、也留不出「要了却拿不到」的空档 */
  deepMainCount: 24,
  deepSocialCount: 16,

  /** 免费档人物背景线：够补出档案与时间线即可，不为「一次生成」付两次深度检索的钱 */
  bgCount: 8,
  /** 会员档背景线（随深度模式一并加厚） */
  deepBgCount: 12,

  /** 问答联网检索条数：够补「报告之后发生了什么」即可，不为一次提问付生成级的检索成本 */
  askCount: 8,
  /** 问答检索的时间窗（天）：用户问的往往是「最近」，而报告可能已是两周前的快照 */
  askFreshnessDays: 7
} as const

/* ═══════════════════════════════════════════════════════════════════════════
 * 四、舆情功能的免费 / 会员分层上限（P2，2026-10-13）
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 舆情功能的免费 / 会员分层上限（数值即策略，改这里即改策略）。
 *
 * 三个维度（口径由产品确认）：
 *   followCount —— 能关注多少位名人；
 *   watchCount  —— 能订阅多少个**关键词监控**（`keyword_watches` 里 type='keyword' 的行；
 *                  不含「监控某人」的 type='person' 行，那是另一套上限）；
 *   detailRows  —— 舆情页每块**明细**最多显示几条；会员用 `null` = 不截断（显示全部）。
 *
 * ## 这条规则怎么用（使用者必须遵守）
 *
 * 1. **只拦新增，绝不删存量、绝不阻塞查看**：线上已有用户可能已经关注了超过
 *    `followCount.free` 的人、或订阅了超过 `watchCount.free` 个词 —— 这些既有数据必须
 *    **原样保留、照常可看可用**，超限部分只影响「继续新增」。任何自动删除 / 隐藏 / 让既有
 *    数据失效的做法都禁止。`detailRows` 只用于**页面展示截断**，绝不用来删数据。
 * 2. **端上上限只是体验层，不是安全边界**：关注列表与监控词是用户自己的数据、由端上直接
 *    写入（`follows` / `keyword_watches` 集合权限为「仅创建者可读写」），改包即可绕过这里的
 *    任何数值。所以真正的成本边界在云端：**关键词监控的新增已由云函数 keywordAlert 按
 *    `memberships`（权威会员表）分档校验数量**（P4，2026-10-13 落地，写入路径 action:'add'）；
 *    「监控某人」那条仍由 riskWatch 按每人不分档的硬上限兜底。本表只负责端上体验，别把它当闸门。
 *
 * ⚠ 派生值（各档上限的取用、门禁判定）由 `utils/opinion-access.ts` 现算，不在这里计算。
 */
export const OPINION_LIMITS = {
  /** 关注人数上限 */
  followCount: { free: 3, member: 30 },
  /** 关键词监控数上限（只算关键词行，不含「监控某人」） */
  watchCount: { free: 1, member: 10 },
  /** 舆情页每块明细可见条数；`member: null` = 不截断（显示全部） */
  detailRows: { free: 5, member: null }
} as const
