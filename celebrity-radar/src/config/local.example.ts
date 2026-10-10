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
  /*
   * 这里**刻意没有**「强制会员身份」开关（曾名 memberOverride，2026-10-10 移除）。
   *
   * 它当时是用着很顺手：没接商户号也能让端上按会员走，看一眼专享段与会员档位。
   * 但它是**本机配置**，而会员身份的真源在云端 `memberships`（aiProxy 的档位与检索
   * 闸门、quotaGuard 的免计费复核都读它）—— 于是「端上按会员走、云端按免费算」
   * 成了默认状态：切了会员档位没效果、加厚检索没效果，界面却一切正常，极难排查。
   * 它同时让「谁是会员」在端上有了配置与数据库**两个来源**，本机把它留在 'monthly'
   * 还会连带把测试套件里的会员 / 配额用例带红（用例只能用 setDebugFlags 逐个关掉）。
   *
   * 现在端上只有**一个**来源：数据库 `users.membership`（读口唯一，见
   * utils/member.ts#readMemberState），它与权威表 memberships 由 payCallback **一次写入、
   * 内容一致**（用例 06 钉住）。要联调会员态，就照 payCallback 的样子**两处都插**：
   *
   *   users        行：`membership: { plan: 'monthly', expires_at: '<未来时间>' }` → 端上界面与配额
   *   memberships  行：`{ _id: '<openid>', plan: 'monthly', expires_at: '<未来时间>' }` → 云端闸门
   *
   * 两张表都写、值一致，端上与云端才会一致（到期判定都只认 `expires_at`）：
   *   · 只写 users       ⇒ 端上显示会员、云端按免费算（档位与加厚检索静默失效，就是旧开关的老毛病）
   *   · 只写 memberships ⇒ 云端会放行，但端上仍按免费显示（界面与权限对不上，更迷惑）
   * ⚠ memberships 客户端完全不可读写，只能在控制台 / 云函数里写 —— 这正是它当权威的原因。
   */
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
    rawIoLog: false
  }
}
