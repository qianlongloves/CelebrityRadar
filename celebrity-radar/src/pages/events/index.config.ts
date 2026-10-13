export default definePageConfig({
  /*
   * 事件列表页（从舆情页事件卡的「查看全部事件 ›」进入，**不是 tab 页**）。
   * 下拉刷新重取并回到第一页；触底加载更多（客户端分段渲染，见 utils/opinion-access#pageSlice）。
   * 返回走小程序默认导航栏（navigateTo 打开的二级页自带返回）。
   */
  navigationBarTitleText: '事件',
  enablePullDownRefresh: true,
  onReachBottomDistance: 80
})
