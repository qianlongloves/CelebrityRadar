export default definePageConfig({
  navigationBarTitleText: '我的订单',
  /* 发货由微信回调云函数异步完成（granting → paid），补下拉刷新让用户能自己看到状态推进 */
  enablePullDownRefresh: true
})
