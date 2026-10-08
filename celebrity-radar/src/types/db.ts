import type { NewsItem } from '@/utils/search'
import type { Report } from '@/utils/report'

/**
 * 云 DB 行类型（§3.8，PostgREST 口径：主键列名 id）。
 * 通过 utils/db.ts 的 table() 访问，行类型在此集中维护。
 */

/** report_cache：全局共享报告缓存（ready 后长期复用，不自动过期）；state=building 作生成互斥锁 */
export interface ReportCacheRow {
  id: string // personKey
  report: Report | null
  generated_at: string // 同时是 building 状态的时间戳
  state: 'building' | 'ready'
  builder: string | null // openid，用于安全释放锁
  search_meta: { news_count: number } | null
}

/** feed_cache：检索结果结构化映射（不存 LLM 产物） */
export interface FeedCacheRow {
  id: string // personKey
  items: NewsItem[]
  fetched_at: string
}

/** refresh_quota：每账号每日主动刷新 ≤10（id = openid#yyyy-mm-dd） */
export interface RefreshQuotaRow {
  id: string
  count: number
}

/** generate_quota：每账号每日「主动生成报告」配额（免费 3 / 会员 30，id = openid#yyyy-mm-dd） */
export interface GenerateQuotaRow {
  id: string
  count: number
}

/**
 * orders：会员订单（id = outTradeNo）。
 * 由云函数 `payCreate` 创建、`payCallback` 改状态；端上**只读**（用于对账与客服排查）。
 */
export interface OrderRow {
  id: string // outTradeNo
  openid: string
  plan: string
  /** 实付金额（分）；回调必须与此值一致才落库 */
  amount_fen: number
  status: 'pending' | 'paid' | 'failed' | 'refunded'
  created_at: string
  paid_at: string | null
  transaction_id: string | null
}

/** events：埋点（§3.8 事件枚举，阶段 7 全量接入，阶段 4 起用报告成本事件） */
export interface EventRow {
  id: string // `${ts}#${rand6}`
  openid: string | null
  event: string
  person_key: string | null
  props: Record<string, unknown> | null
  created_at: string
}
