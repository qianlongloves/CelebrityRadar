import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import Skeleton from '@/components/skeleton'
import EmptyState from '@/components/empty-state'
import { DOMAIN_META, DomainCode, parsePersonKey } from '@/config/domains'
import { listHistory, clearHistory, HistoryRow, HISTORY_LIMIT } from '@/utils/history'
import { fromNow } from '@/utils/time'
import './index.scss'

interface HistoryViewProps {
  /** 变化即重新拉取（由页面的 onShow 递增） */
  reloadKey?: number
}

/**
 * 浏览历史列表（pages/history 专用）。
 *
 * 此前与收藏挤在同一个双 Tab 组件里，现按「一个页面一件事」拆开 ——
 * 历史是只读流水（唯一操作是整体清空），与收藏的增删是两种交互模型，
 * 混在一起时筛选条与工具栏叠成三层，谁管谁都说不清。
 */
export default function HistoryView({ reloadKey }: HistoryViewProps) {
  const [loading, setLoading] = useState(true)
  const [history, setHistory] = useState<HistoryRow[]>([])

  useEffect(() => {
    let alive = true
    setLoading(true)
    void listHistory().then((h) => {
      if (!alive) return
      setHistory(h)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [reloadKey])

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}` })
  }

  const onClearHistory = async () => {
    const res = await Taro.showModal({
      title: '清空浏览历史',
      content: '将删除全部历史记录，不可恢复',
      confirmText: '清空',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    await clearHistory()
    setHistory([])
    Taro.showToast({ title: '已清空', icon: 'none' })
  }

  if (loading) {
    return (
      <View className='history-view'>
        <Skeleton variant='card' rows={3} />
      </View>
    )
  }

  if (history.length === 0) {
    return (
      <View className='history-view'>
        <EmptyState
          icon='🕘'
          title='暂无浏览历史'
          desc={`搜索过的名人会记录在这里（仅自己可见，保留最近 ${HISTORY_LIMIT} 条）`}
          actionText='去发现名人'
          onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
        />
      </View>
    )
  }

  return (
    <View className='history-view'>
      <View className='history-view__toolbar'>
        <Text className='text-tertiary'>
          共 {history.length} 条 · 仅保留最近 {HISTORY_LIMIT} 条
        </Text>
        <Text className='history-view__danger' onClick={() => void onClearHistory()}>
          清空历史
        </Text>
      </View>

      {history.map((h) => {
        const domain = (parsePersonKey(h.person_key)?.domain ?? 'other') as DomainCode
        return (
          <View
            key={h.id}
            className='card'
            onClick={() => openPerson(h.person_key)}
          >
            <View className='history-view__row'>
              <View className={`history-view__icon history-view__icon--${domain}`}>
                {h.name.slice(0, 1)}
              </View>
              <View className='history-view__row-info'>
                <Text className='history-view__row-name'>{h.name}</Text>
                <Text className='text-tertiary'>{DOMAIN_META[domain].label}</Text>
              </View>
              <Text className='history-view__time'>{fromNow(h.ts)}</Text>
            </View>
          </View>
        )
      })}

      <View className='disclaimer'>浏览历史仅自己可见；可随时清空</View>
    </View>
  )
}
