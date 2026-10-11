import { setCooldown } from './cooldown'
import { debugRaw } from './debug'
import { diagLog } from './cloud-diagnostics'
import { callCloudFunction, isCloudConfigured } from './cloud'
import { SEARCH_COUNTS } from '../config/benefits'
import { cleanText } from './text'
/* 关键词与站点白名单的唯一真源：报告模板的分组声明（见 utils/report-toc.ts#SEARCH_LANES） */
import { SEARCH_LANES, SearchLane } from './report-toc'

/** 检索结果条目（附录 A） */
export interface NewsItem {
  title: string
  url: string
  content: string
  source: string
  /** 结果自带的发布时间（用于 N30/N7 计数，§1.6） */
  publishedDate?: string
}

/** 博查 {url} 的主机名，用作 NewsItem.source 的兜底（siteName 缺失时） */
function hostOf(url: string): string {
  try {
    return url.replace(/^https?:\/\//, '').split('/')[0]
  } catch {
    return url
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * days → 博查 freshness 档位。
 * 博查只提供预设档位（oneDay/oneWeek/oneMonth/oneYear/noLimit），不支持任意天数，
 * 因此向上取更宽的档位（宁可多取再本地裁剪，好过取窄档漏掉素材）。
 */
function freshnessOf(days: number): string {
  if (days <= 1) return 'oneDay'
  if (days <= 7) return 'oneWeek'
  if (days <= 30) return 'oneMonth'
  if (days <= 365) return 'oneYear'
  return 'noLimit'
}

/**
 * 时间规范化：博查返回的日期串格式不固定（可能带时区、也可能只有日期），统一成 ISO。
 * report.ts 用 Date.parse 统计 N7，不可解析的值会让该条静默出局，
 * 因此解析失败直接返回 undefined——宁可不计数，也不要一个错值。
 */
function normDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/**
 * 博查单条结果 → NewsItem（字段固定，取值全部兜底，避免脏数据穿透到报告层）。
 *
 * 文本字段一律过 cleanText({ markup: true })：上游（搜索引擎）会给命中词加 `<em>` 高亮、
 * 把 `&` 写成 `&amp;`、顺手夹带零宽字符，不清掉就会被模型照抄进报告，用户看到的是一串标签。
 * 这一步放在**素材入口**而不是报告出口，是因为素材还要进提示词 —— 脏字符一旦进了上下文，
 * 就会以各种形态被抄出来，出口再拦只能拦到抄剩的那部分。
 *
 * url 刻意不清洗：它是出处的比对键（见 report.ts#buildSourceIndex），改动它等于让出处对不上。
 */
function toNewsItem(r: Record<string, unknown>): NewsItem {
  const url = typeof r.url === 'string' ? r.url : ''
  /* summary 是详细摘要、snippet 是短摘，前者更适合喂给 LLM */
  const content = cleanText(r.summary, { markup: true }) || cleanText(r.snippet, { markup: true })
  return {
    title: cleanText(r.name, { markup: true }),
    url,
    content,
    /* siteName 比裸域名可读，缺失时回落 host */
    source: cleanText(r.siteName, { markup: true }) || hostOf(url),
    publishedDate: normDate(r.datePublished) ?? normDate(r.dateLastCrawled)
  }
}

/* 检索重试次数与条数上限：数值在 config/benefits.ts 的 SEARCH_COUNTS（改那里即改策略） */
const MAX_ATTEMPTS = SEARCH_COUNTS.maxAttempts
/**
 * 与云函数 runSearch 的 count 上限对齐（免费 20 / 会员 40，见 aiProxy 的 SEARCH_MAX）。
 *
 * 端上取的是**两者中大的那个**：这一层只决定「要多少」，真正按身份钳住的是云函数
 * （免费用户即便改包要 40 也会被钳回 20）。若这里仍写死 20，深度模式就永远要不到加厚的那部分。
 */
const MAX_RESULTS_CAP = SEARCH_COUNTS.maxResultsCap

interface SearchParams {
  query: string
  freshness: string
  count: number
  /** 站点限定（§1.4 V1.5 多源分域）：仅支线检索使用，主线不传 */
  include?: string[]
}

/** 单次尝试的结果：成功给出上游原始 pages，失败标明「是否值得重试」 */
type PagesAttempt =
  | { ok: true; pages: Array<Record<string, unknown>> }
  | { ok: false; error: string; retryable: boolean }

/*
 * 这里曾有一条「本机 Key 直连博查」通道（BYOK，Taro.request 直打 api.bochaai.com），
 * 已随大模型本机通道一并移除，全项目只保留云函数代理，用户零配置。
 *
 * 随之退役的上游知识（日后要排查请去云函数侧看）：
 *   实测 403 最常见成因是账号没绑资源包 / 额度用尽，key 本身是好的；
 *   失败正文在顶层且字段名是 message（不是 msg），code 是**字符串**；
 *   正文里的 log_id 是找博查客服时唯一有用的凭据。
 * 这些现在都由 aiProxy 的 runSearch 解析成 kind / error 后回传，端上不再直接面对上游报文，
 * 也就不能再靠 HTTP 状态码分流 —— 重试与否统一看云函数给出的 kind。
 */

/**
 * 上游响应结构摘要（对应 cloudfunctions/aiProxy 的 probeOf，只有键名与条数）。
 *
 * 用途单一：回答「博查返不返回图片/视频、字段叫什么」。博查的图片在 `data.images.value`、
 * 视频在 `data.videos.value`，与 `webPages` **同级**，而云函数只把 webPages 交给端上，
 * 于是这件事在端上原本看不到 —— 要往报告里加图/视频，得先看这一眼，别凭猜写 schema。
 */
interface SearchProbe {
  dataKeys: string[]
  pageKeys: string[]
  images: number
  imageKeys: string[]
  videos: number
  videoKeys: string[]
}

/** 云函数 search 动作的返回结构（对应 cloudfunctions/aiProxy 的 runSearch） */
interface ProxySearchResult {
  ok: boolean
  pages?: Array<Record<string, unknown>>
  kind?: string
  error?: string
  probe?: SearchProbe
}

/** 值得重试的 kind：上游 5xx / 业务错误码 / 网络层失败 */
const RETRYABLE_KINDS = new Set(['upstream', 'network'])

/**
 * 唯一的检索通道：云函数代理（平台代付）。
 * 客户端不持有任何 key，博查由 aiProxy 用服务端环境变量代打，上游失败已被消化成 kind。
 *
 * 返回 null = 「通道未就绪」，对齐 fetchNews 的降级语义（null → 读共享缓存 → 引导态）：
 * 函数没部署（-501000）、云环境没配、或函数部署了但环境变量为空，都属于
 * 「平台没把这条通道准备好」，不该让用户看到一句像是故障的报错。
 * 注意这与「通道可用但请求失败」（返回 ok:false）严格区分：后者要重试、冷却或抛出。
 */
async function pagesViaPlatform(params: SearchParams): Promise<PagesAttempt | null> {
  let res: ProxySearchResult | null
  try {
    res = (await callCloudFunction('aiProxy', {
      action: 'search',
      query: params.query,
      freshness: params.freshness,
      count: params.count,
      /* 不传 include 时不发该字段：云函数侧据此保持与改造前完全一致的上游请求 */
      ...(params.include ? { include: params.include } : {})
    })) as ProxySearchResult | null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'http', `平台检索通道不可用：${msg}`)
    return null
  }

  /* 调试打印：云函数 search 动作的完整返回（pages 数组较长，交给 Console 折叠展开） */
  debugRaw('bocha:proxy', res)

  if (!res || res.ok !== true) {
    /*
     * 三种「通道未就绪」，都不是检索故障，统一走降级，避免甩给用户一句无从下手的报错：
     *   函数没部署（callCloudFunction 已抛错，见上）、函数在但额度没配（unconfigured）、
     *   函数是只认 action='test' 的旧版（返回「未知 action」——需要重新部署云函数）。
     */
    if (!res || res.kind === 'unconfigured' || res.error?.includes('未知 action')) {
      diagLog('warn', 'http', `平台检索通道未就绪：${res?.error ?? '云函数无返回值'}`)
      return null
    }
    const msg = res.error || '平台检索失败'
    const kind = res.kind ?? ''
    if (kind === 'rate') setCooldown('search')
    diagLog('warn', 'http', `平台检索失败（${kind}）：${msg}`)
    return { ok: false, error: msg, retryable: RETRYABLE_KINDS.has(kind) }
  }

  /*
   * 上游响应结构记一笔（一报告两次检索 = 两行）：加图/加视频之前先看这行 ——
   * images / videos 为 0 就说明「该套餐或该请求根本没有媒体结果」，不必往报告 schema 上加字段；
   * 非 0 时 imageKeys 直接告诉我们字段叫什么（thumbnailUrl？contentUrl？width/height？）。
   */
  if (res.probe) diagLog('info', 'http', '检索响应结构', res.probe as unknown as Record<string, unknown>)
  return { ok: true, pages: res.pages ?? [] }
}

/**
 * 是否有可用检索通道。只剩云函数代理一条，故这里只反映「云环境 ID 配了没」——
 * 函数是否真部署好、环境变量 BOCHA_API_KEY 是否真配了，只有调一次才知道。
 * 调用方（刷新配额的前置检查）用它避免「明明能用却被拦下」，真失败由 fetchNews 的返回值兜住。
 */
export function hasSearchChannel(): boolean {
  return isCloudConfigured
}

/**
 * 单路检索（含重试），对应改造前的整个 fetchNews。
 *
 * 单一通道：云函数代理（平台代付，用户零配置，见 cloudfunctions/aiProxy 的 runSearch）。
 * 用户不需要申请博查账号 —— 这是「联网能力开箱可用」的关键。
 *
 * 返回 null 表示「平台检索通道未就绪」（降级：读共享缓存，无则引导态，§2.4），
 * 与「通道可用但请求失败」（抛出）严格区分，调用方据此走 coldstart 还是报错。
 *
 * 错误策略（§5.4 用例 9），全部依据云函数回传的 kind：
 *   upstream / network → 重试 2 次（1s/2s 指数退避）；
 *   rate 限流 → 不重试，进入 10 分钟冷却；
 *   其余（密钥无效 / 额度不足等配置类）→ 重试无意义，直接抛出。
 */
async function requestChannel(params: SearchParams): Promise<NewsItem[] | null> {
  let lastError = '搜索源请求失败'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await pagesViaPlatform(params)

    if (result === null) return null // 无可用通道：降级，不算错误
    if (result.ok) {
      /* 无 url 的条目无法溯源，报告白名单也会剔除它，这里先丢掉以免虚占 N30 计数 */
      return result.pages.map(toNewsItem).filter((n) => n.url)
    }

    lastError = result.error
    if (!result.retryable) break
    diagLog('warn', 'http', `检索失败（第 ${attempt} 次）：${lastError}`)
    if (attempt < MAX_ATTEMPTS) await sleep(1000 * 2 ** (attempt - 1))
  }
  throw new Error(lastError)
}

/*
 * 三条检索路（近期主线 / 社交一手发声 / 人物背景线）的**关键词与站点白名单都写在报告模板里**
 * （utils/report-toc.ts#SEARCH_LANES）：模板才是「报告由哪些节组成」的真源，素材需求随之。
 * 本文件一个关键词字面量都不留 —— 否则模板加了节、关键词还停在旧句子上，症状是
 * 「新节的素材从没被查过」，而页面上「没查」与「查了没有」长得一模一样。
 * 这里只取引用（且取的是**对象本身**，不在模块初始化时抽出字符串，测试才能改模板验证）。
 */
const NEWS_LANE = SEARCH_LANES.news
const SOCIAL_LANE = SEARCH_LANES.social
const PROFILE_LANE = SEARCH_LANES.profile

/**
 * 按模板声明的路取博查 freshness 档。
 *
 * `evergreen` 路固定 noLimit（履历不随时间变，窗口越窄越搜不到）；`recent` 路把天数交给
 * 调用方的阶梯（fetchNews 逐档放宽，见 SEARCH_COUNTS.mainFreshnessLadderDays）。
 * 默认值给最宽的一年：万一哪条路被改成 recent 却没人传天数，宁可宽一点也别窄到搜不到。
 */
function laneFreshness(lane: SearchLane, days = 365): string {
  return lane.freshness === 'evergreen' ? 'noLimit' : freshnessOf(days)
}

/* 主线 / 支线 / 深度档条数：数值在 config/benefits.ts 的 SEARCH_COUNTS（改那里即改策略） */
/** 支线条数：够补齐社交维度即可，不为支线付主线的检索成本 */
const SOCIAL_COUNT = SEARCH_COUNTS.socialCount
/** 主线默认条数（免费口径，与改造前一致） */
const MAIN_COUNT = SEARCH_COUNTS.mainCount

/**
 * 深度模式的检索厚度（O-11「质」权益，2026-10-07）：只在**报告生成路径**使用。
 *
 * 为什么是 24 + 16：两条链路各自独立过云函数的 count 钳制，合起来正好吃满给会员的
 * MEMBER_SEARCH_MAX（40），不越界、也留不出「要了却拿不到」的空档。
 * 为什么只加厚生成：报告是「一次生成、长期缓存」的资产，加厚一次能长期受益；
 * 关注流刷新是每日 10 次的常态动作，放大等于常态成本翻倍且用户几乎无感（见 cache.ts 的应用点）。
 */
export const DEEP_MAIN_COUNT = SEARCH_COUNTS.deepMainCount
export const DEEP_SOCIAL_COUNT = SEARCH_COUNTS.deepSocialCount

/* 背景线条数：数值在 config/benefits.ts 的 SEARCH_COUNTS（改那里即改策略） */
/** 免费档背景线条数：够补出档案与时间线即可，不为「一次生成」付两次深度检索的钱 */
export const BG_COUNT = SEARCH_COUNTS.bgCount

/** 会员档背景线条数（随深度模式一并加厚） */
export const DEEP_BG_COUNT = SEARCH_COUNTS.deepBgCount

/** 按 url（去锚点）去重合并：主线在前，支线补充在后 */
function mergeNews(groups: Array<NewsItem[] | null>): NewsItem[] {
  const seen = new Set<string>()
  const out: NewsItem[] = []
  for (const group of groups) {
    for (const item of group ?? []) {
      const key = item.url.split('#')[0]
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

/**
 * 博查检索适配器（附录 A）：主线 + 社交支线两路并发，合并去重后交给报告层。
 *
 * 两路并发而非串行：单路约 1~2s，串行会把整次生成的等待拉长近一倍。
 * 支线是「锦上添花」，失败一律吞掉 —— 上游不认 include（报错或空集）、支线被限流，
 * 都只是拿不到社交维度，结果等价于改造前；只有主线才是判据。
 * 代价是每次生成由 1 次博查调用变为 2 次（成本相关取舍见《开发计划.md》§七 待办 14）。
 *
 * `socialCount: 0` = 明确不要支线（批 2，2026-10-09）：**连那一路请求都不发**。
 * 免费档生成走这条（应用点见 cache.ts）—— 钱花在「发起了一次检索」上，
 * 只把条数降到 0 而不跳过请求是省不下钱的。
 * 于是支线成了会员「质」权益的一部分（与 DEEP_* 同一方向）：免费档回到支线上线前的口径
 * （1 次调用 + 主线 10 条），会员档才是 2 次调用 + 40 条。
 */
export async function fetchNews(
  name: string,
  opts: { days?: number; maxResults?: number; socialCount?: number } = {}
): Promise<NewsItem[] | null> {
  const count = Math.min(opts.maxResults ?? MAIN_COUNT, MAX_RESULTS_CAP)
  const days = opts.days ?? 30

  /*
   * 主线走**降级阶梯**（2026-10-10）：一档抓空就试下一档，直到有内容为止。
   *
   * 为什么：此前只有单档（「人名 + 模板 news 路的句式」@ 30 天），而冷门 / 低产名人的报道常是
   * 「半年内有过、近 30 天没有」—— 单档配置下直接空手而归，用户看到「暂未检索到公开信息」。
   * 对**付费**用户尤其不可接受：他买的就是「查得到」。
   *
   * 各档的取舍：
   *   ① 原句式 + 原时间窗（绝大多数人物在这一档就结束，命中率最高）；
   *   ② **去掉后缀只留人名** —— 博查对纯人名的召回常好于「人名 + 后缀词」，
   *      后缀词把排序拉向「新闻体」标题，反而会挤掉一手内容；
   *   ③ 放宽到一年（天数值见 config/benefits.ts 的 SEARCH_COUNTS.mainFreshnessLadderDays）。
   *
   * ⚠ 只放宽到「年内」为止：`dynamics` 要的是近期动态，`noLimit` 会把年代久远的事件混成
   *   「近期」—— 那比空着更糟（与背景线用 noLimit 是两回事，那条只捞履历、不进 dynamics）。
   * 成本：只有上一档为空时才发下一档，正常人物仍是 1 次调用；最坏 3 次。
   */
  const ladder = SEARCH_COUNTS.mainFreshnessLadderDays
  let main: NewsItem[] = []
  for (let i = 0; i < ladder.length; i++) {
    /* 第一档用调用方给的时间窗（days），之后按阶梯放宽；句式取自模板的 news 路 */
    const pages = await requestChannel({
      query: i === 0 ? `${name} ${NEWS_LANE.keywords}` : name.trim(),
      freshness: laneFreshness(NEWS_LANE, i === 0 ? days : ladder[i]),
      count
    })
    /* null = 通道未就绪（不是「抓空了」）：换句式也一样，交回调用方走 coldstart */
    if (pages === null) return null
    main = pages
    if (pages.length > 0) break
  }

  /* 不要支线：只发主线这一路（成本口径见函数头注释） */
  const socialCount = Math.min(opts.socialCount ?? SOCIAL_COUNT, MAX_RESULTS_CAP)
  if (socialCount <= 0) return mergeNews([main, null])

  const social: SearchParams = {
    query: `${name} ${SOCIAL_LANE.keywords}`,
    freshness: laneFreshness(SOCIAL_LANE, days),
    count: socialCount,
    /* 站点白名单同样取自模板；没声明就整条不传（传空数组会被上游读成「一个站都不许」） */
    ...(SOCIAL_LANE.include && SOCIAL_LANE.include.length > 0 ? { include: SOCIAL_LANE.include } : {})
  }

  /* 支线是「锦上添花」：失败一律吞掉，主线才是判据（见函数头注释） */
  const socialNews = await requestChannel(social).catch((err) => {
    diagLog('warn', 'http', `社交源定向检索跳过：${err instanceof Error ? err.message : String(err)}`)
    return null
  })

  return mergeNews([main, socialNews])
}

/**
 * 人物背景线（P1，2026-10-10）：专供 profile / relations / timeline 这三节，**不进 dynamics**。
 *
 * 与 fetchNews 的分工：
 *   · fetchNews —— 「近期」语义（freshness 30 天），用户消息里的「素材」段，喂动态 / 名言 / 争议；
 *   · 本函数 —— 「不限时间」语义（noLimit），用户消息里单独的「人物背景资料」段，喂档案 / 关系 / 履历。
 * 拿近期窗口去找出生地、学历，等于用错尺子（这也正是这几节此前常年为空的原因）。
 * 句式与时间语义都取自模板的 profile 路（utils/report-toc.ts#SEARCH_LANES）：它是
 * 「履历不进新闻流」这件事的声明处，改关键词去那一处改，本文件不留字面量。
 *
 * 降级语义：`count <= 0` 返回空数组（调用方完全不启用这一路）；
 * 通道未就绪返回 null；请求失败一律吞掉返回 null —— 背景线是**补充**，主线才是判据，
 * 它挂了只是「这几节没有内容」，不该让整次生成失败（与社交支线的取舍一致）。
 */
export async function fetchBackground(name: string, count: number): Promise<NewsItem[] | null> {
  const want = Math.min(count, MAX_RESULTS_CAP)
  if (want <= 0) return []
  try {
    return await requestChannel({
      query: `${name} ${PROFILE_LANE.keywords}`,
      freshness: laneFreshness(PROFILE_LANE),
      count: want
    })
  } catch (err) {
    diagLog('warn', 'http', `人物背景线检索跳过：${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** 问答联网检索的条数：够补「报告之后发生了什么」即可，不为一次提问付生成级的检索成本 */
const ASK_COUNT = SEARCH_COUNTS.askCount
/** 问答联网检索的时间窗：用户问的往往是「最近」，而报告可能已经是两周前的快照 */
const ASK_FRESHNESS_DAYS = SEARCH_COUNTS.askFreshnessDays

/**
 * 问答的「联网检索」补充（2026-10-08，供 utils/qa.ts 的联网补充调用）。
 *
 * 同一条通道、同一套重试与冷却，只是**用量口径不同**：
 *   - 只走主线，不拆社交支线 —— 问题本身已经带了具体指向（谁 + 问什么），
 *     再拆一路社交定向只是让每次提问的成本与耗时翻倍，收益远小于生成那条链路；
 *   - 条数少（8）、时间窗窄（最近 7 天）：这一路补的就是「报告生成之后的新情况」，
 *     按 30 天去取等于把报告里已有的旧闻再买一遍。
 *
 * 降级语义与 fetchNews 完全一致：返回 null = 通道未就绪，失败抛出。
 * 调用方（utils/qa.ts）一律吞掉并退回「只依据报告作答」—— 联网是加分项，
 * 不能让一次提问因为检索不通而彻底失败。
 */
export async function searchForAsk(query: string): Promise<NewsItem[] | null> {
  return requestChannel({
    query,
    freshness: freshnessOf(ASK_FRESHNESS_DAYS),
    count: Math.min(ASK_COUNT, MAX_RESULTS_CAP)
  })
}

/** 热度计数（§1.6 公式的 N30/N7 输入）：norm(N) = min(1, log10(1+N)/2) */
export function heatValue(n30: number, n7: number): number {
  const norm = (n: number) => Math.min(1, Math.log10(1 + Math.max(0, n)) / 2)
  return Math.round(60 * norm(n30) + 40 * norm(n7))
}
