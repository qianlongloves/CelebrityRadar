'use strict'

/**
 * 用户配置上云：真源一致 / 云函数 userInit / 端上读写。
 *
 * 覆盖四件事：
 *   ① `users.settings` 的默认值与键白名单只有一个真源（src/config/user-defaults.ts），
 *      端上、云端副本、schema 三处对得上；
 *   ② 云函数 userInit 的 ensure（幂等初始化 + 缺键补齐 + 版本号）与
 *      set（白名单 + 类型校验 + 点路径更新）；
 *   ③ 端上登录走云端初始化、云函数未部署时回退端上，且登录后把云端偏好灌进本地缓存；
 *   ④ 端上改偏好：本地立即生效 + 推送云端；推送失败留队列、下次登录重放。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ALL_OFF = {
  disableGenerateQuota: false,
  disableAskQuota: false,
  disableRefreshQuota: false,
  disableCooldown: false
}

function fresh(flags) {
  env.resetAll()
  env.setDebugFlags(Object.assign({}, ALL_OFF, flags))
  return { db: env.db, load: env.load }
}

const ROOT = path.resolve(__dirname, '..', '..')
const rel = (...p) => path.join(ROOT, ...p)
const read = (p) => fs.readFileSync(p, 'utf8')

/**
 * 去掉注释再看代码。
 *
 * 静态断言判的是「有没有这段**代码**」，而注释里为了讲清旧实现，常常原样引一句
 * 被禁掉的写法（如 `settings: {}`）—— 不剥注释就会把「解释」当成「重犯」。
 * 只处理 `//` 与 `/* *\/`；字符串里的 `://`（如 `cloud://`）不受影响（`//` 前是 `:`）。
 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** 本文件跑在 mock 身份下（cloud-db 里 add 自动注入的 _openid） */
const ME = 'mock-openid-0001'

/** 真源（同步脚本负责执行它，这里直接复用同一个装载器，免得两处口径不同） */
function userDefaults() {
  const sync = require('../../scripts/sync-config')
  const src = sync.SOURCES.find((s) => s.key === 'user-defaults')
  ok(src, '同步脚本里没有 user-defaults 真源')
  return { sync, src, data: sync.loadSource(src.source) }
}

/**
 * 在内存里执行云函数（不落中间文件），`wx-server-sdk` 用假替身。
 *
 * 与 07 的 loadProxy 同思路：测的是**云函数源码本身**，而不是替身的行为 ——
 * userInit 的价值全在那几行（幂等、补齐、白名单、点路径），替身写不出这些。
 */
function loadCloudFn(name, openid) {
  const file = rel('cloudfunctions', name, 'index.js')
  const code = read(file)
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: 'dyn-mock',
    init: () => {},
    database: () => env.db.database(),
    getWXContext: () => ({ OPENID: openid })
  }
  const mod = { exports: {} }
  const shim = (id) => {
    if (id === 'wx-server-sdk') return cloudMock
    if (id.startsWith('./')) return require(path.join(path.dirname(file), id))
    return require(id)
  }
  /* eslint-disable-next-line no-new-func */
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports,
    shim,
    mod,
    file,
    path.dirname(file)
  )
  return mod.exports.main
}

/** 让出事件循环若干次：端上的云端同步是 fire-and-forget，用例要等它跑完 */
async function settle(times = 3) {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('用户配置 · 真源一致', () => {
  it('SETTINGS_KEYS 与 DEFAULT_USER_SETTINGS 一一对应，版本号是正整数', () => {
    const { data } = userDefaults()
    ok(Array.isArray(data.SETTINGS_KEYS) && data.SETTINGS_KEYS.length > 0, 'SETTINGS_KEYS 不能为空')
    ok(
      Number.isInteger(data.SETTINGS_VERSION) && data.SETTINGS_VERSION >= 1,
      'SETTINGS_VERSION 必须是 >= 1 的整数（ensure 靠它判断要不要补齐）'
    )
    deepEq(
      Object.keys(data.DEFAULT_USER_SETTINGS).sort(),
      data.SETTINGS_KEYS.slice().sort(),
      '默认值的键与白名单不一致：缺了键的默认值，ensure 不知道该补什么'
    )
    /* 默认值必须能过 JSON：真源会被序列化成云端副本 */
    ok(
      JSON.stringify(data.DEFAULT_USER_SETTINGS).length < 200,
      '默认值不该塞进大对象：这一列是纯偏好，不是数据仓库'
    )
  })

  it('schema 里 settings 与 settings_version 就位，且写明「不得作权限依据」', () => {
    const schema = read(rel('cloudfunctions', 'dbInit', 'schema.js'))
    ok(schema.includes('settings_version'), 'users 缺 settings_version 字段（加配置项就没有迁移依据了）')
    ok(
      /f\('settings', 'object'/.test(schema) && /f\('settings_version', 'number'/.test(schema),
      'users 的 settings / settings_version 字段定义不见了'
    )
    ok(
      /不得读本列做判定/.test(schema),
      'schema 没写明「settings 不得作权限依据」：users 是仅创建者可读写，端上能改自己那一行'
    )
  })

  it('权限判定方（aiProxy / quotaGuard）不读用户偏好：偏好不是权限来源', () => {
    for (const fn of ['aiProxy', 'quotaGuard']) {
      const code = read(rel('cloudfunctions', fn, 'index.js'))
      notOk(code.includes('settings'), `${fn} 读了 settings：偏好栏不得参与权限 / 额度判定`)
    }
  })

  it('端上没有第二个 settings 写口：只有 settings.ts 走云函数，auth.ts 不再写空配置', () => {
    const s = read(rel('src', 'utils', 'settings.ts'))
    notOk(s.includes("collection('users')"), 'settings.ts 直接写库了：改配置必须走云函数 userInit')
    notOk(s.includes("table('users')"), 'settings.ts 直接写库了：改配置必须走云函数 userInit')
    ok(s.includes("callCloudFunction('userInit'"), 'settings.ts 没有走 userInit 云函数')

    const a = stripComments(read(rel('src', 'utils', 'auth.ts')))
    notOk(a.includes('settings: {}'), 'auth.ts 还在写空配置：默认值必须来自 config/user-defaults.ts')
    ok(a.includes('DEFAULT_USER_SETTINGS'), 'auth.ts 的回退初始化没有用真源默认值')
    ok(a.includes("'userInit'"), 'auth.ts 登录时没有调用 userInit 初始化')
  })

  it('端上「云端键 → 本地缓存键」映射覆盖全部白名单', () => {
    const { load } = fresh()
    const defs = load('config/user-defaults')
    const map = load('utils/settings').settingLocalKeyMap()
    for (const key of defs.SETTINGS_KEYS) {
      ok(map[key], `配置项 ${key} 没有本地缓存键映射：hydrate 时会被静默丢掉`)
    }
    eq(
      Object.keys(map).length,
      defs.SETTINGS_KEYS.length,
      '映射表里有白名单之外的键（多出来的映射没人用，早晚过期）'
    )
  })

  it('payCallback 的 users 镜像只写 membership：会员变更不该顺带改偏好', () => {
    const pay = read(rel('cloudfunctions', 'payCallback', 'index.js'))
    const at = pay.indexOf("collection('users')")
    ok(at >= 0, 'payCallback 没有写 users 镜像（端上就看不到会员态了）')
    const seg = pay.slice(at, at + 600)
    ok(seg.includes('membership'), 'payCallback 的 users 写入里没有 membership')
    notOk(seg.includes('settings'), 'payCallback 碰了用户偏好：会员变更只该动 membership')
  })
})

describe('用户配置 · 云函数 userInit', () => {
  it('ensure：首次调用建行，带完整默认配置与版本号', async () => {
    const { db } = fresh()
    const main = loadCloudFn('userInit', ME)
    const res = await main({ action: 'ensure' })
    eq(res.ok, true, `ensure 失败：${res.error}`)
    eq(res.created, true, '空表时 ensure 应报告新建')

    const rows = db.__dump('users')
    eq(rows.length, 1, `应只建一行，实际 ${rows.length} 行`)
    eq(rows[0]._openid, ME, '_openid 必须显式写：云函数的 add 不会自动注入（客户端才会）')
    deepEq(
      rows[0].settings,
      { llm_provider: null, llm_tier: null },
      '建行时应写完整默认配置，而不是一句 settings: {}'
    )
    eq(rows[0].settings_version, 1, '版本号没写：以后加配置项就没有补齐依据了')
    ok(typeof rows[0].created_at === 'string', 'created_at 应是 ISO 字符串')
  })

  it('ensure 幂等：已补齐的行再调一次，不产生任何写', async () => {
    const { db } = fresh()
    const main = loadCloudFn('userInit', ME)
    await main({ action: 'ensure' })
    const before = db.stats.docUpdateCalls

    const res = await main({ action: 'ensure' })
    eq(res.created, false, '第二次不该再建行')
    deepEq(res.patched, [], '已补齐的行不该有任何补丁')
    eq(
      db.stats.docUpdateCalls,
      before,
      `稳态 ensure 不该写库（每次登录都写一次是无谓的写放大）：期望 ${before}，实际 ${db.stats.docUpdateCalls}`
    )
    eq(db.__dump('users').length, 1, 'ensure 不该插出第二行')
  })

  it('ensure 补齐存量行：老用户的空配置被填成默认值，已有值一律不动', async () => {
    const { db } = fresh()
    db.__seed('users', [
      {
        _id: 'old1',
        _openid: ME,
        nickname: '老王',
        settings: { llm_tier: 'reason' },
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ])
    const main = loadCloudFn('userInit', ME)
    const res = await main({ action: 'ensure' })
    eq(res.ok, true, `ensure 失败：${res.error}`)
    eq(res.created, false, '有行时不该建新行')

    const row = db.__dump('users')[0]
    eq(row.settings.llm_tier, 'reason', '用户自己选过的值不能被默认值盖掉')
    eq(row.settings.llm_provider, null, '缺失的键应被补成默认值')
    eq(row.settings_version, 1, '补齐后要写上版本号')
    eq(row.nickname, '老王', 'ensure 不该动别的字段')
    ok(res.patched.indexOf('settings') >= 0, '回报里应说明补了 settings')
  })

  it('set：白名单内的键可写，且不丢其它键（点路径更新，不是整对象覆盖）', async () => {
    const { db } = fresh()
    db.__seed('users', [
      {
        _id: 'u1',
        _openid: ME,
        settings: { llm_provider: 'deepseek', llm_tier: null },
        settings_version: 1,
        created_at: '2026-01-01T00:00:00.000Z'
      }
    ])
    const main = loadCloudFn('userInit', ME)
    const res = await main({ action: 'set', key: 'llm_tier', value: 'reason' })
    eq(res.ok, true, `set 失败：${res.error}`)

    const row = db.__dump('users')[0]
    eq(row.settings.llm_tier, 'reason', '档位没写进去')
    eq(row.settings.llm_provider, 'deepseek', '整对象覆盖把同行的另一个配置项抹掉了')
  })

  it('set：白名单外的键被拒（settings 不能变成任意网盘）', async () => {
    const { db } = fresh()
    const main = loadCloudFn('userInit', ME)
    const res = await main({ action: 'set', key: 'admin', value: true })
    eq(res.ok, false, '白名单外的键应被拒')
    ok(String(res.error).includes('不认识的配置项'), `拒绝理由要说清：${res.error}`)

    const rows = db.__dump('users')
    const settings = (rows[0] && rows[0].settings) || {}
    notOk('admin' in settings, '被拒的键不该出现在库里')
  })

  it('set：类型必须与默认值一致，null 表示清除（回落默认）', async () => {
    const { db } = fresh()
    const main = loadCloudFn('userInit', ME)
    const bad = await main({ action: 'set', key: 'llm_tier', value: { v: 1 } })
    eq(bad.ok, false, '对象类型的值应被拒（否则偏好栏能塞进任意结构）')

    const good = await main({ action: 'set', key: 'llm_tier', value: null })
    eq(good.ok, true, 'null 表示清除偏好，必须允许')
    eq(db.__dump('users')[0].settings.llm_tier, null, '清除应写成 null')
  })

  it('没有 OPENID 就拒绝：不能凭空造用户', async () => {
    const { db } = fresh()
    const main = loadCloudFn('userInit', '')
    const res = await main({ action: 'ensure' })
    eq(res.ok, false, '缺 OPENID 时应拒绝（身份只能来自 getWXContext）')
    eq(db.__dump('users').length, 0, '被拒时不该留下任何行')
  })

  it('未知 action 被拒，而不是静默当成 ensure', async () => {
    fresh()
    const main = loadCloudFn('userInit', ME)
    const res = await main({ action: 'dropAll' })
    eq(res.ok, false, '未知 action 应被拒')
    ok(String(res.error).includes('未知 action'), `拒绝理由要说清：${res.error}`)
  })

  it('重复行：取最早那行当权威并报告数量，但不擅自删行', async () => {
    const { db } = fresh()
    db.__seed('users', [
      {
        _id: 'later',
        _openid: ME,
        settings: { llm_provider: null, llm_tier: null },
        settings_version: 1,
        created_at: '2026-03-01T00:00:00.000Z'
      },
      {
        _id: 'earlier',
        _openid: ME,
        settings: { llm_provider: null, llm_tier: null },
        settings_version: 1,
        created_at: '2025-12-01T00:00:00.000Z'
      }
    ])
    const main = loadCloudFn('userInit', ME)
    const res = await main({ action: 'ensure' })
    eq(res.row._id, 'earlier', '应取 created_at 最早的一行当权威')
    eq(res.duplicates, 1, '应报告重复行数量（运维要看得见）')
    eq(db.__dump('users').length, 2, '删用户的 users 行是不可逆操作，ensure 不该擅自删')
  })
})

describe('用户配置 · 云函数 userBackfill（一次性补齐存量行）', () => {
  /* 老用户行的样子：改造前端上首登插的 settings: {} —— 白名单键一个都不在 */
  const legacyRow = (id, openid, extra) =>
    Object.assign(
      { _id: id, _openid: openid, settings: {}, created_at: '2026-01-01T00:00:00.000Z' },
      extra || {}
    )

  it('拒绝端上调用：带 OPENID 一律不执行（它能全表扫描并写库）', async () => {
    const { db } = fresh()
    db.__seed('users', [legacyRow('old1', ME)])
    /* 端上身份：getWXContext().OPENID 有值 ⇒ 与定时器 / 控制台的判据反过来 */
    const main = loadCloudFn('userBackfill', ME)
    /* stats 不随 __reset 清零（跨用例累积），所以这里比差值 */
    const before = db.stats.docUpdateCalls
    const res = await main({ apply: true })
    eq(res.ok, false, '端上调用必须被拒：否则改个包就能点火一次全表补齐')
    eq(db.stats.docUpdateCalls, before, '被拒时不该有任何写')
    deepEq(db.__dump('users')[0].settings, {}, '被拒时数据必须原样')
  })

  it('默认 dry-run：只回报影响面，不落笔', async () => {
    const { db } = fresh()
    db.__seed('users', [legacyRow('old1', 'op-a')])
    const main = loadCloudFn('userBackfill', undefined)
    const before = db.stats.docUpdateCalls
    const res = await main({})
    eq(res.ok, true, `backfill 失败：${res.error}`)
    eq(res.apply, false, '不传 apply 就应停在 dry-run（线上 users 是真实用户数据）')
    eq(res.toPatch, 1, '应报告有一行待补')
    deepEq(res.detail[0].add, ['llm_provider', 'llm_tier'], '明细要说清缺了哪些键')
    eq(db.stats.docUpdateCalls, before, 'dry-run 不该写库')
    deepEq(db.__dump('users')[0].settings, {}, 'dry-run 后数据必须原样')
  })

  it('apply：补缺失键 + 版本号，已有值与非白名单键都不动', async () => {
    const { db } = fresh()
    db.__seed('users', [
      legacyRow('old1', 'op-a', {
        nickname: '老王',
        settings: { llm_tier: 'reason', legacy_key: 1 }
      })
    ])
    const main = loadCloudFn('userBackfill', undefined)
    const res = await main({ apply: true })
    eq(res.written, 1, '应写一行')
    eq(res.failed, 0)

    const row = db.__dump('users')[0]
    eq(row.settings.llm_tier, 'reason', '用户自己选过的值不能被默认值盖掉')
    eq(row.settings.llm_provider, null, '缺失的键应被补成真源默认值')
    eq(row.settings.legacy_key, 1, '非白名单键要保留（这是纯偏好列，不是清库存）')
    eq(row.settings_version, 1, '补齐后要写上版本号')
    eq(row.nickname, '老王', '不该动 settings / settings_version 以外的字段')
  })

  it('幂等：补齐后再跑一次不产生任何写', async () => {
    const { db } = fresh()
    db.__seed('users', [legacyRow('old1', 'op-a')])
    const main = loadCloudFn('userBackfill', undefined)
    await main({ apply: true })
    const before = db.stats.docUpdateCalls

    const res = await main({ apply: true })
    eq(res.toPatch, 0, '已补齐的行不该再被算作待补')
    eq(res.written, 0)
    eq(
      db.stats.docUpdateCalls,
      before,
      `稳态重跑不该写库：期望 ${before}，实际 ${db.stats.docUpdateCalls}`
    )
  })

  it('分页扫描：行数超过单次 get 上限时一行都不漏', async () => {
    const { db } = fresh()
    /* 25 > harness 复刻的平台单次上限 20 —— 按 PAGE 步进的分页会在这里漏掉 5 行 */
    const n = 25
    db.__seed(
      'users',
      Array.from({ length: n }, (_, i) => legacyRow(`old${i}`, `op-${i}`))
    )
    const main = loadCloudFn('userBackfill', undefined)
    const res = await main({ apply: true })
    eq(res.scanned, n, `应扫到全部 ${n} 行（分页要按实际取回条数推进）`)
    eq(res.written, n, '每行都该被补齐')
    eq(
      db.__dump('users').filter((r) => r.settings_version === 1).length,
      n,
      '不该有行被分页漏掉：漏了就永远停在空配置上'
    )
  })

  it('只差版本号的行单独计数；重复行如实报告但不删', async () => {
    const { db } = fresh()
    db.__seed('users', [
      {
        _id: 'a',
        _openid: 'op-dup',
        settings: { llm_provider: null, llm_tier: null },
        created_at: '2026-01-01T00:00:00.000Z'
      },
      {
        _id: 'b',
        _openid: 'op-dup',
        settings: { llm_provider: null, llm_tier: null },
        created_at: '2026-02-01T00:00:00.000Z'
      }
    ])
    const main = loadCloudFn('userBackfill', undefined)
    const res = await main({ apply: true })
    eq(res.toPatch, 2, '两行都缺版本号，都算待补')
    eq(res.versionOnly, 2, '键齐全、只是版本号落后的行要单独计数')
    eq(res.duplicates.length, 1, '同一 _openid 两行应被报告为重复')
    eq(res.duplicates[0].count, 2)
    eq(db.__dump('users').length, 2, '删用户的 users 行不可逆，backfill 不该擅自删')
    eq(db.__dump('users')[0].settings_version, 1, '版本号应被补上')
  })
})

describe('用户配置 · 端上读写', () => {
  it('登录：由云函数建行，端上不再是初始化者', async () => {
    const { db, load } = fresh()
    /* 替身直接转发到真云函数，避免替身与产品代码口径漂移 */
    env.registerCloudFn('userInit', (data) => loadCloudFn('userInit', ME)(data))

    await load('utils/auth').ensureLogin()
    const rows = db.__dump('users')
    eq(rows.length, 1, '登录应恰好产生一行')
    deepEq(rows[0].settings, { llm_provider: null, llm_tier: null }, '登录写下的应是完整默认配置')
    eq(load('stores/auth').useAuth.getState().userId, ME, 'userId 应来自云端注入的 _openid')
  })

  it('登录：把云端偏好灌进本地缓存（换设备后偏好跟着回来）', async () => {
    const { db, load } = fresh()
    db.__seed('users', [
      {
        _id: 'u1',
        _openid: ME,
        settings: { llm_provider: 'qwen', llm_tier: 'reason' },
        settings_version: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        last_seen_at: null
      }
    ])
    env.registerCloudFn('userInit', (data) => loadCloudFn('userInit', ME)(data))

    await load('utils/auth').ensureLogin()
    const settings = load('utils/settings')
    eq(settings.getPreferredProvider(), 'qwen', '云端选的供应商没灌进本地缓存')
    eq(settings.getPreferredTier(), 'reason', '云端选的档位没灌进本地缓存')
  })

  it('云函数未部署：回退端上初始化，写的仍是真源默认值', async () => {
    const { db, load } = fresh()
    /* 不注册 userInit ⇒ mock 按「未部署」抛 -501000，走回退路径 */
    await load('utils/auth').ensureLogin()
    const rows = db.__dump('users')
    eq(rows.length, 1, '回退路径也应恰好一行')
    deepEq(rows[0].settings, { llm_provider: null, llm_tier: null }, '回退时写的必须是真源默认值')
    eq(rows[0].settings_version, 1, '回退路径也要写版本号（否则下次会被判成待补齐）')
  })

  it('改偏好：本地立即生效 + 推送云端 set', async () => {
    const { load } = fresh()
    const calls = []
    env.registerCloudFn('userInit', (data) => {
      calls.push(data)
      return { ok: true, settings: { llm_tier: data.value } }
    })

    const settings = load('utils/settings')
    settings.setPreferredTier('reason')
    eq(settings.getPreferredTier(), 'reason', '本地应立即生效（离线也要能用）')

    await settle()
    eq(calls.length, 1, `应推送一次，实际 ${calls.length} 次`)
    deepEq(calls[0], { action: 'set', key: 'llm_tier', value: 'reason' })
  })

  it('推送失败：改动留在队列里，下次登录重放（离线改的偏好不会丢）', async () => {
    const { load } = fresh()
    const settings = load('utils/settings')
    settings.setPreferredProvider('deepseek') /* 云函数未部署 ⇒ 推送失败 */
    await settle()
    eq(settings.getPreferredProvider(), 'deepseek', '本地必须先生效')
    ok(env.rawStorage.has('settings:pending'), '推送失败的改动应进待同步队列')

    const calls = []
    env.registerCloudFn('userInit', (data) => {
      calls.push(data)
      return { ok: true }
    })
    settings.hydrateUserSettings({ llm_provider: null, llm_tier: null })
    await settle()
    eq(calls.length, 1, '队列里的改动应在下次登录时重放')
    deepEq(calls[0], { action: 'set', key: 'llm_provider', value: 'deepseek' })
    notOk(env.rawStorage.has('settings:pending'), '重放成功后队列应清空')
    eq(settings.getPreferredProvider(), 'deepseek', '重放不该把本地值改回去')
  })

  it('登录灌入：云端旧值不覆盖本地还没同步上去的改动', async () => {
    const { load } = fresh()
    const settings = load('utils/settings')
    settings.setPreferredTier('fast') /* 未部署 ⇒ 进队列 */
    await settle()

    settings.hydrateUserSettings({ llm_provider: 'qwen', llm_tier: 'reason' })
    eq(settings.getPreferredTier(), 'fast', '队列里的 llm_tier 比云端那份新，不该被覆盖')
    eq(settings.getPreferredProvider(), 'qwen', '本地没有改动的键应按云端值灌入')
    await settle()
  })

  it('清空我的数据：本地清空，并把云端那份复位（否则下次登录又会拉回来）', async () => {
    const { load } = fresh()
    const calls = []
    env.registerCloudFn('userInit', (data) => {
      calls.push(data)
      return { ok: true }
    })

    const settings = load('utils/settings')
    settings.setPreferredTier('reason')
    await settle()
    calls.length = 0

    settings.clearLocalSettings()
    eq(settings.getPreferredTier(), null, '本地应清空')
    await settle()

    const pushed = calls.map((c) => `${c.action}:${c.key}`).sort()
    deepEq(pushed, ['set:llm_provider', 'set:llm_tier'], '云端两项都应被复位')
    ok(
      calls.every((c) => c.value === null),
      '复位是把偏好设回默认值（null），而不是把键删掉'
    )
    notOk(env.rawStorage.has('settings:pending'), '复位推送成功后队列应清空')
  })
})

/* ────────────────── 注销账号（P1-4）：userInit/deleteAccount 云端删净 ────────────────── */

/**
 * 注销账号（P1-4，政策 §2.4 承诺的入口）：端上只管确认与善后，**删库全在云函数里**。
 *
 * 与「清空我的数据」（02-data.js）的分工：清空只删内容、留账号与同意；注销连账号行一起删，
 * 订单按《电子商务法》去标识化**保留行**（不删，只把 `_openid` 换成不可逆散列）。
 *
 * 五件事必须钉住：
 *   ① 本人全部个人数据删净，且**只删自己的**（跨用户误删是灾难级）；
 *   ② 订单去标识化、不再含原 openid；
 *   ③ 某张表删不掉时**不整体中止**（否则用户反而更删不干净），失败如实回报；
 *   ④ 重复调用安全；拿不到 OPENID 一律拒绝（控制台 / 定时器调不到注销）；
 *   ⑤ 删表清单与 `schema.js` 对齐 —— 日后新增带用户标识的集合时，这条会失败。
 */
describe('注销账号 · userInit/deleteAccount（P1-4）', () => {
  const OTHER = 'u-other'

  /** 按 openid 归属的集合（端上写口用 openid，云端记的账用 _openid，两种口径都要造） */
  const OWNED = [
    'users',
    'follows',
    'favorites',
    'history',
    'keyword_watches',
    'events',
    'generate_quota',
    'ask_quota',
    'refresh_quota',
    'ai_calls'
  ]

  /**
   * 共享集合：**行内不含任何用户标识**（全站共享的缓存 / 事件本体 / 平台成本计数），
   * 故注销时本就无需按用户删 —— 删了反而害了别人（它们不是「我的那一行」）。
   */
  const SHARED_NO_USER_ID = [
    'report_cache',
    'feed_cache',
    'hot_board',
    'keywords',
    'risk_scans',
    'risk_signals',
    'opinion_events',
    'person_assets',
    'deep_dive_quota',
    'scan_logs'
  ]

  /** 造一份「本人 + 别人」都有的库：每张归属表两行，才验得出「只删自己的」 */
  function seedAll(db) {
    db.__seed('users', [
      { _id: 'me-row', _openid: ME, nickname: '我', settings: {}, created_at: '2026-01-01T00:00:00.000Z' },
      { _id: 'other-row', _openid: OTHER, nickname: '别人', settings: {}, created_at: '2026-01-01T00:00:00.000Z' }
    ])
    for (const name of OWNED) {
      if (name === 'users') continue
      db.__seed(name, [
        { _id: `${name}-me`, openid: ME, _openid: ME, used: 3, event: 'search', props: {} },
        { _id: `${name}-other`, openid: OTHER, _openid: OTHER, used: 1, event: 'search', props: {} }
      ])
    }
    db.__seed('memberships', [
      { _id: ME, _openid: ME, plan: 'annual', expires_at: '2027-01-01T00:00:00.000Z' },
      { _id: OTHER, _openid: OTHER, plan: 'annual', expires_at: '2027-01-01T00:00:00.000Z' }
    ])
    db.__seed('opinion_event_status', [
      { _id: ME, _openid: ME, read: { ev1: 1 }, follow: { ev1: 'done' } },
      { _id: OTHER, _openid: OTHER, read: { ev1: 1 }, follow: {} }
    ])
    db.__seed('orders', [
      {
        _id: 'o-me',
        _openid: ME,
        plan: 'annual',
        amount_fen: 9900,
        days: 365,
        status: 'paid',
        created_at: '2026-05-01T00:00:00.000Z'
      },
      {
        _id: 'o-other',
        _openid: OTHER,
        plan: 'annual',
        amount_fen: 9900,
        days: 365,
        status: 'paid',
        created_at: '2026-05-01T00:00:00.000Z'
      }
    ])
  }

  /** 该表里还剩几行属于本人（三种归属口径：openid / _openid / `_id = openid`） */
  const mineLeft = (db, name) =>
    db.__dump(name).filter((r) => r.openid === ME || r._openid === ME || r._id === ME).length

  it('端上注销 → 云端删净本人全部个人数据、只留别人的；订单去标识化保留行', async () => {
    const { db, load } = fresh()
    seedAll(db)
    env.registerCloudFn('userInit', loadCloudFn('userInit', ME))

    const { deleteAccount } = load('utils/data-deletion')
    const res = await deleteAccount()
    eq(res.ok, true, `注销应成功：${res.message || ''}`)

    for (const name of OWNED) {
      eq(mineLeft(db, name), 0, `${name} 里还留着本人那一行`)
      eq(db.__dump(name).length, 1, `${name} 里别人的行不该被动`)
    }
    for (const name of ['memberships', 'opinion_event_status']) {
      deepEq(db.__dump(name).map((r) => r._id), [OTHER], `${name} 应只余别人的行（_id = openid）`)
    }

    const mineOrder = db.__dump('orders').find((r) => r._id === 'o-me')
    const otherOrder = db.__dump('orders').find((r) => r._id === 'o-other')
    ok(mineOrder, '订单不删行（《电子商务法》留存口径）')
    eq(otherOrder._openid, OTHER, '别人的订单不该被动')
    ok(
      typeof mineOrder.account_deleted_at === 'string',
      '应记下注销时刻，客服对账时才知道这单属销号用户'
    )
    ok(String(mineOrder._openid).indexOf('anon:') === 0, `订单必须去标识化，实际 ${mineOrder._openid}`)
    notOk(String(mineOrder._openid).includes(ME), '去标识化后的 _openid 不能再含原 openid')
    eq(mineOrder.amount_fen, 9900, '记账字段不该被顺手清掉（对账要用）')
  })

  it('某张表删不掉：如实回报 failed、其余照删（不为一张表失败而整体中止）', async () => {
    const { db, load } = fresh()
    seedAll(db)
    db.__setFailing('keyword_watches', true)
    env.registerCloudFn('userInit', loadCloudFn('userInit', ME))

    const { deleteAccount } = load('utils/data-deletion')
    const res = await deleteAccount()
    eq(res.ok, false, '有表没删掉就不能谎报成功（用户会以为已经注销干净）')
    ok(String(res.message).includes('keyword_watches'), `失败信息要点出是哪张表：${res.message}`)
    eq(mineLeft(db, 'users'), 0, 'users 行仍应删除（一张表删不掉不等于什么都不删）')
    eq(db.__dump('follows').length, 1, '其余表仍应删净')
    eq(db.__dump('keyword_watches').length, 2, '注入故障的表原样保留，且别人的行没被牵连')
  })

  it('幂等：已注销的账号再调一次仍 ok，且一行都不再删', async () => {
    const { db, load } = fresh()
    seedAll(db)
    const main = loadCloudFn('userInit', ME)
    env.registerCloudFn('userInit', main)

    const { deleteAccount } = load('utils/data-deletion')
    eq((await deleteAccount()).ok, true, '第一次注销应成功')

    const again = await main({ action: 'deleteAccount' })
    eq(again.ok, true, '重复注销不该报错（用户连点两次是常态）')
    ok(
      Object.values(again.deleted).every((n) => n === 0),
      `第二次应删 0 行，实际 ${JSON.stringify(again.deleted)}`
    )
    eq(db.__dump('users').length, 1, '不该动到别人的行')
  })

  it('拿不到 OPENID 一律拒绝：控制台 / 定时器调不到注销', async () => {
    const { db } = fresh()
    seedAll(db)
    const main = loadCloudFn('userInit', '')

    const res = await main({ action: 'deleteAccount' })
    eq(res.ok, false, '没有身份时必须拒绝')
    ok(String(res.error).includes('OPENID'), `应说明缺的是身份：${res.error}`)
    eq(mineLeft(db, 'users'), 1, '拒绝时一行都不该删')
    eq(db.__dump('follows').length, 2, '拒绝时一行都不该删')
  })

  it('删表清单与 schema 对齐：新增带用户标识的集合时这条必须失败（否则注销留残留）', () => {
    const schemaSrc = read(rel('cloudfunctions/dbInit/schema.js'))
    const fnSrc = read(rel('cloudfunctions/userInit/index.js'))

    /* 只认行首 4 空格缩进的集合声明；`deprecated: [{ name: 'note', ... }]` 是行尾内联的，不算集合 */
    const all = [...schemaSrc.matchAll(/^ {4}name: '([a-z_0-9]+)',$/gm)].map((m) => m[1])
    ok(all.length >= 20, `解析 schema 失败：只认出 ${all.length} 个集合（正则要跟着 schema 写法改）`)

    const purgeSrc = [...fnSrc.matchAll(/const PURGE_BY_[A-Z_]+ = \[([\s\S]*?)\]/g)]
      .map((m) => m[1])
      .join(',')
    ok(purgeSrc.length > 0, '解析不出 PURGE_BY_* 删表清单（正则要跟着云函数写法改）')
    const listed = new Set((purgeSrc.match(/'[a-z_0-9]+'/g) || []).map((s) => s.replace(/'/g, '')))
    listed.add('orders') /* 订单走「去标识化保留」而不是删除，故不在 PURGE_* 里 */

    const missing = all.filter((n) => !listed.has(n) && SHARED_NO_USER_ID.indexOf(n) === -1)
    deepEq(
      missing,
      [],
      `这些集合既不在注销删表清单里、也不在「行内无用户标识」白名单里，注销后会留残留：${missing.join('、')}`
    )
    /* 反向也要看一眼：白名单里的集合若哪天真的带上了用户标识，这份白名单就成了漏删的借口 */
    const wrong = SHARED_NO_USER_ID.filter((n) => all.indexOf(n) === -1)
    deepEq(wrong, [], `白名单里有 schema 中不存在的集合（写错了或是已改名）：${wrong.join('、')}`)
  })
})
