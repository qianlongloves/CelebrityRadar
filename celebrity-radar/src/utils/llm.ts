import { z } from 'zod'
import { publicConfig } from '@/config/public'
import type { LlmTier } from '@/config/public'
import { getPreferredTier } from './settings'
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
 * 端点：云端走**微信云开发 AI**（cloud.ai），端上只上报**档位**（fast / standard / reason）——
 * 端上既不持有 key、也不知道具体模型名（见 cloudfunctions/aiProxy 的 handleChat / llm.config.js）。
 * 用哪一档由 resolveChatSelection() 统一裁决（2026-10-11 起供应商维度整体移除）：
 * 本机偏好（「我的 → 生成档位」所选）优先，否则回落 publicConfig.llm.tier 那一档；
 * 会员专属档位对非会员回落到 fast 档。云函数只在端上没带 / 带了不认识的档位时才用 LLM_TIER 兜底。
 * 取非流式完整响应（云函数侧用 streamText 双流取回正文与 finish_reason，端上仍是完整正文）：
 * 少一层聚合、失败语义更清晰。
 * JSON 的提取与解析见下方 parseModelJson（2026-10-10 重写：字符串感知扫描 + 畸形修复 +
 * 三类失败分流），上层拿到的仍是「校验通过的 data」，解析层的行为对调用方透明。
 */

/**
 * 失败分支带 retryable：调用方（report.ts）据此决定是否进入冷却——
 * 限流 / 网络 / 上游 5xx 值得等一等；密钥/额度类配置错误重试无意义，
 * 冷却只会让用户修好配置后还白等 10 分钟。
 */
export type ChatJSONResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; retryable?: boolean; kind?: string }

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
  | { ok: false; error: string; retryable: boolean; kind?: string }

/**
 * 这次 chat 属于哪个配额池 —— 云端闸门据此取上限（见 aiProxy/quota.config.js）。
 * 缺省 `'generate'`（最严的一池）：调用方漏传时宁可少给，不可默默多给。
 *
 * `'aux'` = 辅助调用（消歧、选题等发生在生成**之前**的小请求）：**不占产品额度**，
 * 只受防滥用限速约束。不单开这一档的话，免费用户把生成额度用完后会连「输入名字时
 * 的候选消歧」都点不动 —— 那是被自己的额度锁在门外。
 */
export type QuotaPurpose = 'generate' | 'ask' | 'aux'

/**
 * 云通道的时限在云函数内控制（见 aiProxy 的 CHAT_DEADLINE_MS / AUX_CHAT_DEADLINE_MS），端上已无直连超时。
 * 但那只管「上游多慢算慢」，管不住**函数自己被平台掐断**：函数的执行超时若短于那道时限
 * （微信云开发默认 20 秒，且 config.json 不生效，须在控制台改 —— 上限就是 60 秒），长生成会在中途被杀，
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
 * 函数是否真部署好、云开发 AI 是否已开通，只有调一次才知道。
 * 调用方用它避免「明明能用却被前置判断拦下」，真失败由 chatOnce 的返回值兜住。
 */
export function hasLlmChannel(): boolean {
  return isCloudConfigured
}

/** 一次生成实际会用的「档位」（设置页展示与请求取值共用同一份判定） */
export interface ChatSelection {
  /** 档位标识：fast / standard / reason */
  tier: string
  /** 档位展示名：极速版 / 标准版 / 深度推理 */
  tierLabel: string
  /** 该档是否会员专属（true 且非会员时，上面两项已是**回落**后的结果，不是用户选的那个） */
  memberOnly: boolean
}

/**
 * 当前生效的「档位」（2026-10-11 起供应商维度整体移除，端上只选档），同步版：
 * 设置页展示与请求取值共用同一判定。
 *
 * 顺序：本机偏好（「我的 → 生成档位」里选的 tier）→ 公共配置默认档（llm.tier）。
 * 用户选的存的是**档位标识**（fast / standard / reason），不是模型名 ——
 * 端上连模型名都不知道，具体模型名由云端 llm.config.js 按档位决定。
 *
 * 三道关卡：
 *   ① 档位偏好只有在仍存在于 llm.models 清单里时才生效 —— 运营改名或下架某档后
 *      （或用户装的是另一份配置），设备上残留的旧选择不能再被带上，否则会稳定地生成失败
 *      且用户看不出为什么；
 *   ② 标了 memberOnly 的档位只有会员能用（「质」权益，2026-10-07）—— 非会员一律回落
 *      fast 档，这样「设置页显示哪档 = 实际用哪档」的承诺对免费用户同样成立；
 *   ③ 会员态由**调用方传入**：本函数必须同步（设置页要同步渲染），而读库是异步的，
 *      调用方各自已在同一份数据上判过会员（设置页用配额卡那次读数、chatViaPlatform 用
 *      readMemberState），这里不再多读一次库。
 *
 * ⚠ 端上这一层只管「展示与请求值」，是**可被改包绕过**的；真正的闸门在云函数 aiProxy
 * （llm.config.js 的 TIERS.memberOnly，非会员请求会员档会被静默降级），两处口径必须一致。
 */
export function resolveChatSelection(member: boolean): ChatSelection {
  const tiers = publicConfig.llm.models as readonly LlmTier[]
  const fallback = tiers[0]
  const wanted = getPreferredTier()
  const hit = (wanted !== null ? tiers.find((m) => m.tier === wanted) : undefined) ?? fallback
  const usable = hit.memberOnly && !member ? fallback : hit
  return {
    tier: usable.tier,
    tierLabel: usable.label,
    memberOnly: usable.memberOnly
  }
}

/**
 * 一次读库拿「本次生成用哪一档」：档位由本机偏好 + 会员态裁决
 * （resolveChatSelection 必须同步，故会员态在函数内读出再传入）。
 *
 * 这里多一次 users 读是刻意的：请求值和设置页展示必须出自同一套判定，
 * 否则会出现「设置页写着极速版、实际发的是深度推理」这种查不出来的错位。
 * 读库失败按非会员处理（readMemberState 的口径）—— 宁可这一次降级，也不给非会员放行会员档。
 *
 * 不再往请求体里带 deep（输出上限对所有人一样，见 aiProxy 的 chatMaxTokens）；
 * 端上也不再上报模型名 —— 只带 tier，具体模型由云端 llm.config.js 按档位（+ 环境变量覆盖）决定。
 */
export async function resolveChatTarget(): Promise<{ tier: string }> {
  const member = (await readMemberState()).member
  return { tier: resolveChatSelection(member).tier }
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
async function chatViaPlatform(messages: ChatMessage[], purpose: QuotaPurpose): Promise<ChatAttempt> {
  const { tier } = await resolveChatTarget()
  const startedAt = Date.now()
  /*
   * 调试打印：本次调用的**完整入参**（档位 / purpose / system 与 user 两条消息）。
   *
   * 与下方 `llm:proxy`（返回）配对 —— 排查「这份报告为什么长这样」时只有返回不够：
   * 同一句返回可能是提示词不同、模型档位不同、或 purpose 让它走了另一个额度池。
   * messages 里是完整的 system + user（含全部素材），几万字交给 Console 折叠展开，
   * 比截断成一行有用得多（与 debugRaw 的设计一致）。
   *
   * 开关是 `config/local.ts` 的 `debug.rawIoLog`（默认 false）：**不改变任何行为**，
   * 只影响控制台噪音。
   */
  debugRaw('llm:proxy:req', { tier, purpose, messages })
  let res: ProxyChatResult | null
  try {
    res = (await callCloudFunction('aiProxy', {
      action: 'chat',
      /*
       * 档位取自同一次判定（resolveChatTarget）：用户在「我的」页选的档在这里生效，
       * 由云函数按档位决定具体模型并走云开发 AI 代打（端上不持有任何 key、也不知道模型名）。
       * 云函数只在端上没带、或带了个它不认识的档位时才用它的 LLM_TIER 兜底（见 llm.config.js）。
       */
      tier,
      /*
       * purpose 决定云端闸门按哪一池算上限（见 aiProxy/quota.config.js）：报告生成与
       * AI 提问是两个独立额度池，云端判上限时必须知道这一趟属于哪一池。
       */
      purpose,
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
        error: `平台大模型通道未就绪：${why}（需部署 aiProxy，且 wx-server-sdk ≥ 4.0.1 以支持云开发 AI，见 llm.config.js）`,
        retryable: false
      }
    }
    const msg = res.error || '平台大模型调用失败'
    const kind = res.kind ?? ''
    diagLog('warn', 'llm', `平台大模型失败（${kind}）：${msg}`)
    /*
     * kind 一并回传：调用方要据此认出「云端配额闸门拦下」（kind='quota'）——
     * report.ts 收到它必须**跳过纯文本降级**，否则降级那次调用会被同一道闸门再拦一次，
     * 白多等一轮往返，还把一个「额度用完」写成「生成失败」。
     * `upstream_quota`（上游自己欠费 / 403，P2-9）是**另一件事**：处置同为「不降级」，
     * 但文案必须保持上游原文，不能与用户的额度混为一谈。
     */
    return { ok: false, error: msg, retryable: RETRYABLE_KINDS.has(kind), kind }
  }

  const content = typeof res.content === 'string' ? res.content : ''
  if (!content.trim()) {
    return { ok: false, error: '大模型返回为空', retryable: true, kind: 'empty' }
  }

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
async function chatOnce(messages: ChatMessage[], purpose: QuotaPurpose): Promise<ChatAttempt> {
  return chatViaPlatform(messages, purpose)
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

/* ===== 模型输出的 JSON 提取与容错解析（2026-10-10 重写） =====
 *
 * 起点是一个真实故障：博查与上游大模型都成功返回了正文，报告页却是「结构化生成暂不可用」
 * 的纯文本简版。原因在这条链上——只要 `JSON.parse` 抛一次错，chatJSON 就重试一次，两次都抛
 * 就整份降级；而**失败原因被压成一句话**，日志里分不出是「模型没按格式答」「语法畸形」
 * 还是「撞上限被砍断」，三种成因的处置又完全不同。
 *
 * 故这里换掉原来的 `indexOf('{') + lastIndexOf('}')`：那对「值里带大括号」与「被截断」
 * 两种情形都会取错 ——
 *   · 值里写了 `{}`（例如标题是「《某某》{上下}」）时，lastIndexOf('}') 会落进字符串内部，
 *     截出来的片段缺尾括号，必解析失败（表现就是「有正文却解析不出」）；
 *   · 被上游截断时压根没有尾括号，于是报成「不含 JSON」，与「模型没按格式输出」混为一谈，
 *     重试还白等一整轮（报告一次 30~40s）。
 * 故改为**字符串感知**的配对扫描 + 只在原样解析失败后进行的**确定性修复**，并把失败分成
 * 三类（no_json / syntax / truncated）交给上层分流。
 */

/** 顶层 JSON 片段的扫描结果 */
interface JsonScan {
  /** 已配平的顶层片段（按出现顺序；正常只有一段） */
  balanced: string[]
  /** 末尾那个扫到结束仍未配平的片段（引号或括号没合上）—— 疑似被 max_tokens 砍断；没有则为 null */
  tail: string | null
}

/**
 * 扫描模型输出里的候选 JSON 片段。
 *
 * 「字符串内」与「字符串外」必须分开看待：只有字符串外的括号才算结构，只有字符串外的引号
 * 才是定界符。`escaped` 一档也不能省 —— 值里出现 `\"` 时，紧随其后的那个引号是正文内容，
 * 不是定界符，漏判就会把字符串提前收尾、后面全乱。
 */
function scanJsonCandidates(raw: string): JsonScan {
  let s = String(raw ?? '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  const balanced: string[] = []
  let tail: string | null = null
  let topStart = -1 // 当前顶层片段的起笔位置（深度 0 → 1 时记下）
  let depth = 0
  let inStr = false
  let escaped = false

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    /* 全角括号也算结构：模型偶尔整段写成全角，这里不认就连候选片段都取不出来（连「语法错」都
       判不成，只会落到「没按格式答」），而它其实只需 repairJsonText 归一半角。只用于定位，不改原文 */
    if (ch === '{' || ch === '[' || ch === '｛' || ch === '［') {
      if (depth === 0) topStart = i
      depth++
      continue
    }
    if (ch === '}' || ch === ']' || ch === '｝' || ch === '］') {
      if (depth === 0) continue // 散文里孤零零的右括号：忽略
      depth--
      if (depth === 0 && topStart >= 0) {
        balanced.push(s.slice(topStart, i + 1))
        topStart = -1
      }
    }
  }
  /* 扫到末尾仍是正的深度 = 有个容器没合上：这一段就是「被砍断的」那一段 */
  if (depth > 0 && topStart >= 0) tail = s.slice(topStart)
  return { balanced, tail }
}

/**
 * 挑出要解析的那一段。
 *
 * 取「配平片段里最长的那个」而不是第一个：模型偶尔先举一个格式示例再给正文
 * （`{...}` 的示例必然短于正文），原实现用 lastIndexOf('}') 时同样会踩，取最长是同一意图
 * 但更稳的写法。未配平的尾段若比配平的还长，则用它并标记 truncated —— 剪掉的只会是一段
 * 短的示例，不会把正文丢了。
 */
function pickJsonCandidate(scan: JsonScan): { text: string; truncated: boolean } | null {
  const longest = scan.balanced.reduce<string | null>(
    (a, b) => (a === null || b.length > a.length ? b : a),
    null
  )
  if (scan.tail && (longest === null || scan.tail.length > longest.length)) {
    return { text: scan.tail, truncated: true }
  }
  return longest === null ? null : { text: longest, truncated: false }
}

/**
 * 修复模型输出里常见的 JSON 畸形。**只在原样解析失败后调用** —— 合法 JSON 一个字节都不会被它碰。
 *
 * 五条都是确定性替换，不做猜测：
 *   ① 字符串内的裸换行 / 回车 / 制表符 → 转义。模型写多行摘要时最常见的畸形
 *      （JSON 规范禁止字符串里出现裸控制字符）；
 *   ② 字符串内**未转义的双引号** → 转 `\"`。判据：若一个 `"` 是字符串的收尾，它后面
 *      （跳过空白）**只能**是 `:` `,` `}` `]` 或文本结束 —— 这是 JSON 语法决定的；反过来，
 *      后面跟的不是这几个字符，它就只能是正文里的引号。这条判据对合法 JSON 恒不成立，
 *      故不会把正常输出改坏（值里含 `“”` 的中文引号也不受影响，它们不是 ASCII 引号）；
 *   ③ 字符串外的行注释 `//` 与块注释 → 删掉（模型爱在 JSON 里写注释）；
 *   ④ 尾随逗号（`}` / `]` 前面那个逗号）→ 删掉；
 *   ⑤ **字符串外**的全角标点（`，` `：` `｛` `｝` `［` `］`）→ 归一半角。中文模型把结构位的
 *      逗号写成全角是高频畸形，而旧版只把它记进报错文案、不救，代价是整份报告降级成纯文本
 *      简版（30~40s 白跑）。判据还是「字符串内 / 外」：正文里的全角标点（`他说“好”，然后走了`
 *      ）永远在字符串内、扫不到，能扫到的一定在结构位，归一不会碰到任何内容。合法 JSON 的
 *      结构位不含全角，故这条同样是恒等变换。
 *
 * 刻意**不**做的三件事，都写在这里免得后人反复试：
 *   · 不把全角**引号**归一成半角 —— 引号是定界符，归一它就得保证开闭配对，而模型真用全角引号
 *     定界时，段内往往还混着半角引号做正文（`“他说"我不退役"”`），归哪一个都是赌，赌错会把
 *     值切碎。这类输出只值得重试一次（报错里点一句「疑似全角」）；
 *   · 不给未配平的片段补右括号 —— 补出来的最后一条必然是半句话，而报告是**全局共享缓存**，
 *     半份内容会被全站读到（与「knowledgeOnly 不进缓存」是同一条理由）。截断的处置是
 *     不重试 + 指明改法，不是把半份当成品；
 *   · 不归一单引号 / 无引号键 / `True` 这类「另一种语言的写法」—— 判据不可能可靠（正文里的
 *     撇号 `don't`、引述的 `'某句话'` 都是合法内容），只能靠重试换一次采样。
 */
export function repairJsonText(text: string): string {
  let out = ''
  let inStr = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inStr) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        out += '\\r'
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      if (ch === '"') {
        /* 收尾引号后面只能跟 : , } ]（跳过空白），或到此为止；否则它是正文里的引号 */
        let j = i + 1
        while (j < text.length && /\s/.test(text[j])) j++
        const next = j < text.length ? text[j] : ''
        /* 全角标点同样算「收尾引号后面该出现的字符」—— 结构位写成全角时，这里的判据若只认半角，
           会把**键的收尾引号**误判成正文里的引号（转义成 `\"`），结构直接崩掉 */
        if (next === '' || next === ':' || next === ',' || next === '}' || next === ']' || FULLWIDTH_PUNCT[next] !== undefined) {
          inStr = false
          out += '"'
        } else {
          out += '\\"'
        }
        continue
      }
      out += ch
      continue
    }

    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    /* ⑤ 字符串外的全角标点 → 半角。能走到这行就一定不在字符串内（见函数头注释） */
    const half = FULLWIDTH_PUNCT[ch]
    if (half !== undefined) {
      out += half
      continue
    }
    if (ch === ',' && isTrailingComma(text, i)) continue
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++ // 连结尾的 '/' 一起跳过
      continue
    }
    out += ch
  }
  return out
}

/** 只收「JSON 结构位真会出现」的六个全角标点；全角引号刻意不在其中（理由见 repairJsonText 注释） */
const FULLWIDTH_PUNCT: Record<string, string> = {
  '，': ',',
  '：': ':',
  '｛': '{',
  '｝': '}',
  '［': '[',
  '］': ']'
}

/** 字符串外的这个逗号后面（跳过空白）紧跟右括号 ⇒ 尾随逗号 */
function isTrailingComma(text: string, at: number): boolean {
  let j = at + 1
  while (j < text.length && /\s/.test(text[j])) j++
  const ch = text[j]
  /* 全角闭合也要认：`{"a":1，｝` 里那个逗号同样是尾随逗号（结构位的全角由 ⑤ 归一） */
  return ch === '}' || ch === ']' || FULLWIDTH_PUNCT[ch] === '}' || FULLWIDTH_PUNCT[ch] === ']'
}

/** 从 JSON.parse 的错误里抠出位置，附该处上下文 —— 日志里一眼能看出是尾随逗号还是未转义引号 */
function syntaxContext(text: string, message: string): string {
  const m = message.match(/position\s+(\d+)/i)
  if (!m) return ''
  const at = Number(m[1])
  if (!Number.isFinite(at) || at < 0 || at > text.length) return ''
  const from = Math.max(0, at - 60)
  const to = Math.min(text.length, at + 60)
  return `位置 ${at} 附近：…${text.slice(from, to).replace(/\s+/g, ' ')}…`
}

/** parseModelJson 的结论：三类失败各有各的处置（见 chatJSON 的循环），故必须分开 */
export type ModelJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; kind: 'no_json' | 'syntax' | 'truncated'; error: string }

/**
 * 从模型输出里取出并解析 JSON：**先原样、后修复**（修复是增量的，原样能过就一个字节都不改）。
 *
 * 三种失败的区分是这一版的重点，因为「有返回却解析不出」正是它们被混在一起时最难查的地方：
 *   · no_json   —— 输出里没有配平的 JSON 片段（模型没按格式答）⇒ 值得重试一次；
 *   · syntax    —— 有片段但语法错，修复后仍错 ⇒ 值得重试一次（换一次采样可能就好）；
 *   · truncated —— 片段没配平，被 max_tokens 砍断 ⇒ **不重试**（重发必然再撞同一道上限），
 *                  且即使上游没给 finish_reason 也能判出来（括号没合上就是没写完）。
 */
/**
 * 顶层 `[{...}]` → `{...}`。
 *
 * 模型偶尔把整个对象包进一层数组（尤其提示词里刚排过 `"dynamics":[]` 这类数组字段之后）。
 * 语法完全合法、schema 必然校验失败 —— 属于「白跑一趟」里最冤的一种：正文一个字不差，
 * 只是外面多了一对方括号。仅在「长度为 1 且元素是普通对象」时解包：多元素时无从判断该取
 * 哪一个，那才是真的没按格式答（该重试）。
 */
function unwrapSingleObject(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1) return value
  const first = value[0]
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return value
  return first
}

export function parseModelJson(raw: string): ModelJsonResult {
  const picked = pickJsonCandidate(scanJsonCandidates(raw))
  if (!picked) return { ok: false, kind: 'no_json', error: 'LLM 输出不含 JSON' }

  const repaired = repairJsonText(picked.text)
  const attempts = repaired === picked.text ? [picked.text] : [picked.text, repaired]

  let syntaxError = ''
  for (const text of attempts) {
    try {
      return { ok: true, value: unwrapSingleObject(JSON.parse(text) as unknown) }
    } catch (err) {
      syntaxError = err instanceof Error ? err.message : String(err)
    }
  }

  if (picked.truncated) {
    return {
      ok: false,
      kind: 'truncated',
      error: `输出被上游截断（JSON 未闭合，${picked.text.length} 字）`
    }
  }
  const ctx = syntaxContext(picked.text, syntaxError)
  const fullAngle = /[“”｛｝]/.test(picked.text) ? '；输出里含全角引号/括号，多半是结构符号写成了全角' : ''
  return { ok: false, kind: 'syntax', error: `LLM 输出 JSON 语法错：${syntaxError}${ctx ? `（${ctx}）` : ''}${fullAngle}` }
}

/**
 * 纯文本生成（无 JSON 约束）：报告降级路径用（§5.4 用例 9）。
 * 失败即失败（调用方已重试过 JSON 路径，不再叠加重试）。
 *
 * 失败分支同样带 `retryable`（与 ChatJSONResult 同口径）：问答链路（qa.ts）据此决定要不要
 * 进 10 分钟冷却 —— 与 report.ts / weekly.ts 完全一致，免得同一趟上游故障在问答侧被无限重打
 * （每次都是真实付费的「检索 + 大模型」）。见 P2-14。
 */
export async function chatText(
  system: string,
  user: string,
  /**
   * 这一趟属于哪个配额池（云端闸门据此取上限，见 aiProxy/quota.config.js）。
   * 默认 `'generate'`：报告降级路径与报告同属生成池；AI 提问必须显式传 `'ask'`（见 qa.ts）。
   */
  purpose: QuotaPurpose = 'generate'
): Promise<{ ok: true; text: string } | { ok: false; error: string; retryable?: boolean; kind?: string }> {
  if (!hasLlmChannel()) {
    return { ok: false, error: '大模型通道不可用：云环境未配置（见 public.ts 的 cloudbaseEnvId）' }
  }
  const attempt = await chatOnce(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    purpose
  )
  if (!attempt.ok) return { ok: false, error: attempt.error, retryable: attempt.retryable, kind: attempt.kind }
  const text = attempt.content.trim()
  /* 上游 200 但正文为空：与 chatOnce 的空返回同判 —— 可重试（进而进冷却），
     否则问答侧会把同一趟上游故障当成「不是错误」，无限重打。文案见 P2-14。 */
  if (!text) return { ok: false, error: 'LLM 返回为空', kind: 'empty', retryable: true }
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
  /* purpose 决定云端闸门按哪一池算上限；默认 'generate'（最严的一池，漏传不会默默多给） */
  opts: { retries?: number; purpose?: QuotaPurpose } = {}
): Promise<ChatJSONResult<T>> {
  if (!hasLlmChannel()) {
    return { ok: false, error: '大模型通道不可用：云环境未配置（见 public.ts 的 cloudbaseEnvId）' }
  }

  const purpose: QuotaPurpose = opts.purpose ?? 'generate'
  const attempts = 1 + (opts.retries ?? 1)
  let lastError = 'LLM 输出无法解析为合法 JSON'
  let lastRetryable = true // 解析/校验失败默认可重试（换一次采样可能就过了）
  /*
   * 最近一次**调用**失败的 kind，随结果交给上层：kind='quota' 时 report.ts 必须跳过
   * 纯文本降级（降级那次会被同一道云端闸门再拦一次，白等一轮往返）。
   * 解析/校验失败不算「调用失败」，那时把它清掉，免得把上一轮的 kind 带出来。
   */
  let lastKind: string | undefined
  for (let i = 0; i < attempts; i++) {
    /* 本次尝试是否被上游截断；截断导致的失败一律不再重试（理由见上方注释） */
    let truncated = false
    try {
      const attempt = await chatOnce(
        [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        purpose
      )
      if (!attempt.ok) {
        lastError = attempt.error
        lastRetryable = attempt.retryable
        lastKind = attempt.kind
        diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次调用失败：${lastError}`)
        /* 密钥无效 / 额度不足这类错误，重试也是同样的结果，早点收手省一次往返 */
        if (!attempt.retryable) break
        continue
      }
      truncated = attempt.finishReason === 'length'
      const jsonValue = parseModelJson(attempt.content)
      if (!jsonValue.ok) {
        lastError = jsonValue.error
        lastKind = undefined
        /*
         * 把「哪一类失败」单独记一笔，并带上正文字数：这条日志是排查「有返回却解析不出」的
         * 唯一现场 —— 输出 8000 字且 kind=truncated 是撞上限，200 字且 no_json 是没按格式答，
         * 两者的改法完全不同（调大 chatMaxTokens / 改提示词）。
         */
        diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次输出无法解析（${jsonValue.kind}）：${lastError}`, {
          outputChars: attempt.content.length,
          finishReason: attempt.finishReason || ''
        })
        /*
         * 截断不重试，且**两种来源都要认**：上游明说 finish_reason=length，或者它什么都没说
         * 但括号压根没配平（parseModelJson 的 truncated）—— 后一种是上游不传 finish_reason 时
         * 唯一的证据，漏认就会白重试一轮（报告一次 30~40s），结果照样撞同一道墙。
         */
        if (truncated || jsonValue.kind === 'truncated') return truncatedFail(lastError)
        continue
      }
      const parsed = schema.safeParse(jsonValue.value)
      if (parsed.success) {
        return { ok: true, data: parsed.data }
      }
      lastError = `LLM 输出未过校验：${parsed.error.issues[0]?.message ?? '字段不合法'}`
      lastKind = undefined
      diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次输出不合法：${lastError}`)
      if (truncated) return truncatedFail(lastError)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      lastRetryable = true
      lastKind = undefined
      diagLog('warn', 'llm', `chatJSON 第 ${i + 1} 次调用失败：${lastError}`)
      if (truncated) return truncatedFail(lastError)
    }
  }
  return { ok: false, error: lastError, retryable: lastRetryable, kind: lastKind }
}

/**
 * 截断失败的统一出口：记一笔诊断（便于在日志里把「撞上限」与「解析/校验不过」分开），
 * 并以 retryable=false 返回 —— 让上层的重试循环立刻收手，直接走降级或报错。
 */
function truncatedFail(error: string): ChatJSONResult<never> {
  diagLog('warn', 'llm', `输出被上游截断，不再重试（重发同一请求只会再撞上限）：${error}`)
  return { ok: false, error, retryable: false, kind: 'truncated' }
}
