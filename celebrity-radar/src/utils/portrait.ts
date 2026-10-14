import Taro from '@tarojs/taro'
import { table } from './db'
import { callCloudFunction } from './cloud'
import { parsePersonKey, domainLabel } from '@/config/domains'
import { diagLog } from './cloud-diagnostics'

/**
 * 名人真图头像（§头像）。全项目此前一律用「领域色渐变 + 姓名首字」占位，
 * 这里补上真图：云端 aiProxy 的 portrait 动作会从博查抓照片、下载、传云存储并缓存
 * （见 cloudfunctions/aiProxy/index.js 顶部注释），端上拿到的只是 `cloud://…` fileID。
 *
 * 三条硬约束决定了本文件的形状：
 *  1. **端上零阻塞**：取图无论多慢/失败，都只回落今天的占位 —— 页面不得变慢或报错，
 *     故所有导出函数一律不抛（失败返回空串）。
 *  2. **一次批量读胜过多行云调用**：列表页一屏可能十几个人，逐人调云函数就是十几次往返；
 *     故 `readPortraits` 用一次 `in` 查询预热内存缓存，组件随后同步命中。
 *  3. **fileID 而非远端 URL**：云存储 fileID 不受 downloadFile 合法域名限制，
 *     这是不走远端 https 图的原因（见 aiProxy 头部注释）。
 */

/** 内存缓存：personKey → 云存储 fileID。命中即画真图，未命中/空串回落「领域色 + 首字」 */
const cache = new Map<string, string>()

/** storage 键前缀。加前缀是为了遍历/清理时能与其它键区分开，不与用户数据混在一起 */
const STORAGE_PREFIX = 'portrait:'

/**
 * 在途请求：同一 personKey 的并发调用共用同一个 promise。
 * 没有它，列表里同一个人被多处引用（如报告页横幅 + 延伸阅读）会同时打两次云函数。
 */
const inflight = new Map<string, Promise<string>>()

/** 订阅者：真图晚到时用它通知已挂载的组件重绘（一个极小的发布订阅，不为这个引状态库） */
const listeners = new Set<(personKey: string) => void>()

/** 读内存缓存（同步）。组件首帧就靠它决定画真图还是回退占位 —— 异步读会让首帧闪一下占位再跳图 */
export function getPortraitCache(): Map<string, string> {
  return cache
}

/** 订阅真图更新；返回退订函数。组件卸载必须退订，否则列表反复进出会堆积回调 */
export function subscribePortrait(listener: (personKey: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 通知订阅者。单个订阅者出错不该影响其它订阅者，故逐个 try */
function emit(personKey: string): void {
  for (const listener of listeners) {
    try {
      listener(personKey)
    } catch {
      /* 忽略：订阅回调属于渲染层，出错不应打断取图流程 */
    }
  }
}

/**
 * 落缓存（内存 + storage）并通知。
 *
 * storage 是 best-effort：写失败只是丢一次「冷启免云调用」的优化，不影响本次展示，
 * 故整段包 try —— 在存储写满 / H5 环境无 storage 时不能让取图主流程挂掉。
 */
function remember(personKey: string, fileId: string): void {
  if (cache.get(personKey) === fileId) return
  cache.set(personKey, fileId)
  try {
    Taro.setStorageSync(STORAGE_PREFIX + personKey, fileId)
  } catch {
    /* 忽略：存储失败不影响内存缓存，本次展示照常 */
  }
  emit(personKey)
}

/**
 * 模块加载即预热内存缓存（不花云调用）。
 *
 * 真图一旦取到就写进 storage，冷启时从这里读回来 —— 否则每次冷启都要为同一批人重跑一遍
 * 云函数，白白多等一次往返。storage 不可用（H5 / 受限环境）时静默跳过，纯内存照常工作。
 */
function primeFromStorage(): void {
  try {
    const keys = Taro.getStorageInfoSync?.()?.keys ?? []
    for (const key of keys) {
      if (!key.startsWith(STORAGE_PREFIX)) continue
      const value = Taro.getStorageSync(key)
      if (typeof value === 'string' && value) cache.set(key.slice(STORAGE_PREFIX.length), value)
    }
  } catch {
    /* 忽略：storage 不可用并不影响真图功能，只是每次冷启都要多一次云调用 */
  }
}
primeFromStorage()

/** `person_assets` 行（客户端只读；_id = personKey，见云端约定） */
interface PersonAssetRow {
  id: string
  person_key?: string
  name?: string
  avatar_file_id?: string
}

/**
 * 批量读真图：一次 `in` 取回多人的头像 fileID，只返回**确有 avatar_file_id** 的人。
 *
 * 命中结果同时写入内存缓存（列表页据此一次预热全部行，避免每行一次云调用）；
 * 已在缓存里的人不再参与本次查询。读失败退化为「只在已知缓存里返回」，绝不抛错。
 */
export async function readPortraits(personKeys: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const keys = Array.from(new Set(personKeys.filter(Boolean)))

  /* 已知的直接进结果：批量读只补未知的，命中已缓存的人不必再花一次往返 */
  const missing: string[] = []
  for (const key of keys) {
    const hit = cache.get(key)
    if (hit) result.set(key, hit)
    else missing.push(key)
  }
  if (missing.length === 0) return result

  const { data, error } = await table('person_assets').select('*').in('id', missing)
  if (error) {
    diagLog('warn', 'db', `person_assets 批量读取失败：${error.message}`)
    return result
  }

  const found = new Set<string>()
  for (const row of (data as PersonAssetRow[] | null) ?? []) {
    const key = row.person_key || row.id
    const fileId = row.avatar_file_id
    if (!key || typeof fileId !== 'string' || !fileId) continue
    remember(key, fileId)
    result.set(key, fileId)
    found.add(key)
  }

  /*
   * 名字回退（Task A，2026-10-12）：`person_assets` 同样以 personKey 为主键，
   * 而 personKey 会因同一人被不同入口写成两个领域而分叉 —— 此时按 id 精确查必然落空。
   * 对仍未命中的 key，改用「名字」再查一次：命中即按**请求方的 key** 记进缓存（组件用的正是它），
   * 头像因此不再因 key 分叉而缺失，也避免组件随后 ensurePortrait 在旧 key 上再写出一行新头像。
   * 本次只读、失败静默；取图本就在渲染之外（fire-and-forget），不阻塞页面。
   */
  const stillMissing = missing.filter((k) => !found.has(k))
  if (stillMissing.length > 0) {
    const requestedKeyByName = new Map<string, string>()
    const names: string[] = []
    for (const k of stillMissing) {
      const name = parsePersonKey(k)?.name
      if (!name || requestedKeyByName.has(name)) continue
      requestedKeyByName.set(name, k)
      names.push(name)
    }
    if (names.length > 0) {
      const byName = await table('person_assets').select('*').in('name', names)
      if (byName.error) {
        diagLog('warn', 'db', `person_assets 按名字回退失败：${byName.error.message}`)
      } else {
        for (const row of (byName.data as PersonAssetRow[] | null) ?? []) {
          const fileId = row.avatar_file_id
          const requested = row.name ? requestedKeyByName.get(row.name) : undefined
          if (!requested || typeof fileId !== 'string' || !fileId) continue
          remember(requested, fileId)
          result.set(requested, fileId)
        }
      }
    }
  }
  return result
}

/**
 * 确保某人真图已取到：命中缓存立即返回，否则调云端 portrait 动作补一次。
 *
 * 去重（in-flight）避免同一人并发重复取图；成功写内存 + storage（冷启免二次云调用）；
 * 失败或 `!ok` 一律返回空串，**绝不抛** —— 端上任何取图失败都必须能静默回退占位。
 */
export async function ensurePortrait(personKey: string, name: string): Promise<string> {
  if (!personKey) return ''

  const known = cache.get(personKey)
  if (known) return known

  const pending = inflight.get(personKey)
  if (pending) return pending

  const task = (async (): Promise<string> => {
    try {
      /* 把领域中文标签一并给云端：同名不同人（张三#文娱 vs 张三#科技）若只按名字查图，
         会拿到同一批图、选出同一张 —— 带上领域，两个同名者各查到各行业的照片。 */
      const domain = parsePersonKey(personKey)?.domain || ''
      const domainZh = domain ? domainLabel(domain) : ''
      const domainQuery = domainZh && domainZh !== '其他' ? domainZh : ''
      const res = await callCloudFunction('aiProxy', {
        action: 'portrait',
        personKey,
        name,
        domain: domainQuery
      })
      const r = res as { ok?: boolean; fileId?: string } | null
      if (r && r.ok === true && typeof r.fileId === 'string' && r.fileId) {
        remember(personKey, r.fileId)
        return r.fileId
      }
      return ''
    } catch {
      /* 取图失败一律静默：回退今天的占位即可，绝不能因为一张头像把页面拖慢或抛错 */
      return ''
    } finally {
      inflight.delete(personKey)
    }
  })()

  inflight.set(personKey, task)
  return task
}
