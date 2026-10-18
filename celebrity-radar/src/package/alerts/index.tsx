import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { Input, Text, View } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import {
  addWatch,
  alertLevelLabel,
  AlertGroup,
  isNewItem,
  KEYWORD_MAX_CHARS,
  loadAlerts,
  listWatches,
  markAllSeen,
  normalizeKeyword,
  removeWatch,
  splitWatches,
  WatchRow
} from '@/utils/keyword-alert'
import { readMemberState } from '@/utils/member'
import { alertNewCount, markModuleSeen } from '@/utils/inbox'
import { personWatchLimit, watchGate, watchLimit, watchLimitNote } from '@/utils/opinion-access'
import {
  groupSignals,
  isMonitoredName,
  loadRiskScans,
  loadRiskSignals,
  PersonSignalGroup,
  seenLabel,
  unmonitorPerson
} from '@/utils/risk-watch'
import { loadScanLogs, latestLogByKey, monitorResultText, riskSignalTotal } from '@/utils/scan-log'
import { emptyStatus, loadEventStatus, loadStoredEvents, toDisplayEvents } from '@/utils/opinion-store'
import { buildSubjectHits, hasSubjectSubs, toggleSubject } from '@/utils/event-subscribe'
import { alertNotifyConfigured, requestAlertNotify, requestRiskNotify, riskNotifyConfigured } from '@/utils/notify'
import { openSourceLink } from '@/utils/source-link'
import { formatMoment8 } from '@/utils/time'
import { decodeParam } from '@/utils/route'
import { track } from '@/utils/events'
import { openMemberPage } from '@/utils/member-entry'
import type { RiskScanRow, RiskSignalRow, ScanLogRow } from '@/types/db'
import type { EventStatus } from '@/utils/opinion-store'
import type { SubjectHit } from '@/utils/event-subscribe'
import EmptyState from '@/components/empty-state'
/* 两路（关键词 / 名人）共用同一份执行日志渲染，此前是两份逐行相同的 JSX */
import ScanLogList from '@/components/scan-log-list'
/* 三处「名单 + ×」（关键词 / 关注对象 / 名人）共用同一份胶囊排 */
import ChipList from '@/components/chip-list'
/* 关键词 / 名人两张监控状态表共用同一套表头、列宽与状态色 */
import MonitorTable, { type MonitorRow } from '@/components/monitor-table'
import './index.scss'

/**
 * 被推送定位到的那一组卡片的类名（S1-3）：JSX 与滚动选择器共用同一个常量，
 * 免得改了一边漏另一边 —— 那种漏改不报错，表现只是「点了通知没滚过去」。
 */
const FOCUS_GROUP_CLASS = 'page-alerts__group--focus'

/** 每个关注对象最多列几条事件：这张卡是「有没有动静」，不是事件列表（全量去事件列表页看） */
const SUB_EVENT_MAX = 3

/** 用户从推送落地时，那个词的四种处境（S1-3）：文案与埋点共用一套取值 */
type FocusKind = 'group' | 'watching' | 'gone' | 'guest'

/**
 * 定位条文案（S1-3）。写成一张按处境索引的表，而不是 JSX 里套三层三元：
 *   · 表能一眼看出有没有漏掉某一类 —— 未登录就是差点漏掉的那一类，
 *     它会把「没登录」说成「已不在监测中」，白白吓用户一跳；
 *   · 同一个 FocusKind 也喂给 `alert_focus` 埋点，文案与埋点不会各说各的。
 */
const FOCUS_COPY: Record<FocusKind, (kw: string, count: number) => { title: string; desc: string }> = {
  guest: (kw) => ({
    title: `登录后查看「${kw}」`,
    desc: '预警与监控按账号保存，登录后即可查看'
  }),
  group: (kw, count) => ({
    title: `推送提醒：「${kw}」有新报道`,
    desc: `已定位到下方这一组，共 ${count} 条。`
  }),
  watching: (kw) => ({
    title: `正在监控「${kw}」`,
    /* 说清「什么时候才会有」，否则用户会以为这条推送是假的 */
    desc: '云端每天上午检索一次，有新报道时会出现在下方并提醒你一次。'
  }),
  gone: (kw) => ({
    title: `「${kw}」已不在监控中`,
    desc: '可能已在别处取消。想继续监控，在上方「关键词监控」里重新添加。'
  })
}

/**
 * 关键词舆情预警（2026-10-08）。
 *
 * 这一页只做两件事：**管订阅**（最多 5 个词）与**看预警**（云端每天检索出的新报道）。
 *
 * 为什么页面上没有「立即扫描」：检索一次就是一次上游计费，把扫描做成按钮等于把成本开关
 * 交给点击频率（改包还能无限刷）。新内容一律由云函数 keywordAlert 每天跑一次，
 * 端上只读缓存 —— 预警的产品语义本来就是「等消息」，不是「查消息」。
 *
 * 为什么列表当收件箱用（已读的条目留在原地、只去掉「新」标记）：全部只给未读的话，
 * 用户看过一次就再也找不回那几条报道了。列表读到之后再调 markAllSeen（顺序见其注释）。
 *
 * 第三种进入方式（S1-3，2026-10-16）：**从订阅消息点进来**，page 上带着 `?keyword=`。
 * 这一页的所有内容都是「多个词并列」，而推送的语义恰好相反 ——「就是这一个词有事」。
 * 所以带参数进来时先给一条定位条、并高亮那一组，把推送刚建立起来的那点确定性接住。
 */
export default function Alerts() {
  const { userId } = useAuth()
  const router = useRouter()

  /**
   * 推送落点带来的关键词（S1-3）。云端 keywordAlert 的订阅消息 page 是
   * `package/alerts/index?keyword=<词>`（见 cloudfunctions/keywordAlert 第 5 步）。
   *
   * 归一化后再比对：写库时走的就是 normalizeKeyword（见 utils/keyword-alert#addWatch），
   * 不归一会因词里多一个空格就匹配不上，而高亮失效**没有任何外在表现** —— 最难查的一类 bug。
   */
  const focusKeyword = useMemo(
    () => normalizeKeyword(decodeParam(router.params.keyword || '')),
    [router.params.keyword]
  )
  /** 关掉定位条：推送的语境到此为止，之后的浏览不再被高亮干扰（仅本次进入内有效） */
  const [focusClosed, setFocusClosed] = useState(false)

  /** 我的关键词订阅（用来渲染 chips 与「已监测 N/上限」）—— 不含监控行 */
  const [watches, setWatches] = useState<WatchRow[]>([])
  /** 监控中的名人（keyword_watches 里 type='person' 的行） */
  const [persons, setPersons] = useState<WatchRow[]>([])
  /** 是否会员：决定关键词监测数上限的档位（免费 watchCount.free / 会员 watchCount.member） */
  const [isMember, setIsMember] = useState(false)
  /** 预警分组（按等级 + 最近检索时间排序） */
  const [groups, setGroups] = useState<AlertGroup[]>([])
  /** 风险信号分组（按人；按最近一条信号时间倒序） */
  const [riskGroups, setRiskGroups] = useState<PersonSignalGroup[]>([])
  /** 名人扫描快照（risk_scans：最近扫描时间 / 累计信号数） */
  const [riskScans, setRiskScans] = useState<RiskScanRow[]>([])
  /** 关键词执行日志（scan_logs，kind=keyword） */
  const [keywordLogs, setKeywordLogs] = useState<ScanLogRow[]>([])
  /** 名人执行日志（scan_logs，kind=person） */
  const [personLogs, setPersonLogs] = useState<ScanLogRow[]>([])
  /**
   * 我订阅的**事件对象**（人 / 关键词）及各自的动向（E1-②）。
   * ⚠ 空数组同时表示「一个都没订阅」与「订阅了但都没动向」—— 卡片只在**有订阅**时渲染，
   * 所以「有没有订阅」必须由 `loadEventStatus` 回答，不能拿这个数组的长度当判据。
   */
  const [subHits, setSubHits] = useState<SubjectHit[]>([])
  /**
   * 我的事件个人状态（已读 / 跟进 / 订阅对象）。
   *
   * ⚠ 必须**存进 state**，不能只在 refresh 里用局部变量判：渲染时那句 `hasSubjectSubs(status)`
   * 要回答「这张卡画不画」，而局部变量在重渲染时早已不在作用域里 —— 那时它会落到同名全局
   * （`window.status`，一个字符串）上，判据变成永远为假：订阅了也不显示（类型系统会挡，但别指望它）。
   */
  const [status, setStatus] = useState<EventStatus>(() => emptyStatus())
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  /** 提交中：防止连点造成两个并发的 addWatch（后一个会撞主键） */
  const [submitting, setSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    if (!userId) {
      setWatches([])
      setPersons([])
      setGroups([])
      setRiskGroups([])
      setSubHits([])
      setStatus(emptyStatus())
      setLoading(false)
      return
    }
    /* `loadEventStatus` 一起并进来：订阅栏要不要读事件表，得先看这一行有没有订阅（见下方注释） */
    const [rows, res, member, evStatus] = await Promise.all([
      listWatches(),
      loadAlerts(),
      readMemberState(),
      loadEventStatus()
    ])
    /* 读出来的状态立刻升到 state：下方「订阅的对象」那张卡的渲染判据用的就是它 */
    setStatus(evStatus)
    /* 同一张表混着两类行，必须拆开：关键词订阅归上方「关键词监测」，监控行归下方风险信号板块。
       直接用整表长度会让「已监测 N/上限」把监控中的人算进关键词额度（见 keyword-alert.ts#splitWatches） */
    const { keywords, persons: personRows } = splitWatches(rows)
    setWatches(keywords)
    setPersons(personRows)
    setIsMember(member.member)
    setGroups(res.groups)
    setLoading(false)

    /* 四份读互不依赖 → 并行：风险信号 + 名人扫描快照 + 关键词执行日志 + 名人执行日志 */
    const keys = personRows.map((p) => p.person_key).filter((k): k is string => !!k)
    const kwKeys = keywords.map((w) => w.keyword)
    const [riskRows, scans, kwLogs, personLogs] = await Promise.all([
      loadRiskSignals(keys),
      loadRiskScans(keys),
      loadScanLogs('keyword', kwKeys),
      loadScanLogs('person', keys)
    ])
    setRiskGroups(groupSignals(riskRows))
    setRiskScans(scans)
    setKeywordLogs(kwLogs)
    setPersonLogs(personLogs)
    /*
     * 进入预警页即把「风险信号」的本机基线推进到当前（或最新一条信号时间）—— 风险信号是唯一
     * 没有天然基线的模块（口径见 utils/inbox.ts 文件头），标记放在**读到之后**，与 markAllSeen 同理。
     */
    if (riskRows.length) {
      const latest = riskRows.reduce(
        (m, s) => (String(s.first_seen_at ?? '') > m ? String(s.first_seen_at ?? '') : m),
        ''
      )
      markModuleSeen('risk', latest)
    }

    /* 标记已看必须在读之后：反了会把本次刚读出的条目直接算成已读 */
    if (res.groups.length) void markAllSeen(res.groups.map((g) => g.keyword))

    /*
     * 订阅的事件对象（E1-②）：先用个人状态判「有没有订阅」，**没订阅就不读事件表**
     * —— 为一个必然是空的列表去读两百行，不值（同 utils/revisit.ts#loadRevisits 的短路口径）。
     * 数据源刻意用**落库事件**（`opinion_events`）：本页整页都是「云端每天扫一轮」的结果视图
     * （上方预警分组、下方风险信号同源）；这里若回落到本端聚类，同一件事会在这张卡和事件列表页
     * 各说一个版本，而这张卡就压在上方那份云端结果下面，对不上最扎眼。
     */
    if (!hasSubjectSubs(evStatus)) {
      setSubHits([])
    } else {
      const eventRows = await loadStoredEvents()
      setSubHits(buildSubjectHits(toDisplayEvents(eventRows ?? [], { keywords: kwKeys, watchNames: keys }), evStatus))
    }
  }, [userId])

  useDidShow(() => {
    void refresh()
  })

  const submitWatch = async () => {
    if (submitting) return
    setSubmitting(true)
    const res = await addWatch(input)
    setSubmitting(false)
    if (res.ok) {
      setInput('')
      Taro.showToast({ title: res.message, icon: 'success' })
      void refresh()
      return
    }
    /* 环境问题（集合没建 / 权限不对）用弹窗说清修法，理由同报告页的监控入口 */
    if (res.fatal) {
      await Taro.showModal({ title: '提醒没能开启', content: res.message, showCancel: false, confirmText: '知道了' })
      return
    }
    Taro.showToast({ title: res.message, icon: 'none' })
  }

  /**
   * 从「订阅的对象」点进事件详情（E1-②）。
   *
   * ⚠ 只跳转，**不在这里标记已读**：本页不构成「我看过这条事件」的证据（用户可能只扫一眼标题就返回），
   * 已读基线归事件详情页自己推进 —— 两处都推会让角标在用户没读正文时就被消掉。
   */
  const openSubjectEvent = (key: string, title: string) => {
    /* 带上 title：事件页加载期间先有标题可显示，不至于白屏（口径同 package/workbench 的 goEvent） */
    void Taro.navigateTo({
      url: `/package/event/index?eventKey=${encodeURIComponent(key)}&title=${encodeURIComponent(title)}`
    })
  }

  /** 「还有 N 条」的出口：订阅栏只列前几条，全量在事件列表页（不在本页做二级列表） */
  /**
   * 「还有 N 条」的出口（2026-10-18）。
   *
   * ⚠ 必须带 `?only=follows`：这段文字出在**订阅/跟进**的上下文里，用户点它想看的是
   * 「我盯的那些」，落到「全部事件」等于让他自己再筛一次（舆情页同一个动作一直带着这个参数）。
   * 之前漏了参数，是本页唯一一处「点了之后看不到自己刚看的那件事」的跳转。
   */
  const openEventList = () => void Taro.navigateTo({ url: '/package/events/index?only=follows' })

  /**
   * 取消订阅一个对象（E1-②）。乐观移除 + 失败重拉 —— 订阅关系正是这一页在展示的东西，
   * 点了没反应会被当成没点成功（与事件详情页 toggleSubjectSub 同一套乐观更新口径）。
   * 埋点与订阅共用 `event_subscribe`（`on: false` 表示取消），见 utils/events.ts 的说明。
   */
  const unsubscribeSubject = async (label: string) => {
    setSubHits((hits) => hits.filter((h) => h.label !== label))
    const outcome = await toggleSubject(label, false)
    if (outcome === 'failed') {
      Taro.showToast({ title: '取消关注失败，请重试', icon: 'none' })
      void refresh()
      return
    }
    /* 同步把 state 里的订阅键也删掉：本卡的渲染判据是 hasSubjectSubs(status)，
       若只改 subHits，取消**最后一个**订阅后这张卡会留在原地、变成一个空壳 */
    setStatus((s) => {
      const subs = { ...(s.subs ?? {}) }
      delete subs[label]
      return { ...s, subs }
    })
    track('event_subscribe', { subject: label, on: false })
  }

  /**
   * 提交前先看一眼输入的是不是**已在监控名单里的人名**。
   *
   * 命中时**不直接拦下**：两种订阅的覆盖范围本来就不同（关键词收全部报道、风险监控只收命中
   * 风险词的那部分），用户完全可能两个都要。所以只把代价说清 —— 云端会把同一批内容再检索
   * 一次（两条链路各有跨用户去重，但互不共享）—— 然后把选择权交回去。
   *
   * 用回调式的 showModal（而不是 await 一个 Promise 版）：与下方两个取消确认同一套写法，
   * 页面里不为此再引入一个工具函数。
   */
  const handleAdd = () => {
    if (submitting) return
    const dup = isMonitoredName(persons, input)
    if (!dup) {
      void submitWatch()
      return
    }
    void Taro.showModal({
      title: '已在风险监控中',
      content: `「${dup.keyword}」只收命中风险词的报道。关键词监控收的是全部报道，但同一批内容会被云端再检索一次。`,
      confirmText: '同时监控关键词',
      cancelText: '只保留监控',
      success: (r) => {
        if (r.confirm) void submitWatch()
      }
    })
  }

  const handleRemove = (keyword: string) => {
    void Taro.showModal({
      title: '取消监控',
      content: `不再监控「${keyword}」？已有的预警记录会一并从列表移除。`,
      confirmText: '取消监控',
      cancelText: '再想想',
      success: async (r) => {
        if (!r.confirm) return
        const ok = await removeWatch(keyword)
        if (ok) void refresh()
      }
    })
  }

  /** 取消监控某个人（列表里的显式操作；与关键词取消同一套二次确认） */
  const handleUnmonitor = (personKey: string, name: string) => {
    void Taro.showModal({
      title: '取消监控',
      content: `不再监控「${name}」的风险情况？已收集的信号会一并从列表移除。`,
      confirmText: '取消监控',
      cancelText: '再想想',
      success: async (r) => {
        if (!r.confirm) return
        const ok = await unmonitorPerson(personKey, 'alerts')
        if (ok) void refresh()
      }
    })
  }

  const handleNotify = async () => {
    const res = await requestAlertNotify()
    Taro.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' })
  }

  /** 风险提醒授权（与关键词提醒是两个模板、两份授权，见 utils/notify.ts） */
  const handleRiskNotify = async () => {
    const res = await requestRiskNotify()
    Taro.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' })
  }

  /**
   * 关键词 → 主题速览（pages/topic）。
   *
   * 预警列表回答「最近被报道了多少条」，但用户看完往往还有一问：**别处都是怎么讲这个词的**。
   * 主题页只读本机已缓存的报告做编目（零检索、零模型调用、不消耗生成额度），
   * 与报告页词云的落点是同一个 —— 这里多给一个入口，但页面语义完全一致。
   */
  const goTopic = (keyword: string) => {
    void Taro.navigateTo({
      url: `/package/topic/index?topic=${encodeURIComponent(keyword)}&from=alerts`
    })
  }

  /** 条目的时间展示：优先媒体发布时间，缺失时退回我们首次看到它的时间（P2-36：一律 UTC+8） */
  const itemDate = (item: AlertGroup['items'][number]) =>
    formatMoment8(item.published_date ?? item.first_seen_at ?? '')

  /**
   * 风险信号的时间展示：与上面 itemDate 及云端时间线**同一口径** —— 优先媒体发布时间，
   * 缺失才退回我们首次看到它的时间。两个口径之差不是小事：「今天扫到一条上月的旧报道」
   * 若一律显示成「今天」，会被读成刚刚发生（判新旧仍走 first_seen_at，不受这里影响）。
   */
  const signalDate = (s: RiskSignalRow) => seenLabel(s.published_date ?? s.first_seen_at)

  /* 本次新增之和：走 utils/inbox#alertNewCount（与舆情页「新 N 条」同一口径，等价于各词 newCount 相加） */
  const newTotal = alertNewCount(groups)
  const notifyReady = alertNotifyConfigured()
  const riskNotifyReady = riskNotifyConfigured()

  /* 每个监控对象的最新一条执行日志（决定表格「最近执行 / 状态 / 命中」列） */
  const kwLatest = latestLogByKey(keywordLogs)
  const personLatest = latestLogByKey(personLogs)
  const scanByKey = new Map(riskScans.map((s) => [s.id, s]))
  const groupByKey = new Map(groups.map((g) => [g.keyword, g]))
  const riskGroupByKey = new Map(riskGroups.map((g) => [g.personKey, g]))

  /*
   * 关键词监测数上限（P2，2026-10-13）：免费 / 会员分档，真源见 utils/opinion-access.ts。
   * 达到上限时**只收起新增入口**（换成一行升级引导），既有订阅与下方预警列表照常可看可管。
   */
  const watchCap = watchLimit(isMember)
  const atWatchLimit = !watchGate(watches.length, isMember).allowed

  /*
   * 定位条的三种落点（S1-3）—— 一句「正在看 X」盖不住三种处境，必须分开说：
   *   ① 词还在监测、也已有报道 → 指到下方那一组（高亮 + 滚过去）；
   *   ② 词还在监测、但还没有报道 → 说清什么时候才会有（云端每天上午一次），
   *      否则用户会以为这条推送是假的；
   *   ③ 词已不在监测（用户在别处取消过）→ 直说，别让人对着满页别家的词猜自己点的是什么；
   *   ④ 未登录（参数在、但账号态读不出来）→ 要说「登录后查看」，不能说成「已不在监测中」。
   * 四种都给得出下一步，不出现「参数带来了、页面却当没看见」。
   */
  const focusWatch = focusKeyword ? watches.find((w) => w.keyword === focusKeyword) : undefined
  const focusGroup = focusKeyword ? groupByKey.get(focusKeyword) : undefined
  const showFocus = !!focusKeyword && !focusClosed

  /*
   * 两张监控状态表的行（2026-10-17）：取数留在这里、摆盘交给 components/monitor-table。
   * 「命中 / 结果」一格的文字必须走同一个口径（utils/scan-log#monitorResultText）——
   * 两张表并排出现在同一条滚动流里，对「扫过没命中」和「没扫过」说法不同就会互相打脸。
   * ⚠ 返回值标 `MonitorRow[]`：`status: log?.status ?? 'pending'` 会被推成 string，
   * 不标就与组件的 `RowStatus` 对不上（类型一松，'pending' 之外的状态名拼错也不会报错）。
   */
  const keywordRows: MonitorRow[] = useMemo(
    () =>
      watches.map((w) => {
        const log = kwLatest.get(w.keyword)
        const g = groupByKey.get(w.keyword)
        return {
          id: w.id,
          label: w.keyword,
          lastRan: log?.ran_at || g?.lastFetchedAt || '',
          result: monitorResultText(log ? log.hit : undefined, g?.items.length ?? log?.total),
          status: log?.status ?? 'pending',
          focused: showFocus && w.keyword === focusKeyword
        }
      }),
    [watches, kwLatest, groupByKey, showFocus, focusKeyword]
  )

  const personRows: MonitorRow[] = useMemo(
    () =>
      persons.map((p) => {
        const key = p.person_key ?? ''
        const log = personLatest.get(key)
        const scan = scanByKey.get(key)
        const grp = riskGroupByKey.get(key)
        return {
          id: p.id,
          label: p.keyword,
          lastRan: log?.ran_at || scan?.scanned_at || '',
          /* 累计条数：快照 signals_total 优先，读到的条数兜底（NaN 也走兜底，见 riskSignalTotal） */
          result: monitorResultText(
            log ? log.hit : undefined,
            riskSignalTotal(scan, grp?.signals.length ?? log?.total ?? 0)
          ),
          status: log?.status ?? 'pending'
        }
      }),
    [persons, personLatest, scanByKey, riskGroupByKey]
  )
  /* 处境判定只写一遍：文案（FOCUS_COPY）与埋点（alert_focus）都从它取，不会各说各的 */
  const focusKind: FocusKind = !userId
    ? 'guest'
    : focusGroup
      ? 'group'
      : focusWatch
        ? 'watching'
        : 'gone'
  const focusCopy = FOCUS_COPY[focusKind](focusKeyword, focusGroup ? focusGroup.items.length : 0)

  /**
   * 落点埋点（S1-3）：每个词只报一次。
   * 它观测的是「推送把用户带到了哪一类处境」—— 尤其 `'gone'` 的比例：
   * 那说明推送名单与用户的订阅脱了节（取消后仍被扫到），而这类错误端上云端都不报错。
   */
  const trackedFocus = useRef('')
  useEffect(() => {
    if (!focusKeyword || loading || trackedFocus.current === focusKeyword) return
    trackedFocus.current = focusKeyword
    track('alert_focus', { keyword: focusKeyword, kind: focusKind })
  }, [focusKeyword, loading, focusKind])

  /**
   * 定位条生效时滚到那一组（S1-3）。**只滚一次**：useDidShow 每次进页都会 refresh，
   * 不设这道闸就会把正在读列表的用户反复拽回那一组。
   */
  const scrolledTo = useRef('')
  useEffect(() => {
    if (!showFocus || loading || !focusGroup || scrolledTo.current === focusKeyword) return
    scrolledTo.current = focusKeyword
    /*
     * 延后到视图层更新之后再去量：这一组是同一轮渲染出来的，立刻量节点位置会量到 0
     * （卡片还没上屏），滚过去等于没滚。同报告页目录跳转的写法与理由（Taro.nextTick）。
     * 找不到节点时 pageScrollTo 会 reject —— 那只是「没滚成」，不该冒到用户面前；
     * 定位条与高亮仍在，用户照样知道是哪一组。
     */
    Taro.nextTick(() => {
      void Taro.pageScrollTo({ selector: `.${FOCUS_GROUP_CLASS}`, duration: 300 }).catch(() => undefined)
    })
  }, [showFocus, loading, focusGroup, focusKeyword])

  return (
    <View className='page-alerts'>
      {/*
        推送落点定位条（S1-3）：放在首卡之前 —— 它回答的是「我为什么在这」，
        先于「我能管什么」。可关，关掉即恢复成一张普通的预警页。
      */}
      {showFocus && (
        <View className='page-alerts__focus'>
          <View className='page-alerts__focus-body'>
            <Text className='page-alerts__focus-title'>{focusCopy.title}</Text>
            <Text className='page-alerts__focus-desc'>{focusCopy.desc}</Text>
          </View>
          <Text className='page-alerts__focus-close' onClick={() => setFocusClosed(true)}>
            ✕
          </Text>
        </View>
      )}

      {/*
        第一段：我在关注的（免费 · 站内）。
        2026-10-18 词表收敛：本页此前是三块并列（关键词 / 订阅的对象 / 名人），
        「订阅」夹在两个「监控」中间 —— 同一种「每天花一次检索」的功能被切成两段，
        而一个不花额度的功能却顶着一个别的名字。现在按「要不要花额度、会不会推送」分成两段：
          · 关注段（本节）—— 免费、站内、不推送：对象之后的新事件收在这里；
          · 监控段（下方）—— 每天云端检索、可推送、有额度：关键词 / 名人。
        用户只需记住两个词，且每个词只对应一种成本。
      */}
      {userId && (
        <View className='page-alerts__section'>
          <Text className='page-alerts__section-title'>我在关注的</Text>
          <Text className='page-alerts__section-note'>免费 · 站内查看 · 不推送</Text>
        </View>
      )}

      {/*
        关注的对象（原「订阅的对象」，E1-②，2026-10-16）：
        单位是「人 / 关键词」这个**对象**，回答「这个对象之后有没有我要看的新事件」。
        与下方监控段的分工（同页并列，必须各说各的，否则用户看到同一个人出现三遍）：
          · 关注的对象 —— 这个对象在**舆情事件**里有没有动（事件聚类的结果，免费）；
          · 关键词监控 —— 这个词的公开报道（云端检索，词面命中就收，花额度）；
          · 名人监控 —— 这个人的风险信号（命中司法 / 税务这类词才收，花额度）。
        入口在**事件详情页**的「关注对象」按钮，本页只呈现与取消（不在本页新增：新增要知道
        对象是谁，而那个对象只有事件页 / 报告页拿得到）。
        ⚠ 判据：登录即渲染，**不要求已关注**。旧判据 `hasSubjectSubs(status)` 会让没关注过的人
        永远看不到这张卡，而唯一新增入口在事件详情页 ⇒ 这个功能在新用户的屏幕上根本不存在。
        卡内「有没有关注」仍不能用 `subHits.length` 判（关注了但都没动向时它也是 0），
        这部分照旧交给 `hasSubjectSubs`。
      */}
      {userId && (
        <View className='card'>
          <View className='card-title'>关注的对象</View>
          <Text className='page-alerts__intro'>
            在事件详情页点「关注对象」，这个对象（人 / 关键词）之后的新事件就会收在这里。
            免费、站内查看、不发推送；云端每天上午更新一次。
          </Text>
          {/* 取消没有二次确认（与关键词 chip 的二次确认不同）：关注随时可重加，代价是零 */}
          <ChipList
            items={subHits}
            keyOf={(h) => h.label}
            labelOf={(h) => h.label}
            onTap={(h) => void unsubscribeSubject(h.label)}
          />

          {/* 只列**有未读动向**的对象：没动向的对象就是那一排 chip，不必再占一段 */}
          {subHits
            .filter((h) => h.fresh.length > 0)
            .map((h) => (
              <View key={`ev-${h.label}`} className='page-alerts__item'>
                <View className='page-alerts__item-head'>
                  <Text className='page-alerts__group-keyword'>{h.label}</Text>
                  <Text className='page-alerts__group-count'>{`${h.fresh.length} 条新动向`}</Text>
                </View>
                {h.fresh.slice(0, SUB_EVENT_MAX).map((ev) => (
                  <View
                    key={ev.key}
                    className='page-alerts__item'
                    hoverClass='page-alerts__item--tap'
                    onClick={() => openSubjectEvent(ev.key, ev.title)}
                  >
                    <View className='page-alerts__item-head'>
                      <Text className='page-alerts__new'>新</Text>
                      <Text className='page-alerts__item-title'>{ev.title}</Text>
                    </View>
                    <Text className='page-alerts__item-meta'>
                      {[`${ev.memberTotal} 条来源`, ev.date ? formatMoment8(ev.date) : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                ))}
                {/* 不静默截断：这张卡只列前 3 条，多的**如实报数**并给出口（同 S3-3 预览的行数口径） */}
                {h.fresh.length > SUB_EVENT_MAX && (
                  <Text className='page-alerts__topic' onClick={openEventList}>
                    <Text>{`还有 ${h.fresh.length - SUB_EVENT_MAX} 条，去事件列表看全部 ›`}</Text>
                  </Text>
                )}
              </View>
            ))}

          {/* 一个都没关注：这张卡照样渲染，所以必须给出**去哪儿加**。
              同时点明它与「跟进」的分界 —— 下方两段都在讲「我要监控谁 / 什么词」，
              只有这句能告诉用户「单条事件该点跟进」。 */}
          {!hasSubjectSubs(status) && (
            <Text className='page-alerts__intro'>
              还没有关注任何对象。想看某个人 / 某个话题的后续，去事件详情页点「关注对象」；
              只想追某一条事件的后续，点那条事件里的「☆ 跟进」。
            </Text>
          )}

          {/* 有关注、但一个对象都没动向时，上面整块为空 —— 必须给一句话，否则这张卡看起来像加载失败。
              两种情况在这里合并成一句是**可以**的：对用户而言「还没事件」与「都看过了」的行动一致
              （都是等新的），而「有没有关注」已经由 `hasSubjectSubs` 判过（上面那条空态）。 */}
          {hasSubjectSubs(status) && subHits.every((h) => h.fresh.length === 0) && (
            <Text className='page-alerts__intro'>
              关注的对象暂无新动向：已收录的相关事件都看过了，或有新事件时会出现在这里。
            </Text>
          )}
        </View>
      )}

      {/*
        第二段：我在监控的（每天云端检索 · 可推送 · 有额度）。
        两张卡（关键词 / 名人）现在**连续**排在同一段里 —— 它们共用 keyword_watches 与
        同一份日常检索成本，只是 type 不同（见 utils/keyword-alert.ts / utils/risk-watch.ts）。
      */}
      {userId && (
        <View className='page-alerts__section'>
          <Text className='page-alerts__section-title'>我在监控的</Text>
          <Text className='page-alerts__section-note'>云端每天检索一次 · 可推送 · 有额度上限</Text>
        </View>
      )}

      {/* 关键词监控 */}
      <View className='card'>
        <View className='card-title'>关键词监控</View>
        <Text className='page-alerts__intro'>
          {watches.length
            ? `正在监控 ${watches.length}/${watchCap} 个词，云端每天检索一次公开报道。`
            : `最多可监控 ${watchCap} 个词，云端每天检索一次公开报道。`}
        </Text>
        {/* 定位说明（2026-10-09）：本卡片与下方「名人监控」是两种监控，同页并列时
            不写清就会被当成同一件事（甚至同一个人出现两遍）。一句话讲清各自的筛法即可。 */}
        <Text className='page-alerts__intro'>
          监控的是话题（人名、公司、事件都行）：词面命中公开报道就收，不筛内容。
        </Text>
        <Text className='page-alerts__intro page-alerts__intro--guide'>
          想监控某个人的风险，去 TA 的报告页点「+ 监控风险」—— 那边按风险词过滤，比关键词更准。
        </Text>

        {userId ? (
          atWatchLimit ? (
            /* 达到上限：收起新增入口，换成一行升级引导（不弹窗、不打断，既有订阅照常可看可管） */
            <View
              className='page-alerts__limit'
              hoverClass={isMember ? '' : 'page-alerts__limit--tap'}
              onClick={isMember ? undefined : () => openMemberPage('alerts')}
            >
              <Text className='page-alerts__limit-text'>{watchLimitNote(isMember)}</Text>
              {!isMember && <Text className='page-alerts__limit-go'>去升级 ›</Text>}
            </View>
          ) : (
            <View className='page-alerts__composer'>
              <Input
                className='page-alerts__input'
                value={input}
                maxlength={KEYWORD_MAX_CHARS}
                placeholder={`输入关键词，不超过 ${KEYWORD_MAX_CHARS} 字`}
                confirmType='done'
                onInput={(e) => setInput(e.detail.value)}
                onConfirm={() => void handleAdd()}
              />
              <View
                className={`page-alerts__submit${submitting || !input.trim() ? ' page-alerts__submit--off' : ''}`}
                hoverClass='page-alerts__submit--tap'
                onClick={() => void handleAdd()}
              >
                <Text>开始监控</Text>
              </View>
            </View>
          )
        ) : (
          <Text className='page-alerts__login-tip'>登录后可添加关键词监控（去「我的」页一键登录）</Text>
        )}

        <ChipList
          items={watches}
          keyOf={(w) => w.id}
          labelOf={(w) => w.keyword}
          isFocused={(w) => showFocus && w.keyword === focusKeyword}
          onTap={(w) => handleRemove(w.keyword)}
        />

        {/*
          推送按钮只在「模板已配置 + 已订阅」时出现：未配置还摆一个按钮，
          点了必然失败（微信要求模板先在小程序后台申请），那是拿用户的点击换一条报错。
        */}
        {userId && watches.length > 0 && notifyReady && (
          <View className='page-alerts__notify'>
            <View
              className='page-alerts__notify-btn'
              hoverClass='page-alerts__notify-btn--tap'
              onClick={() => void handleNotify()}
            >
              <Text>开启每日提醒</Text>
            </View>
            <Text className='page-alerts__notify-tip'>微信一次性订阅：开一次收一次，每次收到后可再开</Text>
          </View>
        )}

        {/* 监控状态表格：一行一个关键词，展示最近执行 / 命中 / 结果 / 状态，明细见下方预警列表 */}
        <MonitorTable rows={keywordRows} />

        {/* 执行日志：关键词这一路每次扫描的时间 / 对象 / 命中数 / 成功与否 */}
        <ScanLogList logs={keywordLogs} />
      </View>

      {/* 预警列表：只在「没有任何监测」时走整块空态；只监控了人、没订阅关键词时
          这里整块不渲染（免得摆一句「已开始监测，暂无相关报道」把人误导成关键词也白监测了） */}
      {!userId ? (
        <EmptyState
          title='登录后可用'
          desc='关键词预警与名人监控按账号保存，登录后即可添加监控'
        />
      ) : watches.length === 0 && persons.length === 0 ? (
        <EmptyState
          title='还没有监控中的关键词'
          desc='添加一个关键词，或在某人的深度报告页点「+ 监控风险」；有新的公开报道时会汇总到这里'
        />
      ) : watches.length === 0 ? null : loading ? (
        <View className='card page-alerts__hint'>
          <Text>正在读取预警…</Text>
        </View>
      ) : groups.length === 0 ? (
        <View className='card page-alerts__hint'>
          <Text className='page-alerts__hint-title'>已开始监控，暂无相关报道</Text>
          <Text className='page-alerts__hint-desc'>
            {notifyReady
              ? '云端每天上午检索一次，有新报道时会出现在这里并提醒你一次。'
              : '云端每天上午检索一次，有新报道时会出现在这里。'}
          </Text>
        </View>
      ) : (
        <>
          {newTotal > 0 && (
            <Text className='page-alerts__summary'>{`本次新增 ${newTotal} 条报道`}</Text>
          )}
          {groups.map((g) => (
            <View
              key={g.keyword}
              className={`card page-alerts__group${showFocus && g.keyword === focusKeyword ? ` ${FOCUS_GROUP_CLASS}` : ''}`}
            >
              <View className='page-alerts__group-head'>
                <Text className='page-alerts__group-keyword'>{g.keyword}</Text>
                {g.level !== 'calm' && (
                  <Text className={`page-alerts__badge page-alerts__badge--${g.level}`}>
                    {alertLevelLabel(g.level)}
                  </Text>
                )}
                <Text className='page-alerts__group-count'>
                  {g.newCount > 0 ? `新增 ${g.newCount} 条` : `最近 ${g.items.length} 条`}
                </Text>
              </View>

              {g.items.map((item) => (
                <View
                  key={item.url}
                  className='page-alerts__item'
                  hoverClass='page-alerts__item--tap'
                  onClick={() =>
                    openSourceLink({
                      url: item.url,
                      title: item.title,
                      source: item.source,
                      date: itemDate(item),
                      summary: item.summary
                    })
                  }
                >
                  <View className='page-alerts__item-head'>
                    {isNewItem(item, watches.find((w) => w.keyword === g.keyword)?.seen_at ?? null) && (
                      <Text className='page-alerts__new'>新</Text>
                    )}
                    <Text className='page-alerts__item-title'>{item.title}</Text>
                  </View>
                  <Text className='page-alerts__item-meta'>
                    {[item.source, itemDate(item)].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              ))}

              {/* 预警说「有多少条」，这里去回答「都怎么讲」——两者的数据源不同，
                  文案必须写清是「已收录的报告」，免得被读成这批预警的汇总。 */}
              <View
                className='page-alerts__topic'
                hoverClass='page-alerts__topic--tap'
                onClick={() => goTopic(g.keyword)}
              >
                <Text>看已收录报告的「{g.keyword}」话题 ›</Text>
              </View>
            </View>
          ))}
        </>
      )}


      {/*
        监控中的名人（第 1 期名人风险监控）：与上方关键词订阅**同一张表**（keyword_watches 的
        type='person' 行），但这里是「人」，管理动作（取消监控）与风险信号于是都收在这一段。
        入口在报告页横幅的「+ 监控风险」按钮 —— 本页只做取消，不做新增（新增要知道 personKey，
        而 personKey 只有报告页/主页拿得到）。
      */}
      {userId && persons.length > 0 && (
        <View className='card'>
          <View className='card-title'>名人监控</View>
          <Text className='page-alerts__intro'>
            {`正在监控 ${persons.length}/${personWatchLimit(isMember)} 位，云端每天按人检索一次公开报道。`}
          </Text>
          {/* 与上方「关键词监测」互为镜像的说明：一个讲「这里收什么」，一个讲「这里不收什么」 */}
          <Text className='page-alerts__intro'>
            {`监控的是人物风险：只有命中「司法 / 税务 / 合作 / 维权 / 表态」这类词的报道才会进下方信号列表，其余报道不收。想看 TA 的全部报道，用上面的关键词监控。`}
          </Text>
          <ChipList
            items={persons}
            keyOf={(p) => p.id}
            labelOf={(p) => p.keyword}
            onTap={(p) => handleUnmonitor(p.person_key ?? '', p.keyword)}
          />
          {/*
            监测工作台入口（S3-2，2026-10-16）：紧跟在「我盯谁」的名单之后 ——
            上面这群人的**明细**就在本页往下看，而他们的**横向台账**（谁在动 / 勾选对比 / 导出简报）
            在另一页。放在名单之后而不是页面顶端：它是本页的下游动作，不是本页的替代品。

            `?from=alerts`（2026-10-17）：两页互相有入口，工作台那边要靠这个参数决定「退回去」
            还是「替换过去」—— 不带它就只能猜，而猜错的代价是页面栈一层层加深，
            最终顶到微信 10 层上限、所有跳转静默失败（表现为「点了没反应」）。
          */}
          <View
            className='page-alerts__workbench'
            hoverClass='page-alerts__workbench--tap'
            onClick={() => void Taro.navigateTo({ url: '/package/workbench/index?from=alerts' })}
          >
            <Text className='page-alerts__workbench-text'>把这些人横着排成台账：谁在动 · 勾选对比 · 导出简报</Text>
            <Text className='page-alerts__workbench-go'>监控工作台 ›</Text>
          </View>
          {riskNotifyReady && (
            <View className='page-alerts__notify'>
              <View
                className='page-alerts__notify-btn'
                hoverClass='page-alerts__notify-btn--tap'
                onClick={() => void handleRiskNotify()}
              >
                <Text>开启风险提醒</Text>
              </View>
              <Text className='page-alerts__notify-tip'>
                微信一次性订阅：开一次收一次；未开启也能在下方看到全部信号
              </Text>
            </View>
          )}

          {/* 监控状态表格：一行一位名人，展示最近执行 / 命中 / 结果 / 状态，明细见下方信号列表 */}
          <MonitorTable rows={personRows} />

          {/* 执行日志：名人这一路每次扫描的时间 / 对象 / 命中数 / 成功与否 */}
          <ScanLogList logs={personLogs} />
        </View>
      )}

      {/* 风险信号（按人分组）*/}
      {userId && persons.length > 0 && (
        loading ? (
          <View className='card page-alerts__hint'>
            <Text>正在读取风险信号…</Text>
          </View>
        ) : riskGroups.length === 0 ? (
          <View className='card page-alerts__hint'>
            <Text className='page-alerts__hint-title'>已开始监控，暂无风险信号</Text>
            <Text className='page-alerts__hint-desc'>
              云端每天上午按人检索一次公开报道，命中「司法 / 税务 / 合作 / 维权 / 表态」这类词时汇总到这里。
            </Text>
          </View>
        ) : (
          <>
            {riskGroups.map((grp) => (
              <View key={grp.personKey} className='card page-alerts__group'>
                <View className='page-alerts__group-head'>
                  <Text className='page-alerts__group-keyword'>{grp.name}</Text>
                  <Text className='page-alerts__group-count'>{`最近 ${grp.signals.length} 条`}</Text>
                </View>

                {grp.signals.map((s) => (
                  <View
                    key={s.id}
                    className='page-alerts__item'
                    hoverClass='page-alerts__item--tap'
                    onClick={() =>
                      openSourceLink({
                        url: s.url,
                        title: s.title,
                        source: s.source,
                        date: signalDate(s),
                        summary: s.quote || s.title
                      })
                    }
                  >
                    <View className='page-alerts__item-head'>
                      {/* 类别标签（司法/税务…）说明「命中的是哪类词」，是词典的固定分类，
                          不是对事件的判断 —— 级别（高/中/低）刻意不显示（见 utils/risk-watch.ts 取舍 2） */}
                      <Text className='page-alerts__risk-tag'>{s.category_label}</Text>
                      <Text className='page-alerts__item-title'>{s.title}</Text>
                    </View>
                    <Text className='page-alerts__item-meta'>
                      {[s.source, signalDate(s)].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
            <Text className='page-alerts__note'>
              信号 = 公开报道里出现了上述某类词，不代表平台对 TA 的评价；类别标签只是词的归类，
              不是对事情的定性。点开每条可查看原文出处。
            </Text>
          </>
        )
      )}

      <Text className='disclaimer'>
        预警来自公开报道的检索结果，只反映「最近被报道的量」，不代表平台对任何人的评价；
        点开每条可查看原文出处。
      </Text>
    </View>
  )
}
