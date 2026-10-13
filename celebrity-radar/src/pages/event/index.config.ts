export default definePageConfig({
  /*
   * 事件时间线页（从舆情页事件卡 navigateTo 进入，**不是 tab 页**）。
   * 下拉刷新重取一次事件；触底加载更多（客户端分段渲染，见 utils/opinion-access#pageSlice）。
   * 返回走小程序默认导航栏（navigateTo 打开的二级页自带返回）。
   */
  navigationBarTitleText: '事件时间线',
  enablePullDownRefresh: true,
  onReachBottomDistance: 80
})
