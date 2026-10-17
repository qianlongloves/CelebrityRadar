import { callCloudFunction } from './cloud'
import { diagLog } from './cloud-diagnostics'
import { track } from './events'
import { hasMemberContent, MEMBER_FIELD_KEYS } from './member'
import type { MemberFielded } from './member'
import type { Report } from './report'

/**
 * 会员段读口（P2 方案 A **阶段 2**，2026-10-17）。
 *
 * ## 它解决什么
 * `report_cache` / `report_versions` 是「所有人可读」的，而报告正文里带着四段会员专属内容。
 * 阶段 1 已经把副本写进客户端读不到的 `report_member`（云端 `op:'member'` 读口已上线），
 * 阶段 3 才会把主行的四段剥掉。**本模块是端上那一天唯一要用的东西**。
 *
 * ## 触发条件（缺一不可）
 * 1. 报告上有 `memberSections` 旗标且非空 —— 说明「这份确实有会员段，内容在副本表里」；
 * 2. 正文里**没有**会员段（`hasMemberContent` 为假）—— 阶段 3 之后的主行形态。
 *
 * ⚠ 条件 1 是本模块存在的理由：没有旗标时**一次云函数调用都不发**。
 * 起因是「主行缺四段」有两种完全不同的原因 —— ①这份报告本来就是免费档生成的（补也没有）；
 * ②主行被剥了段（要补）。端上自己分不出来，而两种情况的成本差一个数量级：
 * 会员打开任意一份免费档报告都要盲调一次云函数 + 一次写限速计数，那是几万次/日的白烧。
 *
 * ## 配对判据：时间戳逐字相等（与云端同一条口径）
 * 主行与副本行不是原子写的。云函数已经按「它收到的 `generatedAt`」比过一次，这里**再比一次**
 * 是因为上游那一次比的是「我们传上去的值」——真正要保证的是「交回来的四段属于**手里这一份**」。
 * 不等一律当作没有会员段：宁可少给（会员这一眼看不到四段，页面给补齐引导），
 * 也绝不能把上一版的结论配到这一版正文上。
 *
 * ## 失败一律静默
 * 这个模块的返回值只有「有」和「没有」，所有失败都退化成「没有」：
 * 非会员（`auth`）、当日读太多（`abuse`）、网络/未部署（`failed`）、时间戳对不上（`mismatch`）、
 * 副本确实不存在（`empty`）。报告页不该因为「补不上四段」而报错或白屏 ——
 * 免费态是完整的、可用的界面，只是少了付费内容。
 */

/** 云端 `op:'member'` 的结果分类（`ok` 之外全是「拿不到」，区别只在埋点与缓存策略） */
export type MemberSectionReason = 'ok' | 'empty' | 'mismatch' | 'auth' | 'abuse' | 'failed'

export interface MemberSectionsOutcome {
  ok: boolean
  reason: MemberSectionReason
  /** 仅在 `ok` 时存在：已按 `MEMBER_FIELD_KEYS` 过滤 */
  sections?: Record<string, unknown>
}

/**
 * 同一份报告的结论缓存上限。
 *
 * 缓存的是**结论**（拿到 / 确实空 / 对不上），不是请求：报告页每次刷新都补一次的话，
 * 会员把一份报告翻十遍就是十次云函数往返（其中九次结论一样）。
 * 键里带 `generatedAt`，所以报告重生一次自然失效 —— 不需要显式清理。
 */
const REPLY_CACHE_MAX = 50
const replyCache = new Map<string, MemberSectionsOutcome>()

/** 只认这四个键（云端多给的东西不进报告对象），空值一律不认 */
function pickSections(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of MEMBER_FIELD_KEYS) {
    const v = src[k]
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : null
}

function finish(
  key: string,
  out: MemberSectionsOutcome,
  props: { personKey: string; version: boolean }
): MemberSectionsOutcome {
  track('member_sections', { personKey: props.personKey, result: out.reason, version: props.version })
  /*
   * 只缓存「数据本身的结论」：ok / empty / mismatch 换一次调用也是这个答案。
   * auth（今天不是会员，明天可能是）、abuse（明天 0 点恢复）、failed（网络抖一下）
   * 都**不缓存** —— 缓存它们等于把一次临时故障变成「这份报告永远补不上」。
   */
  if (out.reason === 'ok' || out.reason === 'empty' || out.reason === 'mismatch') {
    if (replyCache.size >= REPLY_CACHE_MAX) replyCache.clear()
    replyCache.set(key, out)
  }
  return out
}

/**
 * 「这份报告的会员段被写口剥掉了」—— 阶段 3 之后的主行形态。
 *
 * 旗标非空 + 正文没有会员段。两个条件都要：
 * 只看旗标会在**阶段 3 之前**（主行仍带四段）白发一次调用；
 * 只看「正文没有」会把免费档生成的报告也算进来（那种报告永远补不出东西）。
 */
export function hasStrippedMember(
  report: (MemberFielded & { memberSections?: string[] }) | null | undefined
): boolean {
  const flag = report?.memberSections
  if (!Array.isArray(flag) || flag.length === 0) return false
  return !hasMemberContent(report)
}

/**
 * 向云函数要一份报告的会员段。**不做身份判断**（云函数自己读 `memberships` 权威表），
 * 但调用方应当只在「读者是会员」时才走到这里 —— 不是会员的调用只会换来一次 `auth`。
 *
 * `version: true` 取历史版（副本行 `_id` = `<personKey>#<generatedAt>`）；
 * 当前版不传，让云函数点查 `_id = personKey`。
 */
export async function fetchMemberSections(opts: {
  personKey: string
  generatedAt: string
  version?: boolean
}): Promise<MemberSectionsOutcome> {
  const personKey = String(opts?.personKey ?? '').trim()
  const generatedAt = String(opts?.generatedAt ?? '').trim()
  const version = opts?.version === true
  /* 没有配对键就不要问：云函数拿到空的 generatedAt 只能返回当前版，那是错配的来源 */
  if (!personKey || !generatedAt) return { ok: false, reason: 'failed' }

  const key = `${personKey}#${generatedAt}#${version ? 'v' : 'c'}`
  const hit = replyCache.get(key)
  if (hit) return hit

  let raw: unknown
  try {
    raw = await callCloudFunction('aiProxy', {
      action: 'report',
      op: 'member',
      personKey,
      generatedAt,
      ...(version ? { version: generatedAt } : {})
    })
  } catch (err) {
    diagLog('warn', 'db', `会员段读口调用失败：${err instanceof Error ? err.message : String(err)}`)
    return finish(key, { ok: false, reason: 'failed' }, { personKey, version })
  }

  const reply = (raw && typeof raw === 'object' ? raw : {}) as {
    ok?: boolean
    kind?: string
    result?: string
    generated_at?: string
    sections?: unknown
  }
  if (reply.ok === false) {
    const reason: MemberSectionReason =
      reply.kind === 'auth' ? 'auth' : reply.kind === 'abuse' ? 'abuse' : 'failed'
    /* `auth` 是正常路径（端上调用方判断失误或会员刚过期），只记诊断不当作故障 */
    return finish(key, { ok: false, reason }, { personKey, version })
  }
  if (reply.result === 'empty' || reply.result === 'mismatch') {
    return finish(key, { ok: false, reason: reply.result }, { personKey, version })
  }
  if (reply.result !== 'ok') {
    /* 云函数改了返回约定（或中间层吞了字段）：当成拿不到，但要在诊断里留下痕迹 */
    diagLog('warn', 'db', `会员段读口返回了无法识别的结果：${String(reply.result)}`)
    return finish(key, { ok: false, reason: 'failed' }, { personKey, version })
  }
  /* 端上再核一次配对：交回来的时间戳必须与手里这份报告逐字相等 */
  if (String(reply.generated_at ?? '') !== generatedAt) {
    return finish(key, { ok: false, reason: 'mismatch' }, { personKey, version })
  }
  const sections = pickSections(reply.sections)
  if (!sections || !hasMemberContent(sections as MemberFielded)) {
    /* 云端说 ok 但四段全是空壳：按「没有」处理，别把空数组当会员内容塞进正文 */
    return finish(key, { ok: false, reason: 'empty' }, { personKey, version })
  }
  return finish(key, { ok: true, reason: 'ok', sections }, { personKey, version })
}

/**
 * 给一份报告补上会员段，返回**新的**报告对象（补不上返回 null）。
 *
 * ⚠ 必须返回新对象、绝不能就地 `Object.assign(report, sections)`：
 * `report` 可能是缓存里那一份的引用（`cache.ts` 的读口直接把行里的对象交出去），
 * 就地写等于把会员段留在了缓存里 —— 下一位免费读者会拿到同一份对象。
 */
export async function patchMemberSections(
  report: Report | null | undefined,
  kind: 'current' | 'version' = 'current'
): Promise<Report | null> {
  if (!report || !report.personKey || !report.generatedAt) return null
  if (!hasStrippedMember(report)) return null
  const out = await fetchMemberSections({
    personKey: report.personKey,
    generatedAt: report.generatedAt,
    version: kind === 'version'
  })
  if (!out.ok || !out.sections) return null
  return { ...report, ...out.sections } as Report
}

/** 仅测试用：清空结论缓存（生产路径靠 `generatedAt` 变化自然失效） */
export function __clearMemberSectionsCache(): void {
  replyCache.clear()
}
