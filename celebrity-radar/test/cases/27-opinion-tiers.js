'use strict'

/**
 * 舆情功能的免费 / 会员分层（P2，2026-10-13）。
 *
 * 钉住四件事：
 *   1. 三档上限的**取值与两档关系**——真源唯一在 config/benefits.ts#OPINION_LIMITS
 *      （关键词监测 3/10、风险监控人数 3/10、舆情明细 5/全部）；**关注人数上限已于
 *      2026-10-13 取消**（followCount 从真源与取用层一并删除，关注改为完全不限）；
 *   2. 「只拦新增」的门禁判定函数（utils/opinion-access.ts）——达到 / 超过上限都只影响
 *      「还能不能再加一个」，**绝不删除、隐藏、过滤任何既有数据**；
 *   3. 存量超限不删不藏（端到端：seed 超限数据 → 列表照常全量读出 → 新增被拦 → 既有仍可取消）；
 *   4. 舆情页三张**概要卡概要不分档**（统一走 utils/opinion-access.ts#overviewSlice「固定首屏 +
 *      按需加载」）；「明细条数」这一层分层只作用在事件**时间线页**（pages/event：免费 5 条 /
 *      会员全部），而**今日要点（≤3 条）不受此限**。
 *
 * 纯函数直接 require 编译产物；页面是 .tsx（不进测试编译），与既有页面用例同法读源码文本断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 同步脚本本体（被 require 时不会执行 main），用于读回真源导出 */
const sync = require(path.join(ROOT, 'scripts', 'sync-config.js'))

/** 加载取用层（每次从干净模块状态开始） */
function OA() {
  env.resetAll()
  return env.load('utils/opinion-access')
}

/** 设一个已登录用户，返回 load（用于端到端用例） */
function withUser(userId = 'me') {
  env.resetAll()
  const auth = env.load('stores/auth')
  auth.useAuth.setState({ userId })
  return env.load
}

/** 会员行（readMemberState 读 users 镜像那一行） */
const memberRow = () => ({
  _id: 'u1',
  _openid: 'me',
  membership: { plan: 'month', expires_at: new Date(Date.now() + 864e5).toISOString() }
})

/** 取某顶层导出函数的源码体（到下一个 `export ` 为止），用于钉「读列表不截断」 */
function fnBody(src, signature) {
  const at = src.indexOf(signature)
  if (at < 0) return ''
  const next = src.indexOf('\nexport ', at + signature.length)
  return next > 0 ? src.slice(at, next) : src.slice(at)
}

/* ───────────────────────── 1. 真源取值与两档关系 ───────────────────────── */

describe('舆情分层：上限真源 config/benefits#OPINION_LIMITS', () => {
  it('三档取值正确（口径由产品确认）；关注人数上限已取消', () => {
    const L = sync.loadSource().OPINION_LIMITS
    /* 2026-10-13 取消关注人数上限：followCount 不再存在于真源 */
    notOk(L.followCount, '关注人数上限（followCount）应从 OPINION_LIMITS 中删除')
    deepEq(L.watchCount, { free: 3, member: 10 })
    /* 「监控某人」人数：免费 3 / 会员 10，是**另一个维度** */
    deepEq(L.personWatchCount, { free: 3, member: 10 })
    /* 两维口径一致（2026-10-13：关键词免费档也由 1 提到 3，与「监控某人」对齐） */
    deepEq(L.watchCount, L.personWatchCount, '关键词监控与「监控某人」两维免费 / 会员档取值应一致')
    eq(L.detailRows.free, 5)
    eq(L.detailRows.member, null, '会员明细用 null 表示「不截断 / 显示全部」')
  })

  it('两档关系：会员 > 免费（明细：免费有限、会员不截断）', () => {
    const L = sync.loadSource().OPINION_LIMITS
    ok(L.watchCount.member > L.watchCount.free, '关键词监测：会员上限应高于免费')
    ok(L.personWatchCount.member > L.personWatchCount.free, '风险监控人数：会员上限应高于免费')
    ok(L.detailRows.free > 0, '免费档明细是有限的正整数')
    eq(L.detailRows.member, null, '会员档明细不设上限')
  })

  it('端上取用层直接 import 真源，不另存一份数字；关注门禁已删除', () => {
    const src = read('utils/opinion-access.ts')
    ok(src.includes("from '../config/benefits'"), '取用层应引用 config/benefits')
    notOk(/followCount:\s*\{|free:\s*3\b/.test(src), '不得把上限数值抄进取用层')
    /* 2026-10-13 取消关注人数上限：取用层不再导出 followGate / followLimit / canAddFollow / followLimitNote */
    notOk(/followGate|followLimit|canAddFollow\b/.test(src), '关注上限门禁应已从取用层删除')
  })
})

/* ───────────────────────── 2. 门禁判定（只拦新增） ───────────────────────── */

describe('舆情分层：门禁判定（只拦新增，不删存量）', () => {
  it('按身份返回上限：watchLimit / personWatchLimit 会员 > 免费；detailLimit 会员=null', () => {
    const { watchLimit, personWatchLimit, detailLimit } = OA()
    eq(watchLimit(false), 3)
    eq(watchLimit(true), 10)
    eq(personWatchLimit(false), 3)
    eq(personWatchLimit(true), 10)
    eq(detailLimit(false), 5)
    eq(detailLimit(true), null)
  })

  it('边界：未达上限允许、达到上限拦住；存量超限同样只表示「不能再加」', () => {
    const { canAddWatch, watchGate, personWatchGate, canAddPersonWatch } = OA()

    ok(canAddWatch(0, false), '免费档 0 个词可加第一个')
    ok(canAddWatch(2, false), '免费档未到上限（3）可继续加')
    notOk(canAddWatch(3, false), '免费档到 3 即拦住')
    ok(watchGate(4, false).over, '免费档存量超限（4 > 3）→ over=true')
    ok(canAddWatch(9, true))
    notOk(canAddWatch(10, true))

    /* 「监控某人」：免费 3 / 会员 10，口径同样「只拦新增」 */
    ok(canAddPersonWatch(2, false), '免费档未到上限（3）可继续加')
    notOk(canAddPersonWatch(3, false), '免费档到 3 位即拦住')
    ok(personWatchGate(5, false).over, '免费档存量超限 → over=true（既有监控原样保留、继续被扫描）')
    ok(canAddPersonWatch(9, true))
    notOk(canAddPersonWatch(10, true))
  })

  it('上限提示文案：免费档带升级引导、会员档只说事实（与关键词监控同风格）', () => {
    const { watchLimitNote, personWatchLimitNote } = OA()
    ok(/免费版最多监测 3 个词/.test(watchLimitNote(false)))
    ok(/最多同时监测 10 个词/.test(watchLimitNote(true)))
    ok(/开通会员可监测 10 个/.test(watchLimitNote(false)), '免费档文案给出会员上限（10）')
    ok(/免费版最多监控 3 个人/.test(personWatchLimitNote(false)), '免费档说清上限并给升级引导')
    ok(/开通会员可监控 10 个/.test(personWatchLimitNote(false)))
    ok(/最多同时监控 10 个人/.test(personWatchLimitNote(true)), '会员档只报事实')
    notOk(/开通会员/.test(personWatchLimitNote(true)), '会员档不再提升级')
  })

  it('sliceDetail：免费切到 5 条并带回隐藏数；会员全部且返回原引用', () => {
    const { sliceDetail } = OA()
    const ten = Array.from({ length: 10 }, (_, i) => i)

    const free = sliceDetail(ten, false)
    eq(free.rows.length, 5, '免费档明细切到 5 条')
    eq(free.hidden, 5, '隐藏 5 条（供页面提示「会员可见全部 N 条」）')
    deepEq(free.rows, [0, 1, 2, 3, 4])

    const mem = sliceDetail(ten, true)
    eq(mem.rows.length, 10, '会员看到全部')
    eq(mem.hidden, 0)
    ok(mem.rows === ten, '不截断时返回原引用（不产生拷贝）')

    const short = sliceDetail([1, 2, 3], false)
    eq(short.rows.length, 3, '不足上限时原样返回')
    eq(short.hidden, 0)

    deepEq(sliceDetail(null, false), { rows: [], hidden: 0 }, '空值不抛错')
  })
})

/* ───────────────────────── 3. 存量超限不删不藏（端到端） ───────────────────────── */

describe('舆情分层：存量超限不删不藏，只拦新增（端到端）', () => {
  it('关注：已无人数上限，存量照常全量可看、可取消，新增永远放行', async () => {
    const load = withUser()
    const follows = load('utils/follows')

    /* 存量 5 人：模拟改造前就关注了较多人的老用户（关注人数上限已于 2026-10-13 取消，
       存量与新增都不再受限）。_id 必须与真实写入口径一致（`openid#personKey`，
       见 utils/follows.ts#toggleFollow），否则 isFollowed 找不到它、会被当成「未关注」。 */
    env.db.__seed(
      'follows',
      Array.from({ length: 5 }, (_, i) => ({
        _id: `me#甲${i}#tech`,
        openid: 'me',
        person_key: `甲${i}#tech`,
        name: `甲${i}`,
        domain: 'tech',
        followed_at: `2026-10-0${i + 1}T00:00:00.000Z`
      }))
    )

    eq((await follows.listFollows()).length, 5, '存量照常全部读出 —— 不隐藏、不截断')

    /* 无上限：第 6 位照常新增成功（不再被门禁拦下、不再返回 null） */
    const add = await follows.toggleFollow('新人物#tech', 'test')
    eq(add, true, '关注不再有人数上限 —— 新增成功')
    eq((await follows.listFollows()).length, 6, '新增写入一笔')

    const del = await follows.toggleFollow('甲0#tech', 'test')
    eq(del, false, '已有关注对象仍可取消关注')
    eq((await follows.listFollows()).length, 5, '取关正常生效')
  })

  it('关注：免费用户与会员一视同仁，新增都不再受人数限制', async () => {
    const load = withUser()
    /* 刻意造一个会员行：证明「新增放行」不再是会员特权 —— 免费 / 会员走同一条无门禁路径 */
    env.db.__seed('users', [memberRow()])
    const follows = load('utils/follows')
    env.db.__seed(
      'follows',
      Array.from({ length: 3 }, (_, i) => ({
        _id: `me#甲${i}#tech`,
        openid: 'me',
        person_key: `甲${i}#tech`,
        name: `甲${i}`,
        domain: 'tech',
        followed_at: `2026-10-0${i + 1}T00:00:00.000Z`
      }))
    )

    const add = await follows.toggleFollow('新人物#tech', 'test')
    eq(add, true, '已有 3 位关注时仍可新增（不再有 3 人免费上限）')
    eq((await follows.listFollows()).length, 4)
  })

  it('关键词监控：已超免费上限的订阅照常全量可读、可取消，只拦新增', async () => {
    const load = withUser()
    const ka = load('utils/keyword-alert')

    /* 存量 4 个词（> 免费上限 3）：模拟改造前就已经订阅超限的老用户 */
    env.db.__seed(
      'keyword_watches',
      Array.from({ length: 4 }, (_, i) => ({
        _id: `me#词${i}`,
        openid: 'me',
        keyword: `词${i}`,
        created_at: '2026-10-01T00:00:00.000Z',
        seen_at: '2026-10-01T00:00:00.000Z',
        type: 'keyword'
      }))
    )

    eq((await ka.listWatches()).length, 4, '存量订阅照常全部读出 —— 不隐藏、不截断')

    const add = await ka.addWatch('新词')
    eq(add.ok, false, '超限时阻止新增')
    ok(String(add.message).includes('3'), '提示里说明免费档上限（3）')
    eq((await ka.listWatches()).length, 4, '阻止新增不得删 / 动既有订阅')

    eq(await ka.removeWatch('词0'), true, '既有订阅仍可取消')
    eq((await ka.listWatches()).length, 3)
  })

  it('关键词监控：免费用户 3 个词仍是上限（第 3 个可加、第 4 个拦下）', async () => {
    const load = withUser()
    const ka = load('utils/keyword-alert')
    env.db.__seed(
      'keyword_watches',
      Array.from({ length: 2 }, (_, i) => ({
        _id: `me#词${i}`,
        openid: 'me',
        keyword: `词${i}`,
        created_at: '2026-10-01T00:00:00.000Z',
        seen_at: '2026-10-01T00:00:00.000Z',
        type: 'keyword'
      }))
    )

    /* 第 3 个（count=2 < 3）放行 —— 免费档由 1 提到 3 后「允许加到 3」 */
    const third = await ka.addWatch('第三个')
    eq(third.ok, true, '免费档第 3 个应放行（上限 3）')
    eq((await ka.listWatches()).length, 3)

    /* 第 4 个（count=3 ≥ 3）拦下 */
    const fourth = await ka.addWatch('第四个')
    eq(fourth.ok, false, '免费档第 4 个应拦下')
    ok(String(fourth.message).includes('3'), '提示里说明免费档上限（3）')
    eq((await ka.listWatches()).length, 3)
  })

  it('关键词监控：会员可新增到 10（免费上限 3 之上）', async () => {
    const load = withUser()
    env.db.__seed('users', [memberRow()])
    const ka = load('utils/keyword-alert')
    env.db.__seed('keyword_watches', [
      {
        _id: 'me#词0',
        openid: 'me',
        keyword: '词0',
        created_at: '2026-10-01T00:00:00.000Z',
        seen_at: '2026-10-01T00:00:00.000Z',
        type: 'keyword'
      }
    ])

    const add = await ka.addWatch('新词')
    eq(add.ok, true, '会员在免费上限（3）处仍可新增')
    eq((await ka.listWatches()).length, 2)
  })
})

/* ─────────────── 4. 明细切片 / 概要卡不分档与今日要点（静态 + 纯函数） ─────────────── */

describe('舆情分层：明细切片（供时间线页）与今日要点、概要卡不分档', () => {
  const page = read('pages/opinion/index.tsx')

  it('概要卡统一走 overviewSlice（概要不分档）：本页不再按会员态截断列表、也不再重读会员态', () => {
    ok(page.includes("from '@/utils/opinion-access'"), '舆情页应引用 utils/opinion-access')
    ok(page.includes('overviewSlice('), '三张概要卡应走 overviewSlice（固定预览 3 条）')
    notOk(page.includes('sliceDetail('), '概要卡不得再用按会员档放全的 sliceDetail')
    notOk(page.includes('readMemberState('), '概要不分档 → 本页不再需要重读会员态（分层其余部分在各自入口 / 时间线页）')
    ok(page.includes('useDidShow('), '读取挂在 useDidShow 上（不引入额外缓存）')
    ok(page.includes('pickDailyFocus('), '今日要点仍走 P1 的 pickDailyFocus（不受明细分层影响）')
    notOk(page.includes('PREVIEW_ROWS'), '不应再有写死的固定条数')
  })

  it('三张概要卡都不再有「加载更多 / 到底」（统一为卡头「查看全部 ›」入口），也无会员升级提示行', () => {
    notOk(page.includes('page-opinion__more-detail'), '三张卡都不再页内「加载更多」（样式钩子应一并清理）')
    notOk(page.includes('page-opinion__done'), '三张卡都不再有页内到底文案（样式钩子应一并清理）')
    notOk(page.includes('loadMoreAlerts'), '预警卡不该再保留按需加载处理函数')
    notOk(page.includes('alertShownCount'), '预警卡不该再保留按需加载 state')
    notOk(page.includes('moreDetailNote('), '概要卡不再用「会员可见全部 N 条」明细提示')
    notOk(page.includes('/pages/member/index'), '概要不分档 → 本页不再有跳会员页的升级提示行')
  })

  it('明细切片 sliceDetail 仍是「免费 5 条 / 会员全部」，而今日要点照常给 3 条（留存钩子不被切）', () => {
    env.resetAll()
    /* sliceDetail 是**明细**口径，现在只作用在事件时间线页（pages/event）；这里直接钉住纯函数本身 */
    const { sliceDetail } = env.load('utils/opinion-access')
    const { buildOpinionQueue, pickDailyFocus } = env.load('utils/opinion-rank')

    const feed = Array.from({ length: 9 }, (_, i) => ({
      title: `报道第${i}条`,
      source: '某报',
      date: `2026-10-0${(i % 9) + 1}`,
      person: '张三'
    }))
    const queue = buildOpinionQueue({ feed, watchNames: ['张三'] })

    eq(queue.length, 9, '九条不同事件不合并')
    eq(sliceDetail(queue, false).rows.length, 5, '免费档明细被切到 5 条')
    eq(pickDailyFocus(queue).length, 3, '今日要点照常 3 条 —— 不受明细上限影响')
    eq(sliceDetail(queue, true).rows.length, queue.length, '会员看到全部')
  })
})

/* ───────────────────────── 5. 只拦新增的落点（源码钉住） ───────────────────────── */

describe('舆情分层：只拦新增的落点（源码钉住）', () => {
  it('follows.ts：关注人数已无门禁（followGate / followLimitNote 已删除），取关与新增分支仍在', () => {
    const src = read('utils/follows.ts')
    /* 2026-10-13 取消关注人数上限：门禁调用与提示文案一并删除 */
    notOk(src.includes('followGate('), '关注上限门禁（followGate）应已从 follows.ts 删除')
    notOk(src.includes('followLimitNote('), '关注上限提示（followLimitNote）应已从 follows.ts 删除')
    /* 关注 / 取关的既有切换语义不变：两个分支都还在 */
    ok(src.includes("table('follows').delete().eq('id', id)"), '取消关注分支应保留')
    ok(src.includes("table('follows').insert("), '新增关注分支应保留')
  })

  it('关键词监控：门禁在 addWatch 内，且 listWatches 不做截断 / 删除', () => {
    const src = read('utils/keyword-alert.ts')
    ok(src.includes('watchGate('), 'addWatch 应调用 watchGate')
    const body = fnBody(src, 'export async function listWatches')
    ok(body.length > 0, '应能定位 listWatches')
    notOk(body.includes('.slice('), 'listWatches 不得截断（存量必须全部可读）')
    notOk(body.includes('.delete('), 'listWatches 不得删除任何行')
  })

  it('风险监控：门禁在 monitorPerson 内，写入优先走云端，且 listPersonWatches 不截断 / 删除', () => {
    const src = read('utils/risk-watch.ts')
    ok(src.includes('personWatchGate('), 'monitorPerson 回退路径应调用 personWatchGate')
    ok(src.includes("callCloudFunction('riskWatch'"), '写入路径应优先走云端 riskWatch(action:add)')
    const body = fnBody(src, 'export async function listPersonWatches')
    ok(body.length > 0, '应能定位 listPersonWatches')
    notOk(body.includes('.slice('), 'listPersonWatches 不得截断（存量必须全部可读）')
    notOk(body.includes('.delete('), 'listPersonWatches 不得删除任何行')
  })

  it('follows.ts：listFollows 不做截断 / 删除（存量必须全部可读）', () => {
    const src = read('utils/follows.ts')
    const body = fnBody(src, 'export async function listFollows')
    ok(body.length > 0)
    notOk(body.includes('.slice('), 'listFollows 不得截断')
    notOk(body.includes('.delete('), 'listFollows 不得删除任何行')
  })
})

/* ───────────────────────── 6. 端上非安全边界的注释 ───────────────────────── */

describe('舆情分层：端上上限是体验层不是安全边界（注释约束）', () => {
  it('opinion-access.ts 与 benefits.ts 都写明「不是安全边界」并交代 P4 云端校验', () => {
    const oa = read('utils/opinion-access.ts')
    const cfg = read('config/benefits.ts')
    ok(oa.includes('不是安全边界'), '取用层要写明端上上限不是安全边界')
    ok(oa.includes('P4'), '取用层要交代 P4 须在云端按 memberships 校验数量')
    ok(cfg.includes('不是安全边界'), '真源也要写明这一点，别让后人当成闸门')
  })
})
