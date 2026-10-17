/**
 * 输入侧敏感过滤 · 第一级（§六.7）：本地静态拦截，命中即拒答，
 * 不发起任何网络请求（搜索源 / LLM 均不发）。
 *
 * 名单策略：
 * - 关键词维度：覆盖涉政涉军类头衔/机构词（「XX主席」「XX司令」等查询形态）
 * - 人物维度：SENSITIVE_NAMES 随发版维护（云端不下发，避免自身成为可探测接口）
 * - 失败策略（§六.7）：误拦可接受（用户可反馈），漏拦由第二级 LLM 兜底（disambiguate 拒答）
 */
import { RESTRICTED_SEARCH_ALLOWED } from './debug'

/** 涉政涉军关键词（查询串包含即拦截） */
const SENSITIVE_KEYWORDS: string[] = [
  '主席', '总书记', '总理', '总统', '首相', '国王', '女王', '亲王',
  '常委', '委员长', '政治局', '中央委员', '党委书记', '市委书记', '省委书记',
  '部长', '大使', '司令', '政委', '将军', '上将', '中将', '少将', '元帅',
  '军队', '国防', '军事', '解放军', '武警', '公安部', '国安',
  '政治家', '政客', '异见', '维权', '法轮', '达赖'
]

/**
 * 敏感人物名单（随发版更新；运营维护位）。
 *
 * 填写格式：每项一个完整姓名（字符串），按 `query === n || query.includes(n)` 匹配，
 * 故只填「姓名本身」即可，不用带头衔（头衔走下面的 SENSITIVE_KEYWORDS）。
 * 名单刻意**只随发版下发、不走云端**（见文件头注释：避免自身成为可探测接口）。
 */
const SENSITIVE_NAMES: string[] = [
  // TODO(运营): 发版前按最新合规要求补充在世政治/军事人物名单
  '习近平', '李克强', '胡锦涛', '温家宝', '贾庆林'
]

/*
 * 启动告警（与 debug.ts 的 RESTRICTED_SEARCH_ALLOWED 告警同一语义：调试/上线缺口不该被
 * 静默放过）。名单为空时，第一级的人物维度本地拦截整体失效（关键词级仍有效），
 * 查询会直接发网络请求 —— 这是合规漏洞，必须在上线前暴露出来。
 */
if (SENSITIVE_NAMES.length === 0) {
  console.warn(
    '[sensitive] 敏感人物名单 SENSITIVE_NAMES 为空：人物维度本地拦截失效（关键词级仍有效）。上线前必须按最新合规要求补齐。'
  )
}

/** 第一级拦截：命中返回 true（调用方直接展示拒答态，禁止发起网络请求） */
export function isSensitiveQuery(query: string): boolean {
  /*
   * 边界测试开关（默认 false）：见 utils/debug.ts#RESTRICTED_SEARCH_ALLOWED。
   * 放开时这里整体短路 —— 它只是让**端上**不再拦截，云端 contentCheck 仍会拦涉政内容。
   */
  if (RESTRICTED_SEARCH_ALLOWED) return false
  const q = query.trim()
  if (!q) return false
  if (SENSITIVE_NAMES.some((n) => n && (q === n || q.includes(n)))) return true
  return SENSITIVE_KEYWORDS.some((k) => q.includes(k))
}
