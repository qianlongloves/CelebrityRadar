/**
 * 本地配置模板 —— 可进包，但不含任何真实值。
 *
 * ## 用法
 *
 * ```bash
 * cp src/config/local.example.ts src/config/local.ts
 * ```
 *
 * 然后把 `cloudbaseEnvId` 换成你自己的云开发环境 ID
 * （微信开发者工具 → 工具栏「云开发」→ 环境 ID，形如 `celebrity-radar-1a2b3c4d`），
 * 该环境须与 `project.config.json` 里的 appid 归属同一个小程序。
 *
 * ## 为什么单开一个文件
 *
 * 环境 ID、订阅模板 ID 与本地调试开关都是「跟机器走、不跟代码走」的值：
 * 仓库里留真实值，fork 者会直接连上原作者的云环境；而作者本地为放开额度
 * 把 `debug` 置 true 的改动，混在 `public.ts` 里也总有误提交的风险。
 * 抽到 `local.ts` 并由 .gitignore 忽略后，两边互不干扰。
 *
 * ⚠ `local.ts` 必须存在：`src/config/public.ts` 直接 import 它，
 *    未复制时编译会报 `Cannot find module './local'`。
 */
export interface LocalDebugFlags {
  /**
   * 四个 disable* 都会**放大成本**（限流、额度与冷却同时失效），只在本地联调时置 true：
   *   disableGenerateQuota  放开「免费 3 次 / 会员 30 次」的每日生成闸门
   *   disableAskQuota       放开「免费 5 次 / 会员 30 次」的每日提问闸门
   *   disableRefreshQuota   放开关注流「每日 10 次」的刷新闸门
   *   disableCooldown       放开 10 分钟上游限流冷却（搜索源与大模型共用）
   * rawIoLog 只影响控制台噪音（上游原始报文），不改变任何行为。
   *
   * **仓库默认五项全 false** —— 这是「别人 clone 下来直接跑」时唯一安全的取值。
   */
  disableGenerateQuota: boolean
  disableAskQuota: boolean
  disableRefreshQuota: boolean
  disableCooldown: boolean
  rawIoLog: boolean
}

export interface LocalConfig {
  /**
   * CloudBase 环境 ID。
   *
   * 保持占位串 `REPLACE_ME` = 未配置：此时 `utils/cloud.ts#isCloudConfigured` 为 false，
   * 登录与全部 DB 调用不会发起（页面给明确提示，而不是静默报错或白屏）。
   */
  cloudbaseEnvId: string

  /**
   * 订阅消息模板 ID（关注更新提醒）。
   * 微信公众平台 → 功能 → 订阅消息 → 公共模板库选用；云函数侧同名环境变量
   * `SUBSCRIBE_TEMPLATE_ID` 必须指向同一个模板。空串 = 未配置。
   */
  subscribeTemplateId: string

  /**
   * 订阅消息模板 ID（关键词舆情预警）。
   * **必须与 subscribeTemplateId 是不同的模板**：一次性订阅的授权按模板消耗，
   * 两个定时任务共用一枚模板会互相吃掉授权位（后者必得 43101）。
   * 云函数侧同名环境变量 `ALERT_TEMPLATE_ID`。空串 = 未配置。
   */
  alertTemplateId: string

  /**
   * 业务域名白名单（原文预览页可内嵌的站点）。
   * 只填主域名，不带协议/路径/www；默认留空 = 全部走「素材预览卡 + 复制链接」降级路径。
   */
  webviewDomains: string[]

  /** 本地调试开关，逐项说明见 LocalDebugFlags */
  debug: LocalDebugFlags
}

export const localConfig: LocalConfig = {
  cloudbaseEnvId: 'REPLACE_ME',
  subscribeTemplateId: '',
  alertTemplateId: '',
  webviewDomains: [],
  debug: {
    disableGenerateQuota: false,
    disableAskQuota: false,
    disableRefreshQuota: false,
    disableCooldown: false,
    rawIoLog: false
  }
}
