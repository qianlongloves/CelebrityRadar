import Taro from '@tarojs/taro'
import { cloud, isCloudConfigured } from './cloud'
import { useAuth } from '@/stores/auth'
import { diagLog } from './workbuddy-cloud-diagnostics'

/** users 表行（§3.8，PostgREST 语义下主键列名为 id） */
export interface UserRow {
  id: string
  nickname: string | null
  avatar_url: string | null
  settings: { knowledgeMode: boolean }
  created_at: string
  last_seen_at: string | null
}

/**
 * 微信登录 + users 初始化（阶段 2 #3 / #8）：
 * Taro.login 取 code → cloud.auth.signInWithWechat(code, appid) 换 session
 * → upsert users 行（幂等，登录即初始化）。
 * 失败不抛出：写入 auth store 的 error，由「我的」页展示。
 */
export async function ensureLogin(): Promise<void> {
  const store = useAuth.getState()
  if (store.ready) return

  if (!isCloudConfigured) {
    store.setError('云服务未配置：请在 src/config/public.ts 填入 endpoint 与 publishableKey')
    return
  }

  try {
    const { code } = await Taro.login()
    const appid = Taro.getAccountInfoSync().miniProgram.appId
    const { data: session, error } = await cloud.auth.signInWithWechat(code, appid)
    if (error || !session) {
      diagLog('error', 'auth', `signInWithWechat 失败：${error?.message ?? '无会话'}`, {
        kind: error?.kind
      })
      store.setError(`登录失败：${error?.message ?? '未知错误'}`)
      return
    }

    const userId = session.user.id // 'wx:' + openid
    const now = new Date().toISOString()

    // users 幂等初始化：写失败不阻断登录（表未建/RLS 由 G2 联调暴露）
    // 注：SDK 的 Database 泛型默认 unknown，from() 退化为 never[]；
    // 阶段 4 会统一定义 DB Schema 类型并消除该断言
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const usersTable: any = (cloud.database.from as (t: string) => any)('users')
    const { error: dbError } = await usersTable.upsert(
      {
        id: userId,
        nickname: null,
        avatar_url: null,
        settings: { knowledgeMode: false },
        created_at: now,
        last_seen_at: now
      },
      { onConflict: 'id' }
    )
    if (dbError) {
      diagLog('warn', 'db', `users upsert 失败（不阻断登录）：${dbError.message}`)
    }

    const raw = session.user as { nickname?: string; avatar_url?: string } | Record<string, unknown>
    const nickname = typeof raw === 'object' && raw !== null && 'nickname' in raw
      ? String((raw as Record<string, unknown>).nickname ?? '') || null
      : null

    useAuth.getState().setLogin({ userId, nickname })
    diagLog('info', 'auth', `登录成功：${userId.slice(0, 8)}***`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('error', 'auth', `登录异常：${msg}`)
    useAuth.getState().setError(`登录异常：${msg}`)
  }
}
