'use strict'

/**
 * 模型输出的 JSON 解析（utils/llm#parseModelJson / repairJsonText）
 *
 * 起点是一个真实故障（2026-10-10）：博查与上游大模型都成功返回了正文，报告页却是
 * 「结构化生成暂不可用」的纯文本简版 —— 链路只是 `JSON.parse` 抛了一次错，重试一次又抛，
 * 于是整份降级。这组用例钉住三件事：
 *   ① 有正文、只是格式畸形的，必须救回来（否则白等一轮重试后照样降级）；
 *   ② 「被截断」与「没按格式答」必须分开 —— 前者重发必然再撞同一道上限，重试纯属浪费
 *      （报告一次 30~40s），且上游不传 finish_reason 时「括号没配平」是唯一证据；
 *   ③ 合法 JSON 一个字节都不能被修复层碰（修复是「原样失败后」的增量补救，不是统一洗一遍）。
 */

const fs = require('fs')
const path = require('path')
const env = require('../harness/env')
const { describe, it, ok, notOk, eq, deepEq } = require('../harness/t')

const llm = env.load('utils/llm')

describe('模型输出 JSON 解析 utils/llm#parseModelJson', () => {
  const parse = (s) => llm.parseModelJson(s)

  it('正常 JSON：原样通过，值里的中文与空格都不动', () => {
    const raw = '{"intro":"报告正文，含 空格 与中文","heat":72}'
    const r = parse(raw)
    ok(r.ok)
    deepEq(r.value, { intro: '报告正文，含 空格 与中文', heat: 72 })
  })

  it('结构位写成全角：归一半角后救回，值里的全角标点一个字节都不动', () => {
    /* 中文模型把结构位的逗号 / 冒号写成全角是高频畸形。旧实现只把它记进报错文案、不救，
       代价是整份报告降级成纯文本简版（一次 30~40s 白跑） */
    const r = parse('{"intro"："正文"，"heat"：72}')
    ok(r.ok)
    deepEq(r.value, { intro: '正文', heat: 72 })

    /* 整段连括号都是全角：候选扫描必须先认得出来，否则连「语法错」都判不成 */
    const wrapped = parse('｛"intro"："正文"｝')
    ok(wrapped.ok)
    deepEq(wrapped.value, { intro: '正文' })

    /* 反向约束：值里的全角标点与中文引号是**内容**，修复层不能碰（否则每份中文报告都被改坏） */
    const keep = '{"intro":"他说“好”，然后走了："}'
    eq(llm.repairJsonText(keep), keep)
    deepEq(parse(keep).value, { intro: '他说“好”，然后走了：' })
  })

  it('顶层被包成单元素数组：拆一层后照常通过（正文一个字不差，只是多了对方括号）', () => {
    const r = parse('[{"intro":"正文","heat":1}]')
    ok(r.ok)
    deepEq(r.value, { intro: '正文', heat: 1 })
  })

  it('数组里有多条：不解包，原样交给 schema 判（无从判断该取哪一条）', () => {
    const r = parse('[{"a":1},{"a":2}]')
    ok(r.ok)
    deepEq(r.value, [{ a: 1 }, { a: 2 }])
  })

  it('markdown 栅栏 + 前后散文：剥壳取正文', () => {
    const raw = '好的，以下是报告：\n```json\n{"intro":"正文"}\n```\n希望有帮助。'
    const r = parse(raw)
    ok(r.ok)
    deepEq(r.value, { intro: '正文' })
  })

  it('正文后面还跟着带大括号的散文：不能把散文并进 JSON（旧实现会）', () => {
    /*
     * 旧实现取 lastIndexOf('}')，会被正文之后那段散文里的 `{合计 3 条}` 带偏，
     * 截出来的片段尾部多了半句话，JSON.parse 必失败 —— 与「模型没按格式输出」表现一致，
     * 排查时根本看不出是截取规则的问题。
     */
    const raw = '{"intro":"正式内容"}\n\n（以上为示例，括号 {合计 3 条} 仅作标注）'
    const r = parse(raw)
    ok(r.ok)
    deepEq(r.value, { intro: '正式内容' })
  })

  it('值里含大括号与转义引号：不会被当成结构符号', () => {
    const raw = '{"title":"《长津湖》{上下}两部","quote":"他说\\"我不退役\\""}'
    const r = parse(raw)
    ok(r.ok)
    deepEq(r.value, { title: '《长津湖》{上下}两部', quote: '他说"我不退役"' })
  })

  it('先举格式示例再给正文：取最长的那段（示例必然短于正文）', () => {
    const raw = '格式如下：{"intro":"示例","dynamics":[]}\n实际结果：{"intro":"真正的正文","dynamics":[{"date":"2026-10-01","title":"某条动态"}]}'
    const r = parse(raw)
    ok(r.ok)
    eq(r.value.intro, '真正的正文')
    eq(r.value.dynamics.length, 1)
  })

  it('尾随逗号：修复后可用', () => {
    const r = parse('{"a":1,"b":[1,2,],}')
    ok(r.ok)
    deepEq(r.value, { a: 1, b: [1, 2] })
  })

  it('字符串内的裸换行：转义后可用（模型写多行摘要时最常见）', () => {
    const raw = '{"intro":"第一行\n第二行\t缩进"}'
    let threw = false
    try {
      JSON.parse(raw)
    } catch (e) {
      threw = true
    }
    ok(threw, '前提：裸换行确实是非法 JSON（原样必抛）')
    const r = parse(raw)
    ok(r.ok, '修复层转义后必须能读回来')
    deepEq(r.value, { intro: '第一行\n第二行\t缩进' })
    ok(llm.repairJsonText(raw).includes('\\n'), '是转义而不是把换行删掉')
  })

  it('字符串内未转义的双引号：按「收尾引号后面只可能跟 : , } ]」判回来', () => {
    const raw = '{"intro":"他说"我不退役""}'
    const r = parse(raw)
    ok(r.ok, '应能救回')
    deepEq(r.value, { intro: '他说"我不退役"' })
  })

  it('JSON 里写注释：删掉后可用', () => {
    const raw = '{\n  "a": 1, // 计数\n  /* 备注 */\n  "b": 2\n}'
    const r = parse(raw)
    ok(r.ok)
    deepEq(r.value, { a: 1, b: 2 })
  })

  it('被截断（括号没配平）：判为 truncated，而不是「不含 JSON」或「语法错」', () => {
    const raw = '{"intro":"报告正文","dynamics":[{"date":"2026-10-01","title":"某条'
    const r = parse(raw)
    notOk(r.ok)
    eq(r.kind, 'truncated')
    ok(r.error.includes('截断'), '文案要能看出是撞上限被砍断')
  })

  it('截断不靠 finish_reason 也能认出来（上游不传时这是唯一证据）', () => {
    /* 只是少一个右花括号：finish_reason 可能什么都没说，但 JSON 确实没写完 */
    const r = parse('{"intro":"x"')
    notOk(r.ok)
    eq(r.kind, 'truncated')
  })

  it('模型没按格式答（正文里根本没有 JSON）：判为 no_json', () => {
    const r = parse('这位运动员近期状态良好，暂无退役计划。')
    notOk(r.ok)
    eq(r.kind, 'no_json')
  })

  it('有片段但语法错：判为 syntax，并带上出错位置附近的内容', () => {
    const r = parse('{"a":1 "b":2}')
    notOk(r.ok)
    eq(r.kind, 'syntax')
    ok(r.error.startsWith('LLM 输出 JSON 语法错'), r.error)
  })

  it('修复层对合法 JSON 是恒等变换（不统一洗一遍数据）', () => {
    const cases = [
      '{"a":1}',
      '{"intro":"逗号, 然后右括号 } 结束"}',
      '{"url":"https://example.com/a?b=1&c=2","note":"// 双斜杠在值里是正文"}',
      '{"intro":"他说\\"我不退役\\"，随后离场"}'
    ]
    for (const raw of cases) eq(llm.repairJsonText(raw), raw)
  })

  it('chatJSON 已接上：两种截断来源都认，且不再白重试一轮', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'utils', 'llm.ts'), 'utf8')
    ok(/parseModelJson\(attempt\.content\)/.test(src), 'chatJSON 必须走 parseModelJson')
    ok(
      src.includes("jsonValue.kind === 'truncated'"),
      '未配平的输出也要按截断处理（上游不传 finish_reason 时的唯一证据）'
    )
    notOk(src.includes('extractJSONText'), '旧的「首尾大括号」提取已删除，避免两套口径并存')
    notOk(
      /if \(!jsonText\)[\s\S]{0,120}lastError = 'LLM 输出不含 JSON'/.test(src),
      '不再用「不含 JSON」笼统盖住截断'
    )
  })
})
