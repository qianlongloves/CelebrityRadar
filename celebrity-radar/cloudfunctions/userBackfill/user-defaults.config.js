/**
 * user-defaults.config.js —— **自动生成，请勿手改**。
 *
 * 真源：src/config/user-defaults.ts
 * 生成：npm run config:sync（或 node scripts/sync-config.js）
 * 校验：npm run config:check（tests/cases 里的 sync 用例会跑它）
 *
 * 为什么是副本而不是引用：云函数各自独立打包上传（cloudbaserc.json 逐个声明），
 * 且云环境里 require 不到端上的 TS —— 只能把真源序列化成本地文件一起上传。
 * 手改本文件会在下次 config:sync 时被覆盖，且 config:check 会报红。
 */

module.exports = {
  "SETTINGS_VERSION": 1,
  "SETTINGS_KEYS": [
    "llm_provider",
    "llm_tier"
  ],
  "DEFAULT_USER_SETTINGS": {
    "llm_provider": null,
    "llm_tier": null
  }
}
