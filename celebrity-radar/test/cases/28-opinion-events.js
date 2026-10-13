'use strict'

/**
 * 舆情事件聚合与时间线（P3，2026-10-13）—— utils/opinion-events.ts 的纯函数与舆情页静态约束。
 *
 * 钉住六件事：
 *   1. 「同一事件」的多来源聚成一条（复用 P1 的 sameEvent 判据：完全相同 / 长标题互相包含 /
 *      长公共前缀），**不同事件不被误并**；
 *   2. 时间线按时间正序、每条都带来源与来源性质；无来源的条目不进时间线、也不支撑「是否需回应」；
 *   3. 聚合规则：影响面取最高、可信度按整组去重来源重算（与 P1 credibilityOf 同口径）、需回应取最严；
 *   4. 事件标题选取规则（只从带来源成员里选 + 归一后最长优先）；
 *   5. 脏数据跳过不抛、空输入返回空；纯函数对任何输入都不抛；
 *   6. 免费用户事件明细 / 时间线条目受限，而今日要点（pickDailyFocus）不受限；舆情页已接入事件卡。
 *
 * 纯函数直接 require 编译产物；页面是 .tsx（不进测试编译），与既有页面用例同法读源码文本断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

function E() {
  env.resetAll()
  return env.load('utils/opinion-events')
}

/* ───────────────────────── 1. 同一事件聚类 ───────────────────────── */

describe('事件聚合：同一事件聚成一条（复用 P1 判据）', () => {
  it('完全相同 / 长标题互相包含 / 长公共前缀 三种形态各聚成一条', () => {
    const { buildOpinionEvents } = E()

    // 完全相同（去标点后归一相同）
    const same = buildOpinionEvents({
      feed: [
        { title: '关于X公司的声明', source: 'A报', date: '2026-10-03' },
        { title: '【重磅】关于 X 公司的声明！', source: 'B报', date: '2026-10-04' }
      ]
    })
    eq(same.length, 1, '完全相同（归一后）应聚成一条')
    eq(same[0].memberCount, 2, '成员数量记录几条来源在说同一件事')
    eq(same[0].sources.length, 2, '两个来源都记在事件上')

    // 长标题互相包含
    const contains = buildOpinionEvents({
      feed: [
        { title: '关于X公司起诉事件的声明', source: 'A报', date: '2026-10-03' },
        { title: '【重磅】关于X公司起诉事件的声明', source: 'B报', date: '2026-10-04' }
      ]
    })
    eq(contains.length, 1, '长标题互相包含应聚成一条')

    // 长公共前缀（>= 12 字，且互不包含）
    const prefix = buildOpinionEvents({
      feed: [
        { title: '某某公司被起诉事件有了新的进展甲', source: 'A报', date: '2026-10-03' },
        { title: '某某公司被起诉事件有了新的进展乙', source: 'B报', date: '2026-10-04' }
      ]
    })
    eq(prefix.length, 1, '长公共前缀应聚成一条')
  })

  it('不同事件不会被误并', () => {
    const { buildOpinionEvents } = E()
    const events = buildOpinionEvents({
      feed: [
        { title: 'A公司发布新品', source: 'A报', date: '2026-10-03' },
        { title: 'B公司回应传闻', source: 'B报', date: '2026-10-04' }
      ]
    })
    eq(events.length, 2, '无关标题不得合并')
  })

  it('跨块的同一事件也聚成一条（feed 与 alert 里各有一条）', () => {
    const { buildOpinionEvents } = E()
    const events = buildOpinionEvents({
      keywords: ['塌房'],
      feed: [{ title: '关于X公司的声明', source: 'A报', date: '2026-10-03', person: '张三' }],
      alerts: [{ title: '【重磅】关于X公司的声明', source: 'B报', date: '2026-10-04', keyword: '塌房' }]
    })
    eq(events.length, 1, '同一事件跨块也应聚成一条')
    eq(events[0].memberCount, 2)
    ok(events[0].members.some((m) => m.block === 'feed') && events[0].members.some((m) => m.block === 'alert'))
  })
})

/* ───────────────────────── 2. 时间线 ───────────────────────── */

describe('事件聚合：时间线归因', () => {
  it('按时间正序排列，且每条都带来源与来源性质', () => {
    const { buildOpinionEvents } = E()
    const ev = buildOpinionEvents({
      feed: [
        { title: 'X事件最新进展', source: 'C报', date: '2026-10-09' },
        { title: 'X事件最新进展：', source: 'A报', date: '2026-10-02' },
        { title: 'X事件最新进展！', source: '某某市公安局', date: '2026-10-05' }
      ]
    })[0]

    eq(ev.timeline.length, 3, '三条都带来源与时间 → 都进时间线')
    const dates = ev.timeline.map((t) => Date.parse(t.date))
    ok(dates[0] <= dates[1] && dates[1] <= dates[2], '时间线必须按时间正序')
    ok(ev.timeline.every((t) => !!t.source), '每条时间线必须带来源')
    ok(ev.timeline.every((t) => !!t.nature), '每条时间线必须带来源性质')
    eq(ev.timeline[0].source, 'A报', '最早的一条排在最前')
    eq(ev.timeline.find((t) => t.source === '某某市公安局').nature, 'official', '官方渠道标为官方通报')
    eq(ev.timeline.find((t) => t.source === 'C报').nature, 'media', '普通媒体标为媒体报道')
  })

  it('无来源的条目不进时间线、也不用来支撑「是否需回应」', () => {
    const { buildOpinionEvents } = E()
    const ev = buildOpinionEvents({
      alerts: [
        // 无来源：级别 high（本会推成「建议回应」），但无来源 → 红线 2 排除
        { title: '关于Y公司的声明', date: '2026-10-01', category: 'judicial', level: 'high' },
        // 有来源、无类别无级别 → 需回应未知
        { title: '【重磅】关于Y公司的声明', source: 'A报', date: '2026-10-02' }
      ]
    })[0]

    eq(ev.memberCount, 2, '两条成员都算进成员数')
    eq(ev.timeline.length, 1, '只有带来源的那条进时间线')
    eq(ev.timeline[0].source, 'A报')
    eq(ev.response, 'unknown', '无来源的 high 条目不参与「需回应」聚合')
    eq(ev.impact, 'high', '影响面仍取成员里最高（级别是条目自带字段）')
  })
})

/* ───────────────────────── 3. 聚合规则 ───────────────────────── */

describe('事件聚合：影响面 / 可信度 / 需回应的聚合规则', () => {
  it('影响面取成员里最高（不做平均）', () => {
    const { buildOpinionEvents } = E()
    const ev = buildOpinionEvents({
      alerts: [
        { title: '关于Z公司的声明', source: 'A报', date: '2026-10-01', category: 'contract', level: 'low' },
        { title: '【重磅】关于Z公司的声明', source: 'B报', date: '2026-10-02', category: 'judicial', level: 'high' }
      ]
    })[0]
    eq(ev.impact, 'high', '一组里有一条高，整体就按高（平均值会把它稀释掉）')
  })

  it('可信度按整组去重来源重算（与 P1 credibilityOf 同口径）', () => {
    const { buildOpinionEvents } = E()
    const multi = buildOpinionEvents({
      feed: [
        { title: '关于W公司的声明', source: 'A报', date: '2026-10-01' },
        { title: '【重磅】关于W公司的声明', source: 'B报', date: '2026-10-02' }
      ]
    })[0]
    eq(multi.credibility, 'multi', '同事件两个不同来源 → 多方报道')

    const dup = buildOpinionEvents({
      feed: [
        { title: '关于V公司的声明', source: 'A报', date: '2026-10-01' },
        { title: '【重磅】关于V公司的声明', source: 'A报', date: '2026-10-02' }
      ]
    })[0]
    eq(dup.credibility, 'single', '同一来源重复出现不算多方')
    eq(dup.sources.length, 1, '去重后只有一个来源')

    const official = buildOpinionEvents({
      feed: [
        { title: '关于U公司的声明', source: 'A报', date: '2026-10-01' },
        { title: '【重磅】关于U公司的声明', source: '某某人民法院', date: '2026-10-02' }
      ]
    })[0]
    eq(official.credibility, 'official', '组内含官方渠道 → 官方通报（非「已确认」）')
  })

  it('是否需回应取成员里最严的一档', () => {
    const { buildOpinionEvents } = E()
    const watch = buildOpinionEvents({
      alerts: [
        { title: '关于T公司的声明', source: 'A报', date: '2026-10-01', category: 'contract' },
        { title: '【重磅】关于T公司的声明', source: 'B报', date: '2026-10-02', category: 'rights' }
      ]
    })[0]
    eq(watch.response, 'watch', '建议关注 > 无需回应')

    const respond = buildOpinionEvents({
      alerts: [
        { title: '关于S公司的声明', source: 'A报', date: '2026-10-01', category: 'rights' },
        { title: '【重磅】关于S公司的声明', source: 'B报', date: '2026-10-02', category: 'judicial', level: 'high' }
      ]
    })[0]
    eq(respond.response, 'respond', '建议回应 > 建议关注')
  })

  it('命中监控词 / 关注的人取并集（事件级「与我相关」）', () => {
    const { buildOpinionEvents } = E()
    const ev = buildOpinionEvents({
      keywords: ['塌房'],
      watchNames: ['张三'],
      feed: [
        { title: '关于R公司的声明', source: 'A报', date: '2026-10-01', person: '张三' },
        { title: '【重磅】关于R公司的声明', source: 'B报', date: '2026-10-02', keyword: '塌房' }
      ]
    })[0]
    ok(ev.hitsKeyword, '任一成员命中监控词 → 事件命中')
    ok(ev.hitsFollow, '任一成员命中关注的人 → 事件命中')
    ok(ev.labels.includes('张三') && ev.labels.includes('塌房'), '事件级「谁」取成员归属去重')
  })
})

/* ───────────────────────── 4. 事件标题选取 ───────────────────────── */

describe('事件聚合：事件标题选取规则', () => {
  it('从带来源的成员里选，归一后最长者优先', () => {
    const { buildOpinionEvents } = E()
    const ev = buildOpinionEvents({
      feed: [
        { title: '关于Q公司的声明', source: 'A报', date: '2026-10-01' },
        { title: '【重磅】关于Q公司的声明', source: 'B报', date: '2026-10-02' }
      ]
    })[0]
    eq(ev.title, '【重磅】关于Q公司的声明', '更长的标题信息更全，作为事件标题')
  })

  it('无来源条目不作为事件标题（不可追溯），全体无来源时才退回全体', () => {
    const { buildOpinionEvents } = E()
    const noSrc = buildOpinionEvents({
      feed: [
        { title: '【重磅】关于P公司起诉的声明与后续', date: '2026-10-01' }, // 无来源但更长
        { title: '关于P公司起诉的声明', source: 'A报', date: '2026-10-02' }
      ]
    })[0]
    eq(noSrc.title, '关于P公司起诉的声明', '退到带来源的成员选标题')
  })
})

/* ───────────────────────── 5. 健壮性 ───────────────────────── */

describe('事件聚合：脏数据与空输入', () => {
  it('空输入 / 空态：不抛错、返回空数组', () => {
    const { buildOpinionEvents } = E()
    eq(buildOpinionEvents().length, 0)
    eq(buildOpinionEvents({}).length, 0)
    eq(buildOpinionEvents({ feed: [], weekly: [], alerts: [] }).length, 0)
  })

  it('脏数据一律跳过该条，绝不抛出', () => {
    const { buildOpinionEvents } = E()
    const events = buildOpinionEvents({
      feed: [
        null,
        undefined,
        'not-an-object',
        123,
        [],
        { title: '' },
        { title: '   ' },
        { title: 456 },
        { title: '有效事件条目', source: 'S', date: '2026-10-09', person: '张三' }
      ],
      weekly: 'not-an-array',
      alerts: [{}],
      keywords: 'not-array',
      watchNames: null
    })
    eq(events.length, 1, '只留下唯一一条有标题的条目')
    eq(events[0].title, '有效事件条目')
    eq(events[0].memberCount, 1)
  })

  it('时间不可解析的条目不进时间线，但不影响事件产出', () => {
    const { buildOpinionEvents } = E()
    const ev = buildOpinionEvents({
      feed: [
        { title: '关于O公司的声明', source: 'A报', date: '不是日期' },
        { title: '【重磅】关于O公司的声明', source: 'B报', date: '2026-10-02' }
      ]
    })[0]
    eq(ev.memberCount, 2, '两条成员都算数')
    eq(ev.timeline.length, 1, '时间不可解析的那条不进时间线')
    eq(ev.timeline[0].source, 'B报')
  })

  it('sourceNatureOf：官方标识词 → official；普通媒体 → media；空 → unknown', () => {
    const { sourceNatureOf, SOURCE_NATURE_LABEL } = E()
    eq(sourceNatureOf('某某市公安局'), 'official')
    eq(sourceNatureOf('某娱乐自媒体'), 'media')
    eq(sourceNatureOf(''), 'unknown')
    eq(sourceNatureOf(null), 'unknown')
    eq(SOURCE_NATURE_LABEL.official, '官方通报')
    eq(SOURCE_NATURE_LABEL.media, '媒体报道')
  })
})

/* ───────────────────────── 6. 复用 P1（不另写一套判据） ───────────────────────── */

describe('事件聚合：复用 P1 判据（源码钉住，不另写相似度规则）', () => {
  it('opinion-events 复用 opinion-rank 的分组与标题归一，不自己实现 sameEvent', () => {
    const src = read('utils/opinion-events.ts')
    ok(src.includes("from './opinion-rank'"), '事件层应引用 P1 的 opinion-rank')
    ok(src.includes('buildOpinionGroups'), '分组应走 P1 的 buildOpinionGroups（sameEvent 的唯一实现）')
    ok(src.includes('normalizeTitle'), '标题归一应复用 P1 的 normalizeTitle')
    ok(src.includes('credibilityOf') && src.includes('compareOpinionOrder'), '可信度与排序口径同样复用 P1')
    notOk(/function\s+sameEvent/.test(src), '事件层不得另写一套 sameEvent')
  })

  it('opinion-rank 把分组对外暴露且 buildOpinionQueue 仍走同一实现', () => {
    const src = read('utils/opinion-rank.ts')
    ok(src.includes('export function buildOpinionGroups'), 'P1 应导出分组供事件层复用')
    ok(src.includes('export function compareOpinionOrder'), 'P1 应导出排序口径供事件层复用')
  })
})

/* ───────────────────────── 7. 分层（复用 opinion-access） ───────────────────────── */

describe('事件卡分层：免费受限、今日要点不受限', () => {
  it('免费事件明细切到 5 条、时间线同样切；会员全部；今日要点照常 3 条', () => {
    env.resetAll()
    const { sliceDetail } = env.load('utils/opinion-access')
    const { buildOpinionQueue, pickDailyFocus } = env.load('utils/opinion-rank')
    const { buildOpinionEvents } = env.load('utils/opinion-events')

    const feed = Array.from({ length: 9 }, (_, i) => ({
      title: `报道第${i}条`,
      source: '某报',
      date: `2026-10-0${(i % 9) + 1}`,
      person: '张三'
    }))
    const input = { feed, watchNames: ['张三'] }
    const events = buildOpinionEvents(input)
    const queue = buildOpinionQueue(input)

    eq(events.length, 9, '九条不同事件不合并')
    eq(sliceDetail(events, false).rows.length, 5, '免费档事件明细被切到 5 条')
    eq(sliceDetail(events, true).rows.length, 9, '会员看到全部事件')
    eq(pickDailyFocus(queue).length, 3, '今日要点照常 3 条 —— 不受明细分层影响')
  })

  it('单个事件的时间线也用同一 sliceDetail 门禁（免费不放全）', () => {
    env.resetAll()
    const { sliceDetail } = env.load('utils/opinion-access')
    const { buildOpinionEvents } = env.load('utils/opinion-events')

    // 同一事件造 9 条时间线节点（标题共享长前缀，归一后判为同一事件）
    const feed = Array.from({ length: 9 }, (_, i) => ({
      title: `关于N公司起诉事件的声明第${i}篇`,
      source: `报${i}`,
      date: `2026-10-0${(i % 9) + 1}`
    }))
    const ev = buildOpinionEvents({ feed })[0]
    eq(ev.memberCount, 9, '九条来源聚成一个事件')
    eq(sliceDetail(ev.timeline, false).rows.length, 5, '免费档时间线被切到 5 条')
    eq(sliceDetail(ev.timeline, false).hidden, 4, '隐藏 4 条（供提示行）')
    eq(sliceDetail(ev.timeline, true).rows.length, 9, '会员看到全部节点')
  })
})

/* ───────────────────────── 8. 舆情页静态约束 ───────────────────────── */

describe('舆情页：事件时间线视角已接入（静态约束）', () => {
  const page = read('pages/opinion/index.tsx')
  const scss = read('pages/opinion/index.scss')

  it('引用事件纯函数层，不把聚类规则写进页面', () => {
    ok(page.includes("from '@/utils/opinion-events'"), '舆情页应引用 utils/opinion-events')
    ok(page.includes('buildOpinionEvents('), '应调用事件聚合纯函数')
    notOk(/function\s+sameEvent/.test(page), '页面不得另写一套聚类判据')
  })

  it('事件卡改为整卡跳转事件时间线页（不再内联展开），并保留三块与今日要点', () => {
    ok(page.includes('事件时间线'), '缺事件卡标题')
    ok(page.includes('/pages/event/index'), '事件卡应跳转到事件时间线页')
    ok(page.includes('Taro.navigateTo'), '跳转用 navigateTo')
    ok(page.includes('eventKey=') && page.includes('encodeURIComponent'), '跳转要带上 encode 过的 eventKey')
    notOk(page.includes('展开时间线') || page.includes('toggleEvent('), '内联展开已移除，改为整卡跳转')
    ok(page.includes('buildOpinionQueue(') && page.includes('pickDailyFocus('), '三块与今日要点不得被替换掉')
    ok(scss.includes('&__event-actions') && scss.includes('&__event-go'), '缺事件卡操作行 / 跳转提示样式')
  })

  it('事件明细沿用 opinion-access 门禁（同一套门槛，不新写判断）', () => {
    ok(page.includes("from '@/utils/opinion-access'") && page.includes('sliceDetail('), '事件应走 sliceDetail')
    ok(page.includes('moreDetailNote('), '免费档复用现有升级提示行，不新造弹窗')
    ok(page.includes('/pages/member/index'), '提示行应能跳会员页')
  })

  it('保留「聚合 ≠ 认定」的克制说明，区分报道与官方通报', () => {
    ok(/不代表平台已核实/.test(page), '事件卡要有「聚合不等于认定」的轻量说明')
    ok(page.includes('官方通报') && page.includes('媒体报道'), '时间线要能看出来源性质（区分报道与官方通报）')
  })
})
