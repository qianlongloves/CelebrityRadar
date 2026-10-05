import { z } from 'zod'
import Taro from '@tarojs/taro'
import { publicConfig } from '@/config/public'
import { diagLog } from './cloud-diagnostics'
import { getLlmKey } from './settings'
import { callCloudFunction, isCloudConfigured } from './cloud'

/**
 * LLM 调用封装（阶段 3 起全项目共用）。
 *
 * 两条通道，择优其一（与 utils/search.ts 的博查通道完全同构）：
 *   ① 本机 Key 直连 —— BYOK，费用自负，开发与内测用；
 *   ② 云函数代理   —— 平台代付，见 cloudfunctions/aiProxy 的 'chat'，用户零配置。
 * 有本机 Key 就走 ①，否则走 ②，于是「报告能不能生成」不再取决于用户是否自己有 key。
 *
 * 迁移说明：WorkBuddy 托管 LLM（cloud.llm，且仅支持流式），CloudBase 无等价能力，
 * 故走 **OpenAI 兼容端点**（publicConfig.llm.baseURL）。两条通道都取非流式完整响应：
 * 少一层聚合、失败语义更清晰。extractJSONText 等纯函数与原实现一致，上层解析行为不变。
 */

export type ChatJSONResult<T> = { ok: true; data: T } | { ok: false; error: string }

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** 单次尝试的结果：失败时标明「是否值得重试」，交由上层唯一的重试循环裁决 */
type ChatAttempt = { ok: true; content: string } | { ok: false; error: string; retryable: boolean }

/** 本机直连的超时；云通道的超时在云函数内控制（见 aiProxy 的 LLM_CHAT_TIMEOUT_MS） */
const LOCAL_TIMEOUT_MS = 60000

/** 云函数 chat 动作的返回结构（对应 cloudfunctions/aiProxy 的 handleChat） */
interface ProxyChatResult {
  ok: boolean
  content?: string
  model?: string
  kind?: string
  error?: string
}

/** 值得重试的 kind：上游 5xx / 网络层失败。与 search.ts 的 RETRYABLE_KINDS 同构 */
const RETRYABLE_KINDS = new Set(['upstream', 'network'])

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 是否有可用大模型通道：本机 Key（BYOK）或平台代付（云函数代理）。
 *
 * 只做保守估计 —— 云函数是否真部署好、环境变量是否真配了，只有调一次才知道。
 * 调用方用它避免「明明能用却被前置判断拦下」，真失败由 chatOnce 的返回值兜住。
 */
export function hasLlmChannel(): boolean {
  return getLlmKey() !== null || isCloudConfigured
}

/** 取模型名（来自公共配置；占位值视为不可用） */
export async function getChatModel(): Promise<string | null> {
  const m = publicConfig.llm.model
  return !m || m.includes('REPLACE_ME') ? null : m
}

/**
 * 通道一：本机 Key 直连（BYOK）。
 *
 * 计时不是调试噪音，是决策依据：报告正文属长生成，单次耗时直接决定它能否搬进云函数
 * （云函数 60s 是硬上限，还含冷启动）。usage 里的 completion_tokens 可反推输出速度 tok/s，
 * 便于外推「其他长度的报告要多久」，而不是只得到一个孤立的秒数。
 *
 * 与通道二的关键差别：这里能拿到 HTTP 状态码与 usage，故「值不值得重试」在此判定；
 * 云通道的对应信息已被 aiProxy 消化成 kind。
 */
async function chatViaLocalKey(apiKey: string, messages: ChatMessage[]): Promise<ChatAttempt> {
  const model = await getChatModel()
  if (!model) {
    return { ok: false, error: '未配置 LLM 模型名（public.ts 的 llm.model）', retryable: false }
  }

  const url = `${publicConfig.llm.baseURL.replace(/\/+$/, '')}/chat/completions`
  const startedAt = Date.now()
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let res: any
  try {
    res = await Taro.request({
      url,
      method: 'POST',
      timeout: LOCAL_TIMEOUT_MS,
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      data: { model, stream: false, messages }
    })
  } catch (err) {
    const msg = errText(err)
    diagLog('warn', 'llm', `本机直连网络失败：${msg}`)
    return { ok: false, error: msg, retryable: true }
  }

  const elapsedMs = Date.now() - startedAt
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0)

  if (res.statusCode < 200 || res.statusCode >= 300) {
    diagLog(
      'warn',
      'llm',
      `本机直连失败 HTTP ${res.statusCode}（耗时 ${(elapsedMs / 1000).toFixed(1)}s）`
    )
    return {
      ok: false,
      error: `LLM HTTP ${res.statusCode}：${JSON.stringify(res.data).slice(0, 200)}`,
      /* 401 密钥无效 / 402 余额不足 / 429 限流，重试也是同样结果，只有 5xx 值得再打一次 */
      retryable: res.statusCode >= 500
    }
  }

  const body = res.data
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    return { ok: false, error: 'LLM 返回结构异常（缺少 choices[0].message.content）', retryable: true }
  }

  const usage = body?.usage
  const tokens = usage?.completion_tokens
  const tokPerSec = tokens && elapsedMs > 0 ? (tokens / (elapsedMs / 1000)).toFixed(1) : '?'
  /*
   * 数字全部写进 message：diagLog 的 console 输出只打 message，不展开 detail，
   * 关键结论塞进 detail 等于在 Console 里看不见。
   */
  diagLog(
    'info',
    'llm',
    `chatOnce(本机) ${(elapsedMs / 1000).toFixed(1)}s 入${usage?.prompt_tokens ?? '?'}/出${tokens ?? '?'}tokens ${tokPerSec}tok/s 输出${content.length}字`,
    {
      model,
      elapsedMs,
      promptChars,
      promptTokens: usage?.prompt_tokens,
      completionTokens: tokens,
      outputChars: content.length
    }
  )
  return { ok: true, content }
}

/**
 * 通道二：云函数代理（平台代付）。客户端不持有任何 key，大模型由 aiProxy 用服务端环境变量代打。
 *
 * 返回 null = 「这条通道不存在」，与 search.ts 的降级语义一致：函数没部署（-501000）、
 * 云环境没配、或函数部署了但环境变量为空，都属于「平台没把这条通道准备好」，
 * 不该让用户看到一句像是故障的报错。
 */
async function chatViaPlatform(messages: ChatMessage[]): Promise<ChatAttempt | null> {
  const model = await getChatModel()
  const startedAt = Date.now()
  let res: ProxyChatResult | null
  try {
    res = (await callCloudFunction('aiProxy', {
      action: 'chat',
      /* 模型名与端上公共配置同源，传空则云函数用自己那份常量 */
      model: model ?? undefined,
      messages
    })) as ProxyChatResult | null
  } catch (err) {
    diagLog('warn', 'llm', `平台大模型通道不可用：${errText(err)}`)
    return null
  }

  const elapsedMs = Date.now() - startedAt
  if (!res || res.ok !== true) {
    /*
     * 三种「通道未就绪」都不是大模型故障，统一降级，避免甩给用户一句无从下手的报错：
     *   函数没部署（callCloudFunction 已抛错，见上）、函数在但额度没配（unconfigured）、
     *   函数是只认 test/search 的旧版（返回「未知 action」——需重新部署云函数）。
     */
    if (!res || res.kind === 'unconfigured' || res.error?.includes('未知 action')) {
      diagLog('warn', 'llm', `平台大模型通道未就绪：${res?.error ?? '云函数无返回值'}`)
      return null
    }
    const msg = res.error || '平台大模型调用失败'
    const kind = res.kind ?? ''
    diagLog('warn', 'llm', `平台大模型失败（${kind}）：${msg}`)
    return { ok: false, error: msg, retryable: RETRYABLE_KINDS.has(kind) }
  }

  const content = typeof res.content === 'string' ? res.content : ''
  if (!content.trim()) return { ok: false, error: '大模型返回为空', retryable: true }

  diagLog(
    'info',
    'llm',
    `chatOnce(平台) ${(elapsedMs / 1000).toFixed(1)}s 输出${content.length}字`,
    { model: res.model, elapsedMs, outputChars: content.length }
  )
  return { ok: true, content }
}

/**
 * 单次非流式对话，按通道择优其一。
 *
 * 刻意不抛异常：失败以 { ok: false, retryable } 返回，让「要不要再试一次」只有一个裁决点
 * （chatJSON 的重试循环），而不是散在两层里各判一次。
 */
async function chatOnce(messages: ChatMessage[]): Promise<ChatAttempt> {
  const apiKey = getLlmKey()
  if (apiKey) return chatViaLocalKey(apiKey, messages)

  const viaPlatform = await chatViaPlatform(messages)
  if (viaPlatform === null) {
    return {
      ok: false,
      error:
        '大模型通道不可用：本机未配置 Key，平台通道也未就绪（需部署云函数 aiProxy 并配置 DEEPSEEK_API_KEY）',
      retryable: false
    }
  }
  return viaPlatform
}

/** 聚合流式 chunks（保留：仍有个别调用方按流式契约组织数据） */
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

/**
 * 纯文本生成（无 JSON 约束）：报告降级路径用（§5.4 用例 9）。
 * 失败即失败（调用方已重试过 JSON 路径，不再叠加重试）。
 */
export async function chatText(
  system: string,
  user: string
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!hasLlmChannel()) {
    return { ok: false, error: 'LLM 未配置（本机 Key 与平台通道均不可用）' }
  }
  const attempt = await chatOnce([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ])
  if (!attempt.ok) return { ok: false, error: attempt.error }
  const text = attempt.content.trim()
  if (!text) return { ok: false, error: 'LLM 返回为空' }
  return { ok: true, text }
}

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
  if (!hasLlmChannel()) {
    return { ok: false, error: 'LLM 未配置（本机 Key 与平台通道均不可用）' }
  }

  const attempts = 1 + (opts.retries ?? 1)
  let lastError = 'LLM 输出无法解析为合法 JSON'
  for (let i = 0; i < attempts; i++) {
    try {
      const attempt = await chatOnce([
        { role: 'system', content: system },
        { role: 'user', content: user }
      ])
      if (!attempt.ok) {
        lastError = attempt.error
        diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次调用失败：${lastError}`)
        /* 密钥无效 / 额度不足这类错误，重试也是同样的结果，早点收手省一次往返 */
        if (!attempt.retryable) break
        continue
      }
      const jsonText = extractJSONText(attempt.content)
      if (!jsonText) {
        lastError = 'LLM 输出不含 JSON'
        continue
      }
      const parsed = schema.safeParse(JSON.parse(jsonText))
      if (parsed.success) {
        return { ok: true, data: parsed.data }
      }
      lastError = `LLM 输出未过校验：${parsed.error.issues[0]?.message ?? '字段不合法'}`
      diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次输出不合法：${lastError}`)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次调用失败：${lastError}`)
    }
  }
  return { ok: false, error: lastError }
}
