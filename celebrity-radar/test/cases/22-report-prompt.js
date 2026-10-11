'use strict'

/**
 * 报告提示词构造：大模型请求**携带博查素材**（素材驱动），且按模板分组**分批注入**（2026-10-12）。
 * 验证 buildUserMessage 把检索素材（标题/正文/来源/url）拼进 user 消息、system 声明「基于素材」，
 * 以及背景素材只喂拿 profile 检索路的那几批（batch.background 由模板派生）。
 * 全程 mock aiProxy，不真正调用大模型。
 */

const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const BUILD = path.resolve(__dirname, '..', '.build')

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

/** 带明显标识的博查素材：素材若没进提示词，这些串会被断言立刻抓到 */
const newsItem = (i) => ({
  title: `素材标题${i}某影星新片开机`,
  content: `素材正文${i}该片由某影星主演并将于明年上映`,
  url: `https://bocha.example.com/article/${i}`,
  source: `博查媒体${i}`,
  publishedDate: '2026-10-08T00:00:00.000Z'
})

/** 注册假 aiProxy：捕获请求参数 + 返回可解析的空 JSON（不真正调用大模型） */
function mockAiProxy(calls) {
  env.registerCloudFn('aiProxy', (data) => {
    calls.push(data)
    return { ok: true, content: JSON.stringify({}) }
  })
}

describe('报告提示词构造：大模型请求携带博查素材（按模板分组分批）', () => {
  it('每批恰好一次调用，且 user 携带素材、system 声明基于素材', async () => {
    const { load } = fresh()
    const report = load('utils/report')
    const calls = []
    mockAiProxy(calls)

    const out = await report.buildReport('测试人物#tech', '测试人物', [newsItem(0), newsItem(1), newsItem(2)], 'all', {
      background: [newsItem(99)]
    })

    ok(out.ok, `mock 返回空对象应能正常生成报告（实际：${out.ok ? 'ok' : out.error}）`)
    eq(calls.length, report.REPORT_BATCHES.length, '分批生成：每批恰好一次调用')

    /* 打印到控制台：system + user 全文（人工核对「到底给模型喂了什么」） */
    console.log(`\n========== 大模型请求参数（共 ${calls.length} 次） ==========`)
    calls.forEach((c, i) => {
      const sys = String(c.messages[0].content)
      const user = String(c.messages[1].content)
      console.log(`\n--- 第 ${i + 1} 次（vendor=${c.vendor}，quality=${c.quality}，purpose=${c.purpose}）---`)
      console.log(`[system] ${sys.length} 字 ↓`)
      console.log(sys)
      console.log(`[user] ${user.length} 字 ↓`)
      console.log(user)
    })

    for (const c of calls) {
      const sys = String(c.messages[0].content)
      const user = String(c.messages[1].content)
      ok(user.includes('测试人物'), 'user 消息应点名这位名人')
      ok(user.includes('素材（按用途分组）：'), 'user 消息应带「素材（按用途分组）」段头')
      ok(/素材标题0|素材正文0/.test(user), 'user 消息应含检索素材标题 / 正文')
      ok(user.includes('bocha.example.com/article/0'), 'user 消息应含素材 url（出处）')
      ok(sys.includes('基于提供的真实新闻素材'), 'system 应声明基于素材作答')
    }
  })

  it('背景素材只注入拿 profile 检索路的那几批，其余批不带背景段', async () => {
    const { load } = fresh()
    const report = load('utils/report')
    const calls = []
    mockAiProxy(calls)

    await report.buildReport('丙#tech', '丙', [newsItem(0)], 'all', { background: [newsItem(99)] })

    const withProfile = report.REPORT_BATCHES.filter((b) => b.background)
    ok(withProfile.length > 0, '至少有若干批拿 profile 检索路（否则背景段无处可去）')
    report.REPORT_BATCHES.forEach((b, i) => {
      const user = String(calls[i].messages[1].content)
      if (b.background) ok(user.includes('人物背景资料'), `批 ${b.key} 应带背景段`)
      else notOk(user.includes('人物背景资料'), `批 ${b.key} 不该带背景段`)
    })
  })

  it('关注侧重随 focus 变化，但仍携带素材', async () => {
    const { load } = fresh()
    const report = load('utils/report')
    const calls = []
    mockAiProxy(calls)

    await report.buildReport('乙#tech', '乙', [newsItem(0)], 'dynamics', {})

    const user = String(calls[0].messages[1].content)
    ok(user.includes('关注侧重：近期动态'), 'focus=dynamics 时侧重应写「近期动态」')
    ok(/素材标题0|素材正文0/.test(user), '带 focus 的请求同样携带素材')
  })
})
