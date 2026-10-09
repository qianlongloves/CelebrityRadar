import { useState } from 'react'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { View, Text, ScrollView } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import Skeleton from '@/components/skeleton'
import { listFollows, FollowRow } from '@/utils/follows'
import { getFeedDetail, refreshAllFeeds } from '@/utils/cache'
import { NewsItem } from '@/utils/search'
import { DOMAIN_META, DomainCode, parsePersonKey } from '@/config/domains'
import { fromNow, sameDay8 } from '@/utils/time'
import './index.scss'

/** 流条目：新闻 + 归属人 */
interface FeedEntry extends NewsItem {
  personKey: string
  personName: string
  domain: DomainCode
}

function sortByDate(a: FeedEntry, b: FeedEntry): number {
  const ta = a.publishedDate ? Date.parse(a.publishedDate) : 0
  const tb = b.publishedDate ? Date.parse(b.publishedDate) : 0
  return tb - ta
}

/**
 * 今天发布的动态给一枚徽标，让「有没有新东西」一眼可见。
 *
 * P2-36：一律按 UTC+8 判「今天」。以前用 `getMonth()/getDate()`（设备本地）比，
 * 于是同一条动态在不同用户手机上可能一个是「今天」、一个是昨天 —— 徽标本身就是在回答
 * 「这算不算新的」，答案随设备漂移就没有意义了。
 */
function isToday(date?: string): boolean {
  if (!date) return false
  return sameDay8(date, Date.now())
}

/**
 * 关注动态（原底部菜单第二格，2026-10-07 改为二级页，入口在发现页顶部）。
 * 本页不再挂 tab 高亮，也不需要 tabBar 底部占位（safe-tab）。
 */
export default function Feed() {
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<FeedEntry[]>([])
  const [follows, setFollows] = useState<FollowRow[]>([])
  /** 读失败的关注人数：>0 时结果不完整，必须显式告知，不能当成「暂无动态」 */
  const [failedCount, setFailedCount] = useState(0)
  /** 所有关注人里最近一次抓取时间，用于表达数据新鲜度 */
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null)
  /** 按人物筛选，'' = 全部 */
  const [personFilter, setPersonFilter] = useState('')

  const load = async () => {
    setLoading(true)
    const rows = await listFollows()
    setFollows(rows)

    // 归并：每个关注人的 feed_cache → 统一列表，按时间倒序
    const merged: FeedEntry[] = []
    let failed = 0
    let latest: string | null = null

    await Promise.all(
      rows.map(async (f: FollowRow) => {
        const detail = await getFeedDetail(f.person_key)
        if (!detail.ok) failed++
        if (detail.fetchedAt && (!latest || detail.fetchedAt > latest)) latest = detail.fetchedAt
        const parsed = parsePersonKey(f.person_key)
        for (const it of detail.items) {
          merged.push({
            ...it,
            personKey: f.person_key,
            personName: f.name,
            domain: parsed?.domain ?? 'other'
          })
        }
      })
    )

    merged.sort(sortByDate)
    setFailedCount(failed)
    setLastFetchedAt(latest)
    setEntries(merged)
    setLoading(false)
  }

  useDidShow(() => {
    void load()
  })

  usePullDownRefresh(async () => {
    const rows = await listFollows()
    const res = await refreshAllFeeds(rows)
    await load()
    Taro.stopPullDownRefresh()
    Taro.showToast({ title: res.message, icon: 'none', duration: 2000 })
  })

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/profile/index?personKey=${encodeURIComponent(personKey)}` })
  }

  /* 每个人物的动态条数，供筛选芯片展示 */
  const countByPerson: Record<string, number> = {}
  for (const e of entries) countByPerson[e.personKey] = (countByPerson[e.personKey] ?? 0) + 1

  const shown = personFilter ? entries.filter((e) => e.personKey === personFilter) : entries
  const filterName = follows.find((f) => f.person_key === personFilter)?.name ?? ''

  return (
    <View className='page-feed glow-page'>
      {loading && <Skeleton variant='feed' rows={3} withStats />}

      {/*
        周报入口（§2.2 M5-2）：关注了人就有意义，故不依赖 entries 是否有内容——
        周报素材正是本页缓存，空动态时点进去也会给出「先去下拉刷新」的引导。
      */}
      {!loading && follows.length > 0 && (
        <View
          className='page-feed__weekly'
          onClick={() => Taro.navigateTo({ url: '/pages/weekly/index' })}
        >
          <View className='page-feed__weekly-icon'>📰</View>
          <View className='page-feed__weekly-info'>
            <Text className='page-feed__weekly-title'>本周周报</Text>
            <Text className='page-feed__weekly-desc'>
              汇总最近 7 天的关注动态，生成一份可复制、可分享的周报
            </Text>
          </View>
          <Text className='page-feed__weekly-cta'>生成 ›</Text>
        </View>
      )}

      {/* 读取失败：与「确实没有动态」是两回事，分开呈现 */}
      {!loading && entries.length === 0 && failedCount > 0 && (
        <EmptyState
          icon='⚠️'
          title='动态没能加载出来'
          desc={`${failedCount} 位关注人的动态读取失败，可能是网络或权限问题`}
          actionText='重新加载'
          onAction={() => void load()}
        />
      )}

      {!loading && entries.length === 0 && failedCount === 0 && (
        <EmptyState
          icon='📡'
          title={follows.length === 0 ? '还没有关注动态' : '关注的人暂无公开动态'}
          desc={
            follows.length === 0
              ? '关注名人后，这里会聚合展示 TA 的近期公开动态；下拉刷新每日限 10 次'
              : '下拉刷新可联网抓取最新动态（每日限 10 次）'
          }
          actionText='去发现名人'
          onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
        />
      )}

      {!loading && entries.length > 0 && (
        <View>
          {/* 统计双列卡（参照样例 In Progress 双列小卡） */}
          <View className='page-feed__stats'>
            <View className='page-feed__stat page-feed__stat--brand'>
              <Text className='page-feed__stat-label'>已关注</Text>
              <Text className='page-feed__stat-value'>{follows.length} 人</Text>
            </View>
            <View className='page-feed__stat page-feed__stat--blue'>
              <Text className='page-feed__stat-label'>近期动态</Text>
              <Text className='page-feed__stat-value'>{entries.length} 条</Text>
            </View>
          </View>

          {failedCount > 0 && (
            <View className='page-feed__notice' onClick={() => void load()}>
              <Text className='page-feed__notice-text'>
                {failedCount} 位关注人的动态读取失败，以下结果可能不完整 · 点此重试
              </Text>
            </View>
          )}

          {/* 按人物筛选：流是按时间混排的，关注多了想只看某人会非常费劲 */}
          {follows.length > 1 && (
            <ScrollView scrollX className='page-feed__chips' showScrollbar={false}>
              <View className='page-feed__chips-inner'>
                <View
                  className={`page-feed__chip ${personFilter === '' ? 'page-feed__chip--active' : ''}`}
                  onClick={() => setPersonFilter('')}
                >
                  全部 {entries.length}
                </View>
                {follows.map((f) => (
                  <View
                    key={f.person_key}
                    className={`page-feed__chip ${
                      personFilter === f.person_key ? 'page-feed__chip--active' : ''
                    }`}
                    onClick={() => setPersonFilter(f.person_key)}
                  >
                    {f.name} {countByPerson[f.person_key] ?? 0}
                  </View>
                ))}
              </View>
            </ScrollView>
          )}

          <View className='section-head'>
            <Text className='section-head__title'>{personFilter ? `${filterName} 的动态` : '最新动态'}</Text>
            <Text className='section-head__extra'>
              {lastFetchedAt ? `抓取于 ${fromNow(lastFetchedAt)}` : '下拉刷新 · 每日 10 次'}
            </Text>
          </View>

          {shown.length === 0 && (
            <EmptyState
              icon='📭'
              title={`${filterName}暂无动态`}
              desc='下拉刷新可联网抓取最新动态，或切回「全部」看看其他人'
              actionText='查看全部'
              onAction={() => setPersonFilter('')}
            />
          )}

          {shown.map((e, i) => (
            <View
              key={`${e.personKey}-${e.url || i}`}
              className='card page-feed__item'
              onClick={() => openPerson(e.personKey)}
            >
              <View className='page-feed__item-head'>
                <View className='page-feed__item-person'>
                  <View className={`page-feed__item-icon page-feed__item-icon--${e.domain}`}>
                    {e.personName.slice(0, 1)}
                  </View>
                  <View className='page-feed__item-person-info'>
                    <Text className='page-feed__item-name'>{e.personName}</Text>
                    <Text className='page-feed__item-domain'>
                      {DOMAIN_META[e.domain].label} · {e.source}
                    </Text>
                  </View>
                </View>
                <View className='page-feed__item-meta'>
                  {isToday(e.publishedDate) && <Text className='page-feed__item-today'>今日</Text>}
                  <Text className='page-feed__item-date'>{e.publishedDate?.slice(0, 10) ?? '近期'}</Text>
                </View>
              </View>
              <View className='page-feed__item-title'>{e.title}</View>
              <View className='text-secondary page-feed__item-summary'>{e.content}</View>
              <View className='page-feed__item-foot'>
                <Text
                  className='page-feed__copy'
                  onClick={(ev) => {
                    ev.stopPropagation?.()
                    Taro.setClipboardData({ data: e.url })
                  }}
                >
                  复制原文链接
                </Text>
              </View>
            </View>
          ))}
          <View className='disclaimer'>动态内容来自公开网络检索，由 AI 整理，仅供参考；下拉可刷新（每日限 10 次）</View>
        </View>
      )}
    </View>
  )
}
