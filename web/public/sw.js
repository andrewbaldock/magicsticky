// Magic Sticky service worker — caches the app shell so the PWA loads offline. Hand-written (no
// build plugin) and runtime-caching, so it adapts to Vite's hashed asset names without a precache
// manifest. NEVER caches /api, /auth, /mcp — those must always hit the network (and fail loudly
// offline so the UI can switch to catch-up mode).

const CACHE = "magicsticky-shell-v1";

// On install, pre-cache the bare entry so a cold offline open still boots; assets are added at
// runtime as they load.
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/favicon.svg"])),
  );
  self.skipWaiting();
});

// Drop old caches on activate.
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
  if (url.origin !== self.location.origin) return; // third-party (e.g. Google GIS) → straight to network
  // Dynamic, auth'd, or streaming paths must NOT be cached.
  if (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/auth") ||
    url.pathname.startsWith("/mcp")
  ) {
    return;
  }

  // App shell + assets: cache-first, fall back to network and cache the result. For a navigation
  // that misses both, serve the cached "/" so the SPA still boots offline.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === "navigate" ? caches.match("/") : undefined));
    }),
  );
});
