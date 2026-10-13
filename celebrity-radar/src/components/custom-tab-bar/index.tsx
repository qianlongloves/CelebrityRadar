import { useEffect, useState } from 'react'
import Taro, { eventCenter } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { exploreRandomPerson } from '../../utils/explore'
import { TABBAR_SYNC_EVENT } from '../../utils/tabbar'
import './index.scss'

/** 自定义底部菜单（悬浮胶囊底栏 + 中央凸起紫色圆钮 + 四个 tab 槽位） */

interface TabItem {
  path: string
  label: string
  icon: string
}

/**
 * 四格主菜单：查 / 问 / 盯 / 管。
 *
 * 2026-10-13 由「发现 / AI 提问 / 收藏 / 我的」改成这四字，第三格从收藏换成
 * 新增的舆情页（盯）：关注动态 / 周报 / 预警三件事都是「持续看」，凑成一格比
 * 让用户分别去三级页更顺；收藏不再是 tab，改由「我的」进入（见 pages/records）。
 * icon 与路径一一对应，顺序仍按前 2 / 后 2 分组渲染（见下方 render）。
 */
const TABS: TabItem[] = [
  { path: '/pages/index/index', label: '发现', icon: 'home' },
  { path: '/pages/ask/index', label: '提问', icon: 'chat' },
  /* 第三格：舆情聚合页（眼睛 = 盯舆情），见 pages/opinion */
  { path: '/pages/opinion/index', label: '舆情', icon: 'eye' },
  { path: '/pages/mine/index', label: '我的', icon: 'user' }
]

/**
 * **唯一**的「图标+文字 / 纯文字」切换点。
 *
 * 2026-10-13 定为 `true`：四个 tab 走**传统垂直排布** —— 图标在上、文字在下，两者不重叠；
 * 图标 48rpx、文字收小到 22rpx（原 28rpx）。
 * 选中语义按传统 tab：**选中时图标与文字一起高亮**（图标满不透明 + 文字品牌色），
 * 未选中整体弱化（图标半透明 + 文字弱灰）—— 已把上一版「选中图标反而退淡」的反转强调反转回来。
 * 详见 index.scss 的 .tabbar--icon。
 * 置为 `false` 则回到纯文字 + 下方短指示条的「tab 标签页」形态（见 index.scss
 * 的 .tabbar--text / 基础 __btn::after）。
 * 开关留在模块级、左右两槽位共用；两种形态的样式互不污染：根容器按开关挂
 * `tabbar--icon` / `tabbar--text`，各自在自己的作用域里覆盖。
 */
const TAB_SHOW_ICON = true

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
    /* 根容器按开关挂形态类：icon 态与纯文字态的样式各在自己的作用域里，互不污染 */
    <View className={`tabbar ${TAB_SHOW_ICON ? 'tabbar--icon' : 'tabbar--text'}`}>
      <View className='tabbar__inner'>
        {/* 左侧两槽位 */}
        {TABS.slice(0, 2).map((t) => (
          <View
            key={t.path}
            className={`tabbar__item ${selected === t.path ? 'tabbar__item--active' : ''}`}
            onClick={() => switchTo(t.path)}
          >
            {/* 传统垂直排布：图标在上、文字在下（见 .tabbar--icon 的 flex-direction: column）。
                图标由模块级开关 TAB_SHOW_ICON 统一控制（false 即回到纯文字 + 指示条形态）。
                整格仍可点（onClick 在外层 item 上）。 */}
            <View className='tabbar__btn'>
              {TAB_SHOW_ICON && <View className={`tabbar__icon tabbar__icon--${t.icon}`} />}
              <Text className='tabbar__label'>{t.label}</Text>
            </View>
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
            <View className='tabbar__btn'>
              {TAB_SHOW_ICON && <View className={`tabbar__icon tabbar__icon--${t.icon}`} />}
              <Text className='tabbar__label'>{t.label}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}
