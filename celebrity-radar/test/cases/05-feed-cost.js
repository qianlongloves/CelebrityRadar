'use strict'

/**
 * 关注流刷新的成本口径与轮转（批 3，2026-10-09）
 * ＋ 会员身份的来源（2026-10-10：端上只剩数据库一个来源，本机开关已移除）
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
 * 另有会员档位：免费 10 次 / 会员 20 次（P2-30），身份一律来自数据库 `users.membership`
 * —— 曾经的本机开关（debug.memberOverride）能「换身份」，于是端上按会员走、云端按
 * memberships 判免费，切了会员档位也没效果；已移除，见文件末尾那条防回归用例。
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
 * 记下每一次检索请求。`emptyFor` 给出某人的**名字**时，那个人的每一路都返回零条 ——
 * 用来造「检索可用但这个人在主流媒体上就是没动静」这种真实结果。
 *
 * 判空按**名字**而不是整串 query：`fetchNews` 走降级阶梯（utils/search.ts），同一个人的
 * 第一档是「P1 近期 新闻 动态 言论」、第二档是去掉后缀的「P1」—— 按 `startsWith('P1 ')`
 * 判会漏掉第二档，于是「没动静的人」在第二档又捞出了内容，用例前提当场失效
 * （这本身也是那条阶梯真实起作用的证据）。
 */
function spySearch(emptyFor = null) {
  const calls = []
  const person = emptyFor ? emptyFor.trim() : null
  env.registerCloudFn('aiProxy', (data) => {
    if (data.action !== 'search') return { ok: false }
    calls.push(data)
    if (person && String(data.query).split(' ')[0] === person) return { ok: true, pages: [] }
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
  /* ---------- 检索降级阶梯（2026-10-10，产品要求「付费的必须查得到」） ---------- */

  it('第一档抓空就换句式再试，有内容即停（不白花后一档的钱）', async () => {
    const { load } = fresh()
    const calls = []
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action !== 'search') return { ok: false }
      calls.push(data)
      /* 带「近期」后缀那一档永远空 —— 模拟后缀词把排序拉向新闻体、反而挤掉一手内容 */
      if (String(data.query).includes('近期')) return { ok: true, pages: [] }
      return { ok: true, pages: [{ name: '标题', url: 'https://news.example.com/x', snippet: '正文' }] }
    })
    const { fetchNews } = load('utils/search')

    const news = await fetchNews('张三', { socialCount: 0 })

    eq(news.length, 1, '第二档（去掉后缀的纯人名）捞到了内容')
    eq(calls.length, 2, '第一档空即降级；第二档有内容就停，不白花后面那一档')
    ok(String(calls[0].query).includes('近期'), '第一档是原句式')
    eq(calls[1].query, '张三', '第二档只留人名')
    eq(calls[0].freshness, 'oneMonth', '第一档仍是 30 天口径')
  })

  it('阶梯全部抓空时返回空数组（不是 null）—— 判据是「通道可用但没内容」', async () => {
    const { load } = fresh()
    const queries = []
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action !== 'search') return { ok: false }
      /* 记整个 data（下面还要断 freshness），不能只记 query */
      queries.push(data)
      return { ok: true, pages: [] }
    })
    const { SEARCH_COUNTS } = load('config/benefits')
    const { fetchNews } = load('utils/search')

    const news = await fetchNews('冷门人物', { socialCount: 0 })

    deepEq(news, [], '空数组 = 抓到了但没内容（cache.ts 判 nonews）；null 才代表通道未就绪')
    eq(queries.length, SEARCH_COUNTS.mainFreshnessLadderDays.length, '阶梯每一档都试过了')
    eq(queries[queries.length - 1].freshness, 'oneYear', '最后一档放宽到一年，而不是 noLimit')
  })

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

    /* `limit` 一并回报：2026-10-10 起刷新上限按档位分叉，调用方（错误文案）要知道这一档是多少；
       `unlimited` 是调试开关的独立信号（见 utils/cache.ts#consumeRefreshQuota），正常态恒为 false */
    deepEq(await consumeRefreshQuota('me'), { allowed: true, remaining: 8, limit: 10, unlimited: false })
  })

  it('P2-30：调试开关只松闸门、不改数字（刷新侧的 remaining 也照实）', async () => {
    /*
     * 生成侧那个 bug 的镜像（本机反馈「弹窗次数不对」时顺带对齐的）：此前开关打开时
     * 把 remaining 报成满额，而「剩余 N 次刷新」这句话会被直接写进提示文案给用户看。
     * 现改为数字照实、措辞交给 unlimited —— 与 utils/quota.ts 同一套拆法。
     */
    const { load } = fresh({ flags: { disableRefreshQuota: true } })
    login()
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count: 11, allowed: false, limit: 10 }))
    const { consumeRefreshQuota } = load('utils/cache')

    const res = await consumeRefreshQuota('me')

    eq(res.allowed, true, '闸门被放开：云端判越界也放行')
    eq(res.remaining, 0, '数字照实（夹到 0），不再为开挂圆场报满额')
    eq(res.limit, 10)
    eq(res.unlimited, true, '展示方据此少说那句「剩余 N 次刷新」')
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

  /*
   * 2026-10-10：刷新上限按档位分叉（免费 10 / 会员 20）。上面几条都是非会员态，
   * 与免费档的取值一致所以照样通过 —— 这一条专门钉住「兜底也要按身份取」，
   * 否则会员会拿到免费档的 10 次（云端不可用时静默缩水，用户只会觉得「会员买了没用」）。
   */
  it('P2-30：会员身份下兜底用会员档 20 次（免费档仍是 10）', async () => {
    const { load } = fresh()
    login()
    /* 会员身份只能从数据库来（端上的本机开关已移除）：放一行未过期的 membership 即会员 */
    env.db.__seed('users', [
      {
        _id: 'u1',
        _openid: 'me',
        membership: { plan: 'monthly', expires_at: new Date(Date.now() + 864e5).toISOString() }
      }
    ])
    let count = 11
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count }))
    const { consumeRefreshQuota } = load('utils/cache')

    const member = await consumeRefreshQuota('me')
    eq(member.limit, 20, '会员档兜底 20')
    eq(member.allowed, true, 'count=11 在会员档（20）内 —— 免费档此时已经拦下')

    count = 21
    const over = await consumeRefreshQuota('me')
    eq(over.allowed, false, 'count=21 越界')
    eq(over.limit, 20)
    eq(over.remaining, 0)
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

    /*
     * P1 会试满降级阶梯（原句式 → 去掉后缀），另外两位第一档就有内容、各只 1 次。
     * 阶梯长度从真源取，改阶梯配置时这条断言不用跟着改。
     */
    const { SEARCH_COUNTS } = load('config/benefits')
    eq(
      calls.length,
      2 + SEARCH_COUNTS.mainFreshnessLadderDays.length,
      '2 位第一档命中各 1 次，P1 试满阶梯'
    )
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

/* ---------------------------------------- 会员身份的来源（无本机开关） */

describe('会员身份只有一个来源：数据库 users.membership', () => {
  /** 未过期（默认 +1 天）= 会员；传负数 = 已过期 */
  const memberRow = (expiresInDays = 1) => ({
    _id: 'u1',
    _openid: 'me',
    membership: {
      plan: 'month',
      expires_at: new Date(Date.now() + expiresInDays * 864e5).toISOString()
    }
  })

  it('库里有未过期的 membership ⇒ 会员，套餐名与剩余天数一并给出（会员中心要显示）', async () => {
    const { load } = fresh()
    login()
    env.db.__seed('users', [memberRow()])

    const st = await load('utils/member').readMemberState()

    eq(st.member, true)
    eq(st.plan, 'month')
    eq(st.daysLeft, 1, '剩余天数由 expires_at 现算（页面上的「xx 天后到期」靠它）')
  })

  it('membership 已过期 ⇒ 非会员（判定只认 expires_at，不看 plan）', async () => {
    const { load } = fresh()
    login()
    env.db.__seed('users', [memberRow(-1)])

    const st = await load('utils/member').readMemberState()

    eq(st.member, false, '过期就该降级，哪怕行还在、plan 还写着 month')
    eq(st.plan, null)
  })

  it('读不到 users 行 ⇒ 非会员，且不抛错（保守，不放大免费额度）', async () => {
    const { load } = fresh()
    login()

    const st = await load('utils/member').readMemberState()

    eq(st.member, false)
    eq(st.plan, null)
  })

  it('身份贯通到业务闸门：非会员「刚生成过」的刷新提醒成立', async () => {
    const { load } = fresh()
    login()
    const report = {
      personKey: 'P#tech',
      name: 'P',
      generatedAt: new Date(Date.now() - 3600000).toISOString()
    }
    env.db.__seed('report_cache', [{ _id: 'P#tech', state: 'ready', report }])

    const cooling = await load('utils/cache').isFreeRefreshCooling(report)

    eq(cooling, true, '说明身份真的走到了 cache.ts 的读取，不只是 member.ts 里的一个孤立函数')
  })

  it('端上不存在第二个身份来源：没有任何本地会员开关（防回归）', () => {
    /*
     * 曾有 `config/local.ts` 的 `debug.memberOverride`：本机把端上切成会员，而云端按
     * memberships 权威表判 ⇒ 「切了会员档位没效果、加厚检索没效果」而界面毫无异常，
     * 极易误判成档位功能坏了。它也让「谁是会员」在端上有了配置与数据库两个来源，
     * 已于 2026-10-10 移除。
     * 这里只查**真实声明**（字段名 / 常量名），注释里追述历史不算 —— 免得后人
     * 为了写清「为什么没有它」反而把这条用例弄红。
     */
    const files = fs.readdirSync(path.join(SRC, 'utils')).filter((f) => f.endsWith('.ts'))
    const offenders = files.filter((f) => /MEMBER_OVERRIDE/.test(read(path.join(SRC, 'utils', f))))

    eq(offenders.length, 0, `不该再有会员覆写开关，实际：${offenders.join(', ')}`)

    const tpl = read(path.join(SRC, 'config', 'local.example.ts'))
    notOk(/^\s*memberOverride\s*:/m.test(tpl), '模板里不该再有这个字段（留着就会被配回来）')
    notOk(
      /membership\s*=\s*\{/.test(read(path.join(SRC, 'utils/member.ts'))),
      '身份判定也不能顺手把 membership 写回库里（那只能由 payCallback 写）'
    )
  })
})

/* ------------------------------------ 检索拆路：人物背景线（P1，2026-10-10） */

/*
 * 「档案 / 履历 / 时间线」的资料**不进新闻流**（出生地、学历、生平节点），而生成时只发了一条
 * 「近期 30 天新闻」的检索 —— 用错尺子，这就是这几节此前常年为空的原因。
 * P1 给它单开一路：不限时间（noLimit）+ 明确的「找资料」语义，且**只在报告生成路径**启用
 * （feed 刷新是每日 10 次的常态动作，多一路等于常态成本翻倍而用户几乎无感）。
 */
describe('人物背景线 fetchBackground（P1）', () => {
  it('一路只管一件事：不限时间 + 「找资料」语义，且不带社交白名单', async () => {
    const { load } = fresh()
    const calls = spySearch()

    await load('utils/search').fetchBackground('甲', 8)

    eq(calls.length, 1, '背景线只发一路')
    eq(calls[0].freshness, 'noLimit', '履历不随时间变：窗口越窄越搜不到')
    ok(
      String(calls[0].query).includes('出生地'),
      `背景线要有明确的「找资料」语义，而不是又一条新闻查询：${calls[0].query}`
    )
    eq(calls[0].include, undefined, '背景线不要社交站点白名单')
    eq(calls[0].count, 8)
  })

  it('count <= 0 = 完全不启用这一路（连请求都不发）', async () => {
    const { load } = fresh()
    const calls = spySearch()

    const out = await load('utils/search').fetchBackground('甲', 0)

    eq(calls.length, 0, '钱花在「发起了一次检索」上，只把条数降到 0 是省不下钱的')
    deepEq(out, [], '返回空数组而不是 null：调用方要能直接拿来拼')
  })

  it('背景线失败一律吞掉返回 null —— 它是补充，主线才是判据', async () => {
    const { load } = fresh()
    env.registerCloudFn('aiProxy', () => ({ ok: false, kind: 'unconfigured' }))

    eq(
      await load('utils/search').fetchBackground('甲', 8),
      null,
      '不能因为它挂掉就让整次生成失败（与社交支线同一个取舍）'
    )
  })

  it('报告生成并行取两路、档位跟着深度模式；feed 刷新一路都不多（源码级，防回归）', () => {
    const src = read(path.join(SRC, 'utils/cache.ts'))

    ok(
      /Promise\.all\(\[[\s\S]*?fetchNews\([\s\S]*?fetchBackground\(/.test(src),
      '两路必须并行：串行会把首次生成的等待拉长近一倍'
    )
    ok(src.includes('DEEP_BG_COUNT : BG_COUNT'), '档位跟着深度模式走：免费 8 条 / 会员 12 条')

    const feedOpts = src.match(/const FEED_SEARCH_OPTS[^\n]*/)
    ok(feedOpts, '前提：FEED_SEARCH_OPTS 仍在')
    notOk(/background/i.test(feedOpts[0]), 'feed 刷新不该吃背景线的钱')
  })
})
