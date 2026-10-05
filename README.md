# 名人雷达（Celebrity Radar）

> 面向微信生态的**名人动态情报台**小程序：输入任意名人名字 → 联网抓取近期公开信息 → AI 提炼成结构化报告（名言 / 动态 / 点评 / 时间线 / 来源）。
>
> 技术形态：Taro 3（React）+ Taro UI ｜ 云后端：腾讯云 CloudBase（微信云开发）
> 文档最后更新：2026-10-05

---

## 一、功能特性

| 模块 | 能力 |
|---|---|
| 发现 | 自定义底部菜单（发现 / 关注 / 收藏 / 我的）；搜索框 + 热门领域卡；头像问候区 + 提醒红点 |
| 消歧 | 同名人物候选列表（带领域 chips 筛选）+「都不是 TA」兜底，产出稳定 `personKey`（形如 `雷军#tech`） |
| 报告 | 六段卡片化渲染：简介 / 近期动态 / 经典语录 / AI 点评 / 时间线 / 信息来源；骨架屏 + 逐段呈现；「生成于 xx 前 · 刷新最新」双入口 |
| 关注 | 关注列表 + 关注流聚合（`feed_cache` 归并 + 下拉刷新，每账号每日 ≤ 10 次配额） |
| 收藏 / 历史 | 名言与报告收藏（`openid#type#hash` 防重）、浏览历史（保留 50 条） |
| 我的 | 联网能力（博查 key + 大模型 key，仅存本机）、连通性自检、隐私与免责、内容举报 / 反馈、清空我的数据 |
| 合规 | 敏感名单一级拦截（命中即拒答且不发任何网络请求）、来源 URL 白名单、报告统一标注「AI 生成，仅供参考」 |

---

## 二、核心链路

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

`report_cache.state = building` 作为跨设备生成互斥锁：并发查同一人时仅一方代表生成，另一方等待读取结果。

---

## 三、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 框架 | Taro 3.6（React 18）+ TypeScript | webpack5 编译，`framework: 'react'` |
| UI | Taro UI 3.x + SCSS（750 设计稿） | 全局主题变量覆盖于 `src/styles/` |
| 状态 | zustand | `src/stores/auth.ts` 等 |
| 校验 | zod | 报告 Schema 全字段校验 |
| 时间 | dayjs | 相对时间、配额日期键 |
| 云后端 | 腾讯云 CloudBase（微信云开发） | envId `<your-env-id>`；数据库 + 云函数 |
| 搜索源 | 博查 `https://api.bochaai.com/v1/web-search` | 端上直连或经云函数代理 |
| 大模型 | OpenAI 兼容端点 | 默认 `https://api.deepseek.com/v1`，模型名见 `src/config/public.ts` |

> 依赖安装使用 `.npmrc` 中的 `legacy-peer-deps=true`；`@tarojs/plugin-platform-*` 钉在 `^3.6.25`（勿升级）、webpack 钉 `~5.91.0`。

---

## 四、目录结构

```
StartRandar/
├── celebrity-radar/                # 小程序主体（Taro 工程）
│   ├── src/
│   │   ├── pages/                  # 10 个页面
│   │   │   ├── index/              # 发现（tabBar）
│   │   │   ├── feed/               # 关注流（tabBar）
│   │   │   ├── collection/         # 收藏（tabBar）
│   │   │   ├── mine/               # 我的（tabBar）
│   │   │   ├── profile/            # 名人主页
│   │   │   ├── report/             # 报告页（核心）
│   │   │   ├── following/          # 关注列表
│   │   │   ├── history/            # 浏览历史
│   │   │   ├── records/            # 收藏/记录入口
│   │   │   └── agreement/          # 隐私与免责
│   │   ├── components/             # person-card / favorites-view / report-loading 等
│   │   ├── utils/                  # 业务与云访问层（见下表）
│   │   ├── config/                 # public.ts（公共配置）/ domains / hot / filters
│   │   ├── stores/                 # zustand store
│   │   ├── styles/                 # 主题变量、底栏图标
│   │   └── custom-tab-bar/         # 自定义底部菜单
│   ├── cloudfunctions/
│   │   ├── aiProxy/                # 平台代付密钥闸门（test / search / chat）
│   │   └── notifyFollowUpdates/    # 关注更新订阅消息（定时触发）
│   ├── config/                     # Taro 构建配置（dev / index / prod）
│   ├── cloudbaserc.json            # CloudBase 部署描述（函数 + 环境变量 + 定时器）
│   └── project.config.json         # 微信开发者工具工程（miniprogramRoot: dist/）
├── doc/                            # 设计与联调文档
│   ├── 名人雷达_设计方案.md          # 完整设计与研发方案（v1.3）
│   ├── 开发计划.md                  # MVP 阶段分解与验收门 G0~G8
│   ├── 联调手册.md                  # 人工配置清单 + 11 条验收用例
│   └── 云DB建表脚本.sql              # 8 张集合建表脚本
└── assets/                         # Figma 导出素材（图标 / 插图）
```

### 关键模块（`src/utils/`）

| 文件 | 职责 |
|---|---|
| `cloud.ts` | CloudBase 初始化、`isCloudConfigured` 判定、诊断日志 |
| `db.ts` | 自建数据访问适配层（`table('x').select/eq/or/upsert/maybeSingle`），`id ↔ _id` 双向映射、分页续取、写操作兜底 |
| `auth.ts` | 微信登录 + `users` 首次初始化（写入 `last_seen_at`） |
| `search.ts` | 博查适配器（无 key 降级），素材归一为 `NewsItem` |
| `disambiguate.ts` | LLM 同名消歧 + 领域码枚举 + 兜底 |
| `sensitive.ts` | 本地静态敏感名单（一级过滤，发版前人工维护） |
| `report.ts` | 报告生成、zod 校验、URL 白名单清洗、降级纯文本 |
| `cache.ts` | `report_cache` 读写 + `building` 互斥、`feed_cache`、`refresh_quota` 配额 |
| `llm.ts` | LLM 双通道：本机 key 直连 / 云函数 `aiProxy` 平台代付 |
| `settings.ts` | 用户级 key 本地存储（`settings:bocha_api_key`、`settings:llm_api_key`） |
| `events.ts` | 埋点写入（9 类事件） |
| `follows.ts` / `favorites.ts` / `history.ts` | 关注 / 收藏 / 历史读写 |
| `data-deletion.ts` | 「清空我的数据」（云端三类数据 + 本地凭据） |

---

## 五、快速开始

环境要求：Node 16 / 18（建议 LTS）、微信开发者工具、已开通云开发的小程序 appid。

```bash
cd celebrity-radar
npm install                 # 依赖安装（.npmrc 已开 legacy-peer-deps）

npm run dev:weapp           # 开发模式（watch，产物 dist/）
npm run build:weapp         # 生产构建，产物 dist/
npm run build:h5            # H5 端构建（调试用）
```

用微信开发者工具导入 `celebrity-radar/` 目录（`miniprogramRoot: dist/`，`cloudfunctionRoot: cloudfunctions/`）；开发期可勾选「不校验合法域名」先行联调。

---

## 六、配置说明

### 1. 端上公共配置 `src/config/public.ts`

| 字段 | 说明 |
|---|---|
| `cloudbaseEnvId` | CloudBase 环境 ID；为空则 `isCloudConfigured === false`，登录与 DB 调用不会发起 |
| `llm.baseURL` / `llm.model` | OpenAI 兼容端点与模型名（不含 `/chat/completions`） |
| `llm.apiKey` | **恒为空**。该文件会打进小程序包，填入即等同公开 |
| `subscribeTemplateId` | 订阅消息模板 ID（与云函数环境变量 `SUBSCRIBE_TEMPLATE_ID` 指向同一模板） |

### 2. 密钥归属：两条通道，都不进代码

| 通道 | 场景 | 存放位置 |
|---|---|---|
| ① 平台代付 | 用户零配置 | 云函数 `aiProxy` 环境变量：`BOCHA_API_KEY` / `DEEPSEEK_API_KEY` |
| ② 本机直连 | 开发与内测 | 本地 storage：`settings:bocha_api_key` / `settings:llm_api_key`（「我的 → 联网能力」填写，可一键测试连通性） |

有本机 key 走 ②，否则回落 ①。**严禁**把任何真实 key 写进 `src/config/public.ts` 或其它提交进 git 的文件。

### 3. 域名与后台

- request 合法域名：`https://api.bochaai.com`、`https://api.deepseek.com`（云数据库走 `wx.cloud`，不占域名）
- 后台开通「客服功能」并绑定客服人员（内容举报 / 反馈依赖 `open-type="contact"`）
- 后台配置隐私协议（收集：匿名标识 openid、本地存储）

### 4. 云函数部署

`cloudbaserc.json` 已声明函数、环境变量与定时器（`notifyFollowUpdates` 每日 09:00 触发）。部署前在运行环境注入：

```bash
# 以 CloudBase CLI 为例，环境变量由运行环境提供
BOCHA_API_KEY=...  DEEPSEEK_API_KEY=...  SUBSCRIBE_TEMPLATE_ID=...
```

> `aiProxy` 的控制台超时时间必须**大于**函数内 `LLM_CHAT_TIMEOUT_MS`（建议 60s），否则长报告生成会被平台提前掐断。

---

## 七、云数据库

8 张集合（主键列名一律 `id`），建表脚本见 `doc/云DB建表脚本.sql`：

| 集合 | 用途 | 访问权限 |
|---|---|---|
| `users` | 账号与设置（首次登录自动写入） | 仅创建者可读写 |
| `report_cache` | 报告缓存（`state: building \| ready`，全局共享、长期复用） | **所有用户可读**，写需登录 |
| `feed_cache` | 检索结果结构化映射 | **所有用户可读**，写需登录 |
| `refresh_quota` | 每日刷新配额（`id = openid#yyyy-mm-dd`） | 仅创建者可读写 |
| `follows` | 关注列表 | 仅创建者可读写 |
| `favorites` | 收藏（`id = openid#type#hash` 防重） | 仅创建者可读写 |
| `history` | 浏览历史（保留 50 条） | 仅创建者可读写 |
| `events` | 埋点 | 仅创建者可读写 |

配套人工配置与 11 条验收用例的操作步骤见 `doc/联调手册.md`。

---

## 八、安全与合规

- 密钥永不进包：端上只存本地 storage，服务端只存云函数环境变量
- 输入侧：本地敏感名单一级拦截，命中即拒答，**不发任何网络请求**
- 输出侧：报告 `sources` / `dynamics` 链接强制 URL 白名单清洗，只保留检索素材中出现的链接
- 内容口径：全链路标注「AI 生成，仅供参考」；隐私声明页 + 举报入口 + 「清空我的数据」二次确认
- 运行成本：报告缓存共享复用、每账号每日刷新 ≤ 10 次、`building` 互斥避免并发重复生成

---

## 九、文档索引

| 文档 | 内容 |
|---|---|
| `doc/名人雷达_设计方案.md` | 需求、架构、数据模型、缓存与成本模型、合规章节（v1.3） |
| `doc/开发计划.md` | MVP 阶段 1~8 分解、依赖关系、验收门 G0~G8 |
| `doc/联调手册.md` | 发版前人工配置清单、云 DB 建表与权限、11 条验收用例 |
| `doc/云DB建表脚本.sql` | CloudBase 集合建表脚本 |

---

## 十、已知事项

- 「我的 → 刷新最新」走 `report_cache` 条件更新抢占分支（`state=ready` 且过期时重新生成），该分支的云侧条件更新语义以真机实测为准；若失效表现为刷新后仍拿到旧缓存。
- `src/config/public.ts` 注释中引用的《CloudBase 迁移手册.md》未随仓库提供，迁移结论已体现在本文档第六、七节。
- 敏感名单 `src/utils/sensitive.ts` 需按最新合规要求在发版前人工补充（不由开发侧生成）。
- 主包体积硬上限 2MB，新增依赖前先核对构建产物。
