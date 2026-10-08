export default definePageConfig({
  /* 标题继承 app.config 的应用名「名人雷达」：底部菜单已写着「收藏」，导航栏再写一遍是噪音 */
  /* 列表会因「在报告页取消收藏 / 报告重新生成」而过期，补下拉刷新（实现见 components/favorites-view） */
  enablePullDownRefresh: true
})
