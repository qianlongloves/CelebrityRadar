import Taro from '@tarojs/taro'
import { getBochaKey } from './settings'
import { setCooldown } from './cooldown'
import { diagLog } from './cloud-diagnostics'
import { callCloudFunction, isCloudConfigured } from './cloud'

/** 检索结果条目（附录 A） */
export interface NewsItem {
  title: string
  url: string
  content: string
  source: string
  /** 结果自带的发布时间（用于 N30/N7 计数，§1.6） */
  publishedDate?: string
}

/** 博查 Web Search 端点（国内备案域名，可直接配进小程序 request 合法域名） */
const ENDPOINT = 'https://api.bochaai.com/v1/web-search'

function hostOf(url: string): string {
  try {
    return url.replace(/^https?:\/\//, '').split('/')[0]
  } catch {
    return url
  }
}

/**
 * 博查错误信息：失败响应的正文在顶层，字段名是 message（不是 msg）。
 * 实测 403 返回 {"message":"...","log_id":"...","code":"403"}——
 * 注意 code 是**字符串**，所以下面统一用 Number() 归一化后再比较。
 * log_id 一并带出，是找博查客服时唯一有用的凭据。
 */
function errTextOf(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const d = data as Record<string, unknown>
  const raw = d.message ?? d.msg
  const text = typeof raw === 'string' ? raw.trim() : ''
  const logId = typeof d.log_id === 'string' ? d.log_id : ''
  return logId ? `${text} (log_id: ${logId})` : text
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * days → 博查 freshness 档位。
 * 博查只提供预设档位（oneDay/oneWeek/oneMonth/oneYear/noLimit），不支持任意天数，
 * 因此向上取更宽的档位（宁可多取再本地裁剪，好过取窄档漏掉素材）。
 */
function freshnessOf(days: number): string {
  if (days <= 1) return 'oneDay'
  if (days <= 7) return 'oneWeek'
  if (days <= 30) return 'oneMonth'
  if (days <= 365) return 'oneYear'
  return 'noLimit'
}

/**
 * 时间规范化：博查返回的日期串格式不固定（可能带时区、也可能只有日期），统一成 ISO。
 * report.ts 用 Date.parse 统计 N7，不可解析的值会让该条静默出局，
 * 因此解析失败直接返回 undefined——宁可不计数，也不要一个错值。
 */
function normDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/** 博查单条结果 → NewsItem（字段固定，取值全部兜底，避免脏数据穿透到报告层） */
function toNewsItem(r: Record<string, unknown>): NewsItem {
  const url = typeof r.url === 'string' ? r.url : ''
  const summary = typeof r.summary === 'string' ? r.summary.trim() : ''
  const snippet = typeof r.snippet === 'string' ? r.snippet.trim() : ''
  const siteName = typeof r.siteName === 'string' ? r.siteName.trim() : ''
  return {
    title: typeof r.name === 'string' ? r.name : '',
    url,
    /* summary 是详细摘要、snippet 是短摘，前者更适合喂给 LLM */
    content: summary || snippet,
    /* siteName 比裸域名可读，缺失时回落 host */
    source: siteName || hostOf(url),
    publishedDate: normDate(r.datePublished) ?? normDate(r.dateLastCrawled)
  }
}

const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 15000
/** 与云函数 runSearch 的 count 上限对齐，避免两条通道对同一入参给出不同条数 */
const MAX_RESULTS_CAP = 20

interface SearchParams {
  query: string
  freshness: string
  count: number
}

/** 单次尝试的结果：成功给出上游原始 pages，失败标明「是否值得重试」 */
type PagesAttempt =
  | { ok: true; pages: Array<Record<string, unknown>> }
  | { ok: false; error: string; retryable: boolean }

/**
 * 通道一：本机 Key 直连博查（BYOK）。
 *
 * 分支顺序与原实现一致，只是把「直接抛出」改成「打上 retryable 标记」，
 * 交给 fetchNews 里唯一的重试循环裁决（原先循环与判断混在一起，加第二条通道会失控）。
 */
async function pagesViaLocalKey(apiKey: string, params: SearchParams): Promise<PagesAttempt> {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let res: any
  try {
    res = await Taro.request({
      url: ENDPOINT,
      method: 'POST',
      header: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      data: { ...params, summary: true },
      timeout: REQUEST_TIMEOUT_MS
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'http', `博查网络失败：${msg}`)
    return { ok: false, error: msg, retryable: true }
  }

  if (res.statusCode === 429) {
    setCooldown('search')
    diagLog('warn', 'http', '博查 429 限流，进入 10 分钟冷却')
    return { ok: false, error: '搜索源请求过于频繁，请稍后再试', retryable: false }
  }
  if (res.statusCode === 401) {
    diagLog('warn', 'http', `博查 401：${errTextOf(res.data) || '密钥无效'}`)
    return { ok: false, error: '搜索源密钥无效，请检查 bocha_api_key', retryable: false }
  }
  if (res.statusCode === 403) {
    /* 实测最常见成因：账号没绑资源包 / 额度用尽，key 本身是好的 */
    diagLog('warn', 'http', `博查 403：${errTextOf(res.data) || '无权限或额度不足'}`)
    return { ok: false, error: '搜索源额度不足或未开通权限', retryable: false }
  }
  if (res.statusCode !== 200) {
    diagLog('warn', 'http', `博查 ${res.statusCode}`)
    return { ok: false, error: `搜索源返回 ${res.statusCode}`, retryable: true }
  }

  // 博查 HTTP 200 仍可能携带业务错误码，需再判一层
  const body = res.data as { code?: unknown; data?: { webPages?: { value?: unknown } } }
  const code = Number(body?.code ?? 200)
  if (code !== 200) {
    const msg = errTextOf(body) || `搜索源错误码 ${code}`
    diagLog('warn', 'http', `博查业务错误 ${code}：${msg}`)
    return { ok: false, error: msg, retryable: true }
  }

  return { ok: true, pages: (body?.data?.webPages?.value ?? []) as Array<Record<string, unknown>> }
}

/** 云函数 search 动作的返回结构（对应 cloudfunctions/aiProxy 的 runSearch） */
interface ProxySearchResult {
  ok: boolean
  pages?: Array<Record<string, unknown>>
  kind?: string
  error?: string
}

/** 值得重试的 kind：上游 5xx / 业务错误码 / 网络层失败 */
const RETRYABLE_KINDS = new Set(['upstream', 'network'])

/**
 * 通道二：云函数代理（平台代付）。客户端不持有任何 key，博查由 aiProxy 用服务端环境变量代打。
 *
 * 返回 null = 「这条通道不存在」，对齐 fetchNews 既有的降级语义（null → 读共享缓存 → 引导态）：
 * 函数没部署（-501000）、云环境没配、或函数部署了但环境变量为空，都属于
 * 「平台没把这条通道准备好」，不该让用户看到一句像是故障的报错。
 *
 * 与通道一的关键差别：上游失败由云函数消化成 kind，端上不再解析 HTTP 状态码。
 */
async function pagesViaPlatform(params: SearchParams): Promise<PagesAttempt | null> {
  let res: ProxySearchResult | null
  try {
    res = (await callCloudFunction('aiProxy', {
      action: 'search',
      query: params.query,
      freshness: params.freshness,
      count: params.count
    })) as ProxySearchResult | null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'http', `平台检索通道不可用：${msg}`)
    return null
  }

  if (!res || res.ok !== true) {
    /*
     * 三种「通道未就绪」，都不是检索故障，统一走降级，避免甩给用户一句无从下手的报错：
     *   函数没部署（callCloudFunction 已抛错，见上）、函数在但额度没配（unconfigured）、
     *   函数是只认 action='test' 的旧版（返回「未知 action」——需要重新部署云函数）。
     */
    if (!res || res.kind === 'unconfigured' || res.error?.includes('未知 action')) {
      diagLog('warn', 'http', `平台检索通道未就绪：${res?.error ?? '云函数无返回值'}`)
      return null
    }
    const msg = res.error || '平台检索失败'
    const kind = res.kind ?? ''
    if (kind === 'rate') setCooldown('search')
    diagLog('warn', 'http', `平台检索失败（${kind}）：${msg}`)
    return { ok: false, error: msg, retryable: RETRYABLE_KINDS.has(kind) }
  }

  return { ok: true, pages: res.pages ?? [] }
}

/**
 * 是否有可用检索通道：本机 Key（BYOK）或平台代付（云函数代理）。
 *
 * 只做保守估计 —— 云函数是否真部署好、环境变量是否真配了，只有调一次才知道。
 * 调用方（刷新配额的前置检查）用它避免「明明能用却被拦下」，真失败由 fetchNews 的返回值兜住。
 */
export function hasSearchChannel(): boolean {
  return getBochaKey() !== null || isCloudConfigured
}

/**
 * 博查检索适配器（附录 A）。
 *
 * 两条通道择优其一：用户自配了 Key 就走本机直连（BYOK，费用自负，开发与内测用），
 * 否则走云函数代理（平台代付，用户零配置，见 cloudfunctions/aiProxy）。
 * 没有本机 Key 的用户因此不再需要自己去申请博查账号 —— 这是「联网能力开箱可用」的关键。
 *
 * 返回 null 表示「无可用检索通道」（降级：读共享缓存，无则引导态，§2.4），
 * 与「通道可用但请求失败」（抛出）严格区分，调用方据此走 coldstart 还是报错。
 *
 * 错误策略（§5.4 用例 9）：
 *   网络失败 / 5xx / 业务错误码 → 重试 2 次（1s/2s 指数退避）；
 *   429 限流 → 不重试，进入 10 分钟冷却；
 *   401/403 → key 无效或额度不足，重试无意义，直接抛出。
 */
export async function fetchNews(
  name: string,
  opts: { days?: number; maxResults?: number } = {}
): Promise<NewsItem[] | null> {
  const apiKey = getBochaKey()
  const params: SearchParams = {
    query: `${name} 近期 新闻 动态 言论`,
    freshness: freshnessOf(opts.days ?? 30),
    count: Math.min(opts.maxResults ?? 10, MAX_RESULTS_CAP)
  }

  let lastError = '搜索源请求失败'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = apiKey ? await pagesViaLocalKey(apiKey, params) : await pagesViaPlatform(params)

    if (result === null) return null // 无可用通道：降级，不算错误
    if (result.ok) {
      /* 无 url 的条目无法溯源，报告白名单也会剔除它，这里先丢掉以免虚占 N30 计数 */
      return result.pages.map(toNewsItem).filter((n) => n.url)
    }

    lastError = result.error
    if (!result.retryable) break
    diagLog('warn', 'http', `检索失败（第 ${attempt} 次）：${lastError}`)
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1))
  }
  throw new Error(lastError)
}

/** 热度计数（§1.6 公式的 N30/N7 输入）：norm(N) = min(1, log10(1+N)/2) */
export function heatValue(n30: number, n7: number): number {
  const norm = (n: number) => Math.min(1, Math.log10(1 + Math.max(0, n)) / 2)
  return Math.round(60 * norm(n30) + 40 * norm(n7))
}
