/**
 * 报告历史版本（S3-1 ③，2026-10-16）。
 *
 * 要解决的事：`report_cache` 一人一份、`force` 重生即**整篇替换**，于是「上一版报告说了什么」
 * 过去是不可回溯的 —— 而职业用户的真实需求里，「这家公司上个月的判断」与「这次改了什么」
 * 恰恰是报告本身最值钱的两个问题（危机公关前后口径是否变了、热度的判断有没有反转）。
 *
 * 数据不是这里产生的：被覆盖掉的旧版由云端写口在**落库成功之后**写进 `report_versions`
 * （`cloudfunctions/aiProxy/report-store.js#recordVersion`），端上只读。本模块只做三件事：
 *   ① 读口（列表 / 单版正文）；
 *   ② 列表怎么算（纯函数，见 `buildVersionList`）；
 *   ③ 分层门禁（免费看到什么、会员得到什么）。
 *
 * ── 分层口径（这是本模块最需要说清的一件事）─────────────────────────────
 * 与「站内看报告免费」**不冲突**，因为收的不是同一件事：
 *   · 免费：**当前版**照旧完整可见（会员节仍是锁态），且**版本列表完全可见**
 *     —— 看得见「这份报告在 10-14 更新过、上一版素材少 12 条」这个事实本身；
 *   · 会员：**打开历史版本读正文**（职业用户的回溯需求）。
 * 把「更新过几次」藏起来会让人根本不知道有这能力（入口即转化）；把「回看旧版」也免费，
 * 则 S3-1「付费点从额度转向能力」这条线里就少了最实的一块。故列表免费、正文是会员能力。
 *
 * ⚠ 旧版正文**必须**经 `cache.ts#exposeReport` 过滤后才交出去：旧版里可能带着当时会员生成的
 *   段落，绕过它就是把会员内容发给免费读者（那条不变式的正题）。本模块不新造第二条过滤口径。
 */

import { table } from '@/utils/db'
import { exposeReport, getCachedReport } from '@/utils/cache'
import { diagLog } from '@/utils/cloud-diagnostics'
import type { ReportVersionRow } from '@/types/db'
import type { Report } from '@/utils/report'

/**
 * 一次最多取几版。
 *
 * 云端保留策略是 5 版（`REPORT_VERSION_KEEP`），这里取 10 是**刻意宽于云端**：两份数值
 * 不联动（端上从不「按条数补数据」，只显示取回来的那些），而留这点余量的好处是 ——
 * 哪天云端把保留数调大，端上不用跟着发版本；调小更不影响。写成同一个数反而会诱人去做联动。
 */
export const VERSION_LIST_MAX = 10

/**
 * 版本列表里的一行（**不含正文**）。
 *
 * 列表查询刻意**不投影 `report` 字段**：5~10 份正文是几百 KB，而这一屏只需要时间与几个数字 ——
 * 正文在「点开这一版」时才按 `_id` 读单条（见 `loadVersionReport`）。这既省流量，
 * 也让「免费用户拿不到旧版正文」不止靠 UI 拦（数据根本没到本地）。
 */
export interface VersionListRow {
  id: string
  name: string
  /** 这一版什么时候生成的 */
  generatedAt: string
  /** 它什么时候被换掉的 */
  replacedAt: string
  /** 这一版那时的素材条数 */
  newsCount: number
  /**
   * 与**更新的一版**比，素材条数差多少（`+` = 这一版更多，`-` = 更少）；
   * 没有可比对象（最新一版且当前版信息缺失）时为 `null`。
   *
   * 只给数字差，不给「这版更好 / 更差」这类判断 —— 同工作台对比表的口径：
   * 排序与评价一旦由平台给出，用户看到的就是我们的偏好，而不是他自己的判断。
   */
  newsDelta: number | null
  /** 这一版在线上待了多久（毫秒）；时间戳不可解析或早于生成时间时为 `null` */
  heldMs: number | null
}

/** 页面要的两块：历史版本列表 + 当前版（`report_cache` 里那一行）的基本信息 */
export interface VersionBoard {
  rows: VersionListRow[]
  /** 当前版信息；`null` = 还没有报告（或读不到）—— 页面据此不显示「当前版」那一行 */
  current: { generatedAt: string; newsCount: number } | null
}

/* ══════════════════════════ 纯函数 ══════════════════════════ */

const timeOf = (iso: string | undefined | null): number | null => {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? t : null
}

/**
 * 组装列表行（纯函数）：排序 + 与更新的一版作差 + 「用了多久」。
 *
 * **自己再排一次序**（不依赖读口已 `order('id')`）：读口排序是「按 `_id` 降序」这一实现细节，
 * 而这一屏的全部意义就是时间顺序 —— 谁哪天被换掉了必须一眼看得出来。万一哪天有人改了读口的
 * 排序（或换了读口），页面会静默变成乱序，那是最难被发现的一类错。排序键用 `generatedAt`，
 * 与 `_id` 的字典序在数据上等价（`_id` 就是 `personKey#generatedAt` 拼的）。
 */
export function buildVersionList(
  rows: ReportVersionRow[],
  current: VersionBoard['current']
): VersionListRow[] {
  const sorted = [...(rows ?? [])].sort((a, b) => (timeOf(b?.generated_at) ?? 0) - (timeOf(a?.generated_at) ?? 0))

  return sorted.map((row, i) => {
    const gen = timeOf(row?.generated_at)
    const rep = timeOf(row?.replaced_at)
    /* 更新的一版：列表里它上面那一条；第一条（最近被换掉的那一版）的「更新的一版」就是当前版 */
    const newer = i === 0 ? current?.newsCount : sorted[i - 1]?.news_count
    const news = typeof row?.news_count === 'number' ? row.news_count : null
    return {
      id: String(row?.id ?? ''),
      name: String(row?.name ?? ''),
      generatedAt: String(row?.generated_at ?? ''),
      replacedAt: String(row?.replaced_at ?? ''),
      newsCount: typeof news === 'number' ? news : 0,
      newsDelta: typeof news === 'number' && typeof newer === 'number' ? news - newer : null,
      heldMs: gen !== null && rep !== null && rep >= gen ? rep - gen : null
    }
  })
}

/**
 * 「这一版在线上待了多久」的文案。
 *
 * 算不出来返回空串（**宁可不显示也不编一个数**）—— 与「不确定的事不说」一路：
 * 时间戳缺失时写「不到 1 小时」是凭空生成了一个事实。
 *
 * 上限只到「天」：再往上（月 / 年）精度没有意义，而「30 天」这种写法在中文里比「1 个月」更不含糊。
 */
export function heldText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return ''
  const hours = Math.floor(ms / 3600000)
  if (hours < 1) return '不到 1 小时'
  if (hours < 24) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/**
 * 「与更新的一版比，素材多了还是少了」的文案。
 *
 * `null`（没有可比对象）与 `0`（一样多）**必须分开**：前者是不知道，后者是确切的「没变」，
 * 混成一个「±0」会让用户以为我们真比过（同工作台里 `null` 与 `0` 的取舍）。
 */
export function newsDeltaText(delta: number | null): string {
  if (delta === null) return ''
  if (delta === 0) return '素材与新版持平'
  return delta > 0 ? `素材比新版多 ${delta} 条` : `素材比新版少 ${-delta} 条`
}

/* ══════════════════════════ 分层门禁 ══════════════════════════ */

/**
 * 打开历史版本看正文是不是会员能力？二元口径、无数值 —— 与 `canExportReport` /
 * `canExportReportCard` / `canExportWeeklyBrief` 同一分层方式（见 config/benefits.ts 的权益真源）。
 *
 * 分层理由见文件头「分层口径」：**列表免费可见、正文是会员能力**。
 */
export function canViewVersionReport(member: boolean): boolean {
  return !!member
}

/** 免费用户点开某一版时的那一行说明（非弹窗：页面上的一行字，点了跳会员页） */
export function versionHistoryNote(): string {
  return '回看历史版本是会员能力：报告每次更新前的版本都留着，可对照「这次改了什么」'
}

/* ══════════════════════════ 读口 ══════════════════════════ */

/**
 * 读某个人的历史版本列表（不含正文）+ 当前版信息。
 *
 * 两个查询并行：`report_versions` 按 `_id` 降序（= 生成时间降序，理由同云端 `trimVersions`：
 * `_id` 天生有索引，排序不会因为「索引未建」被云侧拒），以及 `report_cache` 那一行
 * —— 列表要能说「比当前版少几条素材」，而当前版的条数只在 `search_meta` 里。
 *
 * 读失败一律返回空列表（不抛错）：历史版本是**附加信息**，它读不到不该让页面变成错误态，
 * 页面据 `rows.length === 0` 显示「还没有更新过的版本」即可。
 */
export async function loadReportVersions(personKey: string): Promise<VersionBoard> {
  const empty: VersionBoard = { rows: [], current: null }
  const key = (personKey ?? '').trim()
  if (!key) return empty

  const [list, cur] = await Promise.all([
    table('report_versions')
      .select('id,person_key,name,generated_at,replaced_at,news_count')
      .eq('person_key', key)
      .order('id', { ascending: false })
      .limit(VERSION_LIST_MAX),
    table('report_cache').select('id,generated_at,search_meta').eq('id', key).maybeSingle()
  ])

  if (list.error) {
    diagLog('warn', 'db', `report_versions 读取失败：${list.error.message ?? list.error}`)
    return empty
  }

  const curRow = (cur.error ? null : cur.data) as
    | { generated_at?: string; search_meta?: { news_count?: number } | null }
    | null
  const newsRaw = curRow?.search_meta?.news_count
  const current: VersionBoard['current'] = curRow?.generated_at
    ? { generatedAt: String(curRow.generated_at), newsCount: typeof newsRaw === 'number' ? newsRaw : 0 }
    : null

  return {
    rows: buildVersionList((list.data as ReportVersionRow[]) ?? [], current),
    current
  }
}

/**
 * 读某一版的正文（按**当前读者**身份过滤后交出去）。
 *
 * 返回 `null` = 取不到：这一版已被保留策略裁掉、`_id` 不存在、或读库失败 —— 三种情况对页面
 * 是同一件事（这一版打不开了），不分开处理。
 *
 * `knownMember`：页面已经在读列表时读过一次会员态，传进来可免掉 `exposeReport` 里的那次
 * users 读（同 `cache.ts` 给生成路径留的那个口子）。不传则本函数自己读（判定仍然是权威表口径）。
 */
export async function loadVersionReport(id: string, knownMember?: boolean): Promise<Report | null> {
  const key = (id ?? '').trim()
  if (!key) return null
  const { data, error } = await table('report_versions').select('id,report').eq('id', key).maybeSingle()
  if (error || !data?.report) return null
  return (await exposeReport(data.report as Report, knownMember)).report
}

/**
 * 「某一版 + 更新的一版」两份正文（N-9 差异视图用，纯读口，比对逻辑在 `utils/report-diff.ts`）。
 *
 * 方向由列表顺序定（`rows` 来自 `loadReportVersions`，按生成时间降序）：第 `index` 行「更新的一版」
 * 就是第 `index - 1` 行；而第 0 行（最近被换掉的那一版）「更新的一版」是**当前版**
 * （`report_cache` 里那一行）—— 这正是 N-2「报告更新回访」要的那一对，也是持有 `heldDays`
 * 那条埋点想验证的判断（用户要的是「今天这次改了什么」，故先把这一对做出来）。
 *
 * 两侧各自可能取不到（这一版已被保留策略裁掉 / 当前版还没生成 / 读库失败）：**不抛错、
 * 也不拿半份数据拼一个看起来像对比的东西**，返回 `null` 的那一侧由调用方决定不出这一块。
 */
export interface VersionPair {
  /** 用户点开的这一版（旧的那一侧） */
  prev: Report | null
  /** 更新的一侧；`null` = 取不到（见上） */
  next: Report | null
  /** `next` 是不是**当前版** —— 页面据此说「与当前版相比」而不是「与更新的一版相比」 */
  nextIsCurrent: boolean
}

export async function loadVersionPair(
  rows: VersionListRow[],
  index: number,
  personKey: string,
  knownMember?: boolean
): Promise<VersionPair> {
  const row = rows?.[index]
  const nextIsCurrent = index === 0
  if (!row?.id) return { prev: null, next: null, nextIsCurrent }
  const newer = nextIsCurrent ? null : rows?.[index - 1]

  const [prev, next] = await Promise.all([
    loadVersionReport(row.id, knownMember),
    nextIsCurrent ? getCachedReport(personKey) : newer?.id ? loadVersionReport(newer.id, knownMember) : null
  ])

  return { prev, next, nextIsCurrent }
}

/**
 * 对比对象的名字：当前版 / 更新的一版。
 *
 * 不写「新版」是因为这一页里「新版」有两种：最近被换掉的那一版（就在上面一行）与**当前版**
 * —— 两者相差可能好几版。含糊的写法会让人以为在比相邻两行，方向一错整块对比都读反了。
 */
export function pairTargetLabel(nextIsCurrent: boolean): string {
  return nextIsCurrent ? '当前版' : '更新的一版'
}

/** 读到了这一版、但没有可比对象时的那一行说明（N-9；不弹窗，与页面其余提示同款） */
export function compareUnavailableNote(): string {
  return '更新的一版暂时读不到，所以这次只能看这一版的内容，给不出「改了什么」。'
}
