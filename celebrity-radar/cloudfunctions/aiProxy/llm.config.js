/**
 * 大模型供应商注册表（2026-10-08；同日改为「供应商由用户自选」）。
 *
 * 在此之前「用哪家大模型」是散在业务代码里的字面量：baseURL 与 key 的环境变量名硬编码在
 * index.js 顶部，换一家（或想两家的 key 都留着做对比）就得改业务代码、重读一遍调用链。
 * 现在只有这张表说了算，index.js 只做查表 + 传参。
 *
 * ── 用户自选（aiProxy 的主路径）──────────────────────────────────
 * 端上「我的 → 模型供应商」能切的家 = src/config/public.ts 的 llm.providers，
 * 每个 chat 请求都把 provider + model 带上来，本文件**以端上为准**（见 resolveLlm 的优先级）。
 * 于是「用户能看到几家」完全取决于端上那张表列了几家，本文件要做的就是让列出来的每一家都能用：
 *   ① 该家的 key 配进云函数环境变量（变量名 = 下表 apiKeyEnv），否则用户一切过去就是「未配置额度」；
 *   ② cloudbaserc.json 里把该变量名加进 aiProxy 的 envVariables（漏一个就少一家可用）；
 *   ③ 会员档位两处口径必须一致（下表 memberOnlyModels ↔ 端上各家的 memberOnly），见下。
 *
 * ── 只改云端的默认（LLM_PROVIDER）───────────────────────────────
 *   LLM_PROVIDER 现在只在**端上没带 provider、或带了个下表没有的 id** 时生效：
 *   定时任务 hotBoardRefresh 走的就是这条（它没有端上偏好）；aiProxy 里它是兜底。
 *
 * ── 加一家表里没有的：三个环境变量就够 ──────────────────────────
 *   LLM_BASE_URL + LLM_MODEL + LLM_API_KEY 会**直接覆盖**下表结果，适合自建网关 / 中转站 /
 *   临时试新模型 —— 连本文件都不用改。只有「长期留在仓库、给 fork 者直接用」的供应商才值得进表。
 *   ⚠ 它与「用户自选」冲突：LLM_MODEL 是全局覆盖，会把所有用户锁到同一个模型上（端上仍显示
 *   用户自己选的那一档），此时不要再对外宣称可选档位 —— 那是排障 / 中转的开关，不是常态配置。
 *
 * ⚠ 本文件在 aiProxy 与 hotBoardRefresh 各有一份**副本**：微信云函数各自独立打包上传，
 * 跨目录 require 在本地能跑、部署后必然失效（表现为定时任务报「找不到模块」）。
 * 两份必须逐字一致 —— 与 hotBoardRefresh 的 DOMAINS 和端上 domains.ts 是同一种「手工同步副本」。
 * 与端上 src/config/public.ts 的 llm.providers 同样是手工同步：两边都是**同一套三档**
 * （极速版 / 标准版 / 深度推理），改一家的档位要两张表一起改。
 */

/**
 * 供应商表。键即配置里写的 id（LLM_PROVIDER=qwen，或端上 llm.providers 里那家的 id）。
 *
 * apiKeyEnv：该家的 key 放在哪个环境变量里。**不要**把 key 写进本文件 ——
 *   本文件随代码进 git，key 只活在云函数环境变量（控制台或 .env，两者都不进仓库）。
 * memberOnlyModels：会员专属档位。这张清单与端上 public.ts 各家的 memberOnly 口径一致，
 *   但**这里才是计费闸门**：端上那份决定 UI 与请求值，改包即可绕过，只有这里拦得住。
 *   ⚠ 每家的「标准版 + 深度推理」两个模型名都要列进来，漏一个 = 那一档对免费用户白送。
 * defaultModel：端上与云端都没指定模型时的兜底，取该家**免费档（极速版）**的模型名。
 * chatMaxTokens：对话输出上限，**所有请求都带**（2026-10-08 起不再按会员分档）。
 *   它是「输出上限」不是额度，与「用户有没有付费」无关，只与「这一轮要写多长」有关：
 *   报告正文是多段摘要 + 逐条动态的长 JSON，不给上限时用上游默认（DeepSeek 4096），
 *   而第二批给免费提示词加的 5 段事实字段（档案 / 关系 / 后续关注 / 名词解释 / 争议）
 *   会把报告 JSON 顶过默认上限 → 输出被截断 → JSON 解析不出 → 重试再失败 →
 *   整份报告降级成纯文本简版（表现是报告页的卡片成批消失，像功能被删了）。
 *   会员的「深度模式」现在只体现在**素材加厚**（search 的 count 分档）与模型档位上。
 */
const PROVIDERS = {
  qwen: {
    label: '通义千问',
    /*
     * 专属部署端点（阿里云百炼 MaaS，北京区）：标准 dashscope.aliyuncs.com 上 flash 生成
     * 1500 字报告 >60s 未返回（实测），故换到专属实例。base path 仍为 /compatible-mode/v1
     * （该端点 /v1 与根路径都 404，已实测确认）。
     */
    baseUrl: 'https://llm-scqsvc912atw6h3o.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'QWEN_API_KEY',
    /* 三档：极速版 qwen3.8-flash / 标准版 qwen3.7-plus / 深度推理 qwen3.8-max */
    defaultModel: 'qwen3.8-flash',
    memberOnlyModels: ['qwen3.7-plus', 'qwen3.8-max'],
    chatMaxTokens: 8192,
    /*
     * 关思考：这三档实测都返回 reasoning_content（连「只回复两个字」都先思考），报告长生成时
     * 思考阶段就把上游 50s 空闲超时耗光。enable_thinking:false 是 DashScope Qwen3 官方开关，
     * 关掉后同规模报告约 40~49s、reasoning 0 字。extraBody 由 handleChat / askLlm 合并进请求体
     * （探针 probeModelTiers 刻意不带，它要测的就是「默认开不开思考」）。
     */
    extraBody: { enable_thinking: false }
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPU_API_KEY',
    /* 三档：极速版 glm-4.7-flash / 标准版 glm-4.6 / 深度推理 glm-4.7（混合思考，默认非推理） */
    defaultModel: 'glm-4.7-flash',
    memberOnlyModels: ['glm-4.6', 'glm-4.7'],
    chatMaxTokens: 8192
  },
  /**
   * OpenAI 官方端点：**云函数在境内无法直连**，只有部署在境外区域、或把 baseUrl 指向
   * 自建中转时才可用（后者更常见：填 LLM_BASE_URL 覆盖即可，不必用这一项）。
   * 未列入端上 llm.providers：用户切过去只会失败，不必给他一个必然报错的选项。
   */
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.6-luna',
    memberOnlyModels: ['gpt-5.6-terra', 'gpt-5.6-sol'],
    chatMaxTokens: 8192
  },
  /**
   * 任意 OpenAI 兼容端点的占位项：baseUrl 与模型名都必须靠 LLM_BASE_URL / LLM_MODEL 覆盖
   * （留空就是空的，故意的 —— 不臆造一个会连错的默认地址）。同样未列入端上清单。
   */
  custom: {
    label: '自定义端点',
    baseUrl: '',
    apiKeyEnv: 'LLM_API_KEY',
    defaultModel: '',
    memberOnlyModels: [],
    chatMaxTokens: 8192
  }
}

/** 表里没指定、环境变量也没指定时用哪家；须与端上 public.ts 的 llm.provider 一致 */
const DEFAULT_PROVIDER = 'qwen'

function readEnv(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * 解析本次调用要用哪家、哪个端点、哪把 key、哪个模型。
 *
 * 供应商优先级：event.provider（端上请求 = 用户在「我的」页选的那家）> LLM_PROVIDER（云端兜底）
 * > DEFAULT_PROVIDER。
 * 为什么让端上压过云端（2026-10-08 改）：供应商已改成**用户可自选**，端上带上来的是用户的真实
 * 选择，云端再压一道等于把用户的切换静默吞掉（表现是「设置页显示 A 家、实际账单与效果在 B 家」）。
 * 云端那份的定位随之变成兜底：端上没带、或带了个表里没有的 id（老版本包 / 改包）时才接管；
 * 定时任务 hotBoardRefresh 不带 event.provider，走的正是这条，行为与改造前一致。
 *
 * 模型优先级：LLM_MODEL > 端上传来的（**仅当端上与最终选定的家是同一家**）> 该家 defaultModel。
 * sameOrigin 这一关必须留着：端上与云端各自可能落后一步，把 A 家的模型名发给 B 家的端点是
 * **必然失败**的错配，此时宁可用该家的默认档（也顺便保住了「没带模型名也能跑」）。
 *
 * 返回的 apiKeyEnv 是「该去哪个环境变量找 key」：未配置时的报错要用它指路 ——
 * 一句不带变量名的「未配置」，排障时等于没说。
 */
function resolveLlm(event) {
  const ev = event || {}
  const asked = typeof ev.provider === 'string' ? ev.provider.trim() : ''
  const envProvider = readEnv('LLM_PROVIDER')
  const id =
    (asked && PROVIDERS[asked] && asked) ||
    (envProvider && PROVIDERS[envProvider] && envProvider) ||
    DEFAULT_PROVIDER
  const conf = PROVIDERS[id]

  const sameOrigin = !asked || asked === id
  const askedModel = typeof ev.model === 'string' ? ev.model.trim() : ''
  const overrideKey = readEnv('LLM_API_KEY')
  /*
   * 用 LLM_MODEL 指定了模型时，memberOnly 判断按「模型名是否在该家清单里」自然得出 ——
   * 自定义模型名不在清单里，即视为不限制档位。这是配置者的选择，不做额外拦截。
   */
  const model = readEnv('LLM_MODEL') || (sameOrigin && askedModel ? askedModel : '') || conf.defaultModel

  return {
    provider: id,
    label: conf.label,
    baseUrl: readEnv('LLM_BASE_URL') || conf.baseUrl,
    apiKey: overrideKey || readEnv(conf.apiKeyEnv),
    apiKeyEnv: overrideKey ? 'LLM_API_KEY' : conf.apiKeyEnv,
    model,
    defaultModel: conf.defaultModel,
    /*
     * 输出上限。**键名必须与 PROVIDERS 里的一致（chatMaxTokens）**。
     *
     * 这里原本写的是 deepMaxTokens —— 「输出上限只给会员」时期的遗留名。PROVIDERS 里从来没有
     * 这个键，于是它恒为 undefined；而 aiProxy 是照 `max_tokens: llm.chatMaxTokens` 取值的
     * （同样是 undefined）。JSON.stringify 会把值为 undefined 的键**整个丢掉**，请求体里
     * 于是根本没有 max_tokens，上游静默退回它自己的默认值（DeepSeek 4096）。
     * 后果就是文件上方那段注释描述的连锁反应：报告 JSON 顶过默认上限 → 尾部被截断 →
     * 解析失败 → 端上重试再失败 → 整份降级成纯文本简版 —— 报告页的折线图、词云与卡片
     * 成批消失，而每一层都没有报错（一个不存在的键被安静地传了下去）。
     * 修法只有一处，但两处（本文件 + PROVIDERS）必须配对：任何一处改名 = 上限失效。
     */
    chatMaxTokens: conf.chatMaxTokens,
    /* 该家的「关思考」等额外请求体字段（qwen=enable_thinking:false），由调用方合并进 payload */
    extraBody: conf.extraBody || null,
    memberOnly: (conf.memberOnlyModels || []).includes(model)
  }
}

module.exports = { PROVIDERS, DEFAULT_PROVIDER, resolveLlm }
