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
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

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
/** 云端档位表（模型名 / memberOnly 的真源）：断言一律按它取，不写死模型名 */
const TIERS = require(LLM_CONFIG).TIERS

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

  it('逐档实测：把「极速版」的思考字数报出来（档位标签只描述期望，不描述行为）', async () => {
    /*
     * 桩：第一档（免费档 fast）返回 120 字 reasoning_content 且正文为空 ——
     * 这正是线上那份报错的形状（思考把 max_tokens 吃光、正文一个字都没轮到）；
     * 后两档正常回正文、无 reasoning。
     */
    const thinkOnly = {
      status: 200,
      data: {
        choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'x'.repeat(120) } }]
      }
    }
    const h = fakeHttps([searchOk(3), chatOk('正常'), thinkOnly, chatOk('正常'), chatOk('正常')])
    const { fn, calls } = loadProxy({ https: h })

    process.env.AI_PROXY_TEST_TOKEN = 'secret'
    try {
      const res = await fn.main({ action: 'test', token: 'secret', models: true })

      eq(calls.length, 5, '博查 + 当前档 + 三档逐测')
      eq(res.models.length, 3, '三档都要测到（驱动源是云端 TIERS，不是写死的名单）')
      eq(res.models[0].model, TIERS.fast.model)
      eq(res.models[0].tier, 'fast', '档位标识原样回报（就是端上请求里带的那个 tier）')
      eq(res.models[0].reasoningChars, 120)
      eq(res.models[0].chars, 0)
      ok(/思考模型/.test(res.models[0].verdict), `结论要直接可读：${res.models[0].verdict}`)
      eq(res.models[1].reasoningChars, 0)
      ok(/无思考/.test(res.models[1].verdict), `不带思考的档要认出来：${res.models[1].verdict}`)
      eq(res.models[2].model, TIERS.reason.model)
      eq(res.models[2].tier, 'reason')
    } finally {
      delete process.env.AI_PROXY_TEST_TOKEN
    }
  })

  it('逐档实测是显式的：不传 models 时一次额外请求都不发', async () => {
    const h = fakeHttps([searchOk(3), chatOk('正常')])
    const { fn, calls } = loadProxy({ https: h })

    process.env.AI_PROXY_TEST_TOKEN = 'secret'
    try {
      const res = await fn.main({ action: 'test', token: 'secret' })

      eq(calls.length, 2, '默认那条 test 的请求次数是钉子，不能被逐档实测悄悄改掉')
      eq(res.models, null, '没要求就不测')
      eq(res.modelList, null, '没要求就不列清单')
    } finally {
      delete process.env.AI_PROXY_TEST_TOKEN
    }
  })

  it('probeModels：探表外的候选名，非 2xx 必须带上游原话（否则只知道一个状态码）', async () => {
    /*
     * 桩：三个候选 —— 一个不思考（可用）、一个思考、一个上游 400。
     * 表外的名字（云开发 AI 上临时冒出来的新模型）要能探得到：改档位表前先用它确认可用性；
     * 而那次 400 光看状态码分不清「模型名不存在」还是「参数不认」，故必须带上游原话。
     */
    const h = fakeHttps([
      searchOk(3),
      chatOk('正常'),
      chatOk('正常'),
      {
        status: 200,
        data: {
          choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'x'.repeat(9) } }]
        }
      },
      { status: 400, data: { error: { message: 'Model Not Exist', type: 'invalid_request_error' } } }
    ])
    const { fn, calls } = loadProxy({ https: h })

    process.env.AI_PROXY_TEST_TOKEN = 'secret'
    try {
      const res = await fn.main({
        action: 'test',
        token: 'secret',
        probeModels: ['cand-ok', 'cand-think', 'cand-missing']
      })

      eq(calls.length, 5, '博查 + 当前档 + 三个候选各一次')
      eq(res.models.length, 3, '给几个就探几个')
      eq(res.models[0].model, 'cand-ok')
      eq(res.models[0].tier, 'other', '表里没登记的名字标成 other，不与档位混淆')
      ok(/无思考/.test(res.models[0].verdict), res.models[0].verdict)
      eq(res.models[1].reasoningChars, 9)
      ok(/思考模型/.test(res.models[1].verdict), res.models[1].verdict)
      eq(res.models[2].ok, false)
      ok(/Model Not Exist/.test(res.models[2].verdict), `400 要带上游原话：${res.models[2].verdict}`)
    } finally {
      delete process.env.AI_PROXY_TEST_TOKEN
    }
  })

  it('listModels：退化为列出云端档位表（云开发 AI 没有 /models 端点，故不再触达上游）', async () => {
    const h = fakeHttps([searchOk(3), chatOk('正常')])
    const { fn, calls } = loadProxy({ https: h })

    process.env.AI_PROXY_TEST_TOKEN = 'secret'
    try {
      const res = await fn.main({ action: 'test', token: 'secret', listModels: true })

      eq(calls.length, 2, '默认两条（博查 + 当前档）；清单是本地档位表，不产生第三次请求')
      ok(
        !calls.some((c) => String(c.path).endsWith('/models')),
        '云开发 AI 不走 OpenAI 兼容端点，不该再有 /models 请求'
      )
      eq(res.modelList.ok, true)
      deepEq(res.modelList.models, [TIERS.fast.model, TIERS.standard.model, TIERS.reason.model])
      eq(res.modelList.tiers.length, 3, '每档的 tier / model / memberOnly 都要回报（这就是「换档」的对照表）')
      eq(res.models, null, '没要求逐档就不探（两个开关互不牵连）')
    } finally {
      delete process.env.AI_PROXY_TEST_TOKEN
    }
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

/** 桩里的响应体可能直接是 JSON 字符串（假 https 分支已 parse 过，这里补一次） */
function safeJson(raw) {
  try {
    return JSON.parse(raw)
  } catch (e) {
    return {}
  }
}

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
  /*
   * 云开发 AI 通道（2026-10-11 起大模型不再走 https，改走 wx-server-sdk 的 cloud.ai）：
   * 与检索用的假 https **共用同一个响应队列** —— 两边都按调用顺序 shift()，所以预置数组的顺序
   * 就是真实调用顺序（现有用例本来就是按真实顺序排的）。请求体也照进 calls（path 标 'cloud.ai'），
   * 于是 calls[i].body.model 这类断言逐字可用。响应形状与 https 分支共用同一套 chatOk / 空正文桩：
   * 这里从 data.choices[0].message 读正文与 reasoning_content、从 choice 读 finish_reason。
   *
   * 非 2xx（或 body 里带 error）一律抛错 —— 与真实 SDK 行为一致（它把非 2xx 包成异常），
   * 由 aiProxy 的 classifyAiError 按 err.status 归类；message 里带上状态码与上游原话，
   * 好让「402 Insufficient Balance」这类断言仍能读到关键信息。
   */
  const finish = (payload) => {
    calls.push({ path: 'cloud.ai', body: payload, modelGroup: payload && payload.__modelGroup })
    const r = responses.length ? responses.shift() : { status: 200, data: {} }
    const body = typeof r.data === 'string' ? safeJson(r.data) : r.data
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
    const content = typeof message.content === 'string' ? message.content : ''
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : ''
    return { content, reasoning, finishReason }
  }
  const ai = () => ({
    createModel: (modelGroup) => ({
      async streamText(payload) {
        const payloadWithGroup = Object.assign({}, payload, { __modelGroup: modelGroup })
        const { content, reasoning, finishReason } = finish(payloadWithGroup)
        return {
          textStream: (async function* () {
            if (content) yield content
          })(),
          dataStream: (async function* () {
            yield {
              choices: [
                {
                  delta: Object.assign(
                    {},
                    content ? { content } : {},
                    reasoning ? { reasoning_content: reasoning } : {}
                  ),
                  finish_reason: finishReason
                }
              ],
              usage: { total_tokens: 1 }
            }
          })()
        }
      },
      async generateText(payload) {
        const { content } = finish(Object.assign({}, payload, { __modelGroup: modelGroup }))
        return { text: content, usage: { total_tokens: 1 } }
      }
    })
  })
  return { module, calls, ai }
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

/** 清掉一切可能干扰的档位覆写与探针开关，只留检索 key（大模型已统一走云开发 AI，无 key 可配） */
function clearLlmEnv() {
  for (const k of [
    'LLM_TIER',
    'CLOUD_AI_MODEL_FAST',
    'CLOUD_AI_MODEL_STANDARD',
    'CLOUD_AI_MODEL_REASON',
    'AI_PROXY_TEST_TOKEN',
    cfg.QUOTA_GUARD_ENV
  ]) {
    delete process.env[k]
  }
  process.env.BOCHA_API_KEY = 'bocha-test'
}

/** 加载 aiProxy 源码：wx-server-sdk → harness 内存 DB（含云开发 AI 假实现），https → 假上游 */
function loadProxy({ openid = 'u1', https } = {}) {
  env.resetAll()
  clearLlmEnv()
  const db = env.db.database()
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    /* cloud.ai 是函数（2026-10-11 改造）：大模型调用全部走这条，假的实现在 fakeHttps 里 */
    ai: () => https.ai(),
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
  tier: 'fast',
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

    const res = await chat(fn, { tier: 'standard' })

    eq(res.ok, true, '降级而不是报错：不因一次残留偏好打断生成')
    eq(res.downgraded, true)
    eq(res.model, TIERS.fast.model)
    eq(calls.length, 1)
    eq(calls[0].body.model, TIERS.fast.model, '代价最高的那一档不能被白用')
  })

  it('memberships 里有未过期的会员：档位放行', async () => {
    const h = fakeHttps([chatOk()])
    const { fn, calls } = loadProxy({ https: h })
    env.db.__seed('memberships', [memberRow()])

    const res = await chat(fn, { tier: 'standard' })

    eq(res.ok, true)
    eq(res.downgraded, false)
    eq(res.model, TIERS.standard.model)
    eq(calls[0].body.model, TIERS.standard.model)
  })

  it('memberships 过期的会员：按非会员降级', async () => {
    const h = fakeHttps([chatOk()])
    const { fn } = loadProxy({ https: h })
    env.db.__seed('memberships', [memberRow({ expires_at: new Date(Date.now() - DAY_MS).toISOString() })])

    const res = await chat(fn, { tier: 'standard' })

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

    const res = await chat(fn, { tier: 'standard' })

    eq(res.downgraded, true, '若这里是 false，说明云端又回去读端上可写的镜像了')
    eq(res.model, TIERS.fast.model)
  })

  it('端上传来的会员标记一律不作数（改包者最容易走的一步）', async () => {
    /*
     * 端上读的是 users.membership 镜像行（改包者能改自己那一行），云端读 memberships
     * 权威表 ⇒ 判为非会员 ⇒ 降级。这时候最顺手的"修法"就是让云端认端上传来的会员标记
     * —— 那等于把计费闸门交给端上（小程序包可解包改掉），与「权威在云端」互斥。
     * 这条用例把正确的那一半钉死：不管端上用哪个字段名自称会员，云端都不看。
     * （这也正是本地联调唯一会踩的坑：端上按会员显示、云端按免费算，见 local.example.ts。）
     */
    const h = fakeHttps([chatOk()])
    const { fn } = loadProxy({ https: h })

    const res = await chat(fn, {
      tier: 'standard',
      member: true,
      isMember: true,
      memberOverride: 'monthly',
      debugMember: true
    })

    eq(res.downgraded, true, '只有 memberships 里有未过期行才算会员')
    eq(res.model, TIERS.fast.model)
  })

  it('档位表里的每一档各走一遍：会员放行，非会员降级到免费档', async () => {
    /*
     * 只测标准档会漏掉两类漂移，而它们都要用户切过去才暴露：
     *   · 云端某档漏配 memberOnly ⇒ 那一档对所有人免费开放（唯一会白花钱的方向）；
     *   · 免费档自己标了 memberOnly ⇒ 降级落到一个会员档上，非会员每次请求都失败。
     * 故驱动源取**端上档位清单**（用户真能切到的那些档），并顺带核对两端 memberOnly 同值。
     */
    const cloud = require(LLM_CONFIG).TIERS
    const listed = env.load('config/public').publicConfig.llm.models
    ok(listed.length > 1, '端上应列出多档，否则本用例覆盖不到「切档」这一半')

    for (const t of listed) {
      const conf = cloud[t.tier]
      ok(conf, `端上列了 ${t.tier}，云函数档位表里却没有它 —— 用户切过去会落到默认档去`)
      eq(conf.memberOnly, t.memberOnly, `${t.tier}：端上与云端的会员闸门口径必须同值`)
      ok(conf.model, `${t.tier} 缺 model：云端不知道这一档该发哪个模型名`)

      /* ① 会员：请求哪一档就发哪一档 —— 「切换档位」真正生效的那一半 */
      const paidProxy = loadProxy({ https: fakeHttps([chatOk()]) })
      env.db.__seed('memberships', [memberRow()])
      const paidRes = await chat(paidProxy.fn, { tier: t.tier })

      eq(paidRes.downgraded, false, `${t.tier} 的会员档对会员必须放行（显示哪档 = 实际用哪档）`)
      eq(paidRes.model, conf.model, `${t.tier}：回执里的模型名要是这一档配的`)
      eq(paidProxy.calls[0].body.model, conf.model, `${t.tier}：发给上游的也要是这一档`)

      /* ② 非会员：免费档自己必须放行；会员档必须降级回落 fast 档 */
      const freeProxy = loadProxy({ https: fakeHttps([chatOk()]) })
      const freeRes = await chat(freeProxy.fn, { tier: t.tier })

      eq(freeRes.downgraded, !!conf.memberOnly, `${t.tier}：非会员请求会员档才降级，免费档不该降级`)
      eq(freeRes.model, t.memberOnly ? TIERS.fast.model : conf.model, '非会员只能落到免费档')
      eq(freeProxy.calls[0].body.model, freeRes.model, '代价最高的那一档不能被白用')
    }
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

/*
 * 云端报文打印（AI_PROXY_RAW_LOG，2026-10-10 补）。
 *
 * 它补的是端上看不到的那一半：端上 debugRaw 只能看到**云函数的返回**，「上游到底回了什么」
 * 看不到。而这两条日志在**云开发控制台 → 云函数 → 日志**里，不在微信开发者工具的 Console
 * （用户报「控制台没打印大模型日志」时，缺的正是这一半）。
 * 钉住三条语义：默认关闭（线上不该持续吐日志）、只认 'on'（拼错不能静默打开）、
 * 打开后**不打正文**（日志有大小上限，几万字灌进去会挤掉同一次调用的计费日志）。
 */
describe('aiProxy 云端报文打印（AI_PROXY_RAW_LOG）', () => {
  /** 抓 console.log 的输出（只在这一组用例里替换，finally 必定还原） */
  const capture = async (work) => {
    const lines = []
    const orig = console.log
    console.log = (...args) => lines.push(args.map(String).join(' '))
    try {
      await work()
    } finally {
      console.log = orig
    }
    return lines
  }

  /** 闸门会影响 chat 能否触达上游，这里只为让日志用例走到上游，与打印本身无关 */
  const withGuardOff = (work) => {
    process.env.AI_PROXY_QUOTA_GUARD = 'off'
    return Promise.resolve(work()).finally(() => {
      delete process.env.AI_PROXY_QUOTA_GUARD
    })
  }

  const rawLines = (lines) => lines.filter((l) => l.includes('[raw:'))

  it('默认关闭：不配置时一条都不打（线上不该持续吐日志）', async () => {
    const h = fakeHttps([chatOk()])
    const { fn } = loadProxy({ https: h })

    const lines = await withGuardOff(() => capture(() => chat(fn)))

    eq(rawLines(lines).length, 0)
  })

  it("只认 'on'：写成别的值一律不打（拼错不能让日志静默打开）", async () => {
    process.env.AI_PROXY_RAW_LOG = 'true'
    try {
      const h = fakeHttps([chatOk()])
      const { fn } = loadProxy({ https: h })

      const lines = await withGuardOff(() => capture(() => chat(fn)))

      eq(rawLines(lines).length, 0)
    } finally {
      delete process.env.AI_PROXY_RAW_LOG
    }
  })

  it('会员档被降级时同时报「请求的」与「实际用的」（档位没生效的唯一线索）', async () => {
    /*
     * 本机反馈：「切到深度推理，发出去的还是极速版的模型」—— 看不出为什么。
     * 根因是 handleChat 的会员闸门：端上按 users.membership 镜像放行，而云端读 memberships
     * 权威表 ⇒ 判为非会员 ⇒ model 换成兜底的 fast 档。
     * 只打最终 model 的话，这条日志反而让人以为「档位切换没接上」，故三个字段必须一起报。
     */
    process.env.AI_PROXY_RAW_LOG = 'on'
    try {
      const h = fakeHttps([chatOk('正文')])
      const { fn } = loadProxy({ https: h })

      const lines = await withGuardOff(() =>
        capture(() =>
          fn.main({
            action: 'chat',
            tier: 'reason',
            messages: [{ role: 'user', content: 'hi' }]
          })
        )
      )

      const req = rawLines(lines).find((l) => l.includes('[raw:chat:req]'))
      ok(req, '要有请求日志')
      ok(req.includes(`"requested":"${TIERS.reason.model}"`), `要报出端上要的那一档：${req}`)
      ok(req.includes('"downgraded":true'), `要报出发生了降级：${req}`)
    } finally {
      delete process.env.AI_PROXY_RAW_LOG
    }
  })

  it('on：请求与上游返回各一条，且都不含正文（日志有大小上限）', async () => {
    process.env.AI_PROXY_RAW_LOG = 'on'
    try {
      const h = fakeHttps([chatOk('这是一段很长的模型正文')])
      const { fn } = loadProxy({ https: h })

      const lines = await withGuardOff(() => capture(() => chat(fn)))

      const req = rawLines(lines).find((l) => l.includes('[raw:chat:req]'))
      ok(req, '请求侧要有一条：否则看不出这次用的是哪个模型 / 走在哪个额度池')
      ok(req.includes('"model"'), `要报出模型：${req}`)
      ok(!req.includes('这是一段很长的模型正文'), '请求侧不打正文')

      const up = rawLines(lines).find((l) => l.includes('[raw:chat:upstream]'))
      ok(up, '上游返回侧要有一条 —— 这正是端上永远看不到的那一半')
      ok(up.includes('finishReason'), `要报 finish_reason：输出被截断只能靠它认：${up}`)
      ok(!up.includes('这是一段很长的模型正文'), '返回侧只报长度，不打正文')
    } finally {
      delete process.env.AI_PROXY_RAW_LOG
    }
  })

  it('推理模型把上限吃光：正文 0 字 + reasoningChars 上千 —— 这是「空正文」的唯一铁证', async () => {
    /*
     * 真机现场：报错里只有一句「大模型返回结构异常」，附带片段又被 SNIPPET=200 截在
     * `"reasoning_conten` 处 —— JSON 的头 200 字全是 id / created / model 这些与故障无关的字段，
     * 真正有用的 finish_reason 与 reasoning_content 都在 200 字之后，恰好被截掉。
     * 故云端日志必须把这一对数字直接摆出来：**正文 0 字而思考上千字**，一眼就是
     * 「推理把 max_tokens 吃光了」，不必再去猜是不是上游抖动。
     */
    process.env.AI_PROXY_RAW_LOG = 'on'
    try {
      const h = fakeHttps([
        {
          status: 200,
          data: {
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '', reasoning_content: '想'.repeat(1200) },
                finish_reason: 'length'
              }
            ]
          }
        }
      ])
      const { fn } = loadProxy({ https: h })

      const lines = await withGuardOff(() => capture(() => chat(fn)))

      const up = rawLines(lines).find((l) => l.includes('[raw:chat:upstream]'))
      ok(up, '要有上游返回那条日志')
      ok(up.includes('"chars":0'), `正文是 0 字：${up}`)
      ok(up.includes('"reasoningChars":1200'), `要报出思考字数（旧版没有这一项，只见正文 0 字）：${up}`)
      ok(up.includes('"finishReason":"length"'), `要报出截断：${up}`)
    } finally {
      delete process.env.AI_PROXY_RAW_LOG
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

describe('aiProxy 第二检索源（博查抓空时的兜底，2026-10-10）', () => {
  /**
   * Serper 的成功响应：`organic[]`，字段名与博查**完全不同**（title/link/snippet），
   * 由适配器翻成 name/url/snippet —— 下面几条「兜底源有内容」的样本都用它。
   */
  const serperOk = (n = 1) => ({
    status: 200,
    data: {
      organic: Array.from({ length: n }, (_, i) => ({
        title: `谷歌结果 ${i}`,
        link: `https://serp.example.com/${i}`,
        snippet: '兜底源摘要',
        date: '2026-10-01'
      }))
    }
  })

  it('博查抓到空内容 → 用 Serper 补，并在返回里标注 source', async () => {
    process.env.SERPER_API_KEY = 'test-serper'
    try {
      const h = fakeHttps([searchOk(0), serperOk(2)])
      const { fn, calls } = loadProxy({ https: h })

      const res = await fn.main({ action: 'search', query: '甲', count: 10 })

      eq(res.ok, true)
      eq(res.source, 'serper', '一眼看出这条结果是兜底源捞的')
      eq(res.pages.length, 2)
      eq(calls.length, 2, '主源空了才问第二家')
      /* fakeHttps 记的是 options.path（不含域名）：博查可按路径认，两家兜底源之间不行 */
      ok(String(calls[0].path).includes('/v1/web-search'), `第一家打的是博查：${calls[0].path}`)
      eq(calls[1].body.gl, 'cn', '第二家是 Serper')
      eq(calls[1].body.tbs, 'qdr:m', '博查的 oneMonth 要翻成 Google 的 qdr:m')
      eq(calls[0].body.query, '甲', '主源请求体仍是博查那套（不改既有行为）')
    } finally {
      delete process.env.SERPER_API_KEY
    }
  })

  it('博查有内容 → 不惊动第二家（不白花一次调用）', async () => {
    process.env.SERPER_API_KEY = 'test-serper'
    try {
      const h = fakeHttps([searchOk(3)])
      const { fn, calls } = loadProxy({ https: h })

      const res = await fn.main({ action: 'search', query: '甲', count: 10 })

      eq(res.ok, true)
      eq(res.source, undefined, '主源命中时不该有兜底标记')
      eq(calls.length, 1, '只问一家')
    } finally {
      delete process.env.SERPER_API_KEY
    }
  })

  it('两家兜底 key 都没配 → 只用博查，行为与改造前完全一致', async () => {
    const h = fakeHttps([searchOk(0)])
    const { fn, calls } = loadProxy({ https: h })

    const res = await fn.main({ action: 'search', query: '甲', count: 10 })

    eq(res.ok, true, '主源成功但空，仍返回 ok')
    eq(res.pages.length, 0, '空数组 —— 端上据此判 nonews')
    eq(calls.length, 1, '兜底是可选的，没配就不发')
  })

  it('两家都空 → 交回主源的空结果（端上判 nonews，而不是被兜底搅成 coldstart）', async () => {
    process.env.SERPER_API_KEY = 'test-serper'
    try {
      const h = fakeHttps([searchOk(0), serperOk(0)])
      const { fn, calls } = loadProxy({ https: h })

      const res = await fn.main({ action: 'search', query: '甲', count: 10 })

      eq(res.ok, true, 'ok:true + 空数组 = 「抓到了但没内容」')
      eq(res.pages.length, 0)
      eq(res.kind, undefined, '不能变成错误分支，否则端上会走 coldstart 而不是 nonews')
      eq(calls.length, 2)
    } finally {
      delete process.env.SERPER_API_KEY
    }
  })

  /* ---------- 适配器与探测顺序（2026-10-10 追加） ---------- */

  it('配了 Serper 就用 Serper，并把 organic 翻译成博查字段名', async () => {
    process.env.SERPER_API_KEY = 'test-serper'
    try {
      const h = fakeHttps([
        searchOk(0),
        {
          status: 200,
          data: {
            organic: [
              { title: '谷歌标题', link: 'https://serp.example.com/1', snippet: '摘要', date: '2026-10-01' }
            ]
          }
        }
      ])
      const { fn, calls } = loadProxy({ https: h })

      const res = await fn.main({ action: 'search', query: '乙', count: 10 })

      eq(res.ok, true)
      eq(res.source, 'serper', 'source 要说清是哪一家捞的')
      eq(res.pages.length, 1)
      /* 字段名必须翻译成博查那套：端上 toNewsItem 与报告层的出处白名单按 name/url/snippet 认 */
      eq(res.pages[0].name, '谷歌标题', 'title → name')
      eq(res.pages[0].url, 'https://serp.example.com/1', 'link → url')
      eq(res.pages[0].snippet, '摘要')
      eq(res.pages[0].datePublished, '2026-10-01', 'date → datePublished')
      /*
       * 认源靠 body 特征而不是 path：fakeHttps 只记 options.path（不含域名），
       * 而 Serper 与 Tavily 的路径**都是 /search**（只有博查是 /v1/web-search），
       * 故两家之间只能靠请求体区分。
       */
      eq(calls[1].body.gl, 'cn', '打的是 Serper')
      eq(calls[1].body.q, '乙')
      eq(calls[1].body.tbs, 'qdr:m', 'oneMonth 要翻成 Google 的 qdr:m')
      eq(calls[1].body.hl, 'zh-cn')
    } finally {
      delete process.env.SERPER_API_KEY
    }
  })

  it('同时配了 Serper 与 Tavily 时用 Serper（表的顺序即推荐度）', async () => {
    process.env.SERPER_API_KEY = 'test-serper'
    process.env.TAVILY_API_KEY = 'test-tavily'
    try {
      const h = fakeHttps([
        searchOk(0),
        {
          status: 200,
          data: { organic: [{ title: 't', link: 'https://s.example.com/1', snippet: 's' }] }
        }
      ])
      const { fn, calls } = loadProxy({ https: h })

      const res = await fn.main({ action: 'search', query: '丙', count: 10 })

      eq(res.source, 'serper')
      eq(calls.length, 2, '只问了主源与 Serper，没有再去问 Tavily')
      eq(calls[1].body.gl, 'cn', '第二家是 Serper（按 body 特征认源）')
      eq(calls[1].body.api_key, undefined, '不是 Tavily：Tavily 的 key 在 body 里')
    } finally {
      delete process.env.SERPER_API_KEY
      delete process.env.TAVILY_API_KEY
    }
  })

  it('只配了 Tavily 时走 Tavily，并取其已清洗正文当摘要', async () => {
    process.env.TAVILY_API_KEY = 'test-tavily'
    try {
      const h = fakeHttps([
        searchOk(0),
        {
          status: 200,
          data: {
            results: [
              {
                title: '塔维标题',
                url: 'https://tav.example.com/1',
                content: '一整段正文',
                published_date: '2026-09-20'
              }
            ]
          }
        }
      ])
      const { fn, calls } = loadProxy({ https: h })

      const res = await fn.main({ action: 'search', query: '丁', count: 10 })

      eq(res.ok, true)
      eq(res.source, 'tavily')
      eq(res.pages[0].name, '塔维标题')
      eq(res.pages[0].url, 'https://tav.example.com/1')
      /* content 是清洗过的正文，与博查的 summary 同性质 —— 原样带回，交给端上的 maxItemChars 裁 */
      eq(res.pages[0].snippet, '一整段正文')
      eq(calls[1].body.api_key, 'test-tavily', '打的是 Tavily：它的 key 放 body 里，不是 header')
      eq(calls[1].body.search_depth, 'basic')
    } finally {
      delete process.env.TAVILY_API_KEY
    }
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

  it('test 探针：配了兜底源就报出它的连通性与耗时（境外源唯一的验证入口）', async () => {
    const h = fakeHttps([
      searchOk(3),
      chatOk('正常'),
      { status: 200, data: { organic: [{ title: 't', link: 'https://s.example.com/1', snippet: 's' }] } }
    ])
    const { fn, calls } = loadProxy({ https: h })

    /*
     * ⚠ 环境变量必须设在 `loadProxy` **之后**：它会清一遍环境里可能干扰的覆写（本文件
     * 顶部的 clearLlmEnv），设早了会被清掉，表现为探针一口回绝「需要口令」（已踩过）。
     */
    process.env.AI_PROXY_TEST_TOKEN = 'secret'
    process.env.SERPER_API_KEY = 'test-serper'
    try {
      const res = await fn.main({ action: 'test', token: 'secret' })

      eq(res.ok, true, '兜底源不参与 ok 判定：它本就是可选的增强项')
      eq(calls.length, 3, '博查 + 大模型 + 兜底源各一次')
      eq(res.backup.provider, 'serper', '要报出探的是哪一家')
      eq(res.backup.ok, true)
      /*
       * 耗时是这条探针的主要产出：两家兜底源都在境外，从腾讯云（境内）调用要绕国际出口 ——
       * 正常值与超时值差两个数量级，没有这个数就分不出是「慢」还是「不通」。
       */
      ok(/耗时 \d+ms/.test(res.backup.detail), `必须带耗时：${res.backup.detail}`)
    } finally {
      delete process.env.AI_PROXY_TEST_TOKEN
      delete process.env.SERPER_API_KEY
    }
  })

  it('test 探针：没配兜底源也不报错（可选增强项，不该让探针变红）', async () => {
    const h = fakeHttps([searchOk(3), chatOk('正常')])
    const { fn, calls } = loadProxy({ https: h })

    process.env.AI_PROXY_TEST_TOKEN = 'secret'
    /* 显式清掉，免得开发机自己配过这两家时「没配」这条用例失效 */
    delete process.env.SERPER_API_KEY
    delete process.env.TAVILY_API_KEY
    try {
      const res = await fn.main({ action: 'test', token: 'secret' })

      eq(res.ok, true, '平台本身是好的，只是没开兜底')
      eq(calls.length, 2, '没配就不发第三次请求')
      eq(res.backup.configured, false)
      eq(res.backup.ok, false)
      ok(/未配置/.test(res.backup.detail), `要说明这是可选项而不是故障：${res.backup.detail}`)
    } finally {
      delete process.env.AI_PROXY_TEST_TOKEN
    }
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

/* ==================== ②c  空正文的分流（2026-10-10） ==================== */

/**
 * 空正文**不等于**「上游抖了」。
 *
 * 推理型模型（DeepSeek reasoner 一类）会先把整份 max_tokens 预算花在 reasoning_content 上；
 * 预算在「思考」阶段就被吃光时，正文一个字都没轮到 —— 上游**仍返回 HTTP 200**，content 是
 * 空串、finish_reason='length'，响应前半段看着完全正常。
 *
 * 旧代码在这里一律回 kind='upstream'，而端上 RETRYABLE_KINDS 含 'upstream' ⇒ 原样重发同一
 * 请求（报告一次 30~40s，真金白银），**必然再次撞上同一道上限**：一次失败被放大成两轮长生成。
 * 端上对「撞上限」早已有专门的收手口径（llm.ts#truncatedFail 的 'truncated'），云端照同一口径报
 * 即可 —— 这几条钉的就是「两端用的是同一个词」。
 */
describe('上游返回空正文：确定性截断不得当成可重试抖动（2026-10-10）', () => {
  /** 推理模型的典型空壳响应：正文空、思考有内容、finish_reason='length' */
  const reasoningEmpty = (reasoning) => ({
    status: 200,
    data: {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', reasoning_content: reasoning },
          finish_reason: 'length'
        }
      ]
    }
  })

  it('正文空 + length + 有思考：kind=truncated，且文案点明凶手与改法', async () => {
    const h = fakeHttps([reasoningEmpty('想'.repeat(500))])
    const { fn, calls } = loadProxy({ https: h })

    const res = await chat(fn)

    eq(res.ok, false)
    eq(
      res.kind,
      'truncated',
      "必须是端上已经认识的那个词（llm.ts#truncatedFail）—— 写成 'upstream' 就会白重试一轮长生成"
    )
    eq(res.finishReason, 'length', '上游给的截断信号要原样带给端上')
    ok(/推理/.test(res.error), `要点出是推理模型的思考吃光了上限：${res.error}`)
    ok(/思考了 500 字/.test(res.error), `要报出思考字数（正文 0 字而思考 500 字）：${res.error}`)
    ok(res.error.includes('chatMaxTokens'), `要给出可照做的改法：${res.error}`)
    ok(
      /max_tokens=\d+/.test(res.error),
      `上限要插值成真实数字（写成 max_tokens=undefined 等于把线索又丢了一次）：${res.error}`
    )
    eq(calls.length, 1, '云端本身只发一次；不许在这里自作主张重发')
  })

  it('非推理模型被截断（正文空、无 reasoning）：同样 truncated，但不硬说成推理的锅', async () => {
    const h = fakeHttps([
      {
        status: 200,
        data: {
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }]
        }
      }
    ])
    const { fn } = loadProxy({ https: h })

    const res = await chat(fn)

    eq(res.kind, 'truncated', '撞上限就是撞上限，与是不是推理模型无关')
    ok(/max_tokens=\d+/.test(res.error), `要说清是撞了输出上限（且上限值插值正确）：${res.error}`)
    notOk(/推理/.test(res.error), '没有 reasoning_content 时不该硬说成推理模型的锅')
  })

  it('正文空但没给 finish_reason：仍是可重试的 upstream，但必须把这个字段报出来', async () => {
    const h = fakeHttps([
      { status: 200, data: { choices: [{ index: 0, message: { role: 'assistant', content: '' } }] } }
    ])
    const { fn } = loadProxy({ https: h })

    const res = await chat(fn)

    eq(
      res.kind,
      'upstream',
      '没有截断证据时不能一口咬定是确定性失败 —— 上游偶发给了个空壳，换一次采样可能就好了'
    )
    ok(res.error.includes('finish_reason'), `文案要带上这个字段，否则现场等于没有线索：${res.error}`)
    notOk(
      res.error.includes('结构异常'),
      `「结构异常」看不出所以然，改报「空正文 + finish_reason」：${res.error}`
    )
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
  env.setDebugFlags({ disableGenerateQuota: false, disableAskQuota: false })
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

  it('chatText 上游 200 但正文为空：判可重试（进而进问答冷却），不得当成「成功」', async () => {
    const load = freshClient()
    env.registerCloudFn('aiProxy', () => ({ ok: true, content: '' }))
    const { chatText } = load('utils/llm')

    const res = await chatText('S', 'U', 'ask')

    eq(res.ok, false, '空正文不是有效回答')
    eq(res.kind, 'empty')
    eq(res.retryable, true, '同一趟上游故障若判「不可重试」，qa.ts 就不进 10 分钟冷却，用户可被无限重打')
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

  /* ---------- 无素材兜底（C，2026-10-10）：所有检索源都没抓到内容时的最后一道 ---------- */

  it('无素材兜底：交回带 knowledgeOnly 的报告，且只给简介、画像为零', async () => {
    const load = freshClient()
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action !== 'chat') return { ok: false }
      return { ok: true, content: JSON.stringify({ intro: '张三，演员，代表作《甲》。' }) }
    })
    const { buildKnowledgeFallback, reportShortfall, reportShortfallRetryable } = load('utils/report')

    const res = await buildKnowledgeFallback('张三#ent', '张三')

    eq(res.ok, true)
    eq(res.data.knowledgeOnly, true, '必须带这个标记：页面据此说明来源')
    ok(res.data.intro.includes('代表作'))
    eq(res.data.dynamics.length, 0, '不许有动态：模型知识给不出时效性内容')
    eq(res.data.quotes.length, 0)
    eq(res.data.analysis, '', '点评要基于素材，这里也不能有')
    eq(res.data.coverage.items, 0, '素材一条都没有，画像必须是零')

    /* 判定：它「有内容」但不「合格」—— 不达标 + 不可重试（检索侧已试完全部源与档位） */
    const verdict = reportShortfall(res.data, false)
    ok(verdict, '没有素材支撑，不该当合格报告收下')
    ok(String(verdict).includes('未经核实'), `文案要说清来源：${verdict}`)
    eq(reportShortfallRetryable(res.data), false, '劝重试就是让用户白等一场')
  })

  it('无素材兜底：模型对该人物没把握（intro 为空）时交回失败，不留空壳报告', async () => {
    const load = freshClient()
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action !== 'chat') return { ok: false }
      return { ok: true, content: JSON.stringify({ intro: '' }) }
    })
    const { buildKnowledgeFallback } = load('utils/report')

    const res = await buildKnowledgeFallback('冷门甲#tech', '冷门甲')

    eq(res.ok, false, '一份空壳报告比「查不到」更糟：用户会以为这就是全部内容')
    eq(res.retryable, false)
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

  /*
   * 2026-10-10：刷新上限按档位分叉。**同一个 count=11** —— 免费档拦下、会员档放行 ——
   * 这样才证明判定真的读了 memberships，而不是把上限当成一个常量。
   */
  it('P2-30：refresh 上限按档位分叉（免费 10 拦下 count=11，会员 20 放行）', async () => {
    const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    const seedCount = (count) =>
      env.db.__seed('refresh_quota', [{ _id: `u1#${date}`, _openid: 'u1', count }])

    const free = loadGuard()
    seedCount(11)
    const blocked = await free.main({ kind: 'refresh', action: 'consume' })
    eq(blocked.limit, 10, '免费档上限 10')
    eq(blocked.allowed, false, '免费档 count=11 已越界')

    const member = loadGuard()
    /* 会员身份读 memberships（服务端权威），与 aiProxy 那批用例同一手法 */
    env.db.__seed('memberships', [memberRow()])
    seedCount(11)
    const passed = await member.main({ kind: 'refresh', action: 'consume' })
    eq(passed.limit, 20, '会员档上限 20')
    eq(passed.allowed, true, '同一个 count=11，会员档放行 —— 判定确实读了身份')

    const over = loadGuard()
    env.db.__seed('memberships', [memberRow()])
    seedCount(21)
    const peeked = await over.main({ kind: 'refresh', action: 'peek' })
    eq(peeked.limit, 20)
    eq(peeked.allowed, false, '会员档到 21 才越界（peek 不自增）')
    eq(peeked.count, 21)
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
    /* 云开发 AI：hotBoardRefresh 生成热榜解读走这条（见 fakeHttps 里的 ai 假实现） */
    ai: () => https.ai(),
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

describe('模型档位：三处口径不许漂（端上清单 / 云函数档位表 / 部署变量）', () => {
  /*
   * 「用户切了档位，云端到底用哪一档」由两份东西共同决定，而它们全是**手工同步**的：
   *   ① src/config/public.ts                     —— 用户看得到、点得到的档位清单（我的 → 生成档位）
   *   ② {aiProxy,hotBoardRefresh}/llm.config.js  —— 云端裁决表（memberOnly 就是计费闸门）
   * 任何一处漂了都不会报错，只会变成「切了没效果」（端上放行 / 云端不认，或认不出那一档）
   * 或「白送贵档」（云端漏标 memberOnly = 对所有人开放）。2026-10-11 起还多守一条：
   * **部署文件里不该再出现任何厂商 key** —— 换成云开发 AI 后 key 由云开发环境承担，
   * 出现旧 key 说明还有人在用直连形态。这些都是本地一次 `npm test` 就能验的，
   * 不必等真机、真云、真会员。
   */
  const HOT_LLM = path.join(CLOUD, 'hotBoardRefresh', 'llm.config.js')

  it('两份 llm.config.js 逐字一致（aiProxy 与 hotBoardRefresh 各存一份手抄副本）', () => {
    eq(
      read(LLM_CONFIG),
      read(HOT_LLM),
      '两份漂了 = 热榜定时任务与在线生成用上不同的档位；cron 没有重试放大，只会静默走错'
    )
  })

  it('端上每一档，云端档位表里都认得出来（认得出来，计费闸门才拦得住）', () => {
    env.resetAll()
    const tiers = env.load('config/public').publicConfig.llm.models
    const cloud = require(LLM_CONFIG).TIERS
    ok(
      Array.isArray(tiers) && tiers.length > 1,
      `端上清单读不到（拿到的是 ${JSON.stringify(tiers)}），先确认 publicConfig.llm.models 的结构`
    )

    for (const t of tiers) {
      const conf = cloud[t.tier]
      ok(conf, `端上有 ${t.tier}，云端表里却没有它 —— 用户切过去会落到默认档去`)
      eq(conf.memberOnly, t.memberOnly, `${t.tier}：端上与云端的会员闸门口径必须同值（云端那份才是闸门）`)
      ok(conf.model, `${t.tier}：云端这一档没有模型名，生成时发不出请求`)
    }
    /* 兜底档必须是免费档：非会员每次请求都落它，标成会员档会让非会员「一片都降级」 */
    eq(cloud.fast.memberOnly, false, 'fast 是兜底档，不能算会员档')
    eq(
      require(LLM_CONFIG).DEFAULT_TIER,
      env.load('config/public').publicConfig.llm.tier,
      '端上默认档要与云端 DEFAULT_TIER 同值（端上没带档位时云端按它兜底）'
    )
  })

  it('cloudbaserc.json 不再注入任何厂商 key（换成云开发 AI 后 key 由云开发环境承担）', () => {
    const rc = JSON.parse(read(path.join(ROOT, 'cloudbaserc.json')))
    for (const name of ['aiProxy', 'hotBoardRefresh']) {
      const fn = (rc.functions || []).filter((f) => f.name === name)[0]
      ok(fn, `cloudbaserc.json 里找不到 ${name}`)
      const vars = fn.envVariables || {}
      for (const k of ['QWEN_API_KEY', 'ZHIPU_API_KEY', 'OPENAI_API_KEY', 'LLM_PROVIDER']) {
        notOk(k in vars, `${name} 不该再有 ${k}：大模型已统一走云开发 AI，key 由云开发环境承担`)
      }
    }
    /* 检索 key 仍在（那部分没改） */
    const ai = (rc.functions || []).filter((f) => f.name === 'aiProxy')[0]
    ok((ai.envVariables || {}).BOCHA_API_KEY, '检索 key 照旧从部署环境注入')
  })
})
