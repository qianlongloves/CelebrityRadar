import Taro from '@tarojs/taro'
import { DomainCode, buildPersonKey } from '@/config/domains'

/** 中央探索按钮：随机打开一位热门名人报告（复用发现页热门池） */
const POOL: Array<{ domain: DomainCode; names: string[] }> = [
  { domain: 'tech', names: ['雷军', '马斯克', '黄仁勋', '奥特曼'] },
  { domain: 'business', names: ['巴菲特', '张一鸣', '王传福', '董明珠'] },
  { domain: 'ent', names: ['周杰伦', '吴京', '赵丽颖', '李子柒'] },
  { domain: 'sports', names: ['姚明', '苏炳添', '全红婵', '梅西'] }
]

export function openRandomPerson(): void {
  const group = POOL[Math.floor(Math.random() * POOL.length)]
  const name = group.names[Math.floor(Math.random() * group.names.length)]
  const personKey = buildPersonKey(name, group.domain)
  Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}` })
}
