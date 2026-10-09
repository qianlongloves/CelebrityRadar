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
 * ⚠ QUOTA_POOLS 的数值必须与端上 MEMBER_BENEFITS 一一对应：
 *   test/cases/07-cloud-authority.js 会读本文件比对端上那份，改一端会红。
 *   表名与 quotaGuard 的 TABLE_BY_KIND 一致（_id = openid#yyyy-MM-dd）。
 */
const QUOTA_POOLS = {
  /* 主动生成报告 / 周报共用一池（与端上 generatePerDay 同源） */
  generate: { table: 'generate_quota', free: 3, member: 30 },
  /* AI 提问独立一池，且「成功才计数」（与端上 askPerDay 同源） */
  ask: { table: 'ask_quota', free: 5, member: 30 }
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

/**
 * 防滥用上限（次/日）：按**每一次真实付费调用**计，包含生成、提问与辅助调用。
 *
 * 取值依据（正常用户一天的调用量）：
 *   免费档 ~ 3 次生成 + 5 次提问 + 若干消歧/选题 ≈ 10~15 次；
 *   会员档 ~ 30 次生成 + 30 次提问（报告可能带一次纯文本降级）≈ 60~70 次。
 * 留 2~3 倍余量，于是正常用户碰不到，改包者最多也就花掉这些。
 */
const ABUSE_LIMITS = { free: 40, member: 200 }

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
  todayKey
}
