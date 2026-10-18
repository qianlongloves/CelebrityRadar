'use strict';

/**
 * 运维中心（2026-10-18）：超管在端上查用户 / 改会员 / 停用大模型厂商。
 *
 * 这个功能的三条红线都在**服务端**，本文件主要钉这三条：
 *   ① 鉴权 fail-closed：没配 `ADMIN_OPENIDS` ⇒ 除 `me` 外一律拒绝；不在名单 ⇒ 拒绝；
 *      没有 OPENID（控制台调用）⇒ 拒绝，那一侧请走 adminOps（口令闸门）。
 *      端上的 `isAdmin` 只决定入口显不显示，**绝不是权限依据**。
 *   ② 会员仍只有一个写口：本函数不直接写 `memberships`，一律代理到 payCallback；
 *      撤销是「把有效期收到此刻」而不是删行（行上挂着 refunded_orders 账本）。
 *   ③ 模型厂商不许全停：停用要在**发请求之前**生效（这是防欠费的意义），
 *      且至少留一家，否则开关本身会变成全站故障。
 *
 * 另有一部分是**行为**断言（直接 require 两份 llm.config.js 跑 resolveLlm），
 * 因为「回落是否真的发生」「全停是否真的报错」用正则证明不了。
 */

const fs = require('fs');
const path = require('path');
const { describe, it, ok, notOk, eq } = require('../harness/t');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const CLOUD = path.join(ROOT, 'cloudfunctions');

const readSrc = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const readCloud = (p) => fs.readFileSync(path.join(CLOUD, p), 'utf8');
/* 剥注释再断言：这些文件里大段「为什么这么做」的注释会被当成违规（70 / 83 / 84 的教训） */
const codeOf = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const CONSOLE_JS = 'adminConsole/index.js';

describe('运维台鉴权：白名单 fail-closed', () => {
  const code = codeOf(readCloud(CONSOLE_JS));

  it('身份只取自 getWXContext，白名单来自环境变量', () => {
    ok(code.includes('ADMIN_OPENIDS'), '白名单必须是环境变量（写死在代码里 = 谁都能从仓库看到）');
    ok(/getWXContext\(\)/.test(code), '调用者身份只能由云端注入');
    /* 调用者身份只有这一个来源：`caller` / `openidOf()` 都必须落在 getWXContext 上。
       ⚠ 不断言「文件里不出现 e.openid」—— getUser / grantMember 的入参**就是**目标用户的 openid，
       那是合法的；要钉的是「调用者」这个变量不许从入参来。 */
    ok(/const caller = openidOf\(\)/.test(code), 'caller 必须由 openidOf()（→ getWXContext）派生');
    notOk(/const caller = str\((?:e|event|payload)\.openid\)/.test(code), '调用者绝不能取自入参');
    notOk(/list\.indexOf\((?:e|event|payload)\.openid\)/.test(code), '鉴权比对也必须是 caller');
  });

  it('没配名单 ⇒ 除 me 外全部拒绝（不是「默认放行」）', () => {
    ok(/if \(!list\.length\)/.test(code), '空名单必须走拒绝分支');
    ok(/未配置环境变量 ADMIN_OPENIDS/.test(code), '要说清为什么被拒，否则运维只会看到「操作失败」');
  });

  it('不在名单 ⇒ 拒绝', () => {
    ok(/list\.indexOf\(caller\) < 0/.test(code));
    ok(/不在超管名单/.test(code));
  });

  it('没有 OPENID ⇒ 拒绝（本函数是端上专用，控制台请走 adminOps）', () => {
    ok(/if \(!caller\)/.test(code));
    ok(/只接受小程序端调用/.test(code));
    ok(/adminOps/.test(code), '拒绝文案要指出正确的那条路，否则运维会以为是部署坏了');
  });

  it('me 排在鉴权之前（自举：先拿到自己的 openid 才能配白名单）', () => {
    const iMe = code.indexOf("action === 'me'");
    const iGuard = code.indexOf('if (!list.length)');
    ok(iMe > 0, 'me 分支必须存在');
    ok(iGuard > 0, '名单守卫必须存在');
    ok(iMe < iGuard, 'me 必须在名单守卫之前，否则第一次部署没有任何人能进配置');
  });
});

describe('改会员：仍只有 payCallback 一个写口', () => {
  const code = codeOf(readCloud(CONSOLE_JS));

  it('adminConsole 不直接写 memberships', () => {
    notOk(
      /collection\('memberships'\)[\s\S]{0,120}?\.(?:set|update|add|remove)\(/.test(code),
      '会员写操作必须代理到 payCallback —— 两个写口就是两份真相'
    );
    ok(/collection\('memberships'\)/.test(code), '（正向对照）它确实会读 memberships 来展示状态');
  });

  it('发放 / 撤销都走 payCallback 的 adminOp', () => {
    ok(/name: 'payCallback'/.test(code), '必须代理到 payCallback');
    ok(/adminOp: 'grantMember'/.test(code));
    ok(/adminOp: 'revokeMember'/.test(code));
  });

  it('payCallback 里有 revokeMember 这条运营动作', () => {
    const after = codeOf(readCloud('payCallback/after-sales.js'));
    ok(/async function adminRevokeMember/.test(after), '撤销要有独立处理函数');
    ok(/op === 'revokeMember'/.test(after), 'dispatch 要认得这个动作（否则永远是「未知 adminOp」）');
    ok(/expires_at: expiresAt/.test(after), '撤销的落地方式是把有效期收到此刻');
    notOk(
      /collection\('memberships'\)\s*\.doc\([^)]*\)\s*\.remove\(/.test(after),
      '撤销不许删 memberships 行：行上的 refunded_orders 是「这几单扣过天数」的唯一凭据'
    );
  });

  it('人工动作留痕：权威行写 last_admin_op（谁在哪天动了什么）', () => {
    const after = codeOf(readCloud('payCallback/after-sales.js'));
    ok(/last_admin_op: \{ op: 'grantMember'/.test(after));
    ok(/last_admin_op: \{ op: 'revokeMember'/.test(after));
    ok(/writeMirror\(/.test(after), '权威与镜像必须双写 —— 只写权威会让端上继续显示会员');
  });
});

describe('模型厂商开关：停用在发请求之前生效，且不许全停', () => {
  it('两份 llm.config.js 仍逐字一致（改一份忘另一份 = 两套裁决）', () => {
    const a = readCloud('aiProxy/llm.config.js');
    const b = readCloud('hotBoardRefresh/llm.config.js');
    ok(a === b, '两份必须逐字一致（用例 07 也钉了这条，这里再钉一次：本次改动直接动了这两份）');
  });

  it('resolveLlm 认停用清单，并挑一家可用的回落', () => {
    const ai = codeOf(readCloud('aiProxy/llm.config.js'));
    ok(/disabledVendors/.test(ai), '裁决要接受停用清单');
    ok(/function pickUsableVendor/.test(ai), '要有「挑一家可用」的显式逻辑，不能拍脑袋');
    ok(/vendorFallback/.test(ai), '回执要能看出「这次是被迫换的厂」');
  });

  it('全部停用给出明确结论（而不是继续调用，也不是一句 401）', () => {
    const ai = codeOf(readCloud('aiProxy/llm.config.js'));
    ok(/所有大模型厂商都已被运营停用/.test(ai));
  });

  it('两个云函数都在入口读清单并注入（不是某个调用点漏传）', () => {
    const ai = codeOf(readCloud('aiProxy/index.js'));
    const hb = codeOf(readCloud('hotBoardRefresh/index.js'));
    ok(/async function loadDisabledVendors/.test(ai), 'aiProxy 要有读取口');
    ok(/disabledVendors = await loadDisabledVendors\(\)/.test(ai), 'aiProxy 要在进 handleChat 前注入');
    ok(/async function loadDisabledVendors/.test(hb), '热榜生成也走大模型，同样要受开关约束');
    ok(/disabledVendors/.test(hb) && /await loadDisabledVendors\(\)/.test(hb));
  });

  it('读不到开关 ⇒ 按全部启用（开关本身不能变成新的故障点）', () => {
    const ai = codeOf(readCloud('aiProxy/index.js'));
    ok(/catch[\s\S]{0,200}?return \[\]/.test(ai), '读失败必须回落到「空停用清单」，而不是抛错');
  });

  it('落库在 sys_config / llm_vendors，且服务端禁止全停', () => {
    const code = codeOf(readCloud(CONSOLE_JS));
    ok(code.includes("FLAG_COLL = 'sys_config'"));
    ok(code.includes("FLAG_ID = 'llm_vendors'"));
    ok(/next\.length >= keys\.length/.test(code), '全停必须被服务端拦下（端上的按钮状态可以被绕过）');
    ok(/至少保留一家/.test(code));
  });
});

describe('裁决行为（直接跑 resolveLlm，正则证明不了的部分）', () => {
  const cfg = require(path.join(CLOUD, 'aiProxy', 'llm.config.js'));
  const keys = Object.keys(cfg.VENDORS);

  it('请求的厂商被停用 ⇒ 换一家，并如实标记 fallback', () => {
    const r = cfg.resolveLlm({
      vendor: keys[0],
      quality: 'standard',
      purpose: 'generate',
      disabledVendors: [keys[0]]
    });
    notOk(r.vendor === keys[0], '被停用的厂商绝不能被选中');
    eq(r.vendorFallback, true);
    eq(r.fallbackFrom, keys[0]);
    ok(!r.configError, `回落后不该带配置错误：${r.configError || ''}`);
  });

  it('全部停用 ⇒ configError 说得出原因', () => {
    const r = cfg.resolveLlm({ vendor: keys[0], quality: 'standard', disabledVendors: keys });
    ok(!!r.configError, '全停时必须给出配置错误，让调用方回一句人话');
    ok(r.configError.includes('停用'), `错误文案要指出是运营停用：${r.configError}`);
  });

  it('没传清单 ⇒ 与从前完全一致（老调用方零影响）', () => {
    const r = cfg.resolveLlm({ vendor: keys[0], quality: 'standard', purpose: 'generate' });
    eq(r.vendor, keys[0]);
    eq(r.vendorFallback, false);
    eq(r.fallbackFrom, null);
  });

  it('vendorCatalog 带上 enabled（端上选择器据此灰掉停用项）', () => {
    const cat = cfg.vendorCatalog([keys[1]]);
    eq(cat.length, keys.length);
    eq(cat.filter((v) => v.enabled).length, keys.length - 1);
    const off = cat.filter((v) => v.key === keys[1])[0];
    eq(off.enabled, false);
  });

  it('未传 enabled 的旧回执按启用处理（不能因为读不到开关就把厂商全藏掉）', () => {
    const cat = cfg.vendorCatalog();
    eq(cat.filter((v) => v.enabled).length, keys.length);
  });
});

describe('端上：入口只在超管时出现，且页面三件套齐全', () => {
  it('分包注册 admin/index', () => {
    const app = readSrc('app.config.ts');
    ok(app.includes("'admin/index'"), '漏注册的表现是「点了没反应」，静默失败最难查');
    ok(/package\/admin/.test(app), '注释里要写明这页的来路');
  });

  it('页面三件套齐备，scss 自带变量导入', () => {
    ok(readSrc('package/admin/index.tsx').length > 0);
    ok(
      readSrc('package/admin/index.config.ts').includes("navigationBarTitleText: '运维中心'"),
      '导航栏标题'
    );
    const scss = readSrc('package/admin/index.scss');
    ok(scss.includes("@import '../../styles/variables.scss'"), '分包页 scss 漏变量导入会直接 SassError');
    ok(/\.page-admin__tabs\s*\{/.test(scss), '样式要真的定义（只加类名不写样式最难发现）');
  });

  it('系统设置页的入口按 isAdmin 条件渲染', () => {
    const s = codeOf(readSrc('package/settings/index.tsx'));
    ok(/adminMe\(\)/.test(s), '要靠服务端的 me 判定，不能端上自己猜');
    ok(/\.\.\.\(isAdmin/.test(s), '入口必须条件展开 —— 普通用户看到陌生入口比看不到更糟');
    ok(/package\/admin\/index/.test(s), '入口要跳对页');
  });

  it('页面自己再拦一次（直接跳转 / 分享链接进来的也要挡住）', () => {
    const p = codeOf(readSrc('package/admin/index.tsx'));
    ok(/if \(!isAdmin\)/.test(p), '非超管必须看到「无权访问」，而不是一个能点但会失败的页面');
    ok(/无权访问/.test(p));
  });

  it('端上通道只打 adminConsole（不绕过云函数直接读 users 集合）', () => {
    const a = codeOf(readSrc('utils/admin.ts'));
    ok(/callCloudFunction\('adminConsole'/.test(a));
    notOk(/collection\('users'\)/.test(a), '端上没有跨用户读权限，硬读只会静默返回空');
  });

  it('停用厂商留在选择器里，但置灰并标「当前不可用」（藏起来只会让人以为厂商没了）', () => {
    const mine = codeOf(readSrc('pages/mine/index.tsx'));
    ok(
      /readyVendors\.some\(\(r\) => r\.key === v\.key && r\.ready\)/.test(mine),
      '选择器只按就绪过滤 —— 停用的要留在原地灰着'
    );
    notOk(
      /r\.ready && r\.enabled/.test(mine),
      '按启用过滤会把整张卡片藏掉，用户连「已停用」都看不到，只会来问「我的 Kimi 呢」'
    );
    ok(/page-mine__vendor-card--off/.test(mine), '要有置灰态');
    ok(/isVendorOff/.test(mine), '停用判定要收口成一个函数，别在两处各写一份');
    const scss = readSrc('pages/mine/index.scss');
    ok(/&--off\s*\{/.test(scss), '置灰样式要真的写（只加类名不写样式最难发现）');
    ok(/&__vendor-off\s*\{/.test(scss), '「当前不可用」角标样式');
  });

  it('点已停用的厂商不写偏好，只提示（不能「点了没反应」）', () => {
    const mine = codeOf(readSrc('pages/mine/index.tsx'));
    const guard = mine.indexOf('if (isVendorOff(v.key))');
    const write = mine.indexOf('setPreferredProvider(v.key)')
    ok(guard >= 0, 'chooseVendor 里要有停用闸门');
    ok(write > guard, '闸门必须在写偏好之前 —— 排在后面等于照旧选中，只是多弹一句话');
    ok(/当前不可用/.test(mine.slice(guard, guard + 400)), '提示要说明「当前不可用」，而不是「切换失败」');
  });

  it('云端被迫换厂时端上说出来（旧包 / 清单还没刷新的兜底）', () => {
    const llm = codeOf(readSrc('utils/llm.ts'));
    ok(/res\.vendorFallback/.test(llm), '回执里的换厂标记要被消费');
    ok(/原选厂商当前不可用/.test(llm), '要有一句人话，而不是只写诊断日志');
  });

  it('清单缓存有 TTL（停用不能只对「重启过的人」生效）', () => {
    const llm = codeOf(readSrc('utils/llm.ts'));
    ok(/READY_VENDOR_TTL_MS/.test(llm), '永久缓存会让开关永远看不到');
    ok(/readyVendorCachedAt/.test(llm));
    ok(/enabled: v\.enabled !== false/.test(llm), '旧回执没有这个字段时按启用处理');
  });
});

describe('dbInit：开关集合与人工改会员的留痕都登记了', () => {
  const schema = readCloud('dbInit/schema.js');

  it('sys_config 集合存在且只由云函数读写', () => {
    ok(schema.includes("name: 'sys_config'"), '集合要登记，否则 dbInit sync 不会建它');
    ok(/f\('disabled'/.test(schema), '停用清单字段');
    ok(/llm_vendors/.test(schema), '注释里要写明这个文档的 id 约定');
  });

  it('memberships 登记 last_admin_op（用户问「我的会员怎么没了」时先看这里）', () => {
    ok(/f\('last_admin_op'/.test(schema));
  });
});
