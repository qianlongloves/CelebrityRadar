'use strict'

/**
 * 报告「争议」一键盯进展（S1-1，2026-10-16）。
 *
 * 这条链路把**报告里的存量内容**换成一次订阅：争议卡每条旁边的「盯这条进展」，把争议点原样
 * 当作**监测词**写进 keyword_watches（type='keyword'），由云函数 keywordAlert 每天 09:20 扫描。
 * 不新造集合、不新造扫描任务 —— 复用预警页手动加词的同一份额度与同一条推送。
 *
 * 正因为「原样当关键词用」，整条链路吊在一个跨文件前提上：
 *   报告落库时把 topic 裁到 12 字内（REPORT_FIELD_LIMITS.controversyTopicChars），
 *   而监测词上限也是 12（KEYWORD_MAX_CHARS）。
 * 两者一旦脱钩（有人觉得「争议点写详细点更好」把 topic 放宽到 16），一键盯不会报错，
 * 而是**对超长的那几条静默失效**：点了只弹一句「这条不能直接盯」。逐条差异行为用例很难覆盖，
 * 所以这里把两个真源直接比在一起（同 14-config-sync.js 的路子）。
 *
 * 另外钉住一条微信侧的硬约束 —— 破坏后**静默失效**，且 monitorPerson 已经踩过一次：
 * 订阅授权 requestAlertNotify() 必须是点击后的第一个 await，必须排在 addWatch 之前。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 注释里会写反例（如「不得写成 await addWatch 之后」），不剥会把反例当成真实用法 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')

const REPORT_PAGE = 'package/report/index.tsx'

describe('报告「争议」一键盯进展：用存量内容换一次订阅（S1-1）', () => {
  it('争议点的裁剪上限不超过监测词上限 —— 否则部分条目点了盯不上', () => {
    const limits = env.load('config/benefits').REPORT_FIELD_LIMITS
    const { KEYWORD_MAX_CHARS } = env.load('utils/keyword-alert')
    ok(
      limits.controversyTopicChars <= KEYWORD_MAX_CHARS,
      `报告把争议点裁到 ${limits.controversyTopicChars} 字，却超过监测词上限 ${KEYWORD_MAX_CHARS} 字：` +
        `超长的那几条会盯不上（validateKeyword 直接拒），而用户看到的是一句「这条不能直接盯」`
    )
  })

  it('监测词的边界就是报告承诺的字数（按字符计）', () => {
    const { KEYWORD_MAX_CHARS, validateKeyword } = env.load('utils/keyword-alert')
    /* 用等长填充而不是挑一个「看起来正好 12 字」的真词：中文手数字数最容易差一个，
       而这条要钉的恰恰是**边界那一个字** */
    ok(validateKeyword('雷'.repeat(KEYWORD_MAX_CHARS)).ok, `${KEYWORD_MAX_CHARS} 字应通过`)
    notOk(validateKeyword('雷'.repeat(KEYWORD_MAX_CHARS + 1)).ok, `${KEYWORD_MAX_CHARS + 1} 字应被拒`)
    /* 真实形态也过一遍：提示词里的争议点就是这个样子（10 字），别只剩边界断言在撑 */
    ok(validateKeyword('代言产品被指虚假宣传').ok, '典型争议点（10 字）应能直接当监测词')
  })

  it('争议卡有一键盯入口，且走 utils/keyword-alert 的 addWatch（不另起一套写库）', () => {
    const code = stripComments(read(REPORT_PAGE))
    ok(code.includes('监控这条进展'), '报告页「争议与回应」应给出一键监控入口')
    ok(
      /from '@\/utils\/keyword-alert'/.test(code),
      '盯进展必须复用 utils/keyword-alert：绕过去就绕过了分档门禁与归一化，也脱离预警页那条推送'
    )
    ok(code.includes('addWatch('), '盯进展要调 addWatch')
    ok(
      !/collection\('keyword_watches'\)/.test(code),
      '报告页不得直接写 keyword_watches（会跳过 watchGate 与 normalizeKeyword，同一份额度就管不住了）'
    )
  })

  it('订阅授权排在写库之前，且中间不夹别的 await —— 否则按钮在真机上直接失效', () => {
    const code = stripComments(read(REPORT_PAGE))
    const atAuth = code.indexOf('await requestAlertNotify()')
    const atAdd = code.indexOf('await addWatch(')
    ok(atAuth > 0, '盯进展应请求预警订阅授权（不请求则盯上了也永远收不到推送，只剩站内）')
    ok(atAdd > atAuth, 'requestAlertNotify 必须在 addWatch 之前：微信只认点击后第一个订阅授权调用')
    const between = code.slice(atAuth, atAdd)
    eq(
      (between.match(/await\s/g) || []).length,
      1,
      '授权与写库之间不能再夹 await（那会把授权挤出点击的同步调用栈）'
    )
  })

  it('盯上的词会进预警页那份列表，取消后真的消失（端到端）', async () => {
    env.resetAll()
    const auth = env.load('stores/auth')
    auth.useAuth.setState({ userId: 'me' })
    const ka = env.load('utils/keyword-alert')
    const topic = '代言产品被指虚假宣传'

    const res = await ka.addWatch(topic)
    ok(res.ok, `盯进展应成功：${res.message}`)
    const { keywords } = ka.splitWatches(await ka.listWatches())
    ok(
      keywords.some((w) => w.keyword === topic),
      '刚盯的词应出现在关键词监测列表里（预警页读的就是这一份）'
    )

    await ka.removeWatch(topic)
    const after = ka.splitWatches(await ka.listWatches())
    ok(!after.keywords.some((w) => w.keyword === topic), '取消盯之后不该还留在列表里 —— 否则「取消」是假的')
  })
})
