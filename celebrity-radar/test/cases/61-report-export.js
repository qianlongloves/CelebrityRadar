'use strict'

/**
 * S3-1：**结构化导出**（utils/report-export.ts）—— 「能力 / 交付物」型付费点。
 *
 * 这条路要钉的不是「有没有导出按钮」，而是四件容易做错的事：
 *
 *   1. **章节真源只有一个**：导出的节名与顺序必须等于模板（`utils/report-toc.ts`）算出来的可见节，
 *      而不是在导出模块里另抄一份标题。所以这里同时钉「SECTION_BODY 的键集合 == REPORT_TEMPLATE 的 id 集合」
 *      （既不能有孤儿键，也不能有漏掉的节）—— 否则加了新节只改模板、导出悄悄少一节，没人会发现。
 *   2. **不变式（最重要）**：非会员的产物里**一定**不含会员段（memberNotes / conflicts / peers /
 *      affiliations / stance / glossary）。理由与 utils/member.ts 那句注释一致：「任何新增的消费方
 *      （AI 问答、以后的分享 / 导出）只要忘了判会员态，就等于把付费内容送出去」。
 *      这里连 **JSON 字符串**一起断言 —— JSON 是原样序列化整份报告，最容易把会员段漏出去。
 *   3. **每条事实带出处**，且**无出处的不许静默当成有据**（动态要显式标「未标出处」，
 *      而不是像长图那样直接不带走：导出是给自己核对的完整材料，删一条会让人以为「那天没这事」）。
 *   4. **分层口径与既有两条先例逐字一致**：导出是会员权益（二元、无数值），
 *      免费用户看得到入口 + 一行非弹窗引导；且中文标签与报告页的 RELATION_META / STANCE_META
 *      逐字相同（第一版这里写错成「竞争 / 批评 / 中立」，页面上其实是「对手 / 质疑 / 中性」）。
 *
 * 纯函数直接 require 编译产物；页面与模板真源读源码断言（与既有用例同法）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 干净加载 utils/report-export */
function EX() {
  env.resetAll()
  return env.load('utils/report-export')
}

/* ---------------------------------- 夹具 ---------------------------------- */

const AT = new Date('2026-10-16T14:20:00')

/** 最小可用报告：字段与 report.ts 的 Report 一一对应，只放本模块真的会读的 */
function mkReport(over = {}) {
  return {
    personKey: '张三#tech',
    name: '张三',
    generatedAt: '2026-10-15T09:12:33.000Z',
    heat: 62,
    intro: '连续创业者，主攻企业服务。',
    coverage: {
      items: 128,
      recent: 31,
      firstAt: '2024-03-01',
      latestAt: '2026-10-14',
      latest: { title: '完成新一轮融资', source: '每日新闻', url: 'https://example.com/n' }
    },
    profile: [{ label: '出生地', value: '四川成都', basis: '新浪娱乐' }],
    relations: [{ name: '李四', relation: 'cooperate', note: '合作过三部作品', basis: '界面新闻' }],
    dynamics: [
      { date: '2026-10-05', title: '出席发布会', summary: '宣布新产品线', source: '每日新闻', url: 'https://example.com/a' },
      /* 无出处的那一条：导出必须保留并标注，不许静默当成有据事实 */
      { date: '2026-10-03', title: '网传调整组织架构', summary: '', source: '', url: '' }
    ],
    quotes: [{ text: '长期主义', context: '发布会', source: '每日新闻' }],
    analysisPoints: [{ point: '新作定档带动档期关注', basis: '界面新闻' }],
    controversies: [
      { topic: '合约纠纷', claim: '2026-09 前经纪公司称合约未到期', response: '工作室称已于 8 月解约', basis: 'https://example.com/b' }
    ],
    timeline: [{ date: '2026-01', event: '成立公司' }],
    verdict: { summary: '关注度上行', positioning: '头部' },
    sources: [
      { title: 'a', url: 'https://example.com/a' },
      { title: 'b', url: '' }
    ],
    ...over
  }
}

/* ═══════════════════ 1. 产物：Markdown 内容与可核对性 ═══════════════════ */

describe('结构化导出：Markdown 产物', () => {
  it('头部给身份与口径：姓名、领域、热度、素材数、导出时间', () => {
    const { buildReportExport } = EX()
    const exp = buildReportExport(mkReport(), { member: true, at: AT })
    ok(exp, '会员应能拿到导出产物')

    ok(exp.markdown.startsWith('# 张三 · 名人雷达（科技）'), `首行是身份：\n${exp.markdown.split('\n')[0]}`)
    ok(exp.markdown.includes('热度 62/100'), '热度如实写（没有就不写，不填 0）')
    ok(exp.markdown.includes('素材 128 条'), '素材覆盖是「这份报告有多厚」的可核对证据')
    ok(exp.markdown.includes('导出 2026-10-16 14:20'), '导出时刻要写：文件离开 App 后没人知道它是哪一版')
  })

  it('章节名与顺序来自模板真源（不在这里另抄一套标题）', () => {
    const { buildReportExport } = EX()
    const exp = buildReportExport(mkReport(), { member: true, at: AT })
    const md = exp.markdown

    ok(md.includes('## 简介'), '模板节名要原样用（sec-intro → 简介）')
    ok(md.includes('## 人物关系'), '同上')
    ok(md.includes('## 争议与回应'), '同上')
    ok(md.includes('## 附：来源清单（2 条）'), '来源清单是附录：图带不了链接，这是导出相对长图的核心增值')

    /* 顺序：模板里「简介」在「人物关系」之前，导出必须同序（否则下面的目录/核对都对不上） */
    const iIntro = md.indexOf('## 简介')
    const iRel = md.indexOf('## 人物关系')
    const iDyn = md.indexOf('## 近期动态')
    ok(iIntro > -1 && iRel > -1 && iDyn > -1 && iIntro < iRel && iRel < iDyn, '章节顺序必须与模板一致')
  })

  it('每条事实带出处；出处为空时不写「据 」半句', () => {
    const { buildReportExport } = EX()
    const md = buildReportExport(mkReport(), { member: true, at: AT }).markdown

    ok(md.includes('出生地：四川成都（据 新浪娱乐）'), '档案条目带出处')
    ok(md.includes('李四（合作）：合作过三部作品（据 界面新闻）'), '关系条目带出处且用中文标签')
    notOk(md.includes('（据 ）'), '出处为空时不许留下半句话（宁可整句不出现）')
  })

  it('无出处的动态：保留但显式标注「未标出处」（不许静默当成有据事实）', () => {
    const { buildReportExport } = EX()
    const md = buildReportExport(mkReport(), { member: true, at: AT }).markdown

    ok(md.includes('2026-10-05 · 出席发布会（据 每日新闻）'), '有出处的正常写法')
    ok(md.includes('2026-10-03 · 网传调整组织架构（未标出处）'), '无出处的要标出来，而不是删掉或假装有据')
  })

  it('判断类内容显式标注「模型判断」，不与事实混排而不自知', () => {
    const { buildReportExport } = EX()
    const md = buildReportExport(mkReport(), { member: true, at: AT }).markdown

    ok(md.includes('以下为模型判断与归纳（非事实认定）'), 'AI 解读 / 点评 / 会员段前都要有这句')
    ok(md.includes('**结论**：关注度上行'), '判断内容照抄原措辞')
  })

  it('末尾有免责与平台署名（对外授权边界的书面留痕）', () => {
    const { buildReportExport } = EX()
    const md = buildReportExport(mkReport(), { member: true, at: AT }).markdown

    ok(md.includes('公开信息整理'), '卡底说明与长图同源')
    ok(md.includes('非平台定性'), '不许出现「已证实 / 实锤」这类定性措辞')
    ok(md.includes('由「名人雷达」导出'), '要能看出这份文件从哪来')
    notOk(md.includes('已证实'), '合规：不出现定性措辞')
  })

  it('同输入同输出（导出是可复现的交付物，不是随机排版）', () => {
    const { buildReportExport } = EX()
    const a = buildReportExport(mkReport(), { member: true, at: AT })
    const b = buildReportExport(mkReport(), { member: true, at: AT })
    eq(a.markdown, b.markdown)
    eq(a.json, b.json)
    eq(a.fileNameBase, b.fileNameBase)
  })
})

/* ═══════════════════ 2. 不变式：非会员产物里不许有会员段 ═══════════════════ */

describe('结构化导出：会员段的不变式', () => {
  const memberOnly = {
    memberNotes: { compare: '与同领域头部相比，增速靠前', risk: '关注治理结构变化' },
    conflicts: [{ topic: '信源分歧', a: 'A 媒体称已签约', b: 'B 媒体称仍在谈' }],
    peers: [{ name: '王五', gap: '作品量少但增速快' }],
    affiliations: [{ name: '某某科技', kind: '创始人', note: '持股 30%', basis: '天眼查' }],
    glossary: [{ term: 'ARR', explain: '年度经常性收入' }],
    stance: [{ topic: '数据安全', attitude: 'positive', note: '公开支持合规要求' }]
  }

  it('会员产物含会员专享节（档位由模板决定）', () => {
    const { buildReportExport } = EX()
    const md = buildReportExport(mkReport(memberOnly), { member: true, at: AT }).markdown

    ok(md.includes('## 会员专享'), '会员档的节要出现在会员导出里')
    ok(md.includes('## 同领域坐标'), '同上')
    ok(md.includes('## 名词解释'), '同上')
    ok(md.includes('与同领域头部相比，增速靠前'), '会员段的内容确实写进去了')
  })

  it('非会员产物**连 JSON 一起**不含会员段的内容（忘了判会员态就等于送出去）', () => {
    const { buildReportExport } = EX()
    const exp = buildReportExport(mkReport(memberOnly), { member: false, at: AT })

    const all = exp.markdown + '\n' + exp.json
    for (const prose of [
      '与同领域头部相比，增速靠前',
      '关注治理结构变化',
      'A 媒体称已签约',
      '作品量少但增速快',
      '持股 30%',
      '年度经常性收入'
    ]) {
      notOk(all.includes(prose), `非会员产物里出现了会员段内容：「${prose}」`)
    }
    notOk(exp.markdown.includes('## 会员专享'), '非会员的节里不该有会员专享')
    notOk(exp.markdown.includes('## 名词解释'), '非会员的节里不该有名词解释')
  })

  it('非会员产物仍有免费档的节（不变式不能把免费内容也一起删掉）', () => {
    const { buildReportExport } = EX()
    const md = buildReportExport(mkReport(memberOnly), { member: false, at: AT }).markdown

    ok(md.includes('## 简介'), '免费档的节必须还在')
    ok(md.includes('## 争议与回应'), '争议是免费档的内容，不许被 strip 误伤')
    ok(md.includes('连续创业者'), '简介正文还在')
  })

  it('敏感名单命中 → 不出产物（导出是本地判断，离开 App 后没人再拦）', () => {
    const { buildReportExport } = EX()
    const exp = buildReportExport(mkReport({ name: '某敏感词人名' }), { member: true, at: AT })
    /* 名单本身是运营提供的空名单（utils/sensitive.ts），所以这里钉的是「接口行为」而非具体人名 */
    ok(exp === null || typeof exp.markdown === 'string', '敏感判定由 isSensitiveQuery 决定，不抛错')
    eq(buildReportExport(null, { member: true, at: AT }), null, '没有报告 → 不产出')
    eq(buildReportExport(mkReport({ name: '' }), { member: true, at: AT }), null, '没名字 → 不产出')
  })
})

/* ═══════════════════ 3. 分层口径（与既有两条导出先例一致） ═══════════════════ */

describe('结构化导出：分层口径与既有导出先例逐字一致', () => {
  it('canExportReport 是二元口径（不是数值：故不必进 benefits.ts）', () => {
    const { canExportReport } = EX()
    eq(canExportReport(true), true)
    eq(canExportReport(false), false)
    eq(canExportReport(null), false)
    eq(canExportReport(undefined), false)
  })

  it('免费引导语说清「能带走什么」，且不含任何数字（数值真源只在 benefits.ts）', () => {
    const { reportDataExportNote } = EX()
    const note = reportDataExportNote()
    ok(note.includes('会员'), '要说清这是会员能力')
    ok(note.includes('Markdown') && note.includes('JSON'), '要说清能带走的是**什么格式**（这才叫能力，不叫额度）')
    notOk(/\d/.test(note), `引导语不许写数字：${note}`)
  })

  it('两个导出出口的引导语必须不同（长图 vs 数据，带走的东西不一样）', () => {
    const { reportDataExportNote } = EX()
    const cardNote = read('utils/report-card.ts')
    const m = cardNote.match(/export function reportExportNote\(\)[^}]*?return '([^']+)'/)
    ok(m, '读不到长图那句引导语（若函数被改名，本用例要同步改）')
    notOk(m[1] === reportDataExportNote(), '两句引导语相同 ⇒ 用户会以为点哪个都一样')
  })

  it('两种格式都有 label 与一行说明（页面只渲染，不拼文案）', () => {
    const { EXPORT_FORMATS } = EX()
    eq(EXPORT_FORMATS.length, 2, 'Markdown + JSON 两种')
    eq(EXPORT_FORMATS.map((f) => f.kind).sort().join(','), 'json,markdown')
    for (const f of EXPORT_FORMATS) {
      ok(f.label && f.label.length > 0, '每种格式要有 label')
      ok(f.desc && f.desc.length > 8, '每种格式要有一行说明（下载/复制前用户得知道它拿来干什么）')
    }
  })

  it('文件名按格式拼扩展名（同一份产物两种格式，不改内容）', () => {
    const { buildReportExport, exportFileName } = EX()
    const exp = buildReportExport(mkReport(), { member: true, at: AT })
    eq(exportFileName(exp, 'markdown'), '名人雷达_张三_20261016.md')
    eq(exportFileName(exp, 'json'), '名人雷达_张三_20261016.json')
    ok(!exp.fileNameBase.includes('.'), 'fileNameBase 不带扩展名（否则拼接会出错）')
  })
})

/* ═══════════════════ 4. 真源同步（静态，防漂移） ═══════════════════ */

describe('结构化导出：与真源同步（静态断言）', () => {
  it('SECTION_BODY 的键集合 == REPORT_TEMPLATE 的 id 集合（无孤儿键、无漏节）', () => {
    const toc = read('utils/report-toc.ts')
    const exp = read('utils/report-export.ts')

    const ids = new Set([...toc.matchAll(/id: '(sec-[a-z]+)'/g)].map((m) => m[1]))
    ok(ids.size >= 10, `模板里应读到全部节 id，实际 ${ids.size} 个`)

    /* SECTION_BODY 里每个 `'sec-xxx':` 键（后续还有别处出现 sec- 字样，故限定在键位置） */
    const keys = new Set([...exp.matchAll(/^ {2}'(sec-[a-z]+)':/gm)].map((m) => m[1]))
    ok(keys.size >= 10, `导出模块里应读到全部节渲染，实际 ${keys.size} 个`)

    const missing = [...ids].filter((id) => !keys.has(id))
    const orphan = [...keys].filter((id) => !ids.has(id))
    eq(missing.join(','), '', `模板里有节但导出没有渲染函数（新增节时必漏）：${missing}`)
    eq(orphan.join(','), '', `导出里有孤儿键（模板已删的节还在渲染）：${orphan}`)
  })

  it('关系 / 立场的中文标签与报告页逐字一致（两份手抄副本）', () => {
    const exp = read('utils/report-export.ts')
    const page = read('package/report/index.tsx')

    const block = (src, name) => {
      const m = src.match(new RegExp(`const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\}`))
      ok(m, `读不到 ${name}`)
      return m[1]
    }
    /* 平铺映射（RELATION_LABEL / RELATION_META）：key: '中文' */
    const flat = (src, name) =>
      [...block(src, name).matchAll(/(\w+):\s*'([^']+)'/g)].map((x) => `${x[1]}=${x[2]}`).sort().join(',')
    /* 带样式的映射（页面 STANCE_META 是 key: { label, cls }）：只取 label，跳过 cls 那半 */
    const labelOf = (src, name) =>
      [...block(src, name).matchAll(/(\w+):\s*\{\s*label:\s*'([^']+)'/g)]
        .map((x) => `${x[1]}=${x[2]}`)
        .sort()
        .join(',')

    eq(flat(exp, 'RELATION_LABEL'), flat(page, 'RELATION_META'), '关系标签两处不一致（同一份数据会两种叫法）')
    /*
     * 立场：两处的结构不同（导出只要一个中文名，页面还要一个样式类），
     * 故不比对整块，只比对「枚举值 → 中文标签」这一层 —— 这正是会漂移的那一层。
     */
    eq(flat(exp, 'STANCE_LABEL'), labelOf(page, 'STANCE_META'), '立场标签两处不一致')
  })

  it('导出模块不 import 页面 / 不 import 渲染层（数据层不许反向依赖 JSX）', () => {
    const exp = read('utils/report-export.ts')
    const imports = [...exp.matchAll(/^import[^\n]*from '([^']+)'/gm)].map((m) => m[1])
    ok(imports.length > 0, '应当有 import')
    for (const i of imports) {
      notOk(i.includes('package/'), `不许 import 页面模块：${i}`)
      notOk(i.endsWith('.tsx'), `不许 import JSX：${i}`)
    }
  })
})

/* ═══════════════════ 5. 页面接入（静态） ═══════════════════ */

describe('结构化导出：报告页接入', () => {
  const page = () => read('package/report/index.tsx')

  it('报告页有两个并列的导出出口，且各有入口文案', () => {
    const src = page()
    ok(src.includes('导出报告长图'), '长图出口保留（不是被替换）')
    ok(src.includes('导出结构化数据'), '数据出口新增')
    ok(/onClick=\{onExportData\}/.test(src), '数据出口绑到 onExportData')
    ok(/onClick=\{onExportCard\}/.test(src), '长图出口仍绑 onExportCard')
  })

  it('引导语按「点了哪个出口」区分（不是同一个布尔）', () => {
    const src = page()
    ok(/useState<'' \| 'card' \| 'data'>/.test(src), 'exportGuide 要记是哪个出口被点')
    ok(/exportGuide === 'data' \? reportDataExportNote\(\) : reportExportNote\(\)/.test(src), '两句引导语按出口分流')
  })

  it('门的顺序：先组装（敏感名单会返回 null）→ 再看身份 → 最后才选格式', () => {
    const src = page()
    const fn = src.slice(src.indexOf('const onExportData'))
    const iBuild = fn.indexOf('buildReportExport(')
    const iGate = fn.indexOf('canExportReport(')
    const iSheet = fn.indexOf('showActionSheet(')
    ok(iBuild > -1 && iGate > -1 && iSheet > -1, '三步都要在 onExportData 里')
    ok(iBuild < iGate && iGate < iSheet, '免费用户不该先选格式再被拦（那是白点一次）')
    ok(/暂不支持导出数据/.test(fn), '敏感名单 / 无报告时要如实说不支持，不是静默失败')
  })

  it('复制失败走统一的用户文案出口（把原始原因留在 diagLog）', () => {
    const src = page()
    ok(/toUserMessage\(/.test(src), '复制失败要用 utils/error 的 toUserMessage')
  })

  it('导出埋点：两个出口都报「点了 / 被拦了」，复制成功再报「带走了什么格式」', () => {
    const src = page()
    const events = read('utils/events.ts')
    ok(/'report_export'/.test(events) && /'report_exported'/.test(events), '两个事件名要先在 TrackEvent 里声明')

    const card = src.slice(src.indexOf('const onExportCard'), src.indexOf('const copyExport'))
    const data = src.slice(src.indexOf('const onExportData'))

    ok(/track\('report_export', \{ personKey, kind: 'card', allowed \}\)/.test(card), '长图出口要报')
    ok(/track\('report_export', \{ personKey, kind: 'data', allowed \}\)/.test(data), '数据出口要报')

    /*
     * 关键在**顺序**：埋点必须在「判身份」之前 —— 只有被拦的那部分也计进分母，
     * 才算得出「有多少需求正好撞在付费墙上」。放行后才报等于把付费墙的效果抹掉。
     */
    for (const [name, block] of [['长图', card], ['数据', data]]) {
      const iTrack = block.indexOf("track('report_export'")
      const iGate = block.indexOf('if (!allowed)')
      ok(iTrack > -1 && iGate > -1 && iTrack < iGate, `${name}出口：先埋点再看身份（被拦也要报）`)
    }

    ok(
      /track\('report_exported', \{ personKey, kind \}\)/.test(src),
      '「真的复制进剪贴板」要单独报一次（回答带走了哪种格式）'
    )
  })
})

/* ═══════════════════ 6. 权益叙事（S3-1 的另一半：把能力写进权益表） ═══════════════════ */

describe('S3-1：付费点从「额度」转向「能力 / 容量 / 导出」', () => {
  it('会员页权益表里有「导出报告」这一行，且免费栏为「—」', () => {
    const src = read('package/member/index.tsx')
    const m = src.match(/name: '导出报告',\s*free: '([^']+)',\s*member: '([^']+)'/)
    ok(m, '权益表里应有「导出报告」行（导出是已上线能力却长期没进权益表）')
    eq(m[1], '—', '免费栏如实写「—」：免费用户看得到入口，点开只有一行引导')
    ok(m[2].includes('Markdown'), '会员栏要说清能带走什么格式')
  })

  it('权益表把「能力类」排在上半部分、次数类留在下半部分（不靠数字当主卖点）', () => {
    const src = read('package/member/index.tsx')
    const rows = [...src.matchAll(/name: '([^']+)'/g)].map((m) => m[1])
    const iExport = rows.indexOf('导出报告')
    const iGen = rows.indexOf('每日主动生成报告')
    ok(iExport > -1 && iGen > -1, '两行都要在表里')
    ok(iExport < iGen, '「导出报告」要排在「每日主动生成报告」之前（先看买到了什么，再看买到多少个）')
  })

  it('会员权益列表（MEMBER_BENEFIT_POINTS）也补上了导出，且不写数字', () => {
    const src = read('utils/member.ts')
    const block = src.slice(src.indexOf('MEMBER_BENEFIT_POINTS'), src.indexOf('FREE_FEATURES_NOTE'))
    ok(/title: '[^']*导出[^']*'/.test(block), '权益列表里要有导出一条（否则只有对比表有，正文没有）')
    const m = block.match(/title: '([^']*导出[^']*)',\s*\n\s*note: '([^']+)'/)
    ok(m, '导出一条要有标题与说明')
    notOk(/\d/.test(m[2]), `导出说明不许写数字（二元能力，数值真源在 benefits.ts）：${m[2]}`)
  })

  it('免费承诺里写明导出的边界（站内看免费、带走是会员能力）', () => {
    const src = read('utils/member.ts')
    /* ⚠ 它可能是普通字符串字面量，也可能是模板字面量（S3-3 起条数取自 REPORT_PREVIEW） */
    const m = src.match(/FREE_FEATURES_NOTE\s*=\s*\n?\s*[`']([^`']+)[`']/)
    ok(m, '读不到 FREE_FEATURES_NOTE')
    ok(/不限次/.test(m[1]), '免费的口径要保留（站内看不限次）')
    ok(/导出/.test(m[1]) && /会员/.test(m[1]), `要写清导出的边界，否则用户以为报告能随便带走：${m[1]}`)
  })
})
