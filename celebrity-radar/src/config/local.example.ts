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
 *
 * ## 订阅消息模板：三个 ID 怎么来（2026-10-09 补）
 *
 * 端上三处推送入口各要一枚**独立**模板，两个地方各填一次（两端必须同模板）：
 *
 * | 用途             | 端上字段             | 云函数环境变量           | 定时任务                |
 * | ---------------- | -------------------- | ------------------------ | ----------------------- |
 * | 关注更新提醒     | `subscribeTemplateId`| `SUBSCRIBE_TEMPLATE_ID`  | notifyFollowUpdates 09:00 |
 * | 关键词舆情预警   | `alertTemplateId`    | `ALERT_TEMPLATE_ID`      | keywordAlert 09:20      |
 * | 名人风险提醒     | `riskTemplateId`     | `RISK_TEMPLATE_ID`       | riskWatch 09:40         |
 *
 * 步骤：
 *
 * 1. 公众平台 → 功能 → 订阅消息 → 公共模板库，挑字段是 `thing1`（提醒内容，≤20 字）
 *    + `date2`（时间）的那一类模板。**选三次**，拿到三个不同的模板 ID
 *    —— 可以标题相同，但不能是同一个 ID（原因见下方 `alertTemplateId`）。
 * 2. 把三个 ID 填进 `localConfig`。这几个值会被编进包，**改完必须重新编译**
 *    （`npm run build:weapp`），热更新不生效。
 * 3. 云开发控制台 → 云函数 → 各自的「环境变量」，按上表填同名模板 ID。
 *    漏填不会报错也不阻断：云函数只跳过推送、把原因写进 `summary.skipped`。
 * 4. 真机跑一次：登录后点三处入口的授权按钮，确认 `users` 表对应行的
 *    `subscribe_ok` / `alert_ok` / `risk_ok` 已置 true —— 定时任务只给 true 的用户发。
 *
 * 三个 ID 全留空**不是坏状态**：端上只保留站内提醒（数据照样落库、预警页看得到），
 * 只是不渲染授权按钮（见 `notify.ts` 里的三个 `*NotifyConfigured()`；模板没申请就摆按钮，
 * 点下去必然失败）。授权为什么必须按模板分开，见 `utils/notify.ts` 顶部注释。
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
   *
   * ⚠ 这四个只放开**端上**的闸门，不顶替云端：生成 / 提问 / 缓存写口在 aiProxy 入口
   *   还会各判一次（计数由端上照旧 consume，debug 下照样涨到上限）。所以它们全开，
   *   生成报告时仍可能被云函数回「今日额度已用完」。本地联调请**两边同时放开**：
   *   云函数环境变量 `AI_PROXY_QUOTA_GUARD=off`，具体语义见
   *   `cloudfunctions/aiProxy/quota.config.js#quotaGuardDisabled`（默认 on、只认 off）。
   */
  disableGenerateQuota: boolean
  disableAskQuota: boolean
  disableRefreshQuota: boolean
  disableCooldown: boolean
  rawIoLog: boolean
  /**
   * 强制会员身份（**仅本地调试**，2026-10-09 补）。
   *
   *   'off'      不覆写，按云端 users.membership 的真实发货结果判定（仓库默认）
   *   'free'     强制按免费版（真实身份是会员时也能测免费档体验）
   *   'monthly'  强制按月度会员 ┐
   *   'quarterly' 强制按季度会员 ├ 三个 plan id 与云函数 payCreate 的 PLANS 同名
   *   'annual'   强制按年度会员 ┘
   *
   * 为什么需要它：会员行为有一半只在**会员**身上出现（报告页三段专享内容、专享段剥离、
   * 免费档刷新冷却是否被绕过、每日 30 次的上限文案与各处的会员卡），而 users.membership
   * 只由微信支付回调云函数 payCallback 写入 —— 没接商户号就永远测不到会员态，
   * 于是「付费功能无法自测」。开这个开关，改一行、重编译即可切换身份。
   *
   * ⚠ 它只覆写**端上**的判定（utils/member.ts#readMemberState 的最外层），
   *   不写数据库，**云端一概不认**。后果分两边，测试时别搞混：
   *
   *   · 强制为会员：端上按会员走（30 次上限、专享段可见、冷却绕过），
   *     但云函数 aiProxy 仍按真实身份**钳制检索条数并回落极速版模型**，
   *     quotaGuard 也仍按真实身份复核「会员补齐免计费」—— 所以
   *     **「加厚检索」与「会员档位模型」这两件事测不出来**，
   *     要看真实产物只能去改云端的 membership 字段。
   *     另：此时**不要测支付** —— utils/pay.ts 靠「expires_at 是否变晚」确认发货，
   *     覆写后它恒定不变，会一直等到超时。
   *
   *   · 强制为免费：端上按免费走，云端仍按真实身份计数（上限 30 也不会被端上拦），
   *     测免费档体验时反而不容易误触上限。
   */
  memberOverride: 'off' | 'free' | 'monthly' | 'quarterly' | 'annual'
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
   * 订阅消息模板 ID（名人风险监控，第 1 期）。
   * **又得是一枚独立的模板**：现在有三个定时任务（notifyFollowUpdates 09:00 /
   * keywordAlert 09:20 / riskWatch 09:40），三枚模板三位授权，任何两个共用都会互相吃授权。
   * 云函数侧同名环境变量 `RISK_TEMPLATE_ID`。空串 = 未配置：
   * 此时只做站内预警（信号照样落库，进预警页看得到），不出现授权按钮。
   */
  riskTemplateId: string

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
  riskTemplateId: '',
  webviewDomains: [],
  debug: {
    disableGenerateQuota: false,
    disableAskQuota: false,
    disableRefreshQuota: false,
    disableCooldown: false,
    rawIoLog: false,
    /* 会员身份覆写：仓库默认不覆写（按云端真实发货结果判定） */
    memberOverride: 'off'
  }
}
