import { publicConfig } from '@/config/public'

/**
 * 调试开关与上游原始报文打印（**仅本地调试用**）。
 *
 * 开关的**值**集中在 `src/config/public.ts` 的 `debug` 节，本文件只做转出：
 * 额度与冷却分属 quota / cache / qa / cooldown 四个模块，开关散着放，改一次要跳四个文件；
 * 集中到一个配置节后，上线前对账只需检查一处，也不必在四个文件里各怀疑一遍。
 *
 * ⚠ 上线口径：`debug` 节五项必须全为 false —— 否则免费层限流（每日 3 次生成 / 5 次提问）
 *   与 429 冷却保护（10 分钟）都会失效，等于把上游成本敞给所有人；
 *   `rawIoLog` 为 true 只是噪音（上游原始报文进控制台），不改变行为。
 *
 * 开关只决定「拦不拦」，不改变数据正确性：
 *   计数照常自增（排查时能看到真实用量）、冷却时间照常写入（关回开关后保护立即恢复）。
 *
 * ⚠ 这里放开的只是**端上**那道闸门（2026-10-09 补）：每日生成 / 提问 / 缓存写口在
 *   aiProxy 入口还会各判一次，且计数由端上主动 consume、debug 下照旧自增 ——
 *   于是「开关全开、生成第 4 次仍报额度用完」是**预期内**的，不是开关失效。
 *   云端不信端上标记（改包即可伪造），故两处各一枚开关，联调时两边一起放开：
 *   云函数环境变量 `AI_PROXY_QUOTA_GUARD=off`（quota.config.js#quotaGuardDisabled，
 *   默认 on、只认 off，只放开判定、记数照旧）。
 */

/** 解除每日生成额度（免费 3 次 / 会员 30 次） */
export const GENERATE_QUOTA_DISABLED = publicConfig.debug.disableGenerateQuota

/**
 * 解除每日提问额度（免费 5 次 / 会员 30 次，见 utils/member.ts 的 askPerDay）。
 *
 * 与生成 / 刷新同一取舍：只放开闸门，**记数照旧**（照样读云端、照样抬高镜像）。
 * 两个附带效果是刻意的，别当成漏改：
 *   ① 连点间隔（3 秒）不受本开关影响 —— 它防的是误触重复计费，与「次数限制」无关；
 *   ② 用量展示照实报（见 utils/qa.ts#qaUsageToday）：开挂时报的是**真实已用次数**，
 *      与生成额度（utils/quota.ts 的 used）同一口径 —— 界面上的数字照样在涨，
 *      「还能不能问」则交给 `unlimited` 决定，不再为了圆场把次数报成满额。
 */
export const ASK_QUOTA_DISABLED = publicConfig.debug.disableAskQuota

/** 解除每日刷新额度（关注流每日 10 次） */
export const REFRESH_QUOTA_DISABLED = publicConfig.debug.disableRefreshQuota

/** 解除 10 分钟限流冷却（搜索源与大模型共用同一套冷却机制） */
export const COOLDOWN_DISABLED = publicConfig.debug.disableCooldown

/** 是否把博查 / 大模型的原始返回打到控制台 */
export const RAW_IO_LOG = publicConfig.debug.rawIoLog

/**
 * 打印上游原始报文。
 *
 * 传对象本身而不是 JSON.stringify 后的字符串：微信开发者工具的 Console 会把对象
 * 渲染成可逐层展开的树，几万字的报告正文也不会被压成一行而看不全；
 * 且字段名、类型、嵌套结构都保留，比字符串更容易定位结构问题。
 */
export function debugRaw(tag: string, payload: unknown): void {
  if (!RAW_IO_LOG) return
  try {
    console.log(`[raw:${tag}]`, payload)
  } catch {
    /* 循环引用等极端结构不应影响主流程 */
  }
}
