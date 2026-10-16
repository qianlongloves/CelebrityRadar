import { useCallback, useRef, useState } from 'react'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { readMemberState } from '@/utils/member'
import { decodeParam } from '@/utils/route'
import { clipText } from '@/utils/text'
import { fromNow } from '@/utils/time'
import { track } from '@/utils/events'
import {
  canViewVersionReport,
  heldText,
  loadReportVersions,
  loadVersionReport,
  newsDeltaText,
  versionHistoryNote,
  type VersionBoard,
  type VersionListRow
} from '@/utils/report-versions'
import type { Report } from '@/utils/report'
import EmptyState from '@/components/empty-state'
import './index.scss'

/**
 * 报告历史版本（S3-1 ③，2026-10-16）。
 *
 * 报告是**全站共享缓存**：一人一份、`force` 重生即整篇替换 —— 过去这意味着「上一版说了什么」
 * 不可回溯。这一页把被覆盖掉的旧版列出来，让「这次改了什么」可查。
 *
 * 三处页面自己的取舍（模块级口径见 utils/report-versions.ts 的文件头）：
 *
 * ① **免费看到列表、会员才能打开正文**。把「更新过几次」藏起来，用户根本不知道有这能力
 *    （列表就是入口，也就是转化的理由）；但「回看旧版全文」正是 S3-1 要卖的**能力**本身，
 *    也免费就等于这条付费线少一块。被拦下时只多**一行**说明（非弹窗，同报告页 / 工作台口径）。
 *
 * ② **这一页只做「摘要」，不复制报告页的版式**。旧版正文的完整呈现需要报告页那一整套
 *    分节渲染，在这里复刻一份等于维护两套、且必然漂移（同工作台「明细一概不复制」）。
 *    这里给的是「时间 / 素材条数 / 这一版的判断与叙述」——足够回答「上次是怎么说的」，
 *    需要完整版式就点「看当前版」。
 *
 * ③ **不做「哪一版更好」的评价**。只并列事实（素材多了还是少了、用了多久），
 *    同工作台对比表的取舍：一旦平台替用户排序，他看到的就不是自己的判断了。
 *
 * ⚠ 旧版正文**必须**经 `utils/report-versions#loadVersionReport` 取（内部走
 *   `cache.ts#exposeReport` 按当前读者身份过滤）：旧版里可能带着当时会员生成的段落，
 *   直接读库渲染就是给免费读者发会员内容。
 */
export default function ReportHistory() {
  const { userId } = useAuth()
  const router = useRouter()
  const personKey = decodeParam(router.params.personKey || '')
  const nameParam = decodeParam(router.params.name || '')

  const [loading, setLoading] = useState(true)
  const [board, setBoard] = useState<VersionBoard>({ rows: [], current: null })
  const [isMember, setIsMember] = useState(false)
  /** 正在展开的那一版（`null` = 都收着） */
  const [openId, setOpenId] = useState<string | null>(null)
  /** 展开版的正文（已按读者身份过滤）。`null` 且 `openId` 非空 = 正在读 / 读不到 */
  const [openReport, setOpenReport] = useState<Report | null>(null)
  const [openBusy, setOpenBusy] = useState(false)
  /** 会员墙的那一行说明（免费点开时出现，非弹窗） */
  const [noteVisible, setNoteVisible] = useState(false)
  /** 进页埋点只报一次：`useDidShow` 每次切回都会重跑 */
  const viewedRef = useRef(false)

  const load = useCallback(async () => {
    if (!personKey) {
      setLoading(false)
      return
    }
    const [state, versions] = await Promise.all([readMemberState(), loadReportVersions(personKey)])
    setIsMember(state.member)
    setBoard(versions)
    setLoading(false)
    if (!viewedRef.current) {
      viewedRef.current = true
      /* count 是这一页最关键的分母：0 说明「这份报告从没更新过」，那一页里根本没有东西可看 */
      track('report_history_view', { personKey, count: versions.rows.length, member: state.member })
    }
  }, [personKey])

  useDidShow(() => {
    void load()
  })

  /**
   * 受控展开：再点一次收起（并清掉正文，别把一份旧报告留在内存里）。
   * 免费用户点「看这一版」不进这里，只显示那一行说明 —— 数据也不会被读下来（不是「读了不显示」）。
   */
  const onOpen = useCallback(
    async (row: VersionListRow) => {
      if (openId === row.id) {
        setOpenId(null)
        setOpenReport(null)
        return
      }
      setNoteVisible(false)
      if (!canViewVersionReport(isMember)) {
        /* allowed:false 也报：否则会员墙的转化分母消失（同 report_export / workbench_export） */
        track('report_version_open', {
          personKey,
          allowed: false,
          ...(typeof row.heldMs === 'number' ? { heldDays: Math.round(row.heldMs / 86400000) } : {})
        })
        setNoteVisible(true)
        return
      }
      setOpenId(row.id)
      setOpenReport(null)
      setOpenBusy(true)
      try {
        const report = await loadVersionReport(row.id, isMember)
        setOpenReport(report)
        track('report_version_open', {
          personKey,
          allowed: true,
          ...(typeof row.heldMs === 'number' ? { heldDays: Math.round(row.heldMs / 86400000) } : {})
        })
      } finally {
        setOpenBusy(false)
      }
    },
    [openId, isMember, personKey]
  )

  const goCurrent = () =>
    void Taro.navigateTo({ url: `/package/report/index?personKey=${encodeURIComponent(personKey)}` })

  const title = nameParam || board.rows[0]?.name || '这份报告'

  if (!personKey) {
    return (
      <View className='page-report-history'>
        <EmptyState title='缺少人物参数' desc='请从报告页进入「历史版本」，或先搜索一位名人' />
      </View>
    )
  }

  if (loading) {
    return (
      <View className='page-report-history'>
        <View className='card page-report-history__hint'>
          <Text>正在读取历史版本…</Text>
        </View>
      </View>
    )
  }

  return (
    <View className='page-report-history'>
      <View className='card'>
        <View className='card-title'>{`${title} · 历史版本`}</View>
        {board.current ? (
          <Text className='page-report-history__intro'>
            {`当前版生成于 ${fromNow(board.current.generatedAt)}（素材 ${board.current.newsCount} 条）。下面每一版都是被它换掉的那一版。`}
          </Text>
        ) : (
          <Text className='page-report-history__intro'>
            这份报告还没有当前版。下面每一版都是曾经存在过、之后被换掉的版本。
          </Text>
        )}
        <Text className='page-report-history__intro'>
          报告是全网共享的一份：任何人刷新都会覆盖旧版，所以旧版不会一直留着 —— 只保留最近几版。
        </Text>
      </View>

      {board.rows.length === 0 ? (
        <EmptyState
          title='还没有更新过的版本'
          desc='这份报告从生成到现在没有被刷新过。等它下次更新后，这里就会出现「上一版是怎么写的」'
        />
      ) : (
        board.rows.map((row) => {
          const on = openId === row.id
          const delta = newsDeltaText(row.newsDelta)
          const held = heldText(row.heldMs)
          return (
            <View className='card page-report-history__ver' key={row.id}>
              <View className='page-report-history__head'>
                <View className='page-report-history__when'>
                  <Text className='page-report-history__gen'>{`${fromNow(row.generatedAt)} 生成`}</Text>
                  <Text className='page-report-history__sub'>{`${fromNow(row.replacedAt)} 被换掉`}</Text>
                </View>
                <View
                  className={`page-report-history__btn${on ? ' page-report-history__btn--on' : ''}`}
                  hoverClass='page-report-history__btn--tap'
                  onClick={() => void onOpen(row)}
                >
                  <Text>{on ? '收起' : '看这一版'}</Text>
                </View>
              </View>

              <View className='page-report-history__facts'>
                <Text className='page-report-history__fact'>{`素材 ${row.newsCount} 条`}</Text>
                {/* 三项都可能算不出来（时间戳缺失 / 没有可比对象），算不出就整块不显示，不写「—」 */}
                {held ? <Text className='page-report-history__fact'>{`在线上待了 ${held}`}</Text> : null}
                {delta ? <Text className='page-report-history__fact'>{delta}</Text> : null}
              </View>

              {on && (
                <View className='page-report-history__body'>
                  {openBusy ? (
                    <Text className='page-report-history__hint'>正在读取这一版…</Text>
                  ) : !openReport ? (
                    <Text className='page-report-history__hint'>
                      这一版已经读不到了（可能已被更久的新版本挤掉）。
                    </Text>
                  ) : (
                    <>
                      <VersionSummary report={openReport} />
                      <Text className='page-report-history__note'>
                        这里只列这一版报告里实际有的关键内容；完整版式请查看当前版。
                      </Text>
                    </>
                  )}
                </View>
              )}
            </View>
          )
        })
      )}

      {noteVisible && (
        <View
          className='card page-report-history__wall'
          hoverClass='page-report-history__wall--tap'
          onClick={() => void Taro.navigateTo({ url: '/package/member/index' })}
        >
          <Text className='page-report-history__wall-text'>{versionHistoryNote()}</Text>
          <Text className='page-report-history__wall-go'>看会员权益 ›</Text>
        </View>
      )}

      <View className='card page-report-history__foot'>
        <View
          className='page-report-history__btn page-report-history__btn--wide'
          hoverClass='page-report-history__btn--tap'
          onClick={goCurrent}
        >
          <Text>看当前版 ›</Text>
        </View>
        {!userId && (
          <Text className='page-report-history__note'>未登录也能看历史版本，登录后可用会员能力。</Text>
        )}
      </View>
    </View>
  )
}

/**
 * 某一版的摘要（**只列真实存在的字段**）。
 *
 * 选择「字段不存在就整行不显示」而不是显示「—」：老报告本来就可能没有 verdict / profile
 * 这些后来才加的键，写「—」会被读成「这一版这几项是空的」——而其实是我们当时还没问模型要。
 * 缺失**不解释**比缺失**被解释错**好。
 *
 * 文本一律 `clipText` 截断：这一页是「回看上次怎么说的」，不是全文阅读器（完整版式在当前版）。
 */
function VersionSummary({ report }: { report: Report }) {
  const rows: Array<{ label: string; value: string }> = []
  rows.push({ label: '热度', value: String(report.heat) })
  const intro = clipText(report.intro, 140)
  if (intro) rows.push({ label: '简介', value: intro })
  const verdict = clipText(report.verdict?.summary, 160)
  if (verdict) rows.push({ label: '一句话结论', value: verdict })
  const analysis = clipText(report.analysis, 200)
  if (analysis) rows.push({ label: '点评', value: analysis })
  /* 条数：给的是「这一版有多少条」，与当前版的条数对照着看就知道这次变动大不大 */
  rows.push({
    label: '内容条数',
    value: `动态 ${report.dynamics?.length ?? 0} · 争议 ${report.controversies?.length ?? 0} · 关系 ${report.relations?.length ?? 0} · 档案 ${report.profile?.length ?? 0}`
  })
  const generated = fromNow(report.generatedAt)
  if (generated) rows.push({ label: '生成时间', value: generated })

  return (
    <View className='page-report-history__summary'>
      {rows.map((r) => (
        <View className='page-report-history__row' key={r.label}>
          <Text className='page-report-history__label'>{r.label}</Text>
          <Text className='page-report-history__value'>{r.value}</Text>
        </View>
      ))}
    </View>
  )
}
