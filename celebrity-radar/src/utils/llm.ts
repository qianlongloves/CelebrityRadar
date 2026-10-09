import { z } from 'zod'
import { publicConfig } from '@/config/public'
import type { LlmProvider, LlmTier } from '@/config/public'
import { getPreferredProvider, getPreferredTier } from './settings'
import { diagLog } from './cloud-diagnostics'
import { debugRaw } from './debug'
import { callCloudFunction, cloudTimeoutHint, isCloudConfigured } from './cloud'
import { readMemberState } from './member'

/**
 * LLM 调用封装（阶段 3 起全项目共用）。
 *
 * **单一通道**：云函数代理（平台代付），见 cloudfunctions/aiProxy 的 'chat'。
 * key 只存在云函数环境变量里，客户端不持有任何密钥，用户零配置。
 *
 * 曾经并列存在过「本机 Key 直连」通道（BYOK，Taro.request 直打上游），已整体移除，
 * 理由见下方 chatOnce 上方的说明。search.ts 的博查通道同步做了同样的收敛，
 * 全项目只剩一种模式，用户不必理解「该填 key 还是靠平台」。
 *
 * 端点走 **OpenAI 兼容协议**：CloudBase 不托管大模型，由 aiProxy 拼 /chat/completions。
 * 用哪家、用哪一档由 resolveChatSelection() 统一裁决（M7-4 / 2026-10-08 供应商自选）：
 * 本机偏好（「我的 → 模型供应商 / 生成档位」所选）优先，否则回落 publicConfig.llm.provider
 * 与他家的 fast 档。两个值都随请求带给云函数，由**云端**那家的 key 代打
 * （云函数只在端上没带 / 带了不认识的 id 时才用 LLM_PROVIDER 兜底，见 llm.config.js 的 resolveLlm）。
 * 取非流式完整响应：少一层聚合、失败语义更清晰。
 * extractJSONText 等纯函数与原实现一致，上层解析行为不变。
 */

/**
 * 失败分支带 retryable：调用方（report.ts）据此决定是否进入冷却——
 * 限流 / 网络 / 上游 5xx 值得等一等；密钥/额度类配置错误重试无意义，
 * 冷却只会让用户修好配置后还白等 10 分钟。
 */
export type ChatJSONResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; retryable?: boolean }

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/**
 * 单次尝试的结果：失败时标明「是否值得重试」，交由上层唯一的重试循环裁决。
 *
 * ok 分支带上 `finishReason`（上游原样回传）：`'length'` = 输出撞上 max_tokens 被截断。
 * 报告是长 JSON，截断必然解析失败 —— 而**原样重发同一请求只会再次撞上同一个上限**，
 * 白白多等一整轮生成（约 30~40s）。故把这一信号交给 chatJSON，让它据此放弃重试、
 * 直接走快速降级（见 chatJSON 里那段）。非长生成的调用方可以忽略它。
 */
type ChatAttempt =
  | { ok: true; content: string; finishReason?: string }
  | { ok: false; error: string; retryable: boolean }

/**
 * 云通道的超时在云函数内控制（见 aiProxy 的 LLM_CHAT_TIMEOUT_MS），端上已无直连超时。
 * 但那只管「上游多慢算慢」，管不住**函数自己被平台掐断**：函数的执行超时若短于上游超时
 * （微信云开发默认 20 秒，且 config.json 不生效，须在控制台改），长生成会在中途被杀，
 * 端上只能拿到 -504003 —— 识别与指引见 utils/cloud.ts#cloudTimeoutHint。
 */

/** 云函数 chat 动作的返回结构（对应 cloudfunctions/aiProxy 的 handleChat） */
interface ProxyChatResult {
  ok: boolean
  content?: string
  model?: string
  /** 云函数把会员专属档位降级成默认模型时置 true（非会员请求了强模型，见 aiProxy 的会员闸门） */
  downgraded?: boolean
  /**
   * 上游的 finish_reason 原样回传（见 aiProxy 的 handleChat）。'length' = 输出撞上 max_tokens 被截断，
   * 报告这类长 JSON 一旦被截断就会解析失败、整份降级成纯文本（表现是卡片成批消失），
   * 所以它是这里唯一值得端上专门记一笔的字段。
   */
  finishReason?: string
  kind?: string
  error?: string
}

/** 值得重试的 kind：上游 5xx / 网络层失败。与 search.ts 的 RETRYABLE_KINDS 同构 */
const RETRYABLE_KINDS = new Set(['upstream', 'network'])

/** 已被显式提取的字段，兜底摊平时跳过，避免重复 */
const ERR_TEXT_FIELDS = ['message', 'errMsg', 'errCode']

/** 摊平单个字段值：对象序列化，其余 String()，序列化失败也给个标记而不是抛错 */
function flatValue(v: unknown): string {
  if (v === undefined || v === null) return String(v)
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v) ?? String(v)
    } catch {
      return '[unserializable]'
    }
  }
  return String(v)
}

/**
 * 提取错误文本。
 *
 * 微信云调用的失败对象把有用信息分在两处：`message` 常常只有
 * `cloud.callFunction:fail Error:` 这个前缀就断了，真正能定位问题的
 * `errMsg` / `errCode`（-501000 函数不存在、-404011 函数执行错误…）挂在对象字段上。
 *
 * 最坏的情况是 message 与 errMsg 填的是**同一个**字符串、且以「...fail Error:」草草收尾——
 * 光看去重后的结果就是一句「看不出所以然」的失败，排查只能靠猜。所以下面加了一道兜底：
 * 结果以 `Error:` 收尾（即冒号后没有内容）时，把其余自有字段全部摊平带上。
 * 宁可日志长一点，也要让失败自己说清原因。
 */
function errText(err: unknown): string {
  if (typeof err === 'string') return err
  if (!err || typeof err !== 'object') return String(err)

  const src = err as Record<string, unknown>
  const parts: string[] = []
  const msg = typeof src.message === 'string' ? src.message : ''
  if (msg) parts.push(msg)
  const errMsg = typeof src.errMsg === 'string' ? src.errMsg : ''
  if (errMsg && errMsg !== msg) parts.push(errMsg)
  if (src.errCode !== undefined && src.errCode !== null) parts.push(`errCode=${String(src.errCode)}`)

  const joined = parts.join(' | ')
  if (/Error:\s*$/.test(joined) || !parts.length) {
    const extra = Object.getOwnPropertyNames(src)
      .filter((k) => !ERR_TEXT_FIELDS.includes(k))
      .map((k) => `${k}=${flatValue(src[k])}`)
      .join(' ')
    if (extra) return `${joined || 'unknown'} | ${extra}`
  }
  return parts.length ? joined : flatValue(err)
}

/**
 * 是否有可用大模型通道。只剩云函数代理一条，故这里只反映「云环境 ID 配了没」——
 * 函数是否真部署好、所选供应商的 key 环境变量是否真配了，只有调一次才知道。
 * 调用方用它避免「明明能用却被前置判断拦下」，真失败由 chatOnce 的返回值兜住。
 */
export function hasLlmChannel(): boolean {
  return isCloudConfigured
}

/** 一次生成实际会用的「供应商 + 档位 + 模型名」（设置页展示与请求取值共用同一份判定） */
export interface ChatSelection {
  /** 供应商 id（config/public.ts 的 llm.providers 里的某个 id） */
  provider: string
  /** 该供应商的展示名（设置页显示「当前」用） */
  providerLabel: string
  /** 档位标识：fast / standard / reason */
  tier: string
  /** 档位展示名：极速版 / 标准版 / 深度推理 */
  tierLabel: string
  /** 实际会带给云函数的模型名 */
  model: string
  /** 该模型是否会员专属（true 且非会员时，上面几项已是**回落**后的结果，不是用户选的那个） */
  memberOnly: boolean
}

/** 按 id 取供应商；找不到（没选过 / 已被运营下线）返回默认那家（providers[0]） */
function pickProvider(id: string | null): LlmProvider {
  const hit = id !== null ? publicConfig.llm.providers.find((p) => p.id === id) : undefined
  return (hit ?? publicConfig.llm.providers[0]) as LlmProvider
}

/**
 * 当前生效的「供应商 + 档位」（M7-4「模型选择」，2026-10-08 起由用户自选供应商），同步版：
 * 设置页展示与请求取值共用同一判定。
 *
 * 顺序：本机偏好（「我的 → 模型供应商 / 生成档位」里选的）→ 公共配置默认值
 * （llm.provider + 他家的 fast 档）。用户选的档位存的是**档位标识**而不是模型名，
 * 所以换供应商时档位跟着走（deepseek 标准版 → 通义千问标准版），不必让用户重选一次。
 *
 * 四道关卡：
 *   ① 供应商偏好只有在仍存在于 llm.providers 清单里时才生效 —— 运营把某家下线后
 *      （或用户装的是另一份配置），设备上残留的旧选择不能再被带上，否则会稳定地生成失败
 *      且用户看不出为什么；档位偏好同理（找不到就回落该家的 fast 档）；
 *   ② 那家必须真的有这个档位：清单里没有该 tier 时回落 fast 档（fast 档是每家的兜底，
 *      config/public.ts 里约定它恒为 memberOnly=false）；
 *   ③ 标了 memberOnly 的档位只有会员能用（「质」权益，2026-10-07）—— 非会员一律回落该家
 *      的 fast 档，这样「设置页显示哪档 = 实际用哪档」的承诺对免费用户同样成立；
 *   ④ 会员态由**调用方传入**：本函数必须同步（设置页要同步渲染），而读库是异步的，
 *      调用方各自已在同一份数据上判过会员（设置页用配额卡那次读数、chatViaPlatform 用
 *      readMemberState），这里不再多读一次库。
 *
 * ⚠ 端上这一层只管「展示与请求值」，是**可被改包绕过**的；真正的闸门在云函数 aiProxy
 * （llm.config.js 的 memberOnlyModels，非会员请求强模型会被静默降级），两处口径必须一致。
 */
export function resolveChatSelection(member: boolean): ChatSelection {
  const provider = pickProvider(getPreferredProvider())
  const tiers = provider.models as readonly LlmTier[]
  const fallback = tiers[0]
  const wanted = getPreferredTier()
  const hit = (wanted !== null ? tiers.find((m) => m.tier === wanted) : undefined) ?? fallback
  const usable = hit.memberOnly && !member ? fallback : hit
  return {
    provider: provider.id,
    providerLabel: provider.label,
    tier: usable.tier,
    tierLabel: usable.label,
    model: usable.id,
    memberOnly: usable.memberOnly
  }
}

/**
 * 当前生效的模型名（只要模型名时的入口；与 resolveChatSelection 同源，判定逻辑不重复一份）。
 * 保留它是因为「档位」是 2026-10-08 才引入的概念 —— 少数只关心模型名的调用方不必跟着改。
 */
export function resolveChatModel(member: boolean): string {
  return resolveChatSelection(member).model
}

/**
 * 一次读库拿「供应商 + 模型名」：供应商与模型档位由本机偏好 + 会员态裁决
 * （resolveChatSelection 必须同步，故会员态在函数内读出再传入）。
 *
 * 这里多一次 users 读是刻意的：请求值和设置页展示必须出自同一套判定，
 * 否则会出现「设置页写着极速版、实际发的是深度推理」这种查不出来的错位。
 * 读库失败按非会员处理（readMemberState 的口径）—— 宁可这一次降级，也不给非会员放行强模型。
 *
 * 2026-10-08：不再往请求体里带 deep（输出上限对所有人一样，见 aiProxy 的 chatMaxTokens）——
 * 会员态在这里只剩「选哪一档模型」这一个用途，云函数那边的会员闸门照旧拦模型档位。
 *
 * 占位模型名（REPLACE_ME）视为不可用，返回 null 交给云函数退回它自己的常量
 * （只对模型名做这个兜底：供应商 id 认不出时 cloud 侧自会回落它自己的默认家）。
 */
export async function resolveChatTarget(): Promise<{
  provider: string
  model: string | null
}> {
  const member = (await readMemberState()).member
  const sel = resolveChatSelection(member)
  return { provider: sel.provider, model: !sel.model || sel.model.includes('REPLACE_ME') ? null : sel.model }
}

/** 取模型名（只关心模型时的入口；与 resolveChatTarget 同源，判定逻辑不重复一份） */
export async function getChatModel(): Promise<string | null> {
  return (await resolveChatTarget()).model
}

/*
 * 这里曾有一条「本机 Key 直连」通道（BYOK，Taro.request 直打 publicConfig.llm.baseURL），
 * 与云函数代理并列、运行时按「本机有没有 key」择优。已整体移除，原因：
 *   ① 单一通道 = 单一心智：用户不必理解「我该填 key 还是靠平台」，失败时也只有一条排查路径；
 *   ② 直连要求每个使用者自备 DeepSeek key，等于把门槛转嫁给用户，产品无法对外发布；
 *   ③ 长生成在端上虽无超时/载荷上限，但云函数已按同一口径验证过容量
 *      （MAX_CHAT_CHARS=24000，实测报告 prompt ≤1.6w 字，余量 8000），够用。
 * 随之退役的还有一处真实踩过的坑：本机 key 含中文时，wx 的 setRequestHeader 会抛
 * 「String contains non ISO-8859-1 code point」——key 不再由端上持有，此类问题从根上消失。
 */

/**
 * 唯一的 LLM 通道：云函数代理（平台代付）。
 * 客户端不持有任何 key，大模型由 aiProxy 用服务端环境变量代打。
 *
 * 原先返回 null 表示「这条通道没准备好，请走本机直连」；本机通道移除后没有备选，
 * 于是「未就绪」不能再静默降级，必须变成一句能照着操作的报错（见下方两个分支）。
 */
async function chatViaPlatform(messages: ChatMessage[]): Promise<ChatAttempt> {
  const { provider, model } = await resolveChatTarget()
  const startedAt = Date.now()
  let res: ProxyChatResult | null
  try {
    res = (await callCloudFunction('aiProxy', {
      action: 'chat',
      /*
       * 供应商与模型名都取自同一次判定（resolveChatTarget）：用户选的供应商在这里生效，
       * 由云函数用**那家**的环境变量 key 代打（端上不持有任何 key）。
       * 云函数只在端上没带、或带了个它不认识的 id 时才用它的 LLM_PROVIDER 兜底（见 llm.config.js）。
       */
      provider,
      model: model ?? undefined,
      messages
    })) as ProxyChatResult | null
  } catch (err) {
    /* 整体打印原始错误对象：对象上可能还有 errText 未覆盖的链路侧字段 */
    debugRaw('llm:proxy:err', err)
    const msg = errText(err)
    diagLog('warn', 'llm', `平台大模型调用失败：${msg}`)
    /*
     * 云函数执行超时（-504003）是被平台在函数外掐断的，函数没机会回 kind / error，
     * 故这里必须单独认一次：它既不是上游故障也不是网络抖动，重试必定再撞同一道墙
     * （还白等一个超时周期、并把 10 分钟冷却也点着），所以 retryable=false + 可照做的指引。
     * 识别口径统一收在 utils/cloud.ts#cloudTimeoutHint。
     */
    const timeoutHint = cloudTimeoutHint(msg)
    if (timeoutHint) return { ok: false, error: timeoutHint, retryable: false }
    /*
     * 只剩一条通道，「函数没部署」不再是「该走另一条路」的降级信号，
     * 而是必须让开发者看见并照着修的部署问题 —— 给一句可操作的指引，而不是把原因吞掉。
     * 另注：入参过大被链路拒绝、网络故障，都走下面的透传分支（retryable=true）。
     */
    if (/not found|FunctionName|-501000/i.test(msg)) {
      return {
        ok: false,
        error: '云函数 aiProxy 未部署：请在 cloudfunctions/aiProxy 上右键「上传并部署」',
        retryable: false
      }
    }
    return { ok: false, error: `平台大模型调用失败：${msg}`, retryable: true }
  }

  const elapsedMs = Date.now() - startedAt
  /* 调试打印：云函数 chat 动作的完整返回（content 即模型正文，可能较长） */
  debugRaw('llm:proxy', res)
  if (!res || res.ok !== true) {
    /*
     * 「通道未就绪」的三种成因现在都必须变成可照做的报错（原先是静默降级到本机通道）：
     *   函数没部署（callCloudFunction 已抛错，见上）、函数在但环境变量没配（unconfigured）、
     *   函数是只认 test/search 的旧版（返回「未知 action」——需重新部署云函数）。
     */
    if (!res || res.kind === 'unconfigured' || res.error?.includes('未知 action')) {
      const why = res?.error ?? '云函数无返回值'
      diagLog('warn', 'llm', `平台大模型通道未就绪：${why}`)
      return {
        ok: false,
        error: `平台大模型通道未就绪：${why}（需部署 aiProxy 并配置大模型环境变量，见 llm.config.js）`,
        retryable: false
      }
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
    /* downgraded 记进 meta：出现「会员说切了深度推理但报告很快」时，一眼能看出是服务端降级 */
    /* finishReason 记进 meta：被截断（length）与正常结束（stop）在日志里要分得开 */
    {
      model: res.model,
      downgraded: !!res.downgraded,
      finishReason: res.finishReason || '',
      elapsedMs,
      outputChars: content.length
    }
  )
  /*
   * 截断了要单独喊一声：JSON 长生成被截断不会报「太长」，而是解析失败 → 整份降级成纯文本，
   * 用户看到的是「报告页一堆卡片没了」。这行 warn 让这类失败在诊断日志里一眼认出来，
   * 不必再从「卡片消失」倒推原因（上限值见 aiProxy 的 chatMaxTokens）。
   */
  if (res.finishReason === 'length') {
    diagLog(
      'warn',
      'llm',
      `输出被上游截断（finish_reason=length，${content.length}字）：长 JSON 会解析失败并整份降级`,
      { model: res.model, outputChars: content.length }
    )
  }
  return { ok: true, content, finishReason: res.finishReason }
}

/**
 * 单次非流式对话。只剩云函数代理一条通道，故不再需要任何通道择优。
 *
 * 刻意不抛异常：失败以 { ok: false, retryable } 返回，让「要不要再试一次」只有一个裁决点
 * （chatJSON 的重试循环），而不是散在两层里各判一次。
 */
async function chatOnce(messages: ChatMessage[]): Promise<ChatAttempt> {
  return chatViaPlatform(messages)
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
    return { ok: false, error: '大模型通道不可用：云环境未配置（见 public.ts 的 cloudbaseEnvId）' }
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
 *
 * **截断例外（本轮，耗时优化 P0）**：上游把 `finish_reason` 回传成 `'length'` 时，
 * 说明这次输出是撞上 max_tokens 被**切断**的。此时原样重发同一请求几乎必然再次撞上
 * 同一道上限 —— 重试不是「再试一次运气」，而是**白等一整轮生成**（报告这类长生成约 30~40s），
 * 两次都失败后还要再走一次降级调用，最坏把一次失败放大成三次往返。
 * 故一旦本次输出被截断且解析失败，就**不再重试**（retryable=false，直接交给上层降级）。
 * 注意：截断的输出仍先尝试解析 —— 偶发情况下截断点恰好落在合法闭合处，能救则救。
 */
export async function chatJSON<T>(
  system: string,
  user: string,
  schema: z.ZodType<T>,
  opts: { retries?: number } = {}
): Promise<ChatJSONResult<T>> {
  if (!hasLlmChannel()) {
    return { ok: false, error: '大模型通道不可用：云环境未配置（见 public.ts 的 cloudbaseEnvId）' }
  }

  const attempts = 1 + (opts.retries ?? 1)
  let lastError = 'LLM 输出无法解析为合法 JSON'
  let lastRetryable = true // 解析/校验失败默认可重试（换一次采样可能就过了）
  for (let i = 0; i < attempts; i++) {
    /* 本次尝试是否被上游截断；截断导致的失败一律不再重试（理由见上方注释） */
    let truncated = false
    try {
      const attempt = await chatOnce([
        { role: 'system', content: system },
        { role: 'user', content: user }
      ])
      if (!attempt.ok) {
        lastError = attempt.error
        lastRetryable = attempt.retryable
        diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次调用失败：${lastError}`)
        /* 密钥无效 / 额度不足这类错误，重试也是同样的结果，早点收手省一次往返 */
        if (!attempt.retryable) break
        continue
      }
      truncated = attempt.finishReason === 'length'
      const jsonText = extractJSONText(attempt.content)
      if (!jsonText) {
        lastError = 'LLM 输出不含 JSON'
        if (truncated) return truncatedFail(lastError)
        continue
      }
      const parsed = schema.safeParse(JSON.parse(jsonText))
      if (parsed.success) {
        return { ok: true, data: parsed.data }
      }
      lastError = `LLM 输出未过校验：${parsed.error.issues[0]?.message ?? '字段不合法'}`
      diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次输出不合法：${lastError}`)
      if (truncated) return truncatedFail(lastError)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      lastRetryable = true
      diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次调用失败：${lastError}`)
      if (truncated) return truncatedFail(lastError)
    }
  }
  return { ok: false, error: lastError, retryable: lastRetryable }
}

/**
 * 截断失败的统一出口：记一笔诊断（便于在日志里把「撞上限」与「解析/校验不过」分开），
 * 并以 retryable=false 返回 —— 让上层的重试循环立刻收手，直接走降级或报错。
 */
function truncatedFail(error: string): ChatJSONResult<never> {
  diagLog('warn', 'llm', `输出被上游截断，不再重试（重发同一请求只会再撞上限）：${error}`)
  return { ok: false, error, retryable: false }
}
