'use strict'

/**
 * 分批生成的第三道闸：**输出预算 + 字段归属**（2026-10-11 补）
 *
 * 分批（P0-B）之后，「一次生成会吐多少字」这件事第一次变得**算得出来**：每批只负责几个字段，
 * 每个字段的条数上限与每条字数上限都在 config/benefits.ts 里有真源。以前不算，是因为算不了；
 * 现在不算，就会出现「某一批悄悄胖到撞 max_tokens」——
 * 撞上限的下场不是「少写一点」，而是**整批 JSON 截断**：这一批的卡片全空，页面看起来像
 * 「这个人没有这些信息」，而日志里只有一句解析失败。
 *
 * 三道闸各管一段，别互相代替：
 *   · test/cases/03 —— 字段 ↔ **提示词条**（哪条要求归哪批，一条不漏）；
 *   · 本文件      —— 字段 ↔ **批**（谁的字段、规模多大、谁在承担达标判定）；
 *   · test/cases/19 —— 素材 ↔ 模板（检索问什么）。
 *
 * 这里钉三件事：
 *   预算 —— 端上的预算副本 = 云端 chatMaxTokens；每批估算都在正文预算线内；
 *           最胖的一批（facts）同时是达标判定的单点 ⇒ 余量按更严的标准要求；
 *   归属 —— 批字段并集 = 契约字段（降级专用的 analysis 除外），且每批的格式行点名了本批字段；
 *   派生 —— 来源清单（sources）不再向模型要：它是 facts 批最大的一块输出、条数还随素材数增长，
 *           改由端上从「报告里真引用到的素材」派生。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const SRC = path.join(ROOT, 'src')
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

/** 造 n 条彼此不相干的素材（与 03 的 newsItem 同形） */
const newsItem = (i) => ({
  title: `报道${i}某影星相关消息`,
  content: '正文',
  url: `https://example.com/${i}`,
  source: `媒体${i}`,
  publishedDate: '2026-10-08T00:00:00.000Z'
})

/**
 * 达标判定（utils/report.ts#shortfallVerdict）数的就是这三条。
 * 下面有一条静态断言核对它没变 —— 这份清单是从那段源码抄的，它改了这里必须跟着改。
 */
const SHORTFALL_FIELDS = ['dynamics', 'quotes', 'timeline']

describe('输出预算：分批之后每批的正文规模算得出来，且离上限有富余', () => {
  it('端上的预算副本 ≡ 云端 CHAT_MAX_TOKENS（漂了则「余量」是假的）', () => {
    const { load } = fresh()
    const budget = load('config/benefits').REPORT_OUTPUT_BUDGET

    for (const fn of ['aiProxy', 'hotBoardRefresh']) {
      /* 2026-10-12 v3 起输出上限收敛为全厂商全档统一常量 CHAT_MAX_TOKENS（不再挂在每个档上） */
      const llmCfg = require(path.join(CLOUD, fn, 'llm.config.js'))
      eq(
        llmCfg.CHAT_MAX_TOKENS,
        budget.chatMaxTokens,
        `${fn} 的 CHAT_MAX_TOKENS 与端上预算副本不一致：端上按这份估算算余量，` +
          '两边一漂，余量就是假的（端上以为还剩一半，云端其实只给一半）'
      )
    }
    ok(
      budget.reasoningReserve > 0 && budget.reasoningReserve < 1,
      '推理余量必须是 (0,1) 的比例（推理模型的思考同样计入 max_tokens）'
    )
  })

  it('正文预算 = 上限 × (1 − 推理余量)：不能拿整个 max_tokens 当正文的家底', () => {
    const { load } = fresh()
    const { REPORT_OUTPUT_BUDGET } = load('config/benefits')
    const { OUTPUT_BUDGET_TOKENS } = load('utils/report')

    eq(
      OUTPUT_BUDGET_TOKENS,
      Math.floor(REPORT_OUTPUT_BUDGET.chatMaxTokens * (1 - REPORT_OUTPUT_BUDGET.reasoningReserve))
    )
    ok(OUTPUT_BUDGET_TOKENS < REPORT_OUTPUT_BUDGET.chatMaxTokens, '正文预算必须小于整个 max_tokens')
  })

  it('每一批都算得出来、都在线内（免费档与会员档各算一遍）', () => {
    const { load } = fresh()
    const report = load('utils/report')

    for (const member of [false, true]) {
      for (const batch of report.REPORT_BATCHES) {
        const est = report.estimateBatchOutput(batch, member)
        deepEq(
          est.unevaluated,
          [],
          `${batch.key} 批有字段没进估算表（${est.unevaluated.join(', ')}）：预算就少算了这一块，` +
            '而漏算不会报错，只会变成线上的一次截断 —— 去 FIELD_OUTPUT_ESTIMATE 补一行'
        )
        ok(
          est.ratio <= 1,
          `${member ? '会员' : '免费'}档 ${batch.key} 批估算 ${est.tokens} token，超过正文预算 ` +
            `${report.OUTPUT_BUDGET_TOKENS}：撞上限 = 整批截断 = 这几张卡全空（改法：减条数 / 削字段 / 拆批）`
        )
      }
    }
  })

  it('最胖的一批同时是达标判定的单点：它的余量按更严的标准要求', () => {
    const { load } = fresh()
    const report = load('utils/report')

    const row = report.REPORT_BATCHES.map((b) => ({ key: b.key, est: report.estimateBatchOutput(b, false) }))
    const fattest = row.slice().sort((a, b) => b.est.tokens - a.est.tokens)[0]
    eq(
      fattest.key,
      'facts',
      '免费档最胖的一批换人了：单点与预算的取舍要重算一遍（见 utils/report.ts 的 BATCH_SPEC.facts 注释）'
    )

    /* 一批里装着两条以上达标字段 = 它一挂，达标判定就只剩一条腿（那份判定的分母见 SHORTFALL_FIELDS） */
    const single = row.filter((r) => SHORTFALL_FIELDS.filter((f) => r.est.fields.includes(f)).length >= 2)
    deepEq(single.map((r) => r.key), ['facts'], '承担两条以上达标字段的批换人了：单点换人，余量标准也要跟着换')

    for (const r of single) {
      ok(
        r.est.ratio <= 0.7,
        `单点批 ${r.key} 占了正文预算的 ${(r.est.ratio * 100).toFixed(0)}%：它一截断，整份报告立刻判残` +
          '（dynamics+quotes 全空 ⇒ 不落库、不计费），故余量要留得比别的批更宽（≤70%）'
      )
    }
  })

  it('单点清单与达标判定的真源一致：判定数的确实是 dynamics / quotes / timeline', () => {
    const src = fs.readFileSync(path.join(SRC, 'utils', 'report.ts'), 'utf8')
    const at = src.indexOf('function shortfallVerdict')
    ok(at > 0, '找不到 shortfallVerdict：它改名了要同步本文件的 SHORTFALL_FIELDS')
    const body = src.slice(at, at + 1200)
    for (const field of SHORTFALL_FIELDS) {
      ok(
        body.includes(`report.${field}.length`),
        `达标判定里没有 report.${field}.length：SHORTFALL_FIELDS 过期了，上面那条「单点」断言就失去意义`
      )
    }
  })
})

describe('模板 → 批次的字段：一份手写映射，得有校验兜着', () => {
  it('批字段并集 = 契约字段 − 降级专用字段（不重不漏）', () => {
    const { load } = fresh()
    const report = load('utils/report')

    const inBatches = new Set(report.REPORT_BATCHES.flatMap((b) => report.batchFields(b, true)))
    const expected = report.REPORT_FIELD_KEYS.filter((k) => !report.OFF_BATCH_FIELDS.includes(k))

    deepEq(
      [...inBatches].sort(),
      expected.slice().sort(),
      '契约里有字段没人写，或有批在写契约外的字段：漏的字段模型永远不会吐（对应卡片常年空白），' +
        '多写的字段会被 schema 静默丢弃（白花输出预算）'
    )
  })

  it('每批的格式行点名了本批每个字段（漏一个键 = 模型不吐那个字段）', () => {
    const { load } = fresh()
    const report = load('utils/report')

    for (const batch of report.REPORT_BATCHES) {
      ok(batch.fields.length > 0, `${batch.key} 批没有字段`)
      eq(
        batch.fields.length,
        new Set(batch.fields).size,
        `${batch.key} 批的字段有重复（同一块内容会被要两遍）`
      )
      for (const field of batch.fields) {
        ok(
          batch.format.includes(`"${field}"`),
          `${batch.key} 批的格式行（第 18 条）没点名 ${field}：模型照着格式行输出，那一格就会整块消失`
        )
      }
    }
  })

  it('会员字段只加在承载它的那一批上（memberFields 开关真的生效）', () => {
    const { load } = fresh()
    const report = load('utils/report')

    const memberOnly = report.REPORT_FIELD_KEYS.filter(
      (k) => k === 'memberNotes' || k === 'conflicts' || k === 'peers'
    )
    ok(memberOnly.length === 3, '前提：会员专属字段应为 memberNotes / conflicts / peers（新增会员段时同步这里）')
    for (const batch of report.REPORT_BATCHES) {
      const free = report.batchFields(batch, false)
      const paid = report.batchFields(batch, true)
      if (batch.memberFields) {
        for (const f of memberOnly) {
          ok(paid.includes(f), `${batch.key} 批声明承载会员段，却没有 ${f}`)
          notOk(free.includes(f), `${batch.key} 的免费档不该出现 ${f}`)
        }
      } else {
        for (const f of memberOnly) notOk(paid.includes(f), `${batch.key} 批多要了 ${f}（每批都为它白付 token）`)
      }
    }
  })
})

describe('来源清单改端上派生：facts 批最大的一块输出不再向模型要', () => {
  it('发给模型的要求里不再有「列出用到的素材」这一条', async () => {
    const { load } = fresh()
    const calls = []
    env.registerCloudFn('aiProxy', (data) => {
      calls.push(data)
      return { ok: true, content: JSON.stringify({}) }
    })
    await load('utils/report').buildReport('甲#tech', '甲', [newsItem(0), newsItem(1), newsItem(2)], 'all', {})

    ok(calls.length > 0, '前提：分批生成会发出若干次调用')
    const systems = calls.map((c) => String(c.messages[0].content))
    for (const sys of systems) {
      notOk(
        /列出.*素材/.test(sys),
        '提示词里又要模型列素材清单了：那片清单会被它写成 facts 批最大的一块输出，' +
          '而且条数随素材数增长、预算封不住（它是端上从引用派生出来的，见 sanitizeReport）'
      )
    }
  })

  it('契约里没有 sources，清单改由端上从「真引用到的素材」派生', () => {
    const { load } = fresh()
    const report = load('utils/report')
    const { sanitizeReport } = report
    const news = [newsItem(0), newsItem(1), newsItem(2)]

    notOk(report.REPORT_FIELD_KEYS.includes('sources'), 'sources 不该回到模型契约里')

    const out = sanitizeReport(
      '甲#tech',
      '甲',
      {
        intro: '甲是演员。',
        dynamics: [{ date: '2026-10-01', title: '新片开机', summary: '影片宣布开机。', url: news[2].url }],
        quotes: [{ text: '我会继续努力。', source: news[0].url }],
        /* 老报告那套「模型自报的清单」还在数据里：端上应当**无视**它 */
        sources: [{ title: '模型瞎编的标题', url: news[1].url }]
      },
      news
    )

    deepEq(
      out.sources.map((s) => s.url),
      [news[0].url, news[2].url],
      '清单 = 报告里真引用到的素材（语录引了第 0 条、动态引了第 2 条），顺序按素材自身顺序；' +
        '模型自报的那条（第 1 条）不算数 —— 它没被任何引用位指到'
    )
    eq(
      out.sources[0].title,
      news[0].title,
      '标题取素材自身的（这片清单的用处就是点回原文，标题由模型写等于多一处走形）'
    )
    deepEq(Object.keys(out.sources[0]).sort(), ['title', 'url'], '清单的形状不变：页面与 quote-check 都读它')
  })

  it('一条都没引用就是空清单，不再有「模型说它用了哪些素材」这种无出处的话', () => {
    const { load } = fresh()
    const { sanitizeReport } = load('utils/report')
    const news = [newsItem(0), newsItem(1)]

    const out = sanitizeReport(
      '甲#tech',
      '甲',
      { intro: '甲是演员。', sources: [{ title: '标题', url: news[0].url }] },
      news
    )
    deepEq(out.sources, [], '没有任何引用位指向素材时，清单为空（页面据长度判空，不会渲染 0 篇的文案）')
  })
})
