// Recipe Box service worker: keeps the app opening with no signal and shows timer alerts.
const VERSION = "__VERSION__";
const SHELL = "rb-shell-" + VERSION, DATA = "rb-data", PHOTOS = "rb-photos", FONTS = "rb-fonts";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(["/", "/manifest.webmanifest", "/icon-180.png", "/icon-512.png"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("rb-shell-") && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// network first, saved copy when offline
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) { const h = new Headers(hit.headers); h.set("x-offline", "1"); return new Response(hit.body, { status: hit.status, headers: h }); }
    throw new Error("offline");
  }
}
async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode === "navigate") { e.respondWith(networkFirst(new Request("/"), SHELL).catch(() => caches.match("/"))); return; }
    if (/^\/api\/(me|recipes|grocery|plan)(\?|$)/.test(url.pathname + url.search.slice(0, 1))) { e.respondWith(networkFirst(req, DATA)); return; }
    if (url.pathname.startsWith("/photo/")) { e.respondWith(cacheFirst(req, PHOTOS)); return; }
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") e.respondWith(cacheFirst(req, FONTS));
});

// lock-screen timer alerts
self.addEventListener("push", e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: "Recipe Box", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Recipe Box", {
    body: d.body || "", tag: d.tag || "recipe-box", renotify: true, icon: "/icon-180.png", badge: "/icon-180.png", requireInteraction: true, data: { url: "/" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("/");
  }));
});
