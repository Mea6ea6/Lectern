'use strict';
/* =====================================================================
   Lectern — offline file viewer (PDF, PPTX, DOCX, XLSX, images, video...).
   Vanilla JS, no build step. Runs from Lectern.html (USB stick) and as a PWA.

   THE CODE IS SPLIT INTO PLAIN SCRIPTS (Lectern.html loads them in this order, they share one global scope):
     core.js (1-4)  ·  drive.js (memory on the flash drive)  ·  list.js (5-6)  ·  viewers.js (7)  ·  viewer-ui.js, viewer-timer.js, viewer-input.js (8)  ·  errors.js (unreadable files)  ·  extras.js (tooltips, bookmarks, notes)  ·  presenter.js
   They are not ES modules on purpose: modules do not load from a file:// address, and Lectern runs from a flash drive.
   A function declared in a later file is not yet known while an earlier file runs its top-level code.

   MAP (search for the number/heading to jump):
     1. Constants and state       EXT_TO_KIND, EXT_TO_VIEWER, `state` (file list state)
     2. Small helpers             $, prefs (localStorage), kvGet/kvSet (IndexedDB)
     3. Appearance                theme; PWA install button
     4. Getting files             folder picker, drag & drop, remembered folder
     5. The file list             cards, search, sort, selection, details, the class QUEUE
     6. Thumbnails                first page/slide previews (PDF/PPTX/images)
     7. Viewers                   BaseViewer -> PdfViewer, BoxViewer (PptxViewer, ImageViewer),
                                  ScrollViewer (DocxViewer, TextViewer).
                                  Spreadsheets, ODF, media, zip, epub, old doc/ppt live in app/modules/fmt-*.js and legacy.js,
                                  libraries are loaded lazily with lib(name).
     8. The viewer window         `V` (the open viewer), toasts, buttons, overview, menu, fullscreen, black screen, laser,
                                  TIMER, notes, pinch/double-tap zoom, keyboard, and at the end
                                  PRESENTER VIEW (the `Link` object: two windows over a
                                  BroadcastChannel; the companion is the window opened with
                                  location.hash === '#companion').

   PITFALLS (read before editing):
     - Animated show/hide: `hidden` is overridden for the id list in the
       'ANIMATED HIDE/SHOW' block (search "'timerDlg'"; it sits in
       section 5). A new popup id must be added to that list.
     - style.css already has a global `.empty` class — do not reuse that name for new elements.
     - Letter shortcuts use e.code (layout independent). The keyboard handler is one big
       function in section 8; the companion window has its own early branch.
     - Presenter view: the presenter window owns the slide state; the companion only sends
       commands ({t:'cmd'}) and draws previews itself. Only PDF and PPTX are presentable.
     - Tests: Playwright + Chromium against `python3 -m http.server`; see make-sw.py /
       make-flash.py for building the archives (service worker file list is generated).
   ===================================================================== */


/* ---------------------------------------------------------------------
   1. CONSTANTS AND STATE
   --------------------------------------------------------------------- */

// File extension -> the kind of file (decides the badge colour, the filter and the thumbnail)
const EXT_TO_KIND = {
  pptx: 'pptx', ppsx: 'pptx', pptm: 'pptx', ppsm: 'pptx', potx: 'pptx', odp: 'pptx', ppt: 'pptx', pps: 'pptx',
  pdf: 'pdf',
  docx: 'docx', odt: 'docx', rtf: 'docx', doc: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xlsx', ods: 'xlsx', csv: 'xlsx', tsv: 'xlsx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', avif: 'image', apng: 'image', ico: 'image', jfif: 'image', jpe: 'image',
  tif: 'image', tiff: 'image',
  heic: 'image', heif: 'image',
  txt: 'text', md: 'text', log: 'text',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', ogv: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', opus: 'audio',
  zip: 'archive',
  json: 'code', html: 'code', htm: 'code',
  epub: 'book',
};

// Extension -> which viewer opens it (when it is not simply the same as the kind)
const EXT_TO_VIEWER = {
  odp: 'odp', odt: 'odt', rtf: 'rtf', ods: 'xlsx', doc: 'doc', ppt: 'ppt', pps: 'ppt',
  heic: 'heic', heif: 'heic', tif: 'tiff', tiff: 'tiff',
  mp4: 'media', m4v: 'media', webm: 'media', mov: 'media', ogv: 'media', mkv: 'media',
  mp3: 'media', wav: 'media', ogg: 'media', oga: 'media', m4a: 'media', aac: 'media', flac: 'media', opus: 'media',
  zip: 'zip', json: 'json', html: 'text', htm: 'text', epub: 'epub',
};

// These viewers live in app/modules/ and load the first time one of them is needed: viewer name -> lib() name
const VIEWER_LIB = {
  xlsx: 'sheets',
  odp: 'odf', odt: 'odf', rtf: 'rtf', heic: 'images', tiff: 'images', media: 'media',
  zip: 'archive', json: 'archive', epub: 'epub', doc: 'legacy', ppt: 'legacy',
};
const SUB_EXT = ['srt', 'vtt'];          // subtitles are not shown in the list: a video picks up the ones with its name

const KINDS = {
  pptx:    { order: 1,  noun: ['slide', 'slides'],  title: 'Presentations' },
  pdf:     { order: 2,  noun: ['page', 'pages'],    title: 'PDF' },
  docx:    { order: 3,  noun: null,                 title: 'Documents' },
  xlsx:    { order: 4,  noun: ['sheet', 'sheets'],  title: 'Spreadsheets' },
  image:   { order: 5,  noun: null,                 title: 'Images' },
  video:   { order: 6,  noun: null,                 title: 'Video' },
  audio:   { order: 7,  noun: null,                 title: 'Audio' },
  book:    { order: 8,  noun: null,                 title: 'Books' },
  text:    { order: 9,  noun: null,                 title: 'Text' },
  code:    { order: 10, noun: null,                 title: 'Code & data' },
  archive: { order: 11, noun: null,                 title: 'Archives' },
};

// Everything the page "remembers" about the file list
const state = {
  files: [],          // list of entries (see makeEntry)
  subs: [],           // subtitle files (.srt / .vtt) found next to the videos
  filter: 'all',      // selected type filter
  sort: 'name',       // sort mode
  query: '',          // search text
  selectedId: null,   // highlighted card
  folderName: '',     // name of the chosen folder
  handle: null,       // directory handle (Chrome/Edge only) — lets us rescan without asking again
  stored: null,       // directory handle remembered from the last visit
  note: '',           // one-off message shown in the status line
};
let nextId = 1;

/* ---------------------------------------------------------------------
   Libraries load only when a file type needs them (the page starts fast even from a slow flash drive).
   pdf.js: on file:// browsers refuse a separate worker, so pdf.js falls back to the main
   thread using pdf.worker.min.js, which is loaded as a normal <script> before the first PDF.
   --------------------------------------------------------------------- */
const LIB_FILES = {
  zip:  ['jszip.min.js'],
  pdf:  ['pdf.min.js', 'pdf.worker.min.js'],
  docx: ['jszip.min.js', 'docx-preview.min.js'],
  pptx: ['jszip.min.js', 'pptx-preview.umd.js'],
  xlsx: ['xlsx.full.min.js'],
  heic: ['heic2any.min.js'],
  tiff: ['pako_inflate.min.js', 'UTIF.js'],
  // Lectern's own code that is only needed sometimes (a name with a "/" is looked up inside app/, not app/lib/)
  odf:     ['jszip.min.js', 'modules/fmt-common.js', 'modules/fmt-odf.js'],
  rtf:     ['modules/fmt-common.js', 'modules/fmt-rtf.js'],
  media:   ['modules/fmt-common.js', 'modules/fmt-media.js'],
  images:  ['modules/fmt-common.js', 'modules/fmt-images.js'],
  archive: ['jszip.min.js', 'modules/fmt-common.js', 'modules/fmt-archive.js'],
  epub:    ['jszip.min.js', 'modules/fmt-common.js', 'modules/fmt-epub.js'],
  sheets:  ['xlsx.full.min.js', 'modules/fmt-xlsx.js'],
  selftest: ['jszip.min.js', 'modules/selftest-data.js', 'modules/selftest.js'],
  legacy:  ['xlsx.full.min.js', 'modules/fmt-common.js', 'modules/fmt-rtf.js', 'modules/legacy.js'],
  ink:     ['modules/ink.js'],
  office:  ['jszip.min.js', 'modules/office.js'],
};
const scriptLoads = {};
const libLoads = {};
function loadScript(file) {
  if (!scriptLoads[file]) {
    scriptLoads[file] = new Promise((ok, fail) => {
      const el = document.createElement('script');
      el.src = (file.includes('/') ? 'app/' : 'app/lib/') + file;
      el.onload = ok;
      el.onerror = () => { delete scriptLoads[file]; fail(new Error('Could not load ' + file)); };
      document.head.appendChild(el);
    });
  }
  return scriptLoads[file];
}
// One look for "nothing to show / loading / could not open": a centred icon (or spinner), a title, one sentence, optional buttons.
// opts: { icon: 'i-search', spinner: true, actions: [[label, fn], …] }
function stateNode(title, text, opts) {
  opts = opts || {};
  const el = h('div', 'state' + (opts.spinner ? ' state-loading' : ''));
  if (opts.icon) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'icon'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + opts.icon); s.appendChild(u); el.appendChild(s); }
  if (title) el.appendChild(h('div', 'state-title', title));
  if (text) el.appendChild(h('div', 'state-text', text));
  for (const [label, fn] of opts.actions || []) { const b = h('button', 'btn-link', label); b.type = 'button'; b.onclick = fn; el.appendChild(b); }
  return el;
}

function lib(name) {
  if (!libLoads[name]) {
    libLoads[name] = (async () => {
      for (const f of LIB_FILES[name]) await loadScript(f);       // in order: a library may need the one before it
      if (name === 'pdf') pdfjsLib.GlobalWorkerOptions.workerSrc = 'app/lib/pdf.worker.min.js';
    })().catch((err) => { delete libLoads[name]; throw err; });
  }
  return libLoads[name];
}


/* ---------------------------------------------------------------------
   2. SMALL HELPERS
   --------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

// Short way to create an element: h('div', 'class', 'text')
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// Builds <svg class="icon"><use href="#id"/></svg> (icons are defined in the HTML)
function icon(id) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#' + id);
  svg.appendChild(use);
  return svg;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(1) + ' GB';
}

function fullDate(ms) {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function plural(n, forms) { return n === 1 ? forms[0] : forms[1]; }
function getExt(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Text between <name>…</name> in a small XML string ('' if missing)
function xmlTag(xml, name) {
  const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([^<]*)</' + name + '>'));
  return m ? decodeXml(m[1]) : '';
}

// Text files: try UTF-8 first; if that fails the file is most likely Windows-1251 (old Russian files)
function decodeText(buffer, partial) {
  if (partial) buffer = buffer.slice(0, Math.max(0, buffer.byteLength - 3)); // don't cut a letter in half
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch (e) {
    try { return new TextDecoder('windows-1251').decode(buffer); }
    catch (e2) { return new TextDecoder().decode(buffer); }
  }
}

// localStorage can be blocked or empty — always wrap it
function loadPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* fine */ }
  if (typeof driveSettingChanged === 'function') driveSettingChanged(key);     // drive.js: settings may travel with the flash drive
}

// A tiny key-value store in IndexedDB (used to remember the last folder).
// The connection is opened once and reused; a failed open is retried next time.
let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((ok, fail) => {
      const req = indexedDB.open('file-viewer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => fail(req.error);
    }).catch(e => { dbPromise = null; throw e; });
  }
  return dbPromise;
}
async function kvGet(key) {
  const db = await openDb();
  return new Promise((ok, fail) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}
async function kvSet(key, value) {
  const db = await openDb();
  return new Promise((ok, fail) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => ok();
    tx.onerror = () => fail(tx.error);
  });
}


/* ---------------------------------------------------------------------
   3. APPEARANCE (theme)
   Stored as an attribute on <html>; the CSS does the rest.
   --------------------------------------------------------------------- */

function setAppearance(name, value) {      // name: 'theme'
  const apply = () => {
    document.documentElement.dataset[name] = value;
    savePref('fv-' + name, value);
    syncAppearanceUI();
  };
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(apply);   // smooth cross-fade where the browser supports it, instant switch elsewhere
  } else {
    apply();
  }
}

function syncAppearanceUI() {
  const root = document.documentElement.dataset;
  document.querySelectorAll('[data-theme-set]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.themeSet === root.theme)));
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-theme-set]');
  if (t) setAppearance('theme', t.dataset.themeSet);
});

/* ----- Installing as an app (PWA): Chrome/Edge offer it, other browsers simply don't show the button ----- */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('btnInstall').hidden = false;
});
window.addEventListener('appinstalled', () => { installPrompt = null; $('btnInstall').hidden = true; });
$('btnInstall').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch (err) { /* closed */ }
  installPrompt = null;
  $('btnInstall').hidden = true;
};
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* works without it, just not offline */ });
}

// The little "Appearance" popover on the home screen
$('btnSettings').onclick = (e) => { e.stopPropagation(); $('settings').hidden = !$('settings').hidden; };
// Items marked data-close close the menu after they are pressed (choose folder, add files, ...)
$('settings').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) $('settings').hidden = true; });
document.addEventListener('pointerdown', (e) => {
  if (!$('settings').hidden && !e.target.closest('#settings, #btnSettings')) $('settings').hidden = true;
});


/* ---------------------------------------------------------------------
   4. GETTING FILES
   A web page can't peek into a folder by itself, so the user picks it once.
   Chrome/Edge: a real folder picker (can be remembered and rescanned).
   Firefox: the classic "upload folder" dialog (nothing is uploaded anywhere).
   --------------------------------------------------------------------- */

function makeEntry(file, ext) {
  const path = file._path || file.webkitRelativePath || file.name;
  const dot = file.name.lastIndexOf('.');
  return {
    id: nextId++,
    file,
    path,                                       // path inside the chosen folder
    root: state.handle ? state.folderName : '',  // name of the chosen folder (folder-picker mode)
    name: file.name,
    base: dot > 0 ? file.name.slice(0, dot) : file.name,
    ext,
    tag: ext.toUpperCase(),
    kind: EXT_TO_KIND[ext],
    viewer: EXT_TO_VIEWER[ext] || EXT_TO_KIND[ext],   // which viewer class opens it
    size: file.size,
    modified: file.lastModified,
    key: path + '|' + file.size + '|' + file.lastModified,   // same file twice? we notice
    pages: 0,
    thumbNode: null,
    thumbUrl: '',
    thumbRequested: false,
    card: null,
  };
}

// Adds files to the list. replace = true: start from scratch (but keep thumbnails of unchanged files)
function addFiles(list, replace) {
  const incoming = [];
  const subs = [];
  for (const file of list) {
    const name = file.name;
    if (name.startsWith('~$') || name.startsWith('.')) continue;   // Office temp files
    const ext = getExt(name);
    if (EXT_TO_KIND[ext]) incoming.push(makeEntry(file, ext));
    else if (SUB_EXT.includes(ext)) subs.push(file);
  }
  state.subs = replace ? subs : state.subs.concat(subs);

  if (replace) {
    const old = new Map(state.files.map((e) => [e.key, e]));
    const next = [];
    const seen = new Set();
    for (const e of incoming) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      const prev = old.get(e.key);
      if (prev) { prev.file = e.file; next.push(prev); } else next.push(e);
    }
    state.files.filter((e) => !seen.has(e.key)).forEach(releaseEntry);
    state.files = next;
    relinkQueue();
    Q.items = Q.items.filter((it) => it.entry && next.includes(it.entry));   // files that are gone from the new folder leave the queue
  } else {
    const have = new Set(state.files.map((e) => e.key));
    for (const e of incoming) if (!have.has(e.key)) { state.files.push(e); have.add(e.key); }
  }
  computeDirs();
  if (replace) state.path = [];
  state.cardsEnter = true;          // the next render lets the cards slide in one after another
  render();
}

function releaseEntry(entry) {
  if (entry.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
}

/* ----- Choosing a folder ----- */
async function chooseFolder() {
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ id: 'file-viewer', mode: 'read' });
      await loadFromHandle(handle, true);
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;           // user pressed Cancel
      console.warn('Folder picker failed, using the classic one:', err);
    }
  }
  if (loadPref('fv-folder-hint', '1') === '1') askBeforeFolderPicker();
  else openClassicFolderPicker();
}
function openClassicFolderPicker() { $('pickFolder').value = ''; $('pickFolder').click(); }
function chooseFiles() { $('pickFiles').value = ''; $('pickFiles').click(); }

$('btnFolder').onclick = $('btnFolder2').onclick = chooseFolder;
$('btnFiles').onclick = $('btnFiles2').onclick = chooseFiles;

$('pickFolder').onchange = (e) => {
  const list = Array.from(e.target.files);
  if (!list.length) return;
  const rel = list[0].webkitRelativePath;
  state.folderName = rel ? rel.split('/')[0] : '';
  state.handle = null;
  addFiles(list, true);
};
$('pickFiles').onchange = (e) => {
  const list = Array.from(e.target.files);
  if (!list.length) return;
  addFiles(list, false);
};

/* ----- Folder handle: scan, remember, rescan (Chrome / Edge) ----- */
async function scanDirectory(dir, prefix, depth, out) {
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.') || name.startsWith('~$') || name === MEMORY_FILE || name === INK_FILE) continue;
    if (handle.kind === 'directory') {
      if (depth < 5) await scanDirectory(handle, prefix + name + '/', depth + 1, out);
    } else {
      const ext = getExt(name);
      if (EXT_TO_KIND[ext] || SUB_EXT.includes(ext)) {
        const file = await handle.getFile();
        file._path = prefix + name;
        out.push(file);
      }
    }
  }
}

async function loadFromHandle(handle, remember) {
  const out = [];
  await scanDirectory(handle, '', 0, out);
  state.handle = handle;
  state.folderName = handle.name;
  state.note = '';
  if (remember) {
    state.stored = handle;
    try { await kvSet('dir', handle); } catch (e) { console.warn('Could not remember the folder:', e); }
  }
  addFiles(out, true);
  driveLoad();
}

async function reopenStored() {
  const handle = state.stored;
  if (!handle) return;
  try {
    const mode = loadPref('fv-drive', '0') === '1' ? 'readwrite' : 'read';     // "Keep place on the drive" needs to write
    let perm = await handle.queryPermission({ mode });
    if (perm !== 'granted') perm = await handle.requestPermission({ mode });
    if (perm !== 'granted') return;
    await loadFromHandle(handle, false);
  } catch (err) {
    console.warn(err);
    state.note = 'The last folder is not available (is the flash drive plugged in?)';
    render();
  }
}

async function rescan() {
  if (!state.handle) return;
  try { await loadFromHandle(state.handle, false); }
  catch (err) {
    state.note = 'Could not read the folder (is the flash drive still plugged in?)';
    render();
  }
}

// On start: if we remember a folder and still have permission, just load it
async function restoreFolder() {
  if (!window.showDirectoryPicker) return;

  // Safety net: if the previous attempt to restore never finished (the browser died on it),
  // forget the saved folder instead of crashing again on every start.
  if (loadPref('fv-restoring', '0') === '1') {
    savePref('fv-restoring', '0');
    try { await kvSet('dir', null); } catch (e) { /* fine */ }
    return;
  }
  savePref('fv-restoring', '1');
  try {
    const handle = await kvGet('dir');
    if (!handle) return;
    state.stored = handle;
    render();
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') await loadFromHandle(handle, false);
  } catch (err) { /* nothing remembered, or the drive is gone — the Reopen button stays */ }
  finally { savePref('fv-restoring', '0'); }
}

document.querySelectorAll('.reopen-btn').forEach((b) => { b.onclick = reopenStored; });
$('btnRefresh').onclick = rescan;

/* ----- Drag & drop (files and whole folders) ----- */
let dragDepth = 0;
function setDragging(on) {
  document.body.classList.toggle('dragging', on);
  const empty = state.files.length === 0;
  document.body.classList.toggle('drag-empty', on && empty);     // start screen: the dashed card reacts
  $('dropHint').hidden = !(on && !empty);                       // list: a glass frame over the page
}
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!document.body.classList.contains('viewing')) { dragDepth++; setDragging(true); }
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDragging(false);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  if (document.body.classList.contains('viewing')) return;
  const files = await filesFromDrop(e.dataTransfer);
  if (files.length) addFiles(files, false);
});

async function filesFromDrop(dataTransfer) {
  const out = [];
  // Entries must be grabbed right away, before any await — afterwards they vanish
  const entries = Array.from(dataTransfer.items || [])
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));

  async function walk(entry) {
    if (entry.isFile) {
      const file = await new Promise((ok, fail) => entry.file(ok, fail));
      file._path = entry.fullPath.replace(/^\//, '');
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {   // folders come in pieces; read until empty
        batch = await new Promise((ok, fail) => reader.readEntries(ok, fail));
        for (const child of batch) await walk(child);
      } while (batch.length);
    }
  }

  if (entries.some(Boolean)) { for (const entry of entries) if (entry) await walk(entry); }
  else out.push(...dataTransfer.files);
  return out;
}

// Subtitle files that belong to a video: same folder, same name ("talk.mp4" -> "talk.srt", "talk.en.vtt" …); the exact name comes first
function subsFor(entry) {
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '').toLowerCase();
  const dir = dirOf(entry.path), base = entry.base.toLowerCase();
  const found = state.subs.filter((f) => {
    const n = f.name.toLowerCase().replace(/\.[^.]+$/, '');
    return dirOf(f._path || f.webkitRelativePath || f.name) === dir && n.startsWith(base) && (n.length === base.length || /[._ -]/.test(n[base.length]));
  });
  return found.sort((a, b) => a.name.length - b.name.length);
}

// Lectern.html#selftest opens the self-check page (see modules/selftest.js)
if (location.hash === '#selftest') window.addEventListener('load', () => setTimeout(() => lib('selftest').then(() => SELFTEST.run()).catch((e) => console.error(e)), 300));
