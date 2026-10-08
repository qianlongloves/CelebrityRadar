import { useCallback, useMemo, useState } from 'react'
import { Input, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useDidShow, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import EmptyState from '@/components/empty-state'
import QaPanel from '@/components/qa-panel'
import Skeleton from '@/components/skeleton'
import { parsePersonKey } from '@/config/domains'
import { useAuth } from '@/stores/auth'
import { getCachedReports } from '@/utils/cache'
import { todayPerson } from '@/utils/explore'
import { listFollows } from '@/utils/follows'
import { listRecentHistory } from '@/utils/history'
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
 * 查不到报告的人自动略过，不进选人条。
 *
 * 一个都没有时给空态，但「未登录」与「登录了确实没有报告」是两种原因，文案必须分开写
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

type Phase = 'loading' | 'ready' | 'empty'

export default function AskPage() {
  useTabBarSync()

  const { userId } = useAuth()

  const [phase, setPhase] = useState<Phase>('loading')
  const [targets, setTargets] = useState<Report[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [member, setMember] = useState(false)
  /* 选人条的过滤词（够长才出现输入框，见下面的 visible） */
  const [filter, setFilter] = useState('')

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

    const found = (await getCachedReports(keys)).filter((r): r is Report => !!r)

    setMember(state.member)
    setTargets(found)
    /* 尽量留在用户原来的选择上；该人已不在候选里（缓存过期）才退回第一位 */
    setActiveKey((prev) => (found.some((r) => r.personKey === prev) ? prev : found[0]?.personKey ?? ''))
    setPhase(found.length > 0 ? 'ready' : 'empty')
  }, [])

  /* 每次切回本页都重算：可能刚生成完一份新报告，也可能刚买完会员 */
  useDidShow(() => {
    void load()
  })

  const active = useMemo(
    () => targets.find((t) => t.personKey === activeKey) ?? null,
    [targets, activeKey]
  )

  /**
   * 关注多了以后选人条会很长，横滑找人很费劲 —— 超过 5 位才出现过滤框
   * （只有两三个人时多一个输入框纯属占地方）。
   * 只在**本机已有报告的这批人**里过滤：本页不做云搜索，「没有报告」的人本来就问不了，
   * 让用户搜到一个点不动的结果比搜不到更糟。
   */
  const visible = useMemo(() => {
    const kw = filter.trim().toLowerCase()
    if (!kw) return targets
    return targets.filter((t) => t.name.toLowerCase().includes(kw))
  }, [targets, filter])

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
    if (active) return { personKey: active.personKey, name: active.name, report: active }
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
        没有身份就没有归属），若还写「先去生成一份报告」，用户按指引走会先撞上登录流程 ——
        指引与真实原因不符，第一次点进底栏第二格的人会以为功能坏了。
      */}
      {phase === 'empty' && (
        <EmptyState
          icon={userId ? '💬' : '🔐'}
          title={userId ? '还没有可以提问的名人' : '登录后才能提问'}
          desc={
            userId
              ? 'AI 提问只依据已生成的报告素材回答。先去生成一份报告，TA 就会出现在这里。'
              : 'AI 提问依据你生成过的报告作答。先登录，再生成一份报告，就能在这里选人提问。'
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
              {/* 「不消耗生成额度」原先独占一行写在卡片底部（O-26 收进这里）：
                  它是选人前最该知道的一句话，但为它单独占一行要把人卡和会话区一起挤下去 */}
              <Text className='page-ask__picker-count'>
                {`${targets.length} 位有报告 · 提问不消耗生成额度`}
              </Text>
            </View>

            {targets.length > FILTER_FROM && (
              <Input
                className='page-ask__filter'
                value={filter}
                placeholder='搜索已生成报告的名人'
                confirmType='search'
                onInput={(e) => setFilter(e.detail.value)}
              />
            )}

            <ScrollView className='page-ask__people' scrollX>
              <View className='page-ask__people-inner'>
                {visible.map((t) => (
                  <View
                    key={t.personKey}
                    className={`page-ask__person${
                      t.personKey === activeKey ? ' page-ask__person--active' : ''
                    }`}
                    hoverClass='page-ask__person--tap'
                    onClick={() => setActiveKey(t.personKey)}
                  >
                    {/* 头像取姓名首字 + 领域色：与关注流 / 收藏页一致，横向滚动时比纯文字好认 */}
                    <View
                      className={`page-ask__avatar page-ask__avatar--${
                        parsePersonKey(t.personKey)?.domain ?? 'other'
                      }`}
                    >
                      {t.name.slice(0, 1)}
                    </View>
                    <Text className='page-ask__person-name'>{t.name}</Text>
                    <Text className='page-ask__person-meta'>{`${fromNow(t.generatedAt)} · ${
                      t.coverage?.items ?? t.dynamics.length
                    } 条`}</Text>
                  </View>
                ))}

                {visible.length === 0 && (
                  <Text className='page-ask__none'>没有匹配的名人；本页只能问已生成过报告的人</Text>
                )}
              </View>
            </ScrollView>

          </View>

          {/* safeBottom=false：本页根容器带了 .safe-tab（已含 env(safe-area-inset-bottom)），
              面板再让一次安全区会让输入框下方多出一整条空白
              compact：本页正上方就是选人条，面板头部不必再复述「多久前生成 · 素材 N 条」（O-26） */}
          <QaPanel report={active} member={member} safeBottom={false} compact />
        </>
      )}
    </View>
  )
}
