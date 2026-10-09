# 名人雷达 · 第二轮全文复审（批次 9）

- 复审日期：2026-10-09
- 范围：`cloudfunctions/` 全部 16 个云函数的关键路径 + `src/utils`(49) + `src/pages`(19)
- 编号：继续沿用 `DESIGN-REVIEW.md` 的全局序列（上批收敛到 P1-9 / P2-26），本轮从 **P1-10、P2-27** 起
- 口径：只收「**不报错的静默缺陷**」——日志干净、界面正常，但数据被漏读/漏写/覆盖/错算，或某个限制从未生效

## 一、覆盖说明（如实交代）

- **已读实**：`payCallback`（含 `after-sales.js`）、`payCreate`、`quotaGuard`、`notifyFollowUpdates`、
  `keywordAlert`、`riskWatch`、`hotBoardRefresh`、`dbInit`、`contentCheck`；端上 `time`/`cooldown`/
  `quota-guard`/`risk-watch`/`keyword-alert`/`cache` 相关段。
- **未彻底覆盖**（文件过大，本轮达上下文上限）：`report.ts`(68KB)、`qa.ts`(50KB)、`llm.ts`(27KB)、
  `cache.ts` 全量、`pages/report/index.tsx`(119KB)。本文件的「无发现」不涵盖这几处，下一轮优先。

## 二、发现清单

| 编号 | 级别 | 位置 | 现象 / 触发 | 影响 | 建议 |
| --- | --- | --- | --- | --- | --- |
| **P1-10** | 高（资损向） | `payCallback/index.js:112-119`、`:122-136`、`:213-221` | `readMembership` 把**所有**读库异常吞成 `null`，「瞬时读失败」与「从没发过货」不可区分；`writeMembership` 用 `doc().set()` **全量覆盖**，且只在 `Array.isArray(m.refunded_orders)` 时写该列，而分支②（`:213-221`）**根本没带** | 一旦读失败或走分支②，`refunded_orders`（「这几单已扣过天数」的唯一凭据）被清空 ⇒ 下一轮对账**再扣一次**用户已付天数 | `readMembership` 改走 `where({_id})`（无匹配不抛错，能与「读失败」干净区分，读失败即抛触发微信重试）；`writeMembership` 在调用方未带名单时**先读回**再写，永不抹列 |
| **P2-27** | 中 | `payCreate/index.js:159-181` | 每次调用无条件 `add` 新单，无 pending 去重。连点/重试会堆出多张 `pending` 单 | 用户可能对同一档付两次（两单各有独立 `outTradeNo`，各自发货 ⇒ 天数叠加） | 下单前复用近期未付单：创建成功后把 `payment` 落库，10 分钟内同 `openid+plan` 的 pending 单直接返回同一份支付参数 |
| **P2-28** | 中 | `notifyFollowUpdates/index.js:260-273` vs `:275-319` | 先把新条目写回 `feed_cache`，**之后**才推送；某用户推送遇瞬时错误（非 43101）时该条已进 `prevUrls` | 该用户的这条更新**永远不会再推**，日志只有一行 skipped，无告警 | 把缓存写回挪到「该人物所有订阅者都尝试过推送」之后 |
| **P2-29** | 中 | `keyword-alert.ts:185-191`、`risk-watch.ts:109-124`；云端 `keywordAlert/index.js:251`、`riskWatch/index.js:345` | 端上是「先查数、再插入」，无并发保护；并发双击可写入第 6 条，而云端 perUser 判定会把第 6 行**整行忽略** | 用户界面显示「已开始监测」，云端永不扫描，三层都不报错 | 插入后复查计数，超出上限则删除刚插入的行并如实报错 |
| **P2-30** | 中 | `cache.ts:39`、`:843-849`；`quotaGuard/index.js:239`；`cooldown.ts:11` | `DAILY_REFRESH_LIMIT` 与十分钟冷却只在端上判；`quotaGuard` 对 `refresh` 只自增不判 | 改包可无限刷新（上游检索成本）；真实上限只剩服务端强判的 `generate` 池（3/日） | `quotaGuard` 为 `refresh` 一并返回**服务端权威 `allowed`**，端上直接采用（不再本地算数）；冷却口径落文档 |
| **P2-31** | 低 | `keyword-alert.ts:91/125` vs `keywordAlert/index.js` | `KEYWORD_MAX_CHARS=12` 只有端上校验，云端无长度判定 | 改包可订阅超长「词」，每词仍占一次上游检索预算 | 云端补长度判定，超长整行忽略并记 `summary.invalid` |
| **P2-32** | 低 | `hotBoardRefresh/index.js:336-344` | 幂等闸门是「读 `generated_at` → 比较 → 写」，无抢锁 | 多端冷启动同时 `ensure` 会重复全量检索+生成（成本，非数据错） | 用 `generated_at` 做条件更新抢锁，抢不到即视为已有他人构建 |
| **P2-33** | 低 | `dbInit/index.js:341-345` | `looksLikeExists` 按 errmsg 关键字（`exist\|duplicate\|冲突`）启发式判「索引已存在」 | 其它错误里恰好含这些词会被记成 `exists` ⇒ 索引静默缺失，相关查询退化为全表扫 | 只认明确的 errcode；认不出就如实上报 `unknown`，不写 `exists` |
| **P2-34** | 低 | `dbInit/index.js:260`、`:430` | 注释称「由 main 的 try/catch 转成返回体」，但 `exports.main` **没有**最外层 try/catch；`currentEnv` 抛错会直接冒泡 | 运维工具抛异常而非返回 `{ok:false}`，输出不可读 | 给 `main` 补最外层 try/catch，与注释一致 |
| **P2-35** | 低 | `after-sales.js:226-254` | `reconcileMirrors` 用批量读到的 `auth` 快照写镜像 | 与并发发货/退款竞争时镜像写入陈旧值；靠下一轮自愈（非永久） | 每行重新读一次权威再比对（行数上限 100，成本可接受） |
| **P2-36** | 低 | `risk-watch.ts:224-231`、`feed/index.tsx:27-38`、`mine/index.tsx:38`、`member/index.tsx:152`、`index/index.tsx:114`、`alerts/index.tsx:197` | 展示层用**设备本地时区**（`getMonth/getDate/getHours`） | 跨时区用户看到的「今天」徽标与日期标签可能差一天；同一份数据在不同设备上结论不同 | 展示层时间口径统一走 `utils/time.ts` 的 UTC+8 |

## 三、已在册、仍属「现存问题」的部署项（非本轮新发现）

| 项 | 位置 | 状态 |
| --- | --- | --- |
| `PAY_CALLBACK_GUARD` 默认 `log`（只记不拦，端上仍可伪造回调发货） | `payCallback/index.js:283` | 待确认真机回调不带 openid 后切 `strict` |
| `memberships` / `report_cache` / `feed_cache` 权限需控制台手工收紧 | `dbInit/schema.js` | 代码侧无法声明，只能人机协作 |
| `contentCheck` 对上游故障 fail-open | `contentCheck/index.js:17` | 有意取舍，已记录 |

## 四、修复进度（批次 9）

（本条随修复推进更新；未动行为 ☐，已修复为 ☑）

| 编号 | 状态 | 落地位置 | 用例 |
| --- | --- | --- | --- |
| P1-10 | ☑ | `payCallback/index.js`：`readMembership` 改 `where({_id})`（无匹配返回 `null`、读失败抛出）；`writeMembership` 未带名单时先读回再写；分支②补注释 | `06-pay-callback.js`（新增 `__setReadFailing` 故障注入） |
| P2-27 | ☑ | `payCreate/index.js`：`PENDING_REUSE_MS` / `findReusablePending` / `savePaymentParams` | `10-pay-create.js`（新文件） |
| P2-28 | ☑ | `notifyFollowUpdates/index.js`：先推送、后写回 `feed_cache`；`retryPersons` 本轮不写回 | `09-pay-after-sales.js` |
| P2-29 | ☑ | `keyword-alert.ts` / `risk-watch.ts`：插入后复核计数，超限撤回刚插的行并报错 | `02-data.js` |
| P2-30 | ☑ | `quotaGuard/index.js#judgeLimit`（`refresh` 回报 `limit`/`allowed`）+ `quota-guard.ts` 透传 + `cache.ts#tallyRefreshQuota` 采用云端判定（旧版云函数回落同源常量） | `07-cloud-authority.js`、`05-feed-cost.js` |
| P2-31 | ☑ | `keywordAlert/index.js`：`MAX_KEYWORD_CHARS=12`，超长整行忽略并计入 `summary.invalid` | `09-pay-after-sales.js` |
| P2-32 | ☑ | `hotBoardRefresh/index.js`：`acquireBuildLock` / `releaseBuildLock`（`_id='building'` + TTL 兜底死锁） | `09-pay-after-sales.js` |
| P2-33 | ☑ | `dbInit/index.js#indexAttemptAction`：`created` / `exists` / `unknown` 三档，收窄匹配词，拿不准顶到 `needs_review` | `11-db-init.js`（新文件） |
| P2-34 | ☑ | `dbInit/index.js`：抽出 `runDbInit(event)`，`exports.main` 补最外层 try/catch | `11-db-init.js` |
| P2-35 | ☑ | `after-sales.js#reconcileMirrors`：写镜像前按 `_id` 重读权威、再比对一次 | `09-pay-after-sales.js` |
| P2-36 | ☑ | `utils/time.ts` 新增 `dayKey8`/`shortDay8`/`sameDay8`/`formatMoment8`/`todayLabel8`；`mine`/`member`/`index`/`alerts`/`feed` 改用 | `01-pure.js` |

**验证**：`npm test` 全绿 —— **572 / 572（11 个用例文件）**，本轮为 11 项改动新增 20 条用例。
测试基建新增 `db.__setReadFailing(表, on)`：只让读抛错、写照常成功，用来把「读失败」与「行不存在」分开
（`__setFailing` 读写一起断，测不出 P1-10 的差别）。

**至此第二轮（P1-10、P2-27~P2-36）全部收敛**；剩余仍只有第三节列出的「人机协作部署项」。
