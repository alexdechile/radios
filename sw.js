const CACHE_NAME = 'radios-sketch-v1.6.4';

// Determinar el prefijo base según dónde esté instalado el Service Worker (ej. '/' o '/radios/')
const basePath = self.location.pathname.substring(0, self.location.pathname.lastIndexOf('/') + 1);

const RELATIVE_ASSETS = [
  '',
  'index.html?v=1.6.4',
  'style.css?v=1.6.4',
  'app.js?v=1.6.4',
  'radios_db.json',
  'manifest.json',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'vendor/plyr/plyr.js',
  'vendor/plyr/plyr.css',
  'vendor/htmx/htmx.min.js',
  'vendor/fontawesome/css/all.min.css',
  'vendor/fontawesome/webfonts/fa-solid-900.woff2',
  'vendor/fontawesome/webfonts/fa-regular-400.woff2',
  'vendor/fontawesome/webfonts/fa-brands-400.woff2',
  'vendor/fontawesome/webfonts/fa-v4compatibility.woff2',
  'vendor/fonts/inter.css',
  'vendor/fonts/inter-a375c31d43e6.woff2',
  'vendor/fonts/inter-13755630d7d2.woff2',
  'vendor/fonts/inter-da72a9f73897.woff2',
  'vendor/fonts/inter-3b78c6fa6456.woff2',
  'vendor/fonts/inter-f059b71e05ff.woff2',
  'vendor/fonts/inter-b6db4a06c119.woff2',
  'vendor/fonts/inter-6ab57b19c69b.woff2'
];

const ASSETS = RELATIVE_ASSETS.map(file => new URL(file, self.location.href).pathname);

// Install: Cache new assets (activate immediately for fresh content)
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        ASSETS.map((asset) =>
          fetch(asset, { cache: 'no-cache' }).then((response) => {
            if (response.ok) {
              return cache.put(asset, response);
            }
          }).catch(() => {})
        )
      );
    })
  );
});

// Activate: Clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network first, then cache, con fallback de navegación.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Excluir APIs, streaming y recursos externos.
  if (url.pathname.includes('/api/') || url.pathname.includes('/proxy')) {
    return;
  }
  if (url.origin !== self.location.origin) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, responseClone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;

        if (e.request.mode === 'navigate' || e.request.headers.get('accept')?.includes('text/html')) {
          const indexCached = await caches.match(basePath) || await caches.match(basePath + 'index.html?v=1.6.4');
          if (indexCached) return indexCached;
        }

        return new Response('Network error', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain' }
        });
      })
  );
});
