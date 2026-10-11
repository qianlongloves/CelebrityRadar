/**
 * 大模型配置（2026-10-12 v3：厂商 × 质量档 × 能力槽，全部配置只在本文件裁决）。
 *
 * ── 选型模型（用户选什么 / 系统怎么路由）─────────────────────────
 * 用户在「我的」页选择两样东西，可随时切换：
 *   ① 厂商 vendor：云开发 AI / DeepSeek / 智谱 GLM / Kimi / 通义千问（VENDORS 的键）；
 *   ② 质量档 quality：基础版 basic（免费）/ 标准版 standard（会员）/ 高级版 premium（会员）。
 * 具体用哪个模型由**用途**在该档的两个能力槽里选，用户不直接选模型：
 *   · 报告生成 generate / 辅助 aux → structured 槽（输出型：稳定长 JSON，**绝不发给纯推理模型**）；
 *   · AI 问答 ask                    → reasoning 槽（推理型：先思考再回答）。
 * 这样回答了「一个模型只会一种能力怎么办」：同一质量档的两个槽可以是不同模型，
 * 双模模型（如 deepseek-v4-flash）则在两个槽里用 extraBody 切换思考开关，一个模型占两个槽。
 *
 * ── 业务矩阵（免费 = 该厂商基础档；会员可手动升标准 / 高级）──────────────
 *                  免费用户            会员（手动切档后生效）
 *   报告 generate  <厂>.basic.structured   <厂>.<standard|premium>.structured
 *   AI 问答 ask     <厂>.basic.reasoning    <厂>.<standard|premium>.reasoning
 *   辅助 aux       <厂>.basic.structured   同左（系统内部调用，强制基础档，不为它烧高档的钱）
 *
 * ── 缺槽兜底（用户已确认：同厂商向下降档）──────────────────────────
 * 所选质量档没有该能力槽的模型时（例：Kimi 高级档没有非思考旗舰，kimi-k3 只能推理），
 * resolveLlm 在**同一厂商内**沿 premium → standard → basic 找第一个有该能力的槽，
 * 绝不跨能力（报告不用纯推理模型）、绝不跨厂商（不偷偷换厂），并在回执里标 qualityDowngraded。
 * 连基础档都缺该能力 → configError，点名缺哪个槽、该配哪个环境变量。
 *
 * ── 两种接入通道 ────────────────────────────────────────────────
 * ① channel='cloudai'（默认厂商 cloudbase）：微信云开发 AI，走 cloud.ai()，零 key；
 * ② channel='http'：OpenAI 兼容协议（POST {endpoint}/chat/completions，Bearer key），
 *     key 只存在于云函数环境变量里，**绝不进小程序包、不写进本文件**。
 *
 * ── 环境变量（全部可选；不设即用本文件默认值，默认厂商零 key 可用）──────────
 *     LLM_VENDOR                              端上没带厂商 / 定时任务用的默认厂商
 *     LLM_TIER                                默认质量档（也兼容旧值 fast/standard/reason）
 *     <VENDOR>_API_KEY                        各厂 key（DEEPSEEK / ZHIPU / MOONSHOT）
 *     LLM_MODEL_<VENDOR>_<QUALITY>_<CAP>      覆盖任一槽位模型名
 *                                             （如 LLM_MODEL_DEEPSEEK_STANDARD_REASONING）
 *     LLM_HTTP_ENDPOINT_<VENDOR>              覆盖厂商端点（接代理 / 兼容网关时用）
 *
 * ── 新增 / 调整一家厂商 ──────────────────────────────────────────
 * 只改下方 VENDORS：给三档各配 structured / reasoning 两个槽 { model, extraBody? }，
 * 调用方（两个云函数 + 端上就绪接口）无需改动。模型名会上下架，以厂商控制台为准，
 * 临时换名优先用环境变量，不必改码、不必重新发版。
 *
 * ⚠ 本文件在 aiProxy 与 hotBoardRefresh 各有一份**副本**：云函数各自独立打包，
 * 跨目录 require 部署后必然失效；两份必须逐字一致 —— 用例 07 逐字比对钉住。
 */

'use strict'

/** cloudai 通道的模型组入参（ai.createModel(MODEL_GROUP)）；非内置名走默认实现 */
const MODEL_GROUP = 'cloudbase'

/** 质量档（顺序即从低到高；memberOnly 是计费闸门，云端这份为准，端上只管 UI） */
const QUALITIES = [
  { key: 'basic', label: '基础版', memberOnly: false },
  { key: 'standard', label: '标准版', memberOnly: true },
  { key: 'premium', label: '高级版', memberOnly: true }
]
const QUALITY_MAP = QUALITIES.reduce((acc, q) => {
  acc[q.key] = q
  return acc
}, {})

const DEFAULT_VENDOR = 'cloudbase'
const DEFAULT_QUALITY = 'basic'

/** 用途 → 能力槽：报告 / 辅助只取输出型，问答只取推理型 */
const PURPOSE_CAPABILITY = {
  generate: 'structured',
  ask: 'reasoning',
  aux: 'structured'
}

/** 辅助调用（消歧 / 选题 / 检索规划）强制基础档：系统内部请求，不为它烧会员档的钱 */
const AUX_FORCE_QUALITY = 'basic'

/** 所有请求统一的输出上限（「这一轮写多长」的客观需求，不是额度；理由见 git 历史）。
 *  ⚠ 通义千问思考模式要求 max_tokens ∈ [1, 32768]（超出直接 400），故这个值不能盲目调大。 */
const CHAT_MAX_TOKENS = 8192

/*
 * 思考开关（extraBody 透传，各厂参数形状以官方文档为准）：
 *   DeepSeek v4 / 智谱 GLM-4.5+ / Kimi k2.6：thinking:{type:'enabled'|'disabled'}
 *   Kimi k3 无此开关（思考永久开启），改用 reasoning_effort:'low'|'high'|'max'
 *   通义千问（百炼）双模模型：enable_thinking:true|false（布尔，与上面的 thinking.type 不是一套）
 * 双模模型靠它在同一质量档里占两个槽：报告槽显式关思考，问答槽开思考。
 */
const THINK_ON = { thinking: { type: 'enabled' } }
const THINK_OFF = { thinking: { type: 'disabled' } }
const QWEN_THINK_ON = { enable_thinking: true }
const QWEN_THINK_OFF = { enable_thinking: false }

/**
 * 厂商注册表 —— 全项目大模型供应商的唯一登记处。
 * 每家三档（tiers），每档两个能力槽（structured / reasoning），槽 = { model, extraBody? }。
 * keyEnv 只登记变量名；endpoint 是公开基址（非密钥）；都可用环境变量覆盖。
 *
 * 模型事实（2026-10-12 核自官方文档）：
 *   DeepSeek：deepseek-v4-flash（双模，便宜）/ deepseek-v4-pro（双模，旗舰）；
 *             旧名 deepseek-chat / deepseek-reasoner 已于 2026-07-24 弃用（分别=flash 关/开思考）。
 *   智谱：glm-4.7-flash（免费、非思考，基础档报告零成本）/ glm-4.5-air（便宜双模）/
 *         glm-4.7（双模）/ glm-5.3（旗舰双模）。
 *   Kimi：kimi-k2.6（双模）/ kimi-k3（旗舰，**只能思考**，故只允许出现在 reasoning 槽）；
 *         moonshot-v1 与 kimi-k2 系列均已于 2026-08-31 下线。
 *   通义千问（百炼 Model Studio）：qwen3.5-flash（双模，最便宜，带免费额度）/
 *         qwen3.7-plus（双模，1M 上下文）/ qwen3.8-max（旗舰双模）。思考开关是 enable_thinking
 *         布尔（OpenAI 兼容模式经 extra_body 透传，落到报文体就是与 model 平级的字段）；
 *         三家都是双模，两槽互相补齐，故三档皆无缺槽（不会触发向下降档）。
 */
const VENDORS = {
  /* ── 云开发 AI（默认通道，零 key）：模型名以当前环境实际开通为准，可用 LLM_MODEL_CLOUDBASE_* 覆盖 ── */
  cloudbase: {
    label: '云开发 AI',
    channel: 'cloudai',
    modelGroup: MODEL_GROUP,
    tiers: {
      basic: {
        structured: { model: 'hy3' },
        reasoning: { model: 'hy4-preview' }
      },
      standard: {
        structured: { model: 'hy3' },
        reasoning: { model: 'hy4-preview' }
      },
      premium: {
        structured: { model: 'hy3' },
        reasoning: { model: 'hy4-preview' }
      }
    }
  },

  deepseek: {
    label: 'DeepSeek',
    channel: 'http',
    endpoint: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    tiers: {
      /* 基础档：flash 一个模型占两槽（关思考写 JSON / 开思考做问答），成本最低 */
      basic: {
        structured: { model: 'deepseek-v4-flash', extraBody: THINK_OFF },
        reasoning: { model: 'deepseek-v4-flash', extraBody: THINK_ON }
      },
      /* 标准档：报告升级 pro（非思考），问答仍用 flash 思考（pro 思考贵 3 倍，留给高级档） */
      standard: {
        structured: { model: 'deepseek-v4-pro', extraBody: THINK_OFF },
        reasoning: { model: 'deepseek-v4-flash', extraBody: THINK_ON }
      },
      /* 高级档：两槽都是 pro 旗舰 */
      premium: {
        structured: { model: 'deepseek-v4-pro', extraBody: THINK_OFF },
        reasoning: { model: 'deepseek-v4-pro', extraBody: THINK_ON }
      }
    }
  },

  zhipu: {
    label: '智谱 GLM',
    channel: 'http',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    keyEnv: 'ZHIPU_API_KEY',
    tiers: {
      /* 基础档：报告用免费的 glm-4.7-flash（平台免额度费），问答用最便宜的双模 glm-4.5-air 开思考 */
      basic: {
        structured: { model: 'glm-4.7-flash' },
        reasoning: { model: 'glm-4.5-air', extraBody: THINK_ON }
      },
      standard: {
        structured: { model: 'glm-4.7', extraBody: THINK_OFF },
        reasoning: { model: 'glm-4.7', extraBody: THINK_ON }
      },
      premium: {
        structured: { model: 'glm-5.3', extraBody: THINK_OFF },
        reasoning: { model: 'glm-5.3', extraBody: THINK_ON }
      }
    }
  },

  moonshot: {
    label: 'Kimi',
    channel: 'http',
    endpoint: 'https://api.moonshot.cn/v1',
    keyEnv: 'MOONSHOT_API_KEY',
    tiers: {
      /* 基础档：k2.6 双模占两槽 */
      basic: {
        structured: { model: 'kimi-k2.6', extraBody: THINK_OFF },
        reasoning: { model: 'kimi-k2.6', extraBody: THINK_ON }
      },
      /* 标准档：问答升级 k3（降推理强度省 token）；Kimi 无非思考旗舰，报告槽保留 k2.6 */
      standard: {
        structured: { model: 'kimi-k2.6', extraBody: THINK_OFF },
        reasoning: { model: 'kimi-k3', extraBody: { reasoning_effort: 'low' } }
      },
      /* 高级档：问答 k3 满强度；**structured 槽刻意留 null** —— k3 思考永久开启、不能输出型使用，
         Kimi 又没有更高级的非思考旗舰。会员选「Kimi + 高级版」生成报告时，resolveLlm 沿
         premium→standard 向下降到 k2.6，并在回执标 qualityDowngraded（这是降档规则的实证场景，
         对应「选中的模型只能满足一种能力怎么办」：报告绝不改用推理模型，也不偷偷换厂商） */
      premium: {
        structured: null,
        reasoning: { model: 'kimi-k3', extraBody: { reasoning_effort: 'max' } }
      }
    }
  },

  /*
   * 通义千问（阿里云百炼 Model Studio，OpenAI 兼容模式）。
   * key 是 DASHSCOPE_API_KEY；endpoint 用**中国内地（北京）**的兼容模式基址
   * （国际站是 dashscope-intl，接哪站以部署环境为准，可用 LLM_HTTP_ENDPOINT_QWEN 覆盖）。
   * 三档都是双模（enable_thinking 开关），报告槽关思考、问答槽开思考；三档模型各不相同：
   *   basic  qwen3.5-flash  —— 最便宜、带免费额度，日常报告与问答
   *   standard qwen3.7-plus —— 能力更强、1M 上下文
   *   premium qwen3.8-max   —— 旗舰，质量优先
   */
  qwen: {
    label: '通义千问',
    channel: 'http',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'DASHSCOPE_API_KEY',
    tiers: {
      basic: {
        structured: { model: 'qwen3.5-flash', extraBody: QWEN_THINK_OFF },
        reasoning: { model: 'qwen3.5-flash', extraBody: QWEN_THINK_ON }
      },
      standard: {
        structured: { model: 'qwen3.7-plus', extraBody: QWEN_THINK_OFF },
        reasoning: { model: 'qwen3.7-plus', extraBody: QWEN_THINK_ON }
      },
      premium: {
        structured: { model: 'qwen3.8-max', extraBody: QWEN_THINK_OFF },
        reasoning: { model: 'qwen3.8-max', extraBody: QWEN_THINK_ON }
      }
    }
  }
}

function readEnv(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * 归一化质量档。兼容旧版端上传的 tier 名（fast / reasonLite → basic，
 * standard 不变，reason → premium），灰度期老版本小程序不至于落到配置错误。
 */
function normalizeQuality(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (QUALITY_MAP[s]) return s
  if (s === 'fast' || s === 'reasonLite') return 'basic'
  if (s === 'reason') return 'premium'
  return null
}

/** 厂商是否就绪：cloudai 恒真（SDK 由调用方另查）；http 厂看 key 在不在环境里 */
function vendorReady(key, conf) {
  if (conf.channel === 'cloudai') return true
  return !!readEnv(conf.keyEnv)
}

/** 供 action='vendors' 只读接口用：注册表公开信息 + 就绪状态（不含 key、不打上游） */
function vendorCatalog() {
  return Object.keys(VENDORS).map((key) => {
    const conf = VENDORS[key]
    return {
      key,
      label: conf.label,
      channel: conf.channel,
      ready: vendorReady(key, conf),
      qualities: QUALITIES.map((q) => ({
        key: q.key,
        structured: !!(conf.tiers[q.key] && conf.tiers[q.key].structured),
        reasoning: !!(conf.tiers[q.key] && conf.tiers[q.key].reasoning)
      }))
    }
  })
}

/**
 * 裁决本次调用：厂商 + 质量档 + 用途（能力槽） → 一条完整路由。
 *
 * 入参 event：{ vendor?, quality?|tier?(旧), purpose? }
 * 优先级：端上显式值 > 环境变量（LLM_VENDOR / LLM_TIER）> 默认厂商 / 基础档。
 *
 * 返回：{ channel, vendor, vendorLabel, quality, qualityRequested, qualityDowngraded,
 *        capability, purpose, model, extraBody, chatMaxTokens, memberOnly,
 *        endpoint?, apiKeyEnv?, modelGroup?, configError? }
 */
function resolveLlm(event) {
  const ev = event || {}

  /* ① 厂商：端上选择 > LLM_VENDOR > cloudbase；未注册的名字不静默回落（否则「我切了厂」无从排查） */
  const askedVendor =
    (typeof ev.vendor === 'string' && ev.vendor.trim()) || readEnv('LLM_VENDOR') || DEFAULT_VENDOR
  const vendorConf = VENDORS[askedVendor] || null
  const vendorKey = vendorConf ? askedVendor : DEFAULT_VENDOR
  const vendor = vendorConf || VENDORS[DEFAULT_VENDOR]
  const vendorError = vendorConf
    ? null
    : `厂商「${askedVendor}」未在 llm.config.js 的 VENDORS 注册，请检查端上厂商名或环境变量 LLM_VENDOR`

  /* ② 用途与能力槽（未知 purpose 按报告处理：宁可走结构化，不把报告发给纯推理模型） */
  const purpose = typeof ev.purpose === 'string' && PURPOSE_CAPABILITY[ev.purpose] ? ev.purpose : 'generate'
  const capability = PURPOSE_CAPABILITY[purpose]

  /* ③ 质量档：端上 > LLM_TIER（兼容旧 tier 名）> basic；辅助调用强制基础档 */
  let qualityRequested =
    normalizeQuality(ev.quality) ||
    normalizeQuality(ev.tier) ||
    normalizeQuality(readEnv('LLM_TIER')) ||
    DEFAULT_QUALITY
  if (purpose === 'aux') qualityRequested = AUX_FORCE_QUALITY

  /* ④ 同厂商内向下降档找能力槽（Kimi 高档无结构化模型是唯一会真实触发的情形） */
  let slot = null
  let quality = null
  const startIdx = QUALITIES.findIndex((q) => q.key === qualityRequested)
  for (let i = startIdx; i >= 0; i--) {
    const qKey = QUALITIES[i].key
    const candidate = vendor.tiers[qKey] && vendor.tiers[qKey][capability]
    if (candidate && candidate.model) {
      slot = candidate
      quality = qKey
      break
    }
  }
  const qualityDowngraded = !!slot && quality !== qualityRequested

  /* ⑤ 模型名：槽位默认 > LLM_MODEL_<VENDOR>_<QUALITY>_<CAPABILITY> 覆盖（覆盖跟随实际落档） */
  let model = null
  let modelOverrideEnv = null
  if (slot) {
    modelOverrideEnv = `LLM_MODEL_${vendorKey.toUpperCase()}_${quality.toUpperCase()}_${capability.toUpperCase()}`
    model = readEnv(modelOverrideEnv) || slot.model
  }

  const slotError = slot
    ? null
    : `${vendor.label} 从「${QUALITY_MAP[qualityRequested].label}」向下所有质量档都没有 ${
        capability === 'structured' ? '结构化输出' : '推理'
      }模型槽，请在 llm.config.js 的 VENDORS.${vendorKey}.tiers 补 ${capability} 槽，或设对应 LLM_MODEL_${vendorKey.toUpperCase()}_<质量档>_${capability.toUpperCase()}`

  const configError = vendorError || slotError

  const base = {
    channel: vendor.channel,
    vendor: vendorKey,
    vendorLabel: vendor.label,
    quality,
    qualityRequested,
    qualityDowngraded,
    capability,
    purpose,
    model,
    extraBody: (slot && slot.extraBody) || null,
    chatMaxTokens: CHAT_MAX_TOKENS,
    memberOnly: quality ? QUALITY_MAP[quality].memberOnly : QUALITIES[0].memberOnly,
    configError
  }

  if (vendor.channel === 'http') {
    return Object.assign(base, {
      endpoint: readEnv(`LLM_HTTP_ENDPOINT_${vendorKey.toUpperCase()}`) || vendor.endpoint,
      apiKeyEnv: vendor.keyEnv,
      modelGroup: null
    })
  }
  return Object.assign(base, {
    modelGroup: vendor.modelGroup || MODEL_GROUP,
    endpoint: null,
    apiKeyEnv: null
  })
}

module.exports = {
  VENDORS,
  QUALITIES,
  QUALITY_MAP,
  DEFAULT_VENDOR,
  DEFAULT_QUALITY,
  PURPOSE_CAPABILITY,
  CHAT_MAX_TOKENS,
  vendorReady,
  vendorCatalog,
  resolveLlm
}
