const STATIC_CACHE = 'jd-static-v8';
const DYNAMIC_CACHE = 'jd-dynamic-v8';
const API_CACHE = 'jd-api-v5';

const STATIC_ASSETS = [
  './vendor/qrcode.min.js',
  './manifest.json'
];

function getScopeBasePath() {
  try {
    const scope = self.registration?.scope || self.location.href;
    const scopePath = new URL(scope).pathname;
    return scopePath.endsWith('/') ? scopePath : `${scopePath}/`;
  } catch {
    return '/';
  }
}

function toScopedPath(asset) {
  const basePath = getScopeBasePath();
  const rel = asset.replace(/^\.\//, '');
  return `${basePath}${rel}`.replace(/\/{2,}/g, '/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS.map(toScopedPath)))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== STATIC_CACHE && key !== DYNAMIC_CACHE && key !== API_CACHE) {
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
  return url.pathname.includes('/api/v1/admin');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (shouldBypass(request)) return;

  const url = new URL(request.url);
  const scopeBase = getScopeBasePath();
  const accept = request.headers.get('accept') || '';
  const isSameOrigin = url.origin === self.location.origin;
  const pathname = isSameOrigin && url.pathname.startsWith(scopeBase) ? url.pathname.slice(scopeBase.length - 1) : url.pathname;
  const isHtml = request.mode === 'navigate' || accept.includes('text/html');

  const isStatic = isSameOrigin && STATIC_ASSETS.map(toScopedPath).includes(url.pathname);
  const isConfig = isSameOrigin && url.pathname === toScopedPath('./config.js');
  const isPublicConfig = pathname.includes('/api/v1/public-config');
  const isProductsApi = pathname.includes('/api/v1/products');
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(url.pathname);
  const isCodeAsset = isSameOrigin && /\.(js|css)$/i.test(url.pathname);

  if (isHtml) {
    event.respondWith(networkFirst(request, DYNAMIC_CACHE));
    return;
  }

  if (isConfig || isCodeAsset) {
    event.respondWith(networkFirst(request, DYNAMIC_CACHE));
    return;
  }

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

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw new Error(`Network unavailable for ${request.url}`);
  }
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
