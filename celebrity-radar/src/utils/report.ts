import { z } from 'zod'
import { NewsItem, heatValue } from './search'
import { chatJSON, chatText, ChatJSONResult } from './llm'
import { setCooldown } from './cooldown'
import { diagLog } from './workbuddy-cloud-diagnostics'

/**
 * AI 报告 Schema v2（§2.3）与生成/校验（附录 B）。
 * 不信任提示词：URL 白名单、来源标注、枚举值全部代码层强制。
 */

const SentimentEnum = z.enum(['positive', 'neutral', 'negative'])

const DynamicSchema = z.object({
  date: z.string(),
  title: z.string(),
  summary: z.string().default(''),
  source: z.string().default(''),
  url: z.string(),
  sentiment: SentimentEnum.default('neutral')
})

const QuoteSchema = z.object({
  text: z.string(),
  context: z.string().default(''),
  source: z.string().default('据公开资料')
})

const TimelineSchema = z.object({
  date: z.string(),
  event: z.string()
})

const SourceSchema = z.object({
  title: z.string(),
  url: z.string()
})

/** LLM 输出契约（heat 由本地计算，不由模型给） */
const LlmReportSchema = z.union([
  z.object({ refused: z.literal(true) }),
  z.object({
    refused: z.literal(false).optional(),
    intro: z.string().default(''),
    dynamics: z.array(DynamicSchema).default([]),
    quotes: z.array(QuoteSchema).default([]),
    analysis: z.string().default(''),
    timeline: z.array(TimelineSchema).default([]),
    sources: z.array(SourceSchema).default([])
  })
])

export type LlmReport = z.infer<typeof LlmReportSchema> & { refused?: boolean }

/** 拒答结果的显式类型守卫（联合窄化用） */
export function isRefusedResult(x: unknown): x is { refused: true } {
  return typeof x === 'object' && x !== null && (x as { refused?: unknown }).refused === true
}

/** sanitizeReport 的输入形态（宽松：字段可能缺失，内部归一） */
export interface LlmReportFields {
  intro?: string
  dynamics?: Array<{ date?: string; title?: string; summary?: string; source?: string; url: string; sentiment?: string }>
  quotes?: Array<{ text: string; context?: string; source?: string }>
  analysis?: string
  timeline?: Array<{ date?: string; event?: string }>
  sources?: Array<{ title?: string; url: string }>
}

/** 完整报告（落库/渲染形态，§2.3 Schema v2） */
export interface Report {
  personKey: string
  name: string
  mode: 'realtime' | 'knowledge'
  generatedAt: string
  heat: number
  intro: string
  dynamics: Array<z.infer<typeof DynamicSchema>>
  quotes: Array<z.infer<typeof QuoteSchema>>
  analysis: string
  timeline: Array<z.infer<typeof TimelineSchema>>
  sources: Array<z.infer<typeof SourceSchema>>
  disclaimer: string
  /** 降级标记：结构化生成失败后由纯文本降级产出（§5.4 用例 9），UI 呈现降级提示 */
  degraded?: true
}

export const DISCLAIMER = '内容由 AI 基于公开网络信息生成，仅供参考，不代表本平台立场。'

const SYSTEM_REALTIME = [
  '你是名人动态分析师。基于提供的真实新闻素材，为指定名人生成一份结构化报告。',
  '硬约束：',
  '1. 仅基于素材作答，不编造日期与来源。',
  '2. dynamics 每条字段：date(YYYY-MM-DD)、title、summary(一句摘要)、source(来源媒体名)、url(必须从素材 URL 原样复制)、sentiment(只能是 positive/neutral/negative)。',
  '3. quotes 每条字段：text(名言原文)、context(出处场合/时间)、source(素材 URL 或「据公开资料」)。',
  '4. sources 列出全部用到的素材：title + url(原样复制)。',
  '5. analysis：风格/近期态度/热点综合点评，措辞中性，不带贬损表述。',
  '6. timeline：素材中可确认的关键事件(date + event)；无把握则留空数组。',
  '7. 若素材显示该人物属政治、军事类敏感人物，仅返回 {"refused": true}。',
  '8. 只输出 JSON，格式：{"intro":string,"dynamics":[],"quotes":[],"analysis":string,"timeline":[],"sources":[]}'
].join('\n')

const SYSTEM_KNOWLEDGE = [
  '你是名人动态分析师。当前无联网素材，基于你已有的公开知识为指定名人整理简版信息。',
  '硬约束：',
  '1. 不编造日期与来源；quotes 的 source 一律写「据公开资料」。',
  '2. 只输出 intro（一句话简介）、quotes（经典语录）、analysis（风格与立场点评，措辞中性）。',
  '3. dynamics、timeline、sources 一律空数组（无实时素材，宁缺毋滥）。',
  '4. 若该人物属政治、军事类敏感人物，仅返回 {"refused": true}。',
  '5. 只输出 JSON，格式：{"intro":string,"dynamics":[],"quotes":[],"analysis":string,"timeline":[],"sources":[]}'
].join('\n')

/** 降级纯文本提示词（结构化 JSON 两次失败后，§5.4 用例 9） */
const SYSTEM_FALLBACK = [
  '你是名人动态分析师。结构化生成暂时不可用，请用不超过 150 字的纯文本，',
  '基于已有知识客观概述该名人的身份与近期公开动向要点。',
  '要求：不编造具体日期与来源；不输出 JSON；措辞中性；若不确定的信息直接略过。'
].join('\n')

/** 素材 → user 消息（附录 B） */
function buildUserMessage(name: string, news: NewsItem[]): string {
  return [
    `名人：${name}`,
    '素材：',
    ...news.map((n) => `- ${n.title}（${n.source}）${n.url}\n${n.content}`)
  ].join('\n')
}

/**
 * 生成报告（实时素材 or 知识模式）。
 * 只负责调 LLM + 校验；缓存互斥由 utils/cache.ts 负责。
 */
export async function buildReport(
  personKey: string,
  name: string,
  news: NewsItem[] | null
): Promise<ChatJSONResult<Report | { refused: true }>> {
  const realtime = news !== null && news.length > 0
  const system = realtime ? SYSTEM_REALTIME : SYSTEM_KNOWLEDGE
  const user = realtime ? buildUserMessage(name, news) : `名人：${name}（无联网素材，知识模式）`

  const result = await chatJSON(system, user, LlmReportSchema)
  if (!result.ok) {
    // 降级：纯文本简版（§5.4 用例 9），不再套结构化 Schema
    setCooldown('llm')
    diagLog('warn', 'auth', `报告结构化生成失败，降级纯文本：${result.error}`)
    const fallback = await chatText(SYSTEM_FALLBACK, `名人：${name}`)
    if (fallback.ok) {
      return {
        ok: true,
        data: {
          personKey,
          name,
          mode: realtime ? 'realtime' : 'knowledge',
          generatedAt: new Date().toISOString(),
          heat: 0,
          intro: '',
          dynamics: [],
          quotes: [],
          analysis: fallback.text,
          timeline: [],
          sources: [],
          disclaimer: DISCLAIMER,
          degraded: true
        }
      }
    }
    return { ok: false, error: fallback.error }
  }

  if (isRefusedResult(result.data)) {
    diagLog('info', 'auth', `报告 LLM 拒答：${personKey}`)
    return { ok: true, data: { refused: true } }
  }

  const report = sanitizeReport(personKey, name, result.data, news, realtime ? 'realtime' : 'knowledge')
  return { ok: true, data: report }
}

/**
 * 代码层强制校验（附录 B，不信任提示词）：
 * 1. dynamics/sources 的 url 必须 ∈ 素材 url 集合，否则剔除
 * 2. quotes.source 为素材 url 或「据公开资料」，否则剔除
 * 3. heat 由 §1.6 公式本地计算；sentiment 已由 zod 枚举保证
 */
export function sanitizeReport(
  personKey: string,
  name: string,
  llm: LlmReportFields,
  news: NewsItem[] | null,
  mode: Report['mode']
): Report {
  const urlSet = new Set((news ?? []).map((n) => n.url))

  const normSentiment = (s?: string): 'positive' | 'neutral' | 'negative' =>
    s === 'positive' || s === 'negative' ? s : 'neutral'

  const dynamics = (llm.dynamics ?? [])
    .filter((d) => urlSet.has(d.url))
    .map((d) => ({
      date: d.date ?? '',
      title: d.title ?? '',
      summary: d.summary ?? '',
      source: d.source ?? '',
      url: d.url,
      sentiment: normSentiment(d.sentiment)
    }))
  const quotes = (llm.quotes ?? [])
    .filter((q) => (q.source ?? '据公开资料') === '据公开资料' || urlSet.has(q.source as string))
    .map((q) => ({ text: q.text, context: q.context ?? '', source: q.source ?? '据公开资料' }))
  const sources = (llm.sources ?? [])
    .filter((s) => urlSet.has(s.url))
    .map((s) => ({ title: s.title ?? '', url: s.url }))
  const timeline = (llm.timeline ?? []).map((t) => ({ date: t.date ?? '', event: t.event ?? '' }))

  let removed = 0
  removed += (llm.dynamics?.length ?? 0) - dynamics.length
  removed += (llm.quotes?.length ?? 0) - quotes.length
  removed += (llm.sources?.length ?? 0) - sources.length
  if (removed > 0) {
    diagLog('warn', 'db', `白名单剔除 ${removed} 条（${personKey}）`)
  }

  // 热度（§1.6）：N30 = 全部素材数（查询窗口 30 天）；N7 = publishedDate 在 7 天内
  let heat = 0
  if (mode === 'realtime' && news) {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
    const n7 = news.filter((n) => {
      if (!n.publishedDate) return false
      const t = Date.parse(n.publishedDate)
      return Number.isFinite(t) && t >= weekAgo
    }).length
    heat = heatValue(news.length, n7)
  }

  return {
    personKey,
    name,
    mode,
    generatedAt: new Date().toISOString(),
    heat,
    intro: llm.intro ?? '',
    dynamics,
    quotes,
    analysis: llm.analysis ?? '',
    timeline: mode === 'realtime' ? timeline : [],
    sources,
    disclaimer: DISCLAIMER
  }
}
