import { View, Text } from '@tarojs/components'
import './index.scss'

export default function Feed() {
  // 阶段 5 接入：feed_cache 归并 + 下拉刷新（受配额）
  return (
    <View className='page-feed'>
      <View className='card'>
        <Text>关注流（待实现：feed_cache 归并展示）</Text>
      </View>
    </View>
  )
}
