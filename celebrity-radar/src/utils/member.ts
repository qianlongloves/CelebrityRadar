import Taro from '@tarojs/taro'
import { readSelf } from './auth'
import { diagLog } from './cloud-diagnostics'
import { FREE_TOC_COUNT, MEMBER_TOC_COUNT, TEMPLATE_SIZE, memberOnlyTocLabels } from './report-toc'
import { MEMBER_BENEFITS, REPORT_PREVIEW } from '../config/benefits'

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
 * 权益数值的真源在 `config/benefits.ts` —— 在那里改一次，云端（aiProxy 的配额池、
 * quotaGuard 的刷新额度、payCreate 的价格）由 `npm run config:sync` 生成副本，
 * 端上就是下面这行 re-export。改额度 / 价格请改那一份，别再回来手抄：
 * 手抄漏了不会有任何报错，只会静默错（会员页说 30 次、实际拦在第 3 次）。
 * 本文件此后只负责**判定逻辑**（readMemberState / isMembershipActive）与展示文案。
 */

/** 会员权益表：数值即策略本身（真源见 config/benefits.ts，改那里即改策略） */
export { MEMBER_BENEFITS }

/** 免费版：每日主动生成次数 */
export const FREE_DAILY_GENERATE_LIMIT = MEMBER_BENEFITS.generatePerDay.free

/** 会员：每日主动生成次数 */
export const MEMBER_DAILY_GENERATE_LIMIT = MEMBER_BENEFITS.generatePerDay.member

/** 免费版：每日 AI 提问次数 */
export const FREE_DAILY_ASK_LIMIT = MEMBER_BENEFITS.askPerDay.free

/** 会员：每日 AI 提问次数 */
export const MEMBER_DAILY_ASK_LIMIT = MEMBER_BENEFITS.askPerDay.member

/**
 * 每日「抓取关注动态」次数上限（2026-10-10 起按档位分叉：免费 10 / 会员 20）。
 *
 * 消费方是 utils/cache.ts（那里原先自带一份 `const DAILY_REFRESH_LIMIT = 10`）：
 * 两个数字分开写迟早会漂，而漂了的表现是「会员页说 20 次、实际拦在 10 次」。
 *
 * ⚠ **判定权威在云函数 quotaGuard**（它读 memberships 后按档回报 `limit`）：
 *   下面两个常量与 dailyRefreshLimit() 只在「云函数不可用 / 旧版云函数不回 limit」时兜底 ——
 *   端上这份可被改包，拿它当闸门等于没有闸门。
 */
export const DAILY_REFRESH_LIMIT = MEMBER_BENEFITS.refreshPerDay.free

/** 会员档的每日抓取次数（会员页对比表与权益列表展示用；判定仍以云端回报为准） */
export const MEMBER_DAILY_REFRESH_LIMIT = MEMBER_BENEFITS.refreshPerDay.member

/** 按身份取当日抓取上限：端上只在云函数不可用时用它兜底（见上面的 ⚠） */
export function dailyRefreshLimit(isMember: boolean): number {
  return isMember ? MEMBER_BENEFITS.refreshPerDay.member : MEMBER_BENEFITS.refreshPerDay.free
}

/** 免费档「刷新最新」冷却窗口（小时）；会员不受限 */
export const FREE_REFRESH_COOLDOWN_HOURS = MEMBER_BENEFITS.freeRefreshCooldownHours

/**
 * 权益说明（会员入口与配额卡展示）。
 * ⚠ 与 MEMBER_BENEFITS 一一对应：改表必须同步改这里，否则页面承诺与实际额度不符。
 * 首条「标准版 / 高级版模型」不对应本文件的数字，而对应 publicConfig.llm.qualities 的
 * memberOnly 列（端上锁 + 云函数 aiProxy 校验）。质量档跨厂商同一套（基础版 / 标准版 / 高级版），
 * 故文案不必随厂商调整而改；但改了 memberOnly 列要回来对一遍文案。
 */
export const MEMBER_BENEFIT_POINTS: Array<{ title: string; note: string }> = [
  {
    title: '标准版 / 高级版模型',
    note: '免费版只能用各厂商「基础版」；会员可切到标准版与高级版，长文更完整、推理更强（生成时由服务端校验）'
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
    /*
     * 2026-10-10 新增（需求「把生成的报告模板纳入会员文字权益」）；
     * 2026-10-16 S3-3 扩写：报告的分档其实是**两个**杠杆，现在两个都写进这一条。
     *
     *   ① 看得到**哪几节** —— 免费档按模板只呈现 FREE_TOC_COUNT 节，会员是完整 TEMPLATE_SIZE 节；
     *   ② 每节**能看多少条** —— 免费档列表型的节最多 REPORT_PREVIEW.sectionRows.free 条
     *      （每处截断都当场注明「还有 N 条」），会员不截断。
     *
     * 只有①的时候，免费用户拿到的每一节都是**完整长度**，与会员的差别只剩「少几张卡」——
     * 而他压根不知道那几张卡本来存在，所以「免费 / 会员观感差异不明显」是必然的（S3-3 修的就是这个）。
     *
     * 数字与名单一律取自真源（节数与名单 → utils/report-toc.ts；每节条数 → config/benefits.ts），
     * **不在这里写死**：以后改档位，这条文案与会员页对比表会跟着变，不会各说各话。
     * 与上一条「深度模式」是两件事：那条讲**生成**多出三段专享文字，这条讲**呈现**。
     */
    title: `完整报告模板（${TEMPLATE_SIZE} 节）`,
    note: `免费版按模板只呈现 ${FREE_TOC_COUNT} 节、每节最多 ${REPORT_PREVIEW.sectionRows.free} 条；会员是完整 ${TEMPLATE_SIZE} 节且每节不截断，多出「${memberOnlyTocLabels().join(' / ')}」共 ${MEMBER_TOC_COUNT} 节`
  },
  {
    /*
     * 2026-10-16 新增（S3-1：付费点从「额度」转向「能力 / 容量 / 导出」）。
     *
     * 为什么必须在这里补上，而不是只做功能：**长图导出（2026-10-15）与周报图导出本来就是会员能力，
     * 却从来没写进任何一份权益表** —— 用户只在被拦的那一下才知道「原来导出要会员」。
     * 一句话概括这条新权益与前三条的区别：前三条讲「生成出来的东西有多好」（模型 / 内容 / 节数），
     * 这一条讲**你能不能把它带走**。也正因为如此，它**不随共享缓存变厚而贬值**：
     * 报告已经在库里，导出是纯本地组装（零上游成本、零等待、零额度），
     * 而额度是越用越不值钱的那一类（见 doc/产品优化路线图.md §6.4）。
     *
     * 不写任何数字：这条是**二元能力**，与长图 / 周报图两处门禁同一口径
     * （`report-card.ts#canExportReportCard`、`weekly-brief.ts#canExportWeeklyBrief`），
     * 故也不必在 config/benefits.ts 新增常量。
     */
    title: '把报告带走（导出）',
    note: '长图可保存 / 转发；Markdown 全文每条事实带出处、附完整来源清单，JSON 结构化数据可进文档与表格逐条核对'
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
     * 2026-10-10 新增：抓取关注动态从「两版同额」改成按档位分叉（免费 10 / 会员 20），
     * 它就从「成本闸门」变成了一条真实的权益差异，要在这里说出来 ——
     * 数字取自本文件上方的 refreshPerDay，不写死（改档位时这条文案跟着变）。
     */
    title: `每日抓取动态 ${MEMBER_DAILY_REFRESH_LIMIT} 次`,
    note: `免费版 ${DAILY_REFRESH_LIMIT} 次 / 日；单次刷新按「最久没更新」优先，覆盖你关注的一部分人`
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
 *
 * 2026-10-16（S3-1）补上**导出的边界**：原句只说「浏览…不限次」，容易被读成
 * 「报告里的东西随便带走」。实际上站内看免费、**带走是会员能力**（长图 / Markdown / JSON 三处同一口径）。
 * 免费用户点导出确实看得到入口（会给一行引导），如实把边界写在这里，比让他点一下才知道诚实。
 *
 * 2026-10-16（S3-3）再补上**阅读深度的边界**：S3-3 起免费档是「速览」——
 * 免费 11 节、每节最多 REPORT_PREVIEW.sectionRows.free 条（会员 18 节且不截断）。
 * 原句「浏览已生成报告…不限次」单看没错（确实不限次、不限人），但「看得到的是速览」
 * 必须写出来，否则这句会被读成「报告全文都能看」。
 * ⚠ 「不限次」说的是**次数**，不是**每节的条数**，两件事别混；
 * ⚠ 那个 3 取自 config/benefits.ts（不写死），改档位这句跟着变。
 */
export const FREE_FEATURES_NOTE = `浏览已生成报告（速览：节内最多 ${REPORT_PREVIEW.sectionRows.free} 条）、关注 / 收藏 / 历史、热门榜均免费开放，不限次；导出（长图 / Markdown / JSON）是会员能力`

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

/** 读会员状态。读库失败按**非会员**处理（保守，不放大免费额度） */
export async function readMemberState(): Promise<MemberState> {
  /*
   * 端上「谁是会员」**只有这一个进口**（2026-10-10 起）。这里曾贴过一个本地调试开关
   * （`debug.memberOverride`）：它让端上按会员走、云端却按 memberships 权威表判免费 ——
   * 表现是「切了会员档位没效果、加厚检索没效果」而界面毫无异常，原因与替代做法见
   * `config/local.example.ts` 的说明。现在来源只有一个：users.membership 镜像行，
   * 由 payCallback 与权威表 memberships 一次写入、内容一致（用例 06 钉住）。
   */
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

/** 报告里可能出现会员专属字段的最小结构（presentSections / hasMemberContent / strip 共用） */
interface MemberFielded {
  memberNotes?: { compare?: string; risk?: string }
  conflicts?: Array<{ topic?: string }>
  /**
   * 同领域坐标（2026-10-12）：与 memberNotes / conflicts 同属**会员生成才会有的字段**
   * （只在会员提示词里请求）。促销条列不下它（单行 18 字预算），但判定口径必须算上它。
   */
  peers?: Array<{ name?: string }>
  /**
   * 关联企业 / 合作方 / 参股（2026-10-12）：同 peers —— 会员生成才会有的字段，
   * 促销条列不下（18 字预算），但判定口径（hasMemberContent / stripMemberSections）必须算上它。
   */
  affiliations?: Array<{ name?: string }>
}

/** 报告里**实际**存在的专享段落（顺序固定，缺的跳过；空串按不存在处理） */
export function presentSections(report: MemberFielded | null | undefined): string[] {
  const present: string[] = []
  if (report?.memberNotes?.compare) present.push(MEMBER_SECTIONS[0])
  if (report?.memberNotes?.risk) present.push(MEMBER_SECTIONS[1])
  if (report?.conflicts && report.conflicts.length > 0) present.push(MEMBER_SECTIONS[2])
  return present
}

/**
 * 报告里是否存在**会员专属内容** —— 三段文字段（memberNotes / conflicts）**或**结构化段
 * peers / affiliations。
 *
 * 与 presentSections 的分工（2026-10-12 拆开）：
 *   · presentSections 给的是**能写进促销条的名字** —— 那条是单行、18 字预算（见 03 用例），
 *     列不下后面的结构化段，故只列三段文字段；
 *   · 本函数是**判定口径** —— 「剥除免费读者拿到的会员内容」（stripMemberSections）与
 *     「只升不降 / 会员补齐免计费复核」（端上 utils/cache.ts#hasMemberBlocks、云端
 *     aiProxy/report-store.js 与 quotaGuard）三处共用它。
 * 两件事一旦混用：要么促销条撑爆单行被裁成「信…」，要么 peers / affiliations 漏在免费对象里
 * （免费读者拿到的对象里本不该有会员生成的字段）。
 */
export function hasMemberContent(report: MemberFielded | null | undefined): boolean {
  if (presentSections(report).length > 0) return true
  if (Array.isArray(report?.peers) && report.peers.length > 0) return true
  return Array.isArray(report?.affiliations) && report.affiliations.length > 0
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
 *   2026-10-12：剔除范围加上 peers（同领域坐标）—— 它也是会员生成才会有的字段，
 *   留在免费对象里就破坏了这条不变式（判定统一走 hasMemberContent）。
 *   2026-10-12：再加上 affiliations（企业关联），同上。
 *
 * 无会员内容时**返回原对象**（引用相等）：绝大多数报告走这条，不产生拷贝、不读任何库 ——
 * 这是调用方可以放心到处调它的前提（见 utils/cache.ts#exposeReport 的快路径）。
 */
export function stripMemberSections<T extends MemberFielded>(report: T): T {
  if (!hasMemberContent(report)) return report
  const copy: T = { ...report }
  delete copy.memberNotes
  delete copy.conflicts
  delete copy.peers
  delete copy.affiliations
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
 * 清掉关闭记忆（由「清空我的数据」依次调用：utils/settings.ts#clearLocalSettings + 本函数）。
 *
 * 为什么不并进 ClearLocalSettings：本文件 import 了 auth.ts，而 auth.ts 要 import
 * settings.ts（登录时灌入云端偏好），settings.ts 若反过来 import 本文件就成环。
 * 单独导出而不是在两处各写一遍键名 —— 键名散开，早晚有一处忘记改。
 */
export function clearPromoDismiss(): void {
  Taro.removeStorageSync(PROMO_DISMISS_KEY)
}
