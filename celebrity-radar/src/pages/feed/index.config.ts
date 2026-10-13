export default definePageConfig({
  /*
   * 2026-10-07：底部菜单第二格换成「AI 提问」，本页改为二级页，从发现页顶部的
   * 「关注」入口进入（navigateTo）—— 不再有 tab 高亮，导航栏必须自己说清这是什么页。
   *
   * 2026-10-13：加分页——下拉刷新重取数据并回到第一页；触底加载更多（客户端分段渲染，
   * 见 utils/opinion-access#FEED_PAGE_SIZE / #pageSlice）。故需要开启下拉刷新与触底距离。
   */
  navigationBarTitleText: '关注动态',
  enablePullDownRefresh: true,
  onReachBottomDistance: 80
})
