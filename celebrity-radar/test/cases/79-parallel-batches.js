'use strict'

/**
 * 报告四批并行（P5，2026-10-17）
 *
 * ## 改了什么
 *
 * 四批互不依赖（字段不重叠、提示词各建各的、会话也是各自的），串行时一次生成 40~100s 里
 * 大半在等上游。现在按 `REPORT_BUILD.batchConcurrency` 分股并发（默认 4），合并仍按批序。
 *
 * ## 为什么必须同时有「只补失败批」（P8）
 *
 * 并发放大限流：四个请求同时到达，遇 429 时 `chatJSON` **不重试**（rate 不在
 * RETRYABLE_KINDS），该批直接判失败。兜底是 P8 的补跑 —— 缺的那批单独重跑，而不是整份
 * 4 批重来。单独开并发会把「偶发限流」放大成「缺组」，两条改动是配套的。
 *
 * ## 这条用例钉的三件事
 *
 *   ① 默认**真的并发**（第二个请求在第一个完成前就发出）；
 *   ② 合并**按批序**（并发只改「谁先回来」，不改「怎么拼」—— 否则 onPart 落库的批次顺序
 *      会随上游返回顺序抖动，补跑的 seed 也会跟着乱）；
 *   ③ `batchConcurrency = 1` 能完整回退成串行，且**不参与**失联上界（上界是悲观值，
 *      云端读不到这个参数，把上界除以并发数会重新引入抢锁）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')

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
 * 慢上游：每个请求睡 120ms，并记录「有没有两个请求同时在飞」。
 *
 * 为什么用重叠而不是闸门（等第 N 个请求到了再一起放行）：闸门在串行档会把第一个请求
 * 永久挂住，那条 promise 一直占着 chatJSON 的 deadline 定时器，跑完用例进程还得空等。
 * 重叠探测是纯被动的：串行时它自然为 false，不需要人为制造死锁。
 */
function slowUpstream() {
  const ctl = { arrived: 0, inFlight: 0, overlapped: false }
  env.registerCloudFn('aiProxy', async () => {
    ctl.arrived++
    ctl.inFlight++
    if (ctl.inFlight > 1) ctl.overlapped = true
    await new Promise((resolve) => setTimeout(resolve, 120))
    ctl.inFlight--
    return { ok: true, content: JSON.stringify({ intro: `intro-${ctl.arrived}` }) }
  })
  return ctl
}

describe('报告四批并行（P5）', () => {
  it('默认并发：第二个请求不等第一个回来就发，合并仍按批序', async () => {
    const load = fresh()
    const report = load('utils/report')
    const order = report.REPORT_BATCHES.map((b) => b.key).join(',')

    const ctl = slowUpstream()
    let collected = []
    const res = await report.buildReport('甲#tech', '甲', news(), 'all', {
      onPart: (parts) => {
        collected = parts.slice()
      }
    })

    ok(res.ok, '报告应生成成功')
    ok(ctl.overlapped, '四个批次没有并行 —— 第二个请求等到第一个结束才发（batchConcurrency 没生效）')
    eq(ctl.arrived, 4, '四个请求都发出去了（每批一次尝试）')
    eq(collected.length, 4, '四批都合并进 parts')
    eq(
      collected.map((p) => p.key).join(','),
      order,
      '合并必须按批序 —— 并发只改「谁先回来」，不该改「怎么拼」'
    )
  })

  it('batchConcurrency = 1 是完整回退：退回串行，一次只有一股在飞', async () => {
    const load = fresh()
    /* 直接改运行时对象（`as const` 只是类型约束）：这正是灰度回退时要改的那一处 */
    load('config/benefits').REPORT_BUILD.batchConcurrency = 1
    const report = load('utils/report')
    const ctl = slowUpstream()

    const res = await report.buildReport('甲#tech', '甲', news(), 'all', {})

    ok(res.ok, '串行档也应生成成功')
    notOk(ctl.overlapped, '并发度设成 1 后仍有请求重叠 —— 回退没生效')
    eq(ctl.arrived, 4, '串行档仍然跑满四批')
  })

  it('并行度来自真源，且刻意不进失联上界', () => {
    const load = fresh()
    eq(
      load('config/benefits').REPORT_BUILD.batchConcurrency,
      4,
      '默认并行度应为 4；灰度顺序建议 1 → 2 → 4'
    )

    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

    /*
     * 上界必须仍是**串行口径**的悲观值：云端 `report-store.js` 读同一组参数，但它不认识
     * `batchConcurrency`（云端不生成）。若把上界「除以并发数」，云端就会用一个它算不出来的
     * 数判失联 —— 直接回到抢锁老路（见文档 P1）。
     */
    const cache = strip(fs.readFileSync(path.join(ROOT, 'src/utils/cache.ts'), 'utf8'))
    const at = cache.indexOf('export const BUILDING_TIMEOUT_MS')
    ok(at > 0, 'cache.ts 里找不到 BUILDING_TIMEOUT_MS')
    const formula = cache.slice(at, at + 400)
    notOk(
      /batchConcurrency/.test(formula),
      '失联上界不许引入并行度 —— 它是悲观上界，云端读不到这个参数'
    )

    const report = strip(fs.readFileSync(path.join(ROOT, 'src/utils/report.ts'), 'utf8'))
    ok(
      report.includes('Math.min(REPORT_BUILD.batchConcurrency'),
      '批循环没有按并发度分股（并行没接上真源）'
    )
    ok(
      report.includes('results[index] = await runOne'),
      '结果必须按原下标落位，否则合并顺序会随上游返回顺序抖动'
    )
  })
})
