import { useCallback, useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { listFollows } from '@/utils/follows'
import { getFeedDetails } from '@/utils/cache'
import { MATERIAL_FAIL_TEXT, WEEKLY_WINDOW_DAYS, collectWeeklyMaterial, readWeeklyCache } from '@/utils/weekly'
import type { WeeklyReport } from '@/utils/weekly'
import { loadAlerts, listWatches, splitWatches } from '@/utils/keyword-alert'
import { groupSignals, loadRiskSignals } from '@/utils/risk-watch'
import { domainLabel, parsePersonKey } from '@/config/domains'
import { formatMoment8, fromNow } from '@/utils/time'
import { useTabBarSync } from '@/utils/tabbar'
import './index.scss'

/**
 * 舆情页（底部菜单第三格「盯」，2026-10-13 新增）。
 *
 * 三块原本是首页问候区右侧的三个图标入口，各自跳一个二级页；它们其实是同一件事的三种
 * 切法（都在回答「我关注的东西最近怎么样了」），散在首页既占位又要逐个点开。这里收成一格：
 * 每块给概要 + 「查看全部」，先看概况、要看细节再进完整页。
 *
 * 数据层全部复用既有 utils（follows / cache / weekly / keyword-alert / risk-watch），
 * 不新增集合、不改云函数；每块各自 try/catch，**一块读失败只降级那一块**，不拖垮整页。
 *
 * 刻意不做的事：不在这里调 generateWeekly（生成要花额度且需用户确认，交给完整页）；
 * 也不调 markAllSeen（一旦在这里标已读，完整页里那批「新」就凭空消失了）。
 */

/** 每个区块最多列几条概要 */
const PREVIEW_ROWS = 3

type Status = 'loading' | 'ready' | 'error'

interface FeedPreview {
  personName: string
  domain: string
  title: string
  source: string
  date: string
}

interface AlertPreview {
  keyword: string
  title: string
  source: string
  date: string
}

interface FeedState {
  status: Status
  followCount: number
  entryCount: number
  failedCount: number
  latest: FeedPreview[]
}

interface WeeklyState {
  status: Status
  report: WeeklyReport | null
  /** 无缓存时的可得性（来自零成本的 collectWeeklyMaterial）；report 非空时为 null */
  materialKind: 'ok' | 'nologin' | 'nofollow' | 'nomaterial' | null
  materialCount: number
}

interface AlertState {
  status: Status
  keywordCount: number
  personCount: number
  newTotal: number
  riskCount: number
  latest: AlertPreview[]
}

/** 周报未生成时的状态文案：先说有没有可汇总的材料，再给出下一步 */
function weeklyStatusText(kind: WeeklyState['materialKind'], count: number): string {
  if (kind === 'ok') return `关注的人近 ${WEEKLY_WINDOW_DAYS} 天有 ${count} 条动态可汇总，去完整页生成`
  if (kind && kind !== 'ok') return MATERIAL_FAIL_TEXT[kind]
  return `本周还没生成周报，去完整页看看（汇总最近 ${WEEKLY_WINDOW_DAYS} 天关注动态）`
}

export default function Opinion() {
  useTabBarSync()

  const [feed, setFeed] = useState<FeedState>({
    status: 'loading',
    followCount: 0,
    entryCount: 0,
    failedCount: 0,
    latest: []
  })
  const [weekly, setWeekly] = useState<WeeklyState>({
    status: 'loading',
    report: null,
    materialKind: null,
    materialCount: 0
  })
  const [alerts, setAlerts] = useState<AlertState>({
    status: 'loading',
    keywordCount: 0,
    personCount: 0,
    newTotal: 0,
    riskCount: 0,
    latest: []
  })

  /** 关注动态概要：批量读缓存（与关注流页同一入口），归并后取最近若干条 */
  const loadFeed = useCallback(async () => {
    setFeed((s) => ({ ...s, status: 'loading' }))
    try {
      const rows = await listFollows()
      const details = await getFeedDetails(rows.map((f) => f.person_key))
      const merged: FeedPreview[] = []
      let failed = 0
      for (const f of rows) {
        const detail = details.get(f.person_key)
        if (!detail || !detail.ok) failed++
        const parsed = parsePersonKey(f.person_key)
        for (const it of detail?.items ?? []) {
          merged.push({
            personName: f.name,
            domain: parsed?.domain ?? 'other',
            title: it.title,
            source: it.source,
            date: it.publishedDate ?? ''
          })
        }
      }
      merged.sort((a, b) => (b.date ? Date.parse(b.date) || 0 : 0) - (a.date ? Date.parse(a.date) || 0 : 0))
      setFeed({
        status: 'ready',
        followCount: rows.length,
        entryCount: merged.length,
        failedCount: failed,
        latest: merged.slice(0, PREVIEW_ROWS)
      })
    } catch {
      setFeed((s) => ({ ...s, status: 'error' }))
    }
  }, [])

  /** 周报概要：先读本机缓存（零成本）；没有缓存再问一次材料可得性（同样零成本） */
  const loadWeekly = useCallback(async () => {
    setWeekly((s) => ({ ...s, status: 'loading' }))
    try {
      const cached = readWeeklyCache()
      if (cached) {
        setWeekly({ status: 'ready', report: cached, materialKind: null, materialCount: cached.entryCount })
        return
      }
      const mat = await collectWeeklyMaterial()
      setWeekly({
        status: 'ready',
        report: null,
        materialKind: mat.kind,
        materialCount: mat.kind === 'ok' ? mat.material.entryCount : 0
      })
    } catch {
      setWeekly((s) => ({ ...s, status: 'error' }))
    }
  }, [])

  /** 预警概要：关键词订阅 + 预警分组 + 名人风险信号，全部只读 */
  const loadAlertBlock = useCallback(async () => {
    setAlerts((s) => ({ ...s, status: 'loading' }))
    try {
      /* 与预警页同一套读法：一次 listWatches 拿到全部行，再拆成关键词 / 监控人两类 */
      const [rows, res] = await Promise.all([listWatches(), loadAlerts()])
      const { keywords, persons } = splitWatches(rows)

      const latest: AlertPreview[] = []
      let newTotal = 0
      for (const g of res.groups) {
        newTotal += g.newCount
        for (const it of g.items) {
          latest.push({
            keyword: g.keyword,
            title: it.title,
            source: it.source,
            date: it.published_date ?? it.first_seen_at ?? ''
          })
        }
      }

      const keys = persons.map((p) => p.person_key).filter((k): k is string => !!k)
      const riskCount = groupSignals(await loadRiskSignals(keys)).reduce((n, g) => n + g.signals.length, 0)

      setAlerts({
        status: 'ready',
        keywordCount: keywords.length,
        personCount: persons.length,
        newTotal,
        riskCount,
        latest: latest.slice(0, PREVIEW_ROWS)
      })
    } catch {
      setAlerts((s) => ({ ...s, status: 'error' }))
    }
  }, [])

  useDidShow(() => {
    void loadFeed()
    void loadWeekly()
    void loadAlertBlock()
  })

  const goFeed = () => void Taro.navigateTo({ url: '/pages/feed/index' })
  const goWeekly = () => void Taro.navigateTo({ url: '/pages/weekly/index' })
  const goAlerts = () => void Taro.navigateTo({ url: '/pages/alerts/index' })

  return (
    <View className='page-opinion glow-page safe-tab'>
      <View className='page-opinion__hero'>
        <Text className='page-opinion__hero-title'>舆情台</Text>
        <Text className='page-opinion__hero-sub'>关注的人 · 本周周报 · 关键词预警，一处看全</Text>
      </View>

      {/* ===== 关注动态 ===== */}
      <View className='card page-opinion__block'>
        <View className='page-opinion__head'>
          <Text className='page-opinion__head-title'>📡 关注动态</Text>
          <Text className='page-opinion__more' onClick={goFeed}>
            查看全部 ›
          </Text>
        </View>

        {feed.status === 'loading' && <Text className='page-opinion__hint'>正在读取关注动态…</Text>}
        {feed.status === 'error' && (
          <Text className='page-opinion__hint page-opinion__hint--err' onClick={() => void loadFeed()}>
            关注动态读取失败 · 点此重试
          </Text>
        )}
        {feed.status === 'ready' &&
          (feed.followCount === 0 || feed.entryCount === 0 ? (
            <Text className='page-opinion__empty'>
              {feed.followCount === 0
                ? '还没有关注的动态，去「查」里关注几位名人'
                : '关注的人暂无公开动态，进完整页抓取一次'}
            </Text>
          ) : (
            <>
              <View className='page-opinion__stats'>
                <Text className='page-opinion__stat'>已关注 {feed.followCount} 人</Text>
                <Text className='page-opinion__stat'>近期 {feed.entryCount} 条</Text>
                {feed.failedCount > 0 && (
                  <Text className='page-opinion__stat page-opinion__stat--warn'>{feed.failedCount} 人读取失败</Text>
                )}
              </View>
              {feed.latest.map((e, i) => (
                <View key={`${e.personName}-${i}`} className='page-opinion__row' onClick={goFeed}>
                  <Text className='page-opinion__row-title'>{e.title}</Text>
                  <Text className='page-opinion__row-meta'>
                    {e.personName} · {domainLabel(e.domain)} · {e.source || '公开来源'}
                  </Text>
                </View>
              ))}
            </>
          ))}
      </View>

      {/* ===== 本周周报 ===== */}
      <View className='card page-opinion__block'>
        <View className='page-opinion__head'>
          <Text className='page-opinion__head-title'>📰 本周周报</Text>
          <Text className='page-opinion__more' onClick={goWeekly}>
            查看全部 ›
          </Text>
        </View>

        {weekly.status === 'loading' && <Text className='page-opinion__hint'>正在读取周报状态…</Text>}
        {weekly.status === 'error' && (
          <Text className='page-opinion__hint page-opinion__hint--err' onClick={() => void loadWeekly()}>
            周报状态读取失败 · 点此重试
          </Text>
        )}
        {weekly.status === 'ready' &&
          (weekly.report ? (
            <>
              <Text className='page-opinion__weekly-range'>
                {weekly.report.windowLabel} · 覆盖 {weekly.report.personCount} 位 / {weekly.report.entryCount} 条
              </Text>
              <Text className='page-opinion__weekly-summary'>
                {weekly.report.overview || '本次未生成综述正文，进完整页看逐人动态与要点'}
              </Text>
              <Text className='page-opinion__row-meta'>生成于 {fromNow(weekly.report.generatedAt)}</Text>
            </>
          ) : (
            <Text className='page-opinion__empty'>
              {weeklyStatusText(weekly.materialKind, weekly.materialCount)}
            </Text>
          ))}
      </View>

      {/* ===== 关键词预警 ===== */}
      <View className='card page-opinion__block'>
        <View className='page-opinion__head'>
          <Text className='page-opinion__head-title'>📣 关键词预警</Text>
          <Text className='page-opinion__more' onClick={goAlerts}>
            查看全部 ›
          </Text>
        </View>

        {alerts.status === 'loading' && <Text className='page-opinion__hint'>正在读取预警…</Text>}
        {alerts.status === 'error' && (
          <Text className='page-opinion__hint page-opinion__hint--err' onClick={() => void loadAlertBlock()}>
            预警读取失败 · 点此重试
          </Text>
        )}
        {alerts.status === 'ready' &&
          (alerts.keywordCount === 0 && alerts.personCount === 0 ? (
            <Text className='page-opinion__empty'>还没有监测中的关键词，进完整页添加一个</Text>
          ) : (
            <>
              <View className='page-opinion__stats'>
                {alerts.keywordCount > 0 && (
                  <Text className='page-opinion__stat'>监测 {alerts.keywordCount} 个词</Text>
                )}
                {alerts.personCount > 0 && (
                  <Text className='page-opinion__stat'>监控 {alerts.personCount} 位名人</Text>
                )}
                {alerts.newTotal > 0 && (
                  <Text className='page-opinion__stat page-opinion__stat--warn'>新增 {alerts.newTotal} 条</Text>
                )}
                {alerts.riskCount > 0 && (
                  <Text className='page-opinion__stat page-opinion__stat--warn'>风险信号 {alerts.riskCount} 条</Text>
                )}
              </View>
              {alerts.latest.length === 0 ? (
                <Text className='page-opinion__empty'>已开始监测，暂无相关报道</Text>
              ) : (
                alerts.latest.map((a, i) => (
                  <View key={`${a.keyword}-${i}`} className='page-opinion__row' onClick={goAlerts}>
                    <Text className='page-opinion__row-title'>{a.title}</Text>
                    <Text className='page-opinion__row-meta'>
                      {a.keyword} · {a.source || '公开来源'}
                      {a.date ? ` · ${formatMoment8(a.date)}` : ''}
                    </Text>
                  </View>
                ))
              )}
            </>
          ))}
      </View>
    </View>
  )
}
