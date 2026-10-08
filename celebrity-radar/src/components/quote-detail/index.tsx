import { ReactNode, useMemo, useState } from 'react'
import Taro from '@tarojs/taro'
import { Text, View } from '@tarojs/components'
import { checkQuote } from '@/utils/quote-check'
import { openSourceLink } from '@/utils/source-link'
import type { Report } from '@/utils/report'
import './index.scss'

/**
 * 名言脚注 + 「查证」展开面板（本轮新增，报告页与名人主页共用一套）。
 *
 * 为什么抽成组件：名言的**脚注口径**（出处一行）与**核对口径**（三档判定怎么算、
 * 旁证怎么挑）必须两处一致 —— 报告页的「经典名言」卡与名人主页的「名言」Tab 渲染的是
 * 同一份 `report.quotes`，各写一份迟早出现「主页说未附出处、报告页说出处可核对」。
 *
 * 为什么默认收起：报告页一份报告最多 8 条语录，每条挂两段背景 + 注解 + 核对结果，
 * 卡片会长到没人往下读（背景/注解是**想深挖时才要**的信息，不是浏览时的主线）。
 * 一次点击给全部：背景、注解、核对结论、出处与旁证条目、复制引文 —— 不做成两级展开，
 * 因为第二级的存在只会让「查证」这个动作多一层犹豫。
 *
 * 「查证」是**纯端上**的：核对逻辑见 utils/quote-check.ts（零模型调用、零云读），
 * 点开即出结果，所以这里没有 loading、也没有任何额度消耗。
 */

interface Props {
  report: Report
  quote: Report['quotes'][number]
  /**
   * 脚注右侧的附加动作：报告页传收藏星标、名人主页不传（复制图标在引文那一行）。
   * 由调用方给而不是写死，是因为两页对「这条语句还能做什么」的取舍本来就不同。
   */
  extra?: ReactNode
}

export default function QuoteDetail({ report, quote, extra }: Props) {
  const [open, setOpen] = useState(false)
  /* 核对是同步纯函数：依赖只有报告与这条语录，进面板前不必算第二次 */
  const check = useMemo(() => checkQuote(report, quote), [report, quote])

  /* 老缓存（本轮之前落库的报告）没有这两个键，取不到就整段不渲染 */
  const background = (quote.background ?? '').trim()
  const note = (quote.note ?? '').trim()

  return (
    <View className='quote-detail'>
      <View className='quote-detail__foot'>
        <Text className='quote-detail__src'>{quote.context || '公开场合'}</Text>
        <View
          className={`quote-detail__toggle${open ? ' quote-detail__toggle--on' : ''}`}
          hoverClass='quote-detail__toggle--tap'
          onClick={() => setOpen((v) => !v)}
        >
          <Text>{open ? '收起' : '查证'}</Text>
        </View>
        {extra}
      </View>

      {open && (
        <View className='quote-detail__panel'>
          {/* 背景 / 注解：模型给的自由文本，空串表示这条没有素材支撑，整行不出 */}
          {background !== '' && (
            <View className='quote-detail__line'>
              <Text className='quote-detail__label'>背景</Text>
              <Text className='quote-detail__text'>{background}</Text>
            </View>
          )}
          {note !== '' && (
            <View className='quote-detail__line'>
              <Text className='quote-detail__label'>注解</Text>
              <Text className='quote-detail__text'>{note}</Text>
            </View>
          )}

          <View className='quote-detail__check'>
            <View className='quote-detail__check-head'>
              <Text className={`quote-detail__badge quote-detail__badge--${check.level}`}>
                {check.verdict}
              </Text>
              <Text className='quote-detail__desc'>{check.desc}</Text>
            </View>

            {/* 出处报道：有链接就永远给这一行（标题取不到时只写「查看原文」），点它进原文预览 */}
            {check.origin && (
              <View
                className='quote-detail__row'
                hoverClass='quote-detail__row--tap'
                onClick={() =>
                  openSourceLink({
                    url: check.origin!.url,
                    title: check.origin!.title,
                    source: check.origin!.source,
                    date: check.origin!.date,
                    summary: check.origin!.summary
                  })
                }
              >
                <Text className='quote-detail__row-head'>出处报道</Text>
                <Text className='quote-detail__row-title'>
                  {check.origin.title || '查看原文'}
                </Text>
                <Text className='quote-detail__row-meta'>
                  {[check.origin.source, check.origin.date].filter(Boolean).join(' · ') ||
                    '点开核对原文'}
                </Text>
              </View>
            )}

            {/* 旁证：报告里其它提到相近说法的报道 —— 一句话在不同报道里重复出现，是「有出处」的旁证 */}
            {check.echoes.length > 0 && (
              <View className='quote-detail__echoes'>
                <Text className='quote-detail__row-head'>{`另有 ${check.echoes.length} 条报道提到相近说法`}</Text>
                {check.echoes.map((e) => (
                  <View
                    key={e.url}
                    className='quote-detail__row'
                    hoverClass='quote-detail__row--tap'
                    onClick={() =>
                      openSourceLink({
                        url: e.url,
                        title: e.title,
                        source: e.source,
                        date: e.date,
                        summary: e.summary
                      })
                    }
                  >
                    <Text className='quote-detail__row-title'>{e.title}</Text>
                    <Text className='quote-detail__row-meta'>
                      {[e.source, e.date].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <View className='quote-detail__acts'>
              <View
                className='quote-detail__act'
                hoverClass='quote-detail__act--tap'
                onClick={() => void Taro.setClipboardData({ data: check.copyText })}
              >
                <Text>复制引文</Text>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}
