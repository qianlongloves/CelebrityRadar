import Taro from '@tarojs/taro'
import { track } from './events'

/**
 * 会员入口的唯一跳转口（R-2 的分子，2026-10-16）。
 *
 * 为什么要有这个模块，而不是各页各写一句 `Taro.navigateTo`：
 *
 * 1. **「去会员页」有十几处**（报告页四种呈现、工作台满员、预警页上限、周报导出、
 *    问答升级、历史版本墙、事件页、我的页两处），这正是 `utils/pay.ts` 收口下单函数
 *    的同一个理由 —— **藏一处漏一处，漏的那处就是线上一个没人数的入口**。
 * 2. **R-2 的判据是「看到锁态卡之后去会员页的比例」**（doc/产品优化路线图.md §5.2）。
 *    在此之前全项目 9 处入口一个埋点都没有、`pages/member` 里 `track(` 出现 0 次，
 *    于是这条判据上线后**根本算不出来** —— 不是坏了，是没数可看（同 S1-4 当时
 *    「只有分子、没有分母」，见 events.ts#opinion_pick 的注释）。
 * 3. 收成一处之后，「新增一个入口忘了报」这件事在源码层面就不可表达了：
 *    页面只能通过本函数跳转，`Taro.navigateTo('/package/member/index')` 不再出现在页面里
 *    （test/cases/71-member-entry.js 钉住这一点）。
 *
 * ⚠ 顺序固定为**先报再跳**：报的是「**点了**这个入口」，不是「到了会员页」——
 * 跳转本身失败（路由异常）也算一次点击，否则分母与分子会各少一种情况、比例偏移。
 */

/**
 * `props.from` 的取值域：**入口标识，不是页面路径**。
 *
 * 报告页刻意分成四个（锁态卡 / 截断提示 / 促销条 / 目录那行）—— S3-3 上线后要回答的
 * 正是「哪种呈现真的把人推去了会员页」（R-2）。合成一个 'report' 就再也拆不开了，
 * 而这类数据必须**发版时就在**，事后补不回来（一次发版 = 一次归因窗口）。
 */
export type MemberEntryFrom =
  /* 报告页：S3-3 的四种呈现 */
  | 'report_lock'
  | 'report_preview'
  | 'report_promo'
  | 'report_toc'
  /* 报告页：导出引导（免费被拦后就地给的一行，与周报同一分层口径） */
  | 'report_export'
  /* 历史版本页的「更早的版本是会员能力」那面墙 */
  | 'history'
  /* 问答面板：提问额度用完后的升级位 */
  | 'qa'
  /* 监测工作台：免费档监控位数到顶 */
  | 'workbench'
  /* 预警页：关注数到顶 */
  | 'alerts'
  /* 周报：导出分享图时的升级引导 */
  | 'weekly'
  /* 事件详情页 */
  | 'event'
  /* 我的页：会员入口那一行（会员态是续费，同一个口） */
  | 'mine'
  /* 我的页：选了会员专属模型后弹出的「去开通」 */
  | 'mine_quality'

/** 跳会员中心，并留下一次 `member_entry`（先报再跳，见文件头） */
export function openMemberPage(from: MemberEntryFrom): void {
  track('member_entry', { from })
  void Taro.navigateTo({ url: '/package/member/index' })
}
