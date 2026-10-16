'use strict'

/**
 * 数据层：db 适配层的**列投影**（`select('a,b')`）。
 *
 * 由来（2026-10-16）：`db.ts#select` 原先的签名是 `select(_cols?: string)` —— 参数名前面
 * 那个下划线就是「故意不用」的意思，于是 `select('id')` 与 `select('*')` 完全等价：
 * 调用点以为自己只取主键在省流量，实际每次都在拉整行。更麻烦的是这件事**在测试里也测不出来**，
 * 因为 harness 的 mock 当时写的是 `field() { return this }`（参数同样被丢掉），
 * 于是「投影到底生效没有」只有真机才知道。
 *
 * 两边一起补齐后由本文件钉住三件事：
 *   ① 投影真的裁剪（未列出的字段必须拿不到）；
 *   ② `_id` 一定在（云开发始终返回它）—— 否则 `toRow` 映射不出 `id`，`select('id')` 反而拿不到主键；
 *   ③ 投影跟着**每一页**下发（只写在第一页，第二页就会把整行又拉回来）。
 */

const env = require('../harness/env')
const { describe, it, ok, eq } = require('../harness/t')

/** 每个用例从干净状态开始：清 storage + 清库 + 清模块缓存 */
function fresh() {
  env.resetAll()
  return { db: env.db, load: env.load }
}

describe('数据层：db 列投影（select 的参数不再被忽略）', () => {
  it("select('id') 只取主键：未列出的字段拿不到，且 id 仍可读", async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    db.__seed('favorites', [
      {
        _id: 'u1#report#张三',
        openid: 'u1',
        type: 'report',
        content_key: '张三',
        name: '张三',
        created_at: '2026-10-01T00:00:00.000Z'
      }
    ])

    const { data, error } = await table('favorites').select('id').eq('openid', 'u1')

    eq(error, null)
    eq(data.length, 1)
    /* 投影里没写 _id，云开发也照样返回它 —— 这条成立，`isFavorited` 那类「只看有没有」的
       调用点才敢只 select('id') */
    eq(data[0].id, 'u1#report#张三', 'id 由 _id 映回，投影不该把它弄丢')
    eq(data[0].content_key, undefined, '未列出的字段不得返回 —— 这条就是投影真的生效的证据')
    eq(data[0].name, undefined)
  })

  it('多列投影：select("id,name") 只给这两列', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    db.__seed('favorites', [
      { _id: 'u1#q#1', openid: 'u1', type: 'quote', name: '名言', content_key: '正文' }
    ])

    const { data } = await table('favorites').select('id, name').eq('openid', 'u1')

    eq(data[0].id, 'u1#q#1')
    eq(data[0].name, '名言')
    eq(data[0].content_key, undefined, '逗号分隔里的列才给，其余不给')
    eq(data[0].openid, undefined)
  })

  it("select('*') 与不带参数仍是全字段（别把通配符也裁掉）", async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    db.__seed('favorites', [
      { _id: 'u1#q#1', openid: 'u1', type: 'quote', name: '名言', content_key: '正文' }
    ])

    const all = await table('favorites').select('*').eq('openid', 'u1')
    eq(all.data[0].content_key, '正文', "'*' = 全字段")
    eq(all.data[0].openid, 'u1')

    const bare = await table('favorites').select().eq('openid', 'u1')
    eq(bare.data[0].content_key, '正文', '不带参数 = 全字段（既有调用点全走这条）')
  })

  it('投影跟着每一页下发：跨页续取时第 2 页也被裁剪', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    /* 25 条 → 内部分页要取 2 页（小程序端单页上限 20）。只把投影写在第一页上，
       第二页会把整行又拉回来 —— 那正是「省流量白省了」的那种 bug。 */
    const rows = []
    for (let i = 0; i < 25; i++) {
      rows.push({ _id: `u1#${String(i).padStart(2, '0')}`, openid: 'u1', name: `n${i}`, extra: 'x'.repeat(50) })
    }
    db.__seed('history', rows)

    const { data } = await table('history').select('id').eq('openid', 'u1').limit(25)

    eq(data.length, 25, '25 条必须跨页取全')
    ok(
      data.every((r) => r.name === undefined && r.extra === undefined),
      '第二页也必须被投影裁剪'
    )
    ok(
      data.every((r) => typeof r.id === 'string'),
      '每一页的主键都要在'
    )
  })

  it('没写 .order() 但要跨页时同样补稳定键：无序 skip 分页会重复或漏行', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    /* 兜底扫描（热门榜 / 会员示例在索引未建时的回落路径）就是「不排序 + 取一批」，而 batch > 单页上限
       时它同样走 skip 分页 —— 原先只有「有显式排序」才补 `_id`，这类查询就是真·无序翻页。
       验证手法与上一条相同：让**插入顺序与 `_id` 升序相反**。
         · 源码只在有排序时补 → 本条拿到插入顺序（_id 降序）→ 断言失败（能捕获回归）；
         · 无条件补（只要要翻页）→ 输出即 _id 升序。 */
    const ids = []
    const rows = []
    for (let i = 0; i < 40; i++) {
      const id = `r${String(i).padStart(2, '0')}`
      ids.push(id)
      rows.push({ _id: id, value: i })
    }
    db.__seed('report_cache', rows.slice().reverse())

    const { data } = await table('report_cache').select('id').limit(40)

    eq(data.length, 40, '40 条要一条不少（跨 2 页）')
    eq(new Set(data.map((r) => r.id)).size, 40, '不得重复 —— 稳定键下 skip 分页才不重不漏')
    eq(
      data.map((r) => r.id).join(','),
      ids.join(','),
      '无显式排序时也按 _id 升序：稳定键对「需要翻页的查询」一律下发'
    )
  })

  it('边界：只取一页（≤20 条）不补排序 —— 不翻页就没有「切到不确定位置」的问题', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    const ids = []
    const rows = []
    for (let i = 0; i < 15; i++) {
      const id = `q${String(i).padStart(2, '0')}`
      ids.push(id)
      rows.push({ _id: id, value: i })
    }
    db.__seed('history', rows.slice().reverse())

    const { data } = await table('history').select('id').limit(15)

    eq(data.length, 15)
    eq(
      data.map((r) => r.id).join(','),
      ids.slice().reverse().join(','),
      '单次 get 不翻页 ⇒ 不额外加排序（否则会给「只取一条」这类最高频查询平白加上一次排序）'
    )
  })

  it('排序自动补 _id 稳定次级键：同值文档按 _id 升序，而不是「库内不确定的先后」', async () => {
    const { db, load } = fresh()
    const { table } = load('utils/db')
    /* 场景：30 条 `last_at` **完全一样**（一轮聚类的产物就是这样 —— 同一分钟的时间戳），
       而取 30 条必然跨 2 页（小程序端单页上限 20），走的是 skip/limit 深分页。
       skip 分页只对**排序确定**的结果集安全：主排序值相同的这批文档在库里的先后没有承诺，
       顺序不定时第二页会切到不确定的位置 —— 重复或漏掉，且极难复现。

       验证手法：故意让**插入顺序与 _id 升序相反**。
         · 源码没补次级键 → 稳定排序保留插入顺序（倒序）→ 本条断言失败（能捕获回归）；
         · 源码补了 `_id` → 输出即 _id 升序。 */
    const ids = []
    const rows = []
    for (let i = 0; i < 30; i++) {
      const id = `e${String(i).padStart(2, '0')}`
      ids.push(id)
      rows.push({ _id: id, last_at: '2026-10-16T00:00:00.000Z' })
    }
    db.__seed('opinion_events', rows.slice().reverse())

    const { data } = await table('opinion_events')
      .select('id')
      .order('last_at', { ascending: false })
      .limit(30)

    eq(data.length, 30, '30 条要一条不少地取回（跨 2 页）')
    eq(new Set(data.map((r) => r.id)).size, 30, '不得重复 —— 稳定排序下 skip 分页才不重不漏')
    eq(
      data.map((r) => r.id).join(','),
      ids.join(','),
      '同 last_at 时按 _id 升序：说明稳定次级键真的下发了（不是靠库的偶然顺序）'
    )
  })
})
