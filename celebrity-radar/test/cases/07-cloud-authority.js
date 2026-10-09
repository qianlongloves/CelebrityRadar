'use strict'

/**
 * 服务端权威与云端闸门（A2 / A3 / B8，2026-10-09）
 *
 * 三件事的根子是同一个：**端上能自证的判定就不是判定**。小程序包可解包，
 * 凡是「改包即可获利的判定」都必须搬到云函数里再判一次。
 *
 *   A2 —— 会员身份的权威从 users.membership（仅创建者可读写）下沉到 memberships
 *         （客户端完全不可读写）。不改的话，端上给自己那一行写上 membership
 *         就能白用最贵模型、并且拿「会员补齐」免计费。
 *   A3 —— aiProxy 的 `test` 是「向两家上游各打一次真实付费探测」，而 action 是
 *         客户端可构造的字段。原来的默认值正是 'test' ⇒ 一次调用烧两笔上游钱。
 *   B8 —— 每日上限的判定从端上搬到 aiProxy 入口；且云端只看 memberships。
 *
 * 这里分两段钉：
 *   ① 源码级（谁读哪张表、默认 action、口令 fail-closed、数值与端上同源）；
 *   ② 行为级 —— 把 aiProxy 真跑一遍（假 wx-server-sdk + 假 https），
 *      断言的是「花了 / 没花钱、发的什么模型、留下的什么计数」，不是字面量。
 *
 * 端上侧（purpose 带上云、kind 决定要不要重试）放在文件末尾：B8 是两端各一半的事。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const BUILD = path.resolve(__dirname, '..', '.build')

const AI_PROXY = path.join(CLOUD, 'aiProxy', 'index.js')
const LLM_CONFIG = path.join(CLOUD, 'aiProxy', 'llm.config.js')
const QUOTA_CONFIG = path.join(CLOUD, 'aiProxy', 'quota.config.js')
const QUOTA_GUARD = path.join(CLOUD, 'quotaGuard', 'index.js')
const SCHEMA = path.join(CLOUD, 'dbInit', 'schema.js')

const read = (p) => fs.readFileSync(p, 'utf8')
const proxySrc = read(AI_PROXY)
const guardSrc = read(QUOTA_GUARD)
const cfgSrc = read(QUOTA_CONFIG)
const schemaSrc = read(SCHEMA)

const cfg = require(QUOTA_CONFIG)

const DAY_MS = 86400000
const quotaKey = () => `u1#${cfg.todayKey()}`
const memberRow = (over) =>
  Object.assign(
    {
      _id: 'u1',
      _openid: 'u1',
      plan: 'month',
      expires_at: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      last_order_id: 'T1'
    },
    over
  )

/* ============================ ①  源码级（谁读哪张表） ============================ */

describe('A2 会员权威下沉 memberships', () => {
  it('aiProxy 判会员读 memberships，不再回落到端上可写的 users', () => {
    ok(
      proxySrc.includes("db.collection('memberships').doc(openid).get()"),
      '会员身份必须读服务端权威表'
    )
    notOk(/collection\('users'\)/.test(proxySrc), 'users 是「仅创建者可读写」：以它为准 = 端上自证会员')
  })

  it('quotaGuard 的免计费复核同样只读 memberships', () => {
    ok(
      guardSrc.includes("db.collection('memberships').doc(openid).get()"),
      '免计费是白给一次生成，身份更不能取自端上可写的那张表'
    )
    notOk(/collection\('users'\)/.test(guardSrc))
  })

  it('memberships / ai_calls 在库结构里标为「客户端不可读写」', () => {
    ok(schemaSrc.includes('cloudOnly:'), 'ACL 档要存在，否则权限无从声明')
    ok(
      /name: 'memberships'[\s\S]{0,400}acl: ACL\.cloudOnly/.test(schemaSrc),
      'memberships 必须是客户端完全不可读写'
    )
    ok(
      /name: 'ai_calls'[\s\S]{0,400}acl: ACL\.cloudOnly/.test(schemaSrc),
      '防滥用计数若客户端可写，闸门等于没有'
    )
  })

  it('users.purpose 如实标注 membership 只是镜像', () => {
    ok(/membership 是端上读口的\*\*镜像\*\*/.test(schemaSrc), '库结构的注释就是下一个人唯一的线索')
  })
})

describe('A3 test 探针要口令', () => {
  it('默认 action 不再是 test', () => {
    ok(/const action = \(event && event\.action\) \|\| ''/.test(proxySrc))
    notOk(/\|\| 'test'/.test(proxySrc), '默认值绑付费探针 = 给任何调用者一个烧钱开关')
  })

  it('口令取 AI_PROXY_TEST_TOKEN，未配置一律拒绝（fail-closed）', () => {
    ok(proxySrc.includes("readEnv('AI_PROXY_TEST_TOKEN')"))
    ok(/!testToken \|\| \(event && event\.token\) !== testToken/.test(proxySrc))
  })

  it('注释不再自称 test 是默认动作（否则下一个人照着注释改回去）', () => {
    notOk(/'test'\s*（默认）/.test(proxySrc))
  })
})

describe('B8 云端闸门与端上同源', () => {
  it('chat 必须先拿到 openid（否则配额与会员都无从谈起）', () => {
    ok(/const openid = \(cloud\.getWXContext\(\) \|\| \{\}\)\.OPENID[\s\S]{0,200}kind: 'auth'/.test(proxySrc))
  })

  it('闸门在真正付费的 postJson 之前', () => {
    ok(proxySrc.includes('const gate = await quotaGate(openid, event.purpose, isMember)'))
    ok(proxySrc.includes('if (gate) return gate'))
  })

  it('配额数值与端上 MEMBER_BENEFITS 逐一相同（改一端就红）', () => {
    const m = env.load('utils/member')
    eq(cfg.QUOTA_POOLS.generate.free, m.MEMBER_BENEFITS.generatePerDay.free, '免费生成额度')
    eq(cfg.QUOTA_POOLS.generate.member, m.MEMBER_BENEFITS.generatePerDay.member, '会员生成额度')
    eq(cfg.QUOTA_POOLS.ask.free, m.MEMBER_BENEFITS.askPerDay.free, '免费提问额度')
    eq(cfg.QUOTA_POOLS.ask.member, m.MEMBER_BENEFITS.askPerDay.member, '会员提问额度')
  })

  it('表名与 quotaGuard 的 TABLE_BY_KIND 一致', () => {
    eq(cfg.QUOTA_POOLS.generate.table, 'generate_quota')
    eq(cfg.QUOTA_POOLS.ask.table, 'ask_quota')
    ok(guardSrc.includes("generate: 'generate_quota'"))
    ok(guardSrc.includes("ask: 'ask_quota'"))
  })

  it('服务端「今天」显式 +8（UTC 与端上 todayKey 错位会正好差一天）', () => {
    ok(cfgSrc.includes('8 * 3600 * 1000'))
    eq(cfg.todayKey(), new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10))
  })

  it('漏传 purpose 时取最严的 generate（不会默默多给免费用户 2 次）', () => {
    eq(cfg.DEFAULT_PURPOSE, 'generate')
    ok(cfg.QUOTA_POOLS.generate.free < cfg.QUOTA_POOLS.ask.free, '前提：generate 确实比 ask 严')
    eq(cfg.AUX_PURPOSE, 'aux', '辅助调用必须有一档不占产品额度的 purpose')
  })

  it('report.ts 遇 quota / abuse / upstream_quota 跳过纯文本降级（否则被同一道闸再拦一次）', () => {
    const src = read(path.join(ROOT, 'src', 'utils', 'report.ts'))
    ok(
      src.includes("result.kind === 'quota' || result.kind === 'abuse' || result.kind === 'upstream_quota'"),
      'P2-9：上游欠费时降级那次打的是同一个上游，必然再被拒一次'
    )
  })
})

/* ==================== ②  行为级：把 aiProxy 真跑一遍（假上游） ==================== */

/** 假上游：按顺序吐出预置响应，并记下每次请求体 */
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
            /* 保持原样：这里只关心业务请求体，不校验 JSON 合法性 */
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
  return { module, calls }
}

const chatOk = (content = '{"ok":true}') => ({
  status: 200,
  data: { choices: [{ message: { content }, finish_reason: 'stop' }] }
})

const searchOk = (n = 3) => ({
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

/** 清掉一切可能干扰的 LLM_* 覆写与联调开关，只留两把「key」 */
function clearLlmEnv() {
  for (const k of [
    'LLM_PROVIDER',
    'LLM_MODEL',
    'LLM_BASE_URL',
    'LLM_API_KEY',
    'AI_PROXY_TEST_TOKEN',
    cfg.QUOTA_GUARD_ENV
  ]) {
    delete process.env[k]
  }
  process.env.BOCHA_API_KEY = 'bocha-test'
  process.env.DEEPSEEK_API_KEY = 'llm-test'
}

/** 加载 aiProxy 源码：wx-server-sdk → harness 内存 DB，https → 假上游 */
function loadProxy({ openid = 'u1', https } = {}) {
  env.resetAll()
  clearLlmEnv()
  const db = env.db.database()
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => (openid ? { OPENID: openid } : {})
  }
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fakeSdk
    if (id === 'https') return https.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(AI_PROXY)]
    delete require.cache[require.resolve(LLM_CONFIG)]
    return { fn: require(AI_PROXY), calls: https.calls }
  } finally {
    Module.prototype.require = orig
  }
}

/** 加载 quotaGuard 源码：wx-server-sdk → harness 内存 DB */
function loadGuard({ openid = 'u1' } = {}) {
  env.resetAll()
  const db = env.db.database()
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => (openid ? { OPENID: openid } : {})
  }
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fakeSdk
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(QUOTA_GUARD)]
    return require(QUOTA_GUARD)
  } finally {
    Module.prototype.require = orig
  }
}

const CHAT = {
  action: 'chat',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  purpose: 'generate',
  messages: [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' }
  ]
}
const chat = (fn, over) => fn.main(Object.assign({}, CHAT, over))

describe('aiProxy 模型档位（会员闸门）', () => {
  it('非会员请求会员专属档位：静默降级，且发给上游的就是免费档', async () => {
    const h = fakeHttps([chatOk()])
    const { fn, calls } = loadProxy({ https: h })

    const res = await chat(fn, { model: 'deepseek-v4' })

    eq(res.ok, true, '降级而不是报错：不因一次残留偏好打断生成')
    eq(res.downgraded, true)
    eq(res.model, 'deepseek-v4-flash')
    eq(calls.length, 1)
    eq(calls[0].body.model, 'deepseek-v4-flash', '代价最高的那一档不能被白用')
  })

  it('memberships 里有未过期的会员：档位放行', async () => {
    const h = fakeHttps([chatOk()])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('memberships', [memberRow()])

    const res = await chat(fn, { model: 'deepseek-v4' })

    eq(res.ok, true)
    eq(res.downgraded, false)
    eq(res.model, 'deepseek-v4')
    eq(calls[0].body.model, 'deepseek-v4')
  })

  it('memberships 过期的会员：按非会员降级', async () => {
    const h = fakeHttps([chatOk()])
    const { fn } = loadProxy({ https: h })
    env.db.__seed('memberships', [memberRow({ expires_at: new Date(Date.now() - DAY_MS).toISOString() })])

    const res = await chat(fn, { model: 'deepseek-v4' })

    eq(res.downgraded, true, '只认 expires_at，过期即非会员')
  })

  it('改 users.membership（端上可写的镜像）骗不到会员档位', async () => {
    const h = fakeHttps([chatOk()])
    const { fn } = loadProxy({ https: h })
    env.db.__seed('users', [
      {
        _id: 'row-u1',
        _openid: 'u1',
        membership: { plan: 'month', expires_at: new Date(Date.now() + DAY_MS).toISOString() }
      }
    ])

    const res = await chat(fn, { model: 'deepseek-v4' })

    eq(res.downgraded, true, '若这里是 false，说明云端又回去读端上可写的镜像了')
    eq(res.model, 'deepseek-v4-flash')
  })

  it('读不到 openid：直接拒绝，一次上游都不发', async () => {
    const h = fakeHttps([])
    const { fn, calls } = loadProxy({ openid: null, https: h })

    const res = await chat(fn)

    eq(res.ok, false)
    eq(res.kind, 'auth')
    eq(calls.length, 0)
  })
})

describe('aiProxy 配额与限速闸门', () => {
  it('产品额度用完：拦下（kind=quota），挡在付费调用之前', async () => {
    const h = fakeHttps([])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('generate_quota', [
      { _id: quotaKey(), _openid: 'u1', count: cfg.QUOTA_POOLS.generate.free }
    ])

    const res = await chat(fn)

    eq(res.ok, false)
    eq(res.kind, 'quota')
    ok(res.error.includes('已用完'), `文案要能直接给用户看：${res.error}`)
    eq(calls.length, 0, '闸门必须挡在花钱那一步之前')
  })

  it('会员按会员上限（30）放行，免费档拿不到', async () => {
    const limit = cfg.QUOTA_POOLS.generate.member
    const h = fakeHttps([chatOk()])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('memberships', [memberRow()])
    env.db.__seed('generate_quota', [{ _id: quotaKey(), _openid: 'u1', count: limit - 1 }])

    const res = await chat(fn)

    eq(res.ok, true, '会员在 29 次时仍可生成')
    eq(calls.length, 1)

    env.db.__seed('generate_quota', [{ _id: quotaKey(), _openid: 'u1', count: limit }])
    const h2 = fakeHttps([])
    const second = loadProxy({ https: h2 })
    env.db.__seed('memberships', [memberRow()])
    env.db.__seed('generate_quota', [{ _id: quotaKey(), _openid: 'u1', count: limit }])
    const blocked = await chat(second.fn)
    eq(blocked.kind, 'quota', '到上限即拦')
    eq(h2.calls.length, 0)
  })

  it('提问走独立池：生成额度用完仍能提问', async () => {
    const h = fakeHttps([chatOk('回答')])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('generate_quota', [
      { _id: quotaKey(), _openid: 'u1', count: cfg.QUOTA_POOLS.generate.free }
    ])

    const res = await chat(fn, { purpose: 'ask' })

    eq(res.ok, true, '两个池各自独立，生成用尽不该殃及提问')
    eq(calls.length, 1)
  })

  it('辅助调用（aux）不占产品额度，但仍在限速闸之内', async () => {
    const h = fakeHttps([chatOk('x')])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('generate_quota', [{ _id: quotaKey(), _openid: 'u1', count: 999 }])

    const res = await chat(fn, { purpose: 'aux' })

    eq(res.ok, true, '消歧 / 选题发生在生成之前，被额度拦住会让用户连名字都输入不了')
    eq(calls.length, 1)

    const h2 = fakeHttps([])
    const second = loadProxy({ https: h2 })
    env.db.__seed('ai_calls', [
      { _id: quotaKey(), _openid: 'u1', count: cfg.ABUSE_LIMITS.free }
    ])
    const blocked = await chat(second.fn, { purpose: 'aux' })
    eq(blocked.kind, 'abuse', 'aux 不占额度不等于不记账')
    eq(h2.calls.length, 0)
  })

  it('防滥用限速：计数由云端就地自增，端上无法阻止', async () => {
    const h = fakeHttps([])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('ai_calls', [{ _id: quotaKey(), _openid: 'u1', count: cfg.ABUSE_LIMITS.free }])

    const res = await chat(fn)

    eq(res.ok, false)
    eq(res.kind, 'abuse')
    eq(calls.length, 0)
  })

  it('正常一次调用会在 ai_calls 留下计数（首次建行）', async () => {
    const h = fakeHttps([chatOk()])
    const { fn } = loadProxy({ https: h })

    const res = await chat(fn)

    eq(res.ok, true)
    const rows = env.db.__dump('ai_calls')
    eq(rows.length, 1)
    eq(rows[0]._id, quotaKey())
    eq(rows[0].count, 1, '这一次已经在云端记过，改包者删不掉它')
  })

  it('计数读不到时按 0 放行（闸门自己抖动不该让所有人停用）', async () => {
    const h = fakeHttps([chatOk()])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__setFailing('generate_quota', true)

    const res = await chat(fn)

    eq(res.ok, true)
    eq(calls.length, 1)
  })
})

/*
 * 本地联调开关（AI_PROXY_QUOTA_GUARD，2026-10-09 补）。
 *
 * 现场：端上 debug.disableGenerateQuota 打开后，端上闸门放行、但记账照旧（见 utils/quota.ts），
 * 计数涨到上限后仍被**云端**这两道闸拦下 —— 现象是「debug 明明开了，生成第 4 次仍报额度用完」。
 * 云端不信端上标记（改包可伪造），故两处各一枚开关，这些用例钉住云端那枚的语义：
 * 只放开判定、不放开设账；只认 'off'，其余取值一律按生产口径。
 */
describe('aiProxy 联调开关（AI_PROXY_QUOTA_GUARD）', () => {
  it('off：产品额度用完 + 限速超限都放行，但计数照旧自增', async () => {
    const h = fakeHttps([chatOk()])
    const { fn, calls } = loadProxy({ https: h })
    process.env.AI_PROXY_QUOTA_GUARD = 'off'
    try {
      env.db.__seed('generate_quota', [
        { _id: quotaKey(), _openid: 'u1', count: cfg.QUOTA_POOLS.generate.free + 10 }
      ])
      env.db.__seed('ai_calls', [
        { _id: quotaKey(), _openid: 'u1', count: cfg.ABUSE_LIMITS.free + 10 }
      ])

      const res = await chat(fn)

      eq(res.ok, true, '联调时两道闸都不该拦，否则生成报告永远卡在「额度用完」')
      eq(calls.length, 1, '放行后确实打了一次上游')
      const row = env.db.__dump('ai_calls').find((r) => r._id === quotaKey())
      eq(
        row.count,
        cfg.ABUSE_LIMITS.free + 11,
        '与端上 debug 同一取舍：只放开闸门，记数照旧（排查时能看到真实调用量）'
      )
    } finally {
      delete process.env.AI_PROXY_QUOTA_GUARD
    }
  })

  it('只认 off：其它取值一律按生产口径拦下（fail-closed）', async () => {
    const h = fakeHttps([])
    const { fn, calls } = loadProxy({ https: h })
    process.env.AI_PROXY_QUOTA_GUARD = 'offf'
    try {
      env.db.__seed('generate_quota', [
        { _id: quotaKey(), _openid: 'u1', count: cfg.QUOTA_POOLS.generate.free }
      ])

      const res = await chat(fn)

      eq(res.kind, 'quota', '拼错的开关值不能让闸门静默失效')
      eq(calls.length, 0)
    } finally {
      delete process.env.AI_PROXY_QUOTA_GUARD
    }
  })

  it('off 同样放开共享缓存写口的限速（同一枚开关）', async () => {
    const h = fakeHttps([])
    const { fn } = loadProxy({ https: h })
    process.env.AI_PROXY_QUOTA_GUARD = 'off'
    try {
      env.db.__seed('ai_calls', [
        { _id: `u1#${cfg.todayKey()}#store`, _openid: 'u1', count: 999 }
      ])

      const res = await fn.main({ action: 'report', op: 'acquire', personKey: 'A#tech' })

      eq(res.ok, true, '写口被拦的表现是「抢不到锁 / 写不进缓存」，比额度用完更难归因')
      eq(res.result, 'acquired')
    } finally {
      delete process.env.AI_PROXY_QUOTA_GUARD
    }
  })
})

describe('aiProxy 检索条数上限（云端裁判）', () => {
  it('免费请求 40 条只能拿到 20 条', async () => {
    const h = fakeHttps([searchOk()])
    const { fn, calls } = loadProxy({ https: h })

    const res = await fn.main({ action: 'search', query: '甲', count: 40 })

    eq(res.ok, true)
    eq(calls[0].body.count, 20)
  })

  it('会员请求 40 条按 40 条放行', async () => {
    const h = fakeHttps([searchOk()])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('memberships', [memberRow()])

    await fn.main({ action: 'search', query: '甲', count: 40 })

    eq(calls[0].body.count, 40)
  })

  it('默认条数（≤20）不查会员身份：memberships 读不到也照常检索', async () => {
    const h = fakeHttps([searchOk()])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__setFailing('memberships', true)

    const res = await fn.main({ action: 'search', query: '甲', count: 10 })

    eq(res.ok, true, '免费档主线 / 支线都在 20 以内，不应为此多一次读库')
    eq(calls[0].body.count, 10)
  })

  /* 以下三条钉住 P1 修复（2026-10-09）：search 也是一次**真实付费调用**（博查按次计费），
     原先这条路径上什么闸门都没有 —— 不判额度、不写 ai_calls、连 openid 都不要，
     改包者用 {action:'search', count:20} 循环调用就能无上限刷掉资源包。 */

  it('读不到 openid：search 直接拒绝，一次上游都不发', async () => {
    const h = fakeHttps([])
    const { fn, calls } = loadProxy({ openid: null, https: h })

    const res = await fn.main({ action: 'search', query: '甲' })

    eq(res.ok, false)
    eq(res.kind, 'auth')
    eq(calls.length, 0, '不能留一条「不要身份就能消耗资源包」的路')
  })

  it('search 也在限速闸之内：ai_calls 打满 ⇒ kind=abuse，且不触达上游', async () => {
    const h = fakeHttps([])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('ai_calls', [{ _id: quotaKey(), _openid: 'u1', count: cfg.ABUSE_LIMITS.free }])

    const res = await fn.main({ action: 'search', query: '甲' })

    eq(res.ok, false)
    eq(res.kind, 'abuse')
    eq(calls.length, 0, '拦不住的话，刷掉的就是整个检索资源包')
  })

  it('search 是付费调用，照样在 ai_calls 留下计数（原先这条路径完全裸奔）', async () => {
    const h = fakeHttps([searchOk()])
    const { fn, calls } = loadProxy({ https: h })

    const res = await fn.main({ action: 'search', query: '甲', count: 10 })

    eq(res.ok, true)
    eq(calls.length, 1)
    const rows = env.db.__dump('ai_calls')
    eq(rows.length, 1, '走 aux 档：不占产品额度，但必须记账')
    eq(rows[0].count, 1, '云端就地自增，端上删不掉')
  })
})

describe('aiProxy action 分发与探针口令', () => {
  it('缺省 / 未知 action：不触达任何上游', async () => {
    const h = fakeHttps([])
    const { fn, calls } = loadProxy({ https: h })

    const a = await fn.main({})
    eq(a.ok, false)
    ok(/未知 action/.test(a.error), `缺省应落在错误分支：${a.error}`)

    const b = await fn.main({ action: 'probe' })
    eq(b.ok, false)
    eq(calls.length, 0, '一次调用烧两笔上游钱的那条路已经关掉')
  })

  it('test 探针：没口令 / 口令错都不花钱，口令对才真探两家', async () => {
    const h = fakeHttps([searchOk(3), chatOk('正常')])
    const { fn, calls } = loadProxy({ https: h })

    const noToken = await fn.main({ action: 'test' })
    eq(noToken.ok, false)
    ok(/口令/.test(noToken.error), `未配置时要指路到环境变量：${noToken.error}`)
    eq(calls.length, 0, '未配置 = fail-closed，不能有探测流量')

    process.env.AI_PROXY_TEST_TOKEN = 'secret'
    const wrong = await fn.main({ action: 'test', token: 'nope' })
    eq(wrong.ok, false)
    eq(calls.length, 0, '口令不对不该发出任何上游请求')

    const right = await fn.main({ action: 'test', token: 'secret' })
    eq(calls.length, 2, '口令正确才真探博查与大模型各一次')
    eq(right.bocha.ok, true)
    eq(right.llm.ok, true)
  })
})

describe('上游账户问题不得冒充用户额度（P2-9，2026-10-09）', () => {
  it('大模型 402：kind=upstream_quota（不是 quota），文案指向平台账户', async () => {
    const h = fakeHttps([{ status: 402, data: { error: { message: 'Insufficient Balance' } } }])
    const { fn } = loadProxy({ https: h })

    const res = await chat(fn)

    eq(res.ok, false)
    eq(res.kind, 'upstream_quota', '归成 quota 会把用户引去查自己的额度页（那里是满的）')
    ok(/上游|账户/.test(res.error), `文案应指向平台账户，实际：${res.error}`)
    notOk(/你的|每日.*次/.test(res.error), '不许改写成「你的额度用完了」')
  })

  it('大模型 403：归 upstream_quota（原先落 4xx 兜底 → upstream → 白重试三次）', async () => {
    const h = fakeHttps([{ status: 403, data: { message: 'forbidden' } }])
    const { fn } = loadProxy({ https: h })

    const res = await chat(fn)

    eq(res.ok, false)
    eq(res.kind, 'upstream_quota')
    ok(/403/.test(res.error), `把状态码留在文案里，便于运维定位，实际：${res.error}`)
  })

  it('检索 403：同样是 upstream_quota（博查资源包问题，不是用户额度）', async () => {
    const h = fakeHttps([{ status: 403, data: {} }])
    const { fn } = loadProxy({ https: h })

    const res = await fn.main({ action: 'search', query: '甲', count: 10 })

    eq(res.ok, false)
    eq(res.kind, 'upstream_quota')
  })

  it('分类边界：5xx 仍是可重试的 upstream（别把「上游抖了」也一律说成账户问题）', async () => {
    const h = fakeHttps([{ status: 500, data: {} }])
    const { fn } = loadProxy({ https: h })

    const res = await chat(fn)

    eq(res.kind, 'upstream')
  })
})

/* ==================== ②b  端上侧：V-1 两种真机行为下的闸门（2026-10-09 复审） ==================== */

/**
 * V-1：`doc(id).update()` 打到**不存在的行**，wx-server-sdk 是返回 `stats.updated===0` 还是
 * 直接抛错，真机未确认。内存 DB 默认只复刻前者，于是「抛错」那一支从未被跑过：
 * 一旦真机是抛错，两道云端闸门的「首次调用」都会异常收场 ——
 *   · aiProxy.bumpAbuseCount 首个 update 进外层 catch ⇒ 返回 null（放行）⇒ 计数行永远建不起来，
 *     这道**成本硬边界**彻底失效；
 *   · quotaGuard.incr 首个 update 抛错 ⇒ exports.main 兜成「配额写入失败」⇒ 端上静默回退本机计数。
 * 修复把抛错归一成「自增未落实」，两种真机行为下结论一致。下面把假设**反转过来**钉住它。
 */
describe('V-1：不存在行 update 抛错时两道云端闸门仍成立', () => {
  it('aiProxy 防滥用：抛错也会补建首行并计数（不是每日首次都放行）', async () => {
    const h = fakeHttps([chatOk()])
    const { fn } = loadProxy({ https: h })
    /* 必须在 loadProxy 之后设：它内部的 resetAll() 会清掉故障注入开关 */
    env.db.__setMissingDocUpdateThrows(true)

    const res = await chat(fn)

    eq(res.ok, true, '正常调用不该被闸门自己绊倒')
    const rows = env.db.__dump('ai_calls')
    eq(rows.length, 1, '首行必须建起来，否则计数恒为 0 = 闸门不存在')
    eq(rows[0].count, 1, '云端就地自增，端上删不掉')
  })

  it('aiProxy 防滥用：行已存在时照常拦（打满即 kind=abuse，零上游请求）', async () => {
    const h = fakeHttps([])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__setMissingDocUpdateThrows(true)
    env.db.__seed('ai_calls', [{ _id: quotaKey(), _openid: 'u1', count: cfg.ABUSE_LIMITS.free }])

    const res = await chat(fn)

    eq(res.ok, false)
    eq(res.kind, 'abuse')
    eq(calls.length, 0)
  })

  it('quotaGuard 首行计数：抛错也会建首行并返回 count=1', async () => {
    const guard = loadGuard()
    env.db.__setMissingDocUpdateThrows(true)

    const res = await guard.main({ kind: 'generate', action: 'consume' })

    eq(res.ok, true, `不应因 update 抛错而整条失败：${res.error || ''}`)
    eq(res.count, 1)
    eq(res.created, true)
    const rows = env.db.__dump('generate_quota')
    eq(rows.length, 1, '云端计数行建不起来 ⇒ 多设备口径兜底失效')
    eq(rows[0].count, 1)
  })

  it('quotaGuard 常态自增：行已存在时抛错开关不影响（4 → 5）', async () => {
    const guard = loadGuard()
    env.db.__seed('generate_quota', [{ _id: quotaKey(), _openid: 'u1', count: 4 }])
    env.db.__setMissingDocUpdateThrows(true)

    const res = await guard.main({ kind: 'generate', action: 'consume' })

    eq(res.ok, true)
    eq(res.count, 5, '行存在时走的是常规自增路径，与 V-1 无关却必须一起回归')
    eq(res.created, false)
  })
})

/* ==================== ③  端上侧：purpose 与 kind 的接线（B8 的另一半） ==================== */

function freshClient() {
  env.resetAll()
  env.setDebugFlags({ disableGenerateQuota: false, disableAskQuota: false, memberOverride: 'off' })
  /* hasLlmChannel() 读的是模块级常量 isCloudConfigured：必须在 load 之前改配置对象 */
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
  return env.load
}

describe('端上把 purpose 带上去、并按 kind 决定要不要重试', () => {
  it('chatText 默认走 generate 池，显式传 ask 时原样送达', async () => {
    const load = freshClient()
    const box = []
    env.registerCloudFn('aiProxy', (data) => {
      box.push(data)
      return { ok: true, content: '回答' }
    })
    const { chatText } = load('utils/llm')

    await chatText('S', 'U')
    await chatText('S', 'U', 'ask')

    eq(box[0].purpose, 'generate', '漏传时按最严的一池算（云端 DEFAULT_PURPOSE 同值）')
    eq(box[1].purpose, 'ask')
  })

  it('云端闸门拦下（kind=quota）：不重试，kind 原样交给上层', async () => {
    const load = freshClient()
    let calls = 0
    env.registerCloudFn('aiProxy', () => {
      calls++
      return { ok: false, kind: 'quota', error: '今日报告生成额度已用完（免费版每日 3 次），明日 0 点恢复' }
    })
    const z = require('zod')
    const { chatJSON } = load('utils/llm')

    const res = await chatJSON('S', 'U', z.object({ intro: z.string() }), { retries: 3 })

    eq(res.ok, false)
    eq(res.kind, 'quota')
    eq(res.retryable, false, '配置类失败重试无意义')
    eq(calls, 1, '多试一次就是多一次付费往返；且会把「额度用完」记成「生成失败」')
  })

  it('上游账户问题（kind=upstream_quota）：不重试，且文案原样透传（P2-9）', async () => {
    const load = freshClient()
    let calls = 0
    env.registerCloudFn('aiProxy', () => {
      calls++
      return { ok: false, kind: 'upstream_quota', error: '大模型额度不足（上游账户余额）' }
    })
    const z = require('zod')
    const { chatJSON } = load('utils/llm')

    const res = await chatJSON('S', 'U', z.object({ intro: z.string() }), { retries: 3 })

    eq(res.ok, false)
    eq(res.kind, 'upstream_quota')
    eq(res.retryable, false, '账户欠费时重试必然再被拒一次')
    eq(calls, 1, '一次都不许多烧')
    eq(
      res.error,
      '大模型额度不足（上游账户余额）',
      '平台账户问题要原样透传，不许改写成「你的额度用完了」'
    )
  })

  it('可重试的 kind（upstream）照旧重试到次数上限', async () => {
    const load = freshClient()
    let calls = 0
    env.registerCloudFn('aiProxy', () => {
      calls++
      return { ok: false, kind: 'upstream', error: '上游 5xx' }
    })
    const z = require('zod')
    const { chatJSON } = load('utils/llm')

    const res = await chatJSON('S', 'U', z.object({ intro: z.string() }), { retries: 2 })

    eq(res.ok, false)
    eq(calls, 3, '1 + retries：网络 / 上游抖动值得等一等')
  })
})

/* ═══════════════ ④ 复审批次（P2-25 / P2-22，2026-10-09 全文复审） ═══════════════ */

describe('P2-25 免计费复核的 target 上限与写口同源', () => {
  it('长 personKey（64 < 长度 ≤ 120）也认会员补齐免计费', async () => {
    const guard = loadGuard()
    /* 70 个汉字 → 长度 76：恰好落在「旧的 64」与「写口的 120」之间 —— 正是会被误伤的那一段 */
    const longKey = `${'长'.repeat(70)}#tech`
    ok(longKey.length > 64 && longKey.length <= 120, '用例前提：这个 key 落在两个上限之间')

    env.db.__seed('memberships', [memberRow()])
    env.db.__seed('report_cache', [{ _id: longKey, state: 'ready', report: { name: '长名字' } }])

    const res = await guard.main({
      kind: 'generate',
      action: 'consume',
      waiveIf: 'member_upgrade',
      target: longKey
    })

    eq(res.ok, true)
    eq(res.waived, true, '复核上限若比写口小，长名字的会员补齐会白白多算一次额度')
    eq(env.db.__dump('generate_quota').length, 0, '豁免即不自增')
  })

  it('禁路径分隔符与空串的判定没被顺手改掉', async () => {
    const guard = loadGuard()
    env.db.__seed('memberships', [memberRow()])

    const empty = await guard.main({ kind: 'generate', action: 'consume', waiveIf: 'member_upgrade', target: '' })
    eq(empty.waived, false, '空 target 不能免计费')

    const slash = await guard.main({
      kind: 'generate',
      action: 'consume',
      waiveIf: 'member_upgrade',
      target: 'a/b#tech'
    })
    eq(slash.waived, false, 'doc(id) 里不能出现路径分隔符')
  })

  it('两个上限必须同值（改一个忘另一个就红）', () => {
    const store = read(path.join(CLOUD, 'aiProxy', 'report-store.js'))
    ok(/MAX_KEY_LEN = 120/.test(guardSrc), 'quotaGuard 的复核上限')
    ok(/MAX_KEY_LEN = 120/.test(store), 'aiProxy 写口的落库上限')
  })

  /*
   * P2-30：刷新额度的**判定**搬到这里。此前端上把计数取回来自己比一遍
   * `count <= DAILY_REFRESH_LIMIT`（同一份业务规则的另一个副本，可被改包改掉，
   * 且越界尝试在云端零留痕）。现在云端回报 `limit` / `allowed`，端上直接采用。
   */
  it('P2-30：refresh 的判定由云端给出（peek 回报 limit + allowed）', async () => {
    const guard = loadGuard()
    const res = await guard.main({ kind: 'refresh', action: 'peek' })
    eq(res.ok, true)
    eq(res.limit, 10)
    eq(res.allowed, true, 'count=0 时应当允许')
  })

  it('P2-30：refresh 越界时 allowed=false（先自增再判定 ⇒ 越界尝试也留痕）', async () => {
    const guard = loadGuard()
    const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    env.db.__seed('refresh_quota', [{ _id: `u1#${date}`, _openid: 'u1', count: 10 }])

    const res = await guard.main({ kind: 'refresh', action: 'consume' })

    eq(res.ok, true)
    eq(res.count, 11, '越界的尝试在云端也要留痕，不能悄悄放过')
    eq(res.allowed, false)
    eq(res.limit, 10)
  })

  it('P2-30：generate / ask 不回报 limit / allowed（上限仍在 aiProxy 入口）', async () => {
    const guard = loadGuard()
    const gen = await guard.main({ kind: 'generate', action: 'consume' })
    const ask = await guard.main({ kind: 'ask', action: 'consume' })
    eq(gen.limit, undefined)
    eq(gen.allowed, undefined)
    eq(ask.limit, undefined)
    eq(ask.allowed, undefined)
  })
})

/** 加载一个定时任务云函数：wx-server-sdk → 内存 DB（无 openid = 定时器），https → 假上游 */
function loadScheduled(name, https) {
  env.resetAll()
  clearLlmEnv()
  const db = env.db.database()
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    /* 定时触发没有调用方 openid —— 这正是 P0-21 那道调用方闸门的通过条件 */
    getWXContext: () => ({})
  }
  const p = path.join(CLOUD, name, 'index.js')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fakeSdk
    if (id === 'https') return https.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(p)]
    return { fn: require(p), calls: https.calls }
  } finally {
    Module.prototype.require = orig
  }
}

const wordWatch = (openid, keyword) => ({
  _id: `${openid}#${keyword}`,
  _openid: openid,
  openid,
  keyword,
  type: 'keyword',
  created_at: '2026-10-01T00:00:00.000Z'
})

const personWatch = (openid, personKey, name) => ({
  _id: `${openid}#person#${personKey}`,
  _openid: openid,
  openid,
  type: 'person',
  person_key: personKey,
  keyword: name,
  created_at: '2026-10-01T00:00:00.000Z'
})

describe('P2-22 定时任务：每人订阅上限的云侧兜底', () => {
  it('keywordAlert：同一人的第 6 个词被云端挡下（端上那道可被改包绕过）', async () => {
    const https = fakeHttps(Array.from({ length: 30 }, () => searchOk(1)))
    const { fn, calls } = loadScheduled('keywordAlert', https)
    env.db.__seed('keyword_watches', [
      ...['甲', '乙', '丙', '丁', '戊', '己'].map((k) => wordWatch('u1', k)),
      wordWatch('u2', '庚')
    ])

    const res = await fn.main({})

    eq(res.ok, true)
    eq(res.over_limit, 1, '第 6 个订阅必须被云端挡下，否则一个人能吃掉整轮检索预算')
    const queries = calls.map((c) => (c.body && c.body.query) || '').filter(Boolean)
    eq(
      queries.length,
      6,
      `7 条订阅（同一人 6 条 + 别人 1 条）只该检索 6 个词 —— 被挡下的那个不花上游的钱，实际 ${JSON.stringify(queries)}`
    )
    ok(queries.indexOf('庚') >= 0, '别人的词照常检索')
  })

  it('riskWatch：同一人的第 6 个监控对象被挡下', async () => {
    const https = fakeHttps(Array.from({ length: 30 }, () => searchOk(1)))
    const { fn, calls } = loadScheduled('riskWatch', https)
    env.db.__seed('keyword_watches', [
      ...[1, 2, 3, 4, 5, 6].map((i) => personWatch('u1', `P${i}#tech`, `名人${i}`)),
      personWatch('u2', 'P9#tech', '名人九')
    ])

    const res = await fn.main({})

    eq(res.ok, true)
    eq(res.over_limit, 1, '第 6 个监控必须被云端挡下（每天只有 20 次上游预算）')
    const queries = calls.map((c) => (c.body && c.body.query) || '').filter(Boolean)
    eq(
      queries.length,
      6,
      `7 条监控（同一人 6 条 + 别人 1 条）只该检索 6 位名人，实际 ${JSON.stringify(queries)}`
    )
    ok(queries.indexOf('名人九') >= 0, '别人的监控照常检索')
  })
})
