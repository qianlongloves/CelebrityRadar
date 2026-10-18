import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Taro, { useDidShow, useRouter, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
/* 本页不再引 taro-ui 组件（2026-10-16）：页脚那两个 AtButton 随工具卡上移后已换成普通 View，
   `import AtButton from 'taro-ui/dist/components/button'` 与相应的按需引入说明一并删掉 ——
   留着就是一份「看着在用、其实摇不掉也占预算」的死引入（A-9）。 */
import { buildPersonKey, DOMAIN_COVERAGE_TEXT, domainLabel, domainStyleCode, parsePersonKey } from '@/config/domains'
import { FOCUS_META, FocusCode, isFocusCode } from '@/config/filters'
import EmptyState from '@/components/empty-state'
import NoticeClose from '@/components/notice-close'
import QuoteDetail from '@/components/quote-detail'
import PersonAvatar from '@/components/person-avatar'
import ReportLoading, { ReportRefreshing } from '@/components/report-loading'
import SharePoster from '@/components/share-poster'
import {
  getOrBuildReport,
  getCachedReports,
  isFreeRefreshCooling,
  refreshFailureNote,
  ReportOutcome,
  ReportProgress,
  BUILDING_TIMEOUT_MS
} from '@/utils/cache'
import { peekGenerateQuota } from '@/utils/quota'
import type { GenerateQuotaSummary } from '@/utils/quota'
import { hasSearchChannel } from '@/utils/search'
import { hasLlmChannel } from '@/utils/llm'
import { Report, backgroundGaps, reportGist } from '@/utils/report'
import { buildComparison } from '@/utils/compare'
import { buildRiskSignals, riskHeadline, riskScope, RISK_CATEGORIES, RISK_CATEGORY_LABEL, RISK_FROM_LABEL } from '@/utils/risk'
import {
  TEMPLATE_SIZE,
  REPORT_TEMPLATE,
  buildReportToc,
  buildReportTocGroups,
  lockedReportToc,
  previewRows,
  previewHiddenNote
} from '@/utils/report-toc'
import { buildCommercialSummary, MIN_AXES } from '@/utils/commercial'
import {
  favoriteQuote,
  favoriteReport,
  listFavorites,
  makeFavoriteId,
  removeFavorite
} from '@/utils/favorites'
import { isFollowed, listFollows, toggleFollow } from '@/utils/follows'
import { loadHotBoard } from '@/utils/hot-board'
import { isMonitored, monitorPerson, unmonitorPerson } from '@/utils/risk-watch'
import {
  addWatch,
  listWatches,
  normalizeKeyword,
  removeWatch,
  splitWatches,
  validateKeyword
} from '@/utils/keyword-alert'
import { alertNotifyConfigured, requestAlertNotify } from '@/utils/notify'
import { track } from '@/utils/events'
import { openMemberPage } from '@/utils/member-entry'
import type { MemberEntryFrom } from '@/utils/member-entry'
import { addHistory, markReportViewed } from '@/utils/history'
import { decodeParam } from '@/utils/route'
import { ensurePortrait, readPortraits } from '@/utils/portrait'
import {
  dismissPromo,
  isPromoDismissed,
  MEMBER_SECTIONS,
  presentSections,
  promoRoll,
  readMemberState,
  reportMemberPromo
} from '@/utils/member'
import { isWatchShare, personShare, reportSharePath } from '@/utils/share'
import {
  buildReportCard,
  canExportReportCard,
  reportExportNote,
  ReportCardModel
} from '@/utils/report-card'
import {
  buildReportExport,
  canExportReport,
  EXPORT_FORMATS,
  exportFileName,
  reportDataExportNote,
  ExportKind,
  ReportExport
} from '@/utils/report-export'
import { renderReportPoster, reportCardHeight } from '@/utils/share-card'
import { openSourceLink } from '@/utils/source-link'
import { toUserMessage } from '@/utils/error'
import { useAuth } from '@/stores/auth'
import { fromNow, formatDay, isStaleReport, reportAgeDays, reportVersion, stampAgo } from '@/utils/time'
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

/**
 * waiting 态（他人正在生成）的轮询参数（P2-19，2026-10-09；2026-10-11 改引真源）。
 * 上限直接取 utils/cache.ts#BUILDING_TIMEOUT_MS（构建耗时上界，按分批数量推导）—— 两者必须是
 * 同一个数：原先这里与云端锁各硬编码一个 90s，分批改造后两边会各自漂移，而漂移的两种后果
 * （页面先于锁放弃、页面比锁等更久）都表现为「等待页永远转不完」。
 * 超过它还没好，说明那次生成大概率已经失败，再转下去只是耗用户的耐心。
 */
const WAIT_POLL_MS = 5_000
const WAIT_POLL_MAX_MS = BUILDING_TIMEOUT_MS

const SENTIMENT_META: Record<string, { label: string; cls: string }> = {
  positive: { label: '积极', cls: 'positive' },
  neutral: { label: '中性', cls: 'neutral' },
  negative: { label: '消极', cls: 'negative' }
}

/**
 * 情绪条的最小样本量：低于它时那句「基于 N 条动态」必须把话说全（见卡片的 __stance-note）。
 *
 * 比例条是按条数铺开的，**1 条动态就能画出「100% 积极」的满格条**。统计口径本身没错
 * （纯本地计数、不掺模型判断），错的是版面：满格条看起来像结论，而它的样本是 1。
 * 故不足 3 条时不改图、只把口径说清 —— 渲染层不替用户改数据，只交代它有多可信。
 */
const SENTIMENT_MIN_SAMPLE = 3

/**
 * 「近期动态」里那张「报道时间分布」柱状图的最小样本量：低于它整图不渲染。
 *
 * 1~2 根柱子读不出「分布」，画出来只是两三条孤零零的柱子 —— 反倒像页面缺了一块；
 * 不足 3 条有日期的动态时，这张卡保持原样（只有列表），不做半张图。
 */
const DYN_CHART_MIN_SAMPLE = 3

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
 * 人物关系的类别标签（第二批）。枚举在 utils/report.ts 的 RelationKindEnum 里归一 ——
 * 认不出的值在那里就被折成 other，故这里兜底也写「其他」，两边口径一致。
 * 四档标签一律用同一套中性样式（不因「对手」染红）：报告只陈述关系，关系本身没有褒贬。
 */
const RELATION_META: Record<string, string> = {
  cooperate: '合作',
  mentor: '师承',
  rival: '对手',
  other: '其他'
}

/**
 * 企业关联的类别标签（2026-10-12，会员专享）。枚举在 utils/report.ts 的 sanitize 里归一
 * （normAffiliationKind）—— 认不出的值在那里折成 other，故这里兜底也写「其他」。
 * 四档一律中性样式：报告只陈列素材里写到的机构关联，不对关联本身作评价。
 */
const AFFILIATION_META: Record<string, string> = {
  company: '关联企业',
  partner: '合作方',
  equity: '参股',
  other: '其他'
}

/**
 * 商业合作与代言的类别标签（2026-10-12，取代原「后续关注」）。枚举在 utils/report.ts 的
 * sanitize 里归一（normEndorseKind）—— 认不出的值在那里折成 other，故这里兜底也写「其他」。
 * 四档一律中性样式：报告只陈列素材里写到的商业关系，不对合作本身作评价。
 */
const ENDORSE_META: Record<string, string> = {
  endorse: '品牌代言',
  collab: '联名 / 合作',
  title: '商业头衔',
  other: '其他'
}

/* ===== 热度趋势折线（M4-6）：绘图区几何 ===== */

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

/**
 * 分批生成失败的组名 → 中文（与 report-toc.ts#TOC_GROUPS 的 label 一致）。
 * 报告分 4 批生成，某一批连续几次失败时那一组段落整块缺失（见 utils/report.ts#Report.missingGroups），
 * 提示条用它把「缺的是哪几组」说成人话，而不是甩一串 identity / facts 给用户。
 */
const MISSING_GROUP_LABELS: Record<string, string> = {
  identity: '基本档案',
  facts: '事实（动态/语录）',
  judgement: '判断与风险（点评/争议）',
  detail: '细节与延伸（时间线）'
}

interface RelatedPerson {
  personKey: string
  name: string
  /** 领域（自由短串，2026-10-12 领域自由化） */
  domain: string
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
      domain: f.person_key.split('#')[1] || 'other',
      shared: common.slice(0, 3).map((c) => c.word),
      total: common.length
    })
  })

  return scored.sort((a, b) => b.total - a.total).slice(0, RELATED_MAX)
}

/* ===== 同类名人（S1-2）===== */

/** 展示上限：与相关名人一样取 3 —— 页尾这块只回答「下一本读谁」，多于 3 位就成了新的一屏 */
const PEER_MAX = 3

interface PeerPerson {
  personKey: string
  name: string
  domain: string
  /** 领域标签（榜单条目自带，缺省是领域名） */
  tag: string
  /** 一句动态速览（榜单条目自带，可能为空串） */
  trend: string
  followed: boolean
}

/**
 * 「同类名人」= 与本报告**同领域**的其他名人（S1-2，2026-10-16）。
 *
 * 为什么要有它：上面的「相关名人」用的是**共同话题**，精准但条件苛刻 —— 交集为空就整块不渲染，
 * 而没收藏过报告的人连候选都没有（`picked.length === 0` 直接返回）。新用户读完报告，
 * 页尾因此什么都没有，动线到此为止。这一块改用**领域**兜底：只要有榜单就一定有内容。
 *
 * 不新造链路：复用首页那套现成的热门榜（`utils/hot-board.ts`，AI 每日榜 → 真实热度 →
 * 静态种子三级兜底、带 5 分钟内存缓存、**永不 reject**）。排序也沿用榜单顺序（数组顺序即排名），
 * 端上不重排 —— 榜单是「当下谁在被关注」的唯一真源。
 *
 * 领域只做**相等**判断、不做任何映射：领域自 2026-10-12 起是自由短串，映射表一改，
 * 这里就会悄悄换成另一批人，而且不报任何错。
 */
async function loadPeers(self: Report, exclude: Set<string>): Promise<PeerPerson[]> {
  const parsed = parsePersonKey(self.personKey)
  const domain = parsed ? parsed.domain : ''
  /* 'other' 是「领域没填上」的兜底桶（见 loadRelated 里 split 的默认值）：
     那一桶里的人彼此没有关系，凑在一起就是随机推荐，不如不推荐 */
  if (domain === '' || domain === 'other') return []

  const board = await loadHotBoard()
  const picked = board
    .filter((p) => p.domain === domain && !exclude.has(buildPersonKey(p.name, p.domain)))
    .slice(0, PEER_MAX)
  if (picked.length === 0) return []

  /* 关注态一次读全表（与预警页同款做法）：3 个人各查一次 isFollowed 就是三次往返 */
  const follows = await listFollows()
  const followedKeys = new Set(follows.map((f) => f.person_key))
  return picked.map((p) => {
    const personKey = buildPersonKey(p.name, p.domain)
    return {
      personKey,
      name: p.name,
      domain: p.domain,
      tag: p.tag,
      trend: p.trend,
      followed: followedKeys.has(personKey)
    }
  })
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

/**
 * 卡内小表格（2026-10-12）：小程序没有 <table>，用 flex 行拼一张「迷你表」。
 *
 * 三层排版沿用本页事实卡既有语言（主行 → 说明 → 依据），只把「主行」拆成若干**成列**的单元格：
 * 表头一行列名（小、灰），下面每条一行；出处（basis）单独铺满一整行压在单元格下方 ——
 * 出处往往是一整句媒体来源，塞进窄列会折成两三行、把列对齐撑散，铺满一行后它读起来
 * 就像这条数据的脚注（与 __entry-basis 同一位置）。
 *
 * 列宽：短列用固定 flex-basis 保成列（不定宽则右侧值凑不成一列），**最后一列**吃满剩余宽度
 * 并允许长文本折行 —— 卡片内任何一格都不得溢出（SCSS 里统一 word-break）。
 */
function SectionTable({
  columns,
  rows
}: {
  columns: string[]
  rows: Array<{ cells: ReactNode[]; basis?: string }>
}) {
  return (
    <View className='page-report__table'>
      <View className='page-report__table-head'>
        {columns.map((col, i) => (
          <View
            key={i}
            className={`page-report__table-cell page-report__table-cell--head${
              i === columns.length - 1 ? ' page-report__table-cell--grow' : ''
            }`}
          >
            {col}
          </View>
        ))}
      </View>
      {rows.map((row, ri) => (
        <View key={ri} className='page-report__table-row'>
          <View className='page-report__table-cells'>
            {row.cells.map((cell, ci) => (
              <View
                key={ci}
                className={`page-report__table-cell${
                  ci === row.cells.length - 1 ? ' page-report__table-cell--grow' : ''
                }`}
              >
                {cell}
              </View>
            ))}
          </View>
          {!!row.basis && <View className='page-report__table-basis'>依据：{row.basis}</View>}
        </View>
      ))}
    </View>
  )
}

/**
 * S3-3 锁态卡：免费档把**会员节原本该在的位置**占住（就地，插在正文流里）。
 *
 * 与目录底部那行「完整模板 18 节 · 会员另含 7 节」是两种补法，缺一不可：
 * 那行要展开目录才看得到（多数人不点），而免费用户滑到正文这里只会觉得「报告到底了」。
 * 锁态卡把「这里还有一节」放在它本来该在的位置 —— 这是免费 / 会员观感差异的主要来源。
 *
 * 口径：
 *   · 节名与说明**都取自** `utils/report-toc.ts` 的模板真源（`label` / `lockedNote`），
 *     页面不另抄 —— 否则模板改了节名，锁态卡还印着旧词；
 *   · **不渲染任何内容片段**：免费用户读到的是锁，不是半份内容（`lockedNote` 只写
 *     「这一节讲什么」，不写条数、不写这人的任何具体信息）；
 *   · 出现条件由调用方用 `lockedIds`（=`lockedReportToc` 的 id 集合）判断，
 *     与目录那行永远同一份条件；会员根本不进这张卡。
 */
function LockedCard({ id, onOpen }: { id: string; onOpen: () => void }) {
  const sec = REPORT_TEMPLATE.find((s) => s.id === id)
  if (!sec) return null
  return (
    <View
      id={id}
      className='card page-report__locked'
      hoverClass='page-report__locked--tap'
      onClick={onOpen}
    >
      <View className='page-report__locked-head'>
        <Text className='page-report__locked-tag'>会员</Text>
        <Text className='page-report__locked-label'>{sec.label}</Text>
      </View>
      {!!sec.lockedNote && <Text className='page-report__locked-note'>{sec.lockedNote}</Text>}
      <Text className='page-report__locked-go'>开通会员查看这一节 ›</Text>
    </View>
  )
}

export default function ReportPage() {
  const router = useRouter()
  /**
   * 扫**分享图上的小程序码**进来时，参数走的是 `scene`（小程序码只带得动 32 字符的场景值，
   * 塞不下 personKey 加别的参数），值是 URL 编码后的 personKey（见 utils/share-code.ts）。
   * 两种入口取到的都是同一个人，故与 personKey 合并成一个来源，其余逻辑一行不用改。
   */
  const sceneKey = decodeParam(router.params.scene || '')
  const personKey = decodeParam(router.params.personKey || '') || sceneKey
  /** 发现页「关注」筛选（生成侧重，§2.3 六段可聚焦） */
  const focusParam = router.params.focus || 'all'
  const focus: FocusCode = isFocusCode(focusParam) ? focusParam : 'all'
  /**
   * 发现页「姓名 + 关键词」拆出的补充关键词（如「雷军 小米科技」的后半段，见 utils/query-split.ts）。
   *
   * 与 focus 同路：**只作检索补充，不参与 personKey、不进缓存键** —— 同一个人始终只有一份报告，
   * 关键词只影响「这一次生成时去查什么」（见 utils/cache.ts#getOrBuildReport 的 opts.keyword）。
   * 缺失 / 空串时**与改造前逐字一致**：下方以 `keywordParam || undefined` 传入，等价于「不传该可选形参」，
   * getOrBuildReport 内部即按「没有关键词」走（见 utils/search-plan.ts#applyKeyword 对空值的处理）。
   */
  const keywordParam = decodeParam(router.params.keyword || '')
  /**
   * 「我在盯的人」分享落地标记（S2-1，2026-10-16）。
   *
   * 与 focus / keyword 同路：**只是这一次的读法，不进 personKey、不进缓存键** ——
   * 同一个人全站始终只有一份报告，标记只决定「首屏要不要把关注入口提到最前」。
   * 认不出的一律当普通分享（`isWatchShare` 只认 `'watch'` 一个值）。
   */
  const watchArrival = isWatchShare(decodeParam(router.params.from || ''))
  const [state, setState] = useState<PageState>({ phase: 'loading' })
  /**
   * 「手上已经有一份能读的报告」——供 `load` 判断这次 force 能不能不清屏。
   *
   * 必须用 ref 而不是把 state 塞进 `load` 的依赖：`load` 被下面那个
   * `useEffect(..., [load])` 挂着，依赖一变就会重新拉一次报告（无限循环）。
   * ref 在每次渲染时同步，`load` 内部读到的永远是最新值，且不改变它的身份。
   */
  const hasReportRef = useRef(false)
  /**
   * 「刷新在途」锁（2026-10-10 新增）。
   *
   * 为什么需要：`load(true)` 有**两个**入口（顶部侧重条的「重新生成为…」与首屏工具卡的「刷新」），
   * 而 force 路径此前没有任何在途判断 —— 上一次还没回来时再点一次，就是一次真实的生成请求
   * （免费版一天只有 3 次）。用户点第二次的原因恰恰是「第一次没反馈」，所以这把锁与顶部那条
   * 刷新提示是同一件事的两半：**先让他看见在跑，再让重复点击无效**。
   *
   * 只拦 force：首次加载不加锁 —— personKey 变了必须能立刻换人（`load` 的依赖就是它），
   * 若把非 force 也锁住，切人时新请求会被悄悄丢掉，屏上留着的却是上一位的报告。
   *
   * 用 ref 而不是 state：`load` 是 `useCallback([personKey, focus])`，闭包里读到的 state 是旧值。
   */
  const loadingRef = useRef(false)
  /**
   * 正在「非破坏式刷新」：手上已有报告，本次 force 在后台跑（P1-8，2026-10-09）。
   * 与 `state.phase === 'loading'` 分开 —— 前者是「首次加载、屏上什么都没有」，
   * 后者是「内容还在，只是在下一次」。
   */
  const [refreshing, setRefreshing] = useState(false)
  /** 非破坏式刷新失败的说明；成功后立刻清空（见 refreshFailureNote） */
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [reportFaved, setReportFaved] = useState(false)
  /**
   * 折叠态（细节与延伸组，2026-10-10）：「名词解释」是按需内容、不占一屏，
   * 默认收起，点标题行展开。与「刷新结果条」的关闭记忆不同 —— 那是「这次不看」，这是
   * 「先收着、想看再点」；展开态只活在本次会话、不落库（报告是共享缓存，不该携带阅读姿势）。
   */
  const [detailOpen, setDetailOpen] = useState<{ glossary: boolean }>({
    glossary: false
  })
  /** 已收藏的内容 id（名言 / 动态 / 履历节点三类共用；整份报告单独用 reportFaved） */
  const [favedIds, setFavedIds] = useState<Set<string>>(new Set())
  const [followed, setFollowed] = useState(false)
  /**
   * 关注态是否**已经读过一次**（S2-1）。
   *
   * 初值是 `false`（没关注），所以「好友分享落地条」不能直接判 `!followed` ——
   * 已经关注了 TA 的人点开自己分享出去的链接，会先看到一秒钟「朋友在盯 TA，点这里关注」，
   * 然后才被读库结果纠正。这条浮层本来就是要抢第一眼的，闪一下反而最刺眼。
   * 故落地条等这一次读完再渲染（读取失败 / 未登录也照样算读过：那不阻塞引导）。
   */
  const [followRead, setFollowRead] = useState(false)
  /** 是否在「监控此人」（风险信号订阅，见 utils/risk-watch.ts）；与关注相互独立 */
  const [monitored, setMonitored] = useState(false)
  /** 监控按钮提交中：防止连点写出两行（后一个会撞主键） */
  const [monitorBusy, setMonitorBusy] = useState(false)
  /**
   * 已在监测的**词**（S1-1，2026-10-16）：驱动「争议与回应」每条旁边的「盯这条进展」按钮态。
   *
   * 存集合而不是一个布尔：「盯进展」是**逐条**的（一份报告可能有三四条争议，各自独立），
   * 且它与「监控此人」是两套独立额度、同住 keyword_watches 表（靠 type 区分，见 utils/keyword-alert.ts）。
   */
  const [watchedKeywords, setWatchedKeywords] = useState<Set<string>>(new Set())
  /** 正在提交的那一条（存词，不存布尔）：只把被点的那条置忙，其余条目照常可点 */
  const [watchBusy, setWatchBusy] = useState<string | null>(null)
  /** 同类名人（S1-2）：仅在「相关名人」为空时才有值（见下方 effect 里的取舍） */
  const [peers, setPeers] = useState<PeerPerson[]>([])
  /** 正在提交关注的那位（存 personKey）：只把被点的那位置忙，其余照常可点 */
  const [peerBusy, setPeerBusy] = useState<string | null>(null)
  /** 上一版报告：仅当用户点「刷新最新」且真的重新生成了才有值 */
  const [prevReport, setPrevReport] = useState<Report | null>(null)
  /**
   * 本次刷新被「只升不降」拦下（P0，2026-10-09）：缓存里那版含会员段落，本次较简略的
   * 产物没有覆盖它（见 utils/cache.ts#shouldKeepMemberVersion）。必须给一句解释 ——
   * 用户点了「刷新最新」却看不出任何变化，最容易理解成按钮坏了。
   */
  const [keptMember, setKeptMember] = useState(false)
  /**
   * 这次带了补充关键词，但读的是**已有报告**，关键词没参与生成（P6，2026-10-17）。
   *
   * 关键词不是缓存键的一部分（同一个人只有一份报告），所以只要命中缓存它就没生效 ——
   * 此前页面一声不吭，用户会把它读成「这个人和关键词没关系」，而事实是「这次没按关键词查」。
   * 值是关键词原文（判据见 utils/cache.ts#ReportOutcome.keywordUnused），只用于这句说明。
   */
  const [keywordUnused, setKeywordUnused] = useState<string | null>(null)
  /**
   * 本次产物没达到最低交付要求（2026-10-10，判定见 utils/report.ts#reportShortfall）。
   *
   * 与 keptMember / refreshError 共用同一个提示位（同一套外观、同一个位置）—— 三者都是
   * 「点了刷新，结果和预期不一样」；但这条的火候完全不同：它必须先说清**「这次没有消耗你的生成次数」**，
   * 否则用户看着一份残缺的报告，只能自己猜是不是白花了一次额度。
   * 注意「共用提示位」只指外观：关闭开关必须各记各的（见 closedNotices 注释）。
   */
  const [shortfall, setShortfall] = useState<string | null>(null)
  /**
   * 上面这条不达标「重试有没有意义」（P2，2026-10-10，判据见 utils/report.ts#shortfallVerdict）。
   *
   * 不达标的原因分两类，文案必须分开：上游抖动（重试通常就好）/ 素材本身就不够
   * （长尾人物近期报道少，重试还是同一批素材）。一律劝重试，用户就会一直点、一直不达标，
   * 白等一场还把「素材少」误解成「服务坏了」—— 与 bgGaps 那条是同一个坑。
   */
  const [shortfallRetryable, setShortfallRetryable] = useState(false)
  /**
   * 本次生成是「为全站首建这个人物」（2026-10-15，判据见 utils/cache.ts#isFirstBuild）。
   * 只驱动下面那条说明（为什么要说这句，见渲染处的注释）—— 不是任何判定的输入。
   */
  const [firstBuild, setFirstBuild] = useState(false)
  /**
   * 本次首建的人物还是**冷门**（公开报道很少的长尾人物，S2-3，2026-10-16）。
   * 判据在 utils/report.ts#isColdPerson（写在缓存层而不是这一页：交给页面的必须是
   * **与埋点同一个判定**的结果，否则「埋点说冷门、页面说不是」这类分歧没人能发现）。
   */
  const [coldFirstBuild, setColdFirstBuild] = useState(false)

  /**
   * 本页可关闭的提示条条目名。
   *
   * 用联合类型而不是裸字符串：key 打错一个字母，✕ 就把「已关」记到了别人头上，
   * 而眼前这条永远关不掉 —— 这种错编译期必须拦下来。
   */
  type NoticeKey =
    | 'error'
    | 'diff'
    | 'keptMember'
    | 'keywordUnused'
    | 'shortfall'
    | 'firstBuild'
    | 'degraded'
    | 'bgGaps'
    | 'missingGroups'
  /*
   * 提示条的「已关闭」记忆（2026-10-10，需求：「所有文字提示的框都要有关闭按钮」）。
   *
   * 一律只记在本机内存里、不落库 —— 提示条说的是「这一份报告 / 这一次操作」的当下状态，
   * 关掉只代表「这次我不看」，换一份报告、或下一次刷新都应重新出现（见各 set* 的复位处）。
   *
   * 2026-10-10 二改（用户反馈「多个提示框点一个全关了」）：刷新结果条此前四条**共用一个布尔**，
   * 点其中任意一条的 ✕，四条一起消失。可它们讲的是完全不同的四件事 —— 这次为什么没刷成 /
   * 刷出了什么变化 / 为什么留着旧版 / 这次扣不扣次数 —— 用户常常只想关掉已经看懂的那一条。
   * 现在按条目分记：**一个 key 一条提示，点哪个关哪个**。
   *   · closedNotices 刷新结果条 + 降级警示条（error / diff / keptMember / shortfall / firstBuild / degraded）：
   *     每次 load 整体复位 —— 新一轮的结果必须能被看到，不能被上一轮的「已关」吞掉；
   *   · focusClosed 侧重条仍单独一个布尔，且**不随 load 复位**：它来自路由参数、不是这一次刷新的
   *     结果，每次回到页面又弹一遍（用户得反复关同一条）比「点一个关一个」更烦人。
   */
  const [focusClosed, setFocusClosed] = useState(false)
  const [closedNotices, setClosedNotices] = useState<Partial<Record<NoticeKey, boolean>>>({})
  /** 关掉一条提示：只动它自己那一格，绝不牵连其余（见 closedNotices 注释） */
  const closeNotice = useCallback((key: NoticeKey) => setClosedNotices((m) => ({ ...m, [key]: true })), [])
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
  /**
   * 报告长图面板（获客 P0，2026-10-15）：**打开时才组装模型并出图**。
   *
   * 存的是已组装好的内容模型（`utils/report-card.ts#buildReportCard` 的产物）而不是
   * `report` 本身：组装那一步会做敏感名单拦截与截断，null 就不再往下走（见 onExportCard），
   * 面板拿到的永远是一份「可以出图」的内容。
   */
  const [posterCard, setPosterCard] = useState<ReportCardModel | null>(null)
  /**
   * 免费用户点过导出：页面上多一行升级引导（不弹窗，不打断阅读）。
   *
   * ⚠ 记的是**哪一个**出口被点了（'card' 长图 / 'data' 结构化数据），不是布尔：
   * 两个出口带走的东西不同（一张图 vs 一份可核对的数据），引导语也必须不同（S3-1）。
   * 用同一句话会让用户以为点哪个都一样。
   */
  const [exportGuide, setExportGuide] = useState<'' | 'card' | 'data'>('')
  /**
   * 本机生成的真实进度（2026-10-11）：由 `getOrBuildReport` 的 onProgress 透传，喂给等待动画。
   *
   * 只在「本机真生成」时有值；命中缓存 / 排队等待始终为 null，等待动画据此回落按秒估算。
   * 每次 load 开头复位 —— 否则上一轮的「已完成 4/4 批」会残留到新一轮（看着像已经生成完了）。
   */
  const [progress, setProgress] = useState<ReportProgress | null>(null)

  const name = personKey.split('#')[0] || '名人'
  const domain = personKey.split('#')[1] || 'other'

  const load = useCallback(
    async (force = false) => {
      if (!personKey) {
        setState({ phase: 'error', message: '缺少 personKey 参数' })
        return
      }
      /**
       * 非破坏式刷新（P1-8，2026-10-09）：手上已经有报告时，force **不清屏**。
       * 原先一律 `setState({ phase: 'loading' })` —— 于是「刷新失败」的代价是连正在读的
       * 那份报告一起消失（断网 / 上游抖动一次，就从「有一份能读的」变成「生成失败」空态）。
       * 首次加载（没有旧内容可留）仍走全屏骨架。
       */
      /* 在途锁（只看 force，理由见 loadingRef 的注释）：返回前重复点刷新直接丢弃，不重复请求 */
      if (force && loadingRef.current) return
      if (force) loadingRef.current = true

      const keepCurrent = force && hasReportRef.current
      if (keepCurrent) {
        setRefreshing(true)
        setRefreshError(null)
      } else {
        setState({ phase: 'loading' })
      }
      /* 新一轮复制定位（见 progress 注释）：残留的上一轮进度会让人以为这次已经生成完了 */
      setProgress(null)
      setPrevReport(null)
      setKeptMember(false)
      setKeywordUnused(null)
      setShortfall(null)
      setShortfallRetryable(false)
      setFirstBuild(false)
      setColdFirstBuild(false)
      setMemberLocked([])
      /* 新一轮的刷新结果条要能被看到：把上一轮「已关」的记忆整体清掉（见 closedNotices 注释） */
      setClosedNotices({})
      /*
        这里接住 reject 并折成 `kind: 'error'`：`getOrBuildReport` 内部大量 `await` 读库，
        任何一次读抛错都会让这个 await 直接 reject —— 那样 `refreshing` 与在途锁都不会复位，
        顶部刷新提示会永久停在那儿，页面看着「一直在生成」。折成 error 后走下面已有的分支：
        有旧报告就只挂一条失败说明（P1-8 的原意），没有才落错误空态。
      */
      const outcome: ReportOutcome = await getOrBuildReport(personKey, {
        force,
        focus,
        /* 补充关键词（可选，见 keywordParam 注释）：空串按 undefined 传，即不传该形参 ——
           既不进 personKey、也不进缓存键，缺失 / 为空时行为与改造前完全一致 */
        keyword: keywordParam || undefined,
        /* 真实进度直通等待动画（见 progress 注释）；生成结束后立刻清掉（见下方复位那行） */
        onProgress: setProgress
      }).catch(
        (err): ReportOutcome => ({
          kind: 'error',
          message: toUserMessage(err, '生成失败，请稍后重试')
        })
      )
      /* 先解锁再处理结果：下面 switch 里的 setState 是同步的，不会有等待窗口 */
      loadingRef.current = false
      setRefreshing(false)
      /* 生成已结束：清掉进度（否则错误/空态下等待动画退场前会闪一下「4/4」） */
      setProgress(null)
      /* 纯函数（utils/cache.ts），文案与「成功时不提示」都被单测钉着 */
      const failureNote = refreshFailureNote(outcome)
      switch (outcome.kind) {
        case 'report':
          setState({ phase: 'ready', report: outcome.report, fromCache: outcome.fromCache })
          /* 交回的是失败时的既有版本（refreshFailed）时不算「变化对比」，否则会拿同一份跟自己比 */
          setPrevReport(outcome.refreshFailed ? null : (outcome.prev ?? null))
          setKeptMember(outcome.keptMember === true)
          /* 关键词没生效（P6）：只在「命中了已有报告」时有值，重新生成成功后自然为空 */
          setKeywordUnused(outcome.keywordUnused ?? null)
          setShortfall(outcome.shortfall ?? null)
          setShortfallRetryable(outcome.shortfallRetryable === true)
          setFirstBuild(outcome.firstBuild === true)
          setColdFirstBuild(outcome.coldFirstBuild === true)
          setMemberLocked(outcome.memberLocked ?? [])
          /* 降级警示条若是这版才出的，已由上面 load 开头的整体复位放行（见 closedNotices 注释） */
          setRefreshError(failureNote)
          break
        case 'coldstart':
        case 'nonews':
        case 'refused':
          /*
           * 有旧内容可留时，这三种也不再清屏 —— 它们说的是「这次没拿到新东西」，
           * 不是「这份报告不能看了」。用户点的是「刷新最新」，不是「重新开始」。
           */
          if (keepCurrent && failureNote) {
            setRefreshError(failureNote)
          } else {
            setState({ phase: outcome.kind })
          }
          break
        case 'error':
          if (outcome.message.includes('正在生成')) {
            setState({ phase: 'waiting' })
          } else if (keepCurrent && failureNote) {
            setRefreshError(failureNote)
          } else {
            setState({ phase: 'error', message: outcome.message })
          }
          break
      }
    },
    [personKey, focus, keywordParam]
  )

  /**
   * 浏览历史的写入（「我查过这个人」）。把这次写入的 Promise 留着，见下面那个 effect ——
   * 版本指纹是写进**这一行**的，必须先有行才能改行。
   */
  const historyWriteRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    historyWriteRef.current = addHistory(personKey, name)
    void load(false)
  }, [load])

  /**
   * 「我看到了这一版」（N-2 回访的判据，2026-10-16）。
   *
   * 记的是**当前版的 `generatedAt`**，写进这条浏览记录的 `viewed_generated_at`（见
   * utils/revisit.ts 的文件头：判据为什么不能拿访问时间顶替）。只在实际渲染出正文
   * （`phase === 'ready'`）时写：报告还在生成、生成失败、或用户没等到就退出，都**不算看到**——
   * 那种情况下写入的指纹会把「没看过的东西」记成「看过这一版」，回访理由就成了编的。
   *
   * ⚠ 与 addHistory 的顺序：两者并发发起、谁先落库不确定，而指纹是 `update` 而不是 `insert`
   * （写口只有 addHistory 一个，见 history.ts#markReportViewed）。所以这里**等**那次写入的
   * Promise 再更新 —— 用结构保证「先有行、再改行」，而不是靠延时或重试去赌时序。
   * addHistory 失败时 Promise 照样 resolve，这一步查不到行就自己返回（这次没指纹，
   * 下次再看一次就补上），不会连累页面。
   */
  useEffect(() => {
    if (state.phase !== 'ready') return
    const version = state.report.generatedAt
    void (historyWriteRef.current ?? Promise.resolve()).then(() => markReportViewed(personKey, version))
  }, [state])

  /** 供 `load` 判断「这次 force 能不能不清屏」（见 hasReportRef 的注释） */
  useEffect(() => {
    hasReportRef.current = state.phase === 'ready'
  }, [state.phase])

  /**
   * 他人正在生成时的轮询（P2-19，2026-10-09）。
   *
   * waiting 态的文案承诺「无需刷新，生成完成后会自动展示」，而此前**一行轮询都没有**：
   * 进到这一态页面就静止了，报告生成完也不会自己出现 —— 用户必须自己想到「返回再进来」，
   * 否则这就是一个永远转不完的等待页，那句承诺成了空头。而这一态恰恰是最常见的并发场景：
   * 热榜里点进一位名人，前面的人正在生成同一份报告。
   *
   * 每 5 秒重试一次**普通** load（force=false）：读缓存 / 抢锁等待即可，绝不能借机触发一次
   * 真生成（那是白烧配额）。拿到 ready 会自动切过去，effect 依赖 state.phase 变化后自行清理。
   *
   * 上限取 BUILDING_TIMEOUT_MS（与云端锁同值，见上方常量注释）：超过它还没好，说明那次生成大概率已经失败
   * （持锁者崩了 / 云函数超时），继续转只是耗尽用户的耐心。此时转 error 态并把决定权交回去 ——
   * 不自动 force，免得把用户的配额烧在一次自动重试上。
   */
  useEffect(() => {
    if (state.phase !== 'waiting') return
    const started = Date.now()
    let done = false
    const timer = setInterval(() => {
      if (done) return
      if (Date.now() - started >= WAIT_POLL_MAX_MS) {
        done = true
        setState({
          phase: 'error',
          message: '这份报告还在生成中，等待时间已超过 90 秒。稍后再进来看看，或换一位名人。'
        })
        return
      }
      void load(false)
    }, WAIT_POLL_MS)
    return () => {
      done = true
      clearInterval(timer)
    }
  }, [state.phase, load])

  /**
   * 相关名人（O-16）+ 同类名人（S1-2）：放在报告就绪之后而不是与 load 并发 —— 前者要拿
   * 当前报告的关键词做交集，没有报告就没有比对基准。算不出来（没收藏过报告 / 交集为空 /
   * 读失败）就是空数组，页面因此不会出现一块「加载中的推荐」（这块内容不值得一个骨架屏）。
   */
  useEffect(() => {
    const rep = state.phase === 'ready' ? state.report : null
    if (!rep) {
      setRelated([])
      setPeers([])
      return
    }
    /*
     * 报告就绪即异步补图（backfill）：不管是刚生成的还是读到的老缓存，首次打开都会
     * fire-and-forget 取一次真图；不 await、不阻塞渲染，失败静默（ensurePortrait 自身不抛）。
     */
    void ensurePortrait(rep.personKey, rep.name)
    let alive = true
    void loadRelated(rep).then(async (rows) => {
      if (!alive) return
      setRelated(rows)
      /* 延伸阅读是一组人：一次批量读预热内存缓存，避免每行各打一次云函数 */
      if (rows.length > 0) {
        void readPortraits(rows.map((r) => r.personKey))
        return
      }
      /*
       * 同类名人（S1-2）只在「相关名人」为空时才取，两个理由：
       *   1. 两者回答的是同一个问题（接下来读谁），连着摆两串人只会让用户在两串之间再挑一遍；
       *      共同话题是更强的相似信号，所以它优先，领域只用来兜底；
       *   2. 顺带省掉这次读榜 —— 有收藏的用户根本走不到这一支（`loadHotBoard` 要读
       *      hot_board，缺榜时还会扫一批 report_cache 兜底，不该白读）。
       */
      const fallback = await loadPeers(rep, new Set([rep.personKey]))
      if (!alive) return
      setPeers(fallback)
      if (fallback.length > 0) void readPortraits(fallback.map((p) => p.personKey))
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
    /* 未登录 = 「没有关注关系」这一事实已确定，同样要放行落地条（见 followRead 的注释） */
    if (!personKey || !useAuth.getState().userId) {
      setFollowRead(true)
      return
    }
    void isFollowed(personKey).then(
      (f) => {
        setFollowed(f)
        setFollowRead(true)
      },
      /* 读失败按「没关注」处理并放行：这里只是引导条的一道理性检查，不值得为它挡住用户 */
      () => setFollowRead(true)
    )
    /* 监控态与关注态一起同步：用户可能刚在预警页取消监控（本页实例还在、personKey 没变），
       只在别处读一次会留下一个显示「监控中」的僵尸按钮。
       「盯进展」的词态（S1-1）取同一份数据：两种订阅同住 keyword_watches，读一次拆两用
       （原先调 listPersonWatches()，而它内部本来就是「读全表再拆」—— 两个态就是两次读库）。 */
    void listWatches().then((rows) => {
      const { keywords, persons } = splitWatches(rows)
      setMonitored(isMonitored(persons, personKey))
      setWatchedKeywords(new Set(keywords.map((w) => w.keyword)))
    })
  })

  /**
   * 好友分享落地的埋点（S2-1）：**每个页面实例只报一次**。
   *
   * 为什么用 ref 而不是把它塞进下面某个 effect 的依赖：`personKey` 不变、`watchArrival` 不变，
   * 但本页会在返回 / 刷新时重新渲染很多次，靠依赖数组去重迟早会漏（或反过来永远不重报）。
   * 它要回答的是「这条入口带来了多少人」，一人一次才对得上。
   */
  const arrivalTrackedRef = useRef(false)
  useEffect(() => {
    if (arrivalTrackedRef.current || !watchArrival || !personKey) return
    arrivalTrackedRef.current = true
    track('watch_share_arrive', { personKey })
  }, [watchArrival, personKey])

  /**
   * 关注 / 取关。报告页此前没有关注入口，看完报告想关注必须退回名人主页，动线是断的。
   *
   * `source` 只进埋点（`'report'` = 横幅按钮，`'watch_share'` = 好友分享落地条，S2-1）：
   * 写库口径仍然只有 `toggleFollow` 一份 —— 拆成两个函数才会出现
   * 「一边能取关、另一边报操作失败」这种分裂。
   */
  const onToggleFollow = async (source = 'report') => {
    const next = await toggleFollow(personKey, source)
    /* null = 失败或未登录：follows.ts 已给出原因 toast，不更新按钮态 */
    if (next === null) return
    setFollowed(next)
    Taro.showToast({ title: next ? '已关注' : '已取消关注', icon: 'none' })
  }

  /**
   * 关注页尾推荐的同类名人（S1-2）。与关注本人只差埋点来源，其余全部复用
   * `toggleFollow`：关注态、失败提示、写库口径都只有一份（两处各写一遍，才会出现
   * 一边能取关、另一边报「操作失败」这种分裂）。
   */
  const onTogglePeerFollow = async (p: PeerPerson) => {
    if (peerBusy) return
    setPeerBusy(p.personKey)
    const next = await toggleFollow(p.personKey, 'report_peer')
    setPeerBusy(null)
    if (next === null) return
    setPeers((prev) => prev.map((x) => (x.personKey === p.personKey ? { ...x, followed: next } : x)))
    /* 说清关注之后去哪儿找 TA：关注本身不推送，动态要回「关注动态」页汇总看 */
    Taro.showToast({
      title: next ? `已关注${p.name}，动态可在「关注动态」页查看` : `已取消关注${p.name}`,
      icon: 'none'
    })
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
  /**
   * 「重新生成」前的确认（2026-10-10）。
   *
   * 原先这套入口靠**前端禁用**防手滑：顶部状态行在 showFresh 时撤掉热区、底部按钮同时变灰
   * 「已是最新」，免费档更狠 —— 12 小时内点刷新会被冷却静默拦下、直接交回旧版本。
   * 同一个动作在页面上有三个答案，用户只能学会「怀疑这个按钮」。
   *
   * 现在把门开在明处：按钮永远可点，点下去先把代价讲清楚（消耗 1 次生成次数 + 今日剩余），
   * 由用户自己决定花不花 —— 冷却原本想传达的「内容大概不会变」降级成这里的一句提醒。
   * 真正的防滥用交给云函数日限（quotaGuard 的 ai_calls），不再由前端替用户做决定。
   *
   * 读配额 / 冷却失败都不拦人：这两条信息的价值是「让用户知情」，读不到就少说一句，
   * 不该反过来变成新的「刷不动」理由。
   */
  const confirmRefresh = useCallback(async (): Promise<boolean> => {
    const userId = useAuth.getState().userId
    if (!userId) {
      Taro.showToast({ title: '请先到「我的」页登录', icon: 'none' })
      return false
    }

    let quota: GenerateQuotaSummary | null = null
    try {
      quota = await peekGenerateQuota(userId)
    } catch {
      quota = null
    }

    const current = state.phase === 'ready' ? state.report : null
    const cooling = current && !member ? await isFreeRefreshCooling(current).catch(() => false) : false

    /*
     * 三句话按「用户此刻最想知道什么」排序：先说这份报告还新不新（冷却留下的最后一点价值），
     * 再说这次要花多少（带上剩余次数，「值不值」才可判断），最后兜一句不达标不计数 ——
     * 第三句是 2026-10-10 新给的承诺，也是用户敢按下「开始生成」的底气（见 utils/report.ts#reportShortfall）。
     *
     * ⚠ 第二句带条件：调试开关放开生成额度时（quota.unlimited）**只改写措辞、不改数字** ——
     * 此时「今日剩余 N 次」已不成立（闸门一律放行），但 remaining 本身是真实的。
     * 此前这里无条件念 remaining，而后端的 remaining 在开挂时被固定报成满额，于是本机
     * 已生成多次仍显示「今日剩余 30/30」—— 假数字比少说一句糟得多（见 utils/quota.ts）。
     */
    const content = [
      cooling ? '这份报告刚生成不久，素材时间窗内内容通常不会有实质变化。' : '',
      quota && !quota.unlimited
        ? `将消耗 1 次生成次数（今日剩余 ${quota.remaining}/${quota.limit} 次）。`
        : '将消耗 1 次生成次数。',
      '生成失败或内容不完整时不计数。'
    ]
      .filter(Boolean)
      .join('\n')

    const { confirm } = await Taro.showModal({
      title: '重新生成',
      content,
      confirmText: '开始生成',
      cancelText: '再想想'
    })
    return confirm
  }, [member, state])

  /**
   * 页面上「重新生成」的唯一出口（首屏工具卡的「刷新」；侧重条的「重新生成为…」也走这里）。
   *
   * 2026-10-17 起入口只剩工具卡一处：横幅状态行原来整行可点、行尾还有「查看最新」，
   * 与工具卡的「刷新」是同一个动作的两个入口（用户反馈重复）。收成一处之后，
   * 「同一动作不能说两套话」不再靠两处对齐来保证 —— 因为只剩一套。
   * 但仍保留这个函数：侧重条那条路径与工具卡共用同一套确认弹窗与忙碌态，
   * 两处若各写一份，「消耗几次 / 能不能点」迟早再次分叉。
   */
  const requestRefresh = useCallback(async () => {
    if (refreshing) return
    if (!(await confirmRefresh())) return
    void load(true)
  }, [confirmRefresh, load, refreshing])

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
          const ok = await unmonitorPerson(personKey, 'report')
          if (ok) {
            setMonitored(false)
            Taro.showToast({ title: '已取消监控', icon: 'none' })
          }
        }
      })
      return
    }
    setMonitorBusy(true)
    const res = await monitorPerson(personKey, name, 'report')
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

  /**
   * 「盯这条进展」（S1-1，2026-10-16）。
   *
   * 盯的是**这条争议的后续报道**，与「监控此人」互补，不是它的替代：
   *   · 监控此人 = 每天按人检索一次、命中风险词典（司法 / 税务 / 商业 / 名誉）才写信号，
   *     回答的是「这个人整体有没有出事」；
   *   · 盯这条   = 把争议点当作**监测词**，回答的是「这桩事后来怎么样了」——
   *     后者单靠人名检索会淹在全部报道里，而它恰恰是用户读完争议卡最想知道的那件事。
   *
   * 实现上不新造链路：`addWatch` 写的仍是 keyword_watches 的 `type='keyword'` 行，
   * 与预警页手动加词共用同一份额度（分档见 config/benefits.ts#OPINION_LIMITS）、
   * 同由云函数 keywordAlert 每天 09:20 扫描 —— 用户也能在预警页看到并取消。
   *
   * 只做争议、不做「风险雷达」里的信号：那边每条是**词典命中词**（「诉讼」「解约」），
   * 拿它当检索词太泛，每天扫回一堆同名不同事的内容，是给用户制造噪音而不是信息。
   */
  const onToggleWatchTopic = async (rawTopic: string) => {
    if (watchBusy) return
    /*
     * ⚠ 顺序不能动（微信要求订阅授权出现在点击的同步调用栈里，见 utils/notify.ts）：
     *   1. 同步校验（validateKeyword 不碰网络）；
     *   2. 请求授权 = **点击后的第一个 await**；
     *   3. 之后才是查库 / 写库（addWatch 内部要读一次库做去重）。
     * 把授权放到后面，按钮会直接失效 —— 这是 monitorPerson 已经踩过的同一个坑。
     */
    const topic = normalizeKeyword(rawTopic)
    const check = validateKeyword(topic)
    /*
     * 模型的 topic 偶尔会越界（提示词要求 12 字内，见 utils/report.ts 的字段说明）。
     * 只回一句「关键词不超过 12 个字」用户不知道下一步该干什么，所以这里把出路一起说了：
     * 改用上方的「+ 监控风险」盯这个人 —— 别让一次失败的点击变成死路。
     */
    if (!check.ok) {
      await Taro.showModal({
        title: '这条不能直接盯',
        content: `${check.message}。可以改用上方的「+ 监控风险」盯这个人，他/她的风险情况一样会出现在预警页。`,
        showCancel: false,
        confirmText: '知道了'
      })
      return
    }
    const keyword = check.keyword

    if (watchedKeywords.has(keyword)) {
      /* 取消走二次确认：盯一条就是一份每天的检索成本，误触会让用户以后收不到、却不知道为什么 */
      void Taro.showModal({
        title: '取消盯这条',
        content: `不再关注「${keyword}」的新报道？已收集的内容会从预警页移除。`,
        confirmText: '取消盯',
        cancelText: '再想想',
        success: async (r) => {
          if (!r.confirm) return
          const ok = await removeWatch(keyword)
          if (!ok) return
          track('watch_remove', { keyword, from: 'report_controversy', personKey })
          setWatchedKeywords((prev) => {
            const next = new Set(prev)
            next.delete(keyword)
            return next
          })
          Taro.showToast({ title: '已取消', icon: 'none' })
        }
      })
      return
    }

    /*
     * 授权拿不到也照常订阅（与 utils/risk-watch.ts 取舍 3 同源）：站内预警页能看到，是这条链路的下限。
     * 授权结果只决定订阅成功后那句话怎么说，不决定订不订得上 —— 不能让用户以为「没授权 = 没盯」。
     */
    /*
     * 置忙要放在**授权之前**（2026-10-18）：从点击到「已盯上」之间要过订阅授权弹窗、
     * 一次读库去重、一次写库，快则半秒、慢则几秒 —— 全程按钮毫无变化，用户会以为没点上而反复点。
     * 注意 `setWatchBusy` 是同步 setState、不是 await，不改变下面「授权必须是点击后第一个 await」
     * 的微信硬约束（见本函数开头与用例 53 那条断言）。
     */
    setWatchBusy(keyword)
    let notifyOk = false
    if (alertNotifyConfigured()) {
      const notify = await requestAlertNotify()
      notifyOk = notify.ok
    }

    const res = await addWatch(keyword)
    setWatchBusy(null)
    if (res.ok) {
      track('watch_add', { keyword, from: 'report_controversy', personKey })
      setWatchedKeywords((prev) => new Set(prev).add(keyword))
      Taro.showToast({
        title: notifyOk ? '已盯上，有新报道会推送提醒' : '已盯上，新报道会出现在预警页',
        icon: 'none'
      })
      return
    }
    if (res.fatal) {
      await Taro.showModal({ title: '没能开始盯', content: res.message, showCancel: false, confirmText: '知道了' })
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
      /* 失败就不改状态：不然星标当场变空心、用户以为取消成功，刷新后它又亮回来 */
      const ok = await removeFavorite(id)
      if (!ok) {
        void Taro.showToast({ title: '取消收藏失败，请重试', icon: 'none' })
        return
      }
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
      const okRemove = await removeFavorite(id)
      if (!okRemove) {
        void Taro.showToast({ title: '取消收藏失败，请重试', icon: 'none' })
        return
      }
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
   *
   * 分享框随**我自己的关注态**换（S2-1）：关注了这个人，分享出去的是「我在盯 TA」，
   * 落地页据此把关注入口提到最前（`?from=watch`）。标题与路径由 `personShare` 成对产出，
   * 不会出现「标题说我在盯、路径里没有标记」这种半截状态；没关注的人仍走原来的报告框
   * （替用户编造关系，对方点开就核对不了）。转发与朋友圈同源：朋友圈单页模式下看到的
   * 仍是同一句话，不会一边一个说法。
   */
  const share = personShare({ personKey, name: report?.name ?? name, domain, report, watched: followed, focus })

  /* 分享侧的埋点：微信转发面板每次被调起时各报一次（`frame` 用来对比两种框的分享量，
     与落地侧的 watch_share_arrive 一起算「分享 → 打开」的转化）。 */
  useShareAppMessage(() => {
    track('share', { personKey, channel: 'forward', frame: followed ? 'watch' : 'report' })
    return { title: share.title, path: share.path }
  })
  useShareTimeline(() => {
    track('share', { personKey, channel: 'timeline', frame: followed ? 'watch' : 'report' })
    return { title: share.title, query: share.path.split('?')[1] ?? '' }
  })

  /** 渲染顺序：动态最新在前、履历从早到晚（模型返回顺序不作保证） */
  const dynamicsView = report ? [...report.dynamics].sort((a, b) => byDateDesc(a.date, b.date)) : []
  const timelineView = report ? [...report.timeline].sort((a, b) => byDateAsc(a.date, b.date)) : []
  /*
   * 时间线按年份切块（2026-10-10）：履历是这份报告里唯一跨年的段落，平铺时「2021-05」和
   * 「2024-03」混在一起，读者要自己对着每个日期算。年份小标题把它切成一段段脉络 ——
   * 纯端上按 date 前 4 位切，不改数据结构、不重生成，存量报告立即受益。
   * 解析不出 4 位年份的条目归入「无年份」组（不显示标题），不因此丢数据。
   */
  const timelineGroups = (() => {
    const groups: Array<{ year: string; items: typeof timelineView }> = []
    for (const t of timelineView) {
      const year = (t.date || '').slice(0, 4)
      const isYear = /^\d{4}$/.test(year)
      const last = groups[groups.length - 1]
      if (isYear && last && last.year === year) last.items.push(t)
      else groups.push({ year: isYear ? year : '', items: [t] })
    }
    return groups
  })()

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
   * 报道时间分布（2026-10-12）：把「近期动态」按**月份**聚合成柱状图的数据（纯本地计数）。
   *
   * 只统计带日期的动态（date.slice(0,7) 必须形如 YYYY-MM）：宁可这 N 条不算进图，
   * 也不堆进一个无标签的空桶 —— 那根柱子只会被读成数据脏点。日期是模型从素材原样复制的
   * YYYY-MM-DD，字符串序即时间序（与时间线同一套口径），故这里只排序、不解析日期。
   *
   * 只留最近 ≤6 个月：动态窗口本就约 30 天，柱数再多只是把每根挤细。dated 是有日期动态的
   * 总数（用于「不足 3 条不画图」的判定），max 是这些桶里的最大值（纵轴归一用）。
   */
  const monthBuckets = useMemo(() => {
    const byMonth = new Map<string, number>()
    for (const d of report?.dynamics ?? []) {
      const ym = (d.date || '').slice(0, 7)
      if (!/^\d{4}-\d{2}$/.test(ym)) continue
      byMonth.set(ym, (byMonth.get(ym) ?? 0) + 1)
    }
    const all = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-6)
    const dated = [...byMonth.values()].reduce((sum, n) => sum + n, 0)
    const max = all.reduce((m, [, n]) => Math.max(m, n), 0)
    return { all, dated, max }
  }, [report])

  /**
   * 话题态度（M4-4 剩余项）：模型对 2~4 个近期热点的舆论倾向判断。
   * 可选字段 —— 2026-10-06 之前落库的报告没有它，那些报告只呈现情绪走向条。
   */
  const stances = report?.stance ?? []

  /**
   * 背景类段落的缺口（P1，2026-10-10）：人物档案 / 人物关系 / 时间线**本次为空**。
   *
   * 与 shortfall 是两件事，别看混了：shortfall 说的是「这次生成不完整，**没扣**你的次数」，
   * 而这条说的是「扣了次数，但确实有几节没内容」—— 计费门槛刻意不把这几节算作失败，
   * 因为它们的素材来自不限时间的背景线，空了多半是这位人物的公开资料本身就少
   * （口径与理由见 utils/report.ts#backgroundGaps）。
   *
   * 所以文案不能套用 shortfall 那句「重试通常就好」—— 那句话在这里是错的，会让用户
   * 一直重试、一直拿不到，还把「没内容」误解成「服务坏了」。
   */
  const bgGaps = report ? backgroundGaps(report) : []

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

  /**
   * 冷门首建那条荣誉里要露出的**素材条数**（S2-3，见渲染处）。
   *
   * `coldFirstBuild` 为真时它必定是个数字 —— 判据本身就是「这个数 ≤ COLD_ITEMS_MAX」
   * （utils/report.ts#isColdPerson），这里的 `?? 0` 只是过类型，不会真显示成 0 条。
   */
  const coldFirstItems = report?.coverage?.items ?? 0

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
   * 「已保留更完整的版本」提示条该点名哪几段（P2-12，2026-10-09）。
   *
   * 为什么不能写死「对比视角 / 风险提示 / 信源分歧」：报告是全局共享缓存，同一人物只有一行，
   * 而「算不算会员版」的判据是**有其一即算**（utils/cache.ts#hasMemberBlocks）—— 于是缓存里
   * 完全可能只有其中一段。写死三段就成了一个当场兑现不了的承诺：免费用户为它开通了会员，
   * 回来看到的仍是他刚才看到的那一份。
   *
   * 两边各自的「实际存在的段落」来源不同，不能共用一个：
   *   · 会员：报告里真的写着哪些段（内容没被剥，memberLocked 对会员恒为空，见其注释）；
   *   · 免费：数据层交回的「被藏起来的」那几段（memberLocked）—— 正是他看不到的部分。
   * 兜底用 MEMBER_SECTIONS：这条提示只在「缓存里含会员段」时才出现，理论上取不到空数组。
   */
  const keptSections = member ? presentSections(report) : memberLocked
  const keptNames = (keptSections.length > 0 ? keptSections : MEMBER_SECTIONS).join(' / ')

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
   * 本页所有「去会员中心」动作的唯一出口（促销条、锁态卡、截断提示、目录那行、导出引导）。
   *
   * O-25 删掉了原先「会员态页内滚动到专享卡」的分支 —— 随会员态整条隐藏一起消失，
   * 连带 `Taro.pageScrollTo` 与专享卡上的 `#report-notes` 锚点一并移除，不留死代码。
   *
   * ⚠ `from` 是必填的，且**四种呈现各报各的**（R-2，2026-10-16）：本页的升级位有五种形态，
   * 而 R-2 要回答的正是「哪种呈现真的把人推去了会员页」—— 合成一个来源就再也拆不开，
   * 而这类数据必须发版时就在（一次发版 = 一次归因窗口，事后补不回来）。
   * 跳转与埋点都在 `utils/member-entry.ts#openMemberPage`（收口一处，避免漏报）。
   */
  const onPromoTap = (from: MemberEntryFrom) => openMemberPage(from)

  /**
   * 导出报告长图（获客 P0，2026-10-15）。
   *
   * 为什么值得单开一个出口：右上角的原生转发**只带得走一个链接**（群里没人点），而
   * 「把结论截成一张图发给老板 / 同事」才是这类调研工具真实的使用动作 —— 图流出去，
   * 落款、免责与小程序码才跟着出去；此前全项目只有名言卡与周报卡出得了图。
   *
   * 三道门的顺序不能换：
   *   1. 先组装 —— `buildReportCard` 会拦掉人物命中本地敏感名单的报告（返回 null），
   *      这类报告连入口都不该往下走；
   *   2. 再看身份 —— 免费用户给**一行**升级引导（与周报导出同一分层口径），不弹窗打断阅读；
   *   3. 最后才开面板出图（出图失败由面板自己兜底提示）。
   */
  const onExportCard = () => {
    if (state.phase !== 'ready') return
    const card = buildReportCard(state.report)
    if (!card) {
      void Taro.showToast({ title: '这份报告暂不支持导出图片', icon: 'none' })
      return
    }
    const allowed = canExportReportCard(member)
    /* 被拦也报（allowed:false）：只报放行的话，付费墙的效果永远测不出来（见 utils/events.ts） */
    track('report_export', { personKey, kind: 'card', allowed })
    if (!allowed) {
      setExportGuide('card')
      return
    }
    setPosterCard(card)
  }

  /** 把某一种格式的导出内容送进剪贴板（本机能力，与会员态无关 —— 门禁已在 onExportData 把过） */
  const copyExport = (exp: ReportExport, kind: ExportKind) => {
    const data = kind === 'json' ? exp.json : exp.markdown
    return Taro.setClipboardData({ data })
      .then(() => {
        /* 只在这一刻报「真的带走了」：用户选完格式又放弃复制的不算（见 utils/events.ts） */
        track('report_exported', { personKey, kind })
        void Taro.showToast({ title: `已复制 ${exportFileName(exp, kind)}`, icon: 'none' })
      })
      .catch((err: unknown) => {
        void Taro.showToast({ title: toUserMessage(err, '复制失败，请重试'), icon: 'none' })
      })
  }

  /**
   * 导出结构化数据（S3-1，2026-10-16）—— 与长图**并列的第二个出口**，不是替代。
   *
   * 长图用来发给人看；这份用来看：每条事实带出处、末尾附完整来源清单（图带不了链接）、
   * JSON 可进表格或二次处理。之所以值得单独开一个付费出口：它**与共享缓存无因果关系**
   * （报告已在库里，导出是纯本地组装，零上游成本），不像额度会随缓存变厚而贬值。
   *
   * 门的顺序与 onExportCard 一致，只在第 2、3 步之间多一格：
   *   1. 先组装 —— 人物命中本地敏感名单时 `buildReportExport` 返回 null，这类报告连入口都不该往下走；
   *      （导出一旦离开 App 就不再受内容检查约束，这里是唯一的拦点）
   *   2. 再看身份 —— 免费用户给一行升级引导，且**在选格式之前**：
   *      格式选择本身就是要卖的能力，让他先选再被拦，是白点一次；
   *   3. 最后才选格式并复制。
   */
  const onExportData = () => {
    if (state.phase !== 'ready') return
    const exp = buildReportExport(state.report, { member })
    if (!exp) {
      void Taro.showToast({ title: '这份报告暂不支持导出数据', icon: 'none' })
      return
    }
    const allowed = canExportReport(member)
    track('report_export', { personKey, kind: 'data', allowed })
    if (!allowed) {
      setExportGuide('data')
      return
    }
    void Taro.showActionSheet({ itemList: EXPORT_FORMATS.map((f) => f.label) })
      .then((res) => copyExport(exp, EXPORT_FORMATS[res.tapIndex]?.kind ?? 'markdown'))
      .catch(() => undefined) // 用户取消：不是失败，不提示
  }

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
  /* 「人物速览」可见的充要条件：不是降级简版，或有覆盖数据（与卡片那两个分支的条件等价） */
  const tocHasOverview = !(!!report && report.degraded && !cov && coverageSpan === '')
  const tocSections = buildReportToc(report, { member, hasOverview: tocHasOverview })
  /*
   * 展开态按组渲染（2026-10-10 三改）：18 节平铺成一格格胶囊后，「人物速览」与「名词解释」
   * 并排、「AI 点评」与「热度趋势」相邻，读起来是一堆没有线索的词。分组只加行首小标签，
   * 不改任何一节的顺序（组必须连续，见 utils/report-toc.ts#TOC_GROUPS）。
   * 与 tocSections 同源：两者都出自 report-toc 的 visibleSections，故标题上的节数与
   * 下面胶囊的总数必然一致，不会出现「标题说 18 节、格子里只有 17 颗」。
   */
  const tocGroups = buildReportTocGroups(report, { member, hasOverview: tocHasOverview })
  /*
   * 免费用户看不到的会员档节（会员为空数组）：目录底部那行「会员另含 N 节」用它。
   * 页面另外还判了一次 `member`（会员档的卡片），两处口径都来自 utils/report-toc.ts，
   * 这里只负责把「差几节」说清楚 —— 免费用户不会在页面里遇到那些卡片，得让他知道有。
   */
  const tocLocked = lockedReportToc(report, { member, hasOverview: tocHasOverview })
  /*
   * S3-3：免费档把会员节的位置**就地**占住（锁态卡）。
   * 用 `tocLocked` 的 id 集合，而不是在页面里另写七个 `!member` 判断 —— 这样目录那行
   * 「会员另含 N 节」与这几张卡永远是**同一份条件**（某节被 visible 判掉时两边一起消失），
   * 以后动模板不需要动页面。
   */
  const lockedIds = new Set(tocLocked.map((s) => s.id))

  /**
   * 这份报告的版本号（2026-10-18）：`v2026.10.18`，显示在目录卡标题里。
   *
   * 为什么不新存一个 version 字段：报告已经有一份权威的生成时间（`generatedAt`，
   * 与 `report_cache.generated_at`、`report_versions._id` 同源），再造一个编号就必须
   * 在**每条**生成路径上同步维护，漏一处就出现「这份报告没有版本号」。
   * 派生则天然对齐：缓存命中、强制重生、降级兜底都走同一个 `generatedAt`。
   * 老报告解析不出时间 => 空串，标题只显示节数（不写「v未知」冒充版本）。
   */
  const reportVer = reportVersion(report?.generatedAt)

  /*
   * S3-3：免费档「速览」—— 列表型节按档截断（免费 3 条 / 会员不截断）。
   *
   * ⚠ 只截**渲染源**，`dynamicsView` / `report.*` 一律保持完整：
   *   · `dynamicsView` 还被算出覆盖区间的算法读着（见上面的 `coverageSpan`），截了会改变速览卡的数字；
   *   · `report` 本身是周报 / 风险监控 / 对比页 / 问答 / 导出的共同来源，截了是另一件严重的事
   *     （理由写在 config/benefits.ts#REPORT_PREVIEW）。
   * 节名后面括号里的总数（如「近期动态（11）」）也保持**真实总数** —— 标题说实话、
   * 正文给 3 条并注明「还有 8 条」，读者才知道自己拿到的是速览。
   */
  const profilePreview = previewRows(report ? report.profile : null, member)
  const relationsPreview = previewRows(report ? report.relations : null, member)
  const dynamicsPreview = previewRows(dynamicsView, member)
  const quotesPreview = previewRows(report ? report.quotes : null, member)

  /*
   * R-2 的分母：免费读者**真的看到**锁态呈现的那一次页面访问（2026-10-16）。
   *
   * 「真的看到」= 会员态已就位 + 不是会员 + 至少有一张锁态卡或一处截断，三者缺一都不报 ——
   * 否则分母里会混进「这一页本来就没有锁态」的访问，转化率被系统性低估
   * （与 `opinion_pick`「只在真的设入候选那一刻报」同一条道理）。
   *   · 必须等 `memberReady`：那之前 `member` 还是初值 false，会把会员当成免费读者报一遍
   *     （同上面促销条掷骰子的取舍）；
   *   · 已报过的 personKey 用 ref 记住：报告加载、关注态同步、会员态同步都会触发重渲染，
   *     不记就每次重渲染补一条，而重渲染次数与「看了几眼」没有关系；
   *   · 换一份报告要重新报（personKey 变 = 另一次「看到速览」的访问）。
   */
  const lockCut =
    profilePreview.hidden + relationsPreview.hidden + dynamicsPreview.hidden + quotesPreview.hidden
  const lockSeen = useRef('')
  useEffect(() => {
    if (!report || !memberReady || member) return
    if (lockSeen.current === report.personKey) return
    if (tocLocked.length === 0 && lockCut === 0) return
    lockSeen.current = report.personKey
    track('report_lock_see', { locked: tocLocked.length, cut: lockCut })
  }, [report, member, memberReady, tocLocked.length, lockCut])

  /*
   * 报告阅读基数 `report_open`（2026-10-16）：这一次访问**真的把一份报告呈现给了读者**。
   *
   * 它是 S3-1（导出出口 ÷ 阅读）、N-4（导出与历史版本的实际使用率）与 D7 的推翻条件
   * （「导出使用率极低而站内访问极高」）**共用的分母** —— 而这三处此前都没有分母可用：
   * `report_hit_cache` 是成本口径，且**刚生成完接着读**的那一次不在它里面（走 `report_generate`），
   * 偏偏那批人最容易立刻导出；靠事件并集凑分母则每加一条分支都要重新对一遍。故挂在**呈现点**
   * （详见 utils/events.ts 那条的完整说明）。
   *
   * `report` 非空即「屏上真有一份报告」（loading / 等他人出结果 / 冷启动 / 无素材 / 出错时
   * 它都是空，不算「读了一份报告」）。按 personKey 用 ref 去重：理由与上面 `report_lock_see`
   * 一字不差 —— 加载、关注态、会员态同步都会触发重渲染，不记就会每次重渲染补一条，
   * 而重渲染次数与「读了几份报告」没有关系。
   */
  const openedSeen = useRef('')
  useEffect(() => {
    if (!report) return
    if (openedSeen.current === report.personKey) return
    openedSeen.current = report.personKey
    track('report_open', { personKey: report.personKey, cached: fromCache })
  }, [report, fromCache])

  const jumpToSection = useCallback((id: string) => {
    setTocActive(id)
    setTocOpen(false)
    /*
     * 用原生 pageScrollTo + 元素 id，不把整页换成 ScrollView：报告页是原生页面滚动
     * （下拉刷新、返回顶部都依赖它），为一个目录条换容器不值当。offsetTop 留一点，
     * 让卡片标题不贴着屏幕顶端。跳转失败不做提示 —— 目标一定存在（目录与卡片条件同源），
     * 失败只可能是页面正在重渲染。
     *
     * ⚠ 必须等「目录收起」这一帧落到视图层之后再去量锚点（2026-10-12 修「跳转位置不对」）：
     * 目录展开时那一整块胶囊列表就在目标节的**上方**，而 setState 是异步的 ——
     * 在同一个函数里紧接着调 pageScrollTo，量到的仍是**展开态**的 offsetTop；
     * 等目录收起、上方内容整体上移一整块目录的高度之后，页面就停在目标的**下方**，
     * 表现为「点了目录，却落到下面一节/中间位置」。nextTick 在本帧渲染落到视图层后触发，
     * 此时量到的才是收起后的真实位置。
     */
    Taro.nextTick(() => {
      Taro.pageScrollTo({ selector: `#${id}`, offsetTop: -12, duration: 260 }).catch(() => {})
    })
  }, [])

  /*
   * 点评导读（2026-10-10）：速览卡末行那句「最值得先看到的判断」，整行可点、跳到点评卡。
   *
   * 首屏目前只有热度、条数、覆盖区间这类冷数据，而模型真正给出的判断（AI 点评）排在第 8 节 ——
   * 用户得滑过七张卡才读到这份报告最有价值的一句话。这里把**模型已经写过**的那一句提到首屏
   * （取法与理由见 utils/report.ts#reportGist），不新增任何说法，也不多调一次模型。
   *
   * 为什么不另起一张卡：新卡必须同时在目录里注册（「页面有卡、目录里找不到入口」是本项目明确
   * 列出的缺陷），而这句导读的归宿本来就是「点评」那一节 —— 单列一节只会多一处需要同步的条件。
   * 故它是速览卡的末行：上面几行是「原样统计、可当事实读」的素材画像，这一行是模型判断，
   * 标签直接写「AI 点评」、行尾写明去哪，读的人不会把它误当成统计结论。
   */
  const gist = report ? reportGist(report) : ''
  const gistRow = gist !== '' && (
    <View
      className='page-report__info page-report__gist'
      hoverClass='page-report__gist--tap'
      onClick={() => jumpToSection('sec-analysis')}
    >
      <Text className='page-report__info-label'>AI 点评</Text>
      <View className='page-report__info-body'>
        <Text className='page-report__info-value page-report__gist-text'>{gist}</Text>
        <Text className='page-report__info-sub'>完整点评与依据 ›</Text>
      </View>
    </View>
  )

  return (
    <View className='page-report glow-page safe-bottom'>
      {/*
        非破坏式刷新的全屏加载浮层（2026-10-10 新增 → 四改：真正浮在最顶层）。
        它只在 refreshing 时出现；渲染位置必须留在页面根节点之下，因为浮层的层级由
        app.scss 的 `.glow-page > .glow-overlay` 给死（见该处注释：不加这个类会被
        `.glow-page > view` 覆盖成 relative + z-index:1，浮层就会被正文压住 —— 用户反馈的
        「加载动画没浮在最顶层、也没覆盖页面」就是这个原因）。
        没有它时这条路径**只有页脚那颗按钮转圈**，从顶部「重新生成为…」点进来的用户完全看不到反馈。
      */}
      {refreshing && <ReportRefreshing progress={progress} />}

      {showFocusBar && !focusClosed && (
        <View className='page-report__focus'>
          <Text className='page-report__focus-tag'>{focus === 'all' ? '综合' : FOCUS_META[focus].short}</Text>
          {/*
            refreshing 也算「正在生成」：刷新期间 phase 仍是 ready，若只判 phase，
            这里会继续挂着「重新生成为深度报告」的链接 —— 用户刚点完它还提示再点一次，
            正是「点了没反应 → 再点一次」的来源（而每次点击都会真实消耗一次生成额度）。
          */}
          {state.phase === 'loading' || refreshing ? (
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
          <NoticeClose onClose={() => setFocusClosed(true)} />
        </View>
      )}

      {/*
        好友分享落地条（S2-1，2026-10-16）。

        为什么要有它：对方是**顺着朋友的分享**进来的陌生人 —— 他从没听过这个产品，
        第一眼看到的却是一份陌生人的报告，读完也不知道该做什么。这条把分享者的动作
        （「朋友在盯 TA」）摆在首屏，并当场给一个关注入口：关注之后 TA 的动态会进
        「关注动态」页，这既是对方留下的一步，也是这条分享链路的全部目的。

        三个位置上的取舍：
          · 摆在人物横幅**之上**（横幅内部的「+ 关注」仍是全站通用的那个按钮）——
            陌生人进来看的是「谁分享给我的、我该干嘛」，先给这件事；
          · 不放在 `{report && ...}` 里：报告可能还没生成（要点开长图/等生成才看得到），
            而关注这件事**完全不需要报告**（只认 personKey）。放进横幅里就等于
            「先等 30 秒生成，再谈关注」—— 那是最容易丢人的 30 秒；
          · 关注后整条消失（`!followed`）：它是一次性的引导，不是常驻广告位。
      */}
      {watchArrival && followRead && !followed && (
        <View className='page-report__invite'>
          <View className='page-report__invite-main'>
            <Text className='page-report__invite-title'>{`朋友在盯 ${name}`}</Text>
            <Text className='page-report__invite-note'>关注后 TA 的动态会汇总到「关注动态」</Text>
          </View>
          {/* 来源标 watch_share：这条引导的转化率要能与横幅上的关注分开算 */}
          <View
            className='page-report__invite-btn'
            hoverClass='page-report__invite-btn--tap'
            onClick={() => void onToggleFollow('watch_share')}
          >
            + 关注
          </View>
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
            {/* 人物头像：有真图（云端博查照片）就画照片，没有仍回落「领域色渐变 + 姓名首字」
                （见 components/person-avatar）。白色描边是为了在紫色横幅上把头像和背景分开。 */}
            <PersonAvatar
              personKey={report.personKey}
              name={report.name}
              domain={domain}
              className={`page-report__avatar page-report__avatar--${domainStyleCode(domain)}`}
            />
            {/* 名字行 = 名字 + 领域。不换行且 overflow:hidden：名字过长时收省略号让位。
                领域跟在名字后面而不是另起一行 —— 它是名字的定语，两三个字，值得花这点宽度。 */}
            <View className='page-report__name-row'>
              <Text className='page-report__name'>{report.name}</Text>
              <View className='page-report__banner-chip'>{domainLabel(domain)}</View>
            </View>
          </View>

          {/* 状态行（全幅）：刚生成 → 这一版引用了多少实时素材（报告自证）；否则 → 这份报告有多旧。
              **它只报事实，不再是入口**（2026-10-17 用户反馈：「查看最新」与工具卡的「刷新」重复）。
              此前这一行整行可点、行尾还挂一个带下划线的「查看最新」，而首屏工具卡里已有一颗「刷新」
              —— 同一个动作两个入口，措辞（查看最新 / 刷新）又像两件轻重不同的事。
              现在刷新只留工具卡一处，这一行退回纯文本。
              历史（2026-10-10）：这一行曾在 showFresh 时撤掉热区、页脚按钮同时变灰「已是最新」，
              同一动作三个答案，用户只能学会怀疑按钮；后来把门开在明处（确认弹窗写清代价：
              消耗 1 次生成次数 + 今日剩余，见 confirmRefresh）。入口收成一处后，
              「前后不能说两套话」自然成立 —— 因为只剩一套。
              O-14 要的「N 天前生成」仍写在这里：年龄是判断依据，建议怎么做的动作交给工具卡。 */}
          <View className='page-report__meta'>
            {showFresh ? (
              <Text className='page-report__meta-text'>{`刚刚生成 · ${sourceNote}`}</Text>
            ) : (
              <Text className='page-report__meta-text'>
                {staleReport ? `${ageDays} 天前生成` : `${fromNow(report.generatedAt)}生成`}
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
        <View
          className='page-report__vip'
          hoverClass='page-report__vip--tap'
          onClick={() => onPromoTap('report_promo')}
        >
          <Text className='page-report__vip-tag'>会员专享</Text>
          <Text className='page-report__vip-note'>{promo.text}</Text>
          <Text className='page-report__vip-action'>{`${promo.action} ›`}</Text>
          {/* 关闭键：点它只关不跳（stopPropagation，见 onPromoClose） */}
          <Text className='page-report__vip-close' onClick={onPromoClose}>
            ✕
          </Text>
        </View>
      )}

      {/*
        刷新失败（P1-8）：非破坏式刷新没拿到新版本时，缓存层会交回**原有那一版**报告，
        并用 refreshFailed / refreshError 说明「这次为什么没刷成」（文案见 utils/cache.ts#refreshFailureNote）。
        这一条此前一直没被渲染出来 —— state 设了、文案也有、单测也钉着，唯独页面上是空的，
        用户点了「刷新最新」只看到内容一动不动，只能以为按钮坏了。补在这里，与其余刷新结果条同一套外观。
      */}
      {refreshError && !closedNotices.error && (
        <View className='page-report__diff'>
          <View className='page-report__diff-main'>
            <Text className='page-report__diff-head'>这次没能刷新成功</Text>
            <Text className='page-report__diff-body'>{refreshError}</Text>
          </View>
          <NoticeClose onClose={() => closeNotice('error')} />
        </View>
      )}

      {/*
        首建说明（2026-10-15）。报告是**全局共享缓存**：一份建好之后全站复用、任何人再查都不消耗
        生成次数（见 utils/cache.ts#isFirstBuild）。于是「第一个生成的人」刚付掉 1 次额度时，
        最容易把账读成「我出钱、别人白看」—— 而实际上：热门人物多半是别人先建、他才是受益者；
        就算真是首建，他买到的也是可反复查看的报告本体，且这笔检索与整理长期留在库里供全站（含他自己）
        复用。这一条只在他刚付完、最可能产生那个念头的一刻把账说清，不做任何劝留。

        只在**首建且落库成功**时出现：命中缓存、覆盖刷新、产物不达标都不带 firstBuild（见缓存层），
        所以它不会在「我只是看看别人的报告」时冒出来。可关闭，且与其余提示条各关各的。

        冷门首建（S2-3，2026-10-16）换一套说法：上面那段把账说清了，但读完的感受是「我明白了」，
        不是「我这趟值」。而**公开报道很少的长尾人物**正是「没人愿意花额度建」的那一类——
        第一个建的人补上的是库里长期空着的一个位置，值得一句看得见的回报（判据与埋点同源，
        见 utils/report.ts#isColdPerson）。三件事一起说：他建的是什么人（附本次素材条数，可自查）、
        此前的位置是空的、这份之后全站共用。**不加码任何承诺**（不说「免计费」「送次数」，
        那笔账由 quotaGuard 复核、端上给不了准话）。
        仍是同一个 notice key（`firstBuild`）——不为荣誉再长出一条提示条，用户已经嫌多。
      */}
      {firstBuild && !closedNotices.firstBuild && (
        <View className={coldFirstBuild ? 'page-report__diff page-report__diff--first' : 'page-report__diff'}>
          <View className='page-report__diff-main'>
            <Text className='page-report__diff-head'>
              {coldFirstBuild ? '🏅 你是 TA 报告的第一位建立者' : '这份报告由你首次生成'}
            </Text>
            {coldFirstBuild ? (
              <Text className='page-report__diff-body'>
                {`TA 的公开报道不多（本次检索到 ${coldFirstItems} 条素材），此前库里没有 TA 的报告 —— 你补上的这一份此后全站共用、长期可查，之后任何人查看都不再消耗生成次数（包括你自己）。`}
              </Text>
            ) : (
              <Text className='page-report__diff-body'>
                报告按人物全站共用一份：之后任何人查看都不再消耗生成次数（包括你自己），
                你这次的检索与整理会留在库里，供之后一直查看。
              </Text>
            )}
          </View>
          <NoticeClose onClose={() => closeNotice('firstBuild')} />
        </View>
      )}

      {/* 刷新反馈：告诉用户这次「刷新最新」到底刷出了什么，此前点完毫无回音 */}
      {diff && !closedNotices.diff && (
        <View className='page-report__diff'>
          <View className='page-report__diff-main'>
            <Text className='page-report__diff-head'>已更新为最新版本</Text>
            <Text className='page-report__diff-body'>
              相比 {fromNow(diff.prevAt)} 的版本：{diffParts.join(' · ')}
            </Text>
          </View>
          <NoticeClose onClose={() => closeNotice('diff')} />
        </View>
      )}

      {/*
        带了补充关键词、读的却是已有报告（P6，2026-10-17）。
        关键词刻意不进 personKey / 缓存键（同一个人只有一份报告），所以只要命中缓存它就没生效。
        此前没有这句，用户会把「关键词没带来变化」读成「这个人和关键词没什么关系」——
        前者是我们的机制，后者是对人物的错误陈述，代价完全不对等。
        与其余刷新结果条同一套外观，各关各的（见 closedNotices 注释）。
      */}
      {keywordUnused && !closedNotices.keywordUnused && (
        <View className='page-report__diff'>
          <View className='page-report__diff-main'>
            <Text className='page-report__diff-head'>这次读的是已有报告</Text>
            <Text className='page-report__diff-body'>
              你填的补充关键词「{keywordUnused}」只在重新生成时才会用到 —— 这份报告是之前生成的，并没有按它去查。
              想让关键词生效，点下方工具的「刷新」并确认重新生成（会消耗一次生成次数）。
            </Text>
          </View>
          <NoticeClose onClose={() => closeNotice('keywordUnused')} />
        </View>
      )}

      {/*
        刷新被「只升不降」拦下（P0）：报告是全局共享缓存，同一人物全站只有一行，
        免费档产物若覆盖掉含会员段落的那一版，全站会员都会看到「深度解析」整块消失，
        且不会自愈 —— 故缓存里已含会员段落时拒绝降级覆盖（utils/cache.ts）。
        这一条必须出现：用户点了「刷新最新」却什么都没变，没有解释就等于按钮坏了。
        文案按会员态分开 —— 免费用户看不到会员段落，对他来说重点是「为什么刷不动、差在哪」。
        段名一律走 keptNames（P2-12，2026-10-09）：缓存那版可能只有其中一段，
        「有其一即算会员版」，写死三段就是一句当场兑现不了的承诺。
      */}
      {keptMember && !closedNotices.keptMember && (
        <View className='page-report__diff'>
          <View className='page-report__diff-main'>
            <Text className='page-report__diff-head'>已保留更完整的版本</Text>
            <Text className='page-report__diff-body'>
              {member
                ? `这位人物的报告已含会员专属段落（${keptNames}），本次刷新生成的内容更基础，故未覆盖它。`
                : `这位人物已有一份更完整的报告（含会员专属段落：${keptNames}），本次刷新生成的内容更基础，故未覆盖它。开通会员后即可查看。`}
            </Text>
          </View>
          <NoticeClose onClose={() => closeNotice('keptMember')} />
        </View>
      )}

      {/*
        产物不达标（2026-10-10）：与上一条同为「点了刷新，结果和预期不一样」，故共用同一个提示位。
        但重点完全不同 —— 上一条回答「为什么没变」，这一条要回答**「这次扣不扣次数」**：
        用户手上是一份残缺的报告，不说清就会以为白花了一次额度（见 utils/report.ts#reportShortfall）。
      */}
      {shortfall && !closedNotices.shortfall && (
        <View className='page-report__diff'>
          <View className='page-report__diff-main'>
            <Text className='page-report__diff-head'>这次生成不完整，没有消耗次数</Text>
            <Text className='page-report__diff-body'>
              本次没能拿到完整的一份报告（{shortfall}），所以没有扣减你的生成次数。
              {shortfallRetryable
                ? '可以直接再点一次「重新生成」，或稍后再试 —— 多为上游偶发抖动，重试通常就好。'
                : '这次检索到的近期素材本身就偏少，重新生成通常也不会有变化 —— 建议过几天素材多些再来，或换一位人物试试。'}
            </Text>
          </View>
          <NoticeClose onClose={() => closeNotice('shortfall')} />
        </View>
      )}

      {/*
        背景类段落为空（P1，2026-10-10）：与上一条共用外观，但**火候相反** ——
        上一条劝「再试一次」，这一条要明确说「重试不会有变化」，省掉一场白等。
        两者可能同时出现（生成不完整 + 档案为空），各自独立、各关各的（见 closedNotices 注释）。
      */}
      {bgGaps.length > 0 && !closedNotices.bgGaps && (
        <View className='page-report__diff'>
          <View className='page-report__diff-main'>
            <Text className='page-report__diff-head'>这几节本次没有内容</Text>
            <Text className='page-report__diff-body'>
              {bgGaps.join(' / ')}：本次已单独检索过「人物背景」资料（不限时间），仍未拿到可溯源的内容
              —— 多为这位人物的公开资料本身就少，重新生成通常不会有变化。
            </Text>
          </View>
          <NoticeClose onClose={() => closeNotice('bgGaps')} />
        </View>
      )}

      {/*
        部分批生成失败（2026-10-11）：报告分 4 批生成，某一批两三次尝试都失败时那一组段落整块缺失，
        但报告仍可能通过达标判定落库（见 utils/report.ts#Report.missingGroups）。这里告诉读者
        「是数据缺失、不是页面坏了」，并指一条能补全的路（重新生成）—— 与 shortfall 不同：shortfall
        是「这次没扣次数」，这条是「已扣次数、但确实少了几组」，两者不会同时出现（shortfall 不落库）。
      */}
      {report?.missingGroups && report.missingGroups.length > 0 && !closedNotices.missingGroups && (
        <View className='page-report__diff'>
          <View className='page-report__diff-main'>
            <Text className='page-report__diff-head'>这份报告缺了几个部分</Text>
            <Text className='page-report__diff-body'>
              生成时有 {report.missingGroups.length} 组段落没能成功产出（
              {report.missingGroups.map((g) => MISSING_GROUP_LABELS[g] ?? g).join(' / ')}
              ），下面相应卡片可能缺失 —— 不是显示问题。点上方工具卡的「刷新」重新生成，通常可以补全。
            </Text>
          </View>
          <NoticeClose onClose={() => closeNotice('missingGroups')} />
        </View>
      )}

      {/*
        报告工具卡（2026-10-16）。

        为什么合并（用户反馈）：同一份报告的五个动作原本散在页面的**首尾两端** ——
        首屏只有一条「向 AI 提问」，而「收藏 / 刷新 / 导出长图 / 导出数据」要滚到页面最底部
        才看得见。读了一半想收藏、或想导出的用户，得先滚到底、再滚回来。
        它们语义上本就是同一类东西（**对这份报告做什么**）、且都不依赖正文，故收进同一张卡、
        落在首屏：紧跟人物横幅与会员促销条之后，随报告一起出现。

        三处刻意保留：
          · 「向 AI 提问」仍是本卡最重的动作（图标按钮 + 主副文案 + 箭头），不降级成第四个工具 ——
            它是本卡唯一会**另开一条阅读动线**的入口，其余四个都是就地生效；
          · 两个导出仍是**会员权益**（门禁见 utils/report-card.ts#canExportReportCard /
            utils/report-export.ts#canExportReport，一处没动），故各自带「会员」角标 ——
            混成四个等重的图标按钮、又不标权益，用户会以为点哪个都一样；
          · 卡尾仍留一行小字说清两个导出各给什么（原两块导出区的说明收敛成一行）。

        文案（2026-10-12 用户反馈「有歧义」）必须原样保留：原先只写「不消耗生成次数」，
        而问答面板头部又有「今日还可问 N 次」，两处并列时读起来像「不消耗生成、却消耗提问」
        的矛盾句。两个额度池本就不同（生成池 / 提问池），文案必须把**两个池的名字都写出来
        并各自定性**，歧义即消。
      */}
      {report && (
        <View className='page-report__tools'>
          <View
            className='page-report__tools-ask'
            hoverClass='page-report__tools-ask--tap'
            onClick={() => Taro.navigateTo({ url: `/package/qa/index?personKey=${encodeURIComponent(personKey)}` })}
          >
            <Text className='page-report__tools-ask-icon'>AI</Text>
            <View className='page-report__tools-ask-main'>
              <Text className='page-report__tools-ask-title'>向 AI 提问</Text>
              <Text className='page-report__tools-ask-desc'>
                就这份报告继续追问 · 只计「每日提问次数」，不占「报告生成次数」
              </Text>
            </View>
            <Text className='page-report__tools-ask-arrow'>→</Text>
          </View>

          <View className='page-report__tools-row'>
            {/* 收藏报告：就地生效，故不做二次确认 */}
            <View
              className={`page-report__tool${reportFaved ? ' page-report__tool--on' : ''}`}
              hoverClass='page-report__tool--tap'
              onClick={() => void toggleReportFav()}
            >
              <Text className='page-report__tool-icon'>{reportFaved ? '★' : '☆'}</Text>
              <Text className='page-report__tool-label'>{reportFaved ? '已收藏' : '收藏'}</Text>
            </View>

            {/*
              刷新最新：非破坏式刷新时 phase 仍是 ready，只看 phase 这颗按钮会像「没反应」，
              故 refreshing 一并算进忙碌态（是否值得花这次额度统一由确认弹窗把门，
              见 requestRefresh 的注释 —— 按钮不替用户做决定，只如实显示在做什么）。
            */}
            <View
              className={`page-report__tool${
                state.phase === 'loading' || refreshing ? ' page-report__tool--busy' : ''
              }`}
              hoverClass='page-report__tool--tap'
              onClick={() => void requestRefresh()}
            >
              <Text className='page-report__tool-icon'>⟳</Text>
              <Text className='page-report__tool-label'>
                {state.phase === 'loading' || refreshing ? '刷新中' : '刷新'}
              </Text>
            </View>

            {/* 导出报告长图：会员权益，角标只在非会员时出现（会员不需要被告知自己买过什么） */}
            <View className='page-report__tool' hoverClass='page-report__tool--tap' onClick={onExportCard}>
              <Text className='page-report__tool-icon'>▤</Text>
              <Text className='page-report__tool-label'>长图</Text>
              {!member && <Text className='page-report__tool-vip'>会员</Text>}
            </View>

            <View className='page-report__tool' hoverClass='page-report__tool--tap' onClick={onExportData}>
              <Text className='page-report__tool-icon'>▦</Text>
              <Text className='page-report__tool-label'>数据</Text>
              {!member && <Text className='page-report__tool-vip'>会员</Text>}
            </View>
          </View>

          <Text className='page-report__tools-note'>
            长图带结论、依据与出处，可保存 / 转发；数据为 Markdown 全文（每条带出处）+ JSON，可核对
          </Text>

          {!!exportGuide && (
            <View className='page-report__export-guide' onClick={() => onPromoTap('report_export')}>
              <Text>{exportGuide === 'data' ? reportDataExportNote() : reportExportNote()}</Text>
            </View>
          )}
        </View>
      )}

      {state.phase === 'loading' && <ReportLoading progress={progress} />}

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
          title='暂未检索到公开信息'
          /*
            文案要点（2026-10-10 改）：
            1. 说清「已经放宽到一年内」—— 检索侧确实做了降级阶梯（utils/search.ts#fetchNews），
               不再是「近 30 天没有」就打发人；
            2. **明说不消耗次数** —— 空手而归的多是付费用户，他最需要知道的就是「这次没花钱」；
            3. 给可操作的下一步（带领域再查 / 换人），而不是「换个时间再试」这种没法照做的建议。
          */
          desc='该名人近期没有公开报道（已放宽到一年内仍无结果）。这次没有生成报告，也不消耗你的生成次数 —— 可以给名字带上领域再查一次（如「张三（演员）」），或换一位近期有报道的名人。'
          actionText='刷新重试'
          onAction={() => void load(true)}
        />
      )}

      {state.phase === 'refused' && (
        <EmptyState icon='🚫' title='暂不支持查询该人物' desc={`本工具覆盖${DOMAIN_COVERAGE_TEXT}等多个领域的公众名人`} />
      )}

      {state.phase === 'error' && (
        /*
          缺 personKey 的两种来路：转发时链接被截断、小程序码 scene 编不完（见 utils/share-code.ts）。
          这一态**不是「生成失败」**，原先把两者合在一起（标题「生成失败」+ 按钮「重试」）会让用户
          反复点重试 —— 而参数缺失重试一万次也还是缺，那是个走不出去的圈。它需要的是出路（2026-10-16）。
        */
        !personKey ? (
          <EmptyState
            icon='🔗'
            title='这条链接没带上要看的人'
            desc='多半是转发时被截断了。回首页搜索名字，就能看到 TA 的报告。'
            actionText='去首页搜名人'
            onAction={() => void Taro.switchTab({ url: '/pages/index/index' })}
          />
        ) : (
          <EmptyState
            icon='⚠️'
            title='生成失败'
            desc={state.message}
            actionText='重试'
            onAction={() => void load(false)}
          />
        )
      )}

      {report && (
        <View>
          {tocSections.length > 1 && (
            <View className='card page-report__toc'>
              <View
                className='page-report__toc-head'
                hoverClass='page-report__toc-head--tap'
                onClick={() => setTocOpen(!tocOpen)}
              >
                {/*
                  版本号跟着目录标题走（2026-10-18）：目录是「这份报告有什么」的总入口，
                  版本号放在这里，用户一眼就知道「我读的是 v2026.10.18 这一版」，
                  翻到历史版本对照时也不用再回顶部找生成时间。
                  `.card-title` 全局是 flex + 居中，故版本号作为兄弟 Text 直接横排、
                  靠 margin-left 拉开距离，不必另包一层容器去改全局标题样式。
                */}
                <View className='card-title'>
                  {`目录 · ${tocSections.length} 节`}
                  {reportVer && <Text className='page-report__toc-ver'>{reportVer}</Text>}
                </View>
                <Text className='page-report__toc-toggle'>{tocOpen ? '收起' : '展开'}</Text>
              </View>
              {tocOpen && (
                <View className='page-report__toc-list'>
                  {tocGroups.map((g) => (
                    <View key={g.key} className='page-report__toc-group'>
                      {/* 组标签是「这几节归一类」，本身不是一节：不可点、也不是胶囊 */}
                      <Text className='page-report__toc-group-label'>{g.label}</Text>
                      <View className='page-report__toc-group-items'>
                        {g.sections.map((s) => (
                          <View
                            key={s.id}
                            className={`page-report__toc-item${tocActive === s.id ? ' page-report__toc-item--active' : ''}`}
                            hoverClass='page-report__toc-item--tap'
                            onClick={() => jumpToSection(s.id)}
                          >
                            <Text className='page-report__toc-item-text'>{s.label}</Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}
                </View>
              )}
              {tocOpen && tocLocked.length > 0 && (
                <View
                  className='page-report__toc-more'
                  hoverClass='page-report__toc-more--tap'
                  onClick={() => onPromoTap('report_toc')}
                >
                  <Text className='page-report__toc-more-text'>
                    {`完整模板 ${TEMPLATE_SIZE} 节 · 会员另含 ${tocLocked.length} 节 · 每节看全部`}
                  </Text>
                  <Text className='page-report__toc-more-go'>开通会员 ›</Text>
                </View>
              )}
            </View>
          )}

          {!report.degraded && !cov && coverageSpan === '' && (
            <View id='sec-overview' className='card'>
              <View className='card-title'>人物速览</View>
              <Text className='page-report__empty'>
                这份报告没有记录素材覆盖范围（多为较早生成的缓存报告），收录的动态也都没有可用日期，故算不出报道热度与覆盖区间。点上方工具卡的「刷新」重新生成即可补上。
              </Text>
              {gistRow}
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

              {gistRow}
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

          {/* AI 解读（批 2）：本系统基于公开信息的客观评价。verdict / reputation / consistency
              任一存在才出卡 —— 老报告没有这些字段，整卡不出。评价/判断类，允许归纳推断，底部配免责。 */}
          {(report.verdict || report.reputation || report.consistency) && (
            <View id='sec-verdict' className='card'>
              <View className='card-title'>AI 解读</View>
              {report.verdict?.summary && (
                <View className='page-report__verdict-summary'>{report.verdict.summary}</View>
              )}
              {report.verdict?.positioning && (
                <View className='page-report__verdict-row'>
                  <Text className='page-report__verdict-label'>行业定位</Text>
                  <Text className='page-report__verdict-text'>{report.verdict.positioning}</Text>
                </View>
              )}
              {(report.reputation?.positive || report.reputation?.negative) && (
                <View className='page-report__reputation'>
                  {report.reputation?.positive && (
                    <View className='page-report__verdict-row'>
                      <Text className='page-report__verdict-label page-report__verdict-label--pos'>支持方</Text>
                      <Text className='page-report__verdict-text'>{report.reputation.positive}</Text>
                    </View>
                  )}
                  {report.reputation?.negative && (
                    <View className='page-report__verdict-row'>
                      <Text className='page-report__verdict-label page-report__verdict-label--neg'>反对方</Text>
                      <Text className='page-report__verdict-text'>{report.reputation.negative}</Text>
                    </View>
                  )}
                </View>
              )}
              {(report.consistency?.claim || report.consistency?.act || report.consistency?.gap) && (
                <View className='page-report__consistency'>
                  {report.consistency?.claim && (
                    <View className='page-report__verdict-row'>
                      <Text className='page-report__verdict-label'>公开说</Text>
                      <Text className='page-report__verdict-text'>{report.consistency.claim}</Text>
                    </View>
                  )}
                  {report.consistency?.act && (
                    <View className='page-report__verdict-row'>
                      <Text className='page-report__verdict-label'>实际做</Text>
                      <Text className='page-report__verdict-text'>{report.consistency.act}</Text>
                    </View>
                  )}
                  {report.consistency?.gap && (
                    <View className='page-report__verdict-row'>
                      <Text className='page-report__verdict-label'>一致性</Text>
                      <Text className='page-report__verdict-text'>{report.consistency.gap}</Text>
                    </View>
                  )}
                </View>
              )}
              <Text className='page-report__entry-foot'>以上为基于公开信息的客观评价，仅供参考，不代表本平台立场。</Text>
            </View>
          )}

          
          {report.profile && (
            <View id='sec-profile' className='card'>
              <View className='card-title'>人物档案</View>
              {report.profile.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的身份信息 —— 指不出出处的信息一律不收录，这一卡宁缺毋滥。
                </Text>
              )}
              {report.profile.length > 0 && (
                <SectionTable
                  columns={['字段', '内容']}
                  rows={profilePreview.rows.map((p) => ({ cells: [p.label, p.value], basis: p.basis }))}
                />
              )}
              {/* S3-3 速览提示：就地写「还有 N 条」（静默少几条等于骗人，见 benefits.ts#REPORT_PREVIEW） */}
              {!!profilePreview.hidden && (
                <Text className='page-report__preview-note' onClick={() => onPromoTap('report_preview')}>
                  {previewHiddenNote(profilePreview.hidden)}
                </Text>
              )}
              <Text className='page-report__entry-foot'>每条档案均出自本报告收录的素材，找不到出处的信息不收录。</Text>
            </View>
          )}

          {/* 人物关系（第二批）：人-人维度。关系必须是素材里明确写到的，
              故这里的依据与档案同规格；四档关系标签一律中性配色，不因「对手」染色。
              ⚠ 标题必须与模板 label（report-toc.ts#sec-relations）逐字一致，用例 69 钉住这一点：
              这一节从「关系图谱」改名为「人物关系」（N-5），因为渲染的是三列表而不是图 ——
              只改一处就会出现「目录叫 A、卡片叫 B」的第二套名字。 */}
          {report.relations && (
            <View id='sec-relations' className='card'>
              <View className='card-title'>人物关系</View>
              {report.relations.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有明确写到的人物关系（不做「同框即关系」一类推测）。
                </Text>
              )}
              {report.relations.length > 0 && (
                <SectionTable
                  columns={['名称', '关系', '说明']}
                  rows={relationsPreview.rows.map((r) => ({
                    cells: [
                      r.name,
                      <Text className='page-report__entry-tag'>{RELATION_META[r.relation] ?? '其他'}</Text>,
                      r.note
                    ],
                    basis: r.basis
                  }))}
                />
              )}
              {!!relationsPreview.hidden && (
                <Text className='page-report__preview-note' onClick={() => onPromoTap('report_preview')}>
                  {previewHiddenNote(relationsPreview.hidden)}
                </Text>
              )}
              <Text className='page-report__entry-foot'>关系出自素材的明确记载，不做「同框即关系」一类推测。</Text>
            </View>
          )}

          
          {lockedIds.has('sec-commercial') && <LockedCard id='sec-commercial' onOpen={() => onPromoTap('report_lock')} />}
          {member && commercial && !report.degraded && (
            <View id='sec-commercial' className='card page-report__vip-card'>
              <View className='card-title'>会员专享 · 商业价值速览</View>
              {/* 商业面结论句（2026-10-12）：把关键数字并成一句读数（近 30 天 N 条报道 · 商业合作 M 项 · 争议 K 条），
                  只并数字、不作评价 —— 与各分项是两个层次（口径见 utils/commercial.ts#CommercialSummary.headline） */}
              {commercial.headline !== '' && (
                <Text className='page-report__cv-headline'>{commercial.headline}</Text>
              )}
              <Text className='page-report__cv-lead'>
                把本报告已收录的素材换个角度汇总：有没有人在报道、媒体怎么写、有没有争议、有哪些具名合作。
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

          {/*
            商业合作与代言（2026-10-12，会员档，取代原「后续关注」）：
            它回答「这个人的商业面是什么样」，紧挨「商业价值速览」（同为商业面）。
            字段在免费批次里生成（utils/report.ts 的 BATCH_SPEC.identity），此处只对会员出卡；
            每条都带出处（指不出素材的条目不落库），故这里可以像档案 / 关系那样给出 basis。
          */}
          {lockedIds.has('sec-endorsement') && <LockedCard id='sec-endorsement' onOpen={() => onPromoTap('report_lock')} />}
          {member && report.endorsements && !report.degraded && (
            <View id='sec-endorsement' className='card page-report__vip-card'>
              <View className='card-title'>会员专享 · 商业合作与代言</View>
              {report.endorsements.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的具名商业合作或代言（只写素材明确写到的，不作推测）。
                </Text>
              )}
              {report.endorsements.length > 0 && (
                <SectionTable
                  columns={['品牌', '类别', '说明']}
                  rows={report.endorsements.map((e) => ({
                    cells: [
                      e.brand,
                      <Text className='page-report__entry-tag'>{ENDORSE_META[e.kind] ?? '其他'}</Text>,
                      e.note
                    ],
                    basis: e.basis
                  }))}
                />
              )}
              <Text className='page-report__entry-foot'>
                只写素材中明确提到的商业合作与代言，不由「同框 / 同场活动」推测。
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
              {/* 两张小图都只用本卡的数据（dynamics），纯 CSS 自绘、不引图表库、不额外取数：
                  免费用户也能看。降级简版整卡不渲染（外层条件），两张图随之消失。 */}
              {monthBuckets.dated >= DYN_CHART_MIN_SAMPLE && (
                <View className='page-report__chart'>
                  <Text className='page-report__chart-title'>报道时间分布</Text>
                  <View className='page-report__bars'>
                    {monthBuckets.all.map(([ym, n]) => (
                      <View key={ym} className='page-report__bar-col'>
                        <Text className='page-report__bar-count'>{n}</Text>
                        <View className='page-report__bar-track'>
                          <View
                            className='page-report__bar'
                            style={{ height: `${Math.round((n / monthBuckets.max) * 100)}%` }}
                          />
                        </View>
                        <Text className='page-report__bar-month'>{ym.slice(5, 7)}月</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
              {sentimentStats && (
                <View className='page-report__chart'>
                  <Text className='page-report__chart-title'>情绪构成</Text>
                  {/* 三段按条数占比铺开，配色沿用「近期动态」逐条情绪标签（__sentiment 三色）。 */}
                  <View className='page-report__sent-bar'>
                    {sentimentStats.positive > 0 && (
                      <View
                        className='page-report__sent-seg page-report__sent-seg--positive'
                        style={{ flex: sentimentStats.positive }}
                      />
                    )}
                    {sentimentStats.neutral > 0 && (
                      <View
                        className='page-report__sent-seg page-report__sent-seg--neutral'
                        style={{ flex: sentimentStats.neutral }}
                      />
                    )}
                    {sentimentStats.negative > 0 && (
                      <View
                        className='page-report__sent-seg page-report__sent-seg--negative'
                        style={{ flex: sentimentStats.negative }}
                      />
                    )}
                  </View>
                  <View className='page-report__sent-legend'>
                    <Text className='page-report__sent-legend-item'>积极 {sentimentStats.positive}</Text>
                    <Text className='page-report__sent-legend-item'>中性 {sentimentStats.neutral}</Text>
                    <Text className='page-report__sent-legend-item'>消极 {sentimentStats.negative}</Text>
                  </View>
                </View>
              )}
              {dynamicsPreview.rows.map((d, i) => {
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
              {!!dynamicsPreview.hidden && (
                <Text className='page-report__preview-note' onClick={() => onPromoTap('report_preview')}>
                  {previewHiddenNote(dynamicsPreview.hidden)}
                </Text>
              )}
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
              {quotesPreview.rows.map((q, i) => {
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
              {!!quotesPreview.hidden && (
                <Text className='page-report__preview-note' onClick={() => onPromoTap('report_preview')}>
                  {previewHiddenNote(quotesPreview.hidden)}
                </Text>
              )}
            </View>
          )}

          {report.degraded && !closedNotices.degraded && (
            <View className='warn-bar'>
              <Text className='warn-bar__text'>
                结构化生成暂不可用，本次为纯文本简版：点评基于模型已有知识，未引用实时素材。
              </Text>
              <NoticeClose onClose={() => closeNotice('degraded')} />
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

          {!report.degraded && (
            <View id='sec-controversies' className='card'>
              <View className='card-title'>近期争议与回应</View>
              {!report.controversies && (
                <Text className='page-report__empty'>
                  这份报告里没有这一段：它生成于「争议与回应」上线之前（或那一版未包含它）。
                  这一段缺数据与「确认没有争议」不是一回事 —— 点上方工具卡的「刷新」可补齐。
                </Text>
              )}
              {report.controversies?.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的公开争议（只有素材真的写到才收录，不把「没看到争议」写成「没有争议」）。
                </Text>
              )}
              {(report.controversies ?? []).map((c, i) => {
                /*
                 * 逐条算「盯没盯上」：比较用的是 normalizeKeyword 归一后的词，与 addWatch 的判定同口径
                 * （否则「A  B」这种多空格会被当成两个不同的词，按钮态就与库里那一行对不上）。
                 */
                const topic = normalizeKeyword(c.topic)
                const watching = watchedKeywords.has(topic)
                return (
                  <View key={`${i}-${c.topic}`} className='page-report__entry'>
                    <Text className='page-report__entry-name'>{c.topic}</Text>
                    <Text className='page-report__entry-text'>争议：{c.claim}</Text>
                    {c.response !== '' && <Text className='page-report__entry-text'>回应：{c.response}</Text>}
                    <Text className='page-report__entry-basis'>依据：{c.basis}</Text>
                    {/*
                      「盯这条进展」（S1-1）：把争议点当监测词，之后抓到新报道时在预警页提醒。
                      排在依据之后 —— 它是对这一条的**延伸动作**，不是这一条的内容本身，
                      得让用户先读完争议，再决定要不要盯。
                    */}
                    {/*
                      提交中（2026-10-18）：授权 / 读库 / 写库期间换成转圈 + 「正在添加…」。
                      这一态**不挂 onClick** —— 加载动画本身就是「别点了」的表达，比再判一次 busy 更直白；
                      只把被点的那一条置忙（`watchBusy === topic`），其余争议条目照常可点。
                    */}
                    {watchBusy === topic ? (
                      <View className='page-report__watch page-report__watch--busy'>
                        <View className='page-report__watch-spin' />
                        <Text>正在添加…</Text>
                      </View>
                    ) : (
                      <View
                        className={`page-report__watch ${watching ? 'page-report__watch--on' : ''}`}
                        onClick={() => void onToggleWatchTopic(c.topic)}
                      >
                        {watching ? '✓ 已盯进展' : '+ 盯这条进展'}
                      </View>
                    )}
                  </View>
                )
              })}
              <Text className='page-report__entry-foot'>
                只记录素材中已公开的争议与回应，平台不作真伪判定，也不做评价。「盯这条进展」是把这条
                争议点当作监测词 —— 之后抓到新报道时，会出现在预警页。
              </Text>
            </View>
          )}

         
          {risk && !report.degraded && (
            <View id='sec-risk' className='card'>
              <View className='card-title'>风险雷达</View>
              {/* 结论句（2026-10-12 用户反馈「能不能给出结论」）：只报「有没有命中」，不评级。
                  分类计数与「未见回应」数拆到下面那排数字胶囊 —— 一句话塞进全部数字，正是上一版读不动的原因。 */}
              <Text className='page-report__risk-headline'>{riskHeadline(risk)}</Text>
              {/* 数字胶囊：类别分布（给条数、不给分档）+ 未见公开回应数 —— 每个数字都能在卡内逐条核对 */}
              {(risk.signals.length > 0 || risk.unanswered > 0) && (
                <View className='page-report__risk-tags'>
                  {RISK_CATEGORIES.filter((c) => risk.byCategory[c] > 0).map((c) => (
                    <Text key={c} className={`page-report__risk-tag page-report__risk-tag--${c}`}>
                      {RISK_CATEGORY_LABEL[c]} {risk.byCategory[c]}
                    </Text>
                  ))}
                  {risk.unanswered > 0 && (
                    <Text className='page-report__risk-tag page-report__risk-tag--statement'>
                      未见回应 {risk.unanswered}
                    </Text>
                  )}
                </View>
              )}
              <Text className='page-report__risk-lead'>{riskScope(risk)}</Text>
              {risk.scanned > 0 && (
                <Text className='page-report__risk-lead'>
                  逐条挑出涉及司法监管 / 税务 / 商业合作 / 名誉维权的字面表述并给出处；平台只陈列素材写法，不作判定，也不作预测。
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
          {lockedIds.has('sec-member') && <LockedCard id='sec-member' onOpen={() => onPromoTap('report_lock')} />}
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
                  P2-12（2026-10-09）：段名从 MEMBER_SECTIONS 派生。原先写死「这三段」，
                  但**给几段由素材决定**（模型按素材给，给不出就不给），承诺三段会当场落空，
                  故改为「这些段落」并一并说明「有几段展示几段」。 */}
              {!report.memberNotes && !report.conflicts && (
                <Text className='page-report__empty'>
                  这份报告生成时没有包含会员段落（可能是免费生成、或较早的缓存）。点上方工具卡的「刷新」，以会员档重新生成，
                  即可得到 {MEMBER_SECTIONS.join('、')} 这些段落 —— 这次补齐不消耗你的每日生成次数。
                  具体给到几段取决于素材：有几段就展示几段，不凑数。
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

          {/*
            同领域坐标（2026-10-12 新增，会员专享）：具名同行 + 具体差异，结构化条目。
            与上方「对比视角」的分工：那段是散文式判断（「与 X 相比更偏 Y」），这一节把它拆成
            可逐条核对的坐标 —— 每条一个具名对象 + 一条落到事实的差异；找不到具名对象或只有
            笼统评价的条目，在数据层（utils/report.ts#sanitizeReport）就已经被整条剔除了。
            与 sec-member 同一套闸门（会员 + 非降级简版），故读到的 report 里通常没有这个键时
            要出「为什么没有」的说明卡，而不是让整卡消失。
          */}
          {lockedIds.has('sec-peers') && <LockedCard id='sec-peers' onOpen={() => onPromoTap('report_lock')} />}
          {member && !report.degraded && (
            <View id='sec-peers' className='card page-report__notes'>
              <View className='card-title'>会员专享 · 同领域坐标</View>
              {(!report.peers || report.peers.length === 0) && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可具名的同领域对象，或模型给不出落到事实的具体差异（只有笼统评价的条目不收录）。
                </Text>
              )}
              {(report.peers ?? []).map((p, i) => (
                <View key={`${i}-${p.name}`} className='page-report__entry'>
                  <View className='page-report__entry-head'>
                    <Text className='page-report__entry-name'>{p.name}</Text>
                  </View>
                  <Text className='page-report__entry-text'>{p.gap}</Text>
                </View>
              ))}
            </View>
          )}

          {/*
            企业关联（2026-10-12 新增，会员专享）：关联企业 / 合作方 / 参股，结构化条目。
            与「人物关系」的分工：那张卡是**人-人**关系而且免费可见，这一节只放**人-机构**关联，
            字段 affiliations 只在会员提示词里出现 —— 每条机构名 + 类别 + 说明 + 出处，
            素材里指不出出处的条目在数据层（utils/report.ts#sanitizeReport）就已被整条剔除。
            与 sec-peers / sec-member 同一套闸门（会员 + 非降级简版），故缺这个键时要出说明卡。
          */}
          {lockedIds.has('sec-affiliation') && <LockedCard id='sec-affiliation' onOpen={() => onPromoTap('report_lock')} />}
          {member && !report.degraded && (
            <View id='sec-affiliation' className='card page-report__vip-card'>
              <View className='card-title'>会员专享 · 企业关联</View>
              {(!report.affiliations || report.affiliations.length === 0) && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有明确写到的关联企业 / 合作方 / 参股（只有同框、同公司这类线索的条目不收录）。
                </Text>
              )}
              {report.affiliations && report.affiliations.length > 0 && (
                <SectionTable
                  columns={['名称', '类别', '说明']}
                  rows={report.affiliations.map((a) => ({
                    cells: [
                      a.name,
                      <Text className='page-report__entry-tag'>{AFFILIATION_META[a.kind] ?? '其他'}</Text>,
                      a.note
                    ],
                    basis: a.basis
                  }))}
                />
              )}
              <Text className='page-report__entry-foot'>机构关联出自素材的明确记载，不做推测。</Text>
            </View>
          )}

          {/* 立场与舆情（2026-10-12 起为会员档）：两块内容（本地统计的情绪走向 + 模型判定的话题
              态度）都可能为空，但卡片本身照出 —— 空的那块写明口径，别让整卡消失。降级简版除外。
              ⚠ 数据仍在**免费批次**里生成（对比页 / 话题速览 / 问答要拿它当上下文，见
                 utils/report-toc.ts 顶部的分档口径），这里只是不再给免费用户出这张卡。 */}
          {lockedIds.has('sec-stance') && <LockedCard id='sec-stance' onOpen={() => onPromoTap('report_lock')} />}
          {member && !report.degraded && (
            <View id='sec-stance' className='card'>
              <View className='card-title'>会员专享 · 立场与舆情</View>
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
                    {sentimentStats.total < SENTIMENT_MIN_SAMPLE
                      ? `基于本报告收录的 ${sentimentStats.total} 条公开动态归类统计 —— 样本不足 ${SENTIMENT_MIN_SAMPLE} 条，上面的比例只作计数读，不足以代表情绪走向；逐条情绪标签见「近期动态」。`
                      : `基于本报告收录的 ${sentimentStats.total} 条公开动态归类统计。`}
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

          {!report.degraded && (
            <View id='sec-timeline' className='card'>
              <View className='card-title'>时间线</View>
              {timelineView.length === 0 && (
                <Text className='page-report__empty'>
                  本次生成时，素材里没有可确认的关键事件。
                </Text>
              )}
              {timelineGroups.map((g, gi) => (
                <View key={gi}>
                  {g.year !== '' && <View className='page-report__timeline-year'>{g.year}</View>}
                  {g.items.map((t, i) => {
                    /*
                     * 刻度是绝对日期 ——「2021-05」离现在多远，用户得自己对着日历算。故日期后面
                     * 补一句相对时间：绝对刻度回答「哪一天」，相对表述回答「多久之前」，两句都在
                     * 才读得出新旧。口径见 utils/time.ts#stampAgo（解析与基准同为 UTC+8）；
                     * 解析不出绝对刻度时返回空串，这一句就不渲染 —— 宁可不写，也不编一个数出来。
                     */
                    const ago = stampAgo(t.date)
                    return (
                      <View key={`${gi}-${i}`} className='page-report__timeline-item'>
                        <View className='page-report__timeline-dot' />
                        <View className='page-report__timeline-body'>
                          <View className='page-report__timeline-meta'>
                            <Text className='page-report__item-date'>{t.date}</Text>
                            {ago !== '' && <Text className='page-report__item-date'>{ago}</Text>}
                          </View>
                          <Text className='page-report__timeline-event'>{t.event}</Text>
                        </View>
                      </View>
                    )
                  })}
                </View>
              ))}
            </View>
          )}

          {/* 名词解释（第二批；2026-10-12 起为会员档）：报告里出现的行话与背景词。摆在这个位置
              是当「页脚工具」用 —— 读到这里遇到没看懂的词，往回翻不如就地查。也是全项目唯一
              不带出处的模型段落（它答的是词义，不是关于本人的事实断言，理由见 utils/report.ts
              的 Schema 注释）。数据仍在免费批次生成，此处只对会员出卡。 */}
          {lockedIds.has('sec-glossary') && <LockedCard id='sec-glossary' onOpen={() => onPromoTap('report_lock')} />}
          {member && report.glossary && (
            <View id='sec-glossary' className='card'>
              <View
                className='page-report__fold-head'
                onClick={() => setDetailOpen((s) => ({ ...s, glossary: !s.glossary }))}
              >
                <View className='card-title'>会员专享 · 名词解释</View>
                <Text className='page-report__fold-arrow'>{detailOpen.glossary ? '收起 ▲' : '展开 ▼'}</Text>
              </View>
              {detailOpen.glossary && (
                <>
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
                </>
              )}
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
            onClick={() => Taro.navigateTo({ url: `/package/compare/index?personKey=${encodeURIComponent(personKey)}` })}
          >
            <Text className='page-report__compare-text'>与另一位名人对比</Text>
            <Text className='page-report__compare-arrow'>→</Text>
          </View>

          {/* 历史版本（S3-1 ③，2026-10-16）：报告是全站共享的一份、刷新即整篇替换，
              「上一次是怎么说的」过去无处可查。与上面的对比条同款（都是一次跳转，不是就地生效），
              且**刻意不在进页时先查一次库**判断「有没有历史版本」—— 那会给每次进报告页都加一次读。
              没有历史时那一页会如实回答「从生成到现在没有被刷新过」，这本身也是把这份报告的
              更新机制讲清楚的地方（共享缓存 → 别人刷新也会覆盖旧版）。 */}
          <View
            className='page-report__compare'
            hoverClass='page-report__compare--tap'
            onClick={() =>
              void Taro.navigateTo({
                url: `/package/report-history/index?personKey=${encodeURIComponent(personKey)}&name=${encodeURIComponent(report ? report.name : '')}`
              })
            }
          >
            <Text className='page-report__compare-text'>历史版本</Text>
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
                  <PersonAvatar
                    personKey={r.personKey}
                    name={r.name}
                    domain={r.domain}
                    className={`page-report__related-avatar page-report__related-avatar--${domainStyleCode(r.domain)}`}
                  />
                  <View className='page-report__related-main'>
                    <Text className='page-report__related-name'>{r.name}</Text>
                    <Text className='page-report__related-words'>{`共同话题：${r.shared.join(' / ')}`}</Text>
                  </View>
                  <Text className='page-report__related-arrow'>→</Text>
                </View>
              ))}
            </View>
          )}

          {/* 同类名人（S1-2，2026-10-16）：上一块的兜底 —— 那边要「共同话题」，
              交集为空就整块不出现，而没收藏过报告的人（绝大多数、尤其新用户）连候选都没有，
              读完报告页尾因此什么都没有。这一块改用**领域**，只要有榜单就取得到人。
              两块共用同一套行样式（同一种东西：接下来读谁），但**不会同时出现**，见上方 effect。 */}
          {peers.length > 0 && (
            <View className='page-report__related'>
              <Text className='page-report__related-head'>同领域的其他名人</Text>
              <Text className='page-report__related-note'>
                按热门榜与已收录报告取同领域名人，仅供延伸阅读；关注后可在「关注动态」页汇总查看
              </Text>
              {peers.map((p) => (
                <View
                  key={p.personKey}
                  className='page-report__related-item'
                  hoverClass='page-report__related-item--tap'
                  onClick={() => Taro.navigateTo({ url: reportSharePath(p.personKey) })}
                >
                  <PersonAvatar
                    personKey={p.personKey}
                    name={p.name}
                    domain={p.domain}
                    className={`page-report__related-avatar page-report__related-avatar--${domainStyleCode(p.domain)}`}
                  />
                  <View className='page-report__related-main'>
                    <Text className='page-report__related-name'>{p.name}</Text>
                    {/* 动态速览可能是一整条标题，故这一行单独做单行省略（见 scss 的 --peer 变体） */}
                    <Text className='page-report__related-words page-report__related-words--peer'>
                      {p.trend !== '' ? p.trend : p.tag}
                    </Text>
                  </View>
                  {/* 关注按钮：必须先吃掉点击，否则点「关注」会连带跳进对方的报告 */}
                  <View
                    className={`page-report__peer-follow${p.followed ? ' page-report__peer-follow--on' : ''}${
                      peerBusy === p.personKey ? ' page-report__peer-follow--busy' : ''
                    }`}
                    hoverClass='page-report__peer-follow--tap'
                    onClick={(e) => {
                      e.stopPropagation()
                      void onTogglePeerFollow(p)
                    }}
                  >
                    {p.followed ? '已关注' : '关注'}
                  </View>
                  <Text className='page-report__related-arrow'>→</Text>
                </View>
              ))}
            </View>
          )}

          {/*
            页脚原有的「收藏报告 / 刷新最新」与两块导出入口已于 2026-10-16 全部上移到首屏
            工具卡（见上方 __tools）：同一份报告的五个动作散在首尾两端，读到一半想收藏 / 导出
            得先滚到底再滚回来。页脚现在只剩免责声明。
          */}

          {/* AI 生成内容免责声明：合规要求必须出现在页面上，不能只藏在可复制的文本里 */}
          <Text className='disclaimer'>{report.disclaimer}</Text>
        </View>
      )}

      {/*
        报告长图弹层：**只在需要时挂载**。组件挂载即出图，常挂会平白请求一次小程序码
        （联网 + 云函数调用），而绝大多数访问并不会导出图。
      */}
      {posterCard && (
        <SharePoster
          title='报告长图'
          hint='图上带结论、依据与出处，页脚带免责与小程序码'
          height={reportCardHeight(posterCard)}
          render={() => renderReportPoster(posterCard)}
          /* 复制摘要与图同源（同一份模型），不另起一套文案 */
          copyText={`${posterCard.name}（${domainLabel(posterCard.domain)}）${posterCard.stats}
${posterCard.headline}
${posterCard.note}`}
          personKey={posterCard.personKey}
          onClose={() => setPosterCard(null)}
        />
      )}
    </View>
  )
}
