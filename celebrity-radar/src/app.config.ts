export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/feed/index',
    'pages/mine/index',
    'pages/profile/index',
    'pages/report/index',
    'pages/collection/index',
    'pages/agreement/index',
    'pages/records/index',
    'pages/history/index',
    'pages/following/index',
    'pages/weekly/index',
    /* 报告素材的原文预览（近期动态 / 最新报道的落点，见 pages/link-preview） */
    'pages/link-preview/index',
    /* 两名人横向对比（从报告页底部进入，只读缓存、零模型调用，见 pages/compare） */
    'pages/compare/index',
    /* 消息中心（首页铃铛进入，数据全部来自端上已有缓存 + 静态公告，见 utils/messages） */
    'pages/messages/index',
    /* AI 提问频道页（底部菜单第二格：选名人后共用问答面板，见 pages/ask） */
    'pages/ask/index',
    /* AI 问答（报告页底部进入，只读缓存报告、不消耗生成额度，见 pages/qa + utils/qa） */
    'pages/qa/index',
    /* 会员中心（「我的」页会员卡进入：权益对比 + 档位选择 + 吸底支付，见 pages/member） */
    'pages/member/index',
    /* 我的订单（会员中心进入，仅会员可见：支付记录 + 开通状态，见 pages/orders） */
    'pages/orders/index',
    /* 关键词舆情预警（消息中心入口 / 预警推送落点：订阅管理 + 预警列表，见 pages/alerts） */
    'pages/alerts/index',
    /* 主题知识库（报告页词云词条进入：把已缓存报告按话题重新编目，见 pages/topic + utils/topic-digest） */
    'pages/topic/index'
  ],
  // 按需注入：仅注入当前页面所需的自定义组件代码（基础库 ≥ 2.11.1）
  lazyCodeLoading: 'requiredComponents',
  tabBar: {
    custom: true,
    color: '#9b97ab',
    selectedColor: '#5F33E1',
    backgroundColor: '#EEE9FF',
    borderStyle: 'white',
    list: [
      { pagePath: 'pages/index/index', text: '发现' },
      /*
       * 第二格是「AI 提问」（2026-10-07 由「关注」换成此页）：
       * 关注流改为二级页，入口在发现页顶部（见 pages/feed + pages/index 的关注入口）。
       * 顺序不能随意调：自定义 tabBar 的槽位按这里的前 2 / 后 2 分组渲染。
       */
      { pagePath: 'pages/ask/index', text: 'AI 提问' },
      { pagePath: 'pages/collection/index', text: '收藏' },
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
