// Recipe Box — a free, self-hosted recipe keeper for families.
// Runs as one Cloudflare Worker with a D1 database (binding: DB) and
// Workers AI (binding: AI). Each household's data is kept separate.
// Secrets: INVITE_CODE (joins the first household), optional ADSENSE_CLIENT /
// ADSENSE_SLOT (turn on the banner ad), optional GEMINI_API_KEY (Google's free AI,
// tried before Workers AI), GEMINI_MODELS (comma list to override the model order) and
// PEXELS_API_KEY (better photo search; Wikimedia Commons is used without it) and OWNER_EMAIL
// (the only account that can see usage and run the admin tools).
// Copyright (c) 2026 Billy McIntyre. All rights reserved. See LICENSE.
// A Durable Object alarm (binding: TIMERS) wakes only when a cooking timer is due.
import { DurableObject } from "cloudflare:workers";

const APP_HTML = __APP_HTML__;
const SW_JS = __SW_JS__;
const PRIVACY_HTML = __PRIVACY_HTML__;
const ICON_180 = __ICON180__;
const ICON_512 = __ICON512__;

// Bump this with every release and add a matching entry to CHANGELOG in app.html.
const APP_VERSION = "3.4";
const CATS = ["Breakfast","Mains","Sides","Soups","Salads","Baking","Desserts","Drinks","Snacks","Other"];
const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, quick_key TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT, prep_min INTEGER DEFAULT 0, cook_min INTEGER DEFAULT 0, servings TEXT, ingredients TEXT, steps TEXT, notes TEXT, tags TEXT, source_url TEXT, source_name TEXT, image_url TEXT, photo_id TEXT, favorite INTEGER DEFAULT 0, added_by TEXT, created INTEGER, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS grocery (id TEXT PRIMARY KEY, text TEXT NOT NULL, recipe_id TEXT, checked INTEGER DEFAULT 0, added_by TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS plan (id TEXT PRIMARY KEY, day TEXT NOT NULL, recipe_id TEXT, note TEXT, added_by TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, mime TEXT, data TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`
];
// columns added after the first release; adding one that already exists just errors and is ignored
const MIGRATIONS = [`ALTER TABLE grocery ADD COLUMN store TEXT`,
  `CREATE TABLE IF NOT EXISTS reset_codes (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS invites (token_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires INTEGER NOT NULL, used_by TEXT)`,
  `ALTER TABLE grocery ADD COLUMN link TEXT`,
  `ALTER TABLE grocery ADD COLUMN photo_id TEXT`,
  // 3.0: separate households, admin, usage meter, lock-screen timer alerts
  `CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, name TEXT, created INTEGER)`,
  `ALTER TABLE users ADD COLUMN household_id TEXT`,
  `ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`,
  `ALTER TABLE recipes ADD COLUMN household_id TEXT`,
  `ALTER TABLE grocery ADD COLUMN household_id TEXT`,
  `ALTER TABLE plan ADD COLUMN household_id TEXT`,
  `ALTER TABLE invites ADD COLUMN household_id TEXT`,
  `CREATE TABLE IF NOT EXISTS starter_codes (token_hash TEXT PRIMARY KEY, created_by TEXT, expires INTEGER, used_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS usage (day TEXT, key TEXT, n REAL, PRIMARY KEY (day, key))`,
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id TEXT, p256dh TEXT, auth TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS push_timers (id TEXT PRIMARY KEY, user_id TEXT, fire_at INTEGER, title TEXT, body TEXT)`,
  `CREATE INDEX IF NOT EXISTS recipes_hh ON recipes (household_id)`,
  `CREATE INDEX IF NOT EXISTS grocery_hh ON grocery (household_id)`,
  `CREATE INDEX IF NOT EXISTS plan_hh ON plan (household_id, day)`,
  `CREATE INDEX IF NOT EXISTS timers_due ON push_timers (fire_at)`,
  // 3.3: credit for photos picked from the photo search
  `ALTER TABLE recipes ADD COLUMN image_credit TEXT`,
  `ALTER TABLE recipes ADD COLUMN image_credit_url TEXT`];
// one-time move of everything from before 3.0 into the first household
const BACKFILL = [
  `INSERT OR IGNORE INTO households (id, name, created) VALUES ('h1', 'Our household', strftime('%s','now') * 1000)`,
  `UPDATE users SET household_id = 'h1' WHERE household_id IS NULL`,
  `UPDATE recipes SET household_id = 'h1' WHERE household_id IS NULL`,
  `UPDATE grocery SET household_id = 'h1' WHERE household_id IS NULL`,
  `UPDATE plan SET household_id = 'h1' WHERE household_id IS NULL`,
  `UPDATE invites SET household_id = 'h1' WHERE household_id IS NULL`,
  `INSERT OR IGNORE INTO settings (key, value) SELECT 'stores:h1', value FROM settings WHERE key = 'stores'`,
  `INSERT OR REPLACE INTO settings (key, value) VALUES ('migrated:households', '1')`];
// Cloudflare free plan daily limits (reset at midnight UTC) and storage cap
const LIMITS = { requests: 100000, neurons: 10000, dbsize: 5e9 };
const DEFAULT_STORES = ["Costco","Walmart","Aldi","Kroger","Meijer","Target","Sam's Club"];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  for (const m of MIGRATIONS) { try { await env.DB.prepare(m).run(); } catch {} }
  const done = await env.DB.prepare("SELECT 1 FROM settings WHERE key = 'migrated:households'").first();
  if (!done) await env.DB.batch(BACKFILL.map(q => env.DB.prepare(q)));
  // the first request after an update records when this version went live
  try { await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").bind("deployed:" + APP_VERSION, String(Date.now())).run(); } catch {}
  schemaReady = true;
}

/* ---------------- helpers ---------------- */
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const err = (msg, status = 400) => json({ error: msg }, status);
const uid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");

async function hashPassword(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return b64(bits);
}
async function sha256(text) { return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))); }
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
const SESSION_DAYS = 365;
function sessionCookie(token, maxAge) {
  return `rb_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
// The app owner (usage meter, starter links, household list) is only ever the account whose
// email matches the OWNER_EMAIL secret. Without that secret, the owner flag saved for this
// app's original install is used. Nobody becomes owner automatically.
async function currentUser(req, env) {
  const u = await loadUser(req, env);
  if (u && env.OWNER_EMAIL) u.is_admin = String(u.email).toLowerCase() === String(env.OWNER_EMAIL).trim().toLowerCase() ? 1 : 0;
  return u;
}
async function loadUser(req, env) {
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const key = auth.slice(7).trim();
    if (key) return await env.DB.prepare("SELECT id, email, name, household_id AS hh, is_admin FROM users WHERE quick_key = ?").bind(key).first();
  }
  const token = getCookie(req, "rb_session");
  if (!token) return null;
  return await env.DB.prepare("SELECT u.id, u.email, u.name, u.household_id AS hh, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?").bind(token, Date.now()).first();
}

/* ---------------- recipe import ---------------- */
/*__PARSE_JS__*/
// a recipe sorted without AI, in the same shape the AI returns
function sorted(text, url, image, titleHint) {
  const r = parseRecipeText(text);
  if (titleHint && (r.title === "Untitled recipe" || r.title.length < 3)) r.title = titleHint.slice(0, 140);
  return { ok: r.usable, confident: r.confident, recipe: { title: r.title, category: "Other", prep_min: r.prep_min, cook_min: r.cook_min, servings: r.servings,
    ingredients: r.ingredients, steps: r.steps, notes: r.notes, tags: "", source_url: url || "", source_name: url ? siteName(url) : "", image_url: image || "" } };
}
const nextReset = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const AI_LIMIT_MSG = "Today's free AI recipe reading is used up.";
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°", frac12: "½", frac14: "¼", frac34: "¾", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", eacute: "é", egrave: "è", ntilde: "ñ", reg: "®", trade: "™", copy: "©" };
function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const clean = s => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function isoMinutes(d) {
  if (!d) return 0;
  if (typeof d === "number") return Math.round(d);
  const m = String(d).match(/P(?:(\d+)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?/i);
  if (!m) return 0;
  return Math.round((+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0));
}
function hasType(o, t) {
  const ty = o && o["@type"];
  return Array.isArray(ty) ? ty.some(x => String(x).toLowerCase() === t) : String(ty || "").toLowerCase() === t;
}
function findRecipe(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n, depth + 1); if (r) return r; } return null; }
  if (hasType(node, "recipe")) return node;
  for (const k of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    if (node[k]) { const r = findRecipe(node[k], depth + 1); if (r) return r; }
  }
  return null;
}
function flattenInstructions(ins, out = []) {
  if (!ins) return out;
  if (typeof ins === "string") {
    const t = decodeEntities(ins).replace(/<\/(p|li|br)>|<br\s*\/?>/gi, "\n");
    clean(t) && t.split(/\n+/).map(clean).filter(Boolean).forEach(l => out.push(l));
    return out;
  }
  if (Array.isArray(ins)) { ins.forEach(i => flattenInstructions(i, out)); return out; }
  if (typeof ins === "object") {
    if (hasType(ins, "howtosection")) {
      if (ins.name) out.push(clean(ins.name) + ":");
      flattenInstructions(ins.itemListElement, out);
    } else if (ins.text || ins.name) out.push(clean(ins.text || ins.name));
    else if (ins.itemListElement) flattenInstructions(ins.itemListElement, out);
  }
  return out;
}
function pickImage(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return pickImage(img[img.length > 1 ? 0 : 0]);
  return img.url || img.contentUrl || "";
}
function guessCategory(r) {
  const s = [r.recipeCategory, r.recipeCuisine, r.name, r.keywords].flat().filter(Boolean).join(" ").toLowerCase();
  const map = [["Breakfast", /breakfast|brunch|pancake|waffle|oatmeal|muffin/], ["Desserts", /dessert|cake|cookie|pie|brownie|pudding|ice cream|cheesecake/], ["Baking", /bread|baking|biscuit|scone|roll|loaf/], ["Soups", /soup|stew|chili|chowder|bisque/], ["Salads", /salad/], ["Sides", /side/], ["Drinks", /drink|cocktail|smoothie|beverage|lemonade/], ["Snacks", /snack|appetizer|dip|starter/], ["Mains", /main|dinner|entree|lunch|chicken|beef|pork|pasta|fish|salmon|shrimp/]];
  for (const [c, re] of map) if (re.test(s)) return c;
  return "Other";
}
function fromJsonLd(r, url) {
  const ingredients = (Array.isArray(r.recipeIngredient) ? r.recipeIngredient : (r.ingredients || [])).map(clean).filter(Boolean);
  const steps = flattenInstructions(r.recipeInstructions);
  let prep = isoMinutes(r.prepTime), cook = isoMinutes(r.cookTime);
  const total = isoMinutes(r.totalTime);
  if (!cook && total > prep) cook = total - prep;
  let yld = r.recipeYield; if (Array.isArray(yld)) yld = yld.find(y => /\D/.test(String(y))) || yld[0];
  const kw = Array.isArray(r.keywords) ? r.keywords.join(", ") : (r.keywords || "");
  return {
    title: clean(r.name).slice(0, 140) || "Untitled recipe",
    category: guessCategory(r),
    prep_min: prep, cook_min: cook,
    servings: clean(yld ?? ""),
    ingredients: ingredients.join("\n"),
    steps: steps.join("\n"),
    notes: "",
    tags: clean(kw).split(/\s*,\s*/).filter(Boolean).slice(0, 6).join(", "),
    source_url: url,
    source_name: siteName(url),
    image_url: pickImage(r.image)
  };
}
function siteName(url) { try { return new URL(url).hostname.replace(/^www\.|^m\./, ""); } catch { return ""; } }
function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = html.match(re); if (!tag) return "";
  const c = tag[0].match(/content=["']([^"']*)["']/i) || tag[0].match(/content=([^\s>]+)/i);
  return c ? decodeEntities(c[1]) : "";
}
function pageText(html) {
  return decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>|<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<\/(p|div|li|h\d|tr|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
const SOCIAL = /(^|\.)(instagram\.com|facebook\.com|fb\.watch|tiktok\.com|threads\.net|pinterest\.[a-z.]+|pin\.it|youtube\.com|youtu\.be|x\.com|twitter\.com)$/i;

async function fetchPage(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9"
    },
    cf: { cacheTtl: 0 }
  });
  const html = res.ok ? (await res.text()).slice(0, 3_000_000) : "";
  return { ok: res.ok, status: res.status, html, finalUrl: res.url || url };
}

function parseRecipeHtml(html, url) {
  const blocks = [...html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let data; try { data = JSON.parse(b[1].trim()); } catch { try { data = JSON.parse(b[1].trim().replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; } }
    const r = findRecipe(data);
    if (r && (r.recipeIngredient || r.recipeInstructions)) return fromJsonLd(r, url);
  }
  return null;
}

const AI_PROMPT = `You turn recipe text into JSON for a family recipe box. The text may come from a web page, a social media caption, or a screenshot, and may contain emojis, hashtags, ads, comments and stories: ignore everything that is not the recipe.
Reply with ONLY a JSON object, no other text:
{"found": true or false (false if there is no actual recipe with ingredients),
 "title": short recipe name,
 "category": one of ${JSON.stringify(CATS)},
 "prep_min": integer minutes or 0,
 "cook_min": integer minutes or 0,
 "servings": string like "4" or "12 cookies" or "",
 "ingredients": array of strings, one ingredient each with its exact amount; a group heading is its own item ending with ":",
 "steps": array of strings, one instruction each, no numbering, temperatures and times exactly as written,
 "notes": tips, substitutions or storage info from the text, or "",
 "tags": a few comma-separated tags or ""}
Never invent ingredients or amounts that are not in the text.`;

function parseAiJson(text) {
  if (!text) return null;
  if (typeof text === "object") return text;
  const s = String(text);
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
function normalizeAi(o, url, image) {
  if (!o || o.found === false || !o.title) return null;
  const arr = v => Array.isArray(v) ? v.map(x => clean(typeof x === "object" ? (x.text || x.name || "") : x)).filter(Boolean).join("\n") : clean(v).replace(/\s*\|\s*/g, "\n");
  const ing = arr(o.ingredients);
  if (!ing) return null;
  return {
    title: clean(o.title).slice(0, 140), category: CATS.includes(o.category) ? o.category : "Other",
    prep_min: Math.max(0, parseInt(o.prep_min) || 0), cook_min: Math.max(0, parseInt(o.cook_min) || 0),
    servings: clean(o.servings), ingredients: ing, steps: arr(o.steps), notes: clean(o.notes), tags: clean(o.tags),
    source_url: url || "", source_name: url ? siteName(url) : "", image_url: image || ""
  };
}
async function aiFromText(env, text, url, image) {
  const g = await gemini(env, AI_PROMPT, [{ text: text.slice(0, 24000) }], true);
  if (g !== null) return normalizeAi(parseAiJson(g), url, image);
  if (!env.AI) throw new Error("ai_missing");
  const out = await runAI(env, TEXT_MODEL, {
    messages: [{ role: "system", content: AI_PROMPT }, { role: "user", content: text.slice(0, 24000) }],
    max_tokens: 2500, temperature: 0.1
  }, AI_PROMPT.length + Math.min(text.length, 24000));
  return normalizeAi(parseAiJson(out && out.response), url, image);
}
async function aiFromImage(env, bytes) {
  const g = await gemini(env, AI_PROMPT, [{ text: "Here is a screenshot or photo of a recipe. Extract it." }, imagePart(bytes)], true);
  if (g !== null) return normalizeAi(parseAiJson(g), "", "");
  if (!env.AI) throw new Error("ai_missing");
  const run = () => runAI(env, VISION_MODEL, {
    messages: [{ role: "system", content: AI_PROMPT }, { role: "user", content: "Here is a screenshot or photo of a recipe. Extract it." }],
    image: [...bytes], max_tokens: 2500, temperature: 0.1
  }, AI_PROMPT.length + 2000);
  let out;
  try { out = await run(); }
  catch (e) {
    // Meta's vision model needs a one-time license agreement per account.
    if (/agree/i.test(String(e && e.message))) { await env.AI.run(VISION_MODEL, { prompt: "agree" }); out = await run(); }
    else throw e;
  }
  return normalizeAi(parseAiJson(out && out.response), "", "");
}

async function importFromUrl(env, rawUrl) {
  let url;
  try { url = new URL(rawUrl.trim()); if (!/^https?:$/.test(url.protocol)) throw 0; } catch { return { error: "That doesn't look like a web link." }; }
  const host = url.hostname;
  const social = SOCIAL.test(host);
  if (social) {
    const s = await socialText(url);
    if (s.text.replace(/\s/g, "").length > 60) {
      const quick = sorted(s.text, url.href, s.image);
      if (quick.confident) return { recipe: quick.recipe, method: "sorted" };
      try {
        const ai = await aiFromText(env, s.text, url.href, s.image);
        if (ai) return { recipe: ai, method: "caption" };
      } catch (e) {
        if (isLimit(e)) return quick.ok ? { recipe: quick.recipe, method: "sorted", aiLimit: true, resetAt: nextReset() } : limitOut({ needsPaste: true, source_url: url.href });
        if (aiError(e)) return { error: aiError(e) };
      }
      if (quick.ok) return { recipe: quick.recipe, method: "sorted" };
    }
    return { error: s.text ? "The post's caption didn't include the full recipe, or it was cut short. Tap \"more\" on the caption, take screenshots while you scroll, and add them all at once." : "That post's caption isn't readable from the link. Tap \"more\" on the caption, take screenshots while you scroll, and add them all at once.", needsPaste: true, source_url: url.href };
  }
  let page;
  try { page = await fetchPage(url.href); } catch { page = { ok: false, html: "", status: 0, finalUrl: url.href }; }
  const finalUrl = page.finalUrl || url.href;
  if (page.ok && page.html) {
    const r = parseRecipeHtml(page.html, finalUrl);
    if (r) return { recipe: r, method: "recipe-data" };
    const caption = meta(page.html, "og:description") || meta(page.html, "description");
    const title = meta(page.html, "og:title");
    const image = meta(page.html, "og:image");
    const body = social ? [title, caption].filter(Boolean).join("\n") : [title, caption, pageText(page.html)].filter(Boolean).join("\n");
    if (body.replace(/\s/g, "").length > 80) {
      try {
        const ai = await aiFromText(env, body, finalUrl, image);
        if (ai) return { recipe: ai, method: "ai" };
      } catch (e) {
        if (isLimit(e)) {
          // no AI left: look for the recipe part of the page by its headings
          const t = pageText(page.html), at = t.search(/\n\s*(?:ingredients?|what you(?:'|’)?ll need)\s*:?\s*\n/i);
          const quick = at >= 0 ? sorted(t.slice(at, at + 12000), finalUrl, image, title) : { ok: false };
          return quick.ok ? { recipe: quick.recipe, method: "sorted", aiLimit: true, resetAt: nextReset() } : limitOut({ needsPaste: true, source_url: url.href });
        }
        if (aiError(e)) return { error: aiError(e) };
      }
    }
  }
  if (social) return { error: "This post's recipe isn't readable from the link. Social sites often hide captions. Copy the caption (or take a screenshot) and paste it in the app instead.", needsPaste: true, source_url: url.href };
  if (page.status === 403 || page.status === 401 || page.status === 429) return { error: "That website blocked the import. Copy the recipe text or take a screenshot and paste it in the app instead.", needsPaste: true, source_url: url.href };
  return { error: "Couldn't find a recipe on that page. Try pasting the recipe text or a screenshot instead.", needsPaste: true, source_url: url.href };
}

/* ---------------- recipes ---------------- */
const RECIPE_FIELDS = ["title","category","prep_min","cook_min","servings","ingredients","steps","notes","tags","source_url","source_name","image_url","photo_id","image_credit","image_credit_url","favorite"];
function sanitizeRecipe(b) {
  const r = {};
  for (const f of RECIPE_FIELDS) if (b[f] !== undefined) r[f] = b[f];
  if ("title" in r) r.title = String(r.title || "").trim().slice(0, 140);
  if ("category" in r && !CATS.includes(r.category)) r.category = "Other";
  for (const n of ["prep_min","cook_min"]) if (n in r) r[n] = Math.max(0, parseInt(r[n]) || 0);
  if ("favorite" in r) r.favorite = r.favorite ? 1 : 0;
  for (const s of ["servings","ingredients","steps","notes","tags","source_url","source_name","image_url","photo_id"]) if (s in r) r[s] = String(r[s] ?? "").slice(0, 60000);
  return r;
}
async function insertRecipe(env, user, data) {
  const r = sanitizeRecipe(data);
  if (!r.title) return null;
  const id = uid(), now = Date.now();
  const cols = ["id", ...Object.keys(r), "added_by", "created", "updated", "household_id"];
  const vals = [id, ...Object.values(r), user.id, now, now, user.hh];
  await env.DB.prepare(`INSERT INTO recipes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...vals).run();
  return id;
}

/* ---------------- router ---------------- */
const ABC_LOWER = "abcdefghijkmnpqrstuvwxyz23456789";
const token16 = () => [...crypto.getRandomValues(new Uint8Array(16))].map(x => ABC_LOWER[x % ABC_LOWER.length]).join("");
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const aiError = e => String(e && e.message) === "ai_missing" ? "Recipe reading isn't switched on yet. Add the Workers AI binding named AI (see setup)."
  : String(e && e.message) === "ai_limit" ? AI_LIMIT_MSG : null;
const isLimit = e => String(e && e.message) === "ai_limit";
const limitOut = extra => ({ error: AI_LIMIT_MSG, aiLimit: true, resetAt: nextReset(), ...extra });

async function api(req, env, url) {
  const p = url.pathname, m = req.method;
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  if (p === "/api/signup" && m === "POST") {
    const b = await body();
    const email = String(b.email || "").trim().toLowerCase(), name = String(b.name || "").trim().slice(0, 60), pw = String(b.password || "");
    // three ways in: an invite link (joins that household), a starter link (makes a new household),
    // or the original household code (joins the first household)
    let hh = null, inviteHash = null, starterHash = null;
    if (b.inviteToken) {
      inviteHash = await sha256(String(b.inviteToken));
      const inv = await env.DB.prepare("SELECT i.expires, i.used_by, COALESCE(i.household_id, u.household_id) AS hh FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?").bind(inviteHash).first();
      if (!inv || inv.used_by || inv.expires < Date.now() || !inv.hh) return err("This invite link has expired or was already used. Ask for a new one.", 403);
      hh = inv.hh;
    } else if (b.starterToken) {
      starterHash = await sha256(String(b.starterToken));
      const st = await env.DB.prepare("SELECT expires, used_by FROM starter_codes WHERE token_hash = ?").bind(starterHash).first();
      if (!st || st.used_by || st.expires < Date.now()) return err("This link has expired or was already used. Ask for a new one.", 403);
    } else {
      if (!env.INVITE_CODE) return err("Sign-ups need an invite link.", 403);
      if (String(b.invite || "").trim() !== env.INVITE_CODE) return err("That household code isn't right.", 403);
      hh = "h1";
    }
    if (!validEmail(email)) return err("Enter a valid email address.");
    if (!name) return err("Enter your name.");
    if (pw.length < 8) return err("Use a password with at least 8 characters.");
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) return err("There's already an account with that email. Log in instead.");
    const salt = randHex(16), id = uid(), now = Date.now();
    const writes = [];
    if (starterHash) {
      hh = "h" + uid();
      const hname = String(b.householdName || "").trim().slice(0, 60) || name + "'s household";
      writes.push(env.DB.prepare("INSERT INTO households (id, name, created) VALUES (?, ?, ?)").bind(hh, hname, now));
      writes.push(env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind("stores:" + hh, JSON.stringify(DEFAULT_STORES)));
      writes.push(env.DB.prepare("UPDATE starter_codes SET used_by = ? WHERE token_hash = ?").bind(id, starterHash));
    }
    writes.push(env.DB.prepare("INSERT INTO users (id,email,name,pass_hash,salt,quick_key,created,household_id,is_admin) VALUES (?,?,?,?,?,?,?,?,0)").bind(id, email, name, await hashPassword(pw, salt), salt, randHex(20), now, hh));
    if (inviteHash) writes.push(env.DB.prepare("UPDATE invites SET used_by = ? WHERE token_hash = ?").bind(id, inviteHash));
    await env.DB.batch(writes);
    return startSession(env, id);
  }
  if (p === "/api/login" && m === "POST") {
    const b = await body();
    const u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(String(b.email || "").trim().toLowerCase()).first();
    if (!u || !safeEqual(await hashPassword(String(b.password || ""), u.salt), u.pass_hash)) return err("Email or password is wrong.", 401);
    return startSession(env, u.id);
  }
  if (p === "/api/invite-info" && m === "GET") {
    const t = url.searchParams.get("token") || "";
    const inv = t && await env.DB.prepare("SELECT i.expires, i.used_by, u.name, h.name AS hname FROM invites i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN households h ON h.id = COALESCE(i.household_id, u.household_id) WHERE i.token_hash = ?").bind(await sha256(t)).first();
    if (!inv || inv.used_by || inv.expires < Date.now()) return json({ valid: false });
    return json({ valid: true, inviter: inv.name || "Someone", household: inv.hname || "" });
  }
  if (p === "/api/starter-info" && m === "GET") {
    const t = url.searchParams.get("token") || "";
    const st = t && await env.DB.prepare("SELECT s.expires, s.used_by, u.name FROM starter_codes s LEFT JOIN users u ON u.id = s.created_by WHERE s.token_hash = ?").bind(await sha256(t)).first();
    if (!st || st.used_by || st.expires < Date.now()) return json({ valid: false });
    return json({ valid: true, inviter: st.name || "Someone" });
  }
  // forgot password: someone in the household makes a one-time code; the locked-out person uses it here
  if (p === "/api/reset/use" && m === "POST") {
    const b = await body();
    const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const pw = String(b.password || "");
    if (pw.length < 8) return err("Use a new password with at least 8 characters.");
    const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(String(b.email || "").trim().toLowerCase()).first();
    const row = code && await env.DB.prepare("SELECT user_id, expires FROM reset_codes WHERE code_hash = ?").bind(await sha256(code)).first();
    if (!u || !row || row.user_id !== u.id || row.expires < Date.now()) return err("That code doesn't match this email, or it has expired. Ask for a new one.", 400);
    const salt = randHex(16);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").bind(await hashPassword(pw, salt), salt, u.id),
      env.DB.prepare("DELETE FROM reset_codes WHERE user_id = ?").bind(u.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id)
    ]);
    return startSession(env, u.id);
  }
  if (p === "/api/logout" && m === "POST") {
    const t = getCookie(req, "rb_session");
    if (t) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(t).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }

  const user = await currentUser(req, env);
  if (!user) return err("Please log in.", 401);
  const H = user.hh;

  if (p === "/api/me" && m === "GET") {
    const [u, people, dep, hh] = await Promise.all([
      env.DB.prepare("SELECT quick_key FROM users WHERE id = ?").bind(user.id).first(),
      env.DB.prepare("SELECT id, name FROM users WHERE household_id = ? ORDER BY created").bind(H).all(),
      env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'deployed:%'").all(),
      env.DB.prepare("SELECT id, name FROM households WHERE id = ?").bind(H).first()
    ]);
    const out = { user: { id: user.id, email: user.email, name: user.name, quick_key: u.quick_key, is_admin: !!user.is_admin },
      people: people.results, household: hh || { id: H, name: "" }, ai: !!env.AI, version: APP_VERSION,
      deployed: Object.fromEntries(dep.results.map(r => [r.key.slice(9), +r.value])),
      ads: env.ADSENSE_CLIENT && env.ADSENSE_SLOT ? { client: env.ADSENSE_CLIENT, slot: env.ADSENSE_SLOT } : null,
      vapid: await vapidPublic(env) };
    if (user.is_admin) { out.usage = await usageToday(env); out.usage.geminiStatus = await geminiStatus(env); }
    return json(out);
  }
  if (p === "/api/household" && m === "PUT") {
    const b = await body();
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return err("Give the household a name.");
    await env.DB.prepare("UPDATE households SET name = ? WHERE id = ?").bind(name, H).run();
    return json({ household: { id: H, name } });
  }
  if (p === "/api/invites" && m === "POST") {
    const token = token16(), expires = Date.now() + 7 * 864e5;
    await env.DB.prepare("INSERT INTO invites (token_hash, created_by, expires, household_id) VALUES (?, ?, ?, ?)").bind(await sha256(token), user.id, expires, H).run();
    return json({ url: url.origin + "/?invite=" + token, expires });
  }
  if (p === "/api/invites" && m === "GET") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE household_id = ? AND used_by IS NULL AND expires > ?").bind(H, Date.now()).first();
    return json({ open: r ? r.n : 0 });
  }
  if (p === "/api/invites" && m === "DELETE") {
    await env.DB.prepare("DELETE FROM invites WHERE household_id = ? AND used_by IS NULL").bind(H).run();
    return json({ ok: true });
  }
  if (p === "/api/reset/create" && m === "POST") {
    const b = await body();
    const target = await env.DB.prepare("SELECT id, name FROM users WHERE id = ? AND household_id = ?").bind(String(b.user_id || ""), H).first();
    if (!target) return err("That person isn't in your household.");
    const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = [...crypto.getRandomValues(new Uint8Array(8))].map(x => ABC[x % ABC.length]).join("");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM reset_codes WHERE user_id = ? OR expires < ?").bind(target.id, Date.now()),
      env.DB.prepare("INSERT INTO reset_codes (code_hash, user_id, expires) VALUES (?, ?, ?)").bind(await sha256(code), target.id, Date.now() + 3600e3)
    ]);
    return json({ code: code.slice(0, 4) + "-" + code.slice(4), name: target.name });
  }
  if (p === "/api/me/password" && m === "POST") {
    const b = await body();
    const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
    if (!safeEqual(await hashPassword(String(b.current || ""), u.salt), u.pass_hash)) return err("Your current password isn't right.");
    if (String(b.password || "").length < 8) return err("Use a new password with at least 8 characters.");
    const salt = randHex(16);
    await env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?").bind(await hashPassword(String(b.password), salt), salt, user.id).run();
    return json({ ok: true });
  }
  if (p === "/api/me/quickkey" && m === "POST") {
    const k = randHex(20);
    await env.DB.prepare("UPDATE users SET quick_key = ? WHERE id = ?").bind(k, user.id).run();
    return json({ quick_key: k });
  }

  // admin: households, starter links, usage
  if (p.startsWith("/api/admin/")) {
    if (!user.is_admin) return err("Only the app's owner can do that.", 403);
    if (p === "/api/admin/households" && m === "GET") {
      const rows = (await env.DB.prepare(`SELECT h.id, h.name, h.created,
        (SELECT COUNT(*) FROM users u WHERE u.household_id = h.id) AS members,
        (SELECT COUNT(*) FROM recipes r WHERE r.household_id = h.id) AS recipes
        FROM households h ORDER BY h.created`).all()).results;
      const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM starter_codes WHERE used_by IS NULL AND expires > ?").bind(Date.now()).first();
      return json({ households: rows, openStarters: open ? open.n : 0 });
    }
    if (p === "/api/admin/starter" && m === "POST") {
      const token = token16(), expires = Date.now() + 14 * 864e5;
      await env.DB.prepare("INSERT INTO starter_codes (token_hash, created_by, expires) VALUES (?, ?, ?)").bind(await sha256(token), user.id, expires).run();
      return json({ url: url.origin + "/?start=" + token, expires });
    }
    if (p === "/api/admin/starter" && m === "DELETE") {
      await env.DB.prepare("DELETE FROM starter_codes WHERE used_by IS NULL").run();
      return json({ ok: true });
    }
    if (p === "/api/admin/usage" && m === "GET") {
      const days = (await env.DB.prepare("SELECT day, key, n FROM usage WHERE day >= ? ORDER BY day").bind(utcDay(-6)).all()).results;
      const today = await usageToday(env); today.geminiStatus = await geminiStatus(env);
      return json({ today, days, limits: LIMITS });
    }
    // owner's "Check Gemini" button: one tiny request to confirm the key works
    if (p === "/api/admin/gemini-test" && m === "POST") {
      if (!env.GEMINI_API_KEY) return json({ ok: false, status: { state: "off" } });
      const out = await gemini(env, "", [{ text: "Reply with the single word: ready" }], false);
      return json({ ok: out !== null, status: await geminiStatus(env) });
    }
    return err("Not found", 404);
  }

  // recipes
  if (p === "/api/recipes" && m === "GET") {
    const rows = (await env.DB.prepare("SELECT * FROM recipes WHERE household_id = ? ORDER BY title COLLATE NOCASE").bind(H).all()).results;
    return json({ recipes: rows });
  }
  if (p === "/api/recipes" && m === "POST") {
    const id = await insertRecipe(env, user, await body());
    if (!id) return err("A recipe needs a title.");
    return json({ recipe: await env.DB.prepare("SELECT * FROM recipes WHERE id = ?").bind(id).first() });
  }
  let mt = p.match(/^\/api\/recipes\/([\w-]+)$/);
  if (mt && m === "PUT") {
    const r = sanitizeRecipe(await body());
    if ("title" in r && !r.title) return err("A recipe needs a title.");
    const keys = Object.keys(r);
    if (keys.length) await env.DB.prepare(`UPDATE recipes SET ${keys.map(k => k + " = ?").join(", ")}, updated = ? WHERE id = ? AND household_id = ?`).bind(...Object.values(r), Date.now(), mt[1], H).run();
    return json({ recipe: await env.DB.prepare("SELECT * FROM recipes WHERE id = ? AND household_id = ?").bind(mt[1], H).first() });
  }
  if (mt && m === "DELETE") {
    const r = await env.DB.prepare("SELECT photo_id FROM recipes WHERE id = ? AND household_id = ?").bind(mt[1], H).first();
    if (!r) return json({ ok: true });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recipes WHERE id = ? AND household_id = ?").bind(mt[1], H),
      env.DB.prepare("DELETE FROM plan WHERE recipe_id = ? AND household_id = ?").bind(mt[1], H),
      ...(r.photo_id ? [env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(r.photo_id)] : [])
    ]);
    return json({ ok: true });
  }

  // import
  if (p === "/api/import/url" && m === "POST") {
    const b = await body();
    return json(await importFromUrl(env, String(b.url || "")));
  }
  if (p === "/api/import/text" && m === "POST") {
    const b = await body();
    const text = String(b.text || "").trim();
    if (text.length < 20) return json({ error: "Paste a bit more of the recipe first." });
    const src = String(b.source_url || ""), img = String(b.image_url || "");
    const quick = sorted(text, src, img);
    if (quick.confident && !b.forceAI) return json({ recipe: quick.recipe, method: "sorted" });   // clearly laid out: no AI needed
    try {
      const r = await aiFromText(env, text, src, img);
      if (r) return json({ recipe: r, method: "ai" });
      return json(quick.ok ? { recipe: quick.recipe, method: "sorted" } : { error: "Couldn't find ingredients in that text. If the recipe is only spoken in the video, it can't be read automatically; type it in instead." });
    } catch (e) {
      if (isLimit(e)) return json(quick.ok ? { recipe: quick.recipe, method: "sorted", aiLimit: true, resetAt: nextReset() } : limitOut());
      if (quick.ok) return json({ recipe: quick.recipe, method: "sorted" });
      return json({ error: aiError(e) || "The recipe reader is having trouble right now. Try again in a minute." });
    }
  }
  // screenshots: each one is read to plain text; the app then joins them and imports the text
  if (p === "/api/import/ocr" && m === "POST") {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length || buf.length > 6_000_000) return json({ error: "That image is too large. Try a screenshot instead of a full photo." });
    try { return json({ text: await ocrImage(env, buf) }); }
    catch (e) { return json(isLimit(e) ? limitOut({ screenshots: true }) : { error: aiError(e) || "Couldn't read that image right now. Try again." }); }
  }
  if (p === "/api/import/image" && m === "POST") {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length || buf.length > 6_000_000) return json({ error: "That image is too large. Try a screenshot instead of a full photo." });
    try {
      const r = await aiFromImage(env, buf);
      return json(r ? { recipe: r, method: "ai" } : { error: "Couldn't read a recipe from that image. Make sure the ingredients are visible, or paste the text instead." });
    } catch (e) { return json(isLimit(e) ? limitOut({ screenshots: true }) : { error: aiError(e) || "Couldn't read that image right now. Try again, or paste the text instead." }); }
  }
  // iPhone Shortcut: save straight from the Share sheet
  if (p === "/api/quicksave" && m === "POST") {
    const ct = req.headers.get("content-type") || "";
    let input = "";
    if (ct.includes("json")) { const b = await body(); input = String(b.url || b.text || ""); } else input = await req.text();
    input = input.trim();
    const link = (input.match(/https?:\/\/\S+/) || [""])[0];
    let result;
    if (link && input.replace(link, "").trim().length < 40) result = await importFromUrl(env, link);
    else {
      const quick = sorted(input, link, "");
      if (quick.confident) result = { recipe: quick.recipe };
      else { try { const r = await aiFromText(env, input, link, ""); result = r ? { recipe: r } : quick.ok ? { recipe: quick.recipe } : { error: "No recipe found in that." }; }
        catch (e) { result = quick.ok ? { recipe: quick.recipe } : { error: isLimit(e) ? AI_LIMIT_MSG + " Open the app and paste the recipe instead." : "The recipe reader is having trouble. Try again." }; } }
    }
    if (!result.recipe) return new Response("Not saved: " + result.error, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    await insertRecipe(env, user, result.recipe);
    return new Response("Saved “" + result.recipe.title + "” to the recipe box", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  // photos
  if (p === "/api/photo-search" && m === "GET") {
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 100), page = Math.min(10, Math.max(1, +url.searchParams.get("page") || 1));
    if (!q) return json({ results: [] });
    try { return json(await photoSearch(env, q, page)); }
    catch (e) { console.log("photo search failed", e && e.message); return json({ error: "Photo search isn't answering right now. Try again in a minute." }); }
  }
  if (p === "/api/photo-search/image" && m === "GET") {
    try { return await fetchPickedPhoto(env, url.searchParams.get("id")); }
    catch { return json({ error: "Couldn't get that photo. Try a different one." }, 502); }
  }
  if (p === "/api/photos" && m === "POST") {
    const b = await body();
    const data = String(b.data || ""), mime = String(b.mime || "image/jpeg");
    if (!/^image\/(jpeg|png|webp)$/.test(mime) || data.length > 1_400_000) return err("Photo is too large.");
    const id = uid();
    await env.DB.prepare("INSERT INTO photos (id, mime, data) VALUES (?,?,?)").bind(id, mime, data).run();
    return json({ id });
  }

  // grocery
  if (p === "/api/grocery" && m === "GET") {
    const items = (await env.DB.prepare("SELECT * FROM grocery WHERE household_id = ? ORDER BY checked, created").bind(H).all()).results;
    return json({ items, stores: await getStores(env, H) });
  }
  if (p === "/api/grocery" && m === "POST") {
    const b = await body();
    const items = (Array.isArray(b.items) ? b.items : [b.text]).map(t => String(t || "").trim().slice(0, 300)).filter(Boolean).slice(0, 200);
    const now = Date.now();
    const store = b.store ? String(b.store).slice(0, 40) : null;
    if (items.length) await env.DB.batch(items.map((t, i) => env.DB.prepare("INSERT INTO grocery (id,text,recipe_id,checked,added_by,created,store,household_id) VALUES (?,?,?,0,?,?,?,?)").bind(uid(), t, b.recipe_id || null, user.id, now + i, store, H)));
    return json({ added: items.length });
  }
  if (p === "/api/grocery/bulk" && m === "POST") {
    const b = await body();
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => /^[\w-]+$/.test(x)).slice(0, 500);
    if (!ids.length) return json({ changed: 0 });
    const st = b.store ? String(b.store).slice(0, 40) : null;
    if (b.remove) await env.DB.batch(ids.map(id => env.DB.prepare("DELETE FROM photos WHERE id = (SELECT photo_id FROM grocery WHERE id = ? AND household_id = ?)").bind(id, H)));
    await env.DB.batch(ids.map(id => b.remove
      ? env.DB.prepare("DELETE FROM grocery WHERE id = ? AND household_id = ?").bind(id, H)
      : env.DB.prepare("UPDATE grocery SET store = ? WHERE id = ? AND household_id = ?").bind(st, id, H)));
    return json({ changed: ids.length });
  }
  if (p === "/api/stores" && m === "PUT") {
    const b = await body();
    const list = [...new Set((Array.isArray(b.stores) ? b.stores : []).map(x => String(x || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind("stores:" + H, JSON.stringify(list)).run();
    return json({ stores: list });
  }
  if (p === "/api/grocery/clear" && m === "POST") {
    const b = await body();
    const only = b.all ? "" : " AND checked = 1";
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM photos WHERE id IN (SELECT photo_id FROM grocery WHERE household_id = ?${only} AND photo_id IS NOT NULL)`).bind(H),
      env.DB.prepare(`DELETE FROM grocery WHERE household_id = ?${only}`).bind(H)]);
    return json({ ok: true });
  }
  mt = p.match(/^\/api\/grocery\/([\w-]+)$/);
  if (mt && m === "PUT") {
    const b = await body();
    const own = await env.DB.prepare("SELECT photo_id FROM grocery WHERE id = ? AND household_id = ?").bind(mt[1], H).first();
    if (!own) return err("That item isn't on your list anymore.", 404);
    const set = (col, v) => env.DB.prepare(`UPDATE grocery SET ${col} = ? WHERE id = ? AND household_id = ?`).bind(v, mt[1], H).run();
    if ("text" in b) {
      const text = String(b.text || "").trim().slice(0, 300);
      if (!text) return err("An item needs a name.");
      await set("text", text);
    }
    if ("checked" in b) await set("checked", b.checked ? 1 : 0);
    if ("store" in b) await set("store", b.store ? String(b.store).slice(0, 40) : null);
    if ("link" in b) {
      let link = String(b.link || "").trim().slice(0, 2000);
      if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
      try { if (link) new URL(link); } catch { return err("That doesn't look like a web link."); }
      await set("link", link || null);
    }
    if ("photo_id" in b) {
      await set("photo_id", b.photo_id ? String(b.photo_id).slice(0, 40) : null);
      if (own.photo_id && own.photo_id !== b.photo_id) await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(own.photo_id).run();
    }
    return json({ item: await env.DB.prepare("SELECT * FROM grocery WHERE id = ?").bind(mt[1]).first() });
  }
  if (mt && m === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM photos WHERE id = (SELECT photo_id FROM grocery WHERE id = ? AND household_id = ?)").bind(mt[1], H),
      env.DB.prepare("DELETE FROM grocery WHERE id = ? AND household_id = ?").bind(mt[1], H)]);
    return json({ ok: true });
  }

  // meal plan
  if (p === "/api/plan" && m === "GET") {
    const from = url.searchParams.get("from") || "0000", to = url.searchParams.get("to") || "9999";
    return json({ entries: (await env.DB.prepare("SELECT * FROM plan WHERE household_id = ? AND day >= ? AND day <= ? ORDER BY day, created").bind(H, from, to).all()).results });
  }
  if (p === "/api/plan" && m === "POST") {
    const b = await body();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || ""))) return err("Pick a day.");
    if (!b.recipe_id && !String(b.note || "").trim()) return err("Pick a recipe or type a note.");
    if (b.recipe_id && !await env.DB.prepare("SELECT 1 FROM recipes WHERE id = ? AND household_id = ?").bind(String(b.recipe_id), H).first()) return err("That recipe isn't in your box.");
    await env.DB.prepare("INSERT INTO plan (id,day,recipe_id,note,added_by,created,household_id) VALUES (?,?,?,?,?,?,?)").bind(uid(), b.day, b.recipe_id || null, String(b.note || "").trim().slice(0, 200), user.id, Date.now(), H).run();
    return json({ ok: true });
  }
  mt = p.match(/^\/api\/plan\/([\w-]+)$/);
  if (mt && m === "DELETE") { await env.DB.prepare("DELETE FROM plan WHERE id = ? AND household_id = ?").bind(mt[1], H).run(); return json({ ok: true }); }
  if (mt && m === "PUT") {
    const b = await body();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || ""))) return err("Pick a day.");
    await env.DB.prepare("UPDATE plan SET day = ? WHERE id = ? AND household_id = ?").bind(b.day, mt[1], H).run();
    return json({ ok: true });
  }

  // lock-screen timer alerts (web push)
  if (p === "/api/push/subscribe" && m === "POST") {
    const b = await body();
    const ep = String(b.endpoint || ""), k = b.keys || {};
    if (!/^https:\/\//.test(ep) || !k.p256dh || !k.auth) return err("That notification setup didn't work. Try again.");
    await env.DB.prepare("INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth")
      .bind(ep, user.id, String(k.p256dh), String(k.auth), Date.now()).run();
    return json({ ok: true });
  }
  if (p === "/api/push/test" && m === "POST") {
    const n = await sendPushToUser(env, user.id, { title: "Recipe Box", body: "Lock-screen alerts are working.", tag: "test" });
    return json(n ? { sent: n } : { error: "No phone is set up for alerts yet." });
  }
  if (p === "/api/push/timer" && m === "POST") {
    const b = await body();
    const fireAt = Math.round(+b.fire_at || 0);
    if (!(fireAt > Date.now() && fireAt < Date.now() + 2 * 864e5)) return err("That timer time isn't valid.");
    const id = uid();
    await env.DB.prepare("INSERT INTO push_timers (id, user_id, fire_at, title, body) VALUES (?,?,?,?,?)")
      .bind(id, user.id, fireAt, String(b.title || "Timer done").slice(0, 80), String(b.body || "").slice(0, 160)).run();
    if (env.TIMERS) await env.TIMERS.get(env.TIMERS.idFromName("clock")).arm();
    return json({ id });
  }
  mt = p.match(/^\/api\/push\/timer\/([\w-]+)$/);
  if (mt && m === "DELETE") { await env.DB.prepare("DELETE FROM push_timers WHERE id = ? AND user_id = ?").bind(mt[1], user.id).run(); return json({ ok: true }); }

  // backup
  if (p === "/api/export" && m === "GET") {
    const recipes = (await env.DB.prepare("SELECT * FROM recipes WHERE household_id = ?").bind(H).all()).results;
    return new Response(JSON.stringify({ exported: new Date().toISOString(), recipes }, null, 2), { headers: { "content-type": "application/json", "content-disposition": "attachment; filename=recipe-box-backup.json" } });
  }
  if (p === "/api/import/backup" && m === "POST") {
    const b = await body();
    const list = Array.isArray(b.recipes) ? b.recipes.slice(0, 2000) : [];
    let n = 0; for (const r of list) { if (await insertRecipe(env, user, r)) n++; }
    return json({ added: n });
  }
  return err("Not found", 404);
}

/* ---------------- stores ---------------- */
async function getStores(env, hh) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind("stores:" + hh).first();
  try { const v = row && JSON.parse(row.value); if (Array.isArray(v)) return v; } catch {}
  return DEFAULT_STORES;
}
async function startSession(env, userId) {
  const token = randHex(32);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)").bind(token, userId, Date.now() + SESSION_DAYS * 864e5).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}

/* ---------------- usage meter ----------------
   Counts this app's own use so the owner can see how close it is to Cloudflare's free limits.
   Counts are kept in memory and written in small batches to save database writes. */
const utcDay = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
let usageBuf = {}, usagePending = 0, usageLast = Date.now();
function bump(key, n = 1) { usageBuf[key] = (usageBuf[key] || 0) + n; usagePending += 1; }
async function flushUsage(env, force) {
  if (!usagePending || (!force && usagePending < 20 && Date.now() - usageLast < 60e3)) return;
  const day = utcDay(), buf = usageBuf;
  usageBuf = {}; usagePending = 0; usageLast = Date.now();
  try {
    const res = await env.DB.batch(Object.entries(buf).map(([k, n]) =>
      env.DB.prepare("INSERT INTO usage (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n").bind(day, k, n)));
    const size = res && res[0] && res[0].meta && res[0].meta.size_after;
    if (size) await env.DB.prepare("INSERT INTO usage (day, key, n) VALUES (?, 'dbsize', ?) ON CONFLICT(day, key) DO UPDATE SET n = excluded.n").bind(day, size).run();
  } catch {}
}
async function usageToday(env) {
  const rows = (await env.DB.prepare("SELECT key, n FROM usage WHERE day = ?").bind(utcDay()).all()).results;
  const t = Object.fromEntries(rows.map(r => [r.key, r.n]));
  for (const [k, n] of Object.entries(usageBuf)) t[k] = (t[k] || 0) + n;   // include what hasn't been written yet
  if (!t.dbsize) { const last = await env.DB.prepare("SELECT n FROM usage WHERE key = 'dbsize' ORDER BY day DESC LIMIT 1").first(); if (last) t.dbsize = last.n; }
  return {
    requests: Math.round(t.requests || 0), neurons: Math.round(t.neurons || 0), imports: Math.round(t.ai_calls || 0), gemini: Math.round(t.gemini_calls || 0), dbsize: Math.round(t.dbsize || 0),
    pct: { requests: (t.requests || 0) / LIMITS.requests, neurons: (t.neurons || 0) / LIMITS.neurons, dbsize: (t.dbsize || 0) / LIMITS.dbsize }
  };
}
// Workers AI bills in "neurons"; these are Cloudflare's published per-million-token rates for the two models used
const NEURON_RATES = { [TEXT_MODEL]: [26668, 204805], [VISION_MODEL]: [4410, 61493] };
async function runAI(env, model, input, promptChars) {
  const used = (await env.DB.prepare("SELECT n FROM usage WHERE day = ? AND key = 'neurons'").bind(utcDay()).first()) || { n: 0 };
  if ((used.n || 0) + (usageBuf.neurons || 0) >= LIMITS.neurons * 0.99) throw new Error("ai_limit");
  let out;
  try { out = await env.AI.run(model, input); }
  catch (e) { if (/4006|daily free allocation|neuron|quota|exceeded/i.test(String(e && e.message))) throw new Error("ai_limit"); throw e; }
  const u = out && out.usage, rate = NEURON_RATES[model] || [30000, 200000];
  const pin = u && u.prompt_tokens || Math.ceil(promptChars / 4), pout = u && u.completion_tokens || Math.ceil(String(out && out.response || "").length / 4);
  bump("neurons", (pin * rate[0] + pout * rate[1]) / 1e6);
  bump("ai_calls");
  return out;
}

/* ---------------- Gemini (Google) ----------------
   Tried first for every AI job when the GEMINI_API_KEY secret is set. Each model has its own
   free daily allowance, so the app works down the list, then falls back to Cloudflare's AI,
   then to the no-AI sorter. Returns the reply text, or null if Gemini couldn't do it. */
const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-latest"];
const geminiModels = env => { const v = String(env.GEMINI_MODELS || "").split(",").map(x => x.trim()).filter(Boolean); return v.length ? v : GEMINI_MODELS; };
// Google's free limits reset at midnight Pacific time
function nextPacificMidnight() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(new Date()).map(x => [x.type, +x.value || 0]));
  const h = parts.hour % 24;
  return Date.now() + ((24 - h) * 3600 - parts.minute * 60 - parts.second) * 1000;
}
async function geminiNote(env, state, model, msg) {
  try { await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('gemini:status', ?)").bind(JSON.stringify({ state, model, msg: String(msg || "").slice(0, 200), at: Date.now() })).run(); } catch {}
}
function imagePart(bytes) {
  const b = bytes, head = String.fromCharCode(...b.slice(4, 12));
  const mime = b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg"
    : String.fromCharCode(...b.slice(8, 12)) === "WEBP" ? "image/webp" : /ftyp(heic|heix|hevc|mif1|msf1|heif)/.test(head) ? "image/heic" : "image/jpeg";
  return { inline_data: { mime_type: mime, data: toB64(b) } };
}
function toB64(b) { let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(bin); }

/* ---------------- photo search ----------------
   Finds example food photos for a recipe. Uses Pexels (better food photos) when the
   PEXELS_API_KEY secret is set, otherwise Wikimedia Commons (no key needed).
   A picked photo is copied into the app's own photo storage so it never disappears. */
async function pexelsSearch(env, q, page) {
  const r = await fetch(`${env.PEXELS_BASE || "https://api.pexels.com"}/v1/search?query=${encodeURIComponent(q)}&per_page=24&page=${page}&orientation=landscape`, { headers: { authorization: env.PEXELS_API_KEY } });
  if (!r.ok) throw new Error("pexels " + r.status);
  const d = await r.json();
  return (d.photos || []).map(x => ({ id: "px:" + x.id, thumb: x.src.medium, credit: "Photo by " + x.photographer + " on Pexels", link: x.url, alt: x.alt || "" }));
}
// Wikimedia Commons: free, openly licensed photos; no key needed. Its rules ask for a
// descriptive user agent and standard thumbnail widths.
const WM_UA = { "user-agent": "RecipeBoxFamilyApp/3.4 (private family recipe app; photo search)" };
const wmBase = env => env.WIKIMEDIA_BASE || "https://commons.wikimedia.org";
const stripTags = h => String(h || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
function wmCredit(ii) {
  const md = ii.extmetadata || {}, who = stripTags(md.Artist && md.Artist.value).slice(0, 80), lic = stripTags(md.LicenseShortName && md.LicenseShortName.value);
  return ["Photo", who ? "by " + who : "", "via Wikimedia Commons", lic ? "(" + lic + ")" : ""].filter(Boolean).join(" ");
}
async function wikimediaSearch(env, q, page) {
  const u = wmBase(env) + "/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrnamespace=6&gsrlimit=24"
    + "&gsroffset=" + (page - 1) * 24 + "&gsrsearch=" + encodeURIComponent(q + " filetype:bitmap")
    + "&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=500&iiextmetadatafilter=Artist|LicenseShortName";
  const r = await fetch(u, { headers: WM_UA });
  if (!r.ok) throw new Error("wikimedia " + r.status);
  const d = await r.json();
  return ((d.query && d.query.pages) || []).sort((x, y) => (x.index || 0) - (y.index || 0))
    .map(pg => ({ pg, ii: (pg.imageinfo || [])[0] }))
    .filter(({ ii }) => ii && ii.thumburl && /^image\/(jpeg|png|webp)$/.test(ii.mime || "image/jpeg"))
    .map(({ pg, ii }) => ({ id: "wm:" + pg.pageid, thumb: ii.thumburl, credit: wmCredit(ii), link: ii.descriptionurl || "", alt: String(pg.title || "").replace(/^File:|\.\w+$/g, "") }));
}
async function photoSearch(env, q, page) {
  if (env.PEXELS_API_KEY) { try { const r = await pexelsSearch(env, q, page); if (r.length) return { source: "pexels", results: r }; } catch {} }
  return { source: "wikimedia", results: await wikimediaSearch(env, q, page) };
}
// Fetches the picked photo for the app (looked up again by id, so only real search results
// can be fetched). The app shrinks and compresses it like any uploaded photo before saving,
// so every saved photo stays small (about 1000px wide, roughly 100–200 KB).
async function fetchPickedPhoto(env, pick) {
  let urls = [], credit = "", link = "";
  const [kind, raw] = String(pick).split(":");
  const id = String(raw || "").replace(/[^\w-]/g, "");
  if (!id) throw new Error("bad");
  if (kind === "px" && env.PEXELS_API_KEY) {
    const r = await fetch((env.PEXELS_BASE || "https://api.pexels.com") + "/v1/photos/" + id, { headers: { authorization: env.PEXELS_API_KEY } });
    if (!r.ok) throw new Error("lookup");
    const x = await r.json();
    urls = [x.src.large, x.src.medium]; credit = "Photo by " + x.photographer + " on Pexels"; link = x.url;
  } else if (kind === "wm") {
    const r = await fetch(wmBase(env) + "/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=1280&iiextmetadatafilter=Artist|LicenseShortName&pageids=" + id, { headers: WM_UA });
    if (!r.ok) throw new Error("lookup");
    const pg = (((await r.json()).query || {}).pages || [])[0] || {}, ii = (pg.imageinfo || [])[0];
    if (!ii) throw new Error("lookup");
    urls = [ii.thumburl, ii.url]; credit = wmCredit(ii); link = ii.descriptionurl || "";
  } else throw new Error("bad");
  for (const u of urls.filter(Boolean)) {
    try {
      const res = await fetch(u, { headers: WM_UA, redirect: "follow" });
      const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!res.ok || !/^image\/(jpeg|png|webp|gif)$/.test(mime)) continue;
      if ((+res.headers.get("content-length") || 0) > 8_000_000) continue;     // huge original: use the smaller copy
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 8_000_000 || buf.byteLength < 500) continue;
      return new Response(buf, { headers: { "content-type": mime, "cache-control": "private, no-store",
        "x-credit": encodeURIComponent(credit.slice(0, 200)), "x-credit-url": encodeURIComponent(link) } });
    } catch {}
  }
  throw new Error("download");
}
async function gemini(env, system, parts, wantJson) {
  const key = env.GEMINI_API_KEY;
  if (!key) return null;
  for (const model of geminiModels(env)) {
    const blocked = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind("gemini_block:" + model).first();
    if (blocked && +blocked.value > Date.now()) continue;               // this model's free day is used up
    try {
      const res = await fetch(`${env.GEMINI_BASE || "https://generativelanguage.googleapis.com"}/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: wantJson ? 0.1 : 0, maxOutputTokens: 8192, ...(wantJson ? { responseMimeType: "application/json" } : {}) }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        bump("gemini_calls");
        const text = ((((data.candidates || [])[0] || {}).content || {}).parts || []).filter(x => !x.thought).map(x => x.text || "").join("");
        await geminiNote(env, "ok", model);
        if (text.trim()) return text;
        continue;                                                          // empty or blocked reply: try the next one
      }
      const msg = (data.error && data.error.message) || "HTTP " + res.status;
      if (res.status === 429) {
        const daily = /per.?day|PerDay|daily/i.test(JSON.stringify(data));
        if (daily) await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind("gemini_block:" + model, String(nextPacificMidnight())).run();
        await geminiNote(env, daily ? "limit" : "busy", model, msg);
        continue;
      }
      await geminiNote(env, "error", model, res.status + ": " + msg);
      if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) break;   // bad key: no point trying other models
    } catch (e) { await geminiNote(env, "error", model, e && e.message); }
  }
  return null;
}
async function geminiStatus(env) {
  if (!env.GEMINI_API_KEY) return { state: "off" };
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'gemini:status'").first();
  let st = {}; try { st = JSON.parse(row && row.value || "{}"); } catch {}
  const models = geminiModels(env), blocks = [];
  for (const mdl of models) { const b = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind("gemini_block:" + mdl).first(); if (b && +b.value > Date.now()) blocks.push(+b.value); }
  return { state: blocks.length === models.length ? "limit" : (st.state || "ready"), msg: st.msg || "", at: st.at || 0, resetAt: blocks.length === models.length ? Math.min(...blocks) : 0 };
}

/* ---------------- screenshots ---------------- */
const OCR_PROMPT = "Transcribe all of the text in this image exactly as written, top to bottom, one line per line. Include ingredient amounts exactly. Do not add anything else.";
async function ocrImage(env, bytes) {
  const g = await gemini(env, "", [{ text: OCR_PROMPT }, imagePart(bytes)], false);
  if (g !== null) return g.trim();
  if (!env.AI) throw new Error("ai_missing");
  const input = { messages: [{ role: "user", content: "Transcribe all of the text in this image exactly as written, top to bottom, one line per line. Include ingredient amounts exactly. Do not add anything else." }],
    image: [...bytes], max_tokens: 2000, temperature: 0 };
  let out;
  try { out = await runAI(env, VISION_MODEL, input, 400); }
  catch (e) {
    if (/agree/i.test(String(e && e.message))) { await env.AI.run(VISION_MODEL, { prompt: "agree" }); out = await runAI(env, VISION_MODEL, input, 400); }
    else throw e;
  }
  return String(out && out.response || "").trim();
}

/* ---------------- social posts ----------------
   Instagram and Facebook hide posts behind a login. Two public doors still show the caption:
   Instagram's embed page, and the preview text they give to link-preview bots. */
const BOT_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
async function fetchAs(url, ua) {
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "user-agent": ua, "accept": "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" } });
    return res.ok ? (await res.text()).slice(0, 2_000_000) : "";
  } catch { return ""; }
}
function instagramCode(u) { const m = u.pathname.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/); return m ? m[1] : null; }
async function socialText(u) {
  const host = u.hostname, texts = [];
  let image = "";
  const fromMeta = html => {
    if (!html) return;
    const d = meta(html, "og:description") || meta(html, "description"), t = meta(html, "og:title");
    if (d) texts.push(d); else if (t) texts.push(t);
    image = image || meta(html, "og:image");
  };
  if (/instagram\.com$/i.test(host)) {
    const code = instagramCode(u);
    if (code) {
      const embed = await fetchAs(`https://www.instagram.com/p/${code}/embed/captioned/`, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15");
      const cap = embed.match(/<div class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/i) || embed.match(/<div class="Caption"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
      if (cap) texts.push(decodeEntities(cap[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").trim());
      const img = embed.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/i);
      if (img) image = decodeEntities(img[1]);
      fromMeta(await fetchAs(`https://www.instagram.com/p/${code}/`, BOT_UA));
    }
  } else if (/(^|\.)tiktok\.com$/i.test(host)) {
    try { const r = await fetch("https://www.tiktok.com/oembed?url=" + encodeURIComponent(u.href)); if (r.ok) { const j = await r.json(); if (j.title) texts.push(j.title); image = j.thumbnail_url || ""; } } catch {}
  } else {
    fromMeta(await fetchAs(u.href, BOT_UA));
  }
  // keep the longest version of the caption, plus any others that add something
  const uniq = [...new Set(texts.map(t => t.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  const keep = uniq.filter((t, i) => !uniq.slice(0, i).some(longer => longer.includes(t.slice(0, 60))));
  return { text: keep.join("\n\n"), image };
}

/* ---------------- web push (lock-screen timer alerts) ----------------
   Standard Web Push: VAPID signing (RFC 8292) and aes128gcm encryption (RFC 8291), using only WebCrypto. */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const enc = s => new TextEncoder().encode(s);
let vapidCache = null;
async function vapidKeys(env) {
  if (vapidCache) return vapidCache;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();
  let v = row && JSON.parse(row.value);
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(v)).run();
    const again = await env.DB.prepare("SELECT value FROM settings WHERE key = 'vapid'").first();   // another request may have won the race
    v = JSON.parse(again.value);
  }
  vapidCache = { pub: v.pub, key: await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
  return vapidCache;
}
async function vapidPublic(env) { try { return (await vapidKeys(env)).pub; } catch { return null; } }
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}
// test hooks: salt and sender key pair can be passed in to check against the RFC 8291 example
async function encryptPush(payload, p256dh, authSecret, opts = {}) {
  const uaPub = unb64u(p256dh), auth = unb64u(authSecret);
  const as = opts.keys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, cat(enc("WebPush: info\0"), uaPub, asPub), 32);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, cat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);   // record size 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(env, sub, data) {
  const v = await vapidKeys(env);
  const aud = new URL(sub.endpoint).origin;
  const head = b64u(enc(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:recipe-box@users.noreply.github.com" })));
  const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc(head + "." + claims)));
  const body = await encryptPush(enc(JSON.stringify(data)), sub.p256dh, sub.auth);
  let res;
  try {
    res = await fetch(sub.endpoint, { method: "POST", body, headers: {
      authorization: `vapid t=${head}.${claims}.${sig}, k=${v.pub}`, "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream", ttl: "300", urgency: "high" } });
  } catch { return false; }
  if (res.status === 404 || res.status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(sub.endpoint).run();
  return res.ok;
}
async function sendPushToUser(env, userId, data) {
  const subs = (await env.DB.prepare("SELECT * FROM push_subs WHERE user_id = ?").bind(userId).all()).results;
  const sent = await Promise.all(subs.map(s => sendPush(env, s, data).catch(() => false)));
  return sent.filter(Boolean).length;
}
// runs every minute: sends each timer due in the next minute at its exact second
// sends every timer alert that is due now, then clears old leftovers
async function fireTimers(env) {
  const due = (await env.DB.prepare("SELECT * FROM push_timers WHERE fire_at <= ? ORDER BY fire_at").bind(Date.now() + 1500).all()).results;
  await Promise.all(due.map(async t => {
    const still = await env.DB.prepare("DELETE FROM push_timers WHERE id = ? RETURNING id").bind(t.id).first();   // cancelled meanwhile?
    if (still) await sendPushToUser(env, t.user_id, { title: t.title, body: t.body, tag: "timer-" + t.id });
  }));
  await env.DB.prepare("DELETE FROM push_timers WHERE fire_at < ?").bind(Date.now() - 3600e3).run();
}

// One alarm clock for the whole app. It is set for the next timer that's due
// and sleeps (costing nothing) whenever no timers are running.
export class TimerClock extends DurableObject {
  async arm() {
    const r = await this.env.DB.prepare("SELECT MIN(fire_at) AS t FROM push_timers").first();
    if (!r || !r.t) return;
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || cur > r.t) await this.ctx.storage.setAlarm(Math.max(r.t, Date.now() + 50));
  }
  async alarm() {
    bump("requests");
    try { await ensureSchema(this.env); await fireTimers(this.env); } catch {}
    await this.arm();
    await flushUsage(this.env);
  }
}

function pngResponse(b64data) {
  const bin = Uint8Array.from(atob(b64data), c => c.charCodeAt(0));
  return new Response(bin, { headers: { "content-type": "image/png", "cache-control": "public, max-age=604800" } });
}

export default {
  async fetch(req, env, ctx) {
    bump("requests");
    if (ctx && env.DB) ctx.waitUntil(flushUsage(env));
    const url = new URL(req.url);
    if (!env.DB) return new Response("Setup isn't finished: add a D1 database binding named DB to this Worker (see the setup steps).", { status: 500, headers: { "content-type": "text/plain" } });
    try {
      await ensureSchema(env);
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && !req.headers.get("authorization")) {
          const origin = req.headers.get("origin");
          if (origin && origin !== url.origin) return err("Bad origin", 403);
        }
        return await api(req, env, url);
      }
      const ph = url.pathname.match(/^\/photo\/([\w-]+)$/);
      if (ph) {
        const row = await env.DB.prepare("SELECT mime, data FROM photos WHERE id = ?").bind(ph[1]).first();
        if (!row) return new Response("Not found", { status: 404 });
        const bin = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
        return new Response(bin, { headers: { "content-type": row.mime, "cache-control": "public, max-age=31536000, immutable" } });
      }
      if (url.pathname === "/icon-180.png" || url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png") return pngResponse(ICON_180);
      if (url.pathname === "/icon-512.png") return pngResponse(ICON_512);
      if (url.pathname === "/sw.js") return new Response(SW_JS.replace("__VERSION__", APP_VERSION), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
      if (url.pathname === "/ads.txt") {
        if (!env.ADSENSE_CLIENT) return new Response("Not found", { status: 404 });
        return new Response(`google.com, ${env.ADSENSE_CLIENT.replace(/^ca-/, "")}, DIRECT, f08c47fec0942fa0\n`, { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname === "/privacy") return new Response(PRIVACY_HTML.replace(/__HOST__/g, url.host), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/manifest.webmanifest") {
        return new Response(JSON.stringify({
          name: "Recipe Box", short_name: "Recipes", start_url: "/", scope: "/", display: "standalone", orientation: "portrait",
          background_color: "#ffffff", theme_color: "#ffffff", id: "/",
          icons: [{ src: "/icon-180.png", sizes: "180x180", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }]
        }), { headers: { "content-type": "application/manifest+json" } });
      }
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    } catch (e) {
      return json({ error: "Something went wrong on the server: " + (e && e.message || e) }, 500);
    }
  }
};
