import Taro, { useLoad } from '@tarojs/taro'
import { useState } from 'react'
import { View, Text, Input, Switch, Textarea } from '@tarojs/components'
import {
  adminMe,
  adminListUsers,
  adminGetUser,
  adminGrantMember,
  adminRevokeMember,
  adminListVendors,
  adminSetVendor,
  adminListPlans,
  adminSetPlans,
  adminRefundRequests,
  adminRefundDecide,
  type AdminUserRow,
  type AdminUserDetail,
  type AdminVendorState,
  type AdminPlanRow,
  type AdminPlanState,
  type AdminRefundRow,
  type AdminRefundStatus
} from '@/utils/admin'
import { clearPlanCache } from '@/utils/pay'
import './index.scss'

/**
 * 运维中心（2026-10-18，超管专用）
 *
 * 四件事：
 *   ① **用户**：按昵称 / openid 找人，看他的会员与配额，直接改会员（发放 / 撤销）；
 *   ② **退款**（2026-10-22）：用户自己在订单页提交的退款申请排在这里，核实理由后
 *      「点击退款」（走 adminConsole → payCallback），或拒绝（必须写理由，用户会看到）；
 *   ③ **模型**：把某家大模型厂商临时停用 —— 欠费、被风控、上游持续 5xx 时先止血，
 *      云端会在发请求之前跳过它并回落到可用的一家，不需要改代码、不需要重新部署；
 *   ④ **价格**（2026-10-22）：改会员三档的价格与角标。价格从「改常量 + 重新部署」变成
 *      线上可调，端上不用发版 —— 但**上下限与「必须三档一次提交」的约束在服务端**。
 *
 * ⚠ 四处刻意的设计：
 *   · **鉴权在服务端**：本页的 `isAdmin` 只决定「要不要显示」。改包把入口强开，云函数照样拒 ——
 *     端上的判断永远只是体验，不是权限。
 *   · **会员只有一条写路**：本页不直接写 `memberships`，而是让云函数代理到 payCallback。
 *     两个写口意味着两份真相，迟早对不上。
 *   · **不许把厂商全停**：服务端强制至少留一家。这条约束必须落在服务端 ——
 *     端上的按钮可以被绕过，而「全停」的后果是全站生成与问答立刻失败。
 *   · **退款也不在本页直接动钱**：点「退款」只是发一次 `refundDecide`，真正退款与
 *     订单状态由 payCallback 完成。钱只有一条路，出问题只有一处要查。
 */

type Tab = 'users' | 'refunds' | 'vendors' | 'plans'

/** 分 → 「¥9.9」文本（订单实付金额展示用） */
function fenLabel(fen: number): string {
  const n = Number(fen)
  if (!Number.isFinite(n) || n <= 0) return '¥—'
  return `¥${(n / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}`
}

const dayTimeOf = (iso?: string | null) => {
  if (!iso) return '—'
  const text = String(iso)
  return text.length >= 16 ? text.slice(0, 16).replace('T', ' ') : dayOf(text)
}

/** 处理弹层的两种动作（同一套输入框，字段要求不同） */
type RefundDecision = 'approve' | 'reject'

/** 分 → 元 文本（990 → `9.9`、6800 → `68`），只用于回填输入框 */
function fenToYuan(fen: number): string {
  return String(Math.round(fen) / 100)
}

/** 价格编辑态：金额用「元」让运维按习惯输入，保存时才换算成分 */
type PlanDraft = Record<string, { yuan: string; badge: string }>

function draftOfPlans(plans: AdminPlanRow[]): PlanDraft {
  const out: PlanDraft = {}
  for (const p of plans) out[p.id] = { yuan: fenToYuan(p.priceFen), badge: p.badge }
  return out
}

const PAGE_SIZE = 20
const REFUND_PAGE_SIZE = 20
const DAY_MS = 86400000

const dayOf = (iso?: string | null) => (iso && iso.length >= 10 ? iso.slice(0, 10) : '—')

/** 剩余天数：算不出来返回 null（显示「—」而不是 0，0 会让人以为是过期当天） */
const leftDays = (iso?: string | null) => {
  const ts = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ts)) return null
  const d = Math.ceil((ts - Date.now()) / DAY_MS)
  return d > 0 ? d : 0
}

const shortId = (openid: string) => (openid && openid.length > 10 ? `…${openid.slice(-8)}` : openid || '—')

export default function Admin() {
  const [checking, setChecking] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [myOpenid, setMyOpenid] = useState('')
  const [hint, setHint] = useState('')
  const [tab, setTab] = useState<Tab>('users')

  const [keyword, setKeyword] = useState('')
  const [rows, setRows] = useState<AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)

  const [detailOf, setDetailOf] = useState('')
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)

  const [vendors, setVendors] = useState<AdminVendorState | null>(null)
  const [busyVendor, setBusyVendor] = useState('')

  const [planState, setPlanState] = useState<AdminPlanState | null>(null)
  const [planDraft, setPlanDraft] = useState<PlanDraft>({})
  const [busyPlans, setBusyPlans] = useState(false)

  /* 退款待办：`pendingRefunds` 只用于 tab 红点，列表另有自己的 pending 总数 */
  const [pendingRefunds, setPendingRefunds] = useState(0)
  const [refunds, setRefunds] = useState<AdminRefundRow[]>([])
  const [refundTotal, setRefundTotal] = useState(0)
  const [refundFilter, setRefundFilter] = useState<AdminRefundStatus | 'all'>('pending')
  const [refundLoading, setRefundLoading] = useState(false)
  const [refundNote, setRefundNote] = useState('')
  const [deciding, setDeciding] = useState<{ row: AdminRefundRow; decision: RefundDecision } | null>(null)
  const [decideFee, setDecideFee] = useState('')
  const [decideRefundId, setDecideRefundId] = useState('')
  const [decideNote, setDecideNote] = useState('')
  const [busyDecide, setBusyDecide] = useState(false)

  useLoad(() => {
    void boot()
  })

  async function boot() {
    const me = await adminMe()
    setChecking(false)
    if (!me.ok) {
      setHint(me.error)
      return
    }
    setMyOpenid(me.openid)
    setIsAdmin(!!me.isAdmin)
    setHint(me.hint || '')
    setPendingRefunds(Number(me.pendingRefunds) || 0)
    if (me.isAdmin) void loadUsers(0)
  }

  /**
   * 拉用户列表。`append=false` 时从第 0 页重来（搜索 / 改完会员后刷新）。
   * 搜索口径与云端一致：像 openid 就精确、否则昵称模糊 —— 提示语里直接写清楚，
   * 免得运维拿昵称去搜 openid 然后以为「查无此人」。
   */
  async function loadUsers(nextPage: number, append = false) {
    if (loading) return
    setLoading(true)
    const res = await adminListUsers({ keyword, page: nextPage, pageSize: PAGE_SIZE })
    setLoading(false)
    if (!res.ok) {
      Taro.showToast({ title: res.error, icon: 'none', duration: 2500 })
      return
    }
    setRows(append ? rows.concat(res.users) : res.users)
    setTotal(res.total)
    setPage(res.page)
  }

  function onSearch() {
    void loadUsers(0)
  }

  async function refreshDetail(openid: string) {
    setDetailOf(openid)
    setDetail(null)
    const res = await adminGetUser(openid)
    if (!res.ok) {
      Taro.showToast({ title: res.error, icon: 'none' })
      return
    }
    setDetail(res)
  }

  function onToggleDetail(openid: string) {
    if (detailOf === openid) {
      setDetailOf('')
      setDetail(null)
      return
    }
    void refreshDetail(openid)
  }

  /** 改会员：一律先确认 —— 这两个动作都直接改变别人能不能用付费功能 */
  async function onGrant(row: AdminUserRow, days: number) {
    const who = row.nickname || shortId(row.openid)
    const ok = await confirmBox(`给「${who}」加 ${days} 天会员？`, '会按现状续期（不与已有有效期冲突）')
    if (!ok) return
    Taro.showLoading({ title: '处理中', mask: true })
    const res = await adminGrantMember(row.openid, days)
    Taro.hideLoading()
    if (!res.ok) {
      Taro.showModal({ title: '发放失败', content: res.error, showCancel: false })
      return
    }
    Taro.showToast({ title: `已加 ${days} 天`, icon: 'success' })
    void loadUsers(page)
    if (detailOf === row.openid) void refreshDetail(row.openid)
  }

  async function onRevoke(row: AdminUserRow) {
    const who = row.nickname || shortId(row.openid)
    const ok = await confirmBox(
      `立即撤销「${who}」的会员？`,
      '有效期会收到此刻，已付订单不会退款；重新发放可随时恢复。'
    )
    if (!ok) return
    Taro.showLoading({ title: '处理中', mask: true })
    const res = await adminRevokeMember(row.openid)
    Taro.hideLoading()
    if (!res.ok) {
      Taro.showModal({ title: '撤销失败', content: res.error, showCancel: false })
      return
    }
    Taro.showToast({ title: res.revoked ? '已撤销' : '本就不是会员', icon: 'none' })
    void loadUsers(page)
    if (detailOf === row.openid) void refreshDetail(row.openid)
  }

  /** 切到退款 tab 并刷新（红点 / 顶部提醒都走这里，避免两处各写一套） */
  function switchToRefunds() {
    setTab('refunds')
    void loadRefunds(refundFilter)
  }

  /**
   * 拉退款申请列表。
   *
   * 默认 `pending`（待我处理的），切到「全部」看历史处理结果 —— 两条口径分开，
   * 是因为「该做什么」和「谁批的」在同一个列表里会互相淹没。
   */
  async function loadRefunds(status: AdminRefundStatus | 'all' = refundFilter) {
    if (refundLoading) return
    setRefundLoading(true)
    setRefundFilter(status)
    const res = await adminRefundRequests({ status, page: 0, pageSize: REFUND_PAGE_SIZE })
    setRefundLoading(false)
    if (!res.ok) {
      Taro.showToast({ title: res.error, icon: 'none', duration: 2500 })
      return
    }
    setRefunds(res.rows)
    setRefundTotal(res.total)
    setPendingRefunds(res.pending)
    setRefundNote(res.note || '')
  }

  /** 打开处理弹层：退款默认带出**全额**（最省事、也最不容易填错），拒绝不带任何默认值 */
  function openDecide(row: AdminRefundRow, decision: RefundDecision) {
    setDeciding({ row, decision })
    setDecideFee(decision === 'approve' ? String(Math.round(row.amountFen) / 100) : '')
    setDecideRefundId('')
    setDecideNote('')
  }

  function closeDecide() {
    if (busyDecide) return
    setDeciding(null)
    setDecideFee('')
    setDecideRefundId('')
    setDecideNote('')
  }

  /**
   * 提交核实结果。
   *
   * 两个必须挡在端上的**明显错误**（服务端还会再判一次，那一道才是闸门）：
   *   · 拒绝不写理由 —— 用户会在订单页看到这条理由，空着等于把人堵死；
   *   · 退款金额超过实付 —— 多退的钱收不回来。
   *
   * 真正的退款由 payCallback 执行；这里成功只代表「钱退了、申请单也记下了」。
   */
  async function submitDecide() {
    if (!deciding || busyDecide) return
    const row = deciding.row
    const note = decideNote.trim()

    if (deciding.decision === 'reject') {
      if (note.length < 2) {
        Taro.showToast({ title: '拒绝理由至少 2 个字（用户会看到）', icon: 'none' })
        return
      }
      const ok = await confirmBox(
        `拒绝「${row.outTradeNo}」的退款申请？`,
        `理由：${note}\n\n用户会在订单页看到这条理由，订单保持 paid。`
      )
      if (!ok) return
      setBusyDecide(true)
      const res = await adminRefundDecide(row.id, 'reject', { note })
      setBusyDecide(false)
      if (!res.ok) {
        Taro.showModal({ title: '拒绝失败', content: res.error, showCancel: false })
        return
      }
      Taro.showToast({ title: '已拒绝', icon: 'none' })
      setDeciding(null)
      void loadRefunds()
      return
    }

    /* 退款：金额以「元」输入、换算成分提交；留空 = 全额退 */
    let fee: number | undefined
    const feeText = decideFee.trim()
    if (feeText) {
      const yuan = Number(feeText)
      if (!Number.isFinite(yuan) || yuan <= 0) {
        Taro.showToast({ title: '退款金额要填正数（留空 = 全额退）', icon: 'none' })
        return
      }
      const fen = yuan * 100
      if (Math.abs(Math.round(fen) - fen) > 1e-6) {
        Taro.showToast({ title: '退款金额最多两位小数', icon: 'none' })
        return
      }
      fee = Math.round(fen)
      if (fee > row.amountFen) {
        Taro.showToast({ title: `退款金额不能超过实付 ${fenLabel(row.amountFen)}`, icon: 'none' })
        return
      }
    }

    const amountText = fee === undefined ? `${fenLabel(row.amountFen)}（全额）` : fenLabel(fee)
    const ok = await confirmBox(
      `确认退款 ${amountText}？`,
      `订单 ${row.outTradeNo}\n用户理由：${row.reason}\n\n点确定后立刻发起退款，订单转为已退款，会员天数按对账撤销。此操作不可撤回。`
    )
    if (!ok) return
    setBusyDecide(true)
    Taro.showLoading({ title: '退款中', mask: true })
    const res = await adminRefundDecide(row.id, 'approve', {
      fee,
      refundId: decideRefundId.trim(),
      note
    })
    Taro.hideLoading()
    setBusyDecide(false)
    if (!res.ok) {
      Taro.showModal({ title: '退款失败', content: res.error, showCancel: false })
      return
    }
    Taro.showToast({ title: `已退 ${fenLabel(Number(res.refundFee) || 0)}`, icon: 'none' })
    setDeciding(null)
    void loadRefunds()
    /* 会员天数可能刚被对账倒扣：用户列表里的「会员」标签需要重新读一次 */
    void loadUsers(page)
    if (detailOf) void refreshDetail(detailOf)
  }

  async function loadVendors() {
    const res = await adminListVendors()
    if (!res.ok) {
      Taro.showToast({ title: res.error, icon: 'none', duration: 2500 })
      return
    }
    setVendors(res)
  }

  /**
   * 切换厂商开关。
   * 「停用」必须弹确认：这一步的后果是「所有新请求立刻不再走这家」，
   * 比「发个通知」重得多 —— 误触一次，付费用户的高级模型当场被换掉。
   */
  async function onToggleVendor(key: string, label: string, next: boolean) {
    if (!next) {
      const ok = await confirmBox(
        `停用「${label}」？`,
        '停用后新请求会立刻回落到其它可用厂商（已发送的请求不受影响），恢复只需再点一次。'
      )
      if (!ok) {
        /* 开关是受控组件：用户取消时把 UI 拉回原状 */
        setVendors(vendors ? { ...vendors, vendors: vendors.vendors.map((v) => ({ ...v })) } : vendors)
        return
      }
    }
    setBusyVendor(key)
    const res = await adminSetVendor(key, next)
    setBusyVendor('')
    if (!res.ok) {
      Taro.showModal({ title: '切换失败', content: res.error, showCancel: false })
      return
    }
    Taro.showToast({ title: next ? '已启用' : '已停用', icon: 'none' })
    void loadVendors()
  }

  async function loadPlans() {
    const res = await adminListPlans()
    if (!res.ok) {
      Taro.showToast({ title: res.error, icon: 'none', duration: 2500 })
      return
    }
    setPlanState(res)
    setPlanDraft(draftOfPlans(res.plans))
  }

  function onEditPlan(id: string, patch: Partial<{ yuan: string; badge: string }>) {
    setPlanDraft((prev) => ({
      ...prev,
      [id]: Object.assign({ yuan: '', badge: '' }, prev[id], patch)
    }))
  }

  /**
   * 保存价格。端上校验只是**体验**（把明显打错的数字当场挡住），
   * 真正的上下限与「三档齐全」在 adminConsole 里再判一次 —— 改包绕不过去。
   */
  async function onSavePlans() {
    if (!planState || busyPlans) return
    const rows: Array<{ id: string; priceFen: number; badge: string }> = []
    const after: string[] = []
    for (const p of planState.plans) {
      const raw = (planDraft[p.id]?.yuan ?? '').trim()
      const yuan = Number(raw)
      if (!raw || !Number.isFinite(yuan) || yuan <= 0) {
        Taro.showToast({ title: `${p.name} 的价格要填正数`, icon: 'none' })
        return
      }
      const fen = yuan * 100
      if (Math.abs(Math.round(fen) - fen) > 1e-6) {
        Taro.showToast({ title: `${p.name} 最多两位小数`, icon: 'none' })
        return
      }
      rows.push({ id: p.id, priceFen: Math.round(fen), badge: (planDraft[p.id]?.badge ?? '').trim() })
      after.push(`${p.name} ¥${raw}`)
    }
    const ok = await confirmBox(
      '确认改价？',
      `改为：${after.join('、')}\n\n新订单立刻按新价收取；已下单未支付的订单保持原价。`
    )
    if (!ok) return
    setBusyPlans(true)
    const res = await adminSetPlans(rows)
    setBusyPlans(false)
    if (!res.ok) {
      Taro.showModal({ title: '改价失败', content: res.error, showCancel: false })
      return
    }
    /* 本机套餐缓存是 24 小时：不清掉的话，管理员进会员页看到的还是旧价 */
    clearPlanCache()
    setPlanState(res)
    setPlanDraft(draftOfPlans(res.plans))
    Taro.showToast({ title: '已保存', icon: 'success' })
  }

  if (checking) {
    return (
      <View className='page-admin'>
        <Text className='page-admin__tip'>正在校验权限…</Text>
      </View>
    )
  }

  if (!isAdmin) {
    return (
      <View className='page-admin'>
        <View className='card page-admin__denied'>
          <Text className='page-admin__denied-title'>无权访问</Text>
          <Text className='page-admin__denied-note'>
            {hint || '你的账号不在超管名单里。运维中心的鉴权在服务端，改包也进不来。'}
          </Text>
          {myOpenid ? (
            <Text className='page-admin__denied-id' selectable>
              你的 openid：{myOpenid}
            </Text>
          ) : null}
          <Text className='page-admin__denied-note'>
            配超管：云函数 adminConsole 的环境变量 ADMIN_OPENIDS 里加这个 openid（逗号分隔），重新部署后生效。
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View className='page-admin'>
      {/* 待办提醒：超管一进来就该看到「有事要做」，而不是自己去翻每个 tab */}
      {pendingRefunds > 0 && tab !== 'refunds' ? (
        <View className='page-admin__notice' onClick={() => void switchToRefunds()}>
          <Text className='page-admin__notice-text'>
            有 {pendingRefunds} 笔退款申请等你核实
          </Text>
          <Text className='page-admin__notice-go'>去处理 ›</Text>
        </View>
      ) : null}

      <View className='page-admin__tabs'>
        <View
          className={`page-admin__tab${tab === 'users' ? ' page-admin__tab--on' : ''}`}
          onClick={() => setTab('users')}
        >
          用户
        </View>
        <View
          className={`page-admin__tab${tab === 'refunds' ? ' page-admin__tab--on' : ''}`}
          onClick={() => void switchToRefunds()}
        >
          退款
          {pendingRefunds > 0 ? (
            <Text className='page-admin__tab-dot'>{pendingRefunds > 99 ? '99+' : pendingRefunds}</Text>
          ) : null}
        </View>
        <View
          className={`page-admin__tab${tab === 'vendors' ? ' page-admin__tab--on' : ''}`}
          onClick={() => {
            setTab('vendors')
            if (!vendors) void loadVendors()
          }}
        >
          模型
        </View>
        <View
          className={`page-admin__tab${tab === 'plans' ? ' page-admin__tab--on' : ''}`}
          onClick={() => {
            setTab('plans')
            if (!planState) void loadPlans()
          }}
        >
          价格
        </View>
      </View>

      {tab === 'users' ? (
        <View>
          <View className='page-admin__search'>
            <Input
              className='page-admin__input'
              value={keyword}
              placeholder='昵称（模糊）或 openid（精确）'
              confirmType='search'
              onInput={(e) => setKeyword(e.detail.value)}
              onConfirm={onSearch}
            />
            <View className='page-admin__search-btn' onClick={onSearch}>
              搜索
            </View>
          </View>

          <Text className='page-admin__meta'>
            {loading ? '查询中…' : `共 ${total} 位${keyword ? `（匹配「${keyword}」）` : '（最近注册优先）'}`}
          </Text>

          {rows.map((row) => {
            const left = leftDays(row.expires_at)
            return (
              <View key={row.openid} className='card page-admin__user'>
                <View className='page-admin__user-head' onClick={() => void onToggleDetail(row.openid)}>
                  <View className='page-admin__user-info'>
                    <Text className='page-admin__user-name'>
                      {row.nickname || '（未设置昵称）'}
                      {row.isMember ? <Text className='page-admin__badge'>会员</Text> : null}
                      {row.mismatched ? <Text className='page-admin__badge page-admin__badge--warn'>镜像不一致</Text> : null}
                    </Text>
                    <Text className='page-admin__user-id'>{shortId(row.openid)}</Text>
                    <Text className='page-admin__user-meta'>
                      {row.isMember
                        ? `${row.plan || '会员'} · 到期 ${dayOf(row.expires_at)}（剩 ${left ?? '—'} 天）`
                        : `非会员${row.expires_at ? ` · 已于 ${dayOf(row.expires_at)} 到期` : ''}`}
                    </Text>
                    {row.lastAdminOp ? (
                      <Text className='page-admin__user-meta'>
                        最近人工操作：{row.lastAdminOp.op === 'revokeMember' ? '撤销' : '发放'} ·{' '}
                        {dayOf(row.lastAdminOp.at)} · by {row.lastAdminOp.by}
                      </Text>
                    ) : null}
                  </View>
                  <Text className='page-admin__user-arrow'>{detailOf === row.openid ? '⌃' : '⌄'}</Text>
                </View>

                <View className='page-admin__user-actions'>
                  <View className='page-admin__act' onClick={() => void onGrant(row, 30)}>
                    +30 天
                  </View>
                  <View className='page-admin__act' onClick={() => void onGrant(row, 365)}>
                    +365 天
                  </View>
                  <View className='page-admin__act page-admin__act--danger' onClick={() => void onRevoke(row)}>
                    撤销会员
                  </View>
                </View>

                {detailOf === row.openid ? (
                  <View className='page-admin__detail'>
                    {!detail ? (
                      <Text className='page-admin__detail-note'>读取中…</Text>
                    ) : (
                      <View>
                        <Text className='page-admin__detail-line'>{detail.conclusion}</Text>
                        <Text className='page-admin__detail-line'>
                          权威：{detail.authority?.plan || '—'} / 到期 {dayOf(detail.authority?.expires_at)} ·
                          镜像：{detail.mirror?.plan || '—'} / {dayOf(detail.mirror?.expires_at)}
                        </Text>
                        <Text className='page-admin__detail-line'>
                          今日配额 生成 {detail.quotasToday.generate ?? 0} · 问答 {detail.quotasToday.ask ?? 0} ·
                          刷新 {detail.quotasToday.refresh ?? 0}
                        </Text>
                        <Text className='page-admin__detail-line'>
                          今日模型调用 {detail.abuseCallsToday} 次 · 注册{' '}
                          {dayOf(detail.user?.created_at)} · 最近活跃 {dayOf(detail.user?.last_seen_at)}
                        </Text>
                        <Text className='page-admin__detail-line' selectable>
                          openid：{detail.user?.openid || row.openid}
                        </Text>
                      </View>
                    )}
                  </View>
                ) : null}
              </View>
            )
          })}

          {rows.length === 0 && !loading ? (
            <Text className='page-admin__tip'>{keyword ? '没有匹配的用户' : '还没有用户'}</Text>
          ) : null}

          {rows.length > 0 && rows.length < total ? (
            <View className='page-admin__more' onClick={() => void loadUsers(page + 1, true)}>
              {loading ? '加载中…' : `加载更多（已显示 ${rows.length} / ${total}）`}
            </View>
          ) : null}
        </View>
      ) : tab === 'refunds' ? (
        <View>
          <View className='page-admin__seg'>
            <View
              className={`page-admin__seg-item${refundFilter === 'pending' ? ' page-admin__seg-item--on' : ''}`}
              onClick={() => void loadRefunds('pending')}
            >
              待核实{pendingRefunds > 0 ? ` ${pendingRefunds}` : ''}
            </View>
            <View
              className={`page-admin__seg-item${refundFilter === 'all' ? ' page-admin__seg-item--on' : ''}`}
              onClick={() => void loadRefunds('all')}
            >
              全部记录
            </View>
          </View>

          <Text className='page-admin__meta'>
            用户自己在「我的订单」里提交申请（理由必填），这里核实后再点退款。钱与订单状态由
            payCallback 处理 —— 点一次只会退一次，重复点会被拒。
          </Text>

          {refundNote ? <Text className='page-admin__tip'>{refundNote}</Text> : null}

          {refundLoading && refunds.length === 0 ? <Text className='page-admin__tip'>读取中…</Text> : null}

          {refunds.map((r) => (
            <View key={r.id} className='card page-admin__refund'>
              <View className='page-admin__refund-head'>
                <Text className='page-admin__refund-amount'>{fenLabel(r.amountFen)}</Text>
                <Text className={`page-admin__refund-state page-admin__refund-state--${r.status}`}>
                  {r.status === 'pending' ? '待核实' : r.status === 'approved' ? '已退款' : '已拒绝'}
                </Text>
              </View>

              <Text className='page-admin__user-meta'>
                {r.plan || '会员'} · {r.days} 天 · 用户 …{r.openidTail}
              </Text>
              <Text className='page-admin__user-id' selectable>
                {r.outTradeNo}
              </Text>
              <Text className='page-admin__user-meta'>
                支付 {dayTimeOf(r.paidAt)} · 申请 {dayTimeOf(r.createdAt)}
              </Text>

              <View className='page-admin__refund-reason'>
                <Text className='page-admin__refund-reason-label'>用户理由</Text>
                <Text className='page-admin__refund-reason-text' selectable>
                  {r.reason || '（未填写）'}
                </Text>
              </View>

              {r.status === 'pending' ? (
                <View className='page-admin__user-actions'>
                  <View className='page-admin__act' onClick={() => openDecide(r, 'approve')}>
                    核实并退款
                  </View>
                  <View className='page-admin__act page-admin__act--danger' onClick={() => openDecide(r, 'reject')}>
                    拒绝
                  </View>
                </View>
              ) : (
                <View className='page-admin__refund-done'>
                  <Text className='page-admin__detail-line'>
                    处理：{dayTimeOf(r.decidedAt)} · by {r.decidedBy || '—'}
                    {r.status === 'approved'
                      ? ` · 退款 ${fenLabel(Number(r.refundFee) || 0)}${r.refundId ? ` · 单号 ${r.refundId}` : ''}`
                      : ''}
                  </Text>
                  {r.decisionNote ? (
                    <Text className='page-admin__detail-line'>处理备注：{r.decisionNote}</Text>
                  ) : null}
                </View>
              )}
            </View>
          ))}

          {refunds.length === 0 && !refundLoading ? (
            <Text className='page-admin__tip'>
              {refundFilter === 'pending'
                ? '没有待核实的退款申请'
                : refundTotal > 0
                  ? '没有记录'
                  : '还没有人提交过退款申请'}
            </Text>
          ) : null}
        </View>
      ) : tab === 'vendors' ? (
        <View>
          <Text className='page-admin__meta'>
            停用某家后，新请求在发出去之前就会改用其它可用厂商（报告生成与问答都生效）。
            开关有 60 秒缓存，改完最迟一分钟内全网生效。
          </Text>

          {(vendors?.vendors || []).map((v) => (
            <View key={v.key} className='card page-admin__vendor'>
              <View className='page-admin__vendor-info'>
                <Text className='page-admin__vendor-name'>
                  {v.label}
                  {!v.ready ? <Text className='page-admin__badge page-admin__badge--warn'>未配 key</Text> : null}
                </Text>
                <Text className='page-admin__vendor-meta'>
                  {v.key} · {v.channel === 'cloudai' ? '腾讯云内置' : 'HTTP 直连'} ·{' '}
                  {v.enabled ? '启用中' : '已停用'}
                </Text>
              </View>
              <Switch
                checked={v.enabled}
                disabled={busyVendor === v.key}
                color='#5F33E1'
                onChange={(e) => void onToggleVendor(v.key, v.label, e.detail.value)}
              />
            </View>
          ))}

          {vendors?.updated_at ? (
            <Text className='page-admin__tip'>
              上次修改：{dayOf(vendors.updated_at)} · by {vendors.updated_by || '—'}
            </Text>
          ) : (
            <Text className='page-admin__tip'>还没有改过开关（当前全部启用）</Text>
          )}
        </View>
      ) : (
        <View>
          <Text className='page-admin__meta'>
            改动立刻作用于新订单（云端有 60 秒缓存，最迟一分钟生效）；用户端最多一天内看到新价。
            金额按元填写，最多两位小数。
          </Text>

          {!planState ? (
            <Text className='page-admin__tip'>读取中…</Text>
          ) : (
            <View>
              {planState.plans.map((p) => (
                <View key={p.id} className='card page-admin__plan'>
                  <View className='page-admin__plan-head'>
                    <Text className='page-admin__plan-name'>{p.name}</Text>
                    <Text className='page-admin__plan-meta'>
                      {p.days} 天 · 默认 {p.defaultPriceLabel}
                    </Text>
                  </View>
                  <View className='page-admin__plan-row'>
                    <Text className='page-admin__plan-label'>价格 ¥</Text>
                    <Input
                      className='page-admin__plan-input'
                      type='digit'
                      value={planDraft[p.id]?.yuan ?? ''}
                      onInput={(e) => onEditPlan(p.id, { yuan: e.detail.value })}
                    />
                  </View>
                  <View className='page-admin__plan-row'>
                    <Text className='page-admin__plan-label'>角标</Text>
                    <Input
                      className='page-admin__plan-input'
                      value={planDraft[p.id]?.badge ?? ''}
                      placeholder='留空则不显示'
                      onInput={(e) => onEditPlan(p.id, { badge: e.detail.value })}
                    />
                  </View>
                </View>
              ))}

              <View
                className={`page-admin__save${busyPlans ? ' page-admin__save--busy' : ''}`}
                onClick={() => void onSavePlans()}
              >
                {busyPlans ? '保存中…' : '保存价格'}
              </View>

              <Text className='page-admin__tip'>
                {planState.source === 'cloud'
                  ? `当前：云端价 · 上次修改 ${dayOf(planState.updated_at)} · by ${planState.updated_by || '—'}`
                  : '当前：构建期默认价（还没有在运维中心改过）'}
              </Text>
            </View>
          )}
        </View>
      )}

      {/*
        核实弹层。刻意用页面内弹层而不是 showModal(editable)：退回款要同时看
        「订单号 / 用户理由 / 实付金额」再填三项，弹窗装不下这些上下文。
      */}
      {deciding ? (
        <View className='page-admin__mask' onClick={closeDecide}>
          <View className='page-admin__sheet' onClick={(e) => e.stopPropagation()}>
            <Text className='page-admin__sheet-title'>
              {deciding.decision === 'approve' ? '核实后退款' : '拒绝退款申请'}
            </Text>
            <Text className='page-admin__sheet-sub'>
              {deciding.row.plan || '会员'} · 实付 {fenLabel(deciding.row.amountFen)} · …{deciding.row.openidTail}
            </Text>
            <Text className='page-admin__sheet-reason' selectable>
              用户理由：{deciding.row.reason || '（未填写）'}
            </Text>

            {deciding.decision === 'approve' ? (
              <View>
                <View className='page-admin__plan-row'>
                  <Text className='page-admin__plan-label'>退款 ¥</Text>
                  <Input
                    className='page-admin__plan-input'
                    type='digit'
                    value={decideFee}
                    placeholder={`留空 = 全额 ${fenLabel(deciding.row.amountFen)}`}
                    onInput={(e) => setDecideFee(e.detail.value)}
                  />
                </View>
                <View className='page-admin__plan-row'>
                  <Text className='page-admin__plan-label'>退款单号</Text>
                  <Input
                    className='page-admin__plan-input'
                    value={decideRefundId}
                    placeholder='选填（微信退款单号，便于事后对账）'
                    onInput={(e) => setDecideRefundId(e.detail.value)}
                  />
                </View>
              </View>
            ) : null}

            <Textarea
              className='page-admin__textarea'
              value={decideNote}
              maxlength={200}
              placeholder={
                deciding.decision === 'approve'
                  ? '处理备注（选填，只有运维能看到）'
                  : '拒绝理由（必填，用户会在订单页看到）'
              }
              onInput={(e) => setDecideNote(e.detail.value)}
            />
            <Text className='page-admin__counter'>{decideNote.length} / 200</Text>

            <View className='page-admin__sheet-actions'>
              <View className='page-admin__btn page-admin__btn--ghost' onClick={closeDecide}>
                取消
              </View>
              <View
                className={`page-admin__btn${busyDecide ? ' page-admin__btn--busy' : ''}`}
                onClick={() => void submitDecide()}
              >
                {busyDecide ? '处理中…' : deciding.decision === 'approve' ? '确认退款' : '确认拒绝'}
              </View>
            </View>

            <Text className='page-admin__sheet-tip'>
              {deciding.decision === 'approve'
                ? '点确认后立刻发起退款：订单转为已退款，已发放的会员天数按对账撤销。'
                : '拒绝后订单保持 paid，用户可以再次提交申请。'}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  )
}

function confirmBox(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    Taro.showModal({
      title,
      content,
      confirmText: '确定',
      cancelText: '取消',
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false)
    })
  })
}
