// Magic Sticky service worker — caches the app shell so the PWA loads offline. Hand-written (no
// build plugin) and runtime-caching, so it adapts to Vite's hashed asset names without a precache
// manifest. NEVER caches /api, /auth, /mcp — those must always hit the network.

const CACHE = "magicsticky-shell-v2";

// Pre-cache the bare entry so a cold offline open still boots; assets cache at runtime as they load.
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/favicon.svg"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch POST/PUT (saves, catch-up, auth)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // third-party (e.g. Google GIS) → network
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/auth") || url.pathname.startsWith("/mcp")) {
    return; // dynamic/auth/streaming — always network
  }

  // NAVIGATIONS (the HTML shell) → NETWORK-FIRST. A new deploy rehashes the asset URLs, so a
  // cached index.html would point at deleted /assets/*.js and break the page. Always fetch fresh
  // index when online; fall back to the cached shell only when the network fails (offline).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // HASHED ASSETS + static files → cache-first (immutable: a change = a new URL, so it's safe and
  // fast). Miss → fetch and cache.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});
