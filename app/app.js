'use strict';
/* =====================================================================
   File Viewer — works offline, opens by double-clicking Viewer.html.

   The file is split into parts:
     1. Constants and state
     2. Small helpers
     3. Appearance (theme + style)
     4. Getting files (folder picker, files, drag & drop, remembered folder)
     5. The file list (cards, search, sort, selection)
     6. Thumbnails
     7. Viewers: PDF, PPTX, DOCX, XLSX, images, text
     8. The viewer window (buttons, overview, menu, fullscreen, keys, touch)
   ===================================================================== */


/* ---------------------------------------------------------------------
   1. CONSTANTS AND STATE
   --------------------------------------------------------------------- */

// File extension -> the kind of file (decides the badge colour, the filter and the thumbnail)
const EXT_TO_KIND = {
  pptx: 'pptx', ppsx: 'pptx', pptm: 'pptx', ppsm: 'pptx', potx: 'pptx', odp: 'pptx',
  pdf: 'pdf',
  docx: 'docx', odt: 'docx', rtf: 'docx',
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
  odp: 'odp', odt: 'odt', rtf: 'rtf', ods: 'xlsx',
  heic: 'heic', heif: 'heic', tif: 'tiff', tiff: 'tiff',
  mp4: 'media', m4v: 'media', webm: 'media', mov: 'media', ogv: 'media', mkv: 'media',
  mp3: 'media', wav: 'media', ogg: 'media', oga: 'media', m4a: 'media', aac: 'media', flac: 'media', opus: 'media',
  zip: 'zip', json: 'json', html: 'text', htm: 'text', epub: 'epub',
};

// These viewers live in app/modules/formats.js, which is loaded the first time one of them is needed
const FORMAT_VIEWERS = new Set(['odp', 'odt', 'rtf', 'heic', 'tiff', 'media', 'zip', 'json', 'epub']);

// Old Office formats can't be opened — we only count them to tell the user
const LEGACY_EXT = ['ppt', 'pps', 'doc'];

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
  filter: 'all',      // selected type filter
  sort: 'name',       // sort mode
  query: '',          // search text
  selectedId: null,   // highlighted card
  skipped: 0,         // how many old-format files were skipped
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
  formats: ['jszip.min.js', 'modules/formats.js'],
  ink:     ['modules/ink.js'],
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
function savePref(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* fine */ } }

// A tiny key-value store in IndexedDB (used to remember the last folder)
function openDb() {
  return new Promise((ok, fail) => {
    const req = indexedDB.open('file-viewer', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
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
  let skipped = 0;
  for (const file of list) {
    const name = file.name;
    if (name.startsWith('~$') || name.startsWith('.')) continue;   // Office temp files
    const ext = getExt(name);
    if (EXT_TO_KIND[ext]) incoming.push(makeEntry(file, ext));
    else if (LEGACY_EXT.includes(ext)) skipped++;
  }

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
    state.skipped = skipped;
    relinkQueue();
    Q.items = Q.items.filter((it) => it.entry && next.includes(it.entry));   // files that are gone from the new folder leave the queue
  } else {
    const have = new Set(state.files.map((e) => e.key));
    for (const e of incoming) if (!have.has(e.key)) { state.files.push(e); have.add(e.key); }
    state.skipped += skipped;
  }
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
    if (name.startsWith('.') || name.startsWith('~$')) continue;
    if (handle.kind === 'directory') {
      if (depth < 5) await scanDirectory(handle, prefix + name + '/', depth + 1, out);
    } else {
      const ext = getExt(name);
      if (EXT_TO_KIND[ext]) {
        const file = await handle.getFile();
        file._path = prefix + name;
        out.push(file);
      } else if (LEGACY_EXT.includes(ext)) {
        out.push({ name });                                   // only needed for the "skipped" counter
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
}

async function reopenStored() {
  const handle = state.stored;
  if (!handle) return;
  try {
    let perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
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


/* ---------------------------------------------------------------------
   5. THE FILE LIST
   --------------------------------------------------------------------- */

function visibleFiles() {
  const q = state.query.trim().toLowerCase();
  const list = state.files.filter((e) =>
    (state.filter === 'all' || e.kind === state.filter) &&
    (!q || e.name.toLowerCase().includes(q)));

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const sorters = {
    name: byName,
    date: (a, b) => b.modified - a.modified || byName(a, b),
    size: (a, b) => b.size - a.size || byName(a, b),
    type: (a, b) => KINDS[a.kind].order - KINDS[b.kind].order || byName(a, b),
  };
  return list.sort(sorters[state.sort]);
}

function createCard(entry) {
  const card = h('div', 'card k-' + entry.kind);
  card.dataset.id = entry.id;
  card.title = entry.name;

  const thumb = h('span', 'thumb');
  thumb.appendChild(h('span', 'tag tag-' + entry.kind, entry.tag));     // format badge, top-right

  const qb = h('button', 'card-queue');                                // "+" = add to the class queue (top-left)
  qb.type = 'button';
  qb.onclick = (e) => { e.stopPropagation(); queueToggle(entry); };
  thumb.appendChild(qb);

  const info = h('button', 'card-info');
  info.type = 'button';
  info.title = 'Details (Space)';
  info.setAttribute('aria-label', 'Details');
  info.appendChild(icon('i-info'));

  const foot = h('span', 'card-foot');
  foot.append(info, h('span', 'card-name', entry.base));
  card.append(thumb, foot);

  card.onclick = () => { select(entry.id, false); openViewer(entry); };
  info.onclick = (e) => { e.stopPropagation(); select(entry.id, false); openInfo(entry); };
  // Hovering with a mouse selects the card, so Space / Enter act on it (like Quick Look on a Mac)
  card.onpointerenter = (e) => { if (e.pointerType === 'mouse') select(entry.id, false); };

  entry.card = card;
  entry.qMark = undefined;          // a new card has to be marked even if the place did not change
  markQueue(entry);
  if (entry.thumbNode) putThumb(entry);
  return card;
}

function render() {
  relinkQueue();
  const hasFiles = state.files.length > 0;
  $('empty').hidden = hasFiles;
  $('toolbar').hidden = !hasFiles;
  $('footKeys').hidden = !hasFiles;
  $('footStart').hidden = hasFiles;
  $('grid').hidden = !hasFiles;

  renderStatus();
  renderChips();
  renderActions();

  const list = visibleFiles();
  $('grid').classList.toggle('no-blur', list.length > 80);   // blur behind hundreds of cards would make scrolling heavy
  $('grid').replaceChildren(...list.map(createCard));
  $('noResults').hidden = !hasFiles || list.length > 0;

  if (!list.some((e) => e.id === state.selectedId)) state.selectedId = list.length ? list[0].id : null;
  markSelected(false);

  for (const e of list) thumbObserver.observe(e.card);   // thumbnails only for visible cards
}

function renderActions() {
  $('headFiles').hidden = state.files.length === 0;     // header buttons appear once there are files
  const show = !!state.stored && !state.handle;
  document.querySelectorAll('.reopen-btn').forEach((b) => {
    b.hidden = !show;
    const label = b.querySelector('.reopen-label');
    if (label) label.textContent = state.stored ? 'Reopen “' + state.stored.name + '”' : 'Reopen last folder';
  });
  $('btnRefresh').hidden = !state.handle;
  $('btnQueue').hidden = !state.files.length && !Q.items.length;
  $('qCount').textContent = Q.items.length ? String(Q.items.length) : '';
}

function renderStatus() {
  if (state.note) { $('status').textContent = state.note; return; }
  if (!state.files.length) { $('status').textContent = 'Nothing open yet'; return; }
  const n = state.files.length;
  let text = (state.folderName ? state.folderName + ' · ' : '') + n + ' ' + plural(n, ['file', 'files']);
  if (state.skipped) text += ' · ' + state.skipped + ' skipped (.ppt / .doc) — re-save as .pptx / .docx';
  $('status').textContent = text;
}

function renderChips() {
  const present = Object.keys(KINDS).filter((k) => state.files.some((e) => e.kind === k));
  const filters = [{ id: 'all', title: 'All' }, ...present.map((k) => ({ id: k, title: KINDS[k].title }))];
  if (!filters.some((f) => f.id === state.filter)) state.filter = 'all';
  const chips = filters.map((f) => {
    const count = f.id === 'all' ? state.files.length : state.files.filter((e) => e.kind === f.id).length;
    const chip = h('button', 'chip k-' + f.id + (state.filter === f.id ? ' active' : ''), f.title);
    chip.type = 'button';
    chip.appendChild(h('b', '', String(count)));
    chip.onclick = () => { state.filter = f.id; render(); };
    return chip;
  });
  $('chips').replaceChildren(...chips);
}

$('search').oninput = (e) => { state.query = e.target.value; render(); };
/* ----- Sort: our own drop-down (the browser's native list can't be styled) ----- */
const SORT_NAMES = { name: 'Name', date: 'Newest first', size: 'Largest first', type: 'Type' };
function setSort(value) {
  state.sort = value;
  $('sortVal').textContent = SORT_NAMES[value];
  $('sortMenu').querySelectorAll('[data-sort]').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.sort === value)));
  render();
}
function sortOptions() { return [...$('sortMenu').querySelectorAll('[data-sort]')]; }
function openSortMenu(focusIndex) {
  $('sortMenu').hidden = false;
  $('sortBtn').setAttribute('aria-expanded', 'true');
  const opts = sortOptions();
  const i = focusIndex != null ? focusIndex : Math.max(0, opts.findIndex((b) => b.dataset.sort === state.sort));
  opts[i].focus();
}
function closeSortMenu(refocus) {
  if ($('sortMenu').hidden) return;
  $('sortMenu').hidden = true;
  $('sortBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('sortBtn').focus();
}
$('sortBtn').onclick = () => { if ($('sortMenu').hidden) openSortMenu(); else closeSortMenu(); };
$('sortMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  setSort(b.dataset.sort);
  closeSortMenu(false);
  b.blur();
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#sortDD')) closeSortMenu(false); });
$('sortDD').addEventListener('keydown', (e) => {
  const opts = sortOptions();
  const i = opts.indexOf(document.activeElement);
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === 'Escape' && !$('sortMenu').hidden) { handled(); closeSortMenu(true); }
  else if (e.key === 'ArrowDown') { handled(); if ($('sortMenu').hidden) openSortMenu(); else opts[(i + 1) % opts.length].focus(); }
  else if (e.key === 'ArrowUp') { handled(); if ($('sortMenu').hidden) openSortMenu(opts.length - 1); else opts[(i - 1 + opts.length) % opts.length].focus(); }
  else if (e.key === 'Home' && i >= 0) { handled(); opts[0].focus(); }
  else if (e.key === 'End' && i >= 0) { handled(); opts[opts.length - 1].focus(); }
  else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { handled(); setSort(opts[i].dataset.sort); closeSortMenu(true); }
  else if (e.key === 'Tab') closeSortMenu(false);
});
$('sortMenu').querySelectorAll('[data-sort]').forEach((b) => b.tabIndex = -1);
$('sortMenu').querySelectorAll('[data-sort]').forEach((b) =>
  b.setAttribute('aria-selected', String(b.dataset.sort === state.sort)));

function select(id, scroll) { state.selectedId = id; markSelected(scroll); }
function markSelected(scroll) {
  for (const card of $('grid').children) {
    const on = Number(card.dataset.id) === state.selectedId;
    card.classList.toggle('selected', on);
    if (on && scroll) card.scrollIntoView({ block: 'nearest' });
  }
}

function moveSelection(dx, dy) {
  const cards = Array.from($('grid').children);
  if (!cards.length) return;
  let i = cards.findIndex((c) => Number(c.dataset.id) === state.selectedId);
  if (i < 0) i = 0;
  i += dx;
  if (dy) {
    const perRow = cards.filter((c) => c.offsetTop === cards[0].offsetTop).length || 1;
    i += dy * perRow;
  }
  select(Number(cards[clamp(i, 0, cards.length - 1)].dataset.id), true);
}
function selectedEntry() { return state.files.find((e) => e.id === state.selectedId); }


/* ---------------------------------------------------------------------
   Smooth show / hide. Everything that pops up or opens just sets `el.hidden`
   as before; for the listed elements the setter now plays an in/out animation
   (CSS classes anim-in / anim-out) and only really hides after the out-animation.
   --------------------------------------------------------------------- */
(function () {
  const OUT_MS = 220;
  const native = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
  ['settings', 'sortMenu', 'modal', 'viewer', 'overview', 'vMenu', 'cover', 'dropHint', 'inkBar', 'notes', 'timerDlg'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    let logical = native.get.call(el), timer = 0;
    Object.defineProperty(el, 'hidden', {
      configurable: true,
      get() { return logical; },
      set(v) {
        v = !!v;
        if (v === logical) return;
        logical = v;
        clearTimeout(timer);
        if (!v) {                                           // appear
          native.set.call(el, false);
          el.classList.remove('anim-out');
          void el.offsetWidth;
          el.classList.add('anim-in');
        } else {                                            // disappear
          el.classList.remove('anim-in');
          el.classList.add('anim-out');
          timer = setTimeout(() => { native.set.call(el, true); el.classList.remove('anim-out'); }, OUT_MS);
        }
      },
    });
  });
})();

/* ---------------------------------------------------------------------
   5b. DIALOGS AND FILE INFO
   One dialog at a time. Used for the folder hint and for "file details"
   (like Get Info on a Mac).
   --------------------------------------------------------------------- */

const M = { el: $('modal'), body: $('modalBody'), onEnter: null, spaceCloses: false, entry: null };

function openModal(content, opts) {
  M.body.className = 'modal-card' + (opts && opts.cls ? ' ' + opts.cls : '');
  M.body.replaceChildren(content);
  M.onEnter = (opts && opts.onEnter) || null;
  M.spaceCloses = !!(opts && opts.spaceCloses);
  M.el.hidden = false;
}
function closeModal() {
  if (M.el.hidden) return;
  M.el.hidden = true;
  M.entry = null;
  setTimeout(() => { if (M.el.hidden) M.body.replaceChildren(); }, 260);   // keep the content while it fades out
}
M.el.addEventListener('pointerdown', (e) => { if (e.target === M.el) closeModal(); });     // click outside = close
M.el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });

/* ----- Folder hint: shown before the browser's own "Upload files?" question ----- */
function askBeforeFolderPicker() {
  const bold = (t) => h('b', '', t);
  const box = h('div');
  box.appendChild(h('h2', 'modal-title', 'Choose a folder'));

  const text = h('p', 'modal-text');
  text.append('Your browser will now ask ', bold('“Upload all files from this folder?”'), '. Click ', bold('Upload'),
    '. Nothing is sent anywhere — Lectern only reads the files on this computer and works offline.');
  const tip = h('p', 'modal-text', 'Tip: dragging a folder into the window skips this question.');

  const skip = h('button', 'menu-item');
  skip.type = 'button';
  skip.setAttribute('aria-pressed', 'false');
  skip.append(h('span', 'grow', 'Don’t show this again'), h('span', 'switch'));
  skip.onclick = () => skip.setAttribute('aria-pressed', String(skip.getAttribute('aria-pressed') !== 'true'));

  const go = () => {
    if (skip.getAttribute('aria-pressed') === 'true') savePref('fv-folder-hint', '0');
    closeModal();
    openClassicFolderPicker();
  };
  const cancel = h('button', 'btn', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = closeModal;
  const ok = h('button', 'btn btn-primary', 'Continue');
  ok.type = 'button';
  ok.onclick = go;

  const actions = h('div', 'modal-actions');
  actions.append(cancel, ok);
  box.append(text, tip, skip, actions);
  openModal(box, { onEnter: go });
}

/* ----- File details ----- */
const KIND_NAMES = {
  pptx: 'PowerPoint presentation', ppsx: 'PowerPoint slide show', pdf: 'PDF document', docx: 'Word document',
  xlsx: 'Excel workbook', xlsm: 'Excel macro-enabled workbook', xls: 'Excel 97–2003 workbook', csv: 'CSV table',
  png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', gif: 'GIF image', webp: 'WebP image',
  bmp: 'BMP image', svg: 'SVG image', avif: 'AVIF image',
  txt: 'Plain text', md: 'Markdown text', log: 'Log file',
  odp: 'OpenDocument presentation', odt: 'OpenDocument text', ods: 'OpenDocument spreadsheet', rtf: 'Rich Text document',
  tif: 'TIFF picture', tiff: 'TIFF picture', ico: 'Icon image', apng: 'Animated PNG', jfif: 'JPEG image', jpe: 'JPEG image',
  mkv: 'Matroska video', tsv: 'Tab-separated table', pptm: 'PowerPoint show (macros)', ppsm: 'PowerPoint slide show', potx: 'PowerPoint template',
  heic: 'HEIC photo (iPhone)', heif: 'HEIF image',
  mp4: 'MP4 video', m4v: 'MP4 video', webm: 'WebM video', mov: 'QuickTime video', ogv: 'Ogg video',
  mp3: 'MP3 audio', wav: 'WAV audio', ogg: 'Ogg audio', oga: 'Ogg audio', m4a: 'M4A audio', aac: 'AAC audio', flac: 'FLAC audio', opus: 'Opus audio',
  zip: 'ZIP archive', json: 'JSON data', html: 'HTML page (shown as source)', htm: 'HTML page (shown as source)', epub: 'EPUB book',
};

// A picture for the dialog: canvases can't be cloned with their pixels, so convert them
function cloneThumb(node) {
  if (!node) return null;
  if (node.tagName === 'CANVAS' || node.tagName === 'IMG') {
    const img = new Image();
    img.src = node.tagName === 'CANVAS' ? node.toDataURL() : node.src;
    return img;
  }
  return node.cloneNode(true);
}

function whereText(entry) {
  const i = entry.path.lastIndexOf('/');
  const dir = i >= 0 ? entry.path.slice(0, i) : '';
  return [entry.root, dir].filter(Boolean).join(' / ') || 'Selected files';
}

function openInfo(entry) {
  const box = h('div');

  // Layout like the Mac "About This Mac" window: picture, big name, small badge, then the rows
  const head = h('div', 'info-head');
  const thumb = h('div', 'info-thumb');
  const pic = cloneThumb(entry.thumbNode);
  if (pic) thumb.appendChild(pic);
  head.append(thumb, h('div', 'info-name', entry.name), h('span', 'tag tag-' + entry.kind, entry.tag));

  const rows = h('dl', 'info-rows');
  const addRow = (label, value) => rows.append(h('dt', '', label), h('dd', '', value));
  addRow('Kind', KIND_NAMES[entry.ext] || entry.tag);
  addRow('Size', formatSize(entry.size) + '  (' + entry.size.toLocaleString('en-US') + ' bytes)');
  addRow('Where', whereText(entry));
  addRow('Modified', fullDate(entry.modified));
  const pendingLabel = h('dt', '', 'More');
  const pendingValue = h('dd', 'pending', 'Reading details…');
  rows.append(pendingLabel, pendingValue);

  const close = h('button', 'btn', 'Close');
  close.type = 'button';
  close.onclick = closeModal;
  const open = h('button', 'btn btn-primary', 'Open');
  open.type = 'button';
  const openFile = () => { closeModal(); openViewer(entry); };
  open.onclick = openFile;
  const actions = h('div', 'modal-actions');
  actions.append(close, open);

  const keys = h('div', 'info-keys');
  const key = (t) => h('kbd', '', t);
  keys.append(key('Enter'), document.createTextNode(' open'), h('i', 'sep'), key('Space'), key('Esc'), document.createTextNode(' close'));

  box.append(head, rows, actions, keys);
  M.entry = entry;
  openModal(box, { onEnter: openFile, spaceCloses: true, cls: 'about' });
  fitPageThumbs(box);

  // The rest (pages, author, dimensions…) needs reading inside the file, so it arrives a moment later
  loadDetails(entry).then((extra) => {
    if (M.entry !== entry || M.el.hidden) return;        // the dialog was closed or replaced meanwhile
    pendingLabel.remove();
    pendingValue.remove();
    for (const [label, value] of extra) addRow(label, value);
  });
}

function parsePdfDate(s) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
  if (!m) return '';
  return fullDate(new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0).getTime());
}

// Reads extra facts from inside the file. Returns a list of [label, value].
async function loadDetails(entry) {
  const rows = [];
  const add = (label, value) => {
    if (value === undefined || value === null || String(value).trim() === '') return;
    rows.push([label, typeof value === 'number' ? value.toLocaleString('en-US') : String(value)]);
  };
  const dateText = (v) => { const d = new Date(v); return isNaN(d) ? '' : fullDate(d.getTime()); };

  try {
    if (FORMAT_VIEWERS.has(entry.viewer)) {
      await lib('formats');
      await VIEWER_CLASSES[entry.viewer].details(entry, add, dateText);

    } else if (entry.kind === 'pdf') {
      await lib('pdf');
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await entry.file.arrayBuffer()) }).promise;
      let info = {};
      try { info = (await doc.getMetadata()).info || {}; } catch (e) { /* no metadata */ }
      const v = (await doc.getPage(1)).getViewport({ scale: 1 });
      add('Pages', doc.numPages);
      add('Page size', Math.round(v.width * 25.4 / 72) + ' × ' + Math.round(v.height * 25.4 / 72) + ' mm');
      add('Title', info.Title);
      add('Author', info.Author);
      add('Created with', info.Creator);
      add('PDF producer', info.Producer);
      add('Created', parsePdfDate(info.CreationDate));
      add('PDF version', info.PDFFormatVersion);
      doc.destroy();

    } else if (entry.kind === 'xlsx') {
      await lib('xlsx');
      const wb = XLSX.read(await entry.file.arrayBuffer(), { type: 'array', bookProps: true, bookSheets: true });
      const p = wb.Props || {};
      add('Sheets', wb.SheetNames.length);
      add('Sheet names', wb.SheetNames.join(', '));
      add('Title', p.Title);
      add('Author', p.Author);
      add('Last saved by', p.LastAuthor);
      add('Created', p.CreatedDate ? dateText(p.CreatedDate) : '');
      add('Application', p.Application);

    } else if (entry.kind === 'pptx' || entry.kind === 'docx') {
      await lib('zip');
      const zip = await JSZip.loadAsync(entry.file);
      const read = async (name) => (zip.file(name) ? zip.file(name).async('string') : '');
      const core = await read('docProps/core.xml');
      const app = await read('docProps/app.xml');
      if (entry.kind === 'pptx') {
        add('Slides', entry.pages || Number(xmlTag(app, 'Slides')));
      } else {
        add('Pages (as saved)', Number(xmlTag(app, 'Pages')));
        add('Words (as saved)', Number(xmlTag(app, 'Words')));
      }
      add('Title', xmlTag(core, 'dc:title'));
      add('Author', xmlTag(core, 'dc:creator'));
      add('Last saved by', xmlTag(core, 'cp:lastModifiedBy'));
      add('Created', dateText(xmlTag(core, 'dcterms:created')));
      add('Saved in document', dateText(xmlTag(core, 'dcterms:modified')));
      add('Application', xmlTag(app, 'Application'));

    } else if (entry.kind === 'image') {
      const url = URL.createObjectURL(entry.file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        if (img.naturalWidth) add('Dimensions', img.naturalWidth + ' × ' + img.naturalHeight + ' px');
      } finally { URL.revokeObjectURL(url); }

    } else if (entry.kind === 'text' || entry.kind === 'code') {
      if (entry.size <= 2 * 1024 * 1024) {
        const buf = await entry.file.arrayBuffer();
        let encoding = 'UTF-8';
        try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { encoding = 'Windows-1251'; }
        const text = decodeText(buf, false);
        add('Encoding', encoding);
        add('Lines', text.split(/\r?\n/).length);
        add('Words', (text.match(/\S+/g) || []).length);
        add('Characters', text.length);
      }
    }
  } catch (err) {
    console.warn('Could not read details:', entry.name, err);
  }
  if (!rows.length) rows.push(['More', 'No extra details found in this file']);
  return rows;
}


/* ---------------------------------------------------------------------
   5c. CLASS QUEUE
   The files for one lesson, in the order they will be shown. "+" on a card (or Q) adds a file;
   the Queue button opens the list to put it in order and start. While a file of the queue is open,
   [ ] (or the two small arrows in the top bar) jump between the files, and a second "Next" at the
   very end of a file moves on to the next one — handy with a presentation clicker.
   The list lives only while the page is open: a reload, or a different folder, starts with an empty queue
   (a rescan of the same folder keeps it).
   --------------------------------------------------------------------- */

const Q = { items: [] };      // { path, name, size, modified, ext, entry }   (entry = the loaded file, or null)

try { localStorage.removeItem('fv-queue'); } catch (e) { /* the queue of older versions is forgotten: it only ever lives while the page is open */ }

// Connects every remembered item with the loaded file that is the same one (same place and size, or same name and size)
function relinkQueue() {
  if (!Q.items.length) return;
  const taken = new Set(Q.items.map((it) => it.entry).filter((e) => e && state.files.includes(e)));
  for (const it of Q.items) {
    if (it.entry && state.files.includes(it.entry)) continue;
    const free = (e) => !taken.has(e);
    it.entry = state.files.find((e) => free(e) && e.path === it.path && e.size === it.size)
            || state.files.find((e) => free(e) && e.name === it.name && e.size === it.size)
            || state.files.find((e) => free(e) && e.path === it.path)
            || null;
    if (it.entry) taken.add(it.entry);
  }
}

function queueIndexOf(entry) { return Q.items.findIndex((it) => it.entry === entry); }

function queueToggle(entry) {
  const i = queueIndexOf(entry);
  if (i >= 0) Q.items.splice(i, 1);
  else Q.items.push({ path: entry.path, name: entry.name, size: entry.size, modified: entry.modified, ext: entry.ext, entry });
  queueChanged();
}
function queueChanged() {
  const place = new Map(Q.items.map((it, i) => [it.entry, i]));
  for (const e of state.files) markQueue(e, place.has(e) ? place.get(e) : -1);   // only cards whose place changed are touched
  $('btnQueue').hidden = !state.files.length && !Q.items.length;
  $('qCount').textContent = Q.items.length ? String(Q.items.length) : '';
  if (!M.el.hidden && M.body.classList.contains('queue-dialog')) renderQueueDialog();
  updateQueueNav();
}

// The little button on a card: "+" when it is not in the queue, its place number when it is
function markQueue(entry, i = queueIndexOf(entry)) {
  if (!entry.card || entry.qMark === i) return;
  entry.qMark = i;
  const btn = entry.card.querySelector('.card-queue');
  entry.card.classList.toggle('queued', i >= 0);
  btn.replaceChildren(i >= 0 ? document.createTextNode(String(i + 1)) : icon('i-plus'));
  btn.title = i >= 0 ? 'In the class queue (place ' + (i + 1) + ') — click to remove (Q)' : 'Add to the class queue (Q)';
  btn.setAttribute('aria-label', btn.title);
}

/* ----- Moving between the files of the queue while viewing ----- */
function queueNeighbor(dir) {
  const i = V.entry ? queueIndexOf(V.entry) : -1;
  if (i < 0) return null;
  for (let j = i + dir; j >= 0 && j < Q.items.length; j += dir) if (Q.items[j].entry) return Q.items[j];
  return null;
}
function queueStep(dir) {
  const n = queueNeighbor(dir);
  if (n) openViewer(n.entry);
  else if (V.entry && queueIndexOf(V.entry) >= 0) showToast(dir > 0 ? 'This is the last file of the queue' : 'This is the first file of the queue');
}
// Pressed Next at the end of a file (or Previous at its start): the first press only announces the move
function queueEdge(where) {
  const n = queueNeighbor(where === 'next' ? 1 : -1);
  if (!n) return false;
  const a = V.armed;
  if (a && a.where === where && a.entry === V.entry && Date.now() < a.until) { V.armed = null; openViewer(n.entry); return true; }
  V.armed = { where, entry: V.entry, until: Date.now() + 4000 };
  showToast((where === 'next' ? 'Next file: ' : 'Previous file: ') + n.name + ' — press again');
  return true;
}
function updateQueueNav() {
  const i = V.entry ? queueIndexOf(V.entry) : -1;
  const show = i >= 0 && Q.items.length > 1;
  $('qNav').hidden = !show;
  if (!show) return;
  $('qPos').textContent = (i + 1) + ' / ' + Q.items.length;
  $('qPrev').disabled = !queueNeighbor(-1);
  $('qNext').disabled = !queueNeighbor(1);
}

/* ----- The queue window ----- */
function queueStart() {
  const first = Q.items.find((it) => it.entry);
  if (!first) return;
  closeModal();
  openViewer(first.entry);
}

function openQueue() {
  if (M.el.hidden) renderQueueDialog(true); else renderQueueDialog();
}

function renderQueueDialog(first) {
  const box = h('div');
  box.appendChild(h('h2', 'modal-title', 'Class queue'));
  const loaded = Q.items.filter((it) => it.entry).length;

  if (!Q.items.length) {
    box.appendChild(h('p', 'modal-text', 'Nothing here yet. Press + on a file card (or Q) to add the files for this lesson.'));
  } else {
    box.appendChild(h('p', 'modal-text', 'Put the files in order, then press Start. Inside a file, [ and ] jump to the next and previous one.'));
    const list = h('div', 'q-list');
    Q.items.forEach((it, i) => {
      const row = h('div', 'q-row' + (it.entry ? '' : ' missing'));
      const info = h('span', 'q-name');
      info.append(h('b', '', it.name), h('small', '', it.entry ? whereText(it.entry) : 'Not loaded — choose the folder again'));
      const btn = (iconId, label, fn, disabled) => {
        const b = h('button', 'vbtn vbtn-icon q-btn');
        b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
        b.appendChild(icon(iconId));
        b.disabled = !!disabled;
        b.onclick = () => { fn(); b.blur(); };
        return b;
      };
      const move = (d) => () => { const t = Q.items[i + d]; Q.items[i + d] = it; Q.items[i] = t; queueChanged(); };
      row.append(
        h('span', 'q-num', String(i + 1)),
        h('span', 'tag tag-' + (EXT_TO_KIND[it.ext] || 'text'), (it.ext || '?').toUpperCase()),
        info,
        btn('i-up', 'Move up', move(-1), i === 0),
        btn('i-down', 'Move down', move(1), i === Q.items.length - 1),
        btn('i-x', 'Remove from the queue', () => { Q.items.splice(i, 1); queueChanged(); }));
      list.appendChild(row);
    });
    box.appendChild(list);
    const clear = h('button', 'q-clear', 'Remove all');
    clear.type = 'button';
    clear.onclick = () => { Q.items = []; queueChanged(); };
    box.appendChild(h('div', 'q-clear-row')).appendChild(clear);
  }

  const actions = h('div', 'modal-actions');
  const close = h('button', 'btn', 'Close');
  close.type = 'button';
  close.onclick = closeModal;
  actions.append(close);
  if (Q.items.length) {                       // nothing to start when the list is empty
    const start = h('button', 'btn btn-primary', 'Start');
    start.type = 'button';
    start.disabled = !loaded;
    start.onclick = queueStart;
    actions.append(start);
  }
  box.appendChild(actions);

  if (first) {
    openModal(box, { onEnter: queueStart, cls: 'queue-dialog' });
  } else {
    const old = M.body.querySelector('.q-list');
    const top = old ? old.scrollTop : 0;
    M.body.replaceChildren(box);
    const now = M.body.querySelector('.q-list');
    if (now) now.scrollTop = top;
    M.onEnter = queueStart;
  }
}
$('btnQueue').onclick = openQueue;


/* ---------------------------------------------------------------------
   6. THUMBNAILS
   Made one at a time, only for cards that are on screen,
   and paused while the viewer is open.
   --------------------------------------------------------------------- */

const thumbQueue = [];
let thumbBusy = false;

const thumbObserver = new IntersectionObserver((items) => {
  for (const item of items) {
    if (!item.isIntersecting) continue;
    thumbObserver.unobserve(item.target);
    const entry = state.files.find((e) => e.id === Number(item.target.dataset.id));
    if (entry && !entry.thumbRequested) { entry.thumbRequested = true; thumbQueue.push(entry); }
  }
  runThumbQueue();
}, { rootMargin: '300px' });

async function runThumbQueue() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length && V.el.hidden) {
    const entry = thumbQueue.shift();
    try {
      if (FORMAT_VIEWERS.has(entry.viewer)) {          // the newer formats make their own thumbnails
        await lib('formats');
        await VIEWER_CLASSES[entry.viewer].thumb(entry);
      } else switch (entry.kind) {
        case 'pdf':   await thumbPdf(entry); break;
        case 'xlsx':  await thumbXlsx(entry); break;
        case 'image': thumbImage(entry); break;
        case 'text':  await thumbText(entry); break;
        case 'code':  await thumbText(entry); break;
        default:      await thumbOffice(entry);
      }
    } catch (err) {
      console.warn('Could not make a thumbnail:', entry.name, err);
    }
    putThumb(entry);
  }
  thumbBusy = false;
}

function putThumb(entry) {
  if (!entry.card || !entry.thumbNode) return;
  const thumb = entry.card.querySelector('.thumb');
  thumb.replaceChildren(entry.thumbNode, ...thumb.querySelectorAll('.tag, .card-queue'));   // picture + the buttons on top
  fitPageThumbs(thumb);
}

// PDF: draw page 1 into a small canvas
async function thumbPdf(entry) {
  await lib('pdf');
  const data = new Uint8Array(await entry.file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data }).promise;
  entry.pages = doc.numPages;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 420 / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#fff' }).promise;
  entry.thumbNode = canvas;
  doc.destroy();
}

// PPTX / DOCX are zip archives: count slides, use the saved preview picture or show the first text
async function thumbOffice(entry) {
  await lib('zip');
  const zip = await JSZip.loadAsync(entry.file);
  if (entry.kind === 'pptx') {
    entry.pages = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  }
  // (DOCX page count isn't stored reliably in the file — Word computes it — so we don't show one)

  const pic = zip.file(/^docProps\/thumbnail\.(jpe?g|png)$/i)[0];
  if (pic) {
    const type = /png$/i.test(pic.name) ? 'image/png' : 'image/jpeg';
    entry.thumbUrl = URL.createObjectURL(new Blob([await pic.async('uint8array')], { type }));
    const img = new Image();
    img.src = entry.thumbUrl;
    entry.thumbNode = img;
    return;
  }

  if (entry.kind === 'docx' && entry.size < 6 * 1024 * 1024) {          // no stored picture: draw the real first page
    try { if (await thumbDocxPage(entry)) return; } catch (err) { console.warn('DOCX thumbnail:', err); }
  }

  const xmlFile = zip.file(entry.kind === 'pptx' ? 'ppt/slides/slide1.xml' : 'word/document.xml');
  if (!xmlFile) return;
  const xml = await xmlFile.async('string');
  const tag = entry.kind === 'pptx' ? 'a:t' : 'w:t';
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]*)</' + tag + '>', 'g');
  const pieces = [];
  let m;
  while ((m = re.exec(xml)) && pieces.join(' ').length < 400) pieces.push(decodeXml(m[1]));
  if (!pieces.length) return;
  const snippet = h('div', 'snippet');
  snippet.appendChild(h('b', '', pieces[0]));
  snippet.appendChild(document.createTextNode(pieces.slice(1).join(' ')));
  entry.thumbNode = snippet;
}

// DOCX without a stored picture: render the document out of sight and keep a scaled copy of its first page
async function thumbDocxPage(entry) {
  await lib('docx');
  const host = h('div', 'docx-host');
  Object.assign(host.style, { position: 'fixed', left: '-20000px', top: '0', width: '1000px' });
  document.body.appendChild(host);
  try {
    await docx.renderAsync(await entry.file.arrayBuffer(), host, null,
      { className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false });
    const page = host.querySelector('section.docx');
    if (!page || !page.offsetWidth || !page.offsetHeight) return false;
    placeAnchors(page);
    const W = page.offsetWidth, H = parseFloat(getComputedStyle(page).minHeight) || page.offsetHeight;
    const copy = host.cloneNode(true);                                   // keeps docx-preview's own <style> with it
    copy.style.cssText = 'width:' + W + 'px;height:' + H + 'px';
    copy.querySelectorAll('section.docx').forEach((sec, i) => { if (i) sec.remove(); });
    const box = h('div', 'page-thumb');
    box.dataset.w = W; box.dataset.h = H;
    box.style.aspectRatio = W + ' / ' + H;
    box.appendChild(copy);
    entry.thumbNode = box;
    return true;
  } finally { host.remove(); }
}
// A page-thumb is drawn at the page's natural size and scaled to fit its box (cards and the info window)
function fitPageThumbs(root) {
  (root || document).querySelectorAll('.page-thumb').forEach((box) => {
    const w = Number(box.dataset.w), width = box.clientWidth;
    if (w && width) box.style.setProperty('--s', (width / w).toFixed(4));
  });
}
if ('ResizeObserver' in window) new ResizeObserver(() => fitPageThumbs()).observe($('grid'));

// XLSX / CSV: a tiny table of the first rows (only the first rows are parsed — fast)
async function thumbXlsx(entry) {
  await lib('xlsx');
  const wb = XLSX.read(await entry.file.arrayBuffer(), { type: 'array', sheetRows: 8 });
  entry.pages = wb.SheetNames.length;
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }).slice(0, 7);
  const table = h('table', 'mini-table');
  for (const row of rows) {
    const tr = h('tr');
    for (const cell of row.slice(0, 5)) tr.appendChild(h('td', '', String(cell)));
    table.appendChild(tr);
  }
  const box = h('div', 'snippet snippet-table');
  box.appendChild(table);
  entry.thumbNode = box;
}

// Images: the picture itself
function thumbImage(entry) {
  entry.thumbUrl = URL.createObjectURL(entry.file);
  const img = new Image();
  img.src = entry.thumbUrl;
  entry.thumbNode = img;
}

// Text: the first lines
async function thumbText(entry) {
  const head = await entry.file.slice(0, 2000).arrayBuffer();
  const text = decodeText(head, entry.size > 2000).trim();
  if (!text) return;
  const lines = text.split(/\r?\n/);
  const snippet = h('div', 'snippet');
  snippet.appendChild(h('b', '', lines[0].slice(0, 80)));
  snippet.appendChild(document.createTextNode(lines.slice(1).join(' ').slice(0, 360)));
  entry.thumbNode = snippet;
}


/* ---------------------------------------------------------------------
   7. VIEWERS
   Each file type has its own class. They all offer the same things:
     open(file)      open the file
     go(where)       'first' | 'prev' | 'next' | 'last'
     goTo(i)         jump to page/slide/sheet number i (0-based)
     seek(ratio)     jump to a place 0..1 (used by the progress bar)
     label()         text like "Slide 3 of 12"
     progress()      0..1 for the progress bar
     atStart/atEnd   are we at the beginning / the end?
     refit()         re-fit after a size / zoom / rotation change
     renderThumb()   draw one overview thumbnail
     destroy()       clean up
     inkKey()        which page the pen drawing belongs to; inkAnchor() the element it is measured against
   Shared view settings (zoom, fit, rotation) arrive as `this.view`.
   --------------------------------------------------------------------- */

class BaseViewer {
  constructor(content, stage, view) {
    this.content = content;     // where we draw
    this.stage = stage;         // the scrollable area around it
    this.view = view;           // { zoom, fit: 'page' | 'width', rot: 0 | 90 | 180 | 270 }
    this.onChange = () => {};   // tells the window to refresh label and buttons
    this.canFit = false;
    this.canRotate = false;
    this.hasOverview = false;
    this.defaultFit = 'page';
    this.canDraw = true;        // pen / marker allowed
    this.isMedia = false;       // video / audio have their own tiny controls
  }

  // Pen drawing: which page it belongs to, and the element it is anchored to (so it follows zoom and scroll)
  inkKey() { return this.index; }
  inkAnchor() { return this.content; }

  // Space available for the page (the content has padding around it; in fullscreen it has none)
  free() {
    const cs = getComputedStyle(this.content);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return {
      w: Math.max(100, this.stage.clientWidth - padX),
      h: Math.max(100, this.stage.clientHeight - padY),
    };
  }

  get count() { return 1; }
  get index() { return 0; }
  notesFor() { return ''; }          // speaker notes of page i (PPTX / ODP)
  get hasNotes() { return false; }
  goTo() {}
  go(where) {
    const i = this.index, last = this.count - 1;
    this.goTo(clamp({ first: 0, prev: i - 1, next: i + 1, last }[where], 0, last));
  }
  seek(ratio) { if (this.count > 1) this.goTo(Math.round(ratio * (this.count - 1))); }
  label() { return ''; }
  caption(i) { return String(i + 1); }
  progress() { return this.count > 1 ? this.index / (this.count - 1) : 1; }
  atStart() { return this.index <= 0; }
  atEnd() { return this.index >= this.count - 1; }
  currentIndex() { return this.index; }
  refit() {}
  get thumbRatio() { return 0.75; }          // height / width of an overview thumbnail
  async renderThumb() {}
  destroy() { this.content.replaceChildren(); }
}

/* ----- PDF: one page at a time ----- */
class PdfViewer extends BaseViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true; this.canRotate = true; this.hasOverview = true;
  }

  async open(file) {
    await lib('pdf');
    const data = new Uint8Array(await file.arrayBuffer());
    this.doc = await pdfjsLib.getDocument({ data }).promise;
    this.total = this.doc.numPages;
    this.page = 1;
    this.shown = 0;            // the page that is really on the screen (a new one takes a moment to draw)
    this.drawId = 0;
    const first = await this.doc.getPage(1);
    const v = first.getViewport({ scale: 1 });
    this.ratio = v.height / v.width;
    await this.draw();
  }

  get count() { return this.total; }
  get index() { return this.page - 1; }
  get thumbRatio() { return this.ratio || 1.4; }
  inkKey() { return this.shown; }
  inkAnchor() { return this.content.firstElementChild; }
  label() { return 'Page ' + this.page + ' of ' + this.total; }

  goTo(i) {
    const page = clamp(i, 0, this.total - 1) + 1;
    if (page === this.page) return;
    this.page = page;
    this.onChange();
    this.draw();
  }

  async draw(keepScroll) {
    const myId = ++this.drawId;                    // if we're asked again while drawing, the older draw is dropped
    const page = await this.doc.getPage(this.page);
    if (myId !== this.drawId) return;

    const rotation = (page.rotate + this.view.rot) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const free = this.free();
    const fit = this.view.fit === 'width'
      ? free.w / base.width
      : Math.min(free.w / base.width, free.h / base.height);
    const cssScale = fit * this.view.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    // Never ask for a canvas bigger than browsers can handle
    const scale = Math.min(cssScale * dpr, 8192 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale, rotation });

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(base.width * cssScale) + 'px';
    canvas.style.height = Math.floor(base.height * cssScale) + 'px';

    if (this.task) this.task.cancel();
    this.task = page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#fff' });
    try { await this.task.promise; }
    catch (err) { if (err && err.name === 'RenderingCancelledException') return; throw err; }
    if (myId !== this.drawId) return;

    this.content.replaceChildren(canvas);          // swap the whole picture at once — no flicker
    this.shown = this.page - 1;
    if (!keepScroll) this.stage.scrollTo(0, 0);
    this.onChange();
  }

  refit() { if (this.doc) this.draw(true); }

  async renderThumb(i, el) {
    const page = await this.doc.getPage(i + 1);
    const base = page.getViewport({ scale: 1 });
    const width = 260 * Math.min(window.devicePixelRatio || 1, 2);
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#fff' }).promise;
    el.replaceChildren(canvas);
  }

  destroy() {
    this.drawId++;
    if (this.task) this.task.cancel();
    if (this.doc) this.doc.destroy();
    super.destroy();
  }
}

/* ----- Shared base for things drawn in a box that we scale and rotate: slides and images ----- */
class BoxViewer extends BaseViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true; this.canRotate = true;
  }

  setupBox(W, H, extraClass) {
    this.W = W; this.H = H;
    this.holder = h('div', 'slide-holder' + (extraClass ? ' ' + extraClass : ''));
    this.box = h('div', 'slide-box');
    this.box.style.width = W + 'px';
    this.box.style.height = H + 'px';
    this.holder.appendChild(this.box);
    this.content.replaceChildren(this.holder);
  }

  inkAnchor() { return this.holder; }

  refit() {
    if (!this.holder) return;
    const rot = this.view.rot;
    const swap = rot % 180 !== 0;
    const w = swap ? this.H : this.W;               // size after rotation (before scaling)
    const hh = swap ? this.W : this.H;
    const free = this.free();
    const fit = this.view.fit === 'width' ? free.w / w : Math.min(free.w / w, free.h / hh);
    const s = fit * this.view.zoom;

    this.holder.style.width = Math.floor(w * s) + 'px';
    this.holder.style.height = Math.floor(hh * s) + 'px';
    // Rotate around the corner, then slide back into view
    const move = {
      0: '',
      90: 'translate(' + this.H * s + 'px,0) rotate(90deg) ',
      180: 'translate(' + this.W * s + 'px,' + this.H * s + 'px) rotate(180deg) ',
      270: 'translate(0,' + this.W * s + 'px) rotate(270deg) ',
    }[rot];
    this.box.style.transform = move + 'scale(' + s + ')';
  }
}

/* ----- PPTX speaker notes: read straight from the file (ppt/notesSlides), one text per slide ----- */
async function pptxNotes(zip) {
  const text = async (n) => { const f = zip.file(n); return f ? f.async('string') : ''; };
  const dom = (x) => new DOMParser().parseFromString(x, 'application/xml');
  const resolve = (base, target) => {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/'); parts.pop();
    for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
    return parts.join('/');
  };
  const rels = async (path) => {
    const dir = path.split('/'), file = dir.pop();
    const xml = await text(dir.join('/') + '/_rels/' + file + '.rels');
    const out = [];
    if (xml) for (const r of dom(xml).getElementsByTagName('Relationship')) {
      out.push({ id: r.getAttribute('Id'), type: r.getAttribute('Type') || '', target: resolve(path, r.getAttribute('Target') || '') });
    }
    return out;
  };
  const pres = dom(await text('ppt/presentation.xml'));
  const presRels = await rels('ppt/presentation.xml');
  const notes = [];
  for (const sld of pres.getElementsByTagName('p:sldId')) {
    const slide = (presRels.find((r) => r.id === sld.getAttribute('r:id')) || {}).target;
    let note = '';
    const link = slide ? (await rels(slide)).find((r) => /\/notesSlide$/.test(r.type)) : null;
    if (link) {
      const d = dom(await text(link.target));
      for (const sp of d.getElementsByTagName('p:sp')) {
        const ph = sp.getElementsByTagName('p:ph')[0];
        if (!ph || ph.getAttribute('type') !== 'body') continue;
        note = [...sp.getElementsByTagName('a:p')]
          .map((p) => [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join(''))
          .join('\n').trim();
      }
    }
    notes.push(note);
  }
  return notes;
}

/* ----- PPTX: one slide at a time ----- */
class PptxViewer extends BoxViewer {
  constructor(...args) { super(...args); this.hasOverview = true; }

  async open(file) {
    await lib('pptx');
    this.buf = await file.arrayBuffer();

    // Slide proportions (16:9, 4:3 …) from presentation.xml
    let ratio = 9 / 16, zip = null;
    try {
      zip = await JSZip.loadAsync(this.buf);
      const xml = await zip.file('ppt/presentation.xml').async('string');
      const cx = xml.match(/<p:sldSz[^>]*\scx="(\d+)"/);
      const cy = xml.match(/<p:sldSz[^>]*\scy="(\d+)"/);
      if (cx && cy) ratio = Number(cy[1]) / Number(cx[1]);
    } catch (e) { /* assume 16:9 */ }

    this.setupBox(1280, Math.round(1280 * ratio));
    this.previewer = pptxPreview.init(this.box, { width: this.W, height: this.H, mode: 'slide' });
    await this.previewer.load(this.buf);
    this.total = this.previewer.slideCount;
    this.notes = zip ? await pptxNotes(zip).catch(() => []) : [];
    this.cur = 0;
    this.show();
    this.refit();
  }

  get count() { return this.total; }
  get index() { return this.cur; }
  get thumbRatio() { return this.H / this.W; }
  notesFor(i) { return (this.notes && this.notes[i]) || ''; }
  get hasNotes() { return !!this.notes && this.notes.some(Boolean); }
  label() { return 'Slide ' + (this.cur + 1) + ' of ' + this.total; }

  show() {
    this.previewer.removeCurrentSlide();
    this.previewer.renderSingleSlide(this.cur);
    this.onChange();
  }
  goTo(i) {
    i = clamp(i, 0, this.total - 1);
    if (i === this.cur) return;
    this.cur = i;
    this.show();
  }

  // Overview: slides are drawn by a second, hidden previewer so the visible slide never flickers
  async renderThumb(i, el) {
    this.thumbChain = (this.thumbChain || Promise.resolve()).then(async () => {
      if (!this.thumbPv) {
        this.thumbHost = h('div');
        Object.assign(this.thumbHost.style, { position: 'fixed', left: '-20000px', top: '0', width: this.W + 'px', height: this.H + 'px' });
        document.body.appendChild(this.thumbHost);
        this.thumbPv = pptxPreview.init(this.thumbHost, { width: this.W, height: this.H, mode: 'slide' });
        await this.thumbPv.load(this.buf);
      }
      this.thumbPv.removeCurrentSlide();
      this.thumbPv.renderSingleSlide(i);
      const src = this.thumbHost.querySelector('.pptx-preview-slide-wrapper');
      if (!src) return;
      const clone = src.cloneNode(true);
      clone.style.cssText += ';position:absolute;left:0;top:0;margin:0';
      const host = h('div', 'clone-host');
      host.style.width = this.W + 'px';
      host.style.height = this.H + 'px';
      host.style.transform = 'scale(' + ((el.clientWidth || 220) / this.W) + ')';
      host.appendChild(clone);
      el.replaceChildren(host);
    }).catch((err) => console.warn('Thumbnail failed:', err));
    return this.thumbChain;
  }

  destroy() {
    try { if (this.previewer) this.previewer.destroy(); } catch (e) { /* fine */ }
    try { if (this.thumbPv) this.thumbPv.destroy(); } catch (e) { /* fine */ }
    if (this.thumbHost) this.thumbHost.remove();
    super.destroy();
  }
}

/* ----- Image ----- */
class ImageViewer extends BoxViewer {
  async open(file) {
    this.url = URL.createObjectURL(file);
    const img = new Image();
    img.src = this.url;
    await img.decode();
    this.setupBox(img.naturalWidth || 1000, img.naturalHeight || 700, 'image-holder');
    this.box.appendChild(img);
    this.refit();
  }
  label() { return this.W + ' × ' + this.H + ' px'; }
  destroy() { if (this.url) URL.revokeObjectURL(this.url); super.destroy(); }
}

/* ----- Shared base for scrolling content (DOCX, text) ----- */
class ScrollViewer extends BaseViewer {
  inkKey() { return 'doc'; }
  scrollRatio() {
    const max = this.stage.scrollHeight - this.stage.clientHeight;
    return max > 0 ? this.stage.scrollTop / max : 0;
  }
  // "Next" scrolls almost a screen; "first" and "last" jump
  go(where) {
    const st = this.stage;
    const step = st.clientHeight * 0.9;
    const top = { first: 0, prev: st.scrollTop - step, next: st.scrollTop + step, last: st.scrollHeight }[where];
    st.scrollTo({ top, behavior: where === 'prev' || where === 'next' ? 'smooth' : 'auto' });
  }
  seek(ratio) { this.stage.scrollTop = ratio * (this.stage.scrollHeight - this.stage.clientHeight); }
  progress() { return this.scrollRatio(); }
  atStart() { return this.stage.scrollTop <= 2; }
  atEnd() { return this.stage.scrollTop + this.stage.clientHeight >= this.stage.scrollHeight - 2; }
  listenScroll() {
    this.onScroll = () => this.onChange();
    this.stage.addEventListener('scroll', this.onScroll, { passive: true });
  }
  destroy() {
    if (this.onScroll) this.stage.removeEventListener('scroll', this.onScroll);
    super.destroy();
  }
}

/* ----- DOCX pagination -----
   docx-preview starts a new page only at a hard page break, so the text between two breaks is one very tall "page".
   This cuts such a page into real sheets (the way Word lays them out): paragraphs and table rows that do not fit are
   moved to the next sheet, a long paragraph is split between two lines (never leaving one line alone), headings stay
   with the text after them, and a dark gap is drawn between the sheets. Returns how many sheets the page became. */
const DOCX_GAP = 28;
// Pictures anchored to a paragraph ("relative to paragraph"): put them at the paragraph's top + the offset
function placeAnchors(sec) {
  const list = sec.querySelectorAll('[data-dx-para]');
  if (!list.length) return;
  const t0 = sec.getBoundingClientRect().top;
  list.forEach((a) => {
    const p = a.closest('p');
    if (p) a.style.top = 'calc(' + (p.getBoundingClientRect().top - t0) + 'px + ' + a.getAttribute('data-dx-para') + ')';
  });
}
function paginateDocx(sec, P) {
  const articles = Array.from(sec.querySelectorAll(':scope > article'));
  if (!articles.length) return 1;
  if (sec.offsetHeight <= P + 3) return 1;
  const cs = getComputedStyle(sec);
  const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
  const G = DOCX_GAP, pitch = P + G;
  if (P - padT - padB < 120) return 1;
  const secTop = () => sec.getBoundingClientRect().top;
  const rel = (el) => { const r = el.getBoundingClientRect(), t = secTop(); return { top: r.top - t, bottom: r.bottom - t }; };
  const contentTop = (k) => k * pitch + padT;
  const contentBottom = (k) => k * pitch + P - padB;

  // The lines of a paragraph, measured on the screen: [{ top, bottom }]
  function lineBoxes(el) {
    const hidden = Array.from(el.querySelectorAll('[data-dx-abs]'));
    hidden.forEach((a) => { a.dataset.dxDisp = a.style.display; a.style.display = 'none'; });
    const range = document.createRange();
    range.selectNodeContents(el);
    const t0 = secTop();
    const rects = Array.from(range.getClientRects()).filter((r) => r.height > 2).sort((a, b) => a.top - b.top || a.left - b.left);
    hidden.forEach((a) => { a.style.display = a.dataset.dxDisp; delete a.dataset.dxDisp; });
    const lines = [];
    for (const r of rects) {
      const top = r.top - t0, bottom = r.bottom - t0, last = lines[lines.length - 1];
      if (last && top < last.top + (last.bottom - last.top) * 0.6) { last.top = Math.min(last.top, top); last.bottom = Math.max(last.bottom, bottom); }
      else lines.push({ top, bottom });
    }
    // Glyph boxes of neighbouring lines can overlap (single line spacing): use evenly spaced line boxes instead
    if (lines.length > 1) {
      const gaps = lines.slice(1).map((l, i) => l.top - lines[i].top).filter((g) => g > 1).sort((a, b) => a - b);
      const d = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
      if (d) lines.forEach((l) => { if (l.bottom - l.top <= d * 1.3) { const c = (l.top + l.bottom) / 2; l.top = c - d / 2; l.bottom = c + d / 2; } });
    }
    return lines;
  }
  const mk = (tag, cls) => { const e = document.createElement(tag); e.className = cls; return e; };
  // Put `el` (with a spacer in front of it) exactly at `target` (px from the top of the section)
  function placeAt(el, spacer, target) {
    spacer.style.height = '0px';
    let t = rel(el).top;
    spacer.style.height = Math.max(0, target - t) + 'px';
    t = rel(el).top;
    if (Math.abs(t - target) > 0.5) spacer.style.height = Math.max(0, parseFloat(spacer.style.height) + target - t) + 'px';
  }

  const units = [];
  for (const art of articles) {
    if (art.style.columnCount && art.style.columnCount !== '1') { units.push({ kind: 'block', box: art, src: art, off: 0 }); continue; }   // text in columns stays whole
    for (const el of Array.from(art.children)) {
      if (el.tagName === 'TABLE') Array.from(el.rows).forEach((tr) => units.push({ kind: 'row', box: tr }));
      else units.push({ kind: el.tagName === 'P' ? 'p' : 'block', box: el, src: el, off: 0 });
    }
  }
  const isHeading = (u) => u.kind === 'p' && /heading|title|заголов/i.test(u.box.className + ' ' + (u.box.getAttribute('data-style') || ''));

  let k = 0;
  for (let i = 0; i < units.length; i++) {
    let u = units[i];
    for (let guard = 0; guard < 300; guard++) {
      const r = rel(u.box), bottom = contentBottom(k);
      const atTop = r.top <= contentTop(k) + 2;
      let fits = r.bottom <= bottom + 0.5;
      // a heading must not be the last thing on a sheet: its first line of text has to fit as well
      if (fits && isHeading(u) && i + 1 < units.length && !atTop) {
        const nx = units[i + 1], nb = nx.kind === 'p' ? (lineBoxes(nx.box)[0] || rel(nx.box)).bottom : rel(nx.box).bottom;
        if (nb > bottom + 0.5) fits = false;
      }
      if (fits) break;

      if (u.kind === 'p') {
        const all = lineBoxes(u.src), br = rel(u.box);
        const lines = all.filter((l) => l.top >= br.top - 1 && l.top < br.bottom - 1);
        const L = lines.length;
        let m = lines.filter((l) => l.bottom <= bottom + 0.5).length;
        if (L >= 4) { if (m < 2 && !atTop) m = 0; else if (L - m < 2) m = L - 2; }
        else if (!atTop) m = 0;
        if (m >= 1 && m < L) {                              // split between line m-1 and line m
          const cut = (lines[m - 1].bottom + lines[m].top) / 2;
          const hA = cut - br.top, hB = br.bottom - cut;
          const clone = u.src.cloneNode(true);
          clone.removeAttribute('id');
          clone.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
          clone.querySelectorAll('[data-dx-abs]').forEach((e) => e.remove());
          clone.classList.add('dx-clone');
          const mb = u.mb !== undefined ? u.mb : (parseFloat(getComputedStyle(u.box).marginBottom) || 0);
          Object.assign(clone.style, { marginTop: (u.off - hA) + 'px', marginBottom: '0px', boxSizing: 'border-box' });
          const wrap = mk('div', 'dx-part');
          Object.assign(wrap.style, { overflow: 'hidden', height: hB + 'px', marginBottom: mb + 'px' });
          wrap.appendChild(clone);
          const spacer = mk('div', 'dx-sp');
          Object.assign(u.box.style, { boxSizing: 'border-box', height: hA + 'px', overflow: 'hidden', marginBottom: '0px' });
          u.box.after(spacer, wrap);
          k++;
          placeAt(wrap, spacer, contentTop(k));
          u = units[i] = { kind: 'p', box: wrap, src: clone, off: u.off - hA, mb };
          continue;
        }
        if (m === 0 && atTop) break;                        // does not fit even on an empty sheet: leave it
      } else if (atTop) break;                              // taller than a whole sheet: leave it

      // move the whole unit to the next sheet
      const spacer = u.kind === 'row' ? mk('tr', 'dx-sp') : mk('div', 'dx-sp');
      if (u.kind === 'row') {
        const td = document.createElement('td');
        td.colSpan = 99; td.style.cssText = 'padding:0;border:0;height:0';
        spacer.appendChild(td);
      } else u.box.style.marginTop = '0px';
      u.box.before(spacer);
      k++;
      if (u.kind === 'row') {
        const td = spacer.firstChild;
        const t0 = rel(u.box).top;
        td.style.height = Math.max(0, contentTop(k) - t0) + 'px';
        const t1 = rel(u.box).top;
        if (Math.abs(t1 - contentTop(k)) > 0.5) td.style.height = Math.max(0, parseFloat(td.style.height) + contentTop(k) - t1) + 'px';
      } else placeAt(u.box, spacer, contentTop(k));
    }
  }
  const pages = k + 1;
  if (pages > 1) {
    sec.style.minHeight = (pages * P + k * G) + 'px';
    for (let j = 0; j < k; j++) {
      const band = mk('div', 'dx-gap');
      Object.assign(band.style, { top: (j * pitch + P) + 'px', height: G + 'px' });
      sec.appendChild(band);
    }
  }
  sec.dataset.dxPages = String(pages);
  sec.dataset.dxPitch = String(pitch);
  return pages;
}

/* ----- DOCX: one long scrolling document ----- */
class DocxViewer extends ScrollViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true; this.hasOverview = true;
    this.defaultFit = 'page';
  }

  async open(file) {
    await lib('docx');
    const buf = await file.arrayBuffer();
    this.host = h('div', 'docx-host');
    this.content.replaceChildren(this.host);
    await docx.renderAsync(buf, this.host, null, {
      className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
    });
    // A Word page that is only part of a "section" (long text between two hard page breaks) is cut into real sheets
    const sections = Array.from(this.host.querySelectorAll('section.docx'));
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* fine */ }
    await Promise.all(Array.from(this.host.querySelectorAll('img')).map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
    this.natural = Math.max(...sections.map((p) => p.offsetWidth), 300);                 // page width at 100%
    const nominal = parseFloat(sections[0] && getComputedStyle(sections[0]).minHeight) || Math.min(...sections.map((p) => p.offsetHeight), 1123);
    this.pageH = Math.max(nominal, 300);
    const self = this;
    this.pages = [];
    for (const sec of sections) {
      let n = 1, pitch = this.pageH;
      try { n = paginateDocx(sec, this.pageH); } catch (err) { console.warn('Page layout failed', err); n = 1; }
      placeAnchors(sec);
      if (n > 1) pitch = Number(sec.dataset.dxPitch) || this.pageH;
      else if (sec.offsetHeight > this.pageH + 3) n = Math.ceil((sec.offsetHeight - 3) / this.pageH);   // could not be cut: count by height
      for (let k = 0; k < n; k++) {
        this.pages.push({
          sec, k, pitch,
          getBoundingClientRect() {
            const r = sec.getBoundingClientRect(), z = parseFloat(self.host.style.zoom) || 1, top = r.top + k * pitch * z;
            return { top, bottom: top + self.pageH * z, left: r.left, right: r.right, width: r.width, height: self.pageH * z };
          },
        });
      }
    }
    this.listenScroll();
    this.refit();
  }

  get count() { return this.pages ? this.pages.length : 1; }
  get thumbRatio() { return this.pageH / this.natural; }

  refit() {
    if (!this.host) return;
    const before = this.scrollRatio();
    const free = this.free();
    const byWidth = free.w / this.natural;
    const fit = this.view.fit === 'width' ? byWidth : Math.min(byWidth, free.h / (this.pageH + 24));
    this.host.style.zoom = Math.min(fit, 3) * this.view.zoom;
    this.stage.scrollTop = before * (this.stage.scrollHeight - this.stage.clientHeight);
    this.onChange();
  }

  // Which page is at the top of the screen right now
  currentIndex() {
    if (!this.pages || this.pages.length < 2) return 0;
    const edge = this.stage.getBoundingClientRect().top + this.stage.clientHeight * 0.35;
    let current = 0;
    this.pages.forEach((p, i) => { if (p.getBoundingClientRect().top <= edge) current = i; });
    return current;
  }

  label() {
    return this.pages.length > 1
      ? 'Page ' + (this.currentIndex() + 1) + ' of ' + this.pages.length
      : 'Read ' + Math.round(this.scrollRatio() * 100) + '%';
  }

  goTo(i) {
    const page = this.pages[clamp(i, 0, this.pages.length - 1)];
    if (!page) return;
    // the top bar floats over the stage: stop the page just below it
    const gap = Math.max(8, parseFloat(getComputedStyle(this.content).paddingTop) - 4);
    const top = page.getBoundingClientRect().top - this.stage.getBoundingClientRect().top + this.stage.scrollTop - gap;
    this.stage.scrollTo({ top, behavior: 'auto' });
  }

  async renderThumb(i, el) {
    const pg = this.pages[i];
    if (!pg) return;
    const wrapper = h('div', 'docx-wrapper');
    const clone = pg.sec.cloneNode(true);
    clone.style.cssText += ';margin:' + (-pg.k * pg.pitch) + 'px 0 0 0;box-shadow:none';
    wrapper.appendChild(clone);
    const host = h('div', 'clone-host docx-host');
    host.style.width = this.natural + 'px';
    host.style.height = this.pageH + 'px';
    host.style.overflow = 'hidden';
    host.style.transform = 'scale(' + ((el.clientWidth || 220) / this.natural) + ')';
    host.appendChild(wrapper);
    el.replaceChildren(host);
  }
}

/* ----- Plain text ----- */
class TextViewer extends ScrollViewer {
  async open(file) {
    const LIMIT = 2 * 1024 * 1024;                       // show the first 2 MB at most
    const buffer = await file.slice(0, LIMIT).arrayBuffer();
    this.host = h('div', 'text-host');
    const page = h('div', 'text-page');
    const text = decodeText(buffer, file.size > LIMIT);
    const shown = this.format(text, file.size > LIMIT);       // subclasses may re-format the text (JSON)
    page.textContent = shown.text;
    this.host.appendChild(page);
    if (shown.note) this.host.appendChild(h('div', 'text-note', shown.note));
    else if (file.size > LIMIT) this.host.appendChild(h('div', 'text-note', 'Only the first 2 MB are shown.'));
    this.content.replaceChildren(this.host);
    this.listenScroll();
    this.refit();
  }
  format(text) { return { text, note: '' }; }
  refit() {
    if (!this.host) return;
    const before = this.scrollRatio();
    this.host.style.zoom = this.view.zoom;
    this.stage.scrollTop = before * (this.stage.scrollHeight - this.stage.clientHeight);
    this.onChange();
  }
  label() { return 'Read ' + Math.round(this.scrollRatio() * 100) + '%'; }
}

/* ----- XLSX / CSV: one sheet at a time as a table ----- */
class XlsxViewer extends BaseViewer {
  constructor(...args) { super(...args); this.hasOverview = true; }

  async open(file) {
    await lib('xlsx');
    this.wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    this.names = this.wb.SheetNames;
    this.cur = 0;
    this.show();
  }

  get count() { return this.names.length; }
  get index() { return this.cur; }
  inkAnchor() { return this.host; }
  caption(i) { return this.names[i]; }
  label() { return 'Sheet ' + (this.cur + 1) + ' of ' + this.names.length + ' · ' + this.names[this.cur]; }
  goTo(i) {
    i = clamp(i, 0, this.names.length - 1);
    if (i === this.cur) return;
    this.cur = i;
    this.show();
  }

  show() {
    const ws = this.wb.Sheets[this.names[this.cur]];
    const host = h('div', 'sheet-host');
    this.host = host;
    if (!ws || !ws['!ref']) {
      host.appendChild(h('div', 'sheet-note', 'This sheet is empty.'));
    } else {
      host.appendChild(this.buildTable(ws));
    }
    this.content.replaceChildren(host);
    this.stage.scrollTo(0, 0);
    this.refit();
    this.onChange();
  }

  buildTable(ws) {
    const MAX_ROWS = 2000, MAX_COLS = 80;
    const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
    const rows = all.slice(0, MAX_ROWS);
    let cols = 0;
    for (const r of rows) cols = Math.max(cols, r.length);
    cols = Math.min(cols, MAX_COLS);

    // Merged cells: the top-left cell spans, the others are skipped
    const span = new Map(), covered = new Set();
    for (const m of ws['!merges'] || []) {
      span.set(m.s.r + ':' + m.s.c, { rows: m.e.r - m.s.r + 1, cols: m.e.c - m.s.c + 1 });
      for (let r = m.s.r; r <= m.e.r; r++)
        for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(r + ':' + c);
    }
    // sheet_to_json starts at the first used cell; shift merges accordingly
    const range = XLSX.utils.decode_range(ws['!ref']);
    const dr = range.s.r, dc = range.s.c;

    const letters = (n) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

    const table = h('table', 'sheet');
    const head = h('tr');
    head.appendChild(h('th', 'rn', ''));
    for (let c = 0; c < cols; c++) head.appendChild(h('th', '', letters(c + dc)));
    table.appendChild(head);

    rows.forEach((row, r) => {
      const tr = h('tr');
      tr.appendChild(h('td', 'rn', String(r + 1 + dr)));
      for (let c = 0; c < cols; c++) {
        const key = (r + dr) + ':' + (c + dc);
        if (covered.has(key)) continue;
        const td = h('td', '', row[c] === undefined ? '' : String(row[c]));
        const sp = span.get(key);
        if (sp) { td.rowSpan = sp.rows; td.colSpan = sp.cols; }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });

    const frag = document.createDocumentFragment();
    frag.appendChild(table);
    if (all.length > MAX_ROWS || cols >= MAX_COLS) {
      frag.appendChild(h('div', 'sheet-note', 'Showing the first ' + Math.min(all.length, MAX_ROWS) + ' rows and ' + cols + ' columns.'));
    }
    return frag;
  }

  refit() { if (this.host) this.host.style.zoom = this.view.zoom; }

  async renderThumb(i, el) {
    const ws = this.wb.Sheets[this.names[i]];
    const box = h('div', 'snippet');
    box.appendChild(h('b', '', this.names[i]));
    const ref = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    box.appendChild(document.createTextNode(ref ? (ref.e.r - ref.s.r + 1) + ' rows × ' + (ref.e.c - ref.s.c + 1) + ' columns' : 'Empty'));
    el.replaceChildren(box);
  }
}

// The newer formats (odp, odt, rtf, heic, media, zip, json, epub) add themselves from app/modules/formats.js
const VIEWER_CLASSES = { pdf: PdfViewer, pptx: PptxViewer, docx: DocxViewer, xlsx: XlsxViewer, image: ImageViewer, text: TextViewer };


/* ---------------------------------------------------------------------
   8. THE VIEWER WINDOW
   --------------------------------------------------------------------- */

const V = {
  el: $('viewer'),
  stage: $('stage'),
  content: $('content'),
  entry: null,          // the open file
  driver: null,         // its viewer (PdfViewer, PptxViewer, …)
  view: { zoom: 1, fit: 'page', rot: 0 },
  immersive: false,     // fullscreen mode (bars float and hide)
  idleTimer: null,
  openToken: 0,         // protects against opening file B while file A is still loading
  menuOpen: false,
  overviewOpen: false,
  cover: false,         // black / white screen is showing
  awake: loadPref('fv-awake', '1') === '1',
  wakeLock: null,
  ovObserver: null,
  armed: null,          // "press Next again to open the next file of the queue"
};

async function openViewer(entry) {
  const token = ++V.openToken;
  closeDriver();
  closeMenu();
  closeOverview();
  if (window.Pen) Pen.reset();                 // drawings belong to one opening of one file
  notesReset();
  V.armed = null;
  Link.key = 0;                                 // nothing to present until the file is open
  V.el.classList.remove('is-media');

  V.entry = entry;
  V.openedAt = Date.now();
  V.view = { zoom: 1, fit: 'page', rot: 0 };
  V.stage.classList.remove('zoomed');
  V.el.hidden = false;
  document.body.classList.add('viewing');
  $('vTitle').textContent = entry.name;
  showMessage('Opening…', '', true);
  updateBar();
  V.stage.focus();
  updateWakeLock();

  try {
    if (FORMAT_VIEWERS.has(entry.viewer)) await lib('formats');
    if (token !== V.openToken) return;
    const driver = new VIEWER_CLASSES[entry.viewer](V.content, V.stage, V.view);
    driver.entry = entry;
    V.view.fit = driver.defaultFit;
    driver.onChange = updateBar;
    V.driver = driver;
    V.el.classList.toggle('is-media', driver.isMedia);
    await driver.open(entry.file);
    if (token !== V.openToken) return;
    showMessage('');
    linkFile();
    updateBar();
  } catch (err) {
    if (token !== V.openToken) return;
    console.error(err);
    const locked = err && err.name === 'PasswordException';
    const friendly = err && err.friendly;            // formats.js explains its own problems in plain words
    showMessage(
      friendly ? friendly[0] : locked ? 'This file is password-protected' : 'Could not open this file',
      friendly ? friendly[1] : locked ? 'Protected files can’t be opened here.' :
        'The file may be damaged or saved in an unusual format. Try re-saving it and opening it again.',
      false);
    updateBar();
  }
}

function closeDriver() {
  if (V.driver) { try { V.driver.destroy(); } catch (e) { /* ignore */ } }
  V.driver = null;
}

function closeViewer() {
  V.openToken++;
  setLaser(false);
  closeTimerDialog();
  if (window.Pen) Pen.reset();
  notesReset();
  V.armed = null;
  hideCover();
  closeMenu();
  closeOverview();
  if (isFullscreen() && !pageFull()) exitFullscreen();
  setImmersive(false);
  closeDriver();
  V.entry = null;
  Link.key = 0; linkPush();
  V.el.classList.remove('is-media');
  V.el.hidden = true;
  document.body.classList.remove('viewing');
  updateWakeLock();
  runThumbQueue();
}

function showMessage(title, details, loading) {
  const box = $('vMsg');
  box.hidden = !title;
  box.className = 'vmsg' + (loading ? ' loading' : '');
  box.replaceChildren();
  if (title) box.appendChild(h('div', '', title));
  if (details) box.appendChild(h('small', '', details));
}

// Refreshes the label, progress bar and which buttons are enabled
function updateBar() {
  const d = V.driver;
  const ready = !!d && $('vMsg').hidden;
  $('vPos').textContent = ready ? d.label() : '';

  const p = ready ? d.progress() : 0;
  $('vProgress').style.width = Math.round(p * 100) + '%';
  $('vKnob').style.left = 'calc(14px + (100% - 28px) * ' + p + ')';
  $('vScrub').classList.toggle('disabled', !ready || d.count <= 1 && !(d instanceof ScrollViewer));

  const atStart = !ready || d.atStart();
  const atEnd = !ready || d.atEnd();
  // In the class queue, "next" at the end of a file moves on to the next file, so the button stays usable
  const prevFile = ready && queueNeighbor(-1), nextFile = ready && queueNeighbor(1);
  $('vFirst').disabled = atStart;
  $('vPrev').disabled = $('vSidePrev').disabled = atStart && !prevFile;
  $('vLast').disabled = atEnd;
  $('vNext').disabled = $('vSideNext').disabled = atEnd && !nextFile;
  $('vOverview').disabled = !ready || !d.hasOverview || d.count < 2;
  $('vInk').disabled = !ready || !d.canDraw;
  $('vInk').setAttribute('aria-pressed', String(!!(window.Pen && Pen.on)));
  Marks.refresh();
  notesRefresh();
  $('mPresenter').disabled = !(ready && presentable());
  linkPush();

  // Video / audio: play button, big play button
  const media = ready && d.isMedia;
  $('mPlayIcon').setAttribute('href', media && d.playing ? '#i-pause' : '#i-play');
  $('mPlay').setAttribute('aria-label', media && d.playing ? 'Pause' : 'Play');
  $('mediaBig').hidden = !media || d.playing || !d.hasPicture;      // sound only: the button in the bar is enough
  updateQueueNav();
  if (window.Pen) Pen.sync();

  // “More” menu state
  $('mZoomVal').textContent = Math.round(V.view.zoom * 100) + '%';
  document.querySelectorAll('[data-fit]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.fit === V.view.fit));
    b.disabled = !ready || !d.canFit;
  });
  $('mRotL').disabled = $('mRotR').disabled = !ready || !d.canRotate;
  $('mAwake').setAttribute('aria-pressed', String(V.awake));
}

function navigate(where) {
  const d = V.driver;
  if (!d || !$('vMsg').hidden) return;                // still opening (or could not open): nothing to turn yet
  if (d.isMedia) {                                    // video / audio: Next / Previous = 5 seconds
    if (where === 'next') { d.skip(5); showToast('+5 s'); }
    else if (where === 'prev') { d.skip(-5); showToast('−5 s'); }
    else if (where === 'first') d.skip(-1e9);
    return;
  }
  // Class queue: at the very end (or start) of a file a second press moves to the next (previous) file
  if (((where === 'next' && d.atEnd()) || (where === 'prev' && d.atStart())) && queueEdge(where)) return;
  V.driver.go(where);
}

/* ----- Zoom, fit, rotate ----- */
function applyView() {
  V.stage.classList.toggle('zoomed', V.view.zoom > 1);
  if (V.driver) V.driver.refit();
  updateBar();
}
function setZoom(value) { V.view.zoom = clamp(value, 0.25, 4); applyView(); }
function setFit(fit) { V.view.fit = fit; V.view.zoom = 1; applyView(); }
function rotate(dir) { V.view.rot = (V.view.rot + dir * 90 + 360) % 360; applyView(); }

let toastTimer = null;
function showToast(text, ms) {
  if (!text) return;
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || 1200);
}

/* ----- Fullscreen ----- */
function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (fn) { try { Promise.resolve(fn.call(document)).catch(() => {}); } catch (e) { /* ignore */ } }
}
// The whole page in fullscreen (Settings → "Fullscreen window"): no browser bars, on the file list and in the viewer
const pageFull = () => (document.fullscreenElement || document.webkitFullscreenElement) === document.documentElement;
async function togglePageFullscreen() {
  if (pageFull()) { exitFullscreen(); return; }
  const root = document.documentElement, request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!request) return;
  try { await request.call(root); } catch (e) { /* the browser said no */ }
}
function syncFullUI() {
  const can = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  for (const id of ['sFull', 'mFull']) { $(id).hidden = !can; $(id).setAttribute('aria-pressed', String(pageFull())); }
}
async function toggleFullscreen() {
  if (isFullscreen() && !pageFull()) { exitFullscreen(); return; }
  if (V.immersive) { setImmersive(false); return; }       // the "fake" fullscreen (browser refused the real one)
  if (pageFull()) { setImmersive(true); return; }         // the window is already full: only hide the bars
  const request = V.el.requestFullscreen || V.el.webkitRequestFullscreen;
  if (!request) { setImmersive(true); return; }
  try { await request.call(V.el); }                        // then fullscreenchange fires
  catch (e) { setImmersive(true); }
}
function onFullscreenChange() {
  syncFullUI();
  if (pageFull()) return;                                 // the whole page went full: the viewer's bars stay as they are
  setImmersive(isFullscreen());
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
$('sFull').onclick = togglePageFullscreen;
$('mFull').onclick = () => { closeMenu(); togglePageFullscreen(); };
syncFullUI();

// "Immersive": the page fills the screen, the bars float on top and hide after a few seconds
function setImmersive(on) {
  if (on === V.immersive) return;
  V.immersive = on;
  V.el.classList.toggle('immersive', on);
  $('vFullIcon').setAttribute('href', on ? '#i-exitfull' : '#i-full');
  $('vFullText').textContent = on ? 'Exit fullscreen' : 'Fullscreen';
  $('vFull').title = on ? 'Exit fullscreen (F or Esc)' : 'Fullscreen (F)';
  if (on) showUi(); else { clearTimeout(V.idleTimer); V.el.classList.remove('ui-hidden'); }
}
function showUi() {
  V.el.classList.remove('ui-hidden');
  clearTimeout(V.idleTimer);
  if (V.immersive) {
    V.idleTimer = setTimeout(() => {
      if (!V.menuOpen && !V.overviewOpen) V.el.classList.add('ui-hidden');
    }, 3500);
  }
}
function toggleUi() {
  if (V.el.classList.contains('ui-hidden')) showUi();
  else { clearTimeout(V.idleTimer); V.el.classList.add('ui-hidden'); }
}

/* ----- Overview (grid of all slides / pages) ----- */
function openOverview() {
  const d = V.driver;
  if (!d || !d.hasOverview || d.count < 2 || V.overviewOpen) return;
  closeMenu();
  V.overviewOpen = true;
  $('overview').hidden = false;
  $('vOverview').setAttribute('aria-expanded', 'true');
  showUi();

  const grid = $('ovGrid');
  grid.replaceChildren();
  const current = d.currentIndex();
  const cells = [];
  V.ovObserver = new IntersectionObserver((items) => {
    for (const item of items) {
      if (!item.isIntersecting) continue;
      V.ovObserver.unobserve(item.target);
      if (V.driver) V.driver.renderThumb(Number(item.target.dataset.i), item.target);   // drawn one by one as they scroll into view
    }
  }, { root: $('overview'), rootMargin: '400px' });

  for (let i = 0; i < d.count; i++) {
    const cell = h('button', 'ov-cell' + (i === current ? ' current' : ''));
    cell.type = 'button';
    const thumb = h('span', 'ov-thumb');
    thumb.dataset.i = i;
    thumb.style.aspectRatio = '1 / ' + d.thumbRatio;
    cell.append(thumb, h('span', 'ov-cap', d.caption(i)));
    if (Marks.has(i)) cell.classList.add('marked');
    cell.onclick = () => { closeOverview(); V.driver.goTo(i); };
    grid.appendChild(cell);
    cells.push(cell);
    V.ovObserver.observe(thumb);
  }
  if (cells[current]) cells[current].scrollIntoView({ block: 'center' });
}
function closeOverview() {
  if (!V.overviewOpen) return;
  V.overviewOpen = false;
  $('overview').hidden = true;
  $('vOverview').removeAttribute('aria-expanded');
  if (V.ovObserver) { V.ovObserver.disconnect(); V.ovObserver = null; }
  $('ovGrid').replaceChildren();
  showUi();
}

/* ----- “More” menu ----- */
function openMenu() {
  closeOverview();
  V.menuOpen = true;
  $('vMenu').hidden = false;
  $('vMore').setAttribute('aria-expanded', 'true');
  showUi();
}
function closeMenu() {
  V.menuOpen = false;
  $('vMenu').hidden = true;
  $('vMore').removeAttribute('aria-expanded');
  showUi();
}
$('vMore').onclick = () => (V.menuOpen ? closeMenu() : openMenu());
document.addEventListener('pointerdown', (e) => {
  if (V.menuOpen && !e.target.closest('#vMenu, #vMore')) closeMenu();
});

/* ----- Black / white screen (hides the slide, like B and W in PowerPoint) ----- */
function showCover(white) {
  closeMenu();
  closeOverview();
  $('cover').className = 'cover' + (white ? ' white' : '');
  $('cover').hidden = false;
  V.cover = true;
}
function hideCover() {
  $('cover').hidden = true;
  V.cover = false;
}
$('cover').addEventListener('pointerdown', (e) => { e.stopPropagation(); hideCover(); });

/* ----- Keep the screen awake while a file is open ----- */
async function updateWakeLock() {
  const want = V.awake && !V.el.hidden && document.visibilityState === 'visible';
  try {
    if (want && !V.wakeLock && navigator.wakeLock) {
      V.wakeLock = await navigator.wakeLock.request('screen');
      V.wakeLock.addEventListener('release', () => { V.wakeLock = null; });
    } else if (!want && V.wakeLock) {
      await V.wakeLock.release();
      V.wakeLock = null;
    }
  } catch (err) { /* the browser said no — nothing to do */ }
}
document.addEventListener('visibilitychange', updateWakeLock);
if (!navigator.wakeLock) {
  $('mAwake').disabled = true;
  $('mAwakeText').textContent = 'Keep screen on (not supported here)';
}

/* ----- Buttons ----- */
// After any click the page gets the focus back, so Space and arrows keep turning pages
V.el.addEventListener('click', (e) => { if (e.target.closest('button')) V.stage.focus(); });
$('vClose').onclick = closeViewer;
$('vFull').onclick = toggleFullscreen;
$('vFirst').onclick = () => navigate('first');
$('vPrev').onclick = $('vSidePrev').onclick = () => navigate('prev');
$('vNext').onclick = $('vSideNext').onclick = () => navigate('next');
$('vLast').onclick = () => navigate('last');
$('vOverview').onclick = () => (V.overviewOpen ? closeOverview() : openOverview());
$('qPrev').onclick = () => queueStep(-1);
$('qNext').onclick = () => queueStep(1);
$('mPlay').onclick = $('mediaBig').onclick = () => { if (V.driver && V.driver.isMedia) V.driver.toggle(); };
$('mBack').onclick = () => navigate('prev');
$('mFwd').onclick = () => navigate('next');

/* ----- Pen and marker (the code lives in app/modules/ink.js and loads on first use) ----- */
async function toggleInk() {
  if (Laser.on) setLaser(false);               // the pen and the laser pointer don't mix
  if (window.Pen) { Pen.toggle(); return; }
  if (!V.driver || !V.driver.canDraw) return;
  try { await lib('ink'); Pen.toggle(); }
  catch (err) { console.warn(err); showToast('Could not load the pen tools'); }
}
$('vInk').onclick = toggleInk;

/* ----- Laser pointer: a red dot that follows the mouse (or a finger on a touch screen). Nothing is drawn ----- */
const Laser = { on: false, dot: $('laserDot'), trail: $('laserTrail'), pts: [], raf: 0 };
const TRAIL_MS = 450;                   // how long the trail lives
function setLaser(on) {
  on = !!on;
  if (on === Laser.on) return;
  if (on && window.Pen && Pen.on) Pen.toggle();
  Laser.on = on;
  V.el.classList.toggle('laser-on', on);
  $('mLaser').setAttribute('aria-pressed', String(on));
  Laser.trail.hidden = !on;
  if (!on) { Laser.dot.hidden = true; Laser.pts.length = 0; }
  showToast(on ? 'Laser pointer on' : 'Laser pointer off');
}
function laserAim(e) {
  if (!Laser.on) return;
  // the dot is only for the page: not over the bars, the menu, the notes, the overview or a dialog
  if (e.target.closest && e.target.closest('.vbar, .menu, .notes, .overview, .modal, .timer-pill')) { Laser.dot.hidden = true; return; }
  Laser.dot.hidden = false;
  Laser.dot.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
  Laser.pts.push({ x: e.clientX, y: e.clientY, t: performance.now(), start: e.type === 'pointerdown' });
  if (Laser.pts.length > 80) Laser.pts.shift();
  if (!Laser.raf) Laser.raf = requestAnimationFrame(laserDraw);
}
// The trail: short line segments that get thinner and fainter with age, then disappear
function laserDraw() {
  Laser.raf = 0;
  const c = Laser.trail, dpr = window.devicePixelRatio || 1, W = window.innerWidth, H = window.innerHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const now = performance.now(), pts = Laser.pts;
  while (pts.length && now - pts[0].t > TRAIL_MS) pts.shift();
  g.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].start) continue;                                  // a new touch does not connect to the previous one
    const k = 1 - (now - pts[i].t) / TRAIL_MS;                   // 1 = fresh, 0 = gone
    g.strokeStyle = 'rgba(255,45,32,' + (k * 0.55).toFixed(3) + ')';
    g.lineWidth = 1 + 3 * k;
    g.beginPath(); g.moveTo(pts[i - 1].x, pts[i - 1].y); g.lineTo(pts[i].x, pts[i].y); g.stroke();
  }
  if (pts.length) Laser.raf = requestAnimationFrame(laserDraw);
}
function laserLose(e) { if (Laser.on && (e.type === 'pointerleave' || e.pointerType !== 'mouse')) Laser.dot.hidden = true; }
V.el.addEventListener('pointermove', laserAim);
V.el.addEventListener('pointerdown', laserAim);
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => V.el.addEventListener(ev, laserLose));
$('mLaser').onclick = () => { closeMenu(); setLaser(!Laser.on); };

/* ----- Timer: no sounds. It only shows the time and turns red when the time is reached.
   "down" counts from the set time to 00:00; "up" counts from 00:00 to the set time.
   After that it keeps going (red), so the speaker sees how far over they are. ----- */
const Timer = {
  active: false, running: false,
  mode: 'down',
  total: 0,                     // the set time, ms
  before: 0, since: 0,          // time counted before the last start, and when the last start was
  set: [0, 7, 0],               // hours, minutes, seconds in the dialog (remembered)
  tick: 0,
};
const TIMER_MAX = [23, 59, 59];
const pad2 = (n) => String(n).padStart(2, '0');
(function loadTimerPref() {
  const p = loadPref('fv-timer', '').split(',');           // "down,0,7,0"
  const n = p.slice(1).map(Number);
  if (p.length === 4 && (p[0] === 'down' || p[0] === 'up') && n.every((x, i) => Number.isInteger(x) && x >= 0 && x <= TIMER_MAX[i])) {
    Timer.mode = p[0]; Timer.set = n;
  }
})();

// Time is counted from the clock (Date.now), so the presenter window and the companion window show the same seconds
const timerElapsed = () => Timer.before + (Timer.running ? Date.now() - Timer.since : 0);
function timerReadout() {
  const el = timerElapsed(), reached = el >= Timer.total;
  const secs = Timer.mode === 'up' ? Math.floor(el / 1000)
    : reached ? Math.floor((el - Timer.total) / 1000) : Math.ceil((Timer.total - el) / 1000);
  const sign = Timer.mode === 'down' && reached && secs > 0 ? '−' : '';     // below zero: −00:12
  const long = Timer.total >= 3600000 || secs >= 3600;
  const text = sign + (long ? Math.floor(secs / 3600) + ':' : '') + pad2(Math.floor(secs / 60) % 60) + ':' + pad2(secs % 60);
  return { text, reached };
}
function timerTick() {
  const r = Timer.active ? timerReadout() : null;
  document.querySelectorAll('.timer-pill').forEach((p) => {       // one in the viewer's top bar, one in the file list's header
    p.hidden = !Timer.active;
    if (!r) return;
    const t = p.querySelector('.tp-text');
    if (t.textContent !== r.text) t.textContent = r.text;
    p.classList.toggle('over', r.reached);
    p.classList.toggle('paused', !Timer.running);
  });
  const live = $('timerLive');
  if (live && r) { live.textContent = r.text; live.classList.toggle('over', r.reached); }
}
function timerRun(on) {
  clearInterval(Timer.tick);
  if (on) Timer.tick = setInterval(timerTick, 200);
}
function timerStart(h, m, s) {
  Timer.total = ((h * 60 + m) * 60 + s) * 1000;
  Timer.before = 0; Timer.since = Date.now();
  Timer.active = Timer.running = true;
  timerRun(true); timerTick(); timerShare();
}
function timerTogglePause() {
  if (Timer.running) { Timer.before = timerElapsed(); Timer.running = false; timerRun(false); }
  else { Timer.since = Date.now(); Timer.running = true; timerRun(true); }
  timerTick(); timerShare();
}
function timerStop() { Timer.active = Timer.running = false; timerRun(false); timerTick(); timerShare(); }

// The two linked windows share one timer: whoever changes it tells the other (see "Presenter view" below)
function timerState() { return { active: Timer.active, running: Timer.running, mode: Timer.mode, total: Timer.total, before: Timer.before, since: Timer.since }; }
function timerShare() { Link.send({ t: 'timer', s: timerState() }); }
function timerApply(s) {
  if (!s) return;
  const was = Timer.active;
  Object.assign(Timer, { active: !!s.active, running: !!s.running, mode: s.mode === 'up' ? 'up' : 'down', total: +s.total || 0, before: +s.before || 0, since: +s.since || 0 });
  timerRun(Timer.running); timerTick();
  if (was !== Timer.active && timerDialogOpen()) TD.body.replaceChildren(Timer.active ? timerRunningView() : timerSetupView());
}

/* The timer window (its own little dialog inside the viewer, so it also works in fullscreen) */
const TD = { el: $('timerDlg'), body: $('timerBody'), onEnter: null };
const timerDialogOpen = () => !TD.el.hidden;
function closeTimerDialog() {
  if (TD.el.hidden) return;
  TD.el.hidden = true;
  TD.onEnter = null;
  setTimeout(() => { if (TD.el.hidden) TD.body.replaceChildren(); }, 260);
  if (!V.el.hidden) showUi();
}
function openTimerDialog() {
  const host = V.el.hidden ? document.body : V.el;               // the window also opens from the file list
  if (TD.el.parentNode !== host) host.appendChild(TD.el);
  if (!V.el.hidden) { closeMenu(); closeOverview(); }
  TD.body.replaceChildren(Timer.active ? timerRunningView() : timerSetupView());
  TD.el.hidden = false;
}
TD.el.addEventListener('pointerdown', (e) => { if (e.target === TD.el) closeTimerDialog(); });
TD.el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });
document.querySelectorAll('.timer-pill').forEach((p) => { p.onclick = openTimerDialog; });
$('mTimer').onclick = openTimerDialog;

function timerSetupView() {
  const box = h('div', 'timer-box');
  box.appendChild(h('h2', 'modal-title', 'Timer'));
  let mode = Timer.mode;
  const vals = Timer.set.slice();
  const inputs = [];
  const nonZero = () => vals[0] > 0 || vals[1] > 0 || vals[2] > 0;

  // The little message under the digits: what the mode does, or "digits only"
  const HINTS = {
    down: 'Counts down from the time you set. Turns red at 00:00.',
    up: 'Counts up from 00:00. Turns red when it reaches the time you set.',
  };
  const hint = h('p', 'timer-hint');
  hint.setAttribute('aria-live', 'polite');
  let hintTimer = 0;
  const say = (text, warn) => {
    clearTimeout(hintTimer);
    hint.textContent = text;
    hint.classList.toggle('warn', !!warn);
    if (warn) hintTimer = setTimeout(() => say(HINTS[mode]), 2200);
  };

  // Countdown / Count up to
  const seg = h('div', 'seg timer-mode');
  const modeButtons = {};
  [['down', 'Countdown'], ['up', 'Count up to']].forEach(([m, label]) => {
    const b = h('button', '', label);
    b.type = 'button';
    b.onclick = () => {
      mode = m;
      for (const k in modeButtons) modeButtons[k].setAttribute('aria-pressed', String(k === mode));
      say(HINTS[mode]);
    };
    modeButtons[m] = b;
    seg.appendChild(b);
  });
  for (const k in modeButtons) modeButtons[k].setAttribute('aria-pressed', String(k === mode));
  box.appendChild(seg);

  const start = h('button', 'btn btn-primary', 'Start');
  start.type = 'button';
  const refresh = () => { start.disabled = !nonZero(); };

  const step = (i, d) => {
    vals[i] = (vals[i] + d + TIMER_MAX[i] + 1) % (TIMER_MAX[i] + 1);
    inputs[i].value = pad2(vals[i]);
    refresh();
  };

  // ▲ / ▼ above and below a field. Held down, they repeat.
  const stepButton = (i, d) => {
    const b = h('button', 'timer-step');
    b.type = 'button';
    b.setAttribute('aria-label', (d > 0 ? 'More ' : 'Less ') + ['hours', 'minutes', 'seconds'][i]);
    b.appendChild(icon(d > 0 ? 'i-chev-up' : 'i-chev'));
    let wait = 0, rep = 0;
    const stop = () => { clearTimeout(wait); clearInterval(rep); };
    b.onpointerdown = () => {
      stop(); step(i, d);
      wait = setTimeout(() => { rep = setInterval(() => step(i, d), 80); }, 450);
    };
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
    b.onclick = (e) => { if (e.detail === 0) step(i, d); };        // Enter / Space on the keyboard (the mouse and fingers act on pointerdown)
    b.oncontextmenu = (e) => e.preventDefault();                    // a long press on a touch screen
    return b;
  };

  // The digits: real text fields, so a phone or tablet shows its number pad
  const field = (i) => {
    const el = h('input', 'timer-input');
    el.type = 'text'; el.inputMode = 'numeric'; el.pattern = '[0-9]*'; el.maxLength = 2;
    el.autocomplete = 'off'; el.spellcheck = false; el.enterKeyHint = 'done';
    el.value = pad2(vals[i]);
    el.setAttribute('aria-label', ['Hours', 'Minutes', 'Seconds'][i]);
    el.onfocus = () => setTimeout(() => { try { el.select(); } catch (e) { /* fine */ } }, 0);
    el.onblur = () => { el.value = pad2(vals[i]); };
    el.onkeydown = (e) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); step(i, 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); step(i, -1); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !/[0-9]/.test(e.key)) {
        e.preventDefault(); say('Digits only (0–9)', true);       // letters, spaces and symbols never get in
      }
    };
    el.oninput = () => {                                           // paste, a phone keyboard…
      const raw = el.value;
      let v = raw.replace(/\D/g, '').slice(0, 2);
      if (v !== raw) say('Digits only (0–9)', true);
      let n = v === '' ? 0 : Number(v);
      if (n > TIMER_MAX[i]) { n = TIMER_MAX[i]; v = String(n); say('The largest value here is ' + n, true); }
      el.value = v;
      vals[i] = n;
      refresh();
      // two digits typed, or a first digit that can't have a second one: move on to the next field
      if (v !== '' && i < 2 && (v.length === 2 || n * 10 > TIMER_MAX[i])) inputs[i + 1].focus();
    };
    inputs.push(el);
    return el;
  };

  // Four rows with the same three columns: labels, ▲, digits, ▼
  const row = (cls) => h('div', 'timer-row ' + cls);
  const labels = row('lab'), ups = row('up'), digits = row('digits'), downs = row('down');
  for (let i = 0; i < 3; i++) {
    if (i) {
      labels.appendChild(h('span')); ups.appendChild(h('span')); downs.appendChild(h('span'));
      digits.appendChild(h('span', 'timer-colon', ':'));
    }
    labels.appendChild(h('span', 'timer-lab', ['h', 'min', 's'][i]));
    ups.appendChild(stepButton(i, 1));
    digits.appendChild(field(i));
    downs.appendChild(stepButton(i, -1));
  }
  box.append(labels, ups, digits, downs, hint);
  say(HINTS[mode]);

  const actions = h('div', 'modal-actions');
  const cancel = h('button', 'btn', 'Close');
  cancel.type = 'button';
  cancel.onclick = closeTimerDialog;
  start.onclick = () => {
    if (!nonZero()) return;
    Timer.mode = mode; Timer.set = vals.slice();
    savePref('fv-timer', [mode, ...vals].join(','));
    timerStart(vals[0], vals[1], vals[2]);
    closeTimerDialog();
  };
  actions.append(cancel, start);
  box.appendChild(actions);
  refresh();
  TD.onEnter = () => start.onclick();
  if (window.matchMedia && matchMedia('(hover: hover)').matches) setTimeout(() => inputs[1].focus(), 60);   // not on a touch screen: the keyboard would pop up
  return box;
}

function timerRunningView() {
  const box = h('div', 'timer-box');
  box.appendChild(h('h2', 'modal-title', 'Timer'));
  const secs = Timer.total / 1000, pad = (n) => pad2(n);
  const target = pad(Math.floor(secs / 3600)) + ':' + pad(Math.floor(secs / 60) % 60) + ':' + pad(secs % 60);
  box.appendChild(h('p', 'timer-hint', Timer.mode === 'down' ? 'Counting down from ' + target : 'Counting up to ' + target));
  const live = h('div', 'timer-live');
  live.id = 'timerLive';
  const r = timerReadout();
  live.textContent = r.text;
  live.classList.toggle('over', r.reached);
  box.appendChild(live);

  const actions = h('div', 'modal-actions');
  const close = h('button', 'btn', 'Close');                      // like every window: the left button only closes it
  close.type = 'button';
  close.onclick = closeTimerDialog;
  const stop = h('button', 'btn', 'Stop');
  stop.type = 'button';
  stop.onclick = () => { timerStop(); closeTimerDialog(); };
  const pause = h('button', 'btn btn-primary', Timer.running ? 'Pause' : 'Resume');
  pause.type = 'button';
  pause.onclick = () => { timerTogglePause(); pause.textContent = Timer.running ? 'Pause' : 'Resume'; };
  actions.append(close, stop, pause);
  box.appendChild(actions);
  TD.onEnter = () => pause.onclick();
  return box;
}

/* ----- Drag to move a zoomed page (mouse; a finger already scrolls by itself) ----- */
let pan = null;
V.stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || e.button !== 0 || Laser.on || V.view.zoom <= 1) return;
  const s = V.stage, r = s.getBoundingClientRect();
  if (e.clientX >= r.left + s.clientWidth || e.clientY >= r.top + s.clientHeight) return;        // that is the scroll bar
  if (s.scrollWidth <= s.clientWidth && s.scrollHeight <= s.clientHeight) return;                // nothing to move
  if (e.target.closest && e.target.closest('a, button, input, select, textarea, video, audio')) return;
  pan = { x: e.clientX, y: e.clientY, left: s.scrollLeft, top: s.scrollTop };
  s.setPointerCapture(e.pointerId);
  s.classList.add('panning');
  e.preventDefault();
});
V.stage.addEventListener('pointermove', (e) => {
  if (!pan) return;
  V.stage.scrollLeft = pan.left - (e.clientX - pan.x);
  V.stage.scrollTop = pan.top - (e.clientY - pan.y);
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) =>
  V.stage.addEventListener(ev, () => { if (pan) { pan = null; V.stage.classList.remove('panning'); } }));

$('mZoomIn').onclick = () => setZoom(V.view.zoom * 1.25);
$('mZoomOut').onclick = () => setZoom(V.view.zoom / 1.25);
$('mZoomVal').onclick = () => setZoom(1);
document.querySelectorAll('[data-fit]').forEach((b) => { b.onclick = () => setFit(b.dataset.fit); });
$('mRotL').onclick = () => rotate(-1);
$('mRotR').onclick = () => rotate(1);
$('mBlack').onclick = () => showCover(false);
$('mAwake').onclick = () => {
  V.awake = !V.awake;
  savePref('fv-awake', V.awake ? '1' : '0');
  updateBar();
  updateWakeLock();
};

/* ----- Progress bar: click or drag to jump ----- */
const scrub = $('vScrub');
let scrubbing = false;
function scrubTo(e) {
  if (!V.driver) return;
  const r = scrub.getBoundingClientRect();
  V.driver.seek(clamp((e.clientX - r.left - 14) / (r.width - 28), 0, 1));
}
scrub.addEventListener('pointerdown', (e) => {
  if (!V.driver) return;
  scrubbing = true;
  scrub.classList.add('dragging');
  scrub.setPointerCapture(e.pointerId);
  scrubTo(e);
  showUi();
});
scrub.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
const endScrub = () => { scrubbing = false; scrub.classList.remove('dragging'); };
scrub.addEventListener('pointerup', endScrub);
scrub.addEventListener('pointercancel', endScrub);

/* ----- Mouse / touch ----- */
V.el.addEventListener('pointermove', (e) => {
  if (!V.immersive || e.pointerType !== 'mouse') return;
  if (Laser.on) {                    // with the laser on, the bars only come back when the mouse goes to the top or bottom edge
    const r = V.el.getBoundingClientRect();
    if (e.clientY - r.top > V.el.querySelector('.vbar-top').offsetHeight && r.bottom - e.clientY > V.el.querySelector('.vbar-bottom').offsetHeight) return;
  }
  showUi();
});
V.el.querySelectorAll('.vbar, .side').forEach((el) =>
  el.addEventListener('pointerdown', () => { if (V.immersive) showUi(); }));

/* ----- Zoom with two fingers, Ctrl + wheel (also a pinch on a trackpad) and a double tap -----
   While the fingers move, the page is only scaled with CSS (smooth). When they lift, the real zoom is set (sharp)
   and the page is scrolled so that the spot under the fingers stays under them. */
const Zoomer = { on: false, f: 1, lastEnd: 0, lastTap: null, token: 0, timer: 0, wheel: 1 };
let pinch = null;
// The page element (a PDF page is a new canvas after every redraw, so it is looked up each time)
const zoomAnchor = () => (V.driver && V.driver.inkAnchor && V.driver.inkAnchor()) || V.content;
function zoomBegin(cx, cy) {
  const anchor = zoomAnchor();
  const r = anchor.getBoundingClientRect(), c = V.content.getBoundingClientRect();
  Object.assign(Zoomer, { on: true, f: 1, cx, cy, w0: Math.round(r.width), fx: (cx - r.left) / (r.width || 1), fy: (cy - r.top) / (r.height || 1), token: Zoomer.token + 1 });
  V.content.style.transformOrigin = (cx - c.left) + 'px ' + (cy - c.top) + 'px';
}
function zoomMove(f) {
  const z = clamp(V.view.zoom * f, 0.25, 4);
  Zoomer.f = z / V.view.zoom;
  V.content.style.transform = 'scale(' + Zoomer.f + ')';
}
function zoomEnd() {
  if (!Zoomer.on) return;
  Zoomer.on = false;
  V.content.style.transform = ''; V.content.style.transformOrigin = '';
  if (Math.abs(Zoomer.f - 1) < 0.01) return;
  const { fx, fy, cx, cy, token, w0 } = Zoomer;
  setZoom(V.view.zoom * Zoomer.f);
  // The page may take a moment to redraw (PDF): keep the spot under the fingers until the new size has arrived and stopped changing
  let last = -1, still = 0, n = 0;
  const settle = () => {
    if (token !== Zoomer.token) return;
    const r = zoomAnchor().getBoundingClientRect(), w = Math.round(r.width);
    if (w > 0) {
      V.stage.scrollLeft += r.left + fx * r.width - cx;
      V.stage.scrollTop += r.top + fy * r.height - cy;
      still = w === last ? still + 1 : 0;
      last = w;
    }
    if (++n < 75 && !(still >= 4 && w !== w0)) requestAnimationFrame(settle);
  };
  requestAnimationFrame(settle);
}
function doubleTapZoom(x, y) {
  zoomBegin(x, y);
  zoomMove((V.view.zoom > 1.05 ? 1 : 1.5) / V.view.zoom);
  zoomEnd();
}
V.stage.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2 || Laser.on || (window.Pen && Pen.on)) return;
  const [a, b] = e.touches;
  pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 };
  zoomBegin((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
}, { passive: true });
V.stage.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  zoomMove(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d);
}, { passive: false });
['touchend', 'touchcancel'].forEach((ev) => V.stage.addEventListener(ev, (e) => {
  if (!pinch || e.touches.length >= 2) return;
  pinch = null; Zoomer.lastEnd = Date.now(); zoomEnd();
}));
V.stage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || Laser.on) return;
  e.preventDefault();                                     // no zoom of the whole browser page
  if (!Zoomer.on) { Zoomer.wheel = 1; zoomBegin(e.clientX, e.clientY); }
  const dy = clamp(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, -30, 30);
  Zoomer.wheel *= Math.exp(-dy * 0.01);
  zoomMove(Zoomer.wheel);
  clearTimeout(Zoomer.timer);
  Zoomer.timer = setTimeout(zoomEnd, 180);
}, { passive: false });
// A double click that has just opened the file must not select the text of the slide under the mouse
V.stage.addEventListener('mousedown', (e) => { if (Date.now() - (V.openedAt || 0) < 600) e.preventDefault(); });

// Taps: edges turn pages, the middle shows/hides the bars; a swipe turns pages too
let pointerStart = null;
V.stage.addEventListener('pointerdown', (e) => { pointerStart = { x: e.clientX, y: e.clientY, time: Date.now() }; });
V.stage.addEventListener('pointercancel', () => { pointerStart = null; });
V.stage.addEventListener('pointerup', (e) => {
  if (!pointerStart) return;
  const dx = e.clientX - pointerStart.x;
  const dy = e.clientY - pointerStart.y;
  const quick = Date.now() - pointerStart.time < 600;
  pointerStart = null;
  const touch = e.pointerType !== 'mouse';
  if (Laser.on && touch) return;           // a finger is the laser: no swipes or edge taps
  if (pinch || Date.now() - Zoomer.lastEnd < 400) return;     // the end of a pinch is not a tap
  const pageBased = V.driver && !(V.driver instanceof ScrollViewer) && !V.driver.isMedia;

  if (touch && pageBased && V.view.zoom <= 1 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    navigate(dx < 0 ? 'next' : 'prev');
    return;
  }
  if (!quick || Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
  if (V.driver && V.driver.isMedia) {       // video / audio: edges = 5 seconds, the middle = play / pause
    const mx = (e.clientX - V.stage.getBoundingClientRect().left) / V.stage.getBoundingClientRect().width;
    if (mx < 0.22 && (touch || V.immersive)) navigate('prev');
    else if (mx > 0.78 && (touch || V.immersive)) navigate('next');
    else { V.driver.toggle(); showUi(); }
    return;
  }
  if (!V.immersive && !touch) return;      // with a mouse in a normal window it's just a click on the content
  const rect = V.stage.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  if (touch && x >= 0.22 && x <= 0.78) {                    // two quick taps in the middle: zoom in, or back to normal
    const now = Date.now(), L = Zoomer.lastTap;
    if (L && now - L.t < 320 && Math.hypot(e.clientX - L.x, e.clientY - L.y) < 40) {
      Zoomer.lastTap = null;
      if (V.immersive) toggleUi();                           // the first tap flipped the bars: put them back
      doubleTapZoom(e.clientX, e.clientY);
      return;
    }
    Zoomer.lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
  if (x < 0.22) navigate('prev');
  else if (x > 0.78) navigate('next');
  else if (V.immersive) toggleUi();
});

// The bars float over the page (so the glass has something to blur): tell the CSS how tall they are
let barTimer = null;
const barObserver = new ResizeObserver(() => {
  const top = V.el.querySelector('.vbar-top'), bottom = V.el.querySelector('.vbar-bottom');
  V.el.style.setProperty('--bt', top.offsetHeight + 'px');
  V.el.style.setProperty('--bb', bottom.offsetHeight + 'px');
  clearTimeout(barTimer);
  barTimer = setTimeout(() => { if (V.driver && !V.el.hidden) { V.driver.refit(); if (window.Pen) Pen.redraw(); } }, 120);
});
V.el.querySelectorAll('.vbar').forEach((b) => barObserver.observe(b));

// Window got resized (rotation, fullscreen…) — fit the content again
let lastSize = '', resizeTimer = null;
new ResizeObserver(() => {
  const size = V.stage.clientWidth + 'x' + V.stage.clientHeight;
  if (size === lastSize) return;
  lastSize = size;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (V.driver && !V.el.hidden) { V.driver.refit(); if (window.Pen) Pen.redraw(); } }, 120);
}).observe(V.stage);

/* ----- Keyboard (letters use e.code, so they work on any keyboard layout) ----- */
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+Z undoes the last pen stroke
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.altKey && !V.el.hidden && window.Pen && Pen.on) {
    e.preventDefault(); if (e.shiftKey) Pen.redo(); else Pen.undo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY' && !V.el.hidden && window.Pen && Pen.on) {
    e.preventDefault(); Pen.redo(); return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  /* the timer window (on any screen): Esc closes, Enter = its main button, the rest is typing */
  if (timerDialogOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeTimerDialog(); }
    else if (e.key === 'Enter' && TD.onEnter && !(e.target.closest && e.target.closest('button'))) { e.preventDefault(); TD.onEnter(); }
    return;
  }

  /* a dialog is open */
  if (!M.el.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    else if (e.key === 'Enter' && M.onEnter && !(e.target.closest && e.target.closest('.q-btn'))) { e.preventDefault(); M.onEnter(); }
    else if (e.key === ' ' && M.spaceCloses) { e.preventDefault(); closeModal(); }
    return;
  }

  /* viewer is open */
  if (!V.el.hidden) {
    const act = (fn) => { e.preventDefault(); fn(); };


    if (V.cover) return act(hideCover);                       // any key brings the slide back

    if (e.key === 'Escape') {
      if (V.menuOpen) return act(closeMenu);
      if (V.overviewOpen) return act(closeOverview);
      if (Laser.on) return act(() => setLaser(false));
      if (window.Pen && Pen.on) return act(() => Pen.toggle());
      if (Notes.open) return act(() => notesToggle(false));
      // In real fullscreen the browser handles Esc itself; the fake one we handle
      return act(() => (V.immersive ? setImmersive(false) : closeViewer()));
    }
    if (e.code === 'KeyG') return act(() => (V.overviewOpen ? closeOverview() : openOverview()));
    if (V.overviewOpen) return;                               // overview: only click, Esc or G

    if (Link.role === 'companion') {
      // Companion window: up / down (and a clicker's Page keys) turn the slides of the presentation; left / right stay with this document
      if (e.key === 'ArrowDown' || e.key === 'PageDown') return act(() => linkCmd('next'));
      if (e.key === 'ArrowUp' || e.key === 'PageUp') return act(() => linkCmd('prev'));
      if (['KeyL', 'KeyD', 'KeyB', 'KeyW', 'KeyN', 'KeyP'].includes(e.code)) return;     // these belong to the presentation window
    } else if (e.code === 'KeyP') return act(presenterStart);

    // Class queue: [ and ] (or Shift + arrows) move between the files of the queue
    if (e.code === 'BracketLeft' || (e.shiftKey && e.key === 'ArrowLeft'))  return act(() => queueStep(-1));
    if (e.code === 'BracketRight' || (e.shiftKey && e.key === 'ArrowRight')) return act(() => queueStep(1));

    if (e.code === 'KeyL') return act(() => setLaser(!Laser.on));
    if (e.code === 'KeyT') return act(openTimerDialog);

    // Video / audio: Space plays or pauses, the arrows jump 5 seconds, nothing else
    if (V.driver && V.driver.isMedia) {
      switch (e.key) {
        case ' ': case 'Enter':   return act(() => { V.driver.toggle(); showUi(); });
        case 'ArrowRight': case 'PageDown': return act(() => navigate('next'));
        case 'ArrowLeft':  case 'PageUp':   return act(() => navigate('prev'));
        case 'Home': return act(() => navigate('first'));
      }
      if (e.code === 'KeyF') return act(toggleFullscreen);
      return;
    }

    if (e.code === 'KeyD') return act(toggleInk);
    if (e.code === 'KeyM') return act(() => Marks.toggle());
    if (e.code === 'Comma') return act(() => Marks.jump(-1));
    if (e.code === 'Period') return act(() => Marks.jump(1));
    if (e.code === 'KeyN') return act(() => notesToggle());
    if (window.Pen && Pen.on) {                               // 1 / 2 / 3 choose pen, marker, eraser
      if (e.key === '1') return act(() => Pen.setTool('pen'));
      if (e.key === '2') return act(() => Pen.setTool('marker'));
      if (e.key === '3') return act(() => Pen.setTool('eraser'));
    }

    const pageBased = V.driver && !(V.driver instanceof ScrollViewer);
    switch (e.key) {
      case 'ArrowRight': case 'PageDown': case ' ': case 'Enter':
        return act(() => navigate('next'));
      case 'ArrowLeft': case 'PageUp': case 'Backspace':
        return act(() => navigate('prev'));
      case 'ArrowDown':
        if (pageBased && V.view.zoom <= 1 && V.view.fit === 'page') act(() => navigate('next'));
        return;
      case 'ArrowUp':
        if (pageBased && V.view.zoom <= 1 && V.view.fit === 'page') act(() => navigate('prev'));
        return;
      case 'Home': return act(() => navigate('first'));
      case 'End':  return act(() => navigate('last'));
      case '+': case '=': return act(() => setZoom(V.view.zoom * 1.25));
      case '-': case '_': return act(() => setZoom(V.view.zoom / 1.25));
      case '0':           return act(() => setZoom(1));
    }
    if (e.code === 'KeyF') return act(toggleFullscreen);
    if (e.code === 'KeyB') return act(() => showCover(false));
    if (e.code === 'KeyW') return act(() => showCover(true));
    if (e.code === 'KeyR') return act(() => rotate(e.shiftKey ? -1 : 1));
    return;
  }

  /* file list */
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;   // a focused button acts by itself
  switch (e.key) {
    case 'ArrowRight': e.preventDefault(); return moveSelection(1, 0);
    case 'ArrowLeft':  e.preventDefault(); return moveSelection(-1, 0);
    case 'ArrowDown':  e.preventDefault(); return moveSelection(0, 1);
    case 'ArrowUp':    e.preventDefault(); return moveSelection(0, -1);
    case ' ': {                                  // Space = details (like Quick Look)
      const entry = selectedEntry();
      if (entry) { e.preventDefault(); openInfo(entry); }
      return;
    }
    case 'Enter': {                              // Enter = open the file
      const entry = selectedEntry();
      if (entry) { e.preventDefault(); openViewer(entry); }
      return;
    }
    case '/': e.preventDefault(); $('search').focus(); return;
  }
  if (e.code === 'KeyQ') {                       // Q = add / remove the selected file in the class queue
    const entry = selectedEntry();
    if (entry) { e.preventDefault(); queueToggle(entry); }
  }
});


/* =====================================================================
   Tooltips: small designed hints instead of the browser's plain ones.
   Any element with a title (or an icon-only button with an aria-label) gets one;
   it appears after a short pause (like macOS: about 0.7 s), and the next one right away.
   A title ending in "(Key)" or "(Key or Key)" shows the keys as little keycaps.
   ===================================================================== */
const Tip = (function () {
  const el = $('tip');
  const DELAY = 700, GRACE = 600;
  const canHover = window.matchMedia && matchMedia('(hover: hover)').matches;
  let timer = 0, target = null, visible = false, lastHidden = 0;
  const KEYS = /^(.*?)\s*\(([^()\s]{1,10}(?:\s+or\s+[^()\s]{1,10})*)\)\s*$/;

  function adopt(root) {
    if (!root || root.nodeType !== 1) return;
    const list = root.matches('[title], button[aria-label]') ? [root] : [];
    list.push(...root.querySelectorAll('[title], button[aria-label]'));
    for (const n of list) {
      if (n.classList.contains('card')) continue;                    // the card shows its own name; the browser's hint helps with long names
      const title = n.getAttribute('title');
      if (title) {
        n.dataset.tip = title;
        n.removeAttribute('title');
        if (!n.hasAttribute('aria-label') && !n.textContent.trim()) n.setAttribute('aria-label', title.replace(/\s*\([^()]*\)\s*$/, ''));
      } else if (!n.dataset.tip && !n.textContent.trim() && n.getAttribute('aria-label')) {
        n.dataset.tip = n.getAttribute('aria-label');
      }
    }
  }
  adopt(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') adopt(r.target); else r.addedNodes.forEach(adopt);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  function hide() {
    clearTimeout(timer);
    target = null;
    if (visible) { visible = false; lastHidden = performance.now(); el.classList.remove('show'); el.setAttribute('aria-hidden', 'true'); }
  }
  function show(node, instant) {
    if (!node.isConnected || !node.matches(':hover')) return;
    const raw = node.dataset.tip || '';
    const m = raw.match(KEYS);
    const label = m ? m[1] : raw;
    const keys = m ? m[2].split(/\s+or\s+/) : [];
    if (!keys.length && label.trim().toLowerCase() === node.textContent.trim().toLowerCase()) return;   // the button already says it
    el.replaceChildren(h('span', '', label), ...keys.map((k) => h('kbd', '', k)));
    el.classList.toggle('instant', !!instant);
    const r = node.getBoundingClientRect();
    el.style.left = '0px'; el.style.top = '0px';
    const w = el.offsetWidth, hh = el.offsetHeight;
    let y = r.top - hh - 10, below = false;
    if (y < 8) { y = r.bottom + 10; below = true; }
    el.style.setProperty('--ty', below ? '-4px' : '4px');
    el.style.left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8) + 'px';
    el.style.top = y + 'px';
    visible = true;
    el.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => el.classList.add('show'));
  }

  if (canHover) {
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t === target) return;
      const wasVisible = visible;
      hide();
      if (!t) return;
      target = t;
      const quick = wasVisible || performance.now() - lastHidden < GRACE;     // moving along a row of buttons: no new wait
      timer = setTimeout(() => show(t, quick), quick ? 90 : DELAY);
    }, true);
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) hide(); }, true);
    ['pointerdown', 'keydown', 'wheel', 'scroll', 'blur'].forEach((ev) => window.addEventListener(ev, hide, true));
  }
  return { hide };
})();

/* =====================================================================
   Bookmarks: M marks or unmarks the current page; , and . jump to the previous / next mark.
   Marks are remembered per file (name + size) on this computer; they show on the progress bar
   and in the overview.
   ===================================================================== */
const Marks = (function () {
  let all = {};
  try { all = JSON.parse(localStorage.getItem('fv-marks') || '{}') || {}; } catch (e) { all = {}; }
  let sig = '';
  const key = () => (V.entry ? V.entry.path + '|' + V.entry.size : '');
  const total = (d) => (d.pages && d.pages.length > 1 ? d.pages.length : d.count);
  const usable = () => { const d = V.driver; return !!d && !d.isMedia && $('vMsg').hidden && total(d) > 1; };
  const list = () => all[key()] || [];
  function save() {
    const keys = Object.keys(all);
    if (keys.length > 300) delete all[keys[0]];
    try { localStorage.setItem('fv-marks', JSON.stringify(all)); } catch (e) { /* private window: marks last until the page closes */ }
  }
  function ratio(d, i, n) {                                  // where the mark of page i sits on the progress bar
    if (d instanceof ScrollViewer && d.pages && d.pages[i]) {
      const st = d.stage, room = st.scrollHeight - st.clientHeight;
      const top = d.pages[i].getBoundingClientRect().top - st.getBoundingClientRect().top + st.scrollTop;
      return room > 0 ? clamp(top / room, 0, 1) : 0;
    }
    return n > 1 ? i / (n - 1) : 0;
  }
  function toggle() {
    if (!usable()) { showToast('Bookmarks need a file with pages'); return; }
    const i = V.driver.currentIndex(), k = key(), arr = list().slice();
    const at = arr.indexOf(i);
    if (at >= 0) arr.splice(at, 1); else arr.push(i);
    arr.sort((a, b) => a - b);
    if (arr.length) all[k] = arr; else delete all[k];
    save(); sig = ''; refresh();
    showToast(at >= 0 ? 'Bookmark removed' : 'Bookmarked page ' + (i + 1));
  }
  function jump(dir) {
    if (!usable()) return;
    const cur = V.driver.currentIndex(), arr = list();
    const to = dir > 0 ? arr.find((i) => i > cur) : arr.slice().reverse().find((i) => i < cur);
    if (to === undefined) { showToast(arr.length ? 'No more bookmarks' : 'No bookmarks yet — press M'); return; }
    V.driver.goTo(to);
  }
  function refresh() {
    const ok = usable(), d = V.driver;
    $('vMark').disabled = !ok;
    $('vMark').setAttribute('aria-pressed', String(ok && list().includes(d.currentIndex())));
    const arr = ok ? list() : [];
    const s = key() + '|' + arr.join(',') + '|' + (ok ? total(d) + '|' + V.view.zoom + '|' + V.view.fit + '|' + (d.stage ? d.stage.scrollHeight : 0) : '');
    if (s === sig) return;
    sig = s;
    $('vMarks').replaceChildren(...arr.map((i) => { const t = document.createElement('i'); t.style.left = (ratio(d, i, total(d)) * 100) + '%'; return t; }));
  }
  return { toggle, jump, refresh, has: (i) => list().includes(i) };
})();
$('vMark').onclick = () => Marks.toggle();

/* =====================================================================
   Speaker notes (PPTX and ODP): N opens a side panel with the notes of the slide on screen.
   ===================================================================== */
const Notes = { open: false };
function notesFill() {
  const d = V.driver;
  if (!Notes.open || !d) return;
  const i = d.currentIndex(), text = d.notesFor(i);
  $('notesTitle').textContent = 'Notes · slide ' + (i + 1);
  $('notesBody').textContent = text || 'No notes for this slide.';
  $('notesBody').classList.toggle('empty', !text);
}
function notesRefresh() {
  const d = V.driver, has = !!d && !!d.hasNotes && $('vMsg').hidden;
  $('mNotes').disabled = !has;
  if (Notes.open && !has) notesToggle(false);
  else notesFill();
}
function notesToggle(force) {
  const d = V.driver;
  if (!d || !d.hasNotes) { if (force !== false) showToast('This file has no speaker notes'); return; }
  Notes.open = force === undefined ? !Notes.open : !!force;
  $('notes').hidden = !Notes.open;
  V.el.classList.toggle('notes-open', Notes.open);
  notesFill();
}
function notesReset() {
  Notes.open = false;
  $('notes').hidden = true;
  V.el.classList.remove('notes-open');
}
$('notesClose').onclick = () => notesToggle(false);
$('mNotes').onclick = () => { closeMenu(); notesToggle(); };


/* =====================================================================
   Presenter view: two windows of Lectern that talk to each other (BroadcastChannel: offline, no server).
   - Presenter window ("P" in the More menu): shows the slides, e.g. on the projector. It OWNS the slide number.
   - Companion window: opened by the presenter window. Shows any other file (the speech) and a panel with the current
     and next slide, the notes and the buttons. It never changes the slide itself: it sends a command, the presenter
     window turns the page and reports the new state. So the two windows can't disagree.
   - The companion gets a copy of the file once (a Blob is passed by reference, so it is cheap) and draws its own small
     slides; after that only numbers travel between the windows. The timer is shared both ways.
   Pen, laser, black screen and notes stay in the presenter window only.
   ===================================================================== */
const Link = {
  id: Math.random().toString(36).slice(2, 10),
  role: location.hash === '#companion' ? 'companion' : 'none',     // 'none' | 'presenter' | 'companion'
  ch: null,
  alive: false, peerRole: '', seen: 0, win: null,
  seq: 0, key: 0,           // presenter: the number of the file now shown (0 = nothing to present)
  last: '', resent: 0,
  rem: null,                // companion: the file of the presenter { key, name, viewer, ratio, notes, ready }
  pos: null,                // companion: where the presenter is { key, index, count }
  peek: null,               // companion: draws small slides
  send(msg) {
    if (!this.ch || this.role === 'none') return;
    try { this.ch.postMessage(Object.assign({ from: this.id, role: this.role }, msg)); }
    catch (err) { console.warn('Presenter link: message not sent', err); }
  },
};
try { if ('BroadcastChannel' in window) Link.ch = new BroadcastChannel('lectern-link'); } catch (e) { /* no link then */ }

const presentable = () => !!V.entry && !!V.driver && (V.entry.viewer === 'pdf' || V.entry.viewer === 'pptx') && V.driver.count > 0;

/* ----- Presenter window ----- */
function linkSendFile() {
  const d = V.driver, e = V.entry;
  if (Link.role !== 'presenter' || !Link.key || !d || !e) return;
  Link.send({ t: 'file', key: Link.key, name: e.name, viewer: e.viewer, file: e.file, ratio: d.thumbRatio, notes: d.notes || [] });
}
// A file has finished opening
function linkFile() {
  if (Link.role !== 'presenter') return;
  Link.key = presentable() ? ++Link.seq : 0;
  if (Link.key && Link.alive) linkSendFile();
}
function linkPush(force) {
  if (Link.role !== 'presenter') return;
  const d = V.driver, ok = !!Link.key && !!d && $('vMsg').hidden;
  const s = ok ? { t: 'state', key: Link.key, index: d.currentIndex(), count: d.count } : { t: 'state', key: 0 };
  const sig = JSON.stringify(s);
  if (!force && sig === Link.last) return;
  Link.last = sig;
  Link.send(s);
}
function linkSendAll() { linkSendFile(); linkPush(true); if (Timer.active) timerShare(); }
function presenterStart() {
  if (Link.role === 'companion') return;
  if (!Link.ch) { showToast('Presenter view needs a newer browser'); return; }
  if (!presentable()) { showToast('Presenter view works with PDF and PowerPoint files'); return; }
  closeMenu();
  Link.role = 'presenter';
  if (!Link.key) linkFile();
  if (Link.alive && Link.peerRole === 'companion') {
    try { if (Link.win && !Link.win.closed) Link.win.focus(); } catch (e) { /* fine */ }
    linkSendAll(); linkUi();
    showToast('The companion window is already open');
    return;
  }
  const w = window.open(location.href.split('#')[0] + '#companion', 'lectern-companion', 'popup,width=1180,height=780');
  if (!w) { showToast('The browser blocked the new window — allow pop-ups for this page', 4000); return; }
  Link.win = w;
  linkUi();
  showToast('Drag the companion window to your own screen, then press F here', 5000);
}

/* ----- Companion window ----- */
function linkCmd(c) {
  if (!Link.rem || !Link.rem.key) { showToast('No presentation to control yet'); return; }
  Link.send({ t: 'cmd', key: Link.rem.key, c });
}

async function peekPdf(file) {
  await lib('pdf');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let chain = Promise.resolve();
  return {
    count: doc.numPages,
    draw(i, el, stale) {
      chain = chain.then(async () => {
        if (stale()) return;
        const page = await doc.getPage(i + 1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (el.clientWidth || 340) * Math.min(window.devicePixelRatio || 1, 2) / base.width });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#fff' }).promise;
        if (!stale()) el.replaceChildren(canvas);
      }).catch((err) => console.warn('Slide preview failed:', err));
      return chain;
    },
    destroy() { try { doc.destroy(); } catch (e) { /* fine */ } },
  };
}
async function peekPptx(file, ratio) {
  await lib('pptx');
  const buf = await file.arrayBuffer();
  const W = 1280, H = Math.round(W * (ratio || 9 / 16));
  const host = h('div');
  Object.assign(host.style, { position: 'fixed', left: '-20000px', top: '0', width: W + 'px', height: H + 'px' });
  document.body.appendChild(host);
  const pv = pptxPreview.init(host, { width: W, height: H, mode: 'slide' });
  await pv.load(buf);
  let chain = Promise.resolve();
  return {
    count: pv.slideCount,
    draw(i, el, stale) {
      chain = chain.then(() => {
        if (stale()) return;
        pv.removeCurrentSlide();
        pv.renderSingleSlide(i);
        const src = host.querySelector('.pptx-preview-slide-wrapper');
        if (!src) return;
        const clone = src.cloneNode(true);
        clone.style.cssText += ';position:absolute;left:0;top:0;margin:0';
        const box = h('div', 'clone-host');
        box.style.width = W + 'px'; box.style.height = H + 'px'; box.dataset.w = W;
        box.style.transform = 'scale(' + ((el.clientWidth || 340) / W) + ')';
        box.appendChild(clone);
        el.replaceChildren(box);
      }).catch((err) => console.warn('Slide preview failed:', err));
      return chain;
    },
    destroy() { try { pv.destroy(); } catch (e) { /* fine */ } host.remove(); },
  };
}
async function peekLoad(m) {
  const old = Link.peek; Link.peek = null;
  if (old) old.destroy();
  Link.rem = { key: m.key, name: m.name, viewer: m.viewer, ratio: m.ratio || 0.5625, notes: m.notes || [], ready: false };
  pvRender();
  try {
    const eng = m.viewer === 'pdf' ? await peekPdf(m.file) : await peekPptx(m.file, m.ratio);
    if (!Link.rem || Link.rem.key !== m.key) { eng.destroy(); return; }
    Link.peek = eng; Link.rem.ready = true;
  } catch (err) { console.warn('Presenter view: could not read the file', err); }
  pvRender();
}

// The panel
let pvJob = 0;
function pvRender() {
  if (Link.role !== 'companion') return;
  const rem = Link.rem, pos = Link.pos && rem && Link.pos.key === rem.key ? Link.pos : null;
  const online = Link.alive && Link.peerRole === 'presenter';
  const empty = $('pvEmpty');
  let msg = '';
  if (!online) msg = 'Waiting for the presentation window…';
  else if (Link.pos && !Link.pos.key) msg = 'Open a PDF or PowerPoint file in the presentation window.';
  else if (!pos) msg = 'Loading the presentation…';
  empty.textContent = msg;
  $('pv').classList.toggle('idle', !!msg);
  $('pvTitle').textContent = online && rem && rem.name ? rem.name : 'Presentation';
  if (msg) { pvJob++; return; }

  const i = pos.index, last = pos.count - 1;
  $('pvPos').textContent = (i + 1) + ' / ' + pos.count;
  $('pvPrev').disabled = i <= 0;
  $('pvNextBtn').disabled = i >= last;
  for (const id of ['pvNow', 'pvNext']) $(id).style.setProperty('--r', rem.ratio);
  const text = rem.notes[i] || '';
  const noNotes = !rem.notes.some(Boolean);
  const box = $('pvNotes');
  box.textContent = text || (noNotes ? 'This file has no speaker notes.' : 'No notes for this slide.');
  box.classList.toggle('none', !text);
  box.scrollTop = 0;

  // The small slides
  const job = ++pvJob, eng = Link.peek, stale = () => job !== pvJob;
  $('pvNext').classList.toggle('end', i >= last);
  if (!eng) return;
  eng.draw(i, $('pvNow'), stale);
  if (i < last) eng.draw(i + 1, $('pvNext'), stale); else $('pvNext').replaceChildren();
}
// When the panel changes size, slides drawn as pages of HTML are scaled again
const pvResize = new ResizeObserver((items) => {
  for (const it of items) {
    const box = it.target.querySelector('.clone-host');
    if (box) box.style.transform = 'scale(' + (it.target.clientWidth / Number(box.dataset.w || 1280)) + ')';
  }
});
pvResize.observe($('pvNow'));
pvResize.observe($('pvNext'));
$('pvPrev').onclick = () => linkCmd('prev');
$('pvNextBtn').onclick = $('pvNext').onclick = () => linkCmd('next');

/* ----- Both windows ----- */
function linkStatus() {
  if (Link.role === 'none') return null;
  const here = Link.alive && Link.peerRole === (Link.role === 'companion' ? 'presenter' : 'companion');
  const text = Link.role === 'companion'
    ? (here ? 'Presentation connected' : 'Presentation not found')
    : (here ? 'Companion connected' : 'No companion window');
  return { here, text };
}
function linkUi() {
  const st = linkStatus();
  document.querySelectorAll('.link-pill').forEach((p) => {
    p.hidden = !st;
    if (!st) return;
    p.classList.toggle('off', !st.here);
    p.querySelector('.lp-text').textContent = st.text;
  });
  if (st) {
    $('pvState').classList.toggle('off', !st.here);
    $('pvStateText').textContent = st.here ? 'Connected' : 'Not connected';
  }
  $('mPresenterNote').textContent = Link.role === 'presenter' && st && st.here ? 'On' : '';
  pvRender();
}

function linkReceive(m) {
  if (!m || m.from === Link.id || !m.role) return;
  if (Link.role !== 'none' && m.role === Link.role) return;              // two windows with the same job: ignore each other
  Link.seen = Date.now();
  Link.peerRole = m.role;
  const joined = !Link.alive;
  Link.alive = true;
  if (m.t === 'bye') { Link.alive = false; Link.pos = null; linkUi(); return; }
  if (joined) {
    if (Link.role === 'presenter') linkSendAll();
    else if (Link.role === 'companion') { if (m.t === 'ping') Link.send({ t: 'hello' }); if (Timer.active) timerShare(); }
    linkUi();
  }
  if (Link.role === 'none') return;

  switch (m.t) {
    case 'hello': if (Link.role === 'presenter' && !joined) linkSendAll(); break;
    case 'ping':
      // The companion lacks the file we are showing (it was not ready when we sent it): send it again
      if (Link.role === 'presenter' && Link.key && m.have !== Link.key && Date.now() - Link.resent > 4000) {
        Link.resent = Date.now(); linkSendFile(); linkPush(true);
      }
      break;
    case 'cmd':
      if (Link.role === 'presenter' && m.key === Link.key && Link.key && V.driver && $('vMsg').hidden && ['next', 'prev', 'first', 'last'].includes(m.c)) V.driver.go(m.c);
      break;
    case 'file': if (Link.role === 'companion') peekLoad(m); break;
    case 'state':
      if (Link.role === 'companion') { Link.pos = m; if (!m.key && Link.rem) { Link.rem = null; if (Link.peek) { Link.peek.destroy(); Link.peek = null; } } pvRender(); }
      break;
    case 'timer': timerApply(m.s); break;
  }
}
if (Link.ch) Link.ch.onmessage = (e) => linkReceive(e.data);

setInterval(() => {
  if (Link.role !== 'none') Link.send({ t: 'ping', have: Link.rem ? Link.rem.key : 0 });
  if (Link.alive && Date.now() - Link.seen > 6000) { Link.alive = false; linkUi(); }
}, 1500);
window.addEventListener('pagehide', () => Link.send({ t: 'bye' }));
$('mPresenter').onclick = presenterStart;

if (Link.role === 'companion') {
  document.title = 'Lectern · Companion';
  V.el.classList.add('pv-open');
  $('pv').hidden = false;
  for (const id of ['mPresenter', 'mLaser', 'mBlack', 'mNotes', 'vInk']) $(id).hidden = true;     // these belong to the presentation window
  Link.send({ t: 'hello' });
  linkUi();
}

/* ----- Start ----- */
// After a mouse click a button gives up the focus, so Space / Enter keep working on the selected file
$('home').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });

/* ----- Double-clicking a file in Explorer / Finder (installed app, Chrome/Edge): "Open with Lectern" ----- */
if ('launchQueue' in window) {
  launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const files = [];
    for (const handle of params.files) files.push(await handle.getFile());
    addFiles(files, false);
    if (files.length === 1) {
      const entry = state.files.find((e) => e.file === files[0]) || state.files.find((e) => e.name === files[0].name);
      if (entry) openViewer(entry);                // one file: straight to the viewer
    }
  });
}

syncAppearanceUI();
render();
restoreFolder();
