import { useCallback, useMemo, useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { listFollows } from '@/utils/follows'
import { getFeedDetails } from '@/utils/cache'
import { MATERIAL_FAIL_TEXT, WEEKLY_WINDOW_DAYS, collectWeeklyMaterial, readWeeklyCache } from '@/utils/weekly'
import type { WeeklyReport } from '@/utils/weekly'
import { loadAlerts, listWatches, markAllSeen, splitWatches } from '@/utils/keyword-alert'
import { groupSignals, loadRiskSignals } from '@/utils/risk-watch'
import { loadFollowWatches } from '@/utils/watch'
import {
  alertNewCount,
  countNewEvents,
  feedNewCount,
  markModuleSeen,
  readInboxSeen,
  riskNewCount
} from '@/utils/inbox'
import { EVENT_OVERVIEW_BATCH, EVENT_OVERVIEW_INITIAL, overviewSlice } from '@/utils/opinion-access'
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
import type { CredTier, ImpactLevel, OpinionBlock, OpinionInput, ResponseNeed } from '@/utils/opinion-rank'
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
import { formatMoment8, fromNow } from '@/utils/time'
import { useTabBarSync } from '@/utils/tabbar'
import './index.scss'

/**
 * 舆情页（底部菜单第三格「盯」，2026-10-13 新增）。
 *
 * 三块原本是首页问候区右侧的三个图标入口，各自跳一个二级页；它们其实是同一件事的三种
 * 切法（都在回答「我关注的东西最近怎么样了」），散在首页既占位又要逐个点开。这里收成一格：
 * 每块给概要 + 「查看全部」，先看概况、要看细节再进完整页。
 *
 * 数据层全部复用既有 utils（follows / cache / weekly / keyword-alert / risk-watch），
 * 不新增集合、不改云函数；每块各自 try/catch，**一块读失败只降级那一块**，不拖垮整页。
 *
 * P1（2026-10-13）：页首新增「今日需要注意的 N 件事」——判断入口。判断规则（分级 / 排序 /
 * 去重 / 挑要点）全在纯函数 utils/opinion-rank.ts 里，本页只负责取数与渲染。
 *
 * P3（2026-10-13）：新增「事件时间线」视角 —— 把同一件事的多条来源聚成一条。
 * 聚类与归因同样是纯函数（utils/opinion-events.ts，复用 P1 的 sameEvent / normalizeTitle 判据），
 * 本页只负责渲染事件卡列表。**聚合 ≠ 认定**：事件卡区保留一句克制的轻量说明。
 *
 * P5（2026-10-13）：事件卡改为**整卡跳转**到独立的事件时间线页（pages/event），**不再内联展开** ——
 * 同一份时间线在两处各渲染一遍必然漂移，且本页已经很长。跳转带上 event_key（稳定主题键）。
 *
 * ⚠ 合规红线（本页同样适用，见 utils/opinion-rank.ts 与 utils/opinion-events.ts 文件头）：
 *   · 涉政涉军仍是拒答 —— 本页只重排 / 归拢**已过滤**的存量条目，不新增任何内容来源；
 *   · 每条必带来源与时间，无来源的不进「今日要点」与事件时间线（显示为「来源未标注」而不是编一个）；
 *   · 分级标签来自「报道里出现的表述类别」，不是平台对人和事的定性（页面底部有免责说明）。
 *
 * 刻意不做的事：不在这里调 generateWeekly（生成要花额度且需用户确认，交给完整页）；
 * **进入本页不会自动 markAllSeen**（若进页即盖章，完整页里那批「新」就凭空消失了）——
 * 只有在用户显式点页首的「全部已读」时才盖章（那是「我要清掉站内未读」的主动意图）。
 *
 * 站内触达收口（2026-10-13）：本页三块的「新 N 条」角标统一走 utils/inbox 的纯函数口径
 * （关注动态 = 有变化的人数、关键词预警 = 各词新增之和、事件 = 复用 reads 的新事件数），
 * 并提供页首「全部已读」一次清掉预警 / 风险 / 事件三处站内未读。口径与各模块既有基线同源，
 * 不新造一套互相冲突的机制（详见 utils/inbox.ts 文件头）。
 */

/**
 * P6（2026-10-13）**口径修正 —— 概要不分档**：本页三张**概要卡**（事件 / 关注动态 / 关键词预警）
 * 统一为「固定首屏 + 按需加载」（`utils/opinion-access.ts#overviewSlice`），**不再按会员档放全**。
 *
 * ⚠ 本页因此**不再**用 `sliceDetail` 渲染任何列表，「明细条数」这一层分层**在舆情页上不再体现**；
 *   分层的其余部分仍生效、且**不在本页**：关注人数 / 关键词监控数 / 风险监控人数上限（P2 门禁，
 *   落在各自新增入口），以及事件**时间线页**的明细门禁（pages/event：免费 5 / 会员全部）。
 *   ⚠ 「今日要点」卡（①）本就不受分层限制 —— 它最多 3 条（utils/opinion-rank.ts#DAILY_FOCUS_MAX），
 *     是留存钩子，免费用户照常看到。
 *
 * P7（2026-10-13）**两张卡去掉页内「加载更多」，改为入口**：
 *   · **事件卡（②）**：保留固定预览（`EVENT_OVERVIEW_INITIAL` = 3 条），**移除卡内「加载更多 / 到底」**，
 *     卡底新增「查看全部事件 ›」→ 新的事件列表页 `pages/events`（那里分页加载：首屏第一页 + 触底追加）；
 *     每条事件仍可整卡点进单事件时间线页 `pages/event`（`goEvent` 行为不变）。
 *   · **关注动态卡（③）**：同样固定预览 3 条、**移除「加载更多」**；「看全部」由卡头既有的
 *     「查看全部 ›」承担（→ 已存在的 `pages/feed`，不再新增第二个入口）。
 *   · **关键词预警卡（⑤）本次不动**：仍保留页内「加载更多」（用户只点名了上面两处）。
 *   这样两张卡在数据很多时**长度恒定**，不会把舆情页撑长（正是用户诉求）。
 */
type Status = 'loading' | 'ready' | 'error'

interface FeedPreview {
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
  /** 条目级分级字段（云端 keywordAlert 写入 keywords.items 时补齐；未命中 / 旧缓存则无） */
  category?: RiskCategory
  level?: string
}

interface FeedState {
  status: Status
  followCount: number
  entryCount: number
  failedCount: number
  /** 自上次查看以来有变化的关注对象数（口径走 utils/inbox#feedNewCount，即每个人的 hasNew） */
  newCount: number
  /** 全部归并后的动态（统一队列取全量；本块按会员态截断展示） */
  items: FeedPreview[]
  /** 关注的人名（「与我相关」排序用） */
  followNames: string[]
}

interface WeeklyState {
  status: Status
  report: WeeklyReport | null
  /** 无缓存时的可得性（来自零成本的 collectWeeklyMaterial）；report 非空时为 null */
  materialKind: 'ok' | 'nologin' | 'nofollow' | 'nomaterial' | null
  materialCount: number
}

interface AlertState {
  status: Status
  keywordCount: number
  personCount: number
  newTotal: number
  /** 风险信号里自上次查看以来的新增条数（口径走 utils/inbox#riskNewCount，基线是本机 inbox:seen.risk） */
  riskNew: number
  riskCount: number
  /** 关键词预警条目（全量；本块按会员态截断展示） */
  items: AlertPreview[]
  /** 风险信号原文（参与统一队列分级；本块只统计条数） */
  riskRows: RiskSignalRow[]
  /** 监控中的关键词原文（「与我相关」排序用） */
  keywords: string[]
  /** 监控中的名人名（「与我相关」排序用；与关注的人合并） */
  personNames: string[]
}

/** 周报未生成时的状态文案：先说有没有可汇总的材料，再给出下一步 */
function weeklyStatusText(kind: WeeklyState['materialKind'], count: number): string {
  if (kind === 'ok') return `关注的人近 ${WEEKLY_WINDOW_DAYS} 天有 ${count} 条动态可汇总，去完整页生成`
  if (kind && kind !== 'ok') return MATERIAL_FAIL_TEXT[kind]
  return `本周还没生成周报，去完整页看看（汇总最近 ${WEEKLY_WINDOW_DAYS} 天关注动态）`
}

export default function Opinion() {
  useTabBarSync()

  const [feed, setFeed] = useState<FeedState>({
    status: 'loading',
    followCount: 0,
    entryCount: 0,
    failedCount: 0,
    newCount: 0,
    items: [],
    followNames: []
  })
  const [weekly, setWeekly] = useState<WeeklyState>({
    status: 'loading',
    report: null,
    materialKind: null,
    materialCount: 0
  })
  const [alerts, setAlerts] = useState<AlertState>({
    status: 'loading',
    keywordCount: 0,
    personCount: 0,
    newTotal: 0,
    riskNew: 0,
    riskCount: 0,
    items: [],
    riskRows: [],
    keywords: [],
    personNames: []
  })
  /**
   * **关键词预警卡**已渲染到第几条（P6 / 2026-10-13，端上分片渲染）：首屏固定
   * `EVENT_OVERVIEW_INITIAL` 条，「加载更多」每次 +`EVENT_OVERVIEW_BATCH`。
   * ⚠ 与会员态**无关** —— 该卡走「概要不分档」（见下方 alertSlice 注释）。
   *
   * 2026-10-13 二次调整：**事件卡与关注动态卡不再在页内「加载更多」**（否则内容越加载页越长，
   * 这正是本次要修的问题）—— 两卡改为**固定 `EVENT_OVERVIEW_INITIAL` 条预览 + 入口跳独立页**
   * （事件 → pages/events、关注动态 → pages/feed，后者复用卡头既有的「查看全部 ›」，不新增第二个入口）。
   * 只有关键词预警卡仍保留页内按需加载（用户未点名它）。
   */
  const [alertShownCount, setAlertShownCount] = useState(EVENT_OVERVIEW_INITIAL)
  /**
   * 落库事件（P4）：`null` = 还没读到 / 读失败（回落本端聚类）；`[]` = 集合为空（同样回落）。
   * 刻意不用页面的 `Status` 表达它 —— 它本就不算「一块读失败」：读不到就走本端聚类，用户无感，
   * 也不该多出第四处 `status:'error'`（那会让「每块独立降级」的既有断言失真）。
   */
  const [storedEvents, setStoredEvents] = useState<OpinionEventRow[] | null>(null)
  /** 我的事件状态（已读 / 跟进）；读失败 = 空状态（页面照常，只是显示为「都没读过」） */
  const [eventStatus, setEventStatus] = useState<EventStatus>(emptyStatus())

  /** 关注动态概要：批量读缓存（与关注流页同一入口），归并后取最近若干条 */
  const loadFeed = useCallback(async () => {
    setFeed((s) => ({ ...s, status: 'loading' }))
    try {
      const rows = await listFollows()
      /* 动态缓存与实际内容并发读；watch 带 60s 内存缓存（与关注流 / 消息中心共享），
         这里只为拿到「自上次查看以来有变化的人数」，口径与关注列页完全一致（utils/inbox#feedNewCount） */
      const [details, watches] = await Promise.all([
        getFeedDetails(rows.map((f) => f.person_key)),
        loadFollowWatches(rows)
      ])
      const merged: FeedPreview[] = []
      let failed = 0
      for (const f of rows) {
        const detail = details.get(f.person_key)
        if (!detail || !detail.ok) failed++
        const parsed = parsePersonKey(f.person_key)
        for (const it of detail?.items ?? []) {
          merged.push({
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
        followCount: rows.length,
        entryCount: merged.length,
        failedCount: failed,
        newCount: feedNewCount(watches),
        items: merged,
        followNames: rows.map((r) => r.name)
      })
    } catch {
      setFeed((s) => ({ ...s, status: 'error' }))
    }
  }, [])

  /** 周报概要：先读本机缓存（零成本）；没有缓存再问一次材料可得性（同样零成本） */
  const loadWeekly = useCallback(async () => {
    setWeekly((s) => ({ ...s, status: 'loading' }))
    try {
      const cached = readWeeklyCache()
      if (cached) {
        setWeekly({ status: 'ready', report: cached, materialKind: null, materialCount: cached.entryCount })
        return
      }
      const mat = await collectWeeklyMaterial()
      setWeekly({
        status: 'ready',
        report: null,
        materialKind: mat.kind,
        materialCount: mat.kind === 'ok' ? mat.material.entryCount : 0
      })
    } catch {
      setWeekly((s) => ({ ...s, status: 'error' }))
    }
  }, [])

  /** 预警概要：关键词订阅 + 预警分组 + 名人风险信号，全部只读 */
  const loadAlertBlock = useCallback(async () => {
    setAlerts((s) => ({ ...s, status: 'loading' }))
    try {
      /* 与预警页同一套读法：一次 listWatches 拿到全部行，再拆成关键词 / 监控人两类 */
      const [rows, res] = await Promise.all([listWatches(), loadAlerts()])
      const { keywords, persons } = splitWatches(rows)

      const items: AlertPreview[] = []
      for (const g of res.groups) {
        for (const it of g.items) {
          items.push({
            keyword: g.keyword,
            title: it.title,
            source: it.source,
            date: it.published_date ?? it.first_seen_at ?? '',
            /* 条目级字段（云端写入缓存时命中词典才有；旧缓存没有 = 保持未评级） */
            category: it.category,
            level: it.level
          })
        }
      }

      const keys = persons.map((p) => p.person_key).filter((k): k is string => !!k)
      const riskRows = await loadRiskSignals(keys)

      setAlerts({
        status: 'ready',
        keywordCount: keywords.length,
        personCount: persons.length,
        /* 关键词预警口径走 utils/inbox#alertNewCount（等价于各词 newCount 之和，基线是每个词的 seen_at） */
        newTotal: alertNewCount(res.groups),
        /* 风险信号没有天然基线，走本机 inbox:seen.risk（见 utils/inbox 文件头） */
        riskNew: riskNewCount(riskRows, readInboxSeen().risk),
        riskCount: groupSignals(riskRows).reduce((n, g) => n + g.signals.length, 0),
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
   * 落库事件 + 我的状态（P4）：各自独立 try/catch。
   * 事件读不到 → 存 `null`（回落本端聚类）；状态读不到 → 空状态。两者都不阻断页面。
   */
  const loadEvents = useCallback(async () => {
    try {
      setStoredEvents(await loadStoredEvents())
    } catch {
      setStoredEvents(null)
    }
    try {
      setEventStatus(await loadEventStatus())
    } catch {
      setEventStatus(emptyStatus())
    }
  }, [])

  useDidShow(() => {
    void loadFeed()
    void loadWeekly()
    void loadAlertBlock()
    void loadEvents()
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
          keyword: a.keyword,
          /* 同上：关键词预警条目也带条目级分级字段（云端写入时补齐） */
          category: a.category,
          level: a.level
        })),
        ...alerts.riskRows.map((s) => ({
          block: 'alert' as const,
          title: s.title,
          source: s.source,
          date: s.first_seen_at,
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

  /** 本端聚类（纯函数）：库未就绪 / 读失败时的**降级**结果，复用 P1 判据与排序 */
  const localEvents = useMemo(() => buildOpinionEvents(opinionInput), [opinionInput])

  /**
   * 事件视角（P4）：**优先读落库事件**（全站共享、跨会话保留），读库失败 / 集合为空则回落本端聚类。
   * 「与我相关」排序所需的 hitsKeyword / hitsFollow 在读库路径上按本用户的词 / 关注的人现算
   * （见 utils/opinion-store.ts#toDisplayEvents）；两条路产出的事件字段完全一致，渲染零分叉。
   */
  const eventView = useMemo(
    () =>
      resolveDisplayEvents(
        storedEvents,
        { keywords: opinionInput.keywords, watchNames: opinionInput.watchNames },
        localEvents
      ),
    [storedEvents, opinionInput.keywords, opinionInput.watchNames, localEvents]
  )
  const events = eventView.events

  /** 今日要点：统一队列前 3 条（无来源 / 与我不相关的不凑数）—— 不受明细条数分层限制 */
  const focus = useMemo(() => pickDailyFocus(queue), [queue])

  /**
   * 事件维度的「新」：复用 opinion_event_status.reads（已读且无新进展 → 不算新），
   * 与每张事件卡上的角标同源（utils/inbox#countNewEvents → opinion-store#eventNewness）。
   */
  const eventNew = useMemo(
    () => countNewEvents(events.map((e) => ({ key: e.key, at: e.date })), eventStatus),
    [events, eventStatus]
  )

  /** 首页「舆情」入口角标口径：预警 + 风险 + 事件（关注动态归铃铛，见 utils/inbox 文件头） */
  const inboxTotal = alerts.newTotal + alerts.riskNew + eventNew

  /**
   * **事件卡 / 关注动态卡**只给**固定预览**（`overviewSlice`，条数 = `EVENT_OVERVIEW_INITIAL`），
   * **不再页内「加载更多」** —— 用户诉求是「不要在舆情台加载更多，改成点进独立页看」：
   *   · 数据多时这两张卡的长度恒定（永远只 3 条），不会把页面撑长；
   *   · 要看全部 → 进独立页（事件 → pages/events，关注动态 → pages/feed），在那里分页加载。
   * 复用既有纯函数 `overviewSlice`（不另造切片），其 `remaining` / `hasMore` 在预览场景不使用。
   *
   * **关键词预警卡**仍走「固定首屏 + 页内按需加载」（`alertShownCount` + `EVENT_OVERVIEW_BATCH`）——
   * 用户本次只点名了事件卡与关注动态卡，未要求改它。
   *
   * ⚠ **概要不分档**（P6）：三张卡对免费 / 会员**一视同仁**，「明细条数」这一层分层**不在本页体现**；
   *   分层其余部分仍生效（关注人数 / 监控数 / 风险监控人数上限；以及事件**时间线页**的明细门禁
   *   pages/event：免费 5 / 会员全部）。**本页不引入会员态变量**。
   */
  const eventPreview = overviewSlice(events, EVENT_OVERVIEW_INITIAL)
  const feedPreview = overviewSlice(feed.items, EVENT_OVERVIEW_INITIAL)
  const alertSlice = overviewSlice(alerts.items, alertShownCount)
  const loadMoreAlerts = () => setAlertShownCount((n) => n + EVENT_OVERVIEW_BATCH)

  const goFeed = () => void Taro.navigateTo({ url: '/pages/feed/index' })
  const goWeekly = () => void Taro.navigateTo({ url: '/pages/weekly/index' })
  const goAlerts = () => void Taro.navigateTo({ url: '/pages/alerts/index' })
  /**
   * 事件卡底「查看全部事件 ›」→ 事件列表页（2026-10-13 新增）：本页只给固定预览，
   * 「看全部事件」挪到独立页分页加载（首屏第一页 + 触底追加），不再在本页越加载越长。
   */
  const goEvents = () => void Taro.navigateTo({ url: '/pages/events/index' })
  /** 今日要点点进对应完整页 —— 同一套入口，不新增页面 */
  const goBlock = (block: OpinionBlock) => {
    if (block === 'feed') goFeed()
    else if (block === 'weekly') goWeekly()
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
      url: `/pages/event/index?eventKey=${encodeURIComponent(ev.key)}&title=${encodeURIComponent(ev.title)}`
    })

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
   * 不做「关注动态」的已读：它的基线是每个人的 followed_at（关注那一刻），没有「清掉」的动作，
   * 且已由「消息中心（铃铛）」覆盖。完成后重读本块，让计数与库内状态对齐。
   */
  const markAllRead = async () => {
    /* 关键词预警：等待写库完成再重读，避免与 loadAlertBlock 抢跑导致「新」计数不归零 */
    if (alerts.keywords.length) await markAllSeen(alerts.keywords)
    /* 风险信号：推进本机基线（无写库） */
    markModuleSeen('risk')
    /* 事件：当前有角标（new / update）的键一次性标已读，乐观更新本地态，失败回滚 */
    const newKeys = events
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
    Taro.showToast({ title: '已全部标为已读', icon: 'none' })
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
          <Text className='page-opinion__hero-sub'>关注的人 · 本周周报 · 关键词预警，一处看全</Text>
          {/* 站内「全部已读」显式入口（推送没了之后的收口），只在确有未读时出现 */}
          {inboxTotal > 0 && (
            <Text className='page-opinion__read-all' onClick={() => void markAllRead()}>
              全部已读
            </Text>
          )}
        </View>
      </View>

      {/* ===== 今日要点（判断入口，置于三块之前） ===== */}
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
            <View key={e.id} className='page-opinion__row' onClick={() => goBlock(e.block)}>
              <Text className='page-opinion__row-title'>{e.title}</Text>
              <Text className='page-opinion__row-meta'>
                {[e.source || '来源未标注', e.date ? formatMoment8(e.date) : '', e.reason]
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
        <View className='page-opinion__head'>
          <View className='page-opinion__head-main'>
            <Text className='page-opinion__head-title'>
              {events.length > 0 ? `🧩 事件时间线 · ${events.length} 件事` : '🧩 事件时间线'}
            </Text>
            {/* 「新 N 条」：口径来自 utils/inbox#countNewEvents（复用 opinion_event_status.reads） */}
            {eventNew > 0 && <Text className='count-badge'>新 {eventNew} 条</Text>}
          </View>
        </View>

        {events.length === 0 ? (
          <Text className='page-opinion__empty'>
            {feed.status === 'loading' || weekly.status === 'loading' || alerts.status === 'loading'
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
                        `${ev.memberCount} 条来源`,
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
            {/* 事件卡不再页内「加载更多」（2026-10-13）：只给固定预览（`eventPreview`），
                卡底改为入口 → 独立的事件列表页（pages/events），在那里分页加载。
                头部标题已给出事件总数（不让人以为只有首屏这几条）。 */}
            <Text className='page-opinion__more-detail' onClick={goEvents}>
              查看全部事件 ›
            </Text>
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

      {/* ===== 关注动态 ===== */}
      <View className='card page-opinion__block'>
        <View className='page-opinion__head'>
          <View className='page-opinion__head-main'>
            <Text className='page-opinion__head-title'>📡 关注动态</Text>
            {/* 「新 N 条」= 自上次查看以来有变化的关注对象数（口径 utils/inbox#feedNewCount，即每个人的 hasNew） */}
            {feed.newCount > 0 && <Text className='count-badge'>新 {feed.newCount} 条</Text>}
          </View>
          <Text className='page-opinion__more' onClick={goFeed}>
            查看全部 ›
          </Text>
        </View>

        {feed.status === 'loading' && <Text className='page-opinion__hint'>正在读取关注动态…</Text>}
        {feed.status === 'error' && (
          <Text className='page-opinion__hint page-opinion__hint--err' onClick={() => void loadFeed()}>
            关注动态读取失败 · 点此重试
          </Text>
        )}
        {feed.status === 'ready' &&
          (feed.followCount === 0 || feed.entryCount === 0 ? (
            <Text className='page-opinion__empty'>
              {feed.followCount === 0
                ? '还没有关注的动态，去「查」里关注几位名人'
                : '关注的人暂无公开动态，进完整页抓取一次'}
            </Text>
          ) : (
            <>
              <View className='page-opinion__stats'>
                <Text className='page-opinion__stat'>已关注 {feed.followCount} 人</Text>
                <Text className='page-opinion__stat'>近期 {feed.entryCount} 条</Text>
                {feed.failedCount > 0 && (
                  <Text className='page-opinion__stat page-opinion__stat--warn'>{feed.failedCount} 人读取失败</Text>
                )}
              </View>
              {feedPreview.rows.map((e, i) => (
                <View key={`${e.personName}-${i}`} className='page-opinion__row' onClick={goFeed}>
                  <Text className='page-opinion__row-title'>{e.title}</Text>
                  <Text className='page-opinion__row-meta'>
                    {[
                      e.personName,
                      domainLabel(e.domain),
                      e.source || '来源未标注',
                      e.date ? formatMoment8(e.date) : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  {gradeTags(e.source, e.category, e.level)}
                </View>
              ))}
              {/* 关注动态卡不再页内「加载更多」（2026-10-13）：只给固定预览（`feedPreview`）。
                  头部 stats 已给出关注人数 / 近期条数（不让人以为只有首屏这几条）；「看全部动态」
                  由卡头既有的「查看全部 ›」入口承担（→ pages/feed 分页加载），此处不新增第二个入口。 */}
            </>
          ))}
      </View>

      {/* ===== 本周周报 ===== */}
      <View className='card page-opinion__block'>
        <View className='page-opinion__head'>
          <Text className='page-opinion__head-title'>📰 本周周报</Text>
          <Text className='page-opinion__more' onClick={goWeekly}>
            查看全部 ›
          </Text>
        </View>

        {weekly.status === 'loading' && <Text className='page-opinion__hint'>正在读取周报状态…</Text>}
        {weekly.status === 'error' && (
          <Text className='page-opinion__hint page-opinion__hint--err' onClick={() => void loadWeekly()}>
            周报状态读取失败 · 点此重试
          </Text>
        )}
        {weekly.status === 'ready' &&
          (weekly.report ? (
            <>
              <Text className='page-opinion__weekly-range'>
                {weekly.report.windowLabel} · 覆盖 {weekly.report.personCount} 位 / {weekly.report.entryCount} 条
              </Text>
              <Text className='page-opinion__weekly-summary'>
                {weekly.report.overview || '本次未生成综述正文，进完整页看逐人动态与要点'}
              </Text>
              <Text className='page-opinion__row-meta'>生成于 {fromNow(weekly.report.generatedAt)}</Text>
            </>
          ) : (
            <Text className='page-opinion__empty'>
              {weeklyStatusText(weekly.materialKind, weekly.materialCount)}
            </Text>
          ))}
      </View>

      {/* ===== 关键词预警 ===== */}
      <View className='card page-opinion__block'>
        <View className='page-opinion__head'>
          <View className='page-opinion__head-main'>
            <Text className='page-opinion__head-title'>📣 关键词预警</Text>
            {/* 「新 N 条」= 关键词新增 + 风险信号新增（口径 utils/inbox#alertNewCount / #riskNewCount） */}
            {alerts.newTotal + alerts.riskNew > 0 && (
              <Text className='count-badge'>新 {alerts.newTotal + alerts.riskNew} 条</Text>
            )}
          </View>
          <Text className='page-opinion__more' onClick={goAlerts}>
            查看全部 ›
          </Text>
        </View>

        {alerts.status === 'loading' && <Text className='page-opinion__hint'>正在读取预警…</Text>}
        {alerts.status === 'error' && (
          <Text className='page-opinion__hint page-opinion__hint--err' onClick={() => void loadAlertBlock()}>
            预警读取失败 · 点此重试
          </Text>
        )}
        {alerts.status === 'ready' &&
          (alerts.keywordCount === 0 && alerts.personCount === 0 ? (
            <Text className='page-opinion__empty'>还没有监测中的关键词，进完整页添加一个</Text>
          ) : (
            <>
              <View className='page-opinion__stats'>
                {alerts.keywordCount > 0 && (
                  <Text className='page-opinion__stat'>监测 {alerts.keywordCount} 个词</Text>
                )}
                {alerts.personCount > 0 && (
                  <Text className='page-opinion__stat'>监控 {alerts.personCount} 位名人</Text>
                )}
                {/* 列表总数（概要卡头部显示总数，与事件卡「N 件事」/ 关注动态「近期 N 条」同义）：
                    首屏只渲染固定若干条，这里如实给出总数，不让人以为只有首屏这几条 */}
                {alerts.items.length > 0 && (
                  <Text className='page-opinion__stat'>相关报道 {alerts.items.length} 条</Text>
                )}
                {alerts.newTotal > 0 && (
                  <Text className='page-opinion__stat page-opinion__stat--warn'>新增 {alerts.newTotal} 条</Text>
                )}
                {alerts.riskCount > 0 && (
                  <Text className='page-opinion__stat page-opinion__stat--warn'>风险信号 {alerts.riskCount} 条</Text>
                )}
              </View>
              {alerts.items.length === 0 ? (
                <Text className='page-opinion__empty'>已开始监测，暂无相关报道</Text>
              ) : (
                <>
                  {alertSlice.rows.map((a, i) => (
                    <View key={`${a.keyword}-${i}`} className='page-opinion__row' onClick={goAlerts}>
                      <Text className='page-opinion__row-title'>{a.title}</Text>
                      <Text className='page-opinion__row-meta'>
                        {[a.keyword, a.source || '来源未标注', a.date ? formatMoment8(a.date) : '']
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                      {gradeTags(a.source, a.category, a.level)}
                    </View>
                  ))}
                  {/* 概要卡「加载更多 / 到底」（与事件卡同一套口径，概要不分档）：每次追加一批，
                      加载完显示到底文案。不再有「会员可见全部 N 条」的明细提示行。 */}
                  {alertSlice.hasMore ? (
                    <Text className='page-opinion__more-detail' onClick={loadMoreAlerts}>
                      加载更多预警（还有 {alertSlice.remaining} 条）›
                    </Text>
                  ) : (
                    <Text className='page-opinion__done'>—— 没有更多预警 ——</Text>
                  )}
                </>
              )}
            </>
          ))}
      </View>
    </View>
  )
}
