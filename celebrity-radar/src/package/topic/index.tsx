import { useEffect, useMemo, useState } from 'react'
import Taro, { useRouter, useShareAppMessage } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { getCachedReports } from '@/utils/cache'
import { listFollows } from '@/utils/follows'
import { listHistory } from '@/utils/history'
import { listFavorites } from '@/utils/favorites'
import { describeTopic, buildTopicDigest, TOPIC_MIN_CHARS, TopicDigest } from '@/utils/topic-digest'
import { domainStyleCode } from '@/config/domains'
import { openSourceLink } from '@/utils/source-link'
import { track } from '@/utils/events'
import type { Report } from '@/utils/report'
import QuoteDetail from '@/components/quote-detail'
import EmptyState from '@/components/empty-state'
import Skeleton from '@/components/skeleton'
import PersonAvatar from '@/components/person-avatar'
import { readPortraits } from '@/utils/portrait'
import { decodeParam } from '@/utils/route'
import './index.scss'

/**
 * 主题知识库（Phase 1，纯端上派生）。
 *
 * 入口来自报告页「关键词云」的某个词：用户在那儿看到「这个话题反复被提及」，
 * 下一步最自然的问题就是「还有谁在讲、都怎么讲」—— 本页回答的就是这个。
 *
 * 三个刻意的取舍：
 *
 * 1. **数据源是本机已缓存的报告**（关注 + 浏览历史 + 收藏里的人），不额外发起任何检索。
 *    因此本页零模型调用、零上游请求、不消耗生成额度，老缓存报告也一视同仁
 *    （与词云 / 两人对比 / 热度趋势同一条路线，见 utils/topic-digest.ts 顶部注释）。
 *
 * 2. **覆盖范围如实说明**。这只是「我这边已收录的报告」，不是全网 —— 页头与脚注都要写清楚，
 *    否则一个 60 分的主题热度会被读成「全网舆情指数」。全局覆盖属于 Phase 2（云端物化）。
 *
 * 3. **只呈现能核对的东西**。每段内容都来自某份已落库报告的原字段，并带人名与出处；
 *    相关言论直接复用 components/quote-detail，与报告页共用同一套「查证」口径。
 */
export default function Topic() {
  const router = useRouter()
  const topic = useMemo(() => decodeParam(router.params.topic || ''), [router.params.topic])
  /** 锚点名人：用户是从 TA 的报告页点进来的，聚合时优先保住这一份 */
  const anchorKey = useMemo(
    () => decodeParam(router.params.personKey || ''),
    [router.params.personKey]
  )
  /** 显式来源（预警页等外部入口传），空则由锚点推断 —— 埋点里两者都不丢 */
  const from = useMemo(() => decodeParam(router.params.from || ''), [router.params.from])
  /**
   * 1 个字的说法不值得开一页：词表口径本来就只收 ≥2 字（utils/keywords.ts 的 MIN_LEN），
   * 预警页的关键词是用户手输的、不受这条约束，所以这里按同一门槛兜一道。
   */
  const usable = topic.length >= TOPIC_MIN_CHARS

  const [phase, setPhase] = useState<'loading' | 'ready' | 'empty'>('loading')
  const [digest, setDigest] = useState<TopicDigest | null>(null)

  useEffect(() => {
    let alive = true
    const run = async () => {
      if (!usable) {
        setPhase('empty')
        return
      }
      const keys = await collectSourceKeys(anchorKey)
      const reports = (await getCachedReports(keys)).filter((r): r is Report => r !== null)
      const result = buildTopicDigest(topic, reports)
      if (!alive) return
      if (result.members.length === 0) {
        setPhase('empty')
        return
      }
      setDigest(result)
      setPhase('ready')
      track('topic_open', {
        topic,
        members: result.members.length,
        materials: result.materialCount,
        /* 入口来源：带锚点 = 从某份报告的词云进来，否则是分享链接等外部入口 */
        from: from || (anchorKey ? 'report' : 'direct')
      })
    }
    void run()
    return () => {
      alive = false
    }
  }, [topic, anchorKey, from, usable])

  /* 真图预热：主题成员是一组人，一次批量读把全部人拉进缓存，避免逐行各打一次云函数 */
  useEffect(() => {
    if (digest && digest.members.length > 0) void readPortraits(digest.members.map((m) => m.personKey))
  }, [digest])

  useShareAppMessage(() => ({
    /* 主题不可用时不给「「」大家都在怎么讲」这种半截标题，退回页面名 */
    title: usable ? `「${topic}」大家都在怎么讲｜名人雷达` : '名人雷达 · 主题速览',
    path: `/package/topic/index?topic=${encodeURIComponent(topic)}`
  }))

  /** 时间线的条形：以最多的一天为满格（同一天几个人的讨论量才看得出来） */
  const timelineMax = useMemo(
    () => (digest?.timeline ?? []).reduce((n, p) => Math.max(n, p.count), 1),
    [digest]
  )

  const goReport = (personKey: string) => {
    void Taro.navigateTo({ url: `/package/report/index?personKey=${encodeURIComponent(personKey)}` })
  }

  if (phase === 'loading') {
    return (
      <View className='page-topic safe-bottom'>
        <View className='card'>
          <Skeleton rows={3} variant='card' />
        </View>
      </View>
    )
  }

  if (phase === 'empty' || !digest) {
    /*
      空状态分两种，别混成一句「暂无内容」：
      · 有报告只是把话题名写成了它（模型判定的话题名），素材正文里没有原样写过 ——
        点词云里的话题词最容易撞上这一种，不说清就会以为是页面坏了；
      · 谁都没写过 —— 那才是真的「这个话题还没进过你已读过的报告」。
      这个数来自 utils/topic-digest（只统计、不算成员，见那里的注释）；digest 为 null 时没有它。
    */
    const stanceOnly = digest?.stanceOnlyReports ?? 0
    return (
      <View className='page-topic safe-bottom'>
        <EmptyState
          icon='🧩'
          title={usable ? `暂时没有别处也讲「${topic}」` : '主题信息缺失'}
          desc={
            stanceOnly > 0
              ? `这个词只在 ${stanceOnly} 份报告的「话题」里出现过（模型判定的话题名），素材正文里没有原样写过它。本页只聚合正文真的写过这个词的报告 —— 否则就成了按话题名联想。换一个更常见的说法，或多读几份报告再来看看。`
              : '这个词还没有进过你已收录的报告（本页只聚合你这边已读过的报告，不联网检索）。多关注几位、多读几份报告，同一个话题下就会汇出更多视角。'
          }
          actionText='去发现名人'
          onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
        />
      </View>
    )
  }

  return (
    <View className='page-topic safe-bottom'>
      {/* 主题概览：名字 + 热度 + 覆盖范围（口径必须写在这里，不能只在脚注） */}
      <View className='card page-topic__head'>
        <View className='page-topic__head-top'>
          <Text className='page-topic__name'>{digest.topic}</Text>
          <View className='page-topic__heat'>
            <Text className='page-topic__heat-num'>{digest.heat}</Text>
            <Text className='page-topic__heat-label'>主题热度</Text>
          </View>
        </View>
        {/* 复用全局 .heat 条形（热度可视化全站一把尺子，不另造进度条样式） */}
        <View className='heat page-topic__heatbar'>
          <View className='heat__bar'>
            <View className='heat__bar-fill' style={{ width: `${digest.heat}%` }} />
          </View>
        </View>
        <Text className='page-topic__summary'>{describeTopic(digest)}</Text>
        {!!digest.updatedAt && (
          <Text className='page-topic__asof'>{`数据截至 ${digest.updatedAt.slice(0, 10)} 已收录的报告`}</Text>
        )}
      </View>

      {/* 相关名人 */}
      <View className='card'>
        <View className='card-title'>哪些名人在讲这个话题</View>
        {digest.members.map((m) => (
          <View
            key={m.personKey}
            className='page-topic__member'
            hoverClass='page-topic__member--tap'
            onClick={() => goReport(m.personKey)}
          >
            <PersonAvatar
              personKey={m.personKey}
              name={m.name}
              domain={m.domain}
              className={`page-topic__avatar page-topic__avatar--${domainStyleCode(m.domain)}`}
            />
            <View className='page-topic__member-main'>
              <View className='page-topic__member-head'>
                <Text className='page-topic__member-name'>{m.name}</Text>
                <View className={`chip chip--${domainStyleCode(m.domain)}`}>{m.domainLabel}</View>
              </View>
              <Text className='page-topic__member-meta'>{`${m.mentions} 条素材提及 · 报告热度 ${m.heat}`}</Text>
            </View>
            <Text className='page-topic__member-arrow'>›</Text>
          </View>
        ))}
        <Text className='page-topic__note'>点姓名可进入 TA 的完整报告 —— 主题页只做编目，细节都在各自的报告里。</Text>
      </View>

      {/* 公开立场：模型判定的话题态度，只在命中本主题时列出 */}
      {/* 空结果也出卡并写明原因（原先不成立就整卡消失，用户只看到「卡片一张张不见了」）。
          本页零模型调用、纯本地聚合，卡片消失只会被读成本页坏了。 */}
      {digest.stances.length === 0 && (
        <View className='card'>
          <View className='card-title'>各自是什么态度</View>
          <Text className='page-topic__note'>
            这批报告的「话题态度」里没有命中本主题的条目。态度是模型在生成报告时判定的，只有那份报告里正好讲到这个话题才会有 —— 不是本页没取到。
          </Text>
        </View>
      )}
      {digest.stances.length > 0 && (
        <View className='card'>
          <View className='card-title'>各自是什么态度</View>
          {digest.stances.map((s) => (
            <View key={s.personKey} className='page-topic__stance'>
              <View className='page-topic__stance-head'>
                <Text className='page-topic__stance-name'>{s.name}</Text>
                <Text className={`page-topic__stance-badge page-topic__stance-badge--${s.attitude}`}>
                  {ATTITUDE_LABEL[s.attitude] ?? s.attitude}
                </Text>
              </View>
              {!!s.note && <Text className='page-topic__stance-note'>{s.note}</Text>}
            </View>
          ))}
          <Text className='page-topic__note'>立场由 AI 依据各自报告收录的素材判定，未必代表主流舆论。</Text>
        </View>
      )}

      {/* 相关言论：复用报告页的 quote-detail（含「查证」），口径两处一致 */}
      {digest.quotes.length === 0 && (
        <View className='card'>
          <View className='card-title'>围绕这个话题说过什么</View>
          <Text className='page-topic__note'>
            这批报告的语录里没有直接谈这个话题的句子。语录按原文命中本主题的关键词，不做语义延伸 —— 没命中就是没有原话，不是本页没取到。
          </Text>
        </View>
      )}
      {digest.quotes.length > 0 && (
        <View className='card'>
          <View className='card-title'>围绕这个话题说过什么</View>
          {digest.quotes.map((q, i) => (
            <View key={`${q.report.personKey}-${i}`} className='page-topic__quote'>
              <Text className='page-topic__quote-text'>{`「${q.quote.text}」`}</Text>
              <Text className='page-topic__quote-from'>{`—— ${q.report.name}`}</Text>
              <QuoteDetail report={q.report} quote={q.quote} />
            </View>
          ))}
        </View>
      )}

      {/* 相关报道：正文里真的出现该主题的条目，点开是原文预览 */}
      {digest.news.length === 0 && (
        <View className='card'>
          <View className='card-title'>相关报道</View>
          <Text className='page-topic__note'>
            这批报告收录的报道正文里没有出现这个话题。本卡只列正文真的出现过该主题的条目，不做相关推荐，也不按标题联想。
          </Text>
        </View>
      )}
      {digest.news.length > 0 && (
        <View className='card'>
          <View className='card-title'>相关报道</View>
          {digest.news.map((n, i) => (
            <View
              /* 不同名人的报告可能引用同一条链接，key 得带上序号才唯一 */
              key={`${n.personKey}-${n.url}-${i}`}
              className='page-topic__news'
              hoverClass='page-topic__news--tap'
              onClick={() =>
                openSourceLink({
                  url: n.url,
                  title: n.title,
                  source: n.source,
                  date: n.date,
                  summary: n.summary
                })
              }
            >
              <Text className='page-topic__news-name'>{n.name}</Text>
              <Text className='page-topic__news-title'>{n.title}</Text>
              <Text className='page-topic__news-meta'>
                {[n.source, n.date].filter(Boolean).join(' · ') || '点开查看原文'}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* 时间线：按天聚合的讨论分布（哪天有几个人在讲），不是逐条罗列 */}
      {digest.timeline.length <= 1 && (
        <View className='card'>
          <View className='card-title'>什么时候被讨论得最多</View>
          <Text className='page-topic__note'>
            {digest.timeline.length === 0
              ? '这批报告里没有可用的日期，按天摊开画不出分布。'
              : '这批报告里谈到本主题的日期只落在一两天内，按天摊开只有一根柱子（也就是没有起伏可看），故不出图。'}
          </Text>
        </View>
      )}
      {digest.timeline.length > 1 && (
        <View className='card'>
          <View className='card-title'>什么时候被讨论得最多</View>
          {digest.timeline.map((p) => (
            <View key={p.date} className='page-topic__tl-row'>
              <Text className='page-topic__tl-date'>{p.date.slice(5)}</Text>
              <View className='heat__bar'>
                <View
                  className='heat__bar-fill'
                  style={{ width: `${Math.max(6, Math.round((p.count / timelineMax) * 100))}%` }}
                />
              </View>
              <Text className='page-topic__tl-names'>{`${p.names.join('、')}（${p.count}）`}</Text>
            </View>
          ))}
          <Text className='page-topic__note'>
            纵条长度是该日命中报道的条数，括号里是条数；只统计带可确认日期的报道。
          </Text>
        </View>
      )}

      <Text className='disclaimer'>
        本页由你已收录的名人报告在本地聚合而成（共 {digest.members.length} 位名人、{digest.materialCount} 条素材），
        零额外检索、不消耗生成额度；覆盖范围随报告缓存增长，主题热度只反映本站已收录报道的覆盖广度，不是全网舆情指数。
      </Text>
    </View>
  )
}

/** 立场文案（与 pages/compare 同一套映射，两页看到的同一份 stance 必须同一种说法） */
const ATTITUDE_LABEL: Record<string, string> = {
  positive: '偏正面',
  neutral: '中性',
  negative: '偏负面',
  mixed: '褒贬不一'
}

/**
 * 候选报告的主键集合 = 锚点名人 + 关注 + 浏览历史 + 收藏。
 *
 * 与 pages/compare 的候选名单同源（本机已有数据，不额外请求），但顺序上**锚点排第一**：
 * 下面会截断到 20 位，若把锚点混在名单中间，用户从自己的报告点进来反而可能聚合不到那一份。
 */
async function collectSourceKeys(anchorKey: string): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (key?: string) => {
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(key)
  }

  push(anchorKey)

  const [follows, history, favorites] = await Promise.all([
    listFollows().catch(() => []),
    listHistory().catch(() => []),
    listFavorites().catch(() => [])
  ])

  for (const f of follows) push(f.person_key)
  for (const h of history) push(h.person_key)
  for (const v of favorites) push(v.person_key)

  return out.slice(0, 20)
}
