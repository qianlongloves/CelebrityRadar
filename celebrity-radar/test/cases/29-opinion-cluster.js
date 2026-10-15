'use strict'

/**
 * 舆情事件落库（P4，2026-10-13）—— 云函数 opinionCluster + 端上 utils/opinion-store 的纯逻辑与静态约束。
 *
 * 钉住八件事：
 *   1. **稳定主题键**：成员集合变化（新增更晚的报道）后 event_key 保持不变；
 *   2. **不同事件不撞键**（不同主题 / 不同对象键）；
 *   3. **端云判据一致**：云函数复制的 sameEvent / normalizeTitle / credibilityOf / isOfficialSource /
 *      sourceNatureOf / impactOf / responseOf / themeTokenOf / objectKeyOf / eventKeyOf 与端上 TS 逐输入一致
 *      （与 test/cases/01-pure.js 的「风险词典两端一致」同法；漂移即红）；
 *   4. **云函数一轮行为**：读库聚类写事件、零上游（不联网）、拒绝端上调用；
 *   5. **沿用旧键**：新报道替换旧报道后，第二轮仍写到同一个 event_key（成员集合变化后键不变）；
 *   6. **状态只读写自己的** + **map 有上限裁剪**；
 *   7. **事件集合字段与端上结构一致**（渲染时字段名不出现两套）；
 *   8. **端上读库失败 / 集合为空时降级到本端聚类**，且免费用户事件 / 时间线仍限 5 条；「新事件」判定规则。
 *
 * 云函数是 JS，用假 wx-server-sdk 加载（同 07-cloud-authority.js 的 loadScheduled 做法）。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const CLUSTER = path.join(CLOUD, 'opinionCluster', 'index.js')
const read = (p) => fs.readFileSync(p, 'utf8')

/**
 * 加载云函数 opinionCluster：wx-server-sdk → harness 内存 DB（**不注入 https** —— 本函数本就不联网），
 * 传 openid 则模拟「端上调用」（用于验证拒绝闸门）。
 */
function loadCluster(openid) {
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
    delete require.cache[require.resolve(CLUSTER)]
    return require(CLUSTER)
  } finally {
    Module.prototype.require = orig
  }
}

const feedRow = (personKey, items) => ({ _id: personKey, items })

/* ───────────────────── 1. 稳定主题键 ───────────────────── */

describe('事件身份：稳定主题键', () => {
  it('成员集合只增（新增更晚报道）时 event_key 保持不变', () => {
    env.resetAll()
    const eventsMod = env.load('utils/opinion-events')
    const { themeTokenOf, objectKeyOf, eventKeyOf, buildOpinionEvents } = eventsMod
    const base = [{ title: '关于X公司起诉事件的声明', date: '2026-10-01', label: '张三' }]
    const k1 = eventKeyOf(objectKeyOf(base), themeTokenOf(base))
    const grown = base.concat([{ title: '【追踪】关于X公司起诉事件的声明', date: '2026-10-05', label: '张三' }])
    const k2 = eventKeyOf(objectKeyOf(grown), themeTokenOf(grown))
    eq(k2, k1, '新增一条更晚的报道后，主题词锚点不变 → 键不变')

    const one = buildOpinionEvents({
      feed: [{ title: '关于X公司起诉事件的声明', source: 'A报', date: '2026-10-01', person: '张三' }]
    })[0]
    const two = buildOpinionEvents({
      feed: [
        { title: '关于X公司起诉事件的声明', source: 'A报', date: '2026-10-01', person: '张三' },
        { title: '【追踪】关于X公司起诉事件的声明', source: 'B报', date: '2026-10-05', person: '张三' }
      ]
    })[0]
    eq(two.memberCount, 2, '两条应聚成同一事件')
    eq(two.key, one.key, '事件键不因成员增加而变')
  })

  it('主题词锚定「日期最早」那条（同日取字典序更小者，与成员顺序无关）', () => {
    env.resetAll()
    const { themeTokenOf, objectKeyOf } = env.load('utils/opinion-events')
    const a = { title: '乙标题更晚', date: '2026-10-05' }
    const b = { title: '甲标题更早', date: '2026-10-02' }
    eq(themeTokenOf([a, b]), themeTokenOf([b, a]), '与成员顺序无关')
    eq(themeTokenOf([a, b]), '甲标题更早'.replace(/[^\u3400-\u9fffa-z0-9]/g, '').toLowerCase())
    /* 都无日期时按标题字典序取，不依赖顺序 */
    eq(themeTokenOf([{ title: 'B' }, { title: 'A' }]), themeTokenOf([{ title: 'A' }, { title: 'B' }]))
    eq(objectKeyOf([{ label: '张三' }, { label: '李四' }, { label: '张三' }]), '张三')
    eq(objectKeyOf([{ label: '李四' }, { label: '张三' }]), '张三', '并列取字典序更小者')
    eq(objectKeyOf([{}]), '')
  })

  it('不同事件不撞键（不同主题词 / 不同对象键）', () => {
    env.resetAll()
    const { themeTokenOf, objectKeyOf, eventKeyOf } = env.load('utils/opinion-events')
    const key = (title, label) => {
      const m = [{ title, label }]
      return eventKeyOf(objectKeyOf(m), themeTokenOf(m))
    }
    notOk(key('A公司发布新品', '张三') === key('B公司回应传闻', '张三'), '不同主题词 → 不同键')
    notOk(key('关于X公司的声明', '张三') === key('关于X公司的声明', '李四'), '同标题不同对象键 → 不同键')
    eq(key('关于X公司的声明', '张三'), key('关于X公司的声明', '张三'), '同输入 → 同键（确定性）')
  })
})

/* ───────────────────── 2. 端云判据一致 ───────────────────── */

describe('端云判据一致（opinionCluster ↔ opinion-rank / opinion-events）', () => {
  it('sameEvent / normalizeTitle / DUP_* 门槛逐输入一致', () => {
    const cloud = loadCluster()
    const rank = env.load('utils/opinion-rank')

    const titles = [
      '',
      '关于X公司的声明',
      '【重磅】关于 X 公司的声明！',
      '关于X公司起诉事件的声明',
      '某某公司被起诉事件有了新的进展甲',
      '某某公司被起诉事件有了新的进展乙',
      '声明',
      'A公司发布新品',
      'ABC',
      'abcdefgh'
    ]
    for (const t of titles) eq(cloud.normalizeTitle(t), rank.normalizeTitle(t), `normalizeTitle(${t})`)
    for (const a of titles) for (const b of titles) {
      eq(cloud.sameEvent(a, b), rank.sameEvent(a, b), `sameEvent(${a}, ${b})`)
    }
    eq(cloud.DUP_MIN_CHARS, rank.DUP_MIN_CHARS)
    eq(cloud.DUP_PREFIX_CHARS, rank.DUP_PREFIX_CHARS)
  })

  it('credibilityOf / isOfficialSource / impactOf / responseOf / sourceNatureOf 一致', () => {
    const cloud = loadCluster()
    const rank = env.load('utils/opinion-rank')
    const events = env.load('utils/opinion-events')

    const sources = [[], ['A报'], ['A报', 'B报'], ['A报', 'A报'], ['某某市公安局'], ['A报', '某某人民法院']]
    for (const s of sources) eq(cloud.credibilityOf(s), rank.credibilityOf(s), `credibilityOf(${JSON.stringify(s)})`)

    const srcs = ['', '某娱乐自媒体', '某某市公安局', '人民法院', '国务院新闻办']
    for (const s of srcs) {
      eq(cloud.isOfficialSource(s), rank.isOfficialSource(s), `isOfficialSource(${s})`)
      eq(cloud.sourceNatureOf(s), events.sourceNatureOf(s), `sourceNatureOf(${s})`)
    }

    const levels = [undefined, 'high', 'mid', 'low', 'weird', '']
    for (const l of levels) eq(cloud.impactOf(l), rank.impactOf(l), `impactOf(${l})`)

    const combos = [
      [undefined, undefined],
      ['rights', undefined],
      ['statement', undefined],
      ['contract', undefined],
      ['judicial', undefined],
      [undefined, 'high'],
      [undefined, 'mid'],
      ['rights', 'low']
    ]
    for (const [c, l] of combos) eq(cloud.responseOf(c, l), rank.responseOf(c, l), `responseOf(${c}, ${l})`)
  })

  it('主题键三函数（themeTokenOf / objectKeyOf / eventKeyOf）一致', () => {
    const cloud = loadCluster()
    const events = env.load('utils/opinion-events')
    const sets = [
      [],
      [{ title: '关于X公司起诉事件的声明', date: '2026-10-03', label: '张三' }],
      [
        { title: '甲', date: '2026-10-02', label: '张三' },
        { title: '乙更长的标题在这里', date: '2026-10-05', label: '张三' }
      ],
      [{ title: '无日期标题', label: '' }],
      [{ title: 'A' }, { title: 'B' }]
    ]
    for (const m of sets) {
      eq(cloud.themeTokenOf(m), events.themeTokenOf(m), `themeTokenOf(${JSON.stringify(m)})`)
      eq(cloud.objectKeyOf(m), events.objectKeyOf(m), `objectKeyOf(${JSON.stringify(m)})`)
      eq(
        cloud.eventKeyOf(cloud.objectKeyOf(m), cloud.themeTokenOf(m)),
        events.eventKeyOf(events.objectKeyOf(m), events.themeTokenOf(m)),
        'eventKeyOf 组合一致'
      )
    }
  })

  it('deriveEvent 与端上 buildOpinionEvents 对同一批条目给出同一事件的同一判断', () => {
    const cloud = loadCluster()
    const { buildOpinionEvents } = env.load('utils/opinion-events')
    const input = {
      alerts: [
        { title: '关于Z公司的声明', source: 'A报', date: '2026-10-01', category: 'contract', level: 'low', keyword: '塌房' },
        { title: '【重磅】关于Z公司的声明', source: '某某市公安局', date: '2026-10-02', category: 'judicial', level: 'high', keyword: '塌房' }
      ]
    }
    const tsEvent = buildOpinionEvents(input)[0]
    const derived = cloud.deriveEvent([
      { block: 'alert', title: '关于Z公司的声明', source: 'A报', date: '2026-10-01', label: '塌房', category: 'contract', level: 'low' },
      { block: 'alert', title: '【重磅】关于Z公司的声明', source: '某某市公安局', date: '2026-10-02', label: '塌房', category: 'judicial', level: 'high' }
    ])
    eq(derived.event_key, tsEvent.key, '键一致')
    eq(derived.title, tsEvent.title, '标题选取一致')
    eq(derived.impact, tsEvent.impact, '影响面聚合一致')
    eq(derived.credibility, tsEvent.credibility, '可信度聚合一致')
    eq(derived.response, tsEvent.response, '需回应聚合一致')
    eq(derived.memberCount, tsEvent.memberCount, '成员数一致')
  })
})

/* ───────────────────── 3. 云函数一轮行为 ───────────────────── */

describe('云函数 opinionCluster：一轮行为', () => {
  it('拒绝端上调用（有 openid 即拒），不写任何东西', async () => {
    const fn = loadCluster('u1')
    const res = await fn.main({})
    eq(res.ok, false)
    ok(/只由定时器/.test(res.skipped || ''))
    eq(env.db.__dump('opinion_events').length, 0)
  })

  it('无存量条目 → 结构化空回执（不是错误）', async () => {
    const fn = loadCluster()
    const res = await fn.main({})
    eq(res.ok, true)
    eq(res.upstream, 0)
    eq(res.events, 0)
    eq(res.source, undefined)
    deepEq(res.skipped, [])
  })

  it('reset 模式：先清空 opinion_events 再重新聚类（删旧冗余、基于当前源表重采）', async () => {
    const fn = loadCluster()
    /* 预先在 opinion_events 里攒下「旧 / 测试冗余」事件 */
    env.db.__seed('opinion_events', [
      { _id: 'old-key-1', title: '旧事件A', members: [], memberCount: 0, impact: 'unknown', credibility: 'unknown', response: 'unknown', event_key: 'old-key-1' },
      { _id: 'old-key-2', title: '旧事件B', members: [], memberCount: 0, impact: 'unknown', credibility: 'unknown', response: 'unknown', event_key: 'old-key-2' }
    ])
    /* 当前源表：feed / risk_signals 各一条（与「读库聚类写事件」同款，确保重采有产出） */
    env.db.__seed('feed_cache', [
      feedRow('张三#ent', [{ title: '关于X公司起诉事件的声明', source: 'A报', publishedDate: '2026-10-01' }])
    ])
    env.db.__seed('risk_signals', [
      { _id: '李四#ent#abc', person_key: '李四#ent', name: '李四', title: '李四被冒名一事已有结果', source: '某某市公安局', quote: '', first_seen_at: '2026-10-02', category: 'judicial', level: 'high' }
    ])

    const res = await fn.main({ reset: true })
    eq(res.ok, true)
    ok(Array.isArray(res.skipped) && res.skipped.some((s) => typeof s === 'string' && s.includes('reset')), '回执应记录 reset 清空动作')
    const rows = env.db.__dump('opinion_events')
    notOk(rows.some((r) => r._id === 'old-key-1' || r._id === 'old-key-2'), '旧事件应被清空（冗余数据已删）')
    eq(rows.length, 2, '基于当前源表重新聚类成 2 个事件（重新采集）')
  })

  it('读库聚类写事件：feed / risk_signals 参与，keywords（私有关键词订阅）不参与，且零上游检索', async () => {
    const fn = loadCluster()
    /* feed / risk_signals 各造一条；keywords 造一条「与 feed 同名」的私有关注词缓存 */
    env.db.__seed('feed_cache', [
      feedRow('张三#ent', [{ title: '关于X公司起诉事件的声明', source: 'A报', publishedDate: '2026-10-01' }])
    ])
    env.db.__seed('keywords', [
      { _id: '塌房', keyword: '塌房', items: [{ title: '【重磅】关于X公司起诉事件的声明', source: 'B报', published_date: '2026-10-03' }], fetched_at: '' }
    ])
    env.db.__seed('risk_signals', [
      { _id: '李四#ent#abc', person_key: '李四#ent', name: '李四', title: '李四被冒名一事已有结果', source: '某某市公安局', quote: '', first_seen_at: '2026-10-02', category: 'judicial', level: 'high' }
    ])

    const res = await fn.main({})
    eq(res.ok, true)
    eq(res.upstream, 0, '本函数只读库聚类，不消耗任何上游检索（不调博查）')
    eq(res.created, 2, 'X 公司声明聚成 1 个事件 + 李四那条自成 1 个事件')
    const rows = env.db.__dump('opinion_events')
    eq(rows.length, 2)

    const x = rows.find((r) => r.title.includes('X公司起诉'))
    ok(!!x, 'X 公司声明事件应存在')
    eq(x.memberCount, 1, 'keywords 的「塌房」条目不参与：成员只有 feed 1 条（私有关键词隔离）')
    eq(x.timeline.length, 1, '时间线只有 feed 1 个节点')
    eq(x.timeline[0].source, 'A报', '时间线按时间正序')
    eq(x.event_key, x._id, 'event_key 即主键')
    ok(x.sources.indexOf('A报') >= 0 && x.sources.indexOf('B报') < 0, 'B报（私有关键词）不得出现在事件来源里')
  })

  it('新报道替换旧报道后，第二轮沿用旧 event_key（键不变、成员合并）', async () => {
    const fn = loadCluster()
    env.db.__seed('feed_cache', [
      feedRow('张三#ent', [{ title: '关于X公司起诉事件的声明', source: 'A报', publishedDate: '2026-10-01' }])
    ])
    const r1 = await fn.main({})
    eq(r1.created, 1)
    const key1 = env.db.__dump('opinion_events')[0]._id

    /* 第二轮：feed_cache 被刷新，旧报道（最早那条）消失了，只剩一条更晚、标题不同的报道 */
    env.db.__seed('feed_cache', [
      feedRow('张三#ent', [{ title: '【追踪】关于X公司起诉事件的声明', source: 'B报', publishedDate: '2026-10-05' }])
    ])
    const r2 = await fn.main({})
    eq(r2.created, 0, '不该另建新事件')
    eq(r2.updated, 1, '应更新既有事件')
    const rows = env.db.__dump('opinion_events')
    eq(rows.length, 1, '仍是同一个事件')
    eq(rows[0]._id, key1, 'event_key 保持不变（用户已读 / 跟进因此不丢）')
    eq(rows[0].memberCount, 2, '旧成员被合并保留（成员集合变化，键不变）')
  })

  it('云函数源码不 require https（自证零上游）+ 带 package.json / 触发声明', () => {
    const src = read(CLUSTER)
    notOk(/require\(['"]https['"]\)/.test(src), '本函数只读库聚类，不得引 https（不联网）')
    notOk(/bochaai|BOCHA_API_KEY/.test(src), '不得引用博查 / 密钥')
    ok(fs.existsSync(path.join(CLOUD, 'opinionCluster', 'package.json')), '新云函数必须带 package.json（云环境不预装 wx-server-sdk）')
    const pkg = JSON.parse(read(path.join(CLOUD, 'opinionCluster', 'package.json')))
    ok(!!pkg.dependencies['wx-server-sdk'], 'package.json 必须声明 wx-server-sdk 依赖')
    const rc = JSON.parse(read(path.join(ROOT, 'cloudbaserc.json')))
    const fnCfg = (rc.functions || []).find((f) => f.name === 'opinionCluster')
    ok(!!fnCfg, 'cloudbaserc.json 要声明 opinionCluster')
    ok(Array.isArray(fnCfg.triggers) && fnCfg.triggers.some((t) => t.type === 'timer'), '要有 timer 触发器')
  })
})

/* ───────────────────── 4. 个人状态：隔离 + 上限 ───────────────────── */

describe('个人状态：只读写自己的 + 上限裁剪', () => {
  const login = (id) => env.load('stores/auth').useAuth.getState().setLogin({ userId: id })

  it('只读到自己那一行；写只写自己那一行，绝不碰别人的行', async () => {
    env.resetAll()
    login('me')
    const store = env.load('utils/opinion-store')
    env.db.__seed('opinion_event_status', [
      { _id: 'other', reads: { k9: '2026-10-01T00:00:00.000Z' }, follows: {}, updated_at: '' }
    ])

    const st = await store.loadEventStatus()
    deepEq(st.reads, {}, '读到的只有自己的状态（别人的 k9 看不到）')

    ok(await store.markEventRead('k1'))
    const dump = env.db.__dump('opinion_event_status')
    eq(dump.length, 2, '只新增了自己那一行')
    eq(dump.find((r) => r._id === 'other').reads.k9, '2026-10-01T00:00:00.000Z', '别人的行一字未动')
    ok(dump.find((r) => r._id === 'me').reads.k1, '自己的写生效了')
    notOk('k9' in dump.find((r) => r._id === 'me').reads, '没有把别人的键写进自己这行')
  })

  it('跟进：写入带时间、取消即删除', async () => {
    env.resetAll()
    login('me')
    const store = env.load('utils/opinion-store')
    ok(await store.setEventFollow('k1', true))
    let row = env.db.__dump('opinion_event_status')[0]
    ok(typeof row.follows.k1 === 'string' && row.follows.k1.length > 0, '跟进要带时间')
    ok(await store.setEventFollow('k1', false))
    row = env.db.__dump('opinion_event_status')[0]
    notOk('k1' in row.follows, '取消跟进 = 删除该键')
  })

  it('map 有条数上限：超出按「最近活跃」裁剪，最新的保留、最旧的丢弃', async () => {
    env.resetAll()
    const { pruneStatus, MAX_STATUS_ENTRIES } = env.load('utils/opinion-store')
    const reads = {}
    const n = MAX_STATUS_ENTRIES + 50
    for (let i = 0; i < n; i++) reads[`k${i}`] = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()

    const pruned = pruneStatus({ reads, follows: {} })
    const total = Object.keys(pruned.reads).length + Object.keys(pruned.follows).length
    ok(total <= MAX_STATUS_ENTRIES, `裁剪后条目数 ${total} 不得超过上限 ${MAX_STATUS_ENTRIES}`)
    ok(`k${n - 1}` in pruned.reads, '最近的保留')
    notOk('k0' in pruned.reads, '最旧的被丢弃')
  })

  it('写回时自动裁剪：种 300+ 条状态后再标记，落库行仍在上限内', async () => {
    env.resetAll()
    login('me')
    const store = env.load('utils/opinion-store')
    const reads = {}
    for (let i = 0; i < store.MAX_STATUS_ENTRIES + 20; i++) {
      reads[`k${i}`] = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()
    }
    env.db.__seed('opinion_event_status', [{ _id: 'me', reads, follows: {}, updated_at: '' }])

    ok(await store.markEventRead('kFresh'))
    const row = env.db.__dump('opinion_event_status').find((r) => r._id === 'me')
    const total = Object.keys(row.reads).length + Object.keys(row.follows).length
    ok(total <= store.MAX_STATUS_ENTRIES, `落库后 ${total} 条，不得超过 ${store.MAX_STATUS_ENTRIES}`)
    ok('kFresh' in row.reads, '刚标记的必须保留')
  })
})

/* ───────────────────── 5. 端上字段 / 降级 / 限额 / 新事件 ───────────────────── */

describe('事件集合字段与端上结构一致（端上能直接读来渲染）', () => {
  it('落库事件经 toDisplayEvents 后，字段名与端上 OpinionEvent 完全一致', () => {
    const fn = loadCluster()
    env.db.__seed('feed_cache', [
      feedRow('张三#ent', [{ title: '关于X公司起诉事件的声明', source: 'A报', publishedDate: '2026-10-01' }])
    ])
    return fn.main({}).then(() => {
      const row = env.db.__dump('opinion_events')[0]
      const { toDisplayEvents } = env.load('utils/opinion-store')
      const { buildOpinionEvents } = env.load('utils/opinion-events')
      const disp = toDisplayEvents([row], {})[0]
      const tsEv = buildOpinionEvents({
        feed: [{ title: '关于X公司起诉事件的声明', source: 'A报', date: '2026-10-01', person: '张三' }]
      })[0]
      deepEq(Object.keys(disp).sort(), Object.keys(tsEv).sort(), '渲染字段名不得出现两套')
      eq(disp.key, row.event_key, 'key ← event_key')
      eq(disp.date, row.last_at, 'date ← last_at')
      eq(disp.objectKey, row.object_key, 'objectKey ← object_key')
      eq(disp.id, row.event_key)
    })
  })

  it('库结构里声明了两张集合与权限（events 只读 / status 仅创建者）', () => {
    const schema = read(path.join(CLOUD, 'dbInit', 'schema.js'))
    ok(/name: 'opinion_events'/.test(schema), 'schema 缺 opinion_events')
    ok(/name: 'opinion_event_status'/.test(schema), 'schema 缺 opinion_event_status')
    ok(/name: 'opinion_events'[\s\S]{0,200}acl: ACL\.publicReadOnly/.test(schema), 'opinion_events 必须「所有人可读、客户端不可写」')
    ok(/name: 'opinion_event_status'[\s\S]{0,200}acl: ACL\.creator/.test(schema), 'opinion_event_status 必须「仅创建者可读写」')
  })
})

describe('端上降级：读库失败 / 集合为空 → 回落本端聚类', () => {
  it('resolveDisplayEvents：空 / null → local；有行 → cloud', () => {
    env.resetAll()
    loginStore()
    const store = env.load('utils/opinion-store')
    const { buildOpinionEvents } = env.load('utils/opinion-events')
    const local = buildOpinionEvents({
      feed: [{ title: '本机临时事件', source: 'A报', date: '2026-10-01' }]
    })
    eq(local.length, 1)
    eq(store.resolveDisplayEvents(null, {}, local).source, 'local', '读失败（null）→ 本端聚类')
    eq(store.resolveDisplayEvents([], {}, local).source, 'local', '集合为空 → 本端聚类')
    eq(store.resolveDisplayEvents([], {}, local).events[0].title, '本机临时事件')

    const row = makeRow({ event_key: 'k1', title: '云端事件' })
    const r = store.resolveDisplayEvents([row], {}, local)
    eq(r.source, 'cloud', '有落库事件 → 用云端')
    eq(r.events[0].title, '云端事件')
  })

  it('loadStoredEvents：读失败返回 null（不抛、不返回空数组冒充「没有」）', async () => {
    env.resetAll()
    loginStore()
    const store = env.load('utils/opinion-store')
    env.db.__setReadFailing('opinion_events', true)
    eq(await store.loadStoredEvents(), null)
  })

  it('事件概要卡固定首屏（不按会员档放全）；单事件时间线仍按会员档限 5 条', () => {
    env.resetAll()
    const store = env.load('utils/opinion-store')
    const { overviewSlice, EVENT_OVERVIEW_INITIAL, sliceDetail } = env.load('utils/opinion-access')
    const rows = Array.from({ length: 9 }, (_, i) =>
      makeRow({
        event_key: `k${i}`,
        title: `事件${i}`,
        last_at: `2026-10-0${(i % 9) + 1}`,
        timeline: Array.from({ length: 9 }, (_, j) => ({ date: `2026-09-0${(j % 9) + 1}`, source: `报${j}`, nature: 'media', text: `节点${j}`, block: 'feed', label: '' }))
      })
    )
    const events = store.toDisplayEvents(rows, {})
    eq(events.length, 9)
    /* 事件**列表**（概要卡）改为固定首屏 + 按需加载，与会员态无关 —— 不再走 sliceDetail(events, isMember) */
    eq(overviewSlice(events, EVENT_OVERVIEW_INITIAL).rows.length, EVENT_OVERVIEW_INITIAL, '概要卡首屏固定 3 条')
    eq(overviewSlice(events, EVENT_OVERVIEW_INITIAL).remaining, 6, '剩余 6 条按需加载')
    /* 分层门禁仍作用在**该事件的时间线**上（点进 pages/event 由那里把关） */
    eq(sliceDetail(events[0].timeline, false).rows.length, 5, '免费档时间线仍切到 5 条')
    eq(sliceDetail(events[0].timeline, true).rows.length, 9, '会员时间线看全部')
  })
})

describe('「新事件」判定规则', () => {
  it('没读过 → new；最近报道晚于已读时刻 → update；否则 seen；时间不可解析 → seen', () => {
    env.resetAll()
    const { eventNewness, newnessLabel } = env.load('utils/opinion-store')
    const row = { event_key: 'k', last_at: '2026-10-05T00:00:00.000Z' }
    eq(eventNewness(row, { reads: {}, follows: {} }), 'new')
    eq(eventNewness(row, { reads: { k: '2026-10-04T00:00:00.000Z' }, follows: {} }), 'update')
    eq(eventNewness(row, { reads: { k: '2026-10-06T00:00:00.000Z' }, follows: {} }), 'seen')
    eq(eventNewness(row, { reads: { k: '不是日期' }, follows: {} }), 'seen')
    eq(eventNewness({ event_key: '', last_at: '' }, {}), 'seen')
    eq(newnessLabel('new'), 'NEW')
    eq(newnessLabel('update'), '有新进展')
    eq(newnessLabel('seen'), '')
  })
})

/* ───────────────────── 6. 舆情页静态约束（P4 交互与降级接入） ───────────────────── */

describe('舆情页：落库事件优先 + 已读/跟进 + 降级（静态约束）', () => {
  const page = read(path.join(ROOT, 'src', 'pages', 'opinion', 'index.tsx'))
  const scss = read(path.join(ROOT, 'src', 'pages', 'opinion', 'index.scss'))

  it('事件卡优先读落库事件，读不到回落到本端聚类（buildOpinionEvents 仍在页面里）', () => {
    ok(page.includes("from '@/utils/opinion-store'"), '舆情页应引用 opinion-store')
    ok(page.includes('resolveDisplayEvents('), '事件取数走 resolveDisplayEvents（落库优先）')
    ok(page.includes('buildOpinionEvents('), '降级要能回落到本端聚类（buildOpinionEvents 仍在页面）')
    ok(page.includes('loadStoredEvents(') && page.includes('loadEventStatus('), '要读落库事件与我的状态')
  })

  it('新增「已读 / 跟进」交互（沿用页面风格，不弹窗）', () => {
    ok(page.includes('markRead(') && page.includes('markEventRead('), '缺标记已读')
    ok(page.includes('toggleFollow(') && page.includes('setEventFollow('), '缺跟进切换')
    ok(page.includes('eventNewness(') && page.includes('newnessLabel('), '缺「新事件」角标判定')
    notOk(/showModal/.test(page), '不得引入弹窗（沿用克制的行内交互）')
    ok(scss.includes('&__event-actions') && scss.includes('&__action') && scss.includes('&__badge'), '缺交互样式')
  })

  it('降级：不新增第四处 status:"error"（读库失败走本端聚类，不算「一块读失败」）', () => {
    const errCount = (page.match(/status: 'error'/g) || []).length
    eq(errCount, 3, `每块各自 catch 降级，期望仍是 3 处，实际 ${errCount}`)
  })
})

/* ───────────────────── helpers ───────────────────── */

function loginStore() {
  env.load('stores/auth').useAuth.getState().setLogin({ userId: 'me' })
}

function makeRow(over = {}) {
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
