import { useRef, useState } from 'react'
import { useDidShow } from '@tarojs/taro'
import { View } from '@tarojs/components'
import HistoryView from '@/components/history-view'

/** 「浏览历史」二级页：由「我的」以 navigateTo 打开 ⇒ 导航栏自带返回箭头 */
export default function History() {
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
      <HistoryView reloadKey={reloadKey} />
    </View>
  )
}
