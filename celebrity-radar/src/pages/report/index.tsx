import { View, Text } from '@tarojs/components'
import './index.scss'

export default function Report() {
  // 阶段 5 接入：六段卡片化渲染 + 缓存双入口 + 免责条 + knowledge 警示条
  // 路由参数：personKey（§4.1）
  return (
    <View className='page-report'>
      <View className='card'>
        <Text>深度报告（待实现：六段卡片化渲染）</Text>
      </View>
    </View>
  )
}
