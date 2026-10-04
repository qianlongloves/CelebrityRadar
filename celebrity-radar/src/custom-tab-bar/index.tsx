import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { openRandomPerson } from '../utils/explore'
import './index.scss'

/** 自定义底部菜单（参照 Figma：半透明浅紫底栏 + 中央凸起紫色圆钮 + 四图标槽位） */

interface TabItem {
  path: string
  label: string
  icon: string
}

const TABS: TabItem[] = [
  { path: '/pages/index/index', label: '发现', icon: 'home' },
  { path: '/pages/feed/index', label: '关注流', icon: 'calendar' },
  { path: '/pages/collection/index', label: '收藏', icon: 'doc' },
  { path: '/pages/mine/index', label: '我的', icon: 'user' }
]

export default function CustomTabBar() {
  const [selected, setSelected] = useState('')

  /* 每个页面的 tabbar 实例独立挂载：mount 时读当前路由确定选中态 */
  useEffect(() => {
    const pages = Taro.getCurrentPages()
    const current = pages[pages.length - 1]
    const route = current ? `/${current.route}` : ''
    const hit = TABS.find((t) => t.path === route)
    setSelected(hit ? hit.path : TABS[0].path)
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
