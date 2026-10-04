import { z } from 'zod'
import { cloud, isCloudConfigured } from './cloud'
import { diagLog } from './workbuddy-cloud-diagnostics'

/**
 * LLM 调用封装（阶段 3 起全项目共用）。
 *
 * SDK 契约（G2 发现）：cloud.llm.chat.completions.create() 仅支持流式，
 * 返回 AsyncIterable<Chunk> —— 所有「要完整 JSON」的场景统一走
 * aggregateStream 聚合后解析（等价非流式，§3.5 的成本/正确性目标不变）。
 */

let cachedModel: string | null = null

/** 取可用模型（首个，带缓存）。models.list 失败时返回 null。 */
export async function getChatModel(): Promise<string | null> {
  if (cachedModel) return cachedModel
  if (!isCloudConfigured) return null
  try {
    const models = await cloud.llm.models.list()
    if (models.length > 0) {
      cachedModel = models[0].id
      diagLog('info', 'auth', `LLM 模型：${cachedModel}（共 ${models.length} 个可选）`)
      return cachedModel
    }
    return null
  } catch (err) {
    diagLog('error', 'auth', `llm.models.list 失败：${String(err)}`)
    return null
  }
}

/** 聚合流式 chunks 为完整文本 */
export async function aggregateStream(
  stream: AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>
): Promise<string> {
  let out = ''
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content
    if (typeof delta === 'string') out += delta
  }
  return out
}

/** 从模型输出中提取 JSON 文本（剥 markdown 代码栅栏、截取首尾大括号） */
export function extractJSONText(raw: string): string | null {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

export type ChatJSONResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * 调 LLM 并解析为 JSON（zod 校验）。
 * 非法 JSON / 校验失败自动重试一次（§2.4）；仍失败返回错误。
 */
export async function chatJSON<T>(
  system: string,
  user: string,
  schema: z.ZodType<T>,
  opts: { retries?: number } = {}
): Promise<ChatJSONResult<T>> {
  if (!isCloudConfigured) {
    return { ok: false, error: '云服务未配置（endpoint / publishableKey）' }
  }
  const model = await getChatModel()
  if (!model) {
    return { ok: false, error: '无可用 LLM 模型' }
  }

  const attempts = 1 + (opts.retries ?? 1)
  let lastError = 'LLM 输出无法解析为合法 JSON'
  for (let i = 0; i < attempts; i++) {
    try {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const stream = (cloud.llm.chat.completions.create as any)({
        model,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }) as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>
      const raw = await aggregateStream(stream)
      const jsonText = extractJSONText(raw)
      if (!jsonText) {
        lastError = 'LLM 输出不含 JSON'
        continue
      }
      const parsed = schema.safeParse(JSON.parse(jsonText))
      if (parsed.success) {
        return { ok: true, data: parsed.data }
      }
      lastError = `LLM 输出未过校验：${parsed.error.issues[0]?.message ?? '字段不合法'}`
      diagLog('warn', 'auth', `chatJSON 第 ${i + 1} 次输出不合法：${lastError}`)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      diagLog('warn', 'auth', `chatJSON 第 ${i + 1} 次调用失败：${lastError}`)
    }
  }
  return { ok: false, error: lastError }
}
