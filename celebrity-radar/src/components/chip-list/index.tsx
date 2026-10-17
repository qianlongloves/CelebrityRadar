import { Text, View } from '@tarojs/components'
import './index.scss'

/**
 * 「名单 + ×」胶囊排（2026-10-17 抽出）。
 *
 * 此前预警页里有**三份逐字相同的 JSX**：关键词的、订阅对象的、名人的。三处的差异只有
 * 「点一下做什么」和「推送定位命中的那一个要不要换实底」，而结构（排 / 胶囊 / × /
 * hover 透明度）完全一样。抽出来之后，视觉是一份、交互回调由调用方给。
 *
 * 刻意保持很薄：
 *   · **不做二次确认**。关键词删除与取消监控要弹确认、取消订阅不要 —— 那是调用方的事
 *     （写在 onTap 里），组件若自作主张加一层弹窗，三处的语义就被强行拉平了；
 *   · **不判空**。`items.length === 0` 时调用方本来就不该渲染这一块（空块会占一行间距），
 *     这里返回 null 只是兜底；
 *   · 用泛型 + 三个访问器，而不是要求调用方先把数据映射成 `{id,label}`：订阅对象那里
 *     label 同时是主键、名人那里要拿 person_key，"先映射一层"会把主键语义在调用处重新起名。
 */
type Props<T> = {
  items: T[]
  /** 列表 key（必须稳定且唯一，否则删除后 React 会复用错行） */
  keyOf: (item: T) => string
  /** 胶囊上的文字 */
  labelOf: (item: T) => string
  /** 是否是「推送定位命中的那一个」—— 换实底品牌色，帮用户在一排胶囊里一眼找到 */
  isFocused?: (item: T) => boolean
  /** 点一下（这里就是「取消」） */
  onTap: (item: T) => void
}

export default function ChipList<T>({ items, keyOf, labelOf, isFocused, onTap }: Props<T>) {
  if (items.length === 0) return null
  return (
    <View className='chip-list'>
      {items.map((item) => (
        <View
          key={keyOf(item)}
          className={`chip-list__chip${isFocused?.(item) ? ' chip-list__chip--focus' : ''}`}
          hoverClass='chip-list__chip--tap'
          onClick={() => onTap(item)}
        >
          <Text>{labelOf(item)}</Text>
          <Text className='chip-list__x'>×</Text>
        </View>
      ))}
    </View>
  )
}
