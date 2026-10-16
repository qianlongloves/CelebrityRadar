'use strict'

/**
 * N-2 报告更新回访（站内，2026-10-16）：
 * `utils/revisit.ts`（判据）+ `utils/history.ts#markReportViewed`（指纹写口）
 * + `utils/messages.ts`（落成消息中心一类）+ `package/messages` / `package/report`（接线）。
 *
 * 这一版要钉的是「**凭什么**告诉用户『你看过的人有变化』」。做错的形态全都长得像对的 ——
 * 列表照常出现、字也通顺，只是那句话是编的：
 *
 *   1. **没有指纹就不算**。存量浏览历史、以及报告没读出来就退出的那几次访问，都没有
 *      「我看的是哪一版」。此时唯一的合法结论是「没有证据」。拿访问时间顶替的话，
 *      任何三天前看过的人都会在三天后被告知「他有变化」—— 这正是路线图里写死的
 *      「明确不做『随便推个旧人回来』」。
 *   2. **必须严格晚于**：指纹与当前版相同（就是这一版）不算变过，早于更不算。
 *   3. **`building` 不算**：抢锁会把 `generated_at` 提前置成 now，而正文还是上一版的 ——
 *      拿它判定就是「报告还没变就报变过」。
 *   4. **同一人只看最近看过的那条**：A→B→A 会在浏览历史里留下多行，判据问的是
 *      「我上次看他是哪一版」，取错了就会拿一份很旧的指纹去比，稳定误报。
 *   5. **指纹只改行、不新增行**：写口只有 addHistory 一个；多一个写口，「连续同一人跳过」
 *      的口径立刻分家。幂等同样重要：报告页每次看到正文都会调它，值没变不该付写库。
 *   6. **折叠不静默**：超出 REVISIT_MAX 的部分要如实报数（同 S3-3）。
 *
 * 页面侧（报告页在 `phase === 'ready'` 才写指纹、消息中心的图标与两条埋点）走源码级静态断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const BUILD = path.resolve(__dirname, '..', '.build')
const read = (p) => fs.readFileSync(p, 'utf8')

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
/** 相对当前时刻取基准，用例不依赖系统日期 */
const NOW = Date.now()
const T0 = NOW - 30 * DAY
const iso = (ms) => new Date(ms).toISOString()

/** 与 13-messages 同一手法：isCloudConfigured 是模块级常量，必须在 load 之前改配置对象 */
function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

function fresh() {
  env.resetAll()
  configureCloud()
  return { db: env.db, load: env.load, storage: env.storage }
}

function login(id = 'me') {
  env.load('stores/auth').useAuth.getState().setLogin({ userId: id })
  return id
}

/* --------------------------------------------------------------- 造数 */

/** 浏览历史行；`viewed` 传 undefined = 存量行（没有版本指纹） */
function hist(personKey, opts) {
  const o = opts || {}
  const ts = o.ts
  const openid = o.openid || 'me'
  const row = {
    _id: `${openid}#${ts}_${personKey}`,
    openid,
    person_key: personKey,
    name: o.name || personKey.split('#')[0],
    ts
  }
  if (o.viewed !== undefined) row.viewed_generated_at = o.viewed
  return row
}

/**
 * report_cache 轻量行（判定只读 id / generated_at / state）。
 *
 * ⚠ `_id` 与 `id` 都给：`__seed` 要的是 DB 口径（`_id`），而纯函数用例喂的是**端上读口形状** ——
 * db.ts#toRow 会把 `_id` 映回 `id`，判定侧读的正是 `id`。只给 `_id` 时纯函数用例会**全部空跑**
 * （一个候选都产不出，负向断言照样「通过」），那是最难发现的一种假绿。
 */
const cache = (personKey, generatedAt, state) => ({
  _id: personKey,
  id: personKey,
  state: state || 'ready',
  generated_at: generatedAt,
  report: { personKey, generatedAt, name: personKey.split('#')[0] }
})

const reportItem = (feed, personKey) => feed.items.find((i) => i.id === `report_update#${personKey}`)
const moreItem = (feed) => feed.items.find((i) => i.id === 'report_update#more')

/* ═══════════════════════ 1. 判据（纯函数） ═══════════════════════ */

describe('N-2 判据：两个时间戳，少一个都不算（utils/revisit）', () => {
  const R = () => {
    env.resetAll()
    return env.load('utils/revisit')
  }

  it('指纹与当前版相同 → 不算变过（就是这一版）', () => {
    const { buildRevisitItems } = R()
    const at = iso(T0 + HOUR)
    deepEq(buildRevisitItems([hist('A#tech', { ts: iso(T0 + 2 * HOUR), viewed: at })], [cache('A#tech', at)]), [])
  })

  it('当前版早于指纹 → 不算（缓存被别人回退过也不该报「更新」）', () => {
    const { buildRevisitItems } = R()
    const out = buildRevisitItems(
      [hist('A#tech', { ts: iso(T0 + 2 * HOUR), viewed: iso(T0 + 5 * HOUR) })],
      [cache('A#tech', iso(T0 + HOUR))]
    )
    deepEq(out, [])
  })

  it('严格晚于 → 算，且字段都摆对', () => {
    const { buildRevisitItems } = R()
    const viewed = iso(T0 + HOUR)
    const cur = iso(T0 + 3 * HOUR)
    const out = buildRevisitItems([hist('A#tech', { ts: iso(T0 + 2 * HOUR), viewed })], [cache('A#tech', cur)])
    eq(out.length, 1)
    eq(out[0].personKey, 'A#tech')
    eq(out[0].name, 'A')
    eq(out[0].viewedAt, iso(T0 + 2 * HOUR))
    eq(out[0].viewedVersion, viewed)
    eq(out[0].currentVersion, cur)
  })

  it('没有指纹的存量行 → 不算（**不许拿访问时间顶替**，这就是「不推旧人」）', () => {
    const { buildRevisitItems } = R()
    /* 三天前看过，报告也确实更新过 —— 但没有任何证据说明他看的是哪一版 */
    const out = buildRevisitItems(
      [hist('A#tech', { ts: iso(T0 + 27 * DAY) })],
      [cache('A#tech', iso(T0 + 28 * DAY))]
    )
    deepEq(out, [], '缺证据时的合法结论只有「没有证据」')
  })

  it('指纹不可解析 → 不算（不许当 0：0 比任何时间都早，会全量误报）', () => {
    const { buildRevisitItems } = R()
    deepEq(
      buildRevisitItems([hist('A#tech', { ts: iso(T0), viewed: '这不是一个时间' })], [cache('A#tech', iso(T0 + HOUR))]),
      []
    )
  })

  it('当前版生成时间不可解析 → 不算', () => {
    const { buildRevisitItems } = R()
    /* ⚠ 夹具刻意避开 `2026-10-9 10:00` 这类字符串：V8 的退化解析能吃下它（`Date.parse` 不是 NaN），
       拿它当「不可解析」会让「算不出就当变过」这条口径被漏掉 */
    deepEq(
      buildRevisitItems([hist('A#tech', { ts: iso(T0), viewed: iso(T0 + HOUR) })], [cache('A#tech', '待定')]),
      []
    )
  })

  it('building / 缺 state → 不算（正文还是上一版的，报「变过」就是编的）', () => {
    const { buildRevisitItems } = R()
    const row = hist('A#tech', { ts: iso(T0 + 2 * HOUR), viewed: iso(T0 + HOUR) })
    const cur = iso(T0 + 3 * HOUR)
    /* 正向对照：同一份输入、只把 state 换成 ready 就**必须**产出 —— 否则下面两条空断言
       可能只是因为「这套夹具根本产不出东西」而通过（假绿） */
    eq(buildRevisitItems([row], [cache('A#tech', cur)]).length, 1)
    deepEq(buildRevisitItems([row], [cache('A#tech', cur, 'building')]), [])
    deepEq(buildRevisitItems([row], [{ id: 'A#tech', generated_at: cur }]), [])
  })

  it('report_cache 里没有这个人 → 不算', () => {
    const { buildRevisitItems } = R()
    deepEq(buildRevisitItems([hist('A#tech', { ts: iso(T0), viewed: iso(T0) })], []), [])
  })

  it('同一人多行：只取**最近看过**的那条（取错会拿很旧的指纹去比，稳定误报）', () => {
    const { buildRevisitItems } = R()
    const cur = iso(T0 + 10 * HOUR)
    const rows = [
      /* 最近一次看的就是当前版（没有变化）；更早那次看的是旧版（有变化） */
      hist('A#tech', { ts: iso(T0 + 9 * HOUR), viewed: cur }),
      hist('A#tech', { ts: iso(T0 + 2 * HOUR), viewed: iso(T0 + HOUR) })
    ]
    deepEq(buildRevisitItems(rows, [cache('A#tech', cur)]), [], '最近一次看的是当前版 ⇒ 他没有「没看到的新东西」')
    deepEq(buildRevisitItems(rows.slice().reverse(), [cache('A#tech', cur)]), [], '结论不许依赖行的先后顺序')
  })

  it('按变化时间倒序（这一屏的顺序就是「先看谁」）', () => {
    const { buildRevisitItems } = R()
    const out = buildRevisitItems(
      [
        hist('A#tech', { ts: iso(T0), viewed: iso(T0) }),
        hist('B#tech', { ts: iso(T0), viewed: iso(T0) }),
        hist('C#tech', { ts: iso(T0), viewed: iso(T0) })
      ],
      [cache('A#tech', iso(T0 + 2 * HOUR)), cache('B#tech', iso(T0 + 9 * HOUR)), cache('C#tech', iso(T0 + 5 * HOUR))]
    )
    deepEq(
      out.map((i) => i.personKey),
      ['B#tech', 'C#tech', 'A#tech']
    )
  })

  it('文案：两个时间都说出来（相对时间，不写死）', () => {
    const { revisitDescText, revisitOverflowText } = R()
    const text = revisitDescText({
      personKey: 'A#tech',
      name: 'A',
      viewedAt: iso(NOW - 3 * DAY),
      viewedVersion: iso(NOW - 3 * DAY),
      currentVersion: iso(NOW - 2 * HOUR)
    })
    ok(/你上次看过/.test(text), '要说清「你上次看过」，而不是含糊的「报告变过」')
    ok(/3 天前/.test(text) && /小时前/.test(text), '看过的时间与这一版生成的时间都要有')
    eq(revisitOverflowText(0), '', '没有折叠就不出这句')
    ok(/另有 3 位/.test(revisitOverflowText(3)), '折叠数如实说出（不许静默截断）')
  })
})

/* ═══════════════════════ 2. 指纹写口 ═══════════════════════ */

describe('N-2 指纹：只改行、不新增行，且幂等（history#markReportViewed）', () => {
  it('把该人最近一条浏览记录的指纹改成这一版', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [hist('A#tech', { ts: iso(T0), viewed: iso(T0 + HOUR) })])
    const before = db.__dump('history').length
    const updates = db.stats.updateCalls

    await load('utils/history').markReportViewed('A#tech', iso(T0 + 5 * HOUR))

    eq(db.__dump('history')[0].viewed_generated_at, iso(T0 + 5 * HOUR))
    eq(db.__dump('history').length, before, '只改行：写口只有 addHistory 一个，这里不该新增行')
    eq(db.stats.updateCalls - updates, 1)
  })

  it('值没变就不写库（报告页每次看到正文都会调它）', async () => {
    const { db, load } = fresh()
    login()
    const at = iso(T0 + 5 * HOUR)
    db.__seed('history', [hist('A#tech', { ts: iso(T0), viewed: at })])
    const updates = db.stats.updateCalls

    await load('utils/history').markReportViewed('A#tech', at)

    eq(db.stats.updateCalls - updates, 0, '幂等不成立的话，每进一次报告页都白付一次写')
  })

  it('该人没有浏览记录 → 什么都不做（绝不新增行）', async () => {
    const { db, load } = fresh()
    login()
    const before = db.__dump('history').length
    const updates = db.stats.updateCalls

    await load('utils/history').markReportViewed('A#tech', iso(T0 + 5 * HOUR))

    eq(db.__dump('history').length, before)
    eq(db.stats.updateCalls - updates, 0)
  })

  it('只改**该人最近**那条：别人的记录、他自己更早的记录都不动', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [
      hist('A#tech', { ts: iso(T0 + 4 * HOUR), viewed: iso(T0) }),
      hist('B#tech', { ts: iso(T0 + 3 * HOUR), viewed: iso(T0) }),
      hist('A#tech', { ts: iso(T0 + 2 * HOUR), viewed: iso(T0) })
    ])

    await load('utils/history').markReportViewed('A#tech', iso(T0 + 5 * HOUR))

    const rows = db.__dump('history')
    const a = rows.filter((r) => r.person_key === 'A#tech')
    eq(a.find((r) => r.ts === iso(T0 + 4 * HOUR)).viewed_generated_at, iso(T0 + 5 * HOUR), '取 ts 最大的那条')
    eq(a.find((r) => r.ts === iso(T0 + 2 * HOUR)).viewed_generated_at, iso(T0), '更早那条不动')
    eq(rows.find((r) => r.person_key === 'B#tech').viewed_generated_at, iso(T0), '别人的不动')
  })

  it('未登录 / 版本为空 → 既不读也不写', async () => {
    const { db, load } = fresh()
    db.__seed('history', [hist('A#tech', { ts: iso(T0) })])
    const { markReportViewed } = load('utils/history')
    const gets = db.stats.getCalls
    const updates = db.stats.updateCalls

    await markReportViewed('A#tech', iso(T0 + HOUR))
    login()
    await markReportViewed('A#tech', '')

    eq(db.stats.getCalls - gets, 0)
    eq(db.stats.updateCalls - updates, 0)
  })

  it('读库失败不抛错（指纹只是增强判据，坏了不能连累报告页）', async () => {
    const { db, load } = fresh()
    login()
    db.__setFailing('history', true)
    await load('utils/history').markReportViewed('A#tech', iso(T0 + HOUR))
    ok(true, '不抛错即通过')
  })
})

/* ═══════════════════════ 3. 读口 ═══════════════════════ */

describe('N-2 读口：谁的报告变过（revisit#loadRevisits）', () => {
  it('有指纹且确实变过 → 报出来', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [hist('A#tech', { ts: iso(T0 + HOUR), viewed: iso(T0) })])
    db.__seed('report_cache', [cache('A#tech', iso(T0 + 5 * HOUR))])

    const out = await load('utils/revisit').loadRevisits()
    eq(out.length, 1)
    eq(out[0].personKey, 'A#tech')
    eq(out[0].currentVersion, iso(T0 + 5 * HOUR))
  })

  it('存量行（一行指纹都没有）→ 连 report_cache 都不查（默认路径的代价必须是 0）', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [hist('A#tech', { ts: iso(T0 + HOUR) }), hist('B#tech', { ts: iso(T0) })])
    db.__seed('report_cache', [cache('A#tech', iso(T0 + 5 * HOUR)), cache('B#tech', iso(T0 + 5 * HOUR))])
    const gets = db.stats.getCalls

    const out = await load('utils/revisit').loadRevisits()

    deepEq(out, [], '没有指纹就没有回访理由（见文件头第 1 条）')
    eq(db.stats.getCalls - gets, 1, '只该有那 1 次浏览历史读；report_cache 不该被碰')
  })

  it('批量查当前版：1 次历史 + 1 次 report_cache，与人数无关', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [
      hist('A#tech', { ts: iso(T0), viewed: iso(T0) }),
      hist('B#tech', { ts: iso(T0), viewed: iso(T0) }),
      hist('C#tech', { ts: iso(T0), viewed: iso(T0) })
    ])
    db.__seed('report_cache', [
      cache('A#tech', iso(T0 + HOUR)),
      cache('B#tech', iso(T0 + 2 * HOUR)),
      cache('C#tech', iso(T0 + 3 * HOUR))
    ])
    const gets = db.stats.getCalls

    const out = await load('utils/revisit').loadRevisits()

    eq(out.length, 3)
    eq(db.stats.getCalls - gets, 2)
  })

  it('未登录 → 一次库都不读，返回空', async () => {
    const { db, load } = fresh()
    const gets = db.stats.getCalls
    deepEq(await load('utils/revisit').loadRevisits(), [])
    eq(db.stats.getCalls - gets, 0)
  })

  it('读库失败 → 返回空数组，不抛错（消息中心少一类消息，绝不白屏）', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [hist('A#tech', { ts: iso(T0), viewed: iso(T0) })])
    db.__setFailing('report_cache', true)
    deepEq(await load('utils/revisit').loadRevisits(), [])
  })

  it('扫描上限 20 位：更早看过的人不进判定（回访理由是最近的，不是全部）', async () => {
    const { db, load } = fresh()
    const R = load('utils/revisit')
    eq(R.REVISIT_SCAN, 20)
    eq(R.REVISIT_MAX, 5)

    login()
    const rows = []
    for (let i = 0; i < 25; i++) rows.push(hist(`P${i}#tech`, { ts: iso(T0 + i * HOUR), viewed: iso(T0) }))
    db.__seed('history', rows)
    db.__seed(
      'report_cache',
      rows.map((r) => cache(r.person_key, iso(T0 + 100 * HOUR)))
    )

    const out = await R.loadRevisits()
    eq(out.length, 20, '只看最近 20 位：再往前的回访理由，用户自己也已经忘了')
  })
})

/* ═══════════════════════ 4. 消息中心成条 ═══════════════════════ */

describe('N-2 消息中心：报告更新成一类消息', () => {
  it('出现的那条：文案、落地页、事件时间、未读、按人可聚合', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [hist('A#tech', { name: '张三', ts: iso(T0 + HOUR), viewed: iso(T0) })])
    db.__seed('report_cache', [cache('A#tech', iso(T0 + 5 * HOUR))])

    const feed = await load('utils/messages').loadMessages()
    const item = reportItem(feed, 'A#tech')

    ok(item, '应有一条报告更新消息')
    eq(item.kind, 'report')
    eq(item.title, '张三 的报告更新了')
    ok(/你上次看过/.test(item.desc))
    eq(item.at, iso(T0 + 5 * HOUR), '事件时间取当前版的生成时间')
    eq(item.unread, true)
    eq(item.personKey, 'A#tech', '埋点要按人聚合回访点击')
    ok(/report-history/.test(item.url), '落在报告历史页 —— 「改了什么」的答案在那里（N-9 差异视图）')
    ok(/personKey=A%23tech/.test(item.url), 'personKey 要转义（`#` 不转义会把 URL 截断）')
    eq(feed.revisitTotal, 1)
  })

  it('**存量用户**：看过很多人、报告也确实更新过，但没有指纹就一条都不出现', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [hist('A#tech', { ts: iso(T0 + HOUR) }), hist('B#tech', { ts: iso(T0 + 2 * HOUR) })])
    db.__seed('report_cache', [cache('A#tech', iso(T0 + 9 * HOUR)), cache('B#tech', iso(T0 + 9 * HOUR))])

    const feed = await load('utils/messages').loadMessages()
    notOk(
      feed.items.some((i) => i.kind === 'report'),
      '「随便推个旧人回来」正是这条要挡住的事：没有证据就没有这句话'
    )
    eq(feed.revisitTotal, 0)
    ok(feed.items.length > 0, '其余消息照常工作')
  })

  it('已读之后报告又更新一版 → 同一条重新变未读（id 复用 + 事件时间变新）', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [hist('A#tech', { ts: iso(T0 + HOUR), viewed: iso(T0) })])
    db.__seed('report_cache', [cache('A#tech', iso(T0 + 5 * HOUR))])

    const M = load('utils/messages')
    const item = reportItem(await M.loadMessages(), 'A#tech')
    ok(item)
    M.markMessageRead(item.id, item.at)
    eq(reportItem(await M.loadMessages({ force: true }), 'A#tech').unread, false, '前置：已读')

    /* 又重生了一版：同一个人、同一个 id，但这是「新的一条」 */
    db.__seed('report_cache', [cache('A#tech', iso(T0 + 9 * HOUR))])
    const again = reportItem(await M.loadMessages({ force: true }), 'A#tech')
    eq(again.at, iso(T0 + 9 * HOUR))
    eq(again.unread, true, '只记 id 的话这里会永远已读 —— 那条静默失效正是 13-messages 钉住的同一件事')
  })

  it('超过 REVISIT_MAX：只列最近 5 位 + 一条如实报数的汇总行（不静默截断）', async () => {
    const { db, load } = fresh()
    login()
    const rows = []
    const caches = []
    for (let i = 0; i < 7; i++) {
      rows.push(hist(`P${i}#tech`, { ts: iso(T0 + i * HOUR), viewed: iso(T0) }))
      caches.push(cache(`P${i}#tech`, iso(T0 + (100 + i) * HOUR)))
    }
    db.__seed('history', rows)
    db.__seed('report_cache', caches)

    const feed = await load('utils/messages').loadMessages()
    const listed = feed.items.filter((i) => i.kind === 'report' && i.personKey)
    eq(listed.length, 5)
    eq(listed[0].personKey, 'P6#tech', '变化时间最近的排最前')
    eq(feed.revisitTotal, 7, '总数如实报出（含被折叠的 2 位）')

    const more = moreItem(feed)
    ok(more, '折叠要有交代')
    ok(/另有 2 位/.test(more.title))
    notOk(more.personKey, '汇总行不属于某个人')
    ok(/浏览历史/.test(more.desc) && /history/.test(more.url), '汇总行的下一步要真的存在')
  })

  it('与关注类消息互不干扰，未读数仍与列表同源', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('follows', [
      { _id: 'me#B#tech', openid: 'me', person_key: 'B#tech', name: 'B', domain: 'tech', followed_at: iso(T0) }
    ])
    db.__seed('history', [hist('A#tech', { ts: iso(T0 + HOUR), viewed: iso(T0) })])
    db.__seed('report_cache', [cache('A#tech', iso(T0 + 5 * HOUR)), cache('B#tech', iso(T0 + 6 * HOUR))])

    const feed = await load('utils/messages').loadMessages()
    ok(reportItem(feed, 'A#tech'), '报告更新在')
    ok(
      feed.items.some((i) => i.id === 'follow#B#tech'),
      '关注更新也在'
    )
    eq(feed.unread, feed.items.filter((i) => i.unread).length)
  })

  it('删掉报告更新这条：只针对该人，别的消息不受连坐', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('history', [
      hist('A#tech', { ts: iso(T0 + HOUR), viewed: iso(T0) }),
      hist('B#tech', { ts: iso(T0 + 2 * HOUR), viewed: iso(T0) })
    ])
    db.__seed('report_cache', [cache('A#tech', iso(T0 + 5 * HOUR)), cache('B#tech', iso(T0 + 6 * HOUR))])

    const M = load('utils/messages')
    const item = reportItem(await M.loadMessages(), 'A#tech')
    ok(item)
    M.deleteMessage(item.id, item.at)

    const after = await M.loadMessages({ force: true })
    notOk(reportItem(after, 'A#tech'))
    ok(reportItem(after, 'B#tech'), '别的名人不受连坐')
  })
})

/* ═══════════════════════ 5. 接线与成本（静态） ═══════════════════════ */

/** 注释里会写反面用法与推理过程，不剥掉会把解释当成真实代码（同 18 / 63 的手法） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('N-2 接线：报告页写指纹、消息中心成条（静态约束）', () => {
  const reportPage = stripComments(read(path.join(SRC, 'package', 'report', 'index.tsx')))
  const msgPage = stripComments(read(path.join(SRC, 'package', 'messages', 'index.tsx')))
  const msgSrc = stripComments(read(path.join(SRC, 'utils', 'messages.ts')))
  const revisitSrc = stripComments(read(path.join(SRC, 'utils', 'revisit.ts')))
  const eventsSrc = stripComments(read(path.join(SRC, 'utils', 'events.ts')))
  const schemaSrc = read(path.resolve(SRC, '..', 'cloudfunctions', 'dbInit', 'schema.js'))

  it('报告页：指纹只在**渲染出正文**时写，且写在 addHistory 之后', () => {
    ok(/markReportViewed/.test(reportPage), '报告页要写指纹，否则回访永远没有证据')
    const write = reportPage.indexOf('historyWriteRef.current = addHistory')
    const mark = reportPage.indexOf('markReportViewed(personKey')
    ok(write > 0 && mark > write, '指纹是 update 而不是 insert：必须等那次写入的 Promise（顺序不能反）')

    const guard = reportPage.indexOf("if (state.phase !== 'ready') return")
    ok(guard > 0 && guard < mark, '报告没读出来不算「看到」——那种指纹会把没看过的东西记成看过')
    ok(/state\.report\.generatedAt/.test(reportPage), '记的必须是当前版的 generatedAt')
  })

  it('消息中心：report 有自己的图标与两条埋点', () => {
    ok(/report: '/.test(msgPage), '报告更新要有自己的图标（与「关注的人有新动态」不是一件事）')
    ok(/track\('revisit_ready'/.test(msgPage))
    ok(/feed\.revisitTotal > 0/.test(msgPage), '一律上报会让它变成「打开次数」，与 messages_open 重复')
    ok(/track\('revisit_open'/.test(msgPage))
    ok(/m\.kind === 'report' && m\.personKey/.test(msgPage), '汇总行不属于某个人，不该按人上报')
  })

  it('事件登记在 events.ts，且写清了 props 的含义', () => {
    ok(/\| 'revisit_ready'/.test(eventsSrc) && /\| 'revisit_open'/.test(eventsSrc))
    ok(/只在 count > 0 时上报/.test(read(path.join(SRC, 'utils', 'events.ts'))), '为什么只报正例要写在登记处')
  })

  it('消息成本：revisitTotal 用**判定出的总数**，不是列表里剩几条', () => {
    ok(/revisitTotal: revisits\.length/.test(msgSrc), '被本机删掉的那几位不该从分母里消失')
    ok(/report_update#\$\{it\.personKey\}/.test(msgSrc), 'id 复用（同一个人又更新时自动重新变未读）')
    ok(/report-history/.test(msgSrc), '落地页是报告历史页（差异视图所在地）')
  })

  it('判定侧不读报告正文、也不写库（成本恒定、写口唯一）', () => {
    ok(/select\('id,generated_at,state'\)/.test(revisitSrc), '只取轻字段：判定不该把报告正文拉回来')
    notOk(/\.update\(|\.insert\(|\.remove\(/.test(revisitSrc), '判据是只读的；写口只有 history#addHistory / markReportViewed')
    ok(/\.in\('id', keys\)/.test(revisitSrc), '1 次批量查，不按人数逐个查')
  })

  it('云端字段声明同步（新建端上直读/直写的字段必须当场改档）', () => {
    ok(/f\('viewed_generated_at', 'string\?'/.test(schemaSrc), "history 要声明这个字段，且必须是 string?（可空是本质）")
    ok(/def: null/.test(schemaSrc.slice(schemaSrc.indexOf("'viewed_generated_at'"))) === true)
    ok(/'revisit_ready', 'revisit_open'/.test(schemaSrc), 'events 的取值提示要带上这两个事件名')
  })
})
