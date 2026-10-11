'use strict'

/**
 * 检索词规划（2026-10-11，utils/search-plan.ts）
 *
 * 改造：查询词原本是模板里写死的句式（utils/report-toc.ts#SEARCH_LANES），现在每次生成先问一次
 * 模型「这个人该去查什么」，端上拿这些词去博查，素材到手后照旧喂模型成文。
 * 19 钉的是「问什么由模板说了算」，本文件钉的是**规划这一步自己**的四条边界：
 *   净化 —— 模型给的词要摘掉人名 / 站点限定 / 纯数字，去重、截断、限条数（成本闸门）；
 *   定级 —— 走 aux 档（不占用户当日的生成额度），且**只发一次**调用（它在必经路径上，重试=白等）；
 *   不带素材 —— 这一步**结构上**拿不到任何检索结果（硬性规定，不是提示词里求它别看）；
 *   失败即回落 —— 乱答 / 空数组 / 上游挂 / 通道未就绪一律返回 null，调用方按模板句式去查。
 */

const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const BUILD = path.resolve(__dirname, '..', '.build')

/** 让「云环境已配置」为真（与 19/05 同一手法：在 load 业务模块之前改配置对象） */
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

/** 假上游：记下每一次 aux 大模型调用的入参；resp 由调用方给（对象=成功，函数=按入参算） */
function fakeChat(resp) {
  const calls = []
  env.registerCloudFn('aiProxy', (data) => {
    if (data.action !== 'aux') return { ok: false, kind: 'bad_request', error: '只该发 aux' }
    calls.push(data)
    return typeof resp === 'function' ? resp(data) : resp
  })
  return calls
}

const json = (obj) => ({ ok: true, content: JSON.stringify(obj) })

describe('检索词规划：先问模型「该查什么」，再拿这些词去查', () => {
  it('模型给的词要净化：摘掉人名、丢掉站点限定与纯数字、去重、截到成本上限', async () => {
    const { load } = fresh()
    const { SEARCH_COUNTS } = load('config/benefits')
    const { planSearchQueries } = load('utils/search-plan')
    fakeChat(
      json({
        /* 人名写在词里是白占排序权重；站点限定与时间由端上管；末条超出条数上限 */
        news: ['  公开报道  ', '张三 访谈', 'site:weibo.com', '2026', '行业观察 人物评价 商业合作'],
        profile: ['出生地', '出生地'],
        social: ['微博发声']
      })
    )

    const plan = await planSearchQueries('张三', 'tech', { lanes: ['news', 'profile'] })

    deepEq(plan.news, ['公开报道', '访谈'], '人名摘掉、站点限定与纯数字丢掉、条数截到成本上限')
    deepEq(plan.profile, ['出生地'], '同一条词只留一份')
    eq(plan.social, undefined, '没问的路不该出现在结果里（免费档不问社交词）')
    ok(SEARCH_COUNTS.planWordsPerLane >= 1, '每路条数由 config/benefits.ts 的 planWordsPerLane 决定')
  })

  it('超长词是截断（不是整条丢掉，也不是原样发出去）', async () => {
    const { load } = fresh()
    const { planSearchQueries, PLAN_WORD_MAX_CHARS } = load('utils/search-plan')
    const long = '这是一条特别特别长的关键词需要被截断处理掉它'
    fakeChat(json({ news: [long] }))

    const plan = await planSearchQueries('张三', 'tech', { lanes: ['news'] })

    eq(plan.news.length, 1)
    eq(plan.news[0].length, PLAN_WORD_MAX_CHARS, '按字数上限截断')
    ok(long.startsWith(plan.news[0]), '截的是尾巴，不是重排')
  })

  it('只在真要查的几路上问词，且逐路要求派生自模板（改 want 就改提示词）', async () => {
    const { load } = fresh()
    const toc = load('utils/report-toc')
    const { planSearchQueries } = load('utils/search-plan')
    const calls = fakeChat(json({ news: ['公开报道'] }))

    const original = toc.SEARCH_LANES.news.want
    try {
      toc.SEARCH_LANES.news.want = '这一路要的是某类素材（改动即改提示词）'
      await planSearchQueries('张三', 'tech', { lanes: ['news'] })

      const sys = calls[0].messages[0].content
      ok(sys.includes('这一路要的是某类素材'), '每路要什么由模板的 want 派生，不在提示词里另写一份')
      notOk(sys.includes('social'), '免费档不问社交路：提示词里连这个词都不该出现')
      notOk(JSON.stringify(calls[0].messages).includes('profile'), '没问的路不许出现在提示词里')
    } finally {
      toc.SEARCH_LANES.news.want = original
    }
  })

  it('定级 aux（不占生成额度）且**只发一次**：规划在每次生成的必经路径上，重试=白等一个往返', async () => {
    const { load } = fresh()
    const { planSearchQueries } = load('utils/search-plan')
    const calls = fakeChat(json({ news: ['公开报道'] }))

    await planSearchQueries('张三', 'tech', { lanes: ['news'] })

    eq(calls.length, 1, '不重试')
    eq(calls[0].purpose, 'aux', '与消歧同档：不占用户当日的生成额度')
    eq(calls[0].action, 'aux', '检索词规划不该叫 chat，走 aux action（只有 AI 问答才叫 chat）')
  })

  it('这一步**结构上**不带任何检索结果（硬性规定：给的是「该查什么」，不是「查到了什么」）', async () => {
    const { load } = fresh()
    const domains = load('config/domains')
    const { planSearchQueries } = load('utils/search-plan')
    const calls = fakeChat(json({ news: ['公开报道'] }))

    await planSearchQueries('张三', 'tech', { lanes: ['news'] })

    const user = calls[0].messages[1].content
    ok(user.includes('张三'), '要有名字（模型据此判断该查什么）')
    ok(String(user).includes(domains.DOMAIN_META.tech.label), '要有领域（同上）')
    /* 素材字段一个都不许出现：规划在检索之前，此刻也**没有**素材可传 */
    const whole = JSON.stringify(calls[0].messages)
    for (const field of ['snippet', 'publishedDate', 'news.example.com']) {
      notOk(whole.includes(field), `规划调用里不该出现素材字段：${field}`)
    }
  })

  it('模型乱答 / 给空数组 / 上游挂 → null（不抛错），调用方按模板句式去查', async () => {
    const { load } = fresh()
    const { planSearchQueries } = load('utils/search-plan')

    /* 报告 JSON（模型没理解任务） */
    fakeChat(json({ intro: '张某，演员。', analysisPoints: ['x'] }))
    eq(await planSearchQueries('张三', 'tech', { lanes: ['news'] }), null, '不合形状的 JSON 等于没规划')
    /* 空数组是合法答案（模型确实想不出），但没有可用的词 ⇒ 回落模板句式 */
    fakeChat(json({ news: [] }))
    eq(await planSearchQueries('张三', 'tech', { lanes: ['news'] }), null)
    /* 词全被净化掉（人名 + 站点限定 + 纯数字）等于空 */
    fakeChat(json({ news: ['张三', 'site:weibo.com', '2026'] }))
    eq(await planSearchQueries('张三', 'tech', { lanes: ['news'] }), null)
    /* 上游报错 */
    fakeChat({ ok: false, kind: 'upstream', error: '大模型服务暂时不可用（502）' })
    eq(await planSearchQueries('张三', 'tech', { lanes: ['news'] }), null)
  })

  it('通道未就绪 → null（不抛错，生成照常走模板句式）', async () => {
    env.resetAll()
    env.setDebugFlags({
      disableGenerateQuota: false,
      disableAskQuota: false,
      disableRefreshQuota: false,
      disableCooldown: false
    })
    /* 刻意不 configureCloud()：云环境没配 */
    const { planSearchQueries } = env.load('utils/search-plan')
    eq(await planSearchQueries('张三', 'tech', { lanes: ['news'] }), null)
  })

  it('空人名或空路：直接返回 null，连调用都不发（不能拿空查询词去烧一次上游）', async () => {
    const { load } = fresh()
    const { planSearchQueries } = load('utils/search-plan')
    const calls = fakeChat(json({ news: ['公开报道'] }))

    eq(await planSearchQueries('   ', 'tech', { lanes: ['news'] }), null)
    eq(await planSearchQueries('张三', 'tech', { lanes: [] }), null)
    eq(calls.length, 0, '一次调用都不该发')
  })

  it('生成路径真的把结果交给了检索（写了规划没人用 = 等于没做）', () => {
    const fs = require('fs')
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'utils', 'cache.ts'), 'utf8')
    ok(src.includes('planSearchQueries('), 'cache.ts 要在检索前调用规划')
    ok(src.includes('.planned = plan'), '模型词要真的交给 fetchNews（主线 + 社交支线）')
    ok(src.includes('plan?.profile'), '背景线也要吃到模型词')
  })
})
