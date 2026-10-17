'use strict'

/** 纯逻辑层：时间 / 敏感词 / 领域键 / 筛选 / 词云 / 数据聚合 / 两人对比 */

const fs = require('fs')
const path = require('path')
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

  it('todayKey 是 UTC+8 的 yyyy-MM-dd（配额主键口径，与云端同日）', () => {
    /*
     * P2-10（2026-10-09）：配额主键是 `openid#yyyy-mm-dd`，云端（quotaGuard / aiProxy#quota.config）
     * 一律按 UTC+8 取日期。端上若按设备本地时区算，非东八区或用户改过设备日期的场景就会出现
     * 「界面显示还有额度、云端却按另一天拒绝」（或反之）。这里钉住同一公式。
     */
    eq(time.todayKey(), new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10))
    ok(/^\d{4}-\d{2}-\d{2}$/.test(time.todayKey()))
  })

  it('todayKey 不依赖设备时区（源码里不许再出现 dayjs 本地格式化）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'utils', 'time.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function todayKey'))
    ok(body.includes('8 * 3600 * 1000'), '必须显式 +8，不能靠运行环境时区')
    notOk(/todayKey[\s\S]{0,200}dayjs\(\)/.test(body), 'todayKey 内不得再回落 dayjs 本地格式化')
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

  it('时间线相对时间 stampAgo：粒度决定说法，未到的刻度与相对说法一律为空', () => {
    /*
     * 时间线的刻度是绝对日期（「2021-05」），离现在多远用户得自己对着日历算 —— 故页面在日期后
     * 补一句「5 年前」。解析与 UTC+8 基准与全项目一致：
     * 刻度还没到时该是空串（时间线讲的是已经发生了什么）。
     */
    const now = '2026-10-10T09:00:00+08:00'
    /* 到日：天 → 月 → 年逐级换档 */
    eq(time.stampAgo('2026-10-10', now), '今天')
    eq(time.stampAgo('2026-10-09', now), '昨天')
    eq(time.stampAgo('2026-10-01', now), '9 天前')
    eq(time.stampAgo('2026-09-11', now), '29 天前', '刚好不到 30 天仍按天说')
    eq(time.stampAgo('2026-08-10', now), '2 个月前')
    eq(time.stampAgo('2025-10-10', now), '1 年前')
    eq(time.stampAgo('2021-05-20', now), '5 年前')
    /* 到月：整月差说「月」，满 12 个月换成「年」 */
    eq(time.stampAgo('2026-10', now), '本月')
    eq(time.stampAgo('2026-09', now), '上个月')
    eq(time.stampAgo('2026-05', now), '5 个月前')
    eq(time.stampAgo('2025-10', now), '1 年前')
    /* 只到年 */
    eq(time.stampAgo('2026', now), '今年')
    eq(time.stampAgo('2025', now), '去年')
    eq(time.stampAgo('2023', now), '3 年前')
    /* 还没到的刻度：空串，不是「-3 个月前」这种怪话（时间线只讲已发生的事） */
    eq(time.stampAgo('2026-11', now), '', '下个月的刻度不该说成过去了多久')
    eq(time.stampAgo('2026-10-31', now), '')
    eq(time.stampAgo('2027', now), '')
    /* 解析不出绝对刻度（老报告里的相对说法 / 空值）= 未知，一律空串，绝不编一个数 */
    eq(time.stampAgo('下月', now), '')
    eq(time.stampAgo('年底', now), '')
    eq(time.stampAgo('', now), '')
    /* 已过去的刻度一定有说法；未过去 / 未知一律空串 */
    for (const when of ['2026-10-10', '2026-10', '2026', '2025', '2021-05-20']) {
      ok(time.stampAgo(when, now) !== '', `${when} 已经过去，相对时间不该为空`)
    }
    for (const when of ['2026-11', '2027', '下月', '']) {
      eq(time.stampAgo(when, now), '', `${when} 未过去或不可解析，相对时间不该有值`)
    }
  })

  it('formatDay / formatDate 输出稳定格式', () => {
    eq(time.formatDay('2026-10-07T10:00:00.000Z'), dayjs('2026-10-07T10:00:00.000Z').format('YYYY-MM-DD'))
    eq(time.formatDate('2026-10-07T10:00:00.000Z'), dayjs('2026-10-07T10:00:00.000Z').format('YYYY-MM-DD HH:mm'))
  })

  /*
   * P2-36（2026-10-09）：展示层的日期必须与数据同口径 —— 上游 `publishedDate` / 云端的
   * `first_seen_at` / `generated_at` 全按 UTC+8 产出，而页面原先用 `getMonth()/getDate()`
   * （设备本地）算「今天」徽标与短日期标签。同一份数据在不同用户的手机上因此得出不同结论，
   * 且只在跨日那几小时显形 —— 用户只会以为数据错了。下面把边界钉在 UTC+8 的 00:00。
   */
  it('dayKey8 / shortDay8：按 UTC+8 取日历日（16:00Z 即换日）', () => {
    eq(time.dayKey8('2026-10-09T15:59:00Z'), '2026-10-09', 'UTC+8 23:59 仍是当天')
    eq(time.dayKey8('2026-10-09T16:00:00Z'), '2026-10-10', 'UTC+8 00:00 已换日（设备时区不该参与）')
    eq(time.shortDay8('2026-10-09T17:00:00Z'), '10-10')
    eq(time.dayKey8('不是日期'), '', '不可解析返回空串，调用方好判空')
    eq(time.shortDay8(''), '')
  })

  it('sameDay8：跨 UTC+8 零点不算同一天，坏输入一律 false', () => {
    ok(time.sameDay8('2026-10-09T15:59:00Z', '2026-10-09T16:00:00Z') === false)
    ok(time.sameDay8('2026-10-09T16:00:00Z', '2026-10-09T17:00:00Z') === true)
    notOk(time.sameDay8('2026-10-09T16:00:00Z', '坏时间'))
  })

  it('formatMoment8 / todayLabel8：MM-DD HH:mm 与「M月D日·周X」都按 UTC+8', () => {
    eq(time.formatMoment8('2026-10-09T17:05:00Z'), '10-10 01:05')
    eq(time.formatMoment8('坏时间'), '')
    /* 2026-10-09 是周五 ⇒ UTC+8 次日 10-10 是周六 */
    eq(time.todayLabel8(new Date('2026-10-09T17:00:00Z')), '10月10日 · 周六')
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

  it('P2-17：buildPersonKey 把名字里的 # 剥掉（否则同一个人的报告会存成两行）', () => {
    eq(d.buildPersonKey('A#B', 'ent'), 'AB#ent')
    eq(d.buildPersonKey('A＃B', 'ent'), 'AB#ent')
    const key = d.buildPersonKey('A#B', 'ent')
    deepEq(d.parsePersonKey(key), { name: 'AB', domain: 'ent' })
  })

  it('历史 key 里残留的 # 仍按最后一个 # 解析（老缓存不因收口而失效）', () => {
    deepEq(d.parsePersonKey('A#B#ent'), { name: 'A#B', domain: 'ent' })
  })

  it('领域自由化：名字或领域为空返回 null，12 个已知码之外的自由领域照常解析', () => {
    eq(d.parsePersonKey('没有井号'), null)
    eq(d.parsePersonKey('#tech'), null)
    eq(d.parsePersonKey(''), null)
    /* 领域净化后为空仍是非法 */
    eq(d.parsePersonKey('张三#'), null)
    eq(d.parsePersonKey('张三#   '), null)
    /* 自 2026-10-12 起领域是自由短串：不是 12 个已知码也合法（不再阻断生成） */
    deepEq(d.parsePersonKey('张三#不存在'), { name: '张三', domain: '不存在' })
  })

  it('isDomainCode 只认枚举内取值', () => {
    ok(d.isDomainCode('tech'))
    ok(d.isDomainCode('other'))
    notOk(d.isDomainCode('TECH'))
    notOk(d.isDomainCode('全部'))
    eq(d.DOMAIN_CODES.length, 12)
  })

  it('domainLabel：已知码给中文标签，自创领域原样展示，空值回落「其他」', () => {
    eq(d.domainLabel('tech'), '科技')
    eq(d.domainLabel('other'), '其他')
    eq(d.domainLabel('脱口秀'), '脱口秀')
    eq(d.domainLabel(''), '其他')
    eq(d.domainLabel('   '), '其他')
  })

  it('domainStyleCode：只有已知码保留，自创领域统一回落中性 other（14 处 SCSS 变体无需新增）', () => {
    eq(d.domainStyleCode('tech'), 'tech')
    eq(d.domainStyleCode('脱口秀'), 'other')
    eq(d.domainStyleCode(''), 'other')
  })

  it('sanitizeDomain / isFreeDomain：去 # 与空白、截到上限、空即非法', () => {
    eq(d.sanitizeDomain('  脱 口 秀 '), '脱口秀')
    eq(d.sanitizeDomain('a#b＃c'), 'abc')
    eq(d.sanitizeDomain(''), '')
    eq(d.sanitizeDomain(null), '')
    eq(d.sanitizeDomain('x'.repeat(30)).length, d.DOMAIN_FREE_MAX)
    ok(d.isFreeDomain('脱口秀'))
    notOk(d.isFreeDomain('脱 口秀'), '含空白就不算净化形态')
    notOk(d.isFreeDomain(''))
  })

  it('自由领域 personKey 可往返；领域里的 # / 空白不会分裂缓存主键', () => {
    const key = d.buildPersonKey('张三', '脱口秀')
    eq(key, '张三#脱口秀')
    deepEq(d.parsePersonKey(key), { name: '张三', domain: '脱口秀' })
    eq(d.buildPersonKey('张三', '脱#口秀'), '张三#脱口秀', '领域里的分隔符会被净化')
    eq(d.buildPersonKey('张三', '  '), '张三#other', '领域净化后为空回落 other')
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
    eq(f.summarizeFilters('all', 'all'), '全部行业 · 完整报告')
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

  /*
   * 关注筛选与报告模板「同源派生」（2026-10-13）。
   *
   * 此前 config/filters 的 FOCUS_META 与 utils/report-toc 的 REPORT_TEMPLATE 各写一份、
   * 靠人工对齐（dynamics↔sec-dynamics / quotes↔sec-quotes / timeline↔sec-timeline），
   * 模板改节 id 或删节时**不会报错**，只会静默漂移。现在标签与顺序都从模板派生，
   * 这条用例就是那道闸：模板一动，绑定/标签/顺序任一不符即红。
   */
  it('关注方向码 / 标签 / 顺序与报告模板同源（改模板节 id 或删节，本用例即红）', () => {
    const toc = env.load('utils/report-toc')
    const DIRS = ['dynamics', 'quotes', 'timeline']

    /* ① 每个具体方向都绑定到模板里**真实存在**的节 —— 模板改 id / 删节，ok(sec) 立刻失败 */
    for (const code of DIRS) {
      const id = f.FOCUS_SECTION_BINDING[code]
      ok(id, `${code} 没有绑定到任何报告节`)
      const sec = toc.REPORT_TEMPLATE.find((s) => s.id === id)
      ok(sec, `${code} 绑定的节「${id}」在模板里不存在 —— 改模板节 id / 删节必须同步 config/filters.ts`)
      /* ② 标签取自该节的 label（同源，不再手写重复字符串） */
      eq(f.FOCUS_META[code].label, sec.label, `${code} 的标签必须等于模板该节的 label`)
      /* ②b 说明文案取自该节的 desc（同源，不再手写重复字符串） */
      eq(f.FOCUS_META[code].desc, sec.desc, `${code} 的说明必须等于模板该节的 desc`)
    }

    /* ③ 顺序 = 绑定节在模板中的先后顺序（'all' 固定最前） */
    const idx = (code) => toc.REPORT_TEMPLATE.findIndex((s) => s.id === f.FOCUS_SECTION_BINDING[code])
    const dirs = f.FOCUS_CODES.slice(1)
    deepEq(dirs, dirs.slice().sort((a, b) => idx(a) - idx(b)), '关注码顺序必须跟着模板顺序走')
    /* 对外取值与顺序保持兼容（本次不做「focus 码改为节 id」的更大重构） */
    deepEq(f.FOCUS_CODES, ['all', 'dynamics', 'quotes', 'timeline'])
  })
})

/* ------------------------------------ 姓名 + 关键词拆分 utils/query-split（2026-10-13） */

/*
 * 用户会输入「雷军 小米科技」这种「姓名 + 关键词」。整串当人名塞进消歧会查无此人，故拆开：
 * 名字走原链路（personKey / 缓存键只认它），关键词只作提示（消歧补充 + 检索补充）。
 * 关键边界是西文人名（Taylor Swift / Robert Downey Jr.）：不能见空格就拆，否则姓氏被当关键词。
 * 判据：按分隔符切开后 ≥2 段、且除首段外至少有一段含中日韩字符时才拆；否则视为单个人名。
 */
describe('姓名 + 关键词拆分 utils/query-split', () => {
  const { splitPersonQuery } = env.load('utils/query-split')

  it('空格 / 全角空格 / 中文标点都能分开名字与关键词，关键词取其余全部', () => {
    deepEq(splitPersonQuery('雷军 小米科技'), { name: '雷军', keyword: '小米科技' })
    deepEq(splitPersonQuery('雷军 小米科技 手机'), { name: '雷军', keyword: '小米科技 手机' }, '其余段合并为关键词')
    deepEq(splitPersonQuery('雷军，小米科技'), { name: '雷军', keyword: '小米科技' })
    deepEq(splitPersonQuery('雷军、小米科技'), { name: '雷军', keyword: '小米科技' })
    deepEq(splitPersonQuery('雷军　小米科技'), { name: '雷军', keyword: '小米科技' }, '全角空格')
  })

  it('西文人名不拆：不含中日韩字符的补充段不成立（否则姓氏会被当关键词）', () => {
    deepEq(splitPersonQuery('Taylor Swift'), { name: 'Taylor Swift', keyword: '' })
    deepEq(splitPersonQuery('Robert Downey Jr.'), { name: 'Robert Downey Jr.', keyword: '' })
  })

  it('译名里的间隔号不算分隔符（否则「迈克尔·乔丹」会被拆成 name=迈克尔，把人查错）', () => {
    deepEq(splitPersonQuery('迈克尔·乔丹'), { name: '迈克尔·乔丹', keyword: '' })
    deepEq(splitPersonQuery('莱昂纳多·迪卡普里奥'), { name: '莱昂纳多·迪卡普里奥', keyword: '' })
    deepEq(splitPersonQuery('迈克尔·乔丹 篮球'), { name: '迈克尔·乔丹', keyword: '篮球' }, '真要补关键词仍可用空格')
  })

  it('没有分隔符 / 单个名字：keyword 为空，name 为整串', () => {
    deepEq(splitPersonQuery('雷军'), { name: '雷军', keyword: '' })
    deepEq(splitPersonQuery('雷军小米科技'), { name: '雷军小米科技', keyword: '' }, '无分隔符 = 单个人名，不猜')
  })

  it('首尾多余空格被去掉（普通空格 / 全角空格）', () => {
    deepEq(splitPersonQuery('  雷军  小米科技  '), { name: '雷军', keyword: '小米科技' })
    deepEq(splitPersonQuery('　雷军　'), { name: '雷军', keyword: '' })
  })

  it('空输入：name / keyword 都为空串（调用方据此不发请求）', () => {
    deepEq(splitPersonQuery(''), { name: '', keyword: '' })
    deepEq(splitPersonQuery('   '), { name: '', keyword: '' })
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

  it('同一天多条「没标题也没摘要」的条目各自算一条，不因去重键退化成「只按日期」而被吞', () => {
    const t = buildHeatTrend(
      mkReport({
        generatedAt: '2026-10-08T10:00:00.000Z',
        dynamics: [
          dyn({ date: '2026-10-01', title: '', summary: '' }),
          dyn({ date: '2026-10-01', title: '', summary: '' }),
          dyn({ date: '2026-10-02', title: '', summary: '' })
        ]
      })
    )
    ok(t, '三条空文本条目足以撑起折线')
    eq(t.total, 3, '判不出身份就按独立事件计，不能被「日期 + 空文本」的键合并成 1 条')
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

  it('素材可信度：门槛看「可判定来源的条数」，来源判不出的条目多也不算数', () => {
    const c = buildProfileStats(
      mkReport({
        dynamics: [
          dyn({ title: '甲', source: 'A', date: '2026-09-05' }),
          dyn({ title: '乙', source: 'B', date: '2026-09-06' }),
          /* 下面两条来源与 url 都缺 → 不进 labels */
          dyn({ title: '丙', date: '2026-09-07' }),
          dyn({ title: '丁', date: '2026-09-08' })
        ]
      })
    ).credibility
    eq(c, null, '4 条动态但只有 2 条能判来源 → 与来源分布卡同判据（MIN_SOURCE_ITEMS），不出卡')
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

  it('六项对照指标齐备，且只有热度给方向', () => {
    const r = buildComparison(A, B)
    eq(r.metrics.length, 6)
    const byKey = Object.fromEntries(r.metrics.map((m) => [m.key, m]))
    eq(byKey.heat.a, '80')
    eq(byKey.heat.b, '70')
    eq(byKey.heat.higher, 'a')
    /* 报道量按原样素材统计、深度档抓得更多，不能当人气读数比大小 —— 与热度同口径的只有热度本身 */
    eq(byKey.news.higher, null, '报道量不参与优劣判断')
    eq(byKey.recent.higher, null)
    eq(byKey.news.a, '20', '数字仍原样给出，只是不给方向')
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

  it('sameTopic 对空串恒不匹配（模型漏给 topic 时不能算「命中任意主题」）', () => {
    const { sameTopic } = env.load('utils/compare')
    eq(sameTopic('', '手机'), false, '空串不该被当成任意主题的子串')
    eq(sameTopic('手机', ''), false)
    eq(sameTopic('', ''), false)
    eq(sameTopic('手机', '手机'), true)
    eq(sameTopic('手机', '旗舰手机'), true, '互为子串仍算同一话题')
    eq(sameTopic('手机', '足球'), false)
  })
})

/* -------------------------------------------------- 分享文案 utils/share（O-13） */

describe('分享文案与落地路径 utils/share', () => {
  const { personShareTitle, reportSharePath } = env.load('utils/share')
  const { DOMAIN_META } = env.load('config/domains')

  it('落地路径统一是报告页，并带上 personKey（tabBar 页不能作分享落地页）', () => {
    const p = reportSharePath('张三#tech')
    ok(p.startsWith('/package/report/index?'), `实际：${p}`)
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

  it('领域为空时回落「名人」；自创领域原样展示（领域自由化后不再要求 12 个已知码）', () => {
    eq(personShareTitle('张三', ''), '张三 · 名人')
    eq(personShareTitle('张三', 'not-a-code'), '张三 · not-a-code')
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

  it('stance.topic 为空的报告不出立场（空串不能与任意主题「互为子串」）', () => {
    const noisy = mkReport({
      name: '丁',
      personKey: '丁#tech',
      heat: 50,
      dynamics: [dyn({ title: '手机又有新进展' })],
      quotes: [],
      stance: [{ topic: '', attitude: 'positive', note: '模型漏给了主题' }]
    })
    const d = buildTopicDigest('手机', [noisy])
    eq(d.members.length, 1, '正文提到「手机」仍是本主题成员')
    deepEq(d.stances, [], 'topic 为空的立场不该被算成「针对手机」')
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

/* -------------------------------------------------- 风险雷达 utils/risk（第 0 期，端上聚合） */

describe('风险雷达 utils/risk', () => {
  const { buildRiskSignals, RISK_CATEGORIES, RISK_CATEGORY_LABEL, MAX_SIGNALS } = env.load('utils/risk')

  it('字面命中即陈列：类别、原词、出处、原文链接都带出来', () => {
    const r = buildRiskSignals(
      mkReport({
        dynamics: [
          dyn({ title: '工作室起诉造谣者', source: '新浪娱乐', url: 'https://a.com/1', date: '2026-10-01' })
        ]
      })
    )
    eq(r.signals.length, 1)
    /* 2026-10-10 起「起诉造谣者」判为名誉维权（本人是维权方、不是被诉方），
       见紧随其后的方向用例 —— 这条只证明「类别、原词、出处、链接都带了出来」 */
    eq(r.signals[0].category, 'rights')
    eq(r.signals[0].keyword, '起诉')
    eq(r.signals[0].from, 'dynamics')
    eq(r.signals[0].url, 'https://a.com/1')
    eq(r.signals[0].source, '新浪娱乐')
    eq(r.signals[0].date, '2026-10-01')
    eq(r.byCategory.rights, 1)
    eq(r.byCategory.contract, 0)
    eq(r.total, 1)
    eq(r.scanned, 1)
  })

  it('双向词看方向：「起诉造谣者」是维权、「被起诉」才是司法监管（2026-10-10 降误导）', () => {
    /*
     * 「起诉 / 诉讼」原告被告都在用，字面读不出语义，只能看动词后面是否跟着维权对象。
     * 判反的代价不对称：把「被起诉」错判成维权会让真风险从雷达上消失（漏报），
     * 故默认按司法（保守），只有明确识别出维权宾语才改判维权。
     * 已知局限：宾语前置的形态（「对造谣者提起诉讼」）识别不到，会保守地留在司法监管。
     */
    const sue = buildRiskSignals(mkReport({ dynamics: [dyn({ title: '工作室起诉造谣者' })] }))
    eq(sue.signals[0].category, 'rights', '起诉他人维权 = 名誉维权')
    eq(sue.signals[0].keyword, '起诉', '原词照旧是「起诉」')

    const far = buildRiskSignals(mkReport({ dynamics: [dyn({ title: '起诉长期造谣的账号' })] }))
    eq(far.signals[0].category, 'rights', '宾语离动词几个字也要认得出')

    const sued = buildRiskSignals(mkReport({ dynamics: [dyn({ title: '本人被起诉' })] }))
    eq(sued.signals[0].category, 'judicial', '本人被起诉 = 司法监管')

    const involved = buildRiskSignals(mkReport({ dynamics: [dyn({ title: '卷入诉讼' })] }))
    eq(involved.signals[0].category, 'judicial', '没写宾语 → 保守按司法')
  })

  it('否定表述整条不计入（「未被起诉」「否认解约」都不该被读成信号）', () => {
    const r = buildRiskSignals(
      mkReport({
        dynamics: [dyn({ title: '工作室否认解约传闻' }), dyn({ title: '本人未被起诉' })]
      })
    )
    deepEq(r.signals, [])
    eq(r.total, 0)
    eq(r.scanned, 2, '扫描过仍要如实计数，只是没命中')
  })

  it('算不出就说算不出：没有可扫描素材时给 null 而不是 0', () => {
    const r = buildRiskSignals(mkReport())
    eq(r.scanned, 0)
    eq(r.signals.length, 0)
    eq(r.negative, null, '「没数据」与「数据是 0」必须分开')
    eq(r.negativeShare, null)
  })

  it('不给结论：返回结构里没有等级 / 评分 / 概率这类字段', () => {
    const r = buildRiskSignals(mkReport({ dynamics: [dyn({ title: '被起诉风波' })] }))
    eq(r.signals.length, 1)
    for (const bad of ['level', 'score', 'risk', 'probability', 'grade', 'severity']) {
      notOk(bad in r, `聚合结果不应出现 ${bad} 字段（本卡只陈列素材表述）`)
    }
    for (const s of r.signals) {
      for (const bad of ['level', 'score', 'severity']) notOk(bad in s, `信号条目不应出现 ${bad}`)
    }
  })

  it('带日期的信号按新的在前排，无日期的跟在后面（不混进时间序列）', () => {
    const r = buildRiskSignals(
      mkReport({
        dynamics: [dyn({ title: '早的起诉', date: '2026-09-01' }), dyn({ title: '晚的立案', date: '2026-10-05' })],
        quotes: [{ text: '谈到解约', context: '采访', source: '某台' }]
      })
    )
    eq(r.signals.map((s) => s.date).join(','), '2026-10-05,2026-09-01,')
    eq(r.signals[2].from, 'quotes')
  })

  it('四段素材都参与扫描，出处字段各取各的（争议只有依据、时间线没有出处）', () => {
    const r = buildRiskSignals(
      mkReport({
        dynamics: [dyn({ title: '起诉相关' })],
        controversies: [{ topic: '税务问题', claim: '被指漏税', response: '', basis: '某媒体 2026-09-01' }],
        quotes: [{ text: '已委托律师处理侵权', context: '发布会', source: '某台' }],
        timeline: [{ date: '2026-09-20', event: '品牌方宣布终止合作' }]
      })
    )
    eq(r.scanned, 4)
    eq(r.signals.length, 4)
    const byFrom = Object.fromEntries(r.signals.map((s) => [s.from, s]))
    eq(byFrom.controversies.source, '某媒体 2026-09-01')
    eq(byFrom.controversies.url, '', '争议段没有 url 字段，不能假装能给链接')
    eq(byFrom.quotes.source, '某台')
    eq(byFrom.timeline.source, '', '时间线没有出处字段')
  })

  it('未回应争议单独计数（素材没收录到回应，不等于没有回应）', () => {
    const r = buildRiskSignals(
      mkReport({
        controversies: [
          { topic: '甲', claim: 'c', response: '', basis: 'b1' },
          { topic: '乙', claim: 'c', response: '已回应', basis: 'b2' }
        ]
      })
    )
    eq(r.unanswered, 1)
  })

  it('负面占比与情绪口径同源（只数 dynamics 的 sentiment）', () => {
    const r = buildRiskSignals(
      mkReport({
        dynamics: [
          dyn({ title: '甲', sentiment: 'negative' }),
          dyn({ title: '乙', sentiment: 'positive' }),
          dyn({ title: '丙', sentiment: 'neutral' }),
          dyn({ title: '丁', sentiment: 'negative' })
        ]
      })
    )
    eq(r.negative, 2)
    eq(r.negativeShare, 0.5)
  })

  it('命中超过上限时截断，但总数如实给出（页面要写「另有 N 条」）', () => {
    const many = Array.from({ length: MAX_SIGNALS + 3 }, (_, i) => dyn({ title: `第${i}次起诉` }))
    const r = buildRiskSignals(mkReport({ dynamics: many }))
    eq(r.total, MAX_SIGNALS + 3)
    eq(r.signals.length, MAX_SIGNALS)
  })

  it('超长原文截断，不把整篇报道搬进索引卡', () => {
    const long = '起诉'.repeat(200)
    const r = buildRiskSignals(mkReport({ dynamics: [dyn({ title: long })] }))
    ok(r.signals[0].text.length < long.length, '应被截断')
    ok(r.signals[0].text.endsWith('…'), `截断应留省略号，实际结尾：${r.signals[0].text.slice(-5)}`)
  })

  it('类别常量与标签一一对应（页面按 RISK_CATEGORIES 出分布标签）', () => {
    eq(RISK_CATEGORIES.length, 5)
    for (const c of RISK_CATEGORIES) ok(!!RISK_CATEGORY_LABEL[c], `缺标签：${c}`)
  })

  it('同一份报告多次扫描结果一致（纯函数）', () => {
    const rep = mkReport({ dynamics: [dyn({ title: '起诉' })] })
    deepEq(buildRiskSignals(rep), buildRiskSignals(rep))
  })
})

/* -------------------------------------------------- 报告目录 utils/report-toc（本轮） */

describe('报告目录 utils/report-toc', () => {
  const {
    buildReportToc,
    buildReportTocGroups,
    lockedReportToc,
    REPORT_TEMPLATE,
    TOC_GROUPS,
    TEMPLATE_SIZE,
    FREE_TOC_COUNT,
    MEMBER_TOC_COUNT,
    memberOnlyTocLabels
  } = env.load('utils/report-toc')

  /* 顺序必须与 package/report/index.tsx 的卡片渲染顺序一致：
     目录点了却到别处，比没有目录更糟。 */
  const FULL_ORDER = [
    'sec-overview',
    'sec-intro',
    'sec-verdict',
    'sec-profile',
    'sec-relations',
    'sec-commercial',
    'sec-endorsement',
    'sec-dynamics',
    'sec-quotes',
    'sec-analysis',
    'sec-controversies',
    'sec-risk',
    'sec-member',
    'sec-peers',
    'sec-affiliation',
    'sec-stance',
    'sec-timeline',
    'sec-glossary'
  ]

  const fullReport = () =>
    mkReport({
      profile: [{ label: '职业', value: '演员', basis: 'b' }],
      relations: [{ name: '某某', relation: '合作', note: 'n', basis: 'b' }],
      controversies: [{ topic: 't', claim: 'c', response: 'r', basis: 'b' }],
      endorsements: [{ brand: '某品牌', kind: 'endorse', note: 'n', basis: 'b' }],
      glossary: [{ term: 't', explain: 'e', basis: 'b' }],
      verdict: { summary: 's', positioning: 'p' }
    })

  it('完整报告 + 会员：18 节齐、顺序与卡片一致', () => {
    const toc = buildReportToc(fullReport(), { member: true, hasOverview: true })
    deepEq(toc.map((s) => s.id), FULL_ORDER)
  })

  /*
   * 2026-10-10 分档（需求「目录配成模板」）：免费档 = 事实与判断，会员档 = 商业速览 + 会员专享。
   * 2026-10-12 调整（方案 A 轻量版）：把「立场与舆情 / 后续关注 / 名词解释」移入会员档，并新增
   * 「同领域坐标」。这三节仍在**免费批次**里生成（对比页 / 话题速览 / 问答要用），只是免费不列卡。
   * 名单在这里也写一份，是为了**钉住边界** —— 挪一节进出会员档，这两组常量与权益文案
   * （utils/member.ts#MEMBER_BENEFIT_POINTS，03-quota-qa.js 已钉住同源）必须一起改。
   * 2026-10-10 二改：三张工具视图（关键词云 / 语录主题 / 热度趋势）已删除，会员档从 5 节缩到 2 节。
   */
  const MEMBER_ONLY_ORDER = [
    'sec-commercial',
    'sec-endorsement',
    'sec-member',
    'sec-peers',
    'sec-affiliation',
    'sec-stance',
    'sec-glossary'
  ]
  const FREE_ORDER = FULL_ORDER.filter((id) => !MEMBER_ONLY_ORDER.includes(id))

  it('免费用户只列免费档那几节：会员档 7 节一个都不进目录', () => {
    const toc = buildReportToc(fullReport(), { member: false, hasOverview: true })
    deepEq(toc.map((s) => s.id), FREE_ORDER)
    for (const id of MEMBER_ONLY_ORDER) notOk(toc.some((s) => s.id === id), `免费目录不该有 ${id}`)
    /* 反向：免费档的节不能被顺手滤掉（timeline 被周报复用，risk 与风险监控同源） */
    for (const id of ['sec-timeline', 'sec-risk']) {
      ok(toc.some((s) => s.id === id), `免费目录丢了 ${id}`)
    }
  })

  it('模板是目录 / 权益文案的唯一来源：顺序、档位、节数都可被断言', () => {
    eq(TEMPLATE_SIZE, FULL_ORDER.length)
    deepEq(REPORT_TEMPLATE.map((s) => s.id), FULL_ORDER)
    eq(FREE_TOC_COUNT + MEMBER_TOC_COUNT, TEMPLATE_SIZE)
    eq(MEMBER_TOC_COUNT, MEMBER_ONLY_ORDER.length)
    deepEq(memberOnlyTocLabels(), ['商业速览', '商业合作', '会员专享', '同领域坐标', '企业关联', '立场与舆情', '名词解释'])
    for (const s of REPORT_TEMPLATE) ok(s.tier === 'free' || s.tier === 'member', `档位异常：${s.id}`)
    for (const s of REPORT_TEMPLATE) eq(typeof s.visible, 'function', `${s.id} 缺可见性条件`)
  })

  it('分组目录与平铺目录同源（2026-10-10 三改）：拍平后逐项相等，一节都没重排', () => {
    /*
     * 页面展开态渲染的是 buildReportTocGroups（组标签 + 组内胶囊格），而标题上的「目录 · N 节」
     * 与跳转目标出自 buildReportToc。两者若各算一套，症状是「标题说 18 节、格子里 17 颗」
     * 或「点得到但排到了别处」。故这里钉住「分组只是切块」：拍平必须与原样平铺逐项相等。
     */
    const groups = buildReportTocGroups(fullReport(), { member: true, hasOverview: true })
    const flat = groups.flatMap((g) => g.sections.map((s) => s.id))
    deepEq(flat, FULL_ORDER, '分组不得增删或重排任何一节 —— 目录的顺序就是卡片的顺序')
    eq(new Set(flat).size, flat.length, '同一节不能同时落进两个组')
    for (const g of groups) ok(g.sections.length > 0, `空组不该返回（会多一行没有胶囊的标题）：${g.key}`)
    /* 组标签全部有值，且组间顺序与 TOC_GROUPS 一致 */
    deepEq(groups.map((g) => g.key), TOC_GROUPS.map((g) => g.key).filter((k) => groups.some((x) => x.key === k)))
    for (const g of groups) ok(!!g.label, `组 ${g.key} 缺标签`)
    /* 免费档同样成立（少掉会员档那 5 节，组可能因此消失，但剩下的一节都不能挪位） */
    const freeGroups = buildReportTocGroups(fullReport(), { member: false, hasOverview: true })
    deepEq(freeGroups.flatMap((g) => g.sections.map((s) => s.id)), FREE_ORDER)
    /* 没有报告 / 降级到只剩兜底卡时，行为与平铺一致 */
    deepEq(buildReportTocGroups(null, { member: true, hasOverview: true }), [])
    deepEq(
      buildReportTocGroups(mkReport({ degraded: true }), { member: true, hasOverview: false }).flatMap((g) =>
        g.sections.map((s) => s.id)
      ),
      ['sec-analysis']
    )
  })

  it('同一组在模板里必须连续（分组的硬约束，断一次顺序就不对了）', () => {
    /*
     * buildReportTocGroups 的做法是「按 group 切块、组内保持模板顺序」：只要某一组的节在模板里
     * 不连续，切块就会把后出现的那些节提前 —— 拍平顺序与卡片顺序不一致，用户点完一节往下滑，
     * 看到的却是另一组的卡（上一条用例会因此报红）。这条用例把约束钉在模板本身，
     * 报错信息能直接指出是哪一节把分组打断了。
     * 新增一节时请放进它语义所属的组，并且放在该组那一段的末尾（或同组相邻处）。
     */
    const keys = TOC_GROUPS.map((g) => g.key)
    for (const s of REPORT_TEMPLATE) ok(keys.includes(s.group), `${s.id} 的分组「${s.group}」未在 TOC_GROUPS 里声明`)
    const seen = new Set()
    let prev = ''
    for (const s of REPORT_TEMPLATE) {
      if (s.group !== prev) {
        notOk(seen.has(s.group), `${s.id} 所在的分组 ${s.group} 被拆成了两段（不连续）`)
        seen.add(s.group)
        prev = s.group
      }
    }
    /* 每个组至少得有一节，否则页面上会出现一行没有内容的组标题 */
    for (const g of TOC_GROUPS) {
      ok(REPORT_TEMPLATE.some((s) => s.group === g.key), `分组 ${g.key} 一节都没有，标签不该存在`)
    }
  })

  it('免费用户的「会员另含 N 节」提示：按「会员会看到什么」判，会员自己为空', () => {
    const locked = lockedReportToc(fullReport(), { member: false, hasOverview: true })
    deepEq(locked.map((s) => s.id), MEMBER_ONLY_ORDER)
    eq(locked.length, MEMBER_TOC_COUNT)
    /* 会员自己看得见，不需要这行提示 */
    deepEq(lockedReportToc(fullReport(), { member: true, hasOverview: true }), [])
    /* 降级简版只剩兜底卡，本来就没有会员档的内容，不该再说「另含 5 节」 */
    deepEq(lockedReportToc(mkReport({ degraded: true }), { member: false, hasOverview: false }), [])
    /* 没有报告就没有目录，也就没有提示 */
    deepEq(lockedReportToc(null, { member: false, hasOverview: true }), [])
    deepEq(lockedReportToc(undefined, { member: false, hasOverview: true }), [])
  })

  it('算不出覆盖范围时也不列「人物速览」的空态卡', () => {
    const toc = buildReportToc(fullReport(), { member: true, hasOverview: false })
    notOk(toc.some((s) => s.id === 'sec-overview'))
  })

  it('降级简版：结构化节全部不收，只留确实会渲染的那几张兜底卡', () => {
    const toc = buildReportToc(
      mkReport({ degraded: true, intro: '一段简版简介', analysis: '简版点评' }),
      { member: true, hasOverview: false }
    )
    deepEq(toc.map((s) => s.id), ['sec-intro', 'sec-analysis'])
  })

  it('降级简版且没有 intro 时连「简介」也不列（空态卡与实体卡两个分支都不成立）', () => {
    const toc = buildReportToc(mkReport({ degraded: true }), { member: true, hasOverview: false })
    deepEq(toc.map((s) => s.id), ['sec-analysis'])
  })

  it('老报告（缺第二批字段）不列这些节 —— 键不存在与键为空数组是两回事', () => {
    /* 用会员档读：endorsement / glossary 现在属会员档，拿免费档测会「测了个空」（免费本来就不列），
       测不出「老报告缺这个键」这件事 */
    const toc = buildReportToc(mkReport(), { member: true, hasOverview: true })
    for (const id of ['sec-profile', 'sec-relations', 'sec-endorsement', 'sec-glossary']) {
      notOk(toc.some((s) => s.id === id), `老报告不该出现 ${id}`)
    }
  })

  it('P2-13：缺 controversies 字段也要列「争议与回应」（页面缺这段时有说明卡，目录得点得到）', () => {
    const toc = buildReportToc(mkReport(), { member: false, hasOverview: true })
    ok(toc.some((s) => s.id === 'sec-controversies'))
    /* 降级简版是唯一不收它的情形 */
    notOk(buildReportToc(mkReport({ degraded: true }), { member: false, hasOverview: false }).some((s) => s.id === 'sec-controversies'))
  })

  it('没有报告时给空目录（页面据此不出目录条）', () => {
    deepEq(buildReportToc(null, { member: true, hasOverview: true }), [])
    deepEq(buildReportToc(undefined, { member: false, hasOverview: false }), [])
  })

  it('id 不重复（锚点重复会跳到第一处）、label 都不为空', () => {
    const toc = buildReportToc(fullReport(), { member: true, hasOverview: true })
    eq(new Set(toc.map((s) => s.id)).size, toc.length)
    for (const s of toc) ok(s.id.startsWith('sec-') && !!s.label, `异常条目：${JSON.stringify(s)}`)
  })
})

/* --------------- 报告页渲染条件与刷新入口（源码钉住，P2-12 / P2-13 / P2-18 / P2-19 / 浮层层级） */

/*
 * 报告页是 tsx，跑不进 Node（无 DOM），但它有三类口径与纯逻辑是**平行**的两份：
 *   · 卡片渲染条件 ↔ utils/report-toc（目录点了却到别处）；
 *   · 「刷新最新」的可用性 ↔ 状态行（同一件事给出两个相反答案）；
 *   · 刷新浮层的层级 ↔ app.scss 的 `.glow-page > view`（组件里写了 fixed 也会被页面样式盖掉）。
 * 这类错只有线上才暴露，故这里读源码把口径钉住。改页面条件 / 容器样式必须同步这几条断言。
 */
describe('报告页渲染条件（P2-12 / P2-13 / P2-18 / P2-19 / 刷新浮层层级）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'package', 'report', 'index.tsx'), 'utf8')
  /** 取 needle 前后的一段源码，用于断言「某元素/常量处在什么条件下」 */
  const around = (needle, before = 60, after = 0) => {
    const at = src.indexOf(needle)
    return at < 0 ? '' : src.slice(Math.max(0, at - before), at + needle.length + after)
  }

  it('P2-12：保留提示的段名走 keptNames / MEMBER_SECTIONS 派生，不写死固定段名', () => {
    ok(src.includes('presentSections(report) : memberLocked'), '会员与免费两条来源都从数据里取实际存在的段')
    ok(src.includes("keptSections.length > 0 ? keptSections : MEMBER_SECTIONS"), '兜底用 MEMBER_SECTIONS')
    ok(src.includes('${keptNames}'), '提示文案须插值 keptNames，而不是写死段名')
    ok(src.includes("MEMBER_SECTIONS.join('、')"), '「补齐」说明同样从 MEMBER_SECTIONS 派生')
    notOk(/['"]对比视角['"]/.test(src), '段名不得作为字符串常量写死在页面里')
  })

  it('会员档标题写法一致：前缀「会员专享 · 」，右侧不挂角标', () => {
    /*
     * 二次调整（本机反馈「去除右侧会员专享字样，保持和深度解析一样的标题」）：
     * 一改给四节挂的是右侧角标，而深度解析那张把「会员专享」写在标题里 —— 同一档东西
     * 于是有两种写法，读起来的观感是「这几张和那张不是一回事」。现统一为**标题前缀**。
     * 2026-10-10 三改：三张工具视图已删，会员档只剩「商业速览」用前缀写法（深度解析本来如此）。
     */
    ok(
      src.includes(`<View className='card-title'>会员专享 · 商业价值速览</View>`),
      '商业价值速览要用前缀写法（与深度解析一致）'
    )
    /* 深度解析那张本就如此，且会员页文案引用了这个字符串，不改它 */
    ok(src.includes('会员专享 · 深度解析'), '深度解析保持原样')
    /* 2026-10-12 新增 / 移入的会员档卡片同样走前缀写法（本机反馈：商业合作 / 立场与舆情 /
       名词解释三张漏了前缀，观感上不再是「会员专享」那一档） */
    ok(src.includes('会员专享 · 商业合作与代言'), '商业合作与代言要用前缀写法')
    ok(src.includes('会员专享 · 立场与舆情'), '立场与舆情要用前缀写法')
    ok(src.includes('会员专享 · 名词解释'), '名词解释要用前缀写法')
    /*
     * 判「角标那个具体用法」而**不判类名** —— 报告页的**会员促销条**用的是同一个
     * `page-report__vip`（另一个组件，与本组标题无关）。`__card-head` 只服务角标，一并废弃。
     */
    eq((src.match(/className='page-report__vip'>会员专享</g) || []).length, 0, '右侧角标不该再有使用点')
    eq((src.match(/className='page-report__card-head'/g) || []).length, 0, '__card-head 只服务角标，一并废弃')

    const scss = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'package', 'report', 'index.scss'),
      'utf8'
    )
    /* 判「选择器定义」而不是裸名字：注释里会提到这个名字，拿它判会自己撞自己 */
    ok(!scss.includes('&__card-head {'), '废弃的容器样式要一并删掉（留着就是死代码）')
    /*
     * 促销条的样式必须留着：它与本次删掉的标题角标**同名**（都叫 `&__vip`），
     * 同名在 CSS 里是属性级互相覆盖 —— 删错一个就是促销条失去布局。
     * 而它此前恰恰被角标那份覆盖过（两处同名定义并存），本次删除顺带修好了这一点。
     */
    ok(
      scss.includes('&__vip {') && scss.includes('&__vip-tag'),
      '促销条的 &__vip / &__vip-tag 不能被误删'
    )
  })

  it('大模型调用的入参与返回都进控制台（rawIoLog 打开时）', () => {
    const llm = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'utils', 'llm.ts'), 'utf8')
    /* 只打返回的话，「这句回答为什么长这样」是无从下手的：看不出问的是什么、用的哪一档 */
    ok(/debugRaw\('llm:proxy:req',\s*\{[^}]*messages/s.test(llm), '入参没打印（必须含 messages）')
    ok(llm.includes("debugRaw('llm:proxy', res)"), '返回没打印')
    ok(llm.includes("debugRaw('llm:proxy:err', err)"), '链路异常要连原始对象一起打印')
  })

  it('P2-13：争议卡以 !report.degraded 为条件（缺键也出卡，不能静默隐藏合规相关段落）', () => {
    const cond = around("id='sec-controversies'", 60)
    ok(cond.includes('!report.degraded'), `争议卡的外层条件应为 !report.degraded，实际：${cond}`)
    ok(src.includes('这一段缺数据与「确认没有争议」不是一回事'), '缺键要出说明卡，而不是整卡消失')
  })

  it('报告分档两侧一致（2026-10-10）：会员档的卡在页面里也判了 member', () => {
    /*
     * 档位口径只写在 utils/report-toc.ts（REPORT_TEMPLATE 的 tier），但**页面得自己再判一次**
     * `member` —— 这两处一错开，症状是「目录里不列、页面却有卡」或「目录列了却点不到」，
     * 而且只在免费账号上出现（开发时多是会员态，测不到）。故分档必须两侧一起钉住。
     * 允许中间夹注释 / 换行（`[\s\S]{0,60}`，源码是 CRLF，窗口要留够），但条件本身必须是那一句。
     */
    ok(src.includes('{member && commercial && !report.degraded && ('), '商业速览属会员档')
    ok(src.includes('{member && !report.degraded && ('), '会员专享（深度解析）卡也要 member 门槛')
    /* 2026-10-12：立场与舆情 / 名词解释 已移入会员档（同一时间新增的商业合作与代言、
       同领域坐标也是会员档），页面必须同步加 member 门槛；反之 timeline 仍在免费档（周报依赖），
       前面不该出现 member。两侧一错开的症状是「目录里不列、页面却有卡」或「目录列了却点不到」，
       且只在免费账号上出现。 */
    for (const id of ['sec-peers', 'sec-affiliation', 'sec-stance', 'sec-endorsement', 'sec-glossary']) {
      ok(
        /* 窗口 100：商业合作与代言的卡前面是「member && report.endorsements && !report.degraded &&」，
           比别的卡多一个字段判空，60 字窗口不够（它仍要求门槛与 id 同处一段表达式，不会误命中别处） */
        new RegExp(`member && [\\s\\S]{0,100}id='${id}'`).test(src),
        `${id} 属会员档，卡前面必须有 member 门槛`
      )
    }
    notOk(
      new RegExp(`member && [\\s\\S]{0,60}id='sec-timeline'`).test(src),
      'sec-timeline 属免费档，卡前面不该出现 member 门槛'
    )
    ok(src.includes('lockedReportToc(report,'), '目录底部的「会员另含 N 节」要用模板口径，不另写一套')
  })

  it('时间线按年份切块（跨年履历的脉络感，2026-10-10）', () => {
    /*
     * 时间线是报告里唯一跨年的段落，平铺时「2021-05」「2024-03」混在一起，读者要自己对着
     * 每个日期算。年份小标题把它切成一段段脉络 —— 纯端上按 date 前 4 位切，不改数据、
     * 不重生成，存量报告立即受益。解析不出 4 位年份的条目归入「无年份」组（不显示标题），
     * 不因此丢数据。
     */
    ok(src.includes('const timelineGroups'), '要派生按年份分组的结构')
    ok(src.includes("(t.date || '').slice(0, 4)"), '分组键是 date 前 4 位')
    ok(src.includes('/^\\d{4}$/'), '只有 4 位数字才算年份，否则归入无标题组')
    ok(src.includes('page-report__timeline-year'), '年份小标题要真的渲染出来')
    ok(src.includes('timelineGroups.map'), '渲染走分组，而不是继续平铺 timelineView')
  })

  it('目录展开态：两列胶囊 + 分组（2026-10-10 二改瘦身、三改分组）', () => {
    /*
     * 批 10 把展开态做成竖向时间线（主轴 + 每节一颗节点），视觉成立但**一次占近两屏**
     * （18 行 × 68rpx ≈ 1200rpx）—— 在一个「本来就嫌报告太长」的目录里自相矛盾。
     * 这里钉住「两列 + 没有主轴」：改回单列 / 时间线即红。
     */
    const scss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'package', 'report', 'index.scss'), 'utf8')
    const at = scss.indexOf('&__toc-item {')
    const block = scss.slice(at, at + 700)
    ok(block.includes('width: calc(50% - 12rpx)'), `目录胶囊应为两列，实际：${block.slice(0, 120)}`)
    notOk(block.includes('&::before'), '竖向时间线的主轴必须去掉（它才是占空间的那一半）')
    /* 标签得包一层 Text 才能出省略号（直接写在小程序 View 上不生效） */
    ok(src.includes('page-report__toc-item-text'), '目录标签要包一层 Text 才能省略号')
    /* 免费档的提示行是唯一「还差什么」的说明，必须真的渲染出来 */
    ok(src.includes('会员另含 ${tocLocked.length} 节'), '会员档提示行不得写死节数')

    /*
     * 三改（分组）：数据侧的口径由上面两条用例钉住，这里钉**界面确实用了它** ——
     * 只加数据结构、页面照旧平铺渲染，是最容易发生的「改了等于没改」。
     */
    ok(src.includes('tocGroups.map'), '展开态要渲染分组目录，而不是平铺的 tocSections')
    ok(src.includes('page-report__toc-group-label'), '组标签必须渲染出来（否则分组只是数据结构）')
    notOk(
      /page-report__toc-list'>\s*\{tocSections\.map/.test(src),
      '旧的平铺渲染要彻底换掉，不许两套并存'
    )
    /* 两列的负右外边距得跟着组容器走：留在 __toc-list 上，每组右侧都会窄 12rpx */
    const gAt = scss.indexOf('&__toc-group-items {')
    ok(gAt > 0, '组内容器缺样式（胶囊格的两列技巧挂在它身上）')
    ok(scss.slice(gAt, gAt + 200).includes('margin-right: -12rpx'), '负右外边距要跟着组容器')
  })

  it('P2-18（2026-10-17 再改）：刷新只剩工具卡一个入口，且确认弹窗仍在', () => {
    notOk(/disabled=\{showFresh\}/.test(src), '按钮不再变灰 —— 用户要的是「重新生成随时可用」')
    notOk(/showFresh \? '已是最新' : '刷新最新'/.test(src), '文案不再随状态变化（代价改由确认弹窗说明）')
    ok(src.includes('const requestRefresh = useCallback'), '统一出口必须存在')
    /*
     * 2026-10-10 这条断言要求「两个入口都走唯一出口」（横幅状态行 + 工具卡）。
     * 2026-10-17 用户反馈两者功能重复、措辞还像两件轻重不同的事 ⇒ 入口收成一个。
     * 断言方向随之反转：以前是「至少两处」，现在是**恰好一处**（多一处就是回退），
     * 且被删掉的那个内联链接不许回来。
     */
    const hits = src.split('onClick={() => void requestRefresh()}').length - 1
    eq(hits, 1, `刷新入口只该有工具卡这一处，实际 ${hits} 处`)
    notOk(src.includes('page-report__refresh-link'), '「查看最新」内联链接已随重复入口一起删掉，不许回来')
    ok(src.includes('confirmRefresh'), '点刷新前必须先确认代价')
    ok(src.includes('将消耗 1 次生成次数'), '确认弹窗要说清消耗几次')
    ok(src.includes('生成失败或内容不完整时不计数'), '确认弹窗要给出「不达标不计数」的承诺')
  })

  it('锁态卡：描边显式 2rpx 淡紫、「会员」标签浅底深字（2026-10-17 用户反馈后钉住）', () => {
    /*
     * 用户反馈两条：免费档看会员节时「边框太鲜艳」「会员二字与底色相近看不清」。
     * 成因是两个叠在一起：① `.card` 基类**没有 border**，LockedCard 只写了 border-style
     * 与 border-color，宽度落到默认 medium（≈6rpx）—— 画出来是一圈粗亮紫虚线；
     * ② 「会员」标签是 $brand-soft(#8764ff) 底 + $brand(#5f33e1) 字，明度太近。
     * 一条卡在一屏里出现两三次，两处叠加就成了「一排刺眼的警示框」。
     */
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'package', 'report', 'index.scss'), 'utf8')
    const at = css.indexOf('&__locked {')
    ok(at > 0, '找不到 &__locked 规则')
    const body = css.slice(at, at + 220)
    ok(/border:\s*2rpx\s+dashed/.test(body), '描边必须显式给宽度：只写 style/color 时落到默认 medium，就是那圈粗紫虚线')
    ok(/rgba\(95,\s*51,\s*225,\s*0\.28\)/.test(body), '描边用品牌紫 28% 透明，不用 $brand-soft 实色')
    const tagAt = css.indexOf('&__locked-tag {')
    ok(tagAt > 0, '找不到 &__locked-tag 规则')
    const tagBody = css.slice(tagAt, tagAt + 240)
    ok(/background:\s*\$brand-weak/.test(tagBody), '「会员」标签底色改浅紫（$brand-weak），与工具卡 __tool-vip 同一套')
    ok(/color:\s*\$brand;/.test(tagBody), '「会员」标签字色用深品牌紫')
    notOk(/background:\s*\$brand-soft/.test(tagBody), '不许回到亮紫底压深紫字（18rpx 上会糊成一块色块）')
  })

  it('P2-19：waiting 态有轮询（5s 一次、上限取锁的 BUILDING_TIMEOUT_MS 后转 error），兑现「无需刷新自动展示」的承诺', () => {
    ok(src.includes('WAIT_POLL_MS = 5_000'), '轮询间隔常量缺失')
    ok(src.includes('WAIT_POLL_MAX_MS = BUILDING_TIMEOUT_MS'), '轮询上限必须直接引用 utils/cache.ts#BUILDING_TIMEOUT_MS，不得再写一个数（改了锁就会漂移）')
    ok(src.includes("if (state.phase !== 'waiting') return"), '轮询只在 waiting 态启动')
    ok(src.includes('setInterval'), '必须有轮询定时器（此前一行都没有，等待页永远转不完）')
    ok(src.includes('clearInterval'), '离开该态要清定时器')
  })

  it('时间线条目带上「距今多久」（算出相对时间就必须真的渲染出来）', () => {
    /*
     * utils/time.ts#stampAgo 的用例已经钉住了说法本身，这里钉「页面用了它」——
     * 加了工具却没接上，是最容易发生的「改了等于没改」。
     */
    /* 2026-10-10 起时间线按年份分组（timelineGroups），相对时间仍在每条里算 —— 分组是外壳，stampAgo 是里子 */
    ok(
      /g\.items\.map\(\(t, i\) => \{[\s\S]{0,500}const ago = stampAgo\(t\.date\)/.test(src),
      '时间线要用 stampAgo 算相对时间'
    )
    ok(src.includes('page-report__timeline-meta'), '相对时间要渲染在日期行里（否则工具白算了）')
    /* 不可解析时必须不渲染这一句，不能留下「2021-05 · 」这种没有下文的尾巴 */
    ok(/ago !== '' && /.test(src), 'stampAgo 返回空串时不该渲染这一句')
    const scss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'package', 'report', 'index.scss'), 'utf8')
    ok(scss.includes('&__timeline-meta'), '日期行缺样式（两个 Text 会贴在一起）')
    /* 顺带钉住这条卡片自己的门槛没被顺手改掉（时间线仍只在非降级简版里出现） */
    ok(around("id='sec-timeline'", 60).includes('!report.degraded'), '时间线的可见条件不该被改动')
  })

  it('速览卡末行的点评导读真的接在点评卡上（算了要旨就必须渲染，点了必须去对地方）', () => {
    /*
     * utils/report.ts#reportGist 的取值口径由 03-quota-qa.js 钉住，这里钉「页面用了它」，
     * 以及「点了真的滚到点评卡」：导读最怕两件事 —— 算了不用（改了等于没改），
     * 和锚点接错（点了没反应，而用户会以为是加载慢）。
     */
    ok(src.includes('reportGist'), '速览卡要用 reportGist 取要旨')
    ok(src.includes('{gistRow}'), '取到要旨要真的渲染进速览卡')
    /* 空串时整行不渲染：页面上不能留一行只有「AI 点评」、没有下文的空壳 */
    ok(src.includes("const gist = report ? reportGist(report) : ''"), '没有要旨时不该留下空壳行')
    ok(src.includes("const gistRow = gist !== '' &&"), '没有要旨时不该留下空壳行')
    /* 两个分支都要有：空态卡是老报告（无 coverage）的那一支，漏了它一半的报告看不到导读 */
    eq([...src.matchAll(/\{gistRow\}/g)].length, 2, '空态与常规两个分支都要带上导读')
    ok(src.includes("jumpToSection('sec-analysis')"), '导读必须跳到点评卡，否则这一行没有意义')
    ok(src.includes("id='sec-analysis'"), '锚点指向的节必须真的在页面上（否则点了没反应）')

    const scss = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'package', 'report', 'index.scss'), 'utf8')
    ok(scss.includes('&__gist-text'), '导读句缺样式：会照数值那样加粗，且长句子不封顶')
  })

  it('「重新生成」弹窗在开挂态不念剩余次数（调试开关只松闸门、不改数字）', () => {
    /*
     * 本机反馈的 bug：弹窗说「今日剩余 30/30」，而当天已生成多次。
     * 数据层的修法在 utils/quota.ts（remaining 照实相减 + 另给 unlimited，用例在 03），
     * 这条钉住**展示方真的用了它** —— 否则后端不再撒谎，前端却继续把归零的 remaining
     * 念出来，用户拿到的依然是错的信息。
     */
    ok(src.includes('quota && !quota.unlimited'), '弹窗要按 unlimited 分流措辞')
  })

  it('会员档共用同一层底色（不只是深度解析那一张）', () => {
    /*
     * 本机反馈：报告页「会员专享」的卡与「深度解析」那张长得不一样。
     * 根因是底色只给了后者，商业速览只有一个角标 —— 同一档东西在版面上分成了两类。
     * 现在共享 `page-report__vip-card`（2026-10-10 三改：三张工具视图已删，会员档只剩商业速览）。
     */
    ok(src.includes(`id='sec-commercial' className='card page-report__vip-card'`), '商业速览要套用会员档底色')
    /* 深度解析那张保留自己的别名（它另有两个子元素类 __notes-head / __notes-badge 挂在上面） */
    ok(src.includes("id='sec-member' className='card page-report__notes'"), '深度解析卡保持原类名')
    /*
     * 两种类名必须落在**同一个选择器组**里：否则哪天调底色只改一处，
     * 五节又会长回两种样子 —— 这正是本次要修的那个毛病。
     */
    const scss = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'package', 'report', 'index.scss'), 'utf8')
    ok(/&__notes,\s*&__vip-card\s*\{/.test(scss), '两类名要在同一个选择器组里，改一处即两处同时生效')

    /*
     * 标题也用**同一种写法**（前缀，而不是右侧角标）：五节在版面上应当是一个样子。
     * 一改时四节挂的是角标、深度解析写的是前缀，读起来的观感是「这几张和那张不是一回事」。
     */
    /*
     * 这里只管**底色**。标题写法不在这里判（见「报告页渲染条件」里那条），
     * 也**不判 `page-report__vip` 这个类名** —— 报告页的会员促销条用的是同一个类名。
     */
  })

  it('刷新加载浮层真的浮在最顶层（2026-10-10 四改：`.glow-page > view` 会盖掉组件自己的 fixed）', () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', p), 'utf8')
    const loadingTsx = read('components/report-loading/index.tsx')
    const loadingScss = read('components/report-loading/index.scss')
    const appScss = read('app.scss')

    /*
     * 这条坑的形态很隐蔽：组件写了 `position: fixed` 也写了 z-index，看着没问题，但报告页根节点是
     * `.page-report.glow-page`，而 app.scss 的 `.glow-page > view`（特异性 0,1,1）压过组件选择器
     * （0,1,0），把浮层按回文档流、z-index 压成 1 —— 于是「没浮在最顶层，还被正文压住」。
     * 光读组件的样式永远发现不了，必须同时钉住「组件挂了口子」与「口子确实在 app.scss 里」。
     */
    ok(src.includes("import ReportLoading, { ReportRefreshing }"), '浮层的渲染入口变了，本组断言要同步')
    ok(loadingTsx.includes("className='report-refreshing glow-overlay'"), '根节点必须挂 glow-overlay，否则仍是 relative + z-index:1')
    ok(loadingTsx.includes('catchMove'), '全屏蒙层要拦 touchmove，否则浮层只是看着盖住、底下的报告照滚')
    ok(loadingScss.includes('&__mask'), '要有蒙层才叫「覆盖当前页面」')

    const at = appScss.indexOf('> .glow-overlay')
    ok(at > 0, 'app.scss 必须提供浮层出口 `.glow-page > .glow-overlay`')
    const rule = appScss.slice(at, at + 200)
    ok(rule.includes('position: fixed'), '出口要给回 fixed')
    const z = Number((rule.match(/z-index:\s*(\d+)/) || [])[1])
    ok(Number.isFinite(z), '出口必须给死 z-index —— 只放开 position 不够，组件自己的 z-index 仍会被 `> view` 压成 1')
    ok(z > 1000, `z-index 要压过 custom-tab-bar 的 999 与 share-poster 的 1000，实际 ${z}`)
  })

  it('等待动画播报真实分批进度（2026-10-11：此前只按秒数估算）', () => {
    /*
     * 报告生成是「检索 → 4 批串行」，系统明明知道走到第几批，此前却没有任何出口 ——
     * 加载动画纯按秒数念估算文案。这条钉住整条透传链：真生成时把 progress 从
     * getOrBuildReport 一路喂到等待动画，且新旧两轮之间要复位（残留会让人以为已经生成完）。
     */
    ok(src.includes('onProgress: setProgress'), '生成入口要把进度回调接上，否则进度永远出不来')
    eq((src.match(/setProgress\(null\)/g) || []).length, 2, '每次 load 开头与生成结束各复位一次')
    ok(src.includes('<ReportLoading progress={progress} />'), '全屏等待态要吃真进度')
    ok(src.includes('<ReportRefreshing progress={progress} />'), '刷新浮层（同一颗动画）也要吃真进度')
    /* waiting 态没有本机生成，不该被喂进度（回落到排队文案） */
    ok(src.includes("<ReportLoading mode='waiting' />"), '排队态仍是纯等待，不接生成进度')

    const loading = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'components', 'report-loading', 'index.tsx'),
      'utf8'
    )
    ok(
      loading.includes('正在生成深度报告…（已完成 ${progress.done}/${progress.total} 批）'),
      '阶段文案要报出「已完成 X/Y 批」（真实批数，不是估算）'
    )
    ok(loading.includes('batchStage(progress)'), '生成阶段用真进度替代按秒估算的文案，其余路径回落')
  })

  it('提示条的 ✕ 各关各的（2026-10-10：此前四条共用一个开关，点一个全关）', () => {
    /*
     * 报告页有多条提示条同时在场（刷新失败 / 刷新变化 / 保留旧版 / 不达标 / 降级简版），
     * 它们讲的不是同一件事，用户常常只想关掉已经看懂的那一条。此前四条刷新结果条共用
     * 一个 `refreshNoticeClosed` —— 点任意一条的 ✕，四条一起消失，看起来就像「关错了」。
     * 这里钉住「一个开关只对应一条提示」，改回共用即红。
     */
    const handlers = [...src.matchAll(/<NoticeClose onClose=\{([^}]+)\}/g)].map((m) => m[1].trim())
    ok(handlers.length >= 5, `报告页的提示条都该有关闭键，实际只找到 ${handlers.length} 条`)
    eq(
      new Set(handlers).size,
      handlers.length,
      `每条 ✕ 必须只关自己那一条，出现了重复的同一个开关：${handlers.join(' | ')}`
    )

    const keys = [...src.matchAll(/closeNotice\('(\w+)'\)/g)].map((m) => m[1])
    /* firstBuild（2026-10-15，首建说明条）同样是**独立一格**：它与其余各条讲的事互不相干 */
    deepEq(keys.sort(), [
      'bgGaps',
      'degraded',
      'diff',
      'error',
      'firstBuild',
      'keptMember',
      'keywordUnused',
      'missingGroups',
      'shortfall'
    ])
    for (const k of keys) ok(src.includes(`!closedNotices.${k} &&`), `key ${k} 必须真的接在渲染条件上，否则 ✕ 点了没反应`)

    notOk(/refreshNoticeClosed|warnClosed/.test(src), '旧的「多条共用一个开关」必须彻底拆掉')
    ok(src.includes('setClosedNotices({})'), '每次 load 整体复位，否则新一轮的结果被上一轮的「已关」吞掉')
  })

  it('不达标提示按「值不值得重试」分流文案（P2，2026-10-10）', () => {
    /*
     * 「这次没扣次数」是承诺，「要不要再试一次」是指路 —— 后者必须分情况：
     * 素材本身就不够时劝重试，用户会每次不扣次数、每次都不达标，白等一场，
     * 还会把「素材少」理解成「服务坏了」（判据见 utils/report.ts#shortfallVerdict）。
     */
    ok(src.includes('outcome.shortfallRetryable'), '页面必须接住这次判定的结果')
    ok(src.includes('setShortfallRetryable(false)'), '新一轮要复位，否则上一轮的判断串到这一次')

    const at = src.indexOf('{shortfallRetryable')
    ok(at > 0, '文案要按 shortfallRetryable 分支，不能两条都写死')
    const branch = src.slice(at, at + 400)
    ok(branch.includes('重试通常就好'), '可重试那一支才说「重试通常就好」')
    ok(branch.includes('重新生成通常也不会有变化'), '不可重试那一支要说清重试没用，否则用户会一直点')
  })
})

/* -------------------------------------------------- 商业价值速览 utils/commercial（第 0 期） */

describe('商业价值速览 utils/commercial', () => {
  const { buildCommercialSummary, COMMERCIAL_AXES, MIN_AXES } = env.load('utils/commercial')
  const { buildProfileStats } = env.load('utils/stats')
  const { buildRiskSignals } = env.load('utils/risk')

  /** 一份「要什么有什么」的报告：有素材画像、有动态、有争议段 */
  const richReport = () =>
    mkReport({
      coverage: { items: 12, recent: 4, firstAt: '2026-09-10T00:00:00.000Z', latestAt: '2026-10-05T00:00:00.000Z' },
      dynamics: [dyn({ sentiment: 'positive' }), dyn({ sentiment: 'negative' }), dyn({ sentiment: 'neutral' })],
      controversies: [{ topic: 't', claim: 'c', response: '', basis: 'b' }],
      endorsements: [
        { brand: '品牌A', kind: 'endorse', note: '代言人', basis: 'b' },
        { brand: '品牌B', kind: 'collab', note: '', basis: 'b' }
      ]
    })

  it('分项齐全：顺序固定、每项一句结论 + 一条口径，可跳明细', () => {
    const s = buildCommercialSummary(richReport())
    eq(s.ready, true)
    deepEq(
      s.axes.map((a) => a.key),
      COMMERCIAL_AXES
    )
    eq(s.gaps.length, 0)
    eq(s.axes[0].value, '近 30 天 12 条报道')
    ok(s.axes[0].note.includes('近 7 天 4 条'), '热度口径要摊开近 7 天')
    ok(s.axes[0].note.includes('不是平台热度指数'), '热度必须标明不是平台指数')
    eq(s.axes[1].value, '积极 1 · 中性 1 · 消极 1')
    eq(s.axes[2].value, '收录 1 条，其中 1 条未见公开回应')
    eq(s.axes[3].value, '2 项：品牌A、品牌B')
    ok(s.headline.includes('近 30 天 12 条报道'), '结论句要并上报道热度')
    ok(s.headline.includes('商业合作 2 项'), '结论句要并上商业合作数')
    ok(s.headline.includes('争议 1 条'), '结论句要并上争议数')
  })

  it('锚点都指向本页真实存在的节（否则点了没反应）', () => {
    const s = buildCommercialSummary(richReport())
    for (const a of s.axes) {
      ok(a.anchor.startsWith('sec-'), `锚点异常：${a.anchor}`)
      ok(!!a.anchorLabel, `缺节名：${a.anchor}`)
    }
  })

  it('老报告（无 coverage）用热度分兜底，并写明「本报告没记录原始条数」', () => {
    const s = buildCommercialSummary(mkReport({ heat: 42, dynamics: [dyn({})] }))
    eq(s.axes[0].value, '热度 42/100')
    ok(s.axes[0].note.includes('老报告'), '必须说明是字段缺失，而不是没热度')
  })

  it('算不出就说算不出：没取到报道时热度分项进 gaps（而不是显示 0 条）', () => {
    const s = buildCommercialSummary(mkReport({ heat: 0, coverage: { items: 0, recent: 0 } }))
    notOk(s.axes.some((a) => a.key === 'heat'))
    ok(s.gaps.some((g) => g.label === '报道热度'))
  })

  it('无动态时「报道倾向」进 gaps 并说明对象为 0 条', () => {
    const s = buildCommercialSummary(
      mkReport({ coverage: { items: 5, recent: 1 }, controversies: [] })
    )
    eq(s.gaps.map((g) => g.label).join(','), '报道倾向,商业合作')
    ok(s.gaps[0].reason.includes('0 条'))
  })

  it('争议段：空数组成立（= 确认没有），字段缺失不成立（= 不知道有没有）', () => {
    const cov = { items: 5, recent: 1 }
    const none = buildCommercialSummary(mkReport({ coverage: cov, controversies: [] }))
    eq(none.axes.find((a) => a.key === 'controversy').value, '素材中未见公开争议')

    const old = buildCommercialSummary(mkReport({ coverage: cov }))
    ok(old.gaps.some((g) => g.label === '争议状况' && g.reason.includes('上线前')))
  })

  it('门槛：成立的分项不足 MIN_AXES 时 ready=false（页面据此出「缺什么」说明）', () => {
    eq(MIN_AXES, 2)
    const s = buildCommercialSummary(mkReport({ heat: 0 }))
    eq(s.axes.length, 0)
    eq(s.ready, false)
    eq(s.gaps.length, 4, '四个分项都要说明为什么没有')
  })

  it('数字与数据 Tab、风险雷达同源（不另算一套）', () => {
    const rep = richReport()
    const s = buildCommercialSummary(rep)
    const st = buildProfileStats(rep)
    eq(s.axes[1].value, `积极 ${st.sentiment.positive} · 中性 ${st.sentiment.neutral} · 消极 ${st.sentiment.negative}`)
    eq(s.axes[2].value, `收录 1 条，其中 ${buildRiskSignals(rep).unanswered} 条未见公开回应`)
  })

  it('传入已算好的聚合结果与内部现算完全一致（页面复用同一趟计算）', () => {
    const rep = richReport()
    deepEq(buildCommercialSummary(rep, { stats: buildProfileStats(rep), risk: buildRiskSignals(rep) }), buildCommercialSummary(rep))
  })

  it('不给结论：结果里没有评分 / 星级 / 指数这类字段', () => {
    const s = buildCommercialSummary(richReport())
    for (const bad of ['score', 'rating', 'grade', 'index', 'probability', 'level']) {
      notOk(bad in s, `速览不应出现 ${bad}（它需要推断，不只是素材）`)
    }
    for (const a of s.axes) for (const bad of ['score', 'rating', 'grade']) notOk(bad in a, `分项不应出现 ${bad}`)
  })

  it('同一份报告多次汇总结果一致（纯函数）', () => {
    const rep = richReport()
    deepEq(buildCommercialSummary(rep), buildCommercialSummary(rep))
  })
})

/* ------------------------------- 风险词典两端一致（cloudfunctions/riskWatch ↔ src/utils/risk） */

/**
 * 云函数不能 require 端上 TS（各自独立打包），故 riskWatch 复制了一份词典与判定规则。
 * 这份「同源」是承诺，不是巧合 —— 一旦有人只改一端，两处就会对同一条报道给出不同判断
 * （雷达卡说有、每天检索说没有，或反之）。这里读云函数**源码**抠出字面量逐条比对，
 * 漂移即红。改动词典必须两端一起改。
 */
describe('风险词典两端一致（cloudfunctions/riskWatch ↔ src/utils/risk）', () => {
  const { RISK_TERMS, NEG_WORDS, NEG_WINDOW, RISK_CATEGORY_LABEL, BIDIRECTIONAL_TERMS, RIGHTS_OBJECTS, RIGHTS_AFTER_WINDOW } =
    env.load('utils/risk')
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'cloudfunctions', 'riskWatch', 'index.js'),
    'utf8'
  )

  /** 从云函数源码里抠出顶层 `const NAME = <字面量>` 并求值（数组 / 对象 / 数字） */
  function literal(name) {
    const head = `const ${name} = `
    const at = src.indexOf(head)
    if (at < 0) throw new Error(`云函数源码里未找到 ${head}`)
    const start = at + head.length
    const open = src[start]
    if (open !== '[' && open !== '{') {
      const nl = src.indexOf('\n', start)
      return new Function(`return (${src.slice(start, nl).trim()})`)()
    }
    const close = open === '[' ? ']' : '}'
    let depth = 0
    for (let j = start; j < src.length; j++) {
      if (src[j] === open) depth++
      else if (src[j] === close) {
        depth--
        if (depth === 0) return new Function(`return (${src.slice(start, j + 1)})`)()
      }
    }
    throw new Error(`const ${name} 字面量未闭合`)
  }

  it('词表逐条相同、顺序也相同（命中取第一个词，顺序变了结果就变）', () => {
    const expected = RISK_TERMS.map((t) => ({ word: t.word, category: t.category }))
    deepEq(literal('RISK_TERMS'), expected)
  })

  it('否定词表与窗口相同（「未被起诉」这类必须两端都排除）', () => {
    deepEq(literal('NEG_WORDS'), NEG_WORDS)
    eq(literal('NEG_WINDOW'), NEG_WINDOW)
  })

  it('双向词方向判定同源（「起诉造谣者」两端都要判成维权，不能一端司法一端维权）', () => {
    deepEq(literal('BIDIRECTIONAL_TERMS'), BIDIRECTIONAL_TERMS)
    deepEq(literal('RIGHTS_OBJECTS'), RIGHTS_OBJECTS)
    eq(literal('RIGHTS_AFTER_WINDOW'), RIGHTS_AFTER_WINDOW)
  })

  it('类别标签相同（预警页按 category_label 展示，两端口径须一致）', () => {
    deepEq(literal('CATEGORY_LABEL'), RISK_CATEGORY_LABEL)
  })

  it('级别只由类别决定：司法/税务高、合作/维权中、回应低', () => {
    deepEq(literal('LEVEL_OF'), { judicial: 'high', tax: 'high', contract: 'mid', rights: 'mid', statement: 'low' })
  })
})

/* --------------------------------------- 名人风险监控 utils/risk-watch（纯逻辑） */

describe('名人风险监控 utils/risk-watch（纯逻辑）', () => {
  const {
    personWatchId,
    isMonitored,
    isMonitoredName,
    sortSignals,
    groupSignals,
    seenLabel,
    SIGNALS_PER_PERSON
  } = env.load('utils/risk-watch')

  const sig = (over = {}) =>
    Object.assign(
      {
        id: 'x',
        person_key: '雷军#tech',
        name: '雷军',
        level: 'low',
        category: 'statement',
        category_label: '回应表态',
        keyword: '澄清',
        title: '标题',
        quote: '摘录',
        source: '来源',
        url: 'https://example.com/a',
        first_seen_at: '2026-10-01T00:00:00.000Z'
      },
      over
    )

  it('监控主键带 person# 前缀（与关键词订阅 openid#关键词 不撞主键）', () => {
    eq(personWatchId('u1', '雷军#tech'), 'u1#person#雷军#tech')
  })

  it('isMonitored 只看 person_key', () => {
    const rows = [{ id: 'a', openid: 'u1', keyword: '雷军', person_key: '雷军#tech', created_at: '', seen_at: null }]
    ok(isMonitored(rows, '雷军#tech'))
    notOk(isMonitored(rows, '其他人#tech'))
  })

  it('isMonitoredName：只认字面相同的人名（预警页「开始监测」前的重复提醒）', () => {
    const rows = [{ id: 'a', openid: 'u1', keyword: '雷军', person_key: '雷军#tech', created_at: '', seen_at: null }]
    /* 归一化后相同即命中（首尾空白、连续空白都不算差异，与 addWatch 同一口径） */
    eq(isMonitoredName(rows, ' 雷军 ')?.person_key, '雷军#tech')
    eq(isMonitoredName(rows, '雷军')?.keyword, '雷军')
    /* 更长/更短的字面不拦：这类词只能靠关键词监测收到，拦下就是误报 */
    eq(isMonitoredName(rows, '雷军 发布会'), null)
    eq(isMonitoredName(rows, '雷'), null)
    /* 空输入与空名单不炸 */
    eq(isMonitoredName(rows, ''), null)
    eq(isMonitoredName(rows, '   '), null)
    eq(isMonitoredName([], '雷军'), null)
  })

  it('排序：司法/税务（high）在前，同类按「第一次见到」倒序', () => {
    const rows = sortSignals([
      sig({ id: 'a', level: 'low', first_seen_at: '2026-10-05T00:00:00.000Z' }),
      sig({ id: 'b', level: 'high', first_seen_at: '2026-10-01T00:00:00.000Z' }),
      sig({ id: 'c', level: 'mid', first_seen_at: '2026-10-03T00:00:00.000Z' })
    ])
    deepEq(rows.map((r) => r.id), ['b', 'c', 'a'])
  })

  it('分组：按人聚合，组间按最近一条信号时间倒序，组名取信号里的 name', () => {
    const groups = groupSignals([
      sig({ id: '1', person_key: 'A#tech', name: 'A', first_seen_at: '2026-10-01T00:00:00.000Z' }),
      sig({ id: '2', person_key: 'B#tech', name: 'B', first_seen_at: '2026-10-05T00:00:00.000Z' })
    ])
    deepEq(groups.map((g) => g.personKey), ['B#tech', 'A#tech'])
    eq(groups[0].name, 'B')
  })

  it('每人最多列 SIGNALS_PER_PERSON 条（不把页面撑成流水账）', () => {
    const many = Array.from({ length: SIGNALS_PER_PERSON + 5 }, (_, i) =>
      sig({ id: `s${i}`, first_seen_at: `2026-10-${String((i % 9) + 1).padStart(2, '0')}T00:00:00.000Z` })
    )
    eq(groupSignals(many)[0].signals.length, SIGNALS_PER_PERSON)
  })

  it('seenLabel：今天 / 昨天 / 具体月日，now 可注入；非法时间返回空串', () => {
    const now = new Date('2026-10-09T12:00:00.000Z')
    eq(seenLabel('2026-10-09T08:00:00.000Z', now), '今天')
    eq(seenLabel('2026-10-08T08:00:00.000Z', now), '昨天')
    eq(seenLabel('2026-09-28T08:00:00.000Z', now), '09-28')
    eq(seenLabel('', now), '')
  })
})

/* ------------------------------------------- 消歧候选净化 utils/disambiguate（P2-17，2026-10-09） */

/*
 * 模型回传的 candidate.name 会直接进 personKey（`名字#领域码`）并落库，此前没有任何约束。
 * 这组用例钉住三道净化：把 `#` 挡在名字外、把整句描述截短、把明显不是同一人的候选过滤掉 ——
 * 但**不一律丢弃**（昵称 / 艺名场景下一个字都不共享是正常的，全丢会让用户查不到人）。
 */
describe('消歧候选净化 utils/disambiguate（P2-17）', () => {
  const { nameRelated, sanitizeCandidates } = env.load('utils/disambiguate')
  const { buildPersonKey } = env.load('config/domains')

  const cand = (name, domain = 'ent', brief = '') => ({ name, domain, brief })

  it('nameRelated：中文只认共享汉字（宽松到只拦明显不是同一人）', () => {
    ok(nameRelated('张三', '张三'))
    ok(nameRelated('小李', '李某某'), '「小李」↔「李某某」靠共享的「李」')
    notOk(nameRelated('张三', '李四'), '一个汉字都不共享则判为无关')
  })

  it('nameRelated：拉丁 / 混合串看包含关系或共享 ≥3 字符', () => {
    ok(nameRelated('Jay', 'Jay Chou'), '拉丁串互相包含即算相关')
    ok(nameRelated('abcde', 'abcfg'), '共享 a/b/c 三个字符')
    notOk(nameRelated('ab', 'xy'), '既不含也不足 3 个共享字符')
  })

  it('nameRelated：空输入一律判为无关（不炸、不误放行）', () => {
    notOk(nameRelated('', '张三'))
    notOk(nameRelated('张三', ''))
    notOk(nameRelated('   ', '张三'))
  })

  it('净化：名字里的 # / ＃ 必须去掉（否则 personKey 会被切错位、同人分裂成两行缓存）', () => {
    const a = sanitizeCandidates('张三', [cand('张#三')])
    eq(a[0].name, '张三')
    eq(buildPersonKey(a[0].name, a[0].domain).split('#').length, 2, '主键只能有一个分隔符')

    const b = sanitizeCandidates('李四', [cand('李＃四')])
    eq(b[0].name, '李四')
    eq(buildPersonKey(b[0].name, b[0].domain).split('#').length, 2)
  })

  it('净化：换行 / 连续空白折成单空格，首尾去空白', () => {
    const out = sanitizeCandidates('A', [cand('  张\n\t三  '), cand('李   四')])
    eq(out[0].name, '张 三')
    eq(out[1].name, '李 四')
  })

  it('净化：名字截到 30 字（模型把一整句描述当名字时收口）、brief 截到 60 字', () => {
    const out = sanitizeCandidates('演员', [cand('演'.repeat(40), 'ent', '简'.repeat(80))])
    eq(out[0].name.length, 30)
    eq(out[0].brief.length, 60)
  })

  it('净化：清完为空的候选被丢弃', () => {
    deepEq(sanitizeCandidates('A', [cand('#'), cand('   '), cand('张三')]).map((c) => c.name), ['张三'])
  })

  it('净化：同一位（同名同领域）只留第一条，同名不同领域各自保留', () => {
    const out = sanitizeCandidates('张三', [cand('张三', 'ent', '第一个'), cand('张三', 'ent', '重复'), cand('张三', 'tech')])
    eq(out.length, 2)
    eq(out[0].brief, '第一个')
    deepEq(out.map((c) => c.domain), ['ent', 'tech'])
  })

  it('相关性过滤：有相关的就只留相关的', () => {
    const out = sanitizeCandidates('张三', [cand('张三', 'ent'), cand('李四', 'tech')])
    deepEq(out.map((c) => c.name), ['张三'], '输入「张三」不该混进「李四」的报告')
  })

  it('相关性过滤：一个都不相关时原样交回（昵称 / 艺名不能全丢，否则用户一屏空）', () => {
    const out = sanitizeCandidates('小甜甜', [cand('布兰妮', 'ent')])
    deepEq(out.map((c) => c.name), ['布兰妮'], '过滤后为空则交回净化后的候选')
  })
})

/* ------------------------------------------------ iOS 虚拟支付门禁 utils/pay（P2-20，2026-10-09） */

/*
 * 会员是虚拟商品，微信不允许在 iOS 小程序内支付（请求被平台拒、提审也会被驳回）。
 * 门禁必须在**拉起收银台之前**、且收口在唯一下单函数里（会员入口有多处，藏一处漏一处）。
 * 环境分叉靠 Taro.getSystemInfoSync().platform 判定 —— 用 env.setTaroOverride 逼出真机分支。
 */
describe('iOS 虚拟支付门禁 utils/pay（P2-20）', () => {
  const { isIapBlocked, buyMembership } = env.load('utils/pay')

  it('默认环境（devtools / 安卓）不拦，开发者照常联调', () => {
    env.resetData()
    notOk(isIapBlocked())
  })

  it('platform=ios（含大小写）判定为拦下', () => {
    env.resetData()
    env.setTaroOverride('getSystemInfoSync', () => ({ platform: 'ios' }))
    ok(isIapBlocked())
    env.setTaroOverride('getSystemInfoSync', () => ({ platform: 'iOS' }))
    ok(isIapBlocked(), '大小写不敏感')
  })

  it('读不到环境信息时不拦（宁可让平台拒一次，也不凭猜测挡掉能买的用户）', () => {
    env.resetData()
    env.setTaroOverride('getSystemInfoSync', () => {
      throw new Error('boom')
    })
    notOk(isIapBlocked())
  })

  it('iOS 上 buyMembership 在拉起收银台 / 打云函数之前就返回 blocked=ios', async () => {
    env.resetData()
    env.setTaroOverride('getSystemInfoSync', () => ({ platform: 'ios' }))
    let called = false
    env.registerCloudFn('payCreate', () => {
      called = true
      return { ok: true }
    })

    const res = await buyMembership('monthly')
    eq(res.ok, false)
    eq(res.blocked, 'ios')
    eq(res.paid, false)
    notOk(called, '门禁必须早于云函数与收银台，否则只是把失败推迟一步')
    ok(/iOS/.test(res.error), '给的是「换个地方买」的出路，不是技术报错')
  })

  it('云端未配置支付通道时返回 blocked=unconfigured，并把运维文案换成用户能懂的说明', async () => {
    env.resetData()
    env.registerCloudFn('payCreate', () => ({
      ok: false,
      kind: 'unconfigured',
      error: '请在环境变量里设置 WX_PAY_MCHID'
    }))

    const res = await buyMembership('monthly')
    eq(res.ok, false)
    eq(res.blocked, 'unconfigured')
    notOk(/WX_PAY_MCHID/.test(res.error), '不该把运维文案直接弹给用户')
  })

  it('未选套餐时直接拒绝，且不带 blocked（这不是环境问题）', async () => {
    env.resetData()
    const res = await buyMembership('')
    eq(res.ok, false)
    eq(res.blocked, undefined)
  })
})

/* ------------------------------- 同名不同人：头像按领域取图 */

/**
 * 同名不同人（张三#文娱 vs 张三#科技）若只按名字查头像，会拿到同一批图、选出同一张。
 * 承诺：端上 ensurePortrait 把「领域中文标签」带给云端，云端把它拼进博查查询词 —— 两端各钉一处。
 */
describe('同名不同人：头像按领域取图（portrait.ts ↔ aiProxy#handlePortrait）', () => {
  const front = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'utils', 'portrait.ts'),
    'utf8'
  )
  const cloud = fs.readFileSync(
    path.join(__dirname, '..', '..', 'cloudfunctions', 'aiProxy', 'index.js'),
    'utf8'
  )

  it('端上 ensurePortrait 把领域中文标签带给云端', () => {
    ok(/action:\s*'portrait'[\s\S]*?domain:\s*domainQuery/.test(front), 'portrait.ts 调 aiProxy 时应带上 domain')
    ok(front.includes('domainLabel'), '端上应引用 domainLabel 把领域码转中文标签')
    ok(front.includes("!== '其他'"), '「其他」领域不应拼进查询词')
  })

  it('云端 handlePortrait 把领域拼进博查查询词', () => {
    ok(cloud.includes('const domain = trimStr(event.domain)'), 'aiProxy 应读取 event.domain')
    ok(cloud.includes('`${name} ${domain}`'), '查询词应带「名字 + 领域」')
  })
})
