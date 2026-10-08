import { table } from './db'
import { Report, buildReport, isRefusedResult } from './report'
import { FocusCode } from '@/config/filters'
import { fetchNews, hasSearchChannel, DEEP_MAIN_COUNT, DEEP_SOCIAL_COUNT, NewsItem } from './search'
import { parsePersonKey } from '@/config/domains'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { todayKey } from './time'
import { cooldownMinutesLeft } from './cooldown'
import { peekGenerateQuota, consumeGenerateQuota } from './quota'
import { quotaExhaustedMessage } from './member'
import { incrQuotaViaCloud } from './quota-guard'
import { REFRESH_QUOTA_DISABLED } from './debug'
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
 * 落库并置 ready。
 *
 * 用 upsert（等价 doc(id).set，整篇替换）而非 where().update()：
 * CloudBase 的 update 对嵌套对象走「点号路径」语义，而 acquire 占位时写入的 report 是 null，
 * 往 null 上写 report.analysis 这类子字段会被数据库直接拒绝：
 *   [FailedOperation] Cannot create field 'analysis' in element {report: null}
 * 后果是落库恒失败 → state 永久停在 building → 缓存永不命中（每次进入都重新生成），
 * 且只有一条 warn 日志，极易被误判成「LLM 通道坏了」。
 * doc(id).set 是整篇替换，对 report / search_meta 的初值没有任何要求，从根上绕开该差异。
 */
async function saveReady(
  personKey: string,
  report: Report,
  newsCount: number,
  userId: string
): Promise<boolean> {
  const { error } = await table('report_cache').upsert({
    id: personKey,
    report,
    state: 'ready',
    generated_at: report.generatedAt,
    builder: null,
    search_meta: { news_count: newsCount }
  })
  if (!error) return true
  diagLog('error', 'db', `报告落库失败：${error.message ?? error}`)
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

  // 0. 缓存命中优先（随用随查）：已生成的报告读取零成本，不受冷却影响。
  //    冷却检查后置到第 1.5 步，只拦「重新生成」，不拦「看已有报告」。
  let row = await getRow(personKey)
  if (!opts.force && isUsable(row)) {
    track('report_hit_cache', { personKey })
    return { kind: 'report', report: row.report, fromCache: true }
  }

  // 1. 冷却检查（§5.4 用例 9）：仅拦截需要真实发起搜索/生成的路径。
  //    注意 setCooldown 现在只由「限流 / 网络 / 上游 5xx」触发（见 report.ts、search.ts），
  //    密钥/额度类错误不再进入冷却，修好配置即可立刻重试。
  for (const label of ['search', 'llm'] as const) {
    const left = cooldownMinutesLeft(label)
    if (left > 0) {
      const what = label === 'search' ? '搜索源' : '生成服务'
      return { kind: 'error', message: `${what}限流冷却中（约 ${left} 分钟），已生成的报告不受影响；可先浏览其他名人` }
    }
  }

  /**
   * 本次生成是否走「深度模式」（O-11）：会员的素材加厚 + 报告多两段专属文字。
   * 会员态**顺带**取自上方的配额检查（peekGenerateQuota 已带回 member），不额外读一次库；
   * 检查失败（catch 分支）时保持 false —— 放行的是免费口径，宁可少给不可误给。
   */
  let memberDeep = false

  // 1.5 生成配额检查（freemium 免费层）：只拦「真实发起生成」的路径。
  //     缓存命中已在上方返回（不计数、不受限）；配额用完仍可浏览所有已生成报告。
  try {
    const quota = await peekGenerateQuota(userId)
    if (!quota.allowed) {
      return {
        kind: 'error',
        message: quotaExhaustedMessage(quota.member, quota.limit, '已生成的报告仍可正常浏览')
      }
    }
    memberDeep = quota.member
  } catch (err) {
    /* 配额服务异常不拦生成：宁可少量超发，不可让所有人无法生成（与冷却的降级哲学一致） */
    diagLog('warn', 'db', `配额检查失败，放行本次生成：${err instanceof Error ? err.message : String(err)}`)
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
    /*
     * 深度模式（O-11）：会员的报告生成走加厚检索，主线 / 支线各加厚一档（见 search.ts 的 DEEP_*）。
     * ⚠ 全文件**只有这一处**加厚：下面 refreshAllFeeds / refreshFeed 的两处 fetchNews 是每日
     *   10 次的常态动作，放大等于常态成本翻倍而用户几乎无感，刻意维持免费口径。
     * 真闸门在云函数（非会员改包要 40 也会被钳回 20），这里只是「要多少」。
     */
    const news = await fetchNews(
      name,
      memberDeep ? { maxResults: DEEP_MAIN_COUNT, socialCount: DEEP_SOCIAL_COUNT } : {}
    )

    if (news === null || news.length === 0) {
      // 无联网素材（搜索源不可用 / 抓取为空）：不生成，进引导态（§2.4）
      await release(personKey, userId)
      return { kind: news === null ? 'coldstart' : 'nonews' }
    }

    const res = await buildReport(personKey, name, news, focus, { member: memberDeep })
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
    /*
     * 配额只在「用户真的拿到报告」时消耗（公平计费，口径见 utils/quota.ts 文件头）：
     *   上方的 refused / error / coldstart / nonews 分支均已提前 return，不计数；
     *   缓存命中（第 0 步 / 抢锁失败等待他人构建）也在上方返回，同样不计数。
     *   ⚠ 本行位于 saveReady 之后：落库失败会抛到下面的 catch，此时用户拿不到报告 → 不计数。
     *   best-effort：计数写失败不影响本次返回，少量丢失可接受（宁可少算不多算）。
     */
    void consumeGenerateQuota(userId)
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

/**
 * 批量只读缓存：一次 `in` 取回多人的报告，供「候选列表」这类**进来就要筛一遍**的场景用
 * （当前调用方是底部菜单「AI 提问」页，见 pages/ask）。
 *
 * 为什么不让调用方循环 getCachedReport：`report_cache` 以 personKey 为主键，逐个查是 N 次
 * 云数据库往返；而这个页面是 tabBar 页，每次切回来都会重跑 —— 8 个人就是 8 次往返，纯浪费。
 *
 * 命中判定与 getCachedReport **完全一致**（state=ready 且有 report），返回数组与入参一一对应、
 * 缺位为 null（调用方可直接 filter），读失败时同样退化为全 null 而不是抛错。
 */
export async function getCachedReports(personKeys: string[]): Promise<Array<Report | null>> {
  const keys = personKeys.filter(Boolean)
  if (keys.length === 0) return personKeys.map(() => null)

  const { data, error } = await table('report_cache').select('*').in('id', keys)
  if (error) {
    diagLog('warn', 'db', `report_cache 批量读取失败：${error.message ?? error}`)
    return personKeys.map(() => null)
  }

  const byId = new Map<string, ReportCacheRow>()
  for (const row of (data as ReportCacheRow[]) ?? []) byId.set(row.id, row)

  return personKeys.map((k) => {
    const row = byId.get(k)
    return row?.state === 'ready' && row.report ? row.report : null
  })
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
 *
 * 计数优先走云函数 `quotaGuard` 原子自增；未部署时回退本地读-改-写。
 * 注意云端是「先自增、再由本函数判定」：已超限时再刷新会让计数多涨 1
 * （只影响展示，`remaining` 已夹到 0），闸门是否放行不受影响。
 */
export async function consumeRefreshQuota(userId: string): Promise<{ allowed: boolean; remaining: number }> {
  const real = await tallyRefreshQuota(userId)
  /*
   * 调试开关（见 utils/debug.ts）：关闭额度时不拦请求，但计数照记 ——
   * 计数是排查问题时最直接的证据，不该因为调试而丢失。
   * remaining 一并报成满额，避免出现「剩余 0 次」却仍能刷新的矛盾展示。
   */
  return REFRESH_QUOTA_DISABLED ? { allowed: true, remaining: DAILY_REFRESH_LIMIT } : real
}

/** 刷新额度的真实口径：自增计数并据此判定（不感知调试开关） */
async function tallyRefreshQuota(userId: string): Promise<{ allowed: boolean; remaining: number }> {
  const cloudCount = await incrQuotaViaCloud('refresh')
  if (cloudCount !== null) {
    return {
      allowed: cloudCount <= DAILY_REFRESH_LIMIT,
      remaining: Math.max(0, DAILY_REFRESH_LIMIT - cloudCount)
    }
  }

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
  /* 客户端不持有任何 Key，故这里判「云环境配了没」而非「用户填了没」 */
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
