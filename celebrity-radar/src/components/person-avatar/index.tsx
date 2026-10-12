import { useEffect, useState } from 'react'
import { View, Image } from '@tarojs/components'
import { domainStyleCode } from '@/config/domains'
import { ensurePortrait, getPortraitCache, subscribePortrait } from '@/utils/portrait'
import './index.scss'

interface PersonAvatarProps {
  /**
   * 人物主键（name#domain）。缺失 = 定位不到人，只画今天的占位、不发任何取图请求。
   */
  personKey?: string
  name: string
  /** 领域（自由短串）：仅在不传 className（独立使用）时用于拼 `--{领域码}` 渐变类 */
  domain: string
  /**
   * 站点原有头像类名，**原样透传**。
   *
   * 这是本组件唯一能保证「只把首字换成照片、尺寸/圆角/描边/配色都不动」的方式 ——
   * 各页头像的盒模型与配色（圆形渐变 / 实色圆 / 圆角方 / 半透明）都写在各页 SCSS 里，
   * 组件自己重画一套必然与其中若干处对不上。故站点类名怎么写，照片元素就挂什么类。
   */
  className?: string
  /** 独立使用（不传 className）时的直径，如 '108rpx'；站点自带类名时不必传 */
  size?: string
}

/**
 * 名人头像（共享）。有真图（云存储 fileID）就画照片，没有就**逐字复用今天的占位**：
 * `View` + `--{领域码}` 渐变类 + 姓名首字。取图在挂载时 fire-and-forget，
 * 不设 loading、不阻塞渲染，晚到的 fileID 由 portrait.ts 的订阅通知本组件重绘。
 *
 * 【2026-10-12 结构性尺寸保证】照片**永远**画在一个与占位盒同尺寸的外层盒里，而不是把站点类名
 * 直接挂到 `<Image>` 上：小程序 `<Image>` 默认尺寸是 320×240px，若某处站点类名没写死宽高，
 * 照片就会顶着这个默认尺寸撑破布局（报告页整页左右可滑动的根因之一）。
 * 现在外层盒始终是那个「原来的占位 View」（站点类名/尺寸**原样**挂在它身上），`<Image>` 只是它的
 * 子元素、由 `person-avatar__img` 保证 100%×100% 铺满 —— 于是「照片必须与占位盒同尺寸」变成结构约束，
 * 不再依赖每个调用点都恰好把宽高写全。
 */
export default function PersonAvatar({ personKey, name, domain, className, size }: PersonAvatarProps) {
  /* 首帧就同步读缓存：命中直接出图，避免「先闪一下占位再跳照片」 */
  const [fileId, setFileId] = useState(() => (personKey ? getPortraitCache().get(personKey) ?? '' : ''))

  useEffect(() => {
    if (!personKey) {
      setFileId('')
      return
    }
    /* 切人（personKey 变化）时先同步到当前缓存，再订阅后续更新 */
    setFileId(getPortraitCache().get(personKey) ?? '')
    const unsubscribe = subscribePortrait((key) => {
      if (key === personKey) setFileId(getPortraitCache().get(personKey) ?? '')
    })
    /* 未命中才补图：命中（含批量读预热过的人）不再打云函数 */
    if (!getPortraitCache().has(personKey)) void ensurePortrait(personKey, name)
    return unsubscribe
  }, [personKey, name])

  const cls = className ?? `person-avatar person-avatar--${domainStyleCode(domain)}`
  const style = size ? { width: size, height: size } : undefined
  const hasPhoto = !!(personKey && fileId)

  return (
    <View className={`${cls} person-avatar__box`} style={style}>
      {hasPhoto ? (
        /* 圆形/圆角由外层站点类名的 border-radius 给出（__box 的 overflow:hidden 负责裁剪），
           aspectFill 保证照片裁满盒子不拉伸 */
        <Image className='person-avatar__img' src={fileId} mode='aspectFill' />
      ) : (
        name.slice(0, 1)
      )}
    </View>
  )
}
