export default definePageConfig({
  /*
   * 2026-10-07：底部菜单第二格换成「AI 提问」，本页改为二级页，从发现页顶部的
   * 「关注」入口进入（navigateTo）—— 不再有 tab 高亮，导航栏必须自己说清这是什么页。
   */
  navigationBarTitleText: '关注动态',
  enablePullDownRefresh: true
})
