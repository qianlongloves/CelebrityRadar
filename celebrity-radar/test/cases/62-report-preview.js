'use strict'

/**
 * S3-3：**报告分档呈现（免费速览 / 会员完整）** —— `utils/report-toc.ts` 的限量派生
 * 与 `config/benefits.ts#REPORT_PREVIEW`。
 *
 * 这一版要钉的不是「免费用户少看几条」，而是五件容易做错、且错了很久都看不出来的事：
 *
 *   1. **两个杠杆都要在**：分档有「看得到哪几节」（模板 tier）与「每节能看多少条」
 *      （`REPORT_PREVIEW`）两层。只做前者时免费档每一节都是完整长度，观感差异出不来 ——
 *      这正是 S3-3 要修的，所以这里同时钉住两层都存在。
 *   2. **只在呈现层**（最重要）：截断只发生在渲染那一行。报告是全局共享缓存，且免费档
 *      那几节是周报 / 风险监控 / 对比页 / 问答 / **导出**的共同来源 —— 截在数据层等于把它们
 *      一起砍掉。故用例反向钉住：`dynamicsView`（它还被覆盖区间的算法读着）、
 *      `utils/member.ts#stripMemberSections`（仍只摘四段）、`utils/report-export.ts`
 *      （导出必须带全量：速览是「看」的档，不是「带走」的档）都不许跟着截。
 *   3. **不许静默截断**：每一处截断都当场写「还有 N 条」。静默少几条，免费用户读到的是
 *      「这个人的资料就这么多」——那是骗人。
 *   4. **锁态卡的节名与说明只在模板真源里**：`lockedNote` 必须**每个会员节都有、任何免费节都没有**
 *      （给免费节写锁态说明 = 让页面以为它被锁）。页面不许另抄一份说明。
 *   5. **数字不写死**：权益文案 / 免费清单 / 会员页表格里的条数全部派生自 `REPORT_PREVIEW`，
 *      改档位时三处一起变（写死就会出现「权益页写着 3 条、代码已经改成 5 条」）。
 *
 * 纯函数直接 require 编译产物；页面与模板读源码断言（与 61-report-export.js 同法）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 干净加载 utils/report-toc（它 import config/benefits，故必须先 resetAll） */
function TOC() {
  env.resetAll()
  return env.load('utils/report-toc')
}

function BENEFITS() {
  env.resetAll()
  return env.load('config/benefits')
}

const page = () => read(path.join('package', 'report', 'index.tsx'))

/* ═══════════════════ 1. 限量派生：纯函数、不改入参、按档分叉 ═══════════════════ */

describe('S3-3 免费速览 · 限量派生', () => {
  it('每档的条数取自 config/benefits.ts（不写死在 report-toc）', () => {
    const toc = TOC()
    const cfg = BENEFITS()
    eq(toc.previewRowLimit(false), cfg.REPORT_PREVIEW.sectionRows.free)
    eq(toc.previewRowLimit(true), cfg.REPORT_PREVIEW.sectionRows.member)
    eq(toc.previewRowLimit(true), null, '会员档必须是不截断（null），否则「会员完整」是空话')
    ok(typeof toc.previewRowLimit(false) === 'number' && toc.previewRowLimit(false) > 0)
  })

  it('免费档截断：只给前 N 条，并如实报出被藏起来的条数', () => {
    const toc = TOC()
    const n = toc.previewRowLimit(false)
    const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const p = toc.previewRows(all, false)
    eq(p.total, 8, 'total 永远报原始总数（标题里那个数字要说实话）')
    eq(p.rows.length, n)
    deepEq(p.rows, all.slice(0, n), '取的是**前** N 条（列表按时间/权重排序，尾部才是可省的）')
    eq(p.hidden, 8 - n)
  })

  it('会员档不截断：全部给回，hidden 恒为 0', () => {
    const toc = TOC()
    const all = ['a', 'b', 'c', 'd', 'e']
    const p = toc.previewRows(all, true)
    eq(p.rows.length, 5)
    eq(p.hidden, 0)
    eq(p.total, 5)
  })

  it('边界：条数不足不动、恰好等于上限不动、空值与 null 不炸', () => {
    const toc = TOC()
    const n = toc.previewRowLimit(false)

    const few = toc.previewRows(['a', 'b'], false)
    eq(few.rows.length, 2)
    eq(few.hidden, 0, '本来就不够 N 条，不该报「还有 0 条」')

    const exact = toc.previewRows(new Array(n).fill('x'), false)
    eq(exact.hidden, 0, '恰好等于上限时没有可藏的条数')

    eq(toc.previewRows(null, false).hidden, 0)
    eq(toc.previewRows(undefined, false).total, 0)
    eq(toc.previewRows(null, false).rows.length, 0)
  })

  it('不改入参：原数组长度与内容一字不动（数据层必须完整）', () => {
    const toc = TOC()
    const all = ['a', 'b', 'c', 'd', 'e', 'f']
    const copy = all.slice()
    const p = toc.previewRows(all, false)
    deepEq(all, copy, 'previewRows 是纯函数，不许 splice / sort / pop 掉调用方的数组')
    notOk(p.rows === all, '返回的是切片，不是同一个引用（免得页面顺手改到数据层）')
  })

  it('提示文案：没有可藏的就返回空串，有则如实报数', () => {
    const toc = TOC()
    eq(toc.previewHiddenNote(0), '', '无截断时必须返回空串，页面靠它短路')
    const note = toc.previewHiddenNote(5)
    ok(note.includes('5'), `提示要报出具体条数：${note}`)
    ok(/会员/.test(note), `提示要指向会员（它是转化点）：${note}`)
    notOk(toc.previewHiddenNote(5).includes('undefined'), '文案里不许漏出 undefined')
  })
})

/* ═══════════════════ 2. 锁态卡：说明只写在模板真源里 ═══════════════════ */

describe('S3-3 锁态卡 · 模板真源', () => {
  it('每个会员节都有 lockedNote，任何免费节都没有（写错方向 = 让页面以为免费节被锁）', () => {
    const toc = TOC()
    const members = toc.REPORT_TEMPLATE.filter((s) => s.tier === 'member')
    const frees = toc.REPORT_TEMPLATE.filter((s) => s.tier !== 'member')

    ok(members.length > 0, '模板里应当有会员节')
    for (const s of members) {
      ok(!!s.lockedNote, `${s.id} 是会员节，必须有 lockedNote（锁态卡上那句「这一节讲什么」）`)
      ok(s.lockedNote.length >= 8 && s.lockedNote.length <= 60, `${s.id} 的 lockedNote 长度应在 8~60 字：${s.lockedNote}`)
    }
    for (const s of frees) {
      notOk(!!s.lockedNote, `${s.id} 是免费节，不该有 lockedNote —— 那会让锁态卡以为它被锁`)
    }
  })

  it('lockedNote 不剧透内容：不写条数、不写数字、不写「还有」', () => {
    const toc = TOC()
    for (const s of toc.REPORT_TEMPLATE) {
      if (!s.lockedNote) continue
      /* 免费用户读到的是**锁**，不是半份内容：条数 / 数量词一律不许出现 */
      notOk(/\d/.test(s.lockedNote), `${s.id} 的 lockedNote 不许写数字：${s.lockedNote}`)
      notOk(/还有|共\s*\d|条已/.test(s.lockedNote), `${s.id} 的 lockedNote 不许透露有多少条：${s.lockedNote}`)
    }
  })

  it('锁态卡的说明与节名同源：页面不许另抄一份文案表', () => {
    const src = page()
    ok(/REPORT_TEMPLATE/.test(src), '页面要 import REPORT_TEMPLATE 才能取 label / lockedNote')
    ok(/sec\.lockedNote/.test(src) && /sec\.label/.test(src), '锁态卡的两个字段都应取自模板对象')
    /* 反向：页面里不该出现 lockNote 的手抄副本（把模板里那几句的任意一句抄进页面即违规） */
    const toc = TOC()
    for (const s of toc.REPORT_TEMPLATE) {
      if (!s.lockedNote) continue
      notOk(src.includes(s.lockedNote), `页面抄了 ${s.id} 的 lockedNote，改模板时会两边不一致`)
    }
  })
})

/* ═══════════════════ 3. 页面接入：截断 + 锁卡 + 就地说实话 ═══════════════════ */

describe('S3-3 报告页接入', () => {
  it('列表型节改用 previewRows 的产物渲染（不再是整份数组直接 map）', () => {
    const src = page()
    ok(/previewRows/.test(src), '页面要 import previewRows')
    for (const name of ['profilePreview', 'relationsPreview', 'dynamicsPreview', 'quotesPreview']) {
      ok(new RegExp(`const ${name} = previewRows\\(`).test(src), `${name} 应当由 previewRows 派生`)
      ok(new RegExp(`${name}\\.rows\\.map\\(`).test(src), `${name} 的渲染必须用 .rows（用错了等于没截）`)
    }
  })

  it('截断处**就地说实话**：每处都渲染「还有 N 条」且可点（落到会员中心）', () => {
    const src = page()
    const notes = src.match(/page-report__preview-note/g) || []
    eq(notes.length, 4, `四处截断各一条提示，实际 ${notes.length} 处`)
    const clickable = src.match(/className='page-report__preview-note' onClick=\{\(\) => onPromoTap\('report_preview'\)\}/g) || []
    eq(clickable.length, 4, '提示要可点（它是这一档看不到的量，也就是最该被点到的那一行）')
    ok(/previewHiddenNote\(/.test(src), '文案要走 previewHiddenNote（口径统一在真源里）')
  })

  it('会员节的位置**就地**放锁态卡，条件取自 lockedReportToc（与目录那行同一份条件）', () => {
    const src = page()
    ok(/const lockedIds = new Set\(tocLocked\.map\(\(s\) => s\.id\)\)/.test(src), '锁态卡的条件应派生自 tocLocked')

    const toc = TOC()
    for (const s of toc.REPORT_TEMPLATE) {
      if (s.tier !== 'member') continue
      ok(
        new RegExp(`lockedIds\\.has\\('${s.id}'\\) && <LockedCard id='${s.id}'`).test(src),
        `${s.id} 没有就地锁态卡（只靠目录底部那行，用户滑到正文只会以为「报告到底了」）`
      )
    }

    const cards = src.match(/<LockedCard id='/g) || []
    const memberCount = toc.REPORT_TEMPLATE.filter((s) => s.tier === 'member').length
    eq(cards.length, memberCount, '锁态卡数量应等于会员节数量')
  })

  it('锁态卡自己也要守住分档：不渲染任何内容片段，只有节名 / 说明 / 引导', () => {
    const src = page()
    const start = src.indexOf('function LockedCard')
    ok(start > -1, 'LockedCard 应在页面里定义')
    const body = src.slice(start, src.indexOf('export default function ReportPage'))
    ok(/sec\.label/.test(body) && /sec\.lockedNote/.test(body))
    notOk(/report\./.test(body), '锁态卡不许读报告字段（免费用户读到的是锁，不是半份内容）')
    notOk(/\.slice\(|\.map\(/.test(body), '锁态卡不许遍历任何数据')
  })

  it('目录底部那行同时交代两个杠杆（节数 + 每节条数）', () => {
    const src = page()
    ok(/完整模板 \$\{TEMPLATE_SIZE\} 节 · 会员另含 \$\{tocLocked\.length\} 节 · 每节看全部/.test(src),
      '目录提示要同时说明「会员另含 N 节」和「每节看全部」——只说节数就是 S3-3 之前的旧口径')
  })
})

/* ═══════════════════ 4. 不变式：绝不下沉到数据层 ═══════════════════ */

describe('S3-3 不变式 · 只在呈现层', () => {
  it('dynamicsView 保持完整（它还被覆盖区间的算法读着，截了会改掉速览卡的数字）', () => {
    const src = page()
    const i = src.indexOf('const dynamicsView')
    ok(i > -1)
    const line = src.slice(i, src.indexOf('\n', i))
    notOk(/previewRows/.test(line), 'dynamicsView 的定义处不许截断，截断只发生在渲染源')
    ok(/const dynamicsPreview = previewRows\(dynamicsView, member\)/.test(src),
      '预览要从 dynamicsView 派生一份副本，而不是改它本身')
  })

  it('报告的节名总数（如「近期动态（11）」）照实报总数，不跟着截断变小', () => {
    const src = page()
    ok(/dynamicsView\.length/.test(src), '标题里的总数应继续用完整数组的长度')
    const i = src.indexOf('const dynamicsPreview')
    const rest = src.slice(i, i + 400)
    notOk(/dynamicsView\s*=\s*previewRows/.test(rest), '不许把 dynamicsView 本身换掉')
  })

  it('stripMemberSections 仍只摘四段（会员档的节数据仍留在站内对象里给免费功能读）', () => {
    const m = read(path.join('utils', 'member.ts'))
    ok(/stripMemberSections/.test(m))
    /* 这三节的数据是「member 档但免费批次也生成」的，站内必须留着（对比页 / 话题速览 / 问答在用） */
    ok(/export function stripMemberSections/.test(m), 'stripMemberSections 必须仍是导出函数')
    const body = m.slice(m.indexOf('export function stripMemberSections'))
    const end = body.indexOf('\n}')
    const fn = body.slice(0, end)
    for (const keep of ['stance', 'glossary', 'endorsements']) {
      notOk(new RegExp(`delete copy\\.${keep}`).test(fn),
        `stripMemberSections 不许删 ${keep}：它是免费功能（对比页 / 话题速览 / 问答）的上下文来源`)
    }
  })

  it('导出带全量：report-export 不许跟着速览截断（速览是「看」的档，不是「带走」的档）', () => {
    const ex = read(path.join('utils', 'report-export.ts'))
    notOk(/previewRows|previewRowLimit|REPORT_PREVIEW/.test(ex),
      '导出必须给全量（会员带走的是完整材料）；把速览口径引进来会让导出的行数随档位偷偷变少')
  })
})

/* ═══════════════════ 5. 权益叙事：三处文案与真源同源 ═══════════════════ */

describe('S3-3 权益叙事', () => {
  it('会员权益那条把两个杠杆都说出来，且条数派生自 REPORT_PREVIEW', () => {
    env.resetAll()
    const m = env.load('utils/member')
    const cfg = env.load('config/benefits')
    const n = cfg.REPORT_PREVIEW.sectionRows.free
    const point = m.MEMBER_BENEFIT_POINTS.find((p) => p.title.includes('完整报告模板'))
    ok(!!point, '权益列表里应有「完整报告模板」那条')
    ok(point.note.includes(`每节最多 ${n} 条`), `该条要写明免费档每节的条数：${point.note}`)
    ok(/不截断/.test(point.note), `该条要写明会员不截断：${point.note}`)
    /* 写死过的典型症状：文案里出现一个和真源不一致的数 */
    notOk(new RegExp(`每节最多 (?!${n}\\b)\\d+ 条`).test(point.note), `条数写死了或与真源不一致：${point.note}`)
  })

  it('免费清单如实写「速览」，且条数同源（不写死数字）', () => {
    env.resetAll()
    const m = env.load('utils/member')
    const cfg = env.load('config/benefits')
    ok(/速览/.test(m.FREE_FEATURES_NOTE), `免费清单要说明看得到的是速览：${m.FREE_FEATURES_NOTE}`)
    ok(m.FREE_FEATURES_NOTE.includes(String(cfg.REPORT_PREVIEW.sectionRows.free)),
      `免费清单的条数应与真源一致：${m.FREE_FEATURES_NOTE}`)
    /* 「不限次」说的是次数，不是每节的条数 —— 两个概念都要在，别被下一句改没了 */
    ok(/不限次/.test(m.FREE_FEATURES_NOTE))
  })

  it('会员页对比表那一格也说条数，且用同一份真源', () => {
    const src = read(path.join('package', 'member', 'index.tsx'))
    ok(/REPORT_PREVIEW/.test(src), '会员页要 import REPORT_PREVIEW')
    ok(/每节 \$\{REPORT_PREVIEW\.sectionRows\.free\} 条/.test(src), '免费格要写出每节条数')
    ok(/完整 \$\{TEMPLATE_SIZE\} 节 · 每节全部/.test(src), '会员格要写「每节全部」')
  })

  it('三个杠杆的常量都还在：节数（模板）与条数（benefits）分属两个真源', () => {
    const toc = TOC()
    const cfg = BENEFITS()
    ok(toc.FREE_TOC_COUNT < toc.TEMPLATE_SIZE, '免费节数必须小于模板节数')
    eq(toc.MEMBER_TOC_COUNT, toc.TEMPLATE_SIZE - toc.FREE_TOC_COUNT, '会员节数 = 模板 - 免费')
    ok(cfg.REPORT_PREVIEW.sectionRows.free > 0)
    eq(cfg.REPORT_PREVIEW.sectionRows.member, null)
  })
})
