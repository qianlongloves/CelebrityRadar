/**
 * notifyFollowUpdates —— 关注的人有新动态时，用订阅消息提醒用户一次。
 *
 * 触发：定时触发器（cloudbaserc.json 的 triggers，默认每天 09:00）。
 * 环境变量（控制台 → 云函数 → notifyFollowUpdates → 配置 → 环境变量）：
 *   BOCHA_API_KEY          博查搜索 key（与 aiProxy 共用同一枚）
 *   SUBSCRIBE_TEMPLATE_ID  订阅消息模板 ID，须与 src/config/public.ts 的
 *                          subscribeTemplateId 指向同一个模板
 *
 * 消息模板字段（选模板时必须包含这两项，键名不符微信会报 47003）：
 *   thing1  提醒内容（≤20 个字符）
 *   date2   更新时间
 *
 * 权限：本函数用**云调用**发消息，必须靠同目录 config.json 的
 *   permissions.openapi: ["subscribeMessage.send"]
 * 声明授权，且随「上传并部署」一起生效（与 contentCheck 的 security.msgSecCheck 同理）。
 * ⚠ 缺这条声明时平台会直接拒绝 openapi 调用（报 openapi permission denied，而**不是** 43101），
 * 表现是日志里天天 failed、用户一条提醒都收不到 —— 排查先看 config.json。
 *
 * 四个设计取舍：
 * 1. 主动检索而非只读现成缓存。feed_cache / report_cache 只在用户手动触发时才更新，
 *    若纯读缓存，「关注了一个月没打开过的人」永远不会有可推的更新，提醒也就永不发生。
 * 2. 一次授权一条。微信一次性订阅的规则如此，故推送成功后立刻把 subscribe_ok 复位；
 *    不复位的话下一次发送会拿到 43101（用户未授权），日志里天天报错却没有提醒送达。
 * 3. 写回 feed_cache 的条目必须与端上 utils/search.ts 的 NewsItem **同构**（含 content）：
 *    这张缓存是端上关注流卡片与 utils/weekly.ts 的数据源，定时任务若只写「标题 + 链接」，
 *    同一个人会出现「端上刷过就有摘要、云端刷过就变空」的脏数据，周报读 e.content 还会直接抛错。
 * 4. **推送在前、写回在后**（P2-28）。写回 feed_cache 就等于宣布「这批条目已经推过了」，
 *    所以它只能在推送跑完之后做；顺序颠倒会把「没送出去」当成「送出去了」——
 *    而这条路径上没有任何报错，只有一条 skipped 日志，属于最难发现的那种丢消息。
 */
const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'
const TIMEOUT_MS = 15000
/** 单次运行最多检索多少个人物：博查按次计费，云函数默认 60s 超时也撑不住更多 */
const MAX_QUERIES = 20
/** 同一人物的最短重检间隔，避免定时任务与用户手动刷新在同一天重复打上游 */
const REFRESH_GAP_MS = 20 * 60 * 60 * 1000
/** thing 类字段的字符数上限（微信按字符算，中文一个算一个） */
const THING_MAX = 20

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

/** 统一成 ISO（端上写入的 publishedDate 也是 ISO，pickWindowEntries 用 Date.parse 比较） */
function normDate(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/**
 * 博查检索 → NewsItem[]（与端上 utils/search.ts#toNewsItem 字段完全一致）。
 * ⚠ summary 必须为 true：内容要随条目一起写回 feed_cache，不然关注流卡片摘要为空、
 * 周报读 e.content 抛 undefined.slice（见文件头设计取舍 3）。
 */
async function searchPerson(name, key) {
  const res = await postJson(
    BOCHA_ENDPOINT,
    { Authorization: `Bearer ${key}` },
    { query: `${name} 最新动态`, freshness: 'oneWeek', summary: true, count: 10 },
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
        content: String(p.summary || p.snippet || '').trim(),
        source: String(p.siteName || '').trim() || hostOf(url)
      }
      const publishedDate = normDate(p.datePublished) || normDate(p.dateLastCrawled)
      if (publishedDate) item.publishedDate = publishedDate
      return item
    })
    .filter((x) => x.url && x.title)
}

/** 按字符数截断（微信 thing 字段按字符计，中文一个算一个） */
function clamp(text, max) {
  const chars = Array.from(String(text || '').trim())
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`
}

/** date 类字段要求 yyyy-MM-dd HH:mm 形态 */
function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
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
 * 调用方闸门（P0-21，2026-10-09）：本函数只该由**定时器**触发，端上一次都不该调它
 * （端上只调 contentCheck / aiProxy / quotaGuard / payCreate / hotBoardRefresh）。
 *
 * 判据：端上 `wx.cloud.callFunction` 调用时 `getWXContext().OPENID` 必有值，
 * 而定时器触发、控制台「云端测试」都没有 openid。
 *
 * 挡的是「改包后循环调用」：本函数一轮要打 BOCHA 检索（还按用户数放大）并群发订阅消息，
 * 端上能反复触发就等于把上游额度与推送配额交给任何人点火。
 */
exports.main = async () => {
  if ((cloud.getWXContext() || {}).OPENID) {
    console.warn('[notifyFollowUpdates] 拒绝端上调用：本函数只由定时器触发')
    return { ok: false, skipped: '本函数只由定时器触发，不接受端上调用' }
  }

  const bochaKey = readEnv('BOCHA_API_KEY')
  const tmplId = readEnv('SUBSCRIBE_TEMPLATE_ID')
  if (!bochaKey || !tmplId) {
    /* 未配置不是错误：函数可能先于模板上线部署，静默跳过即可（不产生失败告警） */
    return {
      ok: false,
      skipped: '缺少环境变量：' + [!bochaKey && 'BOCHA_API_KEY', !tmplId && 'SUBSCRIBE_TEMPLATE_ID'].filter(Boolean).join(' / ')
    }
  }

  // 1. 只服务「已授权提醒」的用户（分页取全 —— 裸 limit 会让第 101 个之后的用户永远收不到，见 listAll）
  const users = await listAll('users', { subscribe_ok: true })
  if (!users.length) return { ok: true, users: 0, queries: 0, pushed: 0 }

  // 2. 关注关系（一次读全表后在内存分组，避免 N+1 查询）
  const byUser = new Map()
  for (const f of await listAll('follows')) {
    if (!f || !f.openid || !f.person_key) continue
    if (!byUser.has(f.openid)) byUser.set(f.openid, [])
    byUser.get(f.openid).push(f)
  }

  // 3. 汇总本轮要核对的人物（跨用户去重，同一个人只查一次）
  const targets = new Map()
  for (const u of users) {
    for (const f of byUser.get(u._openid) || []) targets.set(f.person_key, f.name)
  }

  const results = new Map() // personKey -> { items, prevUrls, fresh }
  let queries = 0
  for (const [personKey, name] of targets) {
    if (queries >= MAX_QUERIES) break
    const cached = await db
      .collection('feed_cache')
      .doc(personKey)
      .get()
      .catch(() => null)
    const prev = (cached && cached.data) || null
    const prevItems = (prev && prev.items) || []
    const prevUrls = new Set(prevItems.map((i) => i && i.url).filter(Boolean))

    /* 缓存足够新就复用：定时任务与用户当天的手动刷新不该打两次上游 */
    if (prev && prev.fetched_at && Date.now() - Date.parse(prev.fetched_at) < REFRESH_GAP_MS) {
      results.set(personKey, { items: prevItems, prevUrls, fresh: false })
      continue
    }

    try {
      const items = await searchPerson(name, bochaKey)
      queries++
      results.set(personKey, { items, prevUrls, fresh: true })
    } catch (err) {
      /* 单个人物失败不拖垮整轮：留原文供下次比对，本轮该人物视为无更新 */
      results.set(personKey, { items: prevItems, prevUrls, fresh: false, error: String(err && err.message) })
    }
  }

  /*
   * 4. 逐用户判定并推送。
   *
   * P2-28：推送**排在写回 feed_cache 之前**。以前的顺序是「先写回、再推送」，于是某个用户
   * 推送遇到瞬时错误（不是 43101 那种「授权已消耗」的确定性失败）时，这批条目已经进了
   * `prevUrls` —— 下一轮 diff 出来是空集，**这个人永远收不到这条更新**，而日志里只有一行
   * skipped，看起来一切正常。取舍：出现过瞬时失败的人物，其缓存本轮**不写回**，下一轮重试；
   * 代价是同一人物下已经收到的那部分用户可能重复收到一次 —— 重复一次远好于永久漏推。
   */
  let pushed = 0
  const skipped = []
  /** 本轮推送出现过「可重试失败」的人物：其 feed_cache 不写回（写回就等于放弃这条更新） */
  const retryPersons = new Set()
  for (const u of users) {
    const mine = byUser.get(u._openid) || []
    let totalNew = 0
    let lead = null // { personKey, name, item }
    for (const f of mine) {
      const r = results.get(f.person_key)
      if (!r) continue
      const news = r.items.filter((i) => i && i.url && !r.prevUrls.has(i.url))
      if (!news.length) continue
      totalNew += news.length
      if (!lead) lead = { personKey: f.person_key, name: f.name, item: news[0] }
    }
    if (!lead || totalNew === 0) continue

    try {
      await cloud.openapi.subscribeMessage.send({
        touser: u._openid,
        templateId: tmplId,
        /* ⚠ 分包路径（2026-10-14 起二级页都在 package/ 下）：这里必须与 app.config.ts
           的 subpackages 一致，写成 `pages/report/index` 用户点开消息会到不了目标页 ——
           云函数与端上解耦，端上改了路径这边不会报错，只会静默失效（2026-10-16 修）。 */
        page: `package/report/index?personKey=${encodeURIComponent(lead.personKey)}`,
        miniprogramState: 'formal',
        lang: 'zh_CN',
        data: {
          thing1: { value: clamp(`${lead.name}有${totalNew}条新动态：${lead.item.title}`, THING_MAX) },
          date2: { value: formatDate(new Date()) }
        }
      })
      pushed++
      /* 一次性订阅：这条用掉了授权，立刻复位；否则下次发送必得 43101。
         复位写失败不影响「已经推出去」这个事实，故自己吃掉异常 —— 别把成功算成失败
         （算成失败会让人物的缓存不写回，害得其它用户下一轮重复收到）。 */
      await db
        .collection('users')
        .doc(u._id)
        .update({ data: { subscribe_ok: false } })
        .catch(() => undefined)
    } catch (err) {
      /* 43101 = 用户已取消或授权已消耗；这类失败属正常状态，只记录不告警 */
      const msg = String((err && err.errMsg) || (err && err.message) || err)
      skipped.push({ openid: String(u._openid).slice(0, 8) + '***', reason: msg })
      if (/43101|user refuse/i.test(msg)) {
        await db
          .collection('users')
          .doc(u._id)
          .update({ data: { subscribe_ok: false } })
          .catch(() => undefined)
      } else {
        /* 瞬时失败：重试有意义 ⇒ 标记这些人物的缓存本轮不写回（下一轮还会 diff 出这批条目） */
        for (const f of mine) retryPersons.add(f.person_key)
      }
    }
  }

  /*
   * 5. 推送跑完才写回 feed_cache（P2-28）。
   *   这一步是「这批条目已经推过了」的唯一凭据，所以必须晚于推送；写早了就是把没送出去的消息
   *   当成送出去了。本轮推送有瞬时失败的人物跳过不写，留给下一轮重试。
   */
  let updated = 0
  for (const [personKey, r] of results) {
    if (!r.fresh) continue
    if (retryPersons.has(personKey)) {
      skipped.push({ openid: '(feed_cache)', reason: `${personKey}: 本轮推送存在瞬时失败，缓存不写回，下一轮重试` })
      continue
    }
    try {
      await db
        .collection('feed_cache')
        .doc(personKey)
        .set({ data: { items: r.items, fetched_at: new Date().toISOString() } })
      updated++
    } catch (err) {
      results.set(personKey, Object.assign({}, r, { writeError: String(err && err.message) }))
    }
  }

  return { ok: true, users: users.length, targets: targets.size, queries, updated, pushed, skipped }
}
