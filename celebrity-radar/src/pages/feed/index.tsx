import Taro from '@tarojs/taro'
import { View } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import './index.scss'

export default function Feed() {
  // 阶段 4/5 接入：feed_cache 归并展示 + 下拉刷新（每账号/日 ≤10 次，§3.8）
  const goDiscover = () => {
    Taro.switchTab({ url: '/pages/index/index' })
  }

  return (
    <View className='page-feed safe-bottom'>
      <EmptyState
        icon='📡'
        title='还没有关注动态'
        desc='关注名人后，这里会聚合展示 TA 的近期公开动态；手动刷新每日限 10 次'
        actionText='去发现名人'
        onAction={goDiscover}
      />
      <View className='disclaimer'>
        动态内容来自公开网络检索，由 AI 整理，仅供参考
      </View>
    </View>
  )
}
