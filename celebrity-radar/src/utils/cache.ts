import { table } from './db'
import { Report, buildReport, isRefusedResult } from './report'
import { FocusCode } from '@/config/filters'
import { fetchNews, hasSearchChannel, NewsItem } from './search'
import { parsePersonKey } from '@/config/domains'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { todayKey } from './time'
import { cooldownMinutesLeft } from './cooldown'
import { diagLog } from './cloud-diagnostics'
import type { ReportCacheRow, FeedCacheRow, RefreshQuotaRow } from '@/types/db'

/**
 * 报告/动态缓存（§3.7 两级缓存 + §2.4 缓存击穿互斥）。
 * 互斥实现：report_cache.state=building + builder 条件写入；
 * 抢锁失败方轮询 ≤30s；构建失败释放锁（delete 本人的 building 行）。
 *
 * 有效期策略：报告一旦 ready 即长期复用，不按时间自动过期；
 * 唯一的重生入口是用户点「刷新最新」（getOrBuildReport force=true）。
 */

// 构建者失联判定：单次构建上限为 LLM 60s 超时 + 检索 15s + 余量，90s 足够；
// 原值 5 分钟过长——一旦构建中途失败留下 building 脏行，期间所有查询都只能排队。
const BUILDING_TIMEOUT_MS = 90 * 1000
// 等待方轮询上限必须 ≥ 一次完整构建耗时（约 35s，最坏 75s），
// 原值 30s 短于构建时间，导致「同一个人被重复查询」时等待方必然超时报错。
const WAIT_TIMEOUT_MS = 75 * 1000
const POLL_INTERVAL_MS = 2000
const DAILY_REFRESH_LIMIT = 10

export type ReportOutcome =
  | {
      kind: 'report'
      report: Report
      fromCache: boolean
      /** force 刷新时带上「上一版」，供页面做变化对比；缓存命中时为 null */
      prev?: Report | null
    }
  | { kind: 'coldstart' } // 无联网素材 + 缓存为空（或强刷）：引导态
  | { kind: 'nonews' } // 抓取为空：暂未检索到
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

/**
 * 缓存可用判定：只要「已就绪且有报告」即可长期复用，不设时间上限。
 * 新鲜度交由页面上的「生成于 X 前 · 查看最新」提示与用户判断，不做自动过期重生。
 */
function isUsable(row: ReportCacheRow | null): row is ReportCacheRow & { report: Report } {
  return !!row && row.state === 'ready' && !!row.report
}

/**
 * 抢锁：无行时条件插入；已有行则条件更新（ready 过期 / building 失联超时可抢占）。
 *
 * 迁移注意：原实现靠 PostgREST 的 23505 唯一冲突码判断"行已存在"，CloudBase 不产生该错误码，
 * 照搬会导致缓存一旦有行就恒抛异常（抢占与等待逻辑全部失效）。改为先探测存在性，
 * 插入失败时再读一次以区分"并发中他人抢先"（lost）与"网络/权限真实失败"（抛给上层避免死等）。
 */
async function acquire(personKey: string, userId: string): Promise<'acquired' | 'lost'> {
  const now = new Date().toISOString()
  const existing = await getRow(personKey)

  if (!existing) {
    const { error } = await table('report_cache')
      .insert({ id: personKey, report: null, generated_at: now, state: 'building', builder: userId, search_meta: null })
      .select()
    if (!error) return 'acquired'
    const again = await getRow(personKey)
    if (again) return 'lost'
    throw new Error(error.message)
  }

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

/**
 * 落库并置 ready。必须校验命中行数：静默 0 行会让 state 永久停在 building，
 * 表现为缓存永不命中（每次进入都重新生成），且全程没有任何报错。
 */
async function saveReady(
  personKey: string,
  report: Report,
  newsCount: number,
  userId: string
): Promise<boolean> {
  const { data, error } = await table('report_cache')
    .update({ report, state: 'ready', generated_at: report.generatedAt, search_meta: { news_count: newsCount } })
    .eq('id', personKey)
    .select()
  if (error) {
    diagLog('error', 'db', `报告落库失败：${error.message ?? error}`)
  } else if (((data as unknown[]) ?? []).length === 0) {
    diagLog('error', 'db', `报告落库未命中任何行：${personKey}`)
  } else {
    return true
  }
  // 落库失败时必须清掉自己的 building 脏行：否则该行会以 state=building 残留，
  // 在 BUILDING_TIMEOUT_MS 内让**所有**查询该人物的请求都只能排队等待，且全程零报错。
  // 报告本身仍返回给本次用户，只是这一次不进缓存（下次重新生成，但不会再排队）。
  await release(personKey, userId).catch(() => undefined)
  return false
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
 *
 * focus 为发现页「关注」筛选（生成侧重）：**不参与缓存键**，
 * 缓存仍以 personKey 为唯一键，避免破坏关注流 / 个人页的只读缓存读取；
 * 侧重不一致时由报告页提示「重新生成以聚焦」，用户点刷新（force）后覆盖缓存。
 */
export async function getOrBuildReport(
  personKey: string,
  opts: { force?: boolean; focus?: FocusCode } = {}
): Promise<ReportOutcome> {
  const focus = opts.focus ?? 'all'
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

  // 1. 缓存命中（已就绪即复用；force=true 时跳过，进入重新生成）
  let row = await getRow(personKey)
  if (!opts.force && isUsable(row)) {
    track('report_hit_cache', { personKey })
    return { kind: 'report', report: row.report, fromCache: true }
  }

  /**
   * 本次生成前的旧报告，仅用于「刷新后告诉用户到底变了什么」。
   * 只在 isUsable 时取，且只在 force（用户主动点刷新）路径上带出：
   * 缓存命中场景用户没有发起任何动作，这时拿「相对上一版」说事会让人
   * 以为发生了他没要求的变更。不落库，纯内存传递。
   */
  const prevReport = isUsable(row) ? row.report : null

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
    if (isUsable(row)) {
      return { kind: 'report', report: row.report, fromCache: true }
    }
    return { kind: 'error', message: '报告正在生成中，请稍后查看' }
  }

  // 4. 我是构建者：博查检索 → LLM → 校验 → 落库
  try {
    const news = await fetchNews(name)

    if (news === null || news.length === 0) {
      // 无联网素材（搜索源不可用 / 抓取为空）：不生成，进引导态（§2.4）
      await release(personKey, userId)
      return { kind: news === null ? 'coldstart' : 'nonews' }
    }

    const res = await buildReport(personKey, name, news, focus)
    if (!res.ok) {
      await release(personKey, userId)
      return { kind: 'error', message: res.error }
    }
    if (isRefusedResult(res.data)) {
      await release(personKey, userId)
      return { kind: 'refused' }
    }
    const report = res.data
    await saveReady(personKey, report, news.length, userId)
    track('report_generate', { personKey, mode: 'realtime' })
    return { kind: 'report', report, fromCache: false, prev: prevReport }
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
  const detail = await getFeedDetail(personKey)
  return detail.items
}

/**
 * 关注流专用的详情版读取。
 *
 * getFeed 把「读失败」和「确实没有数据」都收敛成空数组，关注流因此无法区分二者，
 * 会把一次网络/权限故障渲染成「暂无公开动态」误导用户。这里额外带回 ok 与抓取时间。
 */
export async function getFeedDetail(
  personKey: string
): Promise<{ ok: boolean; items: NewsItem[]; fetchedAt: string | null }> {
  const { data, error } = await table('feed_cache').select('*').eq('id', personKey).maybeSingle()
  if (error) {
    diagLog('warn', 'db', `feed_cache 读取失败：${error.message ?? error}`)
    return { ok: false, items: [], fetchedAt: null }
  }
  const row = data as FeedCacheRow | null
  return { ok: true, items: row?.items ?? [], fetchedAt: row?.fetched_at ?? null }
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

/** 关注流下拉刷新：整次动作消耗 1 配额，刷新全部关注人物（博查上限 10 人次） */
export async function refreshAllFeeds(
  follows: Array<{ person_key: string; name: string }>
): Promise<{ ok: boolean; message: string; refreshed: number }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '未登录', refreshed: 0 }
  if (follows.length === 0) return { ok: true, message: '暂无关注', refreshed: 0 }
  /* 无本机 Key 也已可用（走平台代付），故这里判「有无通道」而非「有无 Key」 */
  if (!hasSearchChannel()) return { ok: false, message: '联网素材不可用，展示缓存动态', refreshed: 0 }

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

/** 关注流刷新：配额 → 博查检索 → feed_cache 更新 */
export async function refreshFeed(
  personKey: string,
  name: string
): Promise<{ ok: boolean; message?: string; items?: NewsItem[] }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '未登录' }
  if (!hasSearchChannel()) return { ok: false, message: '联网素材不可用' }

  const quota = await consumeRefreshQuota(userId)
  if (!quota.allowed) {
    return { ok: false, message: `今日刷新已达上限（${DAILY_REFRESH_LIMIT} 次），明日再来` }
  }

  const news = await fetchNews(name)
  if (!news) return { ok: false, message: '联网素材不可用' }
  if (news.length === 0) return { ok: true, items: [], message: `暂无新动态（剩余 ${quota.remaining} 次刷新）` }

  await table('feed_cache').upsert(
    { id: personKey, items: news, fetched_at: new Date().toISOString() },
    { onConflict: 'id' }
  )
  track('refresh_feed', { personKey })
  return { ok: true, items: news, message: `已更新（剩余 ${quota.remaining} 次刷新）` }
}
