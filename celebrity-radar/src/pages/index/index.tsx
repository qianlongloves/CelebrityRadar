import { useState } from 'react'
import { View } from '@tarojs/components'
import { AtSearchBar, AtButton } from 'taro-ui'
import './index.scss'

export default function Index() {
  const [keyword, setKeyword] = useState('')
  return (
    <View className='page-index'>
      <View className='page-index__hero'>
        <View className='page-index__title'>名人雷达</View>
        <View className='page-index__subtitle'>输入名人名字，AI 整理近期动态与名言</View>
      </View>
      <AtSearchBar
        value={keyword}
        onChange={setKeyword}
        placeholder='输入名人名字，如：雷军'
      />
      <View className='page-index__hint text-secondary'>
        内容由 AI 基于公开网络信息生成，仅供参考
      </View>
      {/* 阶段 3 接入：敏感过滤 → 消歧候选 → personKey 缓存查询 */}
      <AtButton type='primary' disabled={!keyword}>搜索名人</AtButton>
    </View>
  )
}
