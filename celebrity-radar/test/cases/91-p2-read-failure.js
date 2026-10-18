'use strict'

/**
 * P2 批（2026-10-18）：把「读失败」和「没有数据」分开的那批改动，逐处钉住。
 *
 * 这一批的共同病根是同一个：`catch` / `error` 分支返回空值，而空值在 UI 上被翻译成一句
 * **断言式的话** —— 「还没有关注名人」「未生成报告」「从没更新过」「暂无动态」「今天用了 0 次」。
 * 每一次云库抖动都会让这些话变成谎言，其中最狠的是事件状态：整行覆盖写一旦拿空状态回写，
 * 用户真实的已读时间就永久丢了。
 *
 * 这里全部用**源码钉住**（不改行为、不加载端上模块），只保证「那个判据还在」。
 * 断言里的模式串刻意不出现在同文件的注释中，免得改天有人把注释当代码匹配。
 */

const path = require('path')
const fs = require('fs')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const CLOUD = path.join(ROOT, 'cloudfunctions')

const read = (p) => fs.readFileSync(p, 'utf8')
const count = (src, re) => (src.match(re) || []).length

/* ───────────────────────── 事件状态：读失败不许覆盖写 ───────────────────────── */

describe('P2：事件状态读失败时不写（否则整张已读表被抹平）', () => {
  const store = read(path.join(SRC, 'utils/opinion-store.ts'))

  it('写路径全部走 loadEventStatusChecked，且读失败直接返回失败', () => {
    eq(
      count(store, /if \(!read\.ok\) return false/g),
      3,
      'markEventRead / markEventsRead / setEventFollow 三处都要先看 ok —— 少一处就是一处静默的数据丢失'
    )
    ok(
      store.includes('export async function loadEventStatusChecked'),
      '要有一个能区分「读失败」与「空」的读口，供写路径使用'
    )
    /* 正向对照：只读口仍然退化成空状态（展示侧本来就该这样降级） */
    ok(
      /export async function loadEventStatus\(\): Promise<EventStatus> \{\s*return \(await loadEventStatusChecked\(\)\)\.status/.test(
        store
      ),
      '展示侧照旧拿空状态，不因为这条保护而把页面变成错误态'
    )
  })

  it('订阅开关同样先看 ok（它写的也是同一整行）', () => {
    const subs = read(path.join(SRC, 'utils/event-subscribe.ts'))
    ok(subs.includes('loadEventStatusChecked()'), 'toggleSubject 不能用会退化成空的读口')
    ok(subs.includes("return 'failed'"), '读不到就回 failed，不要拿空状态去写')
    notOk(
      /const cur = await loadEventStatus\(\)/.test(subs),
      '旧的、会退化成空状态的读口不许再出现在写路径里'
    )
  })
})

/* ───────────────────────── 关注概览：0 条 vs 没读到 ───────────────────────── */

describe('P2：关注概览的条数用 null 表示「没读到」', () => {
  const watch = read(path.join(SRC, 'utils/watch.ts'))

  it('newsCount 类型允许 null，且取值按 feed.ok 分流', () => {
    ok(watch.includes('newsCount: number | null'), '类型要允许 null，否则读失败只能退回 0')
    ok(
      watch.includes('newsCount: feed.ok ? feed.items.length : null'),
      '取值必须看 feed.ok —— 直接写 length 就是把读失败说成 0 条'
    )
  })

  it('残缺结果不写内存缓存（否则抖动会被锁住 60 秒）', () => {
    ok(
      watch.includes('if (f.newsCount !== null) memo.set('),
      '失败的这一行不能进 memo：进了就会在 TTL 内一直返回同一份残缺结果'
    )
  })

  it('两个使用点都不再把它当数字用', () => {
    const following = read(path.join(SRC, 'package/following/index.tsx'))
    ok(following.includes('动态暂不可读'), '关注流要如实说「没读到」，不能写「暂无动态」')

    const messages = read(path.join(SRC, 'utils/messages.ts'))
    ok(
      messages.includes("typeof w.newsCount === 'number' && w.newsCount > 0"),
      '消息副标题要先判类型，null 时不出「已收录 0 条」'
    )
  })
})

/* ───────────────────────── 报告类读取：别再替故障打包票 ───────────────────────── */

describe('P2：报告读取失败不再伪装成「没有」', () => {
  const versions = read(path.join(SRC, 'utils/report-versions.ts'))
  const page = read(path.join(SRC, 'package/report-history/index.tsx'))
  const historyView = read(path.join(SRC, 'components/history-view/index.tsx'))
  const cache = read(path.join(SRC, 'utils/cache.ts'))

  it('历史版本带回 ok，空态分成两句相反的话', () => {
    ok(versions.includes('ok: boolean'), 'VersionBoard 要能表达「这次没读到」')
    ok(versions.includes('rows: [], current: null, ok: false'), '读失败的返回必须是 ok:false')
    ok(page.includes('board.ok ?'), '页面按 ok 分流，不能一律说「还没有更新过的版本」')
    ok(page.includes('历史版本读取失败'), '被挡住的是列表，不是「本来就没有版本」')
  })

  it('批量缓存读取有 *Checked 版本，历史页用它', () => {
    ok(
      cache.includes('export async function getCachedReportsChecked'),
      '要有一个能带回 ok 的批量读口'
    )
    ok(
      /export async function getCachedReports\([\s\S]{0,120}getCachedReportsChecked/.test(cache),
      '旧签名保留为一行转发，其余调用方不用改'
    )
    ok(historyView.includes('getCachedReportsChecked'), '历史页必须用带 ok 的那个')
    ok(historyView.includes('reportUnknown: !ok'), '卡片要记住「这次没读到」')
    ok(historyView.includes('报告状态读取失败'), '不能对用户说「未生成报告」')
  })

  it('「继续看」的读口仍然只读、不触发生成（防止改成 getOrBuildReport）', () => {
    notOk(historyView.includes('getOrBuildReport'), '历史页读缓存绝不能顺手生成一份')
  })
})

/* ───────────────────────── 报告历史：展开的响应竞态 ───────────────────────── */

describe('P2：报告历史展开慢响应不覆盖新选中', () => {
  const page = read(path.join(SRC, 'package/report-history/index.tsx'))

  it('回包后校验「还是我这一版」，busy 也只关自己那一份', () => {
    ok(page.includes('openIdRef.current !== row.id'), '先点 A 再点 B 时，A 的响应回来必须被丢掉')
    ok(
      page.includes('if (openIdRef.current === row.id) setOpenBusy(false)'),
      '旧响应关掉 busy，会让新那版永远停在「正在读取」'
    )
    ok(page.includes('const openIdRef = useRef'), '判据要用 ref：state 在异步回调里会过时')
  })
})

/* ───────────────────────── 周报：读不到关注列表 ≠ 没关注 ───────────────────────── */

describe('P2：周报把「读不到关注列表」单独成一个态', () => {
  const weekly = read(path.join(SRC, 'utils/weekly.ts'))
  const page = read(path.join(SRC, 'package/weekly/index.tsx'))
  const follows = read(path.join(SRC, 'utils/follows.ts'))

  it('listFollows 有带 ok 的版本，周报走它', () => {
    ok(follows.includes('export async function listFollowsChecked'), '要能区分「没关注」与「没读到」')
    ok(weekly.includes('if (!followRead.ok) return { kind: \'unreadable\' }'), '不可以退回 nofollow')
    notOk(
      /const follows = await listFollows\(\)/.test(weekly),
      '旧的会退化成空数组的读口不许再用在周报材料收集里'
    )
  })

  it('类型、文案、页面态三处齐（漏一处就是 undefined 或空白页）', () => {
    ok(weekly.includes("| { kind: 'unreadable' }"), 'MaterialOutcome 要加这个态')
    ok(weekly.includes("unreadable: '"), 'MATERIAL_FAIL_TEXT 要有对应文案（Record 强制）')
    ok(page.includes("| 'unreadable'"), 'Phase 要能表示它，否则 setPhase 类型不过 / 静默空白')
    ok(page.includes("phase === 'unreadable'"), '要有独立的空态块，给「重试」而不是「去发现名人」')
  })
})

/* ───────────────────────── 云端：成本闸门与可观测性 ───────────────────────── */

describe('P2：云端两处静默失效的口子', () => {
  it('热榜的 dry 试跑与 force 同拦（端上循环调用同样能把上游额度烧光）', () => {
    const src = read(path.join(CLOUD, 'hotBoardRefresh/index.js'))
    ok(
      src.includes("event.force === true || action === 'dry'"),
      'dry 的成本和正常构建一样，只拦 force 等于留后门'
    )
    ok(src.includes('fromClient'), '判据必须来自 getWXContext().OPENID，不能信任入参')
  })

  it('配额读计数失败时区分「行不存在」并留日志（仍是 fail-open）', () => {
    const src = read(path.join(CLOUD, 'quotaGuard/index.js'))
    ok(src.includes('DOCUMENT_NOT_FOUND'), '行不存在是正常情况，不能和读失败混在一起')
    ok(src.includes('console.warn('), '真正的读失败必须留痕，否则额度静默失效只能靠猜')
    ok(/return 0/.test(src), '行为不变：读不到仍按 0 次计（fail-open），这条只补可观测性')
  })

  it('两个定时扫描都有时间预算，并如实上报顺延数', () => {
    for (const name of ['keywordAlert', 'riskWatch']) {
      const src = read(path.join(CLOUD, name, 'index.js'))
      ok(src.includes('TIME_BUDGET_MS'), `${name}：没有时间预算就会被云函数超时直接杀掉，日志里只剩一条超时`)
      ok(src.includes('deferred'), `${name}：顺延数要写进回执，否则看不出「跑完了没有」`)
    }
  })
})
