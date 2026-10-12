import { z } from 'zod'
import { domainLabel } from '../config/domains'
import { SEARCH_COUNTS } from '../config/benefits'
import { SEARCH_LANES, SearchLaneKey } from './report-toc'
import { chatJSON } from './llm'
import { diagLog } from './cloud-diagnostics'
import { cleanText, clipText } from './text'

/**
 * 检索词规划（2026-10-11）：**先问模型「该去查什么」，再拿这些词去查**。
 *
 * 改造前后的差别只有一句话：
 *   以前 —— 查询词是模板里写死的句式（`人名 + 模板 news 路`），模型只负责「已知素材写报告」；
 *   现在 —— 每次生成先让模型按人物与领域**给出检索词**，端上拿这些词去博查，素材到手后照旧喂模型成文。
 *
 * 三条硬性规定（不是「尽量」，是这次改造的边界）：
 *   ① **这一步不看任何检索结果** —— 本次调用的 user 消息里只有人名、领域与「哪几路要什么素材」，
 *      没有任何 NewsItem 字段可传。这是**结构性**保证（不靠提示词里那句「请不要参考」）：
 *      规划发生在检索之前，素材此刻根本还不存在。于是模型给的是「该查什么」，而不是
 *      「假装查到了什么」——后者会直接把编造的事实送进检索层，再以「素材」的名义进报告。
 *   ② **成文那一步照旧只吃素材** —— 本模块不碰 utils/report.ts 的提示词与素材段，
 *      「事实字段仅基于素材」这条硬约束一个字都没松动（规划只影响「查什么词」）。
 *   ③ **失败一律回落模板句式** —— 通道不通 / 模型乱答 / 词不可用，全部返回 null，
 *      调用方按 utils/report-toc.ts#SEARCH_LANES 的兜底句式去查，也就是改造前的行为。
 *      规划是**加分项**：它不该让任何一次生成失败、也不该多等一整轮。
 *
 * 定级：purpose='aux'（与消歧、选题同一档，见 aiProxy/quota.config.js#AUX_PURPOSE）——
 * 它发生在生成之前，不该占用户当日的生成额度；额度用完的用户仍能规划（被防滥用闸挡下时
 * 只是回落到模板句式，不报错）。
 */

/** 规划结果：只含本次真要查的那几路（每条路 0~SEARCH_COUNTS.planWordsPerLane 个词） */
export type SearchPlan = Partial<Record<SearchLaneKey, string[]>>

/** 每路最多采纳几个词（成本闸门真源见 config/benefits.ts#SEARCH_COUNTS） */
const MAX_WORDS = SEARCH_COUNTS.planWordsPerLane
/** 单个关键词的字数上限：它是**查询词的一部分**，长了会把排序拉向噪声（超出即截断） */
export const PLAN_WORD_MAX_CHARS = 16

/**
 * 输出契约：三路都可缺、可为空数组（非严格对象，多余的键由 zod 静默丢弃）。
 * 模型给空数组是**合法答案**（它可能确实想不出该查什么），此时回落模板句式。
 *
 * 用 `.optional()` 而不是 `.default([])`：后者会让 zod 的**输入**类型与**输出**类型分叉
 * （输入可缺、输出必有），而 chatJSON 的 schema 形参要求二者一致（`z.ZodType<T>`）。
 */
const PlanSchema = z.object({
  news: z.array(z.string()).optional(),
  social: z.array(z.string()).optional(),
  profile: z.array(z.string()).optional()
})

/**
 * 净化模型给的词（必做，不是可选的礼貌）：
 *   · 去掉人名 —— 端上拼查询时前面已经带人名（`${name} ${word}`），模型再写一遍会变成
 *     「张三 张三 近期动态」，白占排序权重；
 *   · 去掉标点与引号 —— 它们会原样进 query 串；
 *   · 去掉站点限定与时间词 —— 前者是端上白名单（utils/report-toc.ts#SEARCH_LANES）的事，
 *     后者由端上的时间窗阶梯控制（模型写「2026 年」会把冷门人物的长期报道一次滤掉）。
 * 返回空串表示这个词不可用。
 */
function sanitizeWord(raw: string, name: string): string {
  let w = cleanText(raw, { markup: true })
  /* 人名出现在任何位置都要摘掉（模型常写成「张三 近期动态」） */
  w = w.split(name).join(' ')
  /* 标点 / 引号 / 括号：中文关键词不需要它们，留着只会让 query 串变脏 */
  w = w.replace(/["'“”‘’`《》「」【】〔〕()（）[\]{}<>]/g, ' ')
  w = w.replace(/\s{2,}/g, ' ').trim()
  if (!w) return ''
  /* 站点限定与「键: 值」形态：这一路怎么限定站点由模板说了算，模型不该越权 */
  if (/[:：]/.test(w) || /\bsite\s*:/i.test(w)) return ''
  /* 纯数字/纯符号（如「2026」）：它做查询词只会把时间断章取义 */
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(w)) return ''
  if (w.length < 2) return ''
  return clipText(w, PLAN_WORD_MAX_CHARS)
}

/** 按路的顺序净化 + 去重 + 截到成本上限；整趟都没词就返回 null（调用方回落模板句式） */
function sanitizePlan(data: z.infer<typeof PlanSchema>, name: string, lanes: SearchLaneKey[]): SearchPlan | null {
  const plan: SearchPlan = {}
  let total = 0
  for (const lane of lanes) {
    const words: string[] = []
    for (const raw of data[lane] ?? []) {
      if (words.length >= MAX_WORDS) break
      const w = sanitizeWord(raw, name)
      if (!w || words.includes(w)) continue
      words.push(w)
    }
    if (words.length > 0) {
      plan[lane] = words
      total += words.length
    }
  }
  return total > 0 ? plan : null
}

/**
 * 提示词。逐路的「要什么素材」**从模板派生**（utils/report-toc.ts#SEARCH_LANES 的 want），
 * 不在这里另写一份 —— 否则模板改了一路的意思，模型还在按旧意思给词（19 只钉得住字面量，
 * 钉不住这种漂移）。
 */
function buildSystemPrompt(lanes: SearchLaneKey[]): string {
  const laneList = lanes.map((k) => `- ${k}：${SEARCH_LANES[k].want}`).join('\n')
  return [
    '你为「查人物资料」规划检索引擎的关键词。你只能依据人物名字与领域判断该查什么。',
    '硬性规定（必须遵守）：',
    '1. 本次调用**没有任何检索结果、新闻、网页或资料**可参考 —— 不要假装查过，也不要写出任何' +
      '具体事件、日期、数字、公司名或作品名。你给的是「该去查什么」，不是「查到了什么」。',
    `2. 每条关键词 2~${PLAN_WORD_MAX_CHARS} 个字，可含空格；不要标点、引号、书名号，不要写人名` +
      '（端上会自动与名字拼成查询词），不要写站点限定（site: 开头的写法），不要写时间限定' +
      '（如「2026 年」「最近一周」）。',
    `3. 每条路最多给 ${MAX_WORDS} 条，按重要性排序；想不出这条路该查什么就给空数组，**不要凑数**。`,
    '4. 输出严格 JSON，只含下面列出的键，不要任何解释：',
    /* 示例只列**本次真要查的**那几路：列全三路会让模型误以为社交路也要给词（免费档不问它） */
    `{${lanes.map((k) => `"${k}":["..."]`).join(',')}}`,
    '本次需要你给关键词的素材路（每条路的词只服务这一路）：',
    laneList
  ].join('\n')
}

function buildUserMessage(name: string, domain: string, lanes: SearchLaneKey[]): string {
  const laneList = lanes.map((k) => `- ${k}：${SEARCH_LANES[k].want}`).join('\n')
  return [`人物：${name}`, `领域：${domainLabel(domain)}`, '需要关键词的素材路：', laneList].join('\n')
}

/**
 * 让模型给出检索词。**绝不抛错、绝不阻塞生成**：
 * 返回 null = 「这次没有可用的模型词，请按模板句式去查」，调用方无需区分成因（日志里能查到）。
 *
 * @param lanes 本次真要查的几路（免费档不查社交支线，就不该问模型要社交词 —— 白花 token）
 */
export async function planSearchQueries(
  name: string,
  domain: string,
  opts: { lanes: SearchLaneKey[] }
): Promise<SearchPlan | null> {
  const person = cleanText(name, { markup: true }).trim()
  const lanes = opts.lanes.filter((k, i) => !!SEARCH_LANES[k] && opts.lanes.indexOf(k) === i)
  if (!person || lanes.length === 0) return null

  /*
   * retries: 0 —— 规划在**每次生成的必经路径**上（比报告长生成更靠前），多一轮重试就是白等
   * 一个往返，而模板句式本就是可用的兜底。模型偶尔吐一段坏 JSON 时，采用模板句式的代价
   * 远小于让用户多等两秒。
   */
  const res = await chatJSON(buildSystemPrompt(lanes), buildUserMessage(person, domain, lanes), PlanSchema, {
    retries: 0,
    purpose: 'aux'
  })
  if (!res.ok) {
    diagLog('warn', 'llm', `检索词规划跳过（${res.kind ?? 'error'}），改用模板句式：${res.error}`)
    return null
  }

  const plan = sanitizePlan(res.data, person, lanes)
  if (!plan) {
    diagLog('warn', 'llm', `检索词规划没给出可用词，改用模板句式：${person}`)
    return null
  }
  diagLog(
    'info',
    'llm',
    `检索词规划：${lanes.map((k) => `${k}=[${(plan[k] ?? []).join(' | ')}]`).join(' ')}`,
    { personKeyDomain: domain }
  )
  return plan
}
