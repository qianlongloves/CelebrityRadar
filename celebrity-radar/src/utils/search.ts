import Taro from '@tarojs/taro'
import { getTavilyKey } from './settings'
import { setCooldown } from './cooldown'
import { diagLog } from './workbuddy-cloud-diagnostics'

/** Tavily 检索结果条目（附录 A） */
export interface NewsItem {
  title: string
  url: string
  content: string
  source: string
  /** 结果自带的发布/检索时间（用于 N30/N7 计数，§1.6） */
  publishedDate?: string
}

function hostOf(url: string): string {
  try {
    return url.replace(/^https?:\/\//, '').split('/')[0]
  } catch {
    return url
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Tavily news 检索适配器（附录 A，Taro.request）。
 * 无 key 返回 null（降级：读共享缓存，无则引导态，§2.4）。
 * 错误策略（§5.4 用例 9）：网络失败重试 2 次（1s/2s 指数退避）；
 * 429 超配额不重试，进入 10 分钟冷却。
 */
export async function fetchNews(name: string, opts: { days?: number; maxResults?: number } = {}): Promise<NewsItem[] | null> {
  const apiKey = getTavilyKey()
  if (!apiKey) return null

  const MAX_ATTEMPTS = 3
  let lastError = '搜索源请求失败'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    let res: any
    try {
      res = await Taro.request({
        url: 'https://api.tavily.com/search',
        method: 'POST',
        header: { 'Content-Type': 'application/json' },
        data: {
          api_key: apiKey,
          query: `${name} 近期 新闻 动态 言论`,
          topic: 'news',
          days: opts.days ?? 30,
          max_results: opts.maxResults ?? 10
          // domain_filter: ['weibo.com', 'zhihu.com'] // V1.5 多源分域
        },
        timeout: 15000
      })
    } catch (err) {
      // 网络层失败（超时/断网）：指数退避后重试
      lastError = err instanceof Error ? err.message : String(err)
      diagLog('warn', 'http', `Tavily 网络失败（第 ${attempt} 次）：${lastError}`)
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1))
      continue
    }

    if (res.statusCode === 429) {
      setCooldown('search')
      diagLog('warn', 'http', 'Tavily 429 超配额，进入 10 分钟冷却')
      throw new Error('搜索源今日额度已用完，请稍后再试')
    }
    if (res.statusCode !== 200) {
      lastError = `搜索源返回 ${res.statusCode}`
      diagLog('warn', 'http', `Tavily ${res.statusCode}`)
      if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1))
      continue
    }
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const results = ((res.data as any)?.results ?? []) as Array<Record<string, unknown>>
    return results.map((r) => ({
      title: String(r.title ?? ''),
      url: String(r.url ?? ''),
      content: String(r.content ?? ''),
      source: hostOf(String(r.url ?? '')),
      publishedDate: typeof r.published_date === 'string' ? r.published_date : undefined
    }))
  }
  throw new Error(lastError)
}

/** 热度计数（§1.6 公式的 N30/N7 输入）：norm(N) = min(1, log10(1+N)/2) */
export function heatValue(n30: number, n7: number): number {
  const norm = (n: number) => Math.min(1, Math.log10(1 + Math.max(0, n)) / 2)
  return Math.round(60 * norm(n30) + 40 * norm(n7))
}
