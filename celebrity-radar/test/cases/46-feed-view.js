'use strict'

/**
 * 关注动态页**视图模型**（`utils/feed-view.ts`，2026-10-15 重设计新增）+ 重设计后的页面结构。
 *
 * 为什么要给它单独一个文件：重设计之前，「人物 / 领域 / 关键词 / 时间」四把筛子与
 * 「今天 / 昨天 / …」的分组规则全都长在 `package/feed/index.tsx` 的渲染函数体里，
 * 想验证「多选两位人物 + 近 7 天 + 关键词」叠加后到底剩几条，只能把页面跑起来用肉眼看。
 * 抠成纯函数之后（页面只负责画），这里逐条钉住四件事：
 *
 *   1. **叠加规则**：四把筛子怎么合、谁会把内容挡掉、挡掉多少条必须能被如实报出；
 *   2. **时间口径**：一律 UTC+8 日历日（与页面「今天」徽标同源），读不出日期**不算通过**
 *      —— 一条读不出日期的旧闻不该被当成「今天」，更不该无声消失；
 *   3. **不静默丢信息**：去重合并了多少条、被时间档挡掉多少条，都得有数字出口；
 *   4. **无结果时给得出下一步**：`loosenHint` 要算出「松开哪一项能多看几条」，而不是一句
 *      「试试别的条件」。
 *
 * 最后一段是**页面结构**的静态锁定：三层（工具行 → 条件回显 → 分组列表）+ 底部筛选面板，
 * 以及搜索框改动也回到第一页（分页语义见 37-feed-pagination.js，这里不重复）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 每次都从干净状态加载编译产物（与 37 同法：不共享上一用例的模块状态） */
function FV() {
  env.resetAll()
  return env.load('utils/feed-view')
}

/**
 * 固定的「现在」：UTC+8 的 2026-10-15 12:00。
 *
 * 时间口径的用例**不能**用 `Date.now()`：那会让「今天 / 昨天」的断言随运行日期漂移，
 * 半年后同一份代码会变红。传死一个时刻，日历日的换算就成了确定性断言。
 */
const NOW = new Date('2026-10-15T04:00:00Z')

/** 构造一条关注流条目；只覆盖关心的字段，其余给可用的默认值 */
function entry(over) {
  return Object.assign(
    {
      title: '标题',
      url: 'https://example.com/a',
      content: '摘要',
      source: '某媒体',
      publishedDate: '2026-10-15T01:00:00Z',
      personKey: '张三#tech',
      personName: '张三',
      domain: 'tech'
    },
    over || {}
  )
}

/** 距 NOW 若干 UTC+8 日历日的一条动态（0 = 今天，1 = 昨天…） */
function aged(days, over) {
  const base = Date.parse('2026-10-15T02:00:00Z') - days * 86400000
  return entry(Object.assign({ publishedDate: new Date(base).toISOString() }, over || {}))
}

/* ───────────────── 1. 筛选条件：合并 / 计数 / 回显 / 摘除 ───────────────── */

describe('关注流视图模型：筛选条件（合并 / 计数 / 回显 / 摘除）', () => {
  it('多选切换是纯函数：加得进、减得掉、不改入参', () => {
    const V = FV()
    const src = ['a']
    deepEq(V.toggleIn(src, 'b'), ['a', 'b'], '不在集合里 → 追加')
    deepEq(V.toggleIn(['a', 'b'], 'a'), ['b'], '已在集合里 → 摘掉')
    deepEq(src, ['a'], '原数组不得被改动（页面拿 state 直接传进来）')
  })

  it('角标个数与 chips 一一对应（时间档算一个），顺序＝时间 → 领域 → 人物', () => {
    const V = FV()
    const filter = { persons: ['张三#tech', '李四#tech'], domains: ['tech'], range: 'week' }
    eq(V.filterCount(filter), 4, '时间 1 + 领域 1 + 人物 2')
    deepEq(
      V.activeFilterChips(filter),
      [
        { kind: 'range', value: 'week' },
        { kind: 'domain', value: 'tech' },
        { kind: 'person', value: '张三#tech' },
        { kind: 'person', value: '李四#tech' }
      ],
      'chips 顺序应与筛选面板三组的排列一致'
    )
    eq(V.activeFilterChips(filter).length, V.filterCount(filter), '角标数必须等于 chips 行上的标签数')
  })

  it('无条件时：角标 0、chips 空、isFilterActive 为假', () => {
    const V = FV()
    eq(V.filterCount(V.EMPTY_FILTER), 0)
    deepEq(V.activeFilterChips(V.EMPTY_FILTER), [])
    notOk(V.isFilterActive(V.EMPTY_FILTER))
    ok(V.isFilterActive({ persons: [], domains: [], range: 'today' }), '只设时间档也算「有条件」')
  })

  it('摘掉单个条件：时间归位 all、领域/人物只摘指定那个，且不改原对象', () => {
    const V = FV()
    const filter = { persons: ['张三#tech', '李四#tech'], domains: ['tech', 'ent'], range: 'week' }
    deepEq(V.removeChip(filter, { kind: 'range', value: 'week' }), {
      persons: ['张三#tech', '李四#tech'],
      domains: ['tech', 'ent'],
      range: 'all'
    })
    deepEq(V.removeChip(filter, { kind: 'domain', value: 'tech' }).domains, ['ent'])
    deepEq(V.removeChip(filter, { kind: 'person', value: '张三#tech' }).persons, ['李四#tech'])
    deepEq(
      filter,
      { persons: ['张三#tech', '李四#tech'], domains: ['tech', 'ent'], range: 'week' },
      '原条件对象不得被改脏'
    )
  })

  it('EMPTY_FILTER 是只读常量：更新函数都不许原地改它（否则「重置」会失效）', () => {
    const V = FV()
    const f = V.EMPTY_FILTER
    V.toggleIn(f.persons, '张三#tech')
    V.removeChip(f, { kind: 'person', value: '张三#tech' })
    V.applyFeedFilter([aged(0)], f, 'x', NOW)
    deepEq(f, { persons: [], domains: [], range: 'all' }, 'EMPTY_FILTER 被改脏 → 「清空」再也清不干净')
  })

  it('容错归一：残缺 / 脏输入收敛成合法条件，未知时间档回落 all', () => {
    const V = FV()
    deepEq(V.normalizeFilter({ persons: ['a', '', 1], domains: 'x', range: 'week' }), {
      persons: ['a'],
      domains: [],
      range: 'week'
    })
    deepEq(V.normalizeFilter(null), { persons: [], domains: [], range: 'all' })
    deepEq(V.normalizeFilter(undefined), { persons: [], domains: [], range: 'all' })
    eq(V.normalizeFilter({ range: 'bogus' }).range, 'all', '不认识的档位回落「全部时间」而不是抛错')
  })

  it('档位标签：四个选项与面板渲染同源，未知值回落「全部时间」', () => {
    const V = FV()
    deepEq(
      V.RANGE_OPTIONS.map((o) => o.value),
      ['all', 'today', 'week', 'month']
    )
    eq(V.rangeLabel('week'), '近 7 天')
    eq(V.rangeLabel('all'), '全部时间')
    eq(V.rangeLabel('nope'), '全部时间')
  })
})

/* ───────────────────────── 2. 时间口径（UTC+8 日历日） ───────────────────────── */

describe('关注流视图模型：时间口径（UTC+8 日历日）', () => {
  it('ageDays 按 UTC+8 日历日算：今天 0 / 昨天 1 / 读不出 → null / 未来 → 负数', () => {
    const V = FV()
    eq(V.ageDays('2026-10-15T01:00:00Z', NOW), 0, 'UTC+8 今天上午 → 今天')
    eq(V.ageDays('2026-10-14T20:00:00Z', NOW), 0, 'UTC+8 今天凌晨 04:00 → 仍是今天（按日历日，不是 24 小时差）')
    eq(V.ageDays('2026-10-14T15:30:00Z', NOW), 1, 'UTC+8 昨晚 23:30 → 昨天（同一天里差 12 小时，也不该跳成 0）')
    eq(V.ageDays('2026-10-08T02:00:00Z', NOW), 7)
    eq(V.ageDays('', NOW), null, '空串 → null（不是 0）')
    eq(V.ageDays(undefined, NOW), null)
    eq(V.ageDays('不是日期', NOW), null)
    ok(V.ageDays('2027-01-01T00:00:00Z', NOW) < 0, '未来时间给负数，由调用方决定怎么处理')
  })

  it('档位上界：today 只今天、week <7、month <30，边界日不算在内', () => {
    const V = FV()
    ok(V.inRange(aged(0), 'today', NOW), '今天在「今天」档内')
    notOk(V.inRange(aged(1), 'today', NOW), '昨天不在「今天」档内')
    ok(V.inRange(aged(6), 'week', NOW), '6 天前在「近 7 天」内')
    notOk(V.inRange(aged(7), 'week', NOW), '整 7 天前不在「近 7 天」（上界不含）')
    ok(V.inRange(aged(29), 'month', NOW), '29 天前在「近 30 天」内')
    notOk(V.inRange(aged(30), 'month', NOW))
    ok(V.inRange(aged(365), 'all', NOW), '「全部时间」永远通过')
  })

  it('读不出日期 → 不算通过（不猜）；未来时间 → 算通过（不因上游给错年份就吞掉内容）', () => {
    const V = FV()
    notOk(V.inRange(entry({ publishedDate: '' }), 'week', NOW), '读不出日期不得被当成今天')
    notOk(V.inRange(entry({ publishedDate: undefined }), 'today', NOW))
    ok(V.inRange(entry({ publishedDate: '' }), 'all', NOW), '「全部时间」不该把缺日期的条挡掉')
    ok(V.inRange(entry({ publishedDate: '2027-01-01T00:00:00Z' }), 'week', NOW), '未来时间算通过')
  })
})

/* ─────────────────────── 3. 关键词匹配与四层叠加 ─────────────────────── */

describe('关注流视图模型：关键词与叠加过滤', () => {
  it('关键词只匹配标题 / 摘要 / 人名三处，忽略大小写，空串全通过', () => {
    const V = FV()
    const e = entry({ title: 'AI Update', content: '摘要里有争议', personName: '张三', source: '某媒体' })
    ok(V.matchQuery(e, 'ai'), '标题命中且忽略大小写')
    ok(V.matchQuery(e, '争议'), '摘要命中')
    ok(V.matchQuery(e, '张三'), '人名命中')
    ok(V.matchQuery(e, '   '), '空白串视为不筛')
    notOk(V.matchQuery(e, '某媒体'), '来源不在匹配范围内（不可核对的字段不参与搜索）')
    notOk(V.matchQuery(e, '不存在'))
  })

  it('四层叠加：人物 ∧ 领域 ∧ 时间 ∧ 关键词', () => {
    const V = FV()
    const rows = [
      aged(0, { personKey: 'A#tech', personName: 'A', domain: 'tech', title: '新品发布' }),
      aged(0, { personKey: 'B#tech', personName: 'B', domain: 'tech', title: '新品发布' }),
      aged(0, { personKey: 'A#tech', personName: 'A', domain: 'tech', title: '别的事' }),
      aged(10, { personKey: 'A#tech', personName: 'A', domain: 'tech', title: '旧的新品发布' }),
      aged(0, { personKey: 'A#tech', personName: 'A', domain: 'ent', title: '新品发布' })
    ]
    deepEq(
      V.applyFeedFilter(rows, { persons: ['A#tech'], domains: ['tech'], range: 'week' }, '新品', NOW).map((e) => e.title),
      ['新品发布'],
      '只应剩下「A 的 tech 领域、近 7 天、标题含新品」那一条'
    )
    eq(V.applyFeedFilter(rows, V.EMPTY_FILTER, '', NOW).length, rows.length, '无条件 = 全通过')
    deepEq(V.applyFeedFilter(null, V.EMPTY_FILTER, '', NOW), [], 'null 输入不抛错')
    deepEq(V.applyFeedFilter(undefined, V.EMPTY_FILTER, '', NOW), [])
  })

  it('过滤只做减法：结果里仍是原对象（页面据此做分页切片的引用比对）', () => {
    const V = FV()
    const e = aged(0)
    const out = V.applyFeedFilter([e], V.EMPTY_FILTER, '', NOW)
    eq(out.length, 1)
    ok(out[0] === e, '必须原样返回同一个对象引用，不得复制')
  })

  it('hiddenByRange 只数「其他条件都相符、独缺日期」的那些（页面要如实说出来）', () => {
    const V = FV()
    const rows = [
      aged(0, { personKey: 'A#tech' }),
      entry({ personKey: 'A#tech', publishedDate: '' }),
      entry({ personKey: 'B#tech', publishedDate: '' })
    ]
    const filter = { persons: ['A#tech'], domains: [], range: 'week' }
    eq(V.hiddenByRange(rows, filter, '', NOW), 1, '只算 A 的那条缺日期（B 被人筛选挡掉了，与本函数无关）')
    eq(V.hiddenByRange(rows, { ...filter, range: 'all' }, '', NOW), 0, '「全部时间」不挡任何条 → 无需解释')
  })
})

/* ───────────────────────── 4. 排序与同源去重 ───────────────────────── */

describe('关注流视图模型：排序与同源去重', () => {
  it('按发布时间倒序，读不出日期的排最后（不占「最新」的位置）', () => {
    const V = FV()
    const rows = [aged(3, { title: 'old' }), entry({ title: 'nodate', publishedDate: '' }), aged(0, { title: 'new' })]
    deepEq(rows.slice().sort(V.sortFeedByDate).map((e) => e.title), ['new', 'old', 'nodate'])
  })

  it('同一人的同一件事只留一条（保留先出现的＝最新的），并如实报出合并了几条', () => {
    const V = FV()
    const rows = [
      aged(0, { title: '张三 发布新品！', url: 'https://a.com/1' }),
      aged(1, { title: '张三发布新品', url: 'https://b.com/2' }),
      aged(0, { title: '别的事' })
    ]
    const r = V.dedupeFeedItems(rows.slice().sort(V.sortFeedByDate))
    eq(r.items.length, 2, '两条同源只留一条')
    eq(r.merged, 1, '合并数要能被页面说出来')
    eq(r.items[0].url, 'https://a.com/1', '保留最新的那条')
  })

  it('去重的两条边界：跨人不合并、标题为空不去重', () => {
    const V = FV()
    const cross = [
      aged(0, { personKey: 'A#tech', personName: 'A', title: '同一件事' }),
      aged(0, { personKey: 'B#tech', personName: 'B', title: '同一件事' })
    ]
    eq(V.dedupeFeedItems(cross).items.length, 2, '两个人对同一事件的表态是两条信息，不是重复')

    const blank = [entry({ title: '' }), entry({ title: '' })]
    const r = V.dedupeFeedItems(blank)
    eq(r.items.length, 2, '无从判断是否同一件事时宁可留两条，也不合并掉一条真内容')
    eq(r.merged, 0)
  })

  it('空输入安全：null / undefined / 非数组都当空列表', () => {
    const V = FV()
    for (const bad of [null, undefined, 'x']) {
      deepEq(V.dedupeFeedItems(bad).items, [])
      eq(V.dedupeFeedItems(bad).merged, 0)
    }
  })
})

/* ───────────────────────── 5. 时间分组 ───────────────────────── */

describe('关注流视图模型：时间分组', () => {
  it('分桶：今天 / 昨天 / 近 7 天 / 更早 / 时间未知，空组不返回且顺序固定', () => {
    const V = FV()
    const rows = [
      aged(0, { title: 't' }),
      aged(1, { title: 'y' }),
      aged(3, { title: 'w' }),
      aged(30, { title: 'o' }),
      entry({ title: 'n', publishedDate: '' }),
      entry({ title: 'f', publishedDate: '2027-01-01T00:00:00Z' })
    ]
    const groups = V.groupFeedByDay(rows, NOW)
    deepEq(
      groups.map((g) => [g.key, g.label, g.items.length]),
      [
        ['today', '今天', 1],
        ['yesterday', '昨天', 1],
        ['week', '近 7 天', 1],
        ['older', '更早', 1],
        ['unknown', '时间未知', 2]
      ],
      '未来的（上游给错年份）与缺日期的一起进「时间未知」，不冒充今天'
    )
  })

  it('空组不返回：只有今天有内容时，一个组头都不会多余出现', () => {
    const V = FV()
    const groups = V.groupFeedByDay([aged(0)], NOW)
    eq(groups.length, 1)
    eq(groups[0].key, 'today')
    deepEq(V.groupFeedByDay([], NOW), [])
    deepEq(V.groupFeedByDay(null, NOW), [])
  })

  it('分组不重排：组内条目保持入参顺序（先排序再分组，避免组内乱序）', () => {
    const V = FV()
    const rows = [aged(0, { title: 'a' }), aged(1, { title: 'b' }), aged(0, { title: 'c' })]
    const groups = V.groupFeedByDay(rows, NOW)
    deepEq(groups[0].items.map((e) => e.title), ['a', 'c'])
    deepEq(groups[1].items.map((e) => e.title), ['b'])
  })
})

/* ─────────────────── 6. 筛到一条不剩时，给得出下一步 ─────────────────── */

describe('关注流视图模型：无结果时的出口建议', () => {
  it('本来就有结果 / 数据源为空 → 不给建议（空串）', () => {
    const V = FV()
    const rows = [aged(0)]
    eq(V.loosenHint(rows, V.EMPTY_FILTER, '', NOW), '')
    eq(V.loosenHint([], { persons: ['A#tech'], domains: [], range: 'week' }, '', NOW), '')
    eq(V.loosenHint(null, V.EMPTY_FILTER, '', NOW), '')
  })

  it('筛空时算出「松开哪一项能多看几条」，并挑收益最大的那条', () => {
    const V = FV()
    const rows = [
      aged(40, { personKey: 'A#tech', personName: 'A' }),
      aged(41, { personKey: 'A#tech', personName: 'A' }),
      aged(42, { personKey: 'A#tech', personName: 'A' }),
      aged(0, { personKey: 'B#tech', personName: 'B' }),
      aged(0, { personKey: 'B#tech', personName: 'B' }),
      aged(0, { personKey: 'B#tech', personName: 'B' }),
      aged(0, { personKey: 'B#tech', personName: 'B' })
    ]
    const filter = { persons: ['A#tech'], domains: [], range: 'week' }
    /* 去掉时间档只能多看 A 的 3 条；切回全部人物能多看 B 的 4 条 → 该说后者 */
    eq(V.loosenHint(rows, filter, '', NOW), '切回「全部人物」可多看 4 条')
  })

  it('搜索词也会被算进建议里（输入框与筛选是同一件事的两半）', () => {
    const V = FV()
    const rows = [aged(0, { title: '甲' }), aged(0, { title: '乙' }), aged(0, { title: '丙' })]
    eq(V.loosenHint(rows, V.EMPTY_FILTER, '不存在', NOW), '清空搜索词可多看 3 条')
  })

  it('怎么松都没结果 → 不编造数字，只给一句「换个条件再试试」', () => {
    const V = FV()
    const rows = [aged(40, { title: '甲' })]
    const filter = { persons: ['A#tech'], domains: [], range: 'week' }
    eq(V.loosenHint(rows, filter, '不存在', NOW), '换个条件再试试')
  })
})

/* ───────────────── 7. 页面结构：三层 + 底部面板（静态锁定） ───────────────── */

describe('关注动态页：重设计后的结构（静态锁定）', () => {
  const page = read('package/feed/index.tsx')
  const scss = read('package/feed/index.scss')

  it('三层结构：工具行里搜索与筛选并排（同一行、同一件事）', () => {
    ok(page.includes("className='page-feed__toolbar'"), '缺工具行容器')
    const iBar = page.indexOf('page-feed__toolbar')
    const iSearch = page.indexOf('page-feed__search')
    const iFilter = page.indexOf('page-feed__filter')
    ok(iSearch > iBar && iFilter > iSearch, '搜索框与筛选按钮都应排在工具行内、搜索在前')
    ok(page.includes("placeholder='搜索动态 / 人名'"), '搜索框仍在（占位文案要说清能搜什么）')
    notOk(page.includes('<Picker'), '人物筛选不该再有第二套入口（旧的下拉已由底部面板取代）')
  })

  it('第二层：生效条件 chips 回显 + 可逐个摘掉 + 一键清空', () => {
    ok(page.includes('activeFilterChips('), 'chips 应取自视图模型（与面板同源）')
    ok(page.includes('page-feed__chips'), '缺 chips 行')
    ok(page.includes('onClick={() => dropChip(c)}'), 'chips 上的 × 应能单独摘掉该条件')
    ok(page.includes('page-feed__chips-clear'), '缺「清空」入口')
    ok(page.includes('removeChip('), '摘除单个条件应走纯函数')
  })

  it('第三层：列表按时间分组，组头在「每组第一条之前」插入', () => {
    ok(page.includes('groupFeedByDay('), '分组应走视图模型')
    ok(page.includes("className='section-head'"), '缺分组头（复用全局 .section-head）')
    ok(
      page.includes('groupOf.get(prev ?? e) !== groupOf.get(e)'),
      '应以「与上一条是否同组」判断插不插组头（分页切片里同样成立）'
    )
    ok(scss.includes('&__item {'), '缺列表卡样式')
  })

  it('不静默丢信息：被时间档挡掉的条数与合并掉的条数都要说出来', () => {
    ok(page.includes('rangeHidden'), '缺「另有 N 条缺少发布日期」的口径')
    ok(page.includes('hiddenByRange('), '该条数应由视图模型算出')
    ok(page.includes('mergedCount > 0'), '缺「已合并 N 条同源报道」的提示')
    ok(page.includes('dedupeFeedItems('), '去重应在归并后、分页前完成')
  })

  it('底部筛选面板：挂 glow-overlay（否则会被 .glow-page > view 压回文档流）', () => {
    ok(page.includes('page-feed__mask-layer glow-overlay'), '浮层必须挂 glow-overlay')
    ok(scss.includes('&__sheet {'), '缺底部面板样式')
    notOk(
      /&__mask-layer\s*\{[^}]*position:\s*fixed/.test(scss),
      'position 由 .glow-page > .glow-overlay 给死，这里再写一次会被压掉（写了只会让人误判层级来源）'
    )
  })

  it('搜索框的输入与清空同样回到第一页（与筛选同一套分页语义）', () => {
    ok(/onInput=\{[\s\S]{0,220}setPage\(1\)/.test(page), '输入关键词应回到第一页')
    ok(/page-feed__search-clear[\s\S]{0,220}setPage\(1\)/.test(page), '清空关键词也应回到第一页')
  })
})
