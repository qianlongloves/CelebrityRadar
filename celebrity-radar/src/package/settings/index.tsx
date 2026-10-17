import Taro from '@tarojs/taro'
import { View, Text } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { useConsent } from '@/stores/consent'
import { notifyConfigured, requestNotify } from '@/utils/notify'
import { clearAllMyData, deleteAccount } from '@/utils/data-deletion'
import { deleteCloudFile } from '@/utils/cloud'
import { exportMyDataToClipboard } from '@/utils/data-export'
import { clearLocalSettings, clearLocalSettingsCache } from '@/utils/settings'
import { clearPromoDismiss } from '@/utils/member'
import { clearWeeklyCache } from '@/utils/weekly'
import { clearMessageState } from '@/utils/messages'
import { clearInboxSeen } from '@/utils/inbox'
import { clearPickDismiss } from '@/utils/opinion-pick'
import { clearQaUsage } from '@/utils/qa'
import './index.scss'

/**
 * 系统设置（2026-10-17）：提醒授权 / 导出个人数据 / 清空数据 / 注销账号 收到一页。
 *
 * 为什么从「我的」页搬出来：「我的」首屏本来就被用量卡、模型选择、菜单列表三层内容叠满，
 * 而这一组动作**使用频率极低、后果却极重**，夹在「关注的名人 / 我的收藏 / 浏览历史」中间时，
 * 既容易被误触，也让人在翻菜单时反复看见几个不可恢复的红色入口。搬进独立页之后：
 *   · 「我的」页只留一个中性的「系统设置」入口，视线干净；
 *   · 破坏性操作在这里**并排且分级**（清空 / 注销各自说清删什么），要误点必须先进这一页。
 *
 * 本页**没有**「撤回同意」：它绑定「已同意」这一状态（只能撤回已给出的同意），
 * 留在「我的」页与隐私与免责相邻更合适。三者的区别见下方清空数据 / 注销的注释。
 *
 * ⚠ 页内每一项的动作函数**整体迁自 pages/mine**，口径未改；改动时请连注释一起看，
 * 尤其是注销的善后（必须用 clearLocalSettingsCache，不能用 clearLocalSettings）。
 */

/** 菜单项类型：danger 为破坏性操作，走警示色分级 */
type MenuItem = {
  icon: string
  iconBg: 'brand' | 'blue' | 'orange' | 'danger'
  title: string
  note: string
  danger?: boolean
  onTap: () => void
}

export default function Settings() {
  const { userId, avatarUrl } = useAuth()
  const consented = useConsent((s) => s.consented)

  /**
   * 订阅提醒授权入口。
   * 必须由点击直接触发：requestNotify 在第一个 await 之前就调用了
   * requestSubscribeMessage（微信要求授权请求出现在用户手势的同步调用栈里）。
   */
  const onSubscribeTap = async () => {
    const res = await requestNotify()
    Taro.showToast({ title: res.message, icon: 'none', duration: 2500 })
  }

  /**
   * 导出个人信息副本（PIPL 第 45 条「复制」）。
   *
   * 只读动作：把本人的关注 / 收藏 / 历史 / 监控与偏好拼成一份 JSON，复制到剪贴板。
   * 刻意不做「保存成文件」：小程序沙箱里要 saveFile + openDocument 两步，用户还得再去找文件；
   * 剪贴板可以直接粘进备忘录或聊天，零权限、够用。
   */
  const exportMyData = async () => {
    Taro.showLoading({ title: '整理中', mask: true })
    const res = await exportMyDataToClipboard()
    Taro.hideLoading()
    await Taro.showModal({
      title: res.ok ? '已复制到剪贴板' : '导出失败',
      content: res.message,
      showCancel: false
    })
  }

  /**
   * 清空我的数据：本地设置 + 云端（follows / favorites / history / keyword_watches / events，§六.6）。
   *
   * 与「注销账号」的区别（并排放在同一页，所以必须各说各的）：
   *   · 清空数据：只删内容，**账号与同意都保留**，之后可以继续用（额度照旧挂在账号上）；
   *   · 注销账号：连账号行一起删，登录态解除，不可恢复。
   */
  const clearMyData = async () => {
    const res = await Taro.showModal({
      title: '清空我的数据',
      content: '将清除本地偏好设置与缓存，并删除云端的关注、收藏、历史、监控与行为计数，不可恢复。',
      confirmText: '清除',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return
    const ok = await clearAllMyData()
    /* 清理本机设置（历史遗留密钥 + 模型偏好；云端那份偏好也一并复位）
       ⚠ 促销条关闭记忆不在这条链里（它属 member.ts 的展示策略，在那边清会成环依赖），故单独清 */
    clearLocalSettings()
    clearPromoDismiss()
    clearWeeklyCache()
    /* 消息已读基线也是本机数据：留着会让「清空后」的首页铃铛按旧基线判定未读 */
    clearMessageState()
    /* 风险信号的「上次查看」基线同属本机数据：一并清掉，清空后按「从未看过」重新计（见 utils/inbox） */
    clearInboxSeen()
    /* 舆情页冷启动推荐的「不用了」同属本机偏好：清掉后新的一轮仍会给出引导（避免留下一个看不见的决定） */
    clearPickDismiss()
    /* 问答用量同理：清掉本机镜像与连点时间。⚠ 云端 `ask_quota` 不清 ——
       额度挂在账号上，清本机数据不会重置今日提问次数（与生成配额同一口径） */
    clearQaUsage()
    /*
     * 这里**不**刷新「我的」页的模型选择器与计数：那些是 pages/mine 的 state，
     * 而它 useDidShow 里的 loadCounts 每次显隐都会重算（含 setSelection）——
     * 返回时自然对齐，跨页去戳别人的 state 反而是新的耦合。
     */
    Taro.showToast({ title: ok ? '已清空全部数据' : '本地已清空，云端删除失败请稍后重试', icon: 'none' })
  }

  /**
   * 注销账号（P0 合规项）：删除云端**全部个人信息**并解除登录态，是隐私政策
   * 「通过『我的 → 系统设置 → 注销账号』可注销账号」承诺的实际入口。
   *
   * 不可逆，故**两次确认**；云端删除集中在云函数 `userInit(action:'deleteAccount')`，
   * 端上只负责确认、发起与善后。
   *
   * ⚠ 善后必须用 `clearLocalSettingsCache`（只清本机）而**不是** `clearLocalSettings`：
   * 后者会把默认配置推回 `userInit.set`，其内部 `ensure()` 会把刚删掉的 users 行**重建回来**，
   * 等于注销没生效。此处也不能再调用任何会写 `users` 的接口。
   */
  const cancelAccount = async () => {
    const first = await Taro.showModal({
      title: '注销账号',
      content: '注销后将删除你的关注、收藏、历史、监控与全部个人信息，订单按法律规定去标识化留存。此操作不可恢复。',
      confirmText: '继续',
      confirmColor: '#EF4444'
    })
    if (!first.confirm) return
    const second = await Taro.showModal({
      title: '确认注销？',
      content: '再次确认：账号注销后不可恢复，将立即退出登录。',
      confirmText: '确认注销',
      confirmColor: '#EF4444'
    })
    if (!second.confirm) return

    Taro.showLoading({ title: '注销中', mask: true })
    const res = await deleteAccount()
    Taro.hideLoading()
    if (!res.ok) {
      Taro.showToast({ title: res.message ?? '注销失败，请稍后重试', icon: 'none' })
      return
    }

    /* 云端已删：头像云文件不在云函数的删除清单里，这里顺手删掉，避免个人信息残留 */
    if (avatarUrl && avatarUrl.indexOf('cloud://') === 0) void deleteCloudFile(avatarUrl)
    useAuth.getState().clearLogin()
    clearLocalSettingsCache()
    /* 注销 = 彻底解除关系：同意记录一并撤销（走 store，撤后 app 会即时重现同意网关） */
    useConsent.getState().withdraw()
    clearPromoDismiss()
    clearWeeklyCache()
    clearMessageState()
    clearInboxSeen()
    clearPickDismiss()
    clearQaUsage()
    Taro.showToast({ title: '账号已注销', icon: 'none' })
    /*
     * 注销后留在本页是个死胡同：页面上的项已随登录态消失（本页全部依赖账号），
     * 用户只能自己找返回。回「我的」是唯一有意义的落点 —— 那里正显示未登录态。
     * 栈底进不来这一页时（分享 / 旧链接）navigateBack 会失败，故兜底切回 tab。
     */
    Taro.navigateBack().catch(() => void Taro.switchTab({ url: '/pages/mine/index' }))
  }

  const menus: MenuItem[] = [
    {
      /*
        微信一次性订阅的规则是「授权一次只够推一条」，所以文案写「提醒一次」
        而不是做成常亮开关 —— 开关会让人以为打开后就一直有推送。
        未配置模板 ID 时点击只给指引，见 utils/notify.ts 的 notifyConfigured。

        「关注的人 / 我盯的事」两种都要写：同一位授权同时覆盖「我盯（跟进）的事件有新进展」（E1），
        只写关注会让人以为盯的事不在提醒范围内 —— 而「盯事」正是这个产品的主线动词。
      */
      icon: '🔔',
      iconBg: 'brand',
      title: '更新提醒',
      note: notifyConfigured() ? '关注的人 / 我盯的事 · 授权一次一条' : '未配置订阅模板',
      onTap: () => void onSubscribeTap()
    },
    {
      /* PIPL 第 45 条「查阅、复制」：查阅已有各页，这里补齐「把副本带走」 */
      icon: '📤',
      iconBg: 'brand',
      title: '导出个人数据',
      note: userId ? '复制 JSON 副本到剪贴板' : '登录后可用',
      onTap: () => void exportMyData()
    },
    {
      /* §四 合规阻塞项：声明页承诺「可删除云端数据」，此处提供实际入口 */
      icon: '🗑',
      iconBg: 'danger',
      title: '清空数据',
      note: '删除云端关注 / 收藏 / 历史（账号保留）',
      danger: true,
      onTap: () => void clearMyData()
    },
    /* 注销账号：隐私政策承诺的入口（P0）。仅登录后展示 —— 未登录没有账号可注销 */
    ...(userId
      ? [
          {
            icon: '⚠️',
            iconBg: 'danger' as const,
            title: '注销账号',
            note: '删除全部个人信息并退出登录',
            danger: true,
            onTap: () => void cancelAccount()
          }
        ]
      : [])
  ]

  return (
    <View className='page-settings'>
      <View className='card page-settings__menus'>
        {menus.map((m) => (
          <View
            key={m.title}
            className={`page-settings__menu${m.danger ? ' page-settings__menu--danger' : ''}`}
            onClick={m.onTap}
          >
            <View className={`page-settings__menu-icon page-settings__menu-icon--${m.iconBg}`}>{m.icon}</View>
            <View className='page-settings__menu-info'>
              <Text className='page-settings__menu-title'>{m.title}</Text>
              <Text className='page-settings__menu-note'>{m.note}</Text>
            </View>
            <Text className='page-settings__menu-arrow'>›</Text>
          </View>
        ))}
      </View>

      {/*
        底部把这几个动作的关系一次说清：它们的名字（清空 / 注销 / 撤回）都比实际后果温和，
        并排放在一页里最容易被当成同一件事。这里给的是**区别**，不是免责声明。
      */}
      <Text className='page-settings__foot'>
        清空数据只删内容，账号与授权都保留；注销账号会连账号一并删除，不可恢复
        {consented ? '；想撤回隐私授权请到「我的 → 撤回同意」' : ''}。
      </Text>
    </View>
  )
}
