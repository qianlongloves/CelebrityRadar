import Taro from '@tarojs/taro'
import { table } from './db'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { diagLog } from './cloud-diagnostics'
import { toastText } from './error'
import type { Report } from './report'

/**
 * 收藏（§3.8 favorites）：主键 = openid#type#hash（hash = 内容摘要散列前 8 位，天然防重）。
 *
 * 四类收藏粒度不同，contentKey 的选取标准是「同一份内容在报告重新生成后依然稳定」：
 * - quote    名言原文（同句重复收藏幂等）
 * - report   personKey（一人一份）
 * - dynamic  原始新闻 url
 * - timeline 「日期|事件」
 *
 * dynamic / timeline 刻意不用标题或事件描述做键：那两处措辞每次生成都会漂移，
 * 报告刷新一次，同一条新闻就会变成两条收藏。这与页面「刷新对比」的判同口径一致。
 *
 * 曾经的 note（用户自写备注）已于 2026-10-06 随收藏页改版删除：它是本项目唯一入库的
 * 用户自由文本，列表上却只是一行 22rpx 小字，收益远小于它带来的表达/审核成本。
 * 老数据里残留的 note 字段不再读取，也不做清理。
 */

export type FavoriteType = 'quote' | 'report' | 'dynamic' | 'timeline'

/** 类型中文名：筛选、Toast、卡片副标题共用，避免同一批字面量散落各处 */
export const FAVORITE_TYPE_LABEL: Record<FavoriteType, string> = {
  quote: '名言',
  report: '报告',
  dynamic: '动态',
  timeline: '时间线'
}

/**
 * 动态情绪 → 卡片上的小标记（收藏卡改版新增）。
 *
 * 措辞沿用报告页「近期动态」那一组（积极 / 中性 / 消极，见 pages/report 的 SENTIMENT_META），
 * 免得上游标「积极」、收藏页标「正面」，同一件事两个说法。
 *
 * 只列**偏离中性**的两档：「中性」是默认值（favoriteDynamic 落库时缺省即 neutral），
 * 每张卡都挂一个「中性」只是噪音，标了也传递不了信息。
 */
export const SENTIMENT_TAG: Record<string, string> = {
  positive: '积极',
  negative: '消极'
}

export interface FavoriteRow {
  id: string
  openid: string
  type: FavoriteType
  payload: Record<string, unknown>
  person_key: string
  name: string
  created_at: string
}

/**
 * 收藏列表一次拉取上限。db.ts 内部按 20 条/页自动续取，100 条 = 5 次请求，
 * 在个人量级下耗时可控；超出部分不进列表（页面上有明确条数提示）。
 */
export const FAVORITE_LIMIT = 100

/** FNV-1a 32 位散列 → 8 位 hex（无第三方依赖，防重用途足够，非加密） */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function makeFavoriteId(userId: string, type: FavoriteType, contentKey: string): string {
  return `${userId}#${type}#${fnv1a(`${type}:${contentKey}`)}`
}

function requireUserId(): string | null {
  const userId = useAuth.getState().userId
  if (!userId) {
    Taro.showToast({ title: '请先到「我的」页登录', icon: 'none' })
    return null
  }
  return userId
}

/** 写入一条收藏所需的全部信息；四类收藏只在这三个字段上有区别 */
interface FavoriteDraft {
  type: FavoriteType
  contentKey: string
  payload: Record<string, unknown>
}

/**
 * 四类收藏共用的写入路径。
 *
 * 抽出来是因为「取 userId → 算主键 → 落库 → 失败提示 → 埋点」这五步每加一类
 * 就复制一遍，第四份拷贝里漏埋点或漏校验只是时间问题。
 *
 * 用 update + insert 两步而非 upsert：CloudBase 无 upsert，db.ts 落到 doc(id).set()，
 * 那是**全量覆盖** —— 重复收藏会把「首次收藏时间」冲成现在。这里 update 不携带
 * created_at，重复收藏只刷新内容快照，首次收藏时间留着。
 */
async function writeFavorite(
  draft: FavoriteDraft,
  personKey: string,
  name: string
): Promise<boolean> {
  const userId = requireUserId()
  if (!userId) return false
  /* id 在 update 时会被 db.ts 的 mapPayload 跳过（不会误写 _id），只用于 where */
  const row = {
    id: makeFavoriteId(userId, draft.type, draft.contentKey),
    openid: userId,
    type: draft.type,
    payload: draft.payload,
    person_key: personKey,
    name
  }
  const { data: updated, error: upErr } = await table('favorites')
    .update(row)
    .eq('id', row.id)
    .select()
  const exists = !upErr && Array.isArray(updated) && updated.length > 0
  if (!exists) {
    const { error } = await table('favorites').insert({
      ...row,
      created_at: new Date().toISOString()
    })
    if (error) {
      diagLog('warn', 'db', `favorites(${draft.type}) 写入失败：${error.message ?? error}`)
      /* 环境类失败（表没建 / 权限不对）由 utils/error.ts 译成「请联系开发者…」，网络类才劝重试 */
      Taro.showToast({ title: toastText(error, '收藏失败，请重试'), icon: 'none' })
      return false
    }
  }
  track('favorite', { personKey, favoriteType: draft.type })
  return true
}

/**
 * 收藏名言（同句重复收藏幂等）。
 *
 * 本轮把 `background` / `note` 一并落进 payload（此前只存 text / context / source）：
 * 收藏页改版后名言卡要展示「这句话在什么场合说的、意味着什么」——
 * 只存原句的话，卡片就只是一句悬空的话，收藏的理由（当时读到的判断）全丢了。
 *
 * ⚠ 别与已删除的**顶层 `note` 列**混淆（那是用户自写备注，见文件头注释）：
 * 这里的 `note` 是报告里模型给的「注解」，属于内容快照的一部分，两者只是重名。
 *
 * 两者都是 optional（老缓存里没有这两个键，见 report.ts 的 QuoteSchema），
 * 归一成空串后卡片自然少一行 —— 不编造「背景」。
 */
export async function favoriteQuote(
  personKey: string,
  name: string,
  quote: { text: string; context?: string; background?: string; note?: string; source?: string }
): Promise<boolean> {
  return writeFavorite(
    {
      type: 'quote',
      contentKey: `${personKey}:${quote.text}`,
      payload: {
        text: quote.text,
        context: quote.context ?? '',
        background: quote.background ?? '',
        note: quote.note ?? '',
        source: quote.source ?? '据公开资料'
      }
    },
    personKey,
    name
  )
}

/** 收藏报告（按 personKey 一人一份，幂等） */
export async function favoriteReport(
  personKey: string,
  name: string,
  meta: { heat: number; mode: string; generatedAt: string }
): Promise<boolean> {
  return writeFavorite({ type: 'report', contentKey: personKey, payload: meta }, personKey, name)
}

/** 收藏单条动态（键 = 原文 url） */
export async function favoriteDynamic(
  personKey: string,
  name: string,
  d: {
    date: string
    title: string
    summary?: string
    source?: string
    url: string
    sentiment?: string
  }
): Promise<boolean> {
  return writeFavorite(
    {
      type: 'dynamic',
      contentKey: d.url,
      payload: {
        date: d.date ?? '',
        title: d.title ?? '',
        summary: d.summary ?? '',
        source: d.source ?? '',
        url: d.url,
        sentiment: d.sentiment ?? 'neutral'
      }
    },
    personKey,
    name
  )
}

/** 收藏单个履历节点（键 = 「日期|事件」，与刷新对比口径一致） */
export async function favoriteTimeline(
  personKey: string,
  name: string,
  t: { date: string; event: string }
): Promise<boolean> {
  return writeFavorite(
    {
      type: 'timeline',
      contentKey: `${t.date}|${t.event}`,
      payload: { date: t.date ?? '', event: t.event ?? '' }
    },
    personKey,
    name
  )
}

/** 是否已收藏（UI 心形状态用） */
export async function isFavorited(type: FavoriteType, contentKey: string): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  const { data } = await table('favorites')
    .select('id')
    .eq('id', makeFavoriteId(userId, type, contentKey))
    .maybeSingle()
  return !!data
}

/** 收藏列表（可按类型过滤，时间倒序，上限 100） */
export async function listFavorites(type?: FavoriteType): Promise<FavoriteRow[]> {
  const userId = useAuth.getState().userId
  if (!userId) return []
  let q = table('favorites').select('*').eq('openid', userId)
  if (type) q = q.eq('type', type)
  const { data, error } = await q.order('created_at', { ascending: false }).limit(FAVORITE_LIMIT)
  if (error) {
    diagLog('warn', 'db', `favorites 读取失败：${error.message ?? error}`)
    return []
  }
  return (data as FavoriteRow[]) ?? []
}

/**
 * 取消收藏。**失败必须让调用方知道**：吞掉 error 的话，页面已经把卡片从本地列表移走并提示
 * 「已取消收藏」，下次进来它又原样出现 —— 用户只会认为「删了又自己冒出来」。
 * 返回是否真的删掉了（与 listFavorites 的 diagLog 口径一致）。
 */
export async function removeFavorite(id: string): Promise<boolean> {
  const { error } = await table('favorites').delete().eq('id', id)
  if (error) {
    diagLog('warn', 'db', `favorites 删除失败：${error.message ?? error}`)
    return false
  }
  return true
}

/** 报告卡的内容摘要（收藏卡改版新增）：卡片从「只有一条热度刻度」变成能看出「里面有什么」 */
export interface ReportDigest {
  /** 最新报道的标题；空串表示这份报告既无素材画像也无动态 */
  latest: string
  /** 该条的前缀信息（素材画像给媒体名，动态给「日期 · 媒体名」），与 latest 同生共死 */
  latestMeta: string
  /** 素材画像，如「素材 40 条 · 近 7 天 12 条」；老报告没有 coverage 时为空串 */
  coverage: string
}

/**
 * 从**缓存报告**里摘出报告卡要显示的两行（收藏卡改版新增）。
 *
 * 为什么不能从 payload 取：收藏存的是一份快照，report 类只落了 heat / mode / generatedAt
 * —— 动态列表与素材画像都没有落库（同 utils/trend.ts 的处境）。所以和热度走势一样，
 * 内容摘要是**回源 report_cache** 取的，调用方必须**版本一致**才用它
 * （favorites-view 里与 buildHeatTrend 同一处判断），否则卡片上会出现
 * 「快照的热度 + 另一版报告的内容」这种张冠李戴的组合。
 *
 * 两行的取值优先级刻意反过来：最新的**报道**优先取 coverage.latest（博查原值，事实），
 * 取不到才退回模型写的动态首条 —— 这也与报告页速览卡的「最新报道」同一口径。
 *
 * 纯函数：两条都取不到返回 null，卡片退化成原来的样子（只显示热度），而不是显示占位文案。
 */
export function reportDigestOf(report: Report): ReportDigest | null {
  const latest = latestLineOf(report)
  const coverage = coverageLineOf(report?.coverage)
  if (!latest.title && !coverage) return null
  return { latest: latest.title, latestMeta: latest.meta, coverage }
}

/** 最新一行：coverage.latest（原样素材）优先，退回最新日期的动态 */
function latestLineOf(report: Report): { title: string; meta: string } {
  const raw = report?.coverage?.latest
  const rawTitle = String(raw?.title ?? '').trim()
  if (rawTitle) return { title: rawTitle, meta: String(raw?.source ?? '').trim() }
  return newestDynamicOf(report)
}

/**
 * 日期最新的一条动态。日期是 yyyy-mm-dd 字面量，字典序即时序，无需 Date.parse。
 * 没有日期的条目不参与比较（模型漏字段时，不能让它顶掉真正最新的那条）。
 */
function newestDynamicOf(report: Report): { title: string; meta: string } {
  const list = Array.isArray(report?.dynamics) ? report.dynamics : []
  let title = ''
  let meta = ''
  let bestDate = ''
  list.forEach((d) => {
    const t = String(d?.title ?? '').trim()
    const date = String(d?.date ?? '').trim()
    if (!t || !date || date < bestDate) return
    bestDate = date
    title = t
    meta = [date, String(d?.source ?? '').trim()].filter(Boolean).join(' · ')
  })
  return { title, meta }
}

/** 「素材 N 条 · 近 7 天 M 条」；无画像或两数皆缺返回空串（老报告就是这种情况） */
function coverageLineOf(coverage: Report['coverage'] | undefined): string {
  if (!coverage) return ''
  const items = Number(coverage.items)
  const recent = Number(coverage.recent)
  const parts: string[] = []
  if (Number.isFinite(items) && items > 0) parts.push(`素材 ${items} 条`)
  if (Number.isFinite(recent) && recent > 0) parts.push(`近 7 天 ${recent} 条`)
  return parts.join(' · ')
}
