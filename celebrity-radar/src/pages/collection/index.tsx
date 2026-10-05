import { useRef, useState } from 'react'
import { useDidShow } from '@tarojs/taro'
import { View } from '@tarojs/components'
import FavoritesView from '@/components/favorites-view'
import { useTabBarSync } from '@/utils/tabbar'

/** 收藏（tabBar 页面，switchTab 进入故无返回箭头）
 *  浏览历史已独立为 pages/history；「我的」里带返回按钮的收藏入口见 pages/records */
export default function Collection() {
  useTabBarSync()
  const [reloadKey, setReloadKey] = useState(0)
  const firstShow = useRef(true)

  useDidShow(() => {
    /* 首次显示由组件挂载时的 useEffect 取数，此处跳过避免重复请求；
       之后每次回到本页（如从报告页返回）重新拉取，保证列表最新 */
    if (firstShow.current) {
      firstShow.current = false
      return
    }
    setReloadKey((n) => n + 1)
  })

  return (
    <View className='glow-page safe-tab'>
      <FavoritesView reloadKey={reloadKey} />
    </View>
  )
}
