import Taro from '@tarojs/taro'

/**
 * 超配额冷却（§5.4 用例 9）：外部服务 429 / 连续失败后冷却 10 分钟，
 * 期间不再发起请求，UI 提示「稍后再试」。持久到本地 storage（防重启绕过）。
 */

export type CooldownLabel = 'search' | 'llm'

const COOLDOWN_MS = 10 * 60 * 1000
const STORAGE_PREFIX = 'cooldown:'

export function setCooldown(label: CooldownLabel): void {
  try {
    Taro.setStorageSync(`${STORAGE_PREFIX}${label}`, Date.now() + COOLDOWN_MS)
  } catch {
    /* 静默 */
  }
}

/** 冷却中返回剩余毫秒；不在冷却期返回 0 */
export function cooldownRemainingMs(label: CooldownLabel): number {
  try {
    const until = Number(Taro.getStorageSync(`${STORAGE_PREFIX}${label}`) || 0)
    return Math.max(0, until - Date.now())
  } catch {
    return 0
  }
}

/** 人类可读的剩余时间（分钟） */
export function cooldownMinutesLeft(label: CooldownLabel): number {
  return Math.ceil(cooldownRemainingMs(label) / 60000)
}
