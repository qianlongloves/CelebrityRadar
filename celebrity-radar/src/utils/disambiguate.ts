import { z } from 'zod'
import { DOMAIN_CODES, DOMAIN_META, DomainCode } from '@/config/domains'
import { chatJSON, ChatJSONResult } from './llm'
import { diagLog } from './cloud-diagnostics'

/** 消歧候选（§1.6：领域 + 国籍 + 一句代表事件） */
export interface PersonCandidate {
  name: string
  domain: DomainCode
  brief: string
}

const CandidateSchema = z.object({
  name: z.string().min(1),
  domain: z.enum(DOMAIN_CODES as [DomainCode, ...DomainCode[]]),
  brief: z.string().default('')
})

const DisambiguationSchema = z.union([
  z.object({ refused: z.literal(true) }),
  z.object({
    refused: z.literal(false).optional(),
    candidates: z.array(CandidateSchema)
  })
])

/** 敏感过滤第二级（LLM 兜底）与消歧共用一套提示词（§六.7） */
const BASE_RULES = [
  '你是名人消歧助手。用户输入一个名字，你返回同名公众人物的候选列表，供用户选择具体是哪一位。',
  '规则：',
  '1. 只收录真实存在的公众名人（科技、商业、文娱、体育、学术等领域）。',
  '2. 每位候选字段：name（惯用名）、domain（只能是 tech/business/ent/sports/academia/other 之一）、brief（一句话身份或代表事件，30 字内）。',
  '3. 若该名字对应政治、军事类人物，或存在此类同名人物，直接返回 {"refused": true}，不要返回任何候选。',
  '4. 若查无此公众名人，返回 {"refused": false, "candidates": []}。',
  '5. 只输出 JSON，不要输出任何其他文字。'
]

/** 领域筛选（用户在发现页选定行业）：限定候选领域，避免同名跨行业干扰 */
const DOMAIN_RULE = (label: string) =>
  `6. 用户已限定行业为「${label}」：只返回属于该行业的候选；若该名字在该行业没有公众人物，返回 {"refused": false, "candidates": []}。`

function buildSystemPrompt(domainHint: DomainCode | 'all'): string {
  const rules = [...BASE_RULES]
  if (domainHint !== 'all') rules.push(DOMAIN_RULE(DOMAIN_META[domainHint].label))
  return rules.join('\n')
}

/**
 * LLM 消歧（§4.2 关键交互流第一步）。
 * 返回：refused（敏感拒答）或候选列表（可能为空 = 未识别，需补充领域关键词）。
 * @param opts.domainHint 发现页行业筛选：限定候选领域（'all' = 不限）
 */
export async function disambiguate(
  name: string,
  opts: { domainHint?: DomainCode | 'all' } = {}
): Promise<ChatJSONResult<{ refused: boolean; candidates: PersonCandidate[] }>> {
  const domainHint = opts.domainHint ?? 'all'
  const userMessage =
    domainHint === 'all'
      ? `名字：${name.trim()}`
      : `名字：${name.trim()}\n限定行业：${DOMAIN_META[domainHint].label}`
  const result = await chatJSON(buildSystemPrompt(domainHint), userMessage, DisambiguationSchema)
  if (!result.ok) return result

  const data = result.data
  if ('refused' in data && data.refused === true) {
    diagLog('info', 'auth', `消歧 LLM 拒答：${name}`)
    return { ok: true, data: { refused: true, candidates: [] } }
  }
  const candidates = (data as { candidates: z.infer<typeof CandidateSchema>[] }).candidates ?? []
  return { ok: true, data: { refused: false, candidates } }
}
