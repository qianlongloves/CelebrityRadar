import { PropsWithChildren } from 'react'
import { useLaunch } from '@tarojs/taro'
import { ensureLogin } from './utils/auth'
import './app.scss'

/**
 * 启动即静默恢复登录态。
 *
 * 两条路径配合：
 * 1. stores/auth 命中本地缓存（正常冷启）⇒ 这里被 ensureLogin 的 userId 短路，
 *    一个请求都不发，登录态直接可用；
 * 2. 缓存缺失（首次安装、用户删过小程序）⇒ 才真正走云端「读自己的 users 行，
 *    没有则建一行」，用户无感完成注册。
 *
 * 之所以可以静默：云开发下 openid 由 wx.cloud 隐式携带，本流程不索取任何用户资料
 * （昵称/头像都是用户之后在「我的」页主动设置才上传），不存在需要当场授权的环节。
 *
 * 失败处理沿用原设计：只写 store.error，由「我的」页展示并提供重试，不阻断启动。
 */
function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    void ensureLogin()
  })

  return children
}

export default App
