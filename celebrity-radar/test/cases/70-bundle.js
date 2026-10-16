'use strict'

/**
 * N-7：主包体积预算。硬限 2MB，当前 1.01MB（约 50%），看着宽松，但有两个坑是**发版那天才发现**的：
 *
 *   1. **taro-ui 的包入口摇不掉**。`import { AtButton } from 'taro-ui'` 走 package.json 的 main
 *      = `dist/index.js` —— 一个打包好的 CJS 单文件（5921 行），50 个组件的实现全在里面。webpack
 *      对 CJS 做不了 tree-shaking，于是「只用了 2 个组件」实际把 50 个都打进了 `vendors.js`。
 *      样式侧 2026-10-14 就按需引入了（app.scss 只 @import 4 个 scss），**JS 侧一直漏着**。
 *   2. **按需引入的第二个动作最容易漏**：JS 里 import 了组件，还得去 app.scss 里 @import 它的样式，
 *      否则组件渲染成一团没样子的裸块。这条靠人记必漏，故在这里钉成机械判据（正反两个方向都查）。
 *
 * 本用例只做**静态断言**（不构建）：产物体积由 `npm run build:weapp` 量，数值记在路线图 N-7 落点里。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk, deepEq } = require('../harness/t')

const ROOT = path.resolve(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

/** 剥注释后再断言：上面那两条纪律的「为什么」写在各文件的注释里，注释里带 'taro-ui' 字样是正常的 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** src 下全部 .ts/.tsx */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}
const TS_FILES = walk(SRC)

const codeOf = (f) => stripComments(fs.readFileSync(f, 'utf8'))

/** 项目实际用到的 taro-ui 组件（从 JS 侧引入语句里收） */
function usedComponents() {
  const comps = new Set()
  for (const f of TS_FILES) {
    const re = /from\s+'taro-ui\/dist\/components\/([a-z-]+)'/g
    let m
    while ((m = re.exec(codeOf(f)))) comps.add(m[1])
  }
  return comps
}

/** app.scss 里 @import 了样式的组件 */
function styledComponents() {
  const scss = fs.readFileSync(path.join(SRC, 'app.scss'), 'utf8')
  const out = new Set()
  const re = /@import\s+'taro-ui\/dist\/style\/components\/([a-z-]+)\.scss'/g
  let m
  while ((m = re.exec(scss))) out.add(m[1])
  return out
}

describe('N-7 主包体积 · taro-ui 按需引入', () => {
  it('不许再从包入口整包引入（包入口是 CJS 单文件，50 个组件摇不掉）', () => {
    const bad = TS_FILES.filter((f) => /from\s+'taro-ui'/.test(codeOf(f))).map((f) =>
      path.relative(SRC, f).replace(/\\/g, '/')
    )
    ok(bad.length === 0, `这些文件还在从包入口引入 taro-ui：${bad.join(' / ')}`)
  })

  it('组件一律从 dist/components/<名字> 取，且只用了已登记的那两个', () => {
    const comps = [...usedComponents()].sort()
    deepEq(comps, ['button', 'search-bar'], '用了新组件就要确认它的样式也按需引入了（下一条）')
  })

  it('⚠ 每引入一个组件，app.scss 必须同时引它的样式（漏了就是没样子的裸块）', () => {
    const used = [...usedComponents()].sort()
    const styled = [...styledComponents()].sort()
    ok(used.length > 0, '一个组件都没收到 = 断言写错了（下面两条会「假绿」）')
    const missing = used.filter((c) => !styled.includes(c))
    deepEq(missing, [], '用了组件却没引样式：' + missing.join(' / '))
    /* 反向：多引的样式只允许是 button 的视觉依赖 —— loading（AtButton 的 loading 属性会渲染
       AtLoading）与 icon（按钮/搜索框的图标字形）。多引一个组件的 scss 就是白花 WXSS 体积 */
    const extra = styled.filter((s) => !used.includes(s))
    deepEq(extra, ['icon', 'loading'], '多引了样式：要么补登记，要么删掉')
  })

  it('主题变量必须在 @import 之前赋值（写在后面等于没覆盖）', () => {
    const scss = fs.readFileSync(path.join(SRC, 'app.scss'), 'utf8')
    const iVar = scss.indexOf('$color-brand')
    const iImp = scss.indexOf("@import 'taro-ui/dist/style/components/")
    ok(iVar > -1, 'app.scss 找不到主题变量 $color-brand')
    ok(iImp > -1, 'app.scss 找不到 taro-ui 样式引入')
    ok(iVar < iImp, '主题变量必须写在 @import 之前')
  })

  it('依赖是登记制：加包要显式登记（顺手加个 lodash 就是几十 KB 主包）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const KEEP = [
      '@babel/runtime',
      '@tarojs/components',
      '@tarojs/helper',
      '@tarojs/plugin-platform-alipay',
      '@tarojs/plugin-platform-h5',
      '@tarojs/plugin-platform-jd',
      '@tarojs/plugin-platform-qq',
      '@tarojs/plugin-platform-swan',
      '@tarojs/plugin-platform-tt',
      '@tarojs/plugin-platform-weapp',
      '@tarojs/react',
      '@tarojs/runtime',
      '@tarojs/shared',
      '@tarojs/taro',
      'dayjs',
      'react',
      'react-dom',
      'taro-ui',
      'zod',
      'zustand'
    ]
    const added = Object.keys(pkg.dependencies).filter((k) => !KEEP.includes(k))
    deepEq(added, [], '新增依赖：登记进本用例白名单，并 `npm run build:weapp` 量一次主包体积')
    /* 按需引入依赖 3.x 的 dist/components 目录结构，升大版本前必须先确认它还在 */
    ok(/^\^?3\./.test(pkg.dependencies['taro-ui']), '升级 taro-ui 大版本前先确认 dist/components 结构')
  })
})
