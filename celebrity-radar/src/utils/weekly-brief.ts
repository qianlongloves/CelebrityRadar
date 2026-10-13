import type { WeeklyReport } from './weekly'
import { buildWeeklyDigest } from './weekly'
import { isSensitiveQuery } from './sensitive'

/**
 * 周报简报的**内容组装层**（P4-B，2026-10-13）——把一份 `WeeklyReport` 收敛成
 * 「一张可保存 / 可转发的分享图」与「一段可复制的文本摘要」共用的纯数据。
 *
 * 为什么单独成文件、且必须是纯函数：
 *   分享图与复制摘要**必须说同一件事**。若各自去 `report` 里挑内容，改一处忘另一处不会报错，
 *   只会让「图上有、复制没有」这类漂移悄悄发生。这里只做「从周报数据 → 要点数组」的确定性搬运，
 *   不碰网络 / storage / canvas，于是能用单测逐条钉住（截断、来源、去重、合规过滤）。
 *   **canvas 绘制（utils/share-card.ts）只负责把这些字段画出来，不再做任何内容取舍。**
 *
 * 三条硬约束（合规红线，改本文件前先读）：
 *   1. **涉政涉军一律不出现**：分享图上出现的内容不得涉政涉军，沿用项目既有的本地拦截
 *      （`utils/sensitive.ts#isSensitiveQuery`）逐条过滤，**不放宽任何一条既有拦截**。
 *   2. **每条必带来源与时间**：无来源的条目不可追溯，一律不进要点（与
 *      `utils/opinion-rank.ts#pickDailyFocus` 同口径），来源缺失时**显式写「来源未标注」，绝不编来源**。
 *   3. **只搬运不认定**：要点文本直接取自素材的动态标题（公开报道），**不使用「已证实 / 已确认」
 *      这类会被读成「平台已核实事实」的措辞**；可信度最高一级仍只到「官方通报」（本层不出现分级标签）。
 *      底部说明固定写明「公开报道 · 非平台定性 · 聚合≠认定」。
 *
 * 数据来源：要点取自 `buildWeeklyDigest(report).timeline`（**端上真值、非模型输出**），
 * 因为时间线天然带「人 / 标题 / 来源 / 时间」，正好满足约束 2；模型产出的 `highlights`
 * 是「人：事实」短句、不带来源与时间，故**不用它做分享图要点**（那会破约束 2）。
 */

/** 分享图 / 摘要里最多几条要点（克制：摆满一屏反而没重点） */
export const BRIEF_POINT_MAX = 5
/** 目标条数的下限（素材不足时不必凑数，故只作目标，不作硬校验） */
export const BRIEF_POINT_MIN = 3
/**
 * 单条要点正文的**字符上限**（`人名：标题` 合计）。
 *
 * 为什么按字符截断（而不是只靠 canvas 的像素折行）：分享图是固定尺寸，长标题会把下方说明
 * 与页脚挤出画布。这里先按字符收敛到一个稳定的长度，canvas 侧再有「像素折行 + maxLines」
 * 作为第二道兜底（见 utils/share-card.ts#drawText）。中文一字符≈一个汉字宽度，故用字符数够近似。
 */
export const BRIEF_TEXT_MAX = 42
/** 来源名的字符上限（媒体名通常 3~6 字，超长的多半是脏数据） */
export const BRIEF_SOURCE_MAX = 12

/**
 * 分享图 / 摘要共用的底部说明（**合规硬要求**：分享出去的内容必须带这句）。
 *
 * 刻意同时包含三件事：来源与时间「已标注」、这是「公开报道」、以及「非平台定性 / 聚合≠认定」。
 * 任何一处缺失都会让转发出去的图被读成平台结论，这是本功能的红线。
 */
export const BRIEF_NOTE =
  '均为公开报道与检索结果，已标注来源与时间；聚合≠认定，非平台定性，不构成对事实的核实。'

/** 一条要点：正文 + 来源 + 时间（三者都会画到图上、也会写进复制摘要） */
export interface WeeklyBriefPoint {
  /** 要点正文（`人名：标题`，已按 BRIEF_TEXT_MAX 截断） */
  text: string
  /** 来源（已按 BRIEF_SOURCE_MAX 截断）；调用方为空时回落「来源未标注」 */
  source: string
  /** 时间（yyyy-mm-dd，UTC+8）；素材无日期时为空串，调用方回落「近期」 */
  date: string
}

/** 一份周报简报（分享图与复制摘要的唯一数据形态） */
export interface WeeklyBrief {
  /** 固定标题 */
  title: string
  /** 统计窗口（yyyy-mm-dd ~ yyyy-mm-dd） */
  range: string
  /** 3~5 条要点（素材不足时更少；空态为 []） */
  points: WeeklyBriefPoint[]
  /** 底部说明（BRIEF_NOTE） */
  note: string
  /** 周报生成时间（ISO），用于说明「什么时候整理的」 */
  generatedAt: string
}

/**
 * 截断：超出上限时保留 `max - 1` 个字符并补一个省略号（省略号本身也占一个位置，
 * 保证结果长度**绝不超过 max** —— 画布按字符预算排版，越界就会溢出）。
 */
export function truncateBriefText(s: string, max: number): string {
  const t = (s ?? '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(1, max - 1))}…`
}

/**
 * 组装周报简报（**纯函数**：同输入同输出，不抛错，脏字段一律跳过）。
 *
 * 流程：取端上时间线（已按日期倒序）→ 逐条过滤（跳过空标题 / 涉政涉军 / 无来源 / 重复文本）
 * → 截断 → 最多取 BRIEF_POINT_MAX 条。
 */
export function buildWeeklyBrief(report: WeeklyReport): WeeklyBrief {
  const digest = buildWeeklyDigest(report)
  const points: WeeklyBriefPoint[] = []

  for (const it of digest.timeline.items) {
    const title = (it.title ?? '').trim()
    const person = (it.personName ?? '').trim()
    const source = (it.source ?? '').trim()
    if (!title) continue

    /* 合规红线 1：分享图上不得出现涉政涉军内容 —— 沿用既有本地拦截，不放宽、不例外 */
    if (isSensitiveQuery(title) || isSensitiveQuery(person)) continue
    /* 合规红线 2：无来源的条目不可追溯，不进要点（来源缺失绝不回落到「一条」） */
    if (!source) continue

    const text = truncateBriefText(person ? `${person}：${title}` : title, BRIEF_TEXT_MAX)
    /* 同一句话（截断后）只留一条：重复摆两遍会让「本周要点」看起来注水 */
    if (points.some((p) => p.text === text)) continue

    points.push({
      text,
      source: truncateBriefText(source, BRIEF_SOURCE_MAX),
      date: it.date
    })
    if (points.length >= BRIEF_POINT_MAX) break
  }

  return {
    title: '本周简报',
    range: report.windowLabel,
    points,
    note: BRIEF_NOTE,
    generatedAt: report.generatedAt
  }
}

/**
 * 文本摘要（**内容与分享图一致**）：标题 + 窗口 + 要点（带来源与时间）+ 说明 + 产品署名。
 *
 * 空态（无要点）也要给出一句说明，而不是一段空白 —— 用户点了「复制摘要」却nothing 可复制，
 * 会以为功能坏了。
 */
export function weeklyBriefCopy(brief: WeeklyBrief): string {
  const lines = [`【${brief.title} · ${brief.range}】`]
  if (brief.points.length === 0) {
    lines.push('本周暂无可分享的动态（关注流最近 7 天没有可汇总的公开报道）。')
  } else {
    brief.points.forEach((p, i) => {
      lines.push(`${i + 1}. ${p.text}（${p.source || '来源未标注'} · ${p.date || '近期'}）`)
    })
  }
  lines.push(brief.note)
  lines.push('名人雷达 · AI 辅助整理，仅供参考')
  return lines.join('\n')
}

/* ===== 免费 / 会员门禁（导出 / 分享是会员权益；站内查看周报仍免费） ===== */

/**
 * 导出 / 分享周报图是否放行（**纯函数**，便于单测）。
 *
 * 分层口径由产品确认：**导出 / 分享是会员权益**（免费用户能看到入口，点开给非弹窗的升级引导），
 * **站内查看周报保持免费**。这是一条**二元**口径（会员放行 / 免费拦截），没有「几次 / 几条」这类
 * 阈值数值，故不需要在 `config/benefits.ts` 新增常量；真正的身份来源仍是 `utils/member.ts#readMemberState`
 * （读 `users.membership` 镜像，其数值口径来自 `config/benefits.ts`）。
 *
 * ⚠ 端上判定只是体验层，不是安全边界：分享图在本机绘制、不经过云端闸门；本函数只决定
 *   「要不要给用户看升级引导」，不承担任何成本控制（分享图零上游检索成本）。
 */
export function canExportWeeklyBrief(isMember: boolean): boolean {
  return isMember
}

/**
 * 免费用户点「导出分享图」时的**升级引导行文案**（非弹窗：页面上的一行文字，点了跳会员页）。
 * 沿用 `utils/opinion-access.ts#moreDetailNote` 的克制写法 —— 一行、不刺眼、不遮罩。
 */
export function weeklyExportNote(): string {
  return '导出 / 转发周报图是会员权益，开通会员即可导出 ›'
}
