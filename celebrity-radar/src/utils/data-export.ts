import Taro from '@tarojs/taro'
import { useAuth } from '@/stores/auth'
import { listFollows } from './follows'
import { listFavorites } from './favorites'
import { listHistory } from './history'
import { listWatches } from './keyword-alert'
import { toUserMessage } from './error'
import { getPreferredProvider, getPreferredTier } from './settings'

/**
 * 个人信息副本导出（PIPL 第 45 条「查阅、复制」）。
 *
 * 「查阅」在页面里已经有了（关注 / 收藏 / 历史 / 预警各自成页），但第 45 条还给到
 * 「复制」：用户应当能把属于自己的那份数据**带走**，而不是只能一页一页截图。
 * 本模块把散在各页的数据拢成一份 JSON，由「我的 → 系统设置 → 导出个人数据」复制到剪贴板。
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
  /** 副本说明（中文自解释，随 JSON 一起粘贴 / 存档，让用户知道这是什么、依据什么、如何行使权利） */
  meta: {
    title: string
    basis: string
    scope: string
    rights: string
  }
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
    meta: {
      title: '名人雷达 · 个人数据副本',
      basis: '依据《中华人民共和国个人信息保护法》第 45 条（查阅、复制权）导出',
      scope: '仅含你本人的数据，不含他人信息与全局缓存内容',
      rights:
        '删除：我的 → 系统设置 → 清空数据；撤回同意：我的 → 撤回同意；注销：我的 → 系统设置 → 注销账号'
    },
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
 * 从 Taro 拒绝的未知值里尽量取出可读文案。
 *
 * 微信 / Taro 失败时 reject 的往往不是 `Error` 实例，而是普通对象 `{ errMsg, errno }`
 * （与 db.ts#normalizeDbError 踩过的同一个坑）。原先用 `err instanceof Error ? err.message :
 * String(err)` 会把那种对象拍成 `[object Object]`，弹窗只剩一句没头没尾的「复制到剪贴板失败」，
 * 唯一能指明修法的 errMsg 全被丢掉 —— 这里先取 errMsg / message，取不到再退回 String。
 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const e = err as { errMsg?: unknown; message?: unknown }
    if (typeof e.errMsg === 'string' && e.errMsg) return e.errMsg
    if (typeof e.message === 'string' && e.message) return e.message
  }
  return String(err)
}

/**
 * 判断是否是「隐私未授权」类平台错误。
 *
 * 微信隐私校验（app.config.ts 的 `__usePrivacyCheck__`）开启后，若微信公众平台后台
 * 「用户隐私保护指引」尚未配置 / 未声明对应接口，平台会拒绝调用，errMsg 形如
 * `...:fail please go to mp open official popup or use wx.onNeedPrivacyAuthorization`
 * 或 `...:fail api scope is not declared in the privacy agreement`。
 * 这类错不是端上能兜住的（得去后台配指引），命中时换成一句能照着做的话，而不是甩一屏原始英文。
 */
function isPrivacyNotAuthorized(err: unknown): boolean {
  return /privacy|scope|declared|please go to mp|official popup|needprivacy/i.test(errText(err))
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
    /* 原始异常只进日志：`读取个人数据失败：{errMsg: …}` 这种原文对用户没有意义 */
    return { ok: false, message: toUserMessage(err, '读取个人数据失败，请稍后重试') }
  }
  if (!bundle) return { ok: false, message: '登录后才能导出，请稍后重试' }

  try {
    await Taro.setClipboardData({ data: JSON.stringify(bundle, null, 2) })
    /* setClipboardData 自带一个「内容已复制」toast，调用方可直接用 modal 给出下一步指引 */
    return {
      ok: true,
      message: `已复制「个人数据副本」（JSON，共 ${countBundleItems(bundle)} 条记录，含说明头）。可粘贴到备忘录或聊天中保存；如需删除这些数据，可在「我的」页操作。`
    }
  } catch (err) {
    if (isPrivacyNotAuthorized(err)) {
      return {
        ok: false,
        message:
          '复制到剪贴板失败：剪贴板属平台隐私接口，请先在微信公众平台后台「设置 → 服务内容声明 → 用户隐私保护指引」配置并勾选「剪贴板」后重试。'
      }
    }
    /*
     * 非隐私类的复制失败**照实带回原因**（`mock: clipboard denied` 这类）：
     * 这是「我要把自己的数据带走」的诉求，报错了却只说「请稍后重试」等于让用户一次次白发一次请求，
     * 原始原因至少能让开发者一眼认出是真机权限还是平台拒绝（test/cases/42-data-export.js 钉住这条）。
     * 唯一例外是隐私未授权（上面那个分支）：那种英文指引用户照着做也没用，换成可操作的路径。
     */
    return { ok: false, message: `复制到剪贴板失败：${errText(err)}` }
  }
}
