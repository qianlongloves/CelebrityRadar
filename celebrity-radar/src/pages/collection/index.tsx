import { useState } from 'react'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtActivityIndicator } from 'taro-ui'
import { DOMAIN_META, DomainCode, parsePersonKey } from '@/config/domains'
import EmptyState from '@/components/empty-state'
import { listFavorites, removeFavorite, FavoriteRow } from '@/utils/favorites'
import { listHistory, clearHistory, HistoryRow } from '@/utils/history'
import { takePendingCollectionTab } from '@/utils/tab-target'
import { fromNow } from '@/utils/time'
import './index.scss'

/** 收藏 / 历史（tab 页，双 Tab；其他入口经 eventCenter 指定落地 Tab） */
export default function Collection() {
  const router = useRouter()
  const [tab, setTab] = useState(router.params.tab === 'history' ? 1 : 0)
  const [loading, setLoading] = useState(true)
  const [favorites, setFavorites] = useState<FavoriteRow[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])

  const load = async () => {
    setLoading(true)
    const [f, h] = await Promise.all([listFavorites(), listHistory()])
    setFavorites(f)
    setHistory(h)
    setLoading(false)
  }

  useDidShow(() => {
    /* 我的页菜单经 switchTab 进入时无法带参，用模块变量传目标 Tab（一次性消费） */
    const target = takePendingCollectionTab()
    if (target === 'history') setTab(1)
    if (target === 'favorites') setTab(0)
    void load()
  })

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}` })
  }

  const onRemoveFavorite = async (id: string) => {
    await removeFavorite(id)
    setFavorites((prev) => prev.filter((f) => f.id !== id))
  }

  const onClearHistory = async () => {
    const res = await Taro.showModal({
      title: '清空查询历史',
      content: '将删除全部历史记录，不可恢复',
      confirmText: '清空',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    await clearHistory()
    setHistory([])
    Taro.showToast({ title: '已清空', icon: 'none' })
  }

  return (
    <View className='page-collection glow-page safe-tab'>
      {loading && <AtActivityIndicator mode='center' content='加载中…' className='page-collection__loading' />}

      {!loading && (
        <View>
          {/* 筛选 chips（参照样例 All / To do / In Progress） */}
          <View className='page-collection__chips'>
            <View
              className={`page-collection__chip ${tab === 0 ? 'page-collection__chip--active' : ''}`}
              onClick={() => setTab(0)}
            >
              收藏 {favorites.length}
            </View>
            <View
              className={`page-collection__chip ${tab === 1 ? 'page-collection__chip--active' : ''}`}
              onClick={() => setTab(1)}
            >
              历史 {history.length}
            </View>
          </View>

          {tab === 0 ? (
            favorites.length === 0 ? (
              <EmptyState
                icon='⭐'
                title='还没有收藏'
                desc='在报告页可收藏整份报告或单句名言'
                actionText='去发现名人'
                onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
              />
            ) : (
              <View>
                {favorites.map((f) => {
                  const domain = (parsePersonKey(f.person_key)?.domain ?? 'other') as DomainCode
                  return f.type === 'quote' ? (
                    <View key={f.id} className='card page-collection__quote'>
                      <View className='page-collection__row'>
                        <View className={`page-collection__icon page-collection__icon--quote`}>「</View>
                        <View
                          className='page-collection__row-info'
                          onClick={() => openPerson(f.person_key)}
                        >
                          <Text className='page-collection__row-name'>{f.name}</Text>
                          <Text className='text-tertiary'>{DOMAIN_META[domain].label} · 名言</Text>
                        </View>
                        <Text
                          className='page-collection__op'
                          onClick={() => void onRemoveFavorite(f.id)}
                        >
                          取消收藏
                        </Text>
                      </View>
                      <View
                        className='page-collection__quote-text'
                        onClick={() => openPerson(f.person_key)}
                      >
                        「{String(f.payload?.text ?? '')}」
                      </View>
                      <View className='page-collection__foot'>
                        <Text className='text-tertiary'>{String(f.payload?.context || '公开场合')}</Text>
                      </View>
                    </View>
                  ) : (
                    <View
                      key={f.id}
                      className='card page-collection__report'
                      onClick={() => openPerson(f.person_key)}
                    >
                      <View className='page-collection__row'>
                        <View className={`page-collection__icon page-collection__icon--report`}>📄</View>
                        <View className='page-collection__row-info'>
                          <Text className='page-collection__row-name'>{f.name}</Text>
                          <Text className='text-tertiary'>报告 · 热度 {String(f.payload?.heat ?? '-')}</Text>
                        </View>
                        <Text
                          className='page-collection__op'
                          onClick={(e) => {
                            e.stopPropagation?.()
                            void onRemoveFavorite(f.id)
                          }}
                        >
                          取消收藏
                        </Text>
                      </View>
                      <View className='page-collection__foot'>
                        <Text className='text-tertiary'>收藏于 {fromNow(f.created_at)}</Text>
                      </View>
                    </View>
                  )
                })}
              </View>
            )
          ) : history.length === 0 ? (
            <EmptyState
              icon='🕘'
              title='暂无查询历史'
              desc='搜索过的名人会记录在这里（仅自己可见，保留最近 50 条）'
              actionText='去发现名人'
              onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
            />
          ) : (
            <View>
              <View className='page-collection__toolbar'>
                <Text className='text-tertiary'>仅保留最近 50 条</Text>
                <Text className='page-collection__op' onClick={() => void onClearHistory()}>
                  清空历史
                </Text>
              </View>
              {history.map((h) => {
                const domain = (parsePersonKey(h.person_key)?.domain ?? 'other') as DomainCode
                return (
                  <View
                    key={h.id}
                    className='card page-collection__hist'
                    onClick={() => openPerson(h.person_key)}
                  >
                    <View className='page-collection__row'>
                      <View className={`page-collection__icon page-collection__icon--${domain}`}>
                        {h.name.slice(0, 1)}
                      </View>
                      <View className='page-collection__row-info'>
                        <Text className='page-collection__row-name'>{h.name}</Text>
                        <Text className='text-tertiary'>{DOMAIN_META[domain].label}</Text>
                      </View>
                      <Text className='page-collection__time'>{fromNow(h.ts)}</Text>
                    </View>
                  </View>
                )
              })}
            </View>
          )}
        </View>
      )}

      <View className='disclaimer'>收藏与历史仅自己可见；可随时清空</View>
    </View>
  )
}
