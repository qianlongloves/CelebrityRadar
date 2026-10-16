'use strict'

/**
 * 无索引回退路径：排序不可用时，端上拿到的行**没有顺序**（2026-10-16）。
 *
 * `report_cache` 的两个兜底消费方都写着「按 generated_at 倒序取最近 N 份就绪报告」，
 * 并在带排序的查询失败时回退到**不排序**扫描（源码注释里的理由是「`orderBy` 依赖该字段索引，
 * 索引未建时云侧会拒」）。但此前 harness 无论有没有排序都成功 —— 于是**这两条回退分支一次都没跑过**，
 * 「回退时到底取到了哪一批」没人钉住，改动它们也不会有用例变红。
 *
 * harness 新增 `__setOrderByFailing`（只让带 orderBy 的查询失败）后，两条分支都可复现。
 * 这里钉住的核心口径是同一句话：**降级可以，但「最近」这个语义不能在降级里丢掉**——
 *   · 会员示例卡按行序取第一份（`pickMemberSample` 挑到的就是「最近一份会员报告」）
 *     ⇒ 端上必须补排序，否则示例可能取自一份陈年报告；
 *   · 热门榜兜底榜自己按热度重排（`merge`），但热度相同时谁进 24 人的榜面由行序决定
 *     ⇒ 不补排序，榜面边界就取决于库当时怎么返回，同一批数据两次进页可能不一样。
 *
 * ⚠ 补得回来的只有**顺序**，补不回来的是**选不到「最近 40 份」**（没有索引就只能拿到任意 40 份，
 * 见 `utils/hot-board.ts` 的注释）——那属于兜底榜的固有缺陷，不是这里能修的。
 */
const env = require('../harness/env')
const { describe, it, ok, eq } = require('../harness/t')

const DAY = 86400000
const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

/** 每个用例从干净状态开始：清 storage + 清库 + 清模块缓存 */
function fresh() {
  env.resetAll()
  return { db: env.db, load: env.load }
}

describe('无索引回退：排序不可用时不排序扫描，但「最近」不能在降级里丢掉', () => {
  it('会员示例：回退路径仍取最近那一份（行序就是优先级，端上补排序）', async () => {
    const { db, load } = fresh()
    const { loadMemberSample } = load('utils/member-sample')
    const rows = []
    for (let i = 0; i < 20; i++) {
      rows.push({
        _id: `s${String(i).padStart(2, '0')}#tech`,
        state: 'ready',
        generated_at: iso(BASE + i * DAY),
        report: { name: `n${i}`, memberNotes: { compare: `对比视角${i}` } }
      })
    }
    /* seed 顺序 = 最旧在前（也就是库的「无排序」返回顺序）。`pickMemberSample` 取第一份合格的,
       所以不补排序时它会取到 n0（最旧的一份）—— 这正是要拦住的回归。 */
    db.__seed('report_cache', rows)
    db.__setOrderByFailing('report_cache', true)

    const sample = await loadMemberSample()

    ok(sample, '回退路径也要出示例卡（不能因为排序失败就整块没有）')
    eq(
      sample.name,
      'n19',
      `示例卡必须取最近一份报告；取到 ${sample.name} 说明回退时丢了「最近」这个语义`
    )
  })

  it('热门榜兜底榜：回退路径仍按「最近优先」决定榜面边界', async () => {
    const { db, load } = fresh()
    const { loadHotBoard } = load('utils/hot-board')
    /* 45 份就绪报告，扫描上限 40 ⇒ 只有 40 份能进候选（这本就是无索引时的固有损失）。
       热度给 100（高于种子池任何一位）且**全部相同**：merge 会把它们统统排在种子前面，
       于是榜面 24 位完全由行序（= 最近优先）决定，断言能直接读出「拿到的是哪一批」。 */
    const rows = []
    for (let i = 0; i < 45; i++) {
      rows.push({
        _id: `p${String(i).padStart(2, '0')}#tech`,
        state: 'ready',
        generated_at: iso(BASE + i * DAY),
        report: { heat: 100, dynamics: [{ title: `动态${i}` }] }
      })
    }
    db.__seed('report_cache', rows)
    db.__setOrderByFailing('report_cache', true)

    const names = (await loadHotBoard()).map((p) => p.name)

    ok(names.length > 0, '排序失败不能让兜底榜空掉（它还有静态种子那一级）')
    ok(
      names.includes('p39'),
      `候选里最新的那一份必须上榜，实际 ${names.join(',')}`
    )
    eq(
      names.filter((n) => ['p00', 'p01', 'p02', 'p03', 'p04'].includes(n)).length,
      0,
      '候选里最旧的 5 份不该在热度相同时挤掉更新的报告'
    )
  })
})
