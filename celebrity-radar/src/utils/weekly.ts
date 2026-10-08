import Taro from '@tarojs/taro'
import { z } from 'zod'
import { chatJSON } from './llm'
import { getFeedDetail } from './cache'
import { listFollows } from './follows'
import { NewsItem } from './search'
import { DISCLAIMER, isRefusedResult } from './report'
import { setCooldown, cooldownMinutesLeft } from './cooldown'
import { peekGenerateQuota, consumeGenerateQuota } from './quota'
import { quotaExhaustedMessage } from './member'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { diagLog } from './cloud-diagnostics'
import { currentWeekKey, last7DayRange } from './time'
import { DomainCode, parsePersonKey } from '@/config/domains'

/**
 * 关注周报（§2.2 M5-2「手动生成周报」）。
 *
 * 定位：把「关注流」里已经落到 `feed_cache` 的动态，按人归并成一份可读、可复制、可分享的周报。
 * 三条设计取舍：
 *
 * 1) **不新增采集**。素材只读 `feed_cache`（打开即读缓存，零检索成本），
 *    因此周报「有没有内容」取决于用户是否下拉刷新过关注流 —— 空态即引导去刷新，
 *    这也是把两个功能串成一条动作链的意图。不重复调博查，也不会绕过刷新配额。
 *
 * 2) **素材清单不走模型**。条目（标题/来源/日期/链接）直接取自 `feed_cache`，
 *    模型只负责 `overview`（总览）、`summaries`（逐人摘要）与 `topics`（话题词）。
 *    这样「哪个人有哪些动态」不依赖模型输出，从根本上杜绝漏人、编造链接，
 *    校验层只需要处理三段文字，比整份报告宽松得多。
 *
 * 3) **缓存放本机 storage，不加第 11 张集合**。周报是「本机生成的一次性产物」：
 *    存云要么新增集合（多一步人工配置才能用），要么挤进「所有人可读」的共享缓存表
 *    （关注画像属个人信息，不该被他人读到）。故按自然周存本机，跨周自动失效，
 *    并随「清空我的数据」一并清除。
 *
 * 成本闸门与报告一致：**生成**才消耗今日生成配额（与报告同池），读缓存零成本。
 */

/** 统计窗口：最近 7 天（见 utils/time.ts 的 last7DayRange） */
export const WEEKLY_WINDOW_DAYS = 7
/** 单份周报最多覆盖的人数（与关注流刷新的博查上限对齐） */
export const WEEKLY_PERSON_LIMIT = 10
/** 每人最多取几条素材进模型（控制提示词体积，超出部分仍会进真值清单） */
const PROMPT_ITEMS_PER_PERSON = 3
/** 单条素材正文进模型的截断长度 */
const PROMPT_CONTENT_MAX = 280
/** 本机缓存键前缀（按 ISO 周存，跨周自动作废） */
const STORAGE_PREFIX = 'weekly:'

/* ===== 材料 ===== */

/** 流条目 + 归属人（与关注流页的 FeedEntry 同构） */
export interface WeeklyEntry extends NewsItem {
  personKey: string
  personName: string
  domain: DomainCode
}

export interface WeeklyPerson {
  personKey: string
  name: string
  domain: DomainCode
  entries: WeeklyEntry[]
}

export interface WeeklyMaterial {
  persons: WeeklyPerson[]
  /** 窗口文案（yyyy-mm-dd ~ yyyy-mm-dd） */
  windowLabel: string
  /** 窗口内素材总条数 */
  entryCount: number
  /** 读取失败的关注人数：>0 说明结果不完整，界面需显式告知 */
  failedCount: number
}

export type MaterialOutcome =
  | { kind: 'ok'; material: WeeklyMaterial }
  | { kind: 'nologin' }
  | { kind: 'nofollow' }
  | { kind: 'nomaterial' }

/** 空态文案：页面对三种「没有材料」的原因给出不同出口 */
export const MATERIAL_FAIL_TEXT: Record<Exclude<MaterialOutcome['kind'], 'ok'>, string> = {
  nologin: '登录后即可把关注的名人汇总成周报',
  nofollow: '还没有关注任何名人，先去关注几位再来生成周报',
  nomaterial: '关注的人最近 7 天还没有可汇总的动态'
}

/**
 * 从一个人的 `feed_cache` 里挑出属于统计窗口的条目。
 *
 * 素材带发布时间时按时间窗过滤；不带时间的做兜底：只有「本周抓过」的缓存才敢算进本周，
 * 否则会把三周前抓到的旧闻当成新鲜事写进周报（这是最容易让用户失去信任的失真）。
 */
function pickWindowEntries(
  items: NewsItem[],
  fetchedAt: string | null,
  sinceMs: number
): NewsItem[] {
  const dated = items.filter((it) => {
    if (!it.publishedDate) return false
    const t = Date.parse(it.publishedDate)
    return Number.isFinite(t) && t >= sinceMs
  })
  if (dated.length > 0) return dated.slice(0, PROMPT_ITEMS_PER_PERSON)

  const fetchedMs = fetchedAt ? Date.parse(fetchedAt) : NaN
  if (!Number.isFinite(fetchedMs) || fetchedMs < sinceMs) return []
  return items.filter((it) => !it.publishedDate).slice(0, PROMPT_ITEMS_PER_PERSON)
}

/** 汇总关注人的周报材料（只读 feed_cache，不发任何网络请求） */
export async function collectWeeklyMaterial(): Promise<MaterialOutcome> {
  const userId = useAuth.getState().userId
  if (!userId) return { kind: 'nologin' }

  const follows = await listFollows()
  if (follows.length === 0) return { kind: 'nofollow' }

  const range = last7DayRange(WEEKLY_WINDOW_DAYS)
  const sinceMs = Date.parse(range.since)

  /* 并发读、按关注列表顺序回填：关注顺序即用户在意的顺序，不该被并发打乱 */
  const picked = await Promise.all(
    follows.slice(0, WEEKLY_PERSON_LIMIT).map(async (f) => {
      const detail = await getFeedDetail(f.person_key)
      if (!detail.ok) return { ok: false as const }
      const domain = parsePersonKey(f.person_key)?.domain ?? 'other'
      const entries: WeeklyEntry[] = pickWindowEntries(detail.items, detail.fetchedAt, sinceMs).map(
        (it) => ({ ...it, personKey: f.person_key, personName: f.name, domain })
      )
      return { ok: true as const, person: { personKey: f.person_key, name: f.name, domain, entries } }
    })
  )

  const persons: WeeklyPerson[] = []
  let failedCount = 0
  let entryCount = 0
  for (const r of picked) {
    if (!r.ok) {
      failedCount++
      continue
    }
    if (r.person.entries.length === 0) continue
    persons.push(r.person)
    entryCount += r.person.entries.length
  }

  if (persons.length === 0) return { kind: 'nomaterial' }
  return { kind: 'ok', material: { persons, windowLabel: range.label, entryCount, failedCount } }
}

/* ===== 生成 ===== */

export interface WeeklyReportPerson {
  personKey: string
  name: string
  domain: DomainCode
  /** 该人本周要点（AI；降级时为空） */
  summary: string
  entries: WeeklyEntry[]
}

export interface WeeklyReport {
  weekKey: string
  windowLabel: string
  generatedAt: string
  personCount: number
  entryCount: number
  overview: string
  persons: WeeklyReportPerson[]
  topics: string[]
  disclaimer: string
  /** 降级：模型拒答或没给出任何文字，只呈现素材清单（UI 需提示） */
  degraded?: true
}

const LlmWeeklySchema = z.union([
  z.object({ refused: z.literal(true) }),
  z.object({
    refused: z.literal(false).optional(),
    overview: z.string().default(''),
    summaries: z.array(z.object({ name: z.string(), summary: z.string().default('') })).default([]),
    topics: z.array(z.string()).default([])
  })
])

/**
 * sanitizeWeekly 的输入形态（宽松：字段可能缺失）。
 *
 * 刻意不直接用 `z.infer<typeof LlmWeeklySchema>`：Schema 里的 `.default()` 让**输入**侧字段可选、
 * 输出侧必填，把它当参数类型会在弱类型检查上报「无共同属性」。这里单独声明一个「什么都可缺」的
 * 宽容形态，让「模型少给一段」变成降级而不是报错（见 sanitizeWeekly 末尾的 degraded 判定）。
 */
interface LlmWeeklyFields {
  overview?: string
  summaries?: Array<{ name?: string; summary?: string }>
  topics?: string[]
}

const SYSTEM_WEEKLY = [
  '你是名人动态周报编辑。基于提供的「关注人近期动态素材」，写一份简洁的中文周报。',
  '硬约束：',
  '1. 只依据素材内容，不编造事件、日期与来源；素材没提到的内容一律不写。',
  '2. overview：不超过 200 字的整体观察，点出这些人本周的共同动向或值得注意的变化；措辞中性客观，不褒贬、不预测。',
  '3. summaries：逐个覆盖素材中出现的每个人，summary 不超过 80 字，概括其本周公开动态要点。',
  '4. topics：3~5 个本周高频话题关键词（每个 2~8 字的名词短语）。',
  '5. 若素材涉及政治、军事类敏感人物，仅返回 {"refused": true}。',
  '6. 只输出 JSON，格式：{"overview":string,"summaries":[{"name":string,"summary":string}],"topics":[string]}'
].join('\n')

function buildWeeklyUserMessage(material: WeeklyMaterial): string {
  const lines: string[] = [`统计窗口：${material.windowLabel}（最近 ${WEEKLY_WINDOW_DAYS} 天）`, '素材：']
  for (const p of material.persons) {
    lines.push(`【${p.name}】`)
    for (const e of p.entries) {
      const date = e.publishedDate ? e.publishedDate.slice(0, 10) : '近期'
      const head = `- ${e.title}（${e.source || '未知来源'} · ${date}）`
      /* 兼容历史脏缓存：2026-10-07 前的 notifyFollowUpdates 只写标题 + 链接，content 为空，
         此处若直接 .slice 会抛 TypeError 打断整份周报；空正文就只留标题行 */
      const body = (e.content || '').trim()
      lines.push(body ? `${head}\n  ${body.slice(0, PROMPT_CONTENT_MAX)}` : head)
    }
  }
  return lines.join('\n')
}

/**
 * 代码层强制校验（不信任提示词，与 report.ts 同思路）：
 * 1. 人员清单以**材料为准**，模型只能补摘要，不能增删人；
 * 2. 摘要按人名对齐，模型给了不在清单里的名字直接丢弃；
 * 3. topics 去重、限长、限量。
 */
export function sanitizeWeekly(material: WeeklyMaterial, llm: LlmWeeklyFields, refused = false): WeeklyReport {
  const summaryByName = new Map<string, string>()
  for (const s of llm.summaries ?? []) {
    const name = (s.name ?? '').trim()
    if (!name || summaryByName.has(name)) continue
    summaryByName.set(name, (s.summary ?? '').trim())
  }

  const topics: string[] = []
  for (const raw of llm.topics ?? []) {
    const t = raw.trim()
    if (t.length < 2 || t.length > 12 || topics.includes(t)) continue
    topics.push(t)
    if (topics.length >= 6) break
  }

  const persons: WeeklyReportPerson[] = material.persons.map((p) => ({
    personKey: p.personKey,
    name: p.name,
    domain: p.domain,
    summary: refused ? '' : (summaryByName.get(p.name) ?? ''),
    entries: p.entries
  }))

  const overview = refused ? '' : (llm.overview ?? '').trim()
  const hasText = !!overview || persons.some((p) => p.summary)
  if (!hasText) {
    diagLog('warn', 'auth', '周报未产出任何文字，降级为素材清单')
  }

  const report: WeeklyReport = {
    weekKey: currentWeekKey(),
    windowLabel: material.windowLabel,
    generatedAt: new Date().toISOString(),
    personCount: persons.length,
    entryCount: material.entryCount,
    overview,
    persons,
    topics: refused ? [] : topics,
    disclaimer: DISCLAIMER
  }
  return hasText ? report : { ...report, degraded: true }
}

/* ===== 本机缓存（按 ISO 周） ===== */

function storageKey(weekKey: string): string {
  return `${STORAGE_PREFIX}${weekKey}`
}

function isWeeklyReport(v: unknown): v is WeeklyReport {
  if (!v || typeof v !== 'object') return false
  const r = v as WeeklyReport
  /* 只认本周的缓存：跨周即视为不存在（旧键由 writeWeeklyCache 顺手清掉） */
  return r.weekKey === currentWeekKey() && Array.isArray(r.persons) && !!r.windowLabel
}

/** 读本周周报缓存（同步、零成本）；无缓存或已跨周返回 null */
export function readWeeklyCache(): WeeklyReport | null {
  try {
    const raw = Taro.getStorageSync(storageKey(currentWeekKey()))
    if (!raw) return null
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return isWeeklyReport(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeWeeklyCache(report: WeeklyReport): void {
  try {
    /* 只保留本周一份：旧周键没有任何读取路径，留着只会占本机空间 */
    for (const k of Taro.getStorageInfoSync().keys) {
      if (k.startsWith(STORAGE_PREFIX) && k !== storageKey(report.weekKey)) Taro.removeStorageSync(k)
    }
    Taro.setStorageSync(storageKey(report.weekKey), report)
  } catch (err) {
    diagLog('warn', 'db', `周报缓存写入失败：${String(err)}`)
  }
}

/** 清空本机全部周报缓存（「清空我的数据」调用） */
export function clearWeeklyCache(): void {
  try {
    for (const k of Taro.getStorageInfoSync().keys) {
      if (k.startsWith(STORAGE_PREFIX)) Taro.removeStorageSync(k)
    }
  } catch {
    /* 静默：清理失败不影响主流程 */
  }
}

/* ===== 生成主入口 ===== */

export type WeeklyOutcome =
  | { kind: 'ok'; report: WeeklyReport }
  | { kind: 'quota'; message: string }
  | { kind: 'cooldown'; message: string }
  | { kind: 'error'; message: string }

/**
 * 生成周报（消耗 1 次今日生成配额）。
 *
 * 不做缓存判断：页面已先读缓存，只有确实要生成时才调这里，
 * 免得「重新生成」被缓存再挡一次（force 语义反而不清晰）。
 */
export async function generateWeekly(material: WeeklyMaterial): Promise<WeeklyOutcome> {
  const userId = useAuth.getState().userId
  if (!userId) return { kind: 'error', message: '请先登录' }

  /* 冷却先于配额：冷却源于上游限流，重试无意义，不必先扣用户额度 */
  const left = cooldownMinutesLeft('llm')
  if (left > 0) return { kind: 'cooldown', message: `生成服务限流冷却中（约 ${left} 分钟），稍后再试` }

  try {
    const quota = await peekGenerateQuota(userId)
    if (!quota.allowed) {
      return {
        kind: 'quota',
        message: quotaExhaustedMessage(quota.member, quota.limit, '已生成的周报仍可查看')
      }
    }
  } catch (err) {
    /* 配额服务异常不拦生成（与 report/cache 的降级哲学一致） */
    diagLog('warn', 'db', `周报配额检查失败，放行本次生成：${err instanceof Error ? err.message : String(err)}`)
  }

  const res = await chatJSON(SYSTEM_WEEKLY, buildWeeklyUserMessage(material), LlmWeeklySchema)
  if (!res.ok) {
    /* 与 report.ts 同一套冷却口径：只有限流 / 网络 / 5xx 才值得让用户等 */
    const rateLimited = /频繁|429/.test(res.error)
    if (res.retryable || rateLimited) setCooldown('llm')
    return { kind: 'error', message: res.error }
  }

  let report: WeeklyReport
  if (isRefusedResult(res.data)) {
    diagLog('info', 'auth', '周报 LLM 拒答，降级为素材清单')
    report = sanitizeWeekly(material, {}, true)
  } else {
    report = sanitizeWeekly(material, res.data, false)
  }

  writeWeeklyCache(report)
  track('weekly_generate', { personCount: report.personCount, entryCount: report.entryCount })
  /* 与报告一致：只对「用户确实拿到了周报」计数（best-effort，失败不影响返回） */
  void consumeGenerateQuota(userId)
  return { kind: 'ok', report }
}
