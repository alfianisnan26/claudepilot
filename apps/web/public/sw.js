// Makes the app installable and shows a small page when the server can't be reached.
// Only page loads are handled: API calls, WebSockets and assets always go to the network.
const CACHE = 'pilot-shell-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE, '/favicon.svg']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Nothing answered, or only a proxy did to say the portal is down (502, 503, 504): the offline page. Any other answer is the portal's.
const PROXY_DOWN = new Set([502, 503, 504]);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  event.respondWith(
    fetch(request).then(
      (response) => (PROXY_DOWN.has(response.status) ? caches.match(OFFLINE).then((page) => page || response) : response),
      () => caches.match(OFFLINE),
    ),
  );
});
