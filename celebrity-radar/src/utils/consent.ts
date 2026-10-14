import Taro from '@tarojs/taro'
import { PRIVACY_CONSENT_VERSION } from '@/config/legal'

/**
 * 首次知情同意（PIPL 第 14 / 17 条）。
 *
 * ── 解决什么问题 ───────────────────────────────────────────────────
 * 改造前：小程序**启动即静默建号**（app.tsx 的 useLaunch → ensureLogin），
 * 在用户看到、同意任何隐私条款之前就采集了 openid（个人信息）。这既缺「告知—同意」
 * 闭环，也无从证明取得过同意。
 *
 * 现在：登录（= 采集 openid 的动作）被**闸在同意之后**（见 app.tsx + components/consent-gate），
 * 用户必须对《隐私与免责声明》作出**明确的肯定动作**才放行；同意结果连同**版本号**落本机，
 * 作为「已同意哪一版」的凭据。政策更新（版本号变化）会自动重新征求同意。
 *
 * ── 为什么只落本机、不上云 ─────────────────────────────────────────
 * 云端的账号行由 `userInit.ensure` 在登录时创建，而登录本身已被本网关闸住 ——
 * 若为「记录同意」先在云上落一行带 openid 的记录，等于又回到「同意前先采集」的老问题。
 * 微信生态里，具备平台效力的同意凭据是后台配置的《小程序用户隐私保护指引》与
 * `wx.onNeedPrivacyAuthorization`（见 components/privacy-gate）；本模块落本机的是
 * 「本设备是否已同意当前版本」的**状态**，用于闸门判定与版本失效后重新征求。
 *
 * ── 容错 ──────────────────────────────────────────────────────────
 * storage 读/写失败一律不抛：读失败按「未同意」处理（宁可与用户重新确认，不默认放行）；
 * 写失败只影响「下次冷启是否重新弹出」，本次会话仍由调用方置内存态放行。
 */

/** 本机同意记录的存储键（含版本与时刻） */
const CONSENT_KEY = 'legal:consent'

export interface ConsentRecord {
  /** 已同意的政策版本（= 政策生效日期，见 config/legal.ts） */
  version: string
  /** 同意时刻（ISO 8601） */
  at: string
}

/** 读本机同意记录；缺失 / 结构不对 / storage 不可用一律返回 null（视为未同意） */
export function readConsent(): ConsentRecord | null {
  try {
    const raw = Taro.getStorageSync(CONSENT_KEY) as Partial<ConsentRecord> | '' | null | undefined
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.version !== 'string' || typeof raw.at !== 'string') return null
    return { version: raw.version, at: raw.at }
  } catch {
    return null
  }
}

/**
 * 是否已同意**当前**版本。版本号不一致 = 政策更新过，需重新征求同意。
 * 注意：`recordConsent` 会带当前版本号写入，故正常路径下两者恒一致。
 */
export function hasConsented(): boolean {
  const rec = readConsent()
  return !!rec && rec.version === PRIVACY_CONSENT_VERSION
}

/** 记录同意（当前版本 + 时刻）。storage 不可用时静默失败（调用方仍按本次会话放行） */
export function recordConsent(): void {
  try {
    const rec: ConsentRecord = { version: PRIVACY_CONSENT_VERSION, at: new Date().toISOString() }
    Taro.setStorageSync(CONSENT_KEY, rec)
  } catch {
    /* storage 写满 / 被禁用：本次会话照常放行，下次冷启重新征求 */
  }
}

/**
 * 清除本机同意记录（**注销账号**时调用）。
 *
 * 注销 = 彻底解除关系，本机也回到「未同意」的干净态；下次冷启会**重新征求同意**。
 * 不用于「清空我的数据」——那只是清用户内容，法定同意记录不随之失效（否则每次清数据都要重弹）。
 */
export function clearConsent(): void {
  try {
    Taro.removeStorageSync(CONSENT_KEY)
  } catch {
    /* 清不掉最多是下次冷启不再重新征求，不影响主流程 */
  }
}
