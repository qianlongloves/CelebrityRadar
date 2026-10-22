/**
 * 事件列表的**搜索与筛选**（纯函数，不碰 React / Taro / 数据库）。
 *
 * 为什么单独成文件（2026-10-22）：筛选条件一旦和渲染写在一起，就只能靠「点一下看看」验证 ——
 * 抽成纯函数后 `test/cases/98-event-filter.js` 能直接钉住每一条判据，
 * 页面只负责把 state 递进来、把结果画出去。
 *
 * ## 三个维度**可叠加**（范围 × 影响面 × 关键词），彼此互不覆盖
 *
 *   · `range`：`all` 全部 / `follows` 我跟进的（`status.follows` 里有这条）/ `unread` 未读
 *     （`status.reads` 里**没有**这条）；
 *   · `impact`：`all` / `high` / `mid` / `low` —— 只认事件自身的影响面，**不做任何推断**；
 *   · `query`：标题、对象标签、来源名、成员标题 / 摘要的**包含匹配**（忽略大小写与首尾空白）。
 *
 * ## 判据一律「宁少不误」
 *
 * 字段缺失不抛错、当成不匹配；关键词为空即不过滤（直接返回原序列表），
 * 调用方不需要先判空。**本模块只做过滤，不排序** —— 排序归
 * `utils/opinion-rank.ts#compareEventOrder`（最新优先），两件事分开才不会互相污染。
 */
import type { OpinionEvent } from './opinion-events'

/** 范围：全部 / 我跟进的（已跟进）/ 未读 */
export type EventRange = 'all' | 'follows' | 'unread'

/** 影响面滤镜：全部 / 高 / 中 / 低（`unknown` 是「判不出来」，不提供单选项，只在「全部」里出现） */
export type EventImpactFilter = 'all' | 'high' | 'mid' | 'low'

/** 范围按钮文案（页面与用例共用，避免两处各写一份中文） */
export const EVENT_RANGE_LABELS: Record<EventRange, string> = {
  all: '全部',
  follows: '已跟进',
  unread: '未读'
}

/** 影响面按钮文案；`all` 刻意不叫「全部」，否则与范围那行的「全部」撞名 */
export const EVENT_IMPACT_LABELS: Record<EventImpactFilter, string> = {
  all: '影响面',
  high: '高影响',
  mid: '中影响',
  low: '低影响'
}

export interface EventFilterOptions {
  /** 范围，缺省 = 全部 */
  range?: EventRange
  /** 影响面，缺省 = 全部 */
  impact?: EventImpactFilter
  /** 搜索词，缺省 / 空白 = 不过滤 */
  query?: string
  /** 已跟进的事件键（`EventStatus.follows`，key = `event.key`） */
  follows?: Record<string, string>
  /** 已读的事件键（`EventStatus.reads`，key = `event.key`） */
  reads?: Record<string, string>
}

/**
 * 单条事件是否命中搜索词。
 *
 * 覆盖「用户会拿什么搜」的五类文本：事件标题、对象标签、来源名、成员（每条报道）的
 * 标题 / 摘要、对象键。**不做分词、不做拼音** —— 小程序的输入场景就是「我记得有个词」，
 * 子串包含已经够用，而分词会带来「搜不到明明有的词」的坏体验（也没有可用的离线词表）。
 */
export function matchEventQuery(ev: OpinionEvent, query: string): boolean {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
  if (!q) return true
  if (!ev) return false

  const hay: string[] = [String(ev.title ?? ''), String(ev.objectKey ?? '')]
  if (Array.isArray(ev.labels)) for (const l of ev.labels) if (l) hay.push(String(l))
  if (Array.isArray(ev.sources)) for (const s of ev.sources) if (s) hay.push(String(s))
  if (Array.isArray(ev.members)) {
    for (const m of ev.members) {
      if (!m) continue
      hay.push(String(m.title ?? ''), String(m.label ?? ''), String(m.summary ?? ''), String(m.source ?? ''))
    }
  }
  return hay.filter(Boolean).join(' ').toLowerCase().includes(q)
}

/** 按三个维度过滤（可叠加）。对任何输入都不抛错：非数组当空列表，脏条目跳过。 */
export function filterEvents(events: OpinionEvent[], opts: EventFilterOptions = {}): OpinionEvent[] {
  const list = Array.isArray(events) ? events : []
  const range: EventRange = opts.range ?? 'all'
  const impact: EventImpactFilter = opts.impact ?? 'all'
  const follows = opts.follows ?? {}
  const reads = opts.reads ?? {}
  const query = opts.query ?? ''

  return list.filter((ev) => {
    if (!ev || !ev.key) return false
    if (range === 'follows' && !follows[ev.key]) return false
    /* 未读 = reads 里没有这条（与 opinion-store 的角标同源判据，不另立「未读」标记） */
    if (range === 'unread' && reads[ev.key]) return false
    if (impact !== 'all' && ev.impact !== impact) return false
    return matchEventQuery(ev, query)
  })
}

/**
 * 当前是否**有生效的筛选条件**。
 * 页面用它区分两条空态：「库里没有事件」（列表本来就空）与「没有符合条件的事件」
 * （有数据但被筛掉了）—— 这两句话对用户的下一步动作完全不同。
 */
export function hasActiveFilter(opts: EventFilterOptions = {}): boolean {
  return (
    (opts.range ?? 'all') !== 'all' ||
    (opts.impact ?? 'all') !== 'all' ||
    !!String(opts.query ?? '').trim()
  )
}
