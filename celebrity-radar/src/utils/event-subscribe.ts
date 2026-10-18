import {
  eventNewness,
  loadEventStatusChecked,
  saveEventStatus,
  type EventStatus
} from './opinion-store'
import type { OpinionEvent } from './opinion-events'

/**
 * 事件订阅（E1-②，2026-10-16；**站内口径**）。
 *
 * ## 它和「跟进」（E1-①）差在哪
 *
 *   · 跟进（`setEventFollow`）：盯**这一条**事件的后续（键 = `event_key`），落点在云端日报候选。
 *   · 订阅（本文件）：盯**这个对象**（人 / 关键词）之后的**所有**事件（键 = 对象标签），落点是站内。
 * 跟进是「这条进展我要知道」，订阅是「这个人/这个词在动，我要看到」。粒度差一层，所以两张键空间。
 *
 * ## 订阅的单位为什么是「对象标签」，而不是 personKey / 话题 id
 *
 * ⚠ 这是**被数据逼出来的选择**，不是设计偏好：
 * `opinion_events` 里**没有** `personKey`，也**没有**话题字段 —— 人物与关键词都只以**标签文本**
 * 存在于 `objectKey` / `labels[]` / `members[].label`。要按 personKey 或话题订阅，就得改云侧聚类
 * （新增字段 + 回填存量 + 重跑一轮），成本与风险都远超「站内口径」这次的范围。
 * 因此订阅存的是**归一后的标签文本**，匹配时对事件的标签集合归一后取交集。
 * 代价如实记下：**同名会被合并**（两个同名的人算一个对象），这也是「标签」本来就有的事。
 *
 * ⚠ 另一条被数据逼出来的规则：**匹配用 `labels[]` 全体，不只比 `objectKey`**。
 * `objectKey` 是「成员里出现最多的那个 label」，每轮重算都可能**换人**（同一个人，
 * 如果这轮他旁边冒出一个更高频的标签，整个事件的 objectKey 就变了）—— 拿它当唯一判据，
 * 订阅会时灵时不灵。`labels[]` 是去重后的全体归属，只要新事件里他是成员，就一定在里面。
 *
 * ## 站内消费（订阅之后发生什么）
 *
 * 预警页（`package/alerts`，即「我订的东西」）新增一类「订阅的对象」：列出我订阅的每个对象、
 * 它最近命中且**我还没读过**的事件。事件列表页给命中的事件打个「订阅」标。
 * 推送随 N-1 冻结，**本次不做任何推送 / 通知**。
 *
 * ⚠ **不另算一套角标**：命中的事件本来就参与事件模块的 `new` / `update` 判定（只看 `reads`），
 * 再给订阅算一个角标，同一件事会在两处各提醒一次。订阅只**筛选与呈现**，不新增「消掉」的语义。
 *
 * ⚠ 订阅是**站内关系**，与「导出」不同：**免费与会员完全一致**（同 S3-2 监测工作台的分层口径）。
 */

/**
 * 订阅对象的条数上限。
 *
 * 依据：订阅是**显式动作**（每订一个都要用户点一次），30 个已远超「我真正想盯的对象」量级；
 * 且它要整块塞进 `opinion_event_status` 那一行（单文档有体积上限），不能无界增长。
 * ⚠ 与 `MAX_STATUS_ENTRIES`（reads + follows 的 300）**互不占用**：见 opinion-store#pruneStatus。
 */
export const SUB_MAX = 30

/**
 * 归一化 —— 订阅匹配的**唯一**口径（存与比都走它，绝不能一处用原文、一处用归一）。
 *
 * 做三件事：去首尾空白、内部连续空白压成一个、拉丁字母转小写。
 * ⚠ 刻意**不做**的事：不删空格（「李 明」与「李明」是两个标签）、不删标点、不做模糊匹配。
 * 归一得越激进，越会把两个人当成一个人 —— 那比「同名合并」更糟（同名至少是同一个名字）。
 */
export function normSubject(label: unknown): string {
  return String(label ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 一条事件围绕的「对象」标签集合：`objectKey` + `labels[]`，归一、去重、去空 */
export function subjectLabelsOf(event: OpinionEvent | null | undefined): string[] {
  if (!event) return []
  const raw = [event.objectKey, ...(Array.isArray(event.labels) ? event.labels : [])]
  const out: string[] = []
  for (const r of raw) {
    const n = normSubject(r)
    if (n && out.indexOf(n) < 0) out.push(n)
  }
  return out
}

/** 订阅对象（内存形态）：显示名 + 归一形 + 订阅时刻 */
export interface SubjectSub {
  /** 显示名 = 库里存的原始标签（trim 后） */
  label: string
  /** 归一形（匹配用，= normSubject(label)） */
  norm: string
  /** 订阅时刻（ISO） */
  at: string
}

/**
 * `subs` map → 数组（按订阅时刻倒序，最近的在前）。纯函数，对任何脏输入都不抛。
 * 不可解析的时刻按 0 处理（排在最后），**不丢弃** —— 宁可顺序难看，也不要静默吞掉用户的订阅。
 */
export function toSubjectSubs(subs: Record<string, string> | null | undefined): SubjectSub[] {
  const out: SubjectSub[] = []
  if (!subs || typeof subs !== 'object') return out
  for (const [label, at] of Object.entries(subs)) {
    const key = String(label ?? '').trim()
    const norm = normSubject(key)
    if (!key || !norm) continue
    out.push({ label: key, norm, at: typeof at === 'string' ? at : '' })
  }
  out.sort((a, b) => {
    const x = Date.parse(a.at)
    const y = Date.parse(b.at)
    return (Number.isFinite(y) ? y : 0) - (Number.isFinite(x) ? x : 0) || (a.label < b.label ? -1 : 1)
  })
  return out
}

/**
 * 把订阅表裁到 `max` 条（超出的按「订阅得最晚的优先保留」丢弃）。纯函数，不改入参。
 *
 * ⚠ 没超上限时**原样透传**（只做归一化用的键整理，不重排、不丢）：写口是「读-改-写」，
 * 如果这里顺手按时间重排，`toggleSubject` 每次取消一个订阅都会把整表的键顺序改一遍 ——
 * 库里的 diff 与「我只删了一个键」对不上，排障时看不出到底动过什么。
 */
export function pruneSubjects(
  subs: Record<string, string> | null | undefined,
  max: number = SUB_MAX
): Record<string, string> {
  const list = toSubjectSubs(subs)
  if (list.length <= max) {
    const src = subs && typeof subs === 'object' ? subs : {}
    const out: Record<string, string> = {}
    for (const [label, at] of Object.entries(src)) {
      const key = String(label ?? '').trim()
      if (!key || !normSubject(key)) continue
      out[key] = typeof at === 'string' ? at : ''
    }
    return out
  }
  const out: Record<string, string> = {}
  for (const s of list.slice(0, max)) out[s.label] = s.at
  return out
}

/**
 * 有没有订阅过任何对象。
 *
 * 给消费方做**短路**用：预警页先问这一句，没订阅就**不读事件表**
 * （否则为一个空列表去读两百行，不值；同 `utils/revisit.ts#loadRevisits` 的口径）。
 */
export function hasSubjectSubs(status: EventStatus | null | undefined): boolean {
  return toSubjectSubs(status && status.subs).length > 0
}

/** 我是否已订阅「这个标签」（按归一形比，不管库里存的是哪种大小写 / 空白形态） */
export function findSubjectSub(
  status: EventStatus | null | undefined,
  label: string
): SubjectSub | null {
  const norm = normSubject(label)
  if (!norm) return null
  for (const s of toSubjectSubs(status && status.subs)) {
    if (s.norm === norm) return s
  }
  return null
}

/** 一个订阅对象当前的动向 */
export interface SubjectHit {
  /** 显示名（= 订阅时那个标签） */
  label: string
  /** 订阅时刻（ISO） */
  at: string
  /** 命中该对象的事件**总条数**（含已读）—— 用来区分「这个对象还没事件」与「有事件但我都看过了」 */
  matched: number
  /** 命中该对象、且当前**有角标**（new / update）的事件，时间倒序（最近的在先） */
  fresh: OpinionEvent[]
}

/**
 * 把「我订阅的对象」与「当前事件」对齐，给预警页用。纯函数。
 *
 * 判定三件独立的事，别混成一个数：
 *   · `matched === 0`            → 这个对象**目前还没有事件**（可能刚订阅，也可能库没跑过）；
 *   · `matched > 0 && fresh=[]` → 有事件，但**我都看过了**（角标语义与事件卡完全同源，见 opinion-store）;
 *   · `fresh.length > 0`         → 有**我还没看**的动向，这才是「订阅起作用了」的证据。
 * 把前两种混成「暂无线索」会让「我刚订阅」和「我早看完了」看起来一样。
 *
 * 排序：**有未读动向的排前面**（按未读条数降序），其次按订阅时刻倒序 —— 订阅那一栏是「有没有动静」
 * 的视图，没动静的对象不该把有动静的挤下去。
 */
export function buildSubjectHits(
  events: OpinionEvent[] | null | undefined,
  status: EventStatus | null | undefined
): SubjectHit[] {
  const subs = toSubjectSubs(status && status.subs)
  if (subs.length === 0) return []
  const list = Array.isArray(events) ? events : []

  const hits: SubjectHit[] = subs.map((s) => ({ label: s.label, at: s.at, matched: 0, fresh: [] }))
  /* 归一形 → 该订阅对象在结果数组里的下标（同一归一形只可能有一个订阅键，见 toggleSubject 的幂等） */
  const byNorm: Record<string, number> = {}
  hits.forEach((h, i) => {
    byNorm[normSubject(h.label)] = i
  })

  for (const ev of list) {
    if (!ev || typeof ev.key !== 'string' || !ev.key) continue
    for (const n of subjectLabelsOf(ev)) {
      const idx = byNorm[n]
      if (idx === undefined) continue
      const hit = hits[idx]
      hit.matched++
      if (eventNewness({ event_key: ev.key, last_at: ev.date }, status) !== 'seen') hit.fresh.push(ev)
      /* 一条事件同时命中多个订阅对象时，每个对象都要记上（它们各自是独立的订阅关系） */
    }
  }

  for (const h of hits) {
    h.fresh.sort((a, b) => {
      const x = Date.parse(a.date)
      const y = Date.parse(b.date)
      return (Number.isFinite(y) ? y : 0) - (Number.isFinite(x) ? x : 0)
    })
  }

  hits.sort((a, b) => {
    if (a.fresh.length !== b.fresh.length) return b.fresh.length - a.fresh.length
    const x = Date.parse(a.at)
    const y = Date.parse(b.at)
    return (Number.isFinite(y) ? y : 0) - (Number.isFinite(x) ? x : 0) || (a.label < b.label ? -1 : 1)
  })
  return hits
}

/** 订阅栏的「N 个对象有新动向」计数（无动向返回 0）。数字一律从 `buildSubjectHits` 派生，不另算一套 */
export function subjectFreshCount(hits: SubjectHit[] | null | undefined): number {
  if (!Array.isArray(hits)) return 0
  let n = 0
  for (const h of hits) if (h.fresh.length > 0) n++
  return n
}

/**
 * 事件 key → 命中的订阅对象显示名（命中多个时用「、」连）。
 *
 * 给**列表页打标**用：列表页要的是「这条事件是不是我订阅的那个对象」，含**已读过**的事件
 * —— 所以不能用 `SubjectHit.fresh`（那里面只有未读的）。一次算好，别在渲染里逐条扫。
 */
export function subscribedLabelByEvent(
  events: OpinionEvent[] | null | undefined,
  status: EventStatus | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  const subs = toSubjectSubs(status && status.subs)
  if (subs.length === 0) return out
  const byNorm: Record<string, string> = {}
  for (const s of subs) if (byNorm[s.norm] === undefined) byNorm[s.norm] = s.label
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev.key !== 'string' || !ev.key) continue
    const names: string[] = []
    for (const n of subjectLabelsOf(ev)) {
      const label = byNorm[n]
      if (label !== undefined && names.indexOf(label) < 0) names.push(label)
    }
    if (names.length) out[ev.key] = names.join('、')
  }
  return out
}

/* ─────────────────────────── 读写 ─────────────────────────── */

/** 订阅 / 取消订阅的结果 */
export type SubscribeOutcome =
  /** 已订阅（含「本来就订了」，幂等不写库） */
  | 'on'
  /** 已取消（含「本来就没订」，幂等不写库） */
  | 'off'
  /** 拒绝：订阅对象已达上限（`SUB_MAX`），**不静默顶掉最早的那个** */
  | 'full'
  /** 失败：标签为空，或写库失败（调用方据此提示，且要回滚乐观态） */
  | 'failed'

/**
 * 订阅 / 取消订阅一个对象。返回结果见 {@link SubscribeOutcome}。
 *
 * ⚠ 满员时返回 `'full'` 而**不是**淘汰最早的订阅：订阅是用户一个个点出来的，静默丢掉一个 =
 * 他不知道自己在盯的东西已经没了。让他自己先取消一个（同 S3-2 工作台 togglePick 的口径）。
 *
 * ⚠ 幂等：要订的已订 / 要取消的本来就没有 → 直接返回，**不写库**（一次点击不该产生一次写）。
 */
export async function toggleSubject(
  label: string,
  on: boolean,
  now: Date = new Date()
): Promise<SubscribeOutcome> {
  const key = String(label ?? '').trim()
  if (!key || !normSubject(key)) return 'failed'

  /*
   * 读失败直接回 failed、**不写**（2026-10-18，P2）：saveEventStatus 是整行覆盖写，
   * 拿一份空状态去写会把同一行的 reads / follows 一起清掉 —— 用户真实的「已读」与「关注」
   * 会因为这个对象的订阅动作而全部丢失。
   */
  const read = await loadEventStatusChecked()
  if (!read.ok) return 'failed'
  const cur = read.status
  const subs = { ...(cur.subs ?? {}) }
  const existing = findSubjectSub(cur, key)

  if (on) {
    if (existing) return 'on'
    if (Object.keys(subs).length >= SUB_MAX) return 'full'
    subs[key] = now.toISOString()
  } else {
    if (!existing) return 'off'
    delete subs[existing.label]
  }

  const ok = await saveEventStatus({ ...cur, subs: pruneSubjects(subs) })
  if (!ok) return 'failed'
  return on ? 'on' : 'off'
}
