/**
 * quotaGuard —— 配额计数的服务端权威。
 *
 * 为什么必须服务端化：小程序包可解包，「端上读-改-写」的计数有两个硬伤 ——
 *   1. 并发超发（两个请求同时读到 count=2，都写回 3）；
 *   2. 计数可被改包直接篡改，日期取端上时间 ⇒ 改设备时间即可重置当日额度。
 * 本函数对应两点：`db.command.inc(1)` 原子自增，日期取服务端时间。
 *
 * 与 aiProxy 的分工：aiProxy 管「key 不外泄」，本函数管「额度不可伪造」。
 * 但失败语义不同 —— aiProxy 失败要明确告知用户（生成会失败），
 * 本函数失败则端上静默回退到本地计数（见 src/utils/quota-guard.ts），不阻断生成。
 *
 * ⚠ 部署顺序（颠倒会出事，务必按序执行）：
 *   先部署本函数并确认「我的 → 联网能力」侧无异常，再把 generate_quota /
 *   refresh_quota 的权限收紧为自定义规则：
 *     { "read": "doc._openid == auth.openid", "write": false }
 *   若先收紧权限而函数尚未部署，端上回退写入会被权限拒绝，计数恒为 0
 *   ⇒ 免费额度形同虚设（可无限生成）。
 *
 * action：
 *   'consume'（默认）原子自增一次并返回新值
 *   'peek'    只读当日计数，不自增
 * kind：
 *   'generate' → generate_quota（报告生成配额，免费 3 / 会员 30）
 *   'refresh'  → refresh_quota（关注流刷新配额，10）
 *   'ask'      → ask_quota（AI 提问配额，免费 5 / 会员 30）
 *
 * 免计费（可选，仅 generate 的 consume，2026-10-09 新增）：
 *   入参 `waiveIf: 'member_upgrade'` + `target: personKey` —— 会员「补齐」共享缓存
 *   那一版时不计入配额。复核口径见下方「会员补齐」一节，注意端上那个标记不可信。
 *
 * ⚠ `ask`（2026-10-07 新增）与前两者有一处**语义差异**，改端上前先读：
 *   报告生成是「发起时自增、失败不退还」（端上只在成功落库后调用，见 quota.ts），
 *   而提问的口径是「**成功拿到回答才计数**」—— 端上先读 `ask_quota` 判额度、
 *   拿到回答后才调本函数自增（见 src/utils/qa.ts）。故 `ask` 的 consume
 *   只该在成功分支出现一次，不要挪到发起前：失败/被拦也算次数会与界面承诺不符。
 *
 * 限额判定**不在本函数**（2026-10-09 起由 aiProxy 入口自己判，数值见其 quota.config.js）：
 * 本函数的职责始终只有「把计数写对」；会员身份在这里只有一处用途 —— 「会员补齐」免计费的
 * 复核（见下方），且读的是服务端权威表 memberships。
 *
 * ⚠ 新增 `ask` 类需要配套两步人工操作，缺一步就会静默退回端上计数：
 *   ① 建 `ask_quota` 集合（`dbInit` 的 schema 已声明，或控制台手建）；
 *   ② 部署本函数，并把 `ask_quota` 权限收紧为 { read: 本人, write: false }。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

/** 表名白名单：kind 来自客户端，绝不可拼进表名 */
const TABLE_BY_KIND = {
  generate: 'generate_quota',
  refresh: 'refresh_quota',
  ask: 'ask_quota'
}

/**
 * 服务端「今天」：云函数时区为 UTC，必须显式 +8，
 * 否则北京时间 08:00 之前的计数会落到前一天，与端上 todayKey() 错位。
 */
function todayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 行不存在时 doc().get() 直接抛错 —— 对配额而言「读不到」就等同 0 */
async function readCount(table, id) {
  try {
    const res = await db.collection(table).doc(id).get()
    const c = res && res.data && res.data.count
    return typeof c === 'number' ? c : 0
  } catch (err) {
    return 0
  }
}

function updatedOf(res) {
  return (res && res.stats && res.stats.updated) || 0
}

async function incr(table, id, openid) {
  const coll = db.collection(table)

  /* 常规路径：行已存在，原子自增（并发安全，不会丢计数） */
  if (updatedOf(await coll.doc(id).update({ data: { count: _.inc(1) } })) > 0) {
    return { count: await readCount(table, id), created: false }
  }

  /*
   * 首次调用：插首行。
   * _openid 必须**显式**写入 —— 云函数是管理员身份，不会像端上写入那样
   * 自动注入 _openid；缺了它，端上按「doc._openid == auth.openid」的读规则
   * 就看不到这一行，会员/配额卡会一直显示 0/3。
   */
  try {
    await coll.add({ data: { _id: id, _openid: openid, count: 1 } })
    return { count: 1, created: true }
  } catch (err) {
    /* 并发：另一端刚插好，改回自增路径；仍失败才是真故障 */
    if (updatedOf(await coll.doc(id).update({ data: { count: _.inc(1) } })) > 0) {
      return { count: await readCount(table, id), created: false }
    }
    throw err
  }
}

/* ------------------------------ 「会员补齐」免计费复核（P1，2026-10-09） */

/**
 * 背景：报告是全局共享缓存（report_cache 以 personKey 为主键，全站一行）。
 * 会员点开某个人时，缓存里那一份可能是免费档先生成的 —— 里面没有会员段落
 * （memberNotes / conflicts 只在会员提示词里请求）。
 *
 * 他点「刷新最新」重新生成，实质是**替全站把这行缓存升级成会员版**：产物照样写进
 * 共享缓存，之后所有免费用户都读得到。这笔账不该由他掏每日次数，故端上带
 * `waiveIf: 'member_upgrade'` 申请免计费。
 *
 * ⚠ 端上那个标记不可信（可改包），所以复核必须在这里做，三个条件**同时**成立才免：
 *   1. 调用者会员确实生效（memberships.expires_at 未过期，口径与端上同源 —— 只认有效期）；
 *   2. 目标那行缓存存在且 state=ready；
 *   3. 那一行**不含**会员段落 —— 即这次生成确实是在「从免费档升到会员档」。
 * 任何一步不成立或读库异常 → 不免，按普通生成计数（宁可多算一次，不留白拿口子）。
 * 天然限次：补齐一次之后该行就含会员段了，同一个人无法反复免。
 */
const MEMBER_UPGRADE = 'member_upgrade'

/** 与端上 utils/member.ts#isMembershipActive 同源：只认 expires_at，不校验 plan */
function isMembershipActive(m) {
  if (!m || !m.expires_at) return false
  const t = Date.parse(m.expires_at)
  return Number.isFinite(t) && t > Date.now()
}

/**
 * 与端上同源：utils/cache.ts#hasMemberBlocks → utils/member.ts#presentSections。
 * 口径是「**实际存在**的专享段落」：memberNotes 的两段文字任一非空，或 conflicts 非空数组。
 * 空壳（字段在但内容全空）不算 —— 端上把这个口径同时用于「是否算会员版」与 UI 展示。
 */
function hasMemberBlocks(report) {
  if (!report) return false
  const notes = report.memberNotes
  if (notes && (notes.compare || notes.risk)) return true
  return Array.isArray(report.conflicts) && report.conflicts.length > 0
}

/** target 只用于 doc(id) 取值：禁掉路径分隔符，限定长度 */
function validTargetKey(target) {
  return typeof target === 'string' && target !== '' && target.length <= 64 && !target.includes('/')
}

async function memberUpgradeWaived(openid, target) {
  if (!validTargetKey(target)) return false

  /*
   * 会员身份读 `memberships`（服务端权威），**刻意不读 users.membership**：
   * users 那张表的权限是「仅创建者可读写」，端上能改自己那一行 —— 以它为准的话，
   * 改包用户给自己写上 membership 字段就能白拿这次免计费。
   * 端上读的 users.membership 只是给界面看的镜像（见 utils/member.ts 顶部说明）。
   * 读不到 / 读库异常一律按非会员：方向是「宁可多算一次，不留白拿口子」。
   */
  let auth = null
  try {
    const res = await db.collection('memberships').doc(openid).get()
    auth = (res && res.data) || null
  } catch (err) {
    auth = null
  }
  if (!isMembershipActive(auth)) return false

  /* 行不存在时 doc().get() 直接抛错（与 readCount 同一现象）：由调用方兜成「不免」 */
  const res = await db.collection('report_cache').doc(target).get()
  const cacheRow = res && res.data
  if (!cacheRow || cacheRow.state !== 'ready') return false
  return !hasMemberBlocks(cacheRow.report)
}

exports.main = async (event) => {
  const kind = event && event.kind
  const table = TABLE_BY_KIND[kind]
  if (!table) return { ok: false, error: `未知 kind：${kind}（支持 generate / refresh / ask）` }

  const openid = (cloud.getWXContext() || {}).OPENID
  if (!openid) return { ok: false, error: '取不到调用者 openid（请从小程序端调用）' }

  const date = todayKey()
  const id = `${openid}#${date}`
  const action = (event && event.action) || 'consume'

  try {
    if (action === 'peek') {
      return { ok: true, kind, date, count: await readCount(table, id) }
    }
    if (action !== 'consume') {
      return { ok: false, error: `未知 action：${action}（支持 consume / peek）` }
    }

    /* 「会员补齐」免计费（P1）：只有生成配额这一条口子，复核不过就照常计数 */
    if (kind === 'generate' && event.waiveIf === MEMBER_UPGRADE) {
      let waived = false
      try {
        waived = await memberUpgradeWaived(openid, event.target)
      } catch (err) {
        console.warn(`[quotaGuard] 会员补齐复核失败，按普通生成计数：${(err && err.message) || err}`)
      }
      if (waived) {
        /* 免计费：不自增，回报当前计数（端上按 waived 处理，不再补记） */
        return { ok: true, kind, date, count: await readCount(table, id), waived: true }
      }
    }

    const r = await incr(table, id, openid)
    return { ok: true, kind, date, count: r.count, created: r.created, waived: false }
  } catch (err) {
    return { ok: false, error: `配额写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
