import { publicConfig } from '@/config/public'
import { diagLog } from './cloud-diagnostics'

/**
 * 云服务是否已配置（cloudbaseEnvId 仍是占位值时为 false）。
 * 未配置时登录与全部 DB 调用不会发起，相关页面应给出明确提示而不是静默报错。
 */
export const isCloudConfigured = !publicConfig.cloudbaseEnvId.includes('REPLACE_ME')

let cloudInitError: string | null = null
let inited = false

/**
 * 懒初始化 wx.cloud（不在模块加载期做）：
 * 一是 H5 端不存在 wx 全局对象，二是未配置时不该阻断 app 启动导致白屏。
 * 初始化问题只记录 cloudInitError，由 getDatabase() 在真正调用时抛可读错误。
 */
function ensureInit(): void {
  if (inited) return
  inited = true

  if (typeof wx === 'undefined') {
    cloudInitError = '当前环境无 wx 全局对象（云开发仅微信小程序端可用）'
    return
  }
  if (!wx.cloud) {
    cloudInitError = '当前基础库不支持云开发（需 ≥ 2.2.3），或未在开发者工具中开通「云开发」'
    return
  }
  if (!isCloudConfigured) {
    cloudInitError =
      'CloudBase 环境 ID 未配置：请填写 src/config/public.ts 的 cloudbaseEnvId 后重新编译'
    return
  }
  try {
    wx.cloud.init({ env: publicConfig.cloudbaseEnvId, traceUser: true })
    diagLog('info', 'db', `CloudBase 初始化完成：env=${publicConfig.cloudbaseEnvId}`)
  } catch (err) {
    cloudInitError = `wx.cloud.init 失败：${err instanceof Error ? err.message : String(err)}`
    diagLog('error', 'db', cloudInitError)
  }
}

/** 取数据库实例（未配置/不支持时抛可读错误） */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export function getDatabase(): any {
  ensureInit()
  if (cloudInitError) throw new Error(`云服务不可用：${cloudInitError}`)
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return (wx as any).cloud.database()
}

/** 诊断：配置/初始化异常信息（「我的」页登录失败提示用） */
export function cloudInitErrorMessage(): string | null {
  ensureInit()
  return cloudInitError
}

/**
 * 上传本地文件到云存储，返回可长期使用的 fileID。
 *
 * 头像必须走这一步：chooseAvatar 给出的是 `wxfile://…` **临时路径**，
 * 进程重启即失效，直接落库会在下次冷启变成裂图；fileID 则可直接喂给 <Image src>。
 */
export async function uploadToCloud(cloudPath: string, filePath: string): Promise<string> {
  ensureInit()
  if (cloudInitError) throw new Error(`云服务不可用：${cloudInitError}`)
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const res = await (wx as any).cloud.uploadFile({ cloudPath, filePath })
  const fileID: unknown = res?.fileID
  if (typeof fileID !== 'string' || !fileID) throw new Error('云存储未返回 fileID')
  return fileID
}

/** 删除云存储文件（best-effort：失败只记诊断日志，绝不影响主流程） */
export async function deleteCloudFile(fileID: string): Promise<void> {
  try {
    ensureInit()
    if (cloudInitError) return
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    await (wx as any).cloud.deleteFile({ fileList: [fileID] })
  } catch (err) {
    diagLog('warn', 'db', `云文件删除失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 调用云函数，返回其 result 字段。
 *
 * 用途：平台代付通道 —— key 留在云函数环境变量里，客户端只发业务参数，
 * 这是「小程序包可解包」前提下平台 key 不外泄的唯一实现方式。
 * 函数未部署时 wx 会抛错（含 FunctionName / -501000），由调用方转成可读提示。
 */
export async function callCloudFunction(name: string, data: unknown): Promise<unknown> {
  ensureInit()
  if (cloudInitError) throw new Error(`云服务不可用：${cloudInitError}`)
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const res = await (wx as any).cloud.callFunction({ name, data })
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return (res as any)?.result
}

/**
 * 识别「云函数执行超时被平台掐断」，是则返回一句可照做的指引，否则返回 null。
 *
 * 为什么要单列这一类：云函数超时是**平台在函数进程之外**杀的，函数自身没有任何机会
 * 返回结构化错误 —— aiProxy 里那些 kind / error 一个都传不回来，端上只能拿到
 * errCode -504003（FUNCTIONS_TIME_LIMIT_EXCEEDED）。这与「上游报错」「网络抖动」是两回事：
 * 重试必然再撞同一道墙，只会让用户白等一个超时周期。
 *
 * 两个阶段要靠一句话分清（2026-10-11 起）：
 *   · 超时时间还是默认的 20 秒 → 去控制台改成 60 秒，这一步照旧；
 *   · 已经是 60 秒还报这个错 → **没有更大的数可调了**（60 秒是微信云函数的上限）。
 *     此时真正的原因是「这一趟活儿本身超过了 60 秒」—— 最可能是高级档的推理槽模型在单次
 *     调用里思考太久。给用户的路只有一条：换基础版（或非推理模型）再试。指错方向会让他在
 *     控制台里反复折腾一个已经顶格的配置，所以这句提示必须把两条路分开说。
 * 排查口径见 `../../../README.md` §4.4「云开发 AI 通道与「函数超时改 60s」」一节。
 */
export function cloudTimeoutHint(msg: string): string | null {
  if (!/-504003|FUNCTIONS_TIME_LIMIT_EXCEEDED|Invoking task timed out/i.test(msg)) return null
  return (
    '云端执行超时：云函数 aiProxy 被平台掐断（60 秒是微信云函数的上限，调不上去）。' +
    '若控制台里它还是默认的 20 秒，请到 云开发控制台 → 云函数 → aiProxy → 配置 → 超时时间 ' +
    '改为 60 秒并保存后重试；若已经是 60 秒，说明这一趟本身太慢，请改用「基础版」或切到非推理模型后重试' +
    '（高级档推理槽会先长时间思考，最容易撞上这一道）'
  )
}
