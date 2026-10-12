import { table } from './db'
import {
  Report,
  ReportPart,
  buildReport,
  buildKnowledgeFallback,
  isRefusedResult,
  REPORT_SCHEMA_VERSION,
  shortfallVerdict,
  REPORT_BATCHES
} from './report'
import { FocusCode } from '@/config/filters'
import {
  fetchNews,
  fetchBackground,
  hasSearchChannel,
  BG_COUNT,
  DEEP_BG_COUNT,
  DEEP_MAIN_COUNT,
  DEEP_SOCIAL_COUNT,
  NewsItem
} from './search'
/* 检索词规划（2026-10-11）：先问模型「该查什么」，再拿这些词去查（见 utils/search-plan.ts 头注释） */
import { planSearchQueries } from './search-plan'
import { parsePersonKey } from '@/config/domains'
import { useAuth } from '@/stores/auth'
import { track } from './events'
import { todayKey } from './time'
import { cooldownMinutesLeft, scopedCooldownRemainingMs, setScopedCooldown } from './cooldown'
import { peekGenerateQuota, consumeGenerateQuota, beginGenerateInflight } from './quota'
import {
  quotaExhaustedMessage,
  presentSections,
  hasMemberContent,
  readMemberState,
  stripMemberSections,
  DAILY_REFRESH_LIMIT,
  dailyRefreshLimit,
  FREE_REFRESH_COOLDOWN_HOURS
} from './member'
import { incrQuotaViaCloud } from './quota-guard'
import {
  acquireLockViaCloud,
  releaseLockViaCloud,
  saveReportViaCloud,
  saveReportPartsViaCloud,
  saveFeedViaCloud
} from './report-store'
import { REFRESH_QUOTA_DISABLED } from './debug'
import { diagLog } from './cloud-diagnostics'
import type { ReportCacheRow, FeedCacheRow, RefreshQuotaRow } from '@/types/db'

/**
 * 报告/动态缓存（§3.7 两级缓存 + §2.4 缓存击穿互斥）。
 * 互斥实现：report_cache.state=building + builder 条件写入；
 * 抢锁失败方轮询 ≤30s；构建失败释放锁（delete 本人的 building 行）。
 *
 * 有效期策略：报告一旦 ready 即长期复用，不按时间自动过期；
 * 唯一的重生入口是用户点「刷新最新」（getOrBuildReport force=true）。
 */

const POLL_INTERVAL_MS = 2000

/**
 * 构建耗时上界（P0，2026-10-11）。**必须按「分批生成」重算，不能沿用单次调用的口径。**
 *
 * 现在的构建 = 4 批顺序调用（utils/report.ts#REPORT_BATCHES），且每批 chatJSON 内部最多 3 次
 * 尝试（utils/llm.ts#chatJSON 的 attempts = 1 + retries(2)，retries 由 buildReport 显式传 2），
 * 单次上界为云函数侧给每次调用掐的时限 CHAT_DEADLINE_MS = 45s（注意它**不是**「上游超时」：平台
 * 60 秒是天花板，见 aiProxy/index.js 顶部那段）。此外不达标且可重试的产物会**自动重跑一次**完整
 * 生成（最多 REPORT_GENERATE_ATTEMPTS = 2 次，见 getOrBuildReport 的 shortfall 自动重跑）。
 * 故最坏 ≈ 4 × 3 × 2 × 45s = 1080s，再加重合检索（15s）与余量（30s）。
 *
 * 为什么必须够长：这个常量是「构建者失联判定」——短于真实构建耗时的后果**不是**「多等一会被拒绝」，
 * 而是**正常构建跑到一半就被他人判为失联并抢锁**：两边各白烧一遍 token，后落库的一方还会因
 * builder 不符被云端写口拒绝（saveBuild 返回 failed，缓存不更新，用户拿到报告却全站查不到）。
 * 原值 90s 是单次调用时代的估算（那时「LLM 60s + 检索 15s」确实够），分批改造后已明显不足。
 *
 * 取舍：宁可让「构建者进程被杀」留下的 building 脏行多留几分钟（只在异常时发生），
 * 也不能让正常的长构建中途被抢。若这个上界在时延上不可接受，该动的是**每批的重试次数或批次数**
 * （减少真实耗时），而**不是**把这个值调回小于构建时长 —— 那等于重新引入抢锁。
 */
const CHAT_SINGLE_DEADLINE_MS = 45 * 1000
/* 每批 chatJSON 内部最多 3 次尝试（attempts = 1 + retries(2)，retries 由 buildReport 显式传 2） */
const REPORT_BATCH_ATTEMPTS = 3
/* 不达标且可重试时最多完整生成几次（含第一次；见 getOrBuildReport 的 shortfall 自动重跑） */
const REPORT_GENERATE_ATTEMPTS = 2
const SEARCH_BUDGET_MS = 15 * 1000
const BUILD_SLACK_MS = 30 * 1000

export const BUILDING_TIMEOUT_MS =
  REPORT_BATCHES.length *
    REPORT_BATCH_ATTEMPTS *
    REPORT_GENERATE_ATTEMPTS *
    CHAT_SINGLE_DEADLINE_MS +
  SEARCH_BUDGET_MS +
  BUILD_SLACK_MS

/**
 * 等待方轮询上限（P0，2026-10-11）：**取与构建上界同值**。
 *
 * 原先刻意取得比 BUILDING_TIMEOUT_MS 短（75s vs 90s），留下一个「锁还没过期、等待方已放弃」的
 * 空窗：等待方报「正在生成中」之后，那 15s 里既读不到新报告、也抢不到锁。两者同值后，
 * 等待方的上限与「构建者可能还在正常工作」的时间窗一致。
 * 注意这只是**上限**而非预期等待 —— 正常构建约 40~100s，超时只在对方真卡住时才会走到。
 */
const WAIT_TIMEOUT_MS = BUILDING_TIMEOUT_MS
/*
 * 每日刷新次数上限（10）不再写在这里：它是会员页要展示给用户的数字，唯一来源是
 * utils/member.ts#MEMBER_BENEFITS.refreshPerDay（免费与会员同额）。本文件此前自带一份
 * `const DAILY_REFRESH_LIMIT = 10`，与会员页各写一份 ⇒ 迟早出现「页面说 10 次、
 * 闸门按别的数拦」。判定权威在云函数 quotaGuard，本常量只在云函数不可用时兜底。
 */

/**
 * 生成进度（2026-10-11）：报告是「检索素材 → 分 4 批生成」，页面的等待动画据此显示真实阶段。
 *
 * 为什么需要它：加载动画此前**只按秒数推进**（报告页从发出请求到拿到结果全程只 await 一次），
 * 用户看到的「正在阅读并筛选素材…」纯属估计，与后端到底走到哪一步无关 —— 分批后系统明明
 * 知道「4 批跑到第几批了」，却没有任何出口。
 *
 * 两阶段而非更细：检索（一次并行请求）与生成（4 批串行）是**可观测**的两件事；
 * 再往下切（比如每批拆成「正在写 X 节」）没有真实信号支撑，只会退化成另一种虚假进度。
 */
export interface ReportProgress {
  /** search：正在检索素材；generate：正在分批生成报告 */
  stage: 'search' | 'generate'
  /** 生成阶段已成功的批数（search 阶段恒 0） */
  done: number
  /** 生成总批数（REPORT_BATCHES.length，当前为 4） */
  total: number
}

export type ReportOutcome =
  | {
      kind: 'report'
      report: Report
      fromCache: boolean
      /** force 刷新时带上「上一版」，供页面做变化对比；缓存命中时为 null */
      prev?: Report | null
      /**
       * 本次生成被「只升不降」拦下（P0，2026-10-09）：交回的是缓存里已含会员段落的那一版，
       * 本次产物较简略、没有覆盖它（见 saveReady / shouldKeepMemberVersion）。
       * 页面据此给一句解释 —— 否则用户点了「刷新最新」却看不出任何变化，会以为按钮坏了。
       */
      keptMember?: boolean
      /**
       * 交回的 `report` 里**被藏起来的会员段落名**（批 1，2026-10-09）：免费读者才有值。
       *
       * 内容剥掉、存在性保留 —— 报告页的促销条要说清「这份报告里有什么你看不到」
       * （文案见 utils/member.ts#reportMemberPromo），剥离之后若连「有没有」都不知道，
       * 那句可兑现的承诺（「已含对比视角、风险提示、信源分歧」）就退化成泛泛的招揽。
       */
      memberLocked?: string[]
      /**
       * 本次产物没达到最低交付要求（2026-10-10，判定见 utils/report.ts#reportShortfall）。
       *
       * ⚠ 与 refreshFailed 的关键差别：报告**真的生成出来了**（上面那份就是这次的新产物），
       * 只是质量够不上「一份报告」，所以**没有消耗用户的生成次数**。页面必须说明这一点 ——
       * 否则用户看着一份明显残的报告，只能自己猜「这次是不是白花了」。
       */
      shortfall?: string
      /**
       * 上面这条不达标「重试有没有意义」（P2，2026-10-10，判据见 utils/report.ts#shortfallVerdict）。
       *
       * 页面必须按它分流文案：不达标里有两类原因，一类是上游抖动（重试通常就好），
       * 另一类是**素材本身就不够**（长尾人物近期报道少）—— 后者劝重试就是让用户白等一场，
       * 每次不扣次数、每次都不达标，最后把「素材少」误解成「服务坏了」。
       * 只有不达标时才带这个字段。
       */
      shortfallRetryable?: boolean
      /**
       * 本次 force 刷新**失败**，交回的是缓存里原有的那一版（P1-8，2026-10-09）。
       *
       * 报告页的「刷新最新」是在**已经读着的内容上**再点一次，失败时若交回 `error`，
       * 页面就会把它渲染成「生成失败」空态 —— 上游抖一下，用户就从「有一份能读的报告」
       * 变成「什么都没有」。报告 ready 后长期复用，刷新失败不该把它从读者眼前拿走，
       * 故这里照常交回既有版本，只用这个标记说明「这次没刷成」（文案见 refreshFailureNote）。
       */
      refreshFailed?: boolean
      /** 失败原因（配合 refreshFailed，页面直接展示） */
      refreshError?: string
    }
  | { kind: 'coldstart' } // 无联网素材 + 缓存为空（或强刷）：引导态
  | { kind: 'nonews' } // 抓取为空：暂未检索到
  | { kind: 'refused' }
  | { kind: 'error'; message: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getRow(personKey: string): Promise<ReportCacheRow | null> {
  const { data, error } = await table('report_cache').select('*').eq('id', personKey).maybeSingle()
  if (error) diagLog('warn', 'db', `report_cache 读取失败：${error.message ?? error}`)
  return ((data as ReportCacheRow) ?? null)
}

/**
 * 缓存可用判定：只要「已就绪且有报告」即可长期复用，不设时间上限。
 * 新鲜度交由页面上的「生成于 X 前 · 查看最新」提示与用户判断，不做自动过期重生。
 */
function isUsable(row: ReportCacheRow | null): row is ReportCacheRow & { report: Report } {
  return !!row && row.state === 'ready' && !!row.report
}

/**
 * 读一行的报告 Schema 版本，缺失按 1 处理（前置项 1，2026-10-09）。
 *
 * 为什么需要这个助手，而不是直接读 row.schemaVersion：
 *   · `report_cache` 由端上直写，2026-10-09 之前落库的行没有这个字段，`undefined` 是**正常**的；
 *   · 版本号只有一处读法，才能保证「报告页判版本」「将来按版本决定要不要重生成」口径一致
 *     （与 utils/report-toc.ts 收口目录条件同一个理由：散在各处的判空没人钉得住）。
 *
 * ⚠ 现在**不**因版本低而丢弃缓存：那会让全部存量报告当场失效（用户点开就是重新生成）。
 *   老报告照旧可读，判空逻辑照旧逐字段 —— 版本号是给「将来新增段落」用的，
 *   升级时再用它回答「这一段该不该有」，而不是「这份报告还能不能用」。
 */
export function reportSchemaVersion(row: ReportCacheRow | null): number {
  const v = row?.schemaVersion
  return typeof v === 'number' && v > 0 ? v : 1
}

/**
 * 这份报告是否带着**会员专属内容**（对比视角 / 风险提示 / 信源分歧 / 同领域坐标 / 企业关联）。
 *
 * 判据只能落在字段上，不能落在「谁生成的」：报告是全局共享缓存，两种产物混在
 * 同一张表、同一把键（personKey）上，谁先来谁的版本就在那儿。
 * 这些字段都只在会员提示词里请求，故「有其一」即算会员版。
 */
export function hasMemberBlocks(report: Report | null | undefined): boolean {
  /* 直接复用会员权益层的判定（utils/member.ts#hasMemberContent）：
     它把空串与空数组都按「不存在」处理，正是我们这里要的口径 ——
     有字段但一段内容都没有，不算会员版（那种报告覆盖掉它也不损失什么）。
     口径必须与剥除（stripMemberSections）和云端两处（report-store / quotaGuard）一致，
     否则会出现「UI 说没有、守卫说有」的分歧。 */
  return hasMemberContent(report)
}

/**
 * 「只升不降」判定（P0，2026-10-09）：新产物不含会员段落、而缓存里那一行含时，拒绝覆盖。
 *
 * 为什么需要这一步：同一 personKey 只有一行，免费档产物一旦覆盖掉会员版，
 * **全站会员**下次点开都会看到「深度解析」整块消失；而报告一旦 ready 就长期复用、
 * 不按时间过期（见本文件顶部），这个降级不会自愈 —— 任何人点一次「刷新最新」，
 * 就能把付费换来的内容永久抹掉，被抹掉的人还没有任何补救手段。
 *
 * 纯函数（不含 I/O）以便单测直接钉住判定；那一次读库放在生成主流程里、落库之前，
 * 且发生在持有 building 锁之后（acquire 互斥），所以读到的就是「即将被覆盖的那一版」。
 *
 * 判定只看 `report` 字段，**不看 `state`**（P0 修复，2026-10-09）：
 * 抢锁（acquire）不再清空 `report`，于是刷新期间那一行是 `state='building'` 却仍带着
 * 上一版内容 —— 那正是本次要覆盖掉的东西。原先要求 `state === 'ready'`，
 * 而抢占已经把行改成 building，守卫于是恒不命中，「只升不降」形同虚设
 * （免费档刷新一次就能把全站的会员段落永久抹掉）。
 */
export function shouldKeepMemberVersion(
  next: Report | null | undefined,
  existing: ReportCacheRow | null | undefined
): boolean {
  if (hasMemberBlocks(next)) return false
  return !!existing && hasMemberBlocks(existing.report)
}

/**
 * 交给**当前读者**的报告（批 1，2026-10-09）：会员原样，非会员把会员段落摘掉。
 *
 * 快路径刻意排在读会员态**之前**：报告里没有会员段落时（免费档生成的、老报告、降级简版）
 * 根本不必知道读者是谁 —— 绝大多数读取走这条，于是「不给免费用户发会员段」这件事
 * **不为绝大多数请求多付一次 users 读**；只有真的藏着东西时才读一次身份。
 *
 * 读库失败时 readMemberState 按非会员处理（全项目一致口径，见 utils/member.ts），
 * 代价是极少数抖动会让会员这一眼看不到会员段（页面会显示「这份报告没有会员段落」的
 * 补齐引导，点了即恢复）—— 比反过来给非会员放行一次强。
 *
 * 返回的 locked 见 ReportOutcome.memberLocked。
 *
 * `knownMember` 是给**生成路径**用的：那条路径上身份已经读到了（memberDeep，见配额检查），
 * 再为同一件事读一次库是白付一次往返。读路径不传，由本函数按需读。
 */
async function exposeReport(
  report: Report,
  knownMember?: boolean
): Promise<{ report: Report; locked: string[] }> {
  const locked = presentSections(report)
  if (locked.length === 0) return { report, locked }
  const member = knownMember ?? (await readMemberState()).member
  /* 会员手里没有被锁住的段落 —— 交回空数组而不是「这份报告有哪些专享段」：
     字段名说的是「被藏起来的」，别让它对会员也非空，否则以后有人拿它当身份判断就会读反。 */
  return member ? { report, locked: [] } : { report: stripMemberSections(report), locked }
}

/**
 * 免费档「重复生成」的提醒窗口（批 2，2026-10-09；2026-10-10 收窄为只做提醒）。
 *
 * 为什么仍是 12 小时：报告是「一次生成、长期复用」的资产，不按时间过期（见文件顶部），
 * 半天的间隔内内容不会有实质变化（素材时间窗 30 天，热度按 N30/N7 算），
 * 而每次重新生成都要付一整笔检索 + LLM 输出 —— 用户刚看完就想再刷时，值得提醒一句。
 * ⚠ 但它**只用于确认弹窗里的那句话**，不再拦下任何一次 force：原先命中就交回旧版本，
 * 用户点了刷新却什么都没发生，与「重新生成随时可用」直接冲突（判定见 isFreeRefreshCooling）。
 * 会员不受限：他有每日 30 次，故这句提醒只对免费档发。
 *
 * 数值取自权益表（utils/member.ts#freeRefreshCooldownHours）：它仍是**按身份分叉**的
 * 规则，会员页要原样告诉用户「免费版 12 小时内会先提醒、会员不受限」，两边各写一份
 * 就会出现「页面说 12 小时、提醒按别的时长发」。
 */
const FREE_REFRESH_COOLDOWN_MS = FREE_REFRESH_COOLDOWN_HOURS * 60 * 60 * 1000

/**
 * 这份报告是否还在免费档的「重复生成提示窗口」内（批 2 → 2026-10-10 改语义）。
 *
 * ⚠ 语义变了：它**不再是一道拦截闸门**。原先命中就直接交回旧版本、根本不重新生成，
 * 用户点了刷新却什么都没发生 —— 与「重新生成随时可用」直接冲突。
 * 现在只服务于**页面弹确认时的一句提醒**：免费用户刚生成完再刷，先告诉他「这份 X 小时前
 * 刚生成过、内容可能没实质变化」，确认后照常生成、照常计数。
 * 会员不受限（有每日额度），故这条只对免费档成立。
 *
 * 快路径**先看时间、再看身份**：绝大多数 force 都发生在报告已经旧了的时候（用户就是为这个点的），
 * 那种情况连身份都不必读 —— 与 exposeReport 同一取舍，别让这个判断给常态动作加成本。
 *
 * 读库失败时 readMemberState 按非会员处理（全项目口径，见 utils/member.ts）：
 * 这里判错方向的代价只是多弹一句提醒，可以忽略。
 */
export async function isFreeRefreshCooling(report: Report): Promise<boolean> {
  const at = Date.parse(report.generatedAt ?? '')
  if (!Number.isFinite(at)) return false
  if (Date.now() - at >= FREE_REFRESH_COOLDOWN_MS) return false
  return !(await readMemberState()).member
}

/**
 * 抢锁：无行时条件插入；已有行则条件更新（ready 过期 / building 失联超时可抢占）。
 *
 * 迁移注意：原实现靠 PostgREST 的 23505 唯一冲突码判断"行已存在"，CloudBase 不产生该错误码，
 * 照搬会导致缓存一旦有行就恒抛异常（抢占与等待逻辑全部失效）。改为先探测存在性，
 * 插入失败时再读一次以区分"并发中他人抢先"（lost）与"网络/权限真实失败"。
 *
 * 三态（P0-2，2026-10-09）。`degraded` 是新增的兜底态，与 `lost` **语义完全不同**：
 *   · `lost`      —— 别人正持有锁 ⇒ 调用方去等待 / 读缓存；
 *   · `degraded`  —— 写库这条路整个不通（写口拒绝 + 直写失败）⇒ **照常生成并返回报告**，
 *                    只是这一轮不进共享缓存。原本失败会抛错，等于把「缓存写不进去」
 *                    升级成「用户看不到报告」；而缓存只是加速手段，不该有这种否决权。
 *                    代价仅是无锁并发时可能重复生成，远好过整页报错。
 */
async function acquire(
  personKey: string,
  userId: string
): Promise<'acquired' | 'lost' | 'degraded'> {
  /*
   * 云端优先（P0-2）：写口是权限收紧后**唯一**的写入通道，先交给它。它没通
   * （函数未部署 / 环境未配置 / 网络）才回退下面的端上直写 —— 这条双路正是
   * 「权限收紧」能与「端上尚未全量更新」并存的原因：两边跑的是同一份代码。
   */
  const viaCloud = await acquireLockViaCloud(personKey)
  if (viaCloud !== 'unavailable') return viaCloud

  const now = new Date().toISOString()
  const existing = await getRow(personKey)

  if (!existing) {
    const { error } = await table('report_cache')
      .insert({
        id: personKey,
        report: null,
        generated_at: now,
        state: 'building',
        builder: userId,
        search_meta: null,
        /* 新行还没有中间结果，但把键写出来（null = 无）：行形状与 dbInit 的 def 保持一致，
           排障时不必区分「没有这个键」与「有键但是空」两种情况 */
        parts: null,
        schemaVersion: REPORT_SCHEMA_VERSION
      })
      .select()
    if (!error) return 'acquired'
    const again = await getRow(personKey)
    if (again) return 'lost'
    /* 直写失败（权限已被收紧 / 网络异常）：**降级，不抛错** —— 详见函数头注释 */
    diagLog('warn', 'db', `抢锁直写失败，本轮不写缓存：${personKey} · ${error.message ?? error}`)
    return 'degraded'
  }

  const expireIso = new Date(Date.now() - BUILDING_TIMEOUT_MS).toISOString()
  /*
   * 抢占时**刻意不动 `report`**（P0 修复，2026-10-09）：这一行上留着的是「即将被覆盖的
   * 那一版」，两个下游都指着它 ——
   *   · 「只升不降」守卫要靠它判断本次较简略的产物该不该写（见 shouldKeepMemberVersion）；
   *   · release 失败回退时要把它交还给后续读者。
   * 原先在这里写 `report: null`，等于抢锁的同一刻就把上一版（常常是会员版）抹掉了：
   * 守卫恒判「无既有版本」而放行覆盖，构建失败则整行被删 —— 报告 ready 后长期复用、
   * 不自愈，这个降级一旦发生就没有补救手段。
   *
   * `generated_at` 仍要刷新：building 行上它承担的是「本次构建的起点」，
   * 失联超时抢占（下方 or 条件）靠它判断，不能沿用上一版的生成时间。
   * 抢占同时刷新 schemaVersion：这一轮的产物是**当前端上**生成的，
   * 免得排障时看到「state=building 却没有 schemaVersion」而要再想一遍是哪种情况。
   */
  const { data: upd, error: updErr } = await table('report_cache')
    .update({
      state: 'building',
      builder: userId,
      generated_at: now,
      schemaVersion: REPORT_SCHEMA_VERSION,
      /* 清掉上一轮（可能是被抢占 / 中断的那一次）留下的中间结果：它属于旧的那次生成，
         留着会让「报告缺的那一块是什么原因」的排查读到一份对不上号的记录 */
      parts: null
    })
    .eq('id', personKey)
    .or(`state.eq.ready,generated_at.lt.${expireIso}`)
    .select()
  /* 同上：抢占直写失败也降级，不把「写库不通」变成「用户看不到报告」 */
  if (updErr) {
    diagLog('warn', 'db', `抢锁直写失败，本轮不写缓存：${personKey} · ${updErr.message ?? updErr}`)
    return 'degraded'
  }
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return ((upd as any[])?.length ?? 0) > 0 ? 'acquired' : 'lost'
}

/**
 * 释放锁：只动本人的 building 行（他人持锁不动）。
 *
 * P0 修复（2026-10-09）：抢占时不再清空 `report`，于是这一行上通常还躺着上一版内容。
 * 此时**不能整行删掉** —— 那等于把上一版（常常是会员版）一起抹掉，而报告 ready 后
 * 长期复用、不自愈，一次中断就替全站把缓存击穿。改为「有旧内容就退回 ready 把锁让出去」，
 * 只有确实没内容（首次生成）才删行。
 *
 * 恢复时把 generated_at 交还给旧报告自己的生成时间：那才是这一版的真实产出时刻，
 * 页面上的「生成于 X 前」与免费档刷新冷却（isFreeRefreshCooling）都读它。
 */
async function release(personKey: string, userId: string): Promise<void> {
  /*
   * 云端优先（P0-2）：写口能放就交给它（它有权威的 builder 判定）。
   * 明确拒绝（限速 / 参数）时**不回退**直写 —— 放锁不是要紧事：残留的 building 行
   * 会在 BUILDING_TIMEOUT_MS 后被他人抢占，不值得为它绕过写口。
   */
  const viaCloud = await releaseLockViaCloud(personKey)
  if (viaCloud === 'done') return

  const row = await getRow(personKey)
  /* 已被他人接管 / 已落库 ready：不是我的锁，一律不动 */
  if (!row || row.state !== 'building' || row.builder !== userId) return

  if (row.report) {
    const { error } = await table('report_cache')
      .update({
        state: 'ready',
        builder: null,
        generated_at: row.report.generatedAt ?? row.generated_at,
        /* 中断退回的这一次没生成完整报告，中间结果一并清掉（理由同 acquire 里那处） */
        parts: null
      })
      .eq('id', personKey)
      .eq('builder', userId)
      .eq('state', 'building')
    if (!error) {
      diagLog('info', 'db', `构建中断，回退为 ready（保留既有版本）：${personKey}`)
      return
    }
  }

  await table('report_cache').delete().eq('id', personKey).eq('builder', userId).eq('state', 'building')
  diagLog('info', 'db', `释放 building 锁：${personKey}`)
}

/**
 * 落库并置 ready。
 *
 * 用 upsert（等价 doc(id).set，整篇替换）而非 where().update()：
 * CloudBase 的 update 对嵌套对象走「点号路径」语义，而 acquire 占位时写入的 report 是 null，
 * 往 null 上写 report.analysis 这类子字段会被数据库直接拒绝：
 *   [FailedOperation] Cannot create field 'analysis' in element {report: null}
 * 后果是落库恒失败 → state 永久停在 building → 缓存永不命中（每次进入都重新生成），
 * 且只有一条 warn 日志，极易被误判成「LLM 通道坏了」。
 * doc(id).set 是整篇替换，对 report / search_meta 的初值没有任何要求，从根上绕开该差异。
 *
 * 返回值三态（P0，2026-10-09）：
 *   'saved'  已写入
 *   'kept'   被「只升不降」拦下 —— 缓存里那版含会员段落，本次较简略的产物**不写**，
 *            调用方应改交回既有那份（见 getOrBuildReport 第 4 步）
 *   'failed' 写库失败（已释放自己的 building 锁）
 */
async function saveReady(
  personKey: string,
  report: Report,
  newsCount: number,
  userId: string
): Promise<'saved' | 'kept' | 'failed'> {
  /* 只升不降（P0）：这里再判一次既有的那一版。主流程已在落库前判过一遍（那一次是为了
     「拦下就不计数」与「免计费申请」），此处是兜底 —— 两处口径必须一致，都走同一个纯函数。 */
  if (!hasMemberBlocks(report)) {
    const existing = await getRow(personKey)
    if (shouldKeepMemberVersion(report, existing)) {
      diagLog('info', 'db', `拒绝降级覆盖：${personKey} 已有含会员段落的版本，保留原样`)
      /* 不写库，但锁必须放掉：守卫修好后这条路径才第一次真正可达（P0，2026-10-09）。
         release 会把行退回 ready 并交还旧内容 —— 调用方紧接着要 getRow 取「被保留的那一版」，
         若这里让行以 building 残留，那边 isUsable 会判否、兜底静默失效。 */
      await release(personKey, userId).catch(() => undefined)
      return 'kept'
    }
  }

  /*
   * 云端优先（P0-2，2026-10-09）：写口是权限收紧后**唯一**的写入通道。它的两种「不通」必须
   * 分开处理，混为一谈就会把写口的校验架空 ——
   *   · `rejected`（非会员写会员段 / 体积超限 / 锁被接管）⇒ **不回退直写**：写口拒的正是
   *     这类内容，回退等于把刚被拦下的东西直接塞进库（ACL 收紧前完全做得到）；
   *   · `unavailable`（函数未部署 / 环境未配置 / 网络）⇒ 回退下面的端上直写，与收紧前一致。
   */
  const viaCloud = await saveReportViaCloud(personKey, report, newsCount)
  if (viaCloud === 'saved') return 'saved'
  if (viaCloud === 'rejected') {
    diagLog('error', 'db', `写口拒绝本次落库：${personKey}`)
    await release(personKey, userId).catch(() => undefined)
    return 'failed'
  }

  const { error } = await table('report_cache').upsert({
    id: personKey,
    report,
    state: 'ready',
    generated_at: report.generatedAt,
    builder: null,
    search_meta: { news_count: newsCount },
    /* 成品落库，分批生成的中间结果随之作废 */
    parts: null,
    /* 落库时打版本：这是「这份报告由哪个版本的端上生成」的唯一记录点 */
    schemaVersion: REPORT_SCHEMA_VERSION
  })
  if (!error) return 'saved'
  diagLog('error', 'db', `报告落库失败：${error.message ?? error}`)
  // 落库失败时必须放掉自己的 building 锁：否则该行会以 state=building 残留，
  // 在 BUILDING_TIMEOUT_MS 内让**所有**查询该人物的请求都只能排队等待，且全程零报错。
  // release 的语义是「有上一版就退回 ready 交还出去，确实没有才删行」（P0，2026-10-09），
  // 所以这里不会把缓存里原有的内容一起抹掉。
  // 报告本身仍返回给本次用户，只是这一次不进缓存（下次重新生成，但不会再排队）。
  await release(personKey, userId).catch(() => undefined)
  return 'failed'
}

/**
 * 中间结果落库（P0-B，best-effort）：分批生成时，每批成功即把累计的批次结果写进 building 行的
 * `parts` 字段 —— 后面几批失败时，前面这几批已经花掉的 token 不会白费（可据 parts 排查
 * 「报告缺的那一块是模型没写还是那一批调用失败了」）。
 *
 * 三条边界：
 *   · **不改 state、不写 report**：这只是一次过程记录，缓存命中判定与读者可见性都只看 state/report，
 *     所以写它永远不会把半成品暴露给用户；
 *   · 写口明确拒绝时不回退直写（与 saveReady 同一口径）：拒绝的正是这类写入，回退等于绕过刚拒掉的校验；
 *   · 任何失败都只记日志、不抛 —— 它是锦上添花，不该把一次正在进行的生成打断。
 */
async function saveReportParts(
  personKey: string,
  parts: ReportPart[],
  userId: string
): Promise<void> {
  const viaCloud = await saveReportPartsViaCloud(personKey, parts)
  if (viaCloud === 'saved') return
  if (viaCloud === 'rejected') {
    diagLog('warn', 'db', `写口拒绝中间结果落库：${personKey}`)
    return
  }

  const { error } = await table('report_cache')
    .update({ parts })
    .eq('id', personKey)
    .eq('builder', userId)
    .eq('state', 'building')
  if (error) diagLog('warn', 'db', `中间结果落库失败：${personKey}：${error.message ?? error}`)
}

/** 他人 building：轮询等待 ready（≤30s） */
async function waitForReady(personKey: string): Promise<Report | null> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const row = await getRow(personKey)
    if (row?.state === 'ready' && row.report) return row.report
    if (!row) return null // 构建者失败，锁已释放
  }
  return null
}

/**
 * 报告读取主入口（附录 C + §2.4 边界）。
 * force=true 为强制刷新（无 key 用户同样会走 coldstart 引导，§3.7）。
 *
 * focus 为发现页「关注」筛选（生成侧重）：**不参与缓存键**，
 * 缓存仍以 personKey 为唯一键，避免破坏关注流 / 个人页的只读缓存读取；
 * 侧重不一致时由报告页提示「重新生成以聚焦」，用户点刷新（force）后覆盖缓存。
 *
 * `opts.onProgress`（2026-10-11）：本机真实生成时逐阶段回调（检索 → 分批生成），供等待动画
 * 显示真实进度；命中缓存 / 排队等待等**不产生**进度的路径不会回调（那些路径本就没有「生成」可播报）。
 */
export async function getOrBuildReport(
  personKey: string,
  opts: { force?: boolean; focus?: FocusCode; onProgress?: (p: ReportProgress) => void } = {}
): Promise<ReportOutcome> {
  const focus = opts.focus ?? 'all'
  const userId = useAuth.getState().userId ?? 'anonymous'
  const parsed = parsePersonKey(personKey)
  if (!parsed) return { kind: 'error', message: `非法 personKey：${personKey}` }
  const { name, domain } = parsed

  // 0. 缓存命中优先（随用随查）：已生成的报告读取零成本，不受冷却影响。
  //    冷却检查后置到第 1.5 步，只拦「重新生成」，不拦「看已有报告」。
  let row = await getRow(personKey)
  if (isUsable(row) && !opts.force) {
    /*
     * force 的「免费档冷却」拦截原先就在这个分支里（批 2，2026-10-09），2026-10-10 撤销：
     * 用户要的是「重新生成随时可用」—— 拦下来的结果是点了刷新什么都不变，
     * 而那道闸门想省下的成本，现在已经改由确认弹窗（提示消耗次数）把门，
     * 没必要再来一道用户看不见、点不动任何东西的拦截。
     * 冷却判定本身没删，降级成弹窗里的一句提醒（见 isFreeRefreshCooling）。
     */
    track('report_hit_cache', { personKey })
    /* 交回前先按读者身份过滤（批 1）：免费用户拿到的对象里不该有会员段（见 exposeReport） */
    const shown = await exposeReport(row.report)
    return {
      kind: 'report',
      report: shown.report,
      fromCache: true,
      memberLocked: shown.locked
    }
  }

  /**
   * 本次生成是否走「深度模式」（O-11）：会员的素材加厚 + 报告多两段专属文字。
   * 会员态**顺带**取自上方的配额检查（peekGenerateQuota 已带回 member），不额外读一次库；
   * 检查失败（catch 分支）时保持 false —— 放行的是免费口径，宁可少给不可误给。
   */
  let memberDeep = false

  /**
   * force 刷新失败时的兜底（P1-8，2026-10-09）：交回缓存里原有的那一版，并说明这次没刷成。
   *
   * 见 ReportOutcome.refreshFailed 的理由。返回 `null` 表示这一行恰好不可用（首次生成失败 /
   * 脏行），由调用方照常返回 `error`。
   *
   * ⚠ 只用于**失败**分支：`coldstart` / `nonews` / `refused` 是「这次没有新素材 / 不在覆盖
   * 范围」这类内容性结论，照旧原样返回（有单测钉着，见 04-member-cache.js）。
   *
   * `knownMember` 已知时传入可省一次身份读；未知（如冷却闸在最前面）就传 undefined 让
   * exposeReport 自己读 —— 失败路径很罕见，这里以「别给会员剥错段落」优先。
   */
  const cachedFallback = async (message: string, knownMember?: boolean): Promise<ReportOutcome | null> => {
    const current = await getRow(personKey)
    if (!isUsable(current)) return null
    const shown = await exposeReport(current.report, knownMember)
    diagLog('info', 'db', `刷新失败，交回缓存中的既有版本：${personKey}`)
    return {
      kind: 'report',
      report: shown.report,
      fromCache: true,
      refreshFailed: true,
      refreshError: message,
      memberLocked: shown.locked
    }
  }

  // 1. 冷却检查（§5.4 用例 9）：仅拦截需要真实发起搜索/生成的路径。
  //    注意 setCooldown 现在只由「限流 / 网络 / 上游 5xx」触发（见 report.ts、search.ts），
  //    密钥/额度类错误不再进入冷却，修好配置即可立刻重试。
  for (const label of ['search', 'llm'] as const) {
    const left = cooldownMinutesLeft(label)
    if (left > 0) {
      const what = label === 'search' ? '搜索源' : '生成服务'
      const message = `${what}限流冷却中（约 ${left} 分钟），已生成的报告不受影响；可先浏览其他名人`
      return (await cachedFallback(message)) ?? { kind: 'error', message }
    }
  }

  /*
   * 1.2 该人物的「无素材」冷却（P1，2026-10-11）：机制见 utils/cooldown.ts#setScopedCooldown，
   * 记录点在下方 nonews 分支。
   *
   * 为什么单独一档：无素材兜底（C）**既不入共享缓存、也不计用户次数** —— 两条都是对的
   * （理由见那处注释），但合起来的效果是「同一个人物可以无限重跑」：每点一次刷新就是一次
   * 全量检索（main + social + bg，源侧最多 3 次尝试）加一次模型调用，产物却永远不落库、
   * 不留任何痕迹，也就谈不上复用。全局的 'search' / 'llm' 冷却挡不住它：那是**设备级**键位，
   * 为一个查不到素材的人物把整台设备封 10 分钟，用户只会以为应用坏了。
   *
   * 位置：排在全局冷却之后、配额检查之前 —— 它是**纯本地**判定（零网络），能省下后面的每一次
   * 检索与模型调用；也因此不会出现「先被告知次数用完、再被告知没素材」这种自相矛盾的顺序。
   */
  const materialCool = scopedCooldownRemainingMs('search', personKey)
  if (materialCool > 0) {
    const minutes = Math.ceil(materialCool / 60000)
    const message = `「${name}」刚刚已查过、暂无公开素材（约 ${minutes} 分钟后可再试）`
    /* 缓存里有旧版就交回旧版（与全局冷却同一处理）；没有就进素材空态（§2.4）——
       两者都比「再烧一次上游、再给一遍同样的空结果」对用户更诚实 */
    return (await cachedFallback(message)) ?? { kind: 'nonews' }
  }

  // 1.5 生成配额检查（freemium 免费层）：只拦「真实发起生成」的路径。
  //     缓存命中已在上方返回（不计数、不受限）；配额用完仍可浏览所有已生成报告。
  try {
    const quota = await peekGenerateQuota(userId)
    if (!quota.allowed) {
      const message = quotaExhaustedMessage(quota.member, quota.limit, '已生成的报告仍可正常浏览')
      return (await cachedFallback(message, quota.member)) ?? { kind: 'error', message }
    }
    memberDeep = quota.member
    /*
     * 闸门通过 ⇒ 记一笔在途占位（P1，2026-10-11）：peek 在这里、consume 在落库之后，
     * 中间隔着几十秒上游调用。同一用户在这段窗口里对**两个不同人物**各发起一次生成时，
     * 两次 peek 会看到同一个 used 而双双放行 —— 免费额度被一次性突破，而抢锁拦不住它
     * （抢锁按 personKey，两个不同人物本来就是两把锁）。
     * 撤销不在这里：占位自身会失效（计费推进即失效 / 过期即失效），见 utils/quota.ts
     * 的「在途占位」一节。TTL 与锁同值，故直接用 BUILDING_TIMEOUT_MS。
     * ⚠ 配额服务异常（下面的 catch）不记占位：那条路径本就按「宁可少量超发」放行。
     */
    beginGenerateInflight(userId, personKey, BUILDING_TIMEOUT_MS, quota.used)
  } catch (err) {
    /* 配额服务异常不拦生成：宁可少量超发，不可让所有人无法生成（与冷却的降级哲学一致） */
    diagLog('warn', 'db', `配额检查失败，放行本次生成：${err instanceof Error ? err.message : String(err)}`)
  }

  /**
   * 本次生成前的旧报告，仅用于「刷新后告诉用户到底变了什么」。
   * 只在 isUsable 时取，且只在 force（用户主动点刷新）路径上带出：
   * 缓存命中场景用户没有发起任何动作，这时拿「相对上一版」说事会让人
   * 以为发生了他没要求的变更。不落库，纯内存传递。
   *
   * 交给页面之前先按本次身份过滤（批 1）：免费用户的「变化对比」不该引用会员段的内容 ——
   * 否则一份「刷新后新增了风险提示」的提示语本身就把会员段说出去了。
   * 用 memberDeep 而非 exposeReport：身份已读到，不必为同一件事读第二次库。
   */
  const prevRaw = isUsable(row) ? row.report : null
  const prevReport = prevRaw && !memberDeep ? stripMemberSections(prevRaw) : prevRaw

  /**
   * 「会员补齐」（P1，2026-10-09）：本次是会员在生成，而缓存里现有的那份还不含会员段落
   * （多为免费档先来生成过）—— 那他这次刷新实质是**替全站把这行缓存升级**，
   * 产物照样写进共享缓存，之后所有免费用户都读得到这笔钱换来的东西。
   * 故这一笔不该由他掏每日次数（配额在 utils/quota.ts 消耗，此处只是「申请」）。
   *
   * ⚠ 端上这个标记**不可信**：真伪由云函数 quotaGuard 复核（会员是否真的生效 +
   *   目标那一行是否真的缺会员段）。改包伪造申请只是让自己被按普通生成计数，白不了。
   */
  const memberUpgrade = memberDeep && !hasMemberBlocks(row?.report)

  // 2. 抢锁（三态：acquired / lost / degraded）
  let lock: 'acquired' | 'lost' | 'degraded'
  try {
    lock = await acquire(personKey, userId)
  } catch (err) {
    const message = `缓存服务异常：${err instanceof Error ? err.message : String(err)}`
    return (await cachedFallback(message, memberDeep)) ?? { kind: 'error', message }
  }

  /*
   * 3. **只有 `lost` 才等**（缓存击穿防护，§2.4）。
   * `degraded`（P0-2）刻意落进第 4 步去照常生成：它表示「写库这条路不通」，而不是
   * 「别人正在构建」。若把它一起当成等锁，用户会白等 75 秒再拿到一句「正在生成中」——
   * 明明没有任何人在生成，这份代价纯粹由一次写库失败换来。
   */
  if (lock === 'lost') {
    const report = await waitForReady(personKey)
    if (report) {
      track('report_hit_cache', { personKey })
      const shown = await exposeReport(report)
      return { kind: 'report', report: shown.report, fromCache: true, memberLocked: shown.locked }
    }
    row = await getRow(personKey)
    if (isUsable(row)) {
      const shown = await exposeReport(row.report)
      return { kind: 'report', report: shown.report, fromCache: true, memberLocked: shown.locked }
    }
    return { kind: 'error', message: '报告正在生成中，请稍后查看' }
  }

  /*
   * 进度出口（2026-10-11）：只在「本机真生成」路径上报（命中缓存 / 排队等待在前面就返回了，
   * 那种情况本就没有生成可播报）。total 取自分批数真源 REPORT_BATCHES，不另写常量 ——
   * 分批数改了这里跟着改，页面的「X/4」才不会与真实批数对不上（BatchSpec 的注释同款理由）。
   */
  const totalBatches = REPORT_BATCHES.length
  const emitProgress = (stage: ReportProgress['stage'], done: number) =>
    opts.onProgress?.({ stage, done, total: totalBatches })

  // 4. 我是构建者：博查检索 → LLM → 校验 → 落库
  try {
    /*
     * 深度模式（O-11）：会员的报告生成走加厚检索，主线 / 支线各加厚一档（见 search.ts 的 DEEP_*）。
     * ⚠ 全文件**只有这一处**加厚：下面 refreshAllFeeds / refreshFeed 的两处 fetchNews 是每日
     *   10 次的常态动作，放大等于常态成本翻倍而用户几乎无感，刻意维持免费口径。
     * 真闸门在云函数（非会员改包要 40 也会被钳回 20），这里只是「要多少」。
     *
     * 免费档（批 2，2026-10-09）：**不发社交支线**，只走主线 10 条（`socialCount: 0` 会让
     * search.ts 连那一路请求都不发）。支线本是「锦上添花」（捞回被门户挤掉的一手发声），
     * 代价却是每次生成的检索调用翻倍、素材从 10 条涨到 18 条 —— 这笔常态开销不该压在免费档上，
     * 故把它收进会员的「质」权益（与 DEEP_* 同一方向）：免费档回到支线上线前的口径。
     * ⚠ 代价是免费档生成的报告（长尾人物往往只有这一份）少了社交维度，会员读到它时同样少 ——
     *   这是「共享缓存 + 免费共用」的必然；会员点「刷新最新」即可按自己的档位重生成一份厚的，
     *   且那一次免计费（见上方 memberUpgrade），所以会员并没有被免费档的产物锁死。
     */
    /*
     * 两路素材并行取（P1，2026-10-10「检索拆路」）：近期线 + 人物背景线。
     *
     * 为什么要两路：一条「近期新闻」查询答不了档案 / 履历 / 时间线 —— 出生地、学历、生平节点
     * 不进新闻流，30 天窗里天然搜不到（这几节此前常年为空的原因，详见 utils/search.ts#fetchBackground）。
     * 两路并行而非串行：单路 1~2s，串行会把首次生成的等待拉长近一倍。
     *
     * 判据仍然是主线：背景线返回 null（通道未就绪 / 上游失败）一律吞掉 —— 它只是补充，
     * 与社交支线同一个取舍。
     */
    /* 检索阶段（两路并行）：先播报再发起，否则「检索中」要等第一路回来才出现，白等一段 */
    emitProgress('search', 0)

    /*
     * 检索词规划（2026-10-11）：**先问模型「该查什么」，再拿这些词去查**。
     *
     * 为什么加在检索之前：查询词原本是模板里写死的句式（utils/report-toc.ts#SEARCH_LANES），
     * 冷门 / 低产人物常常「人名 + 通用后缀」一句什么都搜不到 —— 而模型知道这个人该问
     * 「毕业院校」还是「代言品牌」。规划这一步**不看任何检索结果**（此刻也还没有结果可看），
     * 它给的是「该查什么」，不是「查到了什么」；素材到手后照旧喂模型成文，
     * 报告侧「事实仅基于素材」的硬约束一个字都没动。
     *
     * 三条边界（详见 utils/search-plan.ts）：
     *   ① 规划失败 / 没给出可用词一律回落模板句式 —— 它是加分项，不该让任何一次生成失败；
     *   ② 走 aux 档（不占用户当日的生成额度，与消歧同一档）；
     *   ③ 只在真要查的几路上问词 —— 免费档不发社交支线（`socialCount: 0`），也就不问社交词。
     */
    const plan = await planSearchQueries(name, domain, {
      lanes: memberDeep ? ['news', 'social', 'profile'] : ['news', 'profile']
    })

    /* 免费档与会员档的文案口径见上方「批 2」注释；模型词单独走 planned（两档都有） */
    const mainOpts: NonNullable<Parameters<typeof fetchNews>[1]> = memberDeep
      ? { maxResults: DEEP_MAIN_COUNT, socialCount: DEEP_SOCIAL_COUNT }
      : { socialCount: 0 }
    mainOpts.planned = plan ?? undefined

    const [news, background] = await Promise.all([
      fetchNews(name, mainOpts),
      fetchBackground(name, memberDeep ? DEEP_BG_COUNT : BG_COUNT, plan?.profile)
    ])

    if (news === null || news.length === 0) {
      /*
       * 抓空了（注意**不是**通道故障）：先试一次「模型知识兜底」（C，2026-10-10）。
       * 产品要求是「付费的价值在查到的必须有内容」—— 全源都没抓到时的空手而归，正是最伤
       * 付费用户的那一种。检索侧的两层兜底（utils/search.ts 的降级阶梯、aiProxy 的 Bing
       * 第二源）此刻已经试完，到这里就是「确实没有公开素材」，只剩模型知识这一条路。
       *
       * 三条边界，都不是可选的：
       *   ① 只在 `news !== null`（**通道可用**）时试 —— 通道不通时 chat 多半也不通，且那时的
       *      成因是配置问题，硬塞一份知识版会把「通道坏了」掩盖成「查不到」；
       *   ② 产物带 `knowledgeOnly` 标记，页面明说「未经核实」，绝不与检索结果混为一谈；
       *   ③ **不写共享缓存**：`report_cache` 是**全站共享**的一行，把一份没素材的内容写进去，
       *      之后所有读者（包括本来能搜到素材的那些档位）都会读到它 —— 那是污染，不是兜底。
       */
      if (news !== null) {
        /*
         * 记一笔「该人物暂无素材」的作用域冷却（P1，2026-10-11；键位与判定见 utils/cooldown.ts
         * 与上方 1.2 节）。放在兜底**之前**：兜底成功还是失败，这一次都已经把全部检索源跑遍了
         * （utils/search.ts 的降级阶梯 + aiProxy 的第二源），重复跑一遍不会有不同结果。
         *
         * ⚠ 只在 `news !== null`（通道可用）时记：`news === null` 是**通道没就绪**，
         * 那是设备/配置问题，不该由「某个人物」来承担，而且下次进来本就该重新探测通道。
         */
        setScopedCooldown('search', personKey)
        const know = await buildKnowledgeFallback(personKey, name, focus)
        if (know.ok) {
          await release(personKey, userId)
          track('report_knowledge_fallback', { personKey })
          /* fromCache: false —— 这是刚生成的内容，不是缓存命中（口径与其它 report 分支一致） */
          return { kind: 'report', report: know.data, fromCache: false }
        }
      }
      // 无联网素材（搜索源不可用 / 抓取为空）：不生成，进引导态（§2.4）
      await release(personKey, userId)
      return { kind: news === null ? 'coldstart' : 'nonews' }
    }

    /* 素材到手、进入分批生成：先把阶段切到「生成 (0/4)」，避免第一批回来前一直停在「检索中」 */
    emitProgress('generate', 0)
    const res = await buildReport(personKey, name, news, focus, {
      member: memberDeep,
      background: background ?? [],
      /*
       * 分批生成：每批成功即落一次中间结果（best-effort，见 saveReportParts 的注释），
       * 并把「已完成几批」交给等待动画。先播报再落库：落库是库往返（几十~几百 ms），
       * 让进度先动起来，观感上不会「明明这一批写完了，界面还停在上一批」。
       */
      onPart: async (parts) => {
        emitProgress('generate', parts.length)
        await saveReportParts(personKey, parts, userId)
      }
    })
    if (!res.ok) {
      await release(personKey, userId)
      return (await cachedFallback(res.error, memberDeep)) ?? { kind: 'error', message: res.error }
    }
    if (isRefusedResult(res.data)) {
      await release(personKey, userId)
      return { kind: 'refused' }
    }
    /* let：shortfall 可重试时会自动重跑一次，重跑仍不达标则交回**最新那份**残版（更诚实） */
    let report = res.data

    /*
     * 落库前的两道判定共用同一份行快照（P0 / P1 修复，2026-10-09）：
     *
     * ① 「只升不降」必须在**覆盖之前**判 —— 这一行此刻还躺着上一版（acquire 不再清空
     *    report），落库之后就再也读不到了。
     * ② 「会员补齐」免计费申请也必须在**覆盖之前**发 —— 云函数 quotaGuard 复核的第三个
     *    条件是「那一行不含会员段落」（见 quotaGuard#memberUpgradeWaived）。原先端上先
     *    saveReady 再申请，复核读到的已是含会员段的新版，条件恒不成立，于是会员每次
     *    替全站升级缓存都被白扣一次每日次数。
     */
    const beforeWrite = await getRow(personKey)

    /*
     * 「只升不降」命中时交回既有那一版：上面那次提前判定与下方 saveReady 的兜底共用这一处，
     * 免得两个分支各写一遍身份剥离 —— 漏一处就是一处静默的越权（memberLocked 是促销条
     * 唯一的依据）。返回 null 表示那一行刚好不可用（极端：字段缺失的脏行），退路由调用方决定。
     *
     * 顺便把锁放掉：这一轮不写库，但锁是我们抢的。守卫修好之后这条路径**才第一次真正可达**
     * （此前恒不命中），所以「kept 之后 building 残留到超时」这个坑也是从这一刻起才存在的 ——
     * release 会把行退回 ready 并交还旧内容（P0，2026-10-09）。
     */
    const keptReport = async (rowLike: ReportCacheRow | null): Promise<ReportOutcome | null> => {
      if (!isUsable(rowLike)) return null
      await release(personKey, userId).catch(() => undefined)
      track('report_kept_member', { personKey })
      /*
       * 交回的是缓存里含会员段的那一版（正是本次被拦下的原因）：免费读者同样要剥 ——
       * 内容归会员，存在性留给促销条（memberLocked 非空，页面会说「已含对比视角…」）。
       */
      const shown = await exposeReport(rowLike.report, memberDeep)
      return {
        kind: 'report',
        report: shown.report,
        fromCache: true,
        keptMember: true,
        memberLocked: shown.locked
      }
    }

    if (!hasMemberBlocks(report) && shouldKeepMemberVersion(report, beforeWrite)) {
      /*
       * 被「只升不降」拦下（P0）：本次产物不含会员段落，而缓存里已有含会员段落的一版。
       * 交回既有那一版即可 —— 用户拿到的是它，本次生成没有生效，故**不计数**
       * （与缓存命中同一个口径：没拿到新东西就不该扣次数）。
       */
      diagLog('info', 'db', `拒绝降级覆盖：${personKey} 已有含会员段落的版本，保留原样`)
      const kept = await keptReport(beforeWrite)
      if (kept) return kept
      /* 快照刚好不可用（极端：字段缺失的脏行）：退化成普通生成照常计数，不能让用户白等一场还没报告 */
    }

    /*
     * 达标判定必须在**落库之前**（P0，2026-10-11）—— 这是本次流程重排的核心。
     *
     * 原顺序是「先 saveReady 落库，再判 shortfall」，于是**不达标的产物已经写进共享缓存了**，
     * 只是事后没扣次数。而 `report_cache` 是**全站共享、免费共用、ready 后长期复用且不自愈**的
     * 一行，两份守卫都拦不住这种情况：
     *   · 「只升不降」只认会员段（见 shouldKeepMemberVersion），管不了「完整版被降级纯文本覆盖」；
     *   · 云端 storeSave 的四道校验里同样没有质量维度。
     * 后果是叠乘的：一次上游抖动（四批全败 → report.ts 的 chatText 降级，degraded:true）产出的
     * 一段纯文本，会**覆盖掉该人物全站的完整报告**；此后所有读者（含会员）读到它，直到有人主动
     * 刷新；而这一轮又不计次数 ⇒ 没有任何人付代价、也没有任何机制推动修复。
     *
     * 重排后的语义（与原「不达标不计数」的承诺一致，只是把「不写」也补上）：
     *   · 不达标 ⇒ **不写共享缓存**（release 放锁；行上原有的旧版因此被保留），不计数，把本次产物
     *     交回给当前用户并由页面说明原因（页面文案见 pages/report 的 shortfall 分支）；
     *   · 达标 ⇒ 照原流程落库 + 计数。
     * 代价：缓存里没有旧版时，后续读者会重新生成一次 —— 可接受，因为上游抖动已经点着
     * utils/cooldown.ts 的 llm 冷却（report.ts 在失败批上 setCooldown），重复重建会被挡住。
     *
     * ⚠ 判定仍排在「只升不降」守卫**之后**（见上方那条 if）：本次产物较简略、而缓存里已有
     * 含会员段的完整版时，keep 掉旧版是严格更优的结果，不该被 shortfall 分支抢先。
     */
    /*
     * 达标判定 + 「值不值得重试」一次算齐（P2，2026-10-10）：shortfallVerdict 本来就返回
     * { reason, retryable } 二元组，拆成 reportShortfall / reportShortfallRetryable 两次调用会把
     * 同一份判定（遍历 dynamics/quotes/timeline 与会员段）白算两遍 —— 这里一次拿齐。
     */
    const verdict = shortfallVerdict(report, memberDeep)
    /* let：可重试时自动重跑一次，重跑仍不达标则交回最新那份（覆盖掉旧的 shortfall/retryable） */
    let shortfall = verdict?.reason ?? null
    let retryable = verdict?.retryable === true
    if (shortfall) {
      /*
       * 可重试时由系统自己重跑一次（P2，2026-10-11），而不是把残版推给用户再让他点「再试」。
       * retryable=true 的口径正是「这次是上游/网络抖动、重跑通常就好」（见 shortfallVerdict）——
       * 那正好是系统能自己兑现的：素材是刚抓到的，直接复用、**不重新检索**。只重跑这一次：
       * 重跑达标就走正常落库，仍不达标才落到下方的 shortfall 交回（非循环，不会有第二次重跑）。
       */
      if (retryable) {
        diagLog('info', 'db', `本次产物未达最低要求但可重试，自动重跑一次生成：${shortfall}`)
        track('report_generate_retry', { personKey, reason: shortfall, retryable: true })
        const retryRes = await buildReport(personKey, name, news, focus, {
          member: memberDeep,
          background: background ?? [],
          onPart: async (parts) => {
            emitProgress('generate', parts.length)
            await saveReportParts(personKey, parts, userId)
          }
        })
        if (retryRes.ok && !isRefusedResult(retryRes.data)) {
          const retryReport = retryRes.data
          /* 「只升不降」对重跑产物同样要守：重跑产物较简略、而缓存里已有会员完整版时，keep 旧版 */
          const retryBefore = await getRow(personKey)
          if (!hasMemberBlocks(retryReport) && shouldKeepMemberVersion(retryReport, retryBefore)) {
            const kept = await keptReport(retryBefore)
            if (kept) return kept
          }
          const retryVerdict = shortfallVerdict(retryReport, memberDeep)
          if (!retryVerdict) {
            /* 重跑达标：走正常落库 + 计数（finalizeAndReturn 是函数声明，见下方落库处） */
            return finalizeAndReturn(retryReport, news.length)
          }
          /* 重跑仍不达标：交回更诚实的最新那份残版，并带上新的判定理由 */
          report = retryReport
          shortfall = retryVerdict.reason
          retryable = retryVerdict.retryable === true
        }
      }
      /* tag 取 'db'：诊断标签只有 http/storage/auth/db/llm 五档，配额类日志一律归 db（同 utils/quota.ts） */
      diagLog('info', 'db', `本次产物未达最低要求：不写缓存、不消耗次数：${shortfall}（可重试：${retryable}）`)
      track('report_generate_shortfall', { personKey, reason: shortfall, retryable })
      /* 锁是我们抢的，这一轮不落库也必须放掉；release 会把行退回 ready 并交还旧内容 */
      await release(personKey, userId).catch(() => undefined)
      /*
       * 不写库了，但「只升不降」的意图仍要兑现：缓存里若已有含会员段的完整版，它比这份残版
       * **严格更优** —— 内容更全，而且用户已经为它付过一次费，交回它比交回残版对用户更好。
       *
       * 为什么要在 release 之后再判：keptReport 的 isUsable 要求 state==='ready'，而抢锁中的行
       * 是 'building'（这也是上面那条提前判定必须靠 saveReady 兜底生效的原因）。放锁之后这一行
       * 才是可复用的那一版，判定才有意义。keptReport 内部会再 release 一次 —— 幂等，可忽略。
       */
      const afterRelease = await getRow(personKey)
      if (!hasMemberBlocks(report) && shouldKeepMemberVersion(report, afterRelease)) {
        const kept = await keptReport(afterRelease)
        if (kept) return kept
      }
      /* 本次产物按**本次身份**过滤：免费读者不该从这份残版里读到会员段 */
      const shown = await exposeReport(report, memberDeep)
      return {
        kind: 'report',
        report: shown.report,
        fromCache: false,
        prev: prevReport,
        memberLocked: shown.locked,
        /* 只有不达标时才带：页面据此说明「这次没有扣次数」+「要不要再试」（见 ReportOutcome 两字段） */
        ...(shortfall ? { shortfall, shortfallRetryable: retryable } : {})
      }
    }

    /*
     * 达标落库 + 计数 + 返回。提取成**函数声明**（会提升）：shortfall 自动重跑达标时也要走这同一条
     * 落库/计费路径，避免重跑分支把下面 40 行再抄一遍（两处漏一处就是静默多扣或少扣次数）。
     * 参数 report 覆盖外层那个 `let report`（重跑达标时传的是 retryReport），函数体内只用参数。
     */
    async function finalizeAndReturn(report: Report, materialCount: number): Promise<ReportOutcome> {
      /* 免计费申请：必须在 upsert 之前，理由见上方 ② */
      if (memberUpgrade) {
        void consumeGenerateQuota(userId, { waiveIf: 'member_upgrade', target: personKey })
      }

      const saved = await saveReady(personKey, report, materialCount, userId)

      /*
       * saveReady 内部仍独立判一次同一份守卫（兜底）：正常路径下走不到这里 —— 上面已提前
       * 交回既有版本；真落到这里说明「快照」与「落库」之间那一行被换过（构建超时被他人抢占）。
       * 那种情况同样以「保住会员版」为准，交回缓存里的那一版。
       */
      if (saved === 'kept') {
        const kept = await keptReport(await getRow(personKey))
        if (kept) return kept
      }

      track('report_generate', { personKey, mode: 'realtime' })
      /*
       * 配额只在「用户真的拿到一份合格报告」时消耗（公平计费，口径见 utils/quota.ts 文件头）：
       *   上方的 refused / error / coldstart / nonews / shortfall 分支均已提前 return，不计数；
       *   缓存命中（第 0 步 / 抢锁失败等待他人构建）与上面的 kept 分支同样不计数；
       *   落库失败会抛到下面的 catch，此时用户拿不到报告 → 不计数（release 会把上一版交还）。
       * 2026-10-10 加严：**产物不达标同样不计数**（判定见 utils/report.ts#reportShortfall）——
       *   上游把模型调用搞挂了、或者只吐回一段降级文本，用户买的是报告而不是一次失败的尝试。
       *   best-effort：计数写失败不影响本次返回，少量丢失可接受（宁可少算不多算）。
       *   memberUpgrade 的那一次已在落库前申请（见上方 ②），此处不再重复申请。
       */
      if (!memberUpgrade) {
        void consumeGenerateQuota(userId)
      }
      /* 本次产物按**本次身份**过滤（批 1）：非会员生成的报告本就不含会员段 → 快路径直出、零额外读 */
      const shown = await exposeReport(report, memberDeep)
      return {
        kind: 'report',
        report: shown.report,
        fromCache: false,
        prev: prevReport,
        memberLocked: shown.locked
      }
    }
    return finalizeAndReturn(report, news.length)
  } catch (err) {
    await release(personKey, userId).catch(() => undefined)
    const message = err instanceof Error ? err.message : String(err)
    return (await cachedFallback(message, memberDeep)) ?? { kind: 'error', message }
  }
}

/**
 * force 刷新没拿到新版本时，该向用户解释什么（P1-8，2026-10-09）。
 *
 * 返回 `null` 表示这次拿到了新内容（或本来就没有旧内容可保留），页面不必提示。
 * 抽成纯函数是为了能直接钉住文案与「成功时不提示」这条不变量 —— 页面只负责把它渲染出来。
 */
export function refreshFailureNote(outcome: ReportOutcome): string | null {
  switch (outcome.kind) {
    case 'report':
      return outcome.refreshFailed ? outcome.refreshError || '刷新失败，继续显示当前版本' : null
    case 'coldstart':
      return '联网能力不可用，未能刷新，继续显示当前版本'
    case 'nonews':
      return '暂未检索到近期公开信息，未能刷新，继续显示当前版本'
    case 'refused':
      return '本次生成未通过内容校验，未能刷新，继续显示当前版本'
    case 'error':
      /* 「正在生成中」不是失败，是别人在生成：页面会切到等待态，不该再叠一句提示 */
      return outcome.message.includes('正在生成') ? null : outcome.message
  }
}

/* ===== 动态缓存 + 刷新配额（§3.7） ===== */

/**
 * 写 feed_cache（P0-2，2026-10-09：客户端已无写权限，只能走写口）。
 * 云端优先 + 回退直写；`rejected`（体积 / 形状被拒）**不回退** —— 与报告那条同一套判断，
 * 理由见 report-store.ts 文件头。返回是否真的写成功，供调用方决定要不要计入 refreshed。
 * 它比报告那条简单：feed 无锁、无会员差异，失败只影响「这次刷没刷成」，不影响已取到的 items。
 */
async function writeFeedCache(personKey: string, items: NewsItem[]): Promise<boolean> {
  const viaCloud = await saveFeedViaCloud(personKey, items)
  if (viaCloud === 'saved') return true
  if (viaCloud === 'rejected') return false

  const { error } = await table('feed_cache').upsert(
    { id: personKey, items, fetched_at: new Date().toISOString() },
    { onConflict: 'id' }
  )
  return !error
}

/** 只读缓存（不触发生成、不抢锁）：名人主页 / 关注流用 */
export async function getCachedReport(personKey: string): Promise<Report | null> {
  const row = await getRow(personKey)
  if (row?.state !== 'ready' || !row.report) return null
  /*
   * 只读路径同样按读者身份过滤（批 1）：调用方（关注流概览 / 名人主页）虽只用得到 heat、
   * generatedAt 这类公开字段，但**问答页会把报告正文当上下文喂给模型** —— 那是一条能问出
   * 会员段内容的旁路（「报告里对这个人的风险提示说了什么」），必须在出门前就掐掉。
   */
  return (await exposeReport(row.report)).report
}

/**
 * 批量只读缓存：一次 `in` 取回多人的报告，供「候选列表」这类**进来就要筛一遍**的场景用
 * （当前调用方是底部菜单「AI 提问」页，见 pages/ask）。
 *
 * 为什么不让调用方循环 getCachedReport：`report_cache` 以 personKey 为主键，逐个查是 N 次
 * 云数据库往返；而这个页面是 tabBar 页，每次切回来都会重跑 —— 8 个人就是 8 次往返，纯浪费。
 *
 * 命中判定与 getCachedReport **完全一致**（state=ready 且有 report），返回数组与入参一一对应、
 * 缺位为 null（调用方可直接 filter），读失败时同样退化为全 null 而不是抛错。
 */
export async function getCachedReports(personKeys: string[]): Promise<Array<Report | null>> {
  const keys = personKeys.filter(Boolean)
  if (keys.length === 0) return personKeys.map(() => null)

  const { data, error } = await table('report_cache').select('*').in('id', keys)
  if (error) {
    diagLog('warn', 'db', `report_cache 批量读取失败：${error.message ?? error}`)
    return personKeys.map(() => null)
  }

  const byId = new Map<string, ReportCacheRow>()
  for (const row of (data as ReportCacheRow[]) ?? []) byId.set(row.id, row)

  const ready = personKeys.map((k): Report | null => {
    const row = byId.get(k)
    return row?.state === 'ready' && row.report ? row.report : null
  })

  /*
   * 批量路径只读**一次**身份（批 1）：只要其中任何一份藏着会员段就值得这一次读，
   * 全都不藏（常见）则一次也不读 —— 与 getCachedReport 的快路径同一个取舍。
   * 逐份调 exposeReport 会变成 N 次 users 读（这个页是 tabBar 页，切回来就重跑）。
   */
  if (!ready.some((r) => r && hasMemberBlocks(r))) return ready
  const member = (await readMemberState()).member
  return member ? ready : ready.map((r) => (r ? stripMemberSections(r) : null))
}

export async function getFeed(personKey: string): Promise<NewsItem[]> {
  const detail = await getFeedDetail(personKey)
  return detail.items
}

/**
 * 关注流专用的详情版读取。
 *
 * getFeed 把「读失败」和「确实没有数据」都收敛成空数组，关注流因此无法区分二者，
 * 会把一次网络/权限故障渲染成「暂无公开动态」误导用户。这里额外带回 ok 与抓取时间。
 */
export async function getFeedDetail(
  personKey: string
): Promise<{ ok: boolean; items: NewsItem[]; fetchedAt: string | null }> {
  const { data, error } = await table('feed_cache').select('*').eq('id', personKey).maybeSingle()
  if (error) {
    diagLog('warn', 'db', `feed_cache 读取失败：${error.message ?? error}`)
    return { ok: false, items: [], fetchedAt: null }
  }
  const row = data as FeedCacheRow | null
  return { ok: true, items: row?.items ?? [], fetchedAt: row?.fetched_at ?? null }
}

/** 关注流详情（含 ok / 抓取时间），批量版与单人版返回同一个形状 */
export interface FeedDetail {
  /** false = 读取失败（与「这个人还没抓过」区分开，见 getFeedDetail 注释） */
  ok: boolean
  items: NewsItem[]
  fetchedAt: string | null
}

/** 批量读取的分片大小：一串过长的 `in` 条件会顶到云端查询的体积上限 */
const FEED_BATCH_KEYS = 50

/**
 * 批量读多位关注人的动态缓存（关注流、周报素材的公共入口）。
 *
 * 为什么要成批：这两个页面进入时都要对**每一位**关注人各读一行 feed_cache。
 * 逐人读 = N 次云数据库往返（每人还可能因内部 20 条分页再翻一次），关注十几位时
 * 就是十几路请求同时在飞，页面进得去但「要等一下」。一次 `in` 查询把 N 次压成 1 次，
 * 关注人数再多也只多几次翻页。
 *
 * 语义与 getFeedDetail 完全对齐，调用方不需要区分两个入口：
 *   - 整批读失败 → 该批所有人 `ok:false`（本次结果不完整，界面必须显式告知）；
 *   - 行不存在   → `ok:true` + 空 items（这是「还没抓过」这种确定的无内容）。
 * 返回 Map 按 personKey 取，**没有**这个人（未传或已取关）由调用方按失败处理。
 */
export async function getFeedDetails(personKeys: string[]): Promise<Map<string, FeedDetail>> {
  const out = new Map<string, FeedDetail>()
  const keys = [...new Set(personKeys.filter((k) => !!k))]
  if (keys.length === 0) return out

  for (let i = 0; i < keys.length; i += FEED_BATCH_KEYS) {
    const slice = keys.slice(i, i + FEED_BATCH_KEYS)
    const { data, error } = await table('feed_cache').select('*').in('id', slice)
    if (error) {
      diagLog('warn', 'db', `feed_cache 批量读取失败：${error.message ?? error}`)
      for (const k of slice) out.set(k, { ok: false, items: [], fetchedAt: null })
      continue
    }
    const byId = new Map<string, FeedCacheRow>()
    for (const row of (data as FeedCacheRow[]) ?? []) byId.set(row.id, row)
    for (const k of slice) {
      const row = byId.get(k)
      out.set(k, { ok: true, items: row?.items ?? [], fetchedAt: row?.fetched_at ?? null })
    }
  }
  return out
}

/**
 * 检查并消耗一次刷新配额（每账号/日：免费 10、会员 20，§3.8）。
 *
 * 计数优先走云函数 `quotaGuard` 原子自增；未部署时回退本地读-改-写。
 *
 * P2-30：判定改为**以云端为准**（云函数回报 `allowed` / `limit`）。此前端上把计数取回来
 * 自己比一遍 `count <= DAILY_REFRESH_LIMIT` —— 同一份业务规则存了两个副本，端上那份可被
 * 改包改掉，越界的尝试在云端也不留痕。现在云端说了算，端上只在「云函数不可用」时才用
 * 同源常量兜底（此时本就无法强判）。
 * 注意云端是「先自增、再判定」：已超限时再刷新会让计数多涨 1（只影响展示，
 * `remaining` 已夹到 0），闸门是否放行不受影响。
 *
 * 2026-10-10 起上限**按档位分叉**，于是云端的 `limit` 不再是一个常量：端上把它连同
 * `remaining` 一起回报给调用方（错误文案要写「已达上限（20 次）」而不能写死 10）。
 */
export async function consumeRefreshQuota(
  userId: string
): Promise<{ allowed: boolean; remaining: number; limit: number; unlimited: boolean }> {
  const real = await tallyRefreshQuota(userId)
  /*
   * 调试开关（见 utils/debug.ts）：关闭额度时**只放闸门、不改数字** ——
   * 计数照记（那是排查时最直接的证据，不该因为调试而丢失），remaining 也照实相减。
   *
   * 此前这里把 remaining 一并报成满额，理由是「避免出现『剩余 0 次』却仍能刷新的矛盾展示」。
   * 那条理由对**判定方**成立（调用方只看 allowed），但**展示方**会把「剩余 N 次刷新」
   * 直接写进提示文案给用户看 —— 报满额就是在骗他，而且骗得静默无声。
   * 这与生成侧 `peekGenerateQuota` 是同一个毛病（见 utils/quota.ts#GenerateQuotaSummary），
   * 两处一起改：数字照实，措辞交给 `unlimited` 决定。
   */
  return {
    allowed: REFRESH_QUOTA_DISABLED || real.allowed,
    remaining: real.remaining,
    limit: real.limit,
    unlimited: REFRESH_QUOTA_DISABLED
  }
}

/**
 * 端上「按身份」的抓取上限 —— 只在云端**没有**给出 limit 时兜底
 * （云函数未部署，或旧版云函数不返回 limit）。
 *
 * 判定权威始终是云端（它读 `memberships` 后按档回报 limit，端上直接采用）；
 * 这里读的 `users.membership` 只是界面镜像（见 utils/member.ts 顶部说明），
 * 且读失败一律按免费档 —— 宁可少给，也不因为一次读库异常放开上限。
 */
async function localRefreshLimit(): Promise<number> {
  try {
    return dailyRefreshLimit((await readMemberState()).member)
  } catch {
    return DAILY_REFRESH_LIMIT
  }
}

/** 刷新额度的真实口径：自增计数并据此判定（不感知调试开关）；`limit` 一并回报给展示用 */
async function tallyRefreshQuota(
  userId: string
): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const cloud = await incrQuotaViaCloud('refresh')
  if (cloud !== null) {
    /* P2-30：服务端给了判定就用它（`limit` 一并采用，顺带消掉两份常量漂移的风险）；
       老版本云函数不返回这两个字段 ⇒ 回落到**按身份**取的同源常量，行为与从前一致。 */
    const limit = typeof cloud.limit === 'number' ? cloud.limit : await localRefreshLimit()
    const allowed = typeof cloud.allowed === 'boolean' ? cloud.allowed : cloud.count <= limit
    return { allowed, remaining: Math.max(0, limit - cloud.count), limit }
  }

  /* 云函数不可用 → 端上回退读-改-写；上限同样按身份取（两端读的是同一份真源） */
  const id = `${userId}#${todayKey()}`
  const fallbackLimit = await localRefreshLimit()
  const { data, error } = await table('refresh_quota').select('*').eq('id', id).maybeSingle()
  if (error) diagLog('warn', 'db', `refresh_quota 读取失败：${error.message ?? error}`)
  const row = data as RefreshQuotaRow | null
  const count = row?.count ?? 0
  if (count >= fallbackLimit) {
    return { allowed: false, remaining: 0, limit: fallbackLimit }
  }
  if (!row) {
    await table('refresh_quota').insert({ id, count: 1 })
  } else {
    await table('refresh_quota').update({ count: count + 1 }).eq('id', id)
  }
  return { allowed: true, remaining: fallbackLimit - count - 1, limit: fallbackLimit }
}

/**
 * 关注流刷新的检索口径：**只走主线**（批 3，2026-10-09）。
 *
 * 与报告生成的方向相反：feed 只回答「谁有动静」—— 列表里是标题 / 来源 / 时间三样，
 * 不做任何分析。而社交支线（`include` 社交站点）是为**深度报告**捞一手发声用的，
 * 它对 feed 的增量价值是「多几行同样格式的标题」，代价却是每次刷新的检索调用翻倍
 * （10 人 × 2 路 = 20 次调用 / 次刷新，每日上限 10 次 ⇒ 单人日上限 200 次，
 * 这是全项目最大的一笔成本敞口）。故 feed 只保留主线 10 条，与免费档报告生成同口径。
 *
 * ⚠ 代价：feed_cache 的条目从约 18 条降到 10 条，关注周报（utils/weekly.ts）取材于它、
 *   素材相应变少。这是刻意取舍 —— 报告侧的深度不受影响，会员的「加厚检索」仍在
 *   报告生成那一处（DEEP_*），feed 不分档位（它不消耗生成额度，只消耗刷新次数）。
 */
const FEED_SEARCH_OPTS = { socialCount: 0 } as const satisfies Parameters<typeof fetchNews>[1]

/** 一次下拉刷新最多刷几位：决定单次刷新的花费上限（上限 10 次检索调用） */
const FEED_REFRESH_MAX_PERSONS = 10

/**
 * 单批并发数。一次检索约 1~2s，串行十个人就是十次往返相加（真机上几十秒，
 * 用户早就松手下拉手势并以为卡死）。取 4 而不是全量：单路检索的峰值并发本来只有 2，
 * 4 已经把它压到「批数 × 单次往返」；再高只是把上游限流撞在同一个瞬间。
 * 若博查 QPS 吃紧，**只调这一个数**（调回 1 即退回串行）。
 */
const FEED_REFRESH_BATCH = 4

/**
 * 挑出本次要刷的人：不超过上限就原样返回（绝大多数用户，零额外读）。
 *
 * 超过上限时按「最久没刷」优先。此前是 `follows.slice(0, 10)`，而 listFollows 按
 * followed_at **倒序**（最近关注的在最前）⇒ 关注第 11 位起的人**永远轮不到**，
 * 下拉刷新对他们等于无效，而页面上看不出任何区别。轮转只多一次批量读
 * （in 查询，与 getCachedReports 同一手法），且只在关注数超上限时才发生。
 * 从未刷过的（缓存里没有行）排最前 —— 那正是最该被抓一次的人。
 */
async function pickStalestFollows<T extends { person_key: string }>(
  follows: T[],
  max: number
): Promise<T[]> {
  if (follows.length <= max) return follows

  const { data, error } = await table('feed_cache')
    .select('*')
    .in(
      'id',
      follows.map((f) => f.person_key)
    )
  if (error) {
    /* 读不到就别挑：宁可轮转失效，也不能把这次刷新的目标弄成随机顺序 */
    diagLog('warn', 'db', `feed_cache 批量读取失败，退回关注顺序：${error.message ?? error}`)
    return follows.slice(0, max)
  }

  const at = new Map<string, string>()
  for (const row of (data as FeedCacheRow[]) ?? []) {
    if (row.fetched_at) at.set(row.id, row.fetched_at)
  }
  /* 空串（从未刷过）排最前；ISO 时间串按字典序即时间序 */
  return [...follows]
    .sort((a, b) => (at.get(a.person_key) ?? '').localeCompare(at.get(b.person_key) ?? ''))
    .slice(0, max)
}

/** 关注流下拉刷新：整次动作消耗 1 配额，刷新至多 FEED_REFRESH_MAX_PERSONS 位（按最久未刷新优先） */
export async function refreshAllFeeds(
  follows: Array<{ person_key: string; name: string }>
): Promise<{ ok: boolean; message: string; refreshed: number }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '未登录', refreshed: 0 }
  if (follows.length === 0) return { ok: true, message: '暂无关注', refreshed: 0 }
  /* 客户端不持有任何 Key，故这里判「云环境配了没」而非「用户填了没」 */
  if (!hasSearchChannel()) return { ok: false, message: '联网素材不可用，展示缓存动态', refreshed: 0 }

  const quota = await consumeRefreshQuota(userId)
  if (!quota.allowed) {
    return { ok: false, message: `今日刷新已达上限（${quota.limit} 次），明日再来`, refreshed: 0 }
  }

  const targets = await pickStalestFollows(follows, FEED_REFRESH_MAX_PERSONS)
  let refreshed = 0

  for (let i = 0; i < targets.length; i += FEED_REFRESH_BATCH) {
    const slice = targets.slice(i, i + FEED_REFRESH_BATCH)
    /* 一个人失败不影响同批其他人（各自 catch 成 null），也不影响后续批次 */
    const settled = await Promise.all(
      slice.map((f) =>
        fetchNews(f.name, FEED_SEARCH_OPTS)
          .then((news) => ({ f, news }))
          .catch((err) => {
            diagLog('warn', 'http', `feed 刷新失败（${f.name}）：${String(err)}`)
            return null
          })
      )
    )
    for (const hit of settled) {
      if (!hit?.news || hit.news.length === 0) continue
      /* 写口优先（P0-2）：失败只影响「这次刷成没刷成」，已取到的 items 不受影响 */
      if (await writeFeedCache(hit.f.person_key, hit.news)) refreshed++
      else diagLog('warn', 'db', `feed_cache 写入失败（${hit.f.name}）`)
    }
  }

  /*
   * 埋点报**真正刷成的人数**（与返回值同一个数）。原先写的是 follows.length ——
   * 关注 20 位而只刷 10 位时会记成 20，拿它评估成本会系统性高估一倍。
   */
  track('refresh_feed', { count: refreshed })

  /* 关注数超上限时如实说明只刷了一部分：否则用户以为全部更新过了，
     而名单上没动静的那几位会被当成「确实没新闻」（静默丢信息） */
  const partial =
    targets.length < follows.length ? `（本次刷新 ${targets.length} 位，按最久未刷新优先）` : ''
  return {
    ok: true,
    /* 开挂态不报剩余次数：数字是真的（remaining 已照实），但「剩 N 次」这句话在闸门放开时
       已不成立（见 consumeRefreshQuota 的 unlimited） */
    message: `已刷新 ${refreshed} 位名人${partial}${
      quota.unlimited ? '' : `（剩余 ${quota.remaining} 次刷新）`
    }`,
    refreshed
  }
}

/**
 * 单人刷新：配额 → 检索 → feed_cache 更新。
 *
 * 检索口径与批量刷新**必须一致**（只走主线，见 FEED_SEARCH_OPTS）：两者写的是同一张
 * feed_cache，口径若不同，同一个人在「下拉刷新」与「单独刷新」后拿到的条目数会不一样，
 * 而用户无从理解为什么（一个 10 条、一个 18 条）。
 */
export async function refreshFeed(
  personKey: string,
  name: string
): Promise<{ ok: boolean; message?: string; items?: NewsItem[] }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '未登录' }
  if (!hasSearchChannel()) return { ok: false, message: '联网素材不可用' }

  const quota = await consumeRefreshQuota(userId)
  if (!quota.allowed) {
    return { ok: false, message: `今日刷新已达上限（${quota.limit} 次），明日再来` }
  }

  /* 口径与批量刷新一致（只走主线，见 FEED_SEARCH_OPTS）：两处写的是同一张 feed_cache */
  const news = await fetchNews(name, FEED_SEARCH_OPTS)
  if (!news) return { ok: false, message: '联网素材不可用' }
  /* 开挂态（quota.unlimited）不报剩余次数：理由同 refreshAllFeeds（见 consumeRefreshQuota） */
  const left = quota.unlimited ? '' : `（剩余 ${quota.remaining} 次刷新）`
  if (news.length === 0) return { ok: true, items: [], message: `暂无新动态${left}` }

  await writeFeedCache(personKey, news)
  /* count: 1 —— 批量刷新报的是人数，这里保持同一字段可比（否则同一事件两种口径） */
  track('refresh_feed', { personKey, count: 1 })
  return { ok: true, items: news, message: `已更新${left}` }
}
