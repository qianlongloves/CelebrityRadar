'use strict'

/**
 * R1（`utils/report.ts#sanitizeReport`）落库口径的六处收紧（2026-10-17）。
 *
 * R1 是「模型输出 → 共享缓存」的唯一闸门，它写下的每个字段都是全站可读的（`report_cache`
 * 全局一份），所以这里逐条钉住六个**曾经不一致**的地方：
 *
 *   ① 时间线日期先归一成 ISO 再落库 —— 端上按**字符串**排序，混合写法会按「格式」排；
 *   ② `dynamics.date` 此前是唯一连 `cleanText` 都没过的字段；
 *   ③ `dynamics.source` 命中素材时一律取素材的媒体名（出处与链接必须同源）；
 *   ④ `factDropped` 把会员段 `affiliations` 也算进「事实字段被剔除」；
 *   ⑤ 判断类裁剪线（stance / verdict / reputation / consistency）走 `config/benefits.ts`；
 *   ⑥ `knowledgeOnly` 兜底真的从 R1 的出口落地（此前那段让渡逻辑没有调用点）。
 *
 * 每条都配一个**正向对照**：静态断言证明「以前那样写」，动态断言证明「现在是怎样」。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')

/** 剥注释：本文件大量「此前是什么、为什么改」的说明会被静态断言当成现状（70 / 74 / 75 同理） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const REPORT_SRC = stripComments(fs.readFileSync(path.join(SRC, 'utils', 'report.ts'), 'utf8'))

function fresh() {
  env.resetAll()
  return env
}

const item = (over = {}) =>
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

/** 只跑 R1：不经过模型，直接喂 llm 形状与素材 */
const sanitize = (llm, news = [], opts) => {
  const e = fresh()
  return e.load('utils/report').sanitizeReport('k', '甲', llm, news, 'all', opts)
}

/* ═════════════ ① 时间线日期归一 ═════════════ */

describe('R1：时间线日期归一（端上按字符串排序，写法必须统一）', () => {
  it('中文 / 斜杠 / 带时分 / 只有年月 —— 四种写法都收敛成 ISO', () => {
    const r = sanitize({
      timeline: [
        { date: '2026年10月11日', event: '甲' },
        { date: '2026/3/5', event: '乙' },
        { date: '2026-10-11T09:30', event: '丙' },
        { date: '2026年10月', event: '丁' }
      ]
    })
    deepEq(
      r.timeline.map((t) => t.date),
      ['2026-10-11', '2026-03-05', '2026-10-11', '2026-10'],
      '能认出年月日就必须**重拼**成 ISO，而不是照旧按 10 簇硬裁'
    )
    /* 这条是上面断言的前提：中文日期确实超过 timelineDateChars(10) ——
       若哪天它不再超长，本用例就测不到「裁出错日期」这件事了 */
    ok('2026年10月11日'.length > 10, '前提：中文日期的字数超过 timelineDateChars(10)')
  })

  it('认不出的日期不整条剔除（日期只是刻度），仍按真源上限裁', () => {
    const LIMITS = fresh().load('config/benefits').REPORT_FIELD_LIMITS
    const r = sanitize({ timeline: [{ date: '去年年底那场发布会之后', event: '甲' }] })
    eq(r.timeline.length, 1, '日期认不出也要保留事件 —— 剔掉等于丢一条事实')
    eq(r.timeline[0].date.length, LIMITS.timelineDateChars, '兜底路径走 clipText，长度等于真源上限')
  })

  it('归一的收益：ISO 与中文写法在同一份报告里也不会把年份排错', () => {
    const r = sanitize({
      timeline: [
        { date: '2026年3月1日', event: '甲' },
        { date: '2025-12-31', event: '乙' }
      ]
    })
    const dates = r.timeline.map((t) => t.date)
    /* 端上的 timelineGroups（按前 4 位切年份）与排序都吃这个字符串 */
    deepEq([...dates].sort((a, b) => a.localeCompare(b)), ['2025-12-31', '2026-03-01'])
    ok(dates.every((d) => /^\d{4}-\d{2}(-\d{2})?$/.test(d)), '落库的日期必须是 ISO 形状')
  })
})

/* ═════════════ ②③ dynamics 的 date 与 source ═════════════ */

describe('R1：dynamics 的 date 与 source', () => {
  it('date 也过净化：零宽被清掉（此前是唯一原样落库的字段）', () => {
    const src = item()
    const r = sanitize(
      {
        dynamics: [
          { date: '2026-10-11\u200b', title: 't', summary: 's', source: '媒体A', url: src.url }
        ]
      },
      [src]
    )
    eq(r.dynamics[0].date, '2026-10-11', '零宽字符肉眼看不见，却会让「同一天」的排序抖动')
  })

  it('date 超长按 dynamicsDateChars 裁（比 timeline 的 10 字宽，允许带时分）', () => {
    const LIMITS = fresh().load('config/benefits').REPORT_FIELD_LIMITS
    const src = item()
    const r = sanitize(
      {
        dynamics: [
          { date: '2026-10-11 09:30:00.123456789', title: 't', summary: 's', url: src.url }
        ]
      },
      [src]
    )
    ok(
      r.dynamics[0].date.length <= LIMITS.dynamicsDateChars,
      `应裁到 ${LIMITS.dynamicsDateChars}，实际 ${r.dynamics[0].date.length}`
    )
    ok(LIMITS.dynamicsDateChars > LIMITS.timelineDateChars, '前提：动态允许带时分，上限必须比时间线宽')
  })

  it('source 命中素材时一律取素材的媒体名（出处与链接同源）', () => {
    const src = item({ source: '网易娱乐' })
    const r = sanitize(
      {
        dynamics: [
          { date: '2026-10-11', title: 't', summary: 's', source: '新浪娱乐', url: src.url }
        ]
      },
      [src]
    )
    eq(
      r.dynamics[0].source,
      '网易娱乐',
      'url 已强制取素材原串，source 再听模型的就会出现「出处写新浪、点开是网易」'
    )
    eq(r.dynamics[0].url, 'https://example.com/a')
  })

  it('正向对照：无素材兜底时没有可对的素材，才用模型自述', () => {
    const r = sanitize(
      {
        dynamics: [
          {
            date: '2026-10-11',
            title: 't',
            summary: 's',
            source: '新浪娱乐',
            url: 'https://nowhere.example/x'
          }
        ]
      },
      [],
      { knowledgeOnly: true }
    )
    eq(r.dynamics[0].source, '新浪娱乐', '没有可对的素材时才退回模型自述')
    eq(r.dynamics[0].url, '', '指不出素材就不可点开')
  })
})

/* ═════════════ ④ factDropped 计入 affiliations ═════════════ */

describe('R1：事实字段剔除计数覆盖会员段 affiliations', () => {
  it('亲和来源（静态：它只进日志，没有可断言的返回值）', () => {
    ok(
      /\(llm\.affiliations\?\.length \?\? 0\) - affiliations\.length/.test(REPORT_SRC),
      'affiliations 与 relations / endorsements 走同一道 factSourceOf 闸门，剔除却不计数 ⇒ 会员档 warn 少报'
    )
  })
})

/* ═════════════ ⑤ 判断类裁剪线走真源 ═════════════ */

describe('R1：判断类裁剪线走 config/benefits.ts（不是裸数字）', () => {
  it('stance / verdict / reputation / consistency 的长文本都裁到真源给出的上限', () => {
    const LIMITS = fresh().load('config/benefits').REPORT_FIELD_LIMITS
    const LONG = '很长的说明'.repeat(30)
    const r = sanitize({
      stance: [{ topic: '演技', attitude: 'positive', note: LONG }],
      verdict: { summary: LONG, positioning: LONG },
      reputation: { positive: LONG, negative: LONG },
      consistency: { claim: LONG, act: LONG, gap: LONG }
    })
    eq(r.stance[0].note.length, LIMITS.stanceNoteChars, 'stance.note 的裁剪线')
    eq(r.verdict.summary.length, LIMITS.verdictChars, 'verdict.summary 的裁剪线')
    eq(r.verdict.positioning.length, LIMITS.verdictChars, 'verdict.positioning 的裁剪线')
    eq(r.reputation.positive.length, LIMITS.reputationChars, 'reputation.positive 的裁剪线')
    eq(r.reputation.negative.length, LIMITS.reputationChars, 'reputation.negative 的裁剪线')
    eq(r.consistency.claim.length, LIMITS.consistencyChars, 'consistency.claim 的裁剪线')
    eq(r.consistency.act.length, LIMITS.consistencyChars, 'consistency.act 的裁剪线')
    eq(r.consistency.gap.length, LIMITS.consistencyChars, 'consistency.gap 的裁剪线')
  })

  it('stance 条数上限取 REPORT_QUOTAS.stanceMax（此前端上是裸的 4）', () => {
    const QUOTAS = fresh().load('config/benefits').REPORT_QUOTAS
    const many = Array.from({ length: QUOTAS.stanceMax + 3 }, (_, i) => ({
      topic: `话题${i}`,
      attitude: 'positive',
      note: 'x'
    }))
    eq(sanitize({ stance: many }).stance.length, QUOTAS.stanceMax)
  })

  it('静态：这四处不许再出现裸数字（否则改提示词那侧调不到裁剪线）', () => {
    notOk(/clipText\(s\.note, \d+\)/.test(REPORT_SRC), 'stance.note 必须走 STANCE_NOTE_CHARS')
    notOk(/clipText\(verdictRaw\?\.\w+, \d+\)/.test(REPORT_SRC), 'verdict 必须走 VERDICT_CHARS')
    notOk(/clipText\(reputationRaw\?\.\w+, \d+\)/.test(REPORT_SRC), 'reputation 必须走 REPUTATION_CHARS')
    notOk(/clipText\(consistencyRaw\?\.\w+, \d+\)/.test(REPORT_SRC), 'consistency 必须走 CONSISTENCY_CHARS')
    notOk(/\.slice\(0, \d+\)/.test(REPORT_SRC), '条数上限一律走 REPORT_QUOTAS / REPORT_FIELD_LIMITS 的常量')
  })
})

/* ═════════════ ⑥ knowledgeOnly 兜底从 R1 出口落地 ═════════════ */

describe('R1：knowledgeOnly 兜底真的从 R1 的出口落地', () => {
  it('兜底报告带标记、五段空数组不落键、热度与画像全零', () => {
    const r = sanitize({ intro: '他是演员' }, [], { knowledgeOnly: true })
    eq(r.knowledgeOnly, true, '兜底标记必须跟着出口落地，否则 shortfallVerdict 的专门文案会丢')
    eq(r.intro, '他是演员')
    eq(r.heat, 0, '没有素材就没有热度')
    eq(r.coverage.items, 0, '素材一条都没有：画像如实给 0（页面据此说「本次未检索到素材」）')
    for (const key of ['profile', 'relations', 'endorsements', 'glossary', 'controversies']) {
      notOk(key in r, `${key} 不该落空数组：兜底压根没检索素材，「本次确实没有」这句话没有根据`)
    }
  })

  it('正向对照：正常路径仍是「空数组 = 本次确实没有」，且不带兜底标记', () => {
    const r = sanitize({ intro: 'x' }, [item()])
    for (const key of ['profile', 'relations', 'endorsements', 'glossary', 'controversies']) {
      deepEq(r[key], [], `${key} 在正常路径必须落空数组`)
    }
    eq(r.knowledgeOnly, undefined, '正常报告不许带兜底标记')
  })

  it('buildKnowledgeFallback 也从 R1 出来（不再是自己拼一份 Report）', async () => {
    const e = fresh()
    e.registerCloudFn('aiProxy', () => ({
      ok: true,
      content: JSON.stringify({ intro: '  林某，演员。\u200b  ' })
    }))
    const res = await e.load('utils/report').buildKnowledgeFallback('k', '甲', 'all')
    ok(res.ok, `兜底应成功，实际 ${JSON.stringify(res)}`)
    eq(res.data.knowledgeOnly, true, '兜底标记必须在')
    eq(res.data.intro, '林某，演员。', '过 R1 的收益之一：intro 也走 cleanText（零宽 / 两端空白）')
    notOk('profile' in res.data, '兜底报告不该出现「本次确实没有」的空数组')
    eq(res.data.heat, 0)
    eq(res.data.coverage.items, 0)
  })

  it('空 intro 仍然交回上层走空态（判据与落库用同一把尺子）', async () => {
    const e = fresh()
    e.registerCloudFn('aiProxy', () => ({
      ok: true,
      content: JSON.stringify({ intro: '\u200b  ' })
    }))
    const res = await e.load('utils/report').buildKnowledgeFallback('k', '甲', 'all')
    eq(res.ok, false, '只有零宽字符的 intro 与空串同义，必须判空')
    ok(/没有可用的既有资料/.test(res.error || ''), '文案要说明「模型没把握」，不是网络失败')
  })
})
