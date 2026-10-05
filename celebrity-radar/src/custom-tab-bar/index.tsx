import { useEffect, useState } from 'react'
import Taro, { eventCenter } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { openRandomPerson } from '../utils/explore'
import { TABBAR_SYNC_EVENT } from '../utils/tabbar'
import './index.scss'

/** 自定义底部菜单（参照 Figma：半透明浅紫底栏 + 中央凸起紫色圆钮 + 四图标槽位） */

interface TabItem {
  path: string
  label: string
  icon: string
}

const TABS: TabItem[] = [
  { path: '/pages/index/index', label: '发现', icon: 'home' },
  { path: '/pages/feed/index', label: '关注', icon: 'calendar' },
  { path: '/pages/collection/index', label: '收藏', icon: 'doc' },
  { path: '/pages/mine/index', label: '我的', icon: 'user' }
]

/** 归一化路由：个别基础库给的是带前导斜杠的完整路径，不统一就一个都匹配不上、恒亮首项 */
function currentRoute(): string {
  const pages = Taro.getCurrentPages()
  const cur = pages[pages.length - 1]
  const raw = cur && cur.route ? cur.route : ''
  return raw.startsWith('/') ? raw : `/${raw}`
}

export default function CustomTabBar() {
  const [selected, setSelected] = useState('')

  useEffect(() => {
    const sync = () => {
      const route = currentRoute()
      const hit = TABS.find((t) => t.path === route)
      setSelected(hit ? hit.path : TABS[0].path)
    }
    sync()
    eventCenter.on(TABBAR_SYNC_EVENT, sync)
    return () => {
      eventCenter.off(TABBAR_SYNC_EVENT, sync)
    }
  }, [])

  const switchTo = (path: string) => {
    if (path === selected) return
    Taro.switchTab({ url: path })
  }

  return (
    <View className='tabbar'>
      <View className='tabbar__inner'>
        {/* 左侧两槽位 */}
        {TABS.slice(0, 2).map((t) => (
          <View
            key={t.path}
            className={`tabbar__item ${selected === t.path ? 'tabbar__item--active' : ''}`}
            onClick={() => switchTo(t.path)}
          >
            <View className={`tabbar__icon tabbar__icon--${t.icon}`} />
            <Text className='tabbar__label'>{t.label}</Text>
          </View>
        ))}

        {/* 中央凸起按钮：随机探索一位名人 */}
        <View className='tabbar__center' onClick={() => openRandomPerson()}>
          <View className='tabbar__center-plus' />
        </View>

        {/* 右侧两槽位 */}
        {TABS.slice(2).map((t) => (
          <View
            key={t.path}
            className={`tabbar__item ${selected === t.path ? 'tabbar__item--active' : ''}`}
            onClick={() => switchTo(t.path)}
          >
            <View className={`tabbar__icon tabbar__icon--${t.icon}`} />
            <Text className='tabbar__label'>{t.label}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}
