'use strict'

/**
 * 事件列表页「全部事件 | 我盯的」分段与卡片对齐（2026-10-18）。
 *
 * 现场：两段 tab 比下面的卡片各宽 32rpx，左右都顶到屏幕边，右边一对比露出半格。
 * 根因不是「tab 太宽」，而是它**没有左右外边距**：
 *
 *   · `.card` 自带 `margin: 16rpx 32rpx`（app.scss），列表里的每条事件都是卡片；
 *   · `page-events__scope` 是页面的**直接子元素**，只写了 `margin: 4rpx 0 16rpx`
 *     —— 左右是 0，于是它铺满 100vw。
 *
 * 所以修法是把左右外边距对齐到 `.card` 的那个值，而不是给 tab 换个宽度。
 * 本节刻意**不硬编码 32rpx**：直接拿 `.card` 规则里的真实值来比 ——
 * 将来卡片留白调整（比如整体改 36rpx），这条会跟着红，提醒两边一起改。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')
/* 注释里写的就是「原先 margin 左右是 0」这类反例，不剥会把说明当成实现 */
const codeOf = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PAGE = codeOf(read('package/events/index.tsx'))
const SCSS = codeOf(read('package/events/index.scss'))
const APP_SCSS = codeOf(read('app.scss'))

/** 取某条规则的整段（从选择器到配对的第一个 `}` —— 这几个选择器内都没有嵌套块） */
function ruleOf(src, selector) {
  const at = src.indexOf(selector)
  if (at < 0) return ''
  const end = src.indexOf('}', at)
  return end < 0 ? src.slice(at) : src.slice(at, end + 1)
}

/** 取规则内第一个 margin 的四个方向值（写成 1~4 个值都归一成 [上,右,下,左]） */
function marginOf(rule) {
  const m = rule.match(/margin:\s*([^;]+);/)
  if (!m) return null
  const v = m[1].trim().split(/\s+/)
  if (v.length === 1) return [v[0], v[0], v[0], v[0]]
  if (v.length === 2) return [v[0], v[1], v[0], v[1]]
  if (v.length === 3) return [v[0], v[1], v[2], v[1]]
  return [v[0], v[1], v[2], v[3]]
}

describe('事件列表页：范围分段（全部事件 | 我盯的）必须与卡片同宽对齐', () => {
  const cardMargin = marginOf(ruleOf(APP_SCSS, '.card {'))
  const scopeRule = ruleOf(SCSS, '&__scope {')
  const scopeMargin = marginOf(scopeRule)

  /*
   * 前置三项必须放进 it（2026-10-18 复审 P2）：写在 describe 体里会在**加载期**执行，
   * 既不计入 2164 的统计，一旦失败还会让整个文件 require 抛错、把这一轮汇总一起带走。
   */
  it('前置：对齐参照物齐全（.card 的 margin / __scope 规则 / 分段 margin）', () => {
    ok(cardMargin !== null, '找不到 .card 的 margin（对齐的参照物没了）')
    ok(scopeRule.length > 0, '找不到 __scope 规则')
    ok(scopeMargin !== null, '分段必须有 margin（左右为 0 就会铺满全宽）')
  })

  it('分段左右外边距 = .card 的左右外边距（同一个数，不写死）', () => {
    ok(!!cardMargin && !!scopeMargin, '缺少参照物（见上一条前置用例）')
    if (!cardMargin || !scopeMargin) return
    eq(scopeMargin[1], cardMargin[1], '左右外边距要与卡片一致，否则两段比卡片宽出一格')
    eq(scopeMargin[3], cardMargin[3], '左外边距同样要对齐')
    notOk(scopeMargin[1] === '0' || scopeMargin[1] === '0rpx', '左右为 0 正是本次错位的直接原因')
  })

  it('分段是页面直接子元素 —— 所以这条对齐只能靠 margin，卡片帮不上忙', () => {
    ok(PAGE.includes("className='page-events__scope'"), '找不到分段节点')
    notOk(/className='card page-events__scope'/.test(PAGE), '分段刻意不进卡片（它是列表的范围切换，不是一条内容）')
    /* 上面的 card 头 + 下面的每条事件都是 .card：分段夹在两者中间，宽度必须由自己给 */
    ok(PAGE.includes("className='card page-events__head'"), '正向对照：卡头是 .card（自带左右留白）')
    ok(PAGE.includes("className='card page-events__item'"), '正向对照：每条事件也是 .card')
  })

  it('两段等宽铺满底槽（不是各自按文字撑开）', () => {
    const tabRule = ruleOf(SCSS, '&__scope-tab {')
    ok(/flex:\s*1/.test(tabRule), '两段要等宽，否则「全部事件 12」与「我盯的 3」宽度不一、看着像没对齐')
    ok(/height:\s*60rpx/.test(tabRule), '两段同高，选中态底色才不会一高一低')
  })

  it('padding / border 不额外吃宽度（否则加了对齐也会溢出半格）', () => {
    ok(/box-sizing:\s*border-box/.test(scopeRule), '底槽有 padding 与 border，必须 border-box')
    ok(/padding:\s*6rpx/.test(scopeRule), '正向对照：底槽确实有 padding')
    ok(/border:\s*2rpx/.test(scopeRule), '正向对照：底槽确实有 border')
  })

  it('事件条目的动作行同样不压缩（标记已读 / 跟进 / 查看完整时间线）', () => {
    const actions = ruleOf(SCSS, '&__actions {')
    ok(/flex-wrap:\s*wrap/.test(actions), '三个文字按钮挤不下时折行，不要压断字')
    ok(/white-space:\s*nowrap/.test(ruleOf(SCSS, '&__action {')), '「标记已读」不许被压成两行')
    ok(/white-space:\s*nowrap/.test(ruleOf(SCSS, '&__go {')), '「查看完整时间线 ›」同样不许折字')
  })
})

/*
 * 卡头变形（2026-10-18 用户反馈「事件列表页最上面的卡片变形，新的数、盯的提示、
 * 订阅的对象提示挤在一起」）—— 与舆情页事件卡头是**同一个坑的第二次**：
 * 标题 + 三个 `.count-badge` 塞进 nowrap 的一行，而全局 `.count-badge` 是
 * `white-space: nowrap` + `flex-shrink: 0` + 定高 36rpx（用例 87 钉住），
 * 既不折行也不收缩 ⇒ 超出 `.card` 可排宽度的部分直接顶出卡片。
 * 修法与舆情页一致：卡头纵向分层（一行说是什么，一行说能点什么），第二行 wrap 兜底。
 */
describe('P2：事件列表页卡头分层，长角标不进第一行', () => {
  const between = (src, from, to) => {
    const a = src.indexOf(from)
    if (a < 0) return ''
    const b = src.indexOf(to, a + from.length)
    return b < 0 ? src.slice(a) : src.slice(a, b)
  }

  it('结构：第一行只放标题 + 「新 N 条」，两个长角标下沉到 __head-sub', () => {
    const head = between(PAGE, "className='card page-events__head'", "className='page-events__scope'")
    ok(head.length > 0, '找不到卡头')
    const main = between(head, "className='page-events__head-main'", "className='page-events__head-sub'")
    ok(main.includes("className='count-badge'>新 {newCount} 条"), '第一行要有「新 N 条」（短角标）')
    notOk(main.includes('条有新进展'), '「盯的 N 条有新进展」是长入口，留在第一行必挤爆卡头')
    notOk(main.includes('个对象有新动向'), '「订阅的 N 个对象有新动向」同理')

    const sub = between(head, "className='page-events__head-sub'", "className='page-events__scope'")
    ok(sub.includes('条有新进展'), '第二行要保留「盯的 … ›」入口（它同时是筛选入口）')
    ok(sub.includes('个对象有新动向'), '第二行要保留「订阅的 … 个对象」提示')
  })

  it('第二行缺一个就不渲染（不留空行）', () => {
    ok(
      PAGE.includes('{(followCount > 0 || subFreshCount > 0) && ('),
      '两个提示都为空时整行不该存在，否则卡头下面挂一条空白'
    )
  })

  it('样式：卡头纵向排列，第一行与第二行都允许换行', () => {
    const head = ruleOf(SCSS, '&__head {')
    ok(/flex-direction:\s*column/.test(head), '卡头必须纵向分层（原来 row + space-between 是挤成一行的地方）')
    /* 全局角标不许折行（用例 87），所以每一层自己必须能换行 */
    ok(/flex-wrap:\s*wrap/.test(ruleOf(SCSS, '&__head-main {')), '第一行也要 wrap：超长标题不能把「新 N 条」挤出去')
    const sub = ruleOf(SCSS, '&__head-sub {')
    ok(/flex-wrap:\s*wrap/.test(sub), '第二行必须有 wrap —— 这是长角标唯一的溢出防线')
    ok(/box-sizing:\s*border-box/.test(sub), '整行铺满时 padding / gap 不能再吃出溢出')
  })
})
