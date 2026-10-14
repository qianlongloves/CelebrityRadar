'use strict'

/**
 * 底部菜单改版与新增舆情页（2026-10-13）的静态约束。
 *
 * 这一版把底栏从「贴底通栏」换成「悬浮胶囊」，四格为 发现/提问/舆情/我的（均 2 字，
 * 前两格与末格沿用原来的叫法，第三格换成新的舆情聚合页）、并新增 pages/opinion
 * 承载原来首页的三个图标入口。
 *
 * 页面是 .tsx，不进 tsc 的测试编译（test/tsconfig.test.json 只收 utils/config/stores/types），
 * 故这里与既有页面级用例（12-weekly-content / 13-messages / 04-member-cache）同法：
 * 直接读源码文本做结构性断言。逐条钉住「改了容易忘、忘了不报错」的地方。
 */

const fs = require('fs')
const path = require('path')
const { describe, it, ok, notOk } = require('../harness/t')

const SRC = path.resolve(__dirname, '..', '..', 'src')
const read = (p) => fs.readFileSync(p, 'utf8')

describe('底部菜单：四格文案与路由（静态约束）', () => {
  const appConfig = read(path.join(SRC, 'app.config.ts'))
  const tabbarTsx = read(path.join(SRC, 'components', 'custom-tab-bar', 'index.tsx'))

  /** 截出 tabBar.list 的文本（pages 数组里也有 collection，必须只查 tabBar 段） */
  const tabBarList = (() => {
    const tab = appConfig.slice(appConfig.indexOf('tabBar:'))
    const start = tab.indexOf('list: [')
    return tab.slice(start, tab.indexOf(']', start))
  })()

  it('app.config 的 tabBar.list 是 发现 / 提问 / 舆情 / 我的 四格，且指向四个 tab 页', () => {
    ok(appConfig.includes('custom: true'), '自定义 tabBar 开关不能丢')
    for (const [pagePath, text] of [
      ['pages/index/index', '发现'],
      ['pages/ask/index', '提问'],
      ['pages/opinion/index', '舆情'],
      ['pages/mine/index', '我的']
    ]) {
      ok(
        tabBarList.includes(`pagePath: '${pagePath}', text: '${text}'`),
        `tabBar.list 缺「${text}」→ ${pagePath}`
      )
    }
  })

  it('收藏不再是 tab：tabBar.list 里没有 package/collection/index', () => {
    notOk(
      tabBarList.includes('package/collection/index'),
      '收藏已并入「我的」，不能再挂在底部菜单上'
    )
  })

  it('app.config 的 pages 数组注册了舆情页', () => {
    const pages = appConfig.slice(appConfig.indexOf('pages: ['), appConfig.indexOf(']', appConfig.indexOf('pages: [')))
    ok(pages.includes("'pages/opinion/index'"), 'pages/opinion/index 必须注册，否则 tab 打不开')
  })

  it('组件 TABS 与 app.config 同源：四条路径、四个新文案、无收藏', () => {
    for (const path of ['/pages/index/index', '/pages/ask/index', '/pages/opinion/index', '/pages/mine/index']) {
      ok(tabbarTsx.includes(`path: '${path}'`), `TABS 缺 ${path}`)
    }
    for (const label of ["label: '发现'", "label: '提问'", "label: '舆情'", "label: '我的'"]) {
      ok(tabbarTsx.includes(label), `TABS 缺文案 ${label}`)
    }
    notOk(tabbarTsx.includes('/package/collection/index'), 'TABS 里不能残留收藏')
    /* 新增槽位用 eye 眼睛图标（盯舆情）；SCSS 里必须有对应造型，否则是空白图标 */
    ok(tabbarTsx.includes("label: '舆情', icon: 'eye'"), '「舆情」应配 eye 图标')
  })

  it('图标令牌与样式齐全：$icon-eye 有定义、tabbar__icon--eye 有造型', () => {
    const icons = read(path.join(SRC, 'styles', 'tabbar-icons.scss'))
    const scss = read(path.join(SRC, 'components', 'custom-tab-bar', 'index.scss'))
    ok(/\$icon-eye:\s*url\(/.test(icons), 'styles/tabbar-icons.scss 缺 $icon-eye 令牌')
    ok(scss.includes('&--eye { background-image: $icon-eye; }'), 'tabbar__icon--eye 未绑定 $icon-eye')
  })

  it('传统垂直排布：图标与文字收进同一容器 .tabbar__btn，图标在上、文字在下、不重叠，整格仍可点', () => {
    const scss = read(path.join(SRC, 'components', 'custom-tab-bar', 'index.scss'))
    /* 图标与文字在**同一个**内容容器 .tabbar__btn 内（垂直排布：图标在上、文字在下） */
    ok(tabbarTsx.includes("className='tabbar__btn'"), '每个 tab 应把图标与文字收进同一容器 .tabbar__btn')
    const btnBlocks = tabbarTsx.match(/<View className='tabbar__btn'>[\s\S]*?<\/View>/g) || []
    ok(btnBlocks.length === 2, `左右两槽位应各有一个 .tabbar__btn（实际 ${btnBlocks.length}）`)
    for (const b of btnBlocks) {
      ok(
        b.includes('tabbar__icon--${t.icon}') && b.includes("className='tabbar__label'"),
        '同一个 .tabbar__btn 内应同时含图标与文字'
      )
    }
    /* 唯一切换点：模块级 TAB_SHOW_ICON；2026-10-13 定为 true（传统垂直图标），两处渲染共用同一开关 */
    ok(tabbarTsx.includes('const TAB_SHOW_ICON = true'), '应开启图标、走传统垂直形态（唯一切换点）')
    ok((tabbarTsx.match(/TAB_SHOW_ICON &&/g) || []).length === 2, '两处渲染都应受同一开关控制')
    /* 整格可点：onClick 在 item 上（包裹 .tabbar__btn），不是只点图标 / 只点文字 */
    ok(
      /className=\{`tabbar__item [\s\S]*?onClick=\{\(\) => switchTo\(t\.path\)\}[\s\S]*?className='tabbar__btn'/.test(
        tabbarTsx
      ),
      '整格可点：onClick 挂在外层 item 上，内容容器在其内部'
    )
    ok(
      !/tabbar__btn'[^>]*onClick/.test(tabbarTsx) && !/tabbar__icon[^}]*onClick/.test(tabbarTsx),
      '点击处理不应只挂在图标或文字上（否则命中区缩小）'
    )
    /* 传统垂直形态：图标态样式收在 .tabbar--icon 作用域 —— 图标回静态流（非绝对定位 / 非背景层），
       内容容器改竖排、图标在上文字在下 */
    ok(scss.includes('&__btn'), '缺 .tabbar__btn 样式')
    ok(
      /\.tabbar--icon[\s\S]*?\.tabbar__btn\s*\{[\s\S]*?flex-direction:\s*column/.test(scss),
      '内容容器应改竖排（flex-direction: column，图标在上、文字在下）'
    )
    ok(
      !/\.tabbar--icon[\s\S]*?\.tabbar__icon\s*\{[\s\S]*?position:\s*absolute/.test(scss),
      '图标不应再绝对定位（不再是垫在文字后的背景层）'
    )
    ok(
      !/\.tabbar--icon[\s\S]*?\.tabbar__label\s*\{[\s\S]*?z-index/.test(scss),
      '文字不应再有 z-index 分层（不再压图层）'
    )
  })
})

describe('底部菜单：悬浮胶囊样式与底部预留（静态约束）', () => {
  const scss = read(path.join(SRC, 'components', 'custom-tab-bar', 'index.scss'))
  const appScss = read(path.join(SRC, 'app.scss'))

  it('底栏是悬浮胶囊：四周留白 + 四角一致圆角 + 毛玻璃', () => {
    ok(/left:\s*24rpx/.test(scss), '悬浮形态左边要留 24rpx 间距')
    ok(/right:\s*24rpx/.test(scss), '悬浮形态右边要留 24rpx 间距')
    /*
     * 只钉「含安全区」这个不变量，不钉具体像素 —— 间距是观感参数，微调它不该弄红用例
     * （2026-10-13 由 24rpx 调到 12rpx：悬浮栏要更贴近底部）。
     */
    ok(
      /bottom:\s*calc\(\d+rpx \+ env\(safe-area-inset-bottom\)\)/.test(scss),
      '底部间距要含安全区，避免压到 Home 指示条'
    )
    /* 四角一致：再出现「上圆下平」的写法就说明没改干净 */
    ok(/border-radius:\s*40rpx;/.test(scss), '四角统一 40rpx 圆角')
    notOk(/border-radius:\s*44rpx 44rpx 0 0/.test(scss), '不能再保留「上圆下平」的贴底圆角')
    ok(scss.includes('backdrop-filter'), '毛玻璃：标准属性')
    ok(scss.includes('-webkit-backdrop-filter'), '毛玻璃：WebKit 前缀')
    /*
     * 背景取页面底色：原先的浅紫底会在悬浮栏与内容之间显出一条明显边界。
     * 只钉「色取 $bg」，不钉不透明度 —— 它是观感参数（0.94/0.97 来回调过），
     * 钉死数字会让每次调透明度都弄红用例。
     */
    ok(/background:\s*rgba\(\$bg,\s*0\.\d+\)/.test(scss), '背景与内容同色（$bg），边界不易察觉')
    /*
     * 兜底色：现在「兜底」与「毛玻璃底色」是同一层（rgba($bg, 0.94)），
     * 上面那条已钉住它的色与不透明度 —— 不够不透明时，不支持毛玻璃的机型上文字会糊在内容里。
     */
  })

  it('.safe-tab 底部预留不遮挡悬浮栏（≥ 栏高 112rpx）', () => {
    /*
     * 只钉「够不够、含不含安全区」，不钉具体数值 —— 140rpx 是按观感调出来的
     * （200rpx 会在栏与内容间留一条明显空白），钉死数字会让每次微调都弄红用例。
     */
    const m = /\.safe-tab\s*\{\s*[\s\S]*?padding-bottom:\s*calc\((\d+)rpx \+ env\(safe-area-inset-bottom\)\)/.exec(
      appScss
    )
    ok(!!m, '.safe-tab 要用 calc(Nrpx + env(safe-area-inset-bottom)) 留出底部空间')
    ok(Number(m[1]) >= 112, `.safe-tab 预留 ${m[1]}rpx 小于悬浮栏高度 112rpx，内容会被压住`)
    notOk(/calc\(160rpx \+ env\(safe-area-inset-bottom\)\)/.test(appScss), '160rpx 是贴底时的旧值')
  })
})

describe('舆情页：三块内容与页面骨架（静态约束）', () => {
  const page = read(path.join(SRC, 'pages', 'opinion', 'index.tsx'))
  const config = read(path.join(SRC, 'pages', 'opinion', 'index.config.ts'))
  const scss = read(path.join(SRC, 'pages', 'opinion', 'index.scss'))

  it('数据层复用既有 utils，不另起一套云端读写', () => {
    for (const imp of [
      "from '@/utils/follows'",
      "from '@/utils/cache'",
      "from '@/utils/weekly'",
      "from '@/utils/keyword-alert'",
      "from '@/utils/risk-watch'"
    ]) {
      ok(page.includes(imp), `舆情页应复用 ${imp}`)
    }
  })

  it('三块内容齐备：关注动态 / 本周周报 / 监控', () => {
    ok(page.includes('📡 关注动态'), '缺「关注动态」块')
    ok(page.includes('📰 本周周报'), '缺「本周周报」块')
    ok(page.includes('🔔 监控'), '缺「监控」块')
  })

  it('每块都能进完整页：feed / weekly / alerts', () => {
    for (const url of ['/package/feed/index', '/package/weekly/index', '/package/alerts/index']) {
      ok(page.includes(url), `舆情页缺少进入 ${url} 的入口`)
    }
    ok(page.includes('查看全部'), '每块要有「查看全部」入口')
  })

  it('三块各自具备加载态 / 空态 / 失败降级（失败只降级本块）', () => {
    ok(page.includes('正在读取关注动态…'), '关注动态缺加载态')
    ok(page.includes('正在读取周报状态…'), '周报缺加载态')
    ok(page.includes('正在读取预警…'), '预警缺加载态')
    ok(page.includes('还没有关注的动态'), '关注动态缺空态文案')
    ok(page.includes('还没有监测中的关键词'), '预警缺空态文案')
    ok(page.includes('page-opinion__hint--err'), '缺失败降级行样式')
    ok(page.includes('点此重试'), '失败降级要能重试')
    /* 三块各写一次 status: 'error' —— 正好 3 处，证明每块独立降级（不是整页一个兜底） */
    const errCount = (page.match(/status: 'error'/g) || []).length
    ok(errCount === 3, `每块各自 catch 降级，期望 3 处 status:'error'，实际 ${errCount}`)
  })

  it('是 tab 页：挂 .safe-tab 并同步 tabBar 选中态', () => {
    ok(page.includes("className='page-opinion glow-page safe-tab'"), '页面根容器要挂 .safe-tab')
    ok(page.includes("from '@/utils/tabbar'") && page.includes('useTabBarSync()'), 'tab 页要同步底栏选中态')
  })

  it('页面配置标题为「舆情」，且样式文件存在', () => {
    ok(config.includes("navigationBarTitleText: '舆情'"), '导航栏标题应为「舆情」')
    ok(scss.includes('.page-opinion'), '舆情页样式文件缺失或未以 .page-opinion 起头')
  })
})
