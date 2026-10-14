import { table } from './db'
import { useAuth } from '@/stores/auth'
import { diagLog } from './cloud-diagnostics'
import { callCloudFunction } from './cloud'

/**
 * 「清空我的数据」（§六.6）：本地设置 + 云端用户数据
 * （follows / favorites / history / keyword_watches / events）。
 *
 * keyword_watches 必须一起删：同一张表既存关键词订阅（type='keyword'）又存名人监控
 * （type='person'，含 person_key），键就是 openid，属 ACL.creator 用户数据。漏删会出现
 * 「界面说已清空、云端还在听」的静默背离（页面文案承诺「本机已读与删除记录随『清空我的数据』
 * 一并清除」）。
 *
 * events 埋点也必须删：`track()` 把 openid 一并写入（见 utils/events.ts），它是**可关联到人**
 * 的个人信息、并非匿名计数；隐私政策「保存期限」条明确承诺「行为计数随『清空数据』或注销一并删除」，
 * （原来这里写的是「第 1.7 条」——2026-10-14 政策新增「委托处理与最小化」一条后编号顺移为 1.8，
 *  故改为**引标题不引编号**：政策条目会随复核增删而顺移，写死编号必然过期。）
 * 故这里必须一并删。风险信号 risk_signals / risk_scans 是 personKey 维度的共享扫描结果、
 * 不含 openid，不在「我的数据」范围内，故不删。
 */
export async function clearAllMyData(): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return true // 未登录则只需清本地（调用方处理）

  try {
    const results = await Promise.all([
      table('follows').delete().eq('openid', userId),
      table('favorites').delete().eq('openid', userId),
      table('history').delete().eq('openid', userId),
      table('keyword_watches').delete().eq('openid', userId),
      table('events').delete().eq('openid', userId)
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

/**
 * 注销账号（P1-4）：删除云端**全部个人信息**并解除登录态。
 *
 * 与「清空我的数据」的区别：本动作连账号本身一起删（users / memberships / 用量 / 埋点 /
 * 舆情状态），订单按法定留存要求去标识化保留；删除后不可恢复，端上必须先二次确认。
 *
 * 删除集中在云函数 `userInit(action:'deleteAccount')` 里做 —— 端上只能删「自己那一行」，
 * 而用量表 / 会员表 / 埋点表分属不同 ACL，端上没有批量删除的权限，也不该有。
 */
export async function deleteAccount(): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = (await callCloudFunction('userInit', { action: 'deleteAccount' })) as
      | { ok?: boolean; error?: string; failed?: string[] }
      | null
    if (!res || res.ok !== true) {
      const reason = (res && res.error) || (res && res.failed && res.failed.join('；')) || '注销失败'
      diagLog('error', 'db', `注销账号失败：${reason}`)
      return { ok: false, message: reason }
    }
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('error', 'db', `注销账号失败：${msg}`)
    return { ok: false, message: msg }
  }
}
