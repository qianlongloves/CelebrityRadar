/**
 * notifyFollowUpdates —— 「关注的人有新动态」或「我跟进的舆情事件有新进展」时，
 * 用订阅消息提醒用户一次。
 *
 * 触发：定时触发器（cloudbaserc.json 的 triggers，默认每天 09:00）。
 * 环境变量（控制台 → 云函数 → notifyFollowUpdates → 配置 → 环境变量）：
 *   BOCHA_API_KEY          博查搜索 key（与 aiProxy 共用同一枚）。**缺失只停「关注的人」这类候选**
 *                          （那类要打上游检索），跟进事件是纯读库，照样能提醒
 *   SUBSCRIBE_TEMPLATE_ID  订阅消息模板 ID，须与 src/config/public.ts 的
 *                          subscribeTemplateId 指向同一个模板
 *
 * 消息模板字段（选模板时必须包含这两项，键名不符微信会报 47003）：
 *   thing1  提醒内容（≤20 个字符）
 *   time2   更新时间（time 类型，只收 HH:mm，带日期会被判格式错误）
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
 *
 * ## E1（2026-10-16）：第二类候选 —— 「我跟进的事件有新进展」
 *
 * `opinion_event_status`（每人一行，`_id = openid`，ACL 仅创建者可读写）过去**只由端上读写、
 * 云端不介入**；这里以管理员身份翻页读它，是本项目对这一行的**第一个云端读口**。
 * 不新建订阅表、不新建模板：`follows`（event_key → 跟进时刻）本身就是订阅关系，
 * 判定复用端上同一套口径（见 src/utils/opinion-store.ts 文件头「跟进」一节）：
 *
 *   「有新进展」 ⟺ `last_at > max(读过时刻 reads[key], 已提醒时刻 event_notified[key], 跟进时刻 follows[key])`
 *
 * 三个基线缺一个都会出错：
 *   · `reads[key]` —— 用户自己点过「标记已读」的，不该再被同一件事打扰；
 *   · `event_notified[key]`（水位，写在本函数的 users 行里，端上不读）—— 上一轮已经提醒过。
 *     ⚠ 少了它会**天天重复提醒同一件事**：端上打开详情页**刻意不自动标已读**
 *     （见 test/cases/30-event-timeline.js），用户看完并不会推进 reads，第二天条件照样成立；
 *   · `follows[key]` —— 我决定盯它的那一刻。少了它，「跟进一件早已结束的事」（reads 为空、
 *     last_at 是很久以前）会被误判成有新进展。
 *
 * 水位放 `users.event_notified` 而不是塞回 `follows`：后者是端上直写的个人状态，云端往里写
 * 就等于制造第二个写者，且端上整行写回时会把它抹掉。水位只留最近 `EVENT_NOTIFIED_MAX` 条
 * （与 opinion_event_status 的裁剪同一思路）—— 宁可少记，也不让单文档无限长。
 *
 * ## 候选挑选：两类候选抢同一个 thing1
 *
 *   · 只有一类成立 → 就发那一类（**不当沉默的理由**，两类各自回答不同的问题）；
 *   · 两类都成立 → **会员优先「我跟进的事」，非会员先给「关注的人」**（D5 定的付费点）。
 *     理由：事件是用户一条一条**点名**要跟的，关注的人是「这个人可能有动静」。
 *     免费档不因此少拿信息 —— 两类候选都还在预警页 / 事件页里，差别只是正文先给谁；
 *     ⚠ 这条优先级**不产生任何上游调用**（事件候选纯读库），故与共享缓存成本无因果
 *     （doc/产品优化路线图.md §3.3 S3-1：付费项必须与缓存无因果关系）。
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
/** E1：跟进事件那一类候选要读的两张表（`opinion_events` 的 `_id` 就是 event_key） */
const EVENT_TABLE = 'opinion_events'
const STATUS_TABLE = 'opinion_event_status'
/**
 * 一次 `where(in)` 最多塞多少个 event_key。取 **20** 而不是 100：单次 get 能取回多少行由平台
 * 决定（小程序端 20 / 服务端默认 100，与 listAll 注释里那条同源），取二者中小的那个才能在
 * 联调与线上都不丢行。塞 100 个键、平台只回 20 行，症状正是「跟了 30 件事，只有前 20 件会提醒」
 * —— 没有报错、没有日志，纯漏。
 */
const EVENT_QUERY_CHUNK = 20
/** users.event_notified 最多留多少条水位（按时刻留最近），防单文档无限增长 */
const EVENT_NOTIFIED_MAX = 30

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

/* ───────────────── 订阅消息下发（@push-send begin）─────────────────
 * 为什么不直接 `cloud.openapi.subscribeMessage.send` 一条路走到黑：
 *   云调用的「免鉴权」只在**由小程序端触发的云函数**里成立（微信云调用文档原文；CloudBase
 *   错误码 INVALID_WX_ACCESS_TOKEN 的官方解释就是「未从小程序端触发使用云调用的云函数」）。
 *   本函数由**定时器**触发，没有小程序端上下文 ⇒ 线上表现是每轮 `pushed` 恒为 0、一条都发不
 *   出去，而且失败发生在扫描之后、不落 scan_logs，日志看着全绿（2026-10-22 实测：同一枚模板、
 *   同一个 openid，自取 token 后直连返回 errcode 0 并真实收到消息）。
 *   所以：先试云调用（将来若改成端上触发、或平台行为变化，它仍是最省事的一条），只对「通道类」
 *   错误降级到自己取 token 直连；43101 这类业务错误原样抛出，绝不重试（重试只会白白再消耗一次
 *   授权，用户还得多点一次「允许」）。
 * ⚠ 本段在 notifyFollowUpdates / keywordAlert / riskWatch 三处**逐字一致**，
 *   改一处必须三处同改（test/cases/96-push-channel.js 钉住）。
 */
const WX_API_BASE = 'https://api.weixin.qq.com'
let pushTokenCache = { appid: '', token: '', exp: 0 }
let pushOpenapiUsable = true

/** 云调用拿不到鉴权的典型报错：只对这些降级，别的错误照旧抛给调用方 */
function isPushChannelError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err)
  return /invalid wx openapi access_token|INVALID_WX_ACCESS_TOKEN|-501001|openapi permission denied|-604101/i.test(
    msg
  )
}

/**
 * 自建 access_token。
 * 用 `stable_token` 而不是 `/cgi-bin/token`：后者会把此前发放的 token 全部作废 —— 云开发侧自己也在
 * 用同一个 appid 的 token，用老接口等于顺手把别的 openapi 调用搞坏（dbInit 里是同源取舍）。
 */
async function wxAccessToken(force) {
  const appid = readEnv('WX_APPID')
  const secret = readEnv('WX_APPSECRET')
  if (!appid || !secret) return null
  if (!force && pushTokenCache.appid === appid && pushTokenCache.token && Date.now() < pushTokenCache.exp) {
    return pushTokenCache.token
  }
  const res = await postJson(
    `${WX_API_BASE}/cgi-bin/stable_token`,
    {},
    { grant_type: 'client_credential', appid, secret, force_refresh: false },
    8000
  )
  const data = res && res.data
  if (!data || !data.access_token) {
    throw new Error(`取 access_token 失败：${(data && `${data.errcode} ${data.errmsg}`) || '无响应'}`)
  }
  /* 提前 5 分钟过期，避免踩在边界上刚好失效 */
  const ttlMs = Math.max(60, (Number(data.expires_in) || 7200) - 300) * 1000
  pushTokenCache = { appid, token: data.access_token, exp: Date.now() + ttlMs }
  return pushTokenCache.token
}

/** 把云调用那套驼峰入参翻成 HTTP 接口的 snake_case —— 调用点因此不必改形状 */
async function sendSubscribeViaHttp(args) {
  const body = {
    touser: args.touser,
    template_id: args.templateId,
    page: args.page,
    miniprogram_state: args.miniprogramState || 'formal',
    lang: args.lang || 'zh_CN',
    data: args.data
  }
  const post = (token) =>
    postJson(
      `${WX_API_BASE}/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`,
      {},
      body,
      10000
    )
  let token = await wxAccessToken(false)
  if (!token) throw new Error('未配置 WX_APPID / WX_APPSECRET：拿不到 access_token，订阅消息无法下发')
  let data = (await post(token)).data
  /* 40001/42001 = token 失效（过期或被别的调用顶掉）：强制刷新后只重试一次 */
  if (data && (Number(data.errcode) === 40001 || Number(data.errcode) === 42001)) {
    token = await wxAccessToken(true)
    data = (await post(token)).data
  }
  if (!data || Number(data.errcode) !== 0) {
    const err = new Error(`${(data && data.errcode) || 'unknown'} ${(data && data.errmsg) || '订阅消息下发失败'}`)
    err.errCode = data && data.errcode
    throw err
  }
  return data
}

/** 订阅消息唯一出口：云调用优先，通道不可用时自动降级（原因见本段开头） */
async function sendSubscribeMessage(args) {
  if (pushOpenapiUsable) {
    try {
      return await cloud.openapi.subscribeMessage.send(args)
    } catch (err) {
      if (!isPushChannelError(err)) throw err
      /* 只在本实例内记忆：冷启动的新实例仍会先试一次，成本可忽略，却能享受平台修好后的好处 */
      pushOpenapiUsable = false
    }
  }
  return sendSubscribeViaHttp(args)
}
/* ───────────────── 订阅消息下发（@push-send end）───────────────── */

/* ───────────────── 整轮执行日志（scan_logs，kind='follow'）─────────────────
 * 这条链路为什么必须留痕：2026-10-22 之前它**一条消息都没发出去过** —— 定时器拿不到云调用的
 * 自动鉴权（见上方 @push-send 段），而失败发生在扫描之后、什么都不写，于是每天 10:30 的自检
 * 都报「一切正常」。整轮写一条、键固定为 `(round)`：这样「一条都没有」本身就是可判定的信号
 * （cron 没跑 / 提前崩了），而不必去推「有授权却没消耗」那种本身有歧义的指标
 * （没新动态本来就不该推，推不出来也正常）。
 */
const LOG_TABLE = 'scan_logs'

async function writeRoundLog(status, hit, total, note) {
  const ranAt = new Date().toISOString()
  try {
    await db
      .collection(LOG_TABLE)
      .add({
        data: {
          _id: `follow#(round)#${ranAt}`,
          kind: 'follow',
          object_key: '(round)',
          object_name: '关注更新',
          ran_at: ranAt,
          status,
          hit: Math.max(0, Number(hit) || 0),
          total: Math.max(0, Number(total) || 0),
          note: String(note || '')
        }
      })
  } catch (err) {
    /* 日志写不进去不能反过来影响推送结果，但也别静默 —— 控制台至少留一行 */
    console.warn(`[notifyFollowUpdates] 写执行日志失败：${err && err.message}`)
  }
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

/** time 类字段只收 HH:mm（带日期部分会被微信判为格式错误，报 47003） */
function formatTime(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ─────────────────── E1：跟进事件的判定与取数（2026-10-16） ─────────────────── */

/** 时刻 → 毫秒；不可解析按 0（「没有基线」= 一切都算有进展，与端上 utils/inbox 同一口径） */
function msOf(v) {
  const t = Date.parse(String(v == null ? '' : v))
  return Number.isFinite(t) ? t : 0
}

/**
 * 水位表裁剪：按时刻留最近 `max` 条，返回新对象（不改入参）。
 * 用时刻排序而不是「对象插入顺序」：这份水位有两个写者口径（云端写、端上整行写回时原样带回），
 * 时间才是唯一可依赖的序（与端上 opinion-store#pruneStatus 同一思路）。
 * 顺带丢掉不可解析的值：留着它们只会让「已提醒」这条基线永远算成 0。
 */
function pruneNotified(map, max) {
  const entries = Object.entries(map && typeof map === 'object' ? map : {}).filter(([, v]) =>
    Number.isFinite(Date.parse(String(v)))
  )
  if (entries.length <= max) return Object.fromEntries(entries)
  entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
  return Object.fromEntries(entries.slice(0, max))
}

/**
 * 调用者是不是有效期内的会员。读 `memberships`（服务端权威，`_id = openid`，端上不可读写），
 * 读库失败一律按**非会员**（fail-closed，与 aiProxy#isActiveMember 同一口径）。
 *
 * 这里只用来决定「两类候选都成立时谁上正文」，判错**不会少发消息**（两类都在候选里，
 * 只是正文先给哪一类）；但也不能反着判 —— 那等于把会员权益送给所有人。
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
 * 从「我盯的事件」里挑一条上正文。纯函数，无副作用。
 *
 * @param st       该用户的 opinion_event_status 行（`{ follows, reads }`）；没跟进 → null
 * @param rows     event_key → 事件行（只用到 `title` / `last_at`）
 * @param notified `users.event_notified` 水位（上一轮已提醒过的时刻）
 * @return null | `{ key, title, at, count }`，count = 有几件盯的事有新进展（用于正文措辞）
 *
 * ⚠ 事件行缺失（被清理 / 键写错）按「没进展」处理，不是「有新进展」：提醒一条用户点开
 * 什么也看不到的消息，比少提醒一次更伤（这也是工作台「未生成」与「无数据」分开的原因）。
 */
function pickEventLead(st, rows, notified) {
  const follows = st && st.follows && typeof st.follows === 'object' ? st.follows : null
  if (!follows) return null
  const reads = st.reads && typeof st.reads === 'object' ? st.reads : {}
  const notifiedMap = notified && typeof notified === 'object' ? notified : {}
  let lead = null
  let count = 0
  for (const key of Object.keys(follows)) {
    const row = rows.get(key)
    if (!row) continue
    const at = Date.parse(String(row.last_at || ''))
    if (!Number.isFinite(at)) continue
    /* 三个基线取最大：读过 / 已提醒 / 决定盯它（少一个都会误判或重复打扰，见文件头） */
    const base = Math.max(msOf(reads[key]), msOf(notifiedMap[key]), msOf(follows[key]))
    if (at <= base) continue
    count++
    /* 多件都有进展时取最近一件上正文（与「关注的人」那类同一取舍：正文一条，其余只计数） */
    if (!lead || at > lead.at) lead = { key, title: String(row.title || '').trim(), at }
  }
  return lead ? { key: lead.key, title: lead.title, at: lead.at, count } : null
}

/**
 * 按 event_key 批量取事件行。**分块查而不是读全表**：这张表只增不减、随整理轮次一直长，
 * 读全表的代价迟早失控（listAll 那条路径是给「行数 = 用户数」的表用的）。
 *
 * 单块失败按「这几件本轮没进展」处理（catch 成空页）：少提醒一次远好于整轮抛错。
 * ⚠ 但**不能**顺手把它记成「已提醒」—— 水位只在该条真的发出去之后才写（见第 4 步）。
 */
async function loadEventRows(keys) {
  const out = new Map()
  for (let i = 0; i < keys.length; i += EVENT_QUERY_CHUNK) {
    const chunk = keys.slice(i, i + EVENT_QUERY_CHUNK)
    const res = await db
      .collection(EVENT_TABLE)
      .where({ _id: db.command.in(chunk) })
      .get()
      .catch((err) => {
        console.warn(`[${EVENT_TABLE}] 取事件失败（这些事件按本轮无进展处理）：${String(err && err.message)}`)
        return null
      })
    for (const row of (res && res.data) || []) {
      if (row && row._id) out.set(row._id, row)
    }
  }
  return out
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

  const tmplId = readEnv('SUBSCRIBE_TEMPLATE_ID')
  if (!tmplId) {
    /* 没有模板就一条也发不出去：这类缺配置直接收工（未配置不是错误 —— 函数可能先于模板
       上线部署，静默跳过即可，不产生失败告警） */
    return { ok: false, skipped: '缺少环境变量：SUBSCRIBE_TEMPLATE_ID' }
  }
  /*
   * BOCHA_API_KEY 缺失只停「关注的人」那一类候选（它要打上游检索）：跟进事件是纯读库，
   * 照样能提醒。以前两枚 key 缺任一就整轮收工，等于「上游 key 没配」顺手关掉了不花钱的能力 ——
   * 而这恰好是 E1 想让用户先感受到的那一半（点一下跟进，第二天真的收到一次提醒）。
   */
  const bochaKey = readEnv('BOCHA_API_KEY')

  // 1. 只服务「已授权提醒」的用户（分页取全 —— 裸 limit 会让第 101 个之后的用户永远收不到，见 listAll）
  const users = await listAll('users', { subscribe_ok: true })
  if (!users.length) {
    /* 早退也要留痕：否则「全站没人订阅」与「cron 没跑」在日志里长得一模一样 */
    await writeRoundLog('skipped', 0, 0, '没有用户订阅关注更新')
    return { ok: true, users: 0, queries: 0, pushed: 0 }
  }

  /* 2/3. 「关注的人」候选：需要打上游检索，故缺 BOCHA_API_KEY 时整段跳过（空表 → 该用户无此类候选） */
  const byUser = new Map()
  const results = new Map() // personKey -> { items, prevUrls, fresh }
  const targets = new Map()
  let queries = 0

  if (bochaKey) {
    // 关注关系（一次读全表后在内存分组，避免 N+1 查询）
    for (const f of await listAll('follows')) {
      if (!f || !f.openid || !f.person_key) continue
      if (!byUser.has(f.openid)) byUser.set(f.openid, [])
      byUser.get(f.openid).push(f)
    }

    // 汇总本轮要核对的人物（跨用户去重，同一个人只查一次）
    for (const u of users) {
      for (const f of byUser.get(u._openid) || []) targets.set(f.person_key, f.name)
    }

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
  }

  /*
   * 3.5 「我盯的事件」候选（E1，2026-10-16）：纯读库，零上游成本。
   *
   * 读 `opinion_event_status`（每人一行，ACL 仅创建者可读写，本函数以管理员身份读全表 ——
   * 这是该项目里对这一行的第一个云端读口，见文件头）。只取有 follows 的行，接着把所有人
   * 跟进的 event_key 去重后**一次**取回事件行：user 数 × 跟随数不该变成 N+1 次查询。
   */
  const statusByUser = new Map() // openid -> { follows, reads }
  const followedKeys = new Set()
  for (const row of await listAll(STATUS_TABLE)) {
    const uid = row && (row._openid || row._id)
    if (!uid) continue
    const follows = row.follows && typeof row.follows === 'object' ? row.follows : null
    if (!follows || !Object.keys(follows).length) continue
    statusByUser.set(uid, { follows, reads: row.reads && typeof row.reads === 'object' ? row.reads : {} })
    for (const key of Object.keys(follows)) followedKeys.add(key)
  }
  const eventRows = followedKeys.size ? await loadEventRows(Array.from(followedKeys)) : new Map()

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
  /** 本轮有多少条正文是「我跟进的事件」（E1）：排障先看这个数，它同时是 D5 付费点的观测口径 */
  let eventPushed = 0
  const skipped = []
  /** 本轮推送出现过「可重试失败」的人物：其 feed_cache 不写回（写回就等于放弃这条更新） */
  const retryPersons = new Set()
  for (const u of users) {
    /* ── 候选一：关注的人有新动态 ── */
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
    const feedLead = lead && totalNew > 0 ? lead : null

    /* ── 候选二：我盯的事件有新进展（E1，纯读库） ── */
    const eventLead = pickEventLead(statusByUser.get(u._openid), eventRows, u.event_notified)

    /* 两类都没有 → 本轮不打扰这个人（两类各自回答不同的问题，任一成立都值得发一条） */
    if (!feedLead && !eventLead) continue

    /*
     * 挑谁上正文：只有一类成立就发那一类（**不当沉默的理由**）；两类都成立才需要分档 ——
     * 会员优先「我跟进的事」，非会员先给「关注的人」（D5 的付费点，见文件头「候选挑选」）。
     * 只在真的两边都有时读一次会员表：白读一次会随订阅者数量放大成一大堆无用调用。
     */
    let useEvent = !!eventLead && !feedLead
    if (feedLead && eventLead) useEvent = await isActiveMember(u._openid)
    /* 正文先给「关注的人」时，事件那条**不记水位**：用户并不知道它有进展，记上等于以后都不提了 */
    const toldEvent = useEvent ? eventLead : null

    /* 先编码再拼页面路径：路径字面量必须留在 `page:` 那一行（test/cases/52-route-params.js 会
       扫字面量与注册表对照，拼成变量就等于这条防线空转） */
    const encKey = toldEvent ? encodeURIComponent(toldEvent.key) : ''
    const encPerson = feedLead ? encodeURIComponent(feedLead.personKey) : ''
    const thing1 = toldEvent
      ? clamp(
          toldEvent.count > 1
            ? `我跟进的${toldEvent.count}件事有新进展：${toldEvent.title}`
            : `我跟进的「${toldEvent.title}」有新进展`,
          THING_MAX
        )
      : clamp(`${feedLead.name}有${totalNew}条新动态：${feedLead.item.title}`, THING_MAX)

    /* 两边相同的字段放一处：别出现「改了 thing1 忘了改另一处」 */
    const base = {
      touser: u._openid,
      templateId: tmplId,
      miniprogramState: 'formal',
      lang: 'zh_CN',
      data: {
        thing1: { value: thing1 },
        time2: { value: formatTime(new Date()) }
      }
    }

    try {
      /*
       * ⚠ 落点必须**写死**成注册过的分包路径（test/cases/52-route-params.js 扫的就是 `page:` 后面的
       * 字面量，再与 app.config.ts 的注册表对照）：拼成变量、或写成 pages/…，用户点开消息到不了
       * 目标页 —— 而云函数与端上解耦，这边不会报错，只会静默失效（全项目唯一的主动召回链路）。
       * 故两个落点各写一次字面量，不做「拼路径」的抽象；参数名 eventKey 与 package/event 的取值一致。
       */
      if (toldEvent) {
        await sendSubscribeMessage(
          Object.assign({}, base, { page: `package/event/index?eventKey=${encKey}` })
        )
      } else {
        await sendSubscribeMessage(
          Object.assign({}, base, { page: `package/report/index?personKey=${encPerson}` })
        )
      }
      pushed++
      if (toldEvent) eventPushed++

      /*
       * 一次性订阅：这条用掉了授权，立刻复位；否则下次发送必得 43101。
       * 另外把「上一轮已经提醒过这件事」写进水位（E1）—— 端上打开详情页**刻意不自动标已读**，
       * 没有水位第二轮会为同一件事再打扰一次（见文件头）。只写上正文的那一类：正文给了
       * 「关注的人」时用户并不知道事件有进展，写水位等于以后再也不提。
       *
       * 这两处写失败都不影响「已经推出去」这个事实，故自己吃掉异常 —— 别把成功算成失败
       * （算成失败会让人物的缓存不写回，害得其它用户下一轮重复收到）。
       */
      const data = { subscribe_ok: false }
      if (toldEvent) {
        data.event_notified = pruneNotified(
          Object.assign({}, u.event_notified || {}, { [toldEvent.key]: new Date().toISOString() }),
          EVENT_NOTIFIED_MAX
        )
      }
      await db
        .collection('users')
        .doc(u._id)
        .update({ data })
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
        /* 瞬时失败：重试有意义 ⇒ 标记这些人物的缓存本轮不写回（下一轮还会 diff 出这批条目）。
           ⚠ 正文是事件那条时**也要**按住人物缓存：这批条目同样一条都没送出去，
           按住只是让下一轮可能重复，放开却是永久漏推（P2-28 的取舍方向）。 */
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

  /* 只有「不是 43101」的失败才值得人看：43101 = 用户没授权，属正常状态（见文件头第 2 条取舍） */
  const hardFails = skipped.filter((s) => !/43101|user refuse/i.test(String((s && s.reason) || '')))
  await writeRoundLog(
    hardFails.length ? 'error' : 'ok',
    pushed,
    users.length,
    hardFails.length
      ? `${hardFails.length} 次推送/写回失败：${String(hardFails[0].reason || '').slice(0, 160)}`
      : pushed
        ? `推送 ${pushed} 人`
        : '本轮无新动态，未推送'
  )

  return {
    ok: true,
    users: users.length,
    targets: targets.size,
    queries,
    updated,
    pushed,
    /* E1 观测口径：本轮跟进事件有几个键参与判定、其中几条真的上了正文 */
    eventKeys: followedKeys.size,
    eventPushed,
    skipped
  }
}
