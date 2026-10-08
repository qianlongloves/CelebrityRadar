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

export async function clearHistory(): Promise<void> {
  const userId = useAuth.getState().userId
  if (!userId) return
  await table('history').delete().eq('openid', userId)
}
