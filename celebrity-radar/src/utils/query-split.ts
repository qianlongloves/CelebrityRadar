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
