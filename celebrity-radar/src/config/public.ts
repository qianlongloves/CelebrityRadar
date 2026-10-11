/**
 * 非敏感公共配置（§3.8）：可进包。
 * 本项目不持有任何用户密钥 —— 搜索与大模型的 key 只存在于云函数环境变量里，
 * 客户端零配置（见 utils/llm.ts 与 utils/search.ts）。严禁把任何 key 写进本文件。
 *
 * 【哪些值不在这里】环境相关项与本地调试开关已抽到 **未跟踪** 的 `src/config/local.ts`：
 *
 *   cloudbaseEnvId / subscribeTemplateId / alertTemplateId / riskTemplateId / webviewDomains / debug
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
 * 【llm】大模型调用统一走微信云开发 AI（cloudfunctions/aiProxy 里用 cloud.ai），
 * 端上不再直连上游、也不再持有任何厂商 key 或模型名，只上报「档位」（见 llm.models）。
 * 2026-10-11 起**「供应商」维度整体移除**：只剩云开发 AI 一家，用户在「我的」页只选档位。
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
 * 生成档位清单（2026-10-11 改造：统一走微信云开发 AI，供应商维度整体移除）。
 *
 * 三档（tier 是档位标识，label 才是给用户看的名字）：
 *   fast     → 极速版   （免费档：memberOnly 必须为 false，它也是兜底档）
 *   standard → 标准版   （会员档）
 *   reason   → 深度推理 （会员档）
 * 用户只在「我的 → 生成档位」里选一档（不再选供应商：只剩云开发 AI 一家）。
 *
 * ⚠ tier 名字刻意不叫 deep：全项目另有一个 O-11「深度模式」（会员生成时素材加厚 + 多两段专享内容，
 *   见 utils/report.ts 的 memberNotes），那是**报告深度**，与本文件的**模型档位**是两件事。
 *
 * ── 端上有什么、没有什么（重要）────────────────────────────────
 * 端上**不持有任何厂商 key，也不再知道具体模型名**：请求只带档位（tier），由云函数 aiProxy
 * 用云开发 AI（cloud.ai）代打，具体模型名以云端 llm.config.js 的 TIERS 为准。
 * 因此这里没有 id / model 字段 —— 端上连模型名都不需要知道（这是 2026-10-11 改造的收敛点）。
 *
 * ⚠ memberOnly 那一列必须与云端 llm.config.js 的 TIERS.memberOnly 一致 —— 端上这列只决定 UI
 *   与请求值（改包即可绕过），云函数那份才是计费闸门。
 */
const LLM_TIERS = [
  { tier: 'fast', label: '极速版', desc: '响应最快、成本最低，适合日常生成报告', memberOnly: false },
  { tier: 'standard', label: '标准版', desc: '质量与速度均衡，长文更完整', memberOnly: true },
  { tier: 'reason', label: '深度推理', desc: '推理更强、耗时更长，适合深度分析', memberOnly: true }
] as const

/** 单个档位（tier 是档位标识，label/desc 是给用户看的文案） */
export type LlmTier = (typeof LLM_TIERS)[number]

export const publicConfig = {
  /** CloudBase 环境 ID（微信云开发 → 环境 ID）；取值见 src/config/local.ts */
  cloudbaseEnvId: localConfig.cloudbaseEnvId,

  /** LLM 通道：端上只上报档位，请求由 cloudfunctions/aiProxy 走云开发 AI（cloud.ai）代发 */
  llm: {
    /**
     * 默认档位：本机没存偏好时的兜底；须与云端 llm.config.js 的 DEFAULT_TIER 一致。
     * 生成时随请求带给云函数（云端只在端上没带 / 带了不认识的档位时才用它自己的兜底）。
     */
    tier: 'fast',

    /**
     * 档位清单（顺序即展示顺序）。
     *
     * 之所以保留这一份：档位标签与描述只需要一处来源 —— pages/member 的权益对比表与
     * utils/member.ts 的权益说明都按它推导（各自按 memberOnly 过滤），改档位文案不必改这些页面。
     */
    models: LLM_TIERS
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
   * 订阅消息模板 ID（名人风险监控，第 1 期）。
   *
   * **必须是第三枚独立模板**：现在有三个定时任务（notifyFollowUpdates 09:00 /
   * keywordAlert 09:20 / riskWatch 09:40），一次性订阅的授权按模板消耗，
   * 任何两个共用一枚模板就会「先跑的吃掉授权，后跑的必得 43101」。
   * 云函数侧读同名环境变量 RISK_TEMPLATE_ID，两边必须指向同一个模板。
   *
   * 字段要求与预警模板相同（thing1 + date2）。空串 = 未配置：此时「监控此人」
   * 照常可用（信号照样落库、预警页看得到），只是不出现推送授权按钮。
   */
  riskTemplateId: localConfig.riskTemplateId,

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
