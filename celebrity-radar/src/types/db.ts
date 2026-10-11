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
  /**
   * 分批生成的**中间结果**（P0-B，2026-10-11）：每批成功即写一次，元素形如
   * `{ key: 'identity' | 'facts' | 'judgement' | 'detail', data: {…该批字段} }`。
   *
   * 它只是过程记录，**不参与任何读取判定**：缓存命中与读者可见性都只看 state / report。
   * 但正因如此它必然不是必填 —— acquire 会清空它、save 会连同旧行一起替换掉它，
   * 只有「正在按批生成」的那一段时间里才有值，所以声明成可选。
   */
  parts?: unknown
  /**
   * 报告 Schema 版本（见 utils/report.ts#REPORT_SCHEMA_VERSION）。
   *
   * **可选是刻意的**：`report_cache` 由端上直写，2026-10-09 之前落库的行没有这个字段，
   * 声明成必填只会让「读老行」在类型层被当成合法数据。读取一律走
   * utils/cache.ts#reportSchemaVersion（缺失按 1 处理），不要在这里 `?.` 后直接比较。
   */
  schemaVersion?: number
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
  /* granting = 已收到支付成功通知、正在发货（写 memberships 权威 + users.membership 镜像），
     **不是**终态；paid = 已发货完成。残留的 granting 即「付了钱还没拿到会员」，靠回调重试补救 */
  status: 'pending' | 'granting' | 'paid' | 'failed' | 'refunded'
  created_at: string
  /** 收到支付成功通知的时刻（回调抢到发货权时写） */
  paid_at: string | null
  /** 发货完成（两处会员数据都已写入）的时刻；granting 残留时为空 */
  granted_at: string | null
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

/**
 * risk_signals：风险信号流水（id = `${person_key}#${url 哈希}`）。
 * 由云函数 `riskWatch` 写、端上**只读**（第 1 期名人风险监控）。
 */
export interface RiskSignalRow {
  id: string
  person_key: string
  name: string
  /**
   * 只由「命中的是哪一类词」决定（司法/税务 → high、合作/维权 → mid、回应 → low），
   * **不是对事件严重性的评估**（判定规则见 cloudfunctions/riskWatch/index.js 取舍 5）。
   * 端上仅用它排序与决定「值不值得推送」，界面上不出现等级字样。
   */
  level: 'high' | 'mid' | 'low'
  category: 'judicial' | 'tax' | 'contract' | 'rights' | 'statement'
  category_label: string
  /** 命中的原词（与报告页风险雷达同一份词典，两端一致性由测试钉住） */
  keyword: string
  title: string
  /** 素材原文摘录（截断）；为空时退回 title */
  quote: string
  source: string
  url: string
  /** 我们自己的时钟打的「第一次见到这条」 */
  first_seen_at: string
}

/**
 * risk_scans：名人风险扫描快照（id = personKey，云函数写、端上只读）。
 * 用来回答「这个人的哪些条目已经见过」，以及「从哪一刻起算新」。
 */
export interface RiskScanRow {
  id: string
  person_key: string
  name: string
  scanned_at: string
  /** 首次扫描时刻：只把这一刻之后新出现的条目当信号（首轮只建档、不推送） */
  baseline_at: string
  seen_urls: string[]
  scanned: number
  signals_total: number
}

/*
 * 刻意**不在这里**声明的两张表：`memberships`（会员权威）与 `ai_calls`（防滥用计数）。
 * 它们的权限是「客户端完全不可读写」，端上任何读写都会失败 —— 也就是说并不存在
 * 「给它们定义行类型」的场景；反过来在这里留一份看着能用的类型，会诱导后来者把端上
 * 接到会员权威上去读（那就把「会员身份不由端上自证」这条边界又绕回去了）。
 * 端上要显示的会员信息读 `users.membership` 那份镜像（见 utils/member.ts#readMemberState）。
 */
