import Taro, { useLoad } from '@tarojs/taro'
import { useState } from 'react'
import { View, Text, Input, Switch } from '@tarojs/components'
import {
  adminMe,
  adminListUsers,
  adminGetUser,
  adminGrantMember,
  adminRevokeMember,
  adminListVendors,
  adminSetVendor,
  type AdminUserRow,
  type AdminUserDetail,
  type AdminVendorState
} from '@/utils/admin'
import './index.scss'

/**
 * 运维中心（2026-10-18，超管专用）
 *
 * 两件事：
 *   ① **用户**：按昵称 / openid 找人，看他的会员与配额，直接改会员（发放 / 撤销）；
 *   ② **模型**：把某家大模型厂商临时停用 —— 欠费、被风控、上游持续 5xx 时先止血，
 *      云端会在发请求之前跳过它并回落到可用的一家，不需要改代码、不需要重新部署。
 *
 * ⚠ 三处刻意的设计：
 *   · **鉴权在服务端**：本页的 `isAdmin` 只决定「要不要显示」。改包把入口强开，云函数照样拒 ——
 *     端上的判断永远只是体验，不是权限。
 *   · **会员只有一条写路**：本页不直接写 `memberships`，而是让云函数代理到 payCallback。
 *     两个写口意味着两份真相，迟早对不上。
 *   · **不许把厂商全停**：服务端强制至少留一家。这条约束必须落在服务端 ——
 *     端上的按钮可以被绕过，而「全停」的后果是全站生成与问答立刻失败。
 */

type Tab = 'users' | 'vendors'

const PAGE_SIZE = 20
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
      <View className='page-admin__tabs'>
        <View
          className={`page-admin__tab${tab === 'users' ? ' page-admin__tab--on' : ''}`}
          onClick={() => setTab('users')}
        >
          用户
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
      ) : (
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
      )}
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
