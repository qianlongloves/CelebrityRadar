import { table } from './db'
import { useAuth } from '@/stores/auth'
import { diagLog } from './cloud-diagnostics'

/** 查询历史（§3.8 history）：主键 = openid#ts，每账号仅保留最近 50 条，写入时裁剪 */

export interface HistoryRow {
  id: string
  openid: string
  person_key: string
  name: string
  ts: string
  /**
   * 「我看的是哪一版」：打开报告页、真的看到正文时记下那一版的 `generatedAt`（N-2 回访判据）。
   *
   * 为什么挂在浏览历史这一行而不是新开一张表 / 新加一个本机键位：「我看过谁」本来就在这张表，
   * 而「我看到的是哪一版」与它同生共死 —— 同一行、同一次清理、同一次注销。分家之后必然出现
   * 「说得出他看过谁、说不出他看的是哪一版」，那种半份数据比没有更坏（见 utils/revisit.ts）。
   *
   * ⚠ **可空是本质，不是遗漏**：存量行（这次发版之前的所有浏览记录）、以及报告没读出来就退出的
   * 那几次访问，都没有这个值。判定侧必须把「没有它」当成**没有证据**，不能拿访问时间去顶替 ——
   * 否则「三天前看过他」会被读成「他的报告三天前变过」。
   */
  viewed_generated_at?: string
}

export const HISTORY_LIMIT = 50

/** 记录一次查询（连续查同一人不重复记；失败静默，不影响主流程） */
export async function addHistory(personKey: string, name: string): Promise<void> {
  const userId = useAuth.getState().userId
  if (!userId) return

  try {
    // 去重：最新一条已是同一人则跳过
    const { data: latest } = await table('history')
      .select('person_key')
      .eq('openid', userId)
      .order('ts', { ascending: false })
      .limit(1)
    if (latest && latest.length > 0 && latest[0].person_key === personKey) return

    const id = `${userId}#${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const { error } = await table('history').insert({
      id,
      openid: userId,
      person_key: personKey,
      name,
      ts: new Date().toISOString()
    })
    if (error) {
      diagLog('warn', 'db', `history 写入失败：${error.message ?? error}`)
      return
    }
    await pruneHistory(userId)
  } catch (err) {
    diagLog('warn', 'db', `history 异常：${String(err)}`)
  }
}

/**
 * 记下「我看到了这一版」（N-2 回访的判据）。
 *
 * 只**改**那一行已有的指纹，**不新增行**：浏览历史的写入是 addHistory 的职责，这一支越界去写
 * 就成了第二个写口（判「连续同一人跳过」的口径会分家，A→B→A 会多出第三条）。
 *
 * 幂等：报告页每次「看到正文」都会调它，值没变就不写库 —— 否则每进一次报告页都白付一次写。
 * 查不到该人的历史行时直接返回：那说明 addHistory 还没落库（两者并发发起）。报告页把这次调用
 * **挂在 addHistory 之后**（见 package/report 的 historyReadyRef），所以这里不需要重试/等待 ——
 * 重试是把「时序」偷换成「运气」，而失败后果其实很轻：这一版没有指纹，最多这次不产生回访理由
 * （下次再看一次就补上了），绝不会产生错的判据。
 */
export async function markReportViewed(personKey: string, version: string): Promise<void> {
  const userId = useAuth.getState().userId
  if (!userId || !version) return
  try {
    const { data: latest } = await table('history')
      .select('id,viewed_generated_at')
      .eq('openid', userId)
      .eq('person_key', personKey)
      .order('ts', { ascending: false })
      .limit(1)
    const row = latest && latest[0]
    if (!row || row.viewed_generated_at === version) return

    const { error } = await table('history').update({ viewed_generated_at: version }).eq('id', row.id)
    if (error) diagLog('warn', 'db', `history 版本指纹写入失败：${error.message ?? error}`)
  } catch (err) {
    diagLog('warn', 'db', `history 版本指纹异常：${String(err)}`)
  }
}

/** 裁剪：仅保留最近 50 条，溢出部分删除（best-effort） */
async function pruneHistory(userId: string): Promise<void> {
  try {
    const { data: overflow } = await table('history')
      .select('id')
      .eq('openid', userId)
      .order('ts', { ascending: false })
      .range(HISTORY_LIMIT, HISTORY_LIMIT + 99)
    if (overflow && overflow.length > 0) {
      await table('history').delete().in(
        'id',
        overflow.map((r: { id: string }) => r.id)
      )
    }
  } catch {
    /* 静默 */
  }
}

/** 最近历史（时间倒序，上限 50） */
export async function listHistory(): Promise<HistoryRow[]> {
  const userId = useAuth.getState().userId
  if (!userId) return []
  const { data, error } = await table('history')
    .select('*')
    .eq('openid', userId)
    .order('ts', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error) {
    diagLog('warn', 'db', `history 读取失败：${error.message ?? error}`)
    return []
  }
  return (data as HistoryRow[]) ?? []
}

/**
 * 「最近搜索」快捷入口用的精简列表：按名人去重 + 截断。
 *
 * 为什么读侧还要再去一次重：写入侧的「连续同一人跳过」只挡相邻的重复，
 * A → B → A 这种回访仍会留下两条同名记录，直接铺进首屏就是同一个人并排两个胶囊。
 * 按 person_key（名字#领域）保留最近一次：同名不同领域的两人是两份报告，仍各占一条。
 *
 * 历史页走的是 listHistory，保留完整流水，不受这里影响。
 */
export async function listRecentHistory(limit: number): Promise<HistoryRow[]> {
  const rows = await listHistory()
  const seen = new Set<string>()
  const out: HistoryRow[] = []
  for (const row of rows) {
    if (seen.has(row.person_key)) continue
    seen.add(row.person_key)
    out.push(row)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 清空查询历史。**失败必须让调用方知道**（与 removeFavorite 同理）：吞掉 error 的话，
 * 页面已经显示「已清空」并抹掉列表，下次进来记录又全在，用户只会以为「清空是假的」。
 * 返回是否真的清掉（未登录视作无需清、返回 true）。
 */
export async function clearHistory(): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return true
  const { error } = await table('history').delete().eq('openid', userId)
  if (error) {
    diagLog('warn', 'db', `history 清空失败：${error.message ?? error}`)
    return false
  }
  return true
}
