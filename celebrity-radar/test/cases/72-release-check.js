'use strict'

/**
 * 发版前对账脚本（`scripts/release-check.js` / `npm run release:check`）。
 *
 * 这里钉的**不是**「当前仓库能不能发版」—— 那取决于后台隐私指引与运营名单，不是用例该断言的事；
 * 钉的是**脚本的判定逻辑本身**，喂合成文本跑正反两例。
 *
 * 为什么值得单独守一档：它是「发版前必改项」唯一的机械闸门，判错的方向有两个，都很贵 ——
 *
 *   · **假绿**（该红不红）：带着 debug 开关或隐私校验关闭的状态发出去，且事后无法从界面看出来；
 *   · **假红**（该绿不红）：每次发版都误报，人很快就不看它了，闸门等于不存在。
 *
 * 故每个「会红」的判定旁边都放一个**同形态但不该红**的正向对照（仓库铁律）。
 *
 * ⚠ 用例**刻意不**断言真实 `local.ts` 的取值：那是开发者本机的调试选择（该文件未被跟踪），
 * 拿它当断言会让「本地放开额度联调」变成红测试 —— 真实取值由 `npm run release:check`
 * 在发版那一刻拦。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk, eq } = require('../harness/t')
const check = require('../../scripts/release-check')

const ROOT = path.resolve(__dirname, '..', '..')
const realText = (rel) => {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

/** 合成 io：`files` 是「相对工程根的路径 → 文本」（值为 null 表示文件不存在），`mtimes` 是目录最新改动时间 */
function fakeIo(files, mtimes = { src: 2000, dist: 3000 }) {
  return {
    read: (rel) => (rel in files ? files[rel] : null),
    latestMtime: (rel) => (rel in mtimes ? mtimes[rel] : 0)
  }
}

/** 造一份 debug 节文本：只列出要改的项，其余照仓库默认（全 false） */
function localTs(over = {}) {
  const flags = Object.assign(
    {
      disableGenerateQuota: false,
      disableAskQuota: false,
      disableRefreshQuota: false,
      disableCooldown: false,
      rawIoLog: false,
      allowRestrictedSearch: false
    },
    over
  )
  const body = Object.keys(flags)
    .map((k) => `    ${k}: ${flags[k]},`)
    .join('\n')
  return `export const localConfig = {\n  debug: {\n${body}\n  }\n}\n`
}

/** 只替换 debug 节内的原文（用来造「注释里出现 xxx: true」这类形态） */
function localTsRaw(body) {
  return `export const localConfig = {\n  debug: {\n${body}\n  }\n}\n`
}

function greenFiles(over = {}) {
  return Object.assign(
    {
      'src/config/local.ts': localTs(),
      'src/app.config.ts': "export default defineAppConfig({\n  __usePrivacyCheck__: true\n})\n",
      'dist/app.json': '{"pages":["pages/index/index"],"__usePrivacyCheck__":true}',
      'src/utils/sensitive.ts': "const SENSITIVE_NAMES: string[] = [\n  '某人甲'\n]\n",
      'project.private.config.json': '{"appid":"wx1234567890abcdef"}'
    },
    over
  )
}

const run = (files, mtimes) => check.buildReport(fakeIo(files, mtimes))
const item = (report, id) => report.items.filter((i) => i.id === id)[0]

describe('发版前对账：全绿基线（脚本本身要能跑出「可以发」）', () => {
  it('六项机械检查全绿时 failed = 0', () => {
    const r = run(greenFiles())
    eq(r.items.length, check.CHECKS.length)
    eq(r.failed, 0, `不该有失败项：${r.items.filter((i) => !i.ok).map((i) => i.title).join(' / ')}`)
    eq(r.passed, r.items.length)
  })

  it('人工项（脚本查不到的）逐条带「为什么」，且至少三条', () => {
    const r = run(greenFiles())
    ok(r.manual.length >= 3, '隐私指引 / 云侧口径 / 上传姿势这三件事必须列出来')
    for (const s of r.manual) {
      ok(s.title && s.title.length > 8, `人工项缺标题：${JSON.stringify(s)}`)
      ok(s.why && s.why.length > 10, `人工项要说清为什么：${s.title}`)
    }
  })

  it('检查项 id 唯一（打印与定位都按 id 走）', () => {
    const ids = check.CHECKS.map((c) => c.id)
    eq(new Set(ids).size, ids.length, `id 重复：${ids.join(' / ')}`)
    for (const c of check.CHECKS) {
      ok(c.title && c.title.length > 4)
      ok(c.why && c.why.length > 20, `每项都得写清为什么：${c.id}`)
    }
  })
})

describe('发版前对账：debug 开关（会被编译进产物）', () => {
  it('任一项为 true 就红，并点名是哪一个', () => {
    const r = run(greenFiles({ 'src/config/local.ts': localTs({ disableCooldown: true }) }))
    const d = item(r, 'debug-flags')
    eq(d.ok, false)
    ok(d.detail.includes('disableCooldown'), '要点名，否则六个开关还得自己逐个看')
    eq(r.failed, 1, '只能红这一项，不能连坐')
  })

  it('正向对照：同一份文本里它若为 false 就绿', () => {
    eq(item(run(greenFiles()), 'debug-flags').ok, true)
  })

  it('剥注释：注释里写着 `disableCooldown: true` 这种说明不算数', () => {
    const text = localTsRaw('    /* 联调时这里会是 disableCooldown: true */\n    disableCooldown: false')
    eq(item(run(greenFiles({ 'src/config/local.ts': text })), 'debug-flags').ok, true)
  })

  it('文件不存在时红，并给出拿到模板的那一条命令', () => {
    const d = item(run(greenFiles({ 'src/config/local.ts': null })), 'debug-flags')
    eq(d.ok, false)
    ok(d.fix.includes('local.example.ts'), '该文件未跟踪，必须告诉人从模板复制')
  })

  it('文件在、但没有 debug 节 → 红（不静默放过）', () => {
    const d = item(run(greenFiles({ 'src/config/local.ts': 'export const localConfig = {}\n' })), 'debug-flags')
    eq(d.ok, false)
    ok(d.fix.includes('local.example.ts'))
  })
})

describe('发版前对账：隐私校验开关（源码 + 产物各算一遍）', () => {
  it('源码与产物都 true → 两项都绿', () => {
    const r = run(greenFiles())
    eq(item(r, 'privacy-switch-source').ok, true)
    eq(item(r, 'privacy-switch-artifact').ok, true)
  })

  it('源码 false → 源码项红（开发期取值也不是「可以发」）', () => {
    const r = run(greenFiles({ 'src/app.config.ts': 'export default defineAppConfig({\n  __usePrivacyCheck__: false\n})\n' }))
    const d = item(r, 'privacy-switch-source')
    eq(d.ok, false)
    ok(d.fix.includes('true'), '修法要能照做')
    ok(d.fix.includes('后台') || d.fix.includes('指引'), '必须点出「后台指引先过审」这个前置，顺序反了会拒头像接口')
  })

  it('源码 true 但产物 false → 产物项红，且点出「没重新构建」', () => {
    const r = run(greenFiles({ 'dist/app.json': '{"__usePrivacyCheck__":false}' }))
    eq(item(r, 'privacy-switch-source').ok, true, '源码是对的，不该连坐')
    const d = item(r, 'privacy-switch-artifact')
    eq(d.ok, false)
    ok(d.detail.includes('没重新构建'), `要说清是没构建而不是没改：${d.detail}`)
  })

  it('源码也还是 false 时，产物项的修法不是「重建」', () => {
    const r = run(greenFiles({ 'src/app.config.ts': 'export default defineAppConfig({\n  __usePrivacyCheck__: false\n})\n', 'dist/app.json': '{"__usePrivacyCheck__":false}' }))
    const d = item(r, 'privacy-switch-artifact')
    eq(d.ok, false)
    ok(d.detail.includes('源码也还是 false'), `别让人先去重建再发现没改源码：${d.detail}`)
    ok(d.fix.includes('上一项'), '指回源码那一项')
  })

  it('源码注释里写着 `__usePrivacyCheck__: true` 也不会被当成取值', () => {
    const text = 'export default defineAppConfig({\n  /* 上线前要改成 __usePrivacyCheck__: true */\n  __usePrivacyCheck__: false\n})\n'
    eq(check.readPrivacySwitch(text), false, '注释里的字样不算数')
    eq(item(run(greenFiles({ 'src/app.config.ts': text })), 'privacy-switch-source').ok, false)
  })

  it('产物里压根没有这个字段（未声明）→ 红，不当成 false 放过', () => {
    const r = run(greenFiles({ 'dist/app.json': '{"pages":["pages/index/index"]}' }))
    const d = item(r, 'privacy-switch-artifact')
    eq(d.ok, false)
    ok(d.detail.includes('没有该字段'), `未声明与显式 false 是两件事：${d.detail}`)
  })
})

describe('发版前对账：合规名单 / appid / 产物新鲜度', () => {
  it('名单空数组 → 红；正向对照：有内容 → 绿', () => {
    const bad = run(greenFiles({ 'src/utils/sensitive.ts': 'const SENSITIVE_NAMES: string[] = [\n]\n' }))
    eq(item(bad, 'sensitive-names').ok, false)
    ok(item(bad, 'sensitive-names').fix.includes('部署者'), '名单内容归部署者，脚本只拦空')
    eq(item(run(greenFiles()), 'sensitive-names').ok, true)
  })

  it('名单里只有注释（剥完是空的）也算空', () => {
    const text = 'const SENSITIVE_NAMES: string[] = [\n  // TODO(运营): 发版前补充\n]\n'
    eq(item(run(greenFiles({ 'src/utils/sensitive.ts': text })), 'sensitive-names').ok, false)
  })

  it('appid：占位号红 / 文件缺失红 / 真号绿', () => {
    eq(item(run(greenFiles({ 'project.private.config.json': '{"appid":"wx0000000000000000"}' })), 'appid').ok, false)
    eq(item(run(greenFiles({ 'project.private.config.json': null })), 'appid').ok, false)
    eq(item(run(greenFiles()), 'appid').ok, true)
  })

  it('产物不落后 → 绿；产物落后 → 红且报出落后秒数（上传的会是旧代码）', () => {
    eq(item(run(greenFiles(), { src: 2000, dist: 2001 }), 'artifact-freshness').ok, true)
    const d = item(run(greenFiles(), { src: 9000, dist: 1000 }), 'artifact-freshness')
    eq(d.ok, false)
    ok(d.detail.includes('落后'), `要说清是产物旧：${d.detail}`)
    ok(d.fix.includes('build'), '修法就是重新构建')
  })

  it('dist 不存在（还没构建过）→ 红', () => {
    eq(item(run(greenFiles(), { src: 2000, dist: 0 }), 'artifact-freshness').ok, false)
  })
})

describe('发版前对账：真实仓库的形态巡检（只看形态，不判取值）', () => {
  it('模板里的 debug 节仍是六项且全 false（口径「六项」不能悄悄回到五项）', () => {
    const flags = check.readDebugFlags(realText('src/config/local.example.ts'))
    ok(flags, '读不出模板的 debug 节 ⇒ 本脚本的取法已与现实脱节')
    eq(Object.keys(flags).length, 6)
    ok(!Object.values(flags).some((v) => v), '模板里任何一项为 true 都是错的方向')
  })

  it('真实文件的形态能被读出来（读法漂了就会静默变成「读不到」）', () => {
    notOk(check.readPrivacySwitch(realText('src/app.config.ts')) === null, 'app.config.ts 里应能读出 __usePrivacyCheck__')
    notOk(check.readSensitiveList(realText('src/utils/sensitive.ts')) === null, 'sensitive.ts 里应能读出名单')
  })

  it('受跟踪的示例配置里必须是占位号（真 appid 不许进版本库）', () => {
    eq(check.readAppid(realText('project.private.config.example.json')), check.PLACEHOLDER_APPID)
    eq(check.readAppid(realText('project.config.json')), check.PLACEHOLDER_APPID)
  })
})
