'use strict'

/**
 * 舆情页三张**概要卡**「固定首屏 + 按需加载」（P6，2026-10-13）—— 修「内容过多」。
 *
 * 背景：事件 / 关注动态 / 关键词预警三张概要卡此前走 `sliceDetail(<items>, isMember)`，
 * 会员档「全部」→ 概要列表按明细口径把整库一次渲染。概要数据都是**会累积**的（事件一轮聚类
 * 实测约 200 条；关注动态 = 关注人数 × 条目；预警 = 各监测词条目之和），故三张概要卡统一改为：
 * **固定首屏 3 条 + 「加载更多」每次 3 条**，**与会员态无关**（概要不分档）；会员的明细分层
 * 仍作用在单个事件的**时间线**上（pages/event）。
 *
 * 钉住：
 *   1. `overviewSlice` 纯函数：累计行数 / 剩余数 / hasMore 的边界（空、不足、跨批、越界、脏输入）；
 *   2. 概要卡首屏条数**与会员态无关**（overviewSlice 不含会员入参；页面不把 isMember 喂给它）；
 *   3. 静态断言：三张概要卡**都**走 `overviewSlice`（三处调用），**都不再用**按会员档放全的
 *      `sliceDetail` / `moreDetailNote`；头部各自显示总数 / 计数；
 *   4. 到底文案 / 空态由页面按 `hasMore` / 列表长度分支渲染。
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

function OA() {
  env.resetAll()
  return env.load('utils/opinion-access')
}

/* ───────────────────── 1. overviewSlice 纯函数 ───────────────────── */

describe('事件概要卡：overviewSlice 固定首屏 + 按需追加（纯函数）', () => {
  it('首屏只放 3 条：给 200 条也只返回前 3 条，剩余 197、hasMore=true', () => {
    const { overviewSlice, EVENT_OVERVIEW_INITIAL, EVENT_OVERVIEW_BATCH } = OA()
    eq(EVENT_OVERVIEW_INITIAL, 3, '首屏固定 3 条')
    eq(EVENT_OVERVIEW_BATCH, 3, '每批 3 条')

    const many = Array.from({ length: 200 }, (_, i) => `e${i}`)
    const first = overviewSlice(many, EVENT_OVERVIEW_INITIAL)
    eq(first.rows.length, 3, '首屏只渲染 3 条（不因数据多而放全）')
    deepEq(first.rows, ['e0', 'e1', 'e2'])
    eq(first.remaining, 197, '剩余 197 条待加载')
    eq(first.hasMore, true)
  })

  it('「加载更多」是累计切片：shown=3/6/9… 返回累计行数，剩余数随之递减', () => {
    const { overviewSlice, EVENT_OVERVIEW_INITIAL, EVENT_OVERVIEW_BATCH } = OA()
    const many = Array.from({ length: 8 }, (_, i) => i)

    const p1 = overviewSlice(many, EVENT_OVERVIEW_INITIAL)
    eq(p1.rows.length, 3)
    eq(p1.remaining, 5)
    eq(p1.hasMore, true)

    const p2 = overviewSlice(many, EVENT_OVERVIEW_INITIAL + EVENT_OVERVIEW_BATCH)
    eq(p2.rows.length, 6, '追加一批 → 累计 6 条')
    eq(p2.remaining, 2, '剩余 2 条')

    const p3 = overviewSlice(many, EVENT_OVERVIEW_INITIAL + EVENT_OVERVIEW_BATCH * 2)
    eq(p3.rows.length, 8, '越界时按总数截断（不会多渲染）')
    eq(p3.remaining, 0)
    eq(p3.hasMore, false, '没有更多 → 页面显示到底文案')
  })

  it('不足首屏 / 恰好一批：原样返回、remaining=0、hasMore=false', () => {
    const { overviewSlice, EVENT_OVERVIEW_INITIAL } = OA()
    deepEq(overviewSlice([1, 2], EVENT_OVERVIEW_INITIAL), { rows: [1, 2], remaining: 0, hasMore: false })
    deepEq(overviewSlice([1, 2, 3], EVENT_OVERVIEW_INITIAL), { rows: [1, 2, 3], remaining: 0, hasMore: false })
  })

  it('空态 / 脏输入不抛：空数组、null、非数组、非法 shown / batch 都被兜住', () => {
    const { overviewSlice, EVENT_OVERVIEW_INITIAL, EVENT_OVERVIEW_BATCH } = OA()
    deepEq(overviewSlice([], EVENT_OVERVIEW_INITIAL), { rows: [], remaining: 0, hasMore: false }, '空态')
    deepEq(overviewSlice(null, EVENT_OVERVIEW_INITIAL), { rows: [], remaining: 0, hasMore: false })
    deepEq(overviewSlice('not-array', EVENT_OVERVIEW_INITIAL), { rows: [], remaining: 0, hasMore: false })

    eq(overviewSlice([1, 2, 3, 4, 5], NaN).rows.length, EVENT_OVERVIEW_BATCH, 'shown 非法 → 退回一个批次')
    eq(overviewSlice([1, 2, 3, 4, 5], 2, 0).rows.length, 2, 'batch 非法不影响 shown 切片')
    eq(overviewSlice([1, 2, 3, 4, 5], -1).rows.length, EVENT_OVERVIEW_BATCH, 'shown 为负 → 退回一个批次')
  })
})

/* ───────────────────── 2. 与会员态无关（回归锁） ───────────────────── */

describe('概要卡：首屏条数与会员态无关（回归锁）', () => {
  it('overviewSlice 不接收会员入参：同样 200 条，任何调用都只返回固定首屏 —— 概要卡不按会员档放全', () => {
    const { overviewSlice, EVENT_OVERVIEW_INITIAL, detailLimit } = OA()
    const many = Array.from({ length: 200 }, (_, i) => i)
    /* 概要卡没有「会员 → 全部」这条路径：函数入参只有 items / shown / batch（batch 有默认值） */
    eq(overviewSlice.length, 2, 'fn.length=2（items, shown），不存在 isMember 入参')
    eq(overviewSlice(many, EVENT_OVERVIEW_INITIAL).rows.length, 3, '200 条也只放 3 条')
    /* 对照：会员明细口径仍是「不截断」（detailLimit(true) === null）—— 那是留给明细页 / 时间线的，概要卡刻意不用 */
    eq(detailLimit(true), null, '会员明细口径仍是「全部」，但它不作用于概要卡')
  })

  it('舆情页静态：概要卡走 overviewSlice，不把 isMember 喂给概要切片，也不再用 sliceDetail / moreDetailNote', () => {
    const page = read('pages/opinion/index.tsx')
    ok(page.includes('overviewSlice('), '概要卡应走 overviewSlice')
    ok(page.includes('EVENT_OVERVIEW_INITIAL') && page.includes('EVENT_OVERVIEW_BATCH'), '应引用首屏 / 批次常量')
    notOk(/overviewSlice\([^)]*isMember/.test(page), '概要切片不得按会员态决定条数')
    notOk(/sliceDetail\([^)]*isMember/.test(page), '概要卡不得再用按会员档放全的 sliceDetail')
    notOk(page.includes('moreDetailNote('), '概要卡不得再用「会员可见全部 N 条」明细提示')
    notOk(page.includes('isMember'), '概要不分档 → 本页不应再出现 isMember')
  })
})

/* ───────────────────── 3. 页面交互（静态） ───────────────────── */

describe('概要卡：加载更多 / 到底 / 总数（页面静态约束）', () => {
  const page = read('pages/opinion/index.tsx')
  const scss = read('pages/opinion/index.scss')

  it('头部显示事件总数（不让人以为只有首屏 3 条）', () => {
    ok(page.includes('事件时间线 · ${events.length} 件事'), '事件卡标题应显示事件总数')
  })

  it('底部「加载更多（还有 N 条）」→ 追加一批；没有更多显示到底文案', () => {
    ok(page.includes('加载更多事件'), '缺「加载更多」入口')
    ok(page.includes('还有 {eventSlice.remaining} 条'), '缺剩余条数提示')
    ok(page.includes('—— 没有更多事件 ——'), '缺到底文案')
    ok(page.includes('loadMoreEvents'), '缺加载更多的处理函数')
    ok(page.includes('eventSlice.hasMore'), '应以 hasMore 分支「加载更多 / 到底」')
  })

  it('既有的空态 / 加载态与其它块不受影响（不含第四处 status:error）', () => {
    ok(page.includes('暂无可归并的事件'), '空态文案仍在')
    ok(page.includes('正在归并事件'), '加载态文案仍在')
    ok(page.includes('pickDailyFocus(') && page.includes('buildOpinionQueue('), '今日要点 / 统一队列未被替换')
    notOk(page.includes('sliceDetail('), '本页三张概要卡都不再用 sliceDetail（明细分档只留在时间线页）')
    ok(scss.includes('&__done'), '缺到底文案样式钩子')
  })
})

/* ─────────────── 4. 三张概要卡「统一按需加载」（静态回归锁） ─────────────── */

describe('三张概要卡统一按需加载（事件 / 关注动态 / 关键词预警）', () => {
  const page = read('pages/opinion/index.tsx')

  it('三处都走同一套 overviewSlice + EVENT_OVERVIEW_*（首屏 / 批次常量共用，不另造切片）', () => {
    /* 三张概要卡各调用一次 overviewSlice（事件 / 关注动态 / 关键词预警）—— 共用同一函数，别留两套 */
    eq((page.match(/overviewSlice\(/g) || []).length, 3, '三张概要卡应各走一次 overviewSlice')
    ok(page.includes('overviewSlice(events,'), '事件卡走 overviewSlice')
    ok(page.includes('overviewSlice(feed.items,'), '关注动态卡走 overviewSlice')
    ok(page.includes('overviewSlice(alerts.items,'), '关键词预警卡走 overviewSlice')
    /* 首屏 / 批次常量三处共用（三处 useState 初值 + 三处「加载更多」都取这两个常量） */
    eq((page.match(/useState\(EVENT_OVERVIEW_INITIAL\)/g) || []).length, 3, '三处首屏都用 EVENT_OVERVIEW_INITIAL')
    eq((page.match(/n \+ EVENT_OVERVIEW_BATCH/g) || []).length, 3, '三处「加载更多」都按 EVENT_OVERVIEW_BATCH 追加')
  })

  it('三张卡各自的「加载更多（还有 N 条）」/ 到底文案 / hasMore 分支齐全', () => {
    for (const [name, slice] of [['事件', 'eventSlice'], ['动态', 'feedSlice'], ['预警', 'alertSlice']]) {
      ok(page.includes(`加载更多${name}`), `缺「加载更多${name}」入口`)
      ok(page.includes(`还有 {${slice}.remaining} 条`), `缺 ${name} 剩余条数提示`)
      ok(page.includes(`—— 没有更多${name} ——`), `缺 ${name} 到底文案`)
      ok(page.includes(`${slice}.hasMore`), `${name}卡应以 hasMore 分支「加载更多 / 到底」`)
    }
    ok(page.includes('loadMoreEvents') && page.includes('loadMoreFeed') && page.includes('loadMoreAlerts'), '缺三处加载更多处理函数')
  })

  it('三张卡头部各自显示总数 / 计数（不因按需加载丢掉已有信息）', () => {
    ok(page.includes('🧩 事件时间线 · ${events.length} 件事'), '事件卡显示事件总数')
    ok(page.includes('近期 {feed.entryCount} 条'), '关注动态卡显示近期条数（总数）')
    ok(page.includes('已关注 {feed.followCount} 人'), '关注动态卡保留关注人数')
    ok(page.includes('监测 {alerts.keywordCount} 个词'), '预警卡保留监测词数')
    ok(page.includes('相关报道 {alerts.items.length} 条'), '预警卡显示列表总数')
    ok(page.includes('风险信号 {alerts.riskCount} 条'), '预警卡保留风险信号数')
  })

  it('回归锁：三张概要卡一律不按会员档放全（无 sliceDetail/moreDetailNote/isMember 渲染路径）', () => {
    notOk(/sliceDetail\(/.test(page), '概要列表不得再走 sliceDetail')
    notOk(page.includes('moreDetailNote('), '概要卡不得再用「会员可见全部 N 条」明细提示')
    notOk(page.includes('isMember'), '概要不分档 → 本页不应再出现 isMember')
    /* 空态仍在（三张卡各自的空态文案） */
    ok(page.includes('关注的人暂无公开动态'), '关注动态空态仍在')
    ok(page.includes('已开始监测，暂无相关报道'), '预警空态仍在')
  })
})
