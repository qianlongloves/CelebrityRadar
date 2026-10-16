import { table } from './db'
import { diagLog } from './cloud-diagnostics'
import { HistoryRow, listRecentHistory } from './history'
import { fromNow } from './time'

/**
 * N-2 报告更新回访（站内，2026-10-16）。
 *
 * 回答的是一个**只有站内**才谈得上的问题：「我看过的人，报告后来变过吗？」
 * （推送模板因小程序类目限制申请不下来，回访只能发生在用户自己打开 App 的时候 —— 见
 * doc/产品优化路线图.md 的 D8 与 §7。）
 *
 * ── 判据：两个时间戳，少一个都不算 ─────────────────────────────────────────
 *
 * 需要**同时**有：
 *   ① 「我看的是哪一版」（`history.viewed_generated_at`，报告页看到正文时写入）；
 *   ② 「现在这一版是什么时候生成的」（`report_cache.generated_at`，且 `state === 'ready'`）。
 * ② 的毫秒值**严格晚于**①才算「变过」。
 *
 * ⚠ 为什么判据不放在 `report_versions` 上（那里不是已经有版本流水吗）：那份流水**只留被覆盖的
 * 旧版**，且有三处会让它静默算漏 ——
 *   · 首次覆盖时写下的那一行 `generated_at` 与「被我覆盖的那一版」相同（同一版的第二次请求），
 *     严格比较 `>` 会漏掉「他看的是这一版，之后确实重生过一次」；
 *   · 端上直写兜底路径（云端写口不可用时的回退）**不记版本**，流水里根本没有这次重生；
 *   · 流水会被裁剪（每个 personKey 只留有限几行，见 cloudfunctions/aiProxy/report-store.js）。
 * 而 `report_cache.generated_at` 是**当前版的权威生成时间**，上面三处它都不受影响：直写兜底
 * 会照常更新它，裁剪更与它无关。判定只用它，代价是每次回访判定的查询都是「一行一个人、三个
 * 轻字段」，不读任何报告正文。
 *
 * ── 三条不许越过的线 ───────────────────────────────────────────────────────
 *
 * 1) **没有指纹就不算**。存量行、以及报告没读出来就退出的那几次访问都没有指纹 ——
 *    此时必须当成「没有证据」，**不许拿访问时间顶替**。顶替的后果是：只要三天前看过谁，
 *    三天后就会被告知「他有变化」，而这个说法是编出来的（路线图里那句「明确不做『随便推个
 *    旧人回来』」指的正是这件事）。
 * 2) **`building` 不算**。抢锁会把 `generated_at` 提前置成 `now`（代价是让全站对该人物的
 *    查询排队），此时正文还是上一个版本的 —— 拿它判定等于报告**还没变就报变过**。
 * 3) **别人触发的重生也照报**。报告是全局共享缓存（D6），「这一版变了」是客观事实：任何用户
 *    点「刷新最新」之后，所有人看到的确实是新内容。这条不是妥协，是共享缓存的题中之义；
 *    真正要避免的只有「拿没有证据的人凑数」。
 *
 * ── 代价 ───────────────────────────────────────────────────────────────────
 * 未登录、或浏览历史里一行指纹都没有时：**一次库都不读**（listRecentHistory 自己做未登录短路）。
 * 否则 = 1 次 history 读（≤50 行，已有口径）+ 1 次 `report_cache` 批量读（只 select
 * `id,generated_at,state`，不含报告正文）。始终 2 次查询，与「看了多少人」无关。
 */

/**
 * 扫描「最近看过的」多少人。
 *
 * 取 20 而不是全部 50：判定要覆盖的是**最近的回访理由**，而更早看过的那些多半他自己也忘了
 * （listHistory 本身已按时间去重、倒序，取前 20 就是最近 20 个不同的人）。
 */
export const REVISIT_SCAN = 20

/**
 * 消息中心最多**分行列出**几位。
 *
 * 超出部分不静默丢弃：由 `revisitOverflowText` 如实报出还剩几位（同 S3-3「不许静默截断」）。
 * 设成 5 的理由是版面：报告更新是好消息，但一次铺十行会把「关注的人有新动态」挤出第一屏，
 * 而后者才是用户自己建立的关注关系。
 */
export const REVISIT_MAX = 5

/** `report_cache` 里判定要用的**轻字段**（不取 report / search_meta） */
export interface CurrentVersionRow {
  id: string
  generated_at?: string
  state?: string
}

export interface RevisitItem {
  personKey: string
  name: string
  /** 我上次看这份报告的时刻（浏览历史那一行的 `ts`，文案里用） */
  viewedAt: string
  /** 我上次看到的那一版的生成时间 —— **判据本身**，不参与文案（留给调用方与用例复核） */
  viewedVersion: string
  /** 当前版的生成时间（严格晚于 viewedVersion） */
  currentVersion: string
}

/** ISO → 毫秒；不可解析一律 NaN（判据用，绝不用 0 顶替） */
function ms(iso?: string): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : NaN
}

/**
 * 纯函数：从「我看过谁」+「那几个人现在的版本」算出真的有变化的人（时间倒序）。
 *
 * @param rows    浏览历史（可传全量：同一人的多条只取**最近看的那条** —— 判据问的是
 *                「我上次看他是哪一版」，不是「我看过他的每一版」）
 * @param current `report_cache` 的轻字段行（`.in('id', keys)` 批量取回）
 */
export function buildRevisitItems(rows: HistoryRow[], current: CurrentVersionRow[]): RevisitItem[] {
  const now = new Map<string, CurrentVersionRow>()
  for (const c of current) {
    if (c && typeof c.id === 'string') now.set(c.id, c)
  }

  const latest = new Map<string, HistoryRow>()
  for (const row of rows) {
    if (!row || typeof row.person_key !== 'string') continue
    const prev = latest.get(row.person_key)
    if (!prev || ms(row.ts) >= ms(prev.ts)) latest.set(row.person_key, row)
  }

  const out: RevisitItem[] = []
  for (const [personKey, row] of latest) {
    const viewed = ms(row.viewed_generated_at)
    /* 没有指纹 / 指纹不可解析 ⇒ 没有证据（见文件头第 1 条） */
    if (!Number.isFinite(viewed)) continue
    const c = now.get(personKey)
    if (!c || c.state !== 'ready') continue
    const cur = ms(c.generated_at)
    if (!Number.isFinite(cur) || cur <= viewed) continue
    out.push({
      personKey,
      name: row.name,
      viewedAt: row.ts,
      viewedVersion: row.viewed_generated_at as string,
      currentVersion: c.generated_at as string
    })
  }

  /* 最近变化的排前面：这一屏的顺序就是「先看谁」 */
  out.sort((a, b) => ms(b.currentVersion) - ms(a.currentVersion))
  return out
}

/**
 * 一条回访消息的副标题。
 *
 * 只说两件**算得出来的事实**：他什么时候看过、这一版什么时候生成的。刻意不提「素材从 N 条
 * 变成 M 条」—— 那要读当前版的 `search_meta`，而消息行只该说「变了」，**改了什么**是 N-9
 * 差异视图的回答（点进去就能看到条数与条目级差异），两处都说就成了两个口径。
 */
export function revisitDescText(item: RevisitItem): string {
  return `你上次看过（${fromNow(item.viewedAt)}）· 报告已更新于 ${fromNow(item.currentVersion)}`
}

/** 名次之外还剩几位：数字如实说出，不许静默截断 */
export function revisitOverflowText(hidden: number): string {
  return hidden > 0 ? `另有 ${hidden} 位看过的名人也有更新` : ''
}

/**
 * 读口：判定「谁的报告变过」。任何失败都返回空数组（消息中心少一类消息，绝不白屏）。
 */
export async function loadRevisits(): Promise<RevisitItem[]> {
  try {
    const rows = await listRecentHistory(REVISIT_SCAN)
    const marked = rows.filter(
      (r) => typeof r.viewed_generated_at === 'string' && r.viewed_generated_at.length > 0
    )
    /* 一行指纹都没有：连 report_cache 都不查（存量用户与未登录用户的默认路径） */
    if (marked.length === 0) return []

    const keys = Array.from(new Set(marked.map((r) => r.person_key)))
    const { data, error } = await table('report_cache')
      .select('id,generated_at,state')
      .in('id', keys)
    if (error) {
      diagLog('warn', 'db', `回访判定读取失败：${error.message ?? error}`)
      return []
    }
    return buildRevisitItems(marked, (data as CurrentVersionRow[]) ?? [])
  } catch (err) {
    diagLog('warn', 'db', `回访判定异常：${String(err)}`)
    return []
  }
}
