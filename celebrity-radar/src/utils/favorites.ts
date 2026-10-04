import Taro from '@tarojs/taro'
import { table } from './db'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { diagLog } from './workbuddy-cloud-diagnostics'

/**
 * 收藏（§3.8 favorites）：主键 = openid#type#hash（hash = 内容摘要散列前 8 位，天然防重）。
 * quote 收藏内容摘要，report 按 personKey 一人一份。
 */

export type FavoriteType = 'quote' | 'report'

export interface FavoriteRow {
  id: string
  openid: string
  type: FavoriteType
  payload: Record<string, unknown>
  person_key: string
  name: string
  created_at: string
}

export const FAVORITE_LIMIT = 50

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
    Taro.showToast({ title: '未登录，稍后再试', icon: 'none' })
    return null
  }
  return userId
}

/** 收藏名言（同句重复收藏 = 幂等 upsert） */
export async function favoriteQuote(
  personKey: string,
  name: string,
  quote: { text: string; context?: string; source?: string }
): Promise<boolean> {
  const userId = requireUserId()
  if (!userId) return false
  const id = makeFavoriteId(userId, 'quote', `${personKey}:${quote.text}`)
  const { error } = await table('favorites').upsert(
    {
      id,
      openid: userId,
      type: 'quote',
      payload: { text: quote.text, context: quote.context ?? '', source: quote.source ?? '据公开资料' },
      person_key: personKey,
      name,
      created_at: new Date().toISOString()
    },
    { onConflict: 'id' }
  )
  if (error) {
    diagLog('warn', 'db', `favorites 写入失败：${error.message ?? error}`)
    Taro.showToast({ title: '收藏失败，请重试', icon: 'none' })
    return false
  }
  track('favorite', { personKey, favoriteType: 'quote' })
  return true
}

/** 收藏报告（按 personKey 一人一份，幂等） */
export async function favoriteReport(
  personKey: string,
  name: string,
  meta: { heat: number; mode: string; generatedAt: string }
): Promise<boolean> {
  const userId = requireUserId()
  if (!userId) return false
  const id = makeFavoriteId(userId, 'report', personKey)
  const { error } = await table('favorites').upsert(
    {
      id,
      openid: userId,
      type: 'report',
      payload: meta,
      person_key: personKey,
      name,
      created_at: new Date().toISOString()
    },
    { onConflict: 'id' }
  )
  if (error) {
    diagLog('warn', 'db', `favorites(report) 写入失败：${error.message ?? error}`)
    Taro.showToast({ title: '收藏失败，请重试', icon: 'none' })
    return false
  }
  track('favorite', { personKey, favoriteType: 'report' })
  return true
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

/** 收藏列表（可按类型过滤，时间倒序，上限 50） */
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

export async function removeFavorite(id: string): Promise<void> {
  await table('favorites').delete().eq('id', id)
}
