'use strict'

/**
 * 周报内容增强 + 关注流批量读取（2026-10-10）
 *
 * 用户提了两件事：周报「内容单薄」，关注动态页「点进去要等一下」。
 * 两件事的根因在数据层是同一个：**这两个页面都要对每一位关注人各读一行 feed_cache**，
 * 关注十几位就是十几路云数据库请求在飞。所以这里钉三层：
 *
 *   1. 读取次数（getFeedDetails）—— 一次 `in` 查询取回全部人，且「读失败」与
 *      「还没抓过」必须仍是两种结论（前者 ok:false，后者 ok:true + 空列表）；
 *   2. 聚合正确性（buildWeeklyDigest）—— 时间线 / 来源 / 领域 / 跨度全部**只搬运素材**，
 *      同输入同输出，且日期一律走 UTC+8（cross-timezone 不串天）；
 *   3. 要点与收录范围（sanitizeWeekly）—— 模型给的 highlights 逐条过滤，
 *      拒答即清空；coverage 把「共关注几位 / 几位有动态 / 几位读失败」定格进缓存，
 *      否则用户会把「10 位关注里只有 3 位有动静」读成「我的关注丢了」。
 *
 * 页面本身（pages/weekly、pages/feed）不在测试编译范围内，故另有一段**静态约束**：
 * 直接读 tsx 源码，钉住「关注流确实走批量入口」与「重进页面不闪骨架屏」这两条，
 * 防止哪天顺手改回逐人读而没人发现（这类退化在单测里完全看不出来，只体现在真机等待时间上）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const BUILD = path.resolve(__dirname, '..', '.build')
const read = (p) => fs.readFileSync(p, 'utf8')

const HOURS = 3600 * 1000

/** 让「云环境已配置」为真（本文件所有用例都要真的走 DB 适配层，不是降级路径） */
function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

function fresh() {
  env.resetAll()
  env.setDebugFlags({
    disableGenerateQuota: false,
    disableAskQuota: false,
    disableRefreshQuota: false,
    disableCooldown: false
  })
  configureCloud()
  return { load: env.load }
}

function login(id = 'me') {
  env.load('stores/auth').useAuth.getState().setLogin({ userId: id })
  return id
}

/** 关注行：`_id` = openid#personKey（与线上主键口径一致） */
const followRow = (personKey, name, followedAt, openid = 'me') => ({
  _id: `${openid}#${personKey}`,
  openid,
  person_key: personKey,
  name,
  domain: personKey.split('#')[1] || 'other',
  followed_at: followedAt
})

const feedRow = (personKey, items, fetchedAt = new Date().toISOString()) => ({
  _id: personKey,
  items,
  fetched_at: fetchedAt
})

/** 窗口内的素材条目（周报只收最近 7 天） */
const recentItem = (title, hoursAgo = 2) => ({
  title,
  url: `https://example.com/${encodeURIComponent(title)}`,
  content: '正文内容',
  source: '示例来源',
  publishedDate: new Date(Date.now() - hoursAgo * HOURS).toISOString()
})

/* ---------------------------------------------------- 纯函数用的周报构造 */

const entry = (title, date, source = '示例来源', url = 'https://example.com/a') => ({
  title,
  url,
  content: '正文',
  source,
  publishedDate: date
})

const person = (personKey, name, domain, entries) => ({ personKey, name, domain, summary: '', entries })

const mkReport = (persons, extra = {}) => ({
  weekKey: '2026-W41',
  windowLabel: '2026-10-03 ~ 2026-10-09',
  generatedAt: new Date().toISOString(),
  personCount: persons.length,
  entryCount: persons.reduce((n, p) => n + p.entries.length, 0),
  overview: '综述',
  persons,
  topics: [],
  disclaimer: '免责声明',
  ...extra
})

const mkMaterial = (persons, extra = {}) => ({
  persons,
  windowLabel: '2026-10-03 ~ 2026-10-09',
  entryCount: persons.reduce((n, p) => n + p.entries.length, 0),
  failedCount: 0,
  followedCount: persons.length,
  ...extra
})

/* ============================ 1. 端上聚合 ============================ */

describe('周报端上聚合：时间线 / 来源 / 领域（buildWeeklyDigest）', () => {
  const sample = () =>
    mkReport([
      person('A#tech', '甲', 'tech', [
        entry('甲的新品', '2026-10-05', '每日新闻'),
        entry('甲的访谈', '2026-10-09', '每日新闻')
      ]),
      person('B#tech', '乙', 'tech', [entry('乙的发布会', '2026-10-08', '财经网')]),
      person('C#other', '丙', 'other', [entry('丙的无日期动态', '', '')])
    ])

  it('时间线按日期倒序，缺日期的垫底（不给它编一个位置）', () => {
    const { buildWeeklyDigest } = fresh().load('utils/weekly')

    const d = buildWeeklyDigest(sample())

    deepEq(
      d.timeline.items.map((t) => t.date),
      ['2026-10-09', '2026-10-08', '2026-10-05', ''],
      `实际：${JSON.stringify(d.timeline.items.map((t) => t.date))}`
    )
    eq(d.timeline.total, 4)
    eq(d.timeline.dated, 3, '缺日期的那条不算进「带日期的条数」')
  })

  it('日期一律按 UTC+8 归一：跨时区的时间串不会串到前一天/后一天', () => {
    const { buildWeeklyDigest } = fresh().load('utils/weekly')

    const d = buildWeeklyDigest(
      mkReport([
        person('A#tech', '甲', 'tech', [
          /* 北京时间 10-08 晚上 8 点：UTC 是 10-08 12:00，两种算法同一天 */
          entry('晚八点', '2026-10-08T20:00:00+08:00'),
          /* UTC 10-08 23:00 = 北京时间 10-09 07:00：按 UTC 切片会错记成 10-08 */
          entry('深夜', '2026-10-08T23:00:00Z'),
          /* 北京时间 10-09 00:30 = UTC 10-08 16:30：按 UTC 切片也会错记成 10-08 */
          entry('凌晨', '2026-10-09T00:30:00+08:00')
        ])
      ])
    )

    const byTitle = Object.fromEntries(d.timeline.items.map((t) => [t.title, t.date]))
    eq(byTitle['深夜'], '2026-10-09', 'UTC 23:00 已是北京时间次日')
    eq(byTitle['凌晨'], '2026-10-09', '北京时间 00:30 就是 10-09，不该退回 10-08')
    eq(d.timeline.dated, 3)
  })

  it('来源分布：空来源不计入，条数并列时按名称定序（同一份周报两次打开不变位）', () => {
    const { buildWeeklyDigest } = fresh().load('utils/weekly')

    const d = buildWeeklyDigest(
      mkReport([
        person('A#tech', '甲', 'tech', [
          entry('a', '2026-10-05', '乙媒体'),
          entry('b', '2026-10-05', '甲媒体')
        ]),
        person('B#tech', '乙', 'tech', [entry('c', '2026-10-05', '')])
      ])
    )

    deepEq(
      d.sources,
      [
        { name: '甲媒体', count: 1 },
        { name: '乙媒体', count: 1 }
      ],
      `并列时按名称升序；实际：${JSON.stringify(d.sources)}`
    )
  })

  it('领域分布：人数与条数分别统计，条数多的排前面', () => {
    const { buildWeeklyDigest } = fresh().load('utils/weekly')

    const d = buildWeeklyDigest(sample())

    deepEq(
      d.domains,
      [
        { domain: 'tech', persons: 2, entries: 3 },
        { domain: 'other', persons: 1, entries: 1 }
      ],
      `实际：${JSON.stringify(d.domains)}`
    )
  })

  it('跨度取带日期条目的最早与最晚（不能把没日期的算进去）', () => {
    const { buildWeeklyDigest } = fresh().load('utils/weekly')

    eq(buildWeeklyDigest(sample()).span.first, '2026-10-05')
    eq(buildWeeklyDigest(sample()).span.last, '2026-10-09')

    const noDate = mkReport([person('A#tech', '甲', 'tech', [entry('x', '')])])
    eq(buildWeeklyDigest(noDate).span, null, '一条带日期的都没有时跨度必须是 null，不是空串')
  })

  it('动态最多的人：并列时取材料里靠前者（结果不随遍历顺序抖动）', () => {
    const { buildWeeklyDigest } = fresh().load('utils/weekly')

    const d = buildWeeklyDigest(
      mkReport([
        person('A#tech', '甲', 'tech', [entry('a1', '2026-10-05'), entry('a2', '2026-10-05')]),
        person('B#tech', '乙', 'tech', [entry('b1', '2026-10-06'), entry('b2', '2026-10-06')])
      ])
    )

    deepEq(d.mostActive, { name: '甲', count: 2 })

    const empty = buildWeeklyDigest(mkReport([person('A#tech', '甲', 'tech', [])]))
    eq(empty.mostActive, null, '一条动态都没有时不能报「动态最多：0 条」')
  })

  it('时间线只列最近 12 条，但「一共多少条」照实报（分页文案靠它）', () => {
    const { buildWeeklyDigest } = fresh().load('utils/weekly')

    const many = []
    for (let i = 0; i < 20; i++) {
      many.push(entry(`动态${i}`, `2026-10-${String((i % 9) + 1).padStart(2, '0')}`))
    }
    const d = buildWeeklyDigest(mkReport([person('A#tech', '甲', 'tech', many)]))

    eq(d.timeline.items.length, 12, '切片上限')
    eq(d.timeline.total, 20, '总数必须照实报，否则界面会写「共 12 条」误导用户')
  })

  it('同一份周报两次聚合一模一样（确定性；顺序不该依赖 Map 遍历或素材抖动）', () => {
    const { buildWeeklyDigest } = fresh().load('utils/weekly')
    const r = sample()

    deepEq(buildWeeklyDigest(r), buildWeeklyDigest(r))
  })
})

/* ==================== 2. 要点过滤与收录范围定格 ==================== */

describe('周报要点与收录范围（sanitizeWeekly）', () => {
  const material = () =>
    mkMaterial([
      person('A#tech', '甲', 'tech', [entry('a', '2026-10-05')]),
      person('B#tech', '乙', 'tech', [entry('b', '2026-10-06')])
    ])

  it('要点逐条独立取舍：过短（占位输出）、过长、重复的丢掉，其余保留', () => {
    const { sanitizeWeekly } = fresh().load('utils/weekly')

    const r = sanitizeWeekly(material(), {
      overview: '综述',
      highlights: [
        '甲：发布了新品', // 保留
        '暂无', // 太短：占位输出
        'x'.repeat(61), // 过长：整条丢掉
        '甲：发布了新品', // 重复
        '乙：出席活动' // 保留
      ]
    })

    deepEq(r.highlights, ['甲：发布了新品', '乙：出席活动'], `实际：${JSON.stringify(r.highlights)}`)
    notOk(r.degraded, '丢了两条不该牵连整份周报')
  })

  it('要点最多 5 条', () => {
    const { sanitizeWeekly } = fresh().load('utils/weekly')

    const r = sanitizeWeekly(material(), {
      highlights: Array.from({ length: 8 }, (_, i) => `第${i}个人：发生了什么`)
    })

    eq(r.highlights.length, 5)
  })

  it('只有要点、没有综述与逐人摘要时不算降级（有文字就是有文字）', () => {
    const { sanitizeWeekly } = fresh().load('utils/weekly')

    const r = sanitizeWeekly(material(), { overview: '', highlights: ['甲：发布了新品'] })

    notOk(r.degraded, '光看 overview/summaries 会误判成「模型什么都没写」')
    eq(r.highlights.length, 1)
  })

  it('完全没有文字 → 降级（并清空要点，不留一段孤零零的列表）', () => {
    const { sanitizeWeekly } = fresh().load('utils/weekly')

    const r = sanitizeWeekly(material(), { overview: '   ', highlights: [] })

    eq(r.degraded, true)
    eq(r.overview, '')
  })

  it('拒答：综述 / 要点 / 话题一律清空（敏感素材不产出任何文字）', () => {
    const { sanitizeWeekly } = fresh().load('utils/weekly')

    const r = sanitizeWeekly(
      material(),
      { overview: '综述', highlights: ['甲：发布了新品'], topics: ['新品发布'] },
      true
    )

    eq(r.overview, '')
    deepEq(r.highlights, [])
    deepEq(r.topics, [])
    eq(r.degraded, true)
  })

  it('模型没给 highlights 字段（旧格式 / 少给一段）→ 空数组，不抛错', () => {
    const { sanitizeWeekly } = fresh().load('utils/weekly')

    const r = sanitizeWeekly(material(), { overview: '综述' })

    deepEq(r.highlights, [], '缺字段要能降级成「这次没给要点」，界面据此写清原因')
  })

  it('收录范围定格进缓存：共关注几位 / 几位有动态 / 几位读失败', () => {
    const { sanitizeWeekly } = fresh().load('utils/weekly')

    const r = sanitizeWeekly(
      mkMaterial([person('A#tech', '甲', 'tech', [entry('a', '2026-10-05')])], {
        failedCount: 2,
        followedCount: 9
      }),
      { overview: '综述' }
    )

    deepEq(r.coverage, { followed: 9, withEntries: 1, failed: 2 })
  })
})

/* ==================== 3. 关注流素材的批量读取 ==================== */

describe('关注流缓存批量读取（getFeedDetails）', () => {
  const keys = (n) => Array.from({ length: n }, (_, i) => `P${i}#tech`)

  it('12 人一次查询取回（此前是 12 路请求；读次数与人数无关了）', async () => {
    const { load } = fresh()
    const { getFeedDetails } = load('utils/cache')
    const ks = keys(12)
    env.db.__seed('feed_cache', ks.map((k) => feedRow(k, [recentItem(`${k} 的动态`)])))

    const before = env.db.stats.getCalls
    const map = await getFeedDetails(ks)
    const calls = env.db.stats.getCalls - before

    eq(map.size, 12)
    eq(map.get('P3#tech').items.length, 1)
    eq(map.get('P3#tech').ok, true)
    eq(calls, 1, `12 人只该读 1 次，实际 ${calls} 次`)
  })

  it('行不存在 = ok:true + 空列表（「还没抓过」不是读失败）', async () => {
    const { load } = fresh()
    const { getFeedDetails } = load('utils/cache')
    env.db.__seed('feed_cache', [feedRow('P0#tech', [recentItem('有内容')])])

    const map = await getFeedDetails(['P0#tech', 'P1#tech'])

    eq(map.get('P1#tech').ok, true, '没抓过是确定的无内容，不能报成读取失败')
    deepEq(map.get('P1#tech').items, [])
    eq(map.get('P1#tech').fetchedAt, null)
  })

  it('整批读失败 → 该批全部 ok:false（结果不完整必须能被界面看见）', async () => {
    const { load } = fresh()
    const { getFeedDetails } = load('utils/cache')
    env.db.__seed('feed_cache', [feedRow('P0#tech', [recentItem('有内容')])])
    env.db.__setReadFailing('feed_cache', true)

    const map = await getFeedDetails(['P0#tech', 'P1#tech'])

    eq(map.get('P0#tech').ok, false, '行明明在，但这次没读到 —— 这是失败，不是「没动态」')
    eq(map.get('P1#tech').ok, false)
  })

  it('空数组与重复 key：不发无谓的查询', async () => {
    const { load } = fresh()
    const { getFeedDetails } = load('utils/cache')

    const before = env.db.stats.getCalls
    const empty = await getFeedDetails([])
    eq(empty.size, 0)
    eq(env.db.stats.getCalls - before, 0, '没人关注时不该还去发一次空查询')

    env.db.__seed('feed_cache', [feedRow('P0#tech', [])])
    const dup = await getFeedDetails(['P0#tech', 'P0#tech'])
    eq(dup.size, 1, '去重后只剩一个 key')
  })

  it('关注人数超过单片上限（50）时按片续查，结果仍然齐全', async () => {
    const { load } = fresh()
    const { getFeedDetails } = load('utils/cache')
    const ks = keys(51)
    env.db.__seed('feed_cache', ks.map((k) => feedRow(k, [recentItem(`${k}`)])))

    const before = env.db.stats.getCalls
    const map = await getFeedDetails(ks)
    const calls = env.db.stats.getCalls - before

    eq(map.size, 51, '分片不能漏人')
    ok(
      calls <= 6,
      `51 人最多几十次读已经算多，实际 ${calls} 次 —— 分片或内部分页没生效就会掉到 51 次`
    )
  })
})

/* ==================== 4. 周报素材也走批量读 ==================== */

describe('周报材料收集走批量读（collectWeeklyMaterial）', () => {
  it('6 位关注人：读次数是常数级，不随关注人数增长', async () => {
    const { load } = fresh()
    login()
    const ks = ['P0#tech', 'P1#tech', 'P2#tech', 'P3#ent', 'P4#sports', 'P5#other']
    env.db.__seed(
      'follows',
      ks.map((k, i) => followRow(k, `人物${i}`, new Date(Date.now() - i * HOURS).toISOString()))
    )
    env.db.__seed('feed_cache', ks.map((k) => feedRow(k, [recentItem(`${k} 的近期动态`)])))

    const before = env.db.stats.getCalls
    const out = await load('utils/weekly').collectWeeklyMaterial()
    const calls = env.db.stats.getCalls - before

    eq(out.kind, 'ok')
    eq(out.material.persons.length, 6)
    /* 1 次关注列表 + 1 次 feed_cache 批量（此前是 1 + 6） */
    ok(calls <= 3, `6 位关注人只该读几次，实际 ${calls} 次`)
  })

  it('关注总数如实上报：材料里只剩有动态的人，不能说成「你只关注了 1 位」', async () => {
    const { load } = fresh()
    login()
    const ks = ['P0#tech', 'P1#tech', 'P2#tech', 'P3#tech']
    env.db.__seed(
      'follows',
      ks.map((k, i) => followRow(k, `人物${i}`, new Date(Date.now() - i * HOURS).toISOString()))
    )
    /* 只有 P0 最近 7 天有动态；P1 的行存在但没有窗口内条目；P2 没有行；P3 只有一条 30 天前的旧闻 */
    env.db.__seed('feed_cache', [
      feedRow('P0#tech', [recentItem('P0 的新动态')]),
      feedRow('P1#tech', [recentItem('P1 的旧动态', 24 * 20)]),
      feedRow('P3#tech', [
        {
          title: 'P3 的三十天前旧闻',
          url: 'https://example.com/old',
          content: '正文',
          publishedDate: new Date(Date.now() - 30 * 24 * HOURS).toISOString()
        }
      ])
    ])

    const out = await load('utils/weekly').collectWeeklyMaterial()

    eq(out.kind, 'ok')
    eq(out.material.persons.length, 1, '只有 P0 进材料')
    eq(out.material.followedCount, 4, '关注总数是 4，界面要靠它解释「为什么只收录了 1 位」')
    eq(out.material.failedCount, 0, '读得到但没内容 ≠ 读失败')
  })

  it('窗口内的条目全量进材料：提示词截断只发生在拼提示词时，真值清单不能被截', async () => {
    const { load } = fresh()
    login()
    env.db.__seed('follows', [followRow('P0#tech', '人物0', new Date().toISOString())])
    env.db.__seed('feed_cache', [
      feedRow('P0#tech', [
        recentItem('动态一'),
        recentItem('动态二'),
        recentItem('动态三'),
        recentItem('动态四'),
        recentItem('动态五')
      ])
    ])

    const out = await load('utils/weekly').collectWeeklyMaterial()

    eq(out.kind, 'ok')
    eq(
      out.material.persons[0].entries.length,
      5,
      '窗口内 5 条就应 5 条进材料 —— 时间线总数 / 来源分布 / 「本周动态最多」都靠这份清单统计'
    )
    eq(out.material.entryCount, 5, '「共 N 条动态」也必须按全量算')
  })

  it('全部读失败 → 报「最近 7 天没有可汇总的动态」，不谎报成有材料', async () => {
    const { load } = fresh()
    login()
    env.db.__seed('follows', [followRow('P0#tech', '人物0', new Date().toISOString())])
    env.db.__seed('feed_cache', [feedRow('P0#tech', [recentItem('有内容')])])
    env.db.__setReadFailing('feed_cache', true)

    const out = await load('utils/weekly').collectWeeklyMaterial()

    eq(out.kind, 'nomaterial')
  })
})

/* ==================== 5. 页面级静态约束 ==================== */

describe('关注动态页：批量读 + 重进不闪骨架屏（静态约束）', () => {
  const src = () => read(path.join(SRC, 'pages', 'feed', 'index.tsx'))

  it('走批量入口，且不再出现逐人读的调用', () => {
    const s = src()

    ok(s.includes('getFeedDetails('), '关注流必须走批量入口')
    notOk(
      /getFeedDetail\(/.test(s),
      '逐人读（getFeedDetail）会让关注几位就发几路请求，是这次要消灭的写法'
    )
  })

  it('首帧取会话快照：有上一轮结果就不再盖骨架屏', () => {
    const s = src()

    ok(s.includes('snapshot?.entries ?? []'), 'state 初值要取自快照，否则重进仍是从空白开始')
    ok(s.includes('void load(snapshot === null)'), '只有「从没有过结果」时才显示骨架屏')
    ok(s.includes('} finally {'), 'loading 必须在 finally 里收掉，否则一次异常就把整页钉在骨架屏上')
  })

  it('周报提示词要求给出要点，且要点进了 JSON 契约', () => {
    const w = read(path.join(SRC, 'utils', 'weekly.ts'))

    ok(w.includes('highlights：3~5 条本周要点'), '提示词要明确要求，否则模型不会给这段')
    ok(
      w.includes('"highlights":[string]'),
      '要求了就要写进输出格式，否则模型只会按旧格式返回'
    )
  })
})
