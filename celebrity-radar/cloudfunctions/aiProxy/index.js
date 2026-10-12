/**
 * aiProxy —— 平台代付模式的额度闸门。
 *
 * 小程序包可解包、前端一切可见，平台自有 key 一旦下发到客户端即等同公开
 * （见 src/config/public.ts）。大模型选型是「厂商 × 质量档 × 能力槽」，
 * 全部在同目录 llm.config.js 一处裁决，通道有两条：
 *   ① cloudai（默认厂商 cloudbase）：微信云开发 AI（`cloud.ai`，需 wx-server-sdk ≥ 4.0.1），零 key；
 *   ② http：OpenAI 兼容直连外部厂商（DeepSeek / 智谱 GLM / Kimi），key 只放云函数环境变量。
 * 用户在端上选「厂商 + 质量档（基础/标准/高级）」，用途决定能力槽：
 * 报告/辅助 → structured（输出型），问答 → reasoning（推理型）；免费用户卡在基础档。
 *   控制台 → 云函数 → aiProxy → 配置 → 环境变量：
 *     BOCHA_API_KEY                     博查搜索 key（检索源仍要 key，这条路没变）
 *     SERPER_API_KEY / TAVILY_API_KEY   第二检索源（可选，注册哪家填哪个）
 *     LLM_VENDOR                        可选：定时任务 / 端上没带厂商时的默认厂商
 *     LLM_TIER                          可选：默认质量档（basic / standard / premium）
 *     <VENDOR>_API_KEY                  可选：外部厂商 key（DEEPSEEK / ZHIPU / MOONSHOT）
 *     LLM_MODEL_<VENDOR>_<QUALITY>_<CAP> 可选：覆盖任一槽位模型名
 * 详见 llm.config.js 文件头。严禁把任何 key 写进本文件或任何提交进 git 的文件。
 *
 * action：
 *   'test'   运维探针：用云开发 AI 真实各打一次，验证「SDK 就位 + 模型名确已开通 + 能出正文」。
 *            ⚠ 它**不是默认动作**，且要口令（环境变量 AI_PROXY_TEST_TOKEN，未配置一律拒绝）——
 *            每次调用都真花钱，而 action 是客户端可构造的字段：把缺省值绑在付费探针上，
 *            等于给任何调用者留一个「一次调用烧两笔上游钱」的开关（2026-10-09 修，见 exports.main）。
 *            端上「我的 → 测试连通性」入口已于 2026-10-07 移除（改为只保留「生成档位」选择），
 *            此动作现在只供控制台 / 云调用人工排障使用，业务链路只走 search / chat / generate / aux。
 *            三个**可选**字段各自独立收费，都必须显式传（缺省一律不发，见 exports.main）：
 *              models: true        逐槽实测当前厂商 3 档 × 2 能力槽是否产 reasoning（probeModelTiers）
 *              probeModels: [...]  改探给定的候选模型名，回答「该换成哪个模型」（同上，最多 MAX_PROBE_MODELS 个）
 *              listModels: true    列注册表全部厂商×档×槽的模型清单（probeModelList）
 *            models / probeModels 之上可再叠加 bench: true：把探针负载从「连通性两句」换成
 *            「模拟 facts 批体量的长 JSON」（BENCH_* 常量），按真实 8192 上限出正文、撞同一道 45s 墙 ——
 *            回答「这个模型生成 facts 批要几秒 / 会不会超时」，才是换模型前真正的耗时基准。
 *   'search' 业务转发：代理一次博查检索，供端上 search.ts 在用户未自配 key 时使用
 *   'chat' / 'generate' / 'aux'
 *             业务转发：代理一次大模型对话，供端上 llm.ts 使用（端上不再自配 key）。
 *             三者都进 handleChat、只语义不同：'chat'=AI 问答（ask）、'generate'=报告/周报长生成、
 *             'aux'=消歧/选题/检索规划等辅助小请求；实际额度池与时限按 event.purpose 分档。
 *             端上携带 event.vendor + event.quality，能力槽由 purpose 在云端裁决。
 *   'vendors' 免口令只读：返回注册表厂商清单与各家 key 是否已配（布尔），
 *             供「我的」页厂商选择器只展示就绪厂商；不触达上游、不回任何 key 内容。
 *
 * ⚠ 本函数同时是**付费闸门**（2026-10-07 起）：chat 的质量档按会员身份放行（标准/高级仅会员），
 * search 的 count 上限同样分档（见 llm.config.js 的 QUALITIES[...].memberOnly / FREE_SEARCH_MAX 的注释）。
 * 「深度模式」（O-11）也只在这一层放行 —— 它现在只剩**素材加厚**（search 的 count 分档）：
 * chat 的输出上限（chatMaxTokens）自 2026-10-08 起对所有请求下发，不再按会员分档，
 * 理由是它是「这一轮要写多长」的客观需求而不是权益（截断会让整份报告降级，见下方注释）。
 * 端上的会员判定只影响 UI 与请求值，改包即可绕过；凡是要花上游钱的权益都必须在这里拦一次。
 *
 * chat 的耗时约束（务必先读）：
 *   报告正文属长生成，单次可能逼近云函数上限，所以**我们自己给每次调用掐一个时限**
 *   （CHAT_DEADLINE_MS / AUX_CHAT_DEADLINE_MS，见它们的注释），并让它**小于本函数的执行超时**。
 *
 *   ⚠ 执行超时只能在控制台改：微信云开发给云函数配的默认超时是 **20 秒**，
 *   而本目录 config.json / cloudbaserc.json 里写的 timeout **不随上传生效**（实测仍是 20s）。
 *   配置路径：云开发控制台 → 云函数 → aiProxy → 配置 → 超时时间，改成 60 秒并保存（改完即生效）。
 *   **60 秒就是天花板**（微信云函数的上限，调不上去），所以「把超时调大」这条出路不存在 ——
 *   函数必须自己管住自己：撞到时限就主动断开并按普通失败返回（kind=network，可重试）。
 *
 *   被平台掐断的后果（2026-10-11 之前的样子）：函数没有机会返回任何 kind / error，
 *   端上只能拿到 errCode -504003（FUNCTIONS_TIME_LIMIT_EXCEEDED），表现为一句无从下手的「生成失败」，
 *   且控制台里连一行原因都没有。现在这条路已经堵上，但**平台掐断仍可能发生在别处**
 *   （例如检索侧的两次上游调用叠加），故端上保留识别并翻成可照做的提示
 *   （src/utils/cloud.ts 的 cloudTimeoutHint）。
 */
const cloud = require('wx-server-sdk')
const https = require('https')
/*
 * 厂商 × 质量档 × 能力槽注册表 + 解析（换模型改它，不改本文件）。⚠ 与 hotBoardRefresh 目录下的副本逐字一致。
 * VENDORS / QUALITIES / vendorCatalog 本身也要导入：模型探针要列出**全部槽位**的模型名，
 * 而 resolveLlm 只回当前生效的那一条路由（它回的是裁决结果，不是清单）。
 */
const { VENDORS, QUALITIES, vendorCatalog, resolveLlm } = require('./llm.config')
/* 服务端配额与限速（B8）：上限数值由 benefits.config.js 提供，本文件只管判定 */
const {
  QUOTA_POOLS,
  DEFAULT_PURPOSE,
  AUX_PURPOSE,
  ABUSE_TABLE,
  ABUSE_LIMITS,
  quotaGuardDisabled,
  todayKey
} = require('./quota.config')
/* 权益数值（自动生成，真源 src/config/benefits.ts）：检索条数上限与单请求字符上限 */
const { SEARCH_MAX, MAX_CHAT_CHARS } = require('./benefits.config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
/*
 * 第二检索源（2026-10-10）：**博查抓到空内容时的兜底**。
 *
 * 为什么需要：全项目此前只有博查一个源，而冷门 / 低产名人常常是「博查没收录、别家有」。
 * 端上 `fetchNews` 的降级阶梯（换句式 / 放宽时间窗）解决的是「同一个源里的查法问题」，
 * 解决不了「这个源根本没有」—— 两件事，故两条都要有。
 *
 * 为什么是「多家自动探测」而不是钉死一家：**注册门槛才是这条路唯一的阻塞点**。
 * 最初选的是 Bing Web Search，但微软 2023-08 起停止接受 Bing Search API 新客户、
 * 2025-08-11 正式退役，Azure 门户里已经建不出这个资源了（且 Azure 本身要信用卡）——
 * 相关代码已整体移除、不再保留。现在只剩这两家：按顺序取**第一个配了 key 的**，
 * 你注册哪家就填哪个变量，代码一行都不用动。
 * 一个都没配 = 整条跳过，行为与没有兜底时完全一致。
 *
 * ⚠ 两家的响应结构都与博查不同，**适配器里必须翻译成博查那套字段名**
 *   （name / url / snippet）：端上 toNewsItem 与报告层的出处白名单按这三个字段认，
 *   缺一个就会被当成无效素材剔掉。
 * ⚠ 两家都在**境外**：从腾讯云（境内）调用要绕国际出口，延迟明显高于博查，
 *   且可达性受跨境链路影响。故 `test` 探针会把两家的连通性与耗时一并报出来 ——
 *   部署后先跑一次探针，比在报告里瞎猜强（见 handleTest）。
 */
const SERPER_ENDPOINT = 'https://google.serper.dev/search'
/** freshness → Google 的 tbs 时间过滤（qdr:d/w/m/y）；更宽的两档不下发 = 不限时间 */
const SERPER_TBS = { oneDay: 'qdr:d', oneWeek: 'qdr:w', oneMonth: 'qdr:m', oneYear: 'qdr:y' }
/** Serper 单次条数（官方上限 100；取 50，够用且省额度） */
const SERPER_MAX_COUNT = 50

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
/** Tavily 单次条数（官方上限 20） */
const TAVILY_MAX_COUNT = 20

const TIMEOUT_MS = 15000
const SNIPPET = 200
/*
 * 逐档探针一次最多探几个模型名（见 probeModelTiers 的 requested 分支）。
 * 每次探测都是一次**真实付费**的上游请求，而 probeModels 是运维手填的清单 ——
 * 这个上限防的是手滑（把一个几十项的清单粘进来），不是产品限制。
 */
const MAX_PROBE_MODELS = 12

/*
 * 探针单次的输出上限（probeLlm / probeModelTiers）：探测只要「有没有正文 / 带不带思考」这点信息，
 * 用不着 8192，给 1024 足够且更省 —— 但**别压到 1**：思考模型会先把预算花在 reasoning_content 上，
 * 太小虽仍能靠 reasoningChars>0 判出来，却会让 finish_reason 变成 length 而干扰判断。
 */
const PROBE_MAX_TOKENS = 1024

/*
 * 长生成基准负载（bench 探针）：上面的 PROBE_MAX_TOKENS 只够「连通性」探测，测不出
 * 「生成 facts 批（6 动态 + 5 语录 ≈ 3000 字）要几秒」—— 而报告超时的痛恰恰在这个量级。
 * 故探针支持 `bench: true`：改用下面这套模拟 facts 批体量的负载、并按真实上限 8192 出正文，
 * 撞的是同一道 45s 墙（probeModelTiers 调 callCloudAi 不传 purpose，deadlineOf 落到 CHAT_DEADLINE_MS），
 * 于是 elapsedMs 与「ok=false + 超时」就能直接回答「这个模型换上去会不会还超时」。
 * 内容刻意允许虚构 —— 它只测速、不落库，不必背上报告「不编造事实」的契约。
 */
const BENCH_MAX_TOKENS = 8192
const BENCH_SYSTEM = [
  '你是性能基准测试助手。请输出一个 JSON 对象（仅用于测速，内容可虚构）：',
  '{"dynamics":[{"date":"YYYY-MM","title":"","summary":"","source":"","url":"","sentiment":""}],',
  '"quotes":[{"text":"","context":"","background":"","note":"","source":""}]}',
  'dynamics 给 6 条、quotes 给 5 条，每条字段都要写满，体量对齐真实报告。'
].join('\n')
const BENCH_USER = '人物：雷军'

/*
 * 质量档闸门（「质」权益，2026-10-07；2026-10-12 改为厂商×质量档模型）：
 * 质量档在 llm.config.js 的 QUALITIES（每档一个 memberOnly），
 * resolveLlm 返回的 memberOnly 即「本次落档要不要卡会员」。
 * ⚠ 端上 src/config/public.ts 的 llm.qualities 决定 UI 与请求值，**云函数这份才是计费闸门** ——
 * 小程序包可解包，端上判定改包即可绕过，只有这里拦得住「非会员用标准 / 高级档」。
 */

/*
 * 检索条数上限（按会员分档，2026-10-07）：
 *   free   就是改造前的硬上限 20，**不得下调**：端上主线 / 支线默认取 10 / 8，
 *          下调等于回头削减既有免费额度，属于端上无感的「偷偷涨价」。
 *   member 为「深度模式」（会员生成时素材加厚）预留的服务端能力；
 *          端上接线前它只是把上限放宽，不改变任何现有行为。
 * 数值取自 benefits.config.js（真源 src/config/benefits.ts 的 SEARCH_MAX）。
 */
const FREE_SEARCH_MAX = SEARCH_MAX.free
const MEMBER_SEARCH_MAX = SEARCH_MAX.member

/*
 * 对话输出上限（O-11 第二步 2026-10-07 只给会员，2026-10-08 起对所有请求下发）。
 *
 * 为什么不再按会员分档：「报告有多长」不是权益，而是事实 —— 报告正文是多段摘要 + 逐条动态的长
 * JSON，第二批（档案 / 关系 / 后续关注 / 名词解释 / 争议）又往**免费**提示词里加了 5 段，
 * 于是免费报告的 JSON 顶过了上游默认上限（DeepSeek 4096）。贴上限的后果不是「少一段」，
 * 而是尾部被截断 → JSON 解析不出 → 重试再失败 → 整份报告降级成纯文本简版：
 * 报告页的结构化卡片成批消失，看着像功能被删了，还白付两次生成的钱。
 * 它仍是**输出上限**而不是额度：不设时上游用自己的默认值，设了只是把上限抬到「够写完整份报告」。
 * 上限值随供应商配置（llm.config.js 的 chatMaxTokens，默认 8192）。
 */

/**
 * 一次对话调用允许占用的**墙钟时间**上限（毫秒）—— 我们自己掐，不等平台掐。
 *
 * 现场（2026-10-11）：端上报 `errCode: -504003 | Invoking task timed out after 60 seconds`。
 * 这行字是**平台**把本函数掐死在 60 秒（微信云函数执行上限，控制台调到 60 就是天花板）时给的，
 * 此时函数已经死了：既没来得及返回 `{ ok:false, kind }`，也没留下一行日志 ——
 * 端上只拿到一句平台文案，判不出是超时、还是上游断流，自然也谈不上重试与否。
 *
 * 为什么不能只靠 SDK 的 `{ timeout }`：它管得住「请求发出去、响应回来」这一段，
 * 管不住**消费整条流要多久** —— 上游半死不活、每几秒挤一个字，照样能拖过 60 秒。
 * 换成 streamText 之前走的是 postJson（一个真·整体超时，到点必抛），
 * 所以旧的 50 秒是真保证；改成流式之后这条保证没了，
 * 于是「4 批 × 每批 2 次尝试」的算式里出现了一个能撞穿平台上限的洞。
 *
 * 取值 45 秒：**必须明显小于平台的 60 秒**，留出冷启动、DB 读写与回包的时间。
 * 撞到它时由 callCloudAi 主动中止并抛错，handleChat 照常归类返回（见 deadlineOf）。
 */
const CHAT_DEADLINE_MS = readDeadlineMs('AI_PROXY_CHAT_DEADLINE_MS', 45000)

/**
 * 辅助调用（消歧 / 选题 / 检索词规划）的墙钟上限：20 秒。
 *
 * 为什么单独一层、而且更短：这类调用**输出只有一小段 JSON**（一个名字、几个检索词），
 * 正常两三秒就完事；而它们全部卡在用户能感知的路径上（生成前先消歧、先规划检索词），
 * 且**每一个都有非 AI 兜底**（消歧回落候选列表、规划回落模板句式）——
 * 换句话说，把它们掐掉的代价是「少一次加分」，不是功能丧失。
 * 反过来，若沿用报告档的 45 秒：一次卡住的规划调用会让用户在「检索中」之前白等 45 秒，
 * 还会把这份预算吃掉，把后面的报告批次挤到平台上限上去。
 */
const AUX_CHAT_DEADLINE_MS = readDeadlineMs('AI_PROXY_AUX_DEADLINE_MS', 20000)

/** 读一个毫秒数环境变量：不合法/未设置一律退回默认值（联调与用例用，见 test/cases/07 的时限用例） */
function readDeadlineMs(name, fallback) {
  const raw = readEnv(name)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 本次调用用哪一档时限：aux 是「生成之前、必须快」的那一类（理由见 AUX_CHAT_DEADLINE_MS） */
function deadlineOf(purpose) {
  return purpose === AUX_PURPOSE ? AUX_CHAT_DEADLINE_MS : CHAT_DEADLINE_MS
}

/**
 * 「自己掐的」超时错误。带一个可识别的标记：
 * handleChat 靠它把归类与文案都走自己的分支，而不是交给 classifyAiError + failDetail 去猜
 * —— failDetail 见到「超时」二字就会让用户去控制台调超时时间，而这里的现场恰恰是「已经是 60 秒上限」。
 */
function deadlineError(ms, purpose) {
  /* 毫秒级只在联调时出现（默认 45s / 20s），但文案别写成「0 秒」让人以为没时限 */
  const human = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`
  const err = new Error(
    `上游流式响应超过本次调用时限 ${human}（${purpose}）：` +
      '已在平台 60 秒强制中止之前主动断开，以免任务被直接掐死（那样连原因都留不下）。' +
      '若反复出现，请改用基础档或非推理模型后重试 —— 推理槽模型会先花大量时间思考，' +
      '单次很容易撞上这个时限。'
  )
  err.isDeadline = true
  err.deadlineMs = ms
  return err
}
/*
 * 防滥用：这是一条「平台付钱、客户端随便调」的通道，不设闸门就等于对外送一个免费 LLM 网关。
 * 端上实际只发 system + user 两条，这里的上限留了余量而非贴着用。
 * MAX_CHAT_CHARS（单请求字符上限）来自 benefits.config.js —— 端上构造 user 消息时
 * 按同一个值留余量，同源才不会出现「端上以为发得出去、云端直接拒」。
 */
const MAX_CHAT_MESSAGES = 6

function readEnv(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * 云端原始报文打印（**排障用**，默认关闭）。
 *
 * 为什么需要它：端上有 `utils/debug.ts#debugRaw`（`debug.rawIoLog`），但那条只能看到
 * **云函数的返回** —— 「上游到底回了什么」永远看不到。而云端恰恰是这类问题的主场：
 *   上游 200 但结构异常（解析器把正文吃掉了）、检索只回 3 条、模型输出被 max_tokens
 *   截断（`finish_reason: 'length'`）…… 这些在端上要么被折成一句「平台通道未就绪」，
 *   要么根本无从判断。
 *
 * ⚠ **只在「云开发控制台 → 云函数 → 日志」里看得到**，不在微信开发者工具的 Console
 *   （那是端上的 console），两者是两套东西。
 *
 * 开关：环境变量 `AI_PROXY_RAW_LOG=on`，**默认关闭、只认 'on'**。
 * 与 `AI_PROXY_QUOTA_GUARD` 的策略相反是刻意的：那个放开的是闸门，漏配的代价是「拦得狠」
 * （症状显眼）；这个打的是上游报文，漏配的代价是**线上持续吐日志**（噪音，且模型正文会被
 * 记进日志平台），所以必须显式打开。
 *
 * ⚠ **截断后再打**：云函数日志有大小上限，几万字的报告正文灌进去会挤掉同一次调用里的
 *   计费 / 配额日志。要看完整报文请用端上的 `debugRaw`（那里传的是对象，Console 可逐层展开）。
 */
function rawLog(tag, payload) {
  /* 每次现读 env、不缓存模块级常量：与 readEnv 同一取舍，也便于测试里开关取值 */
  if ((process.env.AI_PROXY_RAW_LOG || '').toLowerCase() !== 'on') return
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    console.log(`[raw:${tag}]`, String(text).slice(0, 2000))
  } catch {
    /* 循环引用等极端结构不该影响主流程（与端上 debugRaw 同一取舍） */
  }
}

/** 只回长度与是否配置，绝不回明文片段：该值会进入客户端可读的返回值 */
function keyInfo(key) {
  return { configured: !!key, length: key ? key.length : 0 }
}

/**
 * 调用者是不是有效期内的会员。
 *
 * 读 `memberships`（服务端权威，_id = openid，客户端完全不可见）—— **刻意不读
 * users.membership**：后者所在的那张表是「仅创建者可读写」，端上能改自己那一行，
 * 以它为准等于把「谁能用最贵那一档模型」交给客户端自证（改包者给自己写上 membership
 * 即可白用）。端上读的 users.membership 只是界面镜像，见 dbInit/schema.js 的两条 purpose。
 *
 * 与端上 utils/member.ts 同一口径：只认 expires_at，不校验 plan —— 有效期是唯一事实，
 * plan 只决定天数。
 *
 * 读库失败一律按**非会员**：方向与端上 readMemberState 一致 ——
 * 宁可让真会员这一次拿到降级模型（体验损失），也不能让非会员刷走最贵的那一档（成本损失）。
 */
async function isActiveMember(openid) {
  if (!openid) return false
  try {
    const res = await db.collection('memberships').doc(openid).get()
    const m = (res && res.data) || null
    const t = m && m.expires_at ? Date.parse(m.expires_at) : NaN
    return Number.isFinite(t) && t > Date.now()
  } catch (err) {
    return false
  }
}

/**
 * 当日配额计数：行不存在时 doc().get() 直接抛错（与 quotaGuard 的 readCount 同一现象），
 * 读失败一律按 0。
 *
 * 按 0 = **放行**是有意的：闸门自己读不到库，不能把所有人挡在生成之外。
 * 这里也不存在「攻击者把闸门打瘫」的口子 —— 这几张表的读写权限都在我们手上，
 * 端上既不能让它们读失败，也改不动其中的计数。
 */
async function readQuotaCount(table, id) {
  try {
    const res = await db.collection(table).doc(id).get()
    const c = res && res.data && res.data.count
    return typeof c === 'number' && c > 0 ? c : 0
  } catch (err) {
    return 0
  }
}

/**
 * 防滥用计数：**由本函数自己原子自增**，端上无法阻止 —— 这是它区别于产品额度的关键。
 *
 * 返回**自增之后**的计数；读不到 / 写失败时返回 null，由调用方放行。
 * 「先自增、再按返回值判定」是这里的关键（P1 修复，2026-10-09）：原实现是
 * 「先读计数 → 判超限 → 再自增」，两步之间留了一个 TOCTOU 窗口 —— 并发的一批请求会
 * 同时读到同一个旧值而全部放行，这个「成本硬边界」被一次性放大 N 倍。
 * 自增（db.command.inc）本身是原子的，所以「自增后判定」天然并发安全。
 *
 * 先 update(inc) 再按需 add：正常路径只有一次写；首次调用（行不存在）时 update 不生效
 * （updated === 0），再 add 建行。并发时两个请求可能同时走到 add，撞 _id 的那个由内层
 * catch 兜住 —— 那一刻行已经建好，改回自增路径补上这一次（不再「少计 1 次」）。
 *
 * 自增失败不拦调用（返回 null，只记一行 warn）：闸门的作用是限速，不该把一次写库抖动
 * 放大成「所有人都不能用」。而攻击者也没有办法让这里的写失败 —— 表的权限在我们手上。
 */

/**
 * 「行已存在」时原子自增一次，返回**有没有落实**（updated > 0）。
 *
 * ⚠ V-1（2026-10-09 复审）：`doc(id).update()` 打到**不存在的行**时，wx-server-sdk 的真实行为
 * 尚未在真机确认 —— 可能返回 `stats.updated === 0`，也可能**直接抛错**（两个版本上都出现过）。
 * 本函数只依赖「自增有没有落实」，与具体是哪种无关，故把抛错**一律归一成 0**：
 * 若按「抛错 = 故障」处理（即让异常浮到外层 catch），那么每个用户每天**首次**调用
 * （那一行还不存在）都会直接进 catch 返回 null（放行）⇒ 计数行永远建不起来、这道成本硬边界
 * 静默失效。这正是 V-1 指出的风险点，归一成 0 后两种真机行为下结论完全一致。
 */
async function incrAbuseRow(key) {
  try {
    const upd = await db.collection(ABUSE_TABLE).doc(key).update({ data: { count: db.command.inc(1) } })
    return (upd && upd.stats && upd.stats.updated) || 0
  } catch (err) {
    return 0
  }
}

async function bumpAbuseCount(key, openid) {
  try {
    if (!(await incrAbuseRow(key))) {
      try {
        await db
          .collection(ABUSE_TABLE)
          .add({ data: { _id: key, _openid: openid, count: 1, date: todayKey() } })
        return 1
      } catch (err) {
        /* 并发：另一端刚插好这一行，改回自增路径补上本次；仍失败则返回 null 由调用方放行 */
        if (!(await incrAbuseRow(key))) return null
      }
    }
    return await readQuotaCount(ABUSE_TABLE, key)
  } catch (err) {
    console.warn('aiProxy 防滥用计数自增失败（本次放行）:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 真正付费的上游调用之前的闸门（B8，2026-10-09）。返回 null = 放行，否则返回拒绝体。
 *
 * ## 两道闸，防两件不同的事（详述见 quota.config.js 顶部）
 *
 * 1. **产品额度**（辅助调用除外）：读 quotaGuard 维护的当日计数，比对与端上同值的上限。
 *    它防的是「端上与云端口径不一致」——多设备各算一份、或设备时钟偏差让端上以为还有额度。
 *    ⚠ 这道闸的计数是端上主动调 quotaGuard 才写的，改包者不调就永远是 0，
 *      所以它**不是安全边界**，只是口径兜底（旧注释曾称云端是最终判定，那是不准确的）。
 *
 * 2. **防滥用限速**：计数由本函数就地原子自增（bumpAbuseCount），端上无法阻止 ——
 *    于是「解包把上限改大、随便调」的代价被压进 ABUSE_LIMITS 之内。**这才是成本侧的硬边界**。
 *
 * 会员档位一律取自 `memberships`（端上不可读写，见 isActiveMember），故自授会员无助于成本。
 *
 * 拒绝体的 kind：'quota'（产品额度用完，文案与端上 utils/member.ts#quotaExhaustedMessage
 * 同构 —— 同一种「额度用完」在不同路径上应当说同一句话）与 'abuse'（触发限速）。
 * 两者都不在端上 llm.ts 的 RETRYABLE_KINDS 里 ⇒ 不重试、不点冷却，文案原样透传。
 *
 * 本地联调（2026-10-09 补）：`AI_PROXY_QUOTA_GUARD=off` 时两道闸都只放开**判定**、
 * 计数照旧自增（见 quota.config.js#quotaGuardDisabled）。端上的 debug.disableGenerateQuota
 * 只关端上那道闸，云端不认端上标记，所以联调时要两边同时放开 —— 否则会撞上
 * 「debug 开了、生成第 4 次仍报额度用完」这种看起来像开关失效的现象。
 */
async function quotaGate(openid, purpose, isMember) {
  const member = await isMember()
  const kind = purpose || DEFAULT_PURPOSE
  const today = todayKey()
  /* 调试放行只跳过「判上限」，下面两道计数照常写（排查时能看到真实用量） */
  const guardOff = quotaGuardDisabled()

  /* ① 产品额度：辅助调用不占额度（理由见 quota.config.js 的 AUX_PURPOSE） */
  if (kind !== AUX_PURPOSE && !guardOff) {
    const pool = QUOTA_POOLS[kind] || QUOTA_POOLS[DEFAULT_PURPOSE]
    const limit = member ? pool.member : pool.free
    const count = await readQuotaCount(pool.table, `${openid}#${today}`)
    if (count >= limit) {
      const who = member ? '会员' : '免费版'
      const head =
        kind === 'ask'
          ? `今日提问次数已用完（${who}每日 ${limit} 次），明日 0 点恢复`
          : `今日报告生成额度已用完（${who}每日 ${limit} 次），明日 0 点恢复`
      const upsell = member ? '' : `；开通会员可提到每日 ${pool.member} 次`
      return { ok: false, kind: 'quota', error: `${head}${upsell}` }
    }
  }

  /*
   * ② 防滥用限速：**先自增、再按自增后的值判定**（P1 修复，2026-10-09）。
   *    原实现「先读 → 判 → 再记」中间留了一个 TOCTOU 窗口：并发的一批请求会同时读到
   *    同一个旧值而全部放行，于是这个「成本硬边界」可以被一次性放大 N 倍。
   *    自增是原子的，超限的请求自己也把计数吃掉，上限才真的是硬的。
   *    计数读不到（返回 null，库抖动）时放行 —— 它限的是速，不该把写库抖动放大成
   *    「所有人都不能用」（与 readQuotaCount 按 0 放行同一哲学）。
   *    调试放行（guardOff）时同样只跳过判定，这一步的计数照常自增。
   */
  const abuseLimit = member ? ABUSE_LIMITS.member : ABUSE_LIMITS.free
  const abuseKey = `${openid}#${today}`
  const abuseCount = await bumpAbuseCount(abuseKey, openid)
  if (!guardOff && abuseCount !== null && abuseCount > abuseLimit) {
    return {
      ok: false,
      kind: 'abuse',
      error: `今日调用次数已达上限（${abuseLimit} 次），明日 0 点恢复；如确实需要更多请向我们反馈`
    }
  }
  return null
}

function snippet(v) {
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return String(text || '').slice(0, SNIPPET)
}

/**
 * 原生 https JSON 请求（不引 axios：微信云函数 Node 版本不保证有全局 fetch）。
 *
 * 抽成一个函数是因为「怎么收响应」这条路在 POST 与 GET 上逐字相同：拆成两份，
 * 超时文案 / JSON 容错 / 状态码取值任何一处改了另一边就会落后。列上游模型清单走 GET
 * （见 probeModelList），它和 chat / search 的 POST 必须是同一套读法。
 */
function sendJson(method, target, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(target)
    const body = method === 'GET' ? null : JSON.stringify(payload)
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers:
          body === null
            ? Object.assign({}, headers)
            : Object.assign(
                { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
                headers
              ),
        timeout: timeoutMs
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let data
          try {
            data = JSON.parse(raw)
          } catch (e) {
            data = raw
          }
          resolve({ status: res.statusCode || 0, data })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`上游无响应（${timeoutMs}ms 超时）`)))
    req.on('error', reject)
    /* GET 不带体：连写都不要写，避免出现「带空体」这种两头都不认的混搭请求 */
    if (body !== null) req.write(body)
    req.end()
  })
}

function postJson(target, headers, payload, timeoutMs) {
  return sendJson('POST', target, headers, payload, timeoutMs)
}

/* ═════════════ 头像 / 照片（2026-10-12） ═════════════
 *
 * 为什么要它：全站的名人头像一直是「领域色渐变 + 姓名首字」伪造的 —— 报告页横幅、
 * 人物卡、名人主页都一样。而博查 web-search 的响应里**本来就带图片**
 * （`data.images.value`，字段有 contentUrl / thumbnailUrl / name / width / height 等），
 * 此前 probeOf 只是把条数与字段名数出来、从未用过 —— 所以这里零新增上游端点。
 *
 * 两个关键取舍：
 *   ① **存云存储、不把远端 URL 直接喂给端上**：小程序 <Image> 加载 https 图要求该域名在
 *      「downloadFile 合法域名」里，而素材来自任意媒体、不可能逐一登记；云存储 fileID
 *      （cloud://）走 wx.cloud、不受白名单限制。与 utils/share-card.ts「不下载任何网络图」
 *      的取向一致 —— 代价由云端付一次，端上此后零成本。
 *   ② **每人只取一次**（person_assets 按 personKey 缓存）：一次调用 = 一次博查 + 一次存储写。
 *      客户端在报告**生成成功之后**再调（不压在 60s 生成预算上，见 src/utils/portrait.ts）。
 *
 * 不做身份闸门：与 `action:'search'` 同级（那同样是一个不带闸门的付费上游调用），且本动作
 * 只接收 personKey + 姓名、**不接受客户端给的任何 URL** —— 落库内容完全派生自服务端自己
 * 检索到的图，故不存在「客户端伪造共享缓存」的风险（对比 P0-2 的 report_cache）。
 * 日后若要收紧，在 handlePortrait 开头加一句 openid 判空即可。
 */
const PORTRAIT_MAX_BYTES = 3 * 1024 * 1024
const PORTRAIT_TIMEOUT_MS = 8000
/** 人物图的最小边：小于这个尺寸的基本是图标 / 缩略图，不该当头像 */
const PORTRAIT_MIN_SIDE = 150

const trimStr = (v) => String(v == null ? '' : v).trim()

/** 读缓存的头像行（集合不存在 / 读失败一律当「没有」，让调用方去取图） */
async function readPortraitRow(personKey) {
  try {
    const res = await db.collection('person_assets').where({ _id: personKey }).limit(1).get()
    const row = (res && res.data && res.data[0]) || null
    return row && row.avatar_file_id ? row : null
  } catch (err) {
    return null
  }
}

/**
 * 从博查图片结果里挑一张最像「本人照片」的。
 *
 * 排序先看「标题/宿主页是否含人名」、再看尺寸：图片结果里常见台标、海报、无关配图，
 * 尺寸大并不等于就是本人；含名字的那一张通常是百科或人物页主图。
 *
 * ⚠ 判据刻意宽松：博查返回的 contentUrl 常见 `http://`（不少国内站点仍是 http），
 * 宽高也可能缺字段。这里**只硬拒**「不是 http(s)」与「明确小于最小边」，
 * 其余交给打分排序 —— 宁可给一张不完美的图，也不要因为一条过严的规则导致「永远没有头像」
 * （留空会让端上一直显示首字头像，而排障时看不出是「上游没图」还是「被我们的规则筛掉了」）。
 */
function pickPortrait(list, name) {
  const scored = []
  const rejected = []
  for (const it of Array.isArray(list) ? list.slice(0, 12) : []) {
    const url = trimStr(it && (it.contentUrl || it.thumbnailUrl))
    if (!/^https?:\/\//i.test(url)) {
      rejected.push(`url=${url.slice(0, 40)}`)
      continue
    }
    const w = Number(it && it.width) || 0
    const h = Number(it && it.height) || 0
    if (w && h && Math.max(w, h) < PORTRAIT_MIN_SIDE) {
      rejected.push(`${w}x${h}`)
      continue
    }
    const fmt = trimStr(it && it.encodingFormat).toLowerCase()
    const title = `${trimStr(it && it.name)} ${trimStr(it && it.hostPageUrl)}`
    let score = 0
    if (name && title.includes(name)) score += 100
    if (fmt === 'image/jpeg' || fmt === 'image/jpg' || fmt === 'image/png') score += 10
    score += Math.min(50, Math.round((w * h) / 40000)) /* 尺寸只作次要权重 */
    scored.push({ url, w, h, fmt, score })
  }
  scored.sort((a, b) => b.score - a.score)
  /* 诊断信息随返回值带出：排障时一眼分辨「上游没图」与「被规则筛掉」（见本函数上方注释） */
  return { picked: scored[0] || null, total: Array.isArray(list) ? list.length : 0, rejected: rejected.slice(0, 3) }
}

/** 下载一张图（限时 / 限量 / 限类型）：只给头像用，故不重试 —— 没有头像远好过拖死一次调用 */
function downloadImage(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (e) => {
      if (!settled) {
        settled = true
        reject(e)
      }
    }
    const ok = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        const type = String(res.headers['content-type'] || '')
        if (res.statusCode !== 200) {
          res.resume()
          return fail(new Error(`图片返回 ${res.statusCode}`))
        }
        if (!/^image\//.test(type)) {
          res.resume()
          return fail(new Error(`不是图片类型：${type}`))
        }
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > PORTRAIT_MAX_BYTES) {
            req.destroy()
            return fail(new Error('图片超过体积上限'))
          }
          chunks.push(c)
        })
        res.on('end', () => ok({ buffer: Buffer.concat(chunks), type }))
        res.on('error', fail)
      })
      req.on('timeout', () => {
        req.destroy()
        fail(new Error('图片下载超时'))
      })
      req.on('error', fail)
    } catch (err) {
      fail(err)
    }
  })
}

/**
 * action:'portrait' —— 取一个人的头像/照片，存云存储，写 person_assets（每人一条）。
 * 返回 `{ ok, fileId, cached? }`。**失败不抛错**（回 ok:false），让端上静默回退到「首字头像」——
 * 一张图取不到，不该影响任何主流程。
 */
async function handlePortrait(event) {
  const personKey = trimStr(event.personKey)
  const name = trimStr(event.name)
  if (!personKey || !name) return { ok: false, error: '缺少 personKey / name' }
  if (personKey.length > 120 || name.length > 40) return { ok: false, error: 'personKey / name 过长' }

  const cached = await readPortraitRow(personKey)
  if (cached) return { ok: true, fileId: cached.avatar_file_id, cached: true }

  const key = readEnv('BOCHA_API_KEY')
  if (!key) return { ok: false, error: '未配置 BOCHA_API_KEY' }

  /*
   * 参数刻意与主检索那次**逐字对齐**（query / freshness / summary / count 四件套）：
   * 实测发现少传 `freshness` 时博查**不回 images 块**（2026-10-12，candidates=0），
   * 这一点上游文档没写，只能靠「与已知可用的一次保持同参」来兜。
   *
   * 两次尝试：「名字 + 照片」偏人物图，取不到再退回名字本身（新闻流里也常带人物图）。
   * 两次都没有可用图，才认「这个人就是没有图」——并把每次的候选数带回去，便于排障。
   */
  const attempts = []
  let picked = null
  for (const q of [`${name} 照片`, name]) {
    const params = { query: q, freshness: 'oneMonth', summary: true, count: 5 }
    const res = await postJson(BOCHA_ENDPOINT, { Authorization: `Bearer ${key}` }, params, TIMEOUT_MS)
    if (!res || res.status !== 200) {
      attempts.push({ q, error: `博查返回 ${(res && res.status) || '无响应'}` })
      continue
    }
    /* ⚠ sendJson 返回的是 `{ status, data }`（data = 已解析的响应体），**不是** body —— 
       写成 res.body 会静默拿到 undefined，症状是「博查明明有图、却永远 candidates:0」 */
    const images = ((res.data || {}).data || {}).images || {}
    const pick = pickPortrait(images.value, name)
    attempts.push({ q, candidates: pick.total, rejected: pick.rejected })
    if (pick.picked) {
      picked = pick.picked
      break
    }
  }
  if (!picked) return { ok: false, error: '博查没有返回可用图片', attempts }

  const got = await downloadImage(picked.url, PORTRAIT_TIMEOUT_MS)
  const suffix = picked.fmt === 'image/png' ? 'png' : 'jpg'
  const safeKey = personKey.replace(/[^0-9a-zA-Z]/g, '_').slice(0, 60)
  const up = await cloud.uploadFile({
    cloudPath: `portraits/${safeKey}-${Date.now()}.${suffix}`,
    fileContent: got.buffer
  })
  const fileId = (up && up.fileID) || ''
  if (!fileId) return { ok: false, error: '云存储未返回 fileID' }

  await db.collection('person_assets').doc(personKey).set({
    data: {
      person_key: personKey,
      name,
      avatar_file_id: fileId,
      source_url: picked.url,
      width: picked.w,
      height: picked.h,
      bytes: got.buffer.length,
      updated_at: new Date().toISOString()
    }
  })
  return { ok: true, fileId, source: picked.url, bytes: got.buffer.length }
}

/**
 * GET 封装：2026-10-11 改造后**已无调用方**（原本只给「列上游 /models 清单」用，
 * 而云开发 AI 没有这个端点）。保留它是因为 sendJson 的 GET 分支还在这里，
 * 下次接任一 HTTP GET 检索源时可直接复用，不必重写一遍回调拼装。
 */
function getJson(target, headers, timeoutMs) {
  return sendJson('GET', target, headers, null, timeoutMs)
}

async function probeBocha(key) {
  const res = await postJson(
    BOCHA_ENDPOINT,
    { Authorization: `Bearer ${key}` },
    { query: '雷军 近期 新闻 动态 言论', freshness: 'oneMonth', summary: true, count: 3 },
    TIMEOUT_MS
  )
  const body = res.data
  const code = Number((body && body.code) ?? res.status)
  if (res.status === 200 && code === 200) {
    const pages = (body.data && body.data.webPages && body.data.webPages.value) || []
    return { ok: true, detail: `可用（返回 ${pages.length} 条）` }
  }
  if (res.status === 401) return { ok: false, detail: '401 密钥无效' }
  if (res.status === 403) return { ok: false, detail: '403 未绑资源包或额度不足' }
  return { ok: false, detail: `HTTP ${res.status} / code ${code}：${snippet(body) || '无响应体'}` }
}

/** 探测当前生效档位是否可用：通道 / 厂商 / 模型名都取自 resolveLlm（换档位或换厂商后测的就是换过去的那条路） */
async function probeLlm(llm) {
  try {
    const out = await callLlm({ ...llm, chatMaxTokens: PROBE_MAX_TOKENS }, llm.model, [
      { role: 'system', content: '你是连通性测试助手，只回复两个字：正常' },
      { role: 'user', content: '连通性测试' }
    ])
    if (out.content && out.content.trim()) {
      return {
        ok: true,
        detail: `可用（${llm.channel === 'http' ? llm.vendor : '云开发 AI'}/${llm.model} 返回「${out.content
          .trim()
          .slice(0, 12)}」）`
      }
    }
    return {
      ok: false,
      detail: `无正文（finish_reason=${out.finishReason || '缺失'}，reasoning=${out.reasoningChars}字）`
    }
  } catch (err) {
    /* 配置类错误（缺 key / 厂商名拼错）原话已含「该配哪个变量」，直接透传，别再追加云开发 AI 专属指引 */
    if (err && err.isConfig) return { ok: false, detail: failDetail(err) }
    /* cloudai 通道最常见的失败是「这个名字没在当前环境开通」—— 文案直接给出可照做的下一步 */
    const hint = llm.channel === 'http' ? '请核对厂商 key / 端点与模型名' : '请核对模型名是否已在云开发 AI 中开通'
    return { ok: false, detail: `${failDetail(err)}（${hint}：${llm.model}）` }
  }
}

/**
 * 逐槽模型探针：把**当前厂商注册表里的每个能力槽**（3 质量档 × structured/reasoning）各探一次，
 * 回答「这个槽到底带不带思考、能不能用」。
 *
 * 起因（真实踩到，不是假想）：某个模型顶着「便宜 / 基础档」的标签，实际却先产出上万字
 * reasoning_content，把 max_tokens 全吃光 ⇒ 正文 0 字、finish_reason='length' ⇒
 * 报告结构化生成整份降级（见 handleChat 里空正文分流那段的两种文案）。
 * 而「这个槽带不带思考」标签描述的是**期望**，不描述模型实际行为；这件事也不可能从端上日志
 * 看出来（端上只看到空正文）。模型名会上下架、思考开关各家不一，回填配置前都该先跑一遍。
 *
 * 判据只有一条：`reasoning_content` 非空 ⇒ 这个槽实际在思考。
 * 提示词与 probeLlm 同款（刻意不加料）：这里要测的是「会不会产 reasoning」，不是「思考多长」，
 * 后者由长生成现场决定（端上 chat:upstream 的 reasoningChars 才是那个数）。
 *
 * ⚠ 局限：上游若不暴露 `reasoning_content`（思考藏在别的字段 / 干脆不返回），此处测不出来，
 *   结论是假阴性 —— 那种情况只能靠端上长生成的实际表现判断。
 * ⚠ 每次调用都真花钱（每个槽一次上游请求），故与 test 探针共用口令，且**必须显式传 `models: true`**
 *   或 `probeModels: [...]`：默认那条 test 的请求次数被测试钉死为「博查 + 大模型 + 兜底源」各一次，
 *   不能悄悄加发。
 *
 * 两个入口：
 *   ① 不传 probeModels → 探 event.vendor（缺省默认厂商）注册表里的 3 档 × 2 槽，
 *      回答「现在配的这些槽各自带不带思考」；双模模型同一名字会探两次（思考开 / 关各一次）；
 *   ② 传了 probeModels → 探给定的候选名（云开发 AI 模型名，沿用当前 cloudai 通道），
 *      回答「还有哪些名字能用」（候选名以控制台 AI 页为准）。
 */
async function probeModelTiers(llm, requested, bench) {
  /*
   * 探哪些：`requested` 给了一份候选名就按它探（这些是云开发 AI 的模型名，沿用当前路由的
   * cloudai 通道去敲）；否则逐槽探 llm.vendor 的 3 档 × 2 能力槽 —— 每槽**独立 resolveLlm**：
   * 槽位可能被环境变量覆盖、缺槽会向下降档，用一个 llm 打天下会测不到真实路由。
   */
  const candidateMode = Array.isArray(requested) && requested.length > 0
  const jobs = candidateMode
    ? requested
        .map((n) => (typeof n === 'string' ? n.trim() : ''))
        .filter(Boolean)
        .slice(0, MAX_PROBE_MODELS)
        .map((name) => ({ name, quality: 'other', capability: 'other', conf: llm }))
    : QUALITIES.reduce((acc, q) => {
        ;['structured', 'reasoning'].forEach((cap) => {
          const conf = resolveLlm({
            vendor: llm.vendor,
            quality: q.key,
            purpose: cap === 'reasoning' ? 'ask' : 'generate'
          })
          /* 缺槽被降档时 conf.quality 可能等于更矮的档：仍照实际路由探（结果里看得出来） */
          acc.push({ name: conf.model, quality: conf.quality, capability: cap, conf })
        })
        return acc
      }, [])
  /*
   * bench: true 时换大负载 + 真实上限（BENCH_* 常量）：测「生成 facts 批体量要几秒、会不会撞 45s」，
   * 而不是默认的「连通性两句」（那只测得出带不带思考）。负载与上限是本次探针仅有的两处分支。
   */
  const maxTokens = bench ? BENCH_MAX_TOKENS : PROBE_MAX_TOKENS
  const messages = bench
    ? [
        { role: 'system', content: BENCH_SYSTEM },
        { role: 'user', content: BENCH_USER }
      ]
    : [
        { role: 'system', content: '你是连通性测试助手，只回复两个字：正常' },
        { role: 'user', content: '连通性测试' }
      ]
  const out = []
  for (let i = 0; i < jobs.length; i++) {
    const { name, quality, capability, conf } = jobs[i]
    const startedAt = Date.now()
    try {
      const r = await callLlm({ ...conf, chatMaxTokens: maxTokens }, name, messages)
      const chars = r.content.length
      const reasoningChars = r.reasoningChars
      const finishReason = r.finishReason
      const elapsedMs = Date.now() - startedAt
      /*
       * 结论写成人话：看的人不必自己比对两个字数。
       * 默认判据只有 reasoningChars 一项；bench 模式则直接给「多久出了多少字」—— 那才是换模型的依据。
       */
      const verdict = bench
        ? `${chars} 字 / ${elapsedMs}ms${reasoningChars ? `（含思考 ${reasoningChars} 字）` : ''}：` +
          (elapsedMs >= (CHAT_DEADLINE_MS * 2) / 3 ? '接近时限，慎用' : '余量充足')
        : reasoningChars
          ? `思考模型（思考 ${reasoningChars} 字）：长生成会先吃输出预算，不能用来生成报告 JSON`
          : chars
            ? '无思考：可安全用于长 JSON 生成'
            : `无正文（finish_reason=${finishReason || '缺失'}）`
      out.push({
        model: name,
        quality,
        capability,
        channel: conf.channel,
        vendor: conf.vendor,
        ok: true,
        chars,
        reasoningChars,
        finishReason,
        elapsedMs,
        verdict
      })
    } catch (err) {
      /*
       * 抛错必须带上可照做的信息。三种常见情形分开答：
       *   - 撞时限（isDeadline）：bench 模式下这是「该模型生成 facts 批超时」的直接证据；
       *   - 配置错误（isConfig）：缺 key / 厂商名拼错，原话已含该配什么；
       *   - 其余：最常见是「模型名没开通」，得把名字与开通提示写进结论。
       */
      const hint =
        conf.channel === 'http'
          ? `请核对厂商 ${conf.vendor} 的 key / 端点与模型名「${name}」`
          : `请核对模型名「${name}」是否已在云开发 AI 中开通`
      out.push(
        err && err.isDeadline
          ? {
              model: name,
              quality,
              capability,
              channel: conf.channel,
              vendor: conf.vendor,
              ok: false,
              elapsedMs: Date.now() - startedAt,
              deadlineMs: err.deadlineMs,
              verdict: `生成超时（>${err.deadlineMs}ms）：此模型生成 facts 批体量会撞时限，不可用于报告生成`
            }
          : {
              model: name,
              quality,
              capability,
              channel: conf.channel,
              vendor: conf.vendor,
              ok: false,
              verdict: err && err.isConfig ? failDetail(err) : `${failDetail(err)}（${hint}）`
            }
      )
    }
  }
  return out
}

/**
 * 注册表模型清单：列出 llm.config.js 里每家厂商 × 3 质量档 × 2 能力槽的生效模型名。
 *
 * 云开发 AI **没有** OpenAI 那套 `GET /models` 端点（「当前环境开通了哪些模型」由控制台 AI 页
 * 管理，SDK 不暴露清单接口）；外部厂商则各家鉴权与额度不一，这里也不替它们打上游。
 * 所以清单只反映**我们自己注册表里配了什么**（含环境变量覆盖后的生效值），
 * 它是 probeModelTiers 的对照总表，也是回填模型名时的依据；
 * 真正的「哪个名字能用」仍要逐槽实测（models:true）或去各家控制台看。
 */
async function probeModelList() {
  /* 逐槽 resolve：通道 / 模型名都可能被环境变量覆盖，清单必须反映生效值而不是静态表 */
  const rows = []
  Object.keys(VENDORS).forEach((vendorKey) => {
    QUALITIES.forEach((q) => {
      ;['structured', 'reasoning'].forEach((cap) => {
        const conf = resolveLlm({
          vendor: vendorKey,
          quality: q.key,
          purpose: cap === 'reasoning' ? 'ask' : 'generate'
        })
        rows.push({
          vendor: vendorKey,
          vendorLabel: conf.vendorLabel,
          quality: q.key,
          qualityRequested: q.key,
          qualityDowngraded: conf.qualityDowngraded,
          capability: cap,
          channel: conf.channel,
          model: conf.model,
          memberOnly: q.memberOnly
        })
      })
    })
  })
  return {
    ok: true,
    count: rows.length,
    models: rows.map((r) => r.model),
    detail:
      `注册表共 ${Object.keys(VENDORS).length} 家厂商 × ${QUALITIES.length} 档 × 2 能力槽 = ${rows.length} 条路由` +
      '（云开发 AI 无 /models 端点；可用性请用 models:true 逐槽实测，或在控制台 AI 页查看）',
    slots: rows
  }
}

/**
 * 兜底源探针：**只探装配表里第一个配了 key 的那家**（选取逻辑与 handleSearch 完全一致）。
 *
 * 为什么必须有它：两家兜底源都在**境外**，而云函数在境内（腾讯云）——「能不能连通、
 * 跨境延迟多少」是这套兜底唯一的未知数，而且**在报告里看不出来**：兜底失败会被静默降级成
 * 「主源没内容」（端上只看到 nonews），排查时根本分不清是没配、不通、还是真的没结果。
 * 这个探针把它变成一句可执行的命令。
 *
 * 刻意探**真实的检索请求**（而不是健康检查端点）：两家都没有廉价的 ping 接口，而一次
 * count:3 的检索相对其免费额度可以忽略；好处是「探通了 = 这条路真的能用」。
 * 耗时一并回报：跨境链路的正常值与超时值差两个数量级，一眼分得出是「慢」还是「不通」。
 */
async function probeBackup(provider) {
  const startedAt = Date.now()
  const res = await provider.run(provider.key, {
    query: '雷军 近期 新闻 动态 言论',
    freshness: 'oneMonth',
    count: 3
  })
  const cost = `（耗时 ${Date.now() - startedAt}ms）`
  if (res.ok) return { ok: true, detail: `可用（返回 ${(res.pages || []).length} 条）${cost}` }
  return { ok: false, detail: `${res.error || '失败'}${cost}` }
}

/**
 * 上游超时 / 断流的统一文案。这里的 hint 对应「函数超时够长、上游自己慢」这一支；
 * 若反过来（函数超时短于上游）则根本走不到这里 —— 进程已被平台杀掉，端上看到的是 -504003，
 * 由 src/utils/cloud.ts#cloudTimeoutHint 兜住，故两处文案刻意各自指向自己的修法。
 */
function failDetail(err) {
  const msg = err instanceof Error ? err.message : String(err)
  const hint = /超时|timeout|socket hang up/i.test(msg)
    ? '（请把云函数超时时间调到 60s：控制台 → 云函数 → aiProxy → 配置）'
    : ''
  return `请求失败：${msg}${hint}`
}

/**
 * 探针：把上游响应的**结构**（键名 + 条数，不含任何正文）摘一小份回端上。
 *
 * 起因：博查的响应是 Bing 兼容结构，图片在 `data.images.value`、视频在 `data.videos.value`，
 * 与 `webPages` **同级**；而 runSearch 只把 webPages 交给端上，于是「博查到底返不返回图片/视频、
 * 字段叫什么」这个问题在端上永远看不到答案。要往报告里加图，得先答这个问题。
 * 端上把它记进诊断日志（search.ts），一次真实检索就能看清，不必再猜。
 *
 * 只回键名与计数：正文可能几万字，绝不往这里塞。
 */
function probeOf(body) {
  const d = (body && body.data) || {}
  const isObj = (v) => !!v && typeof v === 'object'
  const firstKeys = (list) => {
    const v = list && Array.isArray(list.value) ? list.value[0] : null
    return isObj(v) ? Object.keys(v).slice(0, 30) : []
  }
  const sizeOf = (list) => (list && Array.isArray(list.value) ? list.value.length : 0)
  return {
    dataKeys: Object.keys(d).slice(0, 20),
    pageKeys: firstKeys(d.webPages),
    images: sizeOf(d.images),
    imageKeys: firstKeys(d.images),
    videos: sizeOf(d.videos),
    videoKeys: firstKeys(d.videos)
  }
}

/**
 * 业务转发：一次博查检索。
 *
 * 刻意只回上游原始 webPages 数组，不在这里做字段映射——
 * 端上 search.ts 的 toNewsItem 是字段兜底的唯一来源，两处各写一份必然漂移。
 * （probe 是例外：它不回内容，只回「上游响应里有哪些键」，见 probeOf。）
 *
 * 返回值带上 kind：端上据此决定「要不要重试」。
 *   rate / auth / quota / unconfigured / badrequest → 重试无意义
 *   upstream / network                              → 可退避重试
 *
 * ⚠ `quota` **只**表示「用户自己的产品额度被闸门拦下」（见 quotaGate）。上游自己的欠费 / 未开通
 * 资源包一律用 `upstream_quota`（P2-9，2026-10-09）：两者处置相同（都不重试），但**不能说同一句话**
 * —— 把平台账户问题说成「你的额度用完了」，用户去查额度页会发现是满的，只能来问客服。
 */
async function runSearch(key, params) {
  const res = await postJson(BOCHA_ENDPOINT, { Authorization: `Bearer ${key}` }, params, TIMEOUT_MS)
  const body = res.data

  if (res.status === 429) return { ok: false, kind: 'rate', error: '搜索源请求过于频繁，请稍后再试' }
  if (res.status === 401) {
    return { ok: false, kind: 'auth', error: '检索密钥无效（请检查云函数环境变量 BOCHA_API_KEY）' }
  }
  /**
   * 403 = 上游（博查）没开通资源包 / 自己欠费 —— 是**平台账户**的问题，不是用户的额度，
   * 故用 `upstream_quota` 而不是 `quota`（P2-9；端上按 kind 分流文案，混用会把用户引去查自己的额度）。
   */
  if (res.status === 403) {
    return { ok: false, kind: 'upstream_quota', error: '检索额度不足或未开通权限（博查资源包）' }
  }
  if (res.status !== 200) {
    return {
      ok: false,
      kind: 'upstream',
      error: `检索服务返回 HTTP ${res.status}：${snippet(body) || '无响应体'}`
    }
  }

  const code = Number((body && body.code) ?? 200)
  if (code !== 200) {
    return { ok: false, kind: 'upstream', error: `检索服务错误码 ${code}：${snippet(body) || '无响应体'}` }
  }

  const pages = (body.data && body.data.webPages && body.data.webPages.value) || []
  /* probe 跟着成功返回一起走，端上只在诊断日志里记一笔（不改任何检索行为） */
  return { ok: true, pages, probe: probeOf(body) }
}

/**
 * Serper.dev 适配器：走 **Google 索引**，是最接近「真的换一个搜索引擎」的一家 ——
 * 也正对本项目要解的问题（博查没收录的中文长尾，Google 往往有）。
 * 注册只需邮箱、无需信用卡（新账号送 2500 次），是目前门槛最低的可行选项。
 *
 * 请求：POST `https://google.serper.dev/search`，key 走 `X-API-KEY` 头；
 *       body 用 `q` / `num` / `gl` / `hl`，时间过滤是 Google 原生的 `tbs=qdr:*`。
 * 响应：`organic[]`，字段为 `{ title, link, snippet, date }` —— **与博查完全不同名**，
 *       故这里翻译成 `{ name, url, snippet, datePublished }`（见文件头那条 ⚠）。
 */
async function runSearchSerper(key, params) {
  const tbs = SERPER_TBS[params.freshness]
  const body = {
    q: params.query,
    num: Math.min(params.count, SERPER_MAX_COUNT),
    gl: 'cn',
    hl: 'zh-cn',
    ...(tbs ? { tbs } : {})
  }
  const res = await postJson(SERPER_ENDPOINT, { 'X-API-KEY': key }, body, TIMEOUT_MS)
  const bad = backupFailure(res, 'SERPER_API_KEY')
  if (bad) return bad

  const list = (res.data && res.data.organic) || []
  return {
    ok: true,
    pages: list.map((it) => ({
      name: it.title || '',
      url: it.link || '',
      snippet: it.snippet || '',
      ...(it.date ? { datePublished: it.date } : {})
    }))
  }
}

/**
 * Tavily 适配器：面向 LLM 的检索 API，返回**已清洗的正文**（`content` 常几百到上千字，
 * 比 snippet 长得多），对「喂给模型」最友好；代价是中文长尾覆盖弱于 Google。
 * 注册同样只需邮箱、无需信用卡（免费 1000 次/月）。
 *
 * 请求：POST `https://api.tavily.com/search`，key 放 body 的 `api_key`。
 * 响应：`results[]`，字段为 `{ title, url, content, published_date }`。
 */
async function runSearchTavily(key, params) {
  const body = {
    api_key: key,
    query: params.query,
    max_results: Math.min(params.count, TAVILY_MAX_COUNT),
    search_depth: 'basic'
  }
  const res = await postJson(TAVILY_ENDPOINT, {}, body, TIMEOUT_MS)
  const bad = backupFailure(res, 'TAVILY_API_KEY')
  if (bad) return bad

  const list = (res.data && res.data.results) || []
  return {
    ok: true,
    pages: list.map((it) => ({
      name: it.title || '',
      url: it.url || '',
      /* content 是清洗过的正文，与博查的 summary 同性质：交给端上的 maxItemChars 裁剪，
         这里不自己截 —— 截了会让「单条素材上限」那个真源参数失去意义 */
      snippet: it.content || '',
      ...(it.published_date ? { datePublished: it.published_date } : {})
    }))
  }
}

/**
 * 备选源的公共故障判定：把「HTTP 层出了什么事」翻成本函数统一的 kind。
 *
 * 抽出来是因为三家的失败分支**完全一样**，而 401/403 的文案里要带上各自的 key 变量名 ——
 * 部署后配错了，用户看到的就是这一句，写清楚比让人猜强。
 * 返回 null 表示「状态码正常，继续解析响应体」。
 */
function backupFailure(res, keyEnv) {
  /*
   * 401/403 = 备选源的 key 没配好 / 未开通：对端上等价于「这条兜底路不存在」，
   * 故与主源的 auth 同档（不重试，也不换一句话去引导用户查自己的额度 —— 那是平台账户问题）。
   */
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      kind: 'auth',
      error: `备选检索密钥无效或未开通（云函数环境变量 ${keyEnv}），HTTP ${res.status}`
    }
  }
  if (res.status === 429) return { ok: false, kind: 'rate', error: '备选搜索源请求过于频繁' }
  if (res.status !== 200) {
    return {
      ok: false,
      kind: 'upstream',
      error: `备选检索返回 HTTP ${res.status}：${snippet(res.data) || '无响应体'}`
    }
  }
  return null
}

/**
 * 备选源装配表：**按顺序取第一个配了 key 的**。
 *
 * 顺序即推荐度，也是「同时配了多个」时的取舍：
 *   serper（Google 索引，中文长尾最好，邮箱可注册）
 *   → tavily（面向 LLM、返回已清洗正文，覆盖次之）
 * 这里只登记 key 的变量名、不读它，是为了把 readEnv 留在 handler 里（便于测试注入）。
 *
 * 两家适配器**刻意都不转发 include（站点限定）**：`site:` 语法要改写整条 query，而这条路是
 * 「主源一条都没捞到」时的兜底 —— 此时把搜索面**放宽**比继续收窄更有意义（而且走到这里的
 * 支线请求本来就是锦上添花）。
 * 两者也都**不带 probe**：probe 是给「往报告里加图 / 视频」做调研用的，那是博查的结构问题。
 */
const BACKUP_PROVIDERS = [
  { name: 'serper', keyEnv: 'SERPER_API_KEY', run: runSearchSerper },
  { name: 'tavily', keyEnv: 'TAVILY_API_KEY', run: runSearchTavily }
]

/**
 * 站点限定参数归一（§1.4 V1.5 多源分域检索）。
 * 端上可能传数组（['weibo.com']）也可能传串，这里统一成博查要的 `site:a.com|site:b.com`；
 * 全都取不出域名时返回 undefined —— 宁可不带该参数，也不要发一个空 include 把结果筛没。
 */
function normalizeInclude(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (Array.isArray(raw)) {
    const list = raw
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .map((x) => (x.includes('site:') ? x.trim() : `site:${x.trim()}`))
    if (list.length > 0) return list.join('|')
  }
  return undefined
}

async function handleSearch(event) {
  const bochaKey = readEnv('BOCHA_API_KEY')
  /*
   * 兜底源是**可选且可换**的：按 BACKUP_PROVIDERS 的顺序取第一个配了 key 的。
   * 一个都没配 = 整条跳过，行为与没有兜底时完全一致（见那张表上方的说明）。
   */
  const backup = BACKUP_PROVIDERS.map((p) => Object.assign({}, p, { key: readEnv(p.keyEnv) })).find(
    (p) => p.key
  )
  if (!bochaKey && !backup) {
    /* 函数部署了但一个源都没配：对端上而言等同「这条通道不存在」，故单列一个 kind */
    return {
      ok: false,
      kind: 'unconfigured',
      error: '平台未配置检索额度（云函数环境变量 BOCHA_API_KEY）'
    }
  }
  const query = typeof event.query === 'string' ? event.query.trim() : ''
  if (!query) return { ok: false, kind: 'badrequest', error: '缺少 query' }

  /*
   * 付费闸门（P1 修复，2026-10-09）：search 同样是一次**真实付费调用**（博查按次计费），
   * 而原实现这条路径上什么闸门都没有 —— 不判额度、不写 ai_calls、连 openid 都不要，
   * 于是 `{action:'search', count:20}` 循环调用就能无上限刷掉资源包。
   *
   * 走 aux 档：检索是生成 / 刷新内部的零件，产品额度在 generate 那一侧已经计过一次，
   * 这里不重复扣额度，只受防滥用限速闸（ABUSE_LIMITS，由云端就地自增，端上无法阻止）。
   * chat 走的是同一道闸门（见 handleChat）。
   */
  const openid = (cloud.getWXContext() || {}).OPENID
  if (!openid) {
    return { ok: false, kind: 'auth', error: '取不到调用者 openid：search 只允许从小程序端调用' }
  }

  /* 会员身份一次读库、两处共用（闸门判档位 + 下方 count 的 cap）：同一次请求不查两遍权威表 */
  let memberKnown = null
  const isMember = async () => {
    if (memberKnown === null) memberKnown = await isActiveMember(openid)
    return memberKnown
  }

  const gate = await quotaGate(openid, AUX_PURPOSE, isMember)
  if (gate) return gate

  const count = Number(event.count)
  const include = normalizeInclude(event.include)
  const want = Number.isFinite(count) && count > 0 ? Math.floor(count) : 10
  /*
   * 只有「要得比免费上限还多」时才用到会员身份：
   * 端上主线 / 支线默认都在 20 以内，故绝大多数请求不会为此多一次读库
   * （上面那道闸门已经读过一次，这里是同一个 memo）。
   */
  const cap = want > FREE_SEARCH_MAX && (await isMember()) ? MEMBER_SEARCH_MAX : FREE_SEARCH_MAX
  const params = {
    query,
    freshness: typeof event.freshness === 'string' ? event.freshness : 'oneMonth',
    summary: true,
    count: Math.min(want, cap),
    /* 不传 include 时不发该字段：保持与原行为完全一致（端上主线检索走这条路径） */
    ...(include ? { include } : {})
  }
  try {
    /*
     * 主源（博查）→ 兜底源（BACKUP_PROVIDERS 里第一个配了 key 的）：
     * **只有主源没捞出内容时才动用第二家**。
     *
     * 触发条件是两种：「主源 ok 但 pages 为空」与「主源整条失败」——
     *   · 空内容就是要解的那个产品问题（付费用户最怕查不到）；
     *   · 主源故障（限流 / 上游抖动）时换个源往往直接就绕过去了，值得一试。
     * 两家都没内容时**交回主源的那份结论**（ok:true + 空数组），语义与从前一致：
     * 端上据此判 `nonews`，而不是被兜底的失败搅成 coldstart。
     */
    const primary = bochaKey
      ? await runSearch(bochaKey, params)
      : { ok: false, kind: 'unconfigured', error: '平台未配置主检索源（BOCHA_API_KEY）' }
    /*
     * 检索侧只报「要了什么、拿到几条」：query 是人名（不敏感），而**条数正是「为什么报没素材」
     * 的答案** —— 端上只看得到空数组 / 一句 nonews，分不清是主源真没收录、还是云端把 count 钳小了。
     */
    rawLog('search:primary', {
      query: params.query,
      freshness: params.freshness,
      want: params.count,
      ok: primary.ok,
      got: (primary.pages || []).length,
      kind: primary.kind || ''
    })
    if (primary.ok && (primary.pages || []).length > 0) return primary
    if (!backup) return primary

    const result = await backup.run(backup.key, params)
    rawLog('search:backup', {
      provider: backup.name,
      ok: result.ok,
      got: (result.pages || []).length,
      kind: result.kind || ''
    })
    if (result.ok && (result.pages || []).length > 0) {
      /*
       * source 只给端上诊断用（不改任何检索行为）：一眼看出这条结果来自哪家兜底源。
       *
       * primary 再补一句「主源这一次为什么让位」。只看 source 时，端上（与部署者）**分不清**
       * 博查是「抓空」（按设计让位，不必管）还是「整条失败」（密钥 / 资源包问题）——
       * 后一种是平台自己在付费源上的账户故障，却被兜底静默盖过，症状与「这个源没收录」一模一样，
       * 而这两件事的处置完全不同（前者放着不管，后者要去博查后台查资源包）。
       */
      return Object.assign({}, result, {
        source: backup.name,
        primary: { ok: primary.ok, got: (primary.pages || []).length, kind: primary.kind || '' }
      })
    }
    return primary.ok ? primary : result
  } catch (err) {
    return { ok: false, kind: 'network', error: failDetail(err) }
  }
}

/**
 * 归一化 messages：只认 system / user，并卡住条数与总长度。
 *
 * 刻意不校验「内容像不像正经提示词」——那既做不到也不该做；
 * 这里只挡住最粗放的滥用（把本函数当免费 API 批量刷）。
 */
function normalizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: '缺少 messages' }
  if (raw.length > MAX_CHAT_MESSAGES) {
    return { error: `messages 过多（上限 ${MAX_CHAT_MESSAGES} 条）` }
  }
  const out = []
  let chars = 0
  for (const m of raw) {
    if (!m || typeof m !== 'object') return { error: 'messages 元素格式错误' }
    const content = typeof m.content === 'string' ? m.content : ''
    if (!content.trim()) return { error: 'messages 内容为空' }
    chars += content.length
    out.push({ role: m.role === 'system' ? 'system' : 'user', content })
  }
  if (chars > MAX_CHAT_CHARS) {
    return { error: `提示词过长（${chars} 字，上限 ${MAX_CHAT_CHARS} 字）` }
  }
  return { messages: out }
}

/**
 * 调云开发 AI（cloud.ai）取一次完整正文 —— 本文件与上游的**唯一**接触点。
 *
 * 为什么用 streamText 而不是更简单的 generateText：
 *   云函数端 generateText 的返回值只有 `{ text, messages, usage, rawResponses, error? }`，
 *   **不含 finish_reason**；而 finish_reason 是「空正文 + 撞上限」这类确定性截断的唯一判据
 *   （见 handleChat 尾部的分流：'length' ⇒ kind='truncated' ⇒ 端上不重试、直接降级）。
 *   文档里 finish_reason 只出现在 streamText 的 dataStream 元素上，所以这里走流式。
 *
 * 两个流各司其职（并发消费，避免任一流未被读而让底层 SSE 卡住）：
 *   · textStream → 正文增量（它的职责就是吐正文）
 *   · dataStream → finish_reason / usage / reasoning_content（正文之外的元信息）
 * ⚠ 实测要点：若真实环境里两流不能并发消费（例如底层只 tee 了一份），
 *   退路是只用 dataStream、从 `choices[0].delta.content` 自行累计正文。
 *
 * 返回 { content, finishReason, reasoningChars, usage }，不在这里判成败 —— 归类交给 handleChat。
 */
async function callCloudAi(llm, model, messages, purpose) {
  const deadline = deadlineOf(purpose)
  const aiModel = cloud.ai().createModel(llm.modelGroup)
  /*
   * 入参形状（与 OpenAI 不同，勿照搬）：
   *   · model / messages 是 SDK 约定字段；max_tokens 不在文档定义里，会**随请求体透传**给模型
   *     —— 所以它照传（理由见 llm.config.js 的 chatMaxTokens 那段）。
   *   · system 提示词走 messages 里的 role:'system'（normalizeMessages 已归好）。
   *   · 第二个参数 `{ timeout }`：cloud.init 的默认超时只有 15s，长报告必须显式放宽。
   *     传的就是本次的 deadline（**不另设一个数**）：SDK 侧与下面这道闸门若能各说各话，
   *     迟早出现「SDK 说 50s、闸门按 45s 掐」这种没人说得清谁在生效的局面。
   */
  const res = await aiModel.streamText(
    {
      model,
      messages,
      max_tokens: llm.chatMaxTokens,
      ...(llm.extraBody || {})
    },
    { timeout: deadline }
  )

  let content = ''
  let finishReason = ''
  let reasoningChars = 0
  let usage = null

  /* 两条流并发消费：任一条没被读，底层 SSE 就可能卡住（见上方 ⚠） */
  const consume = Promise.all([
    (async () => {
      for await (const chunk of res.textStream) {
        if (typeof chunk === 'string') content += chunk
      }
    })(),
    (async () => {
      for await (const ev of res.dataStream) {
        if (!ev) continue
        if (ev.usage) usage = ev.usage
        const choice = ev.choices && ev.choices[0]
        if (!choice) continue
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          finishReason = choice.finish_reason
        }
        const delta = choice.delta
        if (delta && typeof delta.reasoning_content === 'string') {
          reasoningChars += delta.reasoning_content.length
        }
      }
    })()
  ])
  /*
   * 流本身失败时，错误要**原样抛出去**交给 classifyAiError（429 / 5xx / 断流各有各的归类）。
   * 先在这里接住转成值，是为了让「时限先到」时不会留下一个没人管的 unhandledRejection。
   */
  const settled = consume.then(
    () => null,
    (err) => err || new Error('上游流式响应中断')
  )

  /*
   * 墙钟闸门：`Promise.race` 只判「谁先到」，不等落败方 —— 卡死的流不该继续占着这一次调用。
   */
  let timer = null
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), deadline)
  })
  const timedOut = await Promise.race([settled.then(() => false), expired])
  if (timer) clearTimeout(timer)

  if (timedOut) {
    /*
     * 尽力把两条流关上（生成器 return / Readable destroy）：关不掉也不等它 ——
     * 值我们已经要返回了，把连接留着的唯一后果是这个实例的空转。
     */
    for (const s of [res.textStream, res.dataStream]) {
      try {
        if (s && typeof s.return === 'function') s.return()
        else if (s && typeof s.destroy === 'function') s.destroy()
      } catch (e) {
        /* 关不上就随它去：下面照抛时限错误，用户拿到的归类与文案不受影响 */
      }
    }
    throw deadlineError(deadline, purpose || DEFAULT_PURPOSE)
  }

  const failure = await settled
  if (failure) throw failure

  return { content, finishReason, reasoningChars, usage }
}

/**
 * 外部厂商通道（channel='http'）：OpenAI 兼容协议直连 POST {endpoint}/chat/completions。
 *
 * 与 callCloudAi 的契约完全一致 —— 返回 { content, finishReason, reasoningChars, usage }，
 * 于是 handleChat 的空正文 / 截断 / content_filter 分流逐字复用，两条通道只差「怎么把请求送出去」。
 *
 * 配置全部来自 llm.config.js 的 resolveLlm（厂商注册表 VENDORS + LLM_MODEL_* 环境变量），
 * 本函数不内置任何端点 / 模型名；key 在这里现读环境变量（apiKeyEnv 只登记变量名），
 * 缺失时抛 isConfig 错误，由 handleChat 归成不可重试的 kind='config'。
 *
 * 超时复用 postJson 的整体墙钟（发请求 + 收完整响应），取与 cloud.ai 同一道 deadline ——
 * 45s 墙在云函数 60s 天花板之内，通道不同、预算相同，重试算式才不会出现新变量。
 */
async function callVendorHttp(llm, model, messages, purpose) {
  const deadline = deadlineOf(purpose)
  const key = readEnv(llm.apiKeyEnv)
  if (!key) {
    throw Object.assign(
      new Error(
        `大模型厂商 ${llm.vendor} 的 key 未配置：请在云函数环境变量里设置 ${llm.apiKeyEnv}` +
          '（或在小程序「我的」页切回云开发 AI 厂商）'
      ),
      { isConfig: true }
    )
  }
  if (!llm.endpoint) {
    throw Object.assign(new Error(`厂商 ${llm.vendor} 缺少 endpoint（检查 llm.config.js 的 VENDORS 注册表）`), {
      isConfig: true
    })
  }

  const target = `${llm.endpoint.replace(/\/+$/, '')}/chat/completions`
  /*
   * 思考开启时不下发 temperature：DeepSeek v4 / GLM 思考模式下该参数不被支持
   * （DeepSeek 文档明确「思考模式不支持 temperature」，传了不报错但不生效）。
   * 判据覆盖注册表里**三种**思考标记：thinking.enabled（DeepSeek / GLM / Kimi k2.6）、
   * reasoning_effort（Kimi k3）、enable_thinking:true（通义千问）——
   * 加一家厂商只改 llm.config.js 的 extraBody 形状，这里漏认会让思考槽白白带上 temperature。
   */
  const thinkingOn = !!(
    llm.extraBody &&
    ((llm.extraBody.thinking && llm.extraBody.thinking.type === 'enabled') ||
      llm.extraBody.enable_thinking === true ||
      Object.prototype.hasOwnProperty.call(llm.extraBody, 'reasoning_effort'))
  )
  const payload = Object.assign(
    {
      model,
      messages,
      max_tokens: llm.chatMaxTokens,
      stream: false,
      ...(thinkingOn ? {} : { temperature: 0.7 })
    },
    llm.extraBody || {}
  )

  let res
  try {
    res = await postJson(target, { Authorization: `Bearer ${key}` }, payload, deadline)
  } catch (err) {
    /* sendJson 的整体超时（req.destroy）：与 cloud.ai 的墙钟闸门同义，标 isDeadline 走 network 可重试 */
    if (err && /超时/.test(String(err.message || ''))) {
      throw Object.assign(err, { isDeadline: true, deadlineMs: deadline })
    }
    throw err
  }

  if (res.status !== 200) {
    /*
     * 抛带 status 的错，原样复用 classifyAiError：429→rate、401/402/403→upstream_quota、
     * 400→badrequest、5xx→upstream。上游错误原话带上（DeepSeek 等返回 {error:{message}}）。
     */
    const body = res.data || {}
    const detail =
      (body.error && (body.error.message || body.error.code || JSON.stringify(body.error))) ||
      (typeof body === 'string' ? body : '') ||
      `HTTP ${res.status}`
    throw Object.assign(new Error(`${res.status} ${detail}`), { status: res.status })
  }

  const body = res.data || {}
  const choice = (body.choices && body.choices[0]) || {}
  const msg = choice.message || {}
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : '',
    /* DeepSeek v4 思考 / GLM / Kimi 等把思考放在 message.reasoning_content，与 cloud.ai 同字段 */
    reasoningChars: (msg.reasoning_content || '').length,
    usage: body.usage || null
  }
}

/**
 * 大模型统一调用口：按 resolveLlm 裁决出的 channel 选传输实现。
 * 全项目（业务调用 / 探针）都只该调它 —— 新增第三种通道时只改这里一处。
 */
async function callLlm(llm, model, messages, purpose) {
  if (llm.channel === 'http') return callVendorHttp(llm, model, messages, purpose)
  return callCloudAi(llm, model, messages, purpose)
}

/**
 * 把 cloud.ai 抛出的错误归类成端上认识的 kind（llm.ts 的 RETRYABLE_KINDS 决定要不要重试）。
 *
 * 旧版直连时上游的 HTTP 状态码是明确的（429/401/402/403 各有各的语义）；走 SDK 后这些状态码
 * 被包进异常里，能读就读，读不到就落 'network'（可重试）——超时与断流是这条通道最常见的故障。
 */
function classifyAiError(err) {
  const status =
    (err && (err.status || err.statusCode || (err.response && err.response.status))) || 0
  if (status === 429) return 'rate'
  /* 401/403/402 都指向「平台侧配置或额度」问题，重试无用 —— 与旧版同口径归 upstream_quota */
  if (status === 401 || status === 403 || status === 402) return 'upstream_quota'
  /*
   * 400 = 请求本身不合法（「参数过大」就落在这里）：重发同一请求必然再被拒，
   * 与「上游抖了（5xx）」是两回事，故归不可重试的 badrequest —— 之前落默认 network，
   * 端上会把「参数过大」当网络抖动白重试一轮长生成（报告一次 30~40s）。
   */
  if (status === 400) return 'badrequest'
  /* 5xx = 上游自己抖了：与旧版同口径归可重试的 upstream（别把它说成账户问题，也别归成 network 之外的新词） */
  if (status >= 500 && status < 600) return 'upstream'
  /*
   * 云开发 AI 走 SDK，抛错时可能没有 HTTP status，只给一句中文 message（如「请求大模型参数过大」）。
   * 这类同样是「请求本身超限、重试无用」：靠关键词兜住，别让它掉回可重试的 network。
   */
  const msg = String((err && (err.message || err.errMsg)) || '')
  if (/参数过大|请求.*(过大|超长)|too large|too many tokens|context length|maximum context|超长|超出.*(上限|限制)/i.test(msg)) {
    return 'badrequest'
  }
  return 'network'
}

/**
 * 业务转发：一次大模型对话（非流式）。
 *
 * 只回正文文本，不代端上做 JSON 提取与 zod 校验——那是 llm.ts 的职责，
 * 两处各写一份必然漂移（与 runSearch 不代端上映射字段同理）。
 *
 * kind 语义与 runSearch 对齐，端上据此决定「要不要重试」：
 *   rate / auth / quota / unconfigured / badrequest → 重试无意义
 *   upstream / network                              → 可退避重试
 */
async function handleChat(event) {
  /*
   * 先要求登录身份（A3，2026-10-09）：chat 是「平台付钱、客户端随便调」的通道，
   * 配额要按人计、会员要按人判 —— 取不到 openid 时两者都无从谈起，闸门形同虚设，
   * 只剩「谁都能白调一次最贵的模型」。故直接拒绝。
   * 云函数之间不会调本函数（hotBoardRefresh / riskWatch 等自带环境变量 key 直连上游），
   * 所以这道要求不会打断任何定时任务。
   */
  const openid = (cloud.getWXContext() || {}).OPENID
  if (!openid) {
    return { ok: false, kind: 'auth', error: '取不到调用者 openid：chat 只允许从小程序端调用' }
  }

  /*
   * 厂商 / 质量档 / 能力槽 / 模型，全部由 llm.config.js 裁决（换模型 / 换厂商不改这里）。
   * event.vendor + event.quality 是用户在「我的」页选的（旧版端上可能仍带 tier，解析器兼容），
   * event.purpose 决定能力槽（报告/辅助 → structured，问答 → reasoning）。
   */
  const llm = resolveLlm(event)
  /*
   * 配置错误（厂商名拼错 / 基础档也缺该能力槽）在花任何上游钱之前直接拦下：不可重试，
   * 重发也是同一份错误配置。
   */
  if (llm.configError) {
    return { ok: false, kind: 'config', error: llm.configError }
  }
  /*
   * 通道就位检查，按 channel 分两种：
   *   cloudai —— 检 wx-server-sdk 的 cloud.ai 能力（需 ≥ 4.0.1），缺失归 unconfigured；
   *   http    —— 检厂商 key 环境变量（值不进代码），缺失归 config（不重试）。
   */
  if (llm.channel === 'http') {
    if (!readEnv(llm.apiKeyEnv)) {
      return {
        ok: false,
        kind: 'config',
        error:
          `大模型厂商 ${llm.vendor} 的 key 未配置：请在云函数环境变量里设置 ${llm.apiKeyEnv}` +
          '（或在小程序「我的」页切回云开发 AI 厂商）'
      }
    }
  } else if (typeof cloud.ai !== 'function') {
    return {
      ok: false,
      kind: 'unconfigured',
      error: '云函数环境不支持云开发 AI：请把 wx-server-sdk 升到 ≥ 4.0.1 并重新部署本云函数'
    }
  }

  const norm = normalizeMessages(event.messages)
  if (norm.error) return { ok: false, kind: 'badrequest', error: norm.error }

  /* 模型 / 厂商 / 通道已在 resolveLlm 里按「环境变量 > 注册表默认」定好 */
  const requested = llm.model

  /*
   * 用途只在**一个地方**归一化（resolveLlm 已把未知 purpose 归成 generate）：
   * 会员降级、额度池判定、报文日志、本次调用的时限档四处共用，不各写一遍，免得漂移。
   */
  const purpose = llm.purpose || DEFAULT_PURPOSE

  /* 会员身份一次读库、两处共用（模型闸门 + 配额闸门）：同一次请求不查两遍权威表 */
  let memberKnown = null
  const isMember = async () => {
    if (memberKnown === null) memberKnown = await isActiveMember(openid)
    return memberKnown
  }

  /*
   * 会员闸门：端上传的质量档只是「请求」，这里才是裁决点。
   * 非会员请求标准 / 高级档（含缺槽向下降档后仍落在会员档的情形）→ **同厂商静默降回基础档**，
   * 并把 downgraded 回传：生成照常出结果（不因一次残留偏好 / 改包就给用户一句报错），
   * 但高档模型不会被白用。端上按 downgraded 在诊断日志里记一笔。
   *
   * 降级只换质量档、**不换厂商**（用户明确选了哪家就是哪家），也不换能力槽：
   * 问答降回基础档 reasoning 槽（仍是推理模型），报告降回基础档 structured 槽（仍是非思考输出模型）。
   * 降级必须重新 resolveLlm 拿**整份路由**（extraBody 的思考开关随槽位走），不能只改模型名。
   */
  let target = llm
  let model = requested
  let downgraded = false
  if (llm.memberOnly && !(await isMember())) {
    target = resolveLlm({ vendor: llm.vendor, quality: 'basic', purpose })
    if (target.configError) return { ok: false, kind: 'config', error: target.configError }
    model = target.model
    downgraded = true
  }

  /*
   * 配额闸门（B8）：放在这里 —— 上面全是不花钱的前置校验，下面才开始真正付费。
   * 端上发起生成前也判一次（utils/quota.ts / qa.ts），那道门管的是界面与提前拦截；
   * 这道门管的是「改包者把端上那份上限改大」—— 上限、计数、会员身份三者全在云端。
   */
  /*
   * 用途只在**一个地方**归一化（已在会员闸门前提早声明，那里降级路由也要它）：
   * 额度池判定、报文日志、本次调用的时限档三处共用，不各写一遍，免得漂移成三种口径。
   */
  const gate = await quotaGate(openid, purpose, isMember)
  if (gate) return gate

  /*
   * 输出上限对所有请求下发（理由见 llm.config.js 的 chatMaxTokens 那段）：不给它，上游就用默认
   * 上限，而报告 JSON 比默认上限长。这里不查会员身份 —— 一次读库留给上面那道「模型档位」闸门就够了。
   * 实际报文在 callCloudAi 里组装（云开发 AI 的入参形状与 OpenAI 不同，见其定义）。
   */

  /*
   * 云端报文打印（AI_PROXY_RAW_LOG=on 时，见 rawLog 的说明）。
   * 请求侧**刻意不打 messages 正文**：那是几万字的提示词，端上的 debugRaw 已能看到完整对象，
   * 这里只报「这次让谁打、走哪个额度池、多大」，足够回答「为什么是这一档模型 / 为什么被拦」。
   */
  rawLog('chat:req', {
    /* 请求的厂商 / 质量档 / 能力槽：排障先看这三行（选错厂 / 免费用户带了 premium 一眼可见） */
    vendor: target.vendor,
    quality: target.quality,
    qualityRequested: llm.qualityRequested,
    capability: target.capability,
    /* 走哪条通道：云开发 AI 超时还是厂商 401，入口完全不同 */
    channel: target.channel,
    /*
     * `requested` 与 `model` **两个都要打**：两者不同就是被会员闸门降了质量档。
     * 本机与真机都可能踩到 —— 端上按 `users.membership` 镜像行放行高档，
     * 而云端读的是 memberships 权威表（端上那一行改包者能改，故这里不认）⇒ 判为非会员
     * ⇒ 这里路由降回同厂商基础档。若只打最终 model，现象就是
     * 「我选了高级版，怎么发出去的是基础档模型」，且没有任何线索指向降级。
     * qualityDowngraded 是另一回事：所选档缺该能力槽、同厂商向下降档（如 Kimi 高档写报告）。
     */
    requested,
    model,
    downgraded,
    qualityDowngraded: target.qualityDowngraded,
    purpose,
    messages: norm.messages.length,
    chars: norm.messages.reduce((n, m) => n + String(m.content || '').length, 0),
    maxTokens: target.chatMaxTokens,
    /*
     * 本次给了多少秒（aux 与报告档不同，见 deadlineOf）。这一行是「-504003 到底卡在哪一次调用」
     * 的唯一线索：平台掐死函数时**不会有任何返回**，但这条 chat:req 在掐死之前早就打出来了 ——
     * 控制台里紧挨着报错的那一行，就是凶手。
     */
    deadlineMs: deadlineOf(purpose)
  })

  let out
  try {
    out = await callLlm(target, model, norm.messages, purpose)
  } catch (err) {
    /* 上游根本没回（超时 / 断流）或 SDK 侧报错：这条最要紧 —— 端上只会看到一句「平台通道未就绪」 */
    rawLog('chat:err', String(err && err.message ? err.message : err))
    /*
     * 服务端配置错误（厂商 key 缺失 / 端点缺失等，见 callVendorHttp 的 isConfig）：
     * 与上游欠费不同 —— 重试无意义，直接把「该配哪个环境变量」交回上层。
     */
    if (err && err.isConfig) return { ok: false, kind: 'config', error: err.message }
    const kind = classifyAiError(err)
    /*
     * 我们自己掐的那一道（见 deadlineError）：文案已经写全了「为什么掐、接下来怎么办」，
     * **不能再走 failDetail** —— 它见到「超时」二字就让用户去控制台把超时时间调大，
     * 而这里的现场恰恰是「控制台已经顶到 60 秒上限了」，照着做只会白折腾。
     * 归类仍是 network（可重试）：慢是偶发故障的常见形态，而这条通道的重试是**新开一次调用**
     * （每次调用各有一份 60 秒预算），与「重试必定再撞同一道墙」是两回事。
     */
    if (err && err.isDeadline) return { ok: false, kind: 'network', error: err.message }
    /*
     * upstream_quota 是**平台账户**的问题（云开发 AI 的额度 / 授权），不是用户额度。
     * 文案必须说清是谁的问题：说成「你的额度用完了」会把用户引去查自己那份满着的额度页
     * （P2-9）。故这里补一句指向前缀，上游原话（状态码 + message）仍照原样附在后面。
     */
    const error =
      kind === 'upstream_quota'
        ? `上游账户或额度问题（平台侧，与用户额度无关）：${failDetail(err)}`
        : failDetail(err)
    return { ok: false, kind, error }
  }

  /*
   * 上游返回的**结构摘要**：finish_reason + 正文字符数 + 思考字数。
   * 同样不打正文：日志有大小上限，而「报告为什么短了一截」看 finish_reason 与长度就够
   * —— `finish_reason: 'length'` 且长度贴着 max_tokens，就是撞上限被砍。
   * 云开发 AI 由 SDK 直接给结果（非 2xx 已在上面的 catch 里归类），这里不再有 HTTP 状态码可报。
   */
  rawLog('chat:upstream', {
    finishReason: out.finishReason,
    chars: out.content.length,
    /*
     * 推理型模型的思考字数。**正文 0 字而这一项上千字**，就是「max_tokens 被思考吃光、
     * 正文一个字都没轮到」的铁证（见下方空正文分流那段）—— 只看 chars 会误判成上游抖动。
     */
    reasoningChars: out.reasoningChars,
    usage: out.usage || null
  })

  /*
   * finishReason 原样回传端上：'length' = 输出撞上 max_tokens、被上游截断了 —— 报告这类长生成的
   * 失败基本都出在这里，端上据此在诊断日志里留一笔，下次不必靠猜。
   */
  const finishReason = out.finishReason || ''

  if (typeof out.content !== 'string' || !out.content.trim()) {
    /*
     * 空正文（2026-10-10）：**不能一律当成上游抖动**。
     *
     * 推理型模型会先把整份 max_tokens 预算花在 reasoning_content 上；预算在「思考」阶段就被吃光时，
     * 正文一个字都没轮到 —— 上游**仍算成功返回**，content 是空串、finish_reason='length'。
     * 旧代码在这里一律返回 kind='upstream'，而端上 RETRYABLE_KINDS 含 'upstream'
     * ⇒ 原样重发同一请求（报告一次 30~40s，真金白银），**必然再次撞上同一道上限**。
     * 故按 finishReason 分流：'length' 是确定性截断，回端上已经认识的那个 kind
     * （llm.ts#truncatedFail 用的就是 'truncated'，不在 RETRYABLE_KINDS 里 ⇒ 不重试，
     * 直接走降级与报错）；其余情况才是「上游偶发给了个空壳」，维持可重试。
     */
    const reasoningChars = out.reasoningChars
    if (finishReason === 'length') {
      /*
       * 两种成因各给各的改法，别把「不带思考的模型撞上限」也说成「改用非推理档」——
       * 诊断与建议对不上，等于教人去改一个与故障无关的设置。
       */
      const error = reasoningChars
        ? `上游是带推理的模型（${target.vendor}/${model}）：思考了 ${reasoningChars} 字，把 max_tokens=${target.chatMaxTokens} 全吃光，` +
          `正文一个字都没产出。重发同一请求必然再撞同一道墙：请检查 llm.config.js 里该厂商 structured 槽是否误配了思考模型，或调大 chatMaxTokens`
        : `输出撞上 max_tokens=${target.chatMaxTokens} 被截断，正文为空。` +
          `重发同一请求必然再撞同一道墙：请调大 llm.config.js 的 chatMaxTokens，或缩短提示词`
      return { ok: false, kind: 'truncated', finishReason, error }
    }
    if (finishReason === 'content_filter') {
      /*
       * 内容安全拦截（2026-10-11 真机踩到）：模型思考了 4691 字，最终正文被内容安全策略过滤成空。
       * 它和 'length' 一样是**确定性**的 —— 重发同一请求大概率再次被拦，故不放进 RETRYABLE_KINDS；
       * 但成因与改法都和 'length' 不同：不是超时、不是额度、也不是撞输出上限，而是**内容本身**越线。
       * 调配置、换档位都无效，只能往内容侧找（对象的名称/素材，或诱导风险/争议判断的措辞）。
       */
      return {
        ok: false,
        kind: 'content_filter',
        finishReason,
        error:
          `上游模型内容安全拦截（${target.vendor}，finish_reason=content_filter，思考 ${reasoningChars} 字后被拦）：` +
          '生成的内容触发了内容安全策略，正文被过滤为空。这不是超时 / 额度 / 模型配置问题，' +
          '重发同一请求大概率再次被拦（故不重试）。请核对本次对象的名称与素材是否含敏感表述，' +
          '或去掉诱导风险 / 争议判断的措辞后再试。'
      }
    }
    /*
     * 没有 finish_reason 可依（上游没给 / 给了别的值）：保持可重试，但**必须把这个字段报出来**，
     * 否则现场等于没有线索。
     */
    return {
      ok: false,
      kind: 'upstream',
      finishReason: finishReason || 'missing',
      error: `上游模型返回空正文（${target.vendor}，finish_reason=${finishReason || '缺失'}，reasoning=${reasoningChars}字）`
    }
  }
  /*
   * 实际路由回执：vendor/quality/capability 让端上诊断日志能记「请求的 vs 实际落的」，
   * qualityDowngraded 标出缺槽降档（用户选了高级版报告、厂商高档只有推理模型时为 true）。
   */
  return {
    ok: true,
    content: out.content,
    model,
    vendor: target.vendor,
    quality: target.quality,
    capability: target.capability,
    downgraded,
    qualityDowngraded: target.qualityDowngraded,
    finishReason
  }
}

/*
 * 共享缓存写口（P0-2，2026-10-09）：实现在 report-store.js，依赖全部复用本文件里已有的
 * 那一份（会员权威判定 / 防滥用计数 / 错误摘要 / db / cloud），不另起一套口径。
 * 实例化放在这里：上面的函数声明都已就位。
 */
const createReportStore = require('./report-store')
const handleReportStore = createReportStore({
  db,
  cloud,
  isActiveMember,
  bumpAbuseCount,
  /* 与 quotaGate 共用同一枚调试开关（AI_PROXY_QUOTA_GUARD），理由见 report-store.js#storeGate */
  quotaGuardDisabled,
  todayKey,
  failDetail
})

/**
 * 厂商就绪清单（免口令、免登录只读）：供「我的」页厂商选择器只展示**已就绪**的厂商。
 *
 * 为什么免口令也要放行：选择器必须在用户打开页面时就能拉到，而它不泄露任何敏感信息 —
 * 只回注册表的公开元数据（key / label / 通道 / 三档槽位有无）和一个布尔 ready
 * （http 厂 = 对应 *_API_KEY 是否在环境变量里；cloudbase 恒真）。不触达上游、不回 key 内容、
 * 也不花任何钱，故放在 test 口令分支之前（与 search/chat 同层，但没有任何外部调用）。
 */
function handleVendors() {
  return { ok: true, vendors: vendorCatalog() }
}

exports.main = async (event) => {
  /*
   * 默认值刻意**不是** 'test'（A3，2026-10-09）：'test' 会向博查与大模型各发一次真实付费探测，
   * 而 action 是客户端可构造的字段 —— 把缺省值与付费探针绑在一起，等于给任何调用者
   * 留一个「一次调用烧两笔上游钱」的开关。缺省 / 未知一律落在下面的错误分支里，不触达上游。
   */
  const action = (event && event.action) || ''
  if (action === 'search') return handleSearch(event || {})
  /*
   * chat / generate / aux 三个业务动作都进 handleChat：报告生成叫 'generate'、AI 问答叫 'chat'、
   * 辅助小请求叫 'aux'，路由层见名即知；实际额度池与时限仍按 event.purpose 分档（见 handleChat）。
   */
  if (action === 'chat' || action === 'generate' || action === 'aux') return handleChat(event || {})
  /* 厂商就绪清单：免口令只读（见 handleVendors 的说明），放在 test 口令分支之前 */
  if (action === 'vendors') return handleVendors()
  /* 共享缓存写口（P0-2）：不需要口令，但要求登录身份，且 op 会过写口自己的限速 */
  if (action === 'report') return handleReportStore(event || {})
  /* 头像 / 照片（2026-10-12）：从博查图片结果里挑一张存进云存储，写 person_assets 缓存 */
  if (action === 'portrait') return handlePortrait(event || {})
  if (action !== 'test') {
    return {
      ok: false,
      error: `未知 action：${action}（支持 test / vendors / search / chat / generate / aux / report / portrait）`
    }
  }

  /*
   * 运维探针要口令：它不是业务动作，而是「把两家上游 key 的有效性与余额探一遍」，
   * 每次调用都真花钱。口令取环境变量 AI_PROXY_TEST_TOKEN，**未配置时一律拒绝**
   * （fail-closed：宁可让开发者多配一个变量，也不留一个匿名可调的付费探针）。
   * 与 dbInit 的 DB_ADMIN_TOKEN 同一模式。
   */
  const testToken = readEnv('AI_PROXY_TEST_TOKEN')
  if (!testToken || (event && event.token) !== testToken) {
    return {
      ok: false,
      error:
        '探测动作需要口令：请在云函数环境变量里配置 AI_PROXY_TEST_TOKEN，并在 event.token 里带上同一个值'
    }
  }

  const bochaKey = readEnv('BOCHA_API_KEY')
  /* 探测也走同一份注册表：换厂商 / 换质量档后，「测试」测的就是换过去的那条路（event 可带 vendor/quality） */
  const llmConf = resolveLlm(event)
  /*
   * 通道就位检查与 handleChat 同源：http 通道检厂商 key 环境变量，cloudai 通道检 SDK 能力。
   */
  const cloudAiReady = typeof cloud.ai === 'function'
  const llmReady = llmConf.configError
    ? false
    : llmConf.channel === 'http'
      ? !!readEnv(llmConf.apiKeyEnv)
      : cloudAiReady

  const bocha = Object.assign(keyInfo(bochaKey), { ok: false, detail: '' })
  /*
   * 大模型这条没有 key 可报（2026-10-11 改造后不再持有任何厂商 key），但仍保留
   * configured / length 两个字段：它与 bocha / backup 三条并列渲染，形状一致端上才不用分支。
   * configured 在这里的含义变成「通道是否就位」（SDK 装了没）。
   */
  const llm = Object.assign({ configured: llmReady, length: 0 }, { ok: false, detail: '' })

  if (!bochaKey) bocha.detail = '未配置环境变量 BOCHA_API_KEY'
  else {
    try {
      Object.assign(bocha, await probeBocha(bochaKey))
    } catch (err) {
      bocha.detail = failDetail(err)
    }
  }

  if (!llmReady) {
    llm.detail = llmConf.configError
      ? llmConf.configError
      : llmConf.channel === 'http'
        ? `通道未就位：请配置环境变量 ${llmConf.apiKeyEnv}（厂商 ${llmConf.vendor}）`
        : '云函数环境不支持云开发 AI（需 wx-server-sdk ≥ 4.0.1 并重新部署）'
  } else {
    try {
      Object.assign(llm, await probeLlm(llmConf))
    } catch (err) {
      llm.detail = failDetail(err)
    }
  }

  /*
   * 兜底源（**可选**）：走与 handleSearch 相同的选取逻辑（表里第一个配了 key 的）。
   * 刻意**不参与上面的 ok 判定** —— 它本就是可选增强项，没配或探不通都不该让整个探针变红，
   * 否则「平台是好的，只是没开兜底」会被误读成故障。
   * 但配了就必须报：这是判断「境外源到底通不通」的唯一入口（见 probeBackup 的说明）。
   */
  const backupConf = BACKUP_PROVIDERS.map((p) => Object.assign({}, p, { key: readEnv(p.keyEnv) })).find(
    (p) => p.key
  )
  const backup = backupConf
    ? Object.assign(keyInfo(backupConf.key), { provider: backupConf.name, ok: false, detail: '' })
    : {
        configured: false,
        length: 0,
        ok: false,
        detail: '未配置（可选；第二检索源见 .env.example）'
      }
  if (backupConf) {
    try {
      Object.assign(backup, await probeBackup(backupConf))
    } catch (err) {
      backup.detail = failDetail(err)
    }
  }

  /*
   * 逐槽实测（**显式 `models: true` 或 `probeModels: [...]` 才发**，见 probeModelTiers）：
   * 回答「当前厂商哪个槽带思考」/「这些候选名各自能不能用」。
   * 与上面的 llm 探针分工不同：那边测「当前生效的那一条路由通不通」，这边把每个槽都测一遍是否产 reasoning。
   * 同样**不参与 ok 判定** —— 它是诊断信息（「哪个槽能用来生成报告」），不是「平台好不好」的结论。
   * 候选清单（probeModels）与厂商矩阵是同一个入口的两条路：前者用来找**新**名字，后者用来验**现有**配置。
   */
  const candidates = event && Array.isArray(event.probeModels) ? event.probeModels : null
  /* bench: true 叠加在 models/probeModels 之上：把探针负载从「连通性」换成「facts 批体量的长 JSON」（见 BENCH_*） */
  const bench = !!(event && event.bench === true)
  let models = null
  if (event && (event.models === true || (candidates && candidates.length))) {
    /*
     * 候选名（probeModels）是云开发 AI 的模型名，必须有 cloud.ai 才能探；
     * 逐槽实测则看当前生效通道是否就位（cloudai 检 SDK、http 检 key），
     * 其余槽位即便通道没就位，也在 probeModelTiers 内部逐项报错而不是整批跳过。
     */
    const probeReady = candidates && candidates.length ? cloudAiReady : llmReady
    if (!probeReady) {
      models = [
        {
          ok: false,
          verdict:
            llmConf.channel === 'http'
              ? `通道未就位：请配置环境变量 ${llmConf.apiKeyEnv}（厂商 ${llmConf.vendor}）`
              : '云函数环境不支持云开发 AI（需 wx-server-sdk ≥ 4.0.1）'
        }
      ]
    } else {
      try {
        models = await probeModelTiers(llmConf, candidates, bench)
      } catch (err) {
        models = [{ ok: false, verdict: failDetail(err) }]
      }
    }
  }

  /*
   * 模型清单（**显式 `listModels: true` 才发**）：云开发 AI 没有 `GET /models`，这里列
   * **注册表里全部厂商 × 档 × 槽的生效模型名** —— 它是逐槽实测的对照总表，也是回填模型名时的依据（见 probeModelList）。
   * 同样不参与 ok 判定（诊断信息，不是平台结论）。
   */
  let modelList = null
  if (event && event.listModels === true) {
    try {
      modelList = await probeModelList()
    } catch (err) {
      modelList = { ok: false, count: 0, models: [], detail: failDetail(err) }
    }
  }

  return {
    ok: bocha.ok && llm.ok,
    checked_at: new Date().toISOString(),
    /*
     * 三个模型维度的探针各自独立，别混着看：
     *   model     = 当前生效路由（端上带的 vendor/quality/purpose 裁决出的槽），回答「这条路通不通」；
     *   models    = 逐槽实测：当前厂商的 3 档 × 2 槽，或 probeModels 给的候选名，回答「谁带思考」（没要求时为 null）；
     *   modelList = 注册表全部厂商的槽位模型清单，回答「当前配了哪些名字」（没要求时为 null）。
     */
    model: llmConf.model,
    /* 当前生效路由的厂商 / 质量档 / 能力槽 / 通道：回答「这次请求到底发给谁、用哪个槽」 */
    channel: llmConf.channel,
    vendor: llmConf.vendor,
    vendorLabel: llmConf.vendorLabel,
    quality: llmConf.quality,
    qualityRequested: llmConf.qualityRequested,
    qualityDowngraded: llmConf.qualityDowngraded,
    capability: llmConf.capability,
    models,
    modelList,
    bocha,
    llm,
    backup
  }
}
