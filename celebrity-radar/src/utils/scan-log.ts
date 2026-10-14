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
