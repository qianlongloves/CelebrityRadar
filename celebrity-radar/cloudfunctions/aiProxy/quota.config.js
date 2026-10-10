/**
 * quota.config.js —— 服务端配额与限速配置（B8：判定下沉到云端）。
 *
 * 云端为什么要自己判一次：端上那份判定（utils/quota.ts / qa.ts 基于 MEMBER_BENEFITS）
 * 决定**界面**显示多少、并提前拦一下，而小程序包可解包 —— 改包者把上限改大就能白拿。
 * aiProxy 是真正花钱的那一步（每次 chat 都是一次付费上游请求），所以它入口必须自己判。
 *
 * ## 两道闸，防的是两件不同的事（2026-10-09）
 *
 * 1. **产品额度闸（quota）**：读 quotaGuard 维护的当日计数，比对 QUOTA_POOLS 的上限，
 *    与端上界面同值同池。它防的是「端上与云端口径不一致」——多设备各算一份、
 *    或设备时钟偏差让端上以为还有额度。文案与端上逐字同构，用户看不出差异。
 *
 * 2. **防滥用闸（abuse）**：**由本函数自己原子自增**（`ai_calls` 表），上限宽松到正常
 *    用户永远碰不到（一天几十次）。它防的是「解包改大上限随便调」——
 *    第 1 道闸的计数是端上主动调 quotaGuard 才写的，改包者不调就永远是 0，
 *    所以**第 1 道闸单独不能作为安全边界**；这道闸的计数由云端在放行时就地写，
 *    端上无法阻止，于是「改包者一天最多花掉 N 次上游调用」成为硬上限。
 *
 * 两道闸都用 `memberships`（端上不可读写）判会员档位，故自授会员对成本没有帮助。
 *
 * ⚠ 上限数值**不在本文件**：来自同目录的 benefits.config.js（自动生成，真源是
 *   src/config/benefits.ts）—— 端上 utils/member.ts 与这里读同一份数据，
 *   于是「改一端忘了另一端」这个错从根上没有了。调额度请改真源 → `npm run config:sync`
 *   → 重新部署本函数（端上随下次发版）。
 *   表名与 quotaGuard 的 TABLE_BY_KIND 一致（_id = openid#yyyy-MM-dd），
 *   由 test/cases/07-cloud-authority.js 钉住。
 */
const { MEMBER_BENEFITS, ABUSE_LIMITS } = require('./benefits.config')

const QUOTA_POOLS = {
  /* 主动生成报告 / 周报共用一池 */
  generate: { table: 'generate_quota', ...MEMBER_BENEFITS.generatePerDay },
  /* AI 提问独立一池，且「成功才计数」 */
  ask: { table: 'ask_quota', ...MEMBER_BENEFITS.askPerDay }
}

/**
 * 辅助调用：**不走产品额度**，只受限速闸。
 *
 * 消歧（输入一个名字先问模型是哪个人）与随机选题（探索页摇一位名人）都是「一次轻量
 * chat」，但它们发生在生成**之前**：若按生成池判定，用户当天额度用完后连名字都输入不了
 * （会被报成「额度已用完」），而端上并没有为它们计数 —— 那是口径不一致造成的误报。
 * 它们的上限由防滥用闸兜住，足够。
 */
const AUX_PURPOSE = 'aux'

/**
 * purpose 缺失 / 不认识时按哪一池算：取**最严**的 generate（免费 3）而不是最宽的 ask。
 * 漏传的调用方应当尽快暴露出来，而不是默默拿到更宽的额度。
 * 端上唯一的 chat 出口（utils/llm.ts）必传 purpose。
 */
const DEFAULT_PURPOSE = 'generate'

/* 防滥用计数表（本函数写入，端上不可读写） */
const ABUSE_TABLE = 'ai_calls'

/*
 * 防滥用上限（次/日）：已随上面的 require 从 benefits.config.js 引入。
 * 按**每一次真实付费调用**计（生成 / 提问 / 辅助调用），取值依据（按正常用户一天的
 * 调用量留 2~3 倍余量）写在真源 src/config/benefits.ts 的 ABUSE_LIMITS 上方。
 */

/**
 * 云端闸门开关（**本地联调专用**，2026-10-09 补）。
 *
 * 为什么需要它：端上 `src/config/local.ts` 的 `debug.disableGenerateQuota` 只放开
 * **端上那道**闸门（utils/quota.ts#peekGenerateQuota），而两次生成之间端上照样
 * 调 quotaGuard consume（"放开闸门、记数照旧"），计数一路涨到上限后，本文件
 * 这两道闸（产品额度 / 防滥用限速）照样在 aiProxy 入口把人拦下 —— 现象就是
 * 「debug 明明开了，生成第 4 次仍报『今日报告生成额度已用完』」。
 * 端上开关**不能**顶替这里：云端不信端上传来的任何标记（改包即可伪造）。
 * 故两端各有一枚开关，联调时都要放开。
 *
 * 取值（环境变量 AI_PROXY_QUOTA_GUARD）：
 *   'on'（缺省 / 不认识的取值）→ 两道闸都按上限判定 = 生产口径
 *   'off'                      → 只放开**判定**，计数照旧自增（与端上 debug 的取舍一致，
 *                                排查时在 ai_calls 里仍能看到真实调用量）
 *
 * ⚠ 与上面四个端上 disable* 同一性质：`off` 会把上游成本敞给所有走这个云环境的调用者，
 *   只能在自己那套开发环境上临时配置，**上线前必须删掉这个环境变量**。
 *   它是环境变量而非常量，正是为了让它进不了代码库、也不随端上发布一起生效。
 */
const QUOTA_GUARD_ENV = 'AI_PROXY_QUOTA_GUARD'

/** 云端闸门是否整体放行（判定层面）。未配置 / 非 'off' 一律按不放行（fail-closed） */
function quotaGuardDisabled() {
  const v = process.env[QUOTA_GUARD_ENV]
  return typeof v === 'string' && v.trim().toLowerCase() === 'off'
}

/**
 * 服务端「今天」：云函数时区为 UTC，必须显式 +8 —— 否则北京时间 08:00 之前的调用
 * 会落到前一天，与端上 todayKey()、quotaGuard 的日期口径三方错位。
 */
function todayKey() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

module.exports = {
  QUOTA_POOLS,
  DEFAULT_PURPOSE,
  AUX_PURPOSE,
  ABUSE_TABLE,
  ABUSE_LIMITS,
  QUOTA_GUARD_ENV,
  quotaGuardDisabled,
  todayKey
}
