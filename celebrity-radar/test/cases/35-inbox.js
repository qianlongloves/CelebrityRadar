'use strict'

/**
 * 站内触达收口：统一「新内容」口径的纯函数层（2026-10-13）。
 *
 * 订阅消息推送当前未配置（功能完整保留，个人主体 + 机械电子产品类目拿不到模板），召回改由站内承担。
 * 本文件钉住 utils/inbox 的四件事：
 *
 *   1. **统一判据**：一条内容算「新」⟺ 时间可解析且晚于基线；脏数据 / 无数据 / 超上限一律不抛；
 *   2. **跨模块计数口径**：关注动态（followed_at 基线）、关键词预警（seen_at 基线）、
 *      风险信号（本机 inbox:seen.risk）、舆情事件（复用 opinion_event_status.reads）各走各的基线；
 *   3. **查看后清零**：markModuleSeen / clearInboxSeen 推进、清空基线，计数随之归零 / 重新计；
 *   4. **失败降级**：任一模块读失败只把它算作 0，loadInboxSummary 绝不抛。
 *
 * 事件维度必须与 opinion_event_status.reads 一致（已读的不算新）—— 这是与既有状态打通的关键。
 */

const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const BUILD = path.resolve(__dirname, '..', '.build')

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
/** 相对当前时刻取基准，用例不依赖系统日期 */
const NOW = Date.now()
const T0 = NOW - 30 * DAY
const iso = (ms) => new Date(ms).toISOString()

/** 让 isCloudConfigured 为真（在 load 业务模块之前改配置对象，与 13-messages 同法） */
function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

function fresh() {
  env.resetAll()
  configureCloud()
  return env
}

function login(id = 'me') {
  env.load('stores/auth').useAuth.getState().setLogin({ userId: id })
  return id
}

/* ============================ 1. 统一判据（纯函数） ============================ */

describe('站内口径：统一判据 isNewSince / countNew（不抛）', () => {
  it('「新」= 时间可解析且晚于基线；等于或早于都不算', () => {
    const { isNewSince } = env.load('utils/inbox')
    const base = Date.parse('2026-10-01T00:00:00.000Z')
    eq(isNewSince('2026-10-02T00:00:00.000Z', base), true)
    eq(isNewSince('2026-10-01T00:00:00.000Z', base), false, '等于基线不算新')
    eq(isNewSince('2026-09-30T00:00:00.000Z', base), false)
  })

  it('时间缺失 / 不可解析 → 不算新（算不出就不猜）', () => {
    const { isNewSince } = env.load('utils/inbox')
    for (const bad of [null, undefined, '', '这不是时间']) {
      eq(isNewSince(bad, 0), false, `${String(bad)} 不该算新`)
    }
  })

  it('基线缺失 / 不可解析 → 视作 0：一切有时间的内容都算新（与 messages 旧基线同口径）', () => {
    const { isNewSince } = env.load('utils/inbox')
    eq(isNewSince('2026-10-02T00:00:00.000Z', undefined), true)
    eq(isNewSince('2026-10-02T00:00:00.000Z', NaN), true)
    eq(isNewSince('2026-10-02T00:00:00.000Z', null), true)
  })

  it('countNew：无数据 / 非数组 / 脏时间一律跳过、不抛', () => {
    const { countNew } = env.load('utils/inbox')
    for (const bad of [[], null, undefined, 'not-array', 42]) {
      eq(countNew(bad), 0, `${String(bad)} 应为 0`)
    }
    eq(
      countNew([{ at: '2026-10-02T00:00:00.000Z' }, { at: null }, {}, { at: '坏时间' }]),
      1,
      '只留下唯一一条时间可解析的'
    )
  })

  it('countNew：超上限 —— limit 只统计前 N 条，不无界遍历', () => {
    const { countNew } = env.load('utils/inbox')
    const many = Array.from({ length: 10 }, () => ({ at: iso(NOW + DAY) }))
    eq(countNew(many), 10)
    eq(countNew(many, 3), 3, 'limit 生效')
    eq(countNew(many, 0), 10, 'limit = 0 表示不限制')
  })
})

/* ============================ 2. 跨模块计数口径 ============================ */

describe('站内口径：跨模块计数（各自基线，不另造）', () => {
  it('关注动态 = hasNew 的人数（基线是每个人的 followed_at，复用 watch）', () => {
    const { feedNewCount } = env.load('utils/inbox')
    eq(feedNewCount({ a: { hasNew: true }, b: { hasNew: false }, c: {} }), 1)
    eq(feedNewCount({}), 0)
    for (const bad of [null, undefined, 'x', 1]) eq(feedNewCount(bad), 0)
  })

  it('关键词预警 = 各词 newCount 之和（基线是每个词的 seen_at，复用 loadAlerts）', () => {
    const { alertNewCount } = env.load('utils/inbox')
    eq(alertNewCount([{ newCount: 2 }, { newCount: 0 }, {}, { newCount: -5 }, { newCount: 'x' }]), 2)
    for (const bad of [null, undefined, 'x']) eq(alertNewCount(bad), 0)
  })

  it('风险信号 = first_seen_at 晚于本机基线（inbox:seen.risk）的条数', () => {
    const { riskNewCount } = env.load('utils/inbox')
    const base = Date.parse('2026-10-03T00:00:00.000Z')
    const rows = [
      { first_seen_at: '2026-10-04T00:00:00.000Z' }, // 新
      { first_seen_at: '2026-10-03T00:00:00.000Z' }, // 等于基线 → 不算新
      { first_seen_at: '2026-09-01T00:00:00.000Z' },
      { first_seen_at: '坏时间' },
      null
    ]
    eq(riskNewCount(rows, base), 1)
    eq(riskNewCount(rows, undefined), 3, '基线缺失 → 三条有时间（>0）的都算新；坏时间 / null 跳过')
    eq(riskNewCount(rows, base, 1), 1, 'limit 生效')
    eq(riskNewCount(null, base), 0)
  })

  it('summarizeInbox：脏值按 0、给出合计', () => {
    const { summarizeInbox } = env.load('utils/inbox')
    deepEq(summarizeInbox({ feed: 1, alert: 2, risk: 3, event: 4 }), {
      feed: 1,
      alert: 2,
      risk: 3,
      event: 4,
      total: 10
    })
    deepEq(summarizeInbox({ feed: -1, alert: NaN, risk: undefined, event: 'x' }), {
      feed: 0,
      alert: 0,
      risk: 0,
      event: 0,
      total: 0
    })
    deepEq(summarizeInbox(null).total, 0)
  })
})

/* ============================ 3. 本机基线存储 ============================ */

describe('站内口径：本机「上次查看」存储（容错 + 超上限）', () => {
  it('无记录 → 空对象；写坏 JSON → 空对象（绝不抛）', () => {
    const { readInboxSeen, INBOX_SEEN_KEY } = fresh() && env.load('utils/inbox')
    deepEq(readInboxSeen(), {})
    env.storage.set(INBOX_SEEN_KEY, '{不是合法 JSON')
    deepEq(readInboxSeen(), {})
  })

  it('只认已知模块 + 正数毫秒；未知键 / 负数 / 不可解析值一律丢弃', () => {
    const { readInboxSeen, INBOX_SEEN_KEY } = env.load('utils/inbox')
    env.storage.set(
      INBOX_SEEN_KEY,
      JSON.stringify({ feed: 111, alert: -3, risk: 'notdate', event: '2026-10-01T00:00:00.000Z', bogus: 9 })
    )
    const seen = readInboxSeen()
    eq(seen.feed, 111)
    eq(seen.alert, undefined, '负数丢弃')
    eq(seen.risk, undefined, '不可解析丢弃')
    eq(seen.event, Date.parse('2026-10-01T00:00:00.000Z'), '可解析字符串转成毫秒')
    eq(seen.bogus, undefined, '未知模块键丢弃')
  })

  it('writeInboxSeen 只落已知模块；markModuleSeen 推进到 max(now, 传入时刻)', () => {
    const { readInboxSeen, writeInboxSeen, markModuleSeen } = env.load('utils/inbox')
    writeInboxSeen({ feed: 1, bogus: 2 })
    const after = readInboxSeen()
    eq(after.feed, 1)
    eq(after.bogus, undefined)

    const past = iso(T0)
    markModuleSeen('risk', past) /* 传入时刻在过去 → 取 now */
    ok(readInboxSeen().risk >= Date.now() - 2000, '基线应推进到 now 附近')

    const future = iso(Date.now() + 5 * DAY)
    markModuleSeen('risk', future) /* 传入时刻在未来 → 取较晚者（内容时间可能领先本机时钟） */
    eq(readInboxSeen().risk, Date.parse(future))
  })

  it('clearInboxSeen 清空本机基线', () => {
    const { writeInboxSeen, readInboxSeen, clearInboxSeen } = env.load('utils/inbox')
    writeInboxSeen({ risk: Date.now() })
    ok(readInboxSeen().risk)
    clearInboxSeen()
    deepEq(readInboxSeen(), {})
  })
})

/* ============================ 4. 事件维度与 reads 一致 ============================ */

describe('站内口径：事件维度复用 opinion_event_status.reads', () => {
  const rows = [{ key: 'a', at: '2026-10-05T00:00:00.000Z' }]

  it('没读过 → 算新；已读且无新进展 → 不算新；已读但有更晚报道 → 算新', () => {
    const { countNewEvents } = env.load('utils/inbox')
    eq(countNewEvents(rows, { reads: {}, follows: {} }), 1, '没读过 → 新')
    eq(countNewEvents(rows, { reads: { a: '2026-10-06T00:00:00.000Z' }, follows: {} }), 0, '已读之后没有更晚报道 → 不算新')
    eq(countNewEvents(rows, { reads: { a: '2026-10-04T00:00:00.000Z' }, follows: {} }), 1, '已读之后又有更晚报道 → 新')
  })

  it('脏输入 / 空输入不抛；无效 key 跳过；超上限 limit 生效', () => {
    const { countNewEvents } = env.load('utils/inbox')
    eq(countNewEvents(null, { reads: {}, follows: {} }), 0)
    eq(countNewEvents([{ key: '', at: '2026-10-05T00:00:00.000Z' }], {}), 0, '空 key 跳过')
    /* 未读事件即使时间不可解析也算新 —— 与 opinion-store#eventNewness 同口径（没读过 → new），不另判 */
    eq(countNewEvents([null, { key: 'b', at: '坏时间' }], {}), 1, 'null 跳过；未读事件算新')
    eq(countNewEvents([{ key: 'b', at: '坏时间' }], { reads: { b: iso(T0) }, follows: {} }), 0, '已读且时间算不出 → 不算新')
    const many = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, at: iso(NOW + DAY) }))
    eq(countNewEvents(many, {}), 5)
    eq(countNewEvents(many, {}, 2), 2)
  })

  it('与 opinion-store#eventNewness 逐输入一致（同一口径，不另立事件已读）', () => {
    const { countNewEvents } = env.load('utils/inbox')
    const { eventNewness } = env.load('utils/opinion-store')
    const status = { reads: { a: '2026-10-04T00:00:00.000Z' }, follows: {} }
    const list = [{ key: 'a', at: '2026-10-05T00:00:00.000Z' }, { key: 'b', at: '2026-10-01T00:00:00.000Z' }]
    const expect = list.filter((e) => eventNewness({ event_key: e.key, last_at: e.at }, status) !== 'seen').length
    eq(countNewEvents(list, status), expect)
  })
})

/* ============================ 5. 查看后清零（端到端） ============================ */

describe('站内口径：查看后清零 / 冷启动', () => {
  it('风险信号：标记已看后归零；清空基线后又全部算新（冷启动=视为从未看过）', () => {
    const { riskNewCount, markModuleSeen, clearInboxSeen } = env.load('utils/inbox')
    const signals = [{ first_seen_at: iso(T0 + HOUR) }, { first_seen_at: iso(T0 + 2 * HOUR) }]

    eq(riskNewCount(signals, undefined), 2, '冷启动（无基线）→ 全部算新')

    markModuleSeen('risk') /* 进预警页 / 点「全部已读」 */
    eq(riskNewCount(signals, env.load('utils/inbox').readInboxSeen().risk), 0, '仅记到当前时刻 → 旧信号不再算新')

    clearInboxSeen()
    eq(riskNewCount(signals, env.load('utils/inbox').readInboxSeen().risk), 2, '基线被清（清空我的数据）→ 重新算新')
  })

  it('新内容在标记之后到达 → 仍算新（只覆盖当时那批）', () => {
    const { riskNewCount, markModuleSeen, readInboxSeen } = env.load('utils/inbox')
    markModuleSeen('risk')
    const later = [{ first_seen_at: iso(Date.now() + DAY) }]
    eq(riskNewCount(later, readInboxSeen().risk), 1)
  })
})

/* ============================ 6. 只读汇总 + 失败降级 ============================ */

/** report_cache 行：state=ready + report，才被 watch 视作「报告重生」 */
function seedReport(db, personKey, generatedAt, heat = 60) {
  db.__seed('report_cache', [
    {
      _id: personKey,
      state: 'ready',
      builder: null,
      generated_at: generatedAt,
      report: {
        personKey,
        name: personKey.split('#')[0],
        mode: 'realtime',
        generatedAt,
        heat,
        intro: '简介',
        dynamics: [],
        quotes: [],
        analysis: '点评',
        disclaimer: '免责声明'
      }
    }
  ])
}

describe('站内口径：loadInboxSummary 汇总与失败降级', () => {
  it('未登录 / 无数据 → 全 0，不抛', async () => {
    fresh()
    const s = await env.load('utils/inbox').loadInboxSummary()
    deepEq(s, { feed: 0, alert: 0, risk: 0, event: 0, total: 0 })
  })

  it('四模块各自口径汇总：feed / alert / risk / event 各 1 条', async () => {
    const { db } = fresh()
    login('me')
    /* 关注动态：关注之后报告重生 → hasNew */
    db.__seed('follows', [
      { _id: 'me#张三#tech', openid: 'me', person_key: '张三#tech', name: '张三', domain: 'tech', followed_at: iso(T0) }
    ])
    seedReport(db, '张三#tech', iso(T0 + HOUR))
    /* 关键词预警：订阅早于条目 first_seen_at（基线 seen_at < 条目时间） */
    db.__seed('keyword_watches', [
      {
        _id: 'me#雷军',
        openid: 'me',
        keyword: '雷军',
        created_at: iso(T0),
        seen_at: iso(T0),
        type: 'keyword'
      },
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
        fetched_at: iso(T0 + 2 * HOUR),
        items: [{ title: '雷军相关', url: 'https://a', source: '某报', first_seen_at: iso(T0 + 2 * HOUR) }]
      }
    ])
    /* 风险信号：无本机基线 → 冷启动算新 */
    db.__seed('risk_signals', [
      { _id: 's1', person_key: '李四#tech', name: '李四', title: '风险信号', source: '某报', first_seen_at: iso(T0 + 3 * HOUR), category: 'judicial', level: 'high' }
    ])
    /* 舆情事件：无状态 → 未读 → 算新 */
    db.__seed('opinion_events', [{ _id: 'e1', event_key: 'evt1', last_at: iso(T0 + 4 * HOUR) }])

    const s = await env.load('utils/inbox').loadInboxSummary()
    eq(s.feed, 1, '关注动态：1 人有新内容')
    eq(s.alert, 1, '关键词预警：1 条新增')
    eq(s.risk, 1, '风险信号：冷启动 1 条算新')
    eq(s.event, 1, '舆情事件：1 条未读')
    eq(s.total, 4)
  })

  it('单模块读失败只把它算 0，整体不抛（失败降级）', async () => {
    const { db } = fresh()
    login('me')
    db.__seed('keyword_watches', [
      { _id: 'me#雷军', openid: 'me', keyword: '雷军', created_at: iso(T0), seen_at: iso(T0), type: 'keyword' }
    ])
    db.__seed('keywords', [
      { _id: '雷军', keyword: '雷军', fetched_at: iso(T0 + HOUR), items: [{ title: 'x', url: 'https://a', source: 's', first_seen_at: iso(T0 + HOUR) }] }
    ])
    db.__seed('opinion_events', [{ _id: 'e1', event_key: 'evt1', last_at: iso(T0 + HOUR) }])

    /* 让事件集合读取失败：预警仍应被算到，事件降级为 0 */
    db.__setFailing('opinion_events', true)

    const s = await env.load('utils/inbox').loadInboxSummary()
    eq(s.alert, 1, '预警不受影响')
    eq(s.event, 0, '事件读失败 → 降级为 0')
    ok(Number.isFinite(s.total), '整体仍返回可用结果，不抛')
  })

  it('事件维度与 reads 打通：标记已读后汇总里不再算新', async () => {
    const { db } = fresh()
    login('me')
    db.__seed('opinion_events', [{ _id: 'e1', event_key: 'evt1', last_at: iso(T0 + HOUR) }])
    db.__seed('opinion_event_status', [
      { _id: 'me', reads: { evt1: iso(T0 + 2 * HOUR) }, follows: {} }
    ])

    const s = await env.load('utils/inbox').loadInboxSummary()
    eq(s.event, 0, '已读且无更晚报道 → 不算新')
  })
})

/* ============================ 7. 页面静态约束 ============================ */

describe('站内触达收口：页面接入（静态约束）', () => {
  const fs = require('fs')
  const SRC = path.resolve(__dirname, '..', '..', 'src')
  const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

  it('首页：已移除「舆情」入口 + 红点，也不再为首屏红点做汇总读（2026-10-13）', () => {
    const page = read('pages/index/index.tsx')
    /* 回归锁：去掉入口要连「只为首页红点的只读汇总」一起清掉，否则白留 6 次首屏只读 */
    notOk(page.includes("from '@/utils/inbox'"), '首页不应再引用 utils/inbox')
    notOk(page.includes('loadInboxSummary('), '首页不应再调用统一汇总（那是只为首页红点的只读 DB 请求）')
    notOk(page.includes('page-index__opinion'), '首页不应再有「舆情」入口')
    notOk(page.includes('goOpinion'), '首页不应再有「舆情」跳转函数')
    /* 铃铛（消息中心）必须保留 */
    ok(page.includes('page-index__bell') && page.includes('onBellTap'), '消息铃铛必须保留')
  })

  it('舆情页：入口化后保留「新 N 条」inbox 口径（预警/风险/事件），并提供「全部已读」', () => {
    const page = read('pages/opinion/index.tsx')
    ok(page.includes("from '@/utils/inbox'"), '舆情页应引用 utils/inbox')
    /* P9 入口化后，关注动态的「新 N 条」角标随卡一起移到 feed 完整页，舆情页不再有 feedNewCount */
    ok(page.includes('alertNewCount(') && page.includes('riskNewCount('), '预警/风险信号的新计数走 inbox 口径')
    ok(page.includes('countNewEvents('), '事件维度走 inbox（复用 reads）')
    ok(page.includes('markAllSeen('), '「全部已读」应复用既有 markAllSeen 清关键词')
    ok(page.includes('markModuleSeen('), '风险信号基线应被推进')
    ok(page.includes('markEventsRead('), '事件应批量走 opinion_event_status.reads')
    ok(page.includes('新 {eventNew} 条'), '事件卡保留「新 N 条」角标')
  })

  it('预警页 / 关注列表：既有「新」计数接到同一口径函数上', () => {
    ok(read('package/alerts/index.tsx').includes('alertNewCount('), '预警页新增之和走 alertNewCount')
    ok(read('package/alerts/index.tsx').includes('markModuleSeen('), '进预警页应推进风险基线')
    ok(read('package/following/index.tsx').includes('feedNewCount('), '关注列表「有新内容」人数走 feedNewCount')
  })

  it('「清空我的数据」会一并清掉本机 inbox 基线', () => {
    /* 2026-10-17：清空 / 撤回 / 注销三处都迁到 package/settings，清理入口随之搬过去 */
    const page = read('package/settings/index.tsx')
    ok(page.includes("from '@/utils/inbox'") && page.includes('clearInboxSeen()'), '缺少 clearInboxSeen')
  })
})
