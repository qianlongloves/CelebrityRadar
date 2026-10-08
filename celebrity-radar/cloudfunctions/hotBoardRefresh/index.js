/**
 * hotBoardRefresh —— 热门名人榜的每日生产端。
 *
 * 触发：定时触发器（cloudbaserc.json 的 triggers，默认每天 06:30）。
 * 环境变量（控制台 → 云函数 → hotBoardRefresh → 配置 → 环境变量）：
 *   BOCHA_API_KEY     博查检索 key（与 aiProxy / notifyFollowUpdates 共用同一枚）
 *   DEEPSEEK_API_KEY  大模型 key（与 aiProxy 共用同一枚）
 *
 * 为什么必须放在云端而不是端上生成：
 * 1. 榜单是**全局运营位**，一天一份、所有人看同一份。端上生成 = 每个用户各生成一次，
 *    既贵，又会出现「同一时刻不同用户看到不同榜单」。
 * 2. 端上生成要等一次检索 + 长生成（数秒），首屏运营位不能这样等。
 * 3. 榜单要「昨天有、今天也有」：这轮失败就保留上一份，端上照常可读。
 * 流程因此是「云函数按天生产 → 落 hot_board 集合 → 端上只读」。
 *
 * 生产三步：① 6 个领域各打一次博查（近一周）拿标题 + 摘要
 *          ② 摘要喂给大模型，产出 24 位（每领域 4 位）的 JSON 榜单
 *          ③ 校验后覆盖写 hot_board/latest
 *
 * action：
 *   'run'    （默认）生产一轮，按幂等规则决定是否重写
 *   'ensure' 端上冷启动补跑用：与 run 同逻辑，靠 20h 幂等兜住重复调用
 *   'dry'    只走到第 ② 步，返回结果但不落库（控制台试跑、验提示词用）
 *   'report' 只读当前榜单，不请求任何上游
 *
 * ⚠ 控制台里本函数的超时时间要调到 60 秒（默认 20 秒会把这一轮掐断，日志里只有一条
 *   没头没尾的失败）。检索是并行的，正常总耗时 20~40 秒。
 */
const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const LLM_BASE_URL = 'https://api.deepseek.com/v1'
/** 与 aiProxy 的 LLM_MODEL / src/config/public.ts 的 llm.model 同源，改动需同步 */
const LLM_MODEL = 'deepseek-v4-flash'
const SEARCH_TIMEOUT_MS = 15000
const LLM_TIMEOUT_MS = 30000

const COLLECTION = 'hot_board'
/** 单文档覆盖写：端上永远只读这一份，不需要按日期查询 */
const DOC_ID = 'latest'
/** 20 小时内的榜单视为「今天已经生成过」，重复触发直接返回（定时器重试 / 端上补跑都会命中） */
const FRESH_MS = 20 * 60 * 60 * 1000
/** 每领域出几位：6 × 4 = 24，与端上 BOARD_LIMIT 一致 */
const PER_DOMAIN = 4
/** 校验下限：低于这个条数视为这轮失败，保留旧榜单（宁可用昨天的，也不要一份残缺榜） */
const MIN_ITEMS = 12
/** 至少要覆盖几个领域：防止模型全堆在文娱一个领域 */
const MIN_DOMAINS = 4

/** 领域清单：与 src/config/domains.ts 的 DOMAIN_CODES 一一对应 */
const DOMAINS = [
  { code: 'tech', label: '科技', query: '科技 企业家 最新动态 发布' },
  { code: 'business', label: '商业', query: '商界 企业家 最新动态' },
  { code: 'ent', label: '文娱', query: '明星 艺人 最新动态 热搜' },
  { code: 'sports', label: '体育', query: '运动员 体育明星 最新比赛 动态' },
  { code: 'academia', label: '学术', query: '科学家 学者 最新研究成果' },
  { code: 'other', label: '其他', query: '公众人物 热点 最新动态' }
]
const DOMAIN_CODES = DOMAINS.map((d) => d.code)

function readEnv(name) {
  const v = process.env[name]
  return typeof v === 'string' && v.trim() ? v.trim() : null
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

/** 按字符数清洗 + 截断（模型偶尔带引号 / 换行，落库前统一收干净） */
function text(v, max) {
  const s = String(v == null ? '' : v)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^["'“”「」\s]+|["'“”「」\s]+$/g, '')
    .trim()
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max).join('')
}

function isDomain(code) {
  return DOMAIN_CODES.indexOf(code) >= 0
}

/** 领域的检索结果 → 喂给模型的素材块（条数与字数都收着来，别把 prompt 撑爆） */
function buildDigest(domain, pages) {
  const lines = (pages || [])
    .slice(0, 8)
    .map((p) => {
      const title = text(p.name, 60)
      if (!title) return ''
      const site = text(p.siteName, 12)
      const summary = text(p.summary, 90)
      return `- ${title}${site ? `（${site}）` : ''}${summary ? `：${summary}` : ''}`
    })
    .filter(Boolean)
  return `【${domain.label}】\n${lines.join('\n')}`
}

/** 一次分域检索：失败抛错，由调用方按领域兜住，不拖垮整轮 */
async function searchDomain(domain, key) {
  const res = await postJson(
    BOCHA_ENDPOINT,
    { Authorization: `Bearer ${key}` },
    { query: domain.query, freshness: 'oneWeek', summary: true, count: 12 },
    SEARCH_TIMEOUT_MS
  )
  const code = Number((res.data && res.data.code) ?? res.status)
  if (res.status !== 200 || code !== 200) throw new Error(`HTTP ${res.status} / code ${code}`)
  const inner = res.data && res.data.data
  return (inner && inner.webPages && inner.webPages.value) || []
}

/**
 * 提示词。三条硬约束值得单独说：
 * 1. 「数组顺序即排名」—— 榜位由顺序表达，不给分数（分数只会引出「92 和 91 差在哪」的追问，
 *    而模型给不出可核对的口径，端上原来的热度条正是这么变成一个玄学数字的）。
 * 2. 「必须基于给定报道」—— 模型对名人的印象会过期，榜单要的是**本周**的公开信息。
 * 3. 「只输出 JSON」—— 云函数侧手写解析，容忍 markdown 栅栏，但不容忍夹带解释文字。
 */
function buildPrompt(digests, today) {
  const total = PER_DOMAIN * DOMAINS.length
  const system = [
    '你是「名人雷达」的热门榜编辑，负责每天从公开报道里挑出当下最值得关注的公众人物。',
    '',
    '硬性规则：',
    `1. 领域只能从这 6 个里选：tech（科技）、business（商业）、ent（文娱）、sports（体育）、academia（学术）、other（其他），每个领域给 ${PER_DOMAIN} 位，共 ${total} 位。`,
    '2. 只选真实存在、且在给定报道里能找到依据的公众人物；不要政治、军事人物，不要虚构人物，不要把机构名或公司名当人名。',
    '3. 榜单位次 = 关注度从高到低，数组顺序即排名（第 1 位最热）。',
    '4. 同一个人只出现一次；外籍人物用通行中文译名（如「马斯克」，不要写「Elon Musk」）。',
    '5. tag 是这位人物近期的动态关键词，2~6 个字（如「新品发布」「巡演」「复出」）。',
    '6. trend 是一句话（不超过 40 字）说明 TA 近期在做什么、为什么被讨论，必须基于给定报道，不要编造具体数字或结论。',
    '7. 只输出 JSON，不要任何解释文字，不要 markdown 代码块。',
    '',
    '输出格式：',
    '{"items":[{"name":"雷军","domain":"tech","tag":"新品发布","trend":"新品发布节奏与年度目标表态持续被讨论"}]}'
  ].join('\n')

  const user = [
    `今天是 ${today}。以下是各领域近一周的公开报道标题与摘要：`,
    '',
    digests.join('\n\n'),
    '',
    `请据此给出今天的 ${total} 位热门名人榜。`
  ].join('\n')

  return { system, user }
}

/** 从模型输出里取 JSON（剥 markdown 栅栏、截取首尾大括号），与端上 extractJSONText 同口径 */
function extractJson(raw) {
  let s = String(raw || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch (e) {
    return null
  }
}

async function askLlm(key, system, user) {
  const res = await postJson(
    `${LLM_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: `Bearer ${key}` },
    {
      model: LLM_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    LLM_TIMEOUT_MS
  )
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`大模型 HTTP ${res.status}：${String(JSON.stringify(res.data)).slice(0, 200)}`)
  }
  const choices = res.data && res.data.choices
  const content = choices && choices[0] && choices[0].message && choices[0].message.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('大模型返回为空')
  return content
}

/**
 * 模型输出 → 榜单条目。逐条容错：脏条目只让自己消失，不带坏整份榜单。
 * 去重按**人名**而不是 name#domain：同一个人被模型分到两个领域时，榜面上就是两张一样的卡。
 */
function normalizeItems(parsed) {
  const raw = parsed && Array.isArray(parsed.items) ? parsed.items : []
  const seen = new Set()
  const out = []
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue
    const name = text(it.name, 16)
    if (!name || !isDomain(it.domain)) continue
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, domain: it.domain, tag: text(it.tag, 8), trend: text(it.trend, 44) })
  }
  return out
}

/** 校验：条数与领域覆盖两道门槛都过了，才认为这轮产出可用 */
function judge(items) {
  const domains = new Set(items.map((i) => i.domain)).size
  const ok = items.length >= MIN_ITEMS && domains >= MIN_DOMAINS
  return { items: items.slice(0, PER_DOMAIN * DOMAINS.length), count: items.length, domains, ok }
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  /* 云函数跑在 UTC，榜单是给国内用户看的，故按东八区折算 */
  const cst = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  return `${cst.getUTCFullYear()}-${p(cst.getUTCMonth() + 1)}-${p(cst.getUTCDate())}`
}

/** 读当前榜单；集合不存在 / 无数据都返回 null，不算错误 */
async function readBoard() {
  try {
    const res = await db.collection(COLLECTION).doc(DOC_ID).get()
    return res && res.data ? res.data : null
  } catch (e) {
    return null
  }
}

/**
 * 覆盖写榜单。
 * 集合不存在时先建再写：本函数独立于 dbInit —— 新环境忘了跑建表脚本，
 * 不该表现为「榜单永远空着」这种查不出所以然的现象。
 */
async function writeBoard(doc) {
  try {
    await db.collection(COLLECTION).doc(DOC_ID).set({ data: doc })
    return { ok: true, created: false }
  } catch (err) {
    const msg = String((err && err.errMsg) || (err && err.message) || err)
    if (!/collection|not exist|-502005|DATABASE_COLLECTION_NOT_EXIST/i.test(msg)) throw err
    await db.createCollection(COLLECTION)
    await db.collection(COLLECTION).doc(DOC_ID).set({ data: doc })
    return { ok: true, created: true }
  }
}

exports.main = async (event) => {
  const action = (event && typeof event.action === 'string' && event.action) || 'run'

  if (action === 'report') {
    const cur = await readBoard()
    return { ok: true, board: cur }
  }

  const bochaKey = readEnv('BOCHA_API_KEY')
  const llmKey = readEnv('DEEPSEEK_API_KEY')
  if (!bochaKey || !llmKey) {
    /* 未配置不是错误：函数可能先于密钥上线部署，静默跳过即可（不产生失败告警） */
    return {
      ok: false,
      skipped:
        '缺少环境变量：' +
        [!bochaKey && 'BOCHA_API_KEY', !llmKey && 'DEEPSEEK_API_KEY'].filter(Boolean).join(' / ')
    }
  }

  /* 幂等闸门。定时器重试、端上冷启动补跑、人为多点几次，都会撞在这里 ——
     一天最多打一轮上游，成本可控。force 只留给运维手动重建。 */
  const cur = await readBoard()
  const curAt = cur && cur.generated_at ? Date.parse(cur.generated_at) : NaN
  if (!event || event.force !== true) {
    if (Number.isFinite(curAt) && Date.now() - curAt < FRESH_MS) {
      return { ok: true, skipped: 'fresh', generated_at: cur.generated_at, count: (cur.items || []).length }
    }
  }

  // ① 分域检索（并行）：单个领域失败只丢它自己的素材，不拖垮整轮
  const settled = await Promise.allSettled(DOMAINS.map((d) => searchDomain(d, bochaKey)))
  const digests = []
  const failed = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') digests.push(buildDigest(DOMAINS[i], r.value))
    else failed.push(`${DOMAINS[i].code}: ${String((r.reason && r.reason.message) || r.reason)}`)
  })
  /* 只有真正带回报道的领域才算可用：素材块里至少要有一条 '- ' 开头的行 */
  const usable = digests.filter((d) => /^- /m.test(d))
  if (usable.length < 3) {
    /* 检索全线失败：没有任何素材可依据，宁可保留旧榜单，也不要让模型凭记忆编一份出来 */
    return { ok: false, error: '检索素材不足，保留原有榜单', failed }
  }

  // ② 结构化
  const date = today()
  const prompt = buildPrompt(usable, date)
  let items
  try {
    const content = await askLlm(llmKey, prompt.system, prompt.user)
    const parsed = extractJson(content)
    if (!parsed) return { ok: false, error: '大模型输出不含 JSON，保留原有榜单', failed }
    items = normalizeItems(parsed)
  } catch (err) {
    return { ok: false, error: `大模型调用失败：${String((err && err.message) || err)}`, failed }
  }

  const judged = judge(items)
  if (action === 'dry') {
    /* 试跑才带上完整 items，方便在控制台直接看榜单长什么样 */
    return { ok: judged.ok, dry: true, date, searches: usable.length, failed, ...judged }
  }
  if (!judged.ok) {
    return { ok: false, error: `榜单不合格（${judged.count} 位 / ${judged.domains} 个领域），保留原有榜单`, failed }
  }

  // ③ 落库
  const doc = {
    items: judged.items,
    generated_at: new Date().toISOString(),
    date,
    model: LLM_MODEL
  }
  try {
    const w = await writeBoard(doc)
    /* 正式路径只回摘要：端上冷启动补跑也会调到这里，返回整份榜单只会把端上日志刷满 */
    return { ok: true, date, count: judged.count, domains: judged.domains, created: w.created, failed }
  } catch (err) {
    return {
      ok: false,
      error: `写入失败：${String((err && err.errMsg) || (err && err.message) || err)}`,
      count: judged.count,
      domains: judged.domains
    }
  }
}
