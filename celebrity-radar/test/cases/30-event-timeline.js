'use strict'

/**
 * 事件时间线独立页（P5，2026-10-13）。
 *
 * 钉住七件事：
 *   1. 页面已注册、**不是 tab 页**（`.safe-bottom` 而非 `.safe-tab`），标题与下拉刷新配置齐备；
 *   2. 舆情页事件卡**整卡跳转**到它，且带 encode 过的 event_key（内联展开已移除）；
 *   3. 分页切片纯函数 `pageSlice`（每页 10、最后一页不足、空数据、页数计算、越界钳制）；
 *   4. 免费用户时间线限 5 条、会员不受限（复用 opinion-access#sliceDetail / TIMELINE_PAGE_SIZE）；
 *   5. 参数缺失 / 非法 → 明确空态（`isValidEventKey` 门禁）；
 *   6. 降级：库里没有这一键时回落端上聚类（`resolveEventByKey` 三档来源）；
 *   7. 时间线每条带来源与来源性质（页面渲染 SOURCE_NATURE_LABEL）。
 *
 * 纯函数直接 require 编译产物；页面是 .tsx（不进测试编译），与既有页面用例同法读源码文本断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 事件行（opinion_events 的一行；字段与 OpinionEventRow 同名） */
function eventRow(over = {}) {
  return Object.assign(
    {
      id: 'k',
      event_key: 'k',
      object_key: '',
      block: 'feed',
      title: '事件',
      members: [],
      memberCount: 0,
      timeline: [],
      sources: [],
      labels: [],
      impact: 'unknown',
      credibility: 'unknown',
      response: 'unknown',
      first_at: '',
      last_at: '',
      updated_at: ''
    },
    over
  )
}

/* ───────────────────────── 1. 页面注册与非 tab 约束 ───────────────────────── */

describe('事件时间线页：已注册且不是 tab 页（静态约束）', () => {
  const appConfig = read('app.config.ts')
  const page = read('package/event/index.tsx')
  const config = read('package/event/index.config.ts')
  const scss = read('package/event/index.scss')

  it('app.config 的 subpackages 注册了 package/event/index', () => {
    const sub = appConfig.slice(appConfig.indexOf('subpackages: ['))
    ok(sub.includes("'event/index'"), 'event/index 必须注册进 package 分包，否则跳转打不开')
  })

  it('不是 tab 页：tabBar.list 里没有它，页面用 .safe-bottom 而非 .safe-tab', () => {
    const tab = appConfig.slice(appConfig.indexOf('tabBar:'))
    const start = tab.indexOf('list: [')
    const tabBarList = tab.slice(start, tab.indexOf(']', start))
    notOk(tabBarList.includes('package/event/index'), '事件时间线页不是 tab，不应进 tabBar.list')

    ok(page.includes('safe-bottom'), '非 tab 页底部预留用 .safe-bottom')
    notOk(page.includes('safe-tab'), '非 tab 页不得用 .safe-tab（那是给悬浮底栏留空间的）')
  })

  it('导航栏标题为「事件时间线」，开启下拉刷新与触底距离', () => {
    ok(config.includes("navigationBarTitleText: '事件时间线'"), '导航栏标题应为「事件时间线」')
    ok(config.includes('enablePullDownRefresh: true'), '要开启下拉刷新')
    ok(config.includes('onReachBottomDistance'), '要设置触底距离（触底加载更多）')
    ok(scss.includes('.page-event'), '样式文件缺失或未以 .page-event 起头')
  })

  it('复用既有 utils：不另写读库 / 状态 / 门禁代码', () => {
    for (const imp of [
      "from '@/utils/opinion-store'",
      "from '@/utils/opinion-events'",
      "from '@/utils/opinion-access'"
    ]) {
      ok(page.includes(imp), `事件时间线页应复用 ${imp}`)
    }
    ok(
      page.includes('loadStoredEventByKey('),
      '读落库事件应走 loadStoredEventByKey（只按 event_key 取这一条，不再把最近 200 条全读回来 filter）'
    )
    ok(page.includes('loadEventStatus('), '读我的状态应走 loadEventStatus')
    ok(page.includes('buildOpinionEvents('), '降级应回落 buildOpinionEvents')
    ok(page.includes('resolveEventByKey('), '按 event_key 定位应走 resolveEventByKey')
  })
})

/* ───────────────────────── 2. 舆情页跳转已接上且带参 ───────────────────────── */

describe('舆情页：事件卡跳转事件时间线页（静态约束）', () => {
  const page = read('pages/opinion/index.tsx')

  it('整卡跳转 /package/event/index，带 encode 过的 eventKey；不再内联展开', () => {
    ok(page.includes('/package/event/index'), '事件卡应跳转到事件时间线页')
    ok(page.includes('Taro.navigateTo'), '跳转用 navigateTo')
    ok(page.includes('eventKey=${encodeURIComponent(ev.key)}'), 'eventKey 必须 encode 后带上')
    notOk(page.includes('展开时间线') || page.includes('toggleEvent('), '内联展开已移除')
  })
})

/* ───────────────────────── 3. 分页切片纯函数 ───────────────────────── */

describe('时间线分页：pageSlice 纯函数', () => {
  function PA() {
    env.resetAll()
    return env.load('utils/opinion-access')
  }

  it('每页固定 10 条（真源 TIMELINE_PAGE_SIZE）', () => {
    const { TIMELINE_PAGE_SIZE, pageSlice } = PA()
    eq(TIMELINE_PAGE_SIZE, 10, '每页固定 10 条')
    const rows = Array.from({ length: 25 }, (_, i) => i)
    eq(pageSlice(rows, 1).rows.length, TIMELINE_PAGE_SIZE, '第 1 页 10 条（累计）')
  })

  it('累计切片：第 1 / 2 页分别 10 / 20 条且还有更多，第 3 页 25 条到底', () => {
    const { pageSlice } = PA()
    const rows = Array.from({ length: 25 }, (_, i) => i)

    const p1 = pageSlice(rows, 1)
    eq(p1.rows.length, 10)
    eq(p1.hasMore, true)
    eq(p1.pageCount, 3, '25 条 → 3 页')
    eq(p1.page, 1)

    const p2 = pageSlice(rows, 2)
    eq(p2.rows.length, 20, '累计到第 2 页 20 条')
    eq(p2.hasMore, true)

    const p3 = pageSlice(rows, 3)
    eq(p3.rows.length, 25, '最后一页不足也全部给出（累计 25 条）')
    eq(p3.hasMore, false, '到底 → 没有更多')
    eq(p3.page, 3)
    deepEq(p3.rows, rows, '累计行与原始数组一致')
  })

  it('越界页号钳到合法范围（不会少渲染最后一段）', () => {
    const { pageSlice } = PA()
    const rows = Array.from({ length: 25 }, (_, i) => i)
    const over = pageSlice(rows, 99)
    eq(over.page, 3, '超过总页数 → 钳到最后一页')
    eq(over.rows.length, 25)
    eq(over.hasMore, false)

    const zero = pageSlice(rows, 0)
    eq(zero.page, 1, '非正整数页号 → 视作第 1 页')
    eq(zero.rows.length, 10)
  })

  it('空数据 / 非数组：不抛、rows 空、pageCount 0', () => {
    const { pageSlice } = PA()
    for (const bad of [[], null, undefined, 'not-array']) {
      const r = pageSlice(bad, 1)
      deepEq(r.rows, [], '空 → 空行')
      eq(r.hasMore, false)
      eq(r.page, 1)
      eq(r.pageCount, 0, '空数据页数为 0')
    }
  })
})

/* ───────────────────────── 4. 分层门禁：免费 5 / 会员全部 ───────────────────────── */

describe('时间线分层：免费限 5 条、会员不受限（复用同一套门禁）', () => {
  it('免费档切到 5 条并给隐藏数；会员全部；分页叠加在可见集合之上', () => {
    env.resetAll()
    const { sliceDetail, pageSlice } = env.load('utils/opinion-access')

    const timeline = Array.from({ length: 25 }, (_, i) => ({ index: i }))

    const free = sliceDetail(timeline, false)
    eq(free.rows.length, 5, '免费档时间线切到 5 条')
    eq(free.hidden, 20, '隐藏 20 条（供提示行）')
    const freePaged = pageSlice(free.rows, 1)
    eq(freePaged.rows.length, 5, '免费可见集合 ≤ 一页，只有第 1 页')
    eq(freePaged.hasMore, false, '免费看到底 → 没有更多')

    const member = sliceDetail(timeline, true)
    eq(member.rows.length, 25, '会员看到全部')
    eq(member.hidden, 0)
    eq(pageSlice(member.rows, 1).rows.length, 10, '会员第 1 页 10 条')
    eq(pageSlice(member.rows, 2).rows.length, 20)
    eq(pageSlice(member.rows, 3).rows.length, 25)
    eq(pageSlice(member.rows, 3).hasMore, false, '会员翻到底 → 没有更多')
  })

  it('页面复用 sliceDetail + moreDetailNote + 跳会员页，不新写门槛', () => {
    const page = read('package/event/index.tsx')
    ok(page.includes('sliceDetail('), '免费限 5 要走 sliceDetail')
    ok(page.includes('moreDetailNote('), '截断提示复用 moreDetailNote')
    ok(page.includes("openMemberPage('event')"), '提示行应能跳会员页（收口到 openMemberPage，来源 event）')
    ok(page.includes('pageSlice('), '分页走 pageSlice')
    ok(page.includes('usePullDownRefresh(') && page.includes('useReachBottom('), '下拉刷新 + 触底加载更多')
  })
})

/* ───────────────────────── 5. 参数非法 → 空态 ───────────────────────── */

describe('事件时间线页：参数缺失 / 非法的空态分支', () => {
  it('isValidEventKey：8 位十六进制合法（含云函数 -N 后缀），其余非法', () => {
    env.resetAll()
    const { isValidEventKey, eventKeyOf } = env.load('utils/opinion-events')
    ok(isValidEventKey('a1b2c3d4'), '8 位 hex 合法')
    ok(isValidEventKey('00000000'), '全零合法')
    ok(isValidEventKey('a1b2c3d4-2'), '撞键后缀 -N 合法')
    ok(isValidEventKey('a1b2c3d4-10'), '多位后缀合法')
    notOk(isValidEventKey('a1b2c3d'), '7 位不合法')
    notOk(isValidEventKey('A1B2C3D4'), '大写不合法（eventKeyOf 产出小写）')
    notOk(isValidEventKey('xyz12345'), '非 hex 不合法')
    notOk(isValidEventKey('a1b2c3d4-'), '空后缀不合法')
    notOk(isValidEventKey(''), '空串不合法')
    notOk(isValidEventKey(null), 'null 不合法')
    notOk(isValidEventKey(12345678), '数字不合法')
    /* 真源产出天然合法 */
    ok(isValidEventKey(eventKeyOf('张三', '关于x的声明')), 'eventKeyOf 产出即合法')
  })

  it('页面用 isValidEventKey 兜住路由参数，非法即空态且不读库', () => {
    const page = read('package/event/index.tsx')
    ok(page.includes('isValidEventKey('), '参数门禁走 isValidEventKey')
    ok(page.includes("status: 'invalid'") || page.includes("'invalid'"), '缺「参数非法」空态分支')
    ok(page.includes('page-event__empty'), '空态要有明确落点样式')
    ok(page.includes('navigateBack'), '空态要能返回')
    /* 门禁必须排在读库之前：非法的判断要在读库调用之前 */
    ok(page.indexOf('isValidEventKey(') < page.indexOf('loadStoredEventByKey('), '参数校验要早于读库')
  })
})

/* ───────────────────────── 6. 降级：库里无该键 → 回落端上聚类 ───────────────────────── */

describe('事件时间线页：降级到本端聚类（resolveEventByKey）', () => {
  it('库里命中该键 → cloud；库里没有该键 → 回落本端聚类 local；都没有 → none', () => {
    env.resetAll()
    const { resolveEventByKey } = env.load('utils/opinion-store')
    const { buildOpinionEvents } = env.load('utils/opinion-events')

    /* 端上聚类结果：拿到一个真实的事件键 */
    const local = buildOpinionEvents({
      feed: [{ title: '关于X公司起诉事件的声明', source: 'A报', date: '2026-10-01' }]
    })
    eq(local.length, 1)
    const key = local[0].key

    /* 1) 库里命中 → cloud */
    const storedHit = [eventRow({ event_key: key, title: '云端事件' })]
    const hit = resolveEventByKey(storedHit, local, key)
    eq(hit.source, 'cloud')
    eq(hit.event.title, '云端事件')

    /* 2) 库里有别的事件、但没有这一键 → 仍回落本端聚类（不是「库非空就放弃」） */
    const storedOther = [eventRow({ event_key: 'deadbeef', title: '别的事' })]
    const fallback = resolveEventByKey(storedOther, local, key)
    eq(fallback.source, 'local', '库里没有这一键时回落端上聚类')
    eq(fallback.event.title, local[0].title)

    /* 3) 读库失败（null）→ 回落本端聚类 */
    eq(resolveEventByKey(null, local, key).source, 'local')

    /* 4) 两处都没有 → none（页面给空态） */
    eq(resolveEventByKey(null, [], key).source, 'none')
    eq(resolveEventByKey(storedOther, local, 'ffffffff').source, 'none')

    /* 5) 空键 → none，不抛 */
    eq(resolveEventByKey(storedHit, local, '').source, 'none')
  })
})

/* ───────────────────────── 7. 时间线带来源与来源性质 ───────────────────────── */

describe('事件时间线：每条带来源与来源性质（合规）', () => {
  it('聚类产出的时间线每条都带来源与来源性质', () => {
    env.resetAll()
    const { buildOpinionEvents, SOURCE_NATURE_LABEL } = env.load('utils/opinion-events')
    const ev = buildOpinionEvents({
      feed: [
        { title: '关于W公司的声明', source: '某某市公安局', date: '2026-10-05' },
        { title: '【重磅】关于W公司的声明', source: 'A报', date: '2026-10-02' }
      ]
    })[0]
    ok(ev.timeline.length === 2, '两条带来源的成员都进时间线')
    ok(ev.timeline.every((t) => !!t.source && !!t.nature), '每条时间线必须带来源与来源性质')
    eq(SOURCE_NATURE_LABEL.official, '官方通报')
    eq(SOURCE_NATURE_LABEL.media, '媒体报道')
    eq(SOURCE_NATURE_LABEL.unknown, '来源未标注')
  })

  it('页面渲染来源与来源性质，并保留「聚合 ≠ 认定」的克制说明', () => {
    const page = read('package/event/index.tsx')
    ok(page.includes('SOURCE_NATURE_LABEL'), '时间线每条要标注来源性质')
    ok(page.includes('t.source') && page.includes('t.nature'), '时间线要分别渲染来源与来源性质')
    ok(/不代表平台已核实/.test(page), '要有「聚合不等于认定」的轻量说明')
    ok(page.includes('官方通报') && page.includes('媒体报道'), '区分官方通报与媒体报道')
  })
})

/* ───────────────────────── 8. 打开不再自动标已读（2026-10-13 口径变更） ───────────────────────── */

describe('事件时间线页：打开不再自动标已读，显式标记仍可用', () => {
  const page = read('package/event/index.tsx')

  it('打开页面（load）不再自动标记已读：定位成功后不写 reads', () => {
    /* 删除「定位到就标记」的自动分支，避免误清未读 / 替用户下判断 */
    notOk(/if \(!eventStatus\.reads\[found\.key\]\)/.test(page), '打开即已读的自动标记分支应删除')
    notOk(page.includes('void markRead(found.key)'), '打开不得自动调用 markRead(found.key)')
    /* load 依赖里也不该再有 eventStatus.reads（它不再读已读态去做自动标记） */
    ok(page.includes('}, [rawKey, collectInput])'), 'load 不应再依赖 eventStatus.reads')
  })

  it('显式「标记已读」按钮仍在并走 markRead / markEventRead（行为不变），已读态仍显示', () => {
    ok(page.includes('onClick={() => void markRead(event.key)}'), '卡头上的「标记已读」按钮仍在（仅显式触发）')
    ok(page.includes('markEventRead('), '显式标记仍写库（markEventRead）')
    ok(page.includes("read ? '✓ 已读'"), '已读状态仍照常显示（read ? ✓ 已读）')
  })

  it('文件头注释已更新为「打开不再自动标已读」并说明原因', () => {
    ok(page.includes('打开不再自动标已读'), '文件头应写明新口径')
    notOk(page.includes('## 「打开即已读」规则'), '旧的「打开即已读」说明应移除')
    ok(/避免误清未读|替用户下判断|没被标记/.test(page) || page.includes('误清未读'), '注释应说明「为什么不自动标」')
  })
})
