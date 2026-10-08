import { buildPersonKey, DOMAIN_META, isDomainCode, parsePersonKey } from '@/config/domains'
import { HOT_PERSONS, HotPerson } from '@/config/hot'
import { callCloudFunction, isCloudConfigured } from './cloud'
import { diagLog } from './cloud-diagnostics'
import { table } from './db'

/**
 * 热门榜读取（§2.1 M1：原为静态运营位，V1.5 数据化，现由 AI 每日生产）。
 *
 * 三级数据源，自上而下回落，任何一级挂了都不至于让运营位变空：
 *  ① `hot_board` —— AI 每日榜（cloudfunctions/hotBoardRefresh 每天检索 + 结构化后落库）。
 *     这是唯一「真正反映当下的热门名人」的来源，**数组顺序即排名**，端上不再重排。
 *  ② `report_cache` —— 没有 AI 榜时（函数未部署 / 集合未建 / 首次冷启动），
 *     用「谁被查得多」的真实热度兜底，同样能反映关注度，只是缺少本周动态文案。
 *  ③ `config/hot.ts` 的静态 24 位 —— 云未配置 / 读取失败的最终兜底，保证永不为空。
 *
 * 「今日名人」「随机探索」仍用静态池（见 utils/explore.ts）：那两处要的是稳定可复现的池子，
 * 不适合每天换一批人。
 */

/** 榜单位数：与静态运营位一致（首页首屏预览 6 位，展开看全部） */
const BOARD_LIMIT = 24
/** 云端候选扫描上限：按「最近生成」取，只关心当下谁在被关注 */
const CLOUD_SCAN = 40
/** 内存缓存 TTL：tabBar 页每次显示都会重取，而榜单是天级变化的 */
const TTL_MS = 5 * 60 * 1000

/** AI 每日榜集合（写方：cloudfunctions/hotBoardRefresh；端上只读，见 dbInit/schema.js） */
const AI_BOARD_TABLE = 'hot_board'
/** 单文档方案：_id 固定 latest，覆盖写 */
const AI_BOARD_DOC = 'latest'
/** 超过这个时长就算「今天还没生成」→ 端上补跑一次生成。与云函数侧的幂等窗口对齐 */
const AI_BOARD_FRESH_MS = 20 * 60 * 60 * 1000
/** 补跑的最小间隔：函数没部署 / 一直失败时，避免每次进页都发一次云调用 */
const ENSURE_GAP_MS = 30 * 60 * 1000

/**
 * AI 榜单行 → 榜单。字段全部容错，脏条目直接丢弃（模型偶尔会给出空名字 / 非法领域）。
 * 去重按人名：同一个人被分到两个领域时，榜面上就是两张一样的卡。
 */
function toAiBoard(row: any): HotPerson[] {
  const raw = Array.isArray(row?.items) ? row.items : []
  const seen = new Set<string>()
  const out: HotPerson[] = []
  for (const it of raw) {
    const name = typeof it?.name === 'string' ? it.name.trim() : ''
    const domain = typeof it?.domain === 'string' ? it.domain : ''
    if (name === '' || !isDomainCode(domain) || seen.has(name)) continue
    seen.add(name)
    /* 不带 heat：AI 榜单的顺序就是排名，热度条已按需求从卡片上移除 */
    out.push({
      name,
      domain,
      tag: typeof it?.tag === 'string' ? it.tag.trim() : DOMAIN_META[domain].label,
      trend: typeof it?.trend === 'string' ? it.trend.trim() : ''
    })
  }
  return out.slice(0, BOARD_LIMIT)
}

let ensureAt = 0

/**
 * 冷启动补跑：定时器还没跑到 / 新环境还没建榜时，让端上把这轮生成触发起来。
 * 刻意**不 await** —— 生产一轮要几十秒，首屏运营位不能等它；
 * 函数侧有 20h 幂等闸门，所以就算被多个用户同时触发，一天也只打一轮上游。
 */
function ensureAiBoard(): void {
  if (!isCloudConfigured) return
  if (Date.now() - ensureAt < ENSURE_GAP_MS) return
  ensureAt = Date.now()
  callCloudFunction('hotBoardRefresh', { action: 'ensure' })
    .then((res) => diagLog('info', 'db', `热门榜补跑已触发：${JSON.stringify(res)}`))
    .catch((err) => diagLog('warn', 'db', `热门榜补跑失败：${err instanceof Error ? err.message : String(err)}`))
}

/** 读 AI 每日榜；集合不存在 / 权限未开 / 无数据都返回空，交由下一级兜底 */
async function queryAiBoard(): Promise<{ board: HotPerson[]; fresh: boolean }> {
  const res = await table(AI_BOARD_TABLE).select('*').eq('id', AI_BOARD_DOC).maybeSingle()
  if (res.error) {
    diagLog('warn', 'db', `AI 榜单读取失败，回落真实热度：${res.error.message ?? res.error}`)
    return { board: [], fresh: false }
  }
  const board = toAiBoard(res.data)
  const at = typeof res.data?.generated_at === 'string' ? Date.parse(res.data.generated_at) : NaN
  return { board, fresh: Number.isFinite(at) && Date.now() - at < AI_BOARD_FRESH_MS }
}

/** 种子索引：云端条目沿用同名种子的 tag（运营标签），trend 则优先用报告里的最新动态 */
const SEED = new Map(HOT_PERSONS.map((p) => [buildPersonKey(p.name, p.domain), p]))

interface CloudCandidate {
  personKey: string
  heat: number
  brief: string
}

/** 卡片上那句「动态速览」：优先最新一条动态标题，其次简介首句 */
function pickBrief(report: any): string {
  const first = Array.isArray(report?.dynamics) ? report.dynamics[0] : null
  const title = typeof first?.title === 'string' ? first.title.trim() : ''
  if (title !== '') return title
  const intro = typeof report?.intro === 'string' ? report.intro.trim() : ''
  return intro === '' ? '' : intro.slice(0, 40)
}

/**
 * 缓存行 → 候选。字段全部容错：脏数据只让这一行消失，不污染榜单。
 * 身份以行主键 personKey 为准（全局标识），报告正文里的 name 只是副本。
 */
function toCandidate(row: any): CloudCandidate | null {
  const report = row?.report
  if (!report || typeof report !== 'object') return null
  const parsed = parsePersonKey(typeof row?.id === 'string' ? row.id : '')
  if (!parsed) return null
  const heat = report.heat
  if (typeof heat !== 'number' || !Number.isFinite(heat)) return null
  return {
    personKey: buildPersonKey(parsed.name, parsed.domain),
    heat: Math.max(0, Math.min(100, Math.round(heat))),
    brief: pickBrief(report)
  }
}

/** 同一人物理论上只有一行，防手改数据：取热度更高的一条 */
function dedupe(cands: CloudCandidate[]): CloudCandidate[] {
  const best = new Map<string, CloudCandidate>()
  for (const c of cands) {
    const prev = best.get(c.personKey)
    if (!prev || c.heat > prev.heat) best.set(c.personKey, c)
  }
  return [...best.values()]
}

/** 云端候选 + 种子池 → 榜单（按 heat 降序，截断到 BOARD_LIMIT） */
function merge(cloud: CloudCandidate[]): HotPerson[] {
  const merged = new Map<string, HotPerson>()
  for (const c of cloud) {
    const parsed = parsePersonKey(c.personKey)
    if (!parsed) continue
    const seed = SEED.get(c.personKey)
    merged.set(c.personKey, {
      name: parsed.name,
      domain: parsed.domain,
      heat: c.heat,
      tag: seed?.tag ?? DOMAIN_META[parsed.domain].label,
      trend: c.brief !== '' ? c.brief : seed?.trend ?? ''
    })
  }
  for (const p of HOT_PERSONS) {
    const key = buildPersonKey(p.name, p.domain)
    if (!merged.has(key)) merged.set(key, p)
  }
  /* heat 可缺省（AI 榜单条目不带值），缺省按 0 处理；这里所有条目都来自种子 / 缓存，实际都带值 */
  return [...merged.values()].sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0)).slice(0, BOARD_LIMIT)
}

/** 读 report_cache 的 ready 行；失败返回空数组，由调用方走种子兜底 */
async function queryRows(): Promise<any[]> {
  const ordered = await table('report_cache')
    .select('*')
    .eq('state', 'ready')
    .order('generated_at', { ascending: false })
    .limit(CLOUD_SCAN)
  if (!ordered.error) return (ordered.data as any[]) ?? []

  /* orderBy 依赖 generated_at 索引（建表脚本 §四）。索引未建时云侧会拒，
     退化为不排序扫描：数据量小时端上排序等价，量大也只是榜单不够「新」 */
  diagLog('warn', 'db', `热门榜按时间读取失败，回退无排序：${ordered.error.message ?? ordered.error}`)
  const plain = await table('report_cache').select('*').eq('state', 'ready').limit(CLOUD_SCAN)
  if (plain.error) {
    diagLog('warn', 'db', `热门榜读取失败，回落静态种子：${plain.error.message ?? plain.error}`)
    return []
  }
  return (plain.data as any[]) ?? []
}

let memo: { at: number; board: HotPerson[] } | null = null
let pending: Promise<HotPerson[]> | null = null

async function build(): Promise<HotPerson[]> {
  /* 云环境未配置时直接走种子池：DB 调用只会抛可读错误，没必要发出去 */
  if (!isCloudConfigured) {
    memo = { at: Date.now(), board: HOT_PERSONS }
    return HOT_PERSONS
  }

  // ① AI 每日榜：顺序即排名，端上不再重排
  const ai = await queryAiBoard()
  if (ai.board.length > 0) {
    /* 榜单过期就顺手补跑一轮；本次仍用旧榜（天级变化，昨天的榜远好过退回静态池） */
    if (!ai.fresh) ensureAiBoard()
    diagLog('info', 'db', `热门榜采用 AI 每日榜：${ai.board.length} 位${ai.fresh ? '' : '（已过期，已触发补跑）'}`)
    memo = { at: Date.now(), board: ai.board }
    return ai.board
  }

  // ② 没有 AI 榜 → 真实热度兜底，并触发一次补跑，下一轮进页就能拿到 AI 榜
  ensureAiBoard()
  const rows = await queryRows()
  const cloud = dedupe(rows.map(toCandidate).filter((c): c is CloudCandidate => c !== null))
  const board = merge(cloud)
  if (cloud.length > 0) {
    diagLog('info', 'db', `热门榜回落真实热度：${cloud.length} 位来自真实报告，共 ${board.length} 位上榜`)
  }
  memo = { at: Date.now(), board }
  return board
}

/**
 * 取当前热门榜（TTL 内复用内存结果；并发调用共享同一次请求）。
 * 永不 reject —— 首页运营位不该因为一次 DB 抖动变成空块，最坏情况就是回到静态种子。
 */
export function loadHotBoard(): Promise<HotPerson[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return Promise.resolve(memo.board)
  if (pending) return pending

  pending = build()
    .catch((err) => {
      diagLog('warn', 'db', `热门榜构建异常，回落静态种子：${err instanceof Error ? err.message : String(err)}`)
      return HOT_PERSONS
    })
    .finally(() => {
      pending = null
    })
  return pending
}
