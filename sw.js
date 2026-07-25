const CACHE_NAME = 'radios-sketch-v1.6.0';
const ASSETS = [
  '/radios/',
  '/radios/index.html?v=1.6.0',
  '/radios/style.css?v=1.6.0',
  '/radios/app.js?v=1.6.0',
  '/radios/radios_db.json'
];

// Install: Cache new assets (activate immediately for fresh content)
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
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
    })
  );
});

// Fetch: Network first, then cache (to ensure updates are seen)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  // Only handle same-origin requests
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request).catch(() => {
        return caches.match(e.request).then((cached) => {
          if (cached) return cached;
          return new Response('Network error', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain' }
          });
        });
      })
    );
  }
});
