/**
 * payCallback —— 支付链路的**唯一后端**：支付结果通知（校验金额 → 幂等落库 → 续期会员）
 * + 售后（退款写口 + 定时对账 + 调用方闸门）。
 *
 * 本函数由**微信服务器**回调，因此在 `cloudbaserc.json` 里以 `functionName: 'payCallback'`
 * 注册给 `payCreate` 的统一下单。CloudBase 已完成验签与解密，本函数只负责业务处理。
 *
 * 三种入口，在 `exports.main` 顶部按事件形状分派（顺序即优先级）：
 *   ① `{ adminOp, token }`  运营写口（置退款 / 手动对账），需环境变量 `PAY_ADMIN_TOKEN`
 *   ② `{ Type: 'Timer' }`   定时对账（cloudbaserc.json 的 `payReconcile`，每小时第 15 分）
 *   ③ 支付结果通知（默认）   就是下面这六条设计里的第 1~5 条
 * ①② 的实现都在 `./after-sales.js`（那里有为什么「售后也必须长在本函数上」的理由）。
 *
 * 六处幂等 / 安全设计（支付链路上最容易出错的地方）：
 *   0. **调用方闸门**（2026-10-09 新增，2026-10-16 转 fail-closed）：云函数只要部署了，端上
 *      `wx.cloud.callFunction` 就能调到它 ——「进来的必然是微信回调」曾经只是约定，不是事实。
 *      于是任何人用开发者工具调 `{returnCode:'SUCCESS', resultCode:'SUCCESS',
 *      outTradeNo:<自己刚下的单>, totalFee:<单金额>}` 就能**给自己发货**（金额天然对得上，
 *      因为单是自己下的）。闸门按 `getWXContext().OPENID` 判：端上调用必带 openid，
 *      平台侧回调 / 定时器 / 控制台「云端测试」都没有。
 *      **默认已是 `strict`（未配置即拦截）**；`log` 降为「显式配置才生效」的观察档，`off` 一键回滚。
 *      为什么敢把默认从 log 收紧（三个当时可查的事实，不是推测）：
 *        ① 回调由**云支付平台侧**触发 —— payCreate 走的是 `cloudPay.unifiedOrder({ envId,
 *           functionName })`，平台直接调云函数，不是小程序端调用 ⇒ 不带 openid；
 *        ② 线上 `tcb fn log payCallback` **零调用日志**；
 *        ③ orders 集合当时只有一条 mock 行（`MRMOCK…` / `mock-tx-demo-0001`）⇒ 从无真实回调，
 *           也就是「判错的代价」在收紧那一刻恰好为零。
 *      若将来发现真回调被拦（日志会明确写「拒绝端上调用（OPENID=…）」），把
 *      `PAY_CALLBACK_GUARD` 设为 `log` 即刻回到观察档，再按日志里的实际形态补判据。
 *      （即便判错了，对账任务也会把滞留的 `granting` 补上，不会永久丢单。）
 *   1. **金额必须与订单一致**：不等则**不发货**并标记 failed，留人工核对。
 *      回调里的金额不可信（可能被伪造 / 串单），订单里的金额才是我们写的。
 *   2. **订单状态条件更新抢占发货权**：`status: 'pending' → 'granting'`，`updated === 0`
 *      说明已被并发回调处理过，重读一眼状态再决定（见第 3 点）。
 *   3. **`paid` 是「已发货」的终态，不是「已付款」**：`granting` 只在发货
 *      （会员权益写库）成功后才由 `markGranted` 推到 `paid`，且只对 `granting` 生效。
 *      于是残留的 `granting` 只有一个含义 —— 上一次回调发货中途失败，微信重试进来时会
 *      继续发货。这个区分是必需的：若抢占直接置 `paid`，而发货失败返回非 0 触发重试，
 *      重试会被「已 paid」判断 ack 掉 ⇒ 用户付了钱却永远拿不到会员（补偿通道被自己堵死）。
 *   4. **发货侧再按 `last_order_id` 去重，且是跨两处判**（见第 5 点）：两处保险。
 *      即便两个回调同时越过第 2 步，它们读到的旧 `expires_at` 相同 ⇒ 计算结果相同
 *      ⇒ 写入同一个值，不会叠加成 730 天。
 *   5. **会员权益落两处，权威与镜像分工明确（2026-10-09）**：
 *      `memberships`（_id = openid，客户端完全不可见）是**权威**，云端判会员一律读它；
 *      `users.membership` 降级为**端上读口的镜像**（端上界面读它，这次搬迁对端上零改动）。
 *      理由：users 是「仅创建者可读写」，端上能改自己那一行 —— 以它为准等于把会员身份
 *      交给客户端自证（自授会员 = 白用最贵模型 + 生成不计费）。详述见 grantMembership 上方。
 *
 * 返回值语义：`{ errcode: 0 }` = 已收到、不再通知；非 0 = 让微信按退避策略重试。
 * 因此**只有内部故障（DB 异常、找不到用户行）才返回非 0** —— 重试是我们唯一的补偿通道；
 * 而「订单不存在」「金额不符」这类确定性异常返回 0，重试也无意义。
 *
 * ⚠ 本函数是唯一允许写会员数据的地方：权威（memberships）与镜像（users.membership）
 *   都由它写，端上只读那份镜像（见 utils/pay.ts）。退款撤销会员也走它 —— 换个地方写，
 *   这条不变量就只剩一半。
 * 诊断依赖 `console.log`（进云函数日志）—— 回调的返回体格式由微信约定，装不下诊断信息。
 */
const cloud = require('wx-server-sdk')
const createAfterSales = require('./after-sales')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const DAY_MS = 86400000

/** 回调字段名兼容 snake_case / camelCase（微信 v2 通知为 snake_case） */
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function log(msg) {
  console.log(`[payCallback] ${msg}`)
}

/** ack：已收到、不再通知（detail 只进日志） */
function ack(detail) {
  log(`ack：${detail}`)
  return { errcode: 0, errmsg: 'OK' }
}

function updatedOf(res) {
  return (res && res.stats && res.stats.updated) || 0
}

async function readOrder(outTradeNo) {
  try {
    const res = await db.collection('orders').doc(outTradeNo).get()
    return res && res.data ? res.data : null
  } catch (err) {
    /* 行不存在时 doc().get() 直接抛错 */
    return null
  }
}

/** 解析 ISO 时间；非法 / 缺失给 0（参与 Math.max 时不会吃掉 Date.now()） */
function tsOf(v) {
  const t = Date.parse(v || '')
  return Number.isFinite(t) ? t : 0
}

/* ---------------- 会员权益的两个写入位（权威 + 镜像，2026-10-09） ----------------
 *
 * `memberships` 集合（_id = openid）= **服务端权威**，客户端完全不可见（ACL 见 dbInit/schema.js）。
 * 为什么权威不能继续放在 users.membership：那张表是「仅创建者可读写」，端上能改自己那一行，
 * 而云端有两处要拿会员身份做决策 —— aiProxy 的模型档位闸门与配额闸门、quotaGuard 的
 * 免计费复核。以端上可写的字段为准，改包者自授会员即可白用最贵那一档模型并让生成不计费。
 *
 * users.membership 保留为**镜像**：端上所有界面（会员卡 / 配额卡 / 档位展示）都读它，
 * 一处也没改，故这次搬迁对端上无感。镜像只是「给界面看的」，改它骗不到云端任何东西。
 *
 * 两处内容必须一致 —— 由 test/cases/06-pay-callback.js 的用例钉住。
 */

/**
 * 读权威行。**刻意用 `where` 而不是 `doc().get()`**（P1-10）：
 *
 * `doc().get()` 在「行不存在」时**抛错**，于是唯一的写法就是 try/catch 吃下去 ——
 * 而那一口会连着「真读失败」（集合权限没开、网络抖动、集合缺失）一起吞掉，上层只看见
 * `null`，与「这个人从没发过货」**无从分辨**。分辨不了就要命：发货分支会以为没有权威行，
 * 从而①用镜像的有效期当基数重算、②把 `refunded_orders` 名单丢掉 —— 后者是「这几单已经
 * 扣过天数」的唯一凭据，丢了下一轮对账就会**再扣一次**用户已付的天数。
 *
 * `where` 查询在无匹配时返回空数组、**不抛错**，「没有行」与「读失败」于是干净分开：
 * 前者 `null`，后者原样抛出 ⇒ 发货失败 ⇒ 微信重试。本函数的每个调用点都已在
 * 逐条 try/catch 里（发货主流程 / 对账三类 / 运营写口），抛出去是安全的。
 */
async function readMembership(openid) {
  const res = await db.collection('memberships').where({ _id: openid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

/**
 * 写权威行：set = upsert（同一 openid 恒只有一行），重复进入写同一个值。
 *
 * ⚠ `refunded_orders`（已撤销退款的订单号）**必须原样带回来**：本函数是 set 全量覆盖，
 * 漏掉它就等于把「这几单已经扣过天数」的唯一凭据清空 —— 而清空的后果是**再扣一次**。
 * 因此这里不再「信调用方记得带」：调用方没给数组时，**先读回现有名单再写**
 * （P1-10 的另一半；分支② 正是那个漏带的调用点）。读失败会在这里抛出 ⇒ 本趟不写、
 * 微信重试 —— 宁可晚一点发货，也不拿「记不清了」当「没扣过」。
 */
async function writeMembership(openid, m) {
  const data = {
    /* 显式写 _openid：云函数是管理员身份，不会像端上写入那样自动注入 */
    _openid: openid,
    plan: m.plan,
    expires_at: m.expires_at,
    last_order_id: m.last_order_id,
    updated_at: new Date().toISOString()
  }
  if (Array.isArray(m.refunded_orders)) {
    data.refunded_orders = m.refunded_orders
  } else {
    const cur = await readMembership(openid)
    const ledger = cur && cur.refunded_orders
    /* 只有确实有名单时才写这一列：新行本来就没有名单可丢，不必凭空多出一个空数组 */
    if (Array.isArray(ledger)) data.refunded_orders = ledger
  }
  /* 人工改会员的留痕（2026-10-18 运维中心）：只在调用方显式带时写。
     自动发货 / 退款不需要它 —— 那些有 orders 账本可查，人工动作才需要「倒推是谁改的」。 */
  if (m.last_admin_op) data.last_admin_op = m.last_admin_op
  await db.collection('memberships').doc(openid).set({ data })
}

/**
 * 写端上镜像（users.membership）：只给界面读；写不进去必须抛错让微信重试。
 *
 * ⚠ `membership` 必须用 `_.set(...)` **整块替换**，不能直接传对象（P0，2026-10-12 线上暴露）：
 * 微信云数据库的 `update({data})` 会把嵌套对象**展开成点号路径**（＝ `$set: {'membership.plan': …}`），
 * 而 `membership` 在首次购买前是 `null`（schema 的 def 就是 null）—— 往 null 里创建子字段，
 * MongoDB 直接报 `Cannot create field 'expires_at' in element {membership: null}`。
 * 症状：权威行写成功、镜像写失败 → 函数抛错 → 微信重试 → 每次都在同一步失败，
 * **首次购买的用户永远拿不到界面上的会员态**（云端闸门却已按会员放行，界面与权限对不上）。
 * `_.set` 是「整体替换该字段」的语义，对 null / 对象 / 缺失三种状态都成立。
 */
async function writeMirror(rowId, openid, m) {
  const upd = await db
    .collection('users')
    .doc(rowId)
    .update({
      data: {
        membership: _.set({
          plan: m.plan,
          expires_at: m.expires_at,
          /* 幂等标记：同一订单只发一次货 */
          last_order_id: m.last_order_id,
          updated_at: new Date().toISOString()
        })
      }
    })
  if (updatedOf(upd) === 0) throw new Error(`会员镜像写入未生效（openid=${openid}）`)
}

/**
 * 按 openid 找 users 行。云函数是管理员身份，where 查得到任何人；找不到返回 null，
 * 「找不到」在发货路径上是异常（抛错让微信重试），在对账路径上只是跳过这一条。
 */
async function findUserRow(openid) {
  const res = await db.collection('users').where({ _openid: openid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

/**
 * 发货：把会员有效期往后延 `order.days` 天，先写权威、再写镜像。
 *
 * 续期而非覆盖 —— `base = max(now, 权威行 expires_at)`；镜像行**只在权威行没有有效期时**
 * 才参与取值（迁移期老会员只有 users.membership 有值，那一份就是唯一线索，丢了等于吃掉他付过的天数）。
 *
 * ⚠ 权威行一旦有有效期，就**不再**取镜像的 max（2026-10-16 修）：`users` 是「仅创建者可读写」，
 * 端上能改自己那一行 —— 取 max 等于允许用户先把自己的镜像改到 3000 天后、再正常买一单，
 * 这个假值会被直接搬进权威行；之后连「以权威覆盖镜像」的对账也救不回来（权威自己就错了）。
 * 这正是 A2 要防的「端上自授会员」，只是入口从「读」换成了「发货时取 max」。
 *
 * 幂等按**订单号跨两处**判，而不是按某一处判：
 *   ① 权威行已记录这一单 ⇒ 只补镜像；
 *   ② 镜像行已记录这一单、权威行没有（迁移前发的货，或上次权威写成功而镜像失败的反向）
 *      ⇒ 只补权威。
 * 两条分支都**不重算天数**（重算就是叠加成双倍），且任一处缺失都会在下一趟补上 ——
 * 于是「发货成功但某一处写失败」不再需要人工介入，微信重试会自愈。
 *
 * 找不到用户行时**抛错**（返回非 0 让微信重试）：用户行理论上必然存在（下单前已登录），
 * 真缺失属异常，宁可重试也不静默吞掉一单。
 */
async function grantMembership(order, outTradeNo) {
  const openid = order._openid
  const days = Number(order.days) || 0
  if (!openid || days <= 0) {
    throw new Error(`订单 ${outTradeNo} 缺少 _openid 或 days，无法发货`)
  }

  const row = await findUserRow(openid)
  if (!row) throw new Error(`找不到用户行（openid=${openid}），订单 ${outTradeNo} 无法发货`)

  const plan = order.plan
  const auth = await readMembership(openid)
  const mirror = row.membership || null

  /* ① 权威行已记录这一单：只补镜像 */
  if (auth && auth.last_order_id === outTradeNo) {
    if (!mirror || mirror.last_order_id !== outTradeNo || mirror.expires_at !== auth.expires_at) {
      await writeMirror(row._id, openid, {
        plan: auth.plan || plan,
        expires_at: auth.expires_at,
        last_order_id: outTradeNo
      })
      log(`订单 ${outTradeNo} 权威行已有记录，本次只补齐端上镜像`)
    } else {
      log(`订单 ${outTradeNo} 已发货过（权威行 last_order_id 命中），跳过`)
    }
    return
  }

  /*
   * ② 镜像行已记录这一单、权威行没有：补齐权威，不重算天数。
   *
   * P1-10：这里**刻意不传 `refunded_orders`** —— 权威行可能已经存在（记录的是另一单）且带着
   * 退款名单，而 `writeMembership` 是 set 全量覆盖。由 `writeMembership` 自己「没给名单就
   * 先读回再写」来兜住这一列，比要求每个调用点都记得带更可靠（漏一个点就是资损）。
   * 这正是本轮修的那处：以前这里漏带，等于把「哪几单已扣过天数」清空。
   */
  if (mirror && mirror.last_order_id === outTradeNo) {
    await writeMembership(openid, {
      plan: mirror.plan || plan,
      expires_at: mirror.expires_at,
      last_order_id: outTradeNo
    })
    log(`订单 ${outTradeNo} 已在端上镜像里（迁移前发的货），本次补齐权威行`)
    return
  }

  /* ③ 新发货：先权威（成功即真会员生效），再镜像（端上界面用） */
  const authTs = tsOf(auth && auth.expires_at)
  /* 镜像只在「权威行没有有效期」时才参与取值 —— 端上能改镜像，取 max 会把它搬成权威值 */
  const base = Math.max(Date.now(), authTs, authTs > 0 ? 0 : tsOf(mirror && mirror.expires_at))
  const expiresAt = new Date(base + days * DAY_MS).toISOString()

  await writeMembership(openid, {
    plan,
    expires_at: expiresAt,
    last_order_id: outTradeNo,
    /* 带上已撤销退款的名单：set 是全量覆盖，漏一次就等于把幂等凭据清空 */
    refunded_orders: auth && auth.refunded_orders
  })
  await writeMirror(row._id, openid, { plan, expires_at: expiresAt, last_order_id: outTradeNo })

  log(`发货成功：openid=${openid} plan=${plan} days=${days} expires_at=${expiresAt}`)
}

/**
 * 发货完成：把订单从 `granting` 推到终态 `paid`。
 *
 * 只在 `granting` 时生效 —— 并发回调下另一个已经推到 paid，此时 updated 为 0，
 * 属正常情况（不是错误，故不抛错、不触发重试）。「付了钱但没拿到会员」的排查口径：
 * `granting` 残留（paid_at 有值、granted_at 为空、status 未到 paid）就是待补救的单。
 */
async function markGranted(outTradeNo) {
  const res = await db
    .collection('orders')
    .where({ _id: outTradeNo, status: 'granting' })
    .update({ data: { status: 'paid', granted_at: new Date().toISOString() } })
  if (updatedOf(res) === 0) {
    log(`订单 ${outTradeNo} 置 paid 未生效（已被并发回调置过或状态已变），忽略`)
  }
}

/* ─────────────────────── 调用方闸门与入口分派 ─────────────────────── */

/**
 * 调用方闸门：本函数不该被端上调用（端上只调 payCreate 下单，从不自己下发支付回调）。
 *
 * 判据：`getWXContext().OPENID` 非空 ⇒ 这一趟来自端上 `wx.cloud.callFunction`。
 * 平台侧支付回调（云支付 unifiedOrder 注册进来的）、定时器、控制台「云端测试」都没有 openid。
 *
 * 开关 `PAY_CALLBACK_GUARD`（环境变量）：
 *   - `strict`（**默认**）：端上调用一律拒绝。**未配置即此档** —— 与 handleAdminOp 的
 *     「未配置 PAY_ADMIN_TOKEN 一律拒绝」、dbInit 的 DB_ADMIN_TOKEN 同一口径：
 *     「没配就放行」是最常见的一种自我安慰，而出事的恰恰是没配的那一次。
 *   - `log`：**只在显式配置时生效**，检测到端上调用只记日志、照常往下走。这是观察档：
 *     怀疑真回调可能带 openid 时，用它换回现场证据（绝不再作为默认）。
 *   - `off`：完全不判（一键回滚用）。
 *   - 其它值（含拼错的）：走 strict —— 拼错一个开关名不该等于放行。
 *
 * 拒绝时返回非 0 而不是 `ack`：对端上来说两者没差别，但万一判据错了、被拦下的是真回调，
 * 非 0 会让微信继续重试。「宁可让它重试」永远是对的。
 *
 * ⚠ 但**别指望「对账扫 `granting` 兜底」能救被拦下的真回调**：`granting` 是回调**进来之后**
 * 才会写的中间态（见 handleNotify 的形状分支），被拦下的单压根走不到那一步 ——
 * 它会永远停在 `pending`，对账的三类扫描（granting / 镜像 / 退款）一类都扫不到它。
 * 所以拦截口必须**自己留痕**（`markGuardBlocked`）：真回调万一也带 OPENID，
 * 判据错了就是「一轮对账内被发现 + 人工 `adminOp:'grantMember'` 补发」，而不是用户付了钱没人知道。
 */
function callerGuard() {
  const wxContext = (cloud.getWXContext && cloud.getWXContext()) || {}
  const openid = wxContext.OPENID
  if (!openid) return null

  const mode = String(process.env.PAY_CALLBACK_GUARD || 'strict').toLowerCase()
  if (mode === 'off') return null

  const who = `${String(openid).slice(0, 8)}***`
  if (mode !== 'log') {
    log(`拒绝端上调用（OPENID=${who}）：支付回调不接受端上触发`)
    return { errcode: -1, errmsg: '本函数不接受端上调用' }
  }
  log(
    `⚠ 端上调用（OPENID=${who}）—— PAY_CALLBACK_GUARD=log 只记录不拦截。` +
    `确认过真机回调的形态之后，把该环境变量删掉（缺省即 strict）或显式写上 strict，回到拦截档`
  )
  return null
}

/**
 * 被闸门拦下时，在订单上留一个**对账看得见**的痕迹（只对「像微信支付通知」的载荷做）。
 *
 * 为什么必须留：闸门的判据（`OPENID` 非空 ⇒ 端上调用）是**推断**，本函数没法自证它对不对。
 * 若真回调也带 OPENID，被拦的就是真人真钱 —— 而订单会永远停在 `pending`，
 * 对账扫不到（理由见 callerGuard 注释）。于是：拦截 → 留痕 → 对账报出来 → 运营核对
 * 微信商户平台的这一单是否确已支付 → `adminOp:'grantMember'` 补发。判据万一错了，
 * 一轮对账内就有人知道，而不是等用户来投诉。
 *
 * ⚠ 痕迹**不作为发货依据**：端上同样造得出这个载荷（它只能触发「留痕」、触发不了发货），
 * 所以对账只报不改。要做成自动补发，唯一正当的依据是向微信查单（`cloud.cloudPay.queryOrder`）——
 * 那需要线上真机验证过接口形态之后才能接，别凭推断写。
 */
async function markGuardBlocked(event) {
  const outTradeNo = String(pick(event || {}, ['outTradeNo', 'out_trade_no']) || '')
  if (!outTradeNo) return null /* 不像支付通知（例如端上乱调）→ 不值得留痕 */
  try {
    await db
      .collection('orders')
      .doc(outTradeNo)
      .update({
        data: {
          guard_blocked: true,
          guard_blocked_at: new Date().toISOString(),
          guard_blocked_fee: Number(pick(event || {}, ['totalFee', 'total_fee'])) || null
        }
      })
    log(`⚠ 已拦下并留痕：订单 ${outTradeNo} —— 若该单在商户平台确已支付，用 adminOp:'grantMember' 补发（对账也会报出来）`)
    return outTradeNo
  } catch (err) {
    /* 单不存在 / 写不进去都不该改变拦截结论：留痕只是「让人能发现」，不是安全边界 */
    log(`拦截留痕失败（不影响拦截结论）：订单 ${outTradeNo} —— ${(err && err.message) || err}`)
    return null
  }
}

/* 售后（退款写口 + 定时对账）：实现全在 ./after-sales.js，这里只接线。
   注入而不是互相 require，是为了让 test/cases/09 能用内存 DB 直接跑它对账 ——
   云函数不能 require 端上 TS，但可以 require 同目录的纯模块。 */
const afterSales = createAfterSales({
  db,
  log,
  tsOf,
  DAY_MS,
  readOrder,
  readMembership,
  writeMembership,
  writeMirror,
  grantMembership,
  markGranted,
  findUserRow
})

exports.main = async (event) => {
  const blocked = callerGuard()
  if (blocked) {
    /* 拦下之后先留痕再回绝：万一判据错了，对账才看得见这单（见 markGuardBlocked） */
    await markGuardBlocked(event)
    return blocked
  }

  const e = event || {}

  /* ① 运营写口：先于形状判断，因为它的事件里也可能带 outTradeNo */
  if (e.adminOp) return afterSales.handleAdminOp(e)

  /* ② 定时对账：CloudBase 的 timer 事件形如 { Type: 'Timer', TriggerName, Time } */
  if (e.Type === 'Timer' || e.TriggerName) return afterSales.reconcile()

  /* ③ 支付结果通知 */
  const returnCode = pick(e, ['returnCode', 'return_code'])
  const resultCode = pick(e, ['resultCode', 'result_code'])
  const outTradeNo = pick(e, ['outTradeNo', 'out_trade_no'])
  const totalFee = pick(e, ['totalFee', 'total_fee'])
  const transactionId = pick(e, ['transactionId', 'transaction_id'])

  if (!outTradeNo) return ack(`通知缺少 outTradeNo，忽略（returnCode=${returnCode}）`)

  /* 失败 / 关闭通知：不涉及发货，ack 掉即可，避免微信反复重试 */
  if ((returnCode && returnCode !== 'SUCCESS') || (resultCode && resultCode !== 'SUCCESS')) {
    return ack(`非成功通知（returnCode=${returnCode} resultCode=${resultCode}），忽略`)
  }

  try {
    const order = await readOrder(outTradeNo)
    if (!order) return ack(`订单不存在：${outTradeNo}（非本系统订单或已被清理）`)
    if (order.status === 'paid') return ack(`订单已处理：${outTradeNo}`)

    if (Number(totalFee) !== Number(order.amount_fen)) {
      await db.collection('orders').doc(outTradeNo).update({
        data: { status: 'failed', callback_fee: Number(totalFee) || null }
      })
      return ack(
        `金额不符：订单 ${order.amount_fen} 分 / 回调 ${totalFee} 分，订单 ${outTradeNo} 未发货，需人工核对`
      )
    }

    /* 抢占发货权：pending → granting。granting 只是「有人在发货」，不是终态 */
    const claim = await db
      .collection('orders')
      .where({ _id: outTradeNo, status: 'pending' })
      .update({
        data: {
          status: 'granting',
          paid_at: new Date().toISOString(),
          transaction_id: transactionId || null
        }
      })

    if (updatedOf(claim) === 0) {
      /* 没抢到 ⇒ 状态已被别的回调改走。必须重读最新状态再决定，不能一律 ack：
         - paid      已发货完成，ack；
         - failed / refunded  绝不发货，ack；
         - granting  上一次回调发货中途失败（返回非 0 让微信重试、重试进来的正是这一趟），
                     本次继续发货。grantMembership 按 last_order_id 去重，重复进入不叠加天数。 */
      const latest = await readOrder(outTradeNo)
      if (!latest) return ack(`订单在并发处理中被清理：${outTradeNo}`)
      if (latest.status === 'paid') return ack(`订单已处理：${outTradeNo}`)
      if (latest.status === 'failed' || latest.status === 'refunded') {
        return ack(`订单状态为 ${latest.status}，不发货：${outTradeNo}`)
      }
      log(`订单 ${outTradeNo} 处于 ${latest.status}（上次回调未发完货），本次重试继续发货`)
      await grantMembership(latest, outTradeNo)
      await markGranted(outTradeNo)
      return { errcode: 0, errmsg: 'OK' }
    }

    await grantMembership(order, outTradeNo)
    await markGranted(outTradeNo)
    return { errcode: 0, errmsg: 'OK' }
  } catch (err) {
    /* 返回非 0 → 微信重试；这是内部故障的唯一补偿通道 */
    const msg = err instanceof Error ? err.message : String(err)
    log(`处理失败（将触发重试）：${msg}`)
    return { errcode: -1, errmsg: `处理失败：${msg}` }
  }
}
