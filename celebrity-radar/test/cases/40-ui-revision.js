'use strict'

/**
 * P7 UI 改版（2026-10-13）的静态约束：五处互不相关的界面调整打成一个用例文件，
 * 因为它们的共同点是「改了容易忘、忘了不报错」，都需要读源码文本钉住。
 *
 * 逐条钉住：
 *   1. 底栏「纯文字一体化按钮」：TAB_SHOW_ICON=false（无图标）、整格仍可点、选中态样式存在、
 *      纯文字被正式设计过（放大字号 / 字距 / 选中态加粗 + 品牌色 + 淡品牌底）；
 *   2. 关注人数上限**已移除**：followGate / followLimit / canAddFollow / followLimitNote 与
 *      「最多可关注」提示文案在端上全部消失，benefits.ts 的 followCount 一并删除；
 *   3. 隐私 / 免责改「合同阅览」式版式：两个版块共用同一个 LegalDoc 组件与同一套 __doc* 样式；
 *   4. 昵称点击即弹框编辑：点昵称触发、无「编辑」按钮、有取消 / 保存、复用既有保存逻辑；
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

/* ───────────────────── 1. 底栏：纯文字一体化按钮 ───────────────────── */

describe('底栏纯文字形态（TAB_SHOW_ICON = false）', () => {
  const tsx = read('components/custom-tab-bar/index.tsx')
  const scss = read('components/custom-tab-bar/index.scss')

  it('开关为 false：四个 tab 不渲染图标，图标仅在 showIcon=true 时出现', () => {
    ok(tsx.includes('const TAB_SHOW_ICON = false'), '图标开关应为 false（纯文字形态）')
    /* 两处渲染（左两格 / 右两格）都受同一开关控制 */
    ok((tsx.match(/TAB_SHOW_ICON &&/g) || []).length === 2, '图标应由开关统一控制（两处渲染）')
    /* 图标元素只在 `TAB_SHOW_ICON &&` 之后出现 —— 关掉开关即不渲染任何 tabbar__icon */
    ok(/\{TAB_SHOW_ICON && <View className=\{`tabbar__icon/.test(tsx), '图标元素必须挂在开关之下')
  })

  it('整格仍可点：onClick 挂在外层 item 上、pill 在其内部（命中区不缩小）', () => {
    ok(
      /className=\{`tabbar__item [\s\S]*?onClick=\{\(\) => switchTo\(t\.path\)\}[\s\S]*?className='tabbar__btn'/.test(tsx),
      '整格可点：onClick 挂在外层 item 上'
    )
    notOk(/tabbar__btn'[^>]*onClick/.test(tsx), '点击处理不应缩到 pill 上')
  })

  it('纯文字被正式设计过：放大字号 / 字距 / 行高，选中态加粗 + 品牌色 + 淡品牌底 pill', () => {
    /* 文字本身放大到 26rpx（原图标态 18rpx）、加字距、行高收到 1 */
    ok(/&__label\s*\{[\s\S]*?font-size:\s*26rpx/.test(scss), '纯文字字号应放大到 26rpx')
    ok(/&__label\s*\{[\s\S]*?letter-spacing:\s*2rpx/.test(scss), '纯文字应加字距')
    ok(/&__label\s*\{[\s\S]*?line-height:\s*1;/.test(scss), '纯文字行高应收到 1')
    /* 选中态：加粗 + 品牌色 */
    ok(
      /&--active \.tabbar__label\s*\{[\s\S]*?color:\s*\$brand[\s\S]*?font-weight:\s*700/.test(scss),
      '选中态应为品牌色 + 加粗（700）'
    )
    /* 选中态给整块 pill 一层淡品牌底 */
    ok(
      /&--active \.tabbar__btn\s*\{[\s\S]*?background:\s*\$brand-weak/.test(scss),
      '选中态的 pill 应有淡品牌底'
    )
    /* 未选中态用弱化灰 */
    ok(/&__label\s*\{[\s\S]*?color:\s*\$text-3/.test(scss), '未选中态应弱化为灰')
    /* pill 给最小宽度，让四个字各成一枚等宽「图形按钮」 */
    ok(/&__btn\s*\{[\s\S]*?min-width:\s*104rpx/.test(scss), 'pill 应有最小宽度（四格等宽观感）')
    /* 栏高不变：仍 112rpx（.safe-tab 无需改） */
    ok(/&__inner\s*\{[\s\S]*?height:\s*112rpx/.test(scss), '底栏高度应保持 112rpx')
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

/* ───────────────────── 3. 隐私 / 免责：合同阅览式版式 ───────────────────── */

describe('隐私 / 免责页改为合同阅览式版式（两版块共用一套）', () => {
  const tsx = read('pages/agreement/index.tsx')
  const scss = read('pages/agreement/index.scss')

  it('两个版块共用同一个 LegalDoc 组件与同一套 __doc* 类', () => {
    ok((tsx.match(/<LegalDoc /g) || []).length === 2, '隐私与免责应各渲染一次同一个 LegalDoc')
    ok(tsx.includes("className='page-agreement__doc'"), '文档根类应为 page-agreement__doc（两份共用）')
    ok(tsx.includes("title='隐私清单'") && tsx.includes("title='免责声明'"), '两个版块标题应保留原文')
  })

  it('版式特征齐备：居中标题 + 更新日期 + 编号条款 + 放宽行距 / 首行缩进', () => {
    ok(tsx.includes('更新日期：'), '应有生效 / 更新日期一行')
    ok(tsx.includes('CN_NUM') && tsx.includes('、${it.title}'), '条款应按「一、二、…」编号')
    ok(/&__doc-title\s*\{[\s\S]*?text-align:\s*center/.test(scss), '文档标题应居中')
    ok(/&__doc-title\s*\{[\s\S]*?font-weight:\s*700/.test(scss), '文档标题应加粗')
    ok(/&__doc-meta\s*\{[\s\S]*?text-align:\s*center/.test(scss), '更新日期应居中')
    ok(/&__clause-body\s*\{[\s\S]*?line-height:\s*2;/.test(scss), '正文行距应放宽到 2 倍')
    ok(/&__clause-body\s*\{[\s\S]*?text-indent:\s*2em/.test(scss), '正文应统一首行缩进')
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
