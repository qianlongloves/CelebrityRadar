import { View, Text } from '@tarojs/components'
import { AtButton, AtIcon } from 'taro-ui'
import { useRouter } from '@tarojs/taro'
import EmptyState from '@/components/empty-state'
import './index.scss'

/** 深度报告页（六段卡片化渲染骨架，§2.3 Schema v2）
 *  数据生成与缓存接入在阶段 4；本页先落布局与状态位。 */
export default function Report() {
  const router = useRouter()
  const personKey = router.params.personKey || ''
  const name = decodeURIComponent(personKey.split('#')[0] || '名人')

  // 阶段 4 接入后由报告数据驱动（knowledge = 橙色警示条，§2.4）
  const isKnowledgeMode = false

  return (
    <View className='page-report safe-bottom'>
      {isKnowledgeMode && (
        <View className='warn-bar'>
          <AtIcon value='alert-circle' size='16' color='#b45309' />
          <Text>知识模式结果：无实时来源，内容可能不准确（可在设置中关闭）</Text>
        </View>
      )}

      <View className='card page-report__header'>
        <View className='page-report__title-row'>
          <Text className='page-report__name'>{name}</Text>
          <View className='chip'>深度报告</View>
        </View>
        <View className='page-report__meta'>
          {/* 缓存命中时显示「生成于 xx 前 · 查看最新」双入口（§2.4） */}
          <Text className='text-tertiary'>生成于 -- · 内容随缓存更新</Text>
        </View>
      </View>

      <View className='card'>
        <View className='card-title'>简介</View>
        <View className='text-secondary'>一句话简介（AI 生成）</View>
      </View>

      <View className='card'>
        <View className='card-title'>近期动态</View>
        <View className='text-secondary'>带日期 / 摘要 / 来源 / 情绪标签的动态列表</View>
      </View>

      <View className='card'>
        <View className='card-title'>经典名言</View>
        <View className='text-secondary'>逐条带出处的语录，可单独复制（自动附来源）</View>
      </View>

      <View className='card'>
        <View className='card-title'>AI 点评</View>
        <View className='text-secondary'>风格 / 近期态度 / 热点综合点评</View>
      </View>

      <View className='card'>
        <View className='card-title'>时间线</View>
        <View className='text-secondary'>关键事件时间轴</View>
      </View>

      <View className='card'>
        <View className='card-title'>信息来源</View>
        <View className='text-secondary'>全部来源可溯源（审核核心材料，§六.2）</View>
      </View>

      <View className='page-report__actions'>
        <AtButton type='primary' circle>生成 / 刷新报告</AtButton>
      </View>

      <EmptyState icon='🗂' title='报告数据待接入' desc='阶段 4：缓存查询 → Tavily 检索 → LLM 生成 → 白名单校验 → 落库' />

      <View className='disclaimer'>
        内容由 AI 基于公开网络信息生成，仅供参考，不代表本平台立场；来源 URL 均来自公开检索结果
      </View>
    </View>
  )
}
