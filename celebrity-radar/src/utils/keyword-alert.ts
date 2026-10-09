import Taro from '@tarojs/taro'
import { useAuth } from '@/stores/auth'
import { diagLog } from './cloud-diagnostics'
import { explainDbFailure, table } from './db'

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

/** 每人订阅上限：与云函数 keywordAlert 的 MAX_WATCHES_PER_USER 保持一致 */
export const MAX_WATCHES = 5
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
 * 订阅一个关键词。
 *
 * seen_at 写当前时间的原因见文件头取舍 3；重复订阅直接返回提示而不重复写库。
 * 上限与去重都只算**关键词**行：监控名人（type='person'）有它自己的上限，
 * 不该占用「最多监测 5 个词」的额度。
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
  if (watches.length >= MAX_WATCHES) {
    return { ok: false, message: `最多同时监测 ${MAX_WATCHES} 个词，先取消一个再加` }
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
   * P2-29：上面的 `watches.length >= MAX_WATCHES` 是「先查数、再插入」，两次点击并发时
   * 都读到 4、各插一条 ⇒ 落到 6 条（端上没有任何原子计数可用）。而云端 keywordAlert 的
   * 每人上限判定会把**第 6 行整行忽略** —— 超出的那条永不扫描，端上却显示「已开始监测」，
   * 用户以为在监控、实际什么都没发生，三层都不报错。
   * 端上做不了原子计数，于是插完再核一次：真超了就把刚插的这条撤回，如实报错。
   */
  const after = splitWatches(await listWatches()).keywords
  if (after.length > MAX_WATCHES) {
    const { error: rollbackErr } = await table('keyword_watches')
      .delete()
      .eq('id', `${userId}#${check.keyword}`)
    if (rollbackErr) diagLog('warn', 'db', `回滚超限订阅失败：${rollbackErr.message ?? rollbackErr}`)
    return { ok: false, message: `最多同时监测 ${MAX_WATCHES} 个词，先取消一个再加` }
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
 * 一次 `in` 查询取回全部（最多 MAX_WATCHES 个词），不逐个关键词查：
 * 小程序端每次 get 都要一次网络往返，5 个词逐个查就是 5 倍等待。
 */
export async function loadAlerts(): Promise<{ groups: AlertGroup[]; watched: number }> {
  /* 只取关键词订阅：同一张表里的「监控某人」行（type='person'）由预警页的风险信号板块自己读 */
  const { keywords: watches } = splitWatches(await listWatches())
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
