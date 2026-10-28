# Recipe Box

A shared family recipe app.
- Save recipes from links, Instagram and Facebook posts, pasted text and screenshots.
- Cook step by step with named timers and lock-screen alerts.
- Plan meals and keep a shared grocery list by store.

Each household (a family or group of friends) has its own private recipes and lists.

It runs free on Cloudflare (Workers, D1, Workers AI and Durable Objects), with optional Google Gemini for recipe reading.

**Patch notes:** see [CHANGELOG.md](CHANGELOG.md) for every release, what changed and why.

## How it's built
| File | What it is |
|---|---|
| `src/server.js` | The Worker: API, accounts and households, recipe import, push alerts, usage meter, `TimerClock` alarm |
| `src/app.html` | The whole phone app (one page), including the in-app "What's new" list (`CHANGELOG`) |
| `src/parse.js` | Recipe sorter that needs no AI, shared by the server and the app |
| `src/sw.js` | Service worker: offline copies of the app and data, and lock-screen notifications |
| `src/privacy.html` | Privacy page served at `/privacy` |
| `themes.py` | Color palettes (light and dark), font styles, and contrast tuning |
| `build.py` | Bundles everything into `dist/worker.js` (what Cloudflare runs) |
| `build_preview.py` | A stand-alone preview with example data (`dist/preview.html`, not committed) |
| `wrangler.toml` | Cloudflare settings: D1 database, AI, the `TIMERS` Durable Object |

## Cloudflare settings
- **Bindings:** `DB` (D1 database `recipe-box`), `AI` (Workers AI), `TIMERS` (Durable Object `TimerClock`).
- **Secrets** (Worker → Settings → Variables and Secrets, never stored here):
  - `INVITE_CODE` lets someone join the first household.
  - `ADSENSE_CLIENT` and `ADSENSE_SLOT` are optional. They turn on the banner ad.
  - `OWNER_EMAIL` is the only account that can see usage and use the owner tools. Nobody is made owner automatically.
  - `PEXELS_API_KEY` is optional. It's a free key from pexels.com/api that improves Find a photo. Without it, photos come from Openverse.
  - `GEMINI_API_KEY` is optional. It's a free key from Google AI Studio that makes Gemini read recipes first, with Cloudflare's AI as the backup. `GEMINI_MODELS` (a comma-separated list) can override which Gemini models are tried, in order.
- **No cron triggers.** Timer alerts use a Durable Object alarm that wakes only when a timer is due.
- **The database updates itself.** Schema changes run on the first request after a deploy. They only add tables and columns and never delete data.

## Branches
- `main` is live. Every push to it deploys automatically through Cloudflare Workers Builds.
- `next` holds work in progress, previewed before it ships.

## Releasing an update
1. Edit `src/` on `next` and bump `APP_VERSION` in `src/server.js`.
2. Add a short entry to `CHANGELOG` in `src/app.html` (shown in the app) and a detailed entry to `CHANGELOG.md`.
3. Run `python3 build.py` and commit `dist/worker.js` along with the sources.
4. Merge `next` into `main` and push. Add the release's commit to the table at the top of `CHANGELOG.md`.

**Rollback:** Cloudflare dashboard → Worker → Deployments → Rollback.

Your recipes live in the D1 database, not in this repository, so deploys never touch them.

## License
Copyright (c) 2026 Billy McIntyre. All rights reserved. This code is not open source. See [LICENSE](LICENSE).
