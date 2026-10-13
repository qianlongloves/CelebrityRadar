# Celebrity Radar

> A WeChat mini program: type any public figure's name → search recent public coverage online → let an LLM distill it into a structured report; and on top of that report grows a whole set of capabilities — a following feed, weekly digest, AI Q&A, opinion monitoring, membership payments, and quote-card sharing.
> Technically it is built as **Taro 3 (React + TypeScript) + WeChat CloudBase**.

[中文](./README.md) | **English**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/Node-16%20%7C%2018-339933.svg)

> ⚠ This is **complete, compilable and runnable code**, not a product you can put online for operation as-is. The repository ships **no usable credentials** — `appid`, the CloudBase environment ID and every upstream API key are placeholders or empty, and must be supplied by you.
>
> ⚠ This README lives at the **repository root**, but the mini program itself (`package.json`, `src/`, `cloudfunctions/`, etc.) is in the **`celebrity-radar/` subdirectory**; **the root has no `package.json`**. Therefore every `npm` command below must be run after `cd celebrity-radar` into the subdirectory first.

---

## Overview

Celebrity Radar is a "public-figure intelligence desk". What it does is straightforward: **turn a name into a readable, source-traceable, reusable profile.**

The user just types a name. The program first does a round of disambiguation to confirm who you mean; then it searches the internet for recent public coverage of that person, groups and compresses the collected material by event, and feeds it to an LLM in batches, finally producing a structured report. This report is not a few vague sentences of summary but an archive-like combination of information — identity & background, recent dynamics, stance & opinion, commercial ties, and risk signals, broken out section by section, with every item traceable to its original source rather than the LLM's free invention.

The project carries one key trade-off throughout its design: **reports are a globally shared cache**. The same person is generated only once and reused by all users, so the cost of a single generation is amortized across the whole user base; many "summary cards" on the client do not re-invoke the model either — they perform **local aggregation** on the existing cache. So the cost structure is controllable: the more people use it, the lower the per-user cost.

---

## Features

All the capabilities below are **actually implemented in the code**, not blueprints. They fall into three groups.

**Reports & search** is the core path. When generating a report, the program searches the web → groups and batch-injects material into the prompt → asks the LLM for a structured result → performs field validation and source-URL allow-list sanitization → renders it card by card. On top of the report, the client aggregates profile overview, stance & opinion, risk radar, and commercial-value cards — these cards **only read the cache and aggregate purely locally, producing zero new model calls**. It also supports side-by-side comparison of two figures, recataloging existing reports by topic into a topic knowledge base, and "source preview": every material item in a report points to its original link; sites whose business domain has been registered can open inline, while unregistered ones degrade to a material card plus "copy link" — behavior is always predictable.

**Following & opinion monitoring** is the second focus beyond the report. You can follow a figure; the system maintains a follow list, a change overview, and an aggregated feed, and summarizes the last seven days into a weekly digest every week; the hot board is produced automatically by AI every day. On the opinion side, the project provides three independent automation pipelines: **keyword alerts** (subscribe to a word; a scheduled daily search runs on that word; the client lists new items), **person risk watch** (watch a person; a daily scheduled search summarizes hits on judicial, tax, cooperation, rights-defense, and statement keywords — it only states what was hit and where the source is, with no rating or prediction), and **opinion event clustering & timeline** (a scheduled job clusters multiple sources of the same event into one event; the timeline is a separate secondary page). There is also AI Q&A: pick a figure and keep asking follow-up questions against their cached report, using a reasoning model — a different quota pool from "generate report".

**Account & monetization** is a complete loop. Favorites support four types (quote / report / dynamic / timeline) plus browsing history; the message center turns follow updates, weekly reminders, platform notices, and keyword alerts into a single timeline, with read state stored locally only. The membership system tiers the quotas, paired with WeChat Pay order placement, callback fulfillment, and refund reconciliation (optional); quote cards are rendered on the client via Canvas and shared directly, with native forwarding landing on the specific figure's report page.

> The client has **23 pages and 4 tabs** (Discover / Ask / Opinion / Mine); the cloud side has **14 cloud functions and 22 database collections**, explained in "Architecture" and "Deployment" below.

---

## Screenshots

The screenshots below all come from `assets/screenshots/` — real captures from the project, not placeholders:

<table align="center">
  <tr>
    <td align="center"><img src="./assets/screenshots/home.png" width="150"/><br/><sub>Home</sub></td>
    <td align="center"><img src="./assets/screenshots/hot-board.png" width="150"/><br/><sub>Hot board</sub></td>
    <td align="center"><img src="./assets/screenshots/feed.png" width="150"/><br/><sub>Feed</sub></td>
    <td align="center"><img src="./assets/screenshots/profile.png" width="150"/><br/><sub>Profile</sub></td>
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
    <td align="center"><img src="./assets/screenshots/monitoring.png" width="150"/><br/><sub>Monitoring</sub></td>
    <td align="center"><img src="./assets/screenshots/messages.png" width="150"/><br/><sub>Messages</sub></td>
    <td align="center"><img src="./assets/screenshots/mine.png" width="150"/><br/><sub>Mine</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="./assets/screenshots/favorites.png" width="150"/><br/><sub>Favorites</sub></td>
    <td align="center"><img src="./assets/screenshots/member.png" width="150"/><br/><sub>Member</sub></td>
    <td align="center"><img src="./assets/screenshots/model-tier.png" width="150"/><br/><sub>Model tier</sub></td>
    <td align="center"><img src="./assets/screenshots/comparison.png" width="150"/><br/><sub>Celebrity comparison</sub></td>
    <td align="center"><img src="./assets/screenshots/ai-qa.png" width="150"/><br/><sub>AI Q&A</sub></td>
  </tr>
</table>

---

## Tech stack

The frontend is written in **Taro 3 + React 18 + TypeScript**, built with webpack, UI components from Taro UI, state management with zustand, validation with zod, and dates with dayjs. The backend sits entirely on **Tencent CloudBase (WeChat Cloud Development)**: search, LLM calls, membership billing, and scheduled jobs all live in cloud functions with a Node 16.13 runtime; among them, the two functions that actually talk to the LLM — `aiProxy` and `hotBoardRefresh` — use `wx-server-sdk` and go through CloudBase's built-in AI channel.

A deployer-friendly detail: the repo's `.npmrc` already sets `legacy-peer-deps=true`, so `npm install` reads it automatically — no extra flags needed.

---

## Architecture

The system is split into two halves with a clear division of labor: **the client owns experience & aggregation; the cloud owns cost & authority.**

**Client-side**, besides pages and shared components, the core logic is collected under `utils`, organized by layers: search, reports, cache, membership & payments, opinion, and safety. The config directory is another key point: the bundled public config, the machine-local config, and the **single source of truth** for "who can use how much and what it costs" values are all centralized here, so the client and cloud never each write their own copy and slowly drift apart.

**Cloud-side**, the 14 cloud functions can be understood as a few groups. The most central is `aiProxy` — the **only entry point that incurs upstream cost** in the whole system; it proxies search and LLM calls, and before actually making a request it passes two gates: product quota and anti-abuse rate limiting, while also serving as the shared-cache write entry. Beside it are `quotaGuard` (the authority for quota counting) and `contentCheck` (content-safety moderation). Further out is a set of scheduled jobs, each responsible for the hot board, follow pushes, keyword alerts, risk watch, and opinion clustering, plus scheduled reconciliation for payment callbacks. Finally, three domains: payments (order placement & callbacks), users (the single writer of accounts & config), and ops (collection creation, operations write endpoint).

Expanding the complete process of one report generation: the client first plans the search terms and hands them to `aiProxy` for multi-source web search (Bocha primary, an optional second source as fallback); the returned material is grouped by event and compressed under a character budget, injected into prompts in batches, and handed back to `aiProxy` for structured generation; the result goes through field validation, length trimming, source-URL allow-list sanitization, and a "is the material sufficient" check, degrading if not; once it passes, it is persisted into `report_cache`, the globally shared cache, and the client renders it into card sections and aggregates the various summary cards. Across the whole path, one generation costs upstream only once; every subsequent read is free.

---

## Quick start

Before you start, prepare three things: **Node.js 16 or 18 LTS**, **WeChat DevTools**, and a **WeChat mini program appid** (with Cloud Development enabled). If you just want to get the frontend running locally and see the UI, a placeholder appid is fine.

Once ready, the flow is roughly:

```bash
cd celebrity-radar   # the root has no package.json, so enter the project subdirectory first

# Copy three "template → local file" pairs (all templates are gitignored and won't enter the repo)
cp src/config/local.example.ts          src/config/local.ts          # required
cp .env.example                         .env                         # required
cp project.private.config.example.json  project.private.config.json  # optional
# On Windows PowerShell, use Copy-Item instead of cp.

npm install          # install dependencies

npm run build:weapp  # production build; output goes to dist/
```

The one thing you cannot skip is `local.ts` — it is directly imported by `public.ts`, and the build errors out if you don't copy it; `.env` needs at least the CloudBase environment ID filled in. Then import the `celebrity-radar/` directory in WeChat DevTools — the project config already declares `miniprogramRoot` and `cloudfunctionRoot`. During development you can tick "Do not verify valid domains" under "Details → Local Settings" to get going first — since the client never calls upstream directly, this setting doesn't affect functionality.

---

## Configuration

Configuration is designed into three kinds, each with its own **single source of truth**, to avoid the classic "the same value written twice in two places and slowly drifting apart" problem.

**The first kind is `.env`**, copied from `.env.example`, the **shared** single source of truth for both client and cloud. Its keys fall into several tiers: required are the CloudBase environment ID (`TCB_ENV_ID`) and the primary search source Bocha's key (`BOCHA_API_KEY`); optional are a second search source (SERPER or TAVILY, either one), several external LLM vendor keys (whichever you configure appears on the "Mine" page; configure none and only the default "CloudBase AI" remains — usable with zero keys), the default vendor and default quality tier, the three subscribe-message template IDs, the payment-related sub-merchant ID and callback environment, and the appid/secret for index creation. There is also a class of ops tokens — when unconfigured, the corresponding write operations are **rejected outright** (fail-closed rather than open), while read-only inspection is unaffected. Plus two explicit switches: one for the quota gate (empty means on) and one for upstream raw logging (off by default).

The beauty of this `.env` is its **single source**: at cloud deploy time it is read through `cloudbaserc.json` and fixed into the function config; at client build time the build script reads **the same** `.env` and injects compile-time constants. So values that "must be identical across client and cloud" — like the CloudBase environment ID and the subscribe template IDs — only need to be filled in once, and structurally cannot diverge. The only cost is re-running `npm run build:weapp` after changing them, because they are compiled into the bundle and hot reload won't pick them up.

**The second kind is the client-only local config `local.ts`**, whose template is `local.example.ts`, also kept out of the repo. It holds only two kinds of "machine-specific" things: the business-domain allow-list (which affects whether source preview can open inline), and six debug switches (open up the quota & cooldown gates, print raw IO, and open up restricted-search interception). The principle is clear: **secrets never enter the client bundle** — API keys and tokens stay in `.env` and flow to cloud functions only; and even if the `disable*` switches here are opened, they only affect the client's experience-layer checks — the cloud entry still checks again.

**The third kind is the "config source → cloud function copies" sync.** Values like membership benefits, the price table, report parameters, search depth, opinion tier limits, and user default config — "who can use how much, what it costs, where the cost boundary is" — are written only once in `benefits.ts` and `user-defaults.ts`. But cloud functions are packaged independently and can't read the client's TypeScript in the cloud, so `npm run config:sync` generates them into copies in each cloud function directory, and `npm run config:check` verifies they match (the tests pin this too). Separately, the model tier table `llm.config.js` exists in both `aiProxy` and `hotBoardRefresh` and must be kept word-for-word identical by hand.

---

## Deployment

The order matters: **create collections & permissions first, then deploy the cloud functions**, otherwise the reads/writes inside functions fail silently. And membership payments, subscribe pushes, and the scheduled jobs are all **optional** — it's best to get the "search a name → generate a report" path working first, then gradually turn on the rest.

**Step one is the CloudBase environment**: enable it in DevTools and put the environment ID into `.env`.

**Step two is collections & permissions** — 22 collections in total, with the schema source of truth in `dbInit`'s `schema.js`. An easy-to-miss point: **permissions cannot be set programmatically** — they must be configured by hand, collection by collection, in the CloudBase console; `dbInit` can only create collections and create/update indexes. There are four permission tiers: owner read/write only (7 collections — users, follows, favorites, history, events, keyword subscriptions, event status), owner reads but cannot write (three quota collections and orders — 4 total), everyone reads but the client cannot write (8 shared-data collections — report cache, hot board, feed cache, etc.), and the client cannot read or write at all (the membership authority table, anti-abuse counters, and deep-dive quota — 3 total). Three spots are the most error-prone: the three quota collections must be "owner reads but **cannot write**", otherwise users can edit their own quota — and **deploy `quotaGuard` first, then tighten permissions**; the membership table and anti-abuse counter table must be completely unreadable/unwritable by the client, because they are server-side authorities; the report cache and feed cache are shared caches — deploy the write-capable `aiProxy` first, then tighten to read-only once old-version coverage is high enough.

**Step three is deploying the cloud functions**, using the CloudBase CLI (`tcb`); timeouts, environment variables, and triggers are all declared in `cloudbaserc.json`. One important reminder: if you switch to DevTools' "Upload and deploy", it **uploads code only and does not read `cloudbaserc.json`** — environment variables, timeouts, and triggers all have to be added by hand in the console; and the default function timeout is only 20 seconds, while report generation is a long task — be sure to raise `aiProxy`'s timeout to 60 seconds, or the platform cuts it off. The 14 cloud functions each have their role: `aiProxy` proxies keys, passes gates, and writes the cache; `quotaGuard` manages quota; `contentCheck` does moderation; five scheduled jobs handle the hot board, follow pushes, keyword alerts, risk watch, and opinion clustering respectively (clustering only reads the DB, zero upstream cost); payments are `payCreate` (order) and `payCallback` (callback & after-sales); `userInit` is the single writer of accounts & config; `dbInit`, `adminOps`, and `userBackfill` are one-off ops functions.

**Step four is the scheduled triggers**: cron uses Tencent SCF's seven-field format, brought online by `tcb fn deploy`, or created by hand if you upload via DevTools. Six triggers land between 06:30 and 10:00, plus payment reconciliation once an hour.

**Step five is the `dbInit` ops function**. It defaults to read-only inspection (see what's missing first); only with an explicit token and `apply` will it actually create collections and indexes; permissions still have to be set by hand. After you're done, it's recommended to delete this function to avoid leaving an attack surface.

**Step six is domains**. Server (request) domains **need no configuration** — search and LLM calls are proxied by cloud functions, and cloud-function egress is not subject to the mini program domain allow-list; the cloud DB and functions go through `wx.cloud` and need no domain either. Business domains only affect whether "source preview" can open inline; unregistered ones take the degradation path — predictable behavior.

**Step seven is subscribe messages (optional)**. Leaving the three default template IDs empty is the **normal state**: the client doesn't render the auth button, and the three scheduled jobs only write in-app data and skip pushes — in-app features work fully. To enable push, follow four steps under your own service category: apply for three different templates → fill them into `.env` → rebuild the client and redeploy the three functions → authorize on a real device. One easy pitfall: **the three templates must be different**, because WeChat one-time subscriptions are "one authorization pushes one message" — three scheduled jobs sharing one template means the first one eats the authorization and the rest error out.

---

## Tests

Tests run in Node — **no cloud connection and no keys needed**. `npm test` first compiles the source into the test directory with `tsc`, then runs all cases; the harness prepares stubs for Taro and the global `wx`, so pure logic can be asserted directly without a mini program environment.

The cases come in two kinds: **static constraints** pin down "the source must / must not contain a certain pattern" — e.g. the cloud gates and client semantics must agree, the config source and cloud function copies must match, and the two hand-synced model tier tables must be word-for-word identical; and **pure-function assertions** directly assert the input/output of side-effect-free functions like quota, cache, report sanitization, and event clustering. Besides these, `npm run config:sync` syncs the source into copies and `npm run config:check` verifies without writing (errors on any diff) — both are commands to run routinely after changing config.

---

## Cost & compliance

**Cost**: the largest single expense is report generation — one generation triggers search-term planning, multi-source web search, and batched LLM generation. Next are the scheduled scan jobs, which really call upstream every round (only opinion clustering reads the DB without network — zero cost). To cap the cost, the project has an "event-driven deep dive" design: keyword alerts and risk watch only run one extra query for a hit object **when a scan hits**, gated by a three-layer budget (one query per hit, at most six per round, at most sixty per day). The source of truth for these caps, quotas, and report budgets is `benefits.ts` — change it → sync → redeploy.

**Compliance**: the deployer must confirm and take responsibility. The project has three layers of political/military interception built in: local static interception (a hit refuses outright and sends no network request), the disambiguation prompt rule, and the report prompt rule; the name list is an empty array in the repo and must be filled in before going live. AI Q&A goes through content-safety moderation via a cloud call. Reports are permanently labeled "AI-generated, for reference only". To stress again: **this repository provides no compliance endorsement**.

---

## Disclaimer

All reports, rankings, and opinion summaries produced by this project are **auto-generated by an LLM from public web material** — essentially an "AI snapshot of public information at a point in time", for informational reference only, and **do not constitute factual statements, evaluations, or positions about any real person or organization**.

The political/military interception and content-safety moderation built in are **technical safeguards only**, not a compliance endorsement — **content safety and compliance responsibility after going live rests with the deployer under local laws and regulations**. The name lists and interception word lists in the repo are empty placeholders to be filled in before deployment.

In one sentence: **this repository provides only the technical implementation and engineering code — it provides no content, data, or operational service, and assumes no responsibility for any consequences arising from its use.**

---

## Directory structure

```text
celebrity-radar/                ← repository root (no package.json)
├── README.md / README.en.md    Chinese / English docs
├── LICENSE / NOTICE            license (Apache-2.0) and third-party attributions
├── CONTRIBUTING.md  SECURITY.md  CODE_OF_CONDUCT.md
├── assets/screenshots/         UI screenshots
└── celebrity-radar/            ← the mini program (run npm commands here)
    ├── src/                    source (pages / components / utils / config / stores / styles / types)
    ├── cloudfunctions/         14 cloud functions (dbInit/schema.js is the schema source of truth)
    ├── scripts/sync-config.js  config source sync
    ├── test/                   tests (cases / harness / run.js)
    ├── config/                 Taro build config
    ├── cloudbaserc.json        cloud function / env var / trigger declarations
    ├── project.config.json     DevTools project config
    ├── package.json            dependencies and scripts
    └── .env.example            deploy secret template (copy to .env)
```

---

## FAQ / known limitations

- **Push unavailable**: subscribe-message templates must be applied for under **your own service category**; some categories simply can't get the matching template — this is a limitation of the deployment environment, not a missing feature. When the templates are left empty, the system degrades to "write in-app data only" and in-app features are unaffected.
- **Freshness**: reports and rankings are essentially "AI snapshots of public material at a point in time", not real-time. Reports are a globally shared cache; changing parameters only affects newly generated reports, and old cache is not rebuilt automatically unless you manually tap "Regenerate".
- **Client-side caps are not a security boundary**: the client's quota, debug switches, and monitoring caps are experience-layer only and can be bypassed by repackaging; what really guards the cost boundary is the cloud — the anti-abuse counter table and the membership authority table are judged only on the cloud.

---

## Support the project

The project is open-sourced on **Gitee**: [`qianlonglove_admin/celebrity-radar`](https://gitee.com/qianlonglove_admin/celebrity-radar) — stars and issues are welcome. If this project helps you, you can also buy the author a coffee:

<table align="center">
  <tr>
    <td align="center"><img src="./assets/screenshots/wechat-pay.jpg" width="200"/><br/><sub>WeChat Pay</sub></td>
    <td align="center"><img src="./assets/screenshots/alipay.jpg" width="200"/><br/><sub>Alipay</sub></td>
  </tr>
</table>

**Author**: Liu Shuangle (刘双乐) · **Email**: [qianlongloves@qq.com](mailto:qianlongloves@qq.com)

---

## Acknowledgements

This project stands on the shoulders of the following open-source projects:

- [Taro](https://github.com/NervJS/taro) (multi-platform framework), [React](https://reactjs.org/) (UI framework), [Taro UI](https://github.com/NervJS/taro-ui) (component library)
- [zustand](https://github.com/pmndrs/zustand) (state management), [zod](https://github.com/colinhacks/zod) (validation), [dayjs](https://day.js.org/) (date handling)
- [wx-server-sdk](https://github.com/tencentcloudbase/wx-server-sdk) (CloudBase server SDK)

See [`NOTICE`](./NOTICE) for the rest of the third-party dependencies and attributions.

---

## Contributing / Security / License

Issues and PRs are welcome: small fixes can go straight to a PR; for larger changes, discuss the direction in an issue first to avoid wasted effort.

- **Contributing guide**: [`CONTRIBUTING.md`](./CONTRIBUTING.md) · **Code of Conduct**: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- **Security policy** (**do not report security issues in a public issue**): [`SECURITY.md`](./SECURITY.md)
- **Third-party attributions**: [`NOTICE`](./NOTICE) · **License**: **Apache License 2.0**, full text in [`LICENSE`](./LICENSE).

> The `license` field in `celebrity-radar/package.json` is `Apache-2.0`. Copyright: © 2026 Liu Shuangle (刘双乐).
