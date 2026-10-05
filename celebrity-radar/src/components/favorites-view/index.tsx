import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import Skeleton from '@/components/skeleton'
import EmptyState from '@/components/empty-state'
import { DOMAIN_META, DomainCode, parsePersonKey } from '@/config/domains'
import {
  listFavorites,
  removeFavorite,
  setFavoriteNote,
  FavoriteRow,
  FavoriteType,
  FAVORITE_TYPE_LABEL,
  FAVORITE_LIMIT,
  NOTE_MAX
} from '@/utils/favorites'
import { fromNow } from '@/utils/time'
import './index.scss'

/** 收藏类型筛选：四类混排后很难翻，按类型分开看 */
export type FavFilter = 'all' | FavoriteType

const FAV_FILTERS: Array<{ key: FavFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'report', label: FAVORITE_TYPE_LABEL.report },
  { key: 'quote', label: FAVORITE_TYPE_LABEL.quote },
  { key: 'dynamic', label: FAVORITE_TYPE_LABEL.dynamic },
  { key: 'timeline', label: FAVORITE_TYPE_LABEL.timeline }
]

interface FavoritesViewProps {
  /** 变化即重新拉取（由页面的 onShow 递增），保证从报告页返回后列表是最新的 */
  reloadKey?: number
}

/**
 * 我的收藏列表。
 *
 * 与浏览历史（components/history-view）此前挤在同一个双 Tab 组件里，
 * 现按「一个页面一件事」拆开：本组件只认收藏，tabBar「收藏」页与
 * 二级页「我的收藏」共用同一实现。
 *
 * 收藏粒度从「报告 / 名言」两类扩到四类（新增单条动态与履历节点），
 * 并支持用户备注：动态的收藏动机通常是「这条要跟进」，光有标题记不住为什么存它。
 */
export default function FavoritesView({ reloadKey }: FavoritesViewProps) {
  const [loading, setLoading] = useState(true)
  const [favorites, setFavorites] = useState<FavoriteRow[]>([])
  /** 类型筛选（刷新列表不重置） */
  const [favFilter, setFavFilter] = useState<FavFilter>('all')

  useEffect(() => {
    let alive = true
    setLoading(true)
    void listFavorites().then((f) => {
      if (!alive) return
      setFavorites(f)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [reloadKey])

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}` })
  }

  /**
   * 取消收藏。加二次确认：删除不可恢复，而列表项点击区面积大、易误触。
   */
  const onRemoveFavorite = async (id: string) => {
    const res = await Taro.showModal({
      title: '取消收藏',
      content: '取消后可以重新收藏',
      confirmText: '确定',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    await removeFavorite(id)
    setFavorites((prev) => prev.filter((f) => f.id !== id))
  }

  /**
   * 编辑备注。
   *
   * 用 showModal 的 editable 而不是自建弹层：这里只要一行短文本，
   * 为它引入一个带遮罩、键盘避让、滚动的弹窗组件不划算。
   * 保存失败时不动本地状态 —— 那行可能已在别处被取消收藏。
   */
  const onEditNote = async (f: FavoriteRow) => {
    /* editable / placeholderText 是微信原生弹窗能力，@tarojs/taro 3.6 的 Option
       类型定义还没补上这两项，只能整体断言；返回值里的 content 同理 */
    const option = {
      title: '备注',
      editable: true,
      placeholderText: '如：待跟进 / 引用素材',
      content: f.note ?? '',
      confirmText: '保存'
    } as unknown as Taro.showModal.Option
    const res = await Taro.showModal(option)
    const typed = res as { confirm?: boolean; content?: string }
    if (!typed.confirm) return
    const note = (typed.content ?? '').trim().slice(0, NOTE_MAX)
    if (note === (f.note ?? '')) return
    if (!(await setFavoriteNote(f.id, note))) {
      Taro.showToast({ title: '备注保存失败，请重试', icon: 'none' })
      return
    }
    setFavorites((prev) => prev.map((x) => (x.id === f.id ? { ...x, note } : x)))
    Taro.showToast({ title: note ? '备注已保存' : '备注已清空', icon: 'none' })
  }

  const countOf = (key: FavFilter): number =>
    key === 'all' ? favorites.length : favorites.filter((f) => f.type === key).length
  const shownFavorites =
    favFilter === 'all' ? favorites : favorites.filter((f) => f.type === favFilter)

  /** 备注行：无备注时是「加备注」入口，有备注时显示内容 + 改入口 */
  const renderNoteRow = (f: FavoriteRow) => (
    <View
      className='favorites-view__note'
      onClick={(e) => {
        /* 报告卡整卡可点，备注行必须拦住冒泡，否则点备注会顺带跳走 */
        e.stopPropagation?.()
        void onEditNote(f)
      }}
    >
      <Text className={`favorites-view__note-text${f.note ? '' : ' favorites-view__note-text--empty'}`}>
        {f.note ? `📝 ${f.note}` : '＋ 加备注'}
      </Text>
      {!!f.note && <Text className='favorites-view__note-edit'>改</Text>}
    </View>
  )

  /** 底部操作条：左侧收藏时间 + 右侧取消收藏 */
  const renderFoot = (f: FavoriteRow, main: string) => (
    <View className='favorites-view__foot'>
      <Text className='text-tertiary favorites-view__foot-main'>{main}</Text>
      <Text
        className='favorites-view__remove'
        onClick={(e) => {
          e.stopPropagation?.()
          void onRemoveFavorite(f.id)
        }}
      >
        取消收藏
      </Text>
    </View>
  )

  const renderCard = (f: FavoriteRow) => {
    const domain = (parsePersonKey(f.person_key)?.domain ?? 'other') as DomainCode
    const p = f.payload ?? {}

    /* 动态与履历节点卡片结构一致（头部 + 主文 + 备注 + 底栏），合并一条渲染路径 */
    if (f.type === 'dynamic' || f.type === 'timeline') {
      const isDynamic = f.type === 'dynamic'
      const sub = [FAVORITE_TYPE_LABEL[f.type], String(p.date ?? ''), String(p.source ?? '')]
        .filter((x) => x !== '')
        .join(' · ')
      return (
        <View key={f.id} className='card'>
          <View className='favorites-view__row'>
            <View className={`favorites-view__icon favorites-view__icon--${f.type}`}>
              {isDynamic ? '📰' : '📅'}
            </View>
            <View className='favorites-view__row-info' onClick={() => openPerson(f.person_key)}>
              <Text className='favorites-view__row-name'>{f.name}</Text>
              <Text className='text-tertiary'>{sub}</Text>
            </View>
          </View>
          <View className='favorites-view__body-text' onClick={() => openPerson(f.person_key)}>
            {String((isDynamic ? p.title : p.event) ?? '')}
          </View>
          {renderNoteRow(f)}
          {renderFoot(f, `收藏于 ${fromNow(f.created_at)}`)}
        </View>
      )
    }

    if (f.type === 'quote') {
      return (
        <View key={f.id} className='card'>
          <View className='favorites-view__row'>
            <View className='favorites-view__icon favorites-view__icon--quote'>「</View>
            <View className='favorites-view__row-info' onClick={() => openPerson(f.person_key)}>
              <Text className='favorites-view__row-name'>{f.name}</Text>
              <Text className='text-tertiary'>
                {DOMAIN_META[domain].label} · {FAVORITE_TYPE_LABEL.quote}
              </Text>
            </View>
          </View>
          <View
            className='favorites-view__body-text'
            onClick={() => openPerson(f.person_key)}
          >
            「{String(p.text ?? '')}」
          </View>
          {renderNoteRow(f)}
          {renderFoot(f, `${String(p.context || '公开场合')} · 收藏于 ${fromNow(f.created_at)}`)}
        </View>
      )
    }

    return (
      <View key={f.id} className='card' onClick={() => openPerson(f.person_key)}>
        <View className='favorites-view__row'>
          <View className='favorites-view__icon favorites-view__icon--report'>📄</View>
          <View className='favorites-view__row-info'>
            <Text className='favorites-view__row-name'>{f.name}</Text>
            <Text className='text-tertiary'>
              {FAVORITE_TYPE_LABEL.report} · 热度 {String(p.heat ?? '-')}
            </Text>
          </View>
        </View>
        {renderNoteRow(f)}
        {renderFoot(f, `收藏于 ${fromNow(f.created_at)}`)}
      </View>
    )
  }

  if (loading) {
    return (
      <View className='favorites-view'>
        <Skeleton variant='card' rows={3} />
      </View>
    )
  }

  if (favorites.length === 0) {
    return (
      <View className='favorites-view'>
        <EmptyState
          icon='⭐'
          title='还没有收藏'
          desc='在报告页可收藏整份报告、单句名言、单条动态或履历节点'
          actionText='去发现名人'
          onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
        />
      </View>
    )
  }

  return (
    <View className='favorites-view'>
      {/* 类型筛选。小号胶囊 + 浅紫选中，计数缩小降透明度；
          它是页面的分类开关而非主导航，视觉重量刻意压低 */}
      <View className='favorites-view__filters'>
        {FAV_FILTERS.map((f) => (
          <View
            key={f.key}
            className={`favorites-view__filter ${
              favFilter === f.key ? 'favorites-view__filter--active' : ''
            }`}
            onClick={() => setFavFilter(f.key)}
          >
            {f.label}
            <Text className='favorites-view__filter-count'>{countOf(f.key)}</Text>
          </View>
        ))}
      </View>

      {shownFavorites.length === 0 ? (
        <EmptyState
          icon='🔍'
          title='这个分类还没有收藏'
          desc='切回「全部」看看其他收藏'
          actionText='查看全部'
          onAction={() => setFavFilter('all')}
        />
      ) : (
        <View>
          {shownFavorites.map((f) => renderCard(f))}

          <View className='favorites-view__foot-note'>
            {favFilter === 'all'
              ? `共 ${favorites.length} 条`
              : `筛选出 ${shownFavorites.length} 条 / 共 ${favorites.length} 条`}
            {favorites.length >= FAVORITE_LIMIT ? ` · 仅保留最近 ${FAVORITE_LIMIT} 条` : ''}
          </View>
        </View>
      )}

      <View className='disclaimer'>收藏与备注仅自己可见；可随时取消</View>
    </View>
  )
}
