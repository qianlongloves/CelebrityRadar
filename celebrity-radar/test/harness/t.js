'use strict'

/**
 * 极简测试框架（零依赖）：describe / it / 断言 / 汇总。
 * 用例直接 require 编译后的 src 模块，跑在同一进程里。
 */

const cases = []
let suite = '(root)'

function describe(name, fn) {
  const prev = suite
  suite = name
  try {
    fn()
  } finally {
    suite = prev
  }
}

function it(name, fn) {
  cases.push({ suite, name, fn })
}

class AssertionError extends Error {}

function inspect(v) {
  if (typeof v === 'string') return JSON.stringify(v)
  if (v instanceof Error) return `${v.name}(${v.message})`
  try {
    const s = JSON.stringify(v)
    return s === undefined ? String(v) : s
  } catch {
    return String(v)
  }
}

function fail(msg) {
  throw new AssertionError(msg)
}

function ok(v, msg) {
  if (!v) fail(msg || `期望为真，实际 ${inspect(v)}`)
}

function notOk(v, msg) {
  if (v) fail(msg || `期望为假，实际 ${inspect(v)}`)
}

function eq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    fail(msg || `期望 ${inspect(expected)}，实际 ${inspect(actual)}`)
  }
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) fail(msg || `深度比较失败：期望 ${b}，实际 ${a}`)
}

function near(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) {
    fail(msg || `期望 ${expected} ± ${tolerance}，实际 ${actual}`)
  }
}

/** 断言一定会抛错；re 用于匹配 message */
async function rejects(fn, re, msg) {
  let thrown = null
  try {
    await fn()
  } catch (err) {
    thrown = err
  }
  if (!thrown) fail(msg || '期望抛出异常，但没有')
  if (re && !re.test(String(thrown && thrown.message ? thrown.message : thrown))) {
    fail(msg || `异常信息不匹配 ${re}：${inspect(thrown)}`)
  }
  return thrown
}

async function runAll() {
  let passed = 0
  const failures = []

  for (const c of cases) {
    const label = `${c.suite} › ${c.name}`
    try {
      await c.fn()
      passed++
      process.stdout.write(`  ✓ ${label}\n`)
    } catch (err) {
      failures.push({ label, err })
      process.stdout.write(`  ✗ ${label}\n`)
      process.stdout.write(`      ${err && err.message ? err.message : String(err)}\n`)
      if (!(err instanceof AssertionError) && err && err.stack) {
        process.stdout.write(
          err.stack.split('\n').slice(1, 4).map((l) => `      ${l.trim()}`).join('\n') + '\n'
        )
      }
    }
  }

  return { passed, failed: failures.length, total: cases.length, failures }
}

module.exports = { describe, it, ok, notOk, eq, deepEq, near, fail, rejects, runAll, AssertionError }
