'use strict'

/**
 * S3-2：**监测工作台**（`utils/workbench.ts` + `package/workbench`）。
 *
 * 这一版要钉的不是「多了一个页面」，而是七件容易做错、且做错了很久都看不出来的事：
 *
 *   1. **「还没扫」与「扫了没新东西」必须分得开**：`newHits` 用 `null` 表示「没有执行记录」，
 *      0 表示「执行了、这一轮没命中」。把两者混成 0，等于告诉用户「监控在正常工作」——
 *      而它其实一轮都没跑过（这是静默失效里最贵的一种）。
 *   2. **排序是「最近动静」**：工作台存在的意义就是横向扫一眼谁在动，
 *      没有信号的人不该排在有信号的人上面（那是名单顺序，不是工作台）。
 *   3. **未生成的人照样进对比表**：标「未生成」并给生成入口。
 *      从表里删掉会被读成「这个人没问题」—— 那是替用户下了判断。
 *   4. **对比只搬运、不折算**：所有数字必须**逐个等于**报告里对应字段的值/长度，
 *      不许出现跨人的综合分（一旦有分，平台就替用户排了序）。
 *   5. **简报的红线：没出处的条目一律不进文件**（`url` 为空即丢弃）。文件一旦离开 App
 *      就失去「点开看原文」的兜底，带出去的东西必须每条都能核对（与报告长图同一条红线）。
 *   6. **事件刻意不写进简报**：端上事件模型只有来源**名**、没有来源**链接**，
 *      写进去就成了一条指不出出处的条目（违反 5）。宁可少给一段。
 *   7. **站内看与带走的二元口径**：面板 / 对比 / 事件跟踪对免费与会员一视同仁；
 *      只有「导出简报」是会员能力，而门禁**复用** `report-export#canExportReport`，
 *      免费被拦只多一行非弹窗说明（弹窗会把「看一眼入口」变成一次打断）。
 *
 * 另有两条不变式：本页**不推进**「风险信号已看」水位（清角标是预警页的职责），
 * 以及本页**只读**（绝不出现报告生成 / 上游检索的调用）。
 *
 * 纯函数直接 require 编译产物；页面与配置文件读源码断言（与 61 / 62 同法）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 干净加载 utils/workbench（它 import config/domains 与 utils/inbox，故必须先 resetAll） */
function WB() {
  env.resetAll()
  return env.load('utils/workbench')
}

const page = () => read(path.join('package', 'workbench', 'index.tsx'))
const wbSrc = () => read(path.join('utils', 'workbench.ts'))

/**
 * 剥注释后再做源码断言（与 18-user-config / 45-report-card 同法）。
 * 本用例必须用它：页面里有一句「本页不推进水位（预警页调 markModuleSeen）」的**解释性注释**，
 * 不剥注释的话「不许出现 markModuleSeen」会被自己写的理由判成违规。
 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
const pageCode = () => stripComments(page())

/* ─────────────────────────── 素材 ─────────────────────────── */

/** ⚠ 必须补零：`2026-10-9` 会被 Date.parse 判成 NaN，且字符串比较下比 `2026-10-16` 还大 */
const T = (h) => `2026-10-${String(h).padStart(2, '0')}T00:00:00.000Z`

function sig(personKey, at, over = {}) {
  const name = personKey.split('#')[0]
  return {
    id: `${personKey}#${at}`,
    person_key: personKey,
    name,
    level: 'mid',
    category: 'contract',
    category_label: '合作',
    keyword: '合作',
    title: `${name} 的示例条目`,
    quote: '',
    source: '示例媒体',
    url: `https://example.com/${name}/${at}`,
    published_date: null,
    first_seen_at: at,
    ...over
  }
}

function scan(personKey, at, total) {
  return {
    id: personKey,
    person_key: personKey,
    name: personKey.split('#')[0],
    scanned_at: at,
    baseline_at: at,
    seen_urls: [],
    scanned: 1,
    signals_total: total
  }
}

function log(personKey, at, status, hit) {
  return {
    id: `${personKey}#${at}`,
    kind: 'person',
    object_key: personKey,
    object_name: personKey.split('#')[0],
    ran_at: at,
    status,
    hit,
    total: hit
  }
}

function report(name, over = {}) {
  return {
    personKey: `${name}#ent`,
    name,
    heat: 10,
    profile: [{ title: 'p' }],
    relations: [{ title: 'r1' }, { title: 'r2' }],
    dynamics: [{ title: 'd1' }, { title: 'd2' }, { title: 'd3' }],
    controversies: [{ title: 'c1' }],
    generatedAt: T(16),
    ...over
  }
}

/* ═══════════════════ 1. 多人面板：排序与「有没有跑过」 ═══════════════════ */

describe('S3-2 监测工作台 · 多人面板', () => {
  const persons = [
    { personKey: 'A#ent', name: 'A' },
    { personKey: 'B#ent', name: 'B' },
    { personKey: 'C#ent', name: 'C' },
    { personKey: 'D#ent', name: 'D' }
  ]

  it('按「最近动静」排序：有信号的在前（按最新一条倒序），其余按最近执行，最后按名字', () => {
    const wb = WB()
    const rows = wb.buildWorkbenchRows({
      persons,
      signals: [sig('B#ent', T(15)), sig('C#ent', T(14)), sig('C#ent', T(16)), sig('A#ent', T(9))],
      /* A 有信号但不能排在 B/C 之上：它最新一条是 10-09，最旧 */
      scans: [scan('D#ent', T(13), 0)],
      logs: []
    })
    deepEq(
      rows.map((r) => r.name),
      ['C', 'B', 'A', 'D']
    )
  })

  it('没有执行记录时 newHits 是 null，不是 0（「还没扫」与「扫了没新东西」必须分得开）', () => {
    const wb = WB()
    const rows = wb.buildWorkbenchRows({
      persons: [{ personKey: 'A#ent', name: 'A' }],
      signals: [sig('A#ent', T(15))],
      scans: [],
      logs: []
    })
    eq(rows[0].newHits, null)
    notOk(rows[0].newHits === 0, '没有日志却说「新 0 条」= 让用户以为监控在正常工作')

    const withLog = wb.buildWorkbenchRows({
      persons: [{ personKey: 'A#ent', name: 'A' }],
      signals: [sig('A#ent', T(15))],
      logs: [log('A#ent', T(16), 'ok', 0)]
    })
    eq(withLog[0].newHits, 0, '有日志且命中 0 → 这才是真的 0')
  })

  it('状态一行字：日志优先，其次「已扫描」（快照或信号都算扫过的证据），都没有才是「待首次扫描」', () => {
    const wb = WB()
    const rows = wb.buildWorkbenchRows({
      persons: [
        { personKey: 'A#ent', name: 'A' },
        { personKey: 'B#ent', name: 'B' },
        { personKey: 'C#ent', name: 'C' },
        { personKey: 'D#ent', name: 'D' }
      ],
      signals: [sig('C#ent', T(15))],
      scans: [scan('B#ent', T(14), 2)],
      logs: [log('A#ent', T(16), 'error', 0)]
    })
    const by = Object.fromEntries(rows.map((r) => [r.name, r]))
    eq(by.A.statusText, '失败')
    eq(by.B.statusText, '已扫描')
    /* C 有信号、但没有日志与快照：信号本身就是扫过的证据，不能说成「待首次扫描」 */
    eq(by.C.statusText, '已扫描')
    eq(by.D.statusText, '待首次扫描')
  })

  it('累计信号数取快照的 signals_total（它比本次读到的条数更权威），缺失才回落到条数', () => {
    const wb = WB()
    const rows = wb.buildWorkbenchRows({
      persons: [
        { personKey: 'A#ent', name: 'A' },
        { personKey: 'B#ent', name: 'B' }
      ],
      signals: [sig('A#ent', T(15)), sig('A#ent', T(14)), sig('B#ent', T(15))],
      scans: [scan('A#ent', T(16), 9)]
    })
    const by = Object.fromEntries(rows.map((r) => [r.name, r]))
    eq(by.A.signalTotal, 9, '快照说累计 9 条（本次只读到 2 条，不代表只有 2 条）')
    eq(by.B.signalTotal, 1, '没有快照时按读到的条数保守报')
  })

  it('新信号数按本机水位算（口径 = utils/inbox#isNewSince）：水线之前的旧信号不算新', () => {
    const wb = WB()
    const seen = Date.parse(T(15)) // 看过 10-15 之前
    const rows = wb.buildWorkbenchRows({
      persons: [{ personKey: 'A#ent', name: 'A' }],
      signals: [sig('A#ent', T(14)), sig('A#ent', T(15)), sig('A#ent', T(16))],
      seenMs: seen
    })
    eq(rows[0].newSignals, 1, '只有 10-16 那条比水位新')

    const none = wb.buildWorkbenchRows({
      persons: [{ personKey: 'A#ent', name: 'A' }],
      signals: [sig('A#ent', T(14))],
      seenMs: seen
    })
    eq(none[0].newSignals, 0)
  })

  it('第二行给「最新一条是什么」：取最新信号的标题（不是第一条）', () => {
    const wb = WB()
    const rows = wb.buildWorkbenchRows({
      persons: [{ personKey: 'A#ent', name: 'A' }],
      signals: [sig('A#ent', T(14), { title: '旧条目' }), sig('A#ent', T(16), { title: '新条目' })]
    })
    eq(rows[0].latestTitle, '新条目')
    eq(rows[0].latestSignalAt, T(16))
  })

  it('名字以监控行为准（快照与信号上的 name 只作兜底）', () => {
    const wb = WB()
    const rows = wb.buildWorkbenchRows({
      persons: [{ personKey: 'A#ent', name: '用户自己写的词' }],
      signals: [sig('A#ent', T(15), { name: '信号里的名字' })],
      scans: [scan('A#ent', T(16), 1)]
    })
    eq(rows[0].name, '用户自己写的词')
  })

  it('不改入参：persons 数组顺序与内容一字不动；脏输入不炸', () => {
    const wb = WB()
    const input = [
      { personKey: 'B#ent', name: 'B' },
      { personKey: 'A#ent', name: 'A' }
    ]
    const copy = input.map((p) => ({ ...p }))
    wb.buildWorkbenchRows({ persons: input, signals: [sig('A#ent', T(15))] })
    deepEq(input, copy, 'buildWorkbenchRows 是纯函数，不许 sort 调用方的数组')

    deepEq(wb.buildWorkbenchRows({ persons: null }).length, 0)
    deepEq(wb.buildWorkbenchRows({ persons: [null, { personKey: '' }] }).length, 0)
    eq(wb.buildWorkbenchRows({ persons: [{ personKey: 'A#ent', name: 'A' }], signals: null }).length, 1)
  })
})

/* ═══════════════════ 2. 勾选：上限与「不许静默丢弃」 ═══════════════════ */

describe('S3-2 监测工作台 · 勾选上限', () => {
  it('加上 / 去掉；满员时返回 rejected 且列表原样（不静默丢弃、不顶掉最早选的那个）', () => {
    const wb = WB()
    const max = wb.COMPARE_PICK_MAX

    let pick = []
    for (let i = 0; i < max; i++) {
      const res = wb.togglePick(pick, `P${i}#ent`)
      eq(res.rejected, false)
      pick = res.picked
    }
    eq(pick.length, max)

    const full = wb.togglePick(pick, 'X#ent')
    eq(full.rejected, true)
    deepEq(full.picked, pick, '满员时不许把列表改掉（自动顶掉最早选的会让人以为自己选错了人）')

    const off = wb.togglePick(pick, 'P1#ent')
    eq(off.rejected, false)
    deepEq(off.picked, ['P0#ent', 'P2#ent', 'P3#ent'].slice(0, max))
  })

  it('上限是参数（页面才不许写死），2 与 6 都能守', () => {
    const wb = WB()
    deepEq(wb.togglePick(['a', 'b'], 'c', 2).picked, ['a', 'b'])
    eq(wb.togglePick(['a', 'b'], 'c', 2).rejected, true)
    deepEq(wb.togglePick(['a', 'b'], 'c', 6).picked, ['a', 'b', 'c'])
  })

  it('上限本身是版面约束（2~4 列），不是会员数值：设得比 2 还小就没法对比了', () => {
    const wb = WB()
    ok(wb.COMPARE_PICK_MAX >= 2, '至少两列才有「对比」')
    ok(wb.COMPARE_PICK_MAX <= 4, '一屏放不下超过 4 列（再多会横着看不完）')
  })
})

/* ═══════════════════ 3. 横向对比：只搬运、不折算 ═══════════════════ */

describe('S3-2 监测工作台 · 横向对比', () => {
  it('列 = 人、行 = 指标，指标顺序固定（改顺序 = 让用户重新找一遍）', () => {
    const wb = WB()
    const t = wb.buildCompareTable([{ personKey: '张三#ent', report: report('张三') }])
    deepEq(
      t.metrics.map((m) => m.key),
      ['domain', 'heat', 'dynamics', 'controversies', 'relations', 'profile', 'generated']
    )
    deepEq(
      t.metrics.map((m) => m.label),
      ['领域', '热度', '近期动态', '争议与回应', '人物关系', '人物档案', '报告生成']
    )
    eq(t.rows.length, 1)
  })

  it('数字逐个等于报告里的值/长度（不做任何跨人折算）', () => {
    const wb = WB()
    const r = report('张三')
    const t = wb.buildCompareTable([{ personKey: '张三#ent', name: '张三', report: r }])
    const row = t.rows[0]
    eq(row.heat, r.heat)
    eq(row.dynamics, r.dynamics.length)
    eq(row.controversies, r.controversies.length)
    eq(row.relations, r.relations.length)
    eq(row.profileItems, r.profile.length)
    eq(row.generatedAt, r.generatedAt)

    const cell = (key) => t.metrics.find((m) => m.key === key).cells[0].text
    eq(cell('heat'), String(r.heat))
    eq(cell('dynamics'), '3 条')
    eq(cell('controversies'), '1 条')
  })

  it('未生成的人照样进表：除「领域」外都是「未生成」，不是 0', () => {
    const wb = WB()
    const t = wb.buildCompareTable([
      { personKey: '张三#ent', name: '张三', report: report('张三') },
      { personKey: '李四#ent', name: '李四', report: null }
    ])
    eq(t.rows.length, 2, '没生成的人不许从列里消失（删掉会被读成「这个人没问题」）')
    eq(t.rows[1].cached, false)
    const miss = t.metrics.find((m) => m.key === 'heat').cells[1]
    eq(miss.text, wb.NOT_GENERATED)
    eq(miss.num, 0, '数值记 0 是为了「整行是否全空」的判定，不是「他的热度是 0」')
    notOk(/0/.test(miss.text) && !/未/.test(miss.text), '未生成的格子不能显示成数字 0')
  })

  it('「领域」与缓存无关：从 personKey 解析，所以没生成的人也标得出来', () => {
    const wb = WB()
    const t = wb.buildCompareTable([{ personKey: '李四#ent', name: '李四', report: null }])
    const cell = t.metrics.find((m) => m.key === 'domain').cells[0]
    eq(t.rows[0].cached, false)
    ok(!!cell.text && cell.text !== wb.NOT_GENERATED, '领域来自 personKey，不该受「没生成报告」影响')
  })

  it('整行全 0 的指标标 blank（不值得占版面）；「领域」「报告生成」永远不 blank', () => {
    const wb = WB()
    const bare = {
      personKey: '张三#ent',
      name: '张三',
      heat: 5,
      profile: [],
      relations: [],
      dynamics: [],
      controversies: [],
      generatedAt: T(16)
    }
    const t = wb.buildCompareTable([{ personKey: '张三#ent', report: bare }])
    const m = (key) => t.metrics.find((x) => x.key === key)
    eq(m('controversies').blank, true, '全 0 的行不该占版面')
    eq(m('domain').blank, false, '领域一定有内容')
    eq(m('generated').blank, false, '报告生成时间一定有内容')
    eq(m('heat').blank, false)
  })

  it('空输入 / 脏输入不炸', () => {
    const wb = WB()
    deepEq(wb.buildCompareTable(null).rows, [])
    deepEq(wb.buildCompareTable([null, {}]).rows, [])
    eq(wb.buildCompareTable([]).metrics.length, 7)
  })
})

/* ═══════════════════ 4. 导出简报：没出处的不进文件 ═══════════════════ */

describe('S3-2 监测工作台 · 导出简报', () => {
  const rowOf = (name, over = {}) => ({
    personKey: `${name}#ent`,
    name,
    lastRanAt: T(16),
    statusText: '成功',
    newHits: 1,
    signalTotal: 3,
    latestSignalAt: T(16),
    latestTitle: `${name} 的最新条目`,
    newSignals: 1,
    ...over
  })

  it('没有监控对象时不生成（页面据此不去复制一个空文件）', () => {
    const wb = WB()
    eq(wb.buildWorkbenchBrief({ rows: [] }), null)
    eq(wb.buildWorkbenchBrief({ rows: null }), null)
  })

  it('红线：没出处的信号一律不进文件（url 为空即丢弃，且不计入条数）', () => {
    const wb = WB()
    const brief = wb.buildWorkbenchBrief({
      rows: [rowOf('张三')],
      signalsByPerson: {
        '张三#ent': [
          sig('张三#ent', T(16), { url: 'https://example.com/a', title: '有出处' }),
          sig('张三#ent', T(15), { url: '', title: '没出处' }),
          sig('张三#ent', T(14), { url: '   ', title: '空白出处' })
        ]
      }
    })
    ok(/有出处/.test(brief.markdown))
    notOk(/没出处/.test(brief.markdown), '带出去的文件必须每条都能核对（点不开的条目等于编的）')
    notOk(/空白出处/.test(brief.markdown))
    eq(brief.signalCount, 1, 'signalCount 只数真的写进文件的那几条')
  })

  it('每人最多 BRIEF_SIGNAL_MAX 条，且取最近的那几条', () => {
    const wb = WB()
    const n = wb.BRIEF_SIGNAL_MAX
    const list = []
    for (let i = 0; i < n + 3; i++) list.push(sig('张三#ent', T(1 + i), { title: `条目${i}` }))
    const brief = wb.buildWorkbenchBrief({ rows: [rowOf('张三')], signalsByPerson: { '张三#ent': list } })
    eq(brief.signalCount, n)
    ok(new RegExp(`条目${n + 2}`).test(brief.markdown), '取最新的：最后一条时间最大')
    notOk(/条目0/.test(brief.markdown), '最旧的那几条被裁掉（简报要一眼读完）')
  })

  it('头部：生成时间 + 监控人数 + 关键词 + 免责句（与站内免责同源）', () => {
    const wb = WB()
    const brief = wb.buildWorkbenchBrief({
      rows: [rowOf('张三'), rowOf('李四')],
      keywords: ['新剧', '代言'],
      at: new Date('2026-10-16T06:05:00.000Z')
    })
    ok(/^# 名人雷达 · 监控简报/.test(brief.markdown))
    ok(/2026-10-16/.test(brief.markdown))
    ok(/监控对象：2 人/.test(brief.markdown))
    ok(/监控关键词：新剧、代言/.test(brief.markdown))
    ok(/基于公开信息 AI 整理，仅供参考/.test(brief.markdown))
    eq(brief.fileNameBase, '名人雷达-监控简报-20261016')
    eq(brief.personCount, 2)
  })

  it('事件刻意不写进简报（端上事件模型只有来源名、没有链接，写进去就是没出处）', () => {
    const wb = WB()
    const brief = wb.buildWorkbenchBrief({ rows: [rowOf('张三')], at: new Date('2026-10-16T00:00:00.000Z') })
    notOk(/## 事件/.test(brief.markdown))
    ok(/## 风险信号/.test(brief.markdown), '没有可带出处的信号也要写明「本轮没有」，而不是整段消失')
  })

  it('表格单元格转义：标题里的竖线与换行不许切坏 Markdown 表格', () => {
    const wb = WB()
    const brief = wb.buildWorkbenchBrief({
      rows: [rowOf('张三|李四', { latestTitle: 'a|b\nc' })],
      at: new Date('2026-10-16T00:00:00.000Z')
    })
    const tableLine = brief.markdown.split('\n').find((l) => l.startsWith('| 张三'))
    ok(!!tableLine)
    eq(tableLine.split('|').length - 1, 6, '一行数据行仍是 5 列 = 6 个竖线（多出来的竖线都被替换掉了）')
    ok(!/张三\|李四/.test(brief.markdown), '标题里的竖线不许原样出现')
    notOk(/\n\s*c/.test(brief.markdown), '换行被压平，行数不被内容切坏')
  })
})

/* ═══════════════════ 5. 页面接入：口径不许走样 ═══════════════════ */

describe('S3-2 监测工作台 · 页面接入', () => {
  it('四个动作都走纯函数（页面不自己拼数据）', () => {
    const src = pageCode()
    ok(/from '@\/utils\/workbench'/.test(src))
    ok(/buildWorkbenchRows\(/.test(src))
    ok(/buildCompareTable\(/.test(src))
    ok(/buildWorkbenchBrief\(/.test(src))
    ok(/togglePick\(/.test(src))
  })

  it('上限与预览条数都取自模块常量（页面不许写死数字）', () => {
    const src = pageCode()
    ok(/\$\{COMPARE_PICK_MAX\}/.test(src))
    ok(/picked\.length < 2/.test(src), '不足 2 人时要说清为什么不能对比')
    ok(/\$\{WORKBENCH_EVENT_MAX\}|slice\(0, WORKBENCH_EVENT_MAX\)/.test(src))
    ok(/\$\{BRIEF_SIGNAL_MAX\}/.test(src))
    notOk(/最多同时对比 4 位/.test(src), '数字必须来自常量，不许在文案里写死')
  })

  it('导出复用 report-export 的门禁；免费被拦只多一行非弹窗说明', () => {
    const src = pageCode()
    ok(/canExportReport\(isMember\)/.test(src), '导出门禁只认 canExportReport 一个出口判定')
    ok(/setExportNote\(true\)/.test(src))
    ok(/workbenchExportNote\(\)/.test(src))
    const fn = src.slice(src.indexOf('const onExport'), src.indexOf('const goReport'))
    const blocked = fn.slice(0, fn.indexOf('setExportNote(true)'))
    notOk(/showModal/.test(blocked), '被拦时弹窗会把「看一眼入口」变成一次打断')
  })

  it('对比表随勾选变化作废（否则会看着一张与勾选不符的表）', () => {
    const src = pageCode()
    const fn = src.slice(src.indexOf('const onToggle'), src.indexOf('const onCompare'))
    ok(/setTable\(null\)/.test(fn))
  })

  it('本页不推进「风险信号已看」水位：只读水位、清角标是预警页的事', () => {
    const src = pageCode()
    ok(/readInboxSeen\(\)/.test(src))
    notOk(/markModuleSeen/.test(src), '工作台是台账，进来扫一眼不该把角标清掉')
  })

  it('只读：绝不触发报告生成或上游检索（本页零成本）', () => {
    const src = pageCode()
    ok(/getCachedReports\(/.test(src), '对比读的是共享缓存里已生成的报告')
    notOk(/callCloudFunction/.test(src))
    notOk(/generateReport|requestChannel|createReport/.test(src))
  })

  it('分包页硬约束：scss 自带 variables 导入、页面配置有标题、页面注册进 app.config', () => {
    ok(/@import '\.\.\/\.\.\/styles\/variables\.scss';/.test(read(path.join('package', 'workbench', 'index.scss'))))
    ok(/navigationBarTitleText: '监控台账'/.test(read(path.join('package', 'workbench', 'index.config.ts'))))
    ok(/workbench\/index/.test(read('app.config.ts')))
  })

  it('入口：预警页（名单之后）与舆情页都要能进', () => {
    ok(/package\/workbench\/index/.test(read(path.join('package', 'alerts', 'index.tsx'))))
    /*
     * 2026-10-17 从「我的」迁到舆情页：工作台回答的是「我盯的几个人里谁在动」（横向），
     * 与舆情页「我盯的东西怎么样了」同一件事；放在「我的」里被归进了账号设置。
     * ⚠ 「我的」页那条入口**必须删掉**：同一个功能两处入口，退回来时用户不知道该回哪。
     */
    ok(/package\/workbench\/index/.test(read(path.join('pages', 'opinion', 'index.tsx'))))
    notOk(
      /package\/workbench\/index/.test(read(path.join('pages', 'mine', 'index.tsx'))),
      '「我的」页的工作台入口已迁移，不许回流（两处入口会让人不知道该从哪进）'
    )
  })

  it('舆情页入口以卡片形态挂在页首导航区（与另外三个入口同一套结构）', () => {
    const opinion = read(path.join('pages', 'opinion', 'index.tsx'))
    ok(
      opinion.includes("className='page-opinion__nav-item' onClick={goWorkbench}"),
      '必须是页首 nav 的第四格（25/36/39/59 用例钉住这套形态：纯入口、在推荐卡之前）'
    )
    ok(/const goWorkbench = \(\) => void Taro\.navigateTo/.test(opinion), '纯跳转，不预读人数')
  })
})

/* ═══════════════════ 6. 埋点与不变式 ═══════════════════ */

describe('S3-2 监测工作台 · 埋点与不变式', () => {
  it('两条埋点在事件枚举里：对比与导出分开记（一个是「一次看多人」，一个是「带走台账」）', () => {
    const ev = read(path.join('utils', 'events.ts'))
    ok(/'workbench_compare'/.test(ev))
    ok(/'workbench_export'/.test(ev))
    const src = pageCode()
    ok(/track\('workbench_compare'/.test(src))
    ok(/track\('workbench_export', \{ allowed: false \}\)/.test(src), '被拦也要报：只报放行的话，转化分母会消失')
    ok(/track\('workbench_export', \{ allowed: true/.test(src))
  })

  it('简报只吃信号与面板数字：不读报告字段（Report 必须只是类型导入）', () => {
    const src = stripComments(wbSrc())
    ok(/import type \{ Report \}/.test(src))
    notOk(/^import \{ Report \}/m.test(src), '运行时导入 Report 会让简报能把会员段内容带出去')
    const brief = src.slice(src.indexOf('export function buildWorkbenchBrief'), src.indexOf('function mdCell'))
    notOk(/report\./.test(brief), '简报的输入只有面板行与信号，不许顺手去读报告')
  })

  it('对比的读口是共享缓存（getCachedReports），不新造一条数据链', () => {
    const src = pageCode()
    ok(/import \{[^}]*getCachedReports[^}]*\} from '@\/utils\/cache'/.test(src), '只认缓存的批量读口')
    notOk(/getCachedReport\(/.test(src), '一次只读一个人的那个读口在对比里没用（会变成 N 次往返）')
  })
})
