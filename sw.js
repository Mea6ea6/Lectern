/* Lectern service worker — keeps the whole app in the browser, so it opens with no internet at all.
   Generated from sw.template.js by make-sw.py (do not edit sw.js by hand). */
const CACHE = 'lectern-e36c471ee9';
const FILES = [
  "./",
  "Lectern.html",
  "manifest.webmanifest",
  "README.md",
  "app/app.js",
  "app/fonts.css",
  "app/style.css",
  "app/fonts/inter-cyrillic-ext-wght-normal.woff2",
  "app/fonts/inter-cyrillic-wght-normal.woff2",
  "app/fonts/inter-latin-ext-wght-normal.woff2",
  "app/fonts/inter-latin-wght-normal.woff2",
  "app/lib/docx-preview.min.js",
  "app/lib/jszip.min.js",
  "app/lib/pdf.min.js",
  "app/lib/pdf.worker.min.js",
  "app/lib/pptx-preview.umd.js",
  "app/lib/xlsx.full.min.js",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon.svg",
  "icons/maskable-512.png",
  "icons/maskable.svg"
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lectern-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('Lectern.html');     // any address inside the app opens the app
      return fetch(req);
    })
  );
});
