# Celebrity Radar

**English** · [简体中文](./README.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Taro](https://img.shields.io/badge/Taro-3.6-07c160.svg)](https://taro-docs.jd.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-688%20passing-success.svg)](#development--testing)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> A **celebrity intelligence mini program** for the WeChat ecosystem: type any public figure's name → the app searches recent public coverage online → an LLM turns it into a structured report (bio / profile / activity / quotes / commentary / controversies & responses / timeline / glossary…), plus client-side aggregate cards such as profile snapshot, risk radar and commercial value.

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

A complete, compilable WeChat mini program: 19 pages on the client, 12 cloud functions and 18 database collections on the server,
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
- **Report generation** — Bocha web search → material is grouped by the report template and injected batch by batch (**4 batches** per generation: identity / facts / judgement / detail, each with its own contract and its own write, so a single failed batch only loses that group) → LLM produces structured JSON → zod validation of every field + source-URL allowlist sanitization; **rendered card by card** (bio / profile / relationship map / recent activity / notable quotes / AI commentary / controversies & responses / timeline / commercial partnerships & endorsements / glossary + a one-line source summary; the report template has **17 sections**, 11 free / 6 member), skeleton loading with progressive reveal, and a "generated N ago / refresh" pair of entry points; every factual section must cite a real piece of material — anything unsourced is dropped entirely, and a section that is genuinely empty still renders a card explaining why
- **Client-side aggregates** — Profile snapshot, stance & sentiment, risk radar, commercial value snapshot, and commercial partnerships & endorsements — **computed entirely on the client**, so existing cached reports benefit immediately with zero extra model calls or quota usage
- **Quote sourcing** — Verifies only *verifiable* facts (is this quote's source link part of the retrieved material; does that article contain the same wording) — it does **not** render AI verdicts on authenticity

### Reading & saving

- **Following** — Follow list + change overview (who has news) + merged feed (`feed_cache` merged with pull-to-refresh, capped at 10 refreshes per account per day — 20 for members)
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

- **Quota** — Free tier: 3 on-demand generations per day, 30 for members (cache hits never count; the **weekly digest draws on this same pool**); AI Q&A: 5 questions free, 30 for members (counted separately from generation, and only successful answers count); feed refresh: 10 per day free / 20 for members; the free tier additionally has a 12-hour repeat-generation cooldown for the same report that members do not have. All of it appears both on the profile page's quota card and item by item in the membership centre's **"Quotas & limits"** section (including capacity/input caps such as 5 keywords, 5 monitored people, 120 characters per question); every number comes from `src/utils/member.ts#MEMBER_BENEFITS`, referenced by pages and gates alike rather than hard-coded
- **Quality perks** — **User-selectable model vendor** (CloudBase AI / DeepSeek / Zhipu GLM / Kimi / Qwen — **5 vendors**, including the zero-config **CloudBase AI** default channel; keys all live in the cloud function, so users configure nothing) + a **quality tier** (free tier is locked to "Basic"; members can switch to "Standard" / "Premium") + a **deep report mode** (thicker retrieval plus three member-only sections: comparison angles, risk notes, source disagreements) + the **full report template** (17 sections for members, with 6 member-only: Business snapshot / Commercial partnerships / Member-only / Peer comparison / Stance & sentiment / Glossary)
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

Rendered card by card (bio / profile / relationship map / recent activity / notable quotes / AI commentary / controversies &amp; responses / timeline / commercial partnerships &amp; endorsements / glossary); every factual section must cite a real piece of material

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
    <td align="center"><img src="./assets/screenshots/10-providers.png" width="165" alt="Model vendors"><br><sub><b>Model vendor of your choice</b> · CloudBase AI / DeepSeek / Zhipu GLM / Kimi / Qwen</sub></td>
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
- **LLM** — **any of several vendors (5, including the zero-config CloudBase AI)**: CloudBase AI (default, zero key) / DeepSeek / Zhipu GLM / Kimi / Qwen, with 3 quality tiers (Basic / Standard / Premium); the client reports only "vendor + quality tier", and the cloud picks the capability slot by purpose (report / auxiliary → structured, Q&A → reasoning). Selectable vendors / tiers are in `llm.vendors` / `llm.qualities` in `src/config/public.ts`; endpoints, key variable names and the model registry are in `cloudfunctions/aiProxy/llm.config.js` (with a word-for-word identical copy in `hotBoardRefresh`, pinned by case 07); setup steps are in [Configuration](#configuration) §3

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
          → LLM produces structured JSON (any of several vendors, including the zero-config CloudBase AI; proxied by aiProxy) → zod validation + URL allowlist
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
cloudfunctions/**         12 cloud functions (secrets, quota, moderation, scheduled jobs, payments)
     ↓
Upstream: Bocha search / LLM (any of several vendors, incl. CloudBase AI) / WeChat Pay / security.msgSecCheck
```

Two mechanisms worth knowing:

- **`report_cache.state = building` acts as a cross-device generation mutex**: when two clients request the same person concurrently, only one performs the generation while the other waits for the result.
- **A cache hit always wins over cooldown and quota**: hits render immediately without consuming quota or being blocked by cooldowns.

---

## Getting Started

### What you must supply

Environment: Node 16 / 18 (LTS recommended), WeChat DevTools, and a mini program appid with Cloud Development enabled.

- **Mini program appid + entity qualifications** — required by WeChat; without it, no on-device preview and no publishing
- **CloudBase environment (Tencent Cloud)** — hosts the database and all 12 cloud functions; without it, login and **all** database calls are never issued and the profile page shows "cloud service not configured"
- **An LLM API key (optional; zero-key by default)** — generates reports (via the `aiProxy` cloud function). The default vendor, **CloudBase AI**, needs no key and works out of the box; to offer an external vendor, configure its key in the cloud (`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY` (Qwen)) — **a vendor only appears in the app once its key is configured**. Browsing and favoriting cached reports always works
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

- **`src/config/local.ts`** — your own real values: CloudBase environment ID, the webview domain allowlist, the local debug switch (**subscription template IDs are not here** — see the `.env` line). **Required**: `src/config/public.ts` imports it directly and the build fails with `Cannot find module './local'`
- **`project.private.config.json`** — your private WeChat DevTools project settings (your appid and tool preferences). Without it you re-enter the appid and settings in DevTools every time
- **`.env`** — deploy-time secrets for cloud functions (`DEEPSEEK_API_KEY` / `BOCHA_API_KEY` …) **plus the three subscription template IDs** (the single source for both the client and the cloud), referenced from `cloudbaserc.json` as `${env.XXX}`. Without it, deployed functions have no upstream keys, so retrieval and generation fail; empty template IDs simply disable the subscription pushes

### Benefits & pricing (one file to edit)

Member quotas, daily limits, cooldowns, abuse caps, cloud-side search/char limits, plan prices &
durations, and the report's target counts / clipping limits / retrieval depth all live in
**`src/config/benefits.ts`** — the single source of truth; user settings defaults have their own truth
source, **`src/config/user-defaults.ts`** (the default `users.settings` values and key allowlist).

Cloud functions are packaged and uploaded independently and cannot `require` the app's TypeScript
at runtime, so the cloud side uses **generated copies**:

```bash
# 1. edit src/config/benefits.ts (or src/config/user-defaults.ts)
npm run config:sync     # 2. refresh copies: benefits.config.js → {aiProxy,quotaGuard,payCreate}; user-defaults.config.js → {userInit,userBackfill}
npm test                # 3. verify (skipping step 2 turns the suite red: 14-config-sync.js)
npm run config:check    # read-only check for CI (exit 1 on drift)
```

The copies (`cloudfunctions/*/benefits.config.js` and `cloudfunctions/*/user-defaults.config.js`) are **auto-generated** and marked "do not edit";
redeploy the affected cloud function for a change to take effect (the app side ships with the next
release).

**Still hand-synced**: the two `llm.config.js` copies in `aiProxy` and `hotBoardRefresh` (they carry
the `resolveLlm` function and per-vendor key variable names — not plain values, and adding a vendor
needs human verification anyway).

---

## Configuration

### 1. Client config: `public.ts` (shipped) + `local.ts` (local only)

- **`src/config/public.ts`** (committed) — deployment-independent settings: the selectable **vendor** list `llm.vendors` (5 vendors) and the **quality-tier** list `llm.qualities` (Basic / Standard / Premium, with `memberOnly` flags). **Never put any key or model name here** (keys live in cloud function environment variables; choosing a vendor / tier only changes request parameters)
- **`src/config/local.example.ts`** (committed) — template for local config, all values are placeholders
- **`src/config/local.ts`** (not committed, in `.gitignore`) — your own real values: environment ID, webview domain allowlist, local debug switch

`local.ts` (created by copying `local.example.ts` after cloning):

- **`cloudbaseEnvId`** — CloudBase environment ID. While it stays at the placeholder, the cloud service counts as unconfigured and no login or DB call is issued
- **Subscription template IDs** — **not here**: their single source is the repository-root `.env` (`SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID`). At deploy time `cloudbaserc.json` injects them into the three scheduled functions; at build time `config/index.js` reads the **same** `.env` and injects them into `src/config/public.ts` via `defineConstants`. Fill them in **one place only** — the client and the cloud cannot diverge. **Three different templates** are required (WeChat one-time grants are consumed **per template**, so sharing one template between two scheduled jobs means the first consumes the grant and the second always fails with 43101). Empty = push disabled (no authorize button; scheduled jobs write in-app data and record a `skipped` reason) while in-app features keep working
- **`webviewDomains`** — Allowlist of domains the "original article preview" page may embed; leave empty to always fall back to a preview card plus a copy-link action
- **`debug`** — Local debug switch (opens quota gates and upstream cooldowns). **All flags default to safe values** (five `false` plus `memberOverride: 'off'`), change them only for local integration work
- **`debug.memberOverride`** — Forces a membership identity so the paid features can be self-tested: `'off'` (default) keeps the real server-side grant, `'free'` forces the free tier, `'monthly'` / `'quarterly'` / `'annual'` force that tier.
  ⚠ It only overrides the **client-side** verdict (`utils/member.ts#readMemberState`, outermost layer) and is **never recognised by the cloud**: with a forced membership, `aiProxy` still clamps retrieval counts by the real identity and `quotaGuard` still re-checks the waiver — so "thicker retrieval" and "member-tier models" cannot be tested this way; to see the real output, add a row to the authoritative `memberships` collection (`_id` = your openid) in the cloud. Also: do **not** test payments while a membership is forced (`utils/pay.ts` confirms the grant by `expires_at` moving later, which the override keeps constant)

`public.ts`:

- **`llm.vendors`** — Selectable **vendors** (5, in the order shown in the app): each has a `key` (must match a `VENDORS` key in the cloud function's `llm.config.js`), an `icon`, a `label` and a `desc`. CloudBase AI (`cloudbase`) is always present; whether an external vendor is selectable is decided by its cloud readiness (whether its key is configured). The client holds no key / endpoint / model name
- **`llm.defaultVendor` / `llm.defaultQuality`** — the default vendor (`cloudbase`) and default quality tier (`basic`); the fallback when nothing is stored locally, and must match the cloud's `DEFAULT_VENDOR` / `DEFAULT_QUALITY`
- **`llm.qualities`** — the quality-tier list (`basic` / `standard` / `premium` = Basic / Standard / Premium): each has a `key` (must match the cloud's `QUALITIES`), a `label`, a `desc` and `memberOnly`. `memberOnly: true` = member-only: even if a free user picks it locally, the cloud **silently falls back to Basic**. **Changing this flag requires updating `QUALITIES[].memberOnly` in the cloud `llm.config.js`** — that copy is the real billing gate (the client copy can be bypassed by repackaging)

> A user's **vendor + quality-tier** choice lives in local storage only (`settings:llm_provider` + `settings:llm_tier`).
> Both keys store an **id** (a vendor key / `basic` / `standard` / `premium`), never a model name — the client holds no model names at all;
> the three tiers are the same across vendors, so switching vendor keeps "the tier I picked". The concrete model is
> resolved in the cloud from the "vendor × quality tier × purpose" registry in `llm.config.js`, and the **real billing gate lives in the cloud** (the client copy can be bypassed by repackaging).

> They are split so that a real environment ID in the repository does not make forks connect to the original author's cloud environment,
> and so that the author's local `debug: true` edits in `public.ts` cannot be committed by accident.

### 2. Secret ownership: server-side only, zero client secrets

- **`BOCHA_API_KEY` + each external vendor's key (`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY` (Qwen))** — environment variables of the `aiProxy` / `hotBoardRefresh` cloud functions (read from `.env` at deploy time). **A vendor only appears in the app once its key is configured**; the default vendor **CloudBase AI** uses the CloudBase AI channel and needs **no key**. ❌ not in the bundle
- **`SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID`** — the **single source is `.env`**: injected into the three scheduled functions at deploy time, and into the client at build time. Template IDs are **not secrets** (every user can see them in the mini program), so ✅ they **are** in the bundle. **Three different templates**, or the jobs consume each other's one-time grants
- **`WX_APPSECRET`** — `dbInit` only (to exchange an access_token for index updates). ❌ not in the bundle
- **`DB_ADMIN_TOKEN`** — `dbInit` only (custom token, the gate for write actions). ❌ not in the bundle
- **`AI_PROXY_TEST_TOKEN`** — `aiProxy` only (token for the paid `test` probe; **unset means that action is always rejected**, which is the intended default). It is an ops token rather than a deployment item, so normally you add it in the console only while troubleshooting. The probe also reports the **second search source's connectivity and latency** — both providers live outside mainland China, so calls from a domestic cloud function cross the international gateway; that probe is the only way to tell whether the link actually works. ❌ not in the bundle
- **`AI_PROXY_RAW_LOG`** — optional `aiProxy` variable (cloud-side raw payload logging; **only `on` enables it**). It covers the half the client cannot see: `local.ts`'s `debug.rawIoLog` only prints the **cloud function's return**, never what upstream actually replied — and that is where most LLM problems live (200 but malformed body, output cut off by `max_tokens`, a search returning only 3 items). When enabled, `chat:req` / `chat:upstream` / `chat:err` / `search:primary` / `search:backup` go to the cloud function log; it is **off by default and always truncated, never the full body** (the function log has a size limit; tens of thousands of characters would push out the same call's billing entries). ⚠ **Those logs live in the CloudBase console → Cloud Functions → Logs, not in the WeChat DevTools console** — the latter is the client console; they are two separate things, and looking in the wrong place looks like "nothing was printed". ❌ not in the bundle
- **`AI_PROXY_CHAT_DEADLINE_MS` / `AI_PROXY_AUX_DEADLINE_MS`** — optional `aiProxy` variables (defaults `45000` / `20000`, in milliseconds): a **wall-clock deadline** for a single chat call, one for report-style calls and one for auxiliary calls (disambiguation / topic picking / search-query planning). They exist because the platform's 60 seconds is a hard ceiling that cannot be raised, so the function has to police itself: on hitting the deadline it aborts and returns an ordinary retryable failure (`kind=network`) instead of being killed by the platform (which leaves the client with `-504003` and not one line of explanation in the function log). ⚠ **Do not raise it** (it must stay below the function's execution timeout); lowering it while troubleshooting (e.g. `3000`) reproduces the "slow upstream gets aborted" branch immediately. ❌ not in the bundle
- **`WX_PAY_SUB_MCH_ID` / `PAY_CALLBACK_ENV_ID`** — `payCreate`. ❌ not in the bundle
- **`PAY_ADMIN_TOKEN`** — `payCallback` only (token for the refund / manual-reconcile ops write port; **unset means the write port is always rejected**). ❌ not in the bundle
- **`PAY_CALLBACK_GUARD`** — optional `payCallback` variable, the rollout switch: `log` (default, client calls are only logged) / `strict` (client calls rejected) / `off` (no check). Switch to `strict` once real-device logs confirm the callback shape. ❌ not in the bundle
- **Deploy-time secret source (the `.env` file itself)** — `celebrity-radar/.env` (copied from `.env.example`, **not committed**), referenced from `cloudbaserc.json` as `${env.XXX}`. ❌ not in the bundle
- **Environment ID** — `src/config/local.ts` → `cloudbaseEnvId`. ✅ in the bundle (**not a secret**)
- **Subscription template IDs** — not in `local.ts`; their single source is `.env`, build-injected into the client (`src/config/public.ts`) and deploy-injected into the three functions. ✅ in the bundle (**not secrets**)

Every request is proxied through a cloud function; the client holds no keys and users need no setup. An older build-your-own-key (BYOK) direct mode was **removed entirely**.

`src/config/local.ts` *is* bundled, so only put "not a secret, but machine-specific" values there.

### 3. Model vendors and API keys (5, including the zero-config CloudBase AI)

The "Profile → Model vendor & quality tier" screen lets users choose two things: a **vendor** (switchable at any time) and a **quality tier**. **The platform pays for the keys inside the cloud function** — users configure nothing; the default vendor **CloudBase AI** uses the WeChat CloudBase AI channel, with **zero keys and no setup**. Five vendors are exposed to the client (in the order shown in the app):

- **CloudBase AI** (id `cloudbase`) — the **default vendor**, a zero-key fallback
- **DeepSeek** (id `deepseek`) — key variable `DEEPSEEK_API_KEY`; endpoint `https://api.deepseek.com/v1`
- **Zhipu GLM** (id `zhipu`) — key variable `ZHIPU_API_KEY`; endpoint `https://open.bigmodel.cn/api/paas/v4`
- **Kimi / Moonshot** (id `moonshot`) — key variable `MOONSHOT_API_KEY`; endpoint `https://api.moonshot.cn/v1`
- **Qwen** (id `qwen`) — key variable `DASHSCOPE_API_KEY`; endpoint `https://dashscope.aliyuncs.com/compatible-mode/v1` (DashScope compatible mode)

There are **3 quality tiers**: **Basic** (free) / **Standard** (members) / **Premium** (members). The concrete model is **not chosen by the user** — reports and auxiliary calls use that tier's structured (output) capability slot, AI Q&A uses the reasoning slot, and the slot models live in the cloud `llm.config.js` registry; when a tier lacks a slot, the cloud **downgrades within the same vendor** and flags it in the reply.

Setup:

1. To offer an external vendor, put its key into `celebrity-radar/.env` (copied from `.env.example`) — **the variable names must match the list above**; **a vendor only appears in "Profile" once its key is configured** (CloudBase AI is always present and needs no key).
2. Make sure `aiProxy` and `hotBoardRefresh` in `cloudbaserc.json` carry those variables under `envVariables` (the repository already does; if you upload via the DevTools context menu instead of `tcb fn deploy`, add them by hand in the CloudBase console).
3. Deploy both functions (`tcb fn deploy aiProxy && tcb fn deploy hotBoardRefresh`).
4. Verify on a real device: switch to each vendor under "Profile → Model vendor & quality tier" and generate once — a report means that key works.

Rules worth knowing:

- **Every vendor you offer needs its own key** (except CloudBase AI, which is zero-key). Offer an external vendor without a key and users simply will not see it — "configured equals visible" is exactly how it works, so do **not** leave an entry and skip its key.
- **The client reports only "vendor + quality tier"**: the request is proxied by `aiProxy` and the **capability slot is decided in the cloud by purpose** (report / auxiliary → structured, Q&A → reasoning); the client holds no model names or keys.
- **The billing gate lives in the cloud**: a non-member requesting Standard / Premium is **silently dropped back to Basic** by `aiProxy` (a repackaged client cannot bypass it). Changing member tiers means editing two places: `llm.qualities[].memberOnly` in the client `public.ts` (UI and request value) and `QUALITIES[].memberOnly` in the cloud `llm.config.js` (**the billing gate**).
- **Optional override variables** (defaults apply when unset): `LLM_VENDOR` (the default vendor used when the client sends none / by cron jobs; `cloudbase` by default), `LLM_TIER` (the default quality tier), `LLM_MODEL_<VENDOR>_<QUALITY>_<CAPABILITY>` (override a slot's model name, e.g. `LLM_MODEL_DEEPSEEK_STANDARD_REASONING`), `LLM_HTTP_ENDPOINT_<VENDOR>` (override a vendor's endpoint).
- **Self-hosted gateway / relay**: override the target vendor's endpoint with `LLM_HTTP_ENDPOINT_<VENDOR>` — no need to touch the registry.
- **CloudBase AI channel (default)**: requires the AI capability enabled in the CloudBase console, `wx-server-sdk` ≥ 4.0.1 on `aiProxy` / `hotBoardRefresh`, and a 60s function timeout.
- **Adding a vendor for good**: ① add an entry to `llm.vendors` in the client `public.ts` (its `key` must match a cloud `VENDORS` key); ② add a matching entry to the `VENDORS` registry in **both** copies of `llm.config.js` (`aiProxy` and `hotBoardRefresh` — they must stay word-for-word identical, because each WeChat cloud function is packaged separately and a cross-directory `require` breaks after deploy; case 07 pins them); ③ add that vendor's key variable to `.env` and `cloudbaserc.json`.

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

### 2. Deploy cloud functions (12)

Fill in the **Bocha key plus each external vendor's key** in `.env` (the default vendor **CloudBase AI** uses the CloudBase AI channel — zero key, nothing to configure); skip one and that vendor simply will not appear in "Profile":

```
BOCHA_API_KEY=...
SERPER_API_KEY=...      # optional: 2nd search source (Google index; 2500 free, no credit card)
TAVILY_API_KEY=...      # optional: alternative 2nd source (LLM-oriented; 1000/mo, no card)
DEEPSEEK_API_KEY=...
DASHSCOPE_API_KEY=...   # Qwen (Alibaba Cloud Bailian)
ZHIPU_API_KEY=...
MOONSHOT_API_KEY=...    # Kimi
```

**Which vendors users can see is decided by cloud readiness** (a vendor in `llm.vendors` in `src/config/public.ts` appears in "Profile" only once its key is configured; CloudBase AI is always present); see [Configuration](#configuration) §3.

```bash
npm i -g @cloudbase/cli     # once
tcb login                   # once
cd celebrity-radar/celebrity-radar
tcb fn deploy aiProxy       -e <your-env-id>
```

`cloudbaserc.json` already declares the functions, environment variables and timers, so deploy each one with `tcb fn deploy <name>`.

- **`aiProxy`** — platform-paid upstream keys (`search` / `chat` / `generate` / `aux` / `test` / `vendors`) + **server-side gates** (membership read from `memberships`; daily caps from `quota.config.js`; anti-abuse counter incremented in place in `ai_calls`; thicker retrieval gated by `count`; **non-member quality tiers silently dropped back to Basic**) + a chat output cap applied to **every** request (see `chatMaxTokens`) + the **shared cache write port** (`action:'report'`: `acquire` / `release` / `save` / `saveFeed`); **the vendor + quality tier come from the client request** (user-selectable), the cloud resolves the capability slot by purpose and only falls back with `LLM_VENDOR` / `LLM_TIER` when the client sends nothing / an unknown value. Trigger: client call; environment variables: `BOCHA_API_KEY` + each vendor's key (`DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY`; **the default vendor CloudBase AI needs no key**) + `SERPER_API_KEY` / `TAVILY_API_KEY` (optional: second search source — fill any one; without either, Bocha only) + optional overrides `LLM_VENDOR` / `LLM_TIER` / `LLM_MODEL_<VENDOR>_<QUALITY>_<CAPABILITY>` / `LLM_HTTP_ENDPOINT_<VENDOR>` + `AI_PROXY_TEST_TOKEN` (optional: token for the `test` probe — **unset means that action is always rejected**) + `AI_PROXY_RAW_LOG` (optional: cloud-side raw payload logging — **only `on` enables it**; logs live in the CloudBase console) + `AI_PROXY_QUOTA_GUARD` / `AI_PROXY_CHAT_DEADLINE_MS` / `AI_PROXY_AUX_DEADLINE_MS` (optional)
- **`quotaGuard`** — authoritative quota counting (atomic increments with server dates): `refresh` / `generate` / `ask`. Trigger: client call; environment variables: —
- **`contentCheck`** — content moderation via `security.msgSecCheck`, applied to AI questions. Trigger: client call; environment variables: —
- **`hotBoardRefresh`** — builds the daily hot board (writes `hot_board`). Trigger: cron 06:30; environment variables: `BOCHA_API_KEY` + each vendor's key (optional overrides such as `LLM_VENDOR` / `LLM_TIER` / `LLM_HTTP_ENDPOINT_<VENDOR>`; a cron job has no client preference, so it takes `LLM_VENDOR`, CloudBase AI by default — **zero key works**)
- **`notifyFollowUpdates`** — pushes follow-update subscription messages. Trigger: cron 09:00 (**client calls rejected**); environment variables: `BOCHA_API_KEY` `SUBSCRIBE_TEMPLATE_ID`
- **`keywordAlert`** — keyword alerting (searches subscribed keywords, writes `keywords`). Trigger: cron 09:20 (**client calls rejected**); environment variables: `BOCHA_API_KEY` `ALERT_TEMPLATE_ID`
- **`riskWatch`** — person risk monitoring (searches per monitored person, writes `risk_signals` and pushes). Trigger: cron 09:40 (**client calls rejected**); environment variables: `BOCHA_API_KEY` `RISK_TEMPLATE_ID`
- **`payCreate`** — membership order creation (server-side pricing + cloud pay unified order). Trigger: client call; environment variables: `WX_PAY_SUB_MCH_ID` `PAY_CALLBACK_ENV_ID`
- **`payCallback`** — the payment pipeline's **only backend**: payment notification (amount verification + idempotent renewal) + **after-sales** (refund ops write port `adminOp:'refund'` / manual reconcile `adminOp:'reconcile'`). Trigger: WeChat Pay callback (**client calls gated**, see below) + the `payReconcile` cron (minute 15 of every hour); environment variables: `PAY_ADMIN_TOKEN` (write-port token; unset means the port is always rejected) + `PAY_CALLBACK_GUARD` (optional rollout switch)
- **`dbInit`** — ops tool: create collections, compare fields, create/update indexes (never called by the client). Trigger: manual; environment variables: `DB_ADMIN_TOKEN` `WX_APPID` `WX_APPSECRET`
- **`userInit`** — the **single writer** for user accounts and personal settings (first-login init of the `users` row + back-filling missing keys + setting changes; `action:'ensure'` / `'set'`). Trigger: called by the client after login (**falls back to local client init on failure**); environment variables: —; run `npm run config:sync` to generate the `user-defaults.config.js` copy before deploying
- **`userBackfill`** — one-off ops: back-fills settings for existing users that "wrote `settings:{}` before the migration and never logged in since" (same semantics as `userInit.ensure`, idempotent; **rejects client calls**; a dry-run unless `apply:true` is passed). Trigger: manual; environment variables: —; delete it when done

Common pitfalls:

- **Whether config ships with a deployment depends on how you deploy**: `tcb fn deploy` (CloudBase CLI) reads the root `cloudbaserc.json` and applies environment variables, timeouts and triggers; uploading with "Upload and Deploy" in WeChat DevTools **uploads code only**, so you must set environment variables, timeouts and triggers in the console yourself.
- `aiProxy`, `hotBoardRefresh` and `notifyFollowUpdates` must have a **60-second timeout** (`aiProxy` additionally requires the smaller `CHAT_DEADLINE_MS = 45s` / `AUX_CHAT_DEADLINE_MS = 20s` — a **wall-clock deadline the function imposes on itself**: on hitting it, the call is aborted and returns an ordinary retryable failure instead of being silently killed by the platform), otherwise long reports, the hot board's "6 searches + 1 generation" round, and up to 20 searches per push round are cut off early by the platform (`-504003` on the client). ⚠ **60 seconds is the ceiling for WeChat cloud functions**: if the console already says 60 and you still get `-504003`, a single unit of work is itself exceeding 60 seconds — there is no larger timeout to set, so switch tiers (the Premium tier is the slowest) or split the work further.
- `dbInit` is an **ops tool, not a runtime dependency**: start with `{ "action": "report" }` for a read-only audit; write actions require `DB_ADMIN_TOKEN` (otherwise they are rejected); delete the function when you are done (see step 3).
- `contentCheck` needs no environment variables (it uses cloud calls with platform-managed credentials); the only requirement is that `permissions.openapi` in `cloudfunctions/contentCheck/config.json` **takes effect on upload**. Without that declaration the client **fails open**. ⚠ It cannot be verified with the console's "cloud test" (which requires a real `openid`) — test it in the Q&A page on a real device.
- **The client cannot trigger scheduled jobs or payment callbacks (caller gate)**: once deployed, any cloud function can be reached from the client via `wx.cloud.callFunction`, yet the four scheduled push functions (`notifyFollowUpdates` / `keywordAlert` / `riskWatch`) and `payCallback` should never be called from the client. The test is `getWXContext().OPENID` (present for client calls, absent for timers / WeChat callbacks / the console's "cloud test"). The first three **reject client calls outright**; `hotBoardRefresh` keeps the client's `action:'ensure'` cold-start path and **only blocks client `force`**; `payCallback` uses `PAY_CALLBACK_GUARD` as a **rollout switch** — the default `log` only records, so switch to `strict` after real-device logs confirm callbacks carry no `openid` (even if that judgement is wrong, reconcile back-fills stuck `granting` orders, so no order is lost forever).

**There is no mandatory install list — deploy what you need** (skipping a function does not affect the others):

- **Required**: `aiProxy` — report generation / retrieval / AI Q&A all go through it.
- **Recommended (effectively required)**: `quotaGuard` — the server-side gates read the counters it writes; skip it and the three quota collections stay empty, so the daily caps effectively do not exist in the cloud (the client still enforces them, but that is exactly the half a repackaged client can bypass). Step 3 states the deployment order you must follow. Also recommended: `userInit` — the single writer for the `users` row and personal settings; skip it and the client falls back to local init and settings are not synced to the cloud.
- **Optional**: `contentCheck` (moderation; fails open, so skipping it only drops one compliance fallback), `hotBoardRefresh` (daily hot board, timer 06:30), `notifyFollowUpdates` / `keywordAlert` / `riskWatch` (three subscription pushes, each needs its own template + timer), `payCreate` / `payCallback` (membership payments, needs your own merchant account).
- **Ops tools**: `dbInit` / `userBackfill`, delete them when you are done.

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

- **Request domains**: **not needed** — the client never calls an upstream domain directly. Bocha search and all LLM vendors are proxied by cloud functions, and cloud-function egress is not subject to the mini program domain allowlist (the cloud database / functions go through `wx.cloud` and need no domain either)
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
| Subscription pushes never arrive (43101) | The scheduled jobs share one template | `SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID` in `.env` (the single source) must be **three different** templates; rebuild the client and redeploy the functions after changing them |
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
│   ├── config/                 # benefits.ts (benefits & pricing truth) / public.ts (shared) / local.ts (local, untracked) / domains / hot / filters / notices
│   ├── stores/                 # zustand stores
│   ├── styles/                 # Theme variables, tab-bar icons
│   └── custom-tab-bar/         # Custom bottom tab bar
├── cloudfunctions/             # 12 cloud functions
│   ├── aiProxy/                # Upstream key proxy + member / quota / rate gates (test / search / chat / generate / aux / report writes)
│   ├── quotaGuard/             # Authoritative quota counting (atomic increments + server dates)
│   ├── contentCheck/           # Content moderation (cloud call)
│   ├── payCreate/              # Order creation (server-side pricing + cloud pay order)
│   ├── payCallback/            # Payment notification + after-sales (refund port / reconcile, cron :15; after-sales.js)
│   ├── notifyFollowUpdates/    # Follow-update subscription messages (cron 09:00, client calls rejected)
│   ├── keywordAlert/           # Keyword alerting (cron 09:20, client calls rejected)
│   ├── riskWatch/              # Person risk monitoring (cron 09:40, client calls rejected)
│   ├── hotBoardRefresh/        # Daily hot board (cron 06:30; client may `ensure`, `force` is ops-only)
│   ├── dbInit/                 # Ops tool (schema.js is the schema source of truth)
│   ├── userInit/               # Single writer for the users row & personal settings (first-login init + back-fill + set)
│   └── userBackfill/           # One-off ops: back-fill settings for existing users (rejects client calls)
├── test/                       # Local unit tests (14 case files / 688 cases)
├── scripts/                    # Repo scripts (sync-config.js: benefits / user-config truth → cloud-function copies)
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
- **`llm.ts`** — LLM calls, always proxied by `aiProxy`; the client reports only a **vendor + quality tier** (both resolved from the local preference plus `public.ts`), and the **capability slot is decided in the cloud by purpose** (report / auxiliary → structured, Q&A → reasoning); a non-member requesting a member tier always falls back to Basic
- **`member.ts` / `member-sample.ts`** — the membership benefit table (single source of truth), member checks and the report page's member value copy; the "real sample" in the membership center (excerpted verbatim, and omitted when nothing qualifies)
- **`pay.ts`** — membership payments: fetch server plans (24h local cache + offline fallback) + create order + open checkout + poll for confirmation (price and duration come from the **server only**)
- **`qa.ts`** — AI Q&A: passage selection from the report, an extra web search per question, a daily quota gate counted only on success, and a 3-second tap interval
- **`weekly.ts`** — weekly digest: material read from `feed_cache` only, the LLM writes text only (people and items follow the material), cached locally per ISO week
- **`hot-board.ts` / `explore.ts`** — hot board with three-level fallback; "figure of the day" and random exploration (stable seeds, xorshift32 to remove modulo bias)
- **`keyword-alert.ts` / `keywords.ts`** — keyword subscriptions and alert items; keyword / frequent-phrase aggregation (reused by the compare page's "shared topics" and the topic digest; pure client-side aggregation, effective immediately for cached reports)
- **`risk-watch.ts` / `risk.ts`** — person risk monitoring subscriptions and signal grouping; the fact-level risk radar list on the report page (both share one dictionary, held in sync by a test)
- **`topic-digest.ts` / `compare.ts` / `stats.ts` / `trend.ts`** — topic catalog / two-person comparison / profile stats tab / the favorites-page trend curve — all aggregated on the client, adding no schema fields or cloud functions
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
- **Cost control**: shared report cache, ≤ 10 feed refreshes (20 for members) and ≤ 3 generations per account per day (30 for members), a `building` mutex to prevent duplicate concurrent generation, and weekly digests cached per calendar week
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
npm test          # compile tests with tsc, then run everything (688 cases, fully local, no cloud)
npm run test:only # skip tsc and run directly
```

The suite adds **no dependencies** (a hand-written in-memory CloudBase plus Taro / `wx` stubs and a minimal assertion library) and asserts against the **compiled product code itself**.
It needs no cloud environment, no DevTools and no network. It does not cover page rendering, on-device interaction, cloud-function execution, or payments and push.

Before submitting a change, confirm these six:

1. `npm test` is green (currently 688 / 688)
2. `npx tsc --noEmit` reports no new warnings
3. The mini program **main package size** is within the hard 2MB limit (the current build output is about 1.3MB); check the build output before adding dependencies
4. `src/config/local.ts` and the `debug` flags are **not** committed (already in `.gitignore`)
5. Schema changes come with matching updates to `cloudfunctions/dbInit/schema.js` (the single source of truth)
6. Benefits / pricing changes come with a `npm run config:sync` run (source and cloud copies drifting apart turns `npm test` red)

---

## FAQ

| Question | Answer |
|---|---|
| Can I just run it? | It compiles. To exercise generation you need a **CloudBase environment + a Bocha key**; the default LLM vendor is the **zero-key CloudBase AI** (works out of the box), and external vendors (DeepSeek / Zhipu GLM / Kimi / Qwen) need their keys configured — a vendor only appears once it is configured, see [Configuration](#configuration) §3 |
| Will it cost money? | Yes. Search and LLM calls are metered — the quota, cache and cooldown mechanisms exist precisely to contain that |
| Can I use it commercially? | The license allows it, but **launching requires your own entity qualifications, category filing and AI-content compliance measures** |
| Does the membership payment work? | The code is complete (`payCreate`, `payCallback`, the `PLANS` price map) but needs your own WeChat Pay merchant account; without it the client says so explicitly and free features keep working |
| Can I keep the brand? | "Celebrity Radar" belongs to the original author; please rename before publishing a fork to avoid confusion |
| Why is commercial code included? | It is a complete reference implementation: a single price source, a read-only client, and cloud-side enforcement — the reasoning is documented in the comments |
| Which LLMs are supported and can users choose? | The client offers **5 vendors** (including the zero-config default **CloudBase AI**): CloudBase AI / DeepSeek / Zhipu GLM / Kimi / Qwen, and the user picks a **vendor and a quality tier** (Basic / Standard / Premium) under "Profile → Model vendor & quality tier", with the platform paying for the keys in the cloud function. Vendor variable names, setup steps and the cost of a missing key are in [Configuration](#configuration) §3 |
| How hard is it to swap upstreams? | The vendor list users may pick lives in `llm.vendors` in `src/config/public.ts`; the cloud registry (endpoints / key variable names / per-tier capability slots) is the `VENDORS` / `QUALITIES` in `cloudfunctions/aiProxy/llm.config.js` (with a **word-for-word identical** copy in `hotBoardRefresh`, pinned by case 07 — change both). Adding one = one entry on each side + one environment variable |

**Upstream risk**: the search provider (Bocha) and the LLMs (CloudBase AI / DeepSeek / Qwen / Zhipu GLM / Kimi, the external four being OpenAI-compatible endpoints) are third-party paid services;
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
5. When touching `llm.config.js` (the two word-for-word identical `VENDORS` / `QUALITIES` copies, pinned by case 07), change both copies
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

- Upstream services: Tencent CloudBase (WeChat Cloud Development, including the default CloudBase AI channel), Bocha search, several selectable LLM vendors (CloudBase AI / DeepSeek / Zhipu GLM / Kimi / Qwen, the external four being OpenAI-compatible endpoints), WeChat Pay
- Open-source dependencies: Taro, Taro UI, React, zustand, zod, dayjs and others, each owned by its respective authors

**Disclaimer**: this project is intended for technical learning and exchange. You are responsible for any consequences of using it,
including upstream API costs, content compliance and data-security obligations. The "Celebrity Radar" name and brand belong to the original author.

