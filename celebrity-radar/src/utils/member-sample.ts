import { diagLog } from './cloud-diagnostics'
import { table } from './db'

/**
 * 会员中心「真实示例」的数据源（O-22）。
 *
 * 会员中心一直在用文字描述深度模式（对比表那一行「加厚素材 + 专享内容」），
 * 但用户的疑问从来不是「有没有这三段」，而是「这三段到底长什么样、值不值得买」——
 * 抽象描述答不了这个问题，只有真东西能答。所以这里**只取真实产出**：
 * 从 `report_cache` 里挑一份确实带专享段落的就绪报告，把原文当示例摆出来。
 *
 * 三条口径（改动前先读）：
 *   1. **不做假示例**：取不到就不出这张卡（页面整块不渲染）。编一段「看起来像报告」的
 *      文案最省事，但那是把营销素材伪装成产品产出 —— 与全项目「不夸大、不承诺做不到的」
 *      口径直接冲突。示例卡上那行来源（取自谁、什么时候生成）就是为了让这一点可核对。
 *   2. **只读已就绪的报告**（state='ready'）：inbox 里的半成品/过期版本从未被任何人看过，
 *      拿它当示例等于展示一份我们自己的垃圾。
 *   3. **只节选、不改写**：超过 SAMPLE_CLAMP 字就截断（加省略号），不做摘要、不做润色。
 *      改一个字，它就不再是「真实示例」了。
 *
 * 与相邻模块的分工：本文件只负责「拿到一份可展示的真实样本」；
 * 权益说明与文案在 utils/member.ts，页面上怎么摆由 pages/member 决定。
 */

/** 扫描最近多少份就绪报告：小程序端单次 get 上限 20，示例卡不值得再翻一页 */
const SCAN = 20
/** 内存缓存 TTL：示例取自真实报告、天级才可能变化，进一次页打一次库没有意义 */
const TTL_MS = 10 * 60 * 1000
/** 每段节选上限（字符）：示例卡只回答「它长什么样」，全文该去报告页看 */
export const SAMPLE_CLAMP = 80

export interface MemberSampleBlock {
  label: string
  text: string
}

export interface MemberSample {
  /** 样本来源报告的 personKey（缓存行主键），页面用它做文案与后续跳转 */
  personKey: string
  name: string
  /** 样本报告的生成时间（ISO）；脏数据时为空串，页面自行降级 */
  generatedAt: string
  blocks: MemberSampleBlock[]
}

/** 示例卡用的截断：按字符数切、不切词（中文没有词边界可依赖），末尾加省略号 */
export function clampSample(text: string, max: number = SAMPLE_CLAMP): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * 报告 → 示例段落。只认这几段（memberNotes 两段 / conflicts / affiliations），其余字段一律不看
 * （示例卡不是报告预览）。信源分歧与企业关联各只取第一条：这一段的重点是「素材自己会对不上 / 本人
 * 与机构有关联」这件事本身，不是条数。
 */
function buildBlocks(report: any): MemberSampleBlock[] {
  const blocks: MemberSampleBlock[] = []
  const compare = str(report?.memberNotes?.compare)
  const risk = str(report?.memberNotes?.risk)
  if (compare !== '') blocks.push({ label: '对比视角', text: clampSample(compare) })
  if (risk !== '') blocks.push({ label: '风险提示', text: clampSample(risk) })

  const first = Array.isArray(report?.conflicts) ? report.conflicts[0] : null
  const topic = str(first?.topic)
  const a = str(first?.a)
  const b = str(first?.b)
  const sides = [a !== '' ? `一方：${a}` : '', b !== '' ? `另一方：${b}` : ''].filter((s) => s !== '')
  if (sides.length > 0) {
    blocks.push({ label: '信源分歧', text: clampSample([topic, ...sides].filter((s) => s !== '').join(' · ')) })
  }

  /* 企业关联（2026-10-12，会员专享）：与信源分歧同为结构化段，只取第一条。
     kind 是英文枚举（company / partner / equity），示例卡里不展示，只摆机构名与说明。 */
  const firstAff = Array.isArray(report?.affiliations) ? report.affiliations[0] : null
  const affName = str(firstAff?.name)
  const affNote = str(firstAff?.note)
  if (affName !== '') {
    blocks.push({
      label: '企业关联',
      text: clampSample([affName, affNote].filter((s) => s !== '').join(' · '))
    })
  }
  return blocks
}

/**
 * 从一批缓存行里挑出第一份**确实含专享段落**的报告（纯函数，便于单测）。
 * 行序即优先级：调用方按生成时间倒序取，故这里挑到的就是「最近一份会员报告」。
 * 脏行（缺主键 / 缺名字 / 无专享段）一律跳过，绝不用半条数据凑一张示例卡。
 */
export function pickMemberSample(rows: unknown): MemberSample | null {
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    const r = row as any
    const personKey = str(r?.id)
    const report = r?.report
    if (personKey === '' || !report || typeof report !== 'object') continue
    const name = str(report.name)
    if (name === '') continue
    const blocks = buildBlocks(report)
    if (blocks.length === 0) continue
    return { personKey, name, generatedAt: str(r?.generated_at) || str(report.generatedAt), blocks }
  }
  return null
}

/**
 * 无索引回退路径拿到的行**没有可靠顺序**，而本模块的口径是「取**最近**一份会员报告」。
 * 端上补一次按生成时间降序，否则示例卡可能取自一份陈年报告（不报错，只是「示例不像产品现状」）。
 * 解析失败的行按 0 处理（沉到最后）。
 */
function sortByGeneratedAtDesc(rows: any[]): any[] {
  const at = (r: any): number => {
    const t = typeof r?.generated_at === 'string' ? Date.parse(r.generated_at) : NaN
    return Number.isFinite(t) ? t : 0
  }
  return rows.slice().sort((a, b) => at(b) - at(a))
}

/**
 * 示例卡只摆四段（`buildBlocks` 认的那几段）与来源信息，其余 14 节一律不看。
 * 故按列投影取：一次扫 `SCAN` 份，`select('*')` 是把 20 份完整报告拖下来挑四段。
 * 这里要的正是会员段本身，所以它省不掉 —— 省掉的是「与示例无关的那部分正文」。
 */
const SAMPLE_COLUMNS =
  'id, generated_at, report.name, report.generatedAt, report.memberNotes, report.conflicts, report.affiliations'

/** 读最近的就绪报告；排序依赖 generated_at 索引，索引未建时退化为不排序扫描（端上补排序） */
async function queryRows(): Promise<any[]> {
  const ordered = await table('report_cache')
    .select(SAMPLE_COLUMNS)
    .eq('state', 'ready')
    .order('generated_at', { ascending: false })
    .limit(SCAN)
  if (!ordered.error) return (ordered.data as any[]) ?? []

  diagLog('warn', 'db', `会员示例按时间读取失败，回退无排序 + 端上排序：${ordered.error.message ?? ordered.error}`)
  const plain = await table('report_cache').select(SAMPLE_COLUMNS).eq('state', 'ready').limit(SCAN)
  if (plain.error) {
    diagLog('warn', 'db', `会员示例读取失败，本次不出示例卡：${plain.error.message ?? plain.error}`)
    return []
  }
  return sortByGeneratedAtDesc((plain.data as any[]) ?? [])
}

let memo: { at: number; value: MemberSample | null } | null = null
let pending: Promise<MemberSample | null> | null = null

/** 取一份真实示例；永不 reject（示例卡缺了不影响会员中心任何功能，最坏就是不显示） */
export function loadMemberSample(): Promise<MemberSample | null> {
  if (memo && Date.now() - memo.at < TTL_MS) return Promise.resolve(memo.value)
  if (pending) return pending

  pending = queryRows()
    .then((rows) => {
      const value = pickMemberSample(rows)
      /* 取不到也写进缓存：否则每次进页都要为一张不存在的卡再打一次库 */
      if (!value) diagLog('info', 'db', `会员示例：最近 ${rows.length} 份就绪报告中没有专享段落，本次不出示例卡`)
      memo = { at: Date.now(), value }
      return value
    })
    .catch((err) => {
      diagLog('warn', 'db', `会员示例构建异常，本次不出示例卡：${err instanceof Error ? err.message : String(err)}`)
      memo = { at: Date.now(), value: null }
      return null
    })
    .finally(() => {
      pending = null
    })
  return pending
}
