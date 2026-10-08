import type { Report } from './report'

/**
 * 名言「出处核对」—— 纯端上、零调用的一段对照逻辑（本轮新增）。
 *
 * **为什么不做「AI 判真伪」**：判定一句话是否真出自某人，需要能读原始报道全文的语料；
 * 而本机手里只有报告落库的条目（标题 / 摘要 / 链接 / 语录）。让模型凭标题猜真伪，
 * 产出的是一条看起来很权威、实际无从核对的结论 —— 对「别把不实信息当真」这件事来说，
 * 这比不查更糟（合规上也站不住：平台没有能力判定，就不该摆出一个判定）。
 *
 * 所以这里只做**能核对的事实**，三件事：
 *   ① 这条名言的出处链接是不是本次检索到的素材（report.ts 的白名单已保证「是或没有」）；
 *   ② 出处那篇报道在报告里的标题 / 摘要中，有没有与名言相同的表述（有 = 可核对）；
 *   ③ 报告里还有哪些条目提到了相近说法（旁证，逐条可点开原文）。
 * 结论只有三档，全部用「核对到什么程度」的说法，**不出现真 / 假二字**。
 *
 * 零模型调用、零云读、同步纯函数：点一下即出结果，不需要 loading、不消耗任何额度
 * （与 O-13 ~ O-19 那批「纯端上」优化同一取舍）。
 */

/** 判定档位：出处可核对 / 只给了出处 / 连出处都没有 */
export type QuoteCheckLevel = 'matched' | 'linked' | 'no-source'

/** 出处报道（同链接的报告条目；条目没被模型写进正文时只有链接与标题） */
export interface QuoteCheckOrigin {
  url: string
  title: string
  source: string
  date: string
  summary: string
}

/** 旁证条目：报告里其它提到了相近说法的报道 */
export interface QuoteCheckEcho {
  url: string
  title: string
  source: string
  date: string
  summary: string
}

export interface QuoteCheckResult {
  level: QuoteCheckLevel
  /** 一句话判定 */
  verdict: string
  /** 判定依据（一句话，不写长免责——卡片上的字越少越有人读） */
  desc: string
  origin: QuoteCheckOrigin | null
  echoes: QuoteCheckEcho[]
  /** 复制引文（与名人主页复制同一口径） */
  copyText: string
}

type Quote = Report['quotes'][number]

/**
 * 认定「同一表述」的最短公共子串（归一后，汉字数）。
 * 取 8：4~6 字的重合在中文里太容易偶然发生（「他表示」「在接受采访时」），
 * 那样每条名言都会「找到旁证」，核对就变成了噪音。
 */
const MIN_OVERLAP = 8

/** 旁证最多列几条：第 3 条之后的边际信息量已经很低，卡片却会长出一屏 */
const ECHO_MAX = 2

/**
 * 参与比对前的归一：去掉空白与标点。
 * 模型复述同一句话时，标点与空格最容易不一致（「，」对上「,」、引号有无），
 * 不移除就会把同一句话判成两句。
 */
function norm(s: string): string {
  return (s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[「」『』“”‘’"'（）()《》〈〉，,。.、；;：:！!？?—－\-…·~～]/g, '')
}

/**
 * 两段文本的最长公共子串长度。
 *
 * 用「固定窗口探测 + 命中后向两侧扩展」而不是 O(n·m) 的动态规划：
 * 一句名言 40 字、一条摘要 200 字，逐条 DP 就是 8000 次比较，而报告里有 20 条素材起步；
 * 窗口法没命中时只是几次 indexOf，命中一次就能扩到底。
 * 宁可少算不可多算：窗口命中处取的是**第一次出现的位置**，未必是最长的那一处，
 * 结果偏保守 —— 这类「像不像同一句话」的判断，漏认一条远比错认一条安全。
 */
function overlapRun(q: string, m: string): number {
  if (q === '' || m === '') return 0
  const W = 6
  if (q.length < W) return m.includes(q) ? q.length : 0
  let best = 0
  for (let i = 0; i + W <= q.length; i += 1) {
    const win = q.slice(i, i + W)
    const at = m.indexOf(win)
    if (at === -1) continue
    let start = i
    let end = i + W
    let ms = at
    let me = at + W
    while (start > 0 && ms > 0 && q[start - 1] === m[ms - 1]) {
      start -= 1
      ms -= 1
    }
    while (end < q.length && me < m.length && q[end] === m[me]) {
      end += 1
      me += 1
    }
    if (end - start > best) best = end - start
    if (best >= q.length) break
  }
  return best
}

const VERDICT: Record<QuoteCheckLevel, { label: string; desc: string }> = {
  matched: {
    label: '出处可核对',
    desc: '出处是本次检索到的报道，摘要里出现了同一表述，可点开原文核对。'
  },
  linked: {
    label: '出处已给出',
    desc: '出处是本次检索到的报道，但摘要里没有出现原句，建议点开原文核对。'
  },
  'no-source': {
    label: '未附出处',
    desc: '这条没有具体的报道链接，建议复制引文去检索核对。'
  }
}

/**
 * 核对一条名言。
 *
 * 同名同源的判断顺序：同链接的「近期动态」条目（带摘要，信息最全）→「来源清单」里的标题
 * → 都没有则只剩链接本身。三者都不影响「有没有链接」这个事实，只影响能摊开多少东西给用户。
 */
export function checkQuote(report: Report, quote: Quote): QuoteCheckResult {
  const url = (quote.source ?? '').trim()
  const isLink = /^https?:\/\//i.test(url)
  const q = norm(quote.text)
  const dynamics = report.dynamics ?? []

  const sameDyn = isLink ? dynamics.find((d) => d.url === url) : undefined
  const sameSrc = isLink ? (report.sources ?? []).find((s) => s.url === url) : undefined
  const origin: QuoteCheckOrigin | null = isLink
    ? {
        url,
        title: sameDyn?.title || sameSrc?.title || '',
        source: sameDyn?.source || '',
        date: sameDyn?.date || '',
        summary: sameDyn?.summary || ''
      }
    : null

  /* 「可核对」= 出处那篇报道在本报告里的文字里出现了同一表述；只有链接、没有文字呼应就只算「已给出出处」 */
  const originRun = origin ? overlapRun(q, norm(`${origin.title}${origin.summary}`)) : 0
  const level: QuoteCheckLevel = !isLink
    ? 'no-source'
    : originRun >= MIN_OVERLAP
      ? 'matched'
      : 'linked'

  const echoes = dynamics
    .filter((d) => d.url !== url)
    .map((d) => ({ d, run: overlapRun(q, norm(`${d.title}${d.summary}`)) }))
    .filter((x) => x.run >= MIN_OVERLAP)
    .sort((a, b) => b.run - a.run)
    .slice(0, ECHO_MAX)
    .map(({ d }) => ({
      url: d.url,
      title: d.title,
      source: d.source,
      date: d.date,
      summary: d.summary
    }))

  return {
    level,
    verdict: VERDICT[level].label,
    desc: VERDICT[level].desc,
    origin,
    echoes,
    copyText: quoteCopyText(quote)
  }
}

/**
 * 引文的复制文本（唯一口径）。
 * 名人主页原先就地拼了这串，报告页的「查证」面板也要用同一串 —— 两处各写一份，
 * 迟早一处带来源一处不带。source 缺失时退回「据公开资料」，不给出空的「来源：」。
 */
export function quoteCopyText(quote: Quote): string {
  const src = (quote.source ?? '').trim()
  return `${quote.text}\n—— 来源：${src === '' ? '据公开资料' : src}`
}
