# Celebrity Radar

**English** · [简体中文](./README.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Taro](https://img.shields.io/badge/Taro-3.6-07c160.svg)](https://taro-docs.jd.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-522%20passing-success.svg)](#development--testing)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> A **celebrity intelligence mini program** for the WeChat ecosystem: type any public figure's name → the app searches recent public coverage online → an LLM turns it into a structured report (bio / profile / activity / quotes / commentary / controversies & responses / timeline / glossary…), with a keyword cloud, sentiment trend and heat curve aggregated on the client.

- Stack: Taro 3 (React) + Taro UI ｜ Backend: Tencent CloudBase (WeChat Cloud Development)
- License: [Apache-2.0](./LICENSE) ｜ Changelog: [`CHANGELOG.md`](./CHANGELOG.md)
- Repository: [gitee.com/qianlonglove_admin/celebrity-radar](https://gitee.com/qianlonglove_admin/celebrity-radar) ｜ 中文说明: [`README.md`](./README.md)

---

## Table of Contents

- [What This Project Is](#what-this-project-is)
- [Features](#features)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [Architecture & Core Flow](#architecture--core-flow)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Project Structure](#project-structure)
- [Core Modules](#core-modules)
- [Security & Compliance](#security--compliance)
- [Development & Testing](#development--testing)
- [FAQ](#faq)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [Feedback & Support](#feedback--support)
- [Version & Changelog](#version--changelog)
- [License & Credits](#license--credits)

---

## What This Project Is

A complete, compilable WeChat mini program: 19 pages on the client, 10 cloud functions and 18 database collections on the server,
covering the full chain of *search → disambiguation → retrieval → generation → caching → follow / favorite / share / Q&A / compare*.

It is built around two principles:

1. **Usable without paying** — cached reports can be viewed unlimited times; following, favorites, history and the hot board are all free, with no paywall.
2. **No wasted upstream spend** — reports are a **globally shared cache** (one generation per person, reused by every user), a `building` flag acts as a cross-device generation mutex,
   cooldowns only block failures *worth waiting for*, and quota counting lives on the server. Together these keep upstream cost predictable.

> ⚠️ **This is complete source code, not a turnkey product.**
> The repository contains **no usable credentials**: the appid, the CloudBase environment ID and all upstream API keys are placeholders you must supply yourself.

---

## Features

### Content

- **Discovery & disambiguation** — Search box + popular-domain cards; candidate list for homonyms (with domain filters) plus a "none of them" fallback, producing a stable `personKey` (e.g. `雷军#tech`)
- **Report generation** — Bocha web search → LLM produces structured JSON → zod validation of every field + source-URL allowlist sanitization; **rendered card by card** (bio / profile / relationship map / recent activity / notable quotes / AI commentary / controversies & responses / timeline / what to watch / glossary + a one-line source summary), skeleton loading with progressive reveal, and a "generated N ago / refresh" pair of entry points; every factual section must cite a real piece of material — anything unsourced is dropped entirely, and a section that is genuinely empty still renders a card explaining why
- **Client-side aggregates** — Profile snapshot, stance & sentiment, keyword cloud, quote themes, and a heat-trend curve — **computed entirely on the client**, so existing cached reports benefit immediately with zero extra model calls or quota usage
- **Quote sourcing** — Verifies only *verifiable* facts (is this quote's source link part of the retrieved material; does that article contain the same wording) — it does **not** render AI verdicts on authenticity

### Reading & saving

- **Following** — Follow list + change overview (who has news) + merged feed (`feed_cache` merged with pull-to-refresh, capped at 10 refreshes per account per day)
- **Weekly digest** — One tap summarizes the last 7 days across followed figures → per-person highlights + weekly overview + topic words; material comes from cache and **people and items follow the material**, cached locally per ISO week
- **Favorites / History** — Four favorite types (quotes / reports / activity / timeline, deduplicated by an `openid#type#hash` key) + browsing history (last 50 entries); quotes in Favorites can be rendered as a shareable card
- **Message center** — A single timeline: follow updates / weekly reminders / announcements / keyword alerts; read state is tracked **per item** and stored on-device only (no new collection, cloud function or model call)
- **Sharing** — Quote cards (rendered on-device with Canvas 2D, never uploaded to cloud storage) + native forwarding; every landing page is a specific person's report

### Exploration

- **Hot board** — Produced daily by AI (`hot_board`) with a three-level fallback (AI board → cached reports → static list); **every rank is visible to everyone**, never gated
- **Keyword alerts** — Subscribe to keywords → a scheduled cloud function searches them daily → the app lists items *added since you last looked* and pushes a subscription message
- **Person risk monitoring** — Tap "+ Monitor risk" on a report to watch a person → a scheduled cloud function searches them daily → matches on legal / tax / partnership / rights / statement terms are collected in the alerts page and pushed (**states only the match and its source; no rating, no prediction**)
- **Topic knowledge base** — Pivots the person-centric report cache into a topic-centric view: for one topic, who is talking about it, what was said, which articles exist and when it was discussed
- **Compare** — Side-by-side comparison of two figures (reusing both cached reports, zero model calls), with one-tap follow / share
- **AI Q&A** — Answers grounded in the figure's **cached report**, flattened into numbered passages (ordered by reliability, selected by Chinese bigram overlap); each question triggers one extra web search that shares the same budget, and falls back silently to "report-only" answers when search is unavailable

### Membership (freemium)

- **Quota** — Free tier: 3 on-demand generations per day, 30 for members (cache hits never count); AI Q&A: 5 questions free, 30 for members; quota is displayed transparently on the profile page
- **Quality perks** — **User-selectable model provider** (DeepSeek / Qwen / Zhipu GLM / Moonshot — keys all live in the cloud function, so users configure nothing) + model tier (free tier is locked to the fast model; members unlock standard / deep reasoning; switching provider swaps the whole tier list while the tier you picked stays the same) plus a **deep report mode** (thicker retrieval plus three member-only sections: comparison angles, risk notes, source disagreements)
- **Pricing** — ¥9.9 monthly / ¥25 quarterly / ¥68 yearly; the price has **a single source of truth** (the `PLANS` map in the `payCreate` cloud function, fetched by the client, so changing prices needs no release)

### Platform

- **Compliance** — A local sensitive-name list blocks requests up front (rejected without **any** network call), source URLs are allowlisted, and every report notes "AI-generated, for reference only"
- **Zero client-side secrets** — All upstream calls are proxied by cloud functions; quota counting is server-side (atomic increments with server dates); membership gating is enforced in the cloud and cannot be bypassed by a repackaged client

---

## Screenshots

#### Discovery & search

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/01-home.png" width="165" alt="Home"><br><sub><b>Home</b> · search entry / featured domains / today's hot</sub></td>
    <td align="center"><img src="./assets/screenshots/02-search.png" width="165" alt="Search and disambiguation"><br><sub><b>Search &amp; disambiguation</b> · same-name candidates + domain filters</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/03-hot-board.png" width="165" alt="Hot board"><br><sub><b>Hot board</b> · AI-generated daily, every rank visible to everyone</sub></td>
  </tr>
</table>

#### Following & messages

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/04-feed.png" width="165" alt="Following feed"><br><sub><b>Following feed</b> · merged stream + pull to refresh</sub></td>
    <td align="center"><img src="./assets/screenshots/05-following.png" width="165" alt="Follow list"><br><sub><b>Follow list</b> · change overview: who has news</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/07-message-center.png" width="165" alt="Message center"><br><sub><b>Message center</b> · updates / weekly digest / alerts in one timeline</sub></td>
  </tr>
</table>

#### Explore & Q&amp;A

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/06-keyword-alert.png" width="165" alt="Keyword alerts"><br><sub><b>Keyword alerts</b> · only entries added since your last visit</sub></td>
    <td align="center"><img src="./assets/screenshots/08-qa.png" width="165" alt="AI Q&amp;A"><br><sub><b>AI Q&amp;A</b> · answers from your cached reports, with numbered sources</sub></td>
  </tr>
</table>

#### Deep report

Rendered card by card (bio / profile / relationship map / recent activity / notable quotes / AI commentary / controversies &amp; responses / timeline / what to watch / glossary); every factual section must cite a real piece of material

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/bg1.PNG" width="165" alt="Report page screenshot 1"><br><sub><b>Report page 1 / 7</b></sub></td>
    <td align="center"><img src="./assets/screenshots/bg2.PNG" width="165" alt="Report page screenshot 2"><br><sub><b>Report page 2 / 7</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/bg3.PNG" width="165" alt="Report page screenshot 3"><br><sub><b>Report page 3 / 7</b></sub></td>
    <td align="center"><img src="./assets/screenshots/bg4.PNG" width="165" alt="Report page screenshot 4"><br><sub><b>Report page 4 / 7</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/bg5.PNG" width="165" alt="Report page screenshot 5"><br><sub><b>Report page 5 / 7</b></sub></td>
    <td align="center"><img src="./assets/screenshots/bg6.PNG" width="165" alt="Report page screenshot 6"><br><sub><b>Report page 6 / 7</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/bg7.PNG" width="165" alt="Report page screenshot 7"><br><sub><b>Report page 7 / 7</b></sub></td>
  </tr>
</table>

#### Compare

Reuses both cached reports, zero model calls, one-tap follow / share.

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/db1.PNG" width="165" alt="Compare page screenshot 1"><br><sub><b>Compare page 1 / 3</b></sub></td>
    <td align="center"><img src="./assets/screenshots/db2.PNG" width="165" alt="Compare page screenshot 2"><br><sub><b>Compare page 2 / 3</b></sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/db3.PNG" width="165" alt="Compare page screenshot 3"><br><sub><b>Compare page 3 / 3</b></sub></td>
  </tr>
</table>

#### Membership &amp; configuration

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/09-mine.png" width="165" alt="Profile"><br><sub><b>Profile</b> · quota shown transparently / membership perks</sub></td>
    <td align="center"><img src="./assets/screenshots/10-providers.png" width="165" alt="Model providers"><br><sub><b>Model provider of your choice</b> · DeepSeek / Qwen / Zhipu GLM / Moonshot</sub></td>
  </tr>
</table>

---

## Tech Stack

- **Framework** — Taro 3.6 (React 18) + TypeScript: compiled with webpack5
- **UI** — Taro UI 3.x + SCSS (750px design width): theme variables in `src/styles/`
- **State** — zustand: e.g. `src/stores/auth.ts`
- **Validation** — zod: full-field validation of the report schema
- **Dates** — dayjs: relative time, ISO weeks, quota date keys
- **Backend** — Tencent CloudBase (WeChat Cloud Development): database + cloud functions; environment ID comes from local config
- **Search** — Bocha `api.bochaai.com`: proxied by the `aiProxy` cloud function
- **LLM** — **any of four OpenAI-compatible providers**: DeepSeek / Qwen (DashScope compatible mode) / Zhipu GLM / Moonshot Kimi; defaults to `https://api.deepseek.com/v1`; selectable providers and their three tiers are in `src/config/public.ts`, while endpoints / key variable names / member tiers are in `cloudfunctions/aiProxy/llm.config.js`

Dependencies are installed with `legacy-peer-deps=true` from `.npmrc`; `@tarojs/plugin-platform-*` is pinned to `^3.6.25` (do not upgrade) and webpack to `~5.91.0`.

---

## Architecture & Core Flow

```
User enters a name
  → local sensitive-name check (rejected without any request)
  → LLM disambiguation → candidate selection → personKey
  → report_cache hit? ──yes→ render directly (no generation triggered)
       │no
       └→ Bocha web search (api.bochaai.com) → source material
          → LLM produces structured JSON (any of the four providers, proxied by aiProxy) → zod validation + URL allowlist
          → write to report_cache → render report
```

Layering:

```
pages / components        UI layer
     ↓
src/utils/**              business logic & cloud access (the only entry point pages use)
     ↓
utils/db.ts               hand-rolled data-access adapter (id ↔ _id mapping, pagination, write fallbacks)
utils/cloud.ts            CloudBase initialization & diagnostics
     ↓
cloudfunctions/**         10 cloud functions (secrets, quota, moderation, scheduled jobs, payments)
     ↓
Upstream: Bocha search / LLM (any of four providers) / WeChat Pay / security.msgSecCheck
```

Two mechanisms worth knowing:

- **`report_cache.state = building` acts as a cross-device generation mutex**: when two clients request the same person concurrently, only one performs the generation while the other waits for the result.
- **A cache hit always wins over cooldown and quota**: hits render immediately without consuming quota or being blocked by cooldowns.

---

## Getting Started

### What you must supply

Environment: Node 16 / 18 (LTS recommended), WeChat DevTools, and a mini program appid with Cloud Development enabled.

- **Mini program appid + entity qualifications** — required by WeChat; without it, no on-device preview and no publishing
- **CloudBase environment (Tencent Cloud)** — hosts the database and all 10 cloud functions; without it, login and **all** database calls are never issued and the profile page shows "cloud service not configured"
- **An LLM API key (at least `DEEPSEEK_API_KEY`)** — generates reports (via the `aiProxy` cloud function). Users may switch provider under "Profile", so **every provider you list needs its key** (`QWEN_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`); without it, switching to that provider fails with "no quota configured". Without any key, generation fails; browsing and favoriting cached reports still works
- **Bocha API key** — retrieves source material online; without it retrieval is empty, so reports lack material and the timeline is incomplete
- **ICP filing / service category** — launch review; affects publishing only, not local debugging

### Install & Run

```bash
git clone https://gitee.com/qianlonglove_admin/celebrity-radar.git
cd celebrity-radar/celebrity-radar

cp src/config/local.example.ts          src/config/local.ts                  # 1. client-local config (required)
cp project.private.config.example.json  project.private.config.json          # 2. DevTools private config
cp .env.example                         .env                                 # 3. deploy-time secrets
npm install                                                                  # legacy-peer-deps is enabled in .npmrc

npm run dev:weapp      # development (watch, output in dist/)
npm run build:weapp    # production build, output in dist/
npm run build:h5       # H5 build (for debugging)
```

Open the `celebrity-radar/` directory in WeChat DevTools (`miniprogramRoot: dist/`, `cloudfunctionRoot: cloudfunctions/`).
During development you can enable "do not verify valid domains" to iterate before the domains are approved.

### The three local config files

None of the three is committed (all are in `.gitignore`), so your edits never pollute the working tree or a PR.

- **`src/config/local.ts`** — your own real values: CloudBase environment ID, subscription template IDs, the webview domain allowlist, the local debug switch. **Required**: `src/config/public.ts` imports it directly and the build fails with `Cannot find module './local'`
- **`project.private.config.json`** — your private WeChat DevTools project settings (your appid and tool preferences). Without it you re-enter the appid and settings in DevTools every time
- **`.env`** — deploy-time secrets for cloud functions (`DEEPSEEK_API_KEY` / `BOCHA_API_KEY` …), referenced from `cloudbaserc.json` as `${env.XXX}`. Without it, deployed functions have no upstream keys, so retrieval and generation fail

---

## Configuration

### 1. Client config: `public.ts` (shipped) + `local.ts` (local only)

- **`src/config/public.ts`** (committed) — deployment-independent settings: the selectable **provider** list with each provider's three tiers, plus `memberOnly` flags. **Never put any key here** (keys live in cloud function environment variables; switching provider only changes request parameters)
- **`src/config/local.example.ts`** (committed) — template for local config, all values are placeholders
- **`src/config/local.ts`** (not committed, in `.gitignore`) — your own real values: environment ID, subscription template IDs, webview domain allowlist, local debug switch

`local.ts` (created by copying `local.example.ts` after cloning):

- **`cloudbaseEnvId`** — CloudBase environment ID. While it stays at the placeholder, the cloud service counts as unconfigured and no login or DB call is issued
- **`subscribeTemplateId`** — Template ID for follow-update subscription messages; must match the `SUBSCRIBE_TEMPLATE_ID` environment variable of the cloud functions
- **`alertTemplateId`** — Template ID for keyword alerts; **it must differ from the one above**: WeChat one-time subscription grants are consumed **per template**, so sharing one template between two scheduled jobs means the first job consumes the grant and the second always fails with 43101
- **`riskTemplateId`** — Template ID for person risk monitoring; **also must differ from both above** (grants are consumed per template). Leave it empty and the feature still works — it just sends no push, while risk signals remain visible in the alerts page
- **`webviewDomains`** — Allowlist of domains the "original article preview" page may embed; leave empty to always fall back to a preview card plus a copy-link action
- **`debug`** — Local debug switch (opens quota gates and upstream cooldowns). **All flags default to safe values** (five `false` plus `memberOverride: 'off'`), change them only for local integration work
- **`debug.memberOverride`** — Forces a membership identity so the paid features can be self-tested: `'off'` (default) keeps the real server-side grant, `'free'` forces the free tier, `'monthly'` / `'quarterly'` / `'annual'` force that tier.
  ⚠ It only overrides the **client-side** verdict (`utils/member.ts#readMemberState`, outermost layer) and is **never recognised by the cloud**: with a forced membership, `aiProxy` still clamps retrieval counts by the real identity and `quotaGuard` still re-checks the waiver — so "thicker retrieval" and "member-tier models" cannot be tested this way; to see the real output, add a row to the authoritative `memberships` collection (`_id` = your openid) in the cloud. Also: do **not** test payments while a membership is forced (`utils/pay.ts` confirms the grant by `expires_at` moving later, which the override keeps constant)

`public.ts`:

- **`llm.providers`** — Selectable **providers** (currently four: DeepSeek / Qwen / Zhipu GLM / Moonshot Kimi): each has an `id` (must match a `PROVIDERS` key in the cloud function's `llm.config.js`), a display name, and `models` (the same three tiers everywhere: `fast` / `standard` / `reason` = Turbo / Standard / Deep Reasoning). **List only the providers whose keys you configured in the cloud** — whichever one a user picks, the cloud function pays with that provider's key and the client holds no credentials
- **`llm.provider` / `llm.model` / `llm.models`** — Default provider, its default model, and its tier list (the latter two equal `providers[0]`'s fast tier and `providers[0].models`). Tier labels are identical across providers, so membership copy can be derived from them — adding a provider changes no wording
- **`models[].memberOnly`** — `true` = members only: free users fall back to that provider's Turbo tier even if they picked it locally. **Changing this flag requires updating `memberOnlyModels` for the matching provider in the `aiProxy` cloud function's `llm.config.js`** — that copy is the real billing gate (the client copy can be bypassed by repackaging)

> A user's provider / tier choice lives in local storage only (`settings:llm_provider` + `settings:llm_tier`).
> What is stored is the **tier id**, not the model name, so switching provider keeps "the tier I picked"
> (DeepSeek Standard → Qwen Standard) without asking the user to choose again; the tier list itself is
> replaced wholesale by the new provider's three tiers — that is what "switching provider switches the tier parameters" means.

> They are split so that a real environment ID in the repository does not make forks connect to the original author's cloud environment,
> and so that the author's local `debug: true` edits in `public.ts` cannot be committed by accident.

### 2. Secret ownership: server-side only, zero client secrets

- **`BOCHA_API_KEY` + each provider's key (`DEEPSEEK_API_KEY` / `QWEN_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`)** — environment variables of the `aiProxy` / `hotBoardRefresh` cloud functions (read from `.env` at deploy time). **Every provider listed in the client config must have one**. ❌ not in the bundle
- **`SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID`** — environment variables of the three scheduled functions (**three different templates**, or they consume each other's one-time grants). ❌ not in the bundle
- **`WX_APPSECRET`** — `dbInit` only (to exchange an access_token for index updates). ❌ not in the bundle
- **`DB_ADMIN_TOKEN`** — `dbInit` only (custom token, the gate for write actions). ❌ not in the bundle
- **`AI_PROXY_TEST_TOKEN`** — `aiProxy` only (token for the paid `test` probe; **unset means that action is always rejected**, which is the intended default). It is an ops token rather than a deployment item, so normally you add it in the console only while troubleshooting. ❌ not in the bundle
- **`WX_PAY_SUB_MCH_ID` / `PAY_CALLBACK_ENV_ID`** — `payCreate`. ❌ not in the bundle
- **`PAY_ADMIN_TOKEN`** — `payCallback` only (token for the refund / manual-reconcile ops write port; **unset means the write port is always rejected**). ❌ not in the bundle
- **`PAY_CALLBACK_GUARD`** — optional `payCallback` variable, the rollout switch: `log` (default, client calls are only logged) / `strict` (client calls rejected) / `off` (no check). Switch to `strict` once real-device logs confirm the callback shape. ❌ not in the bundle
- **Deploy-time secret source (the `.env` file itself)** — `celebrity-radar/.env` (copied from `.env.example`, **not committed**), referenced from `cloudbaserc.json` as `${env.XXX}`. ❌ not in the bundle
- **Environment ID / subscription template IDs** — `src/config/local.ts`. ✅ in the bundle (**they are not secrets**)

Every request is proxied through a cloud function; the client holds no keys and users need no setup. An older build-your-own-key (BYOK) direct mode was **removed entirely**.

`src/config/local.ts` *is* bundled, so only put "not a secret, but machine-specific" values there.

### 3. Model providers and API keys (four, pick any)

The "Profile → Model provider" screen lets users pick which provider to use, **with the platform paying for the keys inside the cloud function** — users configure nothing. Four providers are exposed to the client (in the order shown in the app):

- **DeepSeek** (id `deepseek`) — key variable `DEEPSEEK_API_KEY`; endpoint `https://api.deepseek.com/v1`; tiers `deepseek-v4-flash` (free) / `deepseek-v4`, `deepseek-reasoner` (members)
- **Qwen** (id `qwen`) — key variable `QWEN_API_KEY`; endpoint `https://dashscope.aliyuncs.com/compatible-mode/v1` (DashScope compatible mode); tiers `qwen-turbo` / `qwen-plus` / `qwen-max`
- **Zhipu GLM** (id `zhipu`) — key variable `ZHIPU_API_KEY`; endpoint `https://open.bigmodel.cn/api/paas/v4`; tiers `glm-4-flash` / `glm-4-air` / `glm-4-plus`
- **Moonshot Kimi** (id `moonshot`) — key variable `MOONSHOT_API_KEY`; endpoint `https://api.moonshot.cn/v1`; tiers `moonshot-v1-8k` / `moonshot-v1-32k` / `moonshot-v1-128k`

Setup:

1. Put all four keys into `celebrity-radar/.env` (copied from `.env.example`) — **the variable names must match the list above**.
2. Make sure `aiProxy` and `hotBoardRefresh` in `cloudbaserc.json` carry those four variables under `envVariables` (the repository already does; if you upload via the DevTools context menu instead of `tcb fn deploy`, add them by hand in the CloudBase console).
3. Deploy both functions (`tcb fn deploy aiProxy && tcb fn deploy hotBoardRefresh`).
4. Verify on a real device: switch to each provider under "Profile → Model provider" and generate once — a report means that key works.

Rules worth knowing:

- **Every provider left in the client list needs its own key.** Listing four and filling in one gives users three options that are bound to fail (they see "the platform has no quota configured for this model (cloud function env `QWEN_API_KEY`)").
- **To stop offering a provider**, remove it from `llm.providers` in `src/config/public.ts` (the membership copy follows automatically) — do **not** leave the entry and skip its key.
- **`LLM_PROVIDER` is only a cloud-side fallback**, not the "which provider" switch. It applies when the client sends no provider, or an id that is not in the registry (old build / repackaged client). The `hotBoardRefresh` cron has no client preference and therefore uses it — DeepSeek by default.
- **Changing member tiers means editing two places**: `memberOnly` in the client `public.ts` (UI and request value) and `memberOnlyModels` in the cloud `llm.config.js` (**the billing gate**). Client-only edits can be bypassed by repackaging.
- **`OPENAI_API_KEY` is unused by default**: `llm.config.js` has an OpenAI entry, but cloud functions in mainland China cannot reach the official endpoint, and the client list deliberately omits it.
- **Self-hosted gateway / relay**: add `LLM_BASE_URL` + `LLM_MODEL` + `LLM_API_KEY` to `aiProxy` to override the whole registry (no need to touch `LLM_PROVIDER`). ⚠ `LLM_MODEL` is a **global override** that pins every user to one model (the client still shows the tier they picked), so treat it as a debugging / relay switch, not a permanent setting.
- **Adding a provider for good**: ① add an entry to `llm.providers` in the client `public.ts`; ② add a matching block to **both** copies of `llm.config.js` (`aiProxy` and `hotBoardRefresh` — they must stay word-for-word identical, because each WeChat cloud function is packaged separately and a cross-directory `require` breaks after deploy); ③ add that provider's key variable to `.env` and `cloudbaserc.json`; ④ keep the member-tier gates aligned in both places.

---

## Deployment

The order matters: without collections and permissions in place first, reads and writes inside functions fail silently. Membership payments, subscriptions and the three scheduled jobs are all **optional** — get the "type a name → generate a report" path working first, then come back for them.

### 1. Enable Cloud Development and set the environment ID

1. Import the `celebrity-radar/` directory in WeChat DevTools (`miniprogramRoot: dist/`, `cloudfunctionRoot: cloudfunctions/`); it will ask for an appid — use your own (or edit `project.config.json`).
2. "Cloud Development" in the toolbar → create an environment, and note the **environment ID** (e.g. `celebrity-radar-1a2b3c4d`).
3. Put the environment ID in two places:

| Location | Field | Who reads it |
|---|---|---|
| `src/config/local.ts` | `cloudbaseEnvId` | The client's `wx.cloud.init` |
| `.env` | `TCB_ENV_ID` | `cloudbaserc.json`'s `envId`, i.e. CloudBase CLI deployments |

If your CloudBase CLI version does not resolve that variable, write the environment ID literally into `envId` at the top of `cloudbaserc.json`.

### 2. Deploy cloud functions (10)

Fill in the **Bocha key plus all four LLM keys** in `.env`: skip one and users who switch to that provider see "no quota configured":

```
BOCHA_API_KEY=...
DEEPSEEK_API_KEY=...
QWEN_API_KEY=...
ZHIPU_API_KEY=...
MOONSHOT_API_KEY=...
```

**Which providers users can see is decided by `llm.providers` in `src/config/public.ts`** (four today). To offer only some of them, delete entries from that client list instead of skipping keys — see [Configuration](#configuration) §3.

```bash
npm i -g @cloudbase/cli     # once
tcb login                   # once
cd celebrity-radar/celebrity-radar
tcb fn deploy aiProxy       -e <your-env-id>
```

`cloudbaserc.json` already declares the functions, environment variables and timers, so deploy each one with `tcb fn deploy <name>`.

- **`aiProxy`** — platform-paid upstream keys (`search` / `chat`) + **server-side gates** (membership read from `memberships`; daily caps from `quota.config.js`; anti-abuse counter incremented in place in `ai_calls`; thicker retrieval gated by `count`) + a chat output cap applied to **every** request (see `chatMaxTokens`); **the provider comes from the client request** (user-selectable), the cloud only falls back. Trigger: client call; environment variables: `BOCHA_API_KEY` `LLM_PROVIDER` + all four providers' keys (`DEEPSEEK_API_KEY` `QWEN_API_KEY` `ZHIPU_API_KEY` `MOONSHOT_API_KEY`) + `OPENAI_API_KEY` (unused by default) + `AI_PROXY_TEST_TOKEN` (optional: token for the `test` probe — **unset means that action is always rejected**)
- **`quotaGuard`** — authoritative quota counting (atomic increments with server dates): `refresh` / `generate` / `ask`. Trigger: client call; environment variables: —
- **`contentCheck`** — content moderation via `security.msgSecCheck`, applied to AI questions. Trigger: client call; environment variables: —
- **`hotBoardRefresh`** — builds the daily hot board (writes `hot_board`). Trigger: cron 06:30; environment variables: `BOCHA_API_KEY` `LLM_PROVIDER` + all four providers' keys (a cron job has no client preference, so it takes `LLM_PROVIDER`, DeepSeek by default — **that provider must therefore have a key**)
- **`notifyFollowUpdates`** — pushes follow-update subscription messages. Trigger: cron 09:00 (**client calls rejected**); environment variables: `BOCHA_API_KEY` `SUBSCRIBE_TEMPLATE_ID`
- **`keywordAlert`** — keyword alerting (searches subscribed keywords, writes `keywords`). Trigger: cron 09:20 (**client calls rejected**); environment variables: `BOCHA_API_KEY` `ALERT_TEMPLATE_ID`
- **`riskWatch`** — person risk monitoring (searches per monitored person, writes `risk_signals` and pushes). Trigger: cron 09:40 (**client calls rejected**); environment variables: `BOCHA_API_KEY` `RISK_TEMPLATE_ID`
- **`payCreate`** — membership order creation (server-side pricing + cloud pay unified order). Trigger: client call; environment variables: `WX_PAY_SUB_MCH_ID` `PAY_CALLBACK_ENV_ID`
- **`payCallback`** — the payment pipeline's **only backend**: payment notification (amount verification + idempotent renewal) + **after-sales** (refund ops write port `adminOp:'refund'` / manual reconcile `adminOp:'reconcile'`). Trigger: WeChat Pay callback (**client calls gated**, see below) + the `payReconcile` cron (minute 15 of every hour); environment variables: `PAY_ADMIN_TOKEN` (write-port token; unset means the port is always rejected) + `PAY_CALLBACK_GUARD` (optional rollout switch)
- **`dbInit`** — ops tool: create collections, compare fields, create/update indexes (never called by the client). Trigger: manual; environment variables: `DB_ADMIN_TOKEN` `WX_APPID` `WX_APPSECRET`

Common pitfalls:

- **Whether config ships with a deployment depends on how you deploy**: `tcb fn deploy` (CloudBase CLI) reads the root `cloudbaserc.json` and applies environment variables, timeouts and triggers; uploading with "Upload and Deploy" in WeChat DevTools **uploads code only**, so you must set environment variables, timeouts and triggers in the console yourself.
- `aiProxy`, `hotBoardRefresh` and `notifyFollowUpdates` must have a **60-second timeout** (`aiProxy` additionally requires the smaller `LLM_CHAT_TIMEOUT_MS = 50000`), otherwise long reports, the hot board's "6 searches + 1 generation" round, and up to 20 searches per push round are cut off early by the platform (`-504003` on the client).
- `dbInit` is an **ops tool, not a runtime dependency**: start with `{ "action": "report" }` for a read-only audit; write actions require `DB_ADMIN_TOKEN` (otherwise they are rejected); delete the function when you are done (see step 3).
- `contentCheck` needs no environment variables (it uses cloud calls with platform-managed credentials); the only requirement is that `permissions.openapi` in `cloudfunctions/contentCheck/config.json` **takes effect on upload**. Without that declaration the client **fails open**. ⚠ It cannot be verified with the console's "cloud test" (which requires a real `openid`) — test it in the Q&A page on a real device.
- **The client cannot trigger scheduled jobs or payment callbacks (caller gate)**: once deployed, any cloud function can be reached from the client via `wx.cloud.callFunction`, yet the four scheduled push functions (`notifyFollowUpdates` / `keywordAlert` / `riskWatch`) and `payCallback` should never be called from the client. The test is `getWXContext().OPENID` (present for client calls, absent for timers / WeChat callbacks / the console's "cloud test"). The first three **reject client calls outright**; `hotBoardRefresh` keeps the client's `action:'ensure'` cold-start path and **only blocks client `force`**; `payCallback` uses `PAY_CALLBACK_GUARD` as a **rollout switch** — the default `log` only records, so switch to `strict` after real-device logs confirm callbacks carry no `openid` (even if that judgement is wrong, reconcile back-fills stuck `granting` orders, so no order is lost forever).

**There is no mandatory install list — deploy what you need** (skipping a function does not affect the others):

- **Required**: `aiProxy` — report generation / retrieval / AI Q&A all go through it.
- **Recommended (effectively required)**: `quotaGuard` — the server-side gates read the counters it writes; skip it and the three quota collections stay empty, so the daily caps effectively do not exist in the cloud (the client still enforces them, but that is exactly the half a repackaged client can bypass). Step 3 states the deployment order you must follow.
- **Optional**: `contentCheck` (moderation; fails open, so skipping it only drops one compliance fallback), `hotBoardRefresh` (daily hot board, timer 06:30), `notifyFollowUpdates` / `keywordAlert` / `riskWatch` (three subscription pushes, each needs its own template + timer), `payCreate` / `payCallback` (membership payments, needs your own merchant account).
- **Ops tool**: `dbInit`, delete it when you are done.

### 3. Collections & permissions (18 collections)

A CloudBase document database. The client writes the `id` field; `utils/db.ts` maps it to the system primary key `_id`.

| Collection | Purpose | Permission |
|---|---|---|
| `users` | Account and settings (created on first login; `membership` is a **mirror** of the authoritative record, for the client UI only) | Creator only |
| `memberships` | **Authoritative membership** (`_id` = openid): written only by `payCallback` when an order ships **or a refund is revoked**; the cloud reads it for model tier and for the quota waiver | **Client cannot read or write** (cloud functions only) |
| `ai_calls` | Anti-abuse rate-limit counter (`_id` = openid#yyyy-MM-dd): incremented in place by `aiProxy` right before paying an upstream call — the hard cost boundary | **Client cannot read or write** (cloud functions only) |
| `report_cache` | Report cache + `building` generation mutex (globally shared, long-lived) | Read: everyone; **client cannot write** (writes go through `aiProxy`'s `action:'report'`) |
| `feed_cache` | Structured mapping of retrieval results (no LLM output stored) | Read: everyone; **client cannot write** (same, `op:'saveFeed'`) |
| `hot_board` | Hot board (written daily by AI, always at `_id = latest`) | Read: everyone; client cannot write |
| `keywords` | Keyword retrieval cache (globally shared) | Read: everyone; client cannot write |
| `refresh_quota` | Feed refreshes, ≤ 10 per day (`openid#yyyy-MM-dd`) | Owner reads; writes via cloud functions only |
| `generate_quota` | Daily report generation quota (3 free / 30 member) | Owner reads; writes via cloud functions only |
| `ask_quota` | Daily AI question quota (5 free / 30 member, counted only on success) | Owner reads; writes via cloud functions only |
| `orders` | Membership order state machine (`pending → granting → paid` / `failed` / `refunded`; `refunded` is set by the ops write port and reverts the membership during reconcile) | Owner reads; writes by payment functions only |
| `follows` | Follow list (`openid#personKey`) | Creator only |
| `favorites` | Favorites, four types (deduplicated by `openid#type#hash`) | Creator only |
| `history` | Browsing history (last 50) | Creator only |
| `events` | Analytics events | Creator only |
| `keyword_watches` | Keyword subscriptions (`openid#keyword hash`, same shape as `follows`); also holds person-monitoring rows (`type='person'`, `openid#person#personKey`) | Creator only |
| `risk_scans` | Person risk scan snapshot (`_id = personKey`): remembers what was last seen, to tell which items are new | Read: everyone; client cannot write |
| `risk_signals` | Person risk signal log (`_id = personKey#url hash`) | Read: everyone; client cannot write |

Current state of schema and permissions (important for forks):

- **Collections** can be created in one go by the `dbInit` ops function (`cloudfunctions/dbInit/schema.js` is the **single source of truth** for the schema).
- **Permissions must be set by hand in the console** — no API can change collection permissions; configure them per collection using the table above.
- **Indexes can be automated**: `dbInit` creates and updates them through the WeChat HTTP "update index" API (requires `WX_APPID` / `WX_APPSECRET`), or you can create them manually in the console.
- To see what is still missing, run `dbInit` with `{"action":"report"}` — the `permissions_manual` block in the result is the very list you must click through.

The console has **no** "everyone reads, signed-in users write" preset, so pick "custom security rules" and fill in one of the four levels below (values map one-to-one to `ACL` in `cloudfunctions/dbInit/schema.js`):

| Level | Security rule (JSON) | Collections |
|---|---|---|
| Creator only | Console preset, just pick it | `users` / `follows` / `favorites` / `history` / `events` / `keyword_watches` |
| Read: everyone; client cannot write | `{"read": true, "write": false}` | `hot_board` / `keywords` / `risk_scans` / `risk_signals` / `report_cache` / `feed_cache` |
| Owner reads; client cannot write | `{"read": "doc._openid == auth.openid", "write": false}` | `refresh_quota` / `generate_quota` / `ask_quota` / `orders` |
| Client cannot read or write | `{"read": false, "write": false}` | `memberships` / `ai_calls` |

```bash
tcb fn deploy dbInit -e <your-env-id>
tcb fn invoke dbInit -e <your-env-id> --params '{"action":"report"}'                  # read-only audit: see what is missing
tcb fn invoke dbInit -e <your-env-id> --params '{"action":"init","token":"<token>"}'  # create the missing collections
```

⚠ **Write actions require a token**: set the `DB_ADMIN_TOKEN` environment variable on `dbInit` (any random string) and pass `"token":"<the same string>"` in the call.
When that variable is unset, write actions are **rejected outright** (the read-only audit is unaffected) — this is the gate that stops the function from being called arbitrarily by the client, so do not skip it.
`action` also accepts `fields` (field comparison) / `indexes` (index plan) / `sync` (all of it), and only writes for real with `apply: true`.

**The three permission settings that bite hardest**:

- The three quota collections (`generate_quota` / `refresh_quota` / `ask_quota`) must be "owner reads, **cannot write**", otherwise users can edit their own quota and the free tier is gone.
  ⚠ Deploy `quotaGuard` *before* tightening them, or the client's fallback writes are rejected and the counters stay at zero.
- `memberships` / `ai_calls` must be "**client cannot read or write**": they hold server-side authority (membership status, anti-abuse counter). If the client can touch them, it can grant itself membership and clear its own counter. What the client UI shows comes from the `users.membership` mirror.
- `report_cache` / `feed_cache` are shared caches: "read: everyone, **cannot write**" — the client cannot write them directly; writes go through `aiProxy`'s `action:'report'` (see `report-store.js`).

### 4. Domains & console setup

`npm run build:weapp` writes the client bundle to `dist/`; just refresh WeChat DevTools, or use `npm run build:h5` for browser debugging, where cloud features are unavailable.

Before previewing on a real device and before launch, configure in "Official Platform → Development Management" and the mini program console:

- **Request domains**: **not needed** — the client never calls an upstream domain directly. Bocha search and all four LLM providers are proxied by cloud functions, and cloud-function egress is not subject to the mini program domain allowlist (the cloud database / functions go through `wx.cloud` and need no domain either)
- **Business domains** (optional): only needed if you want the "original article preview" page to embed external sites; put them in `src/config/local.ts` → `webviewDomains` (domain only, no scheme or path). Leave it empty and every link falls back to the material preview card + copy link
- **Privacy policy**: collected items are "anonymous openid, local storage", and must match what the code actually collects
- **Customer service**: enable it and bind staff (reporting and feedback rely on `open-type="contact"`)

### 5. Membership payments (optional)

The code is complete (`payCreate` / `payCallback` plus `utils/pay.ts` and the profile entry point) but requires manual setup:

1. Enable WeChat Pay in the CloudBase console and bind a merchant account;
2. Set `WX_PAY_SUB_MCH_ID` and `PAY_CALLBACK_ENV_ID` on `payCreate`;
3. Deploy `payCallback` (the `PAY_ADMIN_TOKEN` variable and the `payReconcile` timer already live in `cloudbaserc.json`);
4. Set `PAY_ADMIN_TOKEN` on `payCallback` (the ops write-port token).

The callback function name is hard-coded as `functionName: 'payCallback'` inside `payCreate`; **renaming it will break notifications**.
When unconfigured, the client clearly reports "WeChat Pay not configured / payment service not deployed" and free features still work (3 generations per day).

**Caller gate (rollout)**: once deployed, `payCallback` can be called directly from the client, so anyone could "place an order and forge the callback" to grant themselves membership. The gate keys off `getWXContext().OPENID` and is controlled by `PAY_CALLBACK_GUARD` (default `log`, which only records). **Run with the default for a while**, confirm in the logs that real payment callbacks carry **no** `openid`, then switch to `strict`.

**Refunds and reconciliation (after-sales)**: refunds happen on the WeChat merchant platform, so the business side never hears about them; an ops write port therefore marks the order `refunded` — call it from the console's "cloud test":

```json
{ "adminOp": "refund", "token": "<PAY_ADMIN_TOKEN>", "outTradeNo": "MR...", "reason": "customer request" }
```

Marking **only changes the order status, never the membership**; revoking membership is left to the `payReconcile` cron (minute 15 of every hour, or run manually with `{ "adminOp": "reconcile", "token": "..." }`). Revocation subtracts `max(now, current expiry − that order's days)` and only for orders that actually shipped, deduplicated through the authoritative `memberships.refunded_orders` list so days are **never subtracted twice**. Reconcile also back-fills two other gaps: stale `granting` orders, and authority/mirror mismatches (**authority overwrites the mirror**, so a client-forged membership is wiped).

### Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Build fails with `Cannot find module './local'` | `src/config/local.ts` was never created (step 1 of Install & Run) | See [Getting Started](#getting-started) |
| Profile page shows "cloud service not configured" | `cloudbaseEnvId` in `local.ts` is still `REPLACE_ME` | Put your environment ID in (step 1) |
| Generation fails, `-504003` on the client | Function timeout is still the 20-second default (uploaded with DevTools) | Raise it to 60 seconds in the console (step 2) |
| Retrieval returns results but the report body is empty | The model timed out or its JSON failed validation | Check the `aiProxy` logs; the default model name must really exist upstream |
| Free quota never decreases | Quota collections were not tightened, or `quotaGuard` was deployed after the fact | See step 3 |
| Subscription pushes never arrive (43101) | The scheduled jobs share one template | `subscribeTemplateId` / `alertTemplateId` / `riskTemplateId` must be three different templates |
| Tapping "become a member" does nothing | No merchant account / `payCallback` not deployed | See step 5; free features are unaffected |
| After repackaging, the quota effectively does not exist | `ai_calls` / the three quota collections were not tightened | See step 3: `ai_calls` and `memberships` must be "client cannot read or write" |
| UI shows a member but the cloud uses the free tier | No row in `memberships` (the grant only wrote the mirror) | Have the user reopen the order page so the payment callback retries; or check the `payCallback` logs |
| A client can grant itself membership | `payCallback`'s `PAY_CALLBACK_GUARD` is still the default `log` (records but does not block) | Confirm real callbacks carry no `openid` in the logs, then switch to `strict` (step 5) |
| A refunded user is still a member | The order was not marked `refunded`, or reconcile has not run yet | Mark it with `adminOp:'refund'`; reconcile runs hourly, or run `adminOp:'reconcile'` manually (step 5) |

### Pre-launch checklist

- [ ] The mini program's category and your entity qualifications meet the requirements for "news / AI-generated content"
- [ ] The privacy policy is configured and matches what is actually collected (openid, local storage)
- [ ] AI-generated content labelling is kept (built in: the "AI-generated, for reference only" badge and the report-page statement)
- [ ] `SENSITIVE_NAMES` in `src/utils/sensitive.ts` is up to date (⚠ it is left **for operators to fill in by hand**; the repository ships an empty array)
- [ ] The five `debug` flags in `src/config/local.ts` are `false` and `memberOverride` is `'off'` (those are the repository defaults; otherwise free-tier limits and the 429 cooldown protection are disabled, and you would masquerade as a member while self-testing)
- [ ] `memberships` / `ai_calls` are set to "**client cannot read or write**" in the console (they hold both the membership and the cost authority; skip it and a repackaged client can grant itself membership and clear its own counter)
- [ ] `aiProxy` has **no** `AI_PROXY_TEST_TOKEN` configured (or it is configured and kept private): the `test` probe pays for two real upstream calls every time, and is rejected outright while unset
- [ ] If membership payments are deployed, `payCallback`'s `PAY_CALLBACK_GUARD` has been confirmed against real callbacks and switched to `strict` (the default `log` only observes, so the client can still forge callbacks)
- [ ] If membership payments are deployed, `payCallback` has `PAY_ADMIN_TOKEN` set and kept private (the refund / reconcile write-port token; unset means the port is always rejected)
- [ ] The main acceptance paths have been exercised on a real device (search → disambiguation → generation → favorite / share / Q&A)

---

## Project Structure

Paths below are relative to the `celebrity-radar/` subdirectory; the repository root also holds `README.md` / `README.en.md` / `LICENSE` / `NOTICE` / `CHANGELOG.md` / `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / `assets/screenshots/`.
(`doc/` — the author's internal design and integration docs — is excluded by `.gitignore` and is **not distributed**.)

```
celebrity-radar/
├── src/
│   ├── pages/                  # 19 pages
│   │   ├── index/              # Discover (tab bar)
│   │   ├── ask/                # AI Q&A (tab bar)
│   │   ├── collection/         # Favorites (tab bar)
│   │   ├── mine/               # Profile (tab bar)
│   │   ├── report/             # Report page (core)
│   │   ├── profile/            # Figure profile
│   │   ├── feed/               # Following feed
│   │   ├── following/          # Follow list
│   │   ├── weekly/             # Weekly digest
│   │   ├── compare/            # Compare two figures
│   │   ├── qa/                 # AI Q&A (entry from report)
│   │   ├── topic/              # Topic knowledge base
│   │   ├── alerts/             # Keyword alerts
│   │   ├── messages/           # Message center
│   │   ├── history/            # Browsing history
│   │   ├── records/            # Favorites / records entry
│   │   ├── link-preview/       # Source article preview
│   │   ├── member/             # Membership center
│   │   └── agreement/          # Privacy & disclaimer
│   ├── components/             # person-card / favorites-view / report-loading / share-poster / qa-panel ...
│   ├── utils/                  # Business logic & cloud access (48 modules, see Core Modules)
│   ├── config/                 # public.ts (shared) / local.ts (local, untracked) / domains / hot / filters / notices
│   ├── stores/                 # zustand stores
│   ├── styles/                 # Theme variables, tab-bar icons
│   └── custom-tab-bar/         # Custom bottom tab bar
├── cloudfunctions/             # 10 cloud functions
│   ├── aiProxy/                # Upstream key proxy + member model gate (test / search / chat)
│   ├── quotaGuard/             # Authoritative quota counting (atomic increments + server dates)
│   ├── contentCheck/           # Content moderation (cloud call)
│   ├── payCreate/              # Order creation (server-side pricing + cloud pay order)
│   ├── payCallback/            # Payment notification + after-sales (refund port / reconcile, cron :15; after-sales.js)
│   ├── notifyFollowUpdates/    # Follow-update subscription messages (cron 09:00, client calls rejected)
│   ├── keywordAlert/           # Keyword alerting (cron 09:20, client calls rejected)
│   ├── riskWatch/              # Person risk monitoring (cron 09:40, client calls rejected)
│   ├── hotBoardRefresh/        # Daily hot board (cron 06:30; client may `ensure`, `force` is ops-only)
│   └── dbInit/                 # Ops tool (schema.js is the schema source of truth)
├── test/                       # Local unit tests (9 case files / 522 cases)
├── config/                     # Taro build config (dev / index / prod)
├── cloudbaserc.json            # CloudBase deployment descriptor (functions + env vars + timers)
├── .env.example                # Deployment secret template
├── project.config.json         # WeChat DevTools project (miniprogramRoot: dist/)
└── project.private.config.example.json
```

---

## Core Modules

`src/utils/` is the only exit point for all business logic and cloud access — pages call into it and never touch the database or upstream APIs directly.

- **`cloud.ts` / `db.ts`** — CloudBase initialization and diagnostics; a hand-rolled data-access adapter (`table('x').select/eq/or/upsert/maybeSingle`) with `id ↔ _id` mapping, pagination continuation and write fallbacks
- **`auth.ts`** — WeChat login + first-time `users` initialization; concurrent login deduplication, session persistence, stale-cache rejection
- **`search.ts`** — Bocha adapter (degrades without a key) normalizing material into `NewsItem`; `searchForAsk` used by Q&A
- **`disambiguate.ts`** — LLM homonym disambiguation with a domain-code enum and fallback
- **`report.ts`** — report generation, zod validation, URL allowlist sanitization, plain-text degradation
- **`cache.ts`** — `report_cache` read/write with the `building` mutex, plus `feed_cache` and `refresh_quota`
- **`quota.ts` / `quota-guard.ts`** — freemium generation quota and its server-side channel (falls back to local counting when not deployed)
- **`llm.ts`** — LLM calls, always proxied by `aiProxy`; **provider + tier** are resolved from the local preference plus `public.ts` (switching provider keeps the tier), and non-members requesting a member tier always fall back to that provider's fast model
- **`member.ts` / `member-sample.ts`** — the membership benefit table (single source of truth), member checks and the report page's member value copy; the "real sample" in the membership center (excerpted verbatim, and omitted when nothing qualifies)
- **`pay.ts`** — membership payments: fetch server plans (24h local cache + offline fallback) + create order + open checkout + poll for confirmation (price and duration come from the **server only**)
- **`qa.ts`** — AI Q&A: passage selection from the report, an extra web search per question, a daily quota gate counted only on success, and a 3-second tap interval
- **`weekly.ts`** — weekly digest: material read from `feed_cache` only, the LLM writes text only (people and items follow the material), cached locally per ISO week
- **`hot-board.ts` / `explore.ts`** — hot board with three-level fallback; "figure of the day" and random exploration (stable seeds, xorshift32 to remove modulo bias)
- **`keyword-alert.ts` / `keywords.ts`** — keyword subscriptions and alert items; keyword cloud and frequent viewpoints (pure client-side aggregation, effective immediately for cached reports)
- **`risk-watch.ts` / `risk.ts`** — person risk monitoring subscriptions and signal grouping; the fact-level risk radar list on the report page (both share one dictionary, held in sync by a test)
- **`topic-digest.ts` / `compare.ts` / `stats.ts` / `trend.ts`** — topic catalog / two-person comparison / profile stats tab / heat-trend curve — all aggregated on the client, adding no schema fields or cloud functions
- **`quote-check.ts` / `source-link.ts`** — quote sourcing (verifies only verifiable facts); the single outbound link path for the article preview page
- **`messages.ts` / `notify.ts`** — message-center timeline and its read semantics; WeChat subscription authorization and push placement
- **`share-card.ts` / `share.ts`** — Canvas 2D quote cards (no remote images, nothing uploaded) and the project's only share-copy exit
- **`sensitive.ts` / `sec-check.ts`** — local sensitive-name blocking (maintained by hand before each release); content moderation (fails open)
- **`follows.ts` / `favorites.ts` / `history.ts` / `watch.ts`** — follow list (`openid#personKey` key), four favorite types (`openid#type#hash`, deduplicated by construction), query history (last 50 per account), and the "what changed" overview for followed figures (material read from `report_cache` and `feed_cache` only)
- **Infrastructure** — `time.ts` (relative time and the single report-staleness threshold), `date.ts` (the single report-date normalizer shared by the trend curve and the stats bar), `cooldown.ts` (10-minute cooldown on 429), `debug.ts` (the single debug-switch exit), `cloud-diagnostics.ts` (structured diagnostic logs), `settings.ts`, `events.ts`, `tabbar.ts`, `data-deletion.ts`

---

## Security & Compliance

- **Secrets never ship**: only local storage on the client, only cloud-function environment variables on the server
- **Input side**: the local sensitive-name list blocks requests before any network call is made
- **Output side**: `sources` / `dynamics` links are sanitized against an allowlist and must have appeared in the retrieved material
- **Content policy**: every report is labeled "AI-generated, for reference only"; there is a privacy statement page, a reporting entry point and a two-step "delete my data" flow
- **Cost control**: shared report cache, ≤ 10 feed refreshes and ≤ 3 generations per account per day (30 for members), a `building` mutex to prevent duplicate concurrent generation, and weekly digests cached per calendar week
- **Retrieval depth follows the tier**: the free tier issues the main search line only (10 items); members get 24 main + 16 social (40). Both the number of search calls and the material volume scale with the tier
- **Free-tier refresh cooldown**: within 12 hours of a report being generated, "refresh latest" on a free account returns the existing version with an on-page explanation instead of regenerating (the content would not have changed); members are exempt. **Do not confuse this with the upstream-failure cooldown** — different criteria, duration and purpose
- **Feed refresh uses the main search line only**: one pull-to-refresh queries each followed person once (the social line is dropped: 20 → 10 search calls per refresh), rotates by "least recently refreshed" so people beyond the 10-per-refresh cap get a turn, and runs 4 requests at a time
- **Cooldowns only block failures worth waiting for**: only upstream 429s, network errors and 5xx responses trigger the 10-minute cooldown; invalid keys and exhausted quota fail immediately without cooldown, and a cache hit always outranks both
- **Cloud-function caller gate**: client calls always carry `getWXContext().OPENID`, while timers, WeChat callbacks and the console's "cloud test" never do — the four scheduled jobs and the payment callback **reject client calls** on that basis (`payCallback` uses the `PAY_CALLBACK_GUARD` rollout switch, defaulting to observe-then-`strict`). It blocks "patch the client, then loop the push jobs / forge a payment callback to grant yourself membership"
- **After-sales loop**: refunds are marked by an ops write port, and reconcile revokes membership **by the order's days** (only the days that order bought, deduplicated through the authoritative list); reconcile also back-fills shipments and overwrites any client-rewritten mirror membership with the authority
- **Vulnerability reports**: please **do not** open a public Issue — use the private channel described in [`SECURITY.md`](./SECURITY.md).
  For calibration: patching the client so it *displays* a member tier is **not** a vulnerability (the gate lives in the cloud); bypassing the cloud gate is

---

## Development & Testing

```bash
npm test          # compile tests with tsc, then run everything (522 cases, fully local, no cloud)
npm run test:only # skip tsc and run directly
```

The suite adds **no dependencies** (a hand-written in-memory CloudBase plus Taro / `wx` stubs and a minimal assertion library) and asserts against the **compiled product code itself**.
It needs no cloud environment, no DevTools and no network. It does not cover page rendering, on-device interaction, cloud-function execution, or payments and push.

Before submitting a change, confirm these five:

1. `npm test` is green (currently 522 / 522)
2. `npx tsc --noEmit` reports no new warnings
3. The mini program **main package size** is within the hard 2MB limit (the current build output is about 1.3MB); check the build output before adding dependencies
4. `src/config/local.ts` and the `debug` flags are **not** committed (already in `.gitignore`)
5. Schema changes come with matching updates to `cloudfunctions/dbInit/schema.js` (the single source of truth)

---

## FAQ

| Question | Answer |
|---|---|
| Can I just run it? | It compiles. To exercise generation you need a **CloudBase environment + a Bocha key + LLM keys** (four providers are selectable; configuring `DEEPSEEK_API_KEY` alone is enough to get started, but **every provider left in the client list needs its own key**, see [Configuration](#configuration) §3) |
| Will it cost money? | Yes. Search and LLM calls are metered — the quota, cache and cooldown mechanisms exist precisely to contain that |
| Can I use it commercially? | The license allows it, but **launching requires your own entity qualifications, category filing and AI-content compliance measures** |
| Does the membership payment work? | The code is complete (`payCreate`, `payCallback`, the `PLANS` price map) but needs your own WeChat Pay merchant account; without it the client says so explicitly and free features keep working |
| Can I keep the brand? | "Celebrity Radar" belongs to the original author; please rename before publishing a fork to avoid confusion |
| Why is commercial code included? | It is a complete reference implementation: a single price source, a read-only client, and cloud-side enforcement — the reasoning is documented in the comments |
| Which LLMs are supported and can users choose? | The client offers **four** selectable providers: DeepSeek / Qwen / Zhipu GLM / Moonshot Kimi, picked by the user under "Profile → Model provider", with the platform paying for the keys in the cloud function (`llm.config.js` also lists OpenAI, but it is deliberately not exposed). Variable names, setup steps and the cost of a missing key are in [Configuration](#configuration) §3 |
| How hard is it to swap upstreams? | The providers users may pick live in `llm.providers` in `src/config/public.ts`; the cloud registry (endpoints / key variable names / member tiers) is `cloudfunctions/aiProxy/llm.config.js` (with a byte-identical copy in `hotBoardRefresh` — change both). Adding one = one entry on each side + one environment variable |

**Upstream risk**: the search provider (Bocha) and the LLMs (DeepSeek / Qwen / Zhipu GLM / Moonshot Kimi, all OpenAI-compatible endpoints) are third-party paid services;
their APIs, pricing and availability are outside this project's control.

---

## Known Limitations

- `src/utils/sensitive.ts` must be **updated by hand** before each release to meet current compliance requirements; the code does not update it remotely
- Content moderation (`contentCheck`) uses cloud calls and **fails open** when not deployed or when its permission is not effective (availability over blocking)
- Keyword alerts depend on WeChat **one-time subscription** grants, so template IDs and push timing are constrained by platform rules
- Whether the article preview page can embed content in a webview depends on the domain allowlist and WeChat platform checks; otherwise it degrades to a preview card
- A report's **member-only sections depend on who generated the cached copy**: each person has a single global cache row, so if a free-tier user generated it first, a member opening that person sees a version without the three exclusive sections and must tap "Refresh" to upgrade it with the member tier (**that upgrade does not consume daily generations**). Conversely, a version that already contains member sections is never overwritten by a free-tier refresh — but free users cannot see those three sections in the UI either
- Reports are generated by an LLM and **may contain factual errors** — always check the source links
- Tests cover logic and data layers only, not UI rendering, on-device interaction, cloud-function runtime, or the full payment flow

---

## Contributing

Issues and pull requests are welcome. **The full process, review criteria and Issue template are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md)** (Chinese); the short version:

1. The default branch is `master` — branch off it (`feat/xxx`, `fix/xxx`, `docs/xxx`, `chore/xxx`)
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` / `fix:` / `docs:` / `chore:` …), one concern per commit
3. Complete the five checks in "Before submitting a change" above and explain the motivation and verification in the PR description
4. Attach on-device screenshots for UI or interaction changes
5. When touching either "hand-synced pair" (the provider/tier tables, the member-tier gate), change both copies
6. Keep both READMEs (`README.md` / `README.en.md`) in sync, and update [`CHANGELOG.md`](./CHANGELOG.md)

By participating you agree to the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

We do not accept: real keys or environment IDs, "cracks" that bypass quota or membership gates, material and
fonts of unknown origin, or unrelated large-scale rewrites (framework swaps, repo-wide reformatting).

---

## Feedback & Support

| What you want | Where to go |
|---|---|
| Report a bug | [Gitee Issues](https://gitee.com/qianlonglove_admin/celebrity-radar/issues) — use the template at the end of [`CONTRIBUTING.md`](./CONTRIBUTING.md), and **strip keys and openids from any log excerpt** |
| Suggest a feature | Open an Issue first to align on motivation and scope. The design rationale lives in code comments; aligning up front saves a round trip |
| Report a security issue | **Do not open a public Issue** — use the private channel in [`SECURITY.md`](./SECURITY.md) |
| Get help | Check [FAQ](#faq) and [Known Limitations](#known-limitations) first — most "it does not work" reports are covered there |
| See what changed | [`CHANGELOG.md`](./CHANGELOG.md) |

This project is maintained by one person; replies are best-effort (security reports usually get a first response
within 7 business days).

If this project helps you, a Star on Gitee is appreciated, or add the pitfalls you hit to the [FAQ](#faq).

### Donations

Entirely voluntary, and unrelated to feature decisions — a tip carries no promise of prioritised features,
faster replies, or unlocked membership.

<table>
  <tr>
    <td align="center"><img src="./assets/%E5%BE%AE%E4%BF%A1.JPG" width="165" alt="WeChat Pay QR code"><br><sub><b>WeChat Pay</b></sub></td>
    <td align="center"><img src="./assets/%E6%94%AF%E4%BB%98%E5%AE%9D.JPG" width="165" alt="Alipay QR code"><br><sub><b>Alipay</b></sub></td>
  </tr>
</table>

---

## Version & Changelog

Current version **0.1.0** (see `celebrity-radar/package.json`); all changes are recorded in
[`CHANGELOG.md`](./CHANGELOG.md) (Chinese).

Version numbers follow [Semantic Versioning](https://semver.org/): **MAJOR** = a migration the deployer must
perform (database schema, cloud-function contract, config renames — flagged as **部署者注意** in the log);
**MINOR** = backwards-compatible capabilities; **PATCH** = fixes and copy changes.

---

## License & Credits

Released under the [Apache License 2.0](./LICENSE); copyright and third-party notices are in [`NOTICE`](./NOTICE).

- Upstream services: Tencent CloudBase (WeChat Cloud Development), Bocha search, four selectable LLM providers (DeepSeek / Qwen / Zhipu GLM / Moonshot Kimi), WeChat Pay
- Open-source dependencies: Taro, Taro UI, React, zustand, zod, dayjs and others, each owned by its respective authors

**Disclaimer**: this project is intended for technical learning and exchange. You are responsible for any consequences of using it,
including upstream API costs, content compliance and data-security obligations. The "Celebrity Radar" name and brand belong to the original author.

