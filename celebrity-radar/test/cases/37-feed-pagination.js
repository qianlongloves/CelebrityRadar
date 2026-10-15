'use strict'

/**
 * 关注动态页（`pages/feed`）**分页加载**（2026-10-13）—— 首屏只加载第一页、触底追加。
 *
 * 背景：从舆情页「📡 关注动态 → 查看全部 ›」进入的这个**完整页**此前一次渲染全部关注动态。
 * 数据一次取回全部（`cache.ts#getFeedDetails` 一次 `in` 查询批量读全部人的 `feed_cache`），
 * 故分页只能是**客户端分段渲染**（与事件时间线页同一取舍）：
 *   · 首屏只渲染第一页（每页 `FEED_PAGE_SIZE` 条）；
 *   · 触底（`useReachBottom`）追加下一页；
 *   · 下拉刷新 / 抓取 / 重试**重取数据并回到第一页**；筛选切换（含空态「查看全部」）也回到第一页。
 *
 * 复用而非另造：切片纯函数与每页条数**复用并轻微泛化** `utils/opinion-access.ts` 的
 * `pageSlice`（本轮给它补了 `remaining` 字段，供「还有 N 条」文案；事件时间线页不受影响）+
 * 新增 `FEED_PAGE_SIZE`（真源在 opinion-access，页面与用例共用）—— 不新写第三套切片函数。
 *
 * 钉住：
 *   1. `FEED_PAGE_SIZE` = 10、`pageSlice` 纯函数：累计切片 / 最后一页不足 / 空数据 / 页数计算 /
 *      越界钳制 / **剩余数与到底判定**；
 *   2. 静态断言：列表渲染 `paged.rows`（首屏第一页）、`useReachBottom` 触底追加、
 *      触底不伪造 loading、头部给出总规模；
 *   3. 下拉刷新 / 抓取共用 `load`（`setPage(1)`）；筛选切换 `setPage(1)`。
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

/* ───────────────────── 1. FEED_PAGE_SIZE + pageSlice 纯函数 ───────────────────── */

describe('关注动态分页：FEED_PAGE_SIZE 与 pageSlice 纯函数', () => {
  it('每页固定 10 条（真源 FEED_PAGE_SIZE），pageSlice 按页长切片', () => {
    const { FEED_PAGE_SIZE, pageSlice } = OA()
    eq(FEED_PAGE_SIZE, 10, '每页固定 10 条')

    const rows = Array.from({ length: 25 }, (_, i) => i)
    const p1 = pageSlice(rows, 1, FEED_PAGE_SIZE)
    eq(p1.rows.length, 10, '第 1 页 10 条（累计）')
    eq(p1.page, 1)
    eq(p1.pageCount, 3, '25 条 → 3 页')
  })

  it('累计切片：第 1 / 2 页分别 10 / 20 条且还有更多，第 3 页 25 条到底', () => {
    const { FEED_PAGE_SIZE, pageSlice } = OA()
    const rows = Array.from({ length: 25 }, (_, i) => i)

    const p1 = pageSlice(rows, 1, FEED_PAGE_SIZE)
    eq(p1.rows.length, 10)
    eq(p1.hasMore, true)
    eq(p1.remaining, 15, '剩余 15 条')

    const p2 = pageSlice(rows, 2, FEED_PAGE_SIZE)
    eq(p2.rows.length, 20, '触底追加 → 累计 20 条')
    eq(p2.hasMore, true)
    eq(p2.remaining, 5, '剩余 5 条')

    const p3 = pageSlice(rows, 3, FEED_PAGE_SIZE)
    eq(p3.rows.length, 25, '最后一页不足也全部给出（累计 25 条）')
    eq(p3.hasMore, false, '到底 → 没有更多')
    eq(p3.remaining, 0, '到底 → 剩余 0（页面显示到底文案）')
    deepEq(p3.rows, rows, '累计行与原始数组一致')
  })

  it('每页 N / 最后一页不足 / 页数计算（整除与仅差一条两种边界）', () => {
    const { FEED_PAGE_SIZE, pageSlice } = OA()

    /* 恰好整除：2 页，最后一页刚好满 */
    const twenty = Array.from({ length: 20 }, (_, i) => i)
    eq(pageSlice(twenty, 1, FEED_PAGE_SIZE).pageCount, 2, '20 条 → 2 页')
    const lastFull = pageSlice(twenty, 2, FEED_PAGE_SIZE)
    eq(lastFull.rows.length, 20)
    eq(lastFull.remaining, 0)
    eq(lastFull.hasMore, false)

    /* 仅差一条到页边界：仍算 3 页，最后一页只有 1 条也要给全 */
    const twentyOne = Array.from({ length: 21 }, (_, i) => i)
    eq(pageSlice(twentyOne, 1, FEED_PAGE_SIZE).pageCount, 3, '21 条 → 3 页（末页 1 条）')
    const tail = pageSlice(twentyOne, 3, FEED_PAGE_SIZE)
    eq(tail.rows.length, 21, '末页只有 1 条也全部给出')
    eq(tail.hasMore, false)
  })

  it('空数据 / 非数组 / 越界页号：不抛、空行、pageCount 0、剩余 0、页号钳制', () => {
    const { FEED_PAGE_SIZE, pageSlice } = OA()
    for (const bad of [[], null, undefined, 'not-array']) {
      const r = pageSlice(bad, 1, FEED_PAGE_SIZE)
      deepEq(r.rows, [], '空 → 空行')
      eq(r.hasMore, false)
      eq(r.remaining, 0)
      eq(r.page, 1)
      eq(r.pageCount, 0, '空数据页数为 0')
    }

    const rows = Array.from({ length: 25 }, (_, i) => i)
    const over = pageSlice(rows, 99, FEED_PAGE_SIZE)
    eq(over.page, 3, '超过总页数 → 钳到最后一页')
    eq(over.rows.length, 25)
    eq(over.hasMore, false)

    const zero = pageSlice(rows, 0, FEED_PAGE_SIZE)
    eq(zero.page, 1, '非正整数页号 → 视作第 1 页')
    eq(zero.rows.length, 10)
  })
})

/* ───────────────────── 2. 页面交互（静态锁定「首屏一页 + 触底追加」） ───────────────────── */

describe('关注动态页：首屏只渲染第一页 + 触底追加（静态锁定）', () => {
  const page = read('package/feed/index.tsx')
  const scss = read('package/feed/index.scss')
  const cfg = read('package/feed/index.config.ts')

  it('分页复用共享的 pageSlice + FEED_PAGE_SIZE，页面内不自造切片函数', () => {
    ok(page.includes("from '@/utils/opinion-access'"), '应从 opinion-access 复用分页纯函数')
    ok(page.includes('pageSlice('), '应走共享的 pageSlice')
    ok(page.includes('FEED_PAGE_SIZE'), '每页条数应取 FEED_PAGE_SIZE')
    ok(page.includes('pageSlice(visible, page, FEED_PAGE_SIZE)'), '应对「当前筛选全量」按 FEED_PAGE_SIZE 切片')
    notOk(/function\s+\w*[Ss]lice/.test(page), '页面内不得自造切片函数（复用 pageSlice）')
  })

  it('首屏只渲染第一页：列表渲染 paged.rows，绝不直接渲染全量', () => {
    ok(page.includes('{paged.rows.map('), '列表应渲染分页切片（首屏即第一页）')
    notOk(page.includes('{visible.map('), '不得直接渲染当前筛选的全量（否则退化成一次渲染全部）')
    notOk(page.includes('{entries.map((e, i)'), '不得直接渲染全部 entries')
    ok(page.includes('useState(1)'), '页号 state 初值应为 1（首屏第一页）')
  })

  it('触底加载更多：useReachBottom 仅在还有下一页时前进一页', () => {
    ok(page.includes('useReachBottom('), '缺触底加载')
    ok(
      page.includes('p * FEED_PAGE_SIZE < visible.length ? p + 1 : p'),
      '触底应仅在还有下一页时前进一页，到底不动'
    )
  })

  it('触底是切片渲染（无真实网络加载）：不伪造 loading，如实区分「还有 N 条」与到底', () => {
    ok(page.includes('paged.hasMore'), '应以 hasMore 分支「还有更多 / 到底」')
    ok(page.includes('还有 ${paged.remaining} 条'), '应在到底之前显示剩余条数')
    ok(page.includes('—— 没有更多动态 ——'), '缺到底文案')
    ok(page.includes('page-feed__foot'), '缺触底状态行的样式钩子')
    ok(scss.includes('&__foot'), '缺 __foot 样式')
    notOk(page.includes('showNavigationBarLoading'), '切片渲染不该伪造加载态')
  })

  it('头部给出总规模（已关注 N 人 / 近期 M 条 + 当前筛选全量条数）', () => {
    ok(page.includes('{follows.length} 人'), '缺「已关注 N 人」')
    ok(page.includes('{entries.length} 条'), '缺「近期 M 条」')
    ok(page.includes('{visible.length} 条'), '标题条数取当前筛选全量（不是已渲染的一页），避免误以为只有第一页')
  })

  it('下拉刷新保留原语义（重取数据）并回到第一页；抓取按钮走同一路径', () => {
    ok(page.includes('usePullDownRefresh('), '缺下拉刷新')
    ok(page.includes('const load = async (withSkeleton = true, resetPage = false)'), '下拉 / 抓取应共用 load')
    ok(page.includes('refreshAllFeeds('), '下拉刷新仍要联网重取数据（既有语义不变）')
    /* 只有显式重取（下拉 / 抓取）才 setPage(1)；从子页返回的重读保留页号 */
    ok(/if \(resetPage\) setPage\(1\)/.test(page), '仅当显式重取时才回到第一页')
    ok(page.includes('await load(false, true)'), '显式抓取（doFetch）应要求重置页号（load(false, true)）')
  })

  it('从子页返回不重置页号（「返回即回顶」修复）：useDidShow 重取数据但保留页号', () => {
    /* 只取 useDidShow 回调块本身判断，避免把后面的 doFetch（load(false, true)）误算进来 */
    const didShow = (page.match(/useDidShow\(\(\) => \{[\s\S]*?\n  \}\)/) || [''])[0]
    ok(didShow.includes('void load(snapshot === null)'), 'useDidShow 应重取数据但保留页号')
    notOk(/load\([^)]*,\s*true/.test(didShow), 'useDidShow 不得重置页号')
  })

  it('筛选切换重置到第一页（含空态「查看全部」动作）', () => {
    ok(/const onFilterChange[\s\S]{0,400}setPage\(1\)/.test(page), '筛选切换应 setPage(1)，否则会像「筛完只剩一批」')
    ok(
      /actionText='查看全部'[\s\S]{0,220}setPage\(1\)/.test(page),
      '筛选后空态的「查看全部」也应回到第一页'
    )
  })

  it('页面配置开启下拉刷新与触底距离', () => {
    ok(cfg.includes('enablePullDownRefresh: true'), '下拉刷新需在 config 开启')
    ok(cfg.includes('onReachBottomDistance'), '触底加载需配置触底距离')
  })
})

/* ───────────────────── 3. 既有功能不退化（回归锁） ───────────────────── */

describe('关注动态页：分页不改动既有功能（回归锁）', () => {
  const page = read('package/feed/index.tsx')

  it('仍走批量读、仍有快照首帧与 finally 收 loading（P 既有约束不回退）', () => {
    ok(page.includes('getFeedDetails('), '仍走批量读')
    notOk(/getFeedDetail\(/.test(page), '不得退回逐人读')
    ok(page.includes('snapshot?.entries ?? []'), '快照首帧仍在')
    ok(page.includes('} finally {'), 'loading 仍在 finally 收掉')
  })

  it('按人物筛选（面板）/ 今日标记 / 空态 / 错误态 / 免责声明都还在', () => {
    /* 2026-10-15 重设计：人物筛选由顶卡里的 `<Picker>` 下拉改为**底部筛选面板**里的
       「人物」多选组（与时间档、领域同面板）。断言随之改为钉住面板的两个承重结构：
       面板容器本身 + 触发它的「筛选」按钮；`<Picker>` 不再存在，故此处不再断言它。 */
    ok(page.includes("className='page-feed__sheet'"), '按人物筛选的底部面板仍在')
    ok(page.includes('page-feed__filter'), '筛选入口按钮仍在')
    ok(page.includes('onFilterChange'), '筛选回调仍在')
    ok(page.includes("isToday(e.publishedDate)"), '「今日」新内容标记仍在')
    ok(page.includes('EmptyState'), '空态仍在')
    ok(page.includes('failedCount > 0'), '读取失败提示仍在')
    ok(page.includes('动态内容来自公开网络检索，由 AI 整理，仅供参考'), '免责声明仍在')
  })
})
