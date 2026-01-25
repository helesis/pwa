// Service Worker for Voyage Sorgun Chat PWA
// Version: 2.0.0 - Auto-update enabled
// Cache version updates when service worker file changes
const CACHE_VERSION = 'voyage-chat-v4.3';
const CACHE_NAME = CACHE_VERSION;
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Install event - cache resources
self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing new version', CACHE_VERSION);
  // Force activation immediately, don't wait for other tabs to close
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Caching files');
        // Use cache.addAll but don't fail if some files fail
        return Promise.allSettled(
          urlsToCache.map(url => 
            cache.add(url).catch(err => {
              console.warn('Failed to cache:', url, err);
              return null;
            })
          )
        );
      })
      .catch((error) => {
        console.error('Service Worker: Cache failed', error);
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating new version', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      const deletePromises = cacheNames.map((cacheName) => {
        // Delete all old caches that don't match current version
        if (cacheName !== CACHE_NAME && cacheName.startsWith('voyage-chat-')) {
          console.log('Service Worker: Deleting old cache', cacheName);
          return caches.delete(cacheName);
        }
        return Promise.resolve();
      });
      
      return Promise.all(deletePromises);
    }).then(() => {
      // Claim all clients immediately (iOS/Android compatibility)
      return self.clients.claim();
    }).then(() => {
      // Notify all clients about the update
      return self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'SW_UPDATED',
            version: CACHE_VERSION
          });
        });
      });
    })
  );
});

// Fetch event - Network first strategy for better updates
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip Socket.IO and API requests (always use network)
  if (event.request.url.includes('/socket.io/') || 
      event.request.url.includes('/api/')) {
    return;
  }

  // Network first strategy for HTML files (ensures updates)
  if (event.request.destination === 'document' || 
      event.request.url.endsWith('.html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Update cache with fresh content
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache if network fails
          return caches.match(event.request);
        })
    );
    return;
  }

  // Cache first for static assets
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Return cached version or fetch from network
        return response || fetch(event.request).then((response) => {
          // Don't cache if not a valid response
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          // Clone the response
          const responseToCache = response.clone();

          caches.open(CACHE_NAME)
            .then((cache) => {
              cache.put(event.request, responseToCache);
            });

          return response;
        });
      })
      .catch(() => {
        // If both cache and network fail, return offline page if available
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      })
  );
});

// Push notification event (for future use)
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Voyage Sorgun';
  const options = {
    body: data.body || 'Yeni mesajınız var',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'voyage-chat-notification',
    requireInteraction: true
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click event
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});

// Message event - handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('Service Worker: Skipping waiting, activating immediately');
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CHECK_UPDATE') {
    // Trigger update check
    self.registration.update();
  }
});






