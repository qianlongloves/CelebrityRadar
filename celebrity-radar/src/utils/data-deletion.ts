import { table } from './db'
import { useAuth } from '@/stores/auth'
import { diagLog } from './cloud-diagnostics'

/**
 * 「清空我的数据」（§六.6）：本地设置 + 云端用户数据
 * （follows / favorites / history / keyword_watches）。
 * events 埋点按合规惯例保留（不可关联个人身份的匿名计数）。
 *
 * keyword_watches 必须一起删：同一张表既存关键词订阅（type='keyword'）又存名人监控
 * （type='person'，含 person_key），键就是 openid，属 ACL.creator 用户数据。漏删会出现
 * 「界面说已清空、云端还在听」的静默背离（页面文案承诺「本机已读与删除记录随『清空我的数据』
 * 一并清除」）。风险信号 risk_signals / risk_scans 是 personKey 维度的共享扫描结果、不含 openid，
 * 不在「我的数据」范围内，故不删。
 */
export async function clearAllMyData(): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return true // 未登录则只需清本地（调用方处理）

  try {
    const results = await Promise.all([
      table('follows').delete().eq('openid', userId),
      table('favorites').delete().eq('openid', userId),
      table('history').delete().eq('openid', userId),
      table('keyword_watches').delete().eq('openid', userId)
    ])
    /*
     * ⚠ db 适配层**不会抛错**：db.ts#Builder.run 把异常吞掉并返回 `{ error }`
     * （见 src/utils/db.ts:288-294）。所以这里必须逐条看 `error` —— 只靠外层 try/catch 的话，
     * 云端删失败也会返回 true，页面照样提示「已清空」，是最典型的「界面说清了、云端还在」。
     */
    const failed = results.find((r) => r?.error)
    if (failed) {
      diagLog('error', 'db', `清空云端数据失败：${failed.error?.message ?? failed.error}`)
      return false
    }
    return true
  } catch (err) {
    diagLog('error', 'db', `清空云端数据失败：${String(err)}`)
    return false
  }
}
