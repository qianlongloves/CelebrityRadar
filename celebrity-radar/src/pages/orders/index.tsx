import { useCallback, useEffect, useState } from 'react'
import Taro, { usePullDownRefresh } from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { ensureLogin } from '@/utils/auth'
import { table } from '@/utils/db'
import { planEmojiOf, planLabelOf } from '@/utils/pay'
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
  status: string
  createdAt: string
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

/** 订单号：只显示后 8 位 —— 完整号对用户没有意义，长串还会把布局挤出去 */
function shortOrderNo(id: string): string {
  return id ? `…${id.slice(-8)}` : '—'
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
    status: String(raw.status ?? ''),
    createdAt: String(raw.created_at ?? '')
  }
}

export default function OrdersPage() {
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderRow[]>([])
  /** 读库失败 / 未登录时的降级文案（非空即渲染提示卡，不白屏） */
  const [error, setError] = useState('')

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

    const { data, error: dbError } = await table('orders')
      .select('*')
      .eq('_openid', openid)
      .order('created_at', { ascending: false })
      .limit(ORDER_LIMIT)

    if (dbError) {
      /* 读失败给一句可操作的话 + 下拉重试，而不是让页面停在骨架或干脆空白 */
      setOrders([])
      setError('订单读取失败，请下拉重试')
      setLoading(false)
      return
    }

    setOrders(((data as Record<string, unknown>[] | null) ?? []).map(toOrder))
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /* 下拉刷新：`granting` 是中间态，刷新就能看到它推进到「已生效」（与收藏页同一套交互） */
  usePullDownRefresh(async () => {
    await load()
    Taro.stopPullDownRefresh()
  })

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
                <Text className='page-orders__no'>{`订单号 ${shortOrderNo(o.id)}`}</Text>
              </View>
            )
          })}

          <Text className='disclaimer'>
            订单仅自己可见；支付由微信支付完成，会员权益由服务端异步开通
          </Text>
        </>
      )}
    </View>
  )
}
