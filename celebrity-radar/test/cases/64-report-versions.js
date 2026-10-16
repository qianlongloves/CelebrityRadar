'use strict'

/**
 * S3-1 ③：**报告历史版本**（`report_versions` + 写口记录 + `utils/report-versions` + `package/report-history`）。
 *
 * 要钉的不是「多了一张表」，而是这件功能最容易做错、且做错了很久都看不出来的几件事：
 *
 *   1. **只在被覆盖时记录**：`report_cache` 一人一份、刷新即整篇替换，旧版就此消失 ——
 *      但「首次生成」没有旧版可记，记了就成一条凭空的历史。
 *   2. **顺序：先落库、后记版本**。反过来时，落库失败会在历史里留下一条与当前版**逐字相同**的
 *      记录 —— 用户会以为报告真更新过（假历史）。代价是「落库成功但记录失败」时旧版丢失，
 *      两半都要钉住（`recordVersion` 在 set 之后 + 记录失败不改 `ok`）。
 *   3. **`_id` 必须确定性**（`<personKey>#<旧版生成时间>`）：同一旧版被覆盖两次（重试 / 双端各抢
 *      一次锁）只能落成同一行，否则历史里会出现两条一模一样的版本。
 *   4. **保留策略真的会删**（每人只留最近 5 条），且裁剪排序走 `_id` 而非普通字段 ——
 *      普通字段排序在索引未建时会被云侧拒，而「裁剪失败」意味着这张表一直长下去。
 *   5. **记录失败不阻断落库**（best-effort）：辅助能力不能把一份**生成成功**的报告说成写库失败。
 *   6. **行内不含用户标识**（同 `report_cache` 的定位）：全站共享事实的一段历史，不是「我的那一行」。
 *   7. **分层：列表免费、正文是会员能力**。列表是入口（看不见入口 = 这能力不存在），正文才是
 *      S3-1 要卖的那块；被拦下只多**一行**说明（非弹窗，同报告页 / 工作台口径）。
 *   8. **旧版正文必须经 `cache.ts#exposeReport` 过滤**：旧版可能带着当时会员生成的段落，
 *      绕过它就是给免费读者发会员内容。
 *   9. **列表查询不取正文**：5~10 份正文是几百 KB，而一屏只要时间与几个数字。
 *
 * 云端行为级用 `loadProxy`（同 08：wx-server-sdk → harness 内存 DB）；端上纯函数 `env.load`
 * 编译产物，页面与配置读源码断言（与 61 / 62 / 63 同法）。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const AI_PROXY = path.join(CLOUD, 'aiProxy', 'index.js')
const STORE_JS = path.join(CLOUD, 'aiProxy', 'report-store.js')
const SCHEMA = path.join(CLOUD, 'dbInit', 'schema.js')

const read = (p) => fs.readFileSync(p, 'utf8')
const src = (p) => read(path.join(SRC, p))

const storeSrc = read(STORE_JS)
const schemaSrc = read(SCHEMA)
const rvSrc = src(path.join('utils', 'report-versions.ts'))
const eventsSrc = src(path.join('utils', 'events.ts'))
const cacheSrc = src(path.join('utils', 'cache.ts'))
const appCfg = src('app.config.ts')
const reportPageSrc = src(path.join('package', 'report', 'index.tsx'))
const pageSrc = src(path.join('package', 'report-history', 'index.tsx'))
const scssSrc = src(path.join('package', 'report-history', 'index.scss'))
const userCfgSrc = read(path.join(ROOT, 'test', 'cases', '18-user-config.js'))

/** 剥注释后再断言页面源码（页面里有解释取舍的注释，不剥会被自己写的理由判违规） */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
const pageCode = () => stripComments(pageSrc)

/** `recordVersion` 函数体（源码断言：只在这一段里查写入字段） */
const recordBody = (() => {
  const i = storeSrc.indexOf('async function recordVersion')
  return i < 0 ? '' : storeSrc.slice(i, storeSrc.indexOf('async function trimVersions', i))
})()
/** `storeSave` 函数体（用来钉「set 之后才记版本」这个顺序） */
const saveBody = (() => {
  const i = storeSrc.indexOf('async function storeSave')
  const j = storeSrc.indexOf('async function ', i + 10)
  return i < 0 ? '' : storeSrc.slice(i, j < 0 ? storeSrc.length : j)
})()
/** `trimVersions` 函数体（保留策略的排序与删除方式） */
const trimBody = (() => {
  const i = storeSrc.indexOf('async function trimVersions')
  const j = storeSrc.indexOf('async function ', i + 10)
  return i < 0 ? '' : storeSrc.slice(i, j < 0 ? storeSrc.length : j)
})()

/** ⚠ 必须补零：`2026-10-9` 会被 Date.parse 判成 NaN，字符串比较下也比 `2026-10-16` 大 */
const T = (h) => `2026-10-${String(h).padStart(2, '0')}T00:00:00.000Z`
const DAY_MS = 86400000
const KEY = 'A#tech'

/** 加载 aiProxy（写口不触达上游，故不注入假 https） */
function loadProxy({ openid = 'u1' } = {}) {
  env.resetAll()
  process.env.BOCHA_API_KEY = 'bocha-test'
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
const versionsOf = (key) => env.db.__dump('report_versions').filter((v) => v.person_key === key)
const cacheRow = (key = KEY) => env.db.__dump('report_cache').find((r) => r._id === key)

const reportOf = (over) =>
  Object.assign({ personKey: KEY, name: 'A', generatedAt: T(1), heat: 50, intro: '一句话简介' }, over)

/** 会员版产物：四个会员字段全带（云端 hasMemberPayload 与端上 hasMemberContent 都必须命中） */
const memberReport = (over) =>
  reportOf(
    Object.assign(
      {
        memberNotes: { compare: '与同领域相比…', risk: '风险提示…' },
        conflicts: [{ topic: '信源分歧' }],
        peers: [{ name: 'B' }],
        affiliations: [{ name: 'C' }]
      },
      over
    )
  )

/** 走一遍完整的「抢锁 → 落库」 */
async function saveOnce(fn, report, { personKey = KEY, newsCount = 5 } = {}) {
  await callStore(fn, { op: 'acquire', personKey })
  return callStore(fn, { op: 'save', personKey, report, newsCount })
}

/* ═══════════════════════ ① 库结构：权限与定位 ═══════════════════════ */

describe('S3-1 ③ report_versions：库结构', () => {
  it('新表是「客户端只读」：写入只能走云函数写口', () => {
    ok(/name: 'report_versions'[\s\S]{0,1600}acl: ACL\.publicReadOnly/.test(schemaSrc), '必须收紧成只读')
    notOk(
      /name: 'report_versions'[\s\S]{0,1600}acl: ACL\.publicRead,/.test(schemaSrc),
      '放开写 = 任意用户可伪造或抹掉全站共享报告的历史'
    )
  })

  it('表说明里写明「写入只发生在写口内部」并指出是哪个 op', () => {
    const seg = schemaSrc.slice(schemaSrc.indexOf("name: 'report_versions'"))
    ok(/只发生在写口/.test(seg), '下一个人看这张表时要知道谁在写')
    ok(/op:'save'/.test(seg), '得指出具体是写口的哪个操作')
  })

  it('保留策略写在写口，且讲清它是运维策略而不是权益数值', () => {
    ok(/REPORT_VERSION_KEEP = 5/.test(storeSrc))
    ok(/不是会员权益数值/.test(storeSrc), '写进 benefits.ts 会被当成「卖什么」')
  })

  it('注销删表清单认得它（行内无用户标识 ⇒ 白名单）', () => {
    const i = userCfgSrc.indexOf('SHARED_NO_USER_ID')
    ok(i > 0, '用例 18 必须有这份「行内无用户标识」的清单')
    ok(userCfgSrc.slice(i, i + 1500).includes("'report_versions'"), '新表要么进删表清单、要么进白名单，不能不表态')
  })
})

/* ═══════════════════════ ② 云端写口：记什么、怎么记 ═══════════════════════ */

describe('S3-1 ③ 写口：记录时机', () => {
  it('首次生成不记历史（没有「被覆盖掉的那一版」）', async () => {
    const fn = loadProxy()
    const res = await saveOnce(fn, reportOf({ generatedAt: T(1) }))
    eq(res.ok, true)
    eq(versionsOf(KEY).length, 0, '第一版不是历史，它就在 report_cache 里')
  })

  it('覆盖时记下的是旧版，而不是刚写进去的那一版', async () => {
    const fn = loadProxy()
    await saveOnce(fn, reportOf({ generatedAt: T(1), heat: 50 }), { newsCount: 5 })
    await saveOnce(fn, reportOf({ generatedAt: T(2), heat: 70 }), { newsCount: 9 })

    const rows = versionsOf(KEY)
    eq(rows.length, 1)
    eq(rows[0]._id, `${KEY}#${T(1)}`, '_id 必须是确定性的 <personKey>#<旧版生成时间>')
    eq(rows[0].report.heat, 50, '历史里放的是被换掉的那一版')
    eq(rows[0].news_count, 5, '素材条数取旧行那时的 search_meta.news_count')
    eq(rows[0].name, 'A')
    eq(cacheRow().report.heat, 70, '当前版照旧换成新的')
    ok(!!rows[0].replaced_at && !Number.isNaN(Date.parse(rows[0].replaced_at)), 'replaced_at 要能算时间')
  })

  it('同一旧版被覆盖两次只留一条（确定性 _id ⇒ set 幂等）', async () => {
    const fn = loadProxy()
    await saveOnce(fn, reportOf({ generatedAt: T(1) }), { newsCount: 5 })
    await saveOnce(fn, reportOf({ generatedAt: T(2) }), { newsCount: 9 })
    /* 把行手工退回「还是第一版、且正被本端持锁」的样子，再覆盖一次 —— 相当于端上重试 / 双端各抢一次锁 */
    env.db.__seed('report_cache', [
      {
        _id: KEY,
        state: 'building',
        builder: 'u1',
        report: reportOf({ generatedAt: T(1) }),
        generated_at: T(1),
        search_meta: { news_count: 5 }
      }
    ])
    await callStore(fn, { op: 'save', personKey: KEY, report: reportOf({ generatedAt: T(3) }), newsCount: 11 })

    eq(versionsOf(KEY).length, 1, '确定性 _id 下第二次是覆盖同一行，不该出现两条一样的版本')
  })

  it('被写口拒绝的覆盖不记历史（旧版根本没被换掉）', async () => {
    const fn = loadProxy()
    /*
     * 把行摆成「已有会员版、且正被本端持锁」：非会员产物会被「只升不降」拒掉（kind='stale'）。
     * ⚠ 不能靠再 loadProxy 一次来换身份 —— 那一句会 env.resetAll() 把刚写下的会员版一起抹掉。
     */
    env.db.__seed('report_cache', [
      {
        _id: KEY,
        state: 'building',
        builder: 'u1',
        report: memberReport({ generatedAt: T(1) }),
        generated_at: T(1),
        search_meta: { news_count: 6 }
      }
    ])
    const res = await callStore(fn, {
      op: 'save',
      personKey: KEY,
      report: reportOf({ generatedAt: T(2) }),
      newsCount: 3
    })

    eq(res.ok, false)
    eq(res.kind, 'stale')
    eq(versionsOf(KEY).length, 0, '被拒的写入没换掉任何东西，历史里就不该有东西')
    eq(cacheRow().report.generatedAt, T(1), '既有那一版必须原样留着')
  })
})

describe('S3-1 ③ 写口：顺序与容错', () => {
  it('记版本发生在落库之后（顺序不能反）', () => {
    ok(saveBody.length > 200, '没能截出 storeSave 的函数体，用例本身要修')
    const setAt = saveBody.indexOf('.set({')
    const recAt = saveBody.indexOf('await recordVersion(')
    const okAt = saveBody.indexOf("result: 'saved'")
    ok(setAt > 0 && recAt > 0 && okAt > 0, '三个点都要在 storeSave 里')
    ok(recAt > setAt, '先落库再记版本：反过来的话落库失败时历史会多出一条假版本')
    ok(recAt < okAt, '记版本要在返回成功之前完成（否则 await 就白写了）')
  })

  it('记录失败不阻断落库（best-effort）', async () => {
    const fn = loadProxy()
    await saveOnce(fn, reportOf({ generatedAt: T(1) }), { newsCount: 5 })
    env.db.__setFailing('report_versions', true)
    const res = await saveOnce(fn, reportOf({ generatedAt: T(2) }), { newsCount: 9 })

    eq(res.ok, true, '历史版本的写失败不能把一份生成成功的报告说成写库失败')
    eq(res.result, 'saved')
    eq(cacheRow().report.generatedAt, T(2), '报告本身照旧落库')
  })

  it('裁剪失败同样只打日志（下次覆盖会再试）', () => {
    ok(/裁剪历史版本失败/.test(trimBody), '裁剪必须自己 catch，不能让失败冒到落库路径上')
    ok(/下次覆盖会再试/.test(trimBody), '得说明这不是永久失败')
  })

  it('版本行不写用户标识（注销无需按用户清）', () => {
    ok(recordBody.length > 200, '没能截出 recordVersion 的函数体')
    notOk(/builder\s*:/.test(recordBody), '记「谁覆盖的」会让它变成要按用户删的行（与用例 18 的白名单冲突）')
    notOk(/openid/.test(recordBody), '同上：行内不许出现用户标识')
  })

  it('体积闸门与 report_cache 同一道（旧版不该有第二个体积口径）', () => {
    ok(/REPORT_MAX_BYTES/.test(recordBody))
  })
})

describe('S3-1 ③ 写口：保留策略', () => {
  it('最多留 5 条，且留下的是最新的那 5 个', async () => {
    const fn = loadProxy()
    for (let i = 1; i <= 7; i++) await saveOnce(fn, reportOf({ generatedAt: T(i), heat: i }), { newsCount: i })

    const rows = versionsOf(KEY)
    eq(rows.length, 5, '7 次覆盖该被裁到 5 条')
    deepEq(
      rows.map((r) => r._id).sort(),
      [T(2), T(3), T(4), T(5), T(6)].map((t) => `${KEY}#${t}`).sort(),
      '被删掉的必须是最旧的那一版，而不是随便删'
    )
  })

  it('裁剪按 _id 排序，不依赖任何自建索引', () => {
    ok(/orderBy\('_id', 'desc'\)/.test(trimBody), '_id 是主键、天生有索引；普通字段排序在索引未建时会被云侧拒')
    ok(/slice\(REPORT_VERSION_KEEP\)/.test(trimBody), '保留前 KEEP 条，其余删掉')
    ok(/\.doc\(r\._id\)\.remove\(\)/.test(trimBody), '按真实 _id 逐条删（可核对，不依赖 skip+remove 的云端语义）')
  })

  it('裁剪只动本人物（不会误删别人的历史）', async () => {
    const fn = loadProxy()
    await saveOnce(fn, reportOf({ personKey: 'B#tech', name: 'B', generatedAt: T(1) }), { personKey: 'B#tech' })
    for (let i = 1; i <= 3; i++) await saveOnce(fn, reportOf({ generatedAt: T(i), heat: i }), { newsCount: i })

    eq(versionsOf('B#tech').length, 0, 'B 只生成过一次，没有历史')
    eq(versionsOf(KEY).length, 2, 'A 覆盖 3 次 ⇒ 2 条历史')
  })
})

/* ═══════════════════════ ③ 端上纯函数 ═══════════════════════ */

/** 干净加载 utils/report-versions（它 import cache / member，故必须先 resetAll） */
function RV() {
  env.resetAll()
  return env.load('utils/report-versions')
}

/** ⚠ 字段名是 `id` 不是 `_id`：`db.ts#toRow` 已经把主键映回 PostgREST 口径才交给业务层 */
const vRow = (over) =>
  Object.assign(
    { id: `${KEY}#${T(1)}`, person_key: KEY, name: 'A', generated_at: T(1), replaced_at: T(2), news_count: 5 },
    over
  )

describe('S3-1 ③ 端上：buildVersionList', () => {
  it('自己再排一次序，不依赖读口给的顺序', () => {
    const rv = RV()
    const out = rv.buildVersionList(
      [vRow({ id: 'a', generated_at: T(3) }), vRow({ id: 'b', generated_at: T(1) }), vRow({ id: 'c', generated_at: T(5) })],
      null
    )
    deepEq(
      out.map((r) => r.id),
      ['c', 'a', 'b'],
      '这一屏的全部意义就是时间顺序：读口改了排序时这里必须还是降序'
    )
  })

  it('「与更新的一版比」：第一条对当前版，其余对上面那一条', () => {
    const rv = RV()
    const out = rv.buildVersionList(
      [vRow({ _id: 'new', generated_at: T(3), news_count: 8 }), vRow({ _id: 'old', generated_at: T(1), news_count: 5 })],
      { generatedAt: T(9), newsCount: 10 }
    )
    eq(out[0].newsDelta, -2, '最新一版被换掉时，比的是**当前版**的素材条数')
    eq(out[1].newsDelta, -3, '更旧的一版比的是它上面那一版')
  })

  it('没有可比对象时是 null 而不是 0', () => {
    const rv = RV()
    const out = rv.buildVersionList([vRow({ news_count: 5 })], null)
    eq(out[0].newsDelta, null, '「不知道」与「一样多」必须分得开：合成 ±0 会让用户以为我们真比过')
  })

  it('heldMs：被换掉的时间减生成时间；时间倒挂算不出', () => {
    const rv = RV()
    const okRow = rv.buildVersionList([vRow({ generated_at: T(1), replaced_at: T(3) })], null)[0]
    eq(okRow.heldMs, 2 * DAY_MS)
    const badRow = rv.buildVersionList([vRow({ generated_at: T(4), replaced_at: T(2) })], null)[0]
    eq(badRow.heldMs, null, '时间戳倒挂说明数据有问题，宁可不显示也不给负数')
  })

  it('heldText：不编数（算不出就空串）', () => {
    const rv = RV()
    eq(rv.heldText(null), '')
    eq(rv.heldText(30 * 60000), '不到 1 小时')
    eq(rv.heldText(5 * 3600000), '5 小时')
    eq(rv.heldText(3 * DAY_MS), '3 天')
  })

  it('newsDeltaText：null / 持平 / 多少', () => {
    const rv = RV()
    eq(rv.newsDeltaText(null), '')
    ok(/持平/.test(rv.newsDeltaText(0)))
    ok(/多 3 条/.test(rv.newsDeltaText(3)))
    ok(/少 4 条/.test(rv.newsDeltaText(-4)))
  })
})

describe('S3-1 ③ 端上：分层门禁', () => {
  it('正文是会员能力，且口径是二元的（没有数值档）', () => {
    const rv = RV()
    eq(rv.canViewVersionReport(true), true)
    eq(rv.canViewVersionReport(false), false)
  })

  it('被拦下的说明是一行字（不是弹窗），且说清卖的是什么', () => {
    const rv = RV()
    const note = rv.versionHistoryNote()
    ok(note.length > 10)
    ok(/会员/.test(note), '要说出「这是会员能力」')
    ok(/历史版本|回看|旧版/.test(note), '也要指出买的是什么，而不是只有一句「开通会员」')
  })

  it('端上取列表比云端保留数宽（两端数值刻意不联动）', () => {
    const rv = RV()
    ok(rv.VERSION_LIST_MAX >= 5, '云端留 5 条，端上取得比它宽才不会「云端有、端上看不到」')
    ok(/不联动|刻意宽/.test(rvSrc), '这个「宽一点」是刻意的，得写明，否则下一个人会去把它们对齐')
  })
})

/* ═══════════════════════ ④ 端上读口与页面 ═══════════════════════ */

/** 种一份三版历史 + 一个当前行（当前版素材 10 条，供 newsDelta 用） */
function seedVersions() {
  env.db.__seed('report_versions', [
    { _id: `${KEY}#${T(2)}`, person_key: KEY, name: 'A', generated_at: T(2), replaced_at: T(5), news_count: 4, report: reportOf({ generatedAt: T(2) }) },
    { _id: `${KEY}#${T(1)}`, person_key: KEY, name: 'A', generated_at: T(1), replaced_at: T(2), news_count: 3, report: reportOf({ generatedAt: T(1) }) },
    { _id: `B#tech#${T(1)}`, person_key: 'B#tech', name: 'B', generated_at: T(1), replaced_at: T(2), news_count: 1, report: reportOf({ personKey: 'B#tech' }) }
  ])
  env.db.__seed('report_cache', [{ _id: KEY, state: 'ready', report: reportOf({ generatedAt: T(6) }), generated_at: T(6), search_meta: { news_count: 10 } }])
}

describe('S3-1 ③ 端上：读口', () => {
  it('只取本人物的版本，按时间降序，且带上当前版信息', async () => {
    const rv = RV()
    seedVersions()
    const board = await rv.loadReportVersions(KEY)

    eq(board.rows.length, 2, '另一个人物的历史不该出现在这里')
    deepEq(
      board.rows.map((r) => r.generatedAt),
      [T(2), T(1)]
    )
    eq(board.rows[0].newsDelta, -6, '最新一版比当前版的 10 条少 6 条')
    eq(board.current.generatedAt, T(6))
    eq(board.current.newsCount, 10)
  })

  it('空 personKey 直接返回空（不查库）', async () => {
    const rv = RV()
    const board = await rv.loadReportVersions('  ')
    eq(board.rows.length, 0)
    eq(board.current, null)
  })

  it('读库失败按「没有历史版本」处理，不抛错', async () => {
    const rv = RV()
    seedVersions()
    env.db.__setFailing('report_versions', true)
    const board = await rv.loadReportVersions(KEY)
    eq(board.rows.length, 0, '附加信息读不到不该让整页变成错误态')
  })

  it('旧版正文按当前读者身份过滤：非会员拿到的对象里没有会员段', async () => {
    const rv = RV()
    env.db.__seed('report_versions', [
      { _id: `${KEY}#${T(1)}`, person_key: KEY, name: 'A', generated_at: T(1), replaced_at: T(2), news_count: 3, report: memberReport({ generatedAt: T(1) }) }
    ])
    const got = await rv.loadVersionReport(`${KEY}#${T(1)}`, false)

    ok(!!got, '这一版应该读得到')
    eq(got.heat, 50, '非会员段的内容照旧给')
    notOk('memberNotes' in got, '旧版里可能带着当时会员生成的段落，绕过过滤就是给免费读者发会员内容')
    notOk('conflicts' in got)
    notOk('peers' in got)
    notOk('affiliations' in got)
  })

  it('会员读到的是完整旧版（同一读口，只是身份不同）', async () => {
    const rv = RV()
    env.db.__seed('report_versions', [
      { _id: `${KEY}#${T(1)}`, person_key: KEY, name: 'A', generated_at: T(1), replaced_at: T(2), news_count: 3, report: memberReport({ generatedAt: T(1) }) }
    ])
    const got = await rv.loadVersionReport(`${KEY}#${T(1)}`, true)
    ok(!!got.memberNotes, '会员的回溯能力正是这块内容')
    ok(Array.isArray(got.conflicts))
  })

  it('读不到的版本返回 null（被保留策略裁掉 / 读库失败，对页面是同一件事）', async () => {
    const rv = RV()
    eq(await rv.loadVersionReport(''), null)
    eq(await rv.loadVersionReport(`${KEY}#${T(9)}`), null)
  })

  it('过滤口径是新造一份吗？不是 —— 复用 cache.ts#exposeReport', () => {
    ok(/import \{ exposeReport \} from '@\/utils\/cache'/.test(rvSrc), '派生第二条过滤口径迟早漂移')
    ok(/await exposeReport\(/.test(rvSrc))
  })

  it('列表查询不投影正文（5~10 份正文是几百 KB，一屏只要时间与数字）', () => {
    ok(
      /select\('id,person_key,name,generated_at,replaced_at,news_count'\)/.test(rvSrc),
      '列表只取元数据；正文留在「点开这一版」时按 _id 读单条'
    )
    ok(/select\('id,report'\)/.test(rvSrc), '单版读取才带上正文')
  })
})

describe('S3-1 ③ 页面与接线', () => {
  it('页面已注册进分包', () => {
    ok(/'report-history\/index'/.test(appCfg), '没注册的话点进去是白屏')
  })

  it('报告页有入口（与「对比」同款的一次跳转）', () => {
    ok(/package\/report-history\/index\?personKey=/.test(reportPageSrc))
    ok(/历史版本/.test(reportPageSrc))
  })

  it('分包页 scss 自带 variables（漏了 build 会报 Undefined variable）', () => {
    ok(/@import '\.\.\/\.\.\/styles\/variables\.scss'/.test(scssSrc))
  })

  it('免费用户点「看这一版」不读正文（不是「读了不显示」）', () => {
    const i = pageSrc.indexOf('canViewVersionReport(isMember)')
    const j = pageSrc.indexOf('await loadVersionReport(row.id')
    ok(i > 0 && j > i, '门禁必须在读正文之前')
    const freeSeg = pageSrc.slice(i, pageSrc.indexOf('setNoteVisible(true)', i))
    notOk(/loadVersionReport/.test(freeSeg), '被拦下时不该把旧版正文读到本地')
  })

  it('本页只读：不生成报告、不写库', () => {
    const code = pageCode()
    notOk(/getOrBuildReport|requestRefresh|refreshReport/.test(code), '这一页不该触发任何生成（也就不该花用户的钱）')
    notOk(/\.insert\(|\.update\(|\.remove\(|\.delete\(/.test(code), '写入只走云端写口')
  })

  it('两条埋点分开记（进页 / 点开），被拦也要报', () => {
    ok(/track\('report_history_view'/.test(pageSrc), 'count 是这一页最关键的分母：0 说明根本没东西可看')
    ok(/track\('report_version_open'/.test(pageSrc))
    const i = pageSrc.indexOf("track('report_version_open'")
    ok(/allowed: false/.test(pageSrc.slice(i, pageSrc.indexOf('allowed: true', i))), '被会员墙拦下也要报，否则转化分母消失')
  })

  it('事件名已进埋点白名单（否则端上会静默丢弃）', () => {
    ok(/report_history_view/.test(eventsSrc))
    ok(/report_version_open/.test(eventsSrc))
  })
})
