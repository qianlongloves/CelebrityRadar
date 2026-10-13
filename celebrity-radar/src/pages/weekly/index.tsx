import { useMemo, useState } from 'react'
import Taro, { useDidShow, useShareAppMessage } from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import EmptyState from '@/components/empty-state'
import NoticeClose from '@/components/notice-close'
import Skeleton from '@/components/skeleton'
import SharePoster from '@/components/share-poster'
import {
  WEEKLY_WINDOW_DAYS,
  MATERIAL_FAIL_TEXT,
  buildWeeklyDigest,
  collectWeeklyMaterial,
  generateWeekly,
  readWeeklyCache
} from '@/utils/weekly'
import type { MaterialOutcome, WeeklyMaterial, WeeklyOutcome, WeeklyReport } from '@/utils/weekly'
import {
  buildWeeklyBrief,
  canExportWeeklyBrief,
  weeklyBriefCopy,
  weeklyExportNote
} from '@/utils/weekly-brief'
import { renderWeeklyBriefPoster, weeklyBriefHeight } from '@/utils/share-card'
import { readMemberState } from '@/utils/member'
import { buildDayDistribution } from '@/utils/stats'
import { peekGenerateQuota } from '@/utils/quota'
import { useAuth } from '@/stores/auth'
import { domainLabel, domainStyleCode } from '@/config/domains'
import { dayKey8, fromNow } from '@/utils/time'
import { track } from '@/utils/events'
import './index.scss'

/**
 * 本周周报（§2.2 M5-2）。
 *
 * 两条状态来源要分清，混起来会出现「点了生成却没反应」这类问题：
 *   - 本机缓存命中 → 直接可读（零成本，不消耗额度）；
 *   - 无缓存 → 先只汇总材料（零成本）并展示覆盖范围，用户确认后再生成（消耗 1 次额度）。
 * 生成只发生在用户点击之后，不会一进页面就悄悄扣额度。
 */

type Phase =
  | 'loading'
  | 'idle'
  | 'generating'
  | 'ready'
  | 'nologin'
  | 'nofollow'
  | 'nomaterial'
  | 'quota'
  | 'cooldown'
  | 'error'

export default function Weekly() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [report, setReport] = useState<WeeklyReport | null>(null)
  const [material, setMaterial] = useState<WeeklyMaterial | null>(null)
  /** true = 当前这份来自本机缓存（用于区分「读了缓存」与「刚生成」的文案） */
  const [fromCache, setFromCache] = useState(false)
  const [message, setMessage] = useState('')
  /** 今日剩余生成次数：仅在能读到配额时展示，读不到就不显示（不阻塞主流程） */
  const [quotaLeft, setQuotaLeft] = useState<number | null>(null)
  /**
   * 「本次未生成 AI 概述」警示条是否被用户关掉（2026-10-10，需求：提示框都要有关闭按钮）。
   * 每次生成出新报告时复位 —— 关掉的是「这一份」的说明，换一份就该重新出现。
   */
  const [warnClosed, setWarnClosed] = useState(false)
  /**
   * 是否会员（P4-B：导出 / 分享周报图是会员权益）。
   * ⚠ 每次进入页面（useDidShow）重读 `users.membership` 镜像，不引入额外缓存 —— 开通后重进即生效
   *   （沿用舆情页 readMemberState 口径）。站内查看周报**不分档**，本状态只门禁「导出分享图」这一个动作。
   */
  const [isMember, setIsMember] = useState(false)
  /** 分享图弹层是否打开 */
  const [posterOpen, setPosterOpen] = useState(false)
  /** 免费用户点导出入口后，是否显示**非弹窗**的升级引导行（点引导行跳会员页） */
  const [exportGuide, setExportGuide] = useState(false)

  /* 端上聚合（时间线 / 来源 / 领域 / 跨度）：纯函数，同一份周报任何时候打开结果都一样 */
  const digest = useMemo(() => (report ? buildWeeklyDigest(report) : null), [report])
  /**
   * 周报简报（P4-B）：分享图与复制摘要共用的纯数据（内容取舍全在 utils/weekly-brief.ts，
   * 本页只把它交给弹层；同一份周报任何时候生成的要点都一样）。
   */
  const brief = useMemo(() => (report ? buildWeeklyBrief(report) : null), [report])
  /** 本期要点（模型产出）。旧缓存没有这一段，按「本来就没有」处理并写明怎么补（见字段注释） */
  const highlights = report?.highlights ?? []
  /** 领域分布的归一基准：条数最多的那个领域占满整条 */
  const domainMax = digest?.domains[0]?.entries ?? 1

  const refreshQuota = async () => {
    const uid = useAuth.getState().userId
    if (!uid) return
    try {
      const q = await peekGenerateQuota(uid)
      /*
       * 开挂态（调试开关放开生成额度）不显示剩余次数：数字本身是真实的，但「剩 N 次」
       * 这句话在闸门放开时已不成立（见 utils/quota.ts 的 unlimited）。
       * 复用 null 这个既有的「不显示」信号，不新增状态。
       */
      setQuotaLeft(q.unlimited ? null : q.remaining)
    } catch {
      /* 配额只是提示信息，读不到就不显示 */
    }
  }

  const load = async () => {
    /* 缓存优先：本周已生成过就直接读，避免每次进入都重新收材料 */
    const cached = readWeeklyCache()
    if (cached) {
      setReport(cached)
      setFromCache(true)
      setPhase('ready')
      void refreshQuota()
      return
    }

    setPhase('loading')
    let res: MaterialOutcome
    try {
      res = await collectWeeklyMaterial()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setPhase('error')
      return
    }
    if (res.kind === 'ok') {
      setMaterial(res.material)
      setPhase('idle')
    } else {
      setPhase(res.kind)
    }
    void refreshQuota()
  }

  /**
   * 读会员态（只影响「导出分享图」是否放行；读库失败按非会员处理 —— 保守，不放大权益）。
   * 与舆情页同一取舍：挂在 useDidShow 上，开通后重进即生效，不引入额外缓存。
   */
  const loadMember = async () => {
    try {
      setIsMember((await readMemberState()).member)
    } catch {
      setIsMember(false)
    }
  }

  useDidShow(() => {
    void load()
    void loadMember()
  })

  useShareAppMessage(() => ({
    title: report ? `本周周报 · ${report.personCount} 位关注人的近况` : '名人雷达 · 关注周报',
    path: '/pages/weekly/index'
  }))

  /**
   * 真正发起生成（消耗 1 次今日额度）。
   *
   * `keepContent` 用于「重新生成」：手上已有一份可读的周报，失败时不能把用户从内容上踢回空态
   * （那等于用一次失败换走了他原有的东西），改为留在原报告上 toast 提示。
   */
  const doGenerate = async (mat: WeeklyMaterial, keepContent = false) => {
    if (!keepContent) setPhase('generating')
    Taro.showLoading({ title: '正在汇总…', mask: true })

    /* 先收起 loading 再弹 toast：微信端 hideLoading 与 showToast 同属一个「交互层」，
       顺序反了会把刚弹出的 toast 一起收掉 */
    let outcome: WeeklyOutcome
    try {
      outcome = await generateWeekly(mat)
    } catch (err) {
      outcome = { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
    Taro.hideLoading()
    void refreshQuota()

    if (outcome.kind === 'ok') {
      setReport(outcome.report)
      setFromCache(false)
      setPhase('ready')
      /* 新周报：警示条若是这一版才出的，得重新可见（见 warnClosed 注释） */
      setWarnClosed(false)
      return
    }

    setMessage(outcome.message)
    if (keepContent) {
      setPhase('ready')
      Taro.showToast({ title: outcome.message, icon: 'none', duration: 3200 })
      return
    }
    setPhase(outcome.kind === 'quota' ? 'quota' : outcome.kind === 'cooldown' ? 'cooldown' : 'error')
  }

  const startGenerate = () => {
    if (!material || phase === 'generating') return
    void doGenerate(material)
  }

  /**
   * 重新生成：材料先重新收集。
   * 用户很可能刚去关注流刷新过，沿用旧材料会得到一份「看起来没变」的周报。
   */
  const regenerate = async () => {
    if (phase === 'generating') return
    const confirm = await Taro.showModal({
      title: '重新生成周报',
      content: `将重新汇总最近 ${WEEKLY_WINDOW_DAYS} 天的动态并覆盖当前这份，消耗 1 次今日生成额度。`,
      confirmText: '重新生成'
    })
    if (!confirm.confirm) return

    let res: MaterialOutcome
    try {
      res = await collectWeeklyMaterial()
    } catch (err) {
      Taro.showToast({
        title: err instanceof Error ? err.message : String(err),
        icon: 'none',
        duration: 3200
      })
      return
    }
    if (res.kind !== 'ok') {
      /* 原报告仍在：只提示，不切空态 */
      Taro.showToast({ title: MATERIAL_FAIL_TEXT[res.kind], icon: 'none', duration: 3200 })
      return
    }
    setMaterial(res.material)
    await doGenerate(res.material, true)
  }

  const openPerson = (personKey: string) => {
    Taro.navigateTo({ url: `/pages/profile/index?personKey=${encodeURIComponent(personKey)}` })
  }

  const copyAll = () => {
    if (!report) return
    const blocks: string[] = [`【本周周报 · ${report.windowLabel}】`]
    /* 收录范围先写：分享出去时「这份周报覆盖了什么」和内容一样重要，读者据此判断完整度 */
    if (report.coverage) {
      const c = report.coverage
      blocks.push(
        `收录：${c.withEntries} 位有动态的关注人 / 共关注 ${c.followed} 位${
          c.failed > 0 ? `，${c.failed} 位读取失败未计入` : ''
        }`
      )
    }
    if (report.overview) blocks.push(report.overview)
    if (highlights.length > 0) {
      blocks.push(`本期要点：\n${highlights.map((h, i) => `${i + 1}. ${h}`).join('\n')}`)
    }
    for (const p of report.persons) {
      const lines = [`■ ${p.name}（${domainLabel(p.domain)}）`]
      if (p.summary) lines.push(p.summary)
      for (const e of p.entries) {
        lines.push(`· ${e.title}${e.source ? `（${e.source}）` : ''} ${e.url}`)
      }
      blocks.push(lines.join('\n'))
    }
    if (digest && digest.timeline.items.length > 0) {
      blocks.push(
        `本周时间线：\n${digest.timeline.items
          .map((t) => `· ${t.date || '近期'} ${t.personName}：${t.title}`)
          .join('\n')}`
      )
    }
    if (report.topics.length > 0) blocks.push(`本周话题：${report.topics.join('、')}`)
    blocks.push(report.disclaimer)
    Taro.setClipboardData({ data: blocks.join('\n\n') })
    track('share', { channel: 'copy', scope: 'weekly' })
  }

  const goMember = () => void Taro.navigateTo({ url: '/pages/member/index' })

  /**
   * 「导出分享图」入口（P4-B，对所有用户可见，分层在点击那一刻生效）：
   *   · 本期没有可分享的动态 → 明确提示，不打开空图（不白屏）；
   *   · 免费用户 → **非弹窗**地就地展开一行升级引导（点了跳会员页），不放行；
   *   · 会员 → 打开分享图弹层（保存相册 / 复制摘要 / 转发）。
   * 门禁取自 utils/weekly-brief.ts#canExportWeeklyBrief（身份来自 readMemberState），不写死在页面里。
   */
  const onExport = () => {
    if (!report || !brief) return
    if (brief.points.length === 0) {
      Taro.showToast({ title: '本期暂无可分享的动态', icon: 'none' })
      return
    }
    if (!canExportWeeklyBrief(isMember)) {
      setExportGuide(true)
      return
    }
    setPosterOpen(true)
  }

  const quotaHint = quotaLeft === null ? '' : `（今日报告生成额度剩 ${quotaLeft} 次）`

  /**
   * 本周逐日分布（O-16②）：复用主页「数据 Tab」的月度分布聚合，只把刻度从天换成日。
   *
   * 与月度分布同一取舍 —— 锚点取**周报生成时间**而不是「现在」，于是同一份缓存周报
   * 任何时候打开都是同一张图；纯端上聚合，不新增 Schema / 云函数 / 额度消耗，
   * 存量周报缓存（含旧版）下一次渲染即出卡。
   */
  const dayDist = useMemo(() => {
    if (!report) return null
    const facts = report.persons.flatMap((p) =>
      p.entries.map((e) => ({ date: e.publishedDate, text: e.title }))
    )
    return buildDayDistribution(report.generatedAt, facts, WEEKLY_WINDOW_DAYS)
  }, [report])

  return (
    <View className='page-weekly glow-page safe-bottom'>
      {phase === 'loading' && <Skeleton rows={3} variant='feed' />}

      {/* 无缓存：先展示覆盖范围与额度代价，由用户决定是否生成 */}
      {phase === 'idle' && material && (
        <EmptyState
          icon='📰'
          title='生成本周周报'
          desc={`将汇总最近 ${WEEKLY_WINDOW_DAYS} 天关注人的 ${material.entryCount} 条动态，生成一份可复制、可分享的周报：本周综述 + 本期要点 + 动态时间线 + 逐人清单。共关注 ${material.followedCount} 位，其中 ${material.persons.length} 位近 7 天有动态；消耗 1 次今日生成额度${quotaHint}${
            material.failedCount > 0 ? `。另有 ${material.failedCount} 位的动态读取失败，本次不会计入` : ''
          }`}
          actionText='生成周报'
          onAction={startGenerate}
        />
      )}

      {phase === 'generating' && (
        <EmptyState icon='⏳' title='正在汇总本周动态' desc='模型正在把关注人的近期动态写成周报，请稍候' />
      )}

      {phase === 'ready' && report && (
        <View>
          <View className='card page-weekly__banner'>
            <View className='page-weekly__banner-head'>
              <View className='page-weekly__banner-title-box'>
                <Text className='page-weekly__banner-title'>本周周报</Text>
                <Text className='page-weekly__banner-range'>{report.windowLabel}</Text>
              </View>
              <Text className='page-weekly__regen' onClick={() => void regenerate()}>
                重新生成
              </Text>
            </View>

            <View className='page-weekly__banner-stats'>
              <View className='page-weekly__banner-stat'>
                <Text className='page-weekly__banner-stat-value'>{report.personCount}</Text>
                <Text className='page-weekly__banner-stat-label'>位关注人</Text>
              </View>
              <View className='page-weekly__banner-stat'>
                <Text className='page-weekly__banner-stat-value'>{report.entryCount}</Text>
                <Text className='page-weekly__banner-stat-label'>条动态</Text>
              </View>
            </View>

            {/*
              收录范围（coverage）：材料里只剩「最近 7 天确实有动态」的人，不写清总关注数，
              用户会把「10 位关注里只有 3 位有动静」读成「我的关注丢了」。
              旧缓存没有这一段（2026-10-10 之前生成），故整行不出而不是显示 0。
            */}
            {report.coverage && (
              <Text className='page-weekly__banner-note'>
                收录 {report.coverage.withEntries} 位有动态的关注人
                {report.coverage.followed > report.coverage.withEntries
                  ? ` · 共关注 ${report.coverage.followed} 位`
                  : ''}
                {report.coverage.failed > 0 ? ` · ${report.coverage.failed} 位读取失败未计入` : ''}
              </Text>
            )}

            <Text className='page-weekly__banner-note'>
              {fromCache ? '本周已生成，读取本机缓存 · 不消耗额度' : '本次生成已消耗 1 次今日额度'}
              {` · 生成于 ${fromNow(report.generatedAt)}`}
            </Text>
          </View>

          {report.degraded && !warnClosed && (
            <View className='warn-bar page-weekly__warn'>
              <Text className='warn-bar__text'>本次未生成 AI 概述，以下为素材清单；可稍后点「重新生成」</Text>
              <NoticeClose onClose={() => setWarnClosed(true)} />
            </View>
          )}

          {/*
            本周综述 / 近 7 天动态分布 / 本周话题：一律改成「卡片照出 + 写明为什么没有内容」。
            原先不成立就整卡不出，用户看到的是卡片一张张消失，只能怀疑是坏了
            （报告页、主页数据 Tab 同此处理）。
            降级周报仍不出综述卡：上方警示条已经说明「本次未生成 AI 概述」，再出一张空卡是重复。
          */}
          {(!!report.overview || !report.degraded) && (
            <View className='card'>
              <View className='card-title'>本周综述</View>
              {report.overview ? (
                <View className='page-weekly__overview'>{report.overview}</View>
              ) : (
                <Text className='page-weekly__dist-note'>
                  本次生成没有给出综述正文（这一段的留空条件见报告契约）。
                  下方「关注的人」里逐条列出了本次收录的动态与原文链接，可先据此阅读。
                </Text>
              )}
            </View>
          )}

          {/*
            本期要点：模型产出的「人 + 事实」短句，是这份周报最像「一份东西」的一段。
            降级周报不出（上方警示条已说明本次没有 AI 文字）；
            模型这次没给（或这是 2026-10-10 之前的旧缓存）则照出卡片写清原因与补救入口，
            而不是少一块让用户猜 —— 与本页其余卡片的取舍一致。
          */}
          {!report.degraded && (
            <View className='card'>
              <View className='card-title'>本期要点</View>
              {highlights.length > 0 ? (
                <View className='page-weekly__points'>
                  {highlights.map((h, i) => (
                    <View key={`${i}-${h}`} className='page-weekly__point'>
                      <Text className='page-weekly__point-index'>{i + 1}</Text>
                      <Text className='page-weekly__point-text'>{h}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text className='page-weekly__dist-note'>
                  这一版没有给出要点（模型本次没写，或这份是本功能升级前生成的旧周报）。
                  点右上「重新生成」可让模型再写一遍；下方时间线与逐人卡片里的动态直接取自素材，不受这段影响。
                </Text>
              )}
            </View>
          )}

          {/*
            动态时间线（端上聚合，见 utils/weekly.ts#buildWeeklyDigest）：
            逐人卡片回答「某人这周做了什么」，时间线回答「这周整体是什么节奏」，
            两者是同素材的两种切法 —— 所以它零成本、确定性，存量旧周报打开也立刻有。
          */}
          {digest && digest.timeline.total > 0 && (
            <View className='card'>
              <View className='card-title'>动态时间线</View>
              {digest.span && (
                <Text className='page-weekly__tl-range'>
                  按日期倒序 · 跨度 {digest.span.first} ~ {digest.span.last}
                </Text>
              )}
              <View className='page-weekly__tl'>
                {digest.timeline.items.map((t, i) => (
                  <View
                    key={`${t.personKey}-${t.url || i}`}
                    className='page-weekly__tl-item'
                    onClick={() => openPerson(t.personKey)}
                  >
                    <View className='page-weekly__tl-axis'>
                      <View className={`page-weekly__tl-dot page-weekly__tl-dot--${domainStyleCode(t.domain)}`} />
                      {i < digest.timeline.items.length - 1 && <View className='page-weekly__tl-line' />}
                    </View>
                    <View className='page-weekly__tl-body'>
                      <View className='page-weekly__tl-head'>
                        <Text className='page-weekly__tl-date'>{t.date ? t.date.slice(5) : '近期'}</Text>
                        <Text className='page-weekly__tl-who'>{t.personName}</Text>
                        {!!t.source && <Text className='page-weekly__tl-source'>{t.source}</Text>}
                      </View>
                      <Text className='page-weekly__tl-title'>{t.title}</Text>
                    </View>
                  </View>
                ))}
              </View>
              <Text className='page-weekly__dist-note'>
                共 {digest.timeline.total} 条动态
                {digest.timeline.dated < digest.timeline.total
                  ? `，其中 ${digest.timeline.dated} 条带发布日期`
                  : ''}
                {digest.timeline.total > digest.timeline.items.length
                  ? `，此处列最近 ${digest.timeline.items.length} 条；完整清单见下方「关注的人」。`
                  : '，已全部列在上面。'}
              </Text>
            </View>
          )}

          {/*
            逐日分布：标题不写「本周」——窗口是报告生成日往前 7 天的滚动窗口，不是自然周
            （与 time.ts 的选题口径一致）。
            带日期条目不足 3 条时**不再整卡不出**（门槛一个没动，仍与主页「时间分布」一致），
            改为照出卡片、写明为什么不出柱形图。
          */}
          {!report.degraded && (
            <View className='card'>
              <View className='card-title'>近 7 天动态分布</View>
              {!dayDist && (
                <Text className='page-weekly__dist-note'>
                  本次收录的带日期动态不足 3 条，摊到 7 天上多数格是空的，画不出分布，故不出柱形图。下方「关注的人」里逐条列了动态及其日期。
                </Text>
              )}
              {dayDist && (
                <>
                  <View className='page-weekly__days'>
                    {dayDist.items.map((d) => (
                      <View key={d.key} className='page-weekly__day'>
                        <Text className='page-weekly__day-count'>{d.count > 0 ? d.count : ''}</Text>
                        <View className='page-weekly__day-track'>
                          <View
                            className='page-weekly__day-bar'
                            style={{ height: `${d.count > 0 ? Math.max(10, Math.round(d.ratio * 100)) : 0}%` }}
                          />
                        </View>
                        <Text className='page-weekly__day-label'>{d.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text className='page-weekly__dist-note'>
                    横轴为日期（{dayDist.from} ~ {dayDist.to}），纵轴为当日收录的动态条数（同一说法只计一次）。
                  </Text>
                </>
              )}
            </View>
          )}

          {/*
            本期素材构成（端上聚合）：来源与领域都直接数素材字段，不引入模型的判断 ——
            「这些动态是从哪些渠道来的、集中在哪些领域」是读者判断这份周报可靠性的依据。
            一条都没有时整卡不出（上方分布卡已说明本次收录不足）。
          */}
          {digest && digest.domains.length > 0 && (
            <View className='card'>
              <View className='card-title'>本期素材构成</View>

              {digest.mostActive && (
                <Text className='page-weekly__mix-lead'>
                  动态最多：{digest.mostActive.name}（{digest.mostActive.count} 条）
                </Text>
              )}

              {digest.sources.length > 0 && (
                <>
                  <Text className='page-weekly__mix-label'>来源</Text>
                  <View className='page-weekly__chips'>
                    {digest.sources.map((s) => (
                      <Text key={s.name} className='page-weekly__chip'>
                        {s.name} · {s.count}
                      </Text>
                    ))}
                  </View>
                </>
              )}

              <Text className='page-weekly__mix-label'>领域</Text>
              {digest.domains.map((d) => (
                <View key={d.domain} className='page-weekly__domain'>
                  <Text className='page-weekly__domain-name'>{domainLabel(d.domain)}</Text>
                  <View className='page-weekly__domain-track'>
                    <View
                      className='page-weekly__domain-bar'
                      style={{ width: `${Math.max(6, Math.round((d.entries / domainMax) * 100))}%` }}
                    />
                  </View>
                  <Text className='page-weekly__domain-count'>
                    {d.persons} 人 · {d.entries} 条
                  </Text>
                </View>
              ))}

              <Text className='page-weekly__dist-note'>
                口径：条数与来源取自本机已抓取的动态缓存（同一说法只计一次），不含模型输出。
              </Text>
            </View>
          )}

          <View className='section-head'>
            <Text className='section-head__title'>关注的人</Text>
            <Text className='section-head__extra'>{report.personCount} 位</Text>
          </View>

          {report.persons.map((p) => {
            /* 该人素材里最近一条的日期（UTC+8）与来源个数：两条都是从素材直接读出的元信息 */
            const latest = p.entries.reduce((acc, e) => {
              const d = dayKey8(e.publishedDate ?? '')
              return d > acc ? d : acc
            }, '')
            const srcCount = new Set(p.entries.map((e) => (e.source || '').trim()).filter(Boolean)).size
            return (
              <View
                key={p.personKey}
                className='card page-weekly__person'
                onClick={() => openPerson(p.personKey)}
              >
                <View className='page-weekly__person-head'>
                  <View className={`page-weekly__person-icon page-weekly__person-icon--${domainStyleCode(p.domain)}`}>
                    {p.name.slice(0, 1)}
                  </View>
                  <View className='page-weekly__person-info'>
                    <Text className='page-weekly__person-name'>{p.name}</Text>
                    <Text className='page-weekly__person-domain'>
                      {domainLabel(p.domain)} · {p.entries.length} 条动态
                      {latest ? ` · 最近 ${latest.slice(5)}` : ''}
                      {srcCount > 0 ? ` · ${srcCount} 个来源` : ''}
                    </Text>
                  </View>
                </View>

                {!!p.summary && <View className='page-weekly__person-summary'>{p.summary}</View>}

                {p.entries.map((e, i) => (
                  <View key={`${p.personKey}-${i}`} className='page-weekly__entry'>
                    <Text className='page-weekly__entry-title'>{e.title}</Text>
                    <View className='page-weekly__entry-foot'>
                      <Text className='page-weekly__entry-meta'>
                        {e.source || '公开来源'} · {dayKey8(e.publishedDate ?? '') || '近期'}
                      </Text>
                      <Text
                        className='page-weekly__entry-copy'
                        onClick={(ev) => {
                          ev.stopPropagation?.()
                          Taro.setClipboardData({ data: e.url })
                        }}
                      >
                        复制链接
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )
          })}

          {/* 归不出话题也出卡（原先 `topics.length > 0 &&` 直接整卡不出）：说明为什么没有话题 */}
          {report.topics.length === 0 && (
            <View className='card'>
              <View className='card-title'>本周话题</View>
              <Text className='page-weekly__dist-note'>
                本次收录的动态里，跨名人反复出现的说法不足以归出话题（话题词取自标题与摘要原文，不做语义归类），故本卡只作说明。上方「关注的人」里逐条列了每个人的动态。
              </Text>
            </View>
          )}
          {report.topics.length > 0 && (
            <View className='card'>
              <View className='card-title'>本周话题</View>
              <View className='page-weekly__topics'>
                {report.topics.map((t) => (
                  <Text key={t} className='page-weekly__topic'>
                    {t}
                  </Text>
                ))}
              </View>
            </View>
          )}

          <View className='page-weekly__actions'>
            <View className='page-weekly__action page-weekly__action--ghost' onClick={copyAll}>
              复制全文
            </View>
            <View className='page-weekly__action' onClick={onExport}>
              导出分享图
            </View>
          </View>

          {/*
            免费用户点「导出分享图」后展开的**非弹窗**升级引导（P4-B）：就地一行，不遮罩不弹窗，
            点它进会员页（沿用 opinion-access#moreDetailNote 的克制写法与舆情页交互）。会员不显示。
          */}
          {exportGuide && !isMember && (
            <Text className='page-weekly__export-guide' onClick={goMember}>
              {weeklyExportNote()}
            </Text>
          )}

          <View className='disclaimer'>
            周报由 AI 汇总公开检索素材生成，仅供参考；分享前请自行核对信息
          </View>

          {/*
            分享图弹层（P4-B）：与名言卡**共用同一个弹层组件**（同一套离屏画布 / 保存相册权限处理 /
            失败降级 / dpr 像素比）。图上带来源与时间与「非平台定性」说明；复制摘要内容与图一致。
          */}
          {posterOpen && brief && (
            <SharePoster
              render={() => renderWeeklyBriefPoster(brief)}
              height={weeklyBriefHeight(brief.points.length)}
              title='本周简报'
              hint='图上带来源与时间，并注明「公开报道 · 非平台定性」'
              copyText={weeklyBriefCopy(brief)}
              onClose={() => setPosterOpen(false)}
            />
          )}
        </View>
      )}

      {phase === 'nologin' && (
        <EmptyState
          icon='🔐'
          title='登录后生成周报'
          desc={MATERIAL_FAIL_TEXT.nologin}
          actionText='去登录'
          onAction={() => Taro.switchTab({ url: '/pages/mine/index' })}
        />
      )}

      {phase === 'nofollow' && (
        <EmptyState
          icon='🤝'
          title='还没有关注名人'
          desc={MATERIAL_FAIL_TEXT.nofollow}
          actionText='去发现名人'
          onAction={() => Taro.switchTab({ url: '/pages/index/index' })}
        />
      )}

      {phase === 'nomaterial' && (
        <EmptyState
          icon='📡'
          title='最近 7 天还没有可汇总的动态'
          desc='周报汇总的是关注流已抓取的动态，先到「关注动态」页下拉刷新一次再来生成（每日限 10 次）'
          actionText='去关注流刷新'
          onAction={() => Taro.navigateTo({ url: '/pages/feed/index' })}
        />
      )}

      {phase === 'quota' && (
        <EmptyState
          icon='⏳'
          title='今日报告生成额度已用完'
          desc={message}
          actionText='稍后再来'
          onAction={() => void load()}
        />
      )}

      {phase === 'cooldown' && (
        <EmptyState icon='🌡' title='生成服务限流中' desc={message} actionText='重试' onAction={() => void load()} />
      )}

      {phase === 'error' && (
        <EmptyState
          icon='⚠️'
          title='周报生成失败'
          desc={message || '请稍后重试'}
          actionText='重新加载'
          onAction={() => void load()}
        />
      )}
    </View>
  )
}
