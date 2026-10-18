'use strict'

/**
 * 舆情页事件卡卡头重排（2026-10-18）。
 *
 * 现场：卡头一行塞了四件东西 —— 标题「🧩 事件时间线」、`新 N 条` 角标、
 * `盯的 N 条有新进展 ›`、右侧两个文字按钮（`我盯的 ›` / `查看全部 ›`）。总宽超过
 * 690rpx 的可排宽度，而 `__head-main` 是 nowrap 的 flex：flex 只会**压窄**子元素、
 * 不会换行，于是最长的那个角标里的字被压成两行，`.count-badge` 又是 36rpx 定高，
 * 两行字直接溢出圆底 —— 用户看到的是「换行、变形」。
 *
 * 修法是**分层**而不是缩字号：第一行只说「这是什么」（标题 + 一个角标 + 查看全部），
 * 第二行说「能点什么」（两个带数字的入口），并给第二行 `flex-wrap` 兜底。
 * 两个入口改成语义图标胶囊（★ 我盯的 N / ● 盯的 N 条有新进展），比纯文字省一半宽度。
 *
 * 约束：`page-opinion__more` / `page-opinion__mine` / `page-opinion__follow-jump`
 * 三个类名被 25 / 36 / 38 / 39 几条用例钉住（含「全页只剩一处 __more」的形态锁），
 * 本节只钉**排版位置**，不改名、不改跳转目标。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')
/* 注释里会写「原先挤在一行」「别把 follow-jump 塞回 head」这类反例，不剥会把说明当实现 */
const codeOf = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const PAGE = codeOf(read('pages/opinion/index.tsx'))
const SCSS = codeOf(read('pages/opinion/index.scss'))
const APP_SCSS = codeOf(read('app.scss'))

/** 取某段 JSX 的源码切片（从 `start` 起到 `stop` 之前） */
function between(src, start, stop) {
  const a = src.indexOf(start)
  if (a < 0) return ''
  const b = src.indexOf(stop, a + start.length)
  return b < 0 ? src.slice(a) : src.slice(a, b)
}

describe('事件卡卡头：一行只留「标题 + 一个角标」，长入口下沉到第二行', () => {
  /* ⚠ `page-opinion__head` 是**四张卡共用**的类名（冷启动卡 / 简报卡 / 今日要点 / 事件卡），
     直接对整页取下标会拿到第一张卡的头，断言看起来通过、其实什么都没钉住。
     所以先切出事件卡这一块，再在块内比顺序。 */
  const atEvents = PAGE.indexOf("className='card page-opinion__events'")
  ok(atEvents > 0, '找不到事件卡')
  const atTail = PAGE.indexOf('把多条报道归到同一件事', atEvents)
  const card = atTail > atEvents ? PAGE.slice(atEvents, atTail) : PAGE.slice(atEvents)

  const headAt = card.indexOf("className='page-opinion__head'")
  const atSub = card.indexOf("className='page-opinion__head-sub'")
  ok(headAt > 0, '事件卡内找不到卡头')
  ok(atSub > headAt, '第二行要排在卡头之后')

  /* 顺序：事件卡 → 卡头 → 第二行 → 事件列表。第二行必须真的在卡内、且在列表之前，
     否则它会被渲染到卡片外面（这类结构错误在真机上才看得出来）。 */
  ok(card.indexOf('eventPreview.rows.map') > atSub, '第二行要排在事件列表之前')

  it('第一行只剩标题与「新 N 条」，不再塞「盯的 N 条有新进展」', () => {
    const head = between(card, "className='page-opinion__head'", "className='page-opinion__head-sub'")
    ok(head.includes('page-opinion__head-title'), '第一行要有标题')
    ok(head.includes("<Text className='count-badge'>新 {eventNew} 条</Text>"), '第一行要有「新 N 条」角标')
    notOk(head.includes('page-opinion__follow-jump'), '「盯的 N 条有新进展」必须离开第一行（它是最长的那条）')
    notOk(head.includes('page-opinion__mine'), '「我盯的」入口必须在第二行，不要与标题争宽')
  })

  it('两个入口都在第二行，且各有图标（★ / ●）', () => {
    const sub = between(card, "className='page-opinion__head-sub'", 'eventPreview.rows.map')
    ok(/\{followedCount > 0 &&[\s\S]{0,200}?page-opinion__mine/.test(sub), '「我盯的」要常显（只要盯过，不要求有新进展）')
    ok(/page-opinion__mine-icon'>★/.test(sub), '「我盯的」用星形图标 —— 收藏类关系的通用语汇，比三个字省宽')
    ok(/page-opinion__follow-jump/.test(sub), '「盯的 N 条有新进展」要在第二行')
    ok(/page-opinion__follow-dot'>●/.test(sub), '有新动静要有个点先被看见，而不是只有一行小字')
    /* 两个入口跳的是同一个聚合视图：一个说「我盯的全部」、一个强调「其中这几件有动静」 */
    eq((sub.match(/onClick=\{goFollowedEvents\}/g) || []).length, 2, '两个入口都跳 ?only=follows 聚合视图')
  })

  it('第二行允许折行（窄屏 / 大字号下折行，而不是把字压扁）', () => {
    const sub = SCSS.slice(SCSS.indexOf('&__head-sub'))
    ok(/&__head-sub\s*\{[\s\S]{0,160}?flex-wrap:\s*wrap/.test(sub), '第二行必须 flex-wrap —— 这正是原来缺的那一条')
    ok(/\{[\s\S]{0,200}?flex-wrap:\s*wrap/.test(sub.slice(0, 260)), 'flex-wrap 要写在 __head-sub 自己的规则里')
  })

  it('第一行的元素一律不缩不断行（挤压的根源是这里的 nowrap + 可压缩）', () => {
    ok(/&__head-title\s*\{[\s\S]{0,200}?white-space:\s*nowrap/.test(SCSS), '标题不许被压成两行')
    ok(/&__more\s*\{[\s\S]{0,160}?flex-shrink:\s*0/.test(SCSS), '「查看全部 ›」不许被压缩')
  })

  it('两个入口都是图标胶囊，不再是裸文字 / 下划线', () => {
    ok(/&__mine\s*\{[\s\S]{0,240}?border-radius:\s*999rpx/.test(SCSS), '「我盯的」要成胶囊按钮')
    notOk(/&__mine\s*\{[\s\S]{0,240}?text-decoration:\s*underline/.test(SCSS), '胶囊底替代下划线，别两个都上')
    ok(/&__follow-jump\s*\{[\s\S]{0,240}?background:\s*\$brand-weak/.test(SCSS), '「有新进展」要用品牌浅底强调可点')
    ok(/&__follow-jump\s*\{[\s\S]{0,260}?white-space:\s*nowrap/.test(SCSS), '胶囊内文案不许折行')
  })

  it('删掉已无人使用的 __head-actions（留着空类名会误导后来的人）', () => {
    notOk(PAGE.includes('page-opinion__head-actions'), 'JSX 里已不再有动作组')
    notOk(SCSS.includes('&__head-actions'), '样式也一并清理')
  })

  it('事件条目的动作行同样不压缩（标记已读 / 跟进 / 查看完整时间线）', () => {
    ok(/&__event-actions\s*\{[\s\S]{0,220}?flex-wrap:\s*wrap/.test(SCSS), '三个文字按钮挤不下时折行，不要压断字')
    ok(/&__action\s*\{[\s\S]{0,220}?white-space:\s*nowrap/.test(SCSS), '「标记已读」不许被压成两行')
    ok(/&__event-go\s*\{[\s\S]{0,200}?white-space:\s*nowrap/.test(SCSS), '「查看完整时间线 ›」同样不许折字')
  })
})

describe('全局角标 .count-badge：定高元素绝不允许折行', () => {
  const badge = APP_SCSS.slice(APP_SCSS.indexOf('.count-badge'))
  it('white-space: nowrap + flex-shrink: 0', () => {
    ok(/\.count-badge\s*\{[\s\S]{0,260}?white-space:\s*nowrap/.test(APP_SCSS), '折行会溢出 36rpx 的圆底（本次变形的直接原因）')
    ok(/\.count-badge\s*\{[\s\S]{0,260}?flex-shrink:\s*0/.test(APP_SCSS), 'flex 父级里被压窄才会折行，所以要禁止收缩')
    /* 正向对照：定高仍在，否则「折行溢出」这个前提就不成立了 */
    ok(/\.count-badge\s*\{[\s\S]{0,260}?height:\s*36rpx/.test(APP_SCSS), '角标仍是定高小圆角块')
    ok(badge.length > 0, '找不到 .count-badge 定义')
  })
})
