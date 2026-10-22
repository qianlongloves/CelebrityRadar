import { useCallback, useRef, useState } from 'react'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom, useRouter } from '@tarojs/taro'
import { Input, Text, View } from '@tarojs/components'
import { listFollows } from '@/utils/follows'
import { getFeedDetails } from '@/utils/cache'
import { readWeeklyCache } from '@/utils/weekly'
import { loadAlerts, listWatches, splitWatches } from '@/utils/keyword-alert'
import { loadRiskSignals } from '@/utils/risk-watch'
import { countFollowUpdates, countNewEvents } from '@/utils/inbox'
import { EVENTS_PAGE_SIZE, pageSlice } from '@/utils/opinion-access'
import { CRED_LABEL, IMPACT_LABEL, RESPONSE_LABEL } from '@/utils/opinion-rank'
import type { OpinionInput } from '@/utils/opinion-rank'
import { buildOpinionEvents } from '@/utils/opinion-events'
import type { OpinionEvent } from '@/utils/opinion-events'
import {
  emptyStatus,
  eventNewness,
  invalidateStoredEvents,
  loadEventStatus,
  loadStoredEvents,
  markEventRead,
  newnessLabel,
  resolveDisplayEvents,
  setEventFollow
} from '@/utils/opinion-store'
import type { EventStatus } from '@/utils/opinion-store'
import {
  EVENT_IMPACT_LABELS,
  EVENT_RANGE_LABELS,
  filterEvents,
  hasActiveFilter
} from '@/utils/event-filter'
import type { EventImpactFilter, EventRange } from '@/utils/event-filter'
import { buildSubjectHits, subscribedLabelByEvent, subjectFreshCount } from '@/utils/event-subscribe'
import { formatMoment8 } from '@/utils/time'
import './index.scss'

/**
 * 事件列表页（独立二级页，2026-10-13）。
 *
 * 为什么单独开一页：舆情页（`pages/opinion`）上的「事件时间线」卡此前是「固定首屏 3 条 +
 * 卡内『加载更多』按需追加」—— 于是在**页内越加载越长**，舆情页本身已经很长，用户想「看全部事件」
 * 时反而把整页撑得没法翻。本轮把「看全部」这件事挪到本页：舆情页事件卡只留**固定的 3 条预览**
 * 与一个「查看全部事件 ›」入口，进入本页后再**分页加载**（首屏第一页 + 触底加载更多 + 下拉刷新）。
 *
 * ## 数据来源（与舆情页事件卡**同一套读取口径与同一套事件结构**，不另写读库代码）
 *
 *   · 落库事件：`utils/opinion-store#loadStoredEvents`（读 `opinion_events`，全站共享、只读）；
 *   · 库里取不到（未跑过云函数 / 集合为空 / 读失败）→ 回落**本端聚类**：用与舆情页同一批既有
 *     读取函数（follows / cache#getFeedDetails、weekly、keyword-alert、risk-watch）凑出
 *     `OpinionInput`，交给 `buildOpinionEvents` 现算；
 *   · 两条路合并走 `resolveDisplayEvents`（落库优先、失败 / 空则回落），产出 `OpinionEvent[]`，
 *     渲染字段与舆情页零分叉（不另起字段名）。
 *
 * ## 分页（本次核心）
 *
 * 事件列表的数据是**一次取回全部**（`loadStoredEvents` 一次读回最近 `EVENT_READ_LIMIT` 条），
 * 云数据库无法对「端上聚类后的一维事件列表」做服务端分页 ⇒ 分页只能是**客户端分段渲染**：
 * 复用 `utils/opinion-access#pageSlice`（不再造第三套切片函数），每页 `EVENTS_PAGE_SIZE` 条；
 * 首屏只渲染第一页，触底追加下一页，到底给结束文案，下拉刷新重取并回到第一页。
 *
 * ⚠ **返回不重置页号**（2026-10-13 修「返回即回顶」）：从本页点进某条事件（pages/event）再返回时，
 * `useDidShow` 会重取数据（数据一定刷新），但**不把页号重置回 1**，用户之前翻到的位置得以保留；
 * 只有**下拉刷新**（用户显式「从头来」）才回到第一页。此外重进本页时**不闪加载态**，避免列表塌陷
 * 把滚动位置顶回顶部（见 `page` / `loadedRef` 注释）。
 * **规模门槛写在 `EVENTS_PAGE_SIZE` 的注释里**（事件量涨到数千条时应改真分页）。
 *
 * ## 分层与合规
 *
 *   · 本页是「事件**列表**」。舆情页三张**概要卡**已统一为「概要不分档」（与会员态无关，见
 *     `utils/opinion-access.ts#EVENT_OVERVIEW_INITIAL`），本页沿用同一口径：**列表不分档**。
 *     「明细条数」这一层分层仍作用在**单个事件的时间线**上（`pages/event`：免费 5 / 会员全部），
 *     本页不碰它。
 *   · 合规红线不变（见 `utils/opinion-events.ts` 文件头）：涉政涉军仍由上游拒答；无来源的条目
 *     不进事件；**聚合 ≠ 认定**；可信度最高只到「官方通报」。本页保留一句克制的轻量说明。
 *
 * ## 范围、搜索与筛选（2026-10-22 改造）
 *
 * 2026-10-18 曾在页内加「全部事件 | 我跟进的」两段 tab；用户反馈 tab 只解决了「我要看自己跟的」，
 * 事件一多仍然只能一条条往下翻。本轮**去掉 tab**，换成卡内的**搜索框 + 两组筛选 chip**：
 *   · 范围（全部 / 已跟进 / 未读）、影响面（影响面 / 高 / 中 / 低）、关键词三者**可叠加**；
 *   · 判据全在 `utils/event-filter.ts`（纯函数，有用例 98 钉住），本页只负责搬 state；
 *   · 「我跟进的」从 tab 降级为**筛选之一**，所以 `?only=follows` 照旧有效 ——
 *     进来就把范围初始成 `follows`，与原来的直达体验一致。
 *
 * 排序与筛选是两件事：本页按**最新的事件在前**（`compareEventOrder`），筛选**不改变顺序**。
 */

type Status = 'loading' | 'ready' | 'error'

export default function Events() {
  const router = useRouter()
  const [status, setStatus] = useState<Status>('loading')
  const [events, setEvents] = useState<OpinionEvent[]>([])
  /** 数据来源：cloud（落库）/ local（本端聚类降级）。仅用于渲染降级说明与排障 */
  const [source, setSource] = useState<'cloud' | 'local'>('local')
  /** 我的事件状态（已读 / 跟进）；读失败 = 空状态（页面照常，只是显示为「都没读过」） */
  const [eventStatus, setEventStatus] = useState<EventStatus>(emptyStatus())
  /**
   * 当前页号（从 1 起）—— 事件列表是**客户端分段渲染**：数据一次取回全部，分页只是按页切片。
   *
   * ⚠ **不是任何一次重取都重置页号**（2026-10-13 修「返回即回顶」）：从本页点进某条事件
   *   （`pages/event`）再返回时，`useDidShow` 会重取数据 —— 若此时把页号重置回 1，用户
   *   之前在列表里翻到的位置就丢了，观感上像「被顶回第 1 页」。故重取数据**不重置页号**，
   *   只有**下拉刷新**（用户显式要求「从头来」）才回到第一页。数据仍然照常刷新（见 `load`）。
   */
  const [page, setPage] = useState(1)
  /**
   * 是否已经成功载入过一次数据：用于「从子页返回」时**不闪加载态**。
   *
   * `useDidShow`（重进本页）会重取数据，但若先切到 `loading` 会把已渲染的列表塌掉
   * （内容变矮 → 平台把滚动位置顶回顶部），于是「保留页号」也保不住滚动位置。
   * 首屏（还没有数据）/ 错误重试没有可保留的列表，照常显示加载态。
   */
  const loadedRef = useRef(false)
  /**
   * 筛选三个维度（2026-10-22，判据见 `utils/event-filter.ts`）：范围 × 影响面 × 关键词，可叠加。
   *
   * 范围的初值来自路由参数 `?only=follows` —— 舆情页事件卡的「跟进的 N 条有新进展」与
   * 「我盯的 ›」都带它直达，省掉「进来再点一次筛选」；参数缺失 / 取值不认识一律落回 `all`。
   * 影响面与关键词一律从「不过滤」起步：用户没要求过滤时不该有任何收窄。
   */
  const [range, setRange] = useState<EventRange>(router.params?.only === 'follows' ? 'follows' : 'all')
  const [impact, setImpact] = useState<EventImpactFilter>('all')
  const [query, setQuery] = useState('')

  /** 本端聚类所需的输入：复用舆情页同一批既有读取函数，每块各自 try/catch（一块读失败不拖垮整页） */
  const collectInput = useCallback(async (): Promise<OpinionInput> => {
    const feed: OpinionInput['feed'] = []
    const alerts: OpinionInput['alerts'] = []
    const keywords: string[] = []
    const watchNames: string[] = []

    try {
      const rows = await listFollows()
      const details = await getFeedDetails(rows.map((f) => f.person_key))
      for (const f of rows) {
        watchNames.push(f.name)
        const detail = details.get(f.person_key)
        for (const it of detail?.items ?? []) {
          feed.push({
            block: 'feed',
            title: it.title,
            source: it.source,
            date: it.publishedDate ?? '',
            person: f.name,
            category: it.category,
            level: it.level
          })
        }
      }
    } catch {
      /* 读失败 → 这一块为空，降级结果可能少这一路的成员，不阻断页面 */
    }

    let weekly: OpinionInput['weekly'] = []
    try {
      const cached = readWeeklyCache()
      weekly =
        cached?.persons?.flatMap((p) =>
          p.entries.map((it) => ({
            block: 'weekly' as const,
            title: it.title,
            source: it.source,
            date: it.publishedDate ?? '',
            person: p.name
          }))
        ) ?? []
    } catch {
      weekly = []
    }

    try {
      const [rows, res] = await Promise.all([listWatches(), loadAlerts()])
      const { keywords: kws, persons } = splitWatches(rows)
      for (const k of kws) keywords.push(k.keyword)
      for (const g of res.groups) {
        for (const it of g.items) {
          alerts.push({
            block: 'alert',
            title: it.title,
            source: it.source,
            date: it.published_date ?? it.first_seen_at ?? '',
            /* 口径随条目带下去：有发布时间就是 'published'，退回我们首见时间才标 'seen'
               （时间线据此写「发现于」，见 TimeBasis） */
            timeBasis: it.published_date ? 'published' : 'seen',
            keyword: g.keyword,
            category: it.category,
            level: it.level
          })
        }
      }
      const keys = persons.map((p) => p.person_key).filter((k): k is string => !!k)
      const signals = await loadRiskSignals(keys)
      for (const p of persons) watchNames.push(p.keyword)
      for (const s of signals) {
        alerts.push({
          block: 'alert',
          title: s.title,
          source: s.source,
          /* 与云端同口径（opinionCluster#collectSources）：优先媒体发布时间 ——
             risk_signals 自 2026-10-16 起落 published_date（老行为空 → 退回 first_seen_at） */
          date: s.published_date ?? s.first_seen_at,
          timeBasis: s.published_date ? 'published' : 'seen',
          person: s.name,
          category: s.category,
          level: s.level
        })
      }
    } catch {
      /* 同上：预警 / 风险信号读失败只少这一路 */
    }

    return { feed, weekly, alerts, keywords, watchNames }
  }, [])

  /**
   * 重读列表：落库优先、读不到回落本端聚类；并重读我的状态。任一步抛错 → 错误态（可重试），不白屏。
   *
   * `resetPage` 只在**下拉刷新**（用户显式要求从头来）时为 true —— 从子页返回（`useDidShow`）
   * 虽然也调用本函数**重取数据**（数据一定刷新，不含「为了保位置就不更新」），但**不重置页号**，
   * 用户之前翻到的位置得以保留。
   *
   * 落库事件走 `loadStoredEvents` 的**内存级 TTL 缓存**（见 `EVENT_CACHE_TTL`）：页面重入 / 与舆情页
   * 共用一份数据时不再重复跨页拉 200 条。作废缓存只发生在**下拉刷新**那一处（用户显式要求重取，
   * 见下方 usePullDownRefresh）—— 否则用户拉了一下却仍看到缓存里那份数据，就成了「拉了没用」。
   */
  const load = useCallback(
    async (resetPage = false) => {
      if (resetPage) setPage(1)
      /* 已有列表时不闪 loading（避免返回时列表塌陷、滚动位置被顶回顶部）；首屏 / 重试照常显示 */
      if (!loadedRef.current) setStatus('loading')
      try {
        const input = await collectInput()
        const local = buildOpinionEvents(input)

        let stored: Awaited<ReturnType<typeof loadStoredEvents>> = null
        try {
          stored = await loadStoredEvents()
        } catch {
          stored = null
        }

        const view = resolveDisplayEvents(stored, { keywords: input.keywords, watchNames: input.watchNames }, local)
        setEvents(view.events)
        setSource(view.source)

        try {
          setEventStatus(await loadEventStatus())
        } catch {
          setEventStatus(emptyStatus())
        }
        setStatus('ready')
        loadedRef.current = true
      } catch {
        setStatus('error')
      }
    },
    [collectInput]
  )

  useDidShow(() => {
    /* 重进本页（含从子页返回）：重取数据但**保留页号**，不把用户顶回第一页 */
    void load()
  })

  usePullDownRefresh(async () => {
    /* 下拉刷新 = 重新取数并回到第一页（用户显式要求从头来）。
       这里**显式作废**落库事件的内存级缓存：否则「拉了刷新」会命中 TTL 内的缓存、界面纹丝不动
       —— 那正是这层缓存唯一可能被用户察觉到的副作用，必须在唯一一个「显式重取」入口上关掉。 */
    invalidateStoredEvents()
    await load(true)
    Taro.stopPullDownRefresh()
  })

  /**
   * 我盯的（已跟进）事件：判据只看 `eventStatus.follows` 有没有这个键 ——
   * 与角标、「盯的 N 条有新进展」计数、「全部已读」跳过已跟进 完全同源
   * （见 utils/opinion-store 文件头），不另立「盯过」标记。
   */
  const followRows = events.filter((e) => !!eventStatus.follows[e.key])
  /** 未读条数：判据与角标同源（`reads` 里没有这个键） */
  const unreadCount = events.filter((e) => !eventStatus.reads[e.key]).length

  /**
   * 实际要渲染的那份列表：三个维度**只在这一次**过滤（范围 → 影响面 → 关键词）。
   * 分页、触底、空态、页脚全部基于它 —— 若在渲染里各判一次，「列表里显示的条数」与
   * 「还有 N 条」就会对不上。顺序由上游 `compareEventOrder` 决定（最新在前），本处**不排序**。
   */
  const filtered = filterEvents(events, {
    range,
    impact,
    query,
    follows: eventStatus.follows,
    reads: eventStatus.reads
  })
  /** 是否有生效的筛选（决定空结果显示哪句话、「清除筛选」给不给） */
  const filtering = hasActiveFilter({ range, impact, query })

  /* 客户端分段渲染：首屏只渲染第一页，触底追加下一页（每页 EVENTS_PAGE_SIZE 条，见该常量注释） */
  const paged = pageSlice(filtered, page, EVENTS_PAGE_SIZE)

  /* 触底加载更多：还有下一页才前进一页；到底则不动（不追加、不触发任何请求） */
  useReachBottom(() => {
    setPage((p) => (p * EVENTS_PAGE_SIZE < filtered.length ? p + 1 : p))
  })

  /**
   * 切换筛选：**页号必须回 1**。过滤后的长度与顺序都与原列表不同，沿用旧页号会翻到空页
   * （`pageSlice` 超界返回空行），观感像「点了没反应」。换筛选不是「返回」，不适用保留页号。
   */
  const switchRange = (next: EventRange) => {
    if (next === range) return
    setRange(next)
    setPage(1)
  }

  const switchImpact = (next: EventImpactFilter) => {
    if (next === impact) return
    setImpact(next)
    setPage(1)
  }

  /**
   * 搜索是**逐字符**输入的：只有页号不在第 1 页时才回 1，
   * 否则每敲一个字符都白跑一次 `setState` + 重渲染（列表可能有上百条）。
   */
  const onQueryChange = (next: string) => {
    setQuery(next)
    if (page !== 1) setPage(1)
  }

  /** 一键清空（空结果卡上的出口）：三个维度全回默认，页号回 1 */
  const resetFilters = () => {
    setRange('all')
    setImpact('all')
    setQuery('')
    setPage(1)
  }

  /**
   * 「标记已读」/「跟进」（沿用舆情页事件卡交互）：乐观更新本地态，写库失败回滚并轻提示。
   * 卡上按钮 stopPropagation，避免点它们时触发整卡跳转。
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

  /** 整卡跳转到事件时间线页，带 encode 过的 eventKey（稳定主题键）+ title（空态兜底） */
  const goEvent = (ev: OpinionEvent) =>
    void Taro.navigateTo({
      url: `/package/event/index?eventKey=${encodeURIComponent(ev.key)}&title=${encodeURIComponent(ev.title)}`
    })

  /** 事件维度的「新」：复用 opinion_event_status.reads，与卡片上的角标同源 */
  const newCount = countNewEvents(
    events.map((e) => ({ key: e.key, at: e.date })),
    eventStatus
  )

  /**
   * 「我盯的（已跟进）里有多少件有新进展」（E1，2026-10-16）：与 opinion-store 同源判据、
   * 只收窄到已跟进的键。本页没有「全部已读」，列出来是为了让用户一眼看到**自己点名要跟的事**
   * 里哪几件动了 —— 盯的对象越多，这个提示越重要（这也是工作台之外的「盯事」入口）。
   */
  const followCount = countFollowUpdates(
    events.map((e) => ({ key: e.key, at: e.date })),
    eventStatus
  )

  /**
   * 订阅的对象（E1-②，2026-10-16）：与上面的「盯的」（跟进**单条**事件）刻意分开 —
   * 这是「我订阅的**对象**里有几个动了」（判据见 utils/event-subscribe.ts）。
   * 两个数字分开报，因为它们回答两个问题：`followCount` = 我点名要跟的事里哪几件动了，
   * `subFreshCount` = 我盯的人/词里有几个在动；合并成一个数会让「订阅了 3 个人、只有 1 个人动」
   * 显示成「有 1 条新进展」，看不出覆盖面。
   * ⚠ 与页头角标（`newCount`）**同源不重复**：订阅只做筛选与标注，不新增「消掉」的语义
   * （本页没有「全部已读」，不推进订阅自己的水位）。
   */
  const subHits = buildSubjectHits(events, eventStatus)
  const subFreshCount = subjectFreshCount(subHits)
  const subLabelByEvent = subscribedLabelByEvent(events, eventStatus)

  return (
    <View className='page-events glow-page safe-bottom'>
      <View className='page-events__hero'>
        <Text className='page-events__hero-sub'>同一件事的多条来源聚成一条，点开看完整时间线</Text>
      </View>

      {/*
        卡头分两层（2026-10-18 用户反馈「最上面的卡片变形」）：
        第一行只说「这是什么」（标题 + 短的「新 N 条」），第二行放**带回数的长入口**。
        原因与舆情页事件卡头完全同源（见 pages/opinion 的卡头注释与用例 87）：
        `.count-badge` 是 `white-space: nowrap` + `flex-shrink: 0` + 定高 36rpx ——
        它既不会内部折行、也不肯被压缩，所以四个元素挤在 nowrap 的一行里时，
        超出的部分**直接顶出卡片右边界**（卡头变形、右边露出半截胶囊）。
        下沉后第二行自带 `flex-wrap`：窄屏 / 超大字号下整枚角标换行，而不是把字压扁。
      */}
      <View className='card page-events__head'>
        <View className='page-events__head-main'>
          <Text className='page-events__head-title'>
            {filtering
              ? `🔎 筛选出 · ${filtered.length} 件`
              : events.length > 0
                ? `🧩 事件 · ${events.length} 件事`
                : '🧩 事件'}
          </Text>
          {newCount > 0 && <Text className='count-badge'>新 {newCount} 条</Text>}
        </View>
        {/* 第二行：两个「带数字的长短语」。缺一个就只渲染另一个（不留空行、不留占位） */}
        {(followCount > 0 || subFreshCount > 0) && (
          <View className='page-events__head-sub'>
            {/* 已跟进的另有计数：跟进 = 订阅（云端日报按同一判据提醒，见 opinion-store 文件头）。
                2026-10-18 起它同时是**入口**：点一下就把列表收窄到「我盯的」，不用先想清楚去哪找。 */}
            {followCount > 0 && (
              <Text className='count-badge page-events__follow-jump' onClick={() => switchRange('follows')}>
                跟进的 {followCount} 条有新进展 ›
              </Text>
            )}
            {/* 订阅的对象（E1-②）：「盯的」是**单条事件**，「订阅的 N 个对象」是**对象**这一层。
                它不可点：订阅的落点在预警页「订阅的对象」卡，本页不做二次入口。 */}
            {subFreshCount > 0 && <Text className='count-badge'>关注的 {subFreshCount} 个对象有新动向</Text>}
          </View>
        )}
      </View>

      {/*
        搜索 + 筛选（2026-10-22，替代原来的「全部事件 | 我跟进的」两段 tab）：
        用户反馈 tab 只有两个口径、事件一多还是只能一条条翻。这里给三个**可叠加**维度：
        关键词（标题 / 人物 / 来源）、范围（全部 / 已跟进 / 未读）、影响面（高 / 中 / 低）。
        chip 一律用 View 做胶囊、Text 只放文字：`<text>` 是行内元素，拿它当定高定宽的胶囊
        在部分基础库上会退化成行盒，选中态背景塌成一条粗线（2026-10-18 踩过）。
      */}
      {status === 'ready' && events.length > 0 && (
        <View className='card page-events__filter'>
          <View className='page-events__search'>
            <Text className='page-events__search-icon'>🔍</Text>
            <Input
              className='page-events__search-input'
              value={query}
              onInput={(e) => onQueryChange(e.detail.value)}
              placeholder='搜事件标题、人物、关键词'
              placeholderClass='page-events__search-ph'
              confirmType='search'
              /* 输入框在页面顶部，键盘遮不到它；关掉「自动上推」可避免整页跳动一次 */
              adjustPosition={false}
            />
            {!!query && (
              <Text className='page-events__search-clear' onClick={() => onQueryChange('')}>
                ✕
              </Text>
            )}
          </View>

          <View className='page-events__chips'>
            {(Object.keys(EVENT_RANGE_LABELS) as EventRange[]).map((r) => (
              <View
                key={r}
                className={`page-events__chip${range === r ? ' page-events__chip--on' : ''}`}
                onClick={() => switchRange(r)}
              >
                <Text className='page-events__chip-text'>
                  {EVENT_RANGE_LABELS[r]}
                  {r === 'follows' ? ` ${followRows.length}` : ''}
                  {r === 'unread' ? ` ${unreadCount}` : ''}
                </Text>
              </View>
            ))}
          </View>

          <View className='page-events__chips'>
            {(Object.keys(EVENT_IMPACT_LABELS) as EventImpactFilter[]).map((k) => (
              <View
                key={k}
                className={`page-events__chip${impact === k ? ' page-events__chip--on' : ''}`}
                onClick={() => switchImpact(k)}
              >
                <Text className='page-events__chip-text'>{EVENT_IMPACT_LABELS[k]}</Text>
              </View>
            ))}
          </View>

          {filtering && (
            <Text className='page-events__filter-reset' onClick={resetFilters}>
              清除搜索与筛选
            </Text>
          )}
        </View>
      )}

      {status === 'loading' && <Text className='page-events__hint'>正在归并事件…</Text>}
      {status === 'error' && (
        <Text className='page-events__hint page-events__hint--err' onClick={() => void load()}>
          事件读取失败 · 点此重试
        </Text>
      )}
      {status === 'ready' && events.length === 0 && (
        <Text className='page-events__empty'>暂无可归并的事件，关注的人或监控词有新动态时会聚在这里</Text>
      )}

      {/* 三种「空」必须分开说，否则用户会以为库里空了、反复下拉刷新：
          ① 库里就没有事件 → 上面那句轻提示；② 跟进清单为空 → 告诉他怎么把事件加进来；
          ③ 有数据但被筛掉了 → 只能说「没有符合条件」，并给一键清除。 */}
      {status === 'ready' && events.length > 0 && range === 'follows' && followRows.length === 0 && (
        <View className='card page-events__empty-card'>
          <Text className='page-events__empty'>
            还没有跟进任何事件。在「全部事件」里点某条的「☆ 跟进」（或点开一条、在完整时间线页跟进）——
            之后这件事的后续会聚合在这里，点开就是完整事件线。
          </Text>
          <Text className='page-events__empty-back' onClick={() => switchRange('all')}>
            去看全部事件 ›
          </Text>
        </View>
      )}
      {/* 被筛空：与上一条**互斥**（跟进清单本身为空时上面已经说明了原因，不再叠一张卡） */}
      {status === 'ready' &&
        events.length > 0 &&
        filtered.length === 0 &&
        !(range === 'follows' && followRows.length === 0) && (
          <View className='card page-events__empty-card'>
            <Text className='page-events__empty'>
              {query.trim() ? `没有匹配「${query.trim()}」的事件。` : '没有符合当前筛选条件的事件。'}
              换个词，或放宽筛选条件试试。
            </Text>
            <Text className='page-events__empty-back' onClick={resetFilters}>
              清除搜索与筛选 ›
            </Text>
          </View>
        )}

      {status === 'ready' &&
        filtered.length > 0 &&
        <>
          {paged.rows.map((ev) => {
            /* 「新事件」角标：没读过 → NEW；读过但最近有报道 → 有新进展 */
            const newness = eventNewness({ event_key: ev.key, last_at: ev.date }, eventStatus)
            const badge = newnessLabel(newness)
            const read = !!eventStatus.reads[ev.key]
            const following = !!eventStatus.follows[ev.key]
            /* 命中订阅的事件（E1-②）：标出「这是我订阅的那个对象」，与 NEW / 有新进展两个角标并列 */
            const subLabel = subLabelByEvent[ev.key] || ''
            return (
              /* 整卡跳转到事件时间线页；已读 / 跟进按钮 stopPropagation，避免被整卡手势带走 */
              <View key={ev.key} className='card page-events__item' onClick={() => goEvent(ev)}>
                <View className='page-events__title'>
                  <Text className='page-events__title-text'>{ev.title}</Text>
                  {badge ? (
                    <Text className={`page-events__badge page-events__badge--${newness}`}>{badge}</Text>
                  ) : null}
                  {/* 带上对象名而不是干写「订阅」：用户可能订了好几个对象，只写「订阅」等于让他自己回忆订了谁 */}
                  {subLabel ? (
                    <Text className='page-events__badge page-events__badge--sub'>关注·{subLabel}</Text>
                  ) : null}
                </View>
                <Text className='page-events__meta'>
                  {[
                    `${ev.memberTotal} 条来源`,
                    ev.labels.length ? ev.labels.join('、') : '',
                    ev.date ? `最近 ${formatMoment8(ev.date)}` : '',
                    `${ev.timeline.length} 个节点`
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                <View className='page-events__tags'>
                  <Text className={`page-events__tag page-events__tag--${ev.impact}`}>{IMPACT_LABEL[ev.impact]}</Text>
                  <Text className={`page-events__tag page-events__tag--cred-${ev.credibility}`}>
                    {CRED_LABEL[ev.credibility]}
                  </Text>
                  <Text className={`page-events__tag page-events__tag--${ev.response}`}>{RESPONSE_LABEL[ev.response]}</Text>
                </View>
                <View className='page-events__actions'>
                  <Text
                    className={`page-events__action${read ? ' page-events__action--on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void markRead(ev.key)
                    }}
                  >
                    {read ? '✓ 已读' : '标记已读'}
                  </Text>
                  <Text
                    className={`page-events__action${following ? ' page-events__action--on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void toggleFollow(ev.key)
                    }}
                  >
                    {following ? '★ 已跟进' : '☆ 跟进'}
                  </Text>
                  <Text className='page-events__go'>查看完整时间线 ›</Text>
                </View>
              </View>
            )
          })}

          {/* 触底加载更多的状态行：切片渲染没有真实网络加载，故不伪造 loading，
              只如实区分「还有 N 条（触底会追加）」与「到底」两种状态 */}
          <Text className='page-events__foot'>
            {paged.hasMore
              ? `上滑加载更多（还有 ${paged.remaining} 条）…`
              : filtering
                ? `—— 符合条件的事件就 ${filtered.length} 条 ——`
                : '—— 没有更多事件 ——'}
          </Text>
        </>
      }

      {/* 降级提示：云端事件库还没产出（或读失败）时，如实说明是本机临时归并 */}
      {source === 'local' && events.length > 0 && (
        <Text className='page-events__note'>云端事件库暂未产出，以上为本机临时归并（稍后自动切换为共享事件）。</Text>
      )}

      <Text className='page-events__note'>
        把多条报道归到同一件事只是为了方便阅读，不代表平台已核实任何事实：每条都带来源与时间，
        「官方通报」与「媒体报道」分别标注，聚合本身不等于认定。
      </Text>
    </View>
  )
}
