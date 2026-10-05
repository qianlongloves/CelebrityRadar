import { useCallback, useEffect, useState } from 'react'
import Taro, { useDidShow, useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtButton } from 'taro-ui'
import { DOMAIN_META, DomainCode } from '@/config/domains'
import { FOCUS_META, FocusCode, isFocusCode } from '@/config/filters'
import EmptyState from '@/components/empty-state'
import ReportLoading from '@/components/report-loading'
import { getOrBuildReport, ReportOutcome } from '@/utils/cache'
import { hasSearchChannel } from '@/utils/search'
import { hasLlmChannel } from '@/utils/llm'
import { Report } from '@/utils/report'
import {
  favoriteQuote,
  favoriteReport,
  favoriteDynamic,
  favoriteTimeline,
  makeFavoriteId,
  removeFavorite
} from '@/utils/favorites'
import { isFollowed, toggleFollow } from '@/utils/follows'
import { addHistory } from '@/utils/history'
import { track } from '@/utils/events'
import { useAuth } from '@/stores/auth'
import { fromNow } from '@/utils/time'
import './index.scss'

/** 深度报告页（§2.3 六段渲染 + §2.4 全部边界态） */
type PageState =
  | { phase: 'loading' }
  | { phase: 'waiting' } // 他人 building，轮询中
  | { phase: 'coldstart' }
  | { phase: 'nonews' }
  | { phase: 'refused' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; report: Report; fromCache: boolean }

const SENTIMENT_META: Record<string, { label: string; cls: string }> = {
  positive: { label: '积极', cls: 'positive' },
  neutral: { label: '中性', cls: 'neutral' },
  negative: { label: '消极', cls: 'negative' }
}

/**
 * 取链接的可读域名。
 *
 * 小程序内无法直接打开任意外部网页：web-view 要求目标域名先在小程序后台登记为业务域名，
 * 而报告的来源是任意媒体域名，不可能逐一备案。因此域名不作为跳转入口，
 * 只作为「这条动态出自哪家媒体」的提示，真正的打开动作由用户复制链接到浏览器完成。
 * 另外 url 已经过 report.ts 的素材白名单校验，必然是真实的素材链接。
 */
function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url || '')
  if (!m) return ''
  return (m[1] ?? '').replace(/^www\./i, '')
}

/** 日期倒序（缺日期的排最后）：模型返回顺序不保证，最新动态应排最前 */
function byDateDesc(a: string, b: string): number {
  if (!a) return 1
  if (!b) return -1
  return b.localeCompare(a)
}

/** 日期正序（缺日期的排最后）：时间线是履历脉络，从早到晚读才顺 */
function byDateAsc(a: string, b: string): number {
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b)
}

/** 刷新结果：与上一版逐条比对的差值 */
interface RefreshDiff {
  newDynamics: number
  newTimeline: number
  heatDelta: number
  prevAt: string
}

/**
 * 比对两版报告，回答「这次刷新到底刷出了什么」。
 *
 * dynamics 用 url 判同、timeline 用「日期|事件」判同：这两者都是模型从素材
 * 原样复制的字段，不像 title / event 的措辞那样每次生成都会漂移，
 * 拿它们判「是不是同一条」最稳；若改用标题相似度，会稳定地误报「全是新的」。
 */
function computeDiff(next: Report, prev: Report): RefreshDiff {
  const urls = new Set(prev.dynamics.map((d) => d.url))
  const events = new Set(prev.timeline.map((t) => `${t.date}|${t.event}`))
  return {
    newDynamics: next.dynamics.filter((d) => !urls.has(d.url)).length,
    newTimeline: next.timeline.filter((t) => !events.has(`${t.date}|${t.event}`)).length,
    heatDelta: next.heat - prev.heat,
    prevAt: prev.generatedAt
  }
}

export default function ReportPage() {
  const router = useRouter()
  const personKey = decodeURIComponent(router.params.personKey || '')
  /** 发现页「关注」筛选（生成侧重，§2.3 六段可聚焦） */
  const focusParam = router.params.focus || 'all'
  const focus: FocusCode = isFocusCode(focusParam) ? focusParam : 'all'
  const [state, setState] = useState<PageState>({ phase: 'loading' })
  const [reportFaved, setReportFaved] = useState(false)
  /** 已收藏的内容 id（名言 / 动态 / 履历节点三类共用；整份报告单独用 reportFaved） */
  const [favedIds, setFavedIds] = useState<Set<string>>(new Set())
  const [followed, setFollowed] = useState(false)
  /** 上一版报告：仅当用户点「刷新最新」且真的重新生成了才有值 */
  const [prevReport, setPrevReport] = useState<Report | null>(null)

  const name = personKey.split('#')[0] || '名人'
  const domain = (personKey.split('#')[1] || 'other') as DomainCode

  const load = useCallback(
    async (force = false) => {
      if (!personKey) {
        setState({ phase: 'error', message: '缺少 personKey 参数' })
        return
      }
      setState({ phase: 'loading' })
      setPrevReport(null)
      const outcome: ReportOutcome = await getOrBuildReport(personKey, { force, focus })
      switch (outcome.kind) {
        case 'report':
          setState({ phase: 'ready', report: outcome.report, fromCache: outcome.fromCache })
          setPrevReport(outcome.prev ?? null)
          break
        case 'coldstart':
          setState({ phase: 'coldstart' })
          break
        case 'nonews':
          setState({ phase: 'nonews' })
          break
        case 'refused':
          setState({ phase: 'refused' })
          break
        case 'error':
          if (outcome.message.includes('正在生成')) {
            setState({ phase: 'waiting' })
          } else {
            setState({ phase: 'error', message: outcome.message })
          }
          break
      }
    },
    [personKey, focus]
  )

  useEffect(() => {
    void load(false)
    void addHistory(personKey, name)
  }, [load])

  /**
   * 关注态同步。用 useDidShow 而不是挂载时读一次：用户可能去名人主页取关后
   * 再返回本页（页面实例还在、personKey 没变），只在 mount 时读会留下一个
   * 显示「已关注」的僵尸按钮。
   */
  useDidShow(() => {
    if (!personKey || !useAuth.getState().userId) return
    void isFollowed(personKey).then(setFollowed)
  })

  /** 关注 / 取关。报告页此前没有关注入口，看完报告想关注必须退回名人主页，动线是断的。 */
  const onToggleFollow = async () => {
    const next = await toggleFollow(personKey, 'report')
    /* null = 失败或未登录：follows.ts 已给出原因 toast，不更新按钮态 */
    if (next === null) return
    setFollowed(next)
    Taro.showToast({ title: next ? '已关注' : '已取消关注', icon: 'none' })
  }

  /** 进入页面 / 报告就绪时同步收藏状态 */
  useEffect(() => {
    const userId = useAuth.getState().userId
    const rep = state.phase === 'ready' ? state.report : null
    if (!userId || !personKey) return
    void (async () => {
      /* 一次 in 查回四类收藏态：报告 + 每条名言 + 每条动态 + 每个履历节点。
         报告体量下 id 总数在几十条量级，一次往返比按类型分三次查更省也更好维护。 */
      const ids = [
        ...(rep?.quotes.map((q) => makeFavoriteId(userId, 'quote', `${personKey}:${q.text}`)) ?? []),
        ...(rep?.dynamics.map((d) => makeFavoriteId(userId, 'dynamic', d.url)) ?? []),
        ...(rep?.timeline.map((t) => makeFavoriteId(userId, 'timeline', `${t.date}|${t.event}`)) ?? [])
      ]
      const { table } = await import('@/utils/db')
      const { data } = await table('favorites')
        .select('id')
        .in('id', [makeFavoriteId(userId, 'report', personKey), ...ids])
      const rows = (data as Array<{ id: string }>) ?? []
      setReportFaved(rows.some((r) => r.id === makeFavoriteId(userId, 'report', personKey)))
      setFavedIds(new Set(rows.map((r) => r.id)))
    })()
  }, [personKey, state])

  const copyQuote = (text: string, source: string) => {
    Taro.setClipboardData({ data: `${text}\n—— 来源：${source}` })
  }

  /**
   * 复制素材链接。
   * setClipboardData 自带系统级「内容已复制」提示，但用户未必知道下一步该做什么，
   * 这里再补一句引导（会覆盖前者），把「小程序内打不开外部网页」这件事讲明白。
   */
  const copyLink = (url: string) => {
    if (!url) {
      Taro.showToast({ title: '该条暂无链接', icon: 'none' })
      return
    }
    Taro.setClipboardData({ data: url })
    Taro.showToast({ title: '链接已复制，粘贴到浏览器打开', icon: 'none' })
  }

  /** 当前用户对某条内容的收藏 id；未登录返回空串（一律按「未收藏」渲染） */
  const favIdOf = (type: 'quote' | 'dynamic' | 'timeline', contentKey: string): string => {
    const userId = useAuth.getState().userId
    return userId ? makeFavoriteId(userId, type, contentKey) : ''
  }

  /**
   * 内容收藏切换（名言 / 动态 / 履历节点共用）。
   *
   * 抽出一层是因为三类内容的收藏逻辑完全一致，而原先只写名言的那版有个坑：
   * 无论当前是否已收藏都调 favoriteQuote（幂等 upsert），于是「取消收藏」只改了
   * 本地状态、库里那条依然在，重进页面又变回已收藏。
   *
   * @param makeId 用当前用户 id 算主键，免得调用处各自重复取一遍 userId
   * @param save   未收藏时的落库动作，返回 false 表示失败（内部已 toast）
   */
  const toggleContentFav = async (
    makeId: (userId: string) => string,
    save: () => Promise<boolean>
  ) => {
    const userId = useAuth.getState().userId
    if (!userId) {
      Taro.showToast({ title: '请先到「我的」页登录', icon: 'none' })
      return
    }
    const id = makeId(userId)

    if (favedIds.has(id)) {
      await removeFavorite(id)
      setFavedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      Taro.showToast({ title: '已取消收藏', icon: 'none' })
      return
    }

    if (!(await save())) return
    setFavedIds((prev) => new Set(prev).add(id))
    Taro.showToast({ title: '已收藏', icon: 'none' })
  }

  const toggleQuoteFav = (q: Report['quotes'][number]) =>
    toggleContentFav(
      (uid) => makeFavoriteId(uid, 'quote', `${personKey}:${q.text}`),
      () => favoriteQuote(personKey, name, q)
    )

  const toggleDynamicFav = (d: Report['dynamics'][number]) =>
    toggleContentFav(
      (uid) => makeFavoriteId(uid, 'dynamic', d.url),
      () => favoriteDynamic(personKey, name, d)
    )

  const toggleTimelineFav = (t: Report['timeline'][number]) =>
    toggleContentFav(
      (uid) => makeFavoriteId(uid, 'timeline', `${t.date}|${t.event}`),
      () => favoriteTimeline(personKey, name, t)
    )

  /** 报告收藏切换：原先只有「收藏」分支，没有取消 */
  const toggleReportFav = async () => {
    if (!report) return
    const userId = useAuth.getState().userId
    if (!userId) {
      Taro.showToast({ title: '请先到「我的」页登录', icon: 'none' })
      return
    }
    const id = makeFavoriteId(userId, 'report', personKey)

    if (reportFaved) {
      await removeFavorite(id)
      setReportFaved(false)
      Taro.showToast({ title: '已取消收藏', icon: 'none' })
      return
    }

    const ok = await favoriteReport(personKey, name, {
      heat: report.heat,
      mode: report.mode,
      generatedAt: report.generatedAt
    })
    if (!ok) return
    setReportFaved(true)
    Taro.showToast({ title: '已收藏报告', icon: 'none' })
  }

  /**
   * 复制全文。
   * 原实现漏掉了时间线与信息来源两段，且沿用模型返回的原始顺序，
   * 与页面上的排序渲染不一致 —— 复制出去的内容和用户刚看到的报告对不上。
   */
  const copyAll = (report: Report) => {
    track('share', { personKey: report.personKey, way: 'copy_all' })
    const dynamics = [...report.dynamics].sort((a, b) => byDateDesc(a.date, b.date))
    const timeline = [...report.timeline].sort((a, b) => byDateAsc(a.date, b.date))
    const lines = [
      `【${report.name} · 深度报告】`,
      report.intro,
      '',
      '■ 近期动态',
      ...dynamics.map((d) => `- ${d.date} ${d.title}（${d.source}）${d.url}`),
      '',
      '■ 经典名言',
      ...report.quotes.map((q) => `- ${q.text}（${q.context}）`),
      '',
      '■ AI 点评',
      report.analysis
    ]
    if (timeline.length) {
      lines.push('', '■ 时间线', ...timeline.map((t) => `- ${t.date} ${t.event}`))
    }
    if (report.sources.length) {
      lines.push('', '■ 信息来源', ...report.sources.map((s) => `- ${s.title} ${s.url}`))
    }
    lines.push('', report.disclaimer)
    Taro.setClipboardData({ data: lines.join('\n') })
  }

  const { report, fromCache } =
    state.phase === 'ready' ? { report: state.report, fromCache: state.fromCache } : { report: null, fromCache: false }

  /**
   * 微信原生分享（转发好友 / 分享到朋友圈）。
   *
   * 全项目此前没有注册任何分享回调，右上角「转发」只会带走一个不含参数的页面地址，
   * 对方打开直接落到「缺少 personKey 参数」的错误态 —— 而深度报告恰恰是最该被分享的内容。
   * 加载中与失败态也给一个可读标题，避免分享出去是一句「生成失败」。
   */
  const sharePath = `/pages/report/index?personKey=${encodeURIComponent(personKey)}${
    focus === 'all' ? '' : `&focus=${focus}`
  }`
  const shareTitle = report ? `${report.name} · 深度报告` : '名人观察 · 深度报告'

  useShareAppMessage(() => ({ title: shareTitle, path: sharePath }))
  useShareTimeline(() => ({ title: shareTitle, query: sharePath.split('?')[1] ?? '' }))

  /** 渲染顺序：动态最新在前、履历从早到晚（模型返回顺序不作保证） */
  const dynamicsView = report ? [...report.dynamics].sort((a, b) => byDateDesc(a.date, b.date)) : []
  const timelineView = report ? [...report.timeline].sort((a, b) => byDateAsc(a.date, b.date)) : []

  /** 刷新结果对比：只有本次真的重新生成、且库里本来就有旧版时才算得出来 */
  const diff = report && prevReport ? computeDiff(report, prevReport) : null
  const diffParts: string[] = diff
    ? [
        diff.newDynamics > 0 ? `新增 ${diff.newDynamics} 条动态` : '近期动态无变化',
        diff.newTimeline > 0 ? `${diff.newTimeline} 个履历节点` : '',
        diff.heatDelta !== 0 ? `热度 ${diff.heatDelta > 0 ? '+' : ''}${diff.heatDelta}` : ''
      ].filter((s) => s !== '')
    : []

  /**
   * 联网能力是否就绪：coldstart 的成因有两种且有完全不同的出路——
   * 没配大模型 Key（去配置才有用）vs 配了但素材拉不到（重试才有用），不可混为一谈。
   * 检索侧不计入：没配博查 Key 时走平台代付（见 utils/search.ts 的 hasSearchChannel），
   * 若仍要求博查 Key 存在，这些用户会被误导去配一个根本不必配的东西。
   */
  const netReady = hasSearchChannel() && hasLlmChannel()

  /** 侧重提示条：路由侧重 ≠ 缓存报告侧重时，给出「重新生成」入口（缓存键仍为 personKey） */
  const reportFocus: FocusCode = report?.focus ?? 'all'
  const needRegen = !!report && reportFocus !== focus
  const showFocusBar = focus !== 'all' || (!!report && reportFocus !== 'all')

  return (
    <View className='page-report glow-page safe-bottom'>


      {showFocusBar && (
        <View className='page-report__focus'>
          <Text className='page-report__focus-tag'>{focus === 'all' ? '综合' : FOCUS_META[focus].short}</Text>
          {state.phase === 'loading' ? (
            <Text className='page-report__focus-text'>正在按该侧重生成报告…</Text>
          ) : needRegen ? (
            <Text className='page-report__focus-text'>
              当前为{reportFocus === 'all' ? '综合' : `「${FOCUS_META[reportFocus].short}」`}报告，
              <Text className='page-report__focus-link' onClick={() => void load(true)}>
                重新生成为{focus === 'all' ? '综合' : `「${FOCUS_META[focus].label}」`}
              </Text>
            </Text>
          ) : report ? (
            <Text className='page-report__focus-text'>已按该侧重生成：{FOCUS_META[focus].desc}</Text>
          ) : (
            <Text className='page-report__focus-text'>本次侧重：{FOCUS_META[focus].desc}</Text>
          )}
        </View>
      )}

      {report && (
        <View className='page-report__banner'>
          <View className='page-report__banner-left'>
            <View className='page-report__name-row'>
              <Text className='page-report__name'>{report.name}</Text>
              <View className='page-report__banner-chip'>{DOMAIN_META[domain]?.label ?? '其他'}</View>
            </View>
            <View className='page-report__meta' onClick={() => void load(true)}>
              {fromCache ? (
                <Text className='page-report__refresh'>
                  生成于 {fromNow(report.generatedAt)} · <Text className='page-report__refresh-link'>查看最新</Text>
                </Text>
              ) : (
                <Text className='page-report__fresh'>刚刚生成</Text>
              )}
            </View>
            {/* 关注入口：此前报告页无处关注，看完报告想关注必须先退回名人主页 */}
            <View
              className={`page-report__follow ${followed ? 'page-report__follow--on' : ''}`}
              onClick={() => void onToggleFollow()}
            >
              {followed ? '已关注' : '+ 关注'}
            </View>
          </View>
          <View
            className='page-report__ring'
            style={{
              background: `conic-gradient(#fff 0 ${Math.max(4, Math.min(100, report.heat))}%, rgba(255,255,255,0.22) ${Math.max(4, Math.min(100, report.heat))}% 100%)`
            }}
          >
            <View className='page-report__ring-inner'>
              <Text className='page-report__ring-value'>{report.heat}</Text>
              <Text className='page-report__ring-label'>热度</Text>
            </View>
          </View>
        </View>
      )}

      {/* 刷新反馈：告诉用户这次「刷新最新」到底刷出了什么，此前点完毫无回音 */}
      {diff && (
        <View className='page-report__diff'>
          <Text className='page-report__diff-head'>已更新为最新版本</Text>
          <Text className='page-report__diff-body'>
            相比 {fromNow(diff.prevAt)} 的版本：{diffParts.join(' · ')}
          </Text>
        </View>
      )}

      {state.phase === 'loading' && <ReportLoading />}

      {state.phase === 'waiting' && <ReportLoading mode='waiting' />}

      {state.phase === 'coldstart' && (
        <EmptyState
          icon='🔑'
          title={netReady ? '暂无报告' : '联网能力不可用'}
          desc={
            netReady
              ? '该名人还没有生成过报告，联网素材暂不可用（网络或额度问题），可稍后重试，或换一位热门名人'
              : '报告需「博查搜索取素材 + 大模型按模板生成」，平台额度当前不可用；可到「我的」页填入自己的 Key，或稍后重试'
          }
          actionText={netReady ? '刷新重试' : '去配置'}
          onAction={() => {
            if (netReady) void load(true)
            else void Taro.switchTab({ url: '/pages/mine/index' })
          }}
        />
      )}

      {state.phase === 'nonews' && (
        <EmptyState
          icon='📭'
          title='暂未检索到近期公开信息'
          desc='该名人近 30 天无公开新闻动态，换个时间再试'
          actionText='刷新重试'
          onAction={() => void load(true)}
        />
      )}

      {state.phase === 'refused' && (
        <EmptyState icon='🚫' title='暂不支持查询该人物' desc='本工具仅覆盖科技、商业、文娱、体育、学术领域公众名人' />
      )}

      {state.phase === 'error' && (
        <EmptyState
          icon='⚠️'
          title='生成失败'
          desc={state.message}
          actionText='重试'
          onAction={() => void load(false)}
        />
      )}

      {report && (
        <View>
          {report.intro && (
            <View className='card'>
              <View className='card-title'>简介</View>
              <View className='page-report__text'>{report.intro}</View>
            </View>
          )}

          {dynamicsView.length > 0 && (
            <View className='card'>
              <View className='card-title'>近期动态（{dynamicsView.length}）</View>
              {dynamicsView.map((d, i) => {
                const domain = hostOf(d.url)
                const favId = favIdOf('dynamic', d.url)
                const faved = !!favId && favedIds.has(favId)
                return (
                  <View key={i} className='page-report__item'>
                    <View className='page-report__item-head'>
                      <Text className='page-report__item-date'>{d.date}</Text>
                      <View className={`page-report__sentiment ${SENTIMENT_META[d.sentiment]?.cls ?? 'neutral'}`}>
                        {SENTIMENT_META[d.sentiment]?.label ?? '中性'}
                      </View>
                    </View>
                    <View className='page-report__item-title'>{d.title}</View>
                    {d.summary && <View className='text-secondary'>{d.summary}</View>}
                    <View className='page-report__item-src text-tertiary'>
                      <Text>来源：{d.source || '网络'}</Text>
                      {domain && <Text className='page-report__domain'>{domain}</Text>}
                      <Text className='page-report__copy-link' onClick={() => void toggleDynamicFav(d)}>
                        {faved ? '已收藏' : '收藏'}
                      </Text>
                      <Text className='page-report__copy-link' onClick={() => copyLink(d.url)}>
                        复制链接
                      </Text>
                    </View>
                  </View>
                )
              })}
            </View>
          )}

          {report.quotes.length > 0 && (
            <View className='card'>
              <View className='card-title'>经典名言</View>
              {report.quotes.map((q, i) => {
                const favId = favIdOf('quote', `${personKey}:${q.text}`)
                const faved = !!favId && favedIds.has(favId)
                return (
                  <View key={i} className='page-report__quote'>
                    <View className='page-report__quote-text'>「{q.text}」</View>
                    <View className='page-report__quote-foot'>
                      <Text className='text-tertiary'>{q.context || '公开场合'}</Text>
                      <View className='page-report__quote-ops'>
                        <Text className='page-report__copy-link' onClick={() => void toggleQuoteFav(q)}>
                          {faved ? '已收藏' : '收藏'}
                        </Text>
                        <Text className='page-report__copy-link' onClick={() => copyQuote(q.text, q.source)}>
                          复制这句
                        </Text>
                      </View>
                    </View>
                  </View>
                )
              })}
            </View>
          )}

          {report.degraded && (
            <View className='warn-bar'>
              结构化生成暂不可用，本次为纯文本简版：点评基于模型已有知识，未引用实时素材。
            </View>
          )}

          {report.analysis && (
            <View className='card'>
              <View className='card-title'>{report.degraded ? 'AI 点评 · 简版' : 'AI 点评'}</View>
              <View className='page-report__analysis-text'>{report.analysis}</View>
            </View>
          )}

          {timelineView.length > 0 && (
            <View className='card'>
              <View className='card-title'>时间线</View>
              {timelineView.map((t, i) => {
                const favId = favIdOf('timeline', `${t.date}|${t.event}`)
                const faved = !!favId && favedIds.has(favId)
                return (
                  <View key={i} className='page-report__timeline-item'>
                    <View className='page-report__timeline-dot' />
                    <View className='page-report__timeline-body'>
                      <Text className='page-report__item-date'>{t.date}</Text>
                      <Text className='page-report__timeline-event'>{t.event}</Text>
                      <Text
                        className='page-report__copy-link'
                        onClick={() => void toggleTimelineFav(t)}
                      >
                        {faved ? '已收藏' : '收藏'}
                      </Text>
                    </View>
                  </View>
                )
              })}
            </View>
          )}

          <View className='card'>
            <View className='card-title'>信息来源（{report.sources.length}）</View>
            {report.sources.length === 0 && <View className='text-secondary'>暂无来源链接</View>}
            {report.sources.map((s, i) => {
              const domain = hostOf(s.url)
              return (
                <View key={i} className='page-report__item-src text-tertiary'>
                  <Text>· {s.title || domain || '公开来源'}</Text>
                  {domain && s.title && <Text className='page-report__domain'>{domain}</Text>}
                  <Text className='page-report__copy-link' onClick={() => copyLink(s.url)}>
                    复制链接
                  </Text>
                </View>
              )
            })}
          </View>

          <View className='page-report__actions'>
            <AtButton type='secondary' circle onClick={() => void toggleReportFav()}>
              {reportFaved ? '已收藏' : '收藏报告'}
            </AtButton>
            <AtButton type='secondary' circle onClick={() => copyAll(report)}>
              复制全文
            </AtButton>
            <AtButton type='primary' circle loading={state.phase === 'loading'} onClick={() => void load(true)}>
              刷新最新
            </AtButton>
          </View>

          {/* AI 生成内容免责声明：report.disclaimer 此前只出现在「复制全文」的文本里，页面上完全没展示 */}
          <Text className='disclaimer'>{report.disclaimer}</Text>
        </View>
      )}

    </View>
  )
}
