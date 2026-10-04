import { useState } from 'react'
import Taro, { useRouter } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { AtTabs, AtButton, AtIcon } from 'taro-ui'
import { DOMAIN_META, DomainCode } from '@/config/domains'
import EmptyState from '@/components/empty-state'
import './index.scss'

/** 名人主页（M2 简版：动态 / 名言两 Tab）
 *  路由参数：personKey（§4.1）。数据接入在阶段 4/5。 */
export default function Profile() {
  const router = useRouter()
  const personKey = router.params.personKey || ''
  // 占位：阶段 5 接入真实数据后由 query 读取（demo 数据展示布局）
  const name = decodeURIComponent(personKey.split('#')[0] || '名人')
  const domain = (personKey.split('#')[1] || 'other') as DomainCode
  const heat = 78

  const [tab, setTab] = useState(0)

  const goReport = () => {
    Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}` })
  }

  return (
    <View className='page-profile safe-bottom'>
      <View className='card page-profile__info'>
        <View className='page-profile__row'>
          <View className='page-profile__avatar'>{name.slice(0, 1)}</View>
          <View className='page-profile__meta'>
            <View className='page-profile__name-row'>
              <Text className='page-profile__name'>{name}</Text>
              <View className={`chip chip--${domain}`}>{DOMAIN_META[domain]?.label ?? '其他'}</View>
            </View>
            <View className='text-tertiary'>公开信息整理 · 头像为占位（§六.4）</View>
          </View>
        </View>
        <View className='page-profile__heat'>
          <Text className='text-secondary'>热度</Text>
          <View className='heat__bar'>
            <View className='heat__bar-fill' style={{ width: `${Math.min(100, heat)}%` }} />
          </View>
          <Text className='page-profile__heat-value'>{heat} / 100</Text>
        </View>
        <View className='page-profile__actions'>
          <AtButton type='primary' size='small' className='page-profile__btn' onClick={goReport}>
            生成深度报告
          </AtButton>
          <AtButton type='secondary' size='small' className='page-profile__btn' onClick={() => Taro.showToast({ title: '阶段 4 接入关注', icon: 'none' })}>
            + 关注
          </AtButton>
        </View>
      </View>

      <AtTabs
        current={tab}
        tabList={[{ title: '动态' }, { title: '名言' }]}
        onClick={setTab}
        className='page-profile__tabs'
      >
        {tab === 0 ? (
          <EmptyState icon='📰' title='动态加载中' desc='近期公开动态将在这里展示（带来源与时间）' />
        ) : (
          <EmptyState icon='💬' title='名言整理中' desc='经典语录将按主题分类展示，可复制（自动附来源）' />
        )}
      </AtTabs>

      <View className='disclaimer'>内容由 AI 基于公开网络信息生成，仅供参考</View>
    </View>
  )
}
