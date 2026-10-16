import { useEffect, useState } from 'react'
import Taro, { useRouter } from '@tarojs/taro'
import { View, Text, WebView } from '@tarojs/components'
/* 按需引入：'taro-ui' 的包入口（dist/index.js）是打包好的 CJS，50 个组件全在里面且摇不掉，
   故组件一律从 dist/components/<名字> 取（那一层是 ESM 源码）。用例 70 钉住这一点。 */
import AtButton from 'taro-ui/dist/components/button'
import EmptyState from '@/components/empty-state'
import { publicConfig } from '@/config/public'
import { decodeParam } from '@/utils/route'
import './index.scss'

/**
 * 原文预览页（报告页「近期动态」与「最新报道」的落点）。
 *
 * 存在的理由：报告里的素材链接原先点一下只把 URL 丢进剪贴板，用户拿到的是一串字符，
 * 看不到这条素材到底讲了什么。这里先把素材本身摊开 —— 标题 / 来源 / 时间 / 摘要 ——
 * 再给出「复制链接」这条一定能走通的路。
 *
 * 为什么不直接打开网页：微信要求 web-view 的目标域名事先在公众平台登记为业务域名，
 * 而报告的素材来自任意媒体，不可能逐一登记。登记过的域名（publicConfig.webviewDomains）
 * 会真正内嵌打开；其余走上面的预览卡降级路径 —— 不假装能打开，但把能给的都给到。
 */

function hostOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url || '')
  if (!m) return ''
  return (m[1] ?? '').replace(/^www\./i, '')
}

/**
 * 白名单命中判定：填 example.com 时 news.example.com 也命中。
 * 子域要单独在后台登记，但运营配置时应按「同一个站点」理解，不该逼运营枚举所有子域。
 */
function hitWhitelist(host: string): boolean {
  if (!host) return false
  return publicConfig.webviewDomains.some((d) => {
    const base = d.trim().replace(/^www\./i, '').toLowerCase()
    return base !== '' && (host === base || host.endsWith(`.${base}`))
  })
}

export default function LinkPreviewPage() {
  const router = useRouter()
  /* query 的值由报告页 encodeURIComponent 处理过（见 pages/report 的 openSource） */
  const url = decodeParam(router.params.url || '')
  const title = decodeParam(router.params.title || '')
  const source = decodeParam(router.params.source || '')
  const date = decodeParam(router.params.date || '')
  const summary = decodeParam(router.params.summary || '')

  /* 内嵌加载失败（域名未登记 / 站点拒绝内嵌）时退回预览卡，别把用户晾在一片空白上 */
  const [failed, setFailed] = useState(false)

  const host = hostOf(url)
  const hit = hitWhitelist(host)
  const isWeb = Taro.getEnv() === Taro.ENV_TYPE.WEB
  /* H5 端没有业务域名一说，iframe 可以直接承载；小程序端只有登记过的域名能内嵌 */
  const canEmbed = url !== '' && !failed && (isWeb || hit)

  useEffect(() => {
    /* 内嵌时页面上不放信息条（会被 web-view 原生层盖住），域名只能写在导航栏上 */
    if (isWeb || !host) return
    void Taro.setNavigationBarTitle({ title: host })
  }, [host, isWeb])

  /** 复制链接：setClipboardData 自带系统提示，再补一句「下一步做什么」（会覆盖前者） */
  const copy = () => {
    Taro.setClipboardData({ data: url })
    Taro.showToast({ title: '链接已复制，粘贴到浏览器打开', icon: 'none' })
  }

  /** 浏览器新窗口打开：仅 H5 有 window，小程序端不存在这条通路 */
  const openInBrowser = () => {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank')
    }
  }

  if (!url) {
    return (
      <View className='page-link-preview'>
        <EmptyState icon='🔗' title='链接缺失' desc='这条素材没有可用的原文地址' />
      </View>
    )
  }

  if (canEmbed) {
    return (
      <View className='page-link-preview__embed'>
        <WebView src={url} onError={() => setFailed(true)} />
      </View>
    )
  }

  const meta = [source || host, date].filter(Boolean).join(' · ')

  return (
    <View className='page-link-preview glow-page'>
      <View className='card'>
        <View className='page-link-preview__site'>
          {/* 拿不到站点图标，也不该为一张图多发一次请求：用域名首字做占位标识 */}
          <View className='page-link-preview__mark'>{(host[0] || '🔗').toUpperCase()}</View>
          <Text className='page-link-preview__host'>{host || '来源站点'}</Text>
        </View>
        <View className='page-link-preview__title'>{title || '查看原文'}</View>
        {meta !== '' && <View className='page-link-preview__meta text-tertiary'>{meta}</View>}
        {summary && <View className='page-link-preview__summary text-secondary'>{summary}</View>}
      </View>

      <View className='card'>
        <View className='card-title'>{failed ? '内嵌打开失败' : '关于原文链接'}</View>
        <View className='page-link-preview__note text-secondary'>
          {failed
            ? '这个站点不允许在小程序内打开，原文已备好链接，复制后到浏览器即可查看。'
            : '微信要求网站先在公众平台登记为业务域名，才能在小程序内直接打开。该来源尚未登记，因此这里给出素材本身与原文链接。'}
        </View>
        <View className='page-link-preview__ops'>
          <AtButton type='primary' circle onClick={copy}>
            复制链接
          </AtButton>
          {isWeb && (
            <AtButton type='secondary' circle onClick={openInBrowser}>
              在浏览器打开
            </AtButton>
          )}
        </View>
      </View>
    </View>
  )
}
