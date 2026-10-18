import type { Report } from './report'

/**
 * 「这个人是谁」的身份指纹（2026-10-18）。
 *
 * 背景：`personKey = 名字#领域`，而领域是检索轴、不是身份轴 —— 同一个人横跨科技 / 汽车 / 投资
 * 是常态（雷军就同时属于这三个行业），把它当身份用，同一个人从不同入口进来必然裂成多份报告。
 * 名字又不足以判定（同名不同人才是最危险的那种错）。
 *
 * 这里补上中间那层：**从已生成的报告里抽出「本人与哪些机构有明确关联」**，再与候选的
 * 一句话身份（`PersonCandidate.brief`）比对。同一份报告的机构词是模型按素材写下的，
 * 比名字+领域可靠得多；而 brief 正是同一个模型在消歧时对「这个人是哪位」的一句概括。
 *
 * 信号强度刻意分两档（调用方据此决定「自动合并」还是「问一句」）：
 * · strong = 关联企业 / 商业合作（`affiliations` / `endorsements`）—— 模型明确写了本人与它的关系；
 * · weak  = 档案里「所属机构」这类 label 的 value —— 常是学校、单位，认错人的代价较高，
 *           只用来**提示**用户，绝不自动合并。
 */

export interface IdentityTokens {
  strong: string[]
  weak: string[]
}

export interface IdentityMatch {
  /** same = 可以自动合并；maybe = 只能说「可能是这位」，要问；unknown = 没信号 */
  verdict: 'same' | 'maybe' | 'unknown'
  hits: string[]
  via: 'strong' | 'weak' | 'none'
}

/** 档案里「这是谁的单位」类 label（值是机构名，可与 brief 比对） */
const ORG_LABEL = /机构|公司|企业|任职|就职|所属|创办|创立|供职|旗下|工作室|单位|职务/
/** 「身份 / 职业」类 label（值是角色，用来拼一句人话，不参与机构比对） */
const ROLE_LABEL = /职业|身份|职位|头衔|角色/
/** 泛指：不是机构名，出现在 tokens 里只会制造误命中 */
const NOISE = /^(某|某某|多家|一家|其他|其它|知名|无|不详|暂无|个人)/

/** 归一：去掉括号里的补充说明（「小米集团（1810.HK）」）与所有空白 / 标点 */
export function normEntity(raw: unknown): string {
  if (raw == null) return ''
  return String(raw)
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/[\s·・.,，、;；:：'"“”‘’!！?？]/g, '')
    .trim()
}

function usable(token: string): boolean {
  if (token.length < 2 || token.length > 24) return false
  if (/^\d+$/.test(token)) return false
  return !NOISE.test(token)
}

function push(list: string[], raw: unknown): void {
  const t = normEntity(raw)
  if (usable(t) && !list.includes(t)) list.push(t)
}

/**
 * 抽出身份指纹。报告为空 / 没有这些字段时返回两个空数组（调用方据此走「没信号」分支）。
 *
 * 只认**具名机构**：`profile` 里的「籍贯 / 生日 / 毕业院校」之类不会被收进来，
 * 因为它们与 brief 的比对没有意义（brief 写的是「小米创始人」这种身份，不是籍贯）。
 */
export function identityTokensOf(report: Report | null | undefined): IdentityTokens {
  const strong: string[] = []
  const weak: string[] = []
  if (!report) return { strong, weak }

  for (const item of report.affiliations ?? []) push(strong, item && item.name)
  for (const item of report.endorsements ?? []) push(strong, item && item.brand)

  for (const item of report.profile ?? []) {
    if (!item) continue
    const label = String(item.label ?? '')
    if (ORG_LABEL.test(label)) push(weak, item.value)
  }
  return { strong, weak }
}

/**
 * 机构名是否出现在一句话身份里。
 *
 * 两级命中：
 * 1. brief 里**完整出现**该机构名（「小米集团」⊂「小米集团创始人」）；
 * 2. 机构名较长（≥4 字）时，退一步用**前两个字**匹配 —— brief 常写简称
 *    （「小米创始人」 vs 报告里的「小米集团」），不放这一步就几乎永远命中不了。
 *
 * 第 2 条会带来一类误伤：机构名以城市 / 省份开头时，brief 里的地名会命中
 * （「北京大学」的前两字「北京」出现在「北京人艺演员」里）。故命中后紧邻的那个字
 * 若是「人 / 市 / 省 / 籍」这类地名后缀，就判为没命中。
 */
export function briefHasEntity(brief: string, entity: string): boolean {
  const b = normEntity(brief)
  const e = normEntity(entity)
  if (!b || !e) return false
  if (b.includes(e)) return true
  if (e.length < 4) return false
  const head = e.slice(0, 2)
  const at = b.indexOf(head)
  if (at < 0) return false
  const next = b.charAt(at + 2)
  return !/[人市省籍县区]/.test(next)
}

/**
 * brief × 报告指纹 → 判定。
 *
 * · 命中 strong（关联企业 / 代言品牌）→ `same`：可以让这个入口直接用已有那份报告；
 * · 只命中 weak（档案里的所属机构）→ `maybe`：文案上问一句，用户点了才合并；
 * · 没有 brief、或一个词都没对上 → `unknown`：保守各留一份，绝不猜。
 */
export function matchIdentity(brief: string | undefined | null, tokens: IdentityTokens): IdentityMatch {
  if (!brief) return { verdict: 'unknown', hits: [], via: 'none' }
  const strongHits = tokens.strong.filter((e) => briefHasEntity(brief, e))
  if (strongHits.length) return { verdict: 'same', hits: strongHits, via: 'strong' }
  const weakHits = tokens.weak.filter((e) => briefHasEntity(brief, e))
  if (weakHits.length) return { verdict: 'maybe', hits: weakHits, via: 'weak' }
  return { verdict: 'unknown', hits: [], via: 'none' }
}

/**
 * 一句话身份（给「已并入『科技』那份报告：小米集团创始人」这类提示用）。
 *
 * 优先拼档案里的「所属机构 + 职业」（这是最像人的描述），拼不出才退回 intro 的前 24 字。
 * 只做搬运与截断，不归纳、不改写 —— 提示里出现的东西必须能在报告里找到原话。
 */
export function identityHeadlineOf(report: Report | null | undefined): string {
  if (!report) return ''
  const org: string[] = []
  const role: string[] = []
  for (const item of report.profile ?? []) {
    if (!item) continue
    const label = String(item.label ?? '')
    const value = String(item.value ?? '').trim()
    if (!value) continue
    if (ORG_LABEL.test(label) && org.length === 0) org.push(value)
    else if (ROLE_LABEL.test(label) && role.length === 0) role.push(value)
  }
  const joined = `${org[0] ?? ''}${role[0] ?? ''}`.trim()
  const text = joined || String(report.intro ?? '').trim()
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}
