import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import Skeleton from '@/components/skeleton'
import {
  loadMessages,
  markAllMessagesRead,
  markMessageRead,
  MessageItem,
  MessageKind
} from '@/utils/messages'
import { fromNow } from '@/utils/time'
import { track } from '@/utils/events'
import './index.scss'

/**
 * 消息中心：首页右上角铃铛的落点。
 *
 * 数据来源与三条取舍见 utils/messages.ts（全部由端上已有数据算出来，没有新集合、没有新云函数）。
 * 本页三处交互口径：
 *
 * 1) **已读逐条记**。进页面不再自动全标已读 —— 点开哪条标哪条，没看的留着下次看；
 *    顶部给一个「全部已读」的出口。首页红点取自同一份未读数，所以红点会在真正看过之后才熄灭。
 * 2) **长内容默认折叠**（两行），点卡片展开 / 收起。公告类文案常在 55 字以上，
 *    全部铺开会把列表拉成一篇长文，「扫一眼有哪些消息」这件事就做不成了。
 * 3) **短内容保持原有习惯**：点一下直接进详情页（没有可展开的东西，就不该多一步）。
 *    长内容展开后才在卡片底部给「查看详情 ›」—— 展开的是内容，跳转要用户明确点。
 */

const KIND_ICON: Record<MessageKind, string> = {
  follow: '📣',
  weekly: '📊',
  system: '📢'
}

/** 折叠阈值（字符数）：约两行 —— 24rpx 字号下卡片内可用宽度约 520rpx，每行 ≈ 21 字 */
const FOLD_LIMIT = 42

/** 内容是否超过折叠阈值 */
function foldable(m: MessageItem): boolean {
  return m.desc.length > FOLD_LIMIT
}

export default function Messages() {
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<MessageItem[]>([])
  const [truncated, setTruncated] = useState(false)
  /** 已展开的条目 id：只有长内容才有意义 */
  const [expanded, setExpanded] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    void loadMessages().then((feed) => {
      if (!alive) return
      setItems(feed.items)
      setTruncated(feed.truncated)
      setLoading(false)
      /* 埋点取「打开时」的未读数：与逐条标记无关，口径是入口使用率 */
      track('messages_open', { unread: feed.unread, total: feed.items.length })
    })
    return () => {
      alive = false
    }
  }, [])

  /* 未读数按当前列表实时算：点开一条就少一条，顶部文案与「全部已读」按钮跟着变 */
  const unread = items.filter((i) => i.unread).length

  const readOne = (id: string) => {
    markMessageRead(id)
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, unread: false } : i)))
  }

  /** 去看关注流（O-17）：消息里的「关注的人有新内容」，内容本体在关注流页 */
  const goFeed = () => {
    void Taro.navigateTo({ url: '/pages/feed/index' })
  }

  /**
   * 去看关键词预警。
   *
   * 铃铛是「有事情发生」的统一落点：关键词命中新报道既不该混进关注流（它不是某个名人
   * 的更新），也不该只靠订阅消息触达（订阅授权会耗尽）。放一个常显入口在这里，
   * 用户被推送召回后也有地方能翻历史命中，不至于「点完就断」。
   */
  const goAlerts = () => {
    void Taro.navigateTo({ url: '/pages/alerts/index' })
  }

  const readAll = () => {
    if (unread === 0) return
    markAllMessagesRead(items.map((i) => i.id))
    setItems((prev) => prev.map((i) => ({ ...i, unread: false })))
    void Taro.showToast({ title: '已全部标为已读', icon: 'none' })
  }

  /**
   * 打开条目（O-17）。
   *
   * `system` 类平台公告**没有跳转目标**（见 utils/messages.ts，它只有文案），
   * 此前的 `if (!m.url) return` 让这类卡片的点击变成「什么都不发生」——
   * 用户点一次、两次，只会得出「这页是坏的」。现在没有 url 就兜底去发现页：
   * 公告的下一步本来就该是「平台现在有什么可看的」，停在原地是最差的答案。
   */
  const open = (m: MessageItem) => {
    if (m.url) {
      void Taro.navigateTo({ url: m.url })
      return
    }
    void Taro.switchTab({ url: '/pages/index/index' })
  }

  /**
   * 卡片点击：先标已读；长内容切展开 / 收起，短内容直接进详情。
   *
   * 底部「查看详情 ›」**不单独绑事件** —— 它冒泡到卡片，由这里的角色分流处理。
   * 不依赖 `stopPropagation`：小程序的 bindtap 是原生冒泡，JS 侧不一定拦得住，
   * 拦不住就会「跳转 + 顺手切换展开态」两件事一起发生。
   */
  const onCardTap = (m: MessageItem, role?: string) => {
    readOne(m.id)
    if (role === 'link' || !foldable(m)) {
      open(m)
      return
    }
    setExpanded((prev) => (prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id]))
  }

  const summary = loading
    ? '正在汇总…'
    : items.length === 0
      ? '暂无消息'
      : unread > 0
        ? `${unread} 条未读 · 共 ${items.length} 条`
        : `全部已读 · 共 ${items.length} 条`

  return (
    <View className='page-messages glow-page'>
      <View className='page-messages__head'>
        <View className='page-messages__head-row'>
          <Text className='page-messages__title'>消息中心</Text>
          <View className='page-messages__head-ops'>
            {/*
              去看关注流（O-17）：消息中心是「关注的人有新内容」的落点，但看完消息之后
              最该去的下一步是关注流本身 —— 这里原本没有任何通向内容本体的入口，
              等于把人送进一条死胡同。入口常显（0 关注时也可点，由关注流页自己引导）。
            */}
            {/* 关键词预警入口：与「关注流 ›」同为描边胶囊（都是「去向」而非「动作」） */}
            <Text className='page-messages__feed' onClick={goAlerts}>
              关键词预警 ›
            </Text>
            <Text className='page-messages__feed' onClick={goFeed}>
              关注流 ›
            </Text>
            {!loading && unread > 0 && (
              <Text className='page-messages__read-all' onClick={readAll}>
                全部已读
              </Text>
            )}
          </View>
        </View>
        <Text className='page-messages__sub'>{summary}</Text>
      </View>

      {loading ? (
        <Skeleton variant='list' rows={3} />
      ) : items.length === 0 ? (
        <EmptyState
          icon='🔔'
          title='暂无新消息'
          desc='关注几位名人后，TA 们的报告更新与动态会出现在这里'
          actionText='去发现页看看'
          onAction={() => void Taro.switchTab({ url: '/pages/index/index' })}
        />
      ) : (
        <View className='page-messages__list'>
          {items.map((m) => {
            const fold = foldable(m)
            const isOpen = expanded.includes(m.id)
            return (
              <View
                key={m.id}
                className={`page-messages__item page-messages__item--${m.unread ? 'unread' : 'read'}`}
                hoverClass='page-messages__item--tap'
                onClick={(e) => onCardTap(m, e.target?.dataset?.role as string | undefined)}
              >
                <View
                  className={`page-messages__icon page-messages__icon--${m.kind}`}
                >
                  {KIND_ICON[m.kind]}
                </View>
                <View className='page-messages__body'>
                  <View className='page-messages__row'>
                    <Text className='page-messages__name'>{m.title}</Text>
                    {m.unread && <View className='page-messages__dot' />}
                  </View>
                  <Text
                    className={`page-messages__desc${fold && !isOpen ? ' page-messages__desc--clamp' : ''}`}
                  >
                    {m.desc}
                  </Text>
                  <View className='page-messages__foot'>
                    <Text className='page-messages__time'>{fromNow(m.at)}</Text>
                    <View className='page-messages__acts'>
                      {fold && (
                        <Text className='page-messages__fold'>{isOpen ? '收起' : '展开全文'}</Text>
                      )}
                      {m.url && (!fold || isOpen) && (
                        <Text className='page-messages__link' data-role='link'>
                          查看详情 ›
                        </Text>
                      )}
                    </View>
                  </View>
                </View>
              </View>
            )
          })}
        </View>
      )}

      {!loading && truncated && (
        <View className='disclaimer'>
          关注更新仅覆盖最近关注的 30 位（每位需读两次缓存，不做无上限拉取）
        </View>
      )}
      <View className='disclaimer'>消息仅自己可见；本机已读记录随「清空我的数据」一并清除</View>
    </View>
  )
}
