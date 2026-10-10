/**
 * hotBoardRefresh —— 热门名人榜的每日生产端。
 *
 * 触发：定时触发器（cloudbaserc.json 的 triggers，默认每天 06:30）。
 * 环境变量（控制台 → 云函数 → hotBoardRefresh → 配置 → 环境变量）：
 *   BOCHA_API_KEY   博查检索 key（与 aiProxy / notifyFollowUpdates 共用同一枚）
 *   大模型 key 的变量名随供应商而变（DEEPSEEK_API_KEY / QWEN_API_KEY / …），
 *   由同目录 llm.config.js 决定 —— 换一家只改那张表 + LLM_PROVIDER（与 aiProxy 用同一家）。
 *
 * 为什么必须放在云端而不是端上生成：
 * 1. 榜单是**全局运营位**，一天一份、所有人看同一份。端上生成 = 每个用户各生成一次，
 *    既贵，又会出现「同一时刻不同用户看到不同榜单」。
 * 2. 端上生成要等一次检索 + 长生成（数秒），首屏运营位不能这样等。
 * 3. 榜单要「昨天有、今天也有」：这轮失败就保留上一份，端上照常可读。
 * 流程因此是「云函数按天生产 → 落 hot_board 集合 → 端上只读」。
 *
 * 生产三步：① 12 个领域各打一次博查（近一周）拿标题 + 摘要
 *          ② 摘要喂给大模型，产出 24 位（每领域 2 位）的 JSON 榜单
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
/* 供应商注册表 + 解析（换一家改它，不改本文件）。⚠ 与 aiProxy 目录下的副本逐字一致 */
const { resolveLlm } = require('./llm.config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const SEARCH_TIMEOUT_MS = 15000
const LLM_TIMEOUT_MS = 30000

const COLLECTION = 'hot_board'
/** 单文档覆盖写：端上永远只读这一份，不需要按日期查询 */
const DOC_ID = 'latest'
/** 20 小时内的榜单视为「今天已经生成过」，重复触发直接返回（定时器重试 / 端上补跑都会命中） */
const FRESH_MS = 20 * 60 * 60 * 1000
/**
 * 每领域出几位：12 × 2 = 24，与端上 BOARD_LIMIT（utils/hot-board.ts）一致。
 * 2026-10-08 领域从 6 个扩到 12 个时由 4 降到 2：检索是**并行**的（见 exports.main ①），
 * 但每个领域各自打一次博查，领域翻倍 ⇒ 上游检索次数翻倍，故用降位数把总条数框住 ——
 * 榜单总量与端上完全无感，代价只是单个领域从 4 位缩到 2 位。
 */
const PER_DOMAIN = 2
/** 校验下限：低于这个条数视为这轮失败，保留旧榜单（宁可用昨天的，也不要一份残缺榜） */
const MIN_ITEMS = 12
/** 至少要覆盖几个领域：防止模型全堆在文娱一个领域（12 个领域时，6 个只算及格） */
const MIN_DOMAINS = 6

/** 领域清单：与 src/config/domains.ts 的 DOMAIN_CODES 一一对应（增删必须同步，顺序保持一致） */
const DOMAINS = [
  { code: 'tech', label: '科技', query: '科技 企业家 最新动态 发布' },
  { code: 'internet', label: '互联网', query: '互联网 平台 产品负责人 最新动态' },
  { code: 'business', label: '商业', query: '商界 企业家 最新动态' },
  { code: 'finance', label: '财经', query: '投资人 经济学家 基金经理 最新观点' },
  { code: 'auto', label: '汽车', query: '车企 高管 新能源车 最新动态' },
  { code: 'ent', label: '文娱', query: '明星 艺人 最新动态 热搜' },
  { code: 'art', label: '艺术', query: '艺术家 导演 音乐家 最新作品' },
  { code: 'sports', label: '体育', query: '运动员 体育明星 最新比赛 动态' },
  { code: 'health', label: '健康', query: '医学专家 医生 公共卫生 最新研究' },
  { code: 'academia', label: '学术', query: '科学家 学者 最新研究成果' },
  { code: 'edu', label: '教育', query: '教育家 教师 教育行业 最新动态' },
  { code: 'other', label: '其他', query: '公众人物 热点 最新动态' }
]
const DOMAIN_CODES = DOMAINS.map((d) => d.code)
/** 提示词里的领域清单：从 DOMAINS 派生，增删领域码时不必再改提示词正文（写死必然漂移） */
const DOMAIN_LIST = DOMAINS.map((d) => `${d.code}（${d.label}）`).join('、')

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
    `1. 领域只能从这 ${DOMAINS.length} 个里选：${DOMAIN_LIST}，每个领域给 ${PER_DOMAIN} 位，共 ${total} 位。`,
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

/**
 * 从模型输出里取 JSON：字符串感知配对扫描 + 畸形修复（2026-10-10 重写，
 * 与端上 `utils/llm.ts#parseModelJson` 同口径）。
 *
 * 原来那版 `indexOf('{') + lastIndexOf('}')` 在两种情形下会取错，都表现为「模型明明返回了
 * 正文，却parse 不出来」：值里写了 `{}` 时 lastIndexOf 会落进字符串内部截缺尾括号；被上游
 * 截断时压根没有尾括号。故这里按「字符串外才算结构」扫，并对常见畸形做确定性修复。
 */
function extractJson(raw) {
  let s = String(raw || '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  const balanced = []
  let tail = null
  let topStart = -1
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    /* 全角括号（`｛｝［］`）也算结构：模型偶尔整段写成全角，这里不认就连候选片段都取不出来
       （连「语法错」都判不成），而它其实只需 repairJson 把结构位的全角归一半角。只用于定位，不改原文 */
    if (ch === '{' || ch === '[' || ch === '｛' || ch === '［') {
      if (depth === 0) topStart = i
      depth++
      continue
    }
    if (ch === '}' || ch === ']' || ch === '｝' || ch === '］') {
      if (depth === 0) continue
      depth--
      if (depth === 0 && topStart >= 0) {
        balanced.push(s.slice(topStart, i + 1))
        topStart = -1
      }
    }
  }
  /* 扫到末尾仍是正的深度 = 有容器没合上：这一段就是被砍断的那一段 */
  if (depth > 0 && topStart >= 0) tail = s.slice(topStart)

  /* 取最长的配平片段（模型先举格式示例时，示例必然短于正文）；未配平的尾段更长则用它 */
  let text = balanced.reduce((a, b) => (a === null || b.length > a.length ? b : a), null)
  if (tail && (text === null || tail.length > text.length)) text = tail
  if (!text) return null

  try {
    return unwrapSingleObject(JSON.parse(text))
  } catch (e) {
    /* 落到修复；截断的片段这里必然仍失败（不补右括号，理由见端上注释） */
  }
  try {
    return unwrapSingleObject(JSON.parse(repairJson(text)))
  } catch (e) {
    return null
  }
}

/**
 * 顶层 `[{...}]` → `{...}`（与端上 `utils/llm.ts#unwrapSingleObject` 同口径，改一端必须改另一端）。
 *
 * 模型偶尔把整个对象多包一层数组（它刚排过 `"items": []` 这类数组字段，顺手就多包了一层）。
 * 语法完全合法、内容一个字不差，但 normalizeItems 只认 `parsed.items` —— 取不到就判「榜单不合格」，
 * 整轮检索 + 生成全白跑，而这一切只因为多了一对方括号。仅在「长度为 1 且元素是普通对象」时解包：
 * 多元素时无从判断该取哪一个，那才是真的没按格式答。
 */
function unwrapSingleObject(value) {
  if (!Array.isArray(value) || value.length !== 1) return value
  const first = value[0]
  if (first === null || typeof first !== 'object' || Array.isArray(first)) return value
  return first
}

/**
 * 修复常见 JSON 畸形（只在原样解析失败后调用）：① 字符串内裸换行/制表符 → 转义；
 * ② 字符串内未转义的双引号 → `\"`（收尾引号后面只可能跟 `:` `,` `}` `]` 或结束，否则它是
 * 正文引号）；③ 字符串外的 `//` 与块注释 → 删；④ 尾随逗号 → 删；⑤ **字符串外**的全角标点
 * （`，` `：` `｛` `｝` `［` `］`）→ 归一半角。
 *
 * ⑤ 与端上 `utils/llm.ts#repairJsonText` **同口径，改一端必须改另一端**（两份是手抄关系，
 * 云函数不能 import 端上 TS）：中文模型把结构位的逗号写成全角是高频畸形，旧版只把它记进
 * 报错、不救，代价是整轮检索 + 生成白跑。判据仍是「字符串内 / 外」—— 正文里的全角标点
 * （`他说“好”，然后走了`）永远在字符串内、扫不到，能扫到的一定在结构位，不会碰到任何内容。
 *
 * 刻意不做的三件事：不把全角**引号**归一（引号是定界符，归一它就得保证开闭配对，而模型真用
 * 全角引号定界时往往还混着半角引号做正文，归哪个都是赌）；不给未配平片段补括号（补出来的是
 * 半句话，而榜单是全站共用的一份）；不归一单引号 / 无引号键 / `True` 这类「另一种语言的写法」
 * （判据不可能可靠 —— 正文里的撇号 `don't` 就是合法内容）。
 */
function repairJson(text) {
  let out = ''
  let inStr = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) {
        out += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        out += ch
        escaped = true
        continue
      }
      if (ch === '\n') {
        out += '\\n'
        continue
      }
      if (ch === '\r') {
        out += '\\r'
        continue
      }
      if (ch === '\t') {
        out += '\\t'
        continue
      }
      if (ch === '"') {
        let j = i + 1
        while (j < text.length && /\s/.test(text[j])) j++
        const next = j < text.length ? text[j] : ''
        /* 全角标点同样算「收尾引号后面该出现的字符」—— 结构位写成全角时，这里的判据若只认半角，
           会把**键的收尾引号**误判成正文引号（转义成 `\"`），结构直接崩 */
        if (
          next === '' ||
          next === ':' ||
          next === ',' ||
          next === '}' ||
          next === ']' ||
          FULLWIDTH_PUNCT[next] !== undefined
        ) {
          inStr = false
          out += '"'
        } else {
          out += '\\"'
        }
        continue
      }
      out += ch
      continue
    }
    /* ⑤ 字符串外的全角标点 → 半角。归一后**继续走下面同一套判据**（这里不 continue）：
       否则 `{"a":1，}` 会先变成 `{"a":1,}`、绕过尾随逗号那道处理，照样解析失败。
       能走到这里就说明不在字符串内，正文里的全角标点（`他说“好”，然后走了`）扫不到。 */
    const cur = halfPunct(ch)

    if (cur === '"') {
      inStr = true
      out += cur
      continue
    }
    if (cur === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      /* 闭合也可能是全角：`{"a":1,｝` 与 `{"a":1，}` 两种混搭都要认 */
      if (halfPunct(text[j]) === '}' || halfPunct(text[j]) === ']') continue
      out += ','
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += cur
  }
  return out
}

/** JSON 结构位真会出现的六个全角标点；**全角引号刻意不在其中**（理由见 repairJson 注释） */
const FULLWIDTH_PUNCT = {
  '，': ',',
  '：': ':',
  '｛': '{',
  '｝': '}',
  '［': '[',
  '］': ']'
}

/** 全角标点归一半角（字符串外专用）；不是全角就原样返回 */
function halfPunct(ch) {
  const half = FULLWIDTH_PUNCT[ch]
  return half === undefined ? ch : half
}

async function askLlm(llm, system, user) {
  const res = await postJson(
    `${String(llm.baseUrl || '').replace(/\/+$/, '')}/chat/completions`,
    { Authorization: `Bearer ${llm.apiKey}` },
    {
      model: llm.model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      ...(llm.extraBody || {})
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

/**
 * 构建锁的行号（P2-32）。与 `latest` 共用一个集合：端上只按 `doc('latest')` 读，
 * 多出来的这一行谁也读不到，不必为它再开一张需要配权限的表。
 */
const LOCK_ID = 'building'
/**
 * 锁的存活时间（P2-32）。锁只用来挡「同时」，不挡「已经建过」——后者归上面那道 20 小时
 * 新鲜度闸门管。成功路径会显式放锁（见 releaseBuildLock 的调用点）；而失败路径**故意不放**，
 * 让它在 TTL 内继续挡着 —— 上游刚刚才失败过，几秒后立刻重试大概率还是失败，只是再烧一次额度。
 * 万一函数在中途崩掉，锁行会留在这里，超过这个时长即视为死锁、可被后来者清掉重抢。
 * 取值只需大于「一次构建的最坏耗时」（检索 6 组并行 + 一次生成，实测 1 分钟内）。
 */
const BUILDING_TTL_MS = 5 * 60 * 1000

/** 放锁（P2-32）：只删锁行，不动榜单本身 */
async function releaseBuildLock() {
  await db
    .collection(COLLECTION)
    .doc(LOCK_ID)
    .remove()
    .catch((err) => console.warn(`[hotBoardRefresh] 放锁失败（不影响结果）：${(err && err.message) || err}`))
}

/**
 * 抢构建锁（P2-32）：返回 true = 可以开始构建，false = 已经有人在建。
 *
 * 原来那道幂等闸门是「读 `generated_at` → 比时间 → 开工」，两个人同时冷启动会**双双通过**，
 * 于是同一轮检索与生成被做了两遍（6 组领域检索 + 一次大模型调用，白花上游额度）。
 * 这里换成一个真原子操作：往集合里 `add` 一条 `_id` 固定的锁行 —— 主键唯一由存储层保证，
 * 抢到的写入成功，另一个必得重复键错误，没有「读了再写」的空隙。
 */
async function acquireBuildLock() {
  const nowIso = new Date().toISOString()
  try {
    await db.collection(COLLECTION).add({ data: { _id: LOCK_ID, at: nowIso } })
    return true
  } catch (err) {
    const msg = String((err && err.errMsg) || (err && err.message) || err)
    /* 只有「主键冲突」才解释成「已经有人在建」。其它错（集合没建、权限没开）是环境问题，
       而锁只是省钱的手段、不是正确性闸门 —— 不能因为它把榜单整个卡死，故放过并记一笔。 */
    if (!/already exists|duplicate|-502001/i.test(msg)) {
      console.warn(`[hotBoardRefresh] 构建锁不可用，按无锁继续：${msg}`)
      return true
    }
  }

  /* 锁被持有：先分清「真有人在建」和「上一轮崩了留下的死锁」 */
  let heldAt = NaN
  try {
    const res = await db.collection(COLLECTION).doc(LOCK_ID).get()
    heldAt = Date.parse((res && res.data && res.data.at) || '')
  } catch (e) {
    /* 读不到锁行：保守当成「有人在建」（最坏不过是晚一轮生成，不影响正确性） */
  }
  if (Number.isFinite(heldAt) && Date.now() - heldAt < BUILDING_TTL_MS) return false

  /* 死锁：清掉再抢一次；这次仍抢不到就认输（另一个实例也在清，交给它建） */
  await db
    .collection(COLLECTION)
    .doc(LOCK_ID)
    .remove()
    .catch(() => undefined)
  try {
    await db.collection(COLLECTION).add({ data: { _id: LOCK_ID, at: nowIso } })
    return true
  } catch (err) {
    return false
  }
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

  /* 调用方闸门（P0-21，2026-10-09）：本函数**必须**能被端上调用 —— 端上冷启动的
     `action:'ensure'`（见 utils/hot-board.ts#ensureRefresh）就是「今天还没生成 ⇒ 补跑一次」，
     这条链路不能断，所以这里不做「一律拒绝端上调用」。
     但 `force` 是另一回事：它跳过下面那道 20 小时幂等闸门，一次调用等于 6 组领域检索 + 一次生成。
     上面写着「force 只留给运维手动重建」，那就得真拦住：端上调用（getWXContext().OPENID
     非空）一律不许 force，否则任何人都能循环重建把上游额度烧光。 */
  if (event && event.force === true && (cloud.getWXContext() || {}).OPENID) {
    console.warn('[hotBoardRefresh] 拒绝端上 force：强制重建只允许定时器 / 控制台调用')
    return { ok: false, skipped: 'force 仅供运维使用（端上请用 action:ensure）' }
  }

  if (action === 'report') {
    const cur = await readBoard()
    return { ok: true, board: cur }
  }

  const bochaKey = readEnv('BOCHA_API_KEY')
  /* 供应商 / 端点 / key / 模型由 llm.config.js 统一裁决（与 aiProxy 同一张表、同一份副本） */
  const llm = resolveLlm(event)
  const llmKey = llm.apiKey
  if (!bochaKey || !llmKey || !llm.baseUrl) {
    /* 未配置不是错误：函数可能先于密钥上线部署，静默跳过即可（不产生失败告警） */
    return {
      ok: false,
      skipped:
        '缺少环境变量：' +
        [!bochaKey && 'BOCHA_API_KEY', !llmKey && llm.apiKeyEnv, !llm.baseUrl && 'LLM_BASE_URL']
          .filter(Boolean)
          .join(' / ')
    }
  }

  /* 幂等闸门。定时器重试、端上冷启动补跑、人为多点几次，都会撞在这里 ——
     一天最多打一轮上游，成本可控。force 只留给运维手动重建。
     注意这道闸门只管「不重复」，管不了「不同时」：两个冷启动实例会双双通过，
     所以紧接着还有一道构建锁（P2-32）。 */
  const cur = await readBoard()
  const curAt = cur && cur.generated_at ? Date.parse(cur.generated_at) : NaN
  if (!event || event.force !== true) {
    if (Number.isFinite(curAt) && Date.now() - curAt < FRESH_MS) {
      return { ok: true, skipped: 'fresh', generated_at: cur.generated_at, count: (cur.items || []).length }
    }
  }

  /* 抢构建锁（P2-32）：上面那道闸门只保证「不重复生成」，保证不了「不同时生成」。
     抢不到就当作已经有人在建 —— 这也是端上冷启动补跑最常见的撞车场景。 */
  if (!(await acquireBuildLock())) {
    return { ok: true, skipped: 'building', generated_at: cur && cur.generated_at }
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
    const content = await askLlm(llm, prompt.system, prompt.user)
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
    model: llm.model
  }
  try {
    const w = await writeBoard(doc)
    /* 构建成功、榜单已落库，锁的使命结束，立刻放掉（P2-32） */
    await releaseBuildLock()
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
