import { table } from './db'
import { useAuth } from '@/stores/auth'

/** 埋点事件枚举（§3.8）。阶段 4 起用报告成本事件，阶段 7 全量接入。 */
export type TrackEvent =
  | 'search'
  | 'disambiguate_selected'
  | 'report_hit_cache'
  | 'report_generate'
  | 'follow'
  | 'unfollow'
  | 'favorite'
  | 'refresh_feed'
  | 'share'

/** 非阻塞埋点：失败静默（埋点不允许影响业务路径） */
export function track(event: TrackEvent, props: { personKey?: string; [k: string]: unknown } = {}): void {
  try {
    const id = `${Date.now()}#${Math.random().toString(36).slice(2, 8)}`
    const openid = useAuth.getState().userId
    void table('events')
      .insert({
        id,
        openid,
        event,
        person_key: props.personKey ?? null,
        props,
        created_at: new Date().toISOString()
      })
  } catch {
    /* 静默 */
  }
}
