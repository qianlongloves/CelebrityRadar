import Taro from '@tarojs/taro'
import { create } from 'zustand'

/**
 * 登录态本地缓存键。
 *
 * 原先 userId / 昵称 / 头像只活在内存 store 里，而 store 随小程序进程一起销毁
 * ⇒ 每次冷启（小程序被系统回收后重进、开发者工具重新编译）都退回未登录，
 * 用户必须回「我的」页再点一次登录。
 *
 * 但云开发的 openid 是本设备本微信号的恒定标识，且每次云调用都由 wx.cloud
 * 隐式携带，客户端并不需要拿它换任何会话凭证 —— 因此把身份落盘即可免登录恢复。
 * 昵称头像一并缓存，冷启首屏就不会退回首字占位/「名人观察员」。
 */
const PROFILE_KEY = 'auth:profile'

interface CachedProfile {
  userId: string
  nickname: string | null
  avatarUrl: string | null
}

/**
 * 读本地登录缓存。
 *
 * 逐字段校验而不是直接信任结构：storage 可能残留旧版本或手工改过的值，
 * 而一个类型不对的 userId 不会报错，只会让所有按 openid 过滤的查询静默返回空。
 */
function readCachedProfile(): CachedProfile | null {
  try {
    const raw = Taro.getStorageSync(PROFILE_KEY) as Partial<CachedProfile> | '' | null | undefined
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.userId !== 'string' || !raw.userId) return null
    return {
      userId: raw.userId,
      nickname: typeof raw.nickname === 'string' ? raw.nickname : null,
      avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : null
    }
  } catch {
    return null
  }
}

/** 写本地登录缓存；失败只影响下次冷启能否免登录，不阻断当前会话 */
function writeCachedProfile(p: CachedProfile): void {
  try {
    Taro.setStorageSync(PROFILE_KEY, p)
  } catch {
    /* storage 写满/被禁用属可降级情况：本次会话仍可正常使用 */
  }
}

/** 清本地登录缓存（注销账号时调用）：清掉后下次登录会重新走云端 ensure 建行 */
function clearCachedProfile(): void {
  try {
    Taro.removeStorageSync(PROFILE_KEY)
  } catch {
    /* 清不掉最多是下次冷启仍带旧身份，不影响本次流程 */
  }
}

/** 模块加载即恢复：冷启后首屏就按登录态渲染，且不产生任何网络请求 */
const cached = readCachedProfile()

interface AuthState {
  /** 登录流程已结束（无论成败）；命中本地缓存时视为已结束 */
  ready: boolean
  userId: string | null
  nickname: string | null
  avatarUrl: string | null
  error: string | null
  setLogin: (p: { userId: string; nickname?: string | null; avatarUrl?: string | null }) => void
  setError: (msg: string | null) => void
  /** 注销账号：清本地身份缓存并回到「未登录」态（云端数据已由云函数删除） */
  clearLogin: () => void
}

export const useAuth = create<AuthState>((set) => ({
  ready: cached !== null,
  userId: cached?.userId ?? null,
  nickname: cached?.nickname ?? null,
  avatarUrl: cached?.avatarUrl ?? null,
  error: null,
  setLogin: ({ userId, nickname, avatarUrl }) =>
    set((st) => {
      const next = {
        ready: true,
        error: null,
        userId,
        /* 传 null/undefined 表示「本次不改」，沿用已有值（保持原语义） */
        nickname: nickname ?? st.nickname,
        avatarUrl: avatarUrl ?? st.avatarUrl
      }
      writeCachedProfile({
        userId: next.userId,
        nickname: next.nickname,
        avatarUrl: next.avatarUrl
      })
      return next
    }),
  setError: (msg) => set({ ready: true, error: msg }),
  clearLogin: () => {
    clearCachedProfile()
    set({ ready: true, userId: null, nickname: null, avatarUrl: null, error: null })
  }
}))
