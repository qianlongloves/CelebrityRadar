import { PropsWithChildren } from 'react'
import { useLaunch } from '@tarojs/taro'
import { ensureLogin } from './utils/auth'
import './app.scss'

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 微信登录 + users 初始化（失败不阻断启动，错误态由「我的」页展示）
    void ensureLogin()
  })
  // children 即当前要显示的页面
  return children
}

export default App
