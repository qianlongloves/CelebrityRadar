import { table } from './db'
import { Report, buildReport, isRefusedResult } from './report'
import { fetchNews, NewsItem } from './search'
import { isKnowledgeModeEnabled, getTavilyKey } from './settings'
import { parsePersonKey } from '@/config/domains'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { todayKey } from './time'
import { cooldownMinutesLeft } from './cooldown'
import { diagLog } from './workbuddy-cloud-diagnostics'
import type { ReportCacheRow, FeedCacheRow, RefreshQuotaRow } from '@/types/db'

/**
 * 报告/动态缓存（§3.7 两级缓存 + §2.4 缓存击穿互斥）。
 * 互斥实现：report_cache.state=building + builder 条件写入；
 * 抢锁失败方轮询 ≤30s；构建失败释放锁（delete 本人的 building 行）。
 */

const REPORT_TTL_MS = 24 * 3600 * 1000
const BUILDING_TIMEOUT_MS = 5 * 60 * 1000 // 构建者失联判定
const WAIT_TIMEOUT_MS = 30 * 1000
const POLL_INTERVAL_MS = 2000
const DAILY_REFRESH_LIMIT = 10

export type ReportOutcome =
  | { kind: 'report'; report: Report; fromCache: boolean }
  | { kind: 'coldstart' } // 无 key + 缓存为空（或无 key 强刷）：引导配置搜索源
  | { kind: 'nonews' } // 抓取为空且知识模式未开：暂未检索到
  | { kind: 'refused' }
  | { kind: 'error'; message: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getRow(personKey: string): Promise<ReportCacheRow | null> {
  const { data, error } = await table('report_cache').select('*').eq('id', personKey).maybeSingle()
  if (error) diagLog('warn', 'db', `report_cache 读取失败：${error.message ?? error}`)
  return ((data as ReportCacheRow) ?? null)
}

function isFresh(row: ReportCacheRow): boolean {
  return (
    row.state === 'ready' &&
    !!row.report &&
    Date.now() - Date.parse(row.generated_at) < REPORT_TTL_MS
  )
}

/** 抢锁：先条件插入（无行时成功），冲突则条件更新（ready/超时 building 可抢占） */
async function acquire(personKey: string, userId: string): Promise<'acquired' | 'lost'> {
  const now = new Date().toISOString()
  const { error: insErr } = await table('report_cache')
    .insert({ id: personKey, report: null, generated_at: now, state: 'building', builder: userId, search_meta: null })
    .select()

  if (!insErr) return 'acquired'
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const code = (insErr as any)?.code
  if (code !== '23505') {
    // 非主键冲突（网络/权限等）——当 lost 处理会死等，直接抛给上层
    throw new Error(insErr.message ?? String(insErr))
  }

  // 行已存在：ready 过期 或 building 失联超时 才可抢占
  const expireIso = new Date(Date.now() - BUILDING_TIMEOUT_MS).toISOString()
  const { data: upd, error: updErr } = await table('report_cache')
    .update({ state: 'building', builder: userId, generated_at: now, report: null })
    .eq('id', personKey)
    .or(`state.eq.ready,generated_at.lt.${expireIso}`)
    .select()
  if (updErr) throw new Error(updErr.message ?? String(updErr))
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return ((upd as any[])?.length ?? 0) > 0 ? 'acquired' : 'lost'
}

/** 释放锁：只删本人的 building 行（他人持锁不动） */
async function release(personKey: string, userId: string): Promise<void> {
  await table('report_cache').delete().eq('id', personKey).eq('builder', userId).eq('state', 'building')
  diagLog('info', 'db', `释放 building 锁：${personKey}`)
}

async function saveReady(personKey: string, report: Report, newsCount: number): Promise<void> {
  await table('report_cache')
    .update({ report, state: 'ready', generated_at: report.generatedAt, search_meta: { news_count: newsCount } })
    .eq('id', personKey)
}

/** 他人 building：轮询等待 ready（≤30s） */
async function waitForReady(personKey: string): Promise<Report | null> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const row = await getRow(personKey)
    if (row?.state === 'ready' && row.report) return row.report
    if (!row) return null // 构建者失败，锁已释放
  }
  return null
}

/**
 * 报告读取主入口（附录 C + §2.4 边界）。
 * force=true 为强制刷新（无 key 用户同样会走 coldstart 引导，§3.7）。
 */
export async function getOrBuildReport(
  personKey: string,
  opts: { force?: boolean } = {}
): Promise<ReportOutcome> {
  const userId = useAuth.getState().userId ?? 'anonymous'
  const parsed = parsePersonKey(personKey)
  if (!parsed) return { kind: 'error', message: `非法 personKey：${personKey}` }
  const { name } = parsed

  // 0. 冷却检查（§5.4 用例 9）：搜索源 / LLM 超配额或连续失败后 10 分钟内不再发起
  for (const label of ['search', 'llm'] as const) {
    const left = cooldownMinutesLeft(label)
    if (left > 0) {
      return { kind: 'error', message: `服务繁忙（约 ${left} 分钟后恢复），请稍后再试` }
    }
  }

  // 1. 缓存命中（TTL 内）
  let row = await getRow(personKey)
  if (!opts.force && row && isFresh(row) && row.report) {
    track('report_hit_cache', { personKey })
    return { kind: 'report', report: row.report, fromCache: true }
  }

  // 2. 抢锁
  let acquired: boolean
  try {
    acquired = (await acquire(personKey, userId)) === 'acquired'
  } catch (err) {
    return { kind: 'error', message: `缓存服务异常：${err instanceof Error ? err.message : String(err)}` }
  }

  // 3. 抢锁失败：等待他人构建（缓存击穿防护，§2.4）
  if (!acquired) {
    const report = await waitForReady(personKey)
    if (report) {
      track('report_hit_cache', { personKey })
      return { kind: 'report', report, fromCache: true }
    }
    row = await getRow(personKey)
    if (row && isFresh(row) && row.report) {
      return { kind: 'report', report: row.report, fromCache: true }
    }
    return { kind: 'error', message: '报告正在生成中，请稍后查看' }
  }

  // 4. 我是构建者：Tavily → LLM → 校验 → 落库
  try {
    const news = await fetchNews(name)

    if (news === null) {
      // 无 key：知识模式显式开启才生成，否则引导态（§2.4）
      if (!isKnowledgeModeEnabled()) {
        await release(personKey, userId)
        return { kind: 'coldstart' }
      }
      const res = await buildReport(personKey, name, null)
      if (!res.ok) {
        await release(personKey, userId)
        return { kind: 'error', message: res.error }
      }
      if (isRefusedResult(res.data)) {
        await release(personKey, userId)
        return { kind: 'refused' }
      }
      const report = res.data
      await saveReady(personKey, report, 0)
      track('report_generate', { personKey, mode: 'knowledge' })
      return { kind: 'report', report, fromCache: false }
    }

    if (news.length === 0) {
      // 抓取为空：默认不进知识模式（§2.4）
      await release(personKey, userId)
      return { kind: 'nonews' }
    }

    const res = await buildReport(personKey, name, news)
    if (!res.ok) {
      await release(personKey, userId)
      return { kind: 'error', message: res.error }
    }
    if (isRefusedResult(res.data)) {
      await release(personKey, userId)
      return { kind: 'refused' }
    }
    const report = res.data
    await saveReady(personKey, report, news.length)
    track('report_generate', { personKey, mode: 'realtime' })
    return { kind: 'report', report, fromCache: false }
  } catch (err) {
    await release(personKey, userId).catch(() => undefined)
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/* ===== 动态缓存 + 刷新配额（§3.7） ===== */

/** 只读缓存（不触发生成、不抢锁）：名人主页 / 关注流用 */
export async function getCachedReport(personKey: string): Promise<Report | null> {
  const row = await getRow(personKey)
  return row?.state === 'ready' ? row.report : null
}

export async function getFeed(personKey: string): Promise<NewsItem[]> {
  const { data, error } = await table('feed_cache').select('*').eq('id', personKey).maybeSingle()
  if (error) diagLog('warn', 'db', `feed_cache 读取失败：${error.message ?? error}`)
  return ((data as FeedCacheRow | null)?.items) ?? []
}

/**
 * 检查并消耗一次刷新配额（每账号/日 ≤10，§3.8）。
 * MVP 用读-改-写（竞态可接受，少量超发无害）；原子自增待 rpc 优化。
 */
export async function consumeRefreshQuota(userId: string): Promise<{ allowed: boolean; remaining: number }> {
  const id = `${userId}#${todayKey()}`
  const { data, error } = await table('refresh_quota').select('*').eq('id', id).maybeSingle()
  if (error) diagLog('warn', 'db', `refresh_quota 读取失败：${error.message ?? error}`)
  const row = data as RefreshQuotaRow | null
  const count = row?.count ?? 0
  if (count >= DAILY_REFRESH_LIMIT) {
    return { allowed: false, remaining: 0 }
  }
  if (!row) {
    await table('refresh_quota').insert({ id, count: 1 })
  } else {
    await table('refresh_quota').update({ count: count + 1 }).eq('id', id)
  }
  return { allowed: true, remaining: DAILY_REFRESH_LIMIT - count - 1 }
}

/** 关注流下拉刷新：整次动作消耗 1 配额，刷新全部关注人物（Tavily 上限 10 人次） */
export async function refreshAllFeeds(
  follows: Array<{ person_key: string; name: string }>
): Promise<{ ok: boolean; message: string; refreshed: number }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '未登录', refreshed: 0 }
  if (follows.length === 0) return { ok: true, message: '暂无关注', refreshed: 0 }
  if (getTavilyKey() === null) return { ok: false, message: '未配置搜索源 key，展示缓存动态', refreshed: 0 }

  const quota = await consumeRefreshQuota(userId)
  if (!quota.allowed) {
    return { ok: false, message: `今日刷新已达上限（${DAILY_REFRESH_LIMIT} 次），明日再来`, refreshed: 0 }
  }

  let refreshed = 0
  for (const f of follows.slice(0, 10)) {
    try {
      const news = await fetchNews(f.name)
      if (news && news.length > 0) {
        await table('feed_cache').upsert(
          { id: f.person_key, items: news, fetched_at: new Date().toISOString() },
          { onConflict: 'id' }
        )
        refreshed++
      }
    } catch (err) {
      diagLog('warn', 'http', `feed 刷新失败（${f.name}）：${String(err)}`)
    }
  }
  track('refresh_feed', { count: follows.length })
  return { ok: true, message: `已刷新 ${refreshed} 位名人（剩余 ${quota.remaining} 次刷新）`, refreshed }
}

/** 关注流刷新：配额 → Tavily → feed_cache 更新 */
export async function refreshFeed(
  personKey: string,
  name: string
): Promise<{ ok: boolean; message?: string; items?: NewsItem[] }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '未登录' }
  if (!fetchNewsHasKey()) return { ok: false, message: '未配置搜索源 key' }

  const quota = await consumeRefreshQuota(userId)
  if (!quota.allowed) {
    return { ok: false, message: `今日刷新已达上限（${DAILY_REFRESH_LIMIT} 次），明日再来` }
  }

  const news = await fetchNews(name)
  if (!news) return { ok: false, message: '未配置搜索源 key' }
  if (news.length === 0) return { ok: true, items: [], message: `暂无新动态（剩余 ${quota.remaining} 次刷新）` }

  await table('feed_cache').upsert(
    { id: personKey, items: news, fetched_at: new Date().toISOString() },
    { onConflict: 'id' }
  )
  track('refresh_feed', { personKey })
  return { ok: true, items: news, message: `已更新（剩余 ${quota.remaining} 次刷新）` }
}

function fetchNewsHasKey(): boolean {
  // 与 fetchNews 同源判断（无 key 直接降级，不发请求）
  return getTavilyKey() !== null
}
