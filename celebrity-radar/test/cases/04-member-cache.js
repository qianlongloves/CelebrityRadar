'use strict'

/**
 * 共享缓存 × 会员段落（P0 只升不降 / P1 会员补齐免计费，2026-10-09）
 * ＋ 档位隔离（批 1）与免费档成本闸门（批 2，2026-10-09）
 *
 * 要钉住的是这一对冲突：报告是**全局共享缓存**（report_cache 以 personKey 为主键，全站一行），
 * 而「会员段落」是付费内容。于是同一行上会出现两种产物，谁先来谁的版本就在那儿：
 *
 *   P0 只升不降 —— 免费档产物不得覆盖含会员段落的那一版。否则全站会员下次点开都看到
 *      「深度解析」整块消失，而报告一旦 ready 就长期复用、不按时间过期，这个降级不会自愈。
 *   P1 会员补齐 —— 会员要生成的这一份，缓存里现有的还不含会员段落，那他这次刷新实际是
 *      替**全站**把缓存升级，不该掏他自己的每日次数。端上只「申请」，复核在云函数。
 *   批 1 档位隔离 —— 会员段在**数据层**就不下发给非会员（存在性由 memberLocked 单独带回，
 *      否则促销条的承诺会退化成泛泛的招揽）。
 *   批 2 免费档成本闸门 —— 免费档不发社交支线检索；刚生成过的报告不接受免费档的重复刷新。
 *
 * 云函数与端上各存一份判定（同源，无法共用代码），故两处都用源码比对钉住，
 * 避免以后有人只改一边 —— 那会让「能否覆盖」变成两个不同的答案。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const CLOUD = path.resolve(__dirname, '..', '..', 'cloudfunctions')

const read = (p) => fs.readFileSync(p, 'utf8')

function fresh() {
  env.resetAll()
  env.setDebugFlags({
    disableGenerateQuota: false,
    disableAskQuota: false,
    disableRefreshQuota: false,
    disableCooldown: false
  })
  return { load: env.load }
}

/** 最小报告（只放本文件用到的字段） */
function mkReport(over = {}) {
  return Object.assign({ personKey: '测试人物#tech', name: '测试人物', degraded: false }, over)
}

/** 缓存行（state 默认 ready） */
function mkRow(report, state = 'ready') {
  return { id: '测试人物#tech', state, report }
}

const MEMBER_NOTES = { compare: '与同领域的其他人相比……', risk: '接下来值得留意的是……' }
const CONFLICTS = [{ topic: '说法不一', a: 'A 媒称已回应', b: 'B 媒称未回应' }]

/* ------------------------------------------------------- 会员段落判定 */

describe('会员段落判定 utils/cache#hasMemberBlocks', () => {
  it('两个字段都没有 ⇒ 不是会员版（免费报告 / 老报告 / 降级简版）', () => {
    const { load } = fresh()
    const { hasMemberBlocks } = load('utils/cache')

    notOk(hasMemberBlocks(mkReport()))
    notOk(hasMemberBlocks(null))
    notOk(hasMemberBlocks(undefined))
  })

  it('memberNotes 或 conflicts 有其一即算会员版（两段各自可缺）', () => {
    const { load } = fresh()
    const { hasMemberBlocks } = load('utils/cache')

    ok(hasMemberBlocks(mkReport({ memberNotes: MEMBER_NOTES })), '只有 memberNotes 的老会员报告')
    ok(hasMemberBlocks(mkReport({ conflicts: CONFLICTS })), '只有 conflicts 的报告')
  })

  it('空壳不算：空数组 / 两段皆空 —— sanitize 本就不会把它们落库（口径要一致）', () => {
    const { load } = fresh()
    const { hasMemberBlocks } = load('utils/cache')

    notOk(hasMemberBlocks(mkReport({ conflicts: [] })))
    notOk(hasMemberBlocks(mkReport({ memberNotes: { compare: '', risk: '' } })))
  })

  it('与 utils/member#presentSections 同一口径（两处判定不得走偏）', () => {
    const { load } = fresh()
    const { hasMemberBlocks } = load('utils/cache')
    const { presentSections } = load('utils/member')

    const samples = [
      mkReport(),
      mkReport({ memberNotes: MEMBER_NOTES }),
      mkReport({ memberNotes: { compare: '只有一段', risk: '' } }),
      mkReport({ memberNotes: { compare: '', risk: '只有一段' } }),
      mkReport({ conflicts: CONFLICTS }),
      mkReport({ conflicts: [] }),
      mkReport({ memberNotes: { compare: '', risk: '' } })
    ]
    for (const r of samples) eq(hasMemberBlocks(r), presentSections(r).length > 0)
  })
})

/* --------------------------------------------------------- 只升不降（P0） */

describe('只升不降 utils/cache#shouldKeepMemberVersion', () => {
  it('新产物不含会员段 + 缓存里含 ⇒ 拒绝覆盖（保住全站会员版）', () => {
    const { load } = fresh()
    const { shouldKeepMemberVersion } = load('utils/cache')

    ok(shouldKeepMemberVersion(mkReport(), mkRow(mkReport({ memberNotes: MEMBER_NOTES }))))
    ok(shouldKeepMemberVersion(mkReport(), mkRow(mkReport({ conflicts: CONFLICTS }))))
  })

  it('新产物自己就含会员段 ⇒ 照常写（会员刷新、免费档被升上来）', () => {
    const { load } = fresh()
    const { shouldKeepMemberVersion } = load('utils/cache')

    notOk(
      shouldKeepMemberVersion(mkReport({ memberNotes: MEMBER_NOTES }), mkRow(mkReport({ memberNotes: MEMBER_NOTES })))
    )
  })

  it('缓存里不含会员段 ⇒ 照常写（免费档之间互相刷新不受影响）', () => {
    const { load } = fresh()
    const { shouldKeepMemberVersion } = load('utils/cache')

    notOk(shouldKeepMemberVersion(mkReport(), mkRow(mkReport())))
  })

  it('没有可用的既有行（null / 非 ready）⇒ 照常写', () => {
    const { load } = fresh()
    const { shouldKeepMemberVersion } = load('utils/cache')

    notOk(shouldKeepMemberVersion(mkReport(), null))
    notOk(shouldKeepMemberVersion(mkReport(), undefined))
    notOk(shouldKeepMemberVersion(mkReport(), mkRow(mkReport({ memberNotes: MEMBER_NOTES }), 'building')))
  })
})

describe('只升不降已接进生成主流程（源码钉住，防「写了守卫却没人用」）', () => {
  const src = read(path.join(SRC, 'utils/cache.ts'))

  it('saveReady 真的调用了守卫，并回报三态 kept', () => {
    const save = src.slice(src.indexOf('async function saveReady'))
    ok(save.includes('shouldKeepMemberVersion(report, existing)'), 'saveReady 必须先过守卫再写库')
    ok(save.includes("return 'kept'"), '守卫命中要回报 kept（不能静默当作写成功）')
  })

  it('kept 分支交回既有版本，且不消耗配额（没拿到新东西就不该扣次数）', () => {
    const keptAt = src.indexOf("if (saved === 'kept')")
    ok(keptAt > 0, '主流程必须处理 kept')
    ok(src.includes('keptMember: true'), '页面要靠这个标记解释「刷新了却没变化」')

    const quotaAt = src.indexOf("void consumeGenerateQuota(")
    ok(quotaAt > 0)
    ok(keptAt < quotaAt, 'kept 必须在消耗配额之前 return —— 否则等于扣了次数还降级')
  })

  it('只有 generate 会申请免计费，且 target 就是缓存主键', () => {
    ok(src.includes("waiveIf: 'member_upgrade'"))
    ok(src.includes('target: personKey'), '云函数要按 personKey 回读那一行复核')
  })
})

/* --------------------------------------------- 会员补齐免计费（P1，云端） */

describe('会员补齐免计费：云端复核（源码钉住）', () => {
  const guard = read(path.join(CLOUD, 'quotaGuard/index.js'))

  it('复核三个条件：会员生效 + 目标行存在且 ready + 那行确实缺会员段', () => {
    ok(guard.includes('memberUpgradeWaived('), '必须有独立复核函数')
    ok(guard.includes("db.collection('report_cache')"), '必须回读共享缓存那一行')
    ok(guard.includes("cacheRow.state !== 'ready'"))
    ok(guard.includes('hasMemberBlocks(cacheRow.report)'), '已含会员段就不该再免（不然能反复白拿）')
    /* A2（2026-10-09）：会员身份改读服务端权威表 —— users 是「仅创建者可读写」，
       以它为准等于让端上自证会员（自授会员即可白拿这次免计费）。 */
    ok(guard.includes("db.collection('memberships').doc(openid).get()"), '读服务端权威表 memberships')
    ok(guard.includes('isMembershipActive(auth)'), '口径仍是「未过期的 expires_at」')
  })

  it('端上那个标记不可信：复核不过就照常自增（waived 回落 false）', () => {
    ok(guard.includes('waived = false'), '默认不免')
    ok(guard.includes('const r = await incr(table, id, openid)'), '未豁免仍走原自增')
    ok(/waived: false/.test(guard), '未豁免必须如实回报 waived:false')
  })

  it('只开 generate 一条口子（refresh / ask 不受影响）', () => {
    ok(guard.includes("kind === 'generate' && event.waiveIf === MEMBER_UPGRADE"))
  })

  it('与端上会员判定同源：只认 expires_at，不校验 plan', () => {
    ok(guard.includes('Date.parse(m.expires_at)'))
    ok(guard.includes('t > Date.now()'))
    notOk(guard.includes('m.plan'), 'plan 只决定天数，不该进判定')
  })

  it('云函数的「会员段落」判定与端上同源（空壳不算）', () => {
    ok(guard.includes('notes.compare || notes.risk'), 'memberNotes 要看两段文字是否真有内容')
    ok(guard.includes('report.conflicts.length > 0'), 'conflicts 要看是否非空数组')
  })

  it('端上回退路径不认这个申请（拿不到云端裁决就宁可多算一次）', () => {
    const quota = read(path.join(SRC, 'utils/quota.ts'))
    ok(quota.includes("incrQuotaViaCloud('generate', waive)"), '申请要真的送上去')
    ok(quota.includes('cloud.waived'), '免计费只能由云端裁决，端上不自作主张')
  })
})

/* ------------------------------------------- 配额通道的免计费协议（端上） */

describe('配额通道的免计费协议 utils/quota-guard', () => {
  it('不传 waive 时不往云端塞字段（老云函数不受干扰）', async () => {
    const { load } = fresh()
    const { incrQuotaViaCloud } = load('utils/quota-guard')
    let seen = null
    env.registerCloudFn('quotaGuard', (data) => {
      seen = data
      return { ok: true, count: 1 }
    })

    deepEq(await incrQuotaViaCloud('generate'), { count: 1, waived: false }, '缺省不免')
    eq(seen.waiveIf, undefined)
    eq(seen.target, undefined)
  })

  it('传了 waive 则原样送达，云端 waived:true 如实透传', async () => {
    const { load } = fresh()
    const { incrQuotaViaCloud } = load('utils/quota-guard')
    let seen = null
    env.registerCloudFn('quotaGuard', (data) => {
      seen = data
      return { ok: true, count: 3, waived: true }
    })

    deepEq(await incrQuotaViaCloud('generate', { waiveIf: 'member_upgrade', target: '甲#tech' }), {
      count: 3,
      waived: true
    })
    eq(seen.waiveIf, 'member_upgrade')
    eq(seen.target, '甲#tech')
  })
})

/* --------------------------------- 档位隔离：会员段不下发（批 1，2026-10-09） */

/**
 * 批 1 要钉住的是：**内容归会员**这件事已经下沉到数据层。
 *
 * 报告是全局共享缓存，会员生成的那一份带着三段内容，此前只有报告页卡片与目录两处判身份 ——
 * 任何新增的消费方（问答页把报告正文当上下文喂给模型、以后的分享 / 导出）只要忘了判，
 * 就等于把付费内容送出去，而「忘了判」不会有任何报错提示。
 * 现在 utils/cache.ts#exposeReport 在交回**之前**就把非会员的那两段摘掉。
 *
 * 两条口径要一起钉住，缺一个这个改动就白做：
 *   1. 内容剥掉、**存在性保留**（memberLocked）—— 促销条要靠它说清「这份报告里有什么你看不到」，
 *      否则剥离之后那句可兑现的承诺（「已含对比视角…」）会退化成泛泛的招揽；
 *   2. 没有会员段时**不读身份**（快路径）—— 绝大多数报告里没有会员段，若每次都读一次 users，
 *      等于给每次打开报告都加一次库读，而这件事本身是为了省钱才做的。
 */

describe('档位隔离：会员段不下发给非会员（批 1）', () => {
  /**
   * 落库行：`__seed` 认的是 `_id`（db.ts 那层适配负责 id ↔ _id 双向映射，
   * 所以读回来仍是 id，业务代码只认 id）。本文件上方的 mkRow 是给纯函数用的、不带 _id。
   */
  const row = (report, state = 'ready') => ({ _id: '测试人物#tech', state, report })
  /** 含会员段 + 信源分歧的缓存行（会员生成过的那一份） */
  const memberRow = () => row(mkReport({ memberNotes: MEMBER_NOTES, conflicts: CONFLICTS, heat: 88 }))

  /** 把当前读者设成会员：readMemberState 读 users 表自己那一行 */
  const asMember = (db) =>
    db.__seed('users', [
      {
        _id: 'u1',
        _openid: 'me',
        membership: { plan: 'month', expires_at: new Date(Date.now() + 864e5).toISOString() }
      }
    ])

  it('stripMemberSections：剥掉两段、不动原对象，其余字段原样', () => {
    const { load } = fresh()
    const { stripMemberSections } = load('utils/member')

    const row = mkReport({ memberNotes: MEMBER_NOTES, conflicts: CONFLICTS, heat: 88 })
    const out = stripMemberSections(row)

    eq(out.memberNotes, undefined, 'memberNotes 不能跟着出去')
    eq(out.conflicts, undefined, 'conflicts 不能跟着出去')
    eq(out.heat, 88, '其余字段（热度等）要原样保留')
    eq(out.name, '测试人物')
    deepEq(row.memberNotes, MEMBER_NOTES, '原对象不能被就地改掉 —— 它还要拿去写库 / 交给会员')
  })

  it('stripMemberSections：没有可剥的东西时返回**同一引用**（调用方可以到处调，不产生拷贝）', () => {
    const { load } = fresh()
    const { stripMemberSections } = load('utils/member')

    const plain = mkReport({ heat: 1 })
    ok(stripMemberSections(plain) === plain, '无会员段就不该造新对象')
  })

  it('stripMemberSections：只带 memberNotes 的老报告也要剥（两段各自可缺）', () => {
    const { load } = fresh()
    const { stripMemberSections } = load('utils/member')

    eq(stripMemberSections(mkReport({ memberNotes: MEMBER_NOTES })).memberNotes, undefined)
    eq(stripMemberSections(mkReport({ conflicts: CONFLICTS })).conflicts, undefined)
  })

  it('getCachedReport（问答 / 关注流那条只读路径）：非会员拿到的那一份里没有会员段', async () => {
    const { load } = fresh()
    const { getCachedReport } = load('utils/cache')
    env.db.__seed('report_cache', [memberRow()])

    const r = await getCachedReport('测试人物#tech')

    eq(r.name, '测试人物', '报告本身照旧要交回')
    eq(r.memberNotes, undefined)
    eq(r.conflicts, undefined)
  })

  it('getCachedReport：会员原样拿到（权益到期即收回，判定只认 expires_at）', async () => {
    const { load } = fresh()
    const { getCachedReport } = load('utils/cache')
    asMember(env.db)
    env.db.__seed('report_cache', [memberRow()])

    const r = await getCachedReport('测试人物#tech')

    deepEq(r.memberNotes, MEMBER_NOTES)
    deepEq(r.conflicts, CONFLICTS)
  })

  it('getOrBuildReport 缓存命中：非会员被剥，且带回「藏了哪三段」', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [memberRow()])

    const out = await getOrBuildReport('测试人物#tech', {})

    eq(out.kind, 'report')
    eq(out.fromCache, true)
    eq(out.report.memberNotes, undefined)
    /* 促销条靠它说「已含…」（文案见 member#reportMemberPromo） */
    deepEq(out.memberLocked, ['对比视角', '风险提示', '信源分歧'])
  })

  it('getOrBuildReport 缓存命中：会员拿到完整版，memberLocked 为空', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    asMember(env.db)
    env.db.__seed('report_cache', [memberRow()])

    const out = await getOrBuildReport('测试人物#tech', {})

    deepEq(out.report.memberNotes, MEMBER_NOTES)
    deepEq(out.report.conflicts, CONFLICTS)
    deepEq(out.memberLocked, [], '会员没有被藏起来的东西')
  })

  it('报告里没有会员段时**不读身份**（快路径：绝大多数报告不该为这件事多付一次库读）', async () => {
    const { load } = fresh()
    const { getCachedReport } = load('utils/cache')
    env.db.__seed('report_cache', [row(mkReport({ heat: 7 }))])

    const before = env.db.stats.getCalls
    const r = await getCachedReport('测试人物#tech')
    const after = env.db.stats.getCalls

    eq(r.heat, 7)
    eq(after - before, 1, '只该读一次 report_cache —— 多出来的那次就是白读 users')
  })
})

describe('档位隔离已接进读取路径（源码钉住，防「写了剥离函数却没人用」）', () => {
  const src = read(path.join(SRC, 'utils/cache.ts'))

  it('exposeReport 的快路径排在读身份**之前**（没有东西可藏就不问读者是谁）', () => {
    const body = src.slice(src.indexOf('async function exposeReport'))
    const fast = body.indexOf('locked.length === 0')
    const who = body.indexOf('readMemberState')

    ok(fast > 0, '必须保留无会员段的快路径')
    ok(who > 0)
    ok(fast < who, '先算「有没有东西可藏」，再决定要不要读一次身份')
  })

  it('每个交回口都带上了 memberLocked（漏一处 = 一处静默的越权，或一处静默的文案退化）', () => {
    const n = (src.match(/memberLocked: shown\.locked/g) || []).length
    eq(n, 5, '缓存命中 / 等待他人 ×2 / kept / 生成成功 —— 五处交回口一个都不能少')
  })

  it('批量只读一次身份，而不是逐份读（tabBar 页每次切回来都会重跑）', () => {
    const body = src.slice(src.indexOf('export async function getCachedReports'))
    ok(body.includes('ready.some('), '先看有没有人藏着东西，再决定要不要读')
    eq((body.match(/readMemberState\(\)/g) || []).length, 1, '读一次身份，然后 map 剥离')
  })

  it('页面不再从 report 自己算专享段落（剥离之后那是恒空的）', () => {
    const page = read(path.join(SRC, 'pages/report/index.tsx'))

    /* 刻意不写成 includes('presentSections(report)')：说明这件事的注释里就有这句话 */
    notOk(page.includes('reportMemberPromo(presentSections'), '促销条改吃数据层交回的 memberLocked')
    notOk(page.includes('promoRoll(presentSections'), '掷骰子用的也是同一份清单')
    ok(page.includes('reportMemberPromo(memberLocked)'))
    ok(page.includes('promoRoll(memberLocked)'))
  })
})

/* --------------------------------------- 免费档成本闸门（批 2，2026-10-09） */

/**
 * 批 2 的两条闸门都是「免费档不该付的钱别付」，但都**不是**靠限制用户行为：
 *   一条是别买没必要的素材（不发社交支线检索），
 *   一条是别把同一件事买两遍（刚生成过的报告不接受重复刷新）。
 * 二者的风险也对称：省的是成本，伤的是体验 —— 所以每条都要同时钉住「谁不受影响」，
 * 否则以后有人为了省成本把闸门加到用户身上，这份文件里的用例就是他的刹车。
 */

describe('免费档不再付社交支线的检索成本（批 2）', () => {
  /** 记下每一次检索请求（用来数这次生成发了几路） */
  const spySearch = () => {
    const calls = []
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action !== 'search') return { ok: false }
      calls.push(data)
      return {
        ok: true,
        pages: [{ name: '标题', url: 'https://news.example.com/a', snippet: '正文' }]
      }
    })
    return calls
  }

  it('socialCount: 0 —— 只发主线一路，连请求都不发', async () => {
    const { load } = fresh()
    const calls = spySearch()

    const news = await load('utils/search').fetchNews('测试人物', { socialCount: 0 })

    eq(calls.length, 1, '钱花在「发起了一次检索」上 —— 只把条数写成 0 是省不下钱的')
    notOk(calls[0].include, '免掉的那一路是带社交站点白名单的，它不该再出现')
    ok(Array.isArray(news), '素材照常交回 —— 主线才是判据')
    eq(news.length, 1)
  })

  it('不传 socialCount —— 仍是两路（关注流刷新那条链路保持原口径）', async () => {
    const { load } = fresh()
    const calls = spySearch()

    await load('utils/search').fetchNews('测试人物')

    eq(calls.length, 2, 'feed 动态是另一种用途，这次不动它')
    ok(
      calls.some((c) => Array.isArray(c.include) && c.include.length > 0),
      '其中一路是社交站点白名单'
    )
  })

  it('报告生成路径按档位给：免费档零支线，会员档 24+16', () => {
    const src = read(path.join(SRC, 'utils/cache.ts'))

    ok(src.includes(': { socialCount: 0 }'), '免费档要明确说「不要支线」，不能靠默认值')
    ok(src.includes('DEEP_MAIN_COUNT, socialCount: DEEP_SOCIAL_COUNT'), '会员档维持加厚口径')
  })
})

describe('免费档「刷新最新」冷却（批 2）', () => {
  const HOUR = 60 * 60 * 1000

  /** 落库行（`__seed` 认 _id，见上文说明） */
  const row = (report) => ({ _id: '测试人物#tech', state: 'ready', report })
  /** 生成于 ms 毫秒前的报告 */
  const generatedAgo = (ms) => mkReport({ heat: 5, generatedAt: new Date(Date.now() - ms).toISOString() })
  const asMember = (db) =>
    db.__seed('users', [
      {
        _id: 'u1',
        _openid: 'me',
        membership: { plan: 'month', expires_at: new Date(Date.now() + 864e5).toISOString() }
      }
    ])

  it('刚生成过的报告：force 也不再买一遍，直接交回并说明', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [row(generatedAgo(1 * HOUR))])

    const out = await getOrBuildReport('测试人物#tech', { force: true })

    eq(out.kind, 'report')
    eq(out.fromCache, true)
    eq(out.refreshCooled, true, '页面要靠它说明「为什么点了刷新却没变」')
    eq(out.report.heat, 5, '交回的是刚生成过的那一版')
  })

  it('报告旧了：force 照常重新生成（冷却只拦「刚看过就想再刷」）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [row(generatedAgo(48 * HOUR))])

    const out = await getOrBuildReport('测试人物#tech', { force: true })

    eq(out.kind, 'coldstart', '检索通道不可用 → 说明它真的去生成了一次、没被拦下')
  })

  it('会员不受限：他的刷新随时生效（付了钱，不该吃免费档的闸门）', async () => {
    const { load } = fresh()
    asMember(env.db)
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [row(generatedAgo(1 * HOUR))])

    const out = await getOrBuildReport('测试人物#tech', { force: true })

    eq(out.kind, 'coldstart', '会员的刷新要真的打出去')
  })

  it('不 force 的普通浏览永远是命中，且不带冷却标记', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [row(generatedAgo(1 * HOUR))])

    const out = await getOrBuildReport('测试人物#tech', {})

    eq(out.kind, 'report')
    eq(out.fromCache, true)
    eq(out.refreshCooled, undefined, '用户没点刷新，就不该跟他说「刚刚更新过」')
  })

  it('报告没有生成时间时不拦（老缓存里没有这个字段）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [row(mkReport({ heat: 5 }))])

    const out = await getOrBuildReport('测试人物#tech', { force: true })

    eq(out.kind, 'coldstart', '判不出新旧时宁可放行生成，也不凭猜测拦住用户')
  })

  it('快路径：先看时间再看身份（旧报告的 force 不该多读一次 users）', () => {
    const src = read(path.join(SRC, 'utils/cache.ts'))
    const body = src.slice(src.indexOf('async function isFreeRefreshCooling'))
    const time = body.indexOf('FREE_REFRESH_COOLDOWN_MS')
    const who = body.indexOf('readMemberState')

    ok(time > 0 && who > 0)
    ok(time < who, '先算时间（零成本），只有真的落进窗口才读一次身份')
  })
})
