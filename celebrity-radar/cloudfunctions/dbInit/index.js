/**
 * dbInit —— 云数据库运维工具（初始化集合 / 比对字段 / 补字段 / 建·改索引）。
 *
 * ⚠ 这是**运维函数**，不是产品运行时依赖：端上任何代码都不调用它，
 *   只在「环境重建 / 建新集合 / 字段与索引演进」时手工调用一次。
 *
 * ── 能力与边界（先看这条，避免误期待）─────────────────────────────────
 * | 事项            | 能否程序化 | 依据 |
 * |---|---|---|
 * | 建集合          | ✅ | `db.createCollection()`（wx-server-sdk 有） |
 * | 字段比对 / 补字段 | ✅ | 文档型库无 schema，比对的是**实际文档的字段集合** vs `schema.js`；补字段 = `where(_.exists(false)).update()` |
 * | 建 / 改索引      | ✅ 需 access_token | 微信云开发 HTTP API「更新索引」`POST /tcb/updateindex`（**wx-server-sdk 没有索引 API**） |
 * | 列出已有索引     | ❌ | 该接口**只能按索引名新增 / 删除**，没有「列出」能力 ⇒ 见下方「索引比对的做法」 |
 * | 设置集合权限     | ❌ | 无对应接口，仍须控制台手工设置（见 `doc/云开发配置手册.md` §四） |
 *
 * ── 索引比对的做法（没有 list 接口的替代方案）──────────────────────────
 * 按 `schema.js` 里钉死的索引名**逐个幂等 create**：报「已存在」即视为在位，
 * 其余错误原样上报。若索引名没变、字段定义变了（如加了排序字段），
 * 用 `rebuild: true` 走「先 drop 后 create」——这就是「**更新**索引」的全部含义。
 * 注意：并发 / 批量时微信可能整包失败，故批量失败后**自动逐条重试**以定位到具体哪一条。
 *
 * ── action ───────────────────────────────────────────────────────────
 *   'report'   （默认）全量巡检：集合有无 + 字段差异 + 索引计划 + 权限清单，**只读不改**
 *   'init'     只建缺失的集合
 *   'fields'   字段比对；带 `apply: true` 才回填 `schema.js` 里标了 `def` 的字段
 *   'indexes'  索引计划；带 `apply: true` 才真正调 HTTP API 建立（需 access_token）
 *   'sync'     = init + fields(apply) + indexes(apply)，一步到位
 *
 * ── 事件参数 ─────────────────────────────────────────────────────────
 *   action          见上；缺省 'report'
 *   apply           true 才写库 / 调接口（默认 false ⇒ 任何 action 都是 dry-run）
 *   only            ['users', ...] 只处理这些集合（默认全部）
 *   sample          字段抽样文档数，默认 100（上限 1000）
 *   includeOptional 索引：是否处理 `optional: true` 的可选索引（默认 true）
 *   rebuild         索引：先 drop 再 create（索引定义变了才用，默认 false）
 *   purgeDeprecated 字段：删除 `deprecated` 里列出的历史残留字段（默认 false，如 favorites.note）
 *   token           写操作的通行口令，须等于环境变量 DB_ADMIN_TOKEN
 *   access_token / appid / secret  索引：三者任一可绕过环境变量（一次性排查用）
 *
 * ── 安全 ─────────────────────────────────────────────────────────────
 * 本函数以管理员身份运行、**不受集合权限约束**（能读能写任何集合），
 * 而云函数只要部署了就能被小程序端 `wx.cloud.callFunction` 调到 ⇒ 必须设口令：
 *   环境变量 `DB_ADMIN_TOKEN` 存在时，**所有写操作**（init / apply / rebuild / purge）
 *   都要求 `event.token` 与之相等；未配置该变量时写操作**直接拒绝**（只读巡检不受限）。
 * 建议：跑完运维后直接删除本函数（`tcb fn delete dbInit`），别长期挂在线上。
 */
const cloud = require('wx-server-sdk')
const https = require('https')

const { collections: COLLECTIONS, collectionNames: ALL_NAMES, DIRECTION } = require('./schema')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const SAMPLE_MAX = 1000
const WRITE_ACTIONS = ['init', 'sync']

/* ────────────────────────── 工具 ────────────────────────── */

/** 实际类型（文档型库里 array 也是 object，故单独识别；null 单独返回供 nullable 判定） */
function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v === 'object' ? 'object' : typeof v
}

function matchType(v, field) {
  const t = typeOf(v)
  if (t === 'null') return field.nullable
  if (field.type === 'any') return true
  return t === field.type
}

/** 集合是否存在：不存在时 get() 抛 -502005（云函数是管理员身份，无权限干扰） */
async function collectionExists(name) {
  try {
    await db.collection(name).limit(1).get()
    return true
  } catch (err) {
    return false
  }
}

/** 按 only 过滤 + 只留 `schema.js` 里声明的集合（**表名永不来自调用方**，白名单硬过滤） */
function selectDefs(event) {
  const only = Array.isArray(event.only) && event.only.length ? event.only : null
  const defs = only ? COLLECTIONS.filter((c) => only.includes(c.name)) : COLLECTIONS
  const unknown = only ? only.filter((n) => !ALL_NAMES.includes(n)) : []
  return { defs, unknown }
}

function pickSamples(docs, def) {
  const declared = new Set(def.fields.map((x) => x.name))
  const seen = new Set()
  const extra = new Set()
  const mismatch = []
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      seen.add(key)
      if (!declared.has(key)) extra.add(key)
    }
    for (const field of def.fields) {
      if (!(field.name in doc)) continue
      if (!matchType(doc[field.name], field)) {
        mismatch.push({
          field: field.name,
          expected: field.nullable ? `${field.type} | null` : field.type,
          actual: typeOf(doc[field.name]),
          sampleId: doc._id
        })
      }
    }
  }
  return { seen, extra: [...extra], mismatch }
}

/* ─────────────────────── 集合：初始化 ─────────────────────── */

async function ensureCollections(defs, apply) {
  const results = []
  for (const def of defs) {
    if (await collectionExists(def.name)) {
      results.push({ collection: def.name, action: 'exists' })
      continue
    }
    if (!apply) {
      results.push({ collection: def.name, action: 'will-create' })
      continue
    }
    try {
      await db.createCollection(def.name)
      results.push({ collection: def.name, action: 'created' })
    } catch (err) {
      /* 并发被别人抢先建好 / 真的失败：再探一次来区分 */
      const nowExists = await collectionExists(def.name)
      results.push({
        collection: def.name,
        action: nowExists ? 'exists' : 'error',
        error: nowExists ? '并发已建' : String((err && err.errMsg) || err)
      })
    }
  }
  return results
}

/* ─────────────────────── 字段：比对与回填 ─────────────────────── */

/**
 * 字段巡检：抽样看「实际字段集合」，再对可回填字段做一次 count()。
 * 回填策略（与 schema.js 头注释一致）：
 *   required 缺失 → 只报告（数据异常）；有 def 且缺失 → 按默认值补齐。
 */
async function inspectFields(def, event) {
  const sample = Math.min(Number(event.sample) || 100, SAMPLE_MAX)
  let docs = []
  try {
    docs = (await db.collection(def.name).limit(sample).get()).data || []
  } catch (err) {
    return { collection: def.name, ok: false, error: `抽样失败：${(err && err.errMsg) || err}` }
  }

  const { seen, extra, mismatch } = pickSamples(docs, def)
  const deprecated = (def.deprecated || []).map((d) => d.name)
  const missing = def.fields.filter((x) => !x.system && !seen.has(x.name)).map((x) => x.name)
  const absentRequired = def.fields.filter((x) => x.required && !x.system && !seen.has(x.name)).map((x) => x.name)
  const backfillable = def.fields.filter((x) => !x.system && !x.required && 'def' in x && !seen.has(x.name))

  /* 对可回填字段数一遍「缺字段的文档条数」：抽样看不见 ≠ 一行都没有，这批数字才是回填的真实影响面 */
  const pending = []
  for (const field of backfillable) {
    let docs_missing = null
    try {
      const res = await db.collection(def.name).where({ [field.name]: _.exists(false) }).count()
      docs_missing = res.total
    } catch (err) {
      docs_missing = `count 失败：${(err && err.errMsg) || err}`
    }
    pending.push({ field: field.name, default: field.def, docs_missing })
  }

  let purge = null
  if (event.purgeDeprecated && deprecated.length) {
    purge = []
    for (const name of deprecated) {
      let total = null
      try {
        total = (await db.collection(def.name).where({ [name]: _.exists(true) }).count()).total
      } catch (err) {
        total = `count 失败：${(err && err.errMsg) || err}`
      }
      purge.push({ field: name, docs_with_field: total })
    }
  }

  return {
    collection: def.name,
    ok: true,
    sampled: docs.length,
    /* 下面四项是**样本口径**（看的是抽到的那几条），不是全库统计；backfill_pending 才是全库 count() */
    basis: `抽样 ${docs.length} 条`,
    missing_fields: missing,
    missing_required: absentRequired,
    unexpected_fields: extra.filter((k) => !deprecated.includes(k)),
    deprecated_in_sample: extra.filter((k) => deprecated.includes(k)),
    type_mismatch: mismatch.slice(0, 10),
    backfill_pending: pending,
    purge_pending: purge
  }
}

/** 按默认值补齐「有 def 的可选字段」（只碰缺失的行；已存在的行一个字都不动） */
async function backfillFields(def, pending) {
  const results = []
  for (const item of pending) {
    if (typeof item.docs_missing !== 'number') {
      results.push({ field: item.field, action: 'skipped', reason: item.docs_missing })
      continue
    }
    if (item.docs_missing === 0) {
      results.push({ field: item.field, action: 'nothing-to-do' })
      continue
    }
    const field = def.fields.find((x) => x.name === item.field)
    try {
      const res = await db.collection(def.name).where({ [item.field]: _.exists(false) }).update({ data: { [item.field]: field.def } })
      results.push({ field: item.field, action: 'filled', default: field.def, updated: (res.stats && res.stats.updated) || 0 })
    } catch (err) {
      results.push({ field: item.field, action: 'error', error: String((err && err.errMsg) || err) })
    }
  }
  return results
}

/** 删掉 deprecated 里列出的历史残留字段（默认关闭；`_.remove()` 只删字段、不删行） */
async function purgeDeprecatedFields(def, pending) {
  const results = []
  for (const item of pending) {
    if (typeof item.docs_with_field !== 'number' || item.docs_with_field === 0) {
      results.push({ field: item.field, action: 'nothing-to-do' })
      continue
    }
    try {
      const res = await db.collection(def.name).where({ [item.field]: _.exists(true) }).update({ data: { [item.field]: _.remove() } })
      results.push({ field: item.field, action: 'purged', updated: (res.stats && res.stats.updated) || 0 })
    } catch (err) {
      results.push({ field: item.field, action: 'error', error: String((err && err.errMsg) || err) })
    }
  }
  return results
}

/* ─────────────────── 索引：HTTP API（SDK 无此能力） ─────────────────── */

/**
 * 本环境 ID：云函数里 process.env.TCB_ENV 即当前环境。
 *
 * **不设兜底值**：原来那句兜底写死的是作者自己的环境 ID，fork 之后会把索引建到别人的库里，
 * 而且失败时毫无提示。都取不到就抛可读错误，由 main 的 try/catch 转成返回体。
 */
function currentEnv(event) {
  const env = event.env || process.env.TCB_ENV || process.env.SCF_NAMESPACE
  if (!env) {
    throw new Error('无法确定云环境 ID：请显式传入 event.env，或确认云函数环境变量中存在 TCB_ENV')
  }
  return env
}

function httpsJson(method, url, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : {}
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (err) {
            reject(new Error(`响应非 JSON：${raw.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('请求超时（15s）')))
    if (body) req.write(body)
    req.end()
  })
}

/**
 * 取 access_token。优先 `stable_token`（官方推荐，不会踢掉小程序其他调用在用的 token）；
 * 仅在其不可用时降级到老的 `/cgi-bin/token`，并在结果里明确标注 —— 老接口会**使旧 token 失效**。
 * 云函数出网不受「request 合法域名」限制（那是小程序端的约束），故可直接访问 api.weixin.qq.com。
 */
async function getAccessToken(event) {
  if (event.access_token) return { token: event.access_token, source: 'event.access_token' }
  const appid = event.appid || process.env.WX_APPID
  const secret = event.secret || process.env.WX_APPSECRET
  if (!appid || !secret) {
    return { token: null, reason: '缺少凭据：请配环境变量 WX_APPID / WX_APPSECRET，或直接传 event.access_token' }
  }
  try {
    const res = await httpsJson('POST', 'https://api.weixin.qq.com/cgi-bin/stable_token', {
      grant_type: 'client_credential',
      appid,
      secret,
      force_refresh: false
    })
    if (res && res.access_token) return { token: res.access_token, source: 'stable_token', expires_in: res.expires_in }
    const legacy = await httpsJson('GET', `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`)
    if (legacy && legacy.access_token) {
      return { token: legacy.access_token, source: 'cgi-bin/token', warning: 'stable_token 不可用，已降级用老接口（会使用旧 token 失效）' }
    }
    return { token: null, reason: `取 token 失败：${JSON.stringify(res).slice(0, 200)}` }
  } catch (err) {
    return { token: null, reason: `取 token 异常：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** schema 的 keys → HTTP API 的 keys（direction 必须是 '1' / '-1' / '2dsphere' 字符串） */
function toApiIndex(item) {
  return {
    name: item.name,
    unique: !!item.unique,
    keys: item.keys.map((k) => ({ name: k.field, direction: DIRECTION[k.dir] || '1' }))
  }
}

/**
 * 判一次「建索引」的结果（P2-33）。
 *
 * 这个接口不返回结构化冲突码，只能按 errmsg 认。但**认不出来时绝不能猜成「已在位」**：
 * 把一条真失败记成 `exists`，运维看着巡检报告会以为索引齐了，而缺掉的索引会让相关查询
 * 静默退化成全表扫（正是本函数最该防的那类问题）。故口径收窄成三档：
 *   · 命中明确的「已存在 / 重复」措辞 ⇒ 'exists'（真的在位）
 *   · 其它一律 ⇒ 'unknown'（拿不准，附原始 errcode/errmsg 让人定夺）
 *
 * 刻意**不再**匹配「冲突」「重复」这类宽泛词：errmsg 里出现它们的其它错误（参数校验、
 * 字段类型不符等）会被误判成「已在位」，那才是真正危险的方向。
 */
function indexAttemptAction(res) {
  const msg = String((res && (res.errmsg || res.message)) || '')
  if (/already\s*exists|index\s+exist|索引.{0,6}已存在|already\s*exist|duplicate\s*key|DuplicateKey/i.test(msg)) {
    return 'exists'
  }
  return 'unknown'
}

async function callUpdateIndex(env, name, createIndexes, dropIndexes, token) {
  const url = `https://api.weixin.qq.com/tcb/updateindex?access_token=${token}`
  return httpsJson('POST', url, {
    env,
    collection_name: name,
    create_indexes: createIndexes,
    drop_indexes: dropIndexes
  })
}

/**
 * 逐集合同步索引。因为没有「列出已有索引」的接口，做法是**幂等 create**：
 * 报「已存在」即视为在位；整包失败时**逐条重试**以定位到具体哪一条（并发或命名冲突都可能让整包失败）。
 */
async function syncIndexes(defs, event, apply, token, env) {
  const includeOptional = event.includeOptional !== false
  const results = []
  for (const def of defs) {
    const picked = def.indexes.filter((i) => includeOptional || !i.optional)
    if (!picked.length) {
      results.push({ collection: def.name, indexes: [], note: 'schema 未声明索引（主键 _id 自带唯一索引）' })
      continue
    }
    const apiIndexes = picked.map(toApiIndex)
    if (!apply) {
      results.push({ collection: def.name, indexes: apiIndexes.map((i) => ({ name: i.name, action: 'will-create', keys: i.keys })) })
      continue
    }

    const items = []
    /* 「更新索引」= 先删后建：名字没变但字段/顺序变了（如多加一个排序字段）只能这么改 */
    if (event.rebuild) {
      for (const idx of apiIndexes) {
        try {
          const res = await callUpdateIndex(env, def.name, [], [{ name: idx.name }], token)
          items.push({ name: idx.name, action: res.errcode === 0 ? 'dropped' : 'drop-skipped', errcode: res.errcode, errmsg: res.errmsg })
        } catch (err) {
          items.push({ name: idx.name, action: 'drop-error', error: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    let res = null
    try {
      res = await callUpdateIndex(env, def.name, apiIndexes, [], token)
    } catch (err) {
      items.push({ name: '(batch)', action: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    if (res && res.errcode === 0) {
      for (const idx of apiIndexes) items.push({ name: idx.name, action: 'created' })
    } else if (res) {
      /* 整包失败 ⇒ 逐条重试，把「哪几条其实已在位 / 哪几条真的失败」分开报告 */
      items.push({ name: '(batch)', action: 'failed', errcode: res.errcode, errmsg: res.errmsg, note: '已改逐条重试' })
      for (const idx of apiIndexes) {
        try {
          const one = await callUpdateIndex(env, def.name, [idx], [], token)
          items.push(
            one.errcode === 0
              ? { name: idx.name, action: 'created' }
              : { name: idx.name, action: indexAttemptAction(one), errcode: one.errcode, errmsg: one.errmsg }
          )
        } catch (err) {
          items.push({ name: idx.name, action: 'error', error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
    /* 有「拿不准」的条目就顶到这一层的顶层，否则它会埋在几十条 indexes 里没人看（P2-33） */
    const unsure = items.filter((i) => i.action === 'unknown')
    results.push(
      unsure.length
        ? { collection: def.name, indexes: items, needs_review: unsure.map((i) => i.name) }
        : { collection: def.name, indexes: items }
    )
  }
  return results
}

/* ───────────────────────── 入口 ───────────────────────── */

/** 口令闸门：只读巡检放行；任何写路径都必须在 DB_ADMIN_TOKEN 存在且 token 相符时才放行 */
function gateWrites(action, event) {
  const writes = WRITE_ACTIONS.includes(action) || event.apply === true || event.rebuild === true || !!event.purgeDeprecated
  if (!writes) return null
  const required = process.env.DB_ADMIN_TOKEN
  if (!required) return '拒绝写操作：未配置环境变量 DB_ADMIN_TOKEN（只读巡检不需口令；建议设一个随机串防误调）'
  if (String(event.token || '') !== required) return '拒绝写操作：event.token 与环境变量 DB_ADMIN_TOKEN 不符'
  return null
}

/**
 * 入口：**必须有最外层 try/catch**（P2-34）。
 *
 * `currentEnv()` 取不到环境 ID 时会主动抛错，它的注释写着「由 main 的 try/catch 转成返回体」——
 * 而此前 main 根本没有这一层，于是本该是「一句可读的返回体」的东西变成了函数抛异常：在控制台
 * 只看到调用失败，看不到到底缺哪个环境变量。工具类函数尤其不该这样：它的输出就是它的产品。
 */
exports.main = async (event = {}) => {
  try {
    return await runDbInit(event)
  } catch (err) {
    const msg = (err && err.errMsg) || (err && err.message) || String(err)
    console.warn(`[dbInit] 巡检中断：${msg}`)
    return {
      ok: false,
      error: msg,
      hint: '若提示缺环境 ID：显式传 {"action":"report","env":"<环境ID>"}，或给云函数配 TCB_ENV'
    }
  }
}

/** 巡检主体：正常逻辑都写在这里，异常由上面的入口统一转成返回体 */
async function runDbInit(event) {
  const action = String(event.action || 'report')
  if (!['report', 'init', 'fields', 'indexes', 'sync'].includes(action)) {
    return { ok: false, error: `未知 action：${action}`, allowed: ['report', 'init', 'fields', 'indexes', 'sync'] }
  }

  const denied = gateWrites(action, event)
  if (denied) return { ok: false, action, error: denied, hint: '只读巡检：{"action":"report"}' }

  const { defs, unknown } = selectDefs(event)
  const doCollections = action === 'init' || action === 'sync' || action === 'report'
  const doFields = action === 'fields' || action === 'sync' || action === 'report'
  const doIndexes = action === 'indexes' || action === 'sync' || action === 'report'
  /* dry-run 是默认值：只有显式 apply 才写库 / 调接口；report 永远只读 */
  const apply = action !== 'report' && event.apply === true

  const out = {
    ok: true,
    action,
    apply,
    env: currentEnv(event),
    dryRun: !apply,
    collections_targeted: defs.map((d) => d.name),
    unknown_collections: unknown,
    hint: apply ? '已按 apply=true 执行写操作' : '本次为 dry-run（未写库）；确认无误后加 "apply": true 重跑'
  }

  if (doCollections) out.collections = await ensureCollections(defs, apply)

  if (doFields) {
    out.fields = []
    for (const def of defs) {
      const report = await inspectFields(def, event)
      if (apply && report.ok) {
        report.backfill_applied = await backfillFields(def, report.backfill_pending)
        if (event.purgeDeprecated && report.purge_pending) {
          report.purge_applied = await purgeDeprecatedFields(def, report.purge_pending)
        }
      }
      out.fields.push(report)
    }
    /* 必填字段缺失 = 数据有问题，单独顶到结果最前面提示（绝不回填掩盖） */
    const broken = out.fields.filter((x) => x.ok && x.missing_required && x.missing_required.length)
    if (broken.length) out.warning_required_fields_missing = broken.map((x) => ({ collection: x.collection, missing: x.missing_required }))
  }

  if (doIndexes) {
    const tokenInfo = await getAccessToken(event)
    out.index_token = { source: tokenInfo.source || null, ok: !!tokenInfo.token, reason: tokenInfo.reason || null, warning: tokenInfo.warning || null }
    out.indexes = await syncIndexes(defs, event, apply && !!tokenInfo.token, tokenInfo.token, currentEnv(event))
    if (apply && !tokenInfo.token) {
      /* 无 token 时把完整的请求体裁剪输出，可直接拿去「云开发控制台 → 数据库 → 索引管理」或 curl 使用 */
      out.indexes_manual = defs
        .filter((d) => d.indexes.length)
        .map((d) => ({
          collection: d.name,
          http: `POST https://api.weixin.qq.com/tcb/updateindex?access_token=ACCESS_TOKEN`,
          body: {
            env: currentEnv(event),
            collection_name: d.name,
            create_indexes: d.indexes.filter((i) => event.includeOptional !== false || !i.optional).map(toApiIndex),
            drop_indexes: []
          }
        }))
    }
  }

  /* 权限改不了：把设计要求的 ACL 逐表列出，供人工在控制台核对 */
  out.permissions_manual = defs.map((d) => ({ collection: d.name, acl: d.acl.label, note: d.acl.rule ? '自定义规则（见 doc/云开发配置手册.md §四）' : '控制台预设' }))
  out.token_gate = process.env.DB_ADMIN_TOKEN ? '已配置 DB_ADMIN_TOKEN，写操作需传 event.token' : '未配置 DB_ADMIN_TOKEN ⇒ 写操作一律拒绝'

  return out
}
