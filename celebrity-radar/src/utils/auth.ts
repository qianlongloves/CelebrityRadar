import {
  isCloudConfigured,
  cloudInitErrorMessage,
  uploadToCloud,
  deleteCloudFile
} from './cloud'
import { table } from './db'
import { useAuth } from '@/stores/auth'
import { diagLog } from './cloud-diagnostics'

/** users 集合行。_openid 由云端写入时自动注入，业务上即登录用户标识 userId */
export interface UserRow {
  id: string
  _openid?: string
  nickname: string | null
  avatar_url: string | null
  settings: Record<string, unknown>
  created_at: string
  last_seen_at: string | null
  /**
   * 关注更新提醒的订阅授权（微信一次性订阅：授权一次只够推一条）。
   * 由客户端置 true，云函数 notifyFollowUpdates 成功推送后复位。
   */
  subscribe_ok?: boolean
  subscribe_at?: string | null
  /**
   * 会员权益（买断时长制）：由微信支付回调云函数 `payCallback` 写入，客户端只读。
   * expires_at 未过期即生效（判定见 utils/quota.ts 的 isMembershipActive）。
   * last_order_id 是回调侧的幂等标记（同一订单只发一次货），端上不用。
   */
  membership?: { plan: string; expires_at: string; last_order_id?: string } | null
}

/**
 * 读自己的 users 行。
 * users 集合权限须为「仅创建者可读写」：此时 get() 只返回本人记录，
 * 这也是客户端唯一能取得自己 _openid 的途径（云开发不提供客户端换 openid 的 API）。
 */
export async function readSelf(): Promise<UserRow | null> {
  const { data, error } = await table('users').select('*').limit(1)
  if (error) throw new Error(error.message)
  return (data as UserRow[] | null)?.[0] ?? null
}

/** 登录在途标记：并发去重用（见 ensureLogin） */
let inFlight: Promise<void> | null = null

/**
 * 登录入口：幂等 + 并发去重。
 *
 * 用 userId 而非 ready 短路 —— 原实现 ready 一旦置位就永不重试，
 * 导致登录失败后本次会话内彻底无法恢复（「我的」页重试入口因此形同虚设）。
 *
 * 去重的必要性：app 启动（useLaunch）与「我的」页「点击重试」可能同时进入，
 * 若两处都读到空集合会各插一行 users。users 无唯一键可约束，
 * 重复行会让后续 readSelf 命中哪一条变得不确定。
 */
export function ensureLogin(): Promise<void> {
  if (useAuth.getState().userId) return Promise.resolve()
  if (!inFlight) inFlight = doLogin().finally(() => { inFlight = null })
  return inFlight
}

/**
 * 微信登录 → users 幂等初始化（由 ensureLogin 调用，勿直接调）。
 *
 * 与 WorkBuddy 版的关键差异：不再有 Taro.login + signInWithWechat 换会话，
 * 微信身份由 cloud.database 隐式携带；首次登录（无行）先写占位行再读回 _openid。
 *
 * 失败不抛出：写入 auth store 的 error，由「我的」页展示并提供重试。
 */
async function doLogin(): Promise<void> {
  if (!isCloudConfigured) {
    useAuth.getState().setError(
      cloudInitErrorMessage() ?? '云服务未配置：请在 src/config/public.ts 填写 cloudbaseEnvId'
    )
    return
  }

  try {
    const now = new Date().toISOString()
    let row = await readSelf()

    if (!row) {
      // 首次登录：不指定 _id（由云端生成），_openid 随之自动注入
      const { error } = await table('users').insert({
        nickname: null,
        avatar_url: null,
        settings: {},
        created_at: now,
        last_seen_at: now
      })
      if (error) throw new Error(`users 初始化失败：${error.message}`)
      row = await readSelf()
    }

    if (!row?._openid) {
      throw new Error('无法取得用户标识：请确认 users 集合权限为「仅创建者可读写」')
    }

    // 回写活跃时间；失败不阻断登录（best-effort）
    await table('users').update({ last_seen_at: now }).eq('id', row.id)

    /* avatarUrl 必须一并回填：否则冷启后头像丢失，「我的」页与首页会退回首字占位 */
    useAuth.getState().setLogin({
      userId: row._openid,
      nickname: row.nickname,
      avatarUrl: row.avatar_url
    })
    diagLog('info', 'auth', `登录成功：${row._openid.slice(0, 8)}***`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('error', 'auth', `登录异常：${msg}`)
    useAuth.getState().setError(`登录失败：${msg}`)
  }
}

/** 昵称长度上限（与 <Input maxlength> 保持一致） */
const NICKNAME_MAX = 20

/** 头像云存储路径：带时间戳避免 CDN 命中旧图（历史文件残留可运维清理） */
function avatarCloudPath(userId: string, tempPath: string): string {
  const ext = /\.(png|jpe?g|webp)$/i.exec(tempPath)?.[1]?.toLowerCase() ?? 'png'
  return `avatars/${userId}_${Date.now()}.${ext}`
}

/**
 * 更新本人昵称 / 头像（设计方案隐私清单「微信昵称/头像（可选授权）」的落地）。
 *
 * 微信已收回 wx.getUserProfile，现行合规做法是
 * `button open-type="chooseAvatar"`（头像）+ `<input type="nickname">`（昵称），
 * 二者都必须由用户主动触发 ⇒ 天然满足「可选授权」，不做任何静默索取。
 *
 * 返回结果而非抛出：调用方需按成败给不同 toast。
 */
export async function updateProfile(p: {
  nickname?: string
  /** chooseAvatar 返回的临时路径；仅当传入时才会上传云存储 */
  avatarTempPath?: string
}): Promise<{ ok: boolean; message?: string }> {
  const userId = useAuth.getState().userId
  if (!userId) return { ok: false, message: '登录尚未完成，请稍后重试' }

  try {
    const row = await readSelf()
    if (!row?.id) return { ok: false, message: '未找到用户记录，请点「点击重试」重新登录' }

    const patch: Record<string, unknown> = {}
    /* 昵称 trim 后为空视为「不修改」，避免用户误清空后落一个空串 */
    if (typeof p.nickname === 'string') {
      const nick = p.nickname.trim().slice(0, NICKNAME_MAX)
      if (nick) patch.nickname = nick
    }
    if (p.avatarTempPath) {
      patch.avatar_url = await uploadToCloud(
        avatarCloudPath(userId, p.avatarTempPath),
        p.avatarTempPath
      )
      /* 旧头像顺手删掉：路径含时间戳 ⇒ 不清理会随更换次数无界增长 */
      if (typeof row.avatar_url === 'string' && row.avatar_url.indexOf('cloud://') === 0) {
        void deleteCloudFile(row.avatar_url)
      }
    }
    if (Object.keys(patch).length === 0) return { ok: true }

    const { error } = await table('users').update(patch).eq('id', row.id)
    if (error) throw new Error(error.message)

    useAuth.getState().setLogin({
      userId,
      nickname: (patch.nickname as string | undefined) ?? row.nickname,
      avatarUrl: (patch.avatar_url as string | undefined) ?? row.avatar_url
    })
    diagLog('info', 'auth', `资料已更新：${Object.keys(patch).join(' / ')}`)
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('error', 'auth', `资料更新失败：${msg}`)
    return { ok: false, message: msg }
  }
}

/**
 * 记录关注更新提醒的订阅授权。
 *
 * 放在本文件的原因：users 行的定位方式是「先 readSelf 拿 _id 再 update」
 *（users 的 _id 由云端生成，客户端手上的 userId 是 _openid，不能用作主键），
 * 这套读法只在本模块里有。微信一次性订阅的语义是「授权一次 = 可推一条」，
 * 故此处只置位；复位由云函数在成功推送后执行——客户端无从得知哪条已被消耗。
 */
export async function setSubscribeOptIn(ok: boolean): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  try {
    const row = await readSelf()
    if (!row?.id) return false
    const { error } = await table('users')
      .update({ subscribe_ok: ok, subscribe_at: ok ? new Date().toISOString() : null })
      .eq('id', row.id)
    if (error) throw new Error(error.message)
    diagLog('info', 'auth', `订阅授权标记：${ok ? '已开启' : '已复位'}`)
    return true
  } catch (err) {
    diagLog('error', 'auth', `订阅授权落库失败：${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/**
 * 记录「关键词预警」推送的订阅授权（2026-10-08）。
 *
 * 为什么不复用 setSubscribeOptIn：一次性订阅的授权是**按模板**消耗的，
 * 关注提醒与关键词预警用的是两枚不同的模板（见 config/public.ts#alertTemplateId），
 * 共用一个布尔位会让两个定时任务互相吃掉对方的授权。故这里是独立的一位。
 * 语义与关注提醒一致：端上只置位，复位由云函数推送成功后执行。
 */
export async function setAlertOptIn(ok: boolean): Promise<boolean> {
  const userId = useAuth.getState().userId
  if (!userId) return false
  try {
    const row = await readSelf()
    if (!row?.id) return false
    const { error } = await table('users')
      .update({ alert_ok: ok })
      .eq('id', row.id)
    if (error) throw new Error(error.message)
    diagLog('info', 'auth', `预警订阅授权标记：${ok ? '已开启' : '已复位'}`)
    return true
  } catch (err) {
    diagLog('error', 'auth', `预警订阅授权落库失败：${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}
