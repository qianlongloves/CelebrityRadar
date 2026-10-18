'use strict'

/**
 * 首页两件事（2026-10-18 用户反馈）：
 *
 * ① 热搜一行名字长短不一，四个胶囊平铺会折行、把搜索卡顶高一截 —— 改成**单行横滑**；
 * ② 同名不同领域的人，点候选后生成的却是同一份报告 —— 一半在 utils/person-index（判据
 *    收窄为「名字 + 领域」，见用例 24），另一半在**这里**：生成时不能只拿人名去查，
 *    要把「人名 + 领域标签 + 关键词」一起带到报告页（如「雷军 科技 小米公司」）。
 *
 * 后半部分是行为断言（直接调 buildCandidateKeyword），前半部分是静态断言（JSX / SCSS 结构）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')
/** 注释里就写着「别写 flex-wrap」「scroll-view 里 gap 不生效」这类说明，不剥会把解释当实现 */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const PAGE = codeOf(read('pages/index/index.tsx'))
const SCSS = codeOf(read('pages/index/index.scss'))
const REPORT_PAGE = codeOf(read('package/report/index.tsx'))

function ruleOf(src, selector) {
  const at = src.indexOf(selector)
  if (at < 0) return ''
  const end = src.indexOf('}', at)
  return end < 0 ? src.slice(at) : src.slice(at, end + 1)
}

describe('首页热搜：名字再长也不折行，一律单行横滑', () => {
  it('热搜胶囊装在 ScrollView 滑轨里', () => {
    ok(
      PAGE.includes("<ScrollView className='page-index__hot-chips' scrollX>"),
      '热搜要横滑：静态铺开会随名字变长而折行'
    )
    /* 正向对照：紧邻的「最近」本来就是这么做的，两条滑轨共用一套样式 */
    ok(PAGE.includes("className='page-index__recent-chips' scrollX"), '正向对照：最近搜索本来就是横滑')
  })

  it('容器不再允许折行（折行正是搜索卡被顶高的原因）', () => {
    const wrap = ruleOf(SCSS, '&__hot-words {')
    ok(wrap.length > 0, '找不到 __hot-words 规则')
    notOk(/flex-wrap/.test(wrap), '热搜容器不许 flex-wrap')
    ok(/display:\s*flex/.test(wrap), '正向对照：容器仍是 flex（标签 + 滑轨并排）')
  })

  it('两条滑轨共用同一段样式，chip 自身 inline-block + 不折字', () => {
    ok(/&__recent-chips,\s*\n\s*&__hot-chips\s*\{/.test(SCSS), '热搜与最近共用一个滑轨选择器，别各写一套')
    const chip = ruleOf(SCSS, '&__hot-word {')
    ok(/display:\s*inline-block/.test(chip), 'scroll-view 里的 chip 必须 inline-block，否则各占一行')
    ok(/white-space:\s*nowrap/.test(chip), '名字长的热搜宁可滚出去，也不许把两个字挤成两行')
    ok(/margin-right:\s*12rpx/.test(chip), 'scroll-view 里 gap 不生效，间距要写在 chip 自己身上')
  })
})

describe('候选 → 报告页：人名 + 领域标签 + 关键词全部带上', () => {
  const { buildCandidateKeyword } = env.load('utils/query-split')

  it('领域标签会随关键词进检索（雷军 科技 小米公司 的「科技」「小米公司」）', () => {
    const kw = buildCandidateKeyword({ domain: 'tech', brief: '小米创始人' })
    eq(kw, '科技 小米创始人', '领域码要转成给人看的标签，再拼上候选的一句话身份')
  })

  it('用户自己填的关键词排最前，超长时先丢 brief 的后半段', () => {
    const kw = buildCandidateKeyword({ keyword: '小米', domain: 'tech', brief: '小米创始人、金山董事长' })
    eq(kw, '小米 科技 小米创始人', '「金山董事长」放不下就整段丢弃，不留半句')
    ok(!kw.includes('金山'), '半个公司名比没有更坏，所以是整段丢、不是截字')
  })

  it('冒号等标点先被去掉（检索层会把含冒号的整段丢掉）', () => {
    eq(buildCandidateKeyword({ brief: '主持人：某节目' }), '主持人 某节目')
  })

  it('什么都不给时是空串（热榜 / 今日名人没有 brief 也不该冒出脏词）', () => {
    eq(buildCandidateKeyword({}), '')
    eq(buildCandidateKeyword({ domain: '', brief: '' }), '')
  })

  it('长度上限与检索层同一个数（两处手抄，靠这条盯着）', () => {
    const src = codeOf(read('utils/query-split.ts'))
    const m = src.match(/KEYWORD_MAX_CHARS = (\d+)/)
    ok(m, '找不到 KEYWORD_MAX_CHARS')
    const { PLAN_WORD_MAX_CHARS } = env.load('utils/search-plan')
    eq(Number(m[1]), PLAN_WORD_MAX_CHARS, 'query-split 与 search-plan 的上限必须一致')
    ok(
      buildCandidateKeyword({ keyword: '小米', domain: 'tech', brief: '小米创始人、金山董事长' }).length <= 16,
      '拼出来的词串不能超过上限（否则检索层会再截一次，可能截断半个词）'
    )
  })

  it('首页候选点击把 brief 一起交出去（那是「哪位雷军」的判据）', () => {
    ok(
      PAGE.includes('openPerson(p.name, p.domain, searchKeyword, p.brief)'),
      '候选卡的一句话身份必须传下去，否则同名不同人查到的还是同一锅素材'
    )
  })

  it('openPerson 用 buildCandidateKeyword 拼词并透传给报告页', () => {
    ok(/buildCandidateKeyword\(\{\s*keyword:\s*kw,\s*domain,\s*brief\s*\}\)/.test(PAGE), '拼词要走统一入口')
    ok(/const extra = keyword \? `&keyword=\$\{encodeURIComponent\(keyword\)\}` : ''/.test(PAGE), '关键词随 URL 透传')
  })

  it('只有领域标签时不单独成关键词（否则会谎称「你填的关键词」）', () => {
    ok(
      /const keyword = kw \|\| brief \? buildCandidateKeyword/.test(PAGE),
      '热榜 / 今日名人点开一个已有报告的人，不该弹出「你填的补充关键词『科技』…」'
    )
  })

  it('报告页把它交给生成链路（仍不进 personKey / 缓存键）', () => {
    ok(/keyword:\s*keywordParam \|\| undefined/.test(REPORT_PAGE), '报告页要把 keyword 传给 getOrBuildReport')
    const at = REPORT_PAGE.indexOf('const keywordParam')
    ok(at > 0, '找不到 keywordParam')
    notOk(/buildPersonKey\([^)]*keyword/.test(REPORT_PAGE), '关键词不许参与 personKey')
  })
})
