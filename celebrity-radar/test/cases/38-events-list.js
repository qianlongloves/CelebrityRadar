'use strict'

/**
 * 事件列表页（`pages/events`，2026-10-13）—— 舆情页事件卡「查看全部事件 ›」的落点。
 *
 * 背景（用户诉求）：舆情台上的「事件时间线」卡此前是「固定首屏 + 卡内加载更多」，于是
 * **页内越加载越长**。本轮把「看全部」挪到本页：舆情页事件卡只留固定 3 条预览 + 入口，本页
 * 做**分页加载**（首屏第一页 + 触底追加 + 下拉刷新回第一页）。
 *
 * 钉住：
 *   1. 页面已注册、**不是 tab 页**（`.safe-bottom` 而非 `.safe-tab`），标题 / 下拉刷新 / 触底距离齐备；
 *   2. **分页纯函数**：`EVENTS_PAGE_SIZE` = 10、`pageSlice` 累计切片 / 最后一页不足 / 到底判定 / 空数据；
 *   3. 静态断言：首屏只渲染第一页（`paged.rows`）、`useReachBottom` 触底追加、不伪造 loading；
 *   4. 数据来源复用既有 utils（落库优先 + 本端聚类降级），**不另写读库代码**；读失败有**错误态**不是白屏；
 *   5. 下拉刷新重取并回到第一页；每条事件整卡跳单事件时间线页（带 encode 的 eventKey + title）；
 *      已读 / 跟进按钮 stopPropagation，不与整卡点击冲突；
 *   6. 舆情页两张卡**不再出现「加载更多」**、各自入口指向 `pages/events` / `pages/feed`（回归锁）。
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

/* ───────────────────── 1. 页面注册与非 tab 约束 ───────────────────── */

describe('事件列表页：已注册且不是 tab 页（静态约束）', () => {
  const appConfig = read('app.config.ts')
  const page = read('pages/events/index.tsx')
  const config = read('pages/events/index.config.ts')
  const scss = read('pages/events/index.scss')

  it('app.config 的 pages 注册了 pages/events/index', () => {
    const pages = appConfig.slice(appConfig.indexOf('pages: ['), appConfig.indexOf(']', appConfig.indexOf('pages: [')))
    ok(pages.includes("'pages/events/index'"), 'pages/events/index 必须注册，否则入口跳转打不开')
  })

  it('不是 tab 页：tabBar.list 里没有它，页面用 .safe-bottom 而非 .safe-tab', () => {
    const tab = appConfig.slice(appConfig.indexOf('tabBar:'))
    const start = tab.indexOf('list: [')
    const tabBarList = tab.slice(start, tab.indexOf(']', start))
    notOk(tabBarList.includes('pages/events/index'), '事件列表页不是 tab，不应进 tabBar.list')

    ok(page.includes('safe-bottom'), '非 tab 页底部预留用 .safe-bottom')
    notOk(page.includes('safe-tab'), '非 tab 页不得用 .safe-tab（那是给悬浮底栏留空间的）')
  })

  it('导航栏标题为「事件」，开启下拉刷新与触底距离，样式文件以 .page-events 起头', () => {
    ok(config.includes("navigationBarTitleText: '事件'"), '导航栏标题应为「事件」')
    ok(config.includes('enablePullDownRefresh: true'), '要开启下拉刷新')
    ok(config.includes('onReachBottomDistance'), '要设置触底距离（触底加载更多）')
    ok(scss.includes('.page-events'), '样式文件缺失或未以 .page-events 起头')
  })
})

/* ───────────────────── 2. 数据来源：复用既有 utils + 降级 ───────────────────── */

describe('事件列表页：同舆情页事件卡同一套读取口径（不另写读库代码）', () => {
  const page = read('pages/events/index.tsx')

  it('复用既有 utils：opinion-store / opinion-events / opinion-access', () => {
    for (const imp of [
      "from '@/utils/opinion-store'",
      "from '@/utils/opinion-events'",
      "from '@/utils/opinion-access'"
    ]) {
      ok(page.includes(imp), `事件列表页应复用 ${imp}`)
    }
    ok(page.includes('loadStoredEvents('), '读落库事件应走 loadStoredEvents')
    ok(page.includes('resolveDisplayEvents('), '落库优先 + 降级应走 resolveDisplayEvents')
    ok(page.includes('buildOpinionEvents('), '降级应回落 buildOpinionEvents（与舆情页同一套聚类）')
    ok(page.includes('loadEventStatus('), '读我的状态应走 loadEventStatus')
  })

  it('不另写读库 / 聚类 / 切片代码', () => {
    notOk(/function\s+sameEvent/.test(page), '页面不得另写一套聚类判据')
    notOk(/function\s+\w*[Ss]lice/.test(page), '页面不得自造切片函数（复用 opinion-access#pageSlice）')
    ok(page.includes('pageSlice('), '分页应走共享的 pageSlice')
  })

  it('读失败有明确错误态（可重试），不是白屏', () => {
    ok(page.includes("setStatus('error')") || page.includes("'error'"), '缺「读取失败」分支')
    ok(page.includes('事件读取失败'), '缺错误态文案')
    ok(page.includes('点此重试'), '错误态要能重试')
    notOk(/showModal/.test(page), '不引入弹窗（沿用克制的行内提示）')
  })
})

/* ───────────────────── 3. 分页：EVENTS_PAGE_SIZE + pageSlice 纯函数 ───────────────────── */

describe('事件列表页分页：EVENTS_PAGE_SIZE 与 pageSlice 纯函数', () => {
  it('每页固定 10 条（真源 EVENTS_PAGE_SIZE），pageSlice 按页长切片', () => {
    const { EVENTS_PAGE_SIZE, pageSlice } = OA()
    eq(EVENTS_PAGE_SIZE, 10, '每页固定 10 条（与 feed 页 / 时间线页同档）')

    const rows = Array.from({ length: 25 }, (_, i) => i)
    const p1 = pageSlice(rows, 1, EVENTS_PAGE_SIZE)
    eq(p1.rows.length, 10, '第 1 页 10 条（累计）')
    eq(p1.page, 1)
    eq(p1.pageCount, 3, '25 条 → 3 页')
  })

  it('首屏一页 / 触底追加 / 最后一页不足 / 到底判定', () => {
    const { EVENTS_PAGE_SIZE, pageSlice } = OA()
    const rows = Array.from({ length: 25 }, (_, i) => i)

    const p1 = pageSlice(rows, 1, EVENTS_PAGE_SIZE)
    eq(p1.rows.length, 10, '首屏只渲染第一页')
    eq(p1.hasMore, true)
    eq(p1.remaining, 15, '剩余 15 条')

    const p2 = pageSlice(rows, 2, EVENTS_PAGE_SIZE)
    eq(p2.rows.length, 20, '触底追加 → 累计 20 条')
    eq(p2.hasMore, true)

    const p3 = pageSlice(rows, 3, EVENTS_PAGE_SIZE)
    eq(p3.rows.length, 25, '最后一页不足也全部给出（累计 25 条）')
    eq(p3.hasMore, false, '到底 → 没有更多')
    eq(p3.remaining, 0, '到底 → 剩余 0（页面显示到底文案）')
    deepEq(p3.rows, rows, '累计行与原始数组一致')
  })

  it('空数据 / 非数组：不抛、空行、pageCount 0、页号钳制', () => {
    const { EVENTS_PAGE_SIZE, pageSlice } = OA()
    for (const bad of [[], null, undefined, 'not-array']) {
      const r = pageSlice(bad, 1, EVENTS_PAGE_SIZE)
      deepEq(r.rows, [], '空 → 空行')
      eq(r.hasMore, false)
      eq(r.page, 1)
      eq(r.pageCount, 0, '空数据页数为 0')
    }

    const rows = Array.from({ length: 25 }, (_, i) => i)
    const over = pageSlice(rows, 99, EVENTS_PAGE_SIZE)
    eq(over.page, 3, '超过总页数 → 钳到最后一页')
    eq(over.rows.length, 25)
    eq(over.hasMore, false)
  })
})

/* ───────────────────── 4. 页面分页交互（静态锁定） ───────────────────── */

describe('事件列表页：首屏只渲染第一页 + 触底追加（静态锁定）', () => {
  const page = read('pages/events/index.tsx')
  const scss = read('pages/events/index.scss')

  it('首屏只渲染第一页：渲染 paged.rows，绝不直接渲染全量', () => {
    ok(page.includes('pageSlice(events, page, EVENTS_PAGE_SIZE)'), '应对全量事件按 EVENTS_PAGE_SIZE 切片')
    ok(page.includes('{paged.rows.map('), '列表应渲染分页切片（首屏即第一页）')
    notOk(page.includes('{events.map((ev)'), '不得直接渲染全量事件（否则退化成一次渲染全部）')
    ok(page.includes('useState(1)'), '页号 state 初值应为 1（首屏第一页）')
  })

  it('触底加载更多：useReachBottom 仅在还有下一页时前进一页', () => {
    ok(page.includes('useReachBottom('), '缺触底加载')
    ok(
      page.includes('p * EVENTS_PAGE_SIZE < events.length ? p + 1 : p'),
      '触底应仅在还有下一页时前进一页，到底不动'
    )
  })

  it('切片渲染（无真实网络加载）：不伪造 loading，如实区分「还有 N 条」与到底', () => {
    ok(page.includes('paged.hasMore'), '应以 hasMore 分支「还有更多 / 到底」')
    ok(page.includes('还有 ${paged.remaining} 条'), '应在到底之前显示剩余条数')
    ok(page.includes('—— 没有更多事件 ——'), '缺到底文案')
    ok(page.includes('page-events__foot'), '缺触底状态行的样式钩子')
    ok(scss.includes('&__foot'), '缺 __foot 样式')
    notOk(page.includes('showNavigationBarLoading'), '切片渲染不该伪造加载态')
  })

  it('下拉刷新重取数据并回到第一页；从子页返回不重置页号（「返回即回顶」修复）', () => {
    ok(page.includes('usePullDownRefresh('), '缺下拉刷新')
    ok(page.includes('Taro.stopPullDownRefresh()'), '下拉刷新结束要收起原生指示器')
    /* 下拉刷新 = 显式重取 → load(true) 回到第一页 */
    ok(page.includes('await load(true)'), '下拉刷新应显式要求重置页号（load(true)）')
    ok(/const load = useCallback\(\s*async \(resetPage = false\)/.test(page), 'load 应带 resetPage 参数、默认不重置')
    ok(/if \(resetPage\) setPage\(1\)/.test(page), '仅当显式要求时才回到第一页')
    /* useDidShow（含从子页返回）重取数据但**不**重置页号 —— 保住用户翻到的位置。
       只取 useDidShow 回调块本身来判断，避免把紧随其后的 usePullDownRefresh 里的 load(true) 误算进来。 */
    const didShow = (page.match(/useDidShow\(\(\) => \{[\s\S]*?\n  \}\)/) || [''])[0]
    ok(didShow.includes('void load()'), 'useDidShow 应重取数据（load() 不重置页号）')
    notOk(/load\([^)]*true/.test(didShow), 'useDidShow 不得重置页号（否则返回即回顶）')
    /* 仍不闪加载态：已有列表时保留内容，避免滚动位置被顶回顶部 */
    ok(page.includes('loadedRef'), '应有「是否已载入」标记，避免返回重进时列表塌陷')
  })

  it('每页条数取共享常量 EVENTS_PAGE_SIZE（不写死数字）', () => {
    ok(page.includes('EVENTS_PAGE_SIZE'), '每页条数应取 EVENTS_PAGE_SIZE')
    ok(page.includes("from '@/utils/opinion-access'"), '应从 opinion-access 复用分页纯函数与常量')
  })
})

/* ───────────────────── 5. 每条事件跳单事件时间线页 + 卡内按钮不冲突 ───────────────────── */

describe('事件列表页：整卡跳事件时间线页（带 encode 参数）', () => {
  const page = read('pages/events/index.tsx')

  it('整卡跳 /pages/event/index，带 encode 过的 eventKey + title', () => {
    ok(page.includes('/pages/event/index'), '每条事件应跳单事件时间线页')
    ok(page.includes('Taro.navigateTo'), '跳转用 navigateTo')
    ok(
      page.includes('eventKey=${encodeURIComponent(ev.key)}&title=${encodeURIComponent(ev.title)}'),
      'eventKey 与 title 必须 encode 后带上'
    )
  })

  it('已读 / 跟进按钮 stopPropagation，不与整卡点击冲突', () => {
    ok(page.includes('e.stopPropagation()'), '卡内按钮应 stopPropagation')
    ok(page.includes('markEventRead(') || page.includes('markRead('), '缺标记已读')
    ok(page.includes('setEventFollow(') || page.includes('toggleFollow('), '缺跟进切换')
    ok(page.includes('eventNewness(') && page.includes('newnessLabel('), '缺「新事件」角标判定')
  })

  it('保留「聚合 ≠ 认定」的克制说明', () => {
    ok(/不代表平台已核实/.test(page), '要有「聚合不等于认定」的轻量说明')
    ok(page.includes('官方通报') && page.includes('媒体报道'), '要能看出来源性质（区分报道与官方通报）')
  })
})

/* ───────────────────── 6. 舆情页三卡改入口（回归锁） ───────────────────── */

describe('舆情页三张卡：不再「加载更多」，改为跳独立页的入口（回归锁）', () => {
  const page = read('pages/opinion/index.tsx')

  it('事件卡 / 关注动态卡 / 关键词预警卡都不再出现「加载更多」相关文案与处理函数', () => {
    for (const dead of [
      '加载更多事件',
      '加载更多动态',
      '加载更多预警',
      'loadMoreEvents',
      'loadMoreFeed',
      'loadMoreAlerts',
      'eventShownCount',
      'feedShownCount',
      'alertShownCount',
      '—— 没有更多事件 ——',
      '—— 没有更多动态 ——',
      '—— 没有更多预警 ——'
    ]) {
      notOk(page.includes(dead), `舆情页不得再出现「${dead}」`)
    }
  })

  it('三张卡各自的跳转目标正确：事件 → pages/events；关注动态 → pages/feed；预警 → pages/alerts', () => {
    ok(page.includes("Taro.navigateTo({ url: '/pages/events/index' })"), '事件卡入口应指向 pages/events')
    ok(page.includes("Taro.navigateTo({ url: '/pages/feed/index' })"), '关注动态卡应指向已存在的 pages/feed')
    ok(page.includes("Taro.navigateTo({ url: '/pages/alerts/index' })"), '预警卡应指向已存在的 pages/alerts')
  })

  it('每条事件仍可点进 pages/event（既有能力不丢）', () => {
    ok(page.includes('/pages/event/index'), '舆情页事件卡仍应能点进单事件时间线页')
    ok(page.includes('eventKey=${encodeURIComponent(ev.key)}'), 'eventKey 必须 encode 后带上')
  })
})
