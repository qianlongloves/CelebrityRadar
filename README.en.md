# Celebrity Radar

**English** · [简体中文](./README.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Taro](https://img.shields.io/badge/Taro-3.6-07c160.svg)](https://taro-docs.jd.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-243%20passing-success.svg)](#development--testing)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> A **celebrity intelligence mini program** for the WeChat ecosystem: type any public figure's name → the app searches recent public coverage online → an LLM turns it into a structured report (bio / profile / activity / quotes / commentary / controversies & responses / timeline / glossary…), with a keyword cloud, sentiment trend and heat curve aggregated on the client.

- Stack: Taro 3 (React) + Taro UI ｜ Backend: Tencent CloudBase (WeChat Cloud Development)
- License: [Apache-2.0](./LICENSE) ｜ Changelog: [`CHANGELOG.md`](./CHANGELOG.md)
- Repository: [gitee.com/qianlonglove_admin/celebrity-radar](https://gitee.com/qianlonglove_admin/celebrity-radar) ｜ 中文说明: [`README.md`](./README.md)
- Deploy from scratch: see [Getting Started](#getting-started) and [Deployment](#deployment); before contributing, read [`CONTRIBUTING.md`](./CONTRIBUTING.md)

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

A complete, compilable WeChat mini program: 19 pages on the client, 9 cloud functions and 14 database collections on the server,
covering the full chain of *search → disambiguation → retrieval → generation → caching → follow / favorite / share / Q&A / compare*.

It is built around two principles:

1. **Usable without paying** — cached reports can be viewed unlimited times; following, favorites, history and the hot board are all free, with no paywall.
2. **No wasted upstream spend** — reports are a **globally shared cache** (one generation per person, reused by every user), a `building` flag acts as a cross-device generation mutex,
   cooldowns only block failures *worth waiting for*, and quota counting lives on the server. Together these keep upstream cost predictable.

> ⚠️ **This is complete source code, not a turnkey product.**
> The repository contains **no usable credentials**: the appid, the CloudBase environment ID and all upstream API keys are placeholders you must supply yourself.
> The three things needed to exercise the real flow are listed in [Getting Started](#getting-started).

---

## Features

| Area | Module | Capability |
|---|---|---|
| **Content** | Discovery & disambiguation | Search box + popular-domain cards; candidate list for homonyms (with domain filters) plus a "none of them" fallback, producing a stable `personKey` (e.g. `雷军#tech`) |
| | Report generation | Bocha web search → LLM produces structured JSON → zod validation of every field + source-URL allowlist sanitization; **rendered card by card** (bio / profile / relationship map / recent activity / notable quotes / AI commentary / controversies & responses / timeline / what to watch / glossary + a one-line source summary), skeleton loading with progressive reveal, and a "generated N ago / refresh" pair of entry points; every factual section must cite a real piece of material — anything unsourced is dropped entirely, and a section that is genuinely empty still renders a card explaining why |
| | Client-side aggregates | Profile snapshot, stance & sentiment, keyword cloud, quote themes, and a heat-trend curve — **computed entirely on the client**, so existing cached reports benefit immediately with zero extra model calls or quota usage |
| | Quote sourcing | Verifies only *verifiable* facts (is this quote's source link part of the retrieved material; does that article contain the same wording) — it does **not** render AI verdicts on authenticity |
| **Reading & saving** | Following | Follow list + change overview (who has news) + merged feed (`feed_cache` merged with pull-to-refresh, capped at 10 refreshes per account per day) |
| | Weekly digest | One tap summarizes the last 7 days across followed figures → per-person highlights + weekly overview + topic words; material comes from cache and **people and items follow the material**, cached locally per ISO week |
| | Favorites / History | Four favorite types (quotes / reports / activity / timeline, deduplicated by an `openid#type#hash` key) + browsing history (last 50 entries); quotes in Favorites can be rendered as a shareable card |
| | Message center | A single timeline: follow updates / weekly reminders / announcements / keyword alerts; read state is tracked **per item** and stored on-device only (no new collection, cloud function or model call) |
| | Sharing | Quote cards (rendered on-device with Canvas 2D, never uploaded to cloud storage) + native forwarding; every landing page is a specific person's report |
| **Exploration** | Hot board | Produced daily by AI (`hot_board`) with a three-level fallback (AI board → cached reports → static list); **every rank is visible to everyone**, never gated |
| | Keyword alerts | Subscribe to keywords → a scheduled cloud function searches them daily → the app lists items *added since you last looked* and pushes a subscription message |
| | Topic knowledge base | Pivots the person-centric report cache into a topic-centric view: for one topic, who is talking about it, what was said, which articles exist and when it was discussed |
| | Compare | Side-by-side comparison of two figures (reusing both cached reports, zero model calls), with one-tap follow / share |
| | AI Q&A | Answers grounded in the figure's **cached report**, flattened into numbered passages (ordered by reliability, selected by Chinese bigram overlap); each question triggers one extra web search that shares the same budget, and falls back silently to "report-only" answers when search is unavailable |
| **Membership (freemium)** | Quota | Free tier: 3 on-demand generations per day, 30 for members (cache hits never count); AI Q&A: 5 questions free, 30 for members; quota is displayed transparently on the profile page |
| | Quality perks | **User-selectable model provider** (DeepSeek / Qwen / Zhipu GLM / Moonshot — keys all live in the cloud function, so users configure nothing) + model tier (free tier is locked to the fast model; members unlock standard / deep reasoning; switching provider swaps the whole tier list while the tier you picked stays the same) plus a **deep report mode** (thicker retrieval plus three member-only sections: comparison angles, risk notes, source disagreements) |
| | Pricing | ¥9.9 monthly / ¥25 quarterly / ¥68 yearly; the price has **a single source of truth** (the `PLANS` map in the `payCreate` cloud function, fetched by the client, so changing prices needs no release) |
| **Platform** | Compliance | A local sensitive-name list blocks requests up front (rejected without **any** network call), source URLs are allowlisted, and every report notes "AI-generated, for reference only" |
| | Zero client-side secrets | All upstream calls are proxied by cloud functions; quota counting is server-side (atomic increments with server dates); membership gating is enforced in the cloud and cannot be bypassed by a repackaged client |

---

## Screenshots

> All images below are **on-device screenshots** (iPhone), grouped by feature; the caption under each one states the point of that page.
> Images live in `assets/screenshots/` — **replacing a file with the same name updates this section**, no change to the references below.

**Discovery & search**

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/01-home.png" width="200" alt="Home"><br><sub><b>Home</b> · search entry / featured domains / today's hot</sub></td>
    <td align="center"><img src="./assets/screenshots/02-search.png" width="200" alt="Search and disambiguation"><br><sub><b>Search &amp; disambiguation</b> · same-name candidates + domain filters</sub></td>
    <td align="center"><img src="./assets/screenshots/03-hot-board.png" width="200" alt="Hot board"><br><sub><b>Hot board</b> · AI-generated daily, every rank visible to everyone</sub></td>
  </tr>
</table>

**Following & messages**

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/04-feed.png" width="200" alt="Following feed"><br><sub><b>Following feed</b> · merged stream + pull to refresh</sub></td>
    <td align="center"><img src="./assets/screenshots/05-following.png" width="200" alt="Follow list"><br><sub><b>Follow list</b> · change overview: who has news</sub></td>
    <td align="center"><img src="./assets/screenshots/07-message-center.png" width="200" alt="Message center"><br><sub><b>Message center</b> · updates / weekly digest / alerts in one timeline</sub></td>
  </tr>
</table>

**Explore & Q&amp;A**

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/06-keyword-alert.png" width="200" alt="Keyword alerts"><br><sub><b>Keyword alerts</b> · only entries added since your last visit</sub></td>
    <td align="center"><img src="./assets/screenshots/08-qa.png" width="200" alt="AI Q&amp;A"><br><sub><b>AI Q&amp;A</b> · answers from your cached reports, with numbered sources</sub></td>
  </tr>
</table>

**Membership &amp; configuration**

<table>
  <tr>
    <td align="center"><img src="./assets/screenshots/09-mine.png" width="200" alt="Profile"><br><sub><b>Profile</b> · quota shown transparently / membership perks</sub></td>
    <td align="center"><img src="./assets/screenshots/10-providers.png" width="200" alt="Model providers"><br><sub><b>Model provider of your choice</b> · DeepSeek / Qwen / Zhipu GLM / Moonshot</sub></td>
  </tr>
</table>

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Taro 3.6 (React 18) + TypeScript | Compiled with webpack5 |
| UI | Taro UI 3.x + SCSS (750px design width) | Theme variables in `src/styles/` |
| State | zustand | e.g. `src/stores/auth.ts` |
| Validation | zod | Full-field validation of the report schema |
| Dates | dayjs | Relative time, ISO weeks, quota date keys |
| Backend | Tencent CloudBase (WeChat Cloud Development) | Database + cloud functions; environment ID comes from local config |
| Search | Bocha `api.bochaai.com` | Proxied by the `aiProxy` cloud function |
| LLM | OpenAI-compatible endpoint | Defaults to `https://api.deepseek.com/v1`; selectable providers and their three tiers are in `src/config/public.ts`, while endpoints / key variable names / member tiers are in `cloudfunctions/aiProxy/llm.config.js` |

> Dependencies are installed with `legacy-peer-deps=true` from `.npmrc`; `@tarojs/plugin-platform-*` is pinned to `^3.6.25` (do not upgrade) and webpack to `~5.91.0`.

---

## Architecture & Core Flow

```
User enters a name
  → local sensitive-name check (rejected without any request)
  → LLM disambiguation → candidate selection → personKey
  → report_cache hit? ──yes→ render directly (no generation triggered)
       │no
       └→ Bocha web search (api.bochaai.com) → source material
          → OpenAI-compatible LLM produces structured JSON → zod validation + URL allowlist
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
cloudfunctions/**         9 cloud functions (secrets, quota, moderation, scheduled jobs, payments)
     ↓
Upstream: Bocha search / LLM / WeChat Pay / security.msgSecCheck
```

Two mechanisms worth knowing:

- **`report_cache.state = building` acts as a cross-device generation mutex**: when two clients request the same person concurrently, only one performs the generation while the other waits for the result.
- **A cache hit always wins over cooldown and quota**: hits render immediately without consuming quota or being blocked by cooldowns.

---

## Getting Started

### Requirements

- Node 16 / 18 (LTS recommended)
- WeChat DevTools
- A mini program appid with Cloud Development enabled

### Install & Run

```bash
git clone https://gitee.com/qianlonglove_admin/celebrity-radar.git
cd celebrity-radar/celebrity-radar

cp src/config/local.example.ts src/config/local.ts   # required, otherwise the build fails with "Cannot find module './local'"
npm install                                           # legacy-peer-deps is enabled in .npmrc

npm run dev:weapp      # development (watch, output in dist/)
npm run build:weapp    # production build, output in dist/
npm run build:h5       # H5 build (for debugging)
npm test               # local unit tests, no cloud environment needed
```

Open the `celebrity-radar/` directory in WeChat DevTools (`miniprogramRoot: dist/`, `cloudfunctionRoot: cloudfunctions/`).
During development you can enable "do not verify valid domains" to iterate before the domains are approved.

### Three things you must supply to exercise the real flow

| What you need | Purpose | Without it |
|---|---|---|
| CloudBase environment ID | Hosts the database and all 9 cloud functions | Login and **all** database calls are never issued; the profile page shows "cloud service not configured" |
| `DEEPSEEK_API_KEY` | Generates reports (via the `aiProxy` cloud function). Users may switch to another provider under "Profile", so **every provider you list needs its key** (`QWEN_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`); without it, switching to that provider fails with "no quota configured" | Generation fails; browsing and favoriting cached reports still works |
| `BOCHA_API_KEY` | Retrieves source material online | Empty retrieval, so reports lack material and the timeline is incomplete |

The full checklist (permissions, indexes, scheduled jobs, launch compliance) is in the [Deployment](#deployment) section below.

---

## Configuration

### 1. Client config: `public.ts` (shipped) + `local.ts` (local only)

| File | Committed | Contents |
|---|---|---|
| `src/config/public.ts` | ✅ | Deployment-independent settings: the selectable **provider** list with each provider's three tiers, plus `memberOnly` flags. **Never put any key here** (keys live in cloud function environment variables; switching provider only changes request parameters) |
| `src/config/local.example.ts` | ✅ | Template for local config, all values are placeholders |
| `src/config/local.ts` | ❌ (in `.gitignore`) | Your own real values: environment ID, subscription template IDs, webview domain allowlist, local debug switch |

`local.ts` (created by copying `local.example.ts` after cloning):

| Field | Description |
|---|---|
| `cloudbaseEnvId` | CloudBase environment ID. While it stays at the placeholder, the cloud service counts as unconfigured and no login or DB call is issued |
| `subscribeTemplateId` | Template ID for follow-update subscription messages; must match the `SUBSCRIBE_TEMPLATE_ID` environment variable of the cloud functions |
| `alertTemplateId` | Template ID for keyword alerts; **it must differ from the one above**: WeChat one-time subscription grants are consumed **per template**, so sharing one template between two scheduled jobs means the first job consumes the grant and the second always fails with 43101 |
| `webviewDomains` | Allowlist of domains the "original article preview" page may embed; leave empty to always fall back to a preview card plus a copy-link action |
| `debug` | Local debug switch (opens quota gates and upstream cooldowns). **All five flags default to false**, enable only for local integration work |

`public.ts`:

| Field | Description |
|---|---|
| `llm.providers` | Selectable **providers**: each has an `id` (must match a `PROVIDERS` key in the cloud function's `llm.config.js`), a display name, and `models` (the same three tiers everywhere: `fast` / `standard` / `reason` = Turbo / Standard / Deep Reasoning). **List only the providers whose keys you configured in the cloud** — whichever one a user picks, the cloud function pays with that provider's key and the client holds no credentials |
| `llm.provider` / `llm.model` / `llm.models` | Default provider, its default model, and its tier list (the latter two equal `providers[0]`'s fast tier and `providers[0].models`). Tier labels are identical across providers, so membership copy can be derived from them — adding a provider changes no wording |
| `models[].memberOnly` | `true` = members only: free users fall back to that provider's Turbo tier even if they picked it locally. **Changing this flag requires updating `memberOnlyModels` for the matching provider in the `aiProxy` cloud function's `llm.config.js`** — that copy is the real billing gate (the client copy can be bypassed by repackaging) |

> A user's provider / tier choice lives in local storage only (`settings:llm_provider` + `settings:llm_tier`).
> What is stored is the **tier id**, not the model name, so switching provider keeps "the tier I picked"
> (DeepSeek Standard → Qwen Standard) without asking the user to choose again; the tier list itself is
> replaced wholesale by the new provider's three tiers — that is what "switching provider switches the tier parameters" means.

> Both files are bundled into the mini program, so **never** put real keys in them.
> They are split so that a real environment ID in the repository does not make forks connect to the original author's cloud environment,
> and so that the author's local `debug: true` edits in `public.ts` cannot be committed by accident.
> ⚠️ **All five `debug` flags must be false before release**, otherwise free-tier limits (3 generations / 5 questions per day) and the 429 cooldown protection are disabled.

### 2. Secret ownership: server-side only, zero client secrets

| Item | Location |
|---|---|
| Search / LLM keys | Environment variables of the `aiProxy` cloud function: `BOCHA_API_KEY` plus each provider's key (`DEEPSEEK_API_KEY` / `QWEN_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY`). **Every provider listed in the client config must have one** |
| Deploy-time secret source | `celebrity-radar/.env` (copied from `.env.example`, **not committed**), referenced from `cloudbaserc.json` as `${env.XXX}` |

Every request is proxied through a cloud function; the client holds no keys and users need no setup. An older build-your-own-key (BYOK) direct mode was **removed entirely**.

### 3. Domains & console setup

- Request domains: `https://api.bochaai.com`, `https://api.deepseek.com` (the cloud database goes through `wx.cloud` and needs no domain)
- Enable customer service in the console and bind staff (reports and feedback rely on `open-type="contact"`)
- Configure the privacy policy (collected: anonymous openid, local storage)

---

## Deployment

> Below you will find every item to prepare and the pitfalls to avoid, ordered as
> **cloud functions → database → timers → mini program**. The order matters: without collections and permissions
> in place first, reads and writes inside functions fail silently.
> The repository's `doc/` directory holds the author's internal documents and is **not distributed with the repo**,
> so it is not referenced here; everything you need is covered below.

### 1. Cloud functions (9)

`cloudbaserc.json` declares the functions, environment variables and timers; fill the keys into `.env` before deploying (template in `.env.example`).

| Function | Role | Trigger | Environment variables |
|---|---|---|---|
| `aiProxy` | Platform-paid upstream keys (`test` / `search` / `chat`) + member model gate (thicker retrieval is gated by `count`) + a chat output cap applied to **every** request (see `chatMaxTokens`); **the provider comes from the client request** (user-selectable), the cloud only falls back | Client call | `BOCHA_API_KEY` + each provider's key (`DEEPSEEK_API_KEY` `QWEN_API_KEY` `ZHIPU_API_KEY` `MOONSHOT_API_KEY`) |
| `quotaGuard` | Authoritative quota counting (atomic increments with server dates): `refresh` / `generate` / `ask` | Client call | — |
| `contentCheck` | Content moderation via `security.msgSecCheck`, applied to AI questions | Client call | — |
| `hotBoardRefresh` | Builds the daily hot board (writes `hot_board`) | Cron 06:30 | `BOCHA_API_KEY` + the provider it uses (a cron job has no client preference, so it takes `LLM_PROVIDER`, DeepSeek by default) |
| `notifyFollowUpdates` | Pushes follow-update subscription messages | Cron 09:00 | `BOCHA_API_KEY` `SUBSCRIBE_TEMPLATE_ID` |
| `keywordAlert` | Keyword alerting (searches subscribed keywords, writes `keywords`) | Cron 09:20 | `BOCHA_API_KEY` `ALERT_TEMPLATE_ID` |
| `payCreate` | Membership order creation (server-side pricing + cloud pay unified order) | Client call | `WX_PAY_SUB_MCH_ID` `PAY_CALLBACK_ENV_ID` |
| `payCallback` | Payment notification (amount verification + idempotent renewal) | WeChat Pay callback | — |
| `dbInit` | Ops tool: create collections, compare fields, create/update indexes (never called by the client) | Manual | `DB_ADMIN_TOKEN` `WX_APPID` `WX_APPSECRET` |

Common pitfalls:

- **Whether config ships with a deployment depends on how you deploy**: `tcb fn deploy` (CloudBase CLI) reads the root `cloudbaserc.json` and applies environment variables, timeouts and triggers; uploading with "Upload and Deploy" in WeChat DevTools **uploads code only**, so you must set environment variables, timeouts and triggers in the console yourself.
- `aiProxy`, `hotBoardRefresh` and `notifyFollowUpdates` must have a **60-second timeout** (`aiProxy` additionally requires the smaller `LLM_CHAT_TIMEOUT_MS = 50000`), otherwise long reports, the hot board's "6 searches + 1 generation" round, and up to 20 searches per push round are cut off early by the platform (`-504003` on the client).
- `quotaGuard` has no environment variables but **must be (re)deployed before you tighten the quota collections' permissions**; reversing the order makes the client's fallback writes fail and the counters stay at zero, silently disabling the free tier.
- `dbInit` is an **ops tool, not a runtime dependency**: start with `{ "action": "report" }` for a read-only audit; write actions require `DB_ADMIN_TOKEN` (otherwise they are rejected); delete the function when you are done.
- `contentCheck` needs no environment variables (it uses cloud calls with platform-managed credentials); the only requirement is that `permissions.openapi` in `cloudfunctions/contentCheck/config.json` **takes effect on upload**. Without that declaration the client **fails open**. ⚠ It cannot be verified with the console's "cloud test" (which requires a real `openid`) — test it in the Q&A page on a real device.

### 2. Cloud database (14 collections)

A CloudBase document database. The client writes the `id` field; `utils/db.ts` maps it to the system primary key `_id`.

| Collection | Purpose | Permission |
|---|---|---|
| `users` | Account and settings (created on first login; `membership` is written by the payment callback and read-only for the client) | Creator only |
| `report_cache` | Report cache + `building` generation mutex (globally shared, long-lived) | Read: everyone; write: signed-in users |
| `feed_cache` | Structured mapping of retrieval results (no LLM output stored) | Read: everyone; write: signed-in users |
| `hot_board` | Hot board (written daily by AI, always at `_id = latest`) | Read: everyone; client cannot write |
| `keywords` | Keyword retrieval cache (globally shared) | Read: everyone; client cannot write |
| `refresh_quota` | Feed refreshes, ≤ 10 per day (`openid#yyyy-MM-dd`) | Owner reads; writes via cloud functions only |
| `generate_quota` | Daily report generation quota (3 free / 30 member) | Owner reads; writes via cloud functions only |
| `ask_quota` | Daily AI question quota (5 free / 30 member, counted only on success) | Owner reads; writes via cloud functions only |
| `orders` | Membership order state machine (`pending → paid` / `failed`) | Owner reads; writes by payment functions only |
| `follows` | Follow list (`openid#personKey`) | Creator only |
| `favorites` | Favorites, four types (deduplicated by `openid#type#hash`) | Creator only |
| `history` | Browsing history (last 50) | Creator only |
| `events` | Analytics events | Creator only |
| `keyword_watches` | Keyword subscriptions (`openid#keyword hash`, same shape as `follows`) | Creator only |

Current state of schema and permissions (important for forks):

- **Collections** can be created in one go by the `dbInit` ops function (`cloudfunctions/dbInit/schema.js` is the **single source of truth** for the schema).
- **Permissions must be set by hand in the console** — no API can change collection permissions; configure them per collection using the table above.
- **Indexes can be automated**: `dbInit` creates and updates them through the WeChat HTTP "update index" API, or you can create them manually in the console.
- To see what is still missing, run `dbInit` with `{"action":"report"}`.

### 3. Membership payments (optional)

The code is complete (`payCreate` / `payCallback` plus `utils/pay.ts` and the profile entry point) but requires manual setup:

1. Enable WeChat Pay in the CloudBase console and bind a merchant account;
2. Set `WX_PAY_SUB_MCH_ID` and `PAY_CALLBACK_ENV_ID` on `payCreate`;
3. Deploy `payCallback`.

The callback function name is hard-coded as `functionName: 'payCallback'` inside `payCreate`; **renaming it will break notifications**.
When unconfigured, the client clearly reports "WeChat Pay not configured / payment service not deployed" and free features still work (3 generations per day).

---

## Project Structure

> Paths below are relative to the `celebrity-radar/` subdirectory; the repository root also holds `README.md` / `README.en.md` / `LICENSE` / `NOTICE` / `CHANGELOG.md` / `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / `assets/screenshots/`.
> (`doc/` — the author's internal design and deployment docs — is excluded by `.gitignore` and is **not distributed**.)

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
│   ├── utils/                  # Business logic & cloud access (43 modules, see Core Modules)
│   ├── config/                 # public.ts (shared) / local.ts (local, untracked) / domains / hot / filters / notices
│   ├── stores/                 # zustand stores
│   ├── styles/                 # Theme variables, tab-bar icons
│   └── custom-tab-bar/         # Custom bottom tab bar
├── cloudfunctions/             # 9 cloud functions
│   ├── aiProxy/                # Upstream key proxy + member model gate (test / search / chat)
│   ├── quotaGuard/             # Authoritative quota counting (atomic increments + server dates)
│   ├── contentCheck/           # Content moderation (cloud call)
│   ├── payCreate/              # Order creation (server-side pricing + cloud pay order)
│   ├── payCallback/            # Payment notification (amount check + idempotent renewal)
│   ├── notifyFollowUpdates/    # Follow-update subscription messages (cron 09:00)
│   ├── keywordAlert/           # Keyword alerting (cron 09:20)
│   ├── hotBoardRefresh/        # Daily hot board (cron 06:30)
│   └── dbInit/                 # Ops tool (schema.js is the schema source of truth)
├── test/                       # Local unit tests (3 case files / 219 cases)
├── config/                     # Taro build config (dev / index / prod)
├── cloudbaserc.json            # CloudBase deployment descriptor (functions + env vars + timers)
├── .env.example                # Deployment secret template
├── project.config.json         # WeChat DevTools project (miniprogramRoot: dist/)
└── project.private.config.example.json
```

---

## Core Modules

`src/utils/` is the only exit point for all business logic and cloud access — pages call into it and never touch the database or upstream APIs directly.

| Module | Responsibility |
|---|---|
| `cloud.ts` / `db.ts` | CloudBase initialization and diagnostics; a hand-rolled data-access adapter (`table('x').select/eq/or/upsert/maybeSingle`) with `id ↔ _id` mapping, pagination continuation and write fallbacks |
| `auth.ts` | WeChat login + first-time `users` initialization; concurrent login deduplication, session persistence, stale-cache rejection |
| `search.ts` | Bocha adapter (degrades without a key) normalizing material into `NewsItem`; `searchForAsk` used by Q&A |
| `disambiguate.ts` | LLM homonym disambiguation with a domain-code enum and fallback |
| `report.ts` | Report generation, zod validation, URL allowlist sanitization, plain-text degradation |
| `cache.ts` | `report_cache` read/write with the `building` mutex, plus `feed_cache` and `refresh_quota` |
| `quota.ts` / `quota-guard.ts` | Freemium generation quota and its server-side channel (falls back to local counting when not deployed) |
| `llm.ts` | LLM calls, always proxied by `aiProxy`; the model name is resolved from local preference + `public.ts`, and non-members requesting a member tier fall back to the default model |
| `member.ts` / `member-sample.ts` | The membership benefit table (single source of truth), member checks and the report page's member value copy; the "real sample" in the membership center (excerpted verbatim, and omitted when nothing qualifies) |
| `pay.ts` | Membership payments: fetch server plans (24h local cache + offline fallback) + create order + open checkout + poll for confirmation (price and duration come from the **server only**) |
| `qa.ts` | AI Q&A: passage selection from the report, an extra web search per question, a daily quota gate counted only on success, and a 3-second tap interval |
| `weekly.ts` | Weekly digest: material read from `feed_cache` only, the LLM writes text only (people and items follow the material), cached locally per ISO week |
| `hot-board.ts` / `explore.ts` | Hot board with three-level fallback; "figure of the day" and random exploration (stable seeds, xorshift32 to remove modulo bias) |
| `keyword-alert.ts` / `keywords.ts` | Keyword subscriptions and alert items; keyword cloud and frequent viewpoints (pure client-side aggregation, effective immediately for cached reports) |
| `topic-digest.ts` / `compare.ts` / `stats.ts` / `trend.ts` | Topic catalog / two-person comparison / profile stats tab / heat-trend curve — all aggregated on the client, adding no schema fields or cloud functions |
| `quote-check.ts` / `source-link.ts` | Quote sourcing (verifies only verifiable facts); the single outbound link path for the article preview page |
| `messages.ts` / `notify.ts` | Message-center timeline and its read semantics; WeChat subscription authorization and push placement |
| `share-card.ts` / `share.ts` | Canvas 2D quote cards (no remote images, nothing uploaded) and the project's only share-copy exit |
| `sensitive.ts` / `sec-check.ts` | Local sensitive-name blocking (maintained by hand before each release); content moderation (fails open) |
| Infrastructure | `time.ts` (relative time and the single report-staleness threshold), `cooldown.ts` (10-minute cooldown on 429), `debug.ts` (the single debug-switch exit), `cloud-diagnostics.ts` (structured diagnostic logs), `settings.ts`, `events.ts`, `tabbar.ts`, `data-deletion.ts` |

---

## Security & Compliance

- **Secrets never ship**: only local storage on the client, only cloud-function environment variables on the server
- **Input side**: the local sensitive-name list blocks requests before any network call is made
- **Output side**: `sources` / `dynamics` links are sanitized against an allowlist and must have appeared in the retrieved material
- **Content policy**: every report is labeled "AI-generated, for reference only"; there is a privacy statement page, a reporting entry point and a two-step "delete my data" flow
- **Cost control**: shared report cache, ≤ 10 feed refreshes and ≤ 3 generations per account per day (30 for members), a `building` mutex to prevent duplicate concurrent generation, and weekly digests cached per calendar week
- **Cooldowns only block failures worth waiting for**: only upstream 429s, network errors and 5xx responses trigger the 10-minute cooldown; invalid keys and exhausted quota fail immediately without cooldown, and a cache hit always outranks both
- **Vulnerability reports**: please **do not** open a public Issue — use the private channel described in [`SECURITY.md`](./SECURITY.md).
  For calibration: patching the client so it *displays* a member tier is **not** a vulnerability (the gate lives in the cloud); bypassing the cloud gate is

---

## Development & Testing

```bash
npm test          # compile tests with tsc, then run everything (219 cases, fully local, no cloud)
npm run test:only # skip tsc and run directly
```

The suite adds **no dependencies** (a hand-written in-memory CloudBase plus Taro / `wx` stubs and a minimal assertion library) and asserts against the **compiled product code itself**.
It needs no cloud environment, no DevTools and no network. It does not cover page rendering, on-device interaction, cloud-function execution, or payments and push.

Before submitting a change, confirm:

1. `npm test` is green (currently 219 / 219)
2. `npx tsc --noEmit` reports no new warnings
3. The mini program **main package size** is within the hard 2MB limit (currently about 1.2MB); check the build output before adding dependencies
4. `src/config/local.ts` and the `debug` flags are **not** committed (already in `.gitignore`)
5. Schema changes come with matching updates to `cloudfunctions/dbInit/schema.js` (the single source of truth)

---

## FAQ

| Question | Answer |
|---|---|
| Can I just run it? | It compiles. To exercise generation you need your own CloudBase environment plus DeepSeek and Bocha keys |
| Will it cost money? | Yes. Search and LLM calls are metered — the quota, cache and cooldown mechanisms exist precisely to contain that |
| Can I use it commercially? | The license allows it, but **launching requires your own entity qualifications, category filing and AI-content compliance measures** |
| Does the membership payment work? | The code is complete (`payCreate`, `payCallback`, the `PLANS` price map) but needs your own WeChat Pay merchant account; without it the client says so explicitly and free features keep working |
| Can I keep the brand? | "Celebrity Radar" belongs to the original author; please rename before publishing a fork to avoid confusion |
| Why is commercial code included? | It is a complete reference implementation: a single price source, a read-only client, and cloud-side enforcement — the reasoning is documented in the comments |
| How hard is it to swap upstreams? | The providers users may pick live in `llm.providers` in `src/config/public.ts`; the cloud registry (endpoints / key variable names / member tiers) is `cloudfunctions/aiProxy/llm.config.js` (with a byte-identical copy in `hotBoardRefresh` — change both). Adding one = one entry on each side + one environment variable |

**Upstream risk**: the search provider (Bocha) and the LLM (DeepSeek, an OpenAI-compatible endpoint) are third-party paid services;
their APIs, pricing and availability are outside this project's control.

---

## Known Limitations

- `src/utils/sensitive.ts` must be **updated by hand** before each release to meet current compliance requirements; the code does not update it remotely
- Content moderation (`contentCheck`) uses cloud calls and **fails open** when not deployed or when its permission is not effective (availability over blocking)
- Keyword alerts depend on WeChat **one-time subscription** grants, so template IDs and push timing are constrained by platform rules
- Whether the article preview page can embed content in a webview depends on the domain allowlist and WeChat platform checks; otherwise it degrades to a preview card
- Reports are generated by an LLM and **may contain factual errors** — always check the source links
- Tests cover logic and data layers only, not UI rendering, on-device interaction, cloud-function runtime, or the full payment flow

---

## Contributing

Issues and pull requests are welcome. **The full process, review criteria and Issue template are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md)** (Chinese); the short version:

1. The default branch is `master` — branch off it (`feat/xxx`, `fix/xxx`, `docs/xxx`, `chore/xxx`)
2. Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:` / `fix:` / `docs:` / `chore:` …), one concern per commit
3. Complete the five "before submitting a change" checks above and explain the motivation and verification in the PR description
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
within 7 business days). Before asking, make sure the issue is reproducible and that you have read the known
limitations — many "it does not work" reports are covered there.

If this project helps you, a Star on Gitee is appreciated; adding the pitfalls you hit to the
[FAQ](#faq) is worth more than generic encouragement.

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

- Upstream services: Tencent CloudBase (WeChat Cloud Development), Bocha search, DeepSeek (or any OpenAI-compatible endpoint), WeChat Pay
- Open-source dependencies: Taro, Taro UI, React, zustand, zod, dayjs and others, each owned by its respective authors

**Disclaimer**: this project is intended for technical learning and exchange. You are responsible for any consequences of using it,
including upstream API costs, content compliance and data-security obligations. The "Celebrity Radar" name and brand belong to the original author.

