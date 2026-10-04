import Taro, { useDidShow } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtButton, AtList, AtListItem, AtAvatar } from 'taro-ui'
import { useAuth } from '@/stores/auth'
import './index.scss'

export default function Mine() {
  const { ready, userId, nickname, error } = useAuth()

  // 登录在 app 启动时已触发；进入本页时刷新一次状态展示
  useDidShow(() => {
    // 阶段 2 联调：此处可补充诊断信息入口（getCloudDiagnostics）
  })

  const menus = [
    { title: '我的收藏', note: '名言 / 报告', onTap: () => Taro.showToast({ title: '阶段 6 开放', icon: 'none' }) },
    { title: '查询历史', note: '最近 50 条', onTap: () => Taro.showToast({ title: '阶段 6 开放', icon: 'none' }) },
    { title: '搜索源设置', note: 'Tavily key（仅存本地）', onTap: () => Taro.showToast({ title: '阶段 5 开放', icon: 'none' }) },
    { title: '隐私设置', note: '知识模式 / 数据管理', onTap: () => Taro.showToast({ title: '阶段 7 开放', icon: 'none' }) },
    { title: '内容举报 / 反馈', note: '', onTap: () => Taro.showToast({ title: '阶段 7 开放', icon: 'none' }) }
  ]

  return (
    <View className='page-mine safe-bottom'>
      <View className='page-mine__header'>
        <AtAvatar circle text={userId ? (nickname || '微').slice(0, 1) : '?'} size='large' className='page-mine__avatar' />
        <View className='page-mine__info'>
          <Text className='page-mine__name'>{userId ? (nickname || '已登录用户') : '未登录'}</Text>
          <Text className='page-mine__uid'>{userId ? `ID ${userId.slice(0, 10)}…` : '启动时自动登录'}</Text>
        </View>
        {!ready && <Text className='page-mine__status'>登录中…</Text>}
      </View>

      {error && (
        <View className='page-mine__error' onClick={() => Taro.showToast({ title: error, icon: 'none' })}>
          <Text>⚠ {error}</Text>
          <Text className='page-mine__error-action'>点击查看</Text>
        </View>
      )}

      <View className='card' style={{ padding: '8rpx 0' }}>
        <AtList hasBorder={false}>
          {menus.map((m) => (
            <AtListItem key={m.title} title={m.title} note={m.note || undefined} hasBorder arrow='right' onClick={m.onTap} />
          ))}
        </AtList>
      </View>

      <View className='card'>
        <AtButton type='secondary' size='small' circle onClick={() => Taro.showToast({ title: '阶段 7 开放', icon: 'none' })}>
          清空我的数据
        </AtButton>
        <View className='page-mine__version text-tertiary'>名人雷达 MVP · v0.1.0</View>
      </View>
    </View>
  )
}
