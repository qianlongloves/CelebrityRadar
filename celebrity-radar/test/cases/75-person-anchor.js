'use strict'

/**
 * 人物身份锚点（2026-10-18，「张强的报告混进李强内容」修复）
 *
 * 事故链条：用户查「张强」→ 检索只发「张强 + 泛词」（个人资料 / 出生地 / 学历 / 近期新闻）→
 * 博查把同姓近名的「李强」稿件一起排进结果 → 素材层对「这条是不是在讲本人」零校验 →
 * 提示词里唯一的身份信息只有「名人：张强」两个字 → 李强的履历被当成本人的事实写进档案。
 *
 * 修复分三道，这里各钉一条：
 *   ① 检索 —— 身份锚点（领域 / 关键词 / 候选一句话身份）拼进**每一档** query，末档不再退到纯人名；
 *   ② 素材 —— 标题与正文都不含本人姓名的条目在返回前剔除（一条都不含时原样交回，防误杀指代）；
 *   ③ 提示词 —— system 增「人物一致性」硬约束，user 增「身份限定」行；两者都用同一个锚点，
 *      否则「查的是 A、写的是 B」的错位会重新出现。
 *
 * ⚠ 锚点**不进 personKey / 缓存键**：同一个人仍然只有一份报告（共享缓存的口径不变）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const BUILD = path.resolve(__dirname, '..', '.build')
const read = (p) => fs.readFileSync(p, 'utf8')

/** 让「云环境已配置」为真（与 05 / 19 同一手法，必须在 load 业务模块之前改） */
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

/** 记下每一次检索请求；`pages` 可定制，用来造「混进了别人的稿子」这种真实返回 */
function spySearch(pages = []) {
  const calls = []
  env.registerCloudFn('aiProxy', (data) => {
    if (data.action !== 'search') return { ok: false }
    calls.push(data)
    return { ok: true, pages }
  })
  return calls
}

const queriesOf = (calls) => calls.map((c) => String(c.query))

/** 最小素材（buildReport 只读 title / url / content / source） */
function newsItems(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    title: `张三的报道${i}`,
    url: `https://news.example.com/${i}`,
    content: `张三在公开活动上的发言${i}`,
    source: `媒体${i}`
  }))
}

describe('检索：身份锚点进每一档 query，末档不再退到纯人名', () => {
  it('主线每一档都带锚点，最后一档是「人名 + 锚点」而不是裸人名', async () => {
    const { load } = fresh()
    const calls = spySearch([])

    await load('utils/search').fetchNews('张三', { socialCount: 0, anchor: '科技 创始人' })
    const queries = queriesOf(calls)

    ok(queries.length >= 2, `阶梯要真的跑起来，实际 ${queries.length} 次`)
    ok(
      queries.every((q) => q.includes('科技 创始人')),
      `每一档都必须带锚点，漏掉的那一档就是同名人被捞回来的入口：${queries.join(' | ')}`
    )
    eq(queries[queries.length - 1], '张三 科技 创始人', '末档只留人名 + 锚点')
    notOk(queries.includes('张三'), '有锚点时不得再退到完全无锚定的纯人名')
  })

  it('不传锚点时与改造前一致：末档仍是纯人名（向后兼容）', async () => {
    const { load } = fresh()
    const calls = spySearch([])

    await load('utils/search').fetchNews('张三', { socialCount: 0 })
    const queries = queriesOf(calls)

    eq(queries[queries.length - 1], '张三', '没有锚点可加时才允许纯人名兜底')
    notOk(queries.some((q) => q.includes('科技')), '不该凭空造一个锚点')
  })

  it('模型词里已经写了锚点时不重复拼（query 不能变成复读机）', async () => {
    const { load } = fresh()
    const calls = spySearch([])

    await load('utils/search').fetchNews('张三', {
      socialCount: 0,
      anchor: '科技 创始人',
      planned: { news: ['科技 创始人 发布会'] }
    })

    eq(calls[0].query, '张三 科技 创始人 发布会', '锚点已在这条词里，不再追加一次')
  })

  it('背景线（出生地 / 学历）同样带锚点 —— 这一路串味的后果最重', async () => {
    const { load } = fresh()
    const calls = spySearch([])

    await load('utils/search').fetchBackground('张三', 8, undefined, '科技 创始人')
    const queries = queriesOf(calls)

    ok(queries.length >= 2, `背景阶梯要真的跑，实际 ${queries.length} 次`)
    ok(
      queries.every((q) => q.includes('科技 创始人')),
      `「张三 个人资料 出生地」正是李强百科被召回的那一档：${queries.join(' | ')}`
    )
    eq(queries[queries.length - 1], '张三 科技 创始人', '末档同样只留人名 + 锚点')
  })
})

describe('素材：返回前按「是否提到本人」过滤', () => {
  it('混进来的别人的稿子被剔除，只有提到本人的留下', async () => {
    const { load } = fresh()
    spySearch([
      { name: '张三出席活动', url: 'https://news.example.com/a', snippet: '张三在活动上发言' },
      { name: '李强发布新书', url: 'https://news.example.com/b', snippet: '李强发布新书' }
    ])

    const news = await load('utils/search').fetchNews('张三', { socialCount: 0, filterPerson: true })

    eq(news.length, 1, '讲李强的那条不该进提示词')
    eq(news[0].url, 'https://news.example.com/a', '留下的是本人的那条')
  })

  it('一条都不含人名时原样交回（正文常用「他」指代，按字面筛会误杀整路素材）', async () => {
    const { load } = fresh()
    spySearch([{ name: '某导演近况', url: 'https://news.example.com/c', snippet: '他最近在筹备新片' }])

    const news = await load('utils/search').fetchNews('张三', { socialCount: 0, filterPerson: true })

    eq(news.length, 1, '全都不含人名 ⇒ 说明是摘要没写名字，不是素材不属于本人，不能清空')
  })

  it('关注流刷新不过这道筛（那边是条数口径，不是「写进报告」）', async () => {
    const { load } = fresh()
    spySearch([
      { name: '张三出席活动', url: 'https://news.example.com/a', snippet: '张三在活动上发言' },
      { name: '李强发布新书', url: 'https://news.example.com/b', snippet: '李强发布新书' }
    ])

    const news = await load('utils/search').fetchNews('张三', { socialCount: 0 })

    eq(news.length, 2, '不传 filterPerson 时保持原样：feed 的条数不能被摘要里没写名字压掉')
  })
})

describe('提示词：system 有人物一致性硬约束，user 有身份限定', () => {
  /** 跑一次 buildReport 并抓下每次 chat 请求 */
  async function askReport(identity) {
    const { load } = fresh()
    const calls = []
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'pass' }))
    env.registerCloudFn('aiProxy', (data) => {
      calls.push(data)
      return { ok: true, content: JSON.stringify({ intro: '张三简介' }) }
    })

    try {
      await load('utils/report').buildReport('张三#tech', '张三', newsItems(), 'all', identity ? { identity } : {})
    } catch (e) {
      /* 最小 JSON 不足以拼出完整报告没关系：本用例只验证**发出去的提示词**，请求已经落地 */
    }
    ok(calls.length >= 1, '至少要发出一批 chat，否则断言等于空转')
    return calls
  }

  it('每一批的 system 都带「只写名人这一位」的硬约束（少一批就等于少一道闸）', async () => {
    const calls = await askReport('科技 小米创始人')

    for (const c of calls) {
      ok(
        c.messages[0].content.includes('人物一致性'),
        `批 ${c.messages[0].content.slice(0, 30)} 缺人物一致性约束`
      )
      ok(
        c.messages[0].content.includes('不得写成传主本人的'),
        '约束要写到「不得写成传主本人」这种可执行的强度，而不是「注意区分」'
      )
    }
  })

  it('每一批的 user 都带同一串「身份限定」', async () => {
    const calls = await askReport('科技 小米创始人')

    for (const c of calls) {
      ok(
        c.messages[1].content.includes('名人：张三'),
        '人名仍是第一行（老口径不变）'
      )
      ok(
        c.messages[1].content.includes('身份限定：科技 小米创始人'),
        `user 里没有身份锚点，模型仍无从判断哪条素材属于本人：${c.messages[1].content.slice(0, 80)}`
      )
    }
  })

  it('没有锚点时不加这一行（免费 / 老路径逐字不变）', async () => {
    const calls = await askReport('')

    ok(
      calls.every((c) => !c.messages[1].content.includes('身份限定')),
      '空锚点不得留一个「身份限定：」的空壳行'
    )
  })
})

describe('接线：cache 把同一个锚点交给检索与提示词', () => {
  it('检索两路与两处 buildReport 都拿到 identity（漏一处就会有一批写错人）', () => {
    const src = read(path.join(SRC, 'utils/cache.ts'))

    ok(src.includes('const identity = identityAnchorOf(opts.keyword, domain)'), '锚点由领域 + 关键词算出')
    ok(src.includes('mainOpts.anchor = identity'), '主线检索要带锚点')
    ok(src.includes('mainOpts.filterPerson = true'), '报告素材要过「是不是本人」这道筛')
    ok(src.includes('plan?.profile, identity'), '背景线检索要带锚点')
    eq(
      (src.match(/background: background \?\? \[\],[\s\S]{0,400}?identity/g) ?? []).length,
      2,
      '首次生成与补跑两处 buildReport 都要传 identity'
    )
  })

  it('领域兜底：personKey 里的领域标签可用，但「其他」不参与（不拿一个无意义的词污染 query）', () => {
    const src = read(path.join(SRC, 'utils/cache.ts'))

    ok(src.includes('domainLabel(domain)'), '关键词为空时退回领域标签（热榜 / 历史进入唯一还能拿到的身份轴）')
    ok(src.includes("return label === '其他' ? '' : label"), '「其他」不是身份轴，必须当空处理')
    notOk(
      /identity.*personKey|personKey.*identity/.test(src),
      '锚点绝不能参与 personKey 的生成：同一个人只能有一份报告'
    )
  })
})
