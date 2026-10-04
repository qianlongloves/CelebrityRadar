import { useState } from 'react'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtActivityIndicator } from 'taro-ui'
import EmptyState from '@/components/empty-state'
import { listFollows, FollowRow } from '@/utils/follows'
import { getFeed, refreshAllFeeds } from '@/utils/cache'
import { NewsItem } from '@/utils/search'
import { DomainCode, parsePersonKey } from '@/config/domains'
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

export default function Feed() {
  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<FeedEntry[]>([])
  const [followCount, setFollowCount] = useState(0)

  const load = async () => {
    setLoading(true)
    const follows = await listFollows()
    setFollowCount(follows.length)

    // 归并：每个关注人的 feed_cache → 统一列表，按时间倒序
    const merged: FeedEntry[] = []
    await Promise.all(
      follows.map(async (f: FollowRow) => {
        const items = await getFeed(f.person_key)
        const parsed = parsePersonKey(f.person_key)
        for (const it of items) {
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
    setEntries(merged)
    setLoading(false)
  }

  useDidShow(() => {
    void load()
  })

  usePullDownRefresh(async () => {
    const follows = await listFollows()
    const res = await refreshAllFeeds(follows)
    await load()
    Taro.stopPullDownRefresh()
    Taro.showToast({ title: res.message, icon: 'none', duration: 2000 })
  })

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/profile/index?personKey=${encodeURIComponent(personKey)}` })
  }

  return (
    <View className='page-feed glow-page safe-bottom'>
      {loading && <AtActivityIndicator mode='center' content='加载中…' className='page-feed__loading' />}

      {!loading && entries.length === 0 && (
        <EmptyState
          icon='📡'
          title={followCount === 0 ? '还没有关注动态' : '关注的人暂无公开动态'}
          desc={
            followCount === 0
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
              <Text className='page-feed__stat-value'>{followCount} 人</Text>
            </View>
            <View className='page-feed__stat page-feed__stat--blue'>
              <Text className='page-feed__stat-label'>近期动态</Text>
              <Text className='page-feed__stat-value'>{entries.length} 条</Text>
            </View>
          </View>

          <View className='section-head'>
            <Text className='section-head__title'>最新动态</Text>
            <Text className='section-head__extra'>下拉刷新 · 每日 10 次</Text>
          </View>

          {entries.map((e, i) => (
            <View key={`${e.personKey}-${i}`} className='card page-feed__item' onClick={() => openPerson(e.personKey)}>
              <View className='page-feed__item-head'>
                <View className='page-feed__item-person'>
                  <View className={`page-feed__item-icon page-feed__item-icon--${e.domain}`}>
                    {e.personName.slice(0, 1)}
                  </View>
                  <View className='page-feed__item-person-info'>
                    <Text className='page-feed__item-name'>{e.personName}</Text>
                    <Text className='page-feed__item-domain'>{e.source}</Text>
                  </View>
                </View>
                <Text className='page-feed__item-date'>{e.publishedDate?.slice(0, 10) ?? '近期'}</Text>
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
