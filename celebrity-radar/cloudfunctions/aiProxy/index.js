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
 *   'test'   （默认）真实各打一次上游，验证「环境变量已生效 + 能出网」。
 *            端上「我的 → 测试连通性」入口已于 2026-10-07 移除（改为只保留「生成模型」选择），
 *            此动作现在只供控制台 / 云调用人工排障使用，业务链路只走 search / chat。
 *   'search' 业务转发：代理一次博查检索，供端上 search.ts 在用户未自配 key 时使用
 *   'chat'   业务转发：代理一次大模型对话，供端上 llm.ts 在用户未自配 key 时使用
 *
 * ⚠ 本函数同时是**付费闸门**（2026-10-07 起）：chat 的模型档位按会员身份放行，
 * search 的 count 上限同样分档（见 MEMBER_ONLY_MODELS / FREE_SEARCH_MAX 的注释）。
 * 「深度模式」（O-11）也只在这一层放行：search 加厚素材、chat 放宽 max_tokens，
 * 端上那个 deep 标记只是请求，改包绕过不了这里的会员判定。
 * 端上的会员判定只影响 UI 与请求值，改包即可绕过；凡是要花上游钱的权益都必须在这里拦一次。
 *
 * chat 的耗时约束（务必先读）：
 *   报告正文属长生成，单次可能逼近云函数上限，因此这里的上游超时取 LLM_CHAT_TIMEOUT_MS，
 *   而它必须**小于本函数的执行超时**，否则长生成会被平台在中途掐断。
 *
 *   ⚠ 执行超时只能在控制台改：微信云开发给云函数配的默认超时是 **20 秒**，
 *   而本目录 config.json / cloudbaserc.json 里写的 timeout **不随上传生效**（实测仍是 20s）。
 *   配置路径：云开发控制台 → 云函数 → aiProxy → 配置 → 超时时间，改成 60 秒并保存（改完即生效）。
 *   被平台掐断的后果：函数没有机会返回任何 kind / error，端上只能拿到
 *   errCode -504003（FUNCTIONS_TIME_LIMIT_EXCEEDED），表现为一句无从下手的「生成失败」。
 *   端上已识别该错误码并翻成可照做的提示（src/utils/cloud.ts 的 cloudTimeoutHint）。
 */
const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const LLM_BASE_URL = 'https://api.deepseek.com/v1'
const LLM_MODEL = 'deepseek-v4-flash'
const TIMEOUT_MS = 15000
const SNIPPET = 200

/**
 * 会员专属模型（「质」权益，2026-10-07）：
 * 与 src/config/public.ts 的 llm.models 里 memberOnly: true 的项一一对应。
 * ⚠ 端上那份清单决定 UI 与请求值，**这一份才是计费闸门** —— 小程序包可解包，
 * 端上判定改包即可绕过，只有这里拦得住「非会员用最贵的那一档」。
 */
const MEMBER_ONLY_MODELS = ['deepseek-v4', 'deepseek-reasoner']

/*
 * 检索条数上限（按会员分档，2026-10-07）：
 *   FREE_SEARCH_MAX   就是改造前的硬上限 20，**不得下调**：端上主线 / 支线默认取 10 / 8，
 *                     下调等于回头削减既有免费额度，属于端上无感的「偷偷涨价」。
 *   MEMBER_SEARCH_MAX 为下一步「深度模式」（会员生成时素材加厚）预留的服务端能力；
 *                     端上接线前它只是把上限放宽，不改变任何现有行为。
 */
const FREE_SEARCH_MAX = 20
const MEMBER_SEARCH_MAX = 40

/*
 * 会员「深度模式」的输出上限（O-11 第二步，2026-10-07）：
 *   免费版**不传 max_tokens**，用上游默认 —— 与改造前逐字节一致。它是**输出上限**不是额度，
 *   免费用户不该被悄悄削一刀，故这里只对会员放开。
 *   会员由端上带 deep:true 触发（与 search 的 count 分档同一个套路）：deep 只是「请求」，
 *   这里才是闸门，非会员改包带上它也拿不到。
 *   起因：报告正文是多段摘要 + 逐条动态的长 JSON，贴默认上限时尾部字段容易被截断，
 *   表现为「解析失败 → 重试 → 再失败」，代价反而是翻番的生成耗时。
 */
const MEMBER_CHAT_MAX_TOKENS = 8192

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

/**
 * 调用者是不是有效期内的会员。
 *
 * 只读 users.membership.expires_at —— 与端上 utils/member.ts 同一口径：有效期是唯一事实，
 * plan 只决定天数。云函数是管理员身份，故必须显式按 _openid 过滤，否则会读到别人的行。
 *
 * 读库失败一律按**非会员**：方向与端上 readMemberState 一致 ——
 * 宁可让真会员这一次拿到降级模型（体验损失），也不能让非会员刷走最贵的那一档（成本损失）。
 */
async function isActiveMember(openid) {
  if (!openid) return false
  try {
    const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
    const m = res && res.data && res.data[0] && res.data[0].membership
    const t = m && m.expires_at ? Date.parse(m.expires_at) : NaN
    return Number.isFinite(t) && t > Date.now()
  } catch (err) {
    return false
  }
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

async function probeLlm(key, model) {
  const res = await postJson(
    `${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: `Bearer ${key}` },
    {
      model: model || LLM_MODEL,
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

/**
 * 上游超时 / 断流的统一文案。这里的 hint 对应「函数超时够长、上游自己慢」这一支；
 * 若反过来（函数超时短于上游）则根本走不到这里 —— 进程已被平台杀掉，端上看到的是 -504003，
 * 由 src/utils/cloud.ts#cloudTimeoutHint 兜住，故两处文案刻意各自指向自己的修法。
 */
function failDetail(err) {
  const msg = err instanceof Error ? err.message : String(err)
  const hint = /超时|timeout|socket hang up/i.test(msg)
    ? '（请把云函数超时时间调到 60s：控制台 → 云函数 → aiProxy → 配置）'
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

/**
 * 站点限定参数归一（§1.4 V1.5 多源分域检索）。
 * 端上可能传数组（['weibo.com']）也可能传串，这里统一成博查要的 `site:a.com|site:b.com`；
 * 全都取不出域名时返回 undefined —— 宁可不带该参数，也不要发一个空 include 把结果筛没。
 */
function normalizeInclude(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (Array.isArray(raw)) {
    const list = raw
      .filter((x) => typeof x === 'string' && x.trim() !== '')
      .map((x) => (x.includes('site:') ? x.trim() : `site:${x.trim()}`))
    if (list.length > 0) return list.join('|')
  }
  return undefined
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
  const include = normalizeInclude(event.include)
  const want = Number.isFinite(count) && count > 0 ? Math.floor(count) : 10
  /*
   * 只有「要得比免费上限还多」时才查一次会员身份：
   * 端上主线 / 支线默认都在 20 以内，故绝大多数请求不会为此多一次读库。
   */
  const cap =
    want > FREE_SEARCH_MAX && (await isActiveMember((cloud.getWXContext() || {}).OPENID))
      ? MEMBER_SEARCH_MAX
      : FREE_SEARCH_MAX
  try {
    return await runSearch(key, {
      query,
      freshness: typeof event.freshness === 'string' ? event.freshness : 'oneMonth',
      summary: true,
      count: Math.min(want, cap),
      /* 不传 include 时不发该字段：保持与原行为完全一致（端上主线检索走这条路径） */
      ...(include ? { include } : {})
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
  const requested =
    typeof event.model === 'string' && event.model.trim() ? event.model.trim() : LLM_MODEL

  /*
   * 会员闸门：端上传的模型名只是「请求」，这里才是裁决点。
   * 非会员请求会员专属档位 → **静默降级**为默认模型并把 downgraded 回传：
   * 生成照常出结果（不因一次残留偏好 / 改包就给用户一句报错），
   * 但代价最高的那一档不会被白用。端上按 downgraded 在诊断日志里记一笔。
   */
  let model = requested
  let downgraded = false
  const openid = (cloud.getWXContext() || {}).OPENID
  /* 会员身份一次读库、两处共用（模型闸门 + 深度模式）：同一次请求不查两遍 users */
  let memberKnown = null
  const isMember = async () => {
    if (memberKnown === null) memberKnown = await isActiveMember(openid)
    return memberKnown
  }
  if (MEMBER_ONLY_MODELS.includes(requested) && !(await isMember())) {
    model = LLM_MODEL
    downgraded = true
  }

  /*
   * 深度模式（O-11）：端上只在会员时带 deep:true。非会员带 deep 也拿不到 —— 这里要再查一次身份，
   * 与 runSearch「要得比免费上限多才查会员」同一取舍：常态请求（不带 deep）不为此多一次读库。
   */
  const deep = event.deep === true && (await isMember())
  const payload = { model, stream: false, messages: norm.messages }
  if (deep) payload.max_tokens = MEMBER_CHAT_MAX_TOKENS

  let res
  try {
    res = await postJson(
      `${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
      { Authorization: `Bearer ${key}` },
      payload,
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
  return { ok: true, content, model, downgraded, deep }
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

  /* 探测用的模型名由端上传入（M7-4「模型选择」）：用户在设置页切到哪个模型，就真打哪个，
     免得「测试通过」测的其实是另一个模型。缺省仍用本文件常量。 */
  const probeModel =
    typeof event.model === 'string' && event.model.trim() ? event.model.trim() : LLM_MODEL

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
      Object.assign(llm, await probeLlm(llmKey, probeModel))
    } catch (err) {
      llm.detail = failDetail(err)
    }
  }

  return {
    ok: bocha.ok && llm.ok,
    checked_at: new Date().toISOString(),
    model: probeModel,
    bocha,
    llm
  }
}
