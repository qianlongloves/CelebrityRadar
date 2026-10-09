'use strict'

/**
 * 关注流刷新的成本口径与轮转（批 3，2026-10-09）
 * ＋ 本地调试的会员身份覆写（config/local.ts 的 debug.memberOverride）
 *
 * 批 3 对付的是**全项目最大的一笔成本敞口**：关注流每次下拉刷新，会对每位关注对象
 * 各发一路检索，而 listFollows 按「最近关注」倒序 ⇒ 原来的 `follows.slice(0, 10)`
 * 让第 11 位起的人**永远轮不到**（刷新对他们等于无效，页面上却看不出任何区别）。
 *
 * 于是这里钉三件事：
 *   口径 —— feed 只走主线（`socialCount: 0`，连那一路请求都不发）；
 *           批量刷新与单人刷新**必须同口径**，否则同一个人会得到 10 条 / 18 条两种结果。
 *   轮转 —— 超上限时按「最久未刷新」优先，从没刷过的排最前。
 *   如实 —— 埋点与文案报**真正刷成**的人数（原先报的是关注总数，会系统性高估一倍）。
 *
 * 另有会员身份覆写：它必须**先于**真实判定生效（否则真实是会员的账号测不出免费档），
 * 且**不写库**（`users.membership` 只由 payCallback 写）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const BUILD = path.resolve(__dirname, '..', '.build')
const read = (p) => fs.readFileSync(p, 'utf8')

const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * 让「云环境已配置」为真。
 *
 * refreshAllFeeds 的前置闸门 `hasSearchChannel()` 读的就是 utils/cloud#isCloudConfigured，
 * 而它是**模块级常量**（首次 require 时算定）。测试编译用的 local.ts 里 cloudbaseEnvId
 * 仍是占位串（所以 isCloudConfigured 为 false —— 这正是 04 那批「降级到 coldstart」
 * 用例的前提），而 feed 刷新的用例必须越过这道闸门。
 *
 * 与 env.setDebugFlags 同一手法：在 load 业务模块**之前**改掉那份配置对象即可。
 * 刻意不动 harness 的默认值 —— 改了会让 04 的降级用例全部失真。
 */
function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

function fresh({ cloud = true, flags = {} } = {}) {
  env.resetAll()
  env.setDebugFlags({
    disableGenerateQuota: false,
    disableAskQuota: false,
    disableRefreshQuota: false,
    disableCooldown: false,
    memberOverride: 'off',
    ...flags
  })
  if (cloud) configureCloud()
  return { load: env.load }
}

/** 登录：refreshAllFeeds 要先有 userId（它不校验身份，只用它计刷新次数） */
function login(id = 'me') {
  env.load('stores/auth').useAuth.getState().setLogin({ userId: id })
  return id
}

/**
 * 记下每一次检索请求。`emptyFor` 给出某人的名字前缀时，那一路返回零条 ——
 * 用来造「检索可用但这个人在主流媒体上就是没动静」这种真实结果。
 */
function spySearch(emptyFor = null) {
  const calls = []
  env.registerCloudFn('aiProxy', (data) => {
    if (data.action !== 'search') return { ok: false }
    calls.push(data)
    if (emptyFor && String(data.query).startsWith(emptyFor)) return { ok: true, pages: [] }
    return { ok: true, pages: [{ name: '标题', url: 'https://news.example.com/a', snippet: '正文' }] }
  })
  return calls
}

/** 关注列表（名字即 person_key 的前缀，便于从 requests 里反查刷了谁） */
const follows = (n) =>
  Array.from({ length: n }, (_, i) => ({ person_key: `P${i}#tech`, name: `P${i}` }))

/** 从检索请求里反查这次刷了哪些人（顺序不可断言：并发完成次序不定） */
const namesOf = (calls) => new Set(calls.map((c) => String(c.query).split(' ')[0]))

/* ------------------------------------------------- 检索口径（省钱的那一刀） */

describe('关注流刷新：只走主线（批 3）', () => {
  it('批量刷新：每位关注只发一路，且不再带社交站点白名单', async () => {
    const { load } = fresh()
    login()
    const calls = spySearch()
    const { refreshAllFeeds } = load('utils/cache')

    const out = await refreshAllFeeds(follows(3))

    eq(out.ok, true)
    eq(calls.length, 3, '3 位关注 = 3 次调用（两路口径下是 6 次）')
    ok(
      calls.every((c) => c.include === undefined),
      '不该再出现社交站点白名单'
    )
    eq(out.refreshed, 3)
  })

  it('单人刷新同一口径 —— 否则同一个人会有 10 条 / 18 条两种结果', async () => {
    const { load } = fresh()
    login()
    const calls = spySearch()
    const { refreshFeed } = load('utils/cache')

    const out = await refreshFeed('P0#tech', 'P0')

    eq(out.ok, true)
    eq(calls.length, 1)
    ok(calls[0].include === undefined)
    eq(out.items.length, 1)
  })

  it('两处调用共用同一个常量 —— 钉住「只改一处」的改法', () => {
    const src = read(path.join(SRC, 'utils/cache.ts'))

    eq((src.match(/fetchNews\([^)]*FEED_SEARCH_OPTS/g) ?? []).length, 2, '批量与单人各一处')
    notOk(
      /fetchNews\((?:f\.name|name)\)/.test(src),
      '不该留下退回默认（两路）的调用 —— 那会让 feed 的条目数随刷新入口而变'
    )
  })

  it('刷新次数仍然只算 1 次配额（刷 10 人不是刷 10 次）', async () => {
    const { load } = fresh()
    const me = login()
    spySearch()
    const { refreshAllFeeds } = load('utils/cache')

    await refreshAllFeeds(follows(10))
    await tick()

    /* fresh() 之后这张表是空的，故只会有一行 —— 不猜它的主键字段名 */
    const rows = env.db.__dump('refresh_quota')
    eq(rows.length, 1, `一次刷新只该记一行，实际：${JSON.stringify(rows)}`)
    eq(rows[0].count, 1, '一次下拉刷新消耗 1 次，与人数无关')
    ok(
      JSON.stringify(rows[0]).includes(me),
      `要记在本次操作的人头上，实际：${JSON.stringify(rows[0])}`
    )
  })

  /*
   * P2-30：刷新额度的**判定**改由云端拍板。此前端上把云端计数取回来、自己再比一遍
   * `count <= DAILY_REFRESH_LIMIT`（`DAILY_REFRESH_LIMIT` 与云端 `REFRESH_DAILY_LIMIT`
   * 是同一规则的第三份副本），改包可以把端上那份改掉，越界的尝试在云端也不留痕。
   */
  it('P2-30：云端说不行就不行 —— 端上不再自比 count 放行', async () => {
    const { load } = fresh()
    login()
    spySearch()
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count: 11, allowed: false, limit: 10 }))
    const { consumeRefreshQuota } = load('utils/cache')

    const res = await consumeRefreshQuota('me')

    eq(res.allowed, false, '云端已判越界，端上不得自己再算一遍放行')
    eq(res.remaining, 0)
    eq(env.db.__dump('refresh_quota').length, 0, '云端计数时端上不落本地行')
  })

  it('P2-30：采用云端 limit（两份常量哪天漂开也不会各说各话）', async () => {
    const { load } = fresh()
    login()
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count: 2, allowed: true, limit: 10 }))
    const { consumeRefreshQuota } = load('utils/cache')

    deepEq(await consumeRefreshQuota('me'), { allowed: true, remaining: 8 })
  })

  it('P2-30：旧版云函数不返回 allowed/limit 时回落同源常量（行为与从前一致）', async () => {
    const { load } = fresh()
    login()
    let count = 2
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count }))
    const { consumeRefreshQuota } = load('utils/cache')

    eq((await consumeRefreshQuota('me')).allowed, true, 'count=2 在下限内')
    count = 11
    const over = await consumeRefreshQuota('me')
    eq(over.allowed, false, 'count=11 已越界')
    eq(over.remaining, 0, 'remaining 夹到 0，不出现负数')
  })
})

/* --------------------------------------------------------- 轮转与如实上报 */

describe('关注流刷新：超上限时轮转（批 3）', () => {
  /** 造 feed_cache 行：`[person_key, 几小时前刷过]`；null = 从没刷过（不建行） */
  const seedFeeds = (entries) => {
    env.db.__seed(
      'feed_cache',
      entries
        .filter(([, hours]) => hours !== null)
        .map(([id, hours]) => ({
          _id: id,
          items: [{ title: '旧闻', url: `https://news.example.com/${id}`, content: '正文', source: '示例' }],
          fetched_at: new Date(Date.now() - hours * 3600000).toISOString()
        }))
    )
  }

  it('12 位关注只刷 10 位：最久没刷的（含从没刷过的）优先', async () => {
    const { load } = fresh()
    login()
    /* P0 / P1 刚刷过（不该被选中）；P11 从没刷过，而它排在关注列表最后
       —— 旧代码的 slice(0, 10) 永远轮不到它，这正是要修的失效 */
    seedFeeds([
      ['P0#tech', 0.1],
      ['P1#tech', 0.2],
      ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => [`P${i}#tech`, 50 + i]),
      ['P11#tech', null]
    ])
    const calls = spySearch()
    const { refreshAllFeeds } = load('utils/cache')

    const out = await refreshAllFeeds(follows(12))

    eq(calls.length, 10, '一次刷新最多 10 次检索调用')
    const names = namesOf(calls)
    ok(names.has('P11'), '从没刷过的人必须被选中 —— 旧代码永远轮不到他')
    notOk(names.has('P0'), '刚刷过的不该重复买')
    notOk(names.has('P1'), '刚刷过的不该重复买')
    eq(out.refreshed, 10)
    ok(out.message.includes('最久未刷新'), `超上限时要如实说明只刷了一部分：${out.message}`)
  })

  it('不超过上限时按关注顺序原样刷（不读缓存、不做取舍）', async () => {
    const { load } = fresh()
    login()
    env.db.__setFailing('feed_cache', true) // 只要去读就会炸
    const calls = spySearch()
    const { refreshAllFeeds } = load('utils/cache')

    const out = await refreshAllFeeds(follows(3))

    eq(calls.length, 3, '3 位关注就刷 3 位')
    eq(namesOf(calls).size, 3)
    eq(out.message.includes('最久未刷新'), false, '没超上限就不该说这句')
  })

  it('挑人失败时退回关注顺序，不把这次刷新的目标搞成随机', async () => {
    const { load } = fresh()
    login()
    env.db.__setFailing('feed_cache', true) // 读失败，写也失败
    const calls = spySearch()
    const { refreshAllFeeds } = load('utils/cache')

    const out = await refreshAllFeeds(follows(12))

    eq(calls.length, 10, '挑不出来也要照常刷 10 位')
    eq(out.refreshed, 0, '写不进去就如实报 0，而不是假装成功')
    eq(out.ok, true, '检索本身是成功的，不该报失败')
  })

  it('埋点报真正刷成的人数（原先报关注总数，会高估一倍）', async () => {
    const { load } = fresh()
    login()
    const calls = spySearch('P1 ') // P1 这位在主流媒体上没有动静
    const { refreshAllFeeds } = load('utils/cache')

    const out = await refreshAllFeeds(follows(3))
    await tick()

    eq(calls.length, 3, '三个人都问过了')
    eq(out.refreshed, 2, '只有两个人有素材可落库')
    /* events 的落库结构是 { event, person_key, props } —— 自定义字段全在 props 里 */
    const ev = env.db.__dump('events').find((e) => e.event === 'refresh_feed')
    eq(ev?.props?.count, 2, '埋点要报刷成的人数，才拿它算得出成本')
  })

  it('单人刷新的埋点也带 count，两个入口的字段口径一致', async () => {
    const { load } = fresh()
    login()
    spySearch()
    const { refreshFeed } = load('utils/cache')

    await refreshFeed('P0#tech', 'P0')
    await tick()

    const ev = env.db.__dump('events').find((e) => e.event === 'refresh_feed')
    eq(ev?.props?.count, 1, '单人 = 1 人，与批量的口径可比')
    eq(ev?.person_key, 'P0#tech')
  })
})

/* ----------------------------------------------------- 会员身份覆写（调试） */

describe('会员身份覆写 config.debug.memberOverride', () => {
  const memberRow = () => ({
    _id: 'u1',
    _openid: 'me',
    membership: { plan: 'month', expires_at: new Date(Date.now() + 864e5).toISOString() }
  })

  it("'off'：不覆写，按云端真实发货结果判定", async () => {
    const { load } = fresh()
    login()
    env.db.__seed('users', [memberRow()])

    const st = await load('utils/member').readMemberState()

    eq(st.member, true)
    eq(st.plan, 'month')
  })

  it("'monthly'：强制会员，档位与剩余天数一并给出（会员中心要显示套餐名）", async () => {
    const { load } = fresh({ flags: { memberOverride: 'monthly' } })
    login()
    /* 刻意不放 users 行：覆写不该依赖库里的那一行 */
    const st = await load('utils/member').readMemberState()

    eq(st.member, true)
    eq(st.plan, 'monthly')
    eq(st.daysLeft, 30)
    ok(st.expiresAt, '要有到期时间，否则页面的「xx 天后到期」没得算')
  })

  it("'free'：能盖住真实的会员身份 —— 否则真实是会员的账号测不出免费档", async () => {
    const { load } = fresh({ flags: { memberOverride: 'free' } })
    login()
    env.db.__seed('users', [memberRow()]) // 真实身份是会员

    const st = await load('utils/member').readMemberState()

    eq(st.member, false, '覆写必须先于真实判定生效')
    eq(st.plan, null)
  })

  it('覆写不写库：users.membership 一个字段都不动', async () => {
    const { load } = fresh({ flags: { memberOverride: 'annual' } })
    login()
    env.db.__seed('users', [memberRow()])

    await load('utils/member').readMemberState()

    eq(env.db.__dump('users')[0].membership.plan, 'month', 'membership 只能由 payCallback 写')
  })

  it('覆写贯通到业务闸门：强制免费时「刚生成过」的刷新冷却生效', async () => {
    const { load } = fresh({ flags: { memberOverride: 'free' } })
    login()
    env.db.__seed('report_cache', [
      {
        _id: 'P#tech',
        state: 'ready',
        report: {
          personKey: 'P#tech',
          name: 'P',
          generatedAt: new Date(Date.now() - 3600000).toISOString()
        }
      }
    ])

    const out = await load('utils/cache').getOrBuildReport('P#tech', { force: true })

    eq(out.refreshCooled, true, '说明覆写真的走到了 cache.ts 的闸门，不只是 member.ts 里的一个孤立函数')
  })

  it('消费方只有 member.ts 一处（否则会出现半生效的会员身份）', () => {
    const files = fs.readdirSync(path.join(SRC, 'utils')).filter((f) => f.endsWith('.ts'))
    const users = files.filter((f) => {
      const src = read(path.join(SRC, 'utils', f))
      return src.includes("from './debug'") && src.includes('MEMBER_OVERRIDE')
    })

    eq(users.length, 1, `只该有 member.ts 读这个开关，实际：${users.join(', ')}`)
    eq(users[0], 'member.ts')
    notOk(
      /membership\s*=\s*\{/.test(read(path.join(SRC, 'utils/member.ts'))),
      '覆写也不能顺手把 membership 写回库里'
    )
  })
})
