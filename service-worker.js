const CACHE_NAME = 'festival-app-v31-hyper-speed';
const APP_SHELL = [
  './index.html',
  './reports.html',
  './history.html',
  './materialsMovement.html',
  './style.css',
  './script.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  // API calls should go to the network; application JS handles offline data/queue.
  if (request.url.includes('script.google.com/macros/')) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        // V25: cache-first means navigation and static assets render immediately.
        // The app's explicit refresh button/service-worker update handles freshness.
        return cached;
      }

      return fetch(request).then(response => {
        if (response && (response.ok || response.type === 'opaque')) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => {
        // Basic offline fallback for navigation.
        if (request.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
