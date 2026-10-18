/**
 * adminConsole —— 超管运维台的服务端（2026-10-18）
 *
 * 与 adminOps 的分工（两者刻意不合并）：
 *   · `adminOps` 是**控制台 / CLI** 专用：口令 `ADMIN_OPS_TOKEN`，且 `callerGuard` 明确拒绝
 *     带 OPENID 的调用（端上一律进不来）。它做的是「排障 + 写库级修复」；
 *   · `adminConsole` 是**端上小程序页面**专用：调用者一定带 OPENID，鉴权靠**openid 白名单**
 *     `ADMIN_OPENIDS`，且要求每个动作都能在手机上点。
 *
 * 为什么不干脆让 adminOps 也接受端上调用：那等于把「口令」与「身份」两套闸门搅在一起 ——
 * 端上有 openid 但不该有口令，控制台有口令但没有 openid，混用会让任何一侧的疏漏变成另一侧的突破口。
 *
 * ⚠ 三条铁律（改这个文件前先读）：
 *   1. **fail closed**：`ADMIN_OPENIDS` 没配 ⇒ 除 `me` 外全部拒绝。`me` 是唯一的例外，
 *      因为它必须让运维先拿到自己的 openid 才能配白名单（自举），且它只回自己的 openid。
 *   2. **会员数据只有一个写口**：本函数绝不直接写 `memberships` / `users.membership`，
 *      一律代理 payCallback（`PAY_ADMIN_TOKEN`）。理由见 payCallback/index.js 文件头。
 *   3. **模型厂商不能全停**：至少保留一家，否则全站生成 / 问答立刻全线失败 ——
 *      防欠费的开关本身不能变成新的全站故障。
 *
 * 环境变量：`ADMIN_OPENIDS`（逗号分隔）、`PAY_ADMIN_TOKEN`（代理会员写口用，与 payCallback 同值）。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 一页最多 50 人：手机上再长也翻不完，且每页要多查一次 memberships（批量 in） */
const USER_PAGE_MAX = 50
const QUOTA_TABLES = [
  ['generate', 'generate_quota'],
  ['ask', 'ask_quota'],
  ['refresh', 'refresh_quota']
]
/** 运营开关固定两个文档：llm_vendors（模型厂商停用清单） */
const FLAG_COLL = 'sys_config'
const FLAG_ID = 'llm_vendors'

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim())
const msgOf = (err) => str((err && (err.errMsg || err.message)) || err) || '未知错误'
const nowIso = () => new Date().toISOString()
const openidOf = () => str((cloud.getWXContext() || {}).OPENID)
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 当日 key 用东八区：端上 / 云端所有「今天」口径都是这个时区（与 quotaGuard 一致） */
function todayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 超管名单。逗号 / 分号 / 空白都算分隔符。
 * 长度下限 16：微信 openid 约 28 位，短串多半是把 AppID / 昵称误填进来的，宁可当作没配。
 */
function adminOpenids() {
  return str(process.env.ADMIN_OPENIDS)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 16)
}

async function findUserRow(openid) {
  const res = await db.collection('users').where({ _id: openid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

async function readMembership(openid) {
  const res = await db.collection('memberships').where({ _id: openid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

async function readCount(collection, id) {
  try {
    const res = await db.collection(collection).where({ _id: id }).count()
    return res.total || 0
  } catch (err) {
    /* 集合可能还没建（新环境）：计 0 而不是让整个详情页失败 */
    return 0
  }
}

/**
 * 我是谁：端上据此决定「运维中心」入口显不显示。
 *
 * 这是**唯一不需要已在白名单**的动作：否则第一次部署时没有任何人能进去配置。
 * 它只回调用者自己的 openid 与一句提示，不泄露名单内容（不回 adminCount 之外的信息）。
 */
async function me() {
  const openid = openidOf()
  const list = adminOpenids()
  const isAdmin = !!openid && list.indexOf(openid) >= 0
  return {
    openid,
    isAdmin,
    adminCount: list.length,
    hint: isAdmin
      ? ''
      : list.length === 0
        ? '尚未配置超管：把下面这个 openid 写进云函数 adminConsole 的环境变量 ADMIN_OPENIDS（逗号分隔），重新部署后生效'
        : '你的 openid 不在 ADMIN_OPENIDS 白名单里'
  }
}

/**
 * 用户列表 / 搜索。
 *
 * 搜索口径两条，按输入形态自动判定：
 *   · 形如 openid（字母数字 + `-`/`_`，20 位以上）⇒ **精确**匹配 `_id`；
 *   · 其余 ⇒ 昵称**模糊**匹配（不区分大小写），最多 50 条。
 * 为什么不做「昵称 + openid 同时 OR」：云数据库的 or 查询要走两次读，而运维心里的模型很清楚 ——
 * 「我知道他是谁（昵称）」或「我知道他的号（openid）」，不会一半一半。
 *
 * 会员态**批量取**（`_.in` 一次查完本页所有人）：逐行查 memberships 会让一页变成 20 次多余读。
 */
async function listUsers(e) {
  const kw = str(e.keyword)
  const page = Math.max(0, Math.floor(Number(e.page) || 0))
  const size = Math.min(USER_PAGE_MAX, Math.max(1, Math.floor(Number(e.pageSize) || 20)))

  const build = () => {
    const q = db.collection('users')
    if (!kw) return q
    return /^[A-Za-z0-9_-]{20,}$/.test(kw)
      ? q.where({ _id: kw })
      : q.where({ nickname: db.RegExp({ regexp: escapeRegExp(kw), options: 'i' }) })
  }

  const totalRes = await build().count()
  const res = await build().orderBy('created_at', 'desc').skip(page * size).limit(size).get()
  const rows = res.data || []

  const ids = rows.map((r) => r._openid).filter(Boolean)
  const authMap = {}
  if (ids.length) {
    const mres = await db
      .collection('memberships')
      .where({ _id: _.in(ids) })
      .limit(USER_PAGE_MAX)
      .get()
    for (const m of mres.data || []) authMap[m._id] = m
  }

  const now = Date.now()
  return {
    keyword: kw,
    total: totalRes.total || 0,
    page,
    pageSize: size,
    users: rows.map((r) => {
      const auth = authMap[r._openid] || null
      const mirror = r.membership || null
      const authTs = Date.parse((auth && auth.expires_at) || '') || 0
      const mirrorTs = Date.parse((mirror && mirror.expires_at) || '') || 0
      return {
        openid: r._openid,
        nickname: r.nickname || '',
        created_at: r.created_at || '',
        last_seen_at: r.last_seen_at || null,
        plan: (auth && auth.plan) || (mirror && mirror.plan) || '',
        expires_at: (auth && auth.expires_at) || (mirror && mirror.expires_at) || null,
        isMember: authTs > now,
        /* 权威与镜像的有效期不一致 ⇒ 界面与权限可能对不上（管理员最常查的就是这一类） */
        mismatched: !!auth && !!mirror && (auth.expires_at || '') !== (mirror.expires_at || ''),
        /* 最近一次**人工**改会员的痕迹：用户问「我的会员怎么没了」时先看这里 */
        lastAdminOp: (auth && auth.last_admin_op) || null,
        mirrorActive: mirrorTs > now
      }
    })
  }
}

/**
 * 单个用户全景（点进列表某一行时调）。
 * 除了基础资料，最有价值的是两种「界面与权限对不上」的判定 —— 与 adminOps#getUser 同口径。
 */
async function getUser(e) {
  const openid = str(e.openid)
  if (!openid) return { error: '需要 openid' }
  const day = str(e.day) || todayKey()

  const row = await findUserRow(openid)
  const auth = await readMembership(openid)

  const quotasToday = {}
  for (const [label, table] of QUOTA_TABLES) quotasToday[label] = await readCount(table, `${openid}#${day}`)

  const now = Date.now()
  const authActive = !!auth && Date.parse(auth.expires_at) > now
  const mirror = (row && row.membership) || null
  const mirrorActive = !!mirror && Date.parse(mirror.expires_at) > now

  return {
    day,
    found: !!row,
    user: row
      ? {
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
          last_admin_op: auth.last_admin_op || null,
          mirror_checked_at: auth.mirror_checked_at
        }
      : null,
    mirror,
    isMember: authActive,
    mirrorMatchesAuthority: !!auth && !!mirror && mirror.expires_at === auth.expires_at,
    conclusion: !authActive && !mirrorActive
      ? '权威与镜像一致：都不是会员'
      : authActive && mirrorActive
        ? '权威与镜像一致：都是会员'
        : authActive
          ? '⚠ 云端已按会员放行，界面仍显示免费（镜像没跟上）—— 对账可修'
          : '⚠ 界面显示会员，云端判非会员（以权威为准）—— 检查 memberships 权威行',
    quotasToday,
    abuseCallsToday: await readCount('ai_calls', `${openid}#${day}`)
  }
}

/**
 * 代理到 payCallback 的运营写口 —— 会员数据的**唯一**写口。
 * 本函数只负责「我是谁」（`by`）与转发，不碰任何会员字段。
 */
async function proxyToPayCallback(payload) {
  const token = str(process.env.PAY_ADMIN_TOKEN)
  if (!token) {
    return {
      proxyError:
        '未配置 PAY_ADMIN_TOKEN：改会员不可用（请在 adminConsole 的环境变量里补上，与 payCallback 同值）'
    }
  }
  const res = await cloud.callFunction({
    name: 'payCallback',
    data: Object.assign({ token }, payload, { by: openidOf() })
  })
  return { result: (res && res.result) || null }
}

/** 发放 / 续期会员：参数与 payCallback 的 adminOp=grantMember 完全一致 */
async function grantMember(e) {
  const openid = str(e.openid)
  const days = Math.floor(Number(e.days))
  if (!openid) return { error: '需要 openid' }
  if (!(days > 0)) return { error: 'days 必须是正整数' }
  return proxyToPayCallback({ adminOp: 'grantMember', openid, days, plan: str(e.plan) || 'annual' })
}

/** 撤销会员：把有效期收到此刻（不删行，见 payCallback#adminRevokeMember 的说明） */
async function revokeMember(e) {
  const openid = str(e.openid)
  if (!openid) return { error: '需要 openid' }
  return proxyToPayCallback({ adminOp: 'revokeMember', openid, reason: str(e.reason) })
}

/** 厂商目录 + 停用清单（一次拿全，端上开关据此渲染） */
async function vendorSnapshot() {
  const res = await cloud.callFunction({ name: 'aiProxy', data: { action: 'vendors' } })
  const r = (res && res.result) || {}
  if (!r.ok || !Array.isArray(r.vendors)) throw new Error(str(r.error) || '读取厂商目录失败')
  let flag = null
  try {
    const s = await db.collection(FLAG_COLL).doc(FLAG_ID).get()
    flag = (s && s.data) || null
  } catch (err) {
    /* 还没有开关文档 = 全部启用（第一次进运维中心时就是这样，不是错误） */
    flag = null
  }
  return { vendors: r.vendors, flag }
}

async function vendors() {
  const snap = await vendorSnapshot()
  const flag = snap.flag || {}
  return {
    vendors: snap.vendors,
    disabled: Array.isArray(flag.disabled) ? flag.disabled : [],
    updated_at: flag.updated_at || null,
    updated_by: flag.updated_by || null,
    note: flag.note || null
  }
}

/**
 * 启用 / 停用某家厂商。
 *
 * `enabled` 默认 true（不传 = 恢复）。停用只是把这个名字写进 `disabled` 数组，
 * 注册表与 key 一个都不动 —— 恢复时把名字删掉即可，不需要重新部署。
 *
 * ⚠ 不允许停用到一家不剩：那会让报告生成与 AI 问答**立刻全站失败**。
 * 这个保护放在服务端而不是端上 —— 端上的按钮状态可以被绕过，服务端的约束才是真的。
 */
async function setVendor(e) {
  const key = str(e.key)
  const enabled = e.enabled !== false
  if (!key) return { error: '需要 key' }

  const snap = await vendorSnapshot()
  const keys = snap.vendors.map((v) => v.key)
  if (keys.indexOf(key) < 0) return { error: `未注册的厂商：${key}（可选：${keys.join(' / ')}）` }

  const cur = (Array.isArray(snap.flag && snap.flag.disabled) ? snap.flag.disabled : []).filter(
    (k) => keys.indexOf(k) >= 0
  )
  const next = cur.filter((k) => k !== key)
  if (!enabled) next.push(key)
  if (next.length >= keys.length) {
    return { error: '不能停用全部厂商：至少保留一家可用，否则全站生成与问答会立刻失败' }
  }

  const doc = {
    disabled: next,
    updated_at: nowIso(),
    /* 只留 openid 后 6 位：够回答「是谁改的」，又不把超管身份写进一张业务表 */
    updated_by: openidOf().slice(-6),
    note: str(e.note) || null
  }
  await db.collection(FLAG_COLL).doc(FLAG_ID).set({ data: doc })

  console.log(`[adminConsole] 厂商开关：${key} => ${enabled ? '启用' : '停用'}，当前停用 ${next.join(',') || '无'}`)
  return { key, enabled, disabled: next, updated_at: doc.updated_at, updated_by: doc.updated_by }
}

const ACTIONS = { listUsers, getUser, grantMember, revokeMember, vendors, setVendor }

exports.main = async (event) => {
  const e = event || {}
  const action = str(e.action)
  const caller = openidOf()

  /* 端上专用：没有 OPENID 说明是控制台 / 服务端在调，请改用 adminOps（那一侧有口令闸门） */
  if (!caller) {
    return { ok: false, error: '拒绝：adminConsole 只接受小程序端调用（控制台排障请用 adminOps）' }
  }

  /* me 是唯一的自举入口：必须让运维先拿到自己的 openid 才能配白名单 */
  if (action === 'me') {
    try {
      return Object.assign({ ok: true, action }, await me())
    } catch (err) {
      return { ok: false, action, error: msgOf(err) }
    }
  }

  const list = adminOpenids()
  if (!list.length) {
    return {
      ok: false,
      action,
      error: '拒绝：未配置环境变量 ADMIN_OPENIDS（超管名单未配置时一律拒绝）。先调 action=me 拿到自己的 openid'
    }
  }
  if (list.indexOf(caller) < 0) {
    return { ok: false, action, error: '拒绝：调用者不在超管名单（ADMIN_OPENIDS）里' }
  }

  const run = ACTIONS[action]
  if (!run) {
    return {
      ok: false,
      action,
      error: `未知 action：${action}（支持：me / ${Object.keys(ACTIONS).join(' / ')}）`
    }
  }
  try {
    return Object.assign({ ok: true, action }, await run(e))
  } catch (err) {
    return { ok: false, action, error: msgOf(err) }
  }
}
