'use strict'

/**
 * 首建激励 · 冷门判定（S2-3，2026-10-16）：报告一行全站共用这件事，对**长尾人物**才有欠账感。
 *
 * 背景见 48-report-first-build.js：报告是全局共享缓存（report_cache，一行 / personKey），
 * 首建者付掉 1 次额度，之后全站（含他自己）免费读。48 已把「首建」这件事说清楚了
 * （判据 isFirstBuild + 免计费 + 页面说明条）。本文件补的是它的**分叉**：
 *
 * 热门人物几乎不用激励 —— 早有人建过、首建多半轮不到你，而且你不建也有人会建。
 * 真正值得给一份看得见的回报的是**冷门人物**（公开报道很少的长尾人物）：没人愿意花额度去建，
 * 第一个建的人补上的是库里长期空着的一个位置。故 S2-3 = 「首建 + 冷门」这个交集。
 *
 * 本文件钉六件事：
 *   ① 判据本身（utils/report#isColdPerson）—— 关键是它**只认 coverage.items**、
 *      且**缺字段一律不算**（授予荣誉的判据，宁可少说一句）；
 *   ② 它与达标线（shortfallVerdict）**互相独立**：冷门不等于不达标，反之亦然；
 *   ③ 冷门线取自 config 真源（benefits.ts#reportSource.coldItemsMax），端上不另写常数；
 *   ④ 埋点对**每一次**生成都报 cold / materials —— 验收项「冷门人物首建率可观测」需要一个分母；
 *   ⑤ 缓存层只在「首建 + 冷门」同时成立时才交回 coldFirstBuild（命中缓存 / 覆盖刷新都不带）；
 *   ⑥ 报告页把荣誉版文案渲染出来，且**不加码承诺**（不再多许一句「免费 / 送次数」）。
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
  return { load: env.load, db: env.db }
}

/** 埋点是 fire-and-forget（db.ts#autoRun 走微任务兜底），断言前必须放它落库 */
const tick = () => new Promise((r) => setTimeout(r, 0))

const KEY = '测试人物#tech'

/** 最小报告（只放本文件用到的字段）：coverage.items 是唯一的判据输入 */
const mkReport = (items, over = {}) =>
  Object.assign({ personKey: KEY, name: '测试人物', degraded: false, coverage: { items } }, over)

/**
 * 达标产物（4 批共用的非严格契约对象）：骨架 + 3 条时间线 = 恰好卡在 SHORTFALL_MIN_FACTS 上。
 * 不达标的产物一律不落库，「首建」这条链路就走不到，用例失去意义。
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

/** n 条 url 各异的检索结果（url 是 mergeNews 的去重键，重了会被并成一条） */
const mkPages = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `标题${i}`,
    url: `https://news.example.com/${i}`,
    snippet: '正文',
    datePublished: '2026-09-01'
  }))

/**
 * 假上游：检索返回 n 条（n 直接决定 coverage.items ⇒ 冷门与否）、模型回达标产物。
 * `action==='report'` 刻意不认，触发端上直写回退（同 48：认了会落进「等待他人构建」那条路）。
 */
const online = (n = 1) =>
  env.registerCloudFn('aiProxy', (data) => {
    if (data.action === 'report') return { ok: false, error: '云函数未部署' }
    if (data.action === 'search') return { ok: true, pages: mkPages(n) }
    if (data.purpose === 'aux') {
      return { ok: true, content: JSON.stringify({ news: ['近期动态'], profile: ['履历'] }) }
    }
    return { ok: true, content: JSON.stringify(RICH) }
  })

/* ═══════════════════════════════ 一、判据本身 ═══════════════════════════════ */

describe('冷门判定 utils/report#isColdPerson', () => {
  it('素材条数 ≤ 上限 ⇒ 冷门；> 上限 ⇒ 不是', () => {
    const { load } = fresh()
    const { isColdPerson, COLD_ITEMS_MAX } = load('utils/report')

    ok(isColdPerson(mkReport(COLD_ITEMS_MAX)), '正好等于线上算冷门（边界含端点）')
    ok(isColdPerson(mkReport(COLD_ITEMS_MAX - 1)))
    ok(isColdPerson(mkReport(0)), '一条都没抓到当然算（虽然通常走不到这里）')
    notOk(isColdPerson(mkReport(COLD_ITEMS_MAX + 1)), '过线就不是长尾了，激励不该人人有份')
  })

  it('缺 coverage / items 不是数字 ⇒ **不算**冷门（授予荣誉的判据宁可少说一句）', () => {
    const { load } = fresh()
    const { isColdPerson } = load('utils/report')

    notOk(isColdPerson(null), '没有报告就没有荣誉')
    notOk(isColdPerson(undefined))
    notOk(isColdPerson({}), '老报告没有 coverage 字段')
    notOk(isColdPerson({ coverage: {} }))
    notOk(isColdPerson({ coverage: { items: '3' } }), "字符串 '3' 不是数字：typeof 一旦放宽，脏数据就会混进荣誉判定")
    notOk(isColdPerson({ coverage: { items: null } }))
  })

  it('只认素材条数，不认热度 —— 判据不许偷偷换成「不在热榜上」', () => {
    const { load } = fresh()
    const { isColdPerson } = load('utils/report')

    /* heat 高但报道少：仍算冷门（素材条数是当次生成手上就有的事实，热榜只收热门的人、
       拿「不在榜」当冷门会让激励人人有份 —— 理由见 isColdPerson 头注释） */
    ok(isColdPerson(mkReport(2, { heat: 999 })))
  })

  it('与达标线互相独立：冷门报告照样能达标（冷门 ≠ 残）', () => {
    const { load } = fresh()
    const { isColdPerson, reportShortfall, COLD_ITEMS_MAX, SHORTFALL_MIN_FACTS } = load('utils/report')

    /* items = 3 同时落在两条线里：既算冷门、素材又够门槛 —— 这种交集恰恰是最常见的长尾首建 */
    ok(SHORTFALL_MIN_FACTS <= COLD_ITEMS_MAX, '前提：达标线与冷门线有交集，本用例才有意义')
    const rep = {
      ...mkReport(SHORTFALL_MIN_FACTS),
      intro: '简介',
      analysis: '点评',
      dynamics: [],
      quotes: [],
      timeline: [
        { date: '2026-09-01', event: '事件一' },
        { date: '2026-08-01', event: '事件二' },
        { date: '2026-07-01', event: '事件三' }
      ]
    }

    ok(isColdPerson(rep), '素材少 ⇒ 冷门')
    eq(reportShortfall(rep, false), null, '冷门**不等于**残报告：两把尺子各量各的，不许复用')
  })
})

/* ════════════════════════ 二、常数取自配置真源（端上不另写） ════════════════════════ */

describe('冷门线取自 config 真源（benefits.ts#reportSource.coldItemsMax）', () => {
  it('COLD_ITEMS_MAX 就是配置里那一个数', () => {
    const { load } = fresh()
    const { COLD_ITEMS_MAX } = load('utils/report')
    const { REPORT_SOURCE } = load('config/benefits')

    eq(COLD_ITEMS_MAX, REPORT_SOURCE.coldItemsMax, '端上若另写一个常数，调线时两边会各说各话')
    ok(typeof COLD_ITEMS_MAX === 'number' && COLD_ITEMS_MAX > 0)
  })

  it('配置里写明了这条线的边界（只影响荣誉与分桶，不参与计费 / 达标）', () => {
    const cfg = read(path.join(SRC, 'config', 'benefits.ts'))
    const m = /coldItemsMax:\s*(\d+)/.exec(cfg)

    ok(m, 'coldItemsMax 必须留在真源里（云端 5 份副本由 npm run config:sync 生成）')
    ok(/冷门|长尾/.test(cfg.slice(Math.max(0, m.index - 600), m.index)), '数值旁边要写清它是什么')
  })
})

/* ═══════════════════════ 三、埋点：每一次生成都报 cold / materials ═══════════════════════ */

describe('埋点 report_generate 带上 cold 与 materials（S2-3 验收：冷门人物首建率）', () => {
  const genRows = () => env.db.__dump('events').filter((e) => e.event === 'report_generate')

  it('冷门人物首建 ⇒ cold=true，materials 与报告画像的素材条数同口径', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online(1)

    const out = await getOrBuildReport(KEY)
    await tick()

    const rows = genRows()
    eq(rows.length, 1, '一次成功生成只报一条')
    eq(rows[0].props.cold, true, '只有这条才谈得上「冷门首建」')
    eq(rows[0].props.firstBuild, true)
    eq(
      rows[0].props.materials,
      out.report.coverage.items,
      'materials 与 coverage.items 必须同源：日后调线要拿它重算真实分布'
    )
  })

  it('热门人物（素材过线）⇒ cold=false，但字段照样要在', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    const { COLD_ITEMS_MAX } = load('utils/report')
    online(COLD_ITEMS_MAX + 3)

    const out = await getOrBuildReport(KEY)
    await tick()

    ok(out.report.coverage.items > COLD_ITEMS_MAX, '前提：这一份素材确实过线了')
    const row = genRows()[0]
    eq(row.props.cold, false, '报 false 而不是不报 —— 分母靠的就是这一条')
    eq(row.props.materials, out.report.coverage.items)
  })

  it('**非首建**的生成也要报 cold / materials（否则永远只有分子、算不出率）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online(1)
    env.db.__seed('report_cache', [{ _id: KEY, state: 'ready', report: mkReport(9, { heat: 5 }) }])

    await getOrBuildReport(KEY, { force: true })
    await tick()

    const row = genRows()[0]
    ok(row, '覆盖刷新同样产生一次 report_generate')
    eq(row.props.firstBuild, false, '这是重做，不是首建')
    eq(typeof row.props.cold, 'boolean', '即便不是首建，cold 也必须报出来 —— 它才是那个分母')
    eq(row.props.materials, 1, '素材条数照实报（这一次只抓到 1 条）')
  })
})

/* ══════════════════ 四、缓存层：coldFirstBuild 只在「首建 + 冷门」时交回 ══════════════════ */

describe('coldFirstBuild · 端到端（utils/cache#getOrBuildReport）', () => {
  it('冷门 + 首建 ⇒ firstBuild 与 coldFirstBuild 同时为 true', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online(1)

    const out = await getOrBuildReport(KEY)

    eq(out.kind, 'report')
    eq(out.firstBuild, true)
    eq(out.coldFirstBuild, true, '页面据此换成荣誉版文案')
  })

  it('首建但**不冷门** ⇒ 只有 firstBuild，没有 coldFirstBuild', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    const { COLD_ITEMS_MAX } = load('utils/report')
    online(COLD_ITEMS_MAX + 3)

    const out = await getOrBuildReport(KEY)

    eq(out.firstBuild, true)
    eq(out.coldFirstBuild, undefined, '热门人物首建不给荣誉：不然这条激励人人都有')
  })

  it('命中缓存 ⇒ 两个标记都不带（读别人建好的那份，跟「谁建立的」无关）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online(1)
    env.db.__seed('report_cache', [{ _id: KEY, state: 'ready', report: mkReport(1, { heat: 5 }) }])

    const out = await getOrBuildReport(KEY)

    eq(out.fromCache, true)
    eq(out.firstBuild, undefined)
    eq(out.coldFirstBuild, undefined)
  })

  it('force 覆盖既有报告 ⇒ 两个标记都不带（这是重做，不是首建）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online(1)
    env.db.__seed('report_cache', [{ _id: KEY, state: 'ready', report: mkReport(1, { heat: 5 }) }])

    const out = await getOrBuildReport(KEY, { force: true })

    eq(out.fromCache, false, '真的重新生成了')
    eq(out.firstBuild, undefined)
    eq(out.coldFirstBuild, undefined, '冷门线也救不了它：没有首建就没有激励')
  })
})

/* ══════════════════════════════ 五、接线（源码钉住） ══════════════════════════════ */

describe('冷门判定的接线（源码钉住）', () => {
  const cache = read(path.join(SRC, 'utils', 'cache.ts'))

  it('缓存层用的就是 report.ts 那个判据，不在本地重写一遍阈值', () => {
    ok(cache.includes("import {") && cache.includes('isColdPerson'), '必须从 report 引进来')
    ok(cache.includes('const cold = isColdPerson(report)'), '判在落库那条路径上，页面与埋点同源')
  })

  it('埋点同时带 cold 与 materials（同一个对象上，别拆成两次）', () => {
    ok(/track\('report_generate', \{[^}]*\bcold\b/.test(cache))
    ok(/track\('report_generate', \{[^}]*\bmaterials\b/.test(cache))
  })

  it('coldFirstBuild 嵌在 firstBuild 那个 spread 里（没有首建就绝不出现）', () => {
    ok(cache.includes('...(firstBuild ? { firstBuild: true, ...(cold ? { coldFirstBuild: true } : {}) } : {})'))
  })

  it('埋点枚举里写明了 cold / materials 的口径与「为什么要报分母」', () => {
    const events = read(path.join(SRC, 'utils', 'events.ts'))

    ok(events.includes('props.cold'), '口径要留在枚举注释里，下一个人才知道这两个字段是干嘛的')
    ok(events.includes('props.materials'))
    ok(/分母/.test(events), '「只报首建就答不出率」这件事必须写在注释里')
  })
})

/* ══════════════════════════════ 六、页面：荣誉版文案 ══════════════════════════════ */

describe('冷门首建荣誉条（报告页 · package/report/index.tsx）', () => {
  const page = read(path.join(SRC, 'package', 'report', 'index.tsx'))

  it('有独立状态位，并在新一轮 load 里复位、按 outcome 赋值', () => {
    ok(page.includes('const [coldFirstBuild, setColdFirstBuild] = useState(false)'))
    ok(page.includes('setColdFirstBuild(false)'), '不复位的话，上一份的荣誉会跟着新报告出现')
    ok(page.includes('setColdFirstBuild(outcome.coldFirstBuild === true)'))
  })

  it('**复用**首建那条提示（同一个 notice key），没有新造一个提示条', () => {
    const key = page.slice(page.indexOf('type NoticeKey ='), page.indexOf('type NoticeKey =') + 400)
    notOk(/coldFirstBuild/.test(key), '荣誉版是同一个 notice 的换皮，不该多出一个可关闭项')
    eq(page.split("{firstBuild && !closedNotices.firstBuild && (").length - 1, 1)
  })

  it('荣誉版文案：点明「第一位建立者」并把素材条数说清楚', () => {
    const at = page.indexOf('{firstBuild && !closedNotices.firstBuild && (')
    /* 按**块的真实结尾**切，不按固定字符数：下一条提示（diff）紧跟其后，
       固定窗口一旦够长就会把它的文案算进来（「不加码承诺」那条会因此误报）。 */
    const block = page.slice(at, page.indexOf("closeNotice('firstBuild')", at) + 30)

    ok(block.includes('你是 TA 报告的第一位建立者'), '冷门首建要给一句看得见的回报')
    ok(block.includes('coldFirstItems'), '要说清「公开报道不多」是几多 —— 拿不出数字就是一句空话')
    ok(block.includes("page-report__diff--first"), '用加粗的同一条提示，不新造组件')
    ok(block.includes("closeNotice('firstBuild')"), '所有文字提示框都要能关（既有约定）')
  })

  it('不加码承诺：荣誉版不许再多许一句「免费 / 送次数」', () => {
    const at = page.indexOf('{firstBuild && !closedNotices.firstBuild && (')
    /* 按**块的真实结尾**切，不按固定字符数：下一条提示（diff）紧跟其后，
       固定窗口一旦够长就会把它的文案算进来（「不加码承诺」那条会因此误报）。 */
    const block = page.slice(at, page.indexOf("closeNotice('firstBuild')", at) + 30)

    /* 现有权益只有「首建免计费」这一条（由 quotaGuard 复核），页面不该另许好处 ——
       多写一句兑现不了的话，比不写这句荣誉更糟。 */
    notOk(/免计费|免费|送次数|赠送/.test(block), '荣誉的兑现物是那句话本身，不是新的钱')
  })

  it('冷门条样式（加粗边框）落在报告页 scss 里', () => {
    const scss = read(path.join(SRC, 'package', 'report', 'index.scss'))

    ok(scss.includes('&__diff--first'), '样式写在报告页自己那份 scss 里')
    ok(/__diff--first[^}]*border/.test(scss), '荣誉版靠边框与底色区分，不靠新组件')
  })
})
