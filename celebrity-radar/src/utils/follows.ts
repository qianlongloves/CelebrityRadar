import Taro from '@tarojs/taro'
import { table } from './db'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { parsePersonKey } from '@/config/domains'
import { diagLog } from './cloud-diagnostics'
import { readMemberState } from './member'
import { followGate, followLimitNote } from './opinion-access'

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
    Taro.showToast({ title: '请先到「我的」页登录', icon: 'none' })
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

/**
 * 关注 / 取关切换。
 *
 * 返回切换后的状态：`true`=已关注、`false`=已取关、**`null`=操作失败或未登录**。
 *
 * 为什么失败要单独用 `null` 而不是沿用 `false`：`false` 同时表示「取关成功」与
 * 「操作失败」，调用方无从区分，会把失败当成成功、误报「已取消关注」（profile 页
 * 最初即如此）。另外取关的 delete 原先不检查 error，失败也是静默的。
 *
 * @param source 埋点来源标记（热门卡 / 候选卡 / 名人主页），仅用于分析
 */
export async function toggleFollow(personKey: string, source?: string): Promise<boolean | null> {
  const userId = requireUserId()
  if (!userId) return null
  const parsed = parsePersonKey(personKey)
  if (!parsed) return null

  const id = `${userId}#${personKey}`
  if (await isFollowed(personKey)) {
    const { error } = await table('follows').delete().eq('id', id)
    if (error) {
      diagLog('warn', 'db', `follows 取消失败：${error.message ?? error}`)
      Taro.showToast({ title: '操作失败，请重试', icon: 'none' })
      return null
    }
    track('unfollow', source ? { personKey, from: source } : { personKey })
    return false
  }

  /*
   * 新增关注前的分档门禁（P2，2026-10-13）：免费档最多 followLimit(false) 人、会员档
   * followLimit(true) 人（真源见 config/benefits.ts#OPINION_LIMITS）。
   *
   * ⚠ 判定**只在「新增」这一支**做 —— 上面的取消关注分支永远放行，listFollows 也从不截断：
   *   线上已有用户可能已关注超过免费档的人，那些数据必须原样保留、照常可看可用（含取关），
   *   超限只影响「继续新增」。任何把上限用在读 / 删 / 藏既有数据上的写法都是错的。
   * ⚠ 端上上限是**体验层不是安全边界**：关注数据由端上写入，改包可绕过（见
   *   utils/opinion-access.ts 文件头），这里只负责给用户一个合理的入口体验。
   */
  const isMember = (await readMemberState()).member
  if (!followGate((await listFollows()).length, isMember).allowed) {
    Taro.showToast({ title: followLimitNote(isMember), icon: 'none', duration: 2500 })
    return null
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
    return null
  }
  track('follow', source ? { personKey, from: source } : { personKey })
  return true
}

/** 取关（列表页显式操作：已确定处于关注态，省去一次 isFollowed 查询） */
export async function unfollow(personKey: string): Promise<boolean> {
  const userId = requireUserId()
  if (!userId) return false
  const { error } = await table('follows').delete().eq('id', `${userId}#${personKey}`)
  if (error) {
    diagLog('warn', 'db', `follows 取关失败：${error.message ?? error}`)
    Taro.showToast({ title: '操作失败，请重试', icon: 'none' })
    return false
  }
  track('unfollow', { personKey })
  return true
}
