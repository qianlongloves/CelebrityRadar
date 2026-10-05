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
