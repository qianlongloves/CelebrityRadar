/**
 * 非敏感公共配置（§3.8）：可进包。
 * 用户级 Tavily key 一律只存本地 storage（src/utils/ 下读取），严禁写入本文件。
 */
export const publicConfig = {
  /** WorkBuddy 云服务 endpoint（阶段 2 替换为真实值） */
  endpoint: 'https://REPLACE_ME.example.com',
  /** WorkBuddy publishableKey（阶段 2 替换为真实值；SDK 强校验 wbpk_ 前缀，占位值保持该前缀避免构造抛错） */
  publishableKey: 'wbpk_REPLACE_ME',
  /** 云服务 applicationId（方案 §七） */
  applicationId: 'wbapp_HiLJGZwGoeXSW1X2mHZ9Wy'
} as const
