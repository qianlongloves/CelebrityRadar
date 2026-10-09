'use strict'

/**
 * 支付回调的状态机（cloudfunctions/payCallback）
 *
 * 这里钉的是全项目**后果最重的一条路径**：用户付了钱却没拿到会员。
 *
 * 微信支付回调失败时我们会返回非 0，让微信按退避策略重试 —— 重试是唯一的补偿通道
 * （用户侧没有任何入口能重新触发发货）。而抢占发货权若直接把订单置成终态 `paid`，
 * 重试进来就会被顶部的「已 paid ⇒ ack」判断挡掉，货永远发不出去，且订单看起来一切正常。
 *
 * 故订单状态必须是三段：
 *   pending   —— 已下单未付款；
 *   granting  —— 已收到支付成功通知、正在发货（写 memberships + users.membership），**不是终态**；
 *               残留的 granting 就是「付了钱还没拿到会员」，重试会继续发货；
 *   paid      —— 发货完成（同时写上 granted_at），此后回调只 ack，不二次发货。
 *
 * 另外三条一起吃住的边界：重复回调不叠加天数（续期按 max(now, 旧 expires_at)）、
 * 金额不符不发货、已 failed / refunded 的订单重试也不能发货。
 *
 * 云函数不能 require 端上 TS，所以这里直接加载它的**源码**：把 `wx-server-sdk` 换成
 * harness 的内存 DB（同一个 mock 支持 collection / doc / where / update，见 harness/cloud-db.js），
 * 于是断的是真行为，不是源码字面量。
 */

const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, eq, ok, deepEq } = require('../harness/t')

const FN = path.resolve(__dirname, '..', '..', 'cloudfunctions', 'payCallback', 'index.js')

const DAY_MS = 86400000

/** 加载 payCallback 源码，并把它的 `wx-server-sdk` 指向 harness 的内存 DB */
function loadFn() {
  env.resetAll()
  const db = env.db.database()
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db
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

const ORDER = {
  _id: 'T1',
  _openid: 'u1',
  plan: 'month',
  amount_fen: 1900,
  days: 31,
  status: 'pending',
  created_at: '2026-10-09T00:00:00.000Z',
  paid_at: null,
  transaction_id: null,
  callback_fee: null
}

/** users 行：云函数按 _openid 查、按 _id 更新，故两个都要有 */
const USER = {
  _id: 'row-u1',
  _openid: 'u1',
  nickname: null,
  created_at: '2026-10-01T00:00:00.000Z',
  membership: null
}

/** 微信支付成功通知（字段名用 v2 通知的 snake_case） */
const notify = (over) =>
  Object.assign(
    {
      returnCode: 'SUCCESS',
      resultCode: 'SUCCESS',
      outTradeNo: 'T1',
      totalFee: 1900,
      transactionId: 'wx-tx-1'
    },
    over
  )

const order = () => env.db.__dump('orders')[0]
/** 端上界面读的那份**镜像**（users.membership） */
const membership = () => env.db.__dump('users')[0].membership
/** 云端判会员读的那份**权威**（memberships，_id = openid） */
const authority = () => env.db.__dump('memberships')[0]

describe('支付回调状态机 cloudfunctions/payCallback', () => {
  it('正常回调：发货成功，订单落到终态 paid 并留下 granted_at', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [ORDER])
    env.db.__seed('users', [USER])

    const res = await fn.main(notify())

    eq(res.errcode, 0, '成功要 ack，否则微信会一直重发')
    eq(order().status, 'paid')
    ok(order().paid_at, '收到支付通知的时刻要留下')
    ok(order().granted_at, '发货完成才置 paid，必须能查出是什么时候发的')
    eq(order().transaction_id, 'wx-tx-1')
    eq(membership().last_order_id, 'T1', '发货侧的去重标记')
    eq(membership().plan, 'month')
    ok(
      Date.parse(membership().expires_at) > Date.now() + 30 * DAY_MS,
      `有效期应约等于 31 天，实际 ${membership().expires_at}`
    )
    /* 双写：权威（memberships）+ 镜像（users.membership）内容必须一致，
       否则「端上显示会员、云端判非会员」（或反之）—— 前者用户投诉、后者更贵。 */
    eq(authority()._id, 'u1', '权威行的主键就是 openid')
    eq(authority()._openid, 'u1', '云函数是管理员身份，_openid 必须显式写')
    eq(authority().last_order_id, 'T1')
    eq(authority().plan, 'month')
    eq(authority().expires_at, membership().expires_at, '两处的有效期必须逐字相同')
  })

  it('发货失败：订单停在 granting 而不是 paid，微信重试能把货补上', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [ORDER])
    env.db.__seed('users', [USER])

    /* 故障注入：只有发货这一步（写 users）写不进去 —— orders 的读写都是好的 */
    env.db.__setFailing('users', true)
    const first = await fn.main(notify())

    eq(first.errcode, -1, '内部故障必须返回非 0，这是让微信重试的唯一办法')
    eq(
      order().status,
      'granting',
      '绝不能提前置 paid：一旦置了，重试会被「已 paid」判断 ack 掉，用户永远拿不到会员'
    )
    eq(membership(), null, '这一趟确实没发出去货')

    env.db.__setFailing('users', false)
    const retry = await fn.main(notify())

    eq(retry.errcode, 0, '补偿成功')
    eq(order().status, 'paid', '重试要把订单推到终态，不用人工介入')
    ok(order().granted_at)
    eq(membership().last_order_id, 'T1', '重试就是把货补上')
    ok(Date.parse(membership().expires_at) > Date.now() + 30 * DAY_MS)
  })

  it('重复回调不叠加天数（同一订单只发一次货）', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [ORDER])
    env.db.__seed('users', [USER])

    await fn.main(notify())
    const first = membership().expires_at
    const res = await fn.main(notify())

    eq(res.errcode, 0, '重复通知要 ack 掉，不能让它一直重发')
    eq(membership().expires_at, first, '第二次回调不得再延一次 31 天')
    eq(order().status, 'paid')
  })

  it('granting 残留（上次发货后置 paid 没成）时重试自愈，且不叠加天数', async () => {
    const fn = loadFn()
    const shipped = {
      plan: 'month',
      expires_at: '2027-01-01T00:00:00.000Z',
      last_order_id: 'T1',
      updated_at: '2026-10-09T00:00:01.000Z'
    }
    env.db.__seed('orders', [Object.assign({}, ORDER, { status: 'granting', paid_at: '2026-10-09T00:00:01.000Z' })])
    env.db.__seed('users', [Object.assign({}, USER, { membership: shipped })])

    const res = await fn.main(notify())

    eq(res.errcode, 0)
    eq(order().status, 'paid', '状态没到终态就继续推进，否则这单一直挂在 granting')
    eq(membership().expires_at, shipped.expires_at, '货已经发过了，必须原样不动')
    eq(membership().last_order_id, 'T1')
  })

  it('金额不符：不发货、标 failed，且 ack 掉（这种错重试一万次都一样）', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [ORDER])
    env.db.__seed('users', [USER])

    const res = await fn.main(notify({ totalFee: 1 }))

    eq(res.errcode, 0, '确定性异常重试无意义，ack 掉留人工核对')
    eq(order().status, 'failed')
    eq(order().callback_fee, 1, '把回调金额记下来，人工核对才有依据')
    eq(membership(), null, '绝不能发货')
  })

  it('已 failed / refunded 的订单，重试也不能发货', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [Object.assign({}, ORDER, { status: 'failed' })])
    env.db.__seed('users', [USER])

    const res = await fn.main(notify())

    eq(res.errcode, 0)
    eq(order().status, 'failed', '保持原状态')
    eq(membership(), null, 'failed 的单即便金额对得上也不能发货 —— 它已经被人判定过是异常单')
  })

  it('缺订单号 / 非成功通知：一律 ack，不抛也不发货', async () => {
    const fn = loadFn()
    env.db.__seed('orders', [ORDER])
    env.db.__seed('users', [USER])

    eq((await fn.main({})).errcode, 0, '空通知不能炸')
    eq((await fn.main(notify({ resultCode: 'FAIL' }))).errcode, 0, '失败通知不涉及发货')
    eq(order().status, 'pending', '两次都不该动订单')
    eq(membership(), null)
  })

  /* ---------------------- 权威 + 镜像双写（A2，2026-10-09） ----------------------
   *
   * 两处内容必须一致，且**任一处缺失都能在下一趟补齐**：
   *   ① 权威已记这一单、镜像没跟上（上次发货后半程失败）→ 只补镜像，不重算天数；
   *   ② 镜像已记这一单、权威没有（迁移前发的货）→ 只补权威，不重算天数。
   * 「不重算」是这里最容易写错的地方：重算就等于同一单白送一次天数。
   * 找不到用户行（users 读不到）时仍是非 0，交给微信重试 —— 这是唯一的补偿通道。
   */

  it('权威已记、镜像未跟上：重试只补镜像，且照抄权威的有效期', async () => {
    const fn = loadFn()
    const auth = { plan: 'month', expires_at: '2027-01-01T00:00:00.000Z', last_order_id: 'T1' }
    env.db.__seed('orders', [Object.assign({}, ORDER, { status: 'granting', paid_at: '2026-10-09T00:00:01.000Z' })])
    env.db.__seed('users', [USER])
    env.db.__seed('memberships', [Object.assign({ _id: 'u1', _openid: 'u1' }, auth)])

    /* 故障：这一趟读/写 users 都不行 ⇒ 补镜像这一步失败，必须让微信重试 */
    env.db.__setFailing('users', true)
    const first = await fn.main(notify())
    eq(first.errcode, -1, '补镜像失败要返回非 0')
    eq(order().status, 'granting', '没发完货就不能置 paid')
    eq(authority().expires_at, auth.expires_at, '权威行不得被重算')

    env.db.__setFailing('users', false)
    const retry = await fn.main(notify())
    eq(retry.errcode, 0)
    eq(membership().expires_at, auth.expires_at, '补齐镜像时照抄权威有效期（不叠加）')
    eq(membership().last_order_id, 'T1')
    eq(order().status, 'paid')
  })

  it('迁移期：镜像里已有这一单而权威还没有 → 补齐权威，且不重算天数', async () => {
    const fn = loadFn()
    const shipped = { plan: 'month', expires_at: '2027-01-01T00:00:00.000Z', last_order_id: 'T1' }
    env.db.__seed('orders', [Object.assign({}, ORDER, { status: 'granting', paid_at: '2026-10-09T00:00:01.000Z' })])
    env.db.__seed('users', [Object.assign({}, USER, { membership: shipped })])

    const res = await fn.main(notify())

    eq(res.errcode, 0)
    eq(authority().last_order_id, 'T1', '权威行必须补上（否则云端仍判非会员）')
    eq(authority().expires_at, shipped.expires_at, '照抄镜像的有效期，不得重算（重算就是白送 31 天）')
    eq(membership().expires_at, shipped.expires_at, '镜像原样不动')
    eq(order().status, 'paid')
  })

  it('续费顺延：base 取 max(now, 权威, 镜像)，不吃掉任一处已付的天数', async () => {
    const fn = loadFn()
    const future = new Date(Date.now() + 10 * DAY_MS).toISOString()
    env.db.__seed('orders', [ORDER])
    env.db.__seed('users', [Object.assign({}, USER, { membership: { plan: 'month', expires_at: future, last_order_id: 'OLD' } })])
    env.db.__seed('memberships', [{ _id: 'u1', _openid: 'u1', plan: 'month', expires_at: future, last_order_id: 'OLD' }])

    const res = await fn.main(notify())

    eq(res.errcode, 0)
    ok(
      Date.parse(authority().expires_at) > Date.now() + 40 * DAY_MS,
      `应在剩余 10 天上再叠 31 天，实际 ${authority().expires_at}`
    )
    eq(membership().expires_at, authority().expires_at, '两处同步顺延')
  })
})

/*
 * P1-10（2026-10-09）：退款名单 `refunded_orders` 是「这几单已经扣过天数」的唯一凭据，
 * 而权威行是 `set` 全量覆盖。发货路径有两个地方会把它写没：
 *   ① 分支②「镜像已记本单、权威没有」补权威时**没有带**这个字段；
 *   ② `readMembership` 用 `doc().get()` + `catch → null`，把「读失败」也当成「没有行」，
 *      于是走新发货分支、拿镜像重算有效期并写一个 `refunded_orders: undefined`。
 * 两种都**不报错**，代价是下一轮对账会对同一单再扣一次用户已付的天数。下面两条分别钉住。
 */
describe('P1-10 退款名单不得被发货路径抹掉', () => {
  it('分支②（镜像已记本单、权威记的是另一单）：补权威时把已有退款名单原样带回', async () => {
    const fn = loadFn()
    const future = new Date(Date.now() + 40 * DAY_MS).toISOString()
    /* 权威行存在，但 `last_order_id` 是更早的另一单，且带着退款名单 */
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: future, last_order_id: 'OLD', refunded_orders: ['R0'] }
    ])
    /* 镜像记的正是本次要补的这一单 ⇒ 命中分支② */
    env.db.__seed('users', [
      Object.assign({}, USER, {
        membership: { plan: 'month', expires_at: future, last_order_id: 'T1' }
      })
    ])
    env.db.__seed('orders', [Object.assign({}, ORDER, { status: 'granting', paid_at: '2026-10-09T00:00:01.000Z' })])

    const res = await fn.main(notify())

    eq(res.errcode, 0)
    eq(authority().last_order_id, 'T1', '权威要补上这一单')
    eq(authority().expires_at, future, '照抄镜像有效期，不重算（重算就是白送）')
    deepEq(
      authority().refunded_orders,
      ['R0'],
      '名单丢了下一轮对账就会对 R0 再扣一次天数 —— 吃用户已付的天数是最不能接受的失败'
    )
  })

  it('读权威失败：与「没有权威行」区分开，本趟不写、返回非 0，名单原样不动', async () => {
    const fn = loadFn()
    const future = new Date(Date.now() + 40 * DAY_MS).toISOString()
    env.db.__seed('memberships', [
      { _id: 'u1', _openid: 'u1', plan: 'month', expires_at: future, last_order_id: 'OLD', refunded_orders: ['R0'] }
    ])
    /* 镜像记的是旧单（与本单无关）：若把读失败错当成「没有行」，就会走新发货分支重算并清空名单 */
    env.db.__seed('users', [
      Object.assign({}, USER, {
        membership: { plan: 'month', expires_at: future, last_order_id: 'OLD' }
      })
    ])
    env.db.__seed('orders', [Object.assign({}, ORDER, { status: 'granting', paid_at: '2026-10-09T00:00:01.000Z' })])
    /* 只让 memberships 的**读**失败（写照常）——这正是 `doc().get()+catch` 会吞掉的那种情形 */
    env.db.__setReadFailing('memberships', true)

    const res = await fn.main(notify())

    eq(res.errcode, -1, '读失败要原样冒泡让微信重试，而不是被吞成「没有权威行」')
    eq(authority().last_order_id, 'OLD', '一趟失败的调用不得改写权威行')
    eq(authority().expires_at, future, '更不得拿镜像重算有效期')
    deepEq(authority().refunded_orders, ['R0'], '名单必须原样还在（旧写法会把它清掉）')
  })
})
