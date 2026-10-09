import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import isoWeek from 'dayjs/plugin/isoWeek'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.extend(isoWeek)
dayjs.locale('zh-cn')

export function fromNow(iso: string): string {
  return dayjs(iso).fromNow()
}

export function formatDate(iso: string): string {
  return dayjs(iso).format('YYYY-MM-DD HH:mm')
}

/**
 * 只到日的短格式（报告「人物速览」的覆盖区间用）。
 * 与 report.ts 里 dynamics.date 的 YYYY-MM-DD 同格式，同屏出现不会显得是两个口径。
 */
export function formatDay(iso: string): string {
  return dayjs(iso).format('YYYY-MM-DD')
}

/**
 * yyyy-mm-dd 配额「今天」—— **一律按 UTC+8 算**，与云函数 `quotaGuard#todayKey()` 同一个日期段。
 *
 * 它算的不是「给用户看的日历日」，而是 `openid#日期` 这类**配额行主键的日期段**：云端权威计数
 * 挂在 UTC+8 的日期上（云函数在全球多地执行，本地时区不可用），端上若跟随设备时区，一出时区就错行。
 * 例：UTC-5 的用户在当地 11:00，UTC+8 其实已是次日 00:00 —— 端上仍读写昨天那一行，表现为
 * 「明明刚生成过，额度却没扣」或「还有额度却提示用完」，且只在跨日那几小时出现，极难排查。
 * 故这里刻意**不**跟随设备时区（P2-10，2026-10-09）。加 8 小时后取 UTC 日期 = UTC+8 的日历日，
 * 不依赖 dayjs 的 utc 插件，也不依赖设备时区设置。
 */
export function todayKey(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * ISO 周标识（yyyy-Www，如 2026-W41）。
 * 周报以「自然周」为单位缓存：同一周内重复进入读本机缓存，跨周自动作废重新生成。
 */
export function currentWeekKey(): string {
  const d = dayjs()
  return `${d.isoWeekYear()}-W${String(d.isoWeek()).padStart(2, '0')}`
}

/**
 * 本周（ISO 周）起点的 ISO 时间。
 *
 * 用作「本周周报还没生成」这条提醒的事件时间：以周为单位的时间锚点，
 * 使它在周内只提醒一次（本机已读基线晚于周一即保持已读），跨周自动重新提醒。
 */
export function currentWeekStart(): string {
  return dayjs().startOf('isoWeek').toISOString()
}

/**
 * 报告新鲜度阈值（天）。
 *
 * 缓存策略是「报告一旦 ready 即长期复用、不按时间自动过期」（见 utils/cache.ts），
 * 于是「这份报告是什么时候的」必须由界面主动说清楚。问答页的语料提示、报告页横幅的
 * 刷新入口、收藏卡与历史行的标记都围绕这一个数字，写在这里避免三处各定一个阈值后漂移。
 */
export const STALE_REPORT_DAYS = 14

/** 报告生成距今天数（时间缺失 / 不可解析返回 -1，调用方按「未知」处理） */
export function reportAgeDays(iso?: string | null): number {
  if (!iso) return -1
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return -1
  return Math.floor((Date.now() - t) / 86400000)
}

/** 报告是否已陈旧（生成 ≥ STALE_REPORT_DAYS 天） */
export function isStaleReport(iso?: string | null, days = STALE_REPORT_DAYS): boolean {
  const age = reportAgeDays(iso)
  return age >= 0 && age >= days
}

/**
 * 最近 7 天（含今天）的统计窗口。
 *
 * 刻意用「滚动 7 天」而不是「本周一至今」：自然周口径下每周一打开周报几乎必然没有素材，
 * 用户第一次用就觉得功能是坏的。滚动窗口既保证任何时候都有内容，也仍然是一周的量级。
 */
export function last7DayRange(days = 7): { since: string; until: string; label: string } {
  const until = dayjs()
  const since = until.subtract(days - 1, 'day')
  return {
    since: since.startOf('day').toISOString(),
    until: until.endOf('day').toISOString(),
    label: `${since.format('YYYY-MM-DD')} ~ ${until.format('YYYY-MM-DD')}`
  }
}
