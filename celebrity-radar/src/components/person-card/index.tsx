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
  heat?: number
  followed?: boolean
}

interface PersonCardProps {
  person: PersonInfo
  /** 右侧操作：关注/取关 或 查看报告 等 */
  actionText?: string
  onAction?: (p: PersonInfo) => void
  onClick?: (p: PersonInfo) => void
}

/** 名人卡：消歧候选、关注列表、热门位共用 */
export default function PersonCard({ person, actionText, onAction, onClick }: PersonCardProps) {
  const meta = DOMAIN_META[person.domain] ?? DOMAIN_META.other
  return (
    <View className='person-card' onClick={() => onClick?.(person)}>
      <View className={`person-card__avatar person-card__avatar--${person.domain}`}>{person.name.slice(0, 1)}</View>
      <View className='person-card__main'>
        <View className='person-card__name-row'>
          <Text className='person-card__name'>{person.name}</Text>
          <View className={`chip chip--${person.domain}`}>{meta.label}</View>
        </View>
        {person.brief && <View className='person-card__brief'>{person.brief}</View>}
      </View>
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
