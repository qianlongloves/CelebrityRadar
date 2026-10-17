import Taro from '@tarojs/taro'

/**
 * 页面参数的安全解码（2026-10-16）。
 *
 * 为什么不能直接写 `decodeURIComponent(router.params.x || '')`：它对**非法百分号编码**会抛
 * URIError（以 `%` 结尾、`%zz`、被截断的多字节序列都算）。而这些参数全部来自不可信的入口 ——
 * 转发卡片、小程序码的 scene、订阅消息的 page、聊天记录里的旧链接，任一处被截断都会带进来
 * 一个残串。URIError 在 render 期间抛出就是**整页白屏**（React 渲染中抛错，页面什么都不剩，
 * 用户连「返回」之外无路可走），而「参数丢了」本来只是一个可以解释、可以给出路的失败。
 *
 * 所以统一出口：解码失败退回空串，让页面走各自的「参数缺失」分支（例如 package/report 的
 * 「这条链接没带上要看的人」），而不是崩掉。空串也正好是端上各处 `|| 默认值` 的既有约定，
 * 故替换是逐字等价的，不改变任何正常路径的行为。
 *
 * ⚠ 只用于**页面参数**。云端返回的业务数据不要经过这里：那些若是坏编码，属于数据问题，
 * 偷偷吞掉只会让问题更难查（该由 rawLog / diagLog 暴露）。
 */
export function decodeParam(value?: string | null): string {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    /* 解码失败即当作「没带这个参数」：比白屏好，也比抛给用户一个技术错误好 */
    return ''
  }
}

/**
 * 返回上一页；**没有上一页**时改去 fallback（2026-10-17）。
 *
 * 为什么需要这个：`Taro.navigateBack()` 在栈底（首个页面）会失败，而失败是**静默**的 ——
 * 用户点了「返回」却停在原地，看起来像按钮坏了。栈底不是边缘情况：订阅消息、小程序码、
 * 转发卡片、聊天记录里的旧链接，打开时页面栈里都只有这一页，而事件时间线页（`package/event`）
 * 恰恰是最常被分享和推送的一页。
 *
 * 所以判据取「退不动了就换一条路」，而不是先数栈深：navigateBack 的失败本身就是最准确的
 * 判断依据，且不依赖 `getCurrentPages()` 在各端的一致性。
 *
 * ⚠ 只用于**返回**语义。`redirectTo` 会替换当前页 —— 想「进一页、还能退回来」的场景必须用
 * `navigateTo`，两页互相有入口时尤其要分清（见 package/workbench 的 goAlerts 注释）。
 */
export function goBackOr(fallbackUrl?: string): void {
  Taro.navigateBack().catch(() => {
    if (fallbackUrl) void Taro.redirectTo({ url: fallbackUrl })
  })
}

