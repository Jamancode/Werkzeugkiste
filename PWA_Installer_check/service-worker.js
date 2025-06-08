// service-worker.js - Advanced Cross-Browser PWA Service Worker
// Optimized for Safari's 50MB limit, Chrome's advanced features, and Firefox compatibility

const CACHE_VERSION = 'v1.3.0';
const STATIC_CACHE_NAME = `angel-kalender-static-${CACHE_VERSION}`;
const DYNAMIC_CACHE_NAME = `angel-kalender-dynamic-${CACHE_VERSION}`;
const API_CACHE_NAME = `angel-kalender-api-${CACHE_VERSION}`;
const IMAGE_CACHE_NAME = `angel-kalender-images-${CACHE_VERSION}`;

// Cache size limits (Safari: 50MB total, Chrome: 500MB+)
const SAFARI_TOTAL_LIMIT = 50 * 1024 * 1024; // 50MB for Safari
const CHROME_TOTAL_LIMIT = 500 * 1024 * 1024; // 500MB for Chrome
const MAX_DYNAMIC_ENTRIES = 50;
const MAX_API_ENTRIES = 100;
const MAX_IMAGE_ENTRIES = 30;

// Static resources to precache (essential files only for Safari)
const STATIC_RESOURCES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/apple-touch-icon-180x180.png'
];

// Extended resources for browsers with larger cache limits
const EXTENDED_RESOURCES = [
  '/icons/icon-48x48.png',
  '/icons/icon-72x72.png',
  '/icons/icon-96x96.png',
  '/icons/icon-144x144.png',
  '/icons/icon-192x192-maskable.png',
  '/icons/icon-512x512-maskable.png',
  '/screenshots/mobile-calendar.png',
  '/screenshots/mobile-catch-log.png'
];

// Detect browser capabilities
function detectBrowser() {
  const userAgent = self.navigator.userAgent;
  return {
    isSafari: /Safari/.test(userAgent) && !/Chrome/.test(userAgent),
    isChrome: /Chrome/.test(userAgent) && !/Edge/.test(userAgent),
    isEdge: /Edge/.test(userAgent),
    isFirefox: /Firefox/.test(userAgent),
    isMobile: /Mobile|Android|iPhone|iPad/.test(userAgent)
  };
}

const browser = detectBrowser();

// Install event - Cache essential resources
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker version:', CACHE_VERSION);

  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(STATIC_CACHE_NAME);

        // Always cache essential resources
        await cache.addAll(STATIC_RESOURCES);
        console.log('[SW] Essential resources cached');

        // Cache extended resources only for capable browsers
        if (!browser.isSafari) {
          try {
            await cache.addAll(EXTENDED_RESOURCES);
            console.log('[SW] Extended resources cached for non-Safari browser');
          } catch (error) {
            console.warn('[SW] Some extended resources failed to cache:', error);
          }
        }

        // Skip waiting to activate immediately
        await self.skipWaiting();

      } catch (error) {
        console.error('[SW] Installation failed:', error);
        throw error;
      }
    })()
  );
});

// Activate event - Clean up old caches and claim clients
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker version:', CACHE_VERSION);

  event.waitUntil(
    (async () => {
      try {
        // Clean up old cache versions
        const cacheNames = await caches.keys();
        const deletionPromises = cacheNames
          .filter(name => name.includes('angel-kalender') && !name.includes(CACHE_VERSION))
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          });

        await Promise.all(deletionPromises);

        // Take control of all pages immediately
        await self.clients.claim();

        // Perform storage management for Safari
        if (browser.isSafari) {
          await manageSafariStorage();
        }

        console.log('[SW] Service worker activated successfully');

      } catch (error) {
        console.error('[SW] Activation failed:', error);
      }
    })()
  );
});

// Fetch event - Handle all network requests with intelligent caching strategies
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip cross-origin requests except for APIs and CDNs
  if (url.origin !== self.location.origin && !isAllowedCrossOrigin(url)) {
    return;
  }

  // Route requests to appropriate caching strategies
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(handleApiRequest(request));
  } else if (request.destination === 'image') {
    event.respondWith(handleImageRequest(request));
  } else if (isStaticResource(url.pathname)) {
    event.respondWith(handleStaticRequest(request));
  } else {
    event.respondWith(handleDynamicRequest(request));
  }
});

// Static resources strategy - Cache first with network fallback
async function handleStaticRequest(request) {
  try {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    const networkResponse = await fetch(request);

    // Cache successful responses
    if (networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE_NAME);
      await cache.put(request, networkResponse.clone());
    }

    return networkResponse;

  } catch (error) {
    console.error('[SW] Static request failed:', request.url, error);

    // Return offline fallback for navigation requests
    if (request.mode === 'navigate') {
      const offlineResponse = await caches.match('/');
      return offlineResponse || new Response('Offline', { status: 503 });
    }

    throw error;
  }
}

// Dynamic content strategy - Network first with cache fallback and intelligent updating
async function handleDynamicRequest(request) {
  try {
    // Try network first
    const networkResponse = await Promise.race([
      fetch(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Network timeout')), 3000)
      )
    ]);

    if (networkResponse.ok) {
      // Update cache in background for successful responses
      updateDynamicCache(request, networkResponse.clone());
      return networkResponse;
    }

    // Fall back to cache for failed responses
    return await getCachedOrOffline(request);

  } catch (error) {
    console.log('[SW] Network failed, trying cache:', request.url);
    return await getCachedOrOffline(request);
  }
}

// API requests strategy - Network first with intelligent caching
async function handleApiRequest(request) {
  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      // Cache successful API responses with expiration
      const cache = await caches.open(API_CACHE_NAME);
      const responseWithExpiry = await addExpiryHeader(networkResponse.clone());
      await cache.put(request, responseWithExpiry);

      // Manage cache size
      await manageCacheSize(API_CACHE_NAME, MAX_API_ENTRIES);
    }

    return networkResponse;

  } catch (error) {
    console.log('[SW] API request failed, trying cache:', request.url);

    const cachedResponse = await caches.match(request);
    if (cachedResponse && !isExpired(cachedResponse)) {
      return cachedResponse;
    }

    // Return mock offline response for critical APIs
    return createOfflineApiResponse(request);
  }
}

// Image handling strategy - Cache first with size management
async function handleImageRequest(request) {
  try {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      const cache = await caches.open(IMAGE_CACHE_NAME);
      await cache.put(request, networkResponse.clone());

      // Aggressive cache management for images (especially on Safari)
      await manageCacheSize(IMAGE_CACHE_NAME, browser.isSafari ? 20 : MAX_IMAGE_ENTRIES);
    }

    return networkResponse;

  } catch (error) {
    console.error('[SW] Image request failed:', request.url, error);

    // Return placeholder image for failed image requests
    return createPlaceholderImage();
  }
}

// Helper functions

function isStaticResource(pathname) {
  return STATIC_RESOURCES.some(resource => pathname.endsWith(resource)) ||
         pathname.includes('/icons/') ||
         pathname.includes('/screenshots/') ||
         pathname === '/manifest.json';
}

function isAllowedCrossOrigin(url) {
  const allowedOrigins = [
    'api.openweathermap.org',
    'api.meteomatics.com',
    'api.brightsky.dev',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
  ];

  return allowedOrigins.some(origin => url.hostname.includes(origin));
}

async function getCachedOrOffline(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  // Return offline page for navigation requests
  if (request.mode === 'navigate') {
    const offlinePage = await caches.match('/');
    return offlinePage || new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/html' }
    });
  }

  throw new Error('No cached response available');
}

async function updateDynamicCache(request, response) {
  try {
    const cache = await caches.open(DYNAMIC_CACHE_NAME);
    await cache.put(request, response);
    await manageCacheSize(DYNAMIC_CACHE_NAME, MAX_DYNAMIC_ENTRIES);
  } catch (error) {
    console.warn('[SW] Failed to update dynamic cache:', error);
  }
}

async function manageCacheSize(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();

    if (keys.length > maxEntries) {
      // Delete oldest entries (FIFO)
      const entriesToDelete = keys.slice(0, keys.length - maxEntries);
      await Promise.all(entriesToDelete.map(key => cache.delete(key)));
      console.log(`[SW] Cleaned ${entriesToDelete.length} entries from ${cacheName}`);
    }
  } catch (error) {
    console.warn('[SW] Cache size management failed:', error);
  }
}

async function manageSafariStorage() {
  try {
    // Estimate storage usage
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate();
      console.log('[SW] Storage estimate:', estimate);

      if (estimate.usage > SAFARI_TOTAL_LIMIT * 0.8) {
        console.log('[SW] Approaching Safari storage limit, performing cleanup');
        await performAggressiveCleanup();
      }
    }
  } catch (error) {
    console.warn('[SW] Safari storage management failed:', error);
  }
}

async function performAggressiveCleanup() {
  try {
    // Clear dynamic and API caches first
    await caches.delete(DYNAMIC_CACHE_NAME);
    await caches.delete(API_CACHE_NAME);

    // Reduce image cache
    const imageCache = await caches.open(IMAGE_CACHE_NAME);
    const imageKeys = await imageCache.keys();
    if (imageKeys.length > 10) {
      const toDelete = imageKeys.slice(0, imageKeys.length - 10);
      await Promise.all(toDelete.map(key => imageCache.delete(key)));
    }

    console.log('[SW] Aggressive cleanup completed');
  } catch (error) {
    console.error('[SW] Aggressive cleanup failed:', error);
  }
}

async function addExpiryHeader(response) {
  const headers = new Headers(response.headers);
  headers.set('sw-cached-at', Date.now().toString());

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  });
}

function isExpired(response) {
  const cachedAt = response.headers.get('sw-cached-at');
  if (!cachedAt) return false;

  const age = Date.now() - parseInt(cachedAt);
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  return age > maxAge;
}

function createOfflineApiResponse(request) {
  const url = new URL(request.url);

  // Mock responses for critical API endpoints
  if (url.pathname.includes('/weather/')) {
    return new Response(JSON.stringify({
      offline: true,
      message: 'Wetterdaten offline nicht verfügbar',
      temperature: null,
      conditions: 'unknown'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({
    offline: true,
    message: 'API offline nicht verfügbar'
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

function createPlaceholderImage() {
  // Simple 1x1 transparent PNG
  const transparentPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  return new Response(atob(transparentPng), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-cache'
    }
  });
}

// Background sync for offline actions (Chrome/Edge only)
if ('sync' in self.registration) {
  self.addEventListener('sync', (event) => {
    console.log('[SW] Background sync event:', event.tag);

    if (event.tag === 'catch-upload') {
      event.waitUntil(syncOfflineCatches());
    } else if (event.tag === 'settings-sync') {
      event.waitUntil(syncSettings());
    }
  });
}

async function syncOfflineCatches() {
  try {
    // Implementation for syncing offline catch entries
    console.log('[SW] Syncing offline catch entries');

    // Get offline data from IndexedDB
    // Send to server when online
    // Clear offline queue

  } catch (error) {
    console.error('[SW] Sync failed:', error);
    throw error; // Retry sync
  }
}

async function syncSettings() {
  try {
    console.log('[SW] Syncing settings');
    // Implementation for syncing user settings
  } catch (error) {
    console.error('[SW] Settings sync failed:', error);
  }
}

// Push notifications (where supported)
self.addEventListener('push', (event) => {
  console.log('[SW] Push notification received');

  const options = {
    body: 'Optimale Angelzeiten heute! Bisswahrscheinlichkeit sehr hoch.',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/badge-72x72.png',
    data: {
      url: '/?source=push'
    },
    actions: [
      {
        action: 'view',
        title: 'Öffnen'
      },
      {
        action: 'dismiss',
        title: 'Später'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('Angel Kalender', options)
  );
});

// Notification click handling
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'view' || !event.action) {
    event.waitUntil(
      clients.openWindow(event.notification.data?.url || '/')
    );
  }
});

// Message handling from main app
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.ports[0].postMessage({ version: CACHE_VERSION });
      break;

    case 'CLEAR_CACHE':
      clearAllCaches().then(() => {
        event.ports[0].postMessage({ success: true });
      });
      break;

    case 'CACHE_URLS':
      cacheUrls(data.urls).then(() => {
        event.ports[0].postMessage({ success: true });
      });
      break;
  }
});

async function clearAllCaches() {
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames
      .filter(name => name.includes('angel-kalender'))
      .map(name => caches.delete(name))
  );
}

async function cacheUrls(urls) {
  const cache = await caches.open(DYNAMIC_CACHE_NAME);
  await cache.addAll(urls);
}

// Periodic background sync (Chrome only)
if ('periodicSync' in self.registration) {
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'weather-update') {
      event.waitUntil(updateWeatherCache());
    }
  });
}

async function updateWeatherCache() {
  try {
    console.log('[SW] Updating weather cache in background');
    // Pre-fetch weather data for better user experience
  } catch (error) {
    console.error('[SW] Background weather update failed:', error);
  }
}

console.log('[SW] Service worker script loaded, version:', CACHE_VERSION);