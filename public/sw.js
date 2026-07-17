// Progressive Web App Service Worker for AiroDrop
const CACHE_NAME = 'airodrop-cache-v6';
const OFFLINE_URL = '/offline.html';

// Assets to pre-cache on service worker installation
const PRECACHE_ASSETS = [
  OFFLINE_URL,
  '/manifest.json',
  '/logo.svg',
  '/logo.png',
  '/logo-192.png',
  '/style.css',
  '/app.js',
  '/mobile.html',
  '/mobile-app.js'
];

// Installation event: Pre-cache assets and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Pre-caching offline fallback and assets');
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activation event: Clean up old caches and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[ServiceWorker] Removing old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event: Apply customized caching strategies
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // 1. Bypass Service Worker entirely for APIs, WebDAV, WebSockets, Files, and Received folder routes
  if (url.pathname.startsWith('/api/') || 
      url.pathname.startsWith('/webdav') || 
      url.pathname.startsWith('/trackpad') ||
      url.pathname.startsWith('/files/') ||
      url.pathname.startsWith('/received/') ||
      event.request.url.startsWith('ws') || 
      event.request.headers.get('Upgrade') === 'websocket') {
    return;
  }

  // 2. Network-First (with offline fallback to cache/offline page) for HTML Documents
  const isDocument = event.request.mode === 'navigate' || 
                     url.pathname.endsWith('.html') || 
                     url.pathname === '/' || 
                     url.pathname === '/m';

  if (isDocument) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // If response is valid, cache it for offline use
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // If network fails, try to serve from cache
          return caches.match(event.request)
            .then((cachedResponse) => {
              if (cachedResponse) {
                return cachedResponse;
              }
              // If not in cache, fallback to the offline page
              return caches.match(OFFLINE_URL);
            });
        })
    );
    return;
  }

  // 3. Stale-While-Revalidate for Static Resources (CSS, JS, images, fonts)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          // Silent catch for network failure inside background fetch
        });

      return cachedResponse || fetchPromise;
    })
  );
});