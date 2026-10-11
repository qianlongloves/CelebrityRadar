import Taro from '@tarojs/taro'
import { DEFAULT_USER_SETTINGS, SETTINGS_KEYS } from '@/config/user-defaults'
import { callCloudFunction } from './cloud'
import { diagLog } from './cloud-diagnostics'

/**
 * 用户个性化配置：**云端 `users.settings` 是真源，本机 storage 只是它的缓存**（§3.5/§3.8）。
 *
 * 为什么留一层缓存：读口是**同步**的（`utils/llm.ts` 发请求前要立刻知道「哪家、哪一档」，
 * 页面渲染也一样），异步读云端会让每次请求多一次等待、离线时还会回落到默认
 * （用户明明选过，看起来像没保存）。所以登录成功后把云端值**灌进**本地缓存
 * （`hydrateUserSettings`），之后读走本地、写同时更新两边。
 *
 * 写口三条纪律：
 *  ① **端上不直写 `users.settings`**，一律调云函数 `userInit` 的 `set`（它是这一列的唯一写者）。
 *     端上直写会与云端的读-改-写打架，而且 users 是「仅创建者可读写」，改包就能改自己那一行 ——
 *     写入路径收敛到云端后，将来要加校验（比如只认清单内的供应商 id）只有一处要改。
 *  ② **先本地、后云端**：本地立即可见，云端 best-effort；推失败的键留在**待同步队列**，
 *     下次登录或下次改配置时重放 —— 离线改的偏好不会丢，只是晚一点到云端。
 *  ③ **云端比本地新**：登录时 `hydrateUserSettings` 用云端值覆盖本地缓存，
 *     唯一例外是队列里还没推上去的键（它比云端那份新），那几个键保持本地值。
 *
 * 历史背景：本项目曾支持 BYOK（用户填自己的 Key，存本机、绕过云函数直连上游），
 * 该模式已整体移除，全项目走云函数代理（见 utils/llm.ts / utils/search.ts），
 * 用户零配置、密钥只活在云函数环境变量里。本文件于是只剩两件事：清历史遗留密钥
 * （LEGACY_KEYS），以及管「供应商 + 档位」两个偏好。
 *
 * 促销条关闭记忆（`member:promo_dismissed`）**不在**这里上云：它是本机的展示策略记忆
 * （见 utils/member.ts），不是用户对自己的配置；搬上云会让本文件与 member.ts 互相依赖，
 * 换来的只是省用户一次点击。
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
 * 历史键位：模型供应商偏好（2026-10-08）。2026-10-11 起大模型统一走微信云开发 AI、
 * 供应商维度整体移除，端上**已不再读它**（utils/llm.ts 只读档位）—— 键位与读写函数保留，
 * 只为不动存量用户的配置结构（云端 SETTINGS_KEYS 也照旧含它，免去一次迁移）。
 */
const PROVIDER_KEY = 'settings:llm_provider'

/**
 * 档位偏好键位（2026-10-08）。存的是**档位标识**（fast / standard / reason），不是模型名 ——
 * 这是刻意的：具体模型名只有云端知道（llm.config.js 的 TIERS），端上既不持有也不上报它，
 * 所以「换任何部署配置都不必让用户重选档位」。合法性只在使用点裁决一次（utils/llm.ts）。
 */
const TIER_KEY = 'settings:llm_tier'

/** 待同步队列的键位：本地已改、云端还没收下的偏好（见 pushUserSetting） */
const PENDING_KEY = 'settings:pending'

/**
 * 云端 settings 键 → 本机缓存键。
 *
 * 两套键名（云端下划线、本地 `settings:` 前缀）都是既成事实：改任一侧都会让已发布的
 * 客户端读不到用户的老选择，故只在这里映射一次。完备性由
 * test/cases/18-user-config.js 钉住（每个 SETTINGS_KEYS 都必须有映射）。
 */
const LOCAL_KEY_BY_SETTING: Record<string, string> = {
  llm_provider: PROVIDER_KEY,
  llm_tier: TIER_KEY
}

/** 待同步队列：云端 settings 键 → 还没推上去的值 */
type PendingQueue = Record<string, string | null>

/** 写本地缓存：空串 / 非字符串一律视为「清除该偏好」（回落默认） */
function applyLocal(storageKey: string, value: unknown): void {
  if (typeof value === 'string' && value) {
    Taro.setStorageSync(storageKey, value)
    return
  }
  Taro.removeStorageSync(storageKey)
}

/** 云端键 → 本地缓存键（缺映射时抛错：宁可红，也不要静默把偏好丢在一边） */
function localKeyOf(key: string): string {
  const local = LOCAL_KEY_BY_SETTING[key]
  if (!local) throw new Error(`配置项 ${key} 缺少本地键映射：请同步更新 LOCAL_KEY_BY_SETTING`)
  return local
}

/** 读取历史「模型供应商」偏好（2026-10-11 起端上不再据此裁决档位，仅为保留键位与联调） */
export function getPreferredProvider(): string | null {
  const v = Taro.getStorageSync<string>(PROVIDER_KEY)
  return typeof v === 'string' && v ? v : null
}

/** 写历史「模型供应商」偏好；传 null / 空串表示清除（同上：保留键位，端上不再读） */
export function setPreferredProvider(provider: string | null): void {
  applyLocal(PROVIDER_KEY, provider)
  pushUserSetting('llm_provider', provider || null)
}

/** 读取用户选择的档位标识（fast / standard / reason）；未选过返回 null */
export function getPreferredTier(): string | null {
  const v = Taro.getStorageSync<string>(TIER_KEY)
  return typeof v === 'string' && v ? v : null
}

/** 记住用户选择的档位标识；传 null / 空串表示清除该偏好（回落该家的极速版） */
export function setPreferredTier(tier: string | null): void {
  applyLocal(TIER_KEY, tier)
  pushUserSetting('llm_tier', tier || null)
}

/* -------------------------- 云端同步（以下为内部实现） -------------------------- */

function readPending(): PendingQueue {
  const v = Taro.getStorageSync<PendingQueue>(PENDING_KEY)
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

function writePending(q: PendingQueue): void {
  if (Object.keys(q).length === 0) Taro.removeStorageSync(PENDING_KEY)
  else Taro.setStorageSync(PENDING_KEY, q)
}

/** 正在重放的队列（串行化：两处同时改配置不该发两轮请求） */
let flushing: Promise<void> | null = null

/**
 * 改一项偏好：先记进待同步队列（本地 storage），再尝试推送。
 *
 * 「先记队列、后推送」而不是「推送成功才记账」：推送是异步的，这中间若进程被杀，
 * 用户的改动就没了；先落队列则最坏也只是重放一次（云端 set 是幂等的赋值）。
 */
export function pushUserSetting(key: string, value: string | null): void {
  const q = readPending()
  q[key] = value
  writePending(q)
  void flushPending()
}

/**
 * 重放待同步队列。
 *
 * 逐键串行；**云端明确拒绝**（容器可用但返回 ok:false，如键不在白名单、类型不对）
 * 时丢弃该键 —— 留着只会永远卡住队列后面所有人；**调用失败**（云函数未部署、
 * 未登录、网络）时保留队列并停下，等下次登录或下次改配置再试。
 */
function flushPending(): Promise<void> {
  if (flushing) return flushing
  flushing = runFlush().finally(() => {
    flushing = null
  })
  return flushing
}

/** 云函数 set 的返回形状（宽松断言：只关心 ok / error 两个字段） */
type SetResult = { ok?: boolean; error?: string }

/**
 * 重放的轮数上限：每轮都会删掉已推成功的键，正常两三轮就空了。
 * 设上限只为防「用户一边疯狂改、一边重放」时在这里空转。
 */
const FLUSH_ROUND_MAX = 10

async function runFlush(): Promise<void> {
  for (let round = 0; round < FLUSH_ROUND_MAX; round++) {
    const q = readPending()
    const keys = Object.keys(q)
    if (keys.length === 0) return

    for (const key of keys) {
      const value = q[key]
      let res: SetResult | null = null
      try {
        res = (await callCloudFunction('userInit', { action: 'set', key, value })) as SetResult | null
      } catch (err) {
        /* 云函数未部署 / 未登录 / 网络：保留队列并停下，等下次登录或下次改配置再试 */
        diagLog(
          'warn',
          'storage',
          `配置项 ${key} 暂未同步到云端：${err instanceof Error ? err.message : String(err)}`
        )
        return
      }
      if (!res?.ok) {
        /* 云端明确拒绝（键不在白名单 / 类型不对）：下面照常删键丢弃 —— 留着会永远卡住队列 */
        diagLog('warn', 'storage', `云端拒绝配置项 ${key}（已丢弃）：${res?.error ?? '未知原因'}`)
      }
      /* 基于**当前**队列删键，而不是本轮快照：期间用户又改了同一个键则保留，下一轮推新值 */
      const cur = readPending()
      if (cur[key] === value) {
        delete cur[key]
        writePending(cur)
      }
    }
  }
}

/**
 * 用云端 settings 覆盖本地缓存（登录成功后调用，见 utils/auth.ts#doLogin）。
 *
 * 队列里还没推上去的键**不覆盖** —— 本地那份更新；其余键以云端为准，
 * 这样「换台手机登录后偏好跟着回来」。顺带重放一次队列。
 */
export function hydrateUserSettings(settings: unknown): void {
  const src =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {}
  const pending = readPending()
  for (const key of SETTINGS_KEYS) {
    if (key in pending) continue
    applyLocal(localKeyOf(key), src[key])
  }
  void flushPending()
}

/** 供用例检查映射完备性：当前的「云端键 → 本地缓存键」映射（只读副本） */
export function settingLocalKeyMap(): Record<string, string> {
  return { ...LOCAL_KEY_BY_SETTING }
}

/**
 * 清除全部本机设置（历史遗留密钥 + 供应商（历史键位）/ 生成档位偏好 + 促销条关闭记忆），
 * 「清空我的数据」时调用。
 *
 * 云端那份也一并复位成默认值：只清本机的话，下次登录 hydrate 会把旧偏好拉回来 ——
 * 用户点了「清空我的数据」，看到的却是设置原样还在。
 */
export function clearLocalSettings(): void {
  for (const key of [...LEGACY_KEYS, PROVIDER_KEY, TIER_KEY]) Taro.removeStorageSync(key)
  /*
   * ⚠ 促销条的关闭记忆（member:promo_dismissed）**不在这里清**：它归 utils/member.ts 管
   * （promo 的文案与展示概率同属一套策略），由「清空我的数据」的调用点依次清。
   * 本文件若反过来 import member.ts，就会与 member.ts → auth.ts → 本文件 的依赖链成环。
   */
  writePending({})
  for (const key of SETTINGS_KEYS) pushUserSetting(key, DEFAULT_USER_SETTINGS[key])
}
