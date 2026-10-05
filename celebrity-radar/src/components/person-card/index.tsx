import { View, Text } from '@tarojs/components'
import { AtButton } from 'taro-ui'
import { DOMAIN_META, DomainCode } from '@/config/domains'
import './index.scss'

export interface PersonInfo {
  personKey: string
  name: string
  domain: DomainCode
  /** 一句代表事件 / 简介（消歧候选用） */
  brief?: string
  /** 动态关键词标签（热门位用） */
  tag?: string
  /** 静态热门指数（传入才渲染热度条） */
  heat?: number
  followed?: boolean
}

interface PersonCardProps {
  person: PersonInfo
  /** 右侧操作：关注/取关 或 查看报告 等 */
  actionText?: string
  onAction?: (p: PersonInfo) => void
  onClick?: (p: PersonInfo) => void
  /**
   * 传入即在卡片上渲染关注按钮（消歧候选 / 热门位用）。
   * 此前这两处只有「查看报告」一个出口，想关注必须先跳到报告页或名人主页。
   */
  onToggleFollow?: (p: PersonInfo) => void
  /** 该卡片的关注请求进行中：按钮置灰，避免连点导致关注态来回翻转 */
  followPending?: boolean
}

/** 名人卡：消歧候选、关注列表、热门位共用 */
export default function PersonCard({
  person,
  actionText,
  onAction,
  onClick,
  onToggleFollow,
  followPending
}: PersonCardProps) {
  const meta = DOMAIN_META[person.domain] ?? DOMAIN_META.other
  return (
    <View className='person-card' onClick={() => onClick?.(person)}>
      <View className={`person-card__avatar person-card__avatar--${person.domain}`}>{person.name.slice(0, 1)}</View>
      <View className='person-card__main'>
        <View className='person-card__name-row'>
          <Text className='person-card__name'>{person.name}</Text>
          <View className={`chip chip--${person.domain}`}>{meta.label}</View>
        </View>
        {(person.tag || person.brief) && (
          <View className='person-card__brief-row'>
            {person.tag && <View className='person-card__tag'>{person.tag}</View>}
            {person.brief && <View className='person-card__brief'>{person.brief}</View>}
          </View>
        )}
        {typeof person.heat === 'number' && (
          <View className='person-card__heat'>
            <View className='person-card__heat-bar'>
              <View
                className={`person-card__heat-fill person-card__heat-fill--${person.domain}`}
                style={{ width: `${Math.min(100, Math.max(0, person.heat))}%` }}
              />
            </View>
            <Text className='person-card__heat-num'>{person.heat}</Text>
          </View>
        )}
      </View>
      {/* 直接关注：描边式，视觉上弱于实心的主操作按钮（先关注、再看报告是更轻的路径） */}
      {onToggleFollow && (
        <View
          className={`person-card__follow ${person.followed ? 'person-card__follow--on' : ''} ${
            followPending ? 'person-card__follow--pending' : ''
          }`}
          hoverClass='person-card__follow--tap'
          onClick={(e) => {
            e.stopPropagation?.()
            if (!followPending) onToggleFollow(person)
          }}
        >
          {person.followed ? '已关注' : '关注'}
        </View>
      )}
      {actionText && onAction && (
        <AtButton
          size='small'
          type={person.followed ? 'secondary' : 'primary'}
          circle
          className='person-card__action'
          onClick={(e) => {
            e.stopPropagation?.()
            onAction(person)
          }}
        >
          {actionText}
        </AtButton>
      )}
    </View>
  )
}
