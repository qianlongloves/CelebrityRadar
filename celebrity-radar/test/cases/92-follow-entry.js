'use strict';

/**
 * 「我盯的东西」的入口与词表（2026-10-18）。
 *
 * 背景：用户反馈「跟进、订阅、盯事件、关键词监控这几个功能太乱，第一次用不知道是干嘛的、
 * 在哪边能找到」。盘点后确定：乱的不是存储（两套 follows / subs / keyword_watches 是既有
 * 架构，合并另说），而是**入口**——
 *
 *   ① 「我盯的事件」的数据在 `opinion_event_status.follows[eventKey]`，但全站没有一个
 *      命名入口：只能「舆情 tab → 事件卡 → 事件列表 → 再点一次『我盯的』分段」；
 *   ② 「订阅的对象」卡只在已订阅时渲染，而它唯一的新增入口在事件详情页
 *      ⇒ 没订阅过的人永远看不到这张卡，「订阅」这个词在他的屏幕上根本不存在；
 *   ③ 预警页跳事件列表**丢了 `?only=follows`**，点「还有 N 条」落到「全部事件」；
 *   ④ 事件详情页按钮只写「订阅」，与左边的「☆ 跟进」看起来像同一动作的两种叫法。
 *
 * 本文件钉住这三处入口与一处文案（②的判据本身在 68-event-subscribe.js 里钉，这里不重复），
 * 防的是「改回看起来更省事的老写法」。
 *
 * 刻意不动存储：把 `follows` ⇄ `keyword_watches(type='person')`、
 * `subs` ⇄ `keyword_watches(type='keyword')` 两对合并，要迁移存量数据、统一两套额度口径、
 * 重写三个云函数与会员权益表 —— 那是另一批事，不该和文案改动混在一起。
 */

const fs = require('fs');
const path = require('path');
const { describe, it, ok, notOk, eq } = require('../harness/t');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

/** 剥注释后再做负向断言（同 18/45/63/88：说明性文字里的关键词会被当成违规） */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const MINE = stripComments(read('pages/mine/index.tsx'))
const ALERTS = stripComments(read('package/alerts/index.tsx'))
const EVENT = stripComments(read('package/event/index.tsx'))
const EVENT_SCSS = read('package/event/index.scss')
const EVENTS_PAGE = stripComments(read('package/events/index.tsx'))
const OPINION_PAGE = stripComments(read('pages/opinion/index.tsx'))

describe('入口：「我的」页能直接回到我跟进的事件', () => {
  it('「我跟进的事件」与「关注的名人」挨着，跳转带 ?only=follows', () => {
    ok(MINE.includes("title: '我跟进的事件'"), '「我的」页必须有这一行 —— 它是全站唯一没有入口的一类关注')
    ok(
      MINE.includes('/package/events/index?only=follows'),
      '不带 only=follows 会落到「全部事件」，等于让用户进去再自己筛一次'
    )

    const iFollows = MINE.indexOf("title: '关注的名人'")
    const iEvents = MINE.indexOf("title: '我跟进的事件'")
    const iFav = MINE.indexOf("title: '我的收藏'")
    ok(iFollows > 0 && iEvents > 0 && iFav > 0, '三行都要在')
    eq(
      iEvents > iFollows && iEvents < iFav,
      true,
      '「关注的人」与「跟进的事件」要相邻：中间夹收藏 / 历史会把同一个心智模型劈成两半'
    )
  })

  it('负向：本页不许出现不带筛选的事件列表跳转（两个入口行为必须一致）', () => {
    notOk(/\/package\/events\/index'/.test(MINE), "以引号收尾 = 没带参数")
  })
})

describe('入口：预警页的「还有 N 条」落到「我盯的」', () => {
  it('openEventList 必须带 only=follows', () => {
    const m = /const openEventList = \(\) =>[^\n]*\n/.exec(ALERTS)
    ok(m, '找不到 openEventList')
    ok(
      m[0].includes('?only=follows'),
      '这段文字出在「盯的东西」的上下文里；落到「全部事件」= 点完看不到自己刚看的那件事'
    )
  })

  it('正向对照：事件列表页确实认得这个参数（否则参数只是装饰）', () => {
    const EVENTS = stripComments(read('package/events/index.tsx'))
    ok(/router\.params\?\.only === 'follows'/.test(EVENTS), '入口带参、页面不认 = 白改')
  })
})

describe('文案：按钮说「关注对象」，与预警页的「关注的对象」对得上', () => {
  it('事件详情页的关注按钮点明单位是「对象」', () => {
    ok(
      EVENT.includes("'🔕 关注对象'"),
      '少了「对象」两个字，它和左边的「☆ 跟进」看起来就是同一件事的两种叫法'
    )
    ok(EVENT.includes("'🔔 已关注'"))
    notOk(EVENT.includes("'🔕 订阅'"), '负向：裸「订阅」不许回来')
  })

  it('正向对照：「跟进」按钮仍在 —— 两种粒度并存是设计，不是一个替代另一个', () => {
    ok(EVENT.includes("'☆ 跟进'"), '盯单条事件的入口不能被「关注对象」吃掉')
    ok(/已跟进：这件事有新报道时会提醒一次/.test(EVENT), '跟进的含义要留着')
  })
})

describe('样式：第三个按钮变长后的换行防线', () => {
  const ruleOf = (src, sel) => {
    const i = src.indexOf(sel)
    if (i < 0) return ''
    const j = src.indexOf('}', i)
    return j < 0 ? src.slice(i) : src.slice(i, j)
  }

  it('__actions 让整枚按钮换行，而不是压断字', () => {
    const rule = ruleOf(EVENT_SCSS, '&__actions {')
    ok(rule.length > 0, '找不到 &__actions')
    ok(
      /flex-wrap:\s*wrap/.test(rule),
      '与事件列表页卡头同一个坑：三个按钮（其中一个是「关注对象」）挤不下时没有 wrap 就顶出卡片右边界'
    )
  })
})

/*
 * B：词表收敛为 3 个动词（2026-10-18）。
 *
 *   关注 = 免费、站内、不推送（关注的名人 / 关注的对象）
 *   跟进 = 免费、站内、有新报道提醒一次（单条事件）
 *   监控 = 每天云端检索、会推送、有额度上限（关键词 / 名人）
 *
 * 「盯」「订阅」两个词从用户可见层消失：前者是「跟进」的旧说法，后者同时指过
 * 「免费站内」与「花额度推送」两件事 —— 它是最容易误解的那个词。
 */
describe('词表收敛：只有 关注 / 跟进 / 监控 三个动词', () => {
  const VISIBLE = [
    ['预警页', ALERTS],
    ['事件列表', EVENTS_PAGE],
    ['我的', MINE],
    ['舆情页', OPINION_PAGE]
  ]

  it('用户可见文案里不再出现「我盯的」「订阅的对象」', () => {
    for (const [name, src] of VISIBLE) {
      notOk(/我盯的/.test(src), `${name}还留着「我盯的」—— 它是「跟进」的旧说法`)
      notOk(/订阅的对象/.test(src), `${name}还留着「订阅的对象」—— 它现在叫「关注的对象」`)
    }
  })

  it('预警页分两段：先「我在关注的」，再「我在监控的」', () => {
    ok(ALERTS.includes('我在关注的'), '缺关注段的标题，用户看不出哪些是免费站内的')
    ok(ALERTS.includes('我在监控的'), '缺监控段的标题，用户看不出哪些会花额度 / 会推送')
    eq(
      ALERTS.indexOf('我在关注的') < ALERTS.indexOf('我在监控的'),
      true,
      '顺序反了：免费的一律在前，付费的在后（同「我的」页里关注在订阅之上）'
    )
    ok(/page-alerts__section-title/.test(ALERTS), '分段标题要有自己的样式钩子，不能借卡片标题')
    ok(/page-alerts__section-note/.test(ALERTS), '两段各自要有一行成本说明（免费站内 / 每天检索·可推送·有额度）')
  })

  it('关键词卡的按钮与卡名同词：开始监控', () => {
    ok(ALERTS.includes('开始监控'), '按钮叫「开始监测」、卡叫「关键词监控」，就是两套词')
    notOk(ALERTS.includes('开始监测'), '负向：「监测」不许回来')
  })

  it('人物页与报告页的监控按钮逐字一致', () => {
    const PROFILE = stripComments(read('package/profile/index.tsx'))
    const REPORT = stripComments(read('package/report/index.tsx'))
    for (const [name, src] of [
      ['人物页', PROFILE],
      ['报告页', REPORT]
    ]) {
      ok(src.includes("'+ 监控风险'"), `${name}的按钮要写全称「+ 监控风险」`)
      ok(src.includes("'已监控'"), `${name}的完成态要叫「已监控」（「监控中」不像完成态）`)
    }
  })
})
