'use strict'

/**
 * 预警页消费推送落点参数（S1-3，2026-10-16）。
 *
 * 这条链路的全部风险在**「静默失效」**：订阅消息的 `page` 里带着 `?keyword=<词>`，
 * 点进来本该直接看到那个词怎么了；而这一页此前根本不读参数，用户落地后是七八个词并列的
 * 表格加一叠卡片，得自己再找一遍 —— 推送刚建立的「有事发生」那点确定性又丢掉了。
 *
 * 更麻烦的是，这类参数链路坏掉时**两端都不报错**：
 *   · 云端把参数名写成 `key`、端上读 `keyword` → 谁都不知道对不上；
 *   · 端上不归一化就比对 → 词里多一个空格就匹配不上，高亮和滚动都没有任何外在表现；
 *   · 页面重构时把读参数那段删了 → 编译照样通过，只是回到了旧行为。
 * 所以这里钉的是**两端参数名同源 + 端上归一化口径 + 四种落点都在**，
 * 而不是「点一下通知会滚过去」这种行为（那要真机才验得了）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, eq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.resolve(ROOT, 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/** 注释里会写反例（如「不归一会匹配不上」），不剥会把反例当成真实用法 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')

const ALERTS_PAGE = 'package/alerts/index.tsx'
const ALERTS_SCSS = 'package/alerts/index.scss'
const CLOUD = path.resolve(ROOT, 'cloudfunctions', 'keywordAlert', 'index.js')

describe('预警页消费推送落点：点通知进来就该看到那个词（S1-3）', () => {
  it('云端 page 里的参数名与端上读的是同一个 —— 名字不一致时两端都不报错', () => {
    const cloud = fs.readFileSync(CLOUD, 'utf8')
    /* 顺带把路径与「带的是哪个词」一起钉住：路径错了到不了页面（S0-1 的老坑），
       带的不是 top.keyword 则端上永远匹配不上自己的订阅列表 */
    const m = /page:\s*`(package\/alerts\/index)\?(\w+)=\$\{encodeURIComponent\(([\w.]+)\)\}`/.exec(cloud)
    ok(m, 'keywordAlert 的订阅消息应带上是哪个词（page 形如 package/alerts/index?keyword=...）')
    eq(m[2], 'keyword', `云端用的参数名是 ${m[2]}，端上读的是 keyword：对不上时点通知进来看不到任何定位`)
    eq(m[3], 'top.keyword', '带的应是本轮命中的那个词本身（不是别的派生字段），端上才比得中订阅列表')
    ok(
      stripComments(read(ALERTS_PAGE)).includes('router.params.keyword'),
      '端上应读 router.params.keyword —— 不该回退到「不读参数」的旧行为'
    )
  })

  it('端上先归一化再比对，且走 decodeParam（与写库、与 S0-3 同口径）', () => {
    const { normalizeKeyword } = env.load('utils/keyword-alert')
    /* 写库时存的就是归一后的词（见 utils/keyword-alert#addWatch），推送带的也是它 */
    const stored = normalizeKeyword('雷军  发布会')
    eq(stored, '雷军 发布会', '归一化应把连续空白压成一个空格')
    /* 端上再归一一次是幂等的 —— 这是「拿参数能比中库里那条」的前提 */
    eq(normalizeKeyword(stored), stored, '对已归一的词再归一应不变（否则永远匹配不上）')
    eq(normalizeKeyword(' 雷军 发布会 '), stored, '首尾空白也要吃掉')

    const code = stripComments(read(ALERTS_PAGE))
    ok(
      /normalizeKeyword\(decodeParam\(router\.params\.keyword/.test(code),
      '参数必须先过 decodeParam（坏编码不该在渲染期抛 URIError），再归一化后与订阅列表比对'
    )
  })

  it('四种落点各有各的话：未登录 / 已定位到组 / 暂无报道 / 已不在监测', () => {
    const code = stripComments(read(ALERTS_PAGE))
    /*
     * 判别串一律带模板字面量的反引号或结尾引号：否则注释里那些
     * 「说成『已不在监测中』」的解释句也能让断言通过，等于没钉住。
     */
    for (const [needle, label] of [
      ['`登录后查看「', '未登录（参数在、但列表读不出来）'],
      ['有新报道`', '已定位到下方那一组'],
      ['`正在监测「', '还在监测、但还没有报道'],
      ['」已不在监测中`', '已在别处取消过']
    ]) {
      ok(code.includes(needle), `缺少「${label}」这一种落点的文案：用户会拿到一句与自己处境不符的话`)
    }
  })

  it('落点埋点与文案共用同一处处境判定，且每个词只报一次', () => {
    const code = stripComments(read(ALERTS_PAGE))
    ok(
      code.includes("track('alert_focus'"),
      '落点应埋点：这是「推送 → 点开 → 看到那个词」的最后一跳，没有它就只能凭感觉说有没有用'
    )
    ok(
      /\|\s*'alert_focus'/.test(stripComments(read('utils/events.ts'))),
      'alert_focus 要登记在 TrackEvent 枚举里，否则埋点会被类型挡下（或写错名字静默丢弃）'
    )
    /* useDidShow 每次进页都 refresh，没有闸就会重复上报，比例全被稀释 */
    ok(
      /trackedFocus\.current === focusKeyword/.test(code),
      '缺「每个词只报一次」的闸：重复上报会把落点分布算歪'
    )
    ok(
      /FOCUS_COPY\[focusKind\]/.test(code),
      '文案与埋点必须共用同一处处境判定：两边各算一遍，迟早一个说「有新报道」、一个记成「已不在监测」'
    )
  })

  it('高亮类名与滚动选择器同源，且「只滚一次」的闸还在', () => {
    const code = stripComments(read(ALERTS_PAGE))
    const decl = /const FOCUS_GROUP_CLASS = '([^']+)'/.exec(code)
    ok(decl, '定位组的类名应提成一个常量：JSX 与滚动选择器各写一遍，迟早对不上（且不报错）')
    ok(decl[1].startsWith('page-alerts__'), `类名应在页面命名空间内，实际是 ${decl[1]}`)
    ok(
      (code.match(/FOCUS_GROUP_CLASS/g) || []).length >= 3,
      '常量应被声明 + JSX + pageScrollTo 三处共用，只声明不用等于又抄了一遍'
    )
    ok(
      /pageScrollTo\(\{\s*selector:\s*`\.\$\{FOCUS_GROUP_CLASS\}`/.test(code),
      '滚动选择器必须用同一个常量拼，不能手抄类名'
    )
    /* useDidShow 每次进页都 refresh，没有闸就会把正在读列表的人反复拽回那一组 */
    ok(
      /scrolledTo\.current === focusKeyword/.test(code),
      '缺「只滚一次」的闸：每次 refresh 都重新滚会把用户从当前位置拽走'
    )
  })

  it('三处高亮与定位条都有样式（样式漏了只会「看不出高亮」，最难发现）', () => {
    const scss = fs.readFileSync(path.join(SRC, ALERTS_SCSS), 'utf8')
    /* 判「选择器定义」（带 ` {`）而不是裸名字：裸名字在本文件里到处都是 */
    for (const sel of ['&__focus {', '&__chip--focus {', '&__tr--focus {', '&__group--focus {']) {
      ok(scss.includes(sel), `样式缺 ${sel}：类名加上去了却没有对应的定义，页面上什么都不会变`)
    }
  })
})
