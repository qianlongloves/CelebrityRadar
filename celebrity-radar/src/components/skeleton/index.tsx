import { View } from '@tarojs/components'
import './index.scss'

interface SkeletonProps {
  /** 骨架块数量 */
  rows?: number
  /**
   * list：单行（图标 + 两行文字），用于关注列表 / 收藏列表
   * card：卡片（标题 + 两行正文）
   * feed：动态卡（头像行 + 标题 + 两行摘要）
   */
  variant?: 'list' | 'card' | 'feed'
  /** 顶部是否带统计双列卡骨架（关注流用） */
  withStats?: boolean
  className?: string
}

/**
 * 通用骨架屏。
 *
 * 原先各页加载态都是「整页居中一个转圈」，列表结构要等数据回来才出现，
 * 视觉上是一次跳变。骨架屏先把版面立起来，再让真实内容原地替换，
 * 感知等待时间明显更短。
 */
export default function Skeleton({
  rows = 4,
  variant = 'card',
  withStats = false,
  className = ''
}: SkeletonProps) {
  const withHead = variant === 'list' || variant === 'feed'

  return (
    <View className={`sk ${className}`}>
      {withStats && (
        <View className='sk__stats'>
          <View className='sk__stat' />
          <View className='sk__stat' />
        </View>
      )}

      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} className='sk__card'>
          {withHead && (
            <View className='sk__head'>
              <View className={variant === 'feed' ? 'sk__avatar sk__avatar--round' : 'sk__avatar'} />
              <View className='sk__head-lines'>
                <View className='sk__line sk__line--name' />
                <View className='sk__line sk__line--sub' />
              </View>
            </View>
          )}

          {variant !== 'list' && (
            <>
              <View className='sk__line sk__line--title' />
              <View className='sk__line' />
              <View className='sk__line sk__line--short' />
            </>
          )}
        </View>
      ))}
    </View>
  )
}
