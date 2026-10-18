'use strict'

/**
 * 名人主页的「监控风险」入口（S2-2，2026-10-16）。
 *
 * 这一页此前**只有关注**：想监控只能绕到报告页横幅的「+ 监控风险」或舆情页 ——
 * 而「读到这个人 → 想盯着他」正好发生在本页（同一个人、同一次决策，却要换两个页面）。
 * 链路一行没新造（仍是 utils/risk-watch.ts + keyword_watches + riskWatch 云函数），
 * 所以这里不重复钉写库本身（那份在 02-data 里），钉的是**这次新增的三处风险**：
 *
 *   1. **授权顺序**：微信要求 `requestSubscribeMessage` 必须是点击后的第一个异步调用，
 *      而 `monitorPerson` 内部第一条就是它 —— 于是「在这行之前插一次查库」这种极自然的
 *      改动，会让授权被静默丢弃、按钮从此不弹订阅框（不报错、不看代码看不出来）；
 *   2. **按钮态与库里的关系不一致**：本页若按「报告页才有监控」假设成 false，
 *      早已在别处建过监控的用户会看到「+ 监控」，一点得到「已在监控中」——
 *      两个入口给出两个答案，而两边都不报错；
 *   3. **埋点拆不开**：「人」与「词」同住 keyword_watches 表，若都报成 `watch_add`，
 *      以后再也算不出「新的这个入口到底带来多少监控关系」—— S2-2 值不值得留就看这个数。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, eq, notOk, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 注释里会写反例（如「不许在这行之前 await」），不剥会把反例当成真实用法 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')

const PROFILE_PAGE = 'package/profile/index.tsx'
const PROFILE_SCSS = 'package/profile/index.scss'
const REPORT_PAGE = 'package/report/index.tsx'
const ALERTS_PAGE = 'package/alerts/index.tsx'

function fresh() {
  env.resetAll()
  return { db: env.db, load: env.load }
}

function login(id = 'u-openid-1') {
  const store = env.load('stores/auth')
  store.useAuth.getState().setLogin({ userId: id })
  return id
}

/** 埋点是 fire-and-forget（`void table().insert()`），要让这一轮微任务跑完才看得到落库 */
const tick = () => new Promise((r) => setTimeout(r, 0))

/** 取页面里 onToggleMonitor 的函数体（顶格 `  }` 收尾，与组件内的缩进一致） */
const monitorFn = () => {
  const m = /const onToggleMonitor = async \(\) => \{[\s\S]*?\n  \}/.exec(stripComments(read(PROFILE_PAGE)))
  ok(m, '找不到 onToggleMonitor：本页的监控入口是它，改名请同步本用例')
  return m ? m[0] : ''
}

/** 库里已有的一行人物监控（老行没有 type 字段也照样算，见 listPersonWatches） */
const personRow = (userId, personKey, name) => ({
  _id: `${userId}#person#${personKey}`,
  openid: userId,
  keyword: name,
  person_key: personKey,
  type: 'person',
  created_at: '2026-10-01T00:00:00.000Z',
  seen_at: '2026-10-01T00:00:00.000Z'
})

/* ═════════════ 1. 写库口：来源标记与「词 / 人」的分野 ═════════════ */

describe('监控建立 / 取消都要标来源，且与「盯一个词」分开报（S2-2）', () => {
  it('monitorPerson 建成时写 monitor_add 并带上入口来源', async () => {
    const { db, load } = fresh()
    login()
    const { monitorPerson } = load('utils/risk-watch')

    const res = await monitorPerson('雷军#tech', '雷军', 'profile')
    ok(res.ok, res.message)
    await tick()

    const rows = db.__dump('events')
    eq(rows.length, 1, '一次建立只报一条')
    eq(rows[0].event, 'monitor_add')
    eq(rows[0].person_key, '雷军#tech', 'personKey 仍落到列上（与其它事件同口径，便于按人回查）')
    eq(rows[0].props.from, 'profile', '入口来源必须在 props.from 上 —— 没有它，这个新入口有没有被用上只能靠感觉说')
  })

  it('来源参数是可选的：老调用点不传也不会报错、不落空值', async () => {
    const { db, load } = fresh()
    login()
    const { monitorPerson } = load('utils/risk-watch')

    const res = await monitorPerson('雷军#tech', '雷军')
    ok(res.ok, res.message)
    await tick()
    const row = db.__dump('events')[0]
    eq(row.event, 'monitor_add')
    eq(row.props.from, undefined, '没传来源就不写 from（不是空串、不是 null，聚合时才不会多出一个空桶）')
  })

  it('人与词同住一张表，但关系必须报成「人」的事件名', async () => {
    const { db, load } = fresh()
    login()
    const { monitorPerson } = load('utils/risk-watch')
    const { addWatch } = load('utils/keyword-alert')

    await monitorPerson('雷军#tech', '雷军', 'profile')
    await addWatch('雷军发布会')
    await tick()

    /* 表是同一张（不能改），靠 type / person_key 区分 —— 这也正是事件名必须分开的原因 */
    const rows = db.__dump('keyword_watches')
    eq(rows.filter((r) => r.type === 'person' && r.person_key === '雷军#tech').length, 1)
    eq(rows.filter((r) => r.person_key === undefined).length, 1, '词的那行没有 person_key')

    /* 事件名：人的那条由**写库口**自己报（与 utils/follows.ts#toggleFollow 同一约定：
       关系类动作在唯一出口埋，页面不必记得埋；词的那条是页面在订阅处报 watch_add） */
    deepEq(
      db.__dump('events').map((r) => r.event),
      ['monitor_add'],
      '监控一个人若报成 watch_add，就再也算不出「监控入口带来多少关系」'
    )
    const risk = stripComments(read('utils/risk-watch.ts'))
    ok(risk.includes("track('monitor_add'") && risk.includes("track('monitor_remove'"), '建立与解除都在写库口报')
    notOk(risk.includes("track('watch_add'"), '「监控人」与「盯词」额度、链路、成本各一套，事件名不许混用')
  })

  it('失败不算一次「建立」：超限 / 未登录都不报 monitor_add', async () => {
    const { db, load } = fresh()
    const me = login()
    const { monitorPerson } = load('utils/risk-watch')

    /* 免费档上限 3 位（真源 config/benefits.ts）：先占满，再点一次必被门禁拦下 */
    db.__seed('keyword_watches', [
      personRow(me, 'a#tech', '甲'),
      personRow(me, 'b#tech', '乙'),
      personRow(me, 'c#tech', '丙')
    ])
    const over = await monitorPerson('雷军#tech', '雷军', 'profile')
    notOk(over.ok, '超限必须如实失败')
    await tick()
    eq(db.__dump('events').length, 0, '把失败的点击也报成「建立」，这个入口的转化就被高估了')

    /* 未登录同理：连身份都没有，不算任何人建立的 */
    const guest = fresh()
    guest.load('stores/auth')
    const { monitorPerson: mp2 } = guest.load('utils/risk-watch')
    const res = await mp2('雷军#tech', '雷军', 'profile')
    notOk(res.ok)
    await tick()
    eq(guest.db.__dump('events').length, 0)
  })

  it('取消监控：成功报 monitor_remove 带来源，失败不报', async () => {
    const okRun = fresh()
    const me = login()
    okRun.db.__seed('keyword_watches', [personRow(me, '雷军#tech', '雷军')])
    const { unmonitorPerson } = okRun.load('utils/risk-watch')

    eq(await unmonitorPerson('雷军#tech', 'alerts'), true)
    await tick()
    const row = okRun.db.__dump('events')[0]
    eq(row.event, 'monitor_remove')
    eq(row.props.from, 'alerts', '取消也要能看出从哪取消的（预警页取消 vs 主页取消是两回事）')

    /* 删除失败（集合不可用）：返回 false，且不该记一条「已取消」*/
    const badRun = fresh()
    const me2 = login()
    badRun.db.__seed('keyword_watches', [personRow(me2, '雷军#tech', '雷军')])
    badRun.db.__setFailing('keyword_watches', true)
    const { unmonitorPerson: um2 } = badRun.load('utils/risk-watch')

    eq(await um2('雷军#tech', 'alerts'), false)
    await tick()
    eq(badRun.db.__dump('events').length, 0, '删失败还报 monitor_remove，等于把「关系已解除」记成事实')
  })
})

/* ═════════════ 2. 名人主页：按钮态与入口口径 ═════════════ */

describe('名人主页的监控入口：与报告页同口径，一次点击就建立关系（S2-2）', () => {
  it('先读一次监控名单再决定按钮态，不假设「本页一定没监控过」', async () => {
    const { db, load } = fresh()
    const me = login()
    const { isMonitored, listPersonWatches } = load('utils/risk-watch')
    db.__seed('keyword_watches', [personRow(me, '王五#ent', '王五')])

    const rows = await listPersonWatches()
    eq(isMonitored(rows, '王五#ent'), true, '库里已有的监控必须读得出来')
    eq(isMonitored(rows, '雷军#tech'), false, '别人不该被算成这个人')

    const code = stripComments(read(PROFILE_PAGE))
    ok(
      /Promise\.all\(\[getCachedReport\(personKey\), isFollowed\(personKey\), listPersonWatches\(\)\]\)/.test(code),
      '监控名单要和报告 / 关注态并发读（串行会让首屏多等一次往返）'
    )
    ok(
      /setMonitored\(isMonitored\(watches, personKey\)\)/.test(code),
      '必须按读回来的名单判这个人，不能写死 false —— 否则按钮显示「+ 监控」而库里早就在监控'
    )
    notOk(/const \[monitored, setMonitored\] = useState\(true\)/.test(code), '初始态不许写死 true（那是替用户假设关系已存在）')
  })

  it('不需要报告就能监控：入口在始终渲染的头部，与报告是否生成无关', () => {
    const code = stripComments(read(PROFILE_PAGE))
    const inviteAt = code.indexOf("className='page-profile__monitor'")
    ok(inviteAt > 0, '缺少监控入口（page-profile__monitor）')
    const reportAt = code.indexOf('{loading &&')
    ok(reportAt > 0, '前提：渲染分支的写法未变（本用例据此定位）')
    ok(
      inviteAt < reportAt,
      '入口若落进「报告就绪」的分支里，没生成过报告的人（绝大多数新用户）就看不到它 —— 而监控只需要 personKey'
    )
  })

  it('监控 / 取消都走 utils/risk-watch，页面不自己写库', () => {
    const code = stripComments(read(PROFILE_PAGE))
    ok(
      /monitorPerson\(personKey, name, 'profile'\)/.test(code),
      '本页的监控要与报告页共用 risk-watch（同一张表、同一套门禁与文案）'
    )
    ok(/unmonitorPerson\(personKey, 'profile'\)/.test(code), '取消也走同一个出口')
    notOk(/db\.collection\('keyword_watches'\)/.test(code), '页面不得直连 keyword_watches：两处写库迟早出现一边能取消、另一边报错')
  })

  it('授权必须是点击后的第一个异步调用：monitorPerson 之前不许有 await', () => {
    const fn = monitorFn()
    const busyAt = fn.indexOf('setMonitorBusy(true)')
    const callAt = fn.indexOf('await monitorPerson(')
    ok(busyAt > 0 && callAt > busyAt, '找不到「新增监控」分支：忙碌闸置位后应立刻调用 monitorPerson')

    /* 忙碌闸置位 → 写库调用：中间任何一条语句（哪怕一次查库）都会把订阅授权挤到后面。
       微信只认「点击后的第一个异步调用」，被挤掉后不报错 —— 只是从此不再弹订阅框。 */
    ok(
      /^\s*const res =\s*$/.test(fn.slice(busyAt + 'setMonitorBusy(true)'.length, callAt)),
      '忙碌闸置位后必须立刻调用 monitorPerson（中间多一条语句，订阅授权就不再是点击后的第一个异步调用）'
    )
    const branchAt = fn.lastIndexOf('}', busyAt)
    eq(fn.slice(branchAt + 1, busyAt).trim(), '', '新增分支开头不许插任何语句（同样是为了不让 await 抢到授权前面）')
  })

  it('取消要二次确认、环境类失败给弹窗（与报告页逐字同一套）', () => {
    const fn = monitorFn()
    ok(/if \(monitorBusy\) return/.test(fn), '缺忙碌闸：并发点击会同时走到「先查数、再插入」，端上做不了原子计数')
    ok(/confirmText: '取消监控'/.test(fn), '取消监控要二次确认 —— 误触会让用户第二天收不到提醒')
    ok(/cancelText: '再想想'/.test(fn), '「再想想」是取消类弹窗的统一退路（与报告页 / 预警页一致）')
    ok(/风险情况/.test(fn), '确认文案要说清取消的是什么，不能只说「确定吗」')
    ok(
      /if \(res\.fatal\) \{\s*await Taro\.showModal\(/.test(fn),
      '环境类失败（集合没建 / 权限不对）文案长且不是「再点一次」能解决的，toast 会截成半句'
    )
    ok(/Taro\.showToast\(\{ title: res\.message, icon: 'success' \}\)/.test(fn), '成功落在 toast 上（弹窗只说失败）')
  })

  it('入口自己就把「监控的是什么、去哪取消」说清，并两态可分', () => {
    const code = stripComments(read(PROFILE_PAGE))
    ok(code.includes('云端每天按人检索一次'), '先说要花什么代价（每天一次检索），再让用户点')
    ok(code.includes('可在预警页查看或取消'), '还要说清这段关系去哪看、去哪取消')
    /* 2026-10-18 词表收敛：与报告页逐字一致 —— 「+ 监控风险」/「已监控」（此前这里是「+ 监控」/「监控中」） */
    ok(
      /\{monitorBusy \? '处理中' : monitored \? '已监控' : '\+ 监控风险'\}/.test(code),
      '按钮三态：处理中 / 已监控 / + 监控风险'
    )

    /*
     * 这几个选择器是**兄弟关系**（都挂在 & 下、各自成块），不是嵌套 —— 取「&__monitor 那一块」
     * 只会拿到它自己的几行属性。故从 &__monitor 起、到「&__monitor-btn 那个块自己闭合」为止整段切出来。
     */
    const scss = read(PROFILE_SCSS)
    const start = scss.indexOf('&__monitor {')
    const btnStart = scss.indexOf('&__monitor-btn {', start)
    ok(start > 0 && btnStart > start, '缺少 &__monitor / &__monitor-btn 样式块')
    const btnEnd = scss.indexOf('\n  }', btnStart)
    ok(btnEnd > btnStart, '&__monitor-btn 块未闭合')
    const block = scss.slice(start, btnEnd)

    for (const sel of ['&__monitor-main {', '&__monitor-title {', '&__monitor-note {', '&__monitor-btn {', '&--on {', '&--tap {']) {
      ok(block.includes(sel), `监控行缺 ${sel}`)
    }
    /* 按钮文案是活的（处理中 / 监控中 / + 监控），换行会把头部撑高一截 */
    const btnBlock = block.slice(block.indexOf('&__monitor-btn {'))
    ok(/white-space:\s*nowrap/.test(btnBlock), '按钮文案不许换行 —— 它有三种长度，多一行就顶高头部')
  })
})

/* ═════════════ 3. 入口来源齐了（不止新加的这一处） ═════════════ */

describe('所有监控调用点都标了入口来源（S2-2）', () => {
  it('报告页、名人主页、预警页三处的来源各不相同', () => {
    const cases = [
      [REPORT_PAGE, 'report'],
      [PROFILE_PAGE, 'profile'],
      [ALERTS_PAGE, 'alerts']
    ]
    for (const [file, from] of cases) {
      const code = stripComments(read(file))
      ok(
        code.includes(`unmonitorPerson(personKey, '${from}')`),
        `${file} 的取消监控点没标来源：埋点里会出现一个无法归因的桶`
      )
    }
    /* 建立监控的两个入口（报告页横幅 / 名人主页）同样要标 */
    for (const [file, from] of [cases[0], cases[1]]) {
      const code = stripComments(read(file))
      ok(code.includes(`monitorPerson(personKey, name, '${from}')`), `${file} 的建立监控点没标来源`)
    }
  })
})
