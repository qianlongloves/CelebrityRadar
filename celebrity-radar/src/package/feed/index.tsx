import { useEffect, useState } from 'react'
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from '@tarojs/taro'
import { View, Text, Input, Picker } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import NoticeClose from '@/components/notice-close'
import Skeleton from '@/components/skeleton'
import PersonAvatar from '@/components/person-avatar'
import { listFollows, FollowRow } from '@/utils/follows'
import { getFeedDetails, refreshAllFeeds } from '@/utils/cache'
import { readPortraits } from '@/utils/portrait'
import { NewsItem } from '@/utils/search'
import { domainLabel, domainStyleCode, parsePersonKey } from '@/config/domains'
import { fromNow, sameDay8 } from '@/utils/time'
import { FEED_PAGE_SIZE, pageSlice } from '@/utils/opinion-access'
import './index.scss'

/** 流条目：新闻 + 归属人 */
interface FeedEntry extends NewsItem {
  personKey: string
  personName: string
  /** 领域（自由短串，2026-10-12 领域自由化） */
  domain: string
}

function sortByDate(a: FeedEntry, b: FeedEntry): number {
  const ta = a.publishedDate ? Date.parse(a.publishedDate) : 0
  const tb = b.publishedDate ? Date.parse(b.publishedDate) : 0
  return tb - ta
}

/**
 * 今天发布的动态给一枚徽标，让「有没有新东西」一眼可见。
 *
 * P2-36：一律按 UTC+8 判「今天」。以前用 `getMonth()/getDate()`（设备本地）比，
 * 于是同一条动态在不同用户手机上可能一个是「今天」、一个是昨天 —— 徽标本身就是在回答
 * 「这算不算新的」，答案随设备漂移就没有意义了。
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
  /** 按人物筛选，'' = 全部 */
  const [personFilter, setPersonFilter] = useState('')
  /** 搜索关键词（标题 / 摘要 / 人名模糊匹配，忽略大小写），空 = 不搜索 */
  const [query, setQuery] = useState('')
  /** 按领域筛选（自由短串，2026-10-12 领域自由化），'' = 全部领域 */
  const [domainFilter, setDomainFilter] = useState('')
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
   * （`pages/profile`）再返回时，`useDidShow` 会 `load` 重取数据 —— 若此时把页号重置回 1，
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
      const merged: FeedEntry[] = []
      let failed = 0
      let latest: string | null = null

      for (const f of rows) {
        const detail = details.get(f.person_key)
        if (!detail || !detail.ok) failed++
        if (detail?.fetchedAt && (!latest || detail.fetchedAt > latest)) latest = detail.fetchedAt
        const parsed = parsePersonKey(f.person_key)
        for (const it of detail?.items ?? []) {
          merged.push({
            ...it,
            personKey: f.person_key,
            personName: f.name,
            domain: parsed?.domain ?? 'other'
          })
        }
      }

      merged.sort(sortByDate)
      setFailedCount(failed)
      setLastFetchedAt(latest)
      setEntries(merged)
      snapshot = { entries: merged, follows: rows, failedCount: failed, lastFetchedAt: latest }
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
   * 共用而不是各写一份：两者都是「花一次配额，联网抓一轮，然后重读列表」，
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
      message = `抓取失败：${err instanceof Error ? err.message : String(err)}`
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
      message = `抓取失败：${err instanceof Error ? err.message : String(err)}`
    }
    /* 先收起原生下拉指示器再弹 toast：反了会被下拉的收束动画盖掉半截 */
    Taro.stopPullDownRefresh()
    Taro.showToast({ title: message, icon: 'none', duration: 2000 })
  })

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/package/profile/index?personKey=${encodeURIComponent(personKey)}` })
  }

  /* 真图预热：关注流一屏多条动态（同一人可能多条），去重后一次批量读把这些人拉进缓存（按全量 entries，不分页） */
  useEffect(() => {
    const keys = Array.from(new Set(entries.map((e) => e.personKey)))
    if (keys.length > 0) void readPortraits(keys)
  }, [entries])

  /*
   * 当前筛选下的**全部**条目：它是分页的输入，也是头部「N 条」用来表达总规模的依据。
   *
   * 2026-10-14 叠加三把筛子（人物 / 领域 / 搜索关键词），逐层过滤：
   * 人物与领域是精确匹配，搜索是标题 / 摘要 / 人名三处的忽略大小写模糊匹配。
   * 三把筛子都设在**本地内存**上（数据一次取回，见 load 注释），不额外发请求。
   */
  const q = query.trim().toLowerCase()
  const visible = entries.filter((e) => {
    if (personFilter && e.personKey !== personFilter) return false
    if (domainFilter && e.domain !== domainFilter) return false
    if (q && !`${e.title} ${e.content} ${e.personName}`.toLowerCase().includes(q)) return false
    return true
  })
  const filterName = follows.find((f) => f.person_key === personFilter)?.name ?? ''

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

  /* 每个人物的动态条数：下拉选项与「全部（N）」计数都用它（按全量 entries，不受分页影响） */
  const countByPerson: Record<string, number> = {}
  for (const e of entries) countByPerson[e.personKey] = (countByPerson[e.personKey] ?? 0) + 1

  /*
    下拉筛选项：0 号固定为「全部」，其余按关注顺序一一对应 follows。
    选项文本带上条数，替掉此前横向芯片里的「名字 N」——筛选从「一排芯片逐个点」
    收成一个下拉，关注几十位时差别尤其明显（芯片那排要横向滑半天才能找到人）。
  */
  const filterLabels = [
    `全部（${entries.length}）`,
    ...follows.map((f) => `${f.name}（${countByPerson[f.person_key] ?? 0}）`)
  ]
  const filterIndex = personFilter ? follows.findIndex((f) => f.person_key === personFilter) + 1 : 0

  /** 下拉筛选：0 号为「全部」，其余映射回 follows 的 person_key（越界一律回落全部） */
  const onFilterChange = (e: { detail: { value: string | number } }) => {
    const idx = Number(e.detail.value)
    setPersonFilter(idx > 0 ? follows[idx - 1]?.person_key ?? '' : '')
    /* 切换筛选后回到第一页：否则从「全部」的第 3 页切到某人时只接着渲染那人的第 3 页，看起来像「只剩一批」 */
    setPage(1)
  }

  /*
   * 领域筛选项（2026-10-14 新增）：从**当前关注人实际出现过的领域**去重而来，而非写死 12 个。
   * 领域自 2026-10-12 起是自由短串，写死枚举会漏掉自创领域；从 entries 现取则永远与数据一致，
   * 且关注的人若只跨两三个领域，下拉也不会塞一堆永远筛不中的选项。
   */
  const domains = Array.from(new Set(entries.map((e) => e.domain)))
  const domainFilterLabels = ['全部领域', ...domains.map((d) => domainLabel(d))]
  const domainFilterIndex = domainFilter ? domains.indexOf(domainFilter) + 1 : 0

  /** 领域下拉：0 号为「全部领域」，其余映射回 domains 的原始领域串（越界一律回落全部） */
  const onDomainFilterChange = (e: { detail: { value: string | number } }) => {
    const idx = Number(e.detail.value)
    setDomainFilter(idx > 0 ? domains[idx - 1] ?? '' : '')
    setPage(1)
  }

  /** 搜索输入：实时过滤并回到第一页（避免在第 N 页上输入后只见残留的一两条） */
  const onSearch = (e: { detail: { value: string } }) => {
    setQuery(e.detail.value)
    setPage(1)
  }

  /** 清空搜索：同样回到第一页 */
  const clearSearch = () => {
    setQuery('')
    setPage(1)
  }

  return (
    <View className='page-feed glow-page'>
      {loading && <Skeleton variant='feed' rows={3} withStats />}

      {/*
        顶部聚合卡（2026-10-10 重排）：已关注 / 近期动态两组统计 + 下拉筛选 + 抓取按钮，
        全部收进同一张卡里。

        此前它们是三块彼此分离的部件：统计双列卡、抓取行、以及列表上方那排横向筛选芯片，
        用户要在页面上下几个区块之间来回找；现在合成一格，信息与动作各归其位、一眼看全。

        为什么必须留这颗按钮：刷新此前**只能**靠下拉手势，而本页是从发现页进来的二级页，
        没有「列表 → 下拉」这种肌肉记忆，看到旧内容时的第一反应是找按钮；空列表时更只剩
        一句「下拉刷新…」的文字指令，等于把唯一的出路写成说明。

        本卡不依赖 entries 是否有内容 —— 空列表正是最需要这颗按钮的时候。
      */}
      {!loading && follows.length > 0 && (
        <View className='card page-feed__panel'>
          {/* 搜索框（2026-10-14 新增）：标题 / 摘要 / 人名三处模糊匹配，实时过滤 */}
          <View className='page-feed__search'>
            <Input
              className='page-feed__search-input'
              value={query}
              placeholder='搜索动态标题 / 摘要 / 人名'
              confirmType='search'
              onInput={onSearch}
            />
            {query && (
              <View className='page-feed__search-clear' hoverClass='page-feed__search-clear--tap' onClick={clearSearch}>
                <Text className='page-feed__search-clear-text'>×</Text>
              </View>
            )}
          </View>

          {/* 统计双列：已关注人数 / 已聚合动态条数 */}
          <View className='page-feed__stats'>
            <View className='page-feed__stat page-feed__stat--brand'>
              <Text className='page-feed__stat-label'>已关注</Text>
              <Text className='page-feed__stat-value'>{follows.length} 人</Text>
            </View>
            <View className='page-feed__stat page-feed__stat--blue'>
              <Text className='page-feed__stat-label'>近期动态</Text>
              <Text className='page-feed__stat-value'>{entries.length} 条</Text>
            </View>
          </View>

          {/* 筛选行（2026-10-14 重排）：人物 + 领域两个下拉并排，抓取按钮下移单独成行 */}
          <View className='page-feed__filters'>
            <Picker
              className='page-feed__picker'
              mode='selector'
              range={filterLabels}
              value={filterIndex}
              onChange={onFilterChange}
            >
              <View className='page-feed__select'>
                <Text className='page-feed__select-text'>{filterLabels[filterIndex] ?? filterLabels[0]}</Text>
                <Text className='page-feed__select-caret'>▾</Text>
              </View>
            </Picker>

            <Picker
              className='page-feed__picker'
              mode='selector'
              range={domainFilterLabels}
              value={domainFilterIndex}
              onChange={onDomainFilterChange}
            >
              <View className='page-feed__select'>
                <Text className='page-feed__select-text'>{domainFilterLabels[domainFilterIndex] ?? domainFilterLabels[0]}</Text>
                <Text className='page-feed__select-caret'>▾</Text>
              </View>
            </Picker>
          </View>

          {/* 抓取按钮：独占一行，更醒目 */}
          <View className='page-feed__actions'>
            <View
              className={`page-feed__fetch ${fetching ? 'page-feed__fetch--busy' : ''}`}
              hoverClass='page-feed__fetch--tap'
              onClick={() => void onFetch()}
            >
              {fetching ? '抓取中…' : '抓取动态'}
            </View>
          </View>

          <Text className='page-feed__panel-note'>
            {lastFetchedAt ? `抓取于 ${fromNow(lastFetchedAt)}` : '尚未抓取'} · 每日 10 次
          </Text>
        </View>
      )}

      {/* 读取失败：与「确实没有动态」是两回事，分开呈现 */}
      {!loading && failedCount > 0 && !noticeClosed && (
        <View className='page-feed__notice' onClick={() => void load()}>
          <Text className='page-feed__notice-text'>
            {failedCount} 位关注人的动态读取失败
            {entries.length > 0 ? '，以下结果可能不完整' : ''} · 点此重试
          </Text>
          <NoticeClose onClose={() => setNoticeClosed(true)} />
        </View>
      )}

      {!loading && entries.length === 0 && failedCount === 0 && (
        <EmptyState
          icon='📡'
          title={follows.length === 0 ? '还没有关注动态' : '关注的人暂无公开动态'}
          desc={
            follows.length === 0
              ? '关注名人后，这里会聚合展示 TA 的近期公开动态'
              : '点上方「抓取动态」联网检索最新动态（每日限 10 次）'
          }
          actionText={follows.length === 0 ? '去发现名人' : undefined}
          onAction={
            follows.length === 0 ? () => void Taro.switchTab({ url: '/pages/index/index' }) : undefined
          }
        />
      )}

      {!loading && entries.length > 0 && (
        <View>
          {/* 按人物筛选已收进顶部聚合卡的下拉（2026-10-10），此处只留标题与当前条数 */}
          <View className='section-head'>
            <Text className='section-head__title'>{personFilter ? `${filterName} 的动态` : '最新动态'}</Text>
            {/* 条数取**当前筛选下的全量**（不是已渲染的那一页）：与顶部「近期 M 条」一起表达总规模，避免误以为只有第一页 */}
            <Text className='section-head__extra'>{visible.length} 条</Text>
          </View>

          {visible.length === 0 && (
            <EmptyState
              icon='📭'
              title={`${filterName}暂无动态`}
              desc='点上方「抓取动态」联网检索，或切回「全部」看看其他人'
              actionText='查看全部'
              onAction={() => {
                setPersonFilter('')
                /* 同筛选切换：回到第一页，别让「全部」接着渲染上一个人的第 N 页 */
                setPage(1)
              }}
            />
          )}

          {paged.rows.map((e, i) => (
            <View
              key={`${e.personKey}-${e.url || i}`}
              className='card page-feed__item'
              onClick={() => openPerson(e.personKey)}
            >
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
          ))}

          {/* 触底加载更多的状态行：切片渲染没有真实网络加载，故不伪造 loading，
              只如实区分「还有 N 条（触底会追加）」与「到底」两种状态。
              注意 visible.length === 0（筛选后无内容）时不显示这一行，交由上面的空态表达。 */}
          {visible.length > 0 && (
            <Text className='page-feed__foot'>
              {paged.hasMore ? `上滑加载更多（还有 ${paged.remaining} 条）…` : '—— 没有更多动态 ——'}
            </Text>
          )}

          <View className='disclaimer'>动态内容来自公开网络检索，由 AI 整理，仅供参考</View>
        </View>
      )}
    </View>
  )
}
