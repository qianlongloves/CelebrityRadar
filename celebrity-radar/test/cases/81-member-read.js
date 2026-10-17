'use strict'

/**
 * P2 方案 A **阶段 2**：端上会员段读口（2026-10-17）。
 *
 * 阶段 1（云端双写 + `op:'member'`）已上线；这一版做端上取用侧，且**当下不会真的执行**
 * （没有报告带 `memberSections` 旗标，写口要等阶段 3 剥段时才写）。所以钉的不是「跑得通」，
 * 而是将来跑起来时必须成立的几条：
 *
 *   1. **旗标是唯一触发器**。「主行无四段」有两种原因 —— 免费档产物（补也没有）/ 被剥段（要补），
 *      端上分不出来只能问旗标。少了它，会员每开一份免费报告都白发一次云函数 + 一次限速计数。
 *   2. **时间戳逐字相等**。两行不是原子写的，宁可少给也不能把上一版四段配到这一版正文上。
 *   3. **必须返回新对象**。`report` 可能是缓存里的引用，就地 assign 等于把会员段留在缓存里。
 *   4. **失败一律静默**：免费态本来就是完整可用的界面。
 *   5. **批量读口不补**（列表页不渲染四段），**端上永不直连副本表**。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')
const BUILD = path.join(ROOT, 'test', '.build')
const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')

const PERSON = '张三#tech'
const GEN = '2026-10-17T08:00:00.000Z'
const OTHER_GEN = '2026-10-18T08:00:00.000Z'
/** 旗标 token（精确到段：memberNotes 装两段独立文字，只写字段名分不出 compare / risk） */
const FLAG = ['memberNotes.compare', 'memberNotes.risk', 'conflicts', 'peers', 'affiliations']

const SECTIONS = {
  memberNotes: { compare: '与同领域三人相比曝光更集中', risk: '三条素材指向同一争议' },
  conflicts: [{ topic: '合作方口径不一致' }],
  peers: [{ name: '李四' }],
  affiliations: [{ name: '某公司' }]
}

const report = (extra) => Object.assign({ personKey: PERSON, name: '张三', generatedAt: GEN }, extra || {})
/** 免费档产物：**没有**旗标（绝大多数报告，也是阶段 2 上线时的全部报告） */
const bornFree = () => report()
/** 阶段 3 之后的主行：旗标说有、正文没有 */
const stripped = () => report({ memberSections: FLAG })
/** 阶段 3 之前的主行（双写期）：旗标 + 正文都有 */
const intact = () => report({ memberSections: FLAG, ...SECTIONS })

function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

function fresh() {
  env.resetAll()
  configureCloud()
  const MS = env.load('utils/member-sections')
  MS.__clearMemberSectionsCache()
  return { MS, load: env.load, db: env.db }
}

/** 注册 aiProxy 桩，返回它收到的入参（用来数「到底发了几次」） */
function stubProxy(reply) {
  const calls = []
  env.registerCloudFn('aiProxy', async (data, n) => {
    calls.push(data)
    return typeof reply === 'function' ? reply(data, n) : reply
  })
  return calls
}

const OK = { ok: true, result: 'ok', generated_at: GEN, sections: SECTIONS }

function srcFiles(dir, out) {
  const list = out || []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) srcFiles(full, list)
    else if (/\.tsx?$/.test(name)) list.push(full)
  }
  return list
}

/* ═══════════ 1. 口径：两份名单逐字相同 ═══════════ */

describe('口径一致：端上与云端的会员段字段名单', () => {
  it('MEMBER_FIELD_KEYS 与 aiProxy/report-store.js#MEMBER_FIELDS 逐字相同', () => {
    fresh()
    const { MEMBER_FIELD_KEYS } = env.load('utils/member')
    const cloud = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'aiProxy', 'report-store.js'), 'utf8')
    const m = cloud.match(/const MEMBER_FIELDS = \[([^\]]*)\]/)
    ok(m, '云端应能定位到 MEMBER_FIELDS')
    const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    /* 云侧那份是手抄的（云函数打包读不到 src）：多了少了都会让「副本存了什么」与
       「端上认什么」分家，而后果只是某些会员段静默缺失，不会报错 */
    deepEq([...MEMBER_FIELD_KEYS], names)
  })

  it('MEMBER_FLAGS 与云端 memberFlagsOf 用的 token 逐字相同', () => {
    fresh()
    const { MEMBER_FLAGS } = env.load('utils/member')
    const cloud = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'aiProxy', 'report-store.js'), 'utf8')
    const m = cloud.match(/const MEMBER_FLAGS = \[([^\]]*)\]/)
    ok(m, '云端应能定位到 MEMBER_FLAGS')
    const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    deepEq([...MEMBER_FLAGS], names, 'token 对不上 ⇒ 非会员看到的是「已含对比视角」，实际取回来是另一段')
  })
})

/* ═══════════ 2. 触发判据 ═══════════ */

describe('触发判据：只有「旗标说有、正文没有」才去要副本', () => {
  it('无旗标 = 免费档产物 → 不补（这条快路径决定成本）', () => {
    const { MS } = fresh()
    eq(MS.hasStrippedMember(bornFree()), false)
  })

  it('旗标空数组 / 不是数组 / 空报告 → 一律不补、不抛', () => {
    const { MS } = fresh()
    eq(MS.hasStrippedMember(report({ memberSections: [] })), false)
    eq(MS.hasStrippedMember(report({ memberSections: 'yes' })), false)
    eq(MS.hasStrippedMember(null), false)
    eq(MS.hasStrippedMember(undefined), false)
  })

  it('阶段 3 之前的主行（旗标 + 正文四段）→ 不补：白发请求没有意义', () => {
    const { MS } = fresh()
    eq(MS.hasStrippedMember(intact()), false)
  })

  it('剥过段的主行（旗标 + 正文没有）→ 要补', () => {
    const { MS } = fresh()
    eq(MS.hasStrippedMember(stripped()), true)
  })

  it('只剩结构化段（peers）也算「正文里有」→ 不补', () => {
    const { MS } = fresh()
    eq(MS.hasStrippedMember(report({ memberSections: ['peers'], peers: [{ name: '李四' }] })), false)
  })
})

/* ═══════════ 3. 读口：请求形态与结果分类 ═══════════ */

describe('读口：只发该发的参数、只认该认的结果', () => {
  it('取当前版：带 personKey + generatedAt，**不带** version；只保留白名单字段', async () => {
    const { MS } = fresh()
    const calls = stubProxy({ ...OK, sections: { ...SECTIONS, extra: '不该进来' } })
    const out = await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })

    eq(calls.length, 1)
    eq(calls[0].action, 'report')
    eq(calls[0].op, 'member')
    eq(calls[0].personKey, PERSON)
    eq(calls[0].generatedAt, GEN)
    notOk('version' in calls[0], '当前版不该传 version —— 云函数会拿它去查历史版')

    eq(out.ok, true)
    eq(out.reason, 'ok')
    deepEq(out.sections, SECTIONS)
    notOk('extra' in out.sections, '云端多给的键不得进报告对象')
  })

  it('时间戳对不上 → mismatch（哪怕云端说 ok）', async () => {
    const { MS } = fresh()
    stubProxy({ ok: true, result: 'ok', generated_at: OTHER_GEN, sections: SECTIONS })
    const out = await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })
    eq(out.ok, false)
    eq(out.reason, 'mismatch')
    eq(out.sections, undefined)
  })

  it('云端说 ok 但四段全是空壳 → empty（别把空数组当会员内容塞进正文）', async () => {
    const { MS } = fresh()
    stubProxy({ ok: true, result: 'ok', generated_at: GEN, sections: { memberNotes: {}, conflicts: [] } })
    eq((await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })).reason, 'empty')
  })

  it('云端 ok:false 按 kind 分类：auth / abuse / 其他一律 failed', async () => {
    let s = fresh()
    stubProxy({ ok: false, kind: 'auth', error: '会员专属段落只对有效会员开放' })
    eq((await s.MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })).reason, 'auth')

    s = fresh()
    stubProxy({ ok: false, kind: 'abuse', error: '超限' })
    eq((await s.MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })).reason, 'abuse')

    s = fresh()
    stubProxy({ ok: false, kind: 'upstream', error: '云函数炸了' })
    eq((await s.MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })).reason, 'failed')
  })

  it('云函数 result=empty / mismatch 原样透传', async () => {
    let s = fresh()
    stubProxy({ ok: true, result: 'empty' })
    eq((await s.MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })).reason, 'empty')

    s = fresh()
    stubProxy({ ok: true, result: 'mismatch', generated_at: OTHER_GEN })
    eq((await s.MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })).reason, 'mismatch')
  })

  it('还没部署（callFunction 抛错）→ failed，绝不把异常抛给页面', async () => {
    const { MS } = fresh()
    env.unregisterCloudFn('aiProxy')
    const out = await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })
    eq(out.ok, false)
    eq(out.reason, 'failed')
  })

  it('缺配对键就不发请求：空时间戳只能换来一次错配', async () => {
    const { MS } = fresh()
    const calls = stubProxy(OK)
    eq((await MS.fetchMemberSections({ personKey: '', generatedAt: GEN })).reason, 'failed')
    eq((await MS.fetchMemberSections({ personKey: PERSON, generatedAt: '' })).reason, 'failed')
    eq(calls.length, 0)
  })
})

/* ═══════════ 4. 结论缓存 ═══════════ */

describe('结论缓存：省往返，但不把临时故障变成永久缺失', () => {
  it('同一份（personKey + generatedAt）只问一次', async () => {
    const { MS } = fresh()
    const calls = stubProxy(OK)
    const a = await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })
    const b = await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })
    eq(calls.length, 1, '第二次应命中结论缓存')
    deepEq(a.sections, b.sections)
  })

  it('报告重生（generatedAt 变了）自然失效', async () => {
    const { MS } = fresh()
    const calls = stubProxy((d) => ({ ok: true, result: 'ok', generated_at: d.generatedAt, sections: SECTIONS }))
    await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })
    await MS.fetchMemberSections({ personKey: PERSON, generatedAt: OTHER_GEN })
    eq(calls.length, 2)
  })

  it('failed 不缓存：断网一次不该让这份报告永远补不上', async () => {
    const { MS } = fresh()
    const calls = stubProxy(() => {
      throw new Error('network down')
    })
    await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })
    await MS.fetchMemberSections({ personKey: PERSON, generatedAt: GEN })
    eq(calls.length, 2, '失败必须可重试')
  })
})

/* ═══════════ 5. 补齐 ═══════════ */

describe('补齐（patchMemberSections）', () => {
  it('免费档报告 / 正文已有四段 → 一次请求都不发，返回 null', async () => {
    const { MS } = fresh()
    const calls = stubProxy(OK)
    eq(await MS.patchMemberSections(bornFree()), null)
    eq(await MS.patchMemberSections(intact()), null)
    eq(calls.length, 0)
  })

  it('剥段报告 → 返回新对象，**原对象保持没有四段**（它可能是缓存里的引用）', async () => {
    const { MS } = fresh()
    stubProxy(OK)
    const source = stripped()
    const patched = await MS.patchMemberSections(source)
    ok(patched, '应补上四段')
    notOk(patched === source, '必须是新对象')
    deepEq(patched.memberNotes, SECTIONS.memberNotes)
    eq(patched.conflicts.length, 1)
    notOk('memberNotes' in source, '原对象被就地改写了 —— 下一位免费读者会拿到同一份对象')
  })

  it('历史版：version 传的必须是那一版的生成时间（否则点查成当前版、错配四段）', async () => {
    const { MS } = fresh()
    const calls = stubProxy(OK)
    await MS.patchMemberSections(stripped(), 'version')
    eq(calls.length, 1)
    eq(calls[0].version, GEN)
  })

  it('补不上就是 null（不抛、不返回半份数据）', async () => {
    const { MS } = fresh()
    stubProxy({ ok: true, result: 'empty' })
    eq(await MS.patchMemberSections(stripped()), null)
  })
})

/* ═══════════ 6. 接线：exposeReport 唯一收口 ═══════════ */

describe('接线：exposeReport 是唯一收口，批量读口不补', () => {
  it('会员 + 剥段 → 补齐；非会员 + 剥段 → 一次都不发', async () => {
    const { load } = fresh()
    const calls = stubProxy(OK)
    const { exposeReport } = load('utils/cache')

    const forMember = await exposeReport(stripped(), true)
    eq(calls.length, 1)
    deepEq(forMember.report.memberNotes, SECTIONS.memberNotes)

    const forFree = await exposeReport(stripped(), false)
    eq(calls.length, 1, '非会员本来也拿不到，别白发一次云函数')
    notOk('memberNotes' in forFree.report)
  })

  it('没有旗标（绝大多数报告）→ 不补、且不读任何库', async () => {
    const { load, db } = fresh()
    const calls = stubProxy(OK)
    const { exposeReport } = load('utils/cache')
    const before = db.stats.getCalls
    const shown = await exposeReport(bornFree())
    eq(calls.length, 0)
    eq(db.stats.getCalls, before, '快路径连身份都不该读')
    eq(shown.locked.length, 0)
  })

  it('会员 + 正文有四段（阶段 3 之前）→ 不补，原样交回', async () => {
    const { load } = fresh()
    const calls = stubProxy(OK)
    const { exposeReport } = load('utils/cache')
    const shown = await exposeReport(intact(), true)
    eq(calls.length, 0)
    eq(shown.locked.length, 0)
    deepEq(shown.report.memberNotes, SECTIONS.memberNotes)
  })

  it('非会员看剥段报告：促销条靠旗标点名段落（不能静默消失）', async () => {
    const { load } = fresh()
    const calls = stubProxy(OK)
    const { exposeReport } = load('utils/cache')
    const shown = await exposeReport(stripped(), false)
    eq(calls.length, 0, '非会员不发请求')
    notOk('memberNotes' in shown.report)
    /* 正文里一段都没有时，`locked` 由旗标还原 —— 否则促销条一句话都说不出来，静默消失 */
    deepEq(shown.locked, ['对比视角', '风险提示', '信源分歧'])
  })

  it('批量读口 getCachedReports 不为会员段发请求（列表页不渲染四段）', async () => {
    const { load, db } = fresh()
    const calls = stubProxy(OK)
    db.__seed('report_cache', [{ _id: PERSON, state: 'ready', generated_at: GEN, report: stripped() }])
    const rows = await load('utils/cache').getCachedReports([PERSON])
    ok(Array.isArray(rows), '批量读口应返回数组')
    eq(calls.length, 0, '批量读口必须保持零云函数调用')
  })
})

/* ═══════════ 7. 静态边界 ═══════════ */

/** 剥掉注释再断言：解释性注释里会写到这些字样，直接搜会误伤 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('静态边界：端上永不直连副本表，读口只有一处', () => {
  it('历史版读口把改动交给 version 口径', () => {
    ok(readSrc('utils/report-versions.ts').includes('{ version: true }'), 'loadVersionReport 必须传 version 口径')
  })

  it('端上没有任何一处直连 report_member（客户端读不到它，这正是方案的意义）', () => {
    const bad = srcFiles(SRC).filter((f) =>
      /(?:table|collection)\(\s*['"]report_member/.test(stripComments(fs.readFileSync(f, 'utf8')))
    )
    deepEq(bad.map((f) => path.relative(SRC, f).replace(/\\/g, '/')), [])
  })

  it('`op: \'member\'` 只出现在 utils/member-sections.ts（别处另开口子就绕过了配对与静默降级）', () => {
    const callers = srcFiles(SRC).filter((f) => stripComments(fs.readFileSync(f, 'utf8')).includes("op: 'member'"))
    deepEq(callers.map((f) => path.relative(SRC, f).replace(/\\/g, '/')), ['utils/member-sections.ts'])
  })
})
