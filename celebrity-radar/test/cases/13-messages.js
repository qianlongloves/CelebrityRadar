'use strict'

/**
 * 消息中心：本机已读 / 逐条删除（2026-10-10）
 *
 * 这一页的形态由「消息是端上算出来的」决定（见 utils/messages.ts 文件头）：不新增集合、
 * 不新增云函数，已读与删除都只写本机 storage。于是它有两处**只有跑数据层才看得出来**的口径，
 * 本文件就钉这两处：
 *
 *   1. **删除必须记「id + 事件时间」两个值，不能只记 id**。关注类消息的 id 是
 *      `follow#<personKey>`，同一个人的下一次动态会复用同一个 id —— 只记 id 会把那个人
 *      此后所有动态一起永久静音（没有任何报错，只是再也不提醒，最难排查）。口径写成：
 *      同一 id 里事件时间不晚于删除那一刻的算被删，**晚于它的（后来的新动态）照常出现**。
 *   2. **删除过滤要在「排序之后、统计之前」**。列表与未读数必须来自同一份数组，否则删掉
 *      一条未读会出现「列表少一条、红点没变」这种对不上的状态。
 *
 * 另外把「周报键含周、公告 id 稳定 ⇒ 删除即永久隐藏」「存储被写坏按没有删除记录处理」
 * 「清空我的数据会一并清掉删除记录」这三条边界一并覆盖；页面侧的「删除入口 + 角色分流」
 * 走源码级静态断言（pages 不在测试编译范围内）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const BUILD = path.resolve(__dirname, '..', '.build')
const read = (p) => fs.readFileSync(p, 'utf8')

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
/** 相对当前时刻取基准，用例不依赖系统日期（否则换台机器就飘） */
const NOW = Date.now()
const T0 = NOW - 30 * DAY

const iso = (ms) => new Date(ms).toISOString()

/**
 * 让「云环境已配置」为真：messages → listFollows → utils/db 要走真实 DB 适配层。
 * 与 05 / 12 同一手法 —— isCloudConfigured 是模块级常量，必须在 load 之前改掉配置对象。
 */
function configureCloud() {
  require(path.join(BUILD, 'config/public')).publicConfig.cloudbaseEnvId = 'test-env-id'
}

function fresh() {
  env.resetAll()
  env.setDebugFlags({
    disableGenerateQuota: false,
    disableAskQuota: false,
    disableRefreshQuota: false,
    disableCooldown: false
  })
  configureCloud()
  return { db: env.db, load: env.load, storage: env.storage }
}

function login(id = 'me') {
  env.load('stores/auth').useAuth.getState().setLogin({ userId: id })
  return id
}

/* --------------------------------------------------------------- 造数 */

/** 关注行：`_id` = openid#personKey（与线上主键口径一致） */
function seedFollow(db, { personKey = '张三#tech', name = '张三', followedAt = iso(T0), openid = 'me' } = {}) {
  db.__seed('follows', [
    {
      _id: `${openid}#${personKey}`,
      openid,
      person_key: personKey,
      name,
      domain: personKey.split('#')[1] || 'other',
      followed_at: followedAt
    }
  ])
}

/** report_cache 行：state=ready + report，才被 watch 视作「报告重生」 */
function seedReport(db, personKey = '张三#tech', generatedAt = iso(T0 + HOUR), heat = 60) {
  db.__seed('report_cache', [
    {
      _id: personKey,
      state: 'ready',
      builder: null,
      generated_at: generatedAt,
      report: {
        personKey,
        name: personKey.split('#')[0],
        mode: 'realtime',
        generatedAt,
        heat,
        intro: '简介',
        dynamics: [],
        quotes: [],
        analysis: '点评',
        disclaimer: '免责声明'
      }
    }
  ])
}

const followItem = (feed, personKey = '张三#tech') =>
  feed.items.find((i) => i.id === `follow#${personKey}`)

/* ============================ 1. 关注更新成条 ============================ */

describe('消息中心：关注更新成条与未读', () => {
  it('关注之后报告重生 → 出现一条「有新动态」，事件时间取报告重生时间', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const feed = await load('utils/messages').loadMessages()
    const item = followItem(feed)

    ok(item, '应有张三的关注消息')
    eq(item.kind, 'follow')
    eq(item.title, '张三 有新动态')
    eq(item.at, iso(T0 + HOUR), '事件时间取报告重生时间（报告与动态取较晚者）')
    eq(item.unread, true, '刚重生的动态默认未读')
    ok(item.url && item.url.includes('personKey='), '应带报告页落地地址')
  })

  it('关注时间晚于报告时间 → 不算新动态（followed_at 是天然基线）', async () => {
    const { db, load } = fresh()
    login()
    /* 报告在前、关注在后 */
    seedReport(db, '张三#tech', iso(T0 + HOUR))
    seedFollow(db, { followedAt: iso(T0 + 5 * HOUR) })

    const feed = await load('utils/messages').loadMessages()
    notOk(followItem(feed), '关注之前的旧报告不该算「新动态」')
  })

  it('未登录时没有关注与周报消息，只剩平台公告', async () => {
    const { load } = fresh()
    const feed = await load('utils/messages').loadMessages()

    ok(feed.items.length > 0, '公告始终在')
    ok(
      feed.items.every((i) => i.kind === 'system'),
      '未登录不该产生关注 / 周报消息'
    )
    eq(
      feed.unread,
      feed.items.filter((i) => i.unread).length,
      '未读数必须等于列表里未读的条数'
    )
  })
})

/* ============================ 2. 逐条删除 ============================ */

describe('消息中心：逐条删除（本机隐藏）', () => {
  it('删除一条后：列表不再有它，未读数同源减少（列表与计数出自同一份数组）', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, deleteMessage } = load('utils/messages')
    const before = await loadMessages()
    const item = followItem(before)
    ok(item, '前置：应有这条消息')
    const unreadBefore = before.unread

    deleteMessage(item.id, item.at)

    const after = await loadMessages()
    notOk(followItem(after), '删除后该条不该再出现')
    eq(after.items.length, before.items.length - 1)
    eq(after.unread, unreadBefore - 1, '删掉一条未读，未读数必须同步减 1')
  })

  it('删除只针对选中的一条：其他人物的消息与公告不受影响', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('follows', [
      {
        _id: 'me#张三#tech',
        openid: 'me',
        person_key: '张三#tech',
        name: '张三',
        domain: 'tech',
        followed_at: iso(T0)
      },
      {
        _id: 'me#李四#tech',
        openid: 'me',
        person_key: '李四#tech',
        name: '李四',
        domain: 'tech',
        followed_at: iso(T0)
      }
    ])
    seedReport(db, '张三#tech', iso(T0 + HOUR))
    seedReport(db, '李四#tech', iso(T0 + 2 * HOUR))

    const { loadMessages, deleteMessage } = load('utils/messages')
    const before = await loadMessages()
    const zhang = followItem(before, '张三#tech')
    ok(zhang)
    ok(followItem(before, '李四#tech'), '前置：李四也有一条')

    deleteMessage(zhang.id, zhang.at)

    const after = await loadMessages()
    notOk(followItem(after, '张三#tech'))
    ok(followItem(after, '李四#tech'), '别的关注对象不该被连坐')
    ok(
      after.items.some((i) => i.kind === 'system'),
      '平台公告也不受影响'
    )
  })

  it('删掉「张三 有新动态」不等于永久静音：更晚的新动态照常出现', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, deleteMessage } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)
    deleteMessage(item.id, item.at)

    /* 报告重生了一版（事件时间更晚）：同一个人复用同一个 id，但它是「新的一条」 */
    seedReport(db, '张三#tech', iso(T0 + 3 * HOUR))

    const after = await loadMessages({ force: true })
    const again = followItem(after)
    ok(again, '更新后的动态必须重新出现（记 id 时不能把这个人永久静音）')
    eq(again.at, iso(T0 + 3 * HOUR), '事件时间应是新那一版')
    eq(again.unread, true, '新动态默认未读')
  })

  it('删除时刻与事件时间相等 → 仍算已删（判定是「不晚于」而非「早于」）', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, deleteMessage } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)
    /* 用「这一条自己的事件时间」当删除时刻：等号边界 */
    deleteMessage(item.id, item.at)

    const after = await loadMessages({ force: true })
    notOk(followItem(after), '时间相等的这一条应视为已删')
  })

  it('同一条重复删除：只保留一条记录，不会把存储列表撑满', async () => {
    const { db, load, storage } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, deleteMessage } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)

    deleteMessage(item.id, item.at)
    deleteMessage(item.id, item.at)
    deleteMessage(item.id, item.at)

    const marks = JSON.parse(storage.get('messages:deleted'))
    eq(marks.length, 1, '同一 id 反复删除只留一条')
    eq(marks[0].id, item.id)
  })

  it('删除时事件时间不可解析 → 退化为当前时刻，仍能隐藏该条', async () => {
    const { db, load, storage } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, deleteMessage } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)

    deleteMessage(item.id, '这不是一个时间')

    const marks = JSON.parse(storage.get('messages:deleted'))
    ok(Number.isFinite(marks[0].at), '不可解析时应退化成一个可用的毫秒时间戳')
    const after = await loadMessages({ force: true })
    notOk(followItem(after), '退化后仍然要能隐藏这条')
  })

  it('周报与平台公告的 id 不含时间：删除即永久隐藏', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db) /* 有周报提醒需要先有关注 */

    const { loadMessages, deleteMessage } = load('utils/messages')
    const before = await loadMessages()
    const weekly = before.items.find((i) => i.kind === 'weekly')
    const notice = before.items.find((i) => i.kind === 'system')
    ok(weekly, '前置：应有一条周报提醒')
    ok(notice, '前置：应有一条平台公告')

    deleteMessage(weekly.id, weekly.at)
    deleteMessage(notice.id, notice.at)

    const after = await loadMessages({ force: true })
    notOk(after.items.find((i) => i.id === weekly.id), '周报提醒删除后不该回来')
    notOk(after.items.find((i) => i.id === notice.id), '公告删除后不该回来')
  })

  it('删除记录被写坏时按「没有删除记录」处理：消息照常出现，不抛错', async () => {
    const { db, load, storage } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)

    storage.set('messages:deleted', '{不是合法 JSON')

    const after = await loadMessages({ force: true })
    ok(followItem(after), '存储坏掉最坏是多出几条消息，绝不能白屏或抛错')
  })

  it('清空我的数据（clearMessageState）会一并清掉删除记录，消息重新出现', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, deleteMessage, clearMessageState } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)
    deleteMessage(item.id, item.at)
    notOk(followItem(await loadMessages({ force: true })))

    clearMessageState()

    ok(
      followItem(await loadMessages({ force: true })),
      '清空本机数据后删除记录消失，消息应重新出现'
    )
  })

  it('删除只写本机 storage，不触碰 follows / report_cache（删消息 ≠ 取关）', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, deleteMessage } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)

    const followsBefore = db.__dump('follows').length
    const reportsBefore = db.__dump('report_cache').length
    deleteMessage(item.id, item.at)

    eq(db.__dump('follows').length, followsBefore, '删消息不该动关注表')
    eq(db.__dump('report_cache').length, reportsBefore, '删消息不该动报告缓存')
  })
})

/* ============================ 2.5 逐条已读（与删除同口径） ============================ */

describe('消息中心：逐条已读（本机，id + 事件时间）', () => {
  it('标记已读后未读消失，未读数与列表同源减少', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, markMessageRead } = load('utils/messages')
    const before = await loadMessages()
    const item = followItem(before)
    ok(item)
    eq(item.unread, true)
    const unreadBefore = before.unread

    markMessageRead(item.id, item.at)

    const after = await loadMessages({ force: true })
    eq(followItem(after).unread, false, '点开的那条应变为已读')
    eq(after.unread, unreadBefore - 1, '未读数必须与列表同源，少 1 条')
  })

  it('已读「张三 有新动态」不等于永久静音：更晚的新动态照常未读', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, markMessageRead } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)
    markMessageRead(item.id, item.at)
    eq(followItem(await loadMessages({ force: true })).unread, false, '前置：这一条已读')

    /* 报告重生一版（事件时间更晚）：同一个人复用同一个 id，但它是「新的一条」 */
    seedReport(db, '张三#tech', iso(T0 + 3 * HOUR))

    const after = await loadMessages({ force: true })
    const again = followItem(after)
    ok(again, '新动态仍在列表里')
    eq(again.at, iso(T0 + 3 * HOUR), '事件时间应是新那一版')
    eq(again.unread, true, '只记 id 的话这里会永远是已读 —— 那条静默失效正是本用例要钉住的')
  })

  it('一键全部已读：逐条按各自事件时间记录，之后更晚的新动态仍未读', async () => {
    const { db, load } = fresh()
    login()
    db.__seed('follows', [
      { _id: 'me#张三#tech', openid: 'me', person_key: '张三#tech', name: '张三', domain: 'tech', followed_at: iso(T0) },
      { _id: 'me#李四#tech', openid: 'me', person_key: '李四#tech', name: '李四', domain: 'tech', followed_at: iso(T0) }
    ])
    seedReport(db, '张三#tech', iso(T0 + HOUR))
    seedReport(db, '李四#tech', iso(T0 + 2 * HOUR))

    const { loadMessages, markAllMessagesRead } = load('utils/messages')
    const before = await loadMessages()
    ok(before.unread >= 2, '前置：至少两条未读')
    markAllMessagesRead(before.items.map((i) => ({ id: i.id, at: i.at })))
    eq((await loadMessages({ force: true })).unread, 0, '一键已读后应清零')

    seedReport(db, '张三#tech', iso(T0 + 5 * HOUR))
    const after = await loadMessages({ force: true })
    eq(followItem(after, '张三#tech').unread, true, '一键已读只覆盖当时列表里的那一条')
    eq(followItem(after, '李四#tech').unread, false, '李四没有新动态，仍是已读')
  })

  it('同一条重复标记已读：只保留一条记录，不会把存储列表撑满', async () => {
    const { db, load, storage } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, markMessageRead } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)
    markMessageRead(item.id, item.at)
    markMessageRead(item.id, item.at)
    markMessageRead(item.id, item.at)

    const marks = JSON.parse(storage.get('messages:read_marks'))
    eq(marks.length, 1, '同一 id 反复标记只留一条')
    eq(marks[0].id, item.id)
  })

  it('已读记录被写坏时按「没有已读记录」处理：消息照常出现，不抛错', async () => {
    const { db, load, storage } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages } = load('utils/messages')
    ok(followItem(await loadMessages()))

    storage.set('messages:read_marks', '{不是合法 JSON')

    const after = await loadMessages({ force: true })
    ok(followItem(after), '存储坏掉最坏是多几条未读，绝不能白屏或抛错')
    eq(followItem(after).unread, true)
  })

  it('旧版 messages:read_ids 列表会迁移成「id + 时间」：迁移前存在的条目仍是已读，旧键清掉', async () => {
    const { db, load, storage } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    /* 旧版只记 id：这条关注消息此前已被读过 */
    storage.set('messages:read_ids', JSON.stringify(['follow#张三#tech']))

    const { loadMessages } = load('utils/messages')
    const after = await loadMessages({ force: true })

    eq(followItem(after).unread, false, '老用户升级后不该凭空多出一堆未读')
    notOk(storage.get('messages:read_ids'), '旧键迁移后应删除，只做一次')
    const marks = JSON.parse(storage.get('messages:read_marks'))
    eq(marks.length, 1)
    eq(marks[0].id, 'follow#张三#tech')
    ok(Number.isFinite(marks[0].at), '迁移记录应带一个可用的毫秒时间戳')
  })

  it('清空我的数据（clearMessageState）会一并清掉已读记录', async () => {
    const { db, load } = fresh()
    login()
    seedFollow(db)
    seedReport(db, '张三#tech', iso(T0 + HOUR))

    const { loadMessages, markMessageRead, clearMessageState } = load('utils/messages')
    const item = followItem(await loadMessages())
    ok(item)
    markMessageRead(item.id, item.at)
    eq(followItem(await loadMessages({ force: true })).unread, false)

    clearMessageState()

    eq(followItem(await loadMessages({ force: true })).unread, true, '清空后已读记录消失，重新算未读')
  })
})

/* ============================ 3. 页面静态约束 ============================ */

describe('消息中心页面：删除入口与角色分流（静态约束）', () => {
  const page = read(path.join(SRC, 'pages', 'messages', 'index.tsx'))

  it('从 utils/messages 引入 deleteMessage，并落成卡片底部的删除入口', () => {
    ok(/import\s*\{[\s\S]*?deleteMessage[\s\S]*?\}\s*from\s*'@\/utils\/messages'/.test(page))
    ok(/data-role='del'/.test(page), '删除入口必须带 data-role="del"')
    ok(/className='page-messages__del'/.test(page))
  })

  it('「删除」在标已读之前分流：删一条不会顺带把未读数改掉', () => {
    /* onCardTap 里 role === 'del' 必须早于 readOne(m.id, m.at) */
    const tap = page.slice(page.indexOf('const onCardTap'))
    const delAt = tap.indexOf("role === 'del'")
    const readAt = tap.indexOf('readOne(m.id, m.at)')
    ok(delAt >= 0 && readAt >= 0 && delAt < readAt, 'del 分支必须排在 readOne 之前')
  })

  it('标已读必须带上这条的事件时间（与 deleteMessage 同口径，否则关注类 id 复用会永久静音）', () => {
    ok(/import\s*\{[\s\S]*?markMessageRead[\s\S]*?\}\s*from\s*'@\/utils\/messages'/.test(page))
    ok(page.includes('markMessageRead(id, at)'), 'readOne 必须把 at 透传给 markMessageRead')
    ok(
      page.includes('markAllMessagesRead(items.map((i) => ({ id: i.id, at: i.at })))'),
      '一键已读也要逐条带上事件时间'
    )
  })

  it('删除前二次确认，且文案点明「不影响关注与周报」', () => {
    const fn = page.slice(page.indexOf('const removeOne'))
    ok(fn.includes('showModal'), '删除必须先弹确认')
    ok(/不影响关注与周报/.test(fn), '确认文案要打消「删了会丢数据」的顾虑')
    ok(fn.includes('deleteMessage(m.id, m.at)'), '确认后才写删除记录（带事件时间）')
  })
})
