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
 * 两个设计取舍：
 * 1. 主动检索而非只读现成缓存。feed_cache / report_cache 只在用户手动触发时才更新，
 *    若纯读缓存，「关注了一个月没打开过的人」永远不会有可推的更新，提醒也就永不发生。
 * 2. 一次授权一条。微信一次性订阅的规则如此，故推送成功后立刻把 subscribe_ok 复位；
 *    不复位的话下一次发送会拿到 43101（用户未授权），日志里天天报错却没有提醒送达。
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

/** 博查检索（定时任务只需近一周的条目，取回标题与链接即可） */
async function searchPerson(name, key) {
  const res = await postJson(
    BOCHA_ENDPOINT,
    { Authorization: `Bearer ${key}` },
    { query: `${name} 最新动态`, freshness: 'oneWeek', summary: false, count: 10 },
    TIMEOUT_MS
  )
  const code = Number((res.data && res.data.code) ?? res.status)
  if (res.status !== 200 || code !== 200) {
    throw new Error(`HTTP ${res.status} / code ${code}`)
  }
  const inner = res.data && res.data.data
  const pages = (inner && inner.webPages && inner.webPages.value) || []
  return pages
    .map((p) => ({
      title: String(p.name || '').trim(),
      url: String(p.url || '').trim(),
      source: String(p.siteName || '').trim(),
      publishedDate: p.datePublished || ''
    }))
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

exports.main = async () => {
  const bochaKey = readEnv('BOCHA_API_KEY')
  const tmplId = readEnv('SUBSCRIBE_TEMPLATE_ID')
  if (!bochaKey || !tmplId) {
    /* 未配置不是错误：函数可能先于模板上线部署，静默跳过即可（不产生失败告警） */
    return {
      ok: false,
      skipped: '缺少环境变量：' + [!bochaKey && 'BOCHA_API_KEY', !tmplId && 'SUBSCRIBE_TEMPLATE_ID'].filter(Boolean).join(' / ')
    }
  }

  // 1. 只服务「已授权提醒」的用户
  const usersRes = await db.collection('users').where({ subscribe_ok: true }).limit(100).get()
  const users = usersRes.data || []
  if (!users.length) return { ok: true, users: 0, queries: 0, pushed: 0 }

  // 2. 关注关系（一次读全表后在内存分组，避免 N+1 查询）
  const followsRes = await db.collection('follows').limit(1000).get()
  const byUser = new Map()
  for (const f of followsRes.data || []) {
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

  // 4. 先把新条目写回 feed_cache：否则下次运行会把同一批条目再当成「新增」，重复推送
  let updated = 0
  for (const [personKey, r] of results) {
    if (!r.fresh) continue
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

  // 5. 逐用户判定并推送
  let pushed = 0
  const skipped = []
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
        page: `pages/report/index?personKey=${encodeURIComponent(lead.personKey)}`,
        miniprogramState: 'formal',
        lang: 'zh_CN',
        data: {
          thing1: { value: clamp(`${lead.name}有${totalNew}条新动态：${lead.item.title}`, THING_MAX) },
          date2: { value: formatDate(new Date()) }
        }
      })
      pushed++
      /* 一次性订阅：这条用掉了授权，立刻复位；否则下次发送必得 43101 */
      await db.collection('users').doc(u._id).update({ data: { subscribe_ok: false } })
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
      }
    }
  }

  return { ok: true, users: users.length, targets: targets.size, queries, updated, pushed, skipped }
}
