/**
 * aiProxy —— 平台代付模式的密钥闸门。
 *
 * 小程序包可解包、前端一切可见，平台自有 key 一旦下发到客户端即等同公开
 * （见 src/config/public.ts）。故 key 只活在服务端：本函数的环境变量里。
 *   控制台 → 云函数 → aiProxy → 配置 → 环境变量：
 *     BOCHA_API_KEY   博查搜索 key
 *     大模型 key 的变量名**随供应商而变**（DEEPSEEK_API_KEY / QWEN_API_KEY / …）：
 *     用哪家、去哪取 key 由同目录 llm.config.js 决定，本文件不动。
 *     2026-10-08 起供应商**由用户在「我的」页自选**，端上把 provider + model 带上来，本函数按
 *     那家去读对应的环境变量 —— 所以端上清单里列出的每一家都要在这里配好 key（缺一家 = 少一家可用）。
 *     LLM_PROVIDER 退为兜底（端上没带 / 带了不认识的 id 时才用），
 *     LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 仍可临时覆盖表内结果（但会锁死所有用户的档位）。
 * 严禁把 key 写进本文件或任何提交进 git 的文件。
 *
 * action：
 *   'test'   运维探针：真实各打一次上游，验证「环境变量已生效 + 能出网」。
 *            ⚠ 它**不是默认动作**，且要口令（环境变量 AI_PROXY_TEST_TOKEN，未配置一律拒绝）——
 *            每次调用都真花钱，而 action 是客户端可构造的字段：把缺省值绑在付费探针上，
 *            等于给任何调用者留一个「一次调用烧两笔上游钱」的开关（2026-10-09 修，见 exports.main）。
 *            端上「我的 → 测试连通性」入口已于 2026-10-07 移除（改为只保留「生成模型」选择），
 *            此动作现在只供控制台 / 云调用人工排障使用，业务链路只走 search / chat。
 *   'search' 业务转发：代理一次博查检索，供端上 search.ts 在用户未自配 key 时使用
 *   'chat'   业务转发：代理一次大模型对话，供端上 llm.ts 在用户未自配 key 时使用
 *
 * ⚠ 本函数同时是**付费闸门**（2026-10-07 起）：chat 的模型档位按会员身份放行，
 * search 的 count 上限同样分档（见 llm.config.js 的 memberOnlyModels / FREE_SEARCH_MAX 的注释）。
 * 「深度模式」（O-11）也只在这一层放行 —— 它现在只剩**素材加厚**（search 的 count 分档）：
 * chat 的输出上限（chatMaxTokens）自 2026-10-08 起对所有请求下发，不再按会员分档，
 * 理由是它是「这一轮要写多长」的客观需求而不是权益（截断会让整份报告降级，见下方注释）。
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
/* 供应商注册表 + 解析（换一家改它，不改本文件）。⚠ 与 hotBoardRefresh 目录下的副本逐字一致 */
const { resolveLlm } = require('./llm.config')
/* 服务端配额与限速（B8）：数值须与端上 MEMBER_BENEFITS 同值，用例钉住 */
const {
  QUOTA_POOLS,
  DEFAULT_PURPOSE,
  AUX_PURPOSE,
  ABUSE_TABLE,
  ABUSE_LIMITS,
  todayKey
} = require('./quota.config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const TIMEOUT_MS = 15000
const SNIPPET = 200

/*
 * 会员专属模型（「质」权益，2026-10-07）：清单已移到 llm.config.js 的 memberOnlyModels
 * （每家一份），resolveLlm 返回的 memberOnly 即「本次这个模型要不要卡会员」。
 * ⚠ 端上 src/config/public.ts 的 llm.models 决定 UI 与请求值，**云函数这份才是计费闸门** ——
 * 小程序包可解包，端上判定改包即可绕过，只有这里拦得住「非会员用最贵的那一档」。
 */

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
 * 对话输出上限（O-11 第二步 2026-10-07 只给会员，2026-10-08 起对所有请求下发）。
 *
 * 为什么不再按会员分档：「报告有多长」不是权益，而是事实 —— 报告正文是多段摘要 + 逐条动态的长
 * JSON，第二批（档案 / 关系 / 后续关注 / 名词解释 / 争议）又往**免费**提示词里加了 5 段，
 * 于是免费报告的 JSON 顶过了上游默认上限（DeepSeek 4096）。贴上限的后果不是「少一段」，
 * 而是尾部被截断 → JSON 解析不出 → 重试再失败 → 整份报告降级成纯文本简版：
 * 报告页的结构化卡片成批消失，看着像功能被删了，还白付两次生成的钱。
 * 它仍是**输出上限**而不是额度：不设时上游用自己的默认值，设了只是把上限抬到「够写完整份报告」。
 * 上限值随供应商配置（llm.config.js 的 chatMaxTokens，默认 8192）。
 */

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
 * 读 `memberships`（服务端权威，_id = openid，客户端完全不可见）—— **刻意不读
 * users.membership**：后者所在的那张表是「仅创建者可读写」，端上能改自己那一行，
 * 以它为准等于把「谁能用最贵那一档模型」交给客户端自证（改包者给自己写上 membership
 * 即可白用）。端上读的 users.membership 只是界面镜像，见 dbInit/schema.js 的两条 purpose。
 *
 * 与端上 utils/member.ts 同一口径：只认 expires_at，不校验 plan —— 有效期是唯一事实，
 * plan 只决定天数。
 *
 * 读库失败一律按**非会员**：方向与端上 readMemberState 一致 ——
 * 宁可让真会员这一次拿到降级模型（体验损失），也不能让非会员刷走最贵的那一档（成本损失）。
 */
async function isActiveMember(openid) {
  if (!openid) return false
  try {
    const res = await db.collection('memberships').doc(openid).get()
    const m = (res && res.data) || null
    const t = m && m.expires_at ? Date.parse(m.expires_at) : NaN
    return Number.isFinite(t) && t > Date.now()
  } catch (err) {
    return false
  }
}

/**
 * 当日配额计数：行不存在时 doc().get() 直接抛错（与 quotaGuard 的 readCount 同一现象），
 * 读失败一律按 0。
 *
 * 按 0 = **放行**是有意的：闸门自己读不到库，不能把所有人挡在生成之外。
 * 这里也不存在「攻击者把闸门打瘫」的口子 —— 这几张表的读写权限都在我们手上，
 * 端上既不能让它们读失败，也改不动其中的计数。
 */
async function readQuotaCount(table, id) {
  try {
    const res = await db.collection(table).doc(id).get()
    const c = res && res.data && res.data.count
    return typeof c === 'number' && c > 0 ? c : 0
  } catch (err) {
    return 0
  }
}

/**
 * 防滥用计数：**由本函数自己原子自增**，端上无法阻止 —— 这是它区别于产品额度的关键。
 *
 * 返回**自增之后**的计数；读不到 / 写失败时返回 null，由调用方放行。
 * 「先自增、再按返回值判定」是这里的关键（P1 修复，2026-10-09）：原实现是
 * 「先读计数 → 判超限 → 再自增」，两步之间留了一个 TOCTOU 窗口 —— 并发的一批请求会
 * 同时读到同一个旧值而全部放行，这个「成本硬边界」被一次性放大 N 倍。
 * 自增（db.command.inc）本身是原子的，所以「自增后判定」天然并发安全。
 *
 * 先 update(inc) 再按需 add：正常路径只有一次写；首次调用（行不存在）时 update 不生效
 * （updated === 0），再 add 建行。并发时两个请求可能同时走到 add，撞 _id 的那个由内层
 * catch 兜住 —— 那一刻行已经建好，改回自增路径补上这一次（不再「少计 1 次」）。
 *
 * 自增失败不拦调用（返回 null，只记一行 warn）：闸门的作用是限速，不该把一次写库抖动
 * 放大成「所有人都不能用」。而攻击者也没有办法让这里的写失败 —— 表的权限在我们手上。
 */

/**
 * 「行已存在」时原子自增一次，返回**有没有落实**（updated > 0）。
 *
 * ⚠ V-1（2026-10-09 复审）：`doc(id).update()` 打到**不存在的行**时，wx-server-sdk 的真实行为
 * 尚未在真机确认 —— 可能返回 `stats.updated === 0`，也可能**直接抛错**（两个版本上都出现过）。
 * 本函数只依赖「自增有没有落实」，与具体是哪种无关，故把抛错**一律归一成 0**：
 * 若按「抛错 = 故障」处理（即让异常浮到外层 catch），那么每个用户每天**首次**调用
 * （那一行还不存在）都会直接进 catch 返回 null（放行）⇒ 计数行永远建不起来、这道成本硬边界
 * 静默失效。这正是 V-1 指出的风险点，归一成 0 后两种真机行为下结论完全一致。
 */
async function incrAbuseRow(key) {
  try {
    const upd = await db.collection(ABUSE_TABLE).doc(key).update({ data: { count: db.command.inc(1) } })
    return (upd && upd.stats && upd.stats.updated) || 0
  } catch (err) {
    return 0
  }
}

async function bumpAbuseCount(key, openid) {
  try {
    if (!(await incrAbuseRow(key))) {
      try {
        await db
          .collection(ABUSE_TABLE)
          .add({ data: { _id: key, _openid: openid, count: 1, date: todayKey() } })
        return 1
      } catch (err) {
        /* 并发：另一端刚插好这一行，改回自增路径补上本次；仍失败则返回 null 由调用方放行 */
        if (!(await incrAbuseRow(key))) return null
      }
    }
    return await readQuotaCount(ABUSE_TABLE, key)
  } catch (err) {
    console.warn('aiProxy 防滥用计数自增失败（本次放行）:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 真正付费的上游调用之前的闸门（B8，2026-10-09）。返回 null = 放行，否则返回拒绝体。
 *
 * ## 两道闸，防两件不同的事（详述见 quota.config.js 顶部）
 *
 * 1. **产品额度**（辅助调用除外）：读 quotaGuard 维护的当日计数，比对与端上同值的上限。
 *    它防的是「端上与云端口径不一致」——多设备各算一份、或设备时钟偏差让端上以为还有额度。
 *    ⚠ 这道闸的计数是端上主动调 quotaGuard 才写的，改包者不调就永远是 0，
 *      所以它**不是安全边界**，只是口径兜底（旧注释曾称云端是最终判定，那是不准确的）。
 *
 * 2. **防滥用限速**：计数由本函数就地原子自增（bumpAbuseCount），端上无法阻止 ——
 *    于是「解包把上限改大、随便调」的代价被压进 ABUSE_LIMITS 之内。**这才是成本侧的硬边界**。
 *
 * 会员档位一律取自 `memberships`（端上不可读写，见 isActiveMember），故自授会员无助于成本。
 *
 * 拒绝体的 kind：'quota'（产品额度用完，文案与端上 utils/member.ts#quotaExhaustedMessage
 * 同构 —— 同一种「额度用完」在不同路径上应当说同一句话）与 'abuse'（触发限速）。
 * 两者都不在端上 llm.ts 的 RETRYABLE_KINDS 里 ⇒ 不重试、不点冷却，文案原样透传。
 */
async function quotaGate(openid, purpose, isMember) {
  const member = await isMember()
  const kind = purpose || DEFAULT_PURPOSE
  const today = todayKey()

  /* ① 产品额度：辅助调用不占额度（理由见 quota.config.js 的 AUX_PURPOSE） */
  if (kind !== AUX_PURPOSE) {
    const pool = QUOTA_POOLS[kind] || QUOTA_POOLS[DEFAULT_PURPOSE]
    const limit = member ? pool.member : pool.free
    const count = await readQuotaCount(pool.table, `${openid}#${today}`)
    if (count >= limit) {
      const who = member ? '会员' : '免费版'
      const head =
        kind === 'ask'
          ? `今日提问次数已用完（${who}每日 ${limit} 次），明日 0 点恢复`
          : `今日报告生成额度已用完（${who}每日 ${limit} 次），明日 0 点恢复`
      const upsell = member ? '' : `；开通会员可提到每日 ${pool.member} 次`
      return { ok: false, kind: 'quota', error: `${head}${upsell}` }
    }
  }

  /*
   * ② 防滥用限速：**先自增、再按自增后的值判定**（P1 修复，2026-10-09）。
   *    原实现「先读 → 判 → 再记」中间留了一个 TOCTOU 窗口：并发的一批请求会同时读到
   *    同一个旧值而全部放行，于是这个「成本硬边界」可以被一次性放大 N 倍。
   *    自增是原子的，超限的请求自己也把计数吃掉，上限才真的是硬的。
   *    计数读不到（返回 null，库抖动）时放行 —— 它限的是速，不该把写库抖动放大成
   *    「所有人都不能用」（与 readQuotaCount 按 0 放行同一哲学）。
   */
  const abuseLimit = member ? ABUSE_LIMITS.member : ABUSE_LIMITS.free
  const abuseKey = `${openid}#${today}`
  const abuseCount = await bumpAbuseCount(abuseKey, openid)
  if (abuseCount !== null && abuseCount > abuseLimit) {
    return {
      ok: false,
      kind: 'abuse',
      error: `今日调用次数已达上限（${abuseLimit} 次），明日 0 点恢复；如确实需要更多请向我们反馈`
    }
  }
  return null
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

/** 探测当前供应商是否可用：端点 / 模型 / key 都取自 resolveLlm，换一家后测的就是换过去的那家 */
async function probeLlm(llm) {
  const res = await postJson(
    `${String(llm.baseUrl || '').replace(/\/+$/, '')}/chat/completions`,
    { Authorization: `Bearer ${llm.apiKey}` },
    {
      model: llm.model,
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
 * 探针：把上游响应的**结构**（键名 + 条数，不含任何正文）摘一小份回端上。
 *
 * 起因：博查的响应是 Bing 兼容结构，图片在 `data.images.value`、视频在 `data.videos.value`，
 * 与 `webPages` **同级**；而 runSearch 只把 webPages 交给端上，于是「博查到底返不返回图片/视频、
 * 字段叫什么」这个问题在端上永远看不到答案。要往报告里加图，得先答这个问题。
 * 端上把它记进诊断日志（search.ts），一次真实检索就能看清，不必再猜。
 *
 * 只回键名与计数：正文可能几万字，绝不往这里塞。
 */
function probeOf(body) {
  const d = (body && body.data) || {}
  const isObj = (v) => !!v && typeof v === 'object'
  const firstKeys = (list) => {
    const v = list && Array.isArray(list.value) ? list.value[0] : null
    return isObj(v) ? Object.keys(v).slice(0, 30) : []
  }
  const sizeOf = (list) => (list && Array.isArray(list.value) ? list.value.length : 0)
  return {
    dataKeys: Object.keys(d).slice(0, 20),
    pageKeys: firstKeys(d.webPages),
    images: sizeOf(d.images),
    imageKeys: firstKeys(d.images),
    videos: sizeOf(d.videos),
    videoKeys: firstKeys(d.videos)
  }
}

/**
 * 业务转发：一次博查检索。
 *
 * 刻意只回上游原始 webPages 数组，不在这里做字段映射——
 * 端上 search.ts 的 toNewsItem 是字段兜底的唯一来源，两处各写一份必然漂移。
 * （probe 是例外：它不回内容，只回「上游响应里有哪些键」，见 probeOf。）
 *
 * 返回值带上 kind：端上据此决定「要不要重试」。
 *   rate / auth / quota / unconfigured / badrequest → 重试无意义
 *   upstream / network                              → 可退避重试
 *
 * ⚠ `quota` **只**表示「用户自己的产品额度被闸门拦下」（见 quotaGate）。上游自己的欠费 / 未开通
 * 资源包一律用 `upstream_quota`（P2-9，2026-10-09）：两者处置相同（都不重试），但**不能说同一句话**
 * —— 把平台账户问题说成「你的额度用完了」，用户去查额度页会发现是满的，只能来问客服。
 */
async function runSearch(key, params) {
  const res = await postJson(BOCHA_ENDPOINT, { Authorization: `Bearer ${key}` }, params, TIMEOUT_MS)
  const body = res.data

  if (res.status === 429) return { ok: false, kind: 'rate', error: '搜索源请求过于频繁，请稍后再试' }
  if (res.status === 401) {
    return { ok: false, kind: 'auth', error: '检索密钥无效（请检查云函数环境变量 BOCHA_API_KEY）' }
  }
  /**
   * 403 = 上游（博查）没开通资源包 / 自己欠费 —— 是**平台账户**的问题，不是用户的额度，
   * 故用 `upstream_quota` 而不是 `quota`（P2-9；端上按 kind 分流文案，混用会把用户引去查自己的额度）。
   */
  if (res.status === 403) {
    return { ok: false, kind: 'upstream_quota', error: '检索额度不足或未开通权限（博查资源包）' }
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
  /* probe 跟着成功返回一起走，端上只在诊断日志里记一笔（不改任何检索行为） */
  return { ok: true, pages, probe: probeOf(body) }
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

  /*
   * 付费闸门（P1 修复，2026-10-09）：search 同样是一次**真实付费调用**（博查按次计费），
   * 而原实现这条路径上什么闸门都没有 —— 不判额度、不写 ai_calls、连 openid 都不要，
   * 于是 `{action:'search', count:20}` 循环调用就能无上限刷掉资源包。
   *
   * 走 aux 档：检索是生成 / 刷新内部的零件，产品额度在 generate 那一侧已经计过一次，
   * 这里不重复扣额度，只受防滥用限速闸（ABUSE_LIMITS，由云端就地自增，端上无法阻止）。
   * chat 走的是同一道闸门（见 handleChat）。
   */
  const openid = (cloud.getWXContext() || {}).OPENID
  if (!openid) {
    return { ok: false, kind: 'auth', error: '取不到调用者 openid：search 只允许从小程序端调用' }
  }

  /* 会员身份一次读库、两处共用（闸门判档位 + 下方 count 的 cap）：同一次请求不查两遍权威表 */
  let memberKnown = null
  const isMember = async () => {
    if (memberKnown === null) memberKnown = await isActiveMember(openid)
    return memberKnown
  }

  const gate = await quotaGate(openid, AUX_PURPOSE, isMember)
  if (gate) return gate

  const count = Number(event.count)
  const include = normalizeInclude(event.include)
  const want = Number.isFinite(count) && count > 0 ? Math.floor(count) : 10
  /*
   * 只有「要得比免费上限还多」时才用到会员身份：
   * 端上主线 / 支线默认都在 20 以内，故绝大多数请求不会为此多一次读库
   * （上面那道闸门已经读过一次，这里是同一个 memo）。
   */
  const cap = want > FREE_SEARCH_MAX && (await isMember()) ? MEMBER_SEARCH_MAX : FREE_SEARCH_MAX
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
  /*
   * 先要求登录身份（A3，2026-10-09）：chat 是「平台付钱、客户端随便调」的通道，
   * 配额要按人计、会员要按人判 —— 取不到 openid 时两者都无从谈起，闸门形同虚设，
   * 只剩「谁都能白调一次最贵的模型」。故直接拒绝。
   * 云函数之间不会调本函数（hotBoardRefresh / riskWatch 等自带环境变量 key 直连上游），
   * 所以这道要求不会打断任何定时任务。
   */
  const openid = (cloud.getWXContext() || {}).OPENID
  if (!openid) {
    return { ok: false, kind: 'auth', error: '取不到调用者 openid：chat 只允许从小程序端调用' }
  }

  /*
   * 用哪家、哪个端点、哪把 key、哪个模型，全部由 llm.config.js 裁决（换一家不改这里）。
   * event.provider 即用户在「我的 → 模型供应商」选的那家，**以它为准**；key 仍是平台自己的
   * （该家环境变量里的那一枚），用户为零配置 —— 他付的是额度，不是 key。
   */
  const llm = resolveLlm(event)
  if (!llm.baseUrl) {
    return {
      ok: false,
      kind: 'unconfigured',
      error: `未配置大模型端点（供应商 ${llm.provider}；请设置环境变量 LLM_BASE_URL）`
    }
  }
  const key = llm.apiKey
  if (!key) {
    return {
      ok: false,
      kind: 'unconfigured',
      error: `平台未配置大模型额度（云函数环境变量 ${llm.apiKeyEnv}）`
    }
  }

  const norm = normalizeMessages(event.messages)
  if (norm.error) return { ok: false, kind: 'badrequest', error: norm.error }

  /* 模型名已在 resolveLlm 里按「LLM_MODEL > 端上传入（仅同一家）> 该家默认」定好 */
  const requested = llm.model

  /*
   * 会员闸门：端上传的模型名只是「请求」，这里才是裁决点。
   * 非会员请求会员专属档位 → **静默降级**为默认模型并把 downgraded 回传：
   * 生成照常出结果（不因一次残留偏好 / 改包就给用户一句报错），
   * 但代价最高的那一档不会被白用。端上按 downgraded 在诊断日志里记一笔。
   */
  let model = requested
  let downgraded = false
  /* 会员身份一次读库、两处共用（模型闸门 + 配额闸门）：同一次请求不查两遍权威表 */
  let memberKnown = null
  const isMember = async () => {
    if (memberKnown === null) memberKnown = await isActiveMember(openid)
    return memberKnown
  }
  if (llm.memberOnly && !(await isMember())) {
    model = llm.defaultModel
    downgraded = true
  }

  /*
   * 配额闸门（B8）：放在这里 —— 上面全是不花钱的前置校验，下面才开始真正付费。
   * 端上发起生成前也判一次（utils/quota.ts / qa.ts），那道门管的是界面与提前拦截；
   * 这道门管的是「改包者把端上那份上限改大」—— 上限、计数、会员身份三者全在云端。
   */
  const gate = await quotaGate(openid, event.purpose, isMember)
  if (gate) return gate

  /*
   * 输出上限对所有请求下发（理由见文件上方 chatMaxTokens 那段）：不给它，上游就用默认上限，
   * 而报告 JSON 比默认上限长。这里不查会员身份 —— 一次读库留给上面那道「模型档位」闸门就够了。
   */
  const payload = { model, stream: false, messages: norm.messages, max_tokens: llm.chatMaxTokens }

  let res
  try {
    res = await postJson(
      `${String(llm.baseUrl).replace(/\/+$/, '')}/chat/completions`,
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
    return { ok: false, kind: 'auth', error: `大模型密钥无效（请检查云函数环境变量 ${llm.apiKeyEnv}）` }
  }
  /* 402 = 上游账户余额不足（Payment Required），与 401 是两回事，分开报才定位得到 */
  if (res.status === 402) {
    /* P2-9：用 upstream_quota 而非 quota —— 这是**平台账户**欠费，说成「你的额度用完了」会误导用户 */
    return { ok: false, kind: 'upstream_quota', error: '大模型额度不足（上游账户余额）' }
  }
  /*
   * 403 = 上游拒绝访问（未开通 / 被风控）。原先落进下面的 4xx 兜底 → kind='upstream' →
   * retryable=true → 端上会带着退避**重试三次**，而 403 重试必然还是 403（白烧三次真实请求、
   * 还把文案说成「上游服务异常，可稍后重试」）。归入 upstream_quota：不重试，且文案指向配置。
   */
  if (res.status === 403) {
    return {
      ok: false,
      kind: 'upstream_quota',
      error: `上游拒绝访问（HTTP 403）：多为资源包未开通或额度告急 —— ${snippet(res.data) || '无响应体'}`
    }
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
  /*
   * finishReason 原样回传端上：'length' = 输出撞上 max_tokens、被上游截断了。
   * 报告这类长生成的失败基本都出在这里，端上据此在诊断日志里留一笔，下次不必靠猜。
   */
  const finishReason = choices[0].finish_reason || ''
  return { ok: true, content, model, downgraded, finishReason }
}

/*
 * 共享缓存写口（P0-2，2026-10-09）：实现在 report-store.js，依赖全部复用本文件里已有的
 * 那一份（会员权威判定 / 防滥用计数 / 错误摘要 / db / cloud），不另起一套口径。
 * 实例化放在这里：上面的函数声明都已就位。
 */
const createReportStore = require('./report-store')
const handleReportStore = createReportStore({
  db,
  cloud,
  isActiveMember,
  bumpAbuseCount,
  todayKey,
  failDetail
})

exports.main = async (event) => {
  /*
   * 默认值刻意**不是** 'test'（A3，2026-10-09）：'test' 会向博查与大模型各发一次真实付费探测，
   * 而 action 是客户端可构造的字段 —— 把缺省值与付费探针绑在一起，等于给任何调用者
   * 留一个「一次调用烧两笔上游钱」的开关。缺省 / 未知一律落在下面的错误分支里，不触达上游。
   */
  const action = (event && event.action) || ''
  if (action === 'search') return handleSearch(event || {})
  if (action === 'chat') return handleChat(event || {})
  /* 共享缓存写口（P0-2）：不需要口令，但要求登录身份，且 op 会过写口自己的限速 */
  if (action === 'report') return handleReportStore(event || {})
  if (action !== 'test') {
    return { ok: false, error: `未知 action：${action}（支持 test / search / chat / report）` }
  }

  /*
   * 运维探针要口令：它不是业务动作，而是「把两家上游 key 的有效性与余额探一遍」，
   * 每次调用都真花钱。口令取环境变量 AI_PROXY_TEST_TOKEN，**未配置时一律拒绝**
   * （fail-closed：宁可让开发者多配一个变量，也不留一个匿名可调的付费探针）。
   * 与 dbInit 的 DB_ADMIN_TOKEN 同一模式。
   */
  const testToken = readEnv('AI_PROXY_TEST_TOKEN')
  if (!testToken || (event && event.token) !== testToken) {
    return {
      ok: false,
      error:
        '探测动作需要口令：请在云函数环境变量里配置 AI_PROXY_TEST_TOKEN，并在 event.token 里带上同一个值'
    }
  }

  const bochaKey = readEnv('BOCHA_API_KEY')
  /* 探测也走同一张供应商表：换一家后，「测试」测的就是换过去的那家 */
  const llmConf = resolveLlm(event)
  const llmKey = llmConf.apiKey

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

  if (!llmKey) llm.detail = `未配置环境变量 ${llmConf.apiKeyEnv}`
  else if (!llmConf.baseUrl) llm.detail = `未配置端点（供应商 ${llmConf.provider}）`
  else {
    try {
      Object.assign(llm, await probeLlm(llmConf))
    } catch (err) {
      llm.detail = failDetail(err)
    }
  }

  return {
    ok: bocha.ok && llm.ok,
    checked_at: new Date().toISOString(),
    provider: llmConf.provider,
    model: llmConf.model,
    bocha,
    llm
  }
}
