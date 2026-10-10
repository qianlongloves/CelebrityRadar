/**
 * userBackfill —— 一次性运维：把**存量** users 行的 settings 补齐到真源默认值。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 *
 * `userInit.ensure` 已经能做「缺键补齐」，但它**只在本人登录时**被调用
 * （端上 app.tsx 启动 → ensureLogin，见 utils/auth.ts#ensureUserRow）。
 * 于是总有一批行补不上：改造前首登、插的是 `settings: {}` 的老用户，
 * 此后再没登录过 —— 那一行就没人碰。本函数把「补齐」从「等他下次登录」
 * 变成「管理员主动跑一次全表」。
 *
 * ── 语义与 ensure **完全一致**（这不是巧合，是要求）─────────────────
 *
 *   · 只补白名单（SETTINGS_KEYS）里**缺失**的键，值取真源；已有值一律不动；
 *   · 非白名单键保留（这是纯偏好列，不替别人清理数据）；
 *   · settings_version 落后才补到 SETTINGS_VERSION；
 *   · 一行都不缺 ⇒ 不产生任何写（稳态下扫描是纯只读，零成本）。
 *
 * 因此「跑几次」是幂等的：第二次、第三次不会改动任何行。
 *
 * ── 安全闸门（照抄 notifyFollowUpdates / riskWatch 的判据）───────────
 *
 * 端上 `wx.cloud.callFunction` 调用时 `getWXContext().OPENID` 必有值，
 * 而定时器、控制台「云端测试」都没有。本函数能全表扫描**并写库**，
 * 绝不能让人从端上点火 —— 有 OPENID 一律直接拒绝。
 *
 * ── dry-run 是默认 ───────────────────────────────────────────────────
 *
 * 不传 `apply: true` 就**只读不写**，只回报「会补哪些行、补哪些键」。
 * 线上 users 是真实用户数据，先看影响面再落笔：
 *
 *   云开发控制台 → 云函数 → userBackfill → 云端测试
 *     入参 {}                 → dry-run，看返回的 toPatch / detail
 *     入参 {"apply": true}    → 真写
 *
 * ── 与 userInit 的关系 ───────────────────────────────────────────────
 *
 * 两者共享同一份真源副本（user-defaults.config.js，由 npm run config:sync 生成）。
 * 运行期**不互相调用**：userInit 挂在端上登录链路上，不该背运维的包袱；
 * 本函数是一次性的，跑完可以删 —— 记得同时删掉 config:sync 里的 target
 * 与 cloudbaserc.json 的声明。
 *
 * ⚠ 改完必须部署本云函数才生效；若还改了 src/config/user-defaults.ts，
 *   先 `npm run config:sync` 再部署。
 */
const cloud = require('wx-server-sdk')
const {
  DEFAULT_USER_SETTINGS,
  SETTINGS_KEYS,
  SETTINGS_VERSION
} = require('./user-defaults.config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/**
 * 单次请求多少行（云函数端 get 的上限远高于此，取 100 让每页可控、日志可读）。
 * ⚠ 这只是**请求值**：平台可能把 limit 压到更小，分页推进因此按实际取回条数走，见 scanAll。
 */
const PAGE = 100
/**
 * 扫描上限：真实用户量远小于此，设它是为了让「分页循环」有个确定的终点，
 * 而不是在异常数据上转圈。真撞上就说明该分批跑了（返回值里 truncated=true）。
 */
const MAX_ROWS = 20000
/** 明细最多回报多少行：返回值会进控制台日志，不宜无上限 */
const DETAIL_MAX = 50

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 缺键补齐：`默认值 + 现有值`（现有值优先），并保留非白名单键。
 *
 * ⚠ 与 cloudfunctions/userInit/index.js#mergeDefaults **同构**。
 * 两份是刻意分开的（运维函数不该 require 端上登录链路上的函数），
 * 但语义必须一致 —— 任何一边改了规则，另一边要跟着改。
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

/** 该行缺哪些白名单键（明细用；mergeDefaults 只回答「有没有缺」） */
function missingKeys(settings) {
  const cur = isPlainObject(settings) ? settings : {}
  return SETTINGS_KEYS.filter((k) => !(k in cur))
}

/** 按 created_at 升序（缺失的排最前）：重复行时 userInit 取最早那行当权威 */
function byCreatedAt(a, b) {
  return String(a.created_at || '').localeCompare(String(b.created_at || ''))
}

/**
 * 全表扫描本人可见的所有 users 行。
 *
 * 云函数是管理员身份，不受「仅创建者可读写」限制，所以这里拿得到全部用户 ——
 * 也正是本函数必须有闸门的原因。只取补齐要用的几列，不把整行拉回来。
 */
/**
 * 全表扫描本人可见的所有 users 行。
 *
 * 云函数是管理员身份，不受「仅创建者可读写」限制，所以这里拿得到全部用户 ——
 * 也正是本函数必须有闸门的原因。只取补齐要用的几列，不把整行拉回来。
 *
 * ⚠ `skip` 按**实际取回条数**推进，而不是按 `PAGE`：
 * 平台可能把 limit 压到更小（单次 get 有硬上限），按 PAGE 推进会整段跳过没读到的行
 * ——那种漏是静默的，补不齐还看不出来。停在「取回 0 行」而不是「不满一页」。
 */
async function scanAll() {
  const rows = []
  let truncated = false
  let skip = 0
  for (;;) {
    const res = await db
      .collection('users')
      .field({ _openid: true, settings: true, settings_version: true, created_at: true })
      .skip(skip)
      .limit(PAGE)
      .get()
    const page = (res && res.data) || []
    rows.push(...page)
    if (page.length === 0) break
    skip += page.length
    if (rows.length >= MAX_ROWS) {
      truncated = true
      break
    }
  }
  return { rows, truncated }
}

/**
 * 入口。
 *
 * 与 userInit 一样永远返回 `{ ok: ... }` 而不抛错：调用方是控制台的「云端测试」，
 * 一句裸异常在界面上只剩一行红字，而这里最需要看到的恰恰是统计数字。
 */
exports.main = async (event) => {
  /* 闸门：端上调用带 OPENID，控制台与定时器没有 */
  if ((cloud.getWXContext() || {}).OPENID) {
    console.warn('[userBackfill] 拒绝端上调用：本函数只由控制台 / 管理端触发')
    return { ok: false, skipped: '本函数只由控制台触发，不接受端上调用' }
  }

  /* dry-run 是默认：只有显式 apply 才落笔 */
  const apply = !!(event && event.apply === true)
  const startedAt = Date.now()

  try {
    const { rows, truncated } = await scanAll()

    let toPatch = 0
    let written = 0
    let versionOnly = 0
    let failed = 0
    const detail = []
    const byOpenid = new Map()

    for (const row of rows) {
      const { out, patched } = mergeDefaults(row.settings)
      const needVersion =
        typeof row.settings_version !== 'number' || row.settings_version < SETTINGS_VERSION

      /* 分组统计重复行：userInit.ensure 取最早那行当权威，这里只如实报告，不删 */
      const key = String(row._openid || '')
      byOpenid.set(key, (byOpenid.get(key) || 0) + 1)

      if (!patched && !needVersion) continue

      toPatch += 1
      if (!patched) versionOnly += 1

      if (detail.length < DETAIL_MAX) {
        detail.push({
          id: row._id,
          openid: key,
          add: missingKeys(row.settings),
          version: needVersion ? { from: row.settings_version ?? null, to: SETTINGS_VERSION } : null
        })
      }

      if (!apply) continue

      const patch = {}
      if (patched) patch.settings = out
      if (needVersion) patch.settings_version = SETTINGS_VERSION
      try {
        await db.collection('users').doc(row._id).update({ data: patch })
        written += 1
      } catch (err) {
        failed += 1
        console.warn(
          `[userBackfill] 写库失败 id=${row._id}：${(err && (err.errMsg || err.message)) || String(err)}`
        )
      }
    }

    const duplicates = []
    for (const [openid, count] of byOpenid) {
      if (count > 1) duplicates.push({ openid, count })
    }

    const result = {
      ok: true,
      /* false = dry-run（没落笔）；true = 已写入 */
      apply,
      scanned: rows.length,
      /* 有多少行需要动（dry-run 下即「将要写」的行数） */
      toPatch,
      /* 其中「只是版本号落后、键其实齐全」的行数 */
      versionOnly,
      written,
      failed,
      /* 同一 _openid 出现多行：历史端上竞态的产物，userInit 取最早那行当权威 */
      duplicates,
      /* 扫描被 MAX_ROWS 截断（真用户量撞不到，撞到就该分批跑） */
      truncated,
      detail,
      elapsedMs: Date.now() - startedAt
    }
    console.log(`[userBackfill] ${JSON.stringify({ ...result, detail: undefined })}`)
    return result
  } catch (err) {
    const message = (err && (err.errMsg || err.message)) || String(err)
    console.error(`[userBackfill] 失败：${message}`)
    return { ok: false, error: message, apply, elapsedMs: Date.now() - startedAt }
  }
}
