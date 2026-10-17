'use strict';

/**
 * 监控类页面的收口（2026-10-17）：重复渲染抽共用组件 + 修两页互跳的栈环。
 *
 * 背景：预警页（`package/alerts`）一页塞了三种监控对象（词 / 订阅对象 / 人），
 * 工作台（`package/workbench`）另起一页做横向台账。两边**同一份数据各渲染一遍**：
 * 监控状态表 3 份、执行日志 2 份、事件卡 5 处、名单胶囊 3 份。产品上该不该合成一页是另一个
 * 问题（合并会把「导入检索额度」与「免费站内订阅」混成一个额度，见 doc），但**渲染层的重复
 * 没有任何理由留着** —— 它唯一的产出就是「改一处忘另一处」。
 *
 * 本文件钉四件事：
 *   ① 口径唯一：`monitorResultText` / `riskSignalTotal` 是「命中 / 结果」与「累计条数」的
 *      唯一算法，且三处（词表 / 人表 / 工作台）都用它；
 *   ② 结构唯一：三块 UI 各有一个组件，页面里不再有第二份实现；
 *   ③ 栈环：alerts ⇄ workbench 只能有一个方向进栈，否则来回点几次就顶到微信 10 层上限，
 *      之后所有跳转静默失败（表现为「点了没反应」）；
 *   ④ 深链兜底：`package/event` 可被订阅消息 / 小程序码 / 转发卡片直接打开，
 *      那时栈里只有它自己，`navigateBack` 会静默失败。
 */

const fs = require('fs');
const path = require('path');
const env = require('../harness/env');
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

const ALERTS = 'package/alerts/index.tsx';
const WORKBENCH = 'package/workbench/index.tsx';
const EVENT = 'package/event/index.tsx';

/** 剥注释后再断言：这些文件里「为什么这么做」的说明文字会被当成违规（同 18/45/63） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const scanLog = () => {
  env.resetAll();
  return env.load('utils/scan-log');
};

describe('监控口径：命中 / 结果 只有一个算法', () => {
  it('有执行记录 ⇒ 「新 N / 共 M」，N=0 也要如实说（扫了没命中 ≠ 没扫过）', () => {
    const { monitorResultText } = scanLog();
    eq(monitorResultText(3, 10), '新 3 / 共 10');
    eq(monitorResultText(0, 10), '新 0 / 共 10', '0 是有效值：这一轮执行了、只是没新东西');
  });

  it('没有执行记录但有存量 ⇒ 「共 M 条」；什么都没有 ⇒ 「—」（不写「共 0 条」）', () => {
    const { monitorResultText } = scanLog();
    eq(monitorResultText(undefined, 10), '共 10 条');
    eq(monitorResultText(undefined, 0), '—', '「共 0 条」读起来像「扫过了、结果是空的」，会误导');
    eq(monitorResultText(undefined, undefined), '—');
    eq(monitorResultText(undefined, NaN), '—');
  });

  it('累计条数：快照 signals_total 优先，读到的条数兜底；NaN 不许原样透出', () => {
    const { riskSignalTotal } = scanLog();
    eq(riskSignalTotal({ signals_total: 7 }, 3), 7, '快照是云端写下的历史累计，比"这次读到几行"大是对的');
    eq(riskSignalTotal(undefined, 3), 3);
    eq(riskSignalTotal({ signals_total: NaN }, 3), 3, '用 ?? 兜底会透出 NaN，表格里就成了「共 NaN 条」');
  });

  it('三处都走同一个算法（词表 / 人表 / 工作台）', () => {
    const alerts = stripComments(read(ALERTS));
    eq((alerts.match(/monitorResultText\(/g) || []).length, 2, '词表与人表各一处');
    ok(/riskSignalTotal\(scan,/.test(alerts), '人表的累计条数必须走统一口径');
    const wb = stripComments(read('utils/workbench.ts'));
    ok(/riskSignalTotal\(scan, list\.length\)/.test(wb), '工作台也必须走同一口径');
    notOk(/Number\.isFinite\(scan\?\.signals_total\)/.test(wb), '旧的内联写法不许回流');
  });
});

describe('渲染结构：三块 UI 各一个组件，页面不再留第二份', () => {
  it('执行日志：组件存在，两处调用，页面里没有残留的表结构', () => {
    const alerts = stripComments(read(ALERTS));
    eq((alerts.match(/<ScanLogList /g) || []).length, 2, '关键词一路 + 名人一路');
    notOk(/page-alerts__logs/.test(alerts), '旧的两份手写日志块必须删干净（留着就等于还有第三份真相）');
    const comp = read('components/scan-log-list/index.tsx');
    ok(comp.includes("from '@/utils/scan-log'"), '条数上限必须取 SCAN_LOGS_MAX，不能写死 20');
    ok(comp.includes('SCAN_LOGS_MAX'), '页面里曾写死 slice(0, 20)');
  });

  it('名单胶囊：组件存在，三处调用', () => {
    const alerts = stripComments(read(ALERTS));
    eq((alerts.match(/<ChipList/g) || []).length, 3, '关键词 / 订阅对象 / 名人');
    ok(read('components/chip-list/index.tsx').includes('chip-list__chip--focus'), '定位高亮仍要有');
  });

  it('监控状态表：组件存在，两处调用，表头只写一份', () => {
    const alerts = stripComments(read(ALERTS));
    eq((alerts.match(/<MonitorTable /g) || []).length, 2, '关键词表 + 名人表');
    notOk(/page-alerts__table/.test(alerts), '旧的表结构必须删干净');
    const comp = read('components/monitor-table/index.tsx');
    eq((comp.match(/监控对象/g) || []).length, 1, '表头是两张表共用的一份，不许各写一遍');
    /*
     * `pending` 是端上造的状态（还没有任何执行记录），不在 scan_logs 的枚举里 ——
     * 直接查 SCAN_STATUS_LABEL 会渲染出 undefined。
     */
    ok(/r\.status === 'pending' \? '待扫描'/.test(comp), 'pending 必须自己给文案，不能查表');
  });

  it('组件的样式跟着组件走（否则第二个使用方拿不到样式）', () => {
    for (const c of ['scan-log-list', 'chip-list', 'monitor-table']) {
      ok(read(`components/${c}/index.scss`).includes('@import'), `${c} 必须自带 scss`);
      ok(read(`components/${c}/index.tsx`).includes(`import './index.scss'`), `${c} 必须引入自己的 scss`);
    }
  });
});

describe('导航：两页互跳不许叠栈', () => {
  it('预警页进工作台时带 from=alerts（工作台据此决定退还是替换）', () => {
    const alerts = stripComments(read(ALERTS));
    ok(
      /navigateTo\(\{ url: '\/package\/workbench\/index\?from=alerts' \}\)/.test(alerts),
      '不带来源标记，工作台只能猜；猜错就是栈一层层加深'
    );
  });

  it('工作台回预警页：从预警页来就退，从别处来就替换（两个方向都不进栈）', () => {
    const wb = stripComments(read(WORKBENCH));
    ok(/router\.params\?\.from === 'alerts'/.test(wb), '判据必须有');
    ok(/if \(fromAlerts\) \{\s*void Taro\.navigateBack\(\)/.test(wb), '从预警页来的：退回去');
    ok(/redirectTo\(\{ url: '\/package\/alerts\/index' \}\)/.test(wb), '从别处来的：替换过去，不进栈');
    notOk(
      /const goAlerts = \(\) => void Taro\.navigateTo/.test(wb),
      '这正是修掉的 bug：两个方向都 navigateTo，来回点几次就顶到 10 层上限'
    );
  });

  it('下钻页仍是 navigateTo（进去还能退回来），别把「进」也改成替换', () => {
    ok(
      /const goEvents = \(\) => void Taro\.navigateTo\(\{ url: '\/package\/events\/index' \}\)/.test(
        stripComments(read(WORKBENCH))
      ),
      '事件列表是下钻页：替换掉工作台会让用户退不回来'
    );
  });

  it('事件详情页的返回走 goBackOr（订阅消息/小程序码/转发卡片打开时栈里只有它自己）', () => {
    const ev = stripComments(read(EVENT));
    ok(/const goBack = \(\) => goBackOr\('\/package\/events\/index'\)/.test(ev));
    notOk(/const goBack = \(\) => void Taro\.navigateBack\(\)\s*$/.test(ev), '裸 navigateBack 在栈底会静默失败');
    ok(/export function goBackOr/.test(read('utils/route.ts')), '兜底函数必须在统一的路由工具里');
  });
});
