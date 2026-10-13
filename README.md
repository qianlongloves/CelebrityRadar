# 名人雷达（Celebrity Radar）

> 一个微信小程序：输入任意名人名字 → 联网检索近期公开报道 → 大模型提炼成结构化报告；
> 并在此之上提供关注流 / 周报、AI 提问、舆情监控（关键词预警 / 风险监控 / 事件时间线）、
> 会员与支付、名言卡分享等能力。技术形态为 **Taro 3（React + TypeScript）+ 微信云开发（CloudBase）**。

**中文** | [English](./README.en.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)

---

## 项目简介

名人雷达是一款「名人动态情报台」：**把一个名字，变成一份可读、可溯源、可复用的人物报告。**

- **给谁用**：想快速了解某位公众人物近期动态、立场、商业合作或风险信号的用户。
- **核心链路**：搜索 → 消歧 → 多路联网检索 → 大模型生成 → 结构化报告 → 全局缓存复用。
- **关键取舍**：报告是**全局共享缓存**（同一人物只生成一次，所有用户复用），单次生成成本被摊薄；端上大量卡片是对已有缓存的**本地聚合**，不新增模型调用。

> ⚠ 这是一份**可编译、可运行的完整代码**，不是可直接上线运营的产品。仓库里**没有任何可用凭据**：`appid`、云开发环境 ID、上游 API Key 全部是占位符或空值，需你自备。

> 本 README 位于**仓库根目录**；小程序工程本体（`package.json`、`src/`、`cloudfunctions/` 等）都在 **`celebrity-radar/` 子目录**里，**根目录没有 `package.json`** ⇒ 所有 `npm` 命令都要先 `cd celebrity-radar`。下文引用工程内文件时，路径一律**从仓库根写起**。

---

## 功能特性

下列功能均以代码中**实际存在**为准（页面见 `celebrity-radar/src/app.config.ts`，云函数见 `celebrity-radar/cloudfunctions/`）。

**报告与检索**

- **报告生成**：联网检索 → 素材分组、分批注入提示词 → 大模型生成结构化 JSON → 字段校验 + 来源 URL 白名单清洗 → 逐段卡片渲染。报告为全局共享缓存。
- **端上聚合卡**：人物速览 / 立场与舆情 / 风险雷达 / 商业价值速览等，**纯端上聚合**，复用已有缓存、零新增模型调用。
- **两名人对比**：横向对比，只读缓存、零模型调用。
- **主题知识库**：把已缓存报告按话题重新编目。
- **原文预览**：报告素材落点；已登记业务域名可内嵌打开，否则降级为素材卡 + 复制链接。

**关注与舆情**

- **关注 / 聚合流 / 周报**：关注列表 + 变化概览 + 聚合流（下拉刷新有每日次数上限）；周报汇总最近 7 天动态。
- **热门榜**：AI 每日生产的榜单，全员可见全部位数。
- **关键词预警**：订阅关键词 → 云函数每日定时按词检索 → 端上列出新增条目（可选推送）。
- **名人风险监控**：盯住某个人 → 每日定时按人检索 → 命中司法 / 税务 / 合作 / 维权 / 表态类词时汇总（只陈述命中与出处，不评级、不预测）。
- **舆情事件聚簇 / 时间线**：定时**读库**把同一件事的多条来源聚成事件；时间线为独立二级页。
- **AI 提问**：选名人后就其缓存报告追问，走推理型模型；与「生成」不是同一个额度池。

**账号与商业化**

- **收藏 / 历史**：四类收藏（名言 / 报告 / 动态 / 时间线）+ 浏览历史。
- **消息中心**：关注更新 / 周报提醒 / 平台公告 / 关键词预警的时间流；已读只存本机。
- **会员与支付**：会员额度分档 + 微信支付下单 / 回调发货 / 退款对账（可选启用）。
- **名言卡分享**：Canvas 2D 端上出图分享 + 原生转发，落地页为具体人物报告页。

> 端上共 **23 个页面**、**4 个 tab**（发现 / 提问 / 舆情 / 我的）；云侧 **14 个云函数**、**22 张数据库集合**（口径与出处见「架构概览」与「部署」）。

---

## 界面预览

截图位于 `assets/screenshots/`（真实工程截图，非占位图）：

| 首页 | 搜索 | 热门榜 | 关注流 |
|---|---|---|---|
| ![首页](./assets/screenshots/01-home.png) | ![搜索](./assets/screenshots/02-search.png) | ![热门榜](./assets/screenshots/03-hot-board.png) | ![关注流](./assets/screenshots/04-feed.png) |

| 关注列表 | 关键词预警 | 消息中心 | AI 问答 |
|---|---|---|---|
| ![关注列表](./assets/screenshots/05-following.png) | ![关键词预警](./assets/screenshots/06-keyword-alert.png) | ![消息中心](./assets/screenshots/07-message-center.png) | ![AI 问答](./assets/screenshots/08-qa.png) |

| 我的 | 模型厂商 |
|---|---|
| ![我的](./assets/screenshots/09-mine.png) | ![模型厂商](./assets/screenshots/10-providers.png) |

---

## 技术栈与运行环境

- **框架**：Taro 3.6（`@tarojs/*` `^3.6.25`）+ React 18 + TypeScript 5.4 — `celebrity-radar/package.json`
- **构建器**：webpack5（`@tarojs/webpack5-runner`）— `celebrity-radar/config/index.js`
- **UI / 状态 / 工具**：Taro UI `^3.0.8`、zustand `^4.5.2`、zod `^3.23.8`、dayjs
- **云后端**：腾讯云 CloudBase（微信云开发）；云函数运行时 **Nodejs16.13** — `celebrity-radar/cloudbaserc.json`
- **云函数 SDK**：`wx-server-sdk`；`aiProxy` / `hotBoardRefresh` 要求 `^4.0.1`（走云开发 AI 通道）
- **小程序 appid / 基础库**：占位 `wx0000000000000000`；`libVersion` `3.7.12` — `celebrity-radar/project.config.json`
- **Node.js**：`package.json` **未声明 `engines`**；Taro 3.6 + webpack5 建议 **Node 16 或 18 LTS**（云函数运行时为 16.13），确切最低版本需自行确认
- **微信开发者工具**：任意较新稳定版；导入「快速开始」里的小程序子目录并开通云开发

> `celebrity-radar/.npmrc` 设了 `legacy-peer-deps=true`，`npm install` 会自动读取，无需手动加参数。

---

## 架构概览

**端上（`celebrity-radar/src`）**

- `pages/`：23 个页面（每页含 `index.tsx` / `index.config.ts`，样式文件视需要而定）。
- `components/`：复用组件（自定义 tabBar、名言卡海报、头像、骨架屏、空态等）。
- `utils/`：业务与工具逻辑分层——检索（`search` / `search-plan`）、报告（`report` / `report-store` / `report-toc`）、缓存（`cache`）、会员与支付（`member` / `pay` / `quota`）、舆情（`opinion-*` / `risk-*` / `keyword-alert`）、敏感与安全（`sensitive` / `sec-check`）等。
- `config/`：端上配置。`public.ts` 进包；`local.example.ts` 是本地模板；`benefits.ts` / `user-defaults.ts` 是**配置真源**。
- `stores/`、`styles/`、`types/`：zustand 状态（如 `auth`）、样式变量、数据库字段类型（`types/db.ts`）。

**云端（`celebrity-radar/cloudfunctions`，14 个云函数）**

- **`aiProxy`**：唯一会产生上游费用的入口。代打检索与模型（`search` / `chat` / `generate` / `aux` / `portrait`），在发起调用前自判两道闸（产品额度 + 防滥用限速），并作为共享缓存的写口（`action:'report'`）。
- **`quotaGuard`**：配额计数权威（`refresh` / `generate` / `ask`）。
- **`contentCheck`**：内容安全机审（云调用 `security.msgSecCheck`）。
- **定时任务**：`hotBoardRefresh`、`notifyFollowUpdates`、`keywordAlert`、`riskWatch`、`opinionCluster`，以及 `payCallback` 的对账触发器（见「部署 → 定时触发器」）。
- **支付**：`payCreate`（服务端定价 + 下单）、`payCallback`（回调发货 + 售后 + 定时对账）。
- **用户**：`userInit`（账号与个性化配置的唯一写者）、`userBackfill`（一次性运维）。
- **运维**：`dbInit`（建集合 / 比对字段 / 建改索引）、`adminOps`（运营写口）。

**一次报告生成的数据流**

1. 端上规划检索词 → `aiProxy(search)` 代为多路联网检索（博查为主，可选第二源兜底）。
2. 检索素材按事件分组、按字符预算压缩 → 分批注入提示词 → `aiProxy(generate/chat)` 走结构化槽生成。
3. 结果做字段校验、长度裁剪与来源 URL 白名单清洗，并做「素材是否不足」的**达标判定**；不足则降级。
4. 通过写口落库到 `report_cache`（全局共享）；端上渲染为逐段卡片，并从缓存聚合出各速览卡。

---

## 快速开始

### 前置要求

- **Node.js** 16 或 18 LTS（见上节「Node.js」一行）。
- **微信开发者工具**（较新稳定版）。
- 一个**微信小程序 appid**，并开通**云开发环境**（CloudBase）。本地纯前端调试可先用占位 appid。

### 步骤

```bash
# 仓库根目录没有 package.json，先进入「小程序工程子目录」
cd celebrity-radar

# 1) 复制「模板 → 本地文件」（三份模板都已被 .gitignore 忽略）
cp src/config/local.example.ts          src/config/local.ts          # 必做，见「配置说明」
cp .env.example                         .env                         # 必做，见「配置说明」
cp project.private.config.example.json  project.private.config.json  # 可选：开发者工具私有配置
# Windows PowerShell 请把 cp 换成 Copy-Item。

# 2) 安装依赖（.npmrc 已开 legacy-peer-deps）
npm install

# 3) 配置：至少填好 .env 的 TCB_ENV_ID（云开发环境 ID）

# 4) 生产构建，产物输出到 dist/
npm run build:weapp
```

然后在**微信开发者工具**里导入 `celebrity-radar/` 目录 —— `celebrity-radar/project.config.json` 声明了 `miniprogramRoot: dist/` 与 `cloudfunctionRoot: cloudfunctions/`，工具据此找到小程序产物与云函数。开发期可在「详情 → 本地设置」勾选「不校验合法域名」先行联调（端上本身不直连上游）。

上面的 `cp` / `npm` 命令都在 **`celebrity-radar/` 子目录内**执行。

---

## 配置说明

配置分三类，各有**唯一真源**：一份 `.env`（端云共用）、一份本地端上配置（不进版本库）、一组「配置真源 → 云函数副本」的同步文件。

### 1）`.env`（唯一真源：端上构建期注入 + 云端部署共用）

由 `celebrity-radar/.env.example` 复制而来（`.env` 已被 `.gitignore` 忽略）。**云端部署时**由 `tcb fn deploy` 经 `cloudbaserc.json` 的 `{{env.XXX}}` 读取并固化进函数配置；**端上构建时**由 `celebrity-radar/config/index.js` 读取同一份 `.env`，经 `defineConstants` 注入编译常量。缺 key 时小程序仍能编译运行，但对应上游功能会在调用时报错。

**必填**

- `TCB_ENV_ID`：云开发环境 ID。**端上与部署共用这一处**（见下方「单一来源」）。留空 = 端上**整个云开发不可用**（登录 / 读写 / 云函数调用全挂）。
- `BOCHA_API_KEY`：联网检索主源（博查）。留空 = 检索为空，报告缺素材、时间线不完整。

**检索兜底（可选）**

- `SERPER_API_KEY` / `TAVILY_API_KEY`：第二检索源，**任填其一**即可；都不填 = 该步整体跳过。

**模型厂商（可选）**

- `DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY`：外部大模型厂商 Key（DeepSeek / 智谱 / Kimi / 通义千问）。**配了哪家，「我的」页才出现哪家**；都不配则只剩默认的「云开发 AI」厂商（零 key）。
- `LLM_VENDOR` / `LLM_TIER`：默认厂商 / 默认质量档（端上没带、定时任务用的兜底）；留空 = 用代码内默认值。

**订阅消息（可选）**

- `SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID`：三路订阅消息模板 ID。**端上与云端共用这一处**；为空 = 推送未配置（授权按钮不渲染、定时任务只落站内数据并跳过推送），站内功能不受影响。

**会员支付（可选）**

- `WX_PAY_SUB_MCH_ID` / `PAY_CALLBACK_ENV_ID`：服务商模式子商户号 + 回调所在云环境；为空 = 会员支付不可用（不影响免费功能）。

**运维口令（默认留空，fail-closed）**

- `WX_APPID` / `WX_APPSECRET`：仅 `dbInit` 换 `access_token` 建 / 改索引时用；不配 = `dbInit` 的索引动作无法程序化执行（仍可在控制台手工建索引）。
- `DB_ADMIN_TOKEN`：`dbInit` 写操作口令；**未配置时写操作一律拒绝**（只读巡检不受限）。
- `PAY_ADMIN_TOKEN`：`payCallback` / `adminOps` 写入口令；**未配置时运营接口拒绝调用**（退款与手动对账不可用，支付主链路不受影响）。
- `ADMIN_OPS_TOKEN`：`adminOps` 写入口令；**未配置时运营接口拒绝调用**。
- `AI_PROXY_TEST_TOKEN`：`aiProxy` 的 `test` 探针口令；**未配置时该动作一律拒绝**（期望的默认状态，业务链路不受影响）。
- `AI_PROXY_QUOTA_GUARD`：额度闸门联调开关；**留空 / 非 `off` 一律 = `on`**（生产口径，fail-closed），上线前务必留空。
- `AI_PROXY_RAW_LOG`：上游报文原始日志，只有写 `on` 才开；默认关闭，排障完请改回空值并重新部署。

> `aiProxy` 还读取若干**未在 `cloudbaserc.json` 声明**的可选变量（如超时预算类），按需在控制台追加。

**单一来源（端云构造上不会分叉）**

1. **云开发环境 ID（`TCB_ENV_ID`）**：端上由 `config/index.js` 构建期注入 `src/config/public.ts#cloudbaseEnvId`；云端由 `cloudbaserc.json` 顶部 `envId` 读取它。只填一处 ⇒ 端上连的环境与 `tcb fn deploy` 写的环境一致，不会出现「端上连 A、部署写 B」。改后需 `npm run build:weapp` 重新编译（值编进包，热更新不生效）。
2. **三个订阅模板 ID**：云端由 `cloudbaserc.json` 的 `{{env.X}}` 注入三个云函数；端上由 `config/index.js` 构建期读**同一份 `.env`** 注入 `src/config/public.ts` 的三个编译常量。只填一处 ⇒ 端云构造上不可能不一致。改后同样需重新构建端上，并重新部署三个云函数。

### 2）`src/config/local.ts`（端上专属，gitignored）

模板为 `celebrity-radar/src/config/local.example.ts`，仓库里**只有模板、不含真实值**。`src/config/public.ts` 直接 `import` 它，**未复制会编译报错** `Cannot find module './local'`。

```bash
cp src/config/local.example.ts src/config/local.ts   # 在 celebrity-radar/ 目录内执行
```

它包含两类**端上专属**项：

- `webviewDomains`：业务域名白名单（原文预览页可内嵌打开的站点）。默认空 = 全部走「素材卡 + 复制链接」降级路径。
- `debug`（**六开关**，仓库默认全部为安全值）：
  - `disableGenerateQuota` / `disableAskQuota` / `disableRefreshQuota` / `disableCooldown`：放开端上额度与冷却闸门，只在本地联调时置 `true`，**会放大成本**。
  - `rawIoLog`：只影响控制台噪音，不改变行为。
  - `allowRestrictedSearch`：放开「限制类检索」的三层拦截，**只用于边界测试，上线必须为 `false`**。

> - **密钥绝不能进端上包**：这里只放「跟机器走」的开关与域名白名单；任何 API Key、口令都只留在 `.env`（→ 云函数环境变量）。
> - **云端闸门不因子项放开而失效**：`disable*` 只放开端上判定，`aiProxy` 入口仍会按云端额度与限速判一次。

### 3）配置真源与副本（`benefits.ts` → `config:sync` → `config:check`）

改「谁能用多少、卖多少钱、成本边界」这类数值时，**只在真源里写一次**：

- `celebrity-radar/src/config/benefits.ts`：会员权益、价格表、报告参数、检索厚度、舆情分层上限、深挖预算闸门。
- `celebrity-radar/src/config/user-defaults.ts`：用户默认配置。

云函数各自独立打包、且云环境里 `require` 不到端上的 TS，故需把真源**生成副本**到云函数目录：

```bash
# 在 celebrity-radar/ 目录内执行
npm run config:sync     # 真源 → 各云函数目录下的 *.config.js 副本（幂等）
npm run config:check    # 只校验不写盘，有差异则打印并 exit 1（测试 / CI 用）
npm test                # 用例会比对真源与副本，漏同步就红
```

> 另有两份**手工同步**、不在 `config:sync` 范围内的文件：模型注册表 `celebrity-radar/cloudfunctions/{aiProxy,hotBoardRefresh}/llm.config.js`（两份应逐字一致，由测试用例钉住）。

---

## 部署

顺序有依赖：**先建集合与权限、再部署云函数**，否则函数里的读写会静默失败。会员支付、订阅推送与各定时任务都是**可选**的——建议先把「搜人名 → 生成报告」主链路跑通，再回来配其余。

### 1）云开发环境

在微信开发者工具中开通云开发环境，把环境 ID 填入 `celebrity-radar/.env` 的 `TCB_ENV_ID`。

### 2）集合与权限（共 22 张）

集合真源是 `celebrity-radar/cloudfunctions/dbInit/schema.js`（库结构的单一事实源）。**权限无法程序化设置**——微信没有对应接口，**必须在云开发控制台逐张手工配置**；`dbInit` 只能代劳**建集合**与**建 / 改索引**。

`schema.js` 定义了 5 类权限规则（`ACL`），其中 `publicRead`（所有人可读、登录可写）**当前未被任何集合使用**。实际使用的 4 类及控制台填法：

| 档位（`schema.js` 的 `ACL`） | 控制台安全规则 |
|---|---|
| `creator`（仅创建者可读写） | **预设**：选「仅创建者可读写」 |
| `selfRead`（本人可读、不可写） | `{"read": "doc._openid == auth.openid", "write": false}` |
| `publicReadOnly`（所有人可读、客户端不可写） | `{"read": true, "write": false}` |
| `cloudOnly`（客户端不可读写） | `{"read": false, "write": false}` |

按权限分组的 22 张集合（顺序同 `schema.js`）：

**仅创建者可读写（7 张）**

- `users` — 账号与设置（首登写入）；`membership` 是端上读口的**镜像**，权威在 `memberships`
- `follows` — 关注列表（`_id` = openid#personKey）
- `favorites` — 收藏（四类，`_id` = openid#type#hash 主键防重）
- `history` — 浏览历史（保留最近 50 条）
- `events` — 埋点
- `keyword_watches` — 关键词订阅 + 名人监控（同表靠 `type` 区分：`keyword` / `person`）
- `opinion_event_status` — 用户对舆情事件的个人状态（已读 / 跟进，端上读写自己那一行）

**本人可读、不可写（4 张）**

- `refresh_quota` — 关注流每日主动刷新次数（`_id` = openid#yyyy-MM-dd）
- `generate_quota` — 报告每日生成配额
- `ask_quota` — AI 提问每日配额（成功才计数）
- `orders` — 会员订单状态机（`pending → granting → paid` / `failed` / `refunded`）；端上只读

**所有人可读、客户端不可写（8 张）**

- `report_cache` — 报告缓存 + `building` 生成互斥锁（全局共享）：写入走 `aiProxy(action:'report')`
- `hot_board` — 热门名人榜（AI 每日生产，`_id` 固定 `latest` 覆盖写）
- `feed_cache` — 检索结果结构化映射（不存 LLM 产物），写入走 `aiProxy` 的 `saveFeed`
- `keywords` — 关键词检索缓存（`_id` = 关键词哈希，定时任务写）
- `risk_scans` — 名人风险扫描快照（`_id` = personKey）
- `risk_signals` — 风险信号流水（`_id` = personKey#url 哈希）
- `opinion_events` — 舆情事件（`_id` = event_key，`opinionCluster` 定时读库聚类后写）
- `person_assets` — 人物素材（头像 / 照片，`_id` = personKey）

**客户端不可读写（3 张）**

- `memberships` — 会员权益的**服务端权威**（`_id` = openid），只由 `payCallback` 发货 / 退款撤销时写
- `ai_calls` — 防滥用限速计数（`_id` = openid#yyyy-MM-dd），`aiProxy` 放行上游前就地原子自增
- `deep_dive_quota` — 事件驱动深挖的单日预算计数（`_id` = yyyy-MM-dd）

> ⚠ 三处最容易出事的权限（顺序不可颠倒，否则端上会写失败）：
> - 三张配额表（`refresh_quota` / `generate_quota` / `ask_quota`）必须是「本人可读、**不可写**」，否则用户能自改额度；且**先部署 `quotaGuard`、再收紧权限**。
> - `memberships` / `ai_calls` 必须「**客户端不可读写**」——它们是会员身份与防滥用计数的服务端权威。
> - `report_cache` / `feed_cache` 是「所有人可读、**客户端不可写**」的共享缓存：先部署带写口的 `aiProxy` 并发布端上，待旧版本覆盖率达标后，再把权限收紧到 `{"read": true, "write": false}`。

### 3）云函数部署（共 14 个）

仓库用 **CloudBase CLI（`tcb`）** 部署。函数、环境变量、超时与定时器都声明在 `celebrity-radar/cloudbaserc.json` 里，逐个 `tcb fn deploy <函数名>` 即可：

```bash
npm i -g @cloudbase/cli      # 只需一次
tcb login                    # 只需一次
tcb fn deploy aiProxy -e <环境ID>
# 其余同理：tcb fn deploy <函数名> -e <环境ID>
```

> 若改用**微信开发者工具「上传并部署」**，它**只上传代码、不读 `cloudbaserc.json`** ⇒ 环境变量、超时、触发器都得去控制台逐项手工补。微信云开发给云函数的**默认超时是 20 秒**，生成报告属长任务，请在控制台把 `aiProxy`（及需要的函数）超时改到 **60 秒**，否则会被平台掐断（端上只会拿到 `-504003`）。

14 个云函数及其**必填环境变量**（以 `cloudbaserc.json` 的 `envVariables` 为准）：

| 云函数 | 用途 | 必填环境变量 | 触发 |
|---|---|---|---|
| `aiProxy` | 平台代付上游密钥与云端闸门 + 共享缓存写口 | `BOCHA_API_KEY`；厂商 Key 任配（见 `.env`） | 端上调用 |
| `quotaGuard` | 配额计数权威（`refresh` / `generate` / `ask`） | 无 | 端上调用 |
| `contentCheck` | 内容安全机审（云调用 `security.msgSecCheck`） | 无（凭证由平台托管） | 端上调用 |
| `hotBoardRefresh` | 热门名人榜每日生产（写 `hot_board`） | `BOCHA_API_KEY` + 厂商 Key | 定时 06:30 |
| `notifyFollowUpdates` | 关注更新订阅消息推送 | `BOCHA_API_KEY`、`SUBSCRIBE_TEMPLATE_ID` | 定时 09:00 |
| `keywordAlert` | 关键词舆情预警（写 `keywords`） | `BOCHA_API_KEY`、`ALERT_TEMPLATE_ID` | 定时 09:20 |
| `riskWatch` | 名人风险监控（写 `risk_signals`） | `BOCHA_API_KEY`、`RISK_TEMPLATE_ID` | 定时 09:40 |
| `opinionCluster` | 舆情事件落库（读库聚类，**不联网、零上游成本**） | 无 | 定时 10:00 |
| `payCreate` | 会员下单（服务端定价 + 云支付统一下单） | `WX_PAY_SUB_MCH_ID`、`PAY_CALLBACK_ENV_ID` | 端上调用 |
| `payCallback` | 支付结果通知 + 售后（退款 / 对账）；支付链路唯一后端 | `PAY_ADMIN_TOKEN` | 回调 + 定时对账 |
| `dbInit` | 运维工具：建集合 / 比对字段 / 建改索引 | `DB_ADMIN_TOKEN`、`WX_APPID`、`WX_APPSECRET` | 手动 |
| `adminOps` | 运营写口（代理发货 / 对账等运维动作） | `ADMIN_OPS_TOKEN`、`PAY_ADMIN_TOKEN` | 手动 |
| `userInit` | 用户账号与个性化配置的**唯一写者** | 无 | 端上登录后调用 |
| `userBackfill` | 一次性运维：给存量用户补齐配置（幂等） | 无 | 手动 |

> - 依赖配置真源的云函数需**先跑 `npm run config:sync`** 生成副本（见「配置说明」）：`benefits.config.js` → `aiProxy` / `quotaGuard` / `payCreate` / `keywordAlert` / `riskWatch`；`user-defaults.config.js` → `userInit` / `userBackfill`。
> - `contentCheck` 依赖 `celebrity-radar/cloudfunctions/contentCheck/config.json` 的 `permissions.openapi`（`security.msgSecCheck`）随上传生效；未生效时机审按 fail-open 静默放过。

### 4）定时触发器

cron 为腾讯云 SCF 的 **7 字段**格式（秒 分 时 日 月 周 年），以 `celebrity-radar/cloudbaserc.json` 的 `triggers` 为准：

| 触发器名 | 所属云函数 | cron |
|---|---|---|
| `dailyHotBoard` | `hotBoardRefresh` | `0 30 6 * * * *` |
| `dailyNotify` | `notifyFollowUpdates` | `0 0 9 * * * *` |
| `dailyKeywordAlert` | `keywordAlert` | `0 20 9 * * * *` |
| `dailyRiskWatch` | `riskWatch` | `0 40 9 * * * *` |
| `dailyOpinionCluster` | `opinionCluster` | `0 0 10 * * * *` |
| `payReconcile` | `payCallback` | `0 15 * * * * *` |

用 `tcb fn deploy` 部署时触发器随之上线；用开发者工具上传则需在控制台「定时触发器」里手工建。

### 5）`dbInit` 怎么跑

`dbInit` 是**运维函数、不是运行时依赖**（端上任何代码都不调用它）。它可程序化**建集合**与**建 / 改索引**；**设置集合权限仍须手工**（见上文「集合与权限」）。

```bash
tcb fn deploy dbInit -e <环境ID>
# 只读巡检：先看缺什么（返回体里的 permissions_manual 就是要手工去控制台点的权限清单）
tcb fn invoke dbInit -e <环境ID> --params '{"action":"report"}'
# 建缺失的集合（写操作需带口令，须等于环境变量 DB_ADMIN_TOKEN）
tcb fn invoke dbInit -e <环境ID> --params '{"action":"init","token":"<口令>"}'
```

常用 `action`：`report`（默认，只读巡检）、`init`（只建缺失集合）、`fields`、`indexes`、`sync`（= init + fields(apply) + indexes(apply)，一步到位）。**默认 dry-run**，只有显式传 `"apply": true` 才写库 / 调接口。运维做完建议删除该函数：`tcb fn delete dbInit`。

### 6）域名与业务域名

- **服务器域名**：**无需配置**。端上从不直连上游域名——检索与大模型均由云函数代打，云函数出网不受小程序域名白名单限制；云数据库 / 云函数走 `wx.cloud` 也不需要域名。
- **业务域名**：仅影响「原文预览」页内嵌打开。未登记业务域名的来源走「素材卡 + 复制链接」降级路径，行为可预期、不会白屏。若把高频来源登记进业务域名，可把主域名填入 `src/config/local.ts#webviewDomains` 自动内嵌。

### 7）订阅消息（可选，四步）

**默认（三枚模板 ID 全留空）是正常态**：端上授权按钮不渲染，三个定时任务只落站内数据并跳过推送，**站内功能完全可用**。要启用推送，按**自己的服务类目**走这四步（缺一步都不行）：

1. **申请模板**：微信公众平台 → 功能 → 订阅消息 → 公共模板库，按自身服务类目挑选**字段形如 `thing1`（提醒内容，≤20 字）+ `date2`（时间）**的那类模板，申请 / 选用**三枚不同的模板 ID**（关注更新 / 关键词预警 / 风险提醒各一枚）。
2. **填入配置**：把三个 ID 填进 `celebrity-radar/.env` 的 `SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID`（**只这一处**）。
3. **重新构建与部署**：`npm run build:weapp` 重新编译端上（值编进包，热更新不生效），并重新部署三个云函数让环境变量生效。
4. **真机授权**：登录后点三处入口的授权按钮，确认 `users` 表对应行的 `subscribe_ok` / `alert_ok` / `risk_ok` 已置 `true`——定时任务只给 `true` 的用户发。

> ⚠ **三枚必须不同**：微信一次性订阅**一次授权只够推一条、且按模板消耗授权**，三个定时任务（09:00 / 09:20 / 09:40）共用一枚会导致先跑的吃掉授权、后跑的报 `43101`。

---

## 测试

测试运行在 **Node** 里，不连云、不需要任何 Key。`npm test` 会先用 `tsc` 把 `src` 编译到 `test/.build`（脚手架 `celebrity-radar/test/harness` 装好 `@tarojs/taro` 与全局 `wx` 替身），再跑全部用例。

```bash
# 在 celebrity-radar/ 目录内执行
npm test            # 1) tsc 编译 src；2) 运行全部用例
npm run test:only   # 只跑用例，不重新编译（改动用例时用）
```

全部 `scripts`（来自 `celebrity-radar/package.json`，**均在 `celebrity-radar/` 目录内执行**）：

| 脚本 | 作用 |
|---|---|
| `npm run dev:weapp` | 开发模式（watch，产物 `dist/`） |
| `npm run build:weapp` | 微信小程序生产构建，产物 `dist/` |
| `npm run build:h5` | H5 端构建（调试用，云开发相关功能不可用） |
| `npm test` | `tsc` 编译 `src` 后运行全部用例 |
| `npm run test:only` | 只运行用例，不重新编译 |
| `npm run config:sync` | 配置真源 → 云函数副本（幂等） |
| `npm run config:check` | 只校验真源与副本是否一致（有差异则 `exit 1`） |

用例位于 `celebrity-radar/test/cases/*.js`，分两类：

- **静态约束**：把「源码里必须 / 不得出现某写法」钉住，例如云端闸门与端上口径一致、配置真源与云函数副本一致（`config:sync` / `config:check`）、两处手工同步的 `llm.config.js` 逐字一致。
- **纯函数断言**：对无副作用的纯函数直接断言输入输出（配额、缓存、报告清洗、事件聚簇等）。

---

## 成本与合规

**按次计费的上游调用**

- **报告生成**：一次生成会触发「检索词规划 + 多路联网检索 + 分批大模型生成」，是本项目最大的单次成本来源。
- **定时扫描**：`hotBoardRefresh`（06:30）、`notifyFollowUpdates`（09:00）、`keywordAlert`（09:20）、`riskWatch`（09:40）每轮都会真实检索 / 调用上游。`opinionCluster`（10:00）**只读库聚类、不联网**，无上游成本。
- **事件驱动深挖**：`keywordAlert` / `riskWatch` 在**扫描命中时**才对对象额外扩查一个查询词，成本由**三层预算闸门**共同封顶（真源在 `celebrity-radar/src/config/benefits.ts` 的 `DEEP_DIVE`）：`queriesPerHit = 1`（每次命中最多扩查 1 个词）、`perRunMax = 6`（单轮最多 6 次）、`perDayMax = 60`（单日跨轮累计最多 60 次，计数落在 `deep_dive_quota` 集合）。它是「命中才触发」而非「全量刷新」——这是成本可控的根本。

> 上述额度、上限、报告预算等数值真源都在 `celebrity-radar/src/config/benefits.ts`；改它 → `npm run config:sync` → 重新部署对应云函数。

**合规设计（部署者需自行确认与承担内容合规责任）**

- **涉政涉军三层拦截**（端上 + 提示词）：① `celebrity-radar/src/utils/sensitive.ts` 的**本地静态拦截**（命中即拒答、**不发任何网络请求**）；② 消歧提示词里「政治 / 军事类人物 → refused」规则；③ 报告提示词里「素材显示属政治 / 军事类敏感人物 → 整份拒答」。其中人物名单在仓库里是**空数组**（运营维护位），上线前需按最新合规要求自行补充。
- **云端内容安全机审**：`celebrity-radar/cloudfunctions/contentCheck` 通过云调用 `security.msgSecCheck` 对 AI 提问送检。
- ⚠ 报告内容由大模型基于公开信息生成，程序内已固定标注「AI 生成，仅供参考」。**本仓库不提供任何合规背书**——类目资质、内容审核、隐私协议、AI 生成内容标识等合规义务由**部署者自行确认与承担**。

---

## 目录结构

下列路径相对**仓库根目录**；小程序工程本体位于 `celebrity-radar/` 子目录：

```text
celebrity-radar/                ← 仓库根目录（无 package.json）
├── README.md                   中文说明（本文件）
├── README.en.md                英文说明
├── LICENSE / NOTICE            许可证（Apache-2.0）与第三方署名
├── CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
├── assets/screenshots/         界面截图
└── celebrity-radar/            ← 小程序工程本体（所有 npm 命令在此执行）
    ├── src/                    小程序源码
    │   ├── pages/              23 个页面
    │   ├── components/         复用组件
    │   ├── utils/              业务与工具逻辑
    │   ├── config/             端上配置（public.ts / benefits.ts / local.example.ts …）
    │   ├── stores/  styles/  types/
    │   └── app.config.ts       页面与 tabBar 声明
    ├── cloudfunctions/         14 个云函数（dbInit/schema.js 为数据库结构真源）
    ├── scripts/sync-config.js  配置真源同步到云函数副本
    ├── test/                   测试：cases/ 用例、harness/ 脚手架、run.js 入口
    ├── config/                 Taro 构建配置（index.js + dev.js / prod.js）
    ├── cloudbaserc.json        云函数 / 环境变量 / 定时器声明（CloudBase CLI 部署读它）
    ├── project.config.json     微信开发者工具工程配置
    ├── package.json            依赖与 scripts
    └── .env.example            云函数部署密钥模板（复制为 .env 使用）
```

---

## 常见问题 / 已知限制

- **推送不可用**：订阅消息模板需在**自己的服务类目**下从公共模板库申请；某些主体类型 / 服务类目拿不到可用模板，此时推送不可用。这是**当前部署环境的限制，不是功能缺失**：通道与代码完整保留，三枚模板留空即退化到「只落站内数据、跳过推送」，站内功能照常可用。
- **行情类数据的时效性**：报告与榜单由 AI 基于某一时刻的公开检索素材生成，属**快照**，不保证实时；报告为全局共享缓存，改上游参数只影响之后**新生成**的报告，旧缓存不会自动重建（除非用户点「重新生成」）。
- **端上上限不是安全边界**：端上的额度判定、debug 开关、监控数量上限都只是体验层，改包即可绕过；真正的成本边界在云端（`ai_calls` 防滥用计数、`memberships` 权威会员表）。

---

## 支持本项目

如果这个项目对你有帮助，可以请作者喝杯咖啡：

| 微信支付 | 支付宝 |
|---|---|
| ![微信收款码](./assets/screenshots/微信.JPG) | ![支付宝收款码](./assets/screenshots/支付宝.JPG) |

---

## 贡献 / 安全 / 许可

- **贡献指南**：[`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **行为准则**：[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- **安全策略**（**请勿公开 Issue 报告安全问题**）：[`SECURITY.md`](./SECURITY.md)
- **第三方署名**：[`NOTICE`](./NOTICE)
- **许可**：本项目以 **Apache License 2.0** 开源，全文见 [`LICENSE`](./LICENSE)。

> `celebrity-radar/package.json` 的 `license` 字段为 `Apache-2.0`。发布前请把 `LICENSE` 附录中的版权行占位符替换为你自己的姓名或组织。
