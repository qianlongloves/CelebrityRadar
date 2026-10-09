import { table } from './db'
import { Report, buildReport, isRefusedResult, REPORT_SCHEMA_VERSION } from './report'
import { FocusCode } from '@/config/filters'
import { fetchNews, hasSearchChannel, DEEP_MAIN_COUNT, DEEP_SOCIAL_COUNT, NewsItem } from './search'
import { parsePersonKey } from '@/config/domains'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { todayKey } from './time'
import { cooldownMinutesLeft } from './cooldown'
import { peekGenerateQuota, consumeGenerateQuota } from './quota'
import { quotaExhaustedMessage, presentSections, readMemberState, stripMemberSections } from './member'
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
      /**
       * 本次生成被「只升不降」拦下（P0，2026-10-09）：交回的是缓存里已含会员段落的那一版，
       * 本次产物较简略、没有覆盖它（见 saveReady / shouldKeepMemberVersion）。
       * 页面据此给一句解释 —— 否则用户点了「刷新最新」却看不出任何变化，会以为按钮坏了。
       */
      keptMember?: boolean
      /**
       * 交回的 `report` 里**被藏起来的会员段落名**（批 1，2026-10-09）：免费读者才有值。
       *
       * 内容剥掉、存在性保留 —— 报告页的促销条要说清「这份报告里有什么你看不到」
       * （文案见 utils/member.ts#reportMemberPromo），剥离之后若连「有没有」都不知道，
       * 那句可兑现的承诺（「已含对比视角、风险提示、信源分歧」）就退化成泛泛的招揽。
       */
      memberLocked?: string[]
      /**
       * 本次 force 被免费档「刷新最新」冷却拦下（批 2，2026-10-09）：交回的是刚生成过的那一版，
       * **没有真的重新生成**。页面得说明一句 —— 否则用户点了刷新却看不出任何变化，
       * 会以为按钮坏了（与 keptMember 同一个「点了没变」的问题，故提示挂在同一处）。
       */
      refreshCooled?: boolean
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
 * 读一行的报告 Schema 版本，缺失按 1 处理（前置项 1，2026-10-09）。
 *
 * 为什么需要这个助手，而不是直接读 row.schemaVersion：
 *   · `report_cache` 由端上直写，2026-10-09 之前落库的行没有这个字段，`undefined` 是**正常**的；
 *   · 版本号只有一处读法，才能保证「报告页判版本」「将来按版本决定要不要重生成」口径一致
 *     （与 utils/report-toc.ts 收口目录条件同一个理由：散在各处的判空没人钉得住）。
 *
 * ⚠ 现在**不**因版本低而丢弃缓存：那会让全部存量报告当场失效（用户点开就是重新生成）。
 *   老报告照旧可读，判空逻辑照旧逐字段 —— 版本号是给「将来新增段落」用的，
 *   升级时再用它回答「这一段该不该有」，而不是「这份报告还能不能用」。
 */
export function reportSchemaVersion(row: ReportCacheRow | null): number {
  const v = row?.schemaVersion
  return typeof v === 'number' && v > 0 ? v : 1
}

/**
 * 这份报告是否带着**会员专属段落**（对比视角 / 风险提示 / 信源分歧）。
 *
 * 判据只能落在字段上，不能落在「谁生成的」：报告是全局共享缓存，两种产物混在
 * 同一张表、同一把键（personKey）上，谁先来谁的版本就在那儿。
 * memberNotes 与 conflicts 都只在会员提示词里请求，故「有其一」即算会员版。
 */
export function hasMemberBlocks(report: Report | null | undefined): boolean {
  /* 直接复用会员权益层的「实际存在的专享段落」判定：
     它把空串与空数组都按「不存在」处理，正是我们这里要的口径 ——
     有字段但一段内容都没有，不算会员版（那种报告覆盖掉它也不损失什么）。
     两处若各写一套，迟早会出现「UI 说没有、守卫说有」的分歧。 */
  return presentSections(report).length > 0
}

/**
 * 「只升不降」判定（P0，2026-10-09）：新产物不含会员段落、而缓存里那一行含时，拒绝覆盖。
 *
 * 为什么需要这一步：同一 personKey 只有一行，免费档产物一旦覆盖掉会员版，
 * **全站会员**下次点开都会看到「深度解析」整块消失；而报告一旦 ready 就长期复用、
 * 不按时间过期（见本文件顶部），这个降级不会自愈 —— 任何人点一次「刷新最新」，
 * 就能把付费换来的内容永久抹掉，被抹掉的人还没有任何补救手段。
 *
 * 纯函数（不含 I/O）以便单测直接钉住判定；那一次读库放在 saveReady 里，且它发生在
 * 持有 building 锁之后（acquire 互斥），所以读到的就是「即将被覆盖的那一版」。
 */
export function shouldKeepMemberVersion(
  next: Report | null | undefined,
  existing: ReportCacheRow | null | undefined
): boolean {
  if (hasMemberBlocks(next)) return false
  return !!existing && existing.state === 'ready' && hasMemberBlocks(existing.report)
}

/**
 * 交给**当前读者**的报告（批 1，2026-10-09）：会员原样，非会员把会员段落摘掉。
 *
 * 快路径刻意排在读会员态**之前**：报告里没有会员段落时（免费档生成的、老报告、降级简版）
 * 根本不必知道读者是谁 —— 绝大多数读取走这条，于是「不给免费用户发会员段」这件事
 * **不为绝大多数请求多付一次 users 读**；只有真的藏着东西时才读一次身份。
 *
 * 读库失败时 readMemberState 按非会员处理（全项目一致口径，见 utils/member.ts），
 * 代价是极少数抖动会让会员这一眼看不到会员段（页面会显示「这份报告没有会员段落」的
 * 补齐引导，点了即恢复）—— 比反过来给非会员放行一次强。
 *
 * 返回的 locked 见 ReportOutcome.memberLocked。
 *
 * `knownMember` 是给**生成路径**用的：那条路径上身份已经读到了（memberDeep，见配额检查），
 * 再为同一件事读一次库是白付一次往返。读路径不传，由本函数按需读。
 */
async function exposeReport(
  report: Report,
  knownMember?: boolean
): Promise<{ report: Report; locked: string[] }> {
  const locked = presentSections(report)
  if (locked.length === 0) return { report, locked }
  const member = knownMember ?? (await readMemberState()).member
  /* 会员手里没有被锁住的段落 —— 交回空数组而不是「这份报告有哪些专享段」：
     字段名说的是「被藏起来的」，别让它对会员也非空，否则以后有人拿它当身份判断就会读反。 */
  return member ? { report, locked: [] } : { report: stripMemberSections(report), locked }
}

/**
 * 免费档「刷新最新」的冷却窗口（批 2，2026-10-09）。
 *
 * 为什么是 12 小时：报告是「一次生成、长期复用」的资产，不按时间过期（见文件顶部），
 * 半天的间隔内内容不会有实质变化（素材时间窗 30 天，热度按 N30/N7 算），
 * 而每次重新生成都要付一整笔检索 + LLM 输出。
 * 窗口只拦「刚看过就想再刷」这类无意义重复，跨天使用的用户碰不到它。
 * 会员不受限：他有每日 30 次，且「补齐共享缓存」那类刷新本就免计费（见 memberUpgrade）。
 */
const FREE_REFRESH_COOLDOWN_MS = 12 * 60 * 60 * 1000

/**
 * 这次 force 是否该被免费档冷却拦下（批 2）。
 *
 * 快路径**先看时间、再看身份**：绝大多数 force 都发生在报告已经旧了的时候（用户就是为这个点的），
 * 那种情况连身份都不必读 —— 与 exposeReport 同一取舍，别让这个闸门给常态动作加成本。
 *
 * 读库失败时 readMemberState 按非会员处理（全项目口径，见 utils/member.ts）：
 * 代价是极少数抖动会让免费用户这一下刷新被拦（拿到的是刚生成过的那一版，内容无差），
 * 比反过来放行一次本可省下的生成强。
 */
async function isFreeRefreshCooling(report: Report): Promise<boolean> {
  const at = Date.parse(report.generatedAt ?? '')
  if (!Number.isFinite(at)) return false
  if (Date.now() - at >= FREE_REFRESH_COOLDOWN_MS) return false
  return !(await readMemberState()).member
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
      .insert({
        id: personKey,
        report: null,
        generated_at: now,
        state: 'building',
        builder: userId,
        search_meta: null,
        schemaVersion: REPORT_SCHEMA_VERSION
      })
      .select()
    if (!error) return 'acquired'
    const again = await getRow(personKey)
    if (again) return 'lost'
    throw new Error(error.message)
  }

  const expireIso = new Date(Date.now() - BUILDING_TIMEOUT_MS).toISOString()
  /* 抢占同时刷新版本：这一轮的产物是**当前端上**生成的，building 行也带上版本，
     免得排障时看到「state=building 却没有 schemaVersion」而要再想一遍是哪种情况。 */
  const { data: upd, error: updErr } = await table('report_cache')
    .update({ state: 'building', builder: userId, generated_at: now, report: null, schemaVersion: REPORT_SCHEMA_VERSION })
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
 *
 * 返回值三态（P0，2026-10-09）：
 *   'saved'  已写入
 *   'kept'   被「只升不降」拦下 —— 缓存里那版含会员段落，本次较简略的产物**不写**，
 *            调用方应改交回既有那份（见 getOrBuildReport 第 4 步）
 *   'failed' 写库失败（已释放自己的 building 锁）
 */
async function saveReady(
  personKey: string,
  report: Report,
  newsCount: number,
  userId: string
): Promise<'saved' | 'kept' | 'failed'> {
  /* 只升不降（P0）：先读一眼既有行再决定写不写，理由见 shouldKeepMemberVersion 的注释 */
  if (!hasMemberBlocks(report)) {
    const existing = await getRow(personKey)
    if (shouldKeepMemberVersion(report, existing)) {
      diagLog('info', 'db', `拒绝降级覆盖：${personKey} 已有含会员段落的版本，保留原样`)
      return 'kept'
    }
  }

  const { error } = await table('report_cache').upsert({
    id: personKey,
    report,
    state: 'ready',
    generated_at: report.generatedAt,
    builder: null,
    search_meta: { news_count: newsCount },
    /* 落库时打版本：这是「这份报告由哪个版本的端上生成」的唯一记录点 */
    schemaVersion: REPORT_SCHEMA_VERSION
  })
  if (!error) return 'saved'
  diagLog('error', 'db', `报告落库失败：${error.message ?? error}`)
  // 落库失败时必须清掉自己的 building 脏行：否则该行会以 state=building 残留，
  // 在 BUILDING_TIMEOUT_MS 内让**所有**查询该人物的请求都只能排队等待，且全程零报错。
  // 报告本身仍返回给本次用户，只是这一次不进缓存（下次重新生成，但不会再排队）。
  await release(personKey, userId).catch(() => undefined)
  return 'failed'
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
  if (isUsable(row)) {
    /*
     * 免费档「刷新最新」冷却（批 2，2026-10-09）：force 不等于一定要重新生成 ——
     * 刚生成过的那一份内容不会有实质变化，重做只是把同一件事再买一遍
     * （一次检索 + 一次完整 LLM 输出）。判定见 isFreeRefreshCooling。
     */
    const cooled = opts.force ? await isFreeRefreshCooling(row.report) : false
    if (!opts.force || cooled) {
      track(cooled ? 'report_refresh_cooled' : 'report_hit_cache', { personKey })
      /* 交回前先按读者身份过滤（批 1）：免费用户拿到的对象里不该有会员段（见 exposeReport） */
      const shown = await exposeReport(row.report)
      return {
        kind: 'report',
        report: shown.report,
        fromCache: true,
        memberLocked: shown.locked,
        /* 只有「被冷却拦下的 force」要告诉页面：用户明明点了刷新（见 ReportOutcome.refreshCooled） */
        ...(cooled ? { refreshCooled: true } : {})
      }
    }
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
   *
   * 交给页面之前先按本次身份过滤（批 1）：免费用户的「变化对比」不该引用会员段的内容 ——
   * 否则一份「刷新后新增了风险提示」的提示语本身就把会员段说出去了。
   * 用 memberDeep 而非 exposeReport：身份已读到，不必为同一件事读第二次库。
   */
  const prevRaw = isUsable(row) ? row.report : null
  const prevReport = prevRaw && !memberDeep ? stripMemberSections(prevRaw) : prevRaw

  /**
   * 「会员补齐」（P1，2026-10-09）：本次是会员在生成，而缓存里现有的那份还不含会员段落
   * （多为免费档先来生成过）—— 那他这次刷新实质是**替全站把这行缓存升级**，
   * 产物照样写进共享缓存，之后所有免费用户都读得到这笔钱换来的东西。
   * 故这一笔不该由他掏每日次数（配额在 utils/quota.ts 消耗，此处只是「申请」）。
   *
   * ⚠ 端上这个标记**不可信**：真伪由云函数 quotaGuard 复核（会员是否真的生效 +
   *   目标那一行是否真的缺会员段）。改包伪造申请只是让自己被按普通生成计数，白不了。
   */
  const memberUpgrade = memberDeep && !hasMemberBlocks(row?.report)

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
      const shown = await exposeReport(report)
      return { kind: 'report', report: shown.report, fromCache: true, memberLocked: shown.locked }
    }
    row = await getRow(personKey)
    if (isUsable(row)) {
      const shown = await exposeReport(row.report)
      return { kind: 'report', report: shown.report, fromCache: true, memberLocked: shown.locked }
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
     *
     * 免费档（批 2，2026-10-09）：**不发社交支线**，只走主线 10 条（`socialCount: 0` 会让
     * search.ts 连那一路请求都不发）。支线本是「锦上添花」（捞回被门户挤掉的一手发声），
     * 代价却是每次生成的检索调用翻倍、素材从 10 条涨到 18 条 —— 这笔常态开销不该压在免费档上，
     * 故把它收进会员的「质」权益（与 DEEP_* 同一方向）：免费档回到支线上线前的口径。
     * ⚠ 代价是免费档生成的报告（长尾人物往往只有这一份）少了社交维度，会员读到它时同样少 ——
     *   这是「共享缓存 + 免费共用」的必然；会员点「刷新最新」即可按自己的档位重生成一份厚的，
     *   且那一次免计费（见上方 memberUpgrade），所以会员并没有被免费档的产物锁死。
     */
    const news = await fetchNews(
      name,
      memberDeep
        ? { maxResults: DEEP_MAIN_COUNT, socialCount: DEEP_SOCIAL_COUNT }
        : { socialCount: 0 }
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
    const saved = await saveReady(personKey, report, news.length, userId)

    /*
     * 被「只升不降」拦下（P0）：本次产物不含会员段落，而缓存里已有含会员段落的一版。
     * 交回既有那一版即可 —— 用户拿到的是它，本次生成没有生效，故**不计数**
     * （与缓存命中同一个口径：没拿到新东西就不该扣次数）。
     * 极端情况读不到（刚好被删）：退化成普通生成照常计数，不能让用户白等一场还没报告。
     */
    if (saved === 'kept') {
      const kept = await getRow(personKey)
      if (isUsable(kept)) {
        track('report_kept_member', { personKey })
        /*
         * 交回的是缓存里含会员段的那一版（正是本次被拦下的原因）：免费读者同样要剥 ——
         * 内容归会员，存在性留给促销条（memberLocked 非空，页面会说「已含对比视角…」）。
         */
        const shown = await exposeReport(kept.report, memberDeep)
        return {
          kind: 'report',
          report: shown.report,
          fromCache: true,
          keptMember: true,
          memberLocked: shown.locked
        }
      }
    }

    track('report_generate', { personKey, mode: 'realtime' })
    /*
     * 配额只在「用户真的拿到报告」时消耗（公平计费，口径见 utils/quota.ts 文件头）：
     *   上方的 refused / error / coldstart / nonews 分支均已提前 return，不计数；
     *   缓存命中（第 0 步 / 抢锁失败等待他人构建）与上面的 kept 分支同样不计数。
     *   ⚠ 本行位于 saveReady 之后：落库失败会抛到下面的 catch，此时用户拿不到报告 → 不计数。
     *   best-effort：计数写失败不影响本次返回，少量丢失可接受（宁可少算不多算）。
     *   memberUpgrade：会员「补齐」共享缓存的那一次由云函数复核后免计费（见上方注释）。
     */
    void consumeGenerateQuota(
      userId,
      memberUpgrade ? { waiveIf: 'member_upgrade', target: personKey } : undefined
    )
    /* 本次产物按**本次身份**过滤（批 1）：非会员生成的报告本就不含会员段 → 快路径直出、零额外读 */
    const shown = await exposeReport(report, memberDeep)
    return {
      kind: 'report',
      report: shown.report,
      fromCache: false,
      prev: prevReport,
      memberLocked: shown.locked
    }
  } catch (err) {
    await release(personKey, userId).catch(() => undefined)
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/* ===== 动态缓存 + 刷新配额（§3.7） ===== */

/** 只读缓存（不触发生成、不抢锁）：名人主页 / 关注流用 */
export async function getCachedReport(personKey: string): Promise<Report | null> {
  const row = await getRow(personKey)
  if (row?.state !== 'ready' || !row.report) return null
  /*
   * 只读路径同样按读者身份过滤（批 1）：调用方（关注流概览 / 名人主页）虽只用得到 heat、
   * generatedAt 这类公开字段，但**问答页会把报告正文当上下文喂给模型** —— 那是一条能问出
   * 会员段内容的旁路（「报告里对这个人的风险提示说了什么」），必须在出门前就掐掉。
   */
  return (await exposeReport(row.report)).report
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

  const ready = personKeys.map((k): Report | null => {
    const row = byId.get(k)
    return row?.state === 'ready' && row.report ? row.report : null
  })

  /*
   * 批量路径只读**一次**身份（批 1）：只要其中任何一份藏着会员段就值得这一次读，
   * 全都不藏（常见）则一次也不读 —— 与 getCachedReport 的快路径同一个取舍。
   * 逐份调 exposeReport 会变成 N 次 users 读（这个页是 tabBar 页，切回来就重跑）。
   */
  if (!ready.some((r) => r && hasMemberBlocks(r))) return ready
  const member = (await readMemberState()).member
  return member ? ready : ready.map((r) => (r ? stripMemberSections(r) : null))
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
      allowed: cloudCount.count <= DAILY_REFRESH_LIMIT,
      remaining: Math.max(0, DAILY_REFRESH_LIMIT - cloudCount.count)
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

/**
 * 关注流刷新的检索口径：**只走主线**（批 3，2026-10-09）。
 *
 * 与报告生成的方向相反：feed 只回答「谁有动静」—— 列表里是标题 / 来源 / 时间三样，
 * 不做任何分析。而社交支线（`include` 社交站点）是为**深度报告**捞一手发声用的，
 * 它对 feed 的增量价值是「多几行同样格式的标题」，代价却是每次刷新的检索调用翻倍
 * （10 人 × 2 路 = 20 次调用 / 次刷新，每日上限 10 次 ⇒ 单人日上限 200 次，
 * 这是全项目最大的一笔成本敞口）。故 feed 只保留主线 10 条，与免费档报告生成同口径。
 *
 * ⚠ 代价：feed_cache 的条目从约 18 条降到 10 条，关注周报（utils/weekly.ts）取材于它、
 *   素材相应变少。这是刻意取舍 —— 报告侧的深度不受影响，会员的「加厚检索」仍在
 *   报告生成那一处（DEEP_*），feed 不分档位（它不消耗生成额度，只消耗刷新次数）。
 */
const FEED_SEARCH_OPTS = { socialCount: 0 } as const satisfies Parameters<typeof fetchNews>[1]

/** 一次下拉刷新最多刷几位：决定单次刷新的花费上限（上限 10 次检索调用） */
const FEED_REFRESH_MAX_PERSONS = 10

/**
 * 单批并发数。一次检索约 1~2s，串行十个人就是十次往返相加（真机上几十秒，
 * 用户早就松手下拉手势并以为卡死）。取 4 而不是全量：单路检索的峰值并发本来只有 2，
 * 4 已经把它压到「批数 × 单次往返」；再高只是把上游限流撞在同一个瞬间。
 * 若博查 QPS 吃紧，**只调这一个数**（调回 1 即退回串行）。
 */
const FEED_REFRESH_BATCH = 4

/**
 * 挑出本次要刷的人：不超过上限就原样返回（绝大多数用户，零额外读）。
 *
 * 超过上限时按「最久没刷」优先。此前是 `follows.slice(0, 10)`，而 listFollows 按
 * followed_at **倒序**（最近关注的在最前）⇒ 关注第 11 位起的人**永远轮不到**，
 * 下拉刷新对他们等于无效，而页面上看不出任何区别。轮转只多一次批量读
 * （in 查询，与 getCachedReports 同一手法），且只在关注数超上限时才发生。
 * 从未刷过的（缓存里没有行）排最前 —— 那正是最该被抓一次的人。
 */
async function pickStalestFollows<T extends { person_key: string }>(
  follows: T[],
  max: number
): Promise<T[]> {
  if (follows.length <= max) return follows

  const { data, error } = await table('feed_cache')
    .select('*')
    .in(
      'id',
      follows.map((f) => f.person_key)
    )
  if (error) {
    /* 读不到就别挑：宁可轮转失效，也不能把这次刷新的目标弄成随机顺序 */
    diagLog('warn', 'db', `feed_cache 批量读取失败，退回关注顺序：${error.message ?? error}`)
    return follows.slice(0, max)
  }

  const at = new Map<string, string>()
  for (const row of (data as FeedCacheRow[]) ?? []) {
    if (row.fetched_at) at.set(row.id, row.fetched_at)
  }
  /* 空串（从未刷过）排最前；ISO 时间串按字典序即时间序 */
  return [...follows]
    .sort((a, b) => (at.get(a.person_key) ?? '').localeCompare(at.get(b.person_key) ?? ''))
    .slice(0, max)
}

/** 关注流下拉刷新：整次动作消耗 1 配额，刷新至多 FEED_REFRESH_MAX_PERSONS 位（按最久未刷新优先） */
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

  const targets = await pickStalestFollows(follows, FEED_REFRESH_MAX_PERSONS)
  let refreshed = 0

  for (let i = 0; i < targets.length; i += FEED_REFRESH_BATCH) {
    const slice = targets.slice(i, i + FEED_REFRESH_BATCH)
    /* 一个人失败不影响同批其他人（各自 catch 成 null），也不影响后续批次 */
    const settled = await Promise.all(
      slice.map((f) =>
        fetchNews(f.name, FEED_SEARCH_OPTS)
          .then((news) => ({ f, news }))
          .catch((err) => {
            diagLog('warn', 'http', `feed 刷新失败（${f.name}）：${String(err)}`)
            return null
          })
      )
    )
    for (const hit of settled) {
      if (!hit?.news || hit.news.length === 0) continue
      const { error } = await table('feed_cache').upsert(
        { id: hit.f.person_key, items: hit.news, fetched_at: new Date().toISOString() },
        { onConflict: 'id' }
      )
      if (error) diagLog('warn', 'db', `feed_cache 写入失败（${hit.f.name}）：${error.message ?? error}`)
      else refreshed++
    }
  }

  /*
   * 埋点报**真正刷成的人数**（与返回值同一个数）。原先写的是 follows.length ——
   * 关注 20 位而只刷 10 位时会记成 20，拿它评估成本会系统性高估一倍。
   */
  track('refresh_feed', { count: refreshed })

  /* 关注数超上限时如实说明只刷了一部分：否则用户以为全部更新过了，
     而名单上没动静的那几位会被当成「确实没新闻」（静默丢信息） */
  const partial =
    targets.length < follows.length ? `（本次刷新 ${targets.length} 位，按最久未刷新优先）` : ''
  return {
    ok: true,
    message: `已刷新 ${refreshed} 位名人${partial}（剩余 ${quota.remaining} 次刷新）`,
    refreshed
  }
}

/**
 * 单人刷新：配额 → 检索 → feed_cache 更新。
 *
 * 检索口径与批量刷新**必须一致**（只走主线，见 FEED_SEARCH_OPTS）：两者写的是同一张
 * feed_cache，口径若不同，同一个人在「下拉刷新」与「单独刷新」后拿到的条目数会不一样，
 * 而用户无从理解为什么（一个 10 条、一个 18 条）。
 */
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

  /* 口径与批量刷新一致（只走主线，见 FEED_SEARCH_OPTS）：两处写的是同一张 feed_cache */
  const news = await fetchNews(name, FEED_SEARCH_OPTS)
  if (!news) return { ok: false, message: '联网素材不可用' }
  if (news.length === 0) return { ok: true, items: [], message: `暂无新动态（剩余 ${quota.remaining} 次刷新）` }

  await table('feed_cache').upsert(
    { id: personKey, items: news, fetched_at: new Date().toISOString() },
    { onConflict: 'id' }
  )
  /* count: 1 —— 批量刷新报的是人数，这里保持同一字段可比（否则同一事件两种口径） */
  track('refresh_feed', { personKey, count: 1 })
  return { ok: true, items: news, message: `已更新（剩余 ${quota.remaining} 次刷新）` }
}
