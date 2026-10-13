'use strict'

/**
 * 外部厂商直连通道（channel='http'，2026-10-12 v3：厂商 × 质量档 × 能力槽）
 *
 * 钉住四件事：
 *   ① resolveLlm 的路由矩阵：5 厂 × 3 档（basic/standard/premium）× 2 能力槽
 *      （structured=报告/辅助、reasoning=问答），含同厂向下降档与 LLM_MODEL_* 覆盖；
 *   ② handleChat 真跑：http 槽位的请求确实走 https POST /chat/completions（不碰 cloud.ai），
 *      报文是 OpenAI 协议：双模模型靠 extraBody 的思考开关占两个槽，思考时不下发 temperature；
 *   ③ 缺 key / 未知厂商 → kind='config'，不重试、不产生任何上游调用（花不着钱）；
 *   ④ 非会员请求标准/高级档时**同厂商**降回基础版（绝不能偷偷换回云开发 AI）。
 * 假上游与 07 同构：https 与 cloud.ai 共用一个响应队列，按调用顺序 shift。
 */

const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, ok, eq, notOk } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const AI_PROXY = path.join(ROOT, 'cloudfunctions', 'aiProxy', 'index.js')
const LLM_CONFIG = path.join(ROOT, 'cloudfunctions', 'aiProxy', 'llm.config.js')

const VENDOR_ENV = [
  'LLM_VENDOR',
  'LLM_TIER',
  'LLM_HTTP_ENDPOINT_DEEPSEEK',
  'LLM_HTTP_ENDPOINT_ZHIPU',
  'LLM_HTTP_ENDPOINT_MOONSHOT',
  'LLM_HTTP_ENDPOINT_ARK',
  'DEEPSEEK_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'DASHSCOPE_API_KEY',
  'ARK_API_KEY'
]
function resetEnv() {
  for (const k of VENDOR_ENV) delete process.env[k]
  /* 槽位模型覆盖是开放式命名（LLM_MODEL_<VENDOR>_<QUALITY>_<CAP>），按前缀清扫 */
  for (const k of Object.keys(process.env)) {
    if (/^LLM_MODEL_/.test(k)) delete process.env[k]
  }
}

/** 与 07 同构的最小假上游：https.request 与 cloud.ai 共用响应队列 */
function fakeUpstream(responses) {
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
          let body = chunks.join('')
          try {
            body = JSON.parse(body)
          } catch (e) {
            /* 保持原样 */
          }
          calls.push({ path: options.path, headers: options.headers || {}, body })
          const r = responses.length ? responses.shift() : { status: 200, data: {} }
          cb({
            statusCode: r.status,
            setEncoding() {},
            on(ev, fn) {
              if (ev === 'data') fn(typeof r.data === 'string' ? r.data : JSON.stringify(r.data))
              if (ev === 'end') fn()
            }
          })
        },
        destroy() {}
      }
      return req
    }
  }
  const ai = () => ({
    createModel: () => ({
      async streamText(payload) {
        calls.push({ path: 'cloud.ai', body: payload })
        const r = responses.length ? responses.shift() : { status: 200, data: {} }
        if (r.status >= 400) throw new Error(`cloud.ai ${r.status}`)
        const ch = (r.data.choices && r.data.choices[0]) || {}
        const content = (ch.message && ch.message.content) || ''
        return {
          textStream: (async function* () {
            if (content) yield content
          })(),
          dataStream: (async function* () {
            yield { choices: [{ delta: { content }, finish_reason: ch.finish_reason || 'stop' }] }
          })()
        }
      }
    })
  })
  return { module, ai, calls }
}

const chatOk = (content = '{"ok":true}') => ({
  status: 200,
  data: { choices: [{ message: { content }, finish_reason: 'stop' }] }
})
const httpError = (status, message) => ({ status, data: { error: { message } } })

function loadProxy(up, openid = 'u1') {
  env.resetAll()
  const db = env.db.database()
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    ai: () => up.ai(),
    getWXContext: () => ({ OPENID: openid })
  }
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fakeSdk
    if (id === 'https') return up.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(AI_PROXY)]
    delete require.cache[require.resolve(LLM_CONFIG)]
    return { fn: require(AI_PROXY), calls: up.calls, db: env.db }
  } finally {
    Module.prototype.require = orig
  }
}

/** 重新加载配置模块（env 改了之后必须清缓存） */
function loadConfig() {
  delete require.cache[require.resolve(LLM_CONFIG)]
  return require(LLM_CONFIG)
}

/** 期望矩阵：[vendor, quality, purpose, model, extraBody 形状]
 *  extraBody：'off' = thinking.disabled，'on' = thinking.enabled，
 *             {reasoning_effort:'low'|'max'} = kimi-k3，null = 不带额外参数 */
const MATRIX = [
  /* 云开发 AI：三档同名（官方模型组），报告 hy3 非思考 / 问答 hy4-preview */
  ['cloudbase', 'basic', 'generate', 'hy3', null],
  ['cloudbase', 'basic', 'ask', 'hy4-preview', null],
  ['cloudbase', 'standard', 'generate', 'hy3', null],
  ['cloudbase', 'standard', 'ask', 'hy4-preview', null],
  ['cloudbase', 'premium', 'generate', 'hy3', null],
  ['cloudbase', 'premium', 'ask', 'hy4-preview', null],
  /* DeepSeek：flash 双模占基础档两槽；标准档报告升 pro、问答留 flash（pro 思考贵）；高级档两槽皆 pro */
  ['deepseek', 'basic', 'generate', 'deepseek-v4-flash', 'off'],
  ['deepseek', 'basic', 'ask', 'deepseek-v4-flash', 'on'],
  ['deepseek', 'standard', 'generate', 'deepseek-v4-pro', 'off'],
  ['deepseek', 'standard', 'ask', 'deepseek-v4-flash', 'on'],
  ['deepseek', 'premium', 'generate', 'deepseek-v4-pro', 'off'],
  ['deepseek', 'premium', 'ask', 'deepseek-v4-pro', 'on'],
  /* 智谱：基础报告免费 flash（无思考参数）；基础问答 glm-4.5-air 开思考；标准 glm-4.7；高级 glm-5.3 */
  ['zhipu', 'basic', 'generate', 'glm-4.7-flash', null],
  ['zhipu', 'basic', 'ask', 'glm-4.5-air', 'on'],
  ['zhipu', 'standard', 'generate', 'glm-4.7', 'off'],
  ['zhipu', 'standard', 'ask', 'glm-4.7', 'on'],
  ['zhipu', 'premium', 'generate', 'glm-5.3', 'off'],
  ['zhipu', 'premium', 'ask', 'glm-5.3', 'on'],
  /* Kimi：基础 k2.6 双模；标准问答升 k3 低强度；高级问答 k3 满强度，高级报告槽缺失→降到标准档 k2.6 */
  ['moonshot', 'basic', 'generate', 'kimi-k2.6', 'off'],
  ['moonshot', 'basic', 'ask', 'kimi-k2.6', 'on'],
  ['moonshot', 'standard', 'generate', 'kimi-k2.6', 'off'],
  ['moonshot', 'standard', 'ask', 'kimi-k3', { reasoning_effort: 'low' }],
  ['moonshot', 'premium', 'generate', 'kimi-k2.6', 'off'],
  ['moonshot', 'premium', 'ask', 'kimi-k3', { reasoning_effort: 'max' }],
  /* 通义千问：三档各一个双模模型（enable_thinking 布尔开关），两槽齐全、不降档 */
  ['qwen', 'basic', 'generate', 'qwen3.5-flash', 'qwen-off'],
  ['qwen', 'basic', 'ask', 'qwen3.5-flash', 'qwen-on'],
  ['qwen', 'standard', 'generate', 'qwen3.7-plus', 'qwen-off'],
  ['qwen', 'standard', 'ask', 'qwen3.7-plus', 'qwen-on'],
  ['qwen', 'premium', 'generate', 'qwen3.8-max', 'qwen-off'],
  ['qwen', 'premium', 'ask', 'qwen3.8-max', 'qwen-on'],
  /* 火山方舟：三档各一个豆包双模模型（thinking.type 开关，与 DeepSeek 同形），两槽齐全、不降档 */
  ['ark', 'basic', 'generate', 'doubao-seed-2-1-lite-260915', 'off'],
  ['ark', 'basic', 'ask', 'doubao-seed-2-1-lite-260915', 'on'],
  ['ark', 'standard', 'generate', 'doubao-seed-2-1-turbo-260628', 'off'],
  ['ark', 'standard', 'ask', 'doubao-seed-2-1-turbo-260628', 'on'],
  ['ark', 'premium', 'generate', 'doubao-seed-2-1-pro-260915', 'off'],
  ['ark', 'premium', 'ask', 'doubao-seed-2-1-pro-260915', 'on']
]
const expectedExtra = (shape) =>
  shape === 'off'
    ? { thinking: { type: 'disabled' } }
    : shape === 'on'
    ? { thinking: { type: 'enabled' } }
    : shape === 'qwen-off'
    ? { enable_thinking: false }
    : shape === 'qwen-on'
    ? { enable_thinking: true }
    : shape

/* ==================== ① resolveLlm 路由（纯配置，不碰网络） ==================== */

describe('23-http-vendor 配置路由', () => {
  it('不配置时零参落 cloudbase/basic 零 key；6×3×2 全矩阵模型名/通道/思考参数逐槽正确', () => {
    resetEnv()
    const cfg = loadConfig()

    const fallback = cfg.resolveLlm()
    eq(fallback.channel, 'cloudai')
    eq(fallback.vendor, 'cloudbase')
    eq(fallback.quality, 'basic')
    eq(fallback.capability, 'structured')
    eq(fallback.apiKeyEnv, null)
    ok(fallback.modelGroup, 'cloudai 槽要有 modelGroup')

    for (const [vendor, quality, purpose, model, extra] of MATRIX) {
      const r = cfg.resolveLlm({ vendor, quality, purpose })
      const tag = `${vendor}/${quality}/${purpose}`
      notOk(r.configError, `${tag} 不该是配置错误：${r.configError || ''}`)
      eq(r.model, model, `${tag} 模型名`)
      eq(r.channel, vendor === 'cloudbase' ? 'cloudai' : 'http', `${tag} 通道`)
      eq(r.capability, purpose === 'ask' ? 'reasoning' : 'structured', `${tag} 能力槽由用途决定`)
      deepExtra(r.extraBody, expectedExtra(extra), tag)
      if (vendor === 'cloudbase') {
        eq(r.apiKeyEnv, null, `${tag} 不该要 key`)
        ok(r.modelGroup, `${tag} 要有 modelGroup`)
      } else {
        ok(/^[A-Z0-9_]+_API_KEY$/.test(r.apiKeyEnv), `${tag} keyEnv 是环境变量名`)
        ok(/^https:\/\//.test(r.endpoint), `${tag} endpoint 是公开 https`)
        eq(r.modelGroup, null)
      }
    }
  })

  it('Kimi 高级档缺结构化槽：同厂商向下降到标准版并标 qualityDowngraded；问答槽不降', () => {
    resetEnv()
    const cfg = loadConfig()

    const report = cfg.resolveLlm({ vendor: 'moonshot', quality: 'premium', purpose: 'generate' })
    eq(report.qualityRequested, 'premium')
    eq(report.quality, 'standard', '只允许沿 premium→standard→basic 向下降')
    eq(report.model, 'kimi-k2.6')
    eq(report.qualityDowngraded, true)
    eq(report.vendor, 'moonshot', '绝不跨厂商')
    eq(report.capability, 'structured', '绝不跨能力槽（报告不能改用推理模型 k3）')

    const ask = cfg.resolveLlm({ vendor: 'moonshot', quality: 'premium', purpose: 'ask' })
    eq(ask.quality, 'premium')
    eq(ask.model, 'kimi-k3')
    eq(ask.qualityDowngraded, false)
  })

  it('连基础档都缺该能力槽：configError 点名缺槽与该配的变量，model=null（fail-closed）', () => {
    resetEnv()
    const cfg = loadConfig()
    /* 直接改注册表内存对象：把 Kimi 三档的 structured 槽全拔空（premium 本来就是 null） */
    const kimi = cfg.VENDORS.moonshot.tiers
    const saved = {
      basic: kimi.basic.structured,
      standard: kimi.standard.structured
    }
    kimi.basic.structured = null
    kimi.standard.structured = null
    try {
      const r = cfg.resolveLlm({ vendor: 'moonshot', quality: 'premium', purpose: 'generate' })
      ok(r.configError, '一槽都不剩时必须报配置错误，而不是瞎发一个模型')
      ok(/结构化输出/.test(r.configError), `要点名缺的是哪种能力：${r.configError}`)
      ok(/moonshot/.test(r.configError), `要点名厂商：${r.configError}`)
      eq(r.model, null)
    } finally {
      kimi.basic.structured = saved.basic
      kimi.standard.structured = saved.standard
    }
  })

  it('LLM_MODEL_* 槽位覆盖与 LLM_HTTP_ENDPOINT_* 端点覆盖（不用改码就能临时换名/接网关）', () => {
    resetEnv()
    process.env.LLM_MODEL_DEEPSEEK_STANDARD_REASONING = 'x-reason-model'
    process.env.LLM_HTTP_ENDPOINT_DEEPSEEK = 'https://gateway.example.test/v1'
    const cfg = loadConfig()
    try {
      const ask = cfg.resolveLlm({ vendor: 'deepseek', quality: 'standard', purpose: 'ask' })
      eq(ask.model, 'x-reason-model', '覆盖只动被点名的那一个槽')
      eq(ask.endpoint, 'https://gateway.example.test/v1')
      /* 别的槽不受影响 */
      eq(cfg.resolveLlm({ vendor: 'deepseek', quality: 'standard', purpose: 'generate' }).model, 'deepseek-v4-pro')
      eq(cfg.resolveLlm({ vendor: 'deepseek', quality: 'basic', purpose: 'ask' }).model, 'deepseek-v4-flash')
    } finally {
      resetEnv()
    }
  })

  it('未知厂商名不静默回落：configError 点名去 VENDORS 注册（否则「我切了厂」无从排查）', () => {
    resetEnv()
    const cfg = loadConfig()
    const r = cfg.resolveLlm({ vendor: 'typo-vendor', quality: 'basic', purpose: 'generate' })
    try {
      /*
       * configError 非空才是 fail-closed 的契约（handleChat 见到它直接 kind='config'，
       * 见 handleChat 用例）；路由对象里的 model 虽回填了默认厂值，但调用方绝不许用它发请求。
       */
      ok(r.configError && /VENDORS/.test(r.configError), `configError 应点名注册表：${r.configError}`)
      ok(/typo-vendor/.test(r.configError), `configError 要带上拼错的厂商名：${r.configError}`)
    } finally {
      resetEnv()
    }
  })

  it('旧版端上传 tier（fast/reason）仍兼容：fast→basic、reason→premium（灰度期老版本不挂）', () => {
    resetEnv()
    const cfg = loadConfig()
    const oldFast = cfg.resolveLlm({ vendor: 'deepseek', tier: 'fast', purpose: 'generate' })
    eq(oldFast.quality, 'basic')
    eq(oldFast.qualityRequested, 'basic')
    eq(oldFast.model, 'deepseek-v4-flash')
    const oldReason = cfg.resolveLlm({ vendor: 'deepseek', tier: 'reason', purpose: 'ask' })
    eq(oldReason.quality, 'premium')
    eq(oldReason.model, 'deepseek-v4-pro')
  })

  it('aux 辅助调用：任何人都强制基础档（系统内部请求，不为它烧会员档的钱）', () => {
    resetEnv()
    const cfg = loadConfig()
    const r = cfg.resolveLlm({ vendor: 'deepseek', quality: 'premium', purpose: 'aux' })
    eq(r.quality, 'basic')
    eq(r.capability, 'structured', '辅助与报告同槽：输出型')
    eq(r.model, 'deepseek-v4-flash')
    eq(r.memberOnly, false, '落基础档后不再是会员档，闸门不会拦')
  })
})

function deepExtra(actual, expected, tag) {
  if (expected === null) {
    eq(actual, null, `${tag} 不该带 extraBody`)
    return
  }
  ok(actual && typeof actual === 'object', `${tag} 应带 extraBody`)
  eq(JSON.stringify(actual), JSON.stringify(expected), `${tag} extraBody 形状`)
}

/* ==================== ② handleChat 真跑一遍（假 https） ==================== */

describe('23-http-vendor handleChat 行为', () => {
  /** 种一条未过期会员行（云端权威表 memberships；doc(openid) 取，_id 即 openid） */
  function seedMember(db, openid) {
    db.__seed('memberships', [
      { _id: openid, plan: 'month', expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }
    ])
  }
  const DS_MSG = [{ role: 'user', content: '你好' }]

  it('DeepSeek 基础版报告：POST /chat/completions，关思考 + temperature，Bearer key，8192 上限', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk('厂商你好')])
    const { fn, calls } = loadProxy(up)
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    try {
      const res = await fn.main({
        action: 'chat',
        vendor: 'deepseek',
        quality: 'basic',
        purpose: 'generate',
        messages: DS_MSG
      })
      eq(res.ok, true)
      eq(res.content, '厂商你好')
      eq(res.model, 'deepseek-v4-flash')
      eq(calls.length, 1, '只该有一次调用')
      const req = calls[0]
      eq(req.path, '/v1/chat/completions', '应 POST 到厂商基址下的 /v1/chat/completions（hostname 在另一字段）')
      eq(req.body.model, 'deepseek-v4-flash')
      eq(req.body.temperature, 0.7, '非思考槽才下发 temperature')
      eq(req.body.thinking && req.body.thinking.type, 'disabled', 'extraBody 要透传进报文（与 model 平级）')
      eq(req.body.max_tokens, 8192)
      eq(req.body.stream, false)
      ok(Array.isArray(req.body.messages) && req.body.messages.length === 1, 'messages 要透传')
      eq(req.headers.Authorization, 'Bearer sk-test', 'key 以 Bearer 发出')
    } finally {
      resetEnv()
    }
  })

  it('DeepSeek 基础版问答：同一个 flash 模型开思考，报文里没有 temperature（思考模式不支持该参数）', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk('思考后的回答')])
    const { fn, calls } = loadProxy(up)
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    try {
      const res = await fn.main({
        action: 'chat',
        vendor: 'deepseek',
        quality: 'basic',
        purpose: 'ask',
        messages: DS_MSG
      })
      eq(res.ok, true)
      eq(res.content, '思考后的回答')
      const body = calls[0].body
      eq(body.model, 'deepseek-v4-flash', '双模模型：模型名相同，靠思考开关切槽')
      eq(body.thinking && body.thinking.type, 'enabled')
      notOk(Object.prototype.hasOwnProperty.call(body, 'temperature'), '思考开启时绝不能带 temperature')
    } finally {
      resetEnv()
    }
  })

  it('通义千问双模：enable_thinking 布尔开关随槽位透传，思考槽不下发 temperature', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk('报告'), chatOk('回答')])
    const { fn, calls } = loadProxy(up)
    process.env.DASHSCOPE_API_KEY = 'sk-test'
    try {
      /* 基础版报告：structured 槽关思考（enable_thinking:false），非思考模式可带 temperature */
      const r1 = await fn.main({
        action: 'chat',
        vendor: 'qwen',
        quality: 'basic',
        purpose: 'generate',
        messages: DS_MSG
      })
      eq(r1.ok, true)
      eq(r1.model, 'qwen3.5-flash')
      eq(calls[0].path, '/compatible-mode/v1/chat/completions', '走百炼中国内地兼容模式基址')
      eq(calls[0].body.model, 'qwen3.5-flash')
      eq(calls[0].body.enable_thinking, false, '报告槽显式关思考（与 model 平级透传）')
      eq(calls[0].body.temperature, 0.7, '关思考才带 temperature')

      /* 基础版问答：reasoning 槽开思考（enable_thinking:true）→ 不下发 temperature */
      const r2 = await fn.main({
        action: 'chat',
        vendor: 'qwen',
        quality: 'basic',
        purpose: 'ask',
        messages: DS_MSG
      })
      eq(r2.ok, true)
      eq(calls[1].body.model, 'qwen3.5-flash', '同一个双模模型，靠 enable_thinking 切槽')
      eq(calls[1].body.enable_thinking, true)
      notOk(
        Object.prototype.hasOwnProperty.call(calls[1].body, 'temperature'),
        'enable_thinking:true 也算思考开启，必须识别出来不下发 temperature'
      )
    } finally {
      resetEnv()
    }
  })

  it('火山方舟豆包双模：thinking.type 开关随槽位透传（与 DeepSeek 同形），思考槽不下发 temperature', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk('报告'), chatOk('回答')])
    const { fn, calls } = loadProxy(up)
    process.env.ARK_API_KEY = 'sk-ark'
    try {
      /* 基础版报告：structured 槽关思考（thinking.disabled），非思考模式可带 temperature */
      const r1 = await fn.main({
        action: 'chat',
        vendor: 'ark',
        quality: 'basic',
        purpose: 'generate',
        messages: DS_MSG
      })
      eq(r1.ok, true)
      eq(r1.model, 'doubao-seed-2-1-lite-260915')
      eq(calls[0].path, '/api/v3/chat/completions', '走方舟华北兼容基址（hostname 在另一字段）')
      eq(calls[0].body.model, 'doubao-seed-2-1-lite-260915')
      eq(calls[0].body.thinking && calls[0].body.thinking.type, 'disabled', '报告槽显式关思考（与 model 平级透传）')
      eq(calls[0].body.temperature, 0.7, '关思考才带 temperature')
      eq(calls[0].headers.Authorization, 'Bearer sk-ark', 'key 以 Bearer 发出（ARK_API_KEY）')

      /* 基础版问答：reasoning 槽开思考（thinking.enabled）→ 不下发 temperature */
      const r2 = await fn.main({
        action: 'chat',
        vendor: 'ark',
        quality: 'basic',
        purpose: 'ask',
        messages: DS_MSG
      })
      eq(r2.ok, true)
      eq(calls[1].body.model, 'doubao-seed-2-1-lite-260915', '同一个双模模型，靠 thinking.type 切槽')
      eq(calls[1].body.thinking && calls[1].body.thinking.type, 'enabled')
      notOk(
        Object.prototype.hasOwnProperty.call(calls[1].body, 'temperature'),
        '思考开启时不下发 temperature'
      )
    } finally {
      resetEnv()
    }
  })

  it('Kimi k3 问答：标准档 low / 高级档 max 的 reasoning_effort，且永不带 temperature', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk('标准回答'), chatOk('高级回答')])
    const loaded = loadProxy(up)
    process.env.MOONSHOT_API_KEY = 'sk-test'
    seedMember(loaded.db, 'u1') // k3 是会员档：非会员会被闸门降到基础版 k2.6
    const fn = loaded.fn
    const calls = loaded.calls
    try {
      const r1 = await fn.main({
        action: 'chat',
        vendor: 'moonshot',
        quality: 'standard',
        purpose: 'ask',
        messages: DS_MSG
      })
      eq(r1.ok, true)
      eq(calls[0].body.model, 'kimi-k3')
      eq(calls[0].body.reasoning_effort, 'low', '标准档降推理强度省 token')
      notOk(Object.prototype.hasOwnProperty.call(calls[0].body, 'temperature'))

      const r2 = await fn.main({
        action: 'chat',
        vendor: 'moonshot',
        quality: 'premium',
        purpose: 'ask',
        messages: DS_MSG
      })
      eq(r2.ok, true)
      eq(calls[1].body.model, 'kimi-k3')
      eq(calls[1].body.reasoning_effort, 'max', '高级档满强度思考')
      notOk(Object.prototype.hasOwnProperty.call(calls[1].body, 'temperature'))
    } finally {
      resetEnv()
    }
  })

  it('缺 key：kind=config，且一个上游请求都不发', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk()])
    const { fn, calls } = loadProxy(up) // 故意不设 DEEPSEEK_API_KEY
    try {
      const res = await fn.main({
        action: 'chat',
        vendor: 'deepseek',
        quality: 'basic',
        purpose: 'generate',
        messages: DS_MSG
      })
      eq(res.ok, false)
      eq(res.kind, 'config')
      ok(/DEEPSEEK_API_KEY/.test(res.error), `文案要告诉运维配哪个变量：${res.error}`)
      eq(calls.length, 0, '配置缺失不得产生上游调用')
    } finally {
      resetEnv()
    }
  })

  it('未知厂商名：kind=config，零上游调用', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk()])
    const { fn, calls } = loadProxy(up)
    try {
      const res = await fn.main({
        action: 'chat',
        vendor: 'typo-vendor',
        quality: 'basic',
        purpose: 'generate',
        messages: DS_MSG
      })
      eq(res.ok, false)
      eq(res.kind, 'config')
      ok(/VENDORS/.test(res.error), `错误要指向注册表：${res.error}`)
      eq(calls.length, 0)
    } finally {
      resetEnv()
    }
  })

  it('厂商 401：归 upstream_quota（不重试类），错误原话保留', async () => {
    resetEnv()
    const up = fakeUpstream([httpError(401, 'Invalid Authentication')])
    const { fn } = loadProxy(up)
    process.env.DEEPSEEK_API_KEY = 'sk-bad'
    try {
      const res = await fn.main({
        action: 'chat',
        vendor: 'deepseek',
        quality: 'basic',
        purpose: 'generate',
        messages: DS_MSG
      })
      eq(res.ok, false)
      eq(res.kind, 'upstream_quota')
      ok(/Invalid Authentication/.test(res.error), `要带上游原话：${res.error}`)
    } finally {
      resetEnv()
    }
  })

  it('非会员请求 DeepSeek 标准档：同厂商静默降回基础版（走 https 发 flash，绝不退回云开发 AI）', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk()])
    const { fn, calls } = loadProxy(up, 'u1') // u1 非会员
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    try {
      const res = await fn.main({
        action: 'chat',
        vendor: 'deepseek',
        quality: 'standard',
        purpose: 'generate',
        messages: DS_MSG
      })
      eq(res.ok, true)
      eq(res.downgraded, true)
      eq(res.vendor, 'deepseek', '降级不换厂')
      eq(res.model, 'deepseek-v4-flash', '降级只换质量档：standard→basic')
      eq(calls.length, 1)
      ok(/\/chat\/completions$/.test(calls[0].path),
        `必须仍走 DeepSeek 自有端点，不能拿 pro 的名字或整份路由退回 cloud.ai：${calls[0].path}`)
      eq(calls[0].path !== 'cloud.ai', true)
      eq(calls[0].body.model, 'deepseek-v4-flash', '贵的 pro 不能被白用')
      eq(calls[0].body.thinking && calls[0].body.thinking.type, 'disabled', '降级重取整份路由：基础版报告槽的思考开关也要跟着对')
    } finally {
      resetEnv()
    }
  })

  it('会员请求 DeepSeek 标准档：放行 pro（memberships 权威表说了才算）', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk()])
    const loaded = loadProxy(up, 'u1')
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    seedMember(loaded.db, 'u1')
    try {
      const res = await loaded.fn.main({
        action: 'chat',
        vendor: 'deepseek',
        quality: 'standard',
        purpose: 'generate',
        messages: DS_MSG
      })
      eq(res.ok, true)
      eq(res.downgraded, false)
      eq(res.model, 'deepseek-v4-pro')
      eq(loaded.calls[0].body.model, 'deepseek-v4-pro')
    } finally {
      resetEnv()
    }
  })

  it('非会员请求 Kimi 高级档报告：会员闸门 + 缺槽降档两道叠加后，落同厂基础版 k2.6', async () => {
    resetEnv()
    const up = fakeUpstream([chatOk()])
    const { fn, calls } = loadProxy(up, 'u1') // u1 非会员
    process.env.MOONSHOT_API_KEY = 'sk-test'
    try {
      const res = await fn.main({
        action: 'chat',
        vendor: 'moonshot',
        quality: 'premium',
        purpose: 'generate',
        messages: DS_MSG
      })
      /* 先缺槽（premium→standard 仍是会员档）再过闸门（standard→basic），最终只能是基础版 k2.6 */
      eq(res.ok, true)
      eq(res.downgraded, true, '会员闸门降了质量档')
      eq(res.vendor, 'moonshot')
      eq(res.model, 'kimi-k2.6')
      eq(calls[0].path !== 'cloud.ai', true, '再怎么降也不换厂商')
      eq(calls[0].body.model, 'kimi-k2.6')
    } finally {
      resetEnv()
    }
  })
})
