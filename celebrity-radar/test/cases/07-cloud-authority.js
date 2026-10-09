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

  it('report.ts 遇 quota / abuse 跳过纯文本降级（否则被同一道闸再拦一次）', () => {
    const src = read(path.join(ROOT, 'src', 'utils', 'report.ts'))
    ok(src.includes("result.kind === 'quota' || result.kind === 'abuse'"))
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

/** 清掉一切可能干扰的 LLM_* 覆写，只留两把「key」 */
function clearLlmEnv() {
  for (const k of ['LLM_PROVIDER', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY', 'AI_PROXY_TEST_TOKEN']) {
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
