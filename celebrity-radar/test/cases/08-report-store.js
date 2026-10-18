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
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

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
const storeClientSrc = read(path.join(ROOT, 'src', 'utils', 'report-store.ts'))

const DAY_MS = 86400000

/** 加载 aiProxy：wx-server-sdk → harness 内存 DB。写口不触达上游，故不注入假 https */
function loadProxy({ openid = 'u1', split = false } = {}) {
  env.resetAll()
  process.env.BOCHA_API_KEY = 'bocha-test'
  /*
   * 主行剥段（阶段 3）要**显式打开**：2026-10-18 起 report-store 里有 MEMBER_SPLIT_ENABLED，
   * 默认关闭 = 阶段 1 双写。这两个默认值刻意不同 —— 线上现状是双写，代码里的「阶段 3 已就绪」
   * 不是理由（详见该常量上的注释：靠「暂不部署」维持的契约被一次手滑打破过）。
   */
  process.env.MEMBER_SPLIT = split ? '1' : ''
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
    /*
     * 必须**明显大于** BUILDING_TIMEOUT_MS，而这个值不在用例里写死（2026-10-17）：
     * 它来自真源 `benefits.config.js#REPORT_BUILD`（当前 4 批 × 3 次 × 2 遍 × 45s + 45s = 1125s），
     * 端上与云端同源（用例 77 钉住）。此前这里写「8 分钟」，是按云端当时手写的 405s 估的；
     * 上界涨到 1125s 后，8 分钟已落在锁的有效期内 —— 那样这条用例测的就不再是
     * 「失联可抢占」，而是上一条「他人持锁未失联」。现在从真源推导，参数变、用例自动跟随。
     */
    const RB = require(path.join(CLOUD, 'aiProxy', 'benefits.config.js')).REPORT_BUILD
    const timeoutMs =
      RB.batchCount * RB.batchAttempts * RB.generateAttempts * RB.chatDeadlineMs +
      RB.searchBudgetMs +
      RB.slackMs
    const stale = new Date(Date.now() - (timeoutMs + 60 * 1000)).toISOString()
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

  it('会员写会员段：默认（开关关闭）主行照旧带四段，副本也写一份 —— 阶段 1 双写', async () => {
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
    eq(row.schemaVersion, 2)
    /*
     * 正向对照（故意与下一条相反）：默认不剥段 —— 线上端上包未必带 op:'member' 读口，
     * 此刻剥掉等于让会员在旧包上少四段。这条一旦变红，说明有人把开关默认值改了。
     */
    eq(row.report.memberNotes.compare, 'C', '默认双写：主行仍带四段')
    eq(row.report.memberSections, undefined, '没有剥就不该写旗标（旗标说有、正文没有 = 会员静默少四段）')
    const copy = env.db.__dump('report_member')[0]
    eq(copy.sections.memberNotes.compare, 'C', '副本照旧写（阶段 2 的读口要靠它）')
  })

  it('（开关打开）阶段 3 剥段：四段**不进主行**，改用旗标', async () => {
    const fn = loadProxy({ split: true })
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
    eq(row.schemaVersion, 2)
    /* 阶段 3 的核心：所有人可读的 report_cache 里不再有付费内容 */
    eq(row.report.memberNotes, undefined, '主行不再带四段')
    deepEq(row.report.memberSections, ['memberNotes.compare'], '主行用旗标说「四段在副本里」')
    const copy = env.db.__dump('report_member')[0]
    eq(copy.sections.memberNotes.compare, 'C', '四段进副本表（客户端不可读）')
    eq(copy.generated_at, row.generated_at, '两行写同一个时间戳，它是唯一的配对依据')
  })

  it('开关关闭时不写旗标（否则端上会去取一份「不在副本里」的四段）', async () => {
    const fn = loadProxy()
    env.db.__seed('memberships', [memberRow()])
    env.db.__seed('report_cache', [lockRow()])
    await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ memberNotes: { compare: 'C' } })
    })
    const row = env.db.__dump('report_cache')[0]
    notOk(Array.isArray(row.report.memberSections), '旗标只在真正剥段时写')
  })

  /* ── P1-9（2026-10-09 复审）：只升不降，写在权威侧 ── */

  it('P1-9 只升不降：既有版本含会员段，不许被不含会员段的产物覆盖', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [
      lockRow({ report: report({ memberNotes: { compare: '上一版的会员段' } }) })
    ])

    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report() })

    eq(res.ok, false)
    eq(res.kind, 'stale', '端上的守卫（shouldKeepMemberVersion）改包就能绕过，权威在写口')
    const row = env.db.__dump('report_cache')[0]
    eq(row.report.memberNotes.compare, '上一版的会员段', '全站共享的那一份会员段落必须原样留住')
    eq(row.state, 'building', '被拒就不落库，锁照旧交还')
  })

  it('P1-9 对「剥段形态」的既有版本仍然生效：只看旗标也必须拦', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [
      lockRow({ report: report({ memberSections: ['memberNotes.compare'] }) })
    ])

    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report() })

    eq(res.kind, 'stale', '剥段后正文没有四段，只认正文这条守卫就形同虚设')
    eq(env.db.__dump('report_cache')[0].state, 'building', '被拒就不落库')
  })

  it('剥段的前提是副本写成功：源码里必须「先写副本、再决定剥不剥」', () => {
    /* 静态断言而不是行为断言：让副本写失败在内存 DB 里不好造，而这条顺序一旦写反，
       后果是「旗标说有、副本里没有」——会员永久少四段，而且不报错、页面看不出异常。 */
    const copyAt = storeSrc.indexOf("const copied = await saveMemberRow(personKey, report, generatedAt, 'current'")
    /* 2026-10-18：剥段多了第一道条件 MEMBER_SPLIT_ENABLED，定位串要跟着改（否则这条会红成假失败） */
    const stripAt = storeSrc.indexOf('if (MEMBER_SPLIT_ENABLED && memberFlags.length > 0 && copied)')
    ok(copyAt > 0, '应能定位到前置写副本那一行')
    ok(stripAt > copyAt, '剥段必须发生在副本写成功之后，不能反过来')
    ok(
      storeSrc.includes("process.env.MEMBER_SPLIT === '1'"),
      '剥段必须挂在显式开关上：靠「暂不部署」维持的契约挡不住一次 code update'
    )
  })

  it('P1-9 是单向的：既有版本本就不含会员段，免费档照旧可覆盖', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow({ report: report({ name: '旧免费版' }) })])

    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report({ name: '新免费版' }) })

    eq(res.result, 'saved', '刷新免费档报告是正常路径，不能被这条守卫误伤')
    eq(env.db.__dump('report_cache')[0].report.name, '新免费版')
  })

  it('会员段口径是「真值」：既有版本是纯空白也算「有」，同样拒绝覆盖', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow({ report: report({ memberNotes: { compare: '   ' } }) })])

    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report() })

    eq(
      res.kind,
      'stale',
      '端上 presentSections / quotaGuard 都按真值判，写口若 trim 后判就出现了第三种口径'
    )
  })

  it('非会员提交纯空白会员段：按「有会员段」拒绝（同一口径的另一面）', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])

    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ memberNotes: { risk: '  ' } })
    })

    eq(res.kind, 'auth', '三个口径（端上 / 写口 / quotaGuard）必须是同一个')
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

  it('同领域坐标（peers）也算会员段：非会员提交带 peers 的报告被拒（四个口径必须一致）', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ peers: [{ name: '某同行', gap: '主演作品更多，且拿了同档奖项' }] })
    })
    eq(
      res.kind,
      'auth',
      'peers 是 2026-10-12 新增的会员段：端上 hasMemberContent / 写口 / quotaGuard 必须同口径'
    )
  })

  it('企业关联（affiliations）也算会员段：非会员提交带 affiliations 的报告被拒（四个口径必须一致）', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ affiliations: [{ name: '某影业', kind: 'company', note: '创始人兼董事长', basis: '媒体A' }] })
    })
    eq(
      res.kind,
      'auth',
      'affiliations 是 2026-10-12 新增的会员段：端上 hasMemberContent / 写口 / quotaGuard 必须同口径'
    )
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

/* ============== ③b 中间结果写口（P0-B 分批生成的逐批落库） ============== */

/*
 * 报告改成按模板分组多次生成后，每批成功都会把**迄今累计**的批次结果写进 building 行的 `parts`
 * （见 utils/report.ts#buildReport 的 onPart ↔ utils/cache.ts#saveReportParts）。
 * 它不参与任何读取判定（读者只看 state / report），但仍是**写口**：若不校验持锁与会员一致性，
 * 所有人可写的那条老路就又从 `parts` 这扇侧门打开了。
 */
describe('P0-B 写口：中间结果（parts）', () => {
  const partsOf = (over) => [{ key: 'identity', data: Object.assign({ intro: 'x' }, over) }]

  it('持锁时写入成功，且只动 parts —— report / state 一个字都不碰', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow({ report: { name: '上一版' } })])
    const res = await callStore(fn, { op: 'saveParts', personKey: 'A#tech', parts: partsOf() })

    eq(res.ok, true)
    eq(res.result, 'saved')
    const row = env.db.__dump('report_cache')[0]
    eq(row.parts.length, 1, '中间结果落库了')
    eq(row.parts[0].key, 'identity')
    eq(row.state, 'building', '它只是过程记录，不该改生成状态')
    eq(row.report.name, '上一版', '更不该碰那一行上躺着的那一版报告')
  })

  it('未持锁（他人持锁）：拒绝，且不写入任何字段', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow({ builder: 'u-other' })])
    const res = await callStore(fn, { op: 'saveParts', personKey: 'A#tech', parts: partsOf() })

    eq(res.ok, false)
    eq(res.kind, 'lock')
    eq(env.db.__dump('report_cache')[0].parts, undefined, '被拒就不该落库')
  })

  it('parts 不是数组：拒绝', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, { op: 'saveParts', personKey: 'A#tech', parts: { key: 'identity' } })
    eq(res.kind, 'badrequest')
  })

  it('体积超限：拒绝', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'saveParts',
      personKey: 'A#tech',
      parts: [{ key: 'facts', data: { analysis: 'x'.repeat(100 * 1024) } }]
    })
    eq(res.kind, 'badrequest')
  })

  it('非会员写含会员段的中间结果：拒绝 —— 否则「伪造会员内容」只是换了一扇门进来', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'saveParts',
      personKey: 'A#tech',
      parts: partsOf({ memberNotes: { compare: '伪造的对比视角' } })
    })

    eq(res.ok, false)
    eq(res.kind, 'auth')
    eq(env.db.__dump('report_cache')[0].parts, undefined)
  })

  it('会员写含会员段的中间结果：放行', async () => {
    const fn = loadProxy()
    env.db.__seed('memberships', [memberRow()])
    env.db.__seed('report_cache', [lockRow()])
    const res = await callStore(fn, {
      op: 'saveParts',
      personKey: 'A#tech',
      parts: partsOf({ memberNotes: { compare: '对比视角' } })
    })
    eq(res.result, 'saved')
  })

  it('acquire 会清掉上一轮留下的中间结果（那一份属于旧的那次生成）', async () => {
    const fn = loadProxy()
    /* 抢占场景：他人 building 已过期（generated_at 是很久以前），行上还留着上一轮的 parts */
    env.db.__seed('report_cache', [
      Object.assign(lockRow({ builder: 'u-other', parts: partsOf() }), {
        generated_at: new Date(Date.now() - 60 * 60000).toISOString()
      })
    ])

    const res = await callStore(fn, { op: 'acquire', personKey: 'A#tech' })

    eq(res.result, 'acquired')
    eq(env.db.__dump('report_cache')[0].parts, null, '对不上号的旧记录留着只会误导读排障的人')
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

  it('库里已有更新的内容：skipped-stale，不覆盖（晚回来的旧结果不许盖掉新内容）', async () => {
    const fn = loadProxy()
    /* 比服务端时间晚 1 分钟：仍在 5 分钟容忍度内 ⇒ 参与比较，判为「库里更新」 */
    const newer = new Date(Date.now() + 60 * 1000).toISOString()
    env.db.__seed('feed_cache', [{ _id: 'A#tech', items: [{ title: '新' }], fetched_at: newer }])

    const res = await callStore(fn, { op: 'saveFeed', personKey: 'A#tech', items: [{ title: '旧' }] })

    eq(res.result, 'skipped-stale', '不覆盖要如实回报，端上据此既不算失败、也不回退直写')
    const row = env.db.__dump('feed_cache')[0]
    eq(row.items[0].title, '新', '库里的新内容必须原样保留')
    eq(row.fetched_at, newer, '抓取时刻同样不许倒退（它决定「多久没刷」）')
  })

  it('fetched_at 是未来值（超容忍度）：当脏值覆盖 —— 否则这一行永远刷不动', async () => {
    const fn = loadProxy()
    env.db.__seed('feed_cache', [
      { _id: 'A#tech', items: [{ title: '旧' }], fetched_at: '2099-01-01T00:00:00.000Z' }
    ])

    const res = await callStore(fn, { op: 'saveFeed', personKey: 'A#tech', items: [{ title: '新' }] })

    eq(res.result, 'saved', 'feed_cache 是全站共享的一行，一个未来时间戳会把这个人锁死')
    const row = env.db.__dump('feed_cache')[0]
    eq(row.items[0].title, '新')
    notOk(row.fetched_at === '2099-01-01T00:00:00.000Z', '脏值要被校正回服务端时间')
  })

  it('存量行没有 fetched_at：照常覆盖（否则它永远写不进去）', async () => {
    const fn = loadProxy()
    env.db.__seed('feed_cache', [{ _id: 'A#tech', items: [{ title: '旧' }] }])

    const res = await callStore(fn, { op: 'saveFeed', personKey: 'A#tech', items: [{ title: '新' }] })

    eq(res.result, 'saved')
    eq(env.db.__dump('feed_cache')[0].items[0].title, '新')
  })

  it('落库时间取服务端，不采信端上传来的值', async () => {
    const fn = loadProxy()
    const claimed = new Date(Date.now() - 365 * DAY_MS).toISOString()
    const res = await callStore(fn, {
      op: 'saveFeed',
      personKey: 'A#tech',
      items: [{ title: 't' }],
      fetchedAt: claimed
    })

    eq(res.result, 'saved')
    notOk(env.db.__dump('feed_cache')[0].fetched_at === claimed, '端上时间戳不得直接落库')
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

  it('写口返回 stale（只升不降）：同样归入 rejected，绝不回退直写', async () => {
    const fn = loadProxy()
    env.db.__seed('report_cache', [
      {
        _id: 'A#tech',
        state: 'ready',
        builder: null,
        generated_at: '2026-01-01T00:00:00.000Z',
        report: { personKey: 'A#tech', name: 'A', memberNotes: { compare: '上一版会员段' } }
      }
    ])
    env.registerCloudFn('aiProxy', (data, ctx) => fn.main(data, ctx))
    const api = env.load('utils/report-store')
    await api.acquireLockViaCloud('A#tech')

    const r = await api.saveReportViaCloud('A#tech', { personKey: 'A#tech', name: 'A' }, 0)

    eq(r, 'rejected', 'stale 漏出 REJECTED_KINDS 就会落到 unavailable，然后回退直写把会员段抹掉')
    eq(
      env.db.__dump('report_cache')[0].report.memberNotes.compare,
      '上一版会员段',
      '会员段必须还在'
    )
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

  it('REJECTED_KINDS 覆盖写口全部「拒绝」类 kind（含 P1-9 新增的 stale）', () => {
    for (const k of ['auth', 'badrequest', 'lock', 'abuse', 'stale']) {
      ok(storeClientSrc.includes(`'${k}'`), `端上 REJECTED_KINDS 缺 '${k}' —— 它会退化成「回退直写」`)
    }
  })

  it('feed_cache 收敛到一个写入出口，直写只剩回退那一处', () => {
    ok(cacheSrc.includes('async function writeFeedCache'), '两条写路共用一个出口')
    const hits = cacheSrc.split("table('feed_cache').upsert").length - 1
    eq(hits, 1, '直写只允许留在 writeFeedCache 的回退分支里')
  })
})
