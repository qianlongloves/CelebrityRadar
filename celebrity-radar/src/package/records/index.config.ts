export default definePageConfig({
  navigationBarTitleText: '我的收藏',
  /* 列表会因收藏变更而过期，补下拉刷新（实现见 components/favorites-view） */
  enablePullDownRefresh: true
})
