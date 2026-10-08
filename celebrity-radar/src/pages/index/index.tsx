import { useState } from 'react'
import Taro, { useDidShow, useShareAppMessage, useShareTimeline } from '@tarojs/taro'
import { View, Text, ScrollView, Image } from '@tarojs/components'
import { AtSearchBar, AtButton } from 'taro-ui'
import { DOMAIN_CODES, DOMAIN_COVERAGE_TEXT, DOMAIN_META, DomainCode, buildPersonKey } from '@/config/domains'
import {
  DOMAIN_FILTER_CODES,
  DomainFilterCode,
  FOCUS_CODES,
  FOCUS_META,
  FocusCode,
  domainFilterLabel,
  summarizeFilters
} from '@/config/filters'
import PersonCard, { PersonInfo } from '@/components/person-card'
import EmptyState from '@/components/empty-state'
import { useAuth } from '@/stores/auth'
import { HOT_PERSONS, HotPerson } from '@/config/hot'
import { loadHotBoard } from '@/utils/hot-board'
import { isSensitiveQuery } from '@/utils/sensitive'
import { disambiguate, PersonCandidate } from '@/utils/disambiguate'
import { track } from '@/utils/events'
import { exploreRandomPerson, pickRandomPerson, todayPerson } from '@/utils/explore'
import { listRecentHistory, HistoryRow } from '@/utils/history'
import { listFollows, toggleFollow } from '@/utils/follows'
import { loadMessages } from '@/utils/messages'
import { personShareTitle, reportSharePath } from '@/utils/share'
import { useTabBarSync } from '@/utils/tabbar'
import './index.scss'

/** 热搜词位数：取热门位前 4 位，点击即「填词 + 直接搜索」，省去手输 */
const HOT_WORD_COUNT = 4

/** 「最近搜索」最多展示条数（history 存上限 50 条，这里只取最近几位名人做快捷入口，同一人只出现一次） */
const RECENT_LIMIT = 6

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

type SearchState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'candidates'; candidates: PersonCandidate[] }
  | { phase: 'refused' }
  | { phase: 'notfound' }

export default function Index() {
  useTabBarSync()
  const [keyword, setKeyword] = useState('')
  const [state, setState] = useState<SearchState>({ phase: 'idle' })
  /** 搜索前的行业筛选（作用于消歧 + 候选列表） */
  const [domainHint, setDomainHint] = useState<DomainFilterCode>('all')
  /** 搜索前的关注方向（作用于报告生成侧重） */
  const [focus, setFocus] = useState<FocusCode>('all')
  /** 候选列表内的领域筛选（结果返回后可用） */
  const [domainFilter, setDomainFilter] = useState<DomainCode | 'all'>('all')
  /** 横幅右侧「今日名人」（同一天稳定，可点 ⟳ 随机换一位） */
  const [hero, setHero] = useState(() => todayPerson())
  /**
   * 热门榜：初始值为静态种子（首屏零等待），进页后由 utils/hot-board 换成
   * AI 每日榜（hot_board）；没有 AI 榜时回落真实热度，读取失败则就是这份静态榜单。
   * 卡片刻意不再展示热度数值 —— 榜位由榜单顺序表达。
   */
  const [board, setBoard] = useState<HotPerson[]>(HOT_PERSONS)
  /** 热门榜的领域筛选：此前只能按 heat 平铺，无法「选领域 → 看该领域名人」 */
  const [hotDomain, setHotDomain] = useState<DomainCode | 'all'>('all')
  /** 最近搜索：由报告页写入 history，回到发现页可一键复访 */
  const [recent, setRecent] = useState<HistoryRow[]>([])
  /**
   * 已关注的 personKey 集合。
   * 用一次 listFollows 拿全量再在内存里比对，而不是每张卡调 isFollowed：
   * 热门榜最多 24 张卡，逐张查询会打出几十个请求。
   */
  const [followedKeys, setFollowedKeys] = useState<Set<string>>(() => new Set())
  /** 正在切换关注态的 personKey（空串=空闲）：用于置灰按钮、防连点 */
  const [followPending, setFollowPending] = useState('')
  /**
   * 消息中心未读数（铃铛红点）。
   * 只统计「关注之后有新内容」与「本周周报待生成」等同机可算的提醒，
   * 与消息中心页共用 utils/messages 同一套判定，避免两处口径不一致。
   */
  const [unread, setUnread] = useState(0)
  const { nickname, userId, avatarUrl } = useAuth()

  /**
   * 转发（优化建议 O-13）。
   *
   * 本页此前没注册分享回调：右上角「转发」带出的是不含参数的地址，对方点开只会落在
   * 发现页，分享方想表达的「今天该看这个人」完全丢失。
   *
   * 本页是 tabBar 页、不能作分享落地页，所以落到**横幅上的今日名人报告** ——
   * 分享出去的是「一个今天值得看的人」，对方点开就是完整报告（tabBar 页作落地页是微信限制）。
   * 标题与报告页 / 名人主页 / 提问页同源（utils/share.ts）。
   */
  const sharePath = reportSharePath(hero.personKey)
  const shareTitle = personShareTitle(hero.name, hero.domain)
  useShareAppMessage(() => ({ title: shareTitle, path: sharePath }))
  useShareTimeline(() => ({ title: shareTitle, query: sharePath.split('?')[1] ?? '' }))

  /* 每次显示发现页都重取：首次进入、从报告页返回（刚查过的人要出现在「最近」），
     以及从名人主页 / 关注列表返回（那边的关注变更要同步到卡片按钮上） */
  useDidShow(() => {
    /* 走 listRecentHistory：按名人去重，避免 A→B→A 回访让同一个人在「最近」里占两格 */
    void listRecentHistory(RECENT_LIMIT).then(setRecent)
    void listFollows().then((rows) => setFollowedKeys(new Set(rows.map((r) => r.person_key))))
    /* 榜单带 TTL 内存缓存：重复进页不重复打云；命中缓存时返回同一数组引用，不触发重渲染 */
    void loadHotBoard().then(setBoard)
    /* 仅取未读数点亮铃铛：不阻塞首屏，也不带 force —— watch 的 60s 内存缓存与关注流页共用，
       从关注流切回发现页时基本命中，冷启动最多多打 2×关注数 次缓存读（默认缓存可读，无写扩散） */
    void loadMessages().then((feed) => setUnread(feed.unread))
    /* 本页不再读会员态：热门榜自 2026-10-08 起全员可见全部位数（见 utils/member.ts） */
  })

  const now = new Date()
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日 · 周${WEEKDAYS[now.getDay()]}`

  /** 头像 → 「我的」tab（未登录时同样落在该页，由页内引导登录） */
  const goMine = () => {
    void Taro.switchTab({ url: '/pages/mine/index' })
  }

  /**
   * 关注流入口：2026-10-07 底部菜单第二格换成「AI 提问」，关注流改二级页，
   * 落到发现页顶部（原本它自己占一格 tab，撤掉后必须有明确落点，
   * 否则「关注了人却找不到动态」—— 关注是留存主线，入口不能靠猜）。
   */
  const goFeed = () => {
    void Taro.navigateTo({ url: '/pages/feed/index' })
  }

  /** 铃铛：进消息中心（关注更新 / 周报提醒 / 平台公告，见 utils/messages） */
  const onBellTap = () => {
    void Taro.navigateTo({ url: '/pages/messages/index' })
  }

  /**
   * 搜索失败的反馈：弹框，不走页内空态。
   *
   * 失败信息（密钥未配置 / 网络超时 / 接口原文）是短时的一次性事件，塞进结果区会在
   * 页面中间留一大块「查询失败」，把下方热门推荐整个顶下去，用户还得先清掉才能继续
   * 浏览；弹框看完即走，页面保持原样。确认键直接重试，省去回去再点一次「搜索名人」。
   */
  const reportSearchError = async (name: string, message: string) => {
    /* 先回 idle：弹框期间不应残留 loading，页面也不该被失败态占位 */
    setState({ phase: 'idle' })
    const { confirm } = await Taro.showModal({
      title: '查询失败',
      content: message,
      confirmText: '重试',
      cancelText: '取消'
    })
    /* 重试复用本次的名词而非输入框现值：弹框期间输入框可能已被改动 */
    if (confirm) void doSearch(name)
  }

  /**
   * 搜索流（§4.2）：一级敏感拦截 → LLM 消歧 → 选定 personKey → 报告页。
   * 可显式传入关键词（热搜词一键搜索），缺省读输入框。
   */
  const doSearch = async (rawName?: string) => {
    const name = (rawName ?? keyword).trim()
    if (!name) return

    // 第一级：本地敏感名单（命中即拒答，不发任何网络请求，§六.7）
    if (isSensitiveQuery(name)) {
      setState({ phase: 'refused' })
      return
    }

    setState({ phase: 'loading' })
    setDomainFilter('all')
    track('search', { name, domain: domainHint, focus })
    const res = await disambiguate(name, { domainHint })
    if (!res.ok) {
      await reportSearchError(name, res.error)
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
    // 行业筛选在结果中自动生效（候选含该行业时）；候选区仍可手动改选
    setDomainFilter(
      domainHint !== 'all' && res.data.candidates.some((c) => c.domain === domainHint) ? domainHint : 'all'
    )
    setState({ phase: 'candidates', candidates: res.data.candidates })
  }

  const openPerson = (name: string, domain: DomainCode) => {
    const personKey = buildPersonKey(name, domain)
    track('disambiguate_selected', { personKey, focus })
    Taro.navigateTo({
      url: `/pages/report/index?personKey=${encodeURIComponent(personKey)}&focus=${focus}`
    })
  }

  /** 复访历史名人：history 已存 personKey，直接进报告页（与 openPerson 同一出口） */
  const openHistory = (row: HistoryRow) => {
    track('disambiguate_selected', { personKey: row.person_key, from: 'history' })
    Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(row.person_key)}` })
  }

  /**
   * 卡片内直接关注 / 取关。
   *
   * `toggleFollow` 返回 null 表示失败或未登录，此时**不动本地状态**（它内部已给出
   * 原因 toast，未登录会提示去「我的」页），避免把失败误当成取关成功而报喜。
   */
  const onToggleFollow = async (p: PersonInfo, source: string) => {
    if (followPending) return
    setFollowPending(p.personKey)
    const next = await toggleFollow(p.personKey, source)
    setFollowPending('')
    if (next === null) return
    setFollowedKeys((prev) => {
      const keys = new Set(prev)
      if (next) keys.add(p.personKey)
      else keys.delete(p.personKey)
      return keys
    })
    Taro.showToast({ title: next ? '已关注' : '已取消关注', icon: 'none' })
  }

  /** 重置筛选条件（回到「全部行业 · 综合」） */
  const resetFilters = () => {
    setDomainHint('all')
    setFocus('all')
  }

  /* 候选领域筛选（派生值） */
  const candidates = state.phase === 'candidates' ? state.candidates : []
  const candidateDomains = Array.from(new Set(candidates.map((c) => c.domain)))
  const filteredCandidates =
    domainFilter === 'all' ? candidates : candidates.filter((c) => c.domain === domainFilter)

  /* 热门榜派生值：热搜词 / 领域 chips / 领域筛选都跟着当前榜单走（榜单已数据化，不再写死） */
  const hotOfDomain = hotDomain === 'all' ? board : board.filter((p) => p.domain === hotDomain)
  /*
   * 榜单**全部渲染**，页面这一层不再截断位数。
   *
   * 2026-10-08 撤销原 O-19 的「免费 6 位 / 会员 24 位」分档：榜单一次渲染多少条由数据层
   * 单独决定（utils/hot-board.ts 的 BOARD_LIMIT，AI 榜与热度兜底都在那里截断），页面再截一次
   * 就变成两处各写一个数 —— 而它们本来就会漂。这里直接吃上游给多少显示多少。
   */
  const shownHot = hotOfDomain
  const hotDomains = DOMAIN_CODES.filter((d) => board.some((p) => p.domain === d))
  const hotWords = board.slice(0, HOT_WORD_COUNT)

  return (
    <View className='page-index glow-page safe-tab'>
      {/* 问候区（头像 + 昵称 + 右侧铃铛，点击头像进「我的」） */}
      <View className='page-index__header'>
        <View className='page-index__avatar' onClick={goMine} hoverClass='page-index__tap'>
          {avatarUrl ? (
            <Image className='page-index__avatar-img' src={avatarUrl} mode='aspectFill' />
          ) : userId ? (
            (nickname || '微').slice(0, 1)
          ) : (
            '?'
          )}
        </View>
        <View className='page-index__greet'>
          <Text className='page-index__username'>{userId ? nickname || '名人观察员' : '名人观察员'}</Text>
        </View>
        {/* 关注流入口：带关注人数，让「有没有关注人」一眼可见（0 人也保留入口，点了才知道怎么用） */}
        <View className='page-index__feed' onClick={goFeed} hoverClass='page-index__tap'>
          <Text className='page-index__feed-text'>
            {followedKeys.size > 0 ? `关注 ${followedKeys.size}` : '关注流'}
          </Text>
        </View>
        <View className='page-index__bell' onClick={onBellTap} hoverClass='page-index__tap'>
          {/* 红点按未读数显隐：铃铛图标自带的那颗紫点是装饰，这里才是「有消息」 */}
          {unread > 0 && <View className='page-index__bell-dot' />}
        </View>
      </View>

      {/* 主横幅卡（紫色卡 + 右侧「今日名人」头像） */}
      <View className='page-index__banner'>
        <View className='page-index__banner-body'>
          <View className='page-index__banner-top'>
            <Text className='page-index__banner-title'>今日名人雷达</Text>
            <Text className='page-index__banner-date'>{dateLabel}</Text>
          </View>
          <Text className='page-index__banner-desc'>AI 联网整理公开动态，生成可溯源的深度报告</Text>
          {/* 与底部中央按钮同一个入口：人选都由 AI 决定（见 utils/explore） */}
          <View
            className='page-index__banner-btn'
            hoverClass='page-index__banner-btn--tap'
            onClick={() => void exploreRandomPerson()}
          >
            {/* 箭头放在 JSX 里：写在 scss 的 content 会让 dart-sass 给 wxss 注入 @charset */}
            <Text>随机探索一位</Text>
            <Text>→</Text>
          </View>
        </View>

        {/* 今日名人：点击头像直接看 TA 的报告，点 ⟳ 随机换一位 */}
        <View className='page-index__hero'>
          <View
            className={`page-index__hero-avatar page-index__hero-avatar--${hero.domain}`}
            onClick={() => openPerson(hero.name, hero.domain)}
          >
            {hero.name.slice(0, 1)}
            <View
              className='page-index__hero-shuffle'
              onClick={(e) => {
                e.stopPropagation?.()
                setHero(pickRandomPerson())
              }}
            >
              ⟳
            </View>
          </View>
          <Text className='page-index__hero-name'>{hero.name}</Text>
          <Text className='page-index__hero-tag'>{DOMAIN_META[hero.domain].label} · 今日名人</Text>
        </View>
      </View>

      {/* 搜索卡：输入 + 行业 / 关注 双组筛选 */}
      <View className='page-index__search'>
        <View className='page-index__search-head'>
          <Text className='page-index__search-title'>搜名人</Text>
          <View className='page-index__search-tag'>AI 联网 · 可溯源</View>
        </View>

        <AtSearchBar
          value={keyword}
          onChange={setKeyword}
          placeholder={
            domainHint === 'all'
              ? '输入名人名字，如：雷军'
              : `在「${domainFilterLabel(domainHint)}」中搜索，如：雷军`
          }
          onConfirm={() => void doSearch()}
        />

        {/* 最近搜索：报告页持续写入 history，这里一键复访（未登录或无记录时整行不渲染）。
            固定占一行：6 条 chip 平铺会折成两行把首屏顶长，故与下方「行业 / 关注」同一套写法横滑。 */}
        {recent.length > 0 && (
          <View className='page-index__hot-words'>
            <Text className='page-index__hot-words-label'>最近</Text>
            <ScrollView className='page-index__recent-chips' scrollX>
              {recent.map((r) => (
                <View
                  key={r.id}
                  className='page-index__hot-word page-index__hot-word--recent'
                  hoverClass='page-index__hot-word--tap'
                  onClick={() => openHistory(r)}
                >
                  {r.name}
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* 热搜词：一键「填词 + 搜索」，降低首屏输入成本 */}
        <View className='page-index__hot-words'>
          <Text className='page-index__hot-words-label'>热搜</Text>
          {hotWords.map((w) => (
            <View
              key={w.name}
              className='page-index__hot-word'
              hoverClass='page-index__hot-word--tap'
              onClick={() => {
                setKeyword(w.name)
                void doSearch(w.name)
              }}
            >
              {w.name}
            </View>
          ))}
        </View>

        {/* 行业筛选：单行横滑，避免 chip 换行把首屏顶长 */}
        <View className='page-index__filter-row'>
          <Text className='page-index__filter-label'>行业</Text>
          <ScrollView className='page-index__filter-chips' scrollX>
            {DOMAIN_FILTER_CODES.map((code) => (
              <View
                key={code}
                className={`page-index__fchip ${domainHint === code ? 'page-index__fchip--active' : ''}`}
                onClick={() => setDomainHint(code)}
              >
                {domainFilterLabel(code)}
              </View>
            ))}
          </ScrollView>
        </View>

        {/* 关注方向筛选：同上，横滑单行 */}
        <View className='page-index__filter-row'>
          <Text className='page-index__filter-label'>关注</Text>
          <ScrollView className='page-index__filter-chips' scrollX>
            {FOCUS_CODES.map((code) => (
              <View
                key={code}
                className={`page-index__fchip ${focus === code ? 'page-index__fchip--active' : ''}`}
                onClick={() => setFocus(code)}
              >
                {FOCUS_META[code].label}
              </View>
            ))}
          </ScrollView>
        </View>
        <View className='page-index__focus-desc'>{FOCUS_META[focus].desc}</View>

        {/* 条件摘要 + 重置 */}
        <View className='page-index__search-foot'>
          <Text className='page-index__search-summary'>{summarizeFilters(domainHint, focus)}</Text>
          {(domainHint !== 'all' || focus !== 'all') && (
            <Text className='page-index__search-reset' onClick={resetFilters}>
              {'重置 ✕'}
            </Text>
          )}
        </View>

        <AtButton
          type='primary'
          loading={state.phase === 'loading'}
          disabled={!keyword.trim() || state.phase === 'loading'}
          onClick={() => void doSearch()}
          className='page-index__search-btn'
        >
          搜索名人
        </AtButton>

        {/*
          以下是这张卡的「输出区」：加载态 / 候选 / 各种空态。
          它们原先渲染在卡外，搜完之后视觉上是另起一块，和上面的搜索框像两个孤立组件；
          收进同一张卡后，输入 → 输出才是一条连续的动线（用 &__output 顶部分隔线断开控制台）。
        */}
        {state.phase === 'loading' && (
          <View className='page-index__output page-index__status'>
            {/* 雷达扫描：与「名人雷达」的产品比喻对上，比原先一行灰字更有「正在搜索」的实感 */}
            <View className='page-index__radar'>
              <View className='page-index__radar-ring' />
              <View className='page-index__radar-ring page-index__radar-ring--mid' />
              <View className='page-index__radar-sweep' />
              <View className='page-index__radar-dot' />
            </View>
            <Text className='page-index__status-text'>
              {domainHint === 'all'
                ? 'AI 正在识别同名人物…'
                : `AI 正在「${domainFilterLabel(domainHint)}」行业中识别同名人物…`}
            </Text>
            {/* 说明这一步到底在做什么，等待才有边界（这也是最慢的一次请求） */}
            <Text className='page-index__status-sub'>联网检索 · 同名消歧 · 结构化候选</Text>
            {/* 这里不再放骨架屏：雷达动画下面再叠两张灰卡，会读成「已经在出结果」，
                而此刻连候选数量都还不知道；只留动画，加载态才干净 */}
          </View>
        )}

        {state.phase === 'candidates' && (
          <View className='page-index__output'>
            <View className='page-index__result-head'>
              <Text className='page-index__result-title'>
                TA 是哪一位？
                <Text className='count-badge'>{state.candidates.length}</Text>
              </Text>
            </View>

            {/* 领域筛选（多于一个领域时展示） */}
            {candidateDomains.length > 1 && (
              <View className='page-index__filters'>
                <View
                  className={`page-index__filter ${domainFilter === 'all' ? 'page-index__filter--active' : ''}`}
                  onClick={() => setDomainFilter('all')}
                >
                  全部
                </View>
                {candidateDomains.map((d) => (
                  <View
                    key={d}
                    className={`page-index__filter ${domainFilter === d ? 'page-index__filter--active' : ''}`}
                    onClick={() => setDomainFilter(d)}
                  >
                    {DOMAIN_META[d].label}
                  </View>
                ))}
              </View>
            )}

            {/* 候选卡嵌在搜索卡内，person-card 自带的 44rpx 页边距由 &__output-cards 清零 */}
            <View className='page-index__output-cards'>
              {filteredCandidates.map((c) => {
                const personKey = buildPersonKey(c.name, c.domain)
                return (
                  <PersonCard
                    key={personKey}
                    person={{
                      personKey,
                      name: c.name,
                      domain: c.domain,
                      brief: c.brief,
                      followed: followedKeys.has(personKey)
                    }}
                    followPending={followPending === personKey}
                    onToggleFollow={(p) => void onToggleFollow(p, 'candidate_card')}
                    actionText='查看'
                    onAction={(p) => openPerson(p.name, p.domain)}
                    onClick={(p) => openPerson(p.name, p.domain)}
                  />
                )
              })}
            </View>

            {filteredCandidates.length === 0 && (
              <View className='page-index__filter-empty text-tertiary'>该领域暂无候选，试试其他筛选</View>
            )}

            <View className='page-index__fallback text-tertiary' onClick={() => setState({ phase: 'notfound' })}>
              都不是 TA？补充领域关键词再试 →
            </View>
          </View>
        )}

        {state.phase === 'refused' && (
          <View className='page-index__output'>
            <EmptyState icon='🚫' title='暂不支持查询该人物' desc={`本工具覆盖${DOMAIN_COVERAGE_TEXT}等多个领域的公众名人`} />
          </View>
        )}

        {state.phase === 'notfound' && domainHint === 'all' && (
          <View className='page-index__output'>
            <EmptyState
              icon='🤔'
              title='未识别到该名人'
              desc='试试补充领域关键词，如「雷军 科技」；或从下方热门推荐开始'
            />
          </View>
        )}

        {state.phase === 'notfound' && domainHint !== 'all' && (
          <View className='page-index__output'>
            <EmptyState
              icon='🤔'
              title='该行业下未识别到该名人'
              desc={`已限定行业为「${domainFilterLabel(domainHint)}」，该行业没有找到同名公众人物；可能是行业选错了，清除后重试`}
              actionText='清除行业筛选'
              onAction={() => setDomainHint('all')}
            />
          </View>
        )}
      </View>

      {/* 热门名人：一人一卡（头像 + 领域 + 动态速览 + 热度），点击直达 AI 报告 */}
      <View className='section-head'>
        <Text className='section-head__title'>热门名人</Text>
        <Text className='section-head__extra'>
          {hotDomain === 'all' ? '点击生成 AI 报告' : `该领域 ${hotOfDomain.length} 位`}
        </Text>
      </View>

      {/* 领域筛选：把「搜索前选行业」扩展为「先选领域，再看该领域有哪些名人」 */}
      {hotDomains.length > 1 && (
        <ScrollView className='page-index__hot-filters' scrollX>
          <View
            className={`page-index__fchip ${hotDomain === 'all' ? 'page-index__fchip--active' : ''}`}
            onClick={() => setHotDomain('all')}
          >
            全部
          </View>
          {hotDomains.map((d) => (
            <View
              key={d}
              className={`page-index__fchip ${hotDomain === d ? 'page-index__fchip--active' : ''}`}
              onClick={() => setHotDomain(d)}
            >
              {DOMAIN_META[d].label}
            </View>
          ))}
        </ScrollView>
      )}

      <View className='page-index__hot'>
        {shownHot.map((p) => {
          const personKey = buildPersonKey(p.name, p.domain)
          return (
            <PersonCard
              key={p.name}
              person={{
                personKey,
                name: p.name,
                domain: p.domain,
                brief: p.trend,
                tag: p.tag,
                followed: followedKeys.has(personKey)
              }}
              followPending={followPending === personKey}
              onToggleFollow={(x) => void onToggleFollow(x, 'hot_card')}
              /* 热门位两枚入口收成图标：文字胶囊会把长名字挤到换行、把领域标签压变形 */
              iconActions
              actionText='AI 报告'
              onAction={(x) => openPerson(x.name, x.domain)}
              onClick={(x) => openPerson(x.name, x.domain)}
            />
          )
        })}
      </View>
    </View>
  )
}
