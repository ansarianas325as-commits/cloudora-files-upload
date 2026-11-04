const CACHE_NAME = 'cloudora-pwa-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // API calls must never fall back to index.html: a failed download
  // should surface as a failed download, not as an HTML file.
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
});
