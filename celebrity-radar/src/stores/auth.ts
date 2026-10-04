import { create } from 'zustand'

export interface UserSettings {
  /** 知识模式（默认关闭，§2.4） */
  knowledgeMode: boolean
}

interface AuthState {
  /** 登录流程已结束（无论成败） */
  ready: boolean
  userId: string | null
  nickname: string | null
  avatarUrl: string | null
  settings: UserSettings
  error: string | null
  setLogin: (p: { userId: string; nickname?: string | null; avatarUrl?: string | null }) => void
  setSettings: (s: Partial<UserSettings>) => void
  setError: (msg: string | null) => void
}

export const useAuth = create<AuthState>((set) => ({
  ready: false,
  userId: null,
  nickname: null,
  avatarUrl: null,
  settings: { knowledgeMode: false },
  error: null,
  setLogin: ({ userId, nickname, avatarUrl }) =>
    set((st) => ({
      ready: true,
      error: null,
      userId,
      nickname: nickname ?? st.nickname,
      avatarUrl: avatarUrl ?? st.avatarUrl
    })),
  setSettings: (s) => set((st) => ({ settings: { ...st.settings, ...s } })),
  setError: (msg) => set({ ready: true, error: msg })
}))
