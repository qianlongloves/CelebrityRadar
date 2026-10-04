import type { MiniProgramWxLike, WxRequestOptions, WxRequestTask } from '@tencent-ai/workbuddy-cloud-sdk/miniprogram'

/** 诊断事件（阶段 2 #3：云 SDK 请求/失败/耗时的结构化日志） */
export interface DiagEvent {
  ts: number
  level: 'info' | 'warn' | 'error'
  tag: 'http' | 'storage' | 'auth' | 'db'
  message: string
  detail?: Record<string, unknown>
}

const MAX_EVENTS = 200
const events: DiagEvent[] = []

/** 供「我的 → 诊断信息」页或调试控制台读取最近事件 */
export function getCloudDiagnostics(): readonly DiagEvent[] {
  return events
}

export function diagLog(
  level: DiagEvent['level'],
  tag: DiagEvent['tag'],
  message: string,
  detail?: Record<string, unknown>
): void {
  events.push({ ts: Date.now(), level, tag, message, detail })
  if (events.length > MAX_EVENTS) events.shift()
  const line = `[cloud:${tag}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * 包装 wx：给云 SDK 注入一个带耗时/状态码/错误日志的 wx 替身。
 * 仅包装 SDK 实际用到的四个方法（MiniProgramWxLike 契约）。
 */
export function createDiagnosticWx(wxLike: MiniProgramWxLike): MiniProgramWxLike {
  return {
    request(options: WxRequestOptions): WxRequestTask {
      const startedAt = Date.now()
      const method = options.method || 'GET'
      const url = options.url
      const isStream = options.enableChunked === true
      return wxLike.request({
        ...options,
        success: (res) => {
          const cost = Date.now() - startedAt
          if (res.statusCode >= 400) {
            diagLog('warn', 'http', `${method} ${url} -> ${res.statusCode}（${cost}ms）`, {
              status: res.statusCode,
              costMs: cost
            })
          } else {
            diagLog('info', 'http', `${method}${isStream ? '(SSE)' : ''} ${url} -> ${res.statusCode}（${cost}ms）`)
          }
          options.success?.(res)
        },
        fail: (err) => {
          const cost = Date.now() - startedAt
          diagLog('error', 'http', `${method} ${url} 失败：${err.errMsg}`, { costMs: cost, errMsg: err.errMsg })
          options.fail?.(err)
        }
      })
    },
    getStorageSync: (key: string) => wxLike.getStorageSync(key),
    setStorageSync: (key: string, value: unknown) => {
      try {
        wxLike.setStorageSync(key, value)
      } catch (err) {
        diagLog('error', 'storage', `setStorageSync(${key}) 失败`, { err: String(err) })
      }
    },
    removeStorageSync: (key: string) => wxLike.removeStorageSync(key)
  }
}
