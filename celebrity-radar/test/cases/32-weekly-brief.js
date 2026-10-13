'use strict'

/**
 * 周报简报的导出与分享（P4-B，2026-10-13）。
 *
 * 钉住五件事：
 *   1. **内容组装是纯函数**（utils/weekly-brief.ts#buildWeeklyBrief）：输入周报数据 → 输出要点数组，
 *      同输入同输出、不抛错；要点带来源与时间；最多 5 条；字符截断规则固定（不溢出画布）。
 *   2. **合规红线**：涉政涉军一律不进（沿用既有 isSensitiveQuery 拦截，不放宽）；无来源的不进；
 *      说明文案含「公开报道 / 非平台定性 / 聚合≠认定」；不使用「已证实 / 已确认」这类措辞。
 *   3. **免费 / 会员门禁**：导出 / 分享是会员权益（canExportWeeklyBrief 二元口径），
 *      免费用户被拦在导出入口、会员放行；站内查看周报不受影响。
 *   4. **空态**：没有可分享的动态时给明确文案，不白屏。
 *   5. **绘制管线复用**：分享图与名言卡共用 renderPoster / saveImageToAlbum（静态钉住），
 *      图上有来源与时间、有「非平台定性」说明、有产品名与免责角标。
 *
 * 纯函数直接 require 编译产物；页面与组件是 .tsx（不进测试编译），与既有页面用例同法读源码文本断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 干净加载 utils/weekly-brief */
function WB() {
  env.resetAll()
  return env.load('utils/weekly-brief')
}

/* ---------------------------------- 夹具 ---------------------------------- */

const entry = (title, date, source = '示例来源', url = 'https://example.com/a') => ({
  title,
  url,
  content: '正文',
  source,
  publishedDate: date
})

const person = (personKey, name, domain, entries) => ({ personKey, name, domain, summary: '', entries })

const mkReport = (persons, extra = {}) => ({
  weekKey: '2026-W41',
  windowLabel: '2026-10-03 ~ 2026-10-09',
  generatedAt: '2026-10-09T02:00:00.000Z',
  personCount: persons.length,
  entryCount: persons.reduce((n, p) => n + p.entries.length, 0),
  overview: '综述',
  persons,
  topics: [],
  disclaimer: '免责声明',
  ...extra
})

/* ───────────────────────── 1. 内容组装是纯函数 ───────────────────────── */

describe('周报简报：内容组装（buildWeeklyBrief）', () => {
  it('输入周报数据 → 输出要点数组：带人名 / 来源 / 时间，按时间倒序', () => {
    const { buildWeeklyBrief } = WB()

    const b = buildWeeklyBrief(
      mkReport([
        person('A#tech', '甲', 'tech', [entry('甲发布新品', '2026-10-05', '每日新闻')]),
        person('B#tech', '乙', 'tech', [entry('乙出席活动', '2026-10-06', '财经网')])
      ])
    )

    eq(b.title, '本周简报')
    eq(b.range, '2026-10-03 ~ 2026-10-09')
    eq(b.points.length, 2)
    /* 时间线按日期倒序 → 最新的（乙 10-06）在前 */
    ok(b.points[0].text.includes('乙'), `实际首条：${b.points[0].text}`)
    eq(b.points[0].source, '财经网')
    eq(b.points[0].date, '2026-10-06')
    eq(b.points[1].source, '每日新闻')
    eq(b.points[1].date, '2026-10-05')
    eq(b.generatedAt, '2026-10-09T02:00:00.000Z')
  })

  it('同一份周报两次组装的要点完全一致（确定性，不依赖 Map 遍历抖动）', () => {
    const { buildWeeklyBrief } = WB()
    const r = mkReport([
      person('A#tech', '甲', 'tech', [entry('a', '2026-10-05', 's1'), entry('b', '2026-10-06', 's2')])
    ])
    deepEq(buildWeeklyBrief(r), buildWeeklyBrief(r))
  })

  it('要点最多 5 条（摆满一屏反而没重点）', () => {
    const { buildWeeklyBrief, BRIEF_POINT_MAX } = WB()
    eq(BRIEF_POINT_MAX, 5)

    const entries = []
    for (let i = 0; i < 9; i++) {
      entries.push(entry(`动态${i}`, `2026-10-0${(i % 9) + 1}`, `来源${i}`))
    }
    const b = buildWeeklyBrief(mkReport([person('A#tech', '甲', 'tech', entries)]))
    eq(b.points.length, 5)
  })

  it('截断规则：超长正文 / 来源被截断并补省略号，长度绝不越界（不溢出画布）', () => {
    const { buildWeeklyBrief, BRIEF_TEXT_MAX, BRIEF_SOURCE_MAX } = WB()

    const b = buildWeeklyBrief(
      mkReport([
        person('A#tech', '甲', 'tech', [entry('长'.repeat(120), '2026-10-05', '来'.repeat(60))])
      ])
    )
    const p = b.points[0]
    ok(p.text.length <= BRIEF_TEXT_MAX, `正文截断后 ${p.text.length} 字符，上限 ${BRIEF_TEXT_MAX}`)
    ok(p.text.endsWith('…'), '被截断的文本要补省略号')
    ok(p.source.length <= BRIEF_SOURCE_MAX, `来源截断后 ${p.source.length} 字符，上限 ${BRIEF_SOURCE_MAX}`)

    /* 恰好不超限的长度保持原样（不该多出一个省略号） */
    const okText = '短'.repeat(BRIEF_TEXT_MAX)
    const b2 = buildWeeklyBrief(
      mkReport([person('A#tech', '甲', 'tech', [entry(okText.slice(2), '2026-10-05', '来源')])])
    )
    notOk(b2.points[0].text.endsWith('…'), '未超限的文本不该被截断')
  })

  it('重复要点（截断后同文本）只留一条，不注水', () => {
    const { buildWeeklyBrief } = WB()
    const b = buildWeeklyBrief(
      mkReport([
        person('A#tech', '甲', 'tech', [
          entry('同一个动态', '2026-10-05', '来源甲'),
          entry('同一个动态', '2026-10-06', '来源乙')
        ])
      ])
    )
    eq(b.points.length, 1)
  })
})

/* ───────────────────────── 2. 合规红线 ───────────────────────── */

describe('周报简报：合规红线', () => {
  it('无来源的条目不进要点（不可追溯；来源缺失绝不编一个）', () => {
    const { buildWeeklyBrief } = WB()

    const b = buildWeeklyBrief(
      mkReport([
        person('A#tech', '甲', 'tech', [
          entry('有来源的动态', '2026-10-05', '每日新闻'),
          entry('没来源的动态', '2026-10-06', '')
        ])
      ])
    )

    eq(b.points.length, 1, '只有带来源的那条进要点')
    ok(b.points[0].text.includes('有来源'))
  })

  it('涉政涉军一律不进要点（沿用既有 isSensitiveQuery 拦截，不放宽）', () => {
    const { buildWeeklyBrief } = WB()

    const b = buildWeeklyBrief(
      mkReport([
        person('A#tech', '甲', 'tech', [
          entry('某国总统发表讲话', '2026-10-06', '某报'),
          entry('军队举行年度演练', '2026-10-05', '某报'),
          entry('某艺人发布新专辑', '2026-10-04', '娱乐周刊')
        ])
      ])
    )

    eq(b.points.length, 1, '涉政 / 涉军两条被拦下')
    ok(b.points[0].text.includes('新专辑'))
  })

  it('说明文案含「公开报道 / 非平台定性 / 聚合≠认定」，且不用「已证实 / 已确认」措辞', () => {
    const { buildWeeklyBrief, BRIEF_NOTE } = WB()

    ok(BRIEF_NOTE.includes('公开报道'), '要写明是公开报道')
    ok(BRIEF_NOTE.includes('非平台定性'), '要写明非平台定性')
    ok(BRIEF_NOTE.includes('聚合'), '要有「聚合 ≠ 认定」的克制说明')
    notOk(/已证实|已确认/.test(BRIEF_NOTE), '不得出现「已证实 / 已确认」这类会被读成平台定性的措辞')

    const b = buildWeeklyBrief(mkReport([person('A#tech', '甲', 'tech', [entry('动态', '2026-10-05')])]))
    ok(b.note.includes('非平台定性'), '简报自带的说明就是这句')
  })

  it('复制摘要内容与图一致：含来源与时间，且带上说明', () => {
    const { buildWeeklyBrief, weeklyBriefCopy } = WB()

    const b = buildWeeklyBrief(
      mkReport([person('A#tech', '甲', 'tech', [entry('甲发布新品', '2026-10-05', '每日新闻')])])
    )
    const copy = weeklyBriefCopy(b)

    ok(copy.includes('本周简报'), '摘要含标题')
    ok(copy.includes(b.range), '摘要含统计窗口')
    ok(copy.includes('每日新闻'), '摘要含来源')
    ok(copy.includes('2026-10-05'), '摘要含时间')
    ok(copy.includes('非平台定性'), '摘要含「非平台定性」说明')
  })
})

/* ───────────────────────── 3. 空态分支 ───────────────────────── */

describe('周报简报：空态分支（不白屏）', () => {
  it('没有可分享的动态 → 要点为空数组', () => {
    const { buildWeeklyBrief } = WB()
    const b = buildWeeklyBrief(mkReport([person('A#tech', '甲', 'tech', [])]))
    deepEq(b.points, [])
  })

  it('空态复制摘要：给出明确说明而不是一段空白', () => {
    const { buildWeeklyBrief, weeklyBriefCopy } = WB()
    const copy = weeklyBriefCopy(buildWeeklyBrief(mkReport([person('A#tech', '甲', 'tech', [])])))
    ok(/暂无/.test(copy), '空态摘要要说清「暂无可分享的动态」')
    ok(copy.includes('非平台定性'), '空态也要带说明')
  })

  it('来源 / 时间缺失时的回落：来源未标注 / 近期（摘要兜底，不抛错）', () => {
    const { weeklyBriefCopy } = WB()
    const brief = {
      title: '本周简报',
      range: '2026-10-03 ~ 2026-10-09',
      points: [{ text: '甲：某动态', source: '', date: '' }],
      note: '均为公开报道与检索结果，已标注来源与时间；聚合≠认定，非平台定性，不构成对事实的核实。',
      generatedAt: ''
    }
    const copy = weeklyBriefCopy(brief)
    ok(copy.includes('来源未标注'))
    ok(copy.includes('近期'))
  })
})

/* ───────────────────────── 4. 免费 / 会员门禁 ───────────────────────── */

describe('周报简报：导出 / 分享是会员权益（门禁取自真源）', () => {
  it('二元口径：免费被拦、会员放行', () => {
    const { canExportWeeklyBrief } = WB()
    notOk(canExportWeeklyBrief(false), '免费用户不放行导出 / 分享')
    ok(canExportWeeklyBrief(true), '会员放行')
  })

  it('升级引导文案（非弹窗一行）：免费可见、提到会员与开通', () => {
    const { weeklyExportNote } = WB()
    const note = weeklyExportNote()
    ok(note.includes('会员'), '引导要提到会员')
    ok(note.includes('开通'), '引导要给出开通路径的暗示')
    ok(note.includes('›'), '沿用既有引导行的「›」写法')
  })

  it('门禁不在页面里写死：页面走 canExportWeeklyBrief + readMemberState', () => {
    const page = read('pages/weekly/index.tsx')
    ok(page.includes('canExportWeeklyBrief('), '导出入口应按门禁函数判定，不页面内写死 isMember')
    ok(page.includes('readMemberState('), '身份取自既有会员判定入口')
    ok(page.includes("from '@/utils/weekly-brief'"), '门禁与内容组装同源（weekly-brief）')
    /* 站内查看周报保持免费：主体渲染条件不接会员态（分层只落在导出/分享这一个动作上） */
    ok(
      page.includes("phase === 'ready' && report && ("),
      '站内查看周报的渲染条件不得接会员态'
    )
  })
})

/* ───────────────────────── 5. 页面接入（静态约束） ───────────────────────── */

describe('周报页：导出入口 / 非弹窗引导 / 弹层（静态约束）', () => {
  const page = read('pages/weekly/index.tsx')
  const scss = read('pages/weekly/index.scss')

  it('导出入口对所有用户可见，点击才分层', () => {
    ok(page.includes('导出分享图'), '缺导出入口')
    ok(page.includes('onExport'), '导出入口要有处理函数')
    ok(page.includes('本期暂无可分享的动态'), '无数据时给明确提示（不白屏）')
  })

  it('免费引导是**非弹窗**：就地一行 + 跳会员页，不用 showModal', () => {
    ok(page.includes('page-weekly__export-guide'), '缺引导行样式钩子')
    ok(page.includes('weeklyExportNote('), '引导文案取自 utils/weekly-brief（不页面内写死）')
    ok(page.includes("'/pages/member/index'"), '引导行点了要能进会员页')
    ok(scss.includes('&__export-guide'), '引导行样式缺失')
    /* 导出入口附近不得出现 showModal（分层必须是「非弹窗」的） */
    const at = page.indexOf('const onExport')
    notOk(page.slice(at, at + 800).includes('showModal'), '免费拦截不得用弹窗')
  })

  it('分享图弹层复用 share-poster 组件，并把简报数据交给它', () => {
    ok(page.includes("from '@/components/share-poster'"), '复用既有弹层组件')
    ok(page.includes('renderWeeklyBriefPoster('), '用周报简报的绘制函数出图')
    ok(page.includes('weeklyBriefHeight('), '画布高度随要点条数算')
    ok(page.includes('weeklyBriefCopy('), '复制摘要内容与图一致')
  })
})

/* ───────────────────────── 6. 绘制管线复用（静态钉住） ───────────────────────── */

describe('周报简报卡：复用名言卡的绘制管线与相册处理（静态约束）', () => {
  const sc = read('utils/share-card.ts')
  const wb = read('utils/weekly-brief.ts')

  it('分享图与名言卡共用 renderPoster / saveImageToAlbum（像素比与权限处理不各写一套）', () => {
    ok(sc.includes('export function renderWeeklyBriefPoster'), '缺周报简报出图入口')
    ok(sc.includes('paintWeeklyBrief'), '缺周报简报绘制')
    ok(sc.includes('return renderPoster('), '周报简报必须复用 renderPoster（离屏 canvas + dpr 缩放）')
    ok(sc.includes('export async function saveImageToAlbum'), '保存相册仍走同一实现（含授权被拒分支）')
  })

  it('图上带来源与时间：「来源未标注 · 近期」回落画在图上', () => {
    ok(sc.includes('来源未标注'), '图上的来源缺失回落')
    ok(sc.includes('近期'), '图上的时间缺失回落')
  })

  it('内容组装层复用既有敏感拦截，不另写名单', () => {
    ok(wb.includes("from './sensitive'"), 'weekly-brief 应引用 utils/sensitive')
    ok(wb.includes('isSensitiveQuery('), '逐条走既有拦截函数')
  })
})
