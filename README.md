# 名人雷达（Celebrity Radar）

> 微信小程序：输入任意名人名字 → 联网检索近期公开报道 → 大模型提炼成结构化报告；
> 并在此之上提供关注流 / 周报、AI 提问、舆情（关键词预警 / 风险监控 / 事件时间线）、
> 会员与支付、名言卡分享等能力。技术形态为 **Taro 3（React + TypeScript）+ 微信云开发（CloudBase）**。

本 README 面向「懂前端与微信小程序、但第一次接触本项目」的开发者，目标是**照着做能把项目跑起来**。
文中每一条命令、路径、环境变量名、集合名、云函数名、定时器名都以仓库内文件为准（出处见各节括号）。

> ⚠ **这是一份可编译运行的完整代码，不是可以直接上线运营的产品。**
> 仓库里**没有任何可用凭据**：`appid`、云开发环境 ID、上游 API Key 全部是占位符或空值，需要你自备。

> 📁 **仓库布局**：本 README 位于**仓库根目录**；小程序工程本体（`package.json`、`src/`、`cloudfunctions/` 等）
> 都在 **`celebrity-radar/` 子目录**里。因此**所有 `npm` / `taro` 命令都要先 `cd celebrity-radar` 再执行**
> （仓库根目录**没有** `package.json`）；下文引用工程内文件时，路径一律**从仓库根写起**（如 `celebrity-radar/src/...`）。

---

## 目录

- [1. 这是什么](#1-这是什么)
- [2. 技术栈与运行环境](#2-技术栈与运行环境)
- [3. 快速开始（最小可跑）](#3-快速开始最小可跑)
- [4. 云开发配置（最容易卡住的一节）](#4-云开发配置最容易卡住的一节)
- [5. 订阅消息（可选功能）](#5-订阅消息可选功能)
- [6. 测试与常用脚本](#6-测试与常用脚本)
- [7. 成本与合规提示](#7-成本与合规提示)
- [8. 目录结构](#8-目录结构)
- [9. License](#9-license)

---

## 1. 这是什么

一款**名人动态情报台**微信小程序。核心链路是「搜索 → 消歧 → 联网检索 → 大模型生成 → 结构化报告 → 缓存复用」，
并在此之上叠加浏览、沉淀与提醒。以下功能均以代码实际存在为准（页面见 `celebrity-radar/src/app.config.ts`，云函数见 `celebrity-radar/cloudfunctions/`）：

| 能力 | 说明 | 主要落点 |
|---|---|---|
| **报告生成** | 博查联网检索 → 素材分组、分批注入提示词 → LLM 生成结构化 JSON → 字段校验 + 来源 URL 白名单清洗 → 逐段卡片渲染。报告是**全局共享缓存**（同一人物只生成一次，所有用户复用） | `pages/report`、`cloudfunctions/aiProxy`（`action:'report'`） |
| **端上聚合卡** | 人物速览 / 立场与舆情 / 风险雷达 / 商业价值速览等，**纯端上聚合**，复用已有缓存、不新增模型调用 | `pages/report` 及 `src/utils/*` |
| **关注 / 聚合流 / 周报** | 关注列表 + 变化概览 + 聚合流（下拉刷新有每日次数上限）；周报汇总关注对象最近 7 天动态 | `pages/following`、`pages/weekly`、`src/utils/{follows,weekly}.ts` |
| **AI 提问** | 选名人后就其缓存报告追问，走推理型模型；与「生成」不是同一个额度池 | `pages/ask`、`pages/qa`、`cloudfunctions/aiProxy`（`chat`） |
| **收藏 / 历史** | 四类收藏（名言 / 报告 / 动态 / 时间线）+ 浏览历史（保留最近若干条） | `pages/collection`、`pages/records`、`pages/history` |
| **消息中心** | 关注更新 / 周报提醒 / 平台公告 / 关键词预警的时间流；已读只存本机 | `pages/messages` |
| **热门榜** | AI 每日生产的榜单（`hot_board`），全员可见全部位数 | `pages/index`、`cloudfunctions/hotBoardRefresh` |
| **关键词预警** | 订阅关键词 → 云函数每日定时按词检索 → 端上列出新增条目并推送 | `pages/alerts`、`cloudfunctions/keywordAlert` |
| **名人风险监控** | 盯住某个人 → 每日定时按人检索 → 命中司法 / 税务 / 合作 / 维权 / 表态类词时汇总并推送（**只陈述命中与出处，不评级、不预测**） | `pages/alerts`、`cloudfunctions/riskWatch` |
| **舆情事件聚簇 / 时间线** | 定时**读库**把「同一件事的多条来源」聚成事件；事件时间线独立二级页 | `pages/opinion`、`pages/event`、`cloudfunctions/opinionCluster` |
| **对比 / 主题知识库** | 两名人横向对比（只读缓存、零模型调用）；把缓存报告按话题重新编目 | `pages/compare`、`pages/topic` |
| **会员与支付** | 会员额度分档 + 微信支付下单 / 回调发货 / 退款对账（可选启用） | `pages/member`、`pages/orders`、`cloudfunctions/{payCreate,payCallback}` |
| **名言卡分享** | Canvas 2D 端上出图分享 + 原生转发，落地页为具体人物报告页 | `src/utils/share-card.ts`、`src/components/share-poster` |

小程序共 **22 个页面**、**4 个 tab**（发现 / 提问 / 舆情 / 我的）；云侧 **14 个云函数**、**22 张数据库集合**。

---

## 2. 技术栈与运行环境

| 项 | 取值 | 出处 |
|---|---|---|
| 框架 | Taro 3.6（`@tarojs/*` `^3.6.25`）+ React 18 + TypeScript 5.4 | `celebrity-radar/package.json` |
| 构建器 | webpack5（由 `@tarojs/webpack5-runner` 提供） | `celebrity-radar/config/index.js`、`celebrity-radar/package.json` |
| UI / 状态 / 工具 | Taro UI `^3.0.8`、zustand `^4.5.2`、zod `^3.23.8`、dayjs | `celebrity-radar/package.json` |
| 云后端 | 腾讯云 CloudBase（微信云开发）；云函数运行时 **Nodejs16.13** | `celebrity-radar/cloudbaserc.json` |
| 云函数 SDK | `wx-server-sdk`（`aiProxy` 要求 `^4.0.1`，用云开发 AI 通道） | `celebrity-radar/cloudfunctions/aiProxy/package.json` |
| 小程序 appid / 基础库 | 占位 `wx0000000000000000`；`libVersion` `3.7.12` | `celebrity-radar/project.config.json` |
| Node.js | **未在 `celebrity-radar/package.json` 声明 `engines`**；Taro 3.6 + webpack5 建议用 **Node 16 或 18 LTS**（云函数运行时为 16.13）。👉 **确切最低版本需自行确认** | — |
| 微信开发者工具 | 任意较新稳定版；用其导入下面的「小程序子目录」并开通云开发 | — |

> 小程序子目录下的 `.npmrc`（`celebrity-radar/.npmrc`）设了 `legacy-peer-deps=true`，`npm install` 会自动读取，无需手动加参数。

---

## 3. 快速开始（最小可跑）

### 3.1 你需要自备什么

- 一个**微信小程序 appid**（真机预览 / 上线必需；本地调试可先用占位值）。
- 一个**云开发环境（CloudBase）**（数据库与云函数都跑在这里）。
- 一个**博查（Bocha）API Key**（联网检索；不配则检索为空、报告缺素材）。

### 3.2 安装与运行

```bash
# 在本 README 所在的仓库根目录下，先进小程序子目录：
cd celebrity-radar
```

> ⚠ **注意仓库根与小程序子目录的区别**：本 README、`LICENSE`、`NOTICE` 在**仓库根目录**；
> 而 `package.json`、`cloudfunctions/`、`src/` 等都在 **`celebrity-radar/` 子目录**里。
> 所有 `npm` 命令都要先 `cd celebrity-radar` 再执行（仓库根目录**没有** `package.json`）；
> 微信开发者工具也导入**这个子目录**，而不是它的上级目录。

```bash
npm install                                     # .npmrc 已开 legacy-peer-deps

# 复制三份「模板 → 本地文件」（三份都已被 .gitignore 忽略）：
cp src/config/local.example.ts         src/config/local.ts                     # 见 3.3
cp .env.example                        .env                                    # 见 4.2
cp project.private.config.example.json project.private.config.json             # 可选：开发者工具私有配置
# Windows PowerShell 请把 cp 换成 Copy-Item。

npm run build:weapp                             # 生产构建，产物输出到 dist/
```

> 上述 `cp` / `npm` 命令都在 **`celebrity-radar/` 子目录内**执行（即上一步 `cd` 之后的工作目录）。

然后在**微信开发者工具**里导入 `celebrity-radar/` 这个目录 —— `celebrity-radar/project.config.json` 声明了
`miniprogramRoot: dist/` 与 `cloudfunctionRoot: cloudfunctions/`，工具据此找到小程序产物与云函数。
开发期可在「详情 → 本地设置」勾选「不校验合法域名」先行联调（端上本身不直连上游，见 §7）。

### 3.3 三份本地配置（`cp` 出来的文件都不进版本库）

| 文件 | 必须 | 填什么 | 留空 / 未复制的后果 |
|---|---|---|---|
| `celebrity-radar/src/config/local.ts` | ✅ **必做** | 云开发环境 ID（`cloudbaseEnvId`）；订阅模板 ID；`webviewDomains`；`debug` 开关 | `celebrity-radar/src/config/public.ts` 直接 `import` 它——没复制会**编译报错** `Cannot find module './local'`。`cloudbaseEnvId` 保持占位串 `REPLACE_ME` 时视为云服务未配置：登录与全部 DB 调用不发起，「我的」页显示「云服务未配置」 |
| `celebrity-radar/.env` | ✅（部署云函数才需要） | 云函数部署密钥（博查 Key、各上游厂商 Key 等），由 `celebrity-radar/cloudbaserc.json` 以 `{{env.XXX}}` 引用 | 小程序仍能编译运行，但检索 / 生成 / 定时任务在调用上游时报错 |
| `celebrity-radar/project.private.config.json` | 可选 | 你自己的 appid 与开发者工具本机设置 | 不配则每次在工具里手动设 appid |

### 3.4 `.env` 必填 / 可空逐项说明

`.env` 由 `celebrity-radar/.env.example` 复制而来（**只在 `tcb fn deploy` 时被读取**，部署后固化进函数配置，本地无需长期保留）。
下表逐项说明「必填 / 可空 / 为空时什么功能降级」（变量名与注释出处：`celebrity-radar/.env.example`、`celebrity-radar/cloudbaserc.json`）：

| 变量 | 必填？ | 为空时的行为 |
|---|---|---|
| `TCB_ENV_ID` | 部署时必填 | 供 `celebrity-radar/cloudbaserc.json` 顶部 `envId` 引用；若你的 CLI 不解析它，可直接把该文件的 `envId` 写成环境 ID 字面值 |
| `BOCHA_API_KEY` | **必填** | 联网检索不可用 → 检索为空，报告缺素材、时间线不完整 |
| `SERPER_API_KEY` / `TAVILY_API_KEY` | 可选 | 第二检索源（博查抓空时的兜底）；**任填其一**即可，都不填 = 整条跳过（行为与没有它时一致） |
| `DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY` | 可选 | 外部大模型厂商 Key（DeepSeek / 智谱 / Kimi / 通义千问）。**配了哪家，「我的」页才出现哪家**；都不配则只剩默认的「云开发 AI」厂商（零 key） |
| `LLM_VENDOR` / `LLM_TIER` | 可选 | 默认厂商 / 默认质量档（端上没带、定时任务用的兜底） |
| `SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID` | 可选 | 三路订阅消息模板 ID；为空 = 推送功能未配置（授权按钮不渲染、定时任务只落站内数据并跳过推送）——详见 §5 |
| `WX_PAY_SUB_MCH_ID` / `PAY_CALLBACK_ENV_ID` | 可选 | 会员支付（服务商模式子商户号 + 回调所在云环境）；为空 = 会员支付不可用（不影响免费功能） |
| `WX_APPID` / `WX_APPSECRET` | 仅 `dbInit` 需要 | 换 `access_token` 建 / 改索引时用；不配 = `dbInit` 的索引动作无法程序化执行（仍可在控制台手工建索引） |
| `DB_ADMIN_TOKEN` | 仅 `dbInit` 写入需要 | `dbInit` 写操作口令；**未配置时写操作一律拒绝**（只读巡检不受限） |
| `PAY_ADMIN_TOKEN` | 仅 `payCallback` / `adminOps` 写入需要 | 支付售后 / 运营写口口令；**未配置时运营接口拒绝调用**（退款与手动对账等运营动作不可用，支付主链路不受影响） |
| `ADMIN_OPS_TOKEN` | 仅 `adminOps` 写入需要 | 运营写口口令（代理发货 / 对账等运维动作）；**未配置时运营接口拒绝调用** |
| `AI_PROXY_TEST_TOKEN` | 可选 | `aiProxy` 的 `test` 探针口令；**未配置时该动作一律拒绝**（这是期望的默认状态，业务链路不受影响） |
| `AI_PROXY_QUOTA_GUARD` | 可选（联调） | 额度闸门联调开关；留空/非 `off` 一律 = `on`（生产口径）。联调时才填 `off`，**上线前务必留空** |
| `AI_PROXY_RAW_LOG` | 可选（排障） | 上游报文原始日志，只有写 `on` 才开；默认关闭。排障完请改回空值并重新部署 |

> ⚠ `aiProxy` 还读取几个**可选**变量（如 `AI_PROXY_CHAT_DEADLINE_MS` 等），仓库未在 `cloudbaserc.json` 声明，按需在控制台追加。

---

## 4. 云开发配置（最容易卡住的一节）

顺序有依赖：**先建集合与权限、再部署云函数**，否则函数里的读写会静默失败。
会员支付、订阅推送与各定时任务都是**可选**的 —— 建议先把「搜人名 → 生成报告」这条主链路跑通，再回来配其余。

### 4.1 集合与权限（共 22 张）

集合真源是 **`celebrity-radar/cloudfunctions/dbInit/schema.js`**（库结构的「单一事实源」）。
**权限无法程序化设置** —— 微信没有对应接口，**必须在云开发控制台逐张手工配置**；`dbInit` 只能代劳**建集合**与**建 / 改索引**（详见 4.1.2）。

#### 4.1.1 22 张集合 + 5 类权限规则

`schema.js` 里共定义了 **5 类权限规则**（`ACL`），其中 `publicRead`（所有人可读、登录可写）**当前未被任何集合使用**
（历史遗留定义），实际使用的是另外 4 类：

| 档位（`schema.js` 的 `ACL`） | 安全规则（控制台「自定义」里填） |
|---|---|
| 仅创建者可读写（`creator`） | 控制台**预设**，直接选「仅创建者可读写」 |
| 本人可读、不可写（`selfRead`） | `{"read": "doc._openid == auth.openid", "write": false}` |
| 所有人可读、客户端不可写（`publicReadOnly`） | `{"read": true, "write": false}` |
| 客户端不可读写（`cloudOnly`） | `{"read": false, "write": false}` |
| ~~所有人可读、登录可写（`publicRead`）~~ | ~~`{"read": true, "write": "auth.openid != null"}`~~（**无集合使用**） |

逐张集合清单（顺序同 `schema.js`）：

| # | 集合 | 用途（摘自 `schema.js`） | 权限 |
|---|---|---|---|
| 1 | `users` | 账号与设置（首登写入）；`membership` 是端上读口的**镜像**，权威在 `memberships` | 仅创建者可读写 |
| 2 | `memberships` | 会员权益的**服务端权威**（`_id` = openid），只由 `payCallback` 发货 / 退款撤销时写 | 客户端不可读写（仅云函数） |
| 3 | `ai_calls` | 防滥用限速计数（`_id` = openid#yyyy-MM-dd），`aiProxy` 放行上游前就地原子自增 | 客户端不可读写（仅云函数） |
| 4 | `report_cache` | 报告缓存 + `building` 生成互斥锁（全局共享）：客户端只读，写入走 `aiProxy(action:'report')` | 所有人可读、客户端不可写 |
| 5 | `hot_board` | 热门名人榜（AI 每日生产，`_id` 固定 `latest` 覆盖写；端上只读） | 所有人可读、客户端不可写 |
| 6 | `feed_cache` | 检索结果结构化映射（不存 LLM 产物），全局共享：客户端只读，写入走 `aiProxy` 的 `saveFeed` | 所有人可读、客户端不可写 |
| 7 | `refresh_quota` | 关注流每日主动刷新 ≤ 10 次（`_id` = openid#yyyy-MM-dd） | 本人可读、不可写（写仅限云函数） |
| 8 | `generate_quota` | 报告每日生成配额（免费 3 / 会员 30） | 本人可读、不可写（写仅限云函数） |
| 9 | `ask_quota` | AI 提问每日配额（免费 5 / 会员 30，成功才计数） | 本人可读、不可写（写仅限云函数） |
| 10 | `follows` | 关注列表（`_id` = openid#personKey） | 仅创建者可读写 |
| 11 | `favorites` | 收藏（四类，`_id` = openid#type#hash 主键防重） | 仅创建者可读写 |
| 12 | `history` | 浏览历史（保留最近 50 条） | 仅创建者可读写 |
| 13 | `events` | 埋点（若干类事件） | 仅创建者可读写 |
| 14 | `orders` | 会员订单状态机（`pending → granting → paid` / `failed` / `refunded`）；端上只读 | 本人可读、不可写（写仅限云函数） |
| 15 | `keyword_watches` | 关键词订阅 + 名人监控（同表靠 `type` 区分：`keyword` / `person`） | 仅创建者可读写 |
| 16 | `keywords` | 关键词检索缓存（`_id` = 关键词哈希，全局共享，定时任务写、端上只读） | 所有人可读、客户端不可写 |
| 17 | `risk_scans` | 名人风险扫描快照（`_id` = personKey，云函数写、端上只读） | 所有人可读、客户端不可写 |
| 18 | `risk_signals` | 风险信号流水（`_id` = personKey#url 哈希，云函数写、端上只读） | 所有人可读、客户端不可写 |
| 19 | `deep_dive_quota` | 事件驱动深挖的单日预算计数（`_id` = yyyy-MM-dd），云函数写、客户端不可读写 | 客户端不可读写（仅云函数） |
| 20 | `opinion_events` | 舆情事件（`_id` = event_key，`opinionCluster` 定时读库聚类后写、端上只读） | 所有人可读、客户端不可写 |
| 21 | `opinion_event_status` | 用户对舆情事件的个人状态（已读 / 跟进，`_id` = openid，端上读写自己那一行） | 仅创建者可读写 |
| 22 | `person_assets` | 人物素材（头像 / 照片，`_id` = personKey），`aiProxy(action:'portrait')` 写、端上只读 | 所有人可读、客户端不可写 |

小结：仅创建者可读写 **7** 张（1、10、11、12、13、15、21）；所有人可读、客户端不可写 **8** 张（4、5、6、16、17、18、20、22）；
本人可读、不可写 **4** 张（7、8、9、14）；客户端不可读写 **3** 张（2、3、19）。合计 **22**。

> ⚠ **三处最容易出事的权限**（顺序不可颠倒，否则端上会写失败）：
> - 三张配额表（7/8/9）必须是「本人可读、**不可写**」，否则用户能自改额度；且**先部署 `quotaGuard`、再收紧权限**。
> - `memberships` / `ai_calls`（2/3）必须「**客户端不可读写**」——它们是会员身份与防滥用计数的服务端权威。
> - `report_cache` / `feed_cache`（4/6）是「所有人可读、**客户端不可写**」的共享缓存：**先部署带写口的 `aiProxy` 并发布端上，待旧版本覆盖率达标后，**再把权限收紧到 `{"read": true, "write": false}`。

#### 4.1.2 能程序化完成的：建集合、建索引

`dbInit` 是**运维函数、不是运行时依赖**（端上任何代码都不调用它）。能力边界（见 `celebrity-radar/cloudfunctions/dbInit/index.js` 头部）：

| 事项 | 能否程序化 | 说明 |
|---|---|---|
| 建集合 | ✅ | `db.createCollection()` |
| 字段比对 / 补字段（按 `schema.js` 的 `def`） | ✅ | 需带 `apply: true` |
| 建 / 改索引 | ✅（需 `access_token`） | 走微信云开发 HTTP API「更新索引」；**`wx-server-sdk` 本身没有索引 API** |
| **设置集合权限** | ❌ | **无对应接口，必须在控制台手工设置** |

常用 `action`：`report`（默认，只读巡检：集合有无 + 字段差异 + 索引计划 + **权限清单**）、
`init`（只建缺失集合）、`fields`、`indexes`、`sync`（= init + fields(apply) + indexes(apply)，一步到位）。
**默认是 dry-run**，只有显式传 `"apply": true` 才写库 / 调接口。

```bash
tcb fn deploy dbInit -e <环境ID>
# 只读巡检：先看缺什么（返回体里的 permissions_manual 就是要手工去控制台点的权限清单）
tcb fn invoke dbInit -e <环境ID> --params '{"action":"report"}'
# 建缺失的集合（写操作需带口令，须等于环境变量 DB_ADMIN_TOKEN）
tcb fn invoke dbInit -e <环境ID> --params '{"action":"init","token":"<口令>"}'
```

> 运维做完建议删除该函数：`tcb fn delete dbInit`。

### 4.2 云函数部署（共 14 个）

仓库用 **CloudBase CLI（`tcb`）** 部署。函数、环境变量、超时与定时器都声明在 `celebrity-radar/cloudbaserc.json` 里，
逐个 `tcb fn deploy <函数名>` 即可：

```bash
npm i -g @cloudbase/cli      # 只需一次
tcb login                    # 只需一次
tcb fn deploy aiProxy -e <环境ID>
# 其余同理：tcb fn deploy <函数名> -e <环境ID>
```

> 若改用**微信开发者工具「上传并部署」**，它**只上传代码、不读 `cloudbaserc.json`** ⇒ 环境变量、超时、触发器
> 都得去控制台逐项手工补。

14 个云函数及其**必填环境变量名**（以 `celebrity-radar/cloudbaserc.json` 的 `envVariables` 为准）：

| 云函数 | 用途 | 必填环境变量（`cloudbaserc.json` 已声明） | 触发 |
|---|---|---|---|
| `aiProxy` | 平台代付上游密钥（`search` / `chat` / `generate` / `aux` / `test` / `vendors`）+ 云端闸门 + 共享缓存写口（`action:'report'`） | `BOCHA_API_KEY`；外部厂商任配 `DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY`；可选 `SERPER_API_KEY` / `TAVILY_API_KEY` / `LLM_VENDOR` / `LLM_TIER` / `AI_PROXY_QUOTA_GUARD` / `AI_PROXY_TEST_TOKEN` / `AI_PROXY_RAW_LOG` | 端上调用 |
| `quotaGuard` | 配额计数权威（`refresh` / `generate` / `ask`） | 无 | 端上调用 |
| `contentCheck` | 内容安全机审（云调用 `security.msgSecCheck`） | 无（凭证由平台托管） | 端上调用 |
| `hotBoardRefresh` | 热门名人榜每日生产（写 `hot_board`） | `BOCHA_API_KEY` + 各厂 Key；可选 `LLM_VENDOR` / `LLM_TIER` | 定时 06:30 |
| `notifyFollowUpdates` | 关注更新订阅消息推送 | `BOCHA_API_KEY`、`SUBSCRIBE_TEMPLATE_ID` | 定时 09:00 |
| `keywordAlert` | 关键词舆情预警（写 `keywords`） | `BOCHA_API_KEY`、`ALERT_TEMPLATE_ID` | 定时 09:20 |
| `riskWatch` | 名人风险监控（写 `risk_signals`） | `BOCHA_API_KEY`、`RISK_TEMPLATE_ID` | 定时 09:40 |
| `opinionCluster` | 舆情事件落库（读库聚类，**不联网、零上游成本**） | 无 | 定时 10:00 |
| `payCreate` | 会员下单（服务端定价 + 云支付统一下单） | `WX_PAY_SUB_MCH_ID`、`PAY_CALLBACK_ENV_ID` | 端上调用 |
| `payCallback` | 支付结果通知 + 售后（退款 / 对账）；支付链路唯一后端 | `PAY_ADMIN_TOKEN`（运营写口口令） | 微信支付回调 + 定时对账 |
| `dbInit` | 运维工具：建集合 / 比对字段 / 建·改索引 | `DB_ADMIN_TOKEN`、`WX_APPID`、`WX_APPSECRET` | 手动 |
| `adminOps` | 运营写口（代理发货 / 对账等运维动作） | `ADMIN_OPS_TOKEN`、`PAY_ADMIN_TOKEN` | 手动 |
| `userInit` | 用户账号与个性化配置的**唯一写者**（首登初始化 / 缺键补齐 / 改配置） | 无 | 端上登录后调用 |
| `userBackfill` | 一次性运维：给存量用户补齐配置（幂等；不传 `apply:true` 为 dry-run） | 无 | 手动 |

> - 依赖配置真源的云函数需先跑 `npm run config:sync` 生成副本（见 §6）：`benefits.config.js` → `aiProxy`/`quotaGuard`/`payCreate`/`keywordAlert`/`riskWatch`；`user-defaults.config.js` → `userInit`/`userBackfill`。
> - `contentCheck` 依赖 `celebrity-radar/cloudfunctions/contentCheck/config.json` 的 `permissions.openapi`（`security.msgSecCheck`）随上传生效。

### 4.3 定时触发器（以 `cloudbaserc.json` 的 `triggers` 为准）

cron 为腾讯云 SCF 的 **7 字段**格式（秒 分 时 日 月 周 年）：

| 触发器名 | 所属云函数 | cron | 含义 |
|---|---|---|---|
| `dailyHotBoard` | `hotBoardRefresh` | `0 30 6 * * * *` | 每天 06:30 |
| `dailyNotify` | `notifyFollowUpdates` | `0 0 9 * * * *` | 每天 09:00 |
| `dailyKeywordAlert` | `keywordAlert` | `0 20 9 * * * *` | 每天 09:20 |
| `dailyRiskWatch` | `riskWatch` | `0 40 9 * * * *` | 每天 09:40 |
| `dailyOpinionCluster` | `opinionCluster` | `0 0 10 * * * *` | 每天 10:00 |
| `payReconcile` | `payCallback` | `0 15 * * * * *` | 每小时第 15 分 |

用 `tcb fn deploy` 部署时触发器随之上线；用开发者工具上传则需在控制台「定时触发器」里手工建。

### 4.4 云开发 AI 通道与「函数超时改 60s」

- **云开发 AI 通道（默认、零 key）**：在**云开发控制台开通 AI 能力**并确认模型可用；`aiProxy` / `hotBoardRefresh`
  用到的 `wx-server-sdk` 需 **≥ 4.0.1**（`celebrity-radar/cloudfunctions/aiProxy/package.json` 已声明 `^4.0.1`）。
- **函数超时必须改到 60 秒**：微信云开发给云函数配的**默认超时是 20 秒**，而 `cloudbaserc.json` /
  各函数 `config.json` 里写的 `timeout` **不随「开发者工具上传」生效**（实测仍是 20s）。生成报告属长任务，
  默认 20s 会被平台掐断，端上只会拿到 `-504003`（`FUNCTIONS_TIME_LIMIT_EXCEEDED`），函数自身来不及返回任何原因。
  配置路径：**云开发控制台 → 云函数 → aiProxy → 配置 → 超时时间 → 改 60 秒并保存**。
- **60 秒是上限**（微信云函数天花板，调不上去）。若已是 60 秒仍报 `-504003`，说明单次请求本身就超过了 60 秒 ——
  此时只能换质量档（如改用基础版 / 非推理模型）或把任务拆得更细，反复调超时是无效方向。

---

## 5. 订阅消息（可选功能）

**默认（三枚模板 ID 全留空）时的行为**：端上**授权按钮不渲染**（`notifyConfigured()` / `alertNotifyConfigured()` /
`riskNotifyConfigured()` 均为 false）；三个定时任务**只落站内数据并跳过推送**（在回执 `skipped` 里写明原因），
**站内功能完全可用**（预警页、事件时间线照常看得到）。**这是一个可正常运行的默认态，不是功能缺失。**

要启用推送，按**自己的服务类目**走这四步（缺一步都不行）：

1. **公众平台 → 功能 → 订阅消息 → 公共模板库**，按自己的服务类目挑选**字段是 `thing1`（提醒内容，≤20 字）+ `date2`（时间）**
   的那一类模板，申请 / 选用 **三枚不同的模板 ID**（关注更新 / 关键词预警 / 风险提醒各一枚）。
   > ⚠ **必须三枚不同**（标题可同、ID 不可同）：微信一次性订阅**一次授权只够推一条、且按模板消耗授权**，
   > 三个定时任务（09:00 / 09:20 / 09:40）共用一枚会导致先跑的吃掉授权、后跑的报 `43101`。
2. 把三个 ID 填进 `celebrity-radar/src/config/local.ts` 的三个字段（顺序：关注更新 / 关键词预警 / 风险提醒），
   并 **`cd celebrity-radar && npm run build:weapp` 重新编译**（这些值会编进包，热更新不生效）。
3. **云开发控制台 → 云函数 → 各自的「环境变量」**，按同名模板 ID 填写（必须与端上同模板）：
   `notifyFollowUpdates → SUBSCRIBE_TEMPLATE_ID`、`keywordAlert → ALERT_TEMPLATE_ID`、`riskWatch → RISK_TEMPLATE_ID`。
   漏填不会报错也不阻断：云函数只跳过推送。
4. **真机授权**：登录后点三处入口的授权按钮，确认 `users` 表对应行的 `subscribe_ok` / `alert_ok` / `risk_ok`
   已置 `true` —— 定时任务只给 `true` 的用户发。

对应的端上字段：`subscribeTemplateId` / `alertTemplateId` / `riskTemplateId`（见 `celebrity-radar/src/config/local.example.ts`）。

---

## 6. 测试与常用脚本

全部来自 `celebrity-radar/package.json` 的 `scripts`（先 `cd celebrity-radar` 再执行）：

| 脚本 | 命令 | 作用 |
|---|---|---|
| `npm test` | `tsc -p test/tsconfig.test.json && node test/run.js` | ① 用 tsc 把 `src` 编译到 `test/.build`；② 在 Node 里跑全部用例（`celebrity-radar/test/cases/*.js`）。测的是**产品代码本身**（`celebrity-radar/test/harness` 装好 `@tarojs/taro` 与全局 `wx` 替身） |
| `npm run test:only` | `node test/run.js` | 只跑用例，不重新编译（改动用例时用） |
| `npm run build:weapp` | `taro build --type weapp` | 微信小程序生产构建，产物 `dist/` |
| `npm run dev:weapp` | `npm run build:weapp -- --watch` | 开发模式（watch 监听，产物 `dist/`） |
| `npm run build:h5` | `taro build --type h5` | H5 端构建（调试用，云开发相关功能不可用） |
| `npm run config:sync` | `node scripts/sync-config.js` | **配置真源 → 云函数副本**：把端上真源 `celebrity-radar/src/config/benefits.ts`、`celebrity-radar/src/config/user-defaults.ts` 生成到各云函数目录下的 `*.config.js` 副本（幂等） |
| `npm run config:check` | `node scripts/sync-config.js --check` | **一致性校验**：只校验不写盘，有差异则打印并 `exit 1`（测试 / CI 用） |

**为什么要 `config:sync` / `config:check`**：云函数各自独立打包上传，且云环境里 `require` 不到端上的 TS，
所以「端上与云端同值」只能靠副本维持。改权益 / 价格 / 默认配置时：

```bash
# 在 celebrity-radar/ 子目录内执行：
# 1. 改 src/config/benefits.ts（或 src/config/user-defaults.ts）—— 数值只写这一处
npm run config:sync      # 2. 把副本刷进各云函数目录
npm test                 # 3. 用例会比对真源与副本，漏了第 2 步就红
# 4. 重新部署受影响的云函数（端上随下次发版生效）
```

> `aiProxy` 与 `hotBoardRefresh` 下的两份 `llm.config.js`（模型注册表）是**手工同步**的，不在 `config:sync` 范围内
> （即 `celebrity-radar/cloudfunctions/{aiProxy,hotBoardRefresh}/llm.config.js`）。

---

## 7. 成本与合规提示

### 7.1 上游检索 / 模型调用按次计费的地方

- **报告生成**：一次生成会触发「检索词规划 + 多路博查检索 + 分批大模型生成」，是本项目最大的单次成本来源。
- **定时扫描**：`hotBoardRefresh`（06:30）、`notifyFollowUpdates`（09:00）、`keywordAlert`（09:20）、`riskWatch`（09:40）
  每轮都会真实检索 / 调用上游。`opinionCluster`（10:00）**只读库聚类、不联网**，无上游成本。
- **事件驱动深挖**：`keywordAlert` / `riskWatch` 在**扫描命中时**才对内对象额外扩查一个查询词（`DEEP_DIVE`，见 `celebrity-radar/src/config/benefits.ts`），
  成本由**三层预算闸门**共同封顶：`queriesPerHit = 1`（每次命中最多扩查 1 个词）、`perRunMax = 6`（单轮最多 6 次）、
  `perDayMax = 60`（单日跨轮累计最多 60 次，计数落在 `deep_dive_quota` 集合）。按 ¥0.03/次估算，最坏约 **¥54/月**。
  **它是「命中才触发」而非「全量刷新」——这是成本可控的根本，不要改成全量刷新。**

上述额度、上限、报告预算等**数值真源都在 `celebrity-radar/src/config/benefits.ts`**，改它 → `npm run config:sync` → 重新部署对应云函数。
（免费 / 会员的产品额度、防滥用上限、单次检索条数上限等也在同一文件。）

### 7.2 合规设计（部署者需自行承担内容合规责任）

- **涉政涉军三层拦截**（端上 + 提示词）：① `celebrity-radar/src/utils/sensitive.ts` 的**本地静态拦截**（命中即拒答、**不发任何网络请求**）；
  ② 消歧提示词里「政治 / 军事类人物 → refused」规则；③ 报告提示词里「素材显示属政治 / 军事类敏感人物 → 整份拒答」。
  其中人物名单 `SENSITIVE_NAMES` 在仓库里是**空数组**（`TODO(运营)` 维护位），上线前需按最新合规要求自行补充。
- **云端内容安全机审**：`celebrity-radar/cloudfunctions/contentCheck` 通过云调用 `security.msgSecCheck` 对 AI 提问送检。
- ⚠ 报告内容由大模型基于公开信息生成，程序内已固定标注「AI 生成，仅供参考」。
  **本仓库不提供任何合规背书** —— 类目资质、内容审核、隐私协议、AI 生成内容标识等合规义务由**部署者自行确认与承担**。

---

## 8. 目录结构

下列路径相对**仓库根目录**；小程序工程本体位于 `celebrity-radar/` 子目录：

```
celebrity-radar/                ← 仓库根目录
├── README.md                   本文件（中文说明）
├── README.en.md                英文说明
├── LICENSE                     本项目的开源许可证（Apache-2.0）
├── NOTICE                      第三方依赖 / 服务 / 素材的署名
├── CHANGELOG.md  CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
├── assets/
│   ├── screenshots/            界面截图
│   └── CodeBuddyAssets/        项目自绘 SVG / PNG 素材
└── celebrity-radar/            ← 小程序工程本体（所有 npm 命令在此执行）
    ├── src/                    小程序源码
    │   ├── pages/              22 个页面（每个页面含 index.tsx / index.config.ts / index.scss）
    │   ├── components/         复用组件（自定义 tabBar、名言卡、头像、骨架屏等）
    │   ├── utils/              业务与工具逻辑（检索、报告、缓存、会员、支付、舆情、敏感词…）
    │   ├── config/             端上配置（public.ts 进包；local.example.ts 为模板；benefits.ts / user-defaults.ts 为配置真源）
    │   ├── stores/             zustand 状态（如 auth）
    │   ├── styles/  types/     样式变量与 TS 类型（types/db.ts 为数据库字段类型）
    │   └── app.config.ts       页面与 tabBar 声明
    ├── cloudfunctions/         14 个云函数（各自独立打包；dbInit/schema.js 为数据库结构真源）
    ├── scripts/                sync-config.js —— 配置真源同步到云函数副本
    ├── test/                   Node 端测试：cases/ 用例、harness/ 脚手架（taro 与 wx 替身）、run.js 入口
    ├── config/                 Taro 构建配置（index.js + dev.js / prod.js）
    ├── dist/                   构建产物（git 忽略）
    ├── cloudbaserc.json        云函数 / 环境变量 / 定时器声明（CloudBase CLI 部署读它）
    ├── project.config.json     微信开发者工具工程配置（miniprogramRoot / cloudfunctionRoot）
    ├── package.json            依赖与 scripts（npm 命令在此子目录执行）
    └── .env.example            云函数部署密钥模板（复制为 .env 使用）
```

---

## 9. License

本项目以 **Apache License 2.0** 开源，许可证全文见仓库根目录下的 [`LICENSE`](./LICENSE)。
`celebrity-radar/package.json` 的 `license` 字段为 `Apache-2.0`。

> ⚠ `LICENSE` 附录中的版权行目前是占位符（`Copyright 2026 <在此填写你的姓名或组织>`），
> **发布前请替换为你自己的姓名或组织名**。
