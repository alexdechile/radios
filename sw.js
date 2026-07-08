const CACHE_NAME = 'radios-sketch-v1.1.1';
const ASSETS = [
  '/radios/',
  '/radios/index.html',
  '/radios/style.css',
  '/radios/app.js',
  '/radios/radios_db.json'
];

// Install: Cache new assets
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
  e.respondWith(
    fetch(e.request).catch(() => {
      return caches.match(e.request);
    })
  );
});
