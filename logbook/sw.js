// Offline support: keeps a copy of the app on the phone so it opens with no signal.
// Bump VERSION when you publish changes to force every phone to refresh its copy.
const VERSION = 'logbook-v4';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'store.js', 'config.js', 'manifest.json',
  'assets/icon-192.png', 'assets/icon-512.png', 'assets/apple-touch-icon.png',
  'assets/logo-s.png', 'assets/logo-truck.png', 'assets/logo-saw.png', 'assets/logo-stump.png',
  'assets/logo-treeline.png', 'assets/logo-peak.png',
];
const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase SDK files never change for a given version: cache first.
  if (req.url.startsWith(FIREBASE_SDK)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // Firestore/Auth traffic goes straight to the network

  // App files: try the network first (so updates show up right away), but fall
  // back to the saved copy if there is no signal or the signal is too weak to
  // answer within 3 seconds.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      });
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
      } catch { /* offline */ }
      const hit = await cache.match(key, { ignoreSearch: true });
      return hit || network;
    }),
  );
});
