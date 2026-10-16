import Taro from '@tarojs/taro'
import { buildPersonKey, parsePersonKey } from '@/config/domains'
import { personWatchLimit } from './opinion-access'

/**
 * 舆情页冷启动「先盯上几个人」推荐（S1-4 / 决策 D2，2026-10-16）。
 *
 * ## 这个模块解决什么
 *
 * 舆情页（pages/opinion）是四个 tab 里唯一一个「每天都值得打开」的页面，但它对**新用户是空的**：
 * 简报四格全是 0、今日要点没有、事件时间线没有 —— 因为它们全都要求用户先有「关系」
 * （关注 / 监控词 / 监控人），而新用户一条都没有。于是唯一一个日常型页面对新用户呈现为一页零。
 * 本模块为那种页面准备一份**冷启动推荐**：给出 2-3 个可以一键建立关系的对象。
 *
 * ## D2 已拍死的三件事（改本文件前先读，别把它改回「自动预置监控」）
 *
 * **1. 绝不自动建监控。** 原提案是「新用户进舆情页就替他预置 2-3 个监控」，落地时否掉了。
 * 下面三条任一条都足以否掉它：
 *
 *   · `utils/risk-watch.ts#monitorPerson` 的**第一条异步**是 `Taro.requestSubscribeMessage` ——
 *     微信只认「用户点击后的第一个异步调用」，**非点击触发的预置永远拿不到推送授权**。
 *     而 monitorPerson 的既有取舍是「授权失败照常把监控建上」，于是自动预置产出的是**哑监控**：
 *     收不到任何推送，用户以为盯上了却什么都不会发生 —— 这比空态更糟。
 *   · 「监控某人」在免费档**只有 3 个额度**（`config/benefits.ts#OPINION_LIMITS.personWatchCount`）。
 *     自动预置正好把额度一次占满，用户随后想盯着自己关心的人时撞上「超限，先取消一个再加」——
 *     开局即负债。
 *   · 冷启动的新用户**没有任何个性化信号**（history / follows / watches 都是空的），所以「预置谁」
 *     只能是平台挑的热门。替他决定盯谁，等于在一个他还没表达过兴趣的维度上替他把额度花掉。
 *
 *   ⇒ 所以这里只**产出候选**，由用户自己点，一次点击建一个（授权天然满足「点击后第一个异步」）。
 *
 * **2. 推荐谁。** 优先「他查过的人」（`utils/history.ts#listRecentHistory`，唯一的真实意图信号，
 * 老用户回归时也用得上），不足才用热门榜（`utils/hot-board.ts#loadHotBoard`，**带静态种子兜底、
 * 永不为空**）补齐；已监控的人不再出现在候选里（再点一次是空操作，占了位置又点不动）。
 *
 * **3. 推荐几个。** `PICK_LIMIT` —— 最多 3 个，且**不超过免费档能建的监控人数**：推荐量超过用户
 * 能建的量，就是在推销额度。候选不够时如实少给，不硬凑（宁可只推 1 个）。
 *
 * ## 边界
 *
 * 本文件是**纯函数 + 一处本机 storage**：不查库、不发检索、不花额度（候选全部来自既有的只读口），
 * 也不新增集合 / 云函数。所有函数对脏数据（缺失 / 非数组 / 非字符串 / 算不出）一律不抛，
 * 并且**算不出就不显示**（宁可少说一句，也不给已经有关系的用户推「先盯上几个人」）。
 */

/**
 * 推荐上限：最多 3 个，且不超过免费档「监控某人」的上限（见文件头第 3 条）。
 *
 * 取 `Math.min` 而不是直接抄 3：数值真源在 config/benefits.ts，免费档上限一旦下调，
 * 这里必须跟着降 —— 否则会推出一份用户根本建不完的清单。
 */
export const PICK_LIMIT = Math.min(3, personWatchLimit(false))

/** 本机「已关闭冷启动推荐」标记键（与 `inbox:seen` 同类：纯本机偏好，不上云、不进任何集合） */
export const PICK_DISMISS_KEY = 'opinion:pick.dismissed'

/** 候选来自哪一池：`history` = 他查过的人（优先），`hot` = 热门榜（补齐） */
export type PickReason = 'history' | 'hot'

/** 一个可一键建立监控的候选。`personKey` 与报告缓存同一套键（`名字#领域`），监控的就是同一个人。 */
export interface PickCandidate {
  personKey: string
  name: string
  /** 领域码（已净化，可能是自创领域串） */
  domain: string
  reason: PickReason
}

export interface PickInput {
  /** 他查过的人（`listRecentHistory` 的行，已按时间倒序）；缺 / 脏按空处理 */
  history?: Array<{ personKey?: string | null; name?: string | null }> | null
  /** 热门榜（`loadHotBoard()` 的结果，**数组顺序即排名**）；缺 / 脏按空处理 */
  board?: Array<{ name?: string | null; domain?: string | null }> | null
  /** 已经监控过的人（personKey）：不再推荐 */
  taken?: string[] | null
  /** 覆盖上限（默认 `PICK_LIMIT`）；≤ 0 直接返回空 */
  limit?: number
}

/**
 * 产出冷启动推荐候选（纯函数，见文件头第 2 条）。顺序即展示顺序：他查过的人在前，热门榜在后。
 *
 * 去重按**两个维度**：`personKey` 与**人名**。
 *   · 按 personKey 去重：同一份报告不该出现两次；
 *   · 按人名去重：同名不同领域（`张三#ent` 与 `张三#sport`）是两份报告，但对用户来说就是同一个人 ——
 *     清单里并排两个「张三」只会让人以为页面错了。
 */
export function pickMonitorCandidates(input: PickInput): PickCandidate[] {
  const raw = input?.limit
  const limit = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : PICK_LIMIT
  if (limit <= 0) return []

  const taken = new Set(
    (Array.isArray(input?.taken) ? input.taken : []).filter((k): k is string => typeof k === 'string' && !!k)
  )
  const out: PickCandidate[] = []
  const seenKey = new Set<string>()
  const seenName = new Set<string>()

  const push = (name: string, personKey: string, domain: string, reason: PickReason): void => {
    if (out.length >= limit) return
    if (!name || !personKey || !domain) return
    if (taken.has(personKey) || seenKey.has(personKey) || seenName.has(name)) return
    seenKey.add(personKey)
    seenName.add(name)
    out.push({ personKey, name, domain, reason })
  }

  /* ① 他查过的人优先：这是冷启动场景里唯一可能的「真实意图」信号 */
  for (const row of Array.isArray(input?.history) ? input.history : []) {
    const key = typeof row?.personKey === 'string' ? row.personKey : ''
    const parsed = key ? parsePersonKey(key) : null
    if (!parsed) continue
    const name = typeof row?.name === 'string' ? row.name.trim() : ''
    push(name || parsed.name, key, parsed.domain, 'history')
  }

  /* ② 热门榜补齐（数组顺序即排名）。榜单条目只有 name + domain、**没有 personKey**，
        故在这里用 buildPersonKey 现造一个 —— 与报告缓存同一套 key 口径（含 # 净化），
        监控的就是同一个人；再造一遍 key 而不是拼字符串，是为了不在这里漏掉净化那一步。 */
  for (const row of Array.isArray(input?.board) ? input.board : []) {
    const name = typeof row?.name === 'string' ? row.name.trim() : ''
    if (!name) continue
    const key = buildPersonKey(name, typeof row?.domain === 'string' ? row.domain : '')
    const parsed = parsePersonKey(key)
    if (!parsed) continue
    push(parsed.name, key, parsed.domain, 'hot')
  }

  return out
}

/**
 * 是否该显示冷启动推荐。判据只有「确实是冷启动」+「没关过」两条。
 *
 * `relations` = 关注人数 + 监控词数 + 监控人人数（三者都是用户主动建立的关系）。
 *
 * ⚠ **调用方必须拿「读数据那一刻」的关系数判一次，并把结果存下来**（页面存的是候选数组本身），
 *   不要在渲染期用实时关系数再判一次：用户从推荐里建了第一个监控之后关系数就 > 0 了，
 *   实时判定会让卡片在「还剩两个候选」时突然消失。
 *
 * ⚠ 关系数**算不出来（缺参 / NaN / 非数字）时返回 false**：给一个可能已经有关系的用户推
 *   「先盯上几个人」，比少推一次难看得多（与 `utils/report#isColdPerson` 同一取舍：宁可少说一句）。
 */
export function shouldShowPick(opts: { relations?: number | null; dismissed?: boolean | null }): boolean {
  if (opts?.dismissed) return false
  const n = opts?.relations
  if (typeof n !== 'number' || !Number.isFinite(n)) return false
  return n <= 0
}

/**
 * 推荐卡的一句来源说明 —— **必须如实说是谁挑的**。
 *
 * 不许写成「你可能认识」「为你精选」这类暗示「平台懂你」的话：冷启动的新用户没有任何个性化信号，
 * 这些名字就是平台按热度（或他自己查过的记录）挑的。说清来源，用户才有理由拒绝。
 */
export function pickSourceNote(cands: PickCandidate[] | null | undefined): string {
  const list = Array.isArray(cands) ? cands : []
  const hasHistory = list.some((c) => c?.reason === 'history')
  const hasHot = list.some((c) => c?.reason === 'hot')
  if (hasHistory && hasHot) return '一位是你查过的人，其余是当前热门'
  if (hasHistory) return '你最近查过的人'
  return '当前热门人物，不是根据你的兴趣挑的'
}

/**
 * 推荐卡的代价说明：监控到底做什么、要不要付出代价。
 *
 * 写明代价再让用户点（与 S2-2「监控风险」同一约定）：额度一旦用掉就要用户自己去取消，
 * 不说清楚就引导点击，等于把「超限」留给用户自己撞。
 *
 * ⚠ **不写死「免费版 3 个」这个数字**：舆情页是**不引入会员态**的页面（见该页
 * 「本页不引入会员态变量」的既有约定，用例 36 钉住），写死档位数字对会员就是错的。
 * 只说「有上限、超了要先取消」，两个档位都成立；具体数字在监控页（那里才知道档位）。
 */
export function pickCostNote(): string {
  return '监控 = 每天替你扫一次公开报道，命中风险词才提醒你；监控人数有上限，超了要先取消一个'
}

/* ─────────────────────────── 本机「已关闭」标记 ─────────────────────────── */

/**
 * 读本机「已关闭冷启动推荐」标记。
 * 存储坏掉 / 缺键一律按「没关过」处理（最坏是再显示一次引导，绝不会抛）。
 */
export function readPickDismissed(): boolean {
  try {
    return Taro.getStorageSync<boolean>(PICK_DISMISS_KEY) === true
  } catch {
    return false
  }
}

/**
 * 记下「已关闭」。**关一次就永久不再出现** —— 这是给新用户的引导，不是常驻推荐位；
 * 用户明确说了不用就别再问第二遍。失败静默（写不进去最坏是下次再显示一次，不影响任何主流程）。
 */
export function dismissPick(): void {
  try {
    Taro.setStorageSync(PICK_DISMISS_KEY, true)
  } catch {
    /* 静默 */
  }
}

/** 清除本机标记（「清空我的数据」/「注销」调用，与 messages / inbox / weekly 同一处理）。 */
export function clearPickDismiss(): void {
  try {
    Taro.removeStorageSync(PICK_DISMISS_KEY)
  } catch {
    /* 静默 */
  }
}
