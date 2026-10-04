import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

export function fromNow(iso: string): string {
  return dayjs(iso).fromNow()
}

export function formatDate(iso: string): string {
  return dayjs(iso).format('YYYY-MM-DD HH:mm')
}

/** yyyy-mm-dd（配额主键用，本地时区） */
export function todayKey(): string {
  return dayjs().format('YYYY-MM-DD')
}
