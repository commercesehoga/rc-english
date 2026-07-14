// WonderMayank RC — service worker
// Caches the static app shell + "today's content" API response so the site keeps working
// through brief offline moments (tunnel, elevator, patchy mobile signal).

const CACHE_VERSION = "wm-rc-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL_FILES = [
  "/",
  "/index.html",
  "/practice.html",
  "/weekly-test.html",
  "/mistakes.html",
  "/style.css",
  "/progress.js",
  "/manifest.json",
  "/favicon.svg",
  "/book.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept POSTs (sync, telegram, etc.)

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // "Today's content" APIs: network-first, cache as a same-day offline fallback.
  if (url.pathname === "/api/today" || url.pathname === "/api/days") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA_CACHE).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) return; // everything else: always hit the network

  // Static shell: cache-first, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
