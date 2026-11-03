/**
 * Service worker: makes hoppu open without a network.
 *
 * Strategy: network-first for the app's own files, cache as fallback.
 * Online, every launch gets the current version from the server, so a new
 * deploy shows up immediately and no version number has to be bumped.
 * Offline (or after FETCH_TIMEOUT_MS on a bad connection), the last cached
 * copy is used. Digitransit API calls are cross-origin and never touched:
 * timetables and realtime data must always be fresh. Map tiles
 * (tile.openstreetmap.org) are cross-origin too and left to the browser's
 * HTTP cache.
 *
 * Bump CACHE only when this file's caching logic changes incompatibly.
 */

const CACHE = "hoppu-shell-v1";
const FETCH_TIMEOUT_MS = 3000;

// Everything needed to start the app offline. Paths are relative to this
// file, so the app works under a GitHub Pages subpath (/repo/).
// web/tests/core.test.js checks this list against the files on disk.
const SHELL = [
  "./",
  "index.html",
  "app.css",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "js/analysis.js",
  "js/app.js",
  "js/digitransit.js",
  "js/geocache.js",
  "js/hfp.js",
  "js/map.js",
  "js/models.js",
  "js/places.js",
  "js/polyline.js",
  "js/presets.js",
  "js/ratelimit.js",
  "js/render.js",
  "js/ride.js",
  "js/settings.js",
  "js/suggest.js",
  "js/time.js",
  "js/transfers.js",
  "vendor/leaflet/leaflet.css",
  "vendor/leaflet/leaflet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // "reload" bypasses the HTTP cache, so the shell is really current.
      .then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: "reload" }))))
      // Take over without waiting for old tabs to close. Safe here because
      // the page loads all its modules at startup and never lazily later.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only our own GETs. Returning without respondWith lets the browser
  // handle everything else (Digitransit API, external links) normally.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

/** @param {Request} req */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  // "no-cache" revalidates with the server (cheap 304 when unchanged)
  // instead of trusting the HTTP cache, which on GitHub Pages is 10 min.
  const network = fetch(req, { cache: "no-cache" }).then((resp) => {
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  });
  // If we fall back to the cache, a later network failure is expected;
  // don't let it surface as an unhandled rejection.
  network.catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, FETCH_TIMEOUT_MS, null));
  try {
    const fast = await Promise.race([network, timeout]);
    if (fast) return fast;
  } catch {
    // Network error: fall through to the cache.
  }
  // Navigations to "./" or "./?x" should still find the cached page.
  const cached = await cache.match(req, { ignoreSearch: true });
  // Slow but not failed: keep waiting for the network rather than error.
  return cached ?? network;
}
