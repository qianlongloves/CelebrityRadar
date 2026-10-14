import { useEffect, useState } from 'react'
import { View } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import EmptyState from '@/components/empty-state'
import QaPanel from '@/components/qa-panel'
import Skeleton from '@/components/skeleton'
import { parsePersonKey } from '@/config/domains'
import { getCachedReport } from '@/utils/cache'
import { readMemberState } from '@/utils/member'
import type { Report } from '@/utils/report'
import './index.scss'

/**
 * 基于报告的 AI 问答（M4-8，V2）—— 报告页底部进入的会话页。
 *
 * 本页只负责三件事：解析 personKey、读缓存报告、把会话交给 QaPanel
 * （底部菜单「AI 提问」页共用同一个面板，闸门与提示口径都在那边）。
 *
 * **只读缓存**：没有报告就地引导去生成，不在本页触发生成 —— 生成是 30 秒的重操作，
 * 让用户在「提问」时无意付出这个代价是本末倒置的（见 utils/qa.ts 的三条硬口径）。
 *
 * 会话不落库、不跨次保留：问答是一次性对话，保留历史会让用户误以为「AI 记得」，
 * 而实际上每次提问都是把资料 + 当前问题重新拼一次 prompt（无上下文记忆）。
 */

type Phase = 'loading' | 'missing' | 'ready'

export default function QaPage() {
  const router = useRouter()
  const personKey = decodeURIComponent(router.params.personKey || '')
  const parsed = parsePersonKey(personKey)

  const [phase, setPhase] = useState<Phase>('loading')
  const [report, setReport] = useState<Report | null>(null)
  const [member, setMember] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!parsed) {
        setPhase('missing')
        return
      }
      const cached = await getCachedReport(personKey).catch(() => null)
      if (!alive) return
      setReport(cached)
      setPhase(cached ? 'ready' : 'missing')
    })()
    return () => {
      alive = false
    }
  }, [personKey])

  /* 每次显示都重读会员态：用户可能刚去会员中心买完再回来继续追问 */
  useDidShow(() => {
    void readMemberState().then((state) => setMember(state.member))
  })

  return (
    <View className='page-qa'>
      {phase === 'loading' && (
        <View className='card'>
          <Skeleton rows={4} variant='card' />
        </View>
      )}

      {phase === 'missing' && (
        <EmptyState
          icon='📄'
          title='这位名人还没有报告'
          desc='AI 问答只依据已生成的报告素材作答。先让 TA 生成一份报告，再回来提问。'
          actionText={parsed ? '去生成报告' : '去发现名人'}
          onAction={() =>
            parsed
              ? Taro.redirectTo({ url: `/package/report/index?personKey=${encodeURIComponent(personKey)}` })
              : Taro.switchTab({ url: '/pages/index/index' })
          }
        />
      )}

      {phase === 'ready' && report && <QaPanel report={report} name={report.name} member={member} />}
    </View>
  )
}
