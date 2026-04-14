const STATIC_CACHE = 'jd-static-v4';
const DYNAMIC_CACHE = 'jd-dynamic-v4';
const API_CACHE = 'jd-api-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== STATIC_CACHE && key !== DYNAMIC_CACHE) {
            return caches.delete(key);
          }
          return null;
        })
      )
    ).then(() => self.clients.claim())
  );
});

function shouldBypass(request) {
  if (request.method !== 'GET') return true;
  const url = new URL(request.url);
  return url.pathname.startsWith('/api/v1/admin');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (shouldBypass(request)) return;

  const url = new URL(request.url);
  const isStatic = STATIC_ASSETS.includes(url.pathname);
  const isPublicConfig = url.pathname === '/api/v1/public-config';
  const isProductsApi = url.pathname === '/api/v1/products';
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  if (isPublicConfig) {
    event.respondWith(staleWhileRevalidate(request, DYNAMIC_CACHE));
    return;
  }

  if (isProductsApi) {
    event.respondWith(staleWhileRevalidateJson(request, API_CACHE));
    return;
  }

  if (isImage) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((res) => {
            const clone = res.clone();
            caches.open(DYNAMIC_CACHE).then((cache) => cache.put(request, clone));
            return res;
          })
          .catch(() => cached);
      })
    );
    return;
  }

  // default: network first with cache fallback
  event.respondWith(
    fetch(request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(DYNAMIC_CACHE).then((cache) => cache.put(request, resClone));
        return res;
      })
      .catch(() => caches.match(request))
  );
});

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
}

async function staleWhileRevalidateJson(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then(async (response) => {
      if (response && response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || networkFetch;
}
