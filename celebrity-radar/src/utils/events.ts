import { table } from './db'
import { useAuth } from '@/stores/auth'

/** 埋点事件枚举（§3.8）。阶段 4 起用报告成本事件，阶段 7 全量接入。 */
export type TrackEvent =
  | 'search'
  | 'disambiguate_selected'
  | 'report_hit_cache'
  | 'report_generate'
  /**
   * 本次刷新被「只升不降」拦下（P0，2026-10-09）：缓存里那版含会员段落，本次较简略的
   * 产物没有覆盖它。单列一个事件是为了能算比例 —— 命中率高的说明提示词/档位设计有问题，
   * 用户在反复点「刷新最新」却拿不到会员段落。
   */
  | 'report_kept_member'
  /**
   * 本次刷新被「免费档刷新冷却」拦下（批 2，2026-10-09）：报告是 12 小时内生成的，
   * 免费档不重复生成（见 cache.ts#isFreeRefreshCooling）。
   * 单列一个事件是因为**这条闸门的价值只能靠数据证明**：它省的是真金白银，
   * 代价是用户点了刷新却看不出变化 —— 若长期命中极低，说明没省到钱，就该撤掉它，
   * 而不是白留一个让人困惑的按钮行为。
   */
  | 'report_refresh_cooled'
  | 'follow'
  | 'unfollow'
  | 'favorite'
  | 'refresh_feed'
  | 'share'
  /* 周报：与 report_generate 分开计，避免污染「报告缓存命中率」这一成本口径 */
  | 'weekly_generate'
  /* 消息中心：看的是入口使用率（props.unread 记录打开时还有几条未读） */
  | 'messages_open'
  /* AI 问答：刻意与 report_generate 分开计 —— 问答不消耗生成额度，混在一起会带偏成本口径。
     props.passages 记录本次实际拼进 prompt 的资料条数（判断检索是否真的筛掉了东西）。 */
  | 'report_qa_ask'
  /* 主题知识库：看的是词云点击转化（props.from 区分入口是报告页还是直接打开）。 */
  | 'topic_open'

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
