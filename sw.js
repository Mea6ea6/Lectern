/* Lectern service worker — keeps the whole app in the browser, so it opens with no internet at all.
   Generated from sw.template.js by make-sw.py (do not edit sw.js by hand). */
const CACHE = 'lectern-a798bafc1d';
const FILES = [
  "./",
  "Lectern.html",
  "manifest.webmanifest",
  "app/core.js",
  "app/drive.js",
  "app/errors.js",
  "app/extras.js",
  "app/fonts.css",
  "app/list.js",
  "app/presenter.js",
  "app/style.css",
  "app/viewer-input.js",
  "app/viewer-timer.js",
  "app/viewer-ui.js",
  "app/viewers.js",
  "app/fonts/inter-cyrillic-ext-wght-normal.woff2",
  "app/fonts/inter-cyrillic-wght-normal.woff2",
  "app/fonts/inter-latin-ext-wght-normal.woff2",
  "app/fonts/inter-latin-wght-normal.woff2",
  "app/lib/UTIF.js",
  "app/lib/docx-preview.min.js",
  "app/lib/heic2any.min.js",
  "app/lib/jszip.min.js",
  "app/lib/pako_inflate.min.js",
  "app/lib/pdf.min.js",
  "app/lib/pdf.worker.min.js",
  "app/lib/pptx-preview.umd.js",
  "app/lib/xlsx.full.min.js",
  "app/modules/fmt-archive.js",
  "app/modules/fmt-common.js",
  "app/modules/fmt-epub.js",
  "app/modules/fmt-images.js",
  "app/modules/fmt-media.js",
  "app/modules/fmt-odf.js",
  "app/modules/fmt-rtf.js",
  "app/modules/fmt-xlsx.js",
  "app/modules/ink.js",
  "app/modules/legacy.js",
  "app/modules/office.js",
  "app/modules/selftest-data.js",
  "app/modules/selftest.js",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon.svg",
  "icons/maskable-512.png",
  "icons/maskable.svg",
  "tests/build-selftest-data.py",
  "tests/run.js",
  "tests/fixtures/archive.zip",
  "tests/fixtures/book.epub",
  "tests/fixtures/broken.docx",
  "tests/fixtures/charts-shapes.docx",
  "tests/fixtures/charts-stock-surface.pptx",
  "tests/fixtures/conditional.xlsx",
  "tests/fixtures/data.json",
  "tests/fixtures/empty.pptx",
  "tests/fixtures/icons-formulas.xlsx",
  "tests/fixtures/page.pdf",
  "tests/fixtures/picture.png",
  "tests/fixtures/rtf-named-doc.doc",
  "tests/fixtures/shapes-smartart.pptx",
  "tests/fixtures/sheet.ods",
  "tests/fixtures/sheet.xls",
  "tests/fixtures/slides.odp",
  "tests/fixtures/slides.ppt",
  "tests/fixtures/styles-charts.xlsx",
  "tests/fixtures/table.csv",
  "tests/fixtures/table.doc",
  "tests/fixtures/text.odt",
  "tests/fixtures/text.rtf",
  "tests/fixtures/tone.wav"
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
