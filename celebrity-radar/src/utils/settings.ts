import Taro from '@tarojs/taro'
import { publicConfig } from '@/config/public'

/** 本地设置（用户级，仅存本地 storage，§3.5/§3.8） */

const KEY_BOCHA = 'settings:bocha_api_key'
/** 旧搜索源（Tavily）残留键：只用于清理，不再读写 */
const KEY_TAVILY_LEGACY = 'settings:tavily_api_key'
const KEY_LLM = 'settings:llm_api_key'

export function getBochaKey(): string | null {
  const v = Taro.getStorageSync(KEY_BOCHA)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function setBochaKey(key: string | null): void {
  if (key && key.trim()) Taro.setStorageSync(KEY_BOCHA, key.trim())
  else Taro.removeStorageSync(KEY_BOCHA)
}

/** 清空搜索源密钥（含旧 Tavily 残留），「清空我的数据」时调用 */
export function clearSearchKey(): void {
  Taro.removeStorageSync(KEY_BOCHA)
  Taro.removeStorageSync(KEY_TAVILY_LEGACY)
}

/**
 * LLM 密钥：只从本地 storage 读。
 * 迁移到 CloudBase 后平台不再托管 LLM，密钥归属从"平台"变成"用户/开发者"，
 * 因此复用与搜索源（博查）相同的本地设置机制。
 * 末尾的 publicConfig 回落仅作应急阀门——该字段恒为空，
 * 禁止回填真实 key（public.ts 会进包，等同于公开）。
 */
export function getLlmKey(): string | null {
  const v = Taro.getStorageSync(KEY_LLM)
  if (typeof v === 'string' && v.trim()) return v.trim()
  const fallback = publicConfig.llm.apiKey.trim()
  return fallback || null
}

export function setLlmKey(key: string | null): void {
  if (key && key.trim()) Taro.setStorageSync(KEY_LLM, key.trim())
  else Taro.removeStorageSync(KEY_LLM)
}
