'use strict'

/**
 * P7 UI 改版（2026-10-13）的静态约束：五处互不相关的界面调整打成一个用例文件，
 * 因为它们的共同点是「改了容易忘、忘了不报错」，都需要读源码文本钉住。
 *
 * 逐条钉住：
 *   1. 底栏「传统垂直图标」形态：TAB_SHOW_ICON=true（图标在上、文字在下、不重叠）、整格仍可点；
 *      按传统 tab 语义：选中时图标与文字一起高亮（未选中图标 opacity 0.5 / 文字 $text-3，
 *      选中图标 opacity 1 / 文字 $brand + 600）；文字收小到 20rpx（原 28rpx）、图标 50rpx；
 *      并保留一条「开关置 false 回到纯文字 + 短指示条」的回退约束（防开关失效）；
 *   2. 关注人数上限**已移除**：followGate / followLimit / canAddFollow / followLimitNote 与
 *      「最多可关注」提示文案在端上全部消失，benefits.ts 的 followCount 一并删除；
 *   3. 隐私 / 免责合并为**一份连续文档**：不再有两个并列版块，正文压到 25rpx，大纲式编号；
 *   4. 昵称点击即弹框编辑：点昵称触发、无「编辑」按钮、有取消 / 保存、复用既有保存逻辑，
 *      且遮罩铺满整屏 + 居中 + 层级高于自定义 tabBar；
 *   5. 套餐卡右侧「会员版」与「收起」对齐：两者同高（40rpx）+ 同行高（line-height:1）。
 *
 * 页面是 .tsx（不进测试编译），与既有页面级用例（25-navigation-opinion / 27-opinion-tiers）同法，
 * 直接读源码文本做结构性断言。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

/* ───────────────────── 1. 底栏：传统「图标在上、文字在下」+ 文字收小 ───────────────────── */

describe('底栏传统垂直图标形态（TAB_SHOW_ICON = true，图标在上、文字在下，选中一起高亮）', () => {
  const tsx = read('components/custom-tab-bar/index.tsx')
  const scss = read('components/custom-tab-bar/index.scss')

  it('开关为 true：四个 tab 渲染图标，图标挂在开关之下（false 即不渲染）', () => {
    ok(tsx.includes('const TAB_SHOW_ICON = true'), '图标开关应为 true（图标态）')
    /* 两处渲染（左两格 / 右两格）都受同一开关控制 */
    ok((tsx.match(/TAB_SHOW_ICON &&/g) || []).length === 2, '图标应由开关统一控制（两处渲染）')
    /* 图标元素只在 `TAB_SHOW_ICON &&` 之后出现 —— 关掉开关即不渲染任何 tabbar__icon */
    ok(/\{TAB_SHOW_ICON && <View className=\{`tabbar__icon/.test(tsx), '图标元素必须挂在开关之下')
    /* 根容器按开关挂形态类：icon / text 两套样式各在自己作用域，互不污染 */
    ok(
      tsx.includes("${TAB_SHOW_ICON ? 'tabbar--icon' : 'tabbar--text'}"),
      '根容器要按开关挂 tabbar--icon / tabbar--text（两套样式各在自己作用域）'
    )
  })

  it('整格仍可点：onClick 挂在外层 item 上、内容容器在其内部（命中区不缩小）', () => {
    ok(
      /className=\{`tabbar__item [\s\S]*?onClick=\{\(\) => switchTo\(t\.path\)\}[\s\S]*?className='tabbar__btn'/.test(tsx),
      '整格可点：onClick 挂在外层 item 上'
    )
    notOk(/tabbar__btn'[^>]*onClick/.test(tsx), '点击处理不应缩到内容容器上')
  })

  it('传统垂直排布：内容容器 flex-direction: column + 居中 + 行间距 6rpx（图标与文字不重叠）', () => {
    ok(
      /\.tabbar--icon[\s\S]*?\.tabbar__btn\s*\{[\s\S]*?flex-direction:\s*column/.test(scss),
      '图标态应改为垂直排布（flex-direction: column，图标在上、文字在下）'
    )
    ok(
      /\.tabbar--icon[\s\S]*?\.tabbar__btn\s*\{[\s\S]*?align-items:\s*center/.test(scss),
      '垂直排布应水平居中（align-items: center）'
    )
    ok(/\.tabbar--icon[\s\S]*?\.tabbar__btn\s*\{[\s\S]*?gap:\s*6rpx/.test(scss), '图标与文字行间距应为 6rpx')
  })

  it('图标回到静态流：不再是背景层（无 absolute / 无 z-index 分层），尺寸回到传统 50rpx', () => {
    /* 上一版是「绝对定位垫在文字后」，本版必须去掉：不再有 absolute / 居中偏移 / 层级 */
    notOk(
      /\.tabbar--icon[\s\S]*?\.tabbar__icon\s*\{[\s\S]*?position:\s*absolute/.test(scss),
      '图标不应再绝对定位（不再是背景层）'
    )
    notOk(/\.tabbar--icon[\s\S]*?\.tabbar__icon\s*\{[\s\S]*?z-index/.test(scss), '图标不应再有 z-index 分层')
    notOk(
      /\.tabbar--icon[\s\S]*?\.tabbar__icon\s*\{[\s\S]*?translate\(-50%,\s*-50%\)/.test(scss),
      '图标不应再有居中偏移（translate(-50%,-50%)）'
    )
    ok(/\.tabbar--icon[\s\S]*?\.tabbar__icon\s*\{[\s\S]*?width:\s*50rpx/.test(scss), '图标宽应为 50rpx（传统尺寸，不再是 72rpx）')
    ok(/\.tabbar--icon[\s\S]*?\.tabbar__icon\s*\{[\s\S]*?height:\s*50rpx/.test(scss), '图标高应为 50rpx')
  })

  it('选中态按传统语义：图标与文字一起高亮 —— 选中图标比未选中更实（0.5 -> 1）', () => {
    ok(/\.tabbar--icon[\s\S]*?\.tabbar__icon\s*\{[\s\S]*?opacity:\s*0\.5/.test(scss), '未选中图标应为 0.5（弱化）')
    ok(
      /\.tabbar--icon[\s\S]*?\.tabbar__item--active \.tabbar__icon\s*\{[\s\S]*?opacity:\s*1/.test(scss),
      '选中图标应提到 1（满实、品牌色）'
    )
    /* 传统不变量：选中图标 opacity > 未选中图标 opacity —— 数值比较，别退化成两个孤立字面量 */
    const unIcon = scss.match(/\.tabbar--icon[\s\S]*?\.tabbar__icon\s*\{[\s\S]*?opacity:\s*([\d.]+)/)
    const acIcon = scss.match(/\.tabbar--icon[\s\S]*?\.tabbar__item--active \.tabbar__icon\s*\{[\s\S]*?opacity:\s*([\d.]+)/)
    ok(unIcon && acIcon, '应能从图标态作用域取出未选中 / 选中两种图标 opacity')
    ok(
      parseFloat(acIcon[1]) > parseFloat(unIcon[1]),
      `选中图标应比未选中更实（实际 ${acIcon[1]} vs ${unIcon[1]}）`
    )
    /* 选中文字（基础 __item--active）品牌色 + 600：与图标一起高亮 */
    ok(/&--active \.tabbar__label\s*\{[\s\S]*?color:\s*\$brand/.test(scss), '选中态文字应为品牌色')
    ok(/&--active \.tabbar__label\s*\{[\s\S]*?font-weight:\s*600/.test(scss), '选中态文字应为 600（与图标一起高亮）')
  })

  it('去掉图标态选中指示条：垂直排布下不再需要短横条（display:none）', () => {
    ok(
      /\.tabbar--icon[\s\S]*?\.tabbar__btn::after\s*\{[\s\S]*?display:\s*none/.test(scss),
      '图标态选中指示条应隐藏（display:none）'
    )
    notOk(/\.tabbar--icon[\s\S]*?bottom:\s*-16rpx/.test(scss), '不应再保留上一版下移到 -16rpx 的指示条')
  })

  it('文字收小：图标态字号 20rpx（原 28rpx）+ 字距收到 1rpx + 行高 1；未选中弱灰、选中品牌色', () => {
    ok(
      /\.tabbar--icon[\s\S]*?\.tabbar__label\s*\{[\s\S]*?font-size:\s*20rpx/.test(scss),
      '图标态文字字号应为 20rpx（比 28rpx 明显缩小）'
    )
    ok(
      /\.tabbar--icon[\s\S]*?\.tabbar__label\s*\{[\s\S]*?letter-spacing:\s*1rpx/.test(scss),
      '图标态文字字距应收到 1rpx'
    )
    /* 字号确实比基础（纯文字态）的 28rpx 更小 */
    const baseSize = scss.match(/&__label\s*\{[\s\S]*?font-size:\s*(\d+)rpx/)
    const iconSize = scss.match(/\.tabbar--icon[\s\S]*?\.tabbar__label\s*\{[\s\S]*?font-size:\s*(\d+)rpx/)
    ok(baseSize && iconSize, '应能取出基础字号与图标态字号')
    ok(
      parseFloat(iconSize[1]) < parseFloat(baseSize[1]),
      `图标态字号应小于基础字号（实际 ${iconSize[1]} vs ${baseSize[1]}）`
    )
    /* 小字不弱化到 400：字重沿用基础的 500 / 选中 600（否则小字笔画发虚） */
    notOk(
      /\.tabbar--icon[\s\S]*?\.tabbar__label\s*\{[\s\S]*?font-weight:\s*400/.test(scss),
      '小字不应弱化到 400'
    )
    /* 未选中（基础）弱灰：小字仍是灰的、选中才品牌色 */
    ok(/&__label\s*\{[\s\S]*?color:\s*\$text-3/.test(scss), '未选中（基础）应弱化为灰')
    /* 基础文字度量未受影响：字号 28rpx、字距 2rpx、行高 1（图标态只覆盖字号 / 字距两项） */
    ok(/&__label\s*\{[\s\S]*?font-size:\s*28rpx/.test(scss), '基础字号应仍为 28rpx')
    ok(/&__label\s*\{[\s\S]*?letter-spacing:\s*2rpx/.test(scss), '基础字距应仍为 2rpx')
    ok(/&__label\s*\{[\s\S]*?line-height:\s*1;/.test(scss), '文字行高应为 1')
  })

  it('去掉 pill 底色与内边距：不再有选中态淡品牌底 / 最小宽度 / 左右内边距', () => {
    notOk(scss.includes('$brand-weak'), '选中态的淡品牌底 pill 应彻底去掉')
    ok(/&__btn\s*\{[\s\S]*?padding:\s*0;/.test(scss), '内容容器不应再有内边距')
    notOk(/&__btn\s*\{[\s\S]*?min-width:\s*104rpx/.test(scss), '不应再有 pill 的最小宽度')
    notOk(/&__btn\s*\{[\s\S]*?border-radius:\s*999rpx/.test(scss), '不应再有 pill 的大圆角')
  })

  it('栏高不变：仍 112rpx（.safe-tab 无需改）', () => {
    ok(/&__inner\s*\{[\s\S]*?height:\s*112rpx/.test(scss), '底栏高度应保持 112rpx')
  })

  it('开关置 false 时回到纯文字形态：图标不渲染 + 保留选中短指示条（防开关失效）', () => {
    /* 图标挂在 `TAB_SHOW_ICON &&` 之下：置 false ⇒ 不渲染任何 tabbar__icon（纯文字） */
    ok(/\{TAB_SHOW_ICON && <View className=\{`tabbar__icon/.test(tsx), '图标元素必须挂在开关之下（false 即不渲染）')
    ok(tsx.includes("'tabbar--text'"), '根容器要能切到 tabbar--text（纯文字形态）')
    /* 纯文字形态的短指示条仍完整 */
    ok(/&__btn\s*\{[\s\S]*?&::after\s*\{[\s\S]*?position:\s*absolute/.test(scss), '指示条应绝对定位')
    ok(/&__btn\s*\{[\s\S]*?&::after\s*\{[\s\S]*?height:\s*4rpx/.test(scss), '指示条高应为 4rpx')
    ok(/&__btn\s*\{[\s\S]*?&::after\s*\{[\s\S]*?background:\s*\$brand/.test(scss), '指示条应为品牌色')
    ok(/&__btn\s*\{[\s\S]*?&::after\s*\{[\s\S]*?width:\s*0;/.test(scss), '指示条默认宽度应为 0（未选中不可见）')
    ok(/&__item--active \.tabbar__btn::after\s*\{\s*width:\s*40rpx/.test(scss), '选中态指示条应展开到 40rpx')
  })
})

/* ───────────────────── 2. 关注人数上限已移除 ───────────────────── */

describe('关注人数上限已移除（端上门禁 / 提示 / 真源一并清理）', () => {
  const oa = read('utils/opinion-access.ts')
  const follows = read('utils/follows.ts')
  const benefits = read('config/benefits.ts')
  const following = read('pages/following/index.tsx')
  const followingScss = read('pages/following/index.scss')
  const member = read('pages/member/index.tsx')

  it('取用层不再导出关注门禁；真源不再有 followCount', () => {
    notOk(/followGate|followLimit|canAddFollow\b/.test(oa), 'opinion-access 不得再有关注门禁')
    notOk(oa.includes('最多可关注'), 'opinion-access 不得再有关注上限提示文案')
    notOk(/followCount\s*:\s*\{/.test(benefits), 'benefits.ts 的 OPINION_LIMITS 不得再定义 followCount')
    /* 关键词 / 风险监控两维仍在（别顺手删错） */
    ok(/watchCount:\s*\{/.test(benefits) && /personWatchCount:\s*\{/.test(benefits), '另外两维上限应保留')
  })

  it('follows.ts 新增关注不再有门禁（改包也不会被端上拦）', () => {
    notOk(follows.includes('followGate('), 'follows.ts 不得再调用 followGate')
    notOk(follows.includes('followLimitNote('), 'follows.ts 不得再用关注上限提示')
    notOk(follows.includes('readMemberState'), 'follows.ts 不再需要为关注上限读会员态')
    /* 关注 / 取关的既有切换分支仍在 */
    ok(follows.includes("table('follows').insert("), '新增关注分支应保留')
    ok(follows.includes("table('follows').delete().eq('id', id)"), '取关分支应保留')
    /* 注释交代「为什么现在可以不设上限」 */
    ok(follows.includes('不设上限'), '应留一句「为什么现在可以不设上限」的说明')
    ok(follows.includes('云端'), '应说明将来要参与成本须在云端补校验')
  })

  it('关注列表页与会员对比表都不再出现关注上限', () => {
    notOk(
      following.includes('followGate(') || following.includes('followLimitNote('),
      '关注页不得再调用门禁 / 提示'
    )
    notOk(following.includes('page-following__limit'), '关注页上限提示行应删除')
    notOk(followingScss.includes('&__limit'), '关注页上限提示样式应一并清理')
    notOk(member.includes('OPINION_LIMITS.followCount'), '会员页不得再引用 followCount')
    /* 会员对比表保留行、两栏写明不限 */
    ok(member.includes("name: '关注名人'") && member.includes("free: '不限人数'"), '会员对比表应如实写「不限人数」')
  })
})

/* ───────────────────── 3. 隐私 / 免责：合并为一份连续文档 ───────────────────── */

describe('隐私 / 免责页合并为一份连续文档（大纲式版式）', () => {
  const tsx = read('pages/agreement/index.tsx')
  const scss = read('pages/agreement/index.scss')

  it('只有一份文档：不再有两个并列的 LegalDoc / 版块容器', () => {
    ok((tsx.match(/className='page-agreement__doc'/g) || []).length === 1, '整页应只有一份文档容器')
    notOk(tsx.includes('<LegalDoc'), '不应再并列渲染两个 LegalDoc 版块')
    ok(tsx.includes('隐私与免责声明'), '文档标题应合并为一份「隐私与免责声明」')
    ok(tsx.includes("title: '隐私清单'") && tsx.includes("title: '免责声明'"), '两大部分标题应保留原文')
  })

  it('大纲式编号存在：一级「一、二」+ 二级「1.1 / 1.2」', () => {
    ok(tsx.includes("no: '一'") && tsx.includes("no: '二'"), '应有一级中文序号（一、二）')
    ok(tsx.includes('${s.no}、${s.title}'), '一级标题应拼「一、标题」')
    ok(tsx.includes('${s.index}.${i + 1}'), '二级条款应拼「1.1 / 1.2」')
    ok(scss.includes('&__section-title'), '应有一级条款标题样式')
    ok(/&__section-title\s*\{[\s\S]*?font-weight:\s*700/.test(scss), '一级标题应比二级更重（700）')
    ok(scss.includes('&__clause-title'), '应有二级条款标题样式')
  })

  it('正文更小（25rpx，原 27rpx）+ 行距仍 2 倍 + 首行缩进', () => {
    ok(/&__clause-body\s*\{[\s\S]*?font-size:\s*25rpx/.test(scss), '正文应压到 25rpx（比原 27rpx 更小）')
    ok(/&__clause-body\s*\{[\s\S]*?line-height:\s*2;/.test(scss), '行距仍为 2 倍（不因字小而变密）')
    ok(/&__clause-body\s*\{[\s\S]*?text-indent:\s*2em/.test(scss), '正文保留首行缩进')
    notOk(/font-size:\s*27rpx/.test(scss), '不应再出现 27rpx 正文（原值）')
  })

  it('顶部标题 + 更新/生效日期一行小字 + 静态目录（大纲）', () => {
    ok(tsx.includes('更新日期：') && tsx.includes('生效日期：'), '顶部应有更新日期 / 生效日期一行')
    ok(tsx.includes('page-agreement__toc'), '应有静态目录（大纲）')
    ok(scss.includes('&__toc-item'), '目录条目样式应存在')
    ok(/&__doc-title\s*\{[\s\S]*?text-align:\s*center/.test(scss), '文档标题应居中')
    ok(/&__doc-title\s*\{[\s\S]*?font-weight:\s*700/.test(scss), '文档标题应加粗')
    ok(/&__doc-meta\s*\{[\s\S]*?text-align:\s*center/.test(scss), '日期行应居中')
    /* 旧「圆圈编号 + 每条一张卡」的版式类应清理干净 */
    notOk(scss.includes('&__item-no'), '旧编号圆圈样式应清理')
    notOk(tsx.includes('page-agreement__item'), '旧条目版式类应清理')
  })
})

/* ───────────────────── 4. 昵称点击即弹框编辑 ───────────────────── */

describe('编辑昵称：点昵称即弹框，去掉「编辑」按钮', () => {
  const tsx = read('pages/mine/index.tsx')
  const scss = read('pages/mine/index.scss')

  it('点击昵称触发编辑，且不再有「编辑」文字按钮', () => {
    ok(/className='page-mine__name' onClick=\{openNickEditor\}/.test(tsx), '昵称本身应是编辑入口')
    ok(tsx.includes('openNickEditor'), '仍复用既有 openNickEditor')
    /* 注意用 \b：page-mine__edit 是 page-mine__editor 的子串，不能裸 includes */
    notOk(/page-mine__edit\b/.test(tsx), '不得再有「编辑」文字按钮')
    notOk(/&__edit\s*\{/.test(scss), '「编辑」按钮样式应一并清理')
  })

  it('弹框有取消 / 保存，且复用既有校验与保存逻辑', () => {
    ok(tsx.includes('page-mine__editor-mask'), '应有模态遮罩（点遮罩关闭）')
    ok(tsx.includes('catchMove'), '遮罩应 catchMove，避免滚动穿透')
    ok(tsx.includes('修改昵称'), '弹框应有标题')
    ok(tsx.includes("type='nickname'"), '仍用原生 nickname 输入（否则没有微信昵称快捷填充）')
    ok(tsx.includes('stopPropagation'), '点卡片本体不应冒泡到遮罩（避免误关）')
    /* 取消 / 保存走既有实现，未新写一套保存 */
    ok(tsx.includes("onClick={() => setEditingNick(false)}"), '应有「取消」关闭')
    ok(tsx.includes('submitNick()'), '保存应复用既有的 submitNick')
    ok(tsx.includes('saveProfile'), '保存仍走既有 saveProfile（失败有 toast 提示）')
    /* 样式：遮罩 + 卡片 + 标题 */
    ok(scss.includes('&__editor-mask'), '应有遮罩样式')
    ok(scss.includes('&__editor-title'), '应有弹框标题样式')
  })

  it('弹层遮罩铺满整屏（含底部悬浮栏）+ 双向居中 + 层级高于自定义 tabBar', () => {
    /*
     * `.glow-overlay` 只给 fixed 与 z-index、**不给四边偏移**：
     * 只写 fixed 而不写 left/right/top/bottom 时，遮罩停在静态位置并按内容收缩 ——
     * 既不铺满整屏，也无法把卡片居中（这正是「不居中 / 被悬浮栏压住」的真实成因）。
     * 故这里钉死四边归零 + flex 双向居中。
     */
    ok(/&__editor-mask\s*\{[\s\S]*?left:\s*0;/.test(scss), '遮罩应 left:0')
    ok(/&__editor-mask\s*\{[\s\S]*?right:\s*0;/.test(scss), '遮罩应 right:0')
    ok(/&__editor-mask\s*\{[\s\S]*?top:\s*0;/.test(scss), '遮罩应 top:0')
    ok(/&__editor-mask\s*\{[\s\S]*?bottom:\s*0;/.test(scss), '遮罩应 bottom:0（含底部悬浮栏区域）')
    ok(/&__editor-mask\s*\{[\s\S]*?display:\s*flex/.test(scss), '遮罩应 flex')
    ok(/&__editor-mask\s*\{[\s\S]*?align-items:\s*center/.test(scss), '遮罩应垂直居中')
    ok(/&__editor-mask\s*\{[\s\S]*?justify-content:\s*center/.test(scss), '遮罩应水平居中')
    /* 层级：弹层用 .glow-overlay（app.scss 给死 1200），应高于 custom-tab-bar 的 999 */
    ok(tsx.includes('glow-overlay'), '弹层应挂 .glow-overlay（fixed + z-index 的来源）')
    const appScss = read('app.scss')
    const tabScss = read('components/custom-tab-bar/index.scss')
    const overlayZ = Number((/>\s*\.glow-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/.exec(appScss) || [])[1])
    const tabZ = Number((/z-index:\s*(\d+)/.exec(tabScss) || [])[1])
    ok(overlayZ > 0 && tabZ > 0, '应能读出弹层与 tabBar 的 z-index')
    ok(overlayZ > tabZ, `弹层 z-index（${overlayZ}）应高于自定义 tabBar（${tabZ}）`)
  })
})

/* ───────────────────── 5. 套餐卡右侧对齐 ───────────────────── */

describe('套餐卡右侧「会员版 / 收起」垂直对齐', () => {
  const scss = read('pages/mine/index.scss')

  it('档位标签与折叠开关同高（40rpx）+ 同行高（line-height:1），父容器居中', () => {
    ok(/&__quota-head-right\s*\{[\s\S]*?align-items:\s*center/.test(scss), 'head-right 应垂直居中')
    ok(/&__quota-tag\s*\{[\s\S]*?height:\s*40rpx/.test(scss), '档位标签应定高 40rpx')
    ok(/&__quota-tag\s*\{[\s\S]*?line-height:\s*1;/.test(scss), '档位标签行高应为 1')
    ok(/&__quota-fold\s*\{[\s\S]*?height:\s*40rpx/.test(scss), '折叠开关应与标签同高 40rpx')
    ok(/&__quota-fold-text\s*\{[\s\S]*?line-height:\s*1;/.test(scss), '折叠文字行高应为 1（与标签一致）')
    /* 二者内容竖直居中：不再靠 padding 撑高造成盒高不等 */
    ok(/&__quota-tag\s*\{[\s\S]*?align-items:\s*center/.test(scss), '档位标签内容应竖直居中')
    ok(/&__quota-fold\s*\{[\s\S]*?align-items:\s*center/.test(scss), '折叠开关内容应竖直居中')
  })
})
