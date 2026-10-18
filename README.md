<div align="center">

# 名人雷达 · Celebrity Radar

**输入一个名字，换回一份可读、可溯源、可复用的人物情报报告。**

检索近期公开报道 → 大模型提炼成结构化档案 → 在档案之上生长出关注流、周报、AI 提问、舆情监控与会员体系

**Taro 3（React + TypeScript）· 微信云开发 CloudBase**

[**中文**](./README.md) ｜ [English](./README.en.md) ｜ [GitHub](https://github.com/qianlongloves/CelebrityRadar) ｜ [Gitee](https://gitee.com/qianlonglove_admin/celebrity-radar) ｜ [AtomGit](https://atomgit.com/fivestar/CelebrityRadar)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)
![Taro](https://img.shields.io/badge/Taro-3.6-07c160.svg)
![WeChat Mini Program](https://img.shields.io/badge/WeChat-Mini%20Program-07c160.svg)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/qianlongloves/CelebrityRadar?style=social)](https://github.com/qianlongloves/CelebrityRadar)

</div>

> ⚠ 这是一份**可编译、可运行的完整代码**，而不是一个可直接上线运营的产品。仓库里**没有附带任何可用凭据**——`appid`、云开发环境 ID、各上游 API Key 全都是占位符或空值，需要你自己准备。
>
> ⚠ 本说明位于**仓库根目录**，但小程序工程本体（`package.json`、`src/`、`cloudfunctions/` 等）都在 **`celebrity-radar/` 子目录**里，**根目录本身没有 `package.json`**。因此下面所有 `npm` 命令，都要先 `cd celebrity-radar` 进入子目录再执行。

---

## 目录

- [项目简介](#项目简介)
- [核心亮点](#核心亮点)
- [功能特性](#功能特性)
- [界面预览](#界面预览)
- [技术栈](#技术栈)
- [架构概览](#架构概览)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [部署](#部署)
- [测试](#测试)
- [成本与合规](#成本与合规)
- [免责声明](#免责声明)
- [目录结构](#目录结构)
- [常见问题 / 已知限制](#常见问题--已知限制)
- [Roadmap](#roadmap)
- [支持本项目](#支持本项目)
- [致谢](#致谢)
- [贡献 / 安全 / 许可](#贡献--安全--许可)

---

## 项目简介

名人雷达是一款「名人动态情报台」。它要做的事情很直接：**把一个名字，变成一份可读、可溯源、可复用的人物报告。**

使用者只需要输入一个名字，程序会先做一轮消歧，确认你指的到底是哪一位；然后去互联网上检索这个人物近期的公开报道，把抓回来的素材按事件分组、压缩，分批交给大模型，最终生成一份结构化的报告。这份报告不是几句笼统的总结，而是一份像档案一样的信息组合——身份背景、近期动态、立场与舆情、商业合作、风险信号，逐段拆开呈现，并且每一条都能回溯到原始出处，而不是大模型的空口发挥。

项目在设计上有一个贯穿始终的关键取舍：**报告是全局共享缓存**。同一个人物只生成一次，所有用户复用同一份结果，单次生成的成本被全量用户摊薄；端上大量「速览卡」也并不会重新调用模型，而是对已有的缓存做**本地聚合**——因此成本结构是可控的，越多人用，人均成本反而越低。

```text
输入姓名 → 消歧 → 规划检索词 → 多路联网检索 → 按事件分组 / 按字符预算压缩
        → 分批注入提示词 → 结构化生成 → 字段校验 + 来源白名单清洗
        → 落库 report_cache（全局共享） → 端上渲染逐段卡片 + 本地聚合速览卡
```

---

## 核心亮点

- **一份缓存，全员复用** —— 报告是**全局共享缓存**：同一个人物只生成一次；端上速览卡**纯本地聚合，零模型调用**。越多人用，人均成本越低。
- **免费 11 节，会员 18 节** —— 分层同时落在**节数**与**每节条数**两个杠杆上；会员节在原位渲染锁态卡而不是消失，数据始终完整，截断只发生在渲染那一行。
- **每条结论都可溯源** —— 结果过一遍**来源网址白名单清洗**，每条素材指向原始出处；导出同样带全量出处，登记过域名的站点还能内嵌预览。
- **横向盯人，不只是纵向订阅** —— 监控台账把「我盯的几个人里谁在动」排成一行，勾选 4 人做指标对比；台账、对比、事件跟踪都只读缓存，零上游成本。
- **成本有硬边界** —— 全站上游调用只有**一个**出口，请求前必过「产品额度 + 防滥用限速」双闸；配额在云端按「用户 + 日期」原子自增，**端上只读不写**，改包既不能重置也不能篡改用量。
- **合规内置，工程质量可验证** —— 知情同意、撤回同意、数据导出、账号注销等个人信息保护设施随产品交付，影响评估单独留档；**2200+ 条测试用例**，一条命令跑完，不连云、不需要任何 Key。

---

## 功能特性

以下能力都以代码中**真实存在**的实现为准，而非蓝图。按底部四个 tab（查 / 问 / 盯 / 管）分四块，交付物与运维并入最后一块。

### 一、查：报告与检索（发现 / 报告）

- **发现页**：今日名人（AI 每天挑一位并说明理由）、随机探索、按姓名搜索（带热搜与最近搜索）、行业与侧重筛选、热门榜。
- **报告**：18 节分 4 组；**免费 11 节 / 会员 18 节**，每节条数也分档（免费 3 条 + 就地提示「还有 N 条」），会员节在原位渲染锁态卡而不是消失。
- **速览卡**：人物速览、立场与舆情、风险雷达、商业价值——只读缓存，零模型调用。
- **检索**：三层兜底（降级阶梯 → 第二检索源 → 仅知识模式），素材不足标「简版」；生成前可选「综合 / 动态 / 言论 / 履历」侧重。
- **名人主页**：动态 / 名言 / 时间线 / 数据四 Tab，全部读缓存；数据 Tab 给曝光度、报道来源、来源 × 情绪、可信度、情绪构成与走势，样本不足不画图。
- **对比与知识库**：双人对比（指标 + 对比问答）、按话题编目的主题知识库。
- **刷新与版本**：旧版留档，**版本列表免费、旧版正文会员**；差异只比条数与具名条目；刷新结果有七种，逐一如实提示。
- **溯源与消歧**：每条素材带原始链接，登记域名可内嵌预览；检索前做三层消歧，确认过的别名会记下来，之后所有生成与聚合都认这条别名。

### 二、问：AI 问答（提问）

- **两个入口、一个面板**：提问 tab 选名人提问，报告页工具条也能直接追问——同一套面板、同一条额度。
- **口径**：只读缓存报告、走推理型模型，与生成**不共用额度池**（免费 5 / 会员 30，UTC+8 日清），**拿到回答才计数**。

### 三、盯：关注与舆情（舆情 / 预警 / 事件 / 台账）

- **关注流**：关注列表 + 聚合流，可按人物 / 领域筛选。
- **舆情台**：四格入口（我的预警 / 监控台账 / 关注动态 / 本周周报）、每日简报（关注 / 监控词 / 动态 / 风险 + 风险类别与影响面）、今日要点前 3 条与事件 / 关键词预览卡——全是本地聚合，零模型调用。
- **预警与监控**：关键词监控、名人风险监控——每天定时检索，**只陈述命中了什么、出处在哪，不做评级也不做预测**。
- **周报与热门榜**：周报出分享图 + ≤5 条带来源的摘要（消耗 1 次生成额度）；热门榜每天生产，同时喂给今日名人与热搜。
- **事件与订阅**：同一件事的多条来源会聚成一个事件（时间线明细免费 5 条 / 会员全部）；「跟进」看这一条事件的后续，「订阅」看这个人 / 词之后的所有事件（≤30 个对象，同名会合并）。
- **监控台账**：按最近动静排序，勾选 4 人做指标对比（没报告的人也进表并标「未生成」），可导出简报；站内全免费，仅导出是会员。

### 四、管：账号、额度与交付物（我的 / 设置）

- **收藏、历史与消息**：四类收藏 + 浏览历史；关注更新、周报提醒、报告有更新与公告合成一条时间流，已读只存本机。
- **会员分层**：三类日额度 + 节数（11 / 18）+ 每节条数 + 时间线明细 + 监控上限 + 长图与结构化导出 + 旧版正文 + 模型档位（非会员在云端一律落基础档）；支付走微信支付（可选启用）。
- **额度**：生成 / 刷新 / 提问三类各自按日计数（数值只在权益配置里写一次），云端原子自增、**回读也以云端为准**，端上只读。
- **交付物**：长图、Markdown（每条带出处）、JSON、周报卡、名言卡；分享图的小程序码由云函数生成。
- **设置与运维中心**：设置页收口更新提醒、导出数据、撤回同意、注销等低频重操作；运维中心（openid 白名单）可找人、看配额、发会员、开关模型厂商。

> 端上一共 **26 个页面、4 个 tab**（发现 / 提问 / 舆情 / 我的）；其中 4 个 tab 页留在主包，其余 22 个二级页下沉到分包以控制主包体积。云端有 **16 个云函数、27 张数据库集合**，分别在后面的「架构概览」和「部署」里说明。

---

## 界面预览

下面的截图都来自 `assets/screenshots/`，是真实工程的截图而非占位图：

<table align="center">
  <tr>
    <td align="center"><img src="./assets/screenshots/home.png" width="150"/><br/><sub>首页</sub></td>
    <td align="center"><img src="./assets/screenshots/hot-board.png" width="150"/><br/><sub>热门榜</sub></td>
    <td align="center"><img src="./assets/screenshots/feed.png" width="150"/><br/><sub>关注流</sub></td>
    <td align="center"><img src="./assets/screenshots/profile.png" width="150"/><br/><sub>名人主页</sub></td>
    <td align="center"><img src="./assets/screenshots/weekly.png" width="150"/><br/><sub>周报</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/report-1.png" width="150"/><br/><sub>报告 1</sub></td>
    <td align="center"><img src="./assets/screenshots/report-2.png" width="150"/><br/><sub>报告 2</sub></td>
    <td align="center"><img src="./assets/screenshots/report-3.png" width="150"/><br/><sub>报告 3</sub></td>
    <td align="center"><img src="./assets/screenshots/report-4.png" width="150"/><br/><sub>报告 4</sub></td>
    <td align="center"><img src="./assets/screenshots/report-5.png" width="150"/><br/><sub>报告 5</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/report-6.png" width="150"/><br/><sub>报告 6</sub></td>
    <td align="center"><img src="./assets/screenshots/report-7.png" width="150"/><br/><sub>报告 7</sub></td>
    <td align="center"><img src="./assets/screenshots/report-8.png" width="150"/><br/><sub>报告 8</sub></td>
    <td align="center"><img src="./assets/screenshots/report-9.png" width="150"/><br/><sub>报告 9</sub></td>
    <td align="center"><img src="./assets/screenshots/report-10.png" width="150"/><br/><sub>报告 10</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/opinion.png" width="150"/><br/><sub>舆情</sub></td>
    <td align="center"><img src="./assets/screenshots/events.png" width="150"/><br/><sub>舆情事件</sub></td>
    <td align="center"><img src="./assets/screenshots/monitoring.png" width="150"/><br/><sub>名人监控</sub></td>
    <td align="center"><img src="./assets/screenshots/messages.png" width="150"/><br/><sub>消息中心</sub></td>
    <td align="center"><img src="./assets/screenshots/mine.png" width="150"/><br/><sub>我的</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/favorites.png" width="150"/><br/><sub>我的收藏</sub></td>
    <td align="center"><img src="./assets/screenshots/member.png" width="150"/><br/><sub>会员</sub></td>
    <td align="center"><img src="./assets/screenshots/model-tier.png" width="150"/><br/><sub>大模型切换</sub></td>
    <td align="center"><img src="./assets/screenshots/comparison.png" width="150"/><br/><sub>名人对比照片</sub></td>
    <td align="center"><img src="./assets/screenshots/ai-qa.png" width="150"/><br/><sub>AI 问答</sub></td>
  </tr>
</table>

---

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | **Taro 3** + **React 18** + **TypeScript** |
| 构建 | webpack 5（`@tarojs/webpack5-runner`） |
| UI | Taro UI + 自定义 tabBar / 自绘浮层 |
| 状态管理 | zustand |
| 数据校验 | zod |
| 日期处理 | dayjs |
| 后端 | **腾讯云 CloudBase（微信云开发）**，云函数运行时 Node 16.13 |

其中真正和大模型打交道的 `aiProxy`、`hotBoardRefresh` 两个云函数用到 `wx-server-sdk`，走云开发自带的 AI 通道。

一个对部署者很友好的细节是：仓库的 `.npmrc` 已经写好 `legacy-peer-deps=true`，`npm install` 会自动读取，不需要手动加参数。

---

## 架构概览

整个系统一分为二，分工很清晰：**端上负责体验与聚合，云端负责成本与权威。**

**端上**的页面、复用组件之外，核心逻辑都收在 `utils` 里，按「检索、报告、缓存、会员与支付、舆情、安全」分层组织。配置目录是另一个关键点：进包的公共配置、本地专属配置、以及「谁能用多少、卖多少钱」这类数值的**唯一真源**，都集中在这里，保证不会出现端上云端各写一份、慢慢漂移分叉的问题。

**云端**的 16 个云函数分工如下：

| 分组 | 云函数 | 职责 |
|---|---|---|
| 核心出口 | `aiProxy` | 全系统**唯一产生上游费用**的入口：代打检索与大模型调用，请求前过「产品额度 + 防滥用限速」双闸，同时兼任共享缓存写入口 |
| 闸门与安全 | `quotaGuard`、`contentCheck` | 三类配额（生成 / 刷新 / 提问）的云端计数权威（`consume` 原子自增 / `peek` 只读回读）、内容安全机审 |
| 定时任务 | `hotBoardRefresh`、`notifyFollowUpdates`、`keywordAlert`、`riskWatch`、`opinionCluster` | 热门榜 / 关注推送 / 关键词预警 / 风险监控 / 舆情聚簇（聚簇只读库，零上游成本） |
| 支付 | `payCreate`、`payCallback` | 下单 / 回调与售后对账 |
| 分享与运维台 | `wxacode`、`adminConsole` | 分享图底部的小程序码生成（access_token 只在服务端）/ 端上超管运维台的服务端（openid 白名单鉴权） |
| 用户与运维 | `userInit`、`dbInit`、`adminOps`、`userBackfill` | 账号与配置的唯一写者 / 建集合与索引 / 运营写口 / 数据回填 |

把一次报告生成的完整过程展开：端上先规划检索词，交给 `aiProxy` 去多路联网检索（以博查为主，可选的第二来源兜底）；检索回来的素材按事件分组、按字符预算压缩，分批注入提示词，再交给 `aiProxy` 做结构化生成；生成结果经过字段校验、长度裁剪、来源网址白名单清洗，并做一次「素材是否足够」的达标判定，不足就降级；通过之后就落库到 `report_cache` 这个全局共享缓存里，端上再把它们渲染成逐段卡片，并聚合出各种速览卡。整条链路跑下来，一次生成只花一次上游成本，之后的每一次阅读都是免费的。

---

## 快速开始

动手之前，需要准备三样东西：**Node.js 16 或 18 LTS**、**微信开发者工具**、一个**微信小程序 appid**（并开通云开发环境）。如果只是想先在本地跑通前端、看看界面，用占位的 appid 也可以。

```bash
cd celebrity-radar   # 根目录没有 package.json，先进入工程子目录

# 复制三份「模板 → 本地文件」（模板都已被 .gitignore 忽略，不会进版本库）
cp src/config/local.example.ts          src/config/local.ts          # 必做
cp .env.example                         .env                         # 必做
cp project.private.config.example.json  project.private.config.json  # 可选
# Windows PowerShell 请把 cp 换成 Copy-Item。

npm install          # 安装依赖

npm run build:weapp  # 生产构建，产物输出到 dist/
```

其中最不能省的是 `local.ts`——它被 `public.ts` 直接引用，不复制的话编译会直接报错；`.env` 则至少要填上云开发环境 ID。之后在微信开发者工具里导入 `celebrity-radar/` 目录即可，工程配置已经声明好了 `miniprogramRoot` 和 `cloudfunctionRoot`。开发期可以在「详情 → 本地设置」里勾选「不校验合法域名」先行联调——因为端上本身并不直连上游，所以这一项不影响功能。

常用命令：

| 命令 | 作用 |
|---|---|
| `npm run dev:weapp` | 开发模式构建（watch） |
| `npm run build:weapp` | 生产构建，产物输出到 `dist/` |
| `npm test` | 编译并运行全部测试（不连云、零 Key） |
| `npm run config:sync` | 把配置真源同步成云函数副本 |
| `npm run config:check` | 只校验副本是否一致（有差异即报错） |
| `npm run release:check` | 发版前对账：debug 开关 / 隐私协议校验开关（源码与产物各一遍）/ 合规名单 / appid / 产物是否落后于源码 |

---

## 配置说明

这个项目的配置设计成三类，各有各的**唯一真源**，目的是避免「同一个值在两处各写一份、慢慢不一致」这类经典问题。

**第一类是 `.env`**，由 `.env.example` 复制而来，是端上和云端**共用**的唯一真源。它里边的键分几档：必填的是云开发环境 ID（`TCB_ENV_ID`）和检索主源博查的 Key（`BOCHA_API_KEY`）；可选的是第二检索源（SERPER 或 TAVILY 任填其一）、若干外部大模型厂商的 Key（配了哪家，「我的」页才会出现哪家；一家都不配，就只剩默认的「云开发 AI」这一家，零 Key 也能用）、默认厂商与默认质量档、三路订阅消息的模板 ID、支付相关的子商户号与回调环境、以及建索引用的 appid 与 secret。还有一类是运维口令——它们未配置时，对应的写操作会**一律拒绝**（宁可拒绝也不放行），只读巡检不受影响。此外还有两个显式开关，一个管额度闸门（留空即视为开启）、一个管上游原始日志（默认关闭）。

这套 `.env` 的妙处在于**单一来源**：云端部署时经 `cloudbaserc.json` 读取固化进函数配置，端上构建时经构建脚本读**同一份** `.env` 注入编译常量。于是云开发环境 ID、订阅模板 ID 这类「端云必须一致」的值，只要填一处，构造上就不可能分叉——唯一的代价是改完之后要重新 `npm run build:weapp`，因为这些值编进了包，热更新不生效。

**第二类是端上专属的本地配置 `local.ts`**，模板在 `local.example.ts`，同样不进版本库。它只放两类「跟机器走」的东西：业务域名白名单（影响原文预览能否内嵌打开），以及六个调试开关（放开额度与冷却闸门的、打印原始 IO 的、放开限制类检索拦截的）。原则很明确：**密钥绝不进端上包**——API Key、口令只留在 `.env` 里流向云函数；而这里的 `disable*` 开关即便放开，也只影响端上的体验层判定，云端入口仍会再判一次。

**第三类是「配置真源 → 云函数副本」的同步**。像会员权益、价格表、报告参数、检索厚度、舆情分层上限、用户默认配置这类「谁能用多少、卖多少钱、成本边界」的数值，只在 `benefits.ts` 和 `user-defaults.ts` 里写一次；但云函数各自独立打包，在云环境里读不到端上的 TypeScript，所以需要用 `npm run config:sync` 把它们生成成副本落到各云函数目录里，再用 `npm run config:check` 校验是否一致（测试也会钉住这一点）。另外模型档位表 `llm.config.js` 在 `aiProxy` 和 `hotBoardRefresh` 各有一份、需要手工保持逐字一致。

---

## 部署

部署的顺序是有讲究的：**先建集合与权限、再部署云函数**，否则函数里的读写会静默失败。而且会员支付、订阅推送、各定时任务都是**可选**的——建议先把「搜人名 → 生成报告」这条主链路跑通，再逐步打开其他部分。

1. **云开发环境**：在开发者工具里开通，把环境 ID 填进 `.env`。
2. **建集合与权限**（共 27 张集合，库结构真源在 `dbInit/schema.js`）。
3. **部署云函数**（用 CloudBase CLI `tcb`）。
4. **定时触发器**（`tcb fn deploy` 会随之上线）。
5. **`dbInit` 运维函数**（只读巡检 → 带口令 + `apply` 才真正建集合建索引）。
6. **域名**（服务器域名无需配置）。
7. **订阅消息**（可选）。

**第二步是建集合与权限。** `dbInit` 只能建集合、建改索引；**权限要另设**。这里有三个容易被忽略的点：①四个**预设档**可以用 CLI 设（`tcb api tcb ModifyDatabaseACL --body '{"EnvId":"…","CollectionName":"…","AclTag":"ADMINWRITE"}'`，档位名 `READONLY` / `PRIVATE` / `ADMINWRITE` / `ADMINONLY`），**自定义安全规则**（如「本人可读不可写」那种带条件的 JSON）只能在云开发控制台里逐张手工配；②新建集合的默认档是 `PRIVATE`（仅创建者可读写）——**不会**跟随 `schema.js` 里声明的 ACL 走，所以「端上直读」的集合建完必须显式改档，否则读会被拒且只在端上打一行诊断日志（表现为功能静默为空，最难发现的一类错）；③用 `tcb api tcb DescribeDatabaseACL` 可以随时回读当前档位，巡检时对照下表逐张核。权限一共五档——其中「本人可读不可写」和「所有人可读、登录可写」是带条件的自定义规则，只能进控制台逐张配；其余三档用预置档即可（`PRIVATE` / `READONLY` / `ADMINONLY`）：

| 档位 | 数量 | 说明 |
|---|---|---|
| 仅创建者可读写 | 7 | 用户、关注、收藏、历史、事件、关键词监控、事件状态 |
| 本人可读不可写 | 4 | 三张配额表（刷新 / 生成 / 提问）+ 订单 |
| 所有人可读、客户端不可写 | 10 | 报告缓存、报告历史版本、热门榜、关注流缓存、关键词、风险扫描 / 信号 / 日志、舆情事件、人物素材 |
| 所有人可读、登录可写 | 1 | 人物别名（`person_alias`）：端上确认「是同一个人」后写入，仅供消歧层读 |
| 客户端完全不可读写 | 5 | 会员权威表、上游调用计数、深挖配额、**会员段副本**（`report_member`）、系统配置（`sys_config`） |

其中有三处最容易出问题：三张配额表必须是「本人可读但**不可写**」，否则用户能自己改额度，而且要**先部署 `quotaGuard` 再收紧权限**（2026-10-18 起端上读已改成「云端 `peek` 优先、端上直读只作兜底」，所以即便这条自定义规则漏配，配额也不会再被显示成恒 `0 / 30`、闸门也不会永远放行 —— 但仍建议配好：能省一次云函数调用，兜底路径也才真正可用）；会员表和防滥用计数表必须客户端完全不可读写，因为它们是服务端权威；报告缓存、报告历史版本和关注流缓存是共享缓存，要先部署带写口的 `aiProxy`，等旧版本覆盖达标后再收紧成只读。

还有一处口径要提前定下来：`schema.js` 里声明 `ACL.cloudOnly` 的集合，落地时统一用预置档 **`ADMINONLY`**（「仅管理端可读写」）。它与控制台里手配的自定义规则 `{"read": false, "write": false}` 语义完全相同，但**只有预置档能用 CLI 设**——`ModifyDatabaseACL` 不接受 `Rule` 参数（实测报 `UnknownParameter`），自定义规则只能进控制台点。所以回读存量集合时会看到 `AclTag: CUSTOM`（`memberships` / `ai_calls` / `report_cache` 都是这种），新加的 `report_member` 是 `ADMINONLY`，**不必为了一致去改**：判据是「客户端能不能读写」，不是标签长得一样不一样。

**第三步是部署云函数**，用 CloudBase CLI（`tcb`）进行，函数的超时、环境变量、定时器都声明在 `cloudbaserc.json` 里。要特别提醒的是：如果改用开发者工具的「上传并部署」，它**只上传代码、不读 `cloudbaserc.json`**，环境变量、超时、触发器都得去控制台手工补；而且云函数默认超时只有 20 秒，生成报告属于长任务，一定要把 `aiProxy` 的超时改到 60 秒，否则会被平台掐断。

**第四步是定时触发器**，cron 用的是腾讯云 SCF 的七字段格式，`tcb fn deploy` 部署时会随之上线，开发者工具上传则要手工建。六个触发器分别落在早上六点半到十点之间，外加支付对账每小时一次。

**第五步是 `dbInit` 这个运维函数**。它默认是只读巡检（先看看缺什么），只有显式带上口令和 `apply` 才会真正建集合、建索引；权限仍要另设（预设档可用上面那条 `ModifyDatabaseACL`，自定义规则走控制台）。跑完之后建议直接删掉这个函数，避免留着成为攻击面。

**第六步是域名**。服务器域名**无需配置**——因为检索和大模型都由云函数代打，云函数出网不受小程序域名白名单的限制，云数据库和云函数走 `wx.cloud` 也不需要域名。业务域名只影响「原文预览」能否内嵌打开，不登记就走降级路径，行为可预期。

**第七步是订阅消息（可选）**。默认三枚模板 ID 留空是**正常态**：端上不渲染授权按钮，三个定时任务只落站内数据、跳过推送，站内功能完全可用。要启用推送，需要按自己的服务类目走四步：申请三枚不同模板 → 填入 `.env` → 重新构建端上并重新部署三个函数 → 真机授权。有一个容易踩的坑：**三枚模板必须不同**，因为微信一次性订阅是「一次授权只够推一条」，三个定时任务共用一枚会导致先跑的吃掉授权、后跑的报错。

---

## 测试

测试运行在 Node 里，**不连云、不需要任何 Key**。`npm test` 会先用 `tsc` 把源码编译到测试目录，再跑全部用例；测试脚手架会准备好 Taro 和全局 `wx` 的替身，让纯逻辑可以在没有小程序环境的情况下被直接断言。

用例分成两类：

- **静态约束**：钉死「源码里必须 / 不得出现某写法」——比如云端闸门和端上口径必须一致、配置真源和云函数副本必须一致、两份手工同步的模型档位表必须逐字一致；配额那几张表还钉住「端上不许写」与「云端 `peek` 必须是主读法」。
- **纯函数断言**：对配额、缓存、报告清洗、事件聚簇这类无副作用的函数直接断言输入输出，包括「云端读不到时回退本机镜像、且回退不改变判定方向」这类边界。

---

## 成本与合规

**成本**方面，最大的单次开销是报告生成——一次生成会触发检索词规划、多路联网检索、分批大模型生成。其次是几个定时扫描任务，每轮都会真实调用上游（唯独舆情聚簇只读库、不联网、零成本）。为了把成本封顶，项目里有一条「事件驱动深挖」的设计：关键词预警和风险监控只有在**扫描命中时**才会对对象额外扩查一个词，而且被三层预算闸门限制（每次命中只查一个词、每轮最多六个、每天最多六十个）。这些上限、额度、报告预算的数值，真源都在 `benefits.ts`，改它 → 同步 → 重新部署即可。

**合规**方面，需要部署者自行确认并承担责任。项目内置了三层涉政涉军拦截：本地静态拦截（命中直接拒答、不发任何网络请求）、消歧提示词规则、报告提示词规则，人物名单在仓库里是空数组，上线前需要自行补充（空名单会被 `npm run release:check` 拦下）。AI 提问会经云调用做内容安全机审。报告中已经固定标注「AI 生成，仅供参考」。此外还内置了一套**个人信息保护（PIPL）合规设施**：平台隐私协议校验开关（`__usePrivacyCheck__`）、知情同意网关（`consent-gate` / `privacy-gate`）、撤回同意、导出个人数据（`utils/data-export.ts`）、注销账号（`userInit.deleteAccount`），配套影响评估留档在 `celebrity-radar/doc/个人信息保护影响评估.md`。其中**平台隐私协议校验开关默认是 `false`**：「后台配好隐私指引并通过审核」是把它改成 `true` 的前提，顺序反了会让头像 / 昵称接口被平台**直接拒绝**（这不是端上能兜住的错）；改完还要**重新构建**，因为上传的是产物而不是源码。发版前跑一次 `npm run release:check`，它会把这类「只在发版那一刻才需要」的开关连同产物一起对账，并把只能人工确认的事逐条列出来。需要再次强调：**本仓库不提供任何合规背书**。

---

## 免责声明

本项目生成的所有报告、榜单与舆情摘要，都由大模型基于**公开网络素材自动生成**，本质是「某一时刻公开信息的 AI 快照」，仅供信息参考，**不构成对任何真实个人或组织的事实陈述、评价或立场表达**。

项目内置了涉政涉军拦截、内容安全机审等机制，但它们只是**技术层防护**，不构成任何合规背书——**上线运营后的内容安全与合规责任，由部署者依据所在地法律法规自行承担**。仓库中的人物名单、拦截词表均为空占位，部署前需要自行补充。

一句话总结：**本仓库只提供技术实现与工程代码，不提供内容、数据或运营服务，也不对使用本项目产生的任何后果负责。**

---

## 目录结构

```text
celebrity-radar/                ← 仓库根目录（无 package.json）
├── README.md / README.en.md    中英文说明
├── LICENSE / NOTICE            许可证（Apache-2.0）与第三方署名
├── CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
├── assets/screenshots/         界面截图
└── celebrity-radar/            ← 小程序工程本体（npm 命令在此执行）
    ├── src/                    源码（components / utils / config / stores / styles / types）
    │   ├── pages/              主包 4 个底部 tab 页（发现 / 提问 / 舆情 / 我的）
    │   └── package/            分包 22 个二级页（报告 / 名人主页 / 关注流 / 周报 / 舆情事件 / 预警 / 监控台账 / 历史版本 / 设置 / 运维台 等）
    ├── cloudfunctions/         16 个云函数（dbInit/schema.js 为库结构真源）
    ├── scripts/sync-config.js  配置真源同步
    ├── test/                   测试（cases / harness / run.js）
    ├── config/                 Taro 构建配置
    ├── cloudbaserc.json        云函数 / 环境变量 / 定时器声明
    ├── project.config.json     开发者工具工程配置
    ├── package.json            依赖与 scripts
    └── .env.example            部署密钥模板（复制为 .env）
```

---

## 常见问题 / 已知限制

- **推送不可用**：订阅消息模板需要在**你自己的服务类目**下申请，部分类目根本拿不到相应模板，这是部署环境的限制，而不是功能缺失——模板留空时，系统会退化成只落站内数据，站内功能不受影响。
- **时效性**：报告和榜单本质上是「某时刻公开素材的 AI 快照」，不保证实时。报告是全局共享缓存，改了参数只会影响之后新生成的报告，旧缓存不会自动重建，除非手动点「重新生成」。
- **端上上限不是安全边界**：端上的额度、调试开关、监控上限都只是体验层的设计，改包可以绕过；真正守住成本边界的是云端——防滥用计数表、会员权威表都只在云端判定。
- **配额数字一直不动 / 额度从不拦截**：先确认「开发者工具里登录的是不是真机上那个微信」——切换账号后，`wx.getStorageSync('auth:profile').userId` 必须与 `users` 表里那一行的 `_openid` 一致；配额按 `openid#日期` 分行，不同账号看的是各自那一行，两台设备数字不同通常只是这个原因。同账号仍为 0 时，在端上 Console 回读一次：`wx.cloud.callFunction({ name: 'quotaGuard', data: { kind: 'ask', action: 'peek' } }).then(r => console.log(r.result))`（把 `kind` 换成 `generate` / `refresh` 查另外两类）。返回 `{ ok: true, count: N }` 说明云端那行确实是 N —— 此时界面若仍是 0，那是本机镜像或页面没刷新（退出重进「我的」页即可），与权限无关。端上直读只在云函数不可达时才用得上，它失败只会让数字偏旧，不会再让额度形同虚设。`2026-10-18` 起展示与闸门都以这个 `peek` 为主读法，所以「数字不动」基本只剩三种成因：账号不对、当天确实没有那一行、云函数未部署。

---

## Roadmap

> 以下只是可能的演进方向，**并非路线承诺**；欢迎在 Issue 里讨论优先级。

- [ ] 报告缓存的**增量重建**：改了参数不必整份重新生成。
- [ ] 接入更多检索源与大模型厂商，并保持「配了哪家才出现哪家」的约定。
- [ ] 借助 Taro 的多端能力，探索 H5 / 其他小程序平台的复用。
- [ ] 更细粒度的运营与成本看板。

---

## 支持本项目

项目**同时在 GitHub、Gitee 与 AtomGit 开源**，欢迎 Star 与提 Issue：

- **GitHub**：<https://github.com/qianlongloves/CelebrityRadar>
- **Gitee**：<https://gitee.com/qianlonglove_admin/celebrity-radar>
- **AtomGit**：<https://atomgit.com/fivestar/CelebrityRadar>

如果这个项目对你有帮助，也可以请作者喝杯咖啡：

<table align="center">
  <tr>
    <td align="center"><img src="./assets/screenshots/wechat-pay.jpg" width="200"/><br/><sub>微信支付</sub></td>
    <td align="center"><img src="./assets/screenshots/alipay.jpg" width="200"/><br/><sub>支付宝</sub></td>
  </tr>
</table>

**作者**：刘双乐　·　**联系邮箱**：[qianlongloves@qq.com](mailto:qianlongloves@qq.com)

---

## 致谢

本项目站在以下开源项目的肩膀上，特此致谢：

- [Taro](https://github.com/NervJS/taro)（多端开发框架）、[React](https://reactjs.org/)（UI 框架）、[Taro UI](https://github.com/NervJS/taro-ui)（组件库）
- [zustand](https://github.com/pmndrs/zustand)（状态管理）、[zod](https://github.com/colinhacks/zod)（数据校验）、[dayjs](https://day.js.org/)（日期处理）
- [wx-server-sdk](https://github.com/tencentcloudbase/wx-server-sdk)（云开发服务端 SDK）

其余第三方依赖与署名见 [`NOTICE`](./NOTICE)。

---

## 贡献 / 安全 / 许可

欢迎提 Issue 和 PR：小的修复直接开 PR 即可，较大的改动建议先在 Issue 里讨论方向，避免白费功夫。

- **贡献指南**：[`CONTRIBUTING.md`](./CONTRIBUTING.md)　·　**行为准则**：[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- **安全策略**（**请勿公开 Issue 报告安全问题**）：[`SECURITY.md`](./SECURITY.md)
- **第三方署名**：[`NOTICE`](./NOTICE)　·　**许可**：**Apache License 2.0**，全文见 [`LICENSE`](./LICENSE)。

> `celebrity-radar/package.json` 的 `license` 字段为 `Apache-2.0`。版权归属：© 2026 刘双乐。

---

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=qianlongloves/CelebrityRadar&type=Date)](https://star-history.com/#qianlongloves/CelebrityRadar&Date)

**如果这个项目对你有帮助，请给个 ⭐ Star 支持一下。**

</div>
