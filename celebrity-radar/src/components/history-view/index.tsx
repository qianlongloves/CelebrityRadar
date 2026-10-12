import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { ScrollView, View, Text } from '@tarojs/components'
import Skeleton from '@/components/skeleton'
import EmptyState from '@/components/empty-state'
import PersonAvatar from '@/components/person-avatar'
import { domainLabel, domainStyleCode, parsePersonKey } from '@/config/domains'
import { getCachedReports } from '@/utils/cache'
import { listHistory, clearHistory, HistoryRow, HISTORY_LIMIT } from '@/utils/history'
import { readPortraits } from '@/utils/portrait'
import { fromNow, isStaleReport } from '@/utils/time'
import './index.scss'

interface HistoryViewProps {
  /** 变化即重新拉取（由页面的 onShow 递增） */
  reloadKey?: number
}

/** 「继续看」卡片数：只用最近的 3 位 —— 再多就退化成下面那列列表本身了 */
const CONTINUE_MAX = 3

interface ContinueCard {
  personKey: string
  name: string
  /** 领域（自由短串，2026-10-12 领域自由化） */
  domain: string
  /** 缓存报告的生成时间（'' = 该人没有可用缓存） */
  generatedAt: string
  /** 是否已陈旧（≥ STALE_REPORT_DAYS 天，见 utils/time） */
  stale: boolean
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
  /** 「继续看」卡片（O-15）：报告信息在历史表里没有，见下方注释 */
  const [recent, setRecent] = useState<ContinueCard[]>([])

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

  /**
   * 「继续看」卡片上的报告时间（O-14 的历史页落点）。
   *
   * `history` 表只存「谁、什么时候看过」，**不存报告版本** —— 而这一行卡片的价值恰恰在于
   * 「昨天那份还能接着用吗」，所以这里用一次 `getCachedReports` 批量读回最近 3 位的缓存报告
   * （`in` 一次往返，只读不触发生成）。这是全项目唯一为本功能新增的一次云读，
   * 换来的是历史页第一次能说清「你手上的这份报告是哪一版」；读不到就退化成「未生成报告」，
   * 不阻塞列表渲染。
   */
  useEffect(() => {
    const picks = history.slice(0, CONTINUE_MAX)
    if (picks.length === 0) {
      setRecent([])
      return
    }
    let alive = true
    void getCachedReports(picks.map((h) => h.person_key)).then((reports) => {
      if (!alive) return
      setRecent(
        picks.map((h, i) => {
          const generatedAt = reports[i]?.generatedAt ?? ''
          return {
            personKey: h.person_key,
            name: h.name,
            domain: parsePersonKey(h.person_key)?.domain ?? 'other',
            generatedAt,
            stale: isStaleReport(generatedAt)
          }
        })
      )
    })
    return () => {
      alive = false
    }
  }, [history])

  /* 真图预热：历史页有「继续看」与流水两处列表，一次批量读把全部人拉进缓存，避免逐行云调用 */
  useEffect(() => {
    const keys = [...recent.map((c) => c.personKey), ...history.map((h) => h.person_key)]
    if (keys.length > 0) void readPortraits(keys)
  }, [recent, history])

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
    /* 删除失败时**不清空本地列表、不报「已清空」**：否则下次进来记录原样回来 */
    const ok = await clearHistory()
    if (!ok) {
      void Taro.showToast({ title: '清空失败，请重试', icon: 'none' })
      return
    }
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

      {/*
        「继续看」（O-15）：最近 3 位横滑卡片，顺序直接沿用 history 的既有顺序（时间倒序）。
        列表是「流水」，这一行才是「动作」—— 用户回历史页的真实意图是「接着看昨天那份」，
        而不是重读一遍时间线；卡片上的报告时间还顺带回答「这份还新吗」（O-14）。
      */}
      {recent.length > 0 && (
        <View className='history-view__continue'>
          <Text className='history-view__continue-title'>继续看</Text>
          <ScrollView className='history-view__continue-row' scrollX>
            {recent.map((c) => (
              <View
                key={c.personKey}
                className='history-view__continue-card'
                hoverClass='history-view__continue-card--tap'
                onClick={() => openPerson(c.personKey)}
              >
                <PersonAvatar
                  personKey={c.personKey}
                  name={c.name}
                  domain={c.domain}
                  className={`history-view__continue-avatar history-view__continue-avatar--${domainStyleCode(c.domain)}`}
                />
                <Text className='history-view__continue-name'>{c.name}</Text>
                <Text
                  className={`history-view__continue-age${
                    c.stale ? ' history-view__continue-age--stale' : ''
                  }`}
                >
                  {c.generatedAt
                    ? `${fromNow(c.generatedAt)}${c.stale ? ' · 建议刷新' : ''}`
                    : '未生成报告'}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {history.map((h) => {
        const domain = parsePersonKey(h.person_key)?.domain ?? 'other'
        return (
          <View
            key={h.id}
            className='card'
            onClick={() => openPerson(h.person_key)}
          >
            <View className='history-view__row'>
              <PersonAvatar
                personKey={h.person_key}
                name={h.name}
                domain={domain}
                className={`history-view__icon history-view__icon--${domainStyleCode(domain)}`}
              />
              <View className='history-view__row-info'>
                <Text className='history-view__row-name'>{h.name}</Text>
                <Text className='text-tertiary'>{domainLabel(domain)}</Text>
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
