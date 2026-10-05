/**
 * aiProxy —— 平台代付模式的密钥闸门。
 *
 * 小程序包可解包、前端一切可见，平台自有 key 一旦下发到客户端即等同公开
 * （见 src/config/public.ts）。故 key 只活在服务端：本函数的环境变量里。
 *   控制台 → 云函数 → aiProxy → 配置 → 环境变量：
 *     BOCHA_API_KEY     博查搜索 key
 *     DEEPSEEK_API_KEY  大模型 key（OpenAI 兼容）
 * 严禁把 key 写进本文件或任何提交进 git 的文件。
 *
 * action：
 *   'test'   （默认）真实各打一次上游，验证「环境变量已生效 + 能出网」
 *   'search' 业务转发：代理一次博查检索，供端上 search.ts 在用户未自配 key 时使用
 *   'chat'   业务转发：代理一次大模型对话，供端上 llm.ts 在用户未自配 key 时使用
 *
 * chat 的耗时约束（务必先读）：
 *   报告正文属长生成，单次可能逼近云函数上限，因此这里的上游超时取 LLM_CHAT_TIMEOUT_MS，
 *   而它必须**小于控制台里给本函数配的超时时间**（建议 60s，默认值往往只有 3~20s）。
 *   配置路径：控制台 → 云函数 → aiProxy → 配置 → 超时时间。
 *   若函数超时短于上游超时，长生成会在中途被平台掐断，端上只会看到一句「网络失败」。
 */
const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const LLM_BASE_URL = 'https://api.deepseek.com/v1'
const LLM_MODEL = 'deepseek-v4-flash'
const TIMEOUT_MS = 15000
const SNIPPET = 200

/** 控制台上的函数超时时间必须大于它，否则长生成会被平台提前掐断 */
const LLM_CHAT_TIMEOUT_MS = 50000
/*
 * 防滥用：这是一条「平台付钱、客户端随便调」的通道，不设闸门就等于对外送一个免费 LLM 网关。
 * 端上实际只发 system + user 两条，这里的上限留了余量而非贴着用。
 */
const MAX_CHAT_MESSAGES = 6
const MAX_CHAT_CHARS = 24000

function readEnv(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** 只回长度与是否配置，绝不回明文片段：该值会进入客户端可读的返回值 */
function keyInfo(key) {
  return { configured: !!key, length: key ? key.length : 0 }
}

function snippet(v) {
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  return String(text || '').slice(0, SNIPPET)
}

/** 原生 https POST（不引 axios：微信云函数 Node 版本不保证有全局 fetch） */
function postJson(target, headers, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(target)
    const body = JSON.stringify(payload)
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          headers
        ),
        timeout: timeoutMs
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let data
          try {
            data = JSON.parse(raw)
          } catch (e) {
            data = raw
          }
          resolve({ status: res.statusCode || 0, data })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error(`上游无响应（${timeoutMs}ms 超时）`)))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function probeBocha(key) {
  const res = await postJson(
    BOCHA_ENDPOINT,
    { Authorization: `Bearer ${key}` },
    { query: '雷军 近期 新闻 动态 言论', freshness: 'oneMonth', summary: true, count: 3 },
    TIMEOUT_MS
  )
  const body = res.data
  const code = Number((body && body.code) ?? res.status)
  if (res.status === 200 && code === 200) {
    const pages = (body.data && body.data.webPages && body.data.webPages.value) || []
    return { ok: true, detail: `可用（返回 ${pages.length} 条）` }
  }
  if (res.status === 401) return { ok: false, detail: '401 密钥无效' }
  if (res.status === 403) return { ok: false, detail: '403 未绑资源包或额度不足' }
  return { ok: false, detail: `HTTP ${res.status} / code ${code}：${snippet(body) || '无响应体'}` }
}

async function probeLlm(key) {
  const res = await postJson(
    `${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: `Bearer ${key}` },
    {
      model: LLM_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: '你是连通性测试助手，只回复两个字：正常' },
        { role: 'user', content: '连通性测试' }
      ]
    },
    TIMEOUT_MS
  )
  if (res.status >= 200 && res.status < 300) {
    const choices = res.data && res.data.choices
    const content = choices && choices[0] && choices[0].message && choices[0].message.content
    if (typeof content === 'string' && content.trim()) {
      return { ok: true, detail: `可用（返回「${content.trim().slice(0, 12)}」）` }
    }
    return { ok: false, detail: `返回结构异常：${snippet(res.data)}` }
  }
  if (res.status === 401) return { ok: false, detail: '401 密钥无效' }
  return { ok: false, detail: `HTTP ${res.status}：${snippet(res.data) || '无响应体'}` }
}

/** 超时是头号嫌疑：云函数默认超时太短时，表现为这里抛错而不是上游报错 */
function failDetail(err) {
  const msg = err instanceof Error ? err.message : String(err)
  const hint = /超时|timeout|socket hang up/i.test(msg)
    ? '（请把云函数超时时间调到 ≥20s：控制台 → 云函数 → 配置）'
    : ''
  return `请求失败：${msg}${hint}`
}

/**
 * 业务转发：一次博查检索。
 *
 * 刻意只回上游原始 webPages 数组，不在这里做字段映射——
 * 端上 search.ts 的 toNewsItem 是字段兜底的唯一来源，两处各写一份必然漂移。
 *
 * 返回值带上 kind：端上据此决定「要不要重试」。
 *   rate / auth / quota / unconfigured / badrequest → 重试无意义
 *   upstream / network                              → 可退避重试
 */
async function runSearch(key, params) {
  const res = await postJson(BOCHA_ENDPOINT, { Authorization: `Bearer ${key}` }, params, TIMEOUT_MS)
  const body = res.data

  if (res.status === 429) return { ok: false, kind: 'rate', error: '搜索源请求过于频繁，请稍后再试' }
  if (res.status === 401) {
    return { ok: false, kind: 'auth', error: '检索密钥无效（请检查云函数环境变量 BOCHA_API_KEY）' }
  }
  if (res.status === 403) {
    return { ok: false, kind: 'quota', error: '检索额度不足或未开通权限（博查资源包）' }
  }
  if (res.status !== 200) {
    return {
      ok: false,
      kind: 'upstream',
      error: `检索服务返回 HTTP ${res.status}：${snippet(body) || '无响应体'}`
    }
  }

  const code = Number((body && body.code) ?? 200)
  if (code !== 200) {
    return { ok: false, kind: 'upstream', error: `检索服务错误码 ${code}：${snippet(body) || '无响应体'}` }
  }

  const pages = (body.data && body.data.webPages && body.data.webPages.value) || []
  return { ok: true, pages }
}

async function handleSearch(event) {
  const key = readEnv('BOCHA_API_KEY')
  if (!key) {
    /* 函数部署了但没配环境变量：对端上而言等同「这条通道不存在」，故单列一个 kind */
    return {
      ok: false,
      kind: 'unconfigured',
      error: '平台未配置检索额度（云函数环境变量 BOCHA_API_KEY）'
    }
  }
  const query = typeof event.query === 'string' ? event.query.trim() : ''
  if (!query) return { ok: false, kind: 'badrequest', error: '缺少 query' }

  const count = Number(event.count)
  try {
    return await runSearch(key, {
      query,
      freshness: typeof event.freshness === 'string' ? event.freshness : 'oneMonth',
      summary: true,
      count: Number.isFinite(count) && count > 0 ? Math.min(count, 20) : 10
    })
  } catch (err) {
    return { ok: false, kind: 'network', error: failDetail(err) }
  }
}

/**
 * 归一化 messages：只认 system / user，并卡住条数与总长度。
 *
 * 刻意不校验「内容像不像正经提示词」——那既做不到也不该做；
 * 这里只挡住最粗放的滥用（把本函数当免费 API 批量刷）。
 */
function normalizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: '缺少 messages' }
  if (raw.length > MAX_CHAT_MESSAGES) {
    return { error: `messages 过多（上限 ${MAX_CHAT_MESSAGES} 条）` }
  }
  const out = []
  let chars = 0
  for (const m of raw) {
    if (!m || typeof m !== 'object') return { error: 'messages 元素格式错误' }
    const content = typeof m.content === 'string' ? m.content : ''
    if (!content.trim()) return { error: 'messages 内容为空' }
    chars += content.length
    out.push({ role: m.role === 'system' ? 'system' : 'user', content })
  }
  if (chars > MAX_CHAT_CHARS) {
    return { error: `提示词过长（${chars} 字，上限 ${MAX_CHAT_CHARS} 字）` }
  }
  return { messages: out }
}

/**
 * 业务转发：一次大模型对话（非流式）。
 *
 * 只回正文文本，不代端上做 JSON 提取与 zod 校验——那是 llm.ts 的职责，
 * 两处各写一份必然漂移（与 runSearch 不代端上映射字段同理）。
 *
 * kind 语义与 runSearch 对齐，端上据此决定「要不要重试」：
 *   rate / auth / quota / unconfigured / badrequest → 重试无意义
 *   upstream / network                              → 可退避重试
 */
async function handleChat(event) {
  const key = readEnv('DEEPSEEK_API_KEY')
  if (!key) {
    return {
      ok: false,
      kind: 'unconfigured',
      error: '平台未配置大模型额度（云函数环境变量 DEEPSEEK_API_KEY）'
    }
  }

  const norm = normalizeMessages(event.messages)
  if (norm.error) return { ok: false, kind: 'badrequest', error: norm.error }

  /* 模型名由端上传入（与 public.ts 的 llm.model 同源），缺省用本文件常量 */
  const model =
    typeof event.model === 'string' && event.model.trim() ? event.model.trim() : LLM_MODEL

  let res
  try {
    res = await postJson(
      `${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
      { Authorization: `Bearer ${key}` },
      { model, stream: false, messages: norm.messages },
      LLM_CHAT_TIMEOUT_MS
    )
  } catch (err) {
    return { ok: false, kind: 'network', error: failDetail(err) }
  }

  if (res.status === 429) {
    return { ok: false, kind: 'rate', error: '大模型请求过于频繁，请稍后再试' }
  }
  if (res.status === 401) {
    return { ok: false, kind: 'auth', error: '大模型密钥无效（请检查云函数环境变量 DEEPSEEK_API_KEY）' }
  }
  /* 402 = DeepSeek 账户余额不足，与 401 是两回事，分开报才定位得到 */
  if (res.status === 402) {
    return { ok: false, kind: 'quota', error: '大模型额度不足（上游账户余额）' }
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      kind: 'upstream',
      error: `大模型返回 HTTP ${res.status}：${snippet(res.data) || '无响应体'}`
    }
  }

  const choices = res.data && res.data.choices
  const content = choices && choices[0] && choices[0].message && choices[0].message.content
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, kind: 'upstream', error: `大模型返回结构异常：${snippet(res.data)}` }
  }
  return { ok: true, content, model }
}

exports.main = async (event) => {
  const action = (event && event.action) || 'test'
  if (action === 'search') return handleSearch(event || {})
  if (action === 'chat') return handleChat(event || {})
  if (action !== 'test') {
    return { ok: false, error: `未知 action：${action}（支持 test / search / chat）` }
  }

  const bochaKey = readEnv('BOCHA_API_KEY')
  const llmKey = readEnv('DEEPSEEK_API_KEY')

  const bocha = Object.assign(keyInfo(bochaKey), { ok: false, detail: '' })
  const llm = Object.assign(keyInfo(llmKey), { ok: false, detail: '' })

  if (!bochaKey) bocha.detail = '未配置环境变量 BOCHA_API_KEY'
  else {
    try {
      Object.assign(bocha, await probeBocha(bochaKey))
    } catch (err) {
      bocha.detail = failDetail(err)
    }
  }

  if (!llmKey) llm.detail = '未配置环境变量 DEEPSEEK_API_KEY'
  else {
    try {
      Object.assign(llm, await probeLlm(llmKey))
    } catch (err) {
      llm.detail = failDetail(err)
    }
  }

  return {
    ok: bocha.ok && llm.ok,
    checked_at: new Date().toISOString(),
    model: LLM_MODEL,
    bocha,
    llm
  }
}
