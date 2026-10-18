'use strict'

/**
 * 人物索引：**名字 + 领域 + 身份指纹** → personKey 的读取侧归一
 * （Task A 2026-10-12 建；判据 2026-10-18 两次收窄，三次取舍见 utils/person-index.ts 文件头）
 *
 * 背景：`report_cache` 主键是「名字#领域」，领域由各入口自己决定；领域自由化后同一个人很容易
 * 被写成两行（实测「雷军#tech」与「雷军#auto」并存），所以需要一层读取侧归一。
 *
 * ⚠ 判据演进（每一版都是被实测问题推着改的）：
 *   v1「只按名字、取最新那份」⇒ **同名不同人**被合并，第二个人看到的是第一个人的报告；
 *   v2「名字 + 领域（domainLabel 相等）」⇒ 堵住了串人，但同一个人跨领域裂成多份；
 *   v3（当前）三层：领域**同组**（domainIdentityKey）→ 用户确认过的别名 → brief × 报告机构指纹。
 *
 * 本用例钉住本层**不该被新判据改坏**的那部分：
 *   1. `resolvePersonKey` 的领域判据 —— 同组才复用，跨组退回入参 key；
 *   2. 索引键含领域（storage 里是 `pidx:名字#领域`），否则同名的第二个人会被第一份带偏；
 *   3. 缓存**落空**时（getCachedReport / getCachedReports / getOrBuildReport）同样不跨领域回退；
 *   4. 端上零阻塞 —— 命中即记住（storage + 内存），此后不再查库；查询失败一律退回入参 key。
 *
 * 三层判据本身（brief 机构指纹、别名写入、maybe/same 的区别）在 90-person-identity.js。
 * 说明：这里不触发真实生成 —— 回退命中的场景在第 0 步（缓存命中）就会返回。
 */

const env = require('../harness/env')
const { describe, it, ok, eq } = require('../harness/t')

function fresh() {
  env.resetAll()
  return { load: env.load }
}

/** 最小报告：本文件只关心 name / personKey / generatedAt */
const rep = (name, domain, generatedAt) => ({
  personKey: `${name}#${domain}`,
  name,
  generatedAt,
  degraded: false
})

/** report_cache 行（__seed 认 _id，db.ts 适配层负责 id ↔ _id 互映） */
const rowOf = (name, domain, generatedAt, state = 'ready') => ({
  _id: `${name}#${domain}`,
  state,
  generated_at: generatedAt,
  report: rep(name, domain, generatedAt)
})

const T1 = '2026-10-12T15:04:18.000Z'
const T2 = '2026-10-12T15:06:12.000Z' /* 更晚 = 更新 */

describe('resolvePersonKey：只在「名字 + 领域」对得上时复用（同名不同人各归各的）', () => {
  it('没有任何报告 ⇒ 退回调用方给的「名字#领域」', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')

    eq(await resolvePersonKey('雷军', 'auto'), '雷军#auto', '无缓存时维持各入口自己的领域')
  })

  it('同名两行、领域不同 ⇒ 各用各的（绝不取「最新那份」顶替）', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    /* auto 更旧、tech 更新：旧实现会因为「最新」把点 auto 的人送到 tech 那份 */
    env.db.__seed('report_cache', [rowOf('雷军', 'auto', T1), rowOf('雷军', 'tech', T2)])

    eq(await resolvePersonKey('雷军', 'auto'), '雷军#auto', 'auto 自己有报告，就用 auto 的')
    eq(
      await resolvePersonKey('雷军', 'invest'),
      '雷军#invest',
      'invest 没有报告 ⇒ 用入参 key（同一名字下的另一个人，不能拿 tech 那份充数）'
    )
  })

  it('领域同义（tech ↔ 科技）⇒ 视为同一人，复用那一份', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    eq(
      await resolvePersonKey('雷军', '科技'),
      '雷军#tech',
      '领域标签与领域码是同一件事（domainLabel 相等），否则同一个人会被拆成两份报告'
    )
  })

  it('命中后写进索引：索引键含领域，同一领域再次解析不再查库', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    eq(await resolvePersonKey('雷军', '科技'), '雷军#tech')
    const before = env.db.stats.getCalls
    eq(await resolvePersonKey('雷军', '科技'), '雷军#tech', '索引记住后不再查库')
    eq(env.db.stats.getCalls, before, '第二次解析不应产生新的库读')
    /* 冷启路径：storage 里落的索引键是「名字#领域」—— 只按名字记会让同名的第二个人被带偏 */
    eq(env.storage.get('pidx:雷军#科技'), '雷军#tech', '索引键必须含领域')
    eq(env.storage.get('pidx:雷军'), undefined, '不许再写「只按名字」的旧键')
  })

  it('并发去重：同一「名字#领域」的并发解析共用一个 promise（只查一次库）', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    const before = env.db.stats.getCalls
    const [a, b] = await Promise.all([
      resolvePersonKey('雷军', '科技'),
      resolvePersonKey('雷军', '科技')
    ])
    eq(a, '雷军#tech')
    eq(b, '雷军#tech')
    eq(env.db.stats.getCalls - before, 1, '两个并发解析只该产生一次 report_cache 查询')
  })

  it('不同领域的并发解析各自查一次（不能共用「同名」的结论）', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    const before = env.db.stats.getCalls
    const [a, b] = await Promise.all([resolvePersonKey('雷军', 'auto'), resolvePersonKey('雷军', 'invest')])
    eq(a, '雷军#auto', 'auto 与 tech 是两个领域 ⇒ 各归各的')
    eq(b, '雷军#invest')
    /*
     * 两个领域各自查一次 report_cache；领域都对不上时还会各查一次 person_alias（③-2 的别名查询）。
     * 断「≥4」而不是具体条数：这里要钉的是**没有共用同一个 promise**（共用会变成 2 次，结论串人），
     * 而不是实现里有几条 SQL —— 判据以后再加一层，这条不该跟着红。
     */
    ok(
      env.db.stats.getCalls - before >= 4,
      `两个不同领域必须各自解析（共用一个 promise 会把结论串人），实际只查了 ${env.db.stats.getCalls - before} 次`
    )
  })

  it('查询失败 ⇒ 退回入参 key（端上零阻塞，绝不抛错）', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__setReadFailing('report_cache', true)

    eq(await resolvePersonKey('雷军', 'auto'), '雷军#auto', '读失败时退回入参 key，行为与改动前一致')
  })
})

describe('读取侧回退：只对「同一个人」生效，同名的另一个人不参与', () => {
  it('getCachedReport：本 key 无行、同名者领域不同 ⇒ null（不把别人的报告交回来）', async () => {
    const { load } = fresh()
    const { getCachedReport } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    eq(await getCachedReport('雷军#auto'), null, '领域不同就是另一个人：宁可为空，也不能显示错的人')
  })

  it('getCachedReport：本 key 无行、同名者领域同义 ⇒ 回退命中（同一个人换了个写法）', async () => {
    const { load } = fresh()
    const { getCachedReport } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    const r = await getCachedReport('雷军#科技')
    ok(r, '同义领域应命中，否则同一个人会被重复生成')
    eq(r.personKey, '雷军#tech')
  })

  it('getCachedReport：本 key 有行 ⇒ 用自己那份（不回退，不额外查库）', async () => {
    const { load } = fresh()
    const { getCachedReport } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'auto', T1), rowOf('雷军', 'tech', T2)])

    const r = await getCachedReport('雷军#auto')
    eq(r.personKey, '雷军#auto', '本 key 有 ready 报告时维持原行为')
  })

  it('getCachedReports：批量里落空的项逐项判定，位置仍与入参对齐', async () => {
    const { load } = fresh()
    const { getCachedReports } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2), rowOf('张三', 'other', T1)])

    const out = await getCachedReports(['雷军#auto', '雷军#科技', '李四#other', '张三#other'])
    eq(out.length, 4)
    eq(out[0], null, '第 0 位是另一位雷军（auto），不能被 tech 那份顶替')
    eq(out[1] && out[1].personKey, '雷军#tech', '第 1 位领域同义 ⇒ 回退命中')
    eq(out[2], null, '李四确实没有报告 ⇒ null')
    eq(out[3] && out[3].personKey, '张三#other', '第 3 位本 key 命中，原样返回')
  })

  it('getOrBuildReport：本 key 无行且同名者领域不同 ⇒ 不当缓存命中', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    const out = await getOrBuildReport('雷军#auto', {})
    /* 先钉「交回的到底是什么」：只写 `out.fromCache !== true` 时，生成链路整体失灵
       （返回 error / undefined）也会通过 —— 断言必须在最坏情况下也是红的（2026-10-18 复审 P2） */
    ok(out.kind !== 'report', `不能把 tech 那份当缓存命中交回（实际 kind=${out.kind}）`)
    ok(out.fromCache !== true, '不同领域不能算缓存命中')
    ok(!out.report || out.report.personKey !== '雷军#tech', '绝不能把 tech 那份交回来')
  })

  it('getOrBuildReport：找不到任何同名报告时不改变行为（仍进生成/空态）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')

    const out = await getOrBuildReport('查无此人#auto', {})
    ok(out.kind !== 'report', '无缓存又无素材 ⇒ 不该交回 report（这里是 coldstart/nonews/error 之一）')
  })
})
