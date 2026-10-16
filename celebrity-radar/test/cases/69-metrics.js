'use strict'

/**
 * N-6：**指标行的唯一真源**（`utils/metrics.ts`）—— 对比页与监测工作台不许各写一套。
 *
 * 这一版要钉的不是「多了个工具模块」，而是四件「做错了也看不出错」的事：
 *
 *   1. **同一个数字在两页必须同名**。此前 `report.dynamics.length` 在对比页叫「报告内动态」、
 *      在工作台叫「近期动态」，`quotes.length` 一个叫「收录言论」、另一个叫「经典名言」。
 *      两套口径的结局是漂移成两个数字（改一处忘一处），而用户看到的是「同一份报告的两个说法」。
 *      ⇒ 判据不是「两处代码长得像」，而是**拿同一份报告分别跑两个模块，逐格比对标签与字**。
 *   2. **标签取自章节真源**（`utils/report-toc.ts#REPORT_TEMPLATE`）。指标就是「报告里那一段
 *      有几条」，报告页改了段名这里必须跟着改 —— 手抄第二遍就一定会分家。
 *   3. **占位词不能混**：对比页的「—」= 这份报告没这个数；工作台的「未生成」= 这个人还没报告。
 *      同一个占位会把两件事说成一件（工作台那一档的严重性见 63 用例）。
 *   4. **列不许错位**：工作台按 `personKey` 过滤脏输入后再建行，若还回头用 `items[i]` 取报告，
 *      中间少一个人就会把数字整体挂到别人名下 —— 而错位的表格看起来完全正常（数字都在）。
 *
 * 纯函数直接 require 编译产物；调用方是否「不再自己写行」读源码断言（与 61 / 62 / 63 同法）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 剥注释后再做源码断言（与 18-user-config / 45-report-card / 63-workbench 同法） */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** 干净加载四个模块：行定义 + 模板 + 两个调用方（它们必须共享同一份定义） */
function ALL() {
  env.resetAll()
  return {
    metrics: env.load('utils/metrics'),
    toc: env.load('utils/report-toc'),
    compare: env.load('utils/compare'),
    wb: env.load('utils/workbench')
  }
}

/* ─────────────────────────────── 夹具 ─────────────────────────────── */

const dyn = (title = '事件') => ({ title, date: '2026-10-01', sentiment: 'neutral' })
const quote = (text = '一句话') => ({ text, context: '现场' })
const node = (event = '节点') => ({ date: '2026-09-01', event })

/**
 * 最小可用报告：只放指标行真的会读的字段。
 * 刻意给足条数（动态 3 / 名言 2 / 时间线 1），好让「3 条」这种带单位的字有正向对照。
 */
function mkReport(over = {}) {
  return Object.assign(
    {
      personKey: '张三#tech',
      name: '张三',
      generatedAt: '2026-10-15T09:12:33.000Z',
      heat: 62,
      coverage: { items: 40, recent: 12, firstAt: '2026-09-01', latestAt: '2026-10-15' },
      dynamics: [dyn('甲'), dyn('乙'), dyn('丙')],
      quotes: [quote(), quote()],
      timeline: [node()],
      controversies: [{ topic: '话题', claim: 'a', response: 'b', basis: 'https://example.com/a' }],
      relations: [{ title: '合作方' }, { title: '同行' }],
      profile: [{ title: '履历' }]
    },
    over
  )
}

/** 两人对比里较小的那一位（用于跑通 buildComparison 的第二个入参） */
const other = () => mkReport({ personKey: '李四#ent', name: '李四', heat: 50 })

/* ═══════════════════ 1. 行定义本身：键、名字、单位、方向 ═══════════════════ */

describe('N-6 指标真源 · 行定义', () => {
  it('两页声明要显示的行，必须都在定义表里登记过（没登记 = 又回到两套口径）', () => {
    const { metrics } = ALL()
    const keys = metrics.METRIC_DEFS.map((d) => d.key)
    for (const k of metrics.COMPARE_METRIC_KEYS.concat(metrics.WORKBENCH_METRIC_KEYS)) {
      ok(keys.includes(k), `行定义里没有登记 ${k}`)
    }
    eq(metrics.metricsOf(metrics.COMPARE_METRIC_KEYS).length, metrics.COMPARE_METRIC_KEYS.length)
    eq(metrics.metricsOf(metrics.WORKBENCH_METRIC_KEYS).length, metrics.WORKBENCH_METRIC_KEYS.length)
  })

  it('key 与展示名都不许重复（两行同名 = 用户看不出区别，也没法指着说「第三行」）', () => {
    const { metrics } = ALL()
    const keys = metrics.METRIC_DEFS.map((d) => d.key)
    const labels = metrics.METRIC_DEFS.map((d) => d.label)
    eq(new Set(keys).size, keys.length, 'key 重复')
    eq(new Set(labels).size, labels.length, '展示名重复')
    for (const d of metrics.METRIC_DEFS) ok(!!d.label.trim(), `${d.key} 没有展示名`)
  })

  it('章节类指标的标签取自报告模板（手抄第二遍就一定会分家）', () => {
    const { metrics, toc } = ALL()
    const pair = {
      dynamics: 'sec-dynamics',
      quotes: 'sec-quotes',
      timeline: 'sec-timeline',
      controversies: 'sec-controversies',
      relations: 'sec-relations',
      profile: 'sec-profile'
    }
    for (const [key, id] of Object.entries(pair)) {
      const sec = toc.REPORT_TEMPLATE.find((s) => s.id === id)
      ok(!!sec, `报告模板里找不到 ${id}`)
      eq(metrics.metricDef(key).label, sec.label, `${key} 的名字必须与模板里的节名一致`)
    }
  })

  it('三个旧名字不许回来（用户看到的是报告里的段名）', () => {
    const { metrics } = ALL()
    const labels = metrics.METRIC_DEFS.map((d) => d.label).join('|')
    notOk(/报告内动态|收录言论|履历节点/.test(labels), '行定义里出现了旧名')
    /* 调用方也不许把它们抄回去（定义表里作为「为什么改名」的注释保留，故只查调用方） */
    notOk(/报告内动态|收录言论|履历节点/.test(read(path.join('utils', 'compare.ts'))))
  })

  it('⚠ 只有热度给方向：报道量按原样素材统计，与热度不同口径', () => {
    const { metrics } = ALL()
    deepEq(metrics.METRIC_DEFS.filter((d) => d.higher).map((d) => d.key), ['heat'])
  })

  it('单位只加在条数类指标上：3 是「3 条」，62 是「热度 62」', () => {
    const { metrics } = ALL()
    const rep = mkReport()
    eq(metrics.metricText(metrics.metricDef('dynamics'), rep, rep.personKey), '3 条')
    eq(metrics.metricText(metrics.metricDef('quotes'), rep, rep.personKey), '2 条')
    eq(metrics.metricText(metrics.metricDef('timeline'), rep, rep.personKey), '1 条')
    eq(metrics.metricText(metrics.metricDef('heat'), rep, rep.personKey), '62', '热度不是条数，不许带单位')
    eq(metrics.metricText(metrics.metricDef('news'), rep, rep.personKey), '40')
  })

  it('文本指标：领域来自 personKey（与缓存无关），非法键回落「未标注」', () => {
    const { metrics } = ALL()
    const def = metrics.metricDef('domain')
    eq(metrics.metricText(def, null, '张三#tech'), '科技', '领域不看报告，没生成也标得出')
    eq(metrics.metricText(def, null, '坏键'), '未标注')
    eq(metrics.metricValue(def, mkReport()), null, '文本指标没有数值（不参与「整行是否全空」的判定）')
  })

  it('取不到数时用调用方给的占位（两句话不是一件事）', () => {
    const { metrics } = ALL()
    const old = mkReport({ coverage: null }) // 老报告没有 coverage
    eq(metrics.metricText(metrics.metricDef('news'), old, old.personKey), '—', '默认占位是「这份报告没有这个数」')
    eq(metrics.metricText(metrics.metricDef('news'), old, old.personKey, '未生成'), '未生成')
  })

  it('非有限数当「给不出」，不当 0（0 是一个读数，NaN 不是）', () => {
    const { metrics } = ALL()
    const def = metrics.metricDef('heat')
    eq(metrics.metricValue(def, mkReport({ heat: 62 })), 62, '正向对照：正常热度照原样')
    eq(metrics.metricValue(def, mkReport({ heat: NaN })), null)
    eq(metrics.metricText(def, mkReport({ heat: NaN }), '张三#tech'), '—')
  })
})

/* ═══════════════════ 2. 跨页一致（N-6 的真判据） ═══════════════════ */

describe('N-6 跨页一致 · 同一指标同名同数字', () => {
  /** 对比页的一格 / 工作台的一格：同一个 key，两处都取出来比 */
  function bothPages() {
    const mod = ALL()
    const rep = mkReport()
    const cmp = mod.compare.buildComparison(rep, other())
    const table = mod.wb.buildCompareTable([{ personKey: rep.personKey, name: rep.name, report: rep }])
    const rowCmp = (key) => cmp.metrics.find((m) => m.key === key)
    const rowWb = (key) => table.metrics.find((m) => m.key === key)
    return {
      ...mod,
      rep,
      cellCmp: rowCmp,
      labelCmp: (key) => rowCmp(key).label,
      cellWb: (key) => rowWb(key).cells[0].text,
      labelWb: (key) => rowWb(key).label,
      cmp,
      table
    }
  }

  it('⚠ 同一份报告在对比页与工作台：同名、同数字（这就是 N-6 的全部意义）', () => {
    const { cellCmp, labelCmp, cellWb, labelWb, metrics } = bothPages()
    /* 两页的行集合**刻意不同**（对比页看曝光度与素材量，工作台看「有什么可写的」+ 生成状态），
       所以要比的是**交集** —— 而那正好就是曾经各写一套标签的那两个指标 */
    const shared = metrics.COMPARE_METRIC_KEYS.filter((k) => metrics.WORKBENCH_METRIC_KEYS.includes(k))
    deepEq(shared, ['heat', 'dynamics'], '交集变了就要重新确认：这两个指标在两页是不是还同名同数字')
    for (const key of shared) {
      eq(labelCmp(key), labelWb(key), `${key} 在两页的展示名不一致`)
      eq(cellCmp(key).a, cellWb(key), `${key} 在两页的数字不一致`)
    }
    eq(cellCmp('dynamics').a, '3 条')
    eq(cellWb('dynamics'), '3 条')
  })

  it('行集合由各自的清单决定：对比页 6 行、工作台 7 行（定义表新增一行不会漏到两页上）', () => {
    const { cmp, table, metrics } = bothPages()
    deepEq(cmp.metrics.map((m) => m.key), metrics.COMPARE_METRIC_KEYS)
    deepEq(table.metrics.map((m) => m.key), metrics.WORKBENCH_METRIC_KEYS)
    eq(cmp.metrics.length, 6)
    eq(table.metrics.length, 7)
  })

  it('「未生成」与「—」是两个词：谁都不许把对方的话借过来', () => {
    const mod = ALL()
    const t = mod.wb.buildCompareTable([{ personKey: '李四#ent', name: '李四', report: null }])
    const cell = (key) => t.metrics.find((m) => m.key === key).cells[0]
    eq(cell('heat').text, mod.wb.NOT_GENERATED)
    ok(!!cell('domain').text && cell('domain').text !== mod.wb.NOT_GENERATED, '「领域」与缓存无关，未生成的人也标得出')
    notOk(new RegExp(mod.wb.NOT_GENERATED).test(mod.compare.buildComparison(mkReport(), other()).metrics[0].a))
  })

  it('⚠ 脏输入被过滤后不许错位：剩下的那列必须还是它自己的数', () => {
    const mod = ALL()
    const t = mod.wb.buildCompareTable([
      { personKey: '', name: '脏输入', report: mkReport({ heat: 99 }) },
      { personKey: '李四#ent', name: '李四', report: mkReport({ personKey: '李四#ent', heat: 7 }) }
    ])
    eq(t.rows.length, 1, 'personKey 为空的那列不进表')
    eq(t.rows[0].name, '李四')
    eq(t.rows[0].heat, 7)
    eq(t.metrics.find((m) => m.key === 'heat').cells[0].text, '7', '数字挂到了别人名下 = 表格看起来完全正常')
  })
})

/* ═══════════════════ 3. 接线：两个调用方都不再自己写行 ═══════════════════ */

describe('N-6 接线 · 行定义只有一份', () => {
  const cmpSrc = () => stripComments(read(path.join('utils', 'compare.ts')))
  const wbSrc = () => stripComments(read(path.join('utils', 'workbench.ts')))
  const HAND_WRITTEN =
    /label: '(领域|热度|近 30 天报道|近 7 天报道|近期动态|经典名言|时间线|争议与回应|人物关系|人物档案|报告生成)'/

  it('两页都从定义表取行，而不是各写一份', () => {
    ok(/metricsOf\(COMPARE_METRIC_KEYS\)/.test(cmpSrc()), '对比页没有走定义表')
    ok(/metricsOf\(WORKBENCH_METRIC_KEYS\)/.test(wbSrc()), '工作台没有走定义表')
  })

  it('两个调用方都不许写死行标签与取值', () => {
    notOk(HAND_WRITTEN.test(cmpSrc()), '对比页里又出现了手写的行标签')
    notOk(HAND_WRITTEN.test(wbSrc()), '工作台里又出现了手写的行标签')
  })
})

/* ═══════════════════ 4. 节名的唯一真源（N-5） ═══════════════════ */

/**
 * N-5：把「关系图谱」改成「人物关系」—— 这张卡渲染的是三列表（名称 / 关系 / 说明），不是图。
 * 名字承诺了可视化却给不出，用户点进来只会失望；做真图的成本要算进主包体积（见 N-7），不值。
 *
 * 一次改名要碰到四处：模板 label（真源）、报告页卡片标题、导出标题、缺口提示。其中导出标题
 * （`## ${s.label}`）与指标行（metrics.ts 的 tocLabel）都取自真源，**只有报告页卡片标题是硬编码**
 * —— 所以这里专门钉住它与真源逐字一致，改名漏一处就会红。
 */
describe('N-5 节名 · 报告页卡片标题必须与模板真源同名', () => {
  it('sec-relations：标题逐字等于模板 label，且不再叫「图谱」', () => {
    const { toc } = ALL()
    const label = toc.REPORT_TEMPLATE.find((s) => s.id === 'sec-relations').label
    eq(label, '人物关系', '模板真源的名字变了（改名要连报告页标题一起改）')
    const page = stripComments(read(path.join('package', 'report', 'index.tsx')))
    const m = /id='sec-relations'[\s\S]{0,240}?card-title'>([^<]+)</.exec(page)
    ok(!!m, '报告页里找不到 sec-relations 卡片的标题')
    eq(m[1], label, '卡片标题与模板 label 不一致 = 目录叫 A、卡片叫 B')
    notOk(/图谱|图表/.test(label), '名字不许再承诺可视化：渲染的是表格，不是图')
  })
})
