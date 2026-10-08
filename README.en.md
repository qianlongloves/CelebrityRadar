# Celebrity Radar

> A WeChat Mini Program that turns a celebrity's name into a structured intelligence report:
> it searches recent public news on the web, then has an LLM distil the material into
> quotes, recent updates, commentary, a timeline and cited sources.
>
> Stack: Taro 3 (React) + Taro UI ｜ Backend: Tencent CloudBase (WeChat Cloud Development)
> License: [Apache-2.0](./LICENSE) ｜ Full documentation (Chinese): [README.md](./README.md)

---

## What it does

| Module | Capability |
|---|---|
| Discovery | Search box + trending-domain cards; custom tab bar (Discover / Following / Favorites / Me) |
| Disambiguation | Candidate list when a name is ambiguous (with domain chips), producing a stable `personKey` such as `雷军#tech` |
| Report | Six card sections — intro / recent updates / quotes / AI commentary / timeline / sources — plus three purely client-side cards (stance & sentiment, keyword cloud, heat trend) that cost no model calls |
| Following | Follow list + aggregated feed with pull-to-refresh (cached per account, ≤10 refreshes a day) |
| Weekly digest | One-tap summary of the last 7 days for everyone you follow |
| Share card | Quote poster rendered on-device with Canvas 2D; the image is never uploaded |
| Favorites / History | Deduplicated quotes & reports, plus the last 50 viewed people |
| Membership | Freemium: 3 generations/day free, 30 for members. Cache hits are never counted |
| Moderation | Sensitive-name blocking, source-URL allow-list, and an "AI-generated, for reference only" label on every report |

---

## Quick start

Requirements: Node 16 / 18 (LTS recommended) and an appid with Cloud Development enabled.

```bash
git clone <repository-url>
cd celebrity-radar/celebrity-radar

cp src/config/local.example.ts src/config/local.ts   # required, see Configuration below
npm install

npm run dev:weapp     # watch mode → dist/
npm run build:weapp   # production build → dist/
npm test              # local unit tests, no cloud needed
```

Import the `celebrity-radar/` directory into WeChat DevTools
(`miniprogramRoot: dist/`, `cloudfunctionRoot: cloudfunctions/`).

---

## Configuration

Everything that differs per deployment lives in files that are **not** committed:

| File | Tracked | Purpose |
|---|---|---|
| `src/config/public.ts` | yes | Deployment-independent config: model names, available models, `memberOnly` tiers |
| `src/config/local.example.ts` | yes | Template for local config (placeholder values only) |
| `src/config/local.ts` | no | **Your** values: cloud env ID, subscription template IDs, web-view domain allow-list, local debug switches |
| `.env.example` | yes | Template for cloud-function deploy secrets (read by `cloudbaserc.json` as `${env.XXX}`) |
| `project.private.config.example.json` | yes | Template for WeChat DevTools private config (your local appid) |

`src/config/public.ts` imports `./local`, so **the build fails until you create `local.ts`**.

Cloud functions need at least `DEEPSEEK_API_KEY` and `BOCHA_API_KEY` in their environment.

---

## Deployment

See [`doc/开源部署指南.md`](./doc/开源部署指南.md) (Chinese) for the full walkthrough:
opening a CloudBase environment, deploying the seven cloud functions plus the `dbInit`
maintenance tool, creating the 12 collections, setting collection permissions manually
and building indexes, plus a troubleshooting table and a pre-launch compliance checklist.

---

## License and third parties

Licensed under the [Apache License 2.0](./LICENSE). Third-party dependencies, services and
asset attribution are listed in [`NOTICE`](./NOTICE).

This repository contains **no usable credentials**: every key, cloud environment ID and
appid is either a placeholder or must be supplied by you. Upstream services
(CloudBase, DeepSeek, Bocha search, WeChat Pay) are billed to whoever deploys it.
