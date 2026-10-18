// Minimal service worker so the dashboard can be installed as an app. It caches nothing:
// the hub's data must always be live.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
