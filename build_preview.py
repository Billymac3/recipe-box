"""Build preview.html: the real app UI with a fake in-browser server and example recipes."""
import pathlib, re

root = pathlib.Path(__file__).parent
html = (root / "src" / "app.html").read_text()

MOCK = r"""
<script>
try { if (!localStorage.getItem("rb-seen-version")) localStorage.setItem("rb-seen-version", "1.0"); } catch {}
(function(){
  const P = /*PALETTE*/null;
  const uid = () => Math.random().toString(36).slice(2, 12);
  const now = Date.now();
  const ME = { id: "u1", email: "you@example.com", name: "Billy", quick_key: "example-key-only-in-preview", is_admin: true };
  let HOUSEHOLD = { id: "h1", name: "Our household" };
  const HOUSEHOLDS = [{ id: "h1", name: "Our household", members: 2, recipes: 6 }, { id: "h2", name: "The Lees (example)", members: 3, recipes: 14 }];
  const usage = () => ({ requests: 4210, neurons: 310, imports: 1, gemini: 11, geminiStatus: { state: "ok" }, dbsize: 3.4e6, pct: { requests: .0421, neurons: .031, dbsize: .00068 } });
  const R = (o) => Object.assign({ id: uid(), category: "Mains", prep_min: 0, cook_min: 0, servings: "", ingredients: "", steps: "", notes: "", tags: "", source_url: "", source_name: "", image_url: "", photo_id: "", favorite: 0, added_by: "u1", created: now, updated: now }, o);
  const db = {
    recipes: [
      R({ title: "Sheet Pan Lemon Garlic Chicken", category: "Mains", prep_min: 15, cook_min: 35, servings: "4", favorite: 1,
        ingredients: "2 lb boneless skinless chicken thighs\n1 lb baby potatoes, halved\n3 tbsp olive oil\n4 cloves garlic, minced\n1 lemon, zested and juiced\n1 tsp dried oregano\n1 tsp kosher salt\n½ tsp black pepper\n2 cups green beans, trimmed",
        steps: "Heat the oven to 425°F and line a sheet pan with foil.\nToss the potatoes with 1 tbsp olive oil and a pinch of salt. Roast for 10 minutes.\nWhisk the remaining olive oil with the garlic, lemon zest, lemon juice, oregano, salt and pepper.\nCoat the chicken in the lemon mixture and nestle it among the potatoes.\nAdd the green beans around the edges and roast 20-25 minutes, until the chicken reaches 165°F.\nRest 5 minutes, then squeeze over a little more lemon before serving.",
        notes: "Thighs stay juicier than breasts. Leftovers keep 3 days.", tags: "weeknight, one pan", source_name: "example recipe" }),
      R({ title: "Buttermilk Pancakes", category: "Breakfast", prep_min: 10, cook_min: 15, servings: "8 pancakes", added_by: "u2",
        ingredients: "2 cups all-purpose flour\n2 tbsp sugar\n2 tsp baking powder\n½ tsp baking soda\n½ tsp salt\n2 cups buttermilk\n2 large eggs\n3 tbsp butter, melted",
        steps: "Whisk the flour, sugar, baking powder, baking soda and salt in a large bowl.\nIn another bowl whisk the buttermilk, eggs and melted butter.\nPour the wet into the dry and stir until just combined. Lumps are fine.\nLet the batter rest 5 minutes while the griddle heats over medium.\nCook ¼ cup of batter at a time for 2 minutes, until bubbles form, then flip and cook 1 minute more.",
        tags: "weekend", source_name: "example recipe" }),
      R({ title: "Brown Butter Chocolate Chip Cookies", category: "Desserts", prep_min: 20, cook_min: 12, servings: "24 cookies", favorite: 1,
        ingredients: "Dough:\n1 cup butter\n1 ½ cups brown sugar\n2 large eggs\n2 tsp vanilla\n2 ¼ cups flour\n1 tsp baking soda\n1 tsp salt\n2 cups chocolate chips\nTopping:\nFlaky sea salt",
        steps: "Dough:\nMelt the butter in a pan and cook 4-5 minutes, swirling, until it smells nutty and turns golden brown.\nPour into a bowl and cool 10 minutes.\nBeat in the brown sugar, then the eggs and vanilla.\nStir in the flour, baking soda and salt, then fold in the chocolate chips.\nBake:\nScoop 2 tbsp balls onto a lined sheet and bake at 350°F for 11 minutes.\nSprinkle with flaky sea salt while warm.",
        tags: "baking", source_name: "example recipe" }),
      R({ title: "Creamy Tomato Soup", category: "Soups", prep_min: 10, cook_min: 30, servings: "6",
        ingredients: "2 tbsp butter\n1 onion, diced\n3 cloves garlic\n2 cans (28 oz) whole tomatoes\n2 cups chicken broth\n½ cup heavy cream\n1 tsp salt\nFresh basil",
        steps: "Melt the butter in a pot and cook the onion 6 minutes until soft.\nAdd the garlic and cook 1 minute.\nAdd the tomatoes and broth, bring to a boil, then simmer 20 minutes.\nBlend until smooth, stir in the cream and salt, and serve with basil.",
        source_name: "example recipe" }),
      R({ title: "Street Corn Salad", category: "Salads", prep_min: 15, servings: "4",
        ingredients: "4 cups corn kernels\n½ cup cotija cheese\n¼ cup mayonnaise\n1 lime, juiced\n1 tsp chili powder\n¼ cup cilantro",
        steps: "Char the corn in a dry skillet over high heat for 6-8 minutes.\nMix the mayonnaise, lime and chili powder.\nToss everything together and top with cilantro and cotija cheese.",
        source_name: "example recipe" }),
      R({ title: "Iced Honey Lavender Latte", category: "Drinks", prep_min: 5, servings: "1",
        ingredients: "2 shots espresso\n1 tbsp honey\n¼ tsp lavender syrup\n1 cup milk\nIce", steps: "Stir the honey and lavender syrup into the hot espresso.\nFill a glass with ice and milk, then pour the espresso over.", source_name: "example recipe" })
    ],
    grocery: [], plan: [],
    stores: ["Costco","Walmart","Aldi","Kroger","Meijer","Target","Sam's Club"]
  };
  [["Eggs (5 dozen)","Costco"],["Rotisserie chicken","Costco"],["Paper towels","Costco"],["Bananas","Aldi"],["Milk","Aldi"],["Shredded cheese","Aldi"],["Kids' shampoo","Target",null,"sample1"],["Birthday card","Target"],["Lemons",null],["Fresh basil",null],["Olive oil spray",null,"https://www.example.com/olive-oil-spray"]]
    .forEach(([t, st, link, ph], i) => db.grocery.push({ id: uid(), text: t, recipe_id: null, checked: 0, store: st, link: link || null, photo_id: ph || null, added_by: i % 3 === 1 ? "u1" : "u2", created: now - (11 - i) * 5.3e6 }));
  const key = t => String(t||"").toLowerCase().split(",")[0].replace(/\(.*?\)/g," ").replace(/^[\s\d¼½¾.\/-]+/,"").replace(/[^a-z0-9' ]+/g," ").replace(/\s+/g," ").trim().replace(/(es|s)$/,"");
  const people = [{ id: "u1", name: "Billy" }, { id: "u2", name: "Your wife" }];
  window.PREVIEW_PHOTOS = {};
  // a drawn stand-in photo for the example "Kids' shampoo" item
  function samplePhoto(){
    const c = document.createElement("canvas"); c.width = 600; c.height = 450; const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 600, 450); g.addColorStop(0, "#bfe3ff"); g.addColorStop(1, "#ffd6e8"); x.fillStyle = g; x.fillRect(0, 0, 600, 450);
    x.fillStyle = "#ffffff"; x.beginPath(); x.roundRect(230, 90, 140, 280, 30); x.fill(); x.fillStyle = "#4a8fe0"; x.beginPath(); x.roundRect(255, 50, 90, 50, 12); x.fill();
    x.fillStyle = "#4a8fe0"; x.font = "bold 30px sans-serif"; x.textAlign = "center"; x.fillText("KIDS", 300, 220); x.font = "20px sans-serif"; x.fillText("shampoo", 300, 252);
    x.fillStyle = "rgba(0,0,0,.45)"; x.font = "16px sans-serif"; x.fillText("Example photo", 300, 430);
    window.PREVIEW_PHOTOS.sample1 = c.toDataURL("image/jpeg", .85);
  }
  const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const realFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    const u = new URL(url, "https://preview.local"), p = u.pathname, m = (init && init.method) || "GET";
    let body = {}; try { if (init && typeof init.body === "string") body = JSON.parse(init.body); } catch {}
    await wait(120);
    if (p === "/api/me") { if (!db._pics) { db._pics = 1; samplePhoto(); } }
    if (p === "/api/me") return ok({ user: ME, people, household: HOUSEHOLD, ai: true, version: "3.0", deployed: { "3.0": Date.now() - 3600e3 }, usage: usage(), ads: null, vapid: null });
    if (p === "/api/household") { HOUSEHOLD = { ...HOUSEHOLD, name: body.name }; return ok({ household: HOUSEHOLD }); }
    if (p === "/api/admin/households") return ok({ households: HOUSEHOLDS, openStarters: 0 });
    if (p === "/api/admin/starter" && m === "POST") return ok({ url: "https://recipe-box.example.workers.dev/?start=n7q2x9kfp3wmz8ra", expires: Date.now() + 14 * 864e5 });
    if (p === "/api/admin/starter") return ok({ ok: true });
    if (p === "/api/admin/gemini-test") return ok({ ok: true, status: { state: "ok" } });
    if (p === "/api/admin/usage") { const d = (k) => new Date(Date.now() - k * 864e5).toISOString().slice(0, 10); const days = []; [[6,3100,2],[5,2800,1],[4,5200,7],[3,3900,3],[2,4400,4],[1,6100,9],[0,4210,6]].forEach(([k, r, a]) => { days.push({ day: d(k), key: "requests", n: r }, { day: d(k), key: "ai_calls", n: a }); }); return ok({ today: usage(), days, limits: {} }); }
    if (p === "/api/import/ocr") { await wait(700); return ok({ text: "Garlic butter shrimp 🍤\nYou need: 1 lb shrimp, 4 tbsp butter, 5 cloves garlic, juice of 1 lemon, parsley\nMelt butter, add garlic 1 minute, add shrimp 2-3 minutes per side, finish with lemon." }); }
    if (p.startsWith("/api/push/")) return ok({ ok: true, id: uid() });
    if (p === "/api/invites" && m === "POST") return ok({ url: "https://recipe-box.example.workers.dev/?invite=k3x9q2mfp8tw4zra", expires: Date.now() + 7 * 864e5 });
    if (p === "/api/invites" && m === "GET") return ok({ open: 0 });
    if (p === "/api/invites" && m === "DELETE") return ok({ ok: true });
    if (p === "/api/reset/create") return ok({ code: "K7QM-4XPA", name: (people.find(x => x.id === body.user_id) || {}).name || "" });
    if (p === "/api/reset/use") return ok({ ok: true });
    if (p === "/api/recipes" && m === "GET") return ok({ recipes: [...db.recipes].sort((a,b) => a.title.localeCompare(b.title)) });
    if (p === "/api/recipes" && m === "POST") { const r = R(body); db.recipes.push(r); return ok({ recipe: r }); }
    let mt = p.match(/^\/api\/recipes\/(\w+)$/);
    if (mt && m === "PUT") { const r = db.recipes.find(x => x.id === mt[1]); Object.assign(r, body, { favorite: body.favorite === undefined ? r.favorite : (body.favorite ? 1 : 0) }); return ok({ recipe: r }); }
    if (mt && m === "DELETE") { db.recipes = db.recipes.filter(x => x.id !== mt[1]); return ok({ ok: true }); }
    if (p === "/api/import/text") { await wait(400); const r = parseRecipeText(body.text || ""); if (r.usable) return ok({ recipe: { ...r, source_url: body.source_url || "", source_name: "" }, method: "sorted" }); }
    if (p.startsWith("/api/import/")) { await wait(1200); return ok({ recipe: { title: "Example Imported Recipe", category: "Mains", prep_min: 10, cook_min: 20, servings: "4", ingredients: "1 lb pasta\n2 cups marinara sauce\n½ cup parmesan", steps: "Boil the pasta for 10 minutes.\nWarm the sauce and toss with the pasta.\nTop with parmesan.", notes: "In this preview every import returns this example.", tags: "", source_url: "", source_name: "preview" } }); }
    if (p === "/api/photos") { const id = "p" + uid(); window.PREVIEW_PHOTOS[id] = "data:image/jpeg;base64," + body.data; return ok({ id }); }
    if (p === "/api/grocery" && m === "GET") return ok({ items: [...db.grocery].sort((a,b) => a.checked - b.checked || a.created - b.created), stores: db.stores });
    if (p === "/api/grocery" && m === "POST") { (body.items || []).forEach((t, i) => { db.grocery.push({ id: uid(), text: t, recipe_id: body.recipe_id || null, checked: 0, store: body.store || null, added_by: "u1", created: Date.now() + i }); }); return ok({ added: (body.items || []).length }); }
    if (p === "/api/grocery/bulk") { const ids = new Set(body.ids || []); if (body.remove) db.grocery = db.grocery.filter(g => !ids.has(g.id)); else db.grocery.forEach(g => { if (ids.has(g.id)) g.store = body.store || null; }); return ok({ changed: ids.size }); }
    if (p === "/api/stores") { db.stores = [...new Set((body.stores || []).map(x => String(x).trim()).filter(Boolean))]; return ok({ stores: db.stores }); }
    if (p === "/api/grocery/clear") { db.grocery = body.all ? [] : db.grocery.filter(g => !g.checked); return ok({ ok: true }); }
    mt = p.match(/^\/api\/grocery\/(\w+)$/);
    if (mt && m === "PUT") { const g = db.grocery.find(x => x.id === mt[1]); if (g) { if ("checked" in body) g.checked = body.checked ? 1 : 0; if ("text" in body) g.text = String(body.text).trim(); if ("store" in body) g.store = body.store || null; if ("link" in body) { let l = String(body.link || "").trim(); if (l && !/^https?:\/\//i.test(l)) l = "https://" + l; g.link = l || null; } if ("photo_id" in body) g.photo_id = body.photo_id || null; return ok({ item: g }); } return ok({ ok: true }); }
    if (mt && m === "DELETE") { db.grocery = db.grocery.filter(x => x.id !== mt[1]); return ok({ ok: true }); }
    if (p === "/api/plan" && m === "GET") { const f = u.searchParams.get("from"), t = u.searchParams.get("to"); return ok({ entries: db.plan.filter(e => e.day >= f && e.day <= t) }); }
    if (p === "/api/plan" && m === "POST") { db.plan.push({ id: uid(), day: body.day, recipe_id: body.recipe_id, note: body.note || "", created: Date.now() }); return ok({ ok: true }); }
    mt = p.match(/^\/api\/plan\/(\w+)$/);
    if (mt && m === "PUT") { const e = db.plan.find(x => x.id === mt[1]); if (e) e.day = body.day; return ok({ ok: true }); }
    if (mt) { db.plan = db.plan.filter(x => x.id !== mt[1]); return ok({ ok: true }); }
    if (p === "/api/logout") return ok({ ok: true });
    return ok({});
  };
})();
</script>
"""

BANNER = r"""
<div id="pv" style="position:sticky;top:0;z-index:40;background:var(--ink);color:var(--bg);padding:8px max(16px,env(safe-area-inset-left,0px));display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:.82rem;font-weight:700">
  <span style="flex:1;min-width:10em">Preview · example recipes · nothing is saved</span>
  <button data-pvlook style="border:0;border-radius:999px;padding:7px 12px;font-weight:800;background:var(--accent);color:var(--on-accent)">Change look →</button>
</div>
<style>.ftimers{top:66px}</style>
<script>document.getElementById("pv").addEventListener("click", e => { if (e.target.closest("[data-pvlook]")) { closeCook(); S.meOpen = "look"; go("me"); } });</script>
"""

# strip the document wrapper (the artifact host adds its own)
head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
head = re.sub(r'<meta charset[^>]*>\s*|<meta name="viewport"[^>]*>\s*|<link rel="(apple-touch-icon|manifest)"[^>]*>\s*|<meta name="(apple|mobile)-[^>]*>\s*', "", head)
head = head.replace("<title>Recipe Box</title>", "<title>Recipe Box Preview</title>")
# the preview runs inside a frame that already pads for the phone's notch
head = head.replace("padding-top:env(safe-area-inset-top,0px)}", "}", 1)
main_script_at = body.index("<script>\n\"use strict\";")
body = body[:main_script_at] + "<script>" + (root / "src" / "parse.js").read_text() + "</script>\n" + MOCK + body[main_script_at:]
body = body.replace('<div class="wrap" id="app">', BANNER + '<div class="wrap" id="app">', 1)
out = head.strip() + "\n" + body.strip() + "\n"
(root / "dist" / "preview.html").write_text(out)
print("preview.html", len(out) // 1024, "KB")
