import { callCloudFunction } from './cloud'

/**
 * 云函数通道（平台代付模式）的连通性探测。
 *
 * 与「本机 key 直连」是两条独立链路：本机不配任何 key 时，这条也应能测通，
 * 因为 key 在服务端。返回值刻意是可读文本行，和页面上的本机测试拼在一起显示。
 */

export interface ProxyProbeItem {
  configured: boolean
  length: number
  ok: boolean
  detail: string
}

export interface ProxyProbeResult {
  ok: boolean
  checked_at?: string
  model?: string
  bocha?: ProxyProbeItem
  llm?: ProxyProbeItem
  error?: string
}

function lineOf(label: string, item?: ProxyProbeItem): string {
  if (!item) return `${label}：云函数未返回该项结果`
  if (!item.configured) return `${label}：未配置环境变量`
  return `${label}：${item.ok ? '可用' : '失败'} —— ${item.detail}`
}

/**
 * 探测云函数通道。失败不抛：测试入口不应因某一条通道没部署，
 * 就把另一条通道的结果也吞掉。
 */
export async function probeAiProxy(): Promise<string[]> {
  try {
    const res = (await callCloudFunction('aiProxy', { action: 'test' })) as ProxyProbeResult | null
    if (!res) return ['云函数通道：调用成功但无返回值']
    if (res.error) return [`云函数通道：${res.error}`]
    return [lineOf('云函数·博查', res.bocha), lineOf('云函数·大模型', res.llm)]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not found|FunctionName|-501000/i.test(msg)) {
      return ['云函数通道：aiProxy 未部署（在 cloudfunctions/aiProxy 上右键「上传并部署」）']
    }
    return [`云函数通道：${msg}`]
  }
}
