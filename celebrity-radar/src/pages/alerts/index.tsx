import { useCallback, useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { Input, Text, View } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import {
  addWatch,
  alertLevelLabel,
  AlertGroup,
  isNewItem,
  KEYWORD_MAX_CHARS,
  loadAlerts,
  listWatches,
  markAllSeen,
  MAX_WATCHES,
  removeWatch,
  WatchRow
} from '@/utils/keyword-alert'
import { alertNotifyConfigured, requestAlertNotify } from '@/utils/notify'
import { openSourceLink } from '@/utils/source-link'
import EmptyState from '@/components/empty-state'
import './index.scss'

/**
 * 关键词舆情预警（2026-10-08）。
 *
 * 这一页只做两件事：**管订阅**（最多 5 个词）与**看预警**（云端每天检索出的新报道）。
 *
 * 为什么页面上没有「立即扫描」：检索一次就是一次上游计费，把扫描做成按钮等于把成本开关
 * 交给点击频率（改包还能无限刷）。新内容一律由云函数 keywordAlert 每天跑一次，
 * 端上只读缓存 —— 预警的产品语义本来就是「等消息」，不是「查消息」。
 *
 * 为什么列表当收件箱用（已读的条目留在原地、只去掉「新」标记）：全部只给未读的话，
 * 用户看过一次就再也找不回那几条报道了。列表读到之后再调 markAllSeen（顺序见其注释）。
 */
export default function Alerts() {
  const { userId } = useAuth()

  /** 我的订阅（用来渲染 chips 与「已监测 N/5」） */
  const [watches, setWatches] = useState<WatchRow[]>([])
  /** 预警分组（按等级 + 最近检索时间排序） */
  const [groups, setGroups] = useState<AlertGroup[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  /** 提交中：防止连点造成两个并发的 addWatch（后一个会撞主键） */
  const [submitting, setSubmitting] = useState(false)

  const refresh = useCallback(async () => {
    if (!userId) {
      setWatches([])
      setGroups([])
      setLoading(false)
      return
    }
    const [rows, res] = await Promise.all([listWatches(), loadAlerts()])
    setWatches(rows)
    setGroups(res.groups)
    setLoading(false)
    /* 标记已看必须在读之后：反了会把本次刚读出的条目直接算成已读 */
    if (res.groups.length) void markAllSeen(res.groups.map((g) => g.keyword))
  }, [userId])

  useDidShow(() => {
    void refresh()
  })

  const handleAdd = async () => {
    if (submitting) return
    setSubmitting(true)
    const res = await addWatch(input)
    setSubmitting(false)
    Taro.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' })
    if (res.ok) {
      setInput('')
      void refresh()
    }
  }

  const handleRemove = (keyword: string) => {
    void Taro.showModal({
      title: '取消监测',
      content: `不再监测「${keyword}」？已有的预警记录会一并从列表移除。`,
      confirmText: '取消监测',
      cancelText: '再想想',
      success: async (r) => {
        if (!r.confirm) return
        const ok = await removeWatch(keyword)
        if (ok) void refresh()
      }
    })
  }

  const handleNotify = async () => {
    const res = await requestAlertNotify()
    Taro.showToast({ title: res.message, icon: res.ok ? 'success' : 'none' })
  }

  /**
   * 关键词 → 主题速览（pages/topic）。
   *
   * 预警列表回答「最近被报道了多少条」，但用户看完往往还有一问：**别处都是怎么讲这个词的**。
   * 主题页只读本机已缓存的报告做编目（零检索、零模型调用、不消耗生成额度），
   * 与报告页词云的落点是同一个 —— 这里多给一个入口，但页面语义完全一致。
   */
  const goTopic = (keyword: string) => {
    void Taro.navigateTo({
      url: `/pages/topic/index?topic=${encodeURIComponent(keyword)}&from=alerts`
    })
  }

  /** 条目的时间展示：优先媒体发布时间，缺失时退回我们首次看到它的时间 */
  const itemDate = (item: AlertGroup['items'][number]) => {
    const raw = item.published_date ?? item.first_seen_at
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const newTotal = groups.reduce((n, g) => n + g.newCount, 0)
  const notifyReady = alertNotifyConfigured()

  return (
    <View className='page-alerts'>
      {/* 订阅管理 */}
      <View className='card'>
        <View className='card-title'>关键词监测</View>
        <Text className='page-alerts__intro'>
          {watches.length
            ? `正在监测 ${watches.length}/${MAX_WATCHES} 个词，云端每天检索一次公开报道。`
            : `最多可监测 ${MAX_WATCHES} 个词（人名、公司、事件都行），云端每天检索一次公开报道。`}
        </Text>

        {userId ? (
          <View className='page-alerts__composer'>
            <Input
              className='page-alerts__input'
              value={input}
              maxlength={KEYWORD_MAX_CHARS}
              placeholder={`输入关键词，不超过 ${KEYWORD_MAX_CHARS} 字`}
              confirmType='done'
              onInput={(e) => setInput(e.detail.value)}
              onConfirm={() => void handleAdd()}
            />
            <View
              className={`page-alerts__submit${submitting || !input.trim() ? ' page-alerts__submit--off' : ''}`}
              hoverClass='page-alerts__submit--tap'
              onClick={() => void handleAdd()}
            >
              <Text>开始监测</Text>
            </View>
          </View>
        ) : (
          <Text className='page-alerts__login-tip'>登录后可订阅关键词（去「我的」页一键登录）</Text>
        )}

        {watches.length > 0 && (
          <View className='page-alerts__chips'>
            {watches.map((w) => (
              <View
                key={w.id}
                className='page-alerts__chip'
                hoverClass='page-alerts__chip--tap'
                onClick={() => handleRemove(w.keyword)}
              >
                <Text>{w.keyword}</Text>
                <Text className='page-alerts__chip-x'>×</Text>
              </View>
            ))}
          </View>
        )}

        {/*
          推送按钮只在「模板已配置 + 已订阅」时出现：未配置还摆一个按钮，
          点了必然失败（微信要求模板先在小程序后台申请），那是拿用户的点击换一条报错。
        */}
        {userId && watches.length > 0 && notifyReady && (
          <View className='page-alerts__notify'>
            <View
              className='page-alerts__notify-btn'
              hoverClass='page-alerts__notify-btn--tap'
              onClick={() => void handleNotify()}
            >
              <Text>开启每日提醒</Text>
            </View>
            <Text className='page-alerts__notify-tip'>微信一次性订阅：开一次收一次，每次收到后可再开</Text>
          </View>
        )}
      </View>

      {/* 预警列表 */}
      {!userId || watches.length === 0 ? (
        <EmptyState
          title={userId ? '还没有监测中的关键词' : '登录后可用'}
          desc={
            userId
              ? '添加一个关键词，比如你关心的名人、公司或事件；有新的公开报道时会汇总到这里'
              : '关键词预警按账号保存，登录后即可订阅'
          }
        />
      ) : loading ? (
        <View className='card page-alerts__hint'>
          <Text>正在读取预警…</Text>
        </View>
      ) : groups.length === 0 ? (
        <View className='card page-alerts__hint'>
          <Text className='page-alerts__hint-title'>已开始监测，暂无相关报道</Text>
          <Text className='page-alerts__hint-desc'>
            {notifyReady
              ? '云端每天上午检索一次，有新报道时会出现在这里并提醒你一次。'
              : '云端每天上午检索一次，有新报道时会出现在这里。'}
          </Text>
        </View>
      ) : (
        <>
          {newTotal > 0 && (
            <Text className='page-alerts__summary'>{`本次新增 ${newTotal} 条报道`}</Text>
          )}
          {groups.map((g) => (
            <View key={g.keyword} className='card page-alerts__group'>
              <View className='page-alerts__group-head'>
                <Text className='page-alerts__group-keyword'>{g.keyword}</Text>
                {g.level !== 'calm' && (
                  <Text className={`page-alerts__badge page-alerts__badge--${g.level}`}>
                    {alertLevelLabel(g.level)}
                  </Text>
                )}
                <Text className='page-alerts__group-count'>
                  {g.newCount > 0 ? `新增 ${g.newCount} 条` : `最近 ${g.items.length} 条`}
                </Text>
              </View>

              {g.items.map((item) => (
                <View
                  key={item.url}
                  className='page-alerts__item'
                  hoverClass='page-alerts__item--tap'
                  onClick={() =>
                    openSourceLink({
                      url: item.url,
                      title: item.title,
                      source: item.source,
                      date: itemDate(item),
                      summary: item.summary
                    })
                  }
                >
                  <View className='page-alerts__item-head'>
                    {isNewItem(item, watches.find((w) => w.keyword === g.keyword)?.seen_at ?? null) && (
                      <Text className='page-alerts__new'>新</Text>
                    )}
                    <Text className='page-alerts__item-title'>{item.title}</Text>
                  </View>
                  <Text className='page-alerts__item-meta'>
                    {[item.source, itemDate(item)].filter(Boolean).join(' · ')}
                  </Text>
                </View>
              ))}

              {/* 预警说「有多少条」，这里去回答「都怎么讲」——两者的数据源不同，
                  文案必须写清是「已收录的报告」，免得被读成这批预警的汇总。 */}
              <View
                className='page-alerts__topic'
                hoverClass='page-alerts__topic--tap'
                onClick={() => goTopic(g.keyword)}
              >
                <Text>看已收录报告的「{g.keyword}」话题 ›</Text>
              </View>
            </View>
          ))}
        </>
      )}

      <Text className='disclaimer'>
        预警来自公开报道的检索结果，只反映「最近被报道的量」，不代表平台对任何人的评价；
        点开每条可查看原文出处。
      </Text>
    </View>
  )
}
