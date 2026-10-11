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
 * 【llm】大模型调用统一走云函数 aiProxy 代打（默认云开发 AI，也可在云端配 DeepSeek /
 * 智谱 / Kimi 的 key），端上不直连上游、不持有任何厂商 key 或模型名，只上报
 * 「厂商 + 质量档」（见 llm.vendors / llm.qualities）；报告走结构化槽、问答走推理槽，
 * 槽位由云端按用途裁决（见 cloudfunctions/aiProxy/llm.config.js）。
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
 * 厂商清单（2026-10-12 v3：厂商维度回归，顺序即「我的」页展示顺序）。
 *
 * key 必须与云端 llm.config.js 的 VENDORS 键逐字一致；端上不持有 key / 端点 / 模型名。
 * 某家是否真的可用（云端配没配 *_API_KEY）不在这份静态清单里 —— 运行时从
 * aiProxy 的免口令 action:'vendors' 拉就绪状态，选择器只展示就绪厂商（cloudbase 恒在）。
 *
 * `icon` 是给「我的」页厂商卡片用的表情图标（项目无厂商 logo 资源、也不便引入品牌图），
 * 只影响展示，不参与任何路由 / 请求。
 */
const LLM_VENDORS = [
  { key: 'cloudbase', icon: '☁️', label: '云开发 AI', desc: '平台默认通道，零配置、开箱即用' },
  { key: 'deepseek', icon: '🐋', label: 'DeepSeek', desc: '深度求索，性价比与长文生成' },
  { key: 'zhipu', icon: '🧠', label: '智谱 GLM', desc: '智谱 AI，中文理解稳定' },
  { key: 'moonshot', icon: '🌙', label: 'Kimi', desc: '月之暗面，长文与深度推理' },
  { key: 'qwen', icon: '⚡', label: '通义千问', desc: '阿里云百炼，双模模型覆盖报告与问答' }
] as const

/** 单个厂商（key 是路由标识，label/desc 是给用户看的文案） */
export type LlmVendor = (typeof LLM_VENDORS)[number]

/**
 * 质量档清单（三档；key 必须与云端 llm.config.js 的 QUALITIES 一致）。
 *   basic    → 基础版（免费：memberOnly 必须为 false，也是兜底档）
 *   standard → 标准版（会员）
 *   premium  → 高级版（会员，各厂商旗舰）
 *
 * 用户选「厂商 + 质量档」两样；具体模型不由用户选 —— 报告 / 辅助走该档 structured 槽
 * （输出型），AI 问答走 reasoning 槽（推理型），槽位模型在云端 llm.config.js 的注册表里。
 * 某档缺某个能力槽时（如 Kimi 高级档没有非思考旗舰）云端在同厂商内向下降档并回执标记。
 *
 * ⚠ memberOnly 那一列必须与云端 llm.config.js 的 QUALITIES.memberOnly 一致 —— 端上这列只决定
 *   UI 与请求值（改包即可绕过），云函数那份才是计费闸门（非会员一律落基础档）。
 */
const LLM_QUALITIES = [
  { key: 'basic', label: '基础版', desc: '免费可用，响应快，覆盖日常报告与问答', memberOnly: false },
  { key: 'standard', label: '标准版', desc: '会员可用，长文更完整、问答思考更深', memberOnly: true },
  { key: 'premium', label: '高级版', desc: '会员可用，厂商旗舰模型，质量优先', memberOnly: true }
] as const

/** 单个质量档（key 是路由标识，label/desc 是给用户看的文案） */
export type LlmQuality = (typeof LLM_QUALITIES)[number]

export const publicConfig = {
  /** CloudBase 环境 ID（微信云开发 → 环境 ID）；取值见 src/config/local.ts */
  cloudbaseEnvId: localConfig.cloudbaseEnvId,

  /** LLM 通道：端上只上报「厂商 + 质量档」，请求由 cloudfunctions/aiProxy 代打 */
  llm: {
    /**
     * 默认厂商：本机没存偏好时的兜底；须与云端 llm.config.js 的 DEFAULT_VENDOR 一致。
     * 云开发 AI 零 key 恒在，故默认值永远选得到。
     */
    defaultVendor: 'cloudbase',

    /** 默认质量档：本机没存偏好时的兜底；须与云端 DEFAULT_QUALITY 一致（免费档）。 */
    defaultQuality: 'basic',

    /** 厂商清单（顺序即展示顺序；实际可选范围还要过运行时就绪状态，见 utils/llm.ts#listReadyVendors） */
    vendors: LLM_VENDORS,

    /**
     * 质量档清单（顺序即展示顺序）。
     * 档位标签与描述只此一处来源 —— pages/member 的权益对比表按 memberOnly 过滤推导。
     */
    qualities: LLM_QUALITIES
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
