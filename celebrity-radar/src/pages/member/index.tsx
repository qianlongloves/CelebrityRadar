import { useEffect, useState } from 'react'
import Taro from '@tarojs/taro'
import { Button, Text, View } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { publicConfig } from '@/config/public'
import { ensureLogin } from '@/utils/auth'
import {
  FREE_DAILY_ASK_LIMIT,
  FREE_DAILY_GENERATE_LIMIT,
  FREE_FEATURES_NOTE,
  MEMBER_DAILY_ASK_LIMIT,
  MEMBER_DAILY_GENERATE_LIMIT,
  readMemberState
} from '@/utils/member'
import type { MemberState } from '@/utils/member'
import { loadMemberSample } from '@/utils/member-sample'
import type { MemberSample } from '@/utils/member-sample'
import { fromNow } from '@/utils/time'
import {
  FALLBACK_MEMBERSHIP_PLANS,
  buyMembership,
  fetchMembershipPlans,
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
 *   ② 紧接着给一段**真实示例**（O-22）：对比表那一格只能写「专享内容」四个字，
 *      而用户真正想问的是「那到底长什么样」—— 示例取自平台真实报告，原文未改写；
 *   ③ 再让用户选时长档位（这里就是各档「等级」的价格与时长）；
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
 * 模型档位名从 config/public.ts 的 `memberOnly` 列推导，不在页面里写死：
 * 运营增删档位只改那份清单，这一页与「我的」页的文案自动跟上。
 *
 * 取的是 llm.models（默认供应商的档位）：三家供应商的档位标签是同一套
 * （极速版 / 标准版 / 深度推理，见 llm.providers），所以「免费版能用到什么、会员能用到什么」
 * 与用户切到哪一家无关，这一页不必按供应商分叉。
 */
const FREE_MODEL_LABELS =
  publicConfig.llm.models
    .filter((m) => !m.memberOnly)
    .map((m) => m.label)
    .join(' / ') || '默认档'
const MEMBER_MODEL_LABELS =
  publicConfig.llm.models
    .filter((m) => m.memberOnly)
    .map((m) => m.label)
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
     * 故收成「专享内容」，具体是什么由下方示例卡用真实原文回答（O-22）——
     * 名字与数量写在表格里会随实现漂移，写在示例里不会（示例就是当前实现的产物）。
     */
    member: '加厚素材 + 专享内容'
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
    name: '关注 / 收藏 / 历史',
    free: '不限次',
    member: '不限次'
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

/** 会员到期日展示：ISO → yyyy-mm-dd（按本地时区取日期，避免 toISOString 跨时区差一天） */
function formatDay(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 默认选中的档位：优先带角标的那档（角标由服务端下发，就是运营想主推的锚点），
 * 没有角标则选第一档。默认选中能省掉「选不了/没选」的无效点击。
 */
function pickDefault(plans: MembershipPlan[]): string {
  return (plans.find((p) => p.badge !== '') ?? plans[0])?.id ?? ''
}

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
  /**
   * 真实示例（O-22）：null = 没有可展示的真实样本（读库失败，或库里还没有带专享段的报告）。
   * 刻意不做「加载中骨架」：示例卡是补充说明而非页面骨架，先摆一张会跳动的空卡比晚半秒出现更打扰。
   */
  const [sample, setSample] = useState<MemberSample | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      /* 三件互不依赖的事并行取：任一失败都不该让整页空着（各自有保守兜底） */
      const [m, p, s] = await Promise.all([
        readMemberState().catch(() => null),
        fetchMembershipPlans().catch(() => FALLBACK_MEMBERSHIP_PLANS),
        loadMemberSample().catch(() => null)
      ])
      if (!alive) return
      setMember(m)
      setPlans(p)
      setSample(s)
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
   * 示例来源行：哪一位的报告、什么时候生成的。
   * 这一行是示例卡「真实」二字的凭据 —— 没有它，卡上的文字与营销文案无从分辨。
   * 生成时间读不到（脏数据）时只写报告名，绝不编一个时间。
   */
  const sampleSource = sample
    ? Number.isFinite(Date.parse(sample.generatedAt))
      ? `示例取自《${sample.name}》${fromNow(sample.generatedAt)}生成的报告 · 原文未改写`
      : `示例取自《${sample.name}》的真实报告 · 原文未改写`
    : ''

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
      await Taro.showModal({ title: '支付未完成', content: res.error ?? '请稍后重试', showCancel: false })
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

  return (
    <View className='page-member'>
      <View className='page-member__hero'>
        <View className='page-member__hero-head'>
          <Text className='page-member__hero-title'>名人雷达会员</Text>
          <Text className={`page-member__hero-tag${isMember ? ' page-member__hero-tag--on' : ''}`}>
            {loading ? '读取中' : isMember ? `会员 · 剩 ${member?.daysLeft ?? 0} 天` : '免费版'}
          </Text>
        </View>
        <Text className='page-member__hero-sub'>
          {loading
            ? '正在读取你的会员状态…'
            : isMember && member?.expiresAt
              ? `有效期至 ${formatDay(member.expiresAt)}；到期前续费按天顺延，不浪费剩余时长`
              : `免费版每日可主动生成 ${FREE_DAILY_GENERATE_LIMIT} 次，会员每日 ${MEMBER_DAILY_GENERATE_LIMIT} 次`}
        </Text>
      </View>

      {loading ? (
        <View className='card'>
          <Skeleton rows={4} variant='card' />
        </View>
      ) : (
        <>
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
            真实示例（O-22）：紧接对比表。
            为什么必须相邻：它回答的正是对比表「深度模式」那一格留下的疑问（「专享内容」是什么），
            两张卡隔开就读不通了；挪到档位下面更糟 —— 用户已经开始付钱了才看到买的是什么。
            整卡只在真取到样本时渲染（口径见 utils/member-sample.ts：不做假示例），
            取不到时这一页与改动前完全一致：宁可少一张卡，也不摆一条编出来的内容。
          */}
          {sample && (
            <View className='card page-member__sample'>
              <Text className='page-member__section'>深度解析 · 真实示例</Text>
              <Text className='page-member__section-note'>{sampleSource}</Text>
              {sample.blocks.map((b) => (
                <View key={b.label} className='page-member__sample-block'>
                  {/* 风险提示换暖色：与报告页那张专享卡同一套语义色，跨页看得出是同一段东西 */}
                  <Text
                    className={`page-member__sample-label${
                      b.label === '风险提示' ? ' page-member__sample-label--risk' : ''
                    }`}
                  >
                    {b.label}
                  </Text>
                  <Text className='page-member__sample-text'>{b.text}</Text>
                </View>
              ))}
              <Text className='page-member__sample-foot'>
                {isMember
                  ? '这三段随每次生成出现在报告页的「会员专享 · 深度解析」卡里'
                  : '开通后你生成的报告会带上这几段；示例为节选，完整内容见对应的报告页'}
              </Text>
            </View>
          )}

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
            <Text className='page-member__note'>· 支付由微信支付完成，成功后会员立即生效（个别情况延迟几秒）</Text>
            <Text className='page-member__note'>· 同一账号可反复续费，剩余时长按购买天数顺延累加</Text>
            <Text className='page-member__note'>· 每日额度 0 点重置；生成失败与缓存命中的报告都不计数</Text>
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
