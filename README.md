# Recipe Box

A shared family recipe app: save recipes from links, social posts, text and screenshots,
cook step by step with timers, plan meals and keep a shared grocery list by store.

Runs free on Cloudflare Workers + D1 + Workers AI.

## How it's built
- `src/server.js` — the Worker (API, recipe import, accounts)
- `src/app.html` — the whole phone app (one page)
- `themes.py` — color palettes and font styles
- `build.py` — bundles everything into `dist/worker.js` (what Cloudflare runs)
- `build_preview.py` — a stand-alone preview with example data, for trying changes

## Releasing an update
1. Edit `src/`, bump `APP_VERSION` in `src/server.js` and add a matching `CHANGELOG` entry in `src/app.html`.
2. Run `python3 build.py` and commit `dist/worker.js` with the sources.
3. Push to `main`. Cloudflare builds and deploys it within about a minute.

Rollback: Cloudflare dashboard → Worker → Deployments → Rollback.

Your recipes live in the D1 database, not in this repository, so deploys never touch them.
