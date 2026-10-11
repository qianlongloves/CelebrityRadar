'use strict'

/**
 * 支付售后：调用方闸门 + 退款撤销 + 定时对账（cloudfunctions/payCallback）
 *
 * 钉住三件旧版里根本不存在的事：
 *  1. **谁在调它**：云函数部署了就能被端上 `wx.cloud.callFunction` 调到，而 payCallback 的事件
 *     内容是「我收到了支付成功通知」—— 以前这是约定不是事实，于是任何人都能用开发者工具
 *     给自己发货（金额天然对得上，单是自己下的）。闸门按 `getWXContext().OPENID` 判，
 *     灰度开关 `PAY_CALLBACK_GUARD` 的**默认值**（log，只记日志）也在这里钉住：默认值不该被谁顺手改。
 *  2. **退款要能撤销会员**：`refunded` 以前全仓只被读、没有写入方，也没有任何代码在退款后收回权益。
 *     现在由运营写口置状态、由 settleRefund 扣天数 —— 扣的**只有这一单买的天数**。
 *  3. **对账**：微信重试耗尽后 `granting` 会永久停在半路；双写「权威 memberships + 镜像
 *     users.membership」也不是原子的，而镜像那份端上能改。对账每小时补发货、覆盖镜像、
 *     处理待撤销的退款单。三条都必须**幂等**：重复跑不多扣一天、不少发一天。
 *
 * 加载方式与 06 一致：把 `wx-server-sdk` 换成 harness 的内存 DB，断真行为而不是源码字面量。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, eq, deepEq, ok, notOk } = require('../harness/t')

const FN = path.resolve(__dirname, '..', '..', 'cloudfunctions', 'payCallback', 'index.js')

const DAY_MS = 86400000
const iso = (ms) => new Date(ms).toISOString()
const ago = (ms) => iso(Date.now() - ms)
const ahead = (ms) => iso(Date.now() + ms)

/** 本趟调用的调用方身份：'' = 非端上（微信回调 / 定时器 / 控制台「云端测试」） */
let callerOpenid = ''

/** 加载 payCallback，并把它的 `wx-server-sdk` 指向 harness 的内存 DB */
function loadFn(envVars) {
  env.resetAll()
  delete process.env.PAY_CALLBACK_GUARD
  delete process.env.PAY_ADMIN_TOKEN
  Object.assign(process.env, envVars || {})

  const db = env.db.database()
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => (callerOpenid ? { OPENID: callerOpenid } : {})
  }
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(FN)]
    return require(FN)
  } finally {
    Module.prototype.require = orig
  }
}

const order = (id) => env.db.__dump('orders').find((o) => o._id === (id || 'T1')) || {}
const authority = (openid) => env.db.__dump('memberships').find((m) => m._id === (openid || 'u1')) || null
const membership = (openid) =>
  (env.db.__dump('users').find((u) => u._openid === (openid || 'u1')) || {}).membership || null

const makeOrder = (over) =>
  Object.assign(
    {
      _id: 'T1',
      _openid: 'u1',
      plan: 'month',
      amount_fen: 1900,
      days: 31,
      status: 'pending',
      created_at: '2026-10-01T00:00:00.000Z',
      paid_at: null,
      granted_at: null,
      transaction_id: null,
      callback_fee: null
    },
    over
  )

const makeUser = (over) =>
  Object.assign({ _id: 'row-u1', _openid: 'u1', nickname: null, membership: null }, over)

const notify = (over) =>
  Object.assign(
    { returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: 'T1', totalFee: 1900, transactionId: 'wx-tx-1' },
    over
  )

const timerEvent = () => ({ Type: 'Timer', TriggerName: 'payReconcile', Time: '2026-10-09T01:15:00.000Z' })

/** 已发货的一单：订单 + 权威行，两处有效期相同 —— 退款 / 对账用例的公共起点 */
function seedShipped(expiresAt, over) {
  env.db.__seed('orders', [
    makeOrder(
      Object.assign(
        {
          status: 'paid',
          paid_at: '2026-10-01T00:00:01.000Z',
          granted_at: '2026-10-01T00:00:02.000Z'
        },
        over || {}
      )
    )
  ])
  env.db.__seed('memberships', [
    { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: expiresAt, last_order_id: 'T1' }
  ])
  env.db.__seed('users', [
    makeUser({ membership: { plan: 'month', expires_at: expiresAt, last_order_id: 'T1' } })
  ])
  return expiresAt
}

describe('payCallback 调用方闸门', () => {
  it('默认 log 只记录不拦截：端上伪造的支付通知仍会走完（灰度是刻意的）', async () => {
    const fn = loadFn() /* 不设 PAY_CALLBACK_GUARD ⇒ 默认 log */
    env.db.__seed('orders', [makeOrder()])
    env.db.__seed('users', [makeUser()])
    callerOpenid = 'attacker-openid'

    const res = await fn.main(notify())

    /* 这条是在钉**灰度默认值**，不是在认可这个行为：先观察真机回调的上下文形态，
       确认「微信回调不带 openid」后再切 strict（切完这条用例要一起改）。 */
    eq(res.errcode, 0, '默认 log 不拦截（还没确认真机回调的上下文形态）')
    eq(order().status, 'paid', 'log 模式下照常发货 —— 这就是灰度期剩下的风险窗口')
  })

  it('strict：端上伪造的支付通知被拒，订单与会员都不动', async () => {
    const fn = loadFn({ PAY_CALLBACK_GUARD: 'strict' })
    env.db.__seed('orders', [makeOrder()])
    env.db.__seed('users', [makeUser()])
    callerOpenid = 'attacker-openid'

    const res = await fn.main(notify())

    notOk(res.errcode === 0, '必须返回非 0：万一判据错了，非 0 还能靠微信重试与对账补救')
    eq(order().status, 'pending', '被拒的调用不得动订单')
    eq(membership(), null, '绝不能给自己发货 —— 这就是这条闸门存在的全部理由')
    eq(authority(), null)
  })

  it('strict：非端上调用照常放行（微信回调 / 定时器 / 控制台都没有 openid）', async () => {
    const fn = loadFn({ PAY_CALLBACK_GUARD: 'strict' })
    env.db.__seed('orders', [makeOrder()])
    env.db.__seed('users', [makeUser()])
    callerOpenid = ''

    const res = await fn.main(notify())

    eq(res.errcode, 0, '真实回调必须放行，否则闸门就从防线变成故障')
    eq(order().status, 'paid')
    eq(membership().last_order_id, 'T1')
  })

  it('strict：端上借定时事件的形状也进不来', async () => {
    const fn = loadFn({ PAY_CALLBACK_GUARD: 'strict' })
    env.db.__seed('orders', [makeOrder({ status: 'granting', paid_at: ago(3600 * 1000) })])
    env.db.__seed('users', [makeUser()])
    callerOpenid = 'attacker-openid'

    const res = await fn.main(timerEvent())

    notOk(res.errcode === 0, '闸门在分派之前，换事件形状绕不过去')
    eq(order().status, 'granting', '对账没跑，订单原样不动')
  })

  it('off：一键回滚，连端上调用都不判', async () => {
    const fn = loadFn({ PAY_CALLBACK_GUARD: 'off' })
    env.db.__seed('orders', [makeOrder()])
    env.db.__seed('users', [makeUser()])
    callerOpenid = 'attacker-openid'

    const res = await fn.main(notify())

    eq(res.errcode, 0)
    eq(order().status, 'paid', 'off 的含义就是回到改造前的行为')
  })
})

describe('退款运营写口（adminOp）', () => {
  const refund = (over) =>
    Object.assign({ adminOp: 'refund', token: 'secret', outTradeNo: 'T1', reason: '用户申请退款' }, over)

  it('未配置 PAY_ADMIN_TOKEN 时一律拒绝（fail closed）', async () => {
    const fn = loadFn() /* 不设 PAY_ADMIN_TOKEN */
    seedShipped(ahead(100 * DAY_MS))

    const res = await fn.main(refund())

    eq(res.ok, false, '没配口令就不能写 ——「忘了配」是最常见的那种自我安慰')
    ok(/未配置/.test(res.error), `错误信息要说清原因，实际 ${res.error}`)
    eq(order().status, 'paid', '订单不得被动')
  })

  it('口令不符时拒绝（端上即便能调到这个分支也猜不出口令）', async () => {
    const fn = loadFn({ PAY_ADMIN_TOKEN: 'secret' })
    seedShipped(ahead(100 * DAY_MS))
    callerOpenid = 'attacker-openid'

    const res = await fn.main(refund({ token: 'guess' }))

    eq(res.ok, false)
    eq(order().status, 'paid', '口令不对，一个字都不许改')
  })

  it('已发货订单：置 refunded 并按这一单的 days 扣减，两处同步', async () => {
    const fn = loadFn({ PAY_ADMIN_TOKEN: 'secret' })
    const future = seedShipped(ahead(100 * DAY_MS))

    const res = await fn.main(refund())

    eq(res.ok, true)
    eq(res.revoked, true, '写口自己就该把会员收回去，不留「运营以为退干净了」的窗口')
    eq(order().status, 'refunded')
    ok(order().refunded_at, '留下退款时刻')
    eq(order().refund_reason, '用户申请退款')
    ok(order().refund_revoked_at, '对账的幂等标记')

    /* 扣的只有这一单买的天数：100 天 - 31 天 = 69 天 */
    const expected = iso(Date.parse(future) - 31 * DAY_MS)
    eq(authority().expires_at, expected, `只该扣掉这一单的 31 天，实际 ${authority().expires_at}`)
    eq(membership().expires_at, expected, '镜像必须跟着退，否则端上还显示会员')
    eq(authority().last_order_id, 'T1', 'last_order_id 记的是「最后一次发货」，撤销不改它')
  })

  it('未发过货的订单：只改状态，绝不碰会员', async () => {
    const fn = loadFn({ PAY_ADMIN_TOKEN: 'secret' })
    const future = ahead(50 * DAY_MS)
    /* T2 从没发过货；会员是另一单（OLD）买来的 */
    env.db.__seed('orders', [makeOrder({ _id: 'T2', status: 'pending' })])
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: future, last_order_id: 'OLD' }
    ])
    env.db.__seed('users', [
      makeUser({ membership: { plan: 'month', expires_at: future, last_order_id: 'OLD' } })
    ])

    const res = await fn.main(refund({ outTradeNo: 'T2' }))

    eq(res.ok, true)
    eq(res.revoked, false)
    eq(order('T2').status, 'refunded')
    ok(order('T2').refunded_at, '状态迁移本身要留下')
    eq(authority().expires_at, future, '没发过货就没有天数可扣 —— 扣了就是把用户别处的天数吃掉')
    eq(membership().expires_at, future)
  })

  it('granting 中间态：拒绝，避免与正在进行的发货打架', async () => {
    const fn = loadFn({ PAY_ADMIN_TOKEN: 'secret' })
    env.db.__seed('orders', [makeOrder({ status: 'granting', paid_at: ago(60 * 1000) })])
    env.db.__seed('users', [makeUser()])

    const res = await fn.main(refund())

    eq(res.ok, false)
    ok(/granting/.test(res.error), `提示里要写清状态，实际 ${res.error}`)
    eq(order().status, 'granting', '发货途中不许被退款改写')
  })

  it('重复调用幂等：返回 already，天数不会扣第二次', async () => {
    const fn = loadFn({ PAY_ADMIN_TOKEN: 'secret' })
    seedShipped(ahead(100 * DAY_MS))

    await fn.main(refund())
    const after = authority().expires_at
    const again = await fn.main(refund())

    eq(again.ok, true)
    eq(again.already, true, '第二次要说明「已经退过了」，而不是再扣一次')
    eq(authority().expires_at, after, '天数只能扣一次')
  })

  it('缺 outTradeNo / 未知 adminOp：明确拒绝', async () => {
    const fn = loadFn({ PAY_ADMIN_TOKEN: 'secret' })

    const noId = await fn.main({ adminOp: 'refund', token: 'secret' })
    eq(noId.ok, false)
    ok(/outTradeNo/.test(noId.error))

    const unknown = await fn.main({ adminOp: 'grantFree', token: 'secret' })
    eq(unknown.ok, false)
    ok(/未知/.test(unknown.error), `实际 ${unknown.error}`)
  })
})

describe('payCallback 定时对账（payReconcile）', () => {
  it('granting 超时残留：补发货并推到 paid，不必等人工', async () => {
    const fn = loadFn({ PAY_CALLBACK_GUARD: 'strict' })
    env.db.__seed('orders', [makeOrder({ status: 'granting', paid_at: ago(60 * 60 * 1000) })])
    env.db.__seed('users', [makeUser()])
    callerOpenid = '' /* 定时器 */

    const res = await fn.main(timerEvent())

    eq(res.ok, true)
    eq(res.granted, 1, '付了钱没拿到会员的单必须被扫出来')
    eq(order().status, 'paid')
    ok(order().granted_at)
    eq(membership().last_order_id, 'T1', '货补上了')
    eq(authority().expires_at, membership().expires_at, '两处内容一致')
  })

  it('窗口内的 granting 交给微信重试，对账不抢先动它', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [makeOrder({ status: 'granting', paid_at: ago(60 * 1000) })])
    env.db.__seed('users', [makeUser()])

    const res = await fn.main(timerEvent())

    eq(res.granted, 0, '30 分钟内微信还会自己重试，对账插进去只是白跑一趟')
    eq(res.skipped.length, 1)
    eq(order().status, 'granting', '原样留给微信')
    eq(membership(), null)
  })

  it('镜像被端上改成假会员：以权威覆盖回去（绝不能反向信镜像）', async () => {
    const fn = loadFn()
    const truth = ahead(10 * DAY_MS)
    seedShipped(truth)
    /* 端上把自己那一行改成三千年会员：users 是「仅创建者可读写」 */
    env.db.__seed('users', [
      makeUser({ membership: { plan: 'year', expires_at: ahead(3000 * DAY_MS), last_order_id: 'FAKE' } })
    ])

    const res = await fn.main(timerEvent())

    eq(res.mirrors, 1, '不一致就得被拉齐')
    eq(membership().expires_at, truth, '镜像必须回到权威的值')
    eq(membership().plan, 'month')
    eq(membership().last_order_id, 'T1')
    eq(authority().expires_at, truth, '权威不该被镜像带着走')
  })

  it('权威在、镜像缺：补齐镜像（双写只成功了一半的那种）', async () => {
    const fn = loadFn()
    const truth = ahead(20 * DAY_MS)
    env.db.__seed('orders', [makeOrder({ status: 'paid', granted_at: '2026-10-01T00:00:02.000Z' })])
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: truth, last_order_id: 'T1' }
    ])
    env.db.__seed('users', [makeUser()]) /* 镜像为空 */

    const res = await fn.main(timerEvent())

    eq(res.mirrors, 1)
    eq(membership().expires_at, truth)
    eq(membership().last_order_id, 'T1')
  })

  it('只有镜像有会员（伪造）：不反向创建权威 —— 这是必须放着不管的那种', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [])
    env.db.__seed('users', [
      makeUser({ membership: { plan: 'year', expires_at: ahead(3000 * DAY_MS), last_order_id: 'FAKE' } })
    ])

    const res = await fn.main(timerEvent())

    eq(res.mirrors, 0, '没有权威行就没有可对的基准')
    eq(authority(), null, '端上写的镜像不能变成会员；它只影响自己界面，不影响云端判定')
  })

  it('refunded 未撤销：扣减并标记；再跑一轮不再扣（对账必须幂等）', async () => {
    const fn = loadFn()
    const future = ahead(100 * DAY_MS)
    env.db.__seed('orders', [
      makeOrder({
        status: 'refunded',
        granted_at: '2026-10-01T00:00:02.000Z',
        refunded_at: '2026-10-05T00:00:00.000Z',
        refund_revoked_at: null
      })
    ])
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: future, last_order_id: 'T1' }
    ])
    env.db.__seed('users', [
      makeUser({ membership: { plan: 'month', expires_at: future, last_order_id: 'T1' } })
    ])

    const first = await fn.main(timerEvent())
    const after = authority().expires_at

    eq(first.revoked, 1)
    eq(first.refunded, 1)
    eq(after, iso(Date.parse(future) - 31 * DAY_MS), '按这一单的 31 天扣')
    eq(membership().expires_at, after, '镜像同步')
    ok(order().refund_revoked_at, '标记已结清')
    deepEq(authority().refunded_orders, ['T1'], '扣减与幂等名单写在同一行')

    const second = await fn.main(timerEvent())

    eq(second.revoked, 0, '第二轮不该再扣一次')
    eq(authority().expires_at, after, '天数只能扣一次 —— 吃用户已付的天数是最不能接受的失败')
  })

  it('撤销中途失败（users 不可用）：不去重就再扣一遍 —— 这里钉住自愈后不再扣', async () => {
    const fn = loadFn()
    const future = ahead(100 * DAY_MS)
    env.db.__seed('orders', [
      makeOrder({ status: 'refunded', granted_at: '2026-10-01T00:00:02.000Z', refund_revoked_at: null })
    ])
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: future, last_order_id: 'T1' }
    ])
    env.db.__seed('users', [
      makeUser({ membership: { plan: 'month', expires_at: future, last_order_id: 'T1' } })
    ])
    env.db.__setFailing('users', true)

    const broken = await fn.main(timerEvent())
    const deducted = iso(Date.parse(future) - 31 * DAY_MS)

    eq(broken.ok, true, '对账不因为单条故障整体抛错')
    ok(broken.skipped.length >= 1, '失败要记下来，便于排查')
    eq(authority().expires_at, deducted, '权威已扣（先权威后镜像的顺序与发货一致）')
    notOk(order().refund_revoked_at, '标记没写成 —— 正因如此才不能靠标记去重')

    /* 故障恢复后再跑一轮 */
    env.db.__setFailing('users', false)
    const healed = await fn.main(timerEvent())

    eq(healed.revoked, 0, '已扣过就不该再扣')
    eq(authority().expires_at, deducted, `自愈后有效期不得再减，实际 ${authority().expires_at}`)
    eq(membership().expires_at, deducted, '镜像被补上')
    ok(order().refund_revoked_at, '这一轮才写标记')
  })

  it('单条故障不拖垮整轮：补发货失败也照样去处理退款单', async () => {
    const fn = loadFn()
    const future = ahead(60 * DAY_MS)
    env.db.__seed('orders', [
      makeOrder({ _id: 'G1', status: 'granting', paid_at: ago(2 * 60 * 60 * 1000), _openid: 'u-missing' }),
      makeOrder({
        _id: 'R1',
        status: 'refunded',
        granted_at: '2026-10-01T00:00:02.000Z',
        refund_revoked_at: null
      })
    ])
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: future, last_order_id: 'R1' }
    ])
    env.db.__seed('users', [
      makeUser({ membership: { plan: 'month', expires_at: future, last_order_id: 'R1' } })
    ])

    const res = await fn.main(timerEvent())

    eq(res.ok, true)
    eq(res.granting, 1, 'G1 被扫到了（但它的用户行不存在）')
    eq(res.granted, 0, '发不出去的货只能记下来，下一轮再试')
    ok(res.skipped.some((s) => s.indexOf('G1') === 0), `G1 的失败要进 skipped，实际 ${JSON.stringify(res.skipped)}`)
    eq(res.revoked, 1, '同一轮里的退款单不受影响 —— 一条坏不该拖垮整轮')
    eq(order('G1').status, 'granting', 'G1 原样留在 granting，等下一轮')
  })

  /* ───── 复审批次（P2-23 / P2-24，2026-10-09）：对账的「覆盖面」与「队列公平」 ───── */

  it('P2-23：镜像对账按「最久未校验」轮转，不会只固守前 100 行', async () => {
    const fn = loadFn()
    const truth = ahead(10 * DAY_MS)
    const N = 25 /* 故意大于内存 DB 单次 get 的 20 行上限：一轮读不全，只能靠轮转补上 */

    const members = []
    const users = []
    for (let i = 0; i < N; i++) {
      const id = `m${i}`
      members.push({ _id: id, _openid: id, plan: 'month', expires_at: truth, last_order_id: `T${i}` })
      /* 端上把自己那一行改成免费（镜像漂移）：只有被轮转到才会拉齐 */
      users.push({
        _id: `row-${id}`,
        _openid: id,
        membership: { plan: 'free', expires_at: null, last_order_id: null }
      })
    }
    env.db.__seed('memberships', members)
    env.db.__seed('users', users)

    const first = await fn.main(timerEvent())
    const second = await fn.main(timerEvent())

    eq(
      first.mirrors + second.mirrors,
      N,
      `两轮必须覆盖全部 ${N} 个会员 —— 裸 limit 时第二轮还在扫同一批，后面的人永远修不到`
    )
    const fixed = env.db.__dump('users').filter((u) => u.membership && u.membership.plan === 'month')
    eq(fixed.length, N, '被改坏的镜像全部被拉回权威值')
  })

  it('P2-24：已结清的历史退款单不再占满队列，新的退款单扫得到', async () => {
    const fn = loadFn()
    const future = ahead(100 * DAY_MS)
    const done = []
    for (let i = 0; i < 21; i++) {
      done.push(
        makeOrder({
          _id: `OLD${i}`,
          status: 'refunded',
          granted_at: '2026-09-01T00:00:02.000Z',
          refunded_at: '2026-09-02T00:00:00.000Z',
          refund_revoked_at: '2026-09-02T00:00:01.000Z' /* 早就撤完并标记过 */
        })
      )
    }
    env.db.__seed('orders', [
      ...done,
      makeOrder({
        _id: 'NEW1',
        status: 'refunded',
        granted_at: '2026-10-01T00:00:02.000Z',
        refunded_at: '2026-10-05T00:00:00.000Z',
        refund_revoked_at: null
      })
    ])
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: future, last_order_id: 'NEW1' }
    ])
    env.db.__seed('users', [
      makeUser({ membership: { plan: 'month', expires_at: future, last_order_id: 'NEW1' } })
    ])

    const res = await fn.main(timerEvent())

    eq(res.refunded, 1, '候选里必须只有「还没撤销」的那一条（21 条历史单不许把名额占满）')
    eq(res.revoked, 1, '新退款单必须被扣减 —— 原先它排在 21 条已结清单之后，永远轮不到')
    ok(order('NEW1').refund_revoked_at, '结清后打标记')
  })

  it('P2-24：自动补救达到上限的单不再重试（转人工），避免坏单堵住队列', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [
      makeOrder({
        _id: 'BAD1',
        status: 'granting',
        paid_at: ago(3 * 60 * 60 * 1000),
        reconcile_attempts: 5 /* 已到 MAX_RECONCILE_ATTEMPTS */
      })
    ])
    env.db.__seed('users', [makeUser()])

    const res = await fn.main(timerEvent())

    eq(res.granted, 0, '试满上限就不再自动重试')
    eq(res.stuck, 1, '要把它单独计数出来（skipped 里混着「窗口内」这种正常跳过）')
    ok(res.skipped.some((s) => s.indexOf('BAD1') === 0 && /人工/.test(s)))
    eq(order('BAD1').status, 'granting', '订单状态交给人工，不自动改')
  })

  it('P2-24：补发货失败会累加 reconcile_attempts（下次排到队尾去）', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [
      makeOrder({
        _id: 'G2',
        status: 'granting',
        paid_at: ago(2 * 60 * 60 * 1000),
        _openid: 'u-missing' /* users 行不存在 ⇒ 一定失败 */
      })
    ])

    await fn.main(timerEvent())

    eq(order('G2').reconcile_attempts, 1, '失败一次记一次 —— 没有这个计数，坏单会把前 20 个名额吃光')
    eq(order('G2').status, 'granting', '仍然留在 granting 等下一轮（有界重试）')
  })
})

/* ─────────────────── 定时任务的调用方闸门（P0-21 的另一半） ─────────────────── */

const timerFns = {
  notifyFollowUpdates: 'notifyFollowUpdates',
  keywordAlert: 'keywordAlert',
  riskWatch: 'riskWatch'
}

/** 加载一个定时任务云函数（fake 掉 wx-server-sdk；BOCHA_API_KEY 一律清掉以免真的去打上游） */
function loadTimerFn(name, openid) {
  env.resetAll()
  callerOpenid = openid || ''
  delete process.env.BOCHA_API_KEY
  delete process.env.ALERT_TEMPLATE_ID
  delete process.env.RISK_TEMPLATE_ID

  const db = env.db.database()
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => (callerOpenid ? { OPENID: callerOpenid } : {})
  }
  const file = path.resolve(__dirname, '..', '..', 'cloudfunctions', name, 'index.js')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(file)]
    return require(file)
  } finally {
    Module.prototype.require = orig
  }
}

/* ───────────── 批次 9（2026-10-09）：P2-28 / P2-31 / P2-32 / P2-35 ───────────── */

/** 假上游：按顺序吐出预置响应，并记下每次请求体（与 07 同形） */
function fakeHttps(responses) {
  const calls = []
  const module = {
    request(options, cb) {
      const chunks = []
      const req = {
        on() {
          return req
        },
        write(c) {
          chunks.push(c)
        },
        end() {
          const raw = chunks.join('')
          let body = raw
          try {
            body = JSON.parse(raw)
          } catch (e) {
            /* 保持原样：这里只关心业务请求体 */
          }
          calls.push({ path: options.path, body })
          const r = responses.length ? responses.shift() : { status: 200, data: {} }
          const res = {
            statusCode: r.status,
            setEncoding() {},
            on(ev, fn) {
              if (ev === 'data') fn(typeof r.data === 'string' ? r.data : JSON.stringify(r.data))
              if (ev === 'end') fn()
              return res
            }
          }
          cb(res)
        },
        destroy() {}
      }
      return req
    }
  }
  /*
   * 云开发 AI 通道（2026-10-11 起大模型不再走 https，改走 wx-server-sdk 的 cloud.ai）：
   * 与假 https **共用同一个响应队列**（顺序 = 真实调用顺序），请求体记进 calls[].body。
   * hotBoardRefresh 的定时生成用 generateText（cron 不需要 finish_reason），故只实现它。
   */
  const ai = () => ({
    createModel: () => ({
      async generateText(payload) {
        calls.push({ path: 'cloud.ai', body: payload })
        const r = responses.length ? responses.shift() : { status: 200, data: {} }
        let body = r.data
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body)
          } catch (e) {
            body = {}
          }
        }
        const status = r.status || 0
        const upstreamError = body && body.error
        if (status >= 400 || upstreamError) {
          const detail =
            (upstreamError && (upstreamError.message || upstreamError.code)) ||
            (typeof body.message === 'string' && body.message) ||
            ''
          const err = new Error(`${status || 'upstream'}${detail ? ` ${detail}` : ''}`)
          err.status = status
          err.statusCode = status
          throw err
        }
        const choice = (body.choices && body.choices[0]) || {}
        const message = choice.message || {}
        return { text: typeof message.content === 'string' ? message.content : '', usage: { total_tokens: 1 } }
      }
    })
  })
  return { module, calls, ai }
}

const searchOk = (n = 2) => ({
  status: 200,
  data: {
    code: 200,
    data: {
      webPages: {
        value: Array.from({ length: n }, (_, i) => ({
          name: `t${i}`,
          url: `https://news.example.com/${i}`,
          snippet: '正文'
        }))
      }
    }
  }
})

const chatOk = (content) => ({ status: 200, data: { choices: [{ message: { content }, finish_reason: 'stop' }] } })

/**
 * 加载一个定时任务云函数，并注入假 https 与可编程的推送结果。
 * `opts.env` 合并进 process.env；`opts.push(args)` 决定 `cloud.openapi.subscribeMessage.send` 的行为。
 * 返回 `{ fn, calls }`（calls 是上游请求记录，用来断言「打了几次上游」）。
 */
function loadTimerFnWithHttps(name, responses, opts) {
  env.resetAll()
  callerOpenid = ''
  delete process.env.BOCHA_API_KEY
  delete process.env.ALERT_TEMPLATE_ID
  delete process.env.SUBSCRIBE_TEMPLATE_ID
  delete process.env.RISK_TEMPLATE_ID
  if (opts && opts.env) Object.assign(process.env, opts.env)

  const db = env.db.database()
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    /* 云开发 AI：hotBoardRefresh 生成热榜解读走这条（http 在下方创建，闭包到调用时才求值） */
    ai: () => http.ai(),
    getWXContext: () => ({}),
    openapi: {
      subscribeMessage: {
        send: (args) => ((opts && opts.push) || (() => Promise.resolve({ errCode: 0 })))(args)
      }
    }
  }
  const http = fakeHttps(responses)
  const file = path.resolve(__dirname, '..', '..', 'cloudfunctions', name, 'index.js')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    if (id === 'https') return http.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(file)]
    return { fn: require(file), calls: http.calls }
  } finally {
    Module.prototype.require = orig
  }
}

/**
 * P2-35：加载 payCallback，但把 memberships 的**批量读**（带 orderBy 的那条，就是对账的批量快照）
 * 第一次返回「过期快照」，而按 `_id` 重读（readMembership）返回真值。
 * 复刻「批量读到逐行写之间有真实时间差」这一种情形。
 */
function loadFnWithStaleMirrorSnapshot(staleRow) {
  env.resetAll()
  let batchServed = false
  const real = env.db.database()

  const wrapQuery = (q, isBatch) =>
    new Proxy(q, {
      get(t, p) {
        if (p === 'orderBy' || p === 'limit' || p === 'skip' || p === 'where' || p === 'field') {
          return (...a) => wrapQuery(t[p](...a), p === 'orderBy' ? true : isBatch)
        }
        if (p === 'get') {
          return async (...a) => {
            if (isBatch && !batchServed) {
              batchServed = true
              return { data: [Object.assign({}, staleRow)], errMsg: 'mock: batch(stale)' }
            }
            return t.get(...a)
          }
        }
        const v = t[p]
        return typeof v === 'function' ? v.bind(t) : v
      }
    })

  const memberships = new Proxy(real.collection('memberships'), {
    get(t, p) {
      if (p === 'orderBy') return (...a) => wrapQuery(t.orderBy(...a), true)
      if (p === 'where') return (...a) => wrapQuery(t.where(...a), false)
      const v = t[p]
      return typeof v === 'function' ? v.bind(t) : v
    }
  })

  const db = new Proxy(real, {
    get(t, p) {
      if (p === 'collection') return (name) => (name === 'memberships' ? memberships : t.collection(name))
      const v = t[p]
      return typeof v === 'function' ? v.bind(t) : v
    }
  })

  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => ({})
  }
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(FN)]
    return require(FN)
  } finally {
    Module.prototype.require = orig
  }
}

describe('定时任务的调用方闸门', () => {
  for (const key of Object.keys(timerFns)) {
    const name = timerFns[key]
    it(`${name}：端上调用被拒（它只该由定时器触发）`, async () => {
      const fn = loadTimerFn(name, 'attacker-openid')

      const res = await fn.main()

      eq(res.ok, false, '端上没有任何正当理由调它')
      ok(/只由定时器触发/.test(res.skipped), `实际 ${res.skipped}`)
    })

    it(`${name}：非端上调用不被闸门拦（照常走到后面的缺配置分支）`, async () => {
      const fn = loadTimerFn(name, '')

      const res = await fn.main()

      /* 闸门只是「拒端上」，不该顺手把定时器自己也拒了：没有 API Key 时它应该走到
         自己的配置检查上，而不是返回闸门那句话 */
      notOk(/只由定时器触发/.test(res.skipped || ''), `闸门误伤了定时器调用：${res.skipped}`)
    })
  }

  it('hotBoardRefresh：端上不许 force（它必须保留端上 ensure 的补跑链路）', async () => {
    const fn = loadTimerFn('hotBoardRefresh', 'attacker-openid')

    const forced = await fn.main({ action: 'run', force: true })
    eq(forced.ok, false, 'force 跳过 20 小时幂等闸门 = 一次调用烧 6 组检索 + 一次生成，不能开放给端上')
    ok(/force/.test(forced.skipped), `实际 ${forced.skipped}`)

    const readOnly = await fn.main({ action: 'report' })
    notOk(/force/.test(String(readOnly.skipped || '')), '读榜与端上补跑（ensure）这条路必须还通')
  })
})

/* ─────────────────── 定时推送翻页取全表（P2-11，2026-10-09） ─────────────────── */

/**
 * 三个定时任务原先直接 `.limit(100).get()` 取「所有要推送的人」：第 101 个之后的订阅者
 * 从此静默收不到任何提醒（不报错、不打日志，只有用户觉得自己被忘了）。
 *
 * 修复时特意**不用「这一页不满 = 到底了」当判据** —— 一次 get 能取回多少行由平台决定
 * （小程序端 20 / 服务端默认 100），拿 PAGE_SIZE 去比，平台给不满就会提前收工，
 * 老毛病换个样子回来。故必须以**空页**收尾，用例也把这条钉住。
 */
describe('定时推送翻页取全表（P2-11）', () => {
  it('notifyFollowUpdates：订阅者超过一页也全部读到（裸 limit 只会服务前一小撮）', async () => {
    const fn = loadTimerFn('notifyFollowUpdates', '')
    process.env.BOCHA_API_KEY = 'bocha-test'
    process.env.SUBSCRIBE_TEMPLATE_ID = 'tmpl-test'
    try {
      env.db.__seed(
        'users',
        Array.from({ length: 150 }, (_, i) => ({
          _id: `u${String(i).padStart(3, '0')}`,
          _openid: `openid-${i}`,
          subscribe_ok: true
        }))
      )

      const res = await fn.main()

      eq(res.ok, true)
      eq(res.users, 150, '内存 DB 单页只给 20 行，能读到 150 才说明真的翻页了')
    } finally {
      delete process.env.SUBSCRIBE_TEMPLATE_ID
      delete process.env.BOCHA_API_KEY
    }
  })

  it('三个定时任务都以 listAll 翻页、按主键排序，且不再裸 limit 取全表', () => {
    for (const name of ['notifyFollowUpdates', 'keywordAlert', 'riskWatch']) {
      const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'cloudfunctions', name, 'index.js'), 'utf8')
      ok(/async function listAll\(/.test(src), `${name} 应内联 listAll`)
      ok(src.includes("orderBy('_id', 'asc')"), `${name} 必须按主键稳定翻页（跳过顺序不稳会漏人）`)
      ok(/if \(!batch\.length\) return out/.test(src), `${name} 必须以空页收尾，不能以「不满一页」判定到底`)
      ok(/out\.length >= MAX_ROWS/.test(src), `${name} 达到上限要告警，而不是静默截断`)
      notOk(/\.limit\(\s*\d/.test(src), `${name} 不该再有字面量的裸 limit 取全表`)
    }
  })

  it('users 集合补上 alert_ok / risk_ok 索引（没有索引的 where 会随表变大而全表扫）', () => {
    const schema = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'cloudfunctions', 'dbInit', 'schema.js'),
      'utf8'
    )
    ok(schema.includes('idx_alert_ok'), 'keywordAlert 按 alert_ok 取人')
    ok(schema.includes('idx_risk_ok'), 'riskWatch 按 risk_ok 取人')
  })
})

/*
 * P2-35：对账的批量快照过期时不得用旧值覆盖镜像（写前按 _id 重读权威）。
 * 场景：批量读到的权威还是 5 天，而真正写之前权威已被改成 10 天（有人刚补货 / 刚退款）。
 */
describe('P2-35 对账批量快照过期', () => {
  it('批量读到逐行写之间有真实时间差：以重读到的权威为准，不写快照里的旧值', async () => {
    const staleExp = ahead(5 * DAY_MS)
    const truth = ahead(10 * DAY_MS)
    const fn = loadFnWithStaleMirrorSnapshot({
      _id: 'u1',
      _openid: 'u1',
      plan: 'month',
      expires_at: staleExp,
      last_order_id: 'T1'
    })
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: truth, last_order_id: 'T1' }
    ])
    env.db.__seed('users', [makeUser({ membership: { plan: 'free', expires_at: null, last_order_id: null } })])

    const res = await fn.main(timerEvent())

    eq(res.mirrors, 1)
    eq(membership().plan, 'month')
    eq(
      membership().expires_at,
      truth,
      '必须写重读到的真值 —— 写快照里的旧值，端上就会显示一个权威已经否掉的有效期'
    )
  })
})

/*
 * P2-28：推送必须排在写回 feed_cache 之前。
 * 否则「写回成功 + 推送失败」会被记成「这批已经推过了」，那个用户**永远**收不到这条。
 */
describe('P2-28 推送先于写回 feed_cache', () => {
  it('某个用户推送瞬时失败：人物缓存本轮不写回，下一轮仍能补推（不再永久漏推）', async () => {
    const responses = [searchOk(2), searchOk(2)]
    let u2Fails = 1
    const push = (args) => {
      if (args.touser === 'openid-u2' && u2Fails > 0) {
        u2Fails--
        return Promise.reject(Object.assign(new Error('send fail'), { errMsg: 'system error' }))
      }
      return Promise.resolve({ errCode: 0 })
    }
    const { fn } = loadTimerFnWithHttps('notifyFollowUpdates', responses, {
      env: { BOCHA_API_KEY: 'bocha-test', SUBSCRIBE_TEMPLATE_ID: 'tmpl-test' },
      push
    })
    const oldFetched = ago(25 * 60 * 60 * 1000)
    env.db.__seed('users', [
      { _id: 'row-u1', _openid: 'openid-u1', subscribe_ok: true },
      { _id: 'row-u2', _openid: 'openid-u2', subscribe_ok: true }
    ])
    env.db.__seed('follows', [
      { _id: 'openid-u1#张三#tech', openid: 'openid-u1', person_key: '张三#tech', name: '张三' },
      { _id: 'openid-u2#张三#tech', openid: 'openid-u2', person_key: '张三#tech', name: '张三' }
    ])
    env.db.__seed('feed_cache', [
      {
        _id: '张三#tech',
        items: [{ title: 'old', url: 'https://news.example.com/0', content: 'c', source: 's' }],
        fetched_at: oldFetched
      }
    ])

    const first = await fn.main()

    eq(first.ok, true)
    eq(first.pushed, 1, 'u1 收到、u2 瞬时失败')
    const feed1 = env.db.__dump('feed_cache')[0]
    eq(feed1.items.length, 1, '有人没送达就不能写回 —— 写回等于宣布「这批推过了」')
    eq(feed1.fetched_at, oldFetched, '缓存时间戳也不动，下一轮还会重新 diff 出这条')

    const second = await fn.main()

    eq(second.pushed, 1, '第二轮 u2 终于收到 —— 证明那份「没送达」被保住了')
    eq(env.db.__dump('feed_cache')[0].items.length, 2, '全部送达后才写回')
  })
})

/*
 * P2-31：超长关键词整行忽略（否则上游检索被这种句子吃掉预算，每个人都被拖慢）。
 */
describe('P2-31 超长关键词整行忽略', () => {
  it('超过 12 字的词不打上游，并把 invalid 计数报回来', async () => {
    const { fn, calls } = loadTimerFnWithHttps('keywordAlert', [searchOk(1)], {
      env: { BOCHA_API_KEY: 'bocha-test' }
    })
    const longWord = '这是一个非常非常长的关键词超过十二个字了'
    env.db.__seed('keyword_watches', [
      { _id: `u1#${longWord}`, openid: 'u1', keyword: longWord, type: 'keyword' },
      { _id: 'u1#雷军', openid: 'u1', keyword: '雷军', type: 'keyword' }
    ])

    const res = await fn.main()

    eq(res.invalid, 1, '超长词要单独计数（恒为 0 才「正常」就说明没人看这个数）')
    ok(res.skipped.some((s) => String(s).includes('超过 12 字')), `实际：${JSON.stringify(res.skipped)}`)
    eq(calls.length, 1, '只该为「雷军」打一次上游')
    eq(calls[0].body.query, '雷军')
  })

  it('全是超长词时直接收工：keywords=0 且一次上游都不打', async () => {
    const { fn, calls } = loadTimerFnWithHttps('keywordAlert', [searchOk(1)], {
      env: { BOCHA_API_KEY: 'bocha-test' }
    })
    const longWord = 'x'.repeat(20)
    env.db.__seed('keyword_watches', [
      { _id: `u1#${longWord}`, openid: 'u1', keyword: longWord, type: 'keyword' }
    ])

    const res = await fn.main()

    eq(res.keywords, 0)
    eq(res.invalid, 1)
    eq(calls.length, 0)
  })
})

/*
 * P2-32：热榜构建锁 —— 定时器与手动刷新可能同时进来，两边都做完整轮检索 + 生成就是纯浪费，
 * 且后写的会覆盖先写的。持锁者让出，死锁（超过 TTL）自动被清掉重抢。
 */
describe('P2-32 热榜构建锁', () => {
  const hotItems = () => {
    const codes = ['tech', 'internet', 'business', 'finance', 'auto', 'ent']
    return Array.from({ length: 24 }, (_, i) => ({
      name: `人物${i}`,
      domain: codes[i % codes.length],
      tag: '动态',
      trend: '近期在做什么'
    }))
  }

  it('锁被持有（新鲜的 building 行）：本轮直接让出，一次上游都不打', async () => {
    const { fn, calls } = loadTimerFnWithHttps('hotBoardRefresh', [], {
      env: { BOCHA_API_KEY: 'bocha-test' }
    })
    env.db.__seed('hot_board', [{ _id: 'building', at: new Date().toISOString() }])

    const res = await fn.main({ action: 'run' })

    eq(res.ok, true)
    eq(res.skipped, 'building', '同时进来的第二个实例应当让出，而不是再烧一遍检索与生成')
    eq(calls.length, 0)
  })

  it('死锁（超过 TTL 的 building 行）被清掉重抢，构建成功后放锁', async () => {
    const responses = [
      searchOk(3), searchOk(3), searchOk(3), searchOk(3), searchOk(3), searchOk(3),
      searchOk(3), searchOk(3), searchOk(3), searchOk(3), searchOk(3), searchOk(3),
      chatOk(JSON.stringify({ items: hotItems() }))
    ]
    const { fn } = loadTimerFnWithHttps('hotBoardRefresh', responses, {
      env: { BOCHA_API_KEY: 'bocha-test' }
    })
    env.db.__seed('hot_board', [{ _id: 'building', at: ago(10 * 60 * 1000) }])

    const res = await fn.main({ action: 'run' })

    eq(res.ok, true, JSON.stringify(res))
    eq(res.count, 24)
    const rows = env.db.__dump('hot_board')
    const board = rows.find((r) => r._id === 'latest')
    ok(board && board.items.length === 24, '榜单要落库')
    notOk(rows.some((r) => r._id === 'building'), '成功后放锁 —— 否则下一轮会一直撞在这把锁上')
  })

  it('模型把结构位写成全角（`，` `：` 连括号一起）：归一后照常出榜，值里的全角标点原样保留', async () => {
    /* 端上 utils/llm.ts 的 repairJsonText 补第 ⑤ 条（结构位全角归一）时，这份手抄的副本漏了。
       后果不吵不闹：extractJson 返回 null 或 normalizeItems 拿到空 items，整轮报「榜单不合格」，
       热榜当天不更新而没人收到提示（对比：端上那条路径至少有用户会点重试）。
       这里把括号也一起换成全角，顺手把「候选扫描认全角」那道门也钉住。 */
    const items = hotItems()
    items[0].name = '全角人物甲'
    items[0].trend = '上升期，话题度高'
    const raw = JSON.stringify({ items })
      .replace(/,/g, '，')
      .replace(/:/g, '：')
      .replace(/\[/g, '［')
      .replace(/\]/g, '］')
      .replace(/\{/g, '｛')
      .replace(/\}/g, '｝')

    const { fn } = loadTimerFnWithHttps('hotBoardRefresh', [...Array.from({ length: 12 }, () => searchOk(3)), chatOk(raw)], {
      env: { BOCHA_API_KEY: 'bocha-test' }
    })
    env.db.__seed('hot_board', [{ _id: 'building', at: ago(10 * 60 * 1000) }])

    const res = await fn.main({ action: 'run' })

    eq(res.ok, true, JSON.stringify(res))
    eq(res.count, 24)
    const board = env.db.__dump('hot_board').find((r) => r._id === 'latest')
    const first = board && board.items.find((i) => i.name === '全角人物甲')
    ok(first, '整段全角也要能出榜（连候选片段都取不出来的话，这里就是空的）')
    eq(first.trend, '上升期，话题度高', '值里的全角逗号是内容，一个字符都不能被归一')
  })

  it('模型把整个对象多包一层数组：拆一层后照常出榜（内容一个字不差，只是多了对方括号）', async () => {
    /* 提示词里刚排过 `"items": []` 这类数组字段，模型顺手就多包一层。语法完全合法、
       内容一个字不差，但 normalizeItems 只认 parsed.items —— 不解包就是「榜单不合格」。 */
    const items = hotItems()
    items[0].name = '包裹人物乙'
    const raw = JSON.stringify([{ items }])

    const { fn } = loadTimerFnWithHttps('hotBoardRefresh', [...Array.from({ length: 12 }, () => searchOk(3)), chatOk(raw)], {
      env: { BOCHA_API_KEY: 'bocha-test' }
    })
    env.db.__seed('hot_board', [{ _id: 'building', at: ago(10 * 60 * 1000) }])

    const res = await fn.main({ action: 'run' })

    eq(res.ok, true, JSON.stringify(res))
    eq(res.count, 24)
  })
})
