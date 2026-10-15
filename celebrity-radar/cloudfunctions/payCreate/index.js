/**
 * payCreate —— 会员下单：服务端定价 → 建订单 → 调云支付统一下单。
 *
 * 为什么定价必须在服务端：小程序包可解包，客户端传来的任何价格 / 时长都不可信。
 * 下面的 `PLANS` 是**唯一价格源**：端上不再硬编码价格，而是用
 * `{ action: 'plans' }` 把这份清单拉回去渲染（本地只留一份离线兜底清单，
 * 仅用于「函数未部署 / 首次冷启无缓存」时占位）。因此**改价只改本文件**，无需发版。
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
const { PLANS } = require('./benefits.config')

/** id → 套餐（下单按 id 查白名单，未知 id 一律拒绝） */
const PLAN_BY_ID = PLANS.reduce((acc, p) => {
  acc[p.id] = p
  return acc
}, {})

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
    return {
      ok: true,
      plans: PLANS.map((p) => ({
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
  const plan = PLAN_BY_ID[planId]
  if (!plan) {
    return {
      ok: false,
      kind: 'badrequest',
      error: `未知套餐：${planId}（支持 ${PLANS.map((p) => p.id).join(' / ')}）`
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
