import Taro from '@tarojs/taro'
import { publicConfig } from '@/config/public'
import { useAuth } from '@/stores/auth'
import { setAlertOptIn, setSubscribeOptIn } from './auth'
import { diagLog } from './cloud-diagnostics'

/**
 * 关注更新提醒（微信订阅消息）。
 *
 * 微信「一次性订阅」的规则决定了这个功能的产品形态：**授权一次只够推一条**，
 * 推送后授权即消耗，用户想再收到提醒必须再点一次授权。所以：
 *   - 界面上它是「开启一次提醒」而不是一个常亮开关，文案不能承诺持续推送；
 *   - 客户端只做「请求授权 + 落库置位」；
 *   - 真正的发送由云函数 notifyFollowUpdates 在定时任务里检测到新动态时执行，
 *     发完把 subscribe_ok 复位。
 */

/** 模板 ID 是否已配置（未配置时入口只给指引，不发一个必然失败的授权请求） */
export function notifyConfigured(): boolean {
  return Boolean(publicConfig.subscribeTemplateId)
}

/**
 * 请求订阅授权并落库。
 *
 * requestSubscribeMessage 必须由用户点击直接触发（微信要求），因此第一次 await
 * 必须就是它本身——本函数在调用 Taro.requestSubscribeMessage 之前不做任何异步操作，
 * 调用方直接把本函数挂到 onClick 上即可满足该约束。
 */
export async function requestNotify(): Promise<{ ok: boolean; message: string }> {
  if (!useAuth.getState().userId) return { ok: false, message: '请先登录' }
  if (!notifyConfigured()) {
    return { ok: false, message: '提醒功能未配置：请先在小程序后台创建订阅消息模板' }
  }

  const tmplId: string = publicConfig.subscribeTemplateId
  /**
   * Taro 3.6 给 requestSubscribeMessage 的类型定义走的是新版订阅消息（要求 entityIds），
   * 与微信现行的 tmplIds 写法不兼容，断言到实际调用签名。
   */
  const subscribe = Taro.requestSubscribeMessage as unknown as (
    o: { tmplIds: string[] }
  ) => Promise<Record<string, string>>

  let status: string | undefined
  try {
    const res = await subscribe({ tmplIds: [tmplId] })
    status = res[tmplId]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'auth', `订阅授权失败：${msg}`)
    return { ok: false, message: `授权失败：${msg}` }
  }

  if (status !== 'accept') {
    diagLog('info', 'auth', `订阅授权未通过：${status ?? '无返回'}`)
    /* ban = 用户曾在设置里关掉过该模板的提醒，普通拒绝与它要给不同指引 */
    return {
      ok: false,
      message: status === 'ban' ? '提醒已被关闭，请到小程序设置里开启' : '已取消，未开启提醒'
    }
  }

  const saved = await setSubscribeOptIn(true)
  if (!saved) return { ok: false, message: '授权成功但记录失败，请重试' }
  return { ok: true, message: '已开启：关注的人有新动态时会提醒你一次' }
}

/* ── 关键词舆情预警的推送（2026-10-08）──────────────────────────────
   与关注提醒是**两枚模板、两位授权**（原因见 config/public.ts#alertTemplateId）：
   一次性订阅按模板消耗，共用一枚就会出现「一个任务把授权吃掉、另一个必得 43101」。
   除此之外两条链路完全同构：端上只负责授权 + 置位，发送由云函数
   keywordAlert 在定时任务里做，发完复位。 */

/** 预警模板是否已配置（未配置时预警页只做站内预警，不出现授权按钮） */
export function alertNotifyConfigured(): boolean {
  return Boolean(publicConfig.alertTemplateId)
}

/**
 * 请求预警推送授权并落库。
 *
 * 与 requestNotify 一样，第一次 await 必须就是 requestSubscribeMessage 本身
 * （微信要求授权由用户点击直接触发），调用方直接挂到 onClick 上即可。
 */
export async function requestAlertNotify(): Promise<{ ok: boolean; message: string }> {
  if (!useAuth.getState().userId) return { ok: false, message: '请先登录' }
  if (!alertNotifyConfigured()) {
    return { ok: false, message: '预警推送未配置：请先在小程序后台创建订阅消息模板' }
  }

  const tmplId: string = publicConfig.alertTemplateId
  const subscribe = Taro.requestSubscribeMessage as unknown as (
    o: { tmplIds: string[] }
  ) => Promise<Record<string, string>>

  let status: string | undefined
  try {
    const res = await subscribe({ tmplIds: [tmplId] })
    status = res[tmplId]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    diagLog('warn', 'auth', `预警订阅授权失败：${msg}`)
    return { ok: false, message: `授权失败：${msg}` }
  }

  if (status !== 'accept') {
    diagLog('info', 'auth', `预警订阅授权未通过：${status ?? '无返回'}`)
    return {
      ok: false,
      message: status === 'ban' ? '提醒已被关闭，请到小程序设置里开启' : '已取消，未开启提醒'
    }
  }

  const saved = await setAlertOptIn(true)
  if (!saved) return { ok: false, message: '授权成功但记录失败，请重试' }
  return { ok: true, message: '已开启：订阅的关键词有新增报道时提醒你一次' }
}
