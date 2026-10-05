/** 诊断事件（阶段 2 #3：云请求/失败/耗时的结构化日志） */
export interface DiagEvent {
  ts: number
  level: 'info' | 'warn' | 'error'
  tag: 'http' | 'storage' | 'auth' | 'db' | 'llm'
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
