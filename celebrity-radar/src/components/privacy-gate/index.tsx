import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Text, View } from '@tarojs/components'
import './index.scss'

/**
 * 微信隐私授权网关（2026-10-13，P0-3 合规项）。
 *
 * ── 为什么要有它 ─────────────────────────────────────────────────────
 * 微信自 2023-09 起要求：小程序在调用「隐私接口」（头像昵称填写、保存到相册、位置等）前，
 * 必须先让用户阅读并同意《小程序用户隐私保护指引》。同意前调用这些接口会被平台拒绝。
 * 平台给出的标准形态是**自定义弹窗 + 开放能力按钮**：
 *   · `wx.onNeedPrivacyAuthorization(resolve)` 在「需要授权」时回调，把 resolve 交给我们；
 *   · 用户点「同意」的按钮必须带 `open-type="agreePrivacyAuthorization"`，随后调用
 *     `resolve({ event: 'agree', buttonId })` 才会放行；点「拒绝」则 `resolve({ event: 'disagree' })`。
 *
 * ── 守卫（本项目必须稳）─────────────────────────────────────────────
 * 基础库低于 2.32.3、H5 端、或**后台尚未配置指引**时，这两个 API 不存在 / 不回调 ——
 * 此时本组件等同不存在，绝不报错、不弹框、不阻断启动（`getPrivacySetting` 也会返回
 * needAuthorization=false）。换言之：配了就走合规流程，没配就静静退化为原行为。
 *
 * 挂载点：`app.tsx`（全局一份，覆盖所有页面）。
 */
interface PrivacyResolveArg {
  event: 'agree' | 'disagree'
  buttonId?: string
}

export default function PrivacyGate({ children }: { children?: ReactNode }) {
  const [visible, setVisible] = useState(false)
  /* 平台回调交回来的 resolve：只在本弹窗里用，点按钮时再回传「同意 / 拒绝」 */
  const resolverRef = useRef<((arg: PrivacyResolveArg) => void) | null>(null)

  useEffect(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = (typeof wx !== 'undefined' ? (wx as any) : null)
    if (!w) return undefined

    /* ① 需要授权时弹框（把 resolve 暂存，等用户点按钮再回传） */
    if (typeof w.onNeedPrivacyAuthorization === 'function') {
      w.onNeedPrivacyAuthorization((resolve: (arg: PrivacyResolveArg) => void) => {
        resolverRef.current = resolve
        setVisible(true)
      })
    }

    /* ② 启动即查一次：需要授权就先弹，避免首个隐私接口被静默拒绝、用户不明所以 */
    if (typeof w.getPrivacySetting === 'function') {
      w.getPrivacySetting({
        success: (res: { needAuthorization?: boolean }) => {
          if (res && res.needAuthorization) setVisible(true)
        },
        fail: () => {
          /* 取不到设置（未配置指引 / 旧基础库）→ 不弹，保持原行为 */
        }
      })
    }
    return undefined
  }, [])

  /* 同意：按钮本身带 open-type=agreePrivacyAuthorization，这里只需把结果回传平台 */
  const onAgree = () => {
    resolverRef.current?.({ event: 'agree', buttonId: 'privacy-gate-agree' })
    resolverRef.current = null
    setVisible(false)
  }

  const onDisagree = () => {
    resolverRef.current?.({ event: 'disagree' })
    resolverRef.current = null
    setVisible(false)
  }

  return (
    <>
      {children}
      {visible ? (
        <View className='privacy-gate'>
          <View className='privacy-gate__mask' />
          <View className='privacy-gate__card'>
            <Text className='privacy-gate__title'>隐私保护提示</Text>
            <Text className='privacy-gate__body'>
              使用前请阅读并同意《隐私与免责声明》。我们仅收集为提供服务所必需的信息（微信匿名标识，以及你主动设置的昵称 /
              头像），不会收集手机号、位置、通讯录等。
            </Text>
            <View className='privacy-gate__actions'>
              <View className='privacy-gate__btn privacy-gate__btn--ghost' onClick={onDisagree}>
                拒绝
              </View>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              <Button
                id='privacy-gate-agree'
                className='privacy-gate__btn privacy-gate__btn--primary'
                openType={'agreePrivacyAuthorization' as any}
                hoverClass='none'
                onClick={onAgree}
              >
                同意
              </Button>
            </View>
          </View>
        </View>
      ) : null}
    </>
  )
}
