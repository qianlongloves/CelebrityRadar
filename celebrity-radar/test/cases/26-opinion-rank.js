'use strict'

/**
 * 舆情判断层（P1，2026-10-13）—— utils/opinion-rank.ts 的纯函数与舆情页静态约束。
 *
 * 钉住四件事：
 *   1. 三类判断的推导规则（影响面只认已有级别字段、可信度按来源数与来源类型、是否需回应）；
 *      **数据不足一律标 未评级 / 未知，绝不猜**；
 *   2. 统一队列的排序优先级（监控词 > 关注的人 > 其余 → 影响面 → 需回应 → 时间）；
 *   3. 同事件去重（只留最重要的一条）与今日要点（≤3 条、无来源排除、不凑数）；
 *   4. 脏数据不抛出、空输入给空态。
 *
 * 纯函数用例直接 require 编译产物；页面是 .tsx（不进测试编译），与既有页面用例同法读源码文本断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, eq } = require('../harness/t')

function U() {
  env.resetAll()
  return env.load('utils/opinion-rank')
}

describe('舆情判断：分级规则（算不出就标未知，不猜）', () => {
  it('影响面：只认已有的级别字段，其余一律未评级', () => {
    const { impactOf } = U()
    eq(impactOf('high'), 'high')
    eq(impactOf('mid'), 'mid')
    eq(impactOf('low'), 'low')
    eq(impactOf(undefined), 'unknown', '没有级别字段 = 未评级')
    eq(impactOf('极高'), 'unknown', '词典外的值不认，回退未评级')
    eq(impactOf(3), 'unknown', '非字符串同样回退未评级')
  })

  it('可信度：来源为空→未知；1 个来源→单一来源；≥2→多方报道；含官方渠道→官方通报', () => {
    const { credibilityOf } = U()
    eq(credibilityOf([]), 'unknown')
    eq(credibilityOf(['']), 'unknown')
    eq(credibilityOf(['新浪娱乐']), 'single')
    eq(credibilityOf(['新浪娱乐', '搜狐娱乐']), 'multi')
    eq(credibilityOf(['新浪娱乐', '新浪娱乐']), 'single', '同一来源重复出现不算多方')
    eq(credibilityOf(['某某人民法院']), 'official', '官方渠道前缀 → 官方通报（不含「已确认」措辞）')
    eq(credibilityOf(['新浪娱乐', '某某法院']), 'official')
  })

  it('是否需回应：high→建议回应；名誉维权/回应表态→建议关注；其余→无需回应；无信息→未知', () => {
    const { responseOf } = U()
    eq(responseOf('judicial', 'high'), 'respond')
    eq(responseOf(undefined, 'high'), 'respond', '高严重度即倾向建议回应')
    eq(responseOf('rights', undefined), 'watch')
    eq(responseOf('statement', 'low'), 'watch')
    eq(responseOf('contract', 'mid'), 'none')
    eq(responseOf(undefined, undefined), 'unknown', '没有类别也没有级别 = 未知')
  })

  it('官方来源判定是启发式：只看来源名里的官方标识词', () => {
    const { isOfficialSource } = U()
    ok(isOfficialSource('某某市公安局'))
    ok(isOfficialSource('证监会发布'))
    ok(!isOfficialSource('某娱乐自媒体'))
    ok(!isOfficialSource(''))
  })
})

describe('舆情判断：同事件去重', () => {
  it('归一化：去空白与标点、转小写，只留中日韩/字母/数字', () => {
    const { normalizeTitle } = U()
    eq(normalizeTitle('【重磅】关于 X 的声明！'), '重磅关于x的声明')
    eq(normalizeTitle('   '), '')
  })

  it('同事件判定：完全相同 / 长标题互相包含 / 长公共前缀；短标题的包含不误并', () => {
    const { sameEvent } = U()
    ok(sameEvent('关于X公司的声明', '关于X公司的声明'))
    ok(sameEvent('关于X公司起诉事件的声明', '【重磅】关于X公司起诉事件的声明'), '长标题被包含')
    ok(!sameEvent('声明', '关于X公司的声明'), '短标题（<8 字）不做包含判定')
    ok(!sameEvent('A公司发布新品', 'B公司回应传闻'), '无关标题不合并')
    ok(!sameEvent('', '关于X公司的声明'))
  })

  it('去重后只留最重要的一条，且可信度按整组来源算', () => {
    const { buildOpinionQueue } = U()
    const queue = buildOpinionQueue({
      feed: [
        { title: '关于X公司起诉事件的声明', source: 'A报', date: '2026-10-05', person: '张三' },
        { title: '【重磅】关于X公司起诉事件的声明', source: 'B报', date: '2026-10-06', person: '张三' }
      ],
      watchNames: ['张三']
    })
    eq(queue.length, 1, '同事件合成一条')
    eq(queue[0].sourceCount, 2, '两个来源都记在事件上')
    eq(queue[0].credibility, 'multi', '同事件两个来源 → 多方报道')
    eq(queue[0].title, '【重磅】关于X公司起诉事件的声明', '代表取排序更靠前（更新）的那条')
  })
})

describe('舆情判断：统一队列排序优先级', () => {
  it('命中监控词 > 命中关注的人 > 其余（命中档位压倒时间新旧）', () => {
    const { buildOpinionQueue } = U()
    const queue = buildOpinionQueue({
      keywords: ['塌房'],
      watchNames: ['张三'],
      feed: [
        { title: '来自关注者的普通动态', source: 'A', date: '2026-10-05', person: '张三' },
        { title: '与我无关的报道', source: 'B', date: '2026-10-09' }
      ],
      alerts: [{ title: '命中监控词的报道', source: 'C', date: '2026-10-01', keyword: '塌房' }]
    })
    eq(
      queue.map((e) => e.title).join('|'),
      '命中监控词的报道|来自关注者的普通动态|与我无关的报道'
    )
    ok(queue[0].hitsKeyword && !queue[0].hitsFollow)
    ok(queue[1].hitsFollow && !queue[1].hitsKeyword)
    ok(!queue[2].hitsKeyword && !queue[2].hitsFollow)
  })

  it('同档位下：影响面高者优先（压过时间）', () => {
    const { buildOpinionQueue } = U()
    const queue = buildOpinionQueue({
      watchNames: ['张三'],
      alerts: [
        { title: 'A人被起诉', source: 'X', date: '2026-10-01', person: '张三', category: 'judicial', level: 'high' },
        { title: 'A人新片上映', source: 'Y', date: '2026-10-09', person: '张三' }
      ]
    })
    eq(queue[0].title, 'A人被起诉', '高影响面排在前，即使时间更旧')
    eq(queue[0].impact, 'high')
    eq(queue[0].response, 'respond')
  })

  it('同档位、同影响面下：需回应者优先', () => {
    const { buildOpinionQueue } = U()
    const queue = buildOpinionQueue({
      watchNames: ['张三'],
      alerts: [
        { title: '某人起诉造谣者', source: 'X', date: '2026-10-01', person: '张三', category: 'rights' },
        { title: '某人代言到期', source: 'Y', date: '2026-10-09', person: '张三', category: 'contract' }
      ]
    })
    eq(queue[0].title, '某人起诉造谣者', '建议关注排在无需回应之前')
    eq(queue[0].response, 'watch')
    eq(queue[1].response, 'none')
  })

  it('同档位同影响面：时间新者优先', () => {
    const { buildOpinionQueue } = U()
    const queue = buildOpinionQueue({
      feed: [
        { title: '旧闻一条', source: 'A', date: '2026-10-01' },
        { title: '新闻一条', source: 'B', date: '2026-10-09' }
      ]
    })
    eq(queue[0].title, '新闻一条')
  })

  it('「为什么值得注意」按来源分类：监控词 / 风险词 / 关注的人', () => {
    const { buildOpinionQueue } = U()
    const queue = buildOpinionQueue({
      keywords: ['塌房'],
      watchNames: ['张三'],
      alerts: [
        { title: '命中词的报道', source: 'A', date: '2026-10-03', keyword: '塌房' },
        { title: '风险信号报道', source: 'B', date: '2026-10-02', person: '张三', category: 'tax', level: 'high' },
        { title: '普通关注动态', source: 'C', date: '2026-10-01', person: '张三' }
      ]
    })
    const byTitle = (t) => queue.find((e) => e.title === t)
    eq(byTitle('命中词的报道').reason, '命中你的监控词')
    eq(byTitle('风险信号报道').reason, '命中「税务合规」类风险词')
    eq(byTitle('普通关注动态').reason, '来自你关注/监控的名人')
  })
})

describe('今日需要注意的 N 件事', () => {
  it('最多 3 条，且无来源的条目一律排除', () => {
    const { buildOpinionQueue, pickDailyFocus } = U()
    const queue = buildOpinionQueue({
      watchNames: ['张三'],
      feed: [
        { title: '条一', source: 'A', date: '2026-10-09', person: '张三' },
        { title: '条二', source: '', date: '2026-10-08', person: '张三' }, /* 无来源 */
        { title: '条三', source: 'C', date: '2026-10-07', person: '张三' },
        { title: '条四', source: 'D', date: '2026-10-06', person: '张三' },
        { title: '条五', source: 'E', date: '2026-10-05', person: '张三' }
      ]
    })
    const focus = pickDailyFocus(queue)
    eq(focus.length, 3, '封顶 3 条')
    ok(
      focus.every((e) => !!e.source),
      '无来源的条二不得进要点'
    )
    ok(!focus.some((e) => e.title === '条二'))
  })

  it('不凑数：既非命中、又无风险级别的「其余」条目不进要点', () => {
    const { buildOpinionQueue, pickDailyFocus } = U()
    const queue = buildOpinionQueue({ feed: [{ title: '与我无关的报道', source: 'A', date: '2026-10-09' }] })
    eq(queue.length, 1)
    eq(pickDailyFocus(queue).length, 0, '无关注命中也无风险依据 → 不进今日要点')
  })

  it('limit 参数生效', () => {
    const { buildOpinionQueue, pickDailyFocus } = U()
    const queue = buildOpinionQueue({
      watchNames: ['张三'],
      feed: [
        { title: '条一', source: 'A', date: '2026-10-09', person: '张三' },
        { title: '条二', source: 'B', date: '2026-10-08', person: '张三' }
      ]
    })
    eq(pickDailyFocus(queue, 1).length, 1)
    eq(pickDailyFocus(queue, 0).length, 0)
  })

  it('数据不足时标未评级 / 未知（不是编一个值）', () => {
    const { buildOpinionQueue } = U()
    const e = buildOpinionQueue({ feed: [{ title: '一条没有分级的动态', source: '某报' }] })[0]
    eq(e.impact, 'unknown')
    eq(e.response, 'unknown')
    eq(e.credibility, 'single', '有一个来源但非官方 → 单一来源')
  })

  it('空输入 / 空态：不抛错、返回空数组', () => {
    const { buildOpinionQueue, pickDailyFocus } = U()
    eq(buildOpinionQueue().length, 0)
    eq(buildOpinionQueue({}).length, 0)
    eq(buildOpinionQueue({ feed: [], weekly: [], alerts: [] }).length, 0)
    eq(pickDailyFocus([]).length, 0)
  })

  it('脏数据一律跳过该条，绝不抛出', () => {
    const { buildOpinionQueue } = U()
    const queue = buildOpinionQueue({
      feed: [
        null,
        undefined,
        'not-an-object',
        123,
        [],
        { title: '' },
        { title: '   ' },
        { title: 456 },
        { title: '有效条目', source: 'S', date: '2026-10-09', person: '张三' }
      ],
      weekly: 'not-an-array',
      alerts: [{}],
      keywords: 'not-array',
      watchNames: null
    })
    eq(queue.length, 1, '只留下唯一一条有标题的条目')
    eq(queue[0].title, '有效条目')
  })
})

/* ───────────────── 舆情页静态约束（.tsx 不进测试编译，读源码文本断言） ───────────────── */

describe('舆情页：今日要点与分级标签已接入（静态约束）', () => {
  const SRC = path.resolve(__dirname, '..', '..', 'src')
  const page = fs.readFileSync(path.join(SRC, 'pages', 'opinion', 'index.tsx'), 'utf8')
  const scss = fs.readFileSync(path.join(SRC, 'pages', 'opinion', 'index.scss'), 'utf8')

  it('复用纯函数判断层，不把规则写进页面', () => {
    ok(page.includes("from '@/utils/opinion-rank'"), '舆情页应引用 utils/opinion-rank')
    ok(page.includes('buildOpinionQueue(') && page.includes('pickDailyFocus('), '应调用统一队列与今日要点')
  })

  it('页首有「今日需要注意的 N 件事」卡，且有无要点时的优雅空态', () => {
    ok(page.includes('今日需要注意的'), '缺今日要点卡标题')
    ok(page.includes('今天没有需要你特别留意的事'), '缺今日要点空态文案')
  })

  it('每条带来源与时间：来源缺失显式写「来源未标注」，不编造来源', () => {
    ok(page.includes('来源未标注'), '缺来源时不得编一个来源')
    ok(page.includes('formatMoment8('), '条目要显示时间')
  })

  it('各块条目带分级标签，样式克制（默认灰调，仅需回应/建议关注轻点色）', () => {
    ok(page.includes('page-opinion__tag'), '缺分级标签')
    ok(page.includes('IMPACT_LABEL') && page.includes('CRED_LABEL') && page.includes('RESPONSE_LABEL'))
    ok(scss.includes('&__tag'), '缺标签样式')
    ok(scss.includes('&--respond') && scss.includes('&--watch'), '需回应/建议关注应有轻量强调样式')
  })
})
