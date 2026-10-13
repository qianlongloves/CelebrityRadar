import Taro from '@tarojs/taro'
import { useAuth } from '@/stores/auth'
import { callCloudFunction } from './cloud'
import { diagLog } from './cloud-diagnostics'
import { explainDbFailure, table } from './db'
import { readMemberState } from './member'
import { watchGate, watchLimit, watchLimitNote } from './opinion-access'
/* 风险类别（仅类型，供 AlertItem 的分级字段用）—— 类型导入编译期擦除，不引运行时依赖 */
import type { RiskCategory } from './risk'

/**
 * 关键词舆情预警（2026-10-08）。
 *
 * 链路：我在预警页订阅关键词（keyword_watches，主键 = openid#关键词）
 * → 云函数 keywordAlert 每天定时按词检索并写缓存（keywords，主键 = 关键词原文）
 * → 我打开预警页时读缓存，把「上次看过之后新出现的条目」列出来。
 *
 * 三个刻意的取舍：
 *
 * 1. **端上不给「立即扫描」按钮**。检索一次就是一次上游计费，把扫描动作放在按钮上，
 *    等于把成本开关交给用户的点击频率（改包还能无限刷）。界面上只有「订阅 / 取消订阅」，
 *    新内容由云端每天跑一次——这也符合预警的产品语义：**它是等消息，不是查消息**。
 *    因此本文件只有读（loadAlerts）与订阅管理，没有任何触发检索的入口。
 *
 * 2. **「新」由 seen_at 决定，而不是由条目发布时间决定**。条目发布时间来自媒体，
 *    可能是相对时间甚至抓取时间；seen_at 是「我上次看这个关键词的时刻」，
 *    与云端 first_seen_at 同一个时钟，比较结果可靠。语义也正好是用户要的：
 *    「我上次看过之后才出现的」。
 *
 * 3. **订阅那一刻把 seen_at 置为当前时间**，而不是留空。留空会让新订阅者第一眼就看到
 *    一批昨天的旧闻被标成预警 —— 预警一旦误报几次就没人再看了（宁可空着，不可喊狼来了）。
 *    代价是订阅当天列表是空的，由空态文案说明「已在监测，有新增会出现在这里」。
 */

/** 订阅行（keyword_watches）：与 follows 同构，主键 openid#关键词 */
export interface WatchRow {
  id: string
  openid: string
  /** 关键词订阅存关键词；人脸监控（type='person'）存人名，仅用于显示 */
  keyword: string
  created_at: string
  /** 我最后一次看这个词的时间；null 只可能出现在历史数据里（新订阅都会写时间） */
  seen_at: string | null
  /**
   * 订阅类型（第 1 期名人风险监控引入，见 utils/risk-watch.ts）。
   *
   * **可选是刻意的**：2026-10-08 那批关键词订阅没有这个字段，读库时一律按
   * 「缺失 = keyword」处理（见 splitWatches）。用 `.eq('type','keyword')` 去筛选
   * 会把全部老订阅漏掉 —— 这是本次改动最容易踩的坑。
   */
  type?: 'keyword' | 'person'
  /** 仅 type='person' 有效：名人主键（人名可能重名，person_key 带领域消歧） */
  person_key?: string | null
}

/** 检索到的单条报道 */
export interface AlertItem {
  title: string
  url: string
  source: string
  summary?: string
  /** 媒体发布时间（可能缺） */
  published_date?: string
  /** 我们第一次看到它的时间：判断「是不是新的」只看这个 */
  first_seen_at: string
  /**
   * 条目级分级字段（云端 keywordAlert 写入 keywords.items 前用风险词典补齐）——
   * **只有命中风险词典的条目才有**，未命中则三个字段都不存在（端上判断层据此保持「未评级 / 未知」，
   * 见 utils/opinion-rank.ts）。字段名与 risk_signals 一致；旧缓存没有这些字段，读取时按缺失处理。
   */
  category?: RiskCategory
  category_label?: string
  level?: string
}

/** 关键词检索缓存行（keywords，云端写、端上只读） */
export interface KeywordCacheRow {
  id: string
  keyword: string
  items: AlertItem[]
  fetched_at: string
  watchers?: number
}

/**
 * 预警分组：一个关键词一组。
 *
 * 注意 items 给的是**最近这批全部条目**（而不是只给新的）：预警列表要当「收件箱」用 ——
 * 全部只给未读，用户看过一次就再也找不回那几条了。新的只打标记、排前面，旧的在下面留着。
 */
export interface AlertGroup {
  keyword: string
  items: AlertItem[]
  /** 其中「我上次看过之后才出现的」条数，决定分组等级与排序 */
  newCount: number
  /** alert = 新增较多（舆情升温）；note = 少量新增；calm = 没有新的 */
  level: 'alert' | 'note' | 'calm'
  lastFetchedAt: string
}

/*
 * 每人订阅上限（P2，2026-10-13 起分档）：免费 `watchLimit(false)` 个 / 会员 `watchLimit(true)` 个，
 * 数值真源见 `config/benefits.ts#OPINION_LIMITS`，取用与门禁见 `utils/opinion-access.ts`。
 *
 * ⚠ P4（2026-10-13）：原先这里写死 5、与云函数 keywordAlert 的「每人不分档的 5」对齐 ——
 *   会员档（10）已超过那个 5，云端会把每人第 6~10 行整行忽略（用户以为在盯、实际没扫）。
 *   现云端 keywordAlert 已按 `memberships`（权威表）分档校验新增数量（写入走 action:'add'），
 *   且定时扫描**不再按上限裁剪存量**；本文件的分档门禁只在云端不可用时兜底，是**体验层**。
 */
/** 关键词最长字符数（按字符计，超出会让上游检索变成一句描述） */
export const KEYWORD_MAX_CHARS = 12
/** 判定为「舆情升温」的最少新增条数：与云函数 ALERT_MIN_ITEMS 同口径 */
const ALERT_MIN_ITEMS = 2

export function alertLevelLabel(level: AlertGroup['level']): string {
  if (level === 'alert') return '舆情升温'
  if (level === 'note') return '有新报道'
  return ''
}

/** 这条是不是「我上次看过之后才出现的」（云端 first_seen_at 与端上 seen_at 同一时钟，可直接比字符串） */
export function isNewItem(item: AlertItem, seenAt: string | null): boolean {
  if (!seenAt) return true
  return String(item.first_seen_at ?? '') > seenAt
}

/**
 * 归一化关键词：去掉首尾空白、内部连续空白压成一个空格（「雷军  发布会」与「雷军 发布会」是同一个词）。
 * 不转小写、不做同义合并：中文关键词没有大小写，而英文缩写（AI / ai）强制统一反而会把用户
 * 订阅的形态改掉，展示与检索都用原文更直白。
 */
export function normalizeKeyword(raw: string): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ')
}

/**
 * 校验关键词。
 * 拒绝 `#`：订阅主键是 `openid#关键词` 拼出来的（与 follows 同构），关键词里再有 `#`
 * 会让主键边界模糊 —— 极端情况下 `a#b` 与 `a` + `b` 撞成同一条。
 */
export function validateKeyword(raw: string): { ok: boolean; keyword: string; message?: string } {
  const keyword = normalizeKeyword(raw)
  if (!keyword) return { ok: false, keyword, message: '请输入要监测的关键词' }
  if (keyword.includes('#')) return { ok: false, keyword, message: '关键词不能包含 #' }
  if (Array.from(keyword).length > KEYWORD_MAX_CHARS) {
    return { ok: false, keyword, message: `关键词不超过 ${KEYWORD_MAX_CHARS} 个字` }
  }
  /* 纯符号的「词」检索不出东西，只会白花一次上游调用 */
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(keyword)) {
    return { ok: false, keyword, message: '关键词至少要包含文字或数字' }
  }
  return { ok: true, keyword }
}

/** 我的订阅（按订阅时间倒序） */
export async function listWatches(): Promise<WatchRow[]> {
  const userId = useAuth.getState().userId
  if (!userId) return []
  const { data, error } = await table('keyword_watches')
    .select('*')
    .eq('openid', userId)
    .order('created_at', { ascending: false })
  if (error) {
    diagLog('warn', 'db', `keyword_watches 读取失败：${error.message ?? error}`)
    return []
  }
  return (data as WatchRow[]) ?? []
}

/**
 * 按类型拆订阅行（预警页与人脸监控共用同一张表，见第 1 期名人风险监控）。
 *
 * 为什么在内存里拆、而不是查库时 `.eq('type', 'keyword')`：
 * 2026-10-09 之前的行没有 type 字段，按 type 过滤会把**全部老订阅**漏掉 ——
 * 用户会发现自己的关键词监测一夜之间全没了。这里把「缺失 = keyword」这条规则
 * 收在一个函数里，端上与云函数（keywordAlert 的 `w.type === 'person'` 跳过）同一口径。
 */
export function splitWatches(rows: WatchRow[]): { keywords: WatchRow[]; persons: WatchRow[] } {
  const keywords: WatchRow[] = []
  const persons: WatchRow[] = []
  for (const w of rows) {
    if (!w) continue
    if (w.type === 'person') persons.push(w)
    else keywords.push(w)
  }
  return { keywords, persons }
}

/**
 * 经云函数 keywordAlert 权威写入一条订阅（P4，2026-10-13）。
 *
 * 为什么订阅也要过一次云端：`watchLimit` 读的是 `users.membership` **镜像**（端上可改、
 * 可被改包绕过），而每一条订阅都会在每天定时扫描里持续消耗上游检索预算 —— 所以
 * 「能不能再加一个」必须由云端按 `memberships`（权威表）说了算。云端回的是**结构化回执**，
 * 超限时带 `reason:'over_limit'` 与 `limit` / `tier`，**不会静默丢弃**（静默丢弃正是本轮修的缺陷）。
 *
 * 返回 `null` = 云端不可用（函数未部署 / 网络抖动），调用方回退端上原有路径 ——
 * 与 utils/quota-guard.ts「云端优先、静默回退本机」同一取舍。
 */
async function addWatchViaCloud(
  keyword: string
): Promise<{ ok: boolean; message: string; fatal?: boolean } | null> {
  try {
    const res = (await callCloudFunction('keywordAlert', { action: 'add', keyword })) as
      | { ok?: boolean; reason?: string; limit?: number; tier?: string; message?: string }
      | null
    if (!res || typeof res.ok !== 'boolean') {
      diagLog('warn', 'db', 'keywordAlert(add) 无有效回执，回退端上订阅')
      return null
    }
    if (res.ok) return { ok: true, message: res.message || `已开始监测「${keyword}」` }
    /* over_limit 的文案按云端回执的档位生成（端上 mirror 可能已过期，以云端 tier 为准） */
    if (res.reason === 'over_limit') {
      return { ok: false, message: res.message || watchLimitNote(res.tier === 'member') }
    }
    return { ok: false, message: res.message || '订阅失败，请重试' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'db', `keywordAlert(add) 调用失败，回退端上订阅：${msg}`)
    return null
  }
}

/**
 * 订阅一个关键词。
 *
 * seen_at 写当前时间的原因见文件头取舍 3；重复订阅直接返回提示而不重复写库。
 * 上限与去重都只算**关键词**行：监控名人（type='person'）有它自己的上限，
 * 不该占用「最多监测 N 个词」的额度（N 按身份分档，见 utils/opinion-access.ts）。
 *
 * 写入路径（P4，2026-10-13 起）：**优先走云端权威判定**（见 addWatchViaCloud，读 memberships
 * 判档）；云端不可用时回退端上门禁 + 直接写库。
 *
 * 失败时若判定为环境问题（集合没建 / 权限不允许端上写入），返回值带 `fatal: true`，
 * 调用方改用弹窗说清修法（见 db.ts#explainDbFailure）—— 与 monitorPerson 同一套。
 */
export async function addWatch(raw: string): Promise<{ ok: boolean; message: string; fatal?: boolean }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '请先到「我的」页登录' }
  const check = validateKeyword(raw)
  if (!check.ok) return { ok: false, message: check.message ?? '关键词不合法' }

  const { keywords: watches } = splitWatches(await listWatches())
  if (watches.some((w) => w.keyword === check.keyword)) {
    return { ok: false, message: '这个词已经在监测中了' }
  }

  /* 云端权威判定优先（分档上限读 memberships，端上改包绕不过）。null = 云端不可用，走下面的回退。 */
  const viaCloud = await addWatchViaCloud(check.keyword)
  if (viaCloud) return viaCloud

  /*
   * 回退路径（云端未部署 / 调用失败）：端上门禁 + 直接写库，与 P2 改造后的行为一致。
   * ⚠ 端上这道上限是**体验层不是安全边界**（读的是 users.membership 镜像、整段可被改包绕过），
   *   真正的成本边界在云端 keywordAlert（读 memberships 权威表）。回退期间可被绕过，属已知过渡态。
   * ⚠ 判定**只在「新增」这一支**做 —— 上面的重复订阅、下面的取消订阅都照常，listWatches /
   *   loadAlerts 也从不截断：已有用户可能已订阅超过免费档的词，那些数据原样保留、照常可看可用。
   */
  const isMember = (await readMemberState()).member
  const limit = watchLimit(isMember)
  if (!watchGate(watches.length, isMember).allowed) {
    return { ok: false, message: watchLimitNote(isMember) }
  }

  const now = new Date().toISOString()
  const { error } = await table('keyword_watches').insert({
    id: `${userId}#${check.keyword}`,
    openid: userId,
    keyword: check.keyword,
    created_at: now,
    seen_at: now,
    type: 'keyword'
  })
  if (error) {
    diagLog('warn', 'db', `keyword_watches 写入失败：${error.message ?? error}`)
    const failure = explainDbFailure('keyword_watches', error, '订阅')
    if (failure) return { ok: false, message: failure.message, fatal: failure.fatal }
    return { ok: false, message: '订阅失败，请重试' }
  }

  /*
   * P2-29：上面的门禁是「先查数、再插入」，两次点击并发时都读到 limit-1、各插一条
   * ⇒ 落到 limit+1 条（端上没有任何原子计数可用）。超出的那条会被云端整行忽略 ——
   * 永不扫描，端上却显示「已开始监测」，用户以为在监控、实际什么都没发生，三层都不报错。
   * 端上做不了原子计数，于是插完再核一次：真超了就把**刚插的这条**撤回，如实报错。
   * ⚠ 这里删的只是本次刚插入的那一行，绝不触碰既有订阅（既有存量一律保留）。
   */
  const after = splitWatches(await listWatches()).keywords
  if (after.length > limit) {
    const { error: rollbackErr } = await table('keyword_watches')
      .delete()
      .eq('id', `${userId}#${check.keyword}`)
    if (rollbackErr) diagLog('warn', 'db', `回滚超限订阅失败：${rollbackErr.message ?? rollbackErr}`)
    return { ok: false, message: watchLimitNote(isMember) }
  }

  return { ok: true, message: `已开始监测「${check.keyword}」` }
}

/** 取消订阅（列表页显式操作：已确定处于订阅态，省去一次存在性查询） */
export async function removeWatch(keyword: string): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  const { error } = await table('keyword_watches').delete().eq('id', `${userId}#${keyword}`)
  if (error) {
    diagLog('warn', 'db', `keyword_watches 删除失败：${error.message ?? error}`)
    Taro.showToast({ title: '操作失败，请重试', icon: 'none' })
    return false
  }
  return true
}

/**
 * 读预警列表：订阅 → 批量取各词的检索缓存 → 过滤出「我又没看过的新条目」。
 *
 * 一次 `in` 查询取回全部（每人最多几个词由分档上限决定，见 utils/opinion-access.ts），不逐个关键词查：
 * 小程序端每次 get 都要一次网络往返，5 个词逐个查就是 5 倍等待。
 *
 * @param preRows 可选：调用方**已经读过** `listWatches`（例如舆情页要同时拿监控人行喂风险信号）时，
 *   直接把那份行传进来，省掉本函数内部对 `keyword_watches` 的**重复读**。不传则照旧自己读一遍，
 *   行为与从前完全一致（存量调用点无需改动）。
 */
export async function loadAlerts(preRows?: WatchRow[]): Promise<{ groups: AlertGroup[]; watched: number }> {
  /* 只取关键词订阅：同一张表里的「监控某人」行（type='person'）由预警页的风险信号板块自己读 */
  const rows = Array.isArray(preRows) ? preRows : await listWatches()
  const { keywords: watches } = splitWatches(rows)
  if (!watches.length) return { groups: [], watched: 0 }

  const { data, error } = await table('keywords')
    .select('*')
    .in('id', watches.map((w) => w.keyword))
  if (error) {
    diagLog('warn', 'db', `keywords 读取失败：${error.message ?? error}`)
    return { groups: [], watched: watches.length }
  }
  const cache = new Map(((data as KeywordCacheRow[]) ?? []).map((r) => [r.id, r]))

  const groups: AlertGroup[] = []
  for (const w of watches) {
    const row = cache.get(w.keyword)
    if (!row || !Array.isArray(row.items)) continue
    const items = row.items
      .filter((i) => i && i.url)
      /* 新的排前面：先按我们首次看到的时间，缺失时退回媒体发布时间 */
      .sort((a, b) =>
        String(b.first_seen_at ?? b.published_date ?? '').localeCompare(
          String(a.first_seen_at ?? a.published_date ?? '')
        )
      )
    if (!items.length) continue
    const newCount = items.filter((i) => isNewItem(i, w.seen_at)).length
    groups.push({
      keyword: w.keyword,
      items,
      newCount,
      level: newCount >= ALERT_MIN_ITEMS ? 'alert' : newCount === 1 ? 'note' : 'calm',
      lastFetchedAt: row.fetched_at ?? ''
    })
  }

  /* 先按等级（升温 → 有新增 → 平静），同档按最近一次检索时间：一眼看到最该看的那个词 */
  const rank: Record<AlertGroup['level'], number> = { alert: 0, note: 1, calm: 2 }
  groups.sort((a, b) => {
    if (a.level !== b.level) return rank[a.level] - rank[b.level]
    return String(b.lastFetchedAt).localeCompare(String(a.lastFetchedAt))
  })
  return { groups, watched: watches.length }
}

/**
 * 把当前列出的词全部标记为「已看过」。
 *
 * 在列表**读到之后**调用（而不是进入页面时）：标记动作若先发生，本次读出的条目
 * 就会带上新的 seen_at 而被下次过滤，用户看到的是列表、下次却全没了。
 * 失败只记日志：下次进来重复展示一次，总好过弹一个与用户无关的报错。
 */
export async function markAllSeen(keywords: string[]): Promise<void> {
  const userId = useAuth.getState().userId
  if (!userId || !keywords.length) return
  const { error } = await table('keyword_watches')
    .update({ seen_at: new Date().toISOString() })
    .eq('openid', userId)
    .in('id', keywords.map((k) => `${userId}#${k}`))
  if (error) diagLog('warn', 'db', `keyword_watches 更新 seen_at 失败：${error.message ?? error}`)
}
