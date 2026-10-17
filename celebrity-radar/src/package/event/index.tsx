import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Taro, { usePullDownRefresh, useReachBottom, useRouter } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { listFollows } from '@/utils/follows'
import { getFeedDetails } from '@/utils/cache'
import { readWeeklyCache } from '@/utils/weekly'
import { loadAlerts, listWatches, splitWatches } from '@/utils/keyword-alert'
import { loadRiskSignals } from '@/utils/risk-watch'
import { readMemberState } from '@/utils/member'
import { TIMELINE_PAGE_SIZE, moreDetailNote, pageSlice, sliceDetail } from '@/utils/opinion-access'
import { CRED_LABEL, IMPACT_LABEL, RESPONSE_LABEL } from '@/utils/opinion-rank'
import type { OpinionInput } from '@/utils/opinion-rank'
import { SOURCE_NATURE_LABEL, TIME_BASIS_LABEL, buildOpinionEvents, isValidEventKey } from '@/utils/opinion-events'
import type { OpinionEvent, TimelineItem } from '@/utils/opinion-events'
import {
  emptyStatus,
  eventNewness,
  loadEventStatus,
  loadStoredEventByKey,
  markEventRead,
  newnessLabel,
  resolveEventByKey,
  setEventFollow
} from '@/utils/opinion-store'
import type { EventStatus } from '@/utils/opinion-store'
import { findSubjectSub, toggleSubject, SUB_MAX } from '@/utils/event-subscribe'
import { track } from '@/utils/events'
import { openMemberPage } from '@/utils/member-entry'
import { formatMoment8 } from '@/utils/time'
import { decodeParam, goBackOr } from '@/utils/route'
import './index.scss'

/**
 * 事件时间线页（独立二级页，2026-10-13）。
 *
 * 从舆情页的**事件卡整卡跳转**进入（`pages/opinion` → `pages/event?eventKey=…`）。
 * 为什么拆成独立页而不是在舆情页内联展开：同一份时间线若在两处各渲染一遍必然漂移，
 * 且舆情页本身已经很长；独立页还能顺带做「下拉刷新 + 触底分页」与更从容的合规说明。
 *
 * ## 数据来源（**不读错集合**）
 *
 * 事件落在 `opinion_events`（云函数 `opinionCluster` 写、端上只读）；个人状态在
 * `opinion_event_status`（`_id = openid`，reads / follows / subs 三个 map）。本页**不另写读库代码**、
 * 不另起字段名 —— 复用 `utils/opinion-store.ts` 的 `loadStoredEvents` / `toDisplayEvents` /
 * `loadEventStatus` / `markEventRead` / `setEventFollow`，类型用 `types/db.ts#OpinionEventRow`。
 * 事件身份是 `event_key`（稳定主题键）：路由参数、读库、端上聚类三处都用它对齐。
 *
 * ## 三个动作的分工（别混成一个「收藏」）
 *
 *   · **标记已读**：推进角标基线，只此一个作用；
 *   · **跟进**（`follows`，键 = `event_key`）：「**这一条**事件的后续我要知道」—— 云端日报候选；
 *   · **订阅**（`subs`，键 = 对象标签）：「**这个对象**（人 / 关键词）之后的**所有**事件我要看到」——
 *     站内落点（预警页「订阅的对象」），口径在 `utils/event-subscribe.ts`。
 *   粒度差一层，键空间也不同：按钮文案与说明分别写清，避免用户以为「订阅 = 更贵的跟进」。
 *
 * ## 降级与健壮性
 *
 *   · 库里**还没有这一键**（云函数每天 10:00 才跑一轮，或该事件只在端上聚类出现）→ 回落本端聚类：
 *     用与舆情页同一套取数（follows / feed_cache / weekly / keyword-alert / risk-watch）+ 
 *     `buildOpinionEvents` 现算后按 `event_key` 找到它（见 `resolveEventByKey`）。绝不白屏、不报错。
 *   · 参数缺失 / 非法（不是合法 `event_key`）→ 明确的空态，允许返回，**不发起任何读库**。
 *   · 脏数据（缺时间 / 缺来源 / 时间不可解析）在聚类层就被跳过，本页只渲染已归并的时间线。
 *
 * ## 分层门禁（沿用同一套，不新写判断）
 *
 * 免费用户看时间线仍**限 5 条**、会员看全部 —— 复用 `utils/opinion-access.ts#sliceDetail`，
 * 被截断时用同一行 `moreDetailNote`（点了跳会员页）。**本页不展示今日要点**，故不涉及要点免限。
 * 被截断的 5 条是**头尾各留一半**（最早 3 条 + 最新 2 条），中间由 `__timeline-gap` 画一行省略提示 ——
 * 只留头部会让免费用户永远看不到最新进展（理由见 `sliceDetail` 注释）。
 *
 * ## 合规红线（改本页前先读 utils/opinion-events.ts 文件头）
 *
 * 时间线每条必带来源与时间、并标注来源性质（官方通报 / 媒体报道 / 来源未标注）；保留一句克制的
 * 「聚合 ≠ 认定」说明；涉政涉军仍由上游拒答，本页不加宽任何拦截。
 *
 * ## 「打开不再自动标已读」规则（2026-10-13 口径变更）
 *
 * **打开本页不再自动把该事件标记已读**。已读只能由用户的**显式操作**触发：
 *   · 本页卡头上的「标记已读」按钮；
 *   · 舆情台页首的「全部已读」（一次清掉预警 / 风险 / 事件三处站内未读）。
 * 两处行为不变，与舆情页「标记已读」按钮是**同一份状态**（`opinion_event_status.reads`）。
 * 定位失败（参数非法 / 两处都找不到）依旧不标记。
 *
 * **为什么改成不自动标**：此前「成功定位到该事件即标记已读」——用户只是**点开看一眼**，
 * 就被当成「读过了这件事」。后果有两个：① 用户其实没读，返回列表却已显示「✓ 已读」，
 * 与他的记忆不符（像被平台替他做了判断）；② 舆情台上的「新 N 条」角标会因此凭空减少
 * （未读被误清），用户以为「没新东西」。改为「只有显式操作才标」后，已读与否完全由用户
 * 决定：**已读状态仍照常显示**（已读的事件在列表 / 详情里看得出已读），但不会被动产生。
 * 跟进仍由页面上的按钮显式切换。
 */

type Status = 'loading' | 'ready' | 'invalid' | 'notfound'

/**
 * 时间线条目的时间文案。
 *
 * `timeBasis === 'seen'` 时明确写成「发现于 X」—— 这个时间是我们**第一次扫到**该报道的时刻，
 * 不是媒体发布时刻（`risk_signals` 的老行没有发布时间，只能退回首见时间；见 TimeBasis）。
 * 不区分的话，「10-16 扫到一条 10-10 的旧报道」会被读成「10-16 又有新进展」，时间线的先后就是假的。
 * 其余（绝大多数）就是媒体发布时间，不额外加词。
 */
function timelineTimeText(t: TimelineItem): string {
  const d = t.date ? formatMoment8(t.date) : ''
  if (!d) return ''
  return t.timeBasis === 'seen' ? `${TIME_BASIS_LABEL.seen} ${d}` : d
}

export default function EventTimeline() {
  const router = useRouter()
  /* event_key 是纯 hex（可能带 -N 后缀），不会因 encode/decode 变形；title 含中文才必须编解码 */
  const rawKey = (() => {
    try {
      return decodeParam(router.params.eventKey || '')
    } catch {
      return router.params.eventKey || ''
    }
  })()
  const fallbackTitle = (() => {
    try {
      return decodeParam(router.params.title || '')
    } catch {
      return router.params.title || ''
    }
  })()

  const [status, setStatus] = useState<Status>('loading')
  const [event, setEvent] = useState<OpinionEvent | null>(null)
  /** 数据来源：cloud（落库）/ local（本端聚类降级）/ none。仅用于渲染降级说明与排障 */
  const [source, setSource] = useState<'cloud' | 'local' | 'none'>('none')
  const [isMember, setIsMember] = useState(false)
  const [page, setPage] = useState(1)
  const [eventStatus, setEventStatus] = useState<EventStatus>(emptyStatus())

  /**
   * 本端聚类所需的输入（**只在库里没有这一键时才用到**）。复用舆情页同一批既有读取函数，
   * 每块各自 try/catch（一块读失败不拖垮整页），与舆情页的 `opinionInput` 同口径。
   */
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
          feed.push({ block: 'feed', title: it.title, source: it.source, date: it.publishedDate ?? '', person: f.name })
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
            keyword: g.keyword
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
   * 已读 / 跟进：与舆情页同一套乐观更新 + 写库失败回滚（共用 opinion-store 的写入函数）。
   * **仅在用户显式点「标记已读」时调用** —— 打开本页不再自动标（见文件头口径变更）。
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

  /**
   * 订阅 / 取消订阅「这个对象」（人 / 关键词）的后续事件（E1-②）。口径在 utils/event-subscribe.ts，
   * 这里只管乐观更新 + 失败回滚 + 满员提示。
   *
   * ⚠ 「满员」不是失败：库里**没写**，所以也要回滚乐观态，并明确告诉用户上限是多少、该做什么 ——
   * 静默不生效会让人以为订阅成功了（同 S3-2 工作台 togglePick 的口径：满员回 rejected，不静默丢弃）。
   */
  const toggleSubjectSub = async (label: string) => {
    const key = String(label ?? '').trim()
    if (!key) return
    const prevSubs = { ...(eventStatus.subs ?? {}) }
    const on = !findSubjectSub(eventStatus, key)
    const now = new Date().toISOString()
    setEventStatus((s) => {
      const subs = { ...(s.subs ?? {}) }
      const hit = findSubjectSub(s, key)
      if (on) subs[key] = now
      else if (hit) delete subs[hit.label]
      return { ...s, subs }
    })
    const outcome = await toggleSubject(key, on)
    if (outcome === 'full') {
      setEventStatus((s) => ({ ...s, subs: prevSubs }))
      Taro.showToast({ title: `最多订阅 ${SUB_MAX} 个对象，请先取消一个`, icon: 'none' })
      return
    }
    if (outcome === 'failed') {
      setEventStatus((s) => ({ ...s, subs: prevSubs }))
      Taro.showToast({ title: '操作失败，请重试', icon: 'none' })
      return
    }
    track('event_subscribe', { subject: key, on })
  }

  const load = useCallback(async () => {
    setPage(1)
    setStatus('loading')

    /* 参数门禁：非法直接空态，不读库、不聚类 */
    if (!isValidEventKey(rawKey)) {
      setEvent(null)
      setSource('none')
      setStatus('invalid')
      return
    }

    /* 会员态（读失败按非会员，只影响展示条数）与我的状态（读失败 = 空状态） */
    try {
      setIsMember((await readMemberState()).member)
    } catch {
      setIsMember(false)
    }
    try {
      setEventStatus(await loadEventStatus())
    } catch {
      setEventStatus(emptyStatus())
    }

    /* 读落库事件（读失败返回 null，与「集合为空」区分开，都回落到本端聚类）。
       只按本页的 `event_key` 取**这一条**：以前是把最近 200 条全读回来再 filter，
       为了定位 1 条事件花掉十次往返、几百 KB。 */
    let stored: Awaited<ReturnType<typeof loadStoredEventByKey>> = null
    try {
      stored = await loadStoredEventByKey(rawKey)
    } catch {
      stored = null
    }

    /* 库里没有这一键才去端上聚类（省掉一次不必要的多源取数） */
    let local: OpinionEvent[] = []
    const hasCloud = !!stored && stored.some((r) => r && r.event_key === rawKey)
    if (!hasCloud) {
      try {
        local = buildOpinionEvents(await collectInput())
      } catch {
        local = []
      }
    }

    const { event: found, source: src } = resolveEventByKey(stored, local, rawKey, {})
    if (!found) {
      setEvent(null)
      setSource('none')
      setStatus('notfound')
      return
    }

    setEvent(found)
    setSource(src)
    setStatus('ready')

    /* ⚠ 不再「打开即已读」（2026-10-13 口径变更，见文件头）：打开本页只读、不写 ——
       已读只能由用户显式点「标记已读」按钮或舆情台「全部已读」触发，避免误清未读 / 替用户下判断。 */
  }, [rawKey, collectInput])

  useEffect(() => {
    void load()
    // 仅在首屏按 event_key 加载；下拉刷新走 usePullDownRefresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  usePullDownRefresh(async () => {
    /* 下拉刷新 = 重新取一次事件数据（重读落库 + 我的状态），并把分页重置到第 1 页 */
    await load()
    Taro.stopPullDownRefresh()
  })

  /**
   * 分层门禁：免费档时间线切到 5 条、会员全部（复用 sliceDetail，不新写门槛）；
   * 再对**可见集合**做客户端分段渲染（每页 TIMELINE_PAGE_SIZE 条，触底追加）。
   * 免费档可见集合 ≤5，故只有一页（底部直接「没有更多」）。
   */
  const visible = useMemo(() => sliceDetail(event?.timeline, isMember), [event?.timeline, isMember])
  const paged = useMemo(() => pageSlice(visible.rows, page), [visible.rows, page])

  useReachBottom(() => {
    if (!event) return
    const total = sliceDetail(event.timeline, isMember).rows.length
    setPage((p) => (p * TIMELINE_PAGE_SIZE < total ? p + 1 : p))
  })

  /*
   * 返回（2026-10-17）：这页有 4 个入栈来源（事件列表 / 舆情页 / 工作台 / 预警页），
   * 也有 4 类**没有来源**的入口（订阅消息、小程序码、转发卡片、聊天记录里的旧链接）——
   * 后者打开时页面栈里只有它自己，`navigateBack()` 会静默失败，用户点了「返回」停在原地。
   * 退不动就回事件列表：那是这页在功能上的上一级。
   */
  const goBack = () => goBackOr('/package/events/index')
  const goMember = () => openMemberPage('event')

  /**
   * 页首名称（2026-10-16 新增）：这页此前只有一行灰色说明，没有**名字** —— 用户从事件卡点进来，
   * 看不出「这页是干什么的、这是哪一种功能」。现按舆情页同款 hero（`__hero-title` + `__hero-sub`）
   * 给它一个名字：功能名 + 一句它是干什么的。加载态一并渲染，避免「先有说明后冒出标题」的跳变。
   * 空态（参数非法 / 没找到）**不渲染** —— 那两个分支自带标题，再来一个会变成两行标题。
   */
  const hero = (
    <View className='page-event__hero'>
      <Text className='page-event__hero-title'>事件时间线</Text>
      <Text className='page-event__hero-sub'>
        同一件事的多条来源，按时间排在一起（谁在何时、从哪说的；标「发现于」的是我们首次监测到该报道的时刻）
      </Text>
    </View>
  )

  /* ───────────── 空态 / 加载态 ───────────── */

  if (status === 'invalid') {
    return (
      <View className='page-event glow-page safe-bottom'>
        <View className='page-event__empty'>
          <Text className='page-event__empty-icon'>🔗</Text>
          <Text className='page-event__empty-title'>无法打开这件事</Text>
          <Text className='page-event__empty-desc'>链接缺少或损坏了事件参数，请回到舆情页重新点击事件卡。</Text>
          <Text className='page-event__empty-action' onClick={goBack}>返回 ›</Text>
        </View>
      </View>
    )
  }

  if (status === 'loading') {
    return (
      <View className='page-event glow-page safe-bottom'>
        {hero}
        <Text className='page-event__hint'>正在读取事件时间线…</Text>
      </View>
    )
  }

  if (status === 'notfound' || !event) {
    return (
      <View className='page-event glow-page safe-bottom'>
        <View className='page-event__empty'>
          <Text className='page-event__empty-icon'>🧩</Text>
          <Text className='page-event__empty-title'>{fallbackTitle || '没找到这件事'}</Text>
          <Text className='page-event__empty-desc'>
            该事件可能还没被云端归并入库，且本机暂时也归并不出来（需要先有相关动态或监控词）。
          </Text>
          <Text className='page-event__empty-action' onClick={goBack}>返回 ›</Text>
        </View>
      </View>
    )
  }

  /* ───────────── 正常渲染 ───────────── */

  const newness = eventNewness({ event_key: event.key, last_at: event.date }, eventStatus)
  const badge = newnessLabel(newness)
  const read = !!eventStatus.reads[event.key]
  const following = !!eventStatus.follows[event.key]
  /* 订阅的对象 = 这条事件围绕的那个「谁 / 什么词」（objectKey），为空时回落到第一个标签。
     两者都为空 ⇒ 这条事件没有可订阅的对象：**不渲染**订阅按钮（不给一个点了没用的按钮）。 */
  const subLabel = event.objectKey || event.labels[0] || ''
  const subscribed = !!findSubjectSub(eventStatus, subLabel)

  return (
    <View className='page-event glow-page safe-bottom'>
      {hero}

      <View className='card page-event__head'>
        <View className='page-event__title'>
          <Text className='page-event__title-text'>{event.title}</Text>
          {badge ? <Text className={`page-event__badge page-event__badge--${newness}`}>{badge}</Text> : null}
        </View>
        <Text className='page-event__meta'>
          {[
            `${event.memberTotal} 条来源`,
            event.labels.length ? event.labels.join('、') : '',
            event.date ? `最近 ${formatMoment8(event.date)}` : '',
            `${event.timeline.length} 个节点`
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        <View className='page-event__tags'>
          <Text className={`page-event__tag page-event__tag--${event.impact}`}>{IMPACT_LABEL[event.impact]}</Text>
          <Text className={`page-event__tag page-event__tag--cred-${event.credibility}`}>{CRED_LABEL[event.credibility]}</Text>
          <Text className={`page-event__tag page-event__tag--${event.response}`}>{RESPONSE_LABEL[event.response]}</Text>
        </View>

        <View className='page-event__actions'>
          <Text
            className={`page-event__action${read ? ' page-event__action--on' : ''}`}
            onClick={() => void markRead(event.key)}
          >
            {read ? '✓ 已读' : '标记已读'}
          </Text>
          <Text
            className={`page-event__action${following ? ' page-event__action--on' : ''}`}
            onClick={() => void toggleFollow(event.key)}
          >
            {following ? '★ 已跟进' : '☆ 跟进'}
          </Text>
          {subLabel ? (
            <Text
              className={`page-event__action${subscribed ? ' page-event__action--on' : ''}`}
              onClick={() => void toggleSubjectSub(subLabel)}
            >
              {subscribed ? '🔔 已订阅' : '🔕 订阅'}
            </Text>
          ) : null}
        </View>

        {/* 「跟进」= 订阅（E1，2026-10-16）：点了会发生什么必须说清楚，否则它看起来只是个书签 ——
            云端日报会按同一判据提醒一次，角标也不会被舆情页的「全部已读」清掉。
            刻意不写死「一定推送」：一次性订阅要有**在位**授权才发得出去（见 utils/notify.ts 文件头）。 */}
        {following && (
          <Text className='page-event__follow-note'>
            已跟进：这件事有新报道时会提醒一次（需已开启更新提醒），角标不会被「全部已读」清掉。
          </Text>
        )}

        {/* 订阅（E1-②）：说清「订阅的是对象、落点在站内」，否则它看起来跟上面的「跟进」是一回事。
            刻意点明「不发推送」—— 推送随 N-1 冻结，说成「有动静就通知你」就是空头承诺。 */}
        {subscribed && (
          <Text className='page-event__follow-note'>
            已订阅「{subLabel}」：这个对象之后的新事件会出现在预警页的「订阅的对象」里（站内查看，不发推送）。
          </Text>
        )}
      </View>

      <View className='card page-event__timeline'>
        {paged.rows.length === 0 ? (
          <Text className='page-event__hint'>这件事暂无可展示的时间线节点（需要带来源且时间可解析的报道）。</Text>
        ) : (
          <>
            {paged.rows.map((t, i) => (
              <Fragment key={`${event.key}-${i}`}>
                {/* 免费档时间线是「头尾各留一半」拼出来的（见 utils/opinion-access.ts#sliceDetail），
                    这里是中间那条跳缝，**必须画出来**：否则「最早 3 条 + 最新 2 条」会被当成连续 5 条，
                    读者会把第 4 条的时间当成紧接第 3 条 —— 时间线的先后就假了。
                    `i` 是尾部第一行的下标（分页取的是前缀，故这里的下标仍对得上）。 */}
                {i === visible.headCount && visible.hidden > 0 && (
                  <View className='page-event__timeline-gap'>
                    <Text className='page-event__timeline-gap-text'>⋯ 中间省略 {visible.hidden} 条 ⋯</Text>
                  </View>
                )}
                <View className='page-event__timeline-item'>
                  <View className='page-event__timeline-dot' />
                  <View className='page-event__timeline-body'>
                    <Text className='page-event__timeline-meta'>
                      {[
                        timelineTimeText(t),
                        t.source || '来源未标注',
                        SOURCE_NATURE_LABEL[t.nature],
                        t.label
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    <Text className='page-event__timeline-text'>{t.text}</Text>
                  </View>
                </View>
              </Fragment>
            ))}

            {/* 免费档时间线被截断：沿用与舆情页同一行升级引导（不新造弹窗） */}
            {visible.hidden > 0 && (
              <Text className='page-event__more-detail' onClick={goMember}>
                {moreDetailNote(event.timeline.length)}
              </Text>
            )}

            {/* 触底加载更多：还有下一页时提示「上滑加载更多」，到底显示「没有更多」 */}
            {visible.hidden === 0 && (
              <Text className='page-event__foot'>{paged.hasMore ? '上滑加载更多…' : '—— 没有更多 ——'}</Text>
            )}
          </>
        )}

        {/* 降级提示：云端事件库还没产出（或没有这一键）时，如实说明是本机临时归并 */}
        {source === 'local' && (
          <Text className='page-event__note'>云端事件库暂未产出本条，以上为本机临时归并（稍后自动切换为共享事件）。</Text>
        )}

        <Text className='page-event__note'>
          把多条报道归到同一件事只是为了方便阅读，不代表平台已核实任何事实：每条都带来源与时间，
          「官方通报」与「媒体报道」分别标注，聚合本身不等于认定。
        </Text>
      </View>
    </View>
  )
}
