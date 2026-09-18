const CACHE_NAME = "analytics-pro-v5";
const APP_CACHE_PATTERN = /^analytics-pro-v\d+$/;
const CORE_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"
];
const APP_SCOPE = new URL(self.registration.scope);
const CORE_URLS = new Set(CORE_ASSETS.map((url) => new URL(url, APP_SCOPE).href));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // A missing optional CDN asset must not prevent installation.
    await Promise.all(CORE_ASSETS.map((url) => cache.add(url).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Never remove another application's caches or user backup caches.
    await Promise.all(keys
      .filter((key) => APP_CACHE_PATTERN.test(key) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isAppNavigation = request.mode === "navigate"
    && url.origin === APP_SCOPE.origin
    && url.pathname.startsWith(APP_SCOPE.pathname);
  // Do not intercept API traffic, arbitrary CDN content, or other applications.
  if (!isAppNavigation && !CORE_URLS.has(url.href)) return;

  const cachePromise = caches.open(CACHE_NAME).catch(() => null);
  const cachedPromise = cachePromise.then((cache) =>
    cache ? cache.match(request).catch(() => undefined) : undefined
  );
  const networkPromise = fetch(request);

  // Register synchronously and keep the worker alive until cache.put finishes.
  // A storage failure must not turn a successful network request into a failure.
  event.waitUntil((async () => {
    try {
      const response = await networkPromise;
      if (response && response.status === 200) {
        const copy = response.clone();
        const cache = await cachePromise;
        if (cache) await cache.put(request, copy);
      }
    } catch {
      // Offline requests and full/unavailable storage are handled by respondWith.
    }
  })());

  const fallbackPromise = networkPromise.catch(async () => {
    const cached = await cachedPromise;
    if (cached) return cached;
    if (isAppNavigation) {
      const cache = await cachePromise;
      const shell = cache ? await cache.match("./index.html").catch(() => undefined) : undefined;
      if (shell) return shell;
    }
    // An image or script must never receive the HTML app shell as its contents.
    return Response.error();
  });

  event.respondWith(cachedPromise.then((cached) => cached || fallbackPromise));
});
