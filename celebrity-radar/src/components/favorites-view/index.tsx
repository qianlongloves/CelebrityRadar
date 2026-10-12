import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import Taro, { usePullDownRefresh } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import Skeleton from '@/components/skeleton'
import EmptyState from '@/components/empty-state'
import SharePoster from '@/components/share-poster'
import PersonAvatar from '@/components/person-avatar'
import { QuoteCardInput } from '@/utils/share-card'
import { domainLabel, domainStyleCode, parsePersonKey } from '@/config/domains'
import { getCachedReports } from '@/utils/cache'
import { readPortraits } from '@/utils/portrait'
import {
  listFavorites,
  removeFavorite,
  reportDigestOf,
  FavoriteRow,
  FavoriteType,
  FAVORITE_TYPE_LABEL,
  FAVORITE_LIMIT,
  ReportDigest,
  SENTIMENT_TAG
} from '@/utils/favorites'
import { buildHeatTrend, HeatTrend } from '@/utils/trend'
import { openSourceLink } from '@/utils/source-link'
import { fromNow, isStaleReport } from '@/utils/time'
import './index.scss'

/**
 * 报告卡的「回源信息」（O-16③ 走势条 + 本轮新增的内容摘要）：
 * 走势复用报告页那条折线的同一份聚合（utils/trend.ts），内容摘要由 utils/favorites.ts
 * 的 reportDigestOf 从同一份报告里摘 —— 两者**共用下面这一次批量读库**，
 * 再加一行内容摘要不额外花任何读请求。
 *
 * 为什么要回读缓存报告：收藏存的是**快照**（payload 只有 heat / mode / generatedAt），
 * 逐条日期分布与动态列表都没有落库（理由见 trend.ts 文件头），所以只能从 report_cache 现取。
 *
 * 为什么必须**版本一致**才用：卡片上的热度是收藏那一刻的数字，若拿重新生成过的报告去画走势 /
 * 摘动态，同一条卡就会出现「热度是旧的、内容是新的」的错位 —— 比不画更糟。
 * 版本不一致时不出，卡片上那句「建议刷新」本来就已经说明了原因。
 *
 * 上限 SPARK_MAX 张：每张都要报告原文（一次批量读库），而收藏列表能到 100 条 ——
 * 这些都是加分项而不是主体，不值得为几十张同一屏都看不见的卡片各读一次。
 */
const SPARK_MAX = 12

/** 收藏类型筛选：四类混排后很难翻，按类型分开看 */
export type FavFilter = 'all' | FavoriteType

const FAV_FILTERS: Array<{ key: FavFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'report', label: FAVORITE_TYPE_LABEL.report },
  { key: 'quote', label: FAVORITE_TYPE_LABEL.quote },
  { key: 'dynamic', label: FAVORITE_TYPE_LABEL.dynamic },
  { key: 'timeline', label: FAVORITE_TYPE_LABEL.timeline }
]

interface FavoritesViewProps {
  /** 变化即重新拉取（由页面的 onShow 递增），保证从报告页返回后列表是最新的 */
  reloadKey?: number
}

/**
 * 我的收藏列表。
 *
 * 与浏览历史（components/history-view）此前挤在同一个双 Tab 组件里，
 * 现按「一个页面一件事」拆开：本组件只认收藏，tabBar「收藏」页与
 * 二级页「我的收藏」共用同一实现。
 *
 * v2（2026-10-06）：卡片左侧从「类型 emoji 图标」换成名人头像（姓名首字 + 领域色），
 * 类型退到姓名右端的小胶囊；四类卡片收敛成同一条渲染路径（头 / 正文 / 底线）；
 * 取消收藏由文字改为星标图标；用户备注整体删除；补下拉刷新。
 *
 * v3（2026-10-08）：补「内容」而不是补「装饰」—— 此前每类卡片只有一行信息，
 * 收藏的理由（那条新闻在讲什么、这句话在什么场合说的）全都没进卡片：
 *   · 报告：热度 + 走势之外，回源缓存报告摘「最新报道 + 素材画像」；
 *   · 动态：标出偏离中性的情绪，并给「原文」入口（与报告页走同一跳转入口）；
 *   · 名言：meta 补媒体名，正文补「背景 / 注解」。
 * 新增内容一律「取不到就不渲染」，不显示占位文案（报告摘要复用走势条那次批量读库）。
 */
export default function FavoritesView({ reloadKey }: FavoritesViewProps) {
  const [loading, setLoading] = useState(true)
  const [favorites, setFavorites] = useState<FavoriteRow[]>([])
  /** 类型筛选（刷新列表不重置） */
  const [favFilter, setFavFilter] = useState<FavFilter>('all')
  /**
   * 待生成名言卡的名言（null = 弹层关闭）。
   * 收藏页是「先把话存下来、之后想转发」的地方，所以出图入口放在这里，
   * 与报告页的「读到就想发」形成两条不同的动线。
   * 一并带上 personKey 只为埋点归因，卡片本身画不到它。
   */
  const [posterQuote, setPosterQuote] = useState<{ quote: QuoteCardInput; personKey: string } | null>(null)
  /** 报告卡走势条（personKey → 趋势），取不到就整条不渲染（见 SPARK_MAX 上方注释） */
  const [trends, setTrends] = useState<Record<string, HeatTrend>>({})
  /** 报告卡内容摘要（personKey → 最新报道 + 素材画像），同上：取不到就不渲染那两行 */
  const [digests, setDigests] = useState<Record<string, ReportDigest>>({})

  /**
   * 补报告卡的回源信息（走势条 + 内容摘要）：一次批量读缓存报告，
   * 只给「快照版本仍是当前版本」的报告卡出内容。
   * 读失败 / 报告不存在 / 条目不足（trend 返回 null）都只是那几条不出，不影响列表本身。
   */
  const loadReportExtras = useCallback(async (rows: FavoriteRow[]) => {
    const targets = rows.filter((f) => f.type === 'report').slice(0, SPARK_MAX)
    if (targets.length === 0) {
      setTrends({})
      setDigests({})
      return
    }
    const reports = await getCachedReports(targets.map((f) => f.person_key))
    const nextTrends: Record<string, HeatTrend> = {}
    const nextDigests: Record<string, ReportDigest> = {}
    targets.forEach((f, i) => {
      const report = reports[i]
      if (!report) return
      /* 版本必须一致：卡片上的热度出自收藏那一刻的快照，混用新报告的内容会自相矛盾 */
      if (String(f.payload?.generatedAt ?? '') !== report.generatedAt) return
      const trend = buildHeatTrend(report)
      if (trend) nextTrends[f.person_key] = trend
      const digest = reportDigestOf(report)
      if (digest) nextDigests[f.person_key] = digest
    })
    setTrends(nextTrends)
    setDigests(nextDigests)
  }, [])

  /** 取数。首次进页、onShow 回页、下拉刷新共用同一条路径 */
  const load = useCallback(async () => {
    setLoading(true)
    const rows = await listFavorites()
    setFavorites(rows)
    setLoading(false)
    /* 走这两条是加分项：先让列表出来，再补这一批读库，不让它拖住首屏（也避免骨架多停一拍） */
    void loadReportExtras(rows)
  }, [loadReportExtras])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  /* 真图预热：收藏列表一屏多人，一次批量读把全部人拉进缓存，避免逐卡各打一次云函数 */
  useEffect(() => {
    if (favorites.length > 0) void readPortraits(favorites.map((f) => f.person_key))
  }, [favorites])

  /**
   * 下拉刷新。
   *
   * 收藏列表是「别处一动它就过期」的数据：在报告页取消收藏、报告重新生成后，
   * 列表里的快照都变了，而这里此前没有任何更新入口 —— 只能退出页面再进。
   * 刷新只重拉列表，不触发任何生成、不消耗额度。
   * 两个宿主页（pages/collection、pages/records）都开了 enablePullDownRefresh。
   */
  usePullDownRefresh(async () => {
    await load()
    Taro.stopPullDownRefresh()
    Taro.showToast({ title: '已同步最新收藏', icon: 'none', duration: 1200 })
  })

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}` })
  }

  /**
   * 取消收藏。
   *
   * 图标化把点击区从一整行文字缩到 36rpx 的星标，误触概率大幅下降，但二次确认仍保留：
   * 列表里删掉就没有撤销入口，用户要自己回报告页重新找到那条再收藏。
   */
  const onRemoveFavorite = async (id: string) => {
    const res = await Taro.showModal({
      title: '取消收藏',
      content: '取消后可以重新收藏',
      confirmText: '确定',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    /* 删除失败时**不动本地列表**：否则卡片当场消失、下次进来又出现，用户只会以为删不掉 */
    const ok = await removeFavorite(id)
    if (!ok) {
      void Taro.showToast({ title: '取消收藏失败，请重试', icon: 'none' })
      return
    }
    setFavorites((prev) => prev.filter((f) => f.id !== id))
  }

  const countOf = (key: FavFilter): number =>
    key === 'all' ? favorites.length : favorites.filter((f) => f.type === key).length
  const shownFavorites =
    favFilter === 'all' ? favorites : favorites.filter((f) => f.type === favFilter)

  /**
   * 名人头像：有真图就画照片，没有回落「姓名首字 + 领域色」（见 components/person-avatar）。
   * 姓名都丢了（老脏数据）时不取真图 —— 定位不到人只会白打一次云调用，
   * 直接退回「?」并明示「这里本该是头像」，而不是渲染一个空圆让人以为样式坏了。
   */
  const renderAvatar = (f: FavoriteRow, domain: string) => {
    const name = (f.name ?? '').trim()
    if (!name) {
      return <View className='favorites-view__avatar favorites-view__avatar--unknown'>?</View>
    }
    return (
      <PersonAvatar
        personKey={f.person_key}
        name={name}
        domain={domain}
        className={`favorites-view__avatar favorites-view__avatar--${domainStyleCode(domain)}`}
      />
    )
  }

  /** 姓名下方的元信息行：日期 / 来源 / 领域 / 报告生成时间，类型由右上角胶囊承担 */
  const metaOf = (f: FavoriteRow, domain: string): ReactNode => {
    const p = f.payload ?? {}
    if (f.type === 'timeline') return String(p.date ?? '')
    if (f.type === 'dynamic') {
      return [String(p.date ?? ''), String(p.source ?? '')].filter((x) => x !== '').join(' · ')
    }
    if (f.type === 'quote') {
      /* 出处补上媒体名（本轮改版）：context 说的是「什么场合」，source 说的是「谁报道的」，
         两者合起来才能核对这句话 —— 落库时 source 已被 sanitize 换成媒体名（见 report.ts）。
         旧的「据公开资料」是兜底值，等于没信息，不占这一行。 */
      const source = String(p.source ?? '')
      const src = source && source !== '据公开资料' ? source : ''
      return [domainLabel(domain), String(p.context || '公开场合'), src]
        .filter((x) => x !== '')
        .join(' · ')
    }
    /*
     * 报告没有正文与出处，唯一有价值的时间信息是「手上这份报告是哪一版」。
     *
     * 收藏存的是一份**快照**：报告可以随时重新生成，而这条收藏不会跟着更新
     * （payload 里就是收藏那一刻的内容）。所以陈旧时不能只写「33 天前」——
     * 那读起来像「33 天前我收藏了它」，于是补一句「建议刷新」把两种时间区分开（O-14）。
     */
    const generatedAt = String(p.generatedAt ?? '')
    if (!generatedAt) return ''
    return (
      <>
        {`报告生成于 ${fromNow(generatedAt)}`}
        {isStaleReport(generatedAt) && (
          <Text className='favorites-view__stale'>建议刷新</Text>
        )}
      </>
    )
  }

  const renderHead = (f: FavoriteRow, domain: string) => {
    const meta = metaOf(f, domain)
    return (
      <View className='favorites-view__head'>
        {renderAvatar(f, domain)}
        <View className='favorites-view__head-info'>
          <Text className='favorites-view__name'>{f.name || '未知名人'}</Text>
          {!!meta && <Text className='text-tertiary favorites-view__meta'>{meta}</Text>}
        </View>
        <Text className={`favorites-view__type favorites-view__type--${f.type}`}>
          {FAVORITE_TYPE_LABEL[f.type]}
        </Text>
      </View>
    )
  }

  /**
   * 卡片正文。
   *
   * 四类里只有报告原本没有正文，于是它一定比其它三类矮半截 —— 给它一条热度刻度补上视觉重量，
   * 顺带给「为什么值得收藏这份报告」一个数字依据。热度口径与热门榜 / 热度条一致（0~100）。
   *
   * 本轮改版补的是「内容」而不是「装饰」：原卡片每类只有一行信息，
   * 收藏一条东西的理由（那条新闻在讲什么、这句话在什么场合说的）全都没进卡片。
   */
  const renderBody = (f: FavoriteRow) => {
    const p = f.payload ?? {}
    if (f.type === 'report') {
      const heat = Math.max(0, Math.min(100, Number(p.heat) || 0))
      const trend = trends[f.person_key]
      const digest = digests[f.person_key]
      return (
        <View className='favorites-view__body'>
          <View className='favorites-view__heat'>
            <View className='favorites-view__heat-bar'>
              <View className='favorites-view__heat-fill' style={{ width: `${heat}%` }} />
            </View>
            <Text className='favorites-view__heat-num'>{heat}</Text>
          </View>
          {/* 走势条（O-16③）：口径与报告页那张折线卡一致（同一份 buildHeatTrend），
              这里只换视觉形态 —— 6 根小柱在列表里比压平的折线好认 */}
          {trend && (
            <View className='favorites-view__spark'>
              <Text className='favorites-view__spark-label'>近 30 天</Text>
              <View className='favorites-view__spark-bars'>
                {trend.points.map((pt) => (
                  <View key={pt.label} className='favorites-view__spark-slot'>
                    <View
                      className='favorites-view__spark-fill'
                      style={{ height: `${Math.round(pt.ratio * 100)}%` }}
                    />
                  </View>
                ))}
              </View>
            </View>
          )}
          {/* 内容摘要（本轮改版）：热度刻度只说明「现在多热」，说明不了「这份报告里写了什么」，
              而收藏一份报告的理由几乎总是「里面那几条动态我要跟进」 */}
          {digest && (
            <View className='favorites-view__digest'>
              {!!digest.latest && (
                <View className='favorites-view__digest-line'>
                  <Text className='favorites-view__digest-label'>最新</Text>
                  <Text className='favorites-view__digest-text'>
                    {[digest.latestMeta, digest.latest].filter((x) => x !== '').join(' · ')}
                  </Text>
                </View>
              )}
              {!!digest.coverage && (
                <View className='favorites-view__digest-line'>
                  <Text className='favorites-view__digest-label'>素材</Text>
                  <Text className='favorites-view__digest-text'>{digest.coverage}</Text>
                </View>
              )}
            </View>
          )}
        </View>
      )
    }
    const text =
      f.type === 'quote'
        ? `「${String(p.text ?? '')}」`
        : String((f.type === 'dynamic' ? p.title : p.event) ?? '')
    /* 动态多给两行摘要：收藏动机多半是「这条要跟进」，只有标题不足以回想当时为什么存它 */
    const summary = f.type === 'dynamic' ? String(p.summary ?? '') : ''
    /* 情绪只标**偏离中性**的两档（见 utils/favorites.ts 的 SENTIMENT_TAG）：
       中性是默认值，每张卡挂一个「中性」只是噪音 */
    const sentimentRaw = f.type === 'dynamic' ? String(p.sentiment ?? '') : ''
    const sentiment = SENTIMENT_TAG[sentimentRaw] ?? ''
    /* 名言补「背景 / 注解」（本轮改版）：只存原句的卡片是一句悬空的话，
       补上场合与含义才留得住「当时为什么把它存下来」 */
    const extras =
      f.type === 'quote'
        ? [
            { label: '背景', text: String(p.background ?? '') },
            { label: '注解', text: String(p.note ?? '') }
          ].filter((x) => x.text !== '')
        : []
    return (
      <View className='favorites-view__body'>
        {!!sentiment && (
          <View className={`favorites-view__sentiment favorites-view__sentiment--${sentimentRaw}`}>
            {sentiment}
          </View>
        )}
        <View className='favorites-view__body-text'>{text}</View>
        {!!summary && <View className='favorites-view__summary'>{summary}</View>}
        {extras.map((x) => (
          <View key={x.label} className='favorites-view__extra'>
            <Text className='favorites-view__extra-label'>{x.label}</Text>
            <Text className='favorites-view__extra-text'>{x.text}</Text>
          </View>
        ))}
      </View>
    )
  }

  /** 底部操作条：左侧收藏时间 + 右侧动作（可选的卡片内动作 + 星标取消收藏） */
  const renderFoot = (f: FavoriteRow, action?: ReactNode) => (
    <View className='favorites-view__foot'>
      <Text className='text-tertiary favorites-view__foot-main'>收藏于 {fromNow(f.created_at)}</Text>
      <View className='favorites-view__foot-ops'>
        {action}
        {/* 取消收藏用星标而非文字：与报告页语录的 ★/☆ 同一套符号，动作一眼可辨，
            也不再和左侧的收藏时间抢一行宽度。
            用 View 而非 Text 只是为了能挂 hoverClass（Taro 的 TextProps 没有这个属性） */}
        <View
          className='favorites-view__star'
          hoverClass='favorites-view__star--tap'
          onClick={(e) => {
            e.stopPropagation?.()
            void onRemoveFavorite(f.id)
          }}
        >
          ★
        </View>
      </View>
    </View>
  )

  /** 名言卡入口：把这句话直接做成可转发的图，不必先回报告页找它 */
  const renderPosterAction = (f: FavoriteRow, domain: string) => {
    const p = f.payload ?? {}
    return (
      <Text
        className='favorites-view__poster'
        onClick={(e) => {
          e.stopPropagation?.()
          setPosterQuote({
            personKey: f.person_key,
            quote: {
              name: f.name,
              domain,
              text: String(p.text ?? ''),
              context: String(p.context ?? '')
            }
          })
        }}
      >
        名言卡
      </Text>
    )
  }

  /**
   * 动态卡的「原文」入口（本轮改版）。
   *
   * 与报告页「近期动态」点标题进原文走**同一个**跳转入口（utils/source-link），
   * 区别在于这里整卡已经指向报告页，原文得给一个独立动作 —— 否则收藏了一条新闻，
   * 想核对原文还得先回报告页翻到那一条。
   * 不再加「复制链接」：预览页里已经有了，同一条内容不需要两个通往同一结果的入口。
   */
  const renderLinkAction = (f: FavoriteRow) => {
    const p = f.payload ?? {}
    return (
      <Text
        className='favorites-view__link'
        onClick={(e) => {
          e.stopPropagation?.()
          openSourceLink({
            url: String(p.url ?? ''),
            title: String(p.title ?? ''),
            source: String(p.source ?? ''),
            date: String(p.date ?? ''),
            summary: String(p.summary ?? '')
          })
        }}
      >
        原文
      </Text>
    )
  }

  /**
   * 四类收藏收敛成同一条渲染路径（头 / 正文 / 底线），差异只在正文与可选动作上。
   * 此前是三条各自拼装的路径，改一次布局要改三处，且报告卡连「整卡可点」都和另两类不一致。
   */
  const renderCard = (f: FavoriteRow) => {
    const domain = parsePersonKey(f.person_key)?.domain ?? 'other'
    const action =
      f.type === 'quote'
        ? renderPosterAction(f, domain)
        : f.type === 'dynamic'
          ? renderLinkAction(f)
          : undefined
    return (
      <View key={f.id} className='card' onClick={() => openPerson(f.person_key)}>
        {renderHead(f, domain)}
        {renderBody(f)}
        {renderFoot(f, action)}
      </View>
    )
  }

  if (loading) {
    return (
      <View className='favorites-view'>
        {/* 用 feed 骨架（头像行 + 标题 + 两行摘要）：与改版后的卡片版面同构，
            真实内容进来时不会跳版 —— card 骨架没有头像行，改版后就不匹配了 */}
        <Skeleton variant='feed' rows={3} />
      </View>
    )
  }

  if (favorites.length === 0) {
    return (
      <View className='favorites-view'>
        <EmptyState
          icon='⭐'
          title='还没有收藏'
          desc='在报告页可收藏整份报告、单句名言、单条动态或履历节点'
          actionText='去发现名人'
          onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
        />
      </View>
    )
  }

  return (
    <View className='favorites-view'>
      {/* 类型筛选。小号胶囊 + 浅紫选中，计数缩小降透明度；
          它是页面的分类开关而非主导航，视觉重量刻意压低 */}
      <View className='favorites-view__filters'>
        {FAV_FILTERS.map((f) => (
          <View
            key={f.key}
            className={`favorites-view__filter ${
              favFilter === f.key ? 'favorites-view__filter--active' : ''
            }`}
            onClick={() => setFavFilter(f.key)}
          >
            {f.label}
            <Text className='favorites-view__filter-count'>{countOf(f.key)}</Text>
          </View>
        ))}
      </View>

      {shownFavorites.length === 0 ? (
        <EmptyState
          icon='🔍'
          title='这个分类还没有收藏'
          desc='切回「全部」看看其他收藏'
          actionText='查看全部'
          onAction={() => setFavFilter('all')}
        />
      ) : (
        <View>
          {shownFavorites.map((f) => renderCard(f))}

          <View className='favorites-view__foot-note'>
            {favFilter === 'all'
              ? `共 ${favorites.length} 条`
              : `筛选出 ${shownFavorites.length} 条 / 共 ${favorites.length} 条`}
            {favorites.length >= FAVORITE_LIMIT ? ` · 仅保留最近 ${FAVORITE_LIMIT} 条` : ''}
          </View>
        </View>
      )}

      <View className='disclaimer'>收藏仅自己可见；下拉可同步最新</View>

      {posterQuote && (
        <SharePoster
          quote={posterQuote.quote}
          personKey={posterQuote.personKey}
          onClose={() => setPosterQuote(null)}
        />
      )}
    </View>
  )
}
