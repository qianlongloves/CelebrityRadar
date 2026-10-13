'use strict'

/**
 * 分级字段上游化（P4-B，2026-10-13）——把「类别 / 级别」的**权威产出位置**放在云端写口，
 * 端上只透传 / 展示，不再自行判定（本轮从「端上 cache.ts 写入前补」改为「云端写口补」）。
 *
 * 背景：端上 utils/opinion-rank.ts 的 impactOf 只认条目自带的 level 字段、responseOf 只认
 * category + level；而原先**只有 risk_signals** 带这两个字段 —— 关注动态（feed_cache）与
 * 关键词预警（keywords.items）都没有，于是它们的「影响面」恒为未评级、「是否需回应」恒为未知，
 * 事件聚合的「影响面取成员最高」也基本失效。
 *
 * 本用例钉住六件事：
 *   1. **本地确定性分级（零新增上游成本）**：命中风险词典才产出 category/category_label/level；
 *   2. **诚实分级**：未命中**一律不落任何字段**（端上保持未评级 / 未知，不给默认值、不猜）；
 *   3. **端上不再自行分级**：写口可用时端上把检索结果原样交给写口（不预分级）；写口不可用回退
 *      直写这一路写出的条目**没有**分级字段（端上只透传 / 展示，见 cache.ts#writeFeedCache）；
 *   4. **端上兼容旧缓存**：有字段的条目正确分级、无字段的（旧缓存 / 回退产物）仍按未评级且不抛；
 *   5. **两条云端写入路径**：aiProxy#saveFeed 写 feed_cache、keywordAlert 写 keywords.items；
 *   6. **词典几处同源**：aiProxy / keywordAlert 复制的词典与 src/utils/risk.ts 逐字同源（漂移即红）。
 *
 * 加载方式：端上纯函数走 env.load（编译产物）；云函数走 wx-server-sdk → 内存 DB 的替身
 * （与 31/33 同法，https → 可编程假上游）。
 */

const fs = require('fs')
const path = require('path')
const Module = require('module')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const CLOUD = path.join(ROOT, 'cloudfunctions')
const BUILD = path.join(ROOT, 'test', '.build')

const HOUR = 3600 * 1000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

/* ─────────────────────────── 端上：不再自行分级（云端写口才是权威） ─────────────────────────── */

describe('关注动态：端上只透传、不产出分级字段（分级权威在云端写口）', () => {
  /** 让「云环境已配置」为真（口径同 05-feed-cost） */
  function configureCloud() {
    require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
  }
  function fresh() {
    env.resetAll()
    env.setDebugFlags({ disableRefreshQuota: false, disableCooldown: false })
    configureCloud()
    return env.load
  }
  function login(id = 'me') {
    env.load('stores/auth').useAuth.getState().setLogin({ userId: id })
  }

  it('写口可用时，端上把检索结果原样交给写口（不预分级，即便标题命中词典）', async () => {
    const load = fresh()
    login()
    let saved = null
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action === 'search') {
        return {
          ok: true,
          pages: [{ name: '某明星被起诉', url: 'https://n.example/a', snippet: '某明星被起诉' }]
        }
      }
      if (data.action === 'report' && data.op === 'saveFeed') {
        saved = data
        return { ok: true, result: 'saved' }
      }
      return { ok: false }
    })
    const { refreshFeed } = load('utils/cache')

    const out = await refreshFeed('P0#tech', 'P0')
    eq(out.ok, true)
    ok(!!saved, '写口可用时必须走写口，不落端上直写')
    const sent = saved.items.find((i) => i.url === 'https://n.example/a')
    ok(!!sent, '端上应把条目交给写口')
    notOk(
      'category' in sent || 'level' in sent || 'category_label' in sent,
      '端上不再分级：交给写口的条目不得预置分级字段（分级由云端写口做）'
    )
  })

  it('写口不可用回退直写：条目原样落库、不带任何分级字段（诚实的降级缺口）', async () => {
    const load = fresh()
    login()
    /* aiProxy 只处理 search：写口（action=report）返回 {ok:false} → 端上回退直写 feed_cache */
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action !== 'search') return { ok: false }
      return {
        ok: true,
        pages: [
          { name: '某明星被起诉', url: 'https://n.example/a', snippet: '某明星被起诉' },
          { name: '片场探班花絮', url: 'https://n.example/b', snippet: '片场探班花絮' }
        ]
      }
    })
    const { refreshFeed } = load('utils/cache')

    const out = await refreshFeed('P0#tech', 'P0')
    eq(out.ok, true)

    const row = env.db.__dump('feed_cache').find((r) => r._id === 'P0#tech')
    ok(!!row, 'feed_cache 应被写出（回退直写）')
    const hit = row.items.find((i) => i.url === 'https://n.example/a')
    /* 即便标题命中词典，端上也不落字段 —— 这正是「端上不再承担权威标注」的后果：
       回退路径写出的条目在端上判断层按「未评级 / 未知」对待（它只在云端写口不可用时发生）。 */
    notOk(
      'category' in hit || 'level' in hit || 'category_label' in hit,
      '端上不再分级：回退直写路径不得落分级字段（分级权威在云端写口）'
    )
  })
})

/* ─────────────────────────── 端上：判断层对两种缓存都正确 ─────────────────────────── */

describe('端上判断层：有字段据实分级、无字段（旧缓存）仍为未评级且不抛', () => {
  function loadRank() {
    env.resetAll()
    return env.load('utils/opinion-rank')
  }

  it('有条目级字段 → 影响面 / 需回应据其推导；无字段 → 未评级 / 未知', () => {
    const { buildOpinionQueue } = loadRank()
    const queue = buildOpinionQueue({
      watchNames: ['张三'],
      feed: [
        /* 旧缓存形态：没有 category/level */
        { block: 'feed', title: '新片开机', source: 'A报', date: '2026-10-09', person: '张三' },
        /* 新缓存形态：写入时已补条目级字段 */
        {
          block: 'feed',
          title: '被诉侵权',
          source: 'B报',
          date: '2026-10-08',
          person: '张三',
          category: 'judicial',
          level: 'high'
        }
      ]
    })
    const byTitle = (t) => queue.find((e) => e.title === t)
    eq(byTitle('新片开机').impact, 'unknown', '无字段 = 未评级（旧缓存必须仍按此处理）')
    eq(byTitle('新片开机').response, 'unknown')
    eq(byTitle('被诉侵权').impact, 'high', '有条目级字段即据实分级')
    eq(byTitle('被诉侵权').response, 'respond')
  })

  it('非法 category/level（脏数据）不认，回退未评级且不抛', () => {
    const { buildOpinionQueue } = loadRank()
    const q = buildOpinionQueue({ feed: [{ title: 'X', source: 'A报', category: 'weird', level: '极高' }] })
    eq(q.length, 1)
    eq(q[0].impact, 'unknown')
    eq(q[0].category, undefined)
  })
})

/* ─────────────────────────── 端上：事件聚合影响面取最高 ─────────────────────────── */

describe('事件聚合：影响面取成员最高（吃到条目级新字段）', () => {
  it('同事件内一条 high → 整体 high（平均值会稀释，这里取上界）', () => {
    env.resetAll()
    const { buildOpinionEvents } = env.load('utils/opinion-events')
    const ev = buildOpinionEvents({
      alerts: [
        { block: 'alert', title: '关于Z公司的声明', source: 'A报', date: '2026-10-01', category: 'contract', level: 'mid' },
        {
          block: 'alert',
          title: '【重磅】关于Z公司的声明',
          source: 'B报',
          date: '2026-10-02',
          category: 'judicial',
          level: 'high'
        }
      ]
    })[0]
    eq(ev.memberCount, 2)
    eq(ev.impact, 'high', '成员里有一条 high → 事件按 high 对待')
    ok(
      ev.members.every((m) => m.level),
      '成员各自保留条目级 level（时间线上可回放到是哪一条把影响面抬高）'
    )
  })
})

/* ─────────────────────────── 云函数加载替身（与 31/33 同法） ─────────────────────────── */

const searchOkItems = (items) => ({ status: 200, data: { code: 200, data: { webPages: { value: items } } } })

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

/** 加载一个云函数：wx-server-sdk → 内存 DB，https → 假上游 */
function loadCloudFn(name, responses, opts = {}) {
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
    getWXContext: () => (opts.openid ? { OPENID: opts.openid } : {}),
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

const wordWatch = (openid, keyword) => ({
  _id: `${openid}#${keyword}`,
  openid,
  keyword,
  type: 'keyword',
  created_at: ago(48 * HOUR)
})

/* ─────────────────────── 云端：aiProxy 写口（action:report / op:saveFeed）补字段 ─────────────────────── */

describe('aiProxy 写口：写入 feed_cache 前补条目级分级字段（权威产出位置）', () => {
  it('命中词典的条目落三件套；未命中不落；客户端自报的假级别被抹掉（写口权威）', async () => {
    const { fn } = loadCloudFn('aiProxy', [], { openid: 'u1' })
    const res = await fn.main({
      action: 'report',
      op: 'saveFeed',
      personKey: 'P0#tech',
      items: [
        { title: '某明星被起诉', url: 'https://n.example/a', source: 'A报' },
        { title: '今日片场探班花絮', url: 'https://n.example/b', source: 'B报' },
        /* 端上不该自报级别；万一带着（改包 / 旧版本），写口以词典为准，一并抹掉 */
        { title: '普通的一天', url: 'https://n.example/c', category: 'judicial', level: 'high' }
      ]
    })
    eq(res.ok, true)
    eq(res.result, 'saved')

    const row = env.db.__dump('feed_cache').find((r) => r._id === 'P0#tech')
    ok(!!row, 'feed_cache 应被写出')

    const hit = row.items.find((i) => i.url === 'https://n.example/a')
    eq(hit.category, 'judicial')
    eq(hit.category_label, '司法监管')
    eq(hit.level, 'high')

    const miss = row.items.find((i) => i.url === 'https://n.example/b')
    notOk('category' in miss || 'level' in miss || 'category_label' in miss, '未命中词典不落任何字段')

    const forged = row.items.find((i) => i.url === 'https://n.example/c')
    notOk('category' in forged || 'level' in forged, '写口是权威：客户端自报的级别被抹掉，以词典判定为准')
  })

  it('词典判定与端上同源：否定词 / 双向词方向同口径（写口产出）', async () => {
    const { fn } = loadCloudFn('aiProxy', [], { openid: 'u1' })
    await fn.main({
      action: 'report',
      op: 'saveFeed',
      personKey: 'P1#tech',
      items: [
        { title: '工作室否认被起诉', url: 'https://n.example/x' },
        { title: '本人起诉长期造谣者', url: 'https://n.example/y' }
      ]
    })
    const row = env.db.__dump('feed_cache').find((r) => r._id === 'P1#tech')
    const x = row.items.find((i) => i.url === 'https://n.example/x')
    notOk('category' in x, '「否认被起诉」是假信号，不得分级')
    const y = row.items.find((i) => i.url === 'https://n.example/y')
    eq(y.category, 'rights', '双向动词后跟维权对象 → 名誉维权')
    eq(y.level, 'mid')
  })
})

/* ─────────────────────────── 云端：keywordAlert 写 keywords.items 补字段 ─────────────────────────── */

describe('keywordAlert：写入 keywords.items 时补条目级分级字段', () => {
  it('命中词典的扫描条目落三件套；未命中的不落；深挖相关且命中的条目同样落', async () => {
    const { fn } = loadCloudFn(
      'keywordAlert',
      [
        /* 扫描：一条命中司法词典 + 一条普通报道 */
        searchOkItems([
          { name: '某明星被起诉', url: 'https://n.example/s1', snippet: '某明星被起诉' },
          { name: '今日片场探班', url: 'https://n.example/s2', snippet: '今日片场探班' }
        ]),
        /* 深挖：相关（含对象名）且命中词典（「辟谣」→ 回应表态） */
        searchOkItems([{ name: '迪丽热巴 工作室就传闻辟谣', url: 'https://n.example/d1', snippet: '辟谣' }])
      ],
      { env: { BOCHA_API_KEY: 'k' } }
    )
    env.db.__seed('keyword_watches', [wordWatch('u1', '迪丽热巴')])

    const res = await fn.main({})
    eq(res.ok, true)

    const row = env.db.__dump('keywords').find((r) => r._id === '迪丽热巴')
    ok(!!row, 'keywords 缓存应被写出')
    const s1 = row.items.find((i) => i.url === 'https://n.example/s1')
    const s2 = row.items.find((i) => i.url === 'https://n.example/s2')
    eq(s1.category, 'judicial')
    eq(s1.category_label, '司法监管')
    eq(s1.level, 'high')
    notOk('category' in s2 || 'level' in s2, '未命中词典的扫描条目不得落字段（保持未评级）')

    const d1 = row.items.find((i) => i.url === 'https://n.example/d1')
    ok(!!d1, '深挖条目应并入缓存')
    eq(d1.category, 'statement', '深挖条目也按同一词典判定')
    eq(d1.level, 'low')
  })

  it('riskFieldsOf 纯函数：命中产出三件套、未命中返回空对象（不落字段）', () => {
    const { fn } = loadCloudFn('keywordAlert', [])
    deepEq(fn.riskFieldsOf('被起诉'), { category: 'judicial', category_label: '司法监管', level: 'high' })
    deepEq(fn.riskFieldsOf('普通的一天'), {}, '未命中返回 {}，展开后不落任何字段')
  })
})

/* ─────────────────────────── 云端：opinionCluster 透传条目级字段 ─────────────────────────── */

describe('opinionCluster：落库事件的影响面吃到 feed / keywords 的条目级字段', () => {
  it('feed 条目自带 level=high → 落库事件 impact=high；不带字段的条目仍 unknown', async () => {
    const { fn } = loadCloudFn('opinionCluster', [])
    env.db.__seed('feed_cache', [
      {
        _id: '张三#ent',
        items: [
          {
            title: '关于X公司起诉事件的声明',
            source: 'A报',
            publishedDate: '2026-10-01',
            category: 'judicial',
            level: 'high'
          }
        ],
        fetched_at: ''
      }
    ])

    const res = await fn.main({})
    eq(res.ok, true)
    eq(res.upstream, 0, '本函数只读库，不消耗上游')

    const rows = env.db.__dump('opinion_events')
    eq(rows.length, 1)
    eq(rows[0].impact, 'high', 'feed 条目带的 level 应参与事件影响面（否则恒为未评级）')
  })
})

/* ─────────────────────────── 词典几处一致（漂移即红） ─────────────────────────── */

/**
 * aiProxy（report-store.js）与 keywordAlert **各自复制**了一份风险词典（云函数不能跨函数
 * require，与 riskWatch / src/utils/risk.ts 同源）。这里读两份云函数**源码**字面量、与端上真源
 * 逐条比对 —— 有人只改一处就红，与 01-pure.js 的「风险词典两端一致（riskWatch ↔ risk.ts）」
 * 同一套写法。端上 risk.ts 是词表真源（buildRiskSignals 仍在用它）。
 */
describe('风险词典几处一致（aiProxy · keywordAlert ↔ src/utils/risk.ts）', () => {
  const SOURCES = {
    aiProxy: fs.readFileSync(path.join(CLOUD, 'aiProxy', 'report-store.js'), 'utf8'),
    keywordAlert: fs.readFileSync(path.join(CLOUD, 'keywordAlert', 'index.js'), 'utf8')
  }

  /** 从某份云函数源码里抠出顶层 `const NAME = <字面量>` 并求值（数组 / 对象 / 数字） */
  function literalFrom(src, name) {
    const head = `const ${name} = `
    const at = src.indexOf(head)
    if (at < 0) throw new Error(`云函数源码里未找到 ${head}`)
    const start = at + head.length
    const open = src[start]
    if (open !== '[' && open !== '{') {
      const nl = src.indexOf('\n', start)
      return new Function(`return (${src.slice(start, nl).trim()})`)()
    }
    const close = open === '[' ? ']' : '}'
    let depth = 0
    for (let j = start; j < src.length; j++) {
      if (src[j] === open) depth++
      else if (src[j] === close) {
        depth--
        if (depth === 0) return new Function(`return (${src.slice(start, j + 1)})`)()
      }
    }
    throw new Error(`const ${name} 字面量未闭合`)
  }

  function risk() {
    env.resetAll()
    return env.load('utils/risk')
  }

  for (const label of Object.keys(SOURCES)) {
    const literal = (name) => literalFrom(SOURCES[label], name)

    it(`[${label}] 词表逐条相同、顺序也相同（命中取第一个词，顺序变了结果就变）`, () => {
      const { RISK_TERMS } = risk()
      deepEq(literal('RISK_TERMS'), RISK_TERMS.map((t) => ({ word: t.word, category: t.category })))
    })

    it(`[${label}] 否定词表 / 窗口、双向词方向判定相同`, () => {
      const { NEG_WORDS, NEG_WINDOW, BIDIRECTIONAL_TERMS, RIGHTS_OBJECTS, RIGHTS_AFTER_WINDOW } = risk()
      deepEq(literal('NEG_WORDS'), NEG_WORDS)
      eq(literal('NEG_WINDOW'), NEG_WINDOW)
      deepEq(literal('BIDIRECTIONAL_TERMS'), BIDIRECTIONAL_TERMS)
      deepEq(literal('RIGHTS_OBJECTS'), RIGHTS_OBJECTS)
      eq(literal('RIGHTS_AFTER_WINDOW'), RIGHTS_AFTER_WINDOW)
    })

    it(`[${label}] 类别标签相同、级别只由类别决定（LEVEL_OF ↔ RISK_LEVEL_OF）`, () => {
      const { RISK_CATEGORY_LABEL, RISK_LEVEL_OF } = risk()
      deepEq(literal('CATEGORY_LABEL'), RISK_CATEGORY_LABEL)
      deepEq(literal('LEVEL_OF'), RISK_LEVEL_OF)
    })
  }
})
