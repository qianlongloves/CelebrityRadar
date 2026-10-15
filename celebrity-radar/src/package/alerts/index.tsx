import { useCallback, useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
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
import { loadScanLogs, latestLogByKey, SCAN_STATUS_LABEL } from '@/utils/scan-log'
import { alertNotifyConfigured, requestAlertNotify, requestRiskNotify, riskNotifyConfigured } from '@/utils/notify'
import { openSourceLink } from '@/utils/source-link'
import { formatMoment8, fromNow } from '@/utils/time'
import type { RiskScanRow, RiskSignalRow, ScanLogRow } from '@/types/db'
import EmptyState from '@/components/empty-state'
import './index.scss'

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
 */
export default function Alerts() {
  const { userId } = useAuth()

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
      setLoading(false)
      return
    }
    const [rows, res, member] = await Promise.all([listWatches(), loadAlerts(), readMemberState()])
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
      await Taro.showModal({ title: '订阅没能开启', content: res.message, showCancel: false, confirmText: '知道了' })
      return
    }
    Taro.showToast({ title: res.message, icon: 'none' })
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
      content: `「${dup.keyword}」只收命中风险词的报道。关键词监测收的是全部报道，但同一批内容会被云端再检索一次。`,
      confirmText: '同时订阅关键词',
      cancelText: '只保留监控',
      success: (r) => {
        if (r.confirm) void submitWatch()
      }
    })
  }

  const handleRemove = (keyword: string) => {
    void Taro.showModal({
      title: '取消监测',
      content: `不再监测「${keyword}」？已有的预警记录会一并从列表移除。`,
      confirmText: '取消监测',
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
        const ok = await unmonitorPerson(personKey)
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

  return (
    <View className='page-alerts'>
      {/* 订阅管理 */}
      <View className='card'>
        <View className='card-title'>关键词监控</View>
        <Text className='page-alerts__intro'>
          {watches.length
            ? `正在监测 ${watches.length}/${watchCap} 个词，云端每天检索一次公开报道。`
            : `最多可监测 ${watchCap} 个词，云端每天检索一次公开报道。`}
        </Text>
        {/* 定位说明（2026-10-09）：本卡片与下方「监控中的名人」是两种订阅，同页并列时
            不写清就会被当成同一件事（甚至同一个人出现两遍）。一句话讲清各自的筛法即可。 */}
        <Text className='page-alerts__intro'>
          盯的是话题（人名、公司、事件都行）：词面命中公开报道就收，不筛内容。
        </Text>
        <Text className='page-alerts__intro page-alerts__intro--guide'>
          想盯某个人的风险，去 TA 的报告页点「监控风险」—— 那边按风险词过滤，比关键词更准。
        </Text>

        {userId ? (
          atWatchLimit ? (
            /* 达到上限：收起新增入口，换成一行升级引导（不弹窗、不打断，既有订阅照常可看可管） */
            <View
              className='page-alerts__limit'
              hoverClass={isMember ? '' : 'page-alerts__limit--tap'}
              onClick={isMember ? undefined : () => Taro.navigateTo({ url: '/package/member/index' })}
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
                <Text>开始监测</Text>
              </View>
            </View>
          )
        ) : (
          <Text className='page-alerts__login-tip'>登录后可订阅关键词（去「我的」页一键登录）</Text>
        )}

        {watches.length > 0 && (
          <View className='page-alerts__chips'>
            {watches.map((w) => (
              <View
                key={w.id}
                className='page-alerts__chip'
                hoverClass='page-alerts__chip--tap'
                onClick={() => handleRemove(w.keyword)}
              >
                <Text>{w.keyword}</Text>
                <Text className='page-alerts__chip-x'>×</Text>
              </View>
            ))}
          </View>
        )}

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
        {watches.length > 0 && (
          <View className='page-alerts__table'>
            <View className='page-alerts__tr page-alerts__tr--head'>
              <Text className='page-alerts__td page-alerts__td--obj'>监控对象</Text>
              <Text className='page-alerts__td'>最近执行</Text>
              <Text className='page-alerts__td'>命中 / 结果</Text>
              <Text className='page-alerts__td page-alerts__td--status'>状态</Text>
            </View>
            {watches.map((w) => {
              const log = kwLatest.get(w.keyword)
              const g = groupByKey.get(w.keyword)
              const lastRan = log?.ran_at || g?.lastFetchedAt || ''
              return (
                <View key={w.id} className='page-alerts__tr'>
                  <Text className='page-alerts__td page-alerts__td--obj'>{w.keyword}</Text>
                  <Text className='page-alerts__td'>{lastRan ? fromNow(lastRan) : '待首次扫描'}</Text>
                  <Text className='page-alerts__td'>
                    {log ? `新 ${log.hit} / 共 ${g?.items.length ?? log.total}` : g ? `共 ${g.items.length} 条` : '—'}
                  </Text>
                  <Text className={`page-alerts__td page-alerts__td--status page-alerts__status--${log?.status ?? 'pending'}`}>
                    {log ? SCAN_STATUS_LABEL[log.status] : '待扫描'}
                  </Text>
                </View>
              )
            })}
          </View>
        )}

        {/* 执行日志：关键词这一路每次扫描的时间 / 对象 / 命中数 / 成功与否 */}
        {keywordLogs.length > 0 && (
          <View className='page-alerts__logs'>
            <Text className='page-alerts__logs-title'>执行日志（最近 {keywordLogs.length} 次）</Text>
            {keywordLogs.slice(0, 20).map((l) => (
              <View key={l.id} className='page-alerts__log'>
                <Text className={`page-alerts__log-status page-alerts__log-status--${l.status}`}>
                  {SCAN_STATUS_LABEL[l.status]}
                </Text>
                <Text className='page-alerts__log-body'>
                  {formatMoment8(l.ran_at)} · 「{l.object_name}」
                  {l.note ? ` · ${l.note}` : l.hit > 0 ? ` · 命中 ${l.hit} 条` : ''}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* 预警列表：只在「没有任何监测」时走整块空态；只监控了人、没订阅关键词时
          这里整块不渲染（免得摆一句「已开始监测，暂无相关报道」把人误导成关键词也白监测了） */}
      {!userId ? (
        <EmptyState
          title='登录后可用'
          desc='关键词预警与名人监控按账号保存，登录后即可订阅'
        />
      ) : watches.length === 0 && persons.length === 0 ? (
        <EmptyState
          title='还没有监测中的关键词'
          desc='添加一个关键词，或在某人的深度报告页点「监控风险」；有新的公开报道时会汇总到这里'
        />
      ) : watches.length === 0 ? null : loading ? (
        <View className='card page-alerts__hint'>
          <Text>正在读取预警…</Text>
        </View>
      ) : groups.length === 0 ? (
        <View className='card page-alerts__hint'>
          <Text className='page-alerts__hint-title'>已开始监测，暂无相关报道</Text>
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
            <View key={g.keyword} className='card page-alerts__group'>
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
            {`盯的是人物风险：只有命中「司法 / 税务 / 合作 / 维权 / 表态」这类词的报道才会进下方信号列表，其余报道不收。想看 TA 的全部报道，用上面的关键词监控。`}
          </Text>
          <View className='page-alerts__chips'>
            {persons.map((p) => (
              <View
                key={p.id}
                className='page-alerts__chip'
                hoverClass='page-alerts__chip--tap'
                onClick={() => handleUnmonitor(p.person_key ?? '', p.keyword)}
              >
                <Text>{p.keyword}</Text>
                <Text className='page-alerts__chip-x'>×</Text>
              </View>
            ))}
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
          <View className='page-alerts__table'>
            <View className='page-alerts__tr page-alerts__tr--head'>
              <Text className='page-alerts__td page-alerts__td--obj'>监控对象</Text>
              <Text className='page-alerts__td'>最近执行</Text>
              <Text className='page-alerts__td'>命中 / 结果</Text>
              <Text className='page-alerts__td page-alerts__td--status'>状态</Text>
            </View>
            {persons.map((p) => {
              const key = p.person_key ?? ''
              const log = personLatest.get(key)
              const scan = scanByKey.get(key)
              const grp = riskGroupByKey.get(key)
              const lastRan = log?.ran_at || scan?.scanned_at || ''
              return (
                <View key={p.id} className='page-alerts__tr'>
                  <Text className='page-alerts__td page-alerts__td--obj'>{p.keyword}</Text>
                  <Text className='page-alerts__td'>{lastRan ? fromNow(lastRan) : '待首次扫描'}</Text>
                  <Text className='page-alerts__td'>
                    {log
                      ? `新 ${log.hit} / 共 ${scan?.signals_total ?? grp?.signals.length ?? log.total}`
                      : scan
                        ? `共 ${scan.signals_total} 条`
                        : grp
                          ? `共 ${grp.signals.length} 条`
                          : '—'}
                  </Text>
                  <Text className={`page-alerts__td page-alerts__td--status page-alerts__status--${log?.status ?? 'pending'}`}>
                    {log ? SCAN_STATUS_LABEL[log.status] : '待扫描'}
                  </Text>
                </View>
              )
            })}
          </View>

          {/* 执行日志：名人这一路每次扫描的时间 / 对象 / 命中数 / 成功与否 */}
          {personLogs.length > 0 && (
            <View className='page-alerts__logs'>
              <Text className='page-alerts__logs-title'>执行日志（最近 {personLogs.length} 次）</Text>
              {personLogs.slice(0, 20).map((l) => (
                <View key={l.id} className='page-alerts__log'>
                  <Text className={`page-alerts__log-status page-alerts__log-status--${l.status}`}>
                    {SCAN_STATUS_LABEL[l.status]}
                  </Text>
                  <Text className='page-alerts__log-body'>
                    {formatMoment8(l.ran_at)} · 「{l.object_name}」
                    {l.note ? ` · ${l.note}` : l.hit > 0 ? ` · 命中 ${l.hit} 条` : ''}
                  </Text>
                </View>
              ))}
            </View>
          )}
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
