# Celebrity Radar

> A WeChat mini program: type any public figure's name → search recent public coverage online →
> let an LLM distill it into a structured report; on top of that it offers a following feed / weekly
> digest, AI Q&A, opinion monitoring (keyword alerts / risk watch / event timeline), membership and
> payments, and quote-card sharing. Built with **Taro 3 (React + TypeScript) and WeChat CloudBase**.

[中文](./README.md) | **English**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)

---

## Overview

Celebrity Radar is an "intelligence desk for public figures": **turn a name into a readable,
source-traceable, reusable profile.**

- **Who it's for**: users who want a quick read on a public figure's recent activities, stances, commercial ties, or risk signals.
- **The core flow**: search → disambiguation → multi-source web search → LLM generation → structured report → global cache reuse.
- **Key trade-off**: reports are a **globally shared cache** (generated once per person, reused by all users), which amortizes the cost of a single generation; many on-screen cards are **client-side aggregations** of that cache and add no model calls.

> ⚠ This is **complete, compilable code**, not a product you can put online as-is. The repository ships **no usable credentials**: `appid`, CloudBase environment ID and upstream API keys are all placeholders or empty and must be supplied by you.

> This README lives at the **repository root**; the mini program itself (`package.json`, `src/`, `cloudfunctions/`, etc.) lives in the **`celebrity-radar/` subdirectory**, and the **root has no `package.json`** ⇒ every `npm` command must be run after `cd celebrity-radar`. Paths to files inside the project are written **relative to the repository root**.

---

## Features

Everything below is **present in the code** (pages: `celebrity-radar/src/app.config.ts`; cloud functions: `celebrity-radar/cloudfunctions/`).

**Reports & search**

- **Report generation**: web search → event grouping and batched prompt injection → structured JSON from the LLM → field validation + source-URL allow-list sanitization → card-by-card rendering. Reports are a globally shared cache.
- **Client-side summary cards**: profile / stance & sentiment / risk radar / commercial-value cards — **pure client-side aggregation**, reusing the cache with zero extra model calls.
- **Two-person comparison**: a side-by-side view, read-only from cache, zero model calls.
- **Topic knowledge base**: recatalogs cached reports by topic.
- **Source preview**: the landing page for report material; registered business domains open inline, otherwise it falls back to a material card + copy-link.

**Following & opinion monitoring**

- **Following / feed / weekly digest**: a follow list + change overview + aggregated feed (daily cap on pull-to-refresh); the weekly digest summarizes the last 7 days.
- **Hot board**: an AI-produced daily ranking, fully visible to everyone.
- **Keyword alerts**: subscribe to a keyword → a scheduled cloud function searches daily → the client lists new items (optional push).
- **Person risk watch**: watch a person → daily scheduled search → summarize judicial / tax / contract / rights / statement hits (states hits and sources only; no rating or prediction).
- **Opinion event clustering / timeline**: a scheduled task **reads the DB** to cluster multiple sources of the same event; the timeline is a separate secondary page.
- **AI Q&A**: ask follow-up questions against a person's cached report using a reasoning model; this is a **different quota pool from generation**.

**Account & monetization**

- **Favorites / history**: four favorite types (quote / report / dynamic / timeline) + browsing history.
- **Message center**: a timeline of follow updates / weekly reminders / platform notices / keyword alerts; read state is stored locally only.
- **Membership & payments**: tiered quotas + WeChat Pay order / callback fulfillment / refund reconciliation (optional).
- **Quote-card sharing**: Canvas 2D image generation for sharing + native forwarding, landing on the person's report page.

> The client has **23 pages** and **4 tabs** (Discover / Ask / Opinion / Mine); the cloud side has **14 cloud functions** and **22 database collections** (see "Architecture" and "Deployment").

---

## Screenshots

Screenshots live in `assets/screenshots/` (real project captures, not placeholders):

| Home | Search | Hot board | Following feed |
|---|---|---|---|
| ![Home](./assets/screenshots/01-home.png) | ![Search](./assets/screenshots/02-search.png) | ![Hot board](./assets/screenshots/03-hot-board.png) | ![Feed](./assets/screenshots/04-feed.png) |

| Following list | Keyword alerts | Message center | AI Q&A |
|---|---|---|---|
| ![Following](./assets/screenshots/05-following.png) | ![Keyword alerts](./assets/screenshots/06-keyword-alert.png) | ![Messages](./assets/screenshots/07-message-center.png) | ![Q&A](./assets/screenshots/08-qa.png) |

| Mine | Model providers |
|---|---|
| ![Mine](./assets/screenshots/09-mine.png) | ![Providers](./assets/screenshots/10-providers.png) |

---

## Tech stack & requirements

- **Framework**: Taro 3.6 (`@tarojs/*` `^3.6.25`) + React 18 + TypeScript 5.4 — `celebrity-radar/package.json`
- **Bundler**: webpack5 (`@tarojs/webpack5-runner`) — `celebrity-radar/config/index.js`
- **UI / state / utils**: Taro UI `^3.0.8`, zustand `^4.5.2`, zod `^3.23.8`, dayjs
- **Backend**: Tencent CloudBase (WeChat Cloud Development); cloud function runtime **Nodejs16.13** — `celebrity-radar/cloudbaserc.json`
- **Cloud function SDK**: `wx-server-sdk`; `aiProxy` / `hotBoardRefresh` require `^4.0.1` (for the CloudBase AI channel)
- **appid / base library**: placeholder `wx0000000000000000`; `libVersion` `3.7.12` — `celebrity-radar/project.config.json`
- **Node.js**: **No `engines` field** in `package.json`; Taro 3.6 + webpack5 suggest **Node 16 or 18 LTS** (cloud runtime is 16.13); the exact minimum version needs to be confirmed by you
- **WeChat DevTools**: any recent stable version; import the mini program subdirectory from "Quick start" and enable Cloud Development

> `celebrity-radar/.npmrc` sets `legacy-peer-deps=true`; `npm install` reads it automatically, no extra flags needed.

---

## Architecture

**Client (`celebrity-radar/src`)**

- `pages/`: 23 pages (each with `index.tsx` / `index.config.ts`; style files as needed).
- `components/`: shared components (custom tab bar, quote card poster, avatars, skeletons, empty states).
- `utils/`: layered business and utility logic — search (`search` / `search-plan`), reports (`report` / `report-store` / `report-toc`), cache (`cache`), membership & payments (`member` / `pay` / `quota`), opinion monitoring (`opinion-*` / `risk-*` / `keyword-alert`), sensitivity & safety (`sensitive` / `sec-check`), etc.
- `config/`: client config. `public.ts` is bundled; `local.example.ts` is the local template; `benefits.ts` / `user-defaults.ts` are the **source-of-truth** files.
- `stores/`, `styles/`, `types/`: zustand state (e.g. `auth`), style variables, and database field types (`types/db.ts`).

**Cloud (`celebrity-radar/cloudfunctions`, 14 functions)**

- **`aiProxy`**: the only entry point that incurs upstream cost. It proxies search and models (`search` / `chat` / `generate` / `aux` / `portrait`), runs two gates before calling upstream (product quota + anti-abuse rate limit), and serves as the shared-cache write endpoint (`action:'report'`).
- **`quotaGuard`**: authoritative quota counters (`refresh` / `generate` / `ask`).
- **`contentCheck`**: content moderation (cloud call `security.msgSecCheck`).
- **Scheduled jobs**: `hotBoardRefresh`, `notifyFollowUpdates`, `keywordAlert`, `riskWatch`, `opinionCluster`, plus `payCallback`'s reconciliation trigger (see "Deployment → Triggers").
- **Payments**: `payCreate` (server-side pricing + order), `payCallback` (callback fulfillment + after-sales + scheduled reconciliation).
- **Users**: `userInit` (the single writer of account & preference config), `userBackfill` (one-off ops).
- **Ops**: `dbInit` (create collections / compare fields / create-update indexes), `adminOps` (operations write endpoint).

**Data flow of one report**

1. The client plans search terms → `aiProxy(search)` runs multi-source web search (Bocha primary, an optional second source as fallback).
2. Material is grouped by event and compressed under a character budget → injected into prompts in batches → `aiProxy(generate/chat)` generates via the structured slot.
3. Results go through field validation, length trimming and source-URL allow-list sanitization, plus a **sufficiency check**; if material is insufficient it degrades gracefully.
4. It is persisted to `report_cache` through the write endpoint (globally shared); the client renders it as card sections and aggregates summary cards from the cache.

---

## Quick start

### Prerequisites

- **Node.js** 16 or 18 LTS (see the "Node.js" row above).
- **WeChat DevTools** (a recent stable version).
- A **WeChat mini program appid** with **Cloud Development (CloudBase)** enabled. A placeholder appid is fine for purely local front-end debugging.

### Steps

```bash
# The repo root has no package.json, so enter the mini program subdirectory first
cd celebrity-radar

# 1) Copy the templates to local files (all three are gitignored)
cp src/config/local.example.ts          src/config/local.ts          # required, see "Configuration"
cp .env.example                         .env                         # required, see "Configuration"
cp project.private.config.example.json  project.private.config.json  # optional: DevTools private config
# On Windows PowerShell, use Copy-Item instead of cp.

# 2) Install dependencies (.npmrc enables legacy-peer-deps)
npm install

# 3) Configure: at minimum set TCB_ENV_ID (the CloudBase environment ID) in .env

# 4) Production build; output goes to dist/
npm run build:weapp
```

Then import the `celebrity-radar/` directory in **WeChat DevTools** — `celebrity-radar/project.config.json` declares `miniprogramRoot: dist/` and `cloudfunctionRoot: cloudfunctions/`, so DevTools finds both the build output and the cloud functions. During development you can tick "Do not verify valid domains" under "Details → Local Settings" (the client never calls upstream domains directly).

The `cp` / `npm` commands above all run **inside the `celebrity-radar/` subdirectory**.

---

## Configuration

Configuration comes in three kinds, each with a **single source of truth**: one `.env` (shared by client and cloud), one local client config (not committed), and a set of files synced from the config source to cloud function copies.

### 1) `.env` (single source: build-time injection on the client + shared by cloud deployments)

Copied from `celebrity-radar/.env.example` (`.env` is gitignored). **At deploy time** `tcb fn deploy` reads it via `cloudbaserc.json`'s `{{env.XXX}}` and fixes the values into the function config; **at client build time** `celebrity-radar/config/index.js` reads the same `.env` and injects compile-time constants via `defineConstants`. Missing keys still compile, but the affected upstream feature errors out when called.

**Required**

- `TCB_ENV_ID`: CloudBase environment ID. **Single source for both client and deploy** (see "Single source" below). Empty = the whole CloudBase layer is unavailable on the client (login / reads / writes / cloud function calls all fail).
- `BOCHA_API_KEY`: primary web-search source (Bocha). Empty = empty results, thin reports, incomplete timelines.

**Search fallback (optional)**

- `SERPER_API_KEY` / `TAVILY_API_KEY`: second search source; **either one** suffices, both empty = the whole step is skipped.

**Model vendors (optional)**

- `DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` / `MOONSHOT_API_KEY` / `DASHSCOPE_API_KEY`: external model vendor keys (DeepSeek / Zhipu / Kimi / Qwen). **A vendor appears on the "Mine" page only once its key is configured**; if none are set, only the default "CloudBase AI" vendor remains (no key needed).
- `LLM_VENDOR` / `LLM_TIER`: default vendor / default quality tier (fallback for requests without one, and for scheduled jobs); empty = the in-code default.

**Subscribe messages (optional)**

- `SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID`: the three subscribe-message template IDs. **Single source for both client and cloud**; empty = push is unconfigured (the auth button is not rendered, scheduled jobs only write in-app data and skip pushes), in-app features are unaffected.

**Membership payments (optional)**

- `WX_PAY_SUB_MCH_ID` / `PAY_CALLBACK_ENV_ID`: service-provider sub-merchant ID + the environment hosting the callback; empty = payments unavailable (free features unaffected).

**Ops tokens (empty by default, fail-closed)**

- `WX_APPID` / `WX_APPSECRET`: used only by `dbInit` to exchange for `access_token` when creating/updating indexes; unset = `dbInit`'s index actions can't run programmatically (you can still create indexes manually in the console).
- `DB_ADMIN_TOKEN`: write token for `dbInit`; **when unset, all writes are rejected** (read-only inspection is unaffected).
- `PAY_ADMIN_TOKEN`: token for `payCallback` / `adminOps` writes; **when unset, ops interfaces reject the call** (refunds and manual reconciliation unavailable; the main payment flow is unaffected).
- `ADMIN_OPS_TOKEN`: `adminOps` write token; **when unset, ops interfaces reject the call**.
- `AI_PROXY_TEST_TOKEN`: token for `aiProxy`'s `test` probe; **when unset, the action is always rejected** (the intended default; business flows are unaffected).
- `AI_PROXY_QUOTA_GUARD`: quota-gate integration switch; **empty or anything other than `off` means `on`** (production semantics, fail-closed); clear it before going live.
- `AI_PROXY_RAW_LOG`: raw upstream payload logging, enabled only when set to `on`; off by default; reset to empty and redeploy after debugging.

> `aiProxy` also reads a few **optional variables not declared in `cloudbaserc.json`** (e.g. timeout budgets); add them in the console if needed.

**Single source (the client and cloud can't diverge)**

1. **CloudBase environment ID (`TCB_ENV_ID`)**: the client injects it into `src/config/public.ts#cloudbaseEnvId` at build time; the cloud reads it as `cloudbaserc.json`'s top-level `envId`. Set it once ⇒ the environment the client connects to and the one `tcb fn deploy` writes to are the same, so "client on A, deploy on B" can't happen. Re-run `npm run build:weapp` after changing it (it is bundled; hot reload won't pick it up).
2. **The three subscribe template IDs**: the cloud injects them into three functions via `cloudbaserc.json`'s `{{env.X}}`; the client injects them into three compile-time constants in `src/config/public.ts` from **the same `.env`** at build time. Set them once ⇒ the client and cloud cannot diverge. Rebuild the client and redeploy the three functions after changing them.

### 2) `src/config/local.ts` (client-only, gitignored)

The template is `celebrity-radar/src/config/local.example.ts`; the repo ships **only the template, with no real values**. `src/config/public.ts` imports it directly, and **the build fails with `Cannot find module './local'` if it's missing**.

```bash
cp src/config/local.example.ts src/config/local.ts   # run inside the celebrity-radar/ directory
```

It contains two kinds of **client-only** settings:

- `webviewDomains`: the business-domain allow-list (sites the source-preview page may open inline). Empty by default = everything uses the "material card + copy link" fallback.
- `debug` (**six switches**, all at safe defaults in the repo):
  - `disableGenerateQuota` / `disableAskQuota` / `disableRefreshQuota` / `disableCooldown`: open up the client-side quota and cooldown gates; set to `true` for local integration only — **this raises costs**.
  - `rawIoLog`: only affects console noise, changes no behavior.
  - `allowRestrictedSearch`: opens up the three-layer restricted-search interception; **for boundary testing only, must be `false` in production**.

> - **Secrets must never enter the client bundle**: only machine-local switches and the domain allow-list belong here; any API key or token stays in `.env` (→ cloud function environment variables).
> - **Opening these up does not disable the cloud gates**: `disable*` only affects client-side checks; `aiProxy` still enforces the cloud quota and rate limit at its entry point.

### 3) Config source and copies (`benefits.ts` → `config:sync` → `config:check`)

When changing values like "who gets how much, what it costs, where the cost boundaries are", **write them once in the source**:

- `celebrity-radar/src/config/benefits.ts`: membership benefits, price table, report parameters, search depth, opinion tier limits, deep-dive budget gate.
- `celebrity-radar/src/config/user-defaults.ts`: user default config.

Cloud functions are packaged independently and cannot `require` the client's TS from the cloud environment, so the source must be **generated into copies** in the cloud function directories:

```bash
# run inside the celebrity-radar/ directory
npm run config:sync     # source → *.config.js copies in each cloud function directory (idempotent)
npm run config:check    # verify only, no writes; prints and exits 1 on any diff (for tests / CI)
npm test                # tests compare the source against the copies and fail if you forgot to sync
```

> Two more files are **hand-synced**, outside `config:sync`: the model registries `celebrity-radar/cloudfunctions/{aiProxy,hotBoardRefresh}/llm.config.js` (the two copies must be word-for-word identical; a test case pins this).

---

## Deployment

Order matters: **create the collections and permissions first, then deploy the cloud functions**, otherwise reads/writes inside functions fail silently. Membership payments, subscribe-message push and the scheduled jobs are all **optional** — get the "search a name → generate a report" path working first, then come back for the rest.

### 1) CloudBase environment

Enable a CloudBase environment in WeChat DevTools and put its environment ID into `celebrity-radar/.env`'s `TCB_ENV_ID`.

### 2) Collections & permissions (22 total)

The source of truth for collections is `celebrity-radar/cloudfunctions/dbInit/schema.js` (**the single source of truth** for the DB structure). **Permissions cannot be set programmatically** — WeChat provides no API for it, so they **must be set by hand, collection by collection, in the CloudBase console**; `dbInit` can only take care of creating **collections** and creating/updating **indexes**.

`schema.js` defines five permission rules (`ACL`), of which `publicRead` (everyone reads, signed-in users write) is **currently unused**. The four in use and how to set them:

| Tier (`ACL` in `schema.js`) | Console security rule |
|---|---|
| `creator` (owner read/write only) | **preset**: pick "Owner read/write only" |
| `selfRead` (owner reads, cannot write) | `{"read": "doc._openid == auth.openid", "write": false}` |
| `publicReadOnly` (everyone reads, client cannot write) | `{"read": true, "write": false}` |
| `cloudOnly` (client cannot read or write) | `{"read": false, "write": false}` |

The 22 collections grouped by permission (same order as `schema.js`):

**Owner read/write only (7)**

- `users` — account & settings (written on first login); `membership` is a **mirror** for the client, authority is `memberships`
- `follows` — follow list (`_id` = openid#personKey)
- `favorites` — favorites (four types; `_id` = openid#type#hash as a dedup primary key)
- `history` — browsing history (keeps the latest 50)
- `events` — analytics events
- `keyword_watches` — keyword subscriptions + person watch (same table, separated by `type`: `keyword` / `person`)
- `opinion_event_status` — per-user status for opinion events (read / follow; the client reads/writes its own row)

**Owner reads, cannot write (4)**

- `refresh_quota` — daily proactive feed refresh count (`_id` = openid#yyyy-MM-dd)
- `generate_quota` — daily report generation quota
- `ask_quota` — daily AI question quota (counted only on success)
- `orders` — membership order state machine (`pending → granting → paid` / `failed` / `refunded`); client read-only

**Everyone reads, client cannot write (8)**

- `report_cache` — report cache + `building` generation mutex (globally shared): writes via `aiProxy(action:'report')`
- `hot_board` — hot board (AI-produced daily; `_id` fixed to `latest`, overwritten)
- `feed_cache` — structured mapping of search results (no LLM output); writes via `aiProxy`'s `saveFeed`
- `keywords` — keyword search cache (`_id` = keyword hash; scheduled jobs write)
- `risk_scans` — person risk scan snapshots (`_id` = personKey)
- `risk_signals` — risk signal stream (`_id` = personKey#url hash)
- `opinion_events` — opinion events (`_id` = event_key; `opinionCluster` reads the DB to cluster and writes)
- `person_assets` — person assets (avatar / photo, `_id` = personKey)

**Client cannot read or write (3)**

- `memberships` — **server-side authority** for membership (`_id` = openid), written only by `payCallback` on fulfillment / refund revocation
- `ai_calls` — anti-abuse rate-limit counter (`_id` = openid#yyyy-MM-dd), atomically incremented in place by `aiProxy` before upstream calls
- `deep_dive_quota` — daily budget counter for event-driven deep dives (`_id` = yyyy-MM-dd)

> ⚠ The three most error-prone permissions (order matters, or the client's writes will fail):
> - The three quota collections (`refresh_quota` / `generate_quota` / `ask_quota`) must be "owner reads, **cannot write**", or users can edit their own quota; and **deploy `quotaGuard` first, then tighten the permissions**.
> - `memberships` / `ai_calls` must be "**client cannot read or write**" — they are the server-side authority for membership and anti-abuse counting.
> - `report_cache` / `feed_cache` are the "everyone reads, **client cannot write**" shared caches: deploy the write-capable `aiProxy` and ship the client first, then tighten to `{"read": true, "write": false}` once old-version coverage is high enough.

### 3) Cloud functions (14 total)

The repo deploys with the **CloudBase CLI (`tcb`)**. Functions, environment variables, timeouts and triggers are all declared in `celebrity-radar/cloudbaserc.json`, so deploy each with `tcb fn deploy <name>`:

```bash
npm i -g @cloudbase/cli      # once
tcb login                    # once
tcb fn deploy aiProxy -e <ENV_ID>
# repeat: tcb fn deploy <function-name> -e <ENV_ID>
```

> If you use DevTools' **"Upload and deploy"** instead, note it **uploads code only and does not read `cloudbaserc.json`** ⇒ environment variables, timeouts and triggers all have to be added by hand in the console. WeChat Cloud Development's **default function timeout is 20 seconds**; report generation is a long task, so raise `aiProxy` (and any other needed function) to **60 seconds** in the console, otherwise the platform cuts it off (the client only sees `-504003`).

The 14 functions and their **required environment variables** (per `cloudbaserc.json`'s `envVariables`):

| Function | Purpose | Required env vars | Trigger |
|---|---|---|---|
| `aiProxy` | Proxies upstream keys and runs the cloud gates + the shared-cache write endpoint | `BOCHA_API_KEY`; any vendor key (see `.env`) | Client calls |
| `quotaGuard` | Authoritative quota counters (`refresh` / `generate` / `ask`) | none | Client calls |
| `contentCheck` | Content moderation (cloud call `security.msgSecCheck`) | none (credentials managed by the platform) | Client calls |
| `hotBoardRefresh` | Daily hot board production (writes `hot_board`) | `BOCHA_API_KEY` + vendor keys | Daily 06:30 |
| `notifyFollowUpdates` | Follow-update subscribe-message push | `BOCHA_API_KEY`, `SUBSCRIBE_TEMPLATE_ID` | Daily 09:00 |
| `keywordAlert` | Keyword opinion alerts (writes `keywords`) | `BOCHA_API_KEY`, `ALERT_TEMPLATE_ID` | Daily 09:20 |
| `riskWatch` | Person risk watch (writes `risk_signals`) | `BOCHA_API_KEY`, `RISK_TEMPLATE_ID` | Daily 09:40 |
| `opinionCluster` | Opinion event persistence (DB clustering, **no network, zero upstream cost**) | none | Daily 10:00 |
| `payCreate` | Membership order creation (server-side pricing + cloud payment order) | `WX_PAY_SUB_MCH_ID`, `PAY_CALLBACK_ENV_ID` | Client calls |
| `payCallback` | Payment result notification + after-sales (refund / reconciliation); the only payment backend | `PAY_ADMIN_TOKEN` | Callback + scheduled reconciliation |
| `dbInit` | Ops tool: create collections / compare fields / create-update indexes | `DB_ADMIN_TOKEN`, `WX_APPID`, `WX_APPSECRET` | Manual |
| `adminOps` | Ops write endpoint (proxy fulfillment / reconciliation, etc.) | `ADMIN_OPS_TOKEN`, `PAY_ADMIN_TOKEN` | Manual |
| `userInit` | The **single writer** of account and preference config | none | Called after client login |
| `userBackfill` | One-off ops: backfill config for existing users (idempotent) | none | Manual |

> - Functions that depend on the config source need **`npm run config:sync` first** (see "Configuration"): `benefits.config.js` → `aiProxy` / `quotaGuard` / `payCreate` / `keywordAlert` / `riskWatch`; `user-defaults.config.js` → `userInit` / `userBackfill`.
> - `contentCheck` relies on `permissions.openapi` (`security.msgSecCheck`) in `celebrity-radar/cloudfunctions/contentCheck/config.json` taking effect on upload; if it doesn't, moderation silently fails open.

### 4) Triggers

cron uses Tencent SCF's **7-field** format (second minute hour day month weekday year), per `celebrity-radar/cloudbaserc.json`'s `triggers`:

| Trigger | Function | cron |
|---|---|---|
| `dailyHotBoard` | `hotBoardRefresh` | `0 30 6 * * * *` |
| `dailyNotify` | `notifyFollowUpdates` | `0 0 9 * * * *` |
| `dailyKeywordAlert` | `keywordAlert` | `0 20 9 * * * *` |
| `dailyRiskWatch` | `riskWatch` | `0 40 9 * * * *` |
| `dailyOpinionCluster` | `opinionCluster` | `0 0 10 * * * *` |
| `payReconcile` | `payCallback` | `0 15 * * * * *` |

Deploying with `tcb fn deploy` brings the triggers up too; uploading via DevTools requires creating them by hand under "Triggers" in the console.

### 5) Running `dbInit`

`dbInit` is an **ops function, not a runtime dependency** (no client code calls it). It can programmatically **create collections** and **create/update indexes**; **setting collection permissions must still be done by hand** (see "Collections & permissions" above).

```bash
tcb fn deploy dbInit -e <ENV_ID>
# Read-only inspection: see what's missing (the permissions_manual in the response is the list to set by hand)
tcb fn invoke dbInit -e <ENV_ID> --params '{"action":"report"}'
# Create missing collections (writes require the token to equal the DB_ADMIN_TOKEN env var)
tcb fn invoke dbInit -e <ENV_ID> --params '{"action":"init","token":"<token>"}'
```

Common `action`s: `report` (default, read-only inspection), `init` (create missing collections only), `fields`, `indexes`, `sync` (= init + fields(apply) + indexes(apply), all in one). **It is dry-run by default**; only an explicit `"apply": true` writes to the DB / calls the API. Delete the function when done: `tcb fn delete dbInit`.

### 6) Domains and business domains

- **Request domains**: **not needed**. The client never calls upstream domains directly — search and models are proxied by cloud functions, and cloud-function egress is not subject to the mini program domain allow-list; the cloud DB / functions go through `wx.cloud` and need no domain either.
- **Business domains**: only affect inline opening on the source-preview page. Sources with unregistered domains fall back to a "material card + copy link" path — predictable, never a blank screen. If you register high-frequency sources as business domains, add the main domain to `src/config/local.ts#webviewDomains` to open them inline.

### 7) Subscribe messages (optional, four steps)

**The default (all three template IDs empty) is a normal state**: the client doesn't render the auth button and the three scheduled jobs only write in-app data while skipping pushes — **in-app features work fully**. To enable push, follow these four steps under **your own service category** (all are required):

1. **Apply for templates**: WeChat MP → Features → Subscribe Messages → Public Template Library; pick a template whose **fields are like `thing1` (notification content, ≤ 20 chars) + `date2` (time)**, and apply for / select **three different template IDs** (one each for follow updates / keyword alerts / risk reminders).
2. **Fill in the config**: put the three IDs into `celebrity-radar/.env`'s `SUBSCRIBE_TEMPLATE_ID` / `ALERT_TEMPLATE_ID` / `RISK_TEMPLATE_ID` (**that one place only**).
3. **Rebuild and redeploy**: run `npm run build:weapp` to rebuild the client (the values are bundled; hot reload won't pick them up), and redeploy the three functions so the env vars take effect.
4. **On-device authorization**: after login, tap the auth buttons at the three entry points and confirm that `subscribe_ok` / `alert_ok` / `risk_ok` on the corresponding `users` row are `true` — scheduled jobs only push to users who are `true`.

> ⚠ **The three template IDs must differ**: WeChat one-time subscriptions **consume one authorization per push and per template**, so if the three jobs (09:00 / 09:20 / 09:40) share one template, the first eats the authorization and the rest get `43101`.

---

## Tests

Tests run in **Node**, without a cloud connection or any key. `npm test` first compiles `src` to `test/.build` with `tsc` (the harness `celebrity-radar/test/harness` installs a `@tarojs/taro` stub and a global `wx` stub), then runs all cases.

```bash
# run inside the celebrity-radar/ directory
npm test            # 1) tsc compile src; 2) run all cases
npm run test:only   # run cases only, no recompile (when iterating on cases)
```

All `scripts` (from `celebrity-radar/package.json`; **run them inside the `celebrity-radar/` directory**):

| Script | Purpose |
|---|---|
| `npm run dev:weapp` | Development mode (watch; output to `dist/`) |
| `npm run build:weapp` | Production build for WeChat mini program (output to `dist/`) |
| `npm run build:h5` | H5 build (for debugging; cloud features are unavailable) |
| `npm test` | Compile `src` with `tsc`, then run all cases |
| `npm run test:only` | Run cases only, no recompile |
| `npm run config:sync` | Config source → cloud function copies (idempotent) |
| `npm run config:check` | Verify source vs. copies match (exits 1 on any diff) |

Cases live in `celebrity-radar/test/cases/*.js` and come in two flavors:

- **Static constraints**: pin down "the source must / must not contain this pattern" — e.g. cloud gates agreeing with client semantics, config source matching cloud function copies (`config:sync` / `config:check`), and the two hand-synced `llm.config.js` files being identical.
- **Pure-function assertions**: assert input/output of side-effect-free functions (quota, cache, report sanitization, event clustering, etc.).

---

## Cost & compliance

**Where upstream calls are billed**

- **Report generation**: one generation triggers "search-term planning + multi-source web search + batched LLM generation" — the single largest cost source in this project.
- **Scheduled scans**: `hotBoardRefresh` (06:30), `notifyFollowUpdates` (09:00), `keywordAlert` (09:20) and `riskWatch` (09:40) all hit upstream every run. `opinionCluster` (10:00) **only reads the DB to cluster — no network, no upstream cost**.
- **Event-driven deep dive**: `keywordAlert` / `riskWatch` only run one extra query per hit **when a scan hits**, capped by a **three-layer budget gate** (source: `DEEP_DIVE` in `celebrity-radar/src/config/benefits.ts`): `queriesPerHit = 1` (at most one extra query per hit), `perRunMax = 6` (at most six per run), `perDayMax = 60` (at most sixty per day across runs, counted in the `deep_dive_quota` collection). It is **hit-triggered, not a full refresh** — that is what makes the cost controllable.

> The source of truth for these quotas, caps and report budgets is `celebrity-radar/src/config/benefits.ts`; change it → `npm run config:sync` → redeploy the affected functions.

**Compliance design (deployers are responsible for content compliance)**

- **Three-layer political/military interception** (client + prompts): ① the **local static interception** in `celebrity-radar/src/utils/sensitive.ts` (a hit refuses and **sends no network request**); ② the "political / military figures → refused" rule in the disambiguation prompt; ③ the "material indicates a politically / militarily sensitive figure → refuse the whole report" rule in the report prompt. The name list is an **empty array** in the repo (a placeholder for operations), so you must fill it in per the latest compliance requirements before going live.
- **Cloud content moderation**: `celebrity-radar/cloudfunctions/contentCheck` submits AI questions for review via the cloud call `security.msgSecCheck`.
- ⚠ Reports are generated by an LLM from public information and are permanently labeled "AI-generated, for reference only". **This repository provides no compliance endorsement** — category qualifications, content review, privacy policy, AI-generated content labeling and other compliance duties are the **deployer's own responsibility**.

---

## Directory structure

Paths are relative to the **repository root**; the mini program itself is in the `celebrity-radar/` subdirectory:

```text
celebrity-radar/                ← repository root (no package.json)
├── README.md                   Chinese docs
├── README.en.md                English docs (this file)
├── LICENSE / NOTICE            License (Apache-2.0) and third-party attributions
├── CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
├── assets/screenshots/         UI screenshots
└── celebrity-radar/            ← the mini program (run all npm commands here)
    ├── src/                    mini program source
    │   ├── pages/              23 pages
    │   ├── components/         shared components
    │   ├── utils/              business & utility logic
    │   ├── config/             client config (public.ts / benefits.ts / local.example.ts …)
    │   ├── stores/  styles/  types/
    │   └── app.config.ts       page & tabBar declaration
    ├── cloudfunctions/         14 cloud functions (dbInit/schema.js is the schema source of truth)
    ├── scripts/sync-config.js  syncs the config source to cloud function copies
    ├── test/                   tests: cases/, harness/, run.js entry
    ├── config/                 Taro build config (index.js + dev.js / prod.js)
    ├── cloudbaserc.json        cloud function / env var / trigger declarations (read by the CloudBase CLI)
    ├── project.config.json     WeChat DevTools project config
    ├── package.json            dependencies and scripts
    └── .env.example            cloud deployment secret template (copy to .env)
```

---

## FAQ / known limitations

- **Push unavailable**: subscribe-message templates must be requested from the Public Template Library under **your own service category**; some account types / categories cannot obtain a usable template, so push is unavailable. This is a **limitation of the current deployment environment, not a missing feature**: the channel and code are fully retained, and leaving the three templates empty degrades to "write in-app data only, skip push", with in-app features unaffected.
- **Freshness of market-type data**: reports and rankings are generated by AI from a snapshot of public material at one point in time — not real-time. Reports are a global shared cache, so changing upstream parameters only affects **newly generated** reports; old cache is not rebuilt automatically (unless a user taps "Regenerate").
- **Client-side caps are not a security boundary**: the client's quota checks, debug switches and watch-count limits are experience-layer only and can be bypassed by repackaging; the real cost boundary is in the cloud (`ai_calls` anti-abuse counting, the `memberships` authority table).

---

## Support the project

If this project helps you, you can buy the author a coffee:

| WeChat Pay | Alipay |
|---|---|
| ![WeChat Pay QR](./assets/screenshots/微信.JPG) | ![Alipay QR](./assets/screenshots/支付宝.JPG) |

---

## Contributing / Security / License

- **Contributing guide**: [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Code of Conduct**: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- **Security policy** (**do not report security issues in a public issue**): [`SECURITY.md`](./SECURITY.md)
- **Third-party attributions**: [`NOTICE`](./NOTICE)
- **License**: released under the **Apache License 2.0**; the full text is in [`LICENSE`](./LICENSE).

> The `license` field in `celebrity-radar/package.json` is `Apache-2.0`. Before publishing, replace the copyright-line placeholder in the `LICENSE` appendix with your own name or organization.
