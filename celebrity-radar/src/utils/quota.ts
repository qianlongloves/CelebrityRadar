import Taro from '@tarojs/taro'
import { table } from './db'
import { todayKey } from './time'
import { diagLog } from './cloud-diagnostics'
import { incrQuotaViaCloud } from './quota-guard'
import type { QuotaWaiveOptions } from './quota-guard'
import { GENERATE_QUOTA_DISABLED } from './debug'
import {
  FREE_DAILY_GENERATE_LIMIT,
  MEMBER_DAILY_GENERATE_LIMIT,
  dailyGenerateLimit,
  isMembershipActive,
  readMemberState
} from './member'
import type { GenerateQuotaRow } from '@/types/db'

/**
 * 报告生成配额（freemium 计费的免费层闸门，设计口径见 README § 计费）。
 *
 * 本文件只管**计数**；「谁该有多少额度」在 utils/member.ts（权益层），
 * 本文件所有限额都从那里取，不再自行判断会员状态或写死数字。
 *
 * 计费口径（与冷却、缓存严格区分，三者各管一件事）：
 *   - 冷却（cooldown.ts）：上游限流保护，拦「短时间重试风暴」；
 *   - 缓存（cache.ts）：同一人物全局只生成一次，命中零成本；
 *   - 配额（本文件）：拦「用户主动发起的真实生成」，按账号按日计数。
 *
 * 公平性原则：只对「成功拿到报告」的生成计数——
 *   缓存命中不计数（零成本）、生成失败不计数（用户没拿到东西）、
 *   LLM 拒答不计数（合规拦截不是用户过错）、
 *   「只升不降」拦下的刷新也不计数（交回的是缓存里更完整的那一版，用户没拿到新东西）。
 *   上游成本损失由冷却兜底。
 *
 * 会员「补齐」免计费（2026-10-09）：缓存里那版还不含会员段落时，会员这次生成实际是把
 * 共享缓存从免费档升到会员档，产出归全站所有，故不该扣他的每日次数。端上只**申请**，
 * 复核在云函数 `quotaGuard`（会员是否生效 + 那一行是否真的缺会员段落），复核不过照常计数。
 *
 * 计数已服务端化：优先走云函数 `quotaGuard` 原子自增（并发不丢数、日期取服务端、
 * 不可被改包篡改）；函数未部署时静默回退端上读-改-写。
 *
 * 会员链路：`users.membership` 只由云函数 `payCallback`（微信支付结果通知）写入，
 * 端上永不写该字段。下单链路见 utils/pay.ts；**未部署支付云函数 / 未配商户号时
 * 运行时恒为免费版**（`payCreate` 会返回 kind:'unconfigured'），不影响免费功能。
 */

/*
 * 兼容出口：限额常量与会员判定的**定义**已上移到权益层 utils/member.ts，
 * 这里只是把旧名字继续转出，既有引用（页面 / 周报 / 收藏）无需跟着改。
 */
export { FREE_DAILY_GENERATE_LIMIT, MEMBER_DAILY_GENERATE_LIMIT, isMembershipActive }

export interface GenerateQuotaSummary {
  /** 今日已成功生成次数 */
  used: number
  /** 今日上限（会员/免费版不同，取自 utils/member.ts 的权益表） */
  limit: number
  /**
   * 剩余可发起次数 —— **照实相减，不因调试开关而报满额**。
   *
   * 它与 `allowed` 分开，正是这个字段存在的意义：两者在正常态同进同退，但调试开关
   * （见 utils/debug.ts）只该松开**闸门**、不改**数字** —— 计数照常自增（那是排查时
   * 最直接的证据），展示就该跟着动。合成一个数字只剩两种写法，且两种都撒谎：
   *   · 照实相减（现写法）→ 开挂时显示「剩余 0 次」却仍能一直生成（自相矛盾）；
   *   · 报满额（旧写法）→ 数字永远停在满额，等于「生成次数没有计数」。
   * 「还能不能生成」交给 `allowed` / `unlimited`，数字本身始终真实。
   * 这套拆分照搬提问侧 utils/qa.ts#QaUsage —— 那边已踩过同一个坑（见其注释）。
   */
  remaining: number
  /** 是否还能发起生成（正常态 = 剩余 > 0；调试开关放开时恒为 true） */
  allowed: boolean
  /** 会员是否生效中 */
  member: boolean
  /** 会员到期时间（ISO；非会员为 null），「我的」页展示有效期用 */
  expiresAt: string | null
  /** 距到期天数（向上取整；非会员 -1），会员卡展示「还剩几天」用 */
  daysLeft: number
  /**
   * 调试开关是否放开了生成额度（`config/public.ts` 的 `debug.disableGenerateQuota`）。
   *
   * 展示方据此**改写措辞、而不是改写数字**：开挂态要与真实用户所见逐字一致
   * （见 utils/debug.ts 的上线口径），所以不能报假数字；但「今日剩余 N 次」这句话在
   * 开挂时已经不成立，此时只说「将消耗 1 次生成次数」就够 —— 与提问侧 qa-panel 的
   * `!usage.unlimited` 是同一处理（那边开挂时不弹升级条）。
   */
  unlimited: boolean
}

async function readCount(userId: string): Promise<number> {
  const id = `${userId}#${todayKey()}`
  const { data, error } = await table('generate_quota').select('*').eq('id', id).maybeSingle()
  if (error) diagLog('warn', 'db', `generate_quota 读取失败：${error.message ?? error}`)
  return (data as GenerateQuotaRow | null)?.count ?? 0
}

/* ------------------------------------------------- 未上报计数（2026-10-18） */

/**
 * 云函数写失败时，这一次**已经成立的消费**先记在本机，下次能连上云端时一并补报。
 *
 * 为什么必须记：`generate_quota` 的权限是 selfRead（本人可读、**客户端不可写**），
 * 旧回退路径「函数没响应就自己 insert/update」根本写不进去 —— 权限拒绝只进 diagLog，
 * 用户看到的就是「报告生成了，额度一直不涨」，且能一直生成下去。
 *
 * 语义边界（都是刻意选的）：
 *   · 按天记：云端那一行 `_id` 带日期，跨了天就没有可补的那一行，静默丢弃（宁可漏一天，
 *     也不把昨天的账压到今天）；
 *   · 只补**普通计数**，不补免计费：有待补账时本次不再申请 waive —— 一次调用里
 *     「豁免一次 + 补 N 次」两个语义纠缠不清，宁可多算；
 *   · 方向永远「宁可多算」：云端其实写成功、只是回包丢了，补报就会多算一次。
 */
const PENDING_KEY = 'generate_pending'

/** 一条欠账：[日期, 次数] —— 同一天内累加；换天即作废 */
interface PendingEntry {
  day: string
  count: number
}

function pendingKey(userId: string): string {
  return `${PENDING_KEY}#${userId}`
}

/** 本机欠账（0 = 没有）。读的时候顺手把跨天的作废，理由见上 */
function readPending(userId: string): number {
  try {
    const raw = Taro.getStorageSync(pendingKey(userId)) as PendingEntry | ''
    if (!raw || typeof raw !== 'object') return 0
    if (raw.day !== todayKey()) {
      Taro.removeStorageSync(pendingKey(userId))
      return 0
    }
    return typeof raw.count === 'number' && raw.count > 0 ? Math.floor(raw.count) : 0
  } catch {
    return 0
  }
}

function writePending(userId: string, count: number): void {
  try {
    if (count <= 0) Taro.removeStorageSync(pendingKey(userId))
    else Taro.setStorageSync(pendingKey(userId), { day: todayKey(), count } as PendingEntry)
  } catch {
    /* 静默：写失败最坏是回到「漏这一次」，不影响已经生成的报告 */
  }
}

/* ------------------------------------------------- 在途占位（P1，2026-10-11） */

/**
 * 「已通过闸门、还没有结束」的生成占位，按 userId 记在本机 storage。
 *
 * 解决什么：闸门天然是**先查后做** —— peek 在生成前、consume 在落库后，中间隔着几十秒的上游调用。
 * 同一用户在窗口里对**两个不同人物**各发起一次生成时，两次 peek 看到的是同一个 used，于是双双放行，
 * 免费额度被一次性突破（报告页返回后立刻查另一个人、或两个页面并发，都会命中）。
 * 抢锁拦不住它 —— 那是按 personKey 的，两个不同人物本来就是两把锁。
 *
 * 做法：闸门通过时记一笔占位，peek 把未过期的占位数一起算进 `remaining`。
 * 撤销有两条路，**都不需要调用方显式收尾**：
 *   ① 计费推进即失效：占位带着「记录时的 used」，之后只要读到的 used 超过了它，
 *      说明这一次已经真的计过数（或已被别的计数覆盖），占位即冗余 —— 读时剪掉；
 *   ② 过期即失效：TTL 由调用方给（cache.ts 传 INFLIGHT_TTL_MS = 180s，**刻意短于锁上界**），
 *      构建者进程被杀时不会留下一笔永久占位把用户挡在门外。此前传的是锁上界（1125s），
 *      一次失败就把名额冻结近 19 分钟 —— 占位只需要覆盖一次正常生成的窗口，不需要覆盖
 *      「构建可能还在跑」的悲观上界。
 * 副作用的方向是刻意选的：漏剪只会**少占**一个名额（回到老行为），绝不会**误挡**一个真实可用的名额。
 *
 * ⚠ 边界（如实记录）：
 *   · 挡得住：同设备并发（连点、多入口、后台构建期间又查另一个人）—— 实际会发生的形态；
 *   · 挡不住：跨设备并发（两台手机同时点）。那需要云端原子「预留 + 退还」，
 *     代价是云端要新增动作、并接受「进程被杀时预留无法退还」，属于产品级取舍，未实施。
 *   · 它**不参与计费**：`used` 始终是服务端的真实计数，占位只进 `remaining` / `allowed` 的判定。
 */
const INFLIGHT_KEY = 'generate_inflight'

/** 一条占位：[人物, 过期时间戳, 记录时的已用次数] */
type InflightEntry = [string, number, number]

function readInflight(userId: string, used: number): InflightEntry[] {
  try {
    const raw = Taro.getStorageSync(`${INFLIGHT_KEY}#${userId}`)
    const list = Array.isArray(raw) ? (raw as InflightEntry[]) : []
    const now = Date.now()
    /* 读时就地剪（没有定时器，读是唯一的清理时机）：过期项 + 计费已推进的项，理由见上方 ①② */
    return list.filter(
      (it) =>
        Array.isArray(it) &&
        typeof it[1] === 'number' &&
        typeof it[2] === 'number' &&
        it[1] > now &&
        it[2] >= used
    )
  } catch {
    return []
  }
}

/** 记一笔在途生成（闸门通过后立刻调用）。ttlMs 由调用方给，避免第二个「构建耗时」常量各自漂移 */
export function beginGenerateInflight(
  userId: string,
  personKey: string,
  ttlMs: number,
  usedAtBegin: number
): void {
  try {
    const key = `${INFLIGHT_KEY}#${userId}`
    const raw = Taro.getStorageSync(key)
    const list = (Array.isArray(raw) ? raw : []) as InflightEntry[]
    const now = Date.now()
    /*
     * 同一人物只留最后一条（2026-10-18）：同一个人连点 / 失败重试会 push 出好几条同 key 的占位，
     * remaining 一次掉 N —— 用户看到的是「次数被扣了，报告却没出来」，而它们其实只是同一个
     * 尚未落账的生成。换掉旧条目，而不是并列。
     */
    list.push([personKey, now + ttlMs, usedAtBegin])
    Taro.setStorageSync(
      key,
      list.filter(
        (it, i) =>
          Array.isArray(it) &&
          typeof it[1] === 'number' &&
          it[1] > now &&
          /* 同一人物只留刚 push 的最后一条 */
          (it[0] !== personKey || i === list.length - 1)
      )
    )
  } catch {
    /* 静默：占位只是闸门的加严项，写失败最坏是回到「可能被并发突破一次」的老行为 */
  }
}

/**
 * 查询配额（不消耗）：生成前的闸门检查 + 「我的」页展示共用。
 * 会员判定读 users 行失败时按免费版处理（保守，不放大免费额度）。
 */
export async function peekGenerateQuota(userId: string): Promise<GenerateQuotaSummary> {
  const state = await readMemberState()
  const limit = dailyGenerateLimit(state.member)
  /* 本机欠账算进「已用」：界面必须**先**如实 —— 云端没收到的那几次，不能等补报成功才显示 */
  const used = (await readCount(userId)) + readPending(userId)
  /*
   * 在途占位的基准必须和**写入时**一个口径：beginGenerateInflight 收到的就是 peek 的 used
   * （同样含本机欠账）。拿云端裸计数去比，会让「欠账还没上报」那段时窗口里的占位永远不失效，
   * 一个名额被重复占 —— 用满后还能多生成一次。
   */
  const realRemaining = Math.max(0, limit - used - readInflight(userId, used).length)
  return {
    used,
    limit,
    /*
     * 照实相减（理由见 GenerateQuotaSummary.remaining）。此前这里是
     * `GENERATE_QUOTA_DISABLED ? limit : realRemaining`，出发点是不想让页面出现
     * 「剩余 0 次却还能生成」；但代价是**报告页的确认弹窗会念出一个假的剩余次数** ——
     * 本机开挂时已生成多次，弹窗仍说「今日剩余 30/30」。两害相权：假数字是**静默**的错
     * （用户照着它做判断），而矛盾展示的来源看得见，且真机上开关恒为 false，这个矛盾
     * 根本不会出现。
     *
     * 另注（P1，2026-10-11）：realRemaining 还减掉了**在途占位**（见本文件「在途占位」一节）。
     * `remaining` 的口径是「还能再发起几次」——那笔在途生成已经过了闸门、必然要计数
     * （不达标或不落库时占位会自行失效），所以它必须先占住一个名额，否则同一个用户
     * 在两次 peek 之间就能用两个人物把额度突破掉。
     */
    remaining: realRemaining,
    allowed: GENERATE_QUOTA_DISABLED || realRemaining > 0,
    member: state.member,
    expiresAt: state.expiresAt,
    daysLeft: state.daysLeft,
    unlimited: GENERATE_QUOTA_DISABLED
  }
}

/**
 * 消耗一次配额：仅在生成成功落库后调用（best-effort，计数失败不影响已生成的报告）。
 *
 * 优先由云函数原子自增；不可用时**记本机欠账**，下次能连上云端时一并补报（见上一节）。
 * 「回退本地读-改-写」的老写法是假的：generate_quota 已收紧成 selfRead，端上写必被拒。
 *
 * waive（免计费申请，两种理由见 QuotaWaiveOptions）：他这一次生成产出的东西是替**全站**
 * 建的（写进共享缓存、之后所有人免费读），那笔账不该只由他掏每日次数。端上只**申请**，
 * 复核在云函数 quotaGuard（会员是否生效 / 目标那一行是否真的缺会员段 / 是否真是他首建的那一行）；
 * 复核不过就照常计数。
 * ⚠ 回退路径（函数未部署）**不认**这个申请 —— 端上无法自证身份，宁可多算一次，
 *   也不留下「改包即免次数」的口子（回退态本来就是过渡态，部署函数后即消除）。
 */
/** `consumeGenerateQuota` 的结果：够页面把这一次的账如实说清 */
export interface QuotaConsumeResult {
  /**
   * 云端确认「这一次没有计入次数」（首建豁免 / 会员补段豁免）。
   *
   * 2026-10-18 才敢把它交给页面：此前是 fire-and-forget，端上拿不到裁决，只能在注释里
   * 反复强调「不许承诺免计费」；现在 consume 是 await 的，云端回包里就带着 waived，
   * 页面可以照着事实说话，而不是让用户对着不变的额度自己猜。
   */
  waived: boolean
  /** 云端返回的当日已用次数；这一次没能上报到云端时为 null（已记本机欠账） */
  count: number | null
}

export async function consumeGenerateQuota(
  userId: string,
  waive?: QuotaWaiveOptions
): Promise<QuotaConsumeResult> {
  const pending = readPending(userId)
  /*
   * 有待补账时**不申请**免计费（理由见上一节）；extra 随同一次调用带回：
   * 云端一次原子加上 1 + pending，不必为补报再打一发。
   */
  const cloud = await incrQuotaViaCloud(
    'generate',
    waive && pending === 0 ? waive : undefined,
    pending
  )
  if (cloud !== null) {
    if (pending > 0) {
      writePending(userId, 0)
      diagLog('info', 'db', `补报 ${pending} 次此前未入账的生成`)
    }
    if (cloud.waived) {
      const reason = waive?.waiveIf === 'first_build' ? '首建共享缓存' : '会员补齐共享缓存'
      diagLog('info', 'db', `${reason}，本次生成不计入配额：${waive?.target ?? ''}`)
    }
    return { waived: cloud.waived === true, count: cloud.count }
  }

  /*
   * 云函数不可用：**不要**再去写 generate_quota —— 那是 selfRead 表，端上写必被拒。
   * 旧代码在这里 insert / update，失败只落一行 diagLog，用户看到的就是
   * 「报告生成了，额度一直不涨」，而且还能无限生成 —— 这正是这条回退路径的坑。
   * 现在记本机欠账：peek 立刻把它算进已用（界面如实），云端恢复后一次补报。
   */
  writePending(userId, pending + 1)
  diagLog('warn', 'db', `本次生成未计入云端额度，已记本机欠账 ${pending + 1} 次，云端恢复后补报`)
  return { waived: false, count: null }
}
