import { callCloudFunction, isCloudConfigured } from './cloud'
import { diagLog } from './cloud-diagnostics'

/**
 * 用户自由文本的内容安全检测（设计方案 §六 3 · V1.5）。
 *
 * 服务端通道是云函数 `contentCheck`（云调用 `security.msgSecCheck`，凭证由平台托管，
 * 函数侧零环境变量）。端上只决定「要不要拦」：`pass` 放过，`review` / `risky` 拦下让用户改写。
 *
 * 设计口径 —— **fail-open**：机审是合规兜底，不是核心链路。
 * 云环境未配置 / 函数未部署 / 上游抖动，一律返回 `pass` 并只留一行诊断日志；
 * 宁可漏拦（文本仅本人可见，风险低）也不让用户「因为服务端没配好而存不了备注」。
 * 反过来，**命中违规时是 fail-closed**：调用方必须拦下并提示改写。
 */

/** 上游倾向三值 */
export type SecSuggest = 'pass' | 'review' | 'risky'

interface CheckResult {
  ok?: boolean
  suggest?: string
  label?: number
  skipped?: string
  kind?: string
  error?: string
}

/** 认不出的取值一律按 pass：解析问题不该误伤用户 */
function normSuggest(raw?: string): SecSuggest {
  return raw === 'risky' || raw === 'review' ? raw : 'pass'
}

/**
 * 送检一段用户文本。**永不 reject**。
 *
 * @param content 待检文本；trim 后为空则不打上游，直接 `pass`（清空备注是正常操作）
 */
export async function checkUserText(content: string): Promise<SecSuggest> {
  const text = content.trim()
  if (text === '') return 'pass'
  if (!isCloudConfigured) return 'pass'

  try {
    const res = (await callCloudFunction('contentCheck', {
      action: 'check',
      content: text
    })) as CheckResult | null

    if (!res || res.ok === false) {
      diagLog(
        'warn',
        'http',
        `内容安全检查跳过（${res?.kind ?? '无返回值'}）：${res?.error ?? '云函数无结果'}`
      )
      return 'pass'
    }
    return normSuggest(res.suggest)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    /* 未部署（FunctionName / -501000）与其它异常同路：放过，但日志里留一句可排查的话 */
    const hint = /not found|FunctionName|-501000/i.test(msg) ? 'contentCheck 未部署' : msg
    diagLog('warn', 'http', `内容安全检查跳过：${hint}`)
    return 'pass'
  }
}
