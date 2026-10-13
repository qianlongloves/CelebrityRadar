'use strict'

/**
 * 权益配置真源与云端副本的一致性（`npm run config:sync` / `config:check` 的用例版）。
 *
 * ## 为什么要有这一条
 *
 * 真源机制最怕的不是「改错值」，而是**改完忘了同步** —— 云端副本还是旧的、端上已是新的，
 * 于是「会员页说 30 次、云端拦在第 3 次」。全程没有任何报错，也没有任何日志，
 * 只有用户觉得「这会员买了没用」。本用例把「忘了同步」变成一次红灯。
 *
 * 同时钉住机制本身不被绕过，共三件事：
 *   1. 真源**自包含**（同步脚本靠在 node 里执行它来生成副本，一旦 import 别的东西就会炸）
 *   2. 云函数读取方**从副本取值**，不许把手抄的数字写回去
 *   3. 端上 utils **re-export 真源**，不许自己再存一份权益表
 *
 * 改了权益数值时，正常流程是「改 src/config/benefits.ts → npm run config:sync → npm test」；
 * 本文件负责在漏掉中间那步时说话。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, eq, notOk } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(p, 'utf8')
const rel = (...parts) => path.join(ROOT, ...parts)

/** 同步脚本本体：被 require 时不会执行 main（它只导出函数） */
const sync = require(rel('scripts', 'sync-config.js'))

describe('权益配置真源 / 云端副本（config:sync 机制）', () => {
  it('真源自包含：同步脚本能在 node 里直接执行它', () => {
    /* 这条同时也是「真源没有 import 任何模块」的证明 —— 有 import 的话 loadSource() 会抛 */
    const data = sync.loadSource()
    eq(typeof data.MEMBER_BENEFITS.generatePerDay.free, 'number', '权益表要能被脚本读到')
    eq(typeof data.ABUSE_LIMITS.member, 'number')
    eq(typeof data.SEARCH_MAX.member, 'number')
    eq(typeof data.MAX_CHAT_CHARS, 'number')
    ok(Array.isArray(data.PLANS) && data.PLANS.length > 0, '套餐表要能被脚本读到')
  })

  it('云端副本与真源逐字节一致（改完真源忘跑 config:sync 就红）', () => {
    /* 逐条指名 `item.out` 而不是固定的副本名：多真源之后，各源的副本文件名并不相同 */
    const stale = sync.check().map((item) => `cloudfunctions/${item.fn}/${item.out}`)
    eq(
      stale.length,
      0,
      `以下副本与真源不一致，跑 npm run config:sync 修复：${stale.join(' / ') || '(无)'}`
    )
  })

  it('每个真源都能被脚本执行（自包含），且都得有数据导出', () => {
    for (const src of sync.SOURCES) {
      /* loadSource 会执行真源 —— 它一旦 import 了任何模块就会抛，这条即「自包含」的证明 */
      const data = sync.loadSource(src.source)
      ok(Object.keys(data).length > 0, `${src.key} 真源没有导出任何数据（是不是全写成了函数？）`)
      ok(
        sync.render(data, sync.makeHeader(src.source, src.out)).includes('module.exports'),
        `${src.key} 真源渲染不出生成物`
      )
    }
  })

  it('每份副本都落在云函数目录里，且带「自动生成」的抬头', () => {
    ok(sync.SOURCES.length > 0, '至少要有一个真源')
    for (const src of sync.SOURCES) {
      ok(src.targets.length > 0, `真源 ${src.key} 没有任何读取方（生成了也没人用）`)
      for (const fn of src.targets) {
        const file = rel('cloudfunctions', fn, src.out)
        ok(fs.existsSync(file), `cloudfunctions/${fn}/${src.out} 不存在`)
        const text = read(file)
        ok(text.includes('自动生成'), `${fn} 的副本缺「自动生成」抬头，容易被当成手写文件改掉`)
        ok(
          text.includes(`src/config/${src.key}.ts`),
          `cloudfunctions/${fn}/${src.out} 没写清真源在哪，改的人找不到源头`
        )
      }
    }
  })

  it('副本导出与真源数据一一对应（没有字段被静默丢掉）', () => {
    const data = sync.loadSource()
    const rendered = sync.render(data)
    for (const key of Object.keys(data)) {
      if (typeof data[key] === 'function' || data[key] === undefined) continue
      ok(rendered.includes(`"${key}"`), `真源的 ${key} 没有出现在生成物里`)
    }
  })

  it('云函数读取方都从副本取值，不许把手抄的数字写回去', () => {
    /*
     * 逐个点名，是因为「加一个新的读取方却忘了 require 副本」正是这套机制最容易退化的方式：
     * 手抄一份数字进去，当时值是对的，改动时才漂。
     */
    const readers = [
      ['aiProxy/quota.config.js', './benefits.config'],
      ['aiProxy/index.js', './benefits.config'],
      ['quotaGuard/index.js', './benefits.config'],
      ['payCreate/index.js', './benefits.config'],
      /* 关键词监控的新增上限（OPINION_LIMITS.watchCount）读取方 */
      ['keywordAlert/index.js', './benefits.config'],
      /* 「监控某人」的新增上限（OPINION_LIMITS.personWatchCount）读取方 */
      ['riskWatch/index.js', './benefits.config'],
      /* 用户配置真源的读取方：ensure 的默认值、set 的白名单与版本号都从副本取 */
      ['userInit/index.js', './user-defaults.config'],
      /* 一次性运维（存量行补齐）与 ensure 同语义：缺的键该补成什么，必须来自同一份真源 */
      ['userBackfill/index.js', './user-defaults.config']
    ]
    for (const [file, spec] of readers) {
      ok(
        read(rel('cloudfunctions', file)).includes(`require('${spec}')`),
        `cloudfunctions/${file} 没有 require ${spec}，是不是把手抄的数字写回去了？`
      )
    }
  })

  it('端上权益表 re-export 真源，不再自己存一份数字', () => {
    const member = read(rel('src', 'utils', 'member.ts'))
    ok(member.includes("from '../config/benefits'"), 'utils/member.ts 没有引用真源')
    notOk(
      /export const MEMBER_BENEFITS = \{/.test(member),
      'utils/member.ts 又自己定义了一份权益表 —— 那真源就白建了'
    )

    const pay = read(rel('src', 'utils', 'pay.ts'))
    ok(pay.includes("from '../config/benefits'"), 'utils/pay.ts 没有引用真源（套餐兜底应是派生值）')
    notOk(
      /priceFen: 990/.test(pay),
      'utils/pay.ts 又手写了价格 —— 套餐兜底必须从 PLANS 派生'
    )
  })

  it('条数区间自洽（min ≤ target ≤ max，且都不小于 1）', () => {
    const q = sync.loadSource().REPORT_QUOTAS
    const ranges = [
      ['dynamics', q.dynamicsMin, q.dynamicsTarget, q.dynamicsMax],
      ['quotes', q.quotesMin, q.quotesTarget, q.quotesMax],
      ['stance', q.stanceMin, null, q.stanceMax],
      ['timeline', q.timelineMin, q.timelineTarget, q.timelineMax],
      ['profile', q.profileMin, q.profileTarget, null]
    ]
    for (const [name, min, target, max] of ranges) {
      ok(min >= 1, `${name} 的下限至少是 1（给模型「给 0~N 条」毫无意义）`)
      if (max !== null) ok(max >= min, `${name} 的上限小于下限`)
      if (target !== null) ok(target >= min, `${name} 的「尽量给到」低于下限`)
      if (target !== null && max !== null) ok(target <= max, `${name} 的「尽量给到」超过上限`)
    }
    ok(q.analysisPointsMin >= 1, 'analysisPoints 的下限至少是 1')
  })

  it('提示词的条数取自真源，且没有残留的硬编码', () => {
    const src = read(rel('src', 'utils', 'report.ts'))

    /* 正向：条数必须来自真源 —— 改了真源的数值，提示词文本要跟着变 */
    for (const ref of [
      '${REPORT_QUOTAS.dynamicsMin}~${REPORT_QUOTAS.dynamicsMax}',
      '${REPORT_QUOTAS.quotesMin}~${REPORT_QUOTAS.quotesMax}',
      '${REPORT_QUOTAS.stanceMin}~${REPORT_QUOTAS.stanceMax}',
      '${REPORT_QUOTAS.timelineMin}~${REPORT_QUOTAS.timelineMax}',
      '${REPORT_FIELD_LIMITS.analysisPointMax}',
      '${REPORT_FIELD_LIMITS.profileMax}',
      '${REPORT_FIELD_LIMITS.relationMax}',
      '${REPORT_FIELD_LIMITS.endorseMax}',
      '${REPORT_FIELD_LIMITS.conflictMax}'
    ]) {
      ok(src.includes(ref), `提示词缺少来自真源的插值：${ref}`)
    }

    /*
     * 反向：这些字面量一旦回到源码里，就说明有人把插值改回了硬编码 —— 于是「改条数」又变回改代码。
     * 片段都带上条号或字段名，是为了**只命中提示词**：同一串数字出现在普通代码注释里是合理的
     * （例：某处注释写「对 2~4 个近期热点话题做判断」，那是说明，不是配置）。
     */
    for (const stale of [
      '给 3~6 条（素材充足时尽量给到 5 条）',
      '给 2~5 条（素材充足时尽量给到 4 条）',
      '给 3~8 条（素材充足时尽量给到 5 条）',
      'analysisPoints：3~4 条',
      'stance：2~4 个',
      '结构化人物档案 3~6 条',
      '最多 5 条，每条字段：name(对方姓名)',
      '最多 4 条，每条字段：when(',
      '最多 3 条，每条字段：topic(争议点'
    ]) {
      notOk(src.includes(stale), `提示词里还残留硬编码的条数：${stale}`)
    }
  })

  it('同步命令挂在 npm scripts 上（改了配置要有一条命令可跑）', () => {
    const pkg = JSON.parse(read(rel('package.json')))
    ok(pkg.scripts['config:sync'], '缺 config:sync')
    ok(pkg.scripts['config:check'], '缺 config:check（测试与 CI 用它做只读校验）')
  })
})
