import Taro from '@tarojs/taro'
import { buildPersonKey, DomainCode } from '@/config/domains'
import { HOT_PERSONS } from '@/config/hot'

/** 热门池唯一来源 = config/hot.ts（发现页热门卡片 / 今日名人 / 随机探索共用） */
const FLAT: Array<{ name: string; domain: DomainCode }> = HOT_PERSONS.map(({ name, domain }) => ({ name, domain }))

export interface PersonPick {
  name: string
  domain: DomainCode
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

/** 打开报告页（personKey 统一出口） */
export function openPerson(pick: PersonPick): void {
  Taro.navigateTo({ url: `/pages/report/index?personKey=${encodeURIComponent(pick.personKey)}` })
}

/** 中央探索按钮：随机打开一位热门名人报告（复用同一热门池） */
export function openRandomPerson(): void {
  openPerson(pickRandomPerson())
}
