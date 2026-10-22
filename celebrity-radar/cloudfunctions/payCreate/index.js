/**
 * payCreate —— 会员下单：服务端定价 → 建订单 → 调云支付统一下单。
 *
 * 为什么定价必须在服务端：小程序包可解包，客户端传来的任何价格 / 时长都不可信。
 * 价格分两层：
 *   · **构建期默认值**来自 `benefits.config.js`（真源 src/config/benefits.ts 的 PLANS，
 *     `npm run config:sync` 生成）；
 *   · **运行期覆盖**来自云端 `sys_config/membership_plans`，由运维中心（adminConsole）
 *     写入，改价在手机上点几下即可，不必改代码、不必重新部署、不必发版。
 * 端上通过 `{ action: 'plans' }` 把**生效后**的清单拉回去渲染（本地只留一份离线兜底，
 * 仅用于「函数未部署 / 首次冷启无缓存」时占位）。
 *
 * 本函数只做「下单」，不做「发货」：支付结果由微信服务器回调 `payCallback` 处理，
 * 因此用户付款后会员不会立即生效（端上轮询确认，见 pay.ts）。
 *
 * 需要的环境变量（缺任一则返回 kind:'unconfigured'，不抛错）：
 *   WX_PAY_SUB_MCH_ID     微信支付商户号（云支付服务商模式下的 sub_mch_id）
 *   PAY_CALLBACK_ENV_ID   回调云函数所在环境 ID；不填则取调用上下文 ENV
 *
 * 两种调用：
 *   { action: 'plans' }        只读下发套餐清单（**不需要**商户号，端上渲染价格用）
 *   { plan: '<id>' }           下单：{ ok:true, outTradeNo, amountFen, days, payment }
 *                              payment 直接透传给 `wx.requestPayment`
 *                              窗口内重复点击会**复用同一张未付单**（返回 `reused:true`，
 *                              payment 与上次同一份），见 PENDING_REUSE_MS 的说明。
 * 失败统一返回 { ok:false, kind?, error }。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function readEnv(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * 套餐白名单（**唯一价格源**）—— 数值不在本文件：取自 benefits.config.js
 * （自动生成，真源 src/config/benefits.ts 的 PLANS）。改价 = 改真源 + `npm run config:sync`
 * + 重新部署本函数，**端上无需发版**（它通过 `{ action:'plans' }` 把这份清单拉回去渲染，
 * 见 main）。
 *
 * 字段口径（与 `src/utils/pay.ts` 的 `MembershipPlan` 一一对应）：
 *   priceFen  实付金额（分）—— 下单时即 `totalFee`，端上展示价也用它（整数，无浮点误差）
 *   priceLabel 展示价文案；badge 角标（运营文案，空串 = 不显示）
 *   body      微信支付订单标题（仅本函数使用，不下发）
 */
const { PLANS, PLAN_LIMITS } = require('./benefits.config')

/* ═══════════════════════════════════════════════════════════════════════════
 * 价格覆盖：云端 `sys_config/membership_plans`（2026-10-22）
 *
 * 为什么价格要上云：以前改价 = 改 benefits.ts + `npm run config:sync` + 重新部署云函数，
 * 一次调价要动代码、走一次发布。现在运维中心点几下就生效，端上不用发版。
 *
 * ⚠ 三条约束（改这段前先读）：
 *   1. **只覆盖金额与角标**：days / name / body 仍取构建期常量 —— 改天数会动发货口径、
 *      改名字会让历史订单的套餐名漂移，两者都不该在手机上随手改。
 *   2. **校验不过就整份丢弃**（回到构建期价格），不做「部分采纳」：一份半对的价格表
 *      比旧价更危险，而半对的表现是「有的档位改了、有的没改」，排查起来毫无线索。
 *   3. **读库失败不阻断下单**：宁可卖旧价，也不能因为一张配置表读不到就全站买不了。
 *
 * 缓存 60 秒（与 aiProxy 的厂商开关同节奏）：改价最迟一分钟内全网生效。下单与展示都走
 * `effectivePlans()` —— 若展示读云端、下单读常量，就会出现「看到 ¥12 扣了 ¥9.9」。
 * ═══════════════════════════════════════════════════════════════════════════ */
const PLAN_DOC_COLL = 'sys_config'
const PLAN_DOC_ID = 'membership_plans'
const PLAN_CACHE_MS = 60 * 1000

/** 金额（分）→ 展示文案：990 → `¥9.9`、6800 → `¥68`、1999 → `¥19.99` */
function priceLabelOf(fen) {
  const yuan = Math.round(fen) / 100
  if (Number.isInteger(yuan)) return `¥${yuan}`
  return `¥${String(yuan.toFixed(2)).replace(/0+$/, '').replace(/\.$/, '')}`
}

/**
 * 校验云端覆盖值。返回 `{ ok, reason, prices, badges, updated_at, updated_by, note }`；
 * `ok=false` 表示文档存在但不可用 —— 调用方整份回退构建期价格。
 *
 * 漏配某档不算错（该档用默认值）：加档位时旧文档天然只有两个 id，不该因此整份失效。
 */
function sanitizePlanOverride(doc) {
  const empty = { prices: {}, badges: {}, updated_at: null, updated_by: null, note: null }
  const fail = (reason) => Object.assign({ ok: false, reason }, empty)
  if (!doc) return Object.assign({ ok: true, reason: 'unset' }, empty)

  const prices = doc.prices
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return fail('prices 不是对象')

  const outPrices = {}
  for (const p of PLANS) {
    const raw = prices[p.id]
    if (raw === undefined) continue
    const fen = Number(raw)
    if (!Number.isFinite(fen) || Math.round(fen) !== fen) return fail(`${p.id} 的价格不是整数分`)
    if (fen < PLAN_LIMITS.priceFenMin || fen > PLAN_LIMITS.priceFenMax) {
      return fail(`${p.id} 的价格 ${fen} 分超出 ${PLAN_LIMITS.priceFenMin}~${PLAN_LIMITS.priceFenMax}`)
    }
    outPrices[p.id] = fen
  }

  const outBadges = {}
  const badges = doc.badges
  if (badges && typeof badges === 'object' && !Array.isArray(badges)) {
    for (const p of PLANS) {
      const raw = badges[p.id]
      if (typeof raw !== 'string') continue
      const text = raw.trim()
      if (text.length > PLAN_LIMITS.badgeMax) return fail(`${p.id} 的角标超过 ${PLAN_LIMITS.badgeMax} 字`)
      outBadges[p.id] = text
    }
  }

  return {
    ok: true,
    reason: 'cloud',
    prices: outPrices,
    badges: outBadges,
    updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : null,
    updated_by: typeof doc.updated_by === 'string' ? doc.updated_by : null,
    note: typeof doc.note === 'string' ? doc.note : null
  }
}

let planOverrideCache = null

async function readPlanOverride() {
  const now = Date.now()
  if (planOverrideCache && now - planOverrideCache.at < PLAN_CACHE_MS) return planOverrideCache.value

  let doc = null
  try {
    const res = await db.collection(PLAN_DOC_COLL).doc(PLAN_DOC_ID).get()
    doc = (res && res.data) || null
  } catch (err) {
    /* 文档不存在 = 还没配过价；读库整体失败也走这里 —— 都按「没配」处理 */
    doc = null
  }
  const value = sanitizePlanOverride(doc)
  if (!value.ok) console.warn(`[payCreate] 云端价格配置不可用，回退构建期价格：${value.reason}`)
  planOverrideCache = { at: now, value }
  return value
}

/** 本次生效的套餐清单：构建期常量 + 云端覆盖（金额、角标） */
async function effectivePlans() {
  const ov = await readPlanOverride()
  return PLANS.map((p) => {
    const fen = ov.prices[p.id] === undefined ? p.priceFen : ov.prices[p.id]
    return {
      id: p.id,
      name: p.name,
      days: p.days,
      priceFen: fen,
      priceLabel: priceLabelOf(fen),
      badge: ov.badges[p.id] === undefined ? p.badge : ov.badges[p.id],
      body: p.body
    }
  })
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 订单号：MR + 北京时间 yyyyMMddHHmmss + 6 位随机（共 22 位，微信要求 6~32 位） */
function buildTradeNo() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  const stamp =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  const rand = String(Math.floor(Math.random() * 1000000)).padStart(6, '0')
  return `MR${stamp}${rand}`
}

function nonceStr() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 下单失败时把订单标记为 failed（best-effort，失败不影响错误返回） */
async function markFailed(outTradeNo) {
  try {
    await db.collection('orders').doc(outTradeNo).update({ data: { status: 'failed' } })
  } catch (err) {
    /* 订单行可能尚未建立，忽略 */
  }
}

/**
 * 未付订单的复用窗口（P2-27）。
 *
 * 以前每次点击都无条件建一张新单：「我的」页连点两下、或端上失败重试，就会造出两张
 * `pending` 单，两张都能各拿到一份支付参数 ⇒ 用户可能被扣两次（两次都发货 ⇒ 天数翻倍）。
 * 微信侧一个 `outTradeNo` 只能下一次单，所以要防的不是「同一张单重复回调」（那条由
 * `last_order_id` 去重兜着），而是**别造出第二张单**。
 *
 * 做法：把 unifiedOrder 拿到的 `payment` 参数落回订单行，窗口内再次下单时**原样再下发一次**
 * 同一份参数（JSAPI 的 prepay_id 有效 2 小时，可以重复展示收银台），于是连点只会看到同一个
 * 收银台。取 10 分钟：够覆盖「连点 + 手滑返回再点」，又远短于 prepay 有效期。
 */
const PENDING_REUSE_MS = 10 * 60 * 1000

/** 近期未付单：同人同档、已拿到支付参数、且还在复用窗口内；无匹配返回 null */
async function findReusablePending(openid, planId) {
  try {
    const res = await db
      .collection('orders')
      .where({ _openid: openid, plan: planId, status: 'pending' })
      .orderBy('created_at', 'desc')
      .limit(5)
      .get()
    const now = Date.now()
    for (const o of res.data || []) {
      if (!o || !o.payment) continue
      const t = Date.parse(o.created_at || '')
      if (Number.isFinite(t) && now - t < PENDING_REUSE_MS) return o
    }
  } catch (err) {
    /* 复用只是「省一张单」：读不到就照常新建，绝不能因此下不了单 */
  }
  return null
}

/** 把支付参数落回订单行（best-effort）：让下一次点击能复用同一张单 */
async function savePaymentParams(outTradeNo, payment) {
  try {
    await db.collection('orders').doc(outTradeNo).update({ data: { payment } })
  } catch (err) {
    /* 少了一次复用机会而已，不阻断下单 */
  }
}

exports.main = async (event) => {
  const ctx = cloud.getWXContext() || {}
  const openid = ctx.OPENID
  if (!openid) return { ok: false, kind: 'auth', error: '取不到调用者 openid（请从小程序端调用）' }

  /*
   * 只读下发套餐：端上「我的」页据此渲染档位与价格。
   * 放在商户号校验**之前** —— 价格是展示信息，未开通支付时也要能正确显示，
   * 否则「我的」页只能退化成端上那份兜底清单，改价就得等发版。
   */
  if (event && event.action === 'plans') {
    const plans = await effectivePlans()
    return {
      ok: true,
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        days: p.days,
        priceFen: p.priceFen,
        priceLabel: p.priceLabel,
        badge: p.badge
      }))
    }
  }

  const planId = event && event.plan
  /* 下单与展示同源：价格可能已被运维中心改过，不能再用构建期常量查表 */
  const plans = await effectivePlans()
  const plan = plans.find((p) => p.id === planId)
  if (!plan) {
    return {
      ok: false,
      kind: 'badrequest',
      error: `未知套餐：${planId}（支持 ${plans.map((p) => p.id).join(' / ')}）`
    }
  }

  const subMchId = readEnv('WX_PAY_SUB_MCH_ID')
  if (!subMchId) {
    return {
      ok: false,
      kind: 'unconfigured',
      error: '微信支付未配置：请在云函数 payCreate 的环境变量中设置 WX_PAY_SUB_MCH_ID（商户号）'
    }
  }

  /* 回调云函数所在环境：显式配置优先，回退调用上下文 ENV */
  const envId = readEnv('PAY_CALLBACK_ENV_ID') || ctx.ENV
  if (!envId) {
    return {
      ok: false,
      kind: 'unconfigured',
      error: '微信支付未配置：无法确定回调所在环境，请设置环境变量 PAY_CALLBACK_ENV_ID'
    }
  }

  /* P2-27：连点/重试先看有没有可复用的未付单 —— 有就原样再下发一次，不建第二张单 */
  const reusable = await findReusablePending(openid, planId)
  if (reusable) {
    return {
      ok: true,
      outTradeNo: reusable._id,
      plan: planId,
      amountFen: plan.priceFen,
      days: plan.days,
      payment: reusable.payment,
      reused: true
    }
  }

  const outTradeNo = buildTradeNo()
  try {
    await db.collection('orders').add({
      data: {
        _id: outTradeNo,
        /* 云函数是管理员身份，_openid 必须显式写，端上才读得到自己的订单 */
        _openid: openid,
        plan: planId,
        amount_fen: plan.priceFen,
        /* 天数随订单落库：回调侧据此发货，无需再查套餐表 */
        days: plan.days,
        status: 'pending',
        created_at: new Date().toISOString(),
        paid_at: null,
        transaction_id: null
      }
    })
  } catch (err) {
    return {
      ok: false,
      error: `订单创建失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  try {
    const res = await cloud.cloudPay.unifiedOrder({
      body: plan.body,
      outTradeNo,
      spbillCreateIp: '127.0.0.1',
      subMchId,
      totalFee: plan.priceFen,
      envId,
      functionName: 'payCallback',
      nonceStr: nonceStr(),
      tradeType: 'JSAPI',
      openid
    })

    if (!res || res.returnCode !== 'SUCCESS' || !res.payment) {
      await markFailed(outTradeNo)
      const detail = (res && (res.returnMsg || res.errCodeDes || res.resultCode)) || '云支付未返回支付参数'
      /* 上游原文同时留一份到云函数日志（端上还会经 utils/error.ts 转成用户文案，见下） */
      console.error('payCreate 微信支付下单失败：', detail)
      return { ok: false, kind: 'upstream', error: `微信支付下单失败：${detail}` }
    }

    /* 落回支付参数，供下次点击复用（P2-27） */
    await savePaymentParams(outTradeNo, res.payment)

    return {
      ok: true,
      outTradeNo,
      plan: planId,
      amountFen: plan.priceFen,
      days: plan.days,
      payment: res.payment
    }
  } catch (err) {
    await markFailed(outTradeNo)
    /* 原始异常同时留一份到云函数日志（端上还会经 utils/error.ts 转成用户文案，见下） */
    console.error('payCreate 下单异常：', err)
    return {
      ok: false,
      kind: 'upstream',
      error: `微信支付下单失败：${err instanceof Error ? err.message : String(err)}`
    }
  }
}
