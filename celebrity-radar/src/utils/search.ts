import Taro from '@tarojs/taro'
import { getTavilyKey } from './settings'
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

/**
 * Tavily news 检索适配器（附录 A，Taro.request）。
 * 无 key 返回 null（降级：读共享缓存，无则引导态，§2.4）。
 * 失败抛错（调用方按 §2.4 重试/提示）。
 */
export async function fetchNews(name: string, opts: { days?: number; maxResults?: number } = {}): Promise<NewsItem[] | null> {
  const apiKey = getTavilyKey()
  if (!apiKey) return null

  const res = await Taro.request({
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

  if (res.statusCode !== 200) {
    diagLog('warn', 'http', `Tavily ${res.statusCode}`)
    throw new Error(`搜索源返回 ${res.statusCode}`)
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

/** 热度计数（§1.6 公式的 N30/N7 输入）：norm(N) = min(1, log10(1+N)/2) */
export function heatValue(n30: number, n7: number): number {
  const norm = (n: number) => Math.min(1, Math.log10(1 + Math.max(0, n)) / 2)
  return Math.round(60 * norm(n30) + 40 * norm(n7))
}
