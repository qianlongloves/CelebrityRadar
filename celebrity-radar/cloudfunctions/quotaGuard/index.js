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
 *   'refresh'  → refresh_quota（关注流刷新配额，免费 10 / 会员 20）
 *   'ask'      → ask_quota（AI 提问配额，免费 5 / 会员 30）
 *
 * 免计费（可选，仅 generate 的 consume）：端上传 `waiveIf` + `target: personKey`，
 * 服务端各自复核（端上那个标记不可信，复核不过一律照常计数）：
 *   · `'member_upgrade'`（2026-10-09）：会员「补齐」共享缓存那一版 —— 见下方「会员补齐」；
 *   · `'first_build'`（2026-10-15）：他为全站**首次建立**这个人物（此前缓存里连行都没有），
 *     且当日首建豁免名额还没用 —— 见下方「首建」。
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

/**
 * 行不存在时 doc().get() 直接抛错 —— 对配额而言「读不到」就等同 0。
 *
 * 2026-10-18（P2）：仍保持 fail-open（配额系统不能因为一次云库抖动就把所有付费用户拦在门外），
 * 但**要把「读失败」和「行不存在」分开留痕**。原先两者一律静默 return 0：今天第一次用是 0，
 * 权限配错 / 超时也是 0 —— 后者会让额度静默失效，且日志里一行都看不到，出问题只能靠猜。
 */
async function readCount(table, id) {
  try {
    const res = await db.collection(table).doc(id).get()
    const c = res && res.data && res.data.count
    return typeof c === 'number' ? c : 0
  } catch (err) {
    const msg = String((err && (err.errMsg || err.message)) || err || '')
    /* 行不存在是正常情况（今天第一次调用），不刷日志；其余一律告警 */
    const notFound = /not\s*exist|not\s*found|DOCUMENT_NOT_FOUND|-502004/i.test(msg)
    if (!notFound) console.warn(`[quotaGuard] 读计数失败 table=${table} id=${id}：${msg}`)
    return 0
  }
}

function updatedOf(res) {
  return (res && res.stats && res.stats.updated) || 0
}

/**
 * 「行已存在」时原子自增一次，返回有没有落实（updated > 0 的布尔形态）。
 *
 * ⚠ V-1（2026-10-09 复审）：`doc(id).update()` 打到**不存在的行**时，wx-server-sdk 的真实行为
 * 尚未在真机确认 —— 可能返回 `stats.updated === 0`，也可能**直接抛错**。本函数只关心
 * 「自增有没有落实」，与具体是哪种无关，故把抛错**一律归一成 0（未落实）**：
 * 否则每个用户每天**首次**调用（那一行还不存在）会直接抛错 → exports.main 兜成
 * 「配额写入失败」→ 端上静默回退本机计数，云端计数永远停在 0 ⇒ 多设备口径兜底失效。
 * 归一成 0 后照常走「插首行」分支，两种真机行为下结论完全一致。
 */
async function incrExistingRow(coll, id) {
  try {
    return updatedOf(await coll.doc(id).update({ data: { count: _.inc(1) } })) > 0
  } catch (err) {
    return false
  }
}

async function incr(table, id, openid) {
  const coll = db.collection(table)

  /* 常规路径：行已存在，原子自增（并发安全，不会丢计数） */
  if (await incrExistingRow(coll, id)) {
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
    if (await incrExistingRow(coll, id)) {
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
 * 与端上同源：utils/cache.ts#hasMemberBlocks → utils/member.ts#isMemberVersion。
 *
 * 判的是「**这一版是不是会员版**」：memberNotes 的两段文字任一非空，或 conflicts /
 * peers（同领域坐标，2026-10-12）/ affiliations（企业关联，2026-10-12）非空数组，
 * **或旗标说四段在副本表里**（P2 阶段 3，2026-10-17）。空壳（字段在但内容全空）不算。
 *
 * ⚠ 旗标这一支是阶段 3 的必需项，不是保险：剥段之后主行正文恒为「没有四段」，
 * 只看正文会把每一份会员版都判成免费版 —— 而本函数的唯一用途是**免计费复核**
 * （「这一行原本不含会员内容」才允许把这次生成算成免费的第一次补齐）。
 * 判错的方向是白送额度：同一个人可以把每次重新生成都申请成「补齐」。
 */
function hasMemberBlocks(report) {
  if (!report) return false
  const notes = report.memberNotes
  if (notes && (notes.compare || notes.risk)) return true
  if (Array.isArray(report.conflicts) && report.conflicts.length > 0) return true
  if (Array.isArray(report.peers) && report.peers.length > 0) return true
  if (Array.isArray(report.affiliations) && report.affiliations.length > 0) return true
  return Array.isArray(report.memberSections) && report.memberSections.length > 0
}

/**
 * personKey 的长度上限。**必须与写口 aiProxy/report-store.js 的 MAX_KEY_LEN 同源**：
 * 之前这里是 64、写口是 120，于是 64 < 长度 ≤ 120 的长名字（personKey = `名字#领域码`）
 * 能正常写出缓存、却在免计费复核这步被判成「target 非法」——
 * 症状很隐蔽：会员升级那一次白白多算一次生成额度，日志里什么都没有。
 */
const MAX_KEY_LEN = 120

/**
 * 刷新的每日上限（P2-30）—— **按档位**取（2026-10-10 起分档：免费 10 / 会员 20）。
 *
 * 以前这个数字只在端上判：`tallyRefreshQuota` 把云端计数取回来自己比一遍。同一份业务规则
 * 存两个副本就有两个真相 —— 端上那份可被改包改掉，而云端连「越界的尝试」都不会留痕。
 * 现在判定由本函数给出（回报 `limit` / `allowed`），端上直接采用、不再本地算数。
 *
 * 上限值不手写：取自 benefits.config.js（自动生成，真源 src/config/benefits.ts），
 * 与端上 utils/member.ts 的 refreshPerDay 是同一份数据。**分档之后**这里的档位判定必须是
 * 权威值 —— 端上那份只在云函数不可用时兜底（它可被改包，挡不住谁）。
 *
 * ⚠ 本函数仍然**只记账、只判定，不阻断调用**：真正的硬顶是 aiProxy 强判的 `generate` 池
 *   （3/日）—— 刷新一次报告要过一次生成配额，改包也绕不过去。本判定的作用是「让限制只有
 *   一个真相，并让越界尝试在云端日志里留痕」。
 */
const { MEMBER_BENEFITS } = require('./benefits.config')

/**
 * 调用者是不是有效期内的会员。
 *
 * 读 `memberships`（_id = openid，客户端完全不可读写）—— **刻意不读 users.membership**：
 * 后者那张表的权限是「仅创建者可读写」，端上能改自己那一行，以它为准等于把会员判定
 * 交给改包者。读不到 / 读库异常一律按**非会员**：方向是「宁可少给，不留白拿口子」。
 *
 * 只有 refresh 的额度判定用得到它 —— generate / ask 的限额在 aiProxy 入口，那边有自己
 * 的一份（各云函数独立打包，跨目录 require 部署后必失效）。
 */
async function isActiveMember(openid) {
  try {
    const res = await db.collection('memberships').doc(openid).get()
    return isMembershipActive((res && res.data) || null)
  } catch (err) {
    return false
  }
}

/** refresh 的当日上限（按档位）；调用方 await 一次，peek / consume 两个分支共用 */
async function refreshDailyLimit(openid) {
  const member = await isActiveMember(openid)
  return member ? MEMBER_BENEFITS.refreshPerDay.member : MEMBER_BENEFITS.refreshPerDay.free
}

/**
 * 只有 `refresh` 有服务端判定；`generate` / `ask` 的限额在 aiProxy 入口（见文件头）。
 * 返回 `{}` 表示「本类配额没有服务端上限」，调用方用 Object.assign 挂上去即可。
 *
 * `refreshLimit` 由调用方**先按调用者身份算好**再传进来（见 refreshDailyLimit）：
 * 保持同步是为了让「读一次会员身份、两个分支共用」这件事在调用点看得见。
 */
function judgeLimit(kind, count, refreshLimit) {
  if (kind !== 'refresh') return {}
  return { limit: refreshLimit, allowed: count <= refreshLimit }
}

/** target 只用于 doc(id) 取值：禁掉路径分隔符，限定长度（与写口同源） */
function validTargetKey(target) {
  return typeof target === 'string' && target !== '' && target.length <= MAX_KEY_LEN && !target.includes('/')
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

/* ------------------------------ 「首建」免计费复核（2026-10-15） */

/**
 * 背景（与「会员补齐」同一条原则，只是补上最后一块）：报告是全局共享缓存，一份建好之后
 * 全站长期复用、任何人再查都不消耗次数 —— 于是「第一个生成的人」付掉 1 次额度，
 * 后来者（含他自己）免费读。
 *
 * 这笔账**本来就该认**：项目已经认过「替全站把缓存升级成会员版不该由个人掏次数」（见上）。
 * 首建比升级更彻底 —— 升级至少让会员本人拿到了会员段落，**首建对他自己的额外收益是零**。
 *
 * ⚠ 端上那个标记不可信（可改包），所以复核必须在这里做，四个条件**同时**成立才免：
 *   1. 那一行存在，且 `first_build_owner` 就是调用者 —— 由写口在建行那一条 insert 里写死
 *      （`!existing` 即「全站第一次建这个人物」），端上伪造不了（report_cache 客户端只读）；
 *   2. 那一行还没被免过（`first_build_waived_at` 空）—— 否则「首建完立刻刷新一次」能再来一发；
 *   3. `first_build_at` 落在时间窗内 —— 豁免只对应**刚发生的那一次生成**，不是一张长期欠条；
 *   4. 今天的首建豁免名额还没用完（**上限 1 次/日**）。
 *
 * 为什么上限是 1 次/日：免费额度 3 次/日，若首建全免，「专挑新人物建」就能把闸门整个绕开
 * （平台支出最多涨到 4 次/人/天）。锁在 1 次既把增量压到可控范围，又保住了那句诚意 ——
 * 「你为全站建了新内容，这一次平台请你」。它也是**唯一的滥用边界**：即便有人能伪造出
 * 前面三条，每天也只多拿 1 次。
 *
 * 任何一步不成立或读库异常 → 不免，按普通生成计数（宁可多算一次，不留白拿口子）。
 */
const FIRST_BUILD = 'first_build'

/** 每日首建豁免上限（理由见上）；与免费档 generate 的 3 次/日搭配 ⇒ 最坏 4 次/人/天 */
const FIRST_BUILD_WAIVE_PER_DAY = 1

/**
 * 时间窗：从写口建行（`first_build_at`）到这次申请之间允许的间隔。
 *
 * 取值必须**盖住一次最坏构建**：`utils/cache.ts#BUILDING_TIMEOUT_MS` = 4 批 × 3 次尝试
 * × 2 轮完整生成 × 45s + 检索 15s + 余量 30s = **1125s（约 18.7 分钟）** —— 它是「这次生成
 * 最长可能跑多久」的权威上界，而申请必然发生在构建结束之后。
 *
 * 原先填 15 分钟，比这个上界还短：构建只要慢到 18 分钟，用户在构建结束的毫秒之后提交的申请
 * 就会因超窗被拒 —— 冤枉的恰好是最慢的那些首建（用户已付出最长的等待，还拿不到那句诚意）。
 * 故取 20 分钟，刚好盖住上界；**不要再改小**，除非同时确认构建上界也降了。
 *
 * 再长就等于把「首建」变成一张可以慢慢兑现的欠条；不过放长本身不危险：② 的人物级标记与
 * ④ 的 1 次/日上限都还在，多认的也只是「当天那一次」。所以这里宁可稍微宽松。
 */
const FIRST_BUILD_WINDOW_MS = 20 * 60 * 1000

/**
 * 占用今天的「首建豁免」名额（原子）。返回 true = 名额到手。
 *
 * 计数落在**同一张 generate_quota 行的另一个字段** `waive_count` 上，不新开集合：
 * 那一行本来就是「某人某天」的天然容器（_id = openid#date），而按项目惯例新开集合还要
 * 在控制台手建 + 收紧权限，漏一步就静默失效（见文件头 `ask` 的教训）。
 *
 * 先自增再读回：并发的两个请求各占一坑（读到 1 与 2），后者判超限即回滚并放行失败 ——
 * 宁可多算一次生成，也不放过两次豁免。
 */
async function claimFirstBuildSlot(id, openid) {
  const coll = db.collection('generate_quota')
  let updated = 0
  try {
    updated = updatedOf(await coll.doc(id).update({ data: { waive_count: _.inc(1) } }))
  } catch (err) {
    /* 见 incrExistingRow 的 V-1 说明：行不存在时可能返回 0、也可能抛错，两者一律按「没落实」处理 */
    updated = 0
  }

  if (updated === 0) {
    /*
     * 今天还没有任何**计入**的生成（那一行还不存在）：插首行。
     * count 记 0 —— 本次是免计费的那一次，生成配额本就不该增加。
     * 并发下 add 会因 _id 已存在而抛错：那一坑已被别人占走，保守判不免。
     */
    try {
      await coll.add({ data: { _id: id, _openid: openid, count: 0, waive_count: 1 } })
      return true
    } catch (err) {
      return false
    }
  }

  let used = 0
  try {
    const res = await coll.doc(id).get()
    used = res && res.data && typeof res.data.waive_count === 'number' ? res.data.waive_count : 0
  } catch (err) {
    /* 读不回来：既确认不了、也没法回滚，保守判不免（多算一次生成，好过多放一次豁免） */
    return false
  }
  if (used <= FIRST_BUILD_WAIVE_PER_DAY) return true

  /* 超限：把刚占的这一坑还回去（回滚失败也不影响判定 —— 下次仍会读到超限值） */
  try {
    await coll.doc(id).update({ data: { waive_count: _.inc(-1) } })
  } catch (err) {
    /* 见上 */
  }
  return false
}

async function firstBuildWaived(openid, target) {
  if (!validTargetKey(target)) return false

  /* 行不存在时 doc().get() 直接抛错（与 readCount 同一现象）：由调用方兜成「不免」 */
  const res = await db.collection('report_cache').doc(target).get()
  const row = (res && res.data) || null
  if (!row) return false

  /* ① 这一行是**本次由调用者新建**的（写口在建行那条 insert 里写死，端上伪造不了） */
  if (row.first_build_owner !== openid) return false
  /* ② 同一人物只免一次 —— 否则「首建完马上刷新一次」能重复领 */
  if (row.first_build_waived_at) return false
  /* ③ 时间窗：豁免只对应刚发生的那一次生成，不是一张长期欠条 */
  const builtAt = Date.parse(row.first_build_at)
  if (!Number.isFinite(builtAt) || Date.now() - builtAt > FIRST_BUILD_WINDOW_MS) return false
  /* ④ 每日上限：先占名额再发放（并发下只放一个） */
  if (!(await claimFirstBuildSlot(`${openid}#${todayKey()}`, openid))) return false

  /*
   * 标记「这个人物的首建豁免已用掉」：它是条件 ② 的判据。
   * best-effort —— 写不进去也**不会多发**：③ 的时间窗与 ④ 的日上限仍然拦着。
   */
  try {
    await db
      .collection('report_cache')
      .doc(target)
      .update({ data: { first_build_waived_at: new Date().toISOString() } })
  } catch (err) {
    console.warn(`[quotaGuard] 首建豁免标记写入失败（不影响本次判定）：${(err && err.message) || err}`)
  }
  return true
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
    /*
     * refresh 要按身份判额度，其余 kind 不需要会员身份 —— 别为 generate / ask 白读一次
     * memberships（那是每次生成 / 提问都要多付的一次库读，而它们根本不看这个值）。
     */
    const refreshLimit = kind === 'refresh' ? await refreshDailyLimit(openid) : 0

    if (action === 'peek') {
      const peeked = await readCount(table, id)
      return Object.assign(
        { ok: true, kind, date, count: peeked },
        judgeLimit(kind, peeked, refreshLimit)
      )
    }
    if (action !== 'consume') {
      return { ok: false, error: `未知 action：${action}（支持 consume / peek）` }
    }

    /* 免计费（会员补齐 / 首建）：只有生成配额这一条口子，复核不过就照常计数 */
    if (kind === 'generate' && (event.waiveIf === MEMBER_UPGRADE || event.waiveIf === FIRST_BUILD)) {
      let waived = false
      try {
        waived =
          event.waiveIf === MEMBER_UPGRADE
            ? await memberUpgradeWaived(openid, event.target)
            : await firstBuildWaived(openid, event.target)
      } catch (err) {
        console.warn(`[quotaGuard] ${event.waiveIf} 复核失败，按普通生成计数：${(err && err.message) || err}`)
      }
      if (waived) {
        /* 免计费：不自增，回报当前计数（端上按 waived 处理，不再补记） */
        return { ok: true, kind, date, count: await readCount(table, id), waived: true }
      }
    }

    const r = await incr(table, id, openid)
    return Object.assign(
      { ok: true, kind, date, count: r.count, created: r.created, waived: false },
      judgeLimit(kind, r.count, refreshLimit)
    )
  } catch (err) {
    return { ok: false, error: `配额写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
