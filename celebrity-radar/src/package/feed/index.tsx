import { useEffect, useState } from 'react'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import { View, Text, Input, ScrollView } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import NoticeClose from '@/components/notice-close'
import Skeleton from '@/components/skeleton'
import PersonAvatar from '@/components/person-avatar'
import { listFollows, FollowRow } from '@/utils/follows'
import { getFeedDetails, refreshAllFeeds } from '@/utils/cache'
import { toUserMessage } from '@/utils/error'
import { readPortraits } from '@/utils/portrait'
import { domainLabel, domainStyleCode, parsePersonKey } from '@/config/domains'
import { fromNow, sameDay8 } from '@/utils/time'
import { FEED_PAGE_SIZE, pageSlice } from '@/utils/opinion-access'
import {
  EMPTY_FILTER,
  FeedEntry,
  FeedFilter,
  FeedRange,
  FilterChip,
  RANGE_OPTIONS,
  activeFilterChips,
  applyFeedFilter,
  dedupeFeedItems,
  filterCount,
  groupFeedByDay,
  hiddenByRange,
  loosenHint,
  rangeLabel,
  removeChip,
  sortFeedByDate,
  toggleIn
} from '@/utils/feed-view'
import './index.scss'

/**
 * 今天发布的动态给一枚徽标，让「有没有新东西」一眼可见。
 *
 * P2-36：一律按 UTC+8 判「今天」。以前用 `getMonth()/getDate()`（设备本地）比，
 * 于是同一条动态在不同用户手机上可能一个是「今天」、一个是昨天 —— 徽标本身就是在回答
 * 「这算不算新的」，答案随设备漂移就没有意义了。
 *
 * 分组头（今天/昨天/…）表达的是同一件事，徽标仍保留：往下翻几屏后组头已滚出视野，
 * 此时卡片右侧那枚「今日」是屏幕上唯一还在回答「这是新的吗」的东西。
 */
function isToday(date?: string): boolean {
  if (!date) return false
  return sameDay8(date, Date.now())
}

/** 一轮加载的完整结果（快照与真数据同形状） */
interface FeedSnapshot {
  entries: FeedEntry[]
  follows: FollowRow[]
  failedCount: number
  lastFetchedAt: string | null
  /** 这一轮被合并掉的同源报道条数（见 utils/feed-view.ts#dedupeFeedItems） */
  mergedCount: number
}

/**
 * 上一轮结果，只活在**本次小程序会话的内存里**。
 *
 * 为什么要有它：本页是二级页，用户「发现页 → 某位名人 → 返回 → 关注动态」这样来回切时，
 * 每次 `useDidShow` 都要重新读关注列表 + 各人的动态缓存，于是每进一次都先白一屏骨架屏、
 * 再等一次往返才出内容 —— 这就是「点进去有点慢」的观感。
 * 有快照就先照原样画出来，真数据回来再整体替换；**每次进入仍然重新拉真数据**，
 * 快照只是首帧的底图，不会变成一份停住不更新的旧数据。
 * 只放内存（不落 storage）：跨启动的旧内容没有「抓取于 X」之外的新鲜度提示，不值得留。
 */
let snapshot: FeedSnapshot | null = null

/**
 * 关注动态（原底部菜单第二格，2026-10-07 改为二级页，入口在发现页顶部）。
 * 本页不再挂 tab 高亮，也不需要 tabBar 底部占位（safe-tab）。
 *
 * 2026-10-15 重设计——「搜索 ∧ 筛选」合成一个动作、列表按时间分组：
 *   旧版把搜索框、统计双列、人物下拉、领域下拉、抓取按钮、新鲜度脚注六块一起塞进顶卡，
 *   彼此没有主次；用户要先用眼睛扫一遍才知道哪个控件管什么。现在一屏只剩三层：
 *   **工具行（搜索 + 筛选）→ 条件回显 chips → 分组列表**，低频的「抓取动态」从独占一行的
 *   大按钮降级为摘要行右侧的小动作（下拉刷新仍是同一条路径）。
 *
 *   搜索与筛选之所以要合并到同一行：在用户心里它们本就是**同一个问题** ——「怎样让我想看的
 *   那几条浮上来」。分散两处时，输完关键词才发现还得去另一边选人，就得在两个控件之间来回试；
 *   合并之后已生效的条件以 chips 回显在同一行，「现在生效了什么」和「还能加什么」都在一处完成。
 */
export default function Feed() {
  /* 初值直接取会话快照（见 snapshot 注释）：重进本页时首帧就是上次的内容，不再白一屏 */
  const [loading, setLoading] = useState(snapshot === null)
  const [entries, setEntries] = useState<FeedEntry[]>(snapshot?.entries ?? [])
  const [follows, setFollows] = useState<FollowRow[]>(snapshot?.follows ?? [])
  /** 读失败的关注人数：>0 时结果不完整，必须显式告知，不能当成「暂无动态」 */
  const [failedCount, setFailedCount] = useState(snapshot?.failedCount ?? 0)
  /** 所有关注人里最近一次抓取时间，用于表达数据新鲜度 */
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(snapshot?.lastFetchedAt ?? null)
  /** 本轮被合并掉的同源报道条数（>0 时页面要如实说出来，不能让条目无声少几条） */
  const [mergedCount, setMergedCount] = useState(snapshot?.mergedCount ?? 0)
  /**
   * 筛选条件（人物多选 / 领域多选 / 时间档位），默认 `EMPTY_FILTER` = 不筛。
   *
   * 三组条件合并成**一个对象**而不是三个 state：它们总是一起参与过滤、一起被重置。
   * 分成三个 state 就得每次过滤读三处、清空时写三处 —— 漏写一处就会留下一个「看不见的
   * 筛选」：用户对着空列表，而 chips 行上什么都没显示。
   */
  const [filter, setFilter] = useState<FeedFilter>(EMPTY_FILTER)
  /** 搜索关键词（标题 / 摘要 / 人名模糊匹配，忽略大小写），空 = 不搜索 */
  const [query, setQuery] = useState('')
  /** 筛选面板（底部弹层）是否展开 */
  const [panelOpen, setPanelOpen] = useState(false)
  /** 正在联网抓取：按钮置灰并换文案，防连点（抓取一次要花一次当日配额） */
  const [fetching, setFetching] = useState(false)
  /**
   * 「部分读取失败」提示条是否被用户关掉（2026-10-10，需求：提示框都要有关闭按钮）。
   * 每次 load 复位：失败人数可能每轮都不同，本轮的新结果必须能被看到。
   */
  const [noticeClosed, setNoticeClosed] = useState(false)
  /**
   * 当前页号（从 1 起）—— 关注动态是**客户端分段渲染**：
   * 数据一次取回全部（见 load 注释），分页只是「按页切片渲染」，触底时 `page+1` 追加下一批。
   *
   * ⚠ **不是任何一次重读都重置页号**（2026-10-13 修「返回即回顶」）：从本页点进某位名人
   * （`package/profile`）再返回时，`useDidShow` 会 `load` 重取数据 —— 若此时把页号重置回 1，
   * 用户之前翻到的位置就丢了。故只有**显式重取**（下拉刷新 / 抓取动态按钮）与**切换筛选**才回到
   * 第一页；从子页返回的重读**保留页号**（数据仍照常刷新，见 `load` 的 `resetPage`）。
   */
  const [page, setPage] = useState(1)

  /**
   * 重读列表。
   *
   * `withSkeleton` 只在**首次进入 / 重试**时为 true：抓到新数据后再重读若还盖一层骨架屏，
   * 会把刚看到的内容整页闪掉（用户点了「抓取动态」，画面先白一下再回来）。
   *
   * `resetPage` 只在**显式重取数据**（下拉刷新 / 抓取动态）时为 true —— 从子页返回（`useDidShow`）
   * 也走本函数重取数据（**数据一定刷新**），但**保留页号**，不把用户顶回第一页。
   */
  const load = async (withSkeleton = true, resetPage = false) => {
    if (withSkeleton) setLoading(true)
    if (resetPage) setPage(1)
    try {
      const rows = await listFollows()
      setFollows(rows)

      /*
       * 归并：所有关注人的 feed_cache → 统一列表，按时间倒序。
       *
       * 一次 `in` 查询取回全部人的缓存行（见 cache.ts#getFeedDetails）：此前是每人一路
       * 云数据库请求并行发，关注十几位就是十几路在飞 —— 页面能进，但内容要等这一批回来。
       * 成批之后只多几次分页，且顺序由 follows 决定（不再依赖并发完成顺序）。
       */
      const details = await getFeedDetails(rows.map((f: FollowRow) => f.person_key))
      const all: FeedEntry[] = []
      let failed = 0
      let latest: string | null = null

      for (const f of rows) {
        const detail = details.get(f.person_key)
        if (!detail || !detail.ok) failed++
        if (detail?.fetchedAt && (!latest || detail.fetchedAt > latest)) latest = detail.fetchedAt
        const parsed = parsePersonKey(f.person_key)
        for (const it of detail?.items ?? []) {
          all.push({
            ...it,
            personKey: f.person_key,
            personName: f.name,
            domain: parsed?.domain ?? 'other'
          })
        }
      }

      /*
       * 先排序再去重：去重是「同一人的同一件事只留一条」，保留先出现的那条 ——
       * 排序保证先出现的就是最新的那条（否则留下的可能是三天前的那篇转载）。
       *
       * 去重必须在**归并之后、分页之前**做：它是列表内容的一部分；若挪到渲染时再做，
       * 分页条数会按去重前的数据算，页面上的「还有 N 条」就对不上了。
       */
      all.sort(sortFeedByDate)
      const deduped = dedupeFeedItems(all)

      setFailedCount(failed)
      setLastFetchedAt(latest)
      setMergedCount(deduped.merged)
      setEntries(deduped.items)
      snapshot = {
        entries: deduped.items,
        follows: rows,
        failedCount: failed,
        lastFetchedAt: latest,
        mergedCount: deduped.merged
      }
    } finally {
      /*
       * 收尾放 finally：抛出时也必须把 loading 收掉。
       * 留在 true 的后果是整页停在骨架屏上 —— 看起来正是「页面坏了」，而不是「这次没读到」。
       */
      setLoading(false)
      /* 新一轮结果：上一轮「已关」的记忆作废（见 noticeClosed 注释） */
      setNoticeClosed(false)
    }
  }

  useDidShow(() => {
    /* 重进本页（含从子页返回）：重取数据但**保留页号**（不重置），避免「返回即回顶」。
       有快照 = 首帧已经有内容，就别再盖一层骨架屏（那才是「进页面先白一下」的来源） */
    void load(snapshot === null)
  })

  /**
   * 抓取动作本体（「抓取动态」按钮与下拉刷新**共用同一条路径**）。
   *
   * 共用而不是各写一份：两者都是「花一次配额，联网抓一轮，然后重读列表」；
   * 分开写迟早会出现只有一边做了配额检查、或只有一边重读了缓存这类分叉。
   *
   * ⚠ 两者都是**显式重取数据**，故重读时 `resetPage = true`（回到第一页）—— 与「从子页返回」
   *   的重读（保留页号）区分开。
   */
  const doFetch = async (): Promise<string> => {
    /* 关注名单以现场读到的为准：本页停留期间可能刚在别的页取关过 */
    const rows = follows.length > 0 ? follows : await listFollows()
    if (rows.length === 0) return '还没有关注名人，先去关注几位'
    const res = await refreshAllFeeds(rows)
    await load(false, true)
    return res.message
  }

  const onFetch = async () => {
    if (fetching) return
    setFetching(true)
    Taro.showLoading({ title: '正在抓取…', mask: true })
    let message = ''
    try {
      message = await doFetch()
    } catch (err) {
      message = toUserMessage(err, '抓取失败，请稍后重试')
    }
    /* 先收 loading 再弹 toast：同属一个交互层，顺序反了会把刚弹的 toast 一起收掉 */
    Taro.hideLoading()
    setFetching(false)
    Taro.showToast({ title: message, icon: 'none', duration: 2000 })
  }

  usePullDownRefresh(async () => {
    let message = ''
    try {
      message = await doFetch()
    } catch (err) {
      message = toUserMessage(err, '抓取失败，请稍后重试')
    }
    /* 先收起原生下拉指示器再弹 toast：反了会被下拉的收束动画盖掉半截 */
    Taro.stopPullDownRefresh()
    Taro.showToast({ title: message, icon: 'none', duration: 2000 })
  })

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/package/profile/index?personKey=${encodeURIComponent(personKey)}` })
  }

  /* 真图预热：关注流一屏多条动态（同一人可能多条），一次批量读把这些人的头像拉进缓存（按全量 entries，不分页） */
  useEffect(() => {
    const keys = Array.from(new Set(entries.map((e) => e.personKey)))
    if (keys.length > 0) void readPortraits(keys)
  }, [entries])

  /*
   * 本次渲染的「现在」。只取一次并往下传：同一帧里分组与筛选若各取一次 Date.now()，
   * 恰好跨过午夜时同一条动态可能被分到「今天」又被时间档判成「昨天」。
   */
  const now = Date.now()

  /*
   * 当前筛选下的**全部**条目：它是分页的输入，也是「符合 N 条」用来表达总规模的依据。
   *
   * 四把筛子（人物 / 领域 / 时间 / 关键词）如何叠加，全部在 utils/feed-view.ts 里 ——
   * 叠加顺序、读不出日期怎么办、无结果时给什么出口，都是可测的纯函数；本页只管画。
   */
  const visible = applyFeedFilter(entries, filter, query, now)

  const chipCount = filterCount(filter)
  const chips = activeFilterChips(filter)
  /** 被时间档挡住、其余条件都相符的条目数（页面要如实说明「另有 N 条缺少发布日期」） */
  const rangeHidden = hiddenByRange(entries, filter, query, now)

  /*
   * 客户端分段渲染：首屏只渲染第一页，触底追加下一页（每页 FEED_PAGE_SIZE 条，见该常量注释）。
   * 为什么是「切片渲染」而非「真分页」：数据一次取回全部（load 里 getFeedDetails 一次 in 查询），
   * 每页只是把已到手的一维列表切一段出来 —— **没有真实网络加载**，故页面**不伪造 loading**，
   * 只如实显示「还有 N 条」与到底文案。
   */
  const paged = pageSlice(visible, page, FEED_PAGE_SIZE)

  /* 触底加载更多：还有下一页才前进一页；到底则不动（不追加、不触发任何请求） */
  useReachBottom(() => {
    setPage((p) => (p * FEED_PAGE_SIZE < visible.length ? p + 1 : p))
  })

  /*
   * 时间分组：把「今天 / 昨天 / 近 7 天 / …」的归属算成两张表 ——
   * `groupOf`（条目 → 组 key）供渲染时判断「这一条是不是该组的第一条（要不要插组头）」，
   * `groupMeta`（组 key → 标签与**该组全量条数**）供组头显示条数。
   *
   * 组头条数取全量而不是「已渲染条数」：首屏只渲染第一页，若组头跟着切片走，
   * 用户会以为「今天只有 2 条」，而实际上只是还没往下翻。
   */
  const groups = groupFeedByDay(visible, now)
  const groupOf = new Map<FeedEntry, string>()
  const groupMeta = new Map<string, { label: string; total: number }>()
  for (const g of groups) {
    groupMeta.set(g.key, { label: g.label, total: g.items.length })
    for (const it of g.items) groupOf.set(it, g.key)
  }
  /** 该条所在组的标签；查不到返回空串（不编造分组名） */
  const groupLabelOf = (e: FeedEntry): string => groupMeta.get(groupOf.get(e) ?? '')?.label ?? ''
  /** 该条所在组的全量条数 */
  const groupTotalOf = (e: FeedEntry): number => groupMeta.get(groupOf.get(e) ?? '')?.total ?? 0

  /* 领域候选：从已抓到的动态里现取（不预置固定表——2026-10-12 领域已自由化，预置表会漏掉新领域） */
  const domains = Array.from(new Set(entries.map((e) => e.domain))).sort()

  /* 每位关注人的动态条数（筛选面板的人物 chips 上标条数，让「谁在刷屏」在选择前就可见） */
  const countByPerson = new Map<string, number>()
  for (const e of entries) countByPerson.set(e.personKey, (countByPerson.get(e.personKey) ?? 0) + 1)

  /* ------------------------------ 筛选动作 ------------------------------ */

  /*
   * 每个筛选动作都**自带 setPage(1)**，不抽一层公共包装：
   * 页号是「在第 N 页」这个位置记忆，而换掉一批内容之后第 N 页很可能直接是空的
   * （从 300 条筛到 5 条），用户看到的就是「筛完一片空白」。
   * 逐个写死这行比抽包装更难漏 —— 漏掉的那次不会报错，只在特定页号上表现为空白。
   */

  /** 人物多选（筛选面板里的人物 chips；这个名字沿用旧版，页面与用例都在用它） */
  const onFilterChange = (personKey: string) => {
    setFilter({ ...filter, persons: toggleIn(filter.persons, personKey) })
    setPage(1)
  }

  /** 领域多选 */
  const onDomainFilterChange = (domain: string) => {
    setFilter({ ...filter, domains: toggleIn(filter.domains, domain) })
    setPage(1)
  }

  /** 时间档位（单选；点「全部时间」即松开这一档） */
  const onRangeChange = (range: FeedRange) => {
    setFilter({ ...filter, range })
    setPage(1)
  }

  /** 摘掉一个生效条件（chips 行上每个标签右侧的 ×） */
  const dropChip = (chip: FilterChip) => {
    setFilter(removeChip(filter, chip))
    setPage(1)
  }

  /**
   * 清空全部条件与关键词。
   * 只改条件、**不动页号** —— 两个调用点（chips 行的「清空」与空态的「查看全部」）
   * 各自紧跟一句 `setPage(1)`，页号变化在调用处一眼可见。
   */
  const resetFilter = () => {
    setQuery('')
    setFilter(EMPTY_FILTER)
  }

  /** 生效条件的中文标签：时间查档位表、领域查领域表、人物查关注名单（查不到就用 key 本身） */
  const chipLabel = (chip: FilterChip): string => {
    if (chip.kind === 'range') return rangeLabel(chip.value as FeedRange)
    if (chip.kind === 'domain') return domainLabel(chip.value)
    return follows.find((f) => f.person_key === chip.value)?.name ?? chip.value
  }

  /* ------------------------------ 空态出口 ------------------------------ */

  /*
   * 「筛到一条不剩」和「本来就没有动态」是两件事，出口也必须不同：
   *   · 前者是本页自己的筛选造成的 → 告诉用户松开哪一项能多看几条（纯函数算出来的具体数字）；
   *   · 后者是数据源就是这样 → 引导他去抓取或去关注名人。
   * 把它们混成一句「暂无动态」，用户会以为是产品没内容，而不是自己刚设的条件太紧。
   */
  const filterCauseEmpty = entries.length > 0 && visible.length === 0
  const loosen = filterCauseEmpty ? loosenHint(entries, filter, query, now) : ''

  return (
    <View className='page-feed glow-page'>
      {loading && <Skeleton variant='feed' rows={3} withStats />}

      {/* ── 第一层：工具行。搜索框与「筛选」按钮并排 —— 两者在用户心里是同一个动作 ── */}
      {!loading && (
        <View className='card page-feed__panel'>
          <View className='page-feed__toolbar'>
            <View className='page-feed__search'>
              <Text className='page-feed__search-icon'>🔍</Text>
              <Input
                className='page-feed__search-input'
                type='text'
                value={query}
                confirmType='search'
                placeholder='搜索动态 / 人名'
                onInput={(e) => {
                  setQuery(String(e.detail.value ?? ''))
                  setPage(1)
                }}
              />
              {query !== '' && (
                <Text
                  className='page-feed__search-clear'
                  onClick={() => {
                    setQuery('')
                    setPage(1)
                  }}
                >
                  ✕
                </Text>
              )}
            </View>
            <View
              className={`page-feed__filter${chipCount > 0 ? ' page-feed__filter--on' : ''}`}
              hoverClass='page-feed__filter--tap'
              onClick={() => setPanelOpen(true)}
            >
              <Text className='page-feed__filter-text'>筛选</Text>
              {/* 角标 = 生效条件个数，筛选按钮与 chips 行永远对得上 */}
              {chipCount > 0 && <Text className='page-feed__filter-badge'>{chipCount}</Text>}
            </View>
          </View>

          {/* ── 第二层：生效条件回显。条件都落在这行 chips 上，摘掉一个不用回面板 ── */}
          {chips.length > 0 && (
            <View className='page-feed__chips'>
              {chips.map((c) => (
                <View className='page-feed__chip' key={`${c.kind}-${c.value}`} onClick={() => dropChip(c)}>
                  <Text className='page-feed__chip-text'>{chipLabel(c)}</Text>
                  <Text className='page-feed__chip-x'>✕</Text>
                </View>
              ))}
              <Text
                className='page-feed__chips-clear'
                onClick={() => {
                  resetFilter()
                  setPage(1)
                }}
              >
                清空
              </Text>
            </View>
          )}

          {/* ── 规模 / 新鲜度 / 抓取动作：抓取是低频动作，从独占一行的大按钮降级到这里 ── */}
          <View className='page-feed__summary'>
            <Text className='page-feed__summary-text'>
              关注 {follows.length} 人 · 共 {entries.length} 条
            </Text>
            {chipCount > 0 && <Text className='page-feed__summary-match'>符合 {visible.length} 条</Text>}
            <View
              className={`page-feed__fetch${fetching ? ' page-feed__fetch--busy' : ''}`}
              hoverClass='page-feed__fetch--tap'
              onClick={() => void onFetch()}
            >
              {fetching ? '抓取中…' : '抓取动态'}
            </View>
          </View>
          <Text className='page-feed__panel-note'>
            {lastFetchedAt ? `抓取于 ${fromNow(lastFetchedAt)}` : '尚未抓取过动态'} · 每日限 10 次
          </Text>
        </View>
      )}

      {/* ── 部分读取失败：结果不完整，必须显式告知；整条可点重试，✕ 只负责关掉 ── */}
      {!loading && failedCount > 0 && !noticeClosed && (
        <View className='page-feed__notice' hoverClass='page-feed__notice--tap' onClick={() => void load(false, true)}>
          <Text className='page-feed__notice-text'>
            有 {failedCount} 位名人的动态没能读到，列表里缺少他们的内容，点此重试
          </Text>
          <NoticeClose onClose={() => setNoticeClosed(true)} />
        </View>
      )}

      {/* ── 空态（一）：确实没有内容。出口是「去关注」或「去抓取」，不是让他反复刷新 ── */}
      {!loading && entries.length === 0 && failedCount === 0 && (
        <EmptyState
          icon='🔔'
          title='还没有可看的动态'
          desc={
            follows.length === 0
              ? '先去发现页关注几位名人，这里会汇总他们最近的公开动态'
              : '点上方「抓取动态」联网检索最新动态（每日限 10 次），也可以下拉刷新'
          }
          actionText={follows.length === 0 ? '去发现名人' : '抓取动态'}
          onAction={() => {
            if (follows.length === 0) {
              Taro.switchTab({ url: '/pages/index/index' })
              return
            }
            void onFetch()
          }}
        />
      )}

      {/* ── 空态（二）：筛到一条不剩。desc 由 loosenHint 算出「松开哪一项能多看几条」 ── */}
      {!loading && filterCauseEmpty && (
        <EmptyState
          icon='🔍'
          title='没有符合条件的动态'
          desc={loosen}
          actionText='查看全部'
          onAction={() => {
            resetFilter()
            setPage(1)
          }}
        />
      )}

      {/* ── 第三层：分组列表。首屏只渲染第一页，触底追加（页号保留语义见 load 注释） ── */}
      {!loading && entries.length > 0 && !filterCauseEmpty && (
        <View>
          {paged.rows.map((e, i) => {
            /*
             * 组头插在**每组第一条之前**：与上一条分组不同，说明这里是新组的开头。
             * 分页切片是「按扁平顺序累计」的，所以只在切片内判断组边界即可 ——
             * 第二页的第一条若是昨天的第一条，它的组头照样会出现。
             */
            const prev = i > 0 ? paged.rows[i - 1] : undefined
            const head = i === 0 || groupOf.get(prev ?? e) !== groupOf.get(e)
            return (
              <View key={`${e.personKey}-${e.url || i}`}>
                {head && (
                  <View className='section-head'>
                    <Text className='section-head__title'>{groupLabelOf(e)}</Text>
                    {/* 条数取该组**全量**（不是已渲染的那一页），理由见 groupMeta 注释 */}
                    <Text className='section-head__extra'>{groupTotalOf(e)} 条</Text>
                  </View>
                )}
                <View className='card page-feed__item' onClick={() => openPerson(e.personKey)}>
                  <View className='page-feed__item-head'>
                    <View className='page-feed__item-person'>
                      <PersonAvatar
                        personKey={e.personKey}
                        name={e.personName}
                        domain={e.domain}
                        className={`page-feed__item-icon page-feed__item-icon--${domainStyleCode(e.domain)}`}
                      />
                      <View className='page-feed__item-person-info'>
                        <Text className='page-feed__item-name'>{e.personName}</Text>
                        <Text className='page-feed__item-domain'>
                          {domainLabel(e.domain)} · {e.source}
                        </Text>
                      </View>
                    </View>
                    <View className='page-feed__item-meta'>
                      {isToday(e.publishedDate) && <Text className='page-feed__item-today'>今日</Text>}
                      <Text className='page-feed__item-date'>{e.publishedDate?.slice(0, 10) ?? '近期'}</Text>
                    </View>
                  </View>
                  <View className='page-feed__item-title'>{e.title}</View>
                  <View className='text-secondary page-feed__item-summary'>{e.content}</View>
                  <View className='page-feed__item-foot'>
                    <Text
                      className='page-feed__copy'
                      onClick={(ev) => {
                        ev.stopPropagation?.()
                        Taro.setClipboardData({ data: e.url })
                      }}
                    >
                      复制原文链接
                    </Text>
                  </View>
                </View>
              </View>
            )
          })}

          {/* 缺日期 = 被时间档挡掉的那些。不写这句，用户只会觉得「我的动态怎么少了」 */}
          {rangeHidden > 0 && (
            <Text className='page-feed__hint'>
              另有 {rangeHidden} 条动态缺少发布日期，未计入当前时间范围
            </Text>
          )}

          {/* 合并了多少条也如实说：条目数比抓回来的少了，得有个交代 */}
          {mergedCount > 0 && (
            <Text className='page-feed__hint'>已合并 {mergedCount} 条同源报道（同一件事只留最新一条）</Text>
          )}

          {/* 触底加载更多的状态行：切片渲染没有真实网络加载，故不伪造 loading，
              只如实区分「还有 N 条（触底会追加）」与「到底」。 */}
          <Text className='page-feed__foot'>
            {paged.hasMore ? `上滑加载更多（还有 ${paged.remaining} 条）…` : '—— 没有更多动态 ——'}
          </Text>

          <View className='disclaimer'>动态内容来自公开网络检索，由 AI 整理，仅供参考</View>
        </View>
      )}

      {/* ── 筛选面板（底部弹层）：三组条件，与 chips 行是同一份状态的两种视图 ──
          浮层必须挂 `glow-overlay`（见 app.scss）：根容器带 `.glow-page`，它的 `> view` 把
          直接子级按成 `position: relative; z-index: 1`，本层的 `position: fixed` 会被盖掉 ——
          面板会被按回文档流、被正文压住。`catchMove` 顺手挡住面板后面的列表跟着滚。 ── */}
      {panelOpen && (
        <View className='page-feed__mask-layer glow-overlay' catchMove>
          <View className='page-feed__mask' onClick={() => setPanelOpen(false)} />
          <View className='page-feed__sheet'>
            <View className='page-feed__sheet-head'>
              <Text className='page-feed__sheet-title'>筛选动态</Text>
              {/* 「完成」而不是 ✕：这里选完不需要「提交」，改动即时生效，✕ 会让人以为改动被取消了 */}
              <Text className='page-feed__sheet-close' onClick={() => setPanelOpen(false)}>
                完成
              </Text>
            </View>

            <ScrollView className='page-feed__sheet-body' scrollY>
              <View className='page-feed__group'>
                <Text className='page-feed__group-title'>时间</Text>
                <View className='page-feed__opts'>
                  {RANGE_OPTIONS.map((o) => (
                    <View
                      className={`page-feed__opt${filter.range === o.value ? ' page-feed__opt--on' : ''}`}
                      key={o.value}
                      onClick={() => onRangeChange(o.value)}
                    >
                      {o.label}
                    </View>
                  ))}
                </View>
              </View>

              {follows.length > 0 && (
                <View className='page-feed__group'>
                  <Text className='page-feed__group-title'>
                    人物{filter.persons.length > 0 ? `（已选 ${filter.persons.length}）` : ''}
                  </Text>
                  <View className='page-feed__opts'>
                    {follows.map((f) => (
                      <View
                        className={`page-feed__opt${filter.persons.includes(f.person_key) ? ' page-feed__opt--on' : ''}`}
                        key={f.person_key}
                        onClick={() => onFilterChange(f.person_key)}
                      >
                        {/* 标条数：谁在刷屏在选择之前就看得见，不必先选上看一眼再取消 */}
                        {f.name} · {countByPerson.get(f.person_key) ?? 0}
                      </View>
                    ))}
                  </View>
                </View>
              )}

              {domains.length > 0 && (
                <View className='page-feed__group'>
                  <Text className='page-feed__group-title'>领域</Text>
                  <View className='page-feed__opts'>
                    {domains.map((d) => (
                      <View
                        className={`page-feed__opt${filter.domains.includes(d) ? ' page-feed__opt--on' : ''}`}
                        key={d}
                        onClick={() => onDomainFilterChange(d)}
                      >
                        {domainLabel(d)}
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </ScrollView>

            <View className='page-feed__sheet-foot'>
              <View
                className='page-feed__sheet-reset'
                hoverClass='page-feed__sheet-reset--tap'
                onClick={() => {
                  resetFilter()
                  setPage(1)
                }}
              >
                重置
              </View>
              <View
                className='page-feed__sheet-apply'
                hoverClass='page-feed__sheet-apply--tap'
                onClick={() => setPanelOpen(false)}
              >
                查看 {visible.length} 条结果
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}
