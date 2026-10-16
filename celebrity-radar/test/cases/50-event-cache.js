'use strict'

/**
 * 落库事件的内存级 TTL 缓存（2026-10-16，P0-2 ④）。
 *
 * 由来：`opinion_events` 一次读要跨页取 `EVENT_READ_LIMIT`(200) 条 —— 小程序端单页上限 20 ⇒
 * **10 次往返、约 500 KB**，而端上全程只读、数据由云函数每天产出一轮。可同一次启动里它会被读好几遍：
 * 舆情页 `useDidShow`（首屏 + 从事件列表 / 事件详情返回）、事件列表页 `useDidShow`（首屏 + 从详情返回）。
 * 于 `utils/opinion-store#loadStoredEvents` 上加一层内存级 TTL 缓存（`EVENT_CACHE_TTL`），
 * 并把「用户显式刷新」单独留一个作废口（`invalidateStoredEvents`）。
 *
 * 这个文件钉住四条**改了不报错、但会静默退化成「每次都白拉 200 条」或「 refreshed 了却还是旧数据」** 的口径：
 *   ① TTL 内重复调用**不再读库**（这是缓存存在的全部意义，用 `db.stats.getCalls` 的**差值**验证）；
 *   ② 读失败**不写缓存**（一次网络抖动不该让整页在 TTL 内一直回落到本端聚类）；
 *   ③ 空集合 `[]` **照常缓存**（云函数还没跑过时「空」也是稳定事实，重复去读同样十次往返）；
 *   ④ 显式作废（下拉刷新）**立刻**生效，且不依赖 TTL 到点 —— 包括「作废时还有旧世代的读在途」
 *      这种竞态（旧结果回来不许把刚作废的缓存又填回去）。
 *
 * ⚠ `env.db.stats` **不随 `env.resetAll()` 清零**（见 harness 注释），故断言一律用差值。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const BUILD = path.resolve(__dirname, '..', '.build')

/** 每个用例从干净状态开始（清 storage + 清库 + 清模块缓存 ⇒ 缓存也一并清零） */
function fresh() {
  env.resetAll()
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
  return env
}

function row(id, lastAt, title) {
  return {
    _id: id,
    event_key: id,
    title: title || `事件${id}`,
    last_at: lastAt,
    members: [],
    memberCount: 0,
    memberTotal: 0,
    timeline: [],
    sources: [],
    labels: [],
    impact: 'unknown',
    credibility: 'unknown',
    response: 'unknown'
  }
}

/** 把「现在」推到 TTL 之外（模块读的是全局 `Date.now`，用例可临时改它） */
async function afterTtl(fn) {
  const real = Date.now
  Date.now = () => real() + 10 * 60 * 1000
  try {
    return await fn()
  } finally {
    Date.now = real
  }
}

describe('落库事件的内存级 TTL 缓存：同一次启动不重复拉 200 条', () => {
  it('TTL 内重复调用不再读库（省掉十次往返），且给的是同一份缓存', async () => {
    const { db, load } = fresh()
    db.__seed('opinion_events', [row('k1', '2026-10-10T00:00:00.000Z')])
    const store = load('utils/opinion-store')

    const before = db.stats.getCalls
    const first = await store.loadStoredEvents()
    const afterFirst = db.stats.getCalls
    ok(afterFirst > before, '首次必须真读库（缓存是空的）')
    eq(first.length, 1)

    const second = await store.loadStoredEvents()
    eq(db.stats.getCalls, afterFirst, 'TTL 内第二次不得再读库 —— 这正是这层缓存存在的意义')
    deepEq(second, first, '缓存命中的结果必须与首次逐字一致')
    ok(second === first, '命中的是同一份缓存（页面只读不写；就地改它会污染后续调用）')
  })

  it('超过 TTL 会重新读库（缓存不是永久值，弱网下慢一次就够）', async () => {
    const { db, load } = fresh()
    db.__seed('opinion_events', [row('k1', '2026-10-10T00:00:00.000Z')])
    const store = load('utils/opinion-store')

    await store.loadStoredEvents()
    const afterFirst = db.stats.getCalls

    await afterTtl(async () => {
      const again = await store.loadStoredEvents()
      eq(again.length, 1, '过期的缓存仍要用旧结果之外的一份新读')
      ok(db.stats.getCalls > afterFirst, 'TTL 之外必须重新读库')
    })

    /* TTL 的意义：一次启动内的重复读被吃掉，但数据不会长期停在某一份上 */
    ok(store.EVENT_CACHE_TTL > 0 && store.EVENT_CACHE_TTL <= 10 * 60 * 1000, 'TTL 应在「秒级～十分钟」量级')
  })

  it('invalidateStoredEvents()：立刻作废，不必等 TTL 到点（下拉刷新的路径）', async () => {
    const { db, load } = fresh()
    db.__seed('opinion_events', [row('k1', '2026-10-10T00:00:00.000Z')])
    const store = load('utils/opinion-store')

    const first = await store.loadStoredEvents()
    eq(first.length, 1)
    /* 换一批数据（`__seed` 是追加不是替换，故先清库再种 —— 同时验证「旧行确实没了」） */
    db.__reset()
    db.__seed('opinion_events', [row('k2', '2026-10-11T00:00:00.000Z')])
    const beforeInvalidate = db.stats.getCalls

    /* 不作废的话，下面这次读仍然拿到上面那份缓存（TTL 内）—— 先把这个前提钉住 */
    const cached = await store.loadStoredEvents()
    eq(db.stats.getCalls, beforeInvalidate, '未作废时命中缓存、不读库')
    eq(cached.length, 1)
    eq(cached[0].event_key, 'k1', '未作废时看到的是缓存里那份（新种子还看不到）')

    store.invalidateStoredEvents()
    const refreshed = await store.loadStoredEvents()
    ok(db.stats.getCalls > beforeInvalidate, '作废之后必须重新读库')
    eq(refreshed.length, 1)
    eq(refreshed[0].event_key, 'k2', '刷新后看到的是新数据（不是作废前那份）')
  })

  it('读失败返回 null 且**不写缓存**：恢复之后立刻就能读到（失败要能重试）', async () => {
    const { db, load } = fresh()
    db.__seed('opinion_events', [row('k1', '2026-10-10T00:00:00.000Z')])
    const store = load('utils/opinion-store')

    db.__setReadFailing('opinion_events', true)
    eq(await store.loadStoredEvents(), null, '读失败 = null（调用方据此回落本端聚类）')

    db.__setReadFailing('opinion_events', false)
    const rows = await store.loadStoredEvents()
    ok(rows, '失败没有被缓存住：恢复后立刻拿得到数据，不必等 TTL')
    eq(rows.length, 1)
    eq(rows[0].event_key, 'k1')
  })

  it('空集合 [] 照常缓存（「云函数还没跑过」也是稳定事实，不该重复去读）', async () => {
    const { db, load } = fresh()
    const store = load('utils/opinion-store')

    const before = db.stats.getCalls
    deepEq(await store.loadStoredEvents(), [], '集合为空 → 空数组（不是失败）')
    const afterFirst = db.stats.getCalls
    ok(afterFirst > before, '首次要真读库')

    deepEq(await store.loadStoredEvents(), [], '空集合也要缓存：第二次仍是空、且不再读库')
    eq(db.stats.getCalls, afterFirst, '空结果同样命中缓存，不得重复去读')
  })

  it('并发调用合并成一次读库（多个入口同一时刻各读一次，不该各拉 200 条）', async () => {
    const { db, load } = fresh()
    db.__seed('opinion_events', [row('k1', '2026-10-10T00:00:00.000Z')])
    const store = load('utils/opinion-store')

    /* 先量一次「单次读库」的代价（本项目是一次 get；量出来是为了不写死数字） */
    const s0 = db.stats.getCalls
    await store.loadStoredEvents()
    const singleRead = db.stats.getCalls - s0
    ok(singleRead > 0, '单次读至少要打一次 get')

    store.invalidateStoredEvents()
    const s1 = db.stats.getCalls
    const [a, b, c] = await Promise.all([
      store.loadStoredEvents(),
      store.loadStoredEvents(),
      store.loadStoredEvents()
    ])
    eq(db.stats.getCalls - s1, singleRead, '三次并发调用只应产生「一次读库」的开销')
    ok(a === b && b === c, '并发调用共享同一次读库的同一个 promise 结果')
  })

  it('旧世代在途结果不许回填缓存：作废期间发起的那次读不能把缓存又填回去', async () => {
    const { db, load } = fresh()
    db.__seed('opinion_events', [row('k1', '2026-10-10T00:00:00.000Z')])
    const store = load('utils/opinion-store')

    /* 造出「读在途」的现场：不 await。注意这次读是**异步发起**的（Builder 要等 `then` 才 run），
       所以用「读次数真的涨了」当门来确认它已经把数据取好 —— 猜几个 microtask 太脆 */
    const issued = db.stats.getCalls
    const stale = store.loadStoredEvents()
    let ticks = 0
    while (db.stats.getCalls === issued && ticks < 50) {
      await Promise.resolve()
      ticks++
    }
    ok(db.stats.getCalls > issued, '前置条件：在途那次读要真的发出去（否则本用例证明不了什么）')

    store.invalidateStoredEvents()
    /* 换成另一批数据（`__seed` 是追加不是替换，故先清库） */
    db.__reset()
    db.__seed('opinion_events', [row('k2', '2026-10-11T00:00:00.000Z')])

    const freshRows = await store.loadStoredEvents()
    eq(freshRows.length, 1)
    eq(freshRows[0].event_key, 'k2', '作废后发起的读拿到的是作废之后的数据')

    const staleRows = await stale
    ok(staleRows, '在途那次读照旧把结果交回调用方（只是不许写缓存）')
    eq(staleRows[0].event_key, 'k1', '它拿到的确实是作废**之前**那份数据（否则本用例证明不了什么）')

    /* 关键断言：旧世代的结果随后落地，也不许覆盖上面这次新读写下的缓存 */
    const again = await store.loadStoredEvents()
    eq(again[0].event_key, 'k2', '旧世代在途结果不得把刚作废的缓存又填回去（用户拉了刷新却看到旧数据）')
  })
})

describe('缓存接线：只有「用户显式刷新」才作废（页面重入照旧吃缓存）', () => {
  const page = fs.readFileSync(path.join(SRC, 'package', 'events', 'index.tsx'), 'utf8')

  it('事件列表页下拉刷新显式作废缓存，页面重入（useDidShow）不作废', () => {
    ok(page.includes('invalidateStoredEvents,'), '要 import invalidateStoredEvents')
    /* 只取 usePullDownRefresh 回调块本身（与 38-events-list 取 useDidShow 块同法），
       避免把页面别处的调用误算进来 */
    const pull = (page.match(/usePullDownRefresh\(async \(\) => \{[\s\S]*?\n  \}\)/) || [''])[0]
    ok(pull.includes('invalidateStoredEvents()'), '下拉刷新必须作废缓存：否则用户拉了刷新仍看到缓存里那份数据')
    ok(pull.indexOf('invalidateStoredEvents()') < pull.indexOf('load(true)'), '要先作废再重取（顺序反了就白作废）')

    /* useDidShow 走的 load() 是**页面重入**，不该作废 —— 否则又变回每次十次往返 */
    const didShow = (page.match(/useDidShow\(\(\) => \{[\s\S]*?\n  \}\)/) || [''])[0]
    ok(didShow.includes('void load()'), 'useDidShow 仍要重取数据（吃缓存即可）')
    ok(!didShow.includes('invalidateStoredEvents()'), '页面重入不得作废缓存')
  })

  it('舆情页只读不写：不自己再造一套缓存 / 不作废（同一入口的多份读共用这一层）', () => {
    const opinion = fs.readFileSync(path.join(SRC, 'pages', 'opinion', 'index.tsx'), 'utf8')
    ok(opinion.includes('loadStoredEvents('), '舆情页仍走 loadStoredEvents')
    ok(!opinion.includes('invalidateStoredEvents('), '舆情页没有「显式刷新」入口，不该调作废口')
  })
})
