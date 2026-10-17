'use strict'

/**
 * 报告页两处体验修正（2026-10-16，用户反馈）：
 *
 *   ①「保存长图」必须是**弹框**，而不是「在页面下方突出一段长图」；
 *   ②「收藏 / 刷新 / 导出长图 / 导出结构化数据」收进首屏那张「向 AI 提问」卡，
 *     问答入口本身改成**图标按钮**。
 *
 * ①的成因不是布局细节，是一条**特异性**：`share-poster` 只写了
 * `.share-poster { position: fixed; z-index: 1000 }`（(0,1,0)），而它宿主页的根容器都带
 * `.glow-page`，app.scss 里 `.glow-page > view { position: relative; z-index: 1 }` 是 (0,1,1) ——
 * 组件那条被**整条盖掉**，于是「全屏浮层」被按回文档流，长图直接摊在页面最下方。
 * 这个坑本项目踩过一次并已备好出口（app.scss 的 `> .glow-overlay`，report-refreshing /
 * 收藏页编辑态 / 动态页浮层都在用），只是 share-poster 当时没挂 —— 故本用例的第一条
 * 就是钉住那个类名：**它掉了，症状不是样式错位，而是弹层彻底失效**。
 *
 * ②的两个判断：a) 五个动作原本散在页面首尾两端（首屏只有问答，另四个要滚到底），
 * 故钉「四个入口都落在卡内」且「卡外不许有第二套」；b) 两个导出是会员权益，
 * 收成图标按钮后必须仍有可辨识的权益标记 —— 钉住「会员」角标与卡尾那一行说明，
 * 否则用户会以为点哪个都一样（原两块导出区的两行说明就是为这个存在的）。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(p, 'utf8')

/** 剥注释：本页 / 本样式里大量「原先是什么、为什么改」的说明会被静态断言当成现状（如 70/74 同理） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 取某条选择器的完整规则体（含嵌套，故不能用 `[^}]*` 那种偷懒写法） */
function ruleBody(scss, selector) {
  const at = scss.indexOf(selector)
  if (at < 0) return ''
  const open = scss.indexOf('{', at)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < scss.length; i++) {
    if (scss[i] === '{') depth += 1
    else if (scss[i] === '}') {
      depth -= 1
      if (depth === 0) return scss.slice(open + 1, i)
    }
  }
  return ''
}

const POSTER = stripComments(read(path.join(SRC, 'components', 'share-poster', 'index.tsx')))
const POSTER_SCSS = stripComments(read(path.join(SRC, 'components', 'share-poster', 'index.scss')))
const PAGE = stripComments(read(path.join(SRC, 'package', 'report', 'index.tsx')))
const PAGE_SCSS = stripComments(read(path.join(SRC, 'package', 'report', 'index.scss')))
const APP_SCSS = read(path.join(SRC, 'app.scss'))

/* ═══════════════ ① 保存长图：必须是弹框 ═══════════════ */

describe('保存长图是弹框，不是页面下方的一段长图', () => {
  it('⚠ 根节点挂了 `glow-overlay`（掉了不是样式错位，是弹层彻底失效）', () => {
    ok(/<View className='share-poster glow-overlay'>/.test(POSTER), '只写 share-poster 会被 .glow-page > view 整条盖掉')
  })

  it('对照：app.scss 的出口规则仍在，且 position/z-index 都是给死的（不是只放开 position）', () => {
    const body = ruleBody(APP_SCSS, '> .glow-overlay')
    ok(body, 'app.scss 里的 `> .glow-overlay` 出口不见了')
    ok(/position:\s*fixed/.test(body), '必须给死 position')
    ok(/z-index:\s*1200/.test(body), 'z-index 也得给死，否则组件自己的值仍被 `> view` 压成 1')
  })

  it('对照：把它按回文档流的那条 `> view` 规则还在（说明上面不是空谈）', () => {
    const body = ruleBody(APP_SCSS, '> view')
    ok(/position:\s*relative/.test(body) && /z-index:\s*1/.test(body))
  })

  it('z-index 压得过底部 tab 栏（999），否则弹框会被 tab 栏切一刀', () => {
    const z = Number((ruleBody(APP_SCSS, '> .glow-overlay').match(/z-index:\s*(\d+)/) || [])[1])
    ok(z > 999, `现在是 ${z}`)
  })

  it('遮罩挂了 `catchMove`：弹框上滑动不该把底下的报告页一起滚走', () => {
    ok(/className='share-poster__mask'\s+catchMove/.test(POSTER))
  })

  it('⚠ 预览可滚动（长图要能逐段看完，不能只给最上面一截）', () => {
    ok(/\bScrollView\b/.test(POSTER), 'ScrollView 要真的 import 进来')
    ok(/<ScrollView className='share-poster__scroll' scrollY>/.test(POSTER))
  })

  it('⚠ 预览图不再限高（再限高就又被裁成一段）', () => {
    const body = ruleBody(POSTER_SCSS, '&__preview')
    ok(body, '找不到 &__preview 规则')
    notOk(/max-height/.test(body), '限高 + 父级 overflow 裁剪正是「只看到一段」的来源')
    ok(/width:\s*100%/.test(body))
  })

  it('滚动视口的高度是**确定值**（ScrollView 不给高度就不滚，max-height 不建立视口）', () => {
    const body = ruleBody(POSTER_SCSS, '&__scroll')
    ok(body, '找不到 &__scroll 规则')
    ok(/height:\s*\d+(\.\d+)?vh/.test(body), '要给 vh 这类确定高度，不能只给 max-height')
  })

  it('stage 不再用 overflow:hidden 硬裁（那正是「只看到一段」的另一半）', () => {
    const body = ruleBody(POSTER_SCSS, '&__stage')
    ok(body, '找不到 &__stage 规则')
    notOk(/overflow:\s*hidden/.test(body))
  })

  it('loading / error 两态的居中样式没被顺手删掉（滚动只接管出图成功那一路）', () => {
    ok(ruleBody(POSTER_SCSS, '&__stage') !== '', 'stage 是两态共用的居中容器')
    ok(/share-poster__error/.test(POSTER) && /share-poster__loading/.test(POSTER))
  })
})

/* ═══════════════ ② 首屏工具卡 ═══════════════ */

describe('首屏工具卡：五个动作收拢到一处', () => {
  const toolsAt = PAGE.indexOf("className='page-report__tools'")

  it('卡存在，且仍随报告一起出现（没有报告时不渲染半张空卡）', () => {
    ok(toolsAt > 0, '找不到 page-report__tools')
    ok(PAGE.includes('{report && ('))
  })

  it('⚠「向 AI 提问」是图标按钮（不再是占一整行的描边条）', () => {
    ok(PAGE.includes("className='page-report__tools-ask-icon'"), '图标按钮本体不见了')
    ok(PAGE.includes("className='page-report__tools-ask-title'"))
    ok(PAGE.includes("className='page-report__tools-ask-arrow'"))
  })

  it('入口换了形状，目的地没换：仍跳 /package/qa/index', () => {
    ok(PAGE.includes('/package/qa/index?personKey='))
    ok(PAGE.includes('encodeURIComponent(personKey)'))
  })

  it('⚠ 两个额度池的名字都还在文案里（2026-10-12 修掉的歧义不许回退）', () => {
    ok(PAGE.includes('只计「每日提问次数」，不占「报告生成次数」'))
  })

  it('四个工具各自**恰好一个**入口，且都在卡内（不许卡里卡外两套并存）', () => {
    const countOf = (needle) => PAGE.split(needle).length - 1
    ok(countOf('onClick={() => void toggleReportFav()}') === 1, '收藏')
    ok(countOf('onClick={onExportCard}') === 1, '导出长图')
    ok(countOf('onClick={onExportData}') === 1, '导出数据')
    /*
     * 刷新只剩一个入口：首屏工具卡（2026-10-17 用户反馈「查看最新」与「刷新」功能重复）。
     * 此前时间行整行可点、行尾还挂一个「查看最新」，与卡里这颗是同一个动作的两个入口；
     * 现在时间行只报时间，**不许再把热区加回去** —— 方向反过来了，多一处就算回退。
     */
    ok(countOf('onClick={() => void requestRefresh()}') === 1, '刷新（只许工具卡这一处）')
    ok(PAGE.lastIndexOf('onClick={() => void requestRefresh()}') > toolsAt, '卡里那颗刷新不见了')
    notOk(PAGE.includes("className='page-report__refresh-link'"), '「查看最新」内联链接不许回来')
  })

  it('四个工具的 onClick 都排在卡之后（不是留在页脚的旧块里凑数）', () => {
    const after = (needle) => PAGE.lastIndexOf(needle) > toolsAt
    ok(after('onClick={() => void toggleReportFav()}'))
    ok(after('onClick={onExportCard}'))
    ok(after('onClick={onExportData}'))
  })

  it('⚠ 两个导出带「会员」角标，且只在非会员时出现', () => {
    const tags = PAGE.match(/!member && <Text className='page-report__tool-vip'>会员<\/Text>/g) || []
    ok(tags.length === 2, `期望长图 / 数据各一枚，实际 ${tags.length} 枚`)
  })

  it('会员门禁一行没动：两个导出仍各自过自己的门', () => {
    ok(PAGE.includes('canExportReportCard('), '长图的门禁')
    ok(PAGE.includes('buildReportExport(state.report, { member })'), '数据的门禁')
  })

  it('卡尾一行小字说清两个导出各给什么（原两块导出区的那两行说明没丢）', () => {
    ok(PAGE.includes("className='page-report__tools-note'"))
    ok(/长图带结论、依据与出处/.test(PAGE))
    ok(/Markdown 全文（每条带出处）\+ JSON/.test(PAGE))
  })

  it('免费用户点过导出后的升级引导仍在（口径没变，只换了落点）', () => {
    ok(PAGE.includes("className='page-report__export-guide'"))
    ok(PAGE.includes("onPromoTap('report_export')"))
    ok(PAGE.includes('reportDataExportNote()') && PAGE.includes('reportExportNote()'), '两个出口的引导语各不相同')
  })

  it('引导行落在卡内（贴着触发它的那颗按钮，不再隔着一整个页脚）', () => {
    ok(PAGE.lastIndexOf("className='page-report__export-guide'") > toolsAt)
  })

  it('对照：「与另一位名人对比」那条跳转入口没被顺带拆掉', () => {
    ok(PAGE.includes('page-report__compare'))
    ok(/&__compare\s*\{/.test(PAGE_SCSS) && /&__compare-arrow\s*\{/.test(PAGE_SCSS))
  })
})

/* ═══════════════ ③ 旧的散落入口必须整块消失 ═══════════════ */

describe('页脚的旧入口已彻底移走（不许与新卡并存）', () => {
  it('⚠ tsx 里没有 page-report__foot-actions / page-report__ask / __export 大块', () => {
    notOk(PAGE.includes('page-report__foot-actions'))
    notOk(PAGE.includes('page-report__ask'), '（`page-report__tools-ask` 不含这个子串，不会被误伤）')
    notOk(PAGE.includes('page-report__export-title'))
    notOk(PAGE.includes('page-report__export-sub'))
  })

  it('⚠ scss 里的旧规则也删干净了（留着就是两套规则互相打架）', () => {
    notOk(/&__ask\s*\{/.test(PAGE_SCSS))
    notOk(/&__ask--hero/.test(PAGE_SCSS))
    notOk(/&__foot-actions/.test(PAGE_SCSS))
    notOk(/&__export\s*\{/.test(PAGE_SCSS), '只该剩 &__export-guide')
    notOk(/&__export-title/.test(PAGE_SCSS))
    notOk(/&__export-sub/.test(PAGE_SCSS))
  })

  it('保留了 &__export-guide（用例 45 依赖它，且它确实还在用）', () => {
    ok(/&__export-guide\s*\{/.test(PAGE_SCSS))
  })

  it('新卡的类名在 scss 里齐备（渲染结构改了、样式没跟上是常态漏项）', () => {
    const names = [
      '&__tools {',
      '&__tools-ask {',
      '&__tools-ask-icon {',
      '&__tools-ask-main {',
      '&__tools-ask-title {',
      '&__tools-ask-desc {',
      '&__tools-ask-arrow {',
      '&__tools-row {',
      '&__tool {',
      '&__tool-icon {',
      '&__tool-label {',
      '&__tool-vip {',
      '&__tools-note {'
    ]
    for (const n of names) ok(PAGE_SCSS.includes(n), `缺少 ${n}`)
  })

  it('卡片自身不再用末位元素选择器硬凑间距（引导行的落点改由 &__tools 内的覆盖承担）', () => {
    ok(/\.page-report__export-guide\s*\{/.test(ruleBody(PAGE_SCSS, '&__tools {')), '卡内要有一条引导行间距的覆盖')
  })

  it('报告页不再引 taro-ui 的 button（页脚那两个 AtButton 换掉后它就是死引入）', () => {
    notOk(PAGE.includes('taro-ui/dist/components/button'))
  })
})
