/*
 * payCreate —— 会员下单（定价在服务端）。
 *
 * 本文件集中在 P2-27：连点 / 端上重试不许造出第二张未付单。
 * 以前每次点击都无条件 `add` 一张 `pending` 单，两张单各拿到一份支付参数 ⇒ 用户可能被扣两次，
 * 两次回调都发货 ⇒ 天数翻倍。微信侧一个 outTradeNo 只能下一次单，所以要防的是「别造第二张单」。
 */
const path = require('path')
const env = require('../harness/env')
const { describe, it, eq, ok, notOk, deepEq } = require('../harness/t')

const FN = path.resolve(__dirname, '..', '..', 'cloudfunctions', 'payCreate', 'index.js')

const CLOUD_CONFIG = { SUB_MCH_ID: 'sub-mch-test', ENV_ID: 'env-test' }

/**
 * 加载 payCreate：注入假 wx-server-sdk（含可编程的 cloudPay.unifiedOrder）与调用者 openid。
 * 返回 `{ fn, unified }`（unified.calls 记录统一下单次数，便于断言「只下了一次单」）。
 */
function loadFn(opts = {}) {
  env.resetAll()
  delete process.env.WX_PAY_SUB_MCH_ID
  delete process.env.PAY_CALLBACK_ENV_ID
  if (opts.configured !== false) {
    process.env.WX_PAY_SUB_MCH_ID = CLOUD_CONFIG.SUB_MCH_ID
    process.env.PAY_CALLBACK_ENV_ID = CLOUD_CONFIG.ENV_ID
  }

  const unified = { calls: [] }
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => env.db.database(),
    getWXContext: () => ({ OPENID: opts.openid === undefined ? 'u1' : opts.openid, ENV: 'env-test' }),
    cloudPay: {
      unifiedOrder: (args) => {
        unified.calls.push(args)
        if (opts.unified) return opts.unified(args)
        return Promise.resolve({
          returnCode: 'SUCCESS',
          payment: { prepay_id: `prepay-${unified.calls.length}`, timeStamp: '1', nonceStr: 'n', package: 'p', signType: 'MD5', paySign: 's' }
        })
      }
    }
  }

  const Module = require('module')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(FN)]
    return { fn: require(FN), unified }
  } finally {
    Module.prototype.require = orig
  }
}

const orders = () => env.db.__dump('orders')
const minutesAgoIso = (m) => new Date(Date.now() - m * 60 * 1000).toISOString()

describe('payCreate 下发套餐清单', () => {
  it('未配商户号也能下发价格（价格是展示信息，改价不该等发版）', async () => {
    const { fn } = loadFn({ configured: false })

    const res = await fn.main({ action: 'plans' })

    eq(res.ok, true)
    eq(res.plans.length, 3, '唯一价格源在服务端，端上只渲染')
    ok(res.plans.every((p) => typeof p.priceFen === 'number' && p.priceLabel))
  })

  it('取不到 openid 直接拒（不能给一个落不了库的订单）', async () => {
    const { fn } = loadFn({ openid: '' })

    const res = await fn.main({ plan: 'monthly' })

    eq(res.ok, false)
    eq(res.kind, 'auth')
    eq(orders().length, 0)
  })

  it('未知套餐 / 未配商户号：明确失败，不建单', async () => {
    const bad = loadFn()
    const r1 = await bad.fn.main({ plan: 'lifetime' })
    eq(r1.kind, 'badrequest')

    const unconf = loadFn({ configured: false })
    const r2 = await unconf.fn.main({ plan: 'monthly' })
    eq(r2.kind, 'unconfigured')
    eq(orders().length, 0)
  })
})

describe('P2-27 未付单复用（连点不造第二张单）', () => {
  it('窗口内再次下单：原样下发同一张单的支付参数，且只统一下单一次', async () => {
    const { fn, unified } = loadFn()

    const first = await fn.main({ plan: 'monthly' })
    eq(first.ok, true)
    eq(first.reused, undefined)
    eq(orders().length, 1)
    ok(orders()[0].payment, '支付参数要落回订单行，供下一次复用')

    const second = await fn.main({ plan: 'monthly' })

    eq(second.ok, true)
    eq(second.reused, true, '第二次必须复用，而不是建第二张单')
    eq(second.outTradeNo, first.outTradeNo, '同一张单')
    deepEq(second.payment, first.payment, '同一份支付参数（同一个收银台）')
    eq(unified.calls.length, 1, '微信侧只该下一次单 —— 两张单两份参数就是两次扣款机会')
    eq(orders().length, 1, '库里只该有一张 pending 单')
  })

  it('窗口外（超过 10 分钟）：不复用，另开一张新单', async () => {
    const { fn, unified } = loadFn()
    env.db.__seed('orders', [
      {
        _id: 'MR-OLD',
        _openid: 'u1',
        plan: 'monthly',
        status: 'pending',
        created_at: minutesAgoIso(20),
        payment: { prepay_id: 'old' }
      }
    ])

    const res = await fn.main({ plan: 'monthly' })

    eq(res.ok, true)
    notOk(res.reused, 'prepay 会过期，窗口外必须新开单')
    notOk(res.outTradeNo === 'MR-OLD')
    eq(unified.calls.length, 1)
    eq(orders().length, 2)
  })

  it('不同档位不复用（月卡的单不能顶掉年卡的下单）', async () => {
    const { fn, unified } = loadFn()
    env.db.__seed('orders', [
      {
        _id: 'MR-M',
        _openid: 'u1',
        plan: 'monthly',
        status: 'pending',
        created_at: new Date().toISOString(),
        payment: { prepay_id: 'm' }
      }
    ])

    const res = await fn.main({ plan: 'annual' })

    eq(res.ok, true)
    notOk(res.reused)
    eq(res.days, 365)
    eq(unified.calls.length, 1)
    eq(orders().length, 2)
  })

  it('别人的未付单不会被复用（必须同 openid）', async () => {
    const { fn } = loadFn()
    env.db.__seed('orders', [
      {
        _id: 'MR-OTHER',
        _openid: 'someone-else',
        plan: 'monthly',
        status: 'pending',
        created_at: new Date().toISOString(),
        payment: { prepay_id: 'x' }
      }
    ])

    const res = await fn.main({ plan: 'monthly' })

    eq(res.ok, true)
    notOk(res.reused)
    notOk(res.outTradeNo === 'MR-OTHER')
  })

  it('复用查询读失败时照常新建（复用只是省一张单，绝不能因此下不了单）', async () => {
    const { fn, unified } = loadFn()
    env.db.__seed('orders', [
      {
        _id: 'MR-P',
        _openid: 'u1',
        plan: 'monthly',
        status: 'pending',
        created_at: new Date().toISOString(),
        payment: { prepay_id: 'p' }
      }
    ])
    env.db.__setReadFailing('orders', true)

    const res = await fn.main({ plan: 'monthly' })

    eq(res.ok, true)
    eq(unified.calls.length, 1, '下单本身不能被一次读失败挡住')
  })
})

describe('payCreate 下单失败路径', () => {
  it('统一支付不返回支付参数：订单标记 failed 并如实报错', async () => {
    const { fn } = loadFn({ unified: () => Promise.resolve({ returnCode: 'FAIL', returnMsg: '签名错误' }) })

    const res = await fn.main({ plan: 'monthly' })

    eq(res.ok, false)
    eq(res.kind, 'upstream')
    ok(String(res.error).includes('签名错误'), `实际：${res.error}`)
    eq(orders()[0].status, 'failed', '失败的单不能留在 pending 里被复用')
  })
})
