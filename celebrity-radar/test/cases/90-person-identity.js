'use strict'

/**
 * 「搜到的是不是同一个人」（2026-10-18）。
 *
 * 用户的实测问题：同一个人会出现多份分报告（雷军 科技 / 汽车 / 投资 各一份），
 * 而此前的修法（只按名字或名字+领域）两头都不对：
 *   · 只按名字 ⇒ 同名不同人被并成一份（A 的报告给了 B）；
 *   · 只按名字+领域 ⇒ 同一个人跨领域被拆成多份。
 *
 * 现在补上中间那层：**从已有报告里取「本人与哪些机构有明确关联」，与候选的一句话身份比对**
 * （utils/person-identity.ts），再由 utils/person-index.ts 按三层判据决定用哪一份：
 *   ① 领域同组（domainIdentityKey）→ 直接用；
 *   ② 用户确认过的别名（person_alias）→ 直接用 / 否认过就不合并；
 *   ③ brief 机构指纹：强命中直接用，弱命中只带回 `strength:'maybe'` 让页面问一句。
 *
 * 本用例钉住：
 *   1. 领域同义组：组内相等、跨组不等、自创词只与自己相等；
 *   2. 身份指纹只收**具名机构**，角色词与籍贯之类不入；
 *   3. brief 命中的两条规则（完整包含 / 简称前缀）与那条刻意的地名误伤排除；
 *   4. 三层判据各自的结论与 `merge.from` / `strength`；
 *   5. confirm / reject 的写库与「只允许同名之间合并」的校验。
 */

const env = require('../harness/env')
const { describe, it, ok, eq, deepEq } = require('../harness/t')

function fresh() {
  env.resetAll()
  return { load: env.load }
}

const T1 = '2026-10-18T02:00:00.000Z'
const T2 = '2026-10-18T03:00:00.000Z'

/** 最小报告：本文件只关心身份相关的字段 */
const rep = (name, domain, extra = {}) => ({
  personKey: `${name}#${domain}`,
  name,
  generatedAt: T2,
  degraded: false,
  ...extra
})

/** report_cache 行（__seed 认 _id，db.ts 适配层负责 id ↔ _id 互映） */
const rowOf = (name, domain, extra = {}) => ({
  _id: `${name}#${domain}`,
  state: 'ready',
  generated_at: T2,
  report: rep(name, domain, extra)
})

describe('domainIdentityKey：同义组内相等、跨组刻意不等', () => {
  it('科技 / AI / 芯片 / tech 都在 tech 这一组', () => {
    const { domainIdentityKey } = env.load('config/domains')
    for (const w of ['科技', 'AI', 'ai', '人工智能', '大模型', '芯片', '半导体', 'tech']) {
      eq(domainIdentityKey(w), 'tech', `「${w}」应归到 tech 这一组`)
    }
  })

  it('tech 与 internet、business 与 finance 是不同组（不能为了「少一份」把它们并了）', () => {
    const { domainIdentityKey } = env.load('config/domains')
    eq(domainIdentityKey('互联网'), 'internet', '互联网是 internet 的标签，不是 tech')
    ok(domainIdentityKey('互联网') !== domainIdentityKey('科技'), 'tech ≠ internet')
    ok(domainIdentityKey('商业') !== domainIdentityKey('财经'), 'business ≠ finance')
    ok(domainIdentityKey('投资') !== domainIdentityKey('科技'), 'finance ≠ tech（同一个雷军跨领域是真的）')
  })

  it('未收录的自由词只与自己相等；空值归 other（与 buildPersonKey 的回落一致）', () => {
    const { domainIdentityKey } = env.load('config/domains')
    eq(domainIdentityKey('竖屏短剧'), '竖屏短剧', '自由领域原样保留')
    ok(domainIdentityKey('竖屏短剧') !== domainIdentityKey('微短剧'), '两个自创词不会因为「都叫短剧」被并')
    eq(domainIdentityKey(''), 'other')
    eq(domainIdentityKey('   '), 'other')
  })

  it('同义归一不影响展示：「科技」仍显示「科技」，AI 也显示「科技」（那是同一组的人话名）', () => {
    const { domainDisplayForKey } = env.load('config/domains')
    eq(domainDisplayForKey('科技'), '科技')
    eq(domainDisplayForKey('AI'), '科技', '提示里说「已用『科技』那份」比说「AI」更让人对上号')
    eq(domainDisplayForKey('竖屏短剧'), '竖屏短剧', '未收录的自由词原样展示')
  })
})

describe('identityTokensOf：只收具名机构，角色词 / 籍贯不入', () => {
  it('关联企业、代言品牌是强信号；档案里的「所属机构」是弱信号', () => {
    const { identityTokensOf } = env.load('utils/person-identity')
    const tokens = identityTokensOf({
      profile: [
        { label: '所属机构', value: '小米集团（1810.HK）' },
        { label: '职业', value: '企业家' },
        { label: '籍贯', value: '湖北仙桃' }
      ],
      affiliations: [
        { name: '小米集团', kind: '创办' },
        { name: '金山软件', kind: '任职' }
      ],
      endorsements: [{ brand: '小米汽车' }]
    })
    deepEq(tokens.strong, ['小米集团', '金山软件', '小米汽车'], '强信号 = 关联企业 + 代言品牌（括号里的代码要去掉）')
    deepEq(tokens.weak, ['小米集团'], '弱信号只来自「所属机构」这类 label')
    ok(tokens.weak.indexOf('企业家') === -1, '「职业」是角色词，不是机构，收进来只会制造误命中')
    ok(tokens.weak.indexOf('湖北仙桃') === -1, '籍贯与「是不是同一个人」无关')
  })

  it('空报告 / 缺字段 ⇒ 两个空数组（调用方据此走「没信号」分支，不猜）', () => {
    const { identityTokensOf } = env.load('utils/person-identity')
    deepEq(identityTokensOf(null), { strong: [], weak: [] })
    deepEq(identityTokensOf({ intro: '某某' }), { strong: [], weak: [] })
  })
})

describe('briefHasEntity：完整包含与简称前缀（并排掉那一类地名误伤）', () => {
  it('完整包含直接算命中', () => {
    const { briefHasEntity } = env.load('utils/person-identity')
    ok(briefHasEntity('小米集团创始人', '小米集团'))
    ok(briefHasEntity('小米创始人、金山董事长', '小米'), '机构名就两个字时按完整包含比')
  })

  it('机构名较长时用前两个字兜住简称（brief 写「小米创始人」、报告写「小米集团」）', () => {
    const { briefHasEntity } = env.load('utils/person-identity')
    ok(briefHasEntity('小米创始人、金山董事长', '小米集团'), '不放这一步，简称永远命中不了')
    ok(briefHasEntity('金山董事长', '金山软件'))
  })

  it('前两字命中但紧邻地名后缀（人/市/省/籍）⇒ 判为没命中', () => {
    const { briefHasEntity } = env.load('utils/person-identity')
    ok(!briefHasEntity('北京人艺演员', '北京大学'), '「北京人艺」不是「北京大学」，不能因为都有「北京」就合并')
    ok(!briefHasEntity('上海市作协主席', '上海交通大学'))
    ok(briefHasEntity('上海交通大学教授', '上海交通大学'), '完整包含仍然命中（同一人的正常写法）')
  })

  it('一个词都没对上 ⇒ 没命中（宁可不并，也不猜）', () => {
    const { briefHasEntity } = env.load('utils/person-identity')
    ok(!briefHasEntity('雷军', '金山软件'))
    ok(!briefHasEntity('', '小米集团'))
  })
})

describe('matchIdentity：强命中自动、弱命中只提示', () => {
  it('命中关联企业 ⇒ same（可以直接用已有那份）', () => {
    const { matchIdentity } = env.load('utils/person-identity')
    const m = matchIdentity('小米创始人', { strong: ['小米集团'], weak: [] })
    eq(m.verdict, 'same')
    eq(m.via, 'strong')
    deepEq(m.hits, ['小米集团'])
  })

  it('只命中档案里的所属机构 ⇒ maybe（要问一句，不自动合并）', () => {
    const { matchIdentity } = env.load('utils/person-identity')
    const m = matchIdentity('小米创始人', { strong: [], weak: ['小米集团'] })
    eq(m.verdict, 'maybe')
    eq(m.via, 'weak')
  })

  it('没有 brief、或一个词都没对上 ⇒ unknown', () => {
    const { matchIdentity } = env.load('utils/person-identity')
    eq(matchIdentity('', { strong: ['小米集团'], weak: [] }).verdict, 'unknown')
    eq(matchIdentity('雷军', { strong: ['小米集团'], weak: [] }).verdict, 'unknown')
  })
})

describe('identityHeadlineOf：一句人话，只搬运不归纳', () => {
  it('优先拼「所属机构 + 职业」', () => {
    const { identityHeadlineOf } = env.load('utils/person-identity')
    eq(
      identityHeadlineOf({
        profile: [
          { label: '所属机构', value: '小米集团' },
          { label: '职业', value: '创始人' }
        ]
      }),
      '小米集团创始人'
    )
  })

  it('拼不出来退回 intro 前 24 字（带省略号）', () => {
    const { identityHeadlineOf } = env.load('utils/person-identity')
    const intro = '一位长期从事消费电子与智能汽车的企业家，同时是天使投资人'
    const out = identityHeadlineOf({ intro })
    eq(out, `${intro.slice(0, 24)}…`)
    eq(identityHeadlineOf(null), '')
  })
})

describe('resolvePersonIdentity：三层判据', () => {
  it('brief 强命中同名报告的机构 ⇒ 直接用那份（from=brief, auto）', async () => {
    const { load } = fresh()
    const { resolvePersonIdentity } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', { affiliations: [{ name: '小米集团', kind: '创办' }] })])

    const res = await resolvePersonIdentity('雷军', 'auto', '小米创始人、金山董事长')
    eq(res.personKey, '雷军#tech', '同一个人换个领域写法，不该再生成第二份')
    eq(res.merge && res.merge.from, 'brief')
    eq(res.merge && res.merge.strength, 'auto')
    eq(res.merge && res.merge.domain, 'tech')
  })

  it('weak 命中 ⇒ 不合并（personKey 仍是入参 key），只带回 maybe 让页面问一句', async () => {
    const { load } = fresh()
    const { resolvePersonIdentity } = load('utils/person-index')
    /* 只有「所属机构」、没有关联企业：认错人的代价高，故不许自动合并 */
    env.db.__seed('report_cache', [
      rowOf('雷军', 'tech', { profile: [{ label: '所属机构', value: '小米集团' }] })
    ])

    const res = await resolvePersonIdentity('雷军', 'auto', '小米创始人')
    eq(res.personKey, '雷军#auto', '没确认之前各留一份（保守）')
    eq(res.merge && res.merge.strength, 'maybe')
    eq(res.merge && res.merge.personKey, '雷军#tech', '候选指向已有那份，供页面「是同一人」按钮使用')
  })

  it('用户确认过的别名 ⇒ from=alias（即使领域不同）', async () => {
    const { load } = fresh()
    const { resolvePersonIdentity } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech')])
    env.db.__seed('person_alias', [
      { _id: '雷军#auto', alias: '雷军#auto', personKey: '雷军#tech', name: '雷军', domain: 'auto' }
    ])

    const res = await resolvePersonIdentity('雷军', 'auto')
    eq(res.personKey, '雷军#tech')
    eq(res.merge && res.merge.from, 'alias')
  })

  it('用户否认过（personKey 为空串）⇒ 不合并、也不再问', async () => {
    const { load } = fresh()
    const { resolvePersonIdentity } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech', { affiliations: [{ name: '小米集团' }] })])
    env.db.__seed('person_alias', [
      { _id: '雷军#auto', alias: '雷军#auto', personKey: '', name: '雷军', domain: 'auto' }
    ])

    /* 即使 brief 强命中也不许合并：否定结论优先于启发式 */
    const res = await resolvePersonIdentity('雷军', 'auto', '小米创始人')
    eq(res.personKey, '雷军#auto')
    eq(res.merge, undefined, '用户说过不是这位，就不该再弹确认')
  })

  it('别名指向的行已不存在 ⇒ 别名失效，退回入参 key（不能把用户送到空报告）', async () => {
    const { load } = fresh()
    const { resolvePersonIdentity } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech')])
    env.db.__seed('person_alias', [
      { _id: '雷军#auto', alias: '雷军#auto', personKey: '雷军#game', name: '雷军', domain: 'auto' }
    ])

    eq((await resolvePersonIdentity('雷军', 'auto')).personKey, '雷军#auto')
  })

  it('领域同组优先于一切：别名是另一份也不改变「同领域就是同一人」', async () => {
    const { load } = fresh()
    const { resolvePersonIdentity } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech')])
    env.db.__seed('person_alias', [
      { _id: '雷军#科技', alias: '雷军#科技', personKey: '雷军#other', name: '雷军', domain: '科技' }
    ])

    eq((await resolvePersonIdentity('雷军', '科技')).personKey, '雷军#tech')
  })
})

describe('confirm / reject：同名才能合并，结论落库后跨设备生效', () => {
  it('confirmPersonMerge 拒绝跨名字的 targetKey（一次误写就把张三送到李四的报告上）', async () => {
    const { load } = fresh()
    const { confirmPersonMerge } = load('utils/person-index')
    eq(await confirmPersonMerge('雷军', 'auto', '张三#tech'), false)
    eq(await confirmPersonMerge('雷军', 'auto', '雷军#auto'), false, '指向自己等于没合并')
  })

  it('confirmPersonMerge 写 person_alias，且立刻生效（接下来的解析不再查库）', async () => {
    const { load } = fresh()
    const { confirmPersonMerge, resolvePersonIdentity } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech'), rowOf('雷军', 'auto', {})])

    eq(await confirmPersonMerge('雷军', 'auto', '雷军#tech', '小米集团创始人'), true)
    const rows = env.db.__dump('person_alias')
    eq(rows.length, 1)
    eq(rows[0].personKey, '雷军#tech', '落库的是「这个名字+领域 → 已有那份」')
    eq(rows[0].headline, '小米集团创始人', '身份摘要一起存下来，提示文案不必再读报告')

    const before = env.db.stats.getCalls
    const res = await resolvePersonIdentity('雷军', 'auto')
    eq(res.personKey, '雷军#tech')
    eq(env.db.stats.getCalls, before, '确认后走内存索引，不该再查库')
  })

  it('rejectPersonMerge 落空串：此后解析直接走入参 key，不再合并也不再问', async () => {
    const { load } = fresh()
    const { rejectPersonMerge, resolvePersonIdentity } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech')])

    eq(await rejectPersonMerge('雷军', 'auto'), true)
    const rows = env.db.__dump('person_alias')
    eq(rows[0].personKey, '', '空串 = 用户确认「不是同一位」')

    const res = await resolvePersonIdentity('雷军', 'auto')
    eq(res.personKey, '雷军#auto')
    eq(res.merge, undefined)
  })
})

describe('别名表读不到（未建表 / 权限未生效）也不能影响主流程', () => {
  it('person_alias 读失败 ⇒ 当没有别名，继续按领域 / brief 判（端上零阻塞）', async () => {
    const { load } = fresh()
    const { resolvePersonIdentity } = load('utils/person-index')
    env.db.__seed('report_cache', [rowOf('雷军', 'tech')])
    env.db.__setReadFailing('person_alias', true)

    /* 断言里不再留 `ok(true, '没有抛错就已经是结论')`：那是零信息量（2026-10-18 复审 P2）。
       「不抛错」由这一行本身证明（抛了就不会走到这里），真正要钉的是**降级结果**：
       key 原样退回、且不给出 merge 建议（否则界面会对一次读失败弹「是同一位吗？」）。 */
    const res = await resolvePersonIdentity('雷军', 'auto')
    eq(res.personKey, '雷军#auto', '读不到 ≠ 合并，退回入参 key')
    eq(res.merge, undefined, '读失败不得给出合并建议（否则会弹一次莫名其妙的确认）')
  })
})
