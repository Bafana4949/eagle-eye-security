// Eagle Eye Security Operations - Service Worker
const CACHE_NAME = 'eagle-eye-cache-v1';
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/offline.html'
];

// Install: Cache static app shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Stale-while-revalidate for static files, Network-first for pages, NEVER cache secure API calls
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and cross-origin authentication/storage endpoints
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.hostname.includes('supabase.co')) {
    return; // Pass through to network directly without caching confidential operational/auth data
  }

  // Static assets (images, icons, styles, fonts)
  if (
    url.pathname.match(/\.(png|jpg|jpeg|svg|webp|ico|css|js|woff2|woff)$/) ||
    url.pathname === '/manifest.json'
  ) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // HTML Page Navigation: Network first with offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((cached) => {
            return cached || caches.match('/offline.html');
          });
        })
    );
  }
});
