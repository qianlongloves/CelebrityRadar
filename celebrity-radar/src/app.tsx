import { PropsWithChildren } from 'react'
import { useLaunch } from '@tarojs/taro'
import 'taro-ui/dist/style/index.scss'
import './app.scss'

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 阶段 2：云 SDK 初始化（utils/cloud.ts）
  })
  // children 即当前要显示的页面
  return children
}

export default App
