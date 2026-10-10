'use strict'

/**
 * 文本卫生（utils/text#cleanText / clipText）
 *
 * 这组用例钉住的是**不抛异常**的那一类问题 —— 语法全对、值是坏的，靠日志和截图才发现的那些：
 *   ① 截断不能切开一个字符：按 UTF-16 码元 slice 会把 emoji 切成半个，落库即「�」，
 *      而报告是全局共享缓存，坏字符会被全站读到；
 *   ② 不可见字符（零宽 / 双向控制符）必须清掉 —— 肉眼看不出，却让去重与关键词匹配静默失配；
 *   ③ 外部素材带的 HTML 标签与实体必须剥掉，否则会被模型照抄进报告，用户看到一串标签；
 *   ④ 反向约束：正文本身（换行、制表、全角标点、中文引号）一个字符都不能被误伤。
 */

const env = require('../harness/env')
const { describe, it, ok, eq } = require('../harness/t')

const { cleanText, clipText } = env.load('utils/text')

/** 是否存在**孤立**代理项（`.slice()` 切开 emoji 的产物）—— 各处复用的小判据 */
const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

describe('文本卫生 utils/text', () => {
  it('clipText：emoji 不会被切成半个（老写法 slice 会）', () => {
    const out = clipText('😀😀😀', 2)
    eq(out, '😀😀')
    ok(!hasLoneSurrogate(out))
    /* 对照：老写法的结果确实是坏字符 —— 用例要能钉住「为什么要改」 */
    ok(hasLoneSurrogate('😀😀😀'.slice(0, 3)))
  })

  it('clipText：中文按字截断，与老写法等价（只有 emoji 那段口径不同）', () => {
    eq(clipText('这是一段中文摘要', 4), '这是一段')
    eq(clipText('这是一段中文摘要', 100), '这是一段中文摘要')
  })

  it('clipText：ZWJ 组合序列算一个字（👨‍👩‍👧 不能被拆成三个人）', () => {
    const family = '👨‍👩‍👧'
    const out = clipText(`${family}${family}`, 1)
    /* 有 Intl.Segmenter 时按字形簇切、整个保留；没有时退到按码点。
       两条路径的共同契约是「不留孤立代理项」—— 那是硬断言，切多细是环境能力问题。
       但 ZWJ 本身绝不能被当零宽垃圾清掉（见下一条用例）。 */
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      eq(out, family)
    }
    ok(!hasLoneSurrogate(out))
  })

  it('cleanText：ZWJ / ZWNJ 不算「零宽垃圾」，必须留着（emoji 组合靠它）', () => {
    /* 这一条是被一次真实失败逼出来的：零宽过滤的范围一开始把 U+200D 也圈了进去，
       👨‍👩‍👧 于是被清成三个独立的人 —— 看着还是「有几个人」，但已经不是那个人了 */
    eq(cleanText('👨\u200d👩\u200d👧'), '👨\u200d👩\u200d👧')
    eq(cleanText('a\u200cb'), 'a\u200cb')
    /* 真正只会捣乱的那些仍然清掉 */
    eq(cleanText('a\u200bb'), 'ab')
  })

  it('clipText：max 非正数直接空串', () => {
    eq(clipText('正文', 0), '')
    eq(clipText('正文', -1), '')
  })

  it('cleanText：零宽字符与双向控制符清掉，正文标点不动', () => {
    eq(cleanText('张\u200b三\ufeff丰'), '张三丰')
    eq(cleanText('abc\u202edef'), 'abcdef')
    /* 正文里的全角标点与中文引号是内容，必须原样保留 */
    eq(cleanText('他说“好”，然后走了：'), '他说“好”，然后走了：')
  })

  it('cleanText：控制符清掉，但换行与制表是正文排版，留着', () => {
    eq(cleanText('第一行\n第二行\t尾'), '第一行\n第二行\t尾')
    eq(cleanText('a\u0000b\u0007c'), 'abc')
  })

  it('cleanText：孤立代理项清掉，成对的 emoji 保留', () => {
    eq(cleanText('😀'), '😀')
    /* \uD83D 是 😀 的前半个码元，正是截断留下的那半个 */
    eq(cleanText('A\uD83DB'), 'AB')
    eq(cleanText('A\uDE00B'), 'AB')
  })

  it('cleanText：换行类标签留一个换行，其余标签剥掉（只对外部素材开 markup）', () => {
    eq(
      cleanText('<em>周杰伦</em>宣布<br>新专辑&amp;巡演', { markup: true }),
      '周杰伦宣布\n新专辑&巡演'
    )
    /* 不开 markup 时标签原样留着 —— 模型输出不该被当素材处理 */
    eq(cleanText('<em>x</em>'), '<em>x</em>')
  })

  it('cleanText：先剥标签、后还原实体（`&lt;em&gt;` 是要显示成文本的）', () => {
    eq(cleanText('&lt;em&gt;', { markup: true }), '<em>')
  })

  it('cleanText：数字实体还原，认不出的原样保留（不猜）', () => {
    eq(cleanText('&#39;quoted&#39;'), "'quoted'")
    eq(cleanText('&#x1F600;'), '😀')
    eq(cleanText('&unknown;'), '&unknown;')
  })

  it('cleanText：非字符串与空值一律归空串（不让 undefined 穿透到渲染层）', () => {
    eq(cleanText(undefined), '')
    eq(cleanText(null), '')
    eq(cleanText(123), '')
    eq(cleanText('   '), '')
  })
})
