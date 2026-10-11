'use strict'

/**
 * 检索问什么，由报告模板说了算（2026-10-11）
 *
 * 此前「问博查什么词」是三条字面量写死在 utils/search.ts 里（`近期 新闻 动态 言论` /
 * `近期 动态` / `个人资料 简介 出生地 学历 经历`），与报告模板毫无关系：
 * 模板随时可以增减节，检索却永远只问那三句 —— 新加的节（例如「商业合作」）的素材
 * **从没被查过**，而页面上「没查」与「查了没有」长得一模一样（卡片直接不出现），
 * 只会被读成「这个人没有这些信息」。
 *
 * 于是把「哪几组要哪些素材、这些素材用什么词去问」搬进模板（utils/report-toc.ts
 * 的 SEARCH_LANES + TOC_GROUPS[].search），并在这里钉五件事：
 *   唯一 —— 关键词与站点白名单在 src 下只有模板一处（其它文件出现即红）；
 *   兑现 —— 改模板的关键词 / 白名单，发出去的请求立刻跟着变（不是抄了一份）；
 *   接上 —— 模板声明了哪几路，就真有几路发得出去（只加声明不接发请求点 = 等于没查）；
 *   完整 —— 每组都声明了素材需求，且没有一条路是白声明的（花了钱却没人用）；
 *   同源 —— 批次带不带「人物背景资料」段，等于该组要不要 profile 路（派生，不手写）。
 *
 * ⚠ 别把关键词断言写进注释原样引用：本文件按**源码**判字面量出现次数，
 *   在 utils/search.ts 的注释里引一句被禁的写法会把它误伤（故那里只用「模板的 news 路」指代）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const BUILD = path.resolve(__dirname, '..', '.build')
const read = (p) => fs.readFileSync(p, 'utf8')

/** 关键词字面量：它们只该出现在模板的 SEARCH_LANES 里 */
const KEYWORDS = ['近期 新闻 动态 言论', '近期 动态', '个人资料 简介 出生地 学历 经历']
/** 社交路的站点白名单同样归模板（只列域名，过滤发生在博查服务端） */
const SITE = 'weibo.com'

/** 让「云环境已配置」为真（与 05 同一手法：在 load 业务模块之前改配置对象） */
function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

function fresh() {
  env.resetAll()
  env.setDebugFlags({
    disableGenerateQuota: false,
    disableAskQuota: false,
    disableRefreshQuota: false,
    disableCooldown: false
  })
  configureCloud()
  return { load: env.load }
}

/** 记下每一次检索请求（整条 data：既要看句式，也要看 include 与 freshness） */
function spySearch() {
  const calls = []
  env.registerCloudFn('aiProxy', (data) => {
    if (data.action !== 'search') return { ok: false }
    calls.push(data)
    return { ok: true, pages: [{ name: '标题', url: 'https://news.example.com/a', snippet: '正文' }] }
  })
  return calls
}

/** 递归收集 src 下的 .ts / .tsx（判「字面量有没有第二处」要扫全部源码，不是只看检索层） */
function srcFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) srcFiles(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

const names = (files) => files.map((f) => path.basename(f)).join(' / ')

describe('检索问什么由报告模板说了算（不是写死在检索层）', () => {
  it('关键词与站点白名单在 src 里只有一处：报告模板', () => {
    const files = srcFiles(SRC)
    ok(files.length > 20, '没扫到源码文件，断言等于空转')
    for (const kw of [...KEYWORDS, SITE]) {
      const hit = files.filter((f) => read(f).includes(kw))
      eq(
        hit.length,
        1,
        `「${kw}」只该写在报告模板（utils/report-toc.ts#SEARCH_LANES），现在出现在：${names(hit)}`
      )
      eq(
        path.basename(hit[0]),
        'report-toc.ts',
        `「${kw}」被写回了 ${path.basename(hit[0])}：检索层只按模板发请求，不留字面量`
      )
    }
  })

  it('改模板的 news 路关键词，请求句式立刻跟着变（不是抄了一份）', async () => {
    const { load } = fresh()
    const calls = spySearch()
    const toc = load('utils/report-toc')
    const { fetchNews } = load('utils/search')

    const original = toc.SEARCH_LANES.news.keywords
    try {
      /* 模拟「模板给基本档案组加一节商业合作」后 news 路该问什么 */
      toc.SEARCH_LANES.news.keywords = '代言 品牌 商业合作'
      await fetchNews('张三', { socialCount: 0 })

      eq(calls[0].query, '张三 代言 品牌 商业合作', '第一档句式必须取自模板的 news 路')
      notOk(String(calls[0].query).includes('近期 新闻'), '写死的那句必须已经不生效')
    } finally {
      toc.SEARCH_LANES.news.keywords = original
    }
  })

  it('社交路的句式与站点白名单同样取自模板', async () => {
    const { load } = fresh()
    const calls = spySearch()
    const toc = load('utils/report-toc')
    const { fetchNews } = load('utils/search')

    const original = toc.SEARCH_LANES.social.include
    try {
      toc.SEARCH_LANES.social.include = ['douyin.com']
      await fetchNews('张三', { socialCount: 6 })

      eq(calls.length, 2, '主线第一档就有内容 ⇒ 只多发一条社交支线')
      eq(calls[1].query, `张三 ${toc.SEARCH_LANES.social.keywords}`, '社交路句式取自模板')
      deepEq(calls[1].include, ['douyin.com'], '站点白名单取自模板（改模板即改请求体）')
    } finally {
      toc.SEARCH_LANES.social.include = original
    }
  })

  it('背景线的句式与时间语义取自模板的 profile 路', async () => {
    const { load } = fresh()
    const calls = spySearch()
    const toc = load('utils/report-toc')
    const { fetchBackground } = load('utils/search')

    const original = toc.SEARCH_LANES.profile.keywords
    try {
      toc.SEARCH_LANES.profile.keywords = '出生地 学历 履历'
      await fetchBackground('张三', 8)

      eq(calls[0].query, '张三 出生地 学历 履历', '背景线句式取自模板')
      eq(calls[0].freshness, 'noLimit', 'evergreen 路固定 noLimit：履历不随时间变')
    } finally {
      toc.SEARCH_LANES.profile.keywords = original
    }
  })

  it('模板声明了哪几路，就真有几路发得出去（只加声明、不接发请求点 = 等于没查）', async () => {
    const { load } = fresh()
    const toc = load('utils/report-toc')
    const { fetchNews, fetchBackground } = load('utils/search')
    const lanes = toc.SEARCH_LANES
    const keys = Object.keys(lanes)

    /* 先保证判定可信：两路的句式互不为子串，否则「这条路的词出现过」会被别的路冒充 */
    for (const a of keys) {
      for (const b of keys) {
        if (a === b) continue
        notOk(
          lanes[a].keywords.includes(lanes[b].keywords),
          `检索路的句式互相包含（${a} ⊃ ${b}）：下面「每路都发过请求」的判定会失真`
        )
      }
    }

    /* 跑一轮完整检索：近期主线（阶梯第一档就有内容，故只发一次）+ 社交支线 + 背景线 */
    const calls = spySearch()
    await fetchNews('张三', { socialCount: 6 })
    await fetchBackground('张三', 8)
    const asked = calls.map((c) => String(c.query))

    for (const k of keys) {
      ok(
        asked.some((q) => q.includes(lanes[k].keywords)),
        `模板声明了「${k}」路（${lanes[k].keywords}）却没有任何请求把它问出去 —— ` +
          '多半是模板加了路、utils/search.ts 没接上发请求的点'
      )
    }
    /* 时间语义也要兑现：recent 路不可能是 noLimit（否则「近期动态」会混进旧闻） */
    for (const c of calls) {
      const lane = keys.find((k) => String(c.query).includes(lanes[k].keywords))
      if (!lane) continue
      if (lanes[lane].freshness === 'evergreen') eq(c.freshness, 'noLimit', `${lane} 路必须不限时间`)
      else notOk(c.freshness === 'noLimit', `${lane} 路是 recent 语义，不得用 noLimit`)
    }
  })

  it('每组都声明了素材需求，且没有一条路是白声明的', () => {
    const { load } = fresh()
    const toc = load('utils/report-toc')
    const lanes = Object.keys(toc.SEARCH_LANES)

    for (const g of toc.TOC_GROUPS) {
      ok(
        Array.isArray(g.search) && g.search.length > 0,
        `模板分组 ${g.key} 没声明素材需求：它下面的节到底查什么？`
      )
      for (const k of g.search) ok(lanes.includes(k), `${g.key} 声明了不存在的检索路「${k}」`)
      /* 组是节的唯一归类 ⇒「每组都有素材需求」等价于「每一节都有素材来源」 */
      const ids = toc.REPORT_TEMPLATE.filter((s) => s.group === g.key).map((s) => s.id)
      ok(ids.length > 0, `分组 ${g.key} 下面一节都没有：要么删组，要么模板的 group 写错了`)
      /* 判断也得建立在事实上：任何一组都不能只吃背景线 */
      ok(g.search.includes('news'), `分组 ${g.key} 不要近期主线：它写不出近期事实`)
    }

    const used = new Set(toc.TOC_GROUPS.flatMap((g) => g.search))
    for (const k of lanes) {
      ok(used.has(k), `检索路 ${k} 没有任何组声明：删掉它，或者挂到该用它的组上（否则是白花钱）`)
    }
  })

  it('批次带不带「人物背景资料」段 = 该组要不要 profile 路（派生，不手写）', () => {
    const { load } = fresh()
    const toc = load('utils/report-toc')
    const { REPORT_BATCHES } = load('utils/report')

    deepEq(
      REPORT_BATCHES.map((b) => b.background),
      toc.TOC_GROUPS.map((g) => g.search.includes('profile')),
      'background 必须与模板的组声明一一对应（人工同步过一次，别再退回去）'
    )
    /* 顺带钉住行为本身：只有基本档案 / 细节与延伸两批带背景段 */
    deepEq(
      REPORT_BATCHES.filter((b) => b.background).map((b) => b.key),
      ['identity', 'detail'],
      '带背景段的批次变了：background 一改，动态与争议会被长期履历污染'
    )
  })
})
