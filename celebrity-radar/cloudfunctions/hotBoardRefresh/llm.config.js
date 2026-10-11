/**
 * 大模型档位表（2026-10-11 改造：不再直连各大厂商，统一走**微信云开发 AI**）。
 *
 * ── 这次改造改了什么 ────────────────────────────────────────────
 * 改造前：本文件是「供应商注册表」，每家有 baseUrl + apiKeyEnv + defaultModel + memberOnlyModels，
 *   aiProxy / hotBoardRefresh 用 https POST `{baseUrl}/chat/completions` 直连上游，key 存环境变量。
 * 改造后：只剩**一家**（云开发 AI），调用形态换成云函数端 SDK 的 `cloud.ai()`：
 *     const ai = cloud.ai()
 *     const model = ai.createModel(MODEL_GROUP)
 *     const res = await model.streamText({ model, messages, max_tokens, ... }, { timeout })
 *   baseUrl / apiKey / apiKeyEnv 全部消失 —— 鉴权由云开发环境承担，端上与云端都不再持有任何厂商 key。
 *
 * ── 为什么改叫「档位表」────────────────────────────────────────
 * 「供应商」这个用户可选维度整体移除（详见 src/config/public.ts 顶部说明）：
 * 只剩云开发 AI 一家，用户不再选「哪家」，只选「哪一档」。
 * 于是本表按**档位**组织（fast / standard / reason = 极速版 / 标准版 / 深度推理），
 * 每档一个具体模型名，会员闸门 =「这一档是不是 memberOnly」。
 *
 * ── 云开发 AI 的接入事实（来自官方 SDK 文档，逐字核对过）──────────
 *   · `cloud.ai()` 需 **wx-server-sdk ≥ 4.0.1**（见两个 package.json）。
 *   · `ai.createModel(model)` 的入参是**模型组名**：内置名有
 *     hunyuan / hunyuan-beta / hunyuan-exp / hunyuan-open / deepseek / moonshot / zhipu /
 *     dashscope / ark / 01-ai；非内置名（如 'cloudbase'）走默认实现
 *     （请求路径 `{model}/chat/completions`）。我们统一用 'cloudbase'（云开发售卖的模型）。
 *   · `generateText` 返回 `{ text, messages, usage, rawResponses, error? }` —— **不含** finish_reason。
 *   · `streamText` 返回 `{ dataStream, textStream, messages, usage, error? }`，其中 dataStream 的
 *     每个元素含 `choices[n].finish_reason` —— **这是拿到「是否被截断」的唯一途径**，
 *     也是本改造必须用 streamText 而不能用 generateText 的原因（见 aiProxy/index.js 的 handleChat）。
 *   · 文档未定义的字段（如 `max_tokens`）会**随请求体透传**给模型 —— 所以 chatMaxTokens 照传。
 *   · `cloud.init({ timeout })` 默认 15000ms；单次调用可用 `options.timeout` 覆盖。
 *
 * ── ⚠ 模型名必须实测回填（本次改造唯一的未定项）──────────────────
 * `generateText({ model })` 里的模型名**以「你的云开发环境已开通了哪些模型」为准**，
 * 文档不会给死清单（示例里的 hy3-preview / deepseek-r1 只是「可能可用」）。
 * 下表的三个默认值取自官方文档里**确切出现过**的名字，但**上线前必须实测确认**：
 *   ① 控制台 → 云开发 → AI → 模型管理，看已开通的模型；或
 *   ② 部署后调 aiProxy 的 `{ action:'test', token, models:true }` 探针，它会逐档真跑一遍并列出结果。
 * 若实测发现某个名字不通，**不必改代码**：用环境变量覆盖即可（见下方 MODEL_ENV_PREFIX）：
 *   CLOUD_AI_MODEL_FAST / CLOUD_AI_MODEL_STANDARD / CLOUD_AI_MODEL_REASON
 *
 * ⚠ 本文件在 aiProxy 与 hotBoardRefresh 各有一份**副本**：微信云函数各自独立打包上传，
 * 跨目录 require 在本地能跑、部署后必然失效（表现为定时任务报「找不到模块」）。
 * 两份必须逐字一致 —— 用例 07 逐字比对钉住。
 */

/**
 * 云开发 AI 的「模型组」入参（`ai.createModel(...)`）。
 * 'cloudbase' = 云开发售卖的模型（DeepSeek / 混元 / GLM / Minimax / Kimi 等）；
 * 换用某个内置组（如 'deepseek'）只改这一个常量。
 */
const MODEL_GROUP = 'cloudbase'

/**
 * 覆盖模型名的环境变量前缀：`CLOUD_AI_MODEL_<TIER 大写>`。
 * 实测回填时只需在云函数环境变量里加上这几项，**不用改代码、不用重新走一遍发版**。
 */
const MODEL_ENV_PREFIX = 'CLOUD_AI_MODEL_'

/**
 * 三档位表。键即端上传上来的 tier（fast / standard / reason）。
 *
 * model：传给 `generateText/streamText` 的具体模型名。**默认值是占位候选，务必实测回填**。
 * memberOnly：这一档是否会员专属 = 计费闸门。**这里才是闸门**，端上那份只决定 UI 与请求值
 *   （改包即可绕过）。三档里只有 fast 对所有人开放。
 * chatMaxTokens：输出上限，所有请求都带（按档位可不同）。它是「这一轮要写多长」的上限，
 *   不是额度：报告正文是多段摘要 + 逐条动态的长 JSON，不给上限时用上游默认值，
 *   会被顶过默认上限 → 尾部截断 → JSON 解析失败 → 重试再失败 → 整份报告降级成纯文本简版
 *   （表现是报告页卡片成批消失，像功能被删了）。故**必须透传**。
 * extraBody：该档额外的请求体字段（会随请求体透传）。云开发 AI 上没有等价于
 *   dashscope `enable_thinking` 的通用开关，故留 null；若实测发现某档需要（如推理档要显式
 *   开思考），在这里补。
 */
const TIERS = {
  fast: {
    label: '极速版',
    /* 文档示例中出现过的模型名；实测确认后可换。见文件头「⚠ 模型名必须实测回填」 */
    model: 'hy3-preview',
    memberOnly: false,
    chatMaxTokens: 8192,
    extraBody: null
  },
  standard: {
    label: '标准版',
    /* 文档提到「建议使用 cloudbase hy3」；实测确认后可换 */
    model: 'hy3',
    memberOnly: true,
    chatMaxTokens: 8192,
    extraBody: null
  },
  reason: {
    label: '深度推理',
    /* 文档示例中出现过的推理模型；实测确认后可换 */
    model: 'deepseek-r1',
    memberOnly: true,
    chatMaxTokens: 8192,
    extraBody: null
  }
}

/** 表里没指定、端上也没带时用哪一档；须与端上 public.ts 的默认档一致 */
const DEFAULT_TIER = 'fast'

function readEnv(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** 该档位对应的模型名：环境变量覆盖优先，否则取表里的默认值 */
function modelOf(tier, conf) {
  return readEnv(MODEL_ENV_PREFIX + tier.toUpperCase()) || conf.model
}

/**
 * 解析本次调用用哪一档、哪个模型、上限多少。
 *
 * 档位优先级：event.tier（端上请求 = 用户在「我的」页选的那一档）> LLM_TIER（云端兜底，
 * 定时任务 hotBoardRefresh 走这条 —— 它没有端上偏好）> DEFAULT_TIER。
 *
 * 为什么让端上压过云端：档位是**用户自选**的，端上带上来的是用户的真实选择，云端再压一道
 * 等于把用户的切换静默吞掉。云端那份的定位是兜底：端上没带、或带了个表里没有的 id
 * （老版本包 / 改包）时才接管。
 *
 * 返回的 `model` 已含环境变量覆盖（CLOUD_AI_MODEL_*），调用方直接拿它传给 SDK 即可。
 */
function resolveLlm(event) {
  const ev = event || {}
  const asked = typeof ev.tier === 'string' ? ev.tier.trim() : ''
  const envTier = readEnv('LLM_TIER')
  const tier =
    (asked && TIERS[asked] && asked) ||
    (envTier && TIERS[envTier] && envTier) ||
    DEFAULT_TIER
  const conf = TIERS[tier]
  const model = modelOf(tier, conf)

  return {
    tier,
    label: conf.label,
    /* ai.createModel(MODEL_GROUP) 的入参 */
    modelGroup: MODEL_GROUP,
    model,
    /* 兜底档的模型名（未指定档位时用）；保留键名与调用方口径一致 */
    defaultModel: modelOf(DEFAULT_TIER, TIERS[DEFAULT_TIER]),
    /*
     * 输出上限。**键名必须与 TIERS 里的一致（chatMaxTokens）**。
     * 历史上这里曾写错成 deepMaxTokens，导致 max_tokens 整键被 JSON.stringify 丢掉、
     * 上游静默退回默认上限、报告被截断 —— 改名必须两处配对。
     */
    chatMaxTokens: conf.chatMaxTokens,
    /* 该档额外的请求体字段，由调用方合并进 payload */
    extraBody: conf.extraBody || null,
    memberOnly: conf.memberOnly
  }
}

module.exports = { TIERS, MODEL_GROUP, DEFAULT_TIER, resolveLlm }
