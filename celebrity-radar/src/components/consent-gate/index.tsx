import Taro, { useRouter } from '@tarojs/taro'
import { useState } from 'react'
import { Button, Text, View } from '@tarojs/components'
import './index.scss'

/**
 * 首次知情同意网关（PIPL 第 14 / 17 条）。
 *
 * ── 为什么要有它 ───────────────────────────────────────────────────
 * 小程序启动会静默建号（采集 openid），改造前这一步发生在任何隐私条款被阅读 / 同意之前。
 * 本组件是一层**全屏闸门**：未同意当前版本政策时覆盖全屏、挡住交互，用户必须点
 * 「同意并继续」（明确的肯定动作，区别于沉默）才放行；点「暂不同意」则不放行、
 * 只提示原因。是否放行、同意结果如何落库，由 app.tsx 接线（见 onAgree 回调）。
 *
 * ── 与 components/privacy-gate 的分工（别混）─────────────────────
 *   · 本组件：对**我们自己的《隐私与免责声明》**的首次知情同意，闸的是「采集 openid」；
 *   · privacy-gate：微信**平台级隐私接口授权**（`wx.onNeedPrivacyAuthorization`），
 *     闸的是「调用头像昵称 / 保存相册等隐私接口」。
 * 两者语义与触发时机都不同，故不合并。层级上本闸门更高（同意是更前置的一道）。
 *
 * ── 不满 14 周岁（PIPL 第 31 条）────────────────────────────────────
 * 处理不满 14 周岁未成年人个人信息须取得**监护人同意**。本面向成年人的产品不做实名核验，
 * 故用一道**年龄 / 监护人同意确认**（勾选框）作为前置声明：未勾选不得同意、不得进入；
 * 未满 14 周岁的用户须由监护人在同意并陪同下使用（由监护人代为同意本声明）。
 * 配套的**专门**处理规则见「隐私与免责声明」的「未成年人个人信息保护规则」一节。
 *
 * 挂载点：`app.tsx`（全局一份，覆盖所有页面；同意后自身不再渲染）。
 */
export default function ConsentGate({ onAgree }: { onAgree: () => void }) {
  /*
   * 本闸门挂在 app.tsx、**覆盖所有页面**（同 privacy-gate）。因此它也会盖住
   * 「隐私与免责声明」页本身 —— 那样用户点「查看全文」后反而读不到正文。
   * 故：当前正停在政策页时**不渲染本闸门**（返回 null 让出整屏），返回后仍会重新盖上。
   * 这样「读全文」入口真正可达，同意闭环才成立。
   */
  const router = useRouter()
  const onPolicyPage = (router?.path || '').indexOf('pages/agreement') >= 0
  /* 年龄 / 监护人同意确认（PIPL 第 31 条）：必须勾选才放行 */
  const [ageOk, setAgeOk] = useState(false)

  /** 打开完整政策文本（独立页，navigateTo 到二级页；该页上本闸门自动让出） */
  const openPolicy = () => {
    Taro.navigateTo({ url: '/package/agreement/index' })
  }

  if (onPolicyPage) return null

  /* 暂不同意：不放行，也不退出小程序（避免误触即离开），只说明「为什么不能继续」 */
  const onDecline = () => {
    Taro.showToast({ title: '需同意后才能使用本小程序', icon: 'none' })
  }

  /* 同意前的最后一道：年龄 / 监护人确认未勾选则拦下并说明原因（不静默失败） */
  const onConfirm = () => {
    if (!ageOk) {
      Taro.showToast({ title: '请先确认已年满 14 周岁或已取得监护人同意', icon: 'none' })
      return
    }
    onAgree()
  }

  return (
    <View className='consent-gate'>
      <View className='consent-gate__mask' />
      <View className='consent-gate__card'>
        <Text className='consent-gate__title'>隐私保护提示</Text>
        <Text className='consent-gate__body'>
          欢迎使用名人雷达。在使用前，请阅读并同意
          <Text className='consent-gate__link' onClick={openPolicy}>
            《隐私与免责声明》
          </Text>
          。我们仅收集为提供服务所必需的信息：微信匿名标识（openid），以及你主动设置的昵称 / 头像与关注、收藏、历史等功能数据；不收集手机号、位置、通讯录等敏感信息，也不出售你的个人信息。
        </Text>
        {/* 年龄 / 监护人同意确认：必须勾选，「同意并继续」才放行（PIPL 第 31 条） */}
        <View className='consent-gate__check' onClick={() => setAgeOk((v) => !v)}>
          <View className={`consent-gate__box${ageOk ? ' consent-gate__box--on' : ''}`}>
            {ageOk ? <Text className='consent-gate__tick'>✓</Text> : null}
          </View>
          <Text className='consent-gate__check-text'>
            我已年满 14 周岁；若未满 14 周岁，已取得监护人同意并由其代为同意本声明
          </Text>
        </View>
        <View className='consent-gate__actions'>
          <View className='consent-gate__btn consent-gate__btn--ghost' onClick={onDecline}>
            暂不同意
          </View>
          <Button
            className={`consent-gate__btn consent-gate__btn--primary${ageOk ? '' : ' consent-gate__btn--gated'}`}
            hoverClass='none'
            onClick={onConfirm}
          >
            同意并继续
          </Button>
        </View>
      </View>
    </View>
  )
}
