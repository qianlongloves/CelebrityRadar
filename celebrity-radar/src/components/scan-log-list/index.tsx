import { Text, View } from '@tarojs/components'
import { SCAN_LOGS_MAX, SCAN_STATUS_LABEL } from '@/utils/scan-log'
import { formatMoment8 } from '@/utils/time'
import type { ScanLogRow } from '@/types/db'
import './index.scss'

/**
 * 执行日志（2026-10-17 抽出）。
 *
 * 此前这段 JSX 在预警页里**有两份逐行相同的副本**：关键词一路（`loadScanLogs('keyword', …)`）
 * 与名人一路（`loadScanLogs('person', …)`）。两处唯一的不同是数据来源，而渲染的三件事
 * （状态标签 / 时间与对象 / 备注或命中数）一模一样 —— 两份副本的真实代价不是多写了几行，
 * 而是「改一处忘另一处」：给日志加一列、换一个时间格式，另一张卡就会悄悄长成另一个样子。
 *
 * 抽成组件后仍然**只渲染、不做判断**：
 *   · 不决定读哪一路（kind 由调用方传给 `loadScanLogs`）；
 *   · 不决定要不要显示（`logs.length === 0` 由下面统一为「整块不渲染」，调用方不必再包一层
 *     `logs.length > 0 &&`）；
 *   · 条数上限取 `SCAN_LOGS_MAX`（真源），页面里写死的 `slice(0, 20)` 是同一个数的副本。
 */
type Props = {
  logs: ScanLogRow[]
  /**
   * 空数组时是否整块不渲染，默认 true。
   * 没有日志却渲染一个只有标题的框，会让人以为「加载坏了」。
   */
  hideWhenEmpty?: boolean
}

export default function ScanLogList({ logs, hideWhenEmpty = true }: Props) {
  if (hideWhenEmpty && logs.length === 0) return null
  /* 标题报的是**总条数**而不是渲染条数：被截掉的部分用户看不到，但「最近 37 次」是事实 */
  const shown = logs.slice(0, SCAN_LOGS_MAX)
  return (
    <View className='scan-log-list'>
      <Text className='scan-log-list__title'>执行日志（最近 {logs.length} 次）</Text>
      {shown.map((l) => (
        <View key={l.id} className='scan-log-list__row'>
          <Text className={`scan-log-list__status scan-log-list__status--${l.status}`}>
            {SCAN_STATUS_LABEL[l.status]}
          </Text>
          <Text className='scan-log-list__body'>
            {formatMoment8(l.ran_at)} · 「{l.object_name}」
            {l.note ? ` · ${l.note}` : l.hit > 0 ? ` · 命中 ${l.hit} 条` : ''}
          </Text>
        </View>
      ))}
    </View>
  )
}
