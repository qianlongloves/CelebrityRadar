'use strict';

/**
 * 系统设置页（2026-10-17）：更新提醒 / 导出个人数据 / 清空数据 / 注销账号 从「我的」收到一页。
 *
 * 为什么单开一页：「我的」首屏被用量卡与模型选择占满，这四个**低频、后果重**的入口夹在
 * 「关注的名人 / 我的收藏 / 浏览历史」中间，既容易误触，也让人每次翻菜单都要看见几个红色项。
 *
 * 本文件钉的是**迁移的完整性**，不是视觉：
 *   ① 页面真的注册进分包了（漏了这步的表现是「点了没反应」，静默失败最难查）；
 *   ② 四项都在新页、且**不在**旧页（两处入口 = 用户退回来不知道该从哪进）；
 *   ③ 「我的」页那行入口的说法要让人猜得到注销在里面（政策承诺的入口不能藏到看不见）；
 *   ④ 政策 / 提示文案里的路径与真实入口一致（承诺与实现各说各话，等于承诺落空）；
 *   ⑤ 清空与注销的区别在页面上说得出来（并排放置时最容易混）。
 */

const fs = require('fs');
const path = require('path');
const { describe, it, ok, notOk, eq } = require('../harness/t');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
/* 剥注释后再断言：本模块里「为什么这么做」的解释性注释会被当成违规（见 70 / 83 的教训） */
const codeOf = (p) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SETTINGS = 'package/settings/index.tsx';
const MINE = 'pages/mine/index.tsx';

/** 四个被迁移的入口：菜单项标题（= 用户实际看到的字） */
const ITEMS = ['更新提醒', '导出个人数据', '清空数据', '注销账号'];

describe('系统设置页：注册进分包、页面文件齐全', () => {
  it('分包注册了 settings/index（漏了这步是「点了没反应」，不是报错）', () => {
    const app = read('app.config.ts');
    ok(app.includes("'settings/index'"), 'app.config.ts 的 subpackages 里要有 settings/index');
    ok(/package\/settings/.test(app), '注释里也该写明这页的来路');
  })

  it('三个文件齐备（tsx / scss / config），scss 自带 variables 导入', () => {
    ok(read(SETTINGS).length > 0, '页面主体');
    ok(read('package/settings/index.config.ts').includes("navigationBarTitleText: '系统设置'"), '导航栏标题');
    const scss = read('package/settings/index.scss');
    ok(scss.includes("@import '../../styles/variables.scss'"), '分包页 scss 必须自带变量导入（漏了构建直接 SassError）');
    ok(/\.page-settings__menu\s*\{/.test(scss), '菜单项的样式要真的定义（只加类名不写样式最难发现）');
  })
})

describe('四项都迁走了：新页有、旧页没有', () => {
  const settings = codeOf(SETTINGS);
  const mine = codeOf(MINE);

  it('四项都在系统设置页', () => {
    ITEMS.forEach((title) => {
      ok(settings.includes(`title: '${title}'`), `系统设置页应有「${title}」`)
    })
  })

  it('「我的」页不再保留这四项（两处入口 = 用户不知道该从哪进）', () => {
    ITEMS.forEach((title) => {
      notOk(mine.includes(`title: '${title}'`), `「${title}」已迁走，「我的」页不该再有`)
    })
  })

  it('被迁走的四个处理函数也一起搬过去了，旧页不留空壳', () => {
    ;['onSubscribeTap', 'exportMyData', 'clearMyData', 'cancelAccount'].forEach((fn) => {
      ok(settings.includes(`const ${fn} = async () => {`) || settings.includes(`const ${fn} = () =>`), `新页应有 ${fn}`)
      notOk(mine.includes(`const ${fn} =`), `旧页不该还留着 ${fn}`)
    })
  })
})

describe('「我的」页只剩一行中性入口，但说法要让人猜得到内容', () => {
  const mine = codeOf(MINE);

  it('有「系统设置」这一项，指向分包页', () => {
    ok(mine.includes("title: '系统设置'"), '「我的」页应有系统设置入口')
    ok(mine.includes("'/package/settings/index'"), '应指向 package/settings/index')
  })

  it('note 里点出那几件事（光写「系统设置」没人会想到注销在里面）', () => {
    /* 注销是隐私政策明确承诺的入口，藏在名字看不出内容的入口后面 = 承诺落空 */
    ok(/note: '[^']*(注销|清空)[^']*'/.test(mine), 'note 要点出「清空 / 注销」这类字眼')
  })

  it('这一行不随登录态隐藏（未登录同样要找更新提醒与导出）', () => {
    const row = (mine.match(/title: '系统设置'[\s\S]{0,200}/) || [''])[0];
    notOk(/userId\s*\?/.test(row.split('onTap')[0]), '系统设置入口不该被 userId 条件包住')
  })
})

describe('政策与提示文案的路径必须与真实入口一致（承诺 = 实现）', () => {
  const policy = read('package/agreement/index.tsx');

  it('隐私政策的「注销账号 / 清空数据 / 导出」都写成 我的 → 系统设置 → …', () => {
    ok(policy.includes('我的 → 系统设置 → 注销账号'), '注销条款的路径要跟着入口走')
    ok(policy.includes('我的 → 系统设置 → 清空数据'), '删除条款的路径要跟着入口走')
    ok(policy.includes('我的 → 系统设置 → 导出个人数据'), '复制条款的路径要跟着入口走')
    /* 反向对照：撤回同意仍在「我的」，不能顺手也写成系统设置 */
    ok(policy.includes('我的 → 撤回同意'), '撤回同意的入口没有迁移，文案要保持原样')
    notOk(policy.includes('系统设置 → 撤回同意'), '撤回同意没搬，别把路径改错')
  })

  it('数据导出件里的权利行使路径同步（用户拿走的那份也要能照着走）', () => {
    const exp = read('utils/data-export.ts');
    ok(exp.includes('我的 → 系统设置 → 清空数据'), '导出件里的「删除」路径');
    ok(exp.includes('我的 → 系统设置 → 注销账号'), '导出件里的「注销」路径');
  })

  it('别处提到清空入口的提示文案同步（following / notices）', () => {
    ok(read('package/following/index.tsx').includes('系统设置 → 清空数据'), '关注列表页的提示')
    ok(read('config/notices.ts').includes('系统设置 → 清空数据'), '隐私提示条')
  })
})

describe('清空与注销并排放置，页面上必须说得出区别', () => {
  const settings = codeOf(SETTINGS);

  it('清空数据的 note 明说「账号保留」，注销明说「连账号一起删」', () => {
    ok(/title: '清空数据'[\s\S]{0,160}?账号保留/.test(settings), '清空的 note 要点出账号保留')
    ok(/title: '注销账号'[\s\S]{0,160}?全部个人信息/.test(settings), '注销的 note 要点出删全部个人信息')
  })

  it('底部一行讲清两者区别，并指出撤回同意还在「我的」', () => {
    ok(settings.includes('page-settings__foot'), '要有这行脚注')
    ok(/清空数据只删内容/.test(settings), '脚注要把区别写出来，不能只做免责声明')
  })

  it('注销仍需两次确认，且善后只清本机（不许重建 users 行）', () => {
    eq((settings.match(/showModal\(/g) || []).length >= 3, true, '清空一次确认 + 注销两次确认')
    ok(settings.includes('clearLocalSettingsCache()'), '注销善后只清本机缓存')
    notOk(
      /title: '账号已注销'[\s\S]{0,400}?clearLocalSettings\(\)/.test(settings),
      '注销后绝不能调 clearLocalSettings（会把刚删掉的 users 行重建回来）'
    )
  })
})

describe('破坏性操作有视觉分级', () => {
  const scss = read('package/settings/index.scss');

  it('danger 项用警示色（颜色是最后一道提醒）', () => {
    ok(/&--danger\s*\{/.test(scss), '图标底色的 danger 变体要定义')
    ok(/__menu--danger[\s\S]{0,120}?color: \$danger/.test(scss), 'danger 项的标题要用警示色')
  })
})
