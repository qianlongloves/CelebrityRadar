import Taro from '@tarojs/taro'
import { NOTICES } from '@/config/notices'
import { listFollows } from './follows'
import { loadFollowWatches, FollowWatch, WATCH_LIMIT } from './watch'
import { readWeeklyCache } from './weekly'
import { currentWeekKey, currentWeekStart, fromNow } from './time'
import { loadRevisits, REVISIT_MAX, revisitDescText, revisitOverflowText } from './revisit'

/**
 * 消息中心（首页右上角铃铛）。
 *
 * 三条约束决定了它的形态：
 *
 * 1) **不新增集合、不新增云函数**。关注更新来自 report_cache / feed_cache（watch.ts 已经在
 *    为关注流页做这件事），周报提醒读本机缓存，平台公告是静态常量（config/notices.ts）。
 *    上线不需要任何人工配置，也不用改云 DB 权限。
 * 2) **已读状态存本机 storage，且逐条记「id + 事件时间」**。消息是「本机视角的提醒」：不落云
 *    就没有多设备同步问题，也避免为一条已读记录新增集合与权限。代价是换设备后红点会重新出现
 *    一次，可以接受。已读**不是**「上次打开时间」（那样一进页面就全清空了）：点开哪条算哪条，
 *    没看的留着下次看。也**不是只记 id** —— 关注类消息复用 `follow#<personKey>`，只记 id 会把
 *    那个人此后的动态永久标已读，理由与删除完全相同（见 TimeMark）。旧版本留下的 `messages:read_at`
 *    基线仍参与判定，故老用户升级后不会凭空多出一堆未读（迁移见 readBaselineMs）。
 * 3) **只做「有新内容」这类通知**。点赞 / 评论 / 关注者这类社交通知不做 —— 产品定位是
 *    个人观察工具，没有社区（见设计方案 §九「明确不做」）。
 *
 * 删除（2026-10-10 新增）：与已读一样是**本机**行为 —— 只在本机记一条「已删除」记录，
 * 不落云、不动关注与周报。它与已读共用同一套「id + 事件时间」记录（见 TimeMark）。
 *
 * 成本：读消息 = 1 次 follows 查询 + 关注数×2 次缓存读（watch 带 60s 内存 TTL，与关注流页
 * 共享同一份缓存，从关注流切回发现页时基本全部命中）+ 报告更新（N-2）的 2 次查询
 * （1 次浏览历史 + 1 次 report_cache 轻字段批量读；浏览历史里一行版本指纹都没有时连这 2 次都省掉，
 * 见 utils/revisit.ts 的文件头「代价」）。
 */

/**
 * `report` = 报告更新（N-2 回访，2026-10-16）：**你看过的**某个人，报告又生成过一版。
 * 判据是「我看过哪一版」（history.viewed_generated_at）× 「当前版生成时间」
 * （report_cache.generated_at）—— 两张表都是既有的，云端一行都没改（见 utils/revisit.ts）。
 * 与 `follow` 是两件事：关注类问「我盯的人有新信号吗」，这一类问「我看过的人的结论变了吗」——
 * 前者要求用户先建立关注关系，后者只要求他看过（大多数用户只查不关注）。
 */
export type MessageKind = 'follow' | 'weekly' | 'report' | 'system'

export interface MessageItem {
  id: string
  kind: MessageKind
  title: string
  desc: string
  /** 事件时间（ISO）：用于与已读基线比较、并给列表倒序 */
  at: string
  /** 落地页；平台公告没有跳转目标 */
  url?: string
  unread: boolean
  /** 涉及的名人（只有 `report` 类有）：埋点要能按人聚合「回访点击」 */
  personKey?: string
}

export interface MessageFeed {
  items: MessageItem[]
  /** 未读数（首页红点用同一个值） */
  unread: number
  /** 关注数超过探测上限：说明关注更新只覆盖了前 WATCH_LIMIT 位 */
  truncated: boolean
  /**
   * 命中「报告更新」的总人数（**含被 REVISIT_MAX 折叠掉的那些**）。
   *
   * 为什么单独给一个数而不是让页面自己数列表：折叠之后列表里数不出来，而 R 类验证要的正是
   * 「有多少次打开消息中心是带着回访理由的」（分母是 messages_open）。页面据此上报
   * `revisit_ready`，条件为 > 0 —— 一律上报会让这个数的含义变成「打开次数」，与分母重复。
   */
  revisitTotal: number
}

/** 旧版已读基线键位（存「上次打开消息中心的时间」）：只读不写，作为迁移兜底 */
const LEGACY_READ_KEY = 'messages:read_at'
/** 旧版已读 id 列表（JSON 数组字符串）：只读一次把它迁移成 READ_MARKS_KEY，之后不再写 */
const LEGACY_READ_IDS_KEY = 'messages:read_ids'
/** 已读条目列表（JSON 字符串，元素形如 `{"id":"follow#…","at":1730000000000}`） */
const READ_MARKS_KEY = 'messages:read_marks'
/** 已删除条目列表（JSON 字符串，元素形如 `{"id":"follow#…","at":1730000000000}`） */
const DELETED_KEY = 'messages:deleted'
/**
 * 记录条数上限（已读 / 已删各一份）。消息 id 天然有上限（关注 ≤ 30 + 周报 1 + 公告若干），
 * 但周报键含 ISO 周、关注会增删，长期使用仍会缓慢累积，故裁剪到最近 N 条 —— 被裁掉的都是
 * 很旧的条目，早被后来的新条目挤出列表，不会因此重新变未读 / 重新出现。
 */
const MARK_LIMIT = 300

/**
 * 已读 / 已删除条目都是**「id + 事件时间」两个值**，不是只记 id。
 *
 * 为什么必须带上时间：关注类消息的 id 是 `follow#<personKey>` —— 同一个人的**下一次**更新
 * 会复用同一个 id。只记 id 的话，看过（或删掉）「张三 有新动态」等于把张三此后所有动态
 * 永久标已读 / 永久静音，而用户的本意只是「这条我看过了」；这是最难排查的一类问题
 * （没有任何报错，只是再也不提醒）。于是口径写成：同一 id 里，**事件时间不晚于记录那一刻**
 * 的算已读 / 已删，晚于它的（= 后来的新动态）照常未读 / 照常出现。
 * 周报键含 ISO 周、公告 id 稳定，故对它们就是永久生效，符合预期。
 */
interface TimeMark {
  id: string
  /** 记录那一刻的时间（毫秒）：已读取点击时刻、已删取那条的事件时间；不可解析时退化为当前时间 */
  at: number
}

function isTimeMark(x: unknown): x is TimeMark {
  return (
    !!x && typeof (x as TimeMark).id === 'string' && Number.isFinite((x as TimeMark).at)
  )
}

function readBaselineMs(): number {
  try {
    const raw = Taro.getStorageSync<string>(LEGACY_READ_KEY)
    const t = raw ? Date.parse(raw) : NaN
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

function readMarks(): TimeMark[] {
  try {
    const raw = Taro.getStorageSync<string>(READ_MARKS_KEY)
    if (raw) {
      const arr: unknown = JSON.parse(raw)
      return Array.isArray(arr) ? arr.filter(isTimeMark) : []
    }
  } catch {
    /* 存储被写坏时按「没有已读记录」处理：最坏是多几条未读，不会白屏 */
    return []
  }
  return migrateLegacyReadIds()
}

function writeMarks(marks: TimeMark[]): void {
  try {
    const trimmed = marks.length > MARK_LIMIT ? marks.slice(marks.length - MARK_LIMIT) : marks
    Taro.setStorageSync(READ_MARKS_KEY, JSON.stringify(trimmed))
  } catch {
    /* 静默：写不进去只是红点不熄灭，不影响主流程 */
  }
}

/**
 * 迁移旧版的「已读 id 列表」（`messages:read_ids`）：旧语义是「这条永久已读」。
 * 旧 id 一律记成「迁移这一刻已读」—— 迁移前就存在的条目事件时间早于这一刻，仍算已读
 * （老用户升级后不会凭空多出一堆未读）；而**迁移之后**才产生的新动态（事件时间更晚）
 * 会正常变回未读，这正是本次要修的问题。迁移成功后删掉旧键，只做一次。
 */
function migrateLegacyReadIds(): TimeMark[] {
  let ids: string[] = []
  try {
    const raw = Taro.getStorageSync<string>(LEGACY_READ_IDS_KEY)
    if (raw) {
      const arr: unknown = JSON.parse(raw)
      if (Array.isArray(arr)) ids = arr.filter((x): x is string => typeof x === 'string')
    }
  } catch {
    return []
  }
  if (ids.length === 0) return []
  const at = Date.now()
  const marks = ids.map((id) => ({ id, at }))
  writeMarks(marks)
  try {
    Taro.removeStorageSync(LEGACY_READ_IDS_KEY)
  } catch {
    /* 静默：删不掉旧键只是下次再迁移一次，判定结果一致 */
  }
  return marks
}

/** 已删除条目：与已读共用 TimeMark 记录（形状与判据完全一致，见上方 TimeMark） */
type DeletedMark = TimeMark

function readDeleted(): DeletedMark[] {
  try {
    const raw = Taro.getStorageSync<string>(DELETED_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(isTimeMark)
  } catch {
    /* 存储被写坏时按「没有删除记录」处理：最坏是多出几条消息，不会白屏 */
    return []
  }
}

function writeDeleted(marks: DeletedMark[]): void {
  try {
    const trimmed = marks.length > MARK_LIMIT ? marks.slice(marks.length - MARK_LIMIT) : marks
    Taro.setStorageSync(DELETED_KEY, JSON.stringify(trimmed))
  } catch {
    /* 静默：写不进去只是这条删不掉，不影响主流程 */
  }
}

/** 这条是否已被本机删除（同一 id 且时间不晚于删除那一刻） */
function isDeleted(marks: DeletedMark[], id: string, at: string): boolean {
  const t = Date.parse(at)
  return marks.some((m) => m.id === id && (!Number.isFinite(t) || t <= m.at))
}

/** 这条是否已读（同一 id 且时间不晚于已读那一刻）；与 isDeleted 同一口径 */
function isRead(marks: TimeMark[], id: string, at: string): boolean {
  const t = Date.parse(at)
  return marks.some((m) => m.id === id && (!Number.isFinite(t) || t <= m.at))
}

/**
 * 删除单条消息（本机隐藏，不落云、不影响关注 / 周报本身）。
 *
 * 幂等：同一条删两次只是把时间戳换成第二次的（对判定无影响）。
 * 重复 id 只保留一条记录，避免反复删除同一人时把列表撑满（上限见 MARK_LIMIT）。
 */
export function deleteMessage(id: string, at: string): void {
  const t = Date.parse(at)
  const marks = readDeleted().filter((m) => m.id !== id)
  marks.push({ id, at: Number.isFinite(t) ? t : Date.now() })
  writeDeleted(marks)
}

/**
 * 标记单条已读（点开某条时调用）。
 *
 * 逐条记而不是「一进页面全标」：消息中心的价值在于「哪些我还没看」，自动清空等于没有未读。
 * 记录时刻取**这条自己的事件时间**（与 deleteMessage 完全对称）：此后同一 id 上事件时间
 * 更晚的新动态就自然变回未读 —— 这正是只记 id 时会「永久静音」的地方。
 * 幂等：同一条重复点只是把时间戳换成新的，条目数不增长。
 */
export function markMessageRead(id: string, at: string): void {
  const t = Date.parse(at)
  const marks = readMarks().filter((m) => m.id !== id)
  marks.push({ id, at: Number.isFinite(t) ? t : Date.now() })
  writeMarks(marks)
}

/** 一键全部已读（页面顶部按钮）：逐条按各自的事件时间记「已读到这一刻」 */
export function markAllMessagesRead(targets: Array<{ id: string; at: string }>): void {
  if (targets.length === 0) return
  const byId = new Map<string, number>()
  for (const t of targets) {
    const ms = Date.parse(t.at)
    byId.set(t.id, Number.isFinite(ms) ? ms : Date.now())
  }
  const rest = readMarks().filter((m) => !byId.has(m.id))
  writeMarks([...rest, ...[...byId.entries()].map(([id, at]) => ({ id, at }))])
}

/** 清除本机已读 / 已删除记录（「清空我的数据」调用，与周报缓存同一处理） */
export function clearMessageState(): void {
  try {
    Taro.removeStorageSync(READ_MARKS_KEY)
    Taro.removeStorageSync(LEGACY_READ_IDS_KEY)
    Taro.removeStorageSync(LEGACY_READ_KEY)
    Taro.removeStorageSync(DELETED_KEY)
  } catch {
    /* 静默 */
  }
}

/** 关注更新的时间：报告重生与重新抓到动态取较晚者 —— 它最能代表「这条消息是新的」 */
function watchAt(w: FollowWatch): string {
  const report = w.reportAt ? Date.parse(w.reportAt) : NaN
  const feed = w.feedAt ? Date.parse(w.feedAt) : NaN
  if (!Number.isFinite(report)) return w.feedAt ?? ''
  if (!Number.isFinite(feed)) return w.reportAt ?? ''
  return report >= feed ? (w.reportAt ?? '') : (w.feedAt ?? '')
}

/** 关注更新的副标题：沿用报告页已有的口径（热度 / 收录条数），不引入新术语 */
function describeWatch(w: FollowWatch): string {
  const parts: string[] = []
  if (w.heat !== null) parts.push(`热度 ${w.heat}`)
  /* newsCount 为 null = 这次没读到（见 utils/watch.ts#PersonFacts）：不写「已收录 0 条」 */
  if (typeof w.newsCount === 'number' && w.newsCount > 0) parts.push(`已收录 ${w.newsCount} 条动态`)
  const when = w.reportAt ?? w.feedAt
  parts.push(when ? `更新于 ${fromNow(when)}` : '尚未生成报告')
  return parts.join(' · ')
}

/** 公告日期 → ISO 时间；日期不可解析时退回当前时间（宁可排序偏差，不让整页崩掉） */
function noticeAt(date: string): string {
  const t = Date.parse(`${date}T00:00:00`)
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString()
}

/**
 * 汇总消息列表。未登录时只剩平台公告（关注更新与周报提醒都依赖关注数据）。
 *
 * 未读判定有两个来源：**逐条已读记录**（markMessageRead，id + 事件时间）与旧版时间基线
 * （迁移兜底）。两者都判定为「已读」才算已读 —— 老用户升级后，界面不会突然多出一堆未读。
 *
 * @param force 跳过 watch 的 60s 内存缓存强制重读（留给后续的下拉刷新用）
 */
export async function loadMessages(opts: { force?: boolean } = {}): Promise<MessageFeed> {
  const baseMs = readBaselineMs()
  const marks = readMarks()
  /** 未读 = 没被逐条标记过（同 id 且晚于已读那一刻），且晚于旧基线（老版本「进过消息中心」的痕迹） */
  const isUnread = (id: string, at: string): boolean =>
    Date.parse(at) > baseMs && !isRead(marks, id, at)
  const items: MessageItem[] = []
  const follows = await listFollows()

  if (follows.length > 0) {
    const watches = await loadFollowWatches(follows, { force: opts.force })
    for (const f of follows.slice(0, WATCH_LIMIT)) {
      const w = watches[f.person_key]
      if (!w || !w.hasNew) continue
      const at = watchAt(w)
      if (!at) continue
      const id = `follow#${f.person_key}`
      items.push({
        id,
        kind: 'follow',
        title: `${f.name} 有新动态`,
        desc: describeWatch(w),
        at,
        url: `/package/report/index?personKey=${encodeURIComponent(f.person_key)}`,
        unread: isUnread(id, at)
      })
    }
  }

  /* 周报提醒按 ISO 周给一条。待生成时的时间取「本周起点」而不是 now：
     用 now 的话每次进消息中心都会重新算出一条未读，红点永远熄不掉；
     取周起点则周内看过一次就保持已读，下周自然重新提醒。 */
  if (follows.length > 0) {
    const weekly = readWeeklyCache()
    const pendingAt = currentWeekStart()
    if (weekly) {
      const id = `weekly#${weekly.weekKey}`
      items.push({
        id,
        kind: 'weekly',
        title: '本周周报已生成',
        desc: `${weekly.personCount} 位名人 · ${weekly.entryCount} 条动态，点开查看`,
        at: weekly.generatedAt,
        url: '/package/weekly/index',
        unread: isUnread(id, weekly.generatedAt)
      })
    } else {
      const id = `weekly#${currentWeekKey()}`
      items.push({
        id,
        kind: 'weekly',
        title: '本周周报还没生成',
        desc: `已关注 ${follows.length} 位名人，可汇总最近 7 天的动态`,
        at: pendingAt,
        url: '/package/weekly/index',
        unread: isUnread(id, pendingAt)
      })
    }
  }

  /*
   * 报告更新（N-2 回访）：只对**真的看过**且**报告确实又生成过**的人说这句话。
   * 判据、代价与三条不许越过的线全在 utils/revisit.ts 的文件头 —— 尤其是「没有版本指纹就不算」：
   * 缺了这条，任何三天前查过的人都会在三天后被告知「他有变化」，而那是编出来的。
   *
   * id 复用 `report_update#<personKey>` + 事件时间取当前版的生成时间：这一版之后再重生一版时
   * 同一个 id 上事件时间变新，于是**自动重新变未读**（与 follow 类同一套 TimeMark 口径）。
   */
  const revisits = await loadRevisits()
  for (const it of revisits.slice(0, REVISIT_MAX)) {
    const id = `report_update#${it.personKey}`
    items.push({
      id,
      kind: 'report',
      title: `${it.name} 的报告更新了`,
      desc: revisitDescText(it),
      at: it.currentVersion,
      personKey: it.personKey,
      /* 落在**报告历史页**：那里正是「改了什么」的答案（N-9 差异视图已能给出条数与条目差异），
         而报告页只显示当前版，说不出「跟你看过的那一版比改了什么」 */
      url: `/package/report-history/index?personKey=${encodeURIComponent(it.personKey)}&name=${encodeURIComponent(it.name)}`,
      unread: isUnread(id, it.currentVersion)
    })
  }
  /* 折叠掉的那些如实报数（同 S3-3「不许静默截断」）：这一条只报数、不带人，
     点它去浏览历史（没被列出的那几位都在那份完整名单里） */
  const hidden = revisits.length - REVISIT_MAX
  if (hidden > 0) {
    const tail = revisits[REVISIT_MAX]
    const id = 'report_update#more'
    items.push({
      id,
      kind: 'report',
      title: revisitOverflowText(hidden),
      desc: `消息中心只列最近 ${REVISIT_MAX} 位，其余可以在浏览历史里找到`,
      at: tail.currentVersion,
      url: '/package/history/index',
      unread: isUnread(id, tail.currentVersion)
    })
  }

  for (const n of NOTICES) {
    const at = noticeAt(n.date)
    const id = `notice#${n.id}`
    items.push({
      id,
      kind: 'system',
      title: n.title,
      desc: n.body,
      at,
      unread: isUnread(id, at)
    })
  }

  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  /*
   * 删除过滤放在**排序之后、统计之前**：未读数与列表必须来自同一份数组 ——
   * 在 push 时就跳过会让「未读数」与「列表条数」两处各判一次，早晚对不上。
   */
  const deleted = readDeleted()
  const visible = deleted.length > 0 ? items.filter((i) => !isDeleted(deleted, i.id, i.at)) : items
  return {
    items: visible,
    unread: visible.filter((i) => i.unread).length,
    truncated: follows.length > WATCH_LIMIT,
    /* 用「判定出来的总人数」而不是 visible 里的条数：被本机删掉的那几位不该从分母里消失
       （页面据此上报 revisit_ready，它回答的是「这次打开有没有回访理由」） */
    revisitTotal: revisits.length
  }
}
