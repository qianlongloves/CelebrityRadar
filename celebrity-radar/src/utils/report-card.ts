import { Report } from './report'
import { isSensitiveQuery } from './sensitive'
import { truncateBriefText } from './weekly-brief'

/**
 * 报告分享卡（获客，2026-10-15）：把一份报告压成**一张可转发的长图**的内容模型。
 *
 * 为什么要有这张图：报告页右上角的原生转发只带得走一个链接（群里没人点），而
 * 「把结论截成一张图发给老板 / 同事」才是这类调研工具真实的使用动作 —— 图流出去了，
 * 落款与小程序码才跟着出去。此前全项目只有名言卡与周报简报卡，报告本身出不了图。
 *
 * 四条口径（与 utils/weekly-brief.ts 的三条红线同源，逐条对齐）：
 *
 * 1. **事实带出处、判断带依据**：动态一律带「日期 · 来源」（无来源的条目不进图，来源缺失
 *    绝不回落成「一条」）；模型判断（analysisPoints）后面必须跟它自己的依据（媒体名），
 *    让图上每一句都能回原报告逐条核对。
 * 2. **只搬运不认定**：争议段用「争点 + 说法（+ 回应）」，**不写「已证实 / 实锤」**这类
 *    会被读成「平台已核实事实」的措辞；卡底固定写出「公开信息整理 · 非平台定性」。
 * 3. **涉政涉军不出图**：沿用项目既有的本地拦截 `utils/sensitive.ts#isSensitiveQuery`，
 *    人物本身命中名单时整张卡不出（返回 null）—— 不放宽任何一条既有拦截。
 * 4. **导出是会员权益**：与周报图同一分层（见 canExportReportCard）。站内看报告免费，
 *    出图 / 转发图是会员权益；免费用户看得到入口，点开给一行非弹窗升级引导。
 *
 * 本文件**只组装内容**（纯函数，同输入同输出、不抛错）；排版与绘制在 utils/share-card.ts。
 * 这样「图上该有什么」能在单测里逐条断言，而「画在哪」不必进测试。
 */

/** 图上最多几条判断 / 争议 / 动态（克制：长图的第一屏要有重点，摆满了反而没人读完） */
export const CARD_POINT_MAX = 3
export const CARD_DISPUTE_MAX = 3
export const CARD_DYNAMIC_MAX = 4

/**
 * 各处文本的**字符上限**（与周报简报同一套做法：先按字符收敛，canvas 侧再用
 * 「像素折行 + maxLines」兜底）。中文一字符≈一个汉字宽，故用字符数足够近似 ——
 * 画布高度是按这些上限算出来的固定栅格，越界就会压住下一段。
 */
const HEADLINE_MAX = 62
const POINT_MAX = 38
const BASIS_MAX = 8
const DISPUTE_MAX = 46
const DYNAMIC_MAX = 30
const SOURCE_MAX = 10

/** 报告分享卡的内容模型（**排版无关**：只描述图上有哪几行字） */
export interface ReportCardModel {
  personKey: string
  name: string
  domain: string
  /** 头部元信息：`2026-10-15 生成 · 热度 62` */
  meta: string
  /** 一句话结论（模型评价优先，缺则回落到简介首句） */
  headline: string
  /** 判断与依据：`判断（据 界面新闻）` */
  points: string[]
  /** 争议与回应：`争点：说法（回应：…）` */
  disputes: string[]
  /** 近期动态：`2026-10-05 · 标题 · 来源` */
  dynamics: string[]
  /** 计数行：`5 条动态 · 2 处公开争议 · 12 条素材` */
  stats: string
  /** 合规说明（固定在页脚之上，任何一张图上都要有） */
  note: string
}

/** 卡底固定说明：合规硬要求，与页脚的「AI 生成，仅供参考」两句话分工不同 */
export function reportCardNote(): string {
  return '公开信息整理 · 非平台定性 · 判断为模型观点，可回原报告逐条核对'
}

/* ===== 免费 / 会员门禁（与周报导出同一分层口径） ===== */

/**
 * 导出报告图是否放行（**纯函数**，便于单测）。
 *
 * 分层口径与 `utils/weekly-brief.ts#canExportWeeklyBrief` 逐字一致：**出图 / 转发图是会员权益**
 * （免费用户看得到入口，点开给非弹窗的升级引导），**站内查看报告保持免费**。二元口径，
 * 没有阈值数值，故不在 `config/benefits.ts` 新增常量；真正的身份来源仍是
 * `utils/member.ts#readMemberState`。
 *
 * ⚠ 与周报图一致：端上判定只是体验层，不是安全边界（图在本机画、不经云端闸门），
 *   本函数只决定「要不要给用户看升级引导」。
 */
export function canExportReportCard(isMember: boolean): boolean {
  return isMember
}

/** 免费用户点「导出报告图」时的升级引导行文案（非弹窗：页面上的一行字，点了跳会员页） */
export function reportExportNote(): string {
  return '导出报告图是会员权益，开通会员即可导出 ›'
}

/* ===== 组装 ===== */

/**
 * 取首句（≤ max 字）：报告 `intro` 是 2~3 句，图上只留第一句 ——
 * 塞满整段会把下面的判断与动态挤出画面，而首句恰好是「这个人是谁」。
 */
function firstSentence(text: string, max: number): string {
  const t = (text ?? '').trim()
  if (!t) return ''
  const cut = (t.split(/[。！？!?；;\n]/)[0] ?? '').trim()
  return truncateBriefText(cut || t, max)
}

/** `2026-10-15T09:12:33.000Z` → `2026-10-15`（取不到就空串，绝不显示原始 ISO 串） */
function dayOf(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso ?? '').trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/**
 * 组装报告分享卡。**返回 null = 这张卡不该出图**（缺人物名 / 人物命中敏感名单 /
 * 报告里既没有结论也没有动态，出图就是一张空壳）。
 */
export function buildReportCard(report: Report | null | undefined): ReportCardModel | null {
  if (!report) return null
  const name = (report.name ?? '').trim()
  if (!name) return null

  /* 合规红线 3：人物本身命中本地敏感名单时整张卡不出 —— 与检索侧同一道闸门，不例外 */
  if (isSensitiveQuery(name)) return null

  const verdict = report.verdict?.summary ?? ''
  const headline = truncateBriefText(verdict.trim() || '', HEADLINE_MAX) || firstSentence(report.intro, HEADLINE_MAX)

  const points = (report.analysisPoints ?? [])
    .map((p) => {
      const point = truncateBriefText(p?.point ?? '', POINT_MAX)
      if (!point) return ''
      /* 依据是必带项：没有出处判断就只剩一句无从核对的评价，宁可不带这一条 */
      const basis = truncateBriefText(p?.basis ?? '', BASIS_MAX)
      return basis ? `${point}（据 ${basis}）` : point
    })
    .filter((s) => s !== '')
    .slice(0, CARD_POINT_MAX)

  const disputes = (report.controversies ?? [])
    .map((c) => {
      const topic = truncateBriefText(c?.topic ?? '', 14)
      const claim = truncateBriefText(c?.claim ?? '', DISPUTE_MAX)
      if (!claim) return ''
      const body = topic ? `${topic}：${claim}` : claim
      /* 有公开回应就一并带上：只摆「说法」不摆「回应」是把争议当结论用，图上最容易出事 */
      const response = truncateBriefText(c?.response ?? '', 30)
      return response ? `${truncateBriefText(body, DISPUTE_MAX)}（回应：${response}）` : body
    })
    .filter((s) => s !== '')
    .slice(0, CARD_DISPUTE_MAX)

  const dynamics = (report.dynamics ?? [])
    .map((d) => {
      const title = truncateBriefText(d?.title ?? '', DYNAMIC_MAX)
      const source = truncateBriefText(d?.source ?? '', SOURCE_MAX)
      /* 合规红线 1：无来源的条目不可追溯，不进图（来源缺失绝不回落成「一条」） */
      if (!title || !source) return ''
      const date = (d?.date ?? '').trim()
      return `${date ? `${date} · ` : ''}${title} · ${source}`
    })
    .filter((s) => s !== '')
    .slice(0, CARD_DYNAMIC_MAX)

  /* 既没有结论也没有动态 = 这份报告没什么可搬的（例如刚生成失败留下的空壳） */
  if (!headline && dynamics.length === 0) return null

  const bad = (report.controversies ?? []).length
  const srcCount = (report.sources ?? []).length
  const statParts = [`${(report.dynamics ?? []).length} 条动态`]
  if (bad > 0) statParts.push(`${bad} 处公开争议`)
  if (srcCount > 0) statParts.push(`${srcCount} 条素材`)

  const day = dayOf(report.generatedAt)
  const heat = typeof report.heat === 'number' && report.heat > 0 ? `热度 ${Math.round(report.heat)}` : ''

  return {
    personKey: report.personKey,
    name,
    /* 领域不在报告结构里（personKey 才是它的载体）：与报告页同一口径从 `名字#领域码` 里取，
       取不到回落 'other'（domainLabel('other') 有兜底文案），绝不显示空壳括号 */
    domain: report.personKey.split('#')[1] || 'other',
    meta: [day ? `${day} 生成` : '', heat].filter((s) => s !== '').join(' · '),
    headline,
    points,
    disputes,
    dynamics,
    stats: statParts.join(' · '),
    note: reportCardNote()
  }
}
