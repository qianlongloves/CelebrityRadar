'use strict'

/**
 * 测试入口：node test/run.js（先由 npm script 用 tsc 编译到 test/.build）
 *
 * 注意顺序：必须先加载 harness/env 装好 @tarojs/taro 与全局 wx 的替身，
 * 用例文件再 require 编译产物，才不会在 import 阶段就炸。
 */

require('./harness/env')

const path = require('path')
const fs = require('fs')

const { runAll } = require('./harness/t')
const env = require('./harness/env')

const caseDir = path.join(__dirname, 'cases')

if (!fs.existsSync(env.BUILD)) {
  process.stdout.write(`未找到编译产物 ${env.BUILD}\n请先运行：npm run test\n`)
  process.exit(2)
}

const files = fs.readdirSync(caseDir).filter((f) => f.endsWith('.js')).sort()
process.stdout.write(`\n共 ${files.length} 个用例文件：${files.join(' ')}\n\n`)

for (const f of files) {
  process.stdout.write(`[${f.replace(/\.js$/, '')}]\n`)
  require(path.join(caseDir, f))
}

runAll().then((r) => {
  process.stdout.write(`\n────────────────────────────────────────\n`)
  process.stdout.write(`通过 ${r.passed} / ${r.total}，失败 ${r.failed}\n`)

  if (r.failed > 0) {
    process.stdout.write(`\n失败清单：\n`)
    for (const f of r.failures) process.stdout.write(`  ✗ ${f.label}\n      ${f.err && f.err.message}\n`)
  }
  process.stdout.write('\n')
  process.exit(r.failed > 0 ? 1 : 0)
})
