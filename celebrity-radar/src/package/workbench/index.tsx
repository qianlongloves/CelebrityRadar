import { useCallback, useRef, useState } from 'react'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { splitWatches, listWatches } from '@/utils/keyword-alert'
import { loadRiskScans, loadRiskSignals } from '@/utils/risk-watch'
import { loadScanLogs } from '@/utils/scan-log'
import { loadStoredEvents, toDisplayEvents } from '@/utils/opinion-store'
import { readInboxSeen } from '@/utils/inbox'
import { getCachedReports } from '@/utils/cache'
import { readMemberState } from '@/utils/member'
import { canExportReport } from '@/utils/report-export'
import { personWatchLimit } from '@/utils/opinion-access'
import { fromNow } from '@/utils/time'
import { track } from '@/utils/events'
import { openMemberPage } from '@/utils/member-entry'
import {
  BRIEF_SIGNAL_MAX,
  COMPARE_PICK_MAX,
  WORKBENCH_EVENT_MAX,
  buildCompareTable,
  buildWorkbenchBrief,
  buildWorkbenchRows,
  togglePick,
  workbenchExportNote,
  type CompareTable,
  type WorkbenchRow
} from '@/utils/workbench'
import type { OpinionEvent } from '@/utils/opinion-events'
import type { RiskSignalRow } from '@/types/db'
import EmptyState from '@/components/empty-state'
import './index.scss'

/**
 * 监测工作台（S3-2，2026-10-16）：职业用户的横向台账。
 *
 * 三块，各回答一个问题（与 utils/workbench.ts 文件头同一套口径，这里只讲页面自己的取舍）：
 *   ① 多人面板 —— 「我盯的这几个人，今天谁在动」；
 *   ② 勾选批量对比 —— 「谁和谁能放进同一篇东西里」；
 *   ③ 导出简报 —— 「把台账带走」。
 * 明细（每人有哪些信号、每条讲什么）**一概不在这里复制**：那是预警页的事，这里只给数字、
 * 最新一条的标题与跳转。重复一份明细的代价是「两处都要维护、两处都可能过期」。
 *
 * 与预警页的两处刻意差异：
 *   · 本页**不推进**「风险信号已看」水位（预警页进页时调 markModuleSeen）。工作台是台账，
 *     进来扫一眼不该把角标清掉 —— 清角标是「我看过这些信号了」的意思，那件事发生在预警页。
 *   · 本页**不发「立即扫描」**（同预警页取舍：检索一次就是一次上游计费，成本开关不交给点击频率）。
 *
 * 事件跟踪读的是与事件页同一个读口（loadStoredEvents），只筛「命中我监控的人」那一部分，
 * 取前 WORKBENCH_EVENT_MAX 条，其余交给事件页 —— 本页不越加载越长。
 */
export default function Workbench() {
  const { userId } = useAuth()
  /** 只用来读 `from`：两页互相有入口，回跳方式取决于从哪儿来（见 goAlerts） */
  const router = useRouter()

  /** 面板行（已按最近动静排好序，见 utils/workbench#buildWorkbenchRows） */
  const [rows, setRows] = useState<WorkbenchRow[]>([])
  /** 与我监控的人相关的事件（预览） */
  const [events, setEvents] = useState<OpinionEvent[]>([])
  const [isMember, setIsMember] = useState(false)
  /** 勾选中的人（顺序 = 勾选顺序，决定对比表的列序） */
  const [picked, setPicked] = useState<string[]>([])
  /** 已生成的对比表；null = 还没点「对比」（或勾选变了被作废） */
  const [table, setTable] = useState<CompareTable | null>(null)
  /** 导出被拦时那一行说明（非弹窗，同报告页口径） */
  const [exportNote, setExportNote] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  /** 原始信号：导出简报要按人取「最近几条带出处的」，而面板行只留了最新一条 */
  const signalsRef = useRef<RiskSignalRow[]>([])
  /** 我订阅的关键词：写进简报的名单，让这份文件自己说得清「我在盯什么」 */
  const keywordsRef = useRef<string[]>([])

  const refresh = useCallback(async () => {
    if (!userId) {
      setRows([])
      setEvents([])
      setLoading(false)
      return
    }
    /*
     * 一次 listWatches 拿到整张表，再用 splitWatches 拆开：监控的人与订阅的词同住
     * keyword_watches（靠 type 区分），分两次读（listPersonWatches + listWatches）是两倍往返，
     * 而两者永远要一起用（名单与关键词都要进简报）。拆分规则收在 splitWatches 一处。
     */
    const all = await listWatches()
    const { keywords, persons: personRows } = splitWatches(all)
    keywordsRef.current = keywords.map((w) => w.keyword)
    const member = (await readMemberState()).member
    setIsMember(member)

    const persons = personRows
      .map((p) => ({ personKey: p.person_key ?? '', name: p.keyword }))
      .filter((p) => !!p.personKey)
    const keys = persons.map((p) => p.personKey)

    const [signals, scans, logs] = await Promise.all([
      loadRiskSignals(keys),
      loadRiskScans(keys),
      loadScanLogs('person', keys)
    ])
    signalsRef.current = signals
    setRows(
      buildWorkbenchRows({
        persons,
        signals,
        scans,
        logs,
        /* 水位只读不用：本页不推进它（见文件头），所以每次进来看到的都是「相对上次在预警页查看」 */
        seenMs: readInboxSeen().risk ?? null
      })
    )
    setLoading(false)

    /* 事件跟踪：与事件页同一读口，只留「命中我监控的人」；读失败按「没有事件」处理（同事件页口径） */
    const stored = await loadStoredEvents().catch(() => null)
    const relevant = stored
      ? toDisplayEvents(
          stored,
          { watchNames: persons.map((p) => p.name) }
        ).filter((e) => e.hitsFollow)
      : []
    setEvents(relevant.slice(0, WORKBENCH_EVENT_MAX))
  }, [userId])

  useDidShow(() => {
    void refresh()
  })

  /**
   * 勾选 / 取消。选择一变就把已生成的对比表作废 —— 否则会看着一张与勾选不符的表，
   * 而那种「数字对不上我选的人」的错最难被发现（表本身没有任何问题）。
   */
  const onToggle = (personKey: string) => {
    const res = togglePick(picked, personKey)
    if (res.rejected) {
      Taro.showToast({ title: `最多同时对比 ${COMPARE_PICK_MAX} 位`, icon: 'none' })
      return
    }
    setPicked(res.picked)
    setTable(null)
  }

  /**
   * 对比：读**已缓存报告**（零生成成本），把每人挂到一列上。
   * 没生成过的人照样进表（标未生成 + 生成入口），**不替他筛掉** —— 筛掉会让人以为这个人没问题。
   */
  const onCompare = async () => {
    if (busy) return
    if (picked.length < 2) {
      Taro.showToast({ title: '至少勾选 2 位才能对比', icon: 'none' })
      return
    }
    setBusy(true)
    const reports = await getCachedReports(picked)
    const items = picked.map((key, i) => ({
      personKey: key,
      name: rows.find((r) => r.personKey === key)?.name,
      report: reports[i] ?? null
    }))
    setTable(buildCompareTable(items))
    setBusy(false)
    track('workbench_compare', {
      count: picked.length,
      cached: items.filter((it) => !!it.report).length
    })
  }

  /**
   * 导出简报：会员能力（门禁复用 canExportReport，与报告导出同一个出口判定）。
   * 免费用户**不弹窗**，只在按钮下方补一行说明 —— 弹窗会把「看一眼入口」变成一次打断。
   */
  const onExport = async () => {
    if (busy) return
    if (!canExportReport(isMember)) {
      setExportNote(true)
      track('workbench_export', { allowed: false })
      return
    }
    /* 按人分组：面板行只留了最新一条，而简报每人要带最近几条 */
    const byPerson: Record<string, RiskSignalRow[]> = {}
    for (const s of signalsRef.current) {
      if (!s?.person_key) continue
      const list = byPerson[s.person_key]
      if (list) list.push(s)
      else byPerson[s.person_key] = [s]
    }
    const brief = buildWorkbenchBrief({ rows, signalsByPerson: byPerson, keywords: keywordsRef.current })
    if (!brief) {
      Taro.showToast({ title: '还没有可导出的监控对象', icon: 'none' })
      return
    }
    setBusy(true)
    try {
      await Taro.setClipboardData({ data: brief.markdown })
      track('workbench_export', { allowed: true, persons: brief.personCount, signals: brief.signalCount })
      await Taro.showModal({
        title: '已复制到剪贴板',
        content: `监测简报（Markdown）：${brief.personCount} 位监控对象 / ${brief.signalCount} 条带出处信号。可粘贴到备忘录或文档中，每条信号都附了原文链接。`,
        showCancel: false,
        confirmText: '知道了'
      })
    } finally {
      setBusy(false)
    }
  }

  const goReport = (personKey: string) =>
    void Taro.navigateTo({ url: `/package/report/index?personKey=${encodeURIComponent(personKey)}` })

  /**
   * 回预警页（2026-10-17 修栈环）：两页互相有入口，若两个方向都 `navigateTo`，
   * 来回点几次就把页面栈顶到微信 10 层上限 —— 之后**所有**跳转静默失败（表现为「点了没反应」），
   * 用户唯一能做的就是杀掉小程序重进。
   *
   * 判据看 `from=alerts`（预警页进来时带的）：
   *   · 从预警页来的 ⇒ `navigateBack()`：栈里那一页就是它，退回去既省钱又保住它的滚动位置；
   *   · 从「我的」或别处进来的 ⇒ `redirectTo`：本页是台账、预警页是明细，两者是同一件事的
   *     两个视图，用替换语义（栈不增长，导航栏返回退回「我的」，符合从哪儿来回哪儿去）。
   * ⚠ 不能用 `navigateBack()` 一把梭：从「我的」进来时栈里上一页是「我的」，点「看每人的
   * 信号明细」却退到「我的」—— 功能跳转被做成了返回，用户找不到预警页。
   */
  const fromAlerts = router.params?.from === 'alerts'
  const goAlerts = () => {
    if (fromAlerts) {
      void Taro.navigateBack()
      return
    }
    void Taro.redirectTo({ url: '/package/alerts/index' })
  }
  const goEvents = () => void Taro.navigateTo({ url: '/package/events/index' })

  const goEvent = (ev: OpinionEvent) =>
    void Taro.navigateTo({
      url: `/package/event/index?eventKey=${encodeURIComponent(ev.key)}&title=${encodeURIComponent(ev.title)}`
    })

  const cap = personWatchLimit(isMember)
  const activeCount = rows.filter((r) => !!r.latestSignalAt).length

  if (!userId) {
    return (
      <View className='page-workbench'>
        <EmptyState title='登录后可用' desc='监控工作台按账号保存，登录后即可查看你监控的人' />
      </View>
    )
  }

  return (
    <View className='page-workbench'>
      {loading ? (
        <View className='card page-workbench__hint'>
          <Text>正在读取监测名单…</Text>
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          title='还没有监控中的人'
          desc='在某个人的深度报告页点「监控此人」；有风险信号时这里会给出横向台账，并可勾选对比'
        />
      ) : (
        <>
          <View className='card'>
            <View className='card-title'>监测概览</View>
            <Text className='page-workbench__intro'>
              {activeCount > 0
                ? `正在监控 ${rows.length}/${cap} 位，其中 ${activeCount} 位最近有公开信号。`
                : `正在监控 ${rows.length}/${cap} 位，暂时都没有命中风险词的公开报道。`}
            </Text>
            <Text className='page-workbench__intro'>
              这里只做横向台账：谁在动、动的是什么。每人的全部信号明细在预警页。
            </Text>
            {rows.length >= cap && !isMember && (
              <View
                className='page-workbench__limit'
                hoverClass='page-workbench__limit--tap'
                onClick={() => openMemberPage('workbench')}
              >
                <Text className='page-workbench__limit-text'>{`免费档最多监控 ${cap} 位`}</Text>
                <Text className='page-workbench__limit-go'>看会员额度 ›</Text>
              </View>
            )}
          </View>

          {/* ① 多人面板：一人一行，按最近动静排序 */}
          <View className='card'>
            <View className='card-title'>多人面板</View>
            <Text className='page-workbench__intro'>
              按最近动静排序：有新信号的在最上面。勾选 2~{COMPARE_PICK_MAX} 位可横向对比。
            </Text>

            <View className='page-workbench__table'>
              <View className='page-workbench__tr page-workbench__tr--head'>
                <Text className='page-workbench__td page-workbench__td--obj'>监控对象</Text>
                <Text className='page-workbench__td'>最近执行</Text>
                <Text className='page-workbench__td'>命中 / 累计</Text>
                <Text className='page-workbench__td page-workbench__td--status'>状态</Text>
              </View>
              {rows.map((r) => {
                const on = picked.includes(r.personKey)
                return (
                  <View
                    key={r.personKey}
                    className={`page-workbench__tr${on ? ' page-workbench__tr--on' : ''}`}
                    hoverClass='page-workbench__tr--tap'
                    onClick={() => onToggle(r.personKey)}
                  >
                    <View className='page-workbench__td page-workbench__td--obj'>
                      <View className={`page-workbench__check${on ? ' page-workbench__check--on' : ''}`}>
                        {on ? <Text className='page-workbench__check-mark'>✓</Text> : null}
                      </View>
                      <View className='page-workbench__obj-body'>
                        <Text className='page-workbench__obj-name'>{r.name}</Text>
                        {/* 第二行给「最新一条是什么」——只给数字的话，看到「新 3 条」还得再跳一次才知道是什么事 */}
                        <Text className='page-workbench__obj-sub'>
                          {r.latestTitle || (r.signalTotal > 0 ? '有信号，标题缺失' : '暂无信号')}
                        </Text>
                      </View>
                    </View>
                    <Text className='page-workbench__td'>
                      {r.lastRanAt ? fromNow(r.lastRanAt) : '待首次扫描'}
                    </Text>
                    <Text className='page-workbench__td'>
                      {r.newHits === null ? `共 ${r.signalTotal}` : `新 ${r.newHits} / 共 ${r.signalTotal}`}
                    </Text>
                    <Text className='page-workbench__td page-workbench__td--status'>{r.statusText}</Text>
                  </View>
                )
              })}
            </View>

            <View className='page-workbench__actions'>
              <Text className='page-workbench__picked'>{`已选 ${picked.length}/${COMPARE_PICK_MAX}`}</Text>
              <View
                className={`page-workbench__btn${picked.length < 2 || busy ? ' page-workbench__btn--off' : ''}`}
                hoverClass='page-workbench__btn--tap'
                onClick={() => void onCompare()}
              >
                <Text>{busy ? '正在对比…' : `对比这 ${picked.length} 位`}</Text>
              </View>
            </View>
          </View>

          {/* ② 对比结果：列 = 人、行 = 指标（同一指标横着扫一眼才知道谁多谁少） */}
          {table && (
            <View className='card'>
              <View className='card-title'>横向对比</View>
              <View className='page-workbench__cmp'>
                <View className='page-workbench__cmp-tr page-workbench__cmp-tr--head'>
                  <Text className='page-workbench__cmp-label'>指标</Text>
                  {table.rows.map((r) => (
                    <Text key={r.personKey} className='page-workbench__cmp-cell'>
                      {r.cached ? r.name : `${r.name}（未生成）`}
                    </Text>
                  ))}
                </View>
                {table.metrics.filter((m) => !m.blank).map((m) => (
                  <View key={m.key} className='page-workbench__cmp-tr'>
                    <Text className='page-workbench__cmp-label'>{m.label}</Text>
                    {m.cells.map((c, i) => (
                      <Text key={table.rows[i].personKey} className='page-workbench__cmp-cell'>
                        {c.text}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
              <Text className='page-workbench__note'>
                只搬运已生成报告里的字段，不做任何综合评分 —— 谁更重要是你的判断，不是平台的。
              </Text>
              {table.rows.some((r) => !r.cached) && (
                <View className='page-workbench__gen'>
                  <Text className='page-workbench__gen-tip'>
                    未生成的人没有可比字段：报告是全站共享缓存，生成一次所有人共用一份。
                  </Text>
                  {table.rows
                    .filter((r) => !r.cached)
                    .map((r) => (
                      <View
                        key={r.personKey}
                        className='page-workbench__gen-btn'
                        hoverClass='page-workbench__gen-btn--tap'
                        onClick={() => goReport(r.personKey)}
                      >
                        <Text>{`生成「${r.name}」的报告`}</Text>
                      </View>
                    ))}
                </View>
              )}
            </View>
          )}

          {/* ③ 事件跟踪：我监控的人卷进了哪些事件 */}
          <View className='card'>
            <View className='card-title'>事件跟踪</View>
            {events.length === 0 ? (
              <Text className='page-workbench__intro'>
                暂时没有与监控对象相关的公开事件。事件按「同一件事的多篇报道」聚合，出现后会汇总到这里。
              </Text>
            ) : (
              <>
                <Text className='page-workbench__intro'>
                  {`最近与监控对象相关的公开事件（显示 ${events.length} 条）。`}
                </Text>
                {events.map((ev) => (
                  <View
                    key={ev.key}
                    className='page-workbench__event'
                    hoverClass='page-workbench__event--tap'
                    onClick={() => goEvent(ev)}
                  >
                    <Text className='page-workbench__event-title'>{ev.title}</Text>
                    <Text className='page-workbench__event-meta'>
                      {[`${ev.memberTotal} 条来源`, ev.date ? fromNow(ev.date) : ''].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ))}
              </>
            )}
            <View className='page-workbench__more' hoverClass='page-workbench__more--tap' onClick={goEvents}>
              <Text>查看全部事件 ›</Text>
            </View>
            <View className='page-workbench__more' hoverClass='page-workbench__more--tap' onClick={goAlerts}>
              <Text>看每人的信号明细（预警页）›</Text>
            </View>
          </View>

          {/* ④ 导出：把台账带走（会员能力，免费只多一行说明） */}
          <View className='card'>
            <View className='card-title'>导出监测简报</View>
            <Text className='page-workbench__intro'>
              {`把上面的名单与每人最近 ${BRIEF_SIGNAL_MAX} 条带原文链接的信号拼成 Markdown，复制到剪贴板，可进文档与表格逐条核对。`}
            </Text>
            <View
              className={`page-workbench__btn page-workbench__btn--wide${busy ? ' page-workbench__btn--off' : ''}`}
              hoverClass='page-workbench__btn--tap'
              onClick={() => void onExport()}
            >
              <Text>导出简报（Markdown）</Text>
            </View>
            {exportNote && <Text className='page-workbench__note'>{workbenchExportNote()}</Text>}
          </View>

          <Text className='disclaimer'>
            监测与事件均来自公开报道的检索结果，只反映「最近被报道的量」，不代表平台对任何人的评价；
            横向对比只搬运已生成报告里的字段。
          </Text>
        </>
      )}
    </View>
  )
}
