'use strict'

/**
 * E1-② 事件订阅（站内口径，2026-10-16）：
 * `utils/event-subscribe.ts`（口径）+ `utils/opinion-store.ts`（`subs` 存取）
 * + `package/event`（订阅入口）/ `package/alerts`（消费）/ `package/events`（打标）。
 *
 * 这一版要钉的是「订阅的单位到底是什么、算不算得出来」。做错的形态全都长得像对的 ——
 * 列表照常出现、字也通顺，只是那条关系是假的：
 *
 *   1. **匹配要认 `labels[]` 全体，不只比 `objectKey`**。`objectKey`（出现最多的那个成员标签）
 *      每轮重算都可能换人，只比它 ⇒ 订阅时灵时不灵，而「不灵」在界面上只表现为「今天没动静」。
 *   2. **「没人订阅」与「订阅了都没动」必须分开**。前者不该长出一张空卡、也不该读事件表；
 *      后者必须给一句话，否则看起来像加载失败。
 *   3. **`matched` 与 `fresh` 是两个数**。有相关事件但都读过，与这个对象根本没事件，
 *      对用户是两个意思，混成一个数就会把「你都看完了」说成「没有线索」。
 *   4. **满员不静默顶掉**。订阅是用户一个个点出来的，静默丢一个 = 他不知道在盯的东西没了。
 *   5. **订阅不占已读/跟进的额度**。否则多读几百条事件就把订阅挤掉，
 *      而订阅是显式动作，掉了必须是他自己取消的。
 *   6. **不另算一套角标**。命中的事件本来就参与事件模块的 new/update 判定；
 *      再算一个 = 同一件事在两处各提醒一次。
 *
 * 页面侧（三处接线、短路口径、埋点）走源码级静态断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const BUILD = path.resolve(__dirname, '..', '.build')
const read = (p) => fs.readFileSync(p, 'utf8')

/**
 * 剥掉注释再断言：本版代码里刻意写了很多「不该这样」的说明性注释
 * （例如「渲染判据是 hasSubjectSubs(status)、不是 subHits.length」），
 * 不剥注释就会把**说明**当成违规（同 18 / 45 / 63 的手法）。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const HOUR = 3600 * 1000
const NOW = Date.now()
const T0 = NOW - 3 * 24 * HOUR
const iso = (ms) => new Date(ms).toISOString()

/** 与 13-messages / 67-revisit 同一手法：isCloudConfigured 是模块级常量，必须在 load 之前改配置对象 */
function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

function fresh() {
  env.resetAll()
  configureCloud()
  return { db: env.db, load: env.load }
}

function login(id = 'me') {
  env.load('stores/auth').useAuth.getState().setLogin({ userId: id })
  return id
}

/* ─────────────────────────── 造数 ─────────────────────────── */

/**
 * 一条展示态事件。
 * ⚠ 只喂纯函数**真正读**的字段（key / objectKey / labels / date / title / memberTotal）：
 * 多喂会掩盖「函数偷偷读了别的字段」，少喂会让改口径后断言静默空转。
 */
function ev(key, opts) {
  const o = opts || {}
  return {
    key,
    objectKey: o.objectKey || '',
    labels: o.labels || [],
    title: o.title || key,
    date: o.date || iso(T0),
    memberTotal: o.memberTotal === undefined ? 3 : o.memberTotal,
    sources: []
  }
}

/** 内存态个人状态（`subs` 显式给出，避免「忘了加」导致纯函数用例空跑） */
const SUB = (subs, extra) => Object.assign({ reads: {}, follows: {}, subs: subs || {} }, extra || {})

/** `opinion_event_status` 的 DB 行（`__seed` 要 `_id`） */
const statusRow = (subs, extra) =>
  Object.assign(
    { _id: 'me', reads: {}, follows: {}, subs: subs || {}, updated_at: iso(T0) },
    extra || {}
  )

/* ═══════════════════ 1. 归一化：存与比必须同一个口径 ═══════════════════ */

describe('E1-② 归一化：存与比不能是两个口径（normSubject）', () => {
  const S = () => fresh().load('utils/event-subscribe')

  it('去首尾空白、内部连续空白压成一个', () => {
    const s = S()
    eq(s.normSubject('  张三  '), '张三')
    eq(s.normSubject('张  三'), '张 三')
    eq(s.normSubject('张 三'), '张 三')
  })

  it('拉丁字母统一小写（同名大小写不同不该算两个对象）', () => {
    const s = S()
    eq(s.normSubject('Elon Musk'), 'elon musk')
    eq(s.normSubject('elon  musk'), 'elon musk')
  })

  it('空 / null / 空白 → 空串（调用方据此拒绝，不写库）', () => {
    const s = S()
    eq(s.normSubject(null), '')
    eq(s.normSubject(undefined), '')
    eq(s.normSubject('   '), '')
  })

  it('刻意不做的事：不删内部空格、不做模糊匹配（归一越激进，越把两个人当成一个）', () => {
    const s = S()
    notOk(s.normSubject('李 明') === s.normSubject('李明'), '「李 明」与「李明」是两个标签')
    notOk(s.normSubject('张三') === s.normSubject('张三丰'), '不做前缀 / 包含匹配')
  })
})

describe('E1-② 对象的标签集合：objectKey + labels 全体（subjectLabelsOf）', () => {
  const S = () => fresh().load('utils/event-subscribe')

  it('合并 objectKey 与 labels，去重、去空、逐个归一', () => {
    const s = S()
    deepEq(s.subjectLabelsOf(ev('k', { objectKey: '张三', labels: ['张三', ' 李四 ', ''] })), [
      '张三',
      '李四'
    ])
  })

  it('大小写不影响命中（存进库的是原样标签，匹配走归一形）', () => {
    const s = S()
    deepEq(s.subjectLabelsOf(ev('k', { objectKey: 'Elon Musk', labels: ['elon musk'] })), ['elon musk'])
  })

  it('空 / 脏输入不抛', () => {
    const s = S()
    deepEq(s.subjectLabelsOf(null), [])
    deepEq(s.subjectLabelsOf(ev('k', {})), [])
  })
})

/* ═══════════════════ 2. 对齐：订阅 × 事件 ═══════════════════ */

describe('E1-② 对齐：区分「还没事件」与「都看过了」（buildSubjectHits）', () => {
  const S = () => fresh().load('utils/event-subscribe')

  it('没订阅 → 空数组（消费方据此**不渲染**这张卡）', () => {
    const s = S()
    deepEq(s.buildSubjectHits([ev('k1', { objectKey: '张三' })], SUB({})), [])
  })

  it('命中 objectKey', () => {
    const s = S()
    const hits = s.buildSubjectHits([ev('k1', { objectKey: '张三' })], SUB({ 张三: iso(T0) }))
    eq(hits.length, 1)
    eq(hits[0].label, '张三')
    eq(hits[0].matched, 1)
    eq(hits[0].fresh.length, 1)
  })

  it('⚠ 命中 labels 里**不是 objectKey** 的那个：objectKey 会随聚类漂移，不能当唯一判据', () => {
    const s = S()
    /* 这条事件这轮的 objectKey 是「李四」（他旁边那个标签更高频），但张三仍是成员 */
    const hits = s.buildSubjectHits(
      [ev('k1', { objectKey: '李四', labels: ['李四', '张三'] })],
      SUB({ 张三: iso(T0) })
    )
    eq(hits[0].matched, 1, '只比 objectKey 时这里会是 0 —— 表现就是「订阅今天不灵」')
  })

  it('有相关事件但都读过：matched > 0 而 fresh 为空（不许看成「没有线索」）', () => {
    const s = S()
    const hits = s.buildSubjectHits(
      [ev('k1', { objectKey: '张三', date: iso(T0) })],
      SUB({ 张三: iso(T0) }, { reads: { k1: iso(T0 + HOUR) } })
    )
    eq(hits[0].matched, 1)
    eq(hits[0].fresh.length, 0, '读过 ⇒ fresh 空；matched 必须留着')
  })

  it('根本没事件：matched = 0 且 fresh 为空', () => {
    const s = S()
    const hits = s.buildSubjectHits([], SUB({ 张三: iso(T0) }))
    eq(hits[0].matched, 0)
    deepEq(hits[0].fresh, [])
  })

  it('一条事件命中多个订阅对象：每个对象都记上（各自是独立的关系）', () => {
    const s = S()
    const hits = s.buildSubjectHits(
      [ev('k1', { objectKey: '张三', labels: ['张三', '李四'] })],
      SUB({ 张三: iso(T0), 李四: iso(T0) })
    )
    eq(hits.filter((h) => h.matched === 1).length, 2)
  })

  it('排序：有未读动向的在前（按未读条数降序），其次按订阅时刻倒序', () => {
    const s = S()
    const hits = s.buildSubjectHits(
      [
        ev('a1', { objectKey: 'A', date: iso(T0 + HOUR) }),
        ev('a2', { objectKey: 'A', date: iso(T0 + 2 * HOUR) }),
        ev('b1', { objectKey: 'B', date: iso(T0 + 3 * HOUR) })
      ],
      SUB({ A: iso(T0), B: iso(T0 + HOUR), C: iso(T0 + 2 * HOUR) })
    )
    deepEq(hits.map((h) => h.label), ['A', 'B', 'C'], 'A 有 2 条未读 > B 1 条 > C 0 条')
  })

  it('静止用户（订阅了但都没动）照样返回那些对象 —— 否则卡上一个 chip 都没有', () => {
    const s = S()
    const hits = s.buildSubjectHits([], SUB({ 张三: iso(T0), 李四: iso(T0) }))
    eq(hits.length, 2)
  })

  it('脏输入不抛', () => {
    const s = S()
    deepEq(s.buildSubjectHits(null, null), [])
    deepEq(s.buildSubjectHits([null, ev('k1', {})], SUB({ 张三: iso(T0) })), [
      { label: '张三', at: iso(T0), matched: 0, fresh: [] }
    ])
  })

  it('subjectFreshCount：数的是「有动向的对象个数」，不是事件条数', () => {
    const s = S()
    const hits = s.buildSubjectHits(
      [ev('a1', { objectKey: 'A' }), ev('a2', { objectKey: 'A' }), ev('b1', { objectKey: 'B' })],
      SUB({ A: iso(T0), B: iso(T0), C: iso(T0) })
    )
    eq(s.subjectFreshCount(hits), 2, 'A 有 2 条未读，但仍只算 1 个对象')
  })
})

describe('E1-② 列表打标：含已读的事件也要标（subscribedLabelByEvent）', () => {
  const S = () => fresh().load('utils/event-subscribe')

  it('没订阅 → 空表', () => {
    const s = S()
    deepEq(s.subscribedLabelByEvent([ev('k1', { objectKey: '张三' })], SUB({})), {})
  })

  it('⚠ 已读过的事件照样算命中：打标用**命中集**，不是 fresh（fresh 只有未读）', () => {
    const s = S()
    const map = s.subscribedLabelByEvent(
      [ev('k1', { objectKey: '张三' })],
      SUB({ 张三: iso(T0) }, { reads: { k1: iso(T0 + HOUR) } })
    )
    eq(map.k1, '张三')
  })

  it('一条事件命中多个对象：用「、」连起来（不然用户要自己回忆订了谁）', () => {
    const s = S()
    const map = s.subscribedLabelByEvent(
      [ev('k1', { objectKey: '张三', labels: ['张三', '李四'] })],
      SUB({ 张三: iso(T0), 李四: iso(T0) })
    )
    eq(map.k1, '张三、李四')
  })

  it('没命中的事件不进表（负向断言配正向对照，避免空跑也能过）', () => {
    const s = S()
    const map = s.subscribedLabelByEvent(
      [ev('k1', { objectKey: '张三' }), ev('k2', { objectKey: '王五' })],
      SUB({ 张三: iso(T0) })
    )
    eq(map.k1, '张三')
    notOk('k2' in map)
    eq(Object.keys(map).length, 1)
  })
})

/* ═══════════════════ 3. 额度：都不许静默丢 ═══════════════════ */

describe('E1-② 额度：订阅与已读/跟进各有各的上限（pruneStatus / pruneSubjects）', () => {
  it('⚠ 订阅不占 MAX_STATUS_ENTRIES 的额度：reads 爆表被裁后，subs 原样还在', () => {
    const { load } = fresh()
    const st = load('utils/opinion-store')
    const reads = {}
    for (let i = 0; i < st.MAX_STATUS_ENTRIES + 50; i++) reads[`k${i}`] = iso(T0 + i * 1000)
    const pruned = st.pruneStatus({ reads, follows: {}, subs: { 张三: iso(T0) } })
    eq(Object.keys(pruned.reads).length, st.MAX_STATUS_ENTRIES, 'reads 照旧被裁到上限')
    eq(pruned.subs['张三'], iso(T0), '订阅必须原样透传')
  })

  it('pruneSubjects：超上限时保留**订阅得最晚**的那些（而不是最早的）', () => {
    const { load } = fresh()
    const s = load('utils/event-subscribe')
    const subs = {}
    for (let i = 0; i < s.SUB_MAX + 5; i++) subs[`对象${i}`] = iso(T0 + i * 1000)
    const out = s.pruneSubjects(subs)
    eq(Object.keys(out).length, s.SUB_MAX)
    ok('对象0' in out === false, '最早的先出局')
    ok('对象34' in out, '最晚的留下')
  })

  it('pruneSubjects：没超上限时原样返回（不打乱、不丢）', () => {
    const { load } = fresh()
    const s = load('utils/event-subscribe')
    deepEq(s.pruneSubjects({ 张三: iso(T0), 李四: iso(T0 + HOUR) }), {
      张三: iso(T0),
      李四: iso(T0 + HOUR)
    })
  })
})

/* ═══════════════════ 4. 存取：一个写口（toggleSubject） ═══════════════════ */

describe('E1-② 存取：与已读/跟进共用一行，但是同一个写口（toggleSubject）', () => {
  const S = () => fresh().load('utils/event-subscribe')

  it('订阅：写库一次，subs 里有这个键，返回 on', () => {
    const { db, load } = fresh()
    login()
    db.__seed('opinion_event_status', [statusRow({})])
    const s = load('utils/event-subscribe')
    const before = db.stats.docSetCalls
    return s.toggleSubject('张三', true, new Date(T0)).then((out) => {
      eq(out, 'on')
      eq(db.stats.docSetCalls - before, 1, '订阅是一次写')
      eq(db.__dump('opinion_event_status')[0].subs['张三'], iso(T0))
    })
  })

  it('幂等：本来就订了再点一次 → 不写库、也不刷新时刻', () => {
    const { db, load } = fresh()
    login()
    db.__seed('opinion_event_status', [statusRow({ 张三: iso(T0) })])
    const s = load('utils/event-subscribe')
    const before = db.stats.docSetCalls
    return s.toggleSubject('张三', true, new Date(T0 + HOUR)).then((out) => {
      eq(out, 'on')
      eq(db.stats.docSetCalls - before, 0, '值没变就不该付写库 —— 详情页会反复调')
      eq(db.__dump('opinion_event_status')[0].subs['张三'], iso(T0))
    })
  })

  it('大小写/空白不同也算「本来就订了」：归一后同一个对象，不重复建键', () => {
    const { db, load } = fresh()
    login()
    db.__seed('opinion_event_status', [statusRow({ 'Elon Musk': iso(T0) })])
    const s = load('utils/event-subscribe')
    const before = db.stats.docSetCalls
    return s.toggleSubject('  elon   musk ', true).then((out) => {
      eq(out, 'on')
      eq(db.stats.docSetCalls - before, 0)
      eq(Object.keys(db.__dump('opinion_event_status')[0].subs).length, 1)
    })
  })

  it('取消：删键并写库（upsert 是整行覆盖，空对象也必须写回去）', () => {
    const { db, load } = fresh()
    login()
    db.__seed('opinion_event_status', [statusRow({ 张三: iso(T0), 李四: iso(T0) })])
    const s = load('utils/event-subscribe')
    const before = db.stats.docSetCalls
    return s.toggleSubject('张三', false).then((out) => {
      eq(out, 'off')
      eq(db.stats.docSetCalls - before, 1)
      const subs = db.__dump('opinion_event_status')[0].subs
      notOk('张三' in subs)
      ok('李四' in subs, '只删要取消的那个')
    })
  })

  it('幂等：本来没订，取消 → 不写库', () => {
    const { db, load } = fresh()
    login()
    db.__seed('opinion_event_status', [statusRow({})])
    const s = load('utils/event-subscribe')
    const before = db.stats.docSetCalls
    return s.toggleSubject('张三', false).then((out) => {
      eq(out, 'off')
      eq(db.stats.docSetCalls - before, 0)
    })
  })

  it('空标签 → failed，且不写库（不给「点了没结果」的按钮留后门）', () => {
    const { db, load } = fresh()
    login()
    db.__seed('opinion_event_status', [statusRow({})])
    const s = load('utils/event-subscribe')
    const before = db.stats.docSetCalls
    return Promise.all([s.toggleSubject('   ', true), s.toggleSubject(null, true)]).then((outs) => {
      deepEq(outs, ['failed', 'failed'])
      eq(db.stats.docSetCalls - before, 0)
    })
  })

  it('⚠ 满员 → full，**不写库、也不顶掉最早订阅的那个**', () => {
    const { db, load } = fresh()
    login()
    const s0 = load('utils/event-subscribe')
    const full = {}
    for (let i = 0; i < s0.SUB_MAX; i++) full[`对象${i}`] = iso(T0 + i * 1000)
    db.__seed('opinion_event_status', [statusRow(full)])
    const before = db.stats.docSetCalls
    return s0.toggleSubject('新对象', true).then((out) => {
      eq(out, 'full')
      eq(db.stats.docSetCalls - before, 0, '被拒 = 库里什么都没发生')
      const subs = db.__dump('opinion_event_status')[0].subs
      ok('对象0' in subs, '最早的订阅必须还在')
      notOk('新对象' in subs)
      eq(Object.keys(subs).length, s0.SUB_MAX)
    })
  })

  it('⚠ 订阅不挤掉已读/跟进：写 subs 后 reads / follows 原样还在（同一个写口）', () => {
    const { db, load } = fresh()
    login()
    db.__seed('opinion_event_status', [
      statusRow({}, { reads: { ev_k: iso(T0) }, follows: { ev_k: iso(T0 + HOUR) } })
    ])
    const s = load('utils/event-subscribe')
    return s.toggleSubject('张三', true, new Date(T0)).then(() => {
      const row = db.__dump('opinion_event_status')[0]
      eq(row.reads['ev_k'], iso(T0))
      eq(row.follows['ev_k'], iso(T0 + HOUR))
      eq(row.subs['张三'], iso(T0))
    })
  })

  it('未登录 → failed（不产生半条关系）', () => {
    const { db, load } = fresh()
    const s = load('utils/event-subscribe')
    const before = db.stats.docSetCalls
    return s.toggleSubject('张三', true).then((out) => {
      eq(out, 'failed')
      eq(db.stats.docSetCalls - before, 0)
    })
  })
})

/* ═══════════════════ 5. 读口：不订阅就不读事件表 ═══════════════════ */

describe('E1-② 读口短路：没订阅就不为一张空卡去读事件（hasSubjectSubs）', () => {
  const S = () => fresh().load('utils/event-subscribe')

  it('没订阅 / 空 subs / 脏输入 → false', () => {
    const s = S()
    eq(s.hasSubjectSubs(SUB({})), false)
    eq(s.hasSubjectSubs(null), false)
    eq(s.hasSubjectSubs({ reads: {}, follows: {} }), false)
    eq(s.hasSubjectSubs(SUB({ '  ': iso(T0) })), false, '只有空白的键不算订阅')
  })

  it('真订了一个 → true', () => {
    const s = S()
    eq(s.hasSubjectSubs(SUB({ 张三: iso(T0) })), true)
  })
})

/* ═══════════════════ 6. 接线（源码级静态断言） ═══════════════════ */

const EVENT_PAGE = read(path.join(SRC, 'package', 'event', 'index.tsx'))
const ALERTS_PAGE = stripComments(read(path.join(SRC, 'package', 'alerts', 'index.tsx')))
const EVENTS_PAGE = stripComments(read(path.join(SRC, 'package', 'events', 'index.tsx')))
const EVENTS_SCSS = read(path.join(SRC, 'package', 'events', 'index.scss'))
const EVENTS_TS = read(path.join(SRC, 'utils', 'events.ts'))
const STORE_TS = read(path.join(SRC, 'utils', 'opinion-store.ts'))
const SCHEMA = read(path.resolve(SRC, '..', 'cloudfunctions', 'dbInit', 'schema.js'))

describe('E1-② 接线：事件详情页是入口（package/event）', () => {
  it('用的是口径模块，不自己算匹配', () => {
    ok(/from '@\/utils\/event-subscribe'/.test(EVENT_PAGE))
    ok(/findSubjectSub/.test(EVENT_PAGE))
    ok(/toggleSubject/.test(EVENT_PAGE))
    ok(/SUB_MAX/.test(EVENT_PAGE), '满员提示要用真上限，不能手写一个数字')
  })

  it('订阅按钮只在**有对象可订**时渲染（不给一个点了没用的按钮）', () => {
    ok(/\{subLabel \? \(/.test(EVENT_PAGE))
    ok(/findSubjectSub\(eventStatus, subLabel\)/.test(EVENT_PAGE))
  })

  it('文案说清「落到站内、不发推送」（推送随 N-1 冻结，不能空口承诺）', () => {
    ok(/不发推送/.test(EVENT_PAGE))
    ok(/订阅的对象/.test(EVENT_PAGE), '要指出去哪里看')
  })

  it('埋点在结果判定**之后**报：满员/失败不许算进关系数', () => {
    const iFull = EVENT_PAGE.indexOf("outcome === 'full'")
    const iFail = EVENT_PAGE.indexOf("outcome === 'failed'")
    const iTrack = EVENT_PAGE.indexOf("track('event_subscribe'")
    ok(iFull > 0 && iFail > 0 && iTrack > 0)
    ok(iTrack > iFull && iTrack > iFail, '成功路径才报')
  })
})

describe('E1-② 接线：预警页是消费落点（package/alerts）', () => {
  it('读的是**落库事件**（与整页「云端每天扫一轮」的结果视图同源）', () => {
    ok(/loadStoredEvents/.test(ALERTS_PAGE))
    ok(/toDisplayEvents/.test(ALERTS_PAGE))
    ok(/buildSubjectHits/.test(ALERTS_PAGE))
  })

  it('⚠ 短路口径：先问 hasSubjectSubs，没订阅**才不走** loadStoredEvents', () => {
    const iGuard = ALERTS_PAGE.indexOf('hasSubjectSubs(evStatus)')
    const iRead = ALERTS_PAGE.indexOf('await loadStoredEvents()')
    ok(iGuard > 0 && iRead > 0)
    ok(iGuard < iRead, '顺序反了 = 每个用户都白读两百行')
    ok(/if \(!hasSubjectSubs\(evStatus\)\)/.test(ALERTS_PAGE))
  })

  it('⚠ 渲染判据是 hasSubjectSubs(status)（读出来那行升到 state），不是 subHits.length（后者会把「没订阅」也画成空卡）', () => {
    ok(/useState<EventStatus>/.test(ALERTS_PAGE), '判据要在 state 里活着，局部变量在重渲染时已经出作用域')
    ok(/setStatus\(evStatus\)/.test(ALERTS_PAGE), '读出来的状态必须升到 state')
    ok(/userId && hasSubjectSubs\(status\)/.test(ALERTS_PAGE))
    notOk(/subHits\.length/.test(ALERTS_PAGE))
  })

  it('⚠ 点进事件**不推进已读**：已读基线归事件详情页自己推进（两处都推会消掉用户没读的角标）', () => {
    notOk(/markEventRead/.test(ALERTS_PAGE))
    notOk(/markEventsRead/.test(ALERTS_PAGE))
    ok(/openSubjectEvent/.test(ALERTS_PAGE))
  })

  it('给出路与取消：截断如实报数、取消订阅留在这一页', () => {
    ok(/还有 \$\{h\.fresh\.length - SUB_EVENT_MAX\} 条/.test(ALERTS_PAGE))
    ok(/unsubscribeSubject/.test(ALERTS_PAGE))
    ok(/toggleSubject\(label, false\)/.test(ALERTS_PAGE))
    ok(/\/package\/events\/index/.test(ALERTS_PAGE), '「还有 N 条」要给出口')
  })
})

describe('E1-② 接线：事件列表页给命中订阅的事件打标（package/events）', () => {
  it('打标用命中集（含已读），计数用对象个数', () => {
    ok(/subscribedLabelByEvent/.test(EVENTS_PAGE))
    ok(/subjectFreshCount/.test(EVENTS_PAGE))
    ok(/subLabelByEvent\[ev\.key\]/.test(EVENTS_PAGE))
  })

  it('角标带上对象名，且样式与 NEW / 有新进展区分开', () => {
    ok(/page-events__badge--sub/.test(EVENTS_PAGE))
    ok(/订阅·\{subLabel\}/.test(EVENTS_PAGE))
    ok(/&--sub \{/.test(EVENTS_SCSS))
  })

  it('与「盯的 N 条」分成两个数字（一个问单条事件，一个问对象）', () => {
    ok(/盯的 \{followCount\} 条有新进展/.test(EVENTS_PAGE))
    ok(/订阅的 \{subFreshCount\} 个对象有新动向/.test(EVENTS_PAGE))
  })
})

describe('E1-② 接线：埋点登记与字段声明（events.ts / dbInit）', () => {
  it("events.ts 的联合类型里有 'event_subscribe'", () => {
    ok(/'event_subscribe'/.test(EVENTS_TS))
    ok(/props\.subject/.test(EVENTS_TS), '要写清 props 口径，否则报表看不懂 subject 是什么')
  })

  it("dbInit 声明了 subs 字段，并在 events 的 enumHint 里登记 event_subscribe", () => {
    ok(/f\('subs', 'object\?'/.test(SCHEMA))
    ok(/'revisit_open', 'event_subscribe'/.test(SCHEMA))
    ok(/订阅对象/.test(SCHEMA), '字段用途要写清「键不是 event_key」')
  })

  it('存储层把 subs 与已读/跟进分成两套额度（pruneStatus 只裁 event_key 那两个）', () => {
    ok(/`subs`\s\*\*原样透传\*\*/.test(STORE_TS))
    ok(/export async function saveEventStatus/.test(STORE_TS), '导出的写口，给 event-subscribe 复用')
  })
})
