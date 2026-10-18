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

/*
 * 用例文件在 require 期抛错（写在 describe 体里的断言、模块顶层读文件、语法错误）原先会让
 * **整轮**跑挂：后面所有文件一条都不执行，连已经通过的统计也一起丢掉，报错只剩一行栈。
 * 2026-10-18 起单个文件加载失败算一条失败，其余照常跑完（失败照样以退出码 1 收场）。
 */
const loadFailures = []

for (const f of files) {
  process.stdout.write(`[${f.replace(/\.js$/, '')}]\n`)
  try {
    require(path.join(caseDir, f))
  } catch (err) {
    loadFailures.push({ label: `${f}（加载失败，该文件内的用例一条都没跑）`, err })
    process.stdout.write(`  ✗ 加载失败：${err && err.message}\n`)
  }
}

runAll().then((r) => {
  const failures = loadFailures.concat(r.failures)
  const total = r.total + loadFailures.length
  process.stdout.write(`\n────────────────────────────────────────\n`)
  process.stdout.write(`通过 ${r.passed} / ${total}，失败 ${failures.length}\n`)

  if (failures.length > 0) {
    process.stdout.write(`\n失败清单：\n`)
    for (const f of failures) process.stdout.write(`  ✗ ${f.label}\n      ${f.err && f.err.message}\n`)
  }
  process.stdout.write('\n')
  process.exit(failures.length > 0 ? 1 : 0)
})
