import { useCallback, useEffect, useRef, useState } from 'react'
import Taro, { useDidShow, useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtButton } from 'taro-ui'
import { DOMAIN_META, DomainCode } from '@/config/domains'
import { FOCUS_META, FocusCode, isFocusCode } from '@/config/filters'
import EmptyState from '@/components/empty-state'
import QuoteDetail from '@/components/quote-detail'
import ReportLoading from '@/components/report-loading'
import { getOrBuildReport, getCachedReports, ReportOutcome } from '@/utils/cache'
import { hasSearchChannel } from '@/utils/search'
import { hasLlmChannel } from '@/utils/llm'
import { Report } from '@/utils/report'
import { extractKeywords } from '@/utils/keywords'
import { buildComparison } from '@/utils/compare'
import { buildHeatTrend, TrendPoint } from '@/utils/trend'
import {
  favoriteQuote,
  favoriteReport,
  listFavorites,
  makeFavoriteId,
  removeFavorite
} from '@/utils/favorites'
import { isFollowed, toggleFollow } from '@/utils/follows'
import { addHistory } from '@/utils/history'
import {
  dismissPromo,
  isPromoDismissed,
  presentSections,
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
  /** 上一版报告：仅当用户点「刷新最新」且真的重新生成了才有值 */
  const [prevReport, setPrevReport] = useState<Report | null>(null)
  /** 相关名人（O-16）：报告就绪后异步算，算不出来就是空数组（整卡不渲染） */
  const [related, setRelated] = useState<RelatedPerson[]>([])
  /**
   * 会员态（O-11）：报告是全局共享缓存，会员生成过的那一份带着 memberNotes，
   * 免费用户读到同一份缓存时必须把这两段藏起来 —— 不能只看「报告里有没有这个字段」。
   * 初值 false（非会员）：宁可先藏后现，也不让会员权益先漏出去再收回。
   */
  const [member, setMember] = useState(false)
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
      const outcome: ReportOutcome = await getOrBuildReport(personKey, { force, focus })
      switch (outcome.kind) {
        case 'report':
          setState({ phase: 'ready', report: outcome.report, fromCache: outcome.fromCache })
          setPrevReport(outcome.prev ?? null)
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
  })

  /** 关注 / 取关。报告页此前没有关注入口，看完报告想关注必须退回名人主页，动线是断的。 */
  const onToggleFollow = async () => {
    const next = await toggleFollow(personKey, 'report')
    /* null = 失败或未登录：follows.ts 已给出原因 toast，不更新按钮态 */
    if (next === null) return
    setFollowed(next)
    Taro.showToast({ title: next ? '已关注' : '已取消关注', icon: 'none' })
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
   * 判定在 utils/member.ts#reportMemberPromo —— 页面只把「这份报告里实际有哪些专享段落」喂进去。
   * 会员态整条不渲染（见下方渲染条件），故这里不再需要「是不是会员」这个入参。
   * memberReady 仍要等：免费态文案写着「开通会员」，会员提前读到它就是被推销。
   */
  const promo = reportMemberPromo(presentSections(report))

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
    setPromoOn(!isPromoDismissed() && promoRoll(presentSections(report)))
  }, [report, member, memberReady])

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

      {report && (
        <View className='page-report__banner'>
          {/* 人物头像：平台没有名人真实头像素材（LLM 也不产图），全项目统一用
              「领域色渐变 + 姓名首字」占位，这里与 person-card / 主页保持一致。
              白色描边是为了在紫色横幅上把头像和背景分开。 */}
          <View className={`page-report__avatar page-report__avatar--${domain}`}>
            {report.name.slice(0, 1)}
          </View>
          <View className='page-report__banner-left'>
            {/* 名字行 = 名字 + 领域 + 生成时间。时间原先独占一行（「生成于 3 小时前 · 查看最新」），
                把左栏顶成三行；并进这一行后，左栏高度只由「名字行 + 一行状态 + 关注按钮」决定。
                本行不换行且 overflow:hidden：名字过长时由名字出省略号让位 —— 时间被裁成
                「2 小…」没有任何意义，名字省略到「雷…」同样没有意义，但两者必须选一个，
                故时间用最短的相对写法（「刚刚生成」/「2 小时前」），让位基本不会触发。 */}
            <View className='page-report__name-row'>
              <Text className='page-report__name'>{report.name}</Text>
              <View className='page-report__banner-chip'>{DOMAIN_META[domain]?.label ?? '其他'}</View>
              <Text className='page-report__time'>
                {showFresh ? '刚刚生成' : fromNow(report.generatedAt)}
              </Text>
            </View>
            {/* 状态行：刚生成 → 这一版引用了多少实时素材（报告自证）；已有更新版本 → 刷新入口。
                「查看最新」只在确实存在更新版本的可能时才是入口：刚生成完的那一版本身最新，
                再留个热区只会让手滑白白烧掉一次生成配额（底部还有「刷新最新」按钮兜底）。 */}
            <View className='page-report__meta' onClick={showFresh ? undefined : () => void load(true)}>
              {showFresh ? (
                <Text className='page-report__fresh'>{sourceNote}</Text>
              ) : (
                <Text className='page-report__refresh'>
                  {/* 把年龄写在刷新入口前面：一个孤零零的「查看最新」不构成点击理由，
                      而「33 天前生成」会让用户自己得出「该刷一下」的结论（O-14）。 */}
                  {staleReport && (
                    <Text className='page-report__stale'>{`${ageDays} 天前生成 · 建议刷新 `}</Text>
                  )}
                  <Text className='page-report__refresh-link'>查看最新</Text>
                </Text>
              )}
            </View>
            {/* 关注入口：此前报告页无处关注，看完报告想关注必须先退回名人主页 */}
            <View
              className={`page-report__follow ${followed ? 'page-report__follow--on' : ''}`}
              onClick={() => void onToggleFollow()}
            >
              {followed ? '已关注' : '+ 关注'}
            </View>
          </View>
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
        <EmptyState icon='🚫' title='暂不支持查询该人物' desc='本工具仅覆盖科技、商业、文娱、体育、学术领域公众名人' />
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
            人物速览：把博查返回的素材聚合成「本人近来的公开信息覆盖」，全部字段原样统计、
            不经模型改写，因此可以当作事实读。三行分别回答三个此前没人回答的问题：
            热度怎么来的（近 30 天 / 近 7 天报道量）、最近一次公开动态是什么时候、
            这份报告的素材覆盖了哪段时间。原先这个位置放的是「同领域名人」——
            读一份关于 A 的报告，却被推荐 B、C、D，与「我在看谁」是脱节的。
          */}
          {(cov || coverageSpan !== '') && (
            <View className='card'>
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

          {report.intro && (
            <View className='card'>
              <View className='card-title'>简介</View>
              <View className='page-report__text'>{report.intro}</View>
            </View>
          )}

          {dynamicsView.length > 0 && (
            <View className='card'>
              <View className='card-title'>近期动态（{dynamicsView.length}）</View>
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

          {report.quotes.length > 0 && (
            <View className='card'>
              <View className='card-title'>经典名言</View>
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

          {report.analysis && (
            <View className='card'>
              <View className='card-title'>{report.degraded ? 'AI 点评 · 简版' : 'AI 点评'}</View>
              {/*
                点评拆条（本轮升级）：新报告是 3~4 条「判断 + 依据」，老缓存（与降级简版）
                只有一整段 analysis —— 两条路共用这张卡，有拆条就渲染列表，否则回落整段。
                「依据」必须是可见的：判断与出处分开摆，用户才能自己判断这条可不可信，
                这也是拆条相对整段的全部意义（看起来像专业分析，而不是像套话）。
              */}
              {report.analysisPoints && report.analysisPoints.length > 0 ? (
                <View className='page-report__points'>
                  {report.analysisPoints.map((p, i) => (
                    <View key={`${i}-${p.basis}`} className='page-report__point'>
                      <Text className='page-report__point-text'>{p.point}</Text>
                      <Text className='page-report__point-basis'>依据：{p.basis}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <View className='page-report__analysis-text'>{report.analysis}</View>
              )}
            </View>
          )}

          {/*
            会员专享：对比视角 + 风险提示 + 信源分歧（O-11 / 本轮）。
            这些段落只在会员生成时被请求（见 utils/report.ts 的 MEMBER_HINT_REALTIME），但它们**不是**
            免费的：报告是全局共享缓存、不按身份切分（否则同一个人会有两份报告，热度与来源
            还不一致），免费用户完全可能读到会员生成的那一份 —— 所以这里必须用会员态再拦一道，
            否则「会员专享」等于对所有人开放。因此条件缺一不可：
              · report.memberNotes / report.conflicts —— 这份缓存里确实有这些段；
              · member —— 读它的人此刻是会员（权益到期即收回）。
            免费用户整卡不出，刻意不做「灰掉 + 开通会员」的诱导样式：
            免费用户看到的每一处留白都得额外解释一遍，报告页已经够长了。
            ⚠ 两个字段要**各自**判空：老会员报告只有 memberNotes，新报告才可能有 conflicts，
              用 memberNotes 的存在与否去决定整卡出不出，会让只带 conflicts 的报告整张消失。
          */}
          {member && (report.memberNotes || report.conflicts) && (
            <View className='card page-report__notes'>
              {/* 标题行兼作「会员权益已生效」的确认位（O-25）：顶部促销条已对会员隐藏，
                  这张卡能出现本身就是确认 —— 再补一个「已生效」小标，比一句推销语诚实，也更省地方。
                  原先这里的 id="report-notes" 是给顶部条的「查看 ›」做页内滚动锚点的，随该分支一并删除。 */}
              <View className='page-report__notes-head'>
                <View className='card-title'>会员专享 · 深度解析</View>
                <Text className='page-report__notes-badge'>已生效</Text>
              </View>
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

          {(sentimentStats || stances.length > 0) && (
            <View className='card'>
              <View className='card-title'>立场与舆情</View>
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

          {/* 关键词云 + 高频观点（M4-5）：纯端上统计（口径见 utils/keywords.ts），不消耗生成额度。
              少于 4 个词就整卡不出 —— 素材本来就少的报告，词云只会是一堆零散碎片。 */}
          {keywords.length >= 4 && (
            <View className='card'>
              <View className='card-title'>关键词云</View>
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
                {`按收录的 ${report.dynamics.length} 条动态与 ${report.quotes.length} 条语录统计，字号代表提及它的素材条数；中文无词典，仅作主题速览。点任一词语可看它在别的报告里怎么说。`}
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
            </View>
          )}

          {/* 热度趋势（M4-6）：把报告里带日期的动态与时间线事件摊成近 30 天折线。
              点和线都是普通 View（几何在 trendGeometry 里算成 rpx），与词云、情绪条同一条
              「不引图表库」的路线；纵轴是条数、横轴是时间，脚注交代口径，免得被读成全网报道量。 */}
          {trend && trendGeo && (
            <View className='card'>
              <View className='card-title'>热度趋势</View>
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
                {`按本报告收录的带日期条目聚合：近 30 天共 ${trend.total} 条动态与事件、覆盖 ${trend.spanDays} 天，纵轴为条数（单格峰值 ${trend.peak}）。反映公开信息节奏，不等于全网报道量。`}
              </Text>
            </View>
          )}

          {timelineView.length > 0 && (
            <View className='card'>
              <View className='card-title'>时间线</View>
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
          <View className='page-report__actions'>
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
