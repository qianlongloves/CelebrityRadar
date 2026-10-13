import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { publicConfig } from '@/config/public'
import { ensureLogin } from '@/utils/auth'
import {
  DAILY_REFRESH_LIMIT,
  FREE_DAILY_ASK_LIMIT,
  FREE_DAILY_GENERATE_LIMIT,
  FREE_FEATURES_NOTE,
  FREE_REFRESH_COOLDOWN_HOURS,
  MEMBER_DAILY_REFRESH_LIMIT,
  MEMBER_DAILY_ASK_LIMIT,
  MEMBER_DAILY_GENERATE_LIMIT,
  readMemberState
} from '@/utils/member'
import type { MemberState } from '@/utils/member'
import { dayKey8 } from '@/utils/time'
/* 额度一览里「容量上限」一组的数字，各自取实现处的常量：这些上限分散在多个模块里，
   页面不复制数值，只引用 —— 改上游一处，这一页跟着变 */
import { HISTORY_LIMIT } from '@/utils/history'
/* 报告模板的节数与名单也只有一个来源（utils/report-toc.ts），对比表同样只引用不复制 */
import { FREE_TOC_COUNT, TEMPLATE_SIZE } from '@/utils/report-toc'
/* 舆情功能的免费 / 会员分层上限（关注人数 / 关键词监测 / 舆情明细）真源：config/benefits.ts */
import { OPINION_LIMITS } from '@/config/benefits'
import { QA_MAX_QUESTION } from '@/utils/qa'
import {
  FALLBACK_MEMBERSHIP_PLANS,
  buyMembership,
  fetchMembershipPlans,
  planEmojiOf,
  planLabelOf,
  planNote
} from '@/utils/pay'
import type { BuyResult, MembershipPlan } from '@/utils/pay'
import Skeleton from '@/components/skeleton'
import './index.scss'

/**
 * 会员中心（付费转化页，入口在「我的」页的会员卡）。
 *
 * 为什么从「我的」页里拆出独立页：档位、价格、权益、购买按钮原先全挤在「我的」页的
 * 一张卡片里，三档一铺就把页面撑长，且**说不出「买了到底多得到什么」** ——
 * 权益只能写两行小字，用户在信息不足的情况下被要求付钱。拆出来后：
 *   ① 先讲清「免费版 vs 会员」的差异（对比表，一眼可读）；
 *   ② 再把会被拦下来的额度与次数逐条列清（额度一览，数字与线上闸门同源）；
 *   ③ 然后让用户选时长档位（这里就是各档「等级」的价格与时长）；
 *   ④ 最后才出现唯一的支付按钮（吸底，不随滚动丢失）。
 *
 * 三条与全项目一致的口径（改动前先读）：
 *   1. **价格与天数只认服务端**：档位来自云函数 `payCreate` 的下发（`fetchMembershipPlans`，
 *      24h 本机缓存 + 离线兜底），端上不持有第二份定价 —— 见 utils/pay.ts 文件头原则 1。
 *   2. **权益数值只有一个来源**：对比表里的次数一律引用 utils/member.ts 的常量，
 *      页面里不写死数字，改额度只改权益表。
 *   3. **支付成功 ≠ 会员生效**：发货由微信回调云函数异步完成，故未在等待窗口内生效时
 *      提示「开通中」而不是报错（判定口径见 utils/pay.ts 原则 3）。
 */

/**
 * 质量档名从 config/public.ts 的 `qualities[].memberOnly` 推导，不在页面里写死：
 * 运营增删档位只改那份清单，这一页与「我的」页的文案自动跟上。
 *
 * 质量档是跨厂商同一套（基础版 / 标准版 / 高级版），所以「免费版能用到什么、会员能用到什么」
 * 与用户切到哪一家厂商无关，这一页不必按厂商分叉；具体模型由云端厂商注册表决定。
 */
const FREE_MODEL_LABELS =
  publicConfig.llm.qualities
    .filter((q) => !q.memberOnly)
    .map((q) => q.label)
    .join(' / ') || '默认档'
const MEMBER_MODEL_LABELS =
  publicConfig.llm.qualities
    .filter((q) => q.memberOnly)
    .map((q) => q.label)
    .join(' / ') || '—'

/**
 * 权益对比矩阵（免费版 / 会员两列）。
 *
 * 行文案里的数值全部引用常量插值：这样「改了额度表但忘了改文案」这类事故不会发生
 * （此前额度文案散在页面里，两个月内已经对不上过一次）。
 */
const BENEFIT_MATRIX: Array<{ name: string; free: string; member: string }> = [
  {
    /*
     * 2026-10-07 新增（优化建议 O-10）：这一页必须说清「多花的钱买到了什么**质**」——
     * 此前几行全是次数，用户看完只知道「多的还是次数」。放在首行，因为它是转化决策里
     * 最直观的一条；真实闸门在云函数 aiProxy（端上锁 UI，服务端拦请求）。
     */
    name: '生成模型',
    free: FREE_MODEL_LABELS,
    member: MEMBER_MODEL_LABELS
  },
  {
    /*
     * 2026-10-07 新增（优化建议 O-11）：上一行说的是「用哪个模型」，这一行说的是
     * **报告有多厚** —— 检索加厚 + 两段专属内容。两项都随同一次生成发生、不额外消耗额度，
     * 故文案里不写次数，也不写具体条数（条数随检索策略调整，写死会与实现漂移）。
     */
    name: '报告深度模式',
    free: '标准素材',
    /*
     * 2026-10-08 改口径：原来写「加厚素材 + 对比 / 风险两段」，而专享内容其实早有第三段
     * （信源分歧，与对比 / 风险同在报告页那张卡里）。表格这一列窄，写不下三个名字，
     * 故收成「专享内容」—— 三段具体内容由报告页那张「会员专享 · 深度解析」卡承载，
     * 名字与数量写在表格里只会随实现漂移。
     */
    member: '加厚素材 + 专享内容'
  },
  {
    /*
     * 2026-10-10 新增（用户需求「把报告模板纳入会员文字权益」）：上一行讲的是报告有多**厚**，
     * 这一行讲报告按**模板**分档 —— 免费版只呈现免费档那几节，会员是完整模板。
     * 两个数字都取自 utils/report-toc.ts（模板的唯一定义处），改了档位这一格跟着变；
     * 具体多出哪几节写在下方的权益说明里（表格这一列窄，塞不下名单）。
     */
    name: '报告模板',
    free: `核心 ${FREE_TOC_COUNT} 节`,
    member: `完整 ${TEMPLATE_SIZE} 节`
  },
  {
    name: '每日主动生成报告',
    free: `${FREE_DAILY_GENERATE_LIMIT} 次`,
    member: `${MEMBER_DAILY_GENERATE_LIMIT} 次`
  },
  {
    name: '浏览已生成报告',
    free: '不限次',
    member: '不限次'
  },
  {
    /*
     * 2026-10-07 起提问额度按等级分档（此前两版同额度）。
     * 与生成仍是**不同池**：提问不吃生成额度，所以免费版的两行数字不是同一回事，
     * 表格里必须分行写清楚，避免用户以为「问了 5 次就少生成 5 次」。
     */
    name: 'AI 提问（基于报告）',
    free: `每日 ${FREE_DAILY_ASK_LIMIT} 次`,
    member: `每日 ${MEMBER_DAILY_ASK_LIMIT} 次`
  },
  {
    /*
     * 2026-10-13（P2）起「关注名人」也是分档权益：免费最多关注 3 人、会员 30 人。
     * 数值取自 config/benefits.ts#OPINION_LIMITS（真源），不在这里写死；收藏与浏览历史仍不分档，
     * 故拆成两行，避免把「关注有人数上限」含糊进一句「不限次」里。
     */
    name: '关注名人',
    free: `最多 ${OPINION_LIMITS.followCount.free} 人`,
    member: `最多 ${OPINION_LIMITS.followCount.member} 人`
  },
  {
    name: '收藏 / 浏览历史',
    free: '不限次',
    member: '不限次'
  },
  {
    /* 关键词监测数同样于 2026-10-13 分档（免费 1 / 会员 10）；数值取自 OPINION_LIMITS */
    name: '关键词监测',
    free: `最多 ${OPINION_LIMITS.watchCount.free} 个词`,
    member: `最多 ${OPINION_LIMITS.watchCount.member} 个词`
  },
  {
    /* 「监控某人」（风险监控）人数同为 2026-10-13 分档（免费 1 / 会员 10）；
       与「关键词监测」是两个维度（一个盯人、一个盯词，各自计数），数值取自 OPINION_LIMITS */
    name: '风险监控',
    free: `最多 ${OPINION_LIMITS.personWatchCount.free} 位名人`,
    member: `最多 ${OPINION_LIMITS.personWatchCount.member} 位名人`
  },
  {
    /* 舆情页每块明细：免费截断到 N 条，会员显示全部（今日要点卡不受限，是留存钩子） */
    name: '舆情明细',
    free: `每块最多 ${OPINION_LIMITS.detailRows.free} 条`,
    member: '全部可见'
  },
  {
    /*
     * 2026-10-08 起热门榜不再分档（原优化建议 O-19 的「免费前 6 位 / 会员整榜」已撤销，
     * 见 utils/member.ts）：这一行于是与上面两行同性质 —— 两栏一样，留着是为了**明写**它免费，
     * 而不是权益差异。写「全部可见」而不是「不限次」：榜单原来分的是**位数**不是次数，
     * 用「不限次」会答非所问（用户问的是「能看到第几位」）。趋势 / 对比本就未分档。
     */
    name: '热门榜 · 趋势 · 对比',
    free: '全部可见',
    member: '全部可见'
  },
  {
    /* 续费不清零是会员卡最容易被忽略、但用户最在意的一条（买了 12 个月又续 1 个月，
       剩余天数会不会被重置），所以在对比表里单独占一行 */
    name: '时长叠加',
    free: '—',
    member: '按天顺延'
  }
]

/**
 * 额度与次数一览（2026-10-10 新增）。
 *
 * 为什么要在对比表之外**再列一遍**：对比表是「卖点表」，只挑得出差异的几行（模型档位、
 * 报告厚度、生成 / 提问次数），而用户真正会撞上的限制散在几个模块里 —— 抓取动态 10 次/日、
 * 周报占用生成额度、免费版 12 小时刷新冷却、提问 120 字上限。
 * 这些此前只在撞上的一瞬间以 toast 出现（「今日刷新已达上限」「会员最多监测 10 个词」），
 * 用户不会为了知道规则而先把每一条都撞一遍。
 * （关注人数 / 关键词监测 / 风险监控人数 已在 2026-10-13 起分档，是**差异权益**，故归上方对比表，不列在此。）
 *
 * 三条硬口径（改动前先读）：
 *   1. **数字全部引用常量**，页面里不写死 —— 与对比表同一条规则（见文件头原则 2）；
 *      其中抓取次数与冷却时长唯一的来源是 utils/member.ts#MEMBER_BENEFITS，
 *      utils/cache.ts 也从那里取，两处不可能对不上。
 *   2. **不美化**：免费与会员同额的行照实写成同额（抓取动态），不玩「会员专属」的措辞 ——
 *      这一页的说服力来自「说的和拦的一致」，把同额写成差异只会让会员开通后觉得被骗。
 *   3. **容量类不能混进「每日次数」**：这类上限是**存量上限**（删一个才能加一个），
 *      与每日重置的次数不是一回事，故另起一组；仍留在此组的都是**两版相同**的容量 / 输入限制。
 */
const QUOTA_ROWS: Array<{ name: string; free: string; member: string; note: string }> = [
  {
    name: '主动生成深度报告',
    free: `${FREE_DAILY_GENERATE_LIMIT} 次 / 日`,
    member: `${MEMBER_DAILY_GENERATE_LIMIT} 次 / 日`,
    note: '只有真拿到新报告才计数：缓存命中、生成失败、上游拒答都不算'
  },
  {
    /*
     * 周报与报告共用同一池（utils/weekly.ts#generateWeekly 里 consumeGenerateQuota）：
     * 单列这一行是因为用户完全可能以为「周报是另一份额度」，一周下来比预期少生成几次报告。
     */
    name: '生成本周周报',
    free: '占用生成额度',
    member: '占用生成额度',
    note: '不额外计费：生成一份周报 = 当日生成次数里的 1 次'
  },
  {
    name: 'AI 提问（基于报告）',
    free: `${FREE_DAILY_ASK_LIMIT} 次 / 日`,
    member: `${MEMBER_DAILY_ASK_LIMIT} 次 / 日`,
    note: '与生成分开计数：问满额度不会少生成报告，反之亦然'
  },
  {
    name: '抓取关注动态',
    free: `${DAILY_REFRESH_LIMIT} 次 / 日`,
    member: `${MEMBER_DAILY_REFRESH_LIMIT} 次 / 日`,
    note: '会员 2 倍：单次刷新按「最久没更新」优先，覆盖你关注的一部分人'
  },
  {
    name: '重复刷新同一份报告',
    free: `${FREE_REFRESH_COOLDOWN_HOURS} 小时内会先提醒`,
    member: '不受限',
    note: `两版都能随时重新生成（每点一次消耗 1 次生成次数，失败或内容不完整时不计数）；免费版在报告生成后的 ${FREE_REFRESH_COOLDOWN_HOURS} 小时内再刷，会先提醒一句「内容不会有实质变化」`
  }
]

/** 容量与输入上限（两版相同，不分档；数值取各自实现处的常量） */
const QUOTA_CAPS: string[] = [
  `单条提问：≤ ${QA_MAX_QUESTION} 字`,
  `浏览历史：本机保留最近 ${HISTORY_LIMIT} 条，超出后丢弃最旧的`
]

/**
 * 收尾口径。两件事必须说清，否则用户会按「所有联网动作都扣额度」的直觉猜：
 *   ① 重置时刻（UTC+8 0 点，与云端同日，见 utils/time#todayKey）；
 *   ② 有联网动作但**不占额度**的部分（输入名字时的消歧、探索页随机一位）——
 *      这类请求走的是 aux 通道，只受限速与防滥用闸门，不动上面任何一条。
 *
 * 防滥用闸门（aiProxy 的 ABUSE_LIMITS）**刻意不给数字**：它的设计前提是「宽松到正常用户
 * 永远碰不到」（两次生成 + 提问 + 消歧加起来约 10~15 次/日，上限是这个的几倍），
 * 写出来只会变成一个「原来能刷这么多」的暗示。但也不能不提 —— 完全不提，撞上它的用户
 * 会觉得这一页在骗人（「我明明没到任何额度」），所以留一句只说存在、不说门槛的话。
 */
const QUOTA_FOOT_NOTE =
  '额度按 UTC+8 每日 0 点重置；输入名字时的自动消歧、探索页「随机一位」不占用上述任何额度（只受一层很宽的防滥用闸门保护）'

/**
 * 会员到期日展示：ISO → yyyy-mm-dd。
 * P2-36：按 **UTC+8** 取日期（`dayKey8`），与「我的」页、与云端到期口径一致。
 */
function formatDay(iso: string): string {
  return dayKey8(iso) || iso
}

/**
 * 默认选中的档位：优先带角标的那档（角标由服务端下发，就是运营想主推的锚点），
 * 没有角标则选第一档。默认选中能省掉「选不了/没选」的无效点击。
 */
function pickDefault(plans: MembershipPlan[]): string {
  return (plans.find((p) => p.badge !== '') ?? plans[0])?.id ?? ''
}

/**
 * 会员等级标识（2026-10-12 用户要求）：顶部卡片按当前生效的档位显示等级名 + 一枚 emoji。
 *
 * 映射（plan id → emoji / 名称，未知档位回落「会员」）已抽到 utils/pay.ts 的
 * `planEmojiOf` / `planLabelOf` —— 「我的订单」列表要用同一份口径，两处各放一份必然漂移。
 */

export default function MemberPage() {
  const { userId } = useAuth()
  /** 会员状态：null = 读取中（按免费版渲染，不在读取期间给「已开通」的错误暗示） */
  const [member, setMember] = useState<MemberState | null>(null)
  /** 档位清单：初值取离线兜底，进页后换成云函数下发的权威价格 */
  const [plans, setPlans] = useState<MembershipPlan[]>(FALLBACK_MEMBERSHIP_PLANS)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  /** 下单在途：防连点重复拉起收银台 */
  const [buying, setBuying] = useState(false)
  /** 登录在途：未登录时点开通会先补登录 */
  const [logging, setLogging] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      /* 两件互不依赖的事并行取：任一失败都不该让整页空着（各自有保守兜底） */
      const [m, p] = await Promise.all([
        readMemberState().catch(() => null),
        fetchMembershipPlans().catch(() => FALLBACK_MEMBERSHIP_PLANS)
      ])
      if (!alive) return
      setMember(m)
      setPlans(p)
      setSelectedId((prev) => prev || pickDefault(p))
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  const selected = plans.find((p) => p.id === selectedId) ?? plans[0] ?? null
  const isMember = !!member?.member

  /**
   * 开通 / 续费：登录（如需）→ 下单 → 收银台 → 确认生效。
   *
   * 未登录先去登录：订单与会员都落在 users 行上，未登录下单必然失败，
   * 与其让用户在收银台前吃一次报错，不如在这里顺手补上（ensureLogin 内部已 catch）。
   */
  const doBuy = async () => {
    if (buying || logging || loading || !selected) return

    if (!userId) {
      setLogging(true)
      await ensureLogin()
      setLogging(false)
      if (!useAuth.getState().userId) {
        Taro.showToast({ title: '登录后才能开通会员，请重试', icon: 'none' })
        return
      }
    }

    setBuying(true)
    Taro.showLoading({ title: '正在拉起支付…', mask: true })

    let res: BuyResult
    try {
      res = await buyMembership(selected.id)
    } catch (err) {
      /* buyMembership 内部已兜底，此处仅防御未来改动引入的异常 */
      res = {
        ok: false,
        paid: false,
        activated: false,
        outTradeNo: null,
        cancelled: false,
        error: err instanceof Error ? err.message : String(err)
      }
    } finally {
      Taro.hideLoading()
      setBuying(false)
    }

    /* 用户取消支付不算失败：静默返回，别弹一个「支付未完成」吓人 */
    if (res.cancelled) return
    if (!res.ok) {
      /*
       * 标题按 blocked 分开（P2-20，2026-10-09）：平台限制（iOS 虚拟支付）与「通道还没配好」
       * 都不是「你的支付出了差错」。用「支付未完成」当标题等于把责任推给用户，还暗示重试就能成。
       */
      const title =
        res.blocked === 'ios'
          ? 'iOS 暂不支持购买'
          : res.blocked === 'unconfigured'
            ? '购买暂未开放'
            : '支付未完成'
      await Taro.showModal({ title, content: res.error ?? '请稍后重试', showCancel: false })
      return
    }

    /* 钱已付：无论回调是否已落地都刷新一次状态，页面上的剩余天数立刻跟手 */
    const next = await readMemberState().catch(() => null)
    if (next) setMember(next)

    if (res.activated) {
      Taro.showToast({ title: isMember ? '会员已续费' : '会员已开通', icon: 'success' })
    } else {
      await Taro.showModal({
        title: '支付成功',
        content: '会员开通中，通常几秒内生效；重新进入本页即可看到更新后的有效期。',
        showCancel: false
      })
    }
  }

  /** 当前等级的 emoji / 名称（顶部卡片标题用；非会员 / 未知档位回落 ⭐ 会员） */
  const levelEmoji = planEmojiOf(member?.plan ?? null)
  const levelLabel = planLabelOf(member?.plan ?? null)

  return (
    <View className='page-member'>
      {/*
        顶部卡片（2026-10-12 最终口径，用户两轮确认后定的）：
        **只留两行 —— 「等级名（含 emoji）」+「有效期至 X」**。
        撤掉的是「后面的文字」：右侧状态标（会员 · 剩 N 天 / 免费版）、以及原先跟在有效期后面那句
        「到期前续费按天顺延」（该口径已并入下方 notes）。
        非会员没有有效期：标题回落产品名，第二行给免费版额度，否则这张卡会是全空的。
      */}
      <View className='page-member__hero'>
        <View className='page-member__hero-head'>
          <Text className='page-member__hero-title'>
            {!loading && isMember ? `${levelEmoji} ${levelLabel}` : '名人雷达会员'}
          </Text>
          {/*
            有效期放在标题**右侧**（2026-10-12 修「右侧看着空」）：它原先独占第二行，
            而标题那行右边没有任何东西 —— 一张卡两行、右边全空，观感就是「空」。
            挪到同一行后左名称右有效期，一行把宽度用满，也不再需要第二行。
          */}
          {!loading && isMember && !!member?.expiresAt && (
            <Text className='page-member__hero-sub page-member__hero-sub--right'>
              {`有效期至 ${formatDay(member.expiresAt)}`}
            </Text>
          )}
        </View>
        {/* 非会员 / 还没读到时没有有效期可放右侧，仍用第二行说明状态（否则这张卡是空的） */}
        {(loading || !isMember || !member?.expiresAt) && (
          <Text className='page-member__hero-sub'>
            {loading
              ? '正在读取你的会员状态…'
              : `免费版每日可主动生成 ${FREE_DAILY_GENERATE_LIMIT} 次，会员每日 ${MEMBER_DAILY_GENERATE_LIMIT} 次`}
          </Text>
        )}
      </View>

      {loading ? (
        <View className='card'>
          <Skeleton rows={4} variant='card' />
        </View>
      ) : (
        <>
          {/*
            订单入口（2026-10-12 新增；同日移到**页面第二张卡**的位置）。
            **只对会员可见**：没下过单的人进去只有空态，而「支付成功后开通中」这类疑问本来就只发生在
            已经付过钱的会员身上 —— 与其让所有人看着一个点进去没东西的入口，不如让它只出现在
            真正有订单的人那里。非会员走下面的「选择档位」下单，不需要这条路径。
          */}
          {isMember && (
            <View
              className='card page-member__orders'
              hoverClass='page-member__orders--tap'
              onClick={() => Taro.navigateTo({ url: '/pages/orders/index' })}
            >
              <View className='page-member__orders-main'>
                <Text className='page-member__orders-title'>查看我的订单</Text>
                <Text className='page-member__orders-note'>支付记录与开通状态（发货中通常几秒内生效）</Text>
              </View>
              <Text className='page-member__orders-arrow'>›</Text>
            </View>
          )}

          <View className='card page-member__compare'>
            <Text className='page-member__section'>免费版 vs 会员</Text>
            <View className='page-member__row page-member__row--head'>
              <Text className='page-member__cell page-member__cell--name'>权益</Text>
              <Text className='page-member__cell'>免费版</Text>
              <Text className='page-member__cell page-member__cell--on'>会员</Text>
            </View>
            {BENEFIT_MATRIX.map((r) => (
              <View key={r.name} className='page-member__row'>
                <Text className='page-member__cell page-member__cell--name'>{r.name}</Text>
                <Text className='page-member__cell'>{r.free}</Text>
                <Text className='page-member__cell page-member__cell--on'>{r.member}</Text>
              </View>
            ))}
            <Text className='page-member__foot'>{FREE_FEATURES_NOTE}</Text>
          </View>

          {/*
            额度与次数一览（2026-10-10 新增）。
            位置：对比表之后、选档位之前 —— 顺序是「买到的质（对比表）→ 会被拦在哪（本卡）
            → 该付多少钱（档位）」。
          */}
          <View className='card page-member__quota'>
            <Text className='page-member__section'>额度与次数一览</Text>
            <Text className='page-member__section-note'>
              以下都是真会被拦下来的限制，数字与线上闸门同源
            </Text>

            {QUOTA_ROWS.map((r) => (
              <View key={r.name} className='page-member__quota-row'>
                <Text className='page-member__quota-name'>{r.name}</Text>
                <View className='page-member__quota-values'>
                  <View className='page-member__quota-pill'>
                    <Text className='page-member__quota-pill-label'>免费版</Text>
                    <Text className='page-member__quota-pill-value'>{r.free}</Text>
                  </View>
                  <View className='page-member__quota-pill page-member__quota-pill--on'>
                    <Text className='page-member__quota-pill-label'>会员</Text>
                    <Text className='page-member__quota-pill-value'>{r.member}</Text>
                  </View>
                </View>
                <Text className='page-member__quota-note'>{r.note}</Text>
              </View>
            ))}

            <Text className='page-member__quota-sub'>容量与输入限制（两版相同）</Text>
            {QUOTA_CAPS.map((c) => (
              <Text key={c} className='page-member__quota-cap'>
                · {c}
              </Text>
            ))}

            <Text className='page-member__quota-foot'>{QUOTA_FOOT_NOTE}</Text>
          </View>

          <View className='card page-member__plans'>
            <Text className='page-member__section'>{isMember ? '续费档位' : '选择档位'}</Text>
            <Text className='page-member__section-note'>
              {isMember
                ? '选任意档位续费，天数直接加在现有有效期之后'
                : '三种时长，权益完全相同，只是单价不同'}
            </Text>
            {plans.map((p) => {
              const on = p.id === selected?.id
              return (
                <View
                  key={p.id}
                  className={`page-member__plan${on ? ' page-member__plan--on' : ''}`}
                  hoverClass='page-member__plan--tap'
                  onClick={() => setSelectedId(p.id)}
                >
                  <View className='page-member__plan-main'>
                    <View className='page-member__plan-head'>
                      <Text className='page-member__plan-name'>{p.name}</Text>
                      {!!p.badge && <Text className='page-member__plan-badge'>{p.badge}</Text>}
                    </View>
                    {/* 副文案（折算月价 + 权益额度）与「我的」页同源，均来自 utils/pay.ts */}
                    <Text className='page-member__plan-note'>{`${planNote(p)} · ${p.days} 天`}</Text>
                  </View>
                  <View className='page-member__plan-right'>
                    <Text className='page-member__plan-price'>{p.priceLabel}</Text>
                    <Text className={`page-member__plan-check${on ? ' page-member__plan-check--on' : ''}`}>
                      {on ? '✓' : ''}
                    </Text>
                  </View>
                </View>
              )
            })}
          </View>

          <View className='page-member__notes'>
            {/*
              计费口径（2026-10-12 用户要求「扣减规则写进会员介绍」）。
              刻意**不重复额度一览里的数字**（那一块就在上面，重复写作是此前删掉一条的原因），
              只讲用户最容易踩到、而且对他有利的两条事实 —— 它们都是代码里的硬口径：
              `consume` 在报告落库之后才执行；缓存命中的报告在配额检查**之前**就返回了。
            */}
            <Text className='page-member__note'>
              · 只有「发起生成并成功出报告」才计数；查看已生成的报告、以及生成不达标或失败，都不计数
            </Text>
            <Text className='page-member__note'>· 支付由微信支付完成，成功后会员立即生效（个别情况延迟几秒）</Text>
            <Text className='page-member__note'>· 同一账号可反复续费，剩余时长按购买天数顺延累加</Text>
            {/*
              这一行原先写「每日额度 0 点重置；生成失败与缓存命中的报告都不计数」——
              与上面的额度一览逐字重复。改成指路不加数字：两处各写一份，改额度时必然漏一处。
            */}
            <Text className='page-member__note'>· 会员档额度开通后立即生效，规则见上方「额度与次数一览」</Text>
          </View>
        </>
      )}

      <View className='page-member__bar safe-bottom'>
        <View className='page-member__bar-main'>
          <Text className='page-member__bar-price'>{selected?.priceLabel ?? '—'}</Text>
          <Text className='page-member__bar-note'>
            {selected ? `${selected.name} · ${selected.days} 天` : '正在读取档位…'}
          </Text>
        </View>
        <Button
          className='page-member__bar-btn'
          hoverClass='page-member__bar-btn--tap'
          loading={buying || logging}
          disabled={loading || !selected || buying || logging}
          onClick={() => void doBuy()}
        >
          {isMember ? '立即续费' : '立即开通'}
        </Button>
      </View>
    </View>
  )
}
