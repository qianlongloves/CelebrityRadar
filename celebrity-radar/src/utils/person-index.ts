import Taro from '@tarojs/taro'
import { table } from './db'
import { buildPersonKey } from '@/config/domains'
import { diagLog } from './cloud-diagnostics'
import type { ReportCacheRow } from '@/types/db'

/**
 * 人物索引：名字 → 最新 personKey 的**读取侧归一**（Task A，2026-10-12）。
 *
 * 背景：`report_cache` 的主键是「名字#领域」，而领域由各入口自己决定 —— 迁移到自由领域后，
 * 同一个人很容易被不同入口写成两行（实测「雷军#tech」与「雷军#auto」并存）。后果是同一条根因：
 * 热榜与名人主页命中的缓存不一致、主页按自己的 personKey 查不到最新那份（动态/名言随之空）、
 * 头像也会存到两个 key 上。领域自由化后变体只会更多。
 *
 * 本文件在**不改云端接口、不改缓存契约**的前提下，只做一个「按名字回退」的索引：
 * 若某个名字已经有缓存报告，就把这份的 personKey 记住，此后凡按名字找人都用它。
 *
 * 判定顺序（`resolvePersonKey`，一旦命中就不再查库）：
 *   ① 内存索引（最快，热路径）；
 *   ② storage 索引（键前缀 `pidx:`，冷启免一次云查询，best-effort）；
 *   ③ 一次 `report_cache` 查询（`report.name` 精确匹配 + state='ready'，取 generated_at 最新的一条），
 *      命中即记住并返回它的 _id；
 *   ④ 都没有 → 返回调用方给的「名字#领域」（即原行为，回退零副作用）。
 *
 * 三条硬约束，与 utils/portrait.ts 同一套哲学：
 *   · **端上零阻塞**：任何失败都退回入参 key，绝不抛错、绝不让页面变慢（命中后不再查库）；
 *   · **并发去重**：同一名字的并发查询共用一个 promise，避免一次列表渲染打出一串重复查询；
 *   · **只读兜底**：这是存量分叉的回退路径，不新增写入、不碰计费与会员剥离口径。
 */

/** storage 键前缀：与用户数据、真图缓存（portrait:）分开，便于清理与排查 */
const STORAGE_PREFIX = 'pidx:'

/** 内存索引：name → personKey（本会话内最快的一层） */
const memo = new Map<string, string>()

/** 在途查询：同一名字的并发 resolve 共用一个 promise（见文件头约束②） */
const inflight = new Map<string, Promise<string>>()

/** 读 storage 索引；storage 不可用（H5 / 受限环境）时静默返回空串 */
function readStored(name: string): string {
  try {
    const v = Taro.getStorageSync(STORAGE_PREFIX + name)
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/**
 * 记住「这个名字最新那份报告的 personKey」。
 *
 * 生成成功（报告落库那条路径）、以及回退查询命中时调用。写 storage 是 best-effort：
 * 写失败只是丢掉一次「冷启免查询」的优化，不影响本次结果，故整段包 try。
 */
export function rememberPerson(name: string, personKey: string): void {
  if (!name || !personKey) return
  if (memo.get(name) === personKey) return
  memo.set(name, personKey)
  try {
    Taro.setStorageSync(STORAGE_PREFIX + name, personKey)
  } catch {
    /* 忽略：内存索引已生效，storage 失败不影响本次会话 */
  }
}

/**
 * 解析「这个名字当前应该用的 personKey」。
 *
 * @param name   人名（已净化，不含 #）
 * @param domain 各入口自己给出的领域码 —— 仅在**没有任何缓存报告**时作为兜底
 *
 * 返回的 key 一定可用：或在 `report_cache` 里有 ready 报告，或就是 `buildPersonKey(name, domain)`。
 */
export async function resolvePersonKey(name: string, domain: string): Promise<string> {
  const fallback = buildPersonKey(name, domain)
  if (!name) return fallback

  /* ① 内存索引 */
  const memoed = memo.get(name)
  if (memoed) return memoed

  /* ② storage 索引 */
  const stored = readStored(name)
  if (stored) {
    memo.set(name, stored)
    return stored
  }

  /* ③ 在途查询去重 */
  const pending = inflight.get(name)
  if (pending) return pending

  const task = (async (): Promise<string> => {
    try {
      /*
       * 只取主键：这里做的是「名字 → personKey」的解析，正文一个字都用不到。
       * `select('*')` 每次都会把整份报告（18 节，含会员段）拉下来再扔掉 —— 一次名字回退
       * 就要拖几十 KB，而这条路径恰恰是「用户刚输入一个新名字」时最常走的那条。
       */
      const { data, error } = await table('report_cache')
        .select('id')
        .eq('report.name', name)
        .eq('state', 'ready')
        .order('generated_at', { ascending: false })
        .limit(1)
      if (error) {
        diagLog('warn', 'db', `person-index 回退查询失败：${error.message ?? error}`)
        return fallback
      }
      /* fetchAll 已按 generated_at 倒序，第一条即最新那一份 */
      const row = (data as ReportCacheRow[] | null)?.[0]
      if (row?.id) {
        rememberPerson(name, row.id)
        return row.id
      }
      return fallback
    } catch (err) {
      /* ④ 任何异常都退回入参 key（端上零阻塞，见文件头） */
      diagLog('warn', 'db', `person-index 回退异常：${err instanceof Error ? err.message : String(err)}`)
      return fallback
    } finally {
      inflight.delete(name)
    }
  })()

  inflight.set(name, task)
  return task
}
