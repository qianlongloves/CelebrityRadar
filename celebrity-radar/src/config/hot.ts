import { DomainCode } from './domains'

/**
 * 热门运营位（§2.1 M1：MVP 为静态运营位，V1.5 数据化）。
 * 单一数据源：发现页「热门名人」卡片、横幅「今日名人」、中央随机探索均由此派生。
 * trend 为动态速览运营文案（一句话，不含实时结论）；heat 为静态热门指数（0~100）。
 */
export interface HotPerson {
  name: string
  domain: DomainCode
  /** 静态热门指数（排序 + 热度条） */
  heat: number
  /** 动态关键词标签 */
  tag: string
  /** 动态速览（运营文案） */
  trend: string
}

/**
 * 按 heat 降序排列（列表直接渲染即为热度榜）。
 * 覆盖全部 6 个领域（每领域 4 位）：发现页「热门名人」按领域筛选时不会有空领域。
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
  { name: '苏炳添', domain: 'sports', heat: 60, tag: '复出', trend: '复出参赛与训练状态成为讨论焦点' }
]
