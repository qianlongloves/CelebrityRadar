import { View, Text } from '@tarojs/components'
import { AtButton } from 'taro-ui'
import './index.scss'

interface EmptyStateProps {
  icon?: string
  title: string
  desc?: string
  actionText?: string
  onAction?: () => void
}

/** 通用空态（§4.3：空态有插画位与行动按钮） */
export default function EmptyState({ icon = '🔍', title, desc, actionText, onAction }: EmptyStateProps) {
  return (
    <View className='empty-state'>
      <View className='empty-state__icon'>{icon}</View>
      <View className='empty-state__title'>{title}</View>
      {desc && <View className='empty-state__desc'>{desc}</View>}
      {actionText && onAction && (
        <AtButton size='small' type='secondary' circle onClick={onAction} className='empty-state__action'>
          {actionText}
        </AtButton>
      )}
    </View>
  )
}
