'use strict'

/**
 * N-9：**报告版本「改了什么」的对比**（`utils/report-diff.ts` + `package/report-history` 的差异视图
 * + 读口 `utils/report-versions.ts#loadVersionPair`）。
 *
 * 这一版要钉的不是「多了一块 UI」，而是这件对比最容易做错、且做错了看不出来的几件事：
 *
 *   1. **方向**：`prev` 是旧的那一版。方向读反时整块对比都在说反话，而它看起来**完全正常**
 *      （条数、条目都在，只是新旧互换）—— 故连「时间戳传反了」也要自己摆正。
 *   2. **只比能稳定判同的东西**：条数（数组长度）任何字段都比；条目清单只对**键取自素材原样
 *      字段**的节开。键来自模型措辞的节（争议议题、会员段争点、立场话题）逐字比会**稳定误报
 *      「全变了」** —— 同一个意思换个说法就是一条新增 + 一条消失。故反向钉住：措辞全换、
 *      条数不变 ⇒ **不许**报出任何条目差异。
 *   3. **叙述段要真的对照**：这一条**故意**与 `package/report` 的 computeDiff 相反
 *      （那边不看措辞），因为本视图存在的理由就是「口径变了吗」。且 `changed` 必须用**完整正文**
 *      比、只有展示才截断 —— 截断后再比会把「前 46 字一样、后面改了」读成「没变」。
 *   4. **null 与 0 分开**：`null` = 这一版没有这一段，`0` = 有这一段、里面是空的。
 *      混成一个数会把「当时还没向模型要这一段」说成「这一版是空的」。
 *   5. **比错人宁可不出**：`getCachedReport` 在 key 查不到时会按姓名回退到另一行，
 *      一份指向**另一个人**的差异比没有差异糟得多 —— 故 personKey 不一致时返回 `null`。
 *   6. **不许静默截断**：每节最多列 `DIFF_ITEM_MAX` 条，但**总数如实报出**（同 S3-3）。
 *   7. **不做评价**：只说增减与并列，绝不说哪一版更好（同工作台对比表）；
 *      且「会员段一侧为空」必须附前提，免得被读成「这次改动删掉了会员段」。
 *   8. **模板完整性**：节的 id/label/tier 全取自 `REPORT_TEMPLATE`，`SECTION_SPEC` 必须与它
 *      一一对应 —— 模板加了一节而对比没接上时，新节会在差异视图里**凭空消失**。
 *
 * 纯函数直接 require 编译产物；页面 / 埋点 读源码断言（与 61 / 62 / 63 / 64 同法）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 注释里会写反面用法（「哪一版更好」正是要被禁掉的说法），不剥会把解释当成真实代码 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const diffSrc = read(path.join('utils', 'report-diff.ts'))
const versionsSrc = read(path.join('utils', 'report-versions.ts'))
const eventsSrc = read(path.join('utils', 'events.ts'))
const pageSrc = read(path.join('package', 'report-history', 'index.tsx'))
const scssSrc = read(path.join('package', 'report-history', 'index.scss'))
const pageCode = () => stripComments(pageSrc)

/** 干净加载 utils/report-diff（它 import report-toc / report-export / text，故必须先 resetAll） */
function DIFF() {
  env.resetAll()
  return env.load('utils/report-diff')
}
/** 干净加载 utils/report-toc（真源：模板 id 与 label） */
function TOC() {
  env.resetAll()
  return env.load('utils/report-toc')
}
/** 干净加载 utils/report-versions（它 import cache / member） */
function RV() {
  env.resetAll()
  return env.load('utils/report-versions')
}

/* ─────────────────────────── 素材 ─────────────────────────── */

/** ⚠ 必须补零：`2026-10-9` 会被 Date.parse 判成 NaN，字符串比较下也比 `2026-10-16` 还大 */
const T = (h) => `2026-10-${String(h).padStart(2, '0')}T00:00:00.000Z`
const KEY = 'A#tech'
const OLD_AT = T(1)
const NEW_AT = T(8)

/** 一份最简报告；`over` 里给 `undefined` = 刻意让这个键**不存在**（会员段为空的两种情形之一） */
const rep = (at, over) =>
  Object.assign(
    {
      personKey: KEY,
      name: 'A',
      mode: 'realtime',
      generatedAt: at,
      heat: 62,
      intro: '简介正文',
      dynamics: [],
      quotes: [],
      analysis: '点评正文',
      timeline: [],
      sources: [],
      disclaimer: '基于公开信息 AI 整理，仅供参考'
    },
    over
  )

const dyn = (title, url, over) =>
  Object.assign({ date: '', title, summary: '', source: '某媒体', url, sentiment: 'neutral' }, over)

const dynList = (n, over) =>
  Array.from({ length: n }, (_, i) => dyn(`动态 ${i + 1}`, `https://n.example/${i + 1}`, over))

const rowOf = (name, url) => ({ title: name, url })

/* ═══════════════════════════ ① 方向 ═══════════════════════════ */

describe('N-9 方向：prev 是旧的那一版（utils/report-diff）', () => {
  it('时间戳传反了也自己摆正：prevAt 一定不晚于 nextAt', () => {
    const D = DIFF()
    const older = rep(OLD_AT, { dynamics: dynList(1) })
    const newer = rep(NEW_AT, { dynamics: dynList(3) })
    const a = D.buildReportDiff(older, newer)
    const b = D.buildReportDiff(newer, older)
    eq(a.prevAt, OLD_AT)
    eq(a.nextAt, NEW_AT)
    deepEq([b.prevAt, b.nextAt], [OLD_AT, NEW_AT], '摆正之后两边的方向必须一致')
    deepEq(
      a.changedSections.map((s) => [s.id, s.prevCount, s.nextCount]),
      b.changedSections.map((s) => [s.id, s.prevCount, s.nextCount]),
      '方向读反时条数会新旧互换 —— 而它看起来完全正常，故这条必须钉住'
    )
  })

  it('两版不是同一个人 ⇒ 算不出来（不出一份指向别人的对比）', () => {
    const D = DIFF()
    eq(D.buildReportDiff(rep(OLD_AT), rep(NEW_AT, { personKey: 'B#tech' })), null)
  })

  it('缺任一版 ⇒ 算不出来（不拿半份数据拼一个「看起来像对比」的东西）', () => {
    const D = DIFF()
    eq(D.buildReportDiff(null, rep(NEW_AT)), null)
    eq(D.buildReportDiff(rep(OLD_AT), undefined), null)
  })
})

/* ═══════════════════════════ ② 条数与条目 ═══════════════════════════ */

describe('N-9 条数：任何一节都比，且与措辞无关', () => {
  it('12 → 15 条：delta 是 3，且这一节被判为「有变化」', () => {
    const D = DIFF()
    const d = D.buildReportDiff(rep(OLD_AT, { dynamics: dynList(12) }), rep(NEW_AT, { dynamics: dynList(15) }))
    const row = d.sections.find((s) => s.id === 'sec-dynamics')
    eq(row.prevCount, 12)
    eq(row.nextCount, 15)
    eq(row.delta, 3)
    eq(row.changed, true)
  })

  it('对不上的节标「没有变化」，且不混进 changedSections', () => {
    const D = DIFF()
    const d = D.buildReportDiff(rep(OLD_AT, { dynamics: dynList(3), quotes: [] }), rep(NEW_AT, { dynamics: dynList(3), quotes: [] }))
    const row = d.sections.find((s) => s.id === 'sec-dynamics')
    eq(row.changed, false)
    eq(row.delta, 0)
    notOk(d.changedSections.some((s) => s.id === 'sec-dynamics'), '没变的节不许进 changedSections')
  })

  it('具名条目：url 判同 ⇒ 新增 / 消失各一条，且文案正确', () => {
    const D = DIFF()
    const d = D.buildReportDiff(
      rep(OLD_AT, { dynamics: [dyn('旧闻 A', 'https://n.example/a'), dyn('旧闻 B', 'https://n.example/b')] }),
      rep(NEW_AT, { dynamics: [dyn('旧闻 B', 'https://n.example/b'), dyn('新闻 C', 'https://n.example/c')] })
    )
    const row = d.changedSections.find((s) => s.id === 'sec-dynamics')
    eq(row.added.total, 1, 'url 是素材原样字段：新增一条就是一条')
    eq(row.removed.total, 1)
    eq(row.added.items[0].text, '新闻 C')
    eq(row.removed.items[0].text, '旧闻 A')
    eq(d.addedTotal, 1)
    eq(d.removedTotal, 1)
  })

  it('没有 url 时退回标题判同，且大小写 / 空格差异不算「另一条」', () => {
    const D = DIFF()
    const d = D.buildReportDiff(
      rep(OLD_AT, { dynamics: [dyn('同一件事', '')] }),
      rep(NEW_AT, { dynamics: [dyn(' 同一件事 ', '')] })
    )
    const row = d.changedSections.find((s) => s.id === 'sec-dynamics')
    notOk(row, '归一后是同一个键：不许报出一条新增 + 一条消失')
  })

  it('条目数收敛在 DIFF_ITEM_MAX，但总数如实报出（不许静默截断）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(rep(OLD_AT, { dynamics: dynList(1) }), rep(NEW_AT, { dynamics: dynList(9) }))
    const row = d.changedSections.find((s) => s.id === 'sec-dynamics')
    eq(row.added.items.length, D.DIFF_ITEM_MAX)
    eq(row.added.total, 8)
    eq(row.added.hidden, 8 - D.DIFF_ITEM_MAX)
    ok(/还有 4 条/.test(D.diffMoreText(row.added.hidden)), '折叠数要说得出来')
    eq(D.diffMoreText(0), '')
  })

  it('关系条目带上类别标签（与 report-export 同一份 RELATION_LABEL）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(
      rep(OLD_AT, { relations: [] }),
      rep(NEW_AT, { relations: [{ name: '李某', relation: 'rival', note: '', basis: 'https://n.example/x' }] })
    )
    const row = d.changedSections.find((s) => s.id === 'sec-relations')
    eq(row.added.items[0].text, '李某（对手）', '类别标签只在 report-export 写一次，这里不许另抄一份')
  })
})

/* ═══════════════════════════ ③ 只比能稳定判同的东西 ═══════════════════════════ */

describe('N-9 口径：键来自模型措辞的节只给条数', () => {
  it('争议议题全换措辞、条数不变 ⇒ 一条条目差异都不许报（否则稳定误报「全变了」）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(
      rep(OLD_AT, { controversies: [{ topic: '粉丝冲突', note: '', basis: 'x' }] }),
      rep(NEW_AT, { controversies: [{ topic: '与粉丝的争执', note: '', basis: 'x' }] })
    )
    const row = d.sections.find((s) => s.id === 'sec-controversies')
    eq(row.prevCount, 1)
    eq(row.nextCount, 1)
    eq(row.listed, false, '这一节的键是模型写的短句，不许开条目级比对')
    eq(row.added.total, 0)
    eq(row.removed.total, 0)
    eq(row.changed, false)
  })

  it('同一节的条数真变了则照报条数（只是不给条目清单）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(
      rep(OLD_AT, { controversies: [{ topic: 'a' }] }),
      rep(NEW_AT, { controversies: [{ topic: 'a' }, { topic: 'b' }] })
    )
    const row = d.changedSections.find((s) => s.id === 'sec-controversies')
    ok(row)
    eq(row.delta, 1)
    eq(row.listed, false)
    eq(row.added.total, 0, '列不出是哪一条，就不列')
  })
})

/* ═══════════════════════════ ④ 叙述段对照 ═══════════════════════════ */

describe('N-9 叙述：这一条刻意与报告页的 computeDiff 相反', () => {
  it('判断类正文的差异要报出来（「口径变了吗」正是这一视图存在的理由）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(
      rep(OLD_AT, { intro: '简介 A', analysis: '点评 A', verdict: { summary: '结论 A', positioning: '定位 A' } }),
      rep(NEW_AT, { intro: '简介 A', analysis: '点评 B', verdict: { summary: '结论 A', positioning: '定位 A' } })
    )
    const changed = d.changedProse.map((p) => p.id)
    deepEq(changed, ['analysis'], '只有 AI 点评变了')
    eq(d.changedProse[0].prev, '点评 A')
    eq(d.changedProse[0].next, '点评 B')
    ok(/1 段叙述内容不同/.test(D.diffSummaryText(d)))
  })

  it('changed 用完整正文比、只有展示才截断（前 46 字相同的改动不许读成「没变」）', () => {
    const D = DIFF()
    const head = '这是一段足够长的引言'.repeat(8)
    const d = D.buildReportDiff(rep(OLD_AT, { intro: `${head}结尾甲` }), rep(NEW_AT, { intro: `${head}结尾乙` }))
    const row = d.changedProse.find((p) => p.id === 'intro')
    ok(row, '截断后再比会把这种改动读成「没变」，那是最不该出现的误报')
    eq(row.prev.length, D.DIFF_PROSE_MAX, '展示侧仍要截断（这一页不是全文阅读器）')
    eq(row.prev, row.next, '两边的开头本来就是一样的')
  })

  it('一段从无到有算变化；两侧都空不算', () => {
    const D = DIFF()
    const d = D.buildReportDiff(
      rep(OLD_AT, { reputation: undefined }),
      rep(NEW_AT, { reputation: { positive: '正面', negative: '负面' } })
    )
    deepEq(
      d.changedProse.map((p) => p.id),
      ['reputation-positive', 'reputation-negative']
    )
    eq(d.changedProse[0].prev, '', '旧版那一侧空着，页面会写「当时没有这一段」')
    const same = D.buildReportDiff(rep(OLD_AT), rep(NEW_AT))
    eq(same.changedProse.length, 0, '两侧都没有的段不算「变化」')
    ok(D.diffIsEmpty(same))
    ok(/都没有变化/.test(D.diffSummaryText(same)))
  })

  it('言行一致三段合成一条（同一处改动不许说三遍）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(
      rep(OLD_AT, { consistency: { claim: '说 A', act: '做 A', gap: '' } }),
      rep(NEW_AT, { consistency: { claim: '说 A', act: '做 B', gap: '' } })
    )
    deepEq(
      d.changedProse.map((p) => p.id),
      ['consistency']
    )
  })
})

/* ═══════════════════════════ ⑤ null 与 0 分开 ═══════════════════════════ */

describe('N-9 null 与 0：不是一回事', () => {
  it('一侧没有这一段、另一侧是空数组 ⇒ 是变化，而 delta 是 null（不是 0）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(rep(OLD_AT, { peers: undefined }), rep(NEW_AT, { peers: [] }))
    const row = d.changedSections.find((s) => s.id === 'sec-peers')
    ok(row, '「这一版没有这一段」与「有这一段但空」之间确实是改动')
    eq(row.prevCount, null)
    eq(row.nextCount, 0)
    eq(row.delta, null, '「不知道」与「一样多」必须分得开')
    eq(D.diffCountText(row), '这一版没有这一段，新版 0 条')
  })

  it('两侧都没有这一段 ⇒ 不算变化', () => {
    const D = DIFF()
    const d = D.buildReportDiff(rep(OLD_AT), rep(NEW_AT))
    notOk(d.changedSections.some((s) => s.id === 'sec-peers'))
  })

  it('条数文案四种情形都说人话', () => {
    const D = DIFF()
    const mk = (a, b) => ({ prevCount: a, nextCount: b })
    eq(D.diffCountText(mk(null, null)), '')
    eq(D.diffCountText(mk(3, 3)), '3 条，没有增减')
    eq(D.diffCountText(mk(3, 5)), '3 → 5 条')
    eq(D.diffCountText(mk(5, null)), '这一版 5 条，新版没有这一段')
  })

  it('热度也要分「两版都有」与「一侧缺」', () => {
    const D = DIFF()
    const both = D.buildReportDiff(rep(OLD_AT, { heat: 62 }), rep(NEW_AT, { heat: 71 }))
    eq(D.diffHeatText(both), '热度 62 → 71')
    eq(D.diffHeatText(D.buildReportDiff(rep(OLD_AT, { heat: 62 }), rep(NEW_AT, { heat: 62 }))), '热度 62，没有变化')
    eq(D.diffHeatText(D.buildReportDiff(rep(OLD_AT, { heat: undefined }), rep(NEW_AT, { heat: 71 }))), '', '算不出就留白，不拿 0 冒充「没热度」')
  })
})

/* ═══════════════════════════ ⑥ 前提与评价 ═══════════════════════════ */

describe('N-9 前提：不许让用户从差异里读出不存在的变化', () => {
  it('降级简版要交代（条目少不等于内容被删）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(rep(OLD_AT, { degraded: true }), rep(NEW_AT, { dynamics: dynList(2) }))
    eq(d.degraded, true)
    ok(D.diffCaveats(d).some((c) => /降级简版/.test(c)))
  })

  it('会员节一侧为空要交代（可能只是那一版不是会员档生成的）', () => {
    const D = DIFF()
    const d = D.buildReportDiff(rep(OLD_AT, { peers: undefined }), rep(NEW_AT, { peers: [{ name: 'B', gap: 'g' }] }))
    eq(d.memberUncertain, true)
    ok(D.diffCaveats(d).some((c) => /会员专属段落/.test(c)))
    const freeOnly = D.buildReportDiff(rep(OLD_AT, { dynamics: dynList(1) }), rep(NEW_AT, { dynamics: dynList(2) }))
    eq(freeOnly.memberUncertain, false, '免费节的不齐不该挂会员档的前提')
    deepEq(D.diffCaveats(freeOnly), [])
  })

  it('模块里没有「哪一版更好」这类评价（剥注释后断言）', () => {
    const code = stripComments(diffSrc)
    notOk(/更好|更差|更准|更可信|优劣|更高分/.test(code), '对比只列增减与并列，不排优劣')
  })
})

/* ═══════════════════════════ ⑦ 模板完整性 ═══════════════════════════ */

describe('N-9 模板完整性：对比口径与报告模板一一对应', () => {
  it('SECTION_SPEC 与 REPORT_TEMPLATE 的 id 集合完全相同（孤儿 / 漏项都是错）', () => {
    const toc = TOC()
    const templateIds = toc.REPORT_TEMPLATE.map((s) => s.id)
    const specIds = Array.from(diffSrc.matchAll(/'(sec-[a-z-]+)':/g)).map((m) => m[1])
    const missing = templateIds.filter((id) => !specIds.includes(id))
    const orphan = specIds.filter((id) => !templateIds.includes(id))
    deepEq(missing, [], '模板新增的节必须同时写进 SECTION_SPEC，否则它会在差异视图里凭空消失')
    deepEq(orphan, [], 'SECTION_SPEC 里不许留模板已经没有的 id（那是永不生效的死键）')
  })

  it('节的 label / tier 取自模板真源（页面不另抄一份节名）', () => {
    const D = DIFF()
    const toc = TOC()
    const d = D.buildReportDiff(rep(OLD_AT, { dynamics: dynList(1) }), rep(NEW_AT, { dynamics: dynList(2) }))
    deepEq(
      d.sections.map((s) => [s.id, s.label, s.tier]),
      toc.REPORT_TEMPLATE.map((s) => [s.id, s.label, s.tier])
    )
  })
})

/* ═══════════════════════════ ⑧ 端上读口：两版从哪里来 ═══════════════════════════ */

/** 三版历史 + 一个当前行（同 64 的夹具形状） */
function seedVersions() {
  env.db.__seed('report_versions', [
    {
      _id: `${KEY}#${T(2)}`,
      person_key: KEY,
      name: 'A',
      generated_at: T(2),
      replaced_at: T(6),
      news_count: 4,
      report: rep(T(2), {
        dynamics: dynList(4),
        peers: [{ name: 'B', gap: 'g' }],
        memberNotes: { compare: 'c', risk: 'r' }
      })
    },
    {
      _id: `${KEY}#${T(1)}`,
      person_key: KEY,
      name: 'A',
      generated_at: T(1),
      replaced_at: T(2),
      news_count: 3,
      report: rep(T(1), { dynamics: dynList(1) })
    }
  ])
  env.db.__seed('report_cache', [
    { _id: KEY, state: 'ready', report: rep(T(6), { dynamics: dynList(9) }), generated_at: T(6), search_meta: { news_count: 10 } }
  ])
}

describe('N-9 读口：loadVersionPair（utils/report-versions）', () => {
  it('第一条对的是**当前版**（N-2 回访要的那一对），其余对的是上面那一行', async () => {
    const rv = RV()
    seedVersions()
    const board = await rv.loadReportVersions(KEY)

    const first = await rv.loadVersionPair(board.rows, 0, KEY, true)
    eq(first.nextIsCurrent, true)
    eq(first.prev.generatedAt, T(2))
    eq(first.next.generatedAt, T(6), '第一条的对比对象是当前版')
    eq(first.next.dynamics.length, 9)

    const older = await rv.loadVersionPair(board.rows, 1, KEY, true)
    eq(older.nextIsCurrent, false)
    eq(older.prev.generatedAt, T(1))
    eq(older.next.generatedAt, T(2), '其余对的是列表里上面那一行')
    eq(rv.pairTargetLabel(older.nextIsCurrent), '更新的一版')
    eq(rv.pairTargetLabel(first.nextIsCurrent), '当前版', '含糊地写「新版」会把相隔几版的对比读成相邻两行')
  })

  it('旧版正文仍按读者身份过滤：非会员拿到的对比对象里没有会员段', async () => {
    const rv = RV()
    seedVersions()
    const board = await rv.loadReportVersions(KEY)
    const pair = await rv.loadVersionPair(board.rows, 0, KEY, false)
    eq(pair.prev.peers, undefined, '会员段必须在读口就被摘掉（差异视图比的就是这两个已过滤的对象）')
    eq(pair.prev.memberNotes, undefined)
  })

  it('两侧取不到时返回 null 那一侧，不抛错、也不给半份数据', async () => {
    const rv = RV()
    seedVersions()
    const board = await rv.loadReportVersions(KEY)
    env.db.__setFailing('report_versions', true)
    const pair = await rv.loadVersionPair(board.rows, 1, KEY, true)
    /* 上面那一行读不到 ⇒ 这一侧是 null；这一版的读口同样失败，但整件事不该炸成错误页 */
    eq(pair.next, null)
    ok(typeof rv.compareUnavailableNote() === 'string' && rv.compareUnavailableNote().length > 10)
  })

  it('越界 / 空列表不查库，直接给一个两侧都空的 pair', async () => {
    const rv = RV()
    seedVersions()
    const pair = await rv.loadVersionPair([], 0, KEY, true)
    eq(pair.prev, null)
    eq(pair.next, null)
  })
})

/* ═══════════════════════════ ⑨ 页面与埋点 ═══════════════════════════ */

describe('N-9 页面：差异视图（package/report-history）', () => {
  it('读口统一走 loadVersionPair（页面不许自己拼两版）', () => {
    const code = pageCode()
    ok(/await loadVersionPair\(/.test(code))
    notOk(/loadVersionReport\(/.test(code), '页面直接读单版会把「对比对象」的口径搬进渲染层')
  })

  it('两版都拿到才算对比，算不出就只出这一版的摘要', () => {
    const code = pageCode()
    ok(/pair\.prev && pair\.next \? buildReportDiff\(/.test(code), '少一侧时必须不调用 buildReportDiff')
    ok(/openView\.diff \?/.test(code))
    ok(/compareUnavailableNote\(\)/.test(code))
  })

  it('差异块的条数与文案全部取自纯函数（页面不自己算、也不自己写文案）', () => {
    const code = pageCode()
    ok(/diffSummaryText\(diff\)/.test(code))
    ok(/diffCountText\(s\)/.test(code))
    ok(/diffMoreText\(bucket\.hidden\)/.test(code), '折叠数要就地写出来，不许静默截断')
    ok(/diffCaveats\(diff\)/.test(code))
    ok(/diffHeatText\(diff\)/.test(code))
    notOk(/还有 \$\{/.test(code), '「还有 N 条」的措辞属于纯函数，页面不许另写一份')
  })

  it('分层复用同一个门禁：差异视图没有第二个会员判定', () => {
    const code = pageCode()
    eq((code.match(/canViewVersionReport\(/g) || []).length, 1, '门禁只许一处（复用，不新造一个）')
  })

  it('埋点在**算出来之后**上报（算不出却上报 = 把「没有可比对象」记成「比过、没变化」）', () => {
    const i = pageCode().indexOf('report_version_diff')
    const j = pageCode().indexOf('if (diff)')
    ok(i > 0 && j > 0 && j < i, '上报必须在 if (diff) 里')
    ok(/'report_version_diff'/.test(eventsSrc), 'events.ts 必须登记这个事件名')
    ok(/sections[\s\S]{0,120}prose[\s\S]{0,160}added[\s\S]{0,200}removed/.test(pageCode()), '四个数都要报：它们回答的是不同的问题')
    notOk(/report_version_diff[\s\S]{0,200}allowed/.test(pageCode()), '差异视图不设第二道墙，没有 allowed 这一维')
  })

  it('样式齐全（scss 里每块差异都有对应的类）', () => {
    for (const cls of ['__diff', '__diff-head', '__diff-sec', '__diff-items', '__diff-chip', '__diff-prose', '__diff-caveat']) {
      ok(scssSrc.includes(`.page-report-history${cls}`), `scss 缺少 .page-report-history${cls}`)
      ok(pageSrc.includes(`page-report-history${cls}`), `页面没用到 page-report-history${cls}`)
    }
  })

  it('页面注释说明方向（下一个人改这块时最容易读反的就是 prev / next）', () => {
    ok(/prev/.test(pageSrc) && /nextIsCurrent/.test(pageSrc))
    ok(/N-9/.test(pageSrc) && /N-9/.test(versionsSrc), '两端都要写明这是 N-9 的那对数据')
  })
})
