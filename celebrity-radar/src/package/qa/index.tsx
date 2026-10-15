import { useEffect, useState } from 'react'
import { Text, View } from '@tarojs/components'
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
 * **只读缓存**：不在本页触发生成 —— 生成是 30 秒的重操作，让用户在「提问」时无意付出
 * 这个代价是本末倒置的（见 utils/qa.ts 的三条硬口径）。
 *
 * **没有报告时不再只是劝退**（2026-10-15）：除「去生成报告」外再给一条「不等报告，先直接问」。
 * 原因：「必须先生成报告才能提问」把一次 3 秒的提问卡在 30~60 秒的生成之后，而这两个动作
 * 花的不是同一笔钱（提问池 vs 生成池）、满足的也不是同一个需求（问一件事 vs 要一份档案）。
 * 直连路径早就存在（utils/qa.ts#askDirect），此前只有底部菜单页能走到，这里补上入口。
 * 报告仍是**更准**的那条路（有 12 条带日期动态 + 言论 + 时间线），所以主按钮不变，只是不再唯一。
 *
 * 会话不落库、不跨次保留：面板只把本会话最近两轮当上文（退出即忘），不让用户误以为「AI 记得」。
 */

type Phase = 'loading' | 'missing' | 'ready'

export default function QaPage() {
  const router = useRouter()
  const personKey = decodeURIComponent(router.params.personKey || '')
  const parsed = parsePersonKey(personKey)

  const [phase, setPhase] = useState<Phase>('loading')
  const [report, setReport] = useState<Report | null>(null)
  const [member, setMember] = useState(false)
  /**
   * 「不等报告，先直接问」是否已选（2026-10-15）。
   * 只翻这一页的状态，**不改 report**：报告一旦在别处生成出来（用户真去生成了再回来），
   * 下一次 useDidShow / 重新进入仍走有报告的那条路，不会被这个开关黏住。
   */
  const [directAsk, setDirectAsk] = useState(false)

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

      {phase === 'missing' && !directAsk && (
        <View className='page-qa__missing'>
          <EmptyState
            icon='📄'
            title='这位名人还没有报告'
            desc='有报告时，回答基于报告素材（动态、公开言论、报道画像），更准；也可以不等报告，直接问。'
            actionText={parsed ? '去生成报告' : '去发现名人'}
            onAction={() =>
              parsed
                ? Taro.redirectTo({ url: `/package/report/index?personKey=${encodeURIComponent(personKey)}` })
                : Taro.switchTab({ url: '/pages/index/index' })
            }
          />
          {/* 次出口只在解析出人名时给：直连也要有提问对象，没有对象就只剩「去发现名人」一条路 */}
          {parsed && (
            <View className='page-qa__alt' hoverClass='page-qa__alt--tap' onClick={() => setDirectAsk(true)}>
              <Text>不等报告，直接向 AI 提问 ›</Text>
            </View>
          )}
        </View>
      )}

      {/* 直连态复用同一个面板（report 不传即直连，见 components/qa-panel）：提示与闸门口径全在那边 */}
      {phase === 'missing' && directAsk && parsed && <QaPanel name={parsed.name} member={member} />}

      {phase === 'ready' && report && <QaPanel report={report} name={report.name} member={member} />}
    </View>
  )
}
