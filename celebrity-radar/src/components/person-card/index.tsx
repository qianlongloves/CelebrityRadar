import { View, Text } from '@tarojs/components'
/* 按需引入：'taro-ui' 的包入口（dist/index.js）是打包好的 CJS，50 个组件全在里面且摇不掉，
   故组件一律从 dist/components/<名字> 取（那一层是 ESM 源码）。用例 70 钉住这一点。 */
import AtButton from 'taro-ui/dist/components/button'
import { domainLabel, domainStyleCode } from '@/config/domains'
import PersonAvatar from '@/components/person-avatar'
import './index.scss'

export interface PersonInfo {
  personKey: string
  name: string
  /** 领域（自由短串，2026-10-12 领域自由化）：标签走 domainLabel、配色走 domainStyleCode */
  domain: string
  /** 一句代表事件 / 简介（消歧候选用） */
  brief?: string
  /** 动态关键词标签（热门位用） */
  tag?: string
  followed?: boolean
}

/**
 * 「是不是同一个人」的确认条（2026-10-18）。
 *
 * 场景：搜「雷军」时库里已经有一份「科技」的报告，而这是从别的领域/写法进来的同名候选。
 * 判据在 utils/person-index.ts（领域同组 → 用户别名 → 机构指纹），这里只负责**把结论摆出来**：
 * 强判据（机构命中）直接把两者并成一份，只留一个「不是这位」的出口；
 * 弱判据（只说档案里的所属机构对得上）不合并，先问一句。
 *
 * 文案由调用方组装（它知道领域标签与那份报告的身份），组件不认识业务。
 */
export interface PersonMergeHint {
  /** 一句话说明（如「已用『科技』那份报告：小米集团创始人」） */
  text: string
  /** 主按钮（确认是同一人）；不传则只显示次按钮（= 已经自动合并好了） */
  confirmLabel?: string
  onConfirm?: (p: PersonInfo) => void
  /** 次按钮（不是同一位）；两端都必须给，否则用户没有反悔的出口 */
  rejectLabel: string
  onReject: (p: PersonInfo) => void
}

interface PersonCardProps {
  person: PersonInfo
  /** 右侧操作：关注/取关 或 查看报告 等 */
  actionText?: string
  onAction?: (p: PersonInfo) => void
  onClick?: (p: PersonInfo) => void
  /**
   * 传入即在卡片上渲染关注按钮（消歧候选 / 热门位用）。
   * 此前这两处只有「查看报告」一个出口，想关注必须先跳到报告页或名人主页。
   */
  onToggleFollow?: (p: PersonInfo) => void
  /** 该卡片的关注请求进行中：按钮置灰，避免连点导致关注态来回翻转 */
  followPending?: boolean
  /**
   * 右侧两枚入口以**图标**呈现（热门位用）。
   *
   * 热门卡右侧同时有「关注」与「AI 报告」两个文字胶囊，加上头像与领域标签后，
   * 长名字（尤其英文名）会被挤到换行、领域标签被压变形。换成两枚 60rpx 图标圆后，
   * 名字与标签才留得出空间。
   * 消歧候选卡（「查看」）与对比名单（「对比」）保留文字：那里只有一枚按钮，
   * 图标反而丢了语义。
   */
  iconActions?: boolean
  /** 「是不是同一位」的确认条（见 PersonMergeHint） */
  merge?: PersonMergeHint
}

/** 名人卡：消歧候选、关注列表、热门位共用 */
export default function PersonCard({
  person,
  actionText,
  onAction,
  onClick,
  onToggleFollow,
  followPending,
  iconActions,
  merge
}: PersonCardProps) {
  /* 领域自由化后：配色 / 变体类统一经 domainStyleCode（未知领域复用 other），标签经 domainLabel（自创词原样展示） */
  const styleCode = domainStyleCode(person.domain)
  return (
    <View className='person-card' onClick={() => onClick?.(person)}>
      <PersonAvatar
        personKey={person.personKey}
        name={person.name}
        domain={person.domain}
        className={`person-card__avatar person-card__avatar--${styleCode}`}
      />
      <View className='person-card__main'>
        <View className='person-card__name-row'>
          <Text className='person-card__name'>{person.name}</Text>
          <View className={`chip chip--${styleCode}`}>{domainLabel(person.domain)}</View>
        </View>
        {(person.tag || person.brief) && (
          <View className='person-card__brief-row'>
            {person.tag && <View className='person-card__tag'>{person.tag}</View>}
            {person.brief && <View className='person-card__brief'>{person.brief}</View>}
          </View>
        )}
        {/*
          同一人判定提示（2026-10-18）：整块 stopPropagation —— 两个小按钮就在卡片里，
          不拦住的话点「不是这位」会先触发卡片的 onClick 直接跳进报告页。
        */}
        {merge && (
          <View
            className='person-card__merge'
            onClick={(e) => {
              e.stopPropagation?.()
            }}
          >
            <View className='person-card__merge-text'>{merge.text}</View>
            <View className='person-card__merge-actions'>
              {merge.confirmLabel && merge.onConfirm && (
                <View
                  className='person-card__merge-btn person-card__merge-btn--primary'
                  hoverClass='person-card__merge-btn--tap'
                  onClick={(e) => {
                    e.stopPropagation?.()
                    merge.onConfirm?.(person)
                  }}
                >
                  {merge.confirmLabel}
                </View>
              )}
              <View
                className='person-card__merge-btn'
                hoverClass='person-card__merge-btn--tap'
                onClick={(e) => {
                  e.stopPropagation?.()
                  merge.onReject(person)
                }}
              >
                {merge.rejectLabel}
              </View>
            </View>
          </View>
        )}
      </View>
      {/* 直接关注：描边式，视觉上弱于实心的主操作按钮（先关注、再看报告是更轻的路径） */}
      {onToggleFollow && (
        <View
          className={`person-card__follow ${iconActions ? 'person-card__follow--icon' : ''} ${
            person.followed ? 'person-card__follow--on' : ''
          } ${followPending ? 'person-card__follow--pending' : ''}`}
          hoverClass='person-card__follow--tap'
          onClick={(e) => {
            e.stopPropagation?.()
            if (!followPending) onToggleFollow(person)
          }}
        >
          {/* 图标态（热门位）的图标由 CSS 背景图给出，按钮内不再放文字 */}
          {!iconActions && (person.followed ? '已关注' : '关注')}
        </View>
      )}
      {actionText &&
        onAction &&
        (iconActions ? (
          /* 图标态（热门位）：只出一枚紫底 sparkle 圆，动作语义由「点击生成 AI 报告」的小标题兜住 */
          <View
            className='person-card__action-icon'
            hoverClass='person-card__action-icon--tap'
            onClick={(e) => {
              e.stopPropagation?.()
              onAction(person)
            }}
          />
        ) : (
          <AtButton
            size='small'
            type={person.followed ? 'secondary' : 'primary'}
            circle
            className='person-card__action'
            onClick={(e) => {
              e.stopPropagation?.()
              onAction(person)
            }}
          >
            {actionText}
          </AtButton>
        ))}
    </View>
  )
}
