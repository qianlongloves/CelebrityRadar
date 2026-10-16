import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input, ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
/* 按需引入：'taro-ui' 的包入口（dist/index.js）是打包好的 CJS，50 个组件全在里面且摇不掉，
   故组件一律从 dist/components/<名字> 取（那一层是 ESM 源码）。用例 70 钉住这一点。 */
import AtButton from 'taro-ui/dist/components/button'
import { MEMBER_DAILY_ASK_LIMIT } from '@/utils/member'
import NoticeClose from '@/components/notice-close'
import {
  QA_HISTORY_MAX,
  QA_MAX_QUESTION,
  askDirect,
  askReports,
  checkQaGate,
  clearQaAttempt,
  hasQaCorpusMany,
  noteQaAttempt,
  passageTag,
  qaUsageToday,
  refreshQaUsage,
  splitCitations,
  suggestCompareQuestions,
  suggestDirectQuestions,
  suggestQuestions
} from '@/utils/qa'
import type { QaPassage, QaStage, QaTurn, QaUsage } from '@/utils/qa'
import type { Report } from '@/utils/report'
import { fromNow, isStaleReport } from '@/utils/time'
import './index.scss'

/**
 * AI 问答会话面板（报告页的「向 AI 提问」、底部菜单「AI 提问」、对比页「对比问答」共用同一套会话）。
 *
 * 为什么抽成组件而不是几处各写一遍：会话里最容易出岔子的不是气泡样式，而是三件必须一致的事 ——
 * ① **闸门口径**：每日上限按会员 / 免费版分档（唯一事实源在 utils/member.ts），
 *    几处各写一份早晚会出现「这个入口能问 30 次、那个只能问 5 次」；
 * ② **失败与回答必须能分开看**：报错若长得像 AI 说的话，用户会把「提问太快了」当成回答；
 * ③ 「不落库」的口径：每次提问都重新拼一次 prompt，**只有本会话最近两轮会作为上文带上**
 *    （2026-10-15 加，见 utils/qa.ts#QaAskOpts.history）—— 换人、离开页面即忘；
 *    界面不得暗示 AI 记得历史（原先那句声明 2026-10-09 已按需求去掉，口径照旧）。
 * 对比模式（传 `withReport`，O-18）复用同一套面板，正是为了不让这三条各多出一份实现。
 *
 * 高度交给父容器（本组件只负责撑满）：报告页整屏用，底部菜单页与上方的名人选择共处一屏，
 * 对比页则需要父容器给一个固定高度（页面本身是长滚动，不设高就会把整页拉得极其冗长）。
 * `member` 由页面读取后传入（页面在 onShow 时刷新），组件内不重复读库。
 */

interface Props {
  /**
   * 提问对象的报告。**没有报告时可以为空**（2026-10-12 直连模式）：此时面板改用 `name` 直连大模型
   * 作答（见 utils/qa.ts#askDirect），界面会标注「未基于报告素材」。
   */
  report?: Report
  /**
   * 提问对象姓名 / 话题名（**直连态必用**）。
   * 有报告时通常与 report.name 一致，但仍显式传入 —— 直连态没有 report 可取名。
   */
  name: string
  /**
   * 第二位名人（O-18 对比问答）：带上它就切到「多人语料」——
   * 语料变成两份报告合并编号、建议问题换成对比向、提示词多一条「别把两人搞混」的约束。
   *
   * 为什么不新写一个 CompareQaPanel：会话面板里真正难的不是气泡，而是
   * 闸门口径 / 失败与回答的分野 / 引用的可核对性这几件必须一致的事（见文件头注释）。
   * 复制一份出来，等于把这几个最容易走样的地方各留一份实现。
   */
  withReport?: Report
  /** 会员态：决定每日提问上限（免费版 / 会员两档） */
  member: boolean
  /**
   * 面板底边是否就是屏幕底边、需要自己让开底部安全区（iPhone 横条），默认 true。
   *
   * 贴屏幕底边时必须自己让：输入框不能被横条压住，白色底也要铺到屏幕最底，
   * 否则最下面会露出一条页面灰底。底部菜单「AI 提问」页要传 false —— 那页根容器
   * 带了 .safe-tab（已含 env(safe-area-inset-bottom)），面板再让一次就是双份，
   * 输入框下方会凭空多出一整条空白。
   */
  safeBottom?: boolean
  /**
   * 隐藏头部：底部菜单「AI 提问」页专用。
   *
   * 那页的选人条就在正上方 —— 选中的人（高亮胶囊）与剩余次数（标题行右侧）都已给过，
   * 头部这条「名字 · 剩 N 次」是纯粹的重复，还会把本就不多的会话区再挤掉一截。
   * 回报告页的出口改由输入框左侧的 PDF 图标承担（见下方 composer），头部整块不必存在。
   *
   * 报告页 / 对比页的会话仍带头部：那两处没有选人条，名字与报告入口只能由头部提供。
   */
  hideHead?: boolean
}

interface Bubble {
  id: number
  role: 'user' | 'ai'
  text: string
  /** true = 这不是回答，而是失败提示（样式上必须与回答区分，否则会被当成 AI 说的话） */
  error?: boolean
  /** 仅回答有：这次拼进 prompt 的资料，用来把正文里的 [n] 还原成可点来源 */
  sources?: QaPassage[]
}

/**
 * 建议问题分批展示的批大小。
 * `suggestQuestions` 会按报告内容产出最多 8 条，一次全铺出来会把会话区挤满、
 * 也让人挑花眼；一次 4 条 + 「换一批」既保住冷启动引导，也不占掉会话空间。
 */
const SUGGEST_PAGE_SIZE = 4

/** 输入超过这个字数才显示计数：常态挂一个「0/120」纯属噪音 */
const COUNT_HINT_FROM = Math.floor(QA_MAX_QUESTION * 0.8)

export default function QaPanel({
  report,
  name,
  withReport,
  member,
  safeBottom = true,
  hideHead = false
}: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [asking, setAsking] = useState(false)
  const [notice, setNotice] = useState('')
  /**
   * 提示条是否被用户关掉（2026-10-10，需求：「所有文字提示的框都要有关闭按钮」）。
   * 只对本条提示有效：notice 一变就复位（见下方 useEffect），这样「上一条关了」不会把
   * 下一条闸门提示 / 语料提示一起吞掉；用户真正要忽略的只是眼前这一句。
   */
  const [noticeClosed, setNoticeClosed] = useState(false)
  /*
   * 今日提问用量（已用 / 还可问，见 utils/qa.ts#qaUsageToday）。
   * 存整个口径而不是只存「剩余次数」：升级提示要按 `unlimited` 判定（开挂态不弹，
   * 此时并没被拦），只留一个数字就没法区分「真的还剩 0 次」与「闸门被放开」。
   */
  const [usage, setUsage] = useState<QaUsage>(() => qaUsageToday(member))
  /* 建议问题当前批次（「换一批」只动这个下标，不重新生成问题） */
  const [suggestPage, setSuggestPage] = useState(0)

  /* 防连点用 ref：setAsking 是异步的，连点两次时会话可能同时发两条 */
  const busy = useRef(false)
  const seq = useRef(0)

  /*
   * 会员态变化要立刻反映到「今日还可问」上（刚在会员中心买完返回，数字就该变）；
   * 同时把云端计数拉回来对齐本机镜像 —— 换设备、或本机被清过数据时镜像会偏。
   * 先渲染镜像值、再异步对齐：这一步不值得让面板出现 loading。
   */
  useEffect(() => {
    let alive = true
    setUsage(qaUsageToday(member))
    void refreshQaUsage().then(() => {
      if (alive) setUsage(qaUsageToday(member))
    })
    return () => {
      alive = false
    }
  }, [member])

  /**
   * 直连态（2026-10-12）：没有报告、也不是对比 → 用 `name` 直连大模型作答（不生成报告）。
   * 对比态（有 withReport）必定带主报告，故 `!report && !withReport` 才是直连。
   */
  const direct = !report && !withReport

  /* 语料来源（O-18）：带第二份报告就是两份，否则仍是单份 —— 单份路径逐条行为不变；直连态为空 */
  const reports = useMemo(() => {
    if (report && withReport) return [report, withReport]
    if (report) return [report]
    return []
  }, [report, withReport])
  const multi = reports.length > 1
  /**
   * 本会话已完成的问答（最近两轮，追问用）。
   *
   * 为什么是 ref 而不是 state：它只作为**下一次提问的入参**，界面没有任何地方依赖它 ——
   * 放 state 只会让每轮回答都多触发一次整面板重渲染。
   * 也刻意不落 storage：离开页面即忘（见组件头注释口径③），不让用户以为 AI 记得历史。
   */
  const turns = useRef<QaTurn[]>([])
  /**
   * 本次提问执行到哪一步（2026-10-15）：一次提问在端上要串四段（闸门 → 机审 → 检索 → 模型），
   * 十几秒的等待里「不知道在等什么」比慢本身更难受。阶段由 utils/qa.ts 回推（onStage），
   * 文案与实际动作同源 —— 判定为不检索的那一问（utils/qa.ts#needsWebSearch），
   * 绝不会显示「正在联网检索」，不会让用户以为在联网、实则只读了报告。
   */
  const [stage, setStage] = useState<QaStage>('read')
  /** 会话身份：任一位换人就清空会话；直连态没有 personKey，用姓名 */
  const sessionKey = useMemo(
    () => (direct ? name : reports.map((r) => r.personKey).join('+')),
    [direct, name, reports]
  )

  /*
   * 直连态没有报告可判，一律视为「有可用素材」—— 否则 `corpusOk` 会把输入框禁掉，
   * 直连模式就永远发不出问题（而它恰恰是为「没有报告的人」准备的）。
   */
  const corpusOk = useMemo(() => (direct ? true : hasQaCorpusMany(reports)), [direct, reports])
  const suggestions = useMemo(() => {
    if (direct) return suggestDirectQuestions(name)
    if (report && withReport) return suggestCompareQuestions(report, withReport)
    if (report) return suggestQuestions(report)
    return []
  }, [direct, name, report, withReport])
  /** 两份报告合计的素材条数（多人时头部要一个能一眼看懂的量级）；直连态无报告，恒为 0 */
  const totalItems = useMemo(
    () => reports.reduce((n, r) => n + (r.coverage?.items ?? r.dynamics.length), 0),
    [reports]
  )

  useEffect(() => {
    if (!corpusOk) {
      setNotice(
        multi
          ? '这两份报告都没有可用于问答的素材，回报告页点「刷新最新」后再来试试'
          : '这份报告没有可用于问答的素材，回报告页点「刷新最新」后再来试试'
      )
    }
  }, [corpusOk, multi])

  /* 提示内容一变就重新可见：关闭只针对「眼前这一句」，不跨提示生效（见 noticeClosed 注释） */
  useEffect(() => {
    setNoticeClosed(false)
  }, [notice])

  /*
   * 换名人就清空会话（底部菜单页可在同一屏切换提问对象）。
   * 旧对话留在新名人的页面上会被读成「这是 TA 说的」—— 比清空的体验损失更大。
   * 对比模式下两位任一位换了也要清（旧回答里混着已被换掉的那个人）。
   */
  useEffect(() => {
    setBubbles([])
    setInput('')
    setNotice('')
    seq.current = 0
    /* 上文同样要清：追问里的「他」在新对象身上会指错人（比清空会话更糟的问题） */
    turns.current = []
  }, [sessionKey])

  /** 滚动锚点：每次新增气泡 id 都不同，所以能持续触发滚动到底 */
  const anchor = useMemo(() => {
    if (asking) return 'qa-end'
    const last = bubbles[bubbles.length - 1]
    return last ? `qa-msg-${last.id}` : ''
  }, [asking, bubbles])

  const send = useCallback(
    async (preset?: string) => {
      const question = (preset ?? input).trim()
      if (!question || busy.current) return

      /*
       * 闸门现在要 `await` 云端计数（额度不可伪造，见 utils/qa.ts），
       * 所以**先占住 busy 再判**：否则 await 那几十毫秒里再点一下，
       * 两次调用会都通过闸门、发出两条真实请求（上游按次计费，白花钱）。
       * 被闸门拦下时 finally 会立刻放开，用户改完问题仍可马上再发。
       */
      busy.current = true
      try {
        const gate = await checkQaGate(member)
        if (!gate.allowed) {
          setNotice(gate.message)
          return
        }

        setAsking(true)
        setNotice('')
        setInput('')
        /* 进度复位：上一轮停在 'answer'，不重置会让这一轮一开始就说「正在整理答案」 */
        setStage('read')
        seq.current += 1
        const mine = seq.current
        setBubbles((prev) => [...prev, { id: mine, role: 'user', text: question }])
        noteQaAttempt()

        /*
         * 追问三件套（2026-10-15）：
         * ① 带上本会话最近两轮（上限由 utils/qa.ts#QA_HISTORY_MAX 定，这里不另立一套数字）；
         * ② 把执行阶段回推到界面（等待文案与实际动作同源）；
         * ③ **成功才记账** —— 失败的回答不算「上文」，否则模型会顺着一段没发生的对话往下编。
         */
        const ask = { history: turns.current, onStage: setStage }
        const res = direct ? await askDirect(name, question, ask) : await askReports(reports, question, ask)

        setAsking(false)
        if (res.ok) {
          turns.current = [...turns.current, { q: question, a: res.text }].slice(-QA_HISTORY_MAX)
        }
        /*
         * 这次没问成，就把占用的在途名额还回去（P2-15）。归还方向是安全的：
         * 漏还只会让用户被少放行一次，多还（addInflight 夹到 0 以上）不会。
         */
        if (!res.ok) clearQaAttempt()
        setUsage(qaUsageToday(member))
        seq.current += 1
        setBubbles((prev) => [
          ...prev,
          res.ok
            ? { id: seq.current, role: 'ai' as const, text: res.text, sources: res.sources }
            : { id: seq.current, role: 'ai' as const, text: res.error, error: true }
        ])
      } finally {
        busy.current = false
      }
    },
    [input, member, reports, direct, name]
  )

  const canSend = corpusOk && input.trim() !== '' && !asking
  /**
   * 免费版且今日额度已用完 → 给一条升级入口。
   * 这是全流程里转化说服力最强的位置：用户刚刚体会到「问一句就有回答」，正想继续问。
   *
   * `!usage.unlimited`：调试开挂时剩余次数会照实归 0（用量展示如实报数），
   * 但此时并不真的被拦，弹「开通会员」就成了骗人 —— 开挂态一律不弹。
   */
  const showUpsell = !member && !usage.unlimited && usage.remaining === 0
  /**
   * 提问用量那一行的措辞（O-28 缩短）。
   *
   * 一律说「剩 N 次」：调试开关只松闸门、不改展示（见 utils/debug.ts），
   * 界面与真实用户所见逐字一致 —— 不出现「不限次」这类字样；
   * 数字取自 utils/qa.ts#qaUsageToday 的真值，不是为开挂圆场的满额。
   *
   * 措辞刻意写到最短：它与名人名字**同一行**（见下方 __left），字数多一个字，
   * 长名字就多被挤一个字的宽度。原先的「今日还可问 N 次」（14 字）会把名字压到省略，
   * 「今日」在这里也是冗余 —— 每日额度这件事由升级条（「每日提问提到 N 次」）负责说清。
   */
  const usageLabel = `${member ? '会员' : '免费版'} · 剩 ${usage.remaining} 次`
  /**
   * 等待文案（2026-10-15）：按 utils/qa.ts 回推的**执行阶段**给，而不是猜。
   *
   * 一次提问在端上要串四段（闸门 → 机审 → 检索 → 模型），此前只有一句笼统的
   * 「正在翻阅报告并联网检索…」：十几秒里用户既不知道到哪一步，还会被那句话误导 ——
   * 判定为不检索的那一问，它照样说「联网检索」。阶段与真实动作同源（onStage），
   * 模型那一跳通常最久，所以单独说「正在整理答案」，让人至少知道在等什么。
   */
  const stageText =
    stage === 'search'
      ? '正在联网检索最新报道…'
      : stage === 'answer'
        ? '正在整理答案…'
        : direct
          ? '正在准备资料…'
          : multi
            ? '正在翻阅两份报告…'
            : '正在翻阅这份报告…'

  /**
   * 建议问题分批：候选按报告内容生成，这里只决定取哪一批。
   * 候选不足一批时照常渲染，只是不出现「换一批」（点了没反应的按钮比没有按钮更糟）。
   */
  const suggested = useMemo(() => {
    if (suggestions.length === 0) return []
    const start = (suggestPage * SUGGEST_PAGE_SIZE) % suggestions.length
    const size = Math.min(SUGGEST_PAGE_SIZE, suggestions.length)
    return Array.from({ length: size }, (_, i) => suggestions[(start + i) % suggestions.length])
  }, [suggestions, suggestPage])

  /**
   * 报告「新鲜度」。问答的语料就是这份报告的快照 —— 一份两个月前的报告里不会有上个月的报道，
   * 用户却会拿它当「现在」来问。太旧就提前说清楚，并给一条回报告页刷新的路
   * （重新检索的入口只在报告页，这里不重复实现）。
   *
   * 对比模式下取**两人中更旧的那份**：两份里只要有一份过时，回答就有一半建立在旧素材上，
   * 提示必须出；提示里的「多久以前」指那份旧的，用户才知道该去刷谁。
   */
  const staleSource = useMemo(() => {
    const stale = reports.filter((r) => isStaleReport(r.generatedAt))
    if (stale.length === 0) return null
    return stale.reduce((old, r) => (Date.parse(r.generatedAt) < Date.parse(old.generatedAt) ? r : old))
  }, [reports])

  /**
   * 报告页入口：**单份时才有意义**（对比是两个人的报告，跳哪一份都是错的答案）。
   * 多人模式不渲染这个入口，而不是随便挑一份 —— 跳过去用户会以为看的就是刚才回答依据的报告。
   */
  const gotoReport = useCallback(() => {
    /* 直连态没有报告可跳（头部也不渲染这个入口），这里返回即兜底 */
    if (!report) return
    void Taro.navigateTo({
      url: `/package/report/index?personKey=${encodeURIComponent(report.personKey)}`
    })
  }, [report])

  /**
   * 打开一条引用来源：每个结论都能追溯到具体素材，是这个问答最该有的底气。
   * 带原文链接的（报道 / 联网检索）走 pages/link-preview —— 与报告页同一落点，先摊开标题 / 媒体 / 摘要，
   * 再给「复制链接」这条一定走得通的路；没有链接的（语录 / 时间线 / 报告判定）就地弹摘要，
   * 不硬造一个跳不出去的按钮。
   */
  const openSource = useCallback((p: QaPassage) => {
    if (p.url) {
      const query = [
        ['url', p.url],
        ['title', p.text.slice(0, 40)],
        ['source', p.source],
        ['date', p.date]
      ]
        .filter(([, v]) => !!v)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&')
      void Taro.navigateTo({ url: `/package/link-preview/index?${query}` })
      return
    }
    /* who 排最前（对比问答的两份语料共用同一套编号，不说清是谁的来源就没法核对） */
    const head = [p.who, passageTag(p), p.date, p.source].filter(Boolean).join(' · ')
    void Taro.showModal({
      title: `来源 [${p.no}]`,
      content: `${head}\n\n${p.text.slice(0, 160)}${p.text.length > 160 ? '…' : ''}`,
      showCancel: false,
      confirmText: '知道了'
    })
  }, [])

  return (
    <View className={`qa-panel${safeBottom ? '' : ' qa-panel--no-safe-bottom'}`}>
      {/* 头部整块可省（hideHead）：底部菜单「AI 提问」页的选人条已给全「选中的人 / 剩余次数」，
          那里再渲染这条「名字 · 剩 N 次」纯属重复（见 Props.hideHead） */}
      {!hideHead && (
        <View className='card qa-panel__head'>
          {/* 报告名是回报告页的入口：问出兴趣之后，下一步一定是「看完整份报告」 */}
          {report && withReport ? (
            <View className='qa-panel__head-main'>
              <View className='qa-panel__name-row qa-panel__name-row--wrap'>
                <Text className='qa-panel__name'>{`${report.name} × ${withReport.name}`}</Text>
                <Text className='qa-panel__jump'>对比</Text>
              </View>
              <Text className='qa-panel__meta'>{`合计素材 ${totalItems} 条`}</Text>
            </View>
          ) : direct ? (
            /*
             * 直连态（2026-10-12）：没有报告可跳，因此不显示「报告生成时间 / 素材 N 条」（那会误导成
             * 「有报告」），只把「这是直连大模型、未基于报告素材」说到明处，
             * 否则用户会把模型的自身知识当成报告里的事实。
             */
            <View className='qa-panel__head-main'>
              <View className='qa-panel__name-row'>
                <Text className='qa-panel__name'>{name}</Text>
              </View>
              <Text className='qa-panel__meta'>直连大模型作答 · 未基于报告素材</Text>
            </View>
          ) : report ? (
            <View className='qa-panel__head-main' hoverClass='qa-panel__head-main--tap' onClick={gotoReport}>
              <View className='qa-panel__name-row'>
                <Text className='qa-panel__name'>{report.name}</Text>
                <Text className='qa-panel__jump'>报告 ›</Text>
              </View>
              <Text className='qa-panel__meta'>
                {report.generatedAt ? `${fromNow(report.generatedAt)}生成的报告` : '已缓存报告'}
                {` · 素材 ${report.coverage?.items ?? report.dynamics.length} 条`}
              </Text>
            </View>
          ) : null}
          <Text className='qa-panel__left'>{usageLabel}</Text>
        </View>
      )}

      {/*
        会话上方的口径声明（「每次重新读素材与联网、不记上文；没写到的会直说，[1][2] 可核对」）
        已于 2026-10-09 整行移除：会话区上方每多一行，能读到的回答就少一行，而这三条口径
        并不改变用户的任何操作（问过就懂了）。配套的 `&__scope` 样式与对比页的覆盖同步删除。
        注意「不记上文」是**实现事实**（每次提问都重新拼 prompt，见 utils/qa.ts），
        与界面有没有声明这句话无关 —— 去掉的只是文案，不是这条口径。
      */}

      {staleSource && report && (
        <View
          className='qa-panel__stale'
          hoverClass='qa-panel__stale--tap'
          onClick={multi ? undefined : gotoReport}
        >
          <Text className='qa-panel__stale-text'>
            {multi
              ? `其中${staleSource.name}的报告生成于${fromNow(staleSource.generatedAt)}，那一半素材偏旧；可先回 TA 的报告页刷新`
              : `报告生成于${fromNow(report.generatedAt)}，问答只覆盖那时的报道；回报告页刷新可更新素材`}
          </Text>
          {/* 对比模式不下去报告页（跳哪一份都是错的答案），连箭头一起省掉，避免点了没反应 */}
          {!multi && <Text className='qa-panel__stale-arrow'>›</Text>}
        </View>
      )}

      <ScrollView className='qa-panel__stream' scrollY scrollWithAnimation scrollIntoView={anchor}>
        {bubbles.length === 0 && suggested.length > 0 && (
          <View className='qa-panel__chips'>
            {suggested.map((s) => (
              <View
                key={s}
                className='qa-panel__chip'
                hoverClass='qa-panel__chip--tap'
                onClick={() => void send(s)}
              >
                <Text>{s}</Text>
              </View>
            ))}
            {/* 候选多于一批才给「换一批」：只在一条候选上挂个点了没反应的按钮是最差的 */}
            {suggestions.length > suggested.length && (
              <View
                className='qa-panel__chip qa-panel__chip--more'
                hoverClass='qa-panel__chip--tap'
                onClick={() => setSuggestPage((p) => p + 1)}
              >
                <Text>换一批</Text>
              </View>
            )}
          </View>
        )}

        {bubbles.map((b) => (
          <View key={b.id} id={`qa-msg-${b.id}`} className={`qa-panel__row qa-panel__row--${b.role}`}>
            <View className={`qa-panel__msg${b.error ? ' qa-panel__msg--error' : ''}`}>
              {b.role === 'ai' && !b.error && (direct || (b.sources && b.sources.length > 0)) ? (
                <AnswerBody bubble={b} onCite={openSource} direct={direct} />
              ) : (
                <Text className='qa-panel__msg-text'>{b.text}</Text>
              )}
            </View>
          </View>
        ))}

        {asking && (
          <View className='qa-panel__row'>
            <View className='qa-panel__msg qa-panel__msg--thinking'>
              <Text className='qa-panel__msg-text'>{stageText}</Text>
            </View>
          </View>
        )}

        <View className='qa-panel__end' id='qa-end' />
      </ScrollView>

      {notice !== '' && !noticeClosed && (
        <View className='qa-panel__notice'>
          <Text className='qa-panel__notice-text'>{notice}</Text>
          <NoticeClose onClose={() => setNoticeClosed(true)} />
        </View>
      )}

      {showUpsell && (
        <View
          className='qa-panel__upsell'
          hoverClass='qa-panel__upsell--tap'
          onClick={() => Taro.navigateTo({ url: '/package/member/index' })}
        >
          <Text className='qa-panel__upsell-text'>
            {`开通会员 · 每日提问提到 ${MEMBER_DAILY_ASK_LIMIT} 次`}
          </Text>
          <Text className='qa-panel__upsell-arrow'>›</Text>
        </View>
      )}

      {input.length >= COUNT_HINT_FROM && (
        <Text className='qa-panel__count'>{`${input.length}/${QA_MAX_QUESTION} 字`}</Text>
      )}

      <View className='qa-panel__composer'>
        {report ? (
          /* 报告图标（2026-10-12）：选中的人有报告时，从输入框左侧一键跳回报告页 ——
             问完想回去看原文 / 刷新素材，不必退回上一页重新找人。
             红色 PDF = 有报告；图标自身的颜色就是「有没有报告」的信号（见 index.scss） */
          <View className='qa-panel__report' hoverClass='qa-panel__report--tap' onClick={gotoReport}>
            <View className='qa-panel__report-icon' />
          </View>
        ) : (
          /* 直连态没有报告可跳：同一枚图标置灰，点一下把「未基于报告素材」说清楚 */
          <View
            className='qa-panel__report qa-panel__report--off'
            hoverClass='qa-panel__report--tap'
            onClick={() => void Taro.showToast({ title: '本次未基于报告素材', icon: 'none' })}
          >
            <View className='qa-panel__report-icon qa-panel__report-icon--off' />
          </View>
        )}
        <Input
          className='qa-panel__input'
          value={input}
          maxlength={QA_MAX_QUESTION}
          placeholder={
            direct
              ? `就 ${name} 提问（未基于报告素材）`
              : multi
                ? `就这两位各自的报道提问`
                : `就 ${report?.name ?? name} 的报道与言论提问`
          }
          confirmType='send'
          disabled={!corpusOk || asking}
          onInput={(e) => setInput(e.detail.value)}
          onConfirm={() => void send()}
        />
        <AtButton
          className='qa-panel__send'
          type='primary'
          size='small'
          circle
          loading={asking}
          /*
            loading 与 disabled 不能同真（2026-10-16，用户反馈「看不到加载效果」）：
            asking 时 input 已被 send() 清空，canSend 必然为假，于是按钮同时挂上
            `at-button--disabled` —— taro-ui 的 `&--disabled { opacity: 0.3 }` 会把整个按钮
            （含那枚转圈）一起压淡，转圈只在 30% 不透明度下若隐若现，看着就像没反应。
            这里只保留真正该禁用的两种情形：直连态没有可问对象、或还没输入内容。
            防连点仍由 send() 开头的 busy 守卫负责（asking 期间再点，question 为空会直接 return）。
          */
          disabled={!canSend && !asking}
          onClick={() => void send()}
        >
          发送
        </AtButton>
      </View>
    </View>
  )
}

/**
 * 回答正文 + 来源行。
 *
 * 正文里的 [n] 是 QA_SYSTEM 第 7 条要求模型标出来的，这里只负责把它变成可点标签：
 * 点一下看到「这句话出自哪条采访 / 报道」，长按气泡整段复制（用户常要粘到别处）。
 * 模型没标编号时不硬凑 —— 改成「依据 N 条素材作答」；编一个假编号比不给来源更糟。
 * 直连态（`direct`，无报告素材）的来源行必须说清「未基于报告素材」—— 否则会出现
 * 「直连大模型作答」的头部与「依据 N 条报告素材作答」的来源行自相矛盾。
 */
function AnswerBody({
  bubble,
  onCite,
  direct
}: {
  bubble: Bubble
  onCite: (p: QaPassage) => void
  direct: boolean
}) {
  const sources = bubble.sources ?? []
  const segments = useMemo(
    () => splitCitations(bubble.text, sources.length),
    [bubble.text, sources.length]
  )

  /** 正文里真正被引用到的资料（按编号顺序），用于下方来源行 */
  const cited = useMemo(() => {
    const nos = new Set<number>()
    for (const seg of segments) if (seg.kind === 'cite') seg.nos.forEach((n) => nos.add(n))
    return sources.filter((p) => nos.has(p.no))
  }, [segments, sources])

  return (
    <>
      <Text
        className='qa-panel__msg-text'
        onLongPress={() => void Taro.setClipboardData({ data: bubble.text })}
      >
        {segments.map((seg, i) =>
          seg.kind === 'text' ? (
            <Text key={i}>{seg.text}</Text>
          ) : (
            <Text
              key={i}
              className='qa-panel__cite'
              onClick={() => {
                /* 一组编号共用一个标签（[1][2]），点开第一条 —— 想看的通常是最近的来源 */
                const first = sources.find((p) => p.no === seg.nos[0])
                if (first) onCite(first)
              }}
            >
              {seg.nos.map((n) => `[${n}]`).join('')}
            </Text>
          )
        )}
      </Text>

      <View className='qa-panel__srcs'>
        {cited.length > 0 ? (
          cited.map((p) => (
            <View
              key={p.no}
              className='qa-panel__src'
              hoverClass='qa-panel__src--tap'
              onClick={() => onCite(p)}
            >
              {/* 联网条目在来源行里额外标一个「联网」：它比报告新，用户凭这一眼就知道该不该优先看 */}
              <Text>
                {`[${p.no}] ${p.who ? `${p.who} · ` : ''}${
                  p.kind === 'web'
                    ? `联网 · ${p.source || passageTag(p)}`
                    : p.source || (p.ai ? '报告判定' : '公开报道')
                }`}
              </Text>
            </View>
          ))
        ) : (
          <Text className='qa-panel__src-none'>
            {direct
              ? sources.length > 0
                ? `未基于报告素材 · 依据 ${sources.length} 条联网检索作答`
                : '未基于报告素材 · 由大模型直接作答'
              : `依据 ${sources.length} 条报告素材作答`}
          </Text>
        )}
      </View>
    </>
  )
}
