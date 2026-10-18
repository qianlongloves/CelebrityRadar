import Taro, { useLoad } from '@tarojs/taro'
import { useState } from 'react'
import { View, Text } from '@tarojs/components'
import { useAuth } from '@/stores/auth'
import { useConsent } from '@/stores/consent'
import { hasConsented } from '@/utils/consent'
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
import { adminMe } from '@/utils/admin'
import './index.scss'

/**
 * 系统设置（2026-10-17）：提醒授权 / 导出个人数据 / 清空数据 / 撤回同意 / 注销账号 收到一页。
 *
 * 为什么从「我的」页搬出来：「我的」首屏本来就被用量卡、模型选择、菜单列表三层内容叠满，
 * 而这一组动作**使用频率极低、后果却极重**，夹在「关注的名人 / 我的收藏 / 浏览历史」中间时，
 * 既容易被误触，也让人在翻菜单时反复看见几个不可恢复的红色入口。搬进独立页之后：
 *   · 「我的」页只留一个中性的「系统设置」入口，视线干净；
 *   · 破坏性操作在这里**并排且分级**（清空 / 撤回 / 注销各自说清删什么），要误点必须先进这一页。
 *
 * 「撤回同意」（PIPL 第 15 条）2026-10-17 也迁进来了：此前留在「我的」页，理由是「离授权说明
 * 越近越好」；但它与清空 / 注销是**同一组重后果动作**，分散在两页反而让人只找到其中一个。
 * 三者的区别见下方各自注释与页脚那一行。
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
   * 超管标记（2026-10-18）：只用来决定「运维中心」这一行显不显示。
   *
   * 判据在服务端（云函数 adminConsole 的 openid 白名单），这里拿到的只是一个渲染开关 ——
   * 改包把它强开也没用，云函数会拒。失败一律当作「不是超管」：普通用户看到陌生入口
   * 比看不到更糟（会点进去，然后看到「无权访问」）。
   */
  const [isAdmin, setIsAdmin] = useState(false)
  useLoad(() => {
    void adminMe().then((res) => {
      if (res.ok && res.isAdmin) setIsAdmin(true)
    })
  })

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
      content:
        '将清除本机偏好与缓存，并删除云端的关注、收藏、历史、监控与行为记录，不可恢复。账号、会员与剩余次数不受影响。',
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

  /**
   * 撤回同意（PIPL 第 15 条：个人有权撤回同意，处理者应提供**便捷**的撤回方式）。
   *
   * 与「清空数据」「注销账号」的区别：
   *   · 清空数据：只删内容，账号与同意**都保留**；
   *   · 撤回同意：撤销授权 → **停止处理**（删云端个人数据 + 退出登录 + 清本机）→ 回到「未同意」态；
   *   · 注销账号：在撤回的基础上，连账号行本身一并删除。
   *
   * 撤回即失去处理依据，故基于该同意收集的数据（关注 / 收藏 / 历史 / 监控 / 埋点）**一并删除**；
   * 订单按法定留存要求不在此动作内（走注销的去标识化路径）。撤回经 store（`withdraw`），
   *
   * 2026-10-18 明确两处**刻意保留**（用户追问过「花钱买的会员会不会被一起清掉」）：
   *   · `memberships`（会员档位 / 到期时间）—— 用户已经付费，撤回同意不该吞掉已购买的服务；
   *   · 四张用量表（generate / ask / refresh / ai_calls）—— 防「撤回 → 重登」重置当日额度。
   * 两者都不在 clearAllMyData 的清单里，users 行本身也留着（下次登录 ensure 复用同一行）。
   * 代价是撤回后仍留下两条「openid ↔ 状态」的记录 —— 这是实现与「停止处理」之间的取舍，
   * 所以弹窗文案如实写明「会员与剩余次数不受影响」，不让用户自己猜。真正连会员一起删的只有注销。
   * 使 app.tsx 即时重现同意网关 —— 撤回后不会出现「没同意却还能用 / 还能再登录」的漏洞。
   */
  const withdrawConsent = async () => {
    const res = await Taro.showModal({
      title: '撤回同意',
      content:
        '撤回后将停止处理你的个人信息并退出登录，关注、收藏、历史、监控与行为记录连同本机缓存一并删除，不可恢复。已购买的会员与剩余次数不受影响；重新同意并登录后可继续使用。',
      confirmText: '撤回',
      confirmColor: '#EF4444'
    })
    if (!res.confirm) return

    Taro.showLoading({ title: '处理中', mask: true })
    /* 先删云端个人数据（要用到登录态，故在清登录之前）；删除属于「停止处理」，即便失败也继续退出 */
    const ok = await clearAllMyData()
    Taro.hideLoading()

    if (avatarUrl && avatarUrl.indexOf('cloud://') === 0) void deleteCloudFile(avatarUrl)
    useAuth.getState().clearLogin()
    clearLocalSettingsCache()
    clearPromoDismiss()
    clearWeeklyCache()
    clearMessageState()
    clearInboxSeen()
    clearPickDismiss()
    clearQaUsage()
    /* 撤销同意（走 store）：app.tsx 订阅到变化 → 同意网关即时重现 */
    useConsent.getState().withdraw()
    Taro.showToast({ title: ok ? '已撤回同意' : '已退出登录，云端删除失败请稍后重试', icon: 'none' })
    /*
     * 撤回成功后同意网关会立刻盖住整屏（app.tsx 订阅 store），本页已无意义：
     * 和注销一样回「我的」—— 那里正显示未登录态，用户也能就近看到同意弹窗。
     * 栈底进不来时（分享 / 旧链接）navigateBack 会失败，兜底切回 tab。
     */
    Taro.navigateBack().catch(() => void Taro.switchTab({ url: '/pages/mine/index' }))
  }

  /**
   * 是否「有同意可撤」：**本机记录 / 内存态 / 登录态，三者任一成立即可**。
   *
   * 只认一条会误伤：store 的内存态是模块加载那一刻读出来的，早于存储就绪时会把「已同意」
   * 钉成 false（见 stores/consent 的 sync 注释）；反过来写库失败时内存态却是 true。
   * 而登录只会在同意之后发起（app.tsx 的 onAgree / useLaunch 都以 hasConsented 为前提），
   * 所以 `userId` 存在本身就是「走过同意流程」的证据。
   * 2026-10-17 反馈「点撤回只提示当前未同意」正是只认内存态造成的。
   */
  const canWithdraw = hasConsented() || consented || !!userId

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
      note: notifyConfigured() ? '关注的人 / 跟进的事 · 授权一次一条' : '未配置订阅模板',
      onTap: () => void onSubscribeTap()
    },
    {
      /* PIPL 第 45 条「查阅、复制」：查阅已有各页，这里补齐「把副本带走」 */
      icon: '📤',
      iconBg: 'brand',
      /*
        标题必须与隐私政策里承诺的入口名逐字一致（政策写「我的 → 系统设置 → 导出个人数据」）。
        改短成「个人数据」读起来更顺，但用户照着政策找不到 —— 承诺与实现各说各话
        正是 42 / 84 两个用例在钉的东西。
      */
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
    {
      /*
        撤回同意（PIPL 第 15 条）：**常驻展示**，不按 consented 条件渲染。
        条件渲染时「已同意」这个前提一失效（版本号更新 / storage 被回收 / 内存态读错），
        整行就静默消失，用户只会认为功能不存在（2026-10-17 线上反馈）。
        现在改为常驻：能撤 ⇒ 红色危险项 + 真撤回；没有可撤的 ⇒ 中性色 + 如实说明。
      */
      icon: '↩️',
      iconBg: canWithdraw ? 'danger' : 'blue',
      title: '撤回同意',
      note: canWithdraw ? '停止处理并删除个人数据' : '当前没有有效的同意记录',
      danger: canWithdraw,
      onTap: () => {
        if (!canWithdraw) {
          /* 无同意可撤：说清原因，而不是静默无响应 */
          Taro.showToast({ title: '当前没有有效的同意记录，无需撤回', icon: 'none' })
          return
        }
        void withdrawConsent()
      }
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
      : []),
    /*
      运维中心（2026-10-18）：仅超管可见。
      放在最后而不是最前：它对 99.9% 的用户不存在，不该占据这一页的视觉起点。
      「可见」只是体验，真正的闸门在云函数（openid 白名单）—— 这一行被改包强开也没用。
    */
    ...(isAdmin
      ? [
          {
            icon: '🛠️',
            iconBg: 'blue' as const,
            title: '运维中心',
            note: '查用户 · 改会员 · 模型厂商开关',
            onTap: () => void Taro.navigateTo({ url: '/package/admin/index' })
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
        清空数据只删内容，账号与授权都保留；撤回同意会停止处理并退出登录；注销账号会连账号一并删除，
        三者都不可恢复。
      </Text>
    </View>
  )
}
