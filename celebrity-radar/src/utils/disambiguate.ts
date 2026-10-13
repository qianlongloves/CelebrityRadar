import { z } from 'zod'
import { DOMAIN_CODES, DOMAIN_META, DomainCode, domainLabel, sanitizeDomain } from '@/config/domains'
import { chatJSON, ChatJSONResult } from './llm'
import { diagLog } from './cloud-diagnostics'
/* 边界测试开关：打开时「涉政涉军 → refused」那条规则不拼进提示词（见 utils/debug.ts） */
import { RESTRICTED_SEARCH_ALLOWED } from './debug'

/** 消歧候选（§1.6：领域 + 国籍 + 一句代表事件）。领域自 2026-10-12 起可为自创短串 */
export interface PersonCandidate {
  name: string
  domain: string
  brief: string
}

/**
 * 提示词里的领域清单：从 DOMAIN_CODES 派生，**不写死**（写死会漏改，且不报错）。
 * 两种形态：消歧要求模型回传领域码，故给「码/码/码」；「只收录…领域」那句是给人读的，故给中文标签。
 */
const DOMAIN_HINT_LIST = DOMAIN_CODES.join('/')
const DOMAIN_TEXT_LIST = DOMAIN_CODES.map((c) => DOMAIN_META[c].label).join('、')

const CandidateSchema = z.object({
  name: z.string().min(1),
  /*
   * 领域自 2026-10-12 起**放宽为自由短串**：已知的 12 个码仍然优先，但都不贴切时模型可自创一个。
   * 净化后为空即非法 → 回落 'other'，调用方**永远看不到**空 / 未净化的领域。
   */
  domain: z.string().transform((s) => sanitizeDomain(s) || 'other'),
  brief: z.string().default('')
})

const DisambiguationSchema = z.union([
  z.object({ refused: z.literal(true) }),
  z.object({
    refused: z.literal(false).optional(),
    candidates: z.array(CandidateSchema)
  })
])

/**
 * 涉政涉军的拒答规则（第二级拦截）。**边界测试**时由 debug.allowRestrictedSearch 跳过
 * （见 utils/debug.ts）—— 放开只影响这条提示词，云端 contentCheck 仍会拦涉政内容。
 */
const REFUSE_RULE =
  '3. 若该名字对应政治、军事类人物，或存在此类同名人物，直接返回 {"refused": true}，不要返回任何候选。'

/** 敏感过滤第二级（LLM 兜底）与消歧共用一套提示词（§六.7） */
const BASE_RULES = [
  '你是名人消歧助手。用户输入一个名字，你返回同名公众人物的候选列表，供用户选择具体是哪一位。',
  '规则：',
  `1. 只收录真实存在的公众名人（${DOMAIN_TEXT_LIST}等领域）。`,
  `2. 每位候选字段：name（惯用名）、domain（优先从 ${DOMAIN_HINT_LIST} 中选，都不贴切时可自创一个 2~6 字的中文领域短词）、brief（一句话身份或代表事件，30 字内）。`,
  ...(RESTRICTED_SEARCH_ALLOWED ? [] : [REFUSE_RULE]),
  '4. 若查无此公众名人，返回 {"refused": false, "candidates": []}。',
  '5. 只输出 JSON，不要输出任何其他文字。'
]

/** 领域筛选（用户在发现页选定行业）：限定候选领域，避免同名跨行业干扰 */
const DOMAIN_RULE = (label: string) =>
  `6. 用户已限定行业为「${label}」：只返回属于该行业的候选；若该名字在该行业没有公众人物，返回 {"refused": false, "candidates": []}。`

/** 惯用名长度上限：与 brief 的「30 字内」同档。再长必然是模型跑偏（把一句描述当成了名字） */
const NAME_MAX = 30

/** 汉字（CJK 基本区）：判断该走「共享汉字」还是「拉丁串」比对 */
const HAN = /[\u4e00-\u9fa5]/

/**
 * 「这个名字与用户输入有关吗」—— 宽松到只拦明显不是同一人的候选（P2-17，2026-10-09）。
 *
 * 中文：共享至少一个汉字（「小李」↔「李某某」靠「李」；「张三」↔「李四」拦下）。
 * 拉丁 / 混合：忽略空白与间隔符后互相包含，或共享 ≥3 个字符（「Jay」↔「Jay Chou」）。
 */
export function nameRelated(input: string, name: string): boolean {
  const a = (input || '').trim().toLowerCase()
  const b = (name || '').trim().toLowerCase()
  if (!a || !b) return false
  const hanA = Array.from(a).filter((ch) => HAN.test(ch))
  const hanB = Array.from(b).filter((ch) => HAN.test(ch))
  if (hanA.length > 0 && hanB.length > 0) return hanA.some((ch) => hanB.includes(ch))
  const strip = (s: string): string => s.replace(/[\s.·・'’-]/g, '')
  const x = strip(a)
  const y = strip(b)
  if (!x || !y) return false
  if (x.includes(y) || y.includes(x)) return true
  if (x.length >= 3 && y.length >= 3) {
    const set = new Set(Array.from(y))
    return Array.from(x).filter((ch) => set.has(ch)).length >= 3
  }
  return false
}

/**
 * 候选的净化与相关性过滤（P2-17，2026-10-09）。
 *
 * 模型回传的 name 会直接进 personKey（`名字#领域码`）并落库，此前**没有任何约束**：
 *   · name 带 `#` —— 主键被切错位，同一个人可能分裂成两行缓存；
 *   · name 是一整句描述（「演员、导演张三」）—— 报告标题、目录、锚点全是这串字；
 *   · name 与用户输入毫无关系（输入「张三」回「李四」）—— 用户点了候选，读到的是别人的报告。
 * 前两条净化掉就完了。第三条**不能一律丢弃**：昵称 / 艺名场景下「一个字都不共享」是正常的
 * （「小甜甜」↔「布兰妮」），全丢会让用户查不到人。故只在「过滤后还有候选」时才采用过滤结果，
 * 一个不剩就原样交回（宁可让用户看到一个可疑候选，也不要给他一屏空）。
 */
export function sanitizeCandidates(input: string, candidates: PersonCandidate[]): PersonCandidate[] {
  const cleaned: PersonCandidate[] = []
  for (const c of candidates) {
    const name = (c.name || '')
      /* personKey 的分隔符，绝不能出现在名字里 */
      .replace(/[#＃]/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, NAME_MAX)
    if (!name) continue
    /* 同一位（同名同领域）只留第一条：模型偶尔会把同一人列两遍 */
    if (cleaned.some((x) => x.name === name && x.domain === c.domain)) continue
    cleaned.push({ name, domain: c.domain, brief: (c.brief || '').trim().slice(0, 60) })
  }
  const related = cleaned.filter((c) => nameRelated(input, c.name))
  return related.length > 0 ? related : cleaned
}

function buildSystemPrompt(domainHint: DomainCode | 'all'): string {
  const rules = [...BASE_RULES]
  if (domainHint !== 'all') rules.push(DOMAIN_RULE(domainLabel(domainHint)))
  return rules.join('\n')
}

/**
 * LLM 消歧（§4.2 关键交互流第一步）。
 * 返回：refused（敏感拒答）或候选列表（可能为空 = 未识别，需补充领域关键词）。
 * @param opts.domainHint 发现页行业筛选：限定候选领域（'all' = 不限）
 * @param opts.keyword 用户输入里拆出的补充关键词（见 utils/query-split.ts）：仅作提示帮助模型
 *   判断是哪个同名人物，**不改变 domain 的生成规则**。它只出现在 user 消息里，绝不进 personKey。
 */
export async function disambiguate(
  name: string,
  opts: { domainHint?: DomainCode | 'all'; keyword?: string } = {}
): Promise<ChatJSONResult<{ refused: boolean; candidates: PersonCandidate[] }>> {
  const domainHint = opts.domainHint ?? 'all'
  const keyword = (opts.keyword ?? '').trim()
  const lines = [`名字：${name.trim()}`]
  if (domainHint !== 'all') lines.push(`限定行业：${domainLabel(domainHint)}`)
  /* 补充关键词只帮模型区分同名者，不参与领域生成 —— 且它是用户输入，放在 user 消息里 */
  if (keyword) lines.push(`补充关键词：${keyword}`)
  const userMessage = lines.join('\n')
  /*
   * purpose='aux'：消歧发生在生成**之前**，不该占用户当日的生成额度 ——
   * 否则额度用完的用户连名字都输入不了（会被报成「额度已用完」，而端上并未为消歧计数）。
   * 详见 aiProxy/quota.config.js 的 AUX_PURPOSE。
   */
  const result = await chatJSON(buildSystemPrompt(domainHint), userMessage, DisambiguationSchema, {
    purpose: 'aux'
  })
  if (!result.ok) return result

  const data = result.data
  if ('refused' in data && data.refused === true) {
    diagLog('info', 'auth', `消歧 LLM 拒答：${name}`)
    return { ok: true, data: { refused: true, candidates: [] } }
  }
  const raw = (data as { candidates: z.infer<typeof CandidateSchema>[] }).candidates ?? []
  /* 净化 + 相关性过滤（P2-17）：候选名要进 personKey 并落库，这里是不设防的最后一道 */
  const candidates = sanitizeCandidates(name, raw)
  if (candidates.length !== raw.length) {
    diagLog(
      'warn',
      'auth',
      `消歧候选被净化：${raw.length} → ${candidates.length}（输入「${name.trim()}」）`
    )
  }
  return { ok: true, data: { refused: false, candidates } }
}
