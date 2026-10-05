import { useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { View, Text, Button, Input, Image } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { ensureLogin, updateProfile } from '@/utils/auth'
import { clearSearchKey, getBochaKey, getLlmKey, setBochaKey, setLlmKey } from '@/utils/settings'
import { fetchNews } from '@/utils/search'
import { chatText, hasLlmChannel } from '@/utils/llm'
import { probeAiProxy } from '@/utils/ai-proxy'
import { notifyConfigured, requestNotify } from '@/utils/notify'
import { clearAllMyData } from '@/utils/data-deletion'
import { listFollows } from '@/utils/follows'
import { listFavorites } from '@/utils/favorites'
import { listHistory, HISTORY_LIMIT } from '@/utils/history'
import { useTabBarSync } from '@/utils/tabbar'
import './index.scss'

/** 昵称长度上限（与 utils/auth.ts 的 NICKNAME_MAX 对齐） */
const NICKNAME_MAX = 20

export default function Mine() {
  useTabBarSync()
  const { userId, nickname, avatarUrl, error } = useAuth()
  /** 昵称编辑态：点昵称/「编辑」展开内联编辑行 */
  const [editingNick, setEditingNick] = useState(false)
  const [nickDraft, setNickDraft] = useState('')
  /** 保存中：防连点导致重复上传 / 重复写库 */
  const [saving, setSaving] = useState(false)
  /** 登录在途：按钮 loading，防连点重复建行 */
  const [logging, setLogging] = useState(false)
  /** 菜单概览计数：三个列表接口都是「上限 50 条全量拉取」，此处只取 length 做概览 */
  const [counts, setCounts] = useState({ follows: 0, favorites: 0, history: 0 })
  /** 联网能力（博查搜索 / 大模型）配置态：仅存本机 storage，是报告生成链路的前置条件 */
  const [keys, setKeys] = useState({ bocha: false, llm: false })
  const [bochaDraft, setBochaDraft] = useState('')
  const [llmDraft, setLlmDraft] = useState('')
  const [testing, setTesting] = useState(false)

  const syncKeys = () => setKeys({ bocha: getBochaKey() !== null, llm: getLlmKey() !== null })

  const loadCounts = async () => {
    if (!useAuth.getState().userId) {
      setCounts({ follows: 0, favorites: 0, history: 0 })
      return
    }
    const [f, fav, h] = await Promise.all([listFollows(), listFavorites(), listHistory()])
    setCounts({ follows: f.length, favorites: fav.length, history: h.length })
  }

  /* 每次显示本页都重算：从关注列表取关、或在收藏页取消收藏后返回，数字要跟着变 */
  useDidShow(() => {
    syncKeys()
    void loadCounts()
  })

  /**
   * 微信一键登录。
   *
   * 云开发下 openid 由 wx.cloud 隐式携带，无需 wx.login 换 code；
   * 这里做的是「读自己的 users 行 → 没有则建 → 取回 _openid」，
   * 首次登录会把 created_at / last_seen_at 落库，即完成用户信息保存。
   *
   * ensureLogin 内部已 catch（失败写 store.error），此处只负责按钮态。
   */
  const doLoginByTap = async () => {
    if (logging) return
    setLogging(true)
    useAuth.getState().setError(null)
    try {
      await ensureLogin()
      if (useAuth.getState().userId) {
        void loadCounts()
        Taro.showToast({ title: '登录成功，可点上方头像设置微信头像', icon: 'none' })
      }
    } finally {
      setLogging(false)
    }
  }

  /** 清空我的数据：本地设置 + 云端（follows / favorites / history，§六.6） */
  const clearMyData = async () => {
    const res = await Taro.showModal({
      title: '清空我的数据',
      content: '将清除本地偏好设置与缓存，并删除云端的关注、收藏、历史记录，不可恢复。',
      confirmText: '清除',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    const ok = await clearAllMyData()
    /* 本机联网凭据一并清理（含旧 Tavily 残留），避免旧设备读到陈旧 key */
    clearSearchKey()
    setLlmKey(null)
    syncKeys()
    void loadCounts()
    Taro.showToast({ title: ok ? '已清空全部数据' : '本地已清空，云端删除失败请稍后重试', icon: 'none' })
  }

  /** 保存联网 Key：只写入非空项（留空 = 不改动），清除统一走「清除」按钮，避免误清另一枚 */
  const saveKeys = () => {
    const nextBocha = bochaDraft.trim()
    const nextLlm = llmDraft.trim()
    if (!nextBocha && !nextLlm) {
      Taro.showToast({ title: '请先粘贴需要保存的 Key', icon: 'none' })
      return
    }
    if (nextBocha) setBochaKey(nextBocha)
    if (nextLlm) setLlmKey(nextLlm)
    setBochaDraft('')
    setLlmDraft('')
    syncKeys()
    Taro.showToast({ title: '已保存到本机', icon: 'success' })
  }

  /** 清除本机联网凭据：报告生成会随之不可用，故二次确认 */
  const clearKeys = async () => {
    const res = await Taro.showModal({
      title: '清除联网 Key',
      content:
        '将删除本机保存的博查搜索 Key 与大模型 Key。两项都会回落到平台额度（若平台已配置）。',
      confirmText: '清除',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    setBochaKey(null)
    setLlmKey(null)
    setBochaDraft('')
    setLlmDraft('')
    syncKeys()
    Taro.showToast({ title: '已清除', icon: 'none' })
  }

  /**
   * 连通性自检：两条链路各真实发一次请求。
   * 必要性：博查 401/403（密钥无效 / 未绑资源包）与大模型 401 在报告页只表现为一句「生成失败」，
   * 在这里提前暴露具体原因，避免误判成「报告功能坏了」。博查只取 3 条以省额度。
   *
   * 两行走的都是报告页的真实链路（配了本机 Key 就直连，否则走平台代付），
   * 所以它们是「报告能不能生成」的直接预演；行首按实际走的通道标「本机 / 平台」，
   * 免得看到「失败」时误以为该去改 Key，其实只是平台额度没配。
   */
  const testConnectivity = async () => {
    if (testing) return
    setTesting(true)
    Taro.showLoading({ title: '测试中', mask: true })
    const lines: string[] = []
    /* 通道名必须前置取值：fetchNews 内部自行选通道，调用后无法从返回值反推 */
    const via = getBochaKey() !== null ? '本机' : '平台'
    try {
      const news = await fetchNews('雷军', { maxResults: 3 })
      lines.push(news === null ? `${via}·博查：通道不可用` : `${via}·博查：可用（返回 ${news.length} 条）`)
    } catch (err) {
      lines.push(`${via}·博查：失败 —— ${err instanceof Error ? err.message : String(err)}`)
    }
    const llmVia = getLlmKey() !== null ? '本机' : '平台'
    const llm = await chatText('你是连通性测试助手，只回复两个字：正常', '连通性测试')
    lines.push(
      llm.ok
        ? `${llmVia}·大模型：可用（返回「${llm.text.slice(0, 12)}」）`
        : `${llmVia}·大模型：失败 —— ${llm.error}`
    )
    lines.push(...(await probeAiProxy()))
    Taro.hideLoading()
    setTesting(false)
    await Taro.showModal({ title: '连通性测试结果', content: lines.join('\n'), showCancel: false })
  }

  /**
   * 保存资料：昵称与头像共用一个出口（都是 users 行的 patch）。
   * 失败只 toast 不抛，避免打断用户后续操作。
   */
  const saveProfile = async (
    patch: { nickname?: string; avatarTempPath?: string },
    okText: string
  ): Promise<boolean> => {
    if (saving) return false
    setSaving(true)
    Taro.showLoading({ title: '保存中', mask: true })
    const res = await updateProfile(patch)
    Taro.hideLoading()
    setSaving(false)
    if (res.ok) {
      Taro.showToast({ title: okText, icon: 'success' })
      return true
    }
    Taro.showToast({ title: res.message ?? '保存失败', icon: 'none' })
    return false
  }

  /**
   * 选头像（open-type=chooseAvatar）。
   * 微信返回的是 wxfile:// 临时路径，必须立刻上传云存储换 fileID，否则冷启后裂图。
   * 事件类型随 Taro 版本变动，此处按微信文档的 detail.avatarUrl 取字段。
   */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const onChooseAvatar = (e: any) => {
    const tempPath: string | undefined = e?.detail?.avatarUrl
    if (!tempPath) return
    void saveProfile({ avatarTempPath: tempPath }, '头像已更新')
  }

  const openNickEditor = () => {
    setNickDraft(nickname ?? '')
    setEditingNick(true)
  }

  const submitNick = async () => {
    const next = nickDraft.trim()
    if (!next) {
      Taro.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }
    if (next === nickname) {
      setEditingNick(false)
      return
    }
    if (await saveProfile({ nickname: next }, '昵称已更新')) setEditingNick(false)
  }

  /**
   * 订阅提醒授权入口。
   * 必须由点击直接触发：requestNotify 在第一个 await 之前就调用了
   * requestSubscribeMessage（微信要求授权请求出现在用户手势的同步调用栈里）。
   */
  const onSubscribeTap = async () => {
    const res = await requestNotify()
    Taro.showToast({ title: res.message, icon: 'none', duration: 2500 })
  }

  /** 菜单项类型：danger 为破坏性操作，走警示色分级 */
  type MenuItem = {
    icon: string
    iconBg: 'brand' | 'blue' | 'orange' | 'danger'
    title: string
    note: string
    danger?: boolean
    onTap: () => void
  }

  const menus: MenuItem[] = [
    {
      icon: '🤝',
      iconBg: 'blue',
      title: '关注的名人',
      note: userId ? `${counts.follows} 位` : '登录后查看',
      onTap: () => Taro.navigateTo({ url: '/pages/following/index' })
    },
    {
      icon: '⭐',
      iconBg: 'brand',
      title: '我的收藏',
      note: userId ? `${counts.favorites} 条` : '名言 / 报告',
      /* 二级页（navigateTo）⇒ 导航栏带返回按钮，不再是 tab 页的 switchTab */
      onTap: () => Taro.navigateTo({ url: '/pages/records/index' })
    },
    {
      icon: '🕘',
      iconBg: 'blue',
      title: '浏览历史',
      note: userId ? `${counts.history} 条` : `最近 ${HISTORY_LIMIT} 条`,
      onTap: () => Taro.navigateTo({ url: '/pages/history/index' })
    },
    {
      /*
        微信一次性订阅的规则是「授权一次只够推一条」，所以文案写「提醒一次」
        而不是做成常亮开关 —— 开关会让人以为打开后就一直有推送。
        未配置模板 ID 时点击只给指引，见 utils/notify.ts 的 notifyConfigured。
      */
      icon: '🔔',
      iconBg: 'brand',
      title: '关注更新提醒',
      note: notifyConfigured() ? '授权一次 · 提醒一次' : '未配置订阅模板',
      onTap: () => void onSubscribeTap()
    },
    {
      icon: '🛡',
      iconBg: 'orange',
      title: '隐私与免责',
      note: '隐私清单 · 免责文案',
      onTap: () => Taro.navigateTo({ url: '/pages/agreement/index' })
    },
    {
      /* §四 合规阻塞项：声明页承诺「可删除云端数据」，此处提供实际入口 */
      icon: '🗑',
      iconBg: 'danger',
      title: '清空数据',
      note: '删除云端关注 / 收藏 / 历史',
      danger: true,
      onTap: () => void clearMyData()
    }
  ]

  return (
    <View className='page-mine glow-page safe-tab'>
      {/* 未登录走纵向引导布局，已登录走「头像 + 资料」横排 */}
      <View className={`page-mine__banner${userId ? '' : ' page-mine__banner--guest'}`}>
        {userId ? (
          <>
            {/* 头像：open-type=chooseAvatar 是微信现行唯一可取头像的方式（getUserProfile 已收回） */}
            <Button
              className='page-mine__avatar-btn'
              openType='chooseAvatar'
              hoverClass='none'
              onChooseAvatar={onChooseAvatar}
            >
              {avatarUrl ? (
                <Image className='page-mine__avatar-img' src={avatarUrl} mode='aspectFill' />
              ) : (
                <View className='page-mine__avatar'>{(nickname || '微').slice(0, 1)}</View>
              )}
            </Button>
            <View className='page-mine__info'>
              <View className='page-mine__name-row' onClick={openNickEditor}>
                <Text className='page-mine__name'>{nickname || '名人观察员'}</Text>
                <Text className='page-mine__edit'>编辑</Text>
              </View>
              <Text className='page-mine__uid'>ID {userId.slice(0, 10)}…</Text>
            </View>
          </>
        ) : (
          <View className='page-mine__login'>
            <Text className='page-mine__login-title'>未登录</Text>
            <Text className='page-mine__login-desc'>登录后可同步收藏、关注与浏览历史</Text>
            <Button
              className='page-mine__login-btn'
              hoverClass='none'
              loading={logging}
              onClick={() => void doLoginByTap()}
            >
              微信一键登录
            </Button>
            <Text className='page-mine__login-tip'>首次登录自动创建账号，无需注册</Text>
          </View>
        )}
      </View>

      {/*
        昵称编辑用页面内 <Input type="nickname">，而非 Taro.showModal({editable})：
        只有原生 input 的 nickname 类型才会在键盘上方给出「使用微信昵称」快捷填充。
      */}
      {userId && editingNick && (
        <View className='page-mine__editor'>
          <Input
            className='page-mine__editor-input'
            type='nickname'
            value={nickDraft}
            maxlength={NICKNAME_MAX}
            placeholder='输入昵称，或点击键盘上方的微信昵称'
            onInput={(e) => setNickDraft(e.detail.value)}
          />
          <View className='page-mine__editor-actions'>
            <View className='page-mine__editor-btn' onClick={() => setEditingNick(false)}>
              <Text>取消</Text>
            </View>
            <View
              className='page-mine__editor-btn page-mine__editor-btn--primary'
              onClick={() => void submitNick()}
            >
              <Text>保存</Text>
            </View>
          </View>
        </View>
      )}

      {error && (
        <View className='page-mine__error' onClick={() => void doLoginByTap()}>
          <Text>⚠ {error}</Text>
          <Text className='page-mine__error-action'>点击重试</Text>
        </View>
      )}

      <View className='card page-mine__menus'>
        {menus.map((m) => (
          <View
            key={m.title}
            className={`page-mine__menu${m.danger ? ' page-mine__menu--danger' : ''}`}
            onClick={m.onTap}
          >
            <View className={`page-mine__menu-icon page-mine__menu-icon--${m.iconBg}`}>{m.icon}</View>
            <View className='page-mine__menu-info'>
              <Text className='page-mine__menu-title'>{m.title}</Text>
              <Text className='page-mine__menu-note'>{m.note}</Text>
            </View>
            <Text className='page-mine__menu-arrow'>›</Text>
          </View>
        ))}
      </View>

      {/*
        联网能力配置：报告 = 「博查搜索取素材 + 大模型按模板生成」。
        两步都已支持平台代付（云函数 aiProxy，用户零配置），故两个 Key 都是「可选」：
        不填就用平台额度，填了就走自己账号直连（BYOK，费用自负）。
        「是否就绪」看的是通道而不是本机 Key —— 一个 Key 都没填也能生成报告。
      */}
      <View className='card page-mine__keys'>
        <View className='page-mine__keys-head'>
          <Text className='page-mine__keys-title'>联网能力</Text>
          <Text
            className={`page-mine__keys-badge${hasLlmChannel() ? ' page-mine__keys-badge--on' : ''}`}
          >
            {hasLlmChannel() ? '已就绪' : '待配置'}
          </Text>
        </View>
        <Text className='page-mine__keys-desc'>
          报告由「博查搜索取公开素材 + 大模型按模板生成」两步完成。两步默认都使用平台额度，无需配置；
          填入自己的 Key 则改走本机直连 —— 以下 Key 仅存本机，不上传云端。
        </Text>

        <View className='page-mine__key-field'>
          <View className='page-mine__key-label'>
            <Text>博查搜索 Key（可选）</Text>
            <Text className={`page-mine__key-state${keys.bocha ? ' page-mine__key-state--on' : ''}`}>
              {keys.bocha ? '已配置' : '使用平台额度'}
            </Text>
          </View>
          <Input
            className='page-mine__editor-input'
            value={bochaDraft}
            placeholder='留空即用平台额度；填入则走自己的博查账号'
            onInput={(e) => setBochaDraft(e.detail.value)}
          />
        </View>

        <View className='page-mine__key-field'>
          <View className='page-mine__key-label'>
            <Text>大模型 Key（可选）</Text>
            <Text className={`page-mine__key-state${keys.llm ? ' page-mine__key-state--on' : ''}`}>
              {keys.llm ? '本机直连' : '使用平台额度'}
            </Text>
          </View>
          <Input
            className='page-mine__editor-input'
            value={llmDraft}
            placeholder='留空即用平台额度；填入则走自己的模型账号'
            onInput={(e) => setLlmDraft(e.detail.value)}
          />
        </View>

        <View className='page-mine__editor-actions'>
          <View className='page-mine__editor-btn' onClick={() => void clearKeys()}>
            <Text>清除</Text>
          </View>
          <View className='page-mine__editor-btn' onClick={() => void testConnectivity()}>
            <Text>{testing ? '测试中…' : '测试连通性'}</Text>
          </View>
          <View className='page-mine__editor-btn page-mine__editor-btn--primary' onClick={saveKeys}>
            <Text>保存</Text>
          </View>
        </View>
      </View>

      <View className='card' style={{ padding: '8rpx 0' }}>
        {/* 内容举报 / 反馈：微信客服会话（open-type=contact），需在小程序后台开通客服 */}
        <Button className='page-mine__contact' openType='contact' hoverClass='none'>
          <Text>内容举报 / 反馈</Text>
          <Text className='page-mine__contact-note'>名誉投诉核实后下线对应内容</Text>
        </Button>
      </View>

      {/* 隐私说明：昵称头像为「可选授权」，用户不设置也能正常使用 */}
      <Text className='page-mine__tip'>昵称与头像为可选设置，仅用于本机展示，不设置不影响使用</Text>
    </View>
  )
}
