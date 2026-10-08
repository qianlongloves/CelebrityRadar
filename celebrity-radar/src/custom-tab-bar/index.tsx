import { useEffect, useState } from 'react'
import Taro, { eventCenter } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { exploreRandomPerson } from '../utils/explore'
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
  /* 第二格原为「关注」：关注流改二级页后，这里让给「AI 提问」（对话气泡图标） */
  { path: '/pages/ask/index', label: 'AI 提问', icon: 'chat' },
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

  /**
   * 中央按钮：AI 随机挑一位名人。
   * 选题、降级、loading 都在 utils/explore 的 exploreRandomPerson 里，这里只维护视觉状态：
   * 按下的反馈必须是即时的，不该等一个网络往返。
   */
  const [picking, setPicking] = useState(false)

  const explore = async () => {
    if (picking) return
    setPicking(true)
    await exploreRandomPerson()
    setPicking(false)
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

        {/* 中央凸起按钮：骰子 = 随机探索，人选由 AI 决定（见 utils/explore） */}
        <View className={`tabbar__center ${picking ? 'tabbar__center--busy' : ''}`} onClick={explore}>
          <View className='tabbar__center-icon' />
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
