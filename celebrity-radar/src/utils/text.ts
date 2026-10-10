/**
 * 文本卫生：模型输出与外部素材**进库前**的字符级清洗。
 *
 * 这一层防的不是「语法错」（那归 utils/llm 的 repairJsonText / parseModelJson），而是
 * **解析成功、内容是坏的**那一类 —— 它们一个异常都不抛，只有在数据出口拦得住：
 *
 *   · 孤立代理项：`.slice(0, N)` 把一个 emoji 从码元中间切开留下的半个字符，落库后渲染成
 *     「�」。故长度收敛一律走 clipText（按字形簇切，从源头不产生它），cleanText 兜底清残留；
 *   · 零宽字符与双向控制符（U+200B~200F / U+202A~202E / U+2060~2064 / U+FEFF）：网页素材里
 *     最常见。肉眼完全看不出，却让去重、关键词匹配、URL 比对**静默失配** ——
 *     「明明是同一件事，就是匹配不上」的根因常在这里；双向控制符还能把一段文字的渲染顺序
 *     整个颠倒（伪装内容的老手法），展示型文本必须清掉；
 *   · HTML 标签与实体：搜索接口给命中词加的高亮标记（`<em>`）与 `&amp;` 一类，会被模型
 *     照抄进报告，用户看到的就是一串标签；
 *   · C0/C1 控制符：换行与制表符留给正文（它们是正常排版），其余一律清掉 —— NUL 之类
 *     会让下游的字符串处理在此截断。
 *
 * 沿用项目既有原则：**只做确定性替换，不猜测内容**。猜不出来的（比如「这句是不是完整的」
 * 「这个字是不是错字」）一概不碰 —— 报告是全局共享缓存，改坏了是全站读到。
 */

/**
 * 零宽 / 格式控制符：不可见，只会捣乱。
 *
 * **刻意不含 U+200C（ZWNJ）与 U+200D（ZWJ）** —— 它们名字里带「零宽」，却恰恰不该清：
 * ZWJ 是 emoji 组合序列的粘合剂，`👨‍👩‍👧` 靠它才是一个人，清掉就把一个 emoji 拆成三个人
 * （渲染出来还是「有几个人」，但对不上任何人的本意）；ZWNJ 在部分语言里是正字法的一部分。
 * 真正只会捣乱的是零宽空格、方向标记与双向控制符（后者能把一段文字的渲染顺序整个颠倒）。
 */
const INVISIBLE_CHARS = /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g

/** C0 + C1 控制符（\t \n \r 是正文排版，不在此列） */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** 块级 / 换行标签：剥掉时留一个换行，免得两段文字粘成一行 */
const BREAK_TAGS = /<\/?(?:br|p|div|li|tr|h[1-6])\b[^<>]{0,200}>/gi

/**
 * 其余常见标签。**白名单式**：只认这些具名标签，且必须由 `>` 收尾。
 * 刻意不用「`<` 开头一律剥到底」的通用式 —— 正文里的不等式（`A<B`）、箭头、`<3` 会被误伤，
 * 而那是真实内容，比留着几个标签严重得多。
 */
const INLINE_TAGS = /<\/?(?:em|strong|b|i|u|s|del|ins|span|a|font|sub|sup|small|big|ul|ol|dl|dt|dd|table|thead|tbody|td|th|blockquote|pre|code)\b[^<>]{0,200}>/gi

/** 具名实体：只收「搜索引擎真会吐、且还原后仍是正文」的那几个 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/** 数字实体（`&#39;` / `&#x27;`）与具名实体一并还原；**认不出的原样保留**（不猜） */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1).toLowerCase() === 'x'
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      /* 只认合法且非代理区的码点：0 与半个代理项还原了也是坏字符，不如原样留着当证据 */
      const usable = Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      return usable ? String.fromCodePoint(code) : whole
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? whole : named
  })
}

/**
 * 清掉**单独出现**的代理项（成对的码点照旧保留）。
 *
 * 不用正则 lookbehind 表达：老 iOS 的 JSCore 不支持，整个正则字面量会直接编译失败 ——
 * 项目 browserslist 覆盖到 iOS 8，为一个字符清洗问题让脚本起不来，代价完全不成比例。
 */
function dropLoneSurrogates(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s.charAt(i) + s.charAt(i + 1) // 配对完好：整个码点留下
        i++
      }
      continue // 孤立高位：丢
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue // 孤立低位：丢
    out += s.charAt(i)
  }
  return out
}

/**
 * 按**字形簇**切分：一个 emoji（含 ZWJ 组合序列 `👨‍👩‍👧`、肤色与变体修饰符 `🛡️`）算一个单位。
 *
 * 优先 Intl.Segmenter，没有就退到「按码点」（`Array.from` 走字符串迭代）。后者切不开多码点
 * 的组合序列，但**绝不会产生孤立代理项** —— 而「切出半个字符」才是这一层要防的坏字符。
 * 万一连字符串迭代都没有（极老引擎），`Array.from` 会按码元切，最坏等于没改，不会更糟。
 */
function splitGraphemes(s: string): string[] {
  const Seg = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        opts?: { granularity: string }
      ) => { segment: (text: string) => Iterable<{ segment: string }> }
    }
  ).Segmenter
  if (typeof Seg === 'function') {
    try {
      return Array.from(new Seg('zh', { granularity: 'grapheme' }).segment(s), (g) => g.segment)
    } catch {
      /* 环境声称支持却用不了（参数 / 实现差异）：落到下面的码点路径 */
    }
  }
  return Array.from(s)
}

export interface CleanTextOptions {
  /**
   * 剥 HTML 标签：**只对外部素材开**（搜索接口会给命中词加 `<em>` 高亮）。
   * 模型输出不开 —— 它不会主动写标签，真写了多半是照着素材抄的，而素材进来时已剥过一遍。
   */
  markup?: boolean
}

/** 清洗（不收敛长度）。空值一律归 `''`，不让 undefined 穿透到渲染层 */
export function cleanText(input: unknown, opts: CleanTextOptions = {}): string {
  if (typeof input !== 'string' || input === '') return ''
  let s = dropLoneSurrogates(input)
  /* 顺序要紧：**先剥标签、后还原实体**。`&lt;em&gt;` 是要显示成文本的，还原须在剥标签之后，
     否则它会被当成真标签一并剥掉（用户想要的那段字就没了） */
  if (opts.markup) s = s.replace(BREAK_TAGS, '\n').replace(INLINE_TAGS, '')
  s = decodeEntities(s)
  return s.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '').trim()
}

/**
 * 收敛长度：清洗 + 按字形簇截断到 `max` 个「字」。
 *
 * 报告落库里 `.trim().slice(0, N)` 的**唯一**替代口径：slice 按 UTF-16 码元切，会把 emoji
 * 与生僻字（如「𠮷」）切成半个，落库即坏字符，而这类值会进全局共享缓存被全站读到。
 *
 * 不加省略号：省略号是呈现层的排版选择，不写进数据（存量数据也都没有）。
 */
export function clipText(input: unknown, max: number, opts: CleanTextOptions = {}): string {
  const s = cleanText(input, opts)
  if (!(max > 0)) return ''
  const units = splitGraphemes(s)
  return units.length <= max ? s : units.slice(0, max).join('')
}
