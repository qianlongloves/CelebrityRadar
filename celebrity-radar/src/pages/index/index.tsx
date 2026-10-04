import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import { AtSearchBar, AtButton } from 'taro-ui'
import { DOMAIN_META, DomainCode } from '@/config/domains'
import './index.scss'

/** 热门运营位（§2.1 M1：MVP 仅静态运营位，V1.5 数据化） */
const HOT_PEOPLE: Array<{ domain: DomainCode; names: string[] }> = [
  { domain: 'tech', names: ['雷军', '马斯克', '黄仁勋', '奥特曼'] },
  { domain: 'business', names: ['巴菲特', '张一鸣', '王传福', '董明珠'] },
  { domain: 'ent', names: ['周杰伦', '吴京', '赵丽颖', '李子柒'] },
  { domain: 'sports', names: ['姚明', '苏炳添', '全红婵', '梅西'] }
]

export default function Index() {
  const [keyword, setKeyword] = useState('')

  // 阶段 3 接入：敏感过滤 → LLM 消歧候选 → personKey 缓存查询 → 报告/主页
  const doSearch = () => {
    if (!keyword.trim()) return
  }

  return (
    <View className='page-index safe-bottom'>
      <View className='page-index__hero'>
        <View className='page-index__title'>名人雷达</View>
        <View className='page-index__subtitle'>
          联网抓取近期公开动态，AI 整理成一份可溯源的报告
        </View>
      </View>

      <View className='page-index__search'>
        <AtSearchBar
          value={keyword}
          onChange={setKeyword}
          placeholder='输入名人名字，如：雷军'
          onConfirm={doSearch}
        />
        <AtButton type='primary' disabled={!keyword.trim()} onClick={doSearch} className='page-index__search-btn'>
          搜索名人
        </AtButton>
      </View>

      {HOT_PEOPLE.map((group) => (
        <View key={group.domain}>
          <View className='section-head'>
            <Text className='section-head__title'>{DOMAIN_META[group.domain].label} · 热门</Text>
            <Text className='section-head__extra'>静态运营位</Text>
          </View>
          <View className='page-index__chips'>
            {group.names.map((name) => (
              <View
                key={name}
                className={`chip page-index__chip chip--${group.domain}`}
                onClick={() => setKeyword(name)}
              >
                {name}
              </View>
            ))}
          </View>
        </View>
      ))}

      <View className='disclaimer'>
        内容由 AI 基于公开网络信息生成，仅供参考，不代表本平台立场
      </View>
    </View>
  )
}
