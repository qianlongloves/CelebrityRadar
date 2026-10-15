'use strict'

/**
 * 首建可见化（2026-10-15）：报告一行全站共用带来的**外部性**要说得出来。
 *
 * 背景：报告是全局共享缓存（report_cache，一行 / personKey），一份建好之后全站长期复用、
 * 任何人再查都不消耗生成次数（缓存命中的口径见 utils/cache.ts#getOrBuildReport 第 0 步）。
 * 于是「第一个生成的人」付掉 1 次额度，后来者（含他自己）免费读 —— 用户视角很容易读成
 * 「我出钱、别人白看」。
 *
 * 这不是「谁吃亏」的问题：热门人物多半是别人先建（先点的人是受益者），冷门人物首建者
 * 几乎无人搭便车（他本就是在为自己查）。真正要修的是**信息**：付账那一刻没人告诉他
 * 这笔次数买到的是「可反复查看、且长期留在库里供全站复用的一份报告」。
 *
 * 本文件钉四件事：
 *   ① 判据本身（isFirstBuild）—— 关键是它**不等于**「缓存不可用」：抢占别的构建者留下的
 *      那一行（state=building、行上还躺着上一版）时缓存也不可用，可那个人物早被建过；
 *   ② 缓存层只把标记交给**首建且落库成功**那一条路径（命中缓存 / 覆盖刷新 / 抢占都不带）；
 *   ③ 埋点带上它 —— 这是「到底有多少次生成真的在新建一行」的唯一观测口，
 *      也是「首建免计费」这类公平性方案的成本口径；
 *   ④ 页面确实把它渲染成一条可关闭的说明（算了却没人用，等于没算）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')

const read = (p) => fs.readFileSync(p, 'utf8')

function fresh() {
  env.resetAll()
  env.setDebugFlags({
    disableGenerateQuota: false,
    disableAskQuota: false,
    disableRefreshQuota: false,
    disableCooldown: false
  })
  return { load: env.load }
}

const KEY = '测试人物#tech'

/** 最小报告（只放本文件用到的字段） */
const mkReport = (over = {}) => Object.assign({ personKey: KEY, name: '测试人物', degraded: false }, over)

/**
 * 达标产物（判据见 utils/report.ts#reportShortfall）：骨架（intro / analysisPoints）+ 3 条时间线
 * 是最低配置。四批的分批契约是**非严格**对象（多写的键被静默丢弃），所以同一份回给每一批是安全的。
 * 不达标的产物一律不落库，那会让「首建」这条链路根本走不到，用例失去意义。
 */
const RICH = {
  intro: '新简介',
  analysisPoints: [
    { point: '点评一。', basis: '据公开资料' },
    { point: '点评二。', basis: '据公开资料' }
  ],
  timeline: [
    { date: '2026-09-01', event: '事件一' },
    { date: '2026-08-01', event: '事件二' },
    { date: '2026-07-01', event: '事件三' }
  ]
}

/** 检索可用 + 模型回达标产物（与 04-member-cache 同一套假上游） */
const online = () =>
  env.registerCloudFn('aiProxy', (data) => {
    /*
     * 写口（action='report'）**故意不认**：抢锁是写操作，而这份假上游不是真写口。
     * 认了会返回一个「成功但没写成」的响应，端上据此判不出 saved、又不算失败，整条
     * 生成会落进「等待他人构建」那条路（等锁超时 → error「报告正在生成中」），
     * 首建那条链路就根本走不到。显式报错才能触发端上**直写回退**，抢锁成功。
     */
    if (data.action === 'report') {
      return { ok: false, error: '云函数未部署' }
    }
    if (data.action === 'search') {
      return { ok: true, pages: [{ name: '标题', url: 'https://news.example.com/a', snippet: '正文' }] }
    }
    /* 检索词规划（purpose: 'aux'）在检索之前发生，不属于报告批次 */
    if (data.purpose === 'aux') {
      return { ok: true, content: JSON.stringify({ news: ['近期动态'], profile: ['履历'] }) }
    }
    return { ok: true, content: JSON.stringify(RICH) }
  })

/* ------------------------------------------------------------ 判据本身 */

describe('首建判定 utils/cache#isFirstBuild', () => {
  it('库里连行都没有 ⇒ 首建', () => {
    const { load } = fresh()
    const { isFirstBuild } = load('utils/cache')

    ok(isFirstBuild(null))
    ok(isFirstBuild(undefined))
  })

  it('已有 ready 行 ⇒ 不是首建（这份内容早就在那儿了）', () => {
    const { load } = fresh()
    const { isFirstBuild } = load('utils/cache')

    notOk(isFirstBuild({ id: KEY, state: 'ready', report: mkReport() }))
  })

  it('行是 building 但带着上一版 ⇒ **不是**首建（抢占重做，人物早被建过）', () => {
    const { load } = fresh()
    const { isFirstBuild } = load('utils/cache')

    /*
     * 这正是本判据与「缓存不可用」的分叉点：utils/cache.ts#isUsable 对它是 false
     * （state 不是 ready），可它并不代表「全站第一次建这个人物」—— 上一版报告就在行上躺着。
     */
    notOk(isFirstBuild({ id: KEY, state: 'building', report: mkReport({ heat: 3 }) }))
  })

  it('行是 building 且没有内容 ⇒ 也不是首建（行已经存在）', () => {
    const { load } = fresh()
    const { isFirstBuild } = load('utils/cache')

    notOk(isFirstBuild({ id: KEY, state: 'building', report: null }))
  })
})

/* ------------------------------------------- 缓存层：标记只走首建那条路径 */

describe('首建标记 · 端到端（utils/cache#getOrBuildReport）', () => {
  it('库里没有这一行、生成成功 ⇒ firstBuild=true（页面据此说明「这次是你为全站建立的」）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online()

    const out = await getOrBuildReport(KEY)

    eq(out.kind, 'report')
    eq(out.fromCache, false, '这一份是刚生成的')
    eq(out.firstBuild, true)
  })

  it('命中缓存 ⇒ 不带 firstBuild（不许在「我只是看看别人的报告」时说这句）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online()
    env.db.__seed('report_cache', [{ _id: KEY, state: 'ready', report: mkReport({ heat: 5 }) }])

    const out = await getOrBuildReport(KEY)

    eq(out.kind, 'report')
    eq(out.fromCache, true)
    eq(out.firstBuild, undefined, '读别人建好的那份，跟「谁建立的」无关')
  })

  it('force 覆盖既有报告 ⇒ 不带 firstBuild（这是重做，不是首建）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online()
    env.db.__seed('report_cache', [{ _id: KEY, state: 'ready', report: mkReport({ heat: 5 }) }])

    const out = await getOrBuildReport(KEY, { force: true })

    eq(out.kind, 'report')
    eq(out.fromCache, false, '真的重新生成了')
    eq(out.firstBuild, undefined)
  })

  it('抢占失联的 building 行 ⇒ 不带 firstBuild（那个人物已被建过，本次只是补做）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online()
    /*
     * generated_at 必须**确实早于** BUILDING_TIMEOUT_MS，否则抢不到锁（`state.eq.ready` 不成立、
     * `generated_at.lt.expireIso` 也不成立），本次会落进「等待他人构建」那条路 ——
     * WAIT_TIMEOUT_MS 与那个上界同值，于是这一个用例要干等它跑完（曾因此把整套测试挂住：
     * 看着像死锁，其实是在轮询）。
     *
     * 那个上界**不是 405s**，而是 4 批 × 3 次尝试 × 2 轮完整生成 × 45s + 检索 15s + 余量 30s
     * = 1125s ≈ 18.7 分钟（见 utils/cache.ts#BUILDING_TIMEOUT_MS）。**不要贴边写**：
     * 判据只要求「远超上界」，直接给一天前 —— 贴边写得越准，越容易被上游调参撞翻。
     */
    env.db.__seed('report_cache', [
      {
        _id: KEY,
        state: 'building',
        builder: 'someone-else',
        report: mkReport({ heat: 4 }),
        generated_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString()
      }
    ])

    const out = await getOrBuildReport(KEY, { force: true })

    eq(out.kind, 'report')
    eq(out.firstBuild, undefined, '行本来就在，这一笔不是「为全站从零建立」')
  })
})

/* ------------------------------------------------- 接线（算了却没人用） */

describe('首建判定的接线（源码钉住）', () => {
  const src = read(path.join(SRC, 'utils/cache.ts'))

  it('取值排在抢锁**之前**（抢锁会把行建成 building，之后就再也判不出来了）', () => {
    const body = src.slice(src.indexOf('async function getOrBuildReport'))
    const take = body.indexOf('const firstBuild = isFirstBuild(row)')
    const lock = body.indexOf('acquire(personKey, userId)')

    ok(take > 0, '必须有这次取值')
    ok(lock > 0)
    ok(take < lock, '抢锁之后再判，行的存在性已经被自己改掉了')
  })

  it('用的就是那一次既有读取，不为一句说明多付一次库读', () => {
    ok(src.includes('const firstBuild = isFirstBuild(row)'), '不许出现 await getRow(...) 专门为首建读一次')
  })

  it('埋点带上 firstBuild（否则「有多少次生成在新建一行」永远答不出来）', () => {
    ok(src.includes("track('report_generate', { personKey, mode: 'realtime', firstBuild })"))
  })

  it('只有落库成功那一条路径交回 firstBuild（其余分支都不带）', () => {
    const hits = src.split('...(firstBuild ? { firstBuild: true } : {})').length - 1

    eq(hits, 1, '残版 / 保留旧版 / 缓存命中都不该带这个标记')
  })
})

/* --------------------------------------------------------- 页面提示条 */

describe('首建说明条（报告页 · package/report/index.tsx）', () => {
  const page = read(path.join(SRC, 'package', 'report', 'index.tsx'))

  it('有独立的状态位、复位与赋值（与其余刷新结果条同一套套路）', () => {
    ok(page.includes("| 'firstBuild'"), '要进 NoticeKey：每个提示条各关各的')
    ok(page.includes('const [firstBuild, setFirstBuild] = useState(false)'))
    ok(page.includes('setFirstBuild(false)'), '新一轮 load 必须复位，否则上一轮的说明会跟着新报告出现')
    ok(page.includes('setFirstBuild(outcome.firstBuild === true)'))
  })

  it('只在首建时渲染，且是一条带关闭按钮的提示（不是弹窗、不拦路）', () => {
    const at = page.indexOf('{firstBuild && !closedNotices.firstBuild && (')
    ok(at > 0, '提示条必须挂在 firstBuild 上')

    const block = page.slice(at, at + 800)
    ok(block.includes('这份报告由你首次生成'))
    ok(block.includes('不再消耗生成次数'), '这句才是这条提示的全部意义：把共享缓存的账说清')
    ok(block.includes('包括你自己'), '用户最可能误以为「我下次再看还要再扣一次」')
    ok(block.includes("closeNotice('firstBuild')"), '所有文字提示框都要能关（既有约定）')
  })

  it('埋点枚举里写明了 props.firstBuild 的口径', () => {
    const events = read(path.join(SRC, 'utils', 'events.ts'))

    ok(events.includes('props.firstBuild'))
  })
})

/* ------------------------------------- 端到端：申请真的被送进 quotaGuard */

describe('首建免计费申请 · 端到端（申不申请，由缓存层决定）', () => {
  it('首建那一次生成 ⇒ 申请里带 waiveIf=first_build 与目标人物', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online()
    const sent = []
    env.registerCloudFn('quotaGuard', (data) => {
      sent.push(data)
      return { ok: true, kind: data.kind, date: '2026-10-15', count: 1, waived: false }
    })

    await getOrBuildReport(KEY)

    const req = sent.find((d) => d.kind === 'generate' && d.action === 'consume')
    ok(req, '首建必须问一次免计费，否则用户白掏这一次')
    eq(req.waiveIf, 'first_build')
    eq(req.target, KEY, '云函数据这个 target 去读 report_cache 复核')
  })

  it('覆盖既有报告 ⇒ 不许申请（这是重做，不是首建）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online()
    const sent = []
    env.registerCloudFn('quotaGuard', (data) => {
      sent.push(data)
      return { ok: true, kind: data.kind, date: '2026-10-15', count: 1, waived: false }
    })
    env.db.__seed('report_cache', [{ _id: KEY, state: 'ready', report: mkReport({ heat: 5 }) }])

    await getOrBuildReport(KEY, { force: true })

    const req = sent.find((d) => d.kind === 'generate' && d.action === 'consume')
    ok(req, '照常计数还是要问一次')
    eq(req.waiveIf, undefined, '多带这一个字段就等于「每次刷新都白拿一次」')
  })
})

/* ------------------------------------------- 云端复核（quotaGuard 的「首建」一节） */

const Module = require('module')
const CLOUD = path.join(__dirname, '..', '..', 'cloudfunctions')
const QUOTA_GUARD = path.join(CLOUD, 'quotaGuard', 'index.js')
const REPORT_STORE = path.join(CLOUD, 'aiProxy', 'report-store.js')

/** 加载 quotaGuard：wx-server-sdk → harness 内存 DB（与 07-cloud-authority 同一手法） */
function loadGuard({ openid = 'u1' } = {}) {
  env.resetAll()
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
    delete require.cache[require.resolve(QUOTA_GUARD)]
    return require(QUOTA_GUARD)
  } finally {
    Module.prototype.require = orig
  }
}

const WAIVE = { kind: 'generate', action: 'consume', waiveIf: 'first_build' }
/** quotaGuard 的切天口径：+8 时区（同 aiProxy/quota.config#todayKey） */
const quotaDay = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

/** 写口刚建出来的那一行：building、尚无报告、带首建标记 */
const freshRow = (over = {}) =>
  Object.assign(
    {
      _id: KEY,
      state: 'building',
      report: null,
      builder: 'u1',
      first_build_owner: 'u1',
      first_build_at: new Date().toISOString()
    },
    over
  )

describe('首建免计费复核（quotaGuard）', () => {
  it('他刚首建的那一行 ⇒ 免计费，生成次数不涨', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow()])

    const res = await guard.main(Object.assign({ target: KEY }, WAIVE))

    eq(res.ok, true)
    eq(res.waived, true)
    eq(res.count, 0, '返回给端上的计数必须是 0，否则页面照旧显示「今天已用 1 次」')
    /*
     * 免计费 = **生成次数不涨**，而不是「表里没有行」：豁免名额（waive_count）本来就记在
     * 同一天的那一行上（见 claimFirstBuildSlot），所以那一行会以 count:0 存在 ——
     * 它记的是「今天用掉的豁免名额」，不是「今天生成过几次」。判据因此必须看 count。
     */
    const rows = env.db.__dump('generate_quota')
    eq(
      rows.filter((r) => (r.count || 0) > 0).length,
      0,
      '免了还记账 = 没免（这一行若存在，也只能是 count:0 的豁免名额行）'
    )
  })

  it('免过就落下标记（同一人物不许重复领）', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow()])

    await guard.main(Object.assign({ target: KEY }, WAIVE))

    ok(env.db.__dump('report_cache')[0].first_build_waived_at, '没有这个标记，首建完立刻 force 刷新还能再领一次')
  })

  it('已免过的那个人物再申请 ⇒ 不免，照常计数', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow({ first_build_waived_at: new Date().toISOString() })])

    const res = await guard.main(Object.assign({ target: KEY }, WAIVE))

    eq(res.waived, false)
    eq(env.db.__dump('generate_quota')[0].count, 1)
  })

  it('别人的首建行 ⇒ 不免（端上伪造「我是首建者」没用）', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow({ first_build_owner: 'u2' })])

    const res = await guard.main(Object.assign({ target: KEY }, WAIVE))

    eq(res.waived, false)
    eq(env.db.__dump('generate_quota')[0].count, 1)
  })

  it('没有首建标记的行（老行 / 端上回退直写建的行）⇒ 不免', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [{ _id: KEY, state: 'ready', report: { name: '老报告' } }])

    const res = await guard.main(Object.assign({ target: KEY }, WAIVE))

    eq(res.waived, false, '拿不到服务端自证的首建事实，就宁可多算一次')
  })

  it('行不存在 ⇒ 不免（没建行就申请，只可能是改包）', async () => {
    const guard = loadGuard()

    const res = await guard.main(Object.assign({ target: KEY }, WAIVE))

    eq(res.waived, false)
    eq(env.db.__dump('generate_quota')[0].count, 1)
  })

  it('时间窗外（首建是一小时前）⇒ 不免：豁免只对应刚发生的那一次生成', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [
      freshRow({ first_build_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
    ])

    const res = await guard.main(Object.assign({ target: KEY }, WAIVE))

    eq(res.waived, false, '否则「首建」成了一张可以慢慢兑现的欠条')
  })

  it('每日上限 1 次：同一天首建第二个人物 ⇒ 第二个照常计数', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow(), freshRow({ _id: '另一个人物#tech' })])

    const first = await guard.main(Object.assign({ target: KEY }, WAIVE))
    const second = await guard.main(Object.assign({ target: '另一个人物#tech' }, WAIVE))

    eq(first.waived, true, '当日第一个仍然免')
    eq(second.waived, false, '专挑新人物建也不能把闸门整个绕开')
    const row = env.db.__dump('generate_quota')[0]
    eq(env.db.__dump('generate_quota').length, 1, '计数落在同一行（openid#date）')
    eq(row.waive_count, 1)
    eq(row.count, 1)
  })

  it('名额已被占满 ⇒ 不免，且把多占的那一坑还回去', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow()])
    env.db.__seed('generate_quota', [
      { _id: `u1#${quotaDay()}`, _openid: 'u1', count: 2, waive_count: 1 }
    ])

    const res = await guard.main(Object.assign({ target: KEY }, WAIVE))

    eq(res.waived, false)
    const row = env.db.__dump('generate_quota')[0]
    eq(row.count, 3, '照常计数')
    eq(row.waive_count, 1, '回滚失败的话，名额会被这一次尝试永久吃掉')
  })

  it('配额行还不存在（今天第一次生成就是首建）⇒ 建首行、count 记 0', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow()])
    /* 行不存在时 update 抛错（真机 V-1 现象），必须也能走到「插首行」那条路 */
    env.db.__setMissingDocUpdateThrows(true)

    const res = await guard.main(Object.assign({ target: KEY }, WAIVE))

    eq(res.ok, true)
    eq(res.waived, true)
    eq(res.count, 0, '免计费的那一次不该让配额 +1')
    const row = env.db.__dump('generate_quota')[0]
    eq(row.count, 0)
    eq(row.waive_count, 1)
    eq(row._openid, 'u1', 'selfRead 权限靠 _openid 认人')
  })

  it('只对 generate 生效：refresh 带同一申请不免，也不留豁免标记', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow()])

    const res = await guard.main({ kind: 'refresh', action: 'consume', waiveIf: 'first_build', target: KEY })

    eq(res.waived, false)
    eq(env.db.__dump('refresh_quota')[0].count, 1, '刷新额度照常扣')
    notOk(env.db.__dump('report_cache')[0].first_build_waived_at, '没发放就不许写标记，否则白白吃掉一次机会')
  })

  it('target 非法（空串 / 带路径分隔符）⇒ 不免', async () => {
    const guard = loadGuard()
    env.db.__seed('report_cache', [freshRow()])

    eq((await guard.main(Object.assign({ target: '' }, WAIVE))).waived, false)
    eq((await guard.main(Object.assign({ target: 'a/b#tech' }, WAIVE))).waived, false)
  })

  it('长 personKey 也认（复核上限与写口同值 120）', async () => {
    const guard = loadGuard()
    const longKey = `${'长'.repeat(70)}#tech`
    ok(longKey.length > 64 && longKey.length <= 120, '用例前提：落在「旧的 64」与「写口的 120」之间')
    env.db.__seed('report_cache', [freshRow({ _id: longKey })])

    const res = await guard.main(Object.assign({ target: longKey }, WAIVE))

    eq(res.waived, true, '复核上限比写口小，长名字的首建就会白白多算一次额度')
  })

  it('每日上限写在服务端且是 1（免费 3 次/日 ⇒ 最坏 4 次/人/天）', () => {
    const guardSrc = read(QUOTA_GUARD)

    ok(/const FIRST_BUILD_WAIVE_PER_DAY = 1\b/.test(guardSrc), '上限若与注释不符，成本口径就成了空话')
  })

  it('时间窗盖得住最坏构建（≥ 19 分钟）：短了就会冤枉等得最久的那些首建', () => {
    const guardSrc = read(QUOTA_GUARD)
    const m = /const FIRST_BUILD_WINDOW_MS = (\d+) \* 60 \* 1000/.exec(guardSrc)

    ok(m, '时间窗请保持「分钟 × 60 × 1000」的写法，这条断言才读得懂它')
    ok(
      Number(m[1]) >= 19,
      `时间窗 ${m[1]} 分钟短于 utils/cache.ts#BUILDING_TIMEOUT_MS（4 批×3 次×2 轮×45s + 检索 15s + 余量 30s = 1125s ≈ 18.7 分钟）：` +
        '构建慢到那个量级的用户，申请会在超窗后被拒 —— 而冤枉的恰好是等得最久的那一次首建'
    )
  })
})

describe('写口：首建标记只落在「建新行」那一条 insert 里', () => {
  const store = read(REPORT_STORE)

  it('建行时写 first_build_owner / first_build_at', () => {
    ok(store.includes('first_build_owner: openid'))
    ok(store.includes('first_build_at: now'))
  })

  it('全文只出现一次 first_build_owner', () => {
    eq(
      store.split('first_build_owner').length - 1,
      1,
      '抢占 / 覆盖那条 update 也写的话，就变成「谁抢到锁谁算首建」，豁免能被反复领'
    )
  })
})

describe('schema 登记（下一个人得知道这些键是谁写的）', () => {
  const schema = read(path.join(CLOUD, 'dbInit', 'schema.js'))

  it('report_cache 的三个首建字段都在', () => {
    ok(schema.includes("f('first_build_owner', 'string?'"))
    ok(schema.includes("f('first_build_at', 'string?'"))
    ok(schema.includes("f('first_build_waived_at', 'string?'"))
  })

  it('generate_quota 记上了豁免名额', () => {
    ok(schema.includes("f('waive_count', 'number?'"))
  })
})
