'use strict'

/**
 * 两份 JSON 修复器副本不许再漂：端上 `src/utils/llm.ts` ↔ 云函数 `cloudfunctions/hotBoardRefresh/index.js`
 *
 * 云函数不能 import 端上 TS，所以 `repairJson` 是**手抄的第二份**。抄完就漂过一次：端上补齐了
 * 「结构位全角标点归一」（⑤）与「顶层单元素数组解包」，云函数还停在旧的四条 —— 表现是热榜
 * 「模型明明返回了、却判成榜单不合格」，一次调用烧掉 6 组检索 + 一次生成，而且只在 cron 里静默发生
 * （端上那条路径至少还有用户会重试）。
 *
 * 这条用例读的是**源码字面量**，不是行为：行为用例只能覆盖「已经跑起来的那一份」，覆盖不了
 * 「另一份忘了改」。改动任一端就必须同步另一端，否则红。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(p, 'utf8')

const LOCAL = read(path.join(ROOT, 'src', 'utils', 'llm.ts'))
const CLOUD = read(path.join(ROOT, 'cloudfunctions', 'hotBoardRefresh', 'index.js'))

/**
 * 抠出 `const FULLWIDTH_PUNCT = { ... }` 这一段。
 * 不能用 `indexOf('}')` 收尾 —— 映射里的**值**就含 `}`（`'｝': '}'`），会切在半路上；
 * 末尾那个 `}` 顶格，所以按「行首的 }」收。
 */
const mapBody = (src) => {
  const m = src.match(/const FULLWIDTH_PUNCT[\s\S]*?\n\}/)
  return m ? m[0] : ''
}

/** 该段里的 `'，': ','` 键值对（排序后比较，免得顺序差异造成假红） */
const pairs = (body) => (body.match(/'([^']*)'\s*:\s*'([^']*)'/g) || []).sort()

/** 取某个函数体的开头一段，用于断言「候选扫描认得什么」 */
const fnHead = (src, marker) => {
  const at = src.indexOf(marker)
  return at < 0 ? '' : src.slice(at, at + 2000)
}

describe('两份 JSON 修复器副本不许漂（端上 utils/llm.ts ↔ hotBoardRefresh/index.js）', () => {
  it('全角标点映射逐条一致，且只有结构位的六个（全角引号刻意不在其中）', () => {
    const local = mapBody(LOCAL)
    const cloud = mapBody(CLOUD)
    ok(local !== '', '端上找不到 FULLWIDTH_PUNCT')
    ok(cloud !== '', '云函数找不到 FULLWIDTH_PUNCT（第 ⑤ 条漏了）')
    deepEq(pairs(cloud), pairs(local))
    eq(pairs(local).length, 6, `只该收结构位的六个全角标点，实际 ${pairs(local).length} 条`)
  })

  it('候选扫描两端都认全角括号（不认的话连候选片段都取不出来，「语法错」都判不成）', () => {
    const cases = [
      ['端上', fnHead(LOCAL, 'function scanJsonCandidates')],
      ['云函数', fnHead(CLOUD, 'function extractJson')]
    ]
    for (const [name, head] of cases) {
      ok(head !== '', `${name}找不到候选扫描函数`)
      ok(head.includes("'｛'"), `${name}的候选扫描没认全角开括号`)
      ok(head.includes("'｝'"), `${name}的候选扫描没认全角闭括号`)
    }
  })

  it('「收尾引号后面」的判据两端都认全角（否则键的收尾引号会被当正文引号转义，结构直接崩）', () => {
    ok(/FULLWIDTH_PUNCT\[next\]/.test(LOCAL), '端上判据没认全角')
    ok(/FULLWIDTH_PUNCT\[next\]/.test(CLOUD), '云函数判据没认全角')
  })

  it('顶层单元素数组解包两端都有（否则正文一个字不差也会被判「没按格式答」）', () => {
    ok(/function unwrapSingleObject/.test(LOCAL), '端上缺 unwrapSingleObject')
    ok(/function unwrapSingleObject/.test(CLOUD), '云函数缺 unwrapSingleObject')
  })
})
