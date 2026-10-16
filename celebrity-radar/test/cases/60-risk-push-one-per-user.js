'use strict'

/**
 * 风险提醒的推送粒度：**每人每轮最多一条**（2026-10-16 修）。
 *
 * 要钉住的是「一次授权一条」这条硬约束在**三条推送链路上必须一致**：
 *   · `notifyFollowUpdates` 一直是每人一条（挑 `lead`，其余人数汇总进 `totalNew`）；
 *   · `keywordAlert` 一直是每人一条（取本轮新增最多的那个词）；
 *   · `riskWatch` **原先按名人发** —— `for (personKey) → for (watcher)`，于是一个盯了 3 个人的
 *     用户会在同一轮里被 send 三次。而 `users.risk_ok` 是**布尔**、一次授权只够一条，
 *     第一条发完即复位，第 2、3 条必然 43101 —— 落进 catch 只记一行 skipped，
 *     日志看起来「一切正常」，用户的体感却是「我盯了 3 个人，只有一个人的提醒来了」。
 *
 * 所以本用例断的是**真行为**（`subscribeMessage.send` 被调了几次、正文是谁），
 * 不是源码字面量：
 *   1. 同一用户盯 2 个人 → 只 send **1** 次（修复前是 2 次，第 2 次必 43101）；
 *   2. 正文挑「级别最高」的那一位，如实报出「N 人出现风险」，且**装得进 20 字符**不截断
 *      （类别被 clamp 从尾部切掉过一次，见下）；
 *   3. 没有授权位（`risk_ok` 非 true）的用户一条都不发（不许因为聚合而漏发 / 多发）；
 *   4. 同级别时的挑法**稳定**（不能每次跑都换一个人上正文）；
 *   5. 43101 仍然只记录不告警，且照样复位授权位；
 *   6. 静态兜底：发送不再嵌在「按名人」的内层循环里。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, eq, ok, notOk } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const RISK_SRC = fs.readFileSync(path.join(CLOUD, 'riskWatch', 'index.js'), 'utf8')

const HOUR = 3600 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

/* ─────────────────────────── 假上游（按 query 应答） ─────────────────────────── */

const searchOkItems = (items) => ({
  status: 200,
  data: { code: 200, data: { webPages: { value: items } } }
})

/**
 * 按**请求体里的 query** 决定返回什么。
 * 位置式（shift 队列）在「一台机器扫多个人 + 命中后各深挖一次」的场景里非常脆：
 * 顺序一变，断出来的就是假失败。这里改为认查询词，顺序无关。
 */
function fakeHttpsByQuery(handler) {
  const calls = []
  const module = {
    request(options, cb) {
      const chunks = []
      const req = {
        on() {
          return req
        },
        write(c) {
          chunks.push(c)
        },
        end() {
          const raw = chunks.join('')
          let body = raw
          try {
            body = JSON.parse(raw)
          } catch (e) {
            /* 只关心业务请求体 */
          }
          calls.push({ path: options.path, body })
          const r = handler(body) || searchOkItems([])
          const res = {
            statusCode: r.status,
            setEncoding() {},
            on(ev, fn) {
              if (ev === 'data') fn(typeof r.data === 'string' ? r.data : JSON.stringify(r.data))
              if (ev === 'end') fn()
              return res
            }
          }
          cb(res)
        },
        destroy() {}
      }
      return req
    }
  }
  return { module, calls }
}

/* ─────────────────────────── 加载定时云函数 ─────────────────────────── */

/** `opts.push(args)` 决定 send 的行为（默认成功）；`pushes` 记录每一次尝试 */
function loadRiskWatch(handler, opts = {}) {
  env.resetAll()
  delete process.env.BOCHA_API_KEY
  delete process.env.RISK_TEMPLATE_ID
  Object.assign(process.env, { BOCHA_API_KEY: 'k', RISK_TEMPLATE_ID: 'tmpl-risk' })
  Object.assign(process.env, opts.env || {})

  const http = fakeHttpsByQuery(handler)
  const pushes = []
  const db = env.db.database()
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => ({}), // 定时器：无调用方 openid
    openapi: {
      subscribeMessage: {
        send: (args) => {
          pushes.push(args)
          return (opts.push || (() => Promise.resolve({ errCode: 0 })))(args)
        }
      }
    }
  }
  const file = path.join(CLOUD, 'riskWatch', 'index.js')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    if (id === 'https') return http.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(file)]
    return { fn: require(file), pushes }
  } finally {
    Module.prototype.require = orig
  }
}

/* ─────────────────────────── 造库 ─────────────────────────── */

const personWatch = (openid, personKey, name) => ({
  _id: `${openid}#person#${personKey}`,
  openid,
  type: 'person',
  person_key: personKey,
  keyword: name,
  created_at: ago(48 * HOUR)
})

/** 有 baseline_at = 非首轮扫描（首轮只建档、不产生信号）；scanned_at 做旧以通过重扫间隔 */
const scanRow = (personKey, name) => ({
  _id: personKey,
  person_key: personKey,
  name,
  scanned_at: ago(25 * HOUR),
  baseline_at: ago(30 * HOUR),
  seen_urls: [],
  scanned: 0,
  signals_total: 0
})

const user = (openid, riskOk) => ({ _id: `row-${openid}`, _openid: openid, risk_ok: riskOk })

/**
 * 甲：`甲起诉造谣者` → 「起诉」后 8 字内有维权宾语 → rights = **mid**
 * 乙：`乙被起诉` → 默认按司法 → judicial = **high**
 * 丙：同甲，也走 rights = mid（用来验「同级别时挑法稳定」）
 */
const byName = (body) => {
  const q = String((body && body.query) || '')
  if (/最新进展$/.test(q)) return searchOkItems([]) // 深挖：空，本用例不关心
  if (q.includes('甲')) return searchOkItems([{ name: '甲起诉造谣者', url: 'https://n.example/甲1', snippet: '甲起诉造谣者' }])
  if (q.includes('乙')) return searchOkItems([{ name: '乙被起诉', url: 'https://n.example/乙1', snippet: '乙被起诉' }])
  if (q.includes('丙')) return searchOkItems([{ name: '丙起诉造谣者', url: 'https://n.example/丙1', snippet: '丙起诉造谣者' }])
  return searchOkItems([])
}

/* ═══════════════════════ ① 一个用户盯多个人 → 只发一条 ═══════════════════════ */

describe('riskWatch 推送粒度：每人每轮最多一条', () => {
  it('同一用户盯了 2 个人（都命中）→ 只 send 1 次，不靠「第 2 次必 43101」兜底', async () => {
    const { fn, pushes } = loadRiskWatch(byName)
    env.db.__seed('keyword_watches', [
      personWatch('u1', '甲#tech', '甲'),
      personWatch('u1', '乙#tech', '乙')
    ])
    env.db.__seed('risk_scans', [scanRow('甲#tech', '甲'), scanRow('乙#tech', '乙')])
    env.db.__seed('users', [user('u1', true)])

    const res = await fn.main({})

    eq(res.signals, 2, '两个人的信号都照常落库（推送粒度不改写库）')
    eq(pushes.length, 1, `一个用户只能发一条（一次授权一条）：实际发了 ${pushes.length} 条`)
    eq(res.pushed, 1)
    eq(res.pushedUsers, 1, '「本轮被打扰的用户数」与「发出去的条数」在同一口径上')
    ok(pushes.every((p) => p.touser === 'u1'), '只发给该用户本人')
  })

  it('正文挑「级别最高」的那一位，并如实报出「N 人出现风险」', async () => {
    const { fn, pushes } = loadRiskWatch(byName)
    env.db.__seed('keyword_watches', [
      personWatch('u1', '甲#tech', '甲'),
      personWatch('u1', '乙#tech', '乙')
    ])
    env.db.__seed('risk_scans', [scanRow('甲#tech', '甲'), scanRow('乙#tech', '乙')])
    env.db.__seed('users', [user('u1', true)])

    await fn.main({})

    const text = pushes[0].data.thing1.value
    ok(text.includes('2人出现风险'), `多个人命中时必须报出总数，否则用户以为只出事了 1 个：${text}`)
    ok(text.includes('「乙」'), `正文该给级别最高的那位（乙 = judicial/high，甲 = rights/mid）：${text}`)
    ok(text.includes('司法监管'), `正文要带类别，用户才知道是什么事：${text}`)
    notOk(text.includes('「甲」'), '级别较低的那位不占正文（它在预警页里）')
    ok(text.length <= 20, `thing1 上限 20 字符（超了会被 clamp 从尾部切掉，切掉的正好是类别）：${text.length} 字 —— ${text}`)
    notOk(text.includes('…'), '20 字够用，不该出现截断省略号')
  })

  it('3 字姓名也装得进 20 字符（不能靠 clamp 截断兜底）', async () => {
    const { fn, pushes } = loadRiskWatch((body) => {
      const q = String((body && body.query) || '')
      if (/最新进展$/.test(q)) return searchOkItems([])
      if (q.includes('甲')) return searchOkItems([{ name: '甲起诉造谣者', url: 'https://n.example/甲1', snippet: '甲起诉造谣者' }])
      if (q.includes('王小明')) return searchOkItems([{ name: '王小明被起诉', url: 'https://n.example/王1', snippet: '王小明被起诉' }])
      return searchOkItems([])
    })
    env.db.__seed('keyword_watches', [
      personWatch('u1', '甲#tech', '甲'),
      personWatch('u1', '王小明#tech', '王小明')
    ])
    env.db.__seed('risk_scans', [scanRow('甲#tech', '甲'), scanRow('王小明#tech', '王小明')])
    env.db.__seed('users', [user('u1', true)])

    await fn.main({})

    const text = pushes[0].data.thing1.value
    eq(text.length, 19, `实际文案：${text}`)
    ok(text.includes('司法监管'), `类别必须完整保留（它在文案尾部，最容易被切）：${text}`)
  })

  it('一个人命中时，正文仍是原有格式（信息不回退）', async () => {
    const { fn, pushes } = loadRiskWatch(byName)
    env.db.__seed('keyword_watches', [personWatch('u1', '乙#tech', '乙')])
    env.db.__seed('risk_scans', [scanRow('乙#tech', '乙')])
    env.db.__seed('users', [user('u1', true)])

    await fn.main({})

    eq(pushes.length, 1)
    const text = pushes[0].data.thing1.value
    ok(/^「乙」出现司法监管类表述：/.test(text), `单个人不必报总数，直接说事：${text}`)
    ok(text.includes('乙被起诉'), '正文带标题，用户不点开也能判断要不要看')
  })
})

/* ═══════════════════════ ② 不能因为聚合而漏发 / 多发 ═══════════════════════ */

describe('riskWatch 推送粒度：聚合不等于少发', () => {
  it('两个用户各盯一个人（都命中）→ 各发一条', async () => {
    const { fn, pushes } = loadRiskWatch(byName)
    env.db.__seed('keyword_watches', [
      personWatch('u1', '甲#tech', '甲'),
      personWatch('u2', '乙#tech', '乙')
    ])
    env.db.__seed('risk_scans', [scanRow('甲#tech', '甲'), scanRow('乙#tech', '乙')])
    env.db.__seed('users', [user('u1', true), user('u2', true)])

    const res = await fn.main({})

    eq(pushes.length, 2, '两个人各一条')
    eq(res.pushedUsers, 2)
    eq(
      pushes.map((p) => p.touser).sort().join(','),
      'u1,u2',
      '一条都不能少 —— 按用户聚合最容易出的错就是「只发了第一个」'
    )
  })

  it('没有授权位（risk_ok 非 true）的用户一条都不发', async () => {
    const { fn, pushes } = loadRiskWatch(byName)
    env.db.__seed('keyword_watches', [personWatch('u1', '乙#tech', '乙'), personWatch('u2', '乙#tech', '乙')])
    env.db.__seed('risk_scans', [scanRow('乙#tech', '乙')])
    /* u1 没授权、u2 有 —— 同一个人被两人监控，只该发给有授权的那位 */
    env.db.__seed('users', [user('u1', false), user('u2', true)])

    const res = await fn.main({})

    eq(pushes.length, 1)
    eq(pushes[0].touser, 'u2')
    eq(res.pushedUsers, 1)
    eq(res.users, 2, '「影响面」仍如实报 2 人（含没授权的那位），与「发了几条」不是一个数')
  })

  it('发完复位授权位（下次不再拿已消耗的授权去撞 43101）', async () => {
    const { fn } = loadRiskWatch(byName)
    env.db.__seed('keyword_watches', [personWatch('u1', '乙#tech', '乙')])
    env.db.__seed('risk_scans', [scanRow('乙#tech', '乙')])
    env.db.__seed('users', [user('u1', true)])

    await fn.main({})

    const row = env.db.__dump('users').find((u) => u._openid === 'u1')
    eq(row.risk_ok, false, '一次性订阅：这条用掉了授权，必须立刻复位')
  })
})

/* ═══════════════════════ ③ 同级别时挑法稳定 ═══════════════════════ */

describe('riskWatch 推送粒度：同级别时的挑法必须稳定', () => {
  it('两个同级别对象 → 两次独立运行给出同一个正文（不靠不稳定的排序）', async () => {
    const run = async () => {
      const { fn, pushes } = loadRiskWatch(byName)
      env.db.__seed('keyword_watches', [
        personWatch('u1', '甲#tech', '甲'),
        personWatch('u1', '丙#tech', '丙')
      ])
      env.db.__seed('risk_scans', [scanRow('甲#tech', '甲'), scanRow('丙#tech', '丙')])
      env.db.__seed('users', [user('u1', true)])
      await fn.main({})
      return pushes[0].data.thing1.value
    }

    const first = await run()
    const second = await run()

    eq(first, second, `同级别 + 无发布时间时正文不能每次换人：\n  ${first}\n  ${second}`)
    ok(
      /「甲」|「丙」/.test(first),
      `兜底必须是确定性的（当前按 personKey 升序）：${first}`
    )
  })
})

/* ═══════════════════════ ④ 失败仍然只记录不告警 ═══════════════════════ */

describe('riskWatch 推送粒度：43101 仍只记录不告警', () => {
  it('授权已消耗 → 记 skipped、复位授权位、不算 pushed', async () => {
    const fail = () => Promise.reject(Object.assign(new Error('user refuse'), { errCode: 43101 }))
    const { fn, pushes } = loadRiskWatch(byName, { push: fail })
    env.db.__seed('keyword_watches', [personWatch('u1', '甲#tech', '甲'), personWatch('u1', '乙#tech', '乙')])
    env.db.__seed('risk_scans', [scanRow('甲#tech', '甲'), scanRow('乙#tech', '乙')])
    env.db.__seed('users', [user('u1', true)])

    const res = await fn.main({})

    eq(pushes.length, 1, '失败也只尝试一次 —— 不能因为聚合又变成「失败后继续试下一人」')
    eq(res.pushed, 0)
    ok(
      res.skipped.some((s) => s && /43101|user refuse/.test(String(s.reason))),
      `该失败要留在回执里：${JSON.stringify(res.skipped)}`
    )
    eq(env.db.__dump('users').find((u) => u._openid === 'u1').risk_ok, false)
  })
})

/* ═══════════════════════ ⑤ 静态兜底：别改回去 ═══════════════════════ */

describe('riskWatch：发送点不许再嵌回「按名人」的内层循环', () => {
  it('按用户聚合（byUser）之后再发，且回执里有 pushedUsers', () => {
    ok(/const byUser = new Map\(\)/.test(RISK_SRC), '按用户聚合这一步不能被删掉')
    ok(/summary\.pushedUsers/.test(RISK_SRC), '回执要能回答「发了几条 / 打扰了几个人」')
    notOk(
      /for \(const \[personKey, view\] of worth\)[\s\S]{0,400}?subscribeMessage\.send/.test(RISK_SRC),
      '发送若回到「按名人」的循环里，盯多个人就必然 43101 且静默'
    )
  })

  it('三条推送链路的推送粒度口径写在源码里（下一个人改之前会先读到）', () => {
    ok(/一次授权只够一条/.test(RISK_SRC), '要写明这是授权模型约束，而不是「顺手优化」')
    ok(
      /notifyFollowUpdates|keywordAlert/.test(RISK_SRC),
      '要点出另外两条链路本来就是每人一条（同一口径，不是新发明）'
    )
  })
})
