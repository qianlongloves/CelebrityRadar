import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text, Image, Canvas } from '@tarojs/components'
import {
  POSTER_CANVAS_ID,
  POSTER_WIDTH,
  QUOTE_POSTER_HEIGHT,
  QuoteCardInput,
  renderQuotePoster,
  saveImageToAlbum
} from '@/utils/share-card'
import { track } from '@/utils/events'
import './index.scss'

/**
 * 名言卡弹层。
 *
 * 组件挂载即出图：离屏 canvas 就画在同一个节点树里（屏幕外，见 index.scss），
 * 由 utils/share-card 负责绘制，这里只管「画布多大、图放哪、按了什么」。
 *
 * 为什么不做成页面：卡片是报告页 / 收藏页上的一个动作，跳页会丢掉原页面的滚动位置与上下文，
 * 而弹层关掉就回到原处，用户还要接着往下读。
 */
interface SharePosterProps {
  /** 画什么：调用方直接把内容给全，弹层不回头去取数据 */
  quote: QuoteCardInput
  /** 埋点在动作发生时记录，不带 personKey 的调用方直接传空 */
  personKey?: string
  onClose: () => void
}

export default function SharePoster({ quote, personKey = '', onClose }: SharePosterProps) {
  /** 出图结果：本地临时路径，喂给 <Image> 与两个动作按钮 */
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    renderQuotePoster(quote)
      .then((tempPath) => {
        if (alive) setPath(tempPath)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
    // 出图只发生在弹层打开的那一刻，依赖保持为空是刻意的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 保存到相册：成功才埋点，失败（未授权 / 存储满）不算一次分享 */
  const onSave = async () => {
    if (!path || busy) return
    setBusy(true)
    const ok = await saveImageToAlbum(path)
    setBusy(false)
    if (!ok) return
    track('share', { personKey, channel: 'poster_save' })
    Taro.showToast({ title: '已保存到相册', icon: 'none' })
  }

  /** 拉微信图片转发菜单：path 必须是本地 / 临时路径，出图结果正好满足 */
  const onShare = async () => {
    if (!path || busy) return
    setBusy(true)
    try {
      await Taro.showShareImageMenu({ path })
      track('share', { personKey, channel: 'poster_share' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      /* 用户在转发面板点了取消也是 fail，不该当成错误弹提示 */
      if (!/cancel/i.test(msg)) Taro.showToast({ title: '分享失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className='share-poster'>
      <View className='share-poster__mask' onClick={onClose} />

      {/* 离屏画布：必须真实存在（display:none 会让节点查询拿不到），故放到屏幕外 */}
      <Canvas
        type='2d'
        id={POSTER_CANVAS_ID}
        className='share-poster__canvas'
        style={{ width: `${POSTER_WIDTH}px`, height: `${QUOTE_POSTER_HEIGHT}px` }}
      />

      <View className='share-poster__panel'>
        <View className='share-poster__head'>
          <Text className='share-poster__title'>名言卡</Text>
          <Text className='share-poster__close' onClick={onClose}>
            ✕
          </Text>
        </View>

        <View className='share-poster__stage'>
          {error !== '' ? (
            <View className='share-poster__error'>
              <Text className='share-poster__error-title'>卡片生成失败</Text>
              <Text className='share-poster__error-msg'>{error}</Text>
            </View>
          ) : path === '' ? (
            <View className='share-poster__loading'>
              <Text>正在生成卡片…</Text>
            </View>
          ) : (
            <Image className='share-poster__preview' src={path} mode='widthFix' showMenuByLongpress />
          )}
        </View>

        <View className='share-poster__actions'>
          <View
            className={`share-poster__btn share-poster__btn--ghost ${
              !path || busy ? 'share-poster__btn--disabled' : ''
            }`}
            onClick={() => void onSave()}
          >
            保存到相册
          </View>
          <View
            className={`share-poster__btn share-poster__btn--primary ${
              !path || busy ? 'share-poster__btn--disabled' : ''
            }`}
            onClick={() => void onShare()}
          >
            分享给朋友
          </View>
        </View>

        {/* 图上已画免责角标，弹层里再说一次是为了「还没保存就看到」而不是保存后才发现 */}
        <Text className='share-poster__hint'>图片带「AI 生成，仅供参考」角标</Text>
      </View>
    </View>
  )
}
