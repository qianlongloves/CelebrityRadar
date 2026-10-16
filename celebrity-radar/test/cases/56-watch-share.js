'use strict'

/**
 * 「我在盯的人」分享框与落地引导（S2-1，2026-10-16）。
 *
 * 这条链路的赌注是：**平台上稀缺的不是内容，是关系**。转发一份报告，对方读到的是一段信息；
 * 转发「我在盯的人」，对方读到的是一个活人的判断 —— 而关注这件事本身是不需要报告就能做的。
 *
 * 而它失效的方式全是「静默」的，所以这里钉的不是「分享面板弹出来了」（那要真机才验得了）：
 *
 *   1. **标题与路径脱钩**：标题写「我在盯」、路径却忘了带 `from=watch` ⇒ 落地页读不出这次
 *      是好友分享，那条关注引导永远不出现，而分享侧的文案看起来一切正常（最贵的一种坏法）。
 *      故两者必须由 `personShare` 成对产出，页面不可能只改一半。
 *   2. **替用户编造关系**：没关注的人转发报告，文案却是「我在盯 TA」—— 对方点开一核对就露馅，
 *      而落地页也只能装不知道。故 `watched` 必须取真实关注态，页面里不许写死。
 *   3. **引导被报告卡住**：落地条若放在 `{report && ...}` 里，报告没生成（要等 30 秒）时
 *      连关注入口都没有 —— 恰恰是最容易丢人的那 30 秒。
 *   4. **关注写库分叉**：落地条自己再写一遍 follows ⇒ 一边能取关、另一边报失败。
 *   5. **标记散落**：页面各自拼一遍 `from=watch`，改标记时改一半，另一半静默失效。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, eq, notOk } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 注释里会写反例（如「不许写死 true」），不剥会把反例当成真实用法 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')

const REPORT_PAGE = 'package/report/index.tsx'
const REPORT_SCSS = 'package/report/index.scss'
const PROFILE_PAGE = 'package/profile/index.tsx'

/** 干净加载 utils/share（缓存与 storage 都清掉，避免上一用例的报告缓存串味） */
const SH = () => {
  env.resetAll()
  return env.load('utils/share')
}

/* ---------------------------------- 夹具 ---------------------------------- */

const dyn = (over = {}) => ({
  date: '2026-10-05',
  title: '出席发布会',
  summary: '摘要',
  source: '每日新闻',
  url: 'https://example.com/a',
  ...over
})

const dispute = (over = {}) => ({
  topic: '合约纠纷',
  claim: '2026-09 前经纪公司称合约未到期',
  response: '工作室称已于 8 月解约',
  basis: 'https://example.com/b',
  ...over
})

/** 最小可用报告：只放 share.ts 读到的字段（controversies / dynamics / intro） */
const mkReport = (over = {}) => ({
  personKey: '张三#tech',
  name: '张三',
  generatedAt: '2026-10-15T09:12:33.000Z',
  intro: '连续创业者。更多内容',
  dynamics: [dyn()],
  controversies: [],
  ...over
})

/* ═══════════════════════════ 1. 分享框 ═══════════════════════════ */

describe('「我在盯」分享框：标题与落地路径必须成对产出（S2-1）', () => {
  it('关注了 TA 才写「我在盯」，且同一次返回值里就带上 from=watch', () => {
    const { personShare } = SH()
    const s = personShare({
      personKey: '张三#tech',
      name: '张三',
      domain: 'tech',
      report: mkReport({ controversies: [dispute()] }),
      watched: true
    })
    eq(s.title, '我在盯张三｜1 处公开争议', '标题该说分享者的动作，后半句仍是可核对的条数')
    ok(s.path.includes('from=watch'), `落地路径必须带标记，否则落地页读不出这是好友分享：${s.path}`)
    ok(s.path.includes(encodeURIComponent('张三#tech')), '路径仍要带 personKey —— 换框不该换掉落地对象')

    /* 静态：两个框的标题与路径只能从同一个分支里成对出来，不允许「只改标题」这种改法 */
    const code = stripComments(read('utils/share.ts'))
    const body = /export function personShare\([\s\S]*?\n\}/.exec(code)
    ok(body, '缺少 personShare（页面各自拼标题与路径，迟早漂移）')
    ok(
      /watchShareTitle\([\s\S]{0,200}watchSharePath\(/.test(body[0]),
      'watched 分支里标题与路径必须一起产出：标题说「我在盯」而路径没标记，引导永远不会出现'
    )
    ok(
      /personShareTitle\([\s\S]{0,200}reportSharePath\(/.test(body[0]),
      '未关注分支仍是「一份报告」框（含路径），两条分支都要完整'
    )
  })

  it('没关注的人仍走原来的报告框：不许替用户编造关系', () => {
    const { personShare } = SH()
    const r = mkReport({ controversies: [dispute()] })
    const off = personShare({ personKey: '张三#tech', name: '张三', domain: 'tech', report: r })
    eq(off.title, '张三 · 科技｜1 处公开争议', '默认（未关注）应保持原有标题')
    notOk(off.path.includes('from=watch'), '没关注就不该带落地标记')
    notOk(off.title.includes('我在盯'), '没关注不能说「我在盯」—— 对方点开就核对不了')

    const on = personShare({ personKey: '张三#tech', name: '张三', domain: 'tech', report: r, watched: true })
    ok(on.title.includes('我在盯'), '前提：watched=true 才有这个框')
    eq(on.path.split('&from=')[0], off.path, '两种框的落地对象（personKey / focus）应完全一致')
  })

  it('「我在盯」只改人头那半句：钩子、简介兜底、领域次序照旧', () => {
    const { watchShareTitle } = SH()
    eq(
      watchShareTitle('张三', 'tech', mkReport({ controversies: [], dynamics: [dyn(), dyn(), dyn()] })),
      '我在盯张三｜3 条近期动态',
      '没有争议但有动态时给「N 条近期动态」'
    )
    eq(
      watchShareTitle('张三', 'tech', mkReport({ controversies: [], dynamics: [], intro: '连续创业者。更多内容' })),
      '我在盯张三｜连续创业者',
      '两者都没有才回落可核对的简介首句'
    )
    notOk(watchShareTitle('张三', 'tech', mkReport({ controversies: [], dynamics: [], intro: '连续创业者' })).includes('更多内容'), '简介只取首句')
  })

  it('钩子与简介都没有时补领域：光一句「我在盯张三」说不清这人是谁', () => {
    const { watchShareTitle } = SH()
    const bare = mkReport({ controversies: [], dynamics: [], intro: '' })
    eq(watchShareTitle('张三', 'tech', bare), '我在盯张三 · 科技')
    /* 领域口径与 personShareTitle 共用一处：空 / 非法回落「名人」，自创短词原样展示 */
    eq(watchShareTitle('张三', '', bare), '我在盯张三 · 名人')
    eq(watchShareTitle('张三', 'not-a-code', bare), '我在盯张三 · not-a-code')
    eq(watchShareTitle('张三', 'tech', null), '我在盯张三 · 科技', '报告未就绪（分享面板在加载态也能调起）也要有可读标题')
  })

  it('标题仍按微信展示裁到 ~24 字，且不带分享者身份', () => {
    const { watchShareTitle } = SH()
    const long = '这是一个非常长的名人名字'.repeat(3)
    const t = watchShareTitle(long, 'tech', mkReport({ controversies: [dispute()] }))
    ok(t.length <= 25, `标题应裁到 ~24 字，实际 ${t.length}：${t}`)
    ok(t.startsWith('我在盯'), '截断该发生在名字/后半句，不能把「我在盯」裁掉')
    ok(t.endsWith('…'), '截断要补省略号')
    /* 只暴露「有人关注了 TA」这一件事：谁关注的、昵称、openid 一律不进标题 */
    notOk(/openid|昵称|微信号/i.test(t), `标题不得带分享者身份：${t}`)
  })

  it('focus 照旧往下传（对方点开即落在同一侧重）；isWatchShare 只认 watch 一个值', () => {
    const { watchSharePath, isWatchShare } = SH()
    ok(watchSharePath('张三#tech', 'risk').includes('focus=risk'), '侧重应随分享带过去')
    notOk(watchSharePath('张三#tech', 'all').includes('focus='), 'all 就是默认侧重，不必带（与 reportSharePath 同口径）')

    ok(isWatchShare('watch'), '自己写的标记必须认得出')
    for (const other of ['', 'report', 'Watch', ' watch', 'watch_share', 'watch=1']) {
      eq(isWatchShare(other), false, `只有 'watch' 算落地引导，'${other}' 应走普通分享`)
    }
    /* 大小写 / 空格 / 多余字符都不该被「宽松匹配」放过：认错人比认不出更贵 */
    const code = stripComments(read('utils/share.ts'))
    ok(/from\b/.test(code) && code.includes('WATCH_FROM'), '标记名应只有一处真源（WATCH_FROM）')
  })
})

/* ═══════════════════════════ 2. 落地页 ═══════════════════════════ */

describe('落地页：认出标记，把关注入口提到最前（S2-1）', () => {
  const code = () => stripComments(read(REPORT_PAGE))

  it('报告页读 from 并与分享侧同源，不自己比字符串', () => {
    ok(
      /isWatchShare\(decodeParam\(router\.params\.from/.test(code()),
      '参数应先过 decodeParam（坏编码不该在渲染期抛 URIError），再交给 isWatchShare 判定'
    )
    notOk(
      code().includes("=== 'watch'"),
      '页面里各写一遍字符串比较 = 标记改了页面不知道：判定只能有 utils/share#isWatchShare 一处'
    )
  })

  it('落地条摆在人物横幅之上，且不受「报告是否生成」影响', () => {
    const src = code()
    const heroIdx = src.indexOf("className='page-report__banner'")
    ok(heroIdx > 0, '前提：人物横幅的类名未变（本用例据此定位）')
    const head = src.slice(0, heroIdx)
    const inviteIdx = head.lastIndexOf("className='page-report__invite'")
    ok(inviteIdx > 0, '缺少好友分享落地条')
    const gateIdx = head.lastIndexOf('{report && (')
    ok(gateIdx >= 0, '前提：人物横幅仍由 {report && ...} 把守')
    ok(
      inviteIdx < gateIdx,
      '落地条不能放在 {report && ...} 里：报告未生成时（要等 30 秒）连关注入口都没有 —— 那正是最容易丢人的一段'
    )
  })

  it('等人读过关注态再渲染：已经关注的人不该被劝「快关注」', () => {
    const src = code()
    const gate = /watchArrival && followRead && !followed/.exec(src)
    ok(gate, '落地条应由 watchArrival / followRead / 未关注三者共同把守')
    const reads = src.match(/setFollowRead\(true\)/g) || []
    ok(reads.length >= 3, `未登录 / 读到 / 读失败三种出口都要放行，实际只有 ${reads.length} 处`)
    ok(/const \[followRead, setFollowRead\] = useState\(false\)/.test(src), '关注态读取进度要有独立状态（初值 false 不能直接当结论用）')
  })

  it('关注按钮复用唯一写库口 toggleFollow，来源标 watch_share', () => {
    const src = code()
    ok(src.includes("onToggleFollow('watch_share')"), '落地条的关注要能单独归因（来源标 watch_share）')
    ok(
      /toggleFollow\(personKey, source\)/.test(src),
      '关注只有一个写库口：落地条自己再写一遍 follows，会出现「一边能取关、另一边报失败」'
    )
    notOk(/db\.collection\('follows'\)/.test(src), '页面不得直连 follows 集合')
  })

  it('落点只报一次：这条入口带来多少人，一人一次才对得上', () => {
    const src = code()
    ok(src.includes("track('watch_share_arrive'"), '落点要埋点，否则 S2-1 只能凭感觉结项')
    ok(/arrivalTrackedRef\.current/.test(src), '缺「每个页面实例只报一次」的闸：重复上报会把入口转化算歪')
    ok(
      /\|\s*'watch_share_arrive'/.test(stripComments(read('utils/events.ts'))),
      'watch_share_arrive 要登记在 TrackEvent 枚举里，否则埋点被类型挡下（或写错名字静默丢弃）'
    )
  })

  it('落地条样式齐全：名字再长也单行省略，不撑高首屏', () => {
    const scss = read(REPORT_SCSS)
    /*
     * 这几个选择器是**兄弟关系**（都挂在 & 下、各自成块），不是嵌套 —— 取「&__invite 那一块」
     * 只会拿到它自己的四行属性，后面的 main/title/note/btn 全在块外。故从 &__invite 起、
     * 到「&__invite-btn 那个块自己闭合」为止整段切出来。
     */
    const start = scss.indexOf('&__invite {')
    const btnStart = scss.indexOf('&__invite-btn {', start)
    ok(start > 0 && btnStart > start, '缺少 &__invite / &__invite-btn 样式块')
    const btnEnd = scss.indexOf('\n  }', btnStart)
    ok(btnEnd > btnStart, '&__invite-btn 块未闭合')
    const block = scss.slice(start, btnEnd)

    for (const needle of ['&__invite-main {', '&__invite-title {', '&__invite-note {', '&__invite-btn {', '&--tap {']) {
      ok(block.includes(needle), `落地条缺 ${needle}`)
    }
    /* 选择器名相同、少一条 text-overflow 也能编译通过，只是名字长了会换行把首屏顶下去 */
    const ellipsis = block.match(/text-overflow: ellipsis/g) || []
    ok(ellipsis.length >= 2, `标题与副文案都要单行省略（人名长度不可控），实际 ${ellipsis.length} 处`)
  })
})

/* ═══════════════ 3. 分享框随关系换：两页同口径 ═══════════════ */

describe('分享框随关注态换框：报告页与名人主页同一口径（S2-1）', () => {
  it('两处都用 personShare，watched 取真实关注态 —— 页面里不许写死', () => {
    for (const [file, pattern] of [
      [REPORT_PAGE, /const share = personShare\(\{[\s\S]{0,200}watched: followed/],
      [PROFILE_PAGE, /personShare\(\{[\s\S]{0,120}watched: followed/]
    ]) {
      const src = stripComments(read(file))
      ok(pattern.test(src), `${file} 应通过 personShare 产出分享标题与路径，watched 取关注态`)
      notOk(/watched:\s*true/.test(src), `${file} 不许写死 watched: true —— 那是替用户编造「我在盯」`)
    }
  })

  it('转发与朋友圈同源，且带上 frame 埋点（用来算「分享 → 打开」）', () => {
    for (const file of [REPORT_PAGE, PROFILE_PAGE]) {
      const src = stripComments(read(file))
      const frame = src.match(/frame: followed \? 'watch' : 'report'/g) || []
      eq(frame.length, 2, `${file} 的转发与朋友圈都要带 frame（实际 ${frame.length} 处）`)
      ok(
        src.includes('useShareAppMessage(') && src.includes('useShareTimeline('),
        `${file} 两个分享回调都要在（朋友圈单页模式看到的是同一句话）`
      )
      /* 标题与路径只能来自同一个 share 对象：一处改成 personShareTitle、另一处留着 share.title，
         同一条链接就会一边一个说法（而分享出去的东西事后没法改） */
      eq((src.match(/share\.title/g) || []).length, 2, `${file} 两处分享回调都应取同一份 share.title`)
      eq((src.match(/share\.path/g) || []).length, 2, `${file} 两处分享回调都应取同一份 share.path`)
    }
  })

  it('from=watch 只在 utils/share.ts 里拼：页面各自拼一遍就会与标题对不上', () => {
    const shareSrc = stripComments(read('utils/share.ts'))
    ok(shareSrc.includes('WATCH_FROM') && shareSrc.includes('FROM_KEY'), '标记与参数名应有真源')
    for (const file of [REPORT_PAGE, PROFILE_PAGE]) {
      const src = stripComments(read(file))
      notOk(/from=watch/.test(src), `${file} 不得自己拼 from=watch`)
      notOk(/WATCH_FROM/.test(src), `${file} 只该用 isWatchShare 判定，不该碰标记常量`)
    }
  })
})
