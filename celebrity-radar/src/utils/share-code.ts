import Taro from '@tarojs/taro'
import { diagLog } from './cloud-diagnostics'
import { callCloudFunction, getTempFileUrl } from './cloud'

/**
 * 分享图上的**小程序码**（获客，2026-10-15）。
 *
 * 解决什么：分享图一旦被保存到相册 / 发进朋友圈，就脱离了微信的转发链路 —— 图上没有码
 * 等于这趟传播到此为止。名言卡与周报卡此前都只落产品名，看图的人**没有任何入口**。
 *
 * 为什么码要经过云函数：小程序码只能由服务端接口（`wxacode.getUnlimited` /
 * `wxacode.get`）在**小程序侧用 access_token** 生成，而 access_token 需要 appsecret ——
 * 存在小程序包里的任何密钥都等于公开。云函数走**云调用**（`cloud.openapi.wxacode.*`）
 * 免密钥，密钥链路一步都不进小程序包，与 aiProxy 的「key 只留云端」是同一条纪律。
 *
 * 三级缓存，因为这一步是纯网络调用、而分享图是高频动作：
 *   1. 内存：同一次会话里同一张码只解析一次；
 *   2. 本地存储：**只缓存 fileID**（长期有效），跨会话不必再生成；
 *   3. 云函数：同一目标只生成一次（同 cloudPath 覆盖写，fileID 不变）。
 * 临时链接（2 小时有效）**不缓存**，每次都现换（见 utils/cloud.ts#getTempFileUrl）。
 *
 * 降级：码是锦上添花，任何一步失败（云函数未部署 / 未声明 openapi 权限 / 临时链接拿不到）
 * 都只是图上少一个码，绝不能因此让用户存不出一张图 —— 失败返回空串，绘制侧回落到
 * 「微信搜索「名人雷达」」的文字引导。
 */

/** 码指向哪个页面的哪个人 */
export interface ShareCodeTarget {
  /** 小程序页面路径，**不带前导斜杠、不带查询串**（微信接口只要这个形态） */
  page: string
  /** 场景值（≤ 32 可见字符），扫完由页面自己解析；为空则生成不带参数的码 */
  scene?: string
}

/** 场景值上限（微信侧硬限制，超了整个接口直接报错） */
const SCENE_MAX = 32
/** 落码时用的页面：报告长图与名言卡都指向此人报告，扫码即落在具体一个人身上 */
const REPORT_PAGE = 'package/report/index'
/** 场景值塞不下这个人时的回落页面：首页（宁可多点一次搜索，也不给一个落错页的码） */
const HOME_PAGE = 'pages/index/index'

const FILE_ID_KEY = 'share-code-file-id'

/** 内存缓存：`page|scene` → 已解析出的临时链接（同会话内不重复请求） */
const urlMemo = new Map<string, string>()
/** 在途请求去重：同一张码并发请求时只发一次（分享图可能被连点） */
const inflight = new Map<string, Promise<string>>()

/**
 * 报告卡 / 名言卡的码目标：**场景值就是 personKey**（扫完直接落在那个人的报告页）。
 *
 * 为什么先编码再判长度：scene 只接受可见字符，中文 personKey 必须先 encodeURIComponent；
 * 编码后仍超过 32 字符（长名字）就**退回首页**而不是截断 —— 截断出来的 personKey 是另一个
 * 不存在的键，扫码的人会落在「缺少参数」的错误态，比多点一次搜索更糟。
 */
export function reportCodeTarget(personKey: string): ShareCodeTarget {
  const key = (personKey ?? '').trim()
  if (!key) return { page: HOME_PAGE }
  const enc = encodeURIComponent(key)
  return enc.length <= SCENE_MAX ? { page: REPORT_PAGE, scene: enc } : { page: HOME_PAGE }
}

/** 周报简报卡这类「不属于某个人」的图：码落在页面本身，不带场景值 */
export function pageCodeTarget(page: string): ShareCodeTarget {
  return { page: (page ?? '').replace(/^\//, '') || HOME_PAGE }
}

function targetKey(target: ShareCodeTarget): string {
  return `${target.page}|${target.scene ?? ''}`
}

/** 读本地缓存的 fileID（存储读写都可能抛错，一律视为没有缓存） */
function readCachedFileId(key: string): string {
  try {
    const v = Taro.getStorageSync(`${FILE_ID_KEY}:${key}`)
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

function writeCachedFileId(key: string, fileID: string): void {
  try {
    Taro.setStorageSync(`${FILE_ID_KEY}:${key}`, fileID)
  } catch {
    /* 存储写失败只是下次多调一次云函数，不影响出图 */
  }
}

/**
 * 取小程序码的临时链接；**任何失败都返回空串**（调用方按「没有码」降级）。
 */
export async function shareCodeUrl(target: ShareCodeTarget): Promise<string> {
  const key = targetKey(target)
  const cached = urlMemo.get(key)
  if (cached) return cached

  const running = inflight.get(key)
  if (running) return running

  const task = resolveCode(key, target).finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

async function resolveCode(key: string, target: ShareCodeTarget): Promise<string> {
  try {
    let fileID = readCachedFileId(key)
    if (!fileID) {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const res = (await callCloudFunction('wxacode', {
        page: target.page,
        scene: target.scene ?? ''
      })) as { ok?: boolean; fileID?: string } | null
      fileID = typeof res?.fileID === 'string' ? res.fileID : ''
      if (!fileID) throw new Error('云函数 wxacode 未返回 fileID')
      writeCachedFileId(key, fileID)
    }

    const url = await getTempFileUrl(fileID)
    if (!url) throw new Error('云文件临时链接为空')
    urlMemo.set(key, url)
    return url
  } catch (err) {
    /* 原文只进诊断日志（可能是「函数未部署」「未声明 openapi 权限」「域名未配置」）：
       这些对用户没有可执行信息，他能看到的只是图上少了码 */
    diagLog(
      'warn',
      'storage',
      `分享图小程序码不可用（${target.page}${target.scene ? `?scene=${target.scene}` : ''}）：` +
        `${err instanceof Error ? err.message : String(err)}`
    )
    return ''
  }
}
