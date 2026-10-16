'use strict'

/**
 * 埋点**登记制**：`src/utils/events.ts#TrackEvent` ⇄ `cloudfunctions/dbInit/schema.js` 的
 * `events.event.enumHint` 必须双向一致（2026-10-16）。
 *
 * 这两份名单的处境是「**真源在端上、副本在云侧**」：schema.js 是云函数文件，读不到 `src/`，
 * 所以只能手抄 —— 而手抄的名单在没有任何东西盯着的时候会**静默落后**。
 *
 * 2026-10-16 补齐前实测：联合类型 37 个，enumHint 只有 17 个，**少 20 个**。
 * 少的恰好都是「没被顺手追加」的那批（watch_add / report_export / workbench_*
 * / report_history_view / opinion_pick …），而**被追加过的**恰恰只有最近几次改动里
 * 有人记得同步的那几个（revisit_* / event_subscribe / report_lock_see / member_entry）。
 * 这条规律本身就是证据：缺的不是知识，是**没有一个会变红的东西**。
 *
 * 为什么值得单列一条用例（而不是靠 code review）：
 *   · 它不会以「报错」的形态暴露 —— 埋点照常写入，只是**名单上看不见**，
 *     于是任何照着 enumHint 做的口径普查都会得出「项目一共就这几个事件」的错结论；
 *   · 而 release-check 的人工步骤里恰好写着「对一下云侧与端上的口径」，指着这份名单看。
 *     ⇒ 一份落后 54% 的名单比没有名单更坏，它会让人**确信自己看全了**。
 *
 * ⚠ 只钉**名单**（集合相等），不钉顺序：顺序没有语义，钉了只会让新增事件时多一处无谓摩擦。
 * 同时钉住「声明了就必须有人报」—— 声明了却没有任何 `track(...)` 调用点，等于那个
 * 分子 / 分母在现实里不存在（这正是 report_open / opinion_pick 当初的毛病）。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(p, 'utf8')

/** 剥注释：本文件与 schema 的注释里大量出现事件名与「不该这样」的说明，不剥会误判 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const EVENTS_SRC = read(path.join(SRC, 'utils', 'events.ts'))
const EVENTS_CODE = stripComments(EVENTS_SRC)
const SCHEMA = read(path.resolve(SRC, '..', 'cloudfunctions', 'dbInit', 'schema.js'))

/** `TrackEvent` 的成员（`| 'name'` 这一形态在该文件里只可能是联合类型成员） */
function declaredNames() {
  return [...EVENTS_CODE.matchAll(/\|\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1])
}

/** `events.event.enumHint` 的成员：多张表都有 enumHint，故先按特征值定位到 events 那张 */
function hintedNames() {
  const hints = [...SCHEMA.matchAll(/enumHint:\s*\[([^\]]*)\]/g)].map((m) => m[1])
  const line = hints.find((l) => l.includes('disambiguate_selected'))
  return line ? [...line.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]) : []
}

/**
 * a 里 b 没有的名字（去重 + 排序）。
 * 反向也用它 —— 两边的差集都空才是「一致」，只有一边空说明是对的方向反了。
 */
function onlyIn(a, b) {
  const B = new Set(b)
  return [...new Set(a)].filter((x) => !B.has(x)).sort()
}

const DECLARED = declaredNames()
const HINTED = hintedNames()

/* ═══════════ 0. 抽得出的哨兵：抽成空数组会让后面每一条都「假绿」 ═══════════ */

describe('名单抽得出（防空跑）', () => {
  it('`TrackEvent` 能抽出 ≥ 20 个成员', () => {
    ok(DECLARED.length >= 20, `只抽到 ${DECLARED.length} 个 —— 正则与源码形态脱节了，后面的断言全是假绿`)
  })

  it('schema 的 `events.enumHint` 能被定位（多张表都有 enumHint，按特征值找）', () => {
    ok(HINTED.length > 0, '一个都没抽到：要么 enumHint 被删了，要么特征值改了')
  })
})

/* ═══════════ 1. 双向一致：少一个、多一个都红 ═══════════ */

describe('埋点名单双向一致：联合类型 ⇄ dbInit enumHint', () => {
  it('⚠ 没有「声明了但没登记」的（这部分 2026-10-16 一次补齐了 20 个）', () => {
    deepEq(onlyIn(DECLARED, HINTED), [], '新增埋点必须同时登记进 schema.js 的 events.enumHint')
  })

  it('⚠ 没有「登记了但没声明」的（含名字抄错、废弃事件留在名单里）', () => {
    deepEq(onlyIn(HINTED, DECLARED), [], '名单里留着一个不存在的名字 = 口径普查时对不上账')
  })

  it('两边数量相等（前两条的"差值"口径，配合看更直观）', () => {
    ok(DECLARED.length === HINTED.length, `联合类型 ${DECLARED.length} 个 vs enumHint ${HINTED.length} 个`)
  })
})

/* ═══════════ 2. 比较函数本身的对照：能给出「往哪个方向差了」 ═══════════ */

describe('onlyIn 的对照（这条断言自己不能是摆设）', () => {
  it('漏登记方向：onlyIn(声明, 登记) 报出缺的那个', () => {
    deepEq(onlyIn(['a', 'b', 'c'], ['a', 'c']), ['b'])
  })

  it('反方向为空（说明"缺"不是双向都报，能分辨谁缺谁）', () => {
    deepEq(onlyIn(['a'], ['a', 'b']), [])
  })

  it('重复项不会让差值虚增', () => {
    deepEq(onlyIn(['a', 'a', 'b'], ['a']), ['b'])
  })

  it('⚠ 拿真实名单做一次负向对照：漏掉任意一个都真的会被抓到', () => {
    const dropped = HINTED.slice(1) // 假设真源里少登记了第一个
    deepEq(onlyIn(HINTED, dropped), [HINTED[0]], '反向差集应恰好报出被去掉的那一个')
    deepEq(onlyIn(dropped, HINTED), [], '被去掉的那个不在 dropped 里，这个方向必须是空')
  })
})

/* ═══════════ 3. 上报点：声明了必须有人报 ═══════════ */

describe('声明的事件必须都有上报点（否则那个数在现实里不存在）', () => {
  /** 全项目里 `track('name'` 的调用点 → Set */
  function trackedNames() {
    const out = new Set()
    const walk = (d) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n)
        if (fs.statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(n)) {
          const c = stripComments(read(p))
          for (const m of c.matchAll(/track\(\s*'([a-z][a-z0-9_]*)'/g)) out.add(m[1])
        }
      }
    }
    walk(SRC)
    return out
  }
  const TRACKED = trackedNames()

  it('⚠ 声明了却没有任何 `track(...)` = 分母/分子其实不存在（report_open 当初就是这个样子）', () => {
    deepEq(onlyIn(DECLARED, [...TRACKED]), [], '要么补上报点，要么把这个声明删掉')
  })

  it('报出来的都在联合类型里（TS 已兜底，这里再静态钉一道）', () => {
    deepEq(onlyIn([...TRACKED], DECLARED), [])
  })

  it('对照：`report_open` 两边都在、且有上报点（本次新增的具体回归）', () => {
    ok(DECLARED.includes('report_open'))
    ok(HINTED.includes('report_open'))
    ok(TRACKED.has('report_open'))
  })
})

/* ═══════════ 4. 元信息：别让人以为它在生效 / 别写死会漂的数字 ═══════════ */

describe('schema.js 关于这份名单的说明', () => {
  it('⚠ 写明了「dbInit 不消费 enumHint」（否则下一个读者会以为写错会被拦住）', () => {
    ok(/dbInit\s*(目前)?并不消费\s*enumHint/.test(SCHEMA), '它只是登记副本，不是生效中的白名单')
  })

  it('写明了真源在 `src/utils/events.ts#TrackEvent`', () => {
    ok(/src\/utils\/events\.ts#TrackEvent/.test(SCHEMA))
  })

  it('不再写死事件数量（旧的「9 类」早已漂到 37 类）', () => {
    notOk(/埋点（9 类/.test(SCHEMA), '写死的数量一定会漂，改成指向真源')
  })

  it('注释与本用例互相指认（改的时候能顺着找到这里）', () => {
    ok(/test\/cases\/74-event-enum\.js/.test(SCHEMA))
  })
})
