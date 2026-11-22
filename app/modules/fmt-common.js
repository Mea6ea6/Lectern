'use strict';
/* Lectern — shared helpers of the format viewers (friendly errors, XML, zip, pictures, units). Loaded on demand (see VIEWER_LIB in core.js); shares the global scope with the app scripts and fmt-common.js. */

/* ---------------------------------------------------------------------
   1. HELPERS
   --------------------------------------------------------------------- */

// An error the viewer window shows in plain words: [title, explanation]
function friendly(title, details) {
  const err = new Error(title);
  err.friendly = [title, details];
  return err;
}

function xmlDoc(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML is damaged');
  return doc;
}

// Zip files made on Windows often store Russian names in the old DOS code page (CP866) instead of UTF-8
function zipLoad(file) {
  return JSZip.loadAsync(file, {
    decodeFileName: (bytes) => {
      const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { /* not UTF-8 */ }
      try { return new TextDecoder('ibm866').decode(u8); } catch (e) { return String.fromCharCode(...u8); }
    },
  });
}

function snippetNode(title, body, cls) {
  const box = h('div', 'snippet' + (cls ? ' ' + cls : ''));
  if (title) box.appendChild(h('b', '', title));
  if (body) box.appendChild(document.createTextNode(body));
  return box;
}

// A picture from the zip (png, jpg…) as a blob address. Returns '' for formats a browser can't show (emf, wmf…)
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
async function zipImageUrl(zip, path, cache) {
  const ext = getExt(path);
  if (!IMAGE_MIME[ext]) return '';
  if (cache && cache.has(path)) return cache.get(path);
  const entry = zip.file(path);
  if (!entry) return '';
  const url = URL.createObjectURL(new Blob([await entry.async('uint8array')], { type: IMAGE_MIME[ext] }));
  if (cache) cache.set(path, url);
  return url;
}

// A chart inside an ODF file lives in its own folder ("Object 1/content.xml"); draw it with the Office chart painter
async function odfChartInto(zip, href, box, w, hh) {
  try {
    await lib('office');
    const entry = zip.file((href || '').replace(/^\.\//, '').replace(/\/$/, '') + '/content.xml');
    const svg = entry ? OFC.odfChartSvg(await entry.async('string'), Math.round(w) || 480, Math.round(hh) || 300) : null;
    if (svg) box.innerHTML = svg; else box.remove();
  } catch (err) { box.remove(); }
}
function revokeAll(cache) { if (cache) for (const url of cache.values()) URL.revokeObjectURL(url); }

// Length like "2.5cm", "10pt", "1in" -> centimetres (null if it is not a length)
function toCm(v, fallback) {
  if (v === null || v === undefined) return fallback;
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|px|pc)?$/.exec(String(v).trim());
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'mm': return n / 10;
    case 'in': return n * 2.54;
    case 'pt': return n * 2.54 / 72;
    case 'px': return n * 2.54 / 96;
    case 'pc': return n * 2.54 / 6;
    default: return n;
  }
}
