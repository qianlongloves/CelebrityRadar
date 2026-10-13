/**
 * opinionCluster —— 舆情事件落库：**定时读库后聚类**，把「同一件事的多条来源」写成事件集合。
 *
 * ## 触发 / 入口
 *
 *   · **定时触发**（本函数的本职）：由 cloudbaserc.json 的 timer 驱动（默认每天 10:00，
 *     排在 notifyFollowUpdates 09:00 / keywordAlert 09:20 / riskWatch 09:40 之后，
 *     四个任务各错开，避免挤在同一个 60s 窗口里）。
 *   · **被管理侧调用**（控制台 / 运维）：与定时同路（都没有调用方 openid）。
 *   · ⚠ **拒绝端上调用**（同 keywordAlert / riskWatch 的 P0-21 闸门）：判据是
 *     「端上 callFunction 时 getWXContext().OPENID 必有值，而定时器 / 控制台没有」。
 *     端上读事件是**直接读集合**（opinion_events 只读），从不调本函数。
 *
 * ## 零上游成本（本函数**不联网**）
 *
 * 本函数**只读库**（feed_cache / keywords / risk_signals 这三处「已存在的舆情条目」）后聚类，
 * **不新增任何上游检索调用（不调博查、不调模型）**。故 require 里**没有 https**，也没有任何 key。
 * 这与 keywordAlert / riskWatch 有本质区别：它们是「花钱去查」，本函数是「把已经查到的归拢」。
 *
 * ## 与端上同源（关键约束）
 *
 * 端上聚类在 `src/utils/opinion-events.ts` + `src/utils/opinion-rank.ts`（TS）。云函数是 JS、
 * 不能 require 端上 TS，故这里**复制**了同一批判据（normalizeTitle / sameEvent / credibilityOf /
 * isOfficialSource / sourceNatureOf / themeTokenOf / objectKeyOf / eventKeyOf / impactOf / responseOf /
 * pickEventTitle …）。**两端一致性由 test/cases/29-opinion-cluster.js 的用例钉住**（读本文件的导出、
 * 逐输入比对行为，漂移即红）—— 与「风险词典两端一致」用例（test/cases/01-pure.js）同法。
 * 改判据必须两端一起改。
 *
 * ## 事件身份（稳定主题键）
 *
 * `event_key = hashOf(objectKey#themeToken)`，规则与冲突处理见 src/utils/opinion-events.ts 顶部注释。
 * **同一事件后续新增报道时 event_key 不变**，靠两道保底：① 主题词锚定「日期最早」的报道；
 * ② 新一轮聚类若与某条**已存在事件**判为同一事件，就**沿用它的 event_key**（见下方 adopt）。
 *
 * ## 单轮上限预算（照 keywordAlert / riskWatch 的 MAX_* 做法，理由见各常量注释）
 *
 *   · MAX_SOURCES —— 单轮最多读入多少条存量条目；
 *   · MAX_EVENTS  —— 单轮最多写成 / 更新多少事件；
 *   · MAX_EVENTS_READ —— 读入多少条已存在事件用于「沿用旧键」。
 *
 * ## 合规红线（与端上 opinion-events.ts 同等）
 *
 *   · 涉政涉军仍拒答：本层只对**已经过上游过滤**的存量条目聚类，不新增来源、不放开 / 新增拦截；
 *   · 无来源的条目不进时间线、也不参与「是否需回应」判断（只计入 memberCount 与影响面）；
 *   · 聚合 ≠ 认定：可信度最高只到「官方通报」，绝不把多条报道写成「已证实」。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/* ─────────────────────────── 上限预算 ─────────────────────────── */

/**
 * 单轮最多读入多少条存量条目。理由：feed_cache 每人约 10 条、keywords 每词约 20 条、
 * risk_signals 每人至多几十条，全库叠加可能上千；聚类是 O(组数 × 成员数) 的字符串比较，
 * 不限量会让一轮的内存与耗时随数据线性膨胀（云函数 60s 上限）。取 400 是「够覆盖活跃数据、
 * 又稳稳跑得完」的折中：超出的按发布时间**由近及远**截断（最近的最该被聚成事件）。
 */
const MAX_SOURCES = 400
/** 单轮最多写成 / 更新多少事件：与端上一屏能看的量级一致，超出部分下一轮继续 */
const MAX_EVENTS = 200
/** 读入多少条已存在事件用于「沿用旧键」比对：上限 + 兜底，避免与存量规模无关的全表扫 */
const MAX_EVENTS_READ = 500
/** 单个事件保留的成员上限（超出按时间保留最近的）：一条事件不该无限长 */
const MAX_MEMBERS = 30
/** 单个事件保留的时间线节点上限（同上，保留最近的） */
const MAX_TIMELINE = 30
/** 翻页取全表的页大小与硬上限（同 keywordAlert / riskWatch） */
const PAGE_SIZE = 100
const MAX_ROWS = 5000

const SOURCE_TABLES = { feed: 'feed_cache', keyword: 'keywords', signal: 'risk_signals' }
const OUT_TABLE = 'opinion_events'

/* ═════════════ 判据（**与端上 opinion-rank / opinion-events 同源，改动须两处同步**）═════════════ */

function asText(v) {
  return typeof v === 'string' ? v.trim() : ''
}

/** 解析时间串为毫秒；不可解析返回 null */
function parseMs(date) {
  const s = asText(date)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/** 时间排序权重：不可解析按最旧算（垫底） */
function dateRank(date) {
  const ms = parseMs(date)
  return ms === null ? Number.NEGATIVE_INFINITY : ms
}

/** 标题归一：去掉空白与标点，只留中日韩 / 字母 / 数字并转小写（与 opinion-rank#normalizeTitle 逐字一致） */
function normalizeTitle(title) {
  return asText(title)
    .replace(/[^\u3400-\u9fffa-zA-Z0-9]/g, '')
    .toLowerCase()
}

/** 互相包含判同事件的最短长度门槛（与 opinion-rank#DUP_MIN_CHARS 一致） */
const DUP_MIN_CHARS = 8
/** 公共前缀判同事件的长度门槛（与 opinion-rank#DUP_PREFIX_CHARS 一致） */
const DUP_PREFIX_CHARS = 12

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/** 同事件判定（与 opinion-rank#sameEvent 逐字一致） */
function sameEvent(a, b) {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const min = Math.min(na.length, nb.length)
  if (min >= DUP_MIN_CHARS && (na.includes(nb) || nb.includes(na))) return true
  return commonPrefixLen(na, nb) >= DUP_PREFIX_CHARS
}

/** 官方来源标识词（与 opinion-rank#OFFICIAL_MARKERS 逐条一致） */
const OFFICIAL_MARKERS = [
  '官方',
  '通报',
  '公安',
  '警方',
  '法院',
  '检察院',
  '市场监管',
  '税务',
  '海关',
  '网信',
  '证监会',
  '新闻办',
  '人民政府',
  '政府',
  '管理局',
  '卫健委',
  '纪委',
  '监察'
]

function isOfficialSource(source) {
  const s = asText(source)
  return !!s && OFFICIAL_MARKERS.some((m) => s.includes(m))
}

/** 可信度推导（与 opinion-rank#credibilityOf 逐字一致） */
function credibilityOf(sources) {
  const uniq = [...new Set((Array.isArray(sources) ? sources : []).map(asText).filter(Boolean))]
  if (uniq.length === 0) return 'unknown'
  if (uniq.some(isOfficialSource)) return 'official'
  return uniq.length >= 2 ? 'multi' : 'single'
}

/** 影响面排序权重：高 > 中 > 低 > 未评级 */
const IMPACT_RANK = { high: 3, mid: 2, low: 1, unknown: 0 }
/** 需回应严格度：建议回应 > 建议关注 > 无需回应 > 未知 */
const RESPONSE_STRICT = { respond: 3, watch: 2, none: 1, unknown: 0 }
/** 来源性质权威度（标题选取次级排序用）：官方 > 媒体 > 未标注 */
const NATURE_RANK = { official: 2, media: 1, unknown: 0 }

function normLevel(v) {
  return v === 'high' || v === 'mid' || v === 'low' ? v : undefined
}

function asRiskCategory(v) {
  return v === 'judicial' || v === 'tax' || v === 'contract' || v === 'rights' || v === 'statement'
    ? v
    : undefined
}

/** 影响面：只认已有级别字段（与 opinion-rank#impactOf 一致） */
function impactOf(level) {
  return normLevel(level) || 'unknown'
}

/** 是否需回应（与 opinion-rank#responseOf 一致） */
function responseOf(category, level) {
  const lv = normLevel(level)
  const cat = asRiskCategory(category)
  if (lv === 'high') return 'respond'
  if (cat === 'rights' || cat === 'statement') return 'watch'
  if (cat || lv) return 'none'
  return 'unknown'
}

/** 来源性质：启发式，只看来源名（与 opinion-events#sourceNatureOf 一致） */
function sourceNatureOf(source) {
  const s = asText(source)
  if (!s) return 'unknown'
  return isOfficialSource(s) ? 'official' : 'media'
}

/** 源字符串 → 稳定短哈希（FNV-1a 32 位；与 opinion-events#hashOf 同算法） */
function hashOf(text) {
  let h = 0x811c9dc5
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 锚点比较（与 opinion-events#anchorBetter 一致） */
function anchorBetter(a, b) {
  const am = parseMs(a && a.date)
  const bm = parseMs(b && b.date)
  if ((am === null) !== (bm === null)) return am !== null
  if (am !== null && bm !== null && am !== bm) return am < bm
  return normalizeTitle(String((a && a.title) || '')) < normalizeTitle(String((b && b.title) || ''))
}

/** 主题核心词（与 opinion-events#themeTokenOf 一致） */
function themeTokenOf(members) {
  const list = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === 'object' && !!asText(m.title))
  if (!list.length) return ''
  let best = list[0]
  for (const m of list) if (anchorBetter(m, best)) best = m
  return normalizeTitle(String(best.title || ''))
}

/** 对象键（与 opinion-events#objectKeyOf 一致） */
function objectKeyOf(members) {
  const counts = new Map()
  for (const m of Array.isArray(members) ? members : []) {
    const label = asText(m && m.label)
    if (label) counts.set(label, (counts.get(label) || 0) + 1)
  }
  let best = ''
  let bestN = 0
  for (const label of [...counts.keys()].sort()) {
    const n = counts.get(label) || 0
    if (n > bestN) {
      best = label
      bestN = n
    }
  }
  return best
}

/** 事件稳定键（与 opinion-events#eventKeyOf 一致） */
function eventKeyOf(objectKey, themeToken) {
  return hashOf(`${asText(objectKey)}#${asText(themeToken)}`)
}

/** 事件标题比较（与 opinion-events#titleBetter 一致） */
function titleBetter(a, b) {
  const la = normalizeTitle(a.title).length
  const lb = normalizeTitle(b.title).length
  if (la !== lb) return la > lb
  const na = NATURE_RANK[sourceNatureOf(a.source)]
  const nb = NATURE_RANK[sourceNatureOf(b.source)]
  if (na !== nb) return na > nb
  return dateRank(a.date) > dateRank(b.date)
}

/** 事件标题选取（与 opinion-events#pickEventTitle 一致） */
function pickEventTitle(members) {
  const withSource = members.filter((m) => !!asText(m.source))
  const pool = withSource.length > 0 ? withSource : members
  let best = pool[0]
  for (const m of pool) if (titleBetter(m, best)) best = m
  return best.title
}

/* ─────────────────────────── 分页取全表 ─────────────────────────── */

/**
 * 翻页取全表（同 keywordAlert / riskWatch）。按 `_id` 升序翻页、以**空页**收尾（而不是「不满页就停」）。
 * `maxRows` 为本函数的自设上限：到了就停并告警，避免单轮内存 / 耗时失控。
 */
async function listAll(collection, where, maxRows = MAX_ROWS) {
  const out = []
  for (;;) {
    let query = db.collection(collection)
    if (where) query = query.where(where)
    const res = await query.orderBy('_id', 'asc').skip(out.length).limit(PAGE_SIZE).get()
    const batch = (res && res.data) || []
    if (!batch.length) return out
    out.push(...batch)
    if (out.length >= maxRows) {
      console.warn(`[opinionCluster] ${collection} 取数达到上限 ${maxRows}，本轮只处理这一部分`)
      return out
    }
  }
}

/* ─────────────────────────── 读存量条目 ─────────────────────────── */

/** 从三处已存在的舆情缓存/流水里收集条目（不联网），并截断摘要 */
function pushEntry(out, e) {
  if (!e || !asText(e.title)) return
  out.push(e)
}

/**
 * 读库收集存量条目。三处各司其职：
 *   · feed_cache —— 关注动态（每条 = 一个人的动态一条）；
 *   · keywords   —— 关键词预警缓存（每条 = 一个词的检索结果一条）；
 *   · risk_signals —— 名人风险信号流水（带 category/level，是影响面/需回应的唯一依据）。
 * 三者都被上游过滤过（报告生成拒答 + contentCheck + 端上 sensitive），本函数只归拢、不新增。
 */
async function collectSources() {
  const out = []

  for (const row of await listAll(SOURCE_TABLES.feed)) {
    const label = asText(row && row._id)
    for (const it of Array.isArray(row && row.items) ? row.items : []) {
      pushEntry(out, {
        block: 'feed',
        title: String((it && it.title) || ''),
        summary: asText(it && it.content),
        source: asText(it && it.source),
        date: asText(it && (it.publishedDate || it.published_date)),
        label,
        /* 条目级分级字段（P4-B，可能没有）：feed_cache 写入前已由云端写口
           （aiProxy/report-store.js#storeSaveFeed）用风险词典补齐，有则透传给 deriveEvent
           （影响面 / 需回应据此计算），没有则维持「未评级 / 未知」。 */
        category: asRiskCategory(it && it.category),
        level: normLevel(it && it.level)
      })
    }
  }

  for (const row of await listAll(SOURCE_TABLES.keyword)) {
    const label = asText(row && row.keyword)
    for (const it of Array.isArray(row && row.items) ? row.items : []) {
      pushEntry(out, {
        block: 'alert',
        title: String((it && it.title) || ''),
        summary: asText(it && it.summary),
        source: asText(it && it.source),
        date: asText(it && it.published_date),
        label,
        /* 条目级分级字段（P4-B，可能没有）：keywords.items 写入前已由 keywordAlert 用风险词典补齐
           （与 riskWatch / risk.ts 同源），有则透传，没有则维持「未评级 / 未知」。 */
        category: asRiskCategory(it && it.category),
        level: normLevel(it && it.level)
      })
    }
  }

  for (const row of await listAll(SOURCE_TABLES.signal)) {
    pushEntry(out, {
      block: 'alert',
      title: String((row && row.title) || ''),
      summary: asText(row && row.quote),
      source: asText(row && row.source),
      date: asText(row && row.first_seen_at),
      label: asText(row && row.name),
      category: asRiskCategory(row && row.category),
      level: normLevel(row && row.level)
    })
  }

  return out
}

/* ─────────────────────────── 聚类与装配 ─────────────────────────── */

/** 按 sameEvent 分组（与端上 buildOpinionGroups 同一判据：只与组首成员比） */
function groupBySameEvent(entries) {
  const groups = []
  for (const e of entries) {
    const g = groups.find((grp) => sameEvent(grp[0].title, e.title))
    if (g) g.push(e)
    else groups.push([e])
  }
  return groups
}

/** 成员去重键：同标题 + 同来源 + 同时间算同一条重复上报 */
const memberKey = (m) => `${asText(m.title)}\u0000${asText(m.source)}\u0000${asText(m.date)}`

/** 去重 + 按时间升序（不可解析垫底）+ 超过上限保留最近的 MAX_MEMBERS 条 */
function normalizeMembers(list) {
  const seen = new Set()
  const uniq = []
  for (const m of list) {
    const k = memberKey(m)
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(m)
  }
  uniq.sort((a, b) => dateRank(a.date) - dateRank(b.date) || (normalizeTitle(a.title) < normalizeTitle(b.title) ? -1 : 1))
  return uniq.length > MAX_MEMBERS ? uniq.slice(uniq.length - MAX_MEMBERS) : uniq
}

/** 由成员集合推导出事件的全部字段（纯函数；event_key 由 objectKey + themeToken 现算） */
function deriveEvent(members) {
  const members2 = normalizeMembers(members).map((m) => {
    const member = {
      block: m.block,
      title: m.title,
      summary: m.summary || '',
      source: m.source || '',
      date: m.date || '',
      nature: sourceNatureOf(m.source),
      label: m.label || '',
      impact: impactOf(m.level),
      response: responseOf(m.category, m.level)
    }
    if (m.category) member.category = m.category
    if (m.level) member.level = m.level
    return member
  })
  if (!members2.length) return null

  /* 影响面取成员里最高 */
  let impact = 'unknown'
  for (const m of members2) if (IMPACT_RANK[m.impact] > IMPACT_RANK[impact]) impact = m.impact

  /* 时间线 + 需回应只认**带来源**的成员（红线 2）；无来源者仍计入 memberCount / 影响面 */
  let response = 'unknown'
  const dated = []
  members2.forEach((m, i) => {
    if (!asText(m.source)) return
    if (RESPONSE_STRICT[m.response] > RESPONSE_STRICT[response]) response = m.response
    const ms = parseMs(m.date)
    if (ms !== null) dated.push({ m, ms, i })
  })
  dated.sort((a, b) => a.ms - b.ms || a.i - b.i)
  let timeline = dated.map(({ m }) => ({
    date: m.date,
    source: m.source,
    nature: m.nature,
    text: m.title,
    block: m.block,
    label: m.label
  }))
  if (timeline.length > MAX_TIMELINE) timeline = timeline.slice(timeline.length - MAX_TIMELINE)

  const sources = [...new Set(members2.map((m) => m.source).filter(Boolean))]
  const labels = [...new Set(members2.map((m) => m.label).filter(Boolean))]
  const titleMember = pickEventTitle(members2)
  const objectKey = objectKeyOf(members2)
  const themeToken = themeTokenOf(members2)
  const first = dated.length ? dated[0].m.date : ''
  const last = dated.length ? dated[dated.length - 1].m.date : ''

  return {
    event_key: eventKeyOf(objectKey, themeToken),
    object_key: objectKey,
    /* 主块取「标题所取成员」的块（端上事件卡的归属；存库事件不用于跳转，够用） */
    block: titleMember.block,
    title: pickEventTitle(members2),
    members: members2,
    memberCount: members2.length,
    timeline,
    sources,
    labels,
    impact,
    credibility: credibilityOf(sources),
    response,
    first_at: first,
    last_at: last
  }
}

/** 两条事件是否判为同一事件：任一成员标题（或事件标题）互相 sameEvent 即算 */
function eventMatches(a, b) {
  const at = [a.title, ...(a.members || []).map((m) => m && m.title)].filter(Boolean)
  const bt = [b.title, ...(b.members || []).map((m) => m && m.title)].filter(Boolean)
  for (const x of at) for (const y of bt) if (sameEvent(x, y)) return true
  return false
}

/* ─────────────────────────── 入口 ─────────────────────────── */

exports.main = async (event) => {
  const ctxOpenid = (cloud.getWXContext() || {}).OPENID
  if (ctxOpenid) {
    console.warn('[opinionCluster] 拒绝端上调用：本函数只由定时器触发')
    return { ok: false, skipped: '本函数只由定时器触发，不接受端上调用' }
  }

  const skipped = []
  const sources = await collectSources()
  if (!sources.length) {
    return { ok: true, upstream: 0, sources: 0, groups: 0, events: 0, created: 0, updated: 0, skipped }
  }

  /* 只保留最近的 MAX_SOURCES 条（发布/首次见到时间由近及远） */
  sources.sort((a, b) => dateRank(b.date) - dateRank(a.date))
  const bounded = sources.slice(0, MAX_SOURCES)
  if (sources.length > MAX_SOURCES) {
    skipped.push(`存量条目 ${sources.length} 条，本轮按时间取最近 ${MAX_SOURCES} 条`)
  }

  const groups = groupBySameEvent(bounded)

  /* 读已存在事件：用于「同一事件沿用旧键」（见文件头「事件身份」第 2 条保底） */
  const existingRows = await listAll(OUT_TABLE, undefined, MAX_EVENTS_READ)
  const byId = new Map(existingRows.map((r) => [String(r._id), r]))

  const nowIso = new Date().toISOString()
  let created = 0
  let updated = 0

  for (const group of groups.slice(0, MAX_EVENTS)) {
    const base = deriveEvent(group)
    if (!base) continue

    /* ① 先找一条已存在事件：成员标题判为同一事件 → 沿用它的 event_key */
    let adopted = null
    for (const row of existingRows) {
      if (eventMatches(base, row)) {
        adopted = row
        break
      }
    }

    let id
    let members = base.members
    if (adopted) {
      id = String(adopted._id)
      members = base.members.concat(Array.isArray(adopted.members) ? adopted.members : [])
    } else {
      /* ② 没有可沿用的：用现算键；若键已被一条**判为不同事件**的行占用（哈希碰撞），加后缀避让 */
      id = base.event_key
      let suffix = 1
      while (byId.has(id) && !eventMatches(base, byId.get(id))) {
        suffix += 1
        id = `${base.event_key}-${suffix}`
      }
    }

    const derived = deriveEvent(members)
    if (!derived) continue
    /* event_key 固定为落库主键（沿用旧键 / 避让后的键）；其余字段由合并后的成员重算 */
    derived.event_key = id
    derived.updated_at = nowIso

    const existed = byId.has(id)
    try {
      await db.collection(OUT_TABLE).doc(id).set({ data: derived })
      if (existed || adopted) updated++
      else created++
      /* 记进内存索引：同轮内后续组也能沿用到刚写的事件 */
      byId.set(id, Object.assign({ _id: id }, derived))
    } catch (err) {
      skipped.push({ event: id, reason: `写事件失败：${String((err && err.message) || err)}` })
    }
  }

  return {
    ok: true,
    /* 上游检索调用次数：恒为 0（本函数只读库，不联网）—— 汇报时用来自证不消耗博查 */
    upstream: 0,
    sources: bounded.length,
    groups: groups.length,
    events: created + updated,
    created,
    updated,
    skipped
  }
}

/* 供运维排查 / 端云一致性用例使用：暴露同源判据与身份函数（改判据必须两处同步） */
exports.normalizeTitle = normalizeTitle
exports.sameEvent = sameEvent
exports.credibilityOf = credibilityOf
exports.isOfficialSource = isOfficialSource
exports.sourceNatureOf = sourceNatureOf
exports.themeTokenOf = themeTokenOf
exports.objectKeyOf = objectKeyOf
exports.eventKeyOf = eventKeyOf
exports.impactOf = impactOf
exports.responseOf = responseOf
exports.deriveEvent = deriveEvent
exports.eventMatches = eventMatches
exports.DUP_MIN_CHARS = DUP_MIN_CHARS
exports.DUP_PREFIX_CHARS = DUP_PREFIX_CHARS
exports.OFFICIAL_MARKERS = OFFICIAL_MARKERS
