'use strict'

/**
 * 发版前一处对账（`npm run release:check`）。
 *
 * ## 为什么单开一个脚本
 *
 * 这个仓库里有一类改动**只在发版那一刻才需要**、平时却完全无害 —— 于是它们必然会被忘：
 *
 *   · `src/config/local.ts#debug` 六项：开发期置 true 是常态（放额度、摸边界），
 *     但它**会被编译进产物**，发出去等于免费层限流与 429 冷却同时失效；
 *   · `src/app.config.ts#__usePrivacyCheck__`：开发期用测试号时只能置 false
 *     （否则头像 / 昵称接口被平台直接拒绝），**上线前必须改回 true**；
 *   · `src/utils/sensitive.ts#SENSITIVE_NAMES`：仓库里是空数组（部署者自行补齐）。
 *
 * 上面三处过去只写在各自文件的注释里 —— `utils/debug.ts` 的注释早写过目标：
 * 「集中到一个配置节后，上线前对账**只需检查一处**」，但隐私开关与名单不在那个配置节里，
 * 实际对账仍然靠人记。2026-10-16 真的漏过一次（六项 debug 全 true 差点随构建发出去）。
 * 故把「能机械判定的」全部收进本脚本，「只能人工确认的」逐条打印出来不参与判定。
 *
 * ## 它在算什么、不算什么
 *
 * 判定只看两样东西：**源码文本**与**构建产物**。产物那一项刻意单独算一遍 ——
 * 源码改对了但忘了重新构建，上传的仍是旧包，这种错在上传界面上看不出来。
 *
 * 它**不知道**的事（故列进人工项）：微信后台的隐私指引配没配、名单内容对不对、
 * 云上跑的函数是不是这份源码。
 * （埋点名单那类「云侧 ⇄ 端上口径一致」已经机械化了：test/cases/74-event-enum.js 比对
 *  events.enumHint ⇄ TrackEvent，npm test 会红 —— 能机械判定的就不该留在人工清单里。）
 * 脚本不猜，只把该做什么写清楚。
 *
 * ## 判定逻辑与 IO 分离
 *
 * `buildReport(io)` 收一个可注入的 io（读文件 / 取最新改动时间），用例喂合成文本跑正反两例
 * （见 test/cases/72-release-check.js）；`main()` 才碰真实文件系统。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/** 占位 / 测试号 appid：`project.config.json`（受跟踪）里刻意是它，真号在未跟踪的私有配置里 */
const PLACEHOLDER_APPID = 'wx0000000000000000'

/**
 * 剥注释再断言：本仓库一个文件里往往大段写着「为什么这么做」，注释里出现
 * `xxx: true` 这种字样是常态（如 `local.example.ts` 的逐项说明），不剥就会误判。
 * 与 test/cases 里的 stripComments 同一手法。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** `debug: { ... }` 块里的全部开关（键名与取值都照实读出来，不写死六项） */
function readDebugFlags(text) {
  const block = /debug\s*:\s*\{([\s\S]*?)\}/.exec(stripComments(text))
  if (!block) return null
  const flags = {}
  const re = /([A-Za-z_$][\w$]*)\s*:\s*(true|false)/g
  let m
  while ((m = re.exec(block[1]))) flags[m[1]] = m[2] === 'true'
  return Object.keys(flags).length ? flags : null
}

/**
 * `__usePrivacyCheck__` 的取值 —— 源码（TS）与产物（app.json，键带引号）共用一条正则。
 * 读不到时返回 null（**不要当成 false**：那是未声明，与显式声明 false 是两件事）。
 */
function readPrivacySwitch(text) {
  if (text === null) return null
  // 只剥块注释：源码注释里迟早会有人写下 `__usePrivacyCheck__: true` 这种字样（说明「上线该开」），
  // 不剥就会读到注释里的取值而不是代码里的；对 app.json 是空操作
  const m = /__usePrivacyCheck__"?\s*:\s*(true|false)/.exec(text.replace(/\/\*[\s\S]*?\*\//g, ''))
  return m ? m[1] === 'true' : null
}

/** 名单是否非空（只判空不判内容 —— 内容归部署者，本项目不提供名单） */
function readSensitiveList(text) {
  if (text === null) return null
  const m = /SENSITIVE_NAMES\s*:\s*[A-Za-z_$][\w$]*\[\]\s*=\s*\[([\s\S]*?)\]/.exec(stripComments(text))
  if (!m) return null
  return m[1].trim().length > 0
}

function readAppid(text) {
  if (text === null) return null
  try {
    const json = JSON.parse(text)
    return typeof json.appid === 'string' ? json.appid : null
  } catch {
    return null
  }
}

/**
 * 检查项清单。`why` 是「为什么这条重要」（写在定义里，不重复实现），
 * `run(io)` 只做判定并给 `detail` / `fix`（怎么改，一步能照做）。
 */
const CHECKS = [
  {
    id: 'debug-flags',
    title: '本地调试开关全 false（src/config/local.ts）',
    why: 'debug 会被编译进产物：任一项为 true，免费层限流（每日 3 次生成 / 5 次提问）与 429 冷却保护就同时失效，等于把上游成本敞开；rawIoLog 还会把上游原始报文打进控制台',
    run: (io) => {
      const text = io.read('src/config/local.ts')
      if (text === null) {
        return {
          ok: false,
          detail: 'src/config/local.ts 不存在（该文件被 .gitignore 忽略，不随仓库走）',
          fix: 'cp src/config/local.example.ts src/config/local.ts —— 模板里默认全 false，直接可用'
        }
      }
      const flags = readDebugFlags(text)
      if (!flags) {
        return {
          ok: false,
          detail: '读了文件但没找到 `debug: { ... }` 块',
          fix: '照 src/config/local.example.ts#LocalDebugFlags 的结构补回该配置节'
        }
      }
      const on = Object.keys(flags).filter((k) => flags[k])
      if (on.length === 0) {
        return { ok: true, detail: `六项全 false（${Object.keys(flags).join(' / ')}）` }
      }
      return {
        ok: false,
        detail: `${on.length} 项为 true：${on.join(' / ')}`,
        fix: '改成 false —— 想放开额度联调请用云函数侧 AI_PROXY_QUOTA_GUARD=off（见 local.example.ts 的说明），别改这里'
      }
    }
  },
  {
    id: 'privacy-switch-source',
    title: '平台隐私协议校验开关已开（src/app.config.ts）',
    why: '不声明该字段时微信不会把隐私授权回调交给小程序，端上的同意网关（components/privacy-gate）会静静退化成不存在 —— 于是「用了头像 / 昵称却没有平台级授权闭环」',
    run: (io) => {
      const text = io.read('src/app.config.ts')
      const on = readPrivacySwitch(text)
      if (on === null) {
        return {
          ok: false,
          detail: text === null ? '读不到 src/app.config.ts' : '源码里没有 __usePrivacyCheck__ 这一行',
          fix: '显式写上 __usePrivacyCheck__: true（开启前提见本项目的人工项第 1 条）'
        }
      }
      if (on) return { ok: true, detail: 'true' }
      return {
        ok: false,
        detail: 'false（开发期取值）',
        fix: '改 true 后必须重新构建（上传的是产物 app.json），顺序不能反：后台指引先过审'
      }
    }
  },
  {
    id: 'privacy-switch-artifact',
    title: '同上，但看构建产物（dist/app.json）',
    why: '源码改对了却忘了重新构建，上传的仍是旧包 —— 这一点在上传界面上完全看不出来，故单独再算一遍',
    run: (io) => {
      const text = io.read('dist/app.json')
      const on = readPrivacySwitch(text)
      if (on === null) {
        return {
          ok: false,
          detail: text === null ? '读不到 dist/app.json（还没构建？）' : '产物里没有该字段',
          fix: 'npm run build:weapp'
        }
      }
      if (on) return { ok: true, detail: 'true' }
      const srcOn = readPrivacySwitch(io.read('src/app.config.ts'))
      if (srcOn !== true) {
        return {
          ok: false,
          detail: '产物是 false（源码也还是 false）',
          fix: '先按上一项把源码改成 true，再 npm run build:weapp'
        }
      }
      return {
        ok: false,
        detail: '产物仍是 false —— 源码已改 true，但没重新构建',
        fix: 'npm run build:weapp，然后重跑本脚本'
      }
    }
  },
  {
    id: 'sensitive-names',
    title: '合规拦截名单非空（src/utils/sensitive.ts）',
    why: '名单为空时第一级拦截的「人物」维度整体失效（「关键词」维度仍有效）：命中即拒、不发任何网络请求那一道没了，查询会直接发出去 —— 合规缺口，故端上有启动告警，本脚本再拦一道',
    run: (io) => {
      const nonEmpty = readSensitiveList(io.read('src/utils/sensitive.ts'))
      if (nonEmpty === null) {
        return { ok: false, detail: '读不到 SENSITIVE_NAMES 或它的形态变了', fix: '确认数组仍在（本脚本按 `const SENSITIVE_NAMES: string[] = [...]` 取）' }
      }
      if (nonEmpty) return { ok: true, detail: '非空' }
      return {
        ok: false,
        detail: '空数组（仓库默认值）',
        fix: '由部署者按最新合规要求补齐（本项目不含名单，内容自行确定并承担责任）'
      }
    }
  },
  {
    id: 'appid',
    title: '本机私有配置里有真实 appid（project.private.config.json）',
    why: '受跟踪的 project.config.json 里刻意是占位号 wx0000…，真 appid 只在本机未跟踪的私有配置里；用占位号打开项目会让「上传」按钮直接不可用，或上传到错误的号',
    run: (io) => {
      const appid = readAppid(io.read('project.private.config.json'))
      if (appid === null) {
        return {
          ok: false,
          detail: '读不到该文件或里面没有 appid',
          fix: 'cp project.private.config.example.json project.private.config.json 并填入自己的 appid'
        }
      }
      if (appid === PLACEHOLDER_APPID) {
        return { ok: false, detail: `仍是占位号 ${PLACEHOLDER_APPID}`, fix: '改成真实 appid（该文件不进版本库）' }
      }
      return { ok: true, detail: `已配置（…${appid.slice(-6)}）` }
    }
  },
  {
    id: 'artifact-freshness',
    title: '构建产物不比源码旧（dist/ vs src/）',
    why: '产物旧 = 上传的代码不是现在这份（改动没进去，或进去的是半截）；git 不保留文件时间，刚 clone 时这一项会假红，跑一次 build 即消',
    run: (io) => {
      const src = io.latestMtime('src')
      const dist = io.latestMtime('dist')
      if (!dist) return { ok: false, detail: 'dist/ 不存在或为空', fix: 'npm run build:weapp' }
      if (!src) return { ok: true, detail: 'src/ 读不到，跳过比对' }
      if (dist >= src) return { ok: true, detail: `产物较新（${new Date(dist).toLocaleString()}）` }
      return {
        ok: false,
        detail: `产物落后 ${Math.round((src - dist) / 1000)}s（源码改于 ${new Date(src).toLocaleString()}）`,
        fix: 'npm run build:weapp —— 否则发出的是上一版代码'
      }
    }
  }
]

/** 脚本查不到、只能人工确认的事（不参与判定，逐条打印） */
const MANUAL_STEPS = [
  {
    title: '微信公众平台「设置 → 基本设置 → 用户隐私保护指引」按实际收集情况配置并通过审核',
    why: '这是 __usePrivacyCheck__ 能开 true 的「前置」，顺序不能反：指引未配置而开关为 true 时，头像 / 昵称等隐私接口会被平台直接拒绝，端上兜不住'
  },
  {
    title: '云侧**已部署的函数**与本版是同一份代码（15 个函数，不只是 S0-6 那 4 个）',
    why: '埋点名单的一致性已经机械化了（test/cases/74-event-enum.js 比对 events.enumHint ⇄ TrackEvent，npm test 会红），这里剩下的只有「云上跑的那份是不是这份源码」。⚠ 判据是**字节**不是**时间戳**：改完先本地部署、后提交，时间戳必然领先（内容其实一致）；反过来也骗人。做法：tcb fn code download <name> .tmp/<name> --env-id <env> 拉下来，与 cloudfunctions/<name> 逐文件 SHA256 比对（排除 node_modules）。2026-10-17 按此法查出两个真落后 —— notifyFollowUpdates#index.js（缺 S3-4 条数口径 + E1-①）与 dbInit#schema.js（缺 subs / enumHint），已重部署；详见 doc/产品优化路线图.md §5.2 S0-6'
  },
  {
    title: '上传姿势：开发者工具打开「仓库根」，上传后用真机冒烟清单过一遍',
    why: 'appid 走未跟踪的私有配置、dist/ 里是占位符（所以在 dist 打开项目会认错号）；冒烟清单见 doc/产品优化路线图.md §7'
  }
]

/** 真实文件系统：脚本本体才用它；用例喂合成 io */
const realIo = {
  read: (rel) => {
    try {
      return fs.readFileSync(path.join(ROOT, rel), 'utf8')
    } catch {
      return null
    }
  },
  latestMtime: (rel) => {
    const start = path.join(ROOT, rel)
    let latest = 0
    const walk = (p) => {
      let entries
      try {
        entries = fs.readdirSync(p, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(p, e.name)
        if (e.isDirectory()) walk(full)
        else {
          try {
            const ms = fs.statSync(full).mtimeMs
            if (ms > latest) latest = ms
          } catch {
            /* 读不到就跳过 */
          }
        }
      }
    }
    walk(start)
    return latest
  }
}

function buildReport(io = realIo) {
  const items = CHECKS.map((c) => {
    let res
    try {
      res = c.run(io)
    } catch (err) {
      res = { ok: false, detail: `检查自身抛错：${err && err.message ? err.message : String(err)}`, fix: '修本脚本' }
    }
    return {
      id: c.id,
      title: c.title,
      why: c.why,
      ok: !!res.ok,
      detail: res.detail || '',
      fix: res.fix || ''
    }
  })
  return {
    items,
    manual: MANUAL_STEPS,
    passed: items.filter((i) => i.ok).length,
    failed: items.filter((i) => !i.ok).length
  }
}

function printReport(r) {
  const out = []
  out.push('\n名人雷达 · 发版前对账（npm run release:check）\n')
  for (const i of r.items) {
    out.push(`${i.ok ? '✓' : '✗'} ${i.title}`)
    out.push(`    ${i.detail}`)
    if (!i.ok) {
      out.push(`    ⤷ 为什么：${i.why}`)
      out.push(`    ⤷ 怎么改：${i.fix}`)
    }
  }
  out.push(`\n机械检查：通过 ${r.passed} / ${r.items.length}，失败 ${r.failed}\n`)
  out.push('人工项（脚本查不到，必须自己确认）：')
  r.manual.forEach((s, n) => {
    out.push(`  ${n + 1}. ${s.title}`)
    out.push(`     ${s.why}`)
  })
  out.push(
    r.failed === 0
      ? '\n机械项全过 ⇒ 仍要逐条过完上面的人工项，再上传（一次发版 = 一次归因窗口，别拆）。\n'
      : `\n还有 ${r.failed} 项没准备好 ⇒ 现在上传会把问题一起发出去。\n`
  )
  process.stdout.write(out.join('\n') + '\n')
}

if (require.main === module) {
  const r = buildReport()
  printReport(r)
  process.exit(r.failed > 0 ? 1 : 0)
}

module.exports = {
  CHECKS,
  MANUAL_STEPS,
  PLACEHOLDER_APPID,
  buildReport,
  readDebugFlags,
  readPrivacySwitch,
  readSensitiveList,
  readAppid,
  stripComments
}
