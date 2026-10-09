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
  /** 云端复核后判定本次免计费（会员「补齐」共享缓存），见 cloudfunctions/quotaGuard */
  waived?: boolean
  /** P2-30：该类的服务端上限与本次是否放行（目前只有 `refresh` 返回） */
  limit?: number
  allowed?: boolean
  error?: string
}

/** 云端自增的结果：新计数 + 本次是否被免计费（+ refresh 类的服务端判定） */
export interface QuotaIncrResult {
  count: number
  waived: boolean
  /** 旧版云函数不返回，保持 undefined ⇒ 端上按同源常量兜底 */
  allowed?: boolean
  limit?: number
}

/**
 * 「会员补齐」申请的随行参数（P1，2026-10-09）。
 *
 * 语义：会员要生成的那一份，缓存里现有的还不含会员段落，那他这次刷新是替**全站**
 * 把这行缓存升级，故申请免计费。端上这个标记只是「申请」——真伪由云函数复核
 * （会员是否真的生效 + 目标那一行是否真的缺会员段），复核不过就按普通生成计数。
 */
export interface QuotaWaiveOptions {
  waiveIf: 'member_upgrade'
  /** 目标人物（personKey）：云函数据此读 report_cache 复核 */
  target: string
}

/** 函数未部署时 wx 会抛错（含 FunctionName / -501000）——属预期过渡态，不打扰用户 */
function isNotDeployed(msg: string): boolean {
  return /not found|FunctionName|-501000/i.test(msg)
}

/**
 * 原子自增一次配额，返回自增后的**当日计数**（含云端是否判定免计费）；
 * 云函数不可用时返回 null，由调用方回退端上读-改-写。
 */
export async function incrQuotaViaCloud(
  kind: QuotaKind,
  opts?: QuotaWaiveOptions
): Promise<QuotaIncrResult | null> {
  try {
    const res = (await callCloudFunction('quotaGuard', {
      kind,
      action: 'consume',
      /* 只在传了才带上：老版本云函数不认这个参数，多传反而干扰日志 */
      ...(opts ? { waiveIf: opts.waiveIf, target: opts.target } : {})
    })) as QuotaGuardResult | null

    if (res && res.ok && typeof res.count === 'number') {
      return {
        count: res.count,
        waived: res.waived === true,
        /* P2-30：refresh 类带上服务端权威判定（`limit` / `allowed`）。
           以前端上拿回计数自己比一遍，同一份规则两个副本 ⇒ 端上那份可被改包改掉。
           旧版云函数不返回这两个字段，此时保持 undefined，由端上按同源常量兜底。 */
        allowed: typeof res.allowed === 'boolean' ? res.allowed : undefined,
        limit: typeof res.limit === 'number' ? res.limit : undefined
      }
    }

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
