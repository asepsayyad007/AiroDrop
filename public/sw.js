const APP_VERSION = '6.5.3';
const CACHE_NAME = `airodrop-v${APP_VERSION}`;
const OFFLINE_URL = '/offline.html';

// Assets to pre-cache on service worker installation
const PRECACHE_ASSETS = [
  OFFLINE_URL,
  '/manifest.json',
  '/logo.svg',
  '/logo.png',
  '/logo-192.png',
  '/install',
  '/installer',
  '/installer.html',
  '/m',
  '/mobile.html',
  '/mobile-app.js',
  '/keyboard.js'
];

// Installation event: Resiliently pre-cache critical assets and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log(`[SW] Installing v${APP_VERSION}, pre-caching assets`);
      await Promise.allSettled(
        PRECACHE_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (res.ok) {
              await cache.put(url, res);
            }
          } catch (err) {
            console.warn(`[SW] Pre-cache skipped for ${url}:`, err.message);
          }
        })
      );
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
      url.pathname === '/auth-pin' ||
      url.pathname === '/auth-pin.html' ||
      event.request.url.startsWith('ws') || 
      event.request.headers.get('Upgrade') === 'websocket') {
    return;
  }

  // 2. Network-First for HTML page navigations & app entry points
  const isDocument = event.request.mode === 'navigate' || 
                     url.pathname.endsWith('.html') || 
                     url.pathname === '/' ||
                     url.pathname === '/install' ||
                     url.pathname === '/installer' ||
                     url.pathname === '/m' ||
                     url.pathname === '/mobile.html';

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
        .catch(async () => {
          const cachedResponse = await caches.match(event.request);
          if (cachedResponse) return cachedResponse;

          if (url.pathname.includes('install') || url.pathname === '/') {
            const instRes = (await caches.match('/installer.html')) || 
                            (await caches.match('/install')) ||
                            (await caches.match('/installer'));
            if (instRes) return instRes;
          }

          if (url.pathname === '/m' || url.pathname === '/mobile.html') {
            const mobRes = (await caches.match('/mobile.html')) || 
                           (await caches.match('/m'));
            if (mobRes) return mobRes;
          }

          const offlineRes = await caches.match(OFFLINE_URL);
          if (offlineRes) return offlineRes;

          return new Response('<h1>Offline</h1><p>AiroDrop is currently offline.</p>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
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
