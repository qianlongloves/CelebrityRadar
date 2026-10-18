import type { FollowRow } from './follows'
import { getCachedReport, getFeedDetail } from './cache'

/**
 * 关注对象的「变化概览」。
 *
 * 解决的痛点：关注列表原先只显示「名字 + 关注于 X 天前」，是一份纯静态名单 ——
 * 用户想知道谁有动静只能逐个点进主页，于是「关注」这个动作本身不产生回访理由。
 *
 * 数据全部来自 report_cache / feed_cache（两张表都是所有用户可读），
 * 因此**不需要新增云函数、也不需要新增字段**。
 */

/**
 * 与用户无关的部分：同一个人对所有关注者都一样，可跨用户复用（见 memo）。
 *
 * `newsCount` 为 `null` = **这一次没读到**（2026-10-18，P2）。原实现直接在读失败时写 0，
 * 页面于是把一次云库抖动渲染成「暂无动态」—— 用户以为这个人最近很安静，
 * 而真相是数据没取到。`null` 让页面能说「动态暂不可读」，而不是编一个 0。
 */
interface PersonFacts {
  heat: number | null
  reportAt: string | null
  newsCount: number | null
  feedAt: string | null
}

export interface FollowWatch extends PersonFacts {
  /** 关注之后有新内容（报告重生 或 重新抓到动态） */
  hasNew: boolean
}

/** 单批并发数：一个人物要读 2 次（报告 + 动态），全量并发会打爆小程序端连接池 */
const BATCH = 5
/** 只取前 N 位关注对象做变化探测，避免关注数过大时请求量无界增长（页面上有说明） */
export const WATCH_LIMIT = 30
/** 内存缓存 TTL：切页返回会重复触发加载，天级更新频率下没必要一小时打几十次云 */
const TTL_MS = 60 * 1000

const memo = new Map<string, { at: number; facts: PersonFacts }>()

async function factsOf(personKey: string): Promise<PersonFacts> {
  /* 两个请求互不依赖，并行发出；任一失败都退化成「该项无数据」，不拖垮整行人 */
  const [report, feed] = await Promise.all([getCachedReport(personKey), getFeedDetail(personKey)])
  return {
    heat: report ? report.heat : null,
    reportAt: report ? report.generatedAt : null,
    /* 读失败写 null 而不是 0：0 会被页面说成「暂无动态」（见 PersonFacts） */
    newsCount: feed.ok ? feed.items.length : null,
    feedAt: feed.ok ? feed.fetchedAt : null
  }
}

/** 关注之后是否被更新过；followed_at 是天然基线，不新增字段就能表达「未读」 */
function newerThan(iso: string | null, baseMs: number): boolean {
  if (!iso || Number.isNaN(baseMs)) return false
  return Date.parse(iso) > baseMs
}

/**
 * 批量读取关注对象的变化概览。
 *
 * 为什么不做一次 in 查询：每个 personKey 在两张缓存表里都是一行独立文档，
 * 云 DB 只能按 _id 逐行取，2N 个请求无法合并；这里用分批并发把耗时压在
 * 「批数 × 单次往返」，而不是 N × 2 次串行相加。
 *
 * @param force 下拉刷新时置 true，跳过内存缓存强制重读
 */
export async function loadFollowWatches(
  rows: FollowRow[],
  opts: { force?: boolean } = {}
): Promise<Record<string, FollowWatch>> {
  const targets = rows.slice(0, WATCH_LIMIT)
  const facts: Record<string, PersonFacts> = {}
  const pending: FollowRow[] = []

  for (const r of targets) {
    const hit = memo.get(r.person_key)
    if (!opts.force && hit && Date.now() - hit.at < TTL_MS) facts[r.person_key] = hit.facts
    else pending.push(r)
  }

  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH)
    const settled = await Promise.all(
      slice.map((r) => factsOf(r.person_key).catch(() => null))
    )
    settled.forEach((f, idx) => {
      if (!f) return
      const key = slice[idx].person_key
      /* 读到一半失败（newsCount === null）不写内存缓存：否则这次抖动会被锁 60 秒，
         切页回来还是同一份残缺结果，看起来像「一直读不到」 */
      if (f.newsCount !== null) memo.set(key, { at: Date.now(), facts: f })
      facts[key] = f
    })
  }

  const out: Record<string, FollowWatch> = {}
  for (const r of targets) {
    const f = facts[r.person_key]
    if (!f) continue
    const baseMs = Date.parse(r.followed_at)
    out[r.person_key] = {
      ...f,
      hasNew: newerThan(f.reportAt, baseMs) || newerThan(f.feedAt, baseMs)
    }
  }
  return out
}
