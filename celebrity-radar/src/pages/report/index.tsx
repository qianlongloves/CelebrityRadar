import { useCallback, useEffect, useRef, useState } from 'react'
import Taro, { useDidShow, useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtButton } from 'taro-ui'
import { DOMAIN_COVERAGE_TEXT, DOMAIN_META, DomainCode } from '@/config/domains'
import { FOCUS_META, FocusCode, isFocusCode } from '@/config/filters'
import EmptyState from '@/components/empty-state'
import QuoteDetail from '@/components/quote-detail'
import ReportLoading from '@/components/report-loading'
import { getOrBuildReport, getCachedReports, ReportOutcome } from '@/utils/cache'
import { hasSearchChannel } from '@/utils/search'
import { hasLlmChannel } from '@/utils/llm'
import { Report } from '@/utils/report'
import { extractKeywords, extractQuoteThemes } from '@/utils/keywords'
import { buildComparison } from '@/utils/compare'
import { buildHeatTrend, TrendPoint } from '@/utils/trend'
import { buildRiskSignals, RISK_CATEGORIES, RISK_CATEGORY_LABEL, RISK_FROM_LABEL } from '@/utils/risk'
import { buildReportToc } from '@/utils/report-toc'
import { buildCommercialSummary, MIN_AXES } from '@/utils/commercial'
import {
  favoriteQuote,
  favoriteReport,
  listFavorites,
  makeFavoriteId,
  removeFavorite
} from '@/utils/favorites'
import { isFollowed, toggleFollow } from '@/utils/follows'
import { isMonitored, listPersonWatches, monitorPerson, unmonitorPerson } from '@/utils/risk-watch'
import { addHistory } from '@/utils/history'
import {
  dismissPromo,
  isPromoDismissed,
  promoRoll,
  readMemberState,
  reportMemberPromo
} from '@/utils/member'
import { personShareTitle, reportSharePath } from '@/utils/share'
import { openSourceLink } from '@/utils/source-link'
import { useAuth } from '@/stores/auth'
import { fromNow, formatDay, isStaleReport, reportAgeDays } from '@/utils/time'
import './index.scss'

/** 深度报告页（§2.3 六段渲染 + §2.4 全部边界态） */
type PageState =
  | { phase: 'loading' }
  | { phase: 'waiting' } // 他人 building，轮询中
  | { phase: 'coldstart' }
  | { phase: 'nonews' }
  | { phase: 'refused' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; report: Report; fromCache: boolean }

const SENTIMENT_META: Record<string, { label: string; cls: string }> = {
  positive: { label: '积极', cls: 'positive' },
  neutral: { label: '中性', cls: 'neutral' },
  negative: { label: '消极', cls: 'negative' }
}

/**
 * 话题态度标签（M4-4）。措辞刻意区别于上面那组 —— 动态标的是单条报道的**情绪**，
 * 这里标的是话题上的**舆论态度**（认可 / 质疑 / 两极），两者不是同一件事。
 */
const STANCE_META: Record<string, { label: string; cls: string }> = {
  positive: { label: '认可', cls: 'positive' },
  neutral: { label: '中性', cls: 'neutral' },
  negative: { label: '质疑', cls: 'negative' },
  mixed: { label: '两极', cls: 'mixed' }
}

/**
 * 关系图谱的类别标签（第二批）。枚举在 utils/report.ts 的 RelationKindEnum 里归一 ——
 * 认不出的值在那里就被折成 other，故这里兜底也写「其他」，两边口径一致。
 * 四档标签一律用同一套中性样式（不因「对手」染红）：报告只陈述关系，关系本身没有褒贬。
 */
const RELATION_META: Record<string, string> = {
  cooperate: '合作',
  mentor: '师承',
  rival: '对手',
  other: '其他'
}

/* ===== 热度趋势折线（M4-6）：绘图区几何 ===== */

/**
 * 绘图区尺寸（rpx）：750 - 卡片左右外边距 32×2 - 卡片内边距 28×2 = 630。
 * 宽高都取固定 rpx（而不是量测容器）是因为线段旋转角度依赖真实宽高比，
 * 而 rpx 是等比缩放 —— 用设计稿尺寸算出来的角度在任何机型上都成立。
 */
const TREND_PLOT_W = 630
const TREND_PLOT_H = 220
/** 上下留白：峰值点的圆心落在顶边时，点本身会被裁掉一半 */
const TREND_PAD_Y = 14

/**
 * 把趋势点换算成绘图区内的 rpx 坐标与线段参数（View + transform 自绘，不用 canvas）。
 * 返回值直接进 style：点是中心坐标（CSS 里用负 margin 抵消半径），线段以左端为旋转原点。
 */
function trendGeometry(points: TrendPoint[]) {
  const usable = TREND_PLOT_H - TREND_PAD_Y * 2
  const nodes = points.map((p) => ({
    ...p,
    cx: p.x * TREND_PLOT_W,
    cy: TREND_PAD_Y + (1 - p.ratio) * usable
  }))
  const segs: Array<{ left: number; top: number; len: number; deg: number }> = []
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const a = nodes[i]
    const b = nodes[i + 1]
    const dx = b.cx - a.cx
    const dy = b.cy - a.cy
    segs.push({
      left: a.cx,
      top: a.cy,
      len: Math.sqrt(dx * dx + dy * dy),
      deg: (Math.atan2(dy, dx) * 180) / Math.PI
    })
  }
  return { nodes, segs }
}

/**
 * 取链接的可读域名。
 *
 * 小程序内无法直接打开任意外部网页：web-view 要求目标域名先在小程序后台登记为业务域名，
 * 而报告的来源是任意媒体域名，不可能逐一备案。因此域名本身不承载跳转，
 * 只作为「这条动态出自哪家媒体」的提示 —— 打开动作统一交给 pages/link-preview（见 openSourceLink）。
 * 另外 url 已经过 report.ts 的素材白名单校验，必然是真实的素材链接。
 */
function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url || '')
  if (!m) return ''
  return (m[1] ?? '').replace(/^www\./i, '')
}

/* ===== 相关名人（优化建议 O-16）===== */

/** 参与比对的候选上限（收藏过报告的其他名人） */
const RELATED_CANDIDATES = 3
/** 展示上限 */
const RELATED_MAX = 3

interface RelatedPerson {
  personKey: string
  name: string
  domain: DomainCode
  /** 共同高频话题（最多 3 个，用于说明「为什么把 TA 摆在这里」） */
  shared: string[]
}

/**
 * 「相关名人」= 与本报告有**共同话题**的、你收藏过报告的名人。
 *
 * 候选只取「收藏过的报告」，不取关注列表 / 全量历史，三个理由：
 * 1. 收藏是用户对内容本身给出的正向信号，比「点开看过」强得多，也更少误伤；
 * 2. 数量天然受控（本机收藏上限 100，实际通常只有几条），因此开销有明确上界：
 *    **没收藏过任何报告的用户连第二次请求都不会发**（`picked.length === 0` 直接返回）；
 * 3. 两两求交集本来就稀疏（词云撞不上的两个人比撞得上的多得多），所以候选宁可少而准。
 *
 * 交集复用对比页的 `buildComparison` 而不是自己再抽一次词：
 * 同一套子串匹配（「手机」与「旗舰手机」算同一件事）、同一套排序（按两侧命中数之和），
 * 于是这里写出的共同话题与「和 TA 对比」页里看到的**完全一致** ——
 * 两处各写一套交集算法，迟早会在某次调参后互相打架。
 *
 * 交集为空时返回空数组，由调用方整卡不渲染 —— 宁可没有这块，也不摆一段「暂无相关」。
 */
async function loadRelated(self: Report): Promise<RelatedPerson[]> {
  const favs = await listFavorites('report')
  const picked = favs
    .filter((f) => f.person_key && f.person_key !== self.personKey)
    .slice(0, RELATED_CANDIDATES)
  if (picked.length === 0) return []

  const reports = await getCachedReports(picked.map((f) => f.person_key))
  const scored: Array<RelatedPerson & { total: number }> = []
  picked.forEach((f, i) => {
    /* 只有已缓存的人才有词可算：没缓存的人不触发任何生成（本页是只读聚合，不烧额度） */
    const other = reports[i]
    if (!other) return
    const { common } = buildComparison(self, other)
    if (common.length === 0) return
    scored.push({
      personKey: f.person_key,
      name: f.name || other.name,
      domain: (f.person_key.split('#')[1] || 'other') as DomainCode,
      shared: common.slice(0, 3).map((c) => c.word),
      total: common.length
    })
  })

  return scored.sort((a, b) => b.total - a.total).slice(0, RELATED_MAX)
}

/** 日期倒序（缺日期的排最后）：模型返回顺序不保证，最新动态应排最前 */
function byDateDesc(a: string, b: string): number {
  if (!a) return 1
  if (!b) return -1
  return b.localeCompare(a)
}

/** 日期正序（缺日期的排最后）：时间线是履历脉络，从早到晚读才顺 */
function byDateAsc(a: string, b: string): number {
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b)
}

/** 刷新结果：与上一版逐条比对的差值 */
interface RefreshDiff {
  newDynamics: number
  newTimeline: number
  heatDelta: number
  prevAt: string
}

/**
 * 比对两版报告，回答「这次刷新到底刷出了什么」。
 *
 * dynamics 用 url 判同、timeline 用「日期|事件」判同：这两者都是模型从素材
 * 原样复制的字段，不像 title / event 的措辞那样每次生成都会漂移，
 * 拿它们判「是不是同一条」最稳；若改用标题相似度，会稳定地误报「全是新的」。
 */
function computeDiff(next: Report, prev: Report): RefreshDiff {
  const urls = new Set(prev.dynamics.map((d) => d.url))
  const events = new Set(prev.timeline.map((t) => `${t.date}|${t.event}`))
  return {
    newDynamics: next.dynamics.filter((d) => !urls.has(d.url)).length,
    newTimeline: next.timeline.filter((t) => !events.has(`${t.date}|${t.event}`)).length,
    heatDelta: next.heat - prev.heat,
    prevAt: prev.generatedAt
  }
}

export default function ReportPage() {
  const router = useRouter()
  const personKey = decodeURIComponent(router.params.personKey || '')
  /** 发现页「关注」筛选（生成侧重，§2.3 六段可聚焦） */
  const focusParam = router.params.focus || 'all'
  const focus: FocusCode = isFocusCode(focusParam) ? focusParam : 'all'
  const [state, setState] = useState<PageState>({ phase: 'loading' })
  const [reportFaved, setReportFaved] = useState(false)
  /** 已收藏的内容 id（名言 / 动态 / 履历节点三类共用；整份报告单独用 reportFaved） */
  const [favedIds, setFavedIds] = useState<Set<string>>(new Set())
  const [followed, setFollowed] = useState(false)
  /** 是否在「监控此人」（风险信号订阅，见 utils/risk-watch.ts）；与关注相互独立 */
  const [monitored, setMonitored] = useState(false)
  /** 监控按钮提交中：防止连点写出两行（后一个会撞主键） */
  const [monitorBusy, setMonitorBusy] = useState(false)
  /** 上一版报告：仅当用户点「刷新最新」且真的重新生成了才有值 */
  const [prevReport, setPrevReport] = useState<Report | null>(null)
  /**
   * 本次刷新被「只升不降」拦下（P0，2026-10-09）：缓存里那版含会员段落，本次较简略的
   * 产物没有覆盖它（见 utils/cache.ts#shouldKeepMemberVersion）。必须给一句解释 ——
   * 用户点了「刷新最新」却看不出任何变化，最容易理解成按钮坏了。
   */
  const [keptMember, setKeptMember] = useState(false)
  /**
   * 本次刷新被「免费档刷新冷却」拦下（批 2，2026-10-09）：这份报告是 12 小时内生成的，
   * 免费档不重复买一遍（见 utils/cache.ts#isFreeRefreshCooling）。
   * 同样是「点了刷新却没变」，故与 keptMember 共用同一个提示位、同样先回答「为什么刷不动」。
   * 只有免费读者会看到它 —— 冷却只对非会员生效。
   */
  const [refreshCooled, setRefreshCooled] = useState(false)
  /** 相关名人（O-16）：报告就绪后异步算，算不出来就是空数组（整卡不渲染） */
  const [related, setRelated] = useState<RelatedPerson[]>([])
  /**
   * 会员态（O-11）：报告是全局共享缓存，会员生成过的那一份带着 memberNotes。
   *
   * 批 1（2026-10-09）起「把会员段藏起来」已经下沉到数据层（utils/cache.ts#exposeReport）：
   * 页面拿到的 report 里，非会员**根本没有**那两段，不再需要逐卡判身份 ——
   * 这里留一份会员态只为一件事：会员卡本身要不要渲染（以及促销条对会员整条不渲染）。
   * 初值 false（非会员）：宁可先藏后现，也不让会员权益先漏出去再收回。
   */
  const [member, setMember] = useState(false)
  /**
   * 本次交回的报告里**被数据层藏起来的会员段落名**（批 1）：免费读者才有值。
   *
   * 促销条靠它说清「这份报告里有什么你看不到」（文案见 utils/member.ts#reportMemberPromo）：
   * 内容虽然已经从 report 里剥掉了，但「有没有」这个事实必须留下来 ——
   * 否则那句可兑现的承诺（「已含对比视角、风险提示、信源分歧」）会退化成泛泛的招揽。
   * 也不能从 report 自己算：剥离之后它恒为空数组。
   */
  const [memberLocked, setMemberLocked] = useState<string[]>([])
  /**
   * 会员态是否已读到（O-21）：促销条的免费态文案写着「…开通会员 / 了解会员」，
   * 若在 readMemberState 返回前就渲染，**会员会先看到一句与自己身份不符的话**再整条消失
   * （初值 false 的代价，O-25 起会员态的处置是「不渲染」而不是「换一句话」）；
   * 读库失败按非会员处理，与上方同一口径。代价是免费用户的促销条也晚半秒出现 —— 比说错一句话划算。
   */
  const [memberReady, setMemberReady] = useState(false)

  const name = personKey.split('#')[0] || '名人'
  const domain = (personKey.split('#')[1] || 'other') as DomainCode

  const load = useCallback(
    async (force = false) => {
      if (!personKey) {
        setState({ phase: 'error', message: '缺少 personKey 参数' })
        return
      }
      setState({ phase: 'loading' })
      setPrevReport(null)
      setKeptMember(false)
      setRefreshCooled(false)
      setMemberLocked([])
      const outcome: ReportOutcome = await getOrBuildReport(personKey, { force, focus })
      switch (outcome.kind) {
        case 'report':
          setState({ phase: 'ready', report: outcome.report, fromCache: outcome.fromCache })
          setPrevReport(outcome.prev ?? null)
          setKeptMember(outcome.keptMember === true)
          setRefreshCooled(outcome.refreshCooled === true)
          setMemberLocked(outcome.memberLocked ?? [])
          break
        case 'coldstart':
          setState({ phase: 'coldstart' })
          break
        case 'nonews':
          setState({ phase: 'nonews' })
          break
        case 'refused':
          setState({ phase: 'refused' })
          break
        case 'error':
          if (outcome.message.includes('正在生成')) {
            setState({ phase: 'waiting' })
          } else {
            setState({ phase: 'error', message: outcome.message })
          }
          break
      }
    },
    [personKey, focus]
  )

  useEffect(() => {
    void load(false)
    void addHistory(personKey, name)
  }, [load])

  /**
   * 相关名人（O-16）：放在报告就绪之后而不是与 load 并发 —— 它要拿当前报告的关键词做交集，
   * 没有报告就没有比对基准。算不出来（没收藏过报告 / 交集为空 / 读失败）就是空数组，
   * 页面因此不会出现一块「加载中的相关名人」（这块内容不值得一个骨架屏）。
   */
  useEffect(() => {
    const rep = state.phase === 'ready' ? state.report : null
    if (!rep) {
      setRelated([])
      return
    }
    let alive = true
    void loadRelated(rep).then((rows) => {
      if (alive) setRelated(rows)
    })
    return () => {
      alive = false
    }
  }, [state])

  /**
   * 会员态同步（O-11）。用 useDidShow 而不是挂载时读一次：用户可能去「我的」买完会员
   * 再返回本页（页面实例还在、读的还是同一份缓存报告），只在 mount 时读会让刚买到的
   * 两段一直不出现；反过来权益到期后返回本页也会同步收回。读库失败按非会员处理。
   */
  useDidShow(() => {
    void readMemberState()
      .then((s) => {
        setMember(s.member)
        setMemberReady(true)
      })
      .catch(() => {
        setMember(false)
        setMemberReady(true)
      })
  })

  /**
   * 关注态同步。用 useDidShow 而不是挂载时读一次：用户可能去名人主页取关后
   * 再返回本页（页面实例还在、personKey 没变），只在 mount 时读会留下一个
   * 显示「已关注」的僵尸按钮。
   */
  useDidShow(() => {
    if (!personKey || !useAuth.getState().userId) return
    void isFollowed(personKey).then(setFollowed)
    /* 监控态与关注态一起同步：用户可能刚在预警页取消监控（本页实例还在、personKey 没变），
       只在别处读一次会留下一个显示「监控中」的僵尸按钮 */
    void listPersonWatches().then((rows) => setMonitored(isMonitored(rows, personKey)))
  })

  /** 关注 / 取关。报告页此前没有关注入口，看完报告想关注必须退回名人主页，动线是断的。 */
  const onToggleFollow = async () => {
    const next = await toggleFollow(personKey, 'report')
    /* null = 失败或未登录：follows.ts 已给出原因 toast，不更新按钮态 */
    if (next === null) return
    setFollowed(next)
    Taro.showToast({ title: next ? '已关注' : '已取消关注', icon: 'none' })
  }

  /**
   * 监控此人 / 取消监控（第 1 期名人风险监控，见 utils/risk-watch.ts）。
   *
   * 与关注是两回事：关注只是本机记号，监控会把这个人交给云端每天检索一次公开报道，
   * 命中「司法 / 税务 / 维权 / 表态」这类词时写风险信号并推送 —— 故按钮文案必须
   * 说清它订阅的是「风险情况」，不能与「关注」混成同一个动作。
   *
   * 取消走二次确认（与预警页取消监测同一套交互）：监控是每天真金白银的检索，误触取消
   * 会让用户第二天收不到提醒却不知道发生了什么。
   */
  const onToggleMonitor = async () => {
    if (monitorBusy) return
    if (monitored) {
      void Taro.showModal({
        title: '取消监控',
        content: `不再监控「${name}」的风险情况？已收集的信号会从预警页移除。`,
        confirmText: '取消监控',
        cancelText: '再想想',
        success: async (r) => {
          if (!r.confirm) return
          const ok = await unmonitorPerson(personKey)
          if (ok) {
            setMonitored(false)
            Taro.showToast({ title: '已取消监控', icon: 'none' })
          }
        }
      })
      return
    }
    setMonitorBusy(true)
    const res = await monitorPerson(personKey, name)
    setMonitorBusy(false)
    if (res.ok) {
      setMonitored(true)
      Taro.showToast({ title: res.message, icon: 'success' })
      return
    }
    /* 环境问题（集合没建 / 权限不允许端上写入）的文案长且不是「再点一次」能解决的，
       toast 会把它截成半句 —— 改用弹窗把「去哪建表、改成什么权限」说完（同 saveImageToAlbum
       对权限类失败的处理）。其余失败（断网 / 超时）仍是一句 toast 让用户重试。 */
    if (res.fatal) {
      await Taro.showModal({ title: '监控没能开启', content: res.message, showCancel: false, confirmText: '知道了' })
      return
    }
    Taro.showToast({ title: res.message, icon: 'none' })
  }

  /** 进入页面 / 报告就绪时同步收藏状态 */
  useEffect(() => {
    const userId = useAuth.getState().userId
    const rep = state.phase === 'ready' ? state.report : null
    if (!userId || !personKey) return
    void (async () => {
      /* 一次 in 查回收藏态：报告 + 每条名言。
         近期动态与履历节点都已不提供收藏入口（见渲染处），故不再回查这两类；
         历史版本落库的 dynamic / timeline 收藏仍留在库里由「我的收藏」展示，不受影响。 */
      const ids = [
        ...(rep?.quotes.map((q) => makeFavoriteId(userId, 'quote', `${personKey}:${q.text}`)) ?? [])
      ]
      const { table } = await import('@/utils/db')
      const { data } = await table('favorites')
        .select('id')
        .in('id', [makeFavoriteId(userId, 'report', personKey), ...ids])
      const rows = (data as Array<{ id: string }>) ?? []
      setReportFaved(rows.some((r) => r.id === makeFavoriteId(userId, 'report', personKey)))
      setFavedIds(new Set(rows.map((r) => r.id)))
    })()
  }, [personKey, state])

  /**
   * 打开素材链接（「近期动态」标题、「最新报道」标题、「名言查证」里的出处即入口）。
   *
   * 跳「原文预览」页这件事已经抽到 utils/source-link.ts：调用点从本页一处变成三处
   * （本页两处 + 名言查证面板一处，后者还要复用于名人主页），再各自拼一遍 query
   * 迟早出现一处带 summary 一处不带。这里只保留「谁在什么位置触发了它」的语境。
   */

  /** 当前用户对某条内容的收藏 id；未登录返回空串（一律按「未收藏」渲染） */
  const favIdOf = (type: 'quote', contentKey: string): string => {
    const userId = useAuth.getState().userId
    return userId ? makeFavoriteId(userId, type, contentKey) : ''
  }

  /**
   * 内容收藏切换（现仅「经典名言」使用；动态与履历节点已去掉收藏入口）。
   *
   * 抽出一层是因为三类内容的收藏逻辑完全一致，而原先只写名言的那版有个坑：
   * 无论当前是否已收藏都调 favoriteQuote（幂等 upsert），于是「取消收藏」只改了
   * 本地状态、库里那条依然在，重进页面又变回已收藏。
   *
   * @param makeId 用当前用户 id 算主键，免得调用处各自重复取一遍 userId
   * @param save   未收藏时的落库动作，返回 false 表示失败（内部已 toast）
   */
  const toggleContentFav = async (
    makeId: (userId: string) => string,
    save: () => Promise<boolean>
  ) => {
    const userId = useAuth.getState().userId
    if (!userId) {
      Taro.showToast({ title: '请先到「我的」页登录', icon: 'none' })
      return
    }
    const id = makeId(userId)

    if (favedIds.has(id)) {
      await removeFavorite(id)
      setFavedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      Taro.showToast({ title: '已取消收藏', icon: 'none' })
      return
    }

    if (!(await save())) return
    setFavedIds((prev) => new Set(prev).add(id))
    Taro.showToast({ title: '已收藏', icon: 'none' })
  }

  const toggleQuoteFav = (q: Report['quotes'][number]) =>
    toggleContentFav(
      (uid) => makeFavoriteId(uid, 'quote', `${personKey}:${q.text}`),
      () => favoriteQuote(personKey, name, q)
    )

  /** 报告收藏切换：原先只有「收藏」分支，没有取消 */
  const toggleReportFav = async () => {
    if (!report) return
    const userId = useAuth.getState().userId
    if (!userId) {
      Taro.showToast({ title: '请先到「我的」页登录', icon: 'none' })
      return
    }
    const id = makeFavoriteId(userId, 'report', personKey)

    if (reportFaved) {
      await removeFavorite(id)
      setReportFaved(false)
      Taro.showToast({ title: '已取消收藏', icon: 'none' })
      return
    }

    const ok = await favoriteReport(personKey, name, {
      heat: report.heat,
      mode: report.mode,
      generatedAt: report.generatedAt
    })
    if (!ok) return
    setReportFaved(true)
    Taro.showToast({ title: '已收藏报告', icon: 'none' })
  }

  const { report, fromCache } =
    state.phase === 'ready' ? { report: state.report, fromCache: state.fromCache } : { report: null, fromCache: false }

  /**
   * 微信原生分享（转发好友 / 分享到朋友圈）。
   *
   * 全项目此前没有注册任何分享回调，右上角「转发」只会带走一个不含参数的页面地址，
   * 对方打开直接落到「缺少 personKey 参数」的错误态 —— 而深度报告恰恰是最该被分享的内容。
   * 加载中与失败态也给一个可读标题，避免分享出去是一句「生成失败」。
   */
  const sharePath = reportSharePath(personKey, focus)
  /* 文案与名人主页 / 发现页 / 提问页同源（见 utils/share.ts）：只用报告里那一句可核对的简介，
     不再写「深度报告」这种自夸式后缀 —— 分享出去的标题应该说明「这个人是谁」，而不是我们的栏目名。 */
  const shareTitle = personShareTitle(report?.name ?? name, domain, report)

  useShareAppMessage(() => ({ title: shareTitle, path: sharePath }))
  useShareTimeline(() => ({ title: shareTitle, query: sharePath.split('?')[1] ?? '' }))

  /** 渲染顺序：动态最新在前、履历从早到晚（模型返回顺序不作保证） */
  const dynamicsView = report ? [...report.dynamics].sort((a, b) => byDateDesc(a.date, b.date)) : []
  const timelineView = report ? [...report.timeline].sort((a, b) => byDateAsc(a.date, b.date)) : []

  /**
   * 立场与舆情 = 情绪走向（本地聚合）+ 话题态度（模型判定），两层显式分开：
   *
   * - 情绪走向：把「近期动态」里逐条标好的 sentiment 聚合成一条比例条。**纯本地统计**，
   *   不含任何模型判断，因此对新老报告一视同仁，也不存在「多一次生成多一个不稳定点」。
   * - 话题态度：模型对 2~4 个热点话题的舆论倾向（stance 字段，M4-4 剩余项补齐）。
   *   它回答的是比例条答不了的问题 ——「哪个话题上是这个态度」，且每条都附了依据。
   *
   * 情绪条只在有动态时成立（degraded 纯文本简版没有动态，自然不展示这一段）。
   */
  const sentimentStats = (() => {
    if (!report || report.dynamics.length === 0) return null
    const dyn = report.dynamics
    const positive = dyn.filter((d) => d.sentiment === 'positive').length
    const negative = dyn.filter((d) => d.sentiment === 'negative').length
    return { positive, negative, neutral: dyn.length - positive - negative, total: dyn.length }
  })()

  /**
   * 话题态度（M4-4 剩余项）：模型对 2~4 个近期热点的舆论倾向判断。
   * 可选字段 —— 2026-10-06 之前落库的报告没有它，那些报告只呈现情绪走向条。
   */
  const stances = report?.stance ?? []

  /**
   * 关键词云 + 高频观点（M4-5）：纯端上聚合，口径与取舍见 utils/keywords.ts 顶部注释。
   *
   * 不走模型新增字段，是为了让 2026-10-06 之前落库的老报告也立刻能看到词云 ——
   * 报告是「一次生成、长期缓存」的资产，词云不该逼用户重新消耗一次生成额度。
   */
  const keywords = report ? extractKeywords(report) : []
  /** 高频观点只取带佐证原文的前 3 条：没有出处的词不配叫「观点」，让它留在词云里 */
  const keywordHighlights = keywords.filter((k) => k.refs.length > 0).slice(0, 3)

  /**
   * 语录主题：同一份语录的另一种读法 —— 词云回答「反复提了什么」，这里回答
   * 「他常讲的话分成几类」。口径与门槛见 utils/keywords.ts 的 extractQuoteThemes，
   * 同样是纯端上统计，存量报告立即生效。
   */
  const quoteThemes = report ? extractQuoteThemes(report) : []

  /**
   * 点词云里的词 → 主题速览（pages/topic）。
   *
   * 「这个话题还出现在谁的报告里、各自都怎么说」是读完词云后最自然的下一问，
   * 而答案就在别处已缓存的报告里 —— 主题页只读缓存做编目，零模型调用、零上游请求、
   * 不消耗生成额度（口径见 utils/topic-digest.ts 顶部注释）。
   *
   * 带上 personKey 作为锚点：候选名单会截断到 20 位，锚点排第一才能保证
   * 用户从这份报告点进去时，手上这份一定是聚合进去的那一份。
   */
  const goTopic = (word: string) => {
    void Taro.navigateTo({
      url: `/pages/topic/index?topic=${encodeURIComponent(word)}&personKey=${encodeURIComponent(personKey)}`
    })
  }

  /**
   * 热度趋势（M4-6）：口径与取舍见 utils/trend.ts 顶部注释 —— 只聚合报告里带日期的
   * 动态与时间线事件，因此存量报告不重新生成也能看到这张卡，不消耗生成额度。
   * 几何换算（rpx 坐标 / 线段角度）见文件顶部的 trendGeometry，纯 View 自绘、不引图表库。
   */
  const trend = report ? buildHeatTrend(report) : null
  const trendGeo = trend ? trendGeometry(trend.points) : null

  /**
   * 风险雷达（第 0 期）：从报告已收录的四段素材里**字面**挑出司法 / 监管 / 商业合作 /
   * 名誉维权类表述，逐条给出处。纯端上聚合，存量报告立即生效，不消耗生成额度。
   *
   * ⚠ 这张卡刻意不产出「风险等级 / 塌房概率」这类结论，措辞一律是「收录到 N 条相关表述」——
   *   口径与三条边界（只做字面命中、宁可漏报、算不出就说算不出）写死在 utils/risk.ts 顶部，
   *   改动前先读那段说明。
   */
  const risk = report ? buildRiskSignals(report) : null

  /**
   * 商业价值速览（第 0 期）：给「读完这份报告，值不值得进一步接触」一个一屏入口 ——
   * 报道热度 / 报道倾向 / 争议状况，每段一句话结论 + 一条口径，明细靠锚点跳过去。
   *
   * ⚠ 一个数字都不新算：三段全部复用 utils/stats.ts 与 utils/risk.ts 的既有口径，
   *   并把上面已经算好的 risk 传进去，避免同一趟里把四段素材扫两遍。
   *   门槛（成立的分项 < MIN_AXES 不出速览）与措辞都在 utils/commercial.ts 里，
   *   页面只负责渲染 —— 改动前先读那个文件顶部的说明。
   */
  const commercial = report ? buildCommercialSummary(report, { risk: risk ?? undefined }) : null

  /**
   * 人物速览的数据源：本版新增的博查素材画像（utils/report.ts 的 ReportCoverage）。
   *
   * 这里替换掉了原来的「同领域名人」推荐位 —— 那是**别的人**，而读完报告最需要确认的
   * 是「这份报告覆盖了本人多少公开信息」，热度环上那个数字也一直没有解释。
   */
  const cov = report?.coverage

  /**
   * 覆盖区间：优先用博查素材的发布时间边界；老缓存报告（改动前生成的，没有 coverage 字段）
   * 退回用模型给出的动态日期取首尾，宁可少一行也不留一张空壳卡。
   */
  const coverageSpan = (() => {
    if (!report) return ''
    if (cov?.firstAt && cov.latestAt) {
      const a = formatDay(cov.firstAt)
      const b = formatDay(cov.latestAt)
      return a === b ? a : `${a} ~ ${b}`
    }
    const days = dynamicsView.map((d) => d.date).filter(Boolean)
    if (days.length === 0) return ''
    /* 模型的 date 已是 YYYY-MM-DD，字符串序即时间序（与时间线同一套口径） */
    const asc = [...days].sort((a, b) => a.localeCompare(b))
    return asc[0] === asc[asc.length - 1] ? asc[0] : `${asc[0]} ~ ${asc[asc.length - 1]}`
  })()

  /** 素材来源域名（去重）：原始链接与「来源 + 域名」已在每条动态上给出，这里只要一个可信度信号 */
  const sourceHosts = report
    ? Array.from(new Set(report.sources.map((s) => hostOf(s.url)).filter(Boolean)))
    : []

  /** 溯源摘要文案（域名最多列 3 个，其余收口为「等 N 家媒体」，一行排版放不下更多） */
  const traceText =
    report && report.sources.length > 0
      ? `本报告引用 ${report.sources.length} 篇公开素材${
          sourceHosts.length > 0
            ? `，来自 ${sourceHosts.slice(0, 3).join('、')}${
                sourceHosts.length > 3 ? ` 等 ${sourceHosts.length} 家媒体` : ''
              }`
            : ''
        }`
      : ''

  /**
   * 横幅状态行里的「引用了多少素材」。
   *
   * 横幅那一格原本在「本次刚生成」时只有「刚刚生成」四个字：用户刚看完生成动画，
   * 这句话零信息量，而它旁边恰好是报告最该自证的地方 —— 这一版到底踩了多少实时素材。
   * 简版降级没有素材可引，就如实写「未引用」，与下方警示条一致而不是打架。
   */
  const sourceNote = report
    ? report.degraded || report.sources.length === 0
      ? '未引用实时素材'
      : `引用 ${report.sources.length} 篇实时素材`
    : ''

  /**
   * 是否按「刚刚生成」呈现：判据是生成时间本身，而不是本次是否命中缓存。
   *
   * 只看 fromCache 会漏掉一种自相矛盾的写法：10 秒前生成、进页面时读的是缓存，
   * 横幅就成了「生成于 几秒前 · 查看最新」—— 既说刚刚，又催你去看最新。
   * 一分钟内无论出自哪次会话都按刚刚处理，此时也确实不存在更新的版本。
   */
  const justGenerated = !!report && Date.now() - Date.parse(report.generatedAt) < 60_000
  const showFresh = report ? !fromCache || justGenerated : false

  /**
   * 报告年龄（优化建议 O-14）。
   *
   * 缓存策略是「一旦 ready 就长期复用、不按时间过期」（见 utils/cache.ts），一份两个月前的
   * 报告会一直原样返回，而页面上只有一行相对时间 —— 用户很容易把它当「刚刚查到的」读。
   * ≥ STALE_REPORT_DAYS 天时在「查看最新」入口前把年龄写出来，点不点刷新由用户自己判断。
   * 阈值与问答页的语料提示同源（utils/time.ts）。
   */
  const ageDays = reportAgeDays(report?.generatedAt)
  const staleReport = isStaleReport(report?.generatedAt)

  /** 刷新结果对比：只有本次真的重新生成、且库里本来就有旧版时才算得出来 */
  const diff = report && prevReport ? computeDiff(report, prevReport) : null
  const diffParts: string[] = diff
    ? [
        diff.newDynamics > 0 ? `新增 ${diff.newDynamics} 条动态` : '近期动态无变化',
        diff.newTimeline > 0 ? `${diff.newTimeline} 个履历节点` : '',
        diff.heatDelta !== 0 ? `热度 ${diff.heatDelta > 0 ? '+' : ''}${diff.heatDelta}` : ''
      ].filter((s) => s !== '')
    : []

  /**
   * 联网能力是否就绪：coldstart 的成因有两种且有完全不同的出路——
   * 云环境没配（用户侧无事可做，只能等开发者配好）vs 配了但素材拉不到（重试才有用），
   * 二者不可混为一谈。两项判定现在都只反映「云环境 ID 配了没」（见 utils/search.ts / utils/llm.ts）：
   * 客户端不持有任何 Key，用户侧不存在「没填 Key」这种成因，故未就绪时只引导去看额度 / 会员。
   */
  const netReady = hasSearchChannel() && hasLlmChannel()

  /** 侧重提示条：路由侧重 ≠ 缓存报告侧重时，给出「重新生成」入口（缓存键仍为 personKey） */
  const reportFocus: FocusCode = report?.focus ?? 'all'
  const needRegen = !!report && reportFocus !== focus
  const showFocusBar = focus !== 'all' || (!!report && reportFocus !== 'all')

  /**
   * 顶部「会员促销条」（O-21 立起、O-25 收敛、O-26 降频）：文案只剩免费态一种，
   * 判定在 utils/member.ts#reportMemberPromo —— 页面把数据层交回的「这份报告里实际藏了哪些
   * 专享段落」（memberLocked）喂进去。批 1 之后不能再用 report 自己算：会员段内容已被剥离，
   * presentSections(report) 恒为空，促销条会退化成泛泛的招揽。
   * 会员态整条不渲染（见下方渲染条件），故这里不再需要「是不是会员」这个入参。
   * memberReady 仍要等：免费态文案写着「开通会员」，会员提前读到它就是被推销。
   */
  const promo = reportMemberPromo(memberLocked)

  /**
   * 促销条这一趟要不要出现（O-26）。
   *
   * 为什么不用 `useMemo` / 直接在渲染里掷骰子：骰子必须在**一次访问里只掷一次** ——
   * 每次重渲染重掷，条子就会随机闪现又消失，看着像渲染 bug 而不是「随机展示」。
   * 这里用 `promoRolled` 记住已掷过骰子的报告，同一份报告（含「刷新最新」后仍是同一 personKey）
   * 无论渲染多少次都沿用第一次的结果。
   *
   * 会员不掷：`!member` 时整条本来就不渲染，但也不该给会员留一个「下次进来可能随机出现」的状态。
   * 掷骰子要等 memberReady —— 那之前 `member` 还是初值 false，会把会员当免费用户掷一次。
   */
  const [promoOn, setPromoOn] = useState(false)
  const promoRolled = useRef('')
  useEffect(() => {
    if (!report || !memberReady || member) return
    if (promoRolled.current === report.personKey) return
    promoRolled.current = report.personKey
    setPromoOn(!isPromoDismissed() && promoRoll(memberLocked))
  }, [report, member, memberReady, memberLocked])

  /**
   * 促销条的唯一动作：去会员中心。
   *
   * O-25 删掉了原先「会员态页内滚动到专享卡」的分支 —— 随会员态整条隐藏一起消失，
   * 连带 `Taro.pageScrollTo` 与专享卡上的 `#report-notes` 锚点一并移除，不留死代码。
   */
  const onPromoTap = () => void Taro.navigateTo({ url: '/pages/member/index' })

  /**
   * 关闭促销条（O-26）：本机记住，此后不再出现。
   *
   * 必须 stopPropagation —— 关闭键在整条的可点区域里，不拦住就会顺手跳进会员中心，
   * 恰恰是「想关掉广告却被广告带走」。
   * 给一句 toast 是因为「以后都不出现」这件事从界面上看不出来：不说一声，
   * 用户下次没见到它时会怀疑是不是坏了（而不是庆幸）。
   */
  const onPromoClose = (e: { stopPropagation?: () => void }) => {
    e.stopPropagation?.()
    dismissPromo()
    setPromoOn(false)
    Taro.showToast({ title: '已关闭，不再出现', icon: 'none', duration: 1500 })
  }

  /**
   * 折叠目录（本轮）：卡片从六段涨到十七节，报告页要滑十几屏 ——
   * 目录回答的是「这里有什么、怎么直接过去」，默认收起（它是入口，不是内容）。
   *
   * 口径全在 utils/report-toc.ts：那里与下面卡片的渲染条件是**平行维护的一对**，
   * 改任何一张卡的显示条件都要同步改它（两边都有注释互相指路）。页面只做两件事：
   * 折叠/展开，以及拿 id 跳转。
   */
  const [tocOpen, setTocOpen] = useState(false)
  /** 刚跳过去的那一节：点完目录就收起，需要留个「我到了哪」的记号 */
  const [tocActive, setTocActive] = useState('')
  const tocSections = buildReportToc(report, {
    member,
    /* 「人物速览」可见的充要条件：不是降级简版，或有覆盖数据（与卡片那两个分支的条件等价） */
    hasOverview: !(!!report && report.degraded && !cov && coverageSpan === '')
  })

  const jumpToSection = useCallback((id: string) => {
    setTocActive(id)
    setTocOpen(false)
    /*
     * 用原生 pageScrollTo + 元素 id，不把整页换成 ScrollView：报告页是原生页面滚动
     * （下拉刷新、返回顶部都依赖它），为一个目录条换容器不值当。offsetTop 留一点，
     * 让卡片标题不贴着屏幕顶端。跳转失败不做提示 —— 目标一定存在（目录与卡片条件同源），
     * 失败只可能是页面正在重渲染。
     */
    Taro.pageScrollTo({ selector: `#${id}`, offsetTop: -12, duration: 260 }).catch(() => {})
  }, [])

  return (
    <View className='page-report glow-page safe-bottom'>


      {showFocusBar && (
        <View className='page-report__focus'>
          <Text className='page-report__focus-tag'>{focus === 'all' ? '综合' : FOCUS_META[focus].short}</Text>
          {state.phase === 'loading' ? (
            <Text className='page-report__focus-text'>正在按该侧重生成报告…</Text>
          ) : needRegen ? (
            <Text className='page-report__focus-text'>
              当前为{reportFocus === 'all' ? '综合' : `「${FOCUS_META[reportFocus].short}」`}报告，
              <Text className='page-report__focus-link' onClick={() => void load(true)}>
                重新生成为{focus === 'all' ? '综合' : `「${FOCUS_META[focus].label}」`}
              </Text>
            </Text>
          ) : report ? (
            <Text className='page-report__focus-text'>已按该侧重生成：{FOCUS_META[focus].desc}</Text>
          ) : (
            <Text className='page-report__focus-text'>本次侧重：{FOCUS_META[focus].desc}</Text>
          )}
        </View>
      )}

      {/*
        人物横幅（2026-10-09 重排）。原先是一行 flex：头像 | 左栏（名字行 / 状态行 / 按钮行）| 热度环，
        左栏只剩 ~318rpx，于是名字行里硬塞了「名字 + 领域 + 生成时间」三样东西 —— 名字被挤成省略号；
        而头像与热度环按 align-items:center 居中在一列三行的旁边，跟名字不在一条基线上。
        另外「生成于 3 小时前」（时间）与「33 天前生成 · 建议刷新」（状态行）说的是同一件事，写了两遍。

        现在压成三段，每段只讲一件事，宽度也各归各位：
          ① 身份带  头像 + 名字 + 领域       —— 名字独占一行，长名字才有地方待
          ② 状态行  时间 · 素材出处 / 刷新入口 —— 全幅宽度，长句不折行
          ③ 操作行  「+ 关注」「+ 监控风险」   —— 全幅宽度，两个按钮不再挤在 318rpx 里
        热度环绝对定位贴右上角：它只跟身份带等高，下面两行就能吃满整幅宽度。
      */}
      {report && (
        <View className='page-report__banner'>
          <View
            className='page-report__ring'
            style={{
              background: `conic-gradient(#fff 0 ${Math.max(4, Math.min(100, report.heat))}%, rgba(255,255,255,0.22) ${Math.max(4, Math.min(100, report.heat))}% 100%)`
            }}
          >
            <View className='page-report__ring-inner'>
              <Text className='page-report__ring-value'>{report.heat}</Text>
              <Text className='page-report__ring-label'>热度</Text>
            </View>
          </View>

          <View className='page-report__ident'>
            {/* 人物头像：平台没有名人真实头像素材（LLM 也不产图），全项目统一用
                「领域色渐变 + 姓名首字」占位，这里与 person-card / 主页保持一致。
                白色描边是为了在紫色横幅上把头像和背景分开。 */}
            <View className={`page-report__avatar page-report__avatar--${domain}`}>
              {report.name.slice(0, 1)}
            </View>
            {/* 名字行 = 名字 + 领域。不换行且 overflow:hidden：名字过长时收省略号让位。
                领域跟在名字后面而不是另起一行 —— 它是名字的定语，两三个字，值得花这点宽度。 */}
            <View className='page-report__name-row'>
              <Text className='page-report__name'>{report.name}</Text>
              <View className='page-report__banner-chip'>{DOMAIN_META[domain]?.label ?? '其他'}</View>
            </View>
          </View>

          {/* 状态行（全幅）：刚生成 → 这一版引用了多少实时素材（报告自证）；已有更新版本 → 刷新入口。
              「查看最新」只在确实存在更新版本的可能时才是入口：刚生成完的那一版本身最新，
              再留个热区只会让手滑白白烧掉一次生成配额（底部还有「刷新最新」按钮兜底）。
              时间也归到这一行 —— 原先名字行里的「3 小时前」与这里的「33 天前生成」是同一件事，
              一行写完既省高度也不再自相矛盾（O-14 要的是「N 天前生成 · 建议刷新」这个完整因果）。 */}
          <View className='page-report__meta' onClick={showFresh ? undefined : () => void load(true)}>
            {showFresh ? (
              <Text className='page-report__meta-text'>{`刚刚生成 · ${sourceNote}`}</Text>
            ) : (
              <Text className='page-report__meta-text'>
                {staleReport
                  ? `${ageDays} 天前生成 · 建议刷新 `
                  : `${fromNow(report.generatedAt)}生成 · `}
                <Text className='page-report__refresh-link'>查看最新</Text>
              </Text>
            )}
          </View>

          {/* 关注 / 监控入口：此前报告页无处关注，看完报告想关注必须先退回名人主页。
              两个按钮同行：关注是「记一笔」，监控是「让云端每天替你盯风险」——
              动作相邻、语义不同，故监控按钮用**虚线边**区分（原先还试过加「🛡」图标，
              在小程序部分机型不渲染，已撤），文案把「风险」二字写出来，避免被当成关注去点。
              两者宽度都不固定（各自按文案撑开），中间 16rpx 间距由 __actions 的 gap 给。 */}
          <View className='page-report__actions'>
            <View
              className={`page-report__follow ${followed ? 'page-report__follow--on' : ''}`}
              onClick={() => void onToggleFollow()}
            >
              {followed ? '已关注' : '+ 关注'}
            </View>
            <View
              className={`page-report__follow page-report__monitor ${monitored ? 'page-report__follow--on' : ''}`}
              onClick={() => void onToggleMonitor()}
            >
              {monitored ? '监控中' : '+ 监控风险'}
            </View>
          </View>
        </View>
      )}

      {/*
        会员促销条（O-21 立起、O-25 收敛）：**只对免费用户存在**。
        摆在人物横幅正下方是有意的 —— 会员权益此前只在「滑到最底的会员卡」和会员中心里可见，
        免费用户读完一份报告也不知道会员能多得到什么；而报告是全局共享缓存，他读到的很可能
        就是会员生成的那一份（三段内容此刻正被藏起来），页面上却没有一行字解释这件事。
        O-25 的两处收敛：
          · 会员态**整条不渲染**（`!member`）—— 买过的人不该再被推销一次；权益是否生效由
            下方专享卡标题上的「已生效」标记回答（卡在 = 权益在，不必再多一行字）；
          · 免费态**压成一行**（「会员专享」小标 + 一行文案 + 侧边关闭键）—— 原先是「标题 + 两行说明」，
            与侧重条 / 横幅 / 问答入口叠在首屏，把正文压掉一截。
        O-26 再加一层「少打扰」：只在掷骰子中签时出现（`promoOn`，见上方注释），
        并给免费用户一个 × —— 关掉即本机记住，此后不再出现（utils/member.ts#dismissPromo）。
        仍是中性白卡：不摆「灰掉的内容」，报告正文一律完整呈现，留白只留这一处并当场说明白。
        渲染还要等 memberReady：免费态文案里写着「开通会员」，会员提前读到它就是在被推销
        （见 memberReady 的注释）。
      */}
      {report && memberReady && !member && promoOn && (
        <View className='page-report__vip' hoverClass='page-report__vip--tap' onClick={onPromoTap}>
          <Text className='page-report__vip-tag'>会员专享</Text>
          <Text className='page-report__vip-note'>{promo.text}</Text>
          <Text className='page-report__vip-action'>{`${promo.action} ›`}</Text>
          {/* 关闭键：点它只关不跳（stopPropagation，见 onPromoClose） */}
          <Text className='page-report__vip-close' onClick={onPromoClose}>
            ✕
          </Text>
        </View>
      )}

      {/* 刷新反馈：告诉用户这次「刷新最新」到底刷出了什么，此前点完毫无回音 */}
      {diff && (
        <View className='page-report__diff'>
          <Text className='page-report__diff-head'>已更新为最新版本</Text>
          <Text className='page-report__diff-body'>
            相比 {fromNow(diff.prevAt)} 的版本：{diffParts.join(' · ')}
          </Text>
        </View>
      )}

      {/*
        刷新被「只升不降」拦下（P0）：报告是全局共享缓存，同一人物全站只有一行，
        免费档产物若覆盖掉含会员段落的那一版，全站会员都会看到「深度解析」整块消失，
        且不会自愈 —— 故缓存里已含会员段落时拒绝降级覆盖（utils/cache.ts）。
        这一条必须出现：用户点了「刷新最新」却什么都没变，没有解释就等于按钮坏了。
        文案按会员态分开 —— 免费用户看不到会员段落，对他来说重点是「为什么刷不动、差在哪」。
      */}
      {keptMember && (
        <View className='page-report__diff'>
          <Text className='page-report__diff-head'>已保留更完整的版本</Text>
          <Text className='page-report__diff-body'>
            {member
              ? '这位人物的报告已含会员专属段落（对比视角 / 风险提示 / 信源分歧），本次刷新生成的内容更基础，故未覆盖它。'
              : '这位人物已有一份更完整的报告（含会员专属段落：对比视角 / 风险提示 / 信源分歧），本次刷新生成的内容更基础，故未覆盖它。开通会员后即可查看这三段。'}
          </Text>
        </View>
      )}

      {/*
        刷新被「免费档冷却」拦下（批 2）：这份报告是 12 小时内生成的，免费档不重复买一遍
        （utils/cache.ts#isFreeRefreshCooling）。与上一条同为「点了刷新却没变」，故同一处提示位。
        文案要先回答「那我现在看的是不是旧的」——否则「没重新生成」听着像降级；
        再如实说明会员不受此限（对免费用户说，会员根本看不到这条）。
      */}
      {refreshCooled && (
        <View className='page-report__diff'>
          <Text className='page-report__diff-head'>这份报告刚刚更新过</Text>
          <Text className='page-report__diff-body'>
            它生成于 12 小时内，内容不会有实质变化（素材时间窗为 30 天），所以本次直接交回现有的一版、没有重新生成
            —— 你看到的就是最新的。会员可随时按自己的档位重新生成一份更厚的。
          </Text>
        </View>
      )}

      {/*
        AI 问答入口（M4-8）：原先放在页面最底部（读完报告才看得到），用户反馈「找不到」，
        故提到首屏 —— 紧跟人物横幅与会员促销条之后，仍在首屏之内，是第一眼能看到的动作之一。
        问答只读已缓存报告、不消耗生成次数（见 utils/qa.ts 三条硬口径），文案里明说，
        否则用户会担心「问一句是不是又花掉一次生成」。
      */}
      {report && (
        <View
          className='page-report__ask page-report__ask--hero'
          hoverClass='page-report__ask--tap'
          onClick={() => Taro.navigateTo({ url: `/pages/qa/index?personKey=${encodeURIComponent(personKey)}` })}
        >
          <View className='page-report__ask-main'>
            <Text className='page-report__ask-text'>向 AI 提问</Text>
            <Text className='page-report__ask-desc'>就这份报告继续追问 · 不消耗生成次数</Text>
          </View>
          <Text className='page-report__ask-arrow'>→</Text>
        </View>
      )}

      {state.phase === 'loading' && <ReportLoading />}

      {state.phase === 'waiting' && <ReportLoading mode='waiting' />}

      {state.phase === 'coldstart' && (
        <EmptyState
          icon='🔑'
          title={netReady ? '暂无报告' : '联网能力不可用'}
          desc={
            netReady
              ? '该名人还没有生成过报告，联网素材暂不可用（网络或额度问题），可稍后重试，或换一位热门名人'
              : '报告需「博查搜索取素材 + 大模型按模板生成」，平台通道当前不可用（需开发者确认云端配置）；可稍后重试，或到「我的」页查看今日额度与会员权益'
          }
          actionText={netReady ? '刷新重试' : '查看额度'}
          onAction={() => {
            if (netReady) void load(true)
            else void Taro.switchTab({ url: '/pages/mine/index' })
          }}
        />
      )}

      {state.phase === 'nonews' && (
        <EmptyState
          icon='📭'
          title='暂未检索到近期公开信息'
          desc='该名人近 30 天无公开新闻动态，换个时间再试'
          actionText='刷新重试'
          onAction={() => void load(true)}
        />
      )}

      {state.phase === 'refused' && (
        <EmptyState icon='🚫' title='暂不支持查询该人物' desc={`本工具覆盖${DOMAIN_COVERAGE_TEXT}等多个领域的公众名人`} />
      )}

      {state.phase === 'error' && (
        <EmptyState
          icon='⚠️'
          title='生成失败'
          desc={state.message}
          actionText='重试'
          onAction={() => void load(false)}
        />
      )}

      {report && (
        <View>
          {/*
            折叠目录（本轮）：18 节卡片一屏一屏往下滑，读的人既不知道后面还有什么，
            也不好回头对照。目录默认只占一行（它是入口，不是内容），展开后按节直达。

            ⚠ 条目与下方卡片的对应关系由 utils/report-toc.ts 的可见性条件保证：
              这里渲染出的每一条，下面都真的有一张对应的卡；卡片上的 id 必须与条目 id
              一字不差（改 id 时两处一起改，否则点了没反应）。
              只有一节时不出目录 —— 这不是统计数据，是导航，套「不成立也出卡」没意义。
          */}
          {tocSections.length > 1 && (
            <View className='card page-report__toc'>
              <View
                className='page-report__toc-head'
                hoverClass='page-report__toc-head--tap'
                onClick={() => setTocOpen(!tocOpen)}
              >
                <View className='card-title'>{`目录 · ${tocSections.length} 节`}</View>
                <Text className='page-report__toc-toggle'>{tocOpen ? '收起' : '展开'}</Text>
              </View>
              {tocOpen ? (
                <View className='page-report__toc-list'>
                  {tocSections.map((s) => (
                    <View
                      key={s.id}
                      className={`page-report__toc-item${tocActive === s.id ? ' page-report__toc-item--active' : ''}`}
                      hoverClass='page-report__toc-item--tap'
                      onClick={() => jumpToSection(s.id)}
                    >
                      {s.label}
                    </View>
                  ))}
                </View>
              ) : (
                <Text className='page-report__toc-hint'>按节直达，不必一路滑到底。</Text>
              )}
            </View>
          )}

          {/*
            人物速览：把博查返回的素材聚合成「本人近来的公开信息覆盖」，全部字段原样统计、
            不经模型改写，因此可以当作事实读。三行分别回答三个此前没人回答的问题：
            热度怎么来的（近 30 天 / 近 7 天报道量）、最近一次公开动态是什么时候、
            这份报告的素材覆盖了哪段时间。原先这个位置放的是「同领域名人」——
            读一份关于 A 的报告，却被推荐 B、C、D，与「我在看谁」是脱节的。
          */}
          {/* 端上算得出覆盖范围就出真卡；算不出时也出一张卡说明（原先 `(cov || coverageSpan !== '') &&`
              不成立就整卡消失，用户只看到「卡片不见了」）。降级简版除外：整份只留上方警示条，不堆空卡。 */}
          {!report.degraded && !cov && coverageSpan === '' && (
            <View id='sec-overview' className='card'>
              <View className='card-title'>人物速览</View>
              <Text className='page-report__empty'>
                这份报告没有记录素材覆盖范围（多为较早生成的缓存报告），收录的动态也都没有可用日期，故算不出报道热度与覆盖区间。点右上角「查看最新」重新生成即可补上。
              </Text>
            </View>
          )}
          {(cov || coverageSpan !== '') && (
            <View id='sec-overview' className='card'>
              <View className='card-title'>人物速览</View>

              {cov && (
                <View className='page-report__info'>
                  <Text className='page-report__info-label'>报道热度</Text>
                  <View className='page-report__info-body'>
                    <Text className='page-report__info-value'>
                      近 30 天 {cov.items} 篇 · 近 7 天 {cov.recent} 篇
                    </Text>
                    {/* 简版降级的 heat 恒为 0（见 report.ts），这时不该拿它去解释任何东西 */}
                    {!report.degraded && (
                      <Text className='page-report__info-sub'>热度 {report.heat} 由这两项报道量按公式算出</Text>
                    )}
                  </View>
                </View>
              )}

              {cov?.latest && (
                <View className='page-report__info'>
                  <Text className='page-report__info-label'>最新报道</Text>
                  <View className='page-report__info-body'>
                    <View
                      className='page-report__info-value page-report__info-link'
                      hoverClass='page-report__info-link--tap'
                      onClick={() =>
                        openSourceLink({
                          url: cov.latest!.url,
                          title: cov.latest!.title,
                          source: cov.latest!.source,
                          date: cov.latestAt ? fromNow(cov.latestAt) : ''
                        })
                      }
                    >
                      {cov.latest.title || '查看原文'}
                    </View>
                    <Text className='page-report__info-sub'>
                      {cov.latestAt ? `${fromNow(cov.latestAt)} · ` : ''}
                      {cov.latest.source || hostOf(cov.latest.url) || '网络'}
                    </Text>
                  </View>
                </View>
              )}

              {coverageSpan !== '' && (
                <View className='page-report__info'>
                  {/* 有 coverage 说明区间来自博查素材的发布时间，否则只能来自模型给的动态日期 */}
                  <Text className='page-report__info-label'>{cov?.firstAt ? '覆盖区间' : '动态覆盖'}</Text>
                  <View className='page-report__info-body'>
                    <Text className='page-report__info-value'>{coverageSpan}</Text>
                  </View>
                </View>
              )}
            </View>
          )}

          {/* 简介留空也出卡说明（原先 `report.intro &&` 不成立就整卡消失）。
              降级简版除外：那种报告整份只留上方警示条。 */}
          {!report.degraded && !report.intro && (
            <View id='sec-intro' className='card'>
              <View className='card-title'>简介</View>
              <Text className='page-report__empty'>
                本次生成没有给出简介（模型未返回这一段的正文）。下方的人物档案、动态与语录不受影响，可照常阅读。
              </Text>
            </View>
          )}
          {report.intro && (
            <View id='sec-intro' className='card'>
              <View className='card-title'>简介</View>
              <View className='page-report__text'>{report.intro}</View>
            </View>
          )}

          {/*
            人物档案（第二批）：把散在简介那段散文里的身份锚点提成「字段名 : 值」。
            与简介不是重复关系 —— 简介回答「他最近怎么样」，档案回答「他是谁」，
            后者要能一眼扫完，所以左边字段名对齐成一列、值一行一条。

            profile 是可选字段，这里有**两种空**要分开：
              · 键不存在 → 改动前落库的老报告，整卡降级（那时根本没要过这一段，
                不能替它断言「素材里没有」）；
              · 键存在但为空数组 → 本次生成确认「素材里确实没有」，此时**卡片照出**，
                卡里写明为什么是空的。
            后者是 2026-10-08 改的：此前空数组不落库，两种「空」在页面上长得一样，
            用户看到的是卡片凭空消失，只能怀疑是坏了（见 utils/report.ts 的 sanitizeReport）。
            条目的 basis 在 utils/report.ts 里已强制为「真素材」，
            指不出出处的条目在落库前就被剔除了 —— 所以这里的每条依据都点得回去。
          */}
          {report.profile && (
            <View id='sec-profile' className='card'>
              <View className='card-title'>人物档案</View>
              {report.profile.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的身份信息 —— 指不出出处的信息一律不收录，这一卡宁缺毋滥。
                </Text>
              )}
              {report.profile.map((p, i) => (
                <View key={`${i}-${p.label}`} className='page-report__entry'>
                  <View className='page-report__entry-head'>
                    <Text className='page-report__entry-label'>{p.label}</Text>
                    <Text className='page-report__entry-value'>{p.value}</Text>
                  </View>
                  <Text className='page-report__entry-basis'>依据：{p.basis}</Text>
                </View>
              ))}
              <Text className='page-report__entry-foot'>每条档案均出自本报告收录的素材，找不到出处的信息不收录。</Text>
            </View>
          )}

          {/* 关系图谱（第二批）：人-人维度。关系必须是素材里明确写到的，
              故这里的依据与档案同规格；四档关系标签一律中性配色，不因「对手」染色。 */}
          {report.relations && (
            <View id='sec-relations' className='card'>
              <View className='card-title'>关系图谱</View>
              {report.relations.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有明确写到的人物关系（不做「同框即关系」一类推测）。
                </Text>
              )}
              {report.relations.map((r, i) => (
                <View key={`${i}-${r.name}`} className='page-report__entry'>
                  <View className='page-report__entry-head'>
                    <Text className='page-report__entry-name'>{r.name}</Text>
                    <Text className='page-report__entry-tag'>{RELATION_META[r.relation] ?? '其他'}</Text>
                  </View>
                  {r.note !== '' && <Text className='page-report__entry-text'>{r.note}</Text>}
                  <Text className='page-report__entry-basis'>依据：{r.basis}</Text>
                </View>
              ))}
              <Text className='page-report__entry-foot'>关系出自素材的明确记载，不做「同框即关系」一类推测。</Text>
            </View>
          )}

          {/*
            商业价值速览（第 0 期，端上聚合）：把报告已有素材换成「一屏看结论」的商业读法。

            它与数据 Tab 的关系是「同一批数字的两种读法」：那边是核对用的面板（分布 / 交叉 /
            走势），这边是决策用的入口（一句话结论 + 点回明细）。所以这张卡**刻意不画图、
            不铺明细**，否则报告页会出现第二份统计面板。三段的口径与取舍见 utils/commercial.ts。

            门槛（成立的分项 < MIN_AXES）没过时仍出卡，改为逐条写明缺什么 —— 这一屏最怕的是
            「某一项不见了」被读成「这一项没问题」。降级简版没有结构化素材，整卡不出。
          */}
          {commercial && !report.degraded && (
            <View id='sec-commercial' className='card'>
              <View className='card-title'>商业价值速览</View>
              <Text className='page-report__cv-lead'>
                把本报告已收录的素材换个角度汇总：有没有人在报道、媒体怎么写、有没有争议。
                不新增检索与推断，每个数字的明细都能点回去核对。
              </Text>

              {commercial.ready ? (
                <>
                  {commercial.axes.map((a) => (
                    <View key={a.key} className='page-report__cv-item'>
                      <View className='page-report__cv-head'>
                        <Text className='page-report__cv-label'>{a.label}</Text>
                        <Text className='page-report__cv-value'>{a.value}</Text>
                      </View>
                      <Text className='page-report__cv-note'>{a.note}</Text>
                      {a.anchor !== '' && (
                        /* 用 View 而非 Text：小程序里 hover-class 只对 view / button 生效，
                           Text 上的 hoverClass 既不生效、也不被 Taro 类型接受 */
                        <View
                          className='page-report__cv-more'
                          hoverClass='page-report__cv-more--tap'
                          onClick={() => jumpToSection(a.anchor)}
                        >
                          明细见「{a.anchorLabel}」›
                        </View>
                      )}
                    </View>
                  ))}

                  {/* 没成立的分项照写原因：与其它卡的「不成立也出卡说明」同一条约定 */}
                  {commercial.gaps.map((g) => (
                    <View key={g.label} className='page-report__cv-item'>
                      <View className='page-report__cv-head'>
                        <Text className='page-report__cv-label'>{g.label}</Text>
                        <Text className='page-report__cv-value page-report__cv-value--none'>未收录</Text>
                      </View>
                      <Text className='page-report__cv-note'>{g.reason}</Text>
                    </View>
                  ))}
                </>
              ) : (
                <Text className='page-report__empty'>
                  {`本报告能汇总的分项不足 ${MIN_AXES} 项，故不出速览 —— 硬凑出来的「一屏结论」比没有更误导。${commercial.gaps
                    .map((g) => `${g.label}：${g.reason}`)
                    .join('')}`}
                </Text>
              )}

              <Text className='page-report__entry-foot'>
                只汇总本报告已收录的素材，不含评分、预测或结论；明细见各节的原始条目与出处。
              </Text>
            </View>
          )}

          {/* 近期动态：报告的主体。素材里确实没有时也出卡并写明原因 —— 空数组意味着
              「本次生成确认没有」（与老报告的「没有这个字段」不是一回事），
              此前直接不出卡，用户只能把它读成「页面坏了、模块丢了」。
              降级简版除外：那种报告整份都没有结构化内容，只留上方那条警示条。 */}
          {!report.degraded && (
            <View id='sec-dynamics' className='card'>
              <View className='card-title'>近期动态（{dynamicsView.length}）</View>
              {dynamicsView.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的近期动态。情绪走势、词云等统计都以此卡为数据源，故随之不展示。
                </Text>
              )}
              {dynamicsView.map((d, i) => {
                const domain = hostOf(d.url)
                return (
                  <View key={i} className='page-report__item'>
                    <View className='page-report__item-head'>
                      <Text className='page-report__item-date'>{d.date}</Text>
                      <View className={`page-report__sentiment ${SENTIMENT_META[d.sentiment]?.cls ?? 'neutral'}`}>
                        {SENTIMENT_META[d.sentiment]?.label ?? '中性'}
                      </View>
                    </View>
                    {/* 标题即素材入口：点标题进「原文预览」（见 openSourceLink）。
                        不加「复制链接」按钮，避免同一条内容出现两个通往同一结果的入口。 */}
                    <View
                      className='page-report__item-title'
                      hoverClass='page-report__item-title--tap'
                      onClick={() =>
                        openSourceLink({
                          url: d.url,
                          title: d.title,
                          source: d.source || domain,
                          date: d.date,
                          summary: d.summary
                        })
                      }
                    >
                      {d.title}
                    </View>
                    {d.summary && (
                      <View className='page-report__item-summary text-secondary'>{d.summary}</View>
                    )}
                    <View className='page-report__item-src text-tertiary'>
                      <Text>来源：{d.source || '网络'}</Text>
                      {domain && <Text className='page-report__domain'>{domain}</Text>}
                    </View>
                  </View>
                )
              })}
            </View>
          )}

          {!report.degraded && (
            <View id='sec-quotes' className='card'>
              <View className='card-title'>经典名言</View>
              {report.quotes.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的原文语录（声称有出处、却指不出是哪条素材的，整条不收录）。
                </Text>
              )}
              {report.quotes.map((q, i) => {
                const favId = favIdOf('quote', `${personKey}:${q.text}`)
                const faved = !!favId && favedIds.has(favId)
                return (
                  <View key={i} className='page-report__quote'>
                    <View className='page-report__quote-text'>「{q.text}」</View>
                    {/* 脚注（出处 + 「查证」+ 收藏）整个交给 QuoteDetail：名言的出处本身就是一条素材链接，
                        所以「查证」不是查真伪（平台没有能判定真伪的语料，见 utils/quote-check.ts），
                        而是把这条语录的背景、注解与出处报道一次摊开 —— 纯端上，点开即出结果。
                        收藏星标仍由本页给：两页对「这条还能做什么」的取舍不同。 */}
                    <QuoteDetail
                      report={report}
                      quote={q}
                      extra={
                        <Text
                          className={`page-report__fav-icon ${faved ? 'page-report__fav-icon--on' : ''}`}
                          onClick={() => void toggleQuoteFav(q)}
                        >
                          {faved ? '★' : '☆'}
                        </Text>
                      }
                    />
                  </View>
                )
              })}
            </View>
          )}

          {report.degraded && (
            <View className='warn-bar'>
              结构化生成暂不可用，本次为纯文本简版：点评基于模型已有知识，未引用实时素材。
            </View>
          )}

          {/* 点评为空也出卡说明（原先 `report.analysis &&` 不成立就整卡消失）。
              降级简版有整段 analysis 时照旧出「AI 点评 · 简版」，故这里不排除 degraded。 */}
          {!report.degraded && !report.analysis && (
            <View id='sec-analysis' className='card'>
              <View className='card-title'>AI 点评</View>
              <Text className='page-report__empty'>
                本次生成没有给出点评正文（模型未返回这一段的正文）。上方的人物档案、动态与语录不受影响，可照常阅读。
              </Text>
            </View>
          )}
          {report.analysis && (
            <View id='sec-analysis' className='card'>
              <View className='card-title'>{report.degraded ? 'AI 点评 · 简版' : 'AI 点评'}</View>
              {/*
                点评（本轮修正）：原先把 3~4 条判断**一条一条摆成列表**、每条下面挂一行
                「依据：XX」，读起来是一份论点清单 —— 用户反馈「这不是 AI 点评」。
                而 analysis 本来就是这几句连成的一整段（见 sanitizeReport），现在直接按一段读，
                句末只留一个 [n]，出处集中列在段末。

                [n] 与出处的对应不能省：拆条相对整段的全部意义就是「判断与出处分开摆，
                用户自己判断这条可不可信」（提示词第 5 条）。压成一段而丢掉对应关系，
                等于把上次升级的价值一起丢了 —— 所以是换排版，不是退回整段。
              */}
              {report.analysisPoints && report.analysisPoints.length > 0 ? (
                <View>
                  <Text className='page-report__analysis-text'>
                    {report.analysisPoints.map((p, i) => (
                      <Text key={`${i}-${p.basis}`}>
                        {/[。！？!?]$/.test(p.point) ? p.point : `${p.point}。`}
                        <Text className='page-report__point-ref'>{`[${i + 1}]`}</Text>
                      </Text>
                    ))}
                  </Text>
                  <View className='page-report__points'>
                    <Text className='page-report__points-title'>判断依据</Text>
                    {report.analysisPoints.map((p, i) => (
                      <Text
                        key={`basis-${i}`}
                        className='page-report__point-basis'
                      >{`[${i + 1}] ${p.basis}`}</Text>
                    ))}
                  </View>
                </View>
              ) : (
                <View className='page-report__analysis-text'>{report.analysis}</View>
              )}
            </View>
          )}

          {/*
            近期争议与回应（第二批）：**免费段**，刻意摆在会员卡之前。
            它回答的是「最近吵过什么、当事人怎么答的」，与会员专享的 memberNotes.risk
            （面向未来的风险提示）是两件事 —— 边界写在提示词里：已发生的争议归 free，
            前瞻判断归会员。二者共读时是「事实 + 判断」的两层，不是同一条的两种说法。

            response 允许为空（素材里当事方没公开回应过是常态），此时不出「回应」那一行，
            而不是补一句「暂无回应」——「暂无」是我们替素材下的结论，素材本身没这么说。
          */}
          {report.controversies && (
            <View id='sec-controversies' className='card'>
              <View className='card-title'>近期争议与回应</View>
              {report.controversies.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的公开争议（只有素材真的写到才收录，不把「没看到争议」写成「没有争议」）。
                </Text>
              )}
              {report.controversies.map((c, i) => (
                <View key={`${i}-${c.topic}`} className='page-report__entry'>
                  <Text className='page-report__entry-name'>{c.topic}</Text>
                  <Text className='page-report__entry-text'>争议：{c.claim}</Text>
                  {c.response !== '' && <Text className='page-report__entry-text'>回应：{c.response}</Text>}
                  <Text className='page-report__entry-basis'>依据：{c.basis}</Text>
                </View>
              ))}
              <Text className='page-report__entry-foot'>只记录素材中已公开的争议与回应，平台不作真伪判定，也不做评价。</Text>
            </View>
          )}

          {/*
            风险雷达（第 0 期）：与上面「近期争议与回应」的分工 —— 争议卡是**叙述**
            （模型整理过的争议与回应），本卡是**索引**（从全篇素材里字面挑出的表述），
            因此能覆盖「不构成争议、但有出处」的动作（例如「起诉造谣者」这类维权表态）。

            与下面会员段 memberNotes.risk 的分工：本卡是**已发生**的表述（事实，免费），
            会员段是**面向未来**的判断 —— 与 controversies / risk 是同一套边界口径，禁止互相搬运。

            ⚠ 整卡不出现「风险等级 / 高危 / 疑似」，也不给排序评分：平台只指出素材里写了什么，
              是否构成问题由读者拿着原文判断（口径见 utils/risk.ts 顶部注释）。
              降级简版（degraded）没有结构化素材，整卡不出。
          */}
          {risk && !report.degraded && (
            <View id='sec-risk' className='card'>
              <View className='card-title'>风险雷达</View>
              <Text className='page-report__risk-lead'>
                从本报告收录的 {risk.scanned} 条素材里，挑出涉及司法监管、商业合作、名誉维权的字面表述，
                逐条给出处。平台只陈列素材写法，不作判定，也不作预测。
              </Text>

              {/* 类别分布：给条数、不给分档 —— 「3 条」是事实，「高风险」是结论 */}
              {risk.signals.length > 0 && (
                <View className='page-report__risk-tags'>
                  {RISK_CATEGORIES.filter((c) => risk.byCategory[c] > 0).map((c) => (
                    <Text key={c} className={`page-report__risk-tag page-report__risk-tag--${c}`}>
                      {RISK_CATEGORY_LABEL[c]} {risk.byCategory[c]}
                    </Text>
                  ))}
                </View>
              )}

              {/* 空态照出卡说明（2026-10-08 约定：端上聚合不成立也要写明为什么没内容） */}
              {risk.signals.length === 0 && (
                <Text className='page-report__empty'>
                  {risk.scanned > 0
                    ? `本次收录的 ${risk.scanned} 条素材里没有出现上述类型的表述。只按字面统计，没出现过的不会被推测出来。`
                    : '本报告没有可扫描的结构化素材（纯文本简版），这一块无法统计。'}
                </Text>
              )}

              {risk.signals.map((s, i) => (
                <View key={`${s.from}-${i}-${s.keyword}`} className='page-report__risk-item'>
                  <View className='page-report__risk-head'>
                    <Text className={`page-report__risk-tag page-report__risk-tag--${s.category}`}>
                      {RISK_CATEGORY_LABEL[s.category]}
                    </Text>
                    <Text className='page-report__risk-from'>
                      {RISK_FROM_LABEL[s.from]}
                      {s.date ? ` · ${s.date}` : ''}
                    </Text>
                  </View>
                  <Text className='page-report__risk-text'>
                    出现「{s.keyword}」：{s.text}
                  </Text>
                  {s.url ? (
                    <View
                      className='page-report__risk-src page-report__risk-src--link'
                      hoverClass='page-report__risk-src--tap'
                      onClick={() =>
                        openSourceLink({ url: s.url, title: s.text, source: s.source, date: s.date })
                      }
                    >
                      出处：{s.source || '素材未标注'} · 查看原文 ›
                    </View>
                  ) : (
                    <Text className='page-report__risk-src'>出处：{s.source || '素材未标注'}</Text>
                  )}
                </View>
              ))}

              {risk.total > risk.signals.length && (
                <Text className='page-report__risk-note'>
                  另有 {risk.total - risk.signals.length} 条同类表述未逐条列出。
                </Text>
              )}
              {risk.unanswered > 0 && (
                <Text className='page-report__risk-note'>
                  争议记录中有 {risk.unanswered} 条未见公开回应（素材没收录到回应，不等于没有回应）。
                </Text>
              )}
              {risk.negative !== null && risk.negativeShare !== null && (
                <Text className='page-report__risk-note'>
                  收录条目中标注为消极的 {risk.negative} 条（占 {Math.round(risk.negativeShare * 100)}%），
                  情绪归类口径与上方「立场与舆情」一致。
                </Text>
              )}
              <Text className='page-report__entry-foot'>
                只做字面命中统计，不含语义判定；「未被起诉」这类否定表述已排除。每条都可回溯到原文。
              </Text>
            </View>
          )}

          {/*
            会员专享：对比视角 + 风险提示 + 信源分歧（O-11 / 批 1 2026-10-09）。
            这些段落只在会员生成时被请求（见 utils/report.ts 的 MEMBER_HINT_REALTIME），但它们**不是**
            免费的：报告是全局共享缓存、不按身份切分（否则同一个人会有两份报告，热度与来源
            还不一致），免费用户完全可能读到会员生成的那一份。
            批 1 起「不给免费用户看」已下沉到数据层（utils/cache.ts#exposeReport）：
            非会员拿到的 report 里**根本没有**这两个字段，所以这里的 `member` 不再是防泄漏的
            第二道闸 —— 它是「这张卡属于谁」：本卡是页面上唯一的会员身份确认位（见下方注释），
            非会员整卡不出。即便这个判断以后被人挪掉，漏出去的也只是一张空卡，不再是内容。
            免费用户整卡不出，刻意不做「灰掉 + 开通会员」的诱导样式：
            免费用户看到的每一处留白都得额外解释一遍，报告页已经够长了。
            ⚠ 两个字段要**各自**判空：老会员报告只有 memberNotes，新报告才可能有 conflicts，
              用 memberNotes 的存在与否去决定整卡出不出，会让只带 conflicts 的报告整张消失。
          */}
          {member && !report.degraded && (
            <View id='sec-member' className='card page-report__notes'>
              {/* 标题行兼作「会员权益已生效」的确认位（O-25）：顶部促销条已对会员隐藏，
                  这张卡能出现本身就是确认 —— 再补一个「已生效」小标，比一句推销语诚实，也更省地方。
                  原先这里的 id="report-notes" 是给顶部条的「查看 ›」做页内滚动锚点的，随该分支一并删除。 */}
              <View className='page-report__notes-head'>
                <View className='card-title'>会员专享 · 深度解析</View>
                <Text className='page-report__notes-badge'>已生效</Text>
              </View>
              {/* 会员段落整体缺失时，把原因写清楚，而不是让整卡消失（2026-10-08 改）。
                  报告是**全局共享缓存**，所以会员也会读到免费生成（或分配置更早）的那一份 ——
                  那种报告里根本没有这两个字段（提示词里没要过）。此时若无提示，会员看到的是
                  「深度解析」整块不见，很容易理解成权益没生效。
                  2026-10-09 补：这一次「补齐」是替**全站**把这行共享缓存升级成会员版，
                  不该让他掏自己的每日次数，故明说（复核与免计费见 cloudfunctions/quotaGuard）。
                  文案里的「三段」与下方三段一一对应：对比视角 / 风险提示 / 信源分歧。 */}
              {!report.memberNotes && !report.conflicts && (
                <Text className='page-report__empty'>
                  这份报告生成时没有包含会员段落（可能是免费生成、或较早的缓存）。点上方「查看最新」用会员档重新生成，
                  即可得到对比视角、风险提示与信源分歧这三段 —— 这次补齐不消耗你的每日生成次数。
                </Text>
              )}
              {/* 两段各自判空：memberNotes 可能整个不存在（只带 conflicts 的缓存），
                  写成 `report.memberNotes?.compare !== ''` 会在 undefined 时恒为真、渲染出空段 */}
              {report.memberNotes && report.memberNotes.compare !== '' && (
                <View className='page-report__note'>
                  <Text className='page-report__note-label'>对比视角</Text>
                  <Text className='page-report__note-text'>{report.memberNotes.compare}</Text>
                </View>
              )}
              {report.memberNotes && report.memberNotes.risk !== '' && (
                <View className='page-report__note'>
                  <Text className='page-report__note-label page-report__note-label--risk'>风险提示</Text>
                  <Text className='page-report__note-text'>{report.memberNotes.risk}</Text>
                </View>
              )}
              {/*
                信源分歧（本轮新增）：两边说法并排摆出，不做裁决 —— 报告只负责指出「素材自己对不上」，
                判断权交回用户。这也正是它与上面两段的分工：两段是模型观点，这一段是素材事实。
              */}
              {report.conflicts && report.conflicts.length > 0 && (
                <View className='page-report__note'>
                  <Text className='page-report__note-label'>信源分歧</Text>
                  {report.conflicts.map((c, i) => (
                    <View key={`${i}-${c.topic}`} className='page-report__conflict'>
                      <Text className='page-report__conflict-topic'>{c.topic}</Text>
                      <Text className='page-report__conflict-side'>一方说法：{c.a}</Text>
                      <Text className='page-report__conflict-side'>另一方说法：{c.b}</Text>
                    </View>
                  ))}
                </View>
              )}
              <Text className='page-report__note-foot'>
                以上均由 AI 依据本报告收录素材给出，无素材支撑处留空，可对照下方来源自行核对。
              </Text>
            </View>
          )}

          {/* 立场与舆情：两块内容（本地统计的情绪走向 + 模型判定的话题态度）都可能为空，
              但卡片本身照出 —— 空的那块写明口径，别让整卡消失。降级简版除外。 */}
          {!report.degraded && (
            <View id='sec-stance' className='card'>
              <View className='card-title'>立场与舆情</View>
              {!sentimentStats && (
                <Text className='page-report__empty'>
                  本报告收录的动态不足以归类情绪（至少要有 1 条带情绪标签的动态）。
                </Text>
              )}
              {sentimentStats && (
                <>
                  {/* 情绪走向条：三段按条数占比铺开，颜色与「近期动态」的情绪标签同源。
                      只呈现比例、不作红绿定性评价 —— 统计口径不该被读成对人物本身的褒贬。 */}
                  <View className='page-report__stance-bar'>
                    {sentimentStats.positive > 0 && (
                      <View
                        className='page-report__stance-seg page-report__stance-seg--positive'
                        style={{ flex: sentimentStats.positive }}
                      />
                    )}
                    {sentimentStats.neutral > 0 && (
                      <View
                        className='page-report__stance-seg page-report__stance-seg--neutral'
                        style={{ flex: sentimentStats.neutral }}
                      />
                    )}
                    {sentimentStats.negative > 0 && (
                      <View
                        className='page-report__stance-seg page-report__stance-seg--negative'
                        style={{ flex: sentimentStats.negative }}
                      />
                    )}
                  </View>
                  <View className='page-report__stance-legend'>
                    <Text className='page-report__stance-legend-item'>积极 {sentimentStats.positive}</Text>
                    <Text className='page-report__stance-legend-item'>中性 {sentimentStats.neutral}</Text>
                    <Text className='page-report__stance-legend-item'>消极 {sentimentStats.negative}</Text>
                  </View>
                  <Text className='page-report__stance-note'>
                    基于本报告收录的 {sentimentStats.total} 条公开动态归类统计。
                  </Text>
                </>
              )}

              {/* 话题态度：情绪条说「整体氛围如何」，这里说「哪些话题上是这个氛围」——
                  后者才是可核对的对象（每条都附模型给出的一句话依据）。 */}
              {stances.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材不足以判断各话题上的舆论态度（每条都要求附依据，指不出依据的不写）。
                </Text>
              )}
              {stances.length > 0 && (
                <View className='page-report__stance-topics'>
                  {stances.map((s, i) => (
                    <View key={i} className='page-report__stance-topic'>
                      <View className='page-report__stance-topic-head'>
                        <Text className='page-report__stance-topic-name'>{s.topic}</Text>
                        <Text
                          className={`page-report__stance-tag page-report__stance-tag--${
                            STANCE_META[s.attitude]?.cls ?? 'neutral'
                          }`}
                        >
                          {STANCE_META[s.attitude]?.label ?? '中性'}
                        </Text>
                      </View>
                      {s.note !== '' && (
                        <Text className='page-report__stance-topic-note'>{s.note}</Text>
                      )}
                    </View>
                  ))}
                  <Text className='page-report__stance-note'>
                    话题态度由 AI 依据本报告收录素材判定，未必代表主流舆论。
                  </Text>
                </View>
              )}
            </View>
          )}

          {/*
            关键词云 + 高频观点（M4-5）：纯端上统计（口径见 utils/keywords.ts），不消耗生成额度。

            词数不足 4 个时**不整卡消失**：原先写的是「keywords.length >= 4 &&」，不够就整卡不出。
            端上统计不消耗额度，卡片凭空不见只会被读成功能坏了 —— 照出卡片并写明为什么没出词云，
            读的人才知道是「素材本来就只有这几条」，而不是坏了。
            降级简版除外：那种报告整份没有结构化内容，只留上方那条警示条。
          */}
          {!report.degraded && (
            <View id='sec-cloud' className='card'>
              <View className='card-title'>关键词云</View>
              {keywords.length < 4 && (
                <Text className='page-report__empty'>
                  {`本次生成时，本报告收录的 ${report.dynamics.length} 条动态与 ${report.quotes.length} 条语录里，反复出现的说法不足 4 个（少于 4 个词只会是一堆零散碎片），故不出词云。词云按「有多少条素材提到它」统计，素材太少时这个数没有意义。`}
                </Text>
              )}
              {keywords.length >= 4 && (
                <>
                  {/* 标签墙：不引 canvas / 图表库，字号按词频分三档（设计方案 §3.3 定稿的降级方案） */}
                  <View className='page-report__cloud'>
                    {keywords.map((k) => (
                      <Text
                        key={k.word}
                        className={`page-report__cloud-tag page-report__cloud-tag--t${k.tier}${
                          k.from === 'topic' ? ' page-report__cloud-tag--topic' : ''
                        }`}
                        /* 每个词都可点：本页只回答「这份报告里反复提了什么」，
                           点下去才回答「别人是不是也在讲」。 */
                        onClick={() => goTopic(k.word)}
                      >
                        {k.word}
                      </Text>
                    ))}
                  </View>
                  <Text className='page-report__cloud-note'>
                    {`按收录的 ${report.dynamics.length} 条动态与 ${report.quotes.length} 条语录统计，字号代表提及它的素材条数；中文无词典，仅作主题速览。点任一词语可看它在别的报告里怎么说 —— 其中话题词来自模型判定的热点话题（未必在素材正文里原样出现），聚合结果按正文里真写过这个词的报告算。`}
                  </Text>

                  {keywordHighlights.length > 0 && (
                    <View className='page-report__highlights'>
                      <View className='page-report__highlights-title'>高频观点</View>
                      {keywordHighlights.map((k) => (
                        <View key={k.word} className='page-report__highlight'>
                          <View className='page-report__highlight-head'>
                            <Text
                              className='page-report__highlight-word'
                              onClick={() => goTopic(k.word)}
                            >
                              {`${k.word} ›`}
                            </Text>
                            <Text className='page-report__highlight-count'>{k.count} 条素材提及</Text>
                          </View>
                          {/* 词云说「反复提到了什么」，这里给出「是在哪些素材里提到的」——
                              每个词都摊开原文出处，读的人可以自己核对，不存在凭空生成的词 */}
                          {k.refs.map((r, i) => (
                            <Text key={i} className='page-report__highlight-ref'>
                              {`· ${r.label}（${r.source}）`}
                            </Text>
                          ))}
                        </View>
                      ))}
                      <Text className='page-report__cloud-note'>
                        以上说法在本报告收录的素材中反复出现，逐条附原文出处，可自行核对。
                      </Text>
                    </View>
                  )}
                </>
              )}
            </View>
          )}

          {/*
            语录主题：把平铺的语录按「他常讲的话」归成 2~3 组（口径与门槛见
            utils/keywords.ts 的 extractQuoteThemes）。主题词取自语录原文，不是模型分类，
            故每条语录都能在「经典语录」里逐一核对。

            归不出一组时**不整卡消失**：原先写的是「quoteThemes.length >= 2 &&」，不够就整卡不出。
            主题词是数语录原文里反复出现的说法，语录少自然数不出来 —— 卡片照出并说明，
            免得被读成功能坏了。降级简版除外（整份只有警示条）。
          */}
          {!report.degraded && (
            <View id='sec-qtheme' className='card'>
              <View className='card-title'>语录主题</View>
              {quoteThemes.length < 2 && (
                <Text className='page-report__empty'>
                  {`本次生成时，本报告收录的 ${report.quotes.length} 条语录里，反复出现的说法不足以归成 2 组以上主题（主题词取自语录原文，不做语义归类），故本卡只作说明。语录本身照旧全部列在「经典名言」里。`}
                </Text>
              )}
              {quoteThemes.length >= 2 && (
                <>
                  {quoteThemes.map((t) => (
                    <View key={t.topic} className='page-report__qtheme'>
                      <View className='page-report__qtheme-head'>
                        <Text className='page-report__qtheme-topic'>{t.topic}</Text>
                        <Text className='page-report__qtheme-count'>{`${t.count} 条语录`}</Text>
                      </View>
                      {t.quotes.map((q, i) => (
                        <Text key={i} className='page-report__qtheme-quote'>{`· ${q}`}</Text>
                      ))}
                    </View>
                  ))}
                  <Text className='page-report__cloud-note'>
                    {`主题词取自语录原文里反复出现的说法（不做语义归类），每条语录只归入一个主题；本报告共 ${report.quotes.length} 条语录，未归入的照旧留在「经典语录」里。`}
                  </Text>
                </>
              )}
            </View>
          )}

          {/*
            热度趋势（M4-6）：把报告里带日期的动态与时间线事件摊成折线（默认近 30 天，
            材料稀疏时由 buildHeatTrend 放宽到 60/90/180 天，脚注据实标注窗口与格宽）。
            点和线都是普通 View（几何在 trendGeometry 里算成 rpx），与词云、情绪条同一条
            「不引图表库」的路线；纵轴是条数、横轴是时间，脚注交代口径，免得被读成全网报道量。

            条件没过时**不整卡消失**：原先写的是「trend && trendGeo &&」，不成立就什么都不渲染。
            这张卡是端上聚合、不消耗生成额度，「无声无息少一张图」只会被读成功能坏了 ——
            照出卡片并写明为什么没画线，读的人才知道是素材稀疏，而不是坏了。
            降级简版除外：那种报告整份没有结构化内容，只留上方那条警示条。
          */}
          {!report.degraded && (
            <View id='sec-trend' className='card'>
              <View className='card-title'>热度趋势</View>
              {(trend == null || trendGeo == null) && (
                <Text className='page-report__empty'>
                  {trend == null
                    ? '本次生成时，本报告收录的带日期条目不足 3 条（少于 3 个点连不成走势），故不画折线。可点开上方「近期动态」「时间线」逐条核对 —— 这张图的数据源就是它们。'
                    : '这份报告的生成时间不可解析，横轴刻度无从对齐，故不画折线。'}
                </Text>
              )}
              {trend && trendGeo && (
                <>
                  <View className='page-report__trend'>
                    <View className='page-report__trend-plot'>
                      {[25, 50, 75].map((top) => (
                        <View key={top} className='page-report__trend-grid' style={{ top: `${top}%` }} />
                      ))}
                      {trendGeo.segs.map((s, i) => (
                        <View
                          key={`seg-${i}`}
                          className='page-report__trend-seg'
                          style={{
                            left: `${s.left}rpx`,
                            top: `${s.top}rpx`,
                            width: `${s.len}rpx`,
                            transform: `rotate(${s.deg}deg)`
                          }}
                        />
                      ))}
                      {trendGeo.nodes.map((n, i) => (
                        <View
                          key={`dot-${i}`}
                          className={`page-report__trend-dot${n.ratio >= 1 ? ' page-report__trend-dot--peak' : ''}`}
                          style={{ left: `${n.cx}rpx`, top: `${n.cy}rpx` }}
                        />
                      ))}
                      {/* 只在有内容的桶上标数字：空桶标 0 会让这条线看起来像数据缺失 */}
                      {trendGeo.nodes.map((n, i) =>
                        n.count > 0 ? (
                          <Text
                            key={`val-${i}`}
                            className='page-report__trend-value'
                            style={{ left: `${n.cx}rpx`, top: `${n.cy - 34}rpx` }}
                          >
                            {n.count}
                          </Text>
                        ) : null
                      )}
                    </View>
                    {/* 横轴标签用等宽 flex 均分，中心正好落在各桶中点，与折线上的点对齐 */}
                    <View className='page-report__trend-axis'>
                      {trend.points.map((p, i) => (
                        <Text key={`axis-${i}`} className='page-report__trend-axis-label'>
                          {p.label}
                        </Text>
                      ))}
                    </View>
                  </View>
                  <Text className='page-report__trend-note'>
                    {`按本报告收录的带日期条目聚合：${trend.from} ~ ${trend.to} 共 ${trend.total} 条动态与事件、覆盖 ${trend.spanDays} 天（每格 ${Math.round(
                      trend.windowDays / trend.points.length
                    )} 天，纵轴为条数，单格峰值 ${trend.peak}）。反映公开信息节奏，不等于全网报道量。`}
                  </Text>
                </>
              )}
            </View>
          )}

          {!report.degraded && (
            <View id='sec-timeline' className='card'>
              <View className='card-title'>时间线</View>
              {timelineView.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的关键事件。
                </Text>
              )}
              {timelineView.map((t, i) => (
                <View key={i} className='page-report__timeline-item'>
                  <View className='page-report__timeline-dot' />
                  <View className='page-report__timeline-body'>
                    <Text className='page-report__item-date'>{t.date}</Text>
                    <Text className='page-report__timeline-event'>{t.event}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* 后续关注（第二批）：时间线是往回看，这张卡是往前看 —— 报告因此从「一份回顾」
              变成「一份可以跟踪的东西」。只收素材里已公布的时间点，故 when 常是「2026-11」
              这种刻度而不是精确日期；素材没公布就不写（猜档期是推断，不是信息）。 */}
          {report.watchlist && (
            <View id='sec-watchlist' className='card'>
              <View className='card-title'>后续关注</View>
              {report.watchlist.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有已公布的时间点（档期一类不作推测，未公布就留空）。
                </Text>
              )}
              {report.watchlist.map((w, i) => (
                <View key={`${i}-${w.when}`} className='page-report__entry'>
                  <Text className='page-report__entry-name'>{w.when}</Text>
                  <Text className='page-report__entry-text'>{w.what}</Text>
                  <Text className='page-report__entry-basis'>依据：{w.basis}</Text>
                </View>
              ))}
              <Text className='page-report__entry-foot'>只列素材中已公布的时间点，未公布的不作推测。</Text>
            </View>
          )}

          {/* 名词解释（第二批）：报告里出现的行话与背景词。摆在这个位置是当「页脚工具」用 ——
              读到这里遇到没看懂的词，往回翻不如就地查。也是全项目唯一不带出处的模型段落
              （它答的是词义，不是关于本人的事实断言，理由见 utils/report.ts 的 Schema 注释）。 */}
          {report.glossary && (
            <View id='sec-glossary' className='card'>
              <View className='card-title'>名词解释</View>
              {report.glossary.length === 0 && (
                <Text className='page-report__empty'>
                  本次报告里没有需要额外解释的行话或背景词。
                </Text>
              )}
              {report.glossary.map((g, i) => (
                <View key={`${i}-${g.term}`} className='page-report__entry'>
                  <View className='page-report__entry-head'>
                    <Text className='page-report__entry-label page-report__entry-label--term'>{g.term}</Text>
                    <Text className='page-report__entry-value'>{g.explain}</Text>
                  </View>
                </View>
              ))}
              <Text className='page-report__entry-foot'>只解释报告中出现过的行话与背景词，不涉及对本人事实的判断。</Text>
            </View>
          )}

          {/* 溯源摘要：原先「信息来源」逐条列标题 + 复制链接，与每条动态下的「来源 + 域名徽章」完全重复，
              所以不删、只压成一行；可溯源是报告的核心卖点，完整链接仍可从各条动态的标题点开（见 openSourceLink）。 */}
          {traceText !== '' && <View className='page-report__trace text-tertiary'>{traceText}</View>}

          {/* 对比入口（M4-7）：读完 A 的报告后「A 和别人比怎么样」是这里最自然的下一步，
              所以主视角固定是当前这份。做成整行描边条而不是第三个胶囊按钮 ——
              它是一次跳转（开一条新的阅读动线），与「收藏 / 刷新」这类就地生效的动作并列，
              会让用户期待点完当场有反馈（见 pages/compare）。 */}
          <View
            className='page-report__compare'
            hoverClass='page-report__compare--tap'
            onClick={() => Taro.navigateTo({ url: `/pages/compare/index?personKey=${encodeURIComponent(personKey)}` })}
          >
            <Text className='page-report__compare-text'>与另一位名人对比</Text>
            <Text className='page-report__compare-arrow'>→</Text>
          </View>

          {/* 相关名人（O-16）：把「共同高频话题」当作继续读下去的理由，比再摆一份随机推荐更可能命中。
              交集为空时整卡不渲染 —— 宁可没有这一块，也不摆一段「暂无相关名人」。 */}
          {related.length > 0 && (
            <View className='page-report__related'>
              <Text className='page-report__related-head'>也在聊这些话题的名人</Text>
              <Text className='page-report__related-note'>
                依据你收藏过的报告与本报告的共同高频话题自动聚合，仅供延伸阅读
              </Text>
              {related.map((r) => (
                <View
                  key={r.personKey}
                  className='page-report__related-item'
                  hoverClass='page-report__related-item--tap'
                  onClick={() => Taro.navigateTo({ url: reportSharePath(r.personKey) })}
                >
                  <View className={`page-report__related-avatar page-report__related-avatar--${r.domain}`}>
                    {r.name.slice(0, 1)}
                  </View>
                  <View className='page-report__related-main'>
                    <Text className='page-report__related-name'>{r.name}</Text>
                    <Text className='page-report__related-words'>{`共同话题：${r.shared.join(' / ')}`}</Text>
                  </View>
                  <Text className='page-report__related-arrow'>→</Text>
                </View>
              ))}
            </View>
          )}

          {/* 底部动作一行两个：收藏报告是「读完之后留一份」，刷新最新是「要新版本」。
              分享由右上角原生分享承担；单条名言出图的入口只在收藏页（「名言卡」），
              报告页里不重复摆第二个出口。 */}
          <View className='page-report__foot-actions'>
            <AtButton type='secondary' circle onClick={() => void toggleReportFav()}>
              {reportFaved ? '已收藏' : '收藏报告'}
            </AtButton>
            <AtButton type='primary' circle loading={state.phase === 'loading'} onClick={() => void load(true)}>
              刷新最新
            </AtButton>
          </View>

          {/* AI 生成内容免责声明：合规要求必须出现在页面上，不能只藏在可复制的文本里 */}
          <Text className='disclaimer'>{report.disclaimer}</Text>
        </View>
      )}

    </View>
  )
}
