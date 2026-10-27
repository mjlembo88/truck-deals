/* Truck Deals service worker.
   CACHE_VERSION: bump this when the app shell changes. */
const CACHE_VERSION = "td-v6-recalls";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./vendor/leaflet/images/layers.png",
  "./vendor/leaflet/images/layers-2x.png",
  "./vendor/leaflet/images/marker-icon.png",
  "./vendor/leaflet/images/marker-icon-2x.png",
  "./vendor/leaflet/images/marker-shadow.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            const res = await fetch(new Request(url, { cache: "reload" }));
            if (res && res.ok) await cache.put(url, res);
          } catch (err) {
            /* one missing shell file should not block install */
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isDataJson(pathname) {
  const file = pathname.split("/").pop();
  return file === "data.json";
}

function cleanDataUrl(url) {
  const clean = new URL(url);
  clean.search = "";
  clean.hash = "";
  return clean.href;
}

function tagResponse(response, source) {
  const headers = new Headers(response.headers);
  headers.set("X-TD-Source", source);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function networkFirstData(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cleanUrl = cleanDataUrl(req.url);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      await cache.put(cleanUrl, fresh.clone());
      return tagResponse(fresh, "network");
    }
    const cached = (await cache.match(cleanUrl)) || (await cache.match(req, { ignoreSearch: true }));
    if (cached) return tagResponse(cached, "cache");
    return fresh;
  } catch (err) {
    const cached = (await cache.match(cleanUrl)) || (await cache.match(req, { ignoreSearch: true }));
    if (cached) return tagResponse(cached, "cache");
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  if (fresh && fresh.ok && fresh.type === "basic") {
    try {
      await cache.put(req, fresh.clone());
    } catch (err) {
      /* ignore cache write failures (opaque redirects, etc.) */
    }
  }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isDataJson(url.pathname)) {
    event.respondWith(networkFirstData(req));
    return;
  }

  event.respondWith(
    (async () => {
      try {
        return await cacheFirst(req);
      } catch (err) {
        if (req.mode === "navigate") {
          const cache = await caches.open(CACHE_VERSION);
          const fallback = (await cache.match("./index.html")) || (await cache.match("./"));
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});
