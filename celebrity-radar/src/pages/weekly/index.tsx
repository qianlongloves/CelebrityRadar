import { useMemo, useState } from 'react'
import Taro, { useDidShow, useShareAppMessage } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import Skeleton from '@/components/skeleton'
import {
  WEEKLY_WINDOW_DAYS,
  MATERIAL_FAIL_TEXT,
  collectWeeklyMaterial,
  generateWeekly,
  readWeeklyCache
} from '@/utils/weekly'
import type { MaterialOutcome, WeeklyMaterial, WeeklyOutcome, WeeklyReport } from '@/utils/weekly'
import { buildDayDistribution } from '@/utils/stats'
import { peekGenerateQuota } from '@/utils/quota'
import { useAuth } from '@/stores/auth'
import { DOMAIN_META } from '@/config/domains'
import { fromNow } from '@/utils/time'
import { track } from '@/utils/events'
import './index.scss'

/**
 * 本周周报（§2.2 M5-2）。
 *
 * 两条状态来源要分清，混起来会出现「点了生成却没反应」这类问题：
 *   - 本机缓存命中 → 直接可读（零成本，不消耗额度）；
 *   - 无缓存 → 先只汇总材料（零成本）并展示覆盖范围，用户确认后再生成（消耗 1 次额度）。
 * 生成只发生在用户点击之后，不会一进页面就悄悄扣额度。
 */

type Phase =
  | 'loading'
  | 'idle'
  | 'generating'
  | 'ready'
  | 'nologin'
  | 'nofollow'
  | 'nomaterial'
  | 'quota'
  | 'cooldown'
  | 'error'

export default function Weekly() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [report, setReport] = useState<WeeklyReport | null>(null)
  const [material, setMaterial] = useState<WeeklyMaterial | null>(null)
  /** true = 当前这份来自本机缓存（用于区分「读了缓存」与「刚生成」的文案） */
  const [fromCache, setFromCache] = useState(false)
  const [message, setMessage] = useState('')
  /** 今日剩余生成次数：仅在能读到配额时展示，读不到就不显示（不阻塞主流程） */
  const [quotaLeft, setQuotaLeft] = useState<number | null>(null)

  const refreshQuota = async () => {
    const uid = useAuth.getState().userId
    if (!uid) return
    try {
      const q = await peekGenerateQuota(uid)
      setQuotaLeft(q.remaining)
    } catch {
      /* 配额只是提示信息，读不到就不显示 */
    }
  }

  const load = async () => {
    /* 缓存优先：本周已生成过就直接读，避免每次进入都重新收材料 */
    const cached = readWeeklyCache()
    if (cached) {
      setReport(cached)
      setFromCache(true)
      setPhase('ready')
      void refreshQuota()
      return
    }

    setPhase('loading')
    let res: MaterialOutcome
    try {
      res = await collectWeeklyMaterial()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setPhase('error')
      return
    }
    if (res.kind === 'ok') {
      setMaterial(res.material)
      setPhase('idle')
    } else {
      setPhase(res.kind)
    }
    void refreshQuota()
  }

  useDidShow(() => {
    void load()
  })

  useShareAppMessage(() => ({
    title: report ? `本周周报 · ${report.personCount} 位关注人的近况` : '名人雷达 · 关注周报',
    path: '/pages/weekly/index'
  }))

  /**
   * 真正发起生成（消耗 1 次今日额度）。
   *
   * `keepContent` 用于「重新生成」：手上已有一份可读的周报，失败时不能把用户从内容上踢回空态
   * （那等于用一次失败换走了他原有的东西），改为留在原报告上 toast 提示。
   */
  const doGenerate = async (mat: WeeklyMaterial, keepContent = false) => {
    if (!keepContent) setPhase('generating')
    Taro.showLoading({ title: '正在汇总…', mask: true })

    /* 先收起 loading 再弹 toast：微信端 hideLoading 与 showToast 同属一个「交互层」，
       顺序反了会把刚弹出的 toast 一起收掉 */
    let outcome: WeeklyOutcome
    try {
      outcome = await generateWeekly(mat)
    } catch (err) {
      outcome = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
    Taro.hideLoading()
    void refreshQuota()

    if (outcome.kind === 'ok') {
      setReport(outcome.report)
      setFromCache(false)
      setPhase('ready')
      return
    }

    setMessage(outcome.message)
    if (keepContent) {
      setPhase('ready')
      Taro.showToast({ title: outcome.message, icon: 'none', duration: 3200 })
      return
    }
    setPhase(outcome.kind === 'quota' ? 'quota' : outcome.kind === 'cooldown' ? 'cooldown' : 'error')
  }

  const startGenerate = () => {
    if (!material || phase === 'generating') return
    void doGenerate(material)
  }

  /**
   * 重新生成：材料先重新收集。
   * 用户很可能刚去关注流刷新过，沿用旧材料会得到一份「看起来没变」的周报。
   */
  const regenerate = async () => {
    if (phase === 'generating') return
    const confirm = await Taro.showModal({
      title: '重新生成周报',
      content: `将重新汇总最近 ${WEEKLY_WINDOW_DAYS} 天的动态并覆盖当前这份，消耗 1 次今日生成额度。`,
      confirmText: '重新生成'
    })
    if (!confirm.confirm) return

    let res: MaterialOutcome
    try {
      res = await collectWeeklyMaterial()
    } catch (err) {
      Taro.showToast({
        title: err instanceof Error ? err.message : String(err),
        icon: 'none',
        duration: 3200
      })
      return
    }
    if (res.kind !== 'ok') {
      /* 原报告仍在：只提示，不切空态 */
      Taro.showToast({ title: MATERIAL_FAIL_TEXT[res.kind], icon: 'none', duration: 3200 })
      return
    }
    setMaterial(res.material)
    await doGenerate(res.material, true)
  }

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/profile/index?personKey=${encodeURIComponent(personKey)}` })
  }

  const copyAll = () => {
    if (!report) return
    const blocks: string[] = [`【本周周报 · ${report.windowLabel}】`]
    if (report.overview) blocks.push(report.overview)
    for (const p of report.persons) {
      const lines = [`■ ${p.name}（${DOMAIN_META[p.domain].label}）`]
      if (p.summary) lines.push(p.summary)
      for (const e of p.entries) {
        lines.push(`· ${e.title}${e.source ? `（${e.source}）` : ''} ${e.url}`)
      }
      blocks.push(lines.join('\n'))
    }
    if (report.topics.length > 0) blocks.push(`本周话题：${report.topics.join('、')}`)
    blocks.push(report.disclaimer)
    Taro.setClipboardData({ data: blocks.join('\n\n') })
    track('share', { channel: 'copy', scope: 'weekly' })
  }

  const quotaHint = quotaLeft === null ? '' : `（今日报告生成额度剩 ${quotaLeft} 次）`

  /**
   * 本周逐日分布（O-16②）：复用主页「数据 Tab」的月度分布聚合，只把刻度从天换成日。
   *
   * 与月度分布同一取舍 —— 锚点取**周报生成时间**而不是「现在」，于是同一份缓存周报
   * 任何时候打开都是同一张图；纯端上聚合，不新增 Schema / 云函数 / 额度消耗，
   * 存量周报缓存（含旧版）下一次渲染即出卡。
   */
  const dayDist = useMemo(() => {
    if (!report) return null
    const facts = report.persons.flatMap((p) =>
      p.entries.map((e) => ({ date: e.publishedDate, text: e.title }))
    )
    return buildDayDistribution(report.generatedAt, facts, WEEKLY_WINDOW_DAYS)
  }, [report])

  return (
    <View className='page-weekly glow-page safe-bottom'>
      {phase === 'loading' && <Skeleton rows={3} variant='feed' />}

      {/* 无缓存：先展示覆盖范围与额度代价，由用户决定是否生成 */}
      {phase === 'idle' && material && (
        <EmptyState
          icon='📰'
          title='生成本周周报'
          desc={`将汇总最近 ${WEEKLY_WINDOW_DAYS} 天 ${material.persons.length} 位关注人的 ${material.entryCount} 条动态，生成一份可复制、可分享的周报；消耗 1 次今日生成额度${quotaHint}${
            material.failedCount > 0 ? `。另有 ${material.failedCount} 位的动态读取失败，本次不会计入` : ''
          }`}
          actionText='生成周报'
          onAction={startGenerate}
        />
      )}

      {phase === 'generating' && (
        <EmptyState icon='⏳' title='正在汇总本周动态' desc='模型正在把关注人的近期动态写成周报，请稍候' />
      )}

      {phase === 'ready' && report && (
        <View>
          <View className='card page-weekly__banner'>
            <View className='page-weekly__banner-head'>
              <View className='page-weekly__banner-title-box'>
                <Text className='page-weekly__banner-title'>本周周报</Text>
                <Text className='page-weekly__banner-range'>{report.windowLabel}</Text>
              </View>
              <Text className='page-weekly__regen' onClick={() => void regenerate()}>
                重新生成
              </Text>
            </View>

            <View className='page-weekly__banner-stats'>
              <View className='page-weekly__banner-stat'>
                <Text className='page-weekly__banner-stat-value'>{report.personCount}</Text>
                <Text className='page-weekly__banner-stat-label'>位关注人</Text>
              </View>
              <View className='page-weekly__banner-stat'>
                <Text className='page-weekly__banner-stat-value'>{report.entryCount}</Text>
                <Text className='page-weekly__banner-stat-label'>条动态</Text>
              </View>
            </View>

            <Text className='page-weekly__banner-note'>
              {fromCache ? '本周已生成，读取本机缓存 · 不消耗额度' : '本次生成已消耗 1 次今日额度'}
              {` · 生成于 ${fromNow(report.generatedAt)}`}
            </Text>
          </View>

          {report.degraded && (
            <View className='warn-bar page-weekly__warn'>
              本次未生成 AI 概述，以下为素材清单；可稍后点「重新生成」
            </View>
          )}

          {/*
            本周综述 / 近 7 天动态分布 / 本周话题：一律改成「卡片照出 + 写明为什么没有内容」。
            原先不成立就整卡不出，用户看到的是卡片一张张消失，只能怀疑是坏了
            （报告页、主页数据 Tab 同此处理）。
            降级周报仍不出综述卡：上方警示条已经说明「本次未生成 AI 概述」，再出一张空卡是重复。
          */}
          {(!!report.overview || !report.degraded) && (
            <View className='card'>
              <View className='card-title'>本周综述</View>
              {report.overview ? (
                <View className='page-weekly__overview'>{report.overview}</View>
              ) : (
                <Text className='page-weekly__dist-note'>
                  本次生成没有给出综述正文（这一段的留空条件见报告契约）。
                  下方「关注的人」里逐条列出了本次收录的动态与原文链接，可先据此阅读。
                </Text>
              )}
            </View>
          )}

          {/*
            逐日分布：标题不写「本周」——窗口是报告生成日往前 7 天的滚动窗口，不是自然周
            （与 time.ts 的选题口径一致）。
            带日期条目不足 3 条时**不再整卡不出**（门槛一个没动，仍与主页「时间分布」一致），
            改为照出卡片、写明为什么不出柱形图。
          */}
          {!report.degraded && (
            <View className='card'>
              <View className='card-title'>近 7 天动态分布</View>
              {!dayDist && (
                <Text className='page-weekly__dist-note'>
                  本次收录的带日期动态不足 3 条，摊到 7 天上多数格是空的，画不出分布，故不出柱形图。下方「关注的人」里逐条列了动态及其日期。
                </Text>
              )}
              {dayDist && (
                <>
                  <View className='page-weekly__days'>
                    {dayDist.items.map((d) => (
                      <View key={d.key} className='page-weekly__day'>
                        <Text className='page-weekly__day-count'>{d.count > 0 ? d.count : ''}</Text>
                        <View className='page-weekly__day-track'>
                          <View
                            className='page-weekly__day-bar'
                            style={{ height: `${d.count > 0 ? Math.max(10, Math.round(d.ratio * 100)) : 0}%` }}
                          />
                        </View>
                        <Text className='page-weekly__day-label'>{d.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text className='page-weekly__dist-note'>
                    横轴为日期（{dayDist.from} ~ {dayDist.to}），纵轴为当日收录的动态条数（同一说法只计一次）。
                  </Text>
                </>
              )}
            </View>
          )}

          <View className='section-head'>
            <Text className='section-head__title'>关注的人</Text>
            <Text className='section-head__extra'>{report.personCount} 位</Text>
          </View>

          {report.persons.map((p) => (
            <View
              key={p.personKey}
              className='card page-weekly__person'
              onClick={() => openPerson(p.personKey)}
            >
              <View className='page-weekly__person-head'>
                <View className={`page-weekly__person-icon page-weekly__person-icon--${p.domain}`}>
                  {p.name.slice(0, 1)}
                </View>
                <View className='page-weekly__person-info'>
                  <Text className='page-weekly__person-name'>{p.name}</Text>
                  <Text className='page-weekly__person-domain'>
                    {DOMAIN_META[p.domain].label} · {p.entries.length} 条动态
                  </Text>
                </View>
              </View>

              {!!p.summary && <View className='page-weekly__person-summary'>{p.summary}</View>}

              {p.entries.map((e, i) => (
                <View key={`${p.personKey}-${i}`} className='page-weekly__entry'>
                  <Text className='page-weekly__entry-title'>{e.title}</Text>
                  <View className='page-weekly__entry-foot'>
                    <Text className='page-weekly__entry-meta'>
                      {e.source || '公开来源'} · {e.publishedDate?.slice(0, 10) ?? '近期'}
                    </Text>
                    <Text
                      className='page-weekly__entry-copy'
                      onClick={(ev) => {
                        ev.stopPropagation?.()
                        Taro.setClipboardData({ data: e.url })
                      }}
                    >
                      复制链接
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ))}

          {/* 归不出话题也出卡（原先 `topics.length > 0 &&` 直接整卡不出）：说明为什么没有话题 */}
          {report.topics.length === 0 && (
            <View className='card'>
              <View className='card-title'>本周话题</View>
              <Text className='page-weekly__dist-note'>
                本次收录的动态里，跨名人反复出现的说法不足以归出话题（话题词取自标题与摘要原文，不做语义归类），故本卡只作说明。上方「关注的人」里逐条列了每个人的动态。
              </Text>
            </View>
          )}
          {report.topics.length > 0 && (
            <View className='card'>
              <View className='card-title'>本周话题</View>
              <View className='page-weekly__topics'>
                {report.topics.map((t) => (
                  <Text key={t} className='page-weekly__topic'>
                    {t}
                  </Text>
                ))}
              </View>
            </View>
          )}

          <View className='page-weekly__actions'>
            <View className='page-weekly__action' onClick={copyAll}>
              复制全文
            </View>
          </View>

          <View className='disclaimer'>
            周报由 AI 汇总公开检索素材生成，仅供参考；分享前请自行核对信息
          </View>
        </View>
      )}

      {phase === 'nologin' && (
        <EmptyState
          icon='🔐'
          title='登录后生成周报'
          desc={MATERIAL_FAIL_TEXT.nologin}
          actionText='去登录'
          onAction={() => Taro.switchTab({ url: '/pages/mine/index' })}
        />
      )}

      {phase === 'nofollow' && (
        <EmptyState
          icon='🤝'
          title='还没有关注名人'
          desc={MATERIAL_FAIL_TEXT.nofollow}
          actionText='去发现名人'
          onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
        />
      )}

      {phase === 'nomaterial' && (
        <EmptyState
          icon='📡'
          title='最近 7 天还没有可汇总的动态'
          desc='周报汇总的是关注流已抓取的动态，先到「关注动态」页下拉刷新一次再来生成（每日限 10 次）'
          actionText='去关注流刷新'
          onAction={() => Taro.navigateTo({ url: '/pages/feed/index' })}
        />
      )}

      {phase === 'quota' && (
        <EmptyState
          icon='⏳'
          title='今日报告生成额度已用完'
          desc={message}
          actionText='稍后再来'
          onAction={() => void load()}
        />
      )}

      {phase === 'cooldown' && (
        <EmptyState icon='🌡' title='生成服务限流中' desc={message} actionText='重试' onAction={() => void load()} />
      )}

      {phase === 'error' && (
        <EmptyState
          icon='⚠️'
          title='周报生成失败'
          desc={message || '请稍后重试'}
          actionText='重新加载'
          onAction={() => void load()}
        />
      )}
    </View>
  )
}
