import Taro from '@tarojs/taro'
import { COOLDOWN_DISABLED } from './debug'

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
  /*
   * 调试开关（见 utils/debug.ts）：关闭冷却后一律报「不在冷却期」。
   * 所有拦截点（search.ts / cache.ts / weekly.ts）都只看这个函数，故改这一处即全局放行。
   * setCooldown 照常写 storage，把开关关回去后保护立即恢复。
   */
  if (COOLDOWN_DISABLED) return 0
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

/**
 * 带作用域的冷却（P1，2026-10-11）。
 *
 * 起因是「无素材兜底」这条路径（utils/cache.ts 的 nonews 分支）：对某个人物查遍所有源、再让模型
 * 用已有知识兜一篇简介，而产物**既不入共享缓存、也不计用户次数**（两条都是对的，见那处注释）。
 * 于是同一个「查不到素材」的人物被连点几次「刷新」，就是几次全量检索 + 几次模型调用，
 * 没有任何机制挡一下。
 *
 * 为什么不能直接用全局的 'search' / 'llm'：那是**设备级**的键位 —— 为一个查不到素材的人物
 * 把整台设备封 10 分钟，代价与收益完全不成比例（用户会以为应用坏了）。
 * 故按 personKey 各算各的：只封这一个人物，其余人物照常。
 */
function scopedKey(label: CooldownLabel, scope: string): string {
  return `${STORAGE_PREFIX}${label}#${scope}`
}

/** 记一次作用域冷却（时长与全局同档，都是 COOLDOWN_MS） */
export function setScopedCooldown(label: CooldownLabel, scope: string): void {
  try {
    Taro.setStorageSync(scopedKey(label, scope), Date.now() + COOLDOWN_MS)
  } catch {
    /* 静默 */
  }
}

/**
 * 作用域冷却剩余毫秒（0 = 不在冷却期）。
 * 与 cooldownRemainingMs 共用同一个调试开关：关掉冷却时一并放行 —— 否则排查
 * 「同一个人物反复刷新」这条链路时，会被自己的保护挡住而看不到真实行为。
 */
export function scopedCooldownRemainingMs(label: CooldownLabel, scope: string): number {
  if (COOLDOWN_DISABLED) return 0
  try {
    const until = Number(Taro.getStorageSync(scopedKey(label, scope)) || 0)
    return Math.max(0, until - Date.now())
  } catch {
    return 0
  }
}
