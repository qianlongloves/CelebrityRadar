'use strict'

/** 数据层：db 适配层 / 登录 / 埋点 / 收藏 / 历史 */

const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq, rejects } = require('../harness/t')

/** 每个用例从干净状态开始：清 storage + 清库 + 清模块缓存 */
function fresh() {
  env.resetAll()
  return {
    db: env.db,
    load: env.load,
    store: env.load('stores/auth')
  }
}

/** 登录一个用户，返回其 userId */
function login(id = 'u-openid-1') {
  const store = env.load('stores/auth')
  store.useAuth.getState().setLogin({ userId: id })
  return id
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/* ------------------------------------------------------------------ db.ts */

describe('数据访问适配层 utils/db', () => {
  it('id ↔ _id 双向映射：出参是 id，id 不落库成普通字段', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')

    const ins = await table('probe').insert({ id: 'K1', name: '甲' })
    eq(ins.error, null)
    const raw = db.__dump('probe')[0]
    eq(raw._id, 'K1')
    eq(raw.id, undefined, 'id 应由 _id 承载，不应作为普通字段落库')

    const sel = await table('probe').select('*').eq('id', 'K1')
    eq(sel.data.length, 1)
    eq(sel.data[0].id, 'K1')
    eq(sel.data[0]._id, undefined, '出参应把 _id 映回 id')
    eq(sel.data[0].name, '甲')
  })

  it('内部分页绕过单次 20 条上限（一次要 50 条也要取满）', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    const rows = Array.from({ length: 50 }, (_, i) => ({ _id: `p${String(i).padStart(2, '0')}`, n: i }))
    db.__seed('page', rows)

    const { data } = await table('page').select('*').order('n', { ascending: true }).limit(50)
    eq(data.length, 50)
    eq(data[0].n, 0)
    eq(data[49].n, 49)
    ok(db.stats.getCalls >= 3, `应至少分 3 次取，实际 ${db.stats.getCalls}`)
  })

  it('range 与 limit 组合时按区间切片', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    db.__seed('range_t', Array.from({ length: 30 }, (_, i) => ({ _id: `r${i}`, n: i })))
    const { data } = await table('range_t').select('*').order('n', { ascending: true }).range(25, 99)
    eq(data.length, 5, '25 之后只剩 5 条')
    eq(data[0].n, 25)
  })

  it('order 映射到 _id（主键排序不能漏翻译）', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    db.__seed('ord', [{ _id: 'b' }, { _id: 'a' }, { _id: 'c' }])
    const { data } = await table('ord').select('*').order('id', { ascending: true })
    deepEq(data.map((r) => r.id), ['a', 'b', 'c'])
  })

  it('or 表达式翻译为 command.or（逗号分隔的 PostgREST 串）', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    db.__seed('or_t', [
      { _id: 'a', state: 'ready' },
      { _id: 'b', state: 'done' },
      { _id: 'c', state: 'running' }
    ])
    const { data } = await table('or_t').select('*').or('state.eq.ready,state.eq.done')
    eq(data.length, 2)
    for (const r of data) ok(['ready', 'done'].includes(r.state))
  })

  it('非法 or 表达式在构造期就报错（不把坏条件发到云端）', async () => {
    const { load } = fresh()
    const { table } = load('utils/db')
    await rejects(async () => table('or_t').select('*').or('没有点号'), /or 表达式/)
  })

  it('in 过滤按主键批量命中', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    db.__seed('in_t', [{ _id: '1' }, { _id: '2' }, { _id: '3' }])
    const { data } = await table('in_t').select('id').in('id', ['1', '3'])
    eq(data.length, 2)
  })

  it('upsert 落到 doc(id).set() 全量覆盖，不追加新行', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    await table('up').upsert({ id: 'u1', a: 1 })
    await table('up').upsert({ id: 'u1', b: 2 })
    eq(db.__dump('up').length, 1, 'upsert 不应产生第二行')
    const row = db.__dump('up')[0]
    eq(row.b, 2)
    eq(row.a, undefined, 'set 是全量覆盖，旧字段应被冲掉')
  })

  it('upsert 缺冲突键时返回 error（不静默成功）', async () => {
    const { load } = fresh()
    const { table } = load('utils/db')
    const res = await table('up').upsert({ a: 1 })
    ok(res.error, '缺冲突键应报错')
  })

  it('拒绝无条件 update / delete（防全表误伤）', async () => {
    const { load } = fresh()
    const { table } = load('utils/db')
    const u = await table('guard_t').update({ a: 1 })
    ok(u.error && /过滤条件/.test(u.error.message), `实际：${JSON.stringify(u.error)}`)
    const d = await table('guard_t').delete()
    ok(d.error && /过滤条件/.test(d.error.message), `实际：${JSON.stringify(d.error)}`)
  })

  it('update 带 select() 时按是否真的更新到行决定返回内容', async () => {
    const { load } = fresh()
    const { table } = load('utils/db')
    await table('upd').insert({ id: 'x', v: 1 })
    const hit = await table('upd').update({ v: 2 }).eq('id', 'x').select()
    deepEq(hit.data, [{ v: 2 }])
    const miss = await table('upd').update({ v: 3 }).eq('id', '不存在').select()
    deepEq(miss.data, [])
  })

  it('未 await 的写操作也会执行（fire-and-forget 埋点不能静默失效）', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    table('ff').insert({ id: 'e1', v: 1 })
    eq(db.__dump('ff').length, 0, '同步阶段尚未发出')
    await tick()
    eq(db.__dump('ff').length, 1, '微任务兜底后应已落库')
  })

  it('集合不可用时返回 error（不抛异常穿透业务层）', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    db.__setFailing('broken', true)
    const res = await table('broken').select('*')
    ok(res.error, '应返回 error')
    eq(res.data, null)
  })
})

/* ------------------------------------------------------------------ auth */

describe('登录 utils/auth', () => {
  it('首次登录：写入 users 占位行，并把 _openid 作为 userId', async () => {
    fresh()
    const { useAuth } = env.load('stores/auth')
    const { ensureLogin } = env.load('utils/auth')

    await ensureLogin()

    const rows = env.db.__dump('users')
    eq(rows.length, 1)
    eq(useAuth.getState().userId, rows[0]._openid)
    eq(useAuth.getState().ready, true)
    eq(useAuth.getState().error, null)
    ok(rows[0].created_at, '应有 created_at')
    ok(rows[0].last_seen_at, '应有 last_seen_at')
  })

  it('已登录时 ensureLogin 直接短路，不再插入第二行', async () => {
    const { useAuth } = env.load('stores/auth')
    const { ensureLogin } = env.load('utils/auth')
    const before = env.db.__dump('users').length
    await ensureLogin()
    await ensureLogin()
    eq(env.db.__dump('users').length, before)
    ok(useAuth.getState().userId)
  })

  it('并发登录只插一行（在途去重）', async () => {
    fresh()
    env.load('stores/auth')
    const { ensureLogin } = env.load('utils/auth')
    await Promise.all([ensureLogin(), ensureLogin(), ensureLogin()])
    eq(env.db.__dump('users').length, 1, '并发应去重，只初始化一次')
  })

  it('登录态落盘：冷启免登录（清模块缓存后仍恢复）', async () => {
    fresh()
    const { useAuth } = env.load('stores/auth')
    const { ensureLogin } = env.load('utils/auth')
    await ensureLogin()
    const uid = useAuth.getState().userId
    const cached = env.storage.get('auth:profile')
    eq(cached.userId, uid)

    env.resetModules() // 模拟冷启：模块全丢，storage 保留
    const again = env.load('stores/auth').useAuth.getState()
    eq(again.userId, uid)
    eq(again.ready, true)
  })

  it('本地缓存结构非法时忽略并回到未登录（不拿脏数据当身份）', async () => {
    env.resetData()
    env.storage.set('auth:profile', { userId: 123, nickname: 'x' })
    env.resetModules()
    const st = env.load('stores/auth').useAuth.getState()
    eq(st.userId, null)
    eq(st.ready, false)
  })

  it('取不到 _openid 时给出可执行的错误提示（users 权限配错场景）', async () => {
    env.resetAll()
    env.db.__seed('users', [{ _id: 'u1', created_at: 'x' }])
    const { useAuth } = env.load('stores/auth')
    const { ensureLogin } = env.load('utils/auth')

    await ensureLogin()

    const st = useAuth.getState()
    eq(st.userId, null)
    ok(st.error && st.error.includes('users 集合权限'), `实际：${st.error}`)
    eq(env.db.__dump('users').length, 1, '已有行时不应再插一行')
  })

  it('readSelf 无人时返回 null（权限为「仅创建者可读写」时的预期结果）', async () => {
    fresh()
    const { readSelf } = env.load('utils/auth')
    eq(await readSelf(), null)
  })
})

/* ---------------------------------------------------------------- events */

describe('埋点 utils/events', () => {
  it('track 非阻塞写入，字段与主键形态符合约定', async () => {
    const { db, load } = fresh()
    login('u-ev')
    const { track } = load('utils/events')

    track('search', { personKey: '张三#tech', q: '张三' })
    await tick()

    const rows = db.__dump('events')
    eq(rows.length, 1)
    eq(rows[0].event, 'search')
    eq(rows[0].openid, 'u-ev')
    eq(rows[0].person_key, '张三#tech')
    eq(rows[0].props.q, '张三')
    ok(/^\d+#[a-z0-9]{6}$/.test(rows[0]._id), `主键形态应为 ts#rand，实际 ${rows[0]._id}`)
    ok(rows[0].created_at)
  })

  it('未登录时 openid 落 null，不伪造身份', async () => {
    const { db, load } = fresh()
    load('stores/auth')
    const { track } = load('utils/events')
    track('messages_open', { unread: 2 })
    await tick()
    eq(db.__dump('events')[0].openid, null)
  })

  it('无 personKey 时落 null（不写空串）', async () => {
    const { db, load } = fresh()
    login('u-ev2')
    const { track } = load('utils/events')
    track('share')
    await tick()
    eq(db.__dump('events')[0].person_key, null)
  })

  it('events 集合不可写时静默失败，不影响业务路径', async () => {
    const { db, load } = fresh()
    login('u-ev3')
    const { track } = load('utils/events')
    db.__setFailing('events', true)

    let threw = false
    try {
      track('follow', { personKey: '李四#ent' })
      await tick()
    } catch {
      threw = true
    }
    notOk(threw, 'track 不应把异常抛给调用方')
    eq(db.__dump('events').length, 0)
  })
})

/* ------------------------------------------------------------- favorites */

describe('收藏 utils/favorites', () => {
  it('makeFavoriteId 稳定且形态为 openid#type#8位hex', async () => {
    const { load } = fresh()
    const { makeFavoriteId } = load('utils/favorites')

    const a = makeFavoriteId('u1', 'quote', '内容')
    eq(a, makeFavoriteId('u1', 'quote', '内容'), '同输入必须同主键')
    ok(/^u1#quote#[0-9a-f]{8}$/.test(a), `实际 ${a}`)
    notOk(makeFavoriteId('u1', 'quote', '内容') === makeFavoriteId('u1', 'report', '内容'), '类型应参与散列')
    notOk(makeFavoriteId('u1', 'quote', '内容') === makeFavoriteId('u1', 'quote', '别的内容'), '内容应参与散列')
    notOk(makeFavoriteId('u1', 'quote', 'x') === makeFavoriteId('u2', 'quote', 'x'), '用户应参与主键')
  })

  it('未登录时拒绝收藏并提示去登录', async () => {
    const { load } = fresh()
    load('stores/auth')
    const { favoriteQuote } = load('utils/favorites')
    const okFlag = await favoriteQuote('张三#tech', '张三', { text: '一句话' })
    eq(okFlag, false)
    ok(env.findTaroCall('showToast'), '应弹出提示')
  })

  it('收藏名言幂等：重复收藏不产生第二行，且保留首次收藏时间', async () => {
    const { db, load } = fresh()
    login()
    const { favoriteQuote } = load('utils/favorites')

    eq(await favoriteQuote('张三#tech', '张三', { text: '内容A', context: '发布会' }), true)
    const first = db.__dump('favorites')[0]
    await new Promise((r) => setTimeout(r, 5))
    eq(await favoriteQuote('张三#tech', '张三', { text: '内容A', context: '发布会改' }), true)

    const rows = db.__dump('favorites')
    eq(rows.length, 1, '同句重复收藏应幂等')
    eq(rows[0].created_at, first.created_at, '首次收藏时间不应被冲掉')
    eq(rows[0].payload.context, '发布会改', '内容快照应刷新')
    eq(db.__dump('events').length, 2, '每次收藏都应有埋点')
  })

  it('四类收藏的键口径：报告按人、动态按 url、履历按「日期|事件」', async () => {
    const { db, load } = fresh()
    login()
    const { favoriteReport, favoriteDynamic, favoriteTimeline, FAVORITE_TYPE_LABEL } = load('utils/favorites')

    await favoriteReport('张三#tech', '张三', { heat: 60, mode: 'fast', generatedAt: 'x' })
    await favoriteReport('张三#tech', '张三', { heat: 70, mode: 'deep', generatedAt: 'y' })
    eq(db.__dump('favorites').filter((r) => r.type === 'report').length, 1, '一人一份报告收藏')

    await favoriteDynamic('张三#tech', '张三', { date: '2026-09-01', title: 'T1', url: 'https://a/1' })
    await favoriteDynamic('张三#tech', '张三', { date: '2026-09-01', title: '改了标题', url: 'https://a/1' })
    eq(db.__dump('favorites').filter((r) => r.type === 'dynamic').length, 1, '标题漂移不应产生第二条')
    await favoriteDynamic('张三#tech', '张三', { date: '2026-09-02', title: 'T2', url: 'https://a/2' })
    eq(db.__dump('favorites').filter((r) => r.type === 'dynamic').length, 2)

    await favoriteTimeline('张三#tech', '张三', { date: '2020-01-01', event: '入职' })
    await favoriteTimeline('张三#tech', '张三', { date: '2020-01-01', event: '入职' })
    eq(db.__dump('favorites').filter((r) => r.type === 'timeline').length, 1)

    eq(FAVORITE_TYPE_LABEL.quote, '名言')
    eq(FAVORITE_TYPE_LABEL.timeline, '时间线')
  })

  it('isFavorited 反映真实收藏状态', async () => {
    const { load } = fresh()
    login()
    const { favoriteQuote, isFavorited } = load('utils/favorites')

    const key = '张三#tech:内容B'
    eq(await isFavorited('quote', key), false)
    await favoriteQuote('张三#tech', '张三', { text: '内容B' })
    eq(await isFavorited('quote', key), true, '内容键应与写入时一致')
    eq(await isFavorited('report', '张三#tech'), false, '类型不同不应命中')
  })

  it('收藏列表按类型筛选、时间倒序', async () => {
    const { load } = fresh()
    login()
    const { favoriteQuote, favoriteReport, listFavorites } = load('utils/favorites')

    await favoriteQuote('张三#tech', '张三', { text: '早' })
    await new Promise((r) => setTimeout(r, 5))
    await favoriteReport('张三#tech', '张三', { heat: 1, mode: 'fast', generatedAt: 'x' })

    const all = await listFavorites()
    eq(all.length, 2)
    eq(all[0].type, 'report', '最新的应排在最前')

    const onlyQuote = await listFavorites('quote')
    eq(onlyQuote.length, 1)
    eq(onlyQuote[0].type, 'quote')
  })

  it('删除收藏按主键生效', async () => {
    const { db, load } = fresh()
    login()
    const { favoriteQuote, listFavorites, removeFavorite } = load('utils/favorites')

    await favoriteQuote('张三#tech', '张三', { text: '待删' })
    const [row] = await listFavorites()
    await removeFavorite(row.id)
    eq(db.__dump('favorites').length, 0)
  })

  it('未登录时列表返回空数组而不是报错', async () => {
    const { load } = fresh()
    load('stores/auth')
    const { listFavorites } = load('utils/favorites')
    deepEq(await listFavorites(), [])
  })

  it('收藏名言落库 background / note，缺字段时归一成空串', async () => {
    const { db, load } = fresh()
    login()
    const { favoriteQuote } = load('utils/favorites')

    await favoriteQuote('张三#tech', '张三', {
      text: '内容C',
      context: '发布会',
      background: '在 X 论坛上说的',
      note: '标志性表态'
    })
    const first = db.__dump('favorites')[0].payload
    eq(first.background, '在 X 论坛上说的')
    eq(first.note, '标志性表态')

    /* 老缓存里的名言没有这两个键：必须归一成空串，卡片才能靠空串判断「少渲染一行」 */
    await favoriteQuote('张三#tech', '张三', { text: '内容D' })
    const second = db.__dump('favorites').find((r) => r.payload.text === '内容D').payload
    eq(second.background, '')
    eq(second.note, '')
    eq(second.source, '据公开资料', 'source 缺省仍是兜底值')
  })

  /*
   * 报告卡的内容摘要（收藏卡改版）。
   * 输入刻意用「报告形状的最小对象」而不是完整 report：这个纯函数只认 dynamics / coverage，
   * 造一份真报告反而把用例的意图（两行的取值优先级）埋进无关字段里。
   */
  it('reportDigestOf：最新优先取素材画像的原样值，缺画像时退回最新日期动态', () => {
    const { load } = fresh()
    const { reportDigestOf } = load('utils/favorites')

    deepEq(
      reportDigestOf({
        dynamics: [
          { date: '2026-09-01', title: '较早', source: '媒体A' },
          { date: '2026-09-05', title: '较新', source: '媒体B' }
        ],
        coverage: {
          items: 40,
          recent: 12,
          latest: { title: '素材里的最新', source: '媒体C', url: 'https://a/1' }
        }
      }),
      { latest: '素材里的最新', latestMeta: '媒体C', coverage: '素材 40 条 · 近 7 天 12 条' },
      'coverage.latest 是博查原值（事实），优先于模型写的动态'
    )

    deepEq(
      reportDigestOf({
        dynamics: [
          { date: '2026-09-01', title: '较早', source: '媒体A' },
          { date: '2026-09-05', title: '较新', source: '媒体B' },
          { date: '', title: '没日期', source: '媒体D' }
        ],
        coverage: null
      }),
      { latest: '较新', latestMeta: '2026-09-05 · 媒体B', coverage: '' },
      '没有画像时退回最新日期动态，且没日期的条目不参与比较'
    )
  })

  it('reportDigestOf：没有任何可取内容时返回 null（卡片退化成只显示热度）', () => {
    const { load } = fresh()
    const { reportDigestOf } = load('utils/favorites')
    eq(reportDigestOf({ dynamics: [], coverage: null }), null)
    eq(
      reportDigestOf({
        dynamics: [{ date: '2026-09-01', title: '   ' }],
        coverage: { items: 0, recent: 0 }
      }),
      null,
      '标题只有空白 / 画像两数皆 0，都不算「有内容」'
    )
  })

  it('SENTIMENT_TAG 只标偏离中性的两档', () => {
    const { load } = fresh()
    const { SENTIMENT_TAG } = load('utils/favorites')
    eq(SENTIMENT_TAG.positive, '积极')
    eq(SENTIMENT_TAG.negative, '消极')
    eq(SENTIMENT_TAG.neutral, undefined, '中性是默认值，标出来只是噪音')
  })
})

/* --------------------------------------------------------------- history */

describe('查询历史 utils/history', () => {
  const seedHistory = (db, n, userId) => {
    const now = Date.now()
    db.__seed(
      'history',
      Array.from({ length: n }, (_, i) => ({
        _id: `h${String(i).padStart(3, '0')}`,
        openid: userId,
        person_key: `p${i}#tech`,
        name: `P${i}`,
        ts: new Date(now - (i + 1) * 864e5).toISOString()
      }))
    )
  }

  it('连续查同一人不重复记录', async () => {
    const { db, load } = fresh()
    login()
    const { addHistory } = load('utils/history')

    await addHistory('张三#tech', '张三')
    await addHistory('张三#tech', '张三')
    eq(db.__dump('history').length, 1)
  })

  it('A → B → A 回访留两条流水，但「最近搜索」按人去重', async () => {
    const { db, load } = fresh()
    login()
    const { addHistory, listRecentHistory } = load('utils/history')
    const gap = () => new Promise((r) => setTimeout(r, 5)) // 拉开 ts，避免同毫秒并列

    await addHistory('A#tech', 'A')
    await gap()
    await addHistory('B#tech', 'B')
    await gap()
    await addHistory('A#tech', 'A')
    eq(db.__dump('history').length, 3, '写入侧只挡相邻重复')

    const recent = await listRecentHistory(10)
    eq(recent.length, 2, '读侧应按 person_key 去重')
    eq(recent[0].person_key, 'A#tech', '保留最近一次')
  })

  it('同毫秒写入时「最近一次」不依赖顺序稳定性（只保证去重）', async () => {
    const { db, load } = fresh()
    const me = login()
    const { listRecentHistory } = load('utils/history')
    const t = new Date().toISOString()
    db.__seed('history', [
      { _id: '1', openid: me, person_key: 'A#tech', name: 'A', ts: t },
      { _id: '2', openid: me, person_key: 'B#tech', name: 'B', ts: t },
      { _id: '3', openid: me, person_key: 'A#tech', name: 'A', ts: t }
    ])
    const recent = await listRecentHistory(10)
    eq(recent.length, 2, '无论并列顺序如何，同名只出现一次')
    deepEq(recent.map((r) => r.person_key).sort(), ['A#tech', 'B#tech'])
  })

  it('同名不同领域视为两个人，各占一条', async () => {
    const { load } = fresh()
    login()
    const { addHistory, listRecentHistory } = load('utils/history')
    await addHistory('张三#tech', '张三')
    await addHistory('张三#ent', '张三')
    eq((await listRecentHistory(10)).length, 2)
  })

  it('写入后自动裁剪到 50 条', async () => {
    const { db, load } = fresh()
    const me = login()
    const { addHistory } = load('utils/history')
    seedHistory(db, 55, me)
    eq(db.__dump('history').length, 55)

    await addHistory('新人#tech', '新人')

    eq(db.__dump('history').length, 50, '溢出部分应被删除')
    ok(db.__dump('history').some((r) => r.person_key === '新人#tech'), '新记录不能被裁掉')
  })

  it('未登录不写入、列表返回空', async () => {
    const { db, load } = fresh()
    load('stores/auth')
    const { addHistory, listHistory } = load('utils/history')
    await addHistory('张三#tech', '张三')
    eq(db.__dump('history').length, 0)
    deepEq(await listHistory(), [])
  })

  it('清空历史只清自己的记录', async () => {
    const { db, load } = fresh()
    login('me')
    const { clearHistory, listHistory } = load('utils/history')
    seedHistory(db, 3, 'me')
    seedHistory(db, 2, '别人')
    await clearHistory()
    eq((await listHistory()).length, 0)
    eq(db.__dump('history').filter((r) => r.openid === '别人').length, 2, '不应误删他人记录')
  })

  it('listHistory 时间倒序且最多 50 条', async () => {
    const { db, load } = fresh()
    const me = login()
    const { listHistory } = load('utils/history')
    seedHistory(db, 55, me)
    const rows = await listHistory()
    eq(rows.length, 50)
    for (let i = 1; i < rows.length; i++) ok(rows[i - 1].ts >= rows[i].ts, '应按 ts 倒序')
  })
})
