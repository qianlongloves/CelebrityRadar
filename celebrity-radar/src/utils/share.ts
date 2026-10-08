import { DOMAIN_META, DomainCode } from '@/config/domains'
import { Report } from './report'

/**
 * 分享文案与落地路径的统一出口（优化建议 O-13）。
 *
 * 为什么必须收口：此前全项目只有报告页注册了转发回调，名人主页 / 发现页 / 提问页的
 * 右上角转发会带出一个**不含任何参数的地址**，对方点开直接落在「缺少 personKey」的
 * 错误态 —— 分享是最便宜的拉新路径，却在最需要它的三个页面是坏的。三个页面各写一遍
 * 标题就等于把「文案口径」复制三份，改一次漏两处。
 *
 * 三条口径：
 *
 * 1) **落地页统一是 `pages/report/index`**。深度报告是唯一「点开就看得懂」的内容，
 *    且 tabBar 页不能作为分享落地页（微信限制），所以发现页 / 提问页这类 tab 页
 *    也必须落到报告页而不是自己。
 * 2) **标题只用可核对的一句简介**（报告 `intro` 的首句）—— 与推荐卡的 brief 同源，
 *    页面上本来就这么展示，分享出去不引入新说法，也不把模型的结论性判断当事实转述。
 * 3) **长度按微信展示裁到 ~24 字**，否则会被截成半句（「…小米在汽车与手」）。
 */

/** 标题展示上限（含姓名与领域），超出截断加省略号 */
const TITLE_MAX = 24

/** 简介首句（≤ 22 字）：取到第一个句读为止，过长再截断 */
function briefOf(report?: Report | null): string {
  const intro = (report?.intro ?? '').trim()
  if (!intro) return ''
  const cut = intro.split(/[。！？!?；;\n]/)[0]?.trim() ?? ''
  const text = cut || intro
  return text.length > 22 ? `${text.slice(0, 22)}…` : text
}

/**
 * 报告落地路径（分享与页内跳转共用）。
 * focus 非 all 时带上：对方点开即落在同一侧重，不必自己再切一次。
 */
export function reportSharePath(personKey: string, focus?: string): string {
  const base = `/pages/report/index?personKey=${encodeURIComponent(personKey)}`
  return focus && focus !== 'all' ? `${base}&focus=${focus}` : base
}

/**
 * 分享标题：`姓名 · 领域`，有报告时再拼一句可核对的简介。
 *
 * @param name 名人姓名（报告未就绪时用路由里解析出来的名字）
 * @param domain 领域码（决定「· 科技」这半句）
 * @param report 已缓存的报告；为 null 时只出「姓名 · 领域」
 */
export function personShareTitle(name: string, domain: DomainCode, report?: Report | null): string {
  const domainLabel = DOMAIN_META[domain]?.label ?? '名人'
  const head = `${name} · ${domainLabel}`
  const brief = briefOf(report)
  const title = brief ? `${head}｜${brief}` : head
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title
}
