'use strict'

/**
 * 舆情页概要卡「固定首屏 + 按需加载」（P6，2026-10-13）与
 * 「两张卡去掉页内加载更多、改为入口」（P7，2026-10-13）。
 *
 * P6 背景：事件 / 关注动态 / 关键词预警三张概要卡此前走 `sliceDetail(<items>, isMember)`，
 * 会员档「全部」→ 概要列表按明细口径把整库一次渲染。故改为**固定首屏 3 条 + 「加载更多」**、
 * **与会员态无关**（概要不分档）；会员的明细分层仍作用在单个事件的**时间线**上（pages/event）。
 *
 * P7 背景（用户诉求「不要在舆情台加载更多，新建页面点击跳转、分页加载」）：
 *   · **事件卡 / 关注动态卡不再页内「加载更多」** —— 只给固定预览（`overviewSlice(<items>, EVENT_OVERVIEW_INITIAL)`，
 *     即 3 条），改为入口跳独立页：事件 → `pages/events`、关注动态 → `pages/feed`
 *     （复用卡头既有的「查看全部 ›」）。这样数据再多两卡长度也恒定，不会把页面撑长。
 *   · **关键词预警卡**后于 2026-10-13 一并统一：同样固定预览 3 条、移除页内「加载更多 / 到底」，
 *     入口在卡头右上角（同类名 `page-opinion__more`、同文案「查看全部 ›」）→ `pages/alerts`。
 *
 * 钉住：
 *   1. `overviewSlice` 纯函数：累计行数 / 剩余数 / hasMore 的边界（空、不足、跨批、越界、脏输入）；
 *   2. 概要卡首屏条数**与会员态无关**（overviewSlice 不含会员入参；页面不把 isMember 喂给它）；
 *   3. 静态断言：三张概要卡**都**走 `overviewSlice`（三处调用），**都不再用**按会员档放全的
 *      `sliceDetail` / `moreDetailNote`；头部各自显示总数 / 计数；
 *   4. **三张卡都无「加载更多」（回归锁）**、卡头都有跳独立页的入口（同类名 `page-opinion__more`）。
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
    ok(page.includes('EVENT_OVERVIEW_INITIAL'), '应引用固定预览条数常量')
    notOk(/overviewSlice\([^)]*isMember/.test(page), '概要切片不得按会员态决定条数')
    notOk(/sliceDetail\([^)]*isMember/.test(page), '概要卡不得再用按会员档放全的 sliceDetail')
    notOk(page.includes('moreDetailNote('), '概要卡不得再用「会员可见全部 N 条」明细提示')
    notOk(page.includes('isMember'), '概要不分档 → 本页不应再出现 isMember')
  })
})

/* ───────────────────── 3. 页面交互（静态） ───────────────────── */

describe('概要卡：预览 / 入口 / 总数（页面静态约束）', () => {
  const page = read('pages/opinion/index.tsx')
  const scss = read('pages/opinion/index.scss')

  it('事件卡头部显示事件总数（不让人以为只有首屏 3 条）', () => {
    ok(page.includes('事件时间线 · ${events.length} 件事'), '事件卡标题应显示事件总数')
  })

  it('事件卡不再页内「加载更多」：只给固定预览，入口移到卡头右上角（与关注动态卡同款）', () => {
    /* 原口径「卡内加载更多事件」已废弃，这里改为钉新口径（不是弱化：加载更多改为**禁止出现**） */
    notOk(page.includes('加载更多事件'), '事件卡不得再有页内「加载更多」')
    notOk(page.includes('loadMoreEvents'), '不得保留事件卡的加载更多处理函数')
    notOk(page.includes('eventSlice'), '事件卡不再有「按需增长」的切片')
    ok(page.includes('eventPreview'), '事件卡应走固定预览（overviewSlice(visibleEvents, EVENT_OVERVIEW_INITIAL)）')
    /* 入口从卡底（「查看全部事件 ›」）改为卡头右上角，与关注动态卡同款：同类名 page-opinion__more */
    ok(
      page.includes("<Text className='page-opinion__more' onClick={goEvents}>"),
      '事件卡入口应在卡头右上角，复用关注动态卡同款类名 page-opinion__more'
    )
    notOk(page.includes('查看全部事件 ›'), '卡底「查看全部事件 ›」入口应移除')
    ok(
      page.includes("goEvents = () => void Taro.navigateTo({ url: '/package/events/index' })"),
      '入口应跳到新的事件列表页 pages/events'
    )
  })

  it('既有的空态 / 加载态与其它块不受影响（不含第四处 status:error）', () => {
    ok(page.includes('暂无可归并的事件'), '空态文案仍在')
    ok(page.includes('正在归并事件'), '加载态文案仍在')
    ok(page.includes('pickDailyFocus(') && page.includes('buildOpinionQueue('), '今日要点 / 统一队列未被替换')
    notOk(page.includes('sliceDetail('), '本页概要卡都不再用 sliceDetail（明细分档只留在时间线页）')
    notOk(scss.includes('&__done'), '到底文案样式已无任何使用点，应一并清理')
  })
})

/* ─────────────── 4. 三张卡去掉页内「加载更多」改为卡头入口（静态回归锁） ─────────────── */

describe('事件 / 关注动态 / 关键词预警三卡去掉页内「加载更多」改为卡头入口', () => {
  const page = read('pages/opinion/index.tsx')

  it('三张卡：固定预览（各 3 条），不再有「加载更多」与相关 state / 处理函数', () => {
    /* 三张概要卡各走一次 overviewSlice，shown 均固定为 EVENT_OVERVIEW_INITIAL（不再按需增长） */
    ok(page.includes('overviewSlice(visibleEvents, EVENT_OVERVIEW_INITIAL)'), '事件卡固定预览 3 条')
    ok(page.includes('overviewSlice(feed.items, EVENT_OVERVIEW_INITIAL)'), '关注动态卡固定预览 3 条')
    ok(page.includes('overviewSlice(alerts.items, EVENT_OVERVIEW_INITIAL)'), '关键词预警卡固定预览 3 条')
    for (const dead of [
      'eventShownCount',
      'feedShownCount',
      'loadMoreEvents',
      'loadMoreFeed',
      '加载更多事件',
      '加载更多动态',
      '—— 没有更多事件 ——',
      '—— 没有更多动态 ——'
    ]) {
      notOk(page.includes(dead), `三张卡不得残留「${dead}」（去掉加载更多要连 state / 文案一起清干净）`)
    }
  })

  it('三卡入口都在卡头：事件 → pages/events；关注动态 → pages/feed；预警 → pages/alerts', () => {
    ok(page.includes("Taro.navigateTo({ url: '/package/events/index' })"), '事件卡入口应指向 pages/events')
    ok(page.includes("Taro.navigateTo({ url: '/package/feed/index' })"), '关注动态卡应复用既有的 pages/feed 入口')
    ok(page.includes("Taro.navigateTo({ url: '/package/alerts/index' })"), '预警卡入口应指向已存在的 pages/alerts')
    /* 「查看全部 ›」文字入口在卡头出现 4 次（事件 / 关注动态 / 周报 / 预警）——
       三张概要卡入口形态统一（卡头右上角、同类名 page-opinion__more） */
    eq(
      (page.match(/className='page-opinion__more'/g) || []).length,
      4,
      '「查看全部 ›」卡头入口应恰好 4 个（事件 / 关注动态 / 周报 / 预警）'
    )
  })

  it('关键词预警卡（2026-10-13 一并统一）：固定预览 3 条、卡头同款入口、无页内「加载更多 / 到底」', () => {
    ok(page.includes('overviewSlice(alerts.items, EVENT_OVERVIEW_INITIAL)'), '预警卡应固定预览 3 条')
    ok(
      page.includes("<Text className='page-opinion__more' onClick={goAlerts}>"),
      '预警卡卡头入口应与事件卡 / 关注动态卡**同款**（同类名 + 同「查看全部 ›」文案）'
    )
    ok(
      page.includes("goAlerts = () => void Taro.navigateTo({ url: '/package/alerts/index' })"),
      '预警卡入口应跳已存在的预警完整页 pages/alerts'
    )
    for (const dead of [
      '加载更多预警',
      'alertSlice.hasMore',
      'alertSlice.remaining',
      'loadMoreAlerts',
      'alertShownCount',
      '—— 没有更多预警 ——',
      'page-opinion__more-detail',
      'page-opinion__done'
    ]) {
      notOk(page.includes(dead), `预警卡不得再残留「${dead}」`)
    }
    /* 统计信息保留（不因简化而丢） */
    ok(page.includes('监测 {alerts.keywordCount} 个词'), '保留「监测词数」')
    ok(page.includes('监控 {alerts.personCount} 位名人'), '保留「监控人数」')
    ok(page.includes('相关报道 {alerts.items.length} 条'), '保留「相关报道数」')
    ok(page.includes('风险信号 {alerts.riskCount} 条'), '保留「风险信号数」')
  })

  it('三卡头部仍显示总数 / 计数（不因去加载更多丢掉已有信息）', () => {
    ok(page.includes('🧩 事件时间线 · ${events.length} 件事'), '事件卡显示事件总数')
    ok(page.includes('近期 {feed.entryCount} 条'), '关注动态卡显示近期条数（总数）')
    ok(page.includes('已关注 {feed.followCount} 人'), '关注动态卡保留关注人数')
    ok(page.includes('相关报道 {alerts.items.length} 条'), '预警卡显示相关报道总数')
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
