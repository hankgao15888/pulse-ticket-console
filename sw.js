const CACHE_NAME = 'pulse-v4';
const SHELL = ['./', './index.html', './styles.css?v=4', './app.js?v=4', './agent-ui.js?v=4', './pulse-mark.svg', './manifest.webmanifest'];
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('pulse-') && key !== CACHE_NAME).map((key) => caches.delete(key))))); self.clients.claim(); });
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (!SHELL.some((path) => new URL(path, self.registration.scope).href === url.href)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))); }
    return response;
  }).catch(() => caches.match(event.request)));
});
