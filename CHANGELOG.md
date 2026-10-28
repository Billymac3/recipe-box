# Recipe Box patch notes

Every release of Recipe Box, newest first. Each version lists what changed for people using the app, then the technical details behind it.

- The short version of these notes is shown in the app under **Me → What's new**. It comes from the `CHANGELOG` list in `src/app.html`.
- The **Commit** column links to the exact code each version shipped from.
- Recipes, lists and accounts live in the Cloudflare D1 database, not in this repository, so no release here has ever replaced or deleted anyone's data.

| Version | Went live | Commit | Headline |
|---|---|---|---|
| [3.6](#36--2026-10-27) | 2026-10-27 | [`1ffd335`](https://github.com/Billymac3/recipe-box/commit/1ffd335) | Find a photo removed |
| [3.5](#35--2026-10-27) | 2026-10-27 | [`7f218e9`](https://github.com/Billymac3/recipe-box/commit/7f218e9) | Find a photo searches Wikimedia from the phone |
| [3.4](#34--2026-10-27) | 2026-10-27 | [`cab4bca`](https://github.com/Billymac3/recipe-box/commit/cab4bca) | Find a photo uses Wikimedia Commons when there's no Pexels key |
| [3.3](#33--2026-10-27) | 2026-10-27 | [`ae20270`](https://github.com/Billymac3/recipe-box/commit/ae20270) | Gemini reads recipes first, in-app photo search, owner locked to one email |
| [3.2](#32--2026-10-27) | 2026-10-27 | [`c8c01a3`](https://github.com/Billymac3/recipe-box/commit/c8c01a3) | Timer alerts wake on demand; usage meter relabeled |
| [3.1](#31--2026-10-27) | 2026-10-27 | [`59ad411`](https://github.com/Billymac3/recipe-box/commit/59ad411) | Stronger contrast, depth, clearer meal plan |
| [3.0](#30--2026-10-26) | 2026-10-26 | [`1ef22ad`](https://github.com/Billymac3/recipe-box/commit/1ef22ad) | Separate households, lock-screen alerts, offline, usage meter, no-AI recipe sorter |
| [2.2](#22--2026-10-26) | 2026-10-26 | [`d65adde`](https://github.com/Billymac3/recipe-box/commit/d65adde) | Grocery Edit mode with in-place renaming |
| [2.1](#21--2026-10-26) | 2026-10-26 | [`a0e1197`](https://github.com/Billymac3/recipe-box/commit/a0e1197) | Any Store group, item links and photos |
| [2.0](#20--2026-10-25) | 2026-10-25 | [`88f005f`](https://github.com/Billymac3/recipe-box/commit/88f005f) | New look, cooking mode, timers, stores, press-and-hold |
| [1.0](#10--2026-10-21) | 2026-10-21 | before this repo | First version |

---

## 3.6 — 2026-10-27

**Why:** Find a photo still didn't work reliably after two fixes (3.4, 3.5), and Billy decided to remove it.

### What changed for people using the app
- Find a photo is gone: the button on the edit screen, the button at the top of recipes without a photo, and the search screen.
- Adding a photo works as before: upload your own from the edit screen.
- Any photo already added with Find a photo stays on its recipe. The credit line on those photos is no longer shown.

### Technical details
- Removed the `/api/photo-search` and `/api/photo-search/image` routes, the Pexels and Wikimedia code, the phone-side Wikimedia search, the search screen and its styles, and the preview's stand-in photo search.
- `src/app.html` and `build_preview.py` were restored from the 3.3 Gemini commit (`51444b8`), then re-applied:
  - the in-app "What's new" entries for 3.3–3.6
  - the preview fix that shows stored recipe photos (`imgFor` uses `photoUrl`)
- Kept: the `image_credit` and `image_credit_url` columns, which stay in the database (columns are never dropped) and are simply unused. Also kept: the owner lock (`OWNER_EMAIL`), Gemini, and the LICENSE.
- The `PEXELS_API_KEY` secret is no longer used. Don't add it. If it was added, it can be deleted from Cloudflare.
- Tested in the preview: uploading your own photo still saves and shows it, no Find a photo buttons remain, the Gemini usage card still works, and there are no page errors.
- `APP_VERSION` is now 3.6.

**Files:** `src/server.js`, `src/app.html`, `build_preview.py`, `dist/worker.js`, `README.md`

---

## 3.5 — 2026-10-27

**Why:** After 3.4, Find a photo still said "Photo search isn't answering right now." Wikimedia, like Openverse, turns away many requests that come from cloud servers such as Cloudflare Workers. Every search the app's server sent was refused before it reached the photo library.

### What changed for people using the app
- Find a photo works without any key. Your phone now searches Wikimedia Commons directly, the way a web browser would.
- If the photo library refuses a search, the message now includes its reply code, which makes problems easier to track down.

### Technical details
- `GET /api/photo-search`:
  - With a working `PEXELS_API_KEY`, it still searches Pexels on the server (the key must stay secret).
  - Otherwise it returns `{ useClient: true }`, and the app calls the MediaWiki API itself (`origin=*` for anonymous cross-site access).
  - If the server search errors, the app also falls back to searching Wikimedia itself.
- New in the app:
  - `wmSearch()`: rank order, photos only (JPEG, PNG or WebP), 500 px thumbnails, credit from the author and license with HTML stripped.
  - A `full` URL for saving: Wikimedia's 1280 px copy, or the original when it's 1280 px or smaller.
- Saving a Wikimedia photo downloads it straight from `upload.wikimedia.org`, then shrinks and compresses it in the app as before. If that download fails, it goes through `/api/photo-search/image` instead.
- Removed the server-side Wikimedia search added in 3.4. The server keeps the Wikimedia image lookup as a fallback for saving.
- Photo search and photo download errors now go to the Worker log, and their JSON errors include a `detail` field.
- Tested in a headless browser with stand-in Wikimedia replies:
  - Results are ranked and non-photos are dropped.
  - The 1280 px copy is used for large photos and the original for small ones.
  - A 47 KB source image was saved at about 5 KB.
  - Credits are cleaned up, and a 403 shows a clear message.
- `APP_VERSION` is now 3.5.

**Files:** `src/server.js`, `src/app.html`, `build_preview.py`, `dist/worker.js`

---

## 3.4 — 2026-10-27

**Why:** Right after 3.3 went live, Find a photo said "Photo search isn't answering right now." There was no Pexels key yet, so the app was using Openverse. Openverse puts requests from server networks behind a Cloudflare challenge page, and app servers can't pass it. Other developers have reported the same thing ([WordPress/openverse#5625](https://github.com/WordPress/openverse/issues/5625)), with no fix so far. Every search from the app failed.

### What changed for people using the app
- Without a Pexels key, Find a photo now uses **Wikimedia Commons**, the free, openly licensed photo library behind Wikipedia.
- With a Pexels key, Pexels is still tried first, and Wikimedia is the fallback.
- Credits read "Photo by … via Wikimedia Commons (license)" and link to the photo's page.

### Technical details
- Removed Openverse. Added `wikimediaSearch()`, which uses the MediaWiki API on commons.wikimedia.org:
  - It searches the file namespace for photos only (`filetype:bitmap`), 24 a page, using `gsroffset` for paging.
  - Results come back in search-rank order, and SVG and other non-photo files are dropped.
  - Each result has a 500 px thumbnail.
  - Credits come from the photo's author and license details, with HTML stripped.
- Ids are now `wm:<pageid>`. Saving looks the photo up again by page id and downloads Wikimedia's 1280 px copy, falling back to the original. The app then shrinks it to 1000 px as before.
- Requests send a descriptive user agent, as Wikimedia's rules ask, and use standard thumbnail widths.
- Search failures are now written to the Worker log with the reason, so the cause can be found from Cloudflare's logs.
- `WIKIMEDIA_BASE` is only for testing against a stand-in server.
- Tested against a stand-in Wikimedia API:
  - Results are ranked, non-photos are filtered out and credits are cleaned up.
  - Saving fetches the 1280 px copy and sends the credit to the app.
  - The right user agent is sent.
- Not tested against the real Wikimedia from here (blocked from this test setup). The first real search will be in the app.
- `APP_VERSION` is now 3.4.

**Files:** `src/server.js`, `src/app.html`, `dist/worker.js`, `README.md`

---

## 3.3 — 2026-10-27

**Why:** Cloudflare's free AI covers only about 30–65 AI recipe reads a day, shared by every household. Google's Gemini API has a much larger free allowance that's counted separately for each model. Using it first, and keeping Cloudflare as a backup, gives many more free imports, and the app keeps working if Google changes its terms.

### What changed for people using the app
- When the app owner adds a free Gemini key, Gemini reads links, captions and screenshots first.
- If Gemini can't help (its daily limit is used up, it's busy, or the key is wrong), Cloudflare's AI takes over. The no-AI sorter is still the last fallback, so importing always works.
- Clearly laid-out recipes are still sorted without any AI.
- **Usage section (app owner):**
  - A Gemini card shows today's reads and its status: not set up, working, daily limit reached (with the time it comes back), or a problem message.
  - A **Check Gemini** button sends one tiny test request.
  - The Cloudflare bar is relabeled **Cloudflare AI (backup)**.
  - The 7-day history counts AI reads from both.
- The privacy page now says recipe text and screenshots may go to Google Gemini, and that Google may use free-tier requests to improve its products.

### Technical details
**AI order** (the same for link, pasted text, Share-shortcut, screenshot-to-text and photo imports):
1. Gemini `gemini-3.5-flash-lite`
2. Gemini `gemini-flash-latest`
3. Workers AI (unchanged models)
4. the rule-based sorter

**Gemini calls**
- Each Gemini model has its own free daily quota, so trying two models roughly doubles the free capacity.
- New `gemini()` helper calls Google's `generateContent` REST API directly with `fetch`, sending the key in the `x-goog-api-key` header.
- Recipe extraction asks for JSON output (`responseMimeType: application/json`) and reuses the existing prompt and `normalizeAi()`.
- Screenshot-to-text asks for plain text.
- Images are sent as base64 `inline_data`. The image type (PNG, JPEG, WebP or HEIC) is detected from the file's first bytes.
- "Thinking" parts in Gemini's reply are ignored.

**Limits and errors**
- A daily-quota `429` marks that model as used up until midnight Pacific (Google's reset) and moves on to the next model.
- A per-minute `429` just moves on and isn't remembered.
- A bad key (`400`/`401`/`403`) stops trying Gemini for that request.
- Any other error moves on to the next option.
- The last Gemini result is saved in `settings` (`gemini:status`). Daily blocks are saved as `gemini_block:<model>`.

**Usage meter and endpoints**
- The usage meter counts `gemini_calls`. `/api/me` and `/api/admin/usage` include `gemini` and `geminiStatus` for the owner.
- New `POST /api/admin/gemini-test` (owner only).

**New Cloudflare settings (all optional)**
- `GEMINI_API_KEY` (secret) turns Gemini on.
- `GEMINI_MODELS` overrides the model order, comma-separated, so a retired model can be swapped without a code change.
- `GEMINI_BASE` is only for testing against a stand-in server.

### Find a photo (photo search)
**What changed for people using the app**
- A recipe's edit screen has a **Find a photo** button next to the upload button. It opens a full-screen search, filled in with the recipe's name, showing example photos in a 2-column grid with **Show more**.
- Tap a photo to use it. Recipes with no photo also get a **Find a photo** button at the top of the recipe page, which adds the photo straight away.
- The photographer's credit is shown on the recipe photo and links to the original.
- Saved photos are kept small: resized to 1000 px on the longest side and saved as JPEG at 75% quality. That's about 100–200 KB for a typical food photo, so storage stays well within the free 5 GB.

**Technical details**
- Photo sources:
  - **Pexels** when the `PEXELS_API_KEY` secret is set (free key; better food photos).
  - **Openverse** otherwise (openly licensed photos, no key needed).
  - If a Pexels search fails or finds nothing, Openverse is used.
- The search footer credits Pexels or Openverse, as their terms ask.
- New `GET /api/photo-search?q=&page=`. It returns 24 results a page, each with a thumbnail, credit, link and an id (`px:<id>` or `ov:<id>`).
- New `GET /api/photo-search/image?id=`. The server looks the photo up again by id, so only real search results can be fetched. It downloads the image (skipping originals over 8 MB in favor of the smaller copy) and passes it to the app, with the credit in `x-credit` / `x-credit-url` headers.
- The app shrinks and compresses the photo with the same `shrink()` step used for uploaded photos, then saves it through the existing `POST /api/photos`. Every saved photo lives in the app's own storage, so it keeps working if the original is taken down.
- New recipe columns `image_credit` and `image_credit_url`. They're added automatically and cleared when you upload your own photo or remove the photo.
- `PEXELS_BASE` / `OPENVERSE_BASE` are only for testing against stand-in servers.
- **Preview fix:** recipe photos stored in the preview now show up. This didn't affect the live app.
- **Tested:**
  - Search and save work in the preview, in light and dark themes. The typed form is kept while searching, and the credit shows after saving.
  - In a test, a 660 KB image was saved at 25–30 KB.
  - Against stand-in Pexels and Openverse servers: correct source with and without a key, fallback to the smaller copy, made-up ids refused, and sign-in required.

### Owner locked to one email
- The app owner (usage meter, starter links, household list, Check Gemini) is now only the account whose email matches the new `OWNER_EMAIL` secret, compared without regard to capital letters. Anyone who isn't the owner is refused by the server, whatever the app shows.
- Without `OWNER_EMAIL`, the owner flag already saved for the original install is used, so nothing changes until the secret is added.
- No account ever becomes owner automatically:
  - Removed the 3.0 "first account becomes owner" backfill step. The live database already ran it, so Billy is still owner.
  - New sign-ups always start as regular members.
- Tested: with no `OWNER_EMAIL`, a fresh copy has no owner. With it set, only that email can open usage.
- Added `LICENSE` (all rights reserved) and a copyright line in the source and README.


**Tested locally** against a stand-in Gemini server:
- Recipes come back from the first model.
- A daily-limited first model hands off to the second, and later imports skip the limited model.
- With both models limited, the import falls back to Cloudflare's AI.
- A per-minute limit isn't remembered.
- A bad key shows a clear error in the usage card.
- Screenshots send the right image type.
- A tidy recipe makes no AI call.
- Only the owner can use the test button.

`APP_VERSION` is now 3.3.

**Files:** `src/server.js`, `src/app.html`, `src/privacy.html`, `build_preview.py`, `dist/worker.js`, `LICENSE`, `README.md`

---

## 3.2 — 2026-10-27

**Why:** The usage meter showed about 800 "visits" by mid-morning with almost no use. Nearly all of them came from the server waking up every minute (1,440 times a day) to check for due timer alerts. With more households joining, that background count was too much.

### What changed for people using the app
- The server no longer checks for timer alerts every minute. It wakes only when a cooking timer with lock-screen alerts is running, at the exact moment that timer ends. A day with no timers adds nothing.
- On the usage meter, **App visits** is now **Server requests**, which is what it has always counted. A new line explains that each screen you open, photo you load and timer alert sent counts as one request.

### Technical details
- Removed the every-minute cron trigger (`[triggers] crons = []` in `wrangler.toml`, which also deletes the existing trigger on deploy) and the Worker's `scheduled()` handler.
- Added a SQLite-backed Durable Object, `TimerClock`, bound as `TIMERS` (migration tag `v1`, `new_sqlite_classes`). It runs as a single instance named `clock`.
  - `arm()` reads `MIN(fire_at)` from `push_timers` and sets the object's alarm for that time, but only if no alarm is set or the new time is sooner.
  - `alarm()` sends every due timer, deletes stale rows, re-arms for the next timer, then flushes usage counts.
  - `POST /api/push/timer` calls `arm()` after saving a timer. A cancelled timer needs no extra work: its alarm wakes, finds nothing due and re-arms for the next one.
- `fireTimers()` now sends what is due right away (within 1.5 s) and no longer sleeps inside the invocation until each timer's time, which the per-minute cron needed.
- Tested locally with `wrangler dev`:
  - Timers set 15 s and 30 s out each fired at their own time.
  - A timer that was cancelled early sent nothing and the next timer still fired on time.
- Expected load: about 0 background requests on idle days (down from 1,440). Durable Object requests have their own free allowance of 100,000 a day.
- `APP_VERSION` is now 3.2.
- Repository housekeeping:
  - Added this `CHANGELOG.md`, with the commit each version shipped from.
  - Updated `README.md`.
  - Removed a stray `__pycache__` build file and ignored it in `.gitignore`.

**Files:** `src/server.js`, `src/app.html`, `wrangler.toml`, `dist/worker.js`

---

## 3.1 — 2026-10-27

**Why:** Parts of the screen blended together. Cards sat on a page the same color as them, outlines were faint, grey text was hard to read, and the meals on each meal plan day looked like plain text.

### What changed for people using the app
**Contrast**
- Text boxes, buttons, chips and lists have clearer outlines in every color theme, in both light and dark mode.
- Grey secondary text is darker and easier to read.
- Main buttons and favorite stars stand out more.
- A stronger outline shows where you are when using a keyboard.

**Depth**
- Cards, lists, chips and buttons sit on a lightly tinted page with soft shadows.
- In dark mode, cards and lists are clearly lighter than the background.
- Section headings are bolder and have a color marker, and the active tab has a clear marker.

**Meal plan**
- Each planned recipe is its own colored tile with its photo (or first letter), name, cook time and category, an arrow to open it and × to remove it.
- Typed notes, like "Leftovers", get a dashed tile with a ✎ icon so they look different from recipes.
- Empty days are shaded slightly and say "Nothing planned".
- Today has a colored border and a "Today" tag.
- The add button now reads "+ Add a meal".

### Technical details
- `themes.py` gained `tune()`, which adjusts every palette's light and dark colors to minimum WCAG contrast ratios:

  | Pair | Minimum ratio |
  |---|---|
  | Body text | 12 |
  | Muted text | 6 |
  | Accent text | 6 (5 on accent-soft) |
  | Danger | 5 |
  | Text on accent | 4.5 |
  | Control edges | 3.0 |
  | Dividers | 1.8 |
  | Highlight text | 3.0 |

- New color tokens `--edge` and `--pop-ink`, and shadow tokens `--shadow` and `--shadow-sm`.
- Light themes tint the page so white cards stand off it (ratio 1.18). Dark themes lift card surfaces from the background (ratio 1.42).
- Fixed a tuning bug that pushed accent colors toward white because of an inverted lightness check.
- New meal plan markup in `renderPlan()`, plus CSS for `.meals`, `.meal`, `.meal.note`, `.meal-pic`, `.meal-t`, `.meal-go`, `.nothing`, `.day.free`, `.day.today` and `.today-pill`. Press-and-hold on a meal still works.
- Checked by screenshots in Tomato light and Blueberry dark. Tapping a meal tile opens its recipe.

**Files:** `themes.py`, `src/app.html`, `src/server.js`, `dist/worker.js`

---

## 3.0 — 2026-10-26

**Why:** The app was opening up to friends and family, who each need private recipes and lists. It also needed:
- Instagram and Facebook imports that work more often.
- A warning before reaching Cloudflare's free limits.
- A way to keep adding recipes when the day's free AI runs out.
- More of a real-app feel.

### What changed for people using the app
**Households**
- Each household has its own private recipes, grocery list, stores and meal plan.
- Name your household on the Me tab.
- The app owner can make a single-use **starter link** that sets up a new household for friends. Household invite links still add someone to your own household.

**Timers and offline**
- Timer alerts show on the lock screen even after you leave the app. Turn them on under Me → Timer sound.
- Recipes you've opened stay readable with no signal.

**Importing recipes**
- Instagram and Facebook links try harder to read the full caption.
- Import up to 6 screenshots at once for long captions.
- Neatly laid-out recipes, with headings for ingredients and steps, are sorted without AI.
- Adding recipes keeps working when the day's free AI is used up: messy text falls back to the same sorter.
- When AI recipe reading runs out, a clear message says so and shows when it resets.

**Usage meter (app owner only)**
- Shows requests, AI use and storage against Cloudflare's free limits, with the last 7 days.
- A warning appears on the Recipes screen at 70% of any limit.

**App feel and privacy**
- Launch screen, no accidental zooming or page bounce, smoother tab changes.
- A privacy page at `/privacy`, linked from the Me tab.

### Technical details
**Households and data walls**
- New `households` table and a `household_id` column on `users`, `recipes`, `grocery`, `plan` and `invites`.
- Every API query is scoped to the signed-in user's household.
- A one-time backfill moves all data from before 3.0 into household `h1`. The first account ever created becomes the app owner (`is_admin`).
- Signing up works three ways:
  - an invite link (joins that household)
  - a starter link (`starter_codes`, makes a new household)
  - the original `INVITE_CODE` secret (joins `h1`)
- Password reset codes only work within the same household.
- Grocery stores are saved per household (settings key `stores:<household>`).
- Tested: no reading, editing, deleting, clearing, resetting or planning across households.

**Lock-screen alerts**
- Web Push with VAPID (ES256) and aes128gcm payload encryption (RFC 8291), implemented with WebCrypto. The encryption matches the RFC example and the VAPID signature verifies.
- VAPID keys are generated once and stored in `settings`.
- New tables `push_subs` and `push_timers`.
- Every-minute cron trigger to send due alerts. This was replaced in 3.2.

**Offline**
- New service worker `src/sw.js`, served at `/sw.js`:
  - network-first with a cached fallback for the app and for `/api/me`, `/api/recipes`, `/api/grocery` and `/api/plan`
  - cache-first for photos and fonts
  - push and notification-tap handlers

**Usage meter**
- Request, AI-call and estimated neuron counts are kept in memory and flushed to a `usage` table. Model token rates turn tokens into neuron estimates.
- The app's own meter blocks AI at 99% of the daily allowance.
- Cloudflare's daily-limit error (4006) is recognized and shown as the "AI used up" message, not a generic error.
- New admin endpoints `/api/admin/usage` and `/api/admin/households`, and `/api/admin/starter` (POST / DELETE).

**Importing**
- New `src/parse.js`, a rule-based recipe sorter shared by the server and the app. It handles headings, bullets, emoji, quantities, servings and prep/cook/total times. A "confident" parse skips AI entirely.
- Social captions are read three ways:
  - Instagram: the embed page (`/embed/captioned/`)
  - Facebook: the `og:description` tag, fetched with a link-preview user agent
  - TikTok: oEmbed

**Other**
- `/privacy` page (`src/privacy.html`) and `/ads.txt`.
- AdSense banner support, shown only when the `ADSENSE_CLIENT` and `ADSENSE_SLOT` secrets are set. It is off by default.
- Fixed household rename appearing not to save: a background redraw overwrote typed text. `keepTyping()` now keeps unsaved input and focus.

**Files:** `src/server.js`, `src/app.html`, `src/sw.js`, `src/parse.js`, `src/privacy.html`, `build.py`, `build_preview.py`, `wrangler.toml`, `dist/worker.js`

---

## 2.2 — 2026-10-26

### What changed for people using the app
- On the grocery list, **Select** is now **Edit**. In Edit mode you can fix an item's name right in the list, as well as select several items to move or remove.
- You can also rename an item from its store tag panel.

### Technical details
- `PUT /api/grocery/:id` accepts `text`, so items can be renamed.
- New Edit-mode rows in `renderGrocery()` with inline inputs that save on blur or Enter.

**Files:** `src/app.html`, `src/server.js`, `build_preview.py`, `dist/worker.js`

---

## 2.1 — 2026-10-26

### What changed for people using the app
- Items that can be bought anywhere go in a new group shown first. It was briefly called "General List", then renamed **Any Store** the same day.
- Link a grocery item to the exact product. Its name shows in blue with a link icon.
- Add a photo to a grocery item, and tap the item to see the photo full screen.
- Tap an item's store tag to change its store, link or photo.

### Technical details
- New `link` and `photo_id` columns on `grocery`. `PUT /api/grocery/:id` accepts `store`, `link` and `photo_id`.
- An empty store means Any Store.

**Files:** `src/app.html`, `src/server.js`, `build_preview.py`, `dist/worker.js`

---

## 2.0 — 2026-10-25

The first version in this repository. Earlier versions were pasted into Cloudflare by hand. From here on, pushing to `main` deploys automatically through Cloudflare Workers Builds.

### What changed for people using the app
**Look**
- 6 color palettes (Tomato, Blueberry, Midnight, Beet, Sea Salt, Lemon) and 4 font styles, each with light and dark modes. Pick them on the Me tab.
- Recipes show as a photo grid, and recipe pages have a big **Start cooking** button.

**Cooking**
- Cooking mode: one step at a time in large text, with that step's ingredients, and the screen stays on.
- Step timers:
  - Steps that mention a time get a Start timer button.
  - Each timer is named after what's cooking, like "Roast · potatoes".
  - 6 alarm sounds, which play even with the ringer switch off.

**Groceries**
- Groceries are sorted by store (Costco, Walmart, Aldi, Kroger, Meijer, Target, Sam's Club, plus your own), with filters to shop one store at a time. Stores are not remembered per item.
- Select several items at once to move them to a store or remove them.
- Swipe left on an item to see who added it and when.

**Press-and-hold**
- Quick actions on recipes, ingredients, grocery items and meal plan entries.
- On a recipe, pick several ingredients and send them to the grocery list in one go.

**Accounts**
- Forgot password? Someone in the household can make you a reset code.
- Invite someone to the household with a one-time link you can text them.

**Me tab**
- Each section folds up, and only one opens at a time.
- New update history (What's new).

### Technical details
- New tables `reset_codes` and `invites`, and a `store` column on `grocery`. Schema changes are applied automatically on the first request after a deploy and never drop data.
- The "What's new" banner appears once per version. Phones upgrading from 1.0, which never stored a version, also see it (follow-up fix `2a00d97`).
- Fixes during development:
  - Press-and-hold no longer swallows the next tap after a redraw.
  - Timer pills no longer redraw every tick, which made Stop taps miss.
  - Grocery swipe no longer cuts off item names.

**Files:** whole project (`src/`, `themes.py`, `build.py`, `build_preview.py`, `wrangler.toml`, `README.md`)

---

## 1.0 — 2026-10-21

The first version, deployed by hand before this repository existed.
- Two logins sharing one recipe box.
- Save recipes from links, social posts, pasted text and screenshots.
- Shared grocery list and weekly meal plan.
- Scale servings.
- **Save Recipe** shortcut for the iPhone Share button.
