import { callCloudFunction } from './cloud'
import { diagLog } from './cloud-diagnostics'
import { REPORT_SCHEMA_VERSION } from './report'
import type { Report } from './report'
import type { NewsItem } from './search'

/**
 * 共享缓存的**云端写口**（P0-2，2026-10-09）。
 *
 * 背景：`report_cache` / `feed_cache` 是全局共享的事实源（报告那张还兼作生成互斥锁），
 * 原先对客户端是「所有人可读、登录可写」——`db.ts` 一次的 `table('report_cache').upsert()`
 * 就能覆盖任意人物的报告正文、抹掉会员段、或写 `state=building` 让全站对该人物排队。
 * 权限收紧为「客户端只读」之后，写入只能走 `aiProxy` 的 `action:'report'`（实现见
 * `cloudfunctions/aiProxy/report-store.js`），本文件是它**唯一**的端上出入口。
 *
 * 三种返回语义刻意区分开（这是整套平滑迭代的关键）：
 *   · `saved` / `acquired` / `lost` —— 写口正常应答，以它为准；
 *   · `rejected` —— 写口**明确拒绝**（`auth` / `badrequest` / `lock` / `abuse`）。
 *     这时**不得回退端上直写**，否则等于绕过写口刚刚拒掉的那道校验；
 *   · `unavailable` —— 通道不可用（函数未部署 / 网络抖动 / `upstream`）。
 *     这时回退端上直写，功能与收紧前完全一致。
 *
 * 为什么不做成「一律回退」（如 quota-guard.ts 那样）：那边回退没有安全含义（端上自己算一遍
 * 而已），这边回退意味着**绕过服务端校验去写共享数据**，两种情形必须分开。
 */

type StoreReply =
  | { kind: 'ok'; result: string }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }

/**
 * 写口明确拒绝的 kind 名单：这些是「请求本身有问题」，不适用回退。
 *
 * `lock` 是「没抢到/已被接管的锁」，`abuse` 是写口限速，`auth` / `badrequest` 是入参或身份，
 * `stale`（P1-9）是「既有版本含会员段、不接受把它覆盖成不含会员段」——
 * 它必须在这里：落到 `unavailable` 就会**回退端上直写**，正好把云端刚拦下的那次覆盖写进去。
 */
const REJECTED_KINDS = ['auth', 'badrequest', 'lock', 'abuse', 'stale']

async function callStore(payload: Record<string, unknown>): Promise<StoreReply> {
  let res: unknown
  try {
    res = await callCloudFunction('aiProxy', { action: 'report', ...payload })
  } catch (err) {
    /* 函数未部署 / 环境未配置 / 网络失败：一律按「通道不可用」处理，由调用方回退直写 */
    diagLog('warn', 'db', `缓存写口调用失败，回退端上直写：${err instanceof Error ? err.message : String(err)}`)
    return { kind: 'unavailable' }
  }

  const reply = res as { ok?: boolean; kind?: string; error?: string; result?: string } | null
  if (reply && reply.ok === true) {
    return { kind: 'ok', result: typeof reply.result === 'string' ? reply.result : '' }
  }
  if (reply && typeof reply.kind === 'string' && REJECTED_KINDS.indexOf(reply.kind) >= 0) {
    diagLog('warn', 'db', `缓存写口拒绝（${reply.kind}）：${reply.error || '未说明原因'}`)
    return { kind: 'rejected' }
  }
  /* 落到这里的还有「旧版 aiProxy 不认 action=report」（返回未知 action）——同样是通道未就绪 */
  diagLog('warn', 'db', `缓存写口不可用，回退端上直写：${reply?.error || '无返回'}`)
  return { kind: 'unavailable' }
}

/**
 * 抢锁。返回 `unavailable` 表示写口没通（调用方回退端上直写），
 * `degraded` 表示写口明确拒绝（限速 / 参数被拒）——此时**不写缓存但照常出报告**。
 */
export async function acquireLockViaCloud(
  personKey: string
): Promise<'acquired' | 'lost' | 'degraded' | 'unavailable'> {
  const reply = await callStore({
    op: 'acquire',
    personKey,
    schemaVersion: REPORT_SCHEMA_VERSION
  })
  if (reply.kind === 'unavailable') return 'unavailable'
  if (reply.kind === 'rejected') return 'degraded'
  return reply.result === 'acquired' ? 'acquired' : 'lost'
}

/**
 * 放锁（best-effort）。`rejected` 也按「已处理」返回：锁没放掉最坏是让该行
 * 以 `building` 残留到 `BUILDING_TIMEOUT_MS`（90s）后由他人抢占，不该为此去绕过写口。
 */
export async function releaseLockViaCloud(personKey: string): Promise<'done' | 'unavailable'> {
  const reply = await callStore({ op: 'release', personKey })
  return reply.kind === 'unavailable' ? 'unavailable' : 'done'
}

/** 报告落库。`rejected` = 写口明确拒绝，调用方**不得**回退直写（见文件头说明） */
export async function saveReportViaCloud(
  personKey: string,
  report: Report,
  newsCount: number
): Promise<'saved' | 'rejected' | 'unavailable'> {
  const reply = await callStore({
    op: 'save',
    personKey,
    report,
    newsCount,
    schemaVersion: REPORT_SCHEMA_VERSION
  })
  if (reply.kind === 'ok' && reply.result === 'saved') return 'saved'
  if (reply.kind === 'rejected') return 'rejected'
  return 'unavailable'
}

/** 动态列表落库，语义同 saveReportViaCloud */
export async function saveFeedViaCloud(
  personKey: string,
  items: NewsItem[]
): Promise<'saved' | 'rejected' | 'unavailable'> {
  const reply = await callStore({ op: 'saveFeed', personKey, items, fetchedAt: new Date().toISOString() })
  if (reply.kind === 'ok' && reply.result === 'saved') return 'saved'
  if (reply.kind === 'rejected') return 'rejected'
  return 'unavailable'
}
