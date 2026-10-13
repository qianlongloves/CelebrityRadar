/**
 * 非敏感公共配置（§3.8）：可进包。
 * 本项目不持有任何用户密钥 —— 搜索与大模型的 key 只存在于云函数环境变量里，
 * 客户端零配置（见 utils/llm.ts 与 utils/search.ts）。严禁把任何 key 写进本文件。
 *
 * 【哪些值不在这里】本地调试开关已抽到 **未跟踪** 的 `src/config/local.ts`：
 *
 *   webviewDomains / debug
 *
 * 仓库里只有 `local.example.ts`（值为占位串）。首次 clone 后先执行：
 *
 *   cp src/config/local.example.ts src/config/local.ts
 *
 * 【云开发环境 ID 也不在 local.ts（2026-10-13 起）】唯一真源是仓库根 `.env` 的 `TCB_ENV_ID`
 * （这个名字是 CloudBase CLI 的约定名 —— `cloudbaserc.json` 顶部 `envId` 也读它）：
 * 云端部署与端上构建读**同一份** `.env`，端上由 `config/index.js` 在构建期经 `defineConstants`
 * 注入（见下方 `__TCB_ENV_ID__`）。只填一处 ⇒ 端上连的环境与部署写的环境构造上一致，
 * 不会再出现「端上连 A、部署写 B」这种登录/读写全挂却毫无报错线索的情况。
 * 该环境须与 project.config.json 里的 appid 归属同一个小程序；未配置（空）时
 * isCloudConfigured 为 false，登录与全部 DB 调用不会发起（utils/cloud.ts 会报「未配置 TCB_ENV_ID」）。
 *
 * 【三个订阅模板 ID 也不在这里，也不在 local.ts】它们的**唯一真源同样也是仓库根 `.env`**
 * （`SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID`）：云端部署时
 * `cloudbaserc.json` 用 `{{env.X}}` 从 `.env` 取值注入云函数，端上则由 `config/index.js`
 * 在构建期读同一份 `.env` 并经 `defineConstants` 注入（见下方三个 `__*_TEMPLATE_ID__` 常量）。
 * 只填一处 ⇒ 端云构造上不可能不一致。
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
 * 编译期注入的常量（真源：仓库根 `.env`，见 `config/index.js` 的 defineConstants）：
 * 三个订阅消息模板 ID + 云开发环境 ID（TCB_ENV_ID）。
 *
 * `declare const` 只声明类型、不产生运行时代码；读取侧一律走
 * `typeof __X__ === 'undefined' ? '' : __X__` 守卫 —— 于是：
 *   · 正常构建：Taro 在打包时把这些标识符替换成 `.env` 里的字面值；
 *   · 单测等未经 Taro 打包的场景（tsc 直编）：标识符未注入，`typeof` 为 'undefined' → 退化为空串。
 * 两种情形都不会抛，故「陌生人 clone 后什么都不配也能编译通过」（环境 ID 为空时
 * 由 utils/cloud.ts 在运行期报表，而不是编译失败）。
 */
declare const __SUBSCRIBE_TEMPLATE_ID__: string
declare const __ALERT_TEMPLATE_ID__: string
declare const __RISK_TEMPLATE_ID__: string
declare const __TCB_ENV_ID__: string


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
  { key: 'cloudbase', icon: '🔵', label: '腾讯云', desc: '腾讯云，默认通道、零配置、开箱即用' },
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
  /**
   * CloudBase 环境 ID（微信云开发 → 环境 ID，形如 `cloud1-xxxxxxxx`）。
   *
   * **单一来源 = 仓库根 `.env` 的 `TCB_ENV_ID`**（构建期由 config/index.js 注入）。
   * 该名字是 CloudBase CLI 的约定名 —— `cloudbaserc.json` 的 `envId` 也读它，故端上
   * 连的环境与 `tcb fn deploy` 写的环境构造上一致。为空 = 云服务未配置（isCloudConfigured
   * 为 false，登录与全部 DB 调用不发起；utils/cloud.ts 报到「未配置 TCB_ENV_ID」）。
   */
  cloudbaseEnvId: typeof __TCB_ENV_ID__ === 'undefined' ? '' : __TCB_ENV_ID__,

  /** LLM 通道：端上只上报「厂商 + 质量档」，请求由 cloudfunctions/aiProxy 代打 */
  llm: {
    /**
     * 默认厂商：本机没存偏好时的兜底；须与云端 llm.config.js 的 DEFAULT_VENDOR 一致。
     * 腾讯云零 key 恒在，故默认值永远选得到。
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
   * **单一来源 = 仓库根 `.env` 的 `SUBSCRIBE_TEMPLATE_ID`**（构建期由 config/index.js 注入）。
   * 端上这里与云端云函数 notifyFollowUpdates 读的是**同一份 .env**：云端部署时
   * cloudbaserc.json 用 `{{env.SUBSCRIBE_TEMPLATE_ID}}` 取值，端上由 defineConstants 注入
   * —— 只填一处 ⇒ 构造上不可能不一致。
   *
   * **推送功能完整保留，此处为空只是因为当前部署环境未配置。**
   * 本仓库作者的小程序是个人主体、服务类目「机械电子产品」，微信公共模板库里拿不到可用模板，
   * 故仓库默认值一律留空串 —— 这是**当前部署环境的情况，不是功能被放弃**。任何部署者只要在自己的
   * 服务类目下能选到模板，按下面三步填上即可启用（代码通道一直完整保留，无需改业务代码）。
   *
   * 未配置（空串）时的行为：`notifyConfigured()` 为 false → 端上授权按钮不渲染、云函数
   * notifyFollowUpdates 定时任务只在回执 `skipped` 里写明「未配置 → 跳过推送」（不报错、不阻断
   * 站内数据落库）。**站内功能完全可用** —— 首页「舆情」入口红点、舆情页各块「新 N 条」、
   * 事件时间线 NEW 角标照常工作（口径统一在 utils/inbox.ts）。
   *
   * 如何启用（三步，缺一步都不行）：
   *   1. 微信公众平台 → 功能 → 订阅消息 → 公共模板库，按**自己的服务类目**挑一个同时含
   *      `thing1`（提醒内容，≤20 字符）+ `date2`（时间）的模板；**申请/选用三枚不同的模板**
   *      （关注更新 / 关键词预警 / 风险提醒各一枚，理由见下方 alertTemplateId）。
   *   2. 把三枚 ID 填进仓库根 `.env` 的 SUBSCRIBE_TEMPLATE_ID / ALERT_TEMPLATE_ID /
   *      RISK_TEMPLATE_ID（**只这一处**），再 `npm run build:weapp` 重新编译端上
   *      （这些值被编进包，热更新不生效），并重新部署三个云函数让环境变量生效。
   *   3. 真机点三处入口的授权按钮，确认 users 表对应行的
   *      subscribe_ok / alert_ok / risk_ok 置 true。
   *
   * 模板 ID 不是密钥（每个用户都能在小程序里看到），可以进包。端上读的是构建期注入的常量
   * （下方 `__SUBSCRIBE_TEMPLATE_ID__`），云端读的是同名环境变量 —— 同名同源，不会分叉。
   */
  subscribeTemplateId: typeof __SUBSCRIBE_TEMPLATE_ID__ === 'undefined' ? '' : __SUBSCRIBE_TEMPLATE_ID__,

  /**
   * 订阅消息模板 ID（关键词舆情预警，2026-10-08）。真源同订阅模板：`.env` 的 `ALERT_TEMPLATE_ID`。
   *
   * 与上面同属「功能完整保留、当前部署环境未配置」（原因见 subscribeTemplateId）。空串 = 未配置 →
   * `alertNotifyConfigured()` 为 false → 预警页不出现授权按钮，云函数 keywordAlert 只写站内预警、
   * 在回执 `skipped` 里写明「未配置 → 跳过推送」。**站内预警完全可用**（预警页照常看得到）。
   *
   * ⚠ 启用时的硬约束：**它必须与 subscribeTemplateId 是不同的模板** —— 微信「一次性订阅」的授权
   * 按**模板**消耗、且一次授权只够推一条，两个定时任务（notifyFollowUpdates 09:00 /
   * keywordAlert 09:20）若共用一枚模板与一个授权位，先跑的会把授权吃掉，后跑的必得 43101。
   */
  alertTemplateId: typeof __ALERT_TEMPLATE_ID__ === 'undefined' ? '' : __ALERT_TEMPLATE_ID__,

  /**
   * 订阅消息模板 ID（名人风险监控，第 1 期）。真源同订阅模板：`.env` 的 `RISK_TEMPLATE_ID`。
   *
   * 与上面同属「功能完整保留、当前部署环境未配置」（原因见 subscribeTemplateId）。空串 = 未配置 →
   * `riskNotifyConfigured()` 为 false → 不出现授权按钮，云函数 riskWatch 只落 risk_signals、
   * 在回执 `skipped` 里写明「未配置 → 跳过推送」。**站内部分完全可用**：「监控此人」照常可用、
   * 信号照常落库、预警页照常看得到，缺的只是那条微信推送。
   *
   * ⚠ 启用时的硬约束：**它得是第三枚独立模板**（三个定时任务 09:00 / 09:20 / 09:40 各用一枚，
   * 任何两个共用都会互相吃授权，理由同 alertTemplateId）。
   */
  riskTemplateId: typeof __RISK_TEMPLATE_ID__ === 'undefined' ? '' : __RISK_TEMPLATE_ID__,

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
