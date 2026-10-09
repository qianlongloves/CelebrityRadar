/**
 * keywordAlert —— 关键词舆情预警：定时检索用户订阅的词，出现新报道时落站内预警并提醒一次。
 *
 * 触发：定时触发器（cloudbaserc.json 的 triggers，默认每天 09:20 —— 与 notifyFollowUpdates
 * 的 09:00 错开 20 分钟：两个任务都要打博查，挤在同一个 60s 窗口里会互相拖慢甚至半途超时；
 * 错开后上游限流也更容易扛住）。
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

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const TIMEOUT_MS = 15000
/** 单轮最多检索多少个关键词：博查按次计费，云函数默认 60s 超时也撑不住更多 */
const MAX_KEYWORDS = 20
/** 每人订阅上限（云侧兜底；端上 utils/keyword-alert.ts 也拦一道，但端上判定可被改包绕过） */
const MAX_WATCHES_PER_USER = 5
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

exports.main = async () => {
  const bochaKey = readEnv('BOCHA_API_KEY')
  if (!bochaKey) return { ok: false, skipped: '缺少环境变量：BOCHA_API_KEY' }
  const tmplId = readEnv('ALERT_TEMPLATE_ID')

  // 1. 订阅关系：一次读全表在内存分组（跨用户去重，避免按人查上游）
  const watchesRes = await db.collection(WATCH_TABLE).limit(1000).get()
  const byKeyword = new Map()
  const watchRows = []
  for (const w of watchesRes.data || []) {
    /* 同一张表还存着「监控某人」的行（type='person'，第 1 期 riskWatch 用）：它们的 keyword
       存的是人名，不是要检索的关键词 —— 不过滤就会把名人名当关键词再查一遍（白花钱）。
       老行没有 type 字段（2026-10-08 那批关键词订阅），故只有显式 person 才跳过。 */
    if (w && w.type === 'person') continue
    if (!w || !w.openid || !w.keyword) continue
    watchRows.push(w)
    if (!byKeyword.has(w.keyword)) byKeyword.set(w.keyword, [])
    byKeyword.get(w.keyword).push(w.openid)
  }
  if (!byKeyword.size) return { ok: true, keywords: 0, users: 0, pushed: 0 }

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
    skipped: []
  }
  if (!userNews.size) return summary

  /* 没配模板就到此为止：站内预警（keywords 表）已经写好，端上进预警页照样看得到；
     推送是「顺手多一件事」，不该因为模板还没申请就整轮失败。 */
  if (!tmplId) {
    summary.skipped.push('未配置 ALERT_TEMPLATE_ID：已写站内预警，跳过推送')
    return summary
  }

  // 5. 只推给「已授权预警推送」的用户，每人一条（取本轮新增最多的那个词）
  const usersRes = await db.collection('users').where({ alert_ok: true }).limit(100).get()
  const alerters = new Map((usersRes.data || []).map((u) => [u._openid, u]))

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

/* 供运维排查用：确认「每人最多订阅几个词」与端上常量一致 */
exports.MAX_WATCHES_PER_USER = MAX_WATCHES_PER_USER
exports.watchId = watchId
