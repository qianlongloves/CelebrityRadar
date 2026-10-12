'use strict'

/**
 * 人物索引：名字 → 最新 personKey 的读取侧归一（Task A，2026-10-12）
 *
 * 背景：`report_cache` 主键是「名字#领域」，领域由各入口自己决定；领域自由化后同一个人很容易
 * 被写成两行（实测「雷军#tech」与「雷军#auto」并存）。本用例钉住三件事：
 *   1. `resolvePersonKey` 的判定顺序 —— 有报告就返回**最新那一份**的 key，没有就退回入参 key；
 *   2. 缓存**落空**时（getCachedReport / getCachedReports / getOrBuildReport）按名字回退命中最新那份；
 *   3. 端上零阻塞 —— 命中即记住（storage + 内存），此后不再查库；查询失败一律退回入参 key。
 *
 * 说明：这里不触发真实生成 —— getOrBuildReport 的回退命中会在第 0 步（缓存命中）直接返回。
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

describe('resolvePersonKey：名字 → 最新 personKey（Task A）', () => {
  it('没有任何报告 ⇒ 退回调用方给的「名字#领域」', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')

    eq(await resolvePersonKey('雷军', 'auto'), '雷军#auto', '无缓存时维持各入口自己的领域')
  })

  it('同一名字两行 ⇒ 返回 generated_at 最新的那份（跨领域归一）', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'auto', T1), rowOf('雷军', 'tech', T2)])

    eq(await resolvePersonKey('雷军', 'auto'), '雷军#tech', '应命中较新的 tech 那份，而不是入参的 auto')
  })

  it('命中后写进索引：再次解析不再查库', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    eq(await resolvePersonKey('雷军', 'auto'), '雷军#tech')
    const before = env.db.stats.getCalls
    eq(await resolvePersonKey('雷军', 'business'), '雷军#tech', '索引记住后不再查库')
    eq(env.db.stats.getCalls, before, '第二次解析不应产生新的库读')
    /* 冷启路径：storage 里也落了索引（pidx:雷军） */
    eq(env.storage.get('pidx:雷军'), '雷军#tech', '索引要写进 storage，冷启免一次查询')
  })

  it('并发去重：同一名字的并发解析共用一个 promise（只查一次库）', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    const before = env.db.stats.getCalls
    const [a, b] = await Promise.all([resolvePersonKey('雷军', 'auto'), resolvePersonKey('雷军', 'other')])
    eq(a, '雷军#tech')
    eq(b, '雷军#tech')
    eq(env.db.stats.getCalls - before, 1, '两个并发解析只该产生一次 report_cache 查询')
  })

  it('查询失败 ⇒ 退回入参 key（端上零阻塞，绝不抛错）', async () => {
    const { load } = fresh()
    const { resolvePersonKey } = load('utils/person-index')
    env.db.__setReadFailing('report_cache', true)

    eq(await resolvePersonKey('雷军', 'auto'), '雷军#auto', '读失败时退回入参 key，行为与改动前一致')
  })
})

describe('读取侧按名字回退：落空时命中最新那份（Task A）', () => {
  it('getCachedReport：本 key 无行 ⇒ 回退命中同名的另一 key', async () => {
    const { load } = fresh()
    const { getCachedReport } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    const r = await getCachedReport('雷军#auto')
    ok(r, '应命中回退到的那一份，而不是 null')
    eq(r.personKey, '雷军#tech')
  })

  it('getCachedReport：本 key 有行 ⇒ 用自己那份（不回退，不额外查库）', async () => {
    const { load } = fresh()
    const { getCachedReport } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'auto', T1), rowOf('雷军', 'tech', T2)])

    const r = await getCachedReport('雷军#auto')
    eq(r.personKey, '雷军#auto', '本 key 有 ready 报告时维持原行为')
  })

  it('getCachedReports：批量里落空的那一位按名字回退，位置仍与入参对齐', async () => {
    const { load } = fresh()
    const { getCachedReports } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2), rowOf('张三', 'other', T1)])

    const out = await getCachedReports(['雷军#auto', '李四#other', '张三#other'])
    eq(out.length, 3)
    eq(out[0] && out[0].personKey, '雷军#tech', '第 0 位（原 key 无行）应回退到 tech 那份')
    eq(out[1], null, '李四确实没有报告 ⇒ null')
    eq(out[2] && out[2].personKey, '张三#other', '第 2 位本 key 命中，原样返回')
  })

  it('getOrBuildReport：本 key 无行 ⇒ 当缓存命中交回回退到的那份（不生成、不计数）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', T2)])

    const out = await getOrBuildReport('雷军#auto', {})
    eq(out.kind, 'report')
    ok(out.fromCache === true, '回退命中属于缓存命中，应标 fromCache')
    eq(out.report.personKey, '雷军#tech')
  })

  it('getOrBuildReport：找不到任何同名的报告时不改变行为（仍进生成/空态）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')

    const out = await getOrBuildReport('查无此人#auto', {})
    ok(out.kind !== 'report', '无缓存又无素材 ⇒ 不该交回 report（这里是 coldstart/nonews/error 之一）')
  })
})
