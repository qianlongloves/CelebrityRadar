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

/**
 * 云客户端（auth / database / storage / llm 四模块）。
 *
 * 重要：SDK 构造函数会强校验配置（endpoint 绝对 URL / publishableKey wbpk_ 前缀），
 * 非法配置在模块加载时直接 throw —— 会让 app.js 整体加载失败、小程序白屏。
 * 因此这里 try/catch + 兜底对象：任何配置错误都不阻断启动，
 * 错误延后到首次真正调用 cloud.* 时以可读信息抛出（由各业务路径的 catch 接住）。
 */
let cloudInitError: string | null = null

let cloudInstance: ReturnType<typeof createMiniProgramWorkBuddyCloud> | null = null
try {
  cloudInstance = createMiniProgramWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
    ...(rawWx ? { wx: createDiagnosticWx(rawWx) } : {})
  })
} catch (err) {
  cloudInitError = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

function throwUnconfigured(): never {
  throw new Error(
    `云服务不可用：${cloudInitError ?? 'endpoint / publishableKey 未配置'}。` +
      '请在 src/config/public.ts 填入真实值（publishableKey 需 wbpk_ 开头）后重新构建。'
  )
}

/** 未配置/配置非法时的兜底：属性访问即抛可读错误，替代真客户端 */
const unconfiguredCloud = {
  get auth() {
    return throwUnconfigured()
  },
  get database() {
    return throwUnconfigured()
  },
  get llm() {
    return throwUnconfigured()
  },
  get storage() {
    return throwUnconfigured()
  }
}

export const cloud = (cloudInstance ?? unconfiguredCloud) as ReturnType<
  typeof createMiniProgramWorkBuddyCloud
>

export type CloudClient = ReturnType<typeof createMiniProgramWorkBuddyCloud>

/** 诊断：配置异常信息（「我的」页登录失败提示用） */
export function cloudInitErrorMessage(): string | null {
  return cloudInitError
}
