'use strict'

/**
 * 入口参数的两条纪律（2026-10-16）：云函数里的端上路径、页面参数的安全解码。
 *
 * 两者是同一类故障 —— 一端改了，**另一处没跟着改**，而且都只在「用户真的从分享 / 推送点进来」
 * 时才会暴露：
 *
 *   1. 分包改造（2026-10-14）把 19 个二级页挪进 `package/`，端上 21 处跳转全改了，云函数 3 处
 *      订阅消息的 `page` 参数漏了（`pages/alerts/index`、`pages/report/index`）。云函数与端上解耦，
 *      TS 与静态检查都碰不到它，表现是「消息发得出去、用户点开却到不了目标页」—— 而那是全项目
 *      唯一的主动召回链路。
 *   2. 7 个页面直接用 `decodeURIComponent(router.params.x)`：对非法百分号编码会抛 URIError
 *      （转发被截断、小程序码 scene 残串都会带进来），而它在 render 期间抛出就是**整页白屏**。
 *
 * 两条都属于「另一处忘了改」型，行为用例只能覆盖已经跑起来的那一份，所以这里读**源码字面量**
 * 并与 `app.config.ts` 的注册表、`utils/route.ts` 的出口对照（同 17-repair-sync.js 的路子）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const readRoot = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/**
 * 剥块注释与整行 `//` 注释：注释里会写反例路径（如「写成 pages/report/index 会点不开」），
 * 不剥就会把反例当成真实用法，用例自己先红（18-user-config.js 的 stripComments 同理）。
 * 只剥**整行**的 `//` —— 行内那种可能落在 URL（`https://`）里，剥了会把字符串切坏。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')

/** 从 app.config.ts（**注册表唯一真源**）推出全部合法页面路径 */
function registeredPaths(src) {
  const out = new Set()
  const code = stripComments(src)
  /* 主包 pages：顶层、两空格缩进（分包里那份是 6 空格，不会被这条捞到） */
  const main = (code.match(/\n  pages:\s*\[([\s\S]*?)\n  \]/) || [])[1] || ''
  for (const m of main.matchAll(/'([^']+)'/g)) out.add(m[1])
  /* 分包：pages 里写的是相对 root 的路径，拼成完整路径 */
  const sub = (code.match(/subpackages:\s*\[([\s\S]*?)\n  \]/) || [])[1] || ''
  const root = (sub.match(/root:\s*'([^']+)'/) || [])[1] || ''
  const pages = (sub.match(/pages:\s*\[([\s\S]*?)\]/) || [])[1] || ''
  for (const m of pages.matchAll(/'([^']+)'/g)) out.add(`${root}/${m[1]}`)
  return out
}

/** 云函数源码（只读 index.js：config.json 里只有权限声明，不含路径） */
function cloudSources() {
  const dir = path.join(ROOT, 'cloudfunctions')
  return fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, 'index.js')))
    .map((name) => ({ name, code: stripComments(readRoot(path.join('cloudfunctions', name, 'index.js'))) }))
}

describe('云函数里的端上页面路径必须真实注册过（分包改造的漏改防线）', () => {
  const registered = registeredPaths(readRoot('src/app.config.ts'))

  it('注册表解析自检：主包 4 个 tab 页与分包二级页都必须读到', () => {
    /* 刻意不写死总数（将来增删页面不该让本用例变红），但两个来源各自的关键路径都要在 ——
       解析一旦退化成「只读到主包」，这里立刻红，而不是让下面那条检查悄悄空跑 */
    for (const p of ['pages/index/index', 'pages/mine/index', 'pages/ask/index', 'pages/opinion/index']) {
      ok(registered.has(p), `主包注册表少了 ${p}`)
    }
    for (const p of ['package/report/index', 'package/alerts/index', 'package/weekly/index']) {
      ok(registered.has(p), `分包注册表少了 ${p}`)
    }
    ok(registered.size >= 20, `只解析出 ${registered.size} 个路径，分包那一段多半没读到`)
  })

  it('云函数里出现的每个页面路径都必须注册过', () => {
    const bad = []
    const files = cloudSources()
    /* 扫不到目录时不能「静默通过」—— 那会让本用例变成永远绿的空壳 */
    ok(files.length >= 10, `只读到 ${files.length} 个云函数，扫描范围可能不对`)
    for (const { name, code } of files) {
      for (const m of code.matchAll(/(?:^|[^\w/])((?:pages|package)\/[A-Za-z0-9_-]+\/index)/g)) {
        if (!registered.has(m[1])) bad.push(`${name}: ${m[1]}`)
      }
    }
    deepEq(bad, [], `云函数里出现了未注册的页面路径（多半是分包漏改，用户点开到不了目标页）：\n  ${bad.join('\n  ')}`)
  })

  it('订阅消息的落点必须写死为注册路径（不是变量拼出来的）', () => {
    const blocks = []
    for (const { name, code } of cloudSources()) {
      let at = code.indexOf('subscribeMessage.send')
      while (at >= 0) {
        blocks.push({ name, body: code.slice(at, at + 600) })
        at = code.indexOf('subscribeMessage.send', at + 1)
      }
    }
    /* 三条推送：关注动态 / 关键词预警 / 风险提醒。少于三条说明有人改了发送入口 ——
       那正是「推送悄悄没了」的典型形态（云函数只在 cron 里跑，没有用户会重试） */
    ok(blocks.length >= 3, `只找到 ${blocks.length} 处 subscribeMessage.send，应至少 3 处`)
    for (const b of blocks) {
      const m = b.body.match(/page:\s*[`'"]([^`'"?]+)/)
      ok(!!m, `${b.name} 的 subscribeMessage.send 没写 page（用户点开消息将无处可去）`)
      ok(registered.has(m[1]), `${b.name} 的推送落点 ${m[1]} 不是注册路径`)
    }
  })
})

describe('页面参数必须走 utils/route 的安全解码（坏参数不白屏）', () => {
  /** 全部会解析页面参数的二级页；新增页若也解析参数，应一并加进来 */
  const PAGES = [
    'package/report/index.tsx',
    'package/profile/index.tsx',
    'package/qa/index.tsx',
    'package/compare/index.tsx',
    'package/topic/index.tsx',
    'package/event/index.tsx',
    'package/link-preview/index.tsx'
  ]

  it('decodeParam：正常值照常解码，坏编码退回空串而不抛', () => {
    const { decodeParam } = env.load('utils/route')
    eq(decodeParam(encodeURIComponent('雷军#tech')), '雷军#tech')
    eq(decodeParam(encodeURIComponent('张三（演员）')), '张三（演员）')
    eq(decodeParam('张三#tech'), '张三#tech')
    /* 三种坏输入：孤立的 %、非法转义、被截断的多字节序列 */
    eq(decodeParam('%'), '')
    eq(decodeParam('%zz'), '')
    eq(decodeParam('%E9%9B'), '')
    eq(decodeParam(undefined), '')
    eq(decodeParam(null), '')
    eq(decodeParam(''), '')
    /* 反证：原生确实会抛，否则上面几条「不抛」的断言就没有意义 */
    let threw = false
    try {
      decodeURIComponent('%zz')
    } catch {
      threw = true
    }
    ok(threw, 'decodeURIComponent 对 %zz 竟然不抛，本用例的故障前提失效')
  })

  it('七个解析页面参数的页面都不再直接用 decodeURIComponent', () => {
    const bad = []
    for (const p of PAGES) {
      const code = stripComments(readRoot(path.join('src', p)))
      if (code.includes('decodeURIComponent(')) bad.push(p)
    }
    deepEq(
      bad,
      [],
      `这些页面还在直接用 decodeURIComponent（坏参数会在 render 期抛错、整页白屏），应改走 decodeParam：\n  ${bad.join('\n  ')}`
    )
  })

  it('缺参数的落地页给的是出路，而不是点不完的「重试」', () => {
    const code = readRoot(path.join('src', 'package/report/index.tsx'))
    ok(code.includes('去首页搜名人'), 'report 页缺 personKey 时应给出「去首页搜名人」的出路，而不是只给「重试」')
    ok(
      /switchTab\(\{\s*url:\s*'\/pages\/index\/index'/.test(code),
      '那条出路必须真的走得通（switchTab 到主包首页）'
    )
  })
})
