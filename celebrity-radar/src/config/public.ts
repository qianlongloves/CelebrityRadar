/**
 * 非敏感公共配置（§3.8）：可进包。
 * 本项目不持有任何用户密钥 —— 搜索与大模型的 key 只存在于云函数环境变量里，
 * 客户端零配置（见 utils/llm.ts 与 utils/search.ts）。严禁把任何 key 写进本文件。
 *
 * 【哪些值不在这里】环境相关项与本地调试开关已抽到 **未跟踪** 的 `src/config/local.ts`：
 *
 *   cloudbaseEnvId / subscribeTemplateId / alertTemplateId / webviewDomains / debug
 *
 * 仓库里只有 `local.example.ts`（值为占位串）。首次 clone 后先执行：
 *
 *   cp src/config/local.example.ts src/config/local.ts
 *
 * 再把 cloudbaseEnvId 换成自己的云开发环境 ID（微信开发者工具 → 工具栏「云开发」→ 环境 ID，
 * 形如 `celebrity-radar-1a2b3c4d`）。该环境须与 project.config.json 里的 appid 归属同一个小程序；
 * 未配置时 isCloudConfigured 为 false，登录与全部 DB 调用不会发起。
 *
 * 为什么要分开：仓库里留真实环境 ID，fork 者会直接连上原作者的云环境；
 * 而本地为放开额度把 debug 置 true 的改动，混在本文件里也总有误提交的风险。
 *
 * 【llm】上游密钥由云函数 aiProxy 用环境变量代打（具体变量名随供应商而变，
 * 见 cloudfunctions/aiProxy/llm.config.js），端上不再直连上游，故这里只留
 * 供应商 id 与模型名，不留 baseURL / apiKey。
 * 2026-10-08 起供应商**由用户自选**（「我的 → 模型供应商」），因此下面列的每一家都要在云端
 * 配好 key（用户切到哪家、云函数就用哪家的 key 代打，用户为额度付费）；清单见 llm.providers。
 *
 * 【调试开关】debug 的五个值同样取自 local.ts，**仓库默认五项全 false**：
 * 四个 disable* 都会放大成本（免费层限流、提问额度与 429 冷却同时失效），
 * 只在本地联调时置 true。逐项说明见 local.example.ts。
 *
 * 配套：云端需先建好 users 集合，权限设为「仅创建者可读写」
 *（这是客户端能取到自己 _openid 的唯一途径）。字段由首次登录自动写入，无需手工建。
 */
import { localConfig } from './local'

/**
 * 可选模型供应商（2026-10-08：供应商由用户自选，key 仍由开发者提供）。
 *
 * 每个供应商都按**同一套三档**组织（tier 是档位标识，label 才是给用户看的名字）：
 *   fast     → 极速版   （免费档：memberOnly 必须为 false，它就是这家没得选时的兜底）
 *   standard → 标准版   （会员档）
 *   reason   → 深度推理 （会员档）
 * 用户在「我的」页先选供应商、再选档位；换供应商时档位清单整组跟着换，用户选的**档位**不变
 * （本机存的是 tier 而不是具体模型名，见 utils/settings.ts），于是切到哪家都是「他家对应的那一档」。
 *
 * ⚠ tier 名字刻意不叫 deep：全项目另有一个 O-11「深度模式」（会员生成时素材加厚 + 多两段专享内容，
 *   见 utils/report.ts 的 memberNotes），那是**报告深度**，与本文件的**模型档位**是两件事。
 *
 * ── key 从哪来（重要）──────────────────────────────────────────
 * 端上不持有任何 key：用户切到哪家，就由云函数 aiProxy 用**环境变量里那家的 key** 代打
 * （变量名见 cloudfunctions/aiProxy/llm.config.js 的 apiKeyEnv），用户为额度付费（免费档 / 会员档）。
 * 因此下表的每一家都必须在云端把 key 配好，否则用户一切过去就会拿到
 * 「平台未配置大模型额度（云函数环境变量 XXX_API_KEY）」。
 * **只列出你云端配置了 key 的供应商** —— 这是本表唯一的存在理由。
 *
 * ⚠ 下面的 id 必须与 cloudfunctions/aiProxy/llm.config.js 的 PROVIDERS 键一致（两份手工同步）；
 *   models 里的 id 必须是该家上游真实存在的模型名，填错只会在生成时报上游错误。
 *   memberOnly 那一列必须与 llm.config.js 的 memberOnlyModels 一致 —— 端上这列只决定 UI 与请求值
 *   （改包即可绕过），云函数那份才是计费闸门。
 *   （openai 与 custom 未列入：前者境内云函数连不上、后者没有默认端点，用户切过去只会失败。）
 */
const LLM_PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    models: [
      {
        tier: 'fast',
        id: 'deepseek-v4-flash',
        label: '极速版',
        desc: '响应最快、成本最低，适合日常生成报告',
        memberOnly: false
      },
      { tier: 'standard', id: 'deepseek-v4', label: '标准版', desc: '质量与速度均衡，长文更完整', memberOnly: true },
      {
        tier: 'reason',
        id: 'deepseek-reasoner',
        label: '深度推理',
        desc: '推理更强、耗时更长，适合深度分析',
        memberOnly: true
      }
    ]
  },
  {
    id: 'qwen',
    label: '通义千问',
    models: [
      { tier: 'fast', id: 'qwen-turbo', label: '极速版', desc: '响应最快、成本最低，适合日常生成报告', memberOnly: false },
      { tier: 'standard', id: 'qwen-plus', label: '标准版', desc: '质量与速度均衡，长文更完整', memberOnly: true },
      { tier: 'reason', id: 'qwen-max', label: '深度推理', desc: '推理更强、耗时更长，适合深度分析', memberOnly: true }
    ]
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    models: [
      { tier: 'fast', id: 'glm-4-flash', label: '极速版', desc: '响应最快、成本最低，适合日常生成报告', memberOnly: false },
      { tier: 'standard', id: 'glm-4-air', label: '标准版', desc: '质量与速度均衡，长文更完整', memberOnly: true },
      { tier: 'reason', id: 'glm-4-plus', label: '深度推理', desc: '推理更强、耗时更长，适合深度分析', memberOnly: true }
    ]
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    models: [
      {
        tier: 'fast',
        id: 'moonshot-v1-8k',
        label: '极速版',
        desc: '响应最快、成本最低，适合日常生成报告',
        memberOnly: false
      },
      { tier: 'standard', id: 'moonshot-v1-32k', label: '标准版', desc: '质量与速度均衡，长文更完整', memberOnly: true },
      {
        tier: 'reason',
        id: 'moonshot-v1-128k',
        label: '深度推理',
        desc: '推理更强、耗时更长，适合深度分析',
        memberOnly: true
      }
    ]
  }
] as const

/** 供应商（id + 展示名 + 他家的三档位） */
export type LlmProvider = (typeof LLM_PROVIDERS)[number]

/** 单个档位（tier 是档位标识，id 才是上游模型名） */
export type LlmTier = LlmProvider['models'][number]

export const publicConfig = {
  /** CloudBase 环境 ID（微信云开发 → 环境 ID）；取值见 src/config/local.ts */
  cloudbaseEnvId: localConfig.cloudbaseEnvId,

  /** LLM 通道：端上只读供应商与模型名，请求由 cloudfunctions/aiProxy 代发 */
  llm: {
    /**
     * 可选供应商清单（用户可在「我的 → 模型供应商」里切换）；见上方 LLM_PROVIDERS 的说明。
     * 顺序即展示顺序，**第一项即默认**（用户没选过供应商时走它）。
     */
    providers: LLM_PROVIDERS,

    /**
     * 默认供应商 id。须与 providers[0].id 一致 —— 它是「本机没存偏好」时的兜底，
     * 生成时随请求带给云函数（云函数侧 LLM_PROVIDER 只在端上没带 / 带了不认识的 id 时才接管，
     * 见 llm.config.js 的 resolveLlm）。
     */
    provider: 'deepseek',

    /**
     * 默认档位：providers[0]（默认供应商）那一档的模型名，须与他家的 fast 档一致。
     * 是「端上没带模型名」时的展示与请求值，云函数侧另有 llm.config.js 的 defaultModel 兜底。
     */
    model: 'deepseek-v4-flash',

    /**
     * 默认供应商的档位清单（= providers[0].models）。
     *
     * 之所以还留这一份：三家供应商的**档位标签是统一的**（极速版 / 标准版 / 深度推理），
     * 于是「档位文案」只需要一处来源 —— pages/member 的权益对比表与 utils/member.ts 的权益说明
     * 都按它推导，加一家供应商不必改这些文案。**界面渲染用户可选清单要用 llm.providers**。
     */
    models: LLM_PROVIDERS[0].models
  },

  /**
   * 订阅消息模板 ID（关注更新提醒）。
   *
   * 获取方式：微信公众平台 → 功能 → 订阅消息 → 公共模板库选用一个模板。
   * 推荐模板字段：`thing1`（提醒内容）+ `date2`（更新时间），
   * 与 cloudfunctions/notifyFollowUpdates 里发送的 data 键名一致，换模板需同步改。
   *
   * 模板 ID 不是密钥（每个用户都能在小程序里看到），可以进包；
   * 但云函数发送时读的是同名环境变量 SUBSCRIBE_TEMPLATE_ID，两边必须指向同一个模板。
   * 保持空串 = 未配置：此时「我的」页的入口只给指引，不发一个必然失败的授权请求。
   */
  subscribeTemplateId: localConfig.subscribeTemplateId,

  /**
   * 订阅消息模板 ID（关键词舆情预警，2026-10-08）。
   *
   * **必须与 subscribeTemplateId 是不同的模板**：微信「一次性订阅」的授权按**模板**消耗，
   * 两个定时任务（notifyFollowUpdates 09:00 / keywordAlert 09:20）若共用一枚模板与一个授权位，
   * 先跑的那个会把授权吃掉，后跑的必得 43101 —— 表现为「有一半提醒永远收不到」。
   * 云函数侧读的是同名环境变量 ALERT_TEMPLATE_ID，两边必须指向同一个模板。
   *
   * 字段要求与关注提醒相同（thing1 + date2）；保持空串 = 未配置：此时预警页只给站内预警
   * （云端已写库，照样看得到），不发一个必然失败的授权请求。
   */
  alertTemplateId: localConfig.alertTemplateId,

  /**
   * 业务域名白名单：「原文预览」页里能真正内嵌打开的站点（见 pages/link-preview）。
   *
   * 微信规定 web-view 只能加载事先在「公众平台 → 开发管理 → 业务域名」登记并校验过的
   * 域名（须 https + 已备案），而报告的素材来自任意媒体，不可能逐一登记，所以默认留空：
   * 未登记的域名走「素材预览卡 + 复制链接」的降级路径，行为可预期、不会白屏。
   * 日后若把某些高频来源（如自家站点 / 合作媒体）登记进了业务域名，把域名填在这里即可自动内嵌。
   *
   * 只填主域名，不要带协议、路径与 www（example.com 同时命中 news.example.com 这类子域）。
   */
  webviewDomains: localConfig.webviewDomains,

  /** 调试开关（取值见 src/config/local.ts；仓库默认五项全 false，上线前必须保持） */
  debug: localConfig.debug
} as const
