'use strict'

/**
 * 舆情功能的免费 / 会员分层（P2，2026-10-13）。
 *
 * 钉住四件事：
 *   1. 三档上限的**取值与两档关系**——真源唯一在 config/benefits.ts#OPINION_LIMITS
 *      （关注人数 3/30、关键词监测 1/10、舆情明细 5/全部）；
 *   2. 「只拦新增」的门禁判定函数（utils/opinion-access.ts）——达到 / 超过上限都只影响
 *      「还能不能再加一个」，**绝不删除、隐藏、过滤任何既有数据**；
 *   3. 存量超限不删不藏（端到端：seed 超限数据 → 列表照常全量读出 → 新增被拦 → 既有仍可取消）；
 *   4. 舆情页明细按会员态截断（免费 5 条 / 会员全部）而**今日要点（≤3 条）不受此限**。
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
  it('四档取值正确（口径由产品确认）', () => {
    const L = sync.loadSource().OPINION_LIMITS
    deepEq(L.followCount, { free: 3, member: 30 })
    deepEq(L.watchCount, { free: 1, member: 10 })
    /* 「监控某人」人数：免费 3 / 会员 10，是**另一个维度** */
    deepEq(L.personWatchCount, { free: 3, member: 10 })
    eq(L.detailRows.free, 5)
    eq(L.detailRows.member, null, '会员明细用 null 表示「不截断 / 显示全部」')
  })

  it('两档关系：会员 > 免费（明细：免费有限、会员不截断）', () => {
    const L = sync.loadSource().OPINION_LIMITS
    ok(L.followCount.member > L.followCount.free, '关注：会员上限应高于免费')
    ok(L.watchCount.member > L.watchCount.free, '关键词监测：会员上限应高于免费')
    ok(L.personWatchCount.member > L.personWatchCount.free, '风险监控人数：会员上限应高于免费')
    ok(L.detailRows.free > 0, '免费档明细是有限的正整数')
    eq(L.detailRows.member, null, '会员档明细不设上限')
  })

  it('端上取用层直接 import 真源，不另存一份数字', () => {
    const src = read('utils/opinion-access.ts')
    ok(src.includes("from '../config/benefits'"), '取用层应引用 config/benefits')
    notOk(/followCount:\s*\{|free:\s*3\b/.test(src), '不得把上限数值抄进取用层')
  })
})

/* ───────────────────────── 2. 门禁判定（只拦新增） ───────────────────────── */

describe('舆情分层：门禁判定（只拦新增，不删存量）', () => {
  it('按身份返回上限：followLimit / watchLimit / personWatchLimit 会员 > 免费；detailLimit 会员=null', () => {
    const { followLimit, watchLimit, personWatchLimit, detailLimit } = OA()
    eq(followLimit(false), 3)
    eq(followLimit(true), 30)
    eq(watchLimit(false), 1)
    eq(watchLimit(true), 10)
    eq(personWatchLimit(false), 3)
    eq(personWatchLimit(true), 10)
    eq(detailLimit(false), 5)
    eq(detailLimit(true), null)
  })

  it('边界：未达上限允许、达到上限拦住；存量超限同样只表示「不能再加」', () => {
    const { followGate, canAddFollow, canAddWatch, watchGate, personWatchGate, canAddPersonWatch } = OA()

    ok(canAddFollow(2, false), '未到免费上限（3）可继续加')
    notOk(canAddFollow(3, false), '达到免费上限即拦住新增')
    notOk(canAddFollow(5, false), '存量已超免费上限，同样只拦新增（不是「删到 3」）')
    eq(followGate(5, false).over, true, 'over=true 只如实标记「存量已超」，不触发任何删除 / 隐藏')
    eq(followGate(3, false).over, false, '刚好等于上限不算「超」')
    eq(followGate(2, false).allowed, true)

    ok(canAddFollow(29, true), '会员未到 30 可继续加')
    notOk(canAddFollow(30, true), '会员到 30 也拦住新增')

    ok(canAddWatch(0, false), '免费档 0 个词可加第一个')
    notOk(canAddWatch(1, false), '免费档到 1 即拦住')
    ok(watchGate(3, false).over, '免费档存量超限 → over=true')
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
    ok(/免费版最多监测 1 个词/.test(watchLimitNote(false)))
    ok(/最多同时监测 10 个词/.test(watchLimitNote(true)))
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
  it('关注：已超免费上限的用户照常全量可看、可取消，只拦新增', async () => {
    const load = withUser()
    const follows = load('utils/follows')

    /* 存量 5 人（> 免费上限 3）：模拟改造前就已经关注超限的老用户。
       _id 必须与真实写入口径一致（`openid#personKey`，见 utils/follows.ts#toggleFollow），
       否则 isFollowed 找不到它、会被当成「未关注」而走新增分支。 */
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

    const add = await follows.toggleFollow('新人物#tech', 'test')
    eq(add, null, '超限时阻止新增（返回 null 失败态）')
    eq((await follows.listFollows()).length, 5, '阻止新增不得删 / 动既有数据')

    const del = await follows.toggleFollow('甲0#tech', 'test')
    eq(del, false, '已有关注对象仍可取消关注（管理既有数据不受限）')
    eq((await follows.listFollows()).length, 4, '取关正常生效')
  })

  it('关注：会员在免费上限处仍可继续新增', async () => {
    const load = withUser()
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
    eq(add, true, '会员上限 30 > 免费 3，在 3 处仍可新增')
    eq((await follows.listFollows()).length, 4)
  })

  it('关键词监控：已超免费上限的订阅照常全量可读、可取消，只拦新增', async () => {
    const load = withUser()
    const ka = load('utils/keyword-alert')

    env.db.__seed(
      'keyword_watches',
      Array.from({ length: 3 }, (_, i) => ({
        _id: `me#词${i}`,
        openid: 'me',
        keyword: `词${i}`,
        created_at: '2026-10-01T00:00:00.000Z',
        seen_at: '2026-10-01T00:00:00.000Z',
        type: 'keyword'
      }))
    )

    eq((await ka.listWatches()).length, 3, '存量订阅照常全部读出 —— 不隐藏、不截断')

    const add = await ka.addWatch('新词')
    eq(add.ok, false, '超限时阻止新增')
    ok(String(add.message).includes('1'), '提示里说明免费档上限')
    eq((await ka.listWatches()).length, 3, '阻止新增不得删 / 动既有订阅')

    eq(await ka.removeWatch('词0'), true, '既有订阅仍可取消')
    eq((await ka.listWatches()).length, 2)
  })

  it('关键词监控：会员可新增到 10（免费上限 1 之上）', async () => {
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
    eq(add.ok, true, '会员在免费上限（1）处仍可新增')
    eq((await ka.listWatches()).length, 2)
  })
})

/* ─────────────── 4. 舆情页明细深度与今日要点（静态 + 纯函数） ─────────────── */

describe('舆情分层：舆情页明细深度与今日要点', () => {
  const page = read('pages/opinion/index.tsx')

  it('明细按会员态截断：引用 opinion-access，会员态每次进入重读，未知数不再写死', () => {
    ok(page.includes("from '@/utils/opinion-access'"), '舆情页应引用 utils/opinion-access')
    ok(page.includes('sliceDetail('), '明细应走 sliceDetail（按会员态截断）')
    ok(page.includes('readMemberState('), '每次进入重读会员态，开通后即生效')
    ok(page.includes('useDidShow('), '读取挂在 useDidShow 上（不引入额外缓存）')
    ok(page.includes('pickDailyFocus('), '今日要点仍走 P1 的 pickDailyFocus（不受明细分层影响）')
    notOk(page.includes('PREVIEW_ROWS'), '不应再有写死的固定条数')
  })

  it('免费档给一行不刺眼的升级提示，点了进会员页（不遮罩、不弹窗）', () => {
    ok(page.includes('moreDetailNote('), '缺「会员可见全部 N 条」提示')
    ok(page.includes('page-opinion__more-detail'), '缺提示行样式钩子')
    ok(page.includes('/pages/member/index'), '提示行应能跳会员页')
  })

  it('免费档明细切到 5 条，而今日要点照常给 3 条（留存钩子不被切）', () => {
    env.resetAll()
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
  it('follows.ts：门禁排在「取消关注」分支之后（取关永远放行）', () => {
    const src = read('utils/follows.ts')
    const delAt = src.indexOf("table('follows').delete().eq('id', id)")
    const gateAt = src.indexOf('followGate(')
    ok(delAt > 0 && gateAt > 0, '两处都应存在')
    ok(gateAt > delAt, '门禁必须在取消关注分支之后 —— 否则会连取关一起拦住')
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
