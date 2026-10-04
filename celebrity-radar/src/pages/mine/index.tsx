import { useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { View, Text, Button } from '@tarojs/components'
import { AtButton, AtList, AtListItem } from 'taro-ui'
import { useAuth } from '@/stores/auth'
import { getTavilyKey, setTavilyKey, isKnowledgeModeEnabled, setKnowledgeMode } from '@/utils/settings'
import { clearAllMyData } from '@/utils/data-deletion'
import { setPendingCollectionTab } from '@/utils/tab-target'
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

  /** 清空我的数据：本地设置 + 云端（follows / favorites / history，§六.6） */
  const clearMyData = async () => {
    const res = await Taro.showModal({
      title: '清空我的数据',
      content: '将清除本地保存的搜索源 key 与偏好设置，并删除云端的关注、收藏、历史记录，不可恢复。',
      confirmText: '清除',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    const ok = await clearAllMyData()
    setTavilyKey(null)
    setKnowledgeMode(false)
    setHasKey(false)
    setKnowledgeMode(false)
    Taro.showToast({ title: ok ? '已清空全部数据' : '本地已清空，云端删除失败请稍后重试', icon: 'none' })
  }

  const menus = [
    {
      icon: '⭐',
      iconBg: 'brand',
      title: '我的收藏',
      note: '名言 / 报告',
      onTap: () => {
        setPendingCollectionTab('favorites')
        Taro.switchTab({ url: '/pages/collection/index' })
      }
    },
    {
      icon: '🕘',
      iconBg: 'blue',
      title: '查询历史',
      note: '最近 50 条',
      onTap: () => {
        setPendingCollectionTab('history')
        Taro.switchTab({ url: '/pages/collection/index' })
      }
    },
    {
      icon: '🛡',
      iconBg: 'orange',
      title: '隐私与免责声明',
      note: '隐私清单 · 免责文案',
      onTap: () => Taro.navigateTo({ url: '/pages/agreement/index' })
    }
  ]

  return (
    <View className='page-mine glow-page safe-tab'>
      <View className='page-mine__banner'>
        <View
          className='page-mine__avatar'
        >
          {userId ? (nickname || '微').slice(0, 1) : '?'}
        </View>
        <View className='page-mine__info'>
          <Text className='page-mine__hello'>Hello!</Text>
          <Text className='page-mine__name'>{userId ? nickname || '名人观察员' : '名人观察员'}</Text>
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
        </AtList>
      </View>

      <View className='card page-mine__menus'>
        {menus.map((m) => (
          <View key={m.title} className='page-mine__menu' onClick={m.onTap}>
            <View className={`page-mine__menu-icon page-mine__menu-icon--${m.iconBg}`}>{m.icon}</View>
            <View className='page-mine__menu-info'>
              <Text className='page-mine__menu-title'>{m.title}</Text>
              <Text className='page-mine__menu-note'>{m.note}</Text>
            </View>
            <Text className='page-mine__menu-arrow'>›</Text>
          </View>
        ))}
      </View>

      <View className='card' style={{ padding: '8rpx 0' }}>
        {/* 内容举报 / 反馈：微信客服会话（open-type=contact），需在小程序后台开通客服 */}
        <Button className='page-mine__contact' openType='contact' hoverClass='none'>
          <Text>内容举报 / 反馈</Text>
          <Text className='page-mine__contact-note'>名誉投诉核实后下线对应内容</Text>
        </Button>
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
