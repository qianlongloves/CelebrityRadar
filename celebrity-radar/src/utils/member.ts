import Taro from '@tarojs/taro'
import { readSelf } from './auth'
import { diagLog } from './cloud-diagnostics'
import { MEMBER_OVERRIDE } from './debug'

/**
 * 会员权益层 —— **付费功能唯一的判定入口**。
 *
 * 为什么单独一层：会员判定原本散在配额闸门、配额卡、周报页里，每加一项权益就多一处
 * `expires_at` 比较，改策略要满仓追着改。现在「谁、能用多少」只在本文件写一次，
 * 页面与闸门都从这里取数。
 *
 * 与相邻两层的分工（互不越界）：
 *   - 本文件：**权益**（会员能不能用、用多少）—— 端上读 `users.membership`（**镜像**）
 *   - utils/pay.ts：**价格与购买**（多少钱、买多久）—— 权威在云函数 payCreate
 *   - utils/quota.ts：**计数**（今天已经用了多少）—— 权威在云函数 quotaGuard
 *
 * 可信性（2026-10-09 起）：真权威在 `memberships`（客户端完全不可读写），云端
 * （aiProxy / quotaGuard）一律读它；本文件读的 `users.membership` 是**界面镜像**，
 * 「仅创建者可读写」⇒ 改包者能改自己那一行，故**它只决定界面显示，不决定任何一次付费调用**。
 * 两处由 payCallback 一次写入、内容必须一致（用例 06 钉住）。
 * 镜像存在的唯一理由：端上所有界面都读它，于是这次搬迁对端上零改动。
 * 判定用本机时间，改设备时间最多影响「自己看到的界面」，不影响订单、发货与云端闸门。
 * 权益表数值与云端 quota.config.js 必须同值（用例 07 钉住），改这里要同步改那份。
 */

/** 会员权益表：数值即策略本身，改这里即改策略（端上唯一事实源） */
export const MEMBER_BENEFITS = {
  /**
   * 每日「主动生成报告 / 周报」次数上限（两者共用同一池计数）。
   * 只管主动生成：缓存命中的报告不计数，浏览已生成报告两种版本都不限次。
   */
  generatePerDay: { free: 3, member: 30 },

  /**
   * 每日「AI 提问」次数上限（与生成**不同池**：提问不吃生成额度，见 utils/qa.ts）。
   *
   * 免费额度比生成给得大方（生成一次要等 30 秒，提问只是追问），但必须设上限：
   * 每次提问都是一次真实的付费模型请求，同时这也是会员最有体感的一条权益。
   */
  askPerDay: { free: 5, member: 30 }

  /*
   * 2026-10-08 撤销：原 O-19 的 `hotBoardShown: { free: 6, member: 24 }` 已删除，热门榜
   * **全员可见全部位数**。撤销理由：热门榜是全项目唯一「不需要等待」的内容（静态种子 +
   * 每日 AI 榜，首屏零成本），它同时也是 FREE_FEATURES_NOTE 里那句「不买也能用」的样板；
   * 在用户最先看到的位置先撞一次付费墙，换来的转化远不抵「这也要钱」的印象损耗。
   * 若日后要恢复分档，须同时改三处：本表、`pages/index`（预览位数与底部那一行）、
   * `pages/member` 的权益对比表 —— 少改一处就会出现「说不分档但其实只给 6 位」。
   */
} as const

/** 免费版：每日主动生成次数 */
export const FREE_DAILY_GENERATE_LIMIT = MEMBER_BENEFITS.generatePerDay.free

/** 会员：每日主动生成次数 */
export const MEMBER_DAILY_GENERATE_LIMIT = MEMBER_BENEFITS.generatePerDay.member

/** 免费版：每日 AI 提问次数 */
export const FREE_DAILY_ASK_LIMIT = MEMBER_BENEFITS.askPerDay.free

/** 会员：每日 AI 提问次数 */
export const MEMBER_DAILY_ASK_LIMIT = MEMBER_BENEFITS.askPerDay.member

/**
 * 权益说明（会员入口与配额卡展示）。
 * ⚠ 与 MEMBER_BENEFITS 一一对应：改表必须同步改这里，否则页面承诺与实际额度不符。
 * 首条「标准版 / 深度推理模型」不对应本文件的数字，而对应 publicConfig.llm.providers 里各家的
 * memberOnly 列（端上锁 + 云函数 aiProxy 校验）。档位标签三家统一（极速版 / 标准版 / 深度推理），
 * 故文案不必随供应商增删而改；但改了 memberOnly 列要回来对一遍文案。
 */
export const MEMBER_BENEFIT_POINTS: Array<{ title: string; note: string }> = [
  {
    title: '标准版 / 深度推理模型',
    note: '免费版只能用「极速版」；会员可切到标准版与深度推理，长文更完整、推理更强（生成时由服务端校验）'
  },
  {
    /*
     * 深度模式（O-11）：与上一行同属「质」，差别是它改的是**报告本身**而不是模型档位 ——
     * 素材检索加厚（utils/search.ts 的 DEEP_*）＋ 报告多出「对比视角 / 风险提示 / 信源分歧」
     * （utils/report.ts 的 MEMBER_HINT_REALTIME）。这些都发生在同一次生成里，
     * 不额外消耗额度，故文案里不写次数、也不写具体条数（条数随检索策略调整，写死会漂）。
     */
    title: '报告「深度模式」',
    note: '会员生成时检索加厚（主线与社交支线各加一档），并多出「对比视角 / 风险提示 / 信源分歧」三段专享内容'
  },
  {
    title: `每日主动生成 ${MEMBER_DAILY_GENERATE_LIMIT} 次`,
    note: `免费版每日 ${FREE_DAILY_GENERATE_LIMIT} 次；生成失败与缓存命中都不计数，只有真拿到报告才 +1`
  },
  {
    title: `每日 AI 提问 ${MEMBER_DAILY_ASK_LIMIT} 次`,
    note: `就某位名人的报告继续追问，不消耗生成额度；免费版每日 ${FREE_DAILY_ASK_LIMIT} 次`
  },
  {
    /*
     * 2026-10-08 起热门榜不再列入权益（原「热门榜看全部 24 位」一条已删除）：榜单全员可见
     * 全部位数，免费用户也一样 —— 少一条卖点，但少得诚实（见 MEMBER_BENEFITS 上方那条撤销说明）。
     */
    title: '时长按天顺延叠加',
    note: '到期前续费不会清空剩余天数，服务端按购买天数在有效期上继续累加'
  }
]

/**
 * 会员之外**免费开放**的能力（会员卡下方一行说明用）。
 *
 * 写在这里而不是散在页面里：这句话是「不买也能用」的承诺，
 * 与 MEMBER_BENEFIT_POINTS 一样必须与真实行为一致（改了功能要回来改这里）。
 * ⚠ AI 问答**不在**此列：它现在有独立的每日额度（免费版也有，但有限），
 * 写进「不限次」会与闸门行为矛盾。
 */
export const FREE_FEATURES_NOTE = '浏览已生成报告、关注 / 收藏 / 历史、热门榜均免费开放，不限次'

/** users.membership 的结构（唯一写入方是云函数 payCallback，端上只读） */
export type Membership = { plan: string; expires_at: string; last_order_id?: string }

export interface MemberState {
  /** 会员是否生效中 */
  member: boolean
  /** 生效中的套餐 id；非会员为 null */
  plan: string | null
  /** 到期时间（ISO）；非会员为 null */
  expiresAt: string | null
  /** 距到期天数（向上取整，到期当天为 1）；非会员 / 无有效期 = -1 */
  daysLeft: number
}

/** 非会员状态（读库失败与「确实没买」共用同一出口，避免多处手写对象） */
const NOT_MEMBER: MemberState = { member: false, plan: null, expiresAt: null, daysLeft: -1 }

/**
 * 会员判定：`expires_at` 未过期即有效。
 * 不校验 plan（套餐只决定天数，有效期才是唯一事实）。
 */
export function isMembershipActive(
  m: { plan?: string; expires_at?: string } | null | undefined
): boolean {
  if (!m?.expires_at) return false
  const t = Date.parse(m.expires_at)
  return Number.isFinite(t) && t > Date.now()
}

/** 距到期天数（向上取整，到期当天为 1）；无有效期或已过期返回 -1 */
function daysUntil(expiresAt: string | null): number {
  if (!expiresAt) return -1
  const t = Date.parse(expiresAt)
  if (!Number.isFinite(t)) return -1
  const left = t - Date.now()
  return left > 0 ? Math.ceil(left / 86400000) : -1
}

/** 调试覆写表：键与云函数 payCreate 的 PLANS id 同名（月度 / 季度 / 年度），值是套餐天数 */
const OVERRIDE_PLAN_DAYS: Record<string, number> = { monthly: 30, quarterly: 90, annual: 365 }

/**
 * 本地调试用的会员身份覆写（开关见 `config/local.ts` 的 `debug.memberOverride`）。
 * 返回 `null` = 不覆写，由调用方按云端真实发货结果判定。
 *
 * 为什么贴在这个入口做：端上「谁是会员」只有 readMemberState 一个读口（配额上限、
 * 专享段剥离、报告页促销条、会员中心都从它取数），覆写贴着它做就不会出现
 * 「配额认定是会员、报告页认定是免费」这种半生效状态 —— 那比不覆写更难排查。
 *
 * ⚠ 它**不写数据库**：`users.membership` 仍然只由 payCallback 写（见文件头），
 *   这里改的只是本机判定结果，**云端一概不认**；能测与不能测的清单见 local.example.ts。
 *   配错值（类型上不会，运行时兜一层）按「不覆写」处理 —— 宁可测不出会员，
 *   也不要把人卡在一个不存在的档位上。
 */
export function forcedMemberState(): MemberState | null {
  if (MEMBER_OVERRIDE === 'off') return null
  if (MEMBER_OVERRIDE === 'free') return NOT_MEMBER
  const days = OVERRIDE_PLAN_DAYS[MEMBER_OVERRIDE] ?? 0
  if (days <= 0) return null
  return {
    member: true,
    plan: MEMBER_OVERRIDE,
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
    daysLeft: days
  }
}

/** 读会员状态。读库失败按**非会员**处理（保守，不放大免费额度） */
export async function readMemberState(): Promise<MemberState> {
  /* 调试覆写必须**先于**真实判定（仅本地开关非 off 时命中，见上方）：
     放在读库之前，既省一次库读，也让「强制免费」能盖住真实会员身份 —— 否则
     真实是会员的账号测不出免费档。它不做任何 I/O，不会抛错。 */
  const forced = forcedMemberState()
  if (forced) return forced
  try {
    const m = (await readSelf())?.membership ?? null
    if (!isMembershipActive(m)) return NOT_MEMBER
    return {
      member: true,
      plan: m?.plan ?? null,
      expiresAt: m?.expires_at ?? null,
      daysLeft: daysUntil(m?.expires_at ?? null)
    }
  } catch (err) {
    diagLog(
      'warn',
      'db',
      `会员状态读取失败，按免费版处理：${err instanceof Error ? err.message : String(err)}`
    )
    return NOT_MEMBER
  }
}

/** 当前生效的每日生成上限（页面上限展示与闸门判定同源，不会各说各话） */
export function dailyGenerateLimit(member: boolean): number {
  return member ? MEMBER_DAILY_GENERATE_LIMIT : FREE_DAILY_GENERATE_LIMIT
}

/**
 * 额度用尽的提示文案（报告与周报共用）。
 *
 * 免费版顺带给一句升级路径：这是付费转化最直接的触点 —— 用户刚尝到「生成」的价值就被拦，
 * 此时只说「明日恢复」等于把人推走；会员自身用完就不再推销（没有更高档位可卖）。
 * `tail` 是各功能自己的补充（已生成的内容仍可看），保证两处口径一致而不是各写一套。
 */
export function quotaExhaustedMessage(member: boolean, limit: number, tail: string): string {
  const head = `今日报告生成额度已用完（${member ? '会员' : '免费版'}每日 ${limit} 次），明日 0 点恢复`
  const upsell = member ? '' : `；开通会员可提到每日 ${MEMBER_DAILY_GENERATE_LIMIT} 次`
  return `${head}${upsell}；${tail}`
}

/** 当前生效的每日提问上限（页面上限展示与问答闸门同源，不会各说各话） */
export function dailyAskLimit(member: boolean): number {
  return member ? MEMBER_DAILY_ASK_LIMIT : FREE_DAILY_ASK_LIMIT
}

/**
 * 提问额度用尽的提示文案。
 *
 * 与 quotaExhaustedMessage 同一取舍：免费版顺带给出升级路径 —— 提问是全流程里
 * 最容易立刻体会到价值的一步（问一句就有回答），此时说「开通会员可提到每日 N 次」
 * 比在报告生成被拦时更有说服力；会员自身用完不再推销（没有更高档位可卖）。
 */
export function askQuotaExhaustedMessage(member: boolean, limit: number): string {
  const head = `今日提问次数已用完（${member ? '会员' : '免费版'}每日 ${limit} 次），明日 0 点恢复`
  const upsell = member ? '' : `；开通会员可提到每日 ${MEMBER_DAILY_ASK_LIMIT} 次`
  return `${head}${upsell}；已生成的报告仍可正常浏览`
}

/* ============ 报告页：会员促销条（O-21 立起 / O-25 收敛为只服务免费用户） ============
 *
 * 深度模式的权益（检索加厚 + 三段专享内容）此前只在两处可见：会员中心的对比表一行，
 * 以及**会员**在报告页滑到最底部才遇到的那张卡。免费用户看报告时对「会员能多得到什么」
 * 完全没有画面，且报告是全局共享缓存 —— 他读到的很可能就是会员生成的那一份，
 * 三段内容此刻就在页面里被藏起来，页面上却没有任何一行字解释这件事。
 * 于是把权益提到报告页顶部（横幅正下方）：
 *   · 免费用户：说清「这份报告里有什么你看不到」/「会员生成会多出什么」，给一个入口；
 *   · 会员：确认权益已经生效（买了的东西真的在这份报告里），一句话可跳到那三段。
 *
 * 文案与判定写在这里（纯函数），页面只负责样式与跳转：
 * 「哪些段落算专享」这类口径一旦散进页面，增删一段就会有一处对不上。
 *
 * O-25 收敛：上面「· 会员：确认权益已经生效」那半句**已从本文件移出** ——
 * 会员态整条不渲染，确认交给专享卡标题上的「已生效」标记；本文件只剩免费态文案，
 * 见下方 reportMemberPromo 上方的说明。
 */

/** 会员专享段落名：顺序即报告页卡片里的渲染顺序，也是促销条措辞的唯一来源 */
export const MEMBER_SECTIONS = ['对比视角', '风险提示', '信源分歧'] as const

/** 报告里**实际**存在的专享段落（顺序固定，缺的跳过；空串按不存在处理） */
export function presentSections(
  report:
    | {
        memberNotes?: { compare?: string; risk?: string }
        conflicts?: Array<{ topic?: string }>
      }
    | null
    | undefined
): string[] {
  const present: string[] = []
  if (report?.memberNotes?.compare) present.push(MEMBER_SECTIONS[0])
  if (report?.memberNotes?.risk) present.push(MEMBER_SECTIONS[1])
  if (report?.conflicts && report.conflicts.length > 0) present.push(MEMBER_SECTIONS[2])
  return present
}

/**
 * 非会员读到的报告：把会员专属段落**从数据里摘掉**，而不是靠 UI 不渲染（批 1，2026-10-09）。
 *
 * 为什么要下沉到数据层：此前只有报告页卡片与目录两处判会员态，而报告是全局共享缓存 ——
 * 会员生成的那一份带着三段内容，免费用户拿到的 Report 对象里**原样带着**它们，只是页面不画。
 * 口径散在页面上的后果是：任何新增的消费方（AI 问答把报告当上下文、以后的分享 / 导出）
 * 只要忘了判会员态，就等于把付费内容送出去 —— 而「忘了判」不会有任何报错提示。
 *
 * ⚠ 端上直连云数据库，改包 / 抓包本就能拿到原文，本函数**不是安全防线**：
 *   它的价值是让「非会员拿到的对象里没有会员段」成为不变式，UI 侧从此不必再各自判一次。
 *
 * 无会员段落时**返回原对象**（引用相等）：绝大多数报告走这条，不产生拷贝、不读任何库 ——
 * 这是调用方可以放心到处调它的前提（见 utils/cache.ts#exposeReport 的快路径）。
 */
export function stripMemberSections<
  T extends { memberNotes?: { compare?: string; risk?: string }; conflicts?: Array<{ topic?: string }> }
>(report: T): T {
  if (presentSections(report).length === 0) return report
  const copy: T = { ...report }
  delete copy.memberNotes
  delete copy.conflicts
  return copy
}

export interface ReportMemberPromo {
  /** 主文案（页面按**单行**渲染，超长由样式省略 —— 故长度有预算，改文案要跑对应用例） */
  text: string
  /** 右侧动作文案（免费态唯一动作：去会员中心） */
  action: '开通会员' | '了解会员'
}

/**
 * 报告页顶部**促销条**的文案（纯函数）。
 *
 * ⚠ **只服务免费用户**。O-21 时它还是四态（会员 / 免费 × 报告有 / 无专享段落），
 * 会员态那两句是「权益生效的确认」；O-25 起页面在 `member` 为真时**整条不渲染** ——
 * 买过的人不需要再看一遍卖点，那份确认改由专享卡标题上的「已生效」标记承担
 * （那是内容的一部分，不是宣传，因此也不该由本文件的文案函数来管）。
 *
 * 参数里的 `member` 随之**删除**而不是在函数里返回空值：让「不存在会员文案」这件事
 * 写在签名上，下一个人就不会顺手再给会员补一句。
 *
 * 留下的两个免费态仍必须说真话：
 *   · 报告里**确实有**专享段 → 点名那几段。报告是全局共享缓存，开通后真的看得见，
 *     这是可兑现的承诺，比笼统的「会员可解锁更多」有力得多；
 *   · 没有（免费生成 / 老缓存）→ 只能讲会员生成时会多出什么，**不承诺当前这一份**。
 *
 * 文案有长度预算：条子是**单行**的（换行就退回两行高度，等于白改瘦身），
 * 故段落之间用顿号而非「 / 」、不写「这份报告」这类可省的主语（主语由左侧「会员专享」小标承担）。
 */
export function reportMemberPromo(present: string[]): ReportMemberPromo {
  return present.length > 0
    ? { text: `已含${present.join('、')}`, action: '开通会员' }
    : { text: '会员生成会加厚检索，并多出专享解析', action: '了解会员' }
}

/* ------------- 促销条的展示策略（O-26）：可关闭 + 随机展示 ------------- */

/**
 * 「用户已经手动关掉促销条」的本机记忆键位（只存一个布尔值）。
 *
 * 关闭是**全局**的，不是「这一份报告不看」：按报告逐份重新出现等于没关，
 * 用户点第二次 × 时的感受是「这东西关不掉」。
 */
const PROMO_DISMISS_KEY = 'member:promo_dismissed'

/**
 * 免费用户**看到**促销条的概率，按「这份报告里有没有专享段」分两档。
 *
 * 为什么要随机：它是广告，天天挂在报告顶部，读久了就变成背景噪音 ——
 * 用户不是被说服，而是学会无视它，顺带连报告页其它说明一起无视掉。
 * 降频之后每次出现都还值得看一眼，比 100% 出现但没人读更划算。
 *
 * 为什么分两档：两个免费态的性质不同 ——
 *   · 有专享段（OFFER）：这是**服务性说明**（你在读一份被裁剪过的报告，
 *     而且开通后真的看得见那几段），说清楚对用户有实际价值，故概率给高；
 *   · 无专享段（RATE）：纯招揽 —— 此刻没有任何东西被藏起来，偶尔提一次就够。
 */
export const PROMO_SHOW_RATE_OFFER = 0.7
export const PROMO_SHOW_RATE = 0.3

/**
 * 掷骰子：这一份报告要不要出促销条（纯函数，`rand` 可注入以便用例复现）。
 *
 * 调用方必须**一次访问只掷一次**（见 pages/report 的 `promoRolled` ref）：
 * 每次渲染都重掷的话，条子会随机闪现 / 消失，看起来像渲染 bug。
 */
export function promoRoll(present: string[], rand: () => number = Math.random): boolean {
  return rand() < (present.length > 0 ? PROMO_SHOW_RATE_OFFER : PROMO_SHOW_RATE)
}

/** 用户是否已经手动关掉促销条（本机记忆，与账号无关） */
export function isPromoDismissed(): boolean {
  return Taro.getStorageSync<boolean>(PROMO_DISMISS_KEY) === true
}

/** 关闭促销条：本机记住，此后不再出现（「清空我的数据」会一并清掉） */
export function dismissPromo(): void {
  Taro.setStorageSync(PROMO_DISMISS_KEY, true)
}

/**
 * 清掉关闭记忆（供 utils/settings.ts#clearLocalSettings 调用）。
 * 单独导出而不是在两处各写一遍键名 —— 键名散开，早晚有一处忘记改。
 */
export function clearPromoDismiss(): void {
  Taro.removeStorageSync(PROMO_DISMISS_KEY)
}
