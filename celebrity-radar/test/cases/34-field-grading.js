'use strict'

/**
 * 分级字段上游化（P4-B，2026-10-13）——把「类别 / 级别」在**云端产出时**就写进舆情条目，
 * 使端上舆情判断层不再恒判「未评级 / 未知」。
 *
 * 背景：端上 utils/opinion-rank.ts 的 impactOf 只认条目自带的 level 字段、responseOf 只认
 * category + level；而原先**只有 risk_signals** 带这两个字段 —— 关注动态（feed_cache）与
 * 关键词预警（keywords.items）都没有，于是它们的「影响面」恒为未评级、「是否需回应」恒为未知，
 * 事件聚合的「影响面取成员最高」也基本失效。
 *
 * 本用例钉住六件事：
 *   1. **本地确定性分级（零新增上游成本）**：命中风险词典才产出 category/category_label/level；
 *   2. **诚实分级**：未命中**一律不产出任何字段**（端上保持未评级 / 未知，不给默认值、不猜）；
 *   3. **端上兼容旧缓存**：有字段的条目正确分级、无字段的（旧缓存）仍按未评级且不抛；
 *   4. **事件聚合自动受益**：影响面取成员最高能吃到条目级新字段（端上 + 云函数两侧）；
 *   5. **两条云端写入路径**：cache.ts 写 feed_cache、keywordAlert 写 keywords.items；
 *   6. **词典两端一致**：keywordAlert 复制的词典与 src/utils/risk.ts 逐字同源（漂移即红）。
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

/* ─────────────────────────── 端上：risk.ts#riskFieldsOf ─────────────────────────── */

describe('端上词典：riskFieldsOf 命中即产出三件套、未命中返回 null', () => {
  function R() {
    env.resetAll()
    return env.load('utils/risk')
  }

  it('命中词典 → 正确的类别 / 类别标签 / 级别', () => {
    const { riskFieldsOf } = R()
    deepEq(riskFieldsOf('某明星因偷税被调查'), { category: 'tax', category_label: '税务合规', level: 'high' })
    deepEq(riskFieldsOf('品牌方宣布与其解约'), { category: 'contract', category_label: '商业合作', level: 'mid' })
    deepEq(riskFieldsOf('工作室发声明澄清'), { category: 'statement', category_label: '回应表态', level: 'low' })
  })

  it('未命中 → 返回 null（不产出任何字段；端上据此保持未评级 / 未知）', () => {
    const { riskFieldsOf } = R()
    eq(riskFieldsOf('新片今日开机，主创亮相'), null)
    eq(riskFieldsOf(''), null)
    eq(riskFieldsOf('翻车了 / 塌房了'), null, '评价性词汇不在词典内，不得据此分级')
  })

  it('否定词排除与双向词方向判定与 buildRiskSignals 同口径', () => {
    const { riskFieldsOf } = R()
    eq(riskFieldsOf('工作室否认被起诉'), null, '「否认被起诉」是假信号')
    deepEq(
      riskFieldsOf('本人起诉长期造谣者'),
      { category: 'rights', category_label: '名誉维权', level: 'mid' },
      '双向动词后跟维权对象 → 名誉维权'
    )
    deepEq(riskFieldsOf('某人被起诉'), { category: 'judicial', category_label: '司法监管', level: 'high' })
  })

  it('级别只由类别决定（RISK_LEVEL_OF = 云端 LEVEL_OF 同源）', () => {
    const { RISK_LEVEL_OF } = R()
    deepEq(RISK_LEVEL_OF, { judicial: 'high', tax: 'high', contract: 'mid', rights: 'mid', statement: 'low' })
  })
})

/* ─────────────────────────── 端上：feed_cache 写入即补字段 ─────────────────────────── */

describe('关注动态：写入 feed_cache 时补条目级分级字段', () => {
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

  it('命中词典的动态落 category/level，未命中的不落任何字段', async () => {
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
    ok(!!row, 'feed_cache 应被写出')
    const hit = row.items.find((i) => i.url === 'https://n.example/a')
    const miss = row.items.find((i) => i.url === 'https://n.example/b')
    eq(hit.category, 'judicial')
    eq(hit.level, 'high')
    eq(hit.category_label, '司法监管')
    notOk('category' in miss || 'level' in miss, '未命中词典的条目不得落分级字段（旧口径不变）')
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

const wordWatch = (openid, keyword) => ({
  _id: `${openid}#${keyword}`,
  openid,
  keyword,
  type: 'keyword',
  created_at: ago(48 * HOUR)
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

/* ─────────────────────────── 词典两端一致（漂移即红） ─────────────────────────── */

/**
 * keywordAlert 复制了一份风险词典（与 riskWatch / src/utils/risk.ts 同源，云函数不能跨函数
 * require）。这里读 keywordAlert **源码**字面量、与端上真源逐条比对 —— 有人只改一端就红，
 * 与 01-pure.js 的「风险词典两端一致（riskWatch ↔ risk.ts）」同一套写法。
 */
describe('风险词典两端一致（keywordAlert ↔ src/utils/risk.ts）', () => {
  const src = fs.readFileSync(path.join(CLOUD, 'keywordAlert', 'index.js'), 'utf8')

  /** 从云函数源码里抠出顶层 `const NAME = <字面量>` 并求值（数组 / 对象 / 数字） */
  function literal(name) {
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

  it('词表逐条相同、顺序也相同（命中取第一个词，顺序变了结果就变）', () => {
    const { RISK_TERMS } = risk()
    deepEq(literal('RISK_TERMS'), RISK_TERMS.map((t) => ({ word: t.word, category: t.category })))
  })

  it('否定词表 / 窗口、双向词方向判定相同', () => {
    const { NEG_WORDS, NEG_WINDOW, BIDIRECTIONAL_TERMS, RIGHTS_OBJECTS, RIGHTS_AFTER_WINDOW } = risk()
    deepEq(literal('NEG_WORDS'), NEG_WORDS)
    eq(literal('NEG_WINDOW'), NEG_WINDOW)
    deepEq(literal('BIDIRECTIONAL_TERMS'), BIDIRECTIONAL_TERMS)
    deepEq(literal('RIGHTS_OBJECTS'), RIGHTS_OBJECTS)
    eq(literal('RIGHTS_AFTER_WINDOW'), RIGHTS_AFTER_WINDOW)
  })

  it('类别标签相同、级别只由类别决定（LEVEL_OF ↔ RISK_LEVEL_OF）', () => {
    const { RISK_CATEGORY_LABEL, RISK_LEVEL_OF } = risk()
    deepEq(literal('CATEGORY_LABEL'), RISK_CATEGORY_LABEL)
    deepEq(literal('LEVEL_OF'), RISK_LEVEL_OF)
  })
})
