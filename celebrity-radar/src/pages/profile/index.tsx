import { useState } from 'react'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtTabs, AtButton, AtActivityIndicator } from 'taro-ui'
import { DOMAIN_META, DomainCode, parsePersonKey } from '@/config/domains'
import EmptyState from '@/components/empty-state'
import { getCachedReport } from '@/utils/cache'
import { Report } from '@/utils/report'
import { isFollowed, toggleFollow } from '@/utils/follows'
import { fromNow } from '@/utils/time'
import './index.scss'

/** 名人主页（M2 简版：动态 / 名言两 Tab，数据读报告缓存，不触发生成） */
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
    const next = await toggleFollow(personKey)
    setFollowed(next)
    Taro.showToast({ title: next ? '已关注' : '已取消关注', icon: 'none' })
  }

  const heat = report?.heat ?? 0

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

      {loading && <AtActivityIndicator mode='center' content='加载中…' className='page-profile__loading' />}

      {!loading && !report && (
        <EmptyState
          icon='🗂'
          title='还没有生成过报告'
          desc='生成后将在这里展示 TA 的近期动态与经典名言'
          actionText='生成深度报告'
          onAction={goReport}
        />
      )}

      {!loading && report && (
        <AtTabs
          current={tab}
          tabList={[
            { title: `动态 (${report.dynamics.length})` },
            { title: `名言 (${report.quotes.length})` }
          ]}
          onClick={setTab}
          className='page-profile__tabs'
        >
          {tab === 0 ? (
            report.dynamics.length === 0 ? (
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
            )
          ) : report.quotes.length === 0 ? (
            <EmptyState icon='💬' title='暂无整理名言' desc='名言来自公开资料与新闻素材' />
          ) : (
            report.quotes.map((q, i) => (
              <View key={i} className='card page-profile__quote'>
                <View className='page-profile__quote-text'>「{q.text}」</View>
                <View className='page-profile__quote-foot'>
                  <Text className='text-tertiary'>{q.context || '公开场合'}</Text>
                  <Text
                    className='page-profile__copy'
                    onClick={() => Taro.setClipboardData({ data: `${q.text}\n—— 来源：${q.source}` })}
                  >
                    复制这句
                  </Text>
                </View>
              </View>
            ))
          )}
        </AtTabs>
      )}

      <View className='disclaimer'>内容由 AI 基于公开网络信息生成，仅供参考</View>
    </View>
  )
}
