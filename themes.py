"""Generates the color palettes and font styles for the app (light + dark for every palette)."""
BASE_KEYS = ["bg","card","ink","muted","line","accent","accent-soft","on-accent","accent-ink","pop","pop-soft","danger"]
KEYS = BASE_KEYS + ["edge", "pop-ink"]
LIGHT_SHADOW = "0 1px 2px rgba(0,0,0,.05), 0 6px 18px rgba(0,0,0,.06)"
PALETTES = {
 # id: (name, light, dark)
 "tomato": ("Tomato",
   ["#ffffff","#ffffff","#2a1714","#7a5f59","#f0e4df","#e0452b","#fff0eb","#ffffff","#c2361e","#ffb81f","#fff6d9","#b42318"],
   ["#1b1110","#271a18","#fbeee9","#c4a59e","#3b2824","#ff6a4d","#3f211b","#1b1110","#ff8a72","#ffc94a","#3a2d12","#ff8a7a"]),
 "blueberry": ("Blueberry",
   ["#ffffff","#ffffff","#1c1940","#625e8e","#e7e6f7","#4a43d6","#efeeff","#ffffff","#3a33c0","#8fcf2c","#f0f9dd","#c2334d"],
   ["#12102a","#1d1b3d","#eeecff","#a8a5d6","#2f2c58","#9d98ff","#2a275c","#12102a","#b4b0ff","#b9ee5c","#26361a","#ff8fa3"]),
 "midnight": ("Midnight",
   ["#ffffff","#ffffff","#16181c","#5f656e","#e6e8eb","#12936a","#e4f6ee","#ffffff","#0e7a57","#f07c43","#fff0e6","#c2361e"],
   ["#111316","#1b1e23","#f3efe8","#9ea3ab","#2b2f36","#5fd9a8","#1c362c","#0d1a14","#7be6bb","#ff9e6d","#3b2519","#ff8a7a"]),
 "beet": ("Beet",
   ["#ffffff","#ffffff","#2b1020","#7d5a6c","#f1e1e9","#c2185b","#fde8f1","#ffffff","#a3134c","#ff8a3d","#fff0e3","#b42318"],
   ["#1c0f16","#281621","#fbe9f1","#c9a2b5","#3d2433","#ff5c9a","#43182d","#1c0f16","#ff7fb0","#ffa463","#3d2616","#ff8a7a"]),
 "seasalt": ("Sea Salt",
   ["#ffffff","#ffffff","#0f2a2e","#557277","#dfeced","#0e8388","#e2f4f4","#ffffff","#0b6d71","#ff6f59","#ffece8","#c2361e"],
   ["#0d1b1d","#152729","#e7f4f4","#93b3b6","#24393c","#3cc7c9","#173a3c","#0b1a1b","#5fd8da","#ff8a77","#3d211c","#ff8a7a"]),
 "lemon": ("Lemon",
   ["#ffffff","#ffffff","#24221c","#6f6a5c","#eee9d8","#f2c200","#fff6cc","#24221c","#7d6300","#3c9a5f","#e6f4ea","#b42318"],
   ["#17160f","#222017","#f6f1dc","#b5ad92","#37331f","#ffd23f","#3a3212","#1b1a12","#ffdc66","#6fd39a","#183625","#ff8a7a"]),
}
FONTS = {
 # id: (name, display, weight, tracking, body, radius, radius-sm, btn-radius, base size, google families)
 "bold": ("Bold", '"Bricolage Grotesque", "Arial Rounded MT Bold", system-ui, sans-serif', 800, "-.02em", '"Figtree", -apple-system, system-ui, sans-serif', "18px","12px","14px","16px"),
 "rounded": ("Rounded", '"Fredoka", "Arial Rounded MT Bold", system-ui, sans-serif', 600, "0", '"Nunito", -apple-system, system-ui, sans-serif', "24px","16px","999px","16px"),
 "classic": ("Classic", '"Gloock", Georgia, serif', 400, "0", '"Instrument Sans", -apple-system, system-ui, sans-serif', "14px","10px","10px","16px"),
 "easy": ("Easy Read", '"Lexend", -apple-system, system-ui, sans-serif', 700, "-.015em", '"Lexend", -apple-system, system-ui, sans-serif', "16px","12px","12px","17px"),
}
GOOGLE = ("https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800"
          "&family=Figtree:wght@400;500;600;700;800&family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800"
          "&family=Gloock&family=Instrument+Sans:wght@400;500;600;700&family=Lexend:wght@400;500;600;700;800&display=swap")

# ---------- contrast tuning ----------
# Every palette is nudged until it meets these contrast ratios (WCAG), keeping its own hues:
#   text: ink 12:1, muted 6:1, accent-ink 6:1 (5:1 on tinted panels), danger 5:1
#   button text on accent 4.5:1, control outlines (--edge) 3:1, dividers (--line) 1.8:1, stars (--pop-ink) 3:1
def _rgb(h): h = h.lstrip("#"); return [int(h[i:i+2], 16) for i in (0, 2, 4)]
def _hex(c): return "#" + "".join(f"{max(0, min(255, round(v))):02x}" for v in c)
def _lum(h):
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = [v / 255 for v in _rgb(h)]
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
def contrast(a, b):
    la, lb = _lum(a), _lum(b); return (max(la, lb) + .05) / (min(la, lb) + .05)
def _mix(a, b, t): ca, cb = _rgb(a), _rgb(b); return _hex([x + (y - x) * t for x, y in zip(ca, cb)])
def _push(color, toward, against, need):
    """Move color step by step toward `toward` until it reaches `need` contrast with every color in `against`."""
    for i in range(0, 101):
        c = _mix(color, toward, i / 100)
        if all(contrast(c, a) >= need for a in against): return c
    return _mix(color, toward, 1)
def tune(vals, dark):
    t = dict(zip(BASE_KEYS, vals))
    far = "#ffffff" if dark else "#000000"
    surfaces = [t["bg"], t["card"]]
    t["ink"] = _push(t["ink"], far, surfaces, 12)
    t["muted"] = _push(t["muted"], t["ink"], surfaces + [t["accent-soft"]], 6)
    t["accent-ink"] = _push(t["accent-ink"], far, surfaces, 6)
    t["accent-ink"] = _push(t["accent-ink"], far, [t["accent-soft"]], 5)
    t["danger"] = _push(t["danger"], far, surfaces, 5)
    # button fill: darken (light) or lighten (dark) the accent until its label reads clearly
    t["accent"] = _push(t["accent"], "#000000" if _lum(t["on-accent"]) > .5 else "#ffffff", [t["on-accent"]], 4.5)   # move away from the label color
    t["line"] = _push(t["bg"], t["muted"], surfaces, 1.8)
    t["edge"] = _push(t["bg"], t["muted"], surfaces, 3.0)
    t["pop-ink"] = _push(t["pop"], far, [t["card"]], 3.0)
    return [t[k] for k in KEYS]

def toks(vals, dark):
    vals = tune(vals, dark)
    t = "; ".join(f"--{k}:{v}" for k, v in zip(KEYS, vals))
    return t + ("; --shadow:none; color-scheme:dark" if dark else f"; --shadow:{LIGHT_SHADOW}; color-scheme:light")

def css():
    out = ["/* Colors: 6 palettes, each with light and dark. Auto follows the phone; data-theme forces one. */"]
    for i, (pid, (name, light, dark)) in enumerate(PALETTES.items()):
        sel = f':root[data-palette="{pid}"]'
        base = (":root, " + sel) if i == 0 else sel
        out.append(f"{base}{{{toks(light, False)}}}")
        dsel = f':root:not([data-palette]):not([data-theme="light"]), {sel}:not([data-theme="light"])' if i == 0 else f'{sel}:not([data-theme="light"])'
        out.append(f"@media (prefers-color-scheme: dark){{{dsel}{{{toks(dark, True)}}}}}")
        fsel = (':root:not([data-palette])[data-theme="dark"], ' if i == 0 else "") + f'{sel}[data-theme="dark"]'
        out.append(f"{fsel}{{{toks(dark, True)}}}")
    out.append("/* Font styles */")
    for i, (fid, (name, disp, w, tr, body, r, rs, rb, base)) in enumerate(FONTS.items()):
        sel = f':root[data-font="{fid}"]'
        sel = (":root, " + sel) if i == 0 else sel
        out.append(f"{sel}{{--display:{disp}; --display-weight:{w}; --display-track:{tr}; --body:{body}; --radius:{r}; --radius-sm:{rs}; --btn-radius:{rb}; --base:{base}}}")
    return "\n".join(out) + "\n"

def js():
    pals = ",\n  ".join(f'{{ id: "{pid}", name: "{n}", sw: ["{l[5]}","{l[9]}","{d[0]}"] }}' for pid, (n, l, d) in PALETTES.items())
    fonts = ",\n  ".join(f'{{ id: "{fid}", name: "{v[0]}", display: {v[1]!r}, weight: {v[2]}, body: {v[4]!r} }}' for fid, v in FONTS.items())
    return f"const PALETTES = [\n  {pals}\n];\nconst FONTS = [\n  {fonts}\n];\n"
