import { useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtButton, AtList, AtListItem, AtAvatar } from 'taro-ui'
import { useAuth } from '@/stores/auth'
import { getTavilyKey, setTavilyKey, isKnowledgeModeEnabled, setKnowledgeMode } from '@/utils/settings'
import './index.scss'

export default function Mine() {
  const { ready, userId, nickname, error } = useAuth()
  const [hasKey, setHasKey] = useState(false)
  const [knowledgeMode, setKnowledgeMode] = useState(false)

  useDidShow(() => {
    setHasKey(getTavilyKey() !== null)
    setKnowledgeMode(isKnowledgeModeEnabled())
  })

  /** 搜索源 key 管理（仅存本地 storage，§3.5）
   *  editable/content 为微信基础库 2.17.1+ 能力，Taro 3.6 类型未收录，运行时可用 */
  const editTavilyKey = async () => {
    const res = (await Taro.showModal({
      title: '搜索源 key（Tavily）',
      editable: true,
      placeholderText: hasKey ? '已配置，留空则清除' : '粘贴 tvly- 开头的 key',
      confirmText: '保存'
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    } as any)) as Taro.showModal.SuccessCallbackResult & { content?: string }
    if (!res.confirm) return
    const value = (res.content ?? '').trim()
    setTavilyKey(value || null)
    setHasKey(getTavilyKey() !== null)
    Taro.showToast({ title: value ? '已保存（仅存本地）' : '已清除', icon: 'none' })
  }

  /** 清空我的数据：本地设置（DB 侧删除在阶段 7 合规项统一处理） */
  const clearMyData = async () => {
    const res = await Taro.showModal({
      title: '清空我的数据',
      content: '将清除本地保存的搜索源 key 与偏好设置，不可恢复。云端数据（关注/收藏/历史）可在举报反馈中申请删除。',
      confirmText: '清除',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    setTavilyKey(null)
    setKnowledgeMode(false)
    setHasKey(false)
    setKnowledgeMode(false)
    Taro.showToast({ title: '已清空本地数据', icon: 'none' })
  }

  const menus = [
    { title: '我的收藏', note: '名言 / 报告', onTap: () => Taro.showToast({ title: '阶段 6 开放', icon: 'none' }) },
    { title: '查询历史', note: '最近 50 条', onTap: () => Taro.showToast({ title: '阶段 6 开放', icon: 'none' }) },
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
          <AtListItem
            title='搜索源设置'
            note={hasKey ? '已配置（仅存本地）' : '未配置：无法联网生成报告'}
            arrow='right'
            hasBorder
            onClick={() => void editTavilyKey()}
          />
          <AtListItem
            title='知识模式'
            note='无联网素材时用 AI 已有知识生成（可能不准确）'
            isSwitch
            switchIsCheck={knowledgeMode}
            hasBorder
            onSwitchChange={(e) => {
              /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
              const v = Boolean((e as any)?.detail?.value)
              setKnowledgeMode(v)
              setKnowledgeMode(v)
              Taro.showToast({ title: v ? '已开启（结果带警示条）' : '已关闭', icon: 'none' })
            }}
          />
          {menus.map((m) => (
            <AtListItem
              key={m.title}
              title={m.title}
              note={m.note || undefined}
              hasBorder
              arrow='right'
              onClick={m.onTap}
            />
          ))}
        </AtList>
      </View>

      <View className='card'>
        <AtButton type='secondary' size='small' circle onClick={() => void clearMyData()}>
          清空我的数据
        </AtButton>
        <View className='page-mine__version text-tertiary'>名人雷达 MVP · v0.1.0</View>
      </View>

      <View className='disclaimer'>
        搜索源 key 仅存储在你的设备本地，不会上传；内容由 AI 基于公开网络信息生成，仅供参考
      </View>
    </View>
  )
}
