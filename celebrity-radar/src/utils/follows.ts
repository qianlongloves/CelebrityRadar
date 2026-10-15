import Taro from '@tarojs/taro'
import { table } from './db'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { parsePersonKey } from '@/config/domains'
import { diagLog } from './cloud-diagnostics'
import { toastText } from './error'

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
      Taro.showToast({ title: toastText(error, '操作失败，请重试'), icon: 'none' })
      return null
    }
    track('unfollow', source ? { personKey, from: source } : { personKey })
    return false
  }

  /*
   * 关注人数**不设上限**（2026-10-13 移除）。
   *
   * 此前免费档 3 人 / 会员档 30 人的端上门禁（followGate + followLimitNote）已删除，
   * 新增关注一律放行。
   *
   * 为什么现在可以不设上限：关注数**原本就只在端上拦** —— `follows` 集合是「仅创建者可读写」、
   * 由端上直接写入，改包即可绕过，端上从来不是安全边界；而云端**没有**任何按关注数分档的校验
   * （对比：关键词监控 / 风险监控的新增已由 keywordAlert / riskWatch 在云端按 memberships 校验）。
   * 所以移除这道门禁后，关注数就是**完全不限**，并不是「云端还在兜底」。
   *
   * 成本上可以接受：关注动作本身不发起上游检索、不直接产生费用；成本发生在用户主动
   * 「抓取关注动态」时，那由 refreshPerDay 的每日次数上限（utils/member.ts）约束。
   * 若将来要让关注数驱动成本（例如按关注数预拉取动态），**必须先在云端补一道按 memberships
   * 分档的数量校验**，再回来决定要不要恢复端上提示 —— 端上单方面设限只会被改包绕过。
   */
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
    Taro.showToast({ title: toastText(error, '操作失败，请重试'), icon: 'none' })
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
    Taro.showToast({ title: toastText(error, '操作失败，请重试'), icon: 'none' })
    return false
  }
  track('unfollow', { personKey })
  return true
}
