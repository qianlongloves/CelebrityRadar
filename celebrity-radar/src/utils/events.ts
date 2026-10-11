import { table } from './db'
import { useAuth } from '@/stores/auth'

/** 埋点事件枚举（§3.8）。阶段 4 起用报告成本事件，阶段 7 全量接入。 */
export type TrackEvent =
  | 'search'
  | 'disambiguate_selected'
  | 'report_hit_cache'
  | 'report_generate'
  /**
   * 本次刷新被「只升不降」拦下（P0，2026-10-09）：缓存里那版含会员段落，本次较简略的
   * 产物没有覆盖它。单列一个事件是为了能算比例 —— 命中率高的说明提示词/档位设计有问题，
   * 用户在反复点「刷新最新」却拿不到会员段落。
   */
  | 'report_kept_member'
  /**
   * 全检索源都没抓到内容、改由模型的已有知识兜底（C，2026-10-10）。
   * 单列一个事件是为了盯住「查不到」的真实比例：它偏高说明检索侧（源 / 档位 / 台阶）还不够，
   * 而不该把这份内容当成一份正常报告来读 —— 它未经核实、也不进共享缓存。
   */
  | 'report_knowledge_fallback'
  /**
   * 本次生成出来了、但没达到最低交付要求（2026-10-10，判定见 utils/report.ts#reportShortfall）。
   * 这一笔**不消耗用户次数**，单列出来是为了盯住两个数：
   *   · 比例过高 ⇒ 提示词 / 模型 / 上游检索出了问题，该修；
   *   · 比例正常 ⇒ 说明这道「不达标不计费」的门槛正按预期兜住偶发的残报告。
   * props.reason 直接记判定给的那句话（如「实质条目不足（1/3）」），便于归类。
   *
   * 注：批 2 的 `report_refresh_cooled` 已随「重新生成随时可用」一起撤掉（2026-10-10）——
   * 免费档冷却从硬拦截降级为弹窗里的一句提醒，不再产生该事件。
   */
  | 'report_generate_shortfall'
  /**
   * 本次生成不达标但可重试、由系统自动重跑一次（P2，2026-10-11，见 utils/cache.ts 的 shortfall 分支）。
   * 与 report_generate_shortfall 的关系：先打 retry（尝试补救），补救仍不达标才打 shortfall（最终放弃）。
   * 单列出来是为了盯「自动重跑」的触发率与成功率：触发率过高说明上游抖动频繁、该修通道；补救后仍大量
   * 打 shortfall 说明抖动是持续性的，光重跑一次不够。
   */
  | 'report_generate_retry'
  | 'follow'
  | 'unfollow'
  | 'favorite'
  | 'refresh_feed'
  | 'share'
  /* 周报：与 report_generate 分开计，避免污染「报告缓存命中率」这一成本口径 */
  | 'weekly_generate'
  /* 消息中心：看的是入口使用率（props.unread 记录打开时还有几条未读） */
  | 'messages_open'
  /* AI 问答：刻意与 report_generate 分开计 —— 问答不消耗生成额度，混在一起会带偏成本口径。
     props.passages 记录本次实际拼进 prompt 的资料条数（判断检索是否真的筛掉了东西）。 */
  | 'report_qa_ask'
  /* 主题知识库：看的是词云点击转化（props.from 区分入口是报告页还是直接打开）。 */
  | 'topic_open'

/** 非阻塞埋点：失败静默（埋点不允许影响业务路径） */
export function track(event: TrackEvent, props: { personKey?: string; [k: string]: unknown } = {}): void {
  try {
    const id = `${Date.now()}#${Math.random().toString(36).slice(2, 8)}`
    const openid = useAuth.getState().userId
    void table('events')
      .insert({
        id,
        openid,
        event,
        person_key: props.personKey ?? null,
        props,
        created_at: new Date().toISOString()
      })
  } catch {
    /* 静默 */
  }
}
