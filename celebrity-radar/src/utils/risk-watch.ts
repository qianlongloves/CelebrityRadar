import { useAuth } from '@/stores/auth'
import { callCloudFunction } from './cloud'
import { diagLog } from './cloud-diagnostics'
import { explainDbFailure, table } from './db'
import { normalizeKeyword, splitWatches, WatchRow } from './keyword-alert'
import { readMemberState } from './member'
import { requestRiskNotify, riskNotifyConfigured } from './notify'
import { personWatchGate, personWatchLimit, personWatchLimitNote } from './opinion-access'
import { shortDay8 } from './time'
import { RiskScanRow, RiskSignalRow } from '@/types/db'

/**
 * 名人风险监控（第 1 期，2026-10-09）。
 *
 * 链路：报告页点「监控此人」→ `keyword_watches` 写一行 `type='person'`（复用同一张表）
 * → 云函数 riskWatch 每天 09:40 按人检索、词典命中后写 `risk_signals`
 * → 我打开预警页时读 `risk_signals`，按人列出来。
 *
 * 与「风险雷达」（报告页那张卡）的分工：雷达卡扫的是**报告已收录**的素材，是快照；
 * 这条链路每天扫一次，补的是「不重新生成报告就不知道这两天出事了」那段空白。
 * 两者的词典与判定规则同源（云函数侧复制了一份，一致性由测试钉住）。
 *
 * 三个取舍：
 *
 * 1. **端上只读信号、不给「立即扫描」按钮**。与关键词预警同一个理由（见
 *    keyword-alert.ts 取舍 1）：检索一次就是一次上游计费，成本开关不能交给点击频率。
 *
 * 2. **界面上不出现「高 / 中 / 低」字样**。级别只用于排序与「值不值得推一条」：
 *    它来自「命中的是哪一类词」（司法/税务 → 高），是词典的固定顺序，不是对事件的判断。
 *    一旦把「高危」印在屏幕上，平台就替用户下了结论 —— 与风险雷达卡同一条边界。
 *
 * 3. **授权失败不阻断监控**。微信一次性订阅随时可能被用户拒掉，而监控本身的价值是
 *    「站内预警页看得到」。故授权拿不到时照常写监控行，只把推送降级掉，并在文案里说清
 *    —— 不能让用户以为「没授权 = 没监控」。
 */

/*
 * 监控人数上限（2026-10-13 起分档）：免费 `personWatchLimit(false)` 位 / 会员 `personWatchLimit(true)` 位，
 * 数值真源见 `config/benefits.ts#OPINION_LIMITS`，取用与门禁见 `utils/opinion-access.ts`。
 *
 * ⚠ 与「关键词监控数」（watchCount）是**两个独立维度**：一个盯人、一个盯词，各自计数、互不占用额度
 *   （同住 keyword_watches 表，靠 type 区分）。此前这里写死 5、与云函数「每人不分档的 5」对齐 ——
 *   现云端 riskWatch 已按 `memberships`（权威表）分档校验新增数量（写入走 action:'add'），
 *   且定时扫描**不再按上限裁剪存量**；本文件的分档门禁只在云端不可用时兜底，是**体验层**。
 */
/** 每人最多列多少条信号：够看清最近发生了什么，又不至于把页面撑成流水账 */
export const SIGNALS_PER_PERSON = 12

/** 与云函数 riskWatch#personWatchId 同口径（带 person# 前缀，避免与关键词订阅行撞主键） */
export function personWatchId(userId: string, personKey: string): string {
  return `${userId}#person#${personKey}`
}

/** 我的监控名单（只含 type='person' 的行，按加入时间倒序） */
export async function listPersonWatches(): Promise<WatchRow[]> {
  const userId = useAuth.getState().userId
  if (!userId) return []
  const { data, error } = await table('keyword_watches')
    .select('*')
    .eq('openid', userId)
    .order('created_at', { ascending: false })
  if (error) {
    diagLog('warn', 'db', `监控名单读取失败：${error.message ?? error}`)
    return []
  }
  /* 复用 splitWatches 而不是 `.eq('type','person')`：老行（2026-10-08 那批）没有 type 字段，
     规则收在一处才不会出现「关键词那边漏、这边不漏」的不一致（见 keyword-alert.ts#splitWatches） */
  return splitWatches((data as WatchRow[]) ?? []).persons
}

/** 这个人在不在已加载的名单里（报告页用已加载的行判断，避免每次渲染再查一次库） */
export function isMonitored(rows: WatchRow[], personKey: string): boolean {
  return rows.some((w) => w.person_key === personKey)
}

/**
 * 输入的一串字是不是**已在监控名单里的人名**：命中返回那一行，否则 null。
 *
 * 用途：预警页「开始监测」提交前拦一道。同一个人被关键词订阅与人物监控同时覆盖时，
 * keywordAlert（每天 09:20）与 riskWatch（09:40）会各按同一个 query 打一次上游 ——
 * 两条链路各自有跨用户去重，但互不共享，用户拿到的是两份讲同一批内容的列表。
 *
 * 为什么只做**词面比对**、不做实体识别：端上没有「人名 → personKey」的本地索引，
 * 引入一次检索或一次模型调用去判断「这个词是不是个人名」，等于为了省一次上游先花一次上游。
 * 词面相同是可确定、可解释的信号，宁可漏报（「张三工作室」这类变体不拦，它确实只能靠
 * 关键词监测收到）也不误报（把「发布会」这种词弹一个「已在监控中」，用户会莫名其妙）。
 */
export function isMonitoredName(rows: WatchRow[], raw: string): WatchRow | null {
  const name = normalizeKeyword(raw)
  if (!name) return null
  return rows.find((w) => normalizeKeyword(w.keyword) === name) ?? null
}

/**
 * 经云函数 riskWatch 权威写入一条监控（2026-10-13）。
 *
 * 与 keyword-alert.ts#addWatchViaCloud 同一取舍：端上 `personWatchLimit` 读的是
 * `users.membership` **镜像**（端上可改、可被改包绕过），而每一条监控都会在每天定时扫描里
 * 持续消耗上游检索预算 —— 所以「能不能再加一个」必须由云端按 `memberships`（权威表）说了算。
 * 云端回的是**结构化回执**，超限时带 `reason:'over_limit'` 与 `limit` / `tier`，**不会静默丢弃**。
 *
 * 返回 `null` = 云端不可用（函数未部署 / 网络抖动），调用方回退端上原有路径 ——
 * 与 utils/quota-guard.ts「云端优先、静默回退本机」同一取舍。
 */
async function monitorPersonViaCloud(
  personKey: string,
  name: string
): Promise<{ ok: boolean; message: string; fatal?: boolean } | null> {
  try {
    const res = (await callCloudFunction('riskWatch', {
      action: 'add',
      person_key: personKey,
      name
    })) as { ok?: boolean; reason?: string; limit?: number; tier?: string; message?: string } | null
    if (!res || typeof res.ok !== 'boolean') {
      diagLog('warn', 'db', 'riskWatch(add) 无有效回执，回退端上监控')
      return null
    }
    if (res.ok) return { ok: true, message: res.message || `已开始监控「${name}」` }
    /* over_limit 的文案按云端回执的档位生成（端上 mirror 可能已过期，以云端 tier 为准） */
    if (res.reason === 'over_limit') {
      return { ok: false, message: res.message || personWatchLimitNote(res.tier === 'member') }
    }
    return { ok: false, message: res.message || '监控失败，请重试' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'db', `riskWatch(add) 调用失败，回退端上监控：${msg}`)
    return null
  }
}

/**
 * 加监控。
 *
 * ⚠ **顺序不能动**：`requestSubscribeMessage` 必须是点击之后的第一个异步调用（微信要求，
 * 见 notify.ts），所以「请求授权」排在「查库 / 写库」前面。因此上限校验只能在授权之后做 ——
 * 极端情况下用户会在超限时白授权一次；相比「把授权埋在一次网络往返之后导致按钮直接失效」，
 * 这个代价小得多。
 *
 * 授权被拒也继续写监控（取舍 3）。
 *
 * 上限（2026-10-13 起分档，免费 / 会员各一档，真源见 config/benefits.ts#OPINION_LIMITS）：
 * 写入路径**优先走云端权威判定**（见 monitorPersonViaCloud，读 memberships 判档）；
 * 云端不可用时回退端上门禁 + 直接写库。
 *
 * 失败时若判定为**环境问题**（`keyword_watches` 集合没建 / 权限不允许端上写入），
 * 返回值带 `fatal: true`，调用方改用弹窗把「该做什么」说完（见 db.ts#explainDbFailure）。
 */
export async function monitorPerson(
  personKey: string,
  name: string
): Promise<{ ok: boolean; message: string; fatal?: boolean }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '请先到「我的」页登录' }

  let notifyNote = '（未开启推送，情况会出现在预警页）'
  if (riskNotifyConfigured()) {
    const res = await requestRiskNotify()
    notifyNote = res.ok ? '（有新情况会推送提醒）' : `（${res.message}，仍会出现在预警页）`
  }

  /* 云端权威判定优先（分档上限读 memberships，端上改包绕不过）。null = 云端不可用，走下面的回退。 */
  const viaCloud = await monitorPersonViaCloud(personKey, name)
  if (viaCloud) {
    return viaCloud.ok ? { ok: true, message: `${viaCloud.message}${notifyNote}` } : viaCloud
  }

  /*
   * 回退路径（云端未部署 / 调用失败）：端上门禁 + 直接写库，与 P2 改造后的行为一致。
   * ⚠ 端上这道上限是**体验层不是安全边界**（读 users.membership 镜像、整段可被改包绕过），
   *   真正的成本边界在云端 riskWatch（读 memberships 权威表）。回退期间可被绕过，属已知过渡态。
   * ⚠ 判定**只在「新增」这一支**做 —— listPersonWatches / 预警页读取从不截断：存量用户可能
   *   已监控超过免费档的人，那些数据原样保留、照常可看可用（且必须继续被云端扫描）。
   */
  const isMember = (await readMemberState()).member
  const limit = personWatchLimit(isMember)
  const rows = await listPersonWatches()
  if (!personWatchGate(rows.length, isMember).allowed) {
    return { ok: false, message: personWatchLimitNote(isMember) }
  }

  const now = new Date().toISOString()
  const { error } = await table('keyword_watches').insert({
    id: personWatchId(userId, personKey),
    openid: userId,
    /* 人名存在 keyword 字段里：预警页与云函数复用同一套「读一行拿显示名」的逻辑 */
    keyword: name,
    person_key: personKey,
    type: 'person',
    created_at: now,
    seen_at: now
  })
  if (error) {
    diagLog('warn', 'db', `监控写入失败：${error.message ?? error}`)
    /* 集合没建 / 权限不对是环境问题：重试无用，把原因和修法直接说出来。
       此前一律「监控失败，请重试」，用户只能反复点同一个按钮。 */
    const failure = explainDbFailure('keyword_watches', error, '监控')
    if (failure) return { ok: false, message: failure.message, fatal: failure.fatal }
    return { ok: false, message: '监控失败，请重试' }
  }

  /*
   * P2-29：与 keyword-alert.ts#addWatch 同一处理。上面的门禁是「先查数、再插入」，
   * 并发点击会落到 limit+1 条；而云端扫描不再裁存量、但写入路径按档拦新增 ——
   * 端上做不了原子计数，故插完复核一次：真超了就把**刚插的这条**撤回，如实报错。
   * ⚠ 这里删的只是本次刚插入的那一行，绝不触碰既有监控（既有存量一律保留）。
   */
  const afterCount = (await listPersonWatches()).length
  if (afterCount > limit) {
    const { error: rollbackErr } = await table('keyword_watches')
      .delete()
      .eq('id', personWatchId(userId, personKey))
    if (rollbackErr) diagLog('warn', 'db', `回滚超限监控失败：${rollbackErr.message ?? rollbackErr}`)
    return { ok: false, message: personWatchLimitNote(isMember) }
  }

  return { ok: true, message: `已开始监控「${name}」${notifyNote}` }
}

/** 取消监控（列表页显式操作：已确定处于监控态，省去一次存在性查询） */
export async function unmonitorPerson(personKey: string): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  const { error } = await table('keyword_watches').delete().eq('id', personWatchId(userId, personKey))
  if (error) {
    diagLog('warn', 'db', `取消监控失败：${error.message ?? error}`)
    return false
  }
  return true
}

/* ── 读信号与排序（纯逻辑，见 test/cases/01-pure.js）───────────────── */

/**
 * 读信号：一次 `in` 查询取回全部，不逐人查。
 * 上限按「人数 × 每人条数」给足 —— utils/db.ts#fetchAll 会内部分页突破小程序端 20 条硬限制，
 * 所以这里一次往返就够（逐人查是 5 倍等待）。
 */
export async function loadRiskSignals(personKeys: string[]): Promise<RiskSignalRow[]> {
  if (!personKeys.length) return []
  const { data, error } = await table('risk_signals')
    .select('*')
    .in('person_key', personKeys)
    .order('first_seen_at', { ascending: false })
    .limit(personKeys.length * SIGNALS_PER_PERSON)
  if (error) {
    diagLog('warn', 'db', `风险信号读取失败：${error.message ?? error}`)
    return []
  }
  return (data as RiskSignalRow[]) ?? []
}

/**
 * 读名人扫描快照（risk_scans，id = personKey）：拿「最近扫描时间 / 累计信号数」，
 * 供名人监控表格的「最近执行 / 结果」列填数（与 scan_logs 的执行日志是互补的两份数据：
 * 快照回答「现状」，日志回答「历史」）。
 */
export async function loadRiskScans(personKeys: string[]): Promise<RiskScanRow[]> {
  if (!personKeys.length) return []
  const { data, error } = await table('risk_scans')
    .select('*')
    .in('id', personKeys)
  if (error) {
    diagLog('warn', 'db', `风险扫描快照读取失败：${error.message ?? error}`)
    return []
  }
  return (data as RiskScanRow[]) ?? []
}

/**
 * 级别 → 排序权重。**只用于排序**，界面上不显示等级标签（取舍 2）。
 * 与云函数 riskWatch#LEVEL_RANK 同口径：司法/税务 → 商业合作/名誉维权 → 回应表态。
 */
const LEVEL_RANK: Record<RiskSignalRow['level'], number> = { high: 0, mid: 1, low: 2 }

/** 排序：先按类别（司法/税务在前），同类别按「第一次见到」倒序 */
export function sortSignals(rows: RiskSignalRow[]): RiskSignalRow[] {
  return rows.slice().sort((a, b) => {
    const byLevel = (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9)
    if (byLevel !== 0) return byLevel
    return String(b.first_seen_at ?? '').localeCompare(String(a.first_seen_at ?? ''))
  })
}

/** 预警页的一「人」一块 */
export interface PersonSignalGroup {
  personKey: string
  name: string
  /** 已按「类别从重到轻 + 新的在前」排好序 */
  signals: RiskSignalRow[]
  /** 最新一条信号的时间（决定板块之间谁排前面） */
  latestAt: string
}

/**
 * 按人分组：组间按「最近一条信号的时间」倒序（刚出情况的排最前），
 * 组内交给 sortSignals，每人最多 SIGNALS_PER_PERSON 条。
 */
export function groupSignals(rows: RiskSignalRow[], limitPerPerson = SIGNALS_PER_PERSON): PersonSignalGroup[] {
  const byPerson = new Map<string, RiskSignalRow[]>()
  for (const row of rows) {
    if (!row?.person_key) continue
    const list = byPerson.get(row.person_key)
    if (list) list.push(row)
    else byPerson.set(row.person_key, [row])
  }

  const groups: PersonSignalGroup[] = []
  for (const [personKey, list] of byPerson) {
    const signals = sortSignals(list).slice(0, limitPerPerson)
    const latestAt = list.reduce((max, s) => {
      const at = String(s.first_seen_at ?? '')
      return at > max ? at : max
    }, '')
    groups.push({ personKey, name: signals[0]?.name || personKey, signals, latestAt })
  }
  groups.sort((a, b) => b.latestAt.localeCompare(a.latestAt))
  return groups
}

/**
 * 「今天 / 昨天 / 09-28」：列表项的时间标签。
 * now 可注入，便于测试 —— 跨零点的行为不该由跑测试的机器时钟决定。
 */
export function seenLabel(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const days = Math.floor((now.getTime() - t) / 86400000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  /* P2-36：月日按 UTC+8 取，不再用 getMonth()/getDate()（设备本地）——
     信号时间由云端按 UTC+8 落库，用设备时区去格式化它，跨时区用户看到的日期会差一天。 */
  return shortDay8(t)
}
