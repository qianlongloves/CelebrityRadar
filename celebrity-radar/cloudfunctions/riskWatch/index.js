/**
 * riskWatch —— 名人风险监控：定时检索「正在被监控」的名人，命中风险类表述时落 signal 并提醒一次。
 * 商业化路线图第 1 期（docs/commercial-audience-risk-plan.md §3.3 后段）。
 *
 * 与第 0 期「风险雷达」（报告页那张卡）的分工 —— 这是本函数存在的理由：
 *   雷达卡只扫报告**已收录**的素材；用户不重新生成报告，就永远不知道「这两天出事了」。
 *   本函数把「关注」从「报告生成时的一次快照」变成「每天一次的持续检索」，
 *   词典与判定规则（字面命中 + 否定词排除）与端上 risk.ts **完全同源**（见取舍 1）。
 *
 * 触发 / 入口（2026-10-13 起两条路，靠 event.action 区分）：
 *   · `event.action === 'add'` —— **新增监控**：端上在「监控此人」时调用。按 memberships
 *     （权威会员表）分档判「还能不能再盯一个」（免费 3 / 会员 10），结果**显式回执**
 *     （`{ ok, reason, limit, tier, count }`）——**绝不静默丢弃**（见 handleAdd）。
 *   · 无 action 且无调用方 openid —— **定时扫描**：由 cloudbaserc.json 的触发器驱动
 *     （每天 09:40 —— 排在 notifyFollowUpdates 09:00、keywordAlert 09:20 之后，三个任务
 *     各错开 20 分钟：都要打博查，挤在一个 60s 窗口里会互相拖慢甚至半途超时）。
 *
 * 环境变量（控制台 → 云函数 → riskWatch → 配置 → 环境变量）：
 *   BOCHA_API_KEY    博查搜索 key（与其它三个函数共用同一枚）**缺失则整轮跳过**
 *   RISK_TEMPLATE_ID 风险提醒模板 ID，须与 src/config/public.ts 的 riskTemplateId 同模板。
 *                    **缺失不算错误**：只落 risk_signals（端上进预警页看得见）、跳过推送 ——
 *                    模板要单独去公众平台申请，没申请之前这功能也该能长出东西来。
 *
 * 消息模板字段：thing1 提醒内容（≤20 字符）、date2 更新时间（与预警模板同键名）。
 *
 * ⚠ 两个「上限」是两件事，改代码前必须分清（与 keywordAlert 同一口径）：
 *   ① **新增上限（按档）** PERSON_WATCH_LIMITS.free / .member —— 只拦「还能不能再盯一个」，
 *      写入路径判定（见 handleAdd）；
 *   ② **扫描口径** —— 定时扫描**不按①裁剪存量**：存量用户（免费档历史上可能已监控 >1 位）
 *      与会员的第 6~10 位都必须照常被扫，否则既有监控会静默停摆（违反「只拦新增，不删存量」）。
 *      每轮成本由**单轮 MAX_PERSONS 上限 + RISK_GAP_MS 重扫间隔**兜住，不靠「每人裁几个」。
 *
 * ⚠ 与 keywordAlert 的授权**不能共用**：微信一次性订阅按**模板**消耗授权，
 * 两个任务共用一个授权位就会出现「先跑的吃掉授权，后跑的必得 43101」。
 * 故本函数用 users.risk_ok + RISK_TEMPLATE_ID 这一对独立授权（与 alert_ok 同理）。
 *
 * 五个取舍：
 * 1. **词典与端上 risk.ts 同源**。云函数不能 require 端上 TS，故这里复制一份，
 *    由 test/cases/01-pure.js 的「风险词典两端一致」用例读本文件比对字面量 —— 漂移会红。
 * 2. **命中即报，不做语义判定**（同 risk.ts 的三条边界）：只把素材里出现过的表述指出来，
 *    不判「这条算不算负面」，更不给「塌房概率」。
 * 3. **按人检索、跨用户去重**：3 个人监控同一位名人只打 1 次上游（博查按次计费）。
 * 4. **首次扫描只建档、不落信号也不推送**。新加监控的那一刻，历史报道里必然躺着旧的风险表述，
 *    按它们推「有情况」是典型误报（用户刚订阅就被吓一跳）。故首次只把 url 记进
 *    risk_scans.seen_urls，从第二次起才报真正新出现的条目。
 * 5. **级别只由「命中的是哪一类词」决定**：司法监管 / 税务合规 = high，商业合作 / 名誉维权 = mid，
 *    回应表态 = low。它不是对事件严重性的评估 —— 这样每级都能回放到触发它的那条素材。
 */

const cloud = require('wx-server-sdk')
const https = require('https')

/**
 * 分档新增上限的数值**不手写**：取自真源 `src/config/benefits.ts#OPINION_LIMITS`
 * （经 `npm run config:sync` 生成同目录的 benefits.config.js），与端上
 * utils/opinion-access.ts#personWatchLimit 读的是同一份数据（用例 14 钉住副本一致性）。
 */
const { OPINION_LIMITS } = require('./benefits.config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const TIMEOUT_MS = 15000
/** 单轮最多扫多少位名人：博查按次计费，云函数默认 60s 超时也撑不住更多 */
const MAX_PERSONS = 20
/**
 * 「监控某人」的**分档新增上限**（免费 3 / 会员 10）—— 这是「**能不能再盯一个**」的上限，
 * 只在**写入路径**（见 handleAdd）上判；数值取自 benefits.config.js（真源 config/benefits.ts）。
 *
 * ⚠ 它**不是**定时扫描的裁剪线（与 keywordAlert 同一口径）：拿它当扫描线就是把存量用户
 *   （免费档历史上可能已监控 >1 位）静默停扫 —— 用户以为在盯、实际没扫，等于对用户撒谎。
 *   故本轮删掉了原先「每人最多 5、超出的整行忽略」的那段裁剪，扫描改为照单全收：
 *   成本边界由 ① 写入路径按档拦新增（权威在云端）+ ② 单轮 MAX_PERSONS 上限 + ③ 重扫间隔承担。
 */
const PERSON_WATCH_LIMITS = OPINION_LIMITS.personWatchCount
/** 同一个人的最短重扫间隔：定时任务与人工补跑不重复打上游 */
const RISK_GAP_MS = 20 * 60 * 60 * 1000
/** 每人保留的 url 快照上限（只用于判断「哪些条目是新的」） */
const MAX_SEEN = 40
/** 每人每轮最多落多少条信号：上游抖动一次返回十条相似报道时，不该灌进来十条 */
const MAX_SIGNALS_PER_PERSON = 5
/** 条目摘要入库前的截断（提醒卡上一句话就够） */
const SUMMARY_MAX = 80
/** thing 类字段的字符数上限（微信按字符算，中文一个算一个） */
const THING_MAX = 20
/** 值得打扰用户的最低级别：low 只落库、不推送（站内预警页照样看得到） */
const PUSH_LEVELS = ['high', 'mid']

const WATCH_TABLE = 'keyword_watches'
const SCAN_TABLE = 'risk_scans'
const SIGNAL_TABLE = 'risk_signals'
/** 服务端权威会员表（_id = openid，客户端完全不可读写，见下方 isActiveMember） */
const MEMBERSHIP_TABLE = 'memberships'

/**
 * 风险词典（**与 src/utils/risk.ts#RISK_TERMS 同源，改动须两处同步**，见取舍 1）。
 * 全部是可核对的事实类表述，不含「翻车 / 塌房 / 抵制 / 风波」这类评价性词汇。
 */
const RISK_TERMS = [
  { word: '偷税', category: 'tax' },
  { word: '逃税', category: 'tax' },
  { word: '漏税', category: 'tax' },
  { word: '补缴税款', category: 'tax' },
  { word: '税务稽查', category: 'tax' },
  { word: '起诉', category: 'judicial' },
  { word: '立案', category: 'judicial' },
  { word: '诉讼', category: 'judicial' },
  { word: '判决', category: 'judicial' },
  { word: '败诉', category: 'judicial' },
  { word: '庭审', category: 'judicial' },
  { word: '传唤', category: 'judicial' },
  { word: '拘留', category: 'judicial' },
  { word: '逮捕', category: 'judicial' },
  { word: '强制执行', category: 'judicial' },
  { word: '通报批评', category: 'judicial' },
  { word: '行政处罚', category: 'judicial' },
  { word: '罚款', category: 'judicial' },
  { word: '律师函', category: 'judicial' },
  { word: '调查', category: 'judicial' },
  { word: '查封', category: 'judicial' },
  { word: '冻结', category: 'judicial' },
  { word: '限制高消费', category: 'judicial' },
  { word: '失信被执行人', category: 'judicial' },
  { word: '解约', category: 'contract' },
  { word: '终止合作', category: 'contract' },
  { word: '停止合作', category: 'contract' },
  { word: '合作终止', category: 'contract' },
  { word: '代言取消', category: 'contract' },
  { word: '撤换', category: 'contract' },
  { word: '下架', category: 'contract' },
  { word: '索赔', category: 'contract' },
  { word: '违约', category: 'contract' },
  { word: '解聘', category: 'contract' },
  { word: '辞退', category: 'contract' },
  { word: '撤档', category: 'contract' },
  { word: '名誉权', category: 'rights' },
  { word: '肖像权', category: 'rights' },
  { word: '诽谤', category: 'rights' },
  { word: '造谣', category: 'rights' },
  { word: '侵权', category: 'rights' },
  { word: '维权', category: 'rights' },
  { word: '盗用', category: 'rights' },
  { word: '假冒', category: 'rights' },
  { word: '道歉', category: 'statement' },
  { word: '致歉', category: 'statement' },
  { word: '澄清', category: 'statement' },
  { word: '辟谣', category: 'statement' }
]

/*
 * 双向词方向判定（2026-10-10，**与 src/utils/risk.ts 同源，改动须两处同步**）：
 * 「起诉 / 诉讼」原告被告都在用，命中后要看动词后面是否跟着维权对象 ——
 * 「起诉造谣者」是名誉维权（本人是维权方），「被起诉」才是司法监管（本人是被诉方）。
 * 默认按司法（保守），只有明确识别出维权宾语才改判维权。
 */
const BIDIRECTIONAL_TERMS = ['起诉', '诉讼']
const RIGHTS_OBJECTS = [
  '造谣', '诽谤', '侵权', '名誉', '肖像', '网暴', '黑粉', '抹黑', '诋毁', '抄袭', '盗用', '假冒', '维权'
]
const RIGHTS_AFTER_WINDOW = 8

/** 类别 → 级别：只表示「命中词属于哪一类」，不是对事件的定性（取舍 5） */
const LEVEL_OF = { judicial: 'high', tax: 'high', contract: 'mid', rights: 'mid', statement: 'low' }
const CATEGORY_LABEL = {
  judicial: '司法监管',
  tax: '税务合规',
  contract: '商业合作',
  rights: '名誉维权',
  statement: '回应表态'
}
const LEVEL_RANK = { high: 0, mid: 1, low: 2 }

/**
 * 否定词：命中词前 NEG_WINDOW 个字符内出现即整条丢弃（「未被起诉」「否认解约」）。
 * 与 risk.ts 同源、同窗口 —— 这是启发式，窗口一大就会把「团队否认，此前已被起诉」一起吃掉。
 */
const NEG_WORDS = ['未', '没', '无', '否认', '不实', '谣言', '造谣', '辟谣']
const NEG_WINDOW = 6

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

/** 统一成 ISO：只用于展示，不参与「是不是新的」判定（判定一律用我们自己的时钟） */
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
 * 文本 → 稳定短哈希（FNV-1a 32 位）。
 * 用来拼 risk_signals 主键：url 含 `/` `?` 且可长到几百字符，不适宜直接进 _id。
 */
function hashOf(text) {
  let h = 0x811c9dc5
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 信号主键：同一个人 + 同一个 url = 同一条信号，重复检出不再写第二行 */
const signalId = (personKey, url) => `${personKey}#${hashOf(url)}`

/** 监控文档主键：带 person# 前缀，避免与关键词订阅行（openid#关键词）撞主键 */
const personWatchId = (openid, personKey) => `${openid}#person#${personKey}`

/* ───────────── 分档新增上限（2026-10-13）：写入路径的服务端权威判定 ───────────── */

/**
 * 调用者是不是**有效期内的会员**。口径与云端既有闸门**逐字同源**：
 * `quotaGuard/index.js#isActiveMember`、`aiProxy/index.js` 与 `keywordAlert/index.js`
 * 读的是同一张 `memberships`（_id = openid，客户端完全不可读写），只认 `expires_at`
 * （未过期即有效）、不校验 plan（plan 只决定天数）。
 *
 * **刻意不读 `users.membership`**：那张表权限是「仅创建者可读写」，端上能改自己那一行 ——
 * 以它为准等于把「谁能盯几个人」交给改包者自证。读不到 / 读库异常一律按**非会员**
 * （fail-closed：宁可少给，不留白拿口子）。
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
 * 「新增监控对象」的服务端权威写入路径（2026-10-13）。
 *
 * 与 `keywordAlert#handleAdd` 同一套：端上 utils/risk-watch.ts 那道分档门禁是**体验层**
 * （读 `users.membership` 镜像，且整段可被改包绕过）；而每一条监控都会在每天定时扫描里
 * 持续消耗上游检索预算 —— 所以「能不能再加一个」必须由读 `memberships` 权威表的这一处说了算。
 *
 * ⚠ 「监控某人」与「关键词监控」是**两个维度、两档上限**（personWatchCount / watchCount），
 *   但同住 `keyword_watches` 一张表：这里**只数 type='person' 的行**，关键词行不占本额度。
 *
 * 失败一律**显式结构化回执**（reason + limit + tier + count），**绝不静默丢弃 / 静默截断**
 * ——静默会让用户以为在监控、实际没扫（本项目铁律）。
 *
 * 身份来源：优先 `WXContext.OPENID`（小程序端调用必带，客户端无法伪造）；仅当**没有
 * WXContext**（控制台 / 运维调用）时才接受 `event.openid`。
 */
async function handleAdd(event, ctxOpenid) {
  const openid = ctxOpenid || (event && event.openid)
  if (!openid) {
    return { ok: false, reason: 'no_auth', message: '取不到调用者 openid：请从小程序端监控' }
  }

  const personKey = String((event && event.person_key) || '').trim()
  const name = String((event && event.name) || '').trim() || personKey
  /* personKey 是主键组成部分，禁掉路径分隔符（与 quotaGuard 的 target 校验同一理由） */
  if (!personKey || personKey.includes('/')) {
    return { ok: false, reason: 'invalid', message: '缺少要监控的 personKey' }
  }

  const tier = (await isActiveMember(openid)) ? 'member' : 'free'
  const limit = tier === 'member' ? PERSON_WATCH_LIMITS.member : PERSON_WATCH_LIMITS.free

  /* 只数「监控某人」行：同表还住着关键词订阅（type='keyword'），它有自己的一档上限 */
  const mine = (await listAll(WATCH_TABLE, { openid })).filter((w) => w && w.type === 'person')
  const count = mine.length
  if (mine.some((w) => w.person_key === personKey)) {
    return { ok: false, reason: 'duplicate', limit, tier, count, message: '这个人已经在监控中了' }
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
          ? `最多同时监控 ${limit} 个人，先取消一个再加`
          : `免费版最多监控 ${limit} 个人，开通会员可监控 ${PERSON_WATCH_LIMITS.member} 个`
    }
  }

  const now = new Date().toISOString()
  try {
    await db.collection(WATCH_TABLE).add({
      data: {
        _id: personWatchId(openid, personKey),
        /* 云函数是管理员身份，不会像端上写入那样自动注入 _openid；缺了它，端上按
           「仅创建者可读写」规则读不到这一行（与 keywordAlert / quotaGuard 同一原因）。 */
        _openid: openid,
        openid,
        /* 人名存在 keyword 字段里：预警页与云函数复用同一套「读一行拿显示名」的逻辑 */
        keyword: name,
        person_key: personKey,
        type: 'person',
        created_at: now,
        seen_at: now
      }
    })
  } catch (err) {
    const code = err && (err.errCode != null ? err.errCode : err.code)
    const text = String((err && err.errMsg) || (err && err.message) || err)
    /* -502001 主键冲突 / duplicate：并发同一个人监控时另一个请求刚插好 —— 归一成「已在监控中」 */
    if (code === -502001 || /already exists|duplicate/i.test(text)) {
      return { ok: false, reason: 'duplicate', limit, tier, count, message: '这个人已经在监控中了' }
    }
    console.warn(`[riskWatch] 监控写入失败：${text}`)
    return { ok: false, reason: 'write_failed', limit, tier, count, message: '监控失败，请重试' }
  }
  return {
    ok: true,
    reason: 'added',
    limit,
    tier,
    count: count + 1,
    person_key: personKey,
    message: `已开始监控「${name}」`
  }
}

/** 字面命中：返回第一个未被否定的命中词，没有则 null（与 risk.ts#matchTerm 同一套规则） */
function matchTerm(text) {
  for (const term of RISK_TERMS) {
    const at = text.indexOf(term.word)
    if (at < 0) continue
    const before = text.slice(Math.max(0, at - NEG_WINDOW), at)
    if (NEG_WORDS.some((n) => before.includes(n))) continue
    /* 双向词再看宾语方向：「起诉造谣者」是维权、「被起诉」才是司法监管 */
    if (BIDIRECTIONAL_TERMS.indexOf(term.word) >= 0) {
      const after = text.slice(at + term.word.length, at + term.word.length + RIGHTS_AFTER_WINDOW)
      if (RIGHTS_OBJECTS.some((o) => after.includes(o))) return { word: term.word, category: 'rights' }
    }
    return term
  }
  return null
}

/**
 * 按人检索 → 条目[]。
 * freshness 取 oneWeek（比关键词预警的 oneDay 宽）：风险信号很少当天第一次上网，
 * 一周窗口能覆盖「事件发酵两三天后才被媒体写出来」的常见节奏。
 */
async function searchPerson(name, key) {
  const res = await postJson(
    BOCHA_ENDPOINT,
    { Authorization: `Bearer ${key}` },
    { query: name, freshness: 'oneWeek', summary: true, count: 10 },
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
 * 1. **新增监控（`action:'add'`）**：端上在「监控此人」时调用，走 handleAdd ——
 *    按 `memberships` 分档判「还能不能再加一个」，并把结果**显式回执**（见 handleAdd）。
 * 2. **定时扫描（无 action，且无调用方 openid）**：本函数的本职，按人检索并提醒。
 *
 * 调用方闸门（P0-21，2026-10-09）：除上面那条已授权的写入路径外，端上**调用一律拒绝** ——
 * 判据是「端上 `callFunction` 时 `getWXContext().OPENID` 必有值，而定时器 / 控制台没有」。
 * 挡的是「改包后循环触发扫描」：一轮扫描要按监控对象打 BOCHA 检索并群发预警，
 * 端上能反复触发就等于把上游额度与推送配额交给任何人点火。
 */
exports.main = async (event) => {
  const ctxOpenid = (cloud.getWXContext() || {}).OPENID

  /* 新增监控的服务端权威写入路径：允许端上调用（那是它的正当用途） */
  if (event && event.action === 'add') {
    return handleAdd(event, ctxOpenid)
  }

  if (ctxOpenid) {
    console.warn('[riskWatch] 拒绝端上调用：本函数只由定时器触发')
    return { ok: false, skipped: '本函数只由定时器触发，不接受端上调用' }
  }

  const bochaKey = readEnv('BOCHA_API_KEY')
  if (!bochaKey) return { ok: false, skipped: '缺少环境变量：BOCHA_API_KEY' }
  const tmplId = readEnv('RISK_TEMPLATE_ID')

  // 1. 监控关系：一次读全表按 person_key 分组（跨用户去重，同一人只查一次上游）
  const byPerson = new Map()
  /*
   * ⚠ **扫描不按分档上限裁存量**（2026-10-13 修）：这里原先有一段「每人最多 5 个、
   * 超出的整行忽略」的裁剪 —— 它会把存量用户（免费档历史上可能已监控 >1 位）静默停扫，
   * 用户以为在盯、实际一次都没扫（对用户撒谎）。现改为**照单全收**（只过滤非本队列的行）。
   * 成本边界不在这里，而在 ① 写入路径已按档拦住超额新增（见 handleAdd，权威在云端）；
   * ② 单轮 MAX_PERSONS 限定每轮最多检索多少位名人，其内按 scanned_at 升序轮转保证公平轮到；
   * ③ RISK_GAP_MS 重扫间隔让定时任务与人工补跑不重复打上游。
   */
  for (const w of await listAll(WATCH_TABLE)) {
    if (!w || w.type !== 'person' || !w.openid || !w.person_key) continue
    if (!byPerson.has(w.person_key)) {
      byPerson.set(w.person_key, { personKey: w.person_key, name: String(w.keyword || '').trim(), watchers: [] })
    }
    byPerson.get(w.person_key).watchers.push(w.openid)
  }
  if (!byPerson.size) {
    return {
      ok: true,
      persons: 0,
      queries: 0,
      signals: 0,
      users: 0,
      pushed: 0,
      skipped: []
    }
  }

  // 2. 上次扫描状态：既决定「谁排前面」，也决定「哪些 url 已经见过」
  const personKeys = [...byPerson.keys()]
  const scanRes = await db
    .collection(SCAN_TABLE)
    .where({ _id: db.command.in(personKeys) })
    .limit(MAX_PERSONS * 2)
    .get()
    .catch(() => ({ data: [] }))
  const scans = new Map()
  for (const row of scanRes.data || []) scans.set(row._id, row)

  /* 按 scanned_at 升序轮转：按订阅人数排序会让冷门名人永远轮不到（饿死），
     按「上次扫描最久」则每个人都会被轮到（同 keywordAlert 的队列取舍） */
  const queue = personKeys
    .slice()
    .sort((a, b) =>
      String((scans.get(a) || {}).scanned_at || '').localeCompare(String((scans.get(b) || {}).scanned_at || ''))
    )
    .slice(0, MAX_PERSONS)

  const nowIso = new Date().toISOString()
  const perPerson = new Map() // personKey -> { name, signals: [], error }
  const summary = {
    ok: true,
    persons: queue.length,
    queries: 0,
    signals: 0,
    users: 0,
    pushed: 0,
    /* 扫描不按每人上限裁剪（见上），故不再有 over_limit 字段；被写入路径挡下的超额新增
       在 handleAdd 的回执里（reason:'over_limit'），不会静默丢弃。 */
    skipped: []
  }

  // 3. 逐个名人：检索 → 词典命中 → 落 signal → 更新快照
  for (const personKey of queue) {
    const person = byPerson.get(personKey)
    const prev = scans.get(personKey) || null

    /* 快照够新就跳过：定时任务与人工补跑不会把同一个人一天查两遍 */
    if (prev && prev.scanned_at && Date.now() - Date.parse(prev.scanned_at) < RISK_GAP_MS) continue

    let items
    try {
      items = await searchPerson(person.name, bochaKey)
      summary.queries++
    } catch (err) {
      /* 单个人失败不拖垮整轮：本轮这个人视为无更新，下一轮再试 */
      perPerson.set(personKey, { name: person.name, signals: [], error: String(err && err.message) })
      continue
    }

    const seen = new Set((prev && prev.seen_urls) || [])
    /* 首次扫描（没有 baseline_at）只建档：见文件头取舍 4 */
    const firstScan = !(prev && prev.baseline_at)
    const fresh = firstScan ? [] : items.filter((i) => !seen.has(i.url))

    const signals = []
    for (const item of fresh) {
      const hit = matchTerm(`${item.title} ${item.summary}`)
      if (!hit) continue
      signals.push({
        person_key: personKey,
        name: person.name,
        level: LEVEL_OF[hit.category],
        category: hit.category,
        category_label: CATEGORY_LABEL[hit.category],
        keyword: hit.word,
        title: item.title,
        /* 摘要为空时退回标题：列表项至少要有一句能读的 */
        quote: item.summary || item.title,
        source: item.source,
        url: item.url,
        first_seen_at: nowIso
      })
      if (signals.length >= MAX_SIGNALS_PER_PERSON) break
    }

    /* 先查已落过的再只写新的：同一 url 可能在不同轮次被检出。
       不用「add 撞主键再看错误码」，因为不同驱动的冲突错误码不一致，判定比多查一次更脆。 */
    if (signals.length) {
      const ids = signals.map((s) => signalId(personKey, s.url))
      const knownRes = await db
        .collection(SIGNAL_TABLE)
        .where({ _id: db.command.in(ids) })
        .limit(ids.length)
        .get()
        .catch(() => ({ data: [] }))
      const known = new Set((knownRes.data || []).map((r) => r._id))
      for (const s of signals) {
        const id = signalId(personKey, s.url)
        if (known.has(id)) continue
        try {
          await db.collection(SIGNAL_TABLE).add({ data: Object.assign({ _id: id }, s) })
          summary.signals++
        } catch (err) {
          summary.skipped.push({ person: person.name, reason: `写 signal 失败：${String(err && err.message)}` })
        }
      }
    }

    perPerson.set(personKey, { name: person.name, signals, error: null })

    try {
      await db
        .collection(SCAN_TABLE)
        .doc(personKey)
        .set({
          data: {
            person_key: personKey,
            name: person.name,
            scanned_at: nowIso,
            /* baseline_at 只在首轮写一次：它是「从哪个时刻开始算新」的界线 */
            baseline_at: (prev && prev.baseline_at) || nowIso,
            seen_urls: items
              .map((i) => i.url)
              .filter(Boolean)
              .slice(0, MAX_SEEN),
            scanned: items.length,
            signals_total: Number((prev && prev.signals_total) || 0) + signals.length
          }
        })
    } catch (err) {
      summary.skipped.push({ person: person.name, reason: `写扫描快照失败：${String(err && err.message)}` })
    }
  }

  // 4. 只推「够得上打扰级别」的名人：low 只落库（取舍 5）
  const worth = [...perPerson.entries()].filter(([, v]) => v.signals.some((s) => PUSH_LEVELS.includes(s.level)))
  summary.users = new Set(worth.flatMap(([personKey]) => byPerson.get(personKey).watchers)).size
  if (!worth.length) return summary

  /* 没配模板就到此为止：risk_signals 已经写好，端上进预警页照样看得到；
     推送是「顺手多一件事」，不该因为模板还没申请就整轮失败（同 keywordAlert）。 */
  if (!tmplId) {
    summary.skipped.push('未配置 RISK_TEMPLATE_ID：已落 risk_signals，跳过推送')
    return summary
  }

  // 5. 只推给「已授权风险提醒」的用户；同一个人被多人监控时各自收到一条
  const alerters = new Map((await listAll('users', { risk_ok: true })).map((u) => [u._openid, u]))

  for (const [personKey, view] of worth) {
    const top = view.signals
      .filter((s) => PUSH_LEVELS.includes(s.level))
      .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])[0]

    for (const openid of byPerson.get(personKey).watchers) {
      const u = alerters.get(openid)
      if (!u) continue
      try {
        await cloud.openapi.subscribeMessage.send({
          touser: openid,
          templateId: tmplId,
          page: 'pages/alerts/index',
          miniprogramState: 'formal',
          lang: 'zh_CN',
          data: {
            thing1: { value: clamp(`「${view.name}」出现${top.category_label}类表述：${top.title}`, THING_MAX) },
            date2: { value: formatDate(new Date()) }
          }
        })
        summary.pushed++
        /* 一次性订阅：这条用掉了风险模板的授权，立刻复位；否则下次发送必得 43101 */
        await db.collection('users').doc(u._id).update({ data: { risk_ok: false } })
      } catch (err) {
        const msg = String((err && err.errMsg) || (err && err.message) || err)
        summary.skipped.push({ openid: String(openid).slice(0, 8) + '***', reason: msg })
        /* 43101 = 用户已取消或授权已消耗；这类失败属正常状态，只记录不告警 */
        if (/43101|user refuse/i.test(msg)) {
          await db
            .collection('users')
            .doc(u._id)
            .update({ data: { risk_ok: false } })
            .catch(() => undefined)
        }
      }
    }
  }

  return summary
}

/* 供运维排查用：确认「监控文档主键」与端上 utils/risk-watch.ts 同口径 */
exports.personWatchId = personWatchId
exports.signalId = signalId
/* 供运维排查用：确认「分档新增上限」与端上（utils/opinion-access.ts）同源 */
exports.PERSON_WATCH_LIMITS = PERSON_WATCH_LIMITS


