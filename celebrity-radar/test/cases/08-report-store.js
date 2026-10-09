'use strict'

/**
 * 共享缓存写口与端上降级（P0-2，2026-10-09）
 *
 * 要钉的是同一件事的两半：
 *   ① 服务端写口 —— `report_cache` / `feed_cache` 原先「所有人可读、登录可写」，而它们是
 *      全局共享的事实源（报告那张还兼作生成互斥锁）。权限收紧后写入只能走 `aiProxy` 的
 *      `action:'report'`，所以写口每一道校验都必须是真闸门，而不是装饰。
 *   ② 端上降级 —— 权限收紧后写库对旧客户端就是**不通**的；端上若照旧抛错，「缓存写不进去」
 *      会升级成「用户看不到报告」。降级是这次收紧能安全上线的前提。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const AI_PROXY = path.join(CLOUD, 'aiProxy', 'index.js')
const STORE_JS = path.join(CLOUD, 'aiProxy', 'report-store.js')
const SCHEMA = path.join(CLOUD, 'dbInit', 'schema.js')

const read = (p) => fs.readFileSync(p, 'utf8')
const proxySrc = read(AI_PROXY)
const storeSrc = read(STORE_JS)
const schemaSrc = read(SCHEMA)
const cacheSrc = read(path.join(ROOT, 'src', 'utils', 'cache.ts'))

const DAY_MS = 86400000

/** 加载 aiProxy：wx-server-sdk → harness 内存 DB。写口不触达上游，故不注入假 https */
function loadProxy({ openid = 'u1' } = {}) {
  env.resetAll()
  process.env.BOCHA_API_KEY = 'bocha-test'
  process.env.DEEPSEEK_API_KEY = 'llm-test'
  const db = env.db.database()
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => (openid ? { OPENID: openid } : {})
  }
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fakeSdk
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(AI_PROXY)]
    delete require.cache[require.resolve(STORE_JS)]
    return require(AI_PROXY)
  } finally {
    Module.prototype.require = orig
  }
}

const callStore = (fn, over) => fn.main(Object.assign({ action: 'report' }, over))
const lockRow = (over) =>
  Object.assign(
    { _id: 'A#tech', report: null, state: 'building', builder: 'u1', generated_at: '2026-01-01T00:00:00.000Z' },
    over
  )
const report = (over) =>
  Object.assign({ personKey: 'A#tech', name: 'A', generatedAt: '2026-01-01T00:00:00.000Z' }, over)
const memberRow = () => ({
  _id: 'u1',
  plan: 'month',
  expires_at: new Date(Date.now() + 7 * DAY_MS).toISOString()
})

/* ============== ① 源码级：权限与告诫 ============== */

describe('P0-2 共享缓存的权限声明', () => {
  it('report_cache / feed_cache 都收紧成「客户端只读」', () => {
    ok(/name: 'report_cache'[\s\S]{0,1200}acl: ACL\.publicReadOnly/.test(schemaSrc), '报告缓存必须收紧')
    ok(/name: 'feed_cache'[\s\S]{0,900}acl: ACL\.publicReadOnly/.test(schemaSrc), '动态缓存同步收紧')
  })

  it('两张表都不再是 publicRead（回退即红）', () => {
    notOk(
      /name: 'report_cache'[\s\S]{0,1200}acl: ACL\.publicRead,/.test(schemaSrc),
      '改回「登录可写」= 任意用户可覆盖全站共享报告'
    )
    notOk(/name: 'feed_cache'[\s\S]{0,900}acl: ACL\.publicRead,/.test(schemaSrc))
  })

  it('库结构里留着「收紧顺序不可颠倒」的告诫', () => {
    ok(/先部署带写口的 aiProxy/.test(schemaSrc), '下一个人改权限前必须先看到这句')
    ok(/report-store|aiProxy\(action:report\)/.test(schemaSrc), '得指出去哪儿看写口')
  })
})

describe('P0-2 写口接线', () => {
  it('aiProxy 分发里有 action=report', () => {
    ok(
      proxySrc.includes("if (action === 'report') return handleReportStore(event || {})"),
      '没有这条线，权限收紧后端上就再也写不进来'
    )
  })

  it('写口是独立模块，且复用 index 的会员判定与计数（不另起一套口径）', () => {
    ok(proxySrc.includes('createReportStore({'), '依赖靠注入，而不是在写口里重写一遍')
    ok(storeSrc.includes('isActiveMember'), '会员一致性必须读服务端权威')
    ok(storeSrc.includes('bumpAbuseCount'), '写入是共享数据的入口，必须有独立限速')
  })

  it('写口计数走独立键，不挤占 chat / search 的额度', () => {
    ok(storeSrc.includes('#store`'), '与 ABUSE_LIMITS 共用键会把免费档余量吃掉小半')
  })
})

/* ============== ② 云端行为级 ============== */

describe('P0-2 写口：身份与入参', () => {
  it('未取到 openid：直接拒绝，不建任何行', async () => {
    const fn = loadProxy({ openid: null })
    const res = await callStore(fn, { op: 'acquire', personKey: 'A#tech' })
    eq(res.ok, false)
    eq(res.kind, 'auth')
    eq(env.db.__dump('report_cache').length, 0)
  })

  it('未知 op：拒绝，且什么都不动', async () => {
    const fn = loadProxy()
    const res = await callStore(fn, { op: 'drop', personKey: 'A#tech' })
    eq(res.ok, false)
    eq(res.kind, 'badrequest')
    eq(env.db.__dump('report_cache').length, 0)
  })

  it('缺少 personKey：拒绝', async () => {
    const fn = loadProxy()
    const res = await callStore(fn, { op: 'acquire' })
    eq(res.ok, false)
    eq(res.kind, 'badrequest')
  })
})

describe('P0-2 写口：抢锁 / 放锁', () => {
  it('首次抢锁建行：builder 由服务端写成 openid', async () => {
    const fn = loadProxy()
    const res = await callStore(fn, { op: 'acquire', personKey: 'A#tech' })
    eq(res.ok, true)
    eq(res.result, 'acquired')
    const row = env.db.__dump('report_cache')[0]
    eq(row.state, 'building')
    eq(row.builder, 'u1', '这是「改不了别人那一行」与「抢不到别人的锁」的唯一依据')
  })

  it('他人持锁且未失联：lost，且不动那一行', async () => {
    const fn = loadProxy()
    /* generated_at 取「现在」：锁没过期才谈得上抢不到（过期可抢占见下一条） */
    env.db.__seed('report_cache', [lockRow({ builder: 'u-other', generated_at: new Date().toISOString() })])
    const res = await callStore(fn, { op: 'acquire', personKey: 'A#tech' })
    eq(res.result, 'lost')
    eq(env.db.__dump('report_cache')[0].builder, 'u-other')
  })

  it('构建者失联超时：锁可被抢占（否则一次崩溃会永久卡住该人物）', async () => {
    const fn = loadProxy()
    const stale = new Date(Date.now() - 91 * 1000).toISOString()
    env.db.__seed('report_cache', [lockRow({ builder: 'u-other', generated_at: stale })])
    const res = await callStore(fn, { op: 'acquire', personKey: 'A#tech' })
    eq(res.result, 'acquired')
    eq(env.db.__dump('report_cache')[0].builder, 'u1', '接管者成为新 builder')
  })

  it('抢锁不动 report：那一版还等着「只升不降」守卫与 release 交还', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow({ state: 'ready', report: { name: '旧会员版' } })])
    const res = await callStore(fn, { op: 'acquire', personKey: 'A#tech' })
    eq(res.result, 'acquired')
    eq(env.db.__dump('report_cache')[0].report.name, '旧会员版', '抢锁就抹掉上一版 = 一次中断击穿全站缓存')
  })

  it('放锁：不是自己的锁一律不动', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow({ builder: 'u-other' })])
    const res = await callStore(fn, { op: 'release', personKey: 'A#tech' })
    eq(res.result, 'skipped')
    const row = env.db.__dump('report_cache')[0]
    eq(row.state, 'building')
    eq(row.builder, 'u-other')
  })

  it('放锁且有旧内容：退回 ready 交还，而不是删行', async () => {
    const fn = loadProxy()
    const old = { personKey: 'A#tech', name: 'A', generatedAt: '2026-03-03T00:00:00.000Z' }
    env.db.__seed('report_cache', [lockRow({ report: old })])
    const res = await callStore(fn, { op: 'release', personKey: 'A#tech' })
    eq(res.result, 'restored')
    const row = env.db.__dump('report_cache')[0]
    eq(row.state, 'ready')
    eq(row.builder, null)
    eq(row.report.name, 'A', '上一版必须还在')
    eq(row.generated_at, '2026-03-03T00:00:00.000Z', '交还给这一版的真实产出时刻')
  })

  it('放锁且从无内容：删行（首次生成失败）', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, { op: 'release', personKey: 'A#tech' })
    eq(res.result, 'deleted')
    eq(env.db.__dump('report_cache').length, 0)
  })
})

/* ============== ③ 落库校验（本次收紧最实的增量） ============== */

describe('P0-2 写口：落库校验', () => {
  it('未持锁（他人持锁）：拒绝，别人那一行一个字都不动', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow({ builder: 'u-other', report: { name: 'old' } })])
    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report() })
    eq(res.ok, false)
    eq(res.kind, 'lock')
    const row = env.db.__dump('report_cache')[0]
    eq(row.report.name, 'old')
    eq(row.state, 'building')
  })

  it('非会员写会员段：拒绝 —— 原先任何登录用户都能直写伪造的 memberNotes', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ memberNotes: { compare: '伪造的对比视角' } })
    })
    eq(res.ok, false)
    eq(res.kind, 'auth')
    eq(env.db.__dump('report_cache')[0].state, 'building', '被拒就不该落库')
  })

  it('非会员写 conflicts（会员段的另一半）同样拒绝', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ conflicts: [{ text: '伪造的争议' }] })
    })
    eq(res.kind, 'auth')
  })

  it('会员写会员段：放行', async () => {
    const fn = loadProxy()
    env.db.__seed('memberships', [memberRow()])
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ memberNotes: { compare: 'C' } }),
      newsCount: 9,
      schemaVersion: 2
    })
    eq(res.ok, true)
    eq(res.result, 'saved')
    const row = env.db.__dump('report_cache')[0]
    eq(row.state, 'ready')
    eq(row.builder, null, '落库即放锁')
    eq(row.search_meta.news_count, 9)
    eq(row.report.memberNotes.compare, 'C')
    eq(row.schemaVersion, 2)
  })

  it('非会员写**无**会员段的报告：放行（免费档生成照旧）', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report() })
    eq(res.result, 'saved')
  })

  it('空串 / 空数组不算会员段（与端上 presentSections 同口径）', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ memberNotes: { compare: '', risk: '' }, conflicts: [] })
    })
    eq(res.result, 'saved', '口径若与端上不一致，免费档会被误判成「伪造会员段」而整条写不进去')
  })

  it('report.personKey 与目标行不一致：拒绝', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: { personKey: 'B#tech', name: 'B' } })
    eq(res.kind, 'badrequest')
  })

  it('report 带系统字段：拒绝', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report({ _id: 'x' }) })
    eq(res.kind, 'badrequest')
  })

  it('体积超限：拒绝（不把共享表当网盘）', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ analysis: 'x'.repeat(200 * 1024) })
    })
    eq(res.kind, 'badrequest')
  })
})

/* ============== ④ 动态列表写口 ============== */

describe('P0-2 写口：动态列表', () => {
  it('saveFeed 写入 feed_cache', async () => {
    const fn = loadProxy()
    const res = await callStore(fn, { op: 'saveFeed', personKey: 'A#tech', items: [{ title: 't', url: 'u' }] })
    eq(res.result, 'saved')
    const row = env.db.__dump('feed_cache')[0]
    eq(row.items.length, 1)
    ok(row.fetched_at, '必须带抓取时刻，它决定下次要不要刷新')
  })

  it('items 不是数组：拒绝（形状校验）', async () => {
    const fn = loadProxy()
    const res = await callStore(fn, { op: 'saveFeed', personKey: 'A#tech', items: { x: 1 } })
    eq(res.kind, 'badrequest')
    eq(env.db.__dump('feed_cache').length, 0)
  })

  it('体积超限：拒绝', async () => {
    const fn = loadProxy()
    const res = await callStore(fn, {
      op: 'saveFeed',
      personKey: 'A#tech',
      items: [{ title: 'x'.repeat(100 * 1024) }]
    })
    eq(res.kind, 'badrequest')
  })
})

/* ============== ⑤ 端上写口的三态映射 ============== */

describe('P0-2 端上写口：三态映射', () => {
  it('写口可用：acquire 交给云端（端上不再直写）', async () => {
    const fn = loadProxy()
    env.registerCloudFn('aiProxy', (data, ctx) => fn.main(data, ctx))
    const api = env.load('utils/report-store')

    const r = await api.acquireLockViaCloud('A#tech')

    eq(r, 'acquired')
    const rows = env.db.__dump('report_cache')
    eq(rows.length, 1, '写入确实发生了（在云端）')
    eq(rows[0].builder, 'u1')
  })

  it('写口未部署：unavailable —— 调用方据此回退端上直写', async () => {
    loadProxy()
    env.unregisterCloudFn('aiProxy')
    const api = env.load('utils/report-store')

    const r = await api.acquireLockViaCloud('A#tech')

    eq(r, 'unavailable', '未部署必须与「明确拒绝」区分开，否则老路径在写口上线前会整体失灵')
  })

  it('写口明确拒绝（非会员写会员段）：rejected —— 调用方不得回退直写', async () => {
    const fn = loadProxy()
    env.registerCloudFn('aiProxy', (data, ctx) => fn.main(data, ctx))
    const api = env.load('utils/report-store')
    await api.acquireLockViaCloud('A#tech')

    const r = await api.saveReportViaCloud(
      'A#tech',
      { personKey: 'A#tech', name: 'A', memberNotes: { compare: '伪造' } },
      0
    )

    eq(r, 'rejected')
    eq(env.db.__dump('report_cache')[0].state, 'building', '被拒的内容绝不能绕过写口落库')
  })

  it('写口可用且是会员：save 走通并落 ready', async () => {
    const fn = loadProxy()
    env.db.__seed('memberships', [memberRow()])
    env.registerCloudFn('aiProxy', (data, ctx) => fn.main(data, ctx))
    const api = env.load('utils/report-store')
    await api.acquireLockViaCloud('A#tech')

    const r = await api.saveReportViaCloud(
      'A#tech',
      { personKey: 'A#tech', name: 'A', memberNotes: { compare: 'C' } },
      3
    )

    eq(r, 'saved')
    const row = env.db.__dump('report_cache')[0]
    eq(row.state, 'ready')
    eq(row.search_meta.news_count, 3)
  })
})

/* ============== ⑥ 端上降级（这次收紧能安全上线的前提） ============== */

describe('P0-2 端上降级：写库不通不该让用户看不到报告', () => {
  it('acquire 直写失败是降级（degraded），不再抛错', () => {
    ok(cacheSrc.includes("return 'degraded'"), '必须有这条第 2 出口')
    notOk(/if \(updErr\) throw new Error/.test(cacheSrc), '抛错会把「缓存写不进去」升级成「整页失败」')
    notOk(/if \(again\) return 'lost'[\s\S]{0,80}throw new Error/.test(cacheSrc))
  })

  it('只有 lost 才去等锁（degraded 直接进生成，不白等 75 秒）', () => {
    ok(cacheSrc.includes("if (lock === 'lost') {"), '三态分流')
    notOk(/if \(!acquired\) \{/.test(cacheSrc), '旧的布尔分流会把 degraded 也塞进等待分支')
  })

  it('报告与动态两条写路都先走写口', () => {
    ok(cacheSrc.includes('acquireLockViaCloud'), '抢锁')
    ok(cacheSrc.includes('saveReportViaCloud'), '落库')
    ok(cacheSrc.includes('saveFeedViaCloud'), '动态列表')
  })

  it('saveReady 遇写口明确拒绝：不回退直写', () => {
    ok(/viaCloud === 'rejected'[\s\S]{0,220}return 'failed'/.test(cacheSrc), '回退等于把刚被拦下的内容塞进库')
  })

  it('feed_cache 收敛到一个写入出口，直写只剩回退那一处', () => {
    ok(cacheSrc.includes('async function writeFeedCache'), '两条写路共用一个出口')
    const hits = cacheSrc.split("table('feed_cache').upsert").length - 1
    eq(hits, 1, '直写只允许留在 writeFeedCache 的回退分支里')
  })
})
