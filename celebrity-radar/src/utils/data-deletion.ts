import { table } from './db'
import { useAuth } from '@/stores/auth'
import { diagLog } from './cloud-diagnostics'

/**
 * 「清空我的数据」（§六.6）：本地设置 + 云端用户数据（follows / favorites / history）。
 * events 埋点按合规惯例保留（不可关联个人身份的匿名计数）。
 */
export async function clearAllMyData(): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return true // 未登录则只需清本地（调用方处理）

  try {
    await Promise.all([
      table('follows').delete().eq('openid', userId),
      table('favorites').delete().eq('openid', userId),
      table('history').delete().eq('openid', userId)
    ])
    return true
  } catch (err) {
    diagLog('error', 'db', `清空云端数据失败：${String(err)}`)
    return false
  }
}
