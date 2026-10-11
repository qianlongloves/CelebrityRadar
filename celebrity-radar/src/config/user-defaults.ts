/**
 * user-defaults.ts —— 用户个性化配置（`users.settings`）的**唯一真源**：默认值 / 键白名单 / 版本号。
 *
 * ## 它解决什么
 *
 * `users.settings` 这个字段一直存在（见 `cloudfunctions/dbInit/schema.js` 的 users.fields），
 * 但**从来没有人写过它** —— 首登只写一句 `settings: {}`，之后全项目再无一处更新。
 * 真正生效的偏好（生成档位）躺在本机 storage 里，于是「换台手机就回到出厂设置」，
 * 而云端读同一行时看到的是 `{}`，谁也说不清缺的键该是什么。
 * 默认值因此有了**第二个隐含真源**：端上插行时写一份，读的时候各自再猜一份。
 *
 * 现在默认值只在本文件写一次，两条路各自取用：
 *   - 端上：`utils/settings.ts` / `utils/auth.ts` 直接 import（webpack 打包进小程序）
 *   - 云端：`npm run config:sync` 生成 `cloudfunctions/userInit/user-defaults.config.js`
 *     （云函数 `userInit` 的 ensure / set 两个动作都从副本取值）
 *
 * ## 三条铁律（与 benefits.ts 同构，理由见那边的文件头）
 *
 * 1. **自包含**：不得 import 任何模块，只能由字面量组成 —— 同步脚本在 node 里
 *    转译并执行它，一旦出现 import / require 会直接报错停下。
 * 2. **只放数据**：不放函数、不放 `Date.now()`、不放计算结果（生成物是 JSON）。
 * 3. **改完必须同步**：`npm run config:sync`，然后 `npm test`（漏了同步用例会红）。
 *
 * ## ⚠ 什么东西**不许**放进来
 *
 * 只放「用户自己能决定的偏好」。任何**影响权限、额度、计费**的开关都不许进 settings ——
 * `users` 集合的权限是「仅创建者可读写」，端上能改自己那一行（schema.js 里
 * `membership` 之所以只是镜像、权威另存 `memberships`，就是这条理由）。
 * settings 一旦被云端当作权限依据，等于把判定交给客户端自证。
 * 云端（aiProxy / quotaGuard）**不得读 settings 做任何判定**，读它只允许用于
 * 「按用户偏好调整请求参数」（选哪家模型）这类无权限含义的用途。
 *
 * ## 为什么促销条关闭记忆（promo_dismissed）**不在这里**
 *
 * 它是本机的**展示策略记忆**（见 utils/member.ts，与文案、展示概率同属一套策略），
 * 不是用户对自己的配置：换台设备后重新出现一次、再关一次，代价是一下点击；
 * 而把它搬上云会让 `settings.ts` 与 `member.ts` 互相依赖（一个要读它的键名、
 * 一个要调它的推送），换来的只是省一次点击 —— 不划算，故留在本机。
 *
 * ## 加一个新配置项的正确姿势
 *
 *   1. 在 `SETTINGS_KEYS` 加键、在 `DEFAULT_USER_SETTINGS` 加同名默认值
 *   2. **抬高 `SETTINGS_VERSION`** —— 老用户的 `settings` 里没有这个键，
 *      靠版本号把「该补齐」这件事说清楚（`userInit` 的 ensure 会补，无需迁移脚本）
 *   3. `npm run config:sync` 刷新云端副本
 *   4. 端上读写走 `utils/settings.ts`（它是唯一写口，不要绕过它直写库）
 *   5. `npm test`
 */

/**
 * 配置结构版本号（单调递增的整数）。
 *
 * 作用：区分「老用户的行还没补齐」与「已经补齐」。`userInit` 的 ensure 在
 * `row.settings_version < SETTINGS_VERSION` 时把缺失的键补成默认值 —— 于是
 * 加配置项**不需要写迁移脚本**，存量用户下次登录/调用时自然补齐。
 *
 * 取值口径：只在 `SETTINGS_KEYS` / `DEFAULT_USER_SETTINGS` 发生变化时 +1。
 */
export const SETTINGS_VERSION = 1

/**
 * 允许出现在 `users.settings` 里的键（白名单，`userInit` 的 set 按它拒绝一切别的键）。
 *
 * 白名单而不是黑名单，是因为 settings 会在**云端**被 `userInit` 读-改-写：
 * 若允许任意键，端上就能往这一列里塞任意大小的数据（把 users 行变成免费网盘），
 * 也能塞进一个将来被某个读取方误当成开关的键。
 */
export const SETTINGS_KEYS = ['llm_provider', 'llm_tier'] as const

/**
 * 每个配置项的默认值。`null` = 「没选过」，读取方自行回落到默认值
 * （厂商回落 `publicConfig.llm.defaultVendor`、质量档回落 `defaultQuality`，见 `utils/llm.ts`）。
 *
 * ⚠ 键名与 `SETTINGS_KEYS` **必须一一对应**（用例逐字比对，少一个就红）：
 * 缺了键的默认值，ensure 就不知道该补什么，那个配置项会永远停在「缺失」。
 *
 * 口径说明：
 *   llm_provider  厂商标识（cloudbase / deepseek / zhipu / moonshot / qwen），**不是模型名**。
 *                 2026-10-12 v3 厂商维度回归后重新启用（见 utils/settings.ts）
 *   llm_tier      质量档标识（basic / standard / premium），**不是模型名** ——
 *                 具体模型名只有云端知道（llm.config.js 的厂商×档×能力槽矩阵），端上不持有也不上报
 */
export const DEFAULT_USER_SETTINGS = {
  llm_provider: null,
  llm_tier: null
} as const
