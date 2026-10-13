import { View, Text } from '@tarojs/components'
import { DOMAIN_COVERAGE_TEXT } from '@/config/domains'
import './index.scss'

/**
 * 隐私与免责声明（§六.3/六.4 静态文案，发版前需按最新合规要求复核）。
 *
 * 版式（2026-10-13 二次改）：由「两个并列版块」合并为**一份连续文档** ——
 * 一份标题 + 「更新日期 / 生效日期」一行小字 + 静态目录（大纲）+ 大纲式条款：
 * 一级用「一、二…」，二级用「1.1 / 1.2…」，正文压到 25rpx、行距 2 倍，像常见 APP 的协议页。
 * **只改结构与呈现，法务文案内容一字不改**；两大部分顺序为先隐私、后免责。
 */

/** 文档更新 / 生效日期（纯展示；改版式或复核合规文案时一并维护） */
const UPDATED_AT = '2026-10-13'
const EFFECTIVE_AT = '2026-10-13'

interface Clause {
  title: string
  desc: string
}

interface Section {
  /** 一级条款中文序号（一、二…） */
  no: string
  /** 一级条款标题（沿用原版块的叫法：隐私清单 / 免责声明） */
  title: string
  /** 二级编号前缀（1 / 2…），与条目序号拼成「1.1 / 1.2」 */
  index: number
  items: Clause[]
}

const SECTIONS: Section[] = [
  {
    no: '一',
    title: '隐私清单',
    index: 1,
    items: [
      { title: '自动登录', desc: '使用微信登录能力获取匿名标识（openid）以提供关注、收藏、历史等功能；不获取你的手机号、位置、通讯录等敏感信息。' },
      { title: '本地存储', desc: '应用运行所需的少量本地状态（缓存索引、限流冷却时间等）仅保存在设备本地存储，不上传服务器、不参与任何同步。' },
      { title: '云端数据', desc: '关注列表、收藏、浏览历史保存在云端，仅你自己可见；可随时在「我的 → 清空数据」中删除。' },
      { title: '匿名使用统计', desc: '记录匿名功能使用计数（如生成次数、缓存命中），不关联你的个人身份。' },
      { title: '数据删除', desc: '通过「清空数据」可删除本地设置与云端关注/收藏/历史；删除后不可恢复。' }
    ]
  },
  {
    no: '二',
    title: '免责声明',
    index: 2,
    items: [
      { title: 'AI 生成内容', desc: '报告与动态摘要由 AI 基于公开网络信息生成，仅供参考，不代表本平台立场，不构成任何建议。' },
      { title: '信息来源', desc: '报告中的每条动态与来源链接均来自公开检索结果（博查），可逐条复制链接溯源核查。' },
      { title: '准确性', desc: 'AI 可能产生错误或过时信息；涉及事实请以权威来源为准。' },
      { title: '名誉与纠错', desc: '若你认为某位名人的内容存在错误或侵权，可通过「内容举报 / 反馈」联系我，核实后将下线对应内容。' },
      { title: '查询范围', desc: `本工具覆盖${DOMAIN_COVERAGE_TEXT}等多个领域公众名人的公开信息。` }
    ]
  }
]

export default function Agreement() {
  return (
    <View className='page-agreement glow-page safe-bottom'>
      {/* 一份连续文档：标题 → 更新/生效日期 → 静态目录 → 大纲式条款（一、二… / 1.1、1.2…） */}
      <View className='page-agreement__doc'>
        <Text className='page-agreement__doc-title'>隐私与免责声明</Text>
        <Text className='page-agreement__doc-meta'>
          {`更新日期：${UPDATED_AT} · 生效日期：${EFFECTIVE_AT}`}
        </Text>

        {/* 静态目录（大纲）：不引入跳转依赖，仅列出两级条款编号与标题 */}
        <View className='page-agreement__toc'>
          <Text className='page-agreement__toc-title'>目录</Text>
          {SECTIONS.map((s) => (
            <Text key={s.title} className='page-agreement__toc-item'>
              {`${s.no}、${s.title}`}
            </Text>
          ))}
        </View>

        {SECTIONS.map((s) => (
          <View key={s.title} className='page-agreement__section'>
            <Text className='page-agreement__section-title'>{`${s.no}、${s.title}`}</Text>
            {s.items.map((it, i) => (
              <View key={it.title} className='page-agreement__clause'>
                <Text className='page-agreement__clause-title'>{`${s.index}.${i + 1} ${it.title}`}</Text>
                <Text className='page-agreement__clause-body'>{it.desc}</Text>
              </View>
            ))}
          </View>
        ))}
      </View>

      <View className='disclaimer'>如有疑问，请通过「我的 → 内容举报 / 反馈」联系</View>
    </View>
  )
}
