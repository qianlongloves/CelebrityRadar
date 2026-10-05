import Taro from '@tarojs/taro'
import { table } from './db'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { diagLog } from './cloud-diagnostics'

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
 * note 是用户自写的备注，与内容快照分开存：它不属于「收藏了什么」，而是「为什么收藏」。
 */

export type FavoriteType = 'quote' | 'report' | 'dynamic' | 'timeline'

/** 类型中文名：筛选、Toast、卡片副标题共用，避免同一批字面量散落各处 */
export const FAVORITE_TYPE_LABEL: Record<FavoriteType, string> = {
  quote: '名言',
  report: '报告',
  dynamic: '动态',
  timeline: '时间线'
}

export interface FavoriteRow {
  id: string
  openid: string
  type: FavoriteType
  payload: Record<string, unknown>
  person_key: string
  name: string
  created_at: string
  /** 用户备注（可空；本次改动前的老数据没有这个字段） */
  note?: string
}

/** 备注长度上限：列表上它只是一行小字，再长也只会被省略号截掉 */
export const NOTE_MAX = 40

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
 * 那是**全量覆盖** —— 用户已写的备注会被下一次收藏抹掉。这里 update 不携带 note
 * 与 created_at，重复收藏只刷新内容快照，备注与首次收藏时间都留着。
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
      created_at: new Date().toISOString(),
      note: ''
    })
    if (error) {
      diagLog('warn', 'db', `favorites(${draft.type}) 写入失败：${error.message ?? error}`)
      Taro.showToast({ title: '收藏失败，请重试', icon: 'none' })
      return false
    }
  }
  track('favorite', { personKey, favoriteType: draft.type })
  return true
}

/** 收藏名言（同句重复收藏幂等） */
export async function favoriteQuote(
  personKey: string,
  name: string,
  quote: { text: string; context?: string; source?: string }
): Promise<boolean> {
  return writeFavorite(
    {
      type: 'quote',
      contentKey: `${personKey}:${quote.text}`,
      payload: {
        text: quote.text,
        context: quote.context ?? '',
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
 * 写备注。返回 false 表示库里那行已不存在（例如在另一台设备取消了收藏），
 * 调用方据此提示，不让用户误以为备注保存成功。
 */
export async function setFavoriteNote(id: string, note: string): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  const { data, error } = await table('favorites')
    .update({ note: note.trim().slice(0, NOTE_MAX) })
    .eq('id', id)
    .select()
  if (error || !Array.isArray(data) || data.length === 0) {
    if (error) diagLog('warn', 'db', `favorites 备注写入失败：${error.message ?? error}`)
    return false
  }
  return true
}

export async function removeFavorite(id: string): Promise<void> {
  await table('favorites').delete().eq('id', id)
}
