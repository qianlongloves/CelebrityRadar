# 名人雷达（Celebrity Radar）

[English](./README.en.md) · **简体中文**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Taro](https://img.shields.io/badge/Taro-3.6-07c160.svg)](https://taro-docs.jd.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-243%20passing-success.svg)](#开发与测试)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> 面向微信生态的**名人动态情报台**小程序：输入任意名人名字 → 联网检索近期公开报道 → 大模型提炼成结构化报告（简介 / 人物档案 / 动态 / 语录 / 点评 / 争议与回应 / 时间线 / 名词解释…），再在端上聚合出词云、情绪走势与热度趋势。

- 技术形态：Taro 3（React）+ Taro UI ｜ 云后端：腾讯云 CloudBase（微信云开发）
- 许可：[Apache-2.0](./LICENSE) ｜ 更新日志：[`CHANGELOG.md`](./CHANGELOG.md)
- 仓库：[gitee.com/qianlonglove_admin/celebrity-radar](https://gitee.com/qianlonglove_admin/celebrity-radar) ｜ English: [`README.en.md`](./README.en.md)
- 从零部署：见下文「[快速开始](#快速开始)」与「[部署](#部署)」；想参与贡献先看 [`CONTRIBUTING.md`](./CONTRIBUTING.md)

---

## 目录

- [这是一个什么样的项目](#这是一个什么样的项目)
- [功能特性](#功能特性)
- [界面预览](#界面预览)
- [技术栈](#技术栈)
- [架构与核心链路](#架构与核心链路)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [部署](#部署)
- [项目结构](#项目结构)
- [核心模块](#核心模块)
- [安全与合规](#安全与合规)
- [开发与测试](#开发与测试)
- [常见问题](#常见问题)
- [已知限制](#已知限制)
- [贡献指南](#贡献指南)
- [反馈与支持](#反馈与支持)
- [版本与更新日志](#版本与更新日志)
- [许可与致谢](#许可与致谢)

---

## 这是一个什么样的项目

一个完整、可编译运行的微信小程序工程：端上 19 个页面，云侧 9 个云函数与 14 张数据库集合，
覆盖「搜索 → 消歧 → 检索 → 生成 → 缓存 → 订阅 / 收藏 / 分享 / 问答 / 对比」的全链路。

设计重心只有两条：

1. **不买也能用** —— 缓存命中的报告不限次浏览；关注 / 收藏 / 历史 / 热门榜全部免费开放，不设付费墙。
2. **不烧冤枉钱** —— 报告是**全局共享缓存**（同一人只生成一次，所有用户复用）、`building` 字段作跨设备生成互斥锁、
   冷却只拦「值得等待」的那类失败、配额计数服务端化。三套机制把上游成本压在可控范围。

> ⚠️ **这是一份完整的代码，不是一个可以直接上线运营的产品。**
> 仓库里**没有任何可用凭据**：appid、云开发环境 ID、上游 API Key 全部是占位符，需要你自备。
> 要真正跑通主链路，还差三样东西，见下文「[快速开始](#快速开始)」。

---

## 功能特性

| 分类 | 模块 | 能力 |
|---|---|---|
| **内容生产** | 发现与消歧 | 搜索框 + 热门领域卡；同名人物候选列表（带领域筛选项）+「都不是 TA」兜底，产出稳定 `personKey`（形如 `雷军#tech`） |
| | 报告生成 | 博查联网检索 → LLM 生成结构化 JSON → zod 全字段校验 + 来源 URL 白名单清洗；**逐段卡片化渲染**（简介 / 人物档案 / 关系图谱 / 近期动态 / 经典名言 / AI 点评 / 近期争议与回应 / 时间线 / 后续关注 / 名词解释 + 一行溯源摘要），骨架屏 + 逐段呈现，附「生成于 xx 前 / 刷新最新」双入口；事实类段落**必须指出素材出处**，指不出一律整条剔除，段落真的为空也出卡写明原因 |
| | 端上聚合卡 | 人物速览 / 立场与舆情 / 关键词云 / 语录主题 / 热度趋势 —— **纯端上聚合**，存量缓存同样生效，不新增模型调用与生成额度 |
| | 出处核对 | 只核对「能核对的事实」（这条名言的出处链接是否在本次素材内、那篇报道里有无相同表述），**不做 AI 真伪判定** |
| **浏览与沉淀** | 关注 | 关注列表 + 变化概览（谁有新动态）+ 聚合流（`feed_cache` 归并 + 下拉刷新，每账号每日 ≤ 10 次） |
| | 周报 | 一键汇总关注对象最近 7 天的动态 → 逐人要点 + 本周综述 + 话题词；素材取自缓存，**人与其条目以材料为准**，按 ISO 周本机缓存 |
| | 收藏 / 历史 | 四类收藏（名言 / 报告 / 动态 / 时间线，`openid#type#hash` 主键防重）+ 浏览历史（保留 50 条）；收藏页名言可直接出**名言卡** |
| | 消息中心 | 一条时间流：关注更新 / 周报提醒 / 平台公告 / 关键词预警；已读**逐条记**，只存本机（零新增集合 / 云函数 / 模型调用） |
| | 分享 | 名言卡（Canvas 2D 端上出图，图片不落云存储）+ 原生转发；落地页统一为「具体某个人的报告页」 |
| **探索** | 热门榜 | AI 每日生产（`hot_board`），三级回退（AI 榜 → 已有缓存报告 → 静态清单）；**全员可见全部位数**，不分档 |
| | 关键词预警 | 订阅关键词 → 云函数每日定时按词检索 → 端上列出「上次看过之后新增的条目」，并按订阅消息推送 |
| | 主题知识库 | 把「以人为中心」的报告缓存翻转成「以话题为中心」的视图：一个话题 → 谁在说 / 说过什么 / 有哪些报道 / 何时被讨论 |
| | 对比 | 两位名人横向对比（复用两方缓存报告，零模型调用），可一键关注 / 分享 |
| | AI 问答 | 语料 = 该名人**已缓存报告**摊成的带编号片段（按可信度排序、按汉字二元组命中选片段）；提问时**额外做一次联网检索**并合流竞争预算，检索不通静默降级为「只依据报告作答」 |
| **会员（freemium）** | 额度 | 免费版每日 3 次主动生成、会员 30 次（缓存命中不计次）；AI 提问免费 5 次 / 会员 30 次；配额在「我的」页透明展示 |
| | 「质」权益 | **模型供应商自选**（DeepSeek / 通义千问 / 智谱 GLM / Moonshot 任选，key 全在云函数，用户零配置）+ 模型档位（免费版锁定「极速版」，会员可用「标准版 / 深度推理」；换供应商时档位清单整组跟着换，用户选的那一档不变）+ 报告**深度模式**（检索加厚 + 对比视角 / 风险提示 / 信源分歧三段专享内容） |
| | 定价 | 月 ¥9.9 / 季 ¥25 / 年 ¥68；**价格源唯一**（云函数 `payCreate` 的 `PLANS`，端上拉取展示，改价无需发版） |
| **平台能力** | 合规 | 敏感名单一级拦截（命中即拒答，**不发任何网络请求**）、来源 URL 白名单、全链路标注「AI 生成，仅供参考」 |
| | 端上零密钥 | 所有上游请求经云函数代发；配额计数服务端化（原子自增 + 服务端日期）；会员闸门在云侧强校验（改包绕不过） |

---

## 界面预览

> 以下均为**真机截图**（iPhone），按功能分组；每张下方的说明即该页的核心口径。
> 图片存放在 `assets/screenshots/`，**同名替换即可更新本节**，无需改动本文引用。

**发现与检索**

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/01-home.png" width="200" alt="首页"><br><sub><b>首页</b> · 搜索入口 / 热门领域 / 今日热门</sub></td>
    <td align="center"><img src="./assets/screenshots/02-search.png" width="200" alt="搜索与消歧"><br><sub><b>搜索与消歧</b> · 同名候选列表 + 领域筛选</sub></td>
    <td align="center"><img src="./assets/screenshots/03-hot-board.png" width="200" alt="热门榜"><br><sub><b>热门榜</b> · AI 每日生产，全员可见全部位数</sub></td>
  </tr>
</table>

**关注与消息**

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/04-feed.png" width="200" alt="关注动态"><br><sub><b>关注动态</b> · 聚合流 + 下拉刷新</sub></td>
    <td align="center"><img src="./assets/screenshots/05-following.png" width="200" alt="关注列表"><br><sub><b>关注列表</b> · 变化概览：谁有新动态</sub></td>
    <td align="center"><img src="./assets/screenshots/07-message-center.png" width="200" alt="消息中心"><br><sub><b>消息中心</b> · 关注更新 / 周报 / 预警一条时间流</sub></td>
  </tr>
</table>

**探索与问答**

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/06-keyword-alert.png" width="200" alt="关键词预警"><br><sub><b>关键词预警</b> · 只列出上次看过后新增的条目</sub></td>
    <td align="center"><img src="./assets/screenshots/08-qa.png" width="200" alt="AI 问答"><br><sub><b>AI 问答</b> · 语料为你已缓存的报告，带编号来源作答</sub></td>
  </tr>
</table>

**会员与配置**

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/09-mine.png" width="200" alt="我的页"><br><sub><b>我的</b> · 配额透明展示 / 会员权益</sub></td>
    <td align="center"><img src="./assets/screenshots/10-providers.png" width="200" alt="模型供应商"><br><sub><b>模型供应商自选</b> · DeepSeek / 通义千问 / 智谱 GLM / Moonshot 任选</sub></td>
  </tr>
</table>

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Taro 3.6（React 18）+ TypeScript | webpack5 编译 |
| UI | Taro UI 3.x + SCSS（750 设计稿） | 全局主题变量位于 `src/styles/` |
| 状态 | zustand | `src/stores/auth.ts` 等 |
| 校验 | zod | 报告 Schema 全字段校验 |
| 时间 | dayjs | 相对时间、ISO 周、配额日期键 |
| 云后端 | 腾讯云 CloudBase（微信云开发） | 数据库 + 云函数；环境 ID 由本地配置提供 |
| 检索源 | 博查 `api.bochaai.com` | 经云函数 `aiProxy` 代发 |
| 大模型 | OpenAI 兼容端点 | 默认 `https://api.deepseek.com/v1`；可选供应商与各家的三档位见 `src/config/public.ts`，端点 / key 变量名 / 会员档位见 `cloudfunctions/aiProxy/llm.config.js` |

> 依赖安装使用 `.npmrc` 中的 `legacy-peer-deps=true`；`@tarojs/plugin-platform-*` 钉在 `^3.6.25`（勿升级），webpack 钉 `~5.91.0`。

---

## 架构与核心链路

```
用户输入名人名
  → 本地敏感名单拦截（命中即拒答）
  → LLM 消歧 → 候选选人 → personKey
  → 命中 report_cache？──是→ 直接渲染（不触发生成）
       │否
       └→ 博查联网检索（api.bochaai.com）→ 素材
          → OpenAI 兼容大模型生成结构化 JSON → zod 校验 + URL 白名单清洗
          → 写入 report_cache → 渲染报告
```

分层调用关系：

```
pages / components        页面与展示
     ↓
src/utils/**              业务逻辑与云访问层（页面唯一的调用出口）
     ↓
utils/db.ts               自建数据访问适配层（id ↔ _id 映射、分页续取、写兜底）
utils/cloud.ts            CloudBase 初始化与诊断
     ↓
cloudfunctions/**         9 个云函数（密钥、配额、机审、定时任务、支付）
     ↓
上游：博查检索 / 大模型 / 微信支付 / security.msgSecCheck
```

两个关键机制：

- **`report_cache.state = building` 作为跨设备生成互斥锁**：并发查同一人时仅一方代表生成，另一方等待读取结果。
- **缓存命中优先于冷却与配额**：命中即渲染，不消耗额度、不受冷却限制。

---

## 快速开始

### 环境要求

- Node 16 / 18（建议 LTS）
- 微信开发者工具
- 已开通云开发的小程序 appid

### 安装与运行

```bash
git clone https://gitee.com/qianlonglove_admin/celebrity-radar.git
cd celebrity-radar/celebrity-radar

cp src/config/local.example.ts src/config/local.ts   # ← 必做，否则编译报 Cannot find module './local'
npm install                                           # .npmrc 已开 legacy-peer-deps

npm run dev:weapp      # 开发模式（watch，产物 dist/）
npm run build:weapp    # 生产构建，产物 dist/
npm run build:h5       # H5 端构建（调试用）
npm test               # 本地单测，不需要云环境
```

用微信开发者工具导入 `celebrity-radar/` 目录（`miniprogramRoot: dist/`、`cloudfunctionRoot: cloudfunctions/`）；
开发期可勾选「不校验合法域名」先行联调。

### 想真正跑通主链路，还差三样东西

| 你需要自备 | 用途 | 不配的后果 |
|---|---|---|
| 云开发环境 ID | 数据库与 9 个云函数都跑在这里 | 登录与**全部** DB 调用不会发起，「我的」页显示「云服务未配置」 |
| `DEEPSEEK_API_KEY` | 生成报告（经云函数 `aiProxy` 代打）。用户在「我的」页可以切到别家，**列出哪几家就要配哪几家的 key**（`QWEN_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`）；没配的家用户一切过去就是「未配置额度」 | 生成报错；已缓存报告的浏览、收藏仍可用 |
| `BOCHA_API_KEY` | 联网检索素材 | 检索为空，报告缺素材、时间线不完整 |

完整清单（含权限、索引、定时任务、上线合规）见下文「[部署](#部署)」一节。

---

## 配置说明

### 1. 端上配置：`public.ts`（进包）+ `local.ts`（不进包）

| 文件 | 进版本库 | 放什么 |
|---|---|---|
| `src/config/public.ts` | ✅ | 与部署无关的公共配置：可选**供应商**清单与各家的三档位、`memberOnly` 分档。**严禁写入任何 key**（key 在云函数环境变量里，用户切换供应商只是换一次请求参数） |
| `src/config/local.example.ts` | ✅ | 本地配置**模板**，值全为占位串 |
| `src/config/local.ts` | ❌（已被 `.gitignore`） | 你自己小程序的真实值：环境 ID、订阅模板 ID、业务域名白名单、本地调试开关 |

`local.ts`（首次 clone 后由 `local.example.ts` 复制而来）：

| 字段 | 说明 |
|---|---|
| `cloudbaseEnvId` | CloudBase 环境 ID。保持占位串 `REPLACE_ME` 时云服务视为未配置，登录与 DB 调用不会发起 |
| `subscribeTemplateId` | 关注更新订阅消息模板 ID，与云函数环境变量 `SUBSCRIBE_TEMPLATE_ID` 指向同一模板 |
| `alertTemplateId` | 关键词预警的模板 ID，**必须与上一个不同**：微信一次性订阅授权**按模板**消耗，两个定时任务共用一个模板会互相吃掉授权位（先跑的用掉，后跑的必得 43101） |
| `webviewDomains` | 「原文预览」页可内嵌的业务域名白名单；留空则一律走「素材预览卡 + 复制链接」降级路径 |
| `debug` | 本地调试开关（放开额度闸门与上游冷却）。**仓库默认五项全 false**，只在本地联调时置 true |

`public.ts`：

| 字段 | 说明 |
|---|---|
| `llm.providers` | 可选**供应商**清单：每家有 `id`（须与云函数 `llm.config.js` 的 `PROVIDERS` 键一致）、展示名，与 `models`（统一的三档：`fast` / `standard` / `reason` = 极速版 / 标准版 / 深度推理）。**只列你云端配了 key 的家** —— 用户切到哪家，云函数就用哪家的 key 代打，端上不持有任何凭据 |
| `llm.provider` / `llm.model` / `llm.models` | 默认供应商、它的默认模型名、以及它的档位清单（后两者分别 = `providers[0]` 的 fast 档与 `providers[0].models`）。档位标签三家统一，所以会员文案（会员中心对比表、权益表）按它推导即可，加一家供应商不用改文案 |
| `models[].memberOnly` | `true` = 会员专属：免费用户即使本机选了该档，生成时也会回落该家的极速版。**改这一列必须同步云函数 `aiProxy` 的 `llm.config.js` 里对应供应商的 `memberOnlyModels`**，那份才是计费闸门（端上这份改包即可绕过） |

> 用户的供应商 / 档位偏好只存本机 storage（`settings:llm_provider` + `settings:llm_tier`）。
> 存的是**档位标识**而不是模型名，所以换供应商时「我选的那一档」跟着走（DeepSeek 标准版 → 通义千问标准版），
> 不需要用户重选一次；而档位清单整组换成那家的三档，这正是「换家 = 换档位参数」。

> 两个文件都会打进小程序包，所以**严禁**写入任何真实 key。
> 拆成两个文件的目的：仓库里留真实环境 ID，避免 fork 者直接连上原作者的云环境；
> 而作者本地为放开额度把 `debug` 置 true 的改动，混在 `public.ts` 里也总有误提交的风险。
> ⚠️ **上线前 `debug` 节五项必须全 false**，否则免费层限流（每日 3 次生成 / 5 次提问）与 429 冷却保护都会失效。

### 2. 密钥归属：只在服务端，端上零密钥

| 项 | 存放位置 |
|---|---|
| 检索 / 大模型 Key | 云函数 `aiProxy` 环境变量：`BOCHA_API_KEY` + 各家大模型的 key（`DEEPSEEK_API_KEY` / `QWEN_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`）。**端上清单里列了哪几家，这里就要配齐哪几家** |
| 部署期的密钥来源 | `celebrity-radar/.env`（由 `.env.example` 复制，**不进版本库**），由 `cloudbaserc.json` 以 `${env.XXX}` 引用 |

全部请求经云函数代发，客户端不持有任何 Key，用户零配置。历史版本曾支持「用户填自己的 Key」的本机直连（BYOK），**已整体移除**。

### 3. 域名与后台

- request 合法域名：`https://api.bochaai.com`、`https://api.deepseek.com`（云数据库走 `wx.cloud`，不占域名）
- 后台开通「客服功能」并绑定客服人员（内容举报 / 反馈依赖 `open-type="contact"`）
- 后台配置隐私协议（收集：匿名标识 openid、本地存储）

---

## 部署

> 后面按「云函数 → 云数据库 → 定时器 → 小程序端」的顺序列出**需要准备的每一项**与踩坑点。
> 部署顺序有依赖（先有集合和权限，函数里的读写才不会静默失败），建议按序号做。
> 仓库的 `doc/` 目录是**作者本地的内部文档，不随仓库分发**，故下文不引用它；所需信息本文已覆盖。

### 1. 云函数（9 个）

`cloudbaserc.json` 已声明函数、环境变量与定时器；部署前把密钥填进 `.env`（模板见 `.env.example`）。

| 函数 | 作用 | 触发 | 环境变量 |
|---|---|---|---|
| `aiProxy` | 平台代付上游密钥（`test` / `search` / `chat`）+ 会员模型闸门（会员的素材加厚按 `count` 分档）+ 对话输出上限（所有请求都下发，见 `chatMaxTokens`）；**供应商由端上请求指定**（用户自选），云端只兜底 | 端上调用 | `BOCHA_API_KEY` + 各家大模型 key（`DEEPSEEK_API_KEY` `QWEN_API_KEY` `ZHIPU_API_KEY` `MOONSHOT_API_KEY`） |
| `quotaGuard` | 配额计数权威（原子自增 + 服务端日期），`refresh` / `generate` / `ask` 三类 | 端上调用 | — |
| `contentCheck` | 内容安全机审（云调用 `security.msgSecCheck`），送检源 = AI 提问 | 端上调用 | — |
| `hotBoardRefresh` | 热门名人榜每日生产（写 `hot_board`） | 定时 06:30 | `BOCHA_API_KEY` + 它用的那一家（定时任务没有端上偏好，取 `LLM_PROVIDER`，默认 DeepSeek） |
| `notifyFollowUpdates` | 关注更新订阅消息推送 | 定时 09:00 | `BOCHA_API_KEY` `SUBSCRIBE_TEMPLATE_ID` |
| `keywordAlert` | 关键词舆情预警（按订阅词检索并写 `keywords`） | 定时 09:20 | `BOCHA_API_KEY` `ALERT_TEMPLATE_ID` |
| `payCreate` | 会员下单（服务端定价 + 云支付统一下单） | 端上调用 | `WX_PAY_SUB_MCH_ID` `PAY_CALLBACK_ENV_ID` |
| `payCallback` | 支付结果通知（金额校验 + 幂等续期会员） | 微信支付回调 | — |
| `dbInit` | 运维工具：建集合 / 比对字段 / 建·改索引（端上不调用） | 手动 | `DB_ADMIN_TOKEN` `WX_APPID` `WX_APPSECRET` |

几条容易踩的：

- **「配置是否随部署生效」取决于部署方式**：`tcb fn deploy`（CloudBase CLI）会读仓库根 `cloudbaserc.json`，把环境变量、超时、触发器一并下发；微信开发者工具右键「上传并部署」**只上传代码**，不读 `cloudbaserc.json` ⇒ 环境变量 / 超时 / 触发器都得去控制台补。
- `aiProxy`、`hotBoardRefresh`、`notifyFollowUpdates` 的执行超时必须是 **60 秒**（`aiProxy` 内还要满足 `LLM_CHAT_TIMEOUT_MS = 50000` 更小），否则长报告、热门榜一轮「6 检索 + 1 生成」、推送一轮最多 20 次检索都会被平台提前掐断（端上 `-504003`）。
- `quotaGuard` 无环境变量，但**必须（重新）部署在「收紧配额表权限」之前**；顺序颠倒会让端上回退写入被拒、计数恒为 0 ⇒ 免费额度失效。
- `dbInit` 是**运维工具、不是运行时依赖**：先跑 `{ "action": "report" }` 只读巡检；写操作须先配 `DB_ADMIN_TOKEN`（未配则写操作一律拒绝）；用完可删除该函数。
- `contentCheck` 无环境变量（走云调用，凭证由平台托管），唯一前提是 `cloudfunctions/contentCheck/config.json` 里的 `permissions.openapi` **随上传生效**；缺这条声明时端上按 **fail-open** 静默放过。⚠ 它没法用控制台「云端测试」验（需要真实 `openid`），只能在真机问答页验。

### 2. 云数据库（14 张集合）

CloudBase 文档型数据库。端上写业务字段 `id`，由 `utils/db.ts` 映射到系统主键 `_id`。

| 集合 | 用途 | 权限 |
|---|---|---|
| `users` | 账号与设置（首登自动写入；`membership` 由支付回调写、端上只读） | 仅创建者可读写 |
| `report_cache` | 报告缓存 + `building` 生成互斥锁（全局共享、长期复用） | 所有人可读、登录可写 |
| `feed_cache` | 检索结果结构化映射（不存 LLM 产物） | 所有人可读、登录可写 |
| `hot_board` | 热门名人榜（AI 每日写，`_id` 固定 `latest` 覆盖写） | 所有人可读、客户端不可写 |
| `keywords` | 关键词检索缓存（全局共享） | 所有人可读、客户端不可写 |
| `refresh_quota` | 关注流每日刷新 ≤ 10 次（`openid#yyyy-MM-dd`） | 本人可读、不可写（写仅限云函数） |
| `generate_quota` | 报告每日生成配额（免费 3 / 会员 30） | 本人可读、不可写（同上） |
| `ask_quota` | AI 提问每日配额（免费 5 / 会员 30，成功才计数） | 本人可读、不可写（同上） |
| `orders` | 会员订单状态机（`pending → paid` / `failed`） | 本人可读、不可写（写仅限支付云函数） |
| `follows` | 关注列表（`openid#personKey`） | 仅创建者可读写 |
| `favorites` | 收藏（四类，`openid#type#hash` 防重） | 仅创建者可读写 |
| `history` | 浏览历史（保留 50 条） | 仅创建者可读写 |
| `events` | 埋点 | 仅创建者可读写 |
| `keyword_watches` | 关键词订阅（`openid#关键词哈希`，与 `follows` 同构） | 仅创建者可读写 |

建库与权限的现状（fork 者必读）：

- **集合**可由运维函数 `dbInit` 一键建齐（`cloudfunctions/dbInit/schema.js` 是库结构的**单一事实源**）。
- **权限必须在控制台手工设置** —— 没有任何接口能改集合权限，需在上表逐张集合手工配置。
- **索引可以程序化**：由 `dbInit` 走微信 HTTP API「更新索引」建 / 改，或按手册 §五 手工建。
- 哪些还没设？用 `dbInit` 的 `{"action":"report"}` 一查即知。

### 3. 会员支付（可选）

代码已完整落地（`payCreate` / `payCallback` + `utils/pay.ts` + 「我的」页入口），但要人工配置才能用：

1. 云开发控制台开通微信支付并绑定商户号；
2. 给 `payCreate` 配环境变量 `WX_PAY_SUB_MCH_ID` 与 `PAY_CALLBACK_ENV_ID`；
3. 部署 `payCallback`。

支付回调函数名由 `payCreate` 内的 `functionName: 'payCallback'` 指定，**改名会收不到通知**。
未配置时端上明确提示「微信支付未配置 / 支付服务未部署」，且不影响免费功能（仍按免费版 3 次/日）。

---

## 项目结构

> 下列路径相对 `celebrity-radar/` 子目录；仓库根另有 `README.md` / `README.en.md` / `LICENSE` / `NOTICE` /
> `CHANGELOG.md` / `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / `assets/screenshots/`。
> （另有 `doc/` 为作者本地的设计与部署文档，已在 `.gitignore` 中排除，**不随仓库分发**。）

```
celebrity-radar/
├── src/
│   ├── pages/                  # 19 个页面
│   │   ├── index/              # 发现（tabBar）
│   │   ├── ask/                # AI 提问（tabBar）
│   │   ├── collection/         # 收藏（tabBar）
│   │   ├── mine/               # 我的（tabBar）
│   │   ├── report/             # 报告页（核心）
│   │   ├── profile/            # 名人主页
│   │   ├── feed/               # 关注流
│   │   ├── following/          # 关注列表
│   │   ├── weekly/             # 本周周报
│   │   ├── compare/            # 两位名人横向对比
│   │   ├── qa/                 # AI 问答（报告页入口）
│   │   ├── topic/              # 主题知识库
│   │   ├── alerts/             # 关键词舆情预警
│   │   ├── messages/           # 消息中心
│   │   ├── history/            # 浏览历史
│   │   ├── records/            # 收藏 / 记录入口
│   │   ├── link-preview/       # 素材原文预览
│   │   ├── member/             # 会员中心
│   │   └── agreement/          # 隐私与免责
│   ├── components/             # person-card / favorites-view / report-loading / share-poster / qa-panel 等
│   ├── utils/                  # 业务与云访问层（43 个模块，见「核心模块」）
│   ├── config/                 # public.ts（公共配置）/ local.ts（本地配置，不进库）/ domains / hot / filters / notices
│   ├── stores/                 # zustand store
│   ├── styles/                 # 主题变量、底栏图标
│   └── custom-tab-bar/         # 自定义底部菜单
├── cloudfunctions/             # 9 个云函数
│   ├── aiProxy/                # 平台代付密钥闸门 + 会员模型闸门（test / search / chat）
│   ├── quotaGuard/             # 配额计数权威（原子自增 + 服务端日期）
│   ├── contentCheck/           # 内容安全机审（云调用）
│   ├── payCreate/              # 会员下单（服务端定价 + 云支付统一下单）
│   ├── payCallback/            # 支付结果通知（金额校验 + 幂等续期）
│   ├── notifyFollowUpdates/    # 关注更新订阅消息（定时 09:00）
│   ├── keywordAlert/           # 关键词舆情预警（定时 09:20）
│   ├── hotBoardRefresh/        # 热门名人榜每日生产（定时 06:30）
│   └── dbInit/                 # 运维工具（schema.js 是库结构单一事实源）
├── test/                       # 本地单测（3 个用例文件 / 243 条用例）
├── config/                     # Taro 构建配置（dev / index / prod）
├── cloudbaserc.json            # CloudBase 部署描述（函数 + 环境变量 + 定时器）
├── .env.example                # 云函数部署密钥模板
├── project.config.json         # 微信开发者工具工程（miniprogramRoot: dist/）
└── project.private.config.example.json
```

---

## 核心模块

`src/utils/` 是全部业务逻辑与云访问的唯一出口（页面只调这里，不直接碰 DB 与上游）。

| 模块 | 职责 |
|---|---|
| `cloud.ts` / `db.ts` | CloudBase 初始化与诊断；自建数据访问适配层（`table('x').select/eq/or/upsert/maybeSingle`），`id ↔ _id` 双向映射、分页续取、写操作兜底 |
| `auth.ts` | 微信登录 + `users` 首次初始化；并发登录去重、登录态落盘、脏缓存拒绝 |
| `search.ts` | 博查适配器（无 Key 降级），素材归一为 `NewsItem`；提问用的 `searchForAsk` |
| `disambiguate.ts` | LLM 同名消歧 + 领域码枚举 + 兜底 |
| `report.ts` | 报告生成、zod 校验、URL 白名单清洗、降级纯文本 |
| `cache.ts` | `report_cache` 读写 + `building` 互斥、`feed_cache`、`refresh_quota` |
| `quota.ts` / `quota-guard.ts` | freemium 生成配额与它的服务端通道（未部署时静默回退端上计数） |
| `llm.ts` | LLM 调用：统一经 `aiProxy` 代付；**供应商 + 档位**由本机偏好 + `public.ts` 裁决（换供应商不换档），非会员请求会员档位一律回落该家极速版 |
| `member.ts` / `member-sample.ts` | 会员权益表（唯一事实源）+ 会员判定 + 报告页会员价值条文案；会员中心「真实示例」（只节选不改写、挑不到就不出卡） |
| `pay.ts` | 会员支付：拉取服务端套餐（24h 本机缓存 + 离线兜底）+ 下单 + 拉起收银台 + 轮询确认（价格与时长**只认服务端**） |
| `qa.ts` | AI 问答：报告片段选片 + 提问时联网检索 + 每日额度闸门（回答成功才计数）+ 3 秒连点间隔 |
| `weekly.ts` | 关注周报：材料只读 `feed_cache`，LLM 只写文字（人 / 条目以材料为准），按 ISO 周本机缓存 |
| `hot-board.ts` / `explore.ts` | 热门榜三级回退读取；「今日名人」与随机探索（种子稳定，xorshift32 去取模偏置） |
| `keyword-alert.ts` / `keywords.ts` | 关键词订阅与预警条目；关键词云 + 高频观点（纯端上聚合，存量缓存立即生效） |
| `topic-digest.ts` / `compare.ts` / `stats.ts` / `trend.ts` | 主题编目 / 两人对比 / 主页数据 Tab / 热度趋势折线 —— 全部纯端上聚合，不新增 Schema 字段与云函数 |
| `quote-check.ts` / `source-link.ts` | 名言出处核对（只核对可核对的事实）；原文预览页的唯一跳转出口 |
| `messages.ts` / `notify.ts` | 消息中心时间流与已读口径；微信订阅消息授权与推送落位 |
| `share-card.ts` / `share.ts` | Canvas 2D 名言卡（零网络图依赖、不落云存储）；全项目唯一分享文案出口 |
| `sensitive.ts` / `sec-check.ts` | 本地敏感名单一级拦截（发版前人工维护）；内容机审（fail-open） |
| 基础件 | `time.ts`（相对时间 / 报告过期天数唯一阈值）、`cooldown.ts`（429 冷却 10 分钟）、`debug.ts`（调试开关集中出口）、`cloud-diagnostics.ts`（结构化诊断日志）、`settings.ts`、`events.ts`、`tabbar.ts`、`data-deletion.ts` |

---

## 安全与合规

- **密钥永不进包**：端上只存本地 storage，服务端只存云函数环境变量
- **输入侧**：本地敏感名单一级拦截，命中即拒答，**不发任何网络请求**
- **输出侧**：报告 `sources` / `dynamics` 链接强制 URL 白名单清洗，只保留检索素材中出现过的链接
- **内容口径**：全链路标注「AI 生成，仅供参考」；隐私声明页 + 举报入口 + 「清空我的数据」二次确认
- **运行成本**：报告缓存共享复用、每账号每日刷新 ≤ 10 次、主动生成 ≤ 3 次（会员 30）、`building` 互斥避免并发重复生成、关注周报按自然周本机缓存
- **冷却只拦「值得等待」的失败**：仅上游限流 429 / 网络 / 5xx 进入 10 分钟冷却；密钥无效、额度不足即时报错且不冷却；缓存命中永远优先于冷却与配额
- **漏洞报告**：请**不要**开公开 Issue，按 [`SECURITY.md`](./SECURITY.md) 的渠道私下联系。
  判据提醒：改包让端上显示会员档**不算**漏洞（闸门在云端），云端闸门可被绕过才算

---

## 开发与测试

```bash
npm test          # tsc 编译测试产物 + 跑全部用例（243 条，纯本地、不连云）
npm run test:only # 跳过 tsc，直接跑
```

测试特点：**零新增依赖**（自建内存版 CloudBase + Taro / `wx` 替身 + 极简断言库），断言对象是**编译后的产品代码本身**，
运行不需要云环境、开发者工具或上游网络。不覆盖页面渲染、真机交互、云端函数执行、支付与推送。

提交前请确认：

1. `npm test` 全绿（当前 243 / 243）
2. `npx tsc --noEmit` 无新增告警
3. 检查小程序**主包体积**（硬上限 2MB，当前约 1.2MB）；新增依赖前先核对构建产物
4. `src/config/local.ts` 与 `debug` 开关**不要**提交（已在 `.gitignore` 内）
5. 改动涉及数据模型时，同步更新 `cloudfunctions/dbInit/schema.js`（库结构的单一事实源）

---

## 常见问题

| 问题 | 结论 |
|---|---|
| 能直接跑起来吗？ | 能编译。要跑通生成链路，需自备云开发环境 + DeepSeek / 博查两个 Key |
| 会烧钱吗？ | 会。检索与大模型都按量计费 —— 项目里的配额、缓存、冷却三套机制正是为此而生 |
| 能商用吗？ | 协议允许。但**上线另需你自己的主体资质、类目备案与 AI 生成内容合规措施** |
| 会员支付能用吗？ | 代码完整（`payCreate` / `payCallback` / 定价表 `PLANS`），但需要你自己的微信支付商户号；未配置时端上明确提示，不影响免费功能 |
| 品牌能沿用吗？ | 「名人雷达」属原作者，fork 后建议改成自己的名字再发布，以免混淆 |
| 为什么保留商业化代码？ | 它是一份完整参考实现：定价源唯一、端上只读、云函数强校验，取舍都写在注释里 |
| 换上游供应商难吗？ | 用户能自选的那几家在 `src/config/public.ts` 的 `llm.providers`；云端注册表（端点 / key 变量名 / 会员档位）在 `cloudfunctions/aiProxy/llm.config.js`（`hotBoardRefresh` 有一份逐字相同的副本，两份都要改）。加一家 = 两端各加一项 + 配一个环境变量 |

**上游依赖风险**：检索源（博查）与大模型（DeepSeek，OpenAI 兼容端点）均为第三方付费服务，
接口、价格与可用性不受本项目控制。

---

## 已知限制

- 敏感名单 `src/utils/sensitive.ts` 需按最新合规要求在发版前**人工补充**，代码不做远程更新
- 内容机审 `contentCheck` 走云调用，未部署或权限未生效时按 **fail-open** 放过（可用性优先于拦截）
- 关键词预警依赖微信**一次性订阅**授权，模板 ID 与推送时机受平台规则约束
- 「原文预览」页能否 `webview` 内嵌取决于域名白名单与微信平台校验，未命中一律降级为预览卡
- 报告内容由大模型生成，**可能存在事实偏差**，务必以来源链接为准
- 测试覆盖的是逻辑与数据层，不含 UI 渲染、真机交互、云函数运行时与支付全链路

---

## 贡献指南

欢迎 Issue 与 Pull Request。**完整流程、评审标准与 Issue 模板见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)**，这里是速览：

1. 默认分支是 `master`，从它拉出特性分支（`feat/xxx`、`fix/xxx`、`docs/xxx`、`chore/xxx`）
2. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)（`feat:` / `fix:` / `docs:` / `chore:` …），一个提交只做一件事
3. 提交前跑完上面的「提交前请确认」5 条，并在 PR 描述里说明**改动动机**与**验证方式**
4. 涉及界面或交互的改动，请附真机截图
5. 改到「手工同步的两处」（供应商 / 档位表、会员档位闸门）时，两份必须一起改
6. 行为或配置变更请同步更新 `README`（中英两份）与 [`CHANGELOG.md`](./CHANGELOG.md)

参与本项目即表示你同意遵守 [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)。

我们不接受：提交真实密钥 / 环境 ID、绕过配额与会员闸门的「破解」改动、来源不明的素材与字体、
与项目定位无关的大规模重写（换框架 / 整仓格式化）。

---

## 反馈与支持

| 你想做的事 | 去哪 |
|---|---|
| 报告 Bug | [Gitee Issues](https://gitee.com/qianlonglove_admin/celebrity-radar/issues) —— 请按 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 末尾的模板填写，**务必先删掉日志里的 key 与 openid** |
| 提功能建议 | 先开 Issue 讨论动机与范围。本仓库的设计取舍都写在代码注释里，先对齐能省掉一次返工 |
| 报告安全漏洞 | **不要开公开 Issue**，走 [`SECURITY.md`](./SECURITY.md) 的私下渠道 |
| 使用求助 | 先查上方「[常见问题](#常见问题)」与「[已知限制](#已知限制)」，多数「不生效」都在那几条里；仍无解再开 Issue |
| 想知道改了什么 | [`CHANGELOG.md`](./CHANGELOG.md) |

本项目由个人维护，回复尽力而为（安全报告通常 7 个工作日内首次回复）。
提问前请先确认「能复现 + 已读过已知限制」——不少「不生效」正是那几条里的内容。

如果这个项目对你有帮助，欢迎在 Gitee 上给个 Star；把你踩到的坑补进「[常见问题](#常见问题)」，
比笼统的鼓励更有价值。

---

## 版本与更新日志

当前版本 **0.1.0**（见 `celebrity-radar/package.json`），全部变更记录在 [`CHANGELOG.md`](./CHANGELOG.md)。

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)：**MAJOR** = 需要部署者动手的迁移
（数据库结构、云函数契约、配置项改名，日志里会以「**部署者注意**」标出）；**MINOR** = 向后兼容的新能力；
**PATCH** = 修复与文案。

---

## 许可与致谢

本项目以 [Apache License 2.0](./LICENSE) 发布，版权与第三方组件声明见 [`NOTICE`](./NOTICE)。

- 上游服务：腾讯云 CloudBase（微信云开发）、博查检索、DeepSeek（或任意 OpenAI 兼容端点）、微信支付
- 开源依赖：Taro、Taro UI、React、zustand、zod、dayjs 等，版权归各自作者

**免责声明**：本项目仅用于技术学习与交流。使用者需自行承担因使用本项目产生的一切后果，
包括但不限于上游 API 费用、内容合规责任与数据安全责任。「名人雷达」名称与品牌归原作者所有。

