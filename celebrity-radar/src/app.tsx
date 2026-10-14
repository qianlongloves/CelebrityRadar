import { PropsWithChildren, useCallback } from 'react'
import { useLaunch } from '@tarojs/taro'
import { ensureLogin } from './utils/auth'
import { hasConsented } from './utils/consent'
import { useConsent } from './stores/consent'
import PrivacyGate from './components/privacy-gate'
import ConsentGate from './components/consent-gate'
import './app.scss'

/**
 * 启动即静默恢复登录态 —— **但仅在已同意隐私政策之后**。
 *
 * 两条路径配合：
 * 1. stores/auth 命中本地缓存（正常冷启）⇒ 这里被 ensureLogin 的 userId 短路，
 *    一个请求都不发，登录态直接可用；
 * 2. 缓存缺失（首次安装、用户删过小程序）⇒ 才真正走云端「读自己的 users 行，
 *    没有则建一行」，用户无感完成注册。
 *
 * ⚠ 首次知情同意（PIPL 第 14 / 17 条）：登录会**采集 openid**，属个人信息处理，
 * 必须在用户对《隐私与免责声明》作出明确同意之后。故：
 *   · 已同意 ⇒ 照旧静默登录；
 *   · 未同意 ⇒ 不发起任何登录，先由 ConsentGate 全屏征求同意，同意后再登录。
 *
 * 同意态放在 stores/consent（而非本组件 useState）：这样「我的 → 撤回同意」撤销后
 * 本组件能订阅到变化、**即时重现网关**，不必重启小程序（见 stores/consent 的文件头）。
 */
function App({ children }: PropsWithChildren) {
  const consented = useConsent((s) => s.consented)
  const agree = useConsent((s) => s.agree)

  useLaunch(() => {
    if (hasConsented()) void ensureLogin()
  })

  /* 同意：落库（版本 + 时刻）→ 放行 → 这才发起登录 */
  const onAgree = useCallback(() => {
    agree()
    void ensureLogin()
  }, [agree])

  return (
    <PrivacyGate>
      {children}
      {consented ? null : <ConsentGate onAgree={onAgree} />}
    </PrivacyGate>
  )
}

export default App
