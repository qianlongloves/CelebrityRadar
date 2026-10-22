import { useCallback, useEffect, useRef, useState } from 'react'
import Taro, { usePullDownRefresh } from '@tarojs/taro'
import { Text, Textarea, View } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { ensureLogin } from '@/utils/auth'
import { table } from '@/utils/db'
import { planEmojiOf, planLabelOf } from '@/utils/pay'
import {
  applyRefund,
  loadMyRefundRequests,
  refundMapOf,
  refundReasonError,
  REFUND_REASON_MAX,
  type RefundRequest
} from '@/utils/refund'
import { formatDate } from '@/utils/time'
import Skeleton from '@/components/skeleton'
import EmptyState from '@/components/empty-state'
import './index.scss'

/**
 * 我的订单（2026-10-12 新增，入口在会员中心，**仅会员可见**）。
 *
 * 解决的是「支付成功后到底怎么样了」这一问：会员的开通由微信回调云函数**异步**完成，
 * 端上 `requestPayment` 成功只代表「已扣款」，会员权益要等回调写库才生效（口径见
 * utils/pay.ts 原则 2/3）。此前用户在等待窗口里没有任何地方能确认这件事，只能反复重进会员页。
 * 这一页把订单状态照实摆出来，`granting`（发货中）那句提示就是给这个场景的。
 *
 * 三条与全项目一致的口径（改动前先读）：
 *   1. **orders 客户端只读**：写入只发生在云函数 payCreate / payCallback（金额、状态、
 *      发货都由服务端落库），这里只按 `_openid == 自己` 读自己那几行。
 *   2. **payment 字段绝不渲染**：那是服务端下发给收银台的微信支付参数，只属于云函数内部。
 *      即便 `select('*')` 把它一起取回，也在 toOrder 里逐字段挑选时丢掉（见该函数注释）。
 *   3. **支付成功 ≠ 会员已生效**：`paid` 是「已发货」终态，`granting` 才是「已付款、正在开通」，
 *      两者在文案上必须分开（判定见 cloudfunctions/payCallback 顶部注释）。
 */

/** 订单行：只有本页要展示的字段（`payment` 等云函数内部字段一律不带出 —— 见文件头原则 2） */
interface OrderRow {
  id: string
  plan: string
  amountFen: number
  days: number
  status: string
  createdAt: string
  paidAt: string
  grantedAt: string
  transactionId: string
  refundedAt: string
  refundReason: string
}

/**
 * 状态 → 中文标签。按「用户看到的到底是什么」写，而不是把英文枚举丢出去：
 *   pending  待支付 —— 还没付钱，收银台没走完
 *   granting 发货中 —— **已付款**，回调正在写会员权益，通常几秒内生效（见下方 STATUS_NOTE）
 *   paid     已生效 —— 会员时长已入账，终态
 *   failed   未完成 —— 回调金额校验不过 / 超时未支付，不会发货，可重新下单
 *   refunded 已退款
 */
const STATUS_LABEL: Record<string, string> = {
  pending: '待支付',
  granting: '发货中',
  paid: '已生效',
  failed: '未完成',
  refunded: '已退款'
}

/** 未知状态（历史/新增枚举）不把英文露给用户，统一显示「处理中」 */
const statusLabel = (status: string): string => STATUS_LABEL[status] ?? '处理中'

/**
 * 需要额外解释的状态。
 *
 * `granting` 是最需要解释的一个：「发货中」四个字本身会被读成「还没付成功」，
 * 而它其实是**已付款、会员正在开通**（payCallback 抢占发货权时的中间态）。不写清，
 * 用户会在等待窗口里以为钱白花了，反复下单 —— 故这里明说「已付款」并给一个时间预期。
 */
const STATUS_NOTE: Record<string, string> = {
  granting: '已付款，会员正在开通中，通常几秒内生效；稍后下拉刷新即可看到最新状态'
}

/** 单次读取上限：会员历史订单不会太多，够看即可（与其它列表页同为 30 的取数习惯一致） */
const ORDER_LIMIT = 30

/** 金额：分 → 元（两位小数）。整数运算后再 toFixed，避免 68.000000001 这类浮点尾巴 */
function formatYuan(fen: number): string {
  return Number.isFinite(fen) ? (fen / 100).toFixed(2) : '0.00'
}

/** 下单时间：不可解析时留空（宁可空着，也不显示 dayjs 的 'Invalid Date'） */
function timeText(iso: string): string {
  return iso && Number.isFinite(Date.parse(iso)) ? formatDate(iso) : ''
}

/**
 * 云端行 → 视图模型：**逐字段挑选**。
 *
 * 关键在「挑选」而不是「透传」：`select('*')` 会把整条文档带回来，其中 `payment`
 * 是服务端下发给收银台的微信支付参数（签名、prepay_id 等），只属于云函数内部 ——
 * 一旦整行交给 React 渲染，它迟早会被某句调试代码或某个展开视图带出去。
 * 故这里只构造页面真正要用的五个字段，其余（含 payment）在这里就丢掉。
 */
function toOrder(raw: Record<string, unknown>): OrderRow {
  return {
    id: String(raw.id ?? raw._id ?? ''),
    plan: String(raw.plan ?? ''),
    amountFen: Number(raw.amount_fen ?? 0),
    days: Number(raw.days ?? 0),
    status: String(raw.status ?? ''),
    createdAt: String(raw.created_at ?? ''),
    paidAt: String(raw.paid_at ?? ''),
    grantedAt: String(raw.granted_at ?? ''),
    transactionId: String(raw.transaction_id ?? ''),
    refundedAt: String(raw.refunded_at ?? ''),
    refundReason: String(raw.refund_reason ?? '')
  }
}

/**
 * 明细区**折叠阈值**（px）：超过这个高度就默认收起、并在卡底给一个「展开明细」。
 *
 * 为什么按实测高度而不是「固定藏几行」：不同订单的明细行数本来就不一样
 * （待支付单没有支付/发货时间，退款单多两行），写死「藏后 N 行」必然在某些单上
 * 藏了不该藏的、或漏藏。这里在渲染后用 createSelectorQuery 量一次真实高度，
 * 只有真的超了才折叠 —— 与用户说的「超出高度折叠」逐字一致。
 */
const DETAIL_MAX_PX = 132

export default function OrdersPage() {
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderRow[]>([])
  /** 读库失败 / 未登录时的降级文案（非空即渲染提示卡，不白屏） */
  const [error, setError] = useState('')
  /** 我的退款申请（订单号 → 最近一条）：与订单**并行**读，读不到就是空对象，不阻塞订单展示 */
  const [refunds, setRefunds] = useState<Record<string, RefundRequest>>({})
  /** 正在填写退款理由的订单（null = 弹层收起） */
  const [askFor, setAskFor] = useState<OrderRow | null>(null)
  const [askReason, setAskReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  /**
   * 取数。首次进页与下拉刷新共用同一条路径。
   *
   * openid 就是登录后 users 行的 `_openid`（云开发不提供客户端换 openid 的 API）：
   * 端上从 auth store 取（与「我的」页同一处，见 stores/auth）。冷启后可能还没登录，
   * 先补一次 ensureLogin（内部已 catch），仍拿不到才降级 —— 不硬闯一个必然被拒绝的查询。
   */
  const load = useCallback(async () => {
    setLoading(true)
    setError('')

    let openid = useAuth.getState().userId
    if (!openid) {
      await ensureLogin()
      openid = useAuth.getState().userId
    }
    if (!openid) {
      setOrders([])
      setError('登录后才能查看订单')
      setLoading(false)
      return
    }

    /*
     * 订单与退款申请**并行**取：申请只影响卡片底部那一个小块，
     * 让它串行挡在订单前面（多一次云函数往返）会让整页慢一拍。
     */
    const [{ data, error: dbError }, myRefunds] = await Promise.all([
      table('orders')
        .select('*')
        .eq('_openid', openid)
        .order('created_at', { ascending: false })
        .limit(ORDER_LIMIT),
      loadMyRefundRequests()
    ])

    if (dbError) {
      /* 读失败给一句可操作的话 + 下拉重试，而不是让页面停在骨架或干脆空白 */
      setOrders([])
      setError('订单读取失败，请下拉重试')
      setLoading(false)
      return
    }

    setRefunds(refundMapOf(myRefunds))
    setOrders(((data as Record<string, unknown>[] | null) ?? []).map(toOrder))
    setLoading(false)
  }, [])

  /** 打开发起退款的弹层（清空上一次的草稿，避免把上一单的理由带过来） */
  const openAsk = useCallback((order: OrderRow) => {
    setAskFor(order)
    setAskReason('')
  }, [])

  const closeAsk = useCallback(() => {
    setAskFor(null)
    setAskReason('')
  }, [])

  /**
   * 提交退款申请。
   *
   * 端上这一道校验（`refundReasonError`）只为省一次往返 —— **真正的闸门在云函数**
   * refundApply（端上校验永远可以被绕过）。提交成功后重新拉一次，让卡片立刻变成
   * 「等待平台核实」，不给用户「点了没反应」的错觉。
   */
  const submitAsk = useCallback(async () => {
    if (!askFor || submitting) return
    const why = refundReasonError(askReason)
    if (why) {
      void Taro.showToast({ title: why, icon: 'none' })
      return
    }
    setSubmitting(true)
    const res = await applyRefund(askFor.id, askReason)
    setSubmitting(false)
    if (!res.ok) {
      void Taro.showToast({ title: res.error || '提交失败，请稍后重试', icon: 'none' })
      return
    }
    closeAsk()
    void Taro.showToast({
      title: res.already ? res.hint || '这笔申请已在核实中' : res.hint || '已提交，等待平台核实',
      icon: 'none'
    })
    await load()
  }, [askFor, askReason, submitting, closeAsk, load])

  useEffect(() => {
    void load()
  }, [load])

  /* 下拉刷新：`granting` 是中间态，刷新就能看到它推进到「已生效」（与收藏页同一套交互） */
  usePullDownRefresh(async () => {
    await load()
    Taro.stopPullDownRefresh()
  })

  /**
   * 明细折叠状态（orderId → 是否收起）。
   *
   * 初值刻意是「全展开」：先按真实内容渲染一次，量完高度再决定谁需要收起 ——
   * 反过来（先全收起再展开）会让本来不超高的单也闪一下。
   * 键**存在**（true/false）即表示这张卡的明细超过阈值、需要常驻一个展开/收起按钮；
   * 键不存在 = 明细本来就短，既不限高也不给按钮。
   */
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  /** 已经量过的那批订单（按 id 串起来）：量过就不重复量，避免每次展开/收起又触发一轮测量 */
  const measured = useRef('')

  useEffect(() => {
    if (loading || orders.length === 0) return
    const stamp = orders.map((o) => o.id).join('|')
    if (measured.current === stamp) return
    measured.current = stamp
    /*
     * 量一次明细区的真实高度，只把超阈值的卡默认收起（口径见 DETAIL_MAX_PX）。
     * selectAll 的返回**与渲染顺序一致**，所以按 orders 的下标对齐即可 ——
     * 不给每张卡各写一个 id 选择器（订单号含大写字母与数字，拼选择器更容易写错）。
     */
    Taro.createSelectorQuery()
      .selectAll('.page-orders__detail')
      .boundingClientRect()
      .exec((res) => {
        const rects = (res && res[0]) as Array<{ height?: number }> | undefined
        if (!rects || rects.length !== orders.length) return
        const next: Record<string, boolean> = {}
        rects.forEach((r, i) => {
          if (r && (r.height ?? 0) > DETAIL_MAX_PX) next[orders[i].id] = true
        })
        if (Object.keys(next).length > 0) setFolded(next)
      })
  }, [loading, orders])

  return (
    <View className='page-orders'>
      {loading ? (
        <Skeleton variant='card' rows={3} />
      ) : error ? (
        <View className='card page-orders__hint'>
          <Text>{error}</Text>
        </View>
      ) : orders.length === 0 ? (
        <EmptyState
          icon='🧾'
          title='还没有订单'
          desc='开通或续费会员后，支付与开通记录会显示在这里'
        />
      ) : (
        <>
          {orders.map((o) => {
            const note = STATUS_NOTE[o.status]
            const isFolded = !!folded[o.id]
            const refund = refunds[o.id]
            /*
             * 明细行：只列这条订单**确实有值**的字段（没有的整行不渲染）。
             * 不铺一排「—」的原因：待支付单没有支付/发货时间，退款单多两行 ——
             * 一律渲染会让人以为「字段丢了」，而不是「这件事还没发生」。
             */
            const details: Array<[string, string]> = (
              [
                ['订单号', o.id],
                ['时长', o.days > 0 ? `${o.days} 天` : ''],
                ['下单时间', timeText(o.createdAt)],
                ['支付时间', timeText(o.paidAt)],
                ['开通时间', timeText(o.grantedAt)],
                ['交易号', o.transactionId],
                ['退款时间', timeText(o.refundedAt)],
                ['退款原因', o.refundReason]
              ] as Array<[string, string]>
            ).filter(([, value]) => value !== '')
            return (
              <View key={o.id} className='card page-orders__item'>
                <View className='page-orders__head'>
                  <Text className='page-orders__plan'>
                    {`${planEmojiOf(o.plan)} ${planLabelOf(o.plan)}`}
                  </Text>
                  <Text className={`page-orders__status page-orders__status--${o.status}`}>
                    {statusLabel(o.status)}
                  </Text>
                </View>
                <View className='page-orders__line'>
                  <Text className='page-orders__amount'>{`¥${formatYuan(o.amountFen)}`}</Text>
                  <Text className='text-tertiary page-orders__time'>{timeText(o.createdAt)}</Text>
                </View>
                {!!note && <Text className='page-orders__note'>{note}</Text>}

                {/*
                  * 退款入口（2026-10-22）：只在 `paid`（已生效）上给。
                  *   pending / failed 退不出钱；granting 是发货进行中的几秒窗口，adminRefund 会拒
                  *   （让用户下拉刷新一下再申请，比让超管点到一个必然失败的单要好）。
                  * 已提交 / 被拒绝都要有明确回执：这块是用户唯一能看到「我的申请怎么了」的地方。
                  */}
                {o.status === 'paid' && (
                  <View className='page-orders__refund'>
                    {refund && refund.status === 'pending' ? (
                      <Text className='page-orders__refund-state'>退款申请已提交，等待平台核实</Text>
                    ) : refund && refund.status === 'rejected' ? (
                      <Text className='page-orders__refund-state page-orders__refund-state--rejected'>
                        {`退款申请未通过${refund.decisionNote ? `：${refund.decisionNote}` : ''}`}
                      </Text>
                    ) : (
                      <Text className='page-orders__refund-apply' onClick={() => openAsk(o)}>
                        申请退款
                      </Text>
                    )}
                  </View>
                )}

                {/* 明细区：超过阈值才限高（阈值口径见 DETAIL_MAX_PX），按钮只在需要时出现 */}
                <View
                  className={`page-orders__detail${isFolded ? ' page-orders__detail--fold' : ''}`}
                  style={isFolded ? { maxHeight: `${DETAIL_MAX_PX}px` } : undefined}
                >
                  {details.map(([label, value]) => (
                    <View key={label} className='page-orders__detail-row'>
                      <Text className='page-orders__detail-label'>{label}</Text>
                      <Text className='page-orders__detail-value'>{value}</Text>
                    </View>
                  ))}
                </View>

                {folded[o.id] !== undefined && (
                  <Text
                    className='page-orders__toggle'
                    onClick={() =>
                      setFolded((prev) => Object.assign({}, prev, { [o.id]: !prev[o.id] }))
                    }
                  >
                    {isFolded ? '展开明细 ▾' : '收起明细 ▴'}
                  </Text>
                )}
              </View>
            )
          })}

          <Text className='disclaimer'>
            订单仅自己可见；支付由微信支付完成，会员权益由服务端异步开通
          </Text>
        </>
      )}

      {/*
        * 退款理由弹层。
        * 用页面内的弹层而不是 `Taro.showModal({ editable:true })`：后者只有单行输入，
        * 而退款理由往往需要两三句（「买错了档位」「重复支付」…），单行输入会把理由
        * 压成几个字 —— 而理由正是超管核实的唯一依据（refundApply 强制 2~200 字）。
        */}
      {!!askFor && (
        <View className='page-orders__mask' onClick={() => (submitting ? undefined : closeAsk())}>
          <View className='page-orders__sheet' onClick={(e) => e.stopPropagation()}>
            <Text className='page-orders__sheet-title'>申请退款</Text>
            <Text className='page-orders__sheet-sub'>
              {`${planLabelOf(askFor.plan)} · ¥${formatYuan(askFor.amountFen)}`}
            </Text>
            <Textarea
              className='page-orders__textarea'
              value={askReason}
              onInput={(e) => setAskReason(e.detail.value)}
              placeholder='请说明退款原因（至少 2 个字），平台核实后会处理'
              maxlength={REFUND_REASON_MAX}
            />
            <Text className='page-orders__counter'>{`${askReason.trim().length}/${REFUND_REASON_MAX}`}</Text>
            <View className='page-orders__sheet-actions'>
              <View className='page-orders__btn page-orders__btn--ghost' onClick={closeAsk}>
                <Text>取消</Text>
              </View>
              <View
                className={`page-orders__btn${submitting ? ' page-orders__btn--disabled' : ''}`}
                onClick={() => void submitAsk()}
              >
                <Text>{submitting ? '提交中…' : '提交申请'}</Text>
              </View>
            </View>
            <Text className='page-orders__sheet-tip'>提交后会通知平台核实，结果会显示在这张订单上</Text>
          </View>
        </View>
      )}
    </View>
  )
}
