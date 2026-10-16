import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import Skeleton from '@/components/skeleton'
import {
  deleteMessage,
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
 * 本页四处交互口径：
 *
 * 1) **已读逐条记**。进页面不再自动全标已读 —— 点开哪条标哪条，没看的留着下次看；
 *    顶部给一个「全部已读」的出口。首页红点取自同一份未读数，所以红点会在真正看过之后才熄灭。
 * 2) **长内容默认折叠**（两行），点卡片展开 / 收起。公告类文案常在 55 字以上，
 *    全部铺开会把列表拉成一篇长文，「扫一眼有哪些消息」这件事就做不成了。
 * 3) **短内容保持原有习惯**：点一下直接进详情页（没有可展开的东西，就不该多一步）。
 *    长内容展开后才在卡片底部给「查看详情 ›」—— 展开的是内容，跳转要用户明确点。
 * 4) **删除是逐条的、本机的、要二次确认的**（2026-10-10 新增）。做成卡片底部一个「删除」小字，
 *    不藏进长按手势：长按没有任何可见线索，用户得先被告知才会用，而这一页本来就没有
 *    值得教的隐藏操作。删除只在本机隐藏这一条（口径见 utils/messages.ts#deleteMessage），
 *    所以确认弹窗里写清「不影响关注与周报」，避免用户以为删了会丢数据而不敢点。
 *
 * 本页**不做**「清空全部」：消息是「有新内容」类通知，逐条删才对应「这条我看过了」的本意；
 * 一键清空更容易被误触，且清完明天照样有新消息，收益与风险不成比例。
 *
 * 报告更新（N-2 回访，2026-10-16）落在这里、不新开页面：它的问题（「我看过的人后来变了吗」）
 * 已经有一个能回答「改了什么」的落地页 —— 报告历史页的差异视图（N-9）。消息行只说「变过」，
 * 点进去才是条数与条目级的差异，两处说不重复的东西。判据与代价见 utils/revisit.ts。
 */

const KIND_ICON: Record<MessageKind, string> = {
  follow: '📣',
  weekly: '📊',
  /* 报告更新（N-2 回访）：与「关注的人有新动态」分开一个图标 —— 两件事的问题不同
     （我盯的人有新信号 / 我看过的人的结论变了），图标混用会让列表看起来只有一种消息 */
  report: '🔄',
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
      /*
       * 回访理由（N-2）：只在真有「看过的名人报告更新了」时上报。
       * 一律上报会让这个数变成「打开次数」（与 messages_open 重复，分母失去意义）；
       * 只在 >0 时报，`revisit_ready / messages_open` 就是**带理由打开的比例**——
       * 那正是「站内回访够不够用」要看的数（推送已被类目限制冻结，见路线图 D8）。
       */
      if (feed.revisitTotal > 0) track('revisit_ready', { count: feed.revisitTotal })
    })
    return () => {
      alive = false
    }
  }, [])

  /* 未读数按当前列表实时算：点开一条就少一条，顶部文案与「全部已读」按钮跟着变 */
  const unread = items.filter((i) => i.unread).length

  const readOne = (id: string, at: string) => {
    markMessageRead(id, at)
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, unread: false } : i)))
  }

  const readAll = () => {
    if (unread === 0) return
    markAllMessagesRead(items.map((i) => ({ id: i.id, at: i.at })))
    setItems((prev) => prev.map((i) => ({ ...i, unread: false })))
    void Taro.showToast({ title: '已全部标为已读', icon: 'none' })
  }

  /**
   * 删除单条（2026-10-10 新增）。
   *
   * 先弹确认再落笔：这里删掉的是「入口」，而这条消息背后的关注 / 周报并不会变 ——
   * 误删一个「张三 有新动态」的代价是**这一条**再也找不回来（本机记录，云端无副本）。
   * 文案里那半句「不影响关注与周报」不是客套：它正好回答了「删了会不会漏掉什么」。
   *
   * 成功后同步清掉展开态：条目都没了，`expanded` 里留着 id 只是垃圾。
   */
  const removeOne = (m: MessageItem) => {
    void Taro.showModal({
      title: '删除这条消息？',
      content: '只在本机隐藏这一条，不影响关注与周报；之后的新消息仍会送达',
      confirmText: '删除',
      cancelText: '取消'
    }).then((res) => {
      if (!res.confirm) return
      deleteMessage(m.id, m.at)
      setItems((prev) => prev.filter((x) => x.id !== m.id))
      setExpanded((prev) => prev.filter((x) => x !== m.id))
      void Taro.showToast({ title: '已删除', icon: 'none' })
    })
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
    /*
     * 报告更新（N-2）点开时单独记一笔：`messages_open` 只能回答「有没有人用消息中心」，
     * 回答不了「回访理由有没有把人带回报告里」。按人聚合（personKey）之后还能看出
     * 「是少数几个人反复被点开，还是分散在很多名人上」—— 后者才说明回访是可规模化的理由。
     */
    if (m.kind === 'report' && m.personKey) track('revisit_open', { personKey: m.personKey })
    if (m.url) {
      void Taro.navigateTo({ url: m.url })
      return
    }
    void Taro.switchTab({ url: '/pages/index/index' })
  }

  /**
   * 卡片点击：先标已读；长内容切展开 / 收起，短内容直接进详情。
   *
   * 底部「查看详情 ›」与「删除」都**不单独绑事件** —— 它们冒泡到卡片，由这里的角色分流处理。
   * 不依赖 `stopPropagation`：小程序的 bindtap 是原生冒泡，JS 侧不一定拦得住，
   * 拦不住就会「跳转 + 顺手切换展开态」两件事一起发生。
   *
   * 「删除」必须**在标已读之前**分流：一条马上要消失的消息不该再改动未读数
   * （否则首页红点会凭空跳一下，删掉一条反而像「读了一条」）。
   */
  const onCardTap = (m: MessageItem, role?: string) => {
    if (role === 'del') {
      removeOne(m)
      return
    }
    readOne(m.id, m.at)
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
              这里原本有两个描边胶囊：「关键词预警 ›」与「关注流 ›」。
              2026-10-09 全部迁出：预警入口移到首页铃铛左侧（图标），关注流入口首页已有
              「关注 N」胶囊 —— 同一页顶部塞三条去向，等于替用户做选择，去掉后本页只留
              「消息中心」这一件事，右上角仅保留作用于本页的「全部已读」。
            */}
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
          desc='关注几位名人后 TA 们的动态会出现在这里；你看过的名人报告更新时也会提醒你'
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
                      {/* 删除入口：与上面两个动作同排但不同色（见 scss），免得手滑删掉 */}
                      <Text className='page-messages__del' data-role='del'>
                        删除
                      </Text>
                    </View>
                  </View>
                </View>
              </View>
            )
          })}
        </View>
      )}
      <View className='disclaimer'>
        消息仅自己可见；本机已读与删除记录随「清空我的数据」一并清除
      </View>
    </View>
  )
}
