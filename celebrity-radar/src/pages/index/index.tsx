import { useState } from 'react'
import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtSearchBar, AtButton, AtActivityIndicator } from 'taro-ui'
import { DOMAIN_META, DomainCode, buildPersonKey } from '@/config/domains'
import PersonCard from '@/components/person-card'
import EmptyState from '@/components/empty-state'
import { useAuth } from '@/stores/auth'
import { isSensitiveQuery } from '@/utils/sensitive'
import { disambiguate, PersonCandidate } from '@/utils/disambiguate'
import { track } from '@/utils/events'
import { openRandomPerson } from '@/utils/explore'
import './index.scss'

/** 热门运营位（§2.1 M1：MVP 仅静态运营位，V1.5 数据化） */
const HOT_PEOPLE: Array<{ domain: DomainCode; names: string[] }> = [
  { domain: 'tech', names: ['雷军', '马斯克', '黄仁勋', '奥特曼'] },
  { domain: 'business', names: ['巴菲特', '张一鸣', '王传福', '董明珠'] },
  { domain: 'ent', names: ['周杰伦', '吴京', '赵丽颖', '李子柒'] },
  { domain: 'sports', names: ['姚明', '苏炳添', '全红婵', '梅西'] }
]

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

type SearchState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'candidates'; candidates: PersonCandidate[] }
  | { phase: 'refused' }
  | { phase: 'notfound' }
  | { phase: 'error'; message: string }

export default function Index() {
  const [keyword, setKeyword] = useState('')
  const [state, setState] = useState<SearchState>({ phase: 'idle' })
  const { nickname, userId } = useAuth()

  const now = new Date()
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 · 周${WEEKDAYS[now.getDay()]}`

  /** 搜索流（§4.2）：一级敏感拦截 → LLM 消歧 → 选定 personKey → 报告页 */
  const doSearch = async () => {
    const name = keyword.trim()
    if (!name) return

    // 第一级：本地敏感名单（命中即拒答，不发任何网络请求，§六.7）
    if (isSensitiveQuery(name)) {
      setState({ phase: 'refused' })
      return
    }

    setState({ phase: 'loading' })
    track('search', { name })
    const res = await disambiguate(name)
    if (!res.ok) {
      setState({ phase: 'error', message: res.error })
      return
    }
    if (res.data.refused) {
      setState({ phase: 'refused' })
      return
    }
    if (res.data.candidates.length === 0) {
      setState({ phase: 'notfound' })
      return
    }
    setState({ phase: 'candidates', candidates: res.data.candidates })
  }

  const openPerson = (name: string, domain: DomainCode) => {
    const personKey = buildPersonKey(name, domain)
    track('disambiguate_selected', { personKey })
    Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}` })
  }

  return (
    <View className='page-index glow-page safe-tab'>
      {/* 问候区（参照样例 Hello + 用户名） */}
      <View className='page-index__header'>
        <View className='page-index__greet'>
          <Text className='page-index__hello'>Hello!</Text>
          <Text className='page-index__username'>{userId ? nickname || '名人观察员' : '名人观察员'}</Text>
        </View>
        <Text className='page-index__date'>{dateLabel}</Text>
      </View>

      {/* 主横幅卡（参照样例紫色卡 + 环形元素） */}
      <View className='page-index__banner'>
        <View className='page-index__banner-body'>
          <Text className='page-index__banner-title'>今日名人雷达</Text>
          <Text className='page-index__banner-desc'>AI 联网整理公开动态\n生成可溯源的深度报告</Text>
          <View className='page-index__banner-btn' onClick={() => openRandomPerson()}>
            随机探索一位
          </View>
        </View>
        <View className='page-index__ring'>
          <View className='page-index__ring-inner'>AI</View>
        </View>
      </View>

      {/* 搜索区 */}
      <View className='page-index__search'>
        <AtSearchBar
          value={keyword}
          onChange={setKeyword}
          placeholder='输入名人名字，如：雷军'
          onConfirm={() => void doSearch()}
        />
        <AtButton
          type='primary'
          loading={state.phase === 'loading'}
          disabled={!keyword.trim() || state.phase === 'loading'}
          onClick={() => void doSearch()}
          className='page-index__search-btn'
        >
          搜索名人
        </AtButton>
      </View>

      {state.phase === 'loading' && (
        <View className='page-index__status'>
          <AtActivityIndicator mode='center' content='AI 正在识别同名人物…' />
        </View>
      )}

      {state.phase === 'candidates' && (
        <View>
          <View className='section-head'>
            <Text className='section-head__title'>
              TA 是哪一位？
              <Text className='count-badge'>{state.candidates.length}</Text>
            </Text>
          </View>
          {state.candidates.map((c) => (
            <PersonCard
              key={`${c.name}#${c.domain}`}
              person={{ personKey: buildPersonKey(c.name, c.domain), name: c.name, domain: c.domain, brief: c.brief }}
              actionText='查看'
              onAction={(p) => openPerson(p.name, p.domain)}
              onClick={(p) => openPerson(p.name, p.domain)}
            />
          ))}
          <View className='page-index__fallback text-tertiary' onClick={() => setState({ phase: 'notfound' })}>
            都不是 TA？补充领域关键词再试 →
          </View>
        </View>
      )}

      {state.phase === 'refused' && (
        <EmptyState icon='🚫' title='暂不支持查询该人物' desc='本工具仅覆盖科技、商业、文娱、体育、学术领域公众名人' />
      )}

      {state.phase === 'notfound' && (
        <EmptyState
          icon='🤔'
          title='未识别到该名人'
          desc='试试补充领域关键词，如「雷军 科技」；或从下方热门推荐开始'
        />
      )}

      {state.phase === 'error' && (
        <EmptyState
          icon='⚠️'
          title='查询失败'
          desc={state.message}
          actionText='重试'
          onAction={() => void doSearch()}
        />
      )}

      {/* 热门领域（双列卡片，参照样例 Task Groups 小卡） */}
      <View className='section-head'>
        <Text className='section-head__title'>热门领域</Text>
        <Text className='section-head__extra'>点击名人直接查看</Text>
      </View>
      <View className='page-index__groups'>
        {HOT_PEOPLE.map((group) => (
          <View key={group.domain} className={`page-index__group page-index__group--${group.domain}`}>
            <Text className='page-index__group-title'>{DOMAIN_META[group.domain].label}</Text>
            <View className='page-index__group-chips'>
              {group.names.map((name) => (
                <View
                  key={name}
                  className='page-index__gchip'
                  onClick={() => openPerson(name, group.domain)}
                >
                  {name}
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>

      <View className='disclaimer'>
        内容由 AI 基于公开网络信息生成，仅供参考，不代表本平台立场
      </View>
    </View>
  )
}
