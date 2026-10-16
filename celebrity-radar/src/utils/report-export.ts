/**
 * S3-1：**结构化导出**（Markdown / JSON）—— 「能力 / 交付物」型付费点。
 *
 * 为什么单独立一个付费能力，而不是继续加额度（本文件存在的全部理由）：
 *
 *   1. **额度会随共享缓存变厚而自动贬值**。`report_cache` 是全局共享的（同一份报告全站只生成一次），
 *      所以「卖生成次数」等于卖一件**越用越不值钱**的东西：查得越多、缓存命中率越高，额度越花不完。
 *      这是结构性的（见 doc/产品优化路线图.md §1「变现结构」），调额度数字解决不了。
 *      而**导出**与缓存的厚薄**无因果关系**：报告已经在库里了，导出是纯本地组装 ——
 *      零上游成本、零等待、零额度；而且缓存越厚，用户能导出的报告越多，导出**越有价值**。
 *      这是 S3-1 口径（「付费项必须与缓存无因果关系」）里最纯粹的实例。
 *
 *   2. **长图不是职业用户的交付物**。`utils/report-card.ts` 的导出是**一张图**，
 *      因此处处有长度预算（`CARD_POINT_MAX = 3` / `CARD_DISPUTE_MAX = 3` / `CARD_DYNAMIC_MAX = 4`，
 *      每条还要截断到几十字）。PR / 媒体 / 投资 / 猎头要的是**能进文档与表格、能逐条核对**的东西：
 *      本模块的 Markdown 没有长度预算，且**每条事实都带出处**、末尾附**完整来源清单**（长图带不了链接）。
 *      两者不是替代关系：长图用来发给人看，结构化导出用来自己用。
 *
 *   3. **分层口径不许另起一套**。本项目已有两条「导出 = 会员权益」的先例：
 *      `utils/report-card.ts#canExportReportCard`（报告长图）与
 *      `utils/weekly-brief.ts#canExportWeeklyBrief`（周报图），口径都是**二元**：
 *      「站内看免费；出图 / 带走是会员权益；免费用户看得到入口，点开给一行非弹窗引导」。
 *      本模块逐字沿用 —— 不发明第二套哲学，也不在 `config/benefits.ts` 里新增数值
 *      （二元口径不是数值，那两个先例也明确写了「无需在 benefits.ts 新增常量」）。
 *
 * ⚠ **不变式（最重要的一条）**：`buildReportExport` 内部对非会员再调一次 `stripMemberSections`。
 *   理由与 `utils/member.ts` 那句注释完全一致：「任何新增的消费方（AI 问答把报告当上下文、
 *   以后的分享 / 导出）只要忘了判会员态，就等于把付费内容送出去」。所以这里**不信任调用方**：
 *   即使有人误传 `member: true`，产物里的会员段也已经被摘掉（`stripMemberSections` 有快路径，
 *   无会员内容时返回原引用，等于零成本）。门禁是 `canExportReport`，不变式是这次 strip，两者都要。
 *
 * 合规边界（与 report-card 同源，逐条对齐）：①事实只搬运、每条带出处；②判断类照抄原措辞，
 * 在段前显式标注「模型判断」（不悄悄与事实混排）；③`low` 与热门榜无关；④人物命中敏感名单时
 * 返回 `null`（调用方按「不出导出」处理），导出一旦离开 App 就不再受内容检查约束，只能在这里拦。
 */

import type { Report } from './report'
import { buildReportToc } from './report-toc'
import { RISK_CATEGORY_LABEL, riskHeadline, riskScope, buildRiskSignals } from './risk'
import { buildCommercialSummary } from './commercial'
import { reportCardNote } from './report-card'
import { stripMemberSections } from './member'
import { isSensitiveQuery } from './sensitive'
import { domainLabel } from '@/config/domains'

/* ===== 门禁与文案（与 report-card / weekly-brief 逐字同口径的二元分层） ===== */

/** 导出是不是会员权益？二元口径，无数值 —— 与 canExportReportCard / canExportWeeklyBrief 一致 */
export function canExportReport(member: boolean): boolean {
  return !!member
}

/**
 * 免费用户点「导出数据」时的那一行（非弹窗）。
 * ⚠ 函数名刻意与 `report-card.ts#reportExportNote`（长图那句）**区分开**：两句话都叫「导出」，
 * 但带走的东西不同（一张图 vs 一份可核对的数据），混用会让用户以为点哪个都一样。
 */
export function reportDataExportNote(): string {
  return '导出数据是会员能力：Markdown 全文（每条带出处）+ JSON 结构化数据，可进文档与表格逐条核对'
}

/** 导出条目在页面上怎么列（页面只渲染，不拼文案 —— 同 report-card 的约定） */
export interface ExportFormat {
  kind: ExportKind
  label: string
  /** 一行说明：这个格式拿来干什么 */
  desc: string
}

export type ExportKind = 'markdown' | 'json'

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    kind: 'markdown',
    label: 'Markdown 全文',
    desc: '可粘进文档 / 笔记，每条事实带出处，末尾附完整来源清单'
  },
  {
    kind: 'json',
    label: 'JSON 结构化数据',
    desc: '字段原样结构化，便于进表格或二次处理'
  }
]

/* ===== 产物 ===== */

export interface ReportExport {
  /**
   * 文件名主体（不含扩展名）：页面按用户选的格式拼 `.md` / `.json`。
   * 不在这里定死扩展名 —— 两种格式共用同一份产物，扩展名属于「这次导出选了哪个」。
   */
  fileNameBase: string
  markdown: string
  json: string
  /** 实际写进 Markdown 的节数（用于页面提示与用例断言） */
  sectionCount: number
  /** 来源清单条数 —— 这是结构化导出相对长图的核心增值，单独暴露便于页面说明 */
  sourceCount: number
}

/** 某格式的文件名（页面写文件用） */
export function exportFileName(exp: ReportExport, kind: ExportKind): string {
  return `${exp.fileNameBase}.${kind === 'json' ? 'json' : 'md'}`
}

export interface ExportOptions {
  /** 是否会员：决定节范围（会员档的节只对会员导出） */
  member: boolean
  /** 导出时刻，默认取当前时间；用例传固定值以保证产物可比 */
  at?: Date
}

/* ===== 小工具 ===== */

/** 「据 出处」—— 出处为空时不写这句，而不是写「据 」 */
function basis(b?: string): string {
  const b2 = (b || '').trim()
  return b2 ? `（据 ${b2}）` : ''
}

/** 一行条目：内容 + 出处 + 可选日期，空内容返回空串（调用方过滤掉） */
function line(text?: string, b?: string, date?: string): string {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  const d = (date || '').trim()
  return `- ${d ? `${d} · ` : ''}${t}${basis(b)}`
}

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function dayOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 章节正文：返回按行拆好的内容块（空数组 = 这一节不出） */
type SectionBody = (r: Report) => string[]

/**
 * 每个模板节怎么写进 Markdown。
 *
 * ⚠ 键必须与 `utils/report-toc.ts` 的 `REPORT_TEMPLATE` id 一一对应（用例钉住「没有孤儿键、
 * 也没有漏掉的节」）：节名与顺序由模板真源决定，本表只负责把字段搬成文字，
 * 于是「导出里有什么节」永远等于「页面上有什么节」，两处不会各说各话。
 */
const SECTION_BODY: Record<string, SectionBody> = {
  /* 人物速览：素材覆盖范围（不是热度，热度在头部） */
  'sec-overview': (r) => {
    const c = r.coverage
    if (!c) return []
    const out = [`- 共收录 ${c.items} 条素材${c.recent ? `，近 7 天 ${c.recent} 条` : ''}`]
    if (c.firstAt || c.latestAt) out.push(`- 时间跨度：${c.firstAt || '—'} ~ ${c.latestAt || '—'}`)
    if (c.latest && c.latest.title) {
      out.push(`- 最新一条：${c.latest.title}${c.latest.source ? `（${c.latest.source}）` : ''}`)
    }
    return out
  },

  /* 简介 */
  'sec-intro': (r) => {
    const t = (r.intro || '').trim()
    return t ? [t] : []
  },

  /* AI 解读：判断段，显式标注「模型判断」 */
  'sec-verdict': (r) => {
    const v = r.verdict
    const rep = r.reputation
    const con = r.consistency
    const out: string[] = []
    if (v?.summary) out.push(`**结论**：${v.summary}`)
    if (v?.positioning) out.push(`**行业定位**：${v.positioning}`)
    if (rep?.positive) out.push(`**正向口碑**：${rep.positive}`)
    if (rep?.negative) out.push(`**负向口碑**：${rep.negative}`)
    if (con?.claim) out.push(`**说过的话**：${con.claim}`)
    if (con?.act) out.push(`**实际做法**：${con.act}`)
    if (con?.gap) out.push(`**差异**：${con.gap}`)
    return out.length ? [JUDGE_NOTE, ...out] : []
  },

  /* 人物档案：事实 + 出处 */
  'sec-profile': (r) =>
    (r.profile ?? []).map((p) => line(`${p.label}：${p.value}`, p.basis)).filter(Boolean),

  /* 人物关系 */
  'sec-relations': (r) =>
    (r.relations ?? [])
      .map((x) => line(`${x.name}（${RELATION_LABEL[x.relation] || x.relation}）：${x.note}`, x.basis))
      .filter(Boolean),

  /* 商业速览：复用既有派生（口径与页面上那张卡同一个函数，不另写一套统计） */
  'sec-commercial': (r) => {
    const c = buildCommercialSummary(r)
    const out: string[] = []
    if (c.headline) out.push(`**读数**：${c.headline}`)
    for (const a of c.axes) out.push(`- ${a.label}：${a.value}（${a.note}）`)
    for (const g of c.gaps) out.push(`- ${g.label}：未成立 —— ${g.reason}`)
    return out
  },

  /* 商业合作 */
  'sec-endorsement': (r) =>
    (r.endorsements ?? [])
      .map((e) => line(`${e.brand}${e.kind ? `（${e.kind}）` : ''}：${e.note}`, e.basis))
      .filter(Boolean),

  /* 近期动态 */
  'sec-dynamics': (r) =>
    (r.dynamics ?? [])
      .map((d) => {
        const title = (d.title || '').replace(/\s+/g, ' ').trim()
        if (!title) return ''
        const src = (d.source || '').trim()
        /*
         * ⚠ 与长图「动态无来源不进图」是**同一条合规取向**，但处理方式刻意不同：
         * 长图是**发出去**的（没有出处就不该带走），导出是**给自己核对**的完整材料 ——
         * 直接删掉一条会让人以为「那天没这事」，所以这里**保留并显式标注「未标出处」**。
         * 静默把一条无出处的内容当成有据事实带走，才是真正的问题。
         */
        const head = `- ${d.date ? `${d.date} · ` : ''}${title}（${src ? `据 ${src}` : '未标出处'}）`
        const s = (d.summary || '').replace(/\s+/g, ' ').trim()
        return s && s !== title ? `${head}\n  ${s}` : head
      })
      .filter(Boolean),

  /* 经典名言：语录本身是原话，用引用块；背景说明另起一行（不塞进署名行） */
  'sec-quotes': (r) =>
    (r.quotes ?? [])
      .map((q) => {
        const t = (q.text || '').trim()
        if (!t) return ''
        const meta = [q.context, q.note, q.source].map((x) => (x || '').trim()).filter(Boolean)
        const out = [`> ${t}`]
        if (meta.length) out.push('>', `> —— ${meta.join(' · ')}`)
        const bg = (q.background || '').trim()
        if (bg) out.push('', bg)
        return out.join('\n')
      })
      .filter(Boolean),

  /* AI 点评：优先结构化要点，回落到整段 */
  'sec-analysis': (r) => {
    const pts = r.analysisPoints ?? []
    if (pts.length) {
      return [JUDGE_NOTE, ...pts.map((p) => line(p.point, p.basis)).filter(Boolean)]
    }
    const a = (r.analysis || '').trim()
    return a ? [JUDGE_NOTE, a] : []
  },

  /* 争议与回应：争议点 + 当事方回应（没有回应就如实写「未见公开回应」） */
  'sec-controversies': (r) =>
    (r.controversies ?? [])
      .map((c) => {
        const head = (c.topic || '').trim() || (c.claim || '').trim()
        if (!head) return ''
        const rows = [`- **${head}**`]
        if (c.claim && c.claim.trim() !== head) rows.push(`  - 争议：${c.claim.trim()}`)
        rows.push(`  - 回应：${(c.response || '').trim() || '未见公开回应'}`)
        const b = (c.basis || '').trim()
        if (b) rows.push(`  - 依据：${b}`)
        return rows.join('\n')
      })
      .filter(Boolean),

  /* 风险雷达：复用既有扫描（结论句 + 口径行 + 逐条信号），不在这里重新判词 */
  'sec-risk': (r) => {
    const scan = buildRiskSignals(r)
    if (scan.scanned === 0) return []
    const out = [`**${riskHeadline(scan)}**`, riskScope(scan)]
    for (const s of scan.signals) {
      out.push(line(`[${RISK_CATEGORY_LABEL[s.category]}] ${s.text}`, s.source || s.url, s.date))
    }
    if (scan.total > scan.signals.length) {
      out.push(`- 另有 ${scan.total - scan.signals.length} 条同类表述未逐条列出（口径同页内风险雷达）`)
    }
    return out
  },

  /* 会员专享：模型判断段 */
  'sec-member': (r) => {
    const notes = r.memberNotes
    const out: string[] = []
    if (notes?.compare) out.push(`**横向对比**：${notes.compare}`)
    if (notes?.risk) out.push(`**前瞻风险**：${notes.risk}`)
    for (const c of r.conflicts ?? []) {
      const t = (c.topic || '').trim()
      if (!t) continue
      out.push(`- ${t}：A 面 ${(c.a || '').trim() || '—'} ／ B 面 ${(c.b || '').trim() || '—'}`)
    }
    return out.length ? [JUDGE_NOTE, ...out] : []
  },

  /* 同领域坐标 */
  'sec-peers': (r) =>
    (r.peers ?? []).map((p) => line(`${p.name}：${p.gap}`)).filter(Boolean),

  /* 企业关联 */
  'sec-affiliation': (r) =>
    (r.affiliations ?? [])
      .map((a) => line(`${a.name}${a.kind ? `（${a.kind}）` : ''}：${a.note}`, a.basis))
      .filter(Boolean),

  /* 立场与舆情 */
  'sec-stance': (r) =>
    (r.stance ?? [])
      .map((s) => line(`${s.topic}（${STANCE_LABEL[s.attitude] || s.attitude}）：${s.note}`))
      .filter(Boolean),

  /* 时间线 */
  'sec-timeline': (r) =>
    (r.timeline ?? []).map((t) => line(t.event, undefined, t.date)).filter(Boolean),

  /* 名词解释 */
  'sec-glossary': (r) =>
    (r.glossary ?? []).map((g) => line(`${g.term}：${g.explain}`)).filter(Boolean)
}

/** 判断段（模型观点）在导出里的统一标注 —— 不让判断与事实混排而不自知 */
const JUDGE_NOTE = '> 以下为模型判断与归纳（非事实认定），可回原报告核对。'

/**
 * 关系 / 立场的中文标签。
 *
 * ⚠ 与 `package/report/index.tsx` 的 `RELATION_META` / `STANCE_META` 是**两份手抄副本**，
 * 逐字一致（本项目对「同源副本」的既有做法：repairJson 的两份 + 用例钉同步）。
 * 不直接从页面 import：页面是 JSX 模块，数据层依赖它会把渲染层拖进纯函数。
 * 一致性由 `test/cases/61-report-export.js` 读两个文件比对钉住 ——
 * 这不是形式主义：第一版这里写的是「竞争 / 批评 / 中立」，而页面上是「对手 / 质疑 / 中性」，
 * 同一份数据在两处叫法不同，用户会以为是两回事。
 */
export const RELATION_LABEL: Record<string, string> = {
  cooperate: '合作',
  mentor: '师承',
  rival: '对手',
  other: '其他'
}

export const STANCE_LABEL: Record<string, string> = {
  positive: '认可',
  neutral: '中性',
  negative: '质疑',
  mixed: '两极'
}

/**
 * 模板里 `tier: 'member'`、但**数据在免费批次里也生成**的那三节的字段。
 *
 * ⚠ 与 `stripMemberSections` 摘掉的那四个字段（memberNotes / conflicts / peers / affiliations）
 *   是**两回事**：那四个只在会员提示词里生成，所以连站内对象都要摘掉；这三节的字段必须留在站内
 *   对象里，因为对比页 / 话题速览 / AI 问答正读着同一个 Report（见 report-toc.ts 的分档说明：
 *   「移入会员档只是**呈现**上不再给免费用户出卡」）。
 *
 * 那为什么导出还要单独摘一次？因为**导出是「带走」**，口径与站内不同：
 *   · Markdown 侧天然安全 —— 节由 `buildReportToc` 按档算出来，非会员那三节根本不在循环里；
 *   · JSON 侧是**原样序列化整个 Report 对象**，不摘就等于把会员档节的内容一起打包送出去。
 * 故这里只作用于**导出的 JSON 副本**，不动 utils/member.ts 的站内口径，也不动调用方手里的对象。
 */
const MEMBER_TIER_FIELDS = ['endorsements', 'stance', 'glossary'] as const

/** 非会员导出：把会员档节的字段从**副本**上摘掉；一个都没有时返回原引用（零成本快路径） */
function stripMemberTierFields(report: Report): Report {
  if (
    report.endorsements === undefined &&
    report.stance === undefined &&
    report.glossary === undefined
  ) {
    return report
  }
  const copy = { ...report }
  delete copy.endorsements
  delete copy.stance
  delete copy.glossary
  return copy
}

const APP_NAME = '名人雷达'

/* ===== 主入口 ===== */

/**
 * 组装导出产物。返回 `null` = 这份报告不出导出（命中敏感名单 / 没有报告）。
 *
 * 顺序（与 report 页的 onExportCard 同一套取舍）：过滤 → 摘会员段（不变式）→ 组装。
 */
export function buildReportExport(report: Report | null | undefined, opts: ExportOptions): ReportExport | null {
  if (!report || !report.name) return null
  /* 导出一旦离开 App 就不再受内容检查约束，只能在这里拦（与长图导出同一条边界） */
  if (isSensitiveQuery(report.name)) return null

  const member = canExportReport(opts.member) && !!opts.member
  /*
   * 不变式：非会员**一定**不含会员段。即使调用方误传 member=true 也只影响节范围，
   * 传 false 时这里兜住数据层 —— 与 utils/cache.ts#exposeReport 的取舍同一处。
   */
  const safe: Report = member ? report : stripMemberSections(report)
  /* 第二层摘除：模板里「member 档但数据免费也生成」的节（见 MEMBER_TIER_FIELDS 的说明） */
  const exported: Report = member ? safe : stripMemberTierFields(safe)

  const at = opts.at ?? new Date()
  /* 领域码 = personKey 的 `#` 后半段；没有就不写括号（`domainLabel('')` 会回落「其他」，那会骗人） */
  const domainCode = String(safe.personKey || '').split('#')[1] || ''
  const domain = domainCode ? domainLabel(domainCode) : ''

  /* 可见节 = 模板真源算出来的（档位 + 报告内容双过滤），导出不自己判可见性 */
  const sections = buildReportToc(safe, {
    member,
    /* 与 utils/report-toc.ts#TocOptions 注释里的充要条件同源：不是降级简版，或有覆盖数据 */
    hasOverview: !(safe as { degraded?: boolean }).degraded || !!safe.coverage
  })

  const head: string[] = [`# ${safe.name} · ${APP_NAME}${domain ? `（${domain}）` : ''}`, '']
  const metas: string[] = []
  if (typeof safe.heat === 'number' && safe.heat > 0) metas.push(`热度 ${safe.heat}/100`)
  if (safe.coverage) metas.push(`素材 ${safe.coverage.items} 条`)
  if (safe.generatedAt) metas.push(`报告生成 ${safe.generatedAt}`)
  metas.push(`导出 ${fmtDate(at)}`)
  if (metas.length) head.push(metas.join(' · '), '')

  const blocks: string[] = []
  for (const s of sections) {
    const body = SECTION_BODY[s.id]?.(safe) ?? []
    if (!body.length) continue
    blocks.push(`## ${s.label}`, '', ...body, '')
  }

  const sources = safe.sources ?? []
  if (sources.length) {
    blocks.push(`## 附：来源清单（${sources.length} 条）`, '')
    sources.forEach((s, i) => {
      const url = (s.url || '').trim()
      blocks.push(`${i + 1}. ${(s.title || '').trim() || url}${url ? ` — ${url}` : ''}`)
    })
    blocks.push('')
  }

  blocks.push('---', '', reportCardNote(), `由「${APP_NAME}」导出 · 站内报告为唯一权威版本`, '')
  if (safe.disclaimer) blocks.push(`> ${safe.disclaimer.trim()}`, '')

  const markdown = [...head, ...blocks].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'

  /*
   * JSON：字段原样结构化（除按档摘掉会员档节的字段外不做裁剪），外加导出元信息。
   * 带来源清单是刻意的 —— 「可核对」正是这个导出物相对长图的卖点。
   * ⚠ 序列化的是 `exported`（非会员已摘过一层），不是 `safe`：JSON 是整份对象的原样打包，
   *   不摘就等于把会员档节的内容一起送出去（用例连 JSON 一起断言）。
   */
  const json = JSON.stringify(
    {
      app: APP_NAME,
      exportedAt: fmtDate(at),
      domain,
      member,
      sectionCount: sections.length,
      report: exported
    },
    null,
    2
  )

  return {
    fileNameBase: `${APP_NAME}_${safe.name}_${dayOf(at)}`,
    markdown,
    json,
    sectionCount: sections.length,
    sourceCount: sources.length
  }
}
