// Recipe sorter that needs no AI: turns pasted or captioned recipe text into
// title, ingredients, steps, servings and times using common recipe formatting.
// Shared by the server (links and captions) and the app (pasted text).
function parseRecipeText(raw) {
  const text = String(raw || "").replace(/\r/g, "").replace(/ /g, " ");
  const BULLET = /^\s*(?:[-–—*•·▪▫◦‣⁃○●■□▢☐✓✔✅☑️🔸🔹🔶🔷➡️👉🌟⭐️✨🍋🧄🧅🥕🍗🥩🧈🥚🧂🌶️]|\(?\d{1,2}[.)]|step\s*\d+[:.)]?)\s*/iu;
  const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu;
  const bare = l => l.replace(EMOJI, "").replace(/[*_~|]+/g, "").trim();
  const lines = text.split("\n").map(l => l.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  const HEAD_ING = /^(?:the\s+)?(?:ingredients?|what you(?:'|’)?ll need|you(?:'|’)?ll need|you need|shopping list)\b[\s:：-]*$/i;
  const HEAD_STEP = /^(?:instructions?|directions?|method|steps|preparation|how to make(?: it)?|to make|make it)\b[\s:：-]*$/i;
  const HEAD_NOTE = /^(?:notes?|tips?|recipe notes?|cook(?:'|’)?s notes?|storage)\b[\s:：-]*$/i;
  const UNITS = "cups?|c\\.|tbsps?|tbs|tablespoons?|tsps?|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|l|liters?|litres?|pinch(?:es)?|dash(?:es)?|cloves?|cans?|jars?|packages?|pkgs?|sticks?|slices?|bunch(?:es)?|heads?|sprigs?|handfuls?|quarts?|pints?|gallons?|large|medium|small|whole";
  const QTY = new RegExp(`^(?:\\d+\\s*\\d*\\/?\\d*|\\d*\\.\\d+|[¼½¾⅓⅔⅛⅜⅝⅞]|a|an|one|two|three|four|half)\\s*(?:[-–to]+\\s*\\d+\\S*\\s*)?(?:${UNITS})?\\b`, "i");
  const ACTION = /^(?:add|bake|beat|blend|boil|bring|broil|brown|chill|chop|combine|cook|cool|cover|cut|dice|drain|drizzle|fold|fry|garnish|grate|grease|grill|heat|knead|layer|let|line|marinate|mash|melt|mince|mix|place|pour|preheat|reduce|remove|rest|roast|roll|saute|sauté|season|serve|set|simmer|slice|spread|sprinkle|stir|strain|toss|transfer|turn|whisk|wrap|in a|in the|once|meanwhile|then|while|when|after|using)\b/i;
  const isIng = l => {
    const s = l.replace(BULLET, "");
    if (s.length > 110) return false;
    if (QTY.test(s) && !ACTION.test(s)) return true;
    return /\b(?:to taste|for garnish|optional)\b/i.test(s) && s.length < 60;
  };
  const isStep = l => { const s = l.replace(BULLET, ""); return ACTION.test(s) || s.length > 70 || /^\(?\d{1,2}[.)]\s/.test(l) || /^step\s*\d/i.test(l); };
  const clean = l => l.replace(BULLET, "").replace(EMOJI, "").replace(/\s{2,}/g, " ").replace(/^[:\-–\s]+/, "").trim();
  const minutes = s => { const h = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/i.exec(s), m = /(\d+)\s*(?:m|min|mins|minutes?)\b/i.exec(s); return Math.round((h ? +h[1] * 60 : 0) + (m ? +m[1] : 0)); };

  let servings = "", prep = 0, cook = 0, total = 0, title = "";
  const ing = [], steps = [], notes = [];
  let mode = "", sawIngHead = false, sawStepHead = false;
  const metaLine = l => {
    let m;
    if ((m = /^(?:serves|servings?|yield|yields|makes)\s*[:：-]?\s*(.{1,30})$/i.exec(l))) { servings = m[1].replace(/[.)]+$/, "").trim(); return true; }
    if (/^prep(?:aration)?(?:\s*time)?\s*[:：-]/i.test(l)) { prep = minutes(l); return true; }
    if (/^cook(?:ing)?(?:\s*time)?\s*[:：-]/i.test(l) || /^bake(?:\s*time)?\s*[:：-]/i.test(l)) { cook = minutes(l); return true; }
    if (/^total(?:\s*time)?\s*[:：-]/i.test(l)) { total = minutes(l); return true; }
    return false;
  };
  for (const l of lines) {
    const b = bare(l);
    if (!b) continue;
    if (HEAD_ING.test(b)) { mode = "ing"; sawIngHead = true; continue; }
    if (HEAD_STEP.test(b)) { mode = "step"; sawStepHead = true; continue; }
    if (HEAD_NOTE.test(b)) { mode = "note"; continue; }
    if (metaLine(l)) continue;
    if (!title && !mode && !isIng(l) && l.length <= 120 && !/^https?:/i.test(l)) { title = clean(l).split(/[!.?]+\s|[!]{1,}$| [-–|] /)[0].replace(/[!:.,]+$/, "").trim(); if (title.length > 70) title = title.slice(0, 70).replace(/\s+\S*$/, ""); continue; }
    // a short line ending in ":" inside a section is a sub-heading ("For the sauce:")
    if (mode && /:$/.test(l) && l.length < 50 && !QTY.test(l)) { (mode === "step" ? steps : mode === "note" ? notes : ing).push(clean(l)); continue; }
    if (mode === "ing") { if (!sawStepHead && isStep(l) && !isIng(l)) { mode = "step"; steps.push(clean(l)); } else ing.push(clean(l)); continue; }
    if (mode === "step") { steps.push(clean(l)); continue; }
    if (mode === "note") { notes.push(clean(l)); continue; }
    // no headings yet: sort each line by how it looks
    if (isIng(l)) ing.push(clean(l)); else if (isStep(l)) steps.push(clean(l)); else if (title) notes.push(clean(l));
  }
  if (!cook && total > prep) cook = total - prep;
  const ingredients = ing.filter(Boolean), stepList = steps.filter(Boolean);
  return {
    title: (title || "Untitled recipe").slice(0, 140), category: "Other",
    prep_min: prep, cook_min: cook, servings,
    ingredients: ingredients.join("\n"), steps: stepList.join("\n"), notes: notes.join("\n"), tags: "",
    // confident = clearly laid out, so no AI is needed to sort it
    confident: sawIngHead && ingredients.length >= 2 && stepList.length >= 1,
    usable: ingredients.length >= 2
  };
}
