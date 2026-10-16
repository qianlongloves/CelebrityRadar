/**
 * S3-2：职业用户「监测工作台」的纯逻辑（多人面板 / 勾选批量对比 / 导出简报）。
 *
 * **为什么要有独立一页**（而不是把预警页做大）：预警页（package/alerts）回答的是
 * 「我订的这些东西，各自有什么新东西」—— 一行一个订阅对象、块与块并列，读完还得自己在脑子里横着比。
 * 而 PR / 媒体 / 投资 / 猎头每天要回答的是**另一个问题**：「我盯的这几个人里，今天谁在动、
 * 动的是什么、要不要把谁写进同一篇稿子」。那是**横向**问题，需要的是「一个人一行、指标一列」的台账，
 * 与预警页的纵向明细不是同一件事。
 *
 * 于是本模块只做三件预警页做不了的事，明细一概不复制、一律指回预警页 / 事件页：
 *   ① 横着排 —— 「谁在动」（{@link buildWorkbenchRows}，按最近动静排序）；
 *   ② 勾选成组去比 —— 「能不能一起写」（{@link buildCompareTable}）；
 *   ③ 把台账带走 —— 交付物（{@link buildWorkbenchBrief}）。
 *
 * **与缓存的关系**（S3-1 口径：「付费项必须与共享缓存无因果关系」）：
 *   · 面板与事件跟踪读的都是**已有的只读数据**（risk_signals / risk_scans / scan_logs /
 *     opinion_events），零上游检索、零模型调用、零生成额度；
 *   · 批量对比读的是 `report_cache` 里**已经生成好的报告**（utils/cache#getCachedReports），零成本；
 *     而且缓存越厚，能对比的人越多 —— 这与「卖生成次数」正好相反（次数会随缓存变厚而贬值）。
 *   没生成过的人照样出现在对比表里，标「未生成」并给出生成入口：**不替用户决定、也不假装没这个人**。
 *
 * **分层口径**（沿用 report-export / report-card / weekly-brief 的二元口径，不发明第二套）：
 *   · 站内看：面板 / 对比表 / 事件跟踪 —— 免费与会员**完全一致**（数据来自公开报道与已缓存报告）；
 *   · 带走（导出简报）：会员能力，门禁复用 `utils/report-export.ts#canExportReport`，免费用户
 *     看得到入口与一行非弹窗说明（{@link workbenchExportNote}）。
 *   刻意**不给「勾选对比」设分档数值**：{@link COMPARE_PICK_MAX} 是版面约束（一屏放得下几列），
 *   不是权益 —— 把它做成会员能力等于向用户收「横着看一眼」的钱，而这一步零成本。
 */

import { domainLabel, parsePersonKey } from '@/config/domains'
import { isNewSince } from './inbox'
import { SCAN_STATUS_LABEL } from './scan-log'
import { dayKey8, formatMoment8 } from './time'
import { metricText, metricValue, metricsOf, WORKBENCH_METRIC_KEYS } from './metrics'
import type { MetricDef } from './metrics'
import type { Report } from './report'
import type { RiskScanRow, RiskSignalRow, ScanLogRow } from '@/types/db'

/* ─────────────────────────── 展示上限（不是权益数值） ─────────────────────────── */

/** 对比列数上限：一屏放得下行名 + 4 列，再多就横着看不完了（**版面约束，不是会员数值**） */
export const COMPARE_PICK_MAX = 4

/** 事件跟踪只给前几条预览，其余去事件页（与舆情页事件卡同一取舍：本页不越加载越长） */
export const WORKBENCH_EVENT_MAX = 5

/** 简报里每人最多带几条信号：简报要「一眼读完」，不是信号流水（明细留给站内） */
export const BRIEF_SIGNAL_MAX = 5

/** 对比表 / 简报里「这个人还没生成过报告」的写法 —— 两处共用一份，免得一边说「未生成」一边说「无」 */
export const NOT_GENERATED = '未生成'

/* ─────────────────────────── ① 多人面板 ─────────────────────────── */

/** 我监控的一个人（来自 utils/risk-watch#listPersonWatches，name 取监控行里的 keyword） */
export interface WorkbenchPerson {
  personKey: string
  name: string
}

/** 面板的一行：一个人当前的全部「看得见的状态」，**只放数字与时间，明细不复制** */
export interface WorkbenchRow {
  personKey: string
  name: string
  /** 最近一次执行时刻（执行日志优先，扫描快照兜底）；空串 = 还没扫过 */
  lastRanAt: string
  /** 最近执行结果的一行字（成功 / 跳过 / 失败 / 已扫描 / 待首次扫描）—— 页面只打印，不再判空 */
  statusText: string
  /** 本轮新命中（**无日志时为 null**：与「扫了但没新东西」的 0 区分开） */
  newHits: number | null
  /** 累计信号数（快照的 signals_total 优先，兜底本次读到的条数） */
  signalTotal: number
  /** 最近一条信号的时间；空串 = 没有任何信号 */
  latestSignalAt: string
  /** 最近一条信号的标题；空串 = 没有信号 */
  latestTitle: string
  /** 相对本机「上次查看风险信号」水位的新信号数（口径同预警页，见 utils/inbox#isNewSince） */
  newSignals: number
}

/** 面板排序：**先按最近动静**（有信号的在前、按最新一条信号倒序），没信号的按最近执行，最后按名字 */
function compareRows(a: WorkbenchRow, b: WorkbenchRow): number {
  if (a.latestSignalAt !== b.latestSignalAt) {
    /* 有时间的一律排在空时间之前：空串是「没有信号」，不该排在中间 */
    if (!a.latestSignalAt) return 1
    if (!b.latestSignalAt) return -1
    return b.latestSignalAt.localeCompare(a.latestSignalAt)
  }
  if (a.lastRanAt !== b.lastRanAt) {
    if (!a.lastRanAt) return 1
    if (!b.lastRanAt) return -1
    return b.lastRanAt.localeCompare(a.lastRanAt)
  }
  return a.name.localeCompare(b.name)
}

/**
 * 组装面板：把监控名单与四份只读数据（信号 / 快照 / 执行日志 / 上次查看水位）拼成「一人一行」。
 *
 * 全部字段都是**照实搬运**：读不到就留空串 / null，绝不拿 0 冒充「没有新东西」
 * （`newHits: null` 与 `signalTotal: 0` 在界面上是两句不同的话：前者是「还没扫」，
 *  后者是「扫了，确实没有」—— 混起来会让人以为监控在正常工作，其实一轮都没跑过）。
 */
export function buildWorkbenchRows(input: {
  persons: WorkbenchPerson[]
  signals?: RiskSignalRow[] | null
  scans?: RiskScanRow[] | null
  logs?: ScanLogRow[] | null
  /** 本机上次查看风险信号的水位（ms）；缺失按「都是新的」处理，与预警页 riskNewCount 同口径 */
  seenMs?: number | null
}): WorkbenchRow[] {
  const persons = Array.isArray(input.persons) ? input.persons.filter((p) => !!p?.personKey) : []
  const logs = Array.isArray(input.logs) ? input.logs : []
  const scans = Array.isArray(input.scans) ? input.scans : []
  const signals = Array.isArray(input.signals) ? input.signals : []

  /* 每人的最新一条执行日志：日志表是全站共享的（没有 openid），但我们只按自己的名单取，
     所以「one key 多条」只可能是历史，取 ran_at 最大的一条最稳 */
  const latestLog = new Map<string, ScanLogRow>()
  for (const l of logs) {
    if (!l?.object_key) continue
    const prev = latestLog.get(l.object_key)
    if (!prev || String(l.ran_at ?? '') > String(prev.ran_at ?? '')) latestLog.set(l.object_key, l)
  }
  const scanByKey = new Map(scans.map((s) => [s.id, s]))

  const byPerson = new Map<string, RiskSignalRow[]>()
  for (const s of signals) {
    if (!s?.person_key) continue
    const list = byPerson.get(s.person_key)
    if (list) list.push(s)
    else byPerson.set(s.person_key, [s])
  }

  const rows: WorkbenchRow[] = persons.map((p) => {
    const log = latestLog.get(p.personKey)
    const scan = scanByKey.get(p.personKey)
    const list = byPerson.get(p.personKey) ?? []

    let latest: RiskSignalRow | null = null
    for (const s of list) {
      if (!latest || String(s.first_seen_at ?? '') > String(latest.first_seen_at ?? '')) latest = s
    }

    const latestSignalAt = String(latest?.first_seen_at ?? '')
    const lastRanAt = String(log?.ran_at ?? scan?.scanned_at ?? '')
    const total = Number.isFinite(scan?.signals_total) ? (scan?.signals_total as number) : list.length

    return {
      personKey: p.personKey,
      /* 名字以监控行为准（那是用户自己加的词），快照 / 信号上的 name 只作兜底 */
      name: p.name || scan?.name || latest?.name || p.personKey,
      lastRanAt,
      /*
        状态一行字。⚠ 判定里带上 `latestSignalAt`：**信号本身就是「扫过」的证据** ——
        只认执行日志/快照的话，一个明明有信号的人会因为日志被清理而显示「待首次扫描」，
        那是把一个扫过的人说成没扫过（比少一行数字严重得多）。
      */
      statusText: log
        ? SCAN_STATUS_LABEL[log.status] ?? '未知'
        : lastRanAt || latestSignalAt
          ? '已扫描'
          : '待首次扫描',
      newHits: log ? Number.isFinite(log.hit) ? log.hit : 0 : null,
      signalTotal: total,
      latestSignalAt,
      latestTitle: String(latest?.title ?? ''),
      newSignals: list.filter((s) => isNewSince(s.first_seen_at, input.seenMs ?? null)).length
    }
  })

  return rows.sort(compareRows)
}

/* ─────────────────────────── ② 勾选批量对比 ─────────────────────────── */

/** 勾选结果：`rejected` = 「因为已选满而没选上」（调用方据此提示，不再自己算一次上限） */
export interface PickResult {
  picked: string[]
  rejected: boolean
}

/**
 * 勾选 / 取消勾选，并守住 {@link COMPARE_PICK_MAX}。
 *
 * 满员时**保留原样并回一个 rejected**（而不是静默丢掉、也不是自动顶掉最早选的那个）：
 * 自动替换会让用户以为自己选错了人 —— 那种「我明明点了他」的困惑没有任何提示能补救。
 */
export function togglePick(picked: string[], personKey: string, max: number = COMPARE_PICK_MAX): PickResult {
  const list = Array.isArray(picked) ? picked : []
  if (list.includes(personKey)) return { picked: list.filter((k) => k !== personKey), rejected: false }
  if (list.length >= max) return { picked: list, rejected: true }
  return { picked: [...list, personKey], rejected: false }
}

/** 对比表的一列（一个人）—— 数字都是**报告里已有的、纯搬运的事实**，不含任何推断 */
export interface CompareRow {
  personKey: string
  name: string
  /** 报告是否已在共享缓存里 */
  cached: boolean
  /** 领域标签（**与缓存无关**：从 personKey 解析，所以未生成的人也标得出） */
  domain: string
  heat: number
  dynamics: number
  controversies: number
  relations: number
  profileItems: number
  /** 报告生成时刻（ISO）；空串 = 未生成 */
  generatedAt: string
}

/** 对比表的一格 */
export interface CompareCell {
  /** 给人看的字（「12 条」「未生成」…）—— 页面直接打印，不拼文案 */
  text: string
  /** 判定「整行都是空」用的数值；null = 这一行对该指标不适用（如「领域」） */
  num: number | null
}

/**
 * 对比表的一行指标。
 * `blank`：整行所有人都是 0 ⇒ 这一行不值得占版面（例：四个人的报告都没有「争议与回应」）。
 * 刻意**不删行**、只标 blank 由页面决定藏不藏 —— 判定与呈现分开，用例才好钉住「谁被算成空行」。
 *
 * ⚠ 名字里带 `Table` 是刻意的：对比页 (`utils/compare.ts`) 也有一个 `CompareMetric`，
 * 那是「两个人并排两格」的行，这里是「N 个人并排 N 格」的行。同名不同形状的两个类型
 * 迟早会被 import 错一个，而错的那个在类型层面往往还能过。
 */
export interface CompareTableMetric {
  key: string
  label: string
  cells: CompareCell[]
  blank: boolean
}

export interface CompareTable {
  rows: CompareRow[]
  metrics: CompareTableMetric[]
}

/** 对比表的一列输入：报告为 null = 这个人还没生成过（**仍然出现**，标未生成） */
export interface CompareInput {
  personKey: string
  /** 显示名（监控行里的名字）；缺省时回落报告里的 name / personKey */
  name?: string
  report: Report | null
}

/**
 * 组装对比表：**列 = 人，行 = 指标**。
 *
 * 为什么列是人而不是行是人：这一页要回答的是「谁和谁能放在一起写」，所以要**一眼扫同一指标的
 * 几个人**（谁的动态最多、谁正被争议包围），而不是逐个读一个人的全部指标。
 *
 * 指标全部取自报告里已有的字段（热度 / 动态 / 争议与回应 / 关系图谱 / 人物档案 / 生成时间），
 * **不做任何跨人的加减乘除**：一旦算出「综合分」就等于平台替用户排序了人，那是判断，
 * 而这一页的定位是台账（事实搬运）。比较是用户自己的事。
 */
export function buildCompareTable(items: CompareInput[]): CompareTable {
  /*
    ⚠ 先 filter 再 map：行与入参 `items` 的下标从此**不再一一对应**，所以报告要在这条链上一起取出来，
    不要在下面用 `items[i]` 回查 —— 中间少掉一个人（personKey 为空的脏输入）就会整体错位一格，
    而错位的表格看起来完全正常（数字都在，只是挂到了别人名下）。

    顺带：两页的指标行定义都在 utils/metrics.ts（唯一真源），这里只负责把定义套到每一列上，
    不写死任何标签或取值 —— 各写一份就是两套口径（见那个模块顶部的说明）。
  */
  const valid = (Array.isArray(items) ? items : []).filter((it) => !!it?.personKey)
  const reports: Array<Report | null> = valid.map((it) => it.report ?? null)
  const rows: CompareRow[] = valid.map((it) => {
    const r = it.report
    const parsed = parsePersonKey(it.personKey)
    return {
      personKey: it.personKey,
      name: it.name || r?.name || parsed?.name || it.personKey,
      cached: !!r,
      domain: parsed?.domain ? domainLabel(parsed.domain) : '',
      heat: typeof r?.heat === 'number' && Number.isFinite(r.heat) ? r.heat : 0,
      dynamics: r?.dynamics?.length ?? 0,
      controversies: r?.controversies?.length ?? 0,
      relations: r?.relations?.length ?? 0,
      profileItems: r?.profile?.length ?? 0,
      generatedAt: String(r?.generatedAt ?? '')
    }
  })

  /**
   * 未生成的人：这一格的字是「未生成」，数值记 0（于是不会因为一个人没报告就让整行被当成非空）。
   * 必须用 `report` 是否存在判，而不是行的 `cached` 之外另算一遍 —— 两份判据迟早会不一致。
   */
  const metricOf = (def: MetricDef): CompareTableMetric => {
    const cells = rows.map((r, i) => {
      const report = reports[i] ?? null
      if (!report && !def.ofUncached) return { text: NOT_GENERATED, num: 0 }
      return { text: metricText(def, report, r.personKey, NOT_GENERATED), num: metricValue(def, report) }
    })
    return { key: def.key, label: def.label, cells, blank: !def.always && cells.every((c) => !c.num) }
  }

  const metrics: CompareTableMetric[] = metricsOf(WORKBENCH_METRIC_KEYS).map(metricOf)

  return { rows, metrics }
}

/* ─────────────────────────── ③ 导出监测简报 ─────────────────────────── */

/**
 * 免费用户点「导出简报」时的那一行（**非弹窗**，与 report-export#reportDataExportNote 同一形态）。
 * 函数名与 report-export / report-card 的两句都不同：三句话都叫「导出」，带走的东西不一样，
 * 混用会让用户以为点哪个都一样。
 */
export function workbenchExportNote(): string {
  return '导出简报是会员能力：把这份监控台账（名单 + 每条信号原文链接）存成 Markdown 带走'
}

export interface WorkbenchBrief {
  /** 文件名主体（不含扩展名）：页面拼 `.md` */
  fileNameBase: string
  markdown: string
  personCount: number
  signalCount: number
}

/**
 * 组装可带走的监测简报（Markdown）。
 *
 * 三条纪律（与 report-export 逐条对齐）：
 *   ① **不编造、不推断**：只搬运面板数字与信号标题 / 来源 / 时间；
 *   ② **没出处的条目不进文件**：`url` 为空的信号一律丢弃 —— 文件一旦离开 App 就不受站内
 *      「点开看原文」的兜底保护，带出去的东西必须每条都能核对（与报告长图同一条红线）；
 *   ③ 头部写明「基于公开信息 AI 整理，仅供参考」，与站内免责文案同源。
 *
 * 事件**刻意不写进简报**：端上事件模型（utils/opinion-events#OpinionEvent）只有来源**名**、
 * 没有来源**链接**，写进去就成了一条指不出出处的条目（违反 ②）。宁可少给一段，
 * 也不给一份「看起来有出处、其实点不开」的交付物；事件明细留在站内事件页看。
 */
export function buildWorkbenchBrief(input: {
  rows: WorkbenchRow[]
  /** 每人已经整理好的信号（未排序也可，这里只取前 BRIEF_SIGNAL_MAX 条带 url 的） */
  signalsByPerson?: Record<string, RiskSignalRow[] | undefined>
  /** 我订阅的关键词（可空）：名单里一并写出来，让这份文件自己说得清「我在盯什么」 */
  keywords?: string[]
  at?: Date
}): WorkbenchBrief | null {
  const rows = (Array.isArray(input.rows) ? input.rows : []).filter((r) => !!r?.personKey)
  if (rows.length === 0) return null

  const at = input.at ?? new Date()
  const byPerson = input.signalsByPerson ?? {}
  const keywords = (input.keywords ?? []).map((k) => String(k ?? '').trim()).filter(Boolean)

  const lines: string[] = []
  lines.push('# 名人雷达 · 监测简报')
  lines.push('')
  lines.push(`生成时间：${dayKey8(at)} ${formatMoment8(at)}（UTC+8）`)
  lines.push(
    `监控对象：${rows.length} 人${keywords.length ? ` · 监控关键词：${keywords.join('、')}` : ''}`
  )
  lines.push('')
  lines.push('> 基于公开信息 AI 整理，仅供参考。每条信号附原文链接，可逐条核对。')
  lines.push('')

  lines.push('## 监控名单')
  lines.push('')
  lines.push('| 对象 | 最近执行 | 结果 | 累计信号 | 最近一条信号 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const r of rows) {
    const cells = [
      r.name,
      r.lastRanAt ? formatMoment8(r.lastRanAt) : '待首次扫描',
      r.statusText,
      `${r.signalTotal} 条`,
      r.latestTitle || (r.latestSignalAt ? formatMoment8(r.latestSignalAt) : '暂无')
    ]
    lines.push(`| ${cells.map(mdCell).join(' | ')} |`)
  }
  lines.push('')

  let signalCount = 0
  const body: string[] = []
  for (const r of rows) {
    const list = (byPerson[r.personKey] ?? [])
      .filter((s) => !!String(s?.url ?? '').trim())
      .slice()
      .sort((a, b) => String(b.first_seen_at ?? '').localeCompare(String(a.first_seen_at ?? '')))
      .slice(0, BRIEF_SIGNAL_MAX)
    if (list.length === 0) continue
    body.push(`### ${r.name}`)
    body.push('')
    for (const s of list) {
      signalCount++
      const date = s.published_date ? formatMoment8(s.published_date) : formatMoment8(s.first_seen_at)
      /* 类别标签只是词的归类、不是定性（见 utils/risk-watch 取舍 2），照原样带上，不写等级 */
      const tag = String(s.category_label ?? '').trim()
      body.push(
        `- ${[date, tag ? `【${tag}】` : '', String(s.title ?? '').trim()].filter(Boolean).join(' ')}` +
          `\n  - 来源：${String(s.source ?? '').trim() || '来源未标注'} · ${String(s.url).trim()}`
      )
    }
    body.push('')
  }

  if (body.length > 0) {
    lines.push('## 风险信号')
    lines.push('')
    lines.push('信号 = 公开报道里出现了司法 / 税务 / 合作 / 维权 / 表态这类词，不代表平台对 TA 的评价。')
    lines.push('')
    lines.push(...body)
  } else {
    lines.push('## 风险信号')
    lines.push('')
    lines.push('本轮没有可带出处的信号（信号需有原文链接才会写进本文件）。')
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('本简报由「名人雷达」监测工作台生成；内容来自公开报道的检索结果，仅供参考。')

  return {
    fileNameBase: `名人雷达-监测简报-${dayKey8(at).replace(/-/g, '')}`,
    markdown: lines.join('\n'),
    personCount: rows.length,
    signalCount
  }
}

/** Markdown 表格单元格：竖线与换行会切坏表格结构，一律替换成安全字符 */
function mdCell(v: string): string {
  return String(v ?? '')
    .replace(/\|/g, '/')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}
