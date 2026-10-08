import { DOMAIN_META, DomainCode, parsePersonKey } from '@/config/domains'
import type { Report } from './report'
import { extractKeywords } from './keywords'
import { sameTopic } from './compare'

/**
 * 主题知识库聚合（Phase 1，纯端上派生）。
 *
 * 把「以人为中心」的报告缓存翻转成「以话题为中心」的视图：一个主题 → 谁在说（相关名人）·
 * 说什么立场 · 说过什么（相关言论）· 有哪些报道 · 什么时候被讨论。
 *
 * 与词云（utils/keywords.ts）、两人对比（utils/compare.ts）同一条路线：
 *
 * 1. **纯函数、零模型调用、零上游请求、不消耗生成额度**。数据源就是已缓存的报告，
 *    所以 2026-10-06 之前落库的老报告同样有主题页 —— 报告是「一次生成、长期缓存」的资产，
 *    主题聚合不该逼用户重新花一次额度。
 * 2. **只做编目，不造内容**。本文件不产出任何新句子，只把既有字段按主题重新编排；
 *    每一条言论 / 报道都带原名与出处，可以逐条核对（与词云「逐条附佐证原文」同一口径）。
 * 3. **覆盖范围 = 已收录报告的并集**，因此页面上必须如实说明这一点，不能让人误读成全网热度。
 *    全局覆盖属于 Phase 2（云端物化），那时才有独立的 topics 集合。
 *
 * 主题归并用 utils/compare.ts 的 sameTopic（互为子串即同一主题），保证「对比页说有共同话题、
 * 主题页说没有」这种自相矛盾不会出现。
 */

/** 主题下的一个成员（相关名人） */
export interface TopicMember {
  personKey: string
  name: string
  domain: DomainCode
  domainLabel: string
  /** 该名人报告的热度（§1.6 公式，同一把尺子，可横向比） */
  heat: number
  /** 该报告里命中本主题的素材条数 */
  mentions: number
}

/** 成员对本主题的公开立场（来自报告 stance 段，模型判定的） */
export interface TopicStance {
  personKey: string
  name: string
  attitude: 'positive' | 'neutral' | 'negative' | 'mixed'
  /** 一句话依据（可能为空串） */
  note: string
}

/**
 * 相关言论。整条带出**所属报告**而不是只带文本：
 * 渲染时复用 components/quote-detail（「查证」要拿整份报告去找旁证报道），
 * 也避免这里再造一套脚注口径。
 */
export interface TopicQuote {
  report: Report
  quote: Report['quotes'][number]
}

/** 相关报道（报告内「近期动态」里正文命中本主题的条目） */
export interface TopicNews {
  personKey: string
  name: string
  title: string
  url: string
  source: string
  date: string
  summary: string
}

/**
 * 时间线上的一个点：**按天聚合的讨论分布**（哪天有几个人在讲这个话题）。
 * 刻意不逐条罗列 —— 那种摆法与「相关报道」是同一批素材的两种写法，
 * 会变成同一页里把同样的内容列两遍。
 */
export interface TopicTimelinePoint {
  /** yyyy-MM-dd */
  date: string
  /** 当天命中的素材条数 */
  count: number
  /** 当天在讲这个话题的名人（去重，按首次出现顺序） */
  names: string[]
}

export interface TopicDigest {
  topic: string
  /** 被归并进本主题的其它说法（「旗舰手机」→ 主题「手机」），最多 6 个 */
  aliases: string[]
  members: TopicMember[]
  stances: TopicStance[]
  quotes: TopicQuote[]
  news: TopicNews[]
  timeline: TopicTimelinePoint[]
  /** 命中的素材总条数（动态 + 语录，按条计） */
  materialCount: number
  /** 主题热度 0~100（口径见 heatOf） */
  heat: number
  /** 参与聚合的最新一份报告的生成时间：页面据此说明「数据截至」 */
  updatedAt: string
}

/** 相关言论 / 报道的展示上限（超出的留在各自报告页，不在这里堆成长列表） */
const MAX_QUOTES = 8
const MAX_NEWS = 12
const MAX_ALIASES = 6
/** 时间线最多多少个点（按日期升序保留最近的 N 个） */
const MAX_TIMELINE = 14

/**
 * 主题热度（0~100）。
 *
 * 由两件事决定：**多少人讲**（spread）与**讲了多少条**（volume）。
 * 二者都取对数再封顶，理由与报告热度（§1.6）一致 —— 曝光度类指标的增长是指数型的，
 * 线性相加会让一个被反复报道的话题瞬间顶格，也让「再多人讲也涨不上去」。
 *
 * 权重 45% / 55%（素材量略重）：只被一个人提一句的话，和一个被五个人写了十几条的话题，
 * 应当明显分层。**不做时间衰减**：Phase 1 的数据源是长期不自动过期的缓存，
 * 拿缓存年龄当新鲜度会得到一条「放久了自动降温」的假曲线（时间维度留给 Phase 2 的
 * first_seen_at）。因此这个数字只表达「在本站已收录报告里的覆盖广度」，不是全网实时热度，
 * 页面脚注必须把这一点说清楚。
 */
function heatOf(spread: number, volume: number): number {
  const spreadScore = Math.min(1, Math.log2(1 + spread) / Math.log2(7)) // 6 位封顶
  const volumeScore = Math.min(1, Math.log2(1 + volume) / Math.log2(41)) // 40 条封顶
  return Math.round(100 * (0.45 * spreadScore + 0.55 * volumeScore))
}

/** 把报告里的日期归一成 yyyy-MM-dd；认不出来返回空串（不猜、不填今天） */
function dayOf(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? '').trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/**
 * 生成主题聚合结果。
 *
 * 纯函数：同一批报告必然得到同一结果，便于离线验证（与 buildComparison 同风格）。
 *
 * `reports` 是调用方（页面）从缓存取回的候选报告集合 —— 本文件不做任何数据访问，
 * 因此可以脱离小程序环境直接跑单测。
 */
export function buildTopicDigest(topic: string, reports: Report[]): TopicDigest {
  const t = (topic ?? '').trim()
  const members: TopicMember[] = []
  const aliases = new Set<string>()
  const stances: TopicStance[] = []
  const quotes: TopicQuote[] = []
  const news: TopicNews[] = []
  /** 时间线的累积器：日期 → 条数 / 当天的名人 */
  const byDay = new Map<string, { count: number; names: string[] }>()
  let materialCount = 0
  let updatedAt = ''

  if (t) {
    for (const report of reports) {
      if (!report || !report.personKey) continue

      /*
       * 命中判定只有一条：**素材正文里真的出现了主题词**。
       *
       * 刻意不做「同义说法也算命中」的宽松归并（那是两人对比 utils/compare 的取舍）——
       * 本页是要摊给人核对的，成员、提及数、相关报道、相关言论必须互相能对上：页面写
       * 「3 条素材提及」，下面就该正好列出 3 条。宽松归并会让「显示提及 2 条、报道列表却
       * 是空的」这种对不上的情况出现，那正是这个项目一直在避免的东西。
       *
       * `sameTopic` 在本页只用于两件不涉及计数的事：记下同义说法（别名）、
       * 挑出成员针对本主题的立场。
       *
       * 由此得到一个符合直觉的性质：点「手机」看到所有提到手机的报告（含「旗舰手机」
       * 这类更长的说法，子串天然命中）；点「旗舰手机」就只看真写过这四个字的报告 ——
       * 点的词越具体，视图越窄。
       */
      const hitText = (text: string): boolean => text.includes(t)
      const hitNews = report.dynamics.filter((d) => hitText(`${d.title} ${d.summary}`))
      const hitQuotes = report.quotes.filter((q) => hitText(`${q.text} ${q.context}`))
      const mentions = hitNews.length + hitQuotes.length
      if (mentions === 0) continue

      const parsed = parsePersonKey(report.personKey)
      const domain: DomainCode = parsed?.domain ?? 'other'
      members.push({
        personKey: report.personKey,
        name: report.name,
        domain,
        domainLabel: DOMAIN_META[domain]?.label ?? '其他',
        heat: report.heat,
        mentions
      })
      materialCount += mentions

      /* 同义说法：词表里与主题互为子串的其它写法（「旗舰手机」之于「手机」），只作说明 */
      for (const k of extractKeywords(report, { limit: 24, minHits: 1, minRuns: 2 })) {
        if (k.word !== t && sameTopic(k.word, t)) aliases.add(k.word)
      }

      for (const s of report.stance ?? []) {
        if (!sameTopic((s.topic ?? '').trim(), t)) continue
        stances.push({
          personKey: report.personKey,
          name: report.name,
          attitude: s.attitude,
          note: (s.note ?? '').trim()
        })
        /* 一个人关于同一个主题只留一条立场，后面的当场收起 */
        break
      }

      for (const d of hitNews) {
        news.push({
          personKey: report.personKey,
          name: report.name,
          title: d.title,
          url: d.url,
          source: d.source,
          date: dayOf(d.date),
          summary: d.summary
        })
        const day = dayOf(d.date)
        /* 没有可确认日期的条目不进时间线：宁可少一个点，不可编一个时间 */
        if (!day) continue
        const bucket = byDay.get(day) ?? { count: 0, names: [] }
        bucket.count++
        if (!bucket.names.includes(report.name)) bucket.names.push(report.name)
        byDay.set(day, bucket)
      }

      for (const q of hitQuotes) quotes.push({ report, quote: q })

      if (report.generatedAt > updatedAt) updatedAt = report.generatedAt
    }
  }

  /* 关注度排序：提及条数优先，同档看报告热度（同一把尺子，可直接比大小） */
  members.sort((a, b) => b.mentions - a.mentions || b.heat - a.heat)

  /* 报道按日期倒序，无日期的排末尾（与关注流、时间线的排序口径一致） */
  news.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  news.splice(MAX_NEWS)

  const timeline: TopicTimelinePoint[] = [...byDay.entries()]
    .map(([date, v]) => ({ date, count: v.count, names: v.names }))
    .sort((a, b) => a.date.localeCompare(b.date))
    /* 从早到晚展示「怎么热起来的」，超出上限时保留最近的一段 */
    .slice(-MAX_TIMELINE)

  return {
    topic: t,
    aliases: [...aliases].slice(0, MAX_ALIASES),
    members,
    stances,
    quotes: quotes.slice(0, MAX_QUOTES),
    news,
    timeline,
    materialCount,
    heat: heatOf(members.length, materialCount),
    updatedAt
  }
}

/** 主题名是否值得开一页：太短（1 字）的说法聚合出来都是噪声 */
export const TOPIC_MIN_CHARS = 2

/** 一句话概览（页面头部与分享标题共用一处口径，避免两处拼串各写一遍） */
export function describeTopic(digest: TopicDigest): string {
  if (digest.members.length === 0) return '暂无相关报告'
  const people = `${digest.members.length} 位名人`
  const material = `${digest.materialCount} 条素材`
  const aliases = digest.aliases.length ? `，含「${digest.aliases.slice(0, 3).join('」「')}」等说法` : ''
  return `${people} · ${material}${aliases}`
}
