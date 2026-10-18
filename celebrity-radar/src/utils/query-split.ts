/**
 * 「姓名 + 关键词」拆分（2026-10-13）。
 *
 * 用户会按「名字 补充词」的形式输入，例如「雷军 小米科技」——把整串当成一个人名塞进消歧
 * 提示词，模型会去猜「雷军 小米科技」是不是某个人的名字（实际查无此人）。
 * 本函数把首段当**名字**、其余当**关键词**：名字走原链路（personKey / 缓存键只认它），
 * 关键词只作提示（消歧补充 + 检索补充），**绝不进 personKey，也绝不进缓存键**。
 *
 * 判据（为什么不能简单「一切空格就拆」）：
 *   西文人名本身含空格与点号（`Taylor Swift`、`Robert Downey Jr.`）。若见空格就拆，
 *   姓氏会被误当关键词、名字只剩 `Taylor` —— 反而把人查错。故采用：
 *   **仅当「按分隔符切开后 ≥2 段」且「除首段外至少有一段含中日韩字符」时才拆分**；
 *   否则整串视为单个人名（keyword 为空）。这样纯拉丁串永远不拆，而中文补充词能识别。
 *
 * 取舍：中西混写（如「Taylor Swift 泰勒」）会按此判据拆开，属可接受的少数派。
 *
 * 为什么间隔号（`·` `•` `・`）**不算**分隔符：它是西文译名的组成部分 ——「迈克尔·乔丹」
 * 「莱昂纳多·迪卡普里奥」按间隔号拆会得到 `name=迈克尔`，直接把人查错，而这个错还很隐蔽
 * （首段是非空中文、判据照样满足）。用户若真要加关键词，用空格或逗号即可。
 */

import { domainLabel } from '@/config/domains'

/**
 * 关键词长度上限：与检索层的 `utils/search-plan.ts#PLAN_WORD_MAX_CHARS` **必须是同一个数**。
 *
 * 这里刻意不 import 那个常量：query-split 是发现页（tabBar 首页）直接引用的模块，
 * 而 search-plan 会连带引入 zod 校验、LLM 通道与报告目录 —— 只为一个 16 把半个检索层
 * 拖进主包不划算（主包 0.885MB 已贴边）。两处一致性由用例 test/cases/89-report-args.js 钉住。
 */
const KEYWORD_MAX_CHARS = 16

/** 中日韩字符（CJK 统一区 + 扩展 A + 兼容区 + 假名 + 谚文）：用于判定某段是不是中文补充词 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/

/**
 * 名字与关键词的分隔符：空白（`\s` 已含全角空格，这里再显式列出）+ 常见中英文标点。
 * 注意**不含间隔号**（`·` `•` `・`）—— 译名分隔与「姓名 + 关键词」的分隔在字面上同形，
 * 但前者常见得多（「迈克尔·乔丹」），误拆的代价是把人查错，故一律不拆（见文件头说明）。
 */
const SEP = /[\s\u3000,，、;；|｜/／]+/

/**
 * 拆分「姓名 + 关键词」。返回值：
 *   · name    —— 首段（或整串，当判据不满足时）；不会为 undefined，空输入返回空串
 *   · keyword —— 其余段以单空格拼接；没有可拆的补充词时为空串
 */
export function splitPersonQuery(raw: string): { name: string; keyword: string } {
  const trimmed = (raw || '').trim()
  if (!trimmed) return { name: '', keyword: '' }

  /* 去掉分隔符切出的空段（首尾标点会切出空串），避免它们被当成「第 2 段」 */
  const parts = trimmed
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean)

  const hasCjkAfterFirst = parts.slice(1).some((s) => CJK.test(s))
  if (parts.length >= 2 && hasCjkAfterFirst) {
    return { name: parts[0], keyword: parts.slice(1).join(' ') }
  }

  /* 不满足判据：整串是一个人（含纯拉丁人名），不做任何拆词 */
  return { name: trimmed, keyword: '' }
}

/**
 * 关键词里的标点：检索词是「空格分隔的词串」，标点只会把查询切脏。
 * 冒号必须去掉 —— utils/search-plan.ts#sanitizeWord 会把含 `:` 的整段**丢弃**（那是防「site:」越权），
 * 而候选卡的一句话身份里出现冒号是很常见的写法（「主持人：某节目」）。
 */
const WORD_NOISE = /["'“”‘’`《》「」【】〔〕()（）[\]{}<>、,，;；:：|｜/／\\]+/g

/** 单段净化：去标点、压空白；纯符号返回空串 */
function cleanPart(raw: string): string {
  const s = (raw || '').replace(WORD_NOISE, ' ').replace(/\s{2,}/g, ' ').trim()
  return /[\u4e00-\u9fa5a-zA-Z]/.test(s) ? s : ''
}

/**
 * 拼出「这一次要拿什么词去查这个人」：**用户关键词 + 领域标签 + 候选的一句话身份**（2026-10-18）。
 *
 * 起因：搜索「雷军」出现两个候选（科技 / 投资），点第二个时生成的却还是第一个人那份报告
 * （那是 utils/person-index 的归一判据问题，已在那边按领域收窄）。这次把另一半补上 ——
 * 生成时只拿 `名字` 去查，素材会把同名的人混成一锅；用户要的是 **「雷军 科技 小米公司」**
 * 这三个要素一起进检索（见 utils/search-plan.ts#applyKeyword，它把关键词并进 news 主线）。
 *
 * 优先级（决定了超长时先丢谁）：
 *   ① 用户自己输入的关键词 —— 那是他的明确限定，最不该丢；
 *   ② 领域标签 —— 它是「同名不同人」最直接的区分轴，而且很短；
 *   ③ 候选卡的一句话身份（brief，如「小米创始人、金山董事长」）—— 最能锁定具体是谁，
 *      但也最长，因此排在最后、超限时整段丢弃（不截半句，半个公司名比没有更坏）。
 *
 * 返回值：单行、空格分隔、无重复、长度不超过 `KEYWORD_MAX_CHARS`（与检索层同一档）；可能为空串。
 * **绝不进 personKey / 缓存键**（同 splitPersonQuery 的约定），角色只是「这一次查什么」。
 */
export function buildCandidateKeyword(parts: {
  /** 用户输入里拆出的补充关键词（可空） */
  keyword?: string
  /** 候选的领域（码或自由短串），会经 domainLabel 转成给人看的标签 */
  domain?: string
  /** 候选卡上的一句话身份 / 代表事件（可空） */
  brief?: string
}): string {
  const out: string[] = []
  let len = 0
  const push = (raw?: string): void => {
    const s = cleanPart(raw || '')
    if (!s || out.includes(s)) return
    /* 第一段不受「加空格」影响；后面每段都要多算一个空格 */
    const next = len === 0 ? s.length : len + 1 + s.length
    if (next > KEYWORD_MAX_CHARS) return
    out.push(s)
    len = next
  }
  push(parts.keyword)
  push(parts.domain ? domainLabel(parts.domain) : '')
  /*
   * brief 是「一句话身份」，常见形态是顿号分隔的多段（「小米创始人、金山董事长」）。
   * 整段丢太浪费，逐段塞、塞到放不下为止 —— 每段仍必须完整（半个公司名比没有更坏）。
   */
  for (const seg of (parts.brief || '').split(/[、,，;；/／|｜]+/)) push(seg)
  return out.join(' ')
}
