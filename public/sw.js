// Minimal, safe service worker for an installable PWA.
// Strategy:
//   - Content-hashed Next assets (/_next/static/*) are immutable -> cache-first.
//   - Everything else (pages, API, data) -> network-first, fall back to cache,
//     then to a basic offline message. This avoids serving stale app code,
//     which is the classic PWA footgun while actively developing.
const CACHE = "membro-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Immutable hashed assets: cache-first.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        cache.put(request, res.clone());
        return res;
      }),
    );
    return;
  }

  // Everything else: network-first with cache fallback.
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put(request, res.clone());
        return res;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          return new Response(
            "<h1>Offline</h1><p>You're offline and this page isn't cached yet.</p>",
            { headers: { "Content-Type": "text/html" }, status: 503 },
          );
        }
        return Response.error();
      }
    })(),
  );
});
