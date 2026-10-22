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
/* 价格默认值 + 可调边界：生成副本，真源 src/config/benefits.ts */
const { PLANS, PLAN_LIMITS } = require('./benefits.config')

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
/**
 * sys_config 下的运营开关文档（一张表收所有「不发版就能改」的开关）：
 *   llm_vendors       模型厂商停用清单
 *   membership_plans  会员价格覆盖（改价，见 plans / setPlans）
 */
const FLAG_COLL = 'sys_config'
const FLAG_ID = 'llm_vendors'
const PLAN_ID = 'membership_plans'

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

/**
 * 按 openid 找 users 行。
 *
 * ⚠ 判据是 **`_openid`，不是 `_id`**（2026-10-18 修）：users 行由云函数 `userInit` 用
 * `add()` 写入，`_id` 是数据库自动生成的随机串，`_openid` 才是那个人的 openid
 * （schema 里 `_openid` 标 system，而 `_id` 也是 system，两者极易看混）。
 * 写成 `where({_id: openid})` 的后果不是报错而是**恒查不到** —— 详情页永远显示
 * 「用户不存在」，而列表页（走 `_openid`）显示得好好的，于是运维会以为「这个人没登录过」。
 * 同项目里 `adminOps` / `payCallback` 的同类查询一律用 `_openid`，这里是唯一的例外。
 */
async function findUserRow(openid) {
  const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
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
    /* 待核实的退款申请数（2026-10-22）：运维中心据此在「退款」tab 上挂红点，
       并在有待办时直接切过去。**只有超管才查** —— 非超管拿到这个数既没法处理，
       也等于把「平台有多少笔退款在排队」告诉了一个不相干的人。 */
    pendingRefunds: isAdmin ? await pendingRefundCount() : 0,
    hint: isAdmin
      ? ''
      : list.length === 0
        ? '尚未配置超管：把下面这个 openid 写进云函数 adminConsole 的环境变量 ADMIN_OPENIDS（逗号分隔），重新部署后生效'
        : '你的 openid 不在 ADMIN_OPENIDS 白名单里'
  }
}

/** 退款待办数。集合还没建（dbInit 尚未 sync）时按 0 处理，不能让运维中心因此打不开 */
async function pendingRefundCount() {
  try {
    const res = await db.collection('refund_requests').where({ status: 'pending' }).count()
    return Number(res.total) || 0
  } catch (err) {
    return 0
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
 *
 * ⚠ 必须**读懂 payCallback 的回执**（2026-10-18 修）：它拒绝时有两种形状 ——
 * 运营写口的 `{ ok:false, error }`，以及被调用方闸门挡下时的 `{ errcode:-1, errmsg }`。
 * 以前这里只看「拿到了一个对象」就当成功，于是任何一种拒绝都被包成 `ok:true` 回给端上：
 * 运维点「+30 天」，页面弹出「已加 30 天」，库里一行没变。**静默失败比报错难查十倍**。
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
  const result = (res && res.result) || null
  if (!result || typeof result !== 'object') {
    return { proxyError: 'payCallback 没有返回结果（可能尚未部署，或调用超时）' }
  }
  if (result.ok === true) return { result }
  const why = str(result.error) || str(result.errmsg)
  return {
    proxyError: why
      ? `payCallback 拒绝了这次操作：${why}`
      : `payCallback 拒绝了这次操作（errcode=${result.errcode == null ? '?' : result.errcode}）`
  }
}

/**
 * 把 payCallback 的回执摊平成本函数的返回值。
 * 端上只需要「改完之后的到期日」，不该知道中间多了一跳代理；而失败必须走 `{error}`，
 * 由 `exports.main` 统一翻成 `ok:false`（否则又会变成一次静默成功）。
 */
function unwrapProxy(r) {
  if (r.proxyError) return { error: r.proxyError }
  const out = r.result || {}
  if (out.ok !== true) return { error: str(out.error) || str(out.errmsg) || 'payCallback 拒绝了这次操作' }
  return out
}

/** 发放 / 续期会员：参数与 payCallback 的 adminOp=grantMember 完全一致 */
async function grantMember(e) {
  const openid = str(e.openid)
  const days = Math.floor(Number(e.days))
  if (!openid) return { error: '需要 openid' }
  if (!(days > 0)) return { error: 'days 必须是正整数' }
  const out = unwrapProxy(
    await proxyToPayCallback({ adminOp: 'grantMember', openid, days, plan: str(e.plan) || 'annual' })
  )
  if (out.error) return out
  return {
    openid: str(out.openid) || openid,
    plan: str(out.plan) || str(e.plan) || 'annual',
    days: Number(out.days) || days,
    expires_at: out.expires_at || null
  }
}

/** 撤销会员：把有效期收到此刻（不删行，见 payCallback#adminRevokeMember 的说明） */
async function revokeMember(e) {
  const openid = str(e.openid)
  if (!openid) return { error: '需要 openid' }
  const out = unwrapProxy(await proxyToPayCallback({ adminOp: 'revokeMember', openid, reason: str(e.reason) }))
  if (out.error) return out
  return { openid: str(out.openid) || openid, revoked: out.revoked === true, expires_at: out.expires_at || null }
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

/* ═══════════════════════════════════════════════════════════════════════════
 * 会员价格（2026-10-22）
 *
 * 价格原先只活在 `benefits.config.js` 里：调一次价要改真源、跑 config:sync、重新部署云函数。
 * 现在改为**云端覆盖** —— 运维中心改金额，payCreate 一分钟内按新价下单，端上不用发版。
 *
 * ⚠ 边界必须落在这里（服务端），端上的输入校验只是体验：
 *   · 金额上下限、整数分 —— 多打一个 0 是客诉，少打一个 0 是无声资损；
 *   · 三档必须一次提交 —— 漏传一档会让它静默回到默认价，运维以为改成功；
 *   · 只改金额与角标 —— days / name / body 不动（改天数会动发货口径）。
 * 与 payCreate#sanitizePlanOverride 是同一条判据的两份实现（云函数各自独立打包），
 * 边界值取自 PLAN_LIMITS，改范围只改真源。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 金额（分）→ 展示文案：990 → `¥9.9`、6800 → `¥68`。与 payCreate#priceLabelOf 必须同口径 */
function priceLabelOf(fen) {
  const yuan = Math.round(fen) / 100
  if (Number.isInteger(yuan)) return `¥${yuan}`
  return `¥${String(yuan.toFixed(2)).replace(/0+$/, '').replace(/\.$/, '')}`
}

/**
 * 读价格文档。**刻意不缓存**：运维页要看的就是「库里现在是什么」，
 * 缓存会让刚保存完的页面显示旧值，看起来像没保存成功。
 */
async function readPlanDoc() {
  try {
    const res = await db.collection(FLAG_COLL).doc(PLAN_ID).get()
    return (res && res.data) || null
  } catch (err) {
    /* 没配过价 = 全用构建期默认值，不是错误 */
    return null
  }
}

/** 价格现状：每档的「云端当前值」与「构建期默认值」并排给出，`source` 说明是否已被覆盖 */
async function plans() {
  const doc = await readPlanDoc()
  const prices = doc && doc.prices && typeof doc.prices === 'object' ? doc.prices : {}
  const badges = doc && doc.badges && typeof doc.badges === 'object' ? doc.badges : {}
  return {
    source: doc ? 'cloud' : 'local',
    updated_at: doc && doc.updated_at ? doc.updated_at : null,
    updated_by: doc && doc.updated_by ? doc.updated_by : null,
    note: doc && doc.note ? doc.note : null,
    plans: PLANS.map((p) => {
      const cur = typeof prices[p.id] === 'number' ? prices[p.id] : p.priceFen
      return {
        id: p.id,
        name: p.name,
        days: p.days,
        priceFen: cur,
        priceLabel: priceLabelOf(cur),
        badge: typeof badges[p.id] === 'string' ? badges[p.id] : p.badge,
        defaultPriceFen: p.priceFen,
        defaultPriceLabel: priceLabelOf(p.priceFen),
        defaultBadge: p.badge
      }
    })
  }
}

/**
 * 改价：三档一次提交（数组），金额单位是**分**。
 *
 * 为什么强制三档全传：只改月卡时若只传 monthly，漏掉的两档会按「没配」落回默认价 ——
 * 运营看到的是一次「只改了月卡」，实际发生的是「另外两档被重置」。宁可让调用方多传两个值。
 */
async function setPlans(e) {
  const rows = Array.isArray(e.plans) ? e.plans : null
  if (!rows) return { error: '需要 plans 数组（三档一次提交）' }

  const byId = {}
  for (const row of rows) {
    const id = str(row && row.id)
    if (!id) return { error: '每个档位都需要 id' }
    if (byId[id]) return { error: `档位重复：${id}` }
    byId[id] = row
  }
  const expected = PLANS.map((p) => p.id)
  const missing = expected.filter((id) => !byId[id])
  if (missing.length) {
    return { error: `缺档位：${missing.join(' / ')}（三档必须一次提交，否则漏掉的档位会静默回到默认价）` }
  }
  const unknown = Object.keys(byId).filter((id) => expected.indexOf(id) < 0)
  if (unknown.length) return { error: `未注册的档位：${unknown.join(' / ')}（可选：${expected.join(' / ')}）` }

  const prices = {}
  const badges = {}
  for (const p of PLANS) {
    const row = byId[p.id]
    const fen = Number(row.priceFen)
    if (!Number.isFinite(fen)) return { error: `${p.id} 的价格不是数字` }
    if (Math.round(fen) !== fen) return { error: `${p.id} 的价格必须是整数分（元 × 100）` }
    if (fen < PLAN_LIMITS.priceFenMin || fen > PLAN_LIMITS.priceFenMax) {
      const lo = PLAN_LIMITS.priceFenMin / 100
      const hi = PLAN_LIMITS.priceFenMax / 100
      return { error: `${p.id} 的价格 ¥${fen / 100} 超出允许范围（¥${lo}~¥${hi}）` }
    }
    const badge = str(row.badge)
    if (badge.length > PLAN_LIMITS.badgeMax) {
      return { error: `${p.id} 的角标超过 ${PLAN_LIMITS.badgeMax} 字` }
    }
    prices[p.id] = fen
    badges[p.id] = badge
  }

  const before = await readPlanDoc()
  const doc = {
    prices,
    badges,
    updated_at: nowIso(),
    /* 与厂商开关同口径：只留 openid 后 6 位，够回答「是谁改的」 */
    updated_by: openidOf().slice(-6),
    note: str(e.note) || null
  }
  await db.collection(FLAG_COLL).doc(PLAN_ID).set({ data: doc })

  const diff = PLANS.map((p) => {
    const oldFen =
      before && before.prices && typeof before.prices[p.id] === 'number' ? before.prices[p.id] : p.priceFen
    return `${p.id} ${oldFen}→${prices[p.id]}`
  })
  console.log(`[adminConsole] 会员价格更新：${diff.join('，')}`)

  return {
    source: 'cloud',
    updated_at: doc.updated_at,
    updated_by: doc.updated_by,
    plans: PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      days: p.days,
      priceFen: prices[p.id],
      priceLabel: priceLabelOf(prices[p.id]),
      badge: badges[p.id],
      defaultPriceFen: p.priceFen,
      defaultPriceLabel: priceLabelOf(p.priceFen),
      defaultBadge: p.badge
    }))
  }
}

/* ─────────── 退款申请（2026-10-22）：用户发起 → 超管核实 → 点击退款 ─────────── */

const REFUND_PAGE_MAX = 30

/**
 * 退款申请列表。
 *
 * 默认只看 `pending`（待办），`status:'all'` 看全部处理结果 —— 两条口径分别对应
 * 「现在该我做什么」和「上周那笔是谁批的」，混在一个列表里两头都不好用。
 *
 * 注意这是**唯一能看到用户退款理由与内部处理备注的地方**：refund_requests 的 ACL 是
 * cloudOnly，端上一行都读不到（用户侧走 refundApply.my，只回自己的）。
 */
async function refundRequests(e) {
  const status = str(e.status) || 'pending'
  const page = Math.max(0, Math.floor(Number(e.page) || 0))
  const size = Math.min(REFUND_PAGE_MAX, Math.max(1, Math.floor(Number(e.pageSize) || 20)))
  const where = status === 'all' ? {} : { status }

  let total = 0
  try {
    const c = await db.collection('refund_requests').where(where).count()
    total = Number(c.total) || 0
  } catch (err) {
    /* 集合还不存在：明确告诉运维该做什么，而不是回一个空列表让他以为「没人申请」 */
    return {
      rows: [],
      total: 0,
      pending: 0,
      note: 'refund_requests 集合还不存在：先执行一次 dbInit 的 sync（apply:true）'
    }
  }

  const res = await db
    .collection('refund_requests')
    .where(where)
    .orderBy('created_at', 'desc')
    .skip(page * size)
    .limit(size)
    .get()

  return {
    rows: (res.data || []).map((r) => ({
      id: r._id,
      /* 用户只给后 8 位：运维核实时要对得上人，但列表不该把整串 openid 撒出来 */
      openidTail: str(r._openid).slice(-8),
      outTradeNo: r.out_trade_no,
      status: r.status,
      reason: r.reason,
      plan: str(r.plan),
      amountFen: Number(r.amount_fen) || 0,
      days: Number(r.days) || 0,
      paidAt: r.paid_at || null,
      createdAt: r.created_at,
      decidedAt: r.decided_at || null,
      decidedBy: r.decided_by || null,
      decisionNote: r.decision_note || null,
      refundFee: typeof r.refund_fee === 'number' ? r.refund_fee : null,
      refundId: r.refund_id || null
    })),
    total,
    pending: await pendingRefundCount(),
    page,
    pageSize: size
  }
}

/**
 * 处理一条退款申请：`approve` = 核实后点退款，`reject` = 拒绝（必须写理由）。
 *
 * 两个刻意的顺序：
 *   · **先退款成功、再置 approved**：反过来的话，payCallback 一拒绝，用户那边已经显示
 *     「已退款」而钱没动 —— 那是最坏的一种不一致。
 *   · **拒绝必须带理由**：用户会在订单页看到它。没有理由的拒绝，用户唯一能做的就是再申请一次。
 *
 * 真正的钱与订单状态都在 payCallback（adminOp:'refund'）：本函数只负责「申请单」这一侧，
 * 以及把退款单号 / 金额记回申请，让「一条申请 ↔ 一笔退款」能单独对上。
 */
async function refundDecide(e) {
  const id = str(e.id)
  const decision = str(e.decision)
  if (!id) return { error: '需要 id（申请记录的 _id）' }
  if (decision !== 'approve' && decision !== 'reject') {
    return { error: 'decision 只能是 approve（核实后退款）或 reject（拒绝）' }
  }

  let doc = null
  try {
    const r = await db.collection('refund_requests').doc(id).get()
    doc = (r && r.data) || null
  } catch (err) {
    doc = null
  }
  if (!doc) return { error: `找不到这条申请：${id}` }
  if (doc.status !== 'pending') {
    return { error: `这条申请已经处理过（${doc.status}），不能重复操作` }
  }

  const now = new Date().toISOString()
  const by = openidOf().slice(-6)
  const note = str(e.note).slice(0, 200)

  if (decision === 'reject') {
    if (!note) return { error: '拒绝必须填写理由（用户会在订单页看到）' }
    await db.collection('refund_requests').doc(id).update({
      data: { status: 'rejected', decided_at: now, decided_by: by, decision_note: note }
    })
    return { status: 'rejected', outTradeNo: doc.out_trade_no }
  }

  const amount = Number(doc.amount_fen) || 0
  const rawFee = e.fee === undefined || e.fee === null || e.fee === '' ? undefined : Math.round(Number(e.fee))
  if (rawFee !== undefined && (!Number.isFinite(rawFee) || rawFee <= 0 || rawFee > amount)) {
    return { error: `退款金额不合法：${e.fee}（订单 ${amount} 分，须为 1~${amount} 之间的整数分）` }
  }

  const out = unwrapProxy(
    await proxyToPayCallback({
      adminOp: 'refund',
      outTradeNo: doc.out_trade_no,
      reason: `用户申请：${doc.reason}`.slice(0, 200),
      fee: rawFee,
      refundId: str(e.refundId)
    })
  )
  if (out.error) return out

  const fee = rawFee === undefined ? amount : rawFee
  const refundId = str(e.refundId) || null
  await db.collection('refund_requests').doc(id).update({
    data: {
      status: 'approved',
      decided_at: now,
      decided_by: by,
      decision_note: note || null,
      refund_fee: fee,
      refund_id: refundId
    }
  })

  return {
    status: 'approved',
    outTradeNo: doc.out_trade_no,
    refundFee: fee,
    refundId,
    /* payCallback 会告诉我们对账是否已经把会员天数倒扣掉（refunded 单由对账撤销） */
    revoked: out.revoked === true
  }
}

const ACTIONS = {
  listUsers,
  getUser,
  grantMember,
  revokeMember,
  refundRequests,
  refundDecide,
  vendors,
  setVendor,
  plans,
  setPlans
}

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
    const out = await run(e)
    /*
     * 任何 action 都用 `{ error }` 表示失败（2026-10-18 修）。
     * 以前只有**抛错**才算失败，于是 `getUser` 缺 openid、`grantMember` 被 payCallback 拒绝
     * 这两个分支都回成了 `ok:true` + 一个没人看的 error 字段 —— 端上只判 ok，就变成了
     * 「提示成功、实际没改」。判定放在这里一次，比每个 action 各自记得返回 ok:false 可靠。
     */
    const bad = out && typeof out === 'object' ? str(out.error) : ''
    if (bad) return { ok: false, action, error: bad }
    return Object.assign({ ok: true, action }, out)
  } catch (err) {
    return { ok: false, action, error: msgOf(err) }
  }
}
