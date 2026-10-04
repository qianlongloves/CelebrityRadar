export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/feed/index',
    'pages/mine/index',
    'pages/profile/index',
    'pages/report/index',
    'pages/collection/index',
    'pages/agreement/index'
  ],
  tabBar: {
    color: '#999999',
    selectedColor: '#5F33E1',
    backgroundColor: '#ffffff',
    borderStyle: 'black',
    list: [
      { pagePath: 'pages/index/index', text: '发现' },
      { pagePath: 'pages/feed/index', text: '关注流' },
      { pagePath: 'pages/mine/index', text: '我的' }
    ]
  },
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: '名人雷达',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f6f7f9'
  }
})
