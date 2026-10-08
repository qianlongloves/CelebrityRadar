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
            数据 Tab（M2-4）：曝光度 / 报道来源 / 情绪构成 / 时间分布四张卡。
            每张卡都有自己的成立门槛（见 utils/stats.ts 顶部常量），样本不足时整块不出 ——
            宁可少一张卡，也不摆一张由一两条数据凑出来的「分布」。
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
