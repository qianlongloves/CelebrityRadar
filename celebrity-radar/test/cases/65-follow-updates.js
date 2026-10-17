'use strict'

/**
 * E1：跟进事件 = 订阅（2026-10-16）—— 端上角标口径 + 云端日报候选。
 *
 * 「跟进」此前只是一个站内开关（`opinion_event_status.follows`）：用户点了跟进，这件事再怎么发展
 * 他都只能靠自己回来看。这一轮把它接上第二类日报候选，于是要钉四件事：
 *
 *   1. **端上判据不被污染**：跟进不参与 `new / update / seen`（角标仍只看 `reads`），只多一个
 *      「我盯的 N 条有新进展」计数（`utils/inbox#countFollowUpdates`）—— 一条内容只能有**一个**
 *      「消掉」的动作，理由见 opinion-store 文件头「跟进」一节；
 *   2. **「全部已读」跳过已跟进的键**：一键清屏不该把用户明确点名要跟的事一起抹成「没事发生」；
 *   3. **云端把 follows 当候选**：判定 = `last_at > max(reads, 已提醒水位, follows)`，
 *      三个基线缺一个就会「天天重复提醒」或「误报早已结束的事」；
 *   4. **两类候选抢同一个 thing1**：会员优先「我盯的事」，免费档先给「关注的人」，
 *      且**没告诉他那条不许记水位**（记了等于以后都不提）。
 *
 * 云函数是 JS，用假 wx-server-sdk 加载（同 07 / 09 / 29 的做派）。默认**不注入 BOCHA_API_KEY**：
 * 跟进事件那类候选纯读库、不需要上游 —— 「上游 key 没配也照样能提醒我盯的事」靠这个默认值钉住。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const NOTIFY = path.join(ROOT, 'cloudfunctions', 'notifyFollowUpdates', 'index.js')

const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()
const ago = (ms) => iso(Date.now() - ms)
const ahead = (ms) => iso(Date.now() + ms)

/** 剥注释后再断言：源码里解释「为什么这么做」的注释不该被当成实现（同 18 / 45 / 63 的做法） */
function codeOf(rel) {
  return fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 假上游（本函数只用 https，不碰 cloud.ai）：按顺序吐预置响应，记下请求体（与 07 / 09 同形） */
function fakeHttps(responses) {
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
            /* 保持原样：这里只关心业务请求体 */
          }
          calls.push({ path: options.path, body })
          const r = responses.length ? responses.shift() : { status: 200, data: {} }
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

/**
 * 加载 notifyFollowUpdates：wx-server-sdk → harness 内存 DB，https → 假上游。
 * 推送结果可编程（`opts.push`），用于复刻 43101 / 瞬时失败。
 */
function loadNotify(opts) {
  opts = opts || {}
  env.resetAll()
  delete process.env.BOCHA_API_KEY
  delete process.env.SUBSCRIBE_TEMPLATE_ID
  Object.assign(process.env, opts.env || {})

  const db = env.db.database()
  const sent = []
  const push = opts.push || (() => Promise.resolve({ errCode: 0 }))
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => ({}),
    openapi: {
      subscribeMessage: {
        send: (args) => {
          sent.push(args)
          return push(args)
        }
      }
    }
  }

  const http = fakeHttps(opts.responses || [])
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fakeSdk
    if (id === 'https') return http.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(NOTIFY)]
    return { fn: require(NOTIFY), sent, calls: http.calls }
  } finally {
    Module.prototype.require = orig
  }
}

/* ─────────────────── 端上：我盯的 N 条有新进展（纯函数） ─────────────────── */

describe('端上 countFollowUpdates：只数已跟进的，且判据与角标同源', () => {
  it('跟进是订阅：没跟进的不算，跟进过但读过的也不算', () => {
    env.resetAll()
    const { countFollowUpdates } = env.load('utils/inbox')
    const evs = [
      { key: 'a', at: '2026-10-05T00:00:00.000Z' },
      { key: 'b', at: '2026-10-05T00:00:00.000Z' },
      { key: 'c', at: '2026-10-05T00:00:00.000Z' }
    ]
    const st = {
      reads: { b: '2026-10-06T00:00:00.000Z' },
      follows: { b: '2026-10-01T00:00:00.000Z', c: '2026-10-01T00:00:00.000Z' }
    }
    /* a 有新进展但没跟进 → 不算；b 跟进了但读过了 → 不算；c 跟进了且有新报道 → 算 */
    eq(countFollowUpdates(evs, st), 1)
    eq(countFollowUpdates(evs, { reads: {}, follows: {} }), 0, '一个都没跟进 → 0（不是「全部未读」）')
    eq(countFollowUpdates(evs, st, 2), 0, 'limit 与屏幕范围对齐：前 2 条里没有我盯的')
    eq(countFollowUpdates(evs, st, 3), 1)
  })

  it('脏数据不抛：空值 / 空键 / 时间不可解析', () => {
    env.resetAll()
    const { countFollowUpdates } = env.load('utils/inbox')
    eq(countFollowUpdates(null, null), 0)
    eq(countFollowUpdates([], { follows: { k: '2026-10-01T00:00:00.000Z' } }), 0)
    eq(
      countFollowUpdates([{ key: '' }, {}], { follows: { '': '2026-10-01T00:00:00.000Z' } }),
      0,
      '空键不算（脏行不许变成一次打扰）'
    )
    eq(
      countFollowUpdates([{ key: 'k', at: '不是日期' }], { follows: { k: '2026-10-01T00:00:00.000Z' } }),
      1,
      '没有已读标记 = 从没见过这件事 → new（与日期能不能解析无关，跟 eventNewness 同源）'
    )
    eq(
      countFollowUpdates([{ key: 'k', at: '2026-10-05T00:00:00.000Z' }], {
        reads: { k: '不是日期' },
        follows: { k: '2026-10-01T00:00:00.000Z' }
      }),
      0,
      '有已读标记但时刻算不出来 → seen：算不出就不猜'
    )
    eq(countFollowUpdates([{ key: 'k', at: '2026-10-05T00:00:00.000Z' }], { reads: {}, follows: null }), 0)
  })
})

/* ─────────────────── 云端：跟进事件进日报候选 ─────────────────── */

const KEY = 'evt-1'
const TMPL = { SUBSCRIBE_TEMPLATE_ID: 'tmpl-test' }

/** 一个已授权用户 + 他跟进的一件事 +（可选）事件行 */
function seedBase(opts) {
  opts = opts || {}
  env.db.__seed('users', [
    { _id: 'row-u1', _openid: 'u1', subscribe_ok: true, event_notified: opts.notified || {} }
  ])
  env.db.__seed('opinion_event_status', [
    {
      _id: 'u1',
      _openid: 'u1',
      follows: { [KEY]: opts.followsAt || ago(2 * DAY) },
      reads: opts.reads || {},
      updated_at: ''
    }
  ])
  if (opts.noEvent !== true) {
    env.db.__seed('opinion_events', [
      {
        _id: KEY,
        event_key: KEY,
        title: opts.title || '片场风波',
        last_at: opts.lastAt || ago(DAY)
      }
    ])
  }
}

const userRow = () => env.db.__dump('users')[0]

describe('云端 notifyFollowUpdates：跟进事件有新进展就提醒一次', () => {
  it('有新报道 → 发一条，正文指向事件页，写下「已提醒」水位并复位授权', async () => {
    const { fn, sent } = loadNotify({ env: TMPL })
    seedBase()
    const res = await fn.main({})
    eq(res.ok, true)
    eq(res.pushed, 1)
    eq(res.eventKeys, 1, '本轮有一个跟进的 event_key 参与判定')
    eq(res.targets, 0, '没配 BOCHA_API_KEY → 没有「关注的人」这类候选（不打上游），但事件照样提醒')
    eq(sent.length, 1)
    ok(/我盯的/.test(sent[0].data.thing1.value), `正文要说明这条是「我盯的事」（实际「${sent[0].data.thing1.value}」）`)
    eq(sent[0].page.indexOf('package/event/index?eventKey='), 0, '点了要能到事件详情页（分包路径 + eventKey 参数）')
    ok(typeof userRow().event_notified[KEY] === 'string', '水位：端上打开详情页刻意不自动标已读，没有它就会天天重复提醒')
    eq(userRow().subscribe_ok, false, '一次性订阅：发完立刻复位')
  })

  it('水位生效：同一件事第二轮不再打扰（哪怕用户从没点过已读）', async () => {
    const { fn, sent } = loadNotify({ env: TMPL })
    seedBase()
    await fn.main({})
    env.db.__seed('users', [Object.assign({}, userRow(), { subscribe_ok: true })])
    const again = await fn.main({})
    eq(again.pushed, 0, '上一轮已经提醒过 = 不再提（否则每天一条，用户会关掉整条通道）')
    eq(again.eventKeys, 1, '仍然参与判定（只是没有新进展），不是「没跟进」被跳过')
    eq(sent.length, 1)
  })

  it('读过了 / 跟进之后没有新报道 → 都不算「有新进展」', async () => {
    const a = loadNotify({ env: TMPL })
    seedBase({ reads: { [KEY]: ago(1000) } })
    eq((await a.fn.main({})).pushed, 0, '用户自己点过「标记已读」的，不该再被同一件事打扰')

    const b = loadNotify({ env: TMPL })
    seedBase({ lastAt: ago(3 * DAY), followsAt: ago(DAY) })
    eq((await b.fn.main({})).pushed, 0, '跟进一件早已结束的事，不该被误判成有新进展')
  })

  it('取不到事件行（被清理 / 键写错）→ 不发、也不记水位（不猜）', async () => {
    const { fn, sent } = loadNotify({ env: TMPL })
    seedBase({ noEvent: true })
    const res = await fn.main({})
    eq(res.pushed, 0)
    eq(sent.length, 0)
    eq(res.eventKeys, 1, '确实读到了跟进关系，只是事件行取不到')
    deepEq(userRow().event_notified, {}, '没发出去就不许记「已提醒」')
  })

  it('跟进的事件超过一个分块（20/块）也不丢行', async () => {
    const { fn, sent } = loadNotify({ env: TMPL })
    const keys = Array.from({ length: 25 }, (_, i) => `evt-${String(i + 1).padStart(2, '0')}`)
    const follows = {}
    /* 全部 3 天前跟进；1~24 件的最近报道比跟进更早（无进展），只有第 25 件（第二块里）有新报道 */
    keys.forEach((k) => {
      follows[k] = ago(3 * DAY)
    })
    env.db.__seed('users', [{ _id: 'row-u1', _openid: 'u1', subscribe_ok: true }])
    env.db.__seed('opinion_event_status', [{ _id: 'u1', _openid: 'u1', follows, reads: {}, updated_at: '' }])
    env.db.__seed(
      'opinion_events',
      keys.map((k, i) => ({
        _id: k,
        event_key: k,
        title: `事件${i + 1}`,
        last_at: i === keys.length - 1 ? ago(DAY) : ago(5 * DAY)
      }))
    )

    const res = await fn.main({})
    eq(res.pushed, 1)
    eq(res.eventKeys, 25)
    ok(
      sent[0].data.thing1.value.indexOf('事件25') >= 0,
      `第二块里的事件也要读到（实际正文「${sent[0].data.thing1.value}」）—— 分块大小一旦大于平台单次上限就会静默漏行`
    )
  })

  it('两类候选同时成立：会员正文给「我盯的事」，免费档先给「关注的人」，且不记那条没告诉他的水位', async () => {
    const { fn, sent } = loadNotify({
      env: Object.assign({ BOCHA_API_KEY: 'k' }, TMPL),
      responses: [
        {
          status: 200,
          data: {
            code: 200,
            data: {
              webPages: {
                value: [
                  { name: 't0', url: 'https://news.example.com/0', snippet: '正文' },
                  { name: 't1', url: 'https://news.example.com/1', snippet: '正文' }
                ]
              }
            }
          }
        }
      ]
    })
    env.db.__seed('users', [
      { _id: 'u-m', _openid: 'u-m', subscribe_ok: true },
      { _id: 'u-f', _openid: 'u-f', subscribe_ok: true }
    ])
    env.db.__seed('memberships', [{ _id: 'u-m', _openid: 'u-m', expires_at: ahead(10 * DAY) }])
    env.db.__seed('follows', [
      { _id: 'u-m#张三#ent', openid: 'u-m', person_key: '张三#ent', name: '张三' },
      { _id: 'u-f#张三#ent', openid: 'u-f', person_key: '张三#ent', name: '张三' }
    ])
    env.db.__seed('feed_cache', [
      { _id: '张三#ent', items: [{ title: '旧闻', url: 'https://news.example.com/old' }], fetched_at: ago(25 * 3600000) }
    ])
    env.db.__seed('opinion_event_status', [
      { _id: 'u-m', _openid: 'u-m', follows: { [KEY]: ago(2 * DAY) }, reads: {}, updated_at: '' },
      { _id: 'u-f', _openid: 'u-f', follows: { [KEY]: ago(2 * DAY) }, reads: {}, updated_at: '' }
    ])
    env.db.__seed('opinion_events', [{ _id: KEY, event_key: KEY, title: '片场风波', last_at: ago(DAY) }])

    const res = await fn.main({})
    eq(res.pushed, 2, '两类都成立时，两类候选都不该被丢掉（只是正文先给谁）')
    const byUser = {}
    sent.forEach((s) => {
      byUser[s.touser] = s
    })
    eq(byUser['u-m'].page.indexOf('package/event/index'), 0, `会员：跟进的事优先上正文（实际 ${byUser['u-m'].page}）`)
    eq(byUser['u-f'].page.indexOf('package/report/index'), 0, `免费档：先给「关注的人」（实际 ${byUser['u-f'].page}）`)
    const rows = env.db.__dump('users')
    const notified = (id) => {
      const r = rows.find((x) => x._id === id) || {}
      return (r.event_notified || {})[KEY]
    }
    ok(typeof notified('u-m') === 'string', '会员被告知了 → 记水位')
    eq(notified('u-f'), undefined, '免费档这条消息里没提到事件 → 不能记水位（记了以后再也不提）')
  })

  it('推送失败（43101 授权已消耗）不记水位：用户重新授权后还能补上这条提醒', async () => {
    let mode = 'refuse'
    const { fn, sent } = loadNotify({
      env: TMPL,
      push: () =>
        mode === 'refuse'
          ? Promise.reject(Object.assign(new Error('errCode: 43101'), { errCode: 43101, errMsg: 'errCode: 43101' }))
          : Promise.resolve({ errCode: 0 })
    })
    seedBase()
    const bad = await fn.main({})
    eq(bad.pushed, 0)
    eq(bad.skipped.length, 1, '失败要留痕（这类日志是唯一的线索）')
    deepEq(userRow().event_notified, {}, '没送出去就不许记「已提醒」')
    eq(userRow().subscribe_ok, false, '43101 = 授权已废，立刻复位别留着骗自己')

    env.db.__seed('users', [Object.assign({}, userRow(), { subscribe_ok: true })])
    mode = 'ok'
    const good = await fn.main({})
    eq(good.pushed, 1, '重新授权后这条提醒还能补上（这正是「失败不记水位」的意义）')
    eq(sent.length, 2, '两次尝试都记下来：第一次被 43101 拒了，第二次才发出去')
  })
})

/* ─────────────────── 静态约束：口径写在代码里，别只写在文档里 ─────────────────── */

describe('实现约束：角标口径单一、水位有上限、会员读权威表', () => {
  it('端上：跟进的语义要说给用户听（详情页）+ 提醒入口文案覆盖「我盯的事」', () => {
    const detail = codeOf('src/package/event/index.tsx')
    ok(detail.includes('page-event__follow-note'), '跟进按钮下面要写清后果（跟进 = 订阅，不是一个书签）')
    ok(
      /&__follow-note\s*\{/.test(codeOf('src/package/event/index.scss')),
      '分包页样式必须真的定义（漏了不报错，只是文案挤在按钮行里）'
    )
    /* 提醒入口 2026-10-17 迁到「我的 → 系统设置」（package/settings），文案随之搬过去 */
    const settings = codeOf('src/package/settings/index.tsx')
    ok(settings.includes('我盯的事'), '提醒入口的文案要覆盖两类候选（只写「关注的人」用户就不敢指望跟进会被提醒）')
  })

  it('端上：角标口径与跟进计数分两处，且都复用同一个 eventNewness', () => {
    const inbox = codeOf('src/utils/inbox.ts')
    ok(inbox.includes('eventNewness('), '跟进计数必须复用事件角标的判据，不能自己写一套')
    ok(inbox.includes('countFollowUpdates'), '导出给页面用')
    /* 反例守卫：别有人「顺手」把 follows 塞进角标判定里 —— 那会让点跟进吃掉角标 / 读完不消角标 */
    const store = codeOf('src/utils/opinion-store.ts')
    const newness = store.slice(store.indexOf('export function eventNewness'), store.indexOf('export function newnessLabel'))
    notOk(/follows/.test(newness), 'eventNewness 不得读 follows（理由见 opinion-store 文件头「跟进」一节）')
  })

  it('云端：分块大小不大于平台单次上限、水位有上限、会员读 memberships', () => {
    const src = fs.readFileSync(NOTIFY, 'utf8')
    ok(/EVENT_QUERY_CHUNK\s*=\s*20/.test(src), '分块大小取 20（平台单次 get 上限取小者，否则静默漏行）')
    ok(/db\.command\.in\(/.test(src), '按 event_key 批量取事件（不是把整表读回来）')
    ok(/EVENT_NOTIFIED_MAX\s*=\s*\d+/.test(src), '水位必须有上限，否则单文档无限长')
    ok(/collection\('memberships'\)\.doc\(openid\)/.test(src), '会员判定读 memberships（服务端权威表）')
    notOk(/u\.membership\b/.test(src), '不读 users.membership（端上镜像，会滞后）')
    ok(src.includes("listAll(STATUS_TABLE)"), '个人状态以管理员身份翻页读（本函数是这一行的第一个云端读口）')
    notOk(/\.limit\(\s*\d/.test(src), '仍然不该有字面量的裸 limit')
  })
})
