'use strict'

/**
 * R-2 会员入口埋点（分子 `member_entry` + 分母 `report_lock_see`，2026-10-16）：
 * `utils/member-entry.ts`（唯一跳转口）+ 报告页五种升级位各报各的来源。
 *
 * 这一版要钉的是「转化率到底算不算得出来」。做错的形态全都长得像对的 ——
 * 用户照常被带到会员页、文案也通顺，只是那两个数永远凑不出来：
 *
 *   1. **入口只许有一处跳转**。十几个入口各写一句 `Taro.navigateTo`，新增的那处忘了带埋点
 *      = 线上多一个没人数的入口，而这件事在界面上完全看不出来（同 utils/pay.ts 收口下单函数）。
 *   2. **分子与分母是两件事**。只有「点了几次」而没有「看到过几次」，比例就只能写「算不出」
 *      —— S1-4 当时就是这么卡住的（见 events.ts#opinion_pick 的注释），R-2 此前一模一样：
 *      9 处入口零埋点、`pages/member` 里 `track(` 出现 0 次。
 *   3. **先报再跳**。报的是「**点了**这个入口」，跳转失败也算一次点击。
 *   4. **分母不许按渲染次数计**。重渲染与「看了几眼」无关，多报 = 系统性低估转化率。
 *   5. **会员态、以及页面上本来就没有锁态的访问，都不进分母**。
 *
 * 功能口径用假 db + Taro 替身直接跑，接线与顺序走源码级静态断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(p, 'utf8')

/**
 * 剥掉注释再断言：本版代码里刻意写了很多「不该这样」的说明性注释
 * （例如「页面里不再出现裸的 Taro.navigateTo」），不剥注释就会把**说明**当成违规
 * （同 18 / 45 / 63 / 68 的手法）。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const MEMBER_ENTRY_TS = stripComments(read(path.join(SRC, 'utils', 'member-entry.ts')))
const EVENTS_TS = read(path.join(SRC, 'utils', 'events.ts'))
const REPORT_PAGE = stripComments(read(path.join(SRC, 'package', 'report', 'index.tsx')))
const SCHEMA = read(path.resolve(SRC, '..', 'cloudfunctions', 'dbInit', 'schema.js'))

function fresh() {
  env.resetAll()
  return env
}

/** track 是 void 的异步写，落库要等一个微任务（同 02-data / 03-quota-qa） */
const tick = () => new Promise((r) => setTimeout(r, 0))

/* ═══════════════ 1. 分子：一次点击 = 一条埋点 + 一次跳转 ═══════════════ */

describe('R-2 分子：会员入口只有一个跳转口（openMemberPage）', () => {
  it('一次点击 = 一条 member_entry + 一次 navigateTo', async () => {
    const e = fresh()
    e.load('utils/member-entry').openMemberPage('qa')
    await tick()
    const rows = e.db.__dump('events')
    eq(rows.length, 1, '一次点击只报一条')
    eq(rows[0].event, 'member_entry')
    eq(rows[0].props.from, 'qa')
    const nav = e.taroCallsOf('navigateTo')
    eq(nav.length, 1, '一次点击只跳一次（别顺手多跳一个页面）')
    eq(nav[0].args[0].url, '/package/member/index')
  })

  it('from 原样进 props —— 来源必须能拆开，合成一个就再也分不出是哪种呈现', async () => {
    const e = fresh()
    const m = e.load('utils/member-entry')
    m.openMemberPage('report_lock')
    m.openMemberPage('report_preview')
    m.openMemberPage('mine_quality')
    await tick()
    deepEq(e.db.__dump('events').map((r) => r.props.from), [
      'report_lock',
      'report_preview',
      'mine_quality'
    ])
  })

  it('页面路径不进 props（from 是入口标识，不是路由）', async () => {
    const e = fresh()
    e.load('utils/member-entry').openMemberPage('workbench')
    await tick()
    const props = e.db.__dump('events')[0].props
    eq(Object.keys(props).length, 1, 'props 只有 from 一个键，多塞字段会让报表口径变糊')
    notOk(/package\/member/.test(String(props.from)))
  })

  it('⚠ 先报再跳：报的是「点了」，跳转失败也算一次点击', () => {
    const iTrack = MEMBER_ENTRY_TS.indexOf("track('member_entry'")
    const iNav = MEMBER_ENTRY_TS.indexOf('Taro.navigateTo(')
    ok(iTrack > 0 && iNav > 0)
    ok(iTrack < iNav, '顺序反了/挂在跳转回调里 = 路由异常时点击量少一截')
  })

  it('未登录也照报（openid 为空，但「点了入口」这件事仍然发生过）', async () => {
    const e = fresh()
    e.load('utils/member-entry').openMemberPage('event')
    await tick()
    const row = e.db.__dump('events')[0]
    ok(!row.openid, '用例环境没登录，openid 应为空')
    eq(row.event, 'member_entry', '埋点不因为没登录就少一条')
  })
})

/* ═══════════════ 2. 接线：页面里不再出现裸跳转 ═══════════════ */

/** 每个入口的「页面 → from」对照。新增入口时**这行必须一起出现**，否则就是漏报。 */
const ENTRY_SITES = [
  ['components/qa-panel/index.tsx', 'qa'],
  ['pages/mine/index.tsx', 'mine'],
  ['pages/mine/index.tsx', 'mine_quality'],
  ['package/workbench/index.tsx', 'workbench'],
  ['package/alerts/index.tsx', 'alerts'],
  ['package/weekly/index.tsx', 'weekly'],
  ['package/report-history/index.tsx', 'history'],
  ['package/event/index.tsx', 'event']
]

describe('R-2 接线：所有入口都走 openMemberPage（页面里不再有裸跳转）', () => {
  for (const [rel, from] of ENTRY_SITES) {
    it(`${rel} → from='${from}'`, () => {
      const src = stripComments(read(path.join(SRC, rel)))
      ok(src.includes(`openMemberPage('${from}')`), `这里没带来源，或没走收口函数`)
      ok(/from '@\/utils\/member-entry'/.test(src), '要 import 收口函数，不能自己拼 navigateTo')
      notOk(src.includes("url: '/package/member/index'"), '页面里不该再有裸跳转')
    })
  }

  it('⚠ 全项目只有 member-entry.ts 里出现那个 url（收口成立）', () => {
    const hit = []
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name)
        if (fs.statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name) && stripComments(read(p)).includes('/package/member/index')) {
          hit.push(path.relative(SRC, p).split(path.sep).join('/'))
        }
      }
    }
    walk(SRC)
    deepEq(hit.sort(), ['utils/member-entry.ts'], '多一处 = 那个入口报不出来')
  })
})

/* ═══════════════ 3. 分母：报告页五种升级位各报各的 ═══════════════ */

describe('R-2 报告页：四种呈现带来源，锁态卡一张不落', () => {
  it('四种呈现各是一个 from（合成一个 = R-2 拆不开「哪种呈现推动了转化」）', () => {
    for (const from of ['report_lock', 'report_preview', 'report_promo', 'report_toc', 'report_export']) {
      ok(REPORT_PAGE.includes(`onPromoTap('${from}')`), `少了来源 ${from}`)
    }
  })

  it('⚠ 锁态卡张数 = 会员档节数：每张卡都得带来源，漏一张那张就没人替它数', () => {
    const toc = env.load('utils/report-toc')
    const n = (REPORT_PAGE.match(/onOpen=\{\(\) => onPromoTap\('report_lock'\)\}/g) || []).length
    eq(n, toc.MEMBER_TOC_COUNT, `锁态卡应有 ${toc.MEMBER_TOC_COUNT} 张带来源`)
  })

  it('没有裸的 onOpen / onClick={onPromoTap} 残留（残留处 = 点了但没人数的入口）', () => {
    notOk(/onOpen=\{onPromoTap\}/.test(REPORT_PAGE))
    notOk(/onClick=\{onPromoTap\}/.test(REPORT_PAGE))
  })

  it('截断提示（还有 N 条）也带来源，且与锁态卡分开', () => {
    const n = (REPORT_PAGE.match(/onClick=\{\(\) => onPromoTap\('report_preview'\)\}/g) || []).length
    ok(n >= 1, `四处截断提示都该带来源，实际 ${n} 处`)
  })
})

/* ═══════════════ 4. 分母：三条守卫，一次访问一条 ═══════════════ */

describe('R-2 分母：只在免费态且真出现锁态时上报，一次访问一条', () => {
  it("上报的是 report_lock_see，locked / cut 分开（两种呈现的效果要能分开看）", () => {
    ok(/track\('report_lock_see', \{ locked: tocLocked\.length, cut: lockCut \}\)/.test(REPORT_PAGE))
  })

  it('cut = 四处速览被藏起来的条数之和（漏一处 = 分母少算一种锁态）', () => {
    ok(
      /const lockCut =\s*profilePreview\.hidden \+ relationsPreview\.hidden \+ dynamicsPreview\.hidden \+ quotesPreview\.hidden/.test(
        REPORT_PAGE
      )
    )
  })

  it('⚠ 会员态不报、memberReady 之前不报（否则会把会员当免费读者报一遍）', () => {
    ok(/if \(!report \|\| !memberReady \|\| member\) return/.test(REPORT_PAGE))
  })

  it('⚠ 本来就没有锁态的访问不进分母（否则转化率被系统性低估）', () => {
    ok(/if \(tocLocked\.length === 0 && lockCut === 0\) return/.test(REPORT_PAGE))
  })

  it('⚠ 同一份报告只报一条：按 personKey 记已报过，重渲染不再补', () => {
    ok(/if \(lockSeen\.current === report\.personKey\) return/.test(REPORT_PAGE))
    ok(/lockSeen\.current = report\.personKey/.test(REPORT_PAGE))
  })
})

/* ═══════════════ 5. 登记：events.ts 的联合类型 + dbInit 的 enumHint ═══════════════ */

describe('R-2 登记：埋点声明与字段登记（events.ts / dbInit）', () => {
  it("events.ts 的联合类型里有 'member_entry' 与 'report_lock_see'", () => {
    ok(/'member_entry'/.test(EVENTS_TS))
    ok(/'report_lock_see'/.test(EVENTS_TS))
  })

  it('props 口径写清：from（入口标识）与 locked / cut（锁态张数 / 截断条数）', () => {
    ok(/props\.from/.test(EVENTS_TS), '不写清 from 是什么，报表上就只剩一个字符串')
    ok(/props\.locked/.test(EVENTS_TS))
    ok(/props\.cut/.test(EVENTS_TS))
  })

  it('dbInit 在 events 的 enumHint 里登记了两个新事件（沿用 event_subscribe 的追加方式）', () => {
    ok(/'revisit_open', 'event_subscribe', 'report_lock_see', 'member_entry'/.test(SCHEMA))
  })
})
