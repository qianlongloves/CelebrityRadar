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

- **One cache, shared by everyone** — reports are a **globally shared cache**: each figure is generated once, and the client's summary cards **aggregate purely locally, producing zero new model calls**. The more users, the lower the per-user cost.
- **Every statement is traceable** — output goes through **source-URL allow-list sanitization**, and every material item points to its original source; registered business domains open inline, unregistered ones degrade to a material card + "copy link" — always predictable.
- **Costs have a hard ceiling** — the *only* entry point that incurs upstream cost is `aiProxy`, and every request passes two gates first (product quota + anti-abuse rate limiting); event-driven deep dives are further capped by a three-layer budget (1 query per hit / ≤ 6 per round / ≤ 60 per day).
- **Compliance built in, not bolted on** — a full PIPL toolkit ships with the code: consent gate (`consent-gate` / `privacy-gate`), consent withdrawal, personal-data export and account deletion, with the impact assessment filed in [`doc/`](./celebrity-radar/doc/个人信息保护影响评估.md).
- **Verifiable engineering quality** — **1200+ test cases** (static constraints + pure-function assertions); `npm test` needs **no cloud connection and no keys**.

---

## Features

All the capabilities below are **actually implemented in the code**, not blueprints. They fall into three groups.

### 1. Reports & search (core path)

- **Generation pipeline**: web search → material grouped by event and compressed under a character budget → batched prompt injection → structured LLM output → field validation + length trimming + source-URL allow-list sanitization → rendered card by card.
- **Summary cards**: profile overview, stance & opinion, risk radar, commercial value — **cache-read only, purely local aggregation, zero model calls**.
- **Figure comparison**: put two public figures side by side (cache-read only, zero model calls).
- **Topic knowledge base**: recatalog existing reports by topic into reusable entries.
- **Source preview**: every material item links to its origin; sites with a registered business domain open inline, others degrade to a material card + "copy link".

### 2. Following & opinion monitoring

- **Following feed**: a follow list, a change overview and an aggregated feed (filter/search by figure or domain).
- **Weekly digest & hot board**: the last seven days are summarised weekly; the hot board is produced by AI daily.
- **Keyword alerts**: subscribe to a word; a scheduled daily search runs on it and the client lists new items.
- **Person risk watch**: watch a person with a daily scheduled search; hits on judicial, tax, cooperation, rights-defense and statement keywords are summarised — it **only states what was hit and where the source is, with no rating or prediction**.
- **Opinion event clustering & timeline**: a scheduled job clusters multiple sources of the same event into one; the timeline is a separate secondary page.
- **Daily opinion brief**: aggregates the day's follow updates, keyword alerts and risk signals into risk-category distribution and impact figures (pure client-side aggregation, zero model calls).
- **AI Q&A**: ask follow-up questions against a figure's cached report using a reasoning model — a **separate quota pool** from report generation.

### 3. Account & monetization

- **Favorites & history**: four favorite types (quote / report / dynamic / timeline) plus browsing history.
- **Message center**: follow updates, weekly reminders, platform notices and keyword alerts in one timeline, with read state stored locally only.
- **Membership**: tiered quotas with WeChat Pay order placement, callback fulfillment and refund reconciliation (optional).
- **Quote cards**: rendered on the client via Canvas, shared with native forwarding, landing on the specific figure's report page.

> The client has **22 pages and 4 tabs** (Discover / Ask / Opinion / Mine); 4 tab pages stay in the main package and the other 18 secondary pages are pushed down into the `package/` subpackage to keep the main bundle small (see `app.config.ts`). The cloud side has **14 cloud functions and 23 database collections**, detailed in "Architecture" and "Deployment" below.

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

The **14 cloud functions** on the cloud side are grouped as follows:

| Group | Functions | Role |
|---|---|---|
| Core egress | `aiProxy` | The **only source of upstream cost**: proxies search and LLM calls, passes the "product quota + anti-abuse rate limit" gates first, and is also the shared-cache write entry |
| Gates & security | `quotaGuard`, `contentCheck` | Authority for quota counting / automated content-safety screening |
| Scheduled jobs | `hotBoardRefresh`, `notifyFollowUpdates`, `keywordAlert`, `riskWatch`, `opinionCluster` | Hot board / follow push / keyword alerts / risk watch / opinion clustering (clustering reads only — zero upstream cost) |
| Payment | `payCreate`, `payCallback` | Order placement / callback and reconciliation |
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
2. **Collections & permissions** (23 collections; the schema source of truth is `dbInit/schema.js`).
3. **Deploy cloud functions** (with the CloudBase CLI, `tcb`).
4. **Scheduled triggers** (shipped along with `tcb fn deploy`).
5. **The `dbInit` ops function** (read-only inspection first → create collections and indexes only with token + `apply`).
6. **Domains** (no server domain needed).
7. **Subscription messages** (optional).

**Step two is collections and permissions.** One easily missed point: **permissions cannot be set programmatically** — they must be configured by hand, collection by collection, in the CloudBase console; `dbInit` can only create collections and add/modify indexes. There are four tiers:

| Tier | Count | Details |
|---|---|---|
| Creator-only read/write | 7 | Users, follows, favorites, history, events, keyword watches, event status |
| Self read-only | 4 | Three quota tables (refresh / generate / ask) + orders |
| Public read, client write forbidden | 9 | Report cache, hot board, feed cache, keywords, risk scans / signals / logs, opinion events, person assets |
| Client fully denied | 3 | Membership authority table, upstream call counter, deep-dive quota |

Three spots are the most error-prone: the three quota tables must be "self-readable but **not writable**", or users could edit their own quota — and **deploy `quotaGuard` before tightening them**; the membership table and anti-abuse counter must be fully client-denied since they are server-side authority; and the report cache and feed cache are shared caches, so deploy the write-enabled `aiProxy` first and only tighten them to read-only once the old version has been fully replaced.

**Step three is deploying cloud functions** with the CloudBase CLI (`tcb`); timeouts, environment variables and timers are declared in `cloudbaserc.json`. A key warning: if you instead use DevTools' "upload and deploy", it **uploads code only and ignores `cloudbaserc.json`** — environment variables, timeouts and triggers must be added by hand in the console. Also, cloud functions default to a 20-second timeout; report generation is a long task, so raise `aiProxy` to 60 seconds or the platform will cut it off.

**Step four is scheduled triggers.** The cron uses Tencent SCF's seven-field format, and `tcb fn deploy` ships them along with the code; with DevTools upload you must create them manually. The six triggers land between 06:30 and 10:00, plus an hourly payment reconciliation.

**Step five is the `dbInit` ops function.** It is read-only inspection by default (see what is missing); only with an explicit token and `apply` does it actually create collections and indexes — permissions are still manual. After it runs, deleting the function is recommended so it does not remain as an attack surface.

**Step six is domains.** **No server domain is needed** — search and LLM calls are proxied by cloud functions, which are not subject to the mini program domain allow-list, and CloudBase database and functions go through `wx.cloud` without a domain either. The business domain only affects whether source preview opens inline; unregistered links simply take the degraded path, with predictable behaviour.

**Step seven is subscription messages (optional).** Leaving all three template IDs empty is a **normal state**: the client hides the authorization button, the three scheduled jobs only write in-app data and skip push, and everything in-app works. To enable push you must follow four steps for your own service category: apply for three different templates → fill them into `.env` → rebuild the client and redeploy the three functions → authorize on a real device. One easy pitfall: **the three templates must differ**, because WeChat one-off subscriptions grant exactly one push per authorization; sharing one template across three jobs means the first job consumes the grant and the others error out.

---

## Tests

Tests run in Node, with **no cloud connection and no keys**. `npm test` first compiles the sources with `tsc` into the test directory, then runs every case; the harness stubs Taro and the global `wx` so pure logic can be asserted directly without a mini program environment.

Cases come in two kinds:

- **Static constraints**: pin down "this source must / must not contain this pattern" — e.g. cloud gates and client semantics must agree, config sources of truth and cloud-function copies must agree, and the two hand-synced model-tier tables must be character-identical.
- **Pure-function assertions**: assert inputs and outputs directly for side-effect-free functions such as quota, cache, report sanitization and event clustering.

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
    │   └── package/            18 subpackage pages (report / figure / feed / weekly / events / alerts …)
    ├── cloudfunctions/         14 cloud functions (dbInit/schema.js is the schema source of truth)
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
