import { diagLog } from './cloud-diagnostics'
import { table } from './db'
import type { ScanLogRow } from '@/types/db'

/**
 * 监控执行日志（scan_logs，2026-10-14）。
 *
 * 云函数 keywordAlert / riskWatch 每轮对每个「进入扫描队列」的对象写一条日志
 * （成功 / 跳过 / 失败），端上只读。预警页据此把「监控对象 → 最近执行状态」做成表格，
 * 并把「执行历史」列出来 —— 用户能看到的不只是「现在有什么新东西」，还有「上一次
 * 是什么时候、结果如何、有没有失败」。
 *
 * 日志是**全局共享**的（与 keywords 缓存 / risk_scans 快照同一哲学：同一个词被多人
 * 订阅只打一次上游，也只写一条日志），所以这里按「我订阅的对象键」去 in 查询，而不是
 * 按 openid 过滤（日志行里根本没有 openid）。
 */

/** 每类监控对象最多展示多少条最近执行日志 */
export const SCAN_LOGS_MAX = 20

/** 执行状态 → 表格里给人看的一行字 */
export const SCAN_STATUS_LABEL: Record<ScanLogRow['status'], string> = {
  ok: '成功',
  skipped: '跳过',
  error: '失败'
}

/**
 * 读监控执行日志：kind 指定一路（keyword / person），objectKeys 限定「我订阅的对象」。
 * 空名单直接返回空数组（不发请求）；读到最新在前，端上再按对象分组取最新一条。
 */
export async function loadScanLogs(kind: ScanLogRow['kind'], objectKeys: string[]): Promise<ScanLogRow[]> {
  if (!objectKeys || objectKeys.length === 0) return []
  const want = Math.min(SCAN_LOGS_MAX * objectKeys.length, 100)
  const { data, error } = await table('scan_logs')
    .select('*')
    .eq('kind', kind)
    .in('object_key', objectKeys)
    .order('ran_at', { ascending: false })
    .limit(want)
  if (error) {
    diagLog('warn', 'db', `scan_logs(${kind}) 读取失败：${error.message ?? error}`)
    return []
  }
  return Array.isArray(data) ? (data as ScanLogRow[]) : []
}

/**
 * 每个对象取「最新一条」日志（loadScanLogs 已按 ran_at 倒序，先到先得）。
 * 用来给监控对象表格的「最近执行 / 状态 / 命中」列填数。
 */
export function latestLogByKey(logs: ScanLogRow[]): Map<string, ScanLogRow> {
  const m = new Map<string, ScanLogRow>()
  for (const l of logs) {
    if (!l || !l.object_key) continue
    if (!m.has(l.object_key)) m.set(l.object_key, l)
  }
  return m
}

/**
 * 「命中 / 结果」这一格的唯一算法（2026-10-17 抽出）。
 *
 * 此前预警页里写了**两份等价但不同形的表达式**（关键词那路 `log ? 新 x / 共 y : …`，
 * 名人那路 `log ? … : scan ? … : grp ? … : '—'`），它们对「扫过但没命中」「没扫过」
 * 「有存量但没执行记录」三种情况的说法不一致 —— 同一块 UI 上并排两张表，两张表的
 * 「—」含义却不一样，用户没法比。
 *
 * 约定（三处统一）：
 *   · 本轮**有执行记录** ⇒ `新 N / 共 M`（N 可以是 0：那是"扫了没新东西"，不是"没扫过"）；
 *   · 没有执行记录但有存量 ⇒ `共 M 条`；
 *   · 两者都没有 ⇒ `—`（**不写「共 0 条」**：那读起来像"扫过了、结果是空的"）。
 *
 * @param hit  本轮新命中；`undefined` = 没有执行记录（**0 是有效值**，别写成假值判断）
 * @param total 累计条数（快照的 signals_total 优先，读到的条数兜底，见 riskSignalTotal）
 */
export function monitorResultText(hit?: number | null, total?: number | null): string {
  const n = typeof total === 'number' && Number.isFinite(total) ? total : 0
  if (typeof hit === 'number' && Number.isFinite(hit)) return `新 ${hit} / 共 ${n}`
  return n > 0 ? `共 ${n} 条` : '—'
}

/**
 * 累计条数口径：快照里云端写下的 `signals_total` 优先，读到的行数兜底。
 *
 * 为什么不用 `??`：`signals_total` 列为空（老数据 / 写入时被截断）时会落到兜底，
 * 这是对的；但 NaN（上游给了个坏数）用 `??` 会**原样透出**，表格里就会显示「共 NaN 条」。
 * 所以判据是「是不是有限数」，而不是「是不是 null」。
 */
export function riskSignalTotal(scan: { signals_total?: number } | undefined, loaded: number): number {
  const n = scan?.signals_total
  return typeof n === 'number' && Number.isFinite(n) ? n : loaded
}
