import type { NewsItem } from '@/utils/search'
import type { Report } from '@/utils/report'
import type { CredTier, ImpactLevel, OpinionBlock, ResponseNeed } from '@/utils/opinion-rank'
import type { OpinionEventMember, TimelineItem } from '@/utils/opinion-events'

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

/**
 * report_versions：报告历史版本（S3-1 ③，2026-10-16）。
 *
 * 存**被覆盖掉的那一版**：`report_cache` 一人一份、`force` 重生即整篇替换，旧版不留就永久消失。
 * 行由云端写口在**落库成功之后**写入（`aiProxy/report-store.js#recordVersion`），端上只读；
 * 保留最近 5 版（`REPORT_VERSION_KEEP`，写口每次覆盖顺手裁旧），所以不需要任何定时清理。
 *
 * ⚠ 行内**不含用户标识**（`_id` = `<personKey>#<旧版生成时间>`）：它是全站共享事实的一段历史，
 *   不是「我的那一行」—— 注销时无需按用户删（见 dbInit/schema.js 与用例 18 的白名单）。
 */
export interface ReportVersionRow {
  id: string // `${personKey}#${旧版 generated_at}`
  person_key: string
  name: string
  /** 这一版是什么时候生成的（来自旧版 report.generatedAt） */
  generated_at: string
  /** 它是什么时候被覆盖掉的：与 generated_at 的差就是「这一版被用了多久」 */
  replaced_at: string
  /** 旧版全文（读取时**必须**按读者身份过滤后再交出去，见 utils/report-versions.ts） */
  report: Report
  /** 旧版那时的素材条数（该行当时的 search_meta.news_count） */
  news_count: number
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
  /**
   * 媒体发布时间（上游 datePublished / dateLastCrawled；2026-10-16 起落库，老行为 null）。
   * **不参与「是不是新的」判定**（那是 first_seen_at 的职责）——
   * 只用于展示「这条报道是什么时候发的」，缺失时退回 first_seen_at。
   */
  published_date: string | null
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

/**
 * scan_logs：监控执行日志（云函数 keywordAlert / riskWatch 写、端上只读）。
 * 每个「进入本轮扫描队列」的对象每次执行写一条（成功 / 跳过 / 失败），
 * 供监控页展示「执行状态 + 执行结果」的历史。
 */
export interface ScanLogRow {
  id: string
  /** keyword = 关键词预警；person = 名人风险监控 */
  kind: 'keyword' | 'person'
  /** 被扫描的对象：关键词原文（keyword）或 personKey（person） */
  object_key: string
  /** 显示名：关键词 = 词本身；名人 = 姓名 */
  object_name: string
  /** 本轮执行时刻（ISO） */
  ran_at: string
  /** ok = 扫到结果；skipped = 缓存够新、未打上游；error = 上游失败 */
  status: 'ok' | 'skipped' | 'error'
  /** 命中数：关键词 = 本轮新报道条数；名人 = 本轮新信号条数 */
  hit: number
  /** 结果总数：本轮检索返回条数 */
  total: number
  /** 简短说明：error 的失败原因 / skipped 的复用理由 / ok 的命中摘要 */
  note?: string
}

/*
 * 刻意**不在这里**声明的两张表：`memberships`（会员权威）与 `ai_calls`（防滥用计数）。
 * 它们的权限是「客户端完全不可读写」，端上任何读写都会失败 —— 也就是说并不存在
 * 「给它们定义行类型」的场景；反过来在这里留一份看着能用的类型，会诱导后来者把端上
 * 接到会员权威上去读（那就把「会员身份不由端上自证」这条边界又绕回去了）。
 * 端上要显示的会员信息读 `users.membership` 那份镜像（见 utils/member.ts#readMemberState）。
 */

/**
 * opinion_events：舆情事件（P4 落库，2026-10-13；`_id = event_key`，云函数 `opinionCluster` 写、端上只读）。
 *
 * 全站共享、只读（权限同 `report_cache` / `person_assets`：`{"read": true, "write": false}`）。
 * 字段与端上 `utils/opinion-events.ts#OpinionEvent` **同名同义**，端上能直接读来渲染 ——
 * 只少 `hitsKeyword` / `hitsFollow` 这两项「与我相关」：它们要按**当前用户**的关键词 / 关注的人现算，
 * 而事件是全站共享的，存库事件不带（端上读到后由 utils/opinion-store.ts 现算）。
 */
export interface OpinionEventRow {
  /** = event_key（稳定主题键，见 utils/opinion-events.ts#eventKeyOf） */
  id: string
  event_key: string
  /** 对象键：事件归属的「谁 / 什么词」（成员里出现最多的非空 label；都没有则空串） */
  object_key: string
  block: OpinionBlock
  title: string
  /** 成员条目（含来源、时间、来源性质）—— 与端上 OpinionEventMember 逐字同构 */
  members: OpinionEventMember[]
  /** 保留在事件里的成员数（恒等于 members.length；云端按 MAX_MEMBERS 截断过） */
  memberCount: number
  /** 去重后的**真实**来源条数（≥ memberCount）。老行为空 → 端上回落 memberCount */
  memberTotal?: number
  /** 时间线：时间正序、每条带来源（红线：无来源的条目不入） */
  timeline: TimelineItem[]
  sources: string[]
  labels: string[]
  impact: ImpactLevel
  credibility: CredTier
  response: ResponseNeed
  /** 最早一条报道的时间（不可解析则为空串） */
  first_at: string
  /** 最近一条报道的时间（排序 / 展示用；端上 OpinionEvent.date 与它同义） */
  last_at: string
  /** 我们这一轮重算该事件的时刻（每轮都会前移，**不**用于「是不是新的」判定，见 opinion-store） */
  updated_at: string
}

/**
 * opinion_event_status：用户对舆情事件的**个人状态**（P4，2026-10-13；`_id = openid`，端上读写自己那一行）。
 *
 * 三个 map，都是「我这边的事实」，**没有一个是内容编辑**（产品锁定：不做备注、不做不感兴趣）：
 *   · `reads`   已读标记（event_key → 时刻）；
 *   · `follows` 跟进（event_key → 时刻），E1-①；
 *   · `subs`    **订阅对象**（对象标签 → 订阅时刻），E1-②（2026-10-16）。
 *
 * ⚠ `subs` 的键**不是 event_key**，而是「订阅的那个对象」（人名 / 关键词）的标签文本 ——
 * 它回答的是「这个对象的后续事件我要看」，粒度比单条事件大一层（口径见 utils/event-subscribe.ts）。
 * 正因为粒度与键空间都不同，它的条数上限与裁剪**独立于** reads/follows（`SUB_MAX`，不占那 300 的额度）：
 * 否则用户多读几百条事件就会把订阅**静默挤掉**，而订阅是显式动作，掉了必须是他自己取消的。
 * 每个用户一行，行权限「仅创建者可读写」⇒ 端上写不到别人的行，写也只动这一行的 map，
 * **绝不触碰 users 文档的任何字段**。
 */
export interface OpinionEventStatusRow {
  /** = openid */
  id: string
  /** event_key → 已读时刻（ISO）。缺省 = 未读 */
  reads: Record<string, string>
  /** event_key → 跟进时刻（ISO）。缺省 = 未跟进 */
  follows: Record<string, string>
  /** 订阅对象标签 → 订阅时刻（ISO）。缺省 = 没订阅过任何对象（E1-②） */
  subs?: Record<string, string>
  updated_at: string
}
