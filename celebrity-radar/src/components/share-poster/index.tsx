import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text, Image, Canvas, ScrollView } from '@tarojs/components'
import {
  POSTER_CANVAS_ID,
  POSTER_WIDTH,
  QUOTE_POSTER_HEIGHT,
  QuoteCardInput,
  renderQuotePoster,
  saveImageToAlbum
} from '@/utils/share-card'
import { track } from '@/utils/events'
import { toUserMessage } from '@/utils/error'
import './index.scss'

/**
 * 分享图弹层。
 *
 * 组件挂载即出图：离屏 canvas 就画在同一个节点树里（屏幕外，见 index.scss），
 * 由 utils/share-card 负责绘制，这里只管「画布多大、图放哪、按了什么」。
 *
 * 为什么不做成页面：卡片是报告页 / 收藏页 / 周报页上的一个动作，跳页会丢掉原页面的滚动位置与上下文，
 * 而弹层关掉就回到原处，用户还要接着往下读。
 *
 * P4-B（2026-10-13）：从「只画名言卡」收敛成**两种内容共用一套弹层** —— 名言卡（给 `quote`）
 * 与周报简报（给 `render` + `height`）。保存相册的权限处理、失败降级、转发菜单、离屏画布与
 * 像素比处理全部复用同一段代码，两种分享图的行为不会漂移。
 */
interface SharePosterProps {
  /** 名言卡内容：与 `render` 二选一（都缺则出图失败并如实提示，不白屏） */
  quote?: QuoteCardInput
  /** 自定义出图函数（如周报简报 `renderWeeklyBriefPoster`）：与 `quote` 二选一 */
  render?: () => Promise<string>
  /** 画布逻辑高度（px）；缺省按名言卡 3:4 竖版。必须与 `render` 实际画的高度一致 */
  height?: number
  /** 面板标题 */
  title?: string
  /** 底部提示（说明图上带了什么合规角标） */
  hint?: string
  /** 给了就在动作区多出一个「复制摘要」按钮（内容由调用方保证与图一致） */
  copyText?: string
  /** 埋点在动作发生时记录，不带 personKey 的调用方直接传空 */
  personKey?: string
  onClose: () => void
}

export default function SharePoster({
  quote,
  render,
  height,
  title = '名言卡',
  hint = '图片带「基于公开信息 AI 整理，仅供参考」角标与小程序码',
  copyText,
  personKey = '',
  onClose
}: SharePosterProps) {
  /** 出图结果：本地临时路径，喂给 <Image> 与两个动作按钮 */
  const [path, setPath] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const posterHeight = height ?? QUOTE_POSTER_HEIGHT

  useEffect(() => {
    let alive = true
    /* 两种内容来源二选一：给了自定义 render 就用它，否则回落到名言卡。
       名言卡带上 personKey：页脚的小程序码据此指向这个人的报告页（见 utils/share-code.ts） */
    const draw = render ?? (quote ? () => renderQuotePoster({ ...quote, personKey }) : null)
    if (!draw) {
      setError('缺少卡片内容')
      return
    }
    draw()
      .then((tempPath) => {
        if (alive) setPath(tempPath)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setError(toUserMessage(err, '卡片生成失败，请重试'))
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

  /** 复制文本摘要（内容与图一致，由调用方给全）——纯本地，不依赖出图结果 */
  const onCopy = () => {
    if (!copyText || busy) return
    Taro.setClipboardData({ data: copyText })
    track('share', { personKey, channel: 'poster_copy' })
    Taro.showToast({ title: '摘要已复制', icon: 'none' })
  }

  return (
    /*
      根节点必须同时挂 `glow-overlay`（层级口径见 app.scss），否则**它根本不是弹层**。
      宿主页（报告 / 收藏 / 周报）的根容器都带 `.glow-page`，而 app.scss 里
      `.glow-page > view { position: relative; z-index: 1 }` 的特异性是 (0,1,1)，
      盖过组件自己 `.share-poster { position: fixed; z-index: 1000 }` 的 (0,1,0) ——
      于是这个「全屏浮层」被按回文档流，长图直接摊在页面最下方、撑开一条长滚动。
      这正是用户报「保存长图不是弹框、在页面下方突出一段长图」的成因，不是布局细节问题。
      `glow-overlay` 以 (0,2,0) 把 position / z-index 放回来，同时压过 custom-tab-bar 的 999。
    */
    <View className='share-poster glow-overlay'>
      {/* catchMove：遮罩上滑动不该把底下的报告页一起滚走（与 report-refreshing 同一口径） */}
      <View className='share-poster__mask' catchMove onClick={onClose} />

      {/* 离屏画布：必须真实存在（display:none 会让节点查询拿不到），故放到屏幕外 */}
      <Canvas
        type='2d'
        id={POSTER_CANVAS_ID}
        className='share-poster__canvas'
        style={{ width: `${POSTER_WIDTH}px`, height: `${posterHeight}px` }}
      />

      <View className='share-poster__panel'>
        <View className='share-poster__head'>
          <Text className='share-poster__title'>{title}</Text>
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
            /*
              预览必须是**可滚动**的（2026-10-16）。名言卡是 3:4 竖版、一屏放得下，
              但报告长图能到几千 px —— 此前用 `max-height + overflow: hidden` 硬裁，
              长图只剩最上面一截，用户既看不到下面的内容、也不知道自己被裁了，
              而这张图马上要进相册 / 发给别人，看不到就无从核对（用户反馈的另一半成因）。
              固定 58vh 视口 + 纵向滚动，等价「原尺寸逐段看」，短卡片则自动无滚动条。
            */
            <ScrollView className='share-poster__scroll' scrollY>
              <Image className='share-poster__preview' src={path} mode='widthFix' showMenuByLongpress />
            </ScrollView>
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
          {copyText ? (
            <View
              className={`share-poster__btn share-poster__btn--ghost ${
                busy ? 'share-poster__btn--disabled' : ''
              }`}
              onClick={onCopy}
            >
              复制摘要
            </View>
          ) : null}
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
        <Text className='share-poster__hint'>{hint}</Text>
      </View>
    </View>
  )
}
