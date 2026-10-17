'use strict';

/**
 * 会员段落存量的剥段迁移（P2 方案 A 阶段 4，2026-10-17）
 *
 * 背景：阶段 3 只让**此后新生成**的报告不带四段，此前落库的主行仍带着 —— 而
 * `report_cache` / `report_versions` 都是「所有人可读」。漏洞面不扩大，但也没变小。
 * 本文件钉的是这次**回填**的三条硬约束：
 *
 *   ① 口径同源：迁移写进 `report_member` 的字段名单与旗标 token，必须与写口、端上逐字相同
 *      （少摘一段 = 免费读者拿得到付费内容；多摘一段 = 会员看不到自己买的那一段）；
 *   ② **先写副本、成功才剥主行**。副本写失败就保持原样（下次重跑），绝不允许
 *      「主行说有四段、副本里没有」的静默丢内容；
 *   ③ 幂等：判据是「正文里还有没有会员段」，重跑一遍 `stripped` 必须为 0。
 *
 * 另外两条容易被"简化"掉、但这里必须钉住的：
 *   · **默认 dry-run**（`apply:true` 才写），且迁移不并进 `sync` —— 它改的是正文；
 *   · 分页用 `_id` 升序游标而不是 `skip`：边写边扫时 `skip` 会漏行。
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const env = require('../harness/env');
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_INIT = path.join(ROOT, 'cloudfunctions', 'dbInit', 'index.js');
const STORE_JS = path.join(ROOT, 'cloudfunctions', 'aiProxy', 'report-store.js');
const MEMBER_TS = path.join(ROOT, 'src', 'utils', 'member.ts');

const read = (p) => fs.readFileSync(p, 'utf8');
const dbInitSrc = read(DB_INIT);
const storeSrc = read(STORE_JS);
const memberSrc = read(MEMBER_TS);

/** 从源码里抠出一个数组字面量的元素（够用即可，不引 AST） */
function arrOf(src, name) {
  const m = src.match(new RegExp(name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"`]/, '').replace(/['"`]$/, ''))
    .filter((s) => s && !s.startsWith('//'));
}

/** 载入 dbInit：注入假 SDK 与 harness 的假数据库（同 11-db-init.js 的写法） */
function loadFn() {
  env.resetAll();
  delete process.env.DB_ADMIN_TOKEN;
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => env.db.database()
  };
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fakeSdk;
    if (id === 'https') return { request: () => ({ on() {}, setTimeout() {}, write() {}, destroy() {}, end() {} }) };
    return orig.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(DB_INIT)];
    return require(DB_INIT);
  } finally {
    Module.prototype.require = orig;
  }
}

const GEN = '2026-01-02T03:04:05.000Z';
const OLD_GEN = '2026-01-01T00:00:00.000Z';

const fullReport = (over) =>
  Object.assign(
    {
      personKey: 'A#tech',
      name: 'A',
      generatedAt: GEN,
      memberNotes: { compare: '比同行更激进', risk: '代言集中' },
      conflicts: [{ point: '营收口径' }],
      peers: [{ name: 'B' }],
      affiliations: [{ org: 'C' }]
    },
    over
  );

const cacheRow = (over) =>
  Object.assign({ _id: 'A#tech', state: 'ready', generated_at: GEN, report: fullReport() }, over);

const versionRow = (over) =>
  Object.assign(
    {
      _id: `A#tech#${OLD_GEN}`,
      person_key: 'A#tech',
      name: 'A',
      generated_at: OLD_GEN,
      replaced_at: GEN,
      news_count: 3,
      report: fullReport({ generatedAt: OLD_GEN })
    },
    over
  );

const ALL_FLAGS = ['memberNotes.compare', 'memberNotes.risk', 'conflicts', 'peers', 'affiliations'];
const hasPayload = (r) =>
  !!(r && (r.memberNotes || r.conflicts || r.peers || r.affiliations));

/* ============ ① 口径同源：三处名单必须逐字相同 ============ */

describe('P2 阶段 4 迁移：口径必须与写口 / 端上同源', () => {
  it('字段名单三处逐字相同（dbInit / report-store / 端上 member.ts）', () => {
    const db = arrOf(dbInitSrc, 'MEMBER_FIELDS');
    const cloud = arrOf(storeSrc, 'MEMBER_FIELDS');
    const app = arrOf(memberSrc, 'MEMBER_FIELD_KEYS');
    ok(db && cloud && app, '三处都要能抠出名单，抠不出说明常量被改名/改写');
    deepEq(db, cloud, 'dbInit 与写口不同源：迁移会把「写口不认的段」也摘走');
    deepEq(db, app, 'dbInit 与端上不同源：端上会以为自己买到了某一段');
  });

  it('旗标 token 三处逐字相同（含顺序：顺序变了导出/促销条点名会跟着变）', () => {
    const db = arrOf(dbInitSrc, 'MEMBER_FLAG_TOKENS');
    const cloud = arrOf(storeSrc, 'MEMBER_FLAGS');
    const app = arrOf(memberSrc, 'MEMBER_FLAGS');
    ok(db && cloud && app, '三处都要能抠出 token 名单');
    deepEq(db, cloud);
    deepEq(db, app);
    deepEq(db, ALL_FLAGS, '用例自己抄的名单也要跟着改，否则这条断言就成了摆设');
  });

  it('迁移返回体里带出它写的 token 名单（运维跑完能当场对一眼）', async () => {
    const { main } = loadFn();
    env.db.__seed('report_cache', [cacheRow()]);
    const res = await main({ action: 'stripMember', env: 'env-x' });
    deepEq(res.member[0].flag_tokens, ALL_FLAGS);
  });
});

/* ============ ② 默认 dry-run：只统计、不写库 ============ */

describe('P2 阶段 4 迁移：默认 dry-run', () => {
  it('不给 apply 时一行都不写，但 candidates 与 sample 要如实报', async () => {
    const { main } = loadFn();
    env.db.__seed('report_cache', [cacheRow()]);
    env.db.__seed('report_versions', [versionRow()]);

    const res = await main({ action: 'stripMember', env: 'env-x' });

    eq(res.ok, true);
    eq(res.dryRun, true);
    eq(res.apply, false);
    const cur = res.member.find((x) => x.collection === 'report_cache');
    const ver = res.member.find((x) => x.collection === 'report_versions');
    eq(cur.candidates, 1);
    eq(ver.candidates, 1);
    eq(cur.stripped, 0, 'dry-run 不许写');
    ok(cur.sample.length === 1 && cur.sample[0].id === 'A#tech', '要给出样例 id，否则无法判断是不是误扫了别的行');
    ok(hasPayload(env.db.__dump('report_cache')[0].report), '主行必须原样（dry-run 的字面含义）');
    eq(env.db.__dump('report_member').length, 0, 'dry-run 不许写副本');
  });

  it('apply 但没带 token ⇒ 拒绝，且主行与副本都没动', async () => {
    const { main } = loadFn();
    env.db.__seed('report_cache', [cacheRow()]);
    process.env.DB_ADMIN_TOKEN = 'secret';

    const res = await main({ action: 'stripMember', apply: true, env: 'env-x' });

    eq(res.ok, false);
    ok(String(res.error).includes('token'), `要说明是口令问题，实际：${res.error}`);
    ok(hasPayload(env.db.__dump('report_cache')[0].report));
    eq(env.db.__dump('report_member').length, 0);
  });
});

/* ============ ③ 真正迁移：先副本、后剥段 ============ */

describe('P2 阶段 4 迁移：当前版 report_cache', () => {
  it('四段搬进副本并逐字配对，主行只剩旗标', async () => {
    const { main } = loadFn();
    env.db.__seed('report_cache', [cacheRow()]);
    process.env.DB_ADMIN_TOKEN = 'secret';

    const res = await main({ action: 'stripMember', apply: true, token: 'secret', env: 'env-x' });

    eq(res.ok, true);
    const cur = res.member.find((x) => x.collection === 'report_cache');
    eq(cur.stripped, 1);
    eq(cur.copy_failed, 0);

    const mainRow = env.db.__dump('report_cache')[0];
    notOk(hasPayload(mainRow.report), '主行不许再带四段（否则这一步等于没做）');
    deepEq(mainRow.report.memberSections, ALL_FLAGS);
    eq(mainRow.report.name, 'A', '其余字段一字不许动');
    eq(mainRow.report.generatedAt, GEN, 'generatedAt 是配对键，改了就读不回来');

    const copies = env.db.__dump('report_member');
    eq(copies.length, 1);
    const copy = copies[0];
    eq(copy._id, 'A#tech', '当前版副本主键与公开行逐字相同');
    eq(copy.kind, 'current');
    eq(copy.person_key, 'A#tech');
    eq(copy.generated_at, GEN, '时间戳必须取自这一行，不能用 now() 顶替');
    deepEq(Object.keys(copy.sections).sort(), ['affiliations', 'conflicts', 'memberNotes', 'peers']);
    deepEq(copy.sections.conflicts, [{ point: '营收口径' }], '内容要原样搬运，不是搬运"有没有"');
  });

  it('幂等：再跑一遍 stripped 为 0（判据是正文里还有没有四段）', async () => {
    const { main } = loadFn();
    env.db.__seed('report_cache', [cacheRow()]);
    process.env.DB_ADMIN_TOKEN = 'secret';
    await main({ action: 'stripMember', apply: true, token: 'secret', env: 'env-x', only: ['report_cache'] });

    const again = await main({
      action: 'stripMember',
      apply: true,
      token: 'secret',
      env: 'env-x',
      only: ['report_cache']
    });

    const cur = again.member[0];
    eq(cur.candidates, 0, '已剥过的行不算候选');
    eq(cur.stripped, 0);
    eq(env.db.__dump('report_member').length, 1, '也不许重复写副本');
  });

  it('免费档存量行（本来就没四段）不许被写上旗标 —— 空旗标等于谎报', async () => {
    const { main } = loadFn();
    env.db.__seed('report_cache', [
      cacheRow({ report: { personKey: 'A#tech', name: 'A', generatedAt: GEN } })
    ]);
    process.env.DB_ADMIN_TOKEN = 'secret';

    await main({ action: 'stripMember', apply: true, token: 'secret', env: 'env-x' });

    const mainRow = env.db.__dump('report_cache')[0];
    eq(mainRow.report.memberSections, undefined, '没有会员段就不该有旗标');
    eq(env.db.__dump('report_member').length, 0);
  });
});

/* ============ ④ 历史版 report_versions 同样要剥 ============ */

describe('P2 阶段 4 迁移：历史版 report_versions', () => {
  it('副本 kind 为 version、主键为 `<personKey>#<生成时间>`（读口按它点查）', async () => {
    const { main } = loadFn();
    env.db.__seed('report_versions', [versionRow()]);
    process.env.DB_ADMIN_TOKEN = 'secret';

    const res = await main({ action: 'stripMember', apply: true, token: 'secret', env: 'env-x', only: ['report_versions'] });

    const ver = res.member[0];
    eq(ver.kind, 'version');
    eq(ver.stripped, 1);

    const row = env.db.__dump('report_versions')[0];
    notOk(hasPayload(row.report), '历史版同样在「所有人可读」表里，必须一起剥');
    deepEq(row.report.memberSections, ALL_FLAGS);
    eq(row.generated_at, OLD_GEN, '历史版自己的时间戳不许被当前版覆盖');

    const copy = env.db.__dump('report_member')[0];
    eq(copy._id, `A#tech#${OLD_GEN}`);
    eq(copy.kind, 'version');
    eq(copy.person_key, 'A#tech');
    eq(copy.generated_at, OLD_GEN, '配对键取这一版自己的生成时间');
  });

  it('算不出配对键（没有 generatedAt）的行宁可不动 —— 剥了也取不回来', async () => {
    const { main } = loadFn();
    env.db.__seed('report_cache', [
      cacheRow({ generated_at: undefined, report: fullReport({ generatedAt: undefined }) })
    ]);
    process.env.DB_ADMIN_TOKEN = 'secret';

    const res = await main({ action: 'stripMember', apply: true, token: 'secret', env: 'env-x', only: ['report_cache'] });

    eq(res.member[0].without_key, 1);
    eq(res.member[0].stripped, 0);
    ok(hasPayload(env.db.__dump('report_cache')[0].report), '正文必须原样保留');
  });
});

/* ============ ⑤ 副本写失败 ⇒ 不剥（本文件最重要的一条） ============ */

describe('P2 阶段 4 迁移：先写副本、成功才剥主行', () => {
  it('副本表不可写 ⇒ copy_failed 记账、主行原样（宁可下次重跑，不可静默丢内容）', async () => {
    const { main } = loadFn();
    env.db.__seed('report_cache', [cacheRow()]);
    process.env.DB_ADMIN_TOKEN = 'secret';
    env.db.__setFailing('report_member', true);

    const res = await main({ action: 'stripMember', apply: true, token: 'secret', env: 'env-x', only: ['report_cache'] });

    const cur = res.member[0];
    eq(cur.copy_failed, 1);
    eq(cur.stripped, 0, '副本没写成功就绝不能剥主行');
    ok(hasPayload(env.db.__dump('report_cache')[0].report), '四段必须还在');
    eq(env.db.__dump('report_cache')[0].report.memberSections, undefined, '没剥就不许留旗标');
  });

  it('源码顺序：副本 `.set(` 必须出现在主行 `.update(` 之前', () => {
    const body = dbInitSrc.slice(dbInitSrc.indexOf('async function stripMemberTable'));
    const setAt = body.indexOf('MEMBER_COLLECTION');
    const updateAt = body.indexOf('.update({ data: { report: _.set(stripForRow(report, flags)) } })');
    ok(setAt > 0 && updateAt > 0, '两处调用都要能找到，找不到说明写法变了、这条断言已失效');
    ok(setAt < updateAt, '顺序反了 = 副本没落地就把主行剥了（不可恢复）');
    ok(body.indexOf('out.copy_failed += 1') < updateAt, '失败分支必须在剥段之前 continue');
  });

  it('剥段必须 `_.set(...)` 整块替换 —— 直接写 `{report:{...}}` 会被平台展开合并、四段删不掉', () => {
    ok(
      /update\(\{ data: \{ report: _\.set\(stripForRow\(report, flags\)\) \} \}\)/.test(dbInitSrc),
      '平台会把普通对象展开成点号路径再合并 ⇒ 迁移会报 stripped=1 而四段原样还在'
    );
    notOk(/update\(\{ data: \{ report: stripForRow/.test(dbInitSrc), '不许退回会被合并的写法');
  });
});

/* ============ ⑥ 分批：游标分页不能漏行 ============ */

describe('P2 阶段 4 迁移：分批扫描', () => {
  it('收尾只能看「这一页空了」—— 一次 get 的条数上限跟 SDK 走（客户端 20 / 服务端 100）', () => {
    ok(
      /if \(rows\.length === 0\) break/.test(dbInitSrc),
      '写成 `rows.length < STRIP_PAGE` 时，只要某个运行时只给 20 条，第一页就退出、表里还留一大半'
    );
    notOk(/rows\.length < STRIP_PAGE\)\s*break/.test(dbInitSrc));
  });

  it('超过单页上限（100）时全部扫到并全部迁移', async () => {
    const { main } = loadFn();
    const rows = [];
    for (let i = 0; i < 105; i += 1) {
      const id = `P${String(i).padStart(3, '0')}#tech`;
      rows.push(cacheRow({ _id: id, report: fullReport({ personKey: id }) }));
    }
    env.db.__seed('report_cache', rows);
    process.env.DB_ADMIN_TOKEN = 'secret';

    const res = await main({ action: 'stripMember', apply: true, token: 'secret', env: 'env-x', only: ['report_cache'] });

    eq(res.member[0].scanned, 105, '`skip` 分页在边写边扫时会漏行，必须是 `_id` 游标');
    eq(res.member[0].stripped, 105);
    eq(env.db.__dump('report_member').length, 105);
    ok(
      env.db.__dump('report_cache').every((r) => !hasPayload(r.report)),
      '扫到的每一行都要剥干净'
    );
  });
});

/* ============ ⑦ 接线：迁移是独立动作，不混进巡检 ============ */

describe('P2 阶段 4 迁移：接线', () => {
  it('stripMember 是独立 action，且没有并进 sync / report 的写路径', () => {
    ok(/action === 'stripMember'/.test(dbInitSrc), '必须显式点名才跑');
    notOk(/action === 'sync' \|\| action === 'stripMember'/.test(dbInitSrc));
    notOk(/doCollections[^\n]*stripMember/.test(dbInitSrc));
  });

  it('默认 dry-run：只有 apply === true 才写（沿用 dbInit 的既有约定）', () => {
    ok(/const applyStrip = event\.apply === true/.test(dbInitSrc));
  });

  it('迁移只碰两张公开表，不碰 report_member 以外的新表', async () => {
    const { main } = loadFn();
    const res = await main({ action: 'stripMember', env: 'env-x' });
    deepEq(
      res.member.map((x) => x.collection),
      ['report_cache', 'report_versions']
    );
  });
});
