import Taro from '@tarojs/taro'
import { clearPromoDismiss } from './member'

/**
 * 本机设置（用户级，仅存本地 storage，§3.5/§3.8）。
 *
 * 历史背景：本项目曾支持「用户填自己的 Key」的 BYOK 模式 —— 博查搜索 key 与大模型 key
 * 都存在本机 storage，配了就绕过云函数直连上游。该模式已整体移除，全项目改走云函数代理
 * （见 utils/llm.ts 与 utils/search.ts），用户零配置，密钥只活在云函数环境变量里。
 *
 * 现在本文件承担三件事：
 *   ① 历史遗留密钥的清理：老版本存下的 key 不会再被任何代码读取，但也不该永远躺在用户设备上，
 *      故保留清除入口，挂在「清空我的数据」上（LEGACY_KEYS）。
 *   ② 模型选择（M7-4 / 2026-10-08）：存「用哪家供应商」+「用哪一档」两个偏好，
 *      均不涉及任何密钥 —— key 在云函数环境变量里，用户切供应商只是换一次请求参数。
 *   ③ 本机偏好的「清空」出口：促销条关闭记忆（O-26）的读写写在 utils/member.ts
 *      （它与文案、展示概率同属一套策略），这里只管在清数据时把它一起复位。
 */

/** 历史的 BYOK 密钥键位：均已废弃，只用于清理 */
const LEGACY_KEYS = [
  'settings:bocha_api_key',
  'settings:llm_api_key',
  /** 更早的搜索源残留（Tavily） */
  'settings:tavily_api_key',
  /**
   * 更早的模型偏好（只存一个模型名，没有供应商维度）。已由「供应商 + 档位」两个键取代：
   * 留着会被下面的读取函数忽略，但它是一条**用户的旧选择**，不清掉就永远躺在设备上。
   */
  'settings:llm_model'
]

/**
 * 供应商偏好键位（2026-10-08）。存的是 config/public.ts 里 llm.providers 的某个 id；
 * 未选择时（或选中的供应商已从清单里移除）由 utils/llm.ts 回落到 providers[0]，
 * 因此这里允许存任意字符串，不需要在写入时校验 —— 合法性只在使用点裁决一次。
 */
const PROVIDER_KEY = 'settings:llm_provider'

/**
 * 档位偏好键位（2026-10-08）。存的是**档位标识**（fast / standard / reason），不是模型名 ——
 * 这一点是刻意的：换供应商时模型名整组都要换（deepseek-v4 ↔ qwen-plus），
 * 若存模型名，用户切一家就得重新选一次档位，还会让「上次选的那档」在另一家失效。
 * 存档位标识则「切到哪家都还是我选的那一档」，正是产品的承诺（见「我的」页文案）。
 * 合法性与上面同理，只在使用点裁决。
 */
const TIER_KEY = 'settings:llm_tier'

/** 读取用户选择的供应商 id；未选过返回 null */
export function getPreferredProvider(): string | null {
  const v = Taro.getStorageSync<string>(PROVIDER_KEY)
  return typeof v === 'string' && v ? v : null
}

/** 记住用户选择的供应商 id；传 null / 空串表示清除该偏好（回落默认供应商） */
export function setPreferredProvider(provider: string | null): void {
  if (!provider) {
    Taro.removeStorageSync(PROVIDER_KEY)
    return
  }
  Taro.setStorageSync(PROVIDER_KEY, provider)
}

/** 读取用户选择的档位标识（fast / standard / reason）；未选过返回 null */
export function getPreferredTier(): string | null {
  const v = Taro.getStorageSync<string>(TIER_KEY)
  return typeof v === 'string' && v ? v : null
}

/** 记住用户选择的档位标识；传 null / 空串表示清除该偏好（回落该家的极速版） */
export function setPreferredTier(tier: string | null): void {
  if (!tier) {
    Taro.removeStorageSync(TIER_KEY)
    return
  }
  Taro.setStorageSync(TIER_KEY, tier)
}

/** 清除全部本机设置（历史遗留密钥 + 供应商 / 档位偏好 + 促销条关闭记忆），「清空我的数据」时调用 */
export function clearLocalSettings(): void {
  for (const key of [...LEGACY_KEYS, PROVIDER_KEY, TIER_KEY]) Taro.removeStorageSync(key)
  /*
   * 促销条的关闭记忆（O-26）也属于「本机设置」，清空数据时一并复位 ——
   * 用户清数据是想要一个干净的开始，此时还留着一个「别看广告」的记忆，
   * 既不在他的预期里，也没有任何东西能让他想起来去关。
   */
  clearPromoDismiss()
}
