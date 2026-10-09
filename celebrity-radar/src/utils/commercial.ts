import type { Report } from './report'
import { buildProfileStats } from './stats'
import type { ProfileStats } from './stats'
import { buildRiskSignals } from './risk'
import type { RiskScan } from './risk'

/**
 * 商业价值速览（第 0 期，端上聚合）—— 报告页新卡的数据层。
 *
 * 这张卡回答的是「读完这份报告，值不值得进一步接触」，把已经有的事实换成一个
 * **面向商业决策的读法**：报道热度、报道倾向、争议状况，一屏三段。
 *
 * 三处刻意的设计，改动前先读：
 *
 *   1. **一个数字都不新算**。三段全部取自 utils/stats.ts 的 buildProfileStats 与
 *      utils/risk.ts 的 buildRiskSignals —— 这两处是「数据 Tab」「风险雷达」的口径来源。
 *      本文件只做「挑出与商业相关的那三项 + 换成一句结论」的措辞工作。
 *      为什么宁可多跑一遍聚合也不另写一套：同一份报告出现两处对不上的数字，
 *      是最难向用户解释的故障（同 utils/stats.ts 顶部的教训）。
 *   2. **不评分、不给结论**。没有「商业价值指数」「适配度星级」这类东西 ——
 *      它们都需要推断（受众规模、品牌调性、转化率），而本项目只基于素材说话。
 *      三段给的分别是「多少条报道」「三种倾向各多少条」「几条争议、几条有回应」。
 *   3. **不成立也要说清**。某一段的素材不足以成立时，进 gaps 并写明原因，
 *      由卡片照出、逐条解释，而不是让这一行凭空消失（2026-10-08 的呈现约定）。
 *
 * 与「数据 Tab」的关系（用户最容易问「这不是已经有了吗」）：
 *   同一批数字，两种读法。数据 Tab 是**核对用的面板**（分布、交叉、走势，图表为主），
 *   这张卡是**决策用的入口**（一句话结论 + 点回明细）。因此这里刻意不画图、
 *   不铺明细，每段只留一句 value 与一条口径 note，明细一律靠 anchor 跳过去 ——
 *   否则报告页会出现第二份统计面板。
 */

/** 分项键：界面按这个顺序渲染（避免每个页面各排一份） */
export type CommercialAxisKey = 'heat' | 'tilt' | 'controversy'

export const COMMERCIAL_AXES: CommercialAxisKey[] = ['heat', 'tilt', 'controversy']

export interface CommercialAxis {
  key: CommercialAxisKey
  /** 分项名（界面左侧） */
  label: string
  /** 一句话结论（界面右侧，全部由数字拼出，不含评价词） */
  value: string
  /** 口径说明：这个数字从哪来、为什么长这样 */
  note: string
  /** 明细所在节的锚点 id；空串 = 本页没有对应明细可跳 */
  anchor: string
  /** 锚点对应的节名（界面提示用，与 utils/report-toc.ts 的标签同源同措辞） */
  anchorLabel: string
}

/** 没能成立的分项：写明原因，页面上照出（不许无声消失） */
export interface CommercialGap {
  label: string
  reason: string
}

export interface CommercialSummary {
  axes: CommercialAxis[]
  gaps: CommercialGap[]
  /**
   * 是否够格出「速览」。
   *
   * 门槛：成立的分项少于 MIN_AXES 时，一屏只剩一两行，那不叫速览，
   * 反而让读者以为这份报告的素材很贫瘠 —— 改为出卡说明缺什么，比硬凑强。
   */
  ready: boolean
}

/** 至少要有两个分项才出速览（与商业价值方案文档 3.1 的门槛一致：带出处的分项 < 2 条不出） */
export const MIN_AXES = 2

export interface CommercialInputs {
  /**
   * 已算好的数据 Tab 聚合 / 风险雷达结果。页面若已在同一趟里算过，传进来即可避免重复聚合；
   * 不传则内部按同样口径各算一遍（结果完全一致，只是多花一点端上计算）。
   */
  stats?: ProfileStats
  risk?: RiskScan
}

/**
 * 汇总三段商业视角的事实。
 *
 * 注意门槛与措辞都在这里，页面只渲染 —— 与 utils/report-toc.ts 同一个理由：
 * 这两段口径一旦散进页面，测试就钉不住它们。
 */
export function buildCommercialSummary(report: Report, pre: CommercialInputs = {}): CommercialSummary {
  const stats = pre.stats ?? buildProfileStats(report)
  const risk = pre.risk ?? buildRiskSignals(report)

  const axes: CommercialAxis[] = []
  const gaps: CommercialGap[] = []

  /* ---- 1. 报道热度：回答「现在有没有人在报道他」 ---- */
  const ex = stats.exposure
  /*
   * 成立条件：近 30 天确实取到了报道（items > 0）。
   * 老报告（2026-10-07 之前落库）没有 coverage 字段，只有热度分 —— 那也算成立，
   * 但措辞必须写明「本报告没记录原始条数」，不能拿一个分数假装有明细（见下）。
   */
  const items = ex.items
  if (items !== null ? items > 0 : ex.heat > 0) {
    axes.push({
      key: 'heat',
      label: '报道热度',
      value: items !== null ? `近 30 天 ${items} 条报道` : `热度 ${ex.heat}/100`,
      note:
        items !== null
          ? `热度 ${ex.heat}/100，其中近 7 天 ${ex.recent ?? 0} 条。热度是报道条数的对数归一（近 30 天与近 7 天加权），不是平台热度指数。`
          : '本报告生成时未记录素材条数（该字段上线前的老报告），只能给出归一后的热度分，口径同为「近 30 天报道条数」。',
      anchor: 'sec-overview',
      anchorLabel: '人物速览'
    })
  } else {
    gaps.push({
      label: '报道热度',
      reason: '本次检索没有取到近 30 天的公开报道，热度为 0，没有可汇总的对象。'
    })
  }

  /* ---- 2. 报道倾向：回答「媒体怎么写他」 ---- */
  const sent = stats.sentiment
  if (sent) {
    axes.push({
      key: 'tilt',
      label: '报道倾向',
      value: `积极 ${sent.positive} · 中性 ${sent.neutral} · 消极 ${sent.negative}`,
      note: `基于本报告收录的 ${sent.total} 条动态的报道写法归类。这是模型对每篇报道的标注，与「立场与舆情」同一口径 —— 它不是粉丝情绪，也不代表某家媒体的编辑方针。`,
      anchor: 'sec-stance',
      anchorLabel: '立场与舆情'
    })
  } else {
    gaps.push({
      label: '报道倾向',
      reason: `收录的动态为 ${report.dynamics.length} 条，没有可归类的对象。`
    })
  }

  /* ---- 3. 争议状况：回答「有没有在打官司、闹纠纷」 ---- */
  const controversies = report.controversies
  if (controversies) {
    /*
     * 空数组成立：这是「本次生成确认没有争议」（好消息也是信息），
     * 与「老报告没有这个字段」（不知道有没有）完全是两回事，措辞必须分开。
     */
    axes.push({
      key: 'controversy',
      label: '争议状况',
      value:
        controversies.length === 0
          ? '素材中未见公开争议'
          : `收录 ${controversies.length} 条，其中 ${risk.unanswered} 条未见公开回应`,
      note:
        '只报条数与「素材里有没有收录到公开回应」，不下「有没有风险」的结论。' +
        '争议段没有日期字段，因此这里给不出时效曲线 —— 分项名也就不叫「时效」。',
      anchor: 'sec-controversies',
      anchorLabel: '争议与回应'
    })
  } else {
    gaps.push({
      label: '争议状况',
      reason: '本报告生成于「争议与回应」段上线前，没有这一段的数据（与「本次确认没有争议」不是一回事）。'
    })
  }

  return { axes, gaps, ready: axes.length >= MIN_AXES }
}
