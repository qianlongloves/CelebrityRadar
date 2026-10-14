import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, View, Text } from '@tarojs/components'
import Taro, { useDidShow, useRouter, useShareAppMessage } from '@tarojs/taro'
import { AtButton, AtSearchBar } from 'taro-ui'
import { buildPersonKey, domainStyleCode, parsePersonKey, sanitizeDomain } from '@/config/domains'
import { getCachedReport, getOrBuildReport } from '@/utils/cache'
import { buildComparison, describeComparison, CompareSide, CompareResult } from '@/utils/compare'
import type { Report } from '@/utils/report'
import { isFollowed, listFollows, toggleFollow } from '@/utils/follows'
import { listHistory } from '@/utils/history'
import { readPortraits } from '@/utils/portrait'
import { readMemberState } from '@/utils/member'
import { disambiguate, PersonCandidate } from '@/utils/disambiguate'
import { isSensitiveQuery } from '@/utils/sensitive'
import { track } from '@/utils/events'
import PersonCard, { PersonInfo } from '@/components/person-card'
import PersonAvatar from '@/components/person-avatar'
import QaPanel from '@/components/qa-panel'
import EmptyState from '@/components/empty-state'
import Skeleton from '@/components/skeleton'
import ReportLoading from '@/components/report-loading'
import './index.scss'

/**
 * 两名人横向对比（M4-7，V2）。
 *
 * 为什么是「选人 + 读缓存」而不是「输入两个名字现生成」：
 * 报告是一次生成、长期复用的资产，对比只是把两份已有报告摆在一起（见 utils/compare.ts）。
 * 所以主流程**零模型调用、零额度消耗**；只有当对手方确实还没有报告时，才把「生成」
 * 这个重操作（约 30 秒 + 1 次今日额度）交给用户自己决定点不点，而不是替 TA 花掉。
 *
 * 入口来自报告页底部动作区 —— 用户本来就在看某位名人的报告，「拿 TA 和别人比」是那里
 * 最自然的下一步，所以路由参数固定带一个 personKey 作为主视角。
 */

type Phase =
  | 'loading' // 读主视角的缓存报告
  | 'missingBase' // 主视角没有报告（多半是直接分享了对比页链接进来）
  | 'picking' // 选对比对象
  | 'generating' // 对手方没有报告，正在生成
  | 'noReport' // 对手方没有报告，等用户决定是否生成
  | 'ready'

interface Candidate {
  personKey: string
  name: string
  /** 领域（自由短串，2026-10-12 领域自由化） */
  domain: string
}

/**
 * 选人阶段的搜索态。
 *
 * 与发现页的搜索流同源（本地敏感名单 → LLM 消歧 → 候选），但**出口不同**：
 * 那边选中的是「去看 TA 的报告」，这里选中的人直接进 pickRival ——
 * 有缓存就即时对比，没有才问用户要不要花一次生成额度，与点名单里的卡片是同一条路。
 */
type SearchState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'candidates'; candidates: PersonCandidate[] }
  | { phase: 'refused' }
  | { phase: 'notfound' }
  | { phase: 'error'; message: string }

/** 生成失败时按 outcome 给一句人话，不把上游报错原样丢给用户 */
const OUTCOME_TEXT: Record<string, string> = {
  coldstart: '当前网络环境下没有检索到公开信息，稍后再试',
  nonews: '暂未检索到这位名人的近期报道',
  refused: '内容安全检查未通过，无法为 TA 生成报告',
  error: '生成失败，请稍后重试'
}

const ATTITUDE_LABEL: Record<string, string> = {
  positive: '偏正面',
  neutral: '中性',
  negative: '偏负面',
  mixed: '褒贬不一'
}

/**
 * 领域：personKey 是权威来源（它本身就由 name#domain 生成，见 config/domains.ts），
 * 行内字段只作兜底 —— 关注表里 domain 是裸 string，可能是 AI 自创的自由词（非 12 个已知码）。
 * 自 2026-10-12 起领域自由化，故这里返回自由短串，不再强行当 DomainCode（拼类名时另走 domainStyleCode）。
 */
function domainOf(personKey: string, raw?: string): string {
  const parsed = parsePersonKey(personKey)
  if (parsed) return parsed.domain
  return sanitizeDomain(raw) || 'other'
}

/**
 * 候选名单 = 关注列表 + 浏览历史。
 *
 * 这两个来源都是本机已有的数据，不额外请求、不需要用户再搜索一次；也正因为如此，
 * 名单里大多是「用户本来就在意的人」，比给一份随机热门榜更可能做出有意义的对比。
 */
async function collectCandidates(excludeKey: string): Promise<Candidate[]> {
  const out: Candidate[] = []
  const seen = new Set<string>([excludeKey])

  const follows = await listFollows().catch(() => [])
  for (const f of follows) {
    if (!f.person_key || seen.has(f.person_key)) continue
    seen.add(f.person_key)
    out.push({ personKey: f.person_key, name: f.name, domain: domainOf(f.person_key, f.domain) })
  }

  const history = await listHistory().catch(() => [])
  for (const h of history) {
    if (!h.person_key || seen.has(h.person_key)) continue
    seen.add(h.person_key)
    out.push({ personKey: h.person_key, name: h.name, domain: domainOf(h.person_key) })
  }

  return out.slice(0, 20)
}

/** 情绪结构条：三段堆叠，宽度即占比 */
function SentimentBar({ label, data }: { label: string; data: CompareSide['sentiment'] }) {
  if (data.total === 0) {
    return (
      <View className='page-compare__senti'>
        <View className='page-compare__senti-head'>
          <Text className='page-compare__senti-name'>{label}</Text>
          <Text className='page-compare__senti-total'>无动态数据</Text>
        </View>
      </View>
    )
  }
  const pct = (n: number) => `${Math.round((n / data.total) * 100)}%`
  return (
    <View className='page-compare__senti'>
      <View className='page-compare__senti-head'>
        <Text className='page-compare__senti-name'>{label}</Text>
        <Text className='page-compare__senti-total'>{`${data.total} 条动态`}</Text>
      </View>
      <View className='page-compare__senti-bar'>
        <View className='page-compare__senti-seg page-compare__senti-seg--positive' style={{ width: pct(data.positive) }} />
        <View className='page-compare__senti-seg page-compare__senti-seg--neutral' style={{ width: pct(data.neutral) }} />
        <View className='page-compare__senti-seg page-compare__senti-seg--negative' style={{ width: pct(data.negative) }} />
      </View>
      <View className='page-compare__senti-legend'>
        <Text className='page-compare__senti-legend-item'>积极 {data.positive}</Text>
        <Text className='page-compare__senti-legend-item'>中性 {data.neutral}</Text>
        <Text className='page-compare__senti-legend-item'>消极 {data.negative}</Text>
      </View>
    </View>
  )
}

/** 一方的话题态度列 */
function StanceColumn({ side }: { side: CompareSide }) {
  if (side.stances.length === 0) {
    return <Text className='page-compare__empty-inline'>这份报告没有判定话题态度</Text>
  }
  return (
    <>
      {side.stances.map((s) => (
        <View key={s.topic} className='page-compare__stance'>
          <View className='page-compare__stance-head'>
            <Text className='page-compare__stance-topic'>{s.topic}</Text>
            <Text className={`page-compare__stance-attitude page-compare__stance-attitude--${s.attitude}`}>
              {ATTITUDE_LABEL[s.attitude] ?? s.attitude}
            </Text>
          </View>
          {!!s.note && <Text className='page-compare__stance-note'>{s.note}</Text>}
        </View>
      ))}
    </>
  )
}

export default function Compare() {
  const router = useRouter()
  const baseKey = useMemo(() => decodeURIComponent(router.params.personKey || ''), [router.params.personKey])

  const [phase, setPhase] = useState<Phase>('loading')
  const [base, setBase] = useState<Report | null>(null)
  const [rival, setRival] = useState<Report | null>(null)
  const [pending, setPending] = useState<Candidate | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [notice, setNotice] = useState('')
  /** 对比对象搜索：关键词与结果态（选人阶段的那张搜索卡） */
  const [keyword, setKeyword] = useState('')
  const [search, setSearch] = useState<SearchState>({ phase: 'idle' })

  /* 主视角：只读缓存，不触发生成 —— 进对比页不该有任何额度消耗 */
  useEffect(() => {
    let alive = true
    const run = async () => {
      if (!baseKey) {
        setPhase('missingBase')
        return
      }
      let found: Report | null = null
      try {
        found = await getCachedReport(baseKey)
      } catch {
        found = null
      }
      if (!alive) return
      if (!found) {
        setPhase('missingBase')
        return
      }
      setBase(found)
      setPhase('picking')
      const list = await collectCandidates(baseKey)
      if (!alive) return
      setCandidates(list)
    }
    void run()
    return () => {
      alive = false
    }
  }, [baseKey])

  /* 真图预热：候选名单一屏多人，一次批量读拉进缓存，避免逐卡各打一次云函数 */
  useEffect(() => {
    if (candidates.length > 0) void readPortraits(candidates.map((c) => c.personKey))
  }, [candidates])

  /* 搜索结果同理：候选一出来就批量预热，卡片随即同步命中 */
  useEffect(() => {
    if (search.phase === 'candidates') {
      void readPortraits(search.candidates.map((c) => buildPersonKey(c.name, c.domain)))
    }
  }, [search])

  /** 选定对手：有缓存就直接对比，没有则先告诉用户「要花一次额度」，由 TA 决定 */
  const pickRival = useCallback(
    async (c: Candidate) => {
      setNotice('')
      let found: Report | null = null
      try {
        found = await getCachedReport(c.personKey)
      } catch {
        found = null
      }
      if (found) {
        setPending(c)
        setRival(found)
        setPhase('ready')
        return
      }
      setPending(c)
      setPhase('noReport')
    },
    []
  )

  /**
   * 搜索要对比的人（选人阶段）。
   *
   * 为什么要这一步：候选名单只来自「关注 + 浏览历史」两份本机数据，新用户点进来是空的，
   * 而「拿 TA 和某人比」正是本页的入口诉求 —— 没有搜索就只能从名单里挑，等于把对比
   * 锁死在用户已有的圈子里。
   *
   * 成本口径：消歧是一次模型调用（与发现页完全同一条路），**不消耗生成 / 提问额度**；
   * 真正可能花额度的是选中之后那一步，仍由用户自己决定（见 generateRival）。
   */
  const doSearch = useCallback(async () => {
    const name = keyword.trim()
    if (!name || search.phase === 'loading') return
    /* 一级敏感拦截在本地完成：命中即拒答，不发任何网络请求（与发现页同一道闸门） */
    if (isSensitiveQuery(name)) {
      setSearch({ phase: 'refused' })
      return
    }
    setSearch({ phase: 'loading' })
    track('search', { name, from: 'compare' })
    const res = await disambiguate(name)
    if (!res.ok) {
      setSearch({ phase: 'error', message: res.error })
      return
    }
    if (res.data.refused) {
      setSearch({ phase: 'refused' })
      return
    }
    if (res.data.candidates.length === 0) {
      setSearch({ phase: 'notfound' })
      return
    }
    setSearch({ phase: 'candidates', candidates: res.data.candidates })
  }, [keyword, search.phase])

  /** 选中搜索结果里的某位：与名单里的卡片共用一个出口（pickRival） */
  const pickSearched = useCallback(
    (c: PersonCandidate) => {
      void pickRival({ personKey: buildPersonKey(c.name, c.domain), name: c.name, domain: c.domain })
    },
    [pickRival]
  )

  const generateRival = useCallback(async () => {
    if (!pending) return
    setPhase('generating')
    setNotice('')
    let outcome: Awaited<ReturnType<typeof getOrBuildReport>>
    try {
      outcome = await getOrBuildReport(pending.personKey)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '生成失败，请稍后重试')
      setPhase('noReport')
      return
    }
    if (outcome.kind === 'report') {
      setRival(outcome.report)
      setPhase('ready')
      return
    }
    setNotice(outcome.kind === 'error' ? outcome.message : (OUTCOME_TEXT[outcome.kind] ?? '生成失败，请稍后重试'))
    setPhase('noReport')
  }, [pending])

  const reset = useCallback(() => {
    setRival(null)
    setPhase('picking')
    setNotice('')
    /* 换人对比 = 重新开始：上一次的搜索词与候选一起清掉（留着会让人分不清这次选的是谁） */
    setKeyword('')
    setSearch({ phase: 'idle' })
  }, [])

  const result: CompareResult | null = useMemo(
    () => (base && rival ? buildComparison(base, rival) : null),
    [base, rival]
  )

  const summary = useMemo(() => (result ? describeComparison(result) : ''), [result])

  /** 热度条百分比：两人共用同一根刻度（取二者最大值），差值才看得出来 */
  const heatMax = useMemo(() => Math.max(base?.heat ?? 0, rival?.heat ?? 0, 1), [base, rival])

  /**
   * 会员态（O-18）：只传给对比问答面板，用来显示「今日还可问 N 次」的档位。
   * 每次切回本页重读：刚买完会员回来，这里的次数应与其它入口同时变。
   */
  const [member, setMember] = useState(false)
  useDidShow(() => {
    void readMemberState()
      .then((s) => setMember(s.member))
      .catch(() => setMember(false))
  })

  useShareAppMessage(() => ({
    title: result ? `${result.a.name} vs ${result.b.name}｜名人雷达` : '名人雷达 · 名人对比',
    path: `/package/compare/index?personKey=${encodeURIComponent(baseKey)}`
  }))

  /** 关注态（O-18）：底部动作区要显示「关注 / 已关注」，两人各读一次 */
  const [followed, setFollowed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!result) {
      setFollowed({})
      return
    }
    let alive = true
    const keys = [result.a.personKey, result.b.personKey]
    /* 对比双方也就两个人：顺手批量预热真图，省掉两次云调用 */
    void readPortraits(keys)
    void Promise.all(keys.map((k) => isFollowed(k))).then((flags) => {
      if (!alive) return
      setFollowed({ [keys[0]]: flags[0] ?? false, [keys[1]]: flags[1] ?? false })
    })
    return () => {
      alive = false
    }
  }, [result])

  /**
   * 关注 / 取关（O-18）。
   *
   * `toggleFollow` 的 `null` 专表示「未登录或写入失败」（见 utils/follows.ts），
   * 必须与「取关成功」区分开 —— 否则失败会被当成成功、误报一句「已取消关注」。
   */
  const onToggleFollow = async (side: CompareSide) => {
    const next = await toggleFollow(side.personKey, 'compare')
    if (next === null) {
      void Taro.showToast({ title: '操作失败，请稍后再试', icon: 'none' })
      return
    }
    setFollowed((prev) => ({ ...prev, [side.personKey]: next }))
    void Taro.showToast({ title: next ? `已关注 ${side.name}` : `已取消关注 ${side.name}`, icon: 'none' })
  }

  return (
    <View className='page-compare safe-bottom'>
      {phase === 'loading' && (
        <View className='card'>
          <Skeleton rows={4} variant='card' />
        </View>
      )}

      {phase === 'missingBase' && (
        <EmptyState
          icon='📄'
          title='这位名人还没有报告'
          desc='对比需要两份已生成的报告。先去生成 TA 的报告，再回来做对比。'
          actionText='去生成报告'
          onAction={() => Taro.redirectTo({ url: `/package/report/index?personKey=${encodeURIComponent(baseKey)}` })}
        />
      )}

      {phase === 'picking' && (
        <>
          {candidates.length === 0 ? (
            /* 名单为空时只给空态：再单出一张卡的说明，就与空态的文案重复了 */
            <EmptyState
              icon='🔍'
              title='还没有可以对比的人'
              desc='关注过的、查看过的名人会出现在这里；也可以直接用下面的搜索找一位。至少要有两份报告才能放在一起比。'
              actionText='去发现名人'
              onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
            />
          ) : (
            <>
              <View className='card page-compare__tip'>
                <View className='card-title'>从已有名单里选</View>
                <Text className='page-compare__hint'>
                  关注过的、看过的名人会出现在这里 —— 大多是本机已有报告的人，点一下即可对比，不消耗额度。
                </Text>
              </View>
              <View className='page-compare__list'>
                {candidates.map((c) => (
                  <PersonCard
                    key={c.personKey}
                    person={{ personKey: c.personKey, name: c.name, domain: c.domain } as PersonInfo}
                    actionText='对比'
                    onAction={() => void pickRival(c)}
                    onClick={() => void pickRival(c)}
                  />
                ))}
              </View>
            </>
          )}

          {/*
            搜索卡：独立一张卡，排在名单之后 —— 先看「手上已经有什么人」，再动手去找人。
            与上面的名单是两种输入方式（键盘输入 vs 点选），所以各占一张卡、文案各归各卡。
            选人的出口与名单里的卡片完全同一个（pickRival）：有报告即时对比，
            没有才问要不要花一次生成额度；消歧本身只花一次模型调用，不动生成 / 提问额度。
          */}
          <View className='card page-compare__search'>
            <View className='card-title'>搜索对比对象</View>
            <AtSearchBar
              value={keyword}
              onChange={setKeyword}
              placeholder='输入要对比的名人，如：雷军'
              onConfirm={() => void doSearch()}
            />
            <AtButton
              type='primary'
              loading={search.phase === 'loading'}
              disabled={!keyword.trim() || search.phase === 'loading'}
              onClick={() => void doSearch()}
              className='page-compare__search-btn'
            >
              搜索
            </AtButton>
            <Text className='page-compare__hint'>
              {`与「${base?.name ?? 'TA'}」对比：搜到的人已有报告就即时对比；没有的话可现场生成（约 30 秒，消耗 1 次今日额度）`}
            </Text>

            {/* 输出区长在输入框下面（与发现页同一动线），不另起一块 */}
            {search.phase === 'loading' && (
              <Text className='page-compare__output-note'>AI 正在识别同名人物…</Text>
            )}
            {search.phase === 'refused' && (
              <Text className='page-compare__output-note'>这个名字涉及的人物不在可收录范围内，换一位试试</Text>
            )}
            {search.phase === 'notfound' && (
              <Text className='page-compare__output-note'>
                没有识别到公众名人，加上领域关键词再试（如「雷军 科技」）
              </Text>
            )}
            {search.phase === 'error' && <Text className='page-compare__output-note'>{search.message}</Text>}
            {search.phase === 'candidates' && (
              <View className='page-compare__output-cards'>
                {search.candidates.map((c) => {
                  const personKey = buildPersonKey(c.name, c.domain)
                  return (
                    <PersonCard
                      key={personKey}
                      person={{ personKey, name: c.name, domain: c.domain, brief: c.brief }}
                      actionText='对比'
                      onAction={() => pickSearched(c)}
                      onClick={() => pickSearched(c)}
                    />
                  )
                })}
              </View>
            )}
          </View>
        </>
      )}

      {phase === 'generating' && <ReportLoading mode='generating' />}

      {phase === 'noReport' && pending && (
        <EmptyState
          icon='⏳'
          title={`${pending.name} 还没有报告`}
          desc={notice || '生成后即可与 TA 对比：热度、报道量、舆论情绪、共同关注点与公开立场。'}
          actionText={notice ? '重试生成' : '生成并对比'}
          onAction={() => void generateRival()}
        />
      )}

      {phase === 'ready' && result && (
        <>
          <View className='card'>
            <View className='page-compare__pair'>
              <View className='page-compare__side'>
                <PersonAvatar
                  personKey={result.a.personKey}
                  name={result.a.name}
                  domain={result.a.domain}
                  className={`page-compare__avatar page-compare__avatar--${domainStyleCode(result.a.domain)}`}
                />
                <Text className='page-compare__name'>{result.a.name}</Text>
                <View className={`chip chip--${domainStyleCode(result.a.domain)}`}>{result.a.domainLabel}</View>
              </View>
              <View className='page-compare__vs'>VS</View>
              <View className='page-compare__side'>
                <PersonAvatar
                  personKey={result.b.personKey}
                  name={result.b.name}
                  domain={result.b.domain}
                  className={`page-compare__avatar page-compare__avatar--${domainStyleCode(result.b.domain)}`}
                />
                <Text className='page-compare__name'>{result.b.name}</Text>
                <View className={`chip chip--${domainStyleCode(result.b.domain)}`}>{result.b.domainLabel}</View>
              </View>
            </View>

            <Text className='page-compare__summary'>{summary}</Text>

            <View className='page-compare__pair-actions'>
              <AtButton size='small' type='secondary' circle onClick={reset}>
                换人对比
              </AtButton>
            </View>
          </View>

          <View className='card'>
            <View className='card-title'>热度对照</View>
            {[
              { name: result.a.name, heat: result.a.heat },
              { name: result.b.name, heat: result.b.heat }
            ].map((row, i) => (
              <View key={row.name + i} className='page-compare__heat-row'>
                <Text className='page-compare__heat-name'>{row.name}</Text>
                <View className='page-compare__heat-track'>
                  <View
                    className={`page-compare__heat-fill page-compare__heat-fill--${i === 0 ? 'a' : 'b'}`}
                    style={{ width: `${Math.max(4, Math.round((row.heat / heatMax) * 100))}%` }}
                  />
                </View>
                <Text className='page-compare__heat-value'>{row.heat}</Text>
              </View>
            ))}
            <Text className='page-compare__note'>
              热度由近 30 天与近 7 天的报道条数按固定公式算出，两人同一口径，可直接比大小。
            </Text>
          </View>

          <View className='card'>
            <View className='card-title'>指标对照</View>
            <View className='page-compare__table'>
              <View className='page-compare__tr page-compare__tr--head'>
                <Text className='page-compare__td page-compare__td--label'>指标</Text>
                <Text className='page-compare__td'>{result.a.name}</Text>
                <Text className='page-compare__td'>{result.b.name}</Text>
              </View>
              {result.metrics.map((m) => (
                <View key={m.key} className='page-compare__tr'>
                  <Text className='page-compare__td page-compare__td--label'>{m.label}</Text>
                  <Text className={`page-compare__td${m.higher === 'a' ? ' is-higher' : ''}`}>{m.a}</Text>
                  <Text className={`page-compare__td${m.higher === 'b' ? ' is-higher' : ''}`}>{m.b}</Text>
                </View>
              ))}
            </View>
            <Text className='page-compare__note'>
              只有热度标出更高的一方 —— 那是唯一跨档可比较的曝光度读数。报道量、动态、言论、履历的条数都取决于素材多寡（深度档会抓得更多），多不代表更好，因此只列数字、不做评判。
            </Text>
          </View>

          <View className='card'>
            <View className='card-title'>舆论情绪结构</View>
            <SentimentBar label={result.a.name} data={result.a.sentiment} />
            <SentimentBar label={result.b.name} data={result.b.sentiment} />
            {(result.a.sentiment.total > 0 || result.b.sentiment.total > 0) && (
              <Text className='page-compare__note'>
                按各自报告内「近期动态」条目的情绪标注统计。条数不同时百分比才可比，因此这里看的是结构而不是总数。
              </Text>
            )}
          </View>

          <View className='card'>
            <View className='card-title'>共同关注点</View>
            {result.common.length === 0 ? (
              <Text className='page-compare__note'>
                两份报告的报道主题没有明显重叠 —— 他们最近被讨论的事几乎不沾边。
              </Text>
            ) : (
              <>
                <View className='page-compare__tags'>
                  {result.common.map((c) => (
                    <View key={c.word} className='page-compare__tag'>
                      <Text>{c.word}</Text>
                      <Text className='page-compare__tag-count'>{`${c.aCount}/${c.bCount}`}</Text>
                    </View>
                  ))}
                </View>
                <Text className='page-compare__note'>
                  斜杠两侧是两位名人各自的报道中提到该说法的素材条数。共同关注点来自双方素材的用词重叠，是端上统计结果。
                </Text>
              </>
            )}
          </View>

          <View className='card'>
            <View className='card-title'>各自在讲什么</View>
            <View className='page-compare__cols'>
              <View className='page-compare__col'>
                <Text className='page-compare__col-name'>{result.a.name}</Text>
                {result.onlyA.length === 0 ? (
                  <Text className='page-compare__empty-inline'>无明显独有话题</Text>
                ) : (
                  result.onlyA.map((k) => (
                    <View key={k.word} className='page-compare__tag page-compare__tag--plain'>
                      <Text>{k.word}</Text>
                    </View>
                  ))
                )}
              </View>
              <View className='page-compare__col'>
                <Text className='page-compare__col-name'>{result.b.name}</Text>
                {result.onlyB.length === 0 ? (
                  <Text className='page-compare__empty-inline'>无明显独有话题</Text>
                ) : (
                  result.onlyB.map((k) => (
                    <View key={k.word} className='page-compare__tag page-compare__tag--plain'>
                      <Text>{k.word}</Text>
                    </View>
                  ))
                )}
              </View>
            </View>
          </View>

          {/* 两边都没立场也出卡并写明原因（原先不成立就整卡消失） */}
          {result.a.stances.length === 0 && result.b.stances.length === 0 && (
            <View className='card'>
              <View className='card-title'>公开立场对照</View>
              <Text className='page-compare__note'>
                两份报告都没有命中可对照的公开立场。立场是模型在生成报告时判定的，只有那份报告里正好写到才有 —— 不是本页没取到。
              </Text>
            </View>
          )}
          {(result.a.stances.length > 0 || result.b.stances.length > 0) && (
            <View className='card'>
              <View className='card-title'>公开立场对照</View>
              <View className='page-compare__cols'>
                <View className='page-compare__col'>
                  <Text className='page-compare__col-name'>{result.a.name}</Text>
                  <StanceColumn side={result.a} />
                </View>
                <View className='page-compare__col'>
                  <Text className='page-compare__col-name'>{result.b.name}</Text>
                  <StanceColumn side={result.b} />
                </View>
              </View>
              <Text className='page-compare__note'>
                立场由 AI 依据各自报告收录的素材判定。两位名人的热点话题通常并不重合，故并排呈现而非强行配对。
              </Text>
            </View>
          )}

          {/*
            对比问答（O-18）：把上面这些「摊开的对照表」接上一句能追问的话。
            位置刻意在所有对照表之后、底部动作之前：先把可核对的事实（热度 / 指标 / 情绪 / 共同关注点 /
            立场）全部摊完，用户带着具体疑问去问，问题才会问得准 —— 反过来先给提问框，
            用户会问出「谁更厉害」这种没有素材支撑的问题，反而收到一句「资料里没有相关信息」。
            这是本页唯一会产生模型调用与提问额度的区块（上面的表格全是端上聚合，零调用）。
            用 .card 包住：本页通篇是卡片流（热度对照 / 指标对照 / …），问答此前是唯一一块裸区块 ——
            头部一张白卡、气泡直接浮在灰底上、输入条横穿整页，夹在中间像是另一个页面的东西。
            卡片内部的版式压平见 index.scss &__qa，闸门口径与提问逻辑一行没动
            （面板仍是报告页 / AI 提问页共用的那一个）。
            高度由 .page-compare__qa 固定：页面本身是长滚动，QaPanel 靠 flex:1 撑满父容器。
            safeBottom=false：面板底边不在屏幕底边（下面还有动作卡），不必再让一次底部安全区，
            否则卡片底部会多出一整条空白。
          */}
          {base && rival && (
            <View className='card page-compare__qa'>
              <View className='card-title'>对比问答</View>
              <QaPanel report={base} name={base.name} withReport={rival} member={member} safeBottom={false} />
            </View>
          )}

          {/*
            底部动作（O-18）：对比页是全项目最容易被顺手转发的页面（两个人名本身就是话题），
            但此前唯一的出口是「换人对比」—— 看完、认同之后没有任何可做的事。
            补两条最自然的后续动作，顺序与此刻的心理一致：先「留下」（关注），再「带走」（分享）。
          */}
          <View className='card page-compare__follow'>
            <View className='card-title'>关注这两位</View>
            <Text className='page-compare__note'>
              关注后 TA 有新动态会出现在关注流与消息中心。这里是按人关注，不影响上面这份对比结果。
            </Text>
            <View className='page-compare__follow-row'>
              {[result.a, result.b].map((side) => (
                <AtButton
                  key={side.personKey}
                  size='small'
                  circle
                  type={followed[side.personKey] ? 'secondary' : 'primary'}
                  onClick={() => void onToggleFollow(side)}
                >
                  {followed[side.personKey] ? `已关注 · ${side.name}` : `关注 ${side.name}`}
                </AtButton>
              ))}
            </View>
            {/* 转发：open-type=share 会走本页已注册的 onShareAppMessage（标题就是「A vs B」） */}
            <Button className='page-compare__share' openType='share' hoverClass='none'>
              分享这份对比
            </Button>
          </View>

          <Text className='page-compare__disclaimer'>
            对比数据全部来自两份已生成的深度报告，本次对比不产生任何新的模型判断；报告本身由 AI 依据公开网络信息整理，可能存在偏差。
          </Text>
        </>
      )}
    </View>
  )
}
