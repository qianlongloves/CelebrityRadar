import { PropsWithChildren, useCallback, useEffect } from 'react'
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
 * 同意态放在 stores/consent（而非本组件 useState）：这样「我的 → 系统设置 → 撤回同意」撤销后
 * 本组件能订阅到变化、**即时重现网关**，不必重启小程序（见 stores/consent 的文件头）。
 */
function App({ children }: PropsWithChildren) {
  const consented = useConsent((s) => s.consented)
  const agree = useConsent((s) => s.agree)
  const syncConsent = useConsent((s) => s.sync)

  /*
   * 启动后按本机记录校准一次内存态（只跑一次）。
   *
   * store 的初值在**模块加载时**求值，早于页面挂载与存储就绪；那一次读空就会把
   * 「已同意」钉死成 false，此后内存态与本机记录永久背离 —— 表现为用户明明在用，
   * 点「撤回同意」却只得到「当前未同意」（见 stores/consent 的 sync 注释）。
   * 这里补一次校准，让内存态以本机记录为准。放在 useEffect 而不是 useLaunch：
   * 不需要等小程序生命周期，页面渲染时即可纠正。
   */
  useEffect(() => {
    syncConsent()
  }, [syncConsent])

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
