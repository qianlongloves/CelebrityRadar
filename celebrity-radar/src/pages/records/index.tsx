import { useRef, useState } from 'react'
import { useDidShow } from '@tarojs/taro'
import { View } from '@tarojs/components'
import FavoritesView from '@/components/favorites-view'

/**
 * 「我的收藏」二级页：由「我的」以 navigateTo 打开 ⇒ 导航栏自带返回箭头。
 *
 * 浏览历史已拆到 pages/history —— 两个列表此前共用一个页面、靠 ?tab= 参数决定，
 * 页内还有一层 Tab 与一层类型筛选，三层叠在一起。现在一个页面只讲一件事。
 */
export default function Records() {
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
    <View className='glow-page'>
      <FavoritesView reloadKey={reloadKey} />
    </View>
  )
}
