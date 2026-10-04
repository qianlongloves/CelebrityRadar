import { createMiniProgramWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk/miniprogram'
import { publicConfig } from '@/config/public'
import { createDiagnosticWx } from './workbuddy-cloud-diagnostics'

/**
 * 云服务是否已配置（endpoint / publishableKey 仍是占位值时为 false）。
 * 未配置时登录与 DB 调用会失败，相关页面应给出明确提示而不是静默报错。
 */
export const isCloudConfigured =
  !publicConfig.endpoint.includes('REPLACE_ME') && !publicConfig.publishableKey.includes('REPLACE_ME')

const rawWx = typeof wx !== 'undefined' ? wx : undefined

/** 云客户端（auth / database / storage / llm 四模块） */
export const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  ...(rawWx ? { wx: createDiagnosticWx(rawWx) } : {})
})

export type CloudClient = typeof cloud
