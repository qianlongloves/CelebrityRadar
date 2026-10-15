'use strict'

/**
 * 获客三件套（P0，2026-10-15）：分享钩子 / 报告长图 / 免责标注。
 *
 * 钉住五件事：
 *   1. **分享标题先给结论钩子**（utils/share.ts#hookOf）：`N 处公开争议` 优先于
 *      `N 条近期动态`，两者都没有才回落可核对的简介首句；钩子是「能点开逐条核对的数量」，
 *      不是对人物的判断，且封顶 99（不给出可被质疑的精确大数）。
 *   2. **报告长图的内容组装是纯函数**（utils/report-card.ts#buildReportCard）：同输入同输出、
 *      不抛错；结论/判断/争议/动态各有条数与字符上限；**动态无来源不进图**（不可追溯）；
 *      人物命中本地敏感名单整张卡不出（返回 null）。
 *   3. **合规**：卡底固定说明含「公开信息整理 / 非平台定性」，且不出现「已证实 / 实锤」
 *      这类会被读成平台定性的措辞；页脚免责与图上说明分工不同但都必须有。
 *   4. **导出是会员权益**：canExportReportCard 二元口径（与周报导出同一分层）；免费用户
 *      只多一行**非弹窗**升级引导，站内看报告仍免费。
 *   5. **小程序码链路不落端上密钥**：码走云函数云调用（cloud.openapi.wxacode.*），
 *      端上只发 page/scene；scene 超 32 字符退回首页而**不截断**（截断的 personKey
 *      会把扫码的人带到错误态）；取码失败一律降级成「微信搜索「名人雷达」」。
 *
 * 纯函数直接 require 编译产物；页面与绘制层是 .tsx / 云函数不进测试编译，与既有用例同法读源码断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const ROOT = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')
const readRoot = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/**
 * 剥掉注释再断言「代码里没有某样东西」。
 *
 * 必要性：share-code.ts 的文件头注释**刻意**解释了「为什么不能自己存 appsecret / access_token」，
 * 不剥注释的裸文本断言会把这段解释当成违规（与 18-user-config.js 的 stripComments 同一手法）。
 */
const codeOf = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

/** 干净加载 utils/report-card */
function RC() {
  env.resetAll()
  return env.load('utils/report-card')
}

/* ---------------------------------- 夹具 ---------------------------------- */

const dyn = (over = {}) => ({
  date: '2026-10-05',
  title: '出席发布会',
  summary: '摘要',
  source: '每日新闻',
  url: 'https://example.com/a',
  ...over
})

const point = (over = {}) => ({ point: '新作定档带动档期关注', basis: '界面新闻', ...over })

const dispute = (over = {}) => ({
  topic: '合约纠纷',
  claim: '2026-09 前经纪公司称合约未到期',
  response: '工作室称已于 8 月解约',
  basis: 'https://example.com/b',
  ...over
})

/** 最小可用报告：只放被 buildReportCard 读到的字段 */
function mkReport(over = {}) {
  return {
    personKey: '张三#tech',
    name: '张三',
    generatedAt: '2026-10-15T09:12:33.000Z',
    heat: 62,
    intro: '连续创业者。更多内容',
    dynamics: [dyn()],
    analysisPoints: [point()],
    controversies: [],
    sources: [{ title: 'a' }, { title: 'b' }],
    ...over
  }
}

/* ───────────────────────── 1. 内容组装（纯函数） ───────────────────────── */

describe('报告长图：内容组装（buildReportCard）', () => {
  it('输入报告 → 输出图上要画的每一行：结论 / 计数 / 生成日与热度', () => {
    const { buildReportCard } = RC()
    const c = buildReportCard(mkReport({ verdict: { summary: '新作拉动关注度', positioning: '头部' } }))

    eq(c.name, '张三')
    eq(c.personKey, '张三#tech')
    eq(c.headline, '新作拉动关注度', '有模型结论时优先用结论，而不是简介')
    eq(c.stats, '1 条动态 · 2 条素材')
    eq(c.meta, '2026-10-15 生成 · 热度 62', '生成日取到天，热度取整')
  })

  it('没有结论时回落简介首句；两者都没有又不带动态 → 不出图（null）', () => {
    const { buildReportCard } = RC()

    eq(buildReportCard(mkReport()).headline, '连续创业者')
    eq(buildReportCard(mkReport({ intro: '', verdict: undefined, dynamics: [] })), null)
  })

  it('争议计数只在真有时出现；热度缺失时不写「热度 0」', () => {
    const { buildReportCard } = RC()

    eq(buildReportCard(mkReport({ controversies: [dispute(), dispute()] })).stats, '1 条动态 · 2 处公开争议 · 2 条素材')
    const c = buildReportCard(mkReport({ heat: 0, sources: [] }))
    eq(c.meta, '2026-10-15 生成')
    eq(c.stats, '1 条动态')
  })

  it('时间取不到天时 meta 只留热度，绝不把整串 ISO 时间画上图', () => {
    const { buildReportCard } = RC()
    const c = buildReportCard(mkReport({ generatedAt: '不是时间' }))
    eq(c.meta, '热度 62')
    notOk(c.meta.includes('T'), '不得出现原始 ISO 串')
  })

  it('判断带自己的出处：`判断（据 媒体名）`；没有出处的判断不进图', () => {
    const { buildReportCard } = RC()

    const c = buildReportCard(mkReport({ analysisPoints: [point(), point({ point: '没有出处的一句判断', basis: '' })] }))
    eq(c.points.length, 2, '两条都进（basis 为空只不写「据 …」，判断本身仍保留）')
    ok(c.points[0].includes('（据 界面新闻）'), `实际：${c.points[0]}`)

    const empty = buildReportCard(mkReport({ analysisPoints: [point({ point: '' })] }))
    eq(empty.points.length, 0, '判断本身为空才整条丢掉')
  })

  it('争议用「争点：说法（回应：…）」并置，只摆说法不摆回应是禁止的写法', () => {
    const { buildReportCard } = RC()
    const c = buildReportCard(mkReport({ controversies: [dispute()] }))

    eq(c.disputes.length, 1)
    ok(c.disputes[0].includes('合约纠纷：'), `实际：${c.disputes[0]}`)
    ok(c.disputes[0].includes('（回应：工作室称已于 8 月解约）'), `实际：${c.disputes[0]}`)

    /* 素材里没有公开回应时不编一句回应，只陈述说法 */
    const noResp = buildReportCard(mkReport({ controversies: [dispute({ response: '' })] }))
    notOk(noResp.disputes[0].includes('回应'), '没有回应就不写「回应」二字')

    const noClaim = buildReportCard(mkReport({ controversies: [dispute({ claim: '' })] }))
    eq(noClaim.disputes.length, 0, '争议内容为空的条目丢掉')
  })

  it('动态一律带「日期 · 标题 · 来源」，无来源的条目不进图', () => {
    const { buildReportCard } = RC()
    const c = buildReportCard(
      mkReport({
        dynamics: [dyn(), dyn({ source: '' }), dyn({ date: '', title: '未标注日期的动态', source: '财经网' })]
      })
    )

    eq(c.dynamics.length, 2, '无来源的那条被丢掉')
    eq(c.dynamics[0], '2026-10-05 · 出席发布会 · 每日新闻')
    eq(c.dynamics[1], '未标注日期的动态 · 财经网', '没有日期就不写前缀，不补一个假日期')
  })

  it('条数上限：判断 3 / 争议 3 / 动态 4（长图第一屏要有重点）', () => {
    const { buildReportCard, CARD_POINT_MAX, CARD_DISPUTE_MAX, CARD_DYNAMIC_MAX } = RC()
    eq(CARD_POINT_MAX, 3)
    eq(CARD_DISPUTE_MAX, 3)
    eq(CARD_DYNAMIC_MAX, 4)

    const many = (n, f) => Array.from({ length: n }, (_, i) => f(i))
    const c = buildReportCard(
      mkReport({
        analysisPoints: many(6, (i) => point({ point: `判断${i}` })),
        controversies: many(5, (i) => dispute({ topic: `争点${i}`, claim: `说法${i}` })),
        dynamics: many(7, (i) => dyn({ title: `动态${i}` }))
      })
    )
    eq(c.points.length, 3)
    eq(c.disputes.length, 3)
    eq(c.dynamics.length, 4)
  })

  it('字符截断：超长文本被裁到上限并补省略号（画布高度是固定栅格，越界会压住下一段）', () => {
    const { buildReportCard } = RC()

    const c = buildReportCard(
      mkReport({
        verdict: { summary: '结'.repeat(120), positioning: '' },
        analysisPoints: [point({ point: '判'.repeat(90) })],
        dynamics: [dyn({ title: '动'.repeat(90), source: '来'.repeat(40) })]
      })
    )

    ok(c.headline.length <= 62, `结论 ${c.headline.length} 字符超出上限`)
    ok(c.headline.endsWith('…'), '被截断的结论要补省略号')
    ok(c.points[0].length <= 60, `判断 ${c.points[0].length} 字符过长`)
    ok(c.dynamics[0].includes('…'), '被截断的动态要补省略号')
  })

  it('确定性：同一份报告两次组装完全一致（无随机、无遍历抖动）', () => {
    const { buildReportCard } = RC()
    const r = mkReport({ controversies: [dispute()], verdict: { summary: '结论', positioning: '' } })
    deepEq(buildReportCard(r), buildReportCard(r))
  })

  it('领域取自 personKey（报告结构里没有 domain 字段）；取不到回落 other', () => {
    const { buildReportCard } = RC()
    eq(buildReportCard(mkReport()).domain, 'tech')
    eq(buildReportCard(mkReport({ personKey: '张三' })).domain, 'other')
  })
})

/* ───────────────────────── 2. 合规红线 ───────────────────────── */

describe('报告长图：合规红线', () => {
  it('null / 空输入：不抛错，返回 null（调用方据此不出图）', () => {
    const { buildReportCard } = RC()
    eq(buildReportCard(null), null)
    eq(buildReportCard(undefined), null)
    eq(buildReportCard(mkReport({ name: '' })), null)
    eq(buildReportCard(mkReport({ name: '   ' })), null)
  })

  it('人物命中本地敏感名单 → 整张卡不出（沿用既有拦截，不放宽）', () => {
    const { buildReportCard } = RC()
    /* 人物名单当前为空名单（运营维护位），关键词级拦截仍有效：带「总统」这种头衔的词必被拦下 */
    eq(buildReportCard(mkReport({ name: '某国总统' })), null)
    ok(buildReportCard(mkReport({ name: '张三' })), '普通人物照常出图')
  })

  it('卡底说明含「公开信息整理 / 非平台定性」，且不出现「已证实 / 实锤」这类措辞', () => {
    const { buildReportCard, reportCardNote } = RC()
    const note = reportCardNote()

    ok(note.includes('公开信息整理'), '要写明来源是公开信息')
    ok(note.includes('非平台定性'), '要写明非平台定性')
    ok(note.includes('可回原报告逐条核对'), '要给出核对路径')
    notOk(/已证实|已确认|实锤|属实/.test(note), `不得出现平台定性措辞：${note}`)

    eq(buildReportCard(mkReport()).note, note, '每张卡都带这句（不是只在某个分支里）')
  })
})

/* ───────────────────────── 3. 免费 / 会员门禁 ───────────────────────── */

describe('报告长图：导出是会员权益（与周报导出同一分层）', () => {
  it('二元口径：免费被拦、会员放行', () => {
    const { canExportReportCard } = RC()
    notOk(canExportReportCard(false), '免费用户不放行导出')
    ok(canExportReportCard(true), '会员放行')
  })

  it('升级引导文案（非弹窗一行）：免费可见、提到会员与开通', () => {
    const { reportExportNote } = RC()
    const note = reportExportNote()
    ok(note.includes('会员'), '引导要提到会员')
    ok(note.includes('开通'), '引导要给出开通路径的暗示')
    ok(note.includes('›'), '沿用既有引导行的「›」写法')
  })
})

/* ───────────────────────── 4. 分享标题的结论钩子 ───────────────────────── */

describe('分享标题：先给结论钩子，再回落可核对的简介', () => {
  const SH = () => {
    env.resetAll()
    return env.load('utils/share')
  }

  it('有公开争议时给「N 处公开争议」（争议优先：动态只是「内容在更新」）', () => {
    const { personShareTitle } = SH()
    const r = mkReport({ controversies: [dispute(), dispute()] })
    eq(personShareTitle('张三', 'tech', r), '张三 · 科技｜2 处公开争议')
  })

  it('没有争议但有动态时给「N 条近期动态」', () => {
    const { personShareTitle } = SH()
    const r = mkReport({ controversies: [], dynamics: [dyn(), dyn(), dyn()] })
    eq(personShareTitle('张三', 'tech', r), '张三 · 科技｜3 条近期动态')
  })

  it('两者都没有 → 回落简介首句（与推荐卡同源，不编造）', () => {
    const { personShareTitle } = SH()
    eq(personShareTitle('张三', 'tech', mkReport({ dynamics: [], controversies: [] })), '张三 · 科技｜连续创业者')
    eq(personShareTitle('张三', 'tech', null), '张三 · 科技')
  })

  it('钩子里只放数量，不放任何对人物的评价（分享标题不是下判断的地方）', () => {
    const { personShareTitle } = SH()
    const t = personShareTitle('张三', 'tech', mkReport({ controversies: [dispute()] }))
    notOk(/不靠谱|争议人物|劣迹|塌房/.test(t), `标题不得含评价：${t}`)
    ok(/^\d/.test(t.split('｜')[1]), '钩子必须以数量开头')
  })

  it('数量封顶 99：不给可被质疑的精确大数', () => {
    const { personShareTitle } = SH()
    const r = mkReport({ controversies: Array.from({ length: 150 }, (_, i) => dispute({ claim: `说法${i}` })) })
    eq(personShareTitle('张三', 'tech', r), '张三 · 科技｜99 处公开争议')
  })

  it('标题长度仍按微信展示裁到 ~24 字（加钩子后同样不越界）', () => {
    const { personShareTitle } = SH()
    const long = '这是一句非常长的简介'.repeat(6)
    const t = personShareTitle('张三', 'tech', mkReport({ intro: long, dynamics: [], controversies: [] }))
    ok(t.length <= 25, `实际 ${t.length}：${t}`)
    ok(t.endsWith('…'), '截断要补省略号')
  })
})

/* ───────────────────────── 5. 小程序码的目标（纯函数） ───────────────────────── */

describe('分享图小程序码：码目标（page + scene）', () => {
  const SC = () => {
    env.resetAll()
    return env.load('utils/share-code')
  }

  it('报告卡 / 名言卡的码指向此人报告页，scene = 编码后的 personKey', () => {
    const { reportCodeTarget } = SC()
    const t = reportCodeTarget('张三#tech')
    eq(t.page, 'package/report/index')
    eq(t.scene, encodeURIComponent('张三#tech'))
    ok(t.page.indexOf('/') !== 0, '页面路径不带前导斜杠（微信接口只要这个形态）')
  })

  it('personKey 编不完 / 为空 → 退回首页而不是给一个落错人的码', () => {
    const { reportCodeTarget } = SC()
    eq(reportCodeTarget('').page, 'pages/index/index')
    eq(reportCodeTarget('   ').page, 'pages/index/index')

    const longKey = `${'超长名字'.repeat(6)}#tech`
    ok(encodeURIComponent(longKey).length > 32, '夹具前提：编码后确实超过 32 字符')
    const t = reportCodeTarget(longKey)
    eq(t.page, 'pages/index/index')
    eq(t.scene, undefined, '不回一个被截断的 personKey（那会把扫码的人带到错误态）')
  })

  it('周报这类「不属于某个人」的图：码落在页面本身，不带 scene', () => {
    const { pageCodeTarget } = SC()
    const t = pageCodeTarget('/package/weekly/index')
    eq(t.page, 'package/weekly/index')
    eq(t.scene, undefined)
    eq(pageCodeTarget('').page, 'pages/index/index')
  })

  it('端上不落任何密钥：码由云函数生成，端上只发 page/scene', () => {
    const src = read('utils/share-code.ts')
    ok(src.includes("callCloudFunction('wxacode'"), '码必须走云函数')
    notOk(/appsecret|access_token|API_KEY|secret/i.test(codeOf(src)), '端上代码里不得出现任何密钥字样（说明性注释不算）')
    ok(src.includes('getTempFileUrl('), 'cloud:// 要先换临时链接才能喂给 canvas')
  })
})

/* ───────────────────────── 6. 页面与绘制层（静态钉住） ───────────────────────── */

describe('报告页：导出入口 / 非弹窗引导 / 长图弹层（静态约束）', () => {
  const page = read('package/report/index.tsx')
  const scss = read('package/report/index.scss')
  const at = page.indexOf('const onExportCard')

  it('导出入口对所有用户可见，点击才分层', () => {
    ok(page.includes('导出报告长图'), '缺导出入口')
    ok(page.includes('onExportCard'), '导出入口要有处理函数')
    ok(page.includes('buildReportCard('), '内容组装走 utils/report-card')
    ok(page.includes('这份报告暂不支持导出图片'), '脏报告给明确提示（不白屏、不出空壳图）')
  })

  it('三道门的顺序不可换：先组装（可能被敏感名单拦掉）→ 再判身份 → 才出图', () => {
    const build = at + page.slice(at).indexOf('buildReportCard(')
    const gate = at + page.slice(at).indexOf('canExportReportCard(')
    const open = at + page.slice(at).indexOf('setPosterCard(')
    ok(build < gate, '组装必须早于身份判定（敏感人物连入口都不该往下走）')
    ok(gate < open, '身份判定必须早于开面板')
  })

  it('免费引导是**非弹窗**：就地一行 + 跳会员页，不用 showModal', () => {
    ok(page.includes('page-report__export-guide'), '缺引导行样式钩子')
    ok(page.includes('reportExportNote('), '引导文案取自 utils/report-card（不页面内写死）')
    ok(page.includes("'/package/member/index'"), '引导行点了要能进会员页')
    ok(scss.includes('&__export-guide'), '引导行样式缺失')
    notOk(page.slice(at, at + 900).includes('showModal'), '免费拦截不得用弹窗')
  })

  it('长图弹层复用 share-poster，并把同一份内容交给它（复制摘要与图同源）', () => {
    ok(page.includes("from '@/components/share-poster'"), '复用既有弹层组件')
    ok(page.includes('renderReportPoster('), '用报告长图的绘制函数出图')
    ok(page.includes('reportCardHeight('), '画布高度随内容条数算')
    ok(page.includes('copyText='), '复制摘要与图同源')
    ok(/posterCard && \(/.test(page), '弹层只在需要时挂载（避免平白请求一次小程序码）')
  })

  it('扫码进来的 scene 与 personKey 合并成同一个来源（其余逻辑一行不改）', () => {
    ok(page.includes('router.params.scene'), '报告页要读 scene')
    ok(/router\.params\.personKey[^\n]*\|\|[^\n]*sceneKey/.test(page), 'personKey 缺失时用 scene 兜底')
  })
})

describe('绘制层：报告长图 / 页脚小程序码 / 长图降倍率（静态约束）', () => {
  const sc = read('utils/share-card.ts')

  it('报告长图复用同一条绘制管线（离屏 canvas + dpr 缩放 + canvasToTempFilePath）', () => {
    ok(sc.includes('export function renderReportPoster'), '缺报告长图出图入口')
    ok(sc.includes('export function paintReportCard'), '缺报告长图绘制')
    ok(sc.includes('export function reportCardHeight'), '缺高度计算（空块不占位）')
    ok(sc.includes('return renderPoster('), '必须复用 renderPoster')
  })

  it('长图按物理高度反算倍率：宁可略微不锐，不能导不出来', () => {
    ok(sc.includes('MAX_PHYSICAL_H'), '缺物理高度上限')
    ok(/MAX_PHYSICAL_H \/ Math\.max\(1, height\)/.test(sc), '倍率要按目标高度反算')
    ok(sc.includes('Math.max(1,'), '最低 1 倍，不再往下压')
  })

  it('页脚：免责 + 应用名 + 小程序码；取不到码降级成「微信搜索「名人雷达」」', () => {
    ok(sc.includes('const FOOT_H = 96'), '页脚要容下三行文案 + 码')
    ok(sc.includes("const DISCLAIMER = '基于公开信息 AI 整理，仅供参考'"), '免责口径统一为「基于公开信息」')
    ok(sc.includes('微信搜索「名人雷达」'), '取不到码时的文字引导缺失')
    ok(sc.includes('扫码看完整报告'), '有码时的引导缺失')
    ok(sc.includes('ctx.drawImage(code'), '码要真的画进 canvas')
    ok(sc.includes('canvas.createImage'), '码图必须先解码才能 drawImage')
  })

  it('取码失败不阻断出图：超时兜底 + catch 后回落无码', () => {
    ok(sc.includes('setTimeout(() => resolve(false), 3000)'), '缺 3 秒超时兜底（真机见过不触发回调）')
    ok(/loadCodeImage/.test(sc) && /return loaded \? img : undefined/.test(sc), '失败必须返回 undefined 而不是抛错')
  })

  it('三张图都给码：名言卡指向此人报告、周报卡指向周报页、报告卡指向此人报告', () => {
    ok(sc.includes('reportCodeTarget(data.personKey'), '名言卡的码要带 personKey')
    ok(sc.includes("pageCodeTarget('package/weekly/index')"), '周报卡的码落在周报页')
    ok(sc.includes('reportCodeTarget(card.personKey)'), '报告卡的码落在此人报告页')
  })
})

/* ───────────────────────── 7. 云函数与部署登记（静态钉住） ───────────────────────── */

describe('wxacode 云函数：云调用出码 + 白名单 + 无密钥（静态约束）', () => {
  const fn = readRoot('cloudfunctions/wxacode/index.js')
  const cfg = JSON.parse(readRoot('cloudfunctions/wxacode/config.json'))
  const rc = JSON.parse(readRoot('cloudbaserc.json'))

  it('走云调用（cloud.openapi.wxacode.*）：函数内不出现任何 appsecret', () => {
    ok(fn.includes('cloud.openapi.wxacode.getUnlimited'), '缺 getUnlimited（带 scene 时用）')
    ok(fn.includes('cloud.openapi.wxacode.get'), '缺 get（scene 为空时用，getUnlimited 的 scene 是必填）')
    notOk(/appsecret|access_token/i.test(codeOf(fn)), '云函数里也不该自己管 token（云调用免密钥的意义；说明性注释不算）')
  })

  it('config.json 声明 openapi 权限：不声明就是 -601xxx 权限错误', () => {
    deepEq(cfg.permissions.openapi, ['wxacode.getUnlimited', 'wxacode.get'])
  })

  it('页面白名单：不设白名单等于给别人一个任意页面码生成器（配额算我们头上）', () => {
    ok(fn.includes('ALLOWED_PAGES'), '缺白名单')
    ok(fn.includes("'package/report/index'"), '报告页必须在白名单里')
    ok(fn.includes("'package/weekly/index'"), '周报页必须在白名单里')
    ok(fn.includes('ALLOWED_PAGES.indexOf(page) < 0'), '白名单要真的生效')
  })

  it('scene 超长直接拒绝（端上已先截断过，走到这里说明调用方不对）', () => {
    ok(fn.includes('SCENE_MAX = 32'), '缺 scene 长度上限')
    ok(fn.includes('scene.length > SCENE_MAX'), '缺超长校验')
  })

  it('同一目标落固定 cloudPath（覆盖写、fileID 稳定），端上才能长期缓存 fileID', () => {
    ok(fn.includes('uploadFile({ cloudPath'), '缺上传')
    ok(fn.includes('shortHash(scene)'), 'scene 要收敛成短码再进路径（以免含 % / 括号等字符）')
  })

  it('失败只回人话，技术原文进云函数日志', () => {
    ok(fn.includes('console.error'), '原文进日志')
    ok(fn.includes('小程序码暂时不可用，请稍后重试。'), '回端上的必须是一句话文案')
    notOk(/errMsg: err/.test(fn), '不得把上游原始 errMsg 回给端上')
  })

  it('部署登记：cloudbaserc.json 里有 wxacode（否则 tcb 部署不到）', () => {
    const names = (rc.functions || []).map((f) => f.name)
    ok(names.includes('wxacode'), `函数清单里缺 wxacode：${names.join(', ')}`)
  })
})

describe('分享弹层：免责口径与错误文案（静态约束）', () => {
  const sp = read('components/share-poster/index.tsx')

  it('默认提示写明「基于公开信息」与「小程序码」', () => {
    ok(sp.includes('基于公开信息 AI 整理，仅供参考'), '弹层提示要与图上免责口径一致')
    ok(sp.includes('小程序码'), '要让用户知道图上带码')
  })

  it('名言卡的码要带上 personKey；出图失败给人话（原文只进 diagLog）', () => {
    ok(sp.includes('renderQuotePoster({ ...quote, personKey })'), '名言卡的码要指向这个人的报告')
    ok(sp.includes('toUserMessage('), '失败文案走统一出口')
  })
})
