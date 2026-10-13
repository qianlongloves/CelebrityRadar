#!/usr/bin/env node
/**
 * sync-config.js —— 把「端上真源」刷进各云函数目录（`npm run config:sync`）。
 *
 * ## 它解决什么
 *
 * 云函数各自独立打包上传（`cloudbaserc.json` 逐个声明 functions[]），
 * 且云环境里**不能 require 端上的 TS**（quotaGuard/index.js 有注释说明这一点）。
 * 于是「端上与云端同值」只能靠副本维持 —— 以前靠人记得手抄，抄漏不会有任何报错。
 * 本脚本把这件事变成一条命令，并用 `--check` 让测试能钉住"没人偷偷手改副本"。
 *
 * ## 有哪些真源（SOURCES）
 *
 * 每个真源 = 一份端上 TS + 一个副本文件名 + 需要它的云函数清单：
 *
 *   src/config/benefits.ts        → benefits.config.js       (aiProxy / quotaGuard / payCreate)
 *   src/config/user-defaults.ts   → user-defaults.config.js  (userInit / userBackfill)
 *
 * 新增真源时在 `SOURCES` 里加一项即可；生成物只含**数据**（函数与 undefined 被跳过）。
 *
 * ## 用法
 *
 *   node scripts/sync-config.js           写入/覆盖副本（幂等：内容相同则不动文件）
 *   node scripts/sync-config.js --check   只校验，有差异则打印并 exit 1（测试与 CI 用）
 *
 * ## 实现要点
 *
 * 真源是 TS（带完整注释与 `as const`），本脚本用 **typescript 自带的 transpileModule**
 * 在内存里转成 CJS 再执行 —— 不落中间文件，也不新增依赖（typescript 已在 devDependencies）。
 *
 * 真源里的 `require` 被替换成一个**必抛**桩：真源必须自包含
 * （见 benefits.ts / user-defaults.ts 文件头铁律 1）。它一旦 import 了别的东西，
 * 这里会立刻报错停下，而不是生成一份「运行时才炸」的副本。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
/** 云函数根目录（与 cloudbaserc.json 的 functionRoot 一致） */
const CLOUD_DIR = path.join(ROOT, 'cloudfunctions')

/**
 * 真源清单。`targets` 只列**真正 require 它**的云函数：
 * 每个云函数目录都会被打包上传，塞一份没人 require 的文件只会让
 * 「这个目录到底依赖什么」更难看清。新增读取方时在这里加一行。
 */
const SOURCES = [
  {
    key: 'benefits',
    source: path.join(ROOT, 'src', 'config', 'benefits.ts'),
    out: 'benefits.config.js',
    /* 产品额度池（generate/ask 的免费与会员上限）、防滥用上限、
       单次检索条数上限、对话字符上限 → aiProxy；
       每日「抓取关注动态」次数上限（REFRESH_DAILY_LIMIT） → quotaGuard；
       套餐白名单（唯一价格源：价格 / 天数 / 订单标题） → payCreate；
       舆情功能的免费 / 会员分层上限（OPINION_LIMITS，其中 watchCount 是
       关键词监控的新增上限）→ keywordAlert（写入路径按档判定，P4 2026-10-13） */
    targets: ['aiProxy', 'quotaGuard', 'payCreate', 'keywordAlert']
  },
  {
    key: 'user-defaults',
    source: path.join(ROOT, 'src', 'config', 'user-defaults.ts'),
    out: 'user-defaults.config.js',
    /* 用户个性化配置的默认值 / 键白名单 / 版本号。读方有两个：
       · userInit     —— 首登初始化的写者，也是端上改配置时唯一被调用的云函数；
       · userBackfill —— 一次性运维，给「改造前插了 settings:{}、此后再没登录过」
         的存量行补齐。它与 userInit 各持一份同构的 mergeDefaults，
         改补齐规则要**两边一起改**（否则登录路径与运维路径的语义就分了叉）。 */
    targets: ['userInit', 'userBackfill']
  }
]

/* 向后兼容的历史导出（文档与用例引用的是权益那一份） */
const SOURCE = SOURCES[0].source
const OUT_NAME = SOURCES[0].out
const TARGETS = SOURCES[0].targets

/** 相对 ROOT 的 posix 路径（生成物里不能出现 Windows 的反斜杠） */
const relPosix = (p) => path.relative(ROOT, p).split(path.sep).join('/')

/** 生成物头部：说清它是生成物、真源在哪、怎么重新生成 */
function makeHeader(sourceFile, outName) {
  return `/**
 * ${outName} —— **自动生成，请勿手改**。
 *
 * 真源：${relPosix(sourceFile)}
 * 生成：npm run config:sync（或 node scripts/sync-config.js）
 * 校验：npm run config:check（tests/cases 里的 sync 用例会跑它）
 *
 * 为什么是副本而不是引用：云函数各自独立打包上传（cloudbaserc.json 逐个声明），
 * 且云环境里 require 不到端上的 TS —— 只能把真源序列化成本地文件一起上传。
 * 手改本文件会在下次 config:sync 时被覆盖，且 config:check 会报红。
 */

`
}

/**
 * 在内存里执行 TS 真源，返回它的导出对象。
 * 真源若 import/require 了任何模块，会在这里直接抛错（而不是生成坏副本）。
 */
function loadSource(file = SOURCE) {
  const src = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    fileName: file
  }).outputText

  const mod = { exports: {} }
  const forbidden = (id) => {
    throw new Error(
      `真源必须自包含，但它 import/require 了 "${id}"：${relPosix(file)}（见该文件头部铁律 1）`
    )
  }
  /* eslint-disable-next-line no-new-func */
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(
    mod.exports,
    forbidden,
    mod,
    file,
    path.dirname(file)
  )
  return mod.exports
}

/** 把导出对象渲染成生成物的完整文本：跳过函数与 undefined，保证是干净的 JSON */
function render(exportsObj, header = makeHeader(SOURCE, OUT_NAME)) {
  const data = {}
  for (const key of Object.keys(exportsObj)) {
    const value = exportsObj[key]
    if (typeof value === 'function' || value === undefined) continue
    data[key] = value
  }
  if (Object.keys(data).length === 0) {
    throw new Error('真源没有导出任何数据（是不是全写成了函数？）')
  }
  return `${header}module.exports = ${JSON.stringify(data, null, 2)}\n`
}

/** 每个目标的期望内容 + 是否与磁盘一致（跨全部真源） */
function plan() {
  const items = []
  for (const src of SOURCES) {
    const content = render(loadSource(src.source), makeHeader(src.source, src.out))
    for (const fn of src.targets) {
      const file = path.join(CLOUD_DIR, fn, src.out)
      let current = null
      try {
        current = fs.readFileSync(file, 'utf8')
      } catch {
        /* 首次生成：文件还不存在 */
      }
      items.push({ fn, out: src.out, sourceKey: src.key, file, content, current, stale: current !== content })
    }
  }
  return items
}

/** 只校验，不写盘；返回不一致项（空数组 = 全部同步） */
function check() {
  return plan().filter((item) => item.stale)
}

/** 写入所有副本（幂等）；返回被改动的目标名（`<云函数>/<副本名>`） */
function sync() {
  const changed = []
  for (const item of plan()) {
    if (!item.stale) continue
    fs.mkdirSync(path.dirname(item.file), { recursive: true })
    fs.writeFileSync(item.file, item.content)
    changed.push(`${item.fn}/${item.out}`)
  }
  return changed
}

function main() {
  const isCheck = process.argv.includes('--check')
  const targets = plan()

  if (isCheck) {
    const stale = targets.filter((item) => item.stale)
    if (stale.length === 0) {
      console.log(`config:check 通过 —— ${targets.length} 份副本均与真源一致`)
      return
    }
    console.error('config:check 失败 —— 以下副本与真源不一致（跑 npm run config:sync 修复）：')
    for (const item of stale) {
      const why = item.current === null ? '缺失' : '内容不同'
      console.error(`  · cloudfunctions/${item.fn}/${item.out}（${why}）`)
    }
    process.exit(1)
  }

  const changed = sync()
  if (changed.length === 0) {
    console.log(`config:sync 无事可做 —— ${targets.length} 份副本均已是最新`)
  } else {
    console.log(`config:sync 已更新 ${changed.length} 份副本：${changed.join(' / ')}`)
  }
  console.log('提醒：云端改动需重新部署对应云函数才生效（端上随下次发版）。')
}

if (require.main === module) main()

module.exports = {
  ROOT,
  CLOUD_DIR,
  SOURCES,
  SOURCE,
  OUT_NAME,
  TARGETS,
  loadSource,
  render,
  makeHeader,
  plan,
  check,
  sync
}
