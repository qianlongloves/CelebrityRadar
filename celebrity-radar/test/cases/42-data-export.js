'use strict'

/**
 * 个人信息副本导出（PIPL 第 45 条「查阅、复制」，2026-10-14 新增）。
 *
 * 钉住五件事：
 *   1. **未登录不产出假副本**：直接返回 null，而不是把一堆空数组拼成一份「看起来没有数据」的
 *      JSON —— 那比报错更容易让用户以为「我的数据没了」；
 *   2. **只导出本人数据**：四张表都按 openid 过滤，别人的行一条都不能混进来；
 *   3. **字段映射**：老关键词订阅（无 type 字段）按 keyword 归一，person_key 缺失补 null；
 *   4. **只读**：导出不发任何写请求（写库计数器前后必须一致）；
 *   5. **入口真的接在页面上**：静态读 pages/mine/index.tsx，钉住菜单项与处理函数（页面 .tsx
 *      不进测试编译，与既有页面用例同法读源码文本断言）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, 'src', p), 'utf8')

const ME = 'me'
const OTHER = 'other'

/** 设一个已登录用户；返回 load（模块缓存已清空） */
function withUser(userId = ME) {
  env.resetAll()
  const auth = env.load('stores/auth')
  auth.useAuth.setState({ userId, nickname: '测试用户' })
  return env.load
}

/** 四张表的样例数据：本人各若干 + 他人若干（他人行必须一条都不出现在副本里） */
function seedMixed() {
  env.db.__seed('follows', [
    { _id: 'f1', id: `${ME}#张三#娱乐`, openid: ME, person_key: '张三#娱乐', name: '张三', domain: '娱乐', followed_at: '2026-10-01T00:00:00.000Z' },
    { _id: 'f2', id: `${ME}#李四#商业`, openid: ME, person_key: '李四#商业', name: '李四', domain: '商业', followed_at: '2026-10-02T00:00:00.000Z' },
    { _id: 'f3', id: `${OTHER}#王五#体育`, openid: OTHER, person_key: '王五#体育', name: '王五', domain: '体育', followed_at: '2026-10-03T00:00:00.000Z' }
  ])
  env.db.__seed('favorites', [
    { _id: 'v1', id: `${ME}#quote#abc12345`, openid: ME, type: 'quote', payload: { text: '一句话' }, person_key: '张三#娱乐', name: '张三', created_at: '2026-10-04T00:00:00.000Z' },
    { _id: 'v2', id: `${OTHER}#report#def`, openid: OTHER, type: 'report', payload: {}, person_key: '王五#体育', name: '王五', created_at: '2026-10-05T00:00:00.000Z' }
  ])
  env.db.__seed('history', [
    { _id: 'h1', id: `${ME}#1`, openid: ME, person_key: '张三#娱乐', name: '张三', ts: '2026-10-06T00:00:00.000Z' },
    { _id: 'h2', id: `${OTHER}#2`, openid: OTHER, person_key: '王五#体育', name: '王五', ts: '2026-10-07T00:00:00.000Z' }
  ])
  env.db.__seed('keyword_watches', [
    { _id: 'w1', id: `${ME}#代言`, openid: ME, keyword: '代言', created_at: '2026-10-08T00:00:00.000Z', seen_at: null, type: 'keyword' },
    /* 老数据：没有 type 字段（2026-10-08 那批关键词订阅），读侧必须按 keyword 处理 */
    { _id: 'w2', id: `${ME}#张三`, openid: ME, keyword: '张三', created_at: '2026-10-09T00:00:00.000Z', seen_at: null },
    { _id: 'w3', id: `${OTHER}#李四`, openid: OTHER, keyword: '李四', created_at: '2026-10-10T00:00:00.000Z', seen_at: null, type: 'person' }
  ])
}

/** 只取写库计数器（db.stats 不随 resetAll 清零，只能比差值，不能与 0 比） */
function writeCounters() {
  const s = env.db.stats
  return {
    add: s.addCalls,
    update: s.updateCalls,
    remove: s.removeCalls,
    docSet: s.docSetCalls,
    docUpdate: s.docUpdateCalls
  }
}

describe('42 个人信息副本导出（PIPL 第 45 条）', () => {
  it('未登录：返回 null（不把空数组拼成假副本），且不读库', async () => {
    env.resetAll()
    const exp = env.load('utils/data-export')
    seedMixed()

    const before = env.db.stats.getCalls
    const bundle = await exp.buildMyDataBundle()

    eq(bundle, null)
    eq(env.db.stats.getCalls, before, '未登录就应该在拼包前短路，不该去打四张表')
  })

  it('只导出本人数据：四张表都按 openid 过滤，他人行不混入', async () => {
    const load = withUser()
    seedMixed()
    const exp = load('utils/data-export')

    const b = await exp.buildMyDataBundle()
    ok(b !== null)

    eq(b.account.user_id, ME)
    eq(b.account.nickname, '测试用户')
    eq(b.follows.length, 2)
    eq(b.favorites.length, 1)
    eq(b.history.length, 1)
    eq(b.watches.length, 2)

    const owners = [
      ...b.follows.map((r) => r.person_key),
      ...b.favorites.map((r) => r.person_key),
      ...b.history.map((r) => r.person_key)
    ]
    ok(!owners.some((k) => k.startsWith('王五')), '他人（王五）的数据一条都不该出现')

    /* 行内不再重复带 openid（账号标识只在 account 段给一次），避免同一串 openid 在副本里散落几十处 */
    ok(!('openid' in b.follows[0]))
    ok(!('_openid' in b.follows[0]))
  })

  it('字段映射：老关键词订阅按 keyword 归一，person_key 缺失补 null', async () => {
    const load = withUser()
    seedMixed()
    const exp = load('utils/data-export')

    const b = await exp.buildMyDataBundle()
    const byLabel = Object.fromEntries(b.watches.map((w) => [w.label, w]))

    eq(byLabel['代言'].type, 'keyword')
    eq(byLabel['代言'].created_at, '2026-10-08T00:00:00.000Z')
    /* 老数据没有 type 字段 → 归一为 keyword（与 splitWatches 同口径） */
    eq(byLabel['张三'].type, 'keyword')
    /* 老数据没有 person_key 字段 → null，而不是 undefined（undefined 在 JSON 里会整键消失） */
    eq(byLabel['张三'].person_key, null)

    /* 不比较拼接顺序（中文字符串排序依赖码位，脆），只钉「两个领域都在、且姓名未丢」 */
    ok(b.follows.some((r) => r.domain === '娱乐' && r.name === '张三'))
    ok(b.follows.some((r) => r.domain === '商业' && r.name === '李四'))
    eq(b.favorites[0].type, 'quote')
    deepEq(b.favorites[0].payload, { text: '一句话' })
  })

  it('导出计划：偏好设置以扁平两项给出（与云端 users.settings 同源的两个键）', async () => {
    const load = withUser()
    const exp = load('utils/data-export')

    const b = await exp.buildMyDataBundle()
    deepEq(Object.keys(b.settings).sort(), ['llm_provider', 'llm_tier'])
    deepEq(Object.keys(b.account).sort(), ['nickname', 'user_id'])
    ok(typeof b.exported_at === 'string' && b.exported_at.length > 0)
  })

  it('复制到剪贴板：写入的是可解析的同一份 JSON，话术带条目数', async () => {
    const load = withUser()
    seedMixed()
    const exp = load('utils/data-export')

    const res = await exp.exportMyDataToClipboard()
    eq(res.ok, true)

    const call = env.findTaroCall('setClipboardData')
    ok(call !== null, '必须调用 setClipboardData')
    const parsed = JSON.parse(call.args[0].data)
    eq(parsed.account.user_id, ME)
    eq(parsed.follows.length, 2)
    eq(parsed.watches.length, 2)
    eq(exp.countBundleItems(parsed), 6)
    ok(res.message.includes('6 条'), `话术里应带上条目数，实际：${res.message}`)
    /* 说明头随副本一起落盘：用户粘贴到备忘录也能看懂这是什么、依据什么、如何行使权利 */
    ok(parsed.meta && typeof parsed.meta.title === 'string' && parsed.meta.title.includes('个人数据副本'), '副本应带中文说明头')
    ok(parsed.meta.basis.includes('第 45 条'), '说明头应写明 PIPL 依据')
  })

  it('复制失败（平台拒绝）：如实返回失败与原因，不谎报成功', async () => {
    const load = withUser()
    seedMixed()
    const exp = load('utils/data-export')

    env.setTaroOverride('setClipboardData', () => {
      throw new Error('mock: clipboard denied')
    })
    const res = await exp.exportMyDataToClipboard()

    eq(res.ok, false)
    ok(res.message.includes('clipboard denied'), `应把原始原因带回给用户，实际：${res.message}`)
  })

  it('复制失败（隐私未授权）：换成能照着做的指引，而不是甩平台原始英文', async () => {
    const load = withUser()
    seedMixed()
    const exp = load('utils/data-export')

    /* 微信隐私校验开启而后台指引未配时，reject 的是普通对象（带 errMsg），不是 Error */
    env.setTaroOverride('setClipboardData', () => {
      const e = { errMsg: 'setClipboardData:fail api scope is not declared in the privacy agreement' }
      throw e
    })
    const res = await exp.exportMyDataToClipboard()

    eq(res.ok, false)
    ok(res.message.includes('用户隐私保护指引'), `应换成可操作的指引，实际：${res.message}`)
    ok(res.message.includes('剪贴板'), `应点明是剪贴板，实际：${res.message}`)
  })

  it('只读：导出过程不发任何写请求', async () => {
    const load = withUser()
    seedMixed()
    const exp = load('utils/data-export')

    const before = writeCounters()
    await exp.buildMyDataBundle()
    await exp.exportMyDataToClipboard()
    deepEq(writeCounters(), before, '导出是只读动作，不该产生任何写')
  })

  it('入口接在页面上：菜单项 + 处理函数（静态读源码）', () => {
    /* 2026-10-17 起在「我的 → 系统设置」（package/settings），我的页只留通向它的那一行 */
    const tsx = read('package/settings/index.tsx')

    ok(tsx.includes("title: '导出个人数据'"), '「系统设置」页应有导出入口')
    ok(tsx.includes('onTap: () => void exportMyData()'), '菜单项应指向 exportMyData')
    ok(tsx.includes('const exportMyData = async () => {'), 'exportMyData 应是个处理函数（不是裸名字引用）')
    ok(tsx.includes('exportMyDataToClipboard'), '处理函数应调用 utils/data-export 的导出口')
    ok(/import \{ exportMyDataToClipboard \} from '@\/utils\/data-export'/.test(tsx), '应显式 import 导出模块')
  })

  it('未登录时菜单项给出「登录后可用」而不是静默失败', () => {
    const tsx = read('package/settings/index.tsx')
    ok(tsx.includes("note: userId ? '复制 JSON 副本到剪贴板' : '登录后可用'"))
  })

  it('政策「查阅与复制」条款必须写明复制权的行使入口（文案承诺 = 实际功能）', () => {
    const policy = read('package/agreement/index.tsx')
    ok(policy.includes('导出个人数据'), '政策里承诺的权利，入口名必须与实际菜单一致')
  })
})
