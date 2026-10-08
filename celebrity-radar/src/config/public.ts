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
 * 【llm.model】上游密钥由云函数 aiProxy 用环境变量代打
 *（DEEPSEEK_API_KEY / BOCHA_API_KEY），端上不再直连上游，故这里只留模型名，
 * 不留 baseURL / apiKey。
 *
 * 【调试开关】debug 的五个值同样取自 local.ts，**仓库默认五项全 false**：
 * 四个 disable* 都会放大成本（免费层限流、提问额度与 429 冷却同时失效），
 * 只在本地联调时置 true。逐项说明见 local.example.ts。
 *
 * 配套：云端需先建好 users 集合，权限设为「仅创建者可读写」
 *（这是客户端能取到自己 _openid 的唯一途径）。字段由首次登录自动写入，无需手工建。
 */
import { localConfig } from './local'

export const publicConfig = {
  /** CloudBase 环境 ID（微信云开发 → 环境 ID）；取值见 src/config/local.ts */
  cloudbaseEnvId: localConfig.cloudbaseEnvId,

  /** LLM 通道：端上只读模型名，请求由 cloudfunctions/aiProxy 代发 */
  llm: {
    /**
     * 默认模型名。云函数侧有同名常量（aiProxy 的 LLM_MODEL），作为「端上没带模型名」时的兜底，
     * 改动需同步，否则端上判定的「可用」与云函数实际调用的模型会不一致。
     */
    model: 'deepseek-v4-flash',

    /**
     * 可选模型清单（M7-4「模型选择」）。
     *
     * 端上「我的 → 生成模型」按此渲染选项，用户选择只存本机 storage（见 utils/settings.ts），
     * 生成时由 utils/llm.ts 随请求带给 aiProxy，云函数按传入的模型名调用上游 OpenAI 兼容端点。
     *
     * ⚠ 这里的 id 必须是上游真实存在的模型名（默认端点见 aiProxy 的 LLM_BASE_URL），
     * 填错只会在生成时报上游错误；清单可随上游上新自行增删，无需改端上代码。
     * 第一项即默认：须与上面的 llm.model 一致（用户未选择时展示并实际使用的就是它）。
     *
     * memberOnly（「质」权益，2026-10-07）：true = 仅会员可用。免费用户即使本机存了该档位的
     * 偏好，utils/llm.ts#resolveChatModel 也会回落到默认模型，「我的」页对应项加锁标。
     * ⚠ 改这一列必须同步 cloudfunctions/aiProxy 的 MEMBER_ONLY_MODELS —— 那份才是计费闸门：
     * 端上判定只影响展示与请求值，改包即可绕过；云函数那份才决定上游真用哪个模型。
     */
    models: [
      {
        id: 'deepseek-v4-flash',
        label: '极速版',
        desc: '响应最快、成本最低，适合日常生成报告',
        memberOnly: false
      },
      {
        id: 'deepseek-v4',
        label: '标准版',
        desc: '质量与速度均衡，长文更完整',
        memberOnly: true
      },
      {
        id: 'deepseek-reasoner',
        label: '深度推理',
        desc: '推理更强、耗时更长，适合深度分析',
        memberOnly: true
      }
    ]
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
