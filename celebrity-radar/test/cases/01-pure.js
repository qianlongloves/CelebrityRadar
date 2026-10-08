'use strict'

/** 纯逻辑层：时间 / 敏感词 / 领域键 / 筛选 / 词云 / 数据聚合 / 两人对比 */

const dayjs = require('dayjs')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

/* ------------------------------------------------------------------ 造数 */

/** 最小可用报告（只放被聚合函数读到的字段） */
function mkReport(over = {}) {
  return Object.assign(
    {
      personKey: '测试人物#tech',
      name: '测试人物',
      heat: 60,
      generatedAt: '2026-10-07T10:00:00.000Z',
      summary: '',
      analysis: '',
      dynamics: [],
      quotes: [],
      timeline: [],
      stance: [],
      degraded: false
    },
    over
  )
}

function dyn(over = {}) {
  return Object.assign(
    { title: '', summary: '', source: '', url: '', date: '', sentiment: 'neutral' },
    over
  )
}

/* ------------------------------------------------------------------ 用例 */

describe('时间工具 utils/time', () => {
  const time = env.load('utils/time')

  it('todayKey 是本地时区的 yyyy-MM-dd（配额主键口径）', () => {
    eq(time.todayKey(), dayjs().format('YYYY-MM-DD'))
    ok(/^\d{4}-\d{2}-\d{2}$/.test(time.todayKey()))
  })

  it('currentWeekKey 是 ISO 周标识 yyyy-Www', () => {
    ok(/^\d{4}-W\d{2}$/.test(time.currentWeekKey()), `实际 ${time.currentWeekKey()}`)
    eq(time.currentWeekKey(), `${dayjs().isoWeekYear()}-W${String(dayjs().isoWeek()).padStart(2, '0')}`)
  })

  it('currentWeekStart 落在周一且不晚于现在', () => {
    const start = dayjs(time.currentWeekStart())
    eq(start.day(), 1, 'ISO 周起点应为周一')
    ok(start.valueOf() <= Date.now(), '周起点不应在未来')
    ok(Date.now() - start.valueOf() < 7 * 864e5, '周起点不应早于 7 天前')
  })

  it('last7DayRange 覆盖 7 个自然日，且 since/until 有序', () => {
    const r = time.last7DayRange()
    const since = dayjs(r.since)
    const until = dayjs(r.until)
    ok(since.valueOf() <= until.valueOf())
    eq(until.diff(since, 'day'), 6, 'since 与 until 相差 6 天 = 含首尾共 7 天')
    eq(r.label, `${since.format('YYYY-MM-DD')} ~ ${until.format('YYYY-MM-DD')}`)
  })

  it('last7DayRange(days) 支持自定义窗口', () => {
    const r = time.last7DayRange(3)
    eq(dayjs(r.until).diff(dayjs(r.since), 'day'), 2)
  })

  it('报告年龄 reportAgeDays：按自然日向下取整，时间缺失 / 不可解析返回 -1', () => {
    const day = 86400000
    eq(time.reportAgeDays(new Date(Date.now() - 3 * day).toISOString()), 3)
    eq(time.reportAgeDays(new Date(Date.now() - 20 * day).toISOString()), 20)
    eq(time.reportAgeDays(), -1, '没有生成时间 = 未知')
    eq(time.reportAgeDays(null), -1)
    eq(time.reportAgeDays(''), -1)
    eq(time.reportAgeDays('不是日期'), -1)
  })

  it('陈旧判定 isStaleReport：阈值 14 天一处定义，未知生成时间不算陈旧', () => {
    const day = 86400000
    eq(time.STALE_REPORT_DAYS, 14, '阈值只应有一处（问答头部 / 报告页 / 收藏卡 / 历史页共用）')
    eq(time.isStaleReport(new Date(Date.now() - 13 * day).toISOString()), false)
    eq(time.isStaleReport(new Date(Date.now() - 14 * day).toISOString()), true, '满 14 天即为陈旧')
    eq(time.isStaleReport(new Date(Date.now() - 30 * day).toISOString()), true)
    eq(time.isStaleReport(undefined), false, '不知道什么时候生成的，不应提示「建议刷新」')
    eq(time.isStaleReport('坏时间'), false)
    eq(
      time.isStaleReport(new Date(Date.now() - 3 * day).toISOString(), 2),
      true,
      '阈值可覆盖（旧调用点手写过别的策略）'
    )
  })

  it('formatDay / formatDate 输出稳定格式', () => {
    eq(time.formatDay('2026-10-07T10:00:00.000Z'), dayjs('2026-10-07T10:00:00.000Z').format('YYYY-MM-DD'))
    eq(time.formatDate('2026-10-07T10:00:00.000Z'), dayjs('2026-10-07T10:00:00.000Z').format('YYYY-MM-DD HH:mm'))
  })
})

describe('敏感词一级拦截 utils/sensitive', () => {
  const { isSensitiveQuery } = env.load('utils/sensitive')

  it('空串 / 纯空白不拦（避免把所有空查询都判成违规）', () => {
    notOk(isSensitiveQuery(''))
    notOk(isSensitiveQuery('   '))
    notOk(isSensitiveQuery('\n\t'))
  })

  it('普通名人查询放行', () => {
    notOk(isSensitiveQuery('马斯克'))
    notOk(isSensitiveQuery('雷军 造车'))
    notOk(isSensitiveQuery('泰勒·斯威夫特'))
  })

  it('命中涉政涉军关键词即拦', () => {
    ok(isSensitiveQuery('某国总统'))
    ok(isSensitiveQuery('军队'))
    ok(isSensitiveQuery('国防'))
    ok(isSensitiveQuery('司令'))
  })

  it('前后空白不能绕过拦截', () => {
    ok(isSensitiveQuery('  总统  '))
    ok(isSensitiveQuery('\t主席\n'))
  })
})

describe('领域码与 personKey utils/domains', () => {
  const d = env.load('config/domains')

  it('buildPersonKey / parsePersonKey 可往返', () => {
    for (const code of d.DOMAIN_CODES) {
      const key = d.buildPersonKey('张三', code)
      eq(key, `张三#${code}`)
      deepEq(d.parsePersonKey(key), { name: '张三', domain: code })
    }
  })

  it('名字里含 # 时仍能正确解析（用 lastIndexOf）', () => {
    const key = d.buildPersonKey('A#B', 'ent')
    eq(key, 'A#B#ent')
    deepEq(d.parsePersonKey(key), { name: 'A#B', domain: 'ent' })
  })

  it('非法输入返回 null 而不是抛错', () => {
    eq(d.parsePersonKey('没有井号'), null)
    eq(d.parsePersonKey('#tech'), null)
    eq(d.parsePersonKey('张三#'), null)
    eq(d.parsePersonKey('张三#不存在'), null)
    eq(d.parsePersonKey(''), null)
  })

  it('isDomainCode 只认枚举内取值', () => {
    ok(d.isDomainCode('tech'))
    ok(d.isDomainCode('other'))
    notOk(d.isDomainCode('TECH'))
    notOk(d.isDomainCode('全部'))
    eq(d.DOMAIN_CODES.length, 12)
  })

  it('每个领域码都有中文标签', () => {
    for (const code of d.DOMAIN_CODES) {
      ok(d.DOMAIN_META[code] && d.DOMAIN_META[code].label, `${code} 缺 label`)
    }
  })

  it('标签互不重复（两个领域同名会让人分不清筛选结果）', () => {
    const labels = d.DOMAIN_CODES.map((c) => d.DOMAIN_META[c].label)
    eq(new Set(labels).size, labels.length)
  })

  it('种子池覆盖全部领域码（否则种子兜底时按该领域筛选是空列表）', () => {
    const hot = env.load('config/hot')
    for (const code of d.DOMAIN_CODES) {
      ok(hot.HOT_PERSONS.some((p) => p.domain === code), `${code} 在 config/hot.ts 里没有任何一位种子`)
    }
  })
})

describe('发现页筛选条件 config/filters', () => {
  const f = env.load('config/filters')

  it('isFocusCode 只认四个关注方向', () => {
    for (const c of f.FOCUS_CODES) ok(f.isFocusCode(c))
    notOk(f.isFocusCode('foo'))
    notOk(f.isFocusCode(''))
  })

  it('条件摘要文案符合「行业 · 侧重」格式', () => {
    eq(f.summarizeFilters('all', 'all'), '全部行业 · 六段完整')
    eq(f.summarizeFilters('tech', 'dynamics'), '科技 · 侧重动态')
    eq(f.summarizeFilters('ent', 'quotes'), '文娱 · 侧重言论')
    eq(f.summarizeFilters('sports', 'timeline'), '体育 · 侧重履历')
  })

  it('行业筛选项 = 全部 + 12 个领域码', () => {
    eq(f.DOMAIN_FILTER_CODES.length, 13)
    eq(f.DOMAIN_FILTER_CODES[0], 'all')
    eq(f.domainFilterLabel('all'), '全部')
    eq(f.domainFilterLabel('academia'), '学术')
    eq(f.domainFilterLabel('edu'), '教育')
  })
})

describe('关键词云 utils/keywords', () => {
  const { extractKeywords } = env.load('utils/keywords')

  const duplicated = mkReport({
    name: '雷军',
    dynamics: [
      dyn({ title: '小米发布新一代旗舰手机', summary: '新品定价公布' }),
      dyn({ title: '小米旗舰手机销量领先', summary: '旗舰手机持续爬坡' }),
      dyn({ title: '雷军谈造车', summary: '造车业务稳步推进' })
    ],
    quotes: [{ text: '旗舰手机是我们最看重的产品', context: '发布会' }],
    stance: [{ topic: '造车', attitude: 'positive', note: '多次公开提及' }]
  })

  it('素材为空时返回空数组（宁可不摆，也不摆碎片）', () => {
    deepEq(extractKeywords(mkReport()), [])
  })

  it('只有分析文字（二手表述）时不产生词云', () => {
    deepEq(extractKeywords(mkReport({ analysis: '旗舰手机销量领先，造车稳步推进' })), [])
  })

  it('统计口径要求至少 2 条不同素材命中（模型判定的话题按设计豁免）', () => {
    const out = extractKeywords(duplicated)
    ok(out.length > 0, '应有候选词')
    for (const k of out) {
      if (k.from === 'topic') continue
      ok(k.count >= 2, `${k.word} 命中数 ${k.count} 小于 2`)
    }
  })

  it('每条词最多 2 条佐证原文', () => {
    for (const k of extractKeywords(duplicated)) ok(k.refs.length <= 2, `${k.word} 佐证过多`)
  })

  it('人物名不进词云（通篇都在讲 TA，会挤掉主题词）', () => {
    for (const k of extractKeywords(duplicated)) notOk(k.word.includes('雷军'), `词云出现人名：${k.word}`)
  })

  it('人名碎片也不进词云（搜「陈佩斯」不该出现「陈佩」「佩斯」）', () => {
    /* 造数据复现真实现象：动态标题几乎条条以人名开头，2-gram 碎片因此命中数极高 */
    const report = mkReport({
      name: '陈佩斯',
      dynamics: [
        dyn({ title: '陈佩斯新作定档', summary: '陈佩斯主演的舞台剧公布档期' }),
        dyn({ title: '陈佩斯谈喜剧创作', summary: '陈佩斯认为喜剧要贴着生活' }),
        dyn({ title: '陈佩斯出席活动', summary: '陈佩斯与观众合影' })
      ],
      quotes: [{ text: '陈佩斯说要慢下来', context: '采访' }]
    })
    const out = extractKeywords(report)
    for (const k of out) {
      notOk(k.word.includes('陈佩') || k.word.includes('佩斯'), `词云出现人名碎片：${k.word}`)
      notOk('陈佩斯'.includes(k.word), `词云出现人名局部：${k.word}`)
    }
  })

  it('话题恰好是人名（或人名局部）时同样不进词云', () => {
    const report = mkReport({
      name: '陈佩斯',
      dynamics: [dyn({ title: '陈佩斯新作定档', summary: '舞台剧公布档期' })],
      stance: [
        { topic: '陈佩斯', attitude: 'neutral', note: '报告主角' },
        { topic: '佩斯', attitude: 'neutral', note: '半截名字' }
      ]
    })
    const out = extractKeywords(report)
    for (const k of out) notOk('陈佩斯'.includes(k.word), `词云出现人名局部：${k.word}`)
  })

  it('模型判定的话题进入词云且标记 from=topic、字号不为最小档', () => {
    const out = extractKeywords(duplicated)
    const topic = out.find((k) => k.word === '造车')
    ok(topic, '话题「造车」应在词云里')
    eq(topic.from, 'topic')
    notOk(topic.tier === 1, '话题至少中档')
  })

  it('字号档位只在 1/2/3，且结果按权重降序、不超过 limit', () => {
    const out = extractKeywords(duplicated, { limit: 3 })
    ok(out.length <= 3)
    for (const k of out) ok([1, 2, 3].includes(k.tier), `非法档位 ${k.tier}`)
    const score = (k) => k.count + (k.from === 'topic' ? 1 : 0)
    for (let i = 1; i < out.length; i++) ok(score(out[i - 1]) >= score(out[i]), '未按权重降序')
  })

  it('同一说法不再重复出现（长短两版只留一条）', () => {
    const out = extractKeywords(duplicated)
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i].word
        const b = out[j].word
        const overlapped = a.includes(b) || b.includes(a)
        if (overlapped) {
          ok(
            out[i].from === 'topic' || out[j].from === 'topic',
            `重叠词同时出现且都不是话题：${a} / ${b}`
          )
        }
      }
    }
  })
})

describe('语录主题 utils/keywords', () => {
  const { extractQuoteThemes } = env.load('utils/keywords')

  const q = (text, context = '采访') => ({ text, context })

  it('语录少于 4 条不聚类（两三句本就能一眼看完）', () => {
    const few = mkReport({ quotes: [q('慢下来才能看清'), q('慢下来才有味道'), q('慢下来是种选择')] })
    deepEq(extractQuoteThemes(few), [])
  })

  it('按语录原文的高频说法归成两组，且每条语录只归一个主题', () => {
    const report = mkReport({
      quotes: [
        q('喜剧要贴着生活', '访谈'),
        q('喜剧最怕脱离生活', '论坛'),
        q('资本进来之后创作就变味了', '专访'),
        q('资本不该决定创作', '圆桌')
      ]
    })
    const themes = extractQuoteThemes(report)
    eq(themes.length, 2, '两组话题')
    const topics = themes.map((t) => t.topic).join(',')
    ok(topics.includes('喜剧'), `主题词应来自语录原文，实得 ${topics}`)
    ok(topics.includes('资本'), `主题词应来自语录原文，实得 ${topics}`)
    /* 互斥归类：各主题条数之和不超过语录总数，且同一句不会出现在两个主题里 */
    ok(
      themes.reduce((n, t) => n + t.count, 0) <= report.quotes.length,
      '归一后条数不该超过语录总数'
    )
    const seen = new Set()
    for (const t of themes) {
      ok(t.count >= 2, `主题「${t.topic}」至少 2 条才成立`)
      ok(t.quotes.length <= 2, '代表语录最多 2 条')
      for (const text of t.quotes) notOk(seen.has(text), `语录重复归入两个主题：${text}`)
      for (const text of t.quotes) seen.add(text)
    }
  })

  it('主题词长版与截断碎片只留一条（不出现「喜剧创作」与「剧创作」并列）', () => {
    const report = mkReport({
      quotes: [
        q('喜剧创作要贴着生活'),
        q('喜剧创作最怕脱离生活'),
        q('喜剧创作得慢下来'),
        q('喜剧创作不是讨好观众')
      ]
    })
    const themes = extractQuoteThemes(report)
    for (let i = 0; i < themes.length; i++) {
      for (let j = i + 1; j < themes.length; j++) {
        const a = themes[i].topic
        const b = themes[j].topic
        notOk(a.includes(b) || b.includes(a), `主题词互为子串：${a} / ${b}`)
      }
    }
  })

  it('主题不足 2 个时返回空数组（只有一个「主题」等于没有分类）', () => {
    const report = mkReport({
      quotes: [q('喜剧要贴着生活'), q('喜剧创作不是讨好'), q('他最近在读历史'), q('他喜欢安静的地方')]
    })
    deepEq(extractQuoteThemes(report), [])
  })

  it('人名碎片不当主题词', () => {
    const report = mkReport({
      name: '陈佩斯',
      quotes: [
        q('陈佩斯说喜剧要贴着生活'),
        q('陈佩斯认为喜剧最怕脱离生活'),
        q('陈佩斯：喜剧创作得慢下来'),
        q('陈佩斯谈喜剧创作不是讨好')
      ]
    })
    for (const t of extractQuoteThemes(report)) {
      notOk(t.topic.includes('陈佩') || t.topic.includes('佩斯'), `主题词出现人名碎片：${t.topic}`)
    }
  })
})

describe('热度趋势 utils/trend', () => {
  const { buildHeatTrend } = env.load('utils/trend')

  /* 造数：基准日固定，只改动态日期 */
  const at = (dates, extra = {}) =>
    mkReport(
      Object.assign(
        {
          generatedAt: '2026-10-08T10:00:00.000Z',
          dynamics: dates.map((d) => dyn({ date: d, title: `事件 ${d}` }))
        },
        extra
      )
    )

  it('30 天内够 3 条就用 30 天窗口、6 个桶（窗口起止与生成日对齐）', () => {
    const t = buildHeatTrend(at(['2026-09-20', '2026-10-01', '2026-10-07']))
    ok(t, '应出折线')
    eq(t.windowDays, 30)
    eq(t.points.length, 6)
    eq(t.total, 3)
    eq(t.from, '2026-09-09')
    eq(t.to, '2026-10-08')
    eq(t.peak, 1)
    for (const p of t.points) ok(p.ratio >= 0 && p.ratio <= 1, 'ratio 越界')
    for (let i = 1; i < t.points.length; i++) ok(t.points[i].x > t.points[i - 1].x, 'x 未递增')
  })

  it('30 天不够就按阶梯放宽窗口，而不是整卡消失', () => {
    /* 全都落在 30 天外、60 天内只够 2 条，90 天内才够 3 条 */
    const t = buildHeatTrend(at(['2026-07-20', '2026-08-15', '2026-08-20']))
    ok(t, '稀疏报告仍应出折线')
    eq(t.windowDays, 90, '应放宽到 90 天')
    eq(t.total, 3)
    eq(t.from, '2026-07-11')
    eq(t.points.length, 6, '桶数不随窗口变化')
  })

  it('显式给 opts.days 时只认这一个窗口、不再放宽', () => {
    eq(buildHeatTrend(at(['2026-07-20', '2026-08-15', '2026-08-20']), { days: 30 }), null)
    const t = buildHeatTrend(at(['2026-07-20', '2026-08-15', '2026-08-20']), { days: 90 })
    ok(t)
    eq(t.windowDays, 90)
  })

  it('超出 180 天上限的条目不再救场（履历类节点不该混进近期热度）', () => {
    eq(buildHeatTrend(at(['2025-01-01', '2025-02-01', '2025-03-01'])), null)
  })

  it('只有 2 条或更少时不出折线（两个点连不成趋势）', () => {
    eq(buildHeatTrend(at(['2026-10-01', '2026-10-02'])), null)
    eq(buildHeatTrend(mkReport()), null)
  })

  it('日期形态放宽到中文与斜杠点号，但「只到月份」「只有月日」仍不解析', () => {
    const t = buildHeatTrend(at(['2026年10月1日', '2026/09/25', '2026.09.20']))
    ok(t, '三种写法都应被认出来')
    eq(t.total, 3)
    eq(t.windowDays, 30)
    /* 「宁可不摆也不猜」：缺年或缺日的写法一律丢弃，因此这 3 条里只剩 2 条 → 不出卡 */
    eq(buildHeatTrend(at(['2026-09', '9月8日', '2026-10-01', '2026-10-02'])), null)
  })

  it('同一天同一种说法只算一条（跨动态与时间线也去重），时间线单独也能撑起这张卡', () => {
    const t = buildHeatTrend(
      mkReport({
        generatedAt: '2026-10-08T10:00:00.000Z',
        dynamics: [
          dyn({ date: '2026-09-20', title: '同一件事' }),
          dyn({ date: '2026-09-20', title: '同一件事' }),
          dyn({ date: '2026-10-01', title: '另一件事' })
        ],
        timeline: [
          { date: '2026-09-20', event: '同一件事' },
          { date: '2026-10-07', event: '履历节点' }
        ]
      })
    )
    ok(t, '应出折线')
    eq(t.total, 3, '同日同说法的重复条目只算一条')
    eq(t.spanDays, 18)
    eq(t.peak, 1, '三条落在三个不同的桶')

    const onlyTimeline = buildHeatTrend(
      mkReport({
        generatedAt: '2026-10-08T10:00:00.000Z',
        timeline: [
          { date: '2026-09-20', event: '甲' },
          { date: '2026-10-01', event: '乙' },
          { date: '2026-10-07', event: '丙' }
        ]
      })
    )
    ok(onlyTimeline, '只有时间线时也该出卡')
    eq(onlyTimeline.total, 3)
  })
})

describe('名人主页数据聚合 utils/stats', () => {
  const { buildProfileStats } = env.load('utils/stats')

  const report = mkReport({
    generatedAt: '2026-10-07T10:00:00.000Z',
    heat: 72,
    coverage: { items: 21, recent: 6, firstAt: '2026-08-01T08:00:00.000Z', latestAt: '2026-10-06T08:00:00.000Z' },
    dynamics: [
      dyn({ title: '事件甲', source: '新浪', date: '2026-09-05', sentiment: 'positive' }),
      dyn({ title: '事件乙', source: '新浪娱乐', date: '2026-09-20', sentiment: 'negative' }),
      dyn({ title: '事件丙', source: '新浪娱乐', date: '2026-10-02' }),
      dyn({ title: '事件丁', date: '2026-11-05' })
    ],
    timeline: [{ date: '2026-08-10', event: '履历节点' }]
  })

  it('曝光度来自 coverage，日期归一为 YYYY-MM-DD', () => {
    const s = buildProfileStats(report).exposure
    eq(s.heat, 72)
    eq(s.items, 21)
    eq(s.recent, 6)
    eq(s.hasCoverage, true)
    eq(s.firstAt, '2026-08-01')
    eq(s.latestAt, '2026-10-06')
  })

  it('老报告无 coverage 时给 null 而不是 0（区分「没数据」与「数据是 0」）', () => {
    const s = buildProfileStats(mkReport({ heat: 10 })).exposure
    eq(s.items, null)
    eq(s.recent, null)
    eq(s.hasCoverage, false)
    eq(s.firstAt, null)
    eq(s.latestAt, null)
  })

  it('来源分布做子串归并（「新浪」并入「新浪娱乐」），无来源的回落入 url 主机名', () => {
    const s = buildProfileStats(report).sources
    ok(s, '应有来源分布')
    eq(s.families, 1, '两家写法应归并为一家')
    eq(s.total, 3)
    eq(s.items[0].name, '新浪娱乐')
    eq(s.items[0].count, 3)
    eq(s.items[0].ratio, 1)

    const withUrl = buildProfileStats(
      mkReport({
        dynamics: [
          dyn({ url: 'https://www.example.com/a' }),
          dyn({ url: 'https://www.example.com/b' }),
          dyn({ url: 'https://news.qq.com/c' })
        ]
      })
    ).sources
    eq(withUrl.unknown, 0)
    eq(withUrl.families, 2, 'www 前缀应被剥掉后归并')
  })

  it('可判定来源少于 3 条时不出分布卡', () => {
    const s = buildProfileStats(
      mkReport({ dynamics: [dyn({ source: 'A' }), dyn({ source: 'B' })] })
    ).sources
    eq(s, null)
  })

  it('情绪分布满足 positive + negative + neutral = total', () => {
    const s = buildProfileStats(report).sentiment
    eq(s.total, 4)
    eq(s.positive, 1)
    eq(s.negative, 1)
    eq(s.neutral, 2)
    eq(s.positive + s.negative + s.neutral, s.total)
    eq(buildProfileStats(mkReport()).sentiment, null, '无动态时不出情绪卡')
  })

  it('月度分布以报告生成月为锚、丢弃未来月份、按天去重', () => {
    const m = buildProfileStats(report).months
    ok(m, '应有月度分布')
    eq(m.from, '2026-08')
    eq(m.to, '2026-10')
    eq(m.items.length, 3)
    eq(m.total, 4, '11 月的脏数据应被丢弃')
    eq(m.peak, 2)
    for (const it of m.items) ok(it.ratio >= 0 && it.ratio <= 1)
    eq(m.items.find((x) => x.key === '2026-09').count, 2)
    /* 主页改用通用桶的 label（1~12）：key 是给人看的区间、label 是横轴刻度 */
    eq(m.items.find((x) => x.key === '2026-09').label, 9)
    eq(m.items.find((x) => x.key === '2026-08').label, 8)
  })

  it('带日期的条目不足 3 条时不出月度分布', () => {
    const m = buildProfileStats(
      mkReport({ dynamics: [dyn({ date: '2026-09-01' }), dyn({ date: '2026-09-02' })] })
    ).months
    eq(m, null)
  })

  it('逐日分布（O-16②）：与月度分布同一套分桶，换成日刻度、丢弃未来日期', () => {
    const { buildDayDistribution } = env.load('utils/stats')
    const dist = buildDayDistribution(
      '2026-10-07T10:00:00.000Z',
      [
        { date: '2026-10-07', text: '甲' },
        { date: '2026-10-05', text: '乙' },
        { date: '2026-10-05', text: '丙' },
        { date: '2026-10-10', text: '未来脏数据' }
      ],
      7
    )
    ok(dist, '应有逐日分布')
    eq(dist.from, '2026-10-05')
    eq(dist.to, '2026-10-07')
    eq(dist.items.length, 3)
    eq(dist.total, 3, '未来日期应被丢弃')
    eq(dist.peak, 2)
    eq(dist.items.find((x) => x.key === '2026-10-05').count, 2)
    eq(dist.items[0].label, 5, '刻度为日数字')
    eq(
      buildDayDistribution(
        '2026-10-07T10:00:00.000Z',
        [{ date: '2026-10-06' }, { date: '2026-10-07' }],
        7
      ),
      null,
      '带日期条目不足 3 条时不出图'
    )
  })

  it('来源 × 情绪：与来源分布共用归并，单家条数过少不单列', () => {
    const tiltReport = mkReport({
      generatedAt: '2026-10-07T10:00:00.000Z',
      dynamics: [
        dyn({ title: '甲一', source: '甲媒体', date: '2026-09-05', sentiment: 'positive' }),
        dyn({ title: '甲二', source: '甲媒体', date: '2026-09-06', sentiment: 'positive' }),
        dyn({ title: '乙一', source: '乙媒体', date: '2026-09-07', sentiment: 'negative' }),
        dyn({ title: '乙二', source: '乙媒体', date: '2026-09-08', sentiment: 'negative' }),
        /* 只有 1 条的来源不进交叉表 */
        dyn({ title: '丙一', source: '丙媒体', date: '2026-09-09', sentiment: 'positive' }),
        /* 来源判不出的条目另外计数，不混进任何一家 */
        dyn({ title: '丁一', date: '2026-09-10', sentiment: 'negative' })
      ]
    })
    const t = buildProfileStats(tiltReport).tilt
    ok(t, '两家达到门槛就该出卡')
    eq(t.items.length, 2)
    eq(t.total, 5, '来源可判定的 5 条')
    eq(t.unknown, 1, '无媒体名也无 url 的 1 条')
    eq(t.families, 3)
    eq(t.hidden, 1, '丙媒体只有 1 条，不单列')
    eq(t.hiddenFamilies, 1)
    eq(t.items.map((x) => x.name).join(','), '甲媒体,乙媒体')
    eq(t.items[0].positive, 2)
    eq(t.items[0].tilt, 1, '全正面时净值为 1')
    eq(t.items[1].negative, 2)
    eq(t.items[1].tilt, -1)
    eq(t.items[0].total, t.items[0].positive + t.items[0].neutral + t.items[0].negative)
    eq(
      buildProfileStats(tiltReport).sources.families,
      t.families,
      '来源分布与交叉卡的家数必须一致（共用同一份归并）'
    )

    /* 只有一家达到门槛时整卡不出：只列一家没有对照可言 */
    const single = buildProfileStats(
      mkReport({
        dynamics: [
          dyn({ title: '甲一', source: '甲媒体', sentiment: 'positive' }),
          dyn({ title: '甲二', source: '甲媒体', sentiment: 'positive' }),
          dyn({ title: '乙一', source: '乙媒体', sentiment: 'negative' })
        ]
      })
    ).tilt
    eq(single, null)
  })

  it('素材可信度：同一标题被多家报道算一件（转载识别），首报取最早日期', () => {
    const c = buildProfileStats(
      mkReport({
        generatedAt: '2026-10-07T10:00:00.000Z',
        dynamics: [
          dyn({ title: '同一条新闻的标题', source: '甲媒体', date: '2026-09-05', sentiment: 'positive' }),
          dyn({ title: '同一条新闻的标题', source: '乙媒体', date: '2026-09-06', sentiment: 'positive' }),
          dyn({ title: '另一件事', source: '乙媒体', date: '2026-09-20', sentiment: 'negative' }),
          dyn({ title: '第三件事', date: '2026-09-25', sentiment: 'neutral' })
        ]
      })
    ).credibility
    ok(c, '可判定来源的条目够 3 条就出卡')
    eq(c.total, 4)
    eq(c.sourced, 3)
    eq(c.families, 2)
    eq(c.events, 3, '前两条是同一件事（标题归一）')
    eq(c.shared, 1, '被 2 家报道的事件')
    eq(c.repeated, 1)
    eq(c.repeatRatio, 0.25)
    eq(c.first.date, '2026-09-05')
    eq(c.first.source, '甲媒体')
  })

  it('素材可信度：日期都不可解析时不编首报（给 null 而不是取第一条）', () => {
    const c = buildProfileStats(
      mkReport({
        dynamics: [
          dyn({ title: '甲', source: 'A' }),
          dyn({ title: '乙', source: 'B' }),
          dyn({ title: '丙', source: 'C' })
        ]
      })
    ).credibility
    ok(c)
    eq(c.first, null, '收录顺序不是时间顺序，不能拿它冒充首报')
    eq(c.events, 3)
    eq(c.repeatRatio, 0)
  })

  it('情绪走势：按月分层统计情绪，与月度分布同一套分桶规则', () => {
    const s = buildProfileStats(
      mkReport({
        generatedAt: '2026-10-07T10:00:00.000Z',
        dynamics: [
          dyn({ title: '九月甲', date: '2026-09-05', sentiment: 'positive' }),
          dyn({ title: '九月乙', date: '2026-09-20', sentiment: 'positive' }),
          dyn({ title: '十月甲', date: '2026-10-02', sentiment: 'negative' }),
          /* 未来月份是脏数据，一律丢弃（与月度分布同一规矩） */
          dyn({ title: '十一月', date: '2026-11-05', sentiment: 'positive' })
        ]
      })
    ).sentimentTrend
    ok(s, '跨两个月应出走势')
    eq(s.from, '2026-09')
    eq(s.to, '2026-10')
    eq(s.total, 3, '未来月份被丢弃')
    eq(s.items.length, 2)
    eq(s.peak, 2)
    eq(s.items[0].key, '2026-09')
    eq(s.items[0].label, 9)
    eq(s.items[0].positive, 2)
    eq(s.items[0].negative, 0)
    eq(s.items[0].ratio, 1)
    eq(s.items[1].label, 10)
    eq(s.items[1].negative, 1)
    eq(s.items[1].ratio, 0.5)
    eq(s.items.reduce((n, x) => n + x.total, 0), s.total, '各月条数之和 = 总数')
    eq(s.tilt, 1 / 3, '净倾向 (2-1)/3')

    /* 全落在一个月里不出：那只有一根柱子，是「构成」不是「走势」 */
    const oneMonth = buildProfileStats(
      mkReport({
        generatedAt: '2026-10-07T10:00:00.000Z',
        dynamics: [
          dyn({ title: '甲', date: '2026-10-01', sentiment: 'positive' }),
          dyn({ title: '乙', date: '2026-10-02', sentiment: 'negative' }),
          dyn({ title: '丙', date: '2026-10-03', sentiment: 'neutral' })
        ]
      })
    ).sentimentTrend
    eq(oneMonth, null)
  })

  it('同一份报告多次聚合结果一致（纯函数）', () => {
    deepEq(buildProfileStats(report), buildProfileStats(report))
  })
})

describe('两人对比 utils/compare', () => {
  const { buildComparison, describeComparison } = env.load('utils/compare')

  const mk = (name, key, heat, items, recent, extra = {}) =>
    mkReport(
      Object.assign(
        {
          name,
          personKey: key,
          heat,
          coverage: { items, recent, firstAt: '2026-09-01', latestAt: '2026-10-01' },
          dynamics: [dyn({ title: '事件一', sentiment: 'positive' }), dyn({ title: '事件二', sentiment: 'negative' })],
          timeline: [{ date: '2026-09-01', event: '节点' }],
          quotes: [{ text: '一句话', context: '现场' }]
        },
        extra
      )
    )

  const A = mk('马斯克', '马斯克#tech', 80, 20, 6, {
    stance: [{ topic: '智能汽车', attitude: 'positive', note: '重要布局' }]
  })
  const B = mk('雷军', '雷军#business', 70, 10, 3, {
    stance: [{ topic: '智能汽车', attitude: 'neutral', note: '近期提及' }]
  })

  it('六项对照指标齐备，且只有曝光度类给方向', () => {
    const r = buildComparison(A, B)
    eq(r.metrics.length, 6)
    const byKey = Object.fromEntries(r.metrics.map((m) => [m.key, m]))
    eq(byKey.heat.a, '80')
    eq(byKey.heat.b, '70')
    eq(byKey.heat.higher, 'a')
    eq(byKey.news.higher, 'a')
    eq(byKey.recent.higher, 'a')
    eq(byKey.dynamics.higher, null, '条数类不做优劣判断')
    eq(byKey.quotes.higher, null)
    eq(byKey.timeline.higher, null)
  })

  it('热度相同则不给方向（不给箭头）', () => {
    const r = buildComparison(mk('甲', '甲#tech', 50, 5, 2), mk('乙', '乙#tech', 50, 5, 2))
    eq(r.metrics[0].higher, null)
  })

  it('缺 coverage 时报道量显示「—」且不给方向', () => {
    const r = buildComparison(mkReport({ name: '甲', personKey: '甲#tech', heat: 30 }), B)
    const news = r.metrics.find((m) => m.key === 'news')
    eq(news.a, '—')
    eq(news.higher, null)
  })

  it('领域标签从 personKey 解析，非法键回落「其他」', () => {
    const r = buildComparison(A, mk('无名', '坏键', 10, 1, 1))
    eq(r.a.domainLabel, '科技')
    eq(r.b.domainLabel, '其他')
  })

  it('共同关注点取双方都提到的说法，独有词只保留有分量的', () => {
    const r = buildComparison(A, B)
    ok(r.common.some((c) => c.word === '智能汽车'), '共同话题应在 common 里')
    for (const k of r.onlyA) ok(k.count >= 2 || k.from === 'topic')
    for (const k of r.onlyB) ok(k.count >= 2 || k.from === 'topic')
    ok(r.onlyA.length <= 6)
    ok(r.onlyB.length <= 6)
  })

  it('摘要只陈述可比事实：热度差 < 5 说「接近」，否则点名更靠前的一方', () => {
    ok(describeComparison(buildComparison(A, B)).includes('热度更靠前'))
    ok(describeComparison(buildComparison(A, B)).includes('马斯克'))

    const close = describeComparison(buildComparison(mk('甲', '甲#tech', 70, 5, 2), mk('乙', '乙#tech', 68, 5, 2)))
    ok(close.includes('热度接近'), `实际：${close}`)
  })

  it('没有重叠主题时如实说明，而不是编一个共同点', () => {
    /* 刻意让两边素材用词完全不重叠（否则「都提到 X」会真的成立） */
    const x = mkReport({
      name: '甲',
      personKey: '甲#tech',
      heat: 60,
      coverage: { items: 5, recent: 2, firstAt: '2026-09-01', latestAt: '2026-10-01' },
      dynamics: [dyn({ title: '芯片研发取得进展' }), dyn({ title: '芯片量产爬坡' })],
      quotes: [{ text: '芯片是核心', context: '访谈' }],
      stance: [{ topic: '芯片', attitude: 'positive', note: 'n' }]
    })
    const y = mkReport({
      name: '乙',
      personKey: '乙#tech',
      heat: 60,
      coverage: { items: 5, recent: 2, firstAt: '2026-09-01', latestAt: '2026-10-01' },
      dynamics: [dyn({ title: '足球联赛夺冠' }), dyn({ title: '足球青训投入' })],
      quotes: [{ text: '足球很快乐', context: '访谈' }],
      stance: [{ topic: '足球', attitude: 'positive', note: 'n' }]
    })
    const r = buildComparison(x, y)
    deepEq(r.common, [], '不该凭空造出共同点')
    const text = describeComparison(r)
    ok(text.includes('没有明显重叠'), `实际：${text}`)
  })

  it('同一对报告多次对比结果一致（纯函数）', () => {
    deepEq(buildComparison(A, B), buildComparison(A, B))
  })
})

/* -------------------------------------------------- 分享文案 utils/share（O-13） */

describe('分享文案与落地路径 utils/share', () => {
  const { personShareTitle, reportSharePath } = env.load('utils/share')
  const { DOMAIN_META } = env.load('config/domains')

  it('落地路径统一是报告页，并带上 personKey（tabBar 页不能作分享落地页）', () => {
    const p = reportSharePath('张三#tech')
    ok(p.startsWith('/pages/report/index?'), `实际：${p}`)
    ok(p.includes(`personKey=${encodeURIComponent('张三#tech')}`), '人物键必须编码后带上')
  })

  it('focus 为 all 或不传时不拼参数，其余原样带上', () => {
    eq(reportSharePath('张三#tech'), reportSharePath('张三#tech', 'all'))
    notOk(reportSharePath('张三#tech', 'all').includes('focus='))
    ok(reportSharePath('张三#tech', 'quotes').endsWith('&focus=quotes'))
  })

  it('标题 = 姓名 · 领域（无报告时不编造简介）', () => {
    const t = personShareTitle('张三', 'tech')
    eq(t, `张三 · ${DOMAIN_META.tech.label}`)
    eq(personShareTitle('张三', 'tech', null), t)
    eq(personShareTitle('张三', 'tech', mkReport({ intro: '' })), t)
  })

  it('有报告时拼上可核对的简介首句（与页面展示同源，不加自夸后缀）', () => {
    const t = personShareTitle('张三', 'tech', mkReport({ intro: '连续创业者。更多内容' }))
    eq(t, '张三 · 科技｜连续创业者')
    notOk(t.includes('深度报告'), '不应出现「深度报告」这类自夸后缀')
    notOk(t.includes('更多内容'), '只取首句，不整段搬运')
  })

  it('超长简介先截断再拼，标题不超过微信展示上限', () => {
    const long = '这是一句非常长的简介'.repeat(6)
    const t = personShareTitle('张三', 'tech', mkReport({ intro: long }))
    ok(t.length <= 25, `标题应被裁到 ~24 字，实际 ${t.length}：${t}`)
    ok(t.startsWith('张三 · 科技｜'), '截断应发生在简介部分')
  })

  it('领域码非法时回落「名人」，不抛错', () => {
    eq(personShareTitle('张三', 'not-a-code'), '张三 · 名人')
  })
})

/* -------------------------------------------------- 主题知识库 utils/topic-digest（Phase 1） */

describe('主题知识库 utils/topic-digest', () => {
  const { buildTopicDigest, describeTopic, TOPIC_MIN_CHARS } = env.load('utils/topic-digest')

  /** 甲：话题词是「手机」，报道标题里出现的是「新款手机发布」 */
  const P1 = mkReport({
    name: '甲',
    personKey: '甲#tech',
    heat: 80,
    generatedAt: '2026-10-07T10:00:00.000Z',
    stance: [{ topic: '手机', attitude: 'positive', note: '长期主线' }],
    dynamics: [
      dyn({ title: '新款手机发布', summary: '手机业务继续扩张', source: '甲报', url: 'u1', date: '2026-10-01' }),
      dyn({ title: '手机出货量创新高', summary: '', source: '甲报', url: 'u2', date: '2026-10-03' })
    ],
    quotes: [{ text: '手机是入口', context: '发布会' }]
  })

  /** 乙：话题词是更长的「旗舰手机」—— 按 sameTopic 应归并到同一个主题 */
  const P2 = mkReport({
    name: '乙',
    personKey: '乙#business',
    heat: 60,
    generatedAt: '2026-10-06T10:00:00.000Z',
    stance: [{ topic: '旗舰手机', attitude: 'neutral', note: '近期提及' }],
    dynamics: [
      dyn({ title: '旗舰手机销量承压', summary: '', source: '乙报', url: 'u3', date: '2026-10-02' })
    ],
    quotes: []
  })

  it('互为子串的说法归到同一主题（与 utils/compare 的 sameTopic 同一口径）', () => {
    const d = buildTopicDigest('手机', [P1, P2])
    eq(d.members.length, 2, '「旗舰手机」的报告也应算进主题「手机」')
    eq(d.members.map((m) => m.name).sort().join(','), '乙,甲')
    ok(d.aliases.includes('旗舰手机'), `别名应记录归并进来的说法，实际 ${JSON.stringify(d.aliases)}`)
    notOk(d.aliases.includes('手机'), '别名不该是主题本身')
    ok(d.aliases.length <= 6)
  })

  it('证据按「正文里真的出现」筛：点更具体的主题时视图更窄', () => {
    const loose = buildTopicDigest('手机', [P1, P2])
    eq(loose.news.length, 3, '三份报道里都出现了「手机」（「旗舰手机」是子串，天然命中）')
    eq(loose.quotes.length, 1)

    const strict = buildTopicDigest('旗舰手机', [P1, P2])
    eq(strict.members.length, 1, '甲没写过「旗舰手机」这四个字，不算这个话题的成员')
    eq(strict.news.length, 1, '只有真的写了「旗舰手机」的那条报道')
    eq(strict.news[0].name, '乙')
    eq(strict.members[0].mentions, 1, '提及数必须等于下面列出的条目数，否则对不上')
  })

  it('相关名人按提及条数降序，且带领域标签与报告热度（同一把尺子）', () => {
    const d = buildTopicDigest('手机', [P2, P1])
    for (let i = 0; i + 1 < d.members.length; i++) {
      ok(d.members[i].mentions >= d.members[i + 1].mentions, '应按提及条数降序')
    }
    const first = d.members.find((m) => m.name === '甲')
    eq(first.domainLabel, '科技')
    eq(first.heat, 80)
  })

  it('素材总数与各成员提及数之和一致（页面上的数字必须能对上）', () => {
    const d = buildTopicDigest('手机', [P2, P1])
    eq(d.materialCount, d.members.reduce((n, m) => n + m.mentions, 0))
    eq(d.materialCount, d.news.length + d.quotes.length, '报道 + 言论 = 提及总数')
  })

  it('立场每人一条，带出 AI 判定的态度与依据', () => {
    const d = buildTopicDigest('手机', [P1, P2])
    eq(d.stances.length, 2)
    const jia = d.stances.find((s) => s.name === '甲')
    eq(jia.attitude, 'positive')
    eq(jia.note, '长期主线')
    eq(d.stances.filter((s) => s.personKey === '甲#tech').length, 1, '同一个人只出一条立场')
  })

  it('相关言论带出所属报告（渲染时要复用「查证」口径）', () => {
    const d = buildTopicDigest('手机', [P1, P2])
    eq(d.quotes.length, 1)
    eq(d.quotes[0].quote.text, '手机是入口')
    ok(!!d.quotes[0].report, '必须能拿到整份报告，否则查证找不到旁证')
    eq(d.quotes[0].report.personKey, '甲#tech')
  })

  it('时间线按日期升序，只收带可确认日期的报道', () => {
    const d = buildTopicDigest('手机', [P1, P2])
    eq(d.timeline.length, 3)
    eq(d.timeline.map((p) => p.date).join(','), '2026-10-01,2026-10-02,2026-10-03')
    ok(d.timeline.every((p) => p.count >= 1 && p.names.length >= 1), '每个点都要有出处名人')

    const noDate = buildTopicDigest('手机', [
      mkReport({ name: '丙', personKey: '丙#tech', stance: [{ topic: '手机', attitude: 'neutral', note: '' }], dynamics: [dyn({ title: '手机相关' })] })
    ])
    deepEq(noDate.timeline, [], '日期不可确认时不出点，不猜一个时间')
  })

  it('主题热度 0~100，且随覆盖人数与素材量单调不减、封顶 100', () => {
    eq(buildTopicDigest('不存在的话题', [P1, P2]).heat, 0)
    eq(buildTopicDigest('', [P1, P2]).members.length, 0, '空主题不聚合')

    const one = buildTopicDigest('手机', [P1]).heat
    const two = buildTopicDigest('手机', [P1, P2]).heat
    ok(one > 0 && one <= two, `一位名人 ${one} 不应高于两位名人 ${two}`)

    /* 堆到封顶：同一个人反复讲也只算一份，热度不会因此爆表 */
    const many = buildTopicDigest(
      '手机',
      Array.from({ length: 8 }, (_, i) =>
        mkReport({
          name: `名人${i}`,
          personKey: `名人${i}#tech`,
          stance: [{ topic: '手机', attitude: 'neutral', note: '' }],
          dynamics: Array.from({ length: 8 }, (_, j) => dyn({ title: `手机动态${j}`, date: '2026-10-0' + ((j % 4) + 1) }))
        })
      )
    )
    eq(many.heat, 100, '封顶就是 100，不出现三位数')
  })

  it('零命中时不抛错，且如实说明「没有相关报告」', () => {
    const d = buildTopicDigest('手机', [])
    eq(d.members.length, 0)
    eq(d.materialCount, 0)
    eq(d.heat, 0)
    eq(describeTopic(d), '暂无相关报告')

    const hit = buildTopicDigest('手机', [P1])
    ok(describeTopic(hit).includes('1 位名人'))
    ok(describeTopic(hit).includes('条素材'))
  })

  it('同一批报告多次聚合结果一致（纯函数）', () => {
    deepEq(buildTopicDigest('手机', [P1, P2]), buildTopicDigest('手机', [P1, P2]))
  })

  it('主题名长度门槛常量存在（1 个字的说法聚合出来都是噪声）', () => {
    eq(TOPIC_MIN_CHARS, 2)
  })
})
