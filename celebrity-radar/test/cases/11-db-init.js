/*
 * dbInit —— 云数据库运维工具。
 *
 * 本文件钉住 P2-33 / P2-34：
 *   P2-33  索引接口只能按 errmsg 认「已存在」；认不出来时**绝不能猜成已在位**，
 *          否则运维看着报告以为索引齐了，缺掉的索引会让查询静默退化成全表扫。
 *   P2-34  工具函数必须有最外层 try/catch：它的输出就是它的产品，
 *          不该把「缺个环境变量」变成控制台里的一句「调用失败」。
 */
const path = require('path')
const env = require('../harness/env')
const { describe, it, eq, deepEq, ok, notOk } = require('../harness/t')

const FN = path.resolve(__dirname, '..', '..', 'cloudfunctions', 'dbInit', 'index.js')

/** 假微信 HTTP API：`respond(body, nth)` 决定返回体 */
function fakeHttps(respond) {
  const calls = []
  const module = {
    request(options, cb) {
      let raw = ''
      const req = {
        on() {
          return req
        },
        setTimeout() {
          return req
        },
        write(c) {
          raw += c
        },
        destroy() {},
        end() {
          let body = null
          try {
            body = raw ? JSON.parse(raw) : null
          } catch (e) {
            /* 保留 null：本文件只发 JSON */
          }
          calls.push({ path: options.path, body })
          const out = respond(body, calls.length)
          const res = {
            on(ev, fn) {
              if (ev === 'data') fn(typeof out === 'string' ? out : JSON.stringify(out))
              if (ev === 'end') fn()
              return res
            }
          }
          cb(res)
        }
      }
      return req
    }
  }
  return { module, calls }
}

function loadFn(opts = {}) {
  env.resetAll()
  delete process.env.DB_ADMIN_TOKEN
  delete process.env.TCB_ENV
  delete process.env.SCF_NAMESPACE

  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => env.db.database()
  }
  const http = fakeHttps(opts.https || (() => ({ errcode: 0 })))
  const Module = require('module')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    if (id === 'https') return http.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(FN)]
    return { fn: require(FN), http }
  } finally {
    Module.prototype.require = orig
  }
}

describe('P2-34 dbInit 的最外层 try/catch', () => {
  it('取不到环境 ID：返回可读错误体，而不是抛异常', async () => {
    const { fn } = loadFn()

    const res = await fn.main({ action: 'report' })

    eq(res.ok, false)
    ok(String(res.error).includes('环境 ID'), `要指出缺什么，实际：${res.error}`)
    ok(res.hint, '要顺手给出怎么补（工具函数的输出就是它的产品）')
  })

  it('正常巡检不受影响：给了环境能跑完并回权限清单', async () => {
    const { fn } = loadFn()

    const res = await fn.main({ action: 'report', env: 'env-x', only: ['users'] })

    eq(res.ok, true)
    ok(Array.isArray(res.permissions_manual) && res.permissions_manual.length === 1)
    eq(res.permissions_manual[0].collection, 'users')
    ok(res.token_gate, '要明示当前写操作是否被口令闸住')
  })
})

describe('P2-33 索引结果三档：created / exists / unknown', () => {
  it('errmsg 认不出来 ⇒ unknown，并顶到 needs_review（绝不猜成「已在位」）', async () => {
    const { fn } = loadFn({
      https: (body) => {
        /* 整包失败 ⇒ 触发逐条重试 */
        if (body.create_indexes.length > 1) return { errcode: 1, errmsg: 'batch failed' }
        const name = body.create_indexes[0].name
        if (name === 'idx_subscribe_ok') return { errcode: 1, errmsg: 'Index already exist' }
        /* 含「冲突」「重复」这类宽泛词，但并非明确的「已存在」措辞 ⇒ 必须算 unknown */
        if (name === 'idx_alert_ok') return { errcode: 1, errmsg: '参数冲突：索引定义重复' }
        return { errcode: 1, errmsg: 'unexpected upstream glitch' }
      }
    })
    process.env.DB_ADMIN_TOKEN = 'secret'

    const res = await fn.main({
      action: 'indexes',
      apply: true,
      token: 'secret',
      env: 'env-x',
      access_token: 'tok',
      only: ['users']
    })

    const row = res.indexes.find((x) => x.collection === 'users')
    const byName = Object.fromEntries(row.indexes.map((i) => [i.name, i]))

    eq(byName.idx_subscribe_ok.action, 'exists', '明确的「已存在」措辞才认 exists')
    eq(byName.idx_alert_ok.action, 'unknown', '宽泛词不算「已在位」—— 这条正是旧口径的危险方向')
    eq(byName.idx_risk_ok.action, 'unknown')
    ok(byName.idx_alert_ok.errmsg && byName.idx_alert_ok.errcode !== undefined, 'unknown 要带上原始 errcode/errmsg 供人定夺')

    deepEq(
      [...row.needs_review].sort(),
      ['idx_alert_ok', 'idx_risk_ok'],
      '拿不准的条目要顶到这一层，否则会埋在几十条 indexes 里没人看'
    )
  })

  it('整包成功：全部记 created，不出现 needs_review', async () => {
    const { fn } = loadFn({ https: () => ({ errcode: 0 }) })
    process.env.DB_ADMIN_TOKEN = 'secret'

    const res = await fn.main({
      action: 'indexes',
      apply: true,
      token: 'secret',
      env: 'env-x',
      access_token: 'tok',
      only: ['users']
    })

    const row = res.indexes.find((x) => x.collection === 'users')
    ok(row.indexes.every((i) => i.action === 'created'))
    notOk(row.needs_review, '没有拿不准的条目就不该出现这个字段')
  })
})
