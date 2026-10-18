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

  ok(cardMargin !== null, '找不到 .card 的 margin（对齐的参照物没了）')
  ok(scopeRule.length > 0, '找不到 __scope 规则')
  ok(scopeMargin !== null, '分段必须有 margin（左右为 0 就会铺满全宽）')

  it('分段左右外边距 = .card 的左右外边距（同一个数，不写死）', () => {
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
