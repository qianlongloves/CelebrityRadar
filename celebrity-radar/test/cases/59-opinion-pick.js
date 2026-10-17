'use strict'

/**
 * 舆情页冷启动推荐（S1-4 / 决策 D2，2026-10-16）。
 *
 * ## 背景
 *
 * pages/opinion 是四个 tab 里唯一一个「每天都值得打开」的页面，但它对**新用户是一页零**：
 * 简报四格全是 0、今日要点没有、事件时间线没有 —— 因为那三块的输入全是「用户主动建立的关系」
 * （关注 / 监控词 / 监控人），新用户一条都没有。S1-4 就是补这一块。
 *
 * ## D2 拍板了什么（本文件钉的就是这份规则）
 *
 * 原提案是「新用户进舆情页就替他预置 2-3 个监控」。**落地时否掉了自动预置**，三条理由
 * 任一条都足以否掉：
 *   ① `monitorPerson` 的第一条异步是订阅授权，微信只认「点击后的第一个异步调用」⇒
 *      非点击触发的预置**拿不到推送授权**，而它的既有取舍是「授权失败照常建监控」
 *      ⇒ 自动预置产出**哑监控**（用户以为盯上了，却永远不会收到提醒）—— 比空态更糟；
 *   ② 「监控某人」免费档**只有 3 个额度**，自动预置正好一次占满 ⇒ 用户随后想盯自己关心的人时
 *      撞「超限，先取消一个再加」，开局即负债；
 *   ③ 新用户没有任何个性化信号（history / follows / watches 全空）⇒「预置谁」只能是平台挑的热门，
 *      等于在他还没表达过兴趣的维度上替他把额度花掉。
 * ⇒ 所以改为**只给候选、由用户点**（点一次建一个，授权天然满足），并把来源与代价写在点击之前。
 *
 * 本文件钉六件事：
 *   ① 上限 `PICK_LIMIT` = min(3, 免费档监控人数上限) —— 推荐量不许超过用户能建的量；
 *   ② `pickMonitorCandidates` 纯函数：历史优先 → 榜单补齐、两个维度去重、排除已监控、脏输入不抛；
 *   ③ `shouldShowPick`：只在真冷启动且没关过时显示，**算不出关系数就不显示**；
 *   ④ 本机「已关闭」标记：读 / 写 / 清（清空数据、注销、撤回同意三处都要清）；
 *   ⑤ 页面接线：**不自动建**、动作是 `monitorPerson` 且是点击后的第一个 await、
 *      出现位置在简报之前、不复用被形态锁钉死的 `page-opinion__more`、不引入会员态变量；
 *   ⑥ 文案：如实说明来源 + 写明代价（不许暗示「你可能认识」，也不许写死档位数字）。
 *
 * 纯函数直接 require 编译产物；页面 .tsx 不进测试编译，与既有页面用例同法读源码文本断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')

/** 注释里会写反面用法（如「早退分支里不许上报」），不剥会把解释性注释当成真实代码 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')

function fresh() {
  env.resetAll()
  return env.load
}

const PAGE = 'pages/opinion/index.tsx'

/* ═══════════════════════════ 一、上限：不许超过用户能建的量 ═══════════════════════════ */

describe('推荐上限 PICK_LIMIT（utils/opinion-pick）', () => {
  it('= min(3, 免费档「监控某人」上限) —— 推荐 5 个而用户只能建 3 个，等于在推销额度', () => {
    const load = fresh()
    const { PICK_LIMIT } = load('utils/opinion-pick')
    const { OPINION_LIMITS } = load('config/benefits')

    eq(PICK_LIMIT, Math.min(3, OPINION_LIMITS.personWatchCount.free))
    ok(PICK_LIMIT >= 1 && PICK_LIMIT <= 3, '2-3 个是产品给的区间（S1-4 验收口径）')
  })

  it('上限取自 config 真源（免费档一改，这里跟着降，不是各写一个 3）', () => {
    const load = fresh()
    const { PICK_LIMIT } = load('utils/opinion-pick')
    const { personWatchLimit } = load('utils/opinion-access')

    eq(PICK_LIMIT, Math.min(3, personWatchLimit(false)), '免费档上限是这条推荐线的上界')
  })
})

/* ═══════════════════════ 二、候选纯函数：推荐谁、推荐几个 ═══════════════════════ */

describe('pickMonitorCandidates（推荐谁 / 几个）', () => {
  /** 他查过的人：history 行（`listRecentHistory` 的字段口径） */
  const H = (name, personKey) => ({ personKey, name })

  it('他查过的人优先，不足才用热门榜补齐（顺序即展示顺序）', () => {
    const load = fresh()
    const { pickMonitorCandidates } = load('utils/opinion-pick')

    const out = pickMonitorCandidates({
      history: [H('张三', '张三#ent')],
      board: [
        { name: '李四', domain: 'tech' },
        { name: '王五', domain: 'sport' }
      ]
    })

    eq(out.length, 3, '一历史 + 两热门 = 3（上限内）')
    eq(out[0].name, '张三')
    eq(out[0].reason, 'history', '他查过的人必须排在最前：那是冷启动里唯一真实的意图信号')
    eq(out[0].personKey, '张三#ent', '历史行自带 personKey，原样用（不许拿名字重造，重造可能换领域）')
    eq(out.slice(1).map((c) => c.reason).join(','), 'hot,hot')
  })

  it('热门榜条目没有 personKey，用 buildPersonKey 现造（含 # 净化）', () => {
    const load = fresh()
    const { pickMonitorCandidates } = load('utils/opinion-pick')

    const out = pickMonitorCandidates({ board: [{ name: '李#四', domain: 'tech' }] })

    eq(out.length, 1)
    eq(out[0].personKey, '李四#tech', "名字里的 '#' 会让报告缓存主键分裂（同一人存成两行），必须在造 key 时净化")
    eq(out[0].name, '李四', '展示名用净化后的，不把 # 显示给用户')
    eq(out[0].reason, 'hot')
  })

  it('领域为空 / 脏 ⇒ 回落 other（key 永远只有一个分隔符、领域段非空）', () => {
    const load = fresh()
    const { pickMonitorCandidates } = load('utils/opinion-pick')

    const out = pickMonitorCandidates({ board: [{ name: '赵六', domain: '' }] })

    eq(out.length, 1)
    eq(out[0].personKey, '赵六#other')
    eq(out[0].domain, 'other')
  })

  it('只出 PICK_LIMIT 条：候选再多也不越线（一屏塞满只会让人一个都不点）', () => {
    const load = fresh()
    const { PICK_LIMIT, pickMonitorCandidates } = load('utils/opinion-pick')

    const board = Array.from({ length: 12 }, (_, i) => ({ name: `名人${i}`, domain: 'tech' }))
    eq(pickMonitorCandidates({ board }).length, PICK_LIMIT)
    /* 候选不够时如实少给，不硬凑 */
    eq(pickMonitorCandidates({ board: board.slice(0, 2) }).length, 2)
    eq(pickMonitorCandidates({ board: [] }).length, 0)
  })

  it('已监控的人不再推荐（再点一次是空操作，占了位置又点不动）', () => {
    const load = fresh()
    const { pickMonitorCandidates } = load('utils/opinion-pick')

    const out = pickMonitorCandidates({
      history: [H('张三', '张三#ent')],
      board: [
        { name: '李四', domain: 'tech' },
        { name: '王五', domain: 'sport' }
      ],
      taken: ['张三#ent', '李四#tech']
    })

    eq(out.length, 1)
    eq(out[0].name, '王五')
  })

  it('两个维度去重：同一 personKey、同名不同领域都只留一条', () => {
    const load = fresh()
    const { pickMonitorCandidates } = load('utils/opinion-pick')

    const out = pickMonitorCandidates({
      history: [H('张三', '张三#ent'), H('张三', '张三#ent')],
      board: [{ name: '张三', domain: 'sport' }]
    })

    eq(out.length, 1, '同名不同领域是两份报告，但对用户就是同一个人 —— 并排两个「张三」只会让人以为页面错了')
    eq(out[0].reason, 'history', '去重时保留先出现的那条（他查过的优先）')
  })

  it('脏输入一律不抛、一律当空（这是首屏路径，不能因为历史表里一行脏数据白屏）', () => {
    const load = fresh()
    const { pickMonitorCandidates, PICK_LIMIT } = load('utils/opinion-pick')

    eq(pickMonitorCandidates({}).length, 0)
    eq(pickMonitorCandidates({ history: null, board: null, taken: null }).length, 0)
    /* 非数组 / 元素为 null / 缺字段 / 空名字 / personKey 里没有分隔符 */
    eq(pickMonitorCandidates({ history: 'x', board: 1 }).length, 0)
    eq(pickMonitorCandidates({ history: [null, {}, { name: 'X' }] }).length, 0)
    eq(pickMonitorCandidates({ board: [null, {}, { name: '' }, { name: '  ' }] }).length, 0)
    eq(pickMonitorCandidates({ board: [{ domain: 'tech' }] }).length, 0)
    /* personKey 首字符就是 '#' ⇒ 名字为空 ⇒ parsePersonKey 返回 null ⇒ 跳过（也不是回退成别的名字） */
    eq(pickMonitorCandidates({ history: [H('', '#tech')] }).length, 0)
    /* taken 里混脏值不该影响正常候选 */
    eq(pickMonitorCandidates({ board: [{ name: '李四', domain: 'tech' }], taken: [null, 1, ''] }).length, 1)
    /* limit 覆盖：0 / 负数 / 非数字 */
    eq(pickMonitorCandidates({ board: [{ name: '李四', domain: 'tech' }], limit: 0 }).length, 0)
    eq(pickMonitorCandidates({ board: [{ name: '李四', domain: 'tech' }], limit: -2 }).length, 0)
    eq(pickMonitorCandidates({ board: Array.from({ length: 9 }, (_, i) => ({ name: `N${i}`, domain: 'tech' })), limit: 99 }).length, 9, '上限可由调用方抬高（页面不传则用 PICK_LIMIT）')
    ok(PICK_LIMIT >= 1)
  })
})

/* ═══════════════════════ 三、什么时候显示：只在真冷启动 ═══════════════════════ */

describe('shouldShowPick（什么时候显示这张卡）', () => {
  it('关系数 0 且没关过 ⇒ 显示（这就是「冷启动」的定义）', () => {
    const load = fresh()
    const { shouldShowPick } = load('utils/opinion-pick')

    ok(shouldShowPick({ relations: 0, dismissed: false }))
    ok(shouldShowPick({ relations: 0 }), '没读过标记 = 没关过')
  })

  it('已经有任何关系（关注 / 监控词 / 监控人）⇒ 不显示：这不是给老用户看的推荐位', () => {
    const load = fresh()
    const { shouldShowPick } = load('utils/opinion-pick')

    notOk(shouldShowPick({ relations: 1, dismissed: false }))
    notOk(shouldShowPick({ relations: 7, dismissed: false }))
  })

  it('关过一次就永久不再出现（它是引导，不是常驻推荐位）', () => {
    const load = fresh()
    const { shouldShowPick } = load('utils/opinion-pick')

    notOk(shouldShowPick({ relations: 0, dismissed: true }), '用户明确说了不用，就别问第二遍（关系为 0 也一样）')
  })

  it('关系数**算不出来** ⇒ 不显示（与 report#isColdPerson 同一取舍：宁可少说一句）', () => {
    const load = fresh()
    const { shouldShowPick } = load('utils/opinion-pick')

    notOk(shouldShowPick({}), '缺参')
    notOk(shouldShowPick({ relations: null }))
    notOk(shouldShowPick({ relations: Number.NaN }), 'NaN 不能落进 <= 0 那条分支')
    notOk(shouldShowPick({ relations: '0' }), "字符串 '0' 不是数字：typeof 一旦放宽，脏数据就会混进来")
    notOk(shouldShowPick(null))
    notOk(shouldShowPick(undefined))
  })
})

/* ═══════════════════════ 四、本机「已关闭」标记 ═══════════════════════ */

describe('本机标记 readPickDismissed / dismissPick / clearPickDismiss', () => {
  it('默认「没关过」；关一次后读出来是 true；清掉后又回到 false', () => {
    const load = fresh()
    const { PICK_DISMISS_KEY, readPickDismissed, dismissPick, clearPickDismiss } = load('utils/opinion-pick')

    eq(readPickDismissed(), false, '没写过 = 没关过')
    eq(env.rawStorage.has(PICK_DISMISS_KEY), false, '读一次不该顺手写一个默认值进去（那会让「没关过」与「关过」分不出来）')

    dismissPick()
    eq(readPickDismissed(), true)
    eq(env.rawStorage.get(PICK_DISMISS_KEY), true, '存的是布尔 true，不是字符串（读侧是 === true）')

    clearPickDismiss()
    eq(readPickDismissed(), false)
    eq(env.rawStorage.has(PICK_DISMISS_KEY), false, '清掉就是真删键，不写 false')
  })

  it('存储里是脏值（字符串 / 0 / null）⇒ 一律按「没关过」，且读侧不抛', () => {
    const load = fresh()
    const { PICK_DISMISS_KEY, readPickDismissed } = load('utils/opinion-pick')

    for (const bad of ['true', 1, 0, null, {}, []]) {
      env.rawStorage.set(PICK_DISMISS_KEY, bad)
      eq(readPickDismissed(), false, `${JSON.stringify(bad)} 不是布尔 true ⇒ 按没关过`)
    }
  })

  it('标记键钉死：键名进 storage，改名等于把所有老用户的「已关闭」弄丢', () => {
    const load = fresh()
    const { PICK_DISMISS_KEY, readPickDismissed, dismissPick } = load('utils/opinion-pick')

    eq(PICK_DISMISS_KEY, 'opinion:pick.dismissed')
    /* 与同类标记（inbox:seen 等）同形：模块前缀 + 冒号，便于在 devtools 里一眼看出归属 */
    ok(/^[a-z]+:[a-z.]+$/.test(PICK_DISMISS_KEY))
    dismissPick()
    ok(env.rawStorage.has(PICK_DISMISS_KEY), '写的就是这一个键（不是顺手写进别人的键）')
    eq(readPickDismissed(), true)
  })
})

/* ═══════════════════════ 五、文案：如实说来源、写明代价 ═══════════════════════ */

describe('推荐卡的文案（pickSourceNote / pickCostNote）', () => {
  const H = (name, personKey) => ({ personKey, name })

  it('来源如实分三种：只有历史 / 只有热门 / 两者都有', () => {
    const load = fresh()
    const { pickMonitorCandidates, pickSourceNote } = load('utils/opinion-pick')
    const hist = pickMonitorCandidates({ history: [H('张三', '张三#ent')] })
    const hot = pickMonitorCandidates({ board: [{ name: '李四', domain: 'tech' }] })
    const both = pickMonitorCandidates({
      history: [H('张三', '张三#ent')],
      board: [{ name: '李四', domain: 'tech' }]
    })

    ok(pickSourceNote(hist).includes('你最近查过'))
    ok(pickSourceNote(hot).includes('当前热门'))
    ok(pickSourceNote(both).includes('你查过的') && pickSourceNote(both).includes('热门'))
    /* 全热门时必须说清「不是根据你的兴趣挑的」—— 冷启动的新用户没有任何个性化信号，
       写成「为你精选」「你可能认识」就是在暗示平台懂他，而那是假的 */
    ok(pickSourceNote(hot).includes('不是根据你的兴趣'))
    eq(pickSourceNote([]), pickSourceNote(hot), '空列表按热门那档兜底（页面此时本来也不渲染）')
    ok(pickSourceNote(null) && pickSourceNote(undefined), '脏输入也给一句话，不返回空串')
  })

  it('代价说明：说清监控做什么 + 有上限，但**不写死档位数字**', () => {
    const load = fresh()
    const { pickCostNote } = load('utils/opinion-pick')
    const note = pickCostNote()

    ok(note.includes('每天替你扫一次公开报道'), '点之前要知道点下去会发生什么')
    ok(note.includes('上限'), '额度一旦用掉要用户自己去取消，不说清就引导点击 = 把「超限」留给用户撞')
    /* ⚠ 舆情页是**不引入会员态**的页面（用例 36 钉住），写死「免费版 3 个」对会员就是错的 */
    notOk(/免费版|会员版|\d+\s*个/.test(note), '不写死档位数字：这页不知道档位，写死必然对某一档是错的')
  })
})

/* ═══════════════════════ 六、页面接线（源码钉住） ═══════════════════════ */

describe('舆情页接线（pages/opinion/index.tsx）', () => {
  const page = read(PAGE)

  it('读取挂在 useDidShow 上；卡片显示与否只由候选数组决定', () => {
    ok(page.includes('void loadPick()'), '进页面就读一次（不引入额外缓存 / 不驻留）')
    ok(/const \[pick, setPick\] = useState<PickCandidate\[\]>\(\[\]\)/.test(page), '存候选而不是存布尔：卡片要靠「还剩几个候选」收起')
    ok(page.includes('{pick.length > 0 && ('), '显示条件只有候选非空')
    notOk(
      /const \[(show|showPick|visible|pickVisible)[^\]]*\] = useState/.test(page),
      '不该再存一个平行的「显示 / 不显示」布尔：两份真相必然漂移'
    )
  })

  it('**绝不自动建监控**：读取路径里不许出现 monitorPerson', () => {
    const at = page.indexOf('const loadPick = useCallback(')
    const end = page.indexOf('useDidShow(() => {', at)
    ok(at > 0 && end > at, 'loadPick 必须还在（这条断言靠它定位）')
    const body = page.slice(at, end)

    notOk(
      body.includes('monitorPerson'),
      '读一次就替用户建监控 = 哑监控（预置拿不到订阅授权）+ 免费额度被一次占满，见 utils/opinion-pick 文件头'
    )
    ok(body.includes('pickMonitorCandidates('), '读取路径只负责产出候选')
  })

  it('动作是「监控」而不是别的：一次点击建一个，来源标 opinion', () => {
    ok(page.includes("await monitorPerson(c.personKey, c.name, 'opinion')"))
    ok(page.includes('onClick={() => void addPickMonitor(c)}'), '卡片里唯一的写操作入口')
  })

  it('订阅授权的顺序硬约束：monitorPerson 必须是这次点击的第一个 await', () => {
    const at = page.indexOf('const addPickMonitor = async')
    const callAt = page.indexOf('await monitorPerson(', at)

    ok(at > 0 && callAt > at, 'addPickMonitor 里必须真的 await monitorPerson')
    notOk(
      /await\b/.test(page.slice(at, callAt)),
      '微信只认「用户点击后的第一个异步调用」：在 monitorPerson 之前插任何 await 都会让订阅授权静默失败（监控建上了却收不到推送）'
    )
  })

  it('建成功后摘掉那一行并刷新简报（数字不该等到下次进页面才更新）', () => {
    const at = page.indexOf('const addPickMonitor = async')
    const body = page.slice(at, page.indexOf('const onDismissPick', at))

    ok(/setPick\(\(list\) => list\.filter/.test(body), '同一个候选不再出现')
    ok(body.includes('loadAlertBlock()'), '关系变了 → 简报四格 / 事件的输入跟着变，立刻重读')
    notOk(body.includes('loadPick()'), '不要重读候选（那会用实时关系数重判冷启动，卡会突然消失）')
  })

  it('关掉走 dismissPick（永久），不是只把当前这份藏起来', () => {
    ok(page.includes('const onDismissPick = () => {'))
    ok(page.includes('dismissPick()'), '写本机标记')
    ok(page.includes('readPickDismissed()'), '下次进来第一件事就是读它')
    ok(page.includes('onClick={onDismissPick}'), '卡头要有这个按钮')
  })

  it('位置在「每日舆情简报」之前：新用户的简报四格全是 0，那一屏唯一能做的事就是这张卡', () => {
    const cardAt = page.indexOf("className='card page-opinion__pick'")
    const briefAt = page.indexOf("className='card page-opinion__brief'")

    ok(cardAt > 0 && briefAt > 0, '两张卡都要还在')
    ok(cardAt < briefAt, '推荐卡必须排在简报之前')
    ok(page.indexOf("page-opinion__nav-item' onClick={goWeekly}") < cardAt, '页首三个入口按钮仍在本页最前（既有形态不破）')
  })

  it('不复用 page-opinion__more（那个类名被形态锁钉死为「全页只剩事件卡一处」）', () => {
    eq(
      (page.match(/className='page-opinion__more'/g) || []).length,
      1,
      '推荐卡的「不用了」另起类名，否则 36 / 39 的形态锁会失效'
    )
    ok(page.includes('page-opinion__pick-close'))
  })

  it('不引入会员态变量、不多出第四处 status:\'error\'（沿用本页既有不变式）', () => {
    notOk(page.includes('isMember'), '本页不引入会员态变量（用例 36 钉住）')
    eq((page.match(/status: 'error'/g) || []).length, 3, '引导卡读失败就是不显示，不该变成第四块「读失败」')

    const reads = page.slice(page.indexOf('const loadPick = useCallback('), page.indexOf('useDidShow(() => {'))
    ok(reads.includes('.catch(() => [])'), '四个读口各自兜底：任一失败按空处理，绝不拖垮页面')
  })

  it('两个 note 都是纯函数供页面调用（文案不散在 JSX 里）', () => {
    ok(page.includes('{pickSourceNote(pick)}'))
    ok(page.includes('{pickCostNote()}'))
  })

  it('失败**就地一行**，不用弹窗、也不用会被截半句的 toast（沿用本页「克制的行内交互」）', () => {
    notOk(/showModal/.test(page), '本页有既有的形态锁：不引入弹窗（用例 29 钉住）')
    ok(page.includes('setPickError(res.message)'), '失败原文进 state')
    ok(page.includes('page-opinion__pick-note--error'), '就地渲染在卡里（全文，不截断）')
    ok(page.includes('setPickError(\'\')'), '重试前清掉上一条，避免旧原因挂着误导')

    const scss = read('pages/opinion/index.scss')
    /* scss 用的是嵌套写法（`&__pick-note` 里再嵌 `&--error`），所以断言要按嵌套形态匹配 */
    ok(/&__pick-note\s*\{[\s\S]{0,400}?&--error/.test(scss), '错误行的样式要落在本页 scss 里')
  })
})

/* ═══════════════════ 七、「清空本机痕迹」的三条链路都要清这个标记 ═══════════════════ */

describe('本机标记的清理（我的页 + 系统设置页）', () => {
  /*
   * 2026-10-17：清空数据 / 撤回同意 / 注销账号都搬到「我的 → 系统设置」（package/settings）。
   * 契约不变 —— **三条链路都要清**，所以调用点数一起数，拆开后必须正好还是 3
   * （任一侧漏一处都会留下一个用户看不见的决定）。
   */
  const mine = read('pages/mine/index.tsx')
  const settings = read('package/settings/index.tsx')

  it('清空全部数据 / 撤回同意 / 注销账号 三处都清（与 messages / inbox / weekly 同一处理）', () => {
    eq(
      (mine.match(/clearPickDismiss\(\)/g) || []).length +
        (settings.match(/clearPickDismiss\(\)/g) || []).length,
      3,
      '三条链路的契约都是「本机痕迹全清」：漏一处就会留下一个用户看不见的决定'
    )
    eq(
      (mine.match(/clearInboxSeen\(\)/g) || []).length + (settings.match(/clearInboxSeen\(\)/g) || []).length,
      3,
      '（对照：同类的 inbox 标记本来就是三处）'
    )
    ok(settings.includes("import { clearPickDismiss } from '@/utils/opinion-pick'"))
    /* 反向：三条链路都在系统设置页了，「我的」页不该再残留这条清理（残留 = 还有第四个入口） */
    notOk(mine.includes('clearPickDismiss'), '撤回同意迁走后，「我的」页不再需要 clearPickDismiss')
  })
})

/* ═══════════════════ 八、D2 的三条理由留在源码里（下一个人才不会改回去） ═══════════════════ */

describe('D2 的决策依据留在源码注释里', () => {
  const src = read('utils/opinion-pick.ts')

  it('文件头写明「为什么不能自动预置」的三条理由', () => {
    ok(/requestSubscribeMessage/.test(src), '授权必须由点击触发的第一个异步发起（中文原因也要写出来）')
    ok(/额度/.test(src), '免费档额度会被一次占满')
    ok(/个性化信号/.test(src), '新用户没有个性化信号 ⇒「预置谁」只能是平台挑的')
    ok(/哑监控/.test(src), '自动预置的实际后果必须点名，否则后来者会以为只是「体验差一点」')
  })
})

/* ═══════════ 九、埋点：推荐卡出现过几次（S1-4 的转化分母，2026-10-16 补） ═══════════ */

/**
 * S1-4 落地时只埋了 `monitor_add`（`from='opinion'`）—— **那只是分子**。
 * 「卡出现过几次」当时一条记录都没有（doc/产品优化路线图.md 那一节只能写「算不出转化率」，本次补上；重排后见 §5.1 S1-4），
 * 于是两件事都答不出来：
 *   · 「推荐 → 建立」的转化率（绝对值分不清「用户不想点」与「卡根本没出现过」）；
 *   · 「他查过的人优先」这条规则在实际流量上有没有命中过（历史记录那个读口是否真的给到了数据）。
 * 本组只钉三件事：事件名登记、带哪两个数、以及**不在早退分支里上报**。
 */

describe('埋点 opinion_pick（推荐卡真的出现时才报）', () => {
  const page = stripComments(read(PAGE))
  const events = stripComments(read('utils/events.ts'))

  const loadPickBody = () => {
    const at = page.indexOf('const loadPick = useCallback(')
    const end = page.indexOf('useDidShow(() => {', at)
    ok(at > 0 && end > at, 'loadPick 必须还在（这条断言靠它定位）')
    return page.slice(at, end)
  }

  it("事件名登记在 TrackEvent 里，否则埋点会被类型挡下（或写错名字静默丢弃）", () => {
    ok(/\|\s*'opinion_pick'/.test(events), 'opinion_pick 要先在 utils/events.ts 的枚举里声明')
  })

  it('带 count（候选数）与 history（其中来自「他查过的人」的条数）', () => {
    const body = loadPickBody()

    ok(/track\('opinion_pick'/.test(body), '上报点在 loadPick 里（读数据那一刻），不在渲染期 —— 渲染期上报会被每次重渲染重复计')
    ok(
      /count:\s*cands\.length/.test(body),
      '分母 = 卡出现过几次：没有它，monitor_add 的绝对值分不清「没人想点」与「卡根本没出现过」'
    )
    ok(
      /history:\s*cands\.filter\(\(c\) => c\.reason === 'history'\)\.length/.test(body),
      '「他查过的人」占比是那条优先规则的体检指标：恒为 0 说明这个分支在实际流量上从没命中过'
    )
  })

  it('只在**真的设入候选**时上报：关掉过 / 有关系 / 候选算空都不进分母', () => {
    const body = loadPickBody()
    const guardAt = body.indexOf('if (cands.length > 0)')
    const trackAt = body.indexOf("track('opinion_pick'")

    ok(guardAt > 0 && trackAt > guardAt, '上报必须在「候选非空」判断之内')
    ok(body.indexOf('readPickDismissed()') < guardAt, '「关过」的早退分支在上报点之前')
    ok(body.indexOf('shouldShowPick(') < guardAt, '「关系数不为 0」的早退分支也在上报点之前')
    notOk(
      /track\(/.test(body.slice(0, guardAt)),
      '早退分支里不许上报：那会把「这张卡本来就没显示」也算进分母，转化率被系统性低估'
    )
    ok(/setPick\(cands\)/.test(body), '存进 state 的仍然是候选数组（卡片显示与否只由它决定）')
  })
})
