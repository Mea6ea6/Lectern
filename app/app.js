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

// File extension -> what kind of viewer opens it
const EXT_TO_KIND = {
  pptx: 'pptx', ppsx: 'pptx',
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx', xlsm: 'xlsx', xls: 'xlsx', csv: 'xlsx',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', avif: 'image',
  txt: 'text', md: 'text', log: 'text',
};

// Old Office formats can't be opened — we only count them to tell the user
const LEGACY_EXT = ['ppt', 'pps', 'doc'];

const KINDS = {
  pptx:  { order: 1, noun: ['slide', 'slides'],  title: 'Presentations' },
  pdf:   { order: 2, noun: ['page', 'pages'],    title: 'PDF' },
  docx:  { order: 3, noun: null,                 title: 'Documents' },
  xlsx:  { order: 4, noun: ['sheet', 'sheets'],  title: 'Spreadsheets' },
  image: { order: 5, noun: null,                 title: 'Images' },
  text:  { order: 6, noun: null,                 title: 'Text' },
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
};
const scriptLoads = {};
const libLoads = {};
function loadScript(file) {
  if (!scriptLoads[file]) {
    scriptLoads[file] = new Promise((ok, fail) => {
      const el = document.createElement('script');
      el.src = 'app/lib/' + file;
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
  const card = h('div', 'card');
  card.dataset.id = entry.id;
  card.title = entry.name;

  const thumb = h('span', 'thumb');
  thumb.appendChild(h('span', 'tag tag-' + entry.kind, entry.tag));     // format badge, top-right

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
  if (entry.thumbNode) putThumb(entry);
  return card;
}

function render() {
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
}

function renderStatus() {
  if (state.note) { $('status').textContent = state.note; return; }
  if (!state.files.length) { $('status').textContent = 'No files selected'; return; }
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
    const chip = h('button', 'chip' + (state.filter === f.id ? ' active' : ''), f.title);
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
  ['settings', 'sortMenu', 'modal', 'viewer', 'overview', 'vMenu', 'cover', 'dropHint'].forEach((id) => {
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
    if (entry.kind === 'pdf') {
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

    } else if (entry.kind === 'text') {
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
      switch (entry.kind) {
        case 'pdf':   await thumbPdf(entry); break;
        case 'xlsx':  await thumbXlsx(entry); break;
        case 'image': thumbImage(entry); break;
        case 'text':  await thumbText(entry); break;
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
  thumb.replaceChildren(entry.thumbNode, thumb.querySelector('.tag'));   // picture + the badge on top
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
  }

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
    this.drawId = 0;
    const first = await this.doc.getPage(1);
    const v = first.getViewport({ scale: 1 });
    this.ratio = v.height / v.width;
    await this.draw();
  }

  get count() { return this.total; }
  get index() { return this.page - 1; }
  get thumbRatio() { return this.ratio || 1.4; }
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

/* ----- PPTX: one slide at a time ----- */
class PptxViewer extends BoxViewer {
  constructor(...args) { super(...args); this.hasOverview = true; }

  async open(file) {
    await lib('pptx');
    this.buf = await file.arrayBuffer();

    // Slide proportions (16:9, 4:3 …) from presentation.xml
    let ratio = 9 / 16;
    try {
      const zip = await JSZip.loadAsync(this.buf);
      const xml = await zip.file('ppt/presentation.xml').async('string');
      const cx = xml.match(/<p:sldSz[^>]*\scx="(\d+)"/);
      const cy = xml.match(/<p:sldSz[^>]*\scy="(\d+)"/);
      if (cx && cy) ratio = Number(cy[1]) / Number(cx[1]);
    } catch (e) { /* assume 16:9 */ }

    this.setupBox(1280, Math.round(1280 * ratio));
    this.previewer = pptxPreview.init(this.box, { width: this.W, height: this.H, mode: 'slide' });
    await this.previewer.load(this.buf);
    this.total = this.previewer.slideCount;
    this.cur = 0;
    this.show();
    this.refit();
  }

  get count() { return this.total; }
  get index() { return this.cur; }
  get thumbRatio() { return this.H / this.W; }
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

/* ----- DOCX: one long scrolling document ----- */
class DocxViewer extends ScrollViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true; this.hasOverview = true;
    this.defaultFit = 'width';
  }

  async open(file) {
    await lib('docx');
    const buf = await file.arrayBuffer();
    this.host = h('div', 'docx-host');
    this.content.replaceChildren(this.host);
    await docx.renderAsync(buf, this.host, null, {
      className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
    });
    this.pages = Array.from(this.host.querySelectorAll('section.docx'));
    this.natural = Math.max(...this.pages.map((p) => p.offsetWidth), 300);   // page width at 100%
    this.pageH = Math.max(...this.pages.map((p) => p.offsetHeight), 300);
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
    const fit = this.view.fit === 'width' ? byWidth : Math.min(byWidth, free.h / this.pageH);
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
    const src = this.pages[i];
    if (!src) return;
    const wrapper = h('div', 'docx-wrapper');
    const clone = src.cloneNode(true);
    clone.style.cssText += ';margin:0;box-shadow:none';
    wrapper.appendChild(clone);
    const host = h('div', 'clone-host docx-host');
    host.style.width = this.natural + 'px';
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
    page.textContent = decodeText(buffer, file.size > LIMIT);
    this.host.appendChild(page);
    if (file.size > LIMIT) this.host.appendChild(h('div', 'text-note', 'Only the first 2 MB are shown.'));
    this.content.replaceChildren(this.host);
    this.listenScroll();
    this.refit();
  }
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
};

async function openViewer(entry) {
  const token = ++V.openToken;
  closeDriver();
  closeMenu();
  closeOverview();

  V.entry = entry;
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
    const driver = new VIEWER_CLASSES[entry.kind](V.content, V.stage, V.view);
    V.view.fit = driver.defaultFit;
    driver.onChange = updateBar;
    V.driver = driver;
    await driver.open(entry.file);
    if (token !== V.openToken) return;
    showMessage('');
    updateBar();
  } catch (err) {
    if (token !== V.openToken) return;
    console.error(err);
    const locked = err && err.name === 'PasswordException';
    showMessage(
      locked ? 'This file is password-protected' : 'Could not open this file',
      locked ? 'Protected files can’t be opened here.' :
        'The file may be damaged or saved in an unusual format. Try re-saving it and opening it again.',
      false);
  }
}

function closeDriver() {
  if (V.driver) { try { V.driver.destroy(); } catch (e) { /* ignore */ } }
  V.driver = null;
}

function closeViewer() {
  V.openToken++;
  hideCover();
  closeMenu();
  closeOverview();
  if (isFullscreen()) exitFullscreen();
  setImmersive(false);
  closeDriver();
  V.entry = null;
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
  $('vFirst').disabled = $('vPrev').disabled = $('vSidePrev').disabled = atStart;
  $('vNext').disabled = $('vLast').disabled = $('vSideNext').disabled = atEnd;
  $('vOverview').disabled = !ready || !d.hasOverview || d.count < 2;

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
  if (!V.driver) return;
  V.driver.go(where);
  if (V.immersive && V.el.classList.contains('ui-hidden')) {
    setTimeout(() => showToast(V.driver && V.driver.label()), 60);   // bars are hidden — show where we are
  }
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
function showToast(text) {
  if (!text) return;
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
}

/* ----- Fullscreen ----- */
function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (fn) { try { Promise.resolve(fn.call(document)).catch(() => {}); } catch (e) { /* ignore */ } }
}
async function toggleFullscreen() {
  if (isFullscreen()) { exitFullscreen(); return; }
  if (V.immersive) { setImmersive(false); return; }       // the "fake" fullscreen (browser refused the real one)
  const request = V.el.requestFullscreen || V.el.webkitRequestFullscreen;
  if (!request) { setImmersive(true); return; }
  try { await request.call(V.el); }                        // then fullscreenchange fires
  catch (e) { setImmersive(true); }
}
document.addEventListener('fullscreenchange', () => setImmersive(isFullscreen()));
document.addEventListener('webkitfullscreenchange', () => setImmersive(isFullscreen()));

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
V.el.addEventListener('pointermove', (e) => { if (V.immersive && e.pointerType === 'mouse') showUi(); });
V.el.querySelectorAll('.vbar, .side').forEach((el) =>
  el.addEventListener('pointerdown', () => { if (V.immersive) showUi(); }));

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
  const pageBased = V.driver && !(V.driver instanceof ScrollViewer);

  if (touch && pageBased && V.view.zoom <= 1 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    navigate(dx < 0 ? 'next' : 'prev');
    return;
  }
  if (!quick || Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
  if (!V.immersive && !touch) return;      // with a mouse in a normal window it's just a click on the content
  const rect = V.stage.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
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
  barTimer = setTimeout(() => { if (V.driver && !V.el.hidden) V.driver.refit(); }, 120);
});
V.el.querySelectorAll('.vbar').forEach((b) => barObserver.observe(b));

// Window got resized (rotation, fullscreen…) — fit the content again
let lastSize = '', resizeTimer = null;
new ResizeObserver(() => {
  const size = V.stage.clientWidth + 'x' + V.stage.clientHeight;
  if (size === lastSize) return;
  lastSize = size;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (V.driver && !V.el.hidden) V.driver.refit(); }, 120);
}).observe(V.stage);

/* ----- Keyboard (letters use e.code, so they work on any keyboard layout) ----- */
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  /* a dialog is open */
  if (!M.el.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    else if (e.key === 'Enter' && M.onEnter) { e.preventDefault(); M.onEnter(); }
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
      // In real fullscreen the browser handles Esc itself; the fake one we handle
      return act(() => (V.immersive ? setImmersive(false) : closeViewer()));
    }
    if (e.code === 'KeyG') return act(() => (V.overviewOpen ? closeOverview() : openOverview()));
    if (V.overviewOpen) return;                               // overview: only click, Esc or G

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
});

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
