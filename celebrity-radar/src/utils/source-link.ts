import Taro from '@tarojs/taro'

/**
 * 「原文预览」页（pages/link-preview）的入参 + 唯一的跳转入口。
 *
 * 为什么从 report 页抽到 utils：这条跳转现在有两个来源 ——
 *   ① 报告页的「近期动态」标题 / 「最新报道」标题（原实现所在处）；
 *   ② 新增的名言「出处核对」面板（名言的 source 本身就是一条素材链接，
 *      核对时最该给的动作就是「点开原文」）。
 * 两处各写一份拼串，迟早出现一处带 summary、一处不带，预览页时好时坏。
 *
 * 小程序内无法直接打开任意外部网页（web-view 要求域名先登记为业务域名），
 * 因此统一落到 pages/link-preview：先摊开标题 / 来源 / 时间 / 摘要，
 * 再给「复制链接」这条一定走得通的路。
 */
export interface SourceLink {
  url: string
  title?: string
  source?: string
  /** 时间展示文案：由调用方先格式化好（动态是 YYYY-MM-DD，最新报道是「3 天前」这类相对时间） */
  date?: string
  summary?: string
}

/**
 * 摘要进 query 前的截断长度。
 * 页面路径长度在小程序端有硬限制（超长会直接跳转失败），而预览卡读开头一段就够。
 */
const PREVIEW_SUMMARY_CHARS = 160

/** 打开一条素材的原文预览；空 url 只提示、不跳转（预览页没有 url 会渲染成空态） */
export function openSourceLink(item: SourceLink): void {
  if (!item.url) {
    Taro.showToast({ title: '该条暂无链接', icon: 'none' })
    return
  }
  const summary = item.summary ?? ''
  const query = Object.entries({
    url: item.url,
    title: item.title ?? '',
    source: item.source ?? '',
    date: item.date ?? '',
    /* 超长摘要截断后补省略号：预览卡看到的是「一段摘要」，不是被生硬切掉的半句 */
    summary:
      summary.length > PREVIEW_SUMMARY_CHARS ? `${summary.slice(0, PREVIEW_SUMMARY_CHARS)}…` : summary
  })
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  void Taro.navigateTo({ url: `/pages/link-preview/index?${query}` })
}
