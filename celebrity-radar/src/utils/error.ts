/**
 * 统一错误文案层：把任意异常翻译成用户看得懂的一句话。
 *
 * 起因：各处的 catch 习惯写成 `操作失败：${err.message}`，而云开发/微信抛出来的原文长这样——
 * `cloud.callFunction:fail Error: errCode: -404011 | errMsg: ...`、`requestPayment:fail cancel`、
 * `[object Object]`。用户看到的是英文栈、错误码与函数名，既看不懂，也不知道下一步该做什么。
 *
 * 三条口径：
 *   1. **技术细节不进 UI**：错误码 / 英文栈 / 云函数名 / `[object Object]` 一律拦在这一层。
 *      原文交给 diagLog（诊断日志）与 debugRaw（开发者工具 Console）保留，排查能力不丢。
 *   2. **能照做的话照旧**：能判定的失败仍给具体指引（超时→换基础版、未部署→联系开发者），
 *      只是不再把平台原文贴到用户脸上。
 *   3. **认不出来就用调用方给的兜底**：`fallback`（「收藏失败，请重试」这类）由调用点提供，
 *      本模块不做业务语义猜测，也绝不把原始异常当兜底文案透传。
 *
 * 与 `utils/cloud.ts#cloudTimeoutHint` 的关系：那条是**给部署者看的详细指引**（含控制台路径），
 * 现在只进 diagLog；用户侧统一走本模块的短文案。
 */
import { clipText } from './text'

export interface ErrorRule {
  /** 命中的错误码（云开发 / 微信 errCode，按子串匹配即可） */
  code?: number[]
  /** 命中的特征串 */
  re?: RegExp
  /** 给用户看的话：**不含**错误码、英文栈、云函数名等技术细节 */
  msg: string
}

/**
 * 已知失败 → 用户文案。**顺序即优先级**，靠前的先命中：
 * 具体类别在前、宽泛的网络类在后，否则「超时」会被「网络」先吃掉。
 */
const RULES: ErrorRule[] = [
  /* 用户主动取消不是错误，别吓人 */
  { re: /requestPayment:fail\s*cancel|用户取消|cancel(?:led)?\b/i, msg: '已取消' },

  /* 云函数没部署：用户做什么都没用，得让部署者处理 */
  {
    code: [-501000, -501009],
    re: /FunctionName|function not found|函数不存在|aiProxy 未部署/i,
    msg: '服务尚未就绪，暂时无法使用。请联系开发者部署云端函数后再试。'
  },
  /* 云函数内部抛了未捕获异常：端上拿不到结构化原因，只能请用户稍后重试 */
  {
    code: [-404011, -404012],
    re: /FUNCTIONS_EXECUTE_FAIL|执行出错/i,
    msg: '服务开小差了，请稍后重试。若一直这样，请联系开发者查看云端日志。'
  },
  /* 云函数被平台掐断（-504003）：重试还会再撞，必须换更轻的档位 */
  {
    code: [-504003],
    re: /FUNCTIONS_TIME_LIMIT_EXCEEDED|Invoking task timed out|执行超时/i,
    msg: '这次处理用时过长已中断。请稍后重试；若反复出现，可到「我的」把模型切到基础版再试。'
  },
  /* 数据库没初始化：环境问题，重试无意义 */
  {
    code: [-502005],
    re: /collection not exist|集合不存在|DATABASE_COLLECTION_NOT_EXIST/i,
    msg: '数据表尚未初始化，暂时无法使用。请联系开发者初始化云数据库后再试。'
  },
  /* 数据库权限不对：同样属环境问题 */
  {
    code: [-502003],
    re: /permission denied|no permission|无权限/i,
    msg: '权限不足，操作没有生效。请联系开发者检查云数据库的权限设置。'
  },
  /* 隐私接口未授权（微信平台级） */
  {
    re: /privacy|隐私/i,
    msg: '需先同意隐私授权后才能继续。'
  },
  /* 订阅消息 / 授权被拒 */
  {
    re: /auth deny|auth denied|authorize:fail|requestSubscribeMessage:fail|未授权|授权失败/i,
    msg: '未获得授权，操作没有完成。可在微信「设置」里重新允许后重试。'
  },
  /* 下单阶段失败（还没拉起收银台）：只说「没下成」，别让用户误以为已被扣款 */
  {
    re: /下单|unifiedOrder/i,
    msg: '下单没有成功，请稍后重试。'
  },
  /* 支付：失败原因不该原样贴出（可能含商户号等技术串） */
  {
    re: /requestPayment:fail|支付/i,
    msg: '支付未完成，请稍后重试。若已被扣款，请勿重复支付。'
  },
  /* 内容安全机审不通过 */
  {
    re: /risky|content.?risk|敏感|违规|内容安全/i,
    msg: '内容包含敏感信息，请修改后重试。'
  },
  /* 参数类：云函数入参过大 / 非法 */
  {
    code: [-501007, -501008],
    re: /参数|param(?:eter)?s?\s+(?:invalid|too\s+large)|invalid request/i,
    msg: '请求内容有点问题，请返回上一步重新操作。'
  },
  /* 网络类放最后：它最宽泛，会把上面各种具体原因都匹配到 */
  {
    code: [-504002, -504001, -1],
    re: /request:fail|ERR_|network|Network|timed out|timeout|ENOTFOUND|ECONN|连接|超时|网络/i,
    msg: '网络不太顺畅，请检查网络后重试。'
  }
]

/**
 * 技术细节特征串：只要命中其一，就不允许透传给用户。
 *
 * 判定「能否透传」比「能否识别」更要紧：识别不出来顶多丢了原因（原文仍在日志里），
 * 而误把原始异常当成品文案发出去，用户就会看到 `errCode: -404011`。
 */
const TECH_MARKERS: RegExp[] = [
  /errCode/i,
  /callFunction/i,
  /:fail/i,
  /\[object/i,
  /\bundefined\b/,
  /\bat\s+[\w$.]+\s*\(/,
  /^\s*Error\b/i,
  /-4\d{5}|-5\d{5}/,
  /finish_reason/i,
  /\bJSON\b/i,
  /\bstack\b/i,
  /\.(?:js|ts|json):\d+/,
  /DATABASE_|FUNCTIONS_/,
  /*
   * 部署 / 配置类行话（2026-10-15 补）：`平台大模型通道未就绪：…需部署 aiProxy，且
   * wx-server-sdk ≥ 4.0.1（见 llm.config.js）`这类句子通篇中文、不含上面的技术特征串，
   * 却显然是写给**部署者**看的 —— 少了这一组，它就会被判成「给人看的话」原样透传。
   * 命中即回落到调用点的兜底文案，原文仍留在 diagLog 里。
   */
  /\bLLM\b/,
  /aiProxy|hotBoardRefresh|userInit|userBackfill|quotaGuard|contentCheck|riskWatch/i,
  /wx-server-sdk/,
  /TCB_ENV_ID|ENV_ID|\.env\b/,
  /llm\.config|cloudbaserc/i,
  /API_KEY|apiKey|\bsk-[\w-]{8,}/i,
  /\bkind\s*[:=]/
]

/** 上游给的中文文案里偶尔带这类括号补充，不算技术细节，但透传会显得突兀 */
const TRAILING_NOISE = /（(?:原始错误|错误码|errCode)[^）]*）\s*$/

/**
 * 提取原始错误文本（**只给日志用，不要直接展示**）。
 *
 * 云开发 reject 的是普通对象 `{ errCode, errMsg }` 而非 Error 实例，直接 `String()` 会得到
 * `[object Object]`，把唯一能定位问题的字段丢掉 —— 这里按 `errMsg → message → error → reason`
 * 的顺序取出第一手信息，再补上 errCode。
 */
export function errRawText(err: unknown): string {
  if (err === null || err === undefined) return ''
  if (typeof err === 'string') return err
  if (typeof err !== 'object') return String(err)

  const e = err as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['errMsg', 'message', 'error', 'reason']) {
    const v = e[key]
    if (typeof v === 'string' && v && !parts.includes(v)) parts.push(v)
  }
  if (e.errCode !== undefined && e.errCode !== null) parts.push(`errCode=${String(e.errCode)}`)
  if (parts.length) return parts.join(' | ')

  /* 连一个可读字段都没有（罕见）：退回序列化摘要，失败就放弃 */
  try {
    return JSON.stringify(err) ?? ''
  } catch {
    return ''
  }
}

/** 这段文本是否已经像「给人看的话」（含中文、且不含技术细节） */
function isUserFacing(text: string): boolean {
  if (!/[\u4e00-\u9fa5]/.test(text)) return false
  return !TECH_MARKERS.some((re) => re.test(text))
}

function matchRule(raw: string): ErrorRule | null {
  for (const rule of RULES) {
    const byCode = rule.code ? rule.code.some((c) => raw.includes(String(c))) : false
    const byText = rule.re ? rule.re.test(raw) : false
    /* 两个条件都写了：命中其一即可（错误码比文案可靠，但两者都常见） */
    if (byCode || byText) return rule
  }
  return null
}

/**
 * 把任意异常转成一句可以直接给用户看的话。
 *
 * @param err      任意异常（Error / 云开发 reject 的普通对象 / 字符串）
 * @param fallback 认不出来时用的兜底文案，**由调用点给**，如「收藏失败，请重试」
 */
export function toUserMessage(err: unknown, fallback: string): string {
  const raw = errRawText(err).replace(TRAILING_NOISE, '')
  if (!raw) return fallback

  const rule = matchRule(raw)
  if (rule) return rule.msg

  /* 上游返回的中文文案（如「今日额度已用完，请明天再来」）本来就是给人看的，原样保留 */
  if (isUserFacing(raw)) return clipText(raw, 60)

  return fallback
}

/**
 * toast 专用：`showToast({ icon: 'none' })` 的 title 长了会被截断，先裁到一行能排下的长度。
 * 默认 30 字（约两行），超长补省略号。
 */
export function toastText(err: unknown, fallback: string, max = 30): string {
  const msg = toUserMessage(err, fallback)
  const clipped = clipText(msg, max)
  return clipped === msg ? msg : `${clipped}…`
}
