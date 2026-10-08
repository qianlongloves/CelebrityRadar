/**
 * contentCheck —— 微信内容安全检测（security.msgSecCheck）的服务端通道。
 *
 * 为什么必须是云函数：msgSecCheck 需要小程序服务端凭证，端上既拿不到也不该拿。
 * CloudBase 提供「云调用」（cloud.openapi.*），凭证由平台托管，函数里无需自己取
 * access_token —— 所以本函数**不依赖任何环境变量**，只依赖 config.json 里声明的
 * openapi 权限（permissions.openapi: ["security.msgSecCheck"]）。
 *
 * 作用面（设计方案 §六 3）：用户自己输入的**收藏备注**（favorites.note）入库前机审。
 * AI 生成的报告 / 名言只在本机可见范围，分享卡片只画既有内容且不上传，均不构成新的内容出口。
 *
 * 返回约定沿用 aiProxy：{ ok: true, suggest } / { ok: false, kind, error }。
 * kind 取值：
 *   badrequest —— 参数问题（缺 content / openid、未知 action）
 *   rate       —— 上游限流，端上可重试
 *   upstream   —— 其它上游 / 平台失败（含未声明 openapi 权限）
 * 端上对一切 ok:false 一律**放过**（fail-open），只在诊断日志里留一行。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/** 单次送检内容上限（v2 规格）。端上备注上限 40 字，正常路径用不到，这里只作硬兜底 */
const CONTENT_MAX = 2500
/** 场景码：1 资料 / 2 评论 / 3 论坛 / 4 社交日志。私人备注最贴近「资料」 */
const SCENE = 1

/** 场景码归一：只认 2/3/4，其余一律用默认值，避免给上游发非法枚举 */
function sceneOf(raw) {
  const n = Number(raw)
  return n === 2 || n === 3 || n === 4 ? n : SCENE
}

/** suggest 归一：只认 risky / review，未知取值按 pass —— 解析问题不该误伤用户 */
function normSuggest(raw) {
  return raw === 'risky' || raw === 'review' ? raw : 'pass'
}

/** errCode / errMsg → 失败结果。kind 供端上判断是否值得重试 */
function failure(errCode, errMsg) {
  const msg = String(errMsg || '未知错误')
  if (errCode === -1 || errCode === 45009 || /freq|frequency|busy/i.test(msg)) {
    return { ok: false, kind: 'rate', error: `内容安全接口限流：${msg}` }
  }
  return { ok: false, kind: 'upstream', error: `内容安全检测失败（${errCode || '?'}）：${msg}` }
}

/** 判定「这是违规」而非「这是故障」：v1 用 87014 报违规，v2 走 result.suggest，两条路都要认 */
function isRiskyError(errCode, errMsg) {
  return errCode === 87014 || /87014/.test(String(errMsg || ''))
}

exports.main = async (event) => {
  const action = (event && event.action) || 'check'
  if (action !== 'check') {
    return { ok: false, kind: 'badrequest', error: `未知 action：${action}（仅支持 check）` }
  }

  const content = typeof event.content === 'string' ? event.content.trim() : ''
  /* 空内容不打上游：备注被清空是正常操作，直接算通过（也省一次计费调用） */
  if (content === '') return { ok: true, suggest: 'pass', skipped: 'empty' }

  const openid = String(cloud.getWXContext().OPENID || '').trim()
  if (openid === '') {
    /* v2 需要 openid（用于「谁发的」维度判定），端上调用必带；缺失即视为调用方用错通道 */
    return { ok: false, kind: 'badrequest', error: '缺少 openid（本函数只能由小程序端调用）' }
  }

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: content.slice(0, CONTENT_MAX),
      version: 2,
      scene: sceneOf(event.scene),
      openid
    })

    const errCode = Number(res && res.errCode)
    if (isRiskyError(errCode, res && res.errMsg)) return { ok: true, suggest: 'risky', label: 0 }
    if (errCode && errCode !== 0) return failure(errCode, res && res.errMsg)

    const result = (res && res.result) || {}
    return { ok: true, suggest: normSuggest(result.suggest), label: Number(result.label) || 0 }
  } catch (err) {
    const errCode = Number(err && (err.errCode != null ? err.errCode : err.code))
    const errMsg = (err && (err.errMsg || err.message)) || String(err)
    /* 云调用把违规也以异常抛出（87014）；先按违规认，再按故障归类 */
    if (isRiskyError(errCode, errMsg)) return { ok: true, suggest: 'risky', label: 0 }
    /* 未声明 openapi 权限、函数未部署到带权限的版本，都会落到这里 */
    return failure(errCode, errMsg)
  }
}
