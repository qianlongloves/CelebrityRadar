import { useState } from 'react'
import Taro, { useDidShow, useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtButton } from 'taro-ui'
import Skeleton from '@/components/skeleton'
import { DOMAIN_META, DomainCode, parsePersonKey } from '@/config/domains'
import EmptyState from '@/components/empty-state'
import QuoteDetail from '@/components/quote-detail'
import { getCachedReport } from '@/utils/cache'
import { quoteCopyText } from '@/utils/quote-check'
import { Report } from '@/utils/report'
import { isFollowed, toggleFollow } from '@/utils/follows'
import { personShareTitle, reportSharePath } from '@/utils/share'
import { fromNow } from '@/utils/time'
import { buildProfileStats } from '@/utils/stats'
import './index.scss'

/** 日期正序（缺日期的排最后）：时间线是履历脉络，从早到晚读才顺（与报告页同一口径） */
function byDateAsc(a: string, b: string): number {
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b)
}

/** 老报告缺 coverage 时报道量给「—」：0 是「查过但没有」，缺字段是「没有这项数据」，不能混 */
function num(v: number | null): string {
  return v === null ? '—' : String(v)
}

/** 名人主页（M2 简版动态 / 名言双 Tab + V1.5 时间线 Tab，数据读报告缓存，不触发生成） */
export default function Profile() {
  const router = useRouter()
  const personKey = decodeURIComponent(router.params.personKey || '')
  const parsed = parsePersonKey(personKey)
  const name = parsed?.name ?? '名人'
  const domain: DomainCode = parsed?.domain ?? 'other'

  const [loading, setLoading] = useState(true)
  const [report, setReport] = useState<Report | null>(null)
  const [followed, setFollowed] = useState(false)
  const [tab, setTab] = useState(0)

  /**
   * 转发（优化建议 O-13）。
   *
   * 本页此前没注册任何分享回调：右上角「转发」带出的是一个**不含参数的地址**，
   * 对方点开落在「缺少 personKey」的错误态 —— 名人主页是最常被分享的页面之一，
   * 分享链路却一直是断的。
   *
   * 落地页统一落到报告页（见 utils/share.ts 的口径）：分享一个名人时，对方想看的
   * 正是「这个人是谁」，报告页是唯一点开就看得懂的内容，而 tabBar 页也不能作落地页。
   * 本页只是「转发」的出发点，标题与报告页、发现页、提问页同源。
   */
  const sharePath = reportSharePath(personKey)
  const shareTitle = personShareTitle(name, domain, report)
  useShareAppMessage(() => ({ title: shareTitle, path: sharePath }))
  useShareTimeline(() => ({ title: shareTitle, query: sharePath.split('?')[1] ?? '' }))

  const load = async () => {
    setLoading(true)
    const [r, f] = await Promise.all([getCachedReport(personKey), isFollowed(personKey)])
    setReport(r)
    setFollowed(f)
    setLoading(false)
  }

  useDidShow(() => {
    void load()
  })

  const goReport = () => {
    Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}` })
  }

  const onToggleFollow = async () => {
    const next = await toggleFollow(personKey, 'profile')
    /* null = 失败或未登录：follows.ts 已给出原因 toast，不更新按钮态（原先会误报取关成功） */
    if (next === null) return
    setFollowed(next)
    Taro.showToast({ title: next ? '已关注' : '已取消关注', icon: 'none' })
  }

  const heat = report?.heat ?? 0
  /* 时间线从早到晚（模型返回顺序不保证）；无报告时为空数组 */
  const timelineView = report ? [...report.timeline].sort((a, b) => byDateAsc(a.date, b.date)) : []

  /**
   * 数据 Tab（M2-4）：全部是对**已缓存报告**的本地统计 —— 进这一页不抓取、不调模型、
   * 不消耗生成额度，存量报告立即生效（聚合口径与成立门槛见 utils/stats.ts）。
   */
  const stats = report ? buildProfileStats(report) : null

  /**
   * Tab 定义：标题与计数分开放。计数不塞进标题括号（「时间线 (12)」）——
   * 四格等分下这种长标题会被挤到省略号，而计数本来就是次要信息，给它小一号字更清楚。
   */
  const tabs: { label: string; count: number | null }[] = report
    ? [
        { label: '动态', count: report.dynamics.length },
        { label: '名言', count: report.quotes.length },
        { label: '时间线', count: report.timeline.length },
        { label: '数据', count: null }
      ]
    : []

  /* 曝光度脚注：把热度公式的两个输入摆出来，别让热度继续当玄学数字（§1.6） */
  const exposureNote = (() => {
    const e = stats?.exposure
    if (!e) return ''
    if (!e.hasCoverage) {
      return '这份报告生成于报道画像上线前，报道量暂不可用；重新生成可补齐（热度本身仍然有效）。'
    }
    const range = e.firstAt && e.latestAt ? `素材覆盖 ${e.firstAt} ~ ${e.latestAt}；` : ''
    return `${range}热度由近 30 天报道（六成）与近 7 天报道（四成）按固定公式算出，两个输入都可逐条核对。`
  })()

  const sourceNote = (() => {
    const s = stats?.sources
    if (!s) return ''
    const parts = [`共统计 ${s.total} 条带来源标注的动态（${s.families} 家媒体）`]
    if (s.others > 0) parts.push(`另有 ${s.others} 条来自其它 ${s.otherFamilies} 家`)
    if (s.unknown > 0) parts.push(`${s.unknown} 条无来源标注`)
    return `${parts.join('；')}。条形以条数最多的一家为满格。`
  })()

  /**
   * 来源×情绪脚注。**这句口径必须写**：`sentiment` 是逐条报道的写法，不是该媒体的编辑方针。
   * 不写，读者会把它读成「这家媒体就是反他的」—— 那是个素材撑不住的结论（卡名也因此
   * 叫「来源 × 情绪」而不是「媒体立场」）。
   */
  const tiltNote = (() => {
    const t = stats?.tilt
    if (!t) return ''
    const hidden = t.hidden > 0 ? `，另有 ${t.hidden} 条来自 ${t.hiddenFamilies} 家，因单家条数过少未单列` : ''
    return `配色与「情绪构成」一致。共统计 ${t.total} 条可判定来源的动态（${t.families} 家媒体），下列 ${t.items.length} 家各自达到可比较的条数${hidden}。条数过少的来源不参与对照 —— 一条报道代表不了一家媒体的口径，列出来只会误导。此处标注的是本报告收录的这几条报道的写法，不代表该媒体的整体立场。`
  })()

  /** 素材可信度脚注：把「独立事件」「重复率」的判定口径摊开，说明它是启发式而非精确去重 */
  const credibilityNote = (() => {
    const c = stats?.credibility
    if (!c) return ''
    const shared = c.shared > 0 ? `其中 ${c.shared} 件被 2 家及以上来源报道，` : ''
    const first = c.first ? ` 首报为 ${c.first.date}（${c.first.source}）。` : ''
    return `基于本报告收录的 ${c.total} 条动态：${c.families} 家来源、${c.events} 件独立事件，${shared}重复报道 ${c.repeated} 条（约 ${Math.round(
      c.repeatRatio * 100
    )}%）。同一事件按标题文本归并，属启发式口径。${first}`
  })()

  /** 情绪走势脚注：说明柱高与色块各是什么，以及为什么至少两个月才出这张卡 */
  const trendNote = (() => {
    const t = stats?.sentimentTrend
    if (!t) return ''
    return `横轴为月份（${t.from} ~ ${t.to}），柱高为该月带日期动态的条数（同月同一说法只计一次），色块为其中的情绪构成，共 ${t.total} 条。至少两个月有数据才出这张卡 —— 只有一根柱子那是构成，不是走势。`
  })()

  const pct = (n: number, total: number): string => `${Math.round((n / total) * 100)}%`

  return (
    <View className='page-profile safe-bottom'>
      <View className='card page-profile__info'>
        <View className='page-profile__row'>
          <View className='page-profile__avatar'>{name.slice(0, 1)}</View>
          <View className='page-profile__meta'>
            <View className='page-profile__name-row'>
              <Text className='page-profile__name'>{name}</Text>
              <View className={`chip chip--${domain}`}>{DOMAIN_META[domain].label}</View>
            </View>
            <View className='text-tertiary'>
              {report ? `报告生成于 ${fromNow(report.generatedAt)}` : '公开信息整理 · 头像为占位'}
            </View>
          </View>
        </View>
        <View className='page-profile__heat'>
          <Text className='text-secondary'>热度</Text>
          <View className='heat__bar'>
            <View className='heat__bar-fill' style={{ width: `${Math.min(100, heat)}%` }} />
          </View>
          <Text className='page-profile__heat-value'>{heat} / 100</Text>
        </View>
        <View className='page-profile__actions'>
          <AtButton type='secondary' size='small' className='page-profile__btn' onClick={goReport}>
            深度报告
          </AtButton>
          <AtButton
            type='secondary'
            size='small'
            className='page-profile__btn page-profile__btn--ghost'
            onClick={() => void onToggleFollow()}
          >
            {followed ? '已关注' : '+ 关注'}
          </AtButton>
        </View>
      </View>

      {loading && <Skeleton variant='card' rows={3} />}

      {!loading && !report && (
        <EmptyState
          icon='🗂'
          title='还没有生成过报告'
          desc='生成后将在这里展示 TA 的近期动态、经典名言与经历时间线'
          actionText='生成深度报告'
          onAction={goReport}
        />
      )}

      {!loading && report && stats && (
        <View>
          {/*
            分段控件是自绘的（不用 taro-ui 的 AtTabs）：AtTabs 的样式是「整宽灰条 +
            每格一条满宽紫下划线」，下划线还靠绝对定位放在 __body 里、宽为 100% × N，
            没有 positioned 祖先时会挂到视口左上角；4 个带计数的标题挤在 flex:1 的
            格子里还会被 ellipsis 截成「时间线 (1…」。覆盖它要写五六条规则，
            不如自绘一个胶囊分段器，样式与项目紫色主题一处定义、一处可改。
          */}
          <View className='page-profile__tabs'>
            {tabs.map((t, i) => (
              <View
                key={t.label}
                className={`page-profile__tab${i === tab ? ' page-profile__tab--active' : ''}`}
                hoverClass='page-profile__tab--tap'
                onClick={() => setTab(i)}
              >
                <Text className='page-profile__tab-label'>{t.label}</Text>
                {t.count !== null && <Text className='page-profile__tab-count'>{t.count}</Text>}
              </View>
            ))}
          </View>

          {/*
            切页用条件渲染而不是 AtTabsPane 的横向轨道：轨道要求所有面板常驻
            （body 带 white-space:nowrap，靠 translate3d(-current*100%) 平移），
            既让非当前面板白占一层 DOM，又把 nowrap 带进卡片、逼着每页再复位一次。
          */}
          {tab === 0 && (
            <View className='page-profile__tab-pane'>
              {report.dynamics.length === 0 ? (
                <EmptyState icon='📰' title='暂无近期动态' desc='该名人近 30 天无公开新闻' />
              ) : (
                report.dynamics.map((d, i) => (
                  <View key={i} className='card page-profile__dyn'>
                    <View className='page-profile__dyn-head'>
                      <Text className='text-tertiary'>{d.date}</Text>
                      <Text className='text-tertiary'>{d.source}</Text>
                    </View>
                    <View className='page-profile__dyn-title'>{d.title}</View>
                    {d.summary && <View className='text-secondary page-profile__dyn-summary'>{d.summary}</View>}
                  </View>
                ))
              )}
            </View>
          )}

          {tab === 1 && (
            <View className='page-profile__tab-pane'>
              {report.quotes.length === 0 ? (
                <EmptyState icon='💬' title='暂无整理名言' desc='名言来自公开资料与新闻素材' />
              ) : (
                report.quotes.map((q, i) => (
                  <View key={i} className='card page-profile__quote'>
                    <View className='page-profile__quote-body'>
                      <View className='page-profile__quote-text'>「{q.text}」</View>
                      {/*
                        复制：只用图标，固定在引文右上角。
                        此前这里是「复制」两字，与出处同处一行两端 —— 出处一长就被挤成两行、
                        按钮还被推向下一行，两者互相拉扯。改成图标后引文与出处的长短只影响
                        自己换行，推不动也撞不上按钮（热区由 &__copy 的内边距撑开，不靠字号）。
                        无障碍提示交给微信原生的复制 toast（setClipboardData 自带「内容已复制」）。
                      */}
                      <View
                        className='page-profile__copy'
                        hoverClass='page-profile__copy--tap'
                        onClick={() => Taro.setClipboardData({ data: quoteCopyText(q) })}
                      >
                        <View className='page-profile__copy-icon' />
                      </View>
                    </View>
                    {/* 脚注 + 「查证」：与报告页的「经典名言」共用同一套（含背景 / 注解 / 出处核对） */}
                    <QuoteDetail report={report} quote={q} />
                  </View>
                ))
              )}
            </View>
          )}

          {tab === 2 && (
            <View className='page-profile__tab-pane'>
              {timelineView.length === 0 ? (
                <EmptyState icon='🗓' title='暂无经历时间线' desc='时间线由报告从公开素材中整理，生成报告后展示' />
              ) : (
                <View className='card'>
                  <View className='card-title'>时间线</View>
                  {timelineView.map((t, i) => (
                    <View key={i} className='page-profile__timeline-item'>
                      <View className='page-profile__timeline-dot' />
                      <View className='page-profile__timeline-body'>
                        <Text className='text-tertiary'>{t.date}</Text>
                        <Text className='page-profile__timeline-event'>{t.event}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/*
            数据 Tab（M2-4）：曝光度 / 报道来源 / 来源×情绪 / 素材可信度 / 情绪构成 /
            情绪走势 / 时间分布等卡。每张卡都有自己的成立门槛（见 utils/stats.ts 顶部常量）。

            2026-10-08 改：门槛没过时**不再整卡消失**，改为「卡片照出 + 写明为什么没画图」。
            原先的取舍是「宁可少一张卡，也不摆一张由一两条数据凑出来的分布」——
            出发点（不摆假分布）仍然成立，所以门槛一个没动、一条数据也没多算；
            但代价是用户看到卡片无声无息地少了一张，只能怀疑是坏了（报告页同此处理）。
            故这里只改**呈现**：不出图，但出卡、说明原因。降级（无报告）仍走上面的空状态。
          */}
          {tab === 3 && (
            <View className='page-profile__tab-pane'>
              <View className='card'>
                <View className='card-title'>曝光度</View>
                <View className='page-profile__stat-grid'>
                  <View className='page-profile__stat'>
                    <Text className='page-profile__stat-value'>{stats.exposure.heat}</Text>
                    <Text className='page-profile__stat-label'>热度 / 100</Text>
                  </View>
                  <View className='page-profile__stat'>
                    <Text className='page-profile__stat-value'>{num(stats.exposure.items)}</Text>
                    <Text className='page-profile__stat-label'>近 30 天报道</Text>
                  </View>
                  <View className='page-profile__stat'>
                    <Text className='page-profile__stat-value'>{num(stats.exposure.recent)}</Text>
                    <Text className='page-profile__stat-label'>近 7 天报道</Text>
                  </View>
                </View>
                <Text className='page-profile__stat-note'>{exposureNote}</Text>
              </View>

              {/* 门槛没过也出卡并写明原因（原先不成立就整卡不出，见数据 Tab 顶部注释） */}
              {!stats.sources && (
                <View className='card'>
                  <View className='card-title'>报道来源分布</View>
                  <Text className='page-profile__stat-note'>
                    {`本报告收录的 ${report.dynamics.length} 条动态里，带来源标注的条目不足 3 条（一两条连不成分布），故不出条形图。`}
                  </Text>
                </View>
              )}
              {stats.sources && (
                <View className='card'>
                  <View className='card-title'>报道来源分布</View>
                  {stats.sources.items.map((s) => (
                    <View key={s.name} className='page-profile__bar-row'>
                      <Text className='page-profile__bar-name'>{s.name}</Text>
                      <View className='page-profile__bar-track'>
                        <View
                          className='page-profile__bar-fill'
                          style={{ width: `${Math.max(6, Math.round(s.ratio * 100))}%` }}
                        />
                      </View>
                      <Text className='page-profile__bar-value'>{s.count}</Text>
                    </View>
                  ))}
                  <Text className='page-profile__stat-note'>{sourceNote}</Text>
                </View>
              )}

              {/*
                来源 × 情绪：与「报道来源分布」是同一批动态的两种切法（谁在报 / 怎么报），
                故共用 utils/stats.ts 的同一份来源归并，两卡的家数必然一致。
                门槛比来源分布更严：单家不足 2 条不单列 —— 见 tiltNote 里的说明。
              */}
              {!stats.tilt && (
                <View className='card'>
                  <View className='card-title'>来源 × 情绪</View>
                  <Text className='page-profile__stat-note'>
                    本报告收录的动态里，可判定来源、且单家达到 2 条以上的来源不足 2 家（一条报道代表不了一家媒体的口径），故无可对照的对象。
                  </Text>
                </View>
              )}
              {stats.tilt && (
                <View className='card'>
                  <View className='card-title'>来源 × 情绪</View>
                  {stats.tilt.items.map((s) => (
                    <View key={s.name} className='page-profile__tilt-row'>
                      <Text className='page-profile__bar-name'>{s.name}</Text>
                      <View className='page-profile__tilt-bar'>
                        {s.positive > 0 && (
                          <View
                            className='page-profile__stance-seg page-profile__stance-seg--positive'
                            style={{ flex: s.positive }}
                          />
                        )}
                        {s.neutral > 0 && (
                          <View
                            className='page-profile__stance-seg page-profile__stance-seg--neutral'
                            style={{ flex: s.neutral }}
                          />
                        )}
                        {s.negative > 0 && (
                          <View
                            className='page-profile__stance-seg page-profile__stance-seg--negative'
                            style={{ flex: s.negative }}
                          />
                        )}
                      </View>
                      <Text className='page-profile__tilt-count'>{`${s.total} 条`}</Text>
                    </View>
                  ))}
                  <Text className='page-profile__stat-note'>{tiltNote}</Text>
                </View>
              )}

              {/*
                素材可信度：全部由端上数出来（不依赖 coverage，故老报告也有）。
                四个数字回答「这些素材本身有多硬」，与曝光度卡（热度多高）是两种问题。
              */}
              {!stats.credibility && (
                <View className='card'>
                  <View className='card-title'>素材可信度</View>
                  <Text className='page-profile__stat-note'>
                    {`本报告收录的动态不足 3 条（本次 ${report.dynamics.length} 条），数不出独立事件与重复报道比，故不出这四个数。`}
                  </Text>
                </View>
              )}
              {stats.credibility && (
                <View className='card'>
                  <View className='card-title'>素材可信度</View>
                  <View className='page-profile__stat-grid'>
                    <View className='page-profile__stat'>
                      <Text className='page-profile__stat-value'>{stats.credibility.events}</Text>
                      <Text className='page-profile__stat-label'>独立事件</Text>
                    </View>
                    <View className='page-profile__stat'>
                      <Text className='page-profile__stat-value'>{stats.credibility.families}</Text>
                      <Text className='page-profile__stat-label'>独立信源</Text>
                    </View>
                    <View className='page-profile__stat'>
                      <Text className='page-profile__stat-value'>{stats.credibility.shared}</Text>
                      <Text className='page-profile__stat-label'>多家共报</Text>
                    </View>
                    <View className='page-profile__stat'>
                      <Text className='page-profile__stat-value'>
                        {`${Math.round(stats.credibility.repeatRatio * 100)}%`}
                      </Text>
                      <Text className='page-profile__stat-label'>重复报道</Text>
                    </View>
                  </View>
                  <Text className='page-profile__stat-note'>{credibilityNote}</Text>
                </View>
              )}

              {!stats.sentiment && (
                <View className='card'>
                  <View className='card-title'>情绪构成</View>
                  <Text className='page-profile__stat-note'>
                    本报告收录的公开动态为 0 条，没有可归类的对象，故不出构成条。若报告是刚生成的，可先看「动态」Tab 里有没有条目。
                  </Text>
                </View>
              )}
              {stats.sentiment && (
                <View className='card'>
                  <View className='card-title'>情绪构成</View>
                  <View className='page-profile__stance-bar'>
                    {stats.sentiment.positive > 0 && (
                      <View
                        className='page-profile__stance-seg page-profile__stance-seg--positive'
                        style={{ flex: stats.sentiment.positive }}
                      />
                    )}
                    {stats.sentiment.neutral > 0 && (
                      <View
                        className='page-profile__stance-seg page-profile__stance-seg--neutral'
                        style={{ flex: stats.sentiment.neutral }}
                      />
                    )}
                    {stats.sentiment.negative > 0 && (
                      <View
                        className='page-profile__stance-seg page-profile__stance-seg--negative'
                        style={{ flex: stats.sentiment.negative }}
                      />
                    )}
                  </View>
                  <View className='page-profile__stance-legend'>
                    <Text className='page-profile__stance-legend-item'>
                      积极 {stats.sentiment.positive} · {pct(stats.sentiment.positive, stats.sentiment.total)}
                    </Text>
                    <Text className='page-profile__stance-legend-item'>
                      中性 {stats.sentiment.neutral} · {pct(stats.sentiment.neutral, stats.sentiment.total)}
                    </Text>
                    <Text className='page-profile__stance-legend-item'>
                      消极 {stats.sentiment.negative} · {pct(stats.sentiment.negative, stats.sentiment.total)}
                    </Text>
                  </View>
                  <Text className='page-profile__stat-note'>
                    基于本报告收录的 {stats.sentiment.total} 条公开动态归类统计，口径与报告页「立场与舆情」一致。
                  </Text>
                </View>
              )}

              {/*
                情绪走势：情绪构成（横向占比）与时间分布（条数节奏）的交叉 —— 回答
                「舆情是变好了还是变差了」。月份刻度与窗口来自同一套规则（见 utils/stats.ts
                的 bucketize），不会出现两卡月份错位；但数据源只有动态（时间分布还含时间线），
                故两卡的起止月份与条数可以不相等。
              */}
              {!stats.sentimentTrend && (
                <View className='card'>
                  <View className='card-title'>情绪走势</View>
                  <Text className='page-profile__stat-note'>
                    {`至少要有 3 条带日期的动态、且分布在 2 个月以上才画得出走势（只有一根柱子那是上方的「情绪构成」，不是走势）。本报告为 ${report.dynamics.length} 条动态，未达到门槛，故不出图。`}
                  </Text>
                </View>
              )}
              {stats.sentimentTrend && (
                <View className='card'>
                  <View className='card-title'>情绪走势</View>
                  <View className='page-profile__stance-legend'>
                    <View className='page-profile__legend'>
                      <View className='page-profile__dot page-profile__dot--positive' />
                      <Text className='page-profile__stance-legend-item'>积极</Text>
                    </View>
                    <View className='page-profile__legend'>
                      <View className='page-profile__dot page-profile__dot--neutral' />
                      <Text className='page-profile__stance-legend-item'>中性</Text>
                    </View>
                    <View className='page-profile__legend'>
                      <View className='page-profile__dot page-profile__dot--negative' />
                      <Text className='page-profile__stance-legend-item'>消极</Text>
                    </View>
                  </View>
                  <View className='page-profile__months'>
                    {stats.sentimentTrend.items.map((s) => (
                      <View key={s.key} className='page-profile__month'>
                        <Text className='page-profile__month-count'>{s.total > 0 ? s.total : ''}</Text>
                        <View className='page-profile__month-track'>
                          {s.total > 0 && (
                            <View
                              className='page-profile__trend-bar'
                              style={{ height: `${s.ratio * 100}%` }}
                            >
                              {s.positive > 0 && (
                                <View
                                  className='page-profile__trend-seg page-profile__trend-seg--positive'
                                  style={{ flex: s.positive }}
                                />
                              )}
                              {s.neutral > 0 && (
                                <View
                                  className='page-profile__trend-seg page-profile__trend-seg--neutral'
                                  style={{ flex: s.neutral }}
                                />
                              )}
                              {s.negative > 0 && (
                                <View
                                  className='page-profile__trend-seg page-profile__trend-seg--negative'
                                  style={{ flex: s.negative }}
                                />
                              )}
                            </View>
                          )}
                        </View>
                        <Text className='page-profile__month-label'>{s.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text className='page-profile__stat-note'>{trendNote}</Text>
                </View>
              )}

              {!stats.months && (
                <View className='card'>
                  <View className='card-title'>时间分布</View>
                  <Text className='page-profile__stat-note'>
                    本报告收录的带日期条目（动态 + 时间线）不足 3 条，摊到月份上每月不足一条，画不出分布，故不出图。
                  </Text>
                </View>
              )}
              {stats.months && (
                <View className='card'>
                  <View className='card-title'>时间分布</View>
                  <View className='page-profile__months'>
                    {stats.months.items.map((m) => (
                      <View key={m.key} className='page-profile__month'>
                        <Text className='page-profile__month-count'>{m.count > 0 ? m.count : ''}</Text>
                        <View className='page-profile__month-track'>
                          <View
                            className='page-profile__month-bar'
                            style={{ height: `${m.count > 0 ? Math.max(10, Math.round(m.ratio * 100)) : 0}%` }}
                          />
                        </View>
                        <Text className='page-profile__month-label'>{m.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text className='page-profile__stat-note'>
                    横轴为月份（{stats.months.from} ~ {stats.months.to}），纵轴为本报告收录的带日期条目数（动态 +
                    时间线，同月同一说法只计一次）。
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  )
}
