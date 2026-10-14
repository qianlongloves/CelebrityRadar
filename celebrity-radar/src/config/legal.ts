/**
 * 法务文案的版本元数据（**单一真源**）。
 *
 * 为什么单独抽一个文件：这两个日期有两个读者 ——
 *   ① 隐私与免责页（pages/agreement）展示「更新日期 / 生效日期」；
 *   ② 首次知情同意网关（utils/consent）拿「生效日期」当**同意版本号**：
 *      政策有实质变更时同步更新本文件，已同意旧版本的用户会被**重新征求同意**。
 * 两处必须同源，否则会出现「页面显示新版、网关却按旧版判定已同意」的静默背离。
 *
 * ⚠ 更新约定：修改 pages/agreement 的法务文案时，一并把下面的日期改成当天；
 *   `PRIVACY_CONSENT_VERSION` 自动跟随生效日期，无需单独维护。
 */

/** 文档更新日期（YYYY-MM-DD） */
export const PRIVACY_UPDATED_AT = '2026-10-14'

/** 文档生效日期（YYYY-MM-DD） */
export const PRIVACY_EFFECTIVE_AT = '2026-10-14'

/**
 * 知情同意的版本号 = 政策生效日期。
 *
 * 语义：用户同意的是「某一版政策」。版本号变化（政策实质更新）即视为未同意，
 * 网关会再次弹出征求同意 —— 这正是 PIPL「变更后需重新取得同意」的落地。
 */
export const PRIVACY_CONSENT_VERSION = PRIVACY_EFFECTIVE_AT
