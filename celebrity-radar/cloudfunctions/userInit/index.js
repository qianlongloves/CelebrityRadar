/**
 * userInit —— 用户账号与个性化配置的**唯一写者**（云调用，非 HTTP 触发）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 *
 * 改造前，`users` 行由**端上**在首登时直接 insert（`utils/auth.ts#doLogin`），
 * 插的是 `settings: {}`。三笔账都算在「初始化放在端上」这件事上：
 *
 *   1. **默认值成了端上的事**：换端（H5 / 新版本）默认值就漂了，云端读同一行
 *      看到的是 `{}`，谁也说不清缺的键该是什么 —— 这就是「两个真源」。
 *   2. **并发双插**：端上只能靠「先读、没有再插」，而 `users` 无唯一键可约束
 *      （端上那份 `inFlight` 只在单端去重）。两端同时首登会插出两行，
 *      之后 `readSelf()` 命中哪一条是不确定的。
 *   3. **缺字段补齐无处可做**：存量用户的 `settings: {}` 永远是空的，
 *      除非有人专门写迁移脚本。
 *
 * 现在初始化、补齐、改配置三件事都收敛到本函数（云函数是管理员身份，
 * 不受「仅创建者可读写」约束，却能按 `getWXContext().OPENID` 精确命中本人那一行）。
 * 端上不再写 `users` 的这两个字段，只读（`utils/auth.ts#readSelf`）。
 *
 * ── action ───────────────────────────────────────────────────────────
 *   'ensure'（默认）幂等初始化：无行则建（带完整默认配置 + 版本号）；
 *                    有行则**只补缺失的键**（已有值一律保留），并按版本号迁移。
 *                    端上每次登录后调一次，失败不阻塞（离线仍可用本地缓存）。
 *   'set'            改一个配置项：`{ action:'set', key, value }`。
 *                    只接受 `user-defaults.config.js` 白名单里的键，类型必须与默认值一致。
 *   'deleteAccount'  注销账号：删除本人**全部个人信息**（关注 / 收藏 / 历史 / 监控 / 订阅 / 用量 /
 *                    舆情状态 / 埋点 / 会员镜像），订单按《电子商务法》留存要求**去标识化保留**。
 *                    不可逆，端上须二次确认后才调（见 pages/mine 的「注销账号」）。
 *
 * ── 权限与信任边界 ───────────────────────────────────────────────────
 *   · 身份只认 `getWXContext().OPENID`，**不信任端上传来的任何 openid**（端上也没传）。
 *   · 本函数写的 `settings` 是**纯偏好**：云端（aiProxy / quotaGuard）不得读它做
 *     权限 / 额度判定 —— 那等于把判定交给客户端自证（users 是「仅创建者可读写」）。
 *     这条约束写在 `schema.js` 的 users.fields 里，并由 test/cases/18-user-config.js 钉住。
 *   · 不碰 `membership`（那是 `payCallback` 的地盘）与三个订阅授权位
 *     （`subscribe_ok` / `alert_ok` / `risk_ok`，由各自推送函数复位）。
 *
 * ⚠ 改完必须部署本云函数才生效；若还改了 `src/config/user-defaults.ts`，
 *   先 `npm run config:sync` 再部署。
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { DEFAULT_USER_SETTINGS, SETTINGS_KEYS, SETTINGS_VERSION } = require('./user-defaults.config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const SETTINGS_KEY_SET = new Set(SETTINGS_KEYS)

/**
 * 单次最多取多少行（只为「重复行」判断，正常永远是 1 行）。
 * 取 20 而不是 100：真出现重复行时说明端上那条老路径又插了行，
 * 这时候需要的是日志与人工确认，不是在云函数里静默吞掉一屏。
 */
const ROW_SCAN_MAX = 20

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 配置值类型校验：null 一律允许（表示「清除该偏好」，回落默认），
 * 其余必须与真源默认值同类。
 *
 * ⚠ 默认值是 `null` 时**不能**直接 `typeof def` —— `typeof null === 'object'`，
 * 会把「期望 object」当成判据，于是连 `'reason'` 这样的合法字符串都被拒。
 * 这种配置项指的是「类型未定」（合法取值由使用点决定，如档位），
 * 此时只收**原始值**（字符串 / 数字 / 布尔），挡掉对象与数组 ——
 * 否则 settings 就成了任意结构的容器（端上往里塞多大都行）。
 *
 * 为什么不做更严的枚举校验：合法值的裁决权在**使用点**
 * （`utils/llm.ts` 会忽略清单里已不存在的供应商 id）——
 * 在这里再维护一份枚举，等于给「加一个供应商」多加一处要同步的地方。
 */
function valueOk(key, value) {
  if (value === null) return true
  const def = DEFAULT_USER_SETTINGS[key]
  if (def === null) {
    const t = typeof value
    return t === 'string' || t === 'number' || t === 'boolean'
  }
  return typeof value === typeof def
}

/** 报错文案里的人类可读类型名（同样为了绕开 `typeof null === 'object'` 说反话） */
function expectedTypeName(key) {
  const def = DEFAULT_USER_SETTINGS[key]
  if (def === null) return '字符串 / 数字 / 布尔'
  return typeof def
}

/** 本人名下的 users 行（云函数是管理员身份，必须显式按 _openid 过滤） */
async function findRows(openid) {
  const res = await db.collection('users').where({ _openid: openid }).limit(ROW_SCAN_MAX).get()
  return (res && res.data) || []
}

/**
 * 缺键补齐：`defaults + 现有值`（现有值优先），并保留非白名单键。
 *
 * 三条取舍都在这里：
 *   · **现有值优先** —— ensure 会被反复调用，补齐不是重置，用户选过的不能被默认值盖掉；
 *   · **非白名单键保留** —— 历史 / 其它写入方留下的键不删（这是个纯偏好列，
 *     删别人的数据不是本函数的职责；真要清理由 dbInit 的 deprecated 走）；
 *   · 返回 `patched` 而不是直接比较对象 —— 调用方要用它决定「要不要写库」，
 *     不写就是零成本（ensure 在稳态下不该产生任何写）。
 */
function mergeDefaults(settings) {
  const cur = isPlainObject(settings) ? settings : {}
  const out = {}
  let patched = false
  for (const key of SETTINGS_KEYS) {
    if (key in cur) {
      out[key] = cur[key]
    } else {
      out[key] = DEFAULT_USER_SETTINGS[key]
      patched = true
    }
  }
  for (const k of Object.keys(cur)) if (!(k in out)) out[k] = cur[k]
  return { out, patched }
}

/** 按 created_at 升序（缺失的排最前）：重复行时取最早的那一行当权威 */
function byCreatedAt(a, b) {
  return String(a.created_at || '').localeCompare(String(b.created_at || ''))
}

/**
 * 幂等初始化 / 补齐。返回 `{ created, patched, duplicates, row }`。
 *
 * 只补 `settings` 与 `settings_version` 两列 —— 其余字段（授权位、membership）
 * 各有主人，本函数不越界（它们缺失时的语义就是默认值，见 schema.js 的 def）。
 */
async function ensure(openid) {
  const rows = await findRows(openid)
  const now = new Date().toISOString()

  if (rows.length === 0) {
    /*
     * ⚠ `_openid` 必须显式写：客户端 SDK 的 add 会由云端隐式注入，云函数不会。
     * 这里写的值来自 getWXContext()，正是权威来源（schema.js 把它标为 system，
     * 说的是「dbInit 永不回填」，不是说没人写得对）。
     */
    const doc = {
      _openid: openid,
      nickname: null,
      avatar_url: null,
      settings: Object.assign({}, DEFAULT_USER_SETTINGS),
      settings_version: SETTINGS_VERSION,
      created_at: now,
      last_seen_at: now
    }
    const added = await db.collection('users').add({ data: doc })
    return { created: true, patched: [], duplicates: 0, row: Object.assign({ _id: added._id }, doc) }
  }

  /*
   * 重复行（历史端上竞态的产物）：取最早的一行当权威，**不删**其余行。
   * 删用户的 users 行是不可逆操作，而重复行本身不影响功能（读口都按 _openid 过滤，
   * 端上 readSelf 也是取一行）—— 留个数字让运维看见就够了。
   */
  const sorted = rows.slice().sort(byCreatedAt)
  const row = sorted[0]
  const duplicates = rows.length - 1

  const patch = {}
  const { out, patched } = mergeDefaults(row.settings)
  if (patched) patch.settings = out
  if (typeof row.settings_version !== 'number' || row.settings_version < SETTINGS_VERSION) {
    patch.settings_version = SETTINGS_VERSION
  }

  if (Object.keys(patch).length > 0) {
    await db.collection('users').doc(row._id).update({ data: patch })
  }
  return {
    created: false,
    patched: Object.keys(patch),
    duplicates,
    row: Object.assign({}, row, patch)
  }
}

/**
 * 改一个配置项（这是端上唯一的配置写口背后那一步）。
 *
 * 用**点路径** `settings.<key>` 更新，而不是把整个 settings 对象写回去：
 * 读-改-写会丢并发改动（同一账号在两台设备上各改一项，后写的把前一项抹回旧值）。
 * 点路径只动这一条，其余键由云端原子保留。
 */
async function setSetting(openid, key, value) {
  if (typeof key !== 'string' || !SETTINGS_KEY_SET.has(key)) {
    return { ok: false, error: `不认识的配置项：${String(key)}（只允许 ${SETTINGS_KEYS.join(' / ')}）` }
  }
  if (!valueOk(key, value)) {
    return { ok: false, error: `配置项 ${key} 的类型不对（期望 ${expectedTypeName(key)}，或 null 表示清除）` }
  }

  const res = await ensure(openid)
  const row = res.row
  await db
    .collection('users')
    .doc(row._id)
    .update({ data: { [`settings.${key}`]: value } })

  const settings = Object.assign({}, isPlainObject(row.settings) ? row.settings : {}, { [key]: value })
  return { ok: true, key, value, settings, created: res.created }
}

/**
 * 注销账号：删除本人全部个人信息（不可逆）。
 *
 * ── 删什么、留什么 ──────────────────────────────────────────────────
 *   · 删：users（账号与配置）、memberships（会员镜像的权威）、follows / favorites /
 *         history / keyword_watches（关注 / 收藏 / 历史 / 监控）、opinion_event_status
 *         （舆情已读与跟进）、四张用量表（generate / ask / refresh_quota、ai_calls）、
 *         events（埋点）。
 *   · 留：orders（订单与退款）。依《电子商务法》等要求，交易记录须留存（不少于三年）；
 *         对账也依赖它。为兼顾「删除权」与「留存义务」，这里把订单**去标识化**——
 *         把 `_openid` 换成不可逆散列（`anon:<sha256 前 16 位>`）并记 `account_deleted_at`，
 *         即与自然人**解除关联**后保留。
 *   · 共享数据（report_cache / feed_cache / hot_board / keywords / opinion_events /
 *     risk_* / person_assets）与个人无关，一律不动。
 *
 * ── 幂等与容错 ──────────────────────────────────────────────────────
 *   逐表删除并各自 try/catch：某张表失败只记进 `failed`，不影响其余表 ——
 *   注销不该因为一张用量表删不掉就整体中止（那样用户反而更删不干净）。
 *   重复调用安全：删 0 行也算成功。
 */
const PURGE_BY_OPENID = ['follows', 'favorites', 'history', 'keyword_watches', 'events']
const PURGE_BY__OPENID = ['generate_quota', 'ask_quota', 'refresh_quota', 'ai_calls', 'users']
const PURGE_BY_ID = ['memberships', 'opinion_event_status']

/** 订单去标识化后的 `_openid`：不可逆散列，与自然人解除关联，仅用于「同一单只保留一次」的记账 */
function anonId(openid) {
  return 'anon:' + crypto.createHash('sha256').update(String(openid)).digest('hex').slice(0, 16)
}

async function deleteAccount(openid) {
  const now = new Date().toISOString()
  const removed = {}
  const failed = []

  for (const name of PURGE_BY_OPENID) {
    try {
      const res = await db.collection(name).where({ openid }).remove()
      removed[name] = (res && res.stats && res.stats.removed) || 0
    } catch (err) {
      failed.push(`${name}: ${(err && (err.errMsg || err.message)) || String(err)}`)
    }
  }
  for (const name of PURGE_BY__OPENID) {
    try {
      const res = await db.collection(name).where({ _openid: openid }).remove()
      removed[name] = (res && res.stats && res.stats.removed) || 0
    } catch (err) {
      failed.push(`${name}: ${(err && (err.errMsg || err.message)) || String(err)}`)
    }
  }
  for (const name of PURGE_BY_ID) {
    try {
      const res = await db.collection(name).where({ _id: openid }).remove()
      removed[name] = (res && res.stats && res.stats.removed) || 0
    } catch (err) {
      failed.push(`${name}: ${(err && (err.errMsg || err.message)) || String(err)}`)
    }
  }

  /* 订单：去标识化保留（失败不阻断注销，只如实回报） */
  let ordersAnonymized = 0
  let ordersError = null
  try {
    const res = await db
      .collection('orders')
      .where({ _openid: openid })
      .update({ data: { _openid: anonId(openid), account_deleted_at: now } })
    ordersAnonymized = (res && res.stats && res.stats.updated) || 0
  } catch (err) {
    ordersError = (err && (err.errMsg || err.message)) || String(err)
  }

  return {
    ok: failed.length === 0,
    action: 'deleteAccount',
    deleted: removed,
    ordersAnonymized,
    ordersError,
    failed,
    at: now
  }
}

/**
 * 入口。
 *
 * 永远返回 `{ ok: ... }` 形态而不抛错：调用方是端上登录路径，
 * 它需要区分「云端没部署 / 出错了，走本地兜底」与「真的写进去了」，
 * 一句裸异常没有这个信息量。
 */
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) {
    return { ok: false, error: '缺少用户身份（OPENID）：本函数只能由小程序端调用' }
  }

  const action = (event && event.action) || 'ensure'
  try {
    if (action === 'ensure') {
      const r = await ensure(OPENID)
      return Object.assign({ ok: true, action }, r)
    }
    if (action === 'set') {
      const r = await setSetting(OPENID, event.key, event.value)
      return Object.assign({ action }, r)
    }
    if (action === 'deleteAccount') {
      return await deleteAccount(OPENID)
    }
    return { ok: false, error: `未知 action：${String(action)}（只允许 ensure / set / deleteAccount）` }
  } catch (err) {
    return { ok: false, error: (err && (err.errMsg || err.message)) || String(err) }
  }
}
