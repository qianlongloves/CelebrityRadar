import { View, Text } from '@tarojs/components'
import './index.scss'

export default function Profile() {
  // 阶段 5 接入：信息卡（热度/标签）+ 动态/名言两 Tab + 生成报告
  // 路由参数：personKey（§4.1）
  return (
    <View className='page-profile'>
      <View className='card'>
        <Text>名人主页（待实现：动态 / 名言两 Tab）</Text>
      </View>
    </View>
  )
}
