import { useCallback, useRef, useState } from 'react'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { listFollows } from '@/utils/follows'
import { getFeedDetails } from '@/utils/cache'
import { readWeeklyCache } from '@/utils/weekly'
import { loadAlerts, listWatches, splitWatches } from '@/utils/keyword-alert'
import { loadRiskSignals } from '@/utils/risk-watch'
import { countNewEvents } from '@/utils/inbox'
import { EVENTS_PAGE_SIZE, pageSlice } from '@/utils/opinion-access'
import { CRED_LABEL, IMPACT_LABEL, RESPONSE_LABEL } from '@/utils/opinion-rank'
import type { OpinionInput } from '@/utils/opinion-rank'
import { buildOpinionEvents } from '@/utils/opinion-events'
import type { OpinionEvent } from '@/utils/opinion-events'
import {
  emptyStatus,
  eventNewness,
  loadEventStatus,
  loadStoredEvents,
  markEventRead,
  newnessLabel,
  resolveDisplayEvents,
  setEventFollow
} from '@/utils/opinion-store'
import type { EventStatus } from '@/utils/opinion-store'
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
 */

type Status = 'loading' | 'ready' | 'error'

export default function Events() {
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
          date: s.first_seen_at,
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
    /* 下拉刷新 = 重新取数并回到第一页（用户显式要求从头来） */
    await load(true)
    Taro.stopPullDownRefresh()
  })

  /* 客户端分段渲染：首屏只渲染第一页，触底追加下一页（每页 EVENTS_PAGE_SIZE 条，见该常量注释） */
  const paged = pageSlice(events, page, EVENTS_PAGE_SIZE)

  /* 触底加载更多：还有下一页才前进一页；到底则不动（不追加、不触发任何请求） */
  useReachBottom(() => {
    setPage((p) => (p * EVENTS_PAGE_SIZE < events.length ? p + 1 : p))
  })

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

  return (
    <View className='page-events glow-page safe-bottom'>
      <View className='page-events__hero'>
        <Text className='page-events__hero-sub'>同一件事的多条来源聚成一条，点开看完整时间线</Text>
      </View>

      <View className='card page-events__head'>
        <View className='page-events__head-main'>
          <Text className='page-events__head-title'>
            {events.length > 0 ? `🧩 事件 · ${events.length} 件事` : '🧩 事件'}
          </Text>
          {newCount > 0 && <Text className='count-badge'>新 {newCount} 条</Text>}
        </View>
      </View>

      {status === 'loading' && <Text className='page-events__hint'>正在归并事件…</Text>}
      {status === 'error' && (
        <Text className='page-events__hint page-events__hint--err' onClick={() => void load()}>
          事件读取失败 · 点此重试
        </Text>
      )}
      {status === 'ready' && events.length === 0 && (
        <Text className='page-events__empty'>暂无可归并的事件，关注的人或监控词有新动态时会聚在这里</Text>
      )}

      {status === 'ready' &&
        events.length > 0 &&
        <>
          {paged.rows.map((ev) => {
            /* 「新事件」角标：没读过 → NEW；读过但最近有报道 → 有新进展 */
            const newness = eventNewness({ event_key: ev.key, last_at: ev.date }, eventStatus)
            const badge = newnessLabel(newness)
            const read = !!eventStatus.reads[ev.key]
            const following = !!eventStatus.follows[ev.key]
            return (
              /* 整卡跳转到事件时间线页；已读 / 跟进按钮 stopPropagation，避免被整卡手势带走 */
              <View key={ev.key} className='card page-events__item' onClick={() => goEvent(ev)}>
                <View className='page-events__title'>
                  <Text className='page-events__title-text'>{ev.title}</Text>
                  {badge ? (
                    <Text className={`page-events__badge page-events__badge--${newness}`}>{badge}</Text>
                  ) : null}
                </View>
                <Text className='page-events__meta'>
                  {[
                    `${ev.memberCount} 条来源`,
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
            {paged.hasMore ? `上滑加载更多（还有 ${paged.remaining} 条）…` : '—— 没有更多事件 ——'}
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
