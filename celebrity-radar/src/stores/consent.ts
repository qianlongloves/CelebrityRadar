import { create } from 'zustand'
import { hasConsented, recordConsent, clearConsent } from '@/utils/consent'

/**
 * 首次知情同意的**内存态**（PIPL 第 14 / 15 条）。
 *
 * ── 为什么要有这个 store，而不在 app.tsx 里 useState ─────────────────
 * 「撤回同意」由「我的 → 系统设置」触发，但闸门（ConsentGate）挂在 app.tsx —— 两者不在同一个
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
  /**
   * 按本机记录重新同步一次内存态。
   *
   * 为什么需要：初值 `consented: hasConsented()` 是**模块加载那一刻**求值的，
   * 而模块加载早于页面挂载。那个时点存储可能还没就绪 / 记录还没写进去，
   * 于是一次读空就把「已同意」永久钉成 false —— 内存态与本机记录从此背离。
   * 症状是用户明明在用、却点「撤回同意」只得到一句「当前未同意」（2026-10-17 实测）。
   * 由 app.tsx 在启动后调一次，把内存态拉回本机记录的真相。
   */
  sync: () => void
  /** 同意：落库（版本 + 时刻）并置为已同意 */
  agree: () => void
  /** 撤回同意：清本机记录并置为未同意（网关于是重现） */
  withdraw: () => void
}

export const useConsent = create<ConsentState>((set) => ({
  consented: hasConsented(),
  sync: () => set({ consented: hasConsented() }),
  agree: () => {
    recordConsent()
    set({ consented: true })
  },
  withdraw: () => {
    clearConsent()
    set({ consented: false })
  }
}))
