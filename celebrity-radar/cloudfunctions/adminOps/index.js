/**
 * adminOps —— 运营与排障的统一入口（2026-10-12 新增）。
 *
 * 为什么要有它：此前排障要在控制台里逐个集合翻（users / memberships / 三张配额表 /
 * report_cache），而「界面说免费、云端说会员」这类问题恰恰要**同时看权威表与镜像表**
 * 才看得出来；临时写脚本调 payCallback 的运营口令又没有落点、每次都重写一遍。
 * 本函数把常规动作收成一张表，调用统一为 `{ action, token, ...参数 }`，
 * 返回统一为 `{ ok, action, ... }`。
 *
 * 两道闸门（与 payCallback / dbInit 同一套口径，缺一不可）：
 *   ① **调用方闸门**：端上 `wx.cloud.callFunction` 必带 openid，本函数一律拒绝 ——
 *      它是排障入口，端上没有任何理由调它；
 *   ② **口令闸门**：`ADMIN_OPS_TOKEN`，未配置时回退 `PAY_ADMIN_TOKEN`（省得再配一个口令）。
 *      两者都没有、或对不上，**一律拒绝**（fail-closed，与 dbInit 的 DB_ADMIN_TOKEN 同口径）。
 *
 * ⚠ 本函数**不直接写会员数据**：会员是「权威 memberships + 镜像 users.membership」双写、
 *   且有一套续期与只升不降口径，全项目唯一写口是 payCallback 的 `adminOp`
 *   （见该函数顶部注释）。这里的 grantMember / reconcile 只是**代理**过去，
 *   绝不在这里出现第二处会员写口。
 *
 * 动作表：
 *   ping             环境自检（口令来源 / 关键环境变量齐不齐 / 各集合通不通）—— 排障第一步
 *   findUser         按昵称模糊找 openid（只知道昵称时用）
 *   getUser          一个用户的全景：账号 + 会员（权威 vs 镜像）+ 当日配额 + 当日防滥用计数
 *   grantMember      代理 payCallback：手动发放 / 续期会员（续期基数 = max(now, 权威, 镜像)）
 *   reconcile        代理 payCallback：立刻跑一次对账（含镜像修复）
 *   resetQuota       清某用户某日的三张配额行 + 当日防滥用计数（联调常用）
 *   clearReportLock  把卡在 building 的报告锁恢复成 ready（生成中断留下的脏行）
 */

'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const msgOf = (err) => String((err && err.errMsg) || (err && err.message) || err)
const str = (v) => String(v == null ? '' : v).trim()

/**
 * 当日键（**必须与端上 todayKey() / quotaGuard / aiProxy 三方同口径**）：
 * 不加 8 小时会让北京时间 08:00 之前的计数落到前一天，与端上错位。
 * 真源说明见 cloudfunctions/aiProxy/quota.config.js#todayKey。
 */
function todayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 只在服务端跑：端上调用必带 openid，本函数一律拒绝 */
function callerGuard() {
  const wxContext = (cloud.getWXContext && cloud.getWXContext()) || {}
  if (wxContext.OPENID) {
    return { ok: false, error: '拒绝：本函数不接受端上调用（只供控制台 / CLI / MCP 排障）' }
  }
  return null
}

/** 口令闸门：ADMIN_OPS_TOKEN 优先，回退 PAY_ADMIN_TOKEN；都不配＝永远拒绝 */
function tokenGuard(event) {
  const required = process.env.ADMIN_OPS_TOKEN || process.env.PAY_ADMIN_TOKEN
  if (!required) {
    return {
      ok: false,
      error:
        '拒绝：未配置环境变量 ADMIN_OPS_TOKEN（也没有可回退的 PAY_ADMIN_TOKEN）。' +
        '运营写口不配口令一律拒绝 —— 「没配就放行」是最常见的一种自我安慰。'
    }
  }
  if (str(event.token) !== required) return { ok: false, error: '拒绝：event.token 与环境变量不符' }
  return null
}

/* ---------------------------------- 读库小工具 ---------------------------------- */

/** 按 openid 找 users 行（管理员身份，where 查得到任何人） */
async function findUserRow(openid) {
  const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

/** 读权威会员行（`where` 而非 doc().get()：「没有行」与「读失败」必须分开，见 payCallback） */
async function readMembership(openid) {
  const res = await db.collection('memberships').where({ _id: openid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

/** 读一张配额表的当日计数（行不存在＝0） */
async function readCount(collection, id) {
  const res = await db.collection(collection).where({ _id: id }).limit(1).get()
  const row = (res && res.data && res.data[0]) || null
  return row && typeof row.count === 'number' ? row.count : 0
}

/** 删一行（不存在也算成功，返回是否真的删掉了） */
async function dropRow(collection, id) {
  try {
    const res = await db.collection(collection).doc(id).remove()
    return (res && res.stats && res.stats.removed) || 0
  } catch (err) {
    return 0
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* ------------------------------------ 动作 ------------------------------------ */

const QUOTA_TABLES = [
  ['generate', 'generate_quota'],
  ['ask', 'ask_quota'],
  ['refresh', 'refresh_quota']
]

/** 环境自检：排障第一步 —— 先确认「口令配了没、集合通不通」，再看业务数据 */
async function ping() {
  const collections = ['users', 'memberships', 'ai_calls', 'report_cache', 'generate_quota', 'ask_quota', 'refresh_quota', 'orders']
  const probe = {}
  for (const name of collections) {
    try {
      const res = await db.collection(name).limit(1).get()
      probe[name] = `ok(${(res.data || []).length} 行样例)`
    } catch (err) {
      probe[name] = `fail: ${msgOf(err)}`
    }
  }
  return {
    today: todayKey(),
    node: process.version,
    tokenSource: process.env.ADMIN_OPS_TOKEN
      ? 'ADMIN_OPS_TOKEN'
      : process.env.PAY_ADMIN_TOKEN
        ? 'PAY_ADMIN_TOKEN（回退）'
        : '未配置',
    /* 只报「配没配」，不回报值 —— 口令不该进任何返回体与日志 */
    payAdminToken: process.env.PAY_ADMIN_TOKEN ? '已配置（grantMember / reconcile 可代理）' : '未配置（代理动作不可用）',
    collections: probe
  }
}

/** 只知道昵称时，先把它换成 openid */
async function findUser(e) {
  const openid = str(e.openid)
  if (openid) {
    const row = await findUserRow(openid)
    if (!row) return { found: 0, candidates: [] }
    return { found: 1, candidates: [{ _id: row._id, openid: row._openid, nickname: row.nickname, created_at: row.created_at }] }
  }
  const nickname = str(e.nickname)
  if (!nickname) return { error: '需要 openid 或 nickname' }
  const res = await db
    .collection('users')
    .where({ nickname: db.RegExp({ regexp: escapeRegExp(nickname), options: 'i' }) })
    .limit(20)
    .get()
  const candidates = (res.data || []).map((u) => ({
    _id: u._id,
    openid: u._openid,
    nickname: u.nickname,
    created_at: u.created_at
  }))
  return { found: candidates.length, candidates }
}

/**
 * 一个用户的全景。
 *
 * 最有用的其实是最后那两行派生结论：**权威（云端闸门读的）与镜像（界面读的）是否一致**。
 * 「付了钱但界面还是免费」「界面显示会员但云端判免费」这两种投诉，都要靠同时看两张表才定位得到。
 */
async function getUser(e) {
  const openid = str(e.openid)
  if (!openid) return { error: '需要 openid' }
  const day = str(e.day) || todayKey()

  const row = await findUserRow(openid)
  const auth = await readMembership(openid)

  const quotasToday = {}
  for (const [label, table] of QUOTA_TABLES) {
    quotasToday[label] = await readCount(table, `${openid}#${day}`)
  }

  const now = Date.now()
  const authActive = !!auth && Date.parse(auth.expires_at) > now
  const mirror = (row && row.membership) || null
  const mirrorActive = !!mirror && Date.parse(mirror.expires_at) > now

  return {
    day,
    found: !!row,
    user: row
      ? {
          _id: row._id,
          openid: row._openid,
          nickname: row.nickname,
          created_at: row.created_at,
          last_seen_at: row.last_seen_at,
          settings_version: row.settings_version,
          settings: row.settings,
          subscribe_ok: row.subscribe_ok,
          alert_ok: row.alert_ok,
          risk_ok: row.risk_ok
        }
      : null,
    authority: auth
      ? {
          plan: auth.plan,
          expires_at: auth.expires_at,
          last_order_id: auth.last_order_id,
          refunded_orders: auth.refunded_orders || [],
          mirror_checked_at: auth.mirror_checked_at
        }
      : null,
    mirror,
    isMember: authActive,
    mirrorMatchesAuthority: !!auth && !!mirror && mirror.expires_at === auth.expires_at,
    /* 一句话结论：两种「界面与权限对不上」的投诉全靠它一眼分辨（口径见上） */
    conclusion: !authActive && !mirrorActive
      ? '权威与镜像一致：都不是会员'
      : authActive && mirrorActive
        ? '权威与镜像一致：都是会员'
        : authActive
          ? '⚠ 云端已按会员放行，界面仍显示免费（镜像没跟上）—— 跑一次 reconcile 修复'
          : '⚠ 界面显示会员，云端判非会员（以权威为准）—— 检查 memberships 权威行',
    quotasToday,
    abuseCallsToday: await readCount('ai_calls', `${openid}#${day}`)
  }
}

/** 代理到 payCallback 的运营写口（会员数据的**唯一**写口，见文件头） */
async function proxyToPayCallback(payload) {
  const token = process.env.PAY_ADMIN_TOKEN
  if (!token) {
    return { proxyError: '未配置 PAY_ADMIN_TOKEN：代理动作不可用（请在 adminOps 的环境变量里补上，与 payCallback 同值）' }
  }
  const res = await cloud.callFunction({ name: 'payCallback', data: Object.assign({ token }, payload) })
  return { result: (res && res.result) || null }
}

/** 手动发放 / 续期会员：参数与 payCallback 的 adminOp=grantMember 完全一致 */
async function grantMember(e) {
  const openid = str(e.openid)
  const days = Number(e.days) || 365
  const plan = str(e.plan) || 'annual'
  if (!openid) return { error: '需要 openid' }
  if (!Number.isFinite(days) || days <= 0) return { error: 'days 必须是正数' }
  return proxyToPayCallback({ adminOp: 'grantMember', openid, days, plan })
}

/** 立刻跑一次对账（幂等，可重复调）：主要用途是修镜像 / 补滞留的 granting 订单 */
async function reconcile() {
  return proxyToPayCallback({ adminOp: 'reconcile' })
}

/**
 * 清当日配额与防滥用计数（联调常用）。
 *
 * ⚠ 这是**放大成本**的动作：清掉之后同一天可以再免费生成 / 提问若干次。
 * 只该用在联调与人工补偿，别让它进任何自动化流程。
 */
async function resetQuota(e) {
  const openid = str(e.openid)
  if (!openid) return { error: '需要 openid' }
  const day = str(e.day) || todayKey()
  const removed = {}
  for (const [, table] of QUOTA_TABLES) {
    removed[table] = await dropRow(table, `${openid}#${day}`)
  }
  removed.ai_calls = await dropRow('ai_calls', `${openid}#${day}`)
  return { day, removed, note: '清掉的是当日计数；越权使用会放大上游成本，仅限联调 / 补偿' }
}

/**
 * 报告锁恢复。`acquire` 把 state 置成 building 作互斥锁，生成中断（云函数超时 / 端上退出）
 * 会留下一条**永远 building** 的脏行，此后该人物谁点都拿不到报告（端上会一直排队）。
 * 默认只清「锁龄超过 olderThanMinutes（默认 10 分钟）」的那些 —— 正在生成的锁不能碰。
 */
async function clearReportLock(e) {
  const personKey = str(e.personKey)
  if (!personKey) return { error: '需要 personKey' }
  const olderThanMinutes = Number(e.olderThanMinutes) || 10

  let row = null
  try {
    const res = await db.collection('report_cache').doc(personKey).get()
    row = res && res.data
  } catch (err) {
    row = null
  }
  if (!row) return { found: false, personKey, note: '没有这条缓存行' }
  if (row.state !== 'building') return { found: true, personKey, state: row.state, skipped: '不是 building，无需清锁' }

  const ageMs = row.generated_at ? Date.now() - Date.parse(row.generated_at) : Number.POSITIVE_INFINITY
  if (ageMs < olderThanMinutes * 60000) {
    return { found: true, personKey, state: row.state, skipped: `锁龄不足 ${olderThanMinutes} 分钟，可能正在生成，不动` }
  }

  await db.collection('report_cache').doc(personKey).update({ data: { state: 'ready', builder: null, parts: null } })
  return { found: true, personKey, state: 'ready', cleared: true, ageMinutes: Math.round(ageMs / 60000) }
}

const ACTIONS = { ping, findUser, getUser, grantMember, reconcile, resetQuota, clearReportLock }

exports.main = async (event) => {
  const blocked = callerGuard()
  if (blocked) return blocked

  const e = event || {}
  const action = str(e.action)
  const names = Object.keys(ACTIONS).join(' / ')
  if (!action) return { ok: false, error: `缺少 action（支持：${names}）` }

  const badToken = tokenGuard(e)
  if (badToken) return badToken

  const run = ACTIONS[action]
  if (!run) return { ok: false, error: `未知 action：${action}（支持：${names}）` }

  try {
    return Object.assign({ ok: true, action }, await run(e))
  } catch (err) {
    return { ok: false, action, error: msgOf(err) }
  }
}
