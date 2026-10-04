import { useCallback, useEffect, useState } from 'react'
import Taro, { useRouter } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtButton, AtIcon, AtActivityIndicator } from 'taro-ui'
import { DOMAIN_META, DomainCode } from '@/config/domains'
import EmptyState from '@/components/empty-state'
import { getOrBuildReport, ReportOutcome } from '@/utils/cache'
import { Report } from '@/utils/report'
import { favoriteQuote, favoriteReport, makeFavoriteId } from '@/utils/favorites'
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

export default function ReportPage() {
  const router = useRouter()
  const personKey = decodeURIComponent(router.params.personKey || '')
  const [state, setState] = useState<PageState>({ phase: 'loading' })
  const [reportFaved, setReportFaved] = useState(false)
  const [favedQuotes, setFavedQuotes] = useState<Set<string>>(new Set())

  const name = personKey.split('#')[0] || '名人'
  const domain = (personKey.split('#')[1] || 'other') as DomainCode

  const load = useCallback(
    async (force = false) => {
      if (!personKey) {
        setState({ phase: 'error', message: '缺少 personKey 参数' })
        return
      }
      setState({ phase: 'loading' })
      const outcome: ReportOutcome = await getOrBuildReport(personKey, { force })
      switch (outcome.kind) {
        case 'report':
          setState({ phase: 'ready', report: outcome.report, fromCache: outcome.fromCache })
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
    [personKey]
  )

  useEffect(() => {
    void load(false)
    void addHistory(personKey, name)
  }, [load])

  /** 进入页面 / 报告就绪时同步收藏状态 */
  useEffect(() => {
    const userId = useAuth.getState().userId
    const rep = state.phase === 'ready' ? state.report : null
    if (!userId || !personKey) return
    void (async () => {
      const ids = rep?.quotes.map((q) => makeFavoriteId(userId, 'quote', `${personKey}:${q.text}`)) ?? []
      const { table } = await import('@/utils/db')
      const { data } = await table('favorites')
        .select('id')
        .in('id', [makeFavoriteId(userId, 'report', personKey), ...ids])
      const rows = (data as Array<{ id: string }>) ?? []
      setReportFaved(rows.some((r) => r.id === makeFavoriteId(userId, 'report', personKey)))
      setFavedQuotes(new Set(rows.map((r) => r.id)))
    })()
  }, [personKey, state])

  const copyQuote = (text: string, source: string) => {
    Taro.setClipboardData({ data: `${text}\n—— 来源：${source}` })
  }

  const toggleQuoteFav = async (q: Report['quotes'][number]) => {
    const ok = await favoriteQuote(personKey, name, q)
    if (!ok) return
    const userId = useAuth.getState().userId
    if (!userId) return
    const id = makeFavoriteId(userId, 'quote', `${personKey}:${q.text}`)
    setFavedQuotes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    Taro.showToast({ title: favedQuotes.has(id) ? '已取消收藏' : '已收藏', icon: 'none' })
  }

  const toggleReportFav = async () => {
    if (!report) return
    const ok = await favoriteReport(personKey, name, {
      heat: report.heat,
      mode: report.mode,
      generatedAt: report.generatedAt
    })
    if (!ok) return
    setReportFaved(true)
    Taro.showToast({ title: '已收藏报告', icon: 'none' })
  }

  const copyAll = (report: Report) => {
    track('share', { personKey: report.personKey, way: 'copy_all' })
    const lines = [
      `【${report.name} · 深度报告】`,
      report.intro,
      '',
      '■ 近期动态',
      ...report.dynamics.map((d) => `- ${d.date} ${d.title}（${d.source}）`),
      '',
      '■ 经典名言',
      ...report.quotes.map((q) => `- ${q.text}（${q.context}）`),
      '',
      '■ AI 点评',
      report.analysis,
      '',
      report.disclaimer
    ]
    Taro.setClipboardData({ data: lines.join('\n') })
  }

  const { report, fromCache } =
    state.phase === 'ready' ? { report: state.report, fromCache: state.fromCache } : { report: null, fromCache: false }

  return (
    <View className='page-report safe-bottom'>
      {report?.mode === 'knowledge' && (
        <View className='warn-bar'>
          <AtIcon value='alert-circle' size='16' color='#b45309' />
          <Text>知识模式结果：无实时来源，内容可能不准确（可在设置中关闭）</Text>
        </View>
      )}

      {report && (
        <View className='card page-report__header'>
          <View className='page-report__title-row'>
            <View className='page-report__name-row'>
              <Text className='page-report__name'>{report.name}</Text>
              <View className={`chip chip--${domain}`}>{DOMAIN_META[domain]?.label ?? '其他'}</View>
            </View>
            <View className='chip'>热度 {report.heat}</View>
          </View>
          <View className='page-report__meta' onClick={() => void load(true)}>
            {fromCache ? (
              <Text className='page-report__refresh'>
                生成于 {fromNow(report.generatedAt)} · <Text className='page-report__refresh-link'>查看最新</Text>
              </Text>
            ) : (
              <Text className='text-tertiary'>刚刚生成 · {fromNow(report.generatedAt)}</Text>
            )}
          </View>
        </View>
      )}

      {state.phase === 'loading' && (
        <View className='page-report__loading'>
          <AtActivityIndicator mode='center' content='正在检索与生成报告…' />
          <View className='text-tertiary page-report__loading-tip'>首次生成约需 30 秒，缓存后秒开</View>
        </View>
      )}

      {state.phase === 'waiting' && (
        <View className='page-report__loading'>
          <AtActivityIndicator mode='center' content='其他用户正在生成同一份报告，排队等待…' />
        </View>
      )}

      {state.phase === 'coldstart' && (
        <EmptyState
          icon='🔑'
          title='暂无报告'
          desc='该名人还没有生成过报告。联网生成需配置搜索源 key（仅存本地），配置后即可生成'
          actionText='去配置（我的 → 搜索源设置）'
          onAction={() => Taro.switchTab({ url: '/pages/mine/index' })}
        />
      )}

      {state.phase === 'nonews' && (
        <EmptyState
          icon='📭'
          title='暂未检索到近期公开信息'
          desc='该名人近 30 天无公开新闻动态。可在设置中显式开启「知识模式」（无实时来源，结果可能不准确）'
          actionText='去设置'
          onAction={() => Taro.switchTab({ url: '/pages/mine/index' })}
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

          {report.dynamics.length > 0 && (
            <View className='card'>
              <View className='card-title'>近期动态</View>
              {report.dynamics.map((d, i) => (
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
                    来源：{d.source || '网络'}（长按复制链接）
                    <Text
                      className='page-report__copy-link'
                      onClick={() => Taro.setClipboardData({ data: d.url })}
                    >
                      复制链接
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {report.quotes.length > 0 && (
            <View className='card'>
              <View className='card-title'>经典名言</View>
              {report.quotes.map((q, i) => {
                const userId = useAuth.getState().userId
                const favId = userId ? makeFavoriteId(userId, 'quote', `${personKey}:${q.text}`) : ''
                const faved = favId && favedQuotes.has(favId)
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

          {report.analysis && (
            <View className='card'>
              <View className='card-title'>
                {report.degraded ? 'AI 点评（简版降级：结构化生成暂不可用）' : 'AI 点评'}
              </View>
              <View className='page-report__text'>{report.analysis}</View>
            </View>
          )}

          {report.timeline.length > 0 && (
            <View className='card'>
              <View className='card-title'>时间线</View>
              {report.timeline.map((t, i) => (
                <View key={i} className='page-report__timeline-item'>
                  <Text className='page-report__item-date'>{t.date}</Text>
                  <Text className='page-report__timeline-event'>{t.event}</Text>
                </View>
              ))}
            </View>
          )}

          <View className='card'>
            <View className='card-title'>信息来源（{report.sources.length}）</View>
            {report.sources.length === 0 && <View className='text-secondary'>知识模式：无实时来源</View>}
            {report.sources.map((s, i) => (
              <View key={i} className='page-report__item-src text-tertiary'>
                · {s.title}
                <Text className='page-report__copy-link' onClick={() => Taro.setClipboardData({ data: s.url })}>
                  复制链接
                </Text>
              </View>
            ))}
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
        </View>
      )}

      <View className='disclaimer'>
        内容由 AI 基于公开网络信息生成，仅供参考，不代表本平台立场；来源 URL 均来自公开检索结果
      </View>
    </View>
  )
}
