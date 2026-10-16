'use strict'

/**
 * 报告页尾「同类名人」（S1-2，2026-10-16）。
 *
 * 这一块是「相关名人」的兜底：那边靠**共同话题**，交集为空就整块不渲染，而没收藏过报告的人
 * （绝大多数、尤其新用户）根本没有候选 —— 读完报告的页尾因此什么都没有，动线到此为止。
 * 这里改用**领域**兜底：只要有榜单就一定取得到人（`utils/hot-board.ts`，AI 每日榜 →
 * 真实热度 → 静态种子三级兜底）。数据不新造链路，所以用例也不去钉榜单本身
 * （那份在 01-pure / 51-fallback-order 里）。
 *
 * 钉的是三件**会不报错地坏掉**的事：
 *   1. 同领域只能用**相等**判断。领域自 2026-10-12 起是自由短串，一旦有人改用 `domainStyleCode`
 *      之类做归一，所有自创领域会被并进 'other' —— 推荐出来的人彼此毫无关系，而且没人会发现。
 *      第一条用例拿真实行为把这个后果演示出来，而不是只判一句字符串；
 *   2. 必须排除本人，否则会出现「读完 TA 的报告，页尾推荐你再读一遍 TA」；
 *   3. 两块**不会同时出现**：它们回答的是同一个问题（接下来读谁），连着摆两串人只会让人再挑一遍。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, eq, notOk } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 注释里会写反例（如「不许用 domainStyleCode 归一」），不剥会把反例当成真实用法 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')

const REPORT_PAGE = 'package/report/index.tsx'
const REPORT_SCSS = 'package/report/index.scss'

/** 取出 loadPeers 的函数体（顶格 `}` 收尾） */
const peersFn = () => {
  const m = /async function loadPeers[\s\S]*?\n}/.exec(stripComments(read(REPORT_PAGE)))
  ok(m, 'loadPeers 应还在：它是页尾推荐位唯一的数据来源')
  return m ? m[0] : ''
}

describe('报告页尾「同类名人」：相关名人的领域兜底（S1-2）', () => {
  it('同领域只能判相等 —— 拿样式码归一，会把所有自创领域并成一桶', () => {
    const d = env.load('config/domains')
    /* 自由化后的自创领域原样保留 */
    eq(d.sanitizeDomain('新能源汽车'), '新能源汽车', '自创领域应原样保留')
    /* 而「样式码」只认 12 个已知码，其余一律 other —— 这正是不能拿它做同领域判断的原因：
       一用，所有自创领域的人就互相推荐了（彼此毫无关系，且不报任何错） */
    eq(d.domainStyleCode('新能源汽车'), 'other', '不认识的一律映射到 other（所以它不能用来判同类）')
    eq(d.domainStyleCode('tech'), 'tech')
    /* 相等判断下的正确结果：同串才算同类 */
    notOk('新能源汽车' === '新能源汽车产业', '相邻但不同的领域不是同类')

    const fn = peersFn()
    ok(/p\.domain === domain/.test(fn), '同领域判断必须是原始领域串相等')
    notOk(
      /domainStyleCode|isDomainCode/.test(fn),
      '这里不许做领域归一/映射：一映射，自创领域就全并进 other（见上面两条断言的后果）'
    )
    ok(
      /domain === 'other'/.test(fn),
      "'other' 是「领域没填上」的兜底桶，那一桶里的人彼此无关，凑一起就是随机推荐"
    )
  })

  it('排除本人：榜单里若正好有 TA，不该推荐「再读一遍 TA」', () => {
    const fn = peersFn()
    ok(/exclude\.has\(/.test(fn), 'loadPeers 应按 exclude 过滤')
    ok(
      /new Set\(\[rep\.personKey\]\)/.test(stripComments(read(REPORT_PAGE))),
      '调用处必须把本人放进去 —— 只比名字不够：key 里还有领域段，同名不同领域是两个人'
    )
  })

  it('只在「相关名人」为空时才取，两块不会同时出现', () => {
    const code = stripComments(read(REPORT_PAGE))
    const m = /loadRelated\(rep\)\.then\(async \(rows\) => \{[\s\S]*?\n    \}\)/.exec(code)
    ok(m, '找不到相关名人的加载块')
    const body = m ? m[0] : ''
    ok(
      /if \(rows\.length > 0\) \{[\s\S]*?return\s*\n?\s*\}/.test(body),
      '有相关名人时应提前 return：两块回答同一个问题，连着摆两串人只会让用户再挑一遍'
    )
    ok(
      body.indexOf('loadPeers') === -1 || body.indexOf('return') < body.indexOf('loadPeers'),
      '顺序反了：先取同类名人再判断，等于白读一次榜单（有收藏的用户根本用不上）'
    )
  })

  it('关注复用同一个 toggleFollow，且按钮先吃掉点击（否则点关注会跳进对方报告）', () => {
    const code = stripComments(read(REPORT_PAGE))
    ok(
      /toggleFollow\(p\.personKey, 'report_peer'\)/.test(code),
      '推荐位的关注要复用 utils/follows 的 toggleFollow，不另写一份写库：两套才会出现一边能取关、另一边报错'
    )
    notOk(/db\.collection\('follows'\)/.test(code), '页面不该直接写 follows 集合')
    ok(
      /page-report__peer-follow[\s\S]{0,700}?stopPropagation[\s\S]{0,200}?onTogglePeerFollow/.test(code),
      '关注按钮必须先 stopPropagation 再提交 —— 整行是可点跳转的，不拦就是「点关注 → 跳走」'
    )
  })

  it('样式齐全：两态胶囊 + 单行省略（动态速览长度不可控）', () => {
    const scss = read(REPORT_SCSS)
    /*
     * 修饰符在本文件里是 BEM 嵌套写法（`&--on`），所以判断要**限定在这个块的范围内**：
     * 裸判 `&--on {` 会命中文件里第一个同名修饰符（如 __watch--on），
     * 于是观测位这一块即使整段被删也照样通过 —— 那是假绿。
     */
    const block = /&__peer-follow \{[\s\S]*?\n  \}/.exec(scss)
    ok(block, '样式缺 &__peer-follow')
    for (const sel of ['&--tap {', '&--on {', '&--busy {']) {
      ok(block && block[0].includes(sel), `关注胶囊缺 ${sel}`)
    }
    ok(scss.includes('&__related-words--peer {'), '样式缺 &__related-words--peer')
    ok(/text-overflow:\s*ellipsis/.test(scss), '动态速览可能是一整条标题，必须单行省略')
  })
})
