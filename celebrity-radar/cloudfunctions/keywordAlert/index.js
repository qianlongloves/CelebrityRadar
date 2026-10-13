/**
 * keywordAlert —— 关键词舆情预警：定时检索用户订阅的词，出现新报道时落站内预警并提醒一次。
 *
 * 触发 / 入口（P4，2026-10-13 起两条路，靠 event.action 区分）：
 *   · `event.action === 'add'` —— **新增订阅**：端上在「订阅」时调用。按 memberships
 *     （权威会员表）分档判「还能不能再加一个」（免费 1 / 会员 10），结果**显式回执**
 *     （`{ ok, reason, limit, tier, count }`）——**绝不静默丢弃**（见 handleAdd）。这条写入
 *     路径是**真正的成本边界**：端上 utils/keyword-alert.ts 那道分档门禁只是体验层，可被改包绕过。
 *   · 无 action 且无调用方 openid —— **定时扫描**：由 cloudbaserc.json 的触发器驱动
 *     （默认每天 09:20，与 notifyFollowUpdates 09:00 错开：两个任务都要打博查，
 *     挤在同一个 60s 窗口里会互相拖慢甚至半途超时；错开后上游限流也更容易扛住）。
 *
 * ⚠ 两个「上限」是两件事，改代码前必须分清（本轮缺陷正是混成一把造成的）：
 *   ① **新增上限（按档）** WATCH_LIMITS.free / .member —— 只拦「还能不能再加一个」，写入路径判定；
 *   ② **扫描口径** —— 定时扫描**不按①裁剪存量**：存量用户（免费档历史上可能 >1 个）与会员的
 *      第 6~10 个词都必须照常扫描，否则既有订阅会静默停摆（违反「只拦新增，不删存量」）。
 *      每轮成本由全局 MAX_KEYWORDS 预算 + fetched_at 轮转兜住，不靠「每人裁几个」。
 *
 * 环境变量（控制台 → 云函数 → keywordAlert → 配置 → 环境变量）：
 *   BOCHA_API_KEY     博查搜索 key（与 aiProxy / notifyFollowUpdates 共用同一枚）**缺失则整轮跳过**
 *   ALERT_TEMPLATE_ID 预警推送的模板 ID，须与 src/config/public.ts 的 alertTemplateId 同模板。
 *                     **缺失不算错误**：只写站内预警、跳过推送（模板要单独去公众平台申请，
 *                     没申请之前这个功能也该能长出东西来，否则「预警」永远停在「待配置」）
 *
 * 消息模板字段（与 notifyFollowUpdates 用同一个模板即可，键名必须含这两项）：
 *   thing1  提醒内容（≤20 个字符）
 *   date2   更新时间
 *
 * ⚠ 与 notifyFollowUpdates 的授权**不能共用**：微信一次性订阅按**模板**消耗授权，两个任务
 * 共用一个 subscribe_ok / 一个模板，就会出现「先跑的那个把授权吃掉，后跑的必得 43101」。
 * 故本函数用 users.alert_ok + ALERT_TEMPLATE_ID 这一对独立授权。
 *
 * 四个设计取舍：
 * 1. **规则判定，不用模型**。预警要的是「有情况」而不是「怎么解读」：模型判情绪等于每天为几十条
 *    标题付一次钱，而结论无法向用户解释（用户看不见打分过程）。这里只用一条能复现、能解释的规则：
 *    本轮新出现的报道条数 ≥ ALERT_MIN_ITEMS 就报「舆情升温」，1 条报「有新报道」，0 条不报。
 *    宁可少报、不可乱报 —— 预警一旦误报几次，用户就再也不看它了。
 * 2. **缓存按关键词全局共享，不按用户**。博查按次计费，同一个人订阅的词被 3 个用户订阅就查 3 次
 *    是真金白银。`keywords` 表 _id 就是关键词原文，跨用户去重后一轮最多打 MAX_KEYWORDS 次上游。
 * 3. **扫描队列按 fetched_at 升序轮转**，而不是按订阅人数排序。订阅人数排序会让冷门词永远轮不到
 *    （饿死）；按「上次扫描时间最久的先查」则每个词都会被轮到，20 个/天的预算下最坏几天轮一圈。
 * 4. **新条目由我们自己的时钟打 first_seen_at**，不用媒体发布时间：博查给的 datePublished 可能是
 *    相对时间（「3 天前」）甚至是抓取时间，用它判断「这条是不是新的」会把旧闻反复当成新闻推出去。
 *
 * P4-A（2026-10-13）**事件驱动深挖**：扫描命中（该词本轮确有新报道）时，对该词再**扩查一个
 * 查询词**（对象 + 中性语境后缀，见 DEEP_DIVE_SUFFIXES），把新条目并入关键词缓存（keywords.items）
 * ——于是下一轮 opinionCluster 会把它当作该关键词事件的**补充成员**，让「盯」真正看到进展。
 *
 * ⚠ **只在命中时触发，绝不改成「每轮把所有词都深挖一遍」**（那会让成本随订阅数线性膨胀，
 *   与有没有进展无关）。命中是低频事件，这才是成本可控的根本原因。预算由 `DEEP_DIVE`
 *   （真源 src/config/benefits.ts）的三层闸门封顶，超限**记录不静默丢弃**（见 deepDive* 一组函数）。
 *
 * ⚠ **相关性闸门（2026-10-13 修，线上实测暴露）**：上游是宽松匹配，深挖可能带回与对象无关的
 *   条目（实测「迪丽热巴 最新进展」带回赵丽颖 / 萨利巴 / TVB 等）。故并入 `keywords.items`
 *   前必须过 `isDeepDiveRelated`（title+summary 需含对象名），**只作用于深挖条目**，
 *   扫描/推送口径一个字不动；丢弃条数计入回执 `deep_dive.filtered`。详见该函数注释。
 */

const cloud = require('wx-server-sdk')
const https = require('https')

/**
 * 分档新增上限的数值**不手写**：取自真源 `src/config/benefits.ts#OPINION_LIMITS`
 * （经 `npm run config:sync` 生成同目录的 benefits.config.js），
 * 与端上 utils/opinion-access.ts#watchLimit 读的是同一份数据（用例 14 钉住副本一致性）。
 */
const { OPINION_LIMITS, DEEP_DIVE } = require('./benefits.config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const TIMEOUT_MS = 15000
/** 单轮最多检索多少个关键词：博查按次计费，云函数默认 60s 超时也撑不住更多 */
const MAX_KEYWORDS = 20
/**
 * 关键词订阅的**分档新增上限**（免费 1 / 会员 10）—— 这是「**还能不能再加一个**」的上限，
 * 只在**写入路径**（见下方 handleAdd）上判。
 *
 * ⚠ 它**不是**定时扫描的裁剪线：两者是两件事，混成一把就会出事 ——
 *   · 拿它当扫描线 ⇒ 存量用户会被停扫（免费档历史上可能已订了 >1 个；会员上限 10，
 *     旧版扫描线却是每人不分档的 5，会员的第 6~10 个词会被整行忽略）。用户以为在盯、
 *     实际没扫，等于对用户撒谎 —— 这正是本轮修的核心缺陷。
 *   · 不写入路径判 ⇒ 改包者能订上千个词，把每天 MAX_KEYWORDS 次的上游检索预算吃光。
 *
 * 判定权威在云端（读 `memberships`），端上 utils/keyword-alert.ts 那道是体验层、可被改包绕过。
 */
const WATCH_LIMITS = OPINION_LIMITS.watchCount
/**
 * 订阅词的字符数上限（P2-31）。**与端上 src/utils/keyword-alert.ts#KEYWORD_MAX_CHARS 同源**。
 *
 * 端上也拦一道，但改包可以绕过 —— 而一个几百字的「词」照样要占掉一次上游检索
 * （每轮总共只有 MAX_KEYWORDS 次预算），把检索花在一个句子上的效果约等于零。
 * 超长整行忽略：这是数据问题，不是环境问题，重试也不会变好。
 */
const MAX_KEYWORD_CHARS = 12
/** 同一个关键词的最短重检间隔：与端上「今天已查过」的体感对齐，也避免定时任务与人工补跑重复打上游 */
const REFRESH_GAP_MS = 20 * 60 * 60 * 1000
/** 每个关键词保留的条目上限：预警只看最近这批，无限追加会让文档长到无法读写 */
const MAX_ITEMS = 20
/** 条目摘要入库前的截断（预警卡上一句话就够，不必把正文都存下来） */
const SUMMARY_MAX = 80
/** 判定为「舆情升温」的最少新增条数 */
const ALERT_MIN_ITEMS = 2
/** thing 类字段的字符数上限（微信按字符算，中文一个算一个） */
const THING_MAX = 20

const WATCH_TABLE = 'keyword_watches'
const CACHE_TABLE = 'keywords'
/** 服务端权威会员表（_id = openid，客户端完全不可读写，见下方 isActiveMember） */
const MEMBERSHIP_TABLE = 'memberships'
/** 深挖单日预算计数表（_id = yyyy-MM-dd，+8 时区，客户端完全不可读写）—— P4-A 成本闸门 */
const DEEP_DIVE_TABLE = 'deep_dive_quota'

/**
 * 深挖的候选查询词后缀（**中性语境词，不含任何评价性表述**）：
 * 命中后按 `对象 + 后缀` 生成候选词，只取前 `DEEP_DIVE.queriesPerHit` 个去扩查。
 * 「最新进展」回答的正是「这件事有没有新的一步」（P4-A 的目标），且措辞中性、不带定性。
 */
const DEEP_DIVE_SUFFIXES = ['最新进展', '回应']

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

/** 博查 {url} 的主机名，用作 source 的兜底（与端上 utils/search.ts#hostOf 同口径） */
function hostOf(url) {
  return String(url || '')
    .replace(/^https?:\/\//, '')
    .split('/')[0]
}

/** 统一成 ISO：只用于展示，不参与「是不是新的」判定（见文件头取舍 4） */
function normDate(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/** 按字符数截断（中文按字符计） */
function clamp(text, max) {
  const chars = Array.from(String(text || '').trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

/** date 类字段要求 yyyy-MM-dd HH:mm 形态 */
function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 关键词检索 → 条目[]。
 * freshness 取 oneDay：预警关心的是「刚发生的事」，一周内的旧闻天天重推就是骚扰。
 */
async function searchKeyword(keyword, key) {
  const res = await postJson(
    BOCHA_ENDPOINT,
    { Authorization: `Bearer ${key}` },
    { query: keyword, freshness: 'oneDay', summary: true, count: 10 },
    TIMEOUT_MS
  )
  const code = Number((res.data && res.data.code) ?? res.status)
  if (res.status !== 200 || code !== 200) {
    throw new Error(`HTTP ${res.status} / code ${code}`)
  }
  const inner = res.data && res.data.data
  const pages = (inner && inner.webPages && inner.webPages.value) || []
  return pages
    .map((p) => {
      const url = String(p.url || '').trim()
      const item = {
        title: String(p.name || '').trim(),
        url,
        /* summary 是详细摘要、snippet 是短摘，与端上「前者优先」的取值一致 */
        summary: clamp(String(p.summary || p.snippet || '').trim(), SUMMARY_MAX),
        source: String(p.siteName || '').trim() || hostOf(url)
      }
      const published = normDate(p.datePublished) || normDate(p.dateLastCrawled)
      if (published) item.published_date = published
      return item
    })
    .filter((x) => x.url && x.title)
}

/* ───────────── 事件驱动深挖：三层预算闸门（P4-A，2026-10-13）───────────── */

/**
 * 服务端「今天」（+8 时区）：云函数时区为 UTC，必须显式 +8。
 * 口径与 quotaGuard#todayKey 同源 —— 深挖计数按北京时间切天，跨天即新行（天然重置）。
 */
function todayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 命中对象 → 深挖候选查询词。只取前 `DEEP_DIVE.queriesPerHit` 个（第一层闸门）。
 * 对象为空或词数上限为 0 时返回空数组（不发任何上游请求）。
 */
function deepDiveQueries(object, max) {
  const base = String(object || '').trim()
  const n = Math.max(0, Number(max) || 0)
  if (!base || n <= 0) return []
  return DEEP_DIVE_SUFFIXES.slice(0, n).map((suffix) => `${base} ${suffix}`)
}

/**
 * 深挖条目的**相关性判定（纯函数，与 riskWatch/index.js 逐字同源）**。
 *
 * 缺陷背景：上游（博查）是**宽松匹配** —— 实测 `迪丽热巴 最新进展` 会带回与对象完全无关的条目
 * （赵丽颖昆仑饭店、萨利巴/阿森纳、TVB 女星退圈）。深挖结果原样并入 `keywords.items` 后，
 * 下一轮 opinionCluster 会把它们当作该关键词事件的**补充成员** ⇒ 事件时间线变脏。
 * 故并入前必须先过这道闸门：**深挖条目必须与对象相关，否则丢弃**。
 *
 * 规则（确定性，可测）：`title + summary` 归一化后必须**包含**对象名（归一化后）。
 *   · 「归一化」= 小写 + 去掉间隔号 / 空格等（见 NAME_SEPARATORS）
 *     —— 于是「迪丽热巴」能匹配「迪丽热巴」，也能匹配「张·三」↔「张三」这类写法差异。
 *
 * ⚠ **不引入外部别名词典**（避免误伤）：项目里没有权威的「人物别名 / 简称」来源，自己编一张
 *   别名表会把「同一个人」的判定交给猜测，宁可漏判也不误判。只做「对象名本身 + 去间隔号 / 空格」
 *   这类**确定性变换**。局限：无法覆盖真正的简称（「迪丽热巴」与「热巴」共享字面但长度不同，
 *   本规则**故意不认**——半个名字不足以证明是同一个人；同理「精灵副将」这类外号更不认）。
 *   ——这是刻意的保守取舍：少并入几条相关条目，好过多并入几条无关条目把时间线污染。
 *
 * ⚠ **只作用于深挖条目**：扫描命中判定与推送语义一个字都不动（见 main 里的并入分支）。
 */
const NAME_SEPARATORS = /[\s·・.'’‘"“”\-—–_]+/g

/** 归一化：小写 + 去掉间隔号 / 空格（确定性变换，不依赖别名词典） */
function normalizeName(text) {
  return String(text || '').toLowerCase().replace(NAME_SEPARATORS, '')
}

function isDeepDiveRelated(item, object) {
  const target = normalizeName(object)
  /* 对象名净化后为空（空串 / 纯符号）→ 不并入任何条目：否则「空串匹配一切」会把噪声全放进来 */
  if (!target) return false
  const text = normalizeName(`${(item && item.title) || ''} ${(item && item.summary) || ''}`)
  return text.includes(target)
}

/**
 * 原子预留一次「单日深挖额度」（第三层闸门）。
 *
 * 做法：先确保当日行存在（count=0），再用**单文档条件自增** `count < perDayMax` 时 `inc(1)`
 * 原子预留一格 —— `stats.updated === 1` 才算预留成功。多轮 / 并发同时触发也只能把这一行
 * 加到 `perDayMax` 为止（不会超发）；预留失败即当日超限。
 *
 * 读 / 写异常一律按**未预留**处理（fail-closed：无法确认预算时不花钱），并打出日志 —— 绝不静默。
 */
async function reserveDayDeepDive(dayKey) {
  const coll = db.collection(DEEP_DIVE_TABLE)
  try {
    /* 行已存在时 add 会抛主键冲突，属正常（并发首行同理），吞掉即可 */
    await coll.add({ data: { _id: dayKey, date: dayKey, count: 0 } })
  } catch (err) {
    /* 忽略：多半是主键已存在 */
  }
  try {
    const res = await coll
      .where({ _id: dayKey, count: db.command.lt(DEEP_DIVE.perDayMax) })
      .update({ data: { count: db.command.inc(1), updated_at: new Date().toISOString() } })
    return ((res && res.stats && res.stats.updated) || 0) === 1
  } catch (err) {
    console.warn(`[keywordAlert] 深挖预算表读写失败，本轮跳过深挖：${err && err.message}`)
    return false
  }
}

/** 关键词 → 缓存文档主键：直接用关键词原文（与端上 utils/keyword-alert.ts 同口径，无需哈希） */
const cacheId = (keyword) => keyword

/** 关键词 → 订阅文档主键（与 follows 的 openid#personKey 同构） */
const watchId = (openid, keyword) => `${openid}#${keyword}`

/* ───────────── 分档新增上限（P4，2026-10-13）：写入路径的服务端权威判定 ───────────── */

/**
 * 调用者是不是**有效期内的会员**。口径与云端既有闸门**逐字同源**：
 * `quotaGuard/index.js#isActiveMember` 与 `aiProxy/index.js#isActiveMember` 读的是同一张
 * `memberships`（_id = openid，客户端完全不可读写），只认 `expires_at`（未过期即有效）、
 * 不校验 plan（plan 只决定天数）。
 *
 * **刻意不读 `users.membership`**：那张表权限是「仅创建者可读写」，端上能改自己那一行 ——
 * 以它为准等于把「谁能订几个词」交给改包者自证。读不到 / 读库异常一律按**非会员**
 * （fail-closed：宁可少给，不留白拿口子），与那两处同一方向。
 */
async function isActiveMember(openid) {
  try {
    const res = await db.collection(MEMBERSHIP_TABLE).doc(openid).get()
    const m = (res && res.data) || null
    const t = m && m.expires_at ? Date.parse(m.expires_at) : NaN
    return Number.isFinite(t) && t > Date.now()
  } catch (err) {
    return false
  }
}

/**
 * 关键词校验。**口径与端上 utils/keyword-alert.ts#validateKeyword 同源、不放宽**：
 * 非空、不含 `#`（订阅主键是拼出来的 `openid#关键词`，词里再有 `#` 会让主键边界模糊）、
 * 不超过 MAX_KEYWORD_CHARS 字、且至少含一个中文 / 字母 / 数字（纯符号检索不出东西、白花一次上游）。
 *
 * 云端必须自己再判一次：端上那道可被改包绕过，而写入路径一旦放进来就收不回去了
 * （这条词会进每天的扫描队列、持续消耗上游预算）。
 */
function validateKeyword(raw) {
  const keyword = String(raw || '').trim().replace(/\s+/g, ' ')
  if (!keyword) return { ok: false, reason: 'empty', message: '请输入要监测的关键词' }
  if (keyword.includes('#')) return { ok: false, reason: 'invalid', message: '关键词不能包含 #' }
  if (Array.from(keyword).length > MAX_KEYWORD_CHARS) {
    return { ok: false, reason: 'invalid', message: `关键词不超过 ${MAX_KEYWORD_CHARS} 个字` }
  }
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(keyword)) {
    return { ok: false, reason: 'invalid', message: '关键词至少要包含文字或数字' }
  }
  return { ok: true, keyword }
}

/**
 * 「新增订阅」的服务端权威写入路径（P4，2026-10-13）。
 *
 * 为什么订阅这件事要过一次云端：端上 utils/keyword-alert.ts 的分档门禁是**体验层**
 * （读的是 `users.membership` 镜像，且整段可被改包绕过）。而每一条订阅都会在每天定时
 * 扫描里持续消耗上游检索预算 —— 所以「能不能再加一个」必须由读 `memberships` 权威表的
 * 这一处说了算。**真正的成本边界在云端**，端上那个上限只是提前给用户一个提示。
 *
 * 失败一律**显式回执**（结构化 reason + limit + tier），**绝不静默丢弃 / 静默截断**：
 * 静默会让用户以为在监控、实际没扫（本轮修的正是这个「撒谎」），故宁可明确报错。
 *
 * 身份来源：优先 `WXContext.OPENID`（小程序端调用必带，客户端无法伪造）；仅当**没有
 * WXContext**（控制台 / 运维调用）时才接受 `event.openid` —— 端上永远走前者，故这个口子
 * 不能用来冒充他人，只是给运维排障 / 线上验证留的入口。
 */
async function handleAdd(event, ctxOpenid) {
  const openid = ctxOpenid || (event && event.openid)
  if (!openid) {
    return { ok: false, reason: 'no_auth', message: '取不到调用者 openid：请从小程序端订阅' }
  }

  const check = validateKeyword(event && event.keyword)
  if (!check.ok) return { ok: false, reason: check.reason, message: check.message }

  const tier = (await isActiveMember(openid)) ? 'member' : 'free'
  const limit = tier === 'member' ? WATCH_LIMITS.member : WATCH_LIMITS.free

  /* 只算关键词行：同表还住着「监控某人」（type='person'，属 riskWatch 那一档上限），
     它有自己的一套、不占「最多监测 N 个词」的额度（读法与端上 splitWatches 同口径）。 */
  const mine = (await listAll(WATCH_TABLE, { openid })).filter((w) => w && w.type !== 'person')
  const count = mine.length
  if (mine.some((w) => w.keyword === check.keyword)) {
    return { ok: false, reason: 'duplicate', limit, tier, count, message: '这个词已经在监测中了' }
  }
  if (count >= limit) {
    return {
      ok: false,
      reason: 'over_limit',
      limit,
      tier,
      count,
      message:
        tier === 'member'
          ? `最多同时监测 ${limit} 个词，先取消一个再加`
          : `免费版最多监测 ${limit} 个词，开通会员可监测 ${WATCH_LIMITS.member} 个`
    }
  }

  const now = new Date().toISOString()
  try {
    await db.collection(WATCH_TABLE).add({
      data: {
        _id: watchId(openid, check.keyword),
        /* 云函数是管理员身份，不会像端上写入那样自动注入 _openid；缺了它，端上按
           「仅创建者可读写」规则读不到这一行（与 quotaGuard 显式写 _openid 同一原因）。 */
        _openid: openid,
        openid,
        keyword: check.keyword,
        created_at: now,
        /* 订阅那一刻即盖 seen_at：留空会让新订阅者第一眼看到一批旧闻被标成预警 */
        seen_at: now,
        type: 'keyword'
      }
    })
  } catch (err) {
    const code = err && (err.errCode != null ? err.errCode : err.code)
    const text = String((err && err.errMsg) || (err && err.message) || err)
    /* -502001 主键冲突 / duplicate：并发同词订阅时另一个请求刚插好 —— 归一成「已在监测中」，不是故障 */
    if (code === -502001 || /already exists|duplicate/i.test(text)) {
      return { ok: false, reason: 'duplicate', limit, tier, count, message: '这个词已经在监测中了' }
    }
    console.warn(`[keywordAlert] 订阅写入失败：${text}`)
    return { ok: false, reason: 'write_failed', limit, tier, count, message: '订阅失败，请重试' }
  }
  return {
    ok: true,
    reason: 'added',
    limit,
    tier,
    count: count + 1,
    keyword: check.keyword,
    message: `已开始监测「${check.keyword}」`
  }
}

/* ─────────────────── 分页取全表（P2-11，2026-10-09） ─────────────────── */

const PAGE_SIZE = 100
/* 明面上的上限：到了就打告警，而不是像以前那样「静默只服务前 100 人」 */
const MAX_ROWS = 5000

/**
 * 翻页取全表。**不要**再用裸 `limit(100)` 读「全部要通知的人」。
 *
 * `limit(n)` 在云开发里是「取一批 n 行」，未指定 `orderBy` 时顺序由默认索引决定 ——
 * 既不保证稳定，也不代表优先级。于是订阅用户一旦超过 100，多出来的那些人**永远**收不到通知：
 * 日志里一切正常、没有报错，只有用户来问「为什么别人收到了我没有」。
 *
 * 按 `_id` 升序翻页（`_id` 是主键索引；单字段 where + `_id` 排序不需要额外复合索引）。
 * `skip` 是线性扫描，在这个量级（几千行、每天一轮）完全够用；真到几十万行，该做的是分片。
 */
async function listAll(collection, where) {
  const out = []
  for (;;) {
    let query = db.collection(collection)
    if (where) query = query.where(where)
    const res = await query.orderBy('_id', 'asc').skip(out.length).limit(PAGE_SIZE).get()
    const batch = (res && res.data) || []
    /*
     * 以「空页」收尾，而不是「不满一页就收工」：一次 get 能取回多少行由平台决定
     * （小程序端 20 / 服务端默认 100，上限各不相同、还可能变）。拿 PAGE_SIZE 当
     * 「后面还有没有」的判据，一旦平台给不满就会提前收工 —— P2-11 的老毛病换个样子回来。
     * 代价是多打一次空查询，换「一定取全」，值。
     */
    if (!batch.length) return out
    out.push(...batch)
    if (out.length >= MAX_ROWS) {
      console.warn(`[${collection}] 取数达到上限 ${MAX_ROWS}，本轮只处理这一部分 —— 该评估分片了`)
      return out
    }
  }
}

/**
 * 入口。两条路，靠 `event.action` 区分：
 *
 * 1. **新增订阅（`action:'add'`）**：端上在「订阅」时调用，走 handleAdd ——
 *    按 `memberships` 分档判「还能不能再加一个」，并把结果**显式回执**（见 handleAdd）。
 * 2. **定时扫描（无 action，且无调用方 openid）**：本函数的本职，按词检索并推送预警。
 *
 * 调用方闸门（P0-21，2026-10-09）：除上面那条已授权的写入路径外，端上**调用一律拒绝** ——
 * 判据是「端上 `callFunction` 时 `getWXContext().OPENID` 必有值，而定时器 / 控制台没有」。
 * 挡的是「改包后循环触发扫描」：一轮扫描要打上游检索并按订阅者群发消息，
 * 端上能反复点火就等于把上游额度与推送配额交出去。
 */
exports.main = async (event) => {
  const ctxOpenid = (cloud.getWXContext() || {}).OPENID

  /* 新增订阅的服务端权威写入路径：允许端上调用（那是它的正当用途） */
  if (event && event.action === 'add') {
    return handleAdd(event, ctxOpenid)
  }

  if (ctxOpenid) {
    console.warn('[keywordAlert] 拒绝端上调用：本函数只由定时器触发')
    return { ok: false, skipped: '本函数只由定时器触发，不接受端上调用' }
  }

  const bochaKey = readEnv('BOCHA_API_KEY')
  if (!bochaKey) return { ok: false, skipped: '缺少环境变量：BOCHA_API_KEY' }
  const tmplId = readEnv('ALERT_TEMPLATE_ID')

  // 1. 订阅关系：一次读全表在内存分组（跨用户去重，避免按人查上游）
  const byKeyword = new Map()
  const watchRows = []
  /*
   * ⚠ **扫描不按分档上限裁存量**（P4，2026-10-13 修）：这里原先有一段「每人最多 5 个、
   * 超出的整行忽略」的裁剪。它是本轮的缺陷源 ——
   *   ① 会员上限已按档放开到 10，那段硬顶却是每人不分档的 5 ⇒ 会员订到第 6~10 个词时
   *      被整行忽略：用户以为在盯着，实际一次都没扫（对用户撒谎）；
   *   ② 存量用户（免费档历史上可能已订了 >1 个）也会被按「1」的档位线裁掉，既有订阅
   *      静默停摆 —— 违反项目铁律「只拦新增，不删存量、不阻塞既有功能」。
   * 于是扫描**照单全收**（只过滤「监控某人」与超长词这两种非本队列的行）。
   * 成本边界不在这里，而在：① **写入路径**已按档拦住超额新增（见 handleAdd，权威在云端）；
   * ② 全局预算 MAX_KEYWORDS 限定每轮最多检索多少个词 + 按 fetched_at 轮转保证公平轮到。
   */
  const invalid = []
  for (const w of await listAll(WATCH_TABLE)) {
    /* 同一张表还存着「监控某人」的行（type='person'，第 1 期 riskWatch 用）：它们的 keyword
       存的是人名，不是要检索的关键词 —— 不过滤就会把名人名当关键词再查一遍（白花钱）。
       老行没有 type 字段（2026-10-08 那批关键词订阅），故只有显式 person 才跳过。 */
    if (w && w.type === 'person') continue
    if (!w || !w.openid || !w.keyword) continue
    /* 超长词整行忽略（P2-31）：一次上游检索换一个「句子」，钱花得没有意义。
       id 截断后再进日志，否则一条日志就能顶满整屏。 */
    if (w.keyword.length > MAX_KEYWORD_CHARS) {
      invalid.push(`${watchId(w.openid, w.keyword).slice(0, 40)}: 关键词超过 ${MAX_KEYWORD_CHARS} 字，本轮忽略`)
      continue
    }
    watchRows.push(w)
    if (!byKeyword.has(w.keyword)) byKeyword.set(w.keyword, [])
    byKeyword.get(w.keyword).push(w.openid)
  }
  if (!byKeyword.size) {
    return {
      ok: true,
      keywords: 0,
      users: 0,
      pushed: 0,
      invalid: invalid.length,
      skipped: invalid.slice(),
      /* 无订阅 = 无命中 = 无深挖（全 0；filtered = 因与对象无关被丢弃的深挖条目数） */
      deep_dive: { hits: 0, queries: 0, skipped_run: 0, skipped_day: 0, filtered: 0 }
    }
  }

  // 2. 已缓存的关键词：先批量读出来，才能按「上次扫描时间」排队
  const keywordList = [...byKeyword.keys()]
  const cacheRes = await db
    .collection(CACHE_TABLE)
    .where({ _id: db.command.in(keywordList) })
    .limit(MAX_KEYWORDS * 2)
    .get()
    .catch(() => ({ data: [] }))
  const cached = new Map()
  for (const row of cacheRes.data || []) cached.set(row._id, row)

  const queue = keywordList
    .slice()
    /* 没缓存过的（fetched_at 视为空串）排最前，其次是最久没查的 —— 保证每个词都会被轮到 */
    .sort((a, b) => String((cached.get(a) || {}).fetched_at || '').localeCompare(String((cached.get(b) || {}).fetched_at || '')))
    .slice(0, MAX_KEYWORDS)

  const nowIso = new Date().toISOString()
  const results = new Map() // keyword -> { items, prevUrls, fresh, error }
  let queries = 0
  let updated = 0
  /*
   * P4-A 深挖预算跟踪（三层闸门，见 DEEP_DIVE 注释）：
   *   · runBudgetLeft —— 单轮闸门，**一次调用内存**递减（同轮不可能超发）；
   *   · deepDiveDayKey + reserveDayDeepDive —— 单日闸门，落在 deep_dive_quota（+8 切天，跨天自动重置）；
   *   · deepDiveQueries 的词数 —— 每次命中的词数闸门。
   * 超限一律记进 deepDive / summary（不静默丢弃）。
   */
  const deepDive = { hits: 0, queries: 0, skipped_run: 0, skipped_day: 0, filtered: 0 }
  const deepDiveDayKey = todayKey()
  let runBudgetLeft = DEEP_DIVE.perRunMax

  // 3. 逐个关键词检索并与上次结果比对
  for (const keyword of queue) {
    const prev = cached.get(cacheId(keyword)) || null
    const prevItems = (prev && prev.items) || []
    const prevUrls = new Set(prevItems.map((i) => i && i.url).filter(Boolean))

    /* 缓存足够新就复用：同一关键词一天只打一次上游 */
    if (prev && prev.fetched_at && Date.now() - Date.parse(prev.fetched_at) < REFRESH_GAP_MS) {
      results.set(keyword, { items: prevItems, prevUrls, fresh: false })
      continue
    }

    try {
      const items = await searchKeyword(keyword, bochaKey)
      queries++

      /* P4-A：**命中即深挖**（事件驱动）。命中 = 本轮确有「上次没见过」的报道；
         未命中就绝不发任何额外上游请求 —— 这是成本可控的根本原因（见文件头）。 */
      const prevByUrl = new Map(prevItems.map((i) => [i.url, i]))
      const hasFresh = items.some((i) => i && i.url && !prevUrls.has(i.url))
      const deepItems = []
      if (hasFresh) {
        deepDive.hits++
        for (const q of deepDiveQueries(keyword, DEEP_DIVE.queriesPerHit)) {
          /* 单轮闸门（内存计数）—— 到顶只记不查 */
          if (runBudgetLeft <= 0) {
            deepDive.skipped_run++
            continue
          }
          /* 单日闸门（原子预留）—— 预留不到即当日超限 */
          if (!(await reserveDayDeepDive(deepDiveDayKey))) {
            deepDive.skipped_day++
            continue
          }
          runBudgetLeft--
          try {
            const found = await searchKeyword(q, bochaKey)
            deepDive.queries++
            /* 只并入「本次扫描没扫到、缓存也没见过」的新条目，避免与扫描结果重复 */
            for (const it of found) {
              if (!it.url || !it.title) continue
              if (prevUrls.has(it.url)) continue
              if (items.some((x) => x.url === it.url)) continue
              if (deepItems.some((x) => x.url === it.url)) continue
              /* 相关性闸门（本轮缺陷修复）：深挖条目必须含对象名，否则丢弃 —— 上游宽松匹配
                 会把无关条目（赵丽颖 / 萨利巴 / TVB 等）带回来，原样并入会污染事件时间线。
                 丢弃**计入回执**（deepDive.filtered），绝不静默。 */
              if (!isDeepDiveRelated(it, keyword)) {
                deepDive.filtered++
                continue
              }
              deepItems.push(it)
            }
          } catch (err) {
            /* 单次深挖失败不拖垮整轮：预算已花（上游请求已发出），下一轮再试 */
            console.warn(`[keywordAlert] 深挖检索失败（${q}）：${err && err.message}`)
          }
        }
      }

      /* 新条目带 first_seen_at：老条目沿用上次的时间，端上靠它判断「对我来说哪些是新的」。
         深挖条目与扫描新条目同等对待（一并写进缓存）—— 它们会成为下一轮 opinionCluster 里
         该关键词事件的**补充成员**（带来源与时间，符合合规红线）。 */
      const freshItems = items.concat(deepItems)
      const merged = freshItems
        .concat(prevItems.filter((p) => p && p.url && !freshItems.some((i) => i.url === p.url)))
        .slice(0, MAX_ITEMS)
        .map((i) => ({
          title: i.title,
          url: i.url,
          source: i.source,
          summary: i.summary || '',
          ...(i.published_date ? { published_date: i.published_date } : {}),
          first_seen_at: (prevByUrl.get(i.url) || {}).first_seen_at || nowIso
        }))
      /* ⚠ 推送 / 预警口径仍只看**扫描**条目（results 里只放 items）：深挖只做事件补充，
         不改变推送语义（否则一次命中可能因为深挖而来的条目多推 / 推送内容被改写）。 */
      results.set(keyword, { items, prevUrls, fresh: true })

      /* 先把结果写回缓存：否则下一轮会把同一批条目再当成「新增」，重复推送 */
      await db
        .collection(CACHE_TABLE)
        .doc(cacheId(keyword))
        .set({ data: { keyword, items: merged, fetched_at: nowIso, watchers: (byKeyword.get(keyword) || []).length } })
      updated++
    } catch (err) {
      /* 单个关键词失败不拖垮整轮：留原文供下次比对，本轮该词视为无更新 */
      results.set(keyword, { items: prevItems, prevUrls, fresh: false, error: String(err && err.message) })
    }
  }

  // 4. 按用户汇总本轮真的新出现的条目
  const userNews = new Map() // openid -> [{ keyword, items }]
  for (const w of watchRows) {
    const r = results.get(w.keyword)
    if (!r || !r.fresh) continue
    const news = r.items.filter((i) => i && i.url && !r.prevUrls.has(i.url))
    if (!news.length) continue
    if (!userNews.has(w.openid)) userNews.set(w.openid, [])
    userNews.get(w.openid).push({ keyword: w.keyword, items: news })
  }

  const summary = {
    ok: true,
    keywords: queue.length,
    queries,
    updated,
    users: userNews.size,
    pushed: 0,
    /* 因超长被忽略的订阅数（P2-31）：恒为 0 才是正常（它不是分档裁剪，是数据问题） */
    invalid: invalid.length,
    skipped: invalid.slice(),
    /* P4-A 深挖回执：命中了几个对象、真正扩查了几次、因单轮 / 单日预算各跳过几次、
       因与对象无关被丢弃几条（filtered —— 相关性闸门，绝不静默丢弃） */
    deep_dive: {
      hits: deepDive.hits,
      queries: deepDive.queries,
      skipped_run: deepDive.skipped_run,
      skipped_day: deepDive.skipped_day,
      filtered: deepDive.filtered
    }
  }
  /* 超限不静默：把「因预算跳过几次」明确写进回执，运维一眼能看出是被闸门挡了 */
  if (deepDive.skipped_run || deepDive.skipped_day) {
    summary.skipped.push(
      `深挖预算不足，本轮跳过 ${deepDive.skipped_run + deepDive.skipped_day} 次` +
        `（单轮上限 ${DEEP_DIVE.perRunMax} / 单日上限 ${DEEP_DIVE.perDayMax}；` +
        `单轮跳过 ${deepDive.skipped_run}、单日跳过 ${deepDive.skipped_day}）`
    )
    console.warn(`[keywordAlert] 深挖预算受限：${JSON.stringify(summary.deep_dive)}`)
  }
  /* 相关性丢弃同样不静默：明确写进回执，让「上游宽松匹配带回了多少噪声」可见 */
  if (deepDive.filtered) {
    summary.skipped.push(`深挖结果有 ${deepDive.filtered} 条与命中对象无关（未含对象名），已丢弃`)
  }
  if (!userNews.size) return summary
  /* 没配模板就到此为止：站内预警（keywords 表）已经写好，端上进预警页照样看得到；
     推送是「顺手多一件事」，不该因为模板还没申请就整轮失败。 */
  if (!tmplId) {
    summary.skipped.push('未配置 ALERT_TEMPLATE_ID：已写站内预警，跳过推送')
    return summary
  }

  // 5. 只推给「已授权预警推送」的用户，每人一条（取本轮新增最多的那个词）
  const alerters = new Map((await listAll('users', { alert_ok: true })).map((u) => [u._openid, u]))

  for (const [openid, hits] of userNews) {
    const u = alerters.get(openid)
    if (!u) continue
    const top = hits.slice().sort((a, b) => b.items.length - a.items.length)[0]
    const total = hits.reduce((n, h) => n + h.items.length, 0)
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId: tmplId,
        page: `pages/alerts/index?keyword=${encodeURIComponent(top.keyword)}`,
        miniprogramState: 'formal',
        lang: 'zh_CN',
        data: {
          thing1: { value: clamp(`「${top.keyword}」新增${total}条报道：${top.items[0].title}`, THING_MAX) },
          date2: { value: formatDate(new Date()) }
        }
      })
      summary.pushed++
      /* 一次性订阅：这条用掉了预警模板的授权，立刻复位；否则下次发送必得 43101 */
      await db.collection('users').doc(u._id).update({ data: { alert_ok: false } })
    } catch (err) {
      const msg = String((err && err.errMsg) || (err && err.message) || err)
      summary.skipped.push({ openid: String(openid).slice(0, 8) + '***', reason: msg })
      /* 43101 = 用户已取消或授权已消耗；这类失败属正常状态，只记录不告警 */
      if (/43101|user refuse/i.test(msg)) {
        await db
          .collection('users')
          .doc(u._id)
          .update({ data: { alert_ok: false } })
          .catch(() => undefined)
      }
    }
  }

  return summary
}

/* 供运维排查用：确认「分档新增上限」与端上（utils/opinion-access.ts）同源 */
exports.WATCH_LIMITS = WATCH_LIMITS
exports.watchId = watchId
/* 供运维 / 用例排查用：深挖预算的三层闸门取值与候选词生成（P4-A） */
exports.DEEP_DIVE = DEEP_DIVE
exports.deepDiveQueries = deepDiveQueries
/* 深挖条目的相关性判定（纯函数，与 riskWatch 同源）：供用例直接调用 + 数据清理复用 */
exports.isDeepDiveRelated = isDeepDiveRelated
exports.normalizeName = normalizeName
