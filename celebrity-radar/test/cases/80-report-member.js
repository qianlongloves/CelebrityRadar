'use strict';

/**
 * 会员段边界（P2 方案 A 阶段 1，2026-10-17）
 *
 * 要钉的是「会员段不再放在任何人可读的表里」这条边界的**地基**：
 *   · `report_member` 必须是 `acl: cloudOnly` —— 这是整个方案的全部意义，
 *     ACL 一旦被写成「所有人可读」，后面所有代码都白做（改包直接读表即可）；
 *   · 写口落库成功后顺手写一份副本（best-effort，失败不许把 `ok` 改成失败）；
 *   · 副本与正文靠**时间戳相等**配对（两行不是原子写的），不等就不给；
 *   · 历史版本裁剪时副本要跟着删（否则它会静默长成一张没人查得出用途的表）；
 *   · 读口 `op:'member'` 先判会员，且**非会员拿不到任何一段**。
 *
 * ⚠ 阶段 1 是**双写**（主行照旧带四段，副本在旁边攒）；**阶段 3（2026-10-17）起主行剥段**：
 *   四段只留在副本里，主行只剩旗标 `memberSections`。因此线上会**长期并存两种形态** ——
 *   阶段 3 之前落库的主行仍带四段（阶段 4 才迁移），之后的只剩旗标。读口必须两种都认，
 *   本文件断言的是「写口新写的这一行一定是剥段形态」。
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const env = require('../harness/env');
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t');

const ROOT = path.resolve(__dirname, '..', '..');
const AI_PROXY = path.join(ROOT, 'cloudfunctions', 'aiProxy', 'index.js');
const STORE_JS = path.join(ROOT, 'cloudfunctions', 'aiProxy', 'report-store.js');
const SCHEMA = path.join(ROOT, 'cloudfunctions', 'dbInit', 'schema.js');

const read = (p) => fs.readFileSync(p, 'utf8');
const storeSrc = read(STORE_JS);
const schemaSrc = read(SCHEMA);

const DAY_MS = 86400000;

function loadProxy({ openid = 'u1' } = {}) {
  env.resetAll();
  process.env.BOCHA_API_KEY = 'bocha-test';
  const db = env.db.database();
  const fakeSdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    database: () => db,
    getWXContext: () => (openid ? { OPENID: openid } : {})
  };
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'wx-server-sdk') return fakeSdk;
    return orig.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(AI_PROXY)];
    delete require.cache[require.resolve(STORE_JS)];
    return require(AI_PROXY);
  } finally {
    Module.prototype.require = orig;
  }
}

const callStore = (fn, over) => fn.main(Object.assign({ action: 'report' }, over));
const lockRow = (over) =>
  Object.assign(
    { _id: 'A#tech', report: null, state: 'building', builder: 'u1', generated_at: '2026-01-01T00:00:00.000Z' },
    over
  );
const report = (over) =>
  Object.assign({ personKey: 'A#tech', name: 'A', generatedAt: '2026-01-01T00:00:00.000Z' }, over);
const memberRow = () => ({
  _id: 'u1',
  plan: 'month',
  expires_at: new Date(Date.now() + 7 * DAY_MS).toISOString()
});
const memberDocs = (kind) => env.db.__dump('report_member').filter((r) => r.kind === kind);

/* ============== ① 库结构：这一条不成立，后面全是装饰 ============== */

describe('P2 会员段边界：库结构', () => {
  it('report_member 是「客户端不可读写」（连读都读不到才是方案 A 的意义）', () => {
    ok(/name: 'report_member'[\s\S]{0,1600}acl: ACL\.cloudOnly/.test(schemaSrc), '必须是 cloudOnly');
  });

  it('不许被写成「所有人可读」—— 那等于把会员段原样放回一张可读表', () => {
    notOk(/name: 'report_member'[\s\S]{0,1600}acl: ACL\.publicReadOnly/.test(schemaSrc));
    notOk(/name: 'report_member'[\s\S]{0,1600}acl: ACL\.publicRead,/.test(schemaSrc));
  });

  it('库结构里留着「ACL 不会自动生效」与「时间戳配对」两条告诫', () => {
    ok(/不会由 `dbInit` 自动 apply|不会由 dbInit 自动 apply/.test(schemaSrc), '下一个人建表后会以为权限已经生效');
    ok(/时间戳相等才认/.test(schemaSrc), '两行不是原子的：这条判据必须写在表定义旁边');
  });
});

/* ============== ② 双写：主行照旧、副本另存 ============== */

describe('P2 会员段边界：落库双写', () => {
  it('会员落库后：四段只进 report_member，主行只剩旗标', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    env.db.__seed('report_cache', [lockRow()]);
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({
        memberNotes: { compare: 'C', risk: 'R' },
        conflicts: [{ text: '争议一' }],
        peers: [{ name: 'P' }],
        affiliations: [{ company: 'X' }]
      })
    });
    eq(res.ok, true);

    const rows = memberDocs('current');
    eq(rows.length, 1, '当前版只该有一行副本');
    eq(rows[0]._id, 'A#tech', '当前版 _id = personKey（点查用，不需要索引）');
    eq(rows[0].generated_at, '2026-01-01T00:00:00.000Z', '必须与主行同一个时间戳，否则配对永远是 mismatch');
    eq(rows[0].sections.memberNotes.compare, 'C');
    eq(rows[0].sections.conflicts.length, 1);
    eq(rows[0].sections.peers.length, 1);
    eq(rows[0].sections.affiliations.length, 1);

    /* 阶段 3：主行（所有人可读）里**不再有**付费内容，只留一句旗标 */
    const main = env.db.__dump('report_cache')[0].report;
    eq(main.memberNotes, undefined, '主行不再带四段 —— 剥段是阶段 3 的全部意义');
    eq(main.conflicts, undefined);
    eq(main.peers, undefined);
    eq(main.affiliations, undefined);
    deepEq(
      main.memberSections,
      ['memberNotes.compare', 'memberNotes.risk', 'conflicts', 'peers', 'affiliations'],
      '旗标精确到段：促销条要能点名「已含哪几段」，写字段名就分不出 compare / risk'
    );
  });

  it('免费版落库：不写副本，并把旧副本删掉（免得旧会员段配新正文）', async () => {
    const fn = loadProxy();
    env.db.__seed('report_cache', [lockRow()]);
    env.db.__seed('report_member', [
      { _id: 'A#tech', person_key: 'A#tech', kind: 'current', generated_at: '2025-12-01T00:00:00.000Z', sections: { conflicts: [{ text: '旧' }] } }
    ]);
    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report() });
    eq(res.ok, true);
    eq(memberDocs('current').length, 0, '没有会员段就不该留副本：否则是「旧内容 + 新时间戳」');
  });

  it('副本写失败不影响落库，且**不剥段**（宁可主行带四段，不能让会员永久少四段）', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    env.db.__seed('report_cache', [lockRow()]);
    env.db.__setFailing('report_member', true);
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ memberNotes: { compare: 'C' } })
    });
    eq(res.ok, true, '不能因为副本失败就把已生成的报告判成写库失败');
    const row = env.db.__dump('report_cache')[0];
    eq(row.state, 'ready');
    /* 这是整个阶段 3 最贵的那个方向：剥了段却写不成副本 = 会员永久少四段、且不报错 */
    eq(row.report.memberNotes.compare, 'C', '副本没写上就退回「不剥」，主行照旧带四段');
    eq(row.report.memberSections, undefined, '不剥就不该写旗标（旗标说有而副本里没有 = 静默丢内容）');
  });
});

/* ============== ③ 历史版本：副本跟着写、跟着裁 ============== */

describe('P2 会员段边界：历史版本', () => {
  it('再见一版时旧版副本**不能**被删（阶段 3 起旧版正文没有四段，搬运会走「删行」分支）', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    /* 旧版主行是阶段 3 的形态：正文里没有四段，只有旗标（generated_at 与本行副本的 _id 对应） */
    env.db.__seed('report_cache', [lockRow({ report: report({ memberSections: ['memberNotes.compare'] }) })]);
    /* 旧版四段副本：上一版落库时就写好了，_id 与历史版本行逐字相同 */
    env.db.__seed('report_member', [
      {
        _id: 'A#tech#2026-01-01T00:00:00.000Z',
        person_key: 'A#tech',
        kind: 'version',
        generated_at: '2026-01-01T00:00:00.000Z',
        sections: { memberNotes: { compare: '旧版四段' } }
      }
    ]);

    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ generatedAt: '2026-02-01T00:00:00.000Z', memberNotes: { compare: '新版四段' } })
    });
    eq(res.ok, true);

    const kept = memberDocs('version').filter((r) => r._id === 'A#tech#2026-01-01T00:00:00.000Z');
    eq(kept.length, 1, '历史版本页要靠它取回四段 —— 被删掉就永远少四段，而且不报错');
    eq(kept[0].sections.memberNotes.compare, '旧版四段');
  });

  it('被覆盖掉的那一版，四段也进副本（_id 与版本行逐字相同）', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    const old = { personKey: 'A#tech', name: 'A', generatedAt: '2025-12-31T00:00:00.000Z', conflicts: [{ text: '旧版争议' }] };
    env.db.__seed('report_cache', [lockRow({ report: old })]);
    const res = await callStore(fn, {
      op: 'save',
      personKey: 'A#tech',
      report: report({ memberNotes: { compare: '新' } })
    });
    eq(res.ok, true);

    const versions = env.db.__dump('report_versions');
    eq(versions.length, 1);
    const copies = memberDocs('version');
    eq(copies.length, 1);
    eq(copies[0]._id, versions[0]._id, '同一个 _id 才能「删版本时顺手删副本」');
    eq(copies[0].sections.conflicts[0].text, '旧版争议');
    eq(copies[0].generated_at, '2025-12-31T00:00:00.000Z');
  });

  it('裁剪历史版本时副本一并删除（不留孤儿行）', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    /* 预置 6 条历史（超过 KEEP=5），每条都配一份副本 */
    const seeded = [];
    const copies = [];
    for (let i = 1; i <= 6; i++) {
      const at = `2026-02-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`;
      const id = `A#tech#${at}`;
      seeded.push({ _id: id, person_key: 'A#tech', name: 'A', generated_at: at, replaced_at: at, news_count: 1, report: { name: 'A', generatedAt: at } });
      copies.push({ _id: id, person_key: 'A#tech', kind: 'version', generated_at: at, sections: { conflicts: [{ text: 'x' }] } });
    }
    env.db.__seed('report_versions', seeded);
    env.db.__seed('report_member', copies);
    env.db.__seed('report_cache', [lockRow({ report: { name: 'A', generatedAt: '2026-01-01T00:00:00.000Z' } })]);

    const res = await callStore(fn, { op: 'save', personKey: 'A#tech', report: report() });
    eq(res.ok, true);

    const left = env.db.__dump('report_versions').map((r) => r._id).sort();
    eq(left.length, 5, '版本表只留 5 条');
    const leftCopies = memberDocs('version').map((r) => r._id).sort();
    eq(leftCopies.length, left.length, '副本数量必须与版本数量一致（否则副本表会独立长大）');
    for (const id of leftCopies) ok(left.includes(id), `副本 ${id} 必须有对应的版本行`);
  });
});

/* ============== ④ 读口：先判会员，再按时间戳配对 ============== */

describe('P2 会员段边界：读口 op=member', () => {
  const seedCopy = () =>
    env.db.__seed('report_member', [
      {
        _id: 'A#tech',
        person_key: 'A#tech',
        kind: 'current',
        generated_at: '2026-01-01T00:00:00.000Z',
        sections: { memberNotes: { compare: 'C' }, conflicts: [{ text: '争议' }] }
      }
    ]);

  it('非会员：拒绝，且一个字段都不返回', async () => {
    const fn = loadProxy();
    seedCopy();
    const res = await callStore(fn, { op: 'member', personKey: 'A#tech', generatedAt: '2026-01-01T00:00:00.000Z' });
    eq(res.ok, false);
    eq(res.kind, 'auth', '云函数必须自己判会员（端上身份可伪造）');
    eq(res.sections, undefined);
  });

  it('会员 + 时间戳相等：拿到四段', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    seedCopy();
    const res = await callStore(fn, { op: 'member', personKey: 'A#tech', generatedAt: '2026-01-01T00:00:00.000Z' });
    eq(res.ok, true);
    eq(res.result, 'ok');
    eq(res.sections.memberNotes.compare, 'C');
    eq(res.sections.conflicts.length, 1);
  });

  it('会员 + 时间戳不等：mismatch，宁可不给（不能把上一版会员段配到这一版）', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    seedCopy();
    const res = await callStore(fn, { op: 'member', personKey: 'A#tech', generatedAt: '2026-06-06T00:00:00.000Z' });
    eq(res.ok, true, 'mismatch 是「安静地不给」，不是故障');
    eq(res.result, 'mismatch');
    eq(res.sections, undefined);
    eq(res.generated_at, '2026-01-01T00:00:00.000Z', '把库里那份的时间带回去，便于端上排查');
  });

  it('会员 + 没有副本：empty（这份报告确实没有会员段）', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    const res = await callStore(fn, { op: 'member', personKey: 'A#tech', generatedAt: '2026-01-01T00:00:00.000Z' });
    eq(res.result, 'empty');
    eq(res.sections, undefined);
  });

  it('历史版：传 version 就按 personKey#version 点查', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    env.db.__seed('report_member', [
      {
        _id: 'A#tech#2025-12-31T00:00:00.000Z',
        person_key: 'A#tech',
        kind: 'version',
        generated_at: '2025-12-31T00:00:00.000Z',
        sections: { peers: [{ name: 'P' }] }
      }
    ]);
    const res = await callStore(fn, {
      op: 'member',
      personKey: 'A#tech',
      version: '2025-12-31T00:00:00.000Z'
    });
    eq(res.result, 'ok');
    eq(res.sections.peers.length, 1, '历史版本页要能取回旧版会员段');
  });

  it('缺 personKey：badrequest（不许把空串当合法主键）', async () => {
    const fn = loadProxy();
    env.db.__seed('memberships', [memberRow()]);
    const res = await callStore(fn, { op: 'member' });
    eq(res.ok, false);
    eq(res.kind, 'badrequest');
  });
});

/* ============== ⑤ 接线：读口与写口的预算必须分开 ============== */

describe('P2 会员段边界：接线', () => {
  it('op 白名单与分派都含 member，且读口在写口限速之前分流', () => {
    ok(/op !== 'member'/.test(storeSrc), '白名单漏了它，端上叫过来只会拿到「未知 op」');
    ok(/if \(op === 'member'\) return storeMember\(event, OPENID\)/.test(storeSrc));
    const memberAt = storeSrc.indexOf("if (op === 'member') return storeMember");
    const gateAt = storeSrc.indexOf('const gate = await storeGate(OPENID)');
    ok(memberAt > 0 && memberAt < gateAt, '读口若排在写口限速之后，会员多看几遍报告就写不进缓存了');
  });

  it('读口有自己的计数键（读不该吃掉「今天还能写几次」的预算）', () => {
    ok(/#member`/.test(storeSrc), '独立键');
    ok(/MEMBER_READ_ABUSE_LIMIT/.test(storeSrc));
    ok(/storeMember[\s\S]{0,600}isActiveMember/.test(storeSrc), '会员判定必须在云函数里做');
  });

  it('四段口径只有一处（改一处必须同时改另三处）', () => {
    ok(/MEMBER_FIELDS = \['memberNotes', 'conflicts', 'peers', 'affiliations'\]/.test(storeSrc));
  });
});
