'use strict'

/**
 * 报告补跑：只补失败批（P8，2026-10-17）
 *
 * ## 修的是什么
 *
 * 不达标自动重跑此前是**整份 4 批重来**（见 utils/cache.ts 的 shortfall 分支），而 shortfall
 * 最常见的成因恰好是「某一批空掉导致 facts 不足」（report.ts#shortfallVerdict）——
 * 为一批失败把另外三批的 token 再烧一遍，最坏一次生成 24 次调用（4 批 × 3 次 × 2 遍）。
 *
 * 现在 `buildReport` 支持 `only`（只跑哪几组）+ `seed`（已有的批次结果），cache.ts 按首轮
 * 产物的 `missingGroups` 传参：补跑从 4 批降到 1 批（最坏 3 次尝试）。
 *
 * ## 这条用例钉的四件事
 *
 *   ① 首轮只有一组失败时，`missingGroups` 如实记下那一组；
 *   ② 补跑**只发一次调用**，不是整份重来；
 *   ③ `seed` 的批次内容原样进最终报告（证明「已付的 token 不作废」，而不是靠再用一次调用补回来）；
 *   ④ 补跑全败时**如实失败**，绝不降级成纯文本简版顶替已有三批。
 *
 * 第 ④ 条是这次改动最容易写错的地方：原代码 `done === 0` 一律降级纯文本，补跑模式下那会
 * 把三批真实素材换成一段「模型已有知识」。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')

/* 线上口径：调试开关全关（理由同 03-quota-qa 的 ALL_OFF） */
const ALL_OFF = {
  disableGenerateQuota: false,
  disableAskQuota: false,
  disableRefreshQuota: false,
  disableCooldown: false
}

function fresh() {
  env.resetAll()
  env.setDebugFlags(Object.assign({}, ALL_OFF))
  return env.load
}

function news(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    title: `报道${i}`,
    content: '内容',
    url: `https://example.com/${i}`,
    source: '媒体X',
    publishedDate: new Date(Date.now() - i * 3600 * 1000).toISOString()
  }))
}

/**
 * 首轮：让 facts 批（第 2 组）的**三次尝试全失败**，其余三批一次过。
 *
 * 为什么按序号而不是按内容判断：假上游拿到的是提示词，按批内容匹配要抄一遍提示词特征；
 * 序号完全确定 —— 1 = identity，2~4 = facts 的三次尝试（retries:2），5 = judgement，6 = detail。
 */
async function firstRoundWithMissingFacts() {
  const load = fresh()
  const report = load('utils/report')
  const factsKey = report.REPORT_BATCHES[1].key
  const ctl = { calls: 0, mode: 'seq' }
  env.registerCloudFn('aiProxy', () => {
    ctl.calls++
    const fail = ctl.mode === 'fail' || (ctl.mode === 'seq' && ctl.calls >= 2 && ctl.calls <= 4)
    if (fail) return { ok: false, kind: 'upstream', error: '上游 5xx' }
    return { ok: true, content: JSON.stringify({ intro: `intro-${ctl.calls}` }) }
  })
  let collected = []
  const first = await report.buildReport('甲#tech', '甲', news(), 'all', {
    onPart: (parts) => {
      collected = parts.slice()
    }
  })
  return { report, first, collected, factsKey, ctl }
}

describe('报告补跑：只补失败批（P8）', () => {
  it('首轮缺一组 → 补跑只发一次调用，且已成功批次的字段原样保留', async () => {
    const { report, first, collected, factsKey, ctl } = await firstRoundWithMissingFacts()

    ok(first.ok, '部分批失败不算整份失败，仍应返回报告')
    eq(ctl.calls, 6, '首轮 = identity 1 次 + facts 3 次尝试 + judgement 1 次 + detail 1 次')
    eq(collected.length, 3, '三批成功（onPart 收到累计批次）')
    eq(
      (first.data.missingGroups ?? []).join(','),
      factsKey,
      '缺的正是 facts 组 —— 这是 cache.ts 决定「只补哪几批」的唯一依据'
    )
    eq(first.data.intro, 'intro-1', 'identity 批的字段已进报告')

    /* 补跑：只补 facts，上游此时恢复正常 */
    ctl.mode = 'ok'
    const before = ctl.calls
    const refill = await report.buildReport('甲#tech', '甲', news(), 'all', {
      only: [factsKey],
      seed: collected
    })

    ok(refill.ok, '补跑应成功')
    eq(ctl.calls - before, 1, '补跑只发一次调用（不再整份 4 批重来）')
    eq(refill.data.missingGroups, undefined, '补跑成功后不该再有缺组标记')
    eq(
      refill.data.intro,
      'intro-1',
      'seed 里 identity 批的内容必须保留 —— 否则「只补一批」等于把另外三批丢了'
    )
  })

  it('补跑全败：如实失败，绝不用纯文本简版顶替已有批次', async () => {
    const { report, first, collected, factsKey, ctl } = await firstRoundWithMissingFacts()
    ok(first.ok, '首轮前置条件')

    ctl.mode = 'fail'
    const before = ctl.calls
    const refill = await report.buildReport('甲#tech', '甲', news(), 'all', {
      only: [factsKey],
      seed: collected
    })

    notOk(refill.ok, '补跑全败必须交回失败，而不是给一份 degraded 的纯文本')
    eq(ctl.calls - before, 3, '补跑只打这一批的 3 次尝试（不碰另外三组）')
    /*
     * 反向对照：这份失败里**没有** data。原代码在 done===0 时会返回 ok:true 的纯文本简版，
     * 那时这条断言会红 —— 而那正是「三批真实素材被一段模型知识换掉」的现场。
     */
    eq(refill.data, undefined, '失败结果不该带报告体')
  })

  it('接线：cache 的重跑带 only + seed，report 按 only 收窄批循环', () => {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const cache = strip(fs.readFileSync(path.join(ROOT, 'src/utils/cache.ts'), 'utf8'))
    ok(cache.includes('refillBatchesOf(report, builtParts)'), 'cache 没有推导「补哪几批」')
    ok(
      cache.includes('only: refillOnly, seed: builtParts'),
      '重跑没把「补哪几批」与「已有批次」一起传给 buildReport —— 只传 only 会丢其余组'
    )

    const report = strip(fs.readFileSync(path.join(ROOT, 'src/utils/report.ts'), 'utf8'))
    ok(
      report.includes('REPORT_BATCHES.filter((b) => onlyKeys.has(b.key))'),
      'report.ts 没按 only 收窄批循环（补跑就还是整份 4 批）'
    )
    ok(
      report.includes('if (seeded.length > 0)'),
      '补跑全败时缺少「保留已有批次、不降级纯文本」的分支'
    )
  })
})
