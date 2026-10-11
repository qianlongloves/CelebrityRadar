'use strict'

/**
 * 报告提示词构造：大模型请求参数不再携带博查素材（知识模式改造，2026-10-11）
 * 验证 buildUserMessage 已不把检索素材（标题/正文/url/来源）与背景资料拼进 user 消息。
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

/** 带明显标识的博查素材：一旦漏进提示词，这些串会被断言立刻抓到 */
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

describe('报告提示词构造：大模型请求不再携带博查素材', () => {
  it('打印每次请求参数，并断言 user / system 均不含任何素材', async () => {
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

    /* 断言：任何素材都不该出现在请求参数里 */
    for (const c of calls) {
      const sys = String(c.messages[0].content)
      const user = String(c.messages[1].content)
      ok(user.includes('测试人物'), 'user 消息应点名这位名人')
      notOk(/https?:\/\//.test(user), 'user 消息不该含任何 url')
      notOk(/素材标题|素材正文|博查媒体/.test(user), 'user 消息不该含素材标题 / 正文 / 来源')
      notOk(/bocha\.example\.com|素材标题|素材正文/.test(sys), 'system 消息同样不该含素材')
    }
  })

  it('user 消息精确等于「名人 + 关注侧重」两行，且不随素材数量变化', async () => {
    const { load } = fresh()
    const report = load('utils/report')
    const calls = []
    mockAiProxy(calls)

    const many = Array.from({ length: 20 }, (_, i) => newsItem(i))
    await report.buildReport('甲#tech', '甲', many, 'all', {})

    for (const c of calls) {
      eq(String(c.messages[1].content), '名人：甲\n关注侧重：综合', 'user 消息固定两行，与素材条数无关')
    }
  })

  it('关注侧重随 focus 变化，但依旧不携带素材', async () => {
    const { load } = fresh()
    const report = load('utils/report')
    const calls = []
    mockAiProxy(calls)

    await report.buildReport('乙#tech', '乙', [newsItem(0)], 'dynamics', {})

    eq(String(calls[0].messages[1].content), '名人：乙\n关注侧重：近期动态', 'focus=dynamics 时侧重应写「近期动态」')
    notOk(/素材|https?:\/\//.test(String(calls[0].messages[1].content)), '带 focus 的请求同样不携带素材')
  })
})
