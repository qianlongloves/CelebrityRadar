import { DomainCode } from './domains'

/**
 * 热门运营位（§2.1 M1：MVP 为静态运营位，V1.5 数据化，现由 AI 每日生产）。
 *
 * 榜单的真实来源是 `hot_board` 集合：`cloudfunctions/hotBoardRefresh` 每天分域联网检索 +
 * 大模型结构化后落库，端上只读（见 utils/hot-board.ts）。本文件的静态 24 位退化为**种子池**，
 * 只负责 ① 冷启动 / 云未配置 / 读取失败时兜底（保证运营位永不为空）、
 * ② 提供 tag / trend 运营文案、③ 作为「今日名人」「随机探索」的稳定池（见 utils/explore.ts）。
 */
export interface HotPerson {
  name: string
  domain: DomainCode
  /**
   * 热门指数（0~100），**可选**：只作排序兜底，卡片上不再展示。
   *
   * AI 榜单（hot_board）产出的条目不带这个值 —— 那里**数组顺序即排名**，
   * 模型给不出可核对的分数口径，硬造一个只会变成第二个「玄学热度」。
   * 静态种子与 report_cache 条目带值，用于没有 AI 榜单时把真实被查得多的人排到前面。
   */
  heat?: number
  /** 动态关键词标签 */
  tag: string
  /** 动态速览（运营文案） */
  trend: string
}

/**
 * 按 heat 降序排列（无真实数据时即为最终榜单）。
 * 覆盖全部 12 个领域（每领域 2~4 位）：种子兜底时按领域筛选不会有空领域。
 *
 * 2026-10-08 领域从 6 个扩到 12 个时，给 6 个新领域各补了 2 位 —— 否则云未配置 / 冷启动
 * 时按「财经」「教育」筛选会是空列表。注意这是一份**兜底与运营**池，不承担榜单配比：
 * 真实榜单的领域配比在 hotBoardRefresh 的 PER_DOMAIN。
 */
export const HOT_PERSONS: HotPerson[] = [
  { name: '雷军', domain: 'tech', heat: 92, tag: '新品发布', trend: '新品发布节奏与年度目标表态持续被讨论' },
  { name: '马斯克', domain: 'tech', heat: 88, tag: '航天', trend: '航天发射与自动驾驶进展长期占据话题榜' },
  { name: '黄仁勋', domain: 'tech', heat: 85, tag: '算力', trend: '算力需求与新一代架构路线被反复解读' },
  { name: '周杰伦', domain: 'ent', heat: 82, tag: '巡演', trend: '巡演与新单曲消息长期保持高话题度' },
  { name: '梅西', domain: 'sports', heat: 80, tag: '进球', trend: '赛程与进球数据被球迷持续统计' },
  { name: '屠呦呦', domain: 'academia', heat: 79, tag: '青蒿素', trend: '青蒿素相关研究与公共卫生贡献持续被回顾引用' },
  { name: '奥特曼', domain: 'tech', heat: 78, tag: '大模型', trend: '大模型迭代与组织调整消息频繁登上热搜' },
  { name: '巴菲特', domain: 'business', heat: 76, tag: '投资', trend: '持仓变动与年度股东信内容被持续解读' },
  { name: '罗翔', domain: 'other', heat: 75, tag: '普法', trend: '法律普及内容与公开表达保持较高传播度' },
  { name: '吴京', domain: 'ent', heat: 74, tag: '新片', trend: '新片拍摄进展与动作戏物料被关注' },
  { name: '颜宁', domain: 'academia', heat: 73, tag: '结构生物学', trend: '结构生物学成果与科研团队动向被长期关注' },
  { name: '赵丽颖', domain: 'ent', heat: 72, tag: '定档', trend: '新剧物料与角色话题度持续走高' },
  { name: '全红婵', domain: 'sports', heat: 71, tag: '跳水', trend: '赛事表现与动作难度升级被持续关注' },
  { name: '张一鸣', domain: 'business', heat: 70, tag: '出海', trend: '长期低调，公司海外业务动向仍被频繁提及' },
  { name: '李子柒', domain: 'ent', heat: 69, tag: '非遗', trend: '非遗主题内容更新带动长期讨论' },
  { name: '王传福', domain: 'business', heat: 68, tag: '新能源', trend: '新能源销量与海外建厂进度受关注' },
  { name: '张桂梅', domain: 'other', heat: 67, tag: '教育', trend: '女子高中办学与教育公益相关报道持续被关注' },
  { name: '姚明', domain: 'sports', heat: 66, tag: '篮球', trend: '篮球改革相关发言与联赛动态被关注' },
  { name: '施一公', domain: 'academia', heat: 65, tag: '生命科学', trend: '生命科学领域研究与办学相关表态被持续讨论' },
  { name: '董明珠', domain: 'business', heat: 64, tag: '渠道', trend: '渠道改革表态与新业务布局引发讨论' },
  { name: '潘建伟', domain: 'academia', heat: 63, tag: '量子科技', trend: '量子通信与量子计算进展被反复解读' },
  { name: '樊锦诗', domain: 'other', heat: 62, tag: '文保', trend: '敦煌文物保护与文化遗产话题长期被提及' },
  { name: '单霁翔', domain: 'other', heat: 61, tag: '文博', trend: '文博文创与传统文化的公开分享持续受关注' },
  { name: '苏炳添', domain: 'sports', heat: 60, tag: '复出', trend: '复出参赛与训练状态成为讨论焦点' },
  /* —— 以下为 2026-10-08 领域扩到 12 个后补的种子，heat 接在原有区间之下，不打乱既有排序 —— */
  { name: '张小龙', domain: 'internet', heat: 59, tag: '微信', trend: '微信公开课与产品理念分享常被引用讨论' },
  { name: '王兴', domain: 'internet', heat: 58, tag: '本地生活', trend: '本地生活竞争格局相关表态持续被解读' },
  { name: '沈南鹏', domain: 'finance', heat: 57, tag: '创投', trend: '一级市场投资风向与公开演讲被创投圈关注' },
  { name: '吴晓波', domain: 'finance', heat: 56, tag: '财经观察', trend: '年度企业观察与财经评论长期保持传播度' },
  { name: '李想', domain: 'auto', heat: 55, tag: '新势力', trend: '新车交付节奏与产品定义表态被频繁讨论' },
  { name: '何小鹏', domain: 'auto', heat: 54, tag: '智驾', trend: '智能驾驶路线与出海计划动态受关注' },
  { name: '刘畊宏', domain: 'health', heat: 53, tag: '健身', trend: '健身直播与健康生活方式内容持续更新' },
  { name: '张文宏', domain: 'health', heat: 52, tag: '医学科普', trend: '感染科医学科普与公开表达被持续关注' },
  { name: '俞敏洪', domain: 'edu', heat: 51, tag: '教育', trend: '教育转型与公益助学相关内容被关注' },
  { name: '李永乐', domain: 'edu', heat: 50, tag: '科普课', trend: '科普课程与物理讲解视频长期被推荐' },
  { name: '谭盾', domain: 'art', heat: 49, tag: '作曲', trend: '交响乐新作与跨界演出消息被乐迷关注' },
  { name: '蔡国强', domain: 'art', heat: 48, tag: '当代艺术', trend: '烟花艺术与大型个展动态持续被报道' }
]
