'use strict'

/**
 * P4-A 事件驱动深挖（受硬预算约束）—— cloudfunctions/{keywordAlert,riskWatch}
 *
 * 要钉住的核心不是「深挖能查到东西」，而是**成本闸门真的生效、且超限不被静默丢弃**：
 *   1. **只在命中时触发**（未命中不发任何额外上游请求）—— 这是成本可控的根本原因；
 *   2. 三层闸门各封一层：每次命中词数（queriesPerHit）/ 单轮（perRunMax）/ 单日（perDayMax）；
 *   3. 超限**记录**（summary.deep_dive + summary.skipped）而不是静默丢；
 *   4. 每次命中只扩 **1** 个查询词（候选词里只取前 1 个）；
 *   5. 未配置模板时的推送路径不受影响（原「跳过推送」行为不变）；
 *   6. 预算常量**取自配置真源**并已被同步到云侧副本（不手抄数字）。
 *
 * 加载方式与 07 / 09 一致：把 `wx-server-sdk` 换成 harness 的内存 DB，https 换成可编程假上游，
 * 断的是**真行为**（打了几次上游、写了哪张表、回执里报了几次跳过），不是源码字面量。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, eq, deepEq, ok, notOk } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const sync = require(path.join(ROOT, 'scripts', 'sync-config.js'))

const HOUR = 3600 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()
/** 与服务端同口径的「今天」：云函数用 +8 时区切天（与 quotaGuard#todayKey 一致） */
const todayKey = () => new Date(Date.now() + 8 * HOUR).toISOString().slice(0, 10)

/* ─────────────────────────── 假上游（http + https） ─────────────────────────── */

/** 一条博查返回：给定条目数组 */
const searchOkItems = (items) => ({
  status: 200,
  data: { code: 200, data: { webPages: { value: items } } }
})
/** 便捷：n 条互不相同的条目（每条 url 唯一） */
const searchOkSeq = (n, tag) =>
  searchOkItems(
    Array.from({ length: n }, (_, i) => ({
      name: `t${tag}-${i}`,
      url: `https://news.example.com/${tag}/${i}`,
      snippet: '正文'
    }))
  )

function fakeHttps(responses) {
  const calls = []
  const module = {
    request(options, cb) {
      const chunks = []
      const req = {
        on() {
          return req
        },
        write(c) {
          chunks.push(c)
        },
        end() {
          const raw = chunks.join('')
          let body = raw
          try {
            body = JSON.parse(raw)
          } catch (e) {
            /* 只关心业务请求体 */
          }
          calls.push({ path: options.path, body })
          const r = responses.length ? responses.shift() : { status: 200, data: {} }
          const res = {
            statusCode: r.status,
            setEncoding() {},
            on(ev, fn) {
              if (ev === 'data') fn(typeof r.data === 'string' ? r.data : JSON.stringify(r.data))
              if (ev === 'end') fn()
              return res
            }
          }
          cb(res)
        },
        destroy() {}
      }
      return req
    }
  }
  return { module, calls }
}

/* ─────────────────────────── 加载定时云函数 ─────────────────────────── */

/** 加载一个定时任务云函数：wx-server-sdk → 内存 DB，https → 假上游；openapi 记录推送尝试 */
function loadTimerFn(name, responses, opts = {}) {
  env.resetAll()
  delete process.env.BOCHA_API_KEY
  delete process.env.ALERT_TEMPLATE_ID
  delete process.env.RISK_TEMPLATE_ID
  Object.assign(process.env, opts.env || {})

  const http = fakeHttps(responses)
  const pushes = []
  const db = env.db.database()
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => ({}), // 定时器：无调用方 openid
    openapi: {
      subscribeMessage: {
        send: (args) => {
          pushes.push(args)
          return Promise.resolve({ errCode: 0 })
        }
      }
    }
  }
  const file = path.join(CLOUD, name, 'index.js')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    if (id === 'https') return http.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(file)]
    return { fn: require(file), calls: http.calls, pushes }
  } finally {
    Module.prototype.require = orig
  }
}

/* ─────────────────────────── 造数据的小工具 ─────────────────────────── */

const wordWatch = (openid, keyword) => ({
  _id: `${openid}#${keyword}`,
  openid,
  keyword,
  type: 'keyword',
  created_at: ago(48 * HOUR)
})
const personWatch = (openid, personKey, name) => ({
  _id: `${openid}#person#${personKey}`,
  openid,
  type: 'person',
  person_key: personKey,
  keyword: name,
  created_at: ago(48 * HOUR)
})
/** 关键词缓存行（fetched_at 刻意做旧，让本轮真的重扫） */
const keywordCache = (keyword, items) => ({
  _id: keyword,
  keyword,
  items,
  fetched_at: ago(25 * HOUR)
})
/** 风险扫描快照（有 baseline_at = 非首轮；scanned_at 做旧以通过重扫间隔） */
const scanRow = (personKey, name) => ({
  _id: personKey,
  person_key: personKey,
  name,
  scanned_at: ago(25 * HOUR),
  baseline_at: ago(30 * HOUR),
  seen_urls: [],
  scanned: 0,
  signals_total: 0
})

const queriesOf = (calls) => calls.map((c) => (c.body && c.body.query) || '').filter(Boolean)
/** 深挖查询词的特征：形如「对象 + 空格 + 最新进展」 */
const deepQueriesOf = (calls) => queriesOf(calls).filter((q) => /\s最新进展$/.test(q))

/* ═════════════════════════ ① 只在命中时触发 ═════════════════════════ */

describe('P4-A 深挖：只在命中时触发（未命中不扩查）', () => {
  it('keywordAlert：本轮没有新报道（只有旧条目）→ 只打 1 次扫描，不发任何深挖请求', async () => {
    const { fn, calls } = loadTimerFn('keywordAlert', [
      searchOkItems([{ name: '旧闻', url: 'https://news.example.com/old', snippet: 'x' }])
    ], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [wordWatch('u1', '甲')])
    env.db.__seed('keywords', [
      keywordCache('甲', [{ title: '旧闻', url: 'https://news.example.com/old', source: 's' }])
    ])

    const res = await fn.main({})

    eq(res.ok, true)
    eq(queriesOf(calls).length, 1, `未命中不该有任何额外检索：${JSON.stringify(queriesOf(calls))}`)
    eq(res.deep_dive.hits, 0)
    eq(res.deep_dive.queries, 0)
    eq(res.deep_dive.skipped_run, 0)
  })

  it('riskWatch：本轮无风险表述命中 → 只打 1 次扫描，不发任何深挖请求', async () => {
    const { fn, calls } = loadTimerFn('riskWatch', [
      searchOkItems([{ name: '某人出席活动', url: 'https://news.example.com/a', snippet: '出席活动' }])
    ], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [personWatch('u1', 'P1#tech', '某人')])
    env.db.__seed('risk_scans', [scanRow('P1#tech', '某人')])

    const res = await fn.main({})

    eq(res.ok, true)
    eq(queriesOf(calls).length, 1, `无命中不该深挖：${JSON.stringify(queriesOf(calls))}`)
    eq(res.deep_dive.hits, 0)
    eq(res.deep_dive.queries, 0)
    eq(env.db.__dump('risk_signals').length, 0)
  })
})

/* ═════════════════════════ ② 命中即深挖 + 合并 ═════════════════════════ */

describe('P4-A 深挖：命中即扩查 1 个词，并把结果并入事件 / 信号', () => {
  it('keywordAlert：命中后扩查「甲 最新进展」，新条目并入 keywords.items（成为事件补充成员）', async () => {
    const { fn, calls } = loadTimerFn('keywordAlert', [
      searchOkItems([{ name: '甲被报道', url: 'https://news.example.com/s1', snippet: 'x' }]),
      searchOkItems([{ name: '甲最新进展', url: 'https://news.example.com/d1', snippet: 'y' }])
    ], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [wordWatch('u1', '甲')])

    const res = await fn.main({})

    eq(res.deep_dive.hits, 1)
    eq(res.deep_dive.queries, 1, '每次命中只扩 1 个查询词')
    /* 只有第 1 个候选词（「最新进展」），没有第 2 个（「回应」）= queriesPerHit 生效 */
    deepEq(deepQueriesOf(calls), ['甲 最新进展'], `深挖查询词：${JSON.stringify(queriesOf(calls))}`)
    const cache = env.db.__dump('keywords').find((r) => r._id === '甲')
    ok(cache, '关键词缓存应被写出')
    const urls = (cache.items || []).map((i) => i.url)
    ok(urls.includes('https://news.example.com/d1'), `深挖命中条目应并入缓存：${JSON.stringify(urls)}`)
    /* 深挖条目带来源与时间（合规红线 2） */
    const dd = (cache.items || []).find((i) => i.url === 'https://news.example.com/d1')
    ok(dd.source, '深挖条目必须带来源')
    ok(dd.first_seen_at, '深挖条目必须带时间')
  })

  it('riskWatch：命中后扩查「某人 最新进展」，仍命中词典的新条目补落 risk_signals', async () => {
    const { fn, calls } = loadTimerFn('riskWatch', [
      searchOkItems([{ name: '某人被起诉', url: 'https://news.example.com/s1', snippet: '某人被起诉' }]),
      searchOkItems([{ name: '某人被立案调查', url: 'https://news.example.com/d1', snippet: '立案调查' }])
    ], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [personWatch('u1', 'P1#tech', '某人')])
    env.db.__seed('risk_scans', [scanRow('P1#tech', '某人')])

    const res = await fn.main({})

    eq(res.deep_dive.hits, 1)
    eq(res.deep_dive.queries, 1)
    deepEq(deepQueriesOf(calls), ['某人 最新进展'])
    eq(res.signals, 2, '扫描 1 条 + 深挖补充 1 条')
    const rows = env.db.__dump('risk_signals')
    const urls = rows.map((r) => r.url)
    ok(urls.includes('https://news.example.com/s1'), '扫描命中应落 signal')
    ok(urls.includes('https://news.example.com/d1'), '深挖命中应作为补充证据落 signal')
    /* 级别口径不变：深挖条目按词典命中类别给级别（立案 = judicial = high），不因深挖而乱标 */
    const dd = rows.find((r) => r.url === 'https://news.example.com/d1')
    eq(dd.category, 'judicial')
    eq(dd.level, 'high')
  })

  it('riskWatch：深挖回来但**不命中词典**的条目不落 signal（不把普通报道盖成风险）', async () => {
    const { fn } = loadTimerFn('riskWatch', [
      searchOkItems([{ name: '某人被起诉', url: 'https://news.example.com/s1', snippet: '某人被起诉' }]),
      searchOkItems([{ name: '某人的新电影开机', url: 'https://news.example.com/d1', snippet: '新片开机' }])
    ], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [personWatch('u1', 'P1#tech', '某人')])
    env.db.__seed('risk_scans', [scanRow('P1#tech', '某人')])

    const res = await fn.main({})

    eq(res.deep_dive.queries, 1, '深挖确实发生了')
    eq(res.signals, 1, '只有扫描那条命中落 signal')
    eq(env.db.__dump('risk_signals').length, 1)
  })
})

/* ═════════════════════════ ③ 单轮 / 单日闸门 ═════════════════════════ */

describe('P4-A 深挖：三层预算闸门生效', () => {
  it('keywordAlert：单轮最多深挖 perRunMax 次，超出部分被跳过并记录', async () => {
    const { fn, calls } = loadTimerFn('keywordAlert', Array.from({ length: 40 }, (_, i) => searchOkSeq(1, i)), {
      env: { BOCHA_API_KEY: 'k' }
    })
    /* 10 个词全部命中（无缓存 → 本轮全扫、全有「新条目」） */
    env.db.__seed('keyword_watches', ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'].map((k) => wordWatch('u1', k)))

    const res = await fn.main({})

    const perRunMax = require(path.join(CLOUD, 'keywordAlert', 'benefits.config')).DEEP_DIVE.perRunMax
    eq(res.deep_dive.hits, 10, '10 个词都命中了')
    eq(res.deep_dive.queries, perRunMax, `单轮深挖次数应被 perRunMax(${perRunMax}) 封顶`)
    eq(res.deep_dive.skipped_run, 10 - perRunMax, '超出的命中被单轮闸门跳过')
    eq(deepQueriesOf(calls).length, perRunMax)
    ok(
      res.skipped.some((s) => String(s).includes('深挖预算不足')),
      `超限要记录而不是静默丢弃：${JSON.stringify(res.skipped)}`
    )
    /* 单日计数应当只涨到 perRunMax（原子预留次数） */
    const quota = env.db.__dump('deep_dive_quota').find((r) => r._id === todayKey())
    eq(quota.count, perRunMax)
  })

  it('keywordAlert：单日预算耗尽 → 一次都不扩查，且明确记录（不静默）', async () => {
    const perDayMax = require(path.join(CLOUD, 'keywordAlert', 'benefits.config')).DEEP_DIVE.perDayMax
    const { fn, calls } = loadTimerFn('keywordAlert', [searchOkSeq(1, 0)], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [wordWatch('u1', '甲')])
    /* 当日额度已用满 */
    env.db.__seed('deep_dive_quota', [{ _id: todayKey(), date: todayKey(), count: perDayMax }])

    const res = await fn.main({})

    eq(res.deep_dive.hits, 1, '命中了')
    eq(res.deep_dive.queries, 0, '单日额度耗尽 → 不扩查')
    eq(res.deep_dive.skipped_day, 1)
    eq(queriesOf(calls).length, 1, '只打了扫描那一次上游')
    ok(
      res.skipped.some((s) => String(s).includes('深挖预算不足')),
      `应记录而非静默：${JSON.stringify(res.skipped)}`
    )
  })

  it('riskWatch：单日预算耗尽 → 一次都不扩查，只落扫描信号', async () => {
    const perDayMax = require(path.join(CLOUD, 'riskWatch', 'benefits.config')).DEEP_DIVE.perDayMax
    const { fn, calls } = loadTimerFn('riskWatch', [
      searchOkItems([{ name: '某人被起诉', url: 'https://news.example.com/s1', snippet: '某人被起诉' }])
    ], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [personWatch('u1', 'P1#tech', '某人')])
    env.db.__seed('risk_scans', [scanRow('P1#tech', '某人')])
    env.db.__seed('deep_dive_quota', [{ _id: todayKey(), date: todayKey(), count: perDayMax }])

    const res = await fn.main({})

    eq(res.deep_dive.queries, 0)
    eq(res.deep_dive.skipped_day, 1)
    eq(queriesOf(calls).length, 1)
    eq(res.signals, 1)
  })
})

/* ═════════════════════════ ④ 推送路径不受影响 ═════════════════════════ */

describe('P4-A 深挖：未配置模板时的推送路径不受影响', () => {
  it('keywordAlert：无 ALERT_TEMPLATE_ID → 照常跳过推送并记录原因，深挖照常发生', async () => {
    const { fn, pushes } = loadTimerFn('keywordAlert', [
      searchOkItems([{ name: '甲被报道', url: 'https://news.example.com/s1', snippet: 'x' }]),
      searchOkItems([{ name: '甲最新进展', url: 'https://news.example.com/d1', snippet: 'y' }])
    ], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [wordWatch('u1', '甲')])
    env.db.__seed('users', [{ _id: 'u1', _openid: 'u1', alert_ok: true }])

    const res = await fn.main({})

    ok(
      res.skipped.some((s) => String(s).includes('未配置 ALERT_TEMPLATE_ID')),
      `原「未配置模板则跳过」行为必须保持：${JSON.stringify(res.skipped)}`
    )
    eq(pushes.length, 0, '未配置模板时不该尝试推送')
    eq(res.deep_dive.queries, 1, '深挖与推送配置无关，照常发生')
  })
})

/* ═════════════════════════ ⑤ 预算常量取自配置真源并已同步 ═════════════════════════ */

describe('P4-A 深挖：预算常量取自配置真源、云侧副本已同步', () => {
  const src = sync.loadSource().DEEP_DIVE

  it('真源 DEEP_DIVE 存在且三层齐备（词数 / 单轮 / 单日）', () => {
    eq(typeof src.queriesPerHit, 'number')
    eq(typeof src.perRunMax, 'number')
    eq(typeof src.perDayMax, 'number')
    ok(src.queriesPerHit >= 1, '每次命中至少扩 1 个词，否则深挖无意义')
    ok(src.perRunMax >= src.queriesPerHit, '单轮上限不该小于「一次命中的词数」')
    ok(src.perDayMax >= src.perRunMax, '单日上限不该小于单轮上限')
    /* 建议初始值（改这里要在汇报里说明理由） */
    eq(src.queriesPerHit, 1)
    eq(src.perRunMax, 6)
    eq(src.perDayMax, 60)
  })

  it('云侧副本（keywordAlert / riskWatch）的 DEEP_DIVE 与真源逐字段一致', () => {
    for (const fnName of ['keywordAlert', 'riskWatch']) {
      const cfg = require(path.join(CLOUD, fnName, 'benefits.config.js'))
      deepEq(cfg.DEEP_DIVE, src, `${fnName}/benefits.config.js 的 DEEP_DIVE 与真源不一致（跑 config:sync）`)
    }
  })

  it('两个云函数都从副本取值，且没有把 6 / 60 手抄回源码', () => {
    for (const fnName of ['keywordAlert', 'riskWatch']) {
      const code = fs.readFileSync(path.join(CLOUD, fnName, 'index.js'), 'utf8')
      ok(code.includes("require('./benefits.config')"), `${fnName} 没有 require 副本`)
      for (const field of ['queriesPerHit', 'perRunMax', 'perDayMax']) {
        ok(code.includes(`DEEP_DIVE.${field}`), `${fnName} 没有从 DEEP_DIVE 取 ${field}（是不是手抄了数字？）`)
      }
      /* 闸门必须落在服务端：写入路径只认定时器 / 控制台，端上调用一律拒（P0-21 既有闸门） */
      ok(/只由定时器触发/.test(code), `${fnName} 应保留「拒绝端上调用」的闸门`)
    }
  })

  it('deep_dive_quota 集合在库结构里声明为「客户端不可读写」', () => {
    const schema = fs.readFileSync(path.join(CLOUD, 'dbInit', 'schema.js'), 'utf8')
    ok(/name: 'deep_dive_quota'/.test(schema), '库结构应声明 deep_dive_quota')
    ok(
      /name: 'deep_dive_quota'[\s\S]{0,400}acl: ACL\.cloudOnly/.test(schema),
      '深挖预算是服务端成本边界，客户端必须完全不可读写'
    )
  })

  it('深挖候选词是中性语境词（不含评价性表述）', () => {
    for (const fnName of ['keywordAlert', 'riskWatch']) {
      const code = fs.readFileSync(path.join(CLOUD, fnName, 'index.js'), 'utf8')
      const m = code.match(/DEEP_DIVE_SUFFIXES\s*=\s*\[([^\]]*)\]/)
      ok(m, `${fnName} 应定义候选词后缀`)
      notOk(/塌房|翻车|人设|劣迹|抵制|风波/.test(m[1]), `${fnName} 的候选词不该含评价性 / 定性措辞：${m[1]}`)
    }
  })
})
