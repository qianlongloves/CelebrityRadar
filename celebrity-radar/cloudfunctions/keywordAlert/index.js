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
 */

const cloud = require('wx-server-sdk')
const https = require('https')

/**
 * 分档新增上限的数值**不手写**：取自真源 `src/config/benefits.ts#OPINION_LIMITS`
 * （经 `npm run config:sync` 生成同目录的 benefits.config.js），
 * 与端上 utils/opinion-access.ts#watchLimit 读的是同一份数据（用例 14 钉住副本一致性）。
 */
const { OPINION_LIMITS } = require('./benefits.config')

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
      skipped: invalid.slice()
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
      /* 新条目带 first_seen_at：老条目沿用上次的时间，端上靠它判断「对我来说哪些是新的」 */
      const prevByUrl = new Map(prevItems.map((i) => [i.url, i]))
      const merged = items
        .concat(prevItems.filter((p) => p && p.url && !items.some((i) => i.url === p.url)))
        .slice(0, MAX_ITEMS)
        .map((i) => ({
          title: i.title,
          url: i.url,
          source: i.source,
          summary: i.summary || '',
          ...(i.published_date ? { published_date: i.published_date } : {}),
          first_seen_at: (prevByUrl.get(i.url) || {}).first_seen_at || nowIso
        }))
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
    skipped: invalid.slice()
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
