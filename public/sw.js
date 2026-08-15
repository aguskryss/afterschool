const CACHE_NAME = 'afterschool-v7';
// Only entries that are guaranteed to exist: addAll() rejects the whole
// install if a single URL 404s, which would leave the app with no worker.
const STATIC_ASSETS = [
  '/app/',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/manifest.json'
];

// Install – cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

// Activate – clean up old caches and take control immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch – network first, fall back to cache
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return; // never cache API calls
  // Cross-origin requests (the Supabase logo/photos, Google Fonts, chart CDN)
  // are not this worker's to intercept: the page's own CSP already decides
  // whether the browser may load them, and proxying them through fetch()
  // here re-subjects an img-src/font-src request to connect-src instead,
  // which is stricter and breaks things the page is otherwise allowed to
  // show. Left to the browser, they load exactly as if there were no worker.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Push notifications
self.addEventListener('push', e => {
  let data = { title: 'Afterschool', body: 'New notification', url: '/app/' };
  try { data = e.data.json(); } catch {}
  // Stable tag per pickup/event when the server provides one so a new push for
  // the same pickup replaces the old notification instead of stacking. Falls
  // back to a unique tag for one-off notifications without a tag.
  const tag = data.tag || ('kikar-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      data: { url: data.url, pickup_id: data.pickup_id || null },
      vibrate: [200, 100, 200],
      tag: tag,
      renotify: true,
      requireInteraction: true
    })
  );
});

// Notification click – open/focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
