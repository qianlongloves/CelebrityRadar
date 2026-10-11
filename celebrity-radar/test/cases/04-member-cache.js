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
 *   批 2 免费档成本闸门 —— 免费档不发社交支线检索；刚生成过的报告不再被冷却拦下，
 *      而是在确认弹窗里被提醒一句（2026-10-10：拦截撤销，改为「随时可刷 + 先提醒代价」）。
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
/* 同领域坐标（2026-10-12）：会员生成才会有的**结构化**会员段（与 memberNotes / conflicts 同类） */
const PEERS = [{ name: '某同行', gap: '主演作品数量更多，且拿了同档奖项' }]

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

  it('与 utils/member#hasMemberContent 同一口径（两处判定不得走偏）', () => {
    const { load } = fresh()
    const { hasMemberBlocks } = load('utils/cache')
    const { hasMemberContent } = load('utils/member')

    const samples = [
      mkReport(),
      mkReport({ memberNotes: MEMBER_NOTES }),
      mkReport({ memberNotes: { compare: '只有一段', risk: '' } }),
      mkReport({ memberNotes: { compare: '', risk: '只有一段' } }),
      mkReport({ conflicts: CONFLICTS }),
      mkReport({ conflicts: [] }),
      mkReport({ memberNotes: { compare: '', risk: '' } }),
      /* 同领域坐标（2026-10-12）：也是会员生成才会有的字段，两边都必须算「有会员内容」 */
      mkReport({ peers: PEERS }),
      mkReport({ peers: [] })
    ]
    for (const r of samples) eq(hasMemberBlocks(r), hasMemberContent(r))
    ok(hasMemberBlocks(mkReport({ peers: PEERS })), 'peers 非空即算会员版')
    notOk(hasMemberBlocks(mkReport({ peers: [] })), '空数组不算（与 memberNotes / conflicts 同口径）')
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

  it('没有可用的既有行（null / 无内容）⇒ 照常写', () => {
    const { load } = fresh()
    const { shouldKeepMemberVersion } = load('utils/cache')

    notOk(shouldKeepMemberVersion(mkReport(), null))
    notOk(shouldKeepMemberVersion(mkReport(), undefined))
    notOk(shouldKeepMemberVersion(mkReport(), mkRow(mkReport())))
  })

  it('那一行是 building 却仍带着旧内容 ⇒ 照样保护（P0 修复，2026-10-09）', () => {
    const { load } = fresh()
    const { shouldKeepMemberVersion } = load('utils/cache')

    /*
     * 判定**不看 state**：acquire 不再清空 report，于是刷新期间那一行是 state='building'
     * 却仍带着上一版 —— 那正是本次要覆盖掉的东西。
     * 旧实现要求 state==='ready'，而抢占本就把行改成了 building，守卫于是恒不命中：
     * 免费档点一次「刷新最新」就能把全站的会员段落永久抹掉（报告 ready 后长期复用、不自愈）。
     * 这条用例就是钉住那个错。
     */
    ok(
      shouldKeepMemberVersion(mkReport(), mkRow(mkReport({ memberNotes: MEMBER_NOTES }), 'building')),
      'building 行上的会员版同样不许被免费档产物覆盖'
    )
    notOk(
      shouldKeepMemberVersion(mkReport(), mkRow(mkReport(), 'building')),
      'building 行上本来就没会员段 ⇒ 照常写'
    )
  })
})

describe('只升不降已接进生成主流程（源码钉住，防「写了守卫却没人用」）', () => {
  const src = read(path.join(SRC, 'utils/cache.ts'))

  it('saveReady 真的调用了守卫，并回报三态 kept', () => {
    const save = src.slice(src.indexOf('async function saveReady'))
    ok(save.includes('shouldKeepMemberVersion(report, existing)'), 'saveReady 必须先过守卫再写库')
    ok(save.includes("return 'kept'"), '守卫命中要回报 kept（不能静默当作写成功）')
  })

  it('「只升不降」在**落库之前**判并提前 return，且不消耗配额（没拿到新东西就不该扣次数）', () => {
    const saveAt = src.indexOf('const saved = await saveReady')
    const earlyAt = src.indexOf('if (!hasMemberBlocks(report) && shouldKeepMemberVersion(')
    const plainQuotaAt = src.indexOf('void consumeGenerateQuota(userId)')
    const keptBranchAt = src.indexOf("if (saved === 'kept')")

    ok(earlyAt > 0 && saveAt > 0, '必须同时存在「落库前判定」与落库调用')
    ok(earlyAt < saveAt, '只升不降必须在落库之前判 —— 覆盖之后就再也读不到那一版了')
    ok(keptBranchAt > saveAt, '兜底 kept 分支在计数之前 return')
    ok(plainQuotaAt > saveAt, '普通计数在落库之后（落库失败会抛到 catch，同样不计数）')
    ok(src.includes('keptMember: true'), '页面要靠这个标记解释「刷新了却没变化」')
  })

  it('不达标的产物不进共享缓存、也不扣次数（P0，2026-10-11 公平计费 + 防污染）', () => {
    const shortfallAt = src.indexOf('const verdict = shortfallVerdict(report, memberDeep)')
    const saveAt = src.indexOf('const saved = await saveReady')
    const consumeAt = src.indexOf('void consumeGenerateQuota(userId)')

    /*
     * 判定必须**前移到落库之前**：原顺序是「先 saveReady 再判 shortfall」，于是不达标的产物
     * 已经写进全站共享行，只是事后没扣次数 —— 一次上游抖动产出的降级纯文本会覆盖掉该人物
     * 全站的完整报告，而「只升不降」只认会员段、云端写口也没有质量维度，谁都不会拦它。
     */
    ok(shortfallAt > 0 && shortfallAt < saveAt, '达标判定必须在落库之前（不达标的产物一律不写缓存）')
    ok(consumeAt > shortfallAt, '计费点仍在不达标判定之后')
    /* 不达标走独立的提前 return：分支里只放锁，不落库、不计数 */
    const branch = src.slice(shortfallAt, saveAt)
    ok(branch.includes('if (shortfall) {'), '不达标要有独立分支')
    ok(branch.includes('await release(personKey, userId)'), '不达标必须把抢到的锁放掉（否则 building 残留到超时）')
    notOk(/if \(shortfall\) \{[^}]*consumeGenerateQuota/.test(branch), '不达标分支里绝不能调用计费')
    ok(src.includes("track('report_generate_shortfall'"), '不达标要单独埋点，便于观察上游抖动频次')
  })

  /*
   * P2「文案分流」（2026-10-10）：不达标的原因有两类，页面此前一律劝「重试通常就好」——
   * 可其中「实质条目不足」「会员档没有专享段落」的常见原因是**素材本身就不够**（长尾人物
   * 近期报道本来就少）。用户照着重试，每次不扣次数、每次都不达标，白等一场，还会把
   * 「素材少」误解成「服务坏了」。判据取 coverage.items（端上原样统计、不经模型改写）。
   */
  it('不达标要分「上游抖动」与「素材本来就不够」—— 后者不劝重试', () => {
    const { load } = fresh()
    const { reportShortfall, reportShortfallRetryable } = load('utils/report')

    /** 骨架齐、实质条目 0 条的最小报告；coverage.items = 本次检索到几条素材 */
    const mk = (items, over = {}) =>
      Object.assign(
        {
          degraded: false,
          intro: '简介正文',
          analysis: 'AI 点评正文',
          dynamics: [],
          quotes: [],
          timeline: [],
          coverage: { items, recent: items, firstAt: null, latestAt: null }
        },
        over
      )

    ok(reportShortfall(mk(10), false)?.includes('实质条目不足'), '0 条实质条目必须判不达标')
    eq(reportShortfallRetryable(mk(10), false), true, '素材有 10 条却只吐回 0 条 ⇒ 模型少吐，重试通常就好')
    eq(reportShortfallRetryable(mk(1), false), false, '素材本身只有 1 条 ⇒ 重试还是同一批素材，劝重试就是让用户白等')

    /* 骨架段落缺失 / 结构化失败：与素材多寡无关（素材再少，简介也写得出来）⇒ 永远可重试 */
    eq(reportShortfallRetryable(mk(1, { intro: '  ' }), false), true, '缺简介是模型少吐一段')
    eq(reportShortfallRetryable(mk(1, { degraded: true }), false), true, '结构化输出失败是纯上游抖动')

    /* 会员档没有专享段：同样按素材判（原注释自己写着「检索不到素材是常见原因」） */
    const threeFacts = { dynamics: [1, 2, 3].map((i) => ({ title: `动态 ${i}` })) }
    ok(reportShortfall(mk(10, threeFacts), true)?.includes('会员专享'), '会员档没有专享段落要判不达标')
    eq(reportShortfallRetryable(mk(10, threeFacts), true), true, '素材够 ⇒ 重试有意义')
    eq(reportShortfallRetryable(mk(1, threeFacts), true), false, '素材不够 ⇒ 重试没用')

    /* 达标时恒为 false：那时页面根本不渲染这条提示 */
    eq(reportShortfall(mk(10, threeFacts), false), null, '这份达标')
    eq(reportShortfallRetryable(mk(10, threeFacts), false), false, '达标就没有「要不要重试」这回事')
  })

  it('「可重试」要一路带到页面与埋点（源码钉住）：否则判了也没人用', () => {
    ok(src.includes('shortfallVerdict(report, memberDeep)'), '主流程要给出这个判定')
    ok(src.includes('reason: shortfall, retryable'), '埋点带上它，才能从数据上分离「素材少」与「真故障」')
    ok(src.includes('...(shortfall ? { shortfall, shortfallRetryable: retryable } : {})'), '判定要交回页面')
  })

  it('免计费申请在**落库之前**发出（云端复核读的就是那一行，晚一步条件就恒不成立）', () => {
    const waiveAt = src.indexOf('void consumeGenerateQuota(userId, { waiveIf:')
    const saveAt = src.indexOf('const saved = await saveReady')

    ok(waiveAt > 0 && saveAt > 0)
    ok(
      waiveAt < saveAt,
      '否则 quotaGuard 读到的是刚写入的含会员段新版，member_upgrade 复核永远不过（P1 修复）'
    )
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

  it('stripMemberSections：剥掉三段、不动原对象，其余字段原样', () => {
    const { load } = fresh()
    const { stripMemberSections } = load('utils/member')

    const row = mkReport({ memberNotes: MEMBER_NOTES, conflicts: CONFLICTS, peers: PEERS, heat: 88 })
    const out = stripMemberSections(row)

    eq(out.memberNotes, undefined, 'memberNotes 不能跟着出去')
    eq(out.conflicts, undefined, 'conflicts 不能跟着出去')
    eq(out.peers, undefined, 'peers（同领域坐标）不能跟着出去 —— 它也是会员生成才会有的字段')
    eq(out.heat, 88, '其余字段（热度等）要原样保留')
    eq(out.name, '测试人物')
    deepEq(row.memberNotes, MEMBER_NOTES, '原对象不能被就地改掉 —— 它还要拿去写库 / 交给会员')
  })

  it('stripMemberSections：没有可剥的东西时返回**同一引用**（调用方可以到处调，不产生拷贝）', () => {
    const { load } = fresh()
    const { stripMemberSections } = load('utils/member')

    const plain = mkReport({ heat: 1 })
    ok(stripMemberSections(plain) === plain, '无会员段就不该造新对象')
    /* 空 peers 也不算「有会员内容」：仍走快路径 */
    const emptyPeers = mkReport({ peers: [] })
    ok(stripMemberSections(emptyPeers) === emptyPeers, 'peers 为空数组时不该造新对象')
  })

  it('stripMemberSections：只带 memberNotes 的老报告也要剥（三段各自可缺）', () => {
    const { load } = fresh()
    const { stripMemberSections } = load('utils/member')

    eq(stripMemberSections(mkReport({ memberNotes: MEMBER_NOTES })).memberNotes, undefined)
    eq(stripMemberSections(mkReport({ conflicts: CONFLICTS })).conflicts, undefined)
    eq(stripMemberSections(mkReport({ peers: PEERS })).peers, undefined, '只有 peers 的新报告同样要剥')
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
    eq(
      n,
      7,
      '缓存命中 / 等待他人 ×2 / kept / 生成成功 / 不达标交回残版（2026-10-11 新增：不落库也要按身份剥离）/ 刷新失败交回旧版（cachedFallback）—— 七处交回口一个都不能少'
    )
  })

  it('批量只读一次身份，而不是逐份读（tabBar 页每次切回来都会重跑）', () => {
    const body = src.slice(src.indexOf('export async function getCachedReports'))
    ok(body.includes('ready.some('), '先看有没有人藏着东西，再决定要不要读')
    /*
     * 只数**这个函数体**内的次数。以前直接切到文件尾，等于默认「后面没有别的读身份的代码」——
     * 2026-10-10 加了按身份取刷新上限的兜底（tallyRefreshQuota → localRefreshLimit），
     * 那个默认就不成立了：切到下一个顶层 export 之前，范围才对得上。
     */
    const nextExport = body.indexOf('\nexport ', 1)
    const fnBody = nextExport > 0 ? body.slice(0, nextExport) : body
    eq((fnBody.match(/readMemberState\(\)/g) || []).length, 1, '读一次身份，然后 map 剥离')
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

describe('免费档「刷新最新」提醒窗口（批 2 → 2026-10-10 撤销拦截）', () => {
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

  it('刚生成过也照常刷新：不再有冷却拦截（点了刷新必须有反应）', async () => {
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    env.db.__seed('report_cache', [row(generatedAgo(1 * HOUR))])

    const out = await getOrBuildReport('测试人物#tech', { force: true })

    eq(out.kind, 'coldstart', '检索通道不可用 → 说明它真的去生成了一次、没被冷却拦下')
  })

  it('冷却判定降级成提醒：免费档刚生成过 isFreeRefreshCooling=true（弹窗据此多说一句）', async () => {
    const { load } = fresh()
    const { isFreeRefreshCooling } = load('utils/cache')

    eq(await isFreeRefreshCooling(generatedAgo(1 * HOUR)), true)
    eq(await isFreeRefreshCooling(generatedAgo(48 * HOUR)), false, '过了窗口就不再提醒')
  })

  it('会员不受提醒：付了钱、有每日额度，刚生成过也不多说一句', async () => {
    const { load } = fresh()
    asMember(env.db)
    const { isFreeRefreshCooling } = load('utils/cache')

    eq(await isFreeRefreshCooling(generatedAgo(1 * HOUR)), false)
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

/* --------------------------- 只升不降 · 端到端时序（P0 回归，2026-10-09） */

/**
 * 上半部分钉的是**纯函数**，而 P0 那个坑恰恰不在函数里 —— 它在调用时序上：
 * acquire 与 saveReady 之间，那一行上还剩什么。所以这组用例把整条链路跑一遍。
 *
 * 修复前的实测行为：守卫要求 state==='ready'，而抢锁（acquire）本就把行改成了 building，
 * 于是守卫恒不命中 —— 免费档刷一次就能把全站的会员段落永久抹掉（报告 ready 后长期复用、
 * 不自愈）。这类「函数对、时序错」的缺陷只有端到端能拦住，源码字符串钉不住。
 */
describe('只升不降 · 端到端（非会员 force 刷新不得吃掉会员版）', () => {
  const HOUR = 60 * 60 * 1000

  /** 48 小时前生成的会员版报告（旧到可以 force，含 memberNotes） */
  const memberRow = () => ({
    _id: '测试人物#tech',
    state: 'ready',
    report: mkReport({
      heat: 5,
      memberNotes: MEMBER_NOTES,
      generatedAt: new Date(Date.now() - 48 * HOUR).toISOString()
    })
  })

  const asMember = () =>
    env.db.__seed('users', [
      {
        _id: 'u1',
        _openid: 'me',
        membership: { plan: 'month', expires_at: new Date(Date.now() + 864e5).toISOString() }
      }
    ])

  /**
   * 检索可用 + 模型按提示词要求决定是否吐会员段（与「会员段落的提示词只往会员的 system
   * 末尾追加」用例同一套口径）：免费档的提示词里没有那条要求，于是产物不含会员段 ——
   * 正是 P0 要拦下的那份输入。
   */
  /*
   * 2026-10-11：产物必须**达标**（判据见 utils/report.ts#reportShortfall）。
   * 这几条用例钉的是抢锁 / 只升不降 / 中间结果的**时序**，不是计费门槛；而达标判定前置后，
   * 不达标的产物一律不落库 —— 之前这里只回 `{intro:'新简介'}`，四批合并后没有实质条目
   * （dynamics+quotes+timeline < 3），于是整组用例会因为「没落库」而失败，且失败原因与
   * 它们真正想测的东西无关。骨架（intro/analysis）+ 3 条时间线是最低配置。
   * 四批的分批契约是**非严格**对象（多写的键被静默丢弃，见 report.ts#batchSchema 注释），
   * 所以同一份 superset 回给每一批是安全的：各批各取自己的字段。
   */
  const RICH = {
    intro: '新简介',
    /*
     * 必须用**模型侧的契约字段名**：judgement 批要的是 analysisPoints，`analysis` 是 sanitize
     * 从各条拼出来的派生字段（见 report.ts#REPORT_FIELDS 注释）—— 回 analysis 会被 zod 的非严格
     * 对象静默丢弃，于是 report.analysis 为空、整份产物判成「没有 AI 点评正文」。
     */
    analysisPoints: [
      { point: '点评一。', basis: '据公开资料' },
      { point: '点评二。', basis: '据公开资料' }
    ],
    timeline: [
      { date: '2026-09-01', event: '事件一' },
      { date: '2026-08-01', event: '事件二' },
      { date: '2026-07-01', event: '事件三' }
    ]
  }
  const online = () => {
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action === 'search') {
        return { ok: true, pages: [{ name: '标题', url: 'https://news.example.com/a', snippet: '正文' }] }
      }
      const asked = data.messages[0].content.includes('会员补充要求')
      return {
        ok: true,
        content: JSON.stringify(asked ? { ...RICH, memberNotes: MEMBER_NOTES } : RICH)
      }
    })
  }

  it('免费档 force 刷新：交回会员版、不落库、锁要放掉（state 不得残留 building）', async () => {
    const { load } = fresh()
    const { getOrBuildReport, hasMemberBlocks } = load('utils/cache')
    online()
    env.db.__seed('report_cache', [memberRow()])

    const out = await getOrBuildReport('测试人物#tech', { force: true })

    eq(out.kind, 'report')
    eq(out.keptMember, true, '页面要靠这个标记解释「为什么点了刷新却没变化」')

    const row = env.db.__dump('report_cache')[0]
    eq(row.state, 'ready', '不落库也要放掉锁 —— 否则该行以 building 残留，读者只能排队到超时')
    ok(hasMemberBlocks(row.report), '会员段落必须还在 —— 这正是修复 P0 之前会丢掉的东西')
    eq(row.report.intro, undefined, '免费档那份简版内容一个字都不许写进去')
  })

  it('会员 force 刷新：照常写入，这一次真的把会员段更新了（闸门只拦降级）', async () => {
    const { load } = fresh()
    const { getOrBuildReport, hasMemberBlocks } = load('utils/cache')
    asMember()
    online()
    env.db.__seed('report_cache', [memberRow()])

    const out = await getOrBuildReport('测试人物#tech', { force: true })

    eq(out.keptMember, undefined, '会员自己的刷新不该被「只升不降」拦下')

    const row = env.db.__dump('report_cache')[0]
    eq(row.state, 'ready')
    ok(hasMemberBlocks(row.report), '会员产物本来就含会员段')
    eq(row.report.intro, '新简介', '会员这一次是真的重新生成了')
  })

  it('分批生成：每批成功都把中间结果写进 building 行的 parts，成品落库后作废', async () => {
    const { load } = fresh()
    const cache = load('utils/cache')
    /* 每次模型调用**前**先看一眼行上的 parts —— 它就是「上一批」的落库结果 */
    const before = []
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action === 'search') {
        return { ok: true, pages: [{ name: '标题', url: 'https://news.example.com/a', snippet: '正文' }] }
      }
      /*
       * 检索词规划（purpose: 'aux'，2026-10-11）也在 data.messages 里，但它发生在**检索之前**、
       * 是每次生成额外的一次调用，不属于「报告批次」—— 混进 before 会让「每批一次」失真。
       */
      if (data.purpose === 'aux') {
        return { ok: true, content: JSON.stringify({ news: ['近期动态'], profile: ['履历'] }) }
      }
      if (data.messages) {
        const row = env.db.__dump('report_cache')[0]
        before.push(row ? row.parts : null)
        /* 同样必须是达标产物（见上方 RICH 注释）：不落库的产物没有 parts 可看，本用例会失真 */
        return { ok: true, content: JSON.stringify(RICH) }
      }
      /* 写口回「通道未就绪」⇒ 走端上直写（正是 P0-2 收紧前的既有行为） */
      return { ok: false, error: '云函数未部署' }
    })

    const out = await cache.getOrBuildReport('测试人物#tech')
    eq(out.kind, 'report')

    eq(before.length, 4, '按模板四组各一次调用')
    eq(before[0], null, '第一批之前还没有中间结果')
    eq(before[1].length, 1, '第一批成功后已落库一批 —— 后面几批失败时这一批的 token 不作废')
    eq(before[2].length, 2)
    eq(before[3].length, 3)
    eq(
      env.db.__dump('report_cache')[0].parts,
      null,
      '成品落库后中间结果作废（save 是整篇替换，别让旧的过程记录留着误导排障）'
    )
  })

  it('分批进度：onProgress 报出「检索 → 生成 0/4 → 1/4 … 4/4」（2026-10-11）', async () => {
    /*
     * 等待动画此前只按秒数估算，分批后系统明明知道走到第几批。这条钉住真实的进度信号：
     * 先报「检索」，进生成前报 0/4，之后每批成功 +1，总批数取自 REPORT_BATCHES。
     * 页面据此显示「已完成 X/4 批」（页面侧由 01-pure 的源码断言钉住透传链）。
     */
    const { load } = fresh()
    const { getOrBuildReport } = load('utils/cache')
    online()

    const seen = []
    const out = await getOrBuildReport('测试人物#tech', { onProgress: (p) => seen.push(p) })
    eq(out.kind, 'report')

    eq(seen[0].stage, 'search', '第一步是检索素材')
    eq(seen[0].done, 0)
    const gen = seen.filter((p) => p.stage === 'generate').map((p) => p.done)
    deepEq(gen, [0, 1, 2, 3, 4], '进生成时报 0/4，每批成功 +1，最后一批到 4/4')
    ok(seen.every((p) => p.total === 4), '总批数恒等于 REPORT_BATCHES.length（分批数真源）')
    /* 落库失败等等都不该影响进度回调（这里只关心「有没有走到 4/4」） */
    eq(seen[seen.length - 1].done, 4)
  })
})

/* --------------------------- 刷新失败交回旧版（P1-8，2026-10-09） */

/**
 * 「刷新最新」是在**已经读着的内容上**再点一次。修复前失败分支直接返回 `{kind:'error'}`，
 * 页面就把它渲染成「生成失败」空态 —— 上游抖一下，用户从「有一份能读的报告」变成
 * 「什么都没有」，而报告一旦 ready 就长期复用、刷新失败本不该把它从读者眼前拿走。
 *
 * 这里用端到端钉住整条链路：一次 getOrBuildReport 走完「检索成功 + 模型整条失败」，
 * 返回的必须是缓存里原来的那一版 + refreshFailed 标记 + 已放锁的 ready 行。
 */
describe('force 刷新失败不得清空正在读的报告（P1-8）', () => {
  const HOUR = 60 * 60 * 1000

  const oldRow = () => ({
    _id: '测试人物#tech',
    state: 'ready',
    report: mkReport({
      heat: 5,
      intro: '旧版简介',
      generatedAt: new Date(Date.now() - 48 * HOUR).toISOString()
    })
  })

  /** 检索可用，但模型整条链路（结构化 + 降级纯文本）都失败；返回调用计数 */
  const flaky = () => {
    let n = 0
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action === 'search') {
        return { ok: true, pages: [{ name: '标题', url: 'https://news.example.com/a', snippet: '正文' }] }
      }
      n += 1
      return { ok: false, kind: 'upstream', error: '大模型服务暂时不可用（502）' }
    })
    return () => n
  }

  it('force 失败：交回缓存旧版 + refreshFailed，缓存与锁都不被弄坏', async () => {
    const { load } = fresh()
    const cache = load('utils/cache')
    const calls = flaky()
    env.db.__seed('report_cache', [oldRow()])

    const out = await cache.getOrBuildReport('测试人物#tech', { force: true })

    eq(out.kind, 'report', '刷新失败绝不能把用户从报告页打回错误页')
    eq(out.fromCache, true)
    eq(out.refreshFailed, true)
    eq(out.report.intro, '旧版简介', '交回的必须是原来那一版，一个字都不能少')
    ok(typeof out.refreshError === 'string' && out.refreshError.length > 0, '要带上一句可展示的原因')
    ok(calls() >= 1, '确实尝试过刷新')

    const row = env.db.__dump('report_cache')[0]
    eq(row.state, 'ready', '失败也要放锁，否则全站排队到超时')
    eq(row.report.intro, '旧版简介', '失败不得写坏既有缓存')
  })

  it('缓存里没有可交回的旧版（首次生成就失败）：照旧 error，不伪造 refreshFailed', async () => {
    const { load } = fresh()
    const cache = load('utils/cache')
    flaky()

    const out = await cache.getOrBuildReport('测试人物#tech', { force: true })

    eq(out.kind, 'error')
    notOk(out.refreshFailed)
  })

  it('refreshFailureNote：成功不出提示，「正在生成」也不出（那是等待态），其余失败给人话', () => {
    const { load } = fresh()
    const { refreshFailureNote } = load('utils/cache')

    eq(refreshFailureNote({ kind: 'report', report: mkReport() }), null, '拿到新内容就别多嘴')
    eq(
      refreshFailureNote({
        kind: 'report',
        report: mkReport(),
        refreshFailed: true,
        refreshError: '上游不可用（502）'
      }),
      '上游不可用（502）',
      '刷新失败时原样给出原因'
    )
    eq(
      refreshFailureNote({ kind: 'report', report: mkReport(), refreshFailed: true }),
      '刷新失败，继续显示当前版本',
      '没带原因也要给一句兜底，不能让提示条空着'
    )
    eq(
      refreshFailureNote({ kind: 'error', message: '该人物正在生成中，请稍候' }),
      null,
      '「正在生成」是别人在生成，页面会切等待态，不该再叠一句失败提示'
    )
    ok(typeof refreshFailureNote({ kind: 'coldstart' }) === 'string')
    ok(typeof refreshFailureNote({ kind: 'nonews' }) === 'string')
    ok(typeof refreshFailureNote({ kind: 'refused' }) === 'string')
    ok(typeof refreshFailureNote({ kind: 'error', message: '上游不可用' }) === 'string')
  })
})

/* ------------------------------------------- 无素材兜底的作用域冷却（P1，2026-10-11） */

describe('「该人物暂无素材」的作用域冷却（P1：同一个人物不被反复重跑）', () => {
  /**
   * 检索通道可用但**一条都抓不到**（`pages: []` —— 端上据此判 nonews，口径见 07 的
   * 「空数组 = 抓到了但没内容」用例），这就是 nonews 分支的入口。
   *
   * 为什么这条链路必须有冷却：它的产物**不入共享缓存、也不计用户次数**（两条都是对的，
   * 见 utils/cache.ts 那处注释），合起来的效果就是「同一个人物可以无限重跑」——
   * 每点一次刷新 = 一次全量检索（main + social + bg，源侧最多 3 次尝试）加一次模型调用，
   * 产物却永远不落库。故断言钉在「第二轮一次检索都不再发」上。
   *
   * 本文件刻意**不开** isCloudConfigured（04 那批 coldstart 用例的前提就是它关着），
   * 因此模型知识兜底本身可能因通道未就绪而失败 —— 与本用例无关：冷却记在兜底**之前**，
   * 只要检索通道可用（`news !== null`）就会记上。首轮的 kind 因此放宽到两种合法结果。
   */
  it('同一人物第二轮被冷却挡住（一次检索都不再发），其余人物不受影响', async () => {
    const { load } = fresh()
    let searches = 0
    /*
     * 假上游分三类（照抄同文件「分批中间结果」那条用例的判据）：
     *   search → 通道可用但一条都没抓到（nonews 分支的入口）；
     *   带 messages → 模型调用（知识兜底，回一份最小产物）；
     *   其余（写口：抢锁 / 落库 / parts）→ 「云函数未部署」⇒ 端上按 P0-2 走 degraded 直写。
     * 不注册写口替身是有意的：那会让抢锁走「接管既有行」并依赖假响应的解析细节，
     * 与本节要测的「无素材冷却」无关（758 那条用例已经覆盖了抢锁那条链路）。
     */
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action === 'search') {
        searches++
        return { ok: true, pages: [] }
      }
      if (data.messages) return { ok: true, content: JSON.stringify({ intro: '张某，演员。' }) }
      return { ok: false, error: '云函数未部署' }
    })
    const { getOrBuildReport } = load('utils/cache')
    /* 前置：作用域冷却这套读写在测试环境里是通的（关掉冷却开关时它会一律返回 0） */
    const { setScopedCooldown, scopedCooldownRemainingMs } = load('utils/cooldown')
    setScopedCooldown('search', '冷却自检#tech')
    ok(
      scopedCooldownRemainingMs('search', '冷却自检#tech') > 0,
      '作用域冷却本身要可用（否则本用例的失败原因不在被测逻辑上）'
    )

    const first = await getOrBuildReport('测试人物#tech', { force: true })
    const afterFirst = searches
    ok(afterFirst > 0, `首轮要真的打出去检索，否则本用例测的不是这条链路：${first.kind}`)
    ok(
      first.kind === 'report' || first.kind === 'nonews',
      `首轮只能是「兜底报告」或「素材空态」：${first.kind}`
    )

    const second = await getOrBuildReport('测试人物#tech', { force: true })

    eq(
      searches,
      afterFirst,
      `冷却期内第二轮不得再发起任何检索（${afterFirst} → ${searches}）—— 这正是这条冷却存在的理由`
    )
    eq(second.kind, 'nonews', '没有旧版可交回时进素材空态（§2.4）')

    /* 冷却按 personKey 分开记：另一个人物照常打检索。否则就成了设备级封禁，方向反了 */
    await getOrBuildReport('另一个人物#tech', { force: true })
    ok(searches > afterFirst, '冷却只封这一个人物')
  })

  it('通道未就绪（news === null）不记冷却：那是配置问题，不该由某个人物承担', async () => {
    const { load } = fresh()
    /* 不注册 aiProxy：callCloudFunction 抛错 → pagesViaPlatform 返回 null → coldstart */
    const { getOrBuildReport } = load('utils/cache')

    const first = await getOrBuildReport('测试人物#tech', { force: true })
    eq(first.kind, 'coldstart', '通道未就绪走 coldstart')

    /*
     * 第二次仍是 coldstart（而不是被冷却挡成 nonews）= 没记冷却。
     * 这条区分很重要：通道没配好是**设备级**问题，下次进来本就该重新探测；
     * 若在这里也记冷却，用户配好通道后还要再等 10 分钟才能查这个人。
     */
    const second = await getOrBuildReport('测试人物#tech', { force: true })
    eq(second.kind, 'coldstart', '通道未就绪不得记「该人物无素材」的冷却')
  })
})
