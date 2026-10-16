'use strict'

/**
 * 报告阅读基数 `report_open`（S3-1 / N-4 / D7 三处判据**共用的分母**，2026-10-16）。
 *
 * 这一版要钉的不是一个新功能，而是**一组本来算不出来的比例**。
 * 在这条事件之前，`report_export`（S3-1 导出）的注释写着「出口点击 ÷ report_open」，
 * 而全项目里 `report_open` 出现 **0 次** —— 声明没有、上报点更没有。
 * 于是那三处判据实际都停在「等上线后看使用率」：不是**等数据**，是**取不到数**
 * （与 S1-4 落地前 `opinion_pick` 缺失时那句「算不出转化率」同一形态）。
 *
 * 补上以后，做错的形态都长得像对的 —— 报告照常渲染、导出照常能点，只是那几个比例永远凑不出来：
 *
 *   1. **事件名只写在注释里**（引用分母的那句话在，被引用的东西不存在）。故本用例不只查
 *      「注释提没提 report_open」，而是查它**声明过 + 真的报得出来**。
 *   2. **提交点太多或太少**。零个 = 分母还是空的；两个以上 = 同一份报告被重复计数
 *      （页面会因加载 / 关注态 / 会员态同步重渲染，挂在渲染处就会随渲染次数膨胀）。
 *   3. **不在「真有报告在屏上」时报**。loading / 等他人出结果 / 冷启动 / 无素材 / 出错时
 *      `report` 都是空，这些访问不是「读了一份报告」，混进去分母就虚高。
 *   4. **拿成本口径顶替**（`report_hit_cache` 是「这一读躲开了多少次生成」，而刚生成完接着读
 *      的那一次走 `report_generate` 不在它里面 —— 偏偏那批人最容易立刻导出）。
 *
 * 页面是 tsx 组件、跑不进 Node，故呈现点走**源码级静态断言**（同 71-member-entry.js 的手法）：
 * 剥注释再断言，否则代码里「不该这样」的说明性文字会被当成违规。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(p, 'utf8')

/** 剥注释：本版代码刻意写了很多解释性注释，不剥会把**说明**当成**违规** */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const EVENTS_TS = read(path.join(SRC, 'utils', 'events.ts'))
const EVENTS_CODE = stripComments(EVENTS_TS)
const REPORT_PATH = path.join(SRC, 'package', 'report', 'index.tsx')
const REPORT_CODE = stripComments(read(REPORT_PATH))
const SCHEMA = read(path.resolve(SRC, '..', 'cloudfunctions', 'dbInit', 'schema.js'))

/**
 * 全项目里所有 `track('<event>'` 上报点的分布：`[相对路径, 次数]`。
 *
 * 收口用 —— 分母这类东西**藏一处漏一处**，漏的那处就是线上一个没人数的分支
 * （同 utils/member-entry.ts 收口跳转、utils/pay.ts 收口下单）。
 */
function trackSites(event) {
  const hit = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name)) {
        const code = stripComments(read(p))
        const n = (code.match(new RegExp(`track\\('${event}'`, 'g')) || []).length
        if (n) hit.push([path.relative(SRC, p).split(path.sep).join('/'), n])
      }
    }
  }
  walk(SRC)
  return hit
}

/* ═══════════════ 1. 声明：事件名进了联合类型，不是只写在注释里 ═══════════════ */

describe('report_open 声明：进了 TrackEvent 联合类型（注释里的名字不算数）', () => {
  it("events.ts 的联合类型里有 `| 'report_open'`", () => {
    ok(/\|\s*'report_open'/.test(EVENTS_CODE), '没进联合类型 = track 那一行类型就过不了，或压根没上报')
  })

  it('⚠ 该名字在**剥掉注释后**仍然存在（引用分母的那句话在注释里不算数）', () => {
    const inCode = EVENTS_CODE.includes("'report_open'")
    ok(inCode, '报表上要出现一个事件名，它得先是个真的类型成员')
    notOk(
      EVENTS_CODE.includes("track('report_open'"),
      'events.ts 只负责声明，不该自己上报（上报点在报告页）'
    )
  })

  it("与 `report_lock_see` 是两条事件，不许合并（全体阅读 vs 免费锁态）", () => {
    ok(/\|\s*'report_lock_see'/.test(EVENTS_CODE))
    ok(/\|\s*'report_open'/.test(EVENTS_CODE))
  })
})

/* ═══════════════ 2. 呈现点唯一：全项目只报一处 ═══════════════ */

describe('report_open 呈现点：全项目只有一个，且在报告页', () => {
  it('⚠ 上报点分布 = 恰好在 package/report/index.tsx 一处', () => {
    deepEq(trackSites('report_open'), [['package/report/index.tsx', 1]],
      '零处 = 分母还是空的；两处以上 = 同一份报告被重复计数')
  })

  it('报告页里也只有一次 track 调用（别在多个分支里各报一次）', () => {
    const n = (REPORT_CODE.match(/track\('report_open'/g) || []).length
    ok(n === 1, `报告页里应有且仅有一次，实际 ${n} 次`)
  })
})

/* ═══════════════ 3. 分母真的存在：声明 + 上报点都在（本版修正的核心） ═══════════════ */

describe('report_open 是「算得出的分母」：声明过，且真的报得出来', () => {
  it('⚠ 三处判据共用的分母确实存在（此前 0 处 —— 不是等数据，是取不到数）', () => {
    const declared = /\|\s*'report_open'/.test(EVENTS_CODE)
    const sites = trackSites('report_open')
    ok(declared, '没声明 = 上报时类型不过')
    ok(sites.length === 1, '没有（或不止一个）上报点 = 比例还是凑不出来')
  })

  it('注释里点明了这是 S3-1 / N-4 / D7 共用的分母（三处的再判断都指着它）', () => {
    ok(/S3-1/.test(EVENTS_TS), '没写清它服务的是哪条假设，下一个改的人会另起一个事件名')
    ok(/N-4/.test(EVENTS_TS))
    ok(/D7/.test(EVENTS_TS))
  })

  it('⚠ 明确写了「不能拿 report_hit_cache 顶替」的理由（成本口径 ≠ 阅读口径）', () => {
    ok(/report_hit_cache/.test(EVENTS_TS))
    ok(/顶替/.test(EVENTS_TS), '不写理由，就有人图省事拿成本口径当分母')
  })

  it('props.cached 的语义写清了（读的缓存 vs 刚生成）', () => {
    ok(/props\.cached/.test(EVENTS_TS))
    ok(/props\.personKey/.test(EVENTS_TS))
  })
})

/* ═══════════════ 4. 只在 ready：真有报告在屏上才算「读了一份报告」 ═══════════════ */

describe('report_open 的守卫：report 非空 = phase 已 ready', () => {
  it('⚠ 呈现在「真有报告在屏上」时报：守卫 `if (!report) return`', () => {
    ok(/if \(!report\) return/.test(REPORT_CODE), 'loading / 出结果 / 冷启动 / 无素材 / 出错都该短路')
  })

  it("report 只在 `phase === 'ready'` 时非空（其余态一律 null，不算读了一份报告）", () => {
    ok(
      /state\.phase === 'ready'\s*\?\s*\{ report: state\.report, fromCache: state\.fromCache \}\s*:\s*\{ report: null, fromCache: false \}/.test(
        REPORT_CODE
      ),
      '解构处改了，这条守卫的含义就跟着变'
    )
  })

  it('上报与内部走了哪条分支无关（不在生成 / 命中缓存 / 无素材兜底里各报一次）', () => {
    const m = REPORT_CODE.match(/track\('report_open'[\s\S]*?\}, \[report, fromCache\]\)/)
    ok(m, '找不到 report_open 的呈现点')
    const block = m[0]
    notOk(/hit_cache|report_generate|knowledge_fallback/.test(block), '分母不该挂在某条内部分支上')
  })
})

/* ═══════════════ 5. props 口径与去重 ═══════════════ */

describe('report_open props 与去重', () => {
  it('props = { personKey, cached }：缓存回看与刚拿到的新报告要能分开', () => {
    ok(
      /track\('report_open', \{ personKey: report\.personKey, cached: fromCache \}\)/.test(REPORT_CODE),
      '少一个字段，报表上就分不出「回看的老报告」与「刚拿到的新报告」'
    )
  })

  it('⚠ 每次页面访问最多一条：按 personKey 记已报过（重渲染不补）', () => {
    ok(/if \(openedSeen\.current === report\.personKey\) return/.test(REPORT_CODE))
    ok(/openedSeen\.current = report\.personKey/.test(REPORT_CODE))
  })

  it('记的是 personKey 而不是布尔：换一份报告要重新报（= 另一次访问）', () => {
    ok(/const openedSeen = useRef\(''\)/.test(REPORT_CODE), '存布尔就再也认不出换人是另一次访问')
  })

  it('与 report_lock_see 各用各的 ref（两条事件互不吞掉对方）', () => {
    ok(/const lockSeen = useRef\(''\)/.test(REPORT_CODE))
    ok(/const openedSeen = useRef\(''\)/.test(REPORT_CODE))
    notOk(/lockSeen\.current === report\.personKey\)\s*\{[\s\S]{0,80}track\('report_open'/.test(REPORT_CODE))
  })
})

/* ═══════════════ 6. 登记：dbInit 的 enumHint ═══════════════ */

describe('report_open 登记进 dbInit 的 events.enumHint', () => {
  it('enumHint 里追加了 report_open（沿用 event_subscribe 的追加方式）', () => {
    ok(/'report_lock_see', 'report_open', 'member_entry'/.test(SCHEMA))
  })

  it('只登记事件名，不动 events 表的字段（person_key / props 早已在那）', () => {
    ok(/f\('person_key', 'string\?'/.test(SCHEMA) && /f\('props', 'object\?'/.test(SCHEMA))
  })
})
