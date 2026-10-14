'use strict'

/**
 * 舆情台首屏性能收敛 + 事件卡入口与关注动态卡统一（2026-10-13）。
 *
 * 背景：舆情台「事件时间线 / 关注动态」两张卡初始化慢。定位到的三处根因：
 *   1. 关注动态**预览**在 `Promise.all` 里等 `loadFollowWatches` —— 它为每位关注人各读
 *      report_cache + feed_cache（2N 次只读，分批并发），却只产出「新 N 条」这个角标；
 *   2. 端上聚类 `buildOpinionEvents` 写在无条件的 `useMemo([opinionInput])` 里 —— 首屏三块数据
 *      分批到达时随之重算数遍，**就算库里早有共享事件也照算不误**（要遍历 feed/weekly/alert 多源）；
 *   3. 若干只读是串行的，且 `keyword_watches` 被 `listWatches` + `loadAlerts` 各读一遍。
 *
 * 这一版把三处逐条收敛（口径不变：落库优先 / 降级 / 空态 / 错误态一字未改），并用静态断言把它钉住
 * ——这些「改了不报错、退回就变慢 / 变样」的约束，正是本文件存在的理由。
 *
 * 页面是 .tsx（不进测试编译），与既有页面用例同法读源码文本断言；`loadAlerts` 的复用行为用编译产物验证。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const BUILD = path.resolve(__dirname, '..', '.build')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

const T0 = Date.now() - 30 * 24 * 3600 * 1000
const iso = (ms) => new Date(ms).toISOString()

/** 让 isCloudConfigured 为真（与 35-inbox 同法） */
function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

/* ───────── 1. 首屏：预览不阻塞、聚类降级只在必要时发生（性能回归锁） ───────── */

describe('舆情台首屏：预览不阻塞、端上聚类降级只在必要时发生（性能回归锁）', () => {
  const page = read('pages/opinion/index.tsx')

  it('关注动态入口化：统一队列仍走批量缓存读 getFeedDetails，不再加载 loadFollowWatches', () => {
    ok(page.includes('getFeedDetails('), '统一队列 / 今日要点应走批量缓存读 getFeedDetails')
    /* P9 入口化后不再内联「关注动态预览 + 新 N 条角标」，loadFollowWatches 随卡一起移除 */
    notOk(page.includes('loadFollowWatches('), '入口化后 loadFollowWatches 应移除（角标随卡移到 feed 完整页）')
  })

  it('端上聚类（buildOpinionEvents）不在首屏无条件执行：由 storedReady 门控', () => {
    ok(page.includes('buildOpinionEvents('), '降级仍回落本端聚类')
    ok(page.includes('storedReady'), '应有「落库事件是否读完」的门控标志')
    notOk(
      /useMemo\(\(\)\s*=>\s*buildOpinionEvents\(opinionInput\)\s*,\s*\[opinionInput\]\)/.test(page),
      '不得再有无条件聚类（旧写法：随 opinionInput 每次变化就重算数遍）'
    )
    ok(/if \(!storedReady\)/.test(page), '未读完时应先渲染空、不并发聚类')
  })

  it('串行读改并行：预警分组 ∥ 风险信号；落库事件 ∥ 我的状态', () => {
    ok(
      /Promise\.all\(\[loadAlerts\(rows\),\s*loadRiskSignals\(keys\)\]\)/.test(page),
      '预警分组与风险信号应并行（此前风险信号串在预警之后）'
    )
    ok(
      /Promise\.all\(\[[\s\S]{0,200}loadStoredEvents\(\)\.catch\([\s\S]{0,160}loadEventStatus\(\)\.catch\(/.test(page),
      '落库事件与我的状态应并行（此前串行）'
    )
  })

  it('同一集合只读一次：keyword_watches 不再被 listWatches + loadAlerts 各读一遍', () => {
    ok(page.includes('loadAlerts(rows)'), '应把已读到的订阅行传给 loadAlerts，避免它内部重读 keyword_watches')
    const kw = read('utils/keyword-alert.ts')
    ok(kw.includes('preRows?: WatchRow[]'), 'loadAlerts 应新增可选入参 preRows')
    ok(kw.includes('Array.isArray(preRows) ? preRows : await listWatches()'), '传入 preRows 时不再自读')
  })
})

/* ───────── 2. 事件卡入口与关注动态卡统一（卡头右上角 · 同款类名） ───────── */

describe('事件卡入口与关注动态卡统一（卡头右上角 · 同款类名）（形态回归锁）', () => {
  const page = read('pages/opinion/index.tsx')

  it('事件卡入口在卡头右上角；关注动态/周报/预警改为页首 nav 入口按钮（不再有卡头 more）', () => {
    ok(
      page.includes("<Text className='page-opinion__more' onClick={goEvents}>"),
      '事件卡应在卡头用「查看全部 ›」文字按钮（同款类名 page-opinion__more）'
    )
    /* 事件卡的 more 必须在 head 内、head-main 之后 */
    ok(
      /<View className='page-opinion__head'>[\s\S]*?page-opinion__head-main[\s\S]*?<Text className='page-opinion__more' onClick=\{goEvents\}>/.test(page),
      '事件卡 more 应在卡头（head 内、head-main 之后）'
    )
    eq((page.match(/className='page-opinion__more'/g) || []).length, 1, '卡头「查看全部 ›」入口应只剩事件卡 1 个（其余三块改页首 nav 按钮）')
    notOk(page.includes("<Text className='page-opinion__more' onClick={goFeed}>"), '关注动态卡头入口应移除')
    ok(page.includes("className='page-opinion__nav-item' onClick={goFeed}"), '关注动态应改为页首 nav 入口按钮')
  })

  it('卡底不再有事件入口（也不再借 __more-detail 承载）', () => {
    notOk(page.includes('查看全部事件 ›'), '卡底「查看全部事件 ›」应移除')
    notOk(/page-opinion__more-detail'[^>]*onClick=\{goEvents\}/.test(page), '卡底不得再用 __more-detail 承载事件入口')
    /* 关键词预警卡的 __more-detail「加载更多」也已随三卡统一移除（该样式类在 src 内已无使用点） */
    notOk(page.includes('page-opinion__more-detail'), '三张卡都不再页内「加载更多」（__more-detail 应清理）')
  })

  it('单条事件仍整卡跳单事件时间线页 pages/event（既有能力不丢）', () => {
    ok(page.includes('onClick={() => goEvent(ev)}'), '每条事件仍应整卡跳转')
    ok(page.includes('/package/event/index?eventKey='), '单事件时间线页入口仍在')
    ok(page.includes("goEvents = () => void Taro.navigateTo({ url: '/package/events/index' })"), '「查看全部」仍指向 pages/events')
  })
})

/* ───────── 3. loadAlerts 复用行：结果与自读一致（未读口径不变） ───────── */

describe('loadAlerts 复用已读订阅行：结果与自行读取完全一致（未读口径不变）', () => {
  function fresh() {
    env.resetAll()
    configureCloud()
    env.load('stores/auth').useAuth.getState().setLogin({ userId: 'me' })
    return env
  }

  it('传入 preRows 与不传 → groups / watched 完全一致（只是省掉一次重复读）', async () => {
    const { db } = fresh()
    db.__seed('keyword_watches', [
      { _id: 'me#雷军', openid: 'me', keyword: '雷军', created_at: iso(T0), seen_at: iso(T0), type: 'keyword' },
      {
        _id: 'me#person#李四#tech',
        openid: 'me',
        keyword: '李四',
        person_key: '李四#tech',
        created_at: iso(T0),
        seen_at: iso(T0),
        type: 'person'
      }
    ])
    db.__seed('keywords', [
      {
        _id: '雷军',
        keyword: '雷军',
        fetched_at: iso(T0 + 3600e3),
        items: [{ title: '雷军相关', url: 'https://a', source: '某报', first_seen_at: iso(T0 + 3600e3) }]
      }
    ])
    const ka = env.load('utils/keyword-alert')
    const rows = await ka.listWatches()
    const withPre = await ka.loadAlerts(rows)
    const without = await ka.loadAlerts()
    deepEq(withPre, without, '复用行与自读结果应逐字一致')
    eq(withPre.groups.length, 1, '只含关键词行（监控人被 splitWatches 拆掉）')
    eq(withPre.watched, 1)
    eq(withPre.groups[0].keyword, '雷军')
  })

  it('传入空数组 → 视为「没有订阅」，直接返回空（不抛）', async () => {
    fresh()
    const ka = env.load('utils/keyword-alert')
    deepEq(await ka.loadAlerts([]), { groups: [], watched: 0 })
  })
})
