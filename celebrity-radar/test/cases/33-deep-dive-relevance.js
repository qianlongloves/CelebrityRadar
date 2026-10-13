'use strict'

/**
 * 深挖结果的**相关性闸门**（2026-10-13 修，线上实测暴露的缺陷）——
 * cloudfunctions/{keywordAlert,riskWatch} 的 `isDeepDiveRelated`。
 *
 * 缺陷：上游（博查）是**宽松匹配**。实测 `迪丽热巴 最新进展` 会带回与对象完全无关的条目
 * （赵丽颖昆仑饭店、萨利巴/阿森纳、TVB 女星退圈），而它们被**原样并入** `keywords.items`
 * ⇒ 下一轮 opinionCluster 把它们当作该关键词事件的补充成员 ⇒ 事件时间线变脏。
 *
 * 要钉住的四件事：
 *   1. **规则本身**：title+summary 含对象名（或其去间隔号/空格写法）才保留，否则丢弃；
 *   2. **别名缺失不误伤**：项目无权威别名词典，只有确定性变换 —— 半个名字不足以通过；
 *   3. **两侧一致**：keywordAlert 与 riskWatch 是**刻意的同源复制**，同一批输入结果必须相同；
 *   4. **只作用于深挖条目**：扫描命中判定与推送语义一个字不动；丢弃**计入回执**（不静默）。
 *
 * 加载方式与 31-deep-dive 一致：wx-server-sdk → 内存 DB，https → 可编程假上游。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, eq, deepEq, ok, notOk } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const CLOUD = path.join(ROOT, 'cloudfunctions')

const HOUR = 3600 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

/* ─────────────────────────── 假上游（http + https） ─────────────────────────── */

/** 一条博查返回：给定条目数组 */
const searchOkItems = (items) => ({
  status: 200,
  data: { code: 200, data: { webPages: { value: items } } }
})

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
            /* 只关心业务请求体 */
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

/** 加载一个定时任务云函数：wx-server-sdk → 内存 DB，https → 假上游 */
function loadTimerFn(name, responses, opts = {}) {
  env.resetAll()
  delete process.env.BOCHA_API_KEY
  delete process.env.ALERT_TEMPLATE_ID
  delete process.env.RISK_TEMPLATE_ID
  Object.assign(process.env, opts.env || {})

  const http = fakeHttps(responses)
  const db = env.db.database()
  const fake = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => ({}),
    openapi: { subscribeMessage: { send: () => Promise.resolve({ errCode: 0 }) } }
  }
  const file = path.join(CLOUD, name, 'index.js')
  const orig = Module.prototype.require
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fake
    if (id === 'https') return http.module
    return orig.apply(this, arguments)
  }
  try {
    delete require.cache[require.resolve(file)]
    return { fn: require(file), calls: http.calls }
  } finally {
    Module.prototype.require = orig
  }
}

/* ─────────────────────────── 造数据的小工具 ─────────────────────────── */

const wordWatch = (openid, keyword) => ({
  _id: `${openid}#${keyword}`,
  openid,
  keyword,
  type: 'keyword',
  created_at: ago(48 * HOUR)
})
const personWatch = (openid, personKey, name) => ({
  _id: `${openid}#person#${personKey}`,
  openid,
  type: 'person',
  person_key: personKey,
  keyword: name,
  created_at: ago(48 * HOUR)
})
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

/* 两个函数各加载一份（纯函数与两侧一致用）；模块级加载一次即可 */
const A = loadTimerFn('keywordAlert', [])
const R = loadTimerFn('riskWatch', [])
const item = (title, summary) => ({ title, summary: summary || '' })

/* ═════════════════════════ ① 相关性规则本身 ═════════════════════════ */

describe('深挖相关性判定 isDeepDiveRelated（纯函数）', () => {
  const rel = A.fn.isDeepDiveRelated

  it('含对象名的条目保留（title 命中 / summary 命中都算）', () => {
    eq(rel(item('迪丽热巴新剧开机', ''), '迪丽热巴'), true)
    eq(rel(item('某媒体独家报道', '迪丽热巴现身机场被围拍'), '迪丽热巴'), true)
  })

  it('不含对象名的条目丢弃（用线上实测那几条无关标题作数据）', () => {
    const noise = [
      '赵丽颖昆仑饭店约会疑恋情曝光',
      '萨利巴助阿森纳客场取胜',
      'TVB女星突然宣布退圈'
    ]
    for (const title of noise) eq(rel(item(title, ''), '迪丽热巴'), false, `不该保留：${title}`)
  })

  it('去间隔号 / 空格写法能匹配（「张·三」↔「张三」、拉丁名忽略空格与大小写）', () => {
    eq(rel(item('克里斯埃文斯谈新片', ''), '克里斯·埃文斯'), true)
    eq(rel(item('克里斯·埃文斯 谈新片', ''), '克里斯埃文斯'), true)
    eq(rel(item('taylorswift 巡演开票', ''), 'Taylor Swift'), true)
  })

  it('别名缺失时不误伤：半个名字不足以通过（不引入外部别名词典）', () => {
    /* 「迪丽热巴」的简称「热巴」「丽热巴」都不认 —— 宁可漏判，也不把别的条目放进来 */
    eq(rel(item('丽热巴现身机场', ''), '迪丽热巴'), false)
    eq(rel(item('热巴现身机场', ''), '迪丽热巴'), false)
  })

  it('对象名净化后为空（空串 / 纯符号）→ 不并入任何条目（防「空串匹配一切」）', () => {
    eq(rel(item('任意标题', '任意摘要'), ''), false)
    eq(rel(item('任意标题', '任意摘要'), ' ·  '), false)
    eq(rel(item('任意标题', '任意摘要'), undefined), false)
  })
})

/* ═════════════════════════ ② 两侧判定一致 ═════════════════════════ */

describe('深挖相关性判定：两侧同源一致（keywordAlert ↔ riskWatch）', () => {
  it('同一批输入两侧结果逐条相同', () => {
    const battery = [
      [item('迪丽热巴新剧开机', ''), '迪丽热巴'],
      [item('赵丽颖昆仑饭店', ''), '迪丽热巴'],
      [item('克里斯·埃文斯 谈新片', ''), '克里斯埃文斯'],
      [item('丽热巴', ''), '迪丽热巴'],
      [item('taylorswift 巡演', ''), 'Taylor Swift'],
      [item('某人被起诉', '某人被起诉'), '某人'],
      [item('无关标题', ''), ' · '],
      [item('', ''), '某人']
    ]
    const a = battery.map(([it, obj]) => A.fn.isDeepDiveRelated(it, obj))
    const r = battery.map(([it, obj]) => R.fn.isDeepDiveRelated(it, obj))
    deepEq(a, r, '两侧判定漂移（改一处须改两处）')
  })

  it('两侧 NAME_SEPARATORS 与 normalizeName 实现同源（源码级钉住）', () => {
    const a = fs.readFileSync(path.join(CLOUD, 'keywordAlert', 'index.js'), 'utf8')
    const r = fs.readFileSync(path.join(CLOUD, 'riskWatch', 'index.js'), 'utf8')
    const reSep = /const NAME_SEPARATORS = (\/.*?\/g)/
    ok(a.match(reSep) && r.match(reSep), '两侧都应定义 NAME_SEPARATORS')
    eq(a.match(reSep)[1], r.match(reSep)[1], 'NAME_SEPARATORS 正则必须逐字相同')
    const reFn = /function normalizeName\(text\) \{\s*\n\s*return String\(text \|\| ''\)\.toLowerCase\(\)\.replace\(NAME_SEPARATORS, ''\)/
    ok(reFn.test(a), 'keywordAlert 的 normalizeName 实现不符')
    ok(reFn.test(r), 'riskWatch 的 normalizeName 实现不符')
  })
})

/* ═════════════════════════ ③ 过滤只作用于深挖条目 + 回执 ═════════════════════════ */

describe('深挖相关性过滤：只作用于深挖条目、丢弃计入回执', () => {
  it('keywordAlert：深挖无关条目被丢弃并计入回执；扫描条目（不含对象名）照常保留、照常推送', async () => {
    const { fn } = loadTimerFn(
      'keywordAlert',
      [
        /* 扫描：1 条新报道，标题**不含**对象名 —— 扫描路径不该被相关性过滤影响 */
        searchOkItems([{ name: '一条与对象无关的扫描条目', url: 'https://n.example/s1', snippet: 'x' }]),
        /* 深挖：1 条相关 + 2 条实测无关 */
        searchOkItems([
          { name: '迪丽热巴最新进展回应', url: 'https://n.example/d1', snippet: '回应' },
          { name: '赵丽颖昆仑饭店约会', url: 'https://n.example/d2', snippet: '恋情' },
          { name: '萨利巴助阿森纳取胜', url: 'https://n.example/d3', snippet: '英超' }
        ])
      ],
      { env: { BOCHA_API_KEY: 'k' } }
    )
    env.db.__seed('keyword_watches', [wordWatch('u1', '迪丽热巴')])

    const res = await fn.main({})

    eq(res.deep_dive.hits, 1)
    eq(res.deep_dive.queries, 1)
    eq(res.deep_dive.filtered, 2, '两条无关深挖条目应被丢弃并计数')
    ok(
      res.skipped.some((s) => String(s).includes('与命中对象无关')),
      `丢弃必须计入回执、不静默：${JSON.stringify(res.skipped)}`
    )

    /* 扫描/推送语义不受影响：扫描新条目仍触发 userNews */
    eq(res.users, 1, '扫描命中与推送语义不该被相关性过滤改变')

    const cache = env.db.__dump('keywords').find((row) => row._id === '迪丽热巴')
    ok(cache, '关键词缓存应被写出')
    const urls = (cache.items || []).map((i) => i.url)
    ok(urls.includes('https://n.example/s1'), `扫描条目应保留（不过相关性闸门）：${JSON.stringify(urls)}`)
    ok(urls.includes('https://n.example/d1'), '含对象名的深挖条目应保留')
    notOk(urls.includes('https://n.example/d2'), '无关深挖条目不该并入（赵丽颖）')
    notOk(urls.includes('https://n.example/d3'), '无关深挖条目不该并入（萨利巴）')
  })

  it('riskWatch：深挖条目除命中词典外还需与对象相关；无关条目丢弃、相关但无风险的不计 filtered', async () => {
    const { fn } = loadTimerFn(
      'riskWatch',
      [
        /* 扫描：命中司法词典 → 触发深挖 */
        searchOkItems([{ name: '某人被起诉', url: 'https://n.example/s1', snippet: '某人被起诉' }]),
        searchOkItems([
          /* 相关 + 命中风险词典 → 应补成 signal */
          { name: '某人被立案调查', url: 'https://n.example/d1', snippet: '立案调查' },
          /* 无关（不含对象名）——即便含风险词也不该落 signal，且计入 filtered */
          { name: '赵丽颖被起诉离婚', url: 'https://n.example/d2', snippet: '被起诉' },
          /* 相关但不命中风险词典 → 既不落 signal，也不算 filtered（词典闸门既有口径不动） */
          { name: '某人的新电影开机', url: 'https://n.example/d3', snippet: '新片开机' }
        ])
      ],
      { env: { BOCHA_API_KEY: 'k' } }
    )
    env.db.__seed('keyword_watches', [personWatch('u1', 'P1#tech', '某人')])
    env.db.__seed('risk_scans', [scanRow('P1#tech', '某人')])

    const res = await fn.main({})

    eq(res.deep_dive.queries, 1)
    eq(res.deep_dive.filtered, 1, '只有「无关」那条计入 filtered')
    eq(res.signals, 2, '扫描 1 条 + 深挖相关且命中词典 1 条')

    const rows = env.db.__dump('risk_signals')
    const urls = rows.map((r) => r.url)
    ok(urls.includes('https://n.example/s1'), '扫描命中应落 signal（不受相关性闸门影响）')
    ok(urls.includes('https://n.example/d1'), '相关且命中的深挖条目应落 signal')
    notOk(urls.includes('https://n.example/d2'), '无关条目不该落 signal（含风险词也不行）')
    notOk(urls.includes('https://n.example/d3'), '相关但无风险词的条目不该落 signal（词典口径不变）')
  })
})
