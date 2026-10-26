"""Build dist/worker.js: one self-contained file to paste into Cloudflare."""
import base64, io, json, pathlib
from PIL import Image, ImageDraw

root = pathlib.Path(__file__).parent

def icon(size):
    s = 4  # supersample
    W = size * s
    img = Image.new("RGB", (W, W), (47, 93, 58))  # basil green, full bleed (iOS rounds corners)
    d = ImageDraw.Draw(img)
    cream = (247, 242, 228)
    mustard = (226, 182, 73)
    # recipe card
    cw, ch = W * 0.58, W * 0.44
    x0, y0 = (W - cw) / 2, W * 0.30
    d.rounded_rectangle([x0, y0, x0 + cw, y0 + ch], radius=W * 0.04, fill=cream)
    # mustard header band on the card
    d.rounded_rectangle([x0, y0, x0 + cw, y0 + ch * 0.24], radius=W * 0.04, fill=mustard)
    d.rectangle([x0, y0 + ch * 0.14, x0 + cw, y0 + ch * 0.24], fill=mustard)
    # ruled lines
    for i in range(3):
        ly = y0 + ch * (0.42 + i * 0.17)
        d.rounded_rectangle([x0 + cw * 0.12, ly, x0 + cw * (0.88 if i < 2 else 0.6), ly + W * 0.018], radius=W * 0.009, fill=(47, 93, 58))
    # box behind: front lip
    d.rounded_rectangle([W * 0.16, W * 0.62, W * 0.84, W * 0.80], radius=W * 0.035, fill=(31, 64, 40))
    img = img.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO(); img.save(buf, "PNG", optimize=True)
    (root / "dist").mkdir(exist_ok=True)
    (root / "dist" / f"icon-{size}.png").write_bytes(buf.getvalue())
    return base64.b64encode(buf.getvalue()).decode()

src = (root / "src" / "server.js").read_text()
html = (root / "src" / "app.html").read_text()
out = (src.replace("__APP_HTML__", json.dumps(html))
          .replace("__ICON180__", json.dumps(icon(180)))
          .replace("__ICON512__", json.dumps(icon(512))))
(root / "dist").mkdir(exist_ok=True)
(root / "dist" / "worker.js").write_text(out)
print("worker.js", len(out.encode()) // 1024, "KB")
