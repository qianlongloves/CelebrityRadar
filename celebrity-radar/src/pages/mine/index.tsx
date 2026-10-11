import { useState } from 'react'
import Taro, { useDidShow } from '@tarojs/taro'
import { View, Text, Button, Input, Image } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { ensureLogin, updateProfile } from '@/utils/auth'
import {
  clearLocalSettings,
  getPreferredTier,
  setPreferredTier,
  getPreferredProvider,
  setPreferredProvider
} from '@/utils/settings'
import { resolveChatSelection, listReadyVendors } from '@/utils/llm'
import type { ChatSelection, ReadyVendor } from '@/utils/llm'
import { publicConfig } from '@/config/public'
import type { LlmVendor, LlmQuality } from '@/config/public'
import { notifyConfigured, requestNotify } from '@/utils/notify'
import { clearAllMyData } from '@/utils/data-deletion'
import { listFollows } from '@/utils/follows'
import { listFavorites } from '@/utils/favorites'
import { listHistory, HISTORY_LIMIT } from '@/utils/history'
import { peekGenerateQuota, GenerateQuotaSummary } from '@/utils/quota'
import {
  FREE_FEATURES_NOTE,
  MEMBER_BENEFIT_POINTS,
  MEMBER_DAILY_ASK_LIMIT,
  MEMBER_DAILY_GENERATE_LIMIT,
  clearPromoDismiss
} from '@/utils/member'
import { clearWeeklyCache } from '@/utils/weekly'
import { clearMessageState } from '@/utils/messages'
import { clearQaUsage, qaUsageToday, refreshQaUsage } from '@/utils/qa'
import type { QaUsage } from '@/utils/qa'
import { useTabBarSync } from '@/utils/tabbar'
import { dayKey8 } from '@/utils/time'
import './index.scss'

/** 昵称长度上限（与 utils/auth.ts 的 NICKNAME_MAX 对齐） */
const NICKNAME_MAX = 20

/**
 * 会员到期日展示：ISO → yyyy-mm-dd。
 *
 * P2-36：按 **UTC+8** 取日期（`dayKey8`），不再按设备时区。到期时刻由云端按 UTC+8 落库，
 * 用设备时区去格式化它，UTC-5 的用户会在到期日当天看到「昨天已过期」；这正是上面那句
 * 「避免 toISOString 差一天」想解决的问题，只是当时选了设备时区、而不是产品口径。
 */
function formatDay(iso: string): string {
  return dayKey8(iso) || iso
}

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
  /** 今日生成配额（freemium 免费层）：null = 未登录或读取中 */
  const [genQuota, setGenQuota] = useState<GenerateQuotaSummary | null>(null)
  /**
   * 今日 AI 提问用量（云端 `ask_quota` 计数的本机镜像，见 utils/qa.ts#qaUsageToday）：
   * 与生成额度不同池，仅供用量展示。上限随会员状态变化（免费版与会员两档），
   * 故与已用次数一起从 qaUsageToday 取（口径收口在 utils/qa.ts，页面不自己相减）。
   */
  const [qaUsage, setQaUsage] = useState<QaUsage>(() => qaUsageToday(false))
  /**
   * 当前生效的「厂商 + 质量档」（2026-10-12 v3：厂商维度回归）。
   * 初值按**非会员**口径解析（配额还没读回来，此时确实只能走免费档），
   * loadCounts 拿到会员态后再按真实身份重算一次。
   * 与生成时 utils/llm.ts#resolveChatSelection 同源，页面展示不会和实际调用打架。
   */
  const [selection, setSelection] = useState<ChatSelection>(() => resolveChatSelection(false))
  /**
   * 厂商就绪清单（云端 action:'vendors' 只读返回）：null = 还没拉到 / 拉取失败，
   * 此时按「全部可选」渲染（网络抖动不能把选择器藏没）；拉到后只展示 ready 的厂。
   */
  const [readyVendors, setReadyVendors] = useState<ReadyVendor[] | null>(null)
  /**
   * 套餐用量卡是否展开：默认折叠。
   *
   * 折叠态只留「档位 + 两条用量数字 + 开通入口」，口径说明与会员权益清单在展开态。
   * 不落库也不记本机：这是「这次想看详情」的临时态，下次进页面回到折叠，
   * 否则上次的展开会变成所有人的默认首屏长度（用户反馈本卡文字太多、把「我的」撑得很长）。
   */
  const [quotaOpen, setQuotaOpen] = useState(false)

  /** 会员态：与生成上限出自同一次读数（见 loadCounts），模型档位解锁判定用它 */
  const isMember = !!genQuota?.member

  /**
   * 厂商清单：静态注册表来自 publicConfig.llm.vendors，运行时再用云端就绪状态过滤
   * （未配 key 的外部厂不展示；cloudbase 恒就绪）。readyVendors=null（未拉到）时全展示。
   *
   * `?? []` 是**防御**：正常构建里 llm.vendors 恒存在，但新旧包混用（页面按新结构读、
   * 公共配置还是旧结构）时会拿到 undefined，`undefined.map` 会把整页打成白屏 ——
   * 白屏把「配置读错」伪装成「页面坏了」，代价远大于选择器短暂为空。
   */
  const vendors: readonly LlmVendor[] = publicConfig.llm.vendors ?? []
  const visibleVendors = readyVendors
    ? vendors.filter((v) => readyVendors.some((r) => r.key === v.key && r.ready))
    : vendors

  /**
   * 质量档清单：来自 publicConfig.llm.qualities（基础 / 标准 / 高级）。
   * 类型显式收敛成 LlmQuality[]，与 utils/llm.ts#resolveChatSelection 读的是同一份；同样带 `?? []` 防御。
   */
  const qualities: readonly LlmQuality[] = publicConfig.llm.qualities ?? []

  /**
   * 拉厂商就绪清单（免口令只读，见 utils/llm.ts#listReadyVendors）。
   * 拉到后若本机存的厂商已不在就绪名单（典型：云端撤了 key），自动切回恒在的云开发 AI ——
   * 否则选择器里没有当前项、生成又必败，用户只会看到一句配置错误。
   */
  const refreshReadyVendors = async () => {
    const list = await listReadyVendors()
    if (!list) return
    setReadyVendors(list)
    const cur = getPreferredProvider()
    if (cur && cur !== publicConfig.llm.defaultVendor && !list.some((v) => v.key === cur && v.ready)) {
      setPreferredProvider(publicConfig.llm.defaultVendor)
      setSelection(resolveChatSelection(isMember))
      Taro.showToast({ title: '原选厂商暂未就绪，已切回云开发 AI', icon: 'none' })
    }
  }

  /**
   * 切换厂商（云开发 AI / DeepSeek / 智谱 / Kimi）：只写本机偏好，此后新生成的报告与问答生效。
   * 切换厂商不改变质量档选择（各家都是基础/标准/高级同一套）。
   */
  const chooseVendor = (v: LlmVendor) => {
    if (v.key === selection.vendor) {
      /* 显示与存储对齐（残留偏好被回落时顺手修正），与质量档同一做法 */
      if (getPreferredProvider() !== v.key) setPreferredProvider(v.key)
      return
    }
    setPreferredProvider(v.key)
    setSelection(resolveChatSelection(isMember))
    Taro.showToast({ title: `已切换到${v.label}`, icon: 'none' })
  }

  /**
   * 切换质量档（基础版 / 标准版 / 高级版）：只写本机偏好，下次生成生效。
   *
   * 会员专属档对免费用户不做「静默失败」：说清为什么不能用，并把人送到会员中心 ——
   * 这是「质」权益最直接的转化触点（用户正是在这里第一次发现「更强的模型要付费」）。
   * 真正的闸门在云函数 aiProxy（改包也绕不过，非会员一律落基础档），这里只负责把话说清楚。
   */
  const chooseQuality = async (q: LlmQuality) => {
    if (q.key === selection.quality) {
      /*
       * 已是当前生效档：若本机存的偏好与显示不一致（残留的会员档被回落成了基础版），
       * 顺手对齐 —— 否则「显示基础版、存着高级版」，续费后会毫无预兆地跳档。
       */
      if (getPreferredTier() !== q.key) setPreferredTier(q.key)
      return
    }
    if (q.memberOnly && !isMember) {
      const res = await Taro.showModal({
        title: '会员专属模型',
        content: `${q.label}仅会员可用：开通后即可在各厂商使用标准 / 高级模型，报告更完整、问答思考更深，已生成的报告不受影响`,
        confirmText: '去开通',
        cancelText: '再想想'
      })
      if (res.confirm) Taro.navigateTo({ url: '/pages/member/index' })
      return
    }
    setPreferredTier(q.key)
    setSelection(resolveChatSelection(isMember))
    Taro.showToast({ title: '已切换质量档', icon: 'none' })
  }

  const loadCounts = async () => {
    const uid = useAuth.getState().userId
    if (!uid) {
      setCounts({ follows: 0, favorites: 0, history: 0 })
      setGenQuota(null)
      /* 未登录按免费版口径展示：此时确实只能走免费额度 */
      setQaUsage(qaUsageToday(false))
      /* 模型展示同步回免费档：未登录时残留的强模型偏好不该被显示成「当前生效」 */
      setSelection(resolveChatSelection(false))
      return
    }
    /* 配额与列表并行取：配额失败不拖累列表展示（catch 内静默，卡片显示占位） */
    const quotaP = peekGenerateQuota(uid).catch(() => null)
    /* 提问用量也在云端（`ask_quota`）：先把本机镜像对齐，卡里两个数字才是同一时刻的读数。
       它内部读 auth store 的 userId、不依赖上面几个请求，故一并并行 */
    const askP = refreshQaUsage().catch(() => undefined)
    const [f, fav, h, quota] = await Promise.all([
      listFollows(),
      listFavorites(),
      listHistory(),
      quotaP,
      askP
    ])
    setCounts({ follows: f.length, favorites: fav.length, history: h.length })
    setGenQuota(quota)
    /* 上限按**同一份** quota 判定会员态：生成上限来自云端、提问上限来自会员权益表，
       两个数字必须出自同一次会员判定，否则会出现「卡里一半是会员口径、一半是免费口径」 */
    const askMember = !!quota?.member
    /* 会员态到手后重算模型展示：非会员即使本机残留强模型偏好，也要显示回落到免费档 */
    setSelection(resolveChatSelection(askMember))
    /* qaUsageToday 读的是刚被 askP 对齐过的镜像 ⇒ 这里已是云端口径 */
    setQaUsage(qaUsageToday(askMember))
  }

  /* 每次显示本页都重算：从关注列表取关、取消收藏、生成消耗配额后返回，数字都要跟着变。
     厂商就绪清单一并刷新（listReadyVendors 内部有缓存，不会每次打云函数） */
  useDidShow(() => {
    void loadCounts()
    void refreshReadyVendors()
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
    /* 清理本机设置（历史遗留密钥 + 模型偏好；云端那份偏好也一并复位）
       ⚠ 促销条关闭记忆不在这条链里（它属 member.ts 的展示策略，在那边清会成环依赖），故单独清 */
    clearLocalSettings()
    clearPromoDismiss()
    /* 供应商 / 档位偏好刚被清掉，界面同步回落到默认那家与免费档 */
    setSelection(resolveChatSelection(isMember))
    clearWeeklyCache()
    /* 消息已读基线也是本机数据：留着会让「清空后」的首页铃铛按旧基线判定未读 */
    clearMessageState()
    /* 问答用量同理：清掉本机镜像与连点时间。⚠ 云端 `ask_quota` 不清 ——
       额度挂在账号上，清本机数据不会重置今日提问次数（与生成配额同一口径） */
    clearQaUsage()
    void loadCounts()
    Taro.showToast({ title: ok ? '已清空全部数据' : '本地已清空，云端删除失败请稍后重试', icon: 'none' })
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

  /** 用量卡的分母与百分比：上限取配额摘要，未登录时用会员上限占位（仅用于渲染进度条） */
  const genLimit = genQuota?.limit ?? MEMBER_DAILY_GENERATE_LIMIT
  const genUsed = genQuota?.used ?? 0
  const genPct = genLimit > 0 ? Math.min(100, Math.round((genUsed / genLimit) * 100)) : 0
  const qaPct = qaUsage.limit > 0 ? Math.min(100, Math.round((qaUsage.used / qaUsage.limit) * 100)) : 0
  /**
   * AI 提问用量那一行的数字：一律如实报「已用 / 每日上限」。
   * 调试开关只松闸门、不参与展示（见 utils/debug.ts）—— 界面与真实用户所见逐字一致，
   * 不出现「不限次」这类字样，本地调到的样子就是上线后的样子。
   */
  const qaUsageText = `已用 ${qaUsage.used} / ${qaUsage.limit} 次`

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
                {/*
                  会员标识贴在昵称右侧（就是用户要求的「最上面卡片」）。
                  判定与下方用量卡同源（peekGenerateQuota → utils/member.ts），
                  所以两处显示的档位必然一致，不会出现「上面写会员、下面写免费」。
                */}
                <Text className={`page-mine__vip${genQuota?.member ? ' page-mine__vip--on' : ''}`}>
                  {genQuota?.member
                    ? genQuota.daysLeft > 0
                      ? `会员 · 剩 ${genQuota.daysLeft} 天`
                      : '会员'
                    : '免费版'}
                </Text>
                <Text className='page-mine__edit'>编辑</Text>
              </View>
              <Text className='page-mine__uid'>
                {genQuota?.member && genQuota.expiresAt
                  ? `会员有效期至 ${formatDay(genQuota.expiresAt)}`
                  : `ID ${userId.slice(0, 10)}…`}
              </Text>
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

      {/*
        当前套餐用量：透明展示「这个档位给了什么、今天用了多少」，
        是免费转付费的关键触点——配额用完时的报错文案与此处口径一致（utils/member.ts）。

        为什么按「用量」而不是「剩余」：剩余次数会让用户下意识去算「我还剩几次」，
        而用量（已用 / 上限）才是套餐的口径，也才能和续费 / 升级的预期对齐（用户要求）。
        两行分开而不是合并：报告生成的权威计数在云函数 quotaGuard（跨设备一致），
        AI 提问的权威计数在云端 `ask_quota`（见 utils/qa.ts，上限与生成不同池），
        合并成一个数字会让「换了手机额度变了」变成莫名其妙的 bug。

        折叠（用户反馈）：本卡此前把两条口径说明 + 会员权益清单全量铺开，长度接近一屏。
        现改为默认折叠 —— 折叠态是「档位 + 两条用量数字 + 开通入口」，说明与权益留在展开态。
        数字与入口在任何状态下都在，折叠的只是解释性长文，透明展示的口径一条没删。
      */}
      {userId && (
        <View className='card page-mine__quota'>
          <View className='page-mine__quota-head'>
            <Text className='page-mine__quota-title'>当前套餐用量</Text>
            <View className='page-mine__quota-head-right'>
              <Text className='page-mine__quota-tag'>{genQuota?.member ? '会员版' : '免费版'}</Text>
              {/* 折叠开关放在标题行：说明散在卡内多处，逐条挂「展开」会让每项都长出一个按钮。
                  用 View 而不是 Text：hoverClass 只在 View 上生效，小字热区靠 padding 撑开 */}
              <View
                className='page-mine__quota-fold'
                hoverClass='page-mine__quota-fold--tap'
                onClick={() => setQuotaOpen((v) => !v)}
              >
                <Text className='page-mine__quota-fold-text'>{quotaOpen ? '收起' : '展开说明'}</Text>
              </View>
            </View>
          </View>
          <Text className='page-mine__quota-note'>
            {genQuota?.member
              ? `会员权益生效中${
                  genQuota.expiresAt ? ` · 有效期至 ${formatDay(genQuota.expiresAt)}` : ''
                }${genQuota.daysLeft > 0 ? `（剩 ${genQuota.daysLeft} 天）` : ''}`
              : `免费版每日 ${genLimit} 次主动生成，开通会员提到 ${MEMBER_DAILY_GENERATE_LIMIT} 次`}
          </Text>

          <View className='page-mine__usage'>
            <View className='page-mine__usage-head'>
              <Text className='page-mine__usage-name'>报告生成</Text>
              {/* 用尽的红色标记只在**真的会被拦下**时给：调试开关放开额度时 remaining 仍会归 0
                  （数字照实），但闸门是开的，标红会让人以为不能生成了（见 utils/quota.ts 的 unlimited） */}
              <Text className={`page-mine__usage-value${genQuota && genQuota.remaining === 0 && !genQuota.unlimited ? ' page-mine__usage-value--out' : ''}`}>
                {genQuota ? `已用 ${genUsed} / ${genLimit} 次` : '读取中…'}
              </Text>
            </View>
            <View className='page-mine__usage-bar'>
              <View className='page-mine__usage-fill' style={{ width: `${genPct}%` }} />
            </View>
            {quotaOpen && (
              <Text className='page-mine__usage-note'>
                每日 0 点重置；缓存命中与生成失败都不计数，只有真拿到新报告才 +1（周报生成同样计入）
              </Text>
            )}
          </View>

          <View className='page-mine__usage'>
            <View className='page-mine__usage-head'>
              <Text className='page-mine__usage-name'>AI 提问</Text>
              <Text className='page-mine__usage-value'>{qaUsageText}</Text>
            </View>
            <View className='page-mine__usage-bar'>
              <View className='page-mine__usage-fill' style={{ width: `${qaPct}%` }} />
            </View>
            {/*
              两条都要与实现对齐，账目类文案说错，用户会认定是额度算错：
              ① 计数在**云端**（`ask_quota`，云函数 quotaGuard 的 ask 类）—— 不是「本机统计」了，
                 换设备后数字会跟着账号走；此处展示的是它的本机镜像（进页面已 refreshQaUsage 对齐）。
              ② 口径是「**成功拿到回答才计数**」：被额度拦下、机审命中、模型报错都不计数
                 （utils/qa.ts 只在成功分支 await noteQaUsed()）。此前这里写的是
                 「本机统计（发起即计，失败也算）」，两条都说反，已修正。
            */}
            {quotaOpen && (
              <Text className='page-mine__usage-note'>
                云端计数（回答成功才计数，被拦或失败不扣）· 与报告生成额度分开，不消耗生成次数；上限按会员等级区分
              </Text>
            )}
          </View>

          {/*
            会员权益介绍：紧跟在用量数字之后、开通入口之上 —— 用户刚看完「今天用了多少」，
            下一个问题必然是「会员到底多给什么」，所以介绍与入口之间不隔任何内容。
            权益点全部取自 utils/member.ts（单一事实源），页面里不手写数字，
            改额度只改权益表（此前这里只有一行 planNote，说不清买的是什么）。

            随口径说明一起折叠：四点权益逐条带说明，是本卡最长的一段。
            免费版不点「展开说明」时，升级理由由下面的「开通会员」入口那行承担
            （生成 / 提问两档上限 + 「查看等级权益与价格」），入口本身始终可见。
          */}
          {quotaOpen && !genQuota?.member && (
            <View className='page-mine__benefits'>
              <Text className='page-mine__benefits-title'>会员权益</Text>
              {MEMBER_BENEFIT_POINTS.map((b) => (
                <View key={b.title} className='page-mine__benefit'>
                  <Text className='page-mine__benefit-dot'>✓</Text>
                  <View className='page-mine__benefit-body'>
                    <Text className='page-mine__benefit-title'>{b.title}</Text>
                    <Text className='page-mine__benefit-note'>{b.note}</Text>
                  </View>
                </View>
              ))}
              <Text className='page-mine__benefits-foot'>{FREE_FEATURES_NOTE}</Text>
            </View>
          )}

          {/*
            会员中心入口：档位、价格、权益对比与支付按钮**全部搬到 pages/member**。
            本页只留一行入口 —— 三个档位铺在这里会把「我的」撑长，而真正要说清的
            「免费版 vs 会员」对比没有地方放（用户信息不足时不该被要求付钱）。
            会员态也保留入口（续费走同一个页面），只是文案改成「顺延」口径。
          */}
          <View
            className='page-mine__member-entry'
            hoverClass='page-mine__member-entry--tap'
            onClick={() => Taro.navigateTo({ url: '/pages/member/index' })}
          >
            <View className='page-mine__member-entry-main'>
              <Text className='page-mine__member-entry-title'>
                {genQuota?.member ? '续费会员' : '开通会员'}
              </Text>
              <Text className='page-mine__member-entry-note'>
                {genQuota?.member
                  ? '到期前续费按天顺延，不浪费剩余时长'
                  : `生成 ${MEMBER_DAILY_GENERATE_LIMIT} 次 / 提问 ${MEMBER_DAILY_ASK_LIMIT} 次 · 查看等级权益与价格`}
              </Text>
            </View>
            <Text className='page-mine__member-entry-arrow'>›</Text>
          </View>
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
        厂商 × 质量档（M7-4；2026-10-12 v3 厂商维度回归）：
        用户选「厂商（云开发 AI / DeepSeek / 智谱 / Kimi）× 质量档（基础 / 标准 / 高级）」，
        能力槽（报告 structured / 问答 reasoning）由云端按 purpose 裁决，端上不传模型名。
        端上不持有任何凭据；未配 key 的厂商经云端只读 action 'vendors' 上报后不展示。
      */}
      <View className='card page-mine__model'>
        <View className='page-mine__model-head'>
          <Text className='page-mine__model-title'>模型厂商与质量档</Text>
          <Text className='page-mine__model-current'>{selection.vendorLabel} · {selection.qualityLabel}</Text>
        </View>
        <Text className='page-mine__model-grouplabel'>厂商</Text>
        {/*
          厂商用「图标 + 卡片」排列（用户要求）：每行两张卡片，卡片内是厂商表情图标 + 名称 + 一句简介。
          比原先的整行列表更容易一眼扫出「有哪几家」，也把「换家 = 整组换」的语义做成并列的选项。
        */}
        <View className='page-mine__vendor-grid'>
          {visibleVendors.map((v) => (
            <View
              key={v.key}
              className={`page-mine__vendor-card${v.key === selection.vendor ? ' page-mine__vendor-card--on' : ''}`}
              hoverClass='page-mine__vendor-card--tap'
              onClick={() => chooseVendor(v)}
            >
              <View className='page-mine__vendor-icon'>{v.icon}</View>
              <Text className='page-mine__vendor-label'>{v.label}</Text>
              <Text className='page-mine__vendor-desc'>{v.desc}</Text>
            </View>
          ))}
        </View>
        <Text className='page-mine__model-grouplabel'>质量档</Text>
        <View className='page-mine__model-options'>
          {qualities.map((q) => {
            /* 会员专属档对免费用户显示「会员」标：先说清门槛，点了再给开通引导 */
            const locked = q.memberOnly && !isMember
            return (
              <View
                key={q.key}
                className={`page-mine__model-option${q.key === selection.quality ? ' page-mine__model-option--on' : ''}${locked ? ' page-mine__model-option--locked' : ''}`}
                onClick={() => void chooseQuality(q)}
              >
                <View className='page-mine__model-option-head'>
                  <Text className='page-mine__model-option-label'>{q.label}</Text>
                  {locked && <Text className='page-mine__model-lock'>会员</Text>}
                </View>
                <Text className='page-mine__model-option-desc'>{q.desc}</Text>
              </View>
            )
          })}
        </View>
        <Text className='page-mine__model-note'>免费版仅可用各厂商基础模型；标准版与高级版为会员权益。报告走结构化输出槽、AI 问答走推理槽；所选档缺槽时在同厂商内自动向下降档，不额外计费</Text>
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
