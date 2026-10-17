'use strict'

/**
 * 首次知情同意闭环（PIPL 第 14 / 17 条）。
 *
 * 背景：改造前小程序**启动即静默建号**（app.tsx 的 useLaunch → ensureLogin），在用户
 * 看到 / 同意任何隐私条款之前就采集了 openid。本次加一层「同意网关」把它闸住。
 *
 * 逐条钉住：
 *   1. utils/consent 的**版本化**记录：未同意 → 记录后 → 清空；版本不一致 = 重新征求；
 *      结构损坏不抛、按未同意处理；
 *   2. app.tsx：启动登录被 hasConsented() 闸住（不再无条件静默建号）；同意回调 = 落库 → 放行 → 登录；
 *   3. components/consent-gate：政策入口 + 同意 / 暂不同意，全屏遮罩且层级高于 privacy-gate；
 *   4. 版本号单一真源：协议页从 config/legal 取日期，不再写死；同意版本 = 政策生效日期。
 *
 * 组件 / 页面是 .tsx（不进测试编译），与既有页面级用例（40-ui-revision）同法读源码文本断言。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/* ───────────────────── 1. utils/consent 版本化记录 ───────────────────── */

describe('首次知情同意：utils/consent 版本化记录', () => {
  it('未同意 → false；记录后 → true；清空后 → false', () => {
    env.resetAll()
    const { hasConsented, recordConsent, clearConsent } = env.load('utils/consent')

    eq(hasConsented(), false, '初始应为未同意')
    recordConsent()
    eq(hasConsented(), true, '记录后应为已同意')
    clearConsent()
    eq(hasConsented(), false, '清空后回到未同意')
  })

  it('记录写入当前政策版本 + 时刻（凭据含版本号）', () => {
    env.resetAll()
    const { recordConsent, readConsent } = env.load('utils/consent')
    const { PRIVACY_CONSENT_VERSION } = env.load('config/legal')

    recordConsent()
    const rec = readConsent()
    eq(rec.version, PRIVACY_CONSENT_VERSION, '记录的版本应等于当前政策版本')
    ok(typeof rec.at === 'string' && rec.at.length > 0, '应记录同意时刻')
  })

  it('版本不一致视为未同意：政策更新后重新征求（不改写历史记录）', () => {
    env.resetAll()
    const { hasConsented, readConsent } = env.load('utils/consent')

    /* 手工写入「上一版」的同意记录 */
    env.rawStorage.set('legal:consent', { version: '2000-01-01', at: '2000-01-01T00:00:00.000Z' })
    eq(hasConsented(), false, '旧版本同意不算数，需重新征求')
    eq(readConsent().version, '2000-01-01', '原始记录仍可读出（不篡改历史）')
  })

  it('结构不对 / 损坏的记录一律按未同意处理（不抛）', () => {
    env.resetAll()
    const { hasConsented } = env.load('utils/consent')

    env.rawStorage.set('legal:consent', 'not-an-object')
    eq(hasConsented(), false, '非对象按未同意')
    env.rawStorage.set('legal:consent', { version: 'x' })
    eq(hasConsented(), false, '缺时刻字段按未同意')
  })
})

/* ───────────────── 1b. stores/consent 同意态（撤回即时生效） ───────────────── */

describe('首次知情同意：stores/consent 同意态（撤回可即时生效）', () => {
  it('初始按本机记录；agree 落库并置真；withdraw 清记录并置假', () => {
    env.resetAll()
    const { useConsent } = env.load('stores/consent')
    const { hasConsented, readConsent } = env.load('utils/consent')

    eq(useConsent.getState().consented, false, '干净状态应为未同意')

    useConsent.getState().agree()
    eq(useConsent.getState().consented, true, 'agree 后内存态为已同意')
    eq(hasConsented(), true, 'agree 应同时落库')
    ok(readConsent().version, '库中应含版本号')

    useConsent.getState().withdraw()
    eq(useConsent.getState().consented, false, 'withdraw 后内存态为未同意')
    eq(hasConsented(), false, 'withdraw 应同时清库')
  })
})

/* ───────────────────── 2. app.tsx：同意前不发起登录 ───────────────────── */

describe('首次知情同意：app.tsx 在同意前不发起登录（不再启动即静默建号）', () => {
  const tsx = read('app.tsx')

  it('useLaunch 里的登录被 hasConsented 闸住，不是无条件调用', () => {
    ok(
      /useLaunch\(\(\) => \{[\s\S]*?hasConsented\(\)[\s\S]*?ensureLogin\(\)/.test(tsx),
      '启动登录应以 hasConsented() 为条件'
    )
    notOk(
      /useLaunch\(\(\) => \{\s*void ensureLogin\(\)\s*\}\)/.test(tsx),
      '不应再无条件静默登录（同意前不采集 openid）'
    )
  })

  it('未同意时渲染 ConsentGate；同意态取自 store，同意后放行并登录', () => {
    ok(tsx.includes('ConsentGate'), '应挂载同意网关')
    ok(/consented\s*\?\s*null\s*:\s*<ConsentGate/.test(tsx), '仅在未同意时渲染网关')
    /* 同意态取自 store：撤回时本组件能订阅到变化、即时重现网关（见 stores/consent） */
    ok(tsx.includes('useConsent'), '同意态应取自 stores/consent')
    ok(/agree\(\)[\s\S]*?ensureLogin\(\)/.test(tsx), '同意回调：放行（store.agree 落库）→ 登录')
  })
})

/* ───────────────────── 3. components/consent-gate 形态 ───────────────────── */

describe('首次知情同意：components/consent-gate 形态', () => {
  const tsx = read('components/consent-gate/index.tsx')
  const scss = read('components/consent-gate/index.scss')

  it('有政策入口 + 同意 / 暂不同意两枚按钮', () => {
    ok(tsx.includes('/package/agreement/index'), '应能跳转完整政策页')
    ok(tsx.includes('同意并继续'), '应有同意按钮')
    ok(tsx.includes('暂不同意'), '应有暂不同意按钮（肯定动作之外留出拒绝）')
    ok(tsx.includes('隐私与免责声明'), '应点名政策名称')
  })

  it('全屏遮罩，层级高于 privacy-gate（同意是更前置的一道）', () => {
    ok(/position:\s*fixed/.test(scss), '应为全屏固定层')
    ok(/left:\s*0;[\s\S]*?right:\s*0;[\s\S]*?top:\s*0;[\s\S]*?bottom:\s*0;/.test(scss), '四边显式铺满')
    const m = /z-index:\s*(\d+)/.exec(scss)
    ok(m && Number(m[1]) > 4000, `z-index 应高于 privacy-gate 的 4000，实际 ${m && m[1]}`)
  })

  it('停留在政策页时让出整屏（否则会盖住正文、读不到全文，闭环不成立）', () => {
    ok(tsx.includes('useRouter'), '应读取当前路由')
    ok(/pages\/agreement/.test(tsx), '应识别政策页路径')
    ok(/if \(onPolicyPage\) return null/.test(tsx), '政策页上应 return null 让出整屏')
  })
})

/* ───────────────────── 4. 版本号单一真源 ───────────────────── */

describe('首次知情同意：版本号单一真源（config/legal）', () => {
  it('协议页从 config/legal 取日期，不再写死', () => {
    const tsx = read('package/agreement/index.tsx')
    ok(tsx.includes("from '@/config/legal'"), '协议页应引用单一真源')
    ok(tsx.includes('PRIVACY_UPDATED_AT') && tsx.includes('PRIVACY_EFFECTIVE_AT'), '应使用共享常量')
    notOk(/const UPDATED_AT\s*=/.test(tsx), '不应再写死 UPDATED_AT 常量')
    notOk(/const EFFECTIVE_AT\s*=/.test(tsx), '不应再写死 EFFECTIVE_AT 常量')
  })

  it('同意版本 = 政策生效日期，且为 YYYY-MM-DD', () => {
    const legal = env.load('config/legal')
    eq(legal.PRIVACY_CONSENT_VERSION, legal.PRIVACY_EFFECTIVE_AT, '同意版本应等于生效日期')
    ok(/^\d{4}-\d{2}-\d{2}$/.test(legal.PRIVACY_EFFECTIVE_AT), '生效日期应为 YYYY-MM-DD')
  })
})

/* ───────────────────── 5. 撤回同意独立入口 ───────────────────── */

describe('首次知情同意：撤回同意独立入口（PIPL 第 15 条）', () => {
  const tsx = read('pages/mine/index.tsx')

  it('「我的」页有「撤回同意」菜单项，且经 store.withdraw 撤销', () => {
    ok(tsx.includes("title: '撤回同意'"), '应有「撤回同意」菜单项')
    ok(tsx.includes('withdrawConsent'), '应接线到撤回处理函数')
    ok(/useConsent\.getState\(\)\.withdraw\(\)/.test(tsx), '撤回应走 store.withdraw（即时重现网关）')
  })

  it('撤回是独立处理函数：删云端 → 退出登录 → 撤销同意（与清空/注销分开）', () => {
    ok(tsx.includes('const withdrawConsent'), '应有独立的 withdrawConsent 处理函数')
    ok(
      /const withdrawConsent = async \(\) => \{[\s\S]*?clearAllMyData\(\)[\s\S]*?clearLogin\(\)[\s\S]*?withdraw\(\)/.test(
        tsx
      ),
      '撤回应依次：删云端个人数据 → 退出登录 → 撤销同意'
    )
  })
})

/* ───────────────────── 6. 注销账号独立入口与善后（P1-4） ───────────────────── */

/**
 * 注销账号（PIPL 第 47 条）：隐私政策 §2.4 承诺的入口，必须真实存在且真能删干净。
 *
 * 这里只截 `cancelAccount` 的**函数体**做断言 —— 同文件里还有撤回同意，它也调
 * `clearLocalSettingsCache`，所以「整份文件里不得出现 clearLocalSettings」这种断言会误伤；
 * 反过来，若只在文件级断言，注销路径漏了哪一行也看不出来。
 *
 * 云端「删哪些表 / 订单去标识化」由 test/cases/18-user-config.js 的用例钉住（同属 P1-4）。
 */
describe('注销账号：独立入口 + 善后只清本机（PIPL 第 47 条）', () => {
  /*
   * 2026-10-17：注销入口从「我的」页迁到「我的 → 系统设置」（package/settings）。
   * 政策文案已同步改成同一路径（「二、你的权利 · 注销账号」），否则承诺的入口与实际路径对不上。
   */
  const tsx = read('package/settings/index.tsx')
  const body = (tsx.match(/const cancelAccount = async \(\) => \{[\s\S]*?\n  \}/) || [''])[0]

  it('「系统设置」页有「注销账号」入口，且接线到独立处理函数', () => {
    ok(body.length > 0, 'package/settings 里应有 cancelAccount 处理函数')
    ok(tsx.includes("title: '注销账号'"), '应有「注销账号」菜单项（政策承诺的入口）')
    ok(tsx.includes('onTap: () => void cancelAccount()'), '菜单项应接线到 cancelAccount')
    /* 反向：入口只许有一处 —— 「我的」页必须通向系统设置，而不是自己再挂一个注销 */
    const mine = read('pages/mine/index.tsx')
    ok(mine.includes("'/package/settings/index'"), '「我的」页应有「系统设置」入口')
    ok(!mine.includes('cancelAccount'), '「我的」页不该再直接调 cancelAccount（两处入口会让人退错地方）')
  })

  it('不可逆动作二次确认：连弹两道确认框', () => {
    const modals = body.match(/showModal\(/g) || []
    ok(modals.length >= 2, `注销不可逆，必须二次确认，实际弹 ${modals.length} 道`)
    ok(body.includes('确认注销'), '第二道确认框的按钮文案应明确是「确认注销」')
  })

  it('善后只清本机：不许调 clearLocalSettings（它会把刚删掉的 users 行重建回来）', () => {
    ok(body.includes('clearLocalSettingsCache()'), '注销善后要清本机偏好缓存')
    notOk(
      body.includes('clearLocalSettings('),
      'clearLocalSettings 会把默认配置推回 userInit，其 ensure() 重建 users 行 —— 注销等于没生效'
    )
    ok(body.includes('clearLogin()'), '注销成功后要解除登录态')
  })

  it('顺带清掉其它残留：头像云文件、周报缓存、消息已读位，并撤销同意', () => {
    ok(body.includes('deleteCloudFile(avatarUrl)'), '头像云文件要顺手删掉，否则个人信息残留')
    ok(body.includes('clearWeeklyCache()'), '周报缓存是本机的内容副本，应一并清')
    ok(
      body.includes('clearMessageState()') && body.includes('clearInboxSeen()'),
      '消息中心与信箱已读位应一并清'
    )
    ok(
      /useConsent\.getState\(\)\.withdraw\(\)/.test(body),
      '注销 = 彻底解除关系，同意记录一并撤销（app 即时重现同意网关）'
    )
  })
})

