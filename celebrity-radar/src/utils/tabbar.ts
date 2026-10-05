import { eventCenter, useDidShow } from '@tarojs/taro'

/**
 * 自定义 tabBar 的选中态同步（消费方见 src/custom-tab-bar/index.tsx）。
 *
 * 为什么要由外部触发：真机上 tabBar 实例会跨页复用，切 tab 并不重新 mount 组件，
 * 「mount 时读一次当前路由」的写法会让选中态停在旧页面上 ——
 * 现象就是「点的是收藏，高亮的还是发现」。故由各个 tab 页在 onShow 时发一次信号，
 * tabBar 收到后重新读路由对齐。
 *
 * 放 utils 而非组件内：页面只该依赖一个生命周期钩子，不必为此把组件模块拉进包。
 */
export const TABBAR_SYNC_EVENT = 'tabbar:sync'

/** tab 页接入：在页面组件顶层调用一次即可，无需关心信号如何被消费 */
export function useTabBarSync(): void {
  useDidShow(() => {
    eventCenter.trigger(TABBAR_SYNC_EVENT)
  })
}
