import { useCallback, useMemo, useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { listFollows } from '@/utils/follows'
import { getFeedDetails } from '@/utils/cache'
import { readWeeklyCache } from '@/utils/weekly'
import type { WeeklyReport } from '@/utils/weekly'
import { listRecentHistory } from '@/utils/history'
import { track } from '@/utils/events'
import { loadHotBoard } from '@/utils/hot-board'
import { loadAlerts, listWatches, markAllSeen, splitWatches } from '@/utils/keyword-alert'
import { loadRiskSignals, monitorPerson } from '@/utils/risk-watch'
import {
  alertNewCount,
  countFollowUpdates,
  countNewEvents,
  markModuleSeen,
  readInboxSeen,
  riskNewCount
} from '@/utils/inbox'
import { EVENT_OVERVIEW_INITIAL, overviewSlice } from '@/utils/opinion-access'
import {
  PICK_LIMIT,
  dismissPick,
  pickCostNote,
  pickMonitorCandidates,
  pickSourceNote,
  readPickDismissed,
  shouldShowPick
} from '@/utils/opinion-pick'
import type { PickCandidate } from '@/utils/opinion-pick'
import {
  CRED_LABEL,
  IMPACT_LABEL,
  RESPONSE_LABEL,
  buildOpinionQueue,
  credibilityOf,
  impactOf,
  pickDailyFocus,
  responseOf
} from '@/utils/opinion-rank'
import type { CredTier, ImpactLevel, OpinionEntry, OpinionInput, ResponseNeed, TimeBasis } from '@/utils/opinion-rank'
import { buildDailyBrief } from '@/utils/opinion-brief'
import { buildOpinionEvents } from '@/utils/opinion-events'
import type { OpinionEvent } from '@/utils/opinion-events'
import {
  emptyStatus,
  eventNewness,
  loadEventStatus,
  loadStoredEvents,
  markEventRead,
  markEventsRead,
  newnessLabel,
  resolveDisplayEvents,
  setEventFollow
} from '@/utils/opinion-store'
import type { EventStatus } from '@/utils/opinion-store'
import type { OpinionEventRow, RiskSignalRow } from '@/types/db'
import type { RiskCategory } from '@/utils/risk'
import { domainLabel, parsePersonKey } from '@/config/domains'
import { formatMoment8 } from '@/utils/time'
import { useTabBarSync } from '@/utils/tabbar'
import './index.scss'

/**
 * 舆情页（底部菜单第三格「盯」，2026-10-13 新增）。
 */
type Status = 'loading' | 'ready' | 'error'

interface FeedPreview {
  /** 归属名人的稳定键（`名字#领域码`），供「今日要点」feed 条目精准跳转名人主页 */
  personKey: string
  personName: string
  domain: string
  title: string
  source: string
  date: string
  /** 条目级分级字段（云端写口 aiProxy#saveFeed 写入 feed_cache 前用风险词典补齐；未命中 / 旧缓存则无） */
  category?: RiskCategory
  level?: string
}

interface AlertPreview {
  keyword: string
  title: string
  source: string
  date: string
  /** 时间口径（见 TimeBasis）：'seen' = 上面那个时间其实是**我们首次扫到它**的时刻 */
  timeBasis?: TimeBasis
  /** 条目级分级字段（云端 keywordAlert 写入 keywords.items 时补齐；未命中 / 旧缓存则无） */
  category?: RiskCategory
  level?: string
}

interface FeedState {
  status: Status
  /** 全部归并后的动态（统一队列取全量） */
  items: FeedPreview[]
  /** 关注的人名（「与我相关」排序用） */
  followNames: string[]
}

interface WeeklyState {
  status: Status
  report: WeeklyReport | null
}

interface AlertState {
  status: Status
  newTotal: number
  /** 风险信号里自上次查看以来的新增条数（口径走 utils/inbox#riskNewCount，基线是本机 inbox:seen.risk） */
  riskNew: number
  /** 关键词预警条目（全量） */
  items: AlertPreview[]
  /** 风险信号原文（参与统一队列分级） */
  riskRows: RiskSignalRow[]
  /** 监控中的关键词原文（「与我相关」排序用） */
  keywords: string[]
  /** 监控中的名人名（「与我相关」排序用；与关注的人合并） */
  personNames: string[]
}

export default function Opinion() {
  useTabBarSync()

  const [feed, setFeed] = useState<FeedState>({
    status: 'loading',
    items: [],
    followNames: []
  })
  const [weekly, setWeekly] = useState<WeeklyState>({
    status: 'loading',
    report: null
  })
  const [alerts, setAlerts] = useState<AlertState>({
    status: 'loading',
    newTotal: 0,
    riskNew: 0,
    items: [],
    riskRows: [],
    keywords: [],
    personNames: []
  })
  /**
   * 落库事件（P4）：`null` = 还没读到 / 读失败（回落本端聚类）；`[]` = 集合为空（同样回落）。
   * 刻意不用页面的 `Status` 表达它 —— 它本就不算「一块读失败」：读不到就走本端聚类，用户无感，
   * 也不该多出第四处 `status:'error'`（那会让「每块独立降级」的既有断言失真）。
   */
  const [storedEvents, setStoredEvents] = useState<OpinionEventRow[] | null>(null)
  /**
   * 落库事件是否**已读完**（成功 / 失败都算读完）。
   *
   * 端上聚类（`buildOpinionEvents`，要遍历 feed/weekly/alert 多源）是首屏较重的计算，
   * 只该在「确实没有共享事件可用」时才做 —— 而「读失败」与「集合为空」这两种情况都要等
   * `loadStoredEvents` 返回后才谈得上。用它把聚类从首屏关键路径上摘掉（见下方 eventView）。
   */
  const [storedReady, setStoredReady] = useState(false)
  /** 我的事件状态（已读 / 跟进）；读失败 = 空状态（页面照常，只是显示为「都没读过」） */
  const [eventStatus, setEventStatus] = useState<EventStatus>(emptyStatus())
  /**
   * 冷启动推荐候选（S1-4 / 决策 D2，2026-10-16）。`[]` = 不显示。
   *
   * 为什么存「候选」而不是存一个「显示 / 不显示」的布尔：卡片要靠**候选还剩下几个**决定收不收
   * （用户从里面建了一个监控就摘掉一行，摘完自然收起），布尔表达不了这个。
   *
   * 同样刻意**不用页面的 `Status` 表达它**：它不算「一块读失败」（读失败就是不显示这张引导卡，
   * 用户无感），也不该多出第四处 `status:'error'`（那会让「每块独立降级」的既有断言失真）。
   * 与 `storedEvents` 同一处理。
   */
  const [pick, setPick] = useState<PickCandidate[]>([])
  /** 正在建立的那一个（personKey）：防连点，且只禁掉被点的那一行 */
  const [pickingKey, setPickingKey] = useState('')
  /**
   * 建立失败的原因，**就地显示在卡里**（空串 = 没出错）。
   *
   * 为什么不是弹窗也不是 toast：本页有一条既有的形态锁 —— **不引入弹窗**（见用例 29，
   * 「已读 / 跟进」那套「克制的行内交互」），而失败文案（集合没建 / 权限不对 / 额度超限）
   * 又长到会被 toast 截成半句。所以照这页本来的做法：就地一行，全文显示。
   */
  const [pickError, setPickError] = useState('')

  /**
   * 关注动态数据：**只读一次批量缓存**（`getFeedDetails`），供统一队列 / 今日要点 / 事件降级用。
   * 关注动态已改为页首入口按钮、不再展示概要列表与「新 N 条」角标，故这里不再补 `loadFollowWatches`。
   */
  const loadFeed = useCallback(async () => {
    setFeed((s) => ({ ...s, status: 'loading' }))
    try {
      const rows = await listFollows()
      /*
       * 只读这一**次**批量缓存（`getFeedDetails` 把全部关注人的 feed_cache 用一次 in 查询取回）。
       * 关注动态卡已改为页首入口按钮、不再展示概要列表与「新 N 条」角标，故这里**不再补 `loadFollowWatches`**：
       * 它是为每位关注人各读 report_cache + feed_cache（2N 次只读）只为算角标的最重一段，已随卡片一并移除。
       */
      const details = await getFeedDetails(rows.map((f) => f.person_key))
      const merged: FeedPreview[] = []
      for (const f of rows) {
        const parsed = parsePersonKey(f.person_key)
        for (const it of details.get(f.person_key)?.items ?? []) {
          merged.push({
            personKey: f.person_key,
            personName: f.name,
            domain: parsed?.domain ?? 'other',
            title: it.title,
            source: it.source,
            date: it.publishedDate ?? '',
            /* 条目级字段（缓存里命中词典才有；旧缓存没有 = 保持未评级） */
            category: it.category,
            level: it.level
          })
        }
      }
      merged.sort((a, b) => (b.date ? Date.parse(b.date) || 0 : 0) - (a.date ? Date.parse(a.date) || 0 : 0))
      setFeed({
        status: 'ready',
        items: merged,
        followNames: rows.map((r) => r.name)
      })
    } catch {
      setFeed((s) => ({ ...s, status: 'error' }))
    }
  }, [])

  /** 周报数据：读本机缓存（零成本），供统一队列里的周报条目使用 */
  const loadWeekly = useCallback(async () => {
    setWeekly((s) => ({ ...s, status: 'loading' }))
    try {
      const cached = readWeeklyCache()
      setWeekly({ status: 'ready', report: cached })
    } catch {
      setWeekly((s) => ({ ...s, status: 'error' }))
    }
  }, [])

  /** 预警概要：关键词订阅 + 预警分组 + 名人风险信号，全部只读 */
  const loadAlertBlock = useCallback(async () => {
    setAlerts((s) => ({ ...s, status: 'loading' }))
    try {
      /*
       * 一次 listWatches 拿到全部行，再拆成关键词 / 监控人两类；keyword_watches 只读这一次 ——
       * 监控人行的 person_key 喂给风险信号、关键词行直接交给 `loadAlerts(rows)`，不再让它内部重读一遍。
       */
      const rows = await listWatches()
      const { keywords, persons } = splitWatches(rows)
      const keys = persons.map((p) => p.person_key).filter((k): k is string => !!k)

      /* 预警分组与风险信号互不依赖 → **并行**（此前风险信号串在预警之后，白白多等一次往返） */
      const [res, riskRows] = await Promise.all([loadAlerts(rows), loadRiskSignals(keys)])

      const items: AlertPreview[] = []
      for (const g of res.groups) {
        for (const it of g.items) {
          items.push({
            keyword: g.keyword,
            title: it.title,
            source: it.source,
            date: it.published_date ?? it.first_seen_at ?? '',
            /* 口径随条目带下去（时间线据此写「发现于」，见 TimeBasis） */
            timeBasis: it.published_date ? 'published' : 'seen',
            /* 条目级字段（云端写入缓存时命中词典才有；旧缓存没有 = 保持未评级） */
            category: it.category,
            level: it.level
          })
        }
      }

      setAlerts({
        status: 'ready',
        /* 关键词预警口径走 utils/inbox#alertNewCount（等价于各词 newCount 之和，基线是每个词的 seen_at） */
        newTotal: alertNewCount(res.groups),
        /* 风险信号没有天然基线，走本机 inbox:seen.risk（见 utils/inbox 文件头） */
        riskNew: riskNewCount(riskRows, readInboxSeen().risk),
        items,
        riskRows,
        keywords: keywords.map((w) => w.keyword),
        personNames: persons.map((p) => p.keyword)
      })
    } catch {
      setAlerts((s) => ({ ...s, status: 'error' }))
    }
  }, [])

  /**
   * 落库事件 + 我的状态（P4）：**并行读**（此前串行，白白多等一次往返）；各自兜底、都不阻断页面。
   * 事件读不到 → 存 `null`（回落本端聚类）；状态读不到 → 空状态。
   * 两者都回来后把 `storedReady` 置真 —— 端上聚类降级据此才允许开始（见 storedReady / eventView）。
   */
  const loadEvents = useCallback(async () => {
    const [stored, status] = await Promise.all([
      loadStoredEvents().catch(() => null),
      loadEventStatus().catch(() => emptyStatus())
    ])
    setStoredEvents(stored)
    setStoredReady(true)
    setEventStatus(status)
  }, [])

  /**
   * 冷启动推荐（S1-4 / 决策 D2，2026-10-16）：只在新用户（关注 0 且 监控词 0 且 监控人 0）
   * 且从未关过时给 2-3 个可一键监控的候选。规则与理由全在 utils/opinion-pick.ts 文件头。
   *
   * ⚠ 关系数用**这一次读到的**判，判完就把候选存进 state，**不在渲染期再判一次** ——
   *   用户从卡里建掉第一个之后关系数就 > 0 了，实时判定会让卡在「还剩两个候选」时突然消失
   *   （见 utils/opinion-pick#shouldShowPick）。所以卡片的显示与否只由 `pick.length` 决定。
   *
   * 四个读口全部只读、零成本、互不依赖（history 是用户自己的表、热门榜是内存 TTL 缓存、
   * keyword_watches 单集合只读、follows 单集合只读），故并行；任一失败按空处理 ——
   * 它只是一张引导卡，读不到就不显示，绝不拖慢或拖垮页面（见 loadFeed 的既有约定）。
   * 这里多读一次 follows / keyword_watches 是**刻意**的：拿另两块 state 反推要等它们回来，
   * 而那张卡只在冷启动才出现，为此多串一次等待不划算。
   */
  const loadPick = useCallback(async () => {
    try {
      if (readPickDismissed()) {
        setPick([])
        return
      }
      const [history, board, rows, follows] = await Promise.all([
        /* 候选最多只出 PICK_LIMIT 条，所以历史也只取这么多（不必把 50 条流水全读回来） */
        listRecentHistory(PICK_LIMIT).catch(() => []),
        loadHotBoard().catch(() => []),
        listWatches().catch(() => []),
        listFollows().catch(() => [])
      ])
      const { keywords, persons } = splitWatches(rows)
      if (!shouldShowPick({ relations: follows.length + keywords.length + persons.length })) {
        setPick([])
        return
      }
      const cands = pickMonitorCandidates({
        history: history.map((h) => ({ personKey: h.person_key, name: h.name })),
        board,
        /* 已监控的人不再出现在候选里（再点一次是空操作，占了位置又点不动） */
        taken: persons.map((p) => p.person_key).filter((k): k is string => !!k)
      })
      /* 埋点只在**真的设入候选**这一刻（卡没显示就不该进分母）：S1-4 此前只有
         monitor_add 这一个分子，转化率算不出来 —— 理由见 utils/events#opinion_pick */
      if (cands.length > 0) {
        track('opinion_pick', {
          count: cands.length,
          history: cands.filter((c) => c.reason === 'history').length
        })
      }
      setPick(cands)
    } catch {
      /* 引导卡读不出来就不显示：它是锦上添花，绝不能因为它让页面出问题 */
      setPick([])
    }
  }, [])

  useDidShow(() => {
    void loadFeed()
    void loadWeekly()
    void loadAlertBlock()
    void loadEvents()
    void loadPick()
  })

  /**
   * 三块数据的**统一输入**（摊平后的原始条目）：统一队列与事件聚合共用同一份，
   * 从而「排序去重」与「事件时间线」看到的是同一批条目、走同一套判据（不会两处漂移）。
   * 输入里 `watchNames` = 关注的人 ∪ 监控的人 —— 两者都是用户主动盯上的对象（见 opinion-rank.ts）。
   */
  const opinionInput = useMemo<OpinionInput>(() => {
    const weeklyEntries =
      weekly.report?.persons?.flatMap((p) =>
        p.entries.map((it) => ({
          block: 'weekly' as const,
          title: it.title,
          source: it.source,
          date: it.publishedDate ?? '',
          person: p.name
        }))
      ) ?? []

    return {
      feed: feed.items.map((e) => ({
        block: 'feed' as const,
        title: e.title,
        source: e.source,
        date: e.date,
        person: e.personName,
        personKey: e.personKey,
        /* 条目级分级字段透传给判断层：有则参与分级，无（旧缓存 / 未命中词典）则维持未评级 */
        category: e.category,
        level: e.level
      })),
      weekly: weeklyEntries,
      alerts: [
        ...alerts.items.map((a) => ({
          block: 'alert' as const,
          title: a.title,
          source: a.source,
          date: a.date,
          timeBasis: a.timeBasis,
          keyword: a.keyword,
          /* 同上：关键词预警条目也带条目级分级字段（云端写入时补齐） */
          category: a.category,
          level: a.level
        })),
        ...alerts.riskRows.map((s) => ({
          block: 'alert' as const,
          title: s.title,
          source: s.source,
          /* 与云端同口径（opinionCluster#collectSources）：优先媒体发布时间 ——
             risk_signals 自 2026-10-16 起落 published_date（老行为空 → 退回 first_seen_at） */
          date: s.published_date ?? s.first_seen_at,
          /* 三元里的字面量会被推断成 string，必须窄化回 TimeBasis（同块上面那条走的是已知类型，故不用） */
          timeBasis: (s.published_date ? 'published' : 'seen') as TimeBasis,
          person: s.name,
          category: s.category,
          level: s.level
        }))
      ],
      keywords: alerts.keywords,
      watchNames: [...feed.followNames, ...alerts.personNames]
    }
  }, [feed.items, feed.followNames, weekly.report, alerts.items, alerts.riskRows, alerts.keywords, alerts.personNames])

  /** 统一队列：把三块数据合成一条排序好的列表（纯函数，脏数据自动跳过） */
  const queue = useMemo(() => buildOpinionQueue(opinionInput), [opinionInput])

  /**
   * 事件视角（P4，2026-10-13 性能调整）：**落库优先、端上聚类只作降级，且不在首屏并发做**。
   *
   *   1. 库里读完且有可用事件 → 直接用云端事件（全站共享、跨会话保留），**完全不做端上聚类**；
   *   2. 库读完但为空 / 读失败 / 行进不了（`toDisplayEvents` 过滤后为空）→ 才现算本端聚类；
   *   3. 库还没读完 → 先渲染空（**不并发聚类**）—— 聚类要遍历 feed/weekly/alert 多源、是首屏较重的
   *      计算，等一个「单集合只读」出结果远比它划算。
   *
   * 之前聚类写在一个无条件的 `useMemo(buildOpinionEvents, [opinionInput])`：首屏三块数据分批到达时
   * 它会随之重算数遍，**就算库里早有共享事件也照算不误** —— 这次把它移出渲染关键路径。
   * 「与我相关」排序所需的 hitsKeyword / hitsFollow 在读库路径上按本用户的词 / 关注的人现算
   * （见 utils/opinion-store.ts#toDisplayEvents）；两条路产出的事件字段完全一致，渲染零分叉。
   */
  const eventView = useMemo(() => {
    const opts = { keywords: opinionInput.keywords, watchNames: opinionInput.watchNames }
    if (storedReady && storedEvents && storedEvents.length > 0) {
      const cloud = resolveDisplayEvents(storedEvents, opts, [])
      if (cloud.source === 'cloud') return cloud
    }
    if (!storedReady) return { events: [] as OpinionEvent[], source: 'local' as const }
    return { events: buildOpinionEvents(opinionInput), source: 'local' as const }
  }, [storedReady, storedEvents, opinionInput])
  const events = eventView.events

  /** 今日要点：统一队列前 3 条（无来源 / 与我不相关的不凑数）—— 不受明细条数分层限制 */
  const focus = useMemo(() => pickDailyFocus(queue), [queue])

  /** 每日舆情简报（P10，2026-10-14）：统一队列的数字 + 图表聚合（纯函数，见 utils/opinion-brief.ts） */
  const brief = useMemo(() => buildDailyBrief(queue), [queue])

  /** 简报日期标签（本地当天，仅作展示，不参与任何判定） */
  const briefDate = useMemo(() => {
    const d = new Date()
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }, [])

  /**
   * 事件维度的「新」：复用 opinion_event_status.reads（已读且无新进展 → 不算新），
   * 与每张事件卡上的角标同源（utils/inbox#countNewEvents → opinion-store#eventNewness）。
   */
  const eventNew = useMemo(
    () => countNewEvents(events.map((e) => ({ key: e.key, at: e.date })), eventStatus),
    [events, eventStatus]
  )

  /**
   * 「我盯的（已跟进）里有多少条有新进展」（E1，2026-10-16）。
   *
   * 与上面那个角标**同源不同范围**：这个只数已跟进的事件，用来兑现「跟进 = 订阅」这件事
   * （云端日报也按同一判据提醒一次）。为什么不做成第三个角标颜色：跟进的语义是「我要知道后续」，
   * 而**有新进展 ≠ 我没读过** —— 它更像是给用户的一句提示，不参与首页入口的未读求和。
   */
  const followNew = useMemo(
    () => countFollowUpdates(events.map((e) => ({ key: e.key, at: e.date })), eventStatus),
    [events, eventStatus]
  )

  /**
   * 我盯的**全部**事件件数（含当前没有新进展的，2026-10-18）。
   *
   * 「我盯的 ›」入口的显示依据只能是它：只按 `followNew` 显示，会让「盯了 5 件、这几天都没动」
   * 的用户找不到入口 —— 而那正是最想回看的时候。判据与事件列表页的「我盯的」同一口径
   * （`eventStatus.follows` 有没有这个键）。
   */
  const followedCount = useMemo(
    () => events.filter((ev) => !!eventStatus.follows[ev.key]).length,
    [events, eventStatus]
  )

  /** 首页「舆情」入口角标口径：预警 + 风险 + 事件（关注动态归铃铛，见 utils/inbox 文件头） */
  const inboxTotal = alerts.newTotal + alerts.riskNew + eventNew

  /**
   * 页首「我的预警」格上的角标：只算预警 + 风险，**不含事件** ——
   * 事件未读在下方「事件时间线」卡头已经报过一次，同一页里报两遍会让人以为是两件事。
   */
  const monitorBadge = alerts.newTotal + alerts.riskNew

  /**
   * **三张概要卡**（事件 / 关注动态 / 关键词预警）都只给**固定预览**
   * （`overviewSlice`，条数 = `EVENT_OVERVIEW_INITIAL` = 3），**都不再页内「加载更多」** ——
   * 用户诉求是「不要在舆情台加载更多，改成点进独立页看」：
   *   · 数据多时三张卡的长度恒定（永远只 3 条），不会把页面撑长；
   *   · 要看全部 → 进独立页（事件 → pages/events，关注动态 → pages/feed，预警 → pages/alerts），
   *     入口统一在**卡头右上角**（同类名 `page-opinion__more`、同文案「查看全部 ›」），在那里分页加载。
   * 复用既有纯函数 `overviewSlice`（不另造切片），其 `remaining` / `hasMore` 在预览场景不使用。
   *
   * ⚠ **概要不分档**（P6）：三张卡对免费 / 会员**一视同仁**，「明细条数」这一层分层**不在本页体现**；
   *   分层其余部分仍生效（关注人数 / 监控数 / 风险监控人数上限；以及事件**时间线页**的明细门禁
   *   pages/event：免费 5 / 会员全部）。**本页不引入会员态变量**。
   */
  const eventPreview = overviewSlice(events, EVENT_OVERVIEW_INITIAL)

  const goFeed = () => void Taro.navigateTo({ url: '/package/feed/index' })
  const goWeekly = () => void Taro.navigateTo({ url: '/package/weekly/index' })
  const goAlerts = () => void Taro.navigateTo({ url: '/package/alerts/index' })
  /**
   * 监测工作台（2026-10-17 从「我的」迁来）：它回答的是**横向**问题 ——「我盯的几个人里谁在动、
   * 能不能放一起看」，而舆情页正是「我盯的东西怎么样了」的那一页；放在「我的」里等于把它
   * 归进了账号设置，用户找它要先想到「这是我的资料」。
   * ⚠ 纯入口，不预读人数：工作台进去自己读（与另外三格同一规矩，见下方 nav 注释）。
   */
  const goWorkbench = () => void Taro.navigateTo({ url: '/package/workbench/index' })
  /**
   * 事件卡**卡头右上角**「查看全部 ›」→ 事件列表页（2026-10-13）：本页只给固定预览，
   * 「看全部事件」挪到独立页分页加载（首屏第一页 + 触底追加），不再在本页越加载越长。
   * 入口位置与关注动态卡统一（同为卡头 `page-opinion__more`，不再放在卡底）。
   */
  const goEvents = () => void Taro.navigateTo({ url: '/package/events/index' })
  /**
   * 「我盯的 ›」/「盯的 N 条有新进展」→ 事件列表页的**聚合视图**（2026-10-18）。
   *
   * 带 `?only=follows`，进去只列已跟进的事件；每条仍整卡跳 `package/event`，那就是**完整事件线**。
   * 为什么不在舆情页内展开：本页只给固定预览（见上方三卡注释），而「完整时间线」的分层
   * （免费 5 / 会员全部）只作用在详情页 —— 在这里再渲染一份必然要与详情页漂移。
   */
  const goFollowedEvents = () => void Taro.navigateTo({ url: '/package/events/index?only=follows' })
  /** 名人主页（方案 A：今日要点 feed 条目精准跳转，与关注动态卡的整页跳转区分开） */
  const goProfile = (personKey: string) =>
    void Taro.navigateTo({ url: `/package/profile/index?personKey=${encodeURIComponent(personKey)}` })
  /**
   * 今日要点点进对应完整页 —— 同一套入口，不新增页面。
   * feed 条目若有稳定键（`personKey`）则**精准跳对应名人主页**（不再跳关注动态整页，
   * 与「关注动态」卡的去向区分开）；无键（旧缓存等）回落关注动态页；weekly / alert 照旧。
   */
  const goFocus = (e: OpinionEntry) => {
    if (e.block === 'feed') {
      if (e.personKey) goProfile(e.personKey)
      else goFeed()
    } else if (e.block === 'weekly') goWeekly()
    else goAlerts()
  }
  /**
   * 事件卡 → 独立的事件时间线页（P5，2026-10-13）：整卡跳转，**不再内联展开**。
   *
   * 为什么去掉内联展开：同一份时间线若在舆情页与时间线页各渲染一遍必然漂移（改一处忘另一处
   * 不会报错），且舆情页本身已经很长。参数带上定位该事件所需的 `eventKey`（稳定主题键）——
   * 时间线页据此在 `opinion_events` 里定位，定位不到再回落本端聚类。title 只为空态兜底展示。
   */
  const goEvent = (ev: OpinionEvent) =>
    void Taro.navigateTo({
      url: `/package/event/index?eventKey=${encodeURIComponent(ev.key)}&title=${encodeURIComponent(ev.title)}`
    })

  /**
   * 从冷启动推荐里建立监控（S1-4 / 决策 D2）。
   *
   * ⚠ **顺序是硬约束**：`monitorPerson` 内部第一条异步就是 `requestSubscribeMessage`（见 notify.ts），
   *   而微信只认「用户点击后的第一个异步调用」——所以这个处理函数里**除了同步的置忙标记，
   *   不许在它之前做任何 await**。多插一次 IO 就会让授权静默失败：监控建上了，却永远收不到推送。
   *   与报告页 / 名人主页那两个监控入口同一条约束（utils/risk-watch#monitorPerson 注释里有完整理由）。
   */
  const addPickMonitor = async (c: PickCandidate) => {
    if (pickingKey) return
    setPickingKey(c.personKey)
    setPickError('')
    const res = await monitorPerson(c.personKey, c.name, 'opinion')
    setPickingKey('')
    if (res.ok) {
      /* 摘掉这一行：同一个候选不再出现；摘完（或关掉）卡片自然收起 */
      setPick((list) => list.filter((x) => x.personKey !== c.personKey))
      /* 关系变了 → 简报四格与事件时间线的输入跟着变，立刻重读一次，否则数字要等下次进页面才更新 */
      void loadAlertBlock()
      Taro.showToast({ title: res.message, icon: 'success' })
      return
    }
    /* 失败一律**就地一行**（含 res.fatal 那种长文案）：本页不引入弹窗（形态锁见用例 29），
       而 toast 会把「集合没建 / 权限不对」这类修法截成半句，等于没说 —— 全文写在卡里最稳 */
    setPickError(res.message)
  }

  /** 关掉冷启动推荐：关一次永久不再出现（它是给新用户的引导，不是常驻推荐位） */
  const onDismissPick = () => {
    dismissPick()
    setPick([])
  }

  /**
   * 「标记已读」（P4）：沿用页面既有交互风格 —— 事件卡头部一个小文字按钮，不弹窗、不遮罩。
   * 乐观更新本地态，写库失败则回滚并轻提示；状态落在 opinion_event_status（跨会话 / 跨端生效）。
   */
  const markRead = async (key: string) => {
    if (eventStatus.reads[key]) return
    const now = new Date().toISOString()
    setEventStatus((s) => ({ ...s, reads: { ...s.reads, [key]: now } }))
    if (!(await markEventRead(key))) {
      setEventStatus((s) => {
        const reads = { ...s.reads }
        delete reads[key]
        return { ...s, reads }
      })
      Taro.showToast({ title: '标记失败，请重试', icon: 'none' })
    }
  }

  /** 「跟进 / 已跟进」切换（P4）：与标记已读同一套乐观更新 + 回滚，不弹窗 */
  const toggleFollow = async (key: string) => {
    const following = !!eventStatus.follows[key]
    const now = new Date().toISOString()
    setEventStatus((s) => {
      const follows = { ...s.follows }
      if (following) delete follows[key]
      else follows[key] = now
      return { ...s, follows }
    })
    if (!(await setEventFollow(key, !following))) {
      setEventStatus((s) => {
        const follows = { ...s.follows }
        if (following) follows[key] = now
        else delete follows[key]
        return { ...s, follows }
      })
      Taro.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  }

  /**
   * 「全部已读」：一次把站内三处未读清掉（预警 / 风险 / 事件）—— 推送没了之后的显式收口入口。
   *
   * 各模块沿用**各自既有的写入路径**，不新造一套「已读」（口径见 utils/inbox 文件头）：
   *   · 关键词预警 → 既有 markAllSeen（与预警页进入时的动作完全一致，只盖章关键词行）；
   *   · 风险信号 → 把本机基线 inbox:seen.risk 推进到当前时刻（唯一没有天然基线的模块）；
   *   · 舆情事件 → 把当前有角标的键**一次性**走 opinion_event_status.reads（复用 markEventsRead，
   *     不另立事件已读；与逐条「标记已读」同源，只是合成一次读-改-写）。
   *
   * ⚠ **已跟进的键不在此列**（E1，2026-10-16）：跟进的含义是「这件事的后续我要知道」，
   * 一键清屏把它一起抹掉，等于用户明确点过的那几件事反而最容易被清成「没事发生」——
   * 它们是云端日报的候选（见 notifyFollowUpdates），角标留着才对得上「我盯的 N 条有新进展」。
   * 想让角标消掉仍然做得到：进事件页点「标记已读」（单条路径不受影响）。
   *
   * 不做「关注动态」的已读：它的基线是每个人的 followed_at（关注那一刻），没有「清掉」的动作，
   * 且已由「消息中心（铃铛）」覆盖。完成后重读本块，让计数与库内状态对齐。
   */
  const markAllRead = async () => {
    /* 关键词预警：等待写库完成再重读，避免与 loadAlertBlock 抢跑导致「新」计数不归零 */
    if (alerts.keywords.length) await markAllSeen(alerts.keywords)
    /* 风险信号：推进本机基线（无写库） */
    markModuleSeen('risk')
    /* 事件：当前有角标（new / update）**且未跟进**的键一次性标已读，乐观更新本地态，失败回滚 */
    const newKeys = events
      .filter((ev) => !eventStatus.follows[ev.key])
      .filter((ev) => eventNewness({ event_key: ev.key, last_at: ev.date }, eventStatus) !== 'seen')
      .map((ev) => ev.key)
    if (newKeys.length) {
      const now = new Date().toISOString()
      setEventStatus((s) => {
        const reads = { ...s.reads }
        for (const k of newKeys) reads[k] = now
        return { ...s, reads }
      })
      if (!(await markEventsRead(newKeys))) {
        setEventStatus((s) => {
          const reads = { ...s.reads }
          for (const k of newKeys) delete reads[k]
          return { ...s, reads }
        })
        Taro.showToast({ title: '标记失败，请重试', icon: 'none' })
        return
      }
    }
    await loadAlertBlock()
    /* 已跟进的事件刻意留着角标（见上面的注释）：不把这件事说出来，用户会以为「按钮坏了」 */
    Taro.showToast({
      title: followNew > 0 ? `已读；跟进的 ${followNew} 条仍留着` : '已全部标为已读',
      icon: 'none'
    })
  }

  /** 分级标签行（影响面 / 可信度 / 是否需回应）的可复用渲染：单条与事件卡共用 */
  const tagsView = (impact: ImpactLevel, cred: CredTier, resp: ResponseNeed) => (
    <View className='page-opinion__tags'>
      <Text className={`page-opinion__tag page-opinion__tag--${impact}`}>{IMPACT_LABEL[impact]}</Text>
      <Text className={`page-opinion__tag page-opinion__tag--cred-${cred}`}>{CRED_LABEL[cred]}</Text>
      <Text className={`page-opinion__tag page-opinion__tag--${resp}`}>{RESPONSE_LABEL[resp]}</Text>
    </View>
  )

  /**
   * 单条的分级标签（影响面 / 可信度 / 是否需回应）。
   * feed 与关键词预警条目现在**可能**带条目级分级字段（命中风险词典时才有，见 cache.ts /
   * keywordAlert）；没有字段的（旧缓存 / 未命中）仍如实显示「未评级 / 未知」，不猜。
   */
  const gradeTags = (source: string, category?: RiskSignalRow['category'], level?: string) =>
    tagsView(impactOf(level), credibilityOf([source]), responseOf(category, level))

  return (
    <View className='page-opinion glow-page safe-tab'>
      <View className='page-opinion__hero'>
        <Text className='page-opinion__hero-title'>舆情台</Text>
        <View className='page-opinion__hero-row'>
          <Text className='page-opinion__hero-sub'>关注 · 周报 · 监控 · 台账，一处看全</Text>
          {/* 站内「全部已读」显式入口（推送没了之后的收口），只在确有未读时出现 */}
          {inboxTotal > 0 && (
            <Text className='page-opinion__read-all' onClick={() => void markAllRead()}>
              全部已读
            </Text>
          )}
        </View>
      </View>

      {/*
        ===== 入口区（2026-10-17 重排为 2×2 卡片）=====
        纯入口、不加载数据（进页面各自去读），仍挂在 `page-opinion__nav` / `page-opinion__nav-item`
        之下 —— 这两个类名被 25 / 36 / 39 / 59 四条用例钉住形态（页首、纯跳转、在推荐卡之前），
        重排只改**视觉**，不改这套语义。

        为什么从「三等分横排」改成 2×2：加了台账入口之后是四格，四等分在 375pt 屏上每格
        只剩约 80pt，「监控台账」五个字必然折行或缩字号。2×2 每格还有一行说明的位置 ——
        这四个入口名字（我的预警 / 监控台账 / 关注动态 / 本周周报）彼此**看不出区别**，
        光给名字的话用户得靠点进去试（所以每格都配了一行 hint）。

        排序不是随手拍：**第一行 = 我监控了谁**（我的预警是有未读角标的主入口、监控台账是它的表格视图），
        **第二行 = 他们出了什么**（关注动态是流水、本周周报是综述）。之前按「数据流」排，
        把最常点的入口压在了第三格。
      */}
      <View className='page-opinion__nav'>
        {/*
          我的预警（2026-10-18 二次改名，曾叫「监控」「预警工作台」）：这一格进去的是 package/alerts，
          页内三块分别是关键词监控 / 关注的对象 / 名人监控 —— 全部是「预警」性质。
          叫「预警工作台」时和右边那格「监控工作台」共用「工作台」，差异词又正好是
          「预警 / 监控」这对同源环节（监控产数据、预警展示数据），等于用同义词区分同义词。
          现在两格按**视图形态**命名（收件箱 / 表格），不再共用任何词，入口名与系统标题逐字一致。

          角标 = 关键词预警新 + 风险信号新（口径复用 inboxTotal 的那两项，**不含事件** ——
          事件未读已经显示在下方「事件时间线」卡头，同一页里报两遍会让人以为是两件事）。
          这两项都在 state 里，渲染零成本。
        */}
        <View className='page-opinion__nav-item' onClick={goAlerts}>
          <View className='page-opinion__nav-top'>
            <Text className='page-opinion__nav-icon'>🔔</Text>
            <Text className='page-opinion__nav-label'>我的预警</Text>
            {monitorBadge > 0 && <Text className='page-opinion__nav-badge'>{monitorBadge}</Text>}
            <Text className='page-opinion__nav-go'>›</Text>
          </View>
          <Text className='page-opinion__nav-hint'>关注对象 · 关键词 · 名人</Text>
        </View>

        <View className='page-opinion__nav-item' onClick={goWorkbench}>
          <View className='page-opinion__nav-top'>
            <Text className='page-opinion__nav-icon'>📊</Text>
            <Text className='page-opinion__nav-label'>监控台账</Text>
            <Text className='page-opinion__nav-go'>›</Text>
          </View>
          <Text className='page-opinion__nav-hint'>多人台账 · 勾选对比 · 导出</Text>
        </View>

        <View className='page-opinion__nav-item' onClick={goFeed}>
          <View className='page-opinion__nav-top'>
            <Text className='page-opinion__nav-icon'>📡</Text>
            <Text className='page-opinion__nav-label'>关注动态</Text>
            <Text className='page-opinion__nav-go'>›</Text>
          </View>
          <Text className='page-opinion__nav-hint'>关注的人有什么新东西</Text>
        </View>

        <View className='page-opinion__nav-item' onClick={goWeekly}>
          <View className='page-opinion__nav-top'>
            <Text className='page-opinion__nav-icon'>📰</Text>
            <Text className='page-opinion__nav-label'>本周周报</Text>
            <Text className='page-opinion__nav-go'>›</Text>
          </View>
          <Text className='page-opinion__nav-hint'>一周综述，本机缓存秒开</Text>
        </View>
      </View>

      {/* ===== 冷启动推荐（S1-4 / 决策 D2，2026-10-16）：只在新用户且没关过时出现 =====
          放在简报**之前**：新用户的简报四格全是 0，那一屏上唯一能做的事就是这张卡。
          为什么不直接替他建好监控 —— 见 utils/opinion-pick.ts 文件头（授权必须由点击触发、
          免费档只有 3 个额度、新用户没有个性化信号，三条任一条都足以否掉自动预置）。
          刻意另起 `page-opinion__pick*` 类名而不是复用 `page-opinion__more`：那个类名被用例
          钉死为「全页只剩事件卡一处」（36 / 39 用例），复用会把「查看全部 ›」的形态锁弄坏。 */}
      {pick.length > 0 && (
        <View className='card page-opinion__pick'>
          <View className='page-opinion__head'>
            <View className='page-opinion__head-main'>
              <Text className='page-opinion__head-title'>👀 先关注几个人</Text>
            </View>
            {/* 关掉就永久不再出现：一次明确的拒绝不该被问第二遍（见 utils/opinion-pick#dismissPick） */}
            <Text className='page-opinion__pick-close' onClick={onDismissPick}>
              不用了
            </Text>
          </View>

          {/* 来源与代价都写在点击**之前**：这几个人是谁挑的、点下去会花掉什么（两个 note 都是纯函数） */}
          <Text className='page-opinion__pick-note'>
            {pickSourceNote(pick)}。{pickCostNote()}
          </Text>

          <View className='page-opinion__pick-list'>
            {pick.map((c) => (
              <View key={c.personKey} className='page-opinion__pick-row'>
                <View className='page-opinion__pick-main' onClick={() => void goProfile(c.personKey)}>
                  <Text className='page-opinion__pick-name'>{c.name}</Text>
                  <Text className='page-opinion__pick-meta'>
                    {[domainLabel(c.domain), c.reason === 'history' ? '你查过' : '热门'].join(' · ')}
                  </Text>
                </View>
                <Text
                  className={`page-opinion__pick-add${
                    pickingKey === c.personKey ? ' page-opinion__pick-add--busy' : ''
                  }`}
                  onClick={() => void addPickMonitor(c)}
                >
                  {pickingKey === c.personKey ? '处理中…' : '＋ 监控'}
                </Text>
              </View>
            ))}
          </View>

          {/* 出口：不想用推荐的人也要有下一步（这几个人是平台挑的，用户完全有理由全都不认） */}
          <Text className='page-opinion__pick-note'>也可以直接去首页搜你想关注的人。</Text>

          {/* 建立失败就地一行（全文，不截断）：本页不引入弹窗，toast 又会把修法截成半句 */}
          {!!pickError && (
            <Text className='page-opinion__pick-note page-opinion__pick-note--error'>{pickError}</Text>
          )}
        </View>
      )}

      {/* ===== 每日舆情简报（P10，2026-10-14）：数字 + CSS 图表，纯前端聚合、不新增模型调用 ===== */}
      <View className='card page-opinion__brief'>
        <View className='page-opinion__head'>
          <Text className='page-opinion__head-title'>📊 每日舆情简报</Text>
          <Text className='page-opinion__brief-date'>{briefDate}</Text>
        </View>

        {/* 规模四格：关注 / 监控词 / 动态 / 风险信号 */}
        <View className='page-opinion__brief-stats'>
          <View className='page-opinion__brief-stat'>
            <Text className='page-opinion__brief-stat-value'>{feed.followNames.length}</Text>
            <Text className='page-opinion__brief-stat-label'>关注</Text>
          </View>
          <View className='page-opinion__brief-stat'>
            <Text className='page-opinion__brief-stat-value'>{alerts.keywords.length}</Text>
            <Text className='page-opinion__brief-stat-label'>监控词</Text>
          </View>
          <View className='page-opinion__brief-stat'>
            <Text className='page-opinion__brief-stat-value'>{brief.total}</Text>
            <Text className='page-opinion__brief-stat-label'>动态</Text>
          </View>
          <View className='page-opinion__brief-stat'>
            <Text className='page-opinion__brief-stat-value'>{brief.riskCount}</Text>
            <Text className='page-opinion__brief-stat-label'>风险信号</Text>
          </View>
        </View>

        {/* 风险类别分布：横向条形图（条形宽度按相对最大值换算） */}
        {brief.categories.length > 0 && (
          <View className='page-opinion__brief-block'>
            <Text className='page-opinion__brief-block-title'>风险类别分布</Text>
            <View className='page-opinion__brief-bars'>
              {brief.categories.map((b) => (
                <View key={b.key} className='page-opinion__brief-bar'>
                  <Text className='page-opinion__brief-bar-label'>{b.label}</Text>
                  <View className='page-opinion__brief-bar-track'>
                    <View
                      className={`page-opinion__brief-bar-fill page-opinion__brief-bar-fill--${b.key}`}
                      style={{ width: `${Math.round(b.ratio * 100)}%` }}
                    />
                  </View>
                  <Text className='page-opinion__brief-bar-count'>{b.count}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* 影响面：柱状图（柱高按相对最大值换算） */}
        {brief.impacts.length > 0 && (
          <View className='page-opinion__brief-block'>
            <Text className='page-opinion__brief-block-title'>影响面</Text>
            <View className='page-opinion__brief-cols'>
              {brief.impacts.map((b) => (
                <View key={b.key} className='page-opinion__brief-col'>
                  <Text className='page-opinion__brief-col-count'>{b.count}</Text>
                  <View className='page-opinion__brief-col-track'>
                    <View
                      className={`page-opinion__brief-col-fill page-opinion__brief-col-fill--${b.key}`}
                      style={{ height: `${Math.round(b.ratio * 100)}%` }}
                    />
                  </View>
                  <Text className='page-opinion__brief-col-label'>{b.label}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* 建议回应 / 建议关注：有行动价值的条目单独拎出来 */}
        {(brief.respondCount > 0 || brief.watchCount > 0) && (
          <View className='page-opinion__brief-actions'>
            <Text className='page-opinion__brief-action page-opinion__brief-action--respond'>
              建议回应 {brief.respondCount}
            </Text>
            <Text className='page-opinion__brief-action page-opinion__brief-action--watch'>
              建议关注 {brief.watchCount}
            </Text>
          </View>
        )}

        <Text className='page-opinion__note'>分级来自报道里出现的表述类别，不是平台定性</Text>
      </View>

      {/* ===== 今日要点（判断入口，置于三个入口按钮之后） ===== */}
      <View className='card page-opinion__focus'>
        <View className='page-opinion__head'>
          <Text className='page-opinion__head-title'>
            {focus.length > 0 ? `🎯 今日需要注意的 ${focus.length} 件事` : '🎯 今日需要注意的事'}
          </Text>
        </View>

        {focus.length === 0 ? (
          <Text className='page-opinion__empty'>今天没有需要你特别留意的事</Text>
        ) : (
          focus.map((e) => (
            <View key={e.id} className='page-opinion__row' onClick={() => goFocus(e)}>
              <Text className='page-opinion__row-title'>{e.title}</Text>
              <Text className='page-opinion__row-meta'>
                {[e.label, e.source || '来源未标注', e.date ? formatMoment8(e.date) : '', e.reason]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {gradeTags(e.source, e.category, e.level)}
            </View>
          ))
        )}

        <Text className='page-opinion__note'>
          以上均为公开报道的转载与检索结果，不是平台对任何人、任何事的定性；分级来自报道里出现的表述类别。
        </Text>
      </View>

      {/* ===== 事件时间线（P3/P5：同一事件的多来源聚合；整卡跳转独立时间线页） ===== */}
      <View className='card page-opinion__events'>
        {/*
          卡头重排（2026-10-18）：一行只留「标题 + 一个角标」。
          原先这里是四件东西挤在同一行 —— 标题、`新 N 条`、`盯的 N 条有新进展 ›`、以及右侧
          两个文字按钮（`我盯的 ›` / `查看全部 ›`）—— 总宽超过 690rpx 的可排宽度，而
          `__head-main` 是 nowrap 的 flex，flex 只会**压缩**子元素、不会换行，于是
          最长的那个角标里的字被压成两行、卡头整体变形（`.count-badge` 还是固定 36rpx 高，
          两行字会直接溢出圆底）。
          现在按「一行说是什么、一行说能点什么」重新分层：需要数字的长入口下沉到第二行
          （见下方 `__head-sub`），宽度充裕后既不用缩字也不会折行。
        */}
        <View className='page-opinion__head'>
          <View className='page-opinion__head-main'>
            <Text className='page-opinion__head-title'>🧩 事件时间线</Text>
            {/* 「新 N 条」：口径来自 utils/inbox#countNewEvents（复用 opinion_event_status.reads） */}
            {eventNew > 0 && <Text className='count-badge'>新 {eventNew} 条</Text>}
          </View>
          {/* 卡头右上角文字按钮（同类名 `page-opinion__more`），跳独立的事件列表页 pages/events。 */}
          <Text className='page-opinion__more' onClick={goEvents}>
            查看全部 ›
          </Text>
        </View>

        {/*
          第二行：可点入口（2026-10-18）。两个都是「带数字的长短语」，与标题同排必然把角标挤变形；
          下沉一行后仍有 `flex-wrap` 兜底 —— 小屏（iPhone SE 一档）或超大字号下自动折行，
          而不是把字压扁。
          · 「我盯的 N」= 我盯的**全部**事件件数（不一定有新进展，见 followedCount 注释），
            换成图标胶囊：星形是「我盯的」这类收藏关系的通用语汇，比三个字更省宽度；
          · 「盯的 N 条有新进展」= 口径来自 utils/inbox#countFollowUpdates（只数已跟进的，
            它们不会被「全部已读」清掉，见 markAllRead 与 opinion-store 文件头）。
          两者都跳事件列表页的「我盯的」聚合视图（?only=follows），只是后者强调「有动静」。
          `page-opinion__mine` / `page-opinion__follow-jump` 两个类名保持不变：36 / 38 / 39 / 59
          几条用例按类名钉住「全页只剩事件卡一处」，改名或复用会让形态锁失效。
        */}
        {(followedCount > 0 || followNew > 0) && (
          <View className='page-opinion__head-sub'>
            {followedCount > 0 && (
              <Text className='page-opinion__mine' onClick={goFollowedEvents}>
                <Text className='page-opinion__mine-icon'>★</Text>
                {`我跟进的 ${followedCount}`}
              </Text>
            )}
            {followNew > 0 && (
              <Text className='page-opinion__follow-jump' onClick={goFollowedEvents}>
                <Text className='page-opinion__follow-dot'>●</Text>
                {`跟进的 ${followNew} 条有新进展 ›`}
              </Text>
            )}
          </View>
        )}

        {events.length === 0 ? (
          <Text className='page-opinion__empty'>
            {/* 落库事件还没读完（`!storedReady`）时也算「进行中」—— 此时不该显示成「暂无可归并的事件」 */}
            {!storedReady || feed.status === 'loading' || weekly.status === 'loading' || alerts.status === 'loading'
              ? '正在归并事件…'
              : '暂无可归并的事件，关注的人或监控词有新动态时会聚在这里'}
          </Text>
        ) : (
          <>
            {eventPreview.rows.map((ev) => {
              /* 「新事件」角标：没读过 → NEW；读过但最近有报道 → 有新进展（规则见 opinion-store） */
              const newness = eventNewness({ event_key: ev.key, last_at: ev.date }, eventStatus)
              const badge = newnessLabel(newness)
              const read = !!eventStatus.reads[ev.key]
              const following = !!eventStatus.follows[ev.key]
              return (
                /* 整卡跳转到事件时间线页（P5）：不再内联展开。已读 / 跟进按钮 stopPropagation，
                   避免点它们时被整卡的手势一起带走 */
                <View key={ev.key} className='page-opinion__event' onClick={() => goEvent(ev)}>
                  <View className='page-opinion__event-head'>
                    <View className='page-opinion__event-title'>
                      <Text className='page-opinion__row-title'>{ev.title}</Text>
                      {badge ? (
                        <Text className={`page-opinion__badge page-opinion__badge--${newness}`}>{badge}</Text>
                      ) : null}
                    </View>
                    <Text className='page-opinion__row-meta'>
                      {[
                        `${ev.memberTotal} 条来源`,
                        ev.labels.length ? ev.labels.join('、') : '',
                        ev.date ? `最近 ${formatMoment8(ev.date)}` : '',
                        `${ev.timeline.length} 个节点`
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    {tagsView(ev.impact, ev.credibility, ev.response)}
                    {/* 已读 / 跟进：克制的两个小文字按钮，不用弹窗、不遮罩（stopPropagation 防止触发整卡跳转） */}
                    <View className='page-opinion__event-actions'>
                      <Text
                        className={`page-opinion__action${read ? ' page-opinion__action--on' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          void markRead(ev.key)
                        }}
                      >
                        {read ? '✓ 已读' : '标记已读'}
                      </Text>
                      <Text
                        className={`page-opinion__action${following ? ' page-opinion__action--on' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          void toggleFollow(ev.key)
                        }}
                      >
                        {following ? '★ 已跟进' : '☆ 跟进'}
                      </Text>
                      <Text className='page-opinion__event-go'>查看完整时间线 ›</Text>
                    </View>
                  </View>
                </View>
              )
            })}
            {/* 事件卡不再页内「加载更多」，也**不在卡底放入口**（2026-10-13）：只给固定预览（`eventPreview`），
                「查看全部」在**卡头右上角**（见上面的 page-opinion__more）；头部标题已给出事件总数
                （不让人以为只有首屏这几条）。 */}
          </>
        )}

        {/* 降级提示：云端事件库还没产出（或读失败）时，如实说明是本机临时归并（不遮不弹） */}
        {eventView.source === 'local' && events.length > 0 && (
          <Text className='page-opinion__note'>云端事件库暂未产出，以上为本机临时归并（稍后自动切换为共享事件）。</Text>
        )}

        <Text className='page-opinion__note'>
          把多条报道归到同一件事只是为了方便阅读，不代表平台已核实任何事实：每条都带来源与时间，
          「官方通报」与「媒体报道」分别标注，聚合本身不等于认定。
        </Text>
      </View>

    </View>
  )
}
