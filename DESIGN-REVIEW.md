# 名人雷达 · 设计评审问题台账

本文件记录一次全仓设计/业务逻辑评审（2026-10-09）发现的问题，以及逐条的修复状态。
**改动本文件时请同步更新「状态」列**，并在「修复记录」小节写明改了什么、为什么。

- 评审范围：端上 `src/`（页面 / 组件 / utils）、云端 `cloudfunctions/`（10 个云函数）、测试 `test/`
- 严重度口径：
  - **P0** 会造成真实损失（付费内容永久丢失、缓存被击穿、信任边界崩塌）
  - **P1** 功能承诺落空、成本可被放大、计费不一致
  - **P2** 口径/边界/体验隐患
- 状态取值：`待修` / `修复中` / `已修` / `待决策`（需改动架构，须先确认方案） / `不改`（确认为有意设计）

---

## 一、P0

| 编号 | 严重度 | 问题 | 关键证据 | 触发条件 / 影响 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | P0 | 抢锁时把 `report` 清成 `null`，导致「只升不降」守卫在真实时序下**永远进不去** | `src/utils/cache.ts:226`（`acquire` 写入 `report: null`）、`:265-271`（`saveReady` 读到的即该行）、`:129-135`（守卫要求 `state === 'ready'`） | 免费档对含会员段的报告点「刷新最新」→ 守卫失效 → 会员版被免费版覆盖，全站会员永久失去会员段（报告长期复用、不自愈）。另：生成失败时 `release()` 删整行，缓存内容一并消失 | 已修 |
| P0-2 | P0 | `report_cache` / `feed_cache` 对客户端是「所有人可读、登录可写」，而云端又把这两张表当事实源 | `cloudfunctions/dbInit/schema.js:18-22`（ACL 定义）、`:111`、`:142`；端上经 `src/utils/db.ts:250` 直连云数据库 | 任意登录用户可覆盖任意 `personKey`：伪造报告正文（内容安全/诽谤）、删掉会员段、写 `state=building` 制造全站等待。且 `quotaGuard` 的免计费复核读的正是这张表 | 方案 B 已实施，待发布后收紧权限 |
| P0-21 | P0 | 非端上云函数（`payCallback` + 4 个定时任务）不校验调用方，端上可任意触发 | `cloudfunctions/payCallback/index.js`（无调用方判断）、`notifyFollowUpdates` / `keywordAlert` / `riskWatch` / `hotBoardRefresh` 同 | ① **给自己发货**：任何登录用户用开发者工具调 `payCallback`，传 `{returnCode:'SUCCESS', resultCode:'SUCCESS', outTradeNo:<自己刚下的单>, totalFee:<单金额>}` —— 金额天然对得上（单是自己下的），直接白拿会员；② 循环触发 3 个定时推送 = 把上游检索额度与订阅推送配额交给任何人点火；③ 端上 `hotBoardRefresh` 带 `force` 可跳过 20 小时幂等闸门，循环重建烧光额度 | 已修 |

## 二、P1

| 编号 | 严重度 | 问题 | 关键证据 | 触发条件 / 影响 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P1-3 | P1 | 会员「补齐」免计费恒不生效：端上「先落库、后申请」，云端复核读到的已是含会员段的新版 | `src/utils/cache.ts:468`（先 `saveReady`）→ `:504-507`（后申请）；`cloudfunctions/quotaGuard/index.js:173-176`（复核要求该行**不含**会员段） | 会员每次替全站升级共享缓存都被扣一次每日次数；`utils/quota.ts:33-35` 的承诺从未兑现 | 已修 |
| P1-4 | P1 | 防滥用闸是 TOCTOU：「先读计数、判超限、再自增」，并发窗口内一批请求全部放行 | `cloudfunctions/aiProxy/index.js:226-236`（`readQuotaCount` → 判定 → `bumpAbuseCount`） | 把计数打到 39 后一次性并发 100 个 chat，全部读 39 < 40 而放行，成本「硬边界」被放大 N 倍 | 已修 |
| P1-5 | P1 | `action: 'search'` 完全没有闸门：不判产品额度、不写 `ai_calls`、不要求 openid | `cloudfunctions/aiProxy/index.js:425-461`（`handleSearch`）；`quotaGate` 只在 `handleChat` 调用（`:564`） | 改包以 `{action:'search', count:20}` 循环调用即可无上限消耗博查资源包 | 已修 |
| P1-6 | P1 | 退款链路缺失：`refunded` 是死状态，无任何路径撤销会员 | `cloudfunctions/payCallback/index.js:281`（只读不写）；全仓无 `refunded` 写入方 | 在微信商户平台退款后业务侧无感知，用户按原 `expires_at` 继续白享会员（云端判会员读权威表），只能人工改库 | 已修 |
| P1-7 | P1 | 发货补偿缺失 + 权威/镜像双写非原子 | `cloudfunctions/payCallback/index.js:208`（两次独立写）、`:284`（仅靠微信重试）；定时任务无一处理 `orders` | 重试耗尽后订单永久停在 `granting`（付了钱没拿到会员）；`users.membership` 写失败则云端认会员、端上显示免费，长期不一致且无对账 | 已修 |
| P1-8 | P1 | 报告页 force 刷新失败会把用户正在读的报告整体清空 | `src/pages/report/index.tsx`（先 `setState({phase:'loading'})` 丢弃当前报告）→ `src/utils/cache.ts:332`（force 跳过缓存兜底） | 断网/上游抖动一次，就把「本来能读的报告」变成「生成失败」空态 | 已修 |

## 三、P2

| 编号 | 严重度 | 问题 | 关键证据 | 触发条件 / 影响 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P2-9 | P2 | 上游欠费（402）/ 资源包耗尽（403）被归成 `kind: 'quota'`，端上当作用户额度用完并跳过纯文本降级 | `cloudfunctions/aiProxy/index.js:388-390`、`:592-594`；`src/utils/report.ts` 的降级分支 | 平台自己的账户问题被说成「你的额度用完了」，且不降级、不重试，用户无从判断 | 已修 |
| P2-10 | P2 | 端上 `todayKey()` 用设备本地时区、云端固定 UTC+8，两处计数主键可能不同 | `src/utils/time.ts` vs `cloudfunctions/quotaGuard/index.js:64-66`、`aiProxy/quota.config.js:67-69` | 非东八区或用户改设备日期时，界面显示还有额度而云端拒绝（或反之） | 已修 |
| P2-11 | P2 | 三个定时推送 `where({xxx_ok:true}).limit(100).get()` 且无 `orderBy`，`alert_ok`/`risk_ok` 无索引 | `keywordAlert/index.js:286`、`riskWatch/index.js:416`、`notifyFollowUpdates/index.js:161` | 授权用户超过 100 人后，第 100 个之后的人静默收不到提醒，且无任何报错 | 已修 |
| P2-12 | P2 | 会员「补齐」文案硬编码「三段」，而实际存在的段落是按 `memberLocked` 动态拼的 | `src/pages/report/index.tsx:997-998`、`:1637-1638` vs `src/utils/member.ts` 的 `memberLocked` | 承诺三段可能只给到一段（缓存那版只有其一即算会员版） | 已修 |
| P2-13 | P2 | 「近期争议与回应」缺键时整卡不渲染（只有 `length === 0` 才有文案） | `src/pages/report/index.tsx:1493-1500` | 存量 v1 报告恒缺该键 ⇒ 合规相关段落被静默隐藏，被读成「此人无争议」 | 已修 |
| P2-14 | P2 | 问答链路失败既不计数也不设冷却（`report.ts` / `weekly.ts` 都设了） | `src/utils/qa.ts:862-863`；对比 `src/utils/report.ts`、`src/utils/weekly.ts` 的 `setCooldown('llm')` | 上游故障期用户可每 3 秒重复打出一次真实付费调用（检索 + 大模型） | 已修 |
| P2-15 | P2 | ask 闸门「先读、后成功自增」，`busy` 只防同一面板连点 | `src/utils/qa.ts:589-614`、`:627-633` | 同账号多端并发可超发（与 P1-4 同源，属「成功才计数」的固有代价） | 已修（端上收窄，见批次 5） |
| P2-16 | P2 | 检索素材与用户提问原样拼进提示词，无注入隔离；语料来自全局共享缓存 | `src/utils/qa.ts:240-263`、`:466-472` | 一次「投毒」经共享缓存长期对全体用户生效，模型被要求标 `[n]` 出处 ⇒ 捏造内容被渲染成「有报道佐证」 | 已修 |
| P2-17 | P2 | 消歧候选 `name` 与用户输入无相关性约束；`name` 含 `#` 会破坏 `parsePersonKey` 反解 | `src/utils/disambiguate.ts:20-24`；`src/config/domains.ts:79-81` | 重名场景可能生成/命中「错的人」的报告 | 已修 |
| P2-18 | P2 | 底部「刷新最新」常驻可点且会员无冷却，与顶部刻意撤销热区的取舍自相矛盾 | `src/pages/report/index.tsx:2061` vs `:907-909`；`src/utils/cache.ts:186-191`（冷却只对非会员） | 会员误触一次即烧一笔生成 | 已修 |
| P2-19 | P2 | `waiting` 态文案承诺「无需刷新，生成完成后会自动展示」，但页面无任何轮询 | `src/pages/report/index.tsx:324`、`:1041`；`src/components/report-loading/index.tsx:61-62` | 他人长期持锁时成为死胡同，唯一出路是退出重进 | 已修 |
| P2-20 | P2 | iOS 虚拟支付无平台门禁；`payCreate` 的 `unconfigured` 未被端上识别，技术文案直接弹给用户 | `src/utils/pay.ts:245`、`src/pages/member/index.tsx:259` | iOS 审核驳回 / 支付能力受限风险；用户看到内部配置指引且无明确出路 | 已修 |

---

## 四、待实测确认（非代码缺陷，需运行环境验证）

| 编号 | 事项 | 为什么重要 | 状态 |
| --- | --- | --- | --- |
| V-1 | 对不存在的 `_id` 执行 `doc(id).update()`，在 wx-server-sdk 上是返回 `stats.updated === 0` 还是**抛错** | `aiProxy.bumpAbuseCount`（`:168-183`）与 `quotaGuard.incr`（`:83-107`）都依赖「返回 0 而不是抛错」。若实际抛错，则每个用户每天**首次**调用都会走进 catch（只记 warn 并放行），配额行永远建不起来 ⇒ 两道云端闸门静默失效 | 已修（批次 6：代码层对两种行为**均免疫**，无需再等真机确认） |

---

## 五、修复记录

### 批次 1（2026-10-09）—— 共享缓存与云端闸门

对应编号：**P0-1、P1-3、P1-4、P1-5**

| 编号 | 改了什么 | 涉及文件 |
| --- | --- | --- |
| P0-1 | ① `acquire` 抢占时不再清空 `report`（只改 `state`/`builder`/`generated_at`）；② `release` 改为「有旧内容就退回 `ready` 把锁让出去，确实没内容才删行」，不再整行删除；③ `shouldKeepMemberVersion` 允许 `state === 'building'`（抢占后这一行承载的就是「即将被覆盖的那一版」）；④ 命中保留时必须**放锁**（`keptReport` 与 `saveReady` 的 kept 分支都调 `release`）—— 该路径修好后第一次真正可达，否则那一行会以 `building` 残留到超时 | `src/utils/cache.ts` |
| P1-3 | 「只升不降」判定与免计费申请**一起提到落库之前**，并在同一份行快照上完成（顺带省掉一次读库）：云端复核此刻读到的仍是旧版本，条件 3 得以成立 | `src/utils/cache.ts` |
| P1-4 | 防滥用闸改为**先自增、再按自增后的值判定**；`bumpAbuseCount` 返回自增后的计数（读不到时返回 `null` ⇒ 放行，保持「限速不拦人」的降级哲学） | `cloudfunctions/aiProxy/index.js` |
| P1-5 | `handleSearch` 接入 `quotaGate(purpose = 'aux')`：要求 `openid`，不重复扣产品额度，只受防滥用限速闸；会员身份在同一次请求内只读一次库（与 `cap` 判定共用） | `cloudfunctions/aiProxy/index.js` |

### 验证（批次 1）

| 项 | 结果 |
| --- | --- |
| 全量测试 | **406 / 406 通过**（批次 1 之前为 399 条；新增 7 条：`04-member-cache.js` 4 条、`07-cloud-authority.js` 3 条） |
| 新增端到端用例 | `04-member-cache.js` 的「只升不降 · 端到端」：`__seed` 一份含会员段的旧报告 → 非会员 `force` → 断言交回 `keptMember`、会员段仍在、免费档内容一个字都没写进去、`state` 落回 `ready`（没残留 `building`）；另有一条会员 `force` 反向用例，确认闸门只拦降级 |
| 用例有效性自检 | **把 `shouldKeepMemberVersion` 退回旧判定（要求 `state === 'ready'`），新用例立刻变红** —— 确认它不是「假绿」（上一轮的 P0 之所以带着 399 条全绿上线，就是因为只有纯函数单测 + 读源码字符串） |
| search 闸门回归 | `07-cloud-authority.js`：读不到 openid ⇒ `kind:'auth'` 且**零上游请求**；`ai_calls` 打满 ⇒ `kind:'abuse'` 且零上游请求；正常一次调用会在 `ai_calls` 留下 `count: 1` |

### 批次 2 备选方案：P0-2 共享缓存写入权限收紧（2026-10-09 设计）

#### 一、威胁模型：收紧权限到底能挡住什么

先厘清一个容易高估的点：**收紧 ACL 不等于「缓存内容变可信」**。报告由端上 `buildReport` 生成（`src/utils/report.ts`），云端从未见过完整报告 —— 所以能加的只是「接口层的校验」，不是「内容可信」。

| 编号 | 攻击（当前全部可行） | 收紧 + 云函数写口能否挡住 |
| --- | --- | --- |
| T1 | 覆盖任意 `personKey` 的报告正文（伪造结论 / 诽谤 / 内容安全风险），全站可见 | **只能部分挡住**：写口可限「只能写自己持锁的那一行」+ 形状 / 体积白名单，但「生成一份低质或误导内容」本就是产品允许的行为，除非把生成搬上云（方案 C），否则无法根治 |
| T2 | 非会员把**伪造的会员段**（`memberNotes` / `conflicts`）写进共享行 | **能挡死**：写口按权威 `memberships` 判定，产物含会员段而调用者非会员 ⇒ 直接拒绝。这是本轮**最实的增量** |
| T3 | 把 `state` 改回 `ready` / 直接删行，击穿全站缓存 ⇒ 每次访问都重新生成（烧 LLM 费用） | **部分**：写口不接受端上直接改 `state`（状态只经 acquire / release / save 三态迁移）；但「抢锁触发重新生成」本身就是产品功能，残留威胁交给每日额度 + `ai_calls` 限速（B8）承担 |
| T4 | 伪造 `builder` 抢锁 ⇒ 他人报告页卡在「生成中」（`waitForReady` 轮询至多 30s） | **能挡死**：`builder` 由服务端写成 `getWXContext().OPENID`，端上无法伪造；`release` 只能放自己的锁 |
| T5 | 把这两张表当网盘（超长字段 / 灌大量行） | **能挡住**：写口加字段白名单与体积极限 |
| T6 | 事后追责（谁、何时、写了哪一行） | **能**：写口天然留审计（`openid` + `personKey` + 时间），直连数据库完全做不到 |

#### 二、方案对比

| 方案 | 做法 | 收益 | 成本 / 风险 | 结论 |
| --- | --- | --- | --- | --- |
| **A 独立写口函数** | 新增云函数 `reportStore`（`op: acquire / release / save`）；ACL 改为「所有人可读、**不可写**」；端上 `cache.ts` 三处写改调该函数 | 攻击面从「数据库直连」收敛为「带校验的接口」；T2 / T4 / T5 / T6 挡死 | 新增 1 个函数（~250 行）+ 1 次部署 + 一份重复骨架 | 可行，但要多养一份骨架 |
| **B 并入 `aiProxy`** | 同 A，落在 `aiProxy` 的 `action: 'report'`，复用其 `getWXContext().OPENID` 校验、`isActiveMember`、`quotaGate`、`ai_calls` 限速、`{ ok, kind, error }` 约定 | 与 A 相同；零新增部署单元、无重复骨架、写入天然纳入既有防滥用限速 | `aiProxy` 职责由「AI 代理」扩为「AI 代理 + 共享缓存写口」；部署包略大 | **本轮推荐** |
| **C 生成上云**（根治） | `aiProxy` 新增 `action: 'generate'`：云端做「检索 → LLM → sanitize → 落库」，端上只发 `personKey / name / focus` | 内容不再由端上构造，端上彻底退出共享缓存写入；锁 / 状态 / 会员段过滤全在权威侧；连「端上持提示词」这一更深的问题一并解决 | **云函数超时是硬阻碍**：生成含检索 + LLM（`chatJSON` 内部还有 3 次重试），端上可无限跑，云函数默认 20s；要落地必须配套「任务表 + 轮询」的异步架构，并把 `report.ts`（~1100 行）+ 提示词搬进云端 | 本轮不做，记为路线图 |

**方案 B 的关键设计点**（无论 A / B 都要遵守）：

1. 写口**不接受 `state` / `builder` 参数** —— 这两个字段只由云端按 `op` 自行推导，端上无从伪造（T3 / T4）。
2. `save` 必须校验「调用者 == 该行 `builder`」，且**以锁行为准取 `personKey`**，不接受端上另传的 `id`（否则等于开放任意行改写）。
3. `save` 的校验顺序：持锁 → 体积极限（建议 100KB，`callFunction` 链路官方建议值）→ 顶层字段白名单 → 含会员段则要求权威会员。
4. 云端**不复制**端上那份 zod schema（云端是 CommonJS，`src/utils/report.ts` 是 TS，无法直接 import）：只做「形状 + 体积 + 会员一致性」的轻校验，重校验仍由端上 zod 承担。该轻校验的目的不是「内容合规」，而是防「绕过端上直接打写口」这一类调用，把云端代码量控制在 ~150 行。
5. 写口调用按 `purpose: 'aux'` 计入限速（不占产品额度：生成额度已在 `generate` 侧记过）。
6. 「只升不降」（`shouldKeepMemberVersion`）与免计费复核一并落到云端判定：云端看到的是**权威且最新**的那一行，比端上快照更准；`quotaGuard#memberUpgradeWaived` 依赖「写入前那一行不含会员段」，因此**申请必须与 save 同一次调用内、在写入之前完成**。

#### 三、实施顺序（**不可颠倒**，否则会打掉正在使用的旧版本）

1. `cloudfunctions/dbInit/schema.js` 的 `ACL`（现仅 `publicRead` / `cloudOnly`，见 `:20` / `:28`）新增 `publicReadOnly = { read: true, write: false }`；同步改 `README.md` 权限表（`:424-425`、`:453`）与控制台指引 —— **文档先行，权限最后收紧**。
2. 端上 `cache.ts` 三处写改调写口，并且**写失败必须降级为「本次不缓存、但照常把报告返回给用户」**，绝不能抛。
   ⚠ 现状恰恰相反：`acquire` 写失败会 `throw`（`src/utils/cache.ts:225`、`:248`）→ 权限一旦收紧，**未更新的客户端报告页会直接不可用**（不是降级，是报错）。这是本方案最大的落地风险。
3. 发版，并观察客户端覆盖率（需要旧版占比数据）；**覆盖不到阈值就不能执行第 4 步**。
4. 控制台手工把 `report_cache` / `feed_cache` 改成 `{"read": true, "write": false}`（权限无接口可编程设置，见 `README.md:453`）。
5. 跑 `dbInit` 巡检，核对权限与字段落地（`:497-498` 已输出 `permissions_manual` 供人工比对）。

#### 四、切片建议

`feed_cache` 与 `report_cache` **不必同时切**：

| 表 | 写入点 | 有会员差异 | 有锁 | 先切的理由 / 顾虑 |
| --- | --- | --- | --- | --- |
| `feed_cache` | 端上 2 处（`cache.ts:827`、`:878`）+ 云端 `notifyFollowUpdates`（云函数不受 ACL 影响） | 无 | 无 | 结构最简单，适合先把「写口 + 发版 + 收紧」这条流程跑通；需先确认**旧版** `refreshFeed` 写失败时的降级行为 |
| `report_cache` | 端上 3 处（`acquire` / `release` / `saveReady`）+ 云端 `quotaGuard` 只读 | 有（`memberNotes` / `conflicts`） | 有（`state` / `builder`） | 是 P0-2 的主体（T2 的价值全在这里），但兼容性风险也全在这里 |

#### 五、决策结论（2026-10-09）

| 决策点 | 结论 | 落地位置 |
| --- | --- | --- |
| 方案 | **B：并入 `aiProxy`**（`action:'report'`）—— 零新增部署单元、复用会员判定与限速骨架 | `cloudfunctions/aiProxy/report-store.js`（新增）+ `index.js` 接线 |
| 切片 | **两张表一起切** | `dbInit/schema.js` 把 `report_cache` / `feed_cache` 都改成 `ACL.publicReadOnly` |
| 旧版兼容 | **先降级发版，覆盖率达标后再收紧** | 端上 `cache.ts#acquire` 由「失败即抛」改为三态（新增 `degraded`） |

实现要点：写口不接受端上传 `state` / `builder`；`save` 以**锁行**取 `personKey` 并校验 `builder === openid`；校验顺序「持锁 → 体积 100KB → 形状 → 会员一致性」；限速走独立计数键 `openid#日期#store`（150/日，不挤占 chat / search 的 `ABUSE_LIMITS`）。

端上三态语义（`src/utils/report-store.ts` 的唯一职责）：`rejected`（写口明确拒绝）**不回退直写**；`unavailable`（未部署 / 网络）才回退 —— 两者混同就等于绕过写口刚拦下的那道校验。

实施中实测补上的一处：`personKey` 必须在写口入口统一校验（原先只有 `save` / `saveFeed` 校验），否则空串会成为合法 `_id` 建出一行垃圾锁，而调用方还以为自己抢到了锁。

#### 六、上线前的待办（**顺序不可颠倒**）

- [x] 写口 + 端上双路（写口优先、回退直写）+ 降级（照常出报告，只是不进缓存）
- [x] 测试：`test/cases/08-report-store.js`（写口校验 + 端上三态 + 降级不变量）
- [ ] 部署 `aiProxy`（含 `report-store.js`）
- [ ] 发布端上并观察旧版本覆盖率
- [ ] **覆盖率达标后**，控制台把 `report_cache` / `feed_cache` 改成 `{"read": true, "write": false}`
- [ ] 跑 `dbInit` 巡检比对 `permissions_manual`

⚠ 在最后两步之前，两张表**仍是客户端可写**（`schema.js` 只声明目标状态；权限必须手工设置，且没有接口可改）。这是刻意的：先收紧会让未更新的客户端一进报告页就写锁失败，直接拿不到报告。

### 批次 3（2026-10-09）—— 支付售后闭环 + 非端上云函数调用方守卫

对应编号：**P0-21、P1-6、P1-7**。方案决策（问答确认，三问均选 A）：

- **q1 调用方判据** —— 非端上云函数（`payCallback` + 4 个定时任务）本轮一并加校验，判据 =
  `getWXContext().OPENID` 是否为空（端上调用必带，定时器 / 微信回调 / 控制台「云端测试」都不带）。
  4 个定时任务直接拒绝端上调用；`payCallback` 用环境变量 `PAY_CALLBACK_GUARD` 灰度
  （默认 `log` 只记日志，观察后再切 `strict`）。
- **q2 退款感知** —— 靠运营写口：`payCallback` 内新增 `adminOp:'refund'`（口令 `PAY_ADMIN_TOKEN`，
  语义同 `DB_ADMIN_TOKEN` 的 fail-closed）。
- **q3 撤销口径** —— 按订单 `days` 扣减：`expires_at = max(now, 原有效期 − 该单天数)`，
  只退掉这一单买的天数。

| 编号 | 改了什么 | 涉及文件 |
| --- | --- | --- |
| P0-21 | ① `notifyFollowUpdates` / `keywordAlert` / `riskWatch` 的 `exports.main` 顶部拒绝带 `openid` 的调用；② `hotBoardRefresh` 只拦端上 `force`（**保留**端上 `action:'ensure'` 冷启动补跑链路）；③ `payCallback` 新增 `callerGuard()`：`PAY_CALLBACK_GUARD` = `log`（默认，只记）/ `strict`（拒绝，返回非 0 让微信可重试）/ `off`（不判） | `payCallback/index.js`、`notifyFollowUpdates/index.js`、`keywordAlert/index.js`、`riskWatch/index.js`、`hotBoardRefresh/index.js` |
| P1-6 | ① `revokeOrder`：扣减基数取**权威** `expires_at`，`max(now, base − days×DAY_MS)`；只对「确实发过货」的单动手（`granted_at` 有值 或 权威行 `last_order_id` 命中）；② 撤销幂等改用权威行 `refunded_orders` 名单，且**与扣减写在同一行 `set` 里**；③ 运营写口 `adminOp:'refund'`（拒绝 `granting` 中间态）+ `adminOp:'reconcile'`；④ 对账 `reconcileRefunds` 扫 `refunded` 且无 `refund_revoked_at` 的单 | `payCallback/after-sales.js`、`payCallback/index.js`、`dbInit/schema.js` |
| P1-7 | ① `reconcileStaleGrants`：`granting` 且超过微信重试窗口（30 分钟）⇒ 补发货 + 置 `paid`；② `reconcileMirrors`：权威与镜像不一致 ⇒ **以权威覆盖镜像**（单向，绝不反向信镜像）；③ `cloudbaserc.json` 加定时触发器 `payReconcile`（每小时第 15 分）并把 `payCallback` 超时提到 60 秒 | `payCallback/after-sales.js`、`cloudbaserc.json` |

实施中修正的一处（评审结论外的自检发现）：撤销的幂等标记最初打算用订单行的 `refund_revoked_at`，
但「扣权威」与「写订单标记」之间没有事务 —— 一次中途失败（例如 `users` 写不进去）就会让下一轮
**再扣一次天数**，用户付过钱的天数被吃掉两遍。改为把 `refunded_orders` 名单与扣减写在同一行
`set` 里（`memberships` 是 upsert），于是「扣了」与「记了」必然同时发生；
`writeMembership` / `grantMembership` 同步保留该字段（`set` 是全量覆盖，漏一次就等于清空幂等凭据）。

### 验证（批次 3）

| 项 | 结果 |
| --- | --- |
| 全量测试 | **470 / 470 通过**（批次 1 后为 406 条；本批新增 64 条） |
| 新增用例 | `test/cases/09-pay-after-sales.js` 四段：**调用方闸门**（默认 log 放行并记日志 / `strict` 拒端上 / 放行非端上 / 换事件形状也绕不过 / `off` 不判）、**退款写口**（未配 token 拒、口令不符拒、已发货扣减且同步镜像、未发货不碰会员、`granting` 拒、重复幂等 `already`、缺 `outTradeNo` / 未知 `adminOp` 拒）、**定时对账**（补发货、窗口内跳过、镜像被改以权威覆盖、权威缺镜像补、仅镜像伪造不反向、退款扣减幂等、`users` 故障自愈后不再扣、单条故障不拖垮整轮）、**定时任务闸门**（3 个函数拒绝端上 + `hotBoardRefresh` 端上不许 `force`） |
| 用例有效性自检 | 「撤销中途失败」那条用例：若改回用订单标记去重，日志会显示**再扣一遍**天数 —— 用例变红，确认它钉住的正是「幂等不能靠第二次写」 |

### 批次 4（2026-10-09）—— 剩余 P1/P2 收尾

对应编号：**P1-8、P2-9、P2-10、P2-11、P2-14**。

| 编号 | 改了什么 | 涉及文件 |
| --- | --- | --- |
| P1-8 | ① `cache.ts` 新增 `cachedFallback()`：force 失败时交回缓存里原有那一版 + `refreshFailed` / `refreshError`（冷却 / 配额 / 抢锁异常 / 构建失败四条失败分支统一走它）；② 新增纯函数 `refreshFailureNote(outcome)`（成功返回 null，「正在生成」返回 null）；③ 报告页加 `hasReportRef` + `refreshing` / `refreshError`：force 时不清屏、按钮转圈、底部提示条可重试 | `src/utils/cache.ts`、`src/pages/report/index.tsx`、`index.scss` |
| P2-9 | ① `aiProxy` 检索 403、LLM 402、LLM 403 一律 `kind:'upstream_quota'`（原 403 落 4xx 兜底 = `upstream` = 端上白重试三次）；② 注释明确 `quota` **只**指用户产品额度；③ `report.ts` 降级白名单加 `upstream_quota`（不降级，但文案保持上游原文，不换成「你的额度用完了」） | `cloudfunctions/aiProxy/index.js`、`src/utils/report.ts`、`src/utils/llm.ts` |
| P2-10 | 端上 `todayKey()` 改为显式 UTC+8（`Date.now() + 8h` 的 ISO 日期段），不再依赖设备时区；`qa.ts` 删掉本地 `dayKey()` 与 dayjs 依赖，统一走 `utils/time` | `src/utils/time.ts`、`src/utils/qa.ts` |
| P2-11 | 三个定时任务内联 `listAll(collection, where)`：按 `_id` 升序 `skip/limit` 翻页、达 `MAX_ROWS=5000` 告警；**以空页为终止条件**；`schema.js` 给 `users` 补 `idx_alert_ok` / `idx_risk_ok` | `notifyFollowUpdates/index.js`、`keywordAlert/index.js`、`riskWatch/index.js`、`dbInit/schema.js` |
| P2-14 | ① `chatText` 失败分支补 `retryable`（与 `ChatJSONResult` 同口径）；② `qa.ts#askReports` 最前加 `cooldownMinutesLeft('llm')` 闸门，失败时按 `retryable || /频繁\|429/` 置 `setCooldown('llm')`，与 `report.ts` / `weekly.ts` 完全一致 | `src/utils/llm.ts`、`src/utils/qa.ts` |

实施中修正的一处：`listAll` 最初的终止条件是「这一页不满 `PAGE_SIZE` 就收工」。但一次 `get`
能取回多少行由平台决定（小程序端 20 / 服务端默认 100），平台给不满时就会**提前收工** ——
那正是 P2-11 的老毛病换个样子回来。改用「空页收尾」，代价是多一次空查询。内存 DB harness
（单页硬上限 20）正是靠这条才能验证「150 个订阅者全都读到」。

### 验证（批次 4）

| 项 | 结果 |
| --- | --- |
| 全量测试 | **484 / 484 通过**（批次 3 后为 470 条；本批新增 14 条） |
| 新增用例 | `01-pure`（`todayKey` 钉 UTC+8 + 源码禁止回落 dayjs）、`03-quota-qa`（问答失败冷却：retryable 进冷却 / 配置类不进）、`04-member-cache`（force 失败交回旧版 + 放锁 + `refreshFailureNote` 各态；`memberLocked` 交回口 5 → 6）、`07-cloud-authority`（402 / 403 / 检索 403 → `upstream_quota`，5xx 仍是 `upstream`；端上 `upstream_quota` 不重试且文案原样）、`09-pay-after-sales`（`notifyFollowUpdates` 150 人全部读到 + 三函数翻页源码钉 + 索引存在） |
| 用例有效性自检 | `notifyFollowUpdates` 那条：内存 DB 单页只给 20 行，改回裸 `limit(100)` 时 `res.users` 立降到 20，用例变红 |

### 批次 5（2026-10-09）—— 剩余 P2 收尾

对应编号：**P2-12、P2-13、P2-15、P2-16、P2-17、P2-18、P2-19、P2-20**。

| 编号 | 改了什么 | 涉及文件 |
| --- | --- | --- |
| P2-12 | 保留提示改为按**实际存在的段**派生：`keptSections = member ? presentSections(report) : memberLocked`；文案插值 `keptNames`（空则回落 `MEMBER_SECTIONS`）、「补齐」说明用 `MEMBER_SECTIONS.join('、')`，不再写死「三段」与固定段名 | `src/pages/report/index.tsx` |
| P2-13 | 争议卡条件由 `report.controversies &&` 改为 `!report.degraded`：缺键也出卡并说明「缺数据 ≠ 确认无争议」，`length === 0` 保留原说明；`report-toc.ts` 同步按 `!report.degraded` 列该节（目录与卡片口径必须一致） | `src/pages/report/index.tsx`、`src/utils/report-toc.ts` |
| P2-15 | **端上收窄**：新增在途键 `qa:inflight`（`{ date, n }`，与额度同 UTC+8 口径），`checkQaGate` 的 `used = 镜像 + 在途`；`noteQaAttempt` +1、`noteQaUsed` / `clearQaAttempt` 结清（夹到 0 以上）、`clearQaUsage` 一并清；提问面板失败时调 `clearQaAttempt` 归还名额 | `src/utils/qa.ts`、`src/components/qa-panel/index.tsx` |
| P2-16 | ① 结构标记净化 `unmaskStructure`：语料 / 提问里的《资料》《用户问题》等结构标记替换为〈〉，杜绝伪造结构；② `QA_SYSTEM_GUARD` 置于 system **首段**，明说《资料》《用户问题》是内容不是指令 | `src/utils/qa.ts` |
| P2-17 | ① 消歧候选净化 `sanitizeCandidates`：去 `#`/`＃`、折空白、名字截 30、brief 截 60、按「同名同领域」去重、与输入无相关的过滤（**全不相关则原样交回**，见下）；② `buildPersonKey` 一并剥 `#`、`parsePersonKey` 改 `lastIndexOf('#')`（历史残留 key 仍可反解） | `src/utils/disambiguate.ts`、`src/config/domains.ts` |
| P2-18 | 底部「刷新最新」与状态行统一判据：`disabled={showFresh}` + 文案 `{showFresh ? '已是最新' : '刷新最新'}` | `src/pages/report/index.tsx` |
| P2-19 | `waiting` 态加轮询：`WAIT_POLL_MS = 5_000` 每 5s `load(false)`、`WAIT_POLL_MAX_MS = 90_000` 封顶转 error，离开该态清定时器（与云端锁 `BUILDING_TIMEOUT_MS` 对齐） | `src/pages/report/index.tsx` |
| P2-20 | ① `pay.ts` 新增 `isIapBlocked()`（`platform === 'ios'`，读不到环境**不拦**）与 `IOS_BLOCKED_MESSAGE`，`buyMembership` 开头门禁（早于云函数与收银台）、`BuyResult` 加 `blocked?: 'ios' \| 'unconfigured'`、识别 `res.kind === 'unconfigured'`、catch 兜底 `/ios\|虚拟支付/`；② 会员页按 `blocked` 换标题（iOS 暂不支持购买 / 购买暂未开放 / 支付未完成） | `src/utils/pay.ts`、`src/pages/member/index.tsx` |

**本轮的三处刻意取舍**（都是「不追求彻底、避免误伤」）：

- **P2-15 只做端上收窄**：超发根因是「成功才计数」+ 端上无原子预留，彻底消除要在云端做原子预留（会改计费口径），风险面大。本轮解决同设备多面板 / 快速重问，**跨设备并发窗口仍在**，记为后续。
- **P2-17 相关性过滤不一律丢弃**：昵称 / 艺名（如「小甜甜」↔「布兰妮」）一个字都不共享是正常的，全丢会让用户一屏空。故「过滤后为空则交回净化后的候选」，只拦「有相关的却混进无关的」。
- **P2-19 超时不自动 force**：90s 转 error 并给出「刷新最新」入口，不给被锁定的人自动烧一笔生成（与 P1-8「宁可不刷新也不清屏」同源）。

### 验证（批次 5）

| 项 | 结果 |
| --- | --- |
| 全量测试 | **518 / 518 通过**（批次 4 后为 484 条；本批新增 34 条） |
| 新增用例 | `01-pure`：**消歧净化**（P2-17，10 条：`#`/`＃` 剥离后主键仍单分隔符、空白折叠、30/60 截断、清空丢弃、去重、相关性过滤「有相关的只留相关的 / 全不相关原样交回」）、**iOS 支付门禁**（P2-20，6 条：devtools 不拦 / `ios` 大小写不敏感 / 读不到环境不拦 / iOS 早于云函数拦下 / `unconfigured` 换文案 / 未选套餐拒）、**报告页源码钉住**（P2-12/13/18/19，4 条）；`03-quota-qa`：**在途计数**（P2-15，8 条：占位 / 计入闸门 / 归还 / 夹到 0 / 结清 / 不参与展示 / 跨天归零 / 清空一并清）、**提示词注入隔离**（P2-16，4 条：system 首段存在 / 资料标记净化后只剩结构头一个 / 问题标记同样净化 / 素材原文照传交给 system 兜底） |
| 旧用例口径修正 | 本次改动改变了旧口径，同步修 2 条并各补新断言：① `buildPersonKey` 现剥 `#` ⇒ 期望改 `'AB#ent'` + 新增「历史残留 `#` 仍按最后一个 `#` 反解」；② `sec-controversies` 现按 `!report.degraded` 渲染 ⇒ 从「不列」名单移除 + 新增「缺键也列、降级简版不列」 |
| 测试基建 | `test/harness/env.js` 新增 `setTaroOverride(name, value)`（`resetData` 清空）：Taro 默认替身对任何 API 都返回 `undefined`，测不到「跟运行环境分叉」的分支（如 P2-20 的 iOS 判定），需能临时指定返回值 |
| 本轮口径与文档同步 | `README.md` / `README.en.md` / `CONTRIBUTING.md` / `CHANGELOG.md` / `SECURITY.md` 的用例数 / 文件数按 518 / 9 更新 |

### 批次 6（2026-10-09）—— V-1 代码层免疫（云端闸门「首行建不起来」）

对应编号：**V-1**（原为「待实测」，本次改为**不依赖真机结论**即闭环）。

| 编号 | 改了什么 | 涉及文件 |
| --- | --- | --- |
| V-1 | 把「行不存在时 `doc(id).update()` 返回 `updated===0`」这一**未证假设**从代码里摘掉：新增提纯的 `incrAbuseRow(key)` / `incrExistingRow(coll,id)`，语义只保留「自增有没有落实」，**把抛错一律归一成 0（未落实）**。于是「返回 0」与「抛错」两种真机行为下，`bumpAbuseCount` / `quotaGuard.incr` 都会照常走「插首行」分支 —— 首次调用不再被异常吞掉、计数行必定建起来 | `cloudfunctions/aiProxy/index.js`、`cloudfunctions/quotaGuard/index.js` |

为什么这是**真修复而非防御性摆设**：修复前的语义是「首个 `update` 一旦抛错 ⇒ 整趟作废」。对 `bumpAbuseCount` 而言，抛出会被外层 catch 兜成 `null`（**放行**），而那一行从未被创建 ⇒ 之后每次调用都重复同一路径 ⇒ 防滥用计数**永远停在 0**，这道「成本硬边界」静默消失；对 `quotaGuard.incr` 而言，抛出会让 `exports.main` 返回 `ok:false` ⇒ 端上静默回退本机计数（`generate_quota` 恒为 0，多设备口径兜底失效）。两处受影响的都正是**全站成本/计费**，且只在真机上才会发生 —— 属「测试全绿也测不出」的那一类（内存 DB 此前只复刻了「返回 0」一支）。

### 验证（批次 6）

| 项 | 结果 |
| --- | --- |
| 全量测试 | **522 / 522 通过**（批次 5 后为 518 条；本批新增 4 条，均在 `07-cloud-authority.js` 的「V-1」段） |
| 新增用例 | ① aiProxy 防滥用：不存在行 update 抛错也**补建首行并计数**（不是每日首次都放行）；② aiProxy 防滥用：行已存在时照常拦（`kind=abuse`、零上游请求）；③ quotaGuard 首行计数：抛错也建首行且 `count=1`；④ quotaGuard 常态自增：行已存在时不受开关影响（4→5，`created=false`） |
| 测试基建 | `test/harness/cloud-db.js` 新增 `__setMissingDocUpdateThrows(on)`（`__reset` 清空）：复刻「不存在行 update 抛错」这一支，让此前从未被跑过的代码路径进入覆盖 |
| 用例有效性自检 | 把两处 `catch` 从「归一成未落实」退回归「重新抛出」，**恰好这 2 条「抛错分支」用例报红**（另 2 条走常规路径的仍绿）—— 确认用例钉住的正是 V-1，而非顺带绿 |
| 行为不变性 | 「行存在 → 常规自增」与「行不存在 → 返回 0 再 add」两条既有路径逐字未改，批次 1~5 相关用例全绿 |

### 后续批次

P0 / P1 / P2 已全部收敛（P0-1、P0-2、P0-21、P1-3~P1-8、P2-9~P2-20 均已修）；V-1 已在批次 6 用代码免疫。

**仅剩一项非编码事项**：

1. **人机协作部署**（顺序不可颠倒，详见批次 2 第六节）—— 部署 `aiProxy`（含 `report-store.js`）+ `payCallback`（含 `after-sales.js`）+ 3 个定时函数 + `hotBoardRefresh` + `dbInit`；配置环境变量 `PAY_CALLBACK_GUARD`（观察后切 `strict`）与 `PAY_ADMIN_TOKEN`；**发布端上后**看旧版本覆盖率，达标再把 `report_cache` / `feed_cache` 在控制台收紧为 `{"read": true, "write": false}`，最后跑 `dbInit` 巡检 `permissions_manual`。
