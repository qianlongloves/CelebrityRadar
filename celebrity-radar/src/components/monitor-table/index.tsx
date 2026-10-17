import { Text, View } from '@tarojs/components'
import { SCAN_STATUS_LABEL } from '@/utils/scan-log'
import type { ScanLogRow } from '@/types/db'
import { fromNow } from '@/utils/time'
import './index.scss'

/**
 * 监控状态表（2026-10-17 抽出）。
 *
 * 此前预警页里**两份逐行相同的表格**：关键词一张、名人一张。4 列表头、行结构、状态色
 * 完全一致，差异只有「取哪份数据算这一行」。两份副本最贵的不是行数，是**列宽与状态色的
 * 两套真相**：改一处列宽、另一张表就会跟着歪，而两张表就并排在同一条滚动流里。
 *
 * 组件只负责「把行摆好」：
 *   · 行数据由调用方算（`result` 已经是一句话，口径见 utils/scan-log#monitorResultText）；
 *   · 表头文字固定在这里 —— 两张表说的是同一件事，就不该有两个说法；
 *   · `pending` 是**端上造的状态**（还没有任何执行记录），不在 `scan_logs` 的枚举里，
 *     所以不能直接查 `SCAN_STATUS_LABEL`（查不到会渲染出 undefined）。
 */
type RowStatus = ScanLogRow['status'] | 'pending'

export type MonitorRow = {
  /** 稳定唯一键（删除后 React 才不会复用错行） */
  id: string
  /** 第一列：被监控的对象（关键词 / 人名） */
  label: string
  /** 最近执行时刻；空串 = 还没扫过 */
  lastRan: string
  /** 「命中 / 结果」这一格的整句（由调用方按统一口径算好） */
  result: string
  status: RowStatus
  /** 推送定位命中的那一行：整行换底色，帮用户在一屏里一眼找到 */
  focused?: boolean
}

type Props = {
  rows: MonitorRow[]
  /** 是否渲染表头（默认渲染）；多张表连续排列时可关掉避免重复 */
  showHead?: boolean
}

export default function MonitorTable({ rows, showHead = true }: Props) {
  if (rows.length === 0) return null
  return (
    <View className='monitor-table'>
      {showHead && (
        <View className='monitor-table__tr monitor-table__tr--head'>
          <Text className='monitor-table__td monitor-table__td--obj'>监控对象</Text>
          <Text className='monitor-table__td'>最近执行</Text>
          <Text className='monitor-table__td'>命中 / 结果</Text>
          <Text className='monitor-table__td monitor-table__td--status'>状态</Text>
        </View>
      )}
      {rows.map((r) => (
        <View key={r.id} className={`monitor-table__tr${r.focused ? ' monitor-table__tr--focus' : ''}`}>
          <Text className='monitor-table__td monitor-table__td--obj'>{r.label}</Text>
          <Text className='monitor-table__td'>{r.lastRan ? fromNow(r.lastRan) : '待首次扫描'}</Text>
          <Text className='monitor-table__td'>{r.result}</Text>
          <Text className={`monitor-table__td monitor-table__td--status monitor-table__status--${r.status}`}>
            {r.status === 'pending' ? '待扫描' : SCAN_STATUS_LABEL[r.status]}
          </Text>
        </View>
      ))}
    </View>
  )
}
