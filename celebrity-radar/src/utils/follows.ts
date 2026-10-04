import Taro from '@tarojs/taro'
import { table } from './db'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { parsePersonKey } from '@/config/domains'
import { diagLog } from './workbuddy-cloud-diagnostics'

/** 关注列表（§3.8 follows，主键 = openid#personKey） */
export interface FollowRow {
  id: string
  openid: string
  person_key: string
  name: string
  domain: string
  followed_at: string
}

function requireUserId(): string | null {
  const userId = useAuth.getState().userId
  if (!userId) {
    Taro.showToast({ title: '未登录，稍后再试', icon: 'none' })
    return null
  }
  return userId
}

/** 我的关注列表（按关注时间倒序） */
export async function listFollows(): Promise<FollowRow[]> {
  const userId = useAuth.getState().userId
  if (!userId) return []
  const { data, error } = await table('follows')
    .select('*')
    .eq('openid', userId)
    .order('followed_at', { ascending: false })
  if (error) {
    diagLog('warn', 'db', `follows 读取失败：${error.message ?? error}`)
    return []
  }
  return ((data as FollowRow[]) ?? [])
}

export async function isFollowed(personKey: string): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  const { data } = await table('follows').select('id').eq('id', `${userId}#${personKey}`).maybeSingle()
  return !!data
}

/** 关注 / 取关切换，返回切换后的状态（true=已关注） */
export async function toggleFollow(personKey: string): Promise<boolean> {
  const userId = requireUserId()
  if (!userId) return false
  const parsed = parsePersonKey(personKey)
  if (!parsed) return false

  const id = `${userId}#${personKey}`
  if (await isFollowed(personKey)) {
    await table('follows').delete().eq('id', id)
    track('unfollow', { personKey })
    return false
  }
  const { error } = await table('follows').insert({
    id,
    openid: userId,
    person_key: personKey,
    name: parsed.name,
    domain: parsed.domain,
    followed_at: new Date().toISOString()
  })
  if (error) {
    diagLog('warn', 'db', `follows 写入失败：${error.message ?? error}`)
    Taro.showToast({ title: '操作失败，请重试', icon: 'none' })
    return false
  }
  track('follow', { personKey })
  return true
}
