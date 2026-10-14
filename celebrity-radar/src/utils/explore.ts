import Taro from '@tarojs/taro'
import { z } from 'zod'
import { buildPersonKey, DOMAIN_CODES, DOMAIN_META, sanitizeDomain } from '@/config/domains'
import { HOT_PERSONS } from '@/config/hot'
import { chatJSON } from './llm'
import { resolvePersonKey } from './person-index'
import { diagLog } from './cloud-diagnostics'

/** 热门池唯一来源 = config/hot.ts（发现页热门卡片 / 今日名人 / 静态兜底共用） */
const FLAT: Array<{ name: string; domain: string }> = HOT_PERSONS.map(({ name, domain }) => ({ name, domain }))

/**
 * 提示词里的领域清单：从 DOMAIN_CODES 派生，**不写死**。
 * 领域码增删只改 config/domains.ts，这里与选题提示词自动跟随 —— 写死的话新领域永远不会被
 * AI 选题选中（模型只在被告知的那几个里挑），而且**不会有任何报错**，属于最难发现的一类漏改。
 */
const DOMAIN_LIST = DOMAIN_CODES.map((c) => `${c}（${DOMAIN_META[c].label}）`).join('、')

export interface PersonPick {
  name: string
  domain: string
  personKey: string
}

/**
 * 随机取一位热门名人（seed 相同 ⇒ 结果相同）。
 * 用 xorshift32 做散列，避免「seed 连续 ⇒ 结果连续」的取模偏置。
 */
export function pickRandomPerson(seed: number = Date.now()): PersonPick {
  let x = (seed | 0) ^ 0x9e3779b9
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  const { name, domain } = FLAT[Math.abs(x) % FLAT.length]
  return { name, domain, personKey: buildPersonKey(name, domain) }
}

/** 今日名人：以「天」为种子，同一天稳定、次日自动换一位 */
export function todayPerson(): PersonPick {
  return pickRandomPerson(Math.floor(Date.now() / 86400000))
}

/** 打开报告页（personKey 统一出口）。跳转前按名字归一到「已有报告的那份 key」（Task C，2026-10-12） */
export async function openPerson(pick: PersonPick): Promise<void> {
  const personKey = await resolvePersonKey(pick.name, pick.domain)
  Taro.navigateTo({ url: `/package/report/index?personKey=${encodeURIComponent(personKey)}` })
}

/** AI 选题的输出契约：只认「是谁」和「哪个领域」，多余字段一律忽略 */
const PickSchema = z.object({
  name: z.string().min(1),
  /* 领域自 2026-10-12 起放宽为自由短串：已知码优先，都不贴切时模型可自创；净化后为空回落 'other' */
  domain: z.string().transform((s) => sanitizeDomain(s) || 'other')
})

/**
 * 让模型现挑一位公众人物（失败返回 null，由调用方兜底）。
 *
 * 与 pickRandomPerson 的区别：那个只能在 config/hot.ts 的静态池里循环，连点几次就撞脸，
 * 也永远在池内。这里由模型选题，覆盖池外的人，并要求领域大致均衡 —— 「随机探索」要的是意外感，
 * 而榜单前几位恰恰是用户最不需要被推荐的（他们本来就认识）。
 * 提示词里显式排掉热门池成员，免得模型把「热门」当成「随机」直接复读榜单。
 */
async function pickPersonByAi(): Promise<PersonPick | null> {
  const system = [
    '你是名人观察产品的选题助手：随机推荐一位值得关注的公众人物，供系统生成深度观察报告。',
    '规则：',
    `1. 领域从 ${DOMAIN_LIST} 中选一个，各领域机会大致均等，不要总推企业家或当红艺人；若这些领域都不贴切，可自创一个 2~6 字的中文领域短词。`,
    `2. 不要推荐这些高频人物：${HOT_PERSONS.map((p) => p.name).join('、')}。`,
    '3. 必须是真实存在、且近一年有公开报道的公众人物；不要政治、军事类人物。',
    '4. 输出字段：name（惯用中文名，外籍人物用通行中文译名）、domain（上列之一，或自创的短领域词）。',
    '5. 只输出 JSON，不要输出任何其他文字。'
  ].join('\n')

  /*
   * purpose='aux'：随机选题是辅助调用，不占用户当日的生成额度 ——
   * 生成额度用完后仍应能摇人（否则用户会看到「额度已用完」，而端上并未为它计数）。
   * 失败时上层退回静态热门池（见下方），所以它也不怕被限速闸挡下。
   */
  const res = await chatJSON(system, `随机种子：${Date.now()}\n请给出一个人名。`, PickSchema, {
    purpose: 'aux'
  })
  if (!res.ok) {
    diagLog('warn', 'llm', `AI 随机选题失败，改用静态热门池：${res.error}`)
    return null
  }
  const name = res.data.name.trim()
  if (!name) return null
  diagLog('info', 'llm', `AI 随机选题：${name}#${res.data.domain}`)
  return { name, domain: res.data.domain, personKey: buildPersonKey(name, res.data.domain) }
}

/**
 * 「随机探索」唯一入口：AI 挑一位 → 跳报告页。
 *
 * loading 与防重入都收在这里，而不是散在各个按钮上：入口有不止一处（底部中央按钮、
 * 发现页「随机探索一位」），各写一遍必漏一个 —— AI 往返要 1~3 秒，这段时间连点会连开几个报告页。
 *
 * 全程无错误分支：静态池人选先备好，AI 失败 / 超时 / 输出不合法都直接用它。
 * 「随手一按」的入口不该弹报错让用户做决定，最坏情况就是回到改动前的行为。
 */
let exploring = false

export async function exploreRandomPerson(): Promise<void> {
  if (exploring) return
  exploring = true

  let pick = pickRandomPerson()
  Taro.showLoading({ title: 'AI 正在挑选…', mask: true })
  try {
    pick = (await pickPersonByAi()) ?? pick
  } catch (err) {
    /* chatJSON 本身不抛异常，这里只兜住意料之外的链路故障 */
    diagLog('warn', 'llm', `AI 随机选题异常，改用静态热门池：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    exploring = false
    /* 先关 loading 再跳转：loading 是全局的，带进报告页会盖住那边的生成动画 */
    Taro.hideLoading()
  }
  openPerson(pick)
}
