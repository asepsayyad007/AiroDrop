// Progressive Web App Service Worker for AiroDrop
// Cache version is tied to the app version — update this on each release
const APP_VERSION = '6.2.12';
const CACHE_NAME = `airodrop-v${APP_VERSION}`;
const OFFLINE_URL = '/offline.html';

// Assets to pre-cache on service worker installation
const PRECACHE_ASSETS = [
  OFFLINE_URL,
  '/manifest.json',
  '/logo.svg',
  '/logo.png',
  '/logo-192.png',
  '/style.css'
];

// Installation event: Pre-cache critical assets and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log(`[SW] Installing v${APP_VERSION}, pre-caching assets`);
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activation event: Clean up ALL old caches and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log(`[SW] Removing stale cache: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // Notify all open clients that a new version is active
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'SW_UPDATED',
            version: APP_VERSION
          });
        });
      });
      return self.clients.claim();
    })
  );
});

// Message handler — allow page to request skipWaiting
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch event: Apply customized caching strategies
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // 1. Bypass SW entirely for dynamic/real-time endpoints
  if (url.pathname.startsWith('/api/') || 
      url.pathname.startsWith('/webdav') || 
      url.pathname.startsWith('/trackpad') ||
      url.pathname.startsWith('/files/') ||
      url.pathname.startsWith('/received/') ||
      url.pathname === '/mobile-app.js' ||
      url.pathname === '/mobile.html' ||
      url.pathname === '/m' ||
      url.pathname === '/auth-pin' ||
      url.pathname === '/auth-pin.html' ||
      event.request.url.startsWith('ws') || 
      event.request.headers.get('Upgrade') === 'websocket') {
    return;
  }

  // 2. Network-First for HTML page navigations
  const isDocument = event.request.mode === 'navigate' || 
                     url.pathname.endsWith('.html') || 
                     url.pathname === '/';

  if (isDocument) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request)
            .then((cachedResponse) => cachedResponse || caches.match(OFFLINE_URL));
        })
    );
    return;
  }

  // 3. Cache-First with network update for static assets (CSS, JS, images, fonts)
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
        .catch(() => undefined);

      return cachedResponse || fetchPromise;
    })
  );
});
