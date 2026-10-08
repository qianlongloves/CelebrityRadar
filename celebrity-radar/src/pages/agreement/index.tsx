import { View, Text } from '@tarojs/components'
import { DOMAIN_COVERAGE_TEXT } from '@/config/domains'
import './index.scss'

/** 隐私与免责声明（§六.3/六.4 静态文案，发版前需按最新合规要求复核） */

const PRIVACY_ITEMS: Array<{ title: string; desc: string }> = [
  { title: '自动登录', desc: '使用微信登录能力获取匿名标识（openid）以提供关注、收藏、历史等功能；不获取你的手机号、位置、通讯录等敏感信息。' },
  { title: '本地存储', desc: '应用运行所需的少量本地状态（缓存索引、限流冷却时间等）仅保存在设备本地存储，不上传服务器、不参与任何同步。' },
  { title: '云端数据', desc: '关注列表、收藏、浏览历史保存在云端，仅你自己可见；可随时在「我的 → 清空数据」中删除。' },
  { title: '匿名使用统计', desc: '记录匿名功能使用计数（如生成次数、缓存命中），不关联你的个人身份。' },
  { title: '数据删除', desc: '通过「清空数据」可删除本地设置与云端关注/收藏/历史；删除后不可恢复。' }
]

const DISCLAIMER_ITEMS: Array<{ title: string; desc: string }> = [
  { title: 'AI 生成内容', desc: '报告与动态摘要由 AI 基于公开网络信息生成，仅供参考，不代表本平台立场，不构成任何建议。' },
  { title: '信息来源', desc: '报告中的每条动态与来源链接均来自公开检索结果（博查），可逐条复制链接溯源核查。' },
  { title: '准确性', desc: 'AI 可能产生错误或过时信息；涉及事实请以权威来源为准。' },
  { title: '名誉与纠错', desc: '若你认为某位名人的内容存在错误或侵权，可通过「内容举报 / 反馈」联系我，核实后将下线对应内容。' },
  { title: '查询范围', desc: `本工具覆盖${DOMAIN_COVERAGE_TEXT}等多个领域公众名人的公开信息。` }
]

export default function Agreement() {
  return (
    <View className='page-agreement glow-page safe-bottom'>
      <View className='card'>
        <View className='card-title'>隐私清单</View>
        {PRIVACY_ITEMS.map((it, i) => (
          <View key={it.title} className='page-agreement__item'>
            <View className='page-agreement__item-head'>
              <View className='page-agreement__item-no'>{i + 1}</View>
              <Text className='page-agreement__item-title'>{it.title}</Text>
            </View>
            <Text className='page-agreement__item-desc'>{it.desc}</Text>
          </View>
        ))}
      </View>

      <View className='card'>
        <View className='card-title'>免责声明</View>
        {DISCLAIMER_ITEMS.map((it, i) => (
          <View key={it.title} className='page-agreement__item'>
            <View className='page-agreement__item-head'>
              <View className='page-agreement__item-no'>{i + 1}</View>
              <Text className='page-agreement__item-title'>{it.title}</Text>
            </View>
            <Text className='page-agreement__item-desc'>{it.desc}</Text>
          </View>
        ))}
      </View>

      <View className='disclaimer'>如有疑问，请通过「我的 → 内容举报 / 反馈」联系</View>
    </View>
  )
}
