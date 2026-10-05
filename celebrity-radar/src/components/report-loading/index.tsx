import { useEffect, useState } from 'react'
import { View, Text } from '@tarojs/components'
import './index.scss'

/**
 * 生成阶段提示：按等待时长推进，文案对应真实链路（检索素材 → 阅读筛选 → 生成六段），
 * 仅用于缓解等待焦虑，不代表后端精确进度。
 */
const STAGES: Array<{ at: number; label: string }> = [
  { at: 0, label: '正在检索公开网络信息…' },
  { at: 4, label: '正在阅读并筛选素材…' },
  { at: 12, label: '正在生成六段深度报告…' },
  { at: 28, label: '报告内容较长，仍在生成中…' }
]

/** 进度条参照值（秒）；封顶 92%，不做“假装已完成”的满格 */
const ESTIMATED_SECONDS = 35
const MAX_PROGRESS = 92

interface ReportLoadingProps {
  /** generating：本机正在生成；waiting：他人持锁，本机排队等待 */
  mode?: 'generating' | 'waiting'
}

/** 深度报告生成等待态（§2.4 边界态：loading / waiting 共用） */
export default function ReportLoading({ mode = 'generating' }: ReportLoadingProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (mode !== 'generating') return undefined
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [mode])

  const waiting = mode === 'waiting'
  const stage = waiting
    ? '其他用户正在生成同一份报告，已为你排队…'
    : (STAGES.filter((s) => elapsed >= s.at).pop() ?? STAGES[0]).label
  const progress = Math.min(MAX_PROGRESS, Math.round((elapsed / ESTIMATED_SECONDS) * 100))

  return (
    <View className='report-loading'>
      <View className='report-loading__orbit'>
        <View className='report-loading__ring report-loading__ring--outer' />
        <View className='report-loading__ring report-loading__ring--inner' />
        <View className='report-loading__core-wrap'>
          <View className='report-loading__core'>AI</View>
        </View>
      </View>

      <View className='report-loading__stage'>{stage}</View>

      <View className='report-loading__bar'>
        <View
          className={waiting ? 'report-loading__bar-fill report-loading__bar-fill--waiting' : 'report-loading__bar-fill'}
          style={{ width: waiting ? '100%' : `${progress}%` }}
        />
      </View>

      <Text className='report-loading__hint'>
        {waiting
          ? '无需刷新，生成完成后会自动展示'
          : elapsed >= ESTIMATED_SECONDS
            ? `已等待 ${elapsed} 秒，请保持页面开启`
            : '首次生成约需 30 秒，生成后再次打开秒开'}
      </Text>

      <View className='report-loading__skeleton'>
        <View className='rl-sk'>
          <View className='rl-sk__line rl-sk__line--title' />
          <View className='rl-sk__line' />
          <View className='rl-sk__line rl-sk__line--mid' />
        </View>
        <View className='rl-sk'>
          <View className='rl-sk__line rl-sk__line--title' />
          <View className='rl-sk__line' />
          <View className='rl-sk__line rl-sk__line--mid' />
        </View>
        <View className='rl-sk rl-sk--brand'>
          <View className='rl-sk__line rl-sk__line--title' />
          <View className='rl-sk__line' />
          <View className='rl-sk__line rl-sk__line--mid' />
        </View>
      </View>
    </View>
  )
}
