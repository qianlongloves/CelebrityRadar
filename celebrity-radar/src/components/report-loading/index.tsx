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

/**
 * 秒级等待计时器。
 *
 * 抽出来是因为「全屏等待态」与「悬浮刷新卡」用的是同一套时长口径，但刷新卡的秒数
 * 必须留在组件自己的 state 里：报告页是整站最重的一屏（六段正文 + 十几个子组件），
 * 若把秒数提到页面 state，一次刷新会让整页每秒重渲染一次。
 */
function useElapsedSeconds(active = true): number {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [active])

  return elapsed
}

/** 按等待时长取阶段文案：两处共用同一份 STAGES，避免各自维护一套说法（早晚会不一致） */
function stageLabel(elapsed: number): string {
  return (STAGES.filter((s) => elapsed >= s.at).pop() ?? STAGES[0]).label
}

/** 参照进度（封顶 92%，与 MAX_PROGRESS 同源）；纯展示，不代表后端精确进度 */
function progressPercent(elapsed: number): number {
  return Math.min(MAX_PROGRESS, Math.round((elapsed / ESTIMATED_SECONDS) * 100))
}

/**
 * 等待动画本体：双环反向旋转 + 中心脉冲。
 *
 * 抽成独立组件是因为「全屏等待态」与「悬浮刷新卡」共用这一颗动画（2026-10-10）；
 * 两处连尺寸都不做差异（曾把刷新卡缩到 0.72 再裁切，观感就不再是「同一个动画」了）。
 * 动画本身若各写一份，改一处忘一处迟早会走样。
 */
function LoadingOrbit() {
  return (
    <View className='report-loading__orbit'>
      <View className='report-loading__ring report-loading__ring--outer' />
      <View className='report-loading__ring report-loading__ring--inner' />
      <View className='report-loading__core-wrap'>
        <View className='report-loading__core'>AI</View>
      </View>
    </View>
  )
}

interface LoadingBodyProps {
  /** generating：本机正在生成；waiting：他人持锁，本机排队等待 */
  mode?: 'generating' | 'waiting'
  /**
   * 覆盖底部小字（仅文案随场景变）。
   *
   * 之所以只放开这一个口子：刷新场景说「首次生成约需 30 秒」是错的，只能换说法；
   * 但环、阶段文案、进度条三者必须与全屏等待态逐项同源，否则「一致」就无从谈起。
   */
  hint?: string
}

/**
 * 等待体：双环动画 + 阶段文案 + 进度条 + 底部小字。
 *
 * 「全屏等待态」（ReportLoading）与「悬浮刷新卡」（ReportRefreshing）现在渲染的是**同一个**
 * LoadingBody：同尺寸、同结构、同动画，差别只剩外层容器（整页留白 vs 悬浮卡片）。
 */
function LoadingBody({ mode = 'generating', hint }: LoadingBodyProps) {
  const elapsed = useElapsedSeconds(mode === 'generating')

  const waiting = mode === 'waiting'
  const stage = waiting ? '其他用户正在生成同一份报告，已为你排队…' : stageLabel(elapsed)
  const progress = progressPercent(elapsed)

  const tip =
    hint !== undefined
      ? hint
      : waiting
        ? '无需刷新，生成完成后会自动展示'
        : elapsed >= ESTIMATED_SECONDS
          ? `已等待 ${elapsed} 秒，请保持页面开启`
          : '首次生成约需 30 秒，生成后再次打开秒开'

  return (
    <>
      <LoadingOrbit />

      <View className='report-loading__stage'>{stage}</View>

      <View className='report-loading__bar'>
        <View
          className={waiting ? 'report-loading__bar-fill report-loading__bar-fill--waiting' : 'report-loading__bar-fill'}
          style={{ width: waiting ? '100%' : `${progress}%` }}
        />
      </View>

      <Text className='report-loading__hint'>{tip}</Text>
    </>
  )
}

/** 深度报告生成等待态（§2.4 边界态：loading / waiting 共用）；骨架屏只在这一态出现 */
export default function ReportLoading({ mode = 'generating' }: ReportLoadingProps) {
  return (
    <View className='report-loading'>
      <LoadingBody mode={mode} />

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

/**
 * 「重新生成」全屏加载浮层（2026-10-10 三次改版 → 四改：改成真浮层）。
 *
 * 补的是什么：重新生成走的是**非破坏式刷新** —— utils/cache.ts#getOrBuildReport 让旧报告留在
 * 屏上，新报告好了再整体替换。但此前这条路径**只有底部按钮转圈**：从顶部「重新生成为深度报告」
 * 点进来的用户停在页面顶端，而唯一的反馈在两千多行之外的页脚，于是就「点了没反应 → 再点一次」，
 * 而每点一次都是真实的一次生成请求（免费版一天只有 3 次）。所以必须有浮在最上面的进度反馈。
 *
 * 四改修的是什么：三改的卡片样式本就是 `position: fixed` + 居中，但报告页根节点是
 * `.page-report.glow-page`，而 `app.scss` 里的 `.glow-page > view { position: relative; z-index: 1 }`
 * （特异性 0,1,1）**盖掉**了组件自己的 `position: fixed` —— 卡片被按回文档流、z-index 只剩 1，
 * 于是不是「浮在正中」，而是挤在页面最顶部、还能被后续正文压住。用法上表现为
 * 「加载动画没在最顶层、也没覆盖页面」。修法有两半，缺一不可：
 *   ① 根节点加 `glow-overlay`（见 app.scss，把 (0,1,1) 那条规则挡掉，由它给死 fixed + z-index）；
 *   ② 直接铺**全屏蒙层**：原先三改刻意不铺蒙层（好让旧报告仍可读），但那样在深色横幅/长文页上
 *      浮层边界并不清晰，用户仍会觉得「没盖住」。既然这条路径只有十几到三十几秒，就明确锁住页面，
 *      也让「正在生成」这件事无法被误读成「页面卡住了」。
 * 卡内渲染的仍是与全屏等待态**同一个** LoadingBody（同尺寸、同结构、同动画），本组件只提供容器。
 *
 * catchMove 拦掉 touchmove：否则蒙层只是视觉上盖住，手指在它上面滑动仍会滚动底下的报告，
 * 用户会看到「盖着一张卡，内容却在滚」。蒙层没有点击回调、也不可关闭 —— 它是进行态而非提示条，
 * 中途关掉只会让用户以为生成被取消（会在页面停留十余秒的假象）。
 */
export function ReportRefreshing() {
  return (
    <View className='report-refreshing glow-overlay' catchMove>
      <View className='report-refreshing__mask' />
      <View className='report-refreshing__card'>
        <LoadingBody hint='生成完成后自动替换当前这一版' />
      </View>
    </View>
  )
}
