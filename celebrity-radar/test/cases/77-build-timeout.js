'use strict'

/**
 * 构建时限：端上与云端必须用**同一组参数**（P1，2026-10-17）。
 *
 * ## 这条用例要防的是什么
 *
 * 不是「值写错了」，而是**两侧各自写一个数字**这件事本身。此前的现场：
 * 端上 `cache.ts#BUILDING_TIMEOUT_MS` 随「单批 3 次尝试 + 整份自动重跑」涨到 1125s，
 * 云端 `report-store.js` 还停在 `405 * 1000`（4 批 × 2 次 × 45s + 45s 的旧口径），
 * 而它的注释明确写着「须与端上同值」—— 注释没有任何执行力。
 *
 * 代价不是「多等一会」：真实耗时超过 405s 的构建会被云端判为失联、被第二个人抢锁；
 * 旧构建者落库时又被 `storeSave` 的 builder 校验拒绝（kind='lock'，不回退直写）
 * ⇒ 那一次几十分钟的 token 全废，用户拿到旧版或失败。
 *
 * 现在参数唯一来源是 `src/config/benefits.ts#REPORT_BUILD`，两端各自现算。
 * 本用例钉四件事：批数与模板组数一致、端上由真源派生、云端由副本派生、两侧算出同一个值。
 * 另钉 P3：在途占位 TTL 独立且远短于锁上界（照抄锁上界会让一次失败冻结名额近 19 分钟）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** 真源里的那组参数（同步脚本能在 node 里直接执行 benefits.ts，用例 14 已证明这条路可用） */
const sync = require(path.join(ROOT, 'scripts', 'sync-config.js'))
const { REPORT_BUILD } = sync.loadSource()

const REFS = [
  'REPORT_BUILD.batchCount',
  'REPORT_BUILD.batchAttempts',
  'REPORT_BUILD.generateAttempts',
  'REPORT_BUILD.chatDeadlineMs',
  'REPORT_BUILD.searchBudgetMs',
  'REPORT_BUILD.slackMs'
]

/** 上界算式：两端必须共用这一条（写在用例里，任何一侧换算式都会红） */
const calc = (b) =>
  b.batchCount * b.batchAttempts * b.generateAttempts * b.chatDeadlineMs +
  b.searchBudgetMs +
  b.slackMs

describe('构建时限：端上 / 云端同源（P1、P3）', () => {
  it('batchCount 必须等于 REPORT_BATCHES.length', () => {
    /*
     * 批数的真源是 utils/report.ts#REPORT_BATCHES（18 节分 4 组），云端拿不到它，
     * 所以 REPORT_BUILD 里刻意再写一次。这条断言就是「重复但不许漂」的保险：
     * 改模板组数时它会红，而不是让云端继续按 4 批判失联。
     */
    const { REPORT_BATCHES } = env.load('utils/report')
    eq(
      REPORT_BUILD.batchCount,
      REPORT_BATCHES.length,
      'REPORT_BUILD.batchCount 与 REPORT_BATCHES.length 不一致：改模板组数后要同步真源'
    )
  })

  it('端上从真源现算，手抄的常量不许回来', () => {
    const src = read('src/utils/cache.ts')
    for (const ref of REFS) {
      ok(src.includes(ref), `cache.ts 的上界没有引用 ${ref}（是不是又手抄了数字？）`)
    }
    notOk(
      /const CHAT_SINGLE_DEADLINE_MS/.test(src),
      'cache.ts 又自己存了一份 45s —— 那正是上次两端漂移的起点'
    )
    notOk(
      /BUILDING_TIMEOUT_MS =\s*\d/.test(src),
      '上界不许写成字面量：参数变化时它不会跟着动'
    )
  })

  it('云端从同一份副本现算，405s 那个旧值不许回来', () => {
    const src = read('cloudfunctions/aiProxy/report-store.js')
    /*
     * 先剥注释再断言：这个文件的注释里**故意**写着「这里本来是 `const ... = 405 * 1000`」，
     * 那是给后来人看的历史缘由，不是代码。不剥的话静态断言会把解释当成违规
     * （70-bundle 的 barrel 禁止、63/68 的同类断言都踩过这个坑）。
     */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    ok(code.includes("require('./benefits.config')"), 'report-store.js 没有 require 真源副本')
    for (const ref of REFS) {
      ok(code.includes(ref), `report-store.js 的上界没有引用 ${ref}`)
    }
    notOk(/405\s*\*\s*1000/.test(code), '405s 已随「端上 1125s」一起废弃，不许写回云端')
    notOk(
      /const BUILDING_TIMEOUT_MS = \d/.test(code),
      '云端上界不许写死成数字 —— 注释说「须与端上同值」是没用的，同源才有执行力'
    )
  })

  it('两侧算出来是同一个值，且与端上当前值一致', () => {
    /* 副本与真源的一致性由用例 14 兜底；这里再算一遍，是为了让「参数改了一侧」当场可见 */
    const cloud = require(path.join(ROOT, 'cloudfunctions', 'aiProxy', 'benefits.config.js')).REPORT_BUILD
    eq(calc(REPORT_BUILD), calc(cloud), '真源与云端副本算出的上界不同（跑 npm run config:sync）')
    /*
     * 锚点：4 批 × 3 次 × 2 遍 × 45s + 15s + 30s = 1125s。
     * 它红有两种可能，都该停下来想一下：① 无意中改了参数；② 有意改 —— 那要把
     * doc/报告生成流程问题清单.md 的「数字口径」与等待体验一起复核。
     */
    eq(calc(REPORT_BUILD), 1125 * 1000, '构建上界变了：确认有意为之，并同步 doc/报告生成流程问题清单.md')
  })

  it('在途占位 TTL 独立、远短于锁上界（P3）', () => {
    /*
     * 占位只干一件事：让「同一用户在生成窗口里再点一次」看到少一格，挡住两个人物并发突破额度。
     * 它该覆盖一次正常生成（40~100s），而不是「构建可能还在跑」的悲观上界（1125s）——
     * 照抄锁上界时，一次失败/中途退出就会把名额冻结近 19 分钟，当天只剩 1 次的用户被
     * 「今日次数已用完」挡住，而 used 根本没变。
     */
    const src = read('src/utils/cache.ts')
    ok(/const INFLIGHT_TTL_MS = 180 \* 1000/.test(src), '占位 TTL 应是独立的 INFLIGHT_TTL_MS = 180s')
    ok(
      src.includes('beginGenerateInflight(userId, personKey, INFLIGHT_TTL_MS'),
      '占位调用处没有用 INFLIGHT_TTL_MS'
    )
    notOk(
      src.includes('beginGenerateInflight(userId, personKey, BUILDING_TIMEOUT_MS'),
      '占位 TTL 不许再用锁上界 —— 那会把一次失败冻结成 19 分钟的名额损失'
    )
    ok(180 * 1000 < calc(REPORT_BUILD), '占位 TTL 必须短于锁上界，否则这条修改没有意义')
  })
})
