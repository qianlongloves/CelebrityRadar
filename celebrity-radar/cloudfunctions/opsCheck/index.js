'use strict'

/**
 * 每日自检（2026-10-22）：把「昨天那几个定时任务到底跑没跑、跑成什么样」变成一条**人能看见**的消息。
 *
 * ## 为什么需要它
 *
 * 全站有四个定时任务（06:30 热门榜 / 09:00 关注更新 / 09:20 关键词预警 / 09:40 风险监控），
 * 每一个都可能因为上游 key 失效、检索超时、模板被平台驳回而整轮空转。而现在的失败信号只有两种：
 *   · 云函数日志 —— 要人去控制台翻；
 *   · `scan_logs` 里的 status='error' —— 要人进小程序翻监控台账。
 * 两者都要求「有人当天主动去看」，可「昨天一条都没发出去」恰恰是没人会想起来看的那种故障。
 *
 * ## 它判什么、不判什么
 *
 * 只判**能从库里算出来**的事实（`scan_logs` 是三个推送函数自己写的执行日志）：
 *   1. 昨天某一路「一条执行日志都没有」⇒ 那个 cron 没跑（超时、报错、触发器丢了）；
 *   2. 昨天有 status='error' 的记录 ⇒ 上游检索失败或消息没发出去，列出最近一条原因；
 *   3. 失败率过半 ⇒ 多半是 key 失效或上游整体不可用（不是个别词的偶发失败）。
 *
 * ## 关于关注更新（notifyFollowUpdates，kind='follow'）
 *
 * 2026-10-22 之前它**不写 `scan_logs`**，本函数于是刻意不判它 —— 因为「有授权却没消耗」这个
 * 信号本身歧义（没新动态本来就不该推）。可那天实测发现它整条链路**一条消息都没发出去过**
 * （定时器拿不到云调用鉴权，见各函数 `@push-send` 段），而所有日志看着全绿：不判它 = 漏掉唯一
 * 会静默死掉的链路。
 * 现在它每轮写一条 `kind='follow'、object_key='(round)'` 的整轮日志（含「没有订阅用户」这种
 * 早退），于是「零日志」不再有歧义 ⇒ 本函数可以放心判它的「没跑」与「失败」。
 *
 * ## 只在异常时说话
 *
 * 每天一条「一切正常」的消息等于训练人忽略它。故 `issues` 为空时不发；
 * 想强制发一次看格式，手动调用时带 `always: true`；
 * 想核对「今天刚跑的那一轮」（而不是昨天），带 `today: true`。
 *
 * ## 闸门
 *
 * 定时器触发（event 里有 Type/TriggerName）不需要口令；手动调用必须带 `token`=DB_ADMIN_TOKEN
 * ——否则任何人从小程序端调一次就能让你的告警群里多一条消息。
 *
 * ## 渠道
 *
 * 企业微信群机器人：`OPS_WEBHOOK_URL`（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`）。
 * 未配置时本函数**照常返回报告**、只是不发消息（本地调试与未接渠道时主流程不受影响）。
 */

const cloud = require('wx-server-sdk')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const SCAN_TABLE = 'scan_logs'
const WATCH_TABLE = 'keyword_watches'
const USER_TABLE = 'users'
const PAGE_SIZE = 500
/** 业务口径的「昨天」按 UTC+8 切天（与定时任务的 cron 时区、结算口径一致） */
const TZ_OFFSET = 8 * 3600 * 1000

const WEBHOOK_URL = String(process.env.OPS_WEBHOOK_URL || '').trim()
const ADMIN_TOKEN = String(process.env.DB_ADMIN_TOKEN || '').trim()

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 昨天 [00:00, 24:00) 的 ISO 区间（+8 切天） */
function windowOfYesterday(now = new Date()) {
  const local = new Date(now.getTime() + TZ_OFFSET)
  const y = local.getUTCFullYear()
  const m = local.getUTCMonth()
  const d = local.getUTCDate()
  const startLocal = Date.UTC(y, m, d - 1)
  const endLocal = Date.UTC(y, m, d)
  const labelDate = new Date(startLocal)
  return {
    start: new Date(startLocal - TZ_OFFSET).toISOString(),
    end: new Date(endLocal - TZ_OFFSET).toISOString(),
    label: `${labelDate.getUTCFullYear()}-${pad2(labelDate.getUTCMonth() + 1)}-${pad2(labelDate.getUTCDate())}`
  }
}

/** 今天 [00:00, 现在] 的 ISO 区间（+8 切天）—— 手动排障时看「刚跑的这一轮」（`today: true`） */
function windowOfToday(now = new Date()) {
  const local = new Date(now.getTime() + TZ_OFFSET)
  const y = local.getUTCFullYear()
  const m = local.getUTCMonth()
  const d = local.getUTCDate()
  const startLocal = Date.UTC(y, m, d)
  return {
    start: new Date(startLocal - TZ_OFFSET).toISOString(),
    end: new Date(now.getTime() + 1).toISOString(),
    label: `${y}-${pad2(m + 1)}-${pad2(d)}（当天，手动排障用）`
  }
}

/**
 * 读全量（分页跳页，与 keywordAlert 的 readAll 同一手法）。
 * `skip` 线性扫描在这个量级（每天最多几十到几百行）完全够用；真到几十万行该做的是分片聚合。
 */
async function readAll(table, where, max = 5000) {
  const out = []
  for (;;) {
    const res = await db
      .collection(table)
      .where(where)
      .orderBy('_id', 'asc')
      .skip(out.length)
      .limit(PAGE_SIZE)
      .get()
    const rows = (res && res.data) || []
    out.push(...rows)
    if (rows.length < PAGE_SIZE || out.length >= max) break
  }
  return out
}

/** 用量的「有没有人在等推送」：三种一次性授权任一为 true 的都算 */
async function countArmed() {
  try {
    const res = await db
      .collection(USER_TABLE)
      .where(_.or([{ subscribe_ok: true }, { alert_ok: true }, { risk_ok: true }]))
      .count()
    return Number((res && res.total) || 0)
  } catch (err) {
    console.warn(`[opsCheck] 统计待推送授权失败：${err && err.message}`)
    return -1
  }
}

function emptyStat() {
  return { objects: 0, ok: 0, skipped: 0, error: 0, hit: 0 }
}

/** 把昨天的 scan_logs 按 kind 汇总；kind 之外的脏行忽略（日志表是全站可读的，不能假定干净） */
function summarize(logs) {
  const byKind = new Map()
  const errorNotes = []
  const followNotes = []
  for (const row of logs) {
    const kind = String((row && row.kind) || '')
    if (kind !== 'keyword' && kind !== 'person' && kind !== 'follow') continue
    if (!byKind.has(kind)) byKind.set(kind, emptyStat())
    const stat = byKind.get(kind)
    stat.objects += 1
    stat.hit += Math.max(0, Number(row.hit) || 0)
    const status = String(row.status || '')
    if (status === 'ok') stat.ok += 1
    else if (status === 'skipped') stat.skipped += 1
    else if (status === 'error') {
      stat.error += 1
      const who = String(row.object_name || row.object_key || '')
      /* 关注更新每轮一条，它的失败原因要单独列（不能混进「N 个对象扫描失败」里） */
      if (kind === 'follow') {
        if (followNotes.length < 2) followNotes.push(String(row.note || '').slice(0, 120))
      } else if (errorNotes.length < 3) {
        errorNotes.push(`${who}${row.note ? `（${String(row.note).slice(0, 60)}）` : ''}`)
      }
    }
  }
  return {
    keyword: byKind.get('keyword') || emptyStat(),
    person: byKind.get('person') || emptyStat(),
    follow: byKind.get('follow') || emptyStat(),
    errorNotes,
    followNotes
  }
}

async function collect(opts = {}) {
  const win = opts.today ? windowOfToday() : windowOfYesterday()
  const logs = await readAll(SCAN_TABLE, { ran_at: _.gte(win.start).and(_.lt(win.end)) })
  const stat = summarize(logs)

  /* 监控对象的数量：用来区分「这路没人用所以没日志（正常）」与「有人用却没日志（cron 挂了）」 */
  let watches = []
  try {
    watches = await readAll(WATCH_TABLE, {})
  } catch (err) {
    console.warn(`[opsCheck] 读监控名单失败：${err && err.message}`)
  }
  const kwargs = watches.filter((w) => String((w && w.type) || '') !== 'person').length
  const personCnt = watches.filter((w) => String((w && w.type) || '') === 'person').length

  const armed = await countArmed()
  return { win, stat, kwargs, personCnt, armed }
}

/** 把汇总结果翻译成「人该不该管」：只在这里产生 issues，格式化与发送不重复判断 */
function judge({ stat, kwargs, personCnt }) {
  const issues = []
  const kw = stat.keyword
  const pn = stat.person
  const fl = stat.follow

  if (kwargs > 0 && kw.objects === 0) {
    issues.push(`关键词预警昨天没有任何执行日志（${kwargs} 个词在监测）⇒ 09:20 的定时任务没跑或被超时中断`)
  }
  if (personCnt > 0 && pn.objects === 0) {
    issues.push(`风险监控昨天没有任何执行日志（${personCnt} 个人在监控）⇒ 09:40 的定时任务没跑或被超时中断`)
  }
  /* 关注更新**每天必跑**，且「没有订阅用户」也会写一条 skipped —— 所以零日志只可能是没跑 */
  if (fl.objects === 0) {
    issues.push('关注更新昨天没有任何执行日志 ⇒ 09:00 的定时任务没跑或被超时中断（这条链路已无其他信号）')
  }

  const errors = kw.error + pn.error
  if (errors > 0) {
    issues.push(`${errors} 个对象扫描失败：${stat.errorNotes.join('；') || '日志里没有失败原因'}`)
  }
  /* 订阅消息发不出去是最容易被当成「没问题」的故障（历史上整整一段时间一条都没发出去且日志全绿） */
  if (fl.error > 0) {
    issues.push(`关注更新有 ${fl.error} 轮推送失败：${stat.followNotes.join('；') || '日志里没有失败原因'}`)
  }

  const objects = kw.objects + pn.objects
  if (objects > 0 && errors / objects >= 0.5) {
    issues.push(`失败率 ${Math.round((errors / objects) * 100)}%：多半是检索/大模型的 key 失效或上游整体不可用，不是个别对象的问题`)
  }
  return issues
}

function line(label, s) {
  const tail = s.error > 0 ? `，**${s.error} 个失败**` : ''
  return `**${label}** ${s.objects} 个对象：ok ${s.ok} / skipped ${s.skipped} / error ${s.error}${tail}；命中 ${s.hit} 条`
}

/** 关注更新每轮一条汇总日志，指标是「推送成功几人」而不是「命中几条」，故单独成行 */
function followLine(f) {
  if (f.objects === 0) return '**关注更新** 昨天没有执行日志'
  const bits = [`${f.objects} 轮`]
  if (f.skipped) bits.push(`跳过 ${f.skipped} 轮`)
  bits.push(`推送成功 ${f.hit} 人`)
  if (f.error) bits.push(`**${f.error} 轮失败**`)
  return `**关注更新** ${bits.join(' / ')}`
}

function buildMarkdown({ win, stat, kwargs, personCnt, armed }, issues) {
  const lines = [`## 名人雷达 · 每日自检（${win.label}）`, '']
  lines.push(line(`关键词（监测 ${kwargs} 个）`, stat.keyword))
  lines.push(line(`名人（监控 ${personCnt} 个）`, stat.person))
  lines.push(followLine(stat.follow))
  lines.push(`**待推送授权** ${armed < 0 ? '读不到' : `${armed} 人`}`)
  if (issues.length) {
    lines.push('', '> 需要处理：')
    issues.forEach((s) => lines.push(`> · ${s}`))
  } else {
    lines.push('', '昨天各路的执行日志正常，未发现需要处理的问题。')
  }
  lines.push('', '<font color="comment">只判 scan_logs 能证明的事；「有人订阅但没新动态」不算异常。</font>')
  return lines.join('\n')
}

/** POST 到企业微信机器人；失败只记日志，绝不因此让自检函数本身"红" */
function postWebhook(content) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(WEBHOOK_URL)
    } catch (err) {
      resolve({ ok: false, error: `OPS_WEBHOOK_URL 不是合法 URL：${err && err.message}` })
      return
    }
    const body = Buffer.from(JSON.stringify({ msgtype: 'markdown', markdown: { content } }), 'utf8')
    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        timeout: 10000
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          let errcode = null
          try {
            errcode = JSON.parse(text).errcode
          } catch (err) {
            /* 非 JSON 就当未知，下面按状态码判 */
          }
          resolve({ ok: res.statusCode === 200 && (errcode === 0 || errcode === null), status: res.statusCode, text: text.slice(0, 200) })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（10s）'))
    })
    req.on('error', (err) => resolve({ ok: false, error: err && err.message }))
    req.write(body)
    req.end()
  })
}

exports.main = async (event = {}) => {
  const e = event || {}
  /* 定时触发的事件长这样：{ Type: 'Timer', TriggerName: 'dailyOpsCheck', Time: ... } */
  const fromTimer = Boolean(e.Type || e.TriggerName || e.type === 'timer')
  const token = String(e.token || '')
  if (!fromTimer && !(ADMIN_TOKEN && token === ADMIN_TOKEN)) {
    return { ok: false, skipped: '只由定时器触发；手动调用需带 token（=DB_ADMIN_TOKEN）' }
  }

  const data = await collect({ today: e.today === true })
  const issues = judge(data)
  const content = buildMarkdown(data, issues)

  /* 只在有问题时打扰人；`always` 用于手动验证格式 */
  const shouldSend = Boolean(WEBHOOK_URL) && (issues.length > 0 || e.always === true)
  let notify = { ok: false, skipped: '未配置 OPS_WEBHOOK_URL' }
  if (shouldSend) notify = await postWebhook(content)
  else if (WEBHOOK_URL) notify = { ok: false, skipped: '无异常，按设计不发送（可带 always:true 强制）' }

  console.log(`[opsCheck] ${data.win.label} 关键词 ${data.stat.keyword.objects} / 名人 ${data.stat.person.objects} / 问题 ${issues.length} / 发送 ${notify.ok ? '成功' : '未发'}`)

  return {
    ok: true,
    date: data.win.label,
    window: { start: data.win.start, end: data.win.end },
    keyword: data.stat.keyword,
    person: data.stat.person,
    watches: { keyword: data.kwargs, person: data.personCnt },
    armed: data.armed,
    issues,
    notify,
    markdown: content
  }
}
