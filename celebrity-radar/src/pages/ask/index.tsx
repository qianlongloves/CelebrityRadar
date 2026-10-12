import { useCallback, useEffect, useMemo, useState } from 'react'
import { Input, Text, View } from '@tarojs/components'
import Taro, { useDidShow, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import EmptyState from '@/components/empty-state'
import QaPanel from '@/components/qa-panel'
import Skeleton from '@/components/skeleton'
import { buildPersonKey, DOMAIN_META, parsePersonKey } from '@/config/domains'
import type { DomainCode } from '@/config/domains'
import { useAuth } from '@/stores/auth'
import { getCachedReports } from '@/utils/cache'
import { todayPerson } from '@/utils/explore'
import { listFollows } from '@/utils/follows'
import { listRecentHistory } from '@/utils/history'
import { loadHotBoard } from '@/utils/hot-board'
import { readMemberState } from '@/utils/member'
import type { Report } from '@/utils/report'
import { personShareTitle, reportSharePath } from '@/utils/share'
import { useTabBarSync } from '@/utils/tabbar'
import { fromNow } from '@/utils/time'
import './index.scss'

/**
 * 「AI 提问」（底部菜单第二格；2026-10-07 由「关注」换成此页）。
 *
 * 为什么不是直接把会话页 `pages/qa` 挂到底栏：tabBar 页面只能由 switchTab 打开、
 * **不能带参数**，而会话页必须知道「问谁」。硬把两者合并，就得让报告页的「向 AI 提问」
 * 改成切 tab + 借 storage 传人 —— 那会毁掉「看完报告顺手追问」的返回路径（tab 页没有返回栈）。
 * 于是这里做成频道页：先在此处选人，再把会话交给共用的 QaPanel（与报告页入口同一套闸门）。
 *
 * 候选人 = 「最近查看记录」∪「我的关注」，去重后**一次批量读**判定谁缓存里已有报告
 * （见 utils/cache.ts#getCachedReports）：最近查看排在前（用户刚看过的人理应出现在选人条最前），
 * 关注列表补齐在后。补齐这一半是关键 —— **只靠 history 会漏人**：关注流是从 report_cache
 * 共享读的、不写 history，所以「关注了但没点进过报告页」的人此前根本不进候选。
 *
 * 探测名单本身就是云读代价，所以两头都截断（最近查看 8 位 + 关注补齐至 20 位）；
 * **没有缓存报告的人不再略过**（2026-10-12 起）：他们照样进选人条、标一个「直连」标记，
 * 选中后由 QaPanel 直连大模型作答（不生成报告）—— 「没有报告就不能问」这条旧限制已放开。
 *
 * 一个都没有时给空态，但「未登录」与「登录了确实没有可提问对象」是两种原因，文案必须分开写
 * —— 本页绝不代用户触发生成（那是 30 秒的重操作）。
 *
 * 额度口径：每日提问上限是会员权益（免费版 / 会员两档，见 utils/member.ts），
 * 与报告生成**不同池**：提问不吃生成额度。
 *
 * 版面（O-26）：本页此前被三块「说明」压掉近一半首屏 —— 选人条的标题行、卡片底部那行额度说明、
 * 面板头部复述的「多久前生成 · 素材 N 条」、以及一段两句长的口径声明。它们的共同问题是
 * **信息重复**：选人条已经给出头像 / 名字 / 生成时间 / 素材条数，面板头部再说一遍；
 * 「不消耗生成额度」与面板头部的用量行说的是同一件事。故：
 *   · 额度说明并进选人条标题行（一行说完，不再单独占行）；
 *   · 面板用 compact 头部（省掉 meta 行，见 components/qa-panel）；
 *   · 口径声明压到一行（20rpx）。
 * 会话区是这一页的主角 —— 它被挤到屏幕下半截时，本页就没法用了。
 */

/** 最近查看取多少位（排在选人条最前） */
const HISTORY_PROBE = 8
/** 探测名单总上限：最近查看 + 关注补齐后，最多这么多位参与判定 */
const MAX_TARGETS = 20

/** 候选超过这个数量才显示过滤框：只有两三个人时输入框纯属占地方 */
const FILTER_FROM = 5

/**
 * 折叠态每组最多铺这么多张（2 行 × 4 列）。
 * 选人器是「多点一下就选完」的过渡控件，不该把下半屏的会话区挤没；关注多的人一屏铺不下，
 * 默认只给两行，超出由底部的「展开全部」放开。
 */
const COLLAPSED_PER_GROUP = 8

/**
 * 联想推荐最多给几条。
 * 推荐行是「打字时的顺手补全」，不是搜索结果页 —— 给多了会把下方的候选网格顶下去，
 * 反而看不清自己原本要找的人。
 */
const SUGGEST_MAX = 6

/**
 * 联想推荐的候选池来自热门榜（utils/hot-board）：云端每日 AI 榜 → report_cache 真实热度 →
 * 静态种子，三级回落且带 TTL 缓存（见该文件注释），失败也不 reject。
 * 只推荐**本机候选里没有**的人 —— 本机已有的会出现在下方网格里，再列一遍是重复。
 */
interface SuggestPerson {
  name: string
  domain: DomainCode
  personKey: string
}

type Phase = 'loading' | 'ready' | 'empty'

/**
 * 提问候选：`report` 为 null 表示本机还没有该人的缓存报告 —— 选中后走 QaPanel 的直连模式
 * （直连大模型，不生成报告）；有报告则照旧用报告素材作答。
 *
 * `source`（2026-10-12）为选人器分组用：最近看过 / 我的关注 / 搜索后临时加入（未接触过的人）。
 */
type AskSource = 'recent' | 'follow' | 'search'

interface AskTarget {
  personKey: string
  name: string
  report: Report | null
  source: AskSource
}

export default function AskPage() {
  useTabBarSync()

  const { userId } = useAuth()

  const [phase, setPhase] = useState<Phase>('loading')
  const [targets, setTargets] = useState<AskTarget[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [member, setMember] = useState(false)
  /* 选人器的过滤词（够长才出现输入框，见下面的 FILTER_FROM） */
  const [filter, setFilter] = useState('')
  /* 分组网格是否展开（每组超过 COLLAPSED_PER_GROUP 时才出现「展开全部」） */
  const [expanded, setExpanded] = useState(false)
  /* 联想推荐的候选池（热门榜，见 SuggestPerson 注释）；拉不到就为空，推荐行自然消失 */
  const [hotPool, setHotPool] = useState<SuggestPerson[]>([])

  /* 热门榜只在挂载时拉一次：它带 5 分钟内存缓存、天级变化，本页每次切回不必重拉 */
  useEffect(() => {
    let alive = true
    void loadHotBoard().then((board) => {
      if (alive) {
        setHotPool(
          board.map((p) => ({ name: p.name, domain: p.domain, personKey: buildPersonKey(p.name, p.domain) }))
        )
      }
    })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 候选装载：本页是底栏页，每次切回来都会重跑，所以这里刻意压往返次数 ——
   * 会员态 / 最近查看 / 关注三者互不依赖（并行取），候选报告走一次 `in` 批量读
   * （原来是对 8 位逐个 getCachedReport，等于 8 次独立云读，见 utils/cache.ts#getCachedReports）。
   */
  const load = useCallback(async () => {
    const [state, recent, follows] = await Promise.all([
      readMemberState(),
      listRecentHistory(HISTORY_PROBE),
      listFollows()
    ])

    /* 去重定序：最近查看在前、关注补齐在后。`listFollows` 未登录返回空数组，天然不掺和 */
    const keys: string[] = []
    const seen = new Set<string>()
    for (const key of [...recent.map((r) => r.person_key), ...follows.map((f) => f.person_key)]) {
      if (!key || seen.has(key)) continue
      seen.add(key)
      keys.push(key)
      if (keys.length >= MAX_TARGETS) break
    }

    const found = await getCachedReports(keys)
    /*
     * 逐位造候选：`getCachedReports` 的返回与入参**按下标对齐**（见 utils/cache.ts）。
     * 姓名优先取缓存报告里的，其次从 personKey 解析（无报告时 report 为 null），最后兜底 key 本身。
     */
    const recentKeys = new Set(recent.map((r) => r.person_key))
    const list: AskTarget[] = keys.map((key, i) => {
      const report = found[i] ?? null
      return {
        personKey: key,
        name: report?.name || parsePersonKey(key)?.name || key,
        report,
        /* 最近看过 / 关注：同一个 key 不会同时属于两组（keys 已去重，最近在前） */
        source: recentKeys.has(key) ? 'recent' : 'follow'
      }
    })

    setMember(state.member)
    setTargets(list)
    /* 尽量留在用户原来的选择上；该人已不在候选里才退回第一位 */
    setActiveKey((prev) => (list.some((t) => t.personKey === prev) ? prev : list[0]?.personKey ?? ''))
    setPhase(list.length > 0 ? 'ready' : 'empty')
  }, [])

  /* 每次切回本页都重算：可能刚生成完一份新报告，也可能刚买完会员 */
  useDidShow(() => {
    void load()
  })

  const active = useMemo(
    () => targets.find((t) => t.personKey === activeKey) ?? null,
    [targets, activeKey]
  )

  /* 过滤词原样保留：既用于筛人，也用作「直接向 AI 提问」的兜底出口 */
  const keyword = filter.trim()

  /**
   * 分组（2026-10-12）：最近看过 / 我的关注 / 搜索加入，各一组、组内保持原顺序。
   *
   * 为什么分组而不是一条长条：原先是一条横滑卡片带 —— 候选到十几位时只能靠左右滑找人，
   * 而且「最近看过」与「关注」混在一起，用户看不出某位为什么在列表里。分组后两组各自成块，
   * 来源一目了然，也把「最近看过优先」这条排序口径显式化。
   */
  const groups = useMemo(() => {
    const q = keyword.toLowerCase()
    const keep = (t: AskTarget) => !q || t.name.toLowerCase().includes(q)
    return [
      { key: 'recent' as const, title: '最近看过', items: targets.filter((t) => t.source === 'recent' && keep(t)) },
      { key: 'follow' as const, title: '我的关注', items: targets.filter((t) => t.source === 'follow' && keep(t)) },
      { key: 'search' as const, title: '搜索加入', items: targets.filter((t) => t.source === 'search' && keep(t)) }
    ].filter((g) => g.items.length > 0)
  }, [targets, keyword])

  /** 任一组超过折叠上限，才需要底部的「展开全部」 */
  const overflows = useMemo(() => groups.some((g) => g.items.length > COLLAPSED_PER_GROUP), [groups])

  /**
   * 联想推荐（2026-10-12）：按输入匹配热门榜里**本机候选没有**的人。
   *
   * 为什么只推热门榜、不推本机：本机候选已经在下方网格里按键筛过了，再在推荐行里列一遍是重复；
   * 联想推荐真正的价值是「把用户没想到、但当下正热的人递到手边」—— 点一下即以直连模式提问，
   * 不必先有报告。
   */
  const suggest = useMemo(() => {
    const q = keyword.toLowerCase()
    if (!q) return []
    const local = new Set(targets.map((t) => t.name))
    return hotPool.filter((p) => !local.has(p.name) && p.name.toLowerCase().includes(q)).slice(0, SUGGEST_MAX)
  }, [hotPool, targets, keyword])

  /**
   * 「直接向 AI 提问」：把过滤框里的名字**直接当成提问对象**（未接触过的人也能问）。
   *
   * 刻意不接名人库检索：本页没有「任意名人搜索」这条云通道，而直连模式本来就不需要报告 ——
   * 用户打什么名字就拿它当 subject 去问，落地即直连。这样「未接触过的人」也有了入口，
   * 又不必新增一次检索往返。domain 一律 other：无报告时 personKey 只用于配色与去重。
   */
  const askDirectly = useCallback((text: string) => {
    const name = text.trim()
    if (!name) return
    const personKey = `${name}#other`
    setTargets((prev) =>
      prev.some((t) => t.personKey === personKey)
        ? prev
        : [...prev, { personKey, name, report: null, source: 'search' }]
    )
    setActiveKey(personKey)
    setFilter('')
  }, [])

  /** 点联想推荐：把人加进候选（无报告 → 直连）并选中；清掉过滤词让选中的卡在网格里露出来 */
  const pickSuggested = useCallback((p: SuggestPerson) => {
    setTargets((prev) =>
      prev.some((t) => t.personKey === p.personKey)
        ? prev
        : [...prev, { personKey: p.personKey, name: p.name, report: null, source: 'search' }]
    )
    setActiveKey(p.personKey)
    setFilter('')
  }, [])

  /**
   * 转发（优化建议 O-13）。
   *
   * 本页此前没有分享回调：右上角「转发」带出的是**不含参数的 tabBar 地址**，
   * 对方点开只会落在发现页 —— 提问页分享出去「我在问某某」，对方却看不到是谁。
   *
   * 本页是 tabBar 页、不能作分享落地页，所以落到**当前选中的名人报告**；
   * 还没选出人时（首次加载中 / 空态）退回「今日名人」，保证分享出去的链接总能落地。
   * 标题与报告页 / 名人主页 / 发现页同源（utils/share.ts）。
   */
  const shareTarget = useMemo(() => {
    if (active) return { personKey: active.personKey, name: active.name, report: active.report }
    const pick = todayPerson()
    return { personKey: pick.personKey, name: pick.name, report: null }
  }, [active])
  const sharePath = reportSharePath(shareTarget.personKey)
  const shareTitle = personShareTitle(
    shareTarget.name,
    parsePersonKey(shareTarget.personKey)?.domain ?? 'other',
    shareTarget.report
  )
  useShareAppMessage(() => ({ title: shareTitle, path: sharePath }))
  useShareTimeline(() => ({ title: shareTitle, query: sharePath.split('?')[1] ?? '' }))

  return (
    <View className='page-ask glow-page safe-tab'>
      {phase === 'loading' && (
        <View className='card'>
          <Skeleton rows={3} variant='card' />
        </View>
      )}

      {/*
        空态必须分两种原因：未登录时 utils/history.ts 直接返回空数组（历史是云端的，
        没有身份就没有归属），若还写「先去查看或关注一些人」，用户按指引走会先撞上登录流程 ——
        指引与真实原因不符，第一次点进底栏第二格的人会以为功能坏了。
        （2026-10-12 起：没有报告的人也能直连提问，故空态不再要求「先有一份报告」。）
      */}
      {phase === 'empty' && (
        <EmptyState
          icon={userId ? '💬' : '🔐'}
          title={userId ? '本机还没有可提问的对象' : '登录后才能提问'}
          desc={
            userId
              ? '先去查看或关注一些人，TA 就会出现在这里；有没有报告都可以提问。'
              : '提问需要先登录。登录后查看或关注一些人，就能在这里选人提问。'
          }
          actionText={userId ? '去发现名人' : '去登录'}
          onAction={() => Taro.switchTab({ url: userId ? '/pages/index/index' : '/pages/mine/index' })}
        />
      )}

      {phase === 'ready' && active && (
        <>
          <View className='card page-ask__picker'>
            <View className='page-ask__picker-head'>
              <Text className='page-ask__picker-title'>选一位名人提问</Text>
              {/* 额度口径与报告页同一说法（utils/member.ts 的提问池）：说清两个池的名字，避免被读成「问了也扣生成额度」 */}
              <Text className='page-ask__picker-count'>
                {`${targets.length} 位可提问 · 只计「每日提问次数」，不占「报告生成次数」`}
              </Text>
            </View>

            {targets.length > FILTER_FROM && (
              <Input
                className='page-ask__filter'
                value={filter}
                placeholder='搜索本机的人，或直接输入名人名'
                confirmType='search'
                onInput={(e) => setFilter(e.detail.value)}
              />
            )}

            {/* 联想推荐（2026-10-12）：输入时按热门榜补全 —— 本机没有的人也能一键选中、直连提问 */}
            {suggest.length > 0 && (
              <View className='page-ask__suggest'>
                <Text className='page-ask__suggest-title'>猜你想问</Text>
                <View className='page-ask__suggest-list'>
                  {suggest.map((p) => (
                    <View
                      key={p.personKey}
                      className='page-ask__suggest-item'
                      hoverClass='page-ask__suggest-item--tap'
                      onClick={() => pickSuggested(p)}
                    >
                      <Text className='page-ask__suggest-name'>{p.name}</Text>
                      <Text className='page-ask__suggest-tag'>{DOMAIN_META[p.domain].label}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* 兜底出口：输入了名字却想直接问（未接触过的人也走这里，落地即直连模式） */}
            {keyword.length > 0 && (
              <View
                className='page-ask__direct'
                hoverClass='page-ask__direct--tap'
                onClick={() => askDirectly(keyword)}
              >
                <Text className='page-ask__direct-text'>{`直接向 AI 提问「${keyword}」`}</Text>
                <Text className='page-ask__direct-hint'>未接触过也能问 · 直连大模型</Text>
              </View>
            )}

            {groups.map((g) => (
              <View key={g.key} className='page-ask__group'>
                <Text className='page-ask__group-title'>{`${g.title} · ${g.items.length}`}</Text>
                <View className='page-ask__grid'>
                  {(expanded ? g.items : g.items.slice(0, COLLAPSED_PER_GROUP)).map((t) => (
                    <View key={t.personKey} className='page-ask__cell'>
                      <View
                        className={`page-ask__person${
                          t.personKey === activeKey ? ' page-ask__person--active' : ''
                        }`}
                        hoverClass='page-ask__person--tap'
                        onClick={() => setActiveKey(t.personKey)}
                      >
                        {/* 头像取姓名首字 + 领域色：与关注流 / 收藏页一致，一眼可辨是谁 */}
                        <View
                          className={`page-ask__avatar page-ask__avatar--${
                            parsePersonKey(t.personKey)?.domain ?? 'other'
                          }`}
                        >
                          {t.name.slice(0, 1)}
                        </View>
                        <Text className='page-ask__person-name'>{t.name}</Text>
                        {/* 有报告：给出「多久前生成 · 素材 N 条」；无报告：只标「直连」，不再编一个素材条数 */}
                        {t.report ? (
                          <Text className='page-ask__person-meta'>{`${fromNow(t.report.generatedAt)} · ${
                            t.report.coverage?.items ?? t.report.dynamics.length
                          } 条`}</Text>
                        ) : (
                          <Text className='page-ask__person-meta page-ask__person-meta--direct'>直连</Text>
                        )}
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            ))}

            {groups.length === 0 && (
              <Text className='page-ask__none'>本机没有匹配的名人；可点上方「直接向 AI 提问」</Text>
            )}

            {overflows && (
              <View
                className='page-ask__more'
                hoverClass='page-ask__more--tap'
                onClick={() => setExpanded((v) => !v)}
              >
                <Text className='page-ask__more-text'>{expanded ? '收起' : '展开全部'}</Text>
              </View>
            )}
          </View>

          {/* safeBottom=false：本页根容器带了 .safe-tab（已含 env(safe-area-inset-bottom)），
              面板再让一次安全区会让输入框下方多出一整条空白
              compact：本页正上方就是选人条，面板头部不必再复述「多久前生成 · 素材 N 条」（O-26）
              report 为 null 时（该人无缓存报告）走面板的直连模式，用 name 直连大模型作答 */}
          <QaPanel report={active.report ?? undefined} name={active.name} member={member} safeBottom={false} compact />
        </>
      )}
    </View>
  )
}
