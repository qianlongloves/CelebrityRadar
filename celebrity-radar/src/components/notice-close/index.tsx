import { Text } from '@tarojs/components'
import './index.scss'

/**
 * 提示条关闭键（2026-10-10）。
 *
 * 需求：**所有「文字提示的框」都要能关掉**。此前全站只有会员促销条（page-report__vip）
 * 带 ✕，其余提示条（侧重条 / 刷新结果条 / 降级警示条 / 问答提示条 / 关注流失败条 / 周报警示条）
 * 都只能干等它自己消失 —— 有的还永不消失（降级警示、失败重试条会一直挂着）。
 *
 * 抽成一个组件是为了让下面三件事在各处**逐字一致**（各写一份迟早会走样）：
 *   ① 永远 stopPropagation —— 好些提示条整条是可点区域（会员条跳转、feed 失败条重试），
 *      不拦住就成了「想关掉提示，结果触发了提示的动作」；
 *   ② 热区够大 —— 字号 24rpx 的「✕」本体只有约 24rpx 见方，靠 padding 撑到约 40rpx，
 *      再用负外边距把视觉留白收回去（父级条都有 24rpx 左右内边距，负值不会顶到边框）；
 *   ③ color: inherit + margin-left: auto —— 深浅底、品牌底都不必再配色；在 flex 行里
 *      自动贴到右端，无需调用方给正文加 flex:1（列布局的提示条请自行包一层 __main）。
 *
 * 关不关、关掉后记不记得住，由调用方决定（一般用页面 state）——本组件只负责「点一下，然后回调」。
 */
export default function NoticeClose({ onClose }: { onClose: () => void }) {
  return (
    <Text
      className='notice-close'
      onClick={(e: { stopPropagation?: () => void }) => {
        e.stopPropagation?.()
        onClose()
      }}
    >
      ✕
    </Text>
  )
}
