# 贡献指南

感谢你愿意为「名人雷达」出一份力。这份文档说明**怎么提**、**我们会看什么**、以及**哪些改动不会被接受** ——
目标是让一个 PR 从提交到合并尽量只来回一次。

- 中文 · [English](#english)
- 行为准则：[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- 安全问题：**不要开公开 Issue**，见 [`SECURITY.md`](./SECURITY.md)

---

## 一、可以贡献什么

| 类型 | 建议方式 | 说明 |
|---|---|---|
| Bug 报告 | Issue（模板见下） | 请附**复现步骤 + 期望结果 + 实际结果**；涉及云端时给出云函数日志片段（**先删掉 key**） |
| 新功能 / 大改动 | 先开 Issue 讨论 | 这个仓库的设计取舍都写在注释里，先对齐动机能省掉一次返工 |
| 文案与文档修正、错别字 | 直接 PR | 无需预先讨论 |
| UI / 交互调整 | PR + 真机截图 | 仓库的视觉规范在 `src/styles/variables.scss`；改动请说明取舍 |
| 依赖升级 | 单独 PR | 必须说明升级原因与验证方式（见下方「依赖与体积」） |

**不建议一上来就做的改动**：重构目录结构、替换框架或状态库、格式化整个仓库、批量改注释。
这类 PR 的 diff 无法评审，通常会被关闭。

---

## 二、开发环境

前置：**Node 16 / 18**（LTS）、**微信开发者工具**、一个开通了云开发的小程序 appid。

```bash
git clone https://gitee.com/qianlonglove_admin/celebrity-radar.git
cd celebrity-radar/celebrity-radar

cp src/config/local.example.ts src/config/local.ts   # 必做，否则编译报 Cannot find module './local'
npm install                                          # .npmrc 已开启 legacy-peer-deps

npm run dev:weapp      # 开发模式（watch，产物 dist/）
npm run build:weapp    # 生产构建
npm test               # 本地单测（688 条，不连云、不需要 Key）
```

用微信开发者工具导入 `celebrity-radar/` 目录。**只想改端上逻辑时，不需要任何云端配置** ——
单测与构建都能离线跑通；只有要真机验证生成链路，才需要按 README 的「[配置说明](./README.md#配置说明)」
与「[部署](./README.md#部署)」两节配云端。

> 提交前请确认 `src/config/local.ts` 未被纳入提交：真实环境 ID 不进版本库（`.gitignore` 已覆盖）。

---

## 三、分支与提交信息

- 默认分支是 **`master`**；从它拉出特性分支，命名 `feat/xxx`、`fix/xxx`、`docs/xxx`、`chore/xxx`
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
  `feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `test:` / `chore:`
- 一个提交只做一件事。把「顺手格式化」和「功能改动」混在一个提交里，评审时无法确认哪一行是真的改动
- 历史提交是中文的，保持一致即可

---

## 四、提交前请确认（6 条）

1. `npm test` 全绿（当前 **688 / 688**）
2. `npx tsc --noEmit` 无新增告警
3. 主包体积仍在硬上限 2MB 内（当前约 1.3MB）—— 新增依赖前先看构建产物
4. `src/config/local.ts` 与 `debug` 开关**不要**提交
5. 改动涉及数据模型时，同步更新 `cloudfunctions/dbInit/schema.js`（库结构的单一事实源）
6. 改了权益 / 价格（`src/config/benefits.ts`）时，跑过 `npm run config:sync` 并重新部署受影响的云函数

---

## 五、评审看什么

评审时我们优先关注这几点，请在 PR 描述里主动说明：

- **动机**：为什么需要这个改动？有没有更小的做法？
- **验证方式**：怎么证明它有效？（单测用例名、真机截图、云函数返回体）
- **边界**：失败时会怎样？降级路径是什么？（本项目的惯例是「可用性优先，但要说清为什么」)
- **注释**：`src/utils/**` 与 `cloudfunctions/**` 的注释写**为什么这么选**，而不是复述代码在做什么。
  这是本仓库的主要阅读材料，请延续这个风格。
- **手工同步的两处**：改了一处必须同时改另一处，否则线上表现会和本地不一致：

  | 手工同步对 | 位置 A | 位置 B |
  |---|---|---|
  | 供应商 / 档位表 | `src/config/public.ts` 的 `llm.providers` | `cloudfunctions/aiProxy/llm.config.js` 与 `cloudfunctions/hotBoardRefresh/llm.config.js`（两份逐字相同） |
  | 会员专属档位（计费闸门） | 端上各家的 `memberOnly` | `llm.config.js` 的 `memberOnlyModels` |

  改了库结构只改 `schema.js` 是不够的：集合权限与索引要在**控制台手工**配置（见 README「[部署](./README.md#部署)」第 3 步），
  而这部分不在版本库里 —— PR 描述里请写清「部署者需要去控制台做什么」。

- **文档同步**：行为或配置变更请同时更新 `README.md` 与 `README.en.md`，并补一条 [`CHANGELOG.md`](./CHANGELOG.md)。
  仓库的 `doc/` 是作者本地文档（已被 `.gitignore` 排除、不随仓库分发），请勿在其中新增对外的说明

---

## 六、依赖与体积

- 前端依赖使用 `.npmrc` 里的 `legacy-peer-deps=true`；**不要**改成默认行为
- `@tarojs/plugin-platform-*` 钉在 `^3.6.25`（勿升级），webpack 钉在 `~5.91.0` —— 升级这两个已验证会破坏构建
- 云函数业务逻辑**只依赖 Node 内置模块**，`wx-server-sdk` 由云开发平台注入。给云函数加第三方依赖会让部署包变大且更难审计，请先说明必要性
- 小程序主包硬上限 2MB，任何新依赖都要在 PR 里给出体积变化

---

## 七、我们不接受的改动

- 提交**真实密钥、环境 ID、商户号**或任何可用凭据（包括截图与日志里的）
- 绕过配额、会员闸门或冷却机制的「破解」（这些机制在云端，端上改了也无效）
- 来源不明的素材、字体、图标与第三方代码
- 与项目定位无关的大规模改动（换框架、换 UI 库、整仓格式化）
- 删除或注释掉既有测试来让 CI/本地通过

---

## 八、Issue 里请带上

```text
环境：微信开发者工具 x.x / 基础库 x.x / 机型（真机问题必填）
现象：期望什么，实际发生了什么
复现：最小步骤（哪一页 → 哪个按钮 → 什么输入）
日志：控制台或云函数日志片段（务必先删掉 key / openid / 环境 ID）
补充：是否为缓存命中路径、是否登录、是否为会员态
```

**请勿**在 Issue 中粘贴完整报告 JSON（可能含第三方内容）或任何密钥。

---

## English

Contributions are welcome. The essentials:

1. **Issues** — bug reports need steps to reproduce, expected vs. actual behavior, and a log excerpt with
   **all keys, openids and environment IDs removed**. For non-trivial features, open an Issue first; the design
   rationale lives in code comments and alignment up front saves a round trip.
2. **Setup** — Node 16/18, clone, `cp src/config/local.example.ts src/config/local.ts`, `npm install`.
   `npm run build:weapp` and `npm test` both work fully offline; cloud configuration is only needed for
   on-device verification of the generation flow.
3. **Branches & commits** — branch off **`master`** (`feat/`, `fix/`, `docs/`, `chore/`), follow
   [Conventional Commits](https://www.conventionalcommits.org/), one concern per commit.
4. **Before submitting** — `npm test` green (688/688), no new `tsc --noEmit` warnings, main package still
   under 2MB, `src/config/local.ts` and the `debug` flags not committed, `dbInit/schema.js` updated with schema changes.
5. **Review focus** — motivation, verification evidence, failure/degradation behavior, and comments that explain
   *why* (that is this repo's main reading material). Note the two hand-synced pairs: the provider/tier tables
   (`src/config/public.ts` ↔ both `llm.config.js` copies) and the member-only gate
   (`memberOnly` ↔ `memberOnlyModels`).
6. **Not accepted** — real credentials, cracks that bypass quota or membership gates, material of unknown origin,
   unrelated large-scale rewrites, or disabling existing tests.

By participating you agree to the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
For security issues, follow [`SECURITY.md`](./SECURITY.md) instead of opening a public Issue.
