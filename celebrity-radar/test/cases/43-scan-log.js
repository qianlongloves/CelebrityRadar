'use strict'

/**
 * 监控执行日志 scan_logs（2026-10-14）。
 *
 * 云函数 keywordAlert / riskWatch 每轮对每个「进入扫描队列」的对象写一条日志
 * （ok / skipped / error），端上按 kind + object_key 读回。监控页据此把
 * 「监控对象 → 最近执行状态」做成表格、把「执行历史」列出来。
 *
 * 要钉住的四件事：
 *   1. 扫描成功 → ok（hit = 本轮新条目 / 新信号数，total = 本轮检索返回条数）；
 *   2. 缓存够新跳过 → skipped（不误报成失败、也不当成「没有监控过」）；
 *   3. 上游失败 → error（单对象失败不拖垮整轮，日志仍记下失败）；
 *   4. 端上 latestLogByKey 每个对象取最新一条、loadScanLogs 按 kind + 对象列表过滤。
 */

const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, eq, ok } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')

const HOUR = 3600 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

/* ─────────────────────────── 假上游（http + https） ─────────────────────────── */

const searchOkItems = (items) => ({
  status: 200,
  data: { code: 200, data: { webPages: { value: items } } }
})

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

/** 加载一个定时任务云函数：wx-server-sdk → 内存 DB，https → 假上游 */
function loadTimerFn(name, responses, opts = {}) {
  env.resetAll()
  delete process.env.BOCHA_API_KEY
  delete process.env.ALERT_TEMPLATE_ID
  delete process.env.RISK_TEMPLATE_ID
  Object.assign(process.env, opts.env || {})

  const http = fakeHttps(responses)
  const db = env.db.database()
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => ({}),
    openapi: { subscribeMessage: { send: () => Promise.resolve({ errCode: 0 }) } }
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
    return { fn: require(file), calls: http.calls }
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

const logRow = (id, kind, objectKey, objectName, ranAt, status, hit, total, note) => ({
  _id: id,
  kind,
  object_key: objectKey,
  object_name: objectName,
  ran_at: ranAt,
  status,
  hit,
  total,
  note
})

/* ─────────────────────────── 端上读取（纯函数 + 查询） ─────────────────────────── */

describe('scan_logs 端上读取', () => {
  it('SCAN_STATUS_LABEL：三种执行状态都有面向用户的中文', () => {
    const { SCAN_STATUS_LABEL } = env.load('utils/scan-log')
    eq(SCAN_STATUS_LABEL.ok, '成功')
    eq(SCAN_STATUS_LABEL.skipped, '跳过')
    eq(SCAN_STATUS_LABEL.error, '失败')
  })

  it('latestLogByKey：每个对象取最新一条（输入按 ran_at 倒序，先到先得）', () => {
    const { latestLogByKey } = env.load('utils/scan-log')
    const m = latestLogByKey([
      logRow('a3', 'keyword', '雷军', '雷军', '2026-10-14T03:00:00.000Z', 'ok', 2, 2, '新增 2 条'),
      logRow('a2', 'keyword', '雷军', '雷军', '2026-10-13T03:00:00.000Z', 'skipped', 0, 2, '复用缓存'),
      logRow('b1', 'keyword', '小米', '小米', '2026-10-13T03:00:00.000Z', 'error', 0, 0, 'HTTP 500')
    ])
    eq(m.size, 2)
    eq(m.get('雷军').status, 'ok')
    eq(m.get('雷军').hit, 2)
    eq(m.get('小米').status, 'error')
  })

  it('loadScanLogs：按 kind + 对象列表过滤、时间倒序；空名单不发请求', async () => {
    const db = env.db
    db.__seed('scan_logs', [
      logRow('k1', 'keyword', '雷军', '雷军', '2026-10-14T03:00:00.000Z', 'ok', 1, 1, ''),
      logRow('k2', 'keyword', '小米', '小米', '2026-10-14T03:00:00.000Z', 'ok', 2, 2, ''),
      logRow('p1', 'person', 'P1#tech', '某人', '2026-10-14T03:00:00.000Z', 'ok', 3, 3, '')
    ])
    const { loadScanLogs } = env.load('utils/scan-log')

    const kw = await loadScanLogs('keyword', ['雷军'])
    eq(kw.length, 1, 'kind=keyword 应过滤掉 person 行')
    eq(kw[0].object_key, '雷军')

    const both = await loadScanLogs('keyword', ['雷军', '小米'])
    eq(both.length, 2)

    const none = await loadScanLogs('keyword', [])
    eq(none.length, 0)
  })

  it('loadRiskScans：按 personKey（id）取快照，供名人表格「最近执行 / 结果」列', async () => {
    const db = env.db
    db.__seed('risk_scans', [
      {
        _id: 'P1#tech',
        person_key: 'P1#tech',
        name: '某人',
        scanned_at: '2026-10-14T03:00:00.000Z',
        baseline_at: '2026-10-13T03:00:00.000Z',
        seen_urls: [],
        scanned: 2,
        signals_total: 5
      }
    ])
    const { loadRiskScans } = env.load('utils/risk-watch')
    const rows = await loadRiskScans(['P1#tech'])
    eq(rows.length, 1)
    eq(rows[0].id, 'P1#tech')
    eq(rows[0].signals_total, 5)
  })
})

/* ─────────────────────────── 云函数写日志 ─────────────────────────── */

describe('keywordAlert 写执行日志', () => {
  it('扫描命中 → ok（hit=新条目数，total=本轮检索条数）', async () => {
    const { fn } = loadTimerFn(
      'keywordAlert',
      [
        searchOkItems([{ name: '雷军新品发布会', url: 'https://n.example/1', snippet: '发布会' }]),
        searchOkItems([]) /* 深挖：空，无额外命中 */
      ],
      { env: { BOCHA_API_KEY: 'k' } }
    )
    env.db.__seed('keyword_watches', [wordWatch('u1', '雷军')])

    const res = await fn.main({})

    eq(res.ok, true)
    const logs = env.db.__dump('scan_logs').filter((l) => l.kind === 'keyword' && l.object_key === '雷军')
    eq(logs.length, 1, `每个对象每轮写一条：${JSON.stringify(logs)}`)
    eq(logs[0].status, 'ok')
    eq(logs[0].hit, 1, '1 条新报道 = hit 1')
    eq(logs[0].total, 1)
    eq(logs[0].object_name, '雷军')
    ok(String(logs[0].note).includes('新增 1 条'), `命中摘要应说明新增：${logs[0].note}`)
  })

  it('缓存够新（20 小时内）→ skipped，不误报成失败', async () => {
    const { fn } = loadTimerFn('keywordAlert', [], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [wordWatch('u1', '雷军')])
    env.db.__seed('keywords', [
      {
        _id: '雷军',
        keyword: '雷军',
        fetched_at: ago(1 * HOUR),
        watchers: 1,
        items: [
          { url: 'https://n.example/old', title: '旧报道', summary: '', source: 's', first_seen_at: ago(2 * HOUR) }
        ]
      }
    ])

    const res = await fn.main({})

    eq(res.ok, true)
    const logs = env.db.__dump('scan_logs').filter((l) => l.kind === 'keyword' && l.object_key === '雷军')
    eq(logs.length, 1)
    eq(logs[0].status, 'skipped')
    eq(logs[0].hit, 0)
    eq(logs[0].total, 1, '复用缓存时 total = 缓存里已有条数')
  })

  it('上游失败 → error，单对象失败不拖垮整轮', async () => {
    const { fn } = loadTimerFn('keywordAlert', [{ status: 500, data: {} }], { env: { BOCHA_API_KEY: 'k' } })
    env.db.__seed('keyword_watches', [wordWatch('u1', '雷军')])

    const res = await fn.main({})

    eq(res.ok, true, '单个词失败不能让整轮失败')
    const logs = env.db.__dump('scan_logs').filter((l) => l.kind === 'keyword' && l.object_key === '雷军')
    eq(logs.length, 1)
    eq(logs[0].status, 'error')
    eq(logs[0].hit, 0)
    ok(String(logs[0].note).length > 0, 'error 应带失败原因')
  })
})

describe('riskWatch 写执行日志', () => {
  it('扫描命中风险词 → ok（hit=新信号数）', async () => {
    const { fn } = loadTimerFn(
      'riskWatch',
      [
        searchOkItems([{ name: '某人被起诉', url: 'https://n.example/1', snippet: '某人被起诉' }]),
        searchOkItems([]) /* 深挖：空 */
      ],
      { env: { BOCHA_API_KEY: 'k' } }
    )
    env.db.__seed('keyword_watches', [personWatch('u1', 'P1#tech', '某人')])
    /* 已有快照（非首次扫描）：baseline 已建立，新条目才会被当信号；首轮只建档、不产生信号 */
    env.db.__seed('risk_scans', [
      {
        _id: 'P1#tech',
        person_key: 'P1#tech',
        name: '某人',
        scanned_at: ago(48 * HOUR),
        baseline_at: ago(48 * HOUR),
        seen_urls: [],
        scanned: 0,
        signals_total: 0
      }
    ])

    const res = await fn.main({})

    eq(res.ok, true)
    const logs = env.db.__dump('scan_logs').filter((l) => l.kind === 'person' && l.object_key === 'P1#tech')
    eq(logs.length, 1, `每个监控对象每轮写一条：${JSON.stringify(logs)}`)
    eq(logs[0].status, 'ok')
    eq(logs[0].hit, 1, '1 条新信号 = hit 1')
    eq(logs[0].object_name, '某人')
  })
})
