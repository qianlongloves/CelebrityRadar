import { callCloudFunction } from './cloud'
import { diagLog } from './cloud-diagnostics'

/**
 * 配额计数的服务端通道（云函数 `quotaGuard`）。
 *
 * 为什么需要它：端上读-改-写既会并发超发，也能被改包 / 改设备时间绕过
 * （计数行与日期都由客户端提供）。服务端化后计数不可伪造，日期以服务端为准。
 * 背景见 `cloudfunctions/quotaGuard/index.js` 顶部注释与《开发计划.md》§七 待办 6。
 *
 * 策略是**云端优先、静默回退**：
 *   - 云端成功 → 返回新计数，调用方不再写本地行；
 *   - 函数未部署 / 云端报错 → 返回 null，调用方走原有读-改-写。
 * 这样「函数还没部署」只退回旧行为，而不会让配额闸门整个失效。
 * 回退期间可超发、可被改时间绕过 —— 属已知过渡态，部署函数后即消除。
 *
 * ⚠ 与权限收紧的先后顺序不可颠倒：**先（重新）部署 quotaGuard，再把三张配额表收紧为
 *   `{ "read": "doc._openid == auth.openid", "write": false }`**。
 *   先收紧权限，端上回退写入会被拒绝 ⇒ 计数恒为 0 ⇒ 额度形同虚设。
 *   注意控制台上那份旧版本不认提问用的 `ask` 类（`ask_quota` 表），其权限须在重新部署后再收紧。
 */

/**
 * 三类配额共用一条通道：
 *   `generate` 报告生成（端上只在成功落库后 consume）
 *   `refresh`  关注流刷新（端上「自增并据此判定」，属另一样式，见 utils/cache.ts）
 *   `ask`      AI 提问（端上先读表判额度、成功后才 consume，口径 = 成功才计数）
 * 三者都是「云端优先、静默回退本机」，各自一张表（generate_quota / refresh_quota / ask_quota）。
 */
export type QuotaKind = 'generate' | 'refresh' | 'ask'

interface QuotaGuardResult {
  ok?: boolean
  kind?: string
  date?: string
  count?: number
  created?: boolean
  error?: string
}

/** 函数未部署时 wx 会抛错（含 FunctionName / -501000）——属预期过渡态，不打扰用户 */
function isNotDeployed(msg: string): boolean {
  return /not found|FunctionName|-501000/i.test(msg)
}

/**
 * 原子自增一次配额，返回自增后的**当日计数**；
 * 云函数不可用时返回 null，由调用方回退端上读-改-写。
 */
export async function incrQuotaViaCloud(kind: QuotaKind): Promise<number | null> {
  try {
    const res = (await callCloudFunction('quotaGuard', {
      kind,
      action: 'consume'
    })) as QuotaGuardResult | null

    if (res && res.ok && typeof res.count === 'number') return res.count

    diagLog('warn', 'db', `quotaGuard(${kind}) 未生效：${res?.error ?? '无返回值'}，回退端上计数`)
    return null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog(
      'warn',
      'db',
      isNotDeployed(msg)
        ? `quotaGuard 未部署，${kind} 配额暂用端上计数（可超发；部署并收紧权限后消除）`
        : `quotaGuard(${kind}) 调用失败，回退端上计数：${msg}`
    )
    return null
  }
}
