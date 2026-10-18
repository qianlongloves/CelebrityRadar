<div align="center">

# Celebrity Radar · 名人雷达

**Type a name, get back a readable, source-traceable, reusable intelligence report.**

Search recent public coverage → distil it into a structured profile with an LLM → grow a following feed, weekly digest, AI Q&A, opinion monitoring and memberships on top of it

**Taro 3 (React + TypeScript) · WeChat CloudBase**

[中文](./README.md) ｜ [**English**](./README.en.md) ｜ [GitHub](https://github.com/qianlongloves/CelebrityRadar) ｜ [Gitee](https://gitee.com/qianlonglove_admin/celebrity-radar)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)
![Taro](https://img.shields.io/badge/Taro-3.6-07c160.svg)
![WeChat Mini Program](https://img.shields.io/badge/WeChat-Mini%20Program-07c160.svg)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/qianlongloves/CelebrityRadar?style=social)](https://github.com/qianlongloves/CelebrityRadar)

</div>

> ⚠ This is **complete, compilable and runnable code**, not a product you can put online for operation as-is. The repository ships **no usable credentials** — `appid`, the CloudBase environment ID and every upstream API key are placeholders or empty, and must be supplied by you.
>
> ⚠ This README lives at the **repository root**, but the mini program itself (`package.json`, `src/`, `cloudfunctions/`, etc.) is in the **`celebrity-radar/` subdirectory**; **the root has no `package.json`**. Therefore every `npm` command below must be run after `cd celebrity-radar` into the subdirectory first.

---

## Table of contents

- [Overview](#overview)
- [Highlights](#highlights)
- [Features](#features)
- [Screenshots](#screenshots)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Tests](#tests)
- [Cost & compliance](#cost--compliance)
- [Disclaimer](#disclaimer)
- [Directory structure](#directory-structure)
- [FAQ / known limitations](#faq--known-limitations)
- [Roadmap](#roadmap)
- [Support the project](#support-the-project)
- [Acknowledgements](#acknowledgements)
- [Contributing / Security / License](#contributing--security--license)

---

## Overview

Celebrity Radar is a "public-figure intelligence desk". What it does is straightforward: **turn a name into a readable, source-traceable, reusable profile.**

The user just types a name. The program first does a round of disambiguation to confirm who you mean; then it searches the internet for recent public coverage of that person, groups and compresses the collected material by event, and feeds it to an LLM in batches, finally producing a structured report. This report is not a few vague sentences of summary but an archive-like combination of information — identity & background, recent dynamics, stance & opinion, commercial ties, and risk signals, broken out section by section, with every item traceable to its original source rather than the LLM's free invention.

The project carries one key trade-off throughout its design: **reports are a globally shared cache**. The same person is generated only once and reused by all users, so the cost of a single generation is amortized across the whole user base; many "summary cards" on the client do not re-invoke the model either — they perform **local aggregation** on the existing cache. So the cost structure is controllable: the more people use it, the lower the per-user cost.

```text
name → disambiguation → search-term planning → multi-source web search
     → group by event / compress under budget → batch prompt injection
     → structured generation → field validation + source-URL allow-list
     → persist to report_cache (shared) → render card sections + aggregate locally
```

---

## Highlights

- **One cache, shared by everyone** — reports are a **globally shared cache**: each figure is generated once, and the client's summary cards **aggregate purely locally with zero model calls**. The more users, the lower the per-user cost.
- **11 sections free, 18 for members** — tiering works on two levers at once: **section count** and **rows per section**. Member sections render a lock card in place instead of disappearing, so the data stays complete and truncation only ever happens on the rendering line.
- **Every statement is traceable** — output passes **source-URL allow-list sanitization**, every material item points to its origin, and exports carry the full provenance; registered business domains can be previewed inline.
- **Watch people sideways, not just by subscription** — the monitoring ledger lines up "which of the people I watch is moving", with up to 4 ticked for a metric comparison; the ledger, comparison and event tracking all read cached data at **zero upstream cost**.
- **Costs have a hard ceiling** — every upstream call goes through **one** exit, behind a product-quota + anti-abuse rate-limit double gate; quotas are incremented atomically per user and day on the cloud, and **the client can only read them**, so editing the bundle can neither reset nor forge usage.
- **Compliance built in, engineering verifiable** — consent, withdrawal, data export and account deletion ship with the product, with the impact assessment archived separately; **2200+ test cases** run with one command, needing no cloud and no keys.

---

## Features

All the capabilities below are **actually implemented in the code**, not blueprints. They are grouped by the four tabs (Discover / Ask / Opinion / Mine), with deliverables and operations folded into the last group.

### 1. Discover: reports & search

- **Discover page**: figure of the day (AI picks one and explains why), random exploration, search by name (hot words + recent searches), industry and focus filters, hot board.
- **Reports**: 18 sections in 4 groups; **11 sections free / all 18 for members**, with rows per section tiered too (3 free plus an in-place "N more"); member sections render a lock card in place instead of vanishing.
- **Summary cards**: profile overview, stance & opinion, risk radar, commercial value — cache-read only, zero model calls.
- **Search**: three-layer fallback (degradation ladder → second source → knowledge-only), thin reports marked "brief"; a focus can be picked before generation (everything / dynamics / quotes / timeline).
- **Figure profile page**: dynamics / quotes / timeline / data tabs, all reading the cache; the data tab shows coverage, sources, source × sentiment, credibility, sentiment composition and trend, and skips charts whose sample is too thin.
- **Comparison & knowledge base**: two-figure comparison (metrics + comparative Q&A) and a topic knowledge base that recatalogs existing reports.
- **Refresh & versions**: old versions are archived — **version list free, old-version body for members**; the diff compares counts and named entries only, and each refresh reports one of seven honest outcomes.
- **Provenance & disambiguation**: every material item links to its origin (registered domains preview inline); a three-layer disambiguation round runs before search, and a confirmed alias is remembered for every later generation and aggregation.

### 2. Ask: AI Q&A

- **Two entries, one panel**: ask from the Ask tab, or follow up from the report page's tool row — same panel, same quota.
- **Semantics**: reads the cached report, uses a reasoning model, and has its **own pool** (5 free / 30 for members, resetting at UTC+8); counted **only when an answer comes back**.

### 3. Opinion: following & monitoring

- **Following feed**: follow list plus an aggregated feed, filterable by figure / domain.
- **Opinion desk**: four entries (my alerts / monitoring ledger / following feed / weekly digest), the daily brief (follows / watched words / dynamics / risks + risk categories and impact), the top 3 of today's focus and event / keyword preview cards — all aggregated locally, zero model calls.
- **Alerts & monitoring**: keyword monitoring and person risk watch — daily scheduled searches that **only state what was hit and where, with no rating or prediction**.
- **Weekly digest & hot board**: the digest produces a share image plus a ≤5-point summary with sources (costs one generation credit); the hot board is produced daily and feeds the figure of the day and hot words.
- **Events & subscriptions**: multiple sources of the same event are clustered into one (timeline detail rows: 5 free / all for members); "follow" watches what happens next to that one event, "subscribe" watches all events about a person / word (up to 30 subjects, same names merge).
- **Monitoring ledger**: sorted by latest activity, tick 4 people for a metric comparison (people without a report still appear, marked "not generated"), export a brief; free in-app, export is the only member capability.

### 4. Mine: account, quotas & deliverables

- **Favorites, history & messages**: four favorite types + browsing history; follow updates, weekly reminders, report updates and notices in one timeline, read state on device only.
- **Membership tiers**: three daily quotas + section count (11 / 18) + rows per section + timeline detail + monitoring caps + poster and structured export + old-version bodies + model tier (non-members always fall back to basic on the cloud); WeChat Pay optional.
- **Quotas**: generation / refresh / ask each count per day (the numbers are written once in a benefits config), incremented atomically on the cloud and **read back from the cloud**, client read-only.
- **Deliverables**: poster, Markdown (every fact carries its source), JSON, weekly card, quote card; the mini program code on share images is generated server-side.
- **Settings & admin console**: settings collects update reminders, data export, consent withdrawal and deletion; the admin console (openid allow-list) finds users, inspects quotas, grants membership and toggles LLM vendors.

> The client has **26 pages and 4 tabs** (Discover / Ask / Opinion / Mine); 4 tab pages stay in the main package and the other 22 secondary pages are pushed down into a subpackage to keep the main bundle small. The cloud side has **16 cloud functions and 27 database collections**, detailed in "Architecture" and "Deployment" below.

---

## Screenshots

All screenshots come from `assets/screenshots/` and are from the real project, not placeholders:

<table align="center">
  <tr>
    <td align="center"><img src="./assets/screenshots/home.png" width="150"/><br/><sub>Home</sub></td>
    <td align="center"><img src="./assets/screenshots/hot-board.png" width="150"/><br/><sub>Hot board</sub></td>
    <td align="center"><img src="./assets/screenshots/feed.png" width="150"/><br/><sub>Feed</sub></td>
    <td align="center"><img src="./assets/screenshots/profile.png" width="150"/><br/><sub>Figure page</sub></td>
    <td align="center"><img src="./assets/screenshots/weekly.png" width="150"/><br/><sub>Weekly</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/report-1.png" width="150"/><br/><sub>Report 1</sub></td>
    <td align="center"><img src="./assets/screenshots/report-2.png" width="150"/><br/><sub>Report 2</sub></td>
    <td align="center"><img src="./assets/screenshots/report-3.png" width="150"/><br/><sub>Report 3</sub></td>
    <td align="center"><img src="./assets/screenshots/report-4.png" width="150"/><br/><sub>Report 4</sub></td>
    <td align="center"><img src="./assets/screenshots/report-5.png" width="150"/><br/><sub>Report 5</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/report-6.png" width="150"/><br/><sub>Report 6</sub></td>
    <td align="center"><img src="./assets/screenshots/report-7.png" width="150"/><br/><sub>Report 7</sub></td>
    <td align="center"><img src="./assets/screenshots/report-8.png" width="150"/><br/><sub>Report 8</sub></td>
    <td align="center"><img src="./assets/screenshots/report-9.png" width="150"/><br/><sub>Report 9</sub></td>
    <td align="center"><img src="./assets/screenshots/report-10.png" width="150"/><br/><sub>Report 10</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/opinion.png" width="150"/><br/><sub>Opinion</sub></td>
    <td align="center"><img src="./assets/screenshots/events.png" width="150"/><br/><sub>Events</sub></td>
    <td align="center"><img src="./assets/screenshots/monitoring.png" width="150"/><br/><sub>Risk watch</sub></td>
    <td align="center"><img src="./assets/screenshots/messages.png" width="150"/><br/><sub>Messages</sub></td>
    <td align="center"><img src="./assets/screenshots/mine.png" width="150"/><br/><sub>Mine</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/favorites.png" width="150"/><br/><sub>Favorites</sub></td>
    <td align="center"><img src="./assets/screenshots/member.png" width="150"/><br/><sub>Membership</sub></td>
    <td align="center"><img src="./assets/screenshots/model-tier.png" width="150"/><br/><sub>Model tier</sub></td>
    <td align="center"><img src="./assets/screenshots/comparison.png" width="150"/><br/><sub>Comparison</sub></td>
    <td align="center"><img src="./assets/screenshots/ai-qa.png" width="150"/><br/><sub>AI Q&A</sub></td>
  </tr>
</table>

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | **Taro 3** + **React 18** + **TypeScript** |
| Bundler | webpack 5 (`@tarojs/webpack5-runner`) |
| UI | Taro UI + custom tabBar / hand-drawn overlays |
| State | zustand |
| Validation | zod |
| Dates | dayjs |
| Backend | **Tencent CloudBase (WeChat Cloud Development)**, cloud functions on Node 16.13 |

Only two cloud functions that actually talk to the LLM — `aiProxy` and `hotBoardRefresh` — use `wx-server-sdk`, going through CloudBase's built-in AI channel.

One deployment-friendly detail: the repo's `.npmrc` already contains `legacy-peer-deps=true`, so `npm install` picks it up automatically — no extra flags needed.

---

## Architecture

The system splits in two with a clear division of labour: **the client owns experience and aggregation; the cloud owns cost and authority.**

On the **client**, beyond pages and shared components, the core logic lives in `utils`, layered by "search, reports, cache, membership & payment, opinion, security". The config directory is the other key point: package-level public config, local-only config, and the **single source of truth** for "who gets how much, at what price" all live here, so the client and cloud never keep two drifting copies.

The **16 cloud functions** on the cloud side are grouped as follows:

| Group | Functions | Role |
|---|---|---|
| Core egress | `aiProxy` | The **only source of upstream cost**: proxies search and LLM calls, passes the "product quota + anti-abuse rate limit" gates first, and is also the shared-cache write entry |
| Gates & security | `quotaGuard`, `contentCheck` | Cloud authority for the three quota pools (generate / refresh / ask): `consume` increments atomically, `peek` reads without incrementing; automated content-safety screening |
| Scheduled jobs | `hotBoardRefresh`, `notifyFollowUpdates`, `keywordAlert`, `riskWatch`, `opinionCluster` | Hot board / follow push / keyword alerts / risk watch / opinion clustering (clustering reads only — zero upstream cost) |
| Payment | `payCreate`, `payCallback` | Order placement / callback and reconciliation |
| Sharing & admin console | `wxacode`, `adminConsole` | Mini program code for share images (access_token stays server-side) / server side of the in-app super-admin console (openid allow-list) |
| Users & ops | `userInit`, `dbInit`, `adminOps`, `userBackfill` | Sole writer of account & config / create collections & indexes / ops write endpoint / data backfill |

Expanded, one report generation goes like this: the client plans search terms, hands them to `aiProxy` for multi-source web search (Bocha as the primary source, an optional second source as fallback); the results are grouped by event and compressed under a character budget, injected into prompts in batches, and sent back to `aiProxy` for structured generation; the output passes field validation, length trimming, source-URL allow-list sanitization and a "is the material sufficient" threshold check with graceful degradation; on success it is persisted into the globally shared `report_cache`, and the client renders it into card sections and aggregates the various summary cards. The whole run costs upstream exactly once — every later read is free.

---

## Quick start

Before you start you need three things: **Node.js 16 or 18 LTS**, **WeChat DevTools**, and a **WeChat Mini Program appid** (with a CloudBase environment enabled). If you only want to run the front end locally and look at the UI, a placeholder appid works too.

```bash
cd celebrity-radar   # the root has no package.json — enter the project subdirectory first

# Copy three "template → local file" pairs (templates are gitignored and never committed)
cp src/config/local.example.ts          src/config/local.ts          # required
cp .env.example                         .env                         # required
cp project.private.config.example.json  project.private.config.json  # optional
# On Windows PowerShell, replace cp with Copy-Item.

npm install

npm run build:weapp  # production build, output in dist/
```

The one step you cannot skip is `local.ts` — it is imported directly by `public.ts`, and compilation fails outright without it; `.env` at minimum needs the CloudBase environment ID. Then just import the `celebrity-radar/` directory in WeChat DevTools — the project config already declares `miniprogramRoot` and `cloudfunctionRoot`. During development you can tick "do not verify valid domains" under Details → Local Settings; since the client never calls upstream directly, this toggle does not affect functionality.

Common commands:

| Command | What it does |
|---|---|
| `npm run dev:weapp` | Development build (watch) |
| `npm run build:weapp` | Production build, output in `dist/` |
| `npm test` | Compile and run all tests (no cloud, no keys) |
| `npm run config:sync` | Sync config sources of truth into cloud-function copies |
| `npm run config:check` | Verify copies are in sync (fails on any drift) |
| `npm run release:check` | Pre-release reconciliation: debug switches / privacy-agreement check switch (source **and** build artifact) / compliance name list / appid / whether `dist/` is older than `src/` |

---

## Configuration

Configuration comes in three kinds, each with its own **single source of truth**, precisely to avoid the classic problem of "the same value written in two places, drifting apart over time".

**First is `.env`**, copied from `.env.example`, the shared source of truth for both the client and the cloud. Its keys fall into a few tiers. Required: the CloudBase environment ID (`TCB_ENV_ID`) and the Bocha search key (`BOCHA_API_KEY`). Optional: a second search source (either SERPER or TAVILY), keys for several external LLM vendors (only vendors you configure appear on the "Mine" page — with none, only the default "CloudBase AI" is available, which needs zero keys), default vendor and default quality tier, three subscription-message template IDs, payment sub-merchant ID and callback environment, plus the appid and secret used to build indexes. There is also a set of ops tokens: when unset, the corresponding write operations are **rejected outright** (refuse rather than allow); read-only inspection is unaffected. Finally there are two explicit switches — one for the quota gate (empty means enabled) and one for upstream raw logs (off by default).

The beauty of this `.env` is its **single origin**: at deploy time the cloud reads it via `cloudbaserc.json` and bakes it into function config, and at build time the client reads the **same** `.env` through a build script that injects compile-time constants. So values that must agree between client and cloud — environment ID, template IDs — are entered once and structurally cannot diverge. The only cost is that after changing them you must re-run `npm run build:weapp`, because those values are compiled into the bundle and hot updates will not pick them up.

**Second is the client-only local config `local.ts`**, templated by `local.example.ts` and likewise gitignored. It holds only two kinds of machine-specific settings: the business-domain allow-list (affecting whether source preview opens inline) and six debug switches (releasing quota and cooldown gates, printing raw I/O, releasing restricted-category search blocks). The rule is explicit: **no secrets in the client bundle** — API keys and tokens stay in `.env` and flow to cloud functions only; and even when a `disable*` switch is on, it only affects the client-side experience layer — the cloud entry validates again.

**Third is "config source of truth → cloud-function copies" syncing.** Values like membership benefits, the price table, report parameters, search depth, opinion tier caps and user defaults — "who gets how much, at what price, within what cost ceiling" — are written once in `benefits.ts` and `user-defaults.ts`; but since each cloud function is packaged independently and cannot read the client's TypeScript at runtime, `npm run config:sync` generates copies into each cloud-function directory, and `npm run config:check` verifies they match (tests pin this too). Separately, the model-tier table `llm.config.js` exists in both `aiProxy` and `hotBoardRefresh` and must be kept character-for-character identical by hand.

---

## Deployment

The order matters: **create collections and permissions first, deploy cloud functions second**, otherwise reads and writes inside the functions fail silently. Membership payment, subscription push and every scheduled job are **optional** — get the core "search a name → generate a report" path working first, then open up the rest gradually.

1. **CloudBase environment**: enable it in DevTools and put the environment ID into `.env`.
2. **Collections & permissions** (27 collections; the schema source of truth is `dbInit/schema.js`).
3. **Deploy cloud functions** (with the CloudBase CLI, `tcb`).
4. **Scheduled triggers** (shipped along with `tcb fn deploy`).
5. **The `dbInit` ops function** (read-only inspection first → create collections and indexes only with token + `apply`).
6. **Domains** (no server domain needed).
7. **Subscription messages** (optional).

**Step two is collections and permissions.** One easily missed point: **permissions cannot be set programmatically** — they must be configured by hand, collection by collection, in the CloudBase console; `dbInit` can only create collections and add/modify indexes. There are five tiers:

| Tier | Count | Details |
|---|---|---|
| Creator-only read/write | 7 | Users, follows, favorites, history, events, keyword watches, event status |
| Self read-only | 4 | Three quota tables (refresh / generate / ask) + orders |
| Public read, client write forbidden | 10 | Report cache, report versions, hot board, feed cache, keywords, risk scans / signals / logs, opinion events, person assets |
| Public read, signed-in write | 1 | Person aliases (`person_alias`): the client writes after the user confirms "same person"; only the disambiguation layer reads it |
| Client fully denied | 5 | Membership authority table, upstream call counter, deep-dive quota, member-section copy (`report_member`), system config (`sys_config`) |

Three spots are the most error-prone: the three quota tables must be "self-readable but **not writable**", or users could edit their own quota — and **deploy `quotaGuard` before tightening them** (since 2026-10-18 the client reads quotas via the cloud function's `peek` first and falls back to a direct client read, so a missing custom rule no longer makes usage freeze at `0 / 30` or lets the gate through forever — but do configure it anyway: it saves one function call and keeps the fallback path usable); the membership table and anti-abuse counter must be fully client-denied since they are server-side authority; and the report cache and feed cache are shared caches, so deploy the write-enabled `aiProxy` first and only tighten them to read-only once the old version has been fully replaced.

**Step three is deploying cloud functions** with the CloudBase CLI (`tcb`); timeouts, environment variables and timers are declared in `cloudbaserc.json`. A key warning: if you instead use DevTools' "upload and deploy", it **uploads code only and ignores `cloudbaserc.json`** — environment variables, timeouts and triggers must be added by hand in the console. Also, cloud functions default to a 20-second timeout; report generation is a long task, so raise `aiProxy` to 60 seconds or the platform will cut it off.

**Step four is scheduled triggers.** The cron uses Tencent SCF's seven-field format, and `tcb fn deploy` ships them along with the code; with DevTools upload you must create them manually. The six triggers land between 06:30 and 10:00, plus an hourly payment reconciliation.

**Step five is the `dbInit` ops function.** It is read-only inspection by default (see what is missing); only with an explicit token and `apply` does it actually create collections and indexes — permissions are still manual. After it runs, deleting the function is recommended so it does not remain as an attack surface.

**Step six is domains.** **No server domain is needed** — search and LLM calls are proxied by cloud functions, which are not subject to the mini program domain allow-list, and CloudBase database and functions go through `wx.cloud` without a domain either. The business domain only affects whether source preview opens inline; unregistered links simply take the degraded path, with predictable behaviour.

**Step seven is subscription messages (optional).** Leaving all three template IDs empty is a **normal state**: the client hides the authorization button, the three scheduled jobs only write in-app data and skip push, and everything in-app works. To enable push you must follow four steps for your own service category: apply for three different templates → fill them into `.env` → rebuild the client and redeploy the three functions → authorize on a real device. One easy pitfall: **the three templates must differ**, because WeChat one-off subscriptions grant exactly one push per authorization; sharing one template across three jobs means the first job consumes the grant and the others error out.

---

## Tests

Tests run in Node, with **no cloud connection and no keys**. `npm test` first compiles the sources with `tsc` into the test directory, then runs every case; the harness stubs Taro and the global `wx` so pure logic can be asserted directly without a mini program environment.

Cases come in two kinds:

- **Static constraints**: pin down "this source must / must not contain this pattern" — e.g. cloud gates and client semantics must agree, config sources of truth and cloud-function copies must agree, and the two hand-synced model-tier tables must be character-identical; for quota tables they also pin "the client must not write" and "the cloud `peek` must be the primary read".
- **Pure-function assertions**: assert inputs and outputs directly for side-effect-free functions such as quota, cache, report sanitization and event clustering, including boundaries like "fall back to the local mirror when the cloud read fails, and the fallback never flips the verdict".

---

## Cost & compliance

On **cost**, the largest single expense is report generation — one run triggers search-term planning, multi-source web search and batched LLM generation. Next come the scheduled scans, each of which really calls upstream (only opinion clustering reads the database alone, no network, zero cost). To cap cost, the project has an "event-driven deep dive" design: keyword alerts and risk watch only extend the search by one extra term **for the matched target**, and are limited by three budget gates (one term per hit, at most six per round, at most sixty per day). The sources of truth for these caps, quotas and report budgets are in `benefits.ts` — edit it → sync → redeploy.

On **compliance**, the deployer must verify and take responsibility. Three layers of political/military interception are built in: local static interception (an immediate refusal with no network request at all), disambiguation-prompt rules and report-prompt rules; the name lists ship as empty arrays and must be filled before launch (an empty list is caught by `npm run release:check`). AI Q&A passes through automated content-safety screening via a cloud call. Reports always carry an "AI-generated, for reference only" label. A full **PIPL (personal information protection) toolkit** is also built in: the platform privacy-agreement check switch (`__usePrivacyCheck__`), the consent gate (`consent-gate` / `privacy-gate`), consent withdrawal, personal-data export (`utils/data-export.ts`) and account deletion (`userInit.deleteAccount`) — note that the **privacy-agreement check switch defaults to `false`**: configuring and passing the privacy guidelines in the platform console is the prerequisite for flipping it to `true`, and doing it in the wrong order makes the platform reject the avatar / nickname APIs outright (nothing the client can recover from); rebuild afterwards, since the artifact — not the source — is what gets uploaded. Run `npm run release:check` before uploading: it reconciles these "only needed at release time" switches together with the build artifact and lists whatever only a human can confirm. The impact assessment is filed in `celebrity-radar/doc/个人信息保护影响评估.md`. To repeat: **this repository provides no compliance endorsement of any kind.**

---

## Disclaimer

Every report, ranking and opinion summary produced by this project is **auto-generated by an LLM from public web material** — in essence "an AI snapshot of public information at a moment in time". It is for informational reference only and **does not constitute any factual statement, evaluation or stance regarding any real person or organisation**.

The project includes political/military interception and automated content-safety screening, but these are **technical safeguards only** and constitute no compliance endorsement — **content-safety and legal compliance for a live deployment are the deployer's responsibility under local law**. The name lists and interception word lists ship empty and must be filled before launch.

In one sentence: **this repository provides engineering implementation and code only — no content, data or operational service — and accepts no liability for any consequences of using it.**

---

## Directory structure

```text
celebrity-radar/                ← repository root (no package.json)
├── README.md / README.en.md    Chinese / English docs
├── LICENSE / NOTICE            License (Apache-2.0) and third-party attribution
├── CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
├── assets/screenshots/         UI screenshots
└── celebrity-radar/            ← the mini program itself (run npm commands here)
    ├── src/                    source (components / utils / config / stores / styles / types)
    │   ├── pages/              4 main-package tab pages (Discover / Ask / Opinion / Mine)
    │   └── package/            22 subpackage pages (report / figure / feed / weekly / events / alerts / ledger / versions / settings / admin …)
    ├── cloudfunctions/         16 cloud functions (dbInit/schema.js is the schema source of truth)
    ├── scripts/sync-config.js  config source-of-truth sync
    ├── test/                   tests (cases / harness / run.js)
    ├── config/                 Taro build config
    ├── cloudbaserc.json        cloud functions / env vars / timers
    ├── project.config.json     DevTools project config
    ├── package.json            dependencies and scripts
    └── .env.example            deployment secrets template (copy to .env)
```

---

## FAQ / known limitations

- **Push unavailable**: subscription-message templates must be applied for under **your own service category**, and some categories simply cannot obtain the relevant templates. That is a deployment-environment restriction, not a missing feature — with templates empty the system degrades to in-app data only, and in-app features are unaffected.
- **Freshness**: reports and rankings are essentially "an AI snapshot of public material at a moment in time" and are not guaranteed real-time. Reports are a globally shared cache, so parameter changes only affect reports generated afterwards; old caches are not rebuilt automatically unless you manually hit "regenerate".
- **Client-side caps are not a security boundary**: client quotas, debug switches and monitoring caps are experience-layer design only and can be bypassed by modifying the bundle; the real cost boundary is on the cloud — the anti-abuse counter and membership authority tables are validated server-side only.
- **Quota numbers never move / the gate never blocks**: first check that DevTools is signed in with the **same WeChat account as the real device** — after switching accounts, `wx.getStorageSync('auth:profile').userId` must equal the `_openid` of that row in `users`; quotas are stored per `openid#date`, so two accounts simply read two different rows, which is the usual reason two devices disagree. If the same account still reads 0, read it back from the console: `wx.cloud.callFunction({ name: 'quotaGuard', data: { kind: 'ask', action: 'peek' } }).then(r => console.log(r.result))` (swap `kind` for `generate` / `refresh` for the other two). `{ ok: true, count: N }` means the cloud row really is N — if the page still shows 0, the local mirror or the view simply has not refreshed (leave and re-enter "Mine"), which has nothing to do with permissions. The direct client read is only used when the function is unreachable, and failing it now makes the number stale, not the quota meaningless. Since `2026-10-18` both the display and the gates use this `peek` as the primary read, so a frozen number has only three causes left: wrong account, no row for today, or the function not deployed.

---

## Roadmap

> These are merely possible directions, **not a roadmap commitment**; discussion of priorities in Issues is welcome.

- [ ] **Incremental rebuild** of the report cache: no full regeneration when parameters change.
- [ ] More search sources and LLM vendors, keeping the "configured vendors only" convention.
- [ ] Leverage Taro's multi-platform ability to explore H5 / other mini program platforms.
- [ ] Finer-grained operations and cost dashboards.

---

## Support the project

The project is **open source on both GitHub and Gitee** — stars and issues are welcome:

- **GitHub**: <https://github.com/qianlongloves/CelebrityRadar>
- **Gitee**: <https://gitee.com/qianlonglove_admin/celebrity-radar>

If this project helps you, you can also buy the author a coffee:

<table align="center">
  <tr>
    <td align="center"><img src="./assets/screenshots/wechat-pay.jpg" width="200"/><br/><sub>WeChat Pay</sub></td>
    <td align="center"><img src="./assets/screenshots/alipay.jpg" width="200"/><br/><sub>Alipay</sub></td>
  </tr>
</table>

**Author**: 刘双乐 (Liu Shuangle) · **Email**: [qianlongloves@qq.com](mailto:qianlongloves@qq.com)

---

## Acknowledgements

This project stands on the shoulders of the following open-source projects:

- [Taro](https://github.com/NervJS/taro) (multi-platform framework), [React](https://reactjs.org/) (UI library), [Taro UI](https://github.com/NervJS/taro-ui) (component library)
- [zustand](https://github.com/pmndrs/zustand) (state), [zod](https://github.com/colinhacks/zod) (validation), [dayjs](https://day.js.org/) (dates)
- [wx-server-sdk](https://github.com/tencentcloudbase/wx-server-sdk) (CloudBase server SDK)

Other third-party dependencies and attributions are listed in [`NOTICE`](./NOTICE).

---

## Contributing / Security / License

Issues and PRs are welcome: small fixes can go straight to a PR, while larger changes are better discussed in an Issue first so effort is not wasted.

- **Contributing guide**: [`CONTRIBUTING.md`](./CONTRIBUTING.md) · **Code of conduct**: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- **Security policy** (**please do not report security issues in public Issues**): [`SECURITY.md`](./SECURITY.md)
- **Third-party attribution**: [`NOTICE`](./NOTICE) · **License**: **Apache License 2.0**, full text in [`LICENSE`](./LICENSE).

> The `license` field of `celebrity-radar/package.json` is `Apache-2.0`. Copyright © 2026 刘双乐.

---

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=qianlongloves/CelebrityRadar&type=Date)](https://star-history.com/#qianlongloves/CelebrityRadar&Date)

**If this project helps you, please give it a ⭐ Star.**

</div>
