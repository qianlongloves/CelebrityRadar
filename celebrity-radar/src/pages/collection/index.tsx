import { useRef, useState } from 'react'
import { useDidShow } from '@tarojs/taro'
import { View } from '@tarojs/components'
import FavoritesView from '@/components/favorites-view'

/**
 * 收藏页。
 *
 * 2026-10-13 起收藏不再是 tab（第三格让给「盯」舆情页），本页保留但降为普通页：
 * 不再同步 tabBar 选中态、也不再为悬浮底栏预留底部空间（.safe-bottom 即可）；
 * 「我的」里带返回按钮的收藏入口见 pages/records。浏览历史已独立为 pages/history。
 */
export default function Collection() {
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
    <View className='glow-page safe-bottom'>
      <FavoritesView reloadKey={reloadKey} />
    </View>
  )
}
