import Taro from '@tarojs/taro'

/** 本地设置（用户级，仅存本地 storage，§3.5/§3.8） */

const KEY_TAVILY = 'settings:tavily_api_key'
const KEY_KNOWLEDGE = 'settings:knowledge_mode'

export function getTavilyKey(): string | null {
  const v = Taro.getStorageSync(KEY_TAVILY)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function setTavilyKey(key: string | null): void {
  if (key && key.trim()) Taro.setStorageSync(KEY_TAVILY, key.trim())
  else Taro.removeStorageSync(KEY_TAVILY)
}

/** 知识模式：默认关闭（§2.4），显式开启 */
export function isKnowledgeModeEnabled(): boolean {
  return Taro.getStorageSync(KEY_KNOWLEDGE) === true
}

export function setKnowledgeMode(enabled: boolean): void {
  Taro.setStorageSync(KEY_KNOWLEDGE, enabled)
}
