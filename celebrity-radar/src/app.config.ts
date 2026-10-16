export default defineAppConfig({
  /*
   * 平台隐私协议校验开关：微信要求小程序在 app 配置里显式声明本字段，端上的
   * `onNeedPrivacyAuthorization` / `agreePrivacyAuthorization` 才会被回调（见
   * components/privacy-gate）。不声明时该项校验不生效，那道网关会「静静退化」成不存在
   * （组件注释里写明了这种退化），于是「用了头像 / 昵称能力却没有平台级授权闭环」。
   *
   * ⚠ 开启前提：微信公众平台「设置 → 基本设置 → 用户隐私保护指引」已配置并通过审核。
   *   指引未配置而本字段为 true 时，调用头像 / 昵称等隐私接口会被平台**直接拒绝** ——
   *   这不是端上能兜住的错，故上线前必须先在后台把指引配好再发这一版。
   *
   * ── 当前状态（2026-10-16 核对）───────────────────────────────────
   * 取值是 false，且不是改错：本机已用真实 appid（在**未跟踪**的
   * project.private.config.json 里；受跟踪的 project.config.json 里是占位号），
   * 但「后台指引配没配、过没过审」端上无从得知。没配好就置 true，
   * chooseAvatar / nickname 会被平台直接拒绝，表现为「点头像弹不出选择器」，
   * 而这是端上兜不住的错。故顺序固定：**后台指引过审 → 本字段改 true → 重新构建**。
   *
   * ⚠ 这一项不在 `src/config/local.ts` 的 debug 节里，独立于 utils/debug 的启动告警，
   * 过去只靠这段注释被人记住 —— 已收进 `npm run release:check`
   * （scripts/release-check.js）与路线图 §5 S0-5 行统一对账。
   */
  __usePrivacyCheck__: false,
  /*
   * 二级页已下沉到 package 分包（2026-10-14）：主包只留 4 个底部 tab 页 + 公共代码，
   * 主包从 ~1.41MB 降到 ~1.1MB、给后续迭代腾余量。分包页面路径 = package/<页名>/index。
   */
  pages: [
    'pages/index/index',
    'pages/mine/index',
    /* AI 提问频道页（底部菜单第二格：选名人后共用问答面板，见 pages/ask） */
    'pages/ask/index',
    /* 舆情聚合页（底部菜单第三格「盯」：关注动态 / 周报 / 关键词预警三块概要，见 pages/opinion） */
    'pages/opinion/index'
  ],
  subpackages: [
    {
      root: 'package',
      pages: [
        'feed/index',
        'profile/index',
        'report/index',
        'agreement/index',
        'records/index',
        'history/index',
        'following/index',
        'weekly/index',
        /* 报告素材的原文预览（近期动态 / 最新报道的落点，见 package/link-preview） */
        'link-preview/index',
        /* 两名人横向对比（从报告页底部进入，只读缓存、零模型调用，见 package/compare） */
        'compare/index',
        /* 消息中心（首页铃铛进入，数据全部来自端上已有缓存 + 静态公告，见 utils/messages） */
        'messages/index',
        /* 事件时间线（舆情页事件卡跳转的独立二级页；**不是 tab 页**，见 package/event） */
        'event/index',
        /* 事件列表（舆情页事件卡「查看全部事件」进入的独立二级页；分页加载，**不是 tab 页**，见 package/events） */
        'events/index',
        /* AI 问答（报告页底部进入，只读缓存报告、不消耗生成额度，见 package/qa + utils/qa） */
        'qa/index',
        /* 会员中心（「我的」页会员卡进入：权益对比 + 档位选择 + 吸底支付，见 package/member） */
        'member/index',
        /* 我的订单（会员中心进入，仅会员可见：支付记录 + 开通状态，见 package/orders） */
        'orders/index',
        /* 关键词舆情预警（消息中心入口 / 预警推送落点：订阅管理 + 预警列表，见 package/alerts） */
        'alerts/index',
        /* 主题知识库（报告页词云词条进入：把已缓存报告按话题重新编目，见 package/topic + utils/topic-digest） */
        'topic/index',
        /* 监测工作台（预警页 / 我的页进入：把监控对象横着排成台账，勾选批量对比 + 导出简报，见 package/workbench + utils/workbench） */
        'workbench/index',
        /* 报告历史版本（报告页进入：列出被刷新覆盖掉的旧版，免费看列表、会员看正文，见 package/report-history + utils/report-versions） */
        'report-history/index'
      ]
    }
  ],
  // 按需注入：仅注入当前页面所需的自定义组件代码（基础库 ≥ 2.11.1）
  lazyCodeLoading: 'requiredComponents',
  tabBar: {
    custom: true,
    color: '#9b97ab',
    selectedColor: '#5F33E1',
    backgroundColor: '#EEE9FF',
    borderStyle: 'white',
    /*
     * 四格：查 / 问 / 盯 / 管（2026-10-13 由「发现 / AI 提问 / 收藏 / 我的」改来）。
     * 第三格从收藏换成新增的舆情页（盯），收藏不再是 tab、改由「我的」进入（见 pages/records）；
     * 关注动态 / 周报 / 预警三件事都收进这一格（见 pages/opinion）。
     * 顺序不能随意调：自定义 tabBar 的槽位按这里的前 2 / 后 2 分组渲染（见 components/custom-tab-bar）。
     */
    list: [
      { pagePath: 'pages/index/index', text: '发现' },
      { pagePath: 'pages/ask/index', text: '提问' },
      { pagePath: 'pages/opinion/index', text: '舆情' },
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
