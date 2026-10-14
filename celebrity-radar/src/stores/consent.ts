import { create } from 'zustand'
import { hasConsented, recordConsent, clearConsent } from '@/utils/consent'

/**
 * 首次知情同意的**内存态**（PIPL 第 14 / 15 条）。
 *
 * ── 为什么要有这个 store，而不在 app.tsx 里 useState ─────────────────
 * 「撤回同意」由「我的」页触发，但闸门（ConsentGate）挂在 app.tsx —— 两者不在同一个
 * 组件里。用 useEffect/useState 的话，撤回后 app.tsx 无从得知，网关不会**即时**重现，
 * 用户便能在「已撤回同意」的状态下继续使用、甚至重新点登录绕过闸门。
 * 收口到一个 store：撤回 → `consented` 变 false → app.tsx 订阅到 → 网关立刻重现，
 * 无需重启小程序（也绕开「App 是否按页各挂一份」的不确定性）。
 *
 * 初始值取自本机记录（utils/consent 的版本化校验）；`agree / withdraw` 既落库也改内存态。
 * 版本号不一致（政策更新）在 `hasConsented` 里已按「未同意」处理。
 */
interface ConsentState {
  /** 是否已同意**当前版本**政策 */
  consented: boolean
  /** 同意：落库（版本 + 时刻）并置为已同意 */
  agree: () => void
  /** 撤回同意：清本机记录并置为未同意（网关于是重现） */
  withdraw: () => void
}

export const useConsent = create<ConsentState>((set) => ({
  consented: hasConsented(),
  agree: () => {
    recordConsent()
    set({ consented: true })
  },
  withdraw: () => {
    clearConsent()
    set({ consented: false })
  }
}))
