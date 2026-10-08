import Taro from '@tarojs/taro'
import { callCloudFunction } from './cloud'
import { diagLog } from './cloud-diagnostics'
import { MEMBER_DAILY_GENERATE_LIMIT, readMemberState } from './member'

/**
 * 会员支付（微信支付 · CloudBase 云支付）。
 *
 * 链路：本文件（拉套餐 + 下单 + 拉起收银台）→ 云函数 `payCreate`（服务端定价、写 orders、
 * 调 `cloud.cloudPay.unifiedOrder`）→ 用户支付 → 微信服务器回调云函数 `payCallback`
 * （校验金额、幂等落库、续期 `users.membership`）→ 端上轮询确认生效。
 *
 * 三条不可动摇的原则：
 *   1. **价格与时长只认服务端**：下面的价格清单由云函数 `payCreate` 用
 *      `{ action:'plans' }` 下发（见 `fetchMembershipPlans`），
 *      `FALLBACK_MEMBERSHIP_PLANS` 只是「函数未部署 / 冷启且拉取失败」时的**离线占位**，
 *      不是第二份定价。故**改价只改云函数，无需发版**；下单时客户端传什么都影响不了
 *      实际扣款与有效期（服务端按 id 查白名单，见 payCreate 的 PLAN_BY_ID）。
 *   2. **端上不写 `membership`**：该字段只能由 `payCallback` 写入（管理员身份）。
 *      端上只读，因此「支付成功」与「会员生效」是两件事，必须分开确认。
 *   3. **升级确认要有依据**：回调可能比 `requestPayment` 成功晚几秒落地，
 *      且续费场景下 `expires_at` 本来就非空 —— 所以判定标准是
 *      「`expires_at` 比支付前**更晚**」，而不是「`expires_at` 非空」。
 *
 * 权益（买了能用多少）不在本文件：见 utils/member.ts。本文件只负责「多少钱、怎么买」。
 */

/** 会员套餐（**展示口径**；权威副本在云函数 `payCreate` 的 `PLANS`） */
export interface MembershipPlan {
  id: string
  name: string
  /** 有效期天数（服务端发货据此延长 expires_at） */
  days: number
  /** 价格（分）：整数，避免浮点误差；展示与展示价文案同源于服务端 */
  priceFen: number
  /** 展示用价格文案，如 `¥9.9` */
  priceLabel: string
  /** 角标文案（如「最划算」）；空串 = 不显示 */
  badge: string
}

/**
 * 离线兜底套餐（**仅占位，不是定价源**）。
 *
 * 出现场景：`payCreate` 未部署（未开通支付）或首次冷启拉取失败。
 * ⚠ id 必须与云函数 `PLANS` 对齐，否则未部署时页面会渲染出「点了必然失败」的档位。
 */
export const FALLBACK_MEMBERSHIP_PLANS: MembershipPlan[] = [
  { id: 'monthly', name: '月度会员', days: 30, priceFen: 990, priceLabel: '¥9.9', badge: '' },
  { id: 'quarterly', name: '季度会员', days: 90, priceFen: 2500, priceLabel: '¥25', badge: '省 16%' },
  { id: 'annual', name: '年度会员', days: 365, priceFen: 6800, priceLabel: '¥68', badge: '最划算' }
]

/** 套餐清单的本机缓存（随「清空我的数据」一并清理） */
const PLAN_CACHE_KEY = 'member_plans'

/** 缓存有效期：价格极少变动，缓存一天即可免去每次进「我的」页都打一次云函数 */
const PLAN_CACHE_TTL = 24 * 3600 * 1000

/** 校验服务端下发的清单：字段缺失 / 类型不对一律视为无效（回退到旧缓存或离线兜底） */
function normalizePlans(raw: unknown): MembershipPlan[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: MembershipPlan[] = []
  for (const item of raw) {
    const p = item as Partial<MembershipPlan> | null
    if (!p || typeof p.id !== 'string' || !p.id) return null
    if (typeof p.name !== 'string' || !p.name) return null
    if (typeof p.days !== 'number' || !Number.isFinite(p.days) || p.days <= 0) return null
    if (typeof p.priceFen !== 'number' || !Number.isFinite(p.priceFen) || p.priceFen <= 0) return null
    if (typeof p.priceLabel !== 'string' || !p.priceLabel) return null
    out.push({
      id: p.id,
      name: p.name,
      days: p.days,
      priceFen: p.priceFen,
      priceLabel: p.priceLabel,
      badge: typeof p.badge === 'string' ? p.badge : ''
    })
  }
  return out
}

/** 读本机缓存的套餐；`maxAgeMs` 传值时过期即视为无缓存 */
function readPlanCache(maxAgeMs?: number): MembershipPlan[] | null {
  try {
    const cached = Taro.getStorageSync<{ at?: number; plans?: unknown } | null>(PLAN_CACHE_KEY)
    if (!cached || !Array.isArray(cached.plans)) return null
    if (maxAgeMs !== undefined && (!cached.at || Date.now() - cached.at > maxAgeMs)) return null
    return normalizePlans(cached.plans)
  } catch {
    return null
  }
}

/**
 * 拉取套餐（展示用）：24h 内直接用本机缓存，否则问云函数 `payCreate`。
 * 任一环节失败都逐级回退（新鲜缓存 → 旧缓存 → 离线兜底），**绝不因价格拉取失败挡住页面**。
 */
export async function fetchMembershipPlans(): Promise<MembershipPlan[]> {
  const fresh = readPlanCache(PLAN_CACHE_TTL)
  if (fresh) return fresh

  try {
    const res = (await callCloudFunction('payCreate', { action: 'plans' })) as
      | { ok?: boolean; plans?: unknown }
      | null
    const plans = res?.ok ? normalizePlans(res.plans) : null
    if (plans) {
      Taro.setStorageSync(PLAN_CACHE_KEY, { at: Date.now(), plans })
      return plans
    }
    diagLog('warn', 'db', '套餐下发格式异常，回退本地清单')
  } catch (err) {
    diagLog(
      'warn',
      'db',
      `套餐拉取失败，回退本地清单：${err instanceof Error ? err.message : String(err)}`
    )
  }
  return readPlanCache() ?? FALLBACK_MEMBERSHIP_PLANS
}

/**
 * 套餐副文案：折算月价（年卡 ¥5.7/月 这类锚点由价格算出，不手写，避免改价后文案对不上）
 * + 会员权益额度（取自权益层 utils/member.ts，不在这里写死数字）。
 */
export function planNote(p: MembershipPlan): string {
  return [planMonthlyLabel(p), `每日生成 ${MEMBER_DAILY_GENERATE_LIMIT} 次`]
    .filter((s): s is string => !!s)
    .join(' · ')
}

/** 折算到「月」的单价文案；月卡本身不折算（返回 null），四舍五入到角 */
function planMonthlyLabel(p: MembershipPlan): string | null {
  const months = Math.round(p.days / 30)
  if (months <= 1) return null
  const perMonthYuan = Math.round((p.priceFen / months / 100) * 10) / 10
  return `折合 ¥${perMonthYuan.toFixed(1)}/月`
}

/** 在给定清单里按 id 找套餐（仅 UI 展示用；下单不依赖它，服务端自行查白名单） */
export function findPlan(plans: MembershipPlan[], planId: string): MembershipPlan | null {
  return plans.find((p) => p.id === planId) ?? null
}

interface PayCreateResult {
  ok?: boolean
  kind?: string
  error?: string
  outTradeNo?: string
  /** wx.requestPayment 所需参数（由云支付生成并签名） */
  payment?: Record<string, unknown>
}

/** 支付结果：`paid` 与 `activated` 分开 —— 前者「已扣款」，后者「会员已落库」 */
export interface BuyResult {
  ok: boolean
  paid: boolean
  activated: boolean
  outTradeNo: string | null
  /** 用户主动取消 */
  cancelled: boolean
  error?: string
}

const CANCELLED: BuyResult = {
  ok: false,
  paid: false,
  activated: false,
  outTradeNo: null,
  cancelled: true,
  error: '已取消支付'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 读取当前 `membership.expires_at` 的时间戳（无效 / 无会员一律记 0） */
async function readMembershipExpiry(): Promise<number> {
  const t = Date.parse((await readMemberState()).expiresAt ?? '')
  return Number.isFinite(t) ? t : 0
}

/**
 * 等待回调把会员落库：轮询直到 `expires_at` **超过**支付前的值。
 * 超时不算失败 —— 回调可能延迟，此时会员仍会在稍后生效，交由调用方提示用户。
 */
async function waitMembershipActivated(before: number, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await readMembershipExpiry()) > before) return true
    if (Date.now() >= deadline) return false
    await sleep(1500)
  }
}

/**
 * 购买会员：下单 → 拉起收银台 → 确认生效。
 *
 * 只传套餐 id：价格与天数由服务端白名单决定（见文件头原则 1）。
 * 返回 `paid: true, activated: false` 是合法状态（钱已付、回调未及），
 * 调用方应提示「支付成功，会员开通中」而不是报错。
 */
export async function buyMembership(planId: string): Promise<BuyResult> {
  if (!planId) {
    return {
      ok: false,
      paid: false,
      activated: false,
      outTradeNo: null,
      cancelled: false,
      error: '未选择套餐'
    }
  }

  /* 续费场景的基线：必须在下单前取，否则会把「本来就有效」误判成「本次已生效」 */
  const before = await readMembershipExpiry()

  let res: PayCreateResult | null
  try {
    res = (await callCloudFunction('payCreate', { plan: planId })) as PayCreateResult | null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('error', 'db', `payCreate 调用失败：${msg}`)
    return {
      ok: false,
      paid: false,
      activated: false,
      outTradeNo: null,
      cancelled: false,
      error: /FunctionName|-501000|not found/i.test(msg)
        ? '支付服务未部署（云函数 payCreate），请先在云开发控制台部署'
        : `下单失败：${msg}`
    }
  }

  if (!res?.ok || !res.payment) {
    return {
      ok: false,
      paid: false,
      activated: false,
      outTradeNo: res?.outTradeNo ?? null,
      cancelled: false,
      error: res?.error ?? '下单失败（云函数未返回支付参数）'
    }
  }

  const p = res.payment
  if (!p.timeStamp || !p.nonceStr || !p.package || !p.paySign) {
    return {
      ok: false,
      paid: false,
      activated: false,
      outTradeNo: res.outTradeNo ?? null,
      cancelled: false,
      error: '云支付返回的支付参数不完整（请检查商户号与支付回调配置）'
    }
  }

  try {
    await Taro.requestPayment({
      timeStamp: String(p.timeStamp),
      nonceStr: String(p.nonceStr),
      package: String(p.package),
      signType: String(p.signType ?? 'MD5') as 'MD5' | 'HMAC-SHA256' | 'RSA',
      paySign: String(p.paySign)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    /* 取消不是错误：不记 error 级日志，也不弹报错 */
    if (/cancel/i.test(msg)) return CANCELLED
    diagLog('error', 'db', `微信支付失败：${msg}`)
    return {
      ok: false,
      paid: false,
      activated: false,
      outTradeNo: res.outTradeNo ?? null,
      cancelled: false,
      error: `支付失败：${msg}`
    }
  }

  const activated = await waitMembershipActivated(before)
  if (!activated) diagLog('warn', 'db', `支付已成功但会员未在等待窗口内生效：${res.outTradeNo ?? '未知订单'}`)

  return {
    ok: true,
    paid: true,
    activated,
    outTradeNo: res.outTradeNo ?? null,
    cancelled: false
  }
}
