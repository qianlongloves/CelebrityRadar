import Taro from '@tarojs/taro'
import { useAuth } from '@/stores/auth'
import { listFollows } from './follows'
import { listFavorites } from './favorites'
import { listHistory } from './history'
import { listWatches } from './keyword-alert'
import { getPreferredProvider, getPreferredTier } from './settings'

/**
 * 个人信息副本导出（PIPL 第 45 条「查阅、复制」）。
 *
 * 「查阅」在页面里已经有了（关注 / 收藏 / 历史 / 预警各自成页），但第 45 条还给到
 * 「复制」：用户应当能把属于自己的那份数据**带走**，而不是只能一页一页截图。
 * 本模块把散在各页的数据拢成一份 JSON，由「我的 → 导出我的数据」复制到剪贴板。
 *
 * 四条口径：
 *   · **只导出本人数据**：这几个 list 口本来就按 openid 过滤（对应集合权限亦为「仅创建者可读写」）；
 *   · **不导出他人 / 全局数据**：报告与热门榜是全局共享缓存、不属于任何人的个人信息，一律不进副本；
 *   · **不导出凭据**：本机没有 token / key 之类需要保护的东西（端上不持凭据），无可导出；
 *   · **只读**：本模块不发任何写请求、不产生埋点；失败只把原因交回调用方。
 *
 * 刻意不做「保存成文件」：小程序沙箱里要 saveFile + openDocument 两步，用户还得再去找文件；
 * 剪贴板在微信里可以直接粘进备忘录 / 聊天，零权限、零心智负担，够用。
 */

/** 导出结构刻意保持扁平可读（用户可能直接看 JSON 原文），字段名与业务名一致 */
export interface MyDataBundle {
  /** 导出的时刻（ISO） */
  exported_at: string
  /** 账号信息（openid 是你在本小程序的唯一标识，属你本人数据，故一并给到） */
  account: {
    user_id: string
    nickname: string | null
  }
  /** 偏好设置（与云端 users.settings 两项同源） */
  settings: {
    llm_provider: string | null
    llm_tier: string | null
  }
  follows: Array<{ name: string; person_key: string; domain: string; followed_at: string }>
  favorites: Array<{
    name: string
    type: string
    person_key: string
    created_at: string
    payload: Record<string, unknown>
  }>
  history: Array<{ name: string; person_key: string; ts: string }>
  /** 关键词订阅 + 名人监控（同住 keyword_watches，靠 type 区分） */
  watches: Array<{ label: string; type: string; person_key: string | null; created_at: string }>
}

/** 导出的条目总数（用于给用户一句「共 N 条」的话术；不含账号与偏好两段） */
export function countBundleItems(b: MyDataBundle): number {
  return b.follows.length + b.favorites.length + b.history.length + b.watches.length
}

/**
 * 拉取本人全部个人信息，拼成待导出对象。
 *
 * 未登录返回 `null`（调用方据此提示「登录后可用」）—— 未登录时这几个 list 口
 * 一律返回空数组，静默导出会得到一份「看起来像没有数据」的假副本，比报错更误导。
 */
export async function buildMyDataBundle(): Promise<MyDataBundle | null> {
  const { userId, nickname } = useAuth.getState()
  if (!userId) return null

  const [follows, favorites, history, watches] = await Promise.all([
    listFollows(),
    listFavorites(),
    listHistory(),
    listWatches()
  ])

  return {
    exported_at: new Date().toISOString(),
    account: { user_id: userId, nickname: nickname ?? null },
    settings: { llm_provider: getPreferredProvider(), llm_tier: getPreferredTier() },
    follows: follows.map((r) => ({
      name: r.name,
      person_key: r.person_key,
      domain: r.domain,
      followed_at: r.followed_at
    })),
    favorites: favorites.map((r) => ({
      name: r.name,
      type: r.type,
      person_key: r.person_key,
      created_at: r.created_at,
      payload: r.payload
    })),
    history: history.map((r) => ({ name: r.name, person_key: r.person_key, ts: r.ts })),
    watches: watches.map((r) => ({
      label: r.keyword,
      /* 老数据没有 type 字段，按 keyword 口径归一（与 splitWatches 一致） */
      type: r.type ?? 'keyword',
      person_key: r.person_key ?? null,
      created_at: r.created_at
    }))
  }
}

/**
 * 导出并复制到剪贴板。返回给调用方一句可直接展示的话术。
 *
 * 缩进 2 空格而不是压成一行：用户多半会把这份 JSON 存进备忘录，可读性值这几十个字节。
 */
export async function exportMyDataToClipboard(): Promise<{ ok: boolean; message: string }> {
  let bundle: MyDataBundle | null
  try {
    bundle = await buildMyDataBundle()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `读取个人数据失败：${msg}` }
  }
  if (!bundle) return { ok: false, message: '登录后才能导出，请稍后重试' }

  try {
    await Taro.setClipboardData({ data: JSON.stringify(bundle, null, 2) })
    /* setClipboardData 自带一个「内容已复制」toast，调用方可直接用 modal 给出下一步指引 */
    return {
      ok: true,
      message: `你的个人信息副本（JSON，共 ${countBundleItems(bundle)} 条）已复制到剪贴板，可粘贴到备忘录或聊天中保存。`
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `复制到剪贴板失败：${msg}` }
  }
}
