import { useCallback, useMemo, useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { listFollows } from '@/utils/follows'
import { getFeedDetails } from '@/utils/cache'
import { readWeeklyCache } from '@/utils/weekly'
import type { WeeklyReport } from '@/utils/weekly'
import { loadAlerts, listWatches, markAllSeen, splitWatches } from '@/utils/keyword-alert'
import { loadRiskSignals } from '@/utils/risk-watch'
import {
  alertNewCount,
  countNewEvents,
  markModuleSeen,
  readInboxSeen,
  riskNewCount
} from '@/utils/inbox'
import { EVENT_OVERVIEW_INITIAL, overviewSlice } from '@/utils/opinion-access'
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
import type { CredTier, ImpactLevel, OpinionEntry, OpinionInput, ResponseNeed } from '@/utils/opinion-rank'
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
import { parsePersonKey } from '@/config/domains'
import { formatMoment8 } from '@/utils/time'
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
 *     入口 → 事件列表页 `pages/events`（那里分页加载：首屏第一页 + 触底追加）；
 *     每条事件仍可整卡点进单事件时间线页 `pages/event`（`goEvent` 行为不变）。
 *     ⚠ 入口位置于 2026-10-13 统一：**移到卡头右上角**（与关注动态卡完全同款：同类名 `page-opinion__more`），
 *       **卡底不再有入口** —— 两卡入口形态一致，不再一处卡头、一处卡底。
 *   · **关注动态卡（③）**：同样固定预览 3 条、**移除「加载更多」**；「看全部」由卡头既有的
 *     「查看全部 ›」承担（→ 已存在的 `pages/feed`，不再新增第二个入口）。
 *   · **关键词预警卡（⑤）**（2026-10-13 补统一）：同样固定预览 3 条、**移除卡内「加载更多 / 到底」**，
 *     入口在卡头右上角（与事件卡 / 关注动态卡**完全同款**：同类名 `page-opinion__more`、同文案
 *     「查看全部 ›」），→ 已存在的预警完整页 `pages/alerts`。统计信息（监测词数 / 监控人数 /
 *     相关报道数 / 风险信号数）照常保留。
 *   这样三张卡在数据很多时**长度恒定**，不会把舆情页撑长（正是用户诉求）。
 *
 * P8（2026-10-13）**首屏性能收敛**（本页加载慢的三处根因，逐条改）：
 *   · 关注动态**预览**只读一次批量缓存（`getFeedDetails`），**不再 await** `loadFollowWatches`
 *     （后者为每位关注人各读 report_cache + feed_cache，2N 次只读）—— 角标改为预览之后再补；
 *   · **端上聚类降级不在首屏并发做**：`buildOpinionEvents` 只在落库事件**读完且确实没数据**时才现算
 *     （见 `storedReady` 与 `eventView`）；库里有共享事件时一次都不算；
 *   · 串行读改并行、同一集合只读一次：`loadAlerts(rows)` 复用已读到的订阅行；
 *     「预警分组 ∥ 风险信号」「落库事件 ∥ 我的状态」各自并行。
 *   ⚠ 口径不变：落库优先 / 降级 / 空态 / 错误态 / 合规说明一字未改，只是把重活挪出渲染关键路径。
 *
 * P9（2026-10-14）**布局重构**：关注动态 / 本周周报 / 监控三块由「概要数据卡」改为**页首入口按钮**
 *   （`page-opinion__nav`：纯图标 + 文字，不加载、不渲染列表），只保留「今日要点」与「事件时间线」
 *   两张真正的数据卡。随之：三块数据仍在后台加载（供统一队列 / 今日要点 / 事件降级用），但
 *   **删除了只为卡片角标 / 统计服务的加载与字段**——`loadFollowWatches`（2N 次只读只算「新 N 条」）
 *   与周报的 `collectWeeklyMaterial`（材料可得性提示）随卡片一并移除，首屏更轻。
 *   · 今日要点条目新增归属展示（`label`：人名 / 关键词），点 feed 条目跳对应名人主页时能看出是谁。
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
   * 事件时间线「只看与我相关」（功能 3）：只显示命中我监控词 / 关注·监控的人的**事件**。
   * 关注动态卡天然都是「我关注的人」、无需过滤，故本开关只落在事件卡（那里混着与我无关的热门事件）。
   */
  const [onlyMine, setOnlyMine] = useState(false)

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

  /** 「只看与我相关」过滤后的事件（功能 3）：命中监控词 / 关注·监控的人任一即为「与我相关」 */
  const visibleEvents = onlyMine ? events.filter((e) => e.hitsKeyword || e.hitsFollow) : events

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

  /** 首页「舆情」入口角标口径：预警 + 风险 + 事件（关注动态归铃铛，见 utils/inbox 文件头） */
  const inboxTotal = alerts.newTotal + alerts.riskNew + eventNew

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
  const eventPreview = overviewSlice(visibleEvents, EVENT_OVERVIEW_INITIAL)

  const goFeed = () => void Taro.navigateTo({ url: '/package/feed/index' })
  const goWeekly = () => void Taro.navigateTo({ url: '/package/weekly/index' })
  const goAlerts = () => void Taro.navigateTo({ url: '/package/alerts/index' })
  /**
   * 事件卡**卡头右上角**「查看全部 ›」→ 事件列表页（2026-10-13）：本页只给固定预览，
   * 「看全部事件」挪到独立页分页加载（首屏第一页 + 触底追加），不再在本页越加载越长。
   * 入口位置与关注动态卡统一（同为卡头 `page-opinion__more`，不再放在卡底）。
   */
  const goEvents = () => void Taro.navigateTo({ url: '/package/events/index' })
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
          <Text className='page-opinion__hero-sub'>关注的人 · 本周周报 · 监控，一处看全</Text>
          {/* 站内「全部已读」显式入口（推送没了之后的收口），只在确有未读时出现 */}
          {inboxTotal > 0 && (
            <Text className='page-opinion__read-all' onClick={() => void markAllRead()}>
              全部已读
            </Text>
          )}
        </View>
      </View>

      {/* ===== 三个入口按钮（关注动态 / 本周周报 / 监控）：纯入口，不加载数据，置于页首 ===== */}
      <View className='page-opinion__nav'>
        <View className='page-opinion__nav-item' onClick={goFeed}>
          <Text className='page-opinion__nav-icon'>📡</Text>
          <Text className='page-opinion__nav-label'>关注动态</Text>
        </View>
        <View className='page-opinion__nav-item' onClick={goWeekly}>
          <Text className='page-opinion__nav-icon'>📰</Text>
          <Text className='page-opinion__nav-label'>本周周报</Text>
        </View>
        <View className='page-opinion__nav-item' onClick={goAlerts}>
          <Text className='page-opinion__nav-icon'>🔔</Text>
          <Text className='page-opinion__nav-label'>监控</Text>
        </View>
      </View>

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
        <View className='page-opinion__head'>
          <View className='page-opinion__head-main'>
            <Text className='page-opinion__head-title'>
              {onlyMine
                ? visibleEvents.length > 0
                  ? `🧩 与我相关 · ${visibleEvents.length} 件事`
                  : '🧩 与我相关'
                : events.length > 0
                  ? `🧩 事件时间线 · ${events.length} 件事`
                  : '🧩 事件时间线'}
            </Text>
            {/* 「新 N 条」：口径来自 utils/inbox#countNewEvents（复用 opinion_event_status.reads） */}
            {eventNew > 0 && <Text className='count-badge'>新 {eventNew} 条</Text>}
          </View>
          {/* 右侧动作组：筛选开关 + 「查看全部 ›」入口 */}
          <View className='page-opinion__head-actions'>
            <Text
              className={`page-opinion__filter${onlyMine ? ' page-opinion__filter--on' : ''}`}
              onClick={() => setOnlyMine((v) => !v)}
            >
              {onlyMine ? '✓ 只看与我相关' : '只看与我相关'}
            </Text>
            {/* 卡头右上角文字按钮（同类名 `page-opinion__more`），跳独立的事件列表页 pages/events。
                （2026-10-13 此前在卡底、现移到卡头；2026-10-14 关注动态卡已改为页首入口按钮。） */}
            <Text className='page-opinion__more' onClick={goEvents}>
              查看全部 ›
            </Text>
          </View>
        </View>

        {visibleEvents.length === 0 ? (
          <Text className='page-opinion__empty'>
            {/* 落库事件还没读完（`!storedReady`）时也算「进行中」—— 此时不该显示成「暂无可归并的事件」 */}
            {!storedReady || feed.status === 'loading' || weekly.status === 'loading' || alerts.status === 'loading'
              ? '正在归并事件…'
              : onlyMine && events.length > 0
                ? '没有与我相关的事件，关掉「只看与我相关」查看全部'
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
