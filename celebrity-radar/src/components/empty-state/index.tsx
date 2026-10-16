import { View, Text } from '@tarojs/components'
/* 按需引入：'taro-ui' 的包入口（dist/index.js）是打包好的 CJS，50 个组件全在里面且摇不掉，
   故组件一律从 dist/components/<名字> 取（那一层是 ESM 源码）。用例 70 钉住这一点。 */
import AtButton from 'taro-ui/dist/components/button'
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
