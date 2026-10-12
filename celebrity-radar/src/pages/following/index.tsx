import { useEffect, useState } from 'react'
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import Skeleton from '@/components/skeleton'
import PersonAvatar from '@/components/person-avatar'
import { listFollows, unfollow, FollowRow } from '@/utils/follows'
import { loadFollowWatches, FollowWatch, WATCH_LIMIT } from '@/utils/watch'
import { useAuth } from '@/stores/auth'
import { domainLabel, domainStyleCode, parsePersonKey } from '@/config/domains'
import { readPortraits } from '@/utils/portrait'
import { fromNow } from '@/utils/time'
import './index.scss'

/**
 * 「我关注的名人」二级页。
 *
 * 补的是数据层的空档：关注能力此前只有写入（profile 页 toggleFollow）与消费
 * （feed 页把关注人的动态聚合成流），用户无法回看/管理自己关注了谁。
 *
 * 增补「变化概览」：原先每人只有「关注于 X 天前」，是一份静态名单 —— 谁有动静
 * 必须逐个点进主页才知道，于是关注完就没有再回来的理由。现在每人带上热度 /
 * 动态条数 / 最近更新时间，并以 followed_at 为基线标出「关注以来有新内容」。
 * 数据取自 report_cache / feed_cache 两张已开放读权限的缓存表，无新增字段与云函数。
 */
export default function Following() {
  const { userId } = useAuth()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<FollowRow[]>([])
  const [watches, setWatches] = useState<Record<string, FollowWatch>>({})
  const [onlyNew, setOnlyNew] = useState(false)

  const load = async (force = false) => {
    setLoading(true)
    const list = await listFollows()
    setRows(list)
    /* 先出名单再补变化：变化要对每人多读两次缓存，等它一起出来白屏会明显更久。
       补数据是「基础信息 → 完整信息」的单向增补，不会回退，所以中间态不闪。 */
    setLoading(false)
    setWatches(await loadFollowWatches(list, { force }))
  }

  /* 每次进入都重取：从名人主页返回时，刚刚的关注/取关才能立刻反映到列表 */
  useDidShow(() => {
    void load()
  })

  usePullDownRefresh(async () => {
    /* 下拉是用户主动要「最新的」，必须穿透内存缓存 */
    await load(true)
    Taro.stopPullDownRefresh()
  })

  /* 与「关注流」一致：点击进名人主页（那里能看动态 / 名言，也能再次取关） */
  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/profile/index?personKey=${encodeURIComponent(personKey)}` })
  }

  const onUnfollow = async (personKey: string, name: string) => {
    const res = await Taro.showModal({
      title: '取消关注',
      content: `不再关注「${name}」？TA 的动态将不再出现在关注流。`,
      confirmText: '取消关注',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    /* 本地先移除，避免整页重拉导致列表闪烁 */
    if (await unfollow(personKey)) {
      setRows((prev) => prev.filter((r) => r.person_key !== personKey))
      Taro.showToast({ title: '已取消关注', icon: 'none' })
    }
  }

  const newCount = rows.filter((r) => watches[r.person_key]?.hasNew).length
  const visible = onlyNew ? rows.filter((r) => watches[r.person_key]?.hasNew) : rows

  /* 真图预热：关注列表一屏多人，一次批量读把全部人拉进缓存，避免逐行各打一次云函数 */
  useEffect(() => {
    if (rows.length > 0) void readPortraits(rows.map((r) => r.person_key))
  }, [rows])

  /** 一行内的活动描述；变化数据还没到时退回原有的关注时间，不留空白 */
  const activityText = (row: FollowRow, w?: FollowWatch): string => {
    if (!w) return `关注于 ${fromNow(row.followed_at)}`
    const parts = [w.newsCount > 0 ? `${w.newsCount} 条动态` : '暂无动态']
    if (w.feedAt) parts.push(`${fromNow(w.feedAt)}更新`)
    if (w.reportAt) parts.push(`报告 ${fromNow(w.reportAt)}`)
    return parts.join(' · ')
  }

  return (
    <View className='page-following glow-page'>
      {loading && <Skeleton variant='list' rows={5} />}

      {/* 未登录：listFollows 会直接返回空数组，靠文案区分「没登录」与「没关注」 */}
      {!loading && !userId && (
        <EmptyState
          icon='🔒'
          title='登录后可查看关注列表'
          desc='关注与收藏存在你的账号下，登录即可同步'
          actionText='去登录'
          onAction={() => Taro.switchTab({ url: '/pages/mine/index' })}
        />
      )}

      {!loading && userId && rows.length === 0 && (
        <EmptyState
          icon='🤝'
          title='还没有关注任何人'
          desc='在名人主页点「+ 关注」，TA 的公开动态会聚合到「关注流」'
          actionText='去发现名人'
          onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
        />
      )}

      {!loading && rows.length > 0 && (
        <View>
          <View className='section-head'>
            <Text className='section-head__title'>全部关注</Text>
            <Text className='section-head__extra'>{rows.length} 人 · 下拉刷新</Text>
          </View>

          {/* 有新内容才给筛选：没变化时多一排 chip 只是噪音 */}
          {newCount > 0 && (
            <View className='page-following__filters'>
              <Text
                className={`page-following__chip${onlyNew ? '' : ' page-following__chip--on'}`}
                onClick={() => setOnlyNew(false)}
              >
                全部 {rows.length}
              </Text>
              <Text
                className={`page-following__chip${onlyNew ? ' page-following__chip--on' : ''}`}
                onClick={() => setOnlyNew(true)}
              >
                有新内容 {newCount}
              </Text>
            </View>
          )}

          {visible.map((r) => {
            const domain = parsePersonKey(r.person_key)?.domain ?? 'other'
            const w = watches[r.person_key]
            return (
              <View
                key={r.id}
                className='card page-following__item'
                onClick={() => openPerson(r.person_key)}
              >
                <PersonAvatar
                  personKey={r.person_key}
                  name={r.name}
                  domain={domain}
                  className={`page-following__icon page-following__icon--${domainStyleCode(domain)}`}
                />
                <View className='page-following__info'>
                  <View className='page-following__title'>
                    <Text className='page-following__name'>{r.name}</Text>
                    {w?.hasNew && <Text className='page-following__badge'>有新内容</Text>}
                  </View>
                  <Text className='page-following__meta'>
                    {domainLabel(domain)}
                    {w && w.heat !== null ? ` · 热度 ${w.heat}` : ''}
                  </Text>
                  <Text className='page-following__time'>{activityText(r, w)}</Text>
                </View>
                <Text
                  className='page-following__op'
                  onClick={(e) => {
                    e.stopPropagation?.()
                    void onUnfollow(r.person_key, r.name)
                  }}
                >
                  取关
                </Text>
              </View>
            )
          })}

          {rows.length > WATCH_LIMIT && (
            <View className='disclaimer'>
              变化概览仅展示最近关注的 {WATCH_LIMIT} 位（每人要多读两次缓存，不做无上限拉取）
            </View>
          )}
          <View className='disclaimer'>关注列表仅自己可见；「我的 → 清空我的数据」会一并删除</View>
        </View>
      )}
    </View>
  )
}
