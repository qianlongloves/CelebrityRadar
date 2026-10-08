'use strict'

/** 配额与问答：配额云端通道 / 生成配额 / 会员权益 / 问答闸门与计数 / 问答语料 */

const dayjs = require('dayjs')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq, rejects } = require('../harness/t')

/**
 * 本文件的用例一律按「线上口径」跑：先把全部调试开关关掉再加载模块（见 env.setDebugFlags）。
 *
 * 开关只服务本地手工联调，不该决定用例的判定依据 —— 否则「额度用尽应拦下」这类用例
 * 会随本机 config/public.ts 的取值忽红忽绿（想图方便的人不该顺带改掉测试语义）。
 * 要验证开挂路径的用例显式传 flags（`fresh({ disableAskQuota: true })`）。
 */
const ALL_OFF = {
  disableGenerateQuota: false,
  disableAskQuota: false,
  disableRefreshQuota: false,
  disableCooldown: false
}

function fresh(flags) {
  env.resetAll()
  /* 顺序不能反：setDebugFlags 必须作用在 resetModules 之后重新 require 到的那份配置上 */
  env.setDebugFlags(Object.assign({}, ALL_OFF, flags))
  return { db: env.db, load: env.load }
}

/** 登录一个用户并返回 userId */
function login(id = 'u-me') {
  const store = env.load('stores/auth')
  store.useAuth.getState().setLogin({ userId: id })
  return id
}

/** 造一份最小报告（只放 buildPassages / selectPassages 用到的字段） */
function mkReport(over = {}) {
  return Object.assign(
    {
      personKey: '测试人物#tech',
      name: '测试人物',
      heat: 60,
      generatedAt: '2026-10-07T10:00:00.000Z',
      intro: '',
      summary: '',
      analysis: '',
      dynamics: [],
      quotes: [],
      timeline: [],
      stance: [],
      coverage: null,
      degraded: false
    },
    over
  )
}

function dyn(over = {}) {
  return Object.assign({ title: '', summary: '', source: '', url: '', date: '', sentiment: 'neutral' }, over)
}

const USAGE_KEY = 'qa:usage'
const LAST_KEY = 'qa:last_at'
const todayKey = () => dayjs().format('YYYY-MM-DD')

/* ------------------------------------------------- 配额云端通道 quota-guard */

describe('配额云端通道 utils/quota-guard', () => {
  it('云函数未部署时返回 null（交调用方回退本机计数）', async () => {
    const { load } = fresh()
    const { incrQuotaViaCloud } = load('utils/quota-guard')
    eq(await incrQuotaViaCloud('generate'), null)
  })

  it('云端成功返回自增后的计数，且把 kind / action 原样送达', async () => {
    const { load } = fresh()
    const { incrQuotaViaCloud } = load('utils/quota-guard')
    let seen = null
    env.registerCloudFn('quotaGuard', (data) => {
      seen = data
      return { ok: true, kind: data.kind, date: todayKey(), count: 7, created: false }
    })

    eq(await incrQuotaViaCloud('ask'), 7)
    eq(seen.kind, 'ask')
    eq(seen.action, 'consume')
  })

  it('云端返回 ok:false 时返回 null（不把失败当成功）', async () => {
    const { load } = fresh()
    const { incrQuotaViaCloud } = load('utils/quota-guard')
    env.registerCloudFn('quotaGuard', () => ({ ok: false, error: '权限拒绝' }))
    eq(await incrQuotaViaCloud('generate'), null)
  })

  it('云端抛错时返回 null（异常不外泄给业务层）', async () => {
    const { load } = fresh()
    const { incrQuotaViaCloud } = load('utils/quota-guard')
    env.registerCloudFn('quotaGuard', () => { throw new Error('boom') })
    eq(await incrQuotaViaCloud('refresh'), null)
  })

  it('云端 ok 但缺 count 视为失败（缺少权威计数不能当 0）', async () => {
    const { load } = fresh()
    const { incrQuotaViaCloud } = load('utils/quota-guard')
    env.registerCloudFn('quotaGuard', () => ({ ok: true, kind: 'generate' }))
    eq(await incrQuotaViaCloud('generate'), null)
  })

  it('三类配额共用同一通道，kind 分别透传', async () => {
    const { load } = fresh()
    const { incrQuotaViaCloud } = load('utils/quota-guard')
    const kinds = []
    env.registerCloudFn('quotaGuard', (data) => {
      kinds.push(data.kind)
      return { ok: true, count: kinds.length }
    })
    eq(await incrQuotaViaCloud('generate'), 1)
    eq(await incrQuotaViaCloud('refresh'), 2)
    eq(await incrQuotaViaCloud('ask'), 3)
    deepEq(kinds, ['generate', 'refresh', 'ask'])
  })
})

/* --------------------------------------------------------- 会员权益 member */

describe('会员权益层 utils/member', () => {
  it('isMembershipActive：只认「合法且未过期」的 expires_at', () => {
    const { load } = fresh()
    const { isMembershipActive } = load('utils/member')
    const future = new Date(Date.now() + 864e5).toISOString()
    const past = new Date(Date.now() - 864e5).toISOString()

    eq(isMembershipActive(null), false)
    eq(isMembershipActive(undefined), false)
    eq(isMembershipActive({}), false, '无有效期不算会员')
    eq(isMembershipActive({ expires_at: '' }), false)
    eq(isMembershipActive({ expires_at: '不是日期' }), false, '不可解析的日期不算会员')
    eq(isMembershipActive({ expires_at: past }), false, '已过期不算会员')
    eq(isMembershipActive({ expires_at: future }), true)
    eq(isMembershipActive({ plan: '任意套餐', expires_at: future }), true, 'plan 不参与判定')
  })

  it('额度与展示文案同源：数字全部取自 MEMBER_BENEFITS', () => {
    const { load } = fresh()
    const m = load('utils/member')
    eq(m.FREE_DAILY_GENERATE_LIMIT, m.MEMBER_BENEFITS.generatePerDay.free)
    eq(m.MEMBER_DAILY_GENERATE_LIMIT, m.MEMBER_BENEFITS.generatePerDay.member)
    eq(m.FREE_DAILY_ASK_LIMIT, m.MEMBER_BENEFITS.askPerDay.free)
    eq(m.MEMBER_DAILY_ASK_LIMIT, m.MEMBER_BENEFITS.askPerDay.member)
    eq(m.dailyGenerateLimit(false), m.MEMBER_BENEFITS.generatePerDay.free)
    eq(m.dailyGenerateLimit(true), m.MEMBER_BENEFITS.generatePerDay.member)
    eq(m.dailyAskLimit(false), m.MEMBER_BENEFITS.askPerDay.free)
    eq(m.dailyAskLimit(true), m.MEMBER_BENEFITS.askPerDay.member)

    const joined = m.MEMBER_BENEFIT_POINTS.map((p) => `${p.title}${p.note}`).join('\n')
    ok(joined.includes(String(m.MEMBER_DAILY_GENERATE_LIMIT)), '权益说明应含会员生成上限')
    ok(joined.includes(String(m.MEMBER_DAILY_ASK_LIMIT)), '权益说明应含会员提问上限')
    ok(joined.includes(String(m.FREE_DAILY_GENERATE_LIMIT)), '权益说明应含免费生成上限')
    ok(joined.includes(String(m.FREE_DAILY_ASK_LIMIT)), '权益说明应含免费提问上限')
    /* 5 条：模型分级（O-10）/ 深度模式（O-11）/ 生成额度 / 提问额度 / 顺延叠加
       （原第 6 条「热门榜看全部 24 位」随 2026-10-08 撤销分档一并删除，见下一个用例） */
    eq(m.MEMBER_BENEFIT_POINTS.length, 5)
  })

  it('热门榜不分档（2026-10-08 撤销 O-19）：策略、派生常量与两处文案全部清掉', () => {
    const { load } = fresh()
    const m = load('utils/member')
    /* 三处必须同时消失：策略留着，下一个人就会照着它把 6 / 24 再写一遍 */
    eq(m.MEMBER_BENEFITS.hotBoardShown, undefined, '权益表不应再有热门榜位数策略')
    eq(m.FREE_HOT_BOARD_LIMIT, undefined)
    eq(m.MEMBER_HOT_BOARD_LIMIT, undefined)

    const joined = m.MEMBER_BENEFIT_POINTS.map((p) => `${p.title}${p.note}`).join('\n')
    notOk(joined.includes('热门榜'), `会员权益不应再把热门榜当卖点：${joined}`)
    notOk(/\d+\s*位/.test(joined), `权益文案不应再出现「N 位」：${joined}`)

    /* 反向：它现在属于「不买也能用」，必须出现在免费清单里，且与其它能力同一口径 */
    ok(m.FREE_FEATURES_NOTE.includes('热门榜'), `免费清单应写明热门榜免费：${m.FREE_FEATURES_NOTE}`)
    notOk(m.FREE_FEATURES_NOTE.includes('位'), `免费清单不应再写位数：${m.FREE_FEATURES_NOTE}`)
  })

  it('免费清单不含 AI 问答（它另有额度，不能承诺不限次）', () => {
    const { load } = fresh()
    const { FREE_FEATURES_NOTE } = load('utils/member')
    notOk(/问答|提问/.test(FREE_FEATURES_NOTE), `免费清单不应含问答：${FREE_FEATURES_NOTE}`)
    ok(/收藏|历史|热门/.test(FREE_FEATURES_NOTE), '应写明免费开放的能力')
  })

  it('额度用尽文案：免费版带升级引导，会员版不再推销', () => {
    const { load } = fresh()
    const { quotaExhaustedMessage, askQuotaExhaustedMessage, MEMBER_BENEFITS } = load('utils/member')

    const free = quotaExhaustedMessage(false, MEMBER_BENEFITS.generatePerDay.free, '已生成的报告仍可浏览')
    ok(free.includes('免费版'), `实际：${free}`)
    ok(free.includes('明日 0 点恢复'), `实际：${free}`)
    ok(free.includes(String(MEMBER_BENEFITS.generatePerDay.member)), '免费版应给出升级后的额度')
    ok(free.endsWith('已生成的报告仍可浏览'), 'tail 应拼在末尾')

    const member = quotaExhaustedMessage(true, MEMBER_BENEFITS.generatePerDay.member, 'tail')
    ok(member.includes('会员'), `实际：${member}`)
    notOk(member.includes('开通会员'), '会员自身用完不应再引导升级')

    const askFree = askQuotaExhaustedMessage(false, MEMBER_BENEFITS.askPerDay.free)
    ok(askFree.includes(String(MEMBER_BENEFITS.askPerDay.member)), '提问用尽也应给出升级额度')
    const askMember = askQuotaExhaustedMessage(true, MEMBER_BENEFITS.askPerDay.member)
    notOk(askMember.includes('开通会员'), '会员提问用尽不应再引导升级')
  })

  it('readMemberState：users 无行时按非会员（读不到不等于买了）', async () => {
    const { load } = fresh()
    const { readMemberState } = load('utils/member')
    deepEq(await readMemberState(), { member: false, plan: null, expiresAt: null, daysLeft: -1 })
  })

  it('readMemberState：有效期内为会员，daysLeft 向上取整（到期当天为 1）', async () => {
    const { db, load } = fresh()
    const expires = new Date(Date.now() + 90 * 60 * 1000).toISOString() // 1.5 小时后
    db.__seed('users', [{ _id: 'u1', _openid: 'me', membership: { plan: 'month', expires_at: expires } }])

    const st = await load('utils/member').readMemberState()
    eq(st.member, true)
    eq(st.plan, 'month')
    eq(st.expiresAt, expires)
    eq(st.daysLeft, 1, '不到一天也应报 1 天，不能显示 0')
  })

  it('readMemberState：users 集合不可用时按非会员（保守，不放大免费额度）', async () => {
    const { db, load } = fresh()
    db.__setFailing('users', true)
    deepEq(await load('utils/member').readMemberState(), {
      member: false, plan: null, expiresAt: null, daysLeft: -1
    })
  })
})

/* ---------- 报告页会员促销条 utils/member（O-21 立起 / O-25 收敛 / O-26 降频可关闭） */

describe('报告页会员促销条 utils/member（O-21 立起 / O-25 收敛 / O-26 降频可关闭）', () => {
  it('presentSections：只认实际存在的专享段落，顺序固定、空串跳过', () => {
    const { load } = fresh()
    const { presentSections } = load('utils/member')

    deepEq(presentSections(null), [])
    deepEq(presentSections(undefined), [])
    deepEq(presentSections({}), [])
    deepEq(presentSections({ memberNotes: { compare: '', risk: '' } }), [], '空串不算存在')
    deepEq(presentSections({ conflicts: [] }), [], '空数组合不算存在')
    deepEq(presentSections({ memberNotes: { compare: '有', risk: '' } }), ['对比视角'])
    deepEq(presentSections({ memberNotes: { compare: '', risk: '有' } }), ['风险提示'])
    deepEq(presentSections({ conflicts: [{ topic: '争点' }] }), ['信源分歧'], '只有分歧的老缓存也要认得')
    deepEq(
      presentSections({ memberNotes: { compare: 'a', risk: 'b' }, conflicts: [{ topic: 'x' }] }),
      ['对比视角', '风险提示', '信源分歧']
    )
    /* 顺序即报告页卡片里的渲染顺序（memberNotes 在 conflicts 之前），不随字段出现顺序变 */
    deepEq(
      presentSections({ conflicts: [{ topic: 'x' }], memberNotes: { compare: 'a', risk: '' } }),
      ['对比视角', '信源分歧']
    )
  })

  it('免费用户：报告里有专享段 → 点名实际那几段并给「开通会员」', () => {
    const { load } = fresh()
    const { reportMemberPromo, MEMBER_SECTIONS } = load('utils/member')

    const v = reportMemberPromo(['对比视角', '风险提示'])
    ok(v.text.includes('对比视角'), `实际：${v.text}`)
    ok(v.text.includes('风险提示'), `实际：${v.text}`)
    eq(v.action, '开通会员', '有内容时给的是「现在就能看到」的承诺')
    notOk(v.text.includes(MEMBER_SECTIONS[2]), '没出现的段落不该写进文案')

    /*
     * 单行渲染的长度预算：条子 nowrap + 省略号（见 report/index.scss 的 `&__vip-note`），
     * 文案超长会被裁掉尾巴（「信源分歧」被裁成「信…」等于没说），故把上限钉在这里。
     * 18 字是按 750rpx 机型反推的可用宽度（约 400rpx ÷ 22rpx 字号）留出余量后的结果。
     */
    const longest = reportMemberPromo([...MEMBER_SECTIONS])
    ok(longest.text.length <= 18, `最长一档 ${longest.text.length} 字会撑爆单行：${longest.text}`)
  })

  it('免费用户：无专享段 → 不承诺当前这一份，只说会员生成会多出什么', () => {
    const { load } = fresh()
    const { reportMemberPromo } = load('utils/member')

    const empty = reportMemberPromo([])
    eq(empty.action, '了解会员', '这一份没有，就只引导「了解会员」而不是「开通」')
    ok(empty.text.includes('加厚'), `顺带说明检索加厚这一半权益：${empty.text}`)
    notOk(empty.text.includes('已含'), `没有的东西不能说已有：${empty.text}`)
  })

  it('促销条只服务免费用户：函数不收会员参数，会员态由页面整条不渲染（O-25）', () => {
    const { load } = fresh()
    const m = load('utils/member')

    /*
     * 用「签名只有 1 个入参」当断言：O-21 的四态函数多带一个 member 参数，于是
     * 「会员该看什么」天然多了一个可以随手补文案的位置；删掉参数后，谁要再给会员写
     * 促销语就得先改签名 —— 那一刻这条断言会拦下来。
     */
    eq(m.reportMemberPromo.length, 1, 'reportMemberPromo 只应接受 present 一个参数')
    ok(m.reportMemberValue === undefined, '旧的四态函数应已删除，不能留着再被复用')
  })

  it('降频（O-26）：有专享段的概率高于纯招揽，且骰子可复现', () => {
    const { load } = fresh()
    const m = load('utils/member')

    ok(m.PROMO_SHOW_RATE_OFFER > m.PROMO_SHOW_RATE, '有内容时是服务性说明，概率应更高')
    ok(m.PROMO_SHOW_RATE > 0 && m.PROMO_SHOW_RATE_OFFER < 1, '两档都要是「随机」而不是恒真恒假')

    /*
     * 注入 rand 钉住比较方向：0 必中、1 必不中。写成 `rand() > rate` 这类反向比较时，
     * 这两条会立刻红 —— 概率写反了肉眼是看不出来的（30% 还是 70% 都得跑几十次才像）。
     */
    eq(m.promoRoll(['对比视角'], () => 0), true)
    eq(m.promoRoll([], () => 0), true)
    eq(m.promoRoll(['对比视角'], () => 1), false)
    eq(m.promoRoll([], () => 1), false)

    /* 取两档之间：同一颗骰子，有内容的出现、纯招揽跳过 */
    const mid = (m.PROMO_SHOW_RATE_OFFER + m.PROMO_SHOW_RATE) / 2
    eq(m.promoRoll(['对比视角'], () => mid), true, '两档之间：有专享段的应展示')
    eq(m.promoRoll([], () => mid), false, '两档之间：纯招揽应跳过')
  })

  it('可关闭（O-26）：本机记住「别再出现」，清空我的数据时复位', () => {
    const { load } = fresh()
    const m = load('utils/member')

    eq(m.isPromoDismissed(), false, '默认没关过（storage 里读不到就是没关）')
    m.dismissPromo()
    eq(m.isPromoDismissed(), true, '点过 × 之后应记住')

    /*
     * 关闭是**全局**的、与「这份报告」无关：换一份报告也不该重新出现。
     * 页面侧的顺序是「先看标记、再掷骰子」（见 pages/report 的 promoRolled 效果）。
     */
    load('utils/settings').clearLocalSettings()
    eq(m.isPromoDismissed(), false, '清空我的数据应把这条本机记忆一起复位')
  })
})

/* --------------------------- 会员中心真实示例 utils/member-sample（O-22） */

describe('会员中心真实示例 utils/member-sample（O-22）', () => {
  /** 缓存行：同时带 id（db 适配层出参）与 _id（落库主键），纯函数与种子两用 */
  const cacheRow = (id, report, generatedAt = '2026-10-06T10:00:00.000Z') => ({
    id, _id: id, state: 'ready', generated_at: generatedAt, report
  })
  const mkMemberReport = (over = {}) =>
    Object.assign(
      {
        name: '王小明',
        generatedAt: '2026-10-06T10:00:00.000Z',
        memberNotes: { compare: '对比视角正文', risk: '风险提示正文' }
      },
      over
    )
  const labels = (s) => s.blocks.map((b) => b.label)

  it('pickMemberSample：跳过没有专享段的报告，取第一份有内容的', () => {
    const { load } = fresh()
    const { pickMemberSample } = load('utils/member-sample')

    eq(pickMemberSample(null), null)
    eq(pickMemberSample([]), null)
    eq(pickMemberSample([cacheRow('a#tech', { name: 'A' })]), null, '只有正文没有专享段 → 不出示例')

    const s = pickMemberSample([
      cacheRow('a#tech', { name: 'A' }),
      cacheRow('b#tech', mkMemberReport({ name: 'B' }), '2026-10-05T10:00:00.000Z')
    ])
    eq(s.personKey, 'b#tech')
    eq(s.name, 'B')
    eq(s.generatedAt, '2026-10-05T10:00:00.000Z')
    deepEq(labels(s), ['对比视角', '风险提示'])
  })

  it('pickMemberSample：脏行一律跳过（缺主键 / 缺名字 / report 非对象）', () => {
    const { load } = fresh()
    const { pickMemberSample } = load('utils/member-sample')
    const good = cacheRow('ok#tech', mkMemberReport({ name: 'OK' }))

    eq(pickMemberSample([{ ...cacheRow('', mkMemberReport()) }]), null, '缺主键')
    eq(pickMemberSample([cacheRow('a#tech', mkMemberReport({ name: '   ' }))]), null, '名字空白')
    eq(pickMemberSample([cacheRow('a#tech', '不是对象')]), null)
    eq(pickMemberSample([null, undefined, 42]), null)
    /* 脏行在前、好行在后 → 仍要挑到好行 */
    eq(pickMemberSample([cacheRow('bad#tech', {}), good]).personKey, 'ok#tech')
  })

  it('信源分歧：只取第一条，两个口径并排；缺一边也能成段', () => {
    const { load } = fresh()
    const { pickMemberSample } = load('utils/member-sample')

    const s = pickMemberSample([
      cacheRow('a#tech', {
        name: 'A',
        conflicts: [
          { topic: '融资额', a: '称 3 亿', b: '称 1 亿' },
          { topic: '总部', a: '北京', b: '上海' }
        ]
      })
    ])
    deepEq(labels(s), ['信源分歧'], '只有分歧时也能成卡（老缓存只有 memberNotes，新的才有 conflicts）')
    ok(s.blocks[0].text.includes('融资额'), `实际：${s.blocks[0].text}`)
    ok(s.blocks[0].text.includes('一方：称 3 亿') && s.blocks[0].text.includes('另一方：称 1 亿'))
    notOk(s.blocks[0].text.includes('总部'), '只要第一条：这一段说的是「素材会对不上」，不是分歧条数')

    const oneSide = pickMemberSample([cacheRow('a#tech', { name: 'A', conflicts: [{ topic: 'T', a: '', b: '另一说' }] })])
    eq(oneSide.blocks[0].text, 'T · 另一方：另一说', '缺的那一边整段不出现（不摆空标签占位）')
  })

  it('节选：超长只截断，不摘要不润色（改一个字就不是真实示例）', () => {
    const { load } = fresh()
    const { pickMemberSample, SAMPLE_CLAMP, clampSample } = load('utils/member-sample')

    eq(clampSample('  空格也要剪掉  '), '空格也要剪掉')
    const long = '甲'.repeat(SAMPLE_CLAMP + 25)
    const s = pickMemberSample([cacheRow('a#tech', mkMemberReport({ memberNotes: { compare: long, risk: '' } }))])
    eq(s.blocks[0].text.length, SAMPLE_CLAMP + 1)
    eq(s.blocks[0].text, `${'甲'.repeat(SAMPLE_CLAMP)}…`)
    ok(long.startsWith(s.blocks[0].text.slice(0, -1)), '节选必须是原文前缀（不是摘要）')
  })

  it('loadMemberSample：只读 state=ready 的报告（半成品不算示例）', async () => {
    const { db, load } = fresh()
    const { loadMemberSample } = load('utils/member-sample')

    /* inbox/building 里的半成品从未被任何人看过，不能拿来当示例 */
    db.__seed('report_cache', [
      Object.assign(cacheRow('building#tech', mkMemberReport({ name: '在建' })), { state: 'building' })
    ])
    eq(await loadMemberSample(), null)
  })

  it('loadMemberSample：就绪报告 → 带来源信息（报告名 + 生成时间）', async () => {
    const { db, load } = fresh()
    const { loadMemberSample } = load('utils/member-sample')
    db.__seed('report_cache', [cacheRow('ready#tech', mkMemberReport({ name: '就绪' }))])

    const s = await loadMemberSample()
    eq(s.name, '就绪')
    eq(s.personKey, 'ready#tech')
    eq(s.generatedAt, '2026-10-06T10:00:00.000Z', '来源行要靠它写「3 天前生成」')
  })

  it('loadMemberSample：TTL 内复用内存结果（每次进页不再打库）', async () => {
    const { db, load } = fresh()
    const { loadMemberSample } = load('utils/member-sample')
    db.__seed('report_cache', [cacheRow('ready#tech', mkMemberReport())])

    await loadMemberSample()
    const calls = db.stats.getCalls
    ok(calls > 0, '第一次应真的读库')
    await loadMemberSample()
    eq(db.stats.getCalls, calls, '第二次应命中内存缓存')
  })

  it('loadMemberSample：读库失败返回 null（不抛错，示例卡整块不出）', async () => {
    const { db, load } = fresh()
    const { loadMemberSample } = load('utils/member-sample')
    db.__setFailing('report_cache', true)
    eq(await loadMemberSample(), null, '失败也不该 reject：示例卡缺了不影响会员中心任何功能')
  })
})

/* ---------------------------------------------------- 生成配额 utils/quota */

describe('生成配额 utils/quota', () => {
  /** 造一行当日已用量；date 默认今天 */
  const seedCount = (db, userId, count, date = todayKey()) =>
    db.__seed('generate_quota', [{ _id: `${userId}#${date}`, openid: userId, count }])

  it('peek：免费版上限 3，remaining = 上限 - 已用', async () => {
    const { db, load } = fresh()
    seedCount(db, 'u1', 2)
    const peek = await load('utils/quota').peekGenerateQuota('u1')

    eq(peek.limit, 3)
    eq(peek.used, 2)
    eq(peek.remaining, 1)
    eq(peek.allowed, true)
    eq(peek.member, false)
    eq(peek.expiresAt, null)
    eq(peek.daysLeft, -1)
  })

  it('peek：用满后 allowed=false，remaining 不为负', async () => {
    const { db, load } = fresh()
    seedCount(db, 'u1', 5, todayKey())
    const peek = await load('utils/quota').peekGenerateQuota('u1')
    eq(peek.remaining, 0)
    eq(peek.allowed, false)
  })

  it('peek：会员上限 30，且带出到期时间与剩余天数', async () => {
    const { db, load } = fresh()
    const expires = new Date(Date.now() + 1.5 * 864e5).toISOString()
    db.__seed('users', [{ _id: 'u1', _openid: 'me', membership: { plan: 'quarter', expires_at: expires } }])
    seedCount(db, 'me', 4)

    const peek = await load('utils/quota').peekGenerateQuota('me')
    eq(peek.limit, 30)
    eq(peek.member, true)
    eq(peek.expiresAt, expires)
    eq(peek.daysLeft, 2, '1.5 天应向上取整为 2 天')
    eq(peek.remaining, 26)
  })

  it('peek：会员已过期回落免费版上限（不按会员算额度）', async () => {
    const { db, load } = fresh()
    db.__seed('users', [{
      _id: 'u1', _openid: 'me',
      membership: { plan: 'month', expires_at: new Date(Date.now() - 1000).toISOString() }
    }])
    const peek = await load('utils/quota').peekGenerateQuota('me')
    eq(peek.member, false)
    eq(peek.limit, 3)
  })

  it('peek：配额表不可读时按「已用 0」保守处理，不误报用尽', async () => {
    const { db, load } = fresh()
    db.__setFailing('generate_quota', true)
    const peek = await load('utils/quota').peekGenerateQuota('u1')
    eq(peek.used, 0)
    eq(peek.limit, 3)
    eq(peek.allowed, true)
  })

  it('peek：昨日计数不计入今天（按日切分）', async () => {
    const { db, load } = fresh()
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
    seedCount(db, 'u1', 9, yesterday)
    const peek = await load('utils/quota').peekGenerateQuota('u1')
    eq(peek.used, 0)
    eq(peek.allowed, true)
  })

  it('consume：云端成功时以云端为准，不在本机落计数行', async () => {
    const { db, load } = fresh()
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count: 1 }))
    await load('utils/quota').consumeGenerateQuota('u1')
    eq(db.__dump('generate_quota').length, 0, '云端已计数，端上不应再写一行')
  })

  it('consume：云端不可用时回退本机读-改-写（0 → insert）', async () => {
    const { db, load } = fresh()
    await load('utils/quota').consumeGenerateQuota('u1')
    const rows = db.__dump('generate_quota')
    eq(rows.length, 1)
    eq(rows[0]._id, `u1#${todayKey()}`, '主键口径应为 openid#日期')
    eq(rows[0].count, 1)
  })

  it('consume：回退路径连续调用走 update 递增，而不是插第二行', async () => {
    const { db, load } = fresh()
    const { consumeGenerateQuota } = load('utils/quota')
    await consumeGenerateQuota('u1')
    await consumeGenerateQuota('u1')
    await consumeGenerateQuota('u1')
    const rows = db.__dump('generate_quota')
    eq(rows.length, 1, '同一天仍是一行')
    eq(rows[0].count, 3)
  })

  it('consume：回退路径与 peek 口径闭环（用满后被拦）', async () => {
    const { db, load } = fresh()
    const q = load('utils/quota')
    for (let i = 0; i < 3; i++) await q.consumeGenerateQuota('u1')
    eq((await q.peekGenerateQuota('u1')).allowed, false)
  })

  it('consume：本机计数行写入失败也不会抛给调用方（报告已生成不能被回滚）', async () => {
    const { db, load } = fresh()
    db.__setFailing('generate_quota', true)
    let threw = false
    try {
      await load('utils/quota').consumeGenerateQuota('u1')
    } catch {
      threw = true
    }
    notOk(threw, 'consume 是 best-effort，不应抛异常')
  })

  it('consume：云端报错时回退本机计数，额度不会形同虚设', async () => {
    const { db, load } = fresh()
    env.registerCloudFn('quotaGuard', () => { throw new Error('function down') })
    await load('utils/quota').consumeGenerateQuota('u1')
    eq(db.__dump('generate_quota')[0].count, 1)
  })
})

/* --------------------------------------------- 问答闸门与计数 utils/qa */

describe('问答闸门与计数 utils/qa', () => {
  /** 造一行云端当日提问计数 */
  const seedServer = (db, userId, count) =>
    db.__seed('ask_quota', [{ _id: `${userId}#${todayKey()}`, openid: userId, count }])

  /** 把本机镜像设成指定次数 */
  const setMirror = (count, date = todayKey()) => env.storage.set(USAGE_KEY, { date, count })

  it('连点间隔内直接拦下，且完全不发网络请求', async () => {
    const { db, load } = fresh()
    login('u1')
    env.storage.set(LAST_KEY, Date.now())
    const before = db.stats.getCalls

    const gate = await load('utils/qa').checkQaGate(false)
    eq(gate.allowed, false)
    ok(/提问太快了/.test(gate.message), `实际：${gate.message}`)
    eq(db.stats.getCalls, before, '防误触属本机判定，不该产生云读')
  })

  it('间隔已过（>3s）时不再拦连点', async () => {
    const { load } = fresh()
    login('u1')
    env.storage.set(LAST_KEY, Date.now() - 5000)
    eq((await load('utils/qa').checkQaGate(false)).allowed, true)
  })

  it('免费额度用尽时拦下，文案带免费版与升级引导', async () => {
    const { db, load } = fresh()
    login('u1')
    seedServer(db, 'u1', 5)
    const gate = await load('utils/qa').checkQaGate(false)
    eq(gate.allowed, false)
    ok(gate.message.includes('免费版'), `实际：${gate.message}`)
    ok(gate.message.includes('开通会员'), `实际：${gate.message}`)
  })

  it('未满额度放行，message 为空串', async () => {
    const { db, load } = fresh()
    login('u1')
    seedServer(db, 'u1', 4)
    deepEq(await load('utils/qa').checkQaGate(false), { allowed: true, message: '' })
  })

  it('同一份计数下，会员（上限 30）仍可继续问', async () => {
    const { db, load } = fresh()
    login('u1')
    seedServer(db, 'u1', 5)
    eq((await load('utils/qa').checkQaGate(false)).allowed, false, '免费版 5 次已满')
    eq((await load('utils/qa').checkQaGate(true)).allowed, true, '会员额度 30 仍有余额')
  })

  it('云端计数会被拉进本机镜像（读得到就以云端为准）', async () => {
    const { db, load } = fresh()
    login('u1')
    seedServer(db, 'u1', 3)
    await load('utils/qa').checkQaGate(false)
    deepEq(env.storage.get(USAGE_KEY), { date: todayKey(), count: 3 })
  })

  it('镜像不会被云端的较小值覆盖（只抬高，避免误放开额度）', async () => {
    const { db, load } = fresh()
    login('u1')
    seedServer(db, 'u1', 2)
    setMirror(5)
    await load('utils/qa').refreshQaUsage()
    eq(env.storage.get(USAGE_KEY).count, 5, '镜像更高时应保留')
  })

  it('云端读不到但镜像已用满时仍拦下（回退不改判定方向）', async () => {
    const { db, load } = fresh()
    login('u1')
    db.__setFailing('ask_quota', true)
    setMirror(5)
    eq((await load('utils/qa').checkQaGate(false)).allowed, false)
  })

  it('未登录时走本机镜像判定（云端无身份可读）', async () => {
    const { load } = fresh()
    load('stores/auth')
    setMirror(2)
    eq((await load('utils/qa').checkQaGate(false)).allowed, true)
    setMirror(5)
    eq((await load('utils/qa').checkQaGate(false)).allowed, false)
  })

  it('跨日后镜像归零（昨日已用不计入今天）', async () => {
    const { load } = fresh()
    login('u1')
    setMirror(5, dayjs().subtract(1, 'day').format('YYYY-MM-DD'))
    eq((await load('utils/qa').checkQaGate(false)).allowed, true)
  })

  it('noteQaUsed：云端成功时镜像对齐云端计数', async () => {
    const { load } = fresh()
    login('u1')
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count: 4 }))
    await load('utils/qa').noteQaUsed()
    eq(env.storage.get(USAGE_KEY).count, 4)
    ok(env.storage.get(LAST_KEY) > 0, '应记录连点时间')
  })

  it('noteQaUsed：云端不可用时镜像 +1（这次消费不会漏记）', async () => {
    const { load } = fresh()
    login('u1')
    setMirror(2)
    await load('utils/qa').noteQaUsed()
    eq(env.storage.get(USAGE_KEY).count, 3)
  })

  it('noteQaUsed：云端计数偏小时也抬高到云端值，绝不回落', async () => {
    const { load } = fresh()
    login('u1')
    setMirror(5)
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count: 2 }))
    await load('utils/qa').noteQaUsed()
    eq(env.storage.get(USAGE_KEY).count, 5)
  })

  it('refreshQaUsage：未登录 / 表不可用时保留原镜像', async () => {
    const { db, load } = fresh()
    const { refreshQaUsage } = load('utils/qa')
    load('stores/auth')
    setMirror(3)
    await refreshQaUsage()
    eq(env.storage.get(USAGE_KEY).count, 3, '未登录不应对齐')

    login('u1')
    db.__setFailing('ask_quota', true)
    await refreshQaUsage()
    eq(env.storage.get(USAGE_KEY).count, 3, '读失败应保留镜像')
  })

  it('clearQaUsage 只清本机镜像与连点时间', () => {
    const { load } = fresh()
    setMirror(4)
    env.storage.set(LAST_KEY, 123)
    load('utils/qa').clearQaUsage()
    notOk(env.storage.has(USAGE_KEY), '应移除本机镜像')
    notOk(env.storage.has(LAST_KEY), '应移除连点时间')
    eq(load('utils/qa').qaUsageToday(false).remaining, 5, '清空后应回到满额展示')
  })

  /*
   * 用量展示口径（qaUsageOf / qaUsageToday）。
   * 这组用例钉住的是「数字必须真实」—— 此前它报满额，界面上的提问次数永远停在 0，
   * 看起来就是「AI 提问没有计数」（见 utils/qa.ts 上方的取舍说明）。
   */
  it('qaUsageToday 按会员档位与镜像同步展示，不为负', () => {
    const { load } = fresh()
    const { qaUsageToday } = load('utils/qa')
    deepEq(qaUsageToday(false), { used: 0, limit: 5, remaining: 5, unlimited: false })
    setMirror(3)
    deepEq(qaUsageToday(false), { used: 3, limit: 5, remaining: 2, unlimited: false })
    deepEq(qaUsageToday(true), { used: 3, limit: 30, remaining: 27, unlimited: false })
    setMirror(99)
    const over = qaUsageToday(false)
    eq(over.used, 99, '用超了也要报出真实次数，不能截到上限')
    eq(over.remaining, 0, '但「还可问」不能显示负数')
  })

  it('qaUsageOf 纯函数：脏输入归零，不把 NaN / 负数带进界面', () => {
    const { load } = fresh()
    const { qaUsageOf } = load('utils/qa')
    eq(qaUsageOf(-3, false).used, 0, '负数应归零')
    eq(qaUsageOf(NaN, false).used, 0, 'NaN 应归零')
    eq(qaUsageOf(2.7, false).used, 2, '次数应是整数')
    eq(qaUsageOf(0, true).limit, 30, '上限取会员档')
  })

  /*
   * 调试开关（utils/debug.ts 的 ASK_QUOTA_DISABLED）。
   * 本文件其余用例一律跑 ALL_OFF 口径，只有这一组显式打开它 —— 开挂是「本地想看就看」的
   * 能力，必须有用例钉住「打开后到底松到哪一步、哪一步没松」，否则它很容易被顺手改成
   * 连计数一起抹掉，那时线上排查就再也看不到真实用量。
   */
  it('调试开关：放开提问额度后一律放行，但计数照旧同步、用量照实报', async () => {
    const { db, load } = fresh({ disableAskQuota: true })
    login('u1')
    const qa = load('utils/qa')
    eq(load('utils/debug').ASK_QUOTA_DISABLED, true, '前提：本用例应把开关打开')

    /* 免费额度已满（5/5）仍放行，且不再抛升级文案（没有需要升级的东西） */
    seedServer(db, 'u1', 5)
    deepEq(await qa.checkQaGate(false), { allowed: true, message: '' })

    /* 远超上限也放行：开关是「不拦」，不是「多给几次」 */
    seedServer(db, 'u1', 999)
    eq((await qa.checkQaGate(false)).allowed, true)

    /*
     * 用量**照实报**（本轮修正）：此前这里报满额，界面上的数字永远不动，
     * 表现为「AI 提问好像没有计数」。开挂松的是闸门，不是计数 —— 已用 999 就报 999。
     * remaining 仍照实相减为 0，但它此时不代表「不能再问」，拦不拦由 unlimited 决定。
     */
    deepEq(qa.qaUsageToday(false), { used: 999, limit: 5, remaining: 0, unlimited: true })
    eq(qa.qaUsageToday(true).unlimited, true, '会员档同样标记为开挂')

    /* 计数这条腿**不**跟着开关一起松掉：同步照旧（排查时最需要的证据就是真实用量） */
    setMirror(4)
    await qa.checkQaGate(false)
    eq(env.storage.get(USAGE_KEY).count, 999, '云端计数仍应被拉进镜像')
    eq(qa.qaUsageToday(false).used, 999, '镜像被拉高后，展示口径应跟着走')
  })

  it('调试开关：连点间隔不受影响（它防的是误触重复计费，与次数限制无关）', async () => {
    const { load } = fresh({ disableAskQuota: true })
    login('u1')
    env.storage.set(LAST_KEY, Date.now())
    const gate = await load('utils/qa').checkQaGate(false)
    eq(gate.allowed, false, '开关管的是每日次数，3 秒防连点仍应在')
    ok(/提问太快了/.test(gate.message), `实际：${gate.message}`)
  })
})

/* ------------------------------------------------------- 问答语料 utils/qa */

describe('问答语料 buildPassages / selectPassages', () => {
  const fullReport = () => mkReport({
    intro: '简介正文',
    dynamics: [dyn({ title: 'T1', summary: 'S1', date: '2026-01-01', source: '媒体A' })],
    quotes: [{ text: '名言', context: '发布会', source: '媒体B' }],
    timeline: [{ date: '2020-01-01', event: '入职' }],
    coverage: {
      items: 12, recent: 3,
      firstAt: '2020-01-01T00:00:00.000Z', latestAt: '2026-01-01T00:00:00.000Z'
    },
    stance: [{ topic: 'AI', attitude: 'positive', note: '看好' }],
    analysis: '点评正文'
  })

  it('片段顺序即可信度顺序，且编号从 1 连续', () => {
    const { load } = fresh()
    const ps = load('utils/qa').buildPassages(fullReport())
    deepEq(
      ps.map((p) => p.kind),
      ['intro', 'dynamic', 'quote', 'timeline', 'coverage', 'stance', 'analysis']
    )
    deepEq(ps.map((p) => p.no), [1, 2, 3, 4, 5, 6, 7])
    deepEq(ps.filter((p) => p.ai).map((p) => p.kind), ['stance', 'analysis'], '判定类须标成 AI 判定')
  })

  it('空报告摊出空语料，hasQaCorpus 为 false', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    deepEq(qa.buildPassages(mkReport()), [])
    eq(qa.hasQaCorpus(mkReport()), false)
    eq(qa.hasQaCorpus(fullReport()), true)
  })

  it('动态只有标题或只有摘要都能成片段，且不会拼出多余的冒号', () => {
    const { load } = fresh()
    const ps = load('utils/qa').buildPassages(mkReport({
      dynamics: [dyn({ title: '只有标题' }), dyn({ summary: '只有摘要' }), dyn()]
    }))
    eq(ps.length, 2, '两个字段都空的动态应被丢弃')
    eq(ps[0].text, '只有标题')
    eq(ps[1].text, '只有摘要')
    notOk(ps[0].text.includes('：'), '缺一段时不应留下孤立的冒号')
  })

  it('语录只有出处时也能成片段（不渲染空引号）', () => {
    const { load } = fresh()
    const ps = load('utils/qa').buildPassages(mkReport({
      quotes: [{ context: '某次采访', source: '媒体C' }]
    }))
    eq(ps.length, 1)
    eq(ps[0].text, '某次采访')
    notOk(ps[0].text.includes('「」'), '没有原文时不应出现空引号')
  })

  it('素材统计与话题态度按约定文案摊开', () => {
    const { load } = fresh()
    const ps = load('utils/qa').buildPassages(fullReport())
    const coverage = ps.find((p) => p.kind === 'coverage')
    eq(coverage.text, '本次检索共收录 12 条素材，其中最近 7 天 3 条；素材时间范围 2020-01-01 ~ 2026-01-01')
    eq(ps.find((p) => p.kind === 'stance').text, '关于「AI」，媒体报道倾向为偏正面 · 看好')
  })

  it('语料放得下时全量返回，不做筛选', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const ps = qa.buildPassages(fullReport())
    const picked = qa.selectPassages(ps, '随便问点什么')
    deepEq(picked, ps, '未超预算应原样返回')
  })

  /** 造一份必然超预算的语料：60 条动态，每条 ~300 字 */
  const bigPassages = (qa) => qa.buildPassages(mkReport({
    dynamics: Array.from({ length: 60 }, (_, i) =>
      dyn({ title: `动态${i}`, summary: `内容${i}` + '填充'.repeat(150), date: `2026-01-${(i % 28) + 1}` })
    )
  }))

  it('语料超预算时裁剪，但编号重排后仍从 1 连续', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const all = bigPassages(qa)
    const picked = qa.selectPassages(all, '动态是什么')

    ok(picked.length < all.length, `应发生裁剪，实际 ${picked.length}/${all.length}`)
    ok(picked.length > 0, '至少应留下一些片段')
    deepEq(picked.map((p) => p.no), picked.map((_, i) => i + 1), '编号必须连续')
    const total = picked.reduce((n, p) => n + `[${p.no}]${p.text}${p.source}${p.date}`.length, 0)
    ok(total <= 12000 + 500, `总量应贴近预算，实际约 ${total}`)
  })

  it('裁剪后仍保留至少 6 条最近的动态（不让时间线被挤光）', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const picked = qa.selectPassages(bigPassages(qa), '无关问题')
    ok(
      picked.filter((p) => p.kind === 'dynamic').length >= 6,
      `动态条数应 ≥ 6，实际 ${picked.filter((p) => p.kind === 'dynamic').length}`
    )
  })

  it('问题命中片段时该片段必入选（相关度影响裁剪结果）', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const all = qa.buildPassages(mkReport({
      dynamics: Array.from({ length: 60 }, (_, i) =>
        dyn({ title: `动态${i}`, summary: '填充'.repeat(150), date: '2026-01-01' })
      ).concat([dyn({ title: '独家专访', summary: '关于「星际旅行」的完整回应', date: '2026-02-02' })])
    }))

    const picked = qa.selectPassages(all, '星际旅行')
    ok(picked.some((p) => p.text.includes('星际旅行')), '与问题相关的片段必须入选')
  })

  it('建议问题只给报告里确实存在的内容，按段落生成、上限 8 条', () => {
    const { load } = fresh()
    const { suggestQuestions } = load('utils/qa')
    eq(suggestQuestions(mkReport()).length, 0)

    const full = suggestQuestions(fullReport())
    ok(full.length <= 8, `上限 8 条（面板分批轮转展示），实际 ${full.length}`)
    ok(full.some((q) => q.includes('动态')), '有动态就应有动态提问')
    ok(full.every((q) => typeof q === 'string' && q.length > 0))
    /* 前三条顺序刻意与改版前一致：动态 → 观点 → 话题（观感不变，多出来的是更针对这份报告的问题） */
    eq(full[0], 'TA 最近有什么动态？')
    ok(full[1].includes('公开说过'), `第二条应是观点提问，实际：${full[1]}`)
    /* 高热度但无素材时只出一条「为什么受关注」，不凭热度编造结论性提问 */
    deepEq(suggestQuestions(mkReport({ heat: 90 })), ['TA 最近为什么这么受关注？'])

    const onlyTimeline = suggestQuestions(mkReport({ timeline: [{ date: 'x', event: 'y' }] }))
    deepEq(onlyTimeline, ['TA 的经历时间线是怎样的？'])
  })
})

/* ------------------------------------- 对比问答 O-18（多人语料 / 公平性） */

describe('对比问答 O-18（多人语料 / 公平性下限 / 建议问题）', () => {
  const pair = (overA = {}, overB = {}) => [
    mkReport(Object.assign({ personKey: '甲#tech', name: '甲' }, overA)),
    mkReport(Object.assign({ personKey: '乙#ent', name: '乙' }, overB))
  ]

  /** 与 renderPassage 同构的长度（预算断言用；renderPassage 未导出） */
  const rlen = (p) =>
    `[${p.no}]（${[p.who, p.ai ? 'AI 判定' : '公开报道', p.date, p.source].filter(Boolean).join(' · ')}）${p.text}`
      .length
  const countWho = (list, who) => list.filter((p) => p.who === who).length

  it('单份入参直接走 buildPassages：多人路径不渗回原调用方', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const one = mkReport({ intro: '简介', dynamics: [dyn({ title: 'T1' })] })
    deepEq(qa.buildMultiPassages([one]), qa.buildPassages(one))
    ok(qa.buildMultiPassages([one]).every((p) => p.who === undefined), '单份不该给每条标「谁」')
    deepEq(qa.buildMultiPassages([]), [], '空入参摊出空语料')
  })

  it('多份语料统一编号、逐条标出属于谁、各自按可信度顺序摊开', () => {
    const { load } = fresh()
    const [a, b] = pair(
      { intro: '甲简介', dynamics: [dyn({ title: '甲事件' })] },
      { intro: '乙简介', dynamics: [dyn({ title: '乙事件' })] }
    )
    const ps = load('utils/qa').buildMultiPassages([a, b])
    deepEq(ps.map((p) => p.no), ps.map((_, i) => i + 1), '编号必须从 1 连续（prompt 里的 [n] 靠它）')
    deepEq(ps.map((p) => p.who), ['甲', '甲', '乙', '乙'])
    deepEq(ps.map((p) => p.kind), ['intro', 'dynamic', 'intro', 'dynamic'], '两人各自内部仍是可信度顺序')
  })

  it('绝不合并去重：两人说同一句话也是两条独立事实', () => {
    const { load } = fresh()
    const [a, b] = pair(
      { quotes: [{ text: '同一句话', context: '采访' }] },
      { quotes: [{ text: '同一句话', context: '采访' }] }
    )
    const ps = load('utils/qa').buildMultiPassages([a, b])
    eq(ps.length, 2, '一字不差的语录也不能合并（合并会被模型当成共识）')
    deepEq(ps.map((p) => p.who), ['甲', '乙'])
  })

  it('hasQaCorpusMany 用 some：只要有一位有素材就该给输入框', () => {
    const { load } = fresh()
    const { hasQaCorpusMany } = load('utils/qa')
    eq(hasQaCorpusMany(pair({ intro: '有' })), true, '一位有素材就该开问答（另一位由第 8 条约束说明）')
    eq(hasQaCorpusMany(pair()), false, '两位都没素材才关闭')
    eq(hasQaCorpusMany([]), false)
  })

  /**
   * 造一份「一位必然占满预算」的语料：甲 65 条 ~190 字的大片段 + 乙 3 条 ~240 字。
   * 这是下限唯一要解决的场景 —— 实测此时乙的片段会被贪心装填完全挤出（0 条）。
   */
  const starved = (qa) =>
    qa.buildMultiPassages([
      mkReport({
        name: '甲',
        dynamics: Array.from({ length: 65 }, (_, i) =>
          dyn({ title: `甲事件${i}`, summary: '填'.repeat(150), date: '2026-01-01', source: '媒体甲' })
        )
      }),
      mkReport({
        name: '乙',
        dynamics: Array.from({ length: 3 }, (_, i) =>
          dyn({ title: `乙事${i}`, summary: '简'.repeat(200), date: '2026-02-02', source: '媒体乙' })
        )
      })
    ])

  it('公平性下限：一位被挤出预算时必须被补进，否则对比问答只剩一个人的资料', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const all = starved(qa)

    const without = qa.selectPassages(all, '甲事件')
    ok(without.length < all.length, '前提：语料超预算并发生裁剪')
    eq(countWho(without, '乙'), 0, '前提：无下限时乙会被完全挤出（贪心装填到塞不下为止）')

    const withFair = qa.selectPassages(all, '甲事件', { minPerWho: 2 })
    eq(countWho(withFair, '乙'), 2, '下限要求每位至少 2 条')
    ok(countWho(withFair, '甲') >= 30, `不该为了公平把甲几乎清空，实际 ${countWho(withFair, '甲')}`)
  })

  it('公平性下限的代价只落在尾部：靠前的可信片段一条都不能少', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const all = starved(qa)
    const withFair = qa.selectPassages(all, '甲事件', { minPerWho: 2 })
    const got = new Set(withFair.map((p) => p.text))

    const head = all.filter((p) => p.who === '甲').slice(0, 10).map((p) => p.text)
    for (const t of head) ok(got.has(t), `靠前的可信片段不应被牺牲：${t.slice(0, 12)}`)
  })

  it('公平性下限不越预算，且补位后编号仍连续', () => {
    const { load } = fresh()
    const picked = load('utils/qa').selectPassages(starved(load('utils/qa')), '甲事件', { minPerWho: 2 })
    deepEq(picked.map((p) => p.no), picked.map((_, i) => i + 1), '编号必须连续（否则回答里的 [n] 会指错）')
    const total = picked.reduce((n, p) => n + rlen(p), 0)
    ok(total <= 12000, `补位后不应超预算，实际 ${total}`)
  })

  it('单份报告传 minPerWho 也与不传一致（语料里没有 who，下限整段空转）', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const ps = qa.buildPassages(mkReport({
      dynamics: Array.from({ length: 60 }, (_, i) => dyn({ title: `动态${i}`, summary: '填'.repeat(200) }))
    }))
    ok(qa.selectPassages(ps, '动态').length < ps.length, '前提：该语料确实超预算')
    deepEq(qa.selectPassages(ps, '动态', { minPerWho: 2 }), qa.selectPassages(ps, '动态'))
  })

  it('建议问题：同一人回落单份建议，共同话题才出对比问，上限 4 条且不预设结论', () => {
    const { load } = fresh()
    const qa = load('utils/qa')
    const { suggestCompareQuestions } = qa

    const a = mkReport({
      personKey: '甲#tech',
      name: '甲',
      stance: [{ topic: 'AI', attitude: 'positive' }],
      dynamics: [dyn({ title: 'x' })]
    })
    const b = mkReport({
      personKey: '乙#ent',
      name: '乙',
      stance: [{ topic: 'AI', attitude: 'neutral' }],
      dynamics: [dyn({ title: 'y' })]
    })
    const out = suggestCompareQuestions(a, b)
    ok(out.length <= 4, `上限 4 条，实际 ${out.length}`)
    ok(out[0].includes('AI'), `有共同话题时应先问对比，实际：${out[0]}`)
    ok(out.some((q) => q.includes('甲')) && out.some((q) => q.includes('乙')), '应给两位各一条兜底提问')
    notOk(out.some((q) => /谁更|谁最|更成功|更优秀/.test(q)), '不得写预设结论的提问（会引导模型下判断）')

    /* 同一人：退化成单份建议的前 4 条，而不是问「两人的异同」 */
    const same = mkReport({
      personKey: '甲#tech',
      name: '甲',
      dynamics: [dyn({ title: 'x' })],
      quotes: [{ text: 'q' }]
    })
    deepEq(suggestCompareQuestions(same, same), qa.suggestQuestions(same).slice(0, 4))

    /* 无共同话题也不该一条都点不出来 */
    const c = mkReport({ personKey: '丙#sport', name: '丙', dynamics: [dyn({ title: 'z' })] })
    const d = mkReport({ personKey: '丁#sport', name: '丁', dynamics: [dyn({ title: 'w' })] })
    const noShared = suggestCompareQuestions(c, d)
    ok(noShared.includes('最近这段时间，谁被报道得更多？'), `实际：${JSON.stringify(noShared)}`)
    ok(noShared.some((q) => q.startsWith('丙 ')) && noShared.some((q) => q.startsWith('丁 ')))
  })

  it('提问流程：两人时追加第 8 条约束，埋点记下双方', async () => {
    const { db, load } = fresh()
    login('u1')
    let seen = null
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'pass' }))
    env.registerCloudFn('aiProxy', (data) => {
      seen = data
      return { ok: true, content: '回答[1]' }
    })

    const [a, b] = pair({ intro: '甲简介' }, { intro: '乙简介' })
    const res = await load('utils/qa').askReports([a, b], '他们有什么不同？')
    eq(res.ok, true)

    ok(seen.messages[0].content.includes('多位名人'), 'system 必须追加「别把两人搞混」那条')
    ok(
      seen.messages[0].content.includes('不得把一人的事实安到另一人身上'),
      '第 8 条须含防串人约束（对比语境下的错认极难被用户察觉）'
    )
    ok(seen.messages[1].content.includes('甲 × 乙'), `user 提示应写明参与的名人，实际：${seen.messages[1].content.slice(0, 40)}`)
    ok(seen.messages[1].content.includes('（甲 · 公开报道'), '多条资料须逐条标出属于谁')

    await new Promise((r) => setTimeout(r, 0))
    const ev = db.__dump('events').find((e) => e.event === 'report_qa_ask')
    eq(ev.person_key, '甲#tech+乙#ent', '一次提问两份资料，埋点须记下双方')
    eq(ev.props.multi, true)
  })

  it('提问流程：单份时 system 仍是原来那 7 条（不带多人约束）', async () => {
    const { load } = fresh()
    login('u1')
    let seen = null
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'pass' }))
    env.registerCloudFn('aiProxy', (data) => {
      seen = data
      return { ok: true, content: '回答' }
    })

    const res = await load('utils/qa').askReports([mkReport({ intro: '简介' })], '有什么动态？')
    eq(res.ok, true)
    notOk(seen.messages[0].content.includes('多位名人'), '单份不该带第 8 条')
    ok(seen.messages[0].content.includes('硬性约束'), '单份仍是原来那 7 条')
  })
})

/* -------------------------------------------------- 内容安全 utils/sec-check */

describe('内容安全检查 utils/sec-check', () => {
  it('空白文本直接 pass，不打上游（清空备注是正常操作）', async () => {
    const { load } = fresh()
    let called = false
    env.registerCloudFn('contentCheck', () => { called = true; return { ok: true, suggest: 'risky' } })
    eq(await load('utils/sec-check').checkUserText('   \n '), 'pass')
    notOk(called, '空文本不应触发云调用')
  })

  it('未部署时 fail-open 返回 pass（不因服务端没配好就拦住用户）', async () => {
    const { load } = fresh()
    eq(await load('utils/sec-check').checkUserText('正常文本'), 'pass')
  })

  it('上游返回 risky / review 原样转出（命中违规 fail-closed）', async () => {
    const { load } = fresh()
    const { checkUserText } = load('utils/sec-check')
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'risky' }))
    eq(await checkUserText('违规文本'), 'risky')
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'review' }))
    eq(await checkUserText('可疑文本'), 'review')
  })

  it('认不出的取值一律按 pass（解析问题不误伤用户）', async () => {
    const { load } = fresh()
    const { checkUserText } = load('utils/sec-check')
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: '未知取值' }))
    eq(await checkUserText('文本'), 'pass')
    env.registerCloudFn('contentCheck', () => ({ ok: true }))
    eq(await checkUserText('文本'), 'pass')
  })

  it('云函数返回失败 / 抛错都返回 pass 且不 reject', async () => {
    const { load } = fresh()
    const { checkUserText } = load('utils/sec-check')
    env.registerCloudFn('contentCheck', () => ({ ok: false, error: '内部错误' }))
    eq(await checkUserText('文本'), 'pass')
    env.registerCloudFn('contentCheck', () => { throw new Error('boom') })
    eq(await checkUserText('文本'), 'pass')
  })

  it('送检参数按约定：action=check 且带上原文（trim 后）', async () => {
    const { load } = fresh()
    let seen = null
    env.registerCloudFn('contentCheck', (data) => { seen = data; return { ok: true, suggest: 'pass' } })
    await load('utils/sec-check').checkUserText('  内容  ')
    eq(seen.action, 'check')
    eq(seen.content, '内容')
  })
})

/* --------------------------------------------------- 提问流程 askReport */

describe('提问流程 utils/qa#askReport', () => {
  const report = () => mkReport({
    dynamics: [dyn({ title: '动态标题', summary: '动态摘要', date: '2026-01-01', source: '媒体A' })],
    intro: '简介'
  })

  /** 装上「机审放行 + 模型成功」的两条云函数 */
  const online = (content = '这是回答') => {
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'pass' }))
    env.registerCloudFn('aiProxy', () => ({ ok: true, content, model: 'deepseek-v4-flash' }))
  }

  const mirrorCount = () => (env.storage.get(USAGE_KEY) || {}).count || 0

  it('空问题直接拒绝，不消耗额度', async () => {
    const { load } = fresh()
    login('u1')
    const res = await load('utils/qa').askReport(report(), '   ')
    eq(res.ok, false)
    ok(res.error.includes('请输入问题'), `实际：${res.error}`)
    eq(mirrorCount(), 0)
  })

  it('超过 120 字的问题被拦下', async () => {
    const { load } = fresh()
    login('u1')
    const { askReport, QA_MAX_QUESTION } = load('utils/qa')
    eq(QA_MAX_QUESTION, 120)
    const res = await askReport(report(), '问'.repeat(121))
    eq(res.ok, false)
    ok(res.error.includes('过长'), `实际：${res.error}`)
    eq(mirrorCount(), 0)
  })

  it('机审命中违规时拦截，且不发生任何计数', async () => {
    const { load } = fresh()
    login('u1')
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'risky' }))
    let modelCalled = false
    env.registerCloudFn('aiProxy', () => { modelCalled = true; return { ok: true, content: 'x' } })

    const res = await load('utils/qa').askReport(report(), '违规问题')
    eq(res.ok, false)
    ok(res.error.includes('不合规'), `实际：${res.error}`)
    notOk(modelCalled, '机审未过不应再调模型（白花钱）')
    eq(mirrorCount(), 0, '被拦下的提问不计费')
  })

  it('报告没有素材时给出可照做的提示', async () => {
    const { load } = fresh()
    login('u1')
    online()
    const res = await load('utils/qa').askReport(mkReport(), '有什么动态？')
    eq(res.ok, false)
    ok(res.error.includes('素材'), `实际：${res.error}`)
    eq(mirrorCount(), 0)
  })

  it('成功拿到回答才计数，并写入埋点', async () => {
    const { db, load } = fresh()
    login('u1')
    online('TA 最近的动态是……')

    const res = await load('utils/qa').askReport(report(), 'TA 最近有什么动态？')
    eq(res.ok, true)
    eq(res.text, 'TA 最近的动态是……')
    eq(mirrorCount(), 1, '成功提问应 +1')
    ok(env.storage.get(LAST_KEY) > 0, '应记连点时间')

    await new Promise((r) => setTimeout(r, 0))
    const ev = db.__dump('events').find((e) => e.event === 'report_qa_ask')
    ok(ev, '应有 report_qa_ask 埋点')
    eq(ev.person_key, report().personKey)
    ok(ev.props.passages >= 1, '埋点应记录带入的片段数')
  })

  it('模型失败时不计数（用户没拿到回答）', async () => {
    const { load } = fresh()
    login('u1')
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'pass' }))
    env.registerCloudFn('aiProxy', () => ({ ok: false, kind: 'upstream', error: '上游 5xx' }))

    const res = await load('utils/qa').askReport(report(), '问题')
    eq(res.ok, false)
    ok(res.error.length > 0)
    eq(mirrorCount(), 0, '失败分支不得计数')
  })

  it('云端计数可用时以云端为准（端上改不动次数）', async () => {
    const { load } = fresh()
    login('u1')
    online()
    env.registerCloudFn('quotaGuard', () => ({ ok: true, count: 3 }))

    const res = await load('utils/qa').askReport(report(), '问题')
    eq(res.ok, true)
    eq(mirrorCount(), 3, '应以云端返回的当日计数对齐镜像')
  })

  it('问答不消耗生成额度（只读缓存报告）', async () => {
    const { db, load } = fresh()
    login('u1')
    online()
    await load('utils/qa').askReport(report(), '问题')
    eq(db.__dump('generate_quota').length, 0, '提问不得写生成配额表')
  })

  /*
   * 联网补充（2026-10-08）：问答除了读报告，还会做一次实时检索。
   * 它是「加分的腿」，下面几条分别钉住：怎么进资料、怎么交代给模型、拿不到时怎么办、
   * 以及它多花了什么（一次检索调用 + 埋点里的条数）。
   */
  /** 博查原始条目（字段名与云函数回传一致：name / summary / siteName / datePublished） */
  const webItems = (n = 3) =>
    Array.from({ length: n }, (_, i) => ({
      name: `最新报道${i}`,
      summary: `联网正文${i}`,
      url: `https://example.com/web${i}`,
      siteName: `网媒${i}`,
      datePublished: '2026-10-08T09:00:00.000Z'
    }))

  /** 机审放行 + 检索回传 items + 模型成功；`box` 收集两次 aiProxy 的入参供断言 */
  const onlineWithSearch = (items, box) => {
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'pass' }))
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action === 'search') {
        box.search = data
        return { ok: true, pages: items }
      }
      box.chat = data
      return { ok: true, content: '回答[1]', model: 'deepseek-v4-flash' }
    })
  }

  it('联网补充：检索结果接在报告语料之后，标注「联网检索」并保留原文链接', async () => {
    const { db, load } = fresh()
    login('u1')
    const box = {}
    onlineWithSearch(webItems(3), box)

    const res = await load('utils/qa').askReport(report(), 'TA 最近有什么动态？')
    eq(res.ok, true)

    /* 检索式 = 名人 + 去掉指代词的问题：姓名不能省，TA 这种指代词对检索毫无信息量 */
    eq(box.search.query, '测试人物 最近有什么动态？')
    eq(box.search.freshness, 'oneWeek', '问的是「最近」，不该按 30 天取回一堆报告里已有的旧闻')
    eq(box.search.count, 8)

    /* 报告那两条编号与改造前一致（1 简介 / 2 动态），联网条目从 3 开始往后接 */
    eq(res.sources[0].kind, 'intro')
    eq(res.sources[1].kind, 'dynamic')
    const web = res.sources.filter((p) => p.kind === 'web')
    deepEq(web.map((p) => p.no), [3, 4, 5], '联网条目编号应连续接在报告之后')
    eq(web[0].text, '最新报道0：联网正文0')
    eq(web[0].source, '网媒0')
    eq(web[0].date, '2026-10-08')
    eq(web[0].url, 'https://example.com/web0', '必须留住原文链接：界面上要能点开核对')
    eq(web[0].ai, false, '检索结果不是 AI 判定，不能标成报告点评')

    /* prompt：条数报出联网份数，system 里那段身份说明必须在
       （漏了它，模型会把检索结果当成报告的一部分，「报告里没有」这句就再也不会出现） */
    ok(box.chat.messages[1].content.includes('联网检索 3 条'), `实际：${box.chat.messages[1].content}`)
    ok(box.chat.messages[0].content.includes('提问时刻'), 'system 须说明联网条目的身份')
    ok(box.chat.messages[0].content.includes('以时间更新的一方为准'), 'system 须给冲突时的判据')

    await new Promise((r) => setTimeout(r, 0))
    const ev = db.__dump('events').find((e) => e.event === 'report_qa_ask')
    eq(ev.props.web, 3, '埋点要能看出这一问多花了多少检索条目（成本可回溯）')
  })

  it('检索不可用时静默降级：回答照常给，资料里没有联网条目，也不报错', async () => {
    const { load } = fresh()
    login('u1')
    const box = {}
    const ask = () => load('utils/qa').askReport(report(), '最近有什么动态？')

    /* ① 通道未就绪（云函数在、但检索额度没配）→ requestChannel 返回 null */
    env.registerCloudFn('contentCheck', () => ({ ok: true, suggest: 'pass' }))
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action === 'search') return { ok: false, kind: 'unconfigured', error: 'BoCha key 未配置' }
      box.chat = data
      return { ok: true, content: '回答' }
    })
    const a = await ask()
    eq(a.ok, true, '检索不通不该让提问失败 —— 问答的底线是「有报告就能问」')
    notOk(a.sources.some((p) => p.kind === 'web'))
    notOk(
      box.chat.messages[0].content.includes('关于《资料》末尾的「联网检索」条目'),
      '没有联网资料时不该出现那段补充说明'
    )

    /* ② 通道可用但上游报错（配置类，不重试）→ requestChannel 抛出，同样降级 */
    env.registerCloudFn('aiProxy', (data) => {
      if (data.action === 'search') return { ok: false, kind: 'config', error: '检索额度不足' }
      box.chat = data
      return { ok: true, content: '回答' }
    })
    const b = await ask()
    eq(b.ok, true, '检索报错也只当「这次没有联网补充」')
    notOk(b.sources.some((p) => p.kind === 'web'))
  })

  it('检索式去掉指代词；整句都是指代词时退回通用检索式', async () => {
    const { load } = fresh()
    login('u1')
    const box = {}
    onlineWithSearch(webItems(1), box)
    const ask = (q) => load('utils/qa').askReport(report(), q)

    await ask('TA 他 最近怎么样')
    eq(box.search.query, '测试人物 最近怎么样')
    /* 「TA 最近怎么样」被抹空后不能只剩一个姓名：搜姓名只能拿回百科页，等于没补 */
    await ask('TA 他她它')
    eq(box.search.query, '测试人物 最新 动态 报道')
  })
})

/* ------------------------- 会员深度模式 O-11（闸门 / deep / 会员段落 / 热度） */

describe('会员深度模式 O-11（模型闸门 / deep / memberNotes / 热度口径）', () => {
  const cfg = (load) => load('config/public').publicConfig

  /** 会员专属档位的 id 取自公共配置：写死会在运营调整清单时变成假失败 */
  const memberOnlyModel = (load) => {
    const m = cfg(load).llm.models.find((x) => x.memberOnly)
    ok(m, '前提：公共配置里应有 memberOnly 档位，否则本组用例失去意义')
    return m.id
  }

  const seedMember = (db) =>
    db.__seed('users', [
      {
        _id: 'u1',
        _openid: 'me',
        membership: { plan: 'month', expires_at: new Date(Date.now() + 864e5).toISOString() }
      }
    ])

  const newsItems = (n, len = 40) =>
    Array.from({ length: n }, (_, i) => ({
      title: `报道${i}`,
      content: '内容'.repeat(len),
      url: `https://example.com/${i}`,
      source: '媒体X',
      publishedDate: new Date(Date.now() - i * 3600 * 1000).toISOString()
    }))

  it('模型闸门：非会员即使本机选了会员档也回落默认（设置页显示哪档 = 实际用哪档）', () => {
    const { load } = fresh()
    const preferred = memberOnlyModel(load)
    load('utils/settings').setPreferredModel(preferred)

    eq(load('utils/llm').resolveChatModel(true), preferred, '会员应能用该档')
    eq(
      load('utils/llm').resolveChatModel(false),
      cfg(load).llm.model,
      '非会员必须回落默认模型（设备上残留的旧选择也要被忽略）'
    )
  })

  it('模型闸门：偏好已从清单移除时回落默认（旧选择不能稳定生成失败）', () => {
    const { load } = fresh()
    load('utils/settings').setPreferredModel('已下架的模型')
    eq(load('utils/llm').resolveChatModel(true), cfg(load).llm.model)
    eq(load('utils/llm').resolveChatModel(false), cfg(load).llm.model)
  })

  it('深度模式：免费请求体里没有 deep 这个键（不是 deep:false），会员才有', async () => {
    const { db, load } = fresh()
    let seen = null
    env.registerCloudFn('aiProxy', (data) => {
      seen = data
      return { ok: true, content: 'ok' }
    })

    await load('utils/llm').chatText('S', 'U')
    notOk(Object.prototype.hasOwnProperty.call(seen, 'deep'), '免费版的请求体要与改造前逐字节一致')
    eq(seen.model, cfg(load).llm.model)

    seedMember(db)
    load('utils/settings').setPreferredModel(memberOnlyModel(load))
    await load('utils/llm').chatText('S', 'U')
    eq(seen.deep, true, '会员必须带 deep=true（请云函数放宽输出上限）')
    eq(seen.model, memberOnlyModel(load))
  })

  it('会员段落的提示词只往会员的 system 末尾追加，免费提示词逐字节不变', async () => {
    const { db, load } = fresh()
    let seen = null
    /* 模拟真实模型行为：只有被要求时才输出 memberNotes */
    env.registerCloudFn('aiProxy', (data) => {
      seen = data
      const asked = data.messages[0].content.includes('会员补充要求')
      const body = asked
        ? { intro: 'x', memberNotes: { compare: '对比视角', risk: '风险提示' } }
        : { intro: 'x' }
      return { ok: true, content: JSON.stringify(body) }
    })

    const news = newsItems(3)
    const free = await load('utils/report').buildReport('甲#tech', '甲', news, 'all')
    const freeSystem = seen.messages[0].content
    notOk(freeSystem.includes('memberNotes'), '免费提示词不该出现会员段落（也就不白付这两段的 token）')
    eq(free.data.memberNotes, undefined, '免费报告恒无会员段落')

    seedMember(db)
    const paid = await load('utils/report').buildReport('甲#tech', '甲', news, 'all', { member: true })
    const memberSystem = seen.messages[0].content
    ok(memberSystem.startsWith(freeSystem), '会员提示词 = 免费提示词 + 追加，而不是另起一套')
    ok(memberSystem.includes('会员补充要求'), '应追加 O-11 的会员段要求')
    eq(paid.data.memberNotes.compare, '对比视角', 'schema 必须声明 memberNotes，否则 zod 会静默丢弃')
    eq(paid.data.memberNotes.risk, '风险提示')
  })

  it('memberNotes：两段皆空则整个字段不落库，非空则各自收敛到 240 字', () => {
    const { load } = fresh()
    const { sanitizeReport } = load('utils/report')
    const news = newsItems(2)
    const fields = { dynamics: [], quotes: [], sources: [], timeline: [] }

    eq(
      sanitizeReport('k', '甲', Object.assign({}, fields, { memberNotes: { compare: '  ', risk: '' } }), news).memberNotes,
      undefined,
      '两段皆空应整段不落库（UI 按有没有这个字段决定出不出一张卡）'
    )
    eq(sanitizeReport('k', '甲', fields, news).memberNotes, undefined, '老报告没有该字段时恒无此段')

    const long = sanitizeReport(
      'k',
      '甲',
      Object.assign({}, fields, { memberNotes: { compare: '长'.repeat(300), risk: '风险' } }),
      news
    )
    eq(long.memberNotes.compare.length, 240, '自由文本只能收敛长度')
    eq(long.memberNotes.risk, '风险')
  })

  it('热度口径：深度模式多拿的素材不参与热度（截到 20 条，榜单不被档位污染）', () => {
    const { load } = fresh()
    const { sanitizeReport } = load('utils/report')
    const news = newsItems(40)

    const full = sanitizeReport('k', '甲', {}, news)
    const capped = sanitizeReport('k', '甲', {}, news.slice(0, 20))
    eq(full.heat, capped.heat, '热度必须只看前 20 条：否则同一个人「被谁生成过」会改变它的热度')
    eq(full.coverage.items, 40, 'coverage 是事实（原样统计），与热度刻意不必相等')
    eq(capped.coverage.items, 20)
  })

  it('深度模式放宽 user 预算：免费 15000 字内、会员 20000 字内，且会员真的用上了', async () => {
    const { db, load } = fresh()
    let seen = null
    env.registerCloudFn('aiProxy', (data) => {
      seen = data
      return { ok: true, content: JSON.stringify({ intro: 'x' }) }
    })
    const news = newsItems(60, 300)

    await load('utils/report').buildReport('甲#tech', '甲', news, 'all')
    const freeLen = seen.messages[1].content.length

    seedMember(db)
    await load('utils/report').buildReport('甲#tech', '甲', news, 'all', { member: true })
    const paidLen = seen.messages[1].content.length

    ok(freeLen <= 15000, `免费 user 不应超 15000，实际 ${freeLen}`)
    ok(paidLen <= 20000, `会员 user 不应超 20000，实际 ${paidLen}`)
    ok(paidLen > 15000, `会员应真的用上更宽的预算（否则加厚的素材会被直接截掉），实际 ${paidLen}`)
  })
})

/* --------------------------------- 报告质量：素材分级保留 / 点评拆条 / 信源分歧 */

describe('报告质量（素材分级保留 / 点评拆条 / 信源分歧）', () => {
  const newsItem = (over = {}) =>
    Object.assign(
      {
        title: '标题',
        content: '正文',
        url: 'https://example.com/a',
        source: '媒体A',
        publishedDate: '2026-10-08T00:00:00.000Z'
      },
      over
    )

  /*
   * 三组互不相干的词，标题取 (i%6, i%8, i%9) 的组合：0..39 之间任两条最多只有一个部件相同，
   * 相似度远低于判同阈值 —— 否则「只差一个字的标题」会全部被判成同一件事，测的就不是分级保留了。
   */
  const PARTS_A = ['影星', '歌手', '导演', '编剧', '演员', '主持']
  const PARTS_B = ['新片', '巡演', '剧本', '奖项', '代言', '声明', '公益', '版权']
  const PARTS_C = ['开机', '延期', '完稿', '揭晓', '官宣', '澄清', '启动', '结项', '复出']

  /** 造 n 条彼此不相干的素材（两两不会归组） */
  const distinct = (n, len = 40) =>
    Array.from({ length: n }, (_, i) =>
      newsItem({
        title: `报道${PARTS_A[i % 6]}${PARTS_B[i % 8]}${PARTS_C[i % 9]}`,
        url: `https://example.com/${i}`,
        content: '内容'.repeat(len)
      })
    )

  /** 跑一次 buildReport，把真正发给模型的两条消息正文取回来 */
  const buildMessages = async (news, member = false) => {
    const { load } = fresh()
    let seen = null
    env.registerCloudFn('aiProxy', (data) => {
      seen = data
      return { ok: true, content: JSON.stringify({ intro: 'x' }) }
    })
    await load('utils/report').buildReport('甲#tech', '甲', news, 'all', member ? { member: true } : {})
    return { system: seen.messages[0].content, user: seen.messages[1].content }
  }

  const countOf = (s, sub) => s.split(sub).length - 1

  it('装不下时降级为压缩条目，而不是整条丢弃（改造前是「截断即丢失」）', async () => {
    /* 40 条 × 600 字：全文名额只有 10 个，其余 30 条必然降到压缩档 */
    const news = distinct(40, 300)
    const { user } = await buildMessages(news)

    ok(user.length <= 15000, `user 消息不应超预算，实际 ${user.length}`)
    eq(countOf(user, '（正文从略）'), 30, '超出全文名额的条目应被压成参考条目，而不是消失')
    const missing = news.filter((n) => !user.includes(n.url))
    deepEq(missing, [], '每一条素材的 url 都应出现在提示词里（降级只压缩正文，不丢素材）')
    ok(user.includes('内容内容'), '压缩条目仍带正文摘要片段，不是空白占位')
  })

  it('同一事件的第 2 条起一律压缩：重复信息让位给别的条目', async () => {
    /* 5 篇讲同一件事（标题完全相同）+ 1 篇另一件事；判同只看标题，故正文可以完全不同 */
    const dup = Array.from({ length: 5 }, (_, i) =>
      newsItem({
        title: '某影星回应新片争议传闻并表示一切以官方消息为准',
        url: `https://example.com/dup${i}`,
        content: `重复正文${i}`.repeat(200)
      })
    )
    const other = newsItem({
      title: '另一位艺人的演唱会宣布延期',
      url: 'https://example.com/other',
      content: '另一件事的正文'.repeat(50)
    })
    const { user } = await buildMessages([...dup, other])

    eq(countOf(user, '（正文从略）'), 4, '同事件的第 2~5 条全部进压缩档')
    ok(user.includes('重复正文0'), '组代表（首条）仍拿到全文')
    ok(user.includes('重复正文1'), '同事件其余报道仍要在场，并在压缩档里保留摘要')
    ok(user.includes('另一件事的正文'), '不相干的事件不受归组影响，仍给全文')
  })

  it('点评拆条的 basis 换成媒体名，编造的 url 收敛为「据公开资料」', () => {
    const { load } = fresh()
    const { sanitizeReport } = load('utils/report')
    const news = distinct(2)

    const r = sanitizeReport(
      'k',
      '甲',
      {
        dynamics: [],
        quotes: [],
        sources: [],
        timeline: [],
        analysisPoints: [
          { point: '某影星在采访中否认了传闻', basis: news[0].url },
          { point: '该片票房已破十亿', basis: 'https://编造的.example.com/x' },
          { point: '   ', basis: news[0].url }
        ]
      },
      news
    )

    deepEq(
      r.analysisPoints,
      [
        { point: '某影星在采访中否认了传闻', basis: '媒体A' },
        { point: '该片票房已破十亿', basis: '据公开资料' }
      ],
      '删除空判断；basis 由 url 换成媒体名，不在素材内的一律退回「据公开资料」'
    )
    ok(
      r.analysisPoints.every((p) => !p.basis.includes('http')),
      '页面上不该出现裸 URL（依据只展示媒体名）'
    )
    eq(
      r.analysis,
      '某影星在采访中否认了传闻。该片票房已破十亿。',
      'analysis 由各条拼出（问答上下文与老 UI 都读这个字符串，不能断供）'
    )
  })

  it('点评拆条超 4 条截断、超 80 字收敛；老报告只有 analysis 时也没有拆条', () => {
    const { load } = fresh()
    const { sanitizeReport } = load('utils/report')
    const news = distinct(1)
    const fields = { dynamics: [], quotes: [], sources: [], timeline: [] }

    const many = sanitizeReport(
      'k',
      '甲',
      Object.assign({}, fields, {
        analysisPoints: Array.from({ length: 9 }, (_, i) => ({ point: `判断${i}`.repeat(40), basis: '' }))
      }),
      news
    )
    eq(many.analysisPoints.length, 4, '条数上限 4')
    eq(many.analysisPoints[0].point.length, 80, '自由文本只能收敛长度')

    const legacy = sanitizeReport('k', '甲', Object.assign({}, fields, { analysis: '老报告的整段点评' }), news)
    eq(legacy.analysis, '老报告的整段点评')
    eq(legacy.analysisPoints, undefined, '改动前落库的报告没有这个字段，UI 据此回落整段')
  })

  it('信源分歧：缺任一侧的条目剔除、超 3 条截断、全空则不落库', () => {
    const { load } = fresh()
    const { sanitizeReport } = load('utils/report')
    const news = distinct(1)
    const fields = { dynamics: [], quotes: [], sources: [], timeline: [] }

    eq(sanitizeReport('k', '甲', fields, news).conflicts, undefined, '免费报告（无该字段）恒无此段')

    const r = sanitizeReport(
      'k',
      '甲',
      Object.assign({}, fields, {
        conflicts: [
          { topic: '票房', a: '甲媒体说破十亿', b: '乙媒体说未过亿' },
          { topic: '离婚', a: '甲媒体说已离婚', b: '' },
          { topic: '  ', a: 'A', b: 'B' },
          { topic: '第二处', a: 'A2', b: 'B2' },
          { topic: '第三处', a: 'A3', b: 'B3' },
          { topic: '第四处', a: 'A4', b: 'B4' }
        ]
      }),
      news
    )
    eq(r.conflicts.length, 3, '超 3 条截断')
    deepEq(
      r.conflicts.map((c) => c.topic),
      ['票房', '第二处', '第三处'],
      '只有一方说法的不是分歧（剔除），争点为空的也剔除'
    )
  })

  it('信源分歧只往会员提示词追加：免费提示词里既无字段、也不白付这段 token', async () => {
    /* 素材刻意混一条重复报道：会员与免费的**素材选取**必须一致，只是预算不同 */
    const news = distinct(3).concat([
      newsItem({
        title: '报道影星新片开机',
        url: 'https://example.com/dup',
        content: '重复正文'.repeat(100)
      })
    ])
    const { system: freeSystem, user: freeUser } = await buildMessages(news)
    const { system: paidSystem, user: paidUser } = await buildMessages(news, true)

    notOk(freeSystem.includes('conflicts'), '免费提示词不该出现会员段')
    notOk(freeUser.includes('conflicts'), '免费提示词不该出现会员段')
    ok(paidSystem.startsWith(freeSystem), '会员提示词仍是「免费 + 追加」，不另起一套')
    ok(paidSystem.includes('conflicts'), '会员应被要求输出信源分歧')
    eq(paidUser, freeUser, '素材选取只取决于素材本身，与会员身份无关（预算够时两者逐字相同）')
  })
})
