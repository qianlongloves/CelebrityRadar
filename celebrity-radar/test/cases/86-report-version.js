'use strict'

/**
 * 报告版本号 + 「盯这条进展」的提交中反馈（2026-10-18）。
 *
 * 两件事同属「这一页读起来有没有底」：
 *   ① 版本号：用户要能说出「我读的是哪一版」。实现上**不新增字段**，而是由 `generatedAt`
 *      派生（`utils/time.ts#reportVersion`）—— 报告已经有权威生成时间，再造一个编号就得在
 *      每条生成路径上同步维护，漏一处就出现「这份报告没有版本号」。
 *   ② 反馈：点「盯这条进展」到「已盯上」之间要过订阅授权弹窗、一次读库去重、一次写库，
 *      原先这段时间按钮毫无变化，用户会以为没点上而反复点。
 *
 * 版本号的日期段**必须按 UTC+8**：同一份报告在哪台手机上都该是同一个版本号，
 * 否则用户互相对照时对不上（P2-36 已经在设备时区上吃过一次亏）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 注释里会写反例（如「不能写成 vInvalid」），不剥会把说明当成真实实现 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')

describe('报告版本号：由 generatedAt 派生（纯函数）', () => {
  const { reportVersion } = env.load('utils/time')

  it('形如 v2026.10.18 —— 带日期、只到日', () => {
    eq(reportVersion('2026-10-18T10:00:00.000Z'), 'v2026.10.18')
    ok(/^v\d{4}\.\d{2}\.\d{2}$/.test(reportVersion('2026-01-05T00:00:00.000Z')), '月份、日必须补零')
  })

  it('日期段按 UTC+8 算 —— 同一份报告在任何手机上版本号一致', () => {
    /* 2026-10-18T17:30Z = UTC+8 的 10-19 01:30（跨日那一侧） */
    eq(reportVersion('2026-10-18T17:30:00.000Z'), 'v2026.10.19')
    /* 正向对照：只差两小时、仍在同一天 —— 证明上一条不是「整体加一天」 */
    eq(reportVersion('2026-10-18T15:30:00.000Z'), 'v2026.10.18')
  })

  it('拿不到时间就不给版本号（老报告没有 generatedAt，不写 vInvalid 冒充）', () => {
    eq(reportVersion(''), '')
    eq(reportVersion(undefined), '')
    eq(reportVersion(null), '')
    /* 造一个真正不可解析的值：'2026-10-9 10:00' 在 V8 里是能解析的，不能当负例 */
    eq(reportVersion('待定'), '')
  })
})

describe('报告页：版本号进目录标题、盯进展有点击反馈', () => {
  const page = stripComments(read('package/report/index.tsx'))
  const scss = read('package/report/index.scss')

  it('目录卡标题显示版本号，且派生自这份报告的生成时间', () => {
    ok(page.includes('reportVersion(report?.generatedAt)'), '版本号必须由 generatedAt 派生，不新造字段')
    ok(page.includes('page-report__toc-ver'), '目录标题要渲染版本号')
    ok(page.includes('{reportVer &&'), '解析不出时间时整段不显示（不能印一个空版本号）')
    ok(page.includes('目录 · ${tocSections.length} 节'), '原有的「目录 · N 节」不能丢')
    ok(scss.includes('&__toc-ver'), '缺版本号样式（只加类名不写样式最难发现）')
  })

  it('「盯这条进展」点击后进入提交中态：转圈 + 文案，且不再可点', () => {
    ok(page.includes('page-report__watch--busy'), '缺提交中态')
    ok(/watchBusy === topic/.test(page), '只把被点的那一条置忙，其余条目照常可点')
    ok(page.includes('正在添加'), '提交中要有文字，不能只有一个圈')
    ok(scss.includes('@keyframes report-watch-spin'), '缺转圈动画')
    ok(scss.includes('&__watch-spin'), '缺转圈元素样式')
    /* 仍保留原有两种按钮态的文字（用例 53 的入口断言依赖「盯这条进展」这句） */
    ok(page.includes('盯这条进展'), '原有入口文案不能丢')
    ok(page.includes('已盯进展'), '已盯态不能丢')
  })

  it('置忙排在订阅授权之前 —— 否则授权弹窗那几秒按了没反应', () => {
    /*
     * 必须把范围**限定在 onToggleWatchTopic 函数体内**再比顺序：
     * 本页还有「监控此人」（onToggleMonitor）也调 requestAlertNotify，它在文件里排在前面，
     * 直接对整页 indexOf 会拿到那一处的下标，断言看起来通过、实际什么都没钉住。
     */
    const fnAt = page.indexOf('const onToggleWatchTopic')
    ok(fnAt > 0, '找不到 onToggleWatchTopic')
    const fn = page.slice(fnAt, page.indexOf('useEffect', fnAt))

    const atBusy = fn.indexOf('setWatchBusy(keyword)')
    const atAuth = fn.indexOf('await requestAlertNotify()')
    const atAdd = fn.indexOf('await addWatch(')
    const atClear = fn.indexOf('setWatchBusy(null)')
    ok(atBusy > 0, '缺置忙')
    ok(atAuth > atBusy, 'setWatchBusy 必须早于 requestAlertNotify（setState 不是 await，不破坏微信约束）')
    ok(atAdd > atAuth, '写库仍在授权之后（微信只认点击后第一个订阅授权调用）')
    /* 复位必须紧跟在写库之后、且在按结果分支之前，否则失败分支会把按钮永远留在加载态 */
    ok(atClear > atAdd, '写完库必须复位 busy')
    ok(fn.indexOf('if (res.ok)') > atClear, '复位要排在读结果之前，否则失败分支会把按钮留在加载态')
  })
})
