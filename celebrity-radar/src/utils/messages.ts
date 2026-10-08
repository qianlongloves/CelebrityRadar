import Taro from '@tarojs/taro'
import { NOTICES } from '@/config/notices'
import { listFollows } from './follows'
import { loadFollowWatches, FollowWatch, WATCH_LIMIT } from './watch'
import { readWeeklyCache } from './weekly'
import { currentWeekKey, currentWeekStart, fromNow } from './time'

/**
 * 消息中心（首页右上角铃铛）。
 *
 * 三条约束决定了它的形态：
 *
 * 1) **不新增集合、不新增云函数**。关注更新来自 report_cache / feed_cache（watch.ts 已经在
 *    为关注流页做这件事），周报提醒读本机缓存，平台公告是静态常量（config/notices.ts）。
 *    上线不需要任何人工配置，也不用改云 DB 权限。
 * 2) **已读状态存本机 storage，且逐条记**。消息是「本机视角的提醒」：不落云就没有多设备同步
 *    问题，也避免为一条已读记录新增集合与权限。代价是换设备后红点会重新出现一次，可以接受。
 *    已读记的是**条目 id**而不是「上次打开时间」：进页面不再自动清空未读，点开哪条算哪条，
 *    没看的留着下次看。旧版本留下的 `messages:read_at` 基线仍参与判定，故老用户升级后
 *    不会凭空多出一堆未读（迁移见 readBaselineMs）。
 * 3) **只做「有新内容」这类通知**。点赞 / 评论 / 关注者这类社交通知不做 —— 产品定位是
 *    个人观察工具，没有社区（见设计方案 §九「明确不做」）。
 *
 * 成本：读消息 = 1 次 follows 查询 + 关注数×2 次缓存读（watch 带 60s 内存 TTL，与关注流页
 * 共享同一份缓存，从关注流切回发现页时基本全部命中）。
 */

export type MessageKind = 'follow' | 'weekly' | 'system'

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
}

export interface MessageFeed {
  items: MessageItem[]
  /** 未读数（首页红点用同一个值） */
  unread: number
  /** 关注数超过探测上限：说明关注更新只覆盖了前 WATCH_LIMIT 位 */
  truncated: boolean
}

/** 旧版已读基线键位（存「上次打开消息中心的时间」）：只读不写，作为迁移兜底 */
const LEGACY_READ_KEY = 'messages:read_at'
/** 已读条目 id 列表（JSON 数组字符串） */
const READ_IDS_KEY = 'messages:read_ids'
/**
 * id 列表上限。消息 id 天然有上限（关注 ≤ 30 + 周报 1 + 公告若干），但周报键含 ISO 周、
 * 关注会增删，长期使用仍会缓慢累积，故裁剪到最近 N 条 —— 被裁掉的都是很旧的条目，
 * 早被后来的新条目挤出列表，不会因此重新变未读。
 */
const READ_IDS_LIMIT = 300

function readBaselineMs(): number {
  try {
    const raw = Taro.getStorageSync<string>(LEGACY_READ_KEY)
    const t = raw ? Date.parse(raw) : NaN
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

function readIds(): string[] {
  try {
    const raw = Taro.getStorageSync<string>(READ_IDS_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    /* 存储被写坏时按「没有已读记录」处理：最坏是多几条未读，不会白屏 */
    return []
  }
}

function writeIds(ids: string[]): void {
  try {
    const trimmed = ids.length > READ_IDS_LIMIT ? ids.slice(ids.length - READ_IDS_LIMIT) : ids
    Taro.setStorageSync(READ_IDS_KEY, JSON.stringify(trimmed))
  } catch {
    /* 静默：写不进去只是红点不熄灭，不影响主流程 */
  }
}

/**
 * 标记单条已读（点开某条时调用）。
 *
 * 逐条记而不是「一进页面全标」：消息中心的价值在于「哪些我还没看」，自动清空等于没有未读。
 * 幂等 —— 重复点同一条不会写进重复 id。
 */
export function markMessageRead(id: string): void {
  const ids = readIds()
  if (ids.includes(id)) return
  ids.push(id)
  writeIds(ids)
}

/** 一键全部已读（页面顶部按钮）：把当前列表的 id 一次性并入 */
export function markAllMessagesRead(targets: string[]): void {
  const set = new Set(readIds())
  const before = set.size
  for (const id of targets) set.add(id)
  if (set.size === before) return
  writeIds([...set])
}

/** 清除本机已读记录（「清空我的数据」调用，与周报缓存同一处理） */
export function clearMessageState(): void {
  try {
    Taro.removeStorageSync(READ_IDS_KEY)
    Taro.removeStorageSync(LEGACY_READ_KEY)
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
  if (w.newsCount > 0) parts.push(`已收录 ${w.newsCount} 条动态`)
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
 * 未读判定有两个来源：**逐条已读 id**（markMessageRead）与旧版时间基线（迁移兜底）。
 * 两者都判定为「已读」才算已读 —— 老用户升级后，界面不会突然多出一堆未读。
 *
 * @param force 跳过 watch 的 60s 内存缓存强制重读（留给后续的下拉刷新用）
 */
export async function loadMessages(opts: { force?: boolean } = {}): Promise<MessageFeed> {
  const baseMs = readBaselineMs()
  const readSet = new Set(readIds())
  /** 未读 = 没被逐条标记过，且晚于旧基线（老版本「进过消息中心」的痕迹） */
  const isUnread = (id: string, at: string): boolean => !readSet.has(id) && Date.parse(at) > baseMs
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
        url: `/pages/report/index?personKey=${encodeURIComponent(f.person_key)}`,
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
        url: '/pages/weekly/index',
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
        url: '/pages/weekly/index',
        unread: isUnread(id, pendingAt)
      })
    }
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
  return {
    items,
    unread: items.filter((i) => i.unread).length,
    truncated: follows.length > WATCH_LIMIT
  }
}
