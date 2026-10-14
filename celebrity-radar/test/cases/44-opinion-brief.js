'use strict'

/**
 * 每日舆情简报（P10，2026-10-14）—— utils/opinion-brief.ts 的纯函数。
 *
 * 钉住三件事：
 *   1. 从统一队列聚合的四个口径：总数 / 风险类别分布 / 影响面分布 / 需回应计数；
 *   2. 空输入给空态（不抛错、图表空数组、计数全 0）；
 *   3. 脏数据防御：非法 category / impact / response 一律按未命中计，绝不产生 NaN、不抛错。
 *
 * 纯函数用例直接 require 编译产物；页面是 .tsx（不进测试编译），与既有页面用例同法读源码文本断言。
 */

const env = require('../harness/env')
const { describe, it, ok, eq } = require('../harness/t')

function load() {
  env.resetAll()
  return {
    rank: env.load('utils/opinion-rank'),
    brief: env.load('utils/opinion-brief')
  }
}

describe('每日舆情简报（P10）：聚合规则', () => {
  it('从统一队列聚合：总数 / 风险类别分布 / 影响面分布 / 需回应计数', () => {
    const { rank, brief } = load()
    /* 用 buildOpinionQueue 走真实归一，再喂给简报，端到端钉住数据流 */
    const queue = rank.buildOpinionQueue({
      keywords: [],
      watchNames: ['张三'],
      feed: [
        { title: '张三被指侵权', source: 'S1', date: '2026-10-09', person: '张三', personKey: '张三#ent', category: 'rights', level: 'high' },
        { title: '李四涉税传闻', source: 'S2', date: '2026-10-08', person: '李四', personKey: '李四#ent', category: 'tax', level: 'mid' },
        { title: '张三再度回应', source: 'S3', date: '2026-10-07', person: '张三', personKey: '张三#ent', category: 'rights', level: 'low' }
      ],
      weekly: [],
      alerts: []
    })

    const b = brief.buildDailyBrief(queue)

    eq(b.total, 3, '总数 = 队列条数')
    eq(b.riskCount, 3, '三条都有风险类别')

    /* 风险类别分布：rights 2 条、tax 1 条；比例以最大值为满格 */
    const rights = b.categories.find((c) => c.key === 'rights')
    const tax = b.categories.find((c) => c.key === 'tax')
    ok(rights, 'rights 类别存在')
    ok(tax, 'tax 类别存在')
    eq(rights.count, 2, 'rights 命中 2 条')
    eq(tax.count, 1, 'tax 命中 1 条')
    eq(rights.ratio, 1, 'rights 是最大值 → 满格比例 1')
    eq(tax.ratio, 0.5, 'tax 是最大值的一半 → 比例 0.5')

    /* 影响面分布：high / mid / low 各 1 条 */
    const high = b.impacts.find((i) => i.key === 'high')
    const mid = b.impacts.find((i) => i.key === 'mid')
    const low = b.impacts.find((i) => i.key === 'low')
    ok(high, '影响面 high 档存在')
    ok(mid, '影响面 mid 档存在')
    ok(low, '影响面 low 档存在')
    eq(high.count, 1, 'high 命中 1 条')
    eq(mid.count, 1, 'mid 命中 1 条')
    eq(low.count, 1, 'low 命中 1 条')

    /* 需回应：rights+high → 建议回应；rights+low → 建议关注 */
    eq(b.respondCount, 1, 'rights + high → 建议回应')
    eq(b.watchCount, 1, 'rights + low → 建议关注')
  })

  it('空输入给空态：不抛错，图表为空数组、计数全 0', () => {
    const { brief } = load()
    const b = brief.buildDailyBrief([])
    eq(b.total, 0)
    eq(b.riskCount, 0)
    eq(b.categories.length, 0)
    eq(b.impacts.length, 0)
    eq(b.respondCount, 0)
    eq(b.watchCount, 0)
  })

  it('脏数据防御：非法 category / impact / response 一律按未命中计，不产生 NaN、不抛错', () => {
    const { brief } = load()
    /* 直接喂绕过归一后的脏对象，模拟极端调用，验证白名单防御 */
    const b = brief.buildDailyBrief([
      { category: '不是合法类别', impact: '不是合法档位', response: '不是合法回应' }
    ])
    eq(b.total, 1, '脏条目也计入总数')
    eq(b.riskCount, 0, '非法类别不计风险')
    eq(b.categories.length, 0, '非法类别不产生柱子')
    eq(b.impacts.length, 0, '非法影响面不产生柱子')
    eq(b.respondCount, 0)
    eq(b.watchCount, 0)
  })
})
