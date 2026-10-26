// Recipe Box — a free, self-hosted recipe keeper for a household.
// Runs as one Cloudflare Worker with a D1 database (binding: DB) and
// Workers AI (binding: AI). Set a secret named INVITE_CODE: anyone who
// signs up must type it, so strangers can't join your box.

const APP_HTML = __APP_HTML__;
const ICON_180 = __ICON180__;
const ICON_512 = __ICON512__;

// Bump this with every release and add a matching entry to CHANGELOG in app.html.
const APP_VERSION = "2.1";
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
  `ALTER TABLE grocery ADD COLUMN photo_id TEXT`];
const DEFAULT_STORES = ["Costco","Walmart","Aldi","Kroger","Meijer","Target","Sam's Club"];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  for (const m of MIGRATIONS) { try { await env.DB.prepare(m).run(); } catch {} }
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
async function currentUser(req, env) {
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const key = auth.slice(7).trim();
    if (key) return await env.DB.prepare("SELECT id, email, name FROM users WHERE quick_key = ?").bind(key).first();
  }
  const token = getCookie(req, "rb_session");
  if (!token) return null;
  return await env.DB.prepare("SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?").bind(token, Date.now()).first();
}

/* ---------------- recipe import ---------------- */
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
  if (!env.AI) throw new Error("ai_missing");
  const out = await env.AI.run(TEXT_MODEL, {
    messages: [{ role: "system", content: AI_PROMPT }, { role: "user", content: text.slice(0, 24000) }],
    max_tokens: 2500, temperature: 0.1
  });
  return normalizeAi(parseAiJson(out && out.response), url, image);
}
async function aiFromImage(env, bytes) {
  if (!env.AI) throw new Error("ai_missing");
  const run = () => env.AI.run(VISION_MODEL, {
    messages: [{ role: "system", content: AI_PROMPT }, { role: "user", content: "Here is a screenshot or photo of a recipe. Extract it." }],
    image: [...bytes], max_tokens: 2500, temperature: 0.1
  });
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
      } catch (e) { if (String(e.message) === "ai_missing") return { error: "Recipe reading isn't switched on yet. Add the Workers AI binding named AI (see setup)." }; }
    }
  }
  if (social) return { error: "This post's recipe isn't readable from the link. Social sites often hide captions. Copy the caption (or take a screenshot) and paste it in the app instead.", needsPaste: true, source_url: url.href };
  if (page.status === 403 || page.status === 401 || page.status === 429) return { error: "That website blocked the import. Copy the recipe text or take a screenshot and paste it in the app instead.", needsPaste: true, source_url: url.href };
  return { error: "Couldn't find a recipe on that page. Try pasting the recipe text or a screenshot instead.", needsPaste: true, source_url: url.href };
}

/* ---------------- recipes ---------------- */
const RECIPE_FIELDS = ["title","category","prep_min","cook_min","servings","ingredients","steps","notes","tags","source_url","source_name","image_url","photo_id","favorite"];
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
  const cols = ["id", ...Object.keys(r), "added_by", "created", "updated"];
  const vals = [id, ...Object.values(r), user.id, now, now];
  await env.DB.prepare(`INSERT INTO recipes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).bind(...vals).run();
  return id;
}

/* ---------------- router ---------------- */
async function api(req, env, url) {
  const p = url.pathname, m = req.method;
  const body = async () => { try { return await req.json(); } catch { return {}; } };

  if (p === "/api/signup" && m === "POST") {
    const b = await body();
    const email = String(b.email || "").trim().toLowerCase(), name = String(b.name || "").trim().slice(0, 60), pw = String(b.password || "");
    // join with a one-time invite link, or with the household code
    let inviteHash = null;
    if (b.inviteToken) {
      inviteHash = await sha256(String(b.inviteToken));
      const inv = await env.DB.prepare("SELECT expires, used_by FROM invites WHERE token_hash = ?").bind(inviteHash).first();
      if (!inv || inv.used_by || inv.expires < Date.now()) return err("This invite link has expired or was already used. Ask for a new one.", 403);
    } else {
      if (!env.INVITE_CODE) return err("Sign-ups are closed until an INVITE_CODE secret is set (see setup).", 403);
      if (String(b.invite || "").trim() !== env.INVITE_CODE) return err("That household code isn't right.", 403);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email address.");
    if (!name) return err("Enter your name.");
    if (pw.length < 8) return err("Use a password with at least 8 characters.");
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) return err("There's already an account with that email. Log in instead.");
    const salt = randHex(16), id = uid();
    await env.DB.prepare("INSERT INTO users (id,email,name,pass_hash,salt,quick_key,created) VALUES (?,?,?,?,?,?,?)").bind(id, email, name, await hashPassword(pw, salt), salt, randHex(20), Date.now()).run();
    if (inviteHash) await env.DB.prepare("UPDATE invites SET used_by = ? WHERE token_hash = ?").bind(id, inviteHash).run();
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
    const inv = t && await env.DB.prepare("SELECT i.expires, i.used_by, u.name FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?").bind(await sha256(t)).first();
    if (!inv || inv.used_by || inv.expires < Date.now()) return json({ valid: false });
    return json({ valid: true, inviter: inv.name || "Someone" });
  }
  // forgot password: someone logged in makes a one-time code; the locked-out person uses it here
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

  if (p === "/api/me" && m === "GET") {
    const u = await env.DB.prepare("SELECT quick_key FROM users WHERE id = ?").bind(user.id).first();
    const people = (await env.DB.prepare("SELECT id, name FROM users ORDER BY created").all()).results;
    const dep = (await env.DB.prepare("SELECT key, value FROM settings WHERE key LIKE 'deployed:%'").all()).results;
    return json({ user: { ...user, quick_key: u.quick_key }, people, ai: !!env.AI, version: APP_VERSION,
      deployed: Object.fromEntries(dep.map(r => [r.key.slice(9), +r.value])) });
  }
  if (p === "/api/invites" && m === "POST") {
    const ABC = "abcdefghijkmnpqrstuvwxyz23456789";
    const token = [...crypto.getRandomValues(new Uint8Array(16))].map(x => ABC[x % ABC.length]).join("");
    const expires = Date.now() + 7 * 864e5;
    await env.DB.prepare("INSERT INTO invites (token_hash, created_by, expires) VALUES (?, ?, ?)").bind(await sha256(token), user.id, expires).run();
    return json({ url: url.origin + "/?invite=" + token, expires });
  }
  if (p === "/api/invites" && m === "GET") {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_by IS NULL AND expires > ?").bind(Date.now()).first();
    return json({ open: r ? r.n : 0 });
  }
  if (p === "/api/invites" && m === "DELETE") {
    await env.DB.prepare("DELETE FROM invites WHERE used_by IS NULL").run();
    return json({ ok: true });
  }
  if (p === "/api/reset/create" && m === "POST") {
    const b = await body();
    const target = await env.DB.prepare("SELECT id, name FROM users WHERE id = ?").bind(String(b.user_id || "")).first();
    if (!target) return err("That person isn't in the household.");
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

  // recipes
  if (p === "/api/recipes" && m === "GET") {
    const rows = (await env.DB.prepare("SELECT * FROM recipes ORDER BY title COLLATE NOCASE").all()).results;
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
    if (keys.length) await env.DB.prepare(`UPDATE recipes SET ${keys.map(k => k + " = ?").join(", ")}, updated = ? WHERE id = ?`).bind(...Object.values(r), Date.now(), mt[1]).run();
    return json({ recipe: await env.DB.prepare("SELECT * FROM recipes WHERE id = ?").bind(mt[1]).first() });
  }
  if (mt && m === "DELETE") {
    const r = await env.DB.prepare("SELECT photo_id FROM recipes WHERE id = ?").bind(mt[1]).first();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM recipes WHERE id = ?").bind(mt[1]),
      env.DB.prepare("DELETE FROM plan WHERE recipe_id = ?").bind(mt[1]),
      ...(r && r.photo_id ? [env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(r.photo_id)] : [])
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
    try {
      const r = await aiFromText(env, text, String(b.source_url || ""), "");
      return json(r ? { recipe: r, method: "ai" } : { error: "Couldn't find ingredients in that text. If the recipe is only spoken in the video, it can't be read automatically; type it in instead." });
    } catch (e) {
      return json({ error: String(e.message) === "ai_missing" ? "Recipe reading isn't switched on yet. Add the Workers AI binding named AI (see setup)." : "The recipe reader is busy. Try again in a minute." });
    }
  }
  if (p === "/api/import/image" && m === "POST") {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length || buf.length > 6_000_000) return json({ error: "That image is too large. Try a screenshot instead of a full photo." });
    try {
      const r = await aiFromImage(env, buf);
      return json(r ? { recipe: r, method: "ai" } : { error: "Couldn't read a recipe from that image. Make sure the ingredients are visible, or paste the text instead." });
    } catch (e) {
      return json({ error: String(e.message) === "ai_missing" ? "Recipe reading isn't switched on yet. Add the Workers AI binding named AI (see setup)." : "Couldn't read that image right now. Try again, or paste the text instead." });
    }
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
    else { try { const r = await aiFromText(env, input, link, ""); result = r ? { recipe: r } : { error: "No recipe found in that." }; } catch { result = { error: "The recipe reader is busy. Try again." }; } }
    if (!result.recipe) return new Response("Not saved: " + result.error, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    await insertRecipe(env, user, result.recipe);
    return new Response("Saved “" + result.recipe.title + "” to the recipe box", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  // photos
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
    const items = (await env.DB.prepare("SELECT * FROM grocery ORDER BY checked, created").all()).results;
    return json({ items, stores: await getStores(env) });
  }
  if (p === "/api/grocery" && m === "POST") {
    const b = await body();
    const items = (Array.isArray(b.items) ? b.items : [b.text]).map(t => String(t || "").trim().slice(0, 300)).filter(Boolean).slice(0, 200);
    const now = Date.now();
    const store = b.store ? String(b.store).slice(0, 40) : null;
    if (items.length) await env.DB.batch(items.map((t, i) => env.DB.prepare("INSERT INTO grocery (id,text,recipe_id,checked,added_by,created,store) VALUES (?,?,?,0,?,?,?)").bind(uid(), t, b.recipe_id || null, user.id, now + i, store)));
    return json({ added: items.length });
  }
  if (p === "/api/grocery/bulk" && m === "POST") {
    const b = await body();
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(x => /^[\w-]+$/.test(x)).slice(0, 500);
    if (!ids.length) return json({ changed: 0 });
    const st = b.store ? String(b.store).slice(0, 40) : null;
    if (b.remove) await env.DB.batch(ids.map(id => env.DB.prepare("DELETE FROM photos WHERE id = (SELECT photo_id FROM grocery WHERE id = ?)").bind(id)));
    await env.DB.batch(ids.map(id => b.remove
      ? env.DB.prepare("DELETE FROM grocery WHERE id = ?").bind(id)
      : env.DB.prepare("UPDATE grocery SET store = ? WHERE id = ?").bind(st, id)));
    return json({ changed: ids.length });
  }
  if (p === "/api/stores" && m === "PUT") {
    const b = await body();
    const list = [...new Set((Array.isArray(b.stores) ? b.stores : []).map(x => String(x || "").trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('stores', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(list)).run();
    return json({ stores: list });
  }
  if (p === "/api/grocery/clear" && m === "POST") {
    const b = await body();
    const where = b.all ? "" : " WHERE checked = 1";
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM photos WHERE id IN (SELECT photo_id FROM grocery${where ? where + " AND" : " WHERE"} photo_id IS NOT NULL)`),
      env.DB.prepare("DELETE FROM grocery" + where)]);
    return json({ ok: true });
  }
  mt = p.match(/^\/api\/grocery\/([\w-]+)$/);
  if (mt && m === "PUT") {
    const b = await body();
    if ("checked" in b) await env.DB.prepare("UPDATE grocery SET checked = ? WHERE id = ?").bind(b.checked ? 1 : 0, mt[1]).run();
    if ("store" in b) {
      const st = b.store ? String(b.store).slice(0, 40) : null;
      await env.DB.prepare("UPDATE grocery SET store = ? WHERE id = ?").bind(st, mt[1]).run();
    }
    if ("link" in b) {
      let link = String(b.link || "").trim().slice(0, 2000);
      if (link && !/^https?:\/\//i.test(link)) link = "https://" + link;
      try { if (link) new URL(link); } catch { return err("That doesn't look like a web link."); }
      await env.DB.prepare("UPDATE grocery SET link = ? WHERE id = ?").bind(link || null, mt[1]).run();
    }
    if ("photo_id" in b) {
      const old = await env.DB.prepare("SELECT photo_id FROM grocery WHERE id = ?").bind(mt[1]).first();
      await env.DB.prepare("UPDATE grocery SET photo_id = ? WHERE id = ?").bind(b.photo_id ? String(b.photo_id).slice(0, 40) : null, mt[1]).run();
      if (old && old.photo_id && old.photo_id !== b.photo_id) await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(old.photo_id).run();
    }
    return json({ item: await env.DB.prepare("SELECT * FROM grocery WHERE id = ?").bind(mt[1]).first() });
  }
  if (mt && m === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM photos WHERE id = (SELECT photo_id FROM grocery WHERE id = ?)").bind(mt[1]),
      env.DB.prepare("DELETE FROM grocery WHERE id = ?").bind(mt[1])]);
    return json({ ok: true });
  }

  // meal plan
  if (p === "/api/plan" && m === "GET") {
    const from = url.searchParams.get("from") || "0000", to = url.searchParams.get("to") || "9999";
    return json({ entries: (await env.DB.prepare("SELECT * FROM plan WHERE day >= ? AND day <= ? ORDER BY day, created").bind(from, to).all()).results });
  }
  if (p === "/api/plan" && m === "POST") {
    const b = await body();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || ""))) return err("Pick a day.");
    if (!b.recipe_id && !String(b.note || "").trim()) return err("Pick a recipe or type a note.");
    await env.DB.prepare("INSERT INTO plan (id,day,recipe_id,note,added_by,created) VALUES (?,?,?,?,?,?)").bind(uid(), b.day, b.recipe_id || null, String(b.note || "").trim().slice(0, 200), user.id, Date.now()).run();
    return json({ ok: true });
  }
  mt = p.match(/^\/api\/plan\/([\w-]+)$/);
  if (mt && m === "DELETE") { await env.DB.prepare("DELETE FROM plan WHERE id = ?").bind(mt[1]).run(); return json({ ok: true }); }
  if (mt && m === "PUT") {
    const b = await body();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day || ""))) return err("Pick a day.");
    await env.DB.prepare("UPDATE plan SET day = ? WHERE id = ?").bind(b.day, mt[1]).run();
    return json({ ok: true });
  }

  // backup
  if (p === "/api/export" && m === "GET") {
    const recipes = (await env.DB.prepare("SELECT * FROM recipes").all()).results;
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
async function getStores(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'stores'").first();
  try { const v = row && JSON.parse(row.value); if (Array.isArray(v)) return v; } catch {}
  return DEFAULT_STORES;
}
async function startSession(env, userId) {
  const token = randHex(32);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires) VALUES (?,?,?)").bind(token, userId, Date.now() + SESSION_DAYS * 864e5).run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
}

function pngResponse(b64data) {
  const bin = Uint8Array.from(atob(b64data), c => c.charCodeAt(0));
  return new Response(bin, { headers: { "content-type": "image/png", "cache-control": "public, max-age=604800" } });
}

export default {
  async fetch(req, env) {
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
      if (url.pathname === "/manifest.webmanifest") {
        return new Response(JSON.stringify({
          name: "Recipe Box", short_name: "Recipes", start_url: "/", display: "standalone",
          background_color: "#f4f6f1", theme_color: "#2f5d3a",
          icons: [{ src: "/icon-180.png", sizes: "180x180", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }]
        }), { headers: { "content-type": "application/manifest+json" } });
      }
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    } catch (e) {
      return json({ error: "Something went wrong on the server: " + (e && e.message || e) }, 500);
    }
  }
};
