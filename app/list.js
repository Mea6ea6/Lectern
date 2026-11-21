'use strict';
/* Lectern — The file list, details, the class queue, thumbnails.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, errors.js, list.js, viewers.js, viewer-ui.js, viewer-timer.js, viewer-input.js, extras.js, presenter.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

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

  card.onclick = () => { select(entry.id, false); openCard(entry); };
  info.onclick = (e) => { e.stopPropagation(); select(entry.id, false); openInfo(entry); };

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
  renderRecent();

  const list = visibleFiles();
  $('grid').classList.toggle('no-blur', list.length > 80);   // blur behind hundreds of cards would make scrolling heavy
  $('grid').replaceChildren(...list.map(createCard));
  if (state.cardsEnter) {                                  // only right after files were loaded, not on every filter / search
    state.cardsEnter = false;
    list.forEach((e, i) => e.card.style.setProperty('--i', String(Math.min(i, 14))));
    $('grid').classList.add('enter');
    clearTimeout(render.enterTimer);
    render.enterTimer = setTimeout(() => $('grid').classList.remove('enter'), 1000);
  }
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
  $('status').textContent = text;
}

function renderChips() {
  const present = Object.keys(KINDS).filter((k) => state.files.some((e) => e.kind === k));
  const filters = [{ id: 'all', title: 'All' }, ...present.map((k) => ({ id: k, title: KINDS[k].title }))];
  if (!filters.some((f) => f.id === state.filter)) state.filter = 'all';
  const chips = filters.map((f) => {
    const count = f.id === 'all' ? state.files.length : state.files.filter((e) => e.kind === f.id).length;
    const chip = h('button', 'chip k-' + f.id + (state.filter === f.id ? ' active' : ''), f.title);
    chip.title = f.id === 'all' ? 'Show all files' : 'Show only: ' + f.title;
    chip.type = 'button';
    chip.appendChild(h('b', '', String(count)));
    chip.onclick = () => { state.filter = f.id; render(); };
    return chip;
  });
  $('chips').replaceChildren(...chips);
  $('filterVal').textContent = filters.find((f) => f.id === state.filter).title;
}

// Filter button: the chip row slides open / closed (always closed when the app starts)
function setFiltersOpen(open) {
  $('chipsWrap').classList.toggle('open', open);
  $('chipsWrap').setAttribute('aria-hidden', String(!open));
  $('filterBtn').setAttribute('aria-expanded', String(open));
  $('filterBtn').dataset.tip = open ? 'Hide file types' : 'Show file types';
}
$('filterBtn').onclick = () => setFiltersOpen($('filterBtn').getAttribute('aria-expanded') !== 'true');

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
// Opening a file from the list: the card gives a short bounce, then the viewer opens
function openCard(entry) {
  const card = entry.card;
  if (!card || !card.isConnected) { openViewer(entry); return; }
  if (!card.matches(':hover')) { card.classList.remove('pop'); void card.offsetWidth; card.classList.add('pop'); }   // opened with the keyboard: bounce by hand (a click already bounces through :active)
  setTimeout(() => {
    card.classList.remove('pop');
    V.openFrom = card.isConnected ? card.getBoundingClientRect() : null;     // the viewer grows out of this card
    openViewer(entry);
  }, 120);
}

function markSelected(scroll) {
  for (const card of $('grid').children) {
    const on = Number(card.dataset.id) === state.selectedId;
    card.classList.toggle('selected', on);
    if (on && scroll) card.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
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
  ['settings', 'sortMenu', 'modal', 'viewer', 'overview', 'vMenu', 'cover', 'dropHint', 'inkBar', 'notes', 'timerDlg', 'footer', 'footKeys', 'footStart', 'resume', 'upnext'].forEach((id) => {
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
  skip.title = 'Go straight to the picker next time';
  skip.append(h('span', 'grow', 'Don’t show this again'), h('span', 'switch'));
  skip.onclick = () => skip.setAttribute('aria-pressed', String(skip.getAttribute('aria-pressed') !== 'true'));

  const go = () => {
    if (skip.getAttribute('aria-pressed') === 'true') savePref('fv-folder-hint', '0');
    closeModal();
    openClassicFolderPicker();
  };
  const cancel = h('button', 'btn', 'Cancel');
  cancel.title = 'Cancel';
  cancel.type = 'button';
  cancel.onclick = closeModal;
  const ok = h('button', 'btn btn-primary', 'Continue');
  ok.title = 'Continue to the folder picker';
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
  close.title = 'Close this window (Esc)';
  close.type = 'button';
  close.onclick = closeModal;
  const open = h('button', 'btn btn-primary', 'Open');
  open.title = 'Open this file (Enter)';
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
    if (VIEWER_LIB[entry.viewer]) {
      await lib(VIEWER_LIB[entry.viewer]);
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
const prefersReducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function queueChanged() {
  const place = new Map(Q.items.map((it, i) => [it.entry, i]));
  for (const e of state.files) markQueue(e, place.has(e) ? place.get(e) : -1);   // only cards whose place changed are touched
  $('btnQueue').hidden = !state.files.length && !Q.items.length;
  const countText = Q.items.length ? String(Q.items.length) : '';
  if ($('qCount').textContent !== countText && countText && !prefersReducedMotion()) {       // the number gives a little hop when it changes
    $('qCount').animate([{ scale: 1.4 }, { scale: 1 }], { duration: 260, easing: 'cubic-bezier(.3,1.6,.5,1)' });
  }
  $('qCount').textContent = countText;
  if (!M.el.hidden && M.body.classList.contains('queue-dialog')) renderQueueDialog();
  updateQueueNav();
}

// The little button on a card: "+" when it is not in the queue, its place number when it is
function markQueue(entry, i = queueIndexOf(entry)) {
  if (!entry.card || entry.qMark === i) return;
  entry.qMark = i;
  const btn = entry.card.querySelector('.card-queue');
  entry.card.classList.toggle('queued', i >= 0);
  if (i >= 0) { const num = h('span', 'qn', String(i + 1)), x = icon('i-trash'); x.classList.add('qx'); btn.replaceChildren(num, x); }
  else btn.replaceChildren(icon('i-plus'));
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
    // empty: three faint placeholder rows show what the queue will look like, with one line of help below
    const ghost = h('div', 'q-list q-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    for (let i = 1; i <= 3; i++) {
      const row = h('div', 'q-row');
      const name = h('span', 'q-name');
      name.append(h('i', 'q-bar'), h('i', 'q-bar short'));
      row.append(h('span', 'q-num', String(i)), h('i', 'q-tag'), name);
      ghost.appendChild(row);
    }
    box.appendChild(ghost);
    const hint = h('p', 'modal-text q-hint');
    hint.append('Add files with ', h('b', '', '+'), ' on a card, or press ', h('kbd', '', 'Q'));
    box.appendChild(hint);
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
    const clear = h('button', 'btn q-clear-btn', 'Remove all');
    clear.title = 'Take every file out of the queue';
    clear.type = 'button';
    clear.onclick = () => { Q.items = []; queueChanged(); };
    box.appendChild(h('div', 'q-clear-row')).appendChild(clear);
  }

  const actions = h('div', 'modal-actions');
  const close = h('button', 'btn', 'Close');
  close.title = 'Close this window (Esc)';
  close.type = 'button';
  close.onclick = closeModal;
  actions.append(close);
  if (Q.items.length) {                       // nothing to start when the list is empty
    const start = h('button', 'btn btn-primary', 'Start');
    start.title = 'Start the class queue';
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
      if (VIEWER_LIB[entry.viewer]) {          // the newer formats make their own thumbnails
        await lib(VIEWER_LIB[entry.viewer]);
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

// Shared by every PDF preview (list thumbnail, overview, presenter panel):
// draw one pdf.js page into a new canvas that is `width` pixels wide.
async function pdfCanvas(page, width) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#fff' }).promise;
  return canvas;
}

// Shared by every PPTX preview (overview, presenter panel): copy the slide that the hidden
// previewer `host` has just drawn into a box of the full slide size W x H, scaled down to
// `shownWidth` px. (A scaled copy is far cheaper than re-rendering the slide.)
function slideCopy(host, W, H, shownWidth) {
  const src = host.querySelector('.pptx-preview-slide-wrapper');
  if (!src) return null;
  const clone = src.cloneNode(true);
  clone.style.cssText += ';position:absolute;left:0;top:0;margin:0';
  const box = h('div', 'clone-host');
  box.style.width = W + 'px';
  box.style.height = H + 'px';
  box.dataset.w = W;                       // the panel's resize observer rescales from this
  box.style.transform = 'scale(' + (shownWidth / W) + ')';
  box.appendChild(clone);
  return box;
}

// PDF: draw page 1 into a small canvas
async function thumbPdf(entry) {
  await lib('pdf');
  const data = new Uint8Array(await entry.file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data }).promise;
  entry.pages = doc.numPages;
  entry.thumbNode = await pdfCanvas(await doc.getPage(1), 420);
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


/* ----- Recent files: the last files opened from this folder (remembered with the place; travels with the drive) ----- */
const RECENT_KEY = 'fv-recent', RECENT_SHOW = 4;
function recentTouch(entry) {                       // called when a file is opened
  let map = {};
  try { map = JSON.parse(loadPref(RECENT_KEY, '{}')) || {}; } catch (e) { map = {}; }
  map[posKey(entry)] = { n: entry.name, t: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > 40) keys.sort((a, b) => map[a].t - map[b].t).slice(0, keys.length - 40).forEach((k) => delete map[k]);
  savePref(RECENT_KEY, JSON.stringify(map));
  drivePush();
}
function recentLabel(entry, saved) {                // the second line: where you stopped
  if (!saved || saved.d) return (entry.ext || '').toUpperCase();
  if (entry.kind === 'video' || entry.kind === 'audio') {
    const s = Math.floor(saved.p), m = Math.floor(s / 60);
    return 'At ' + (m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0');
  }
  if (!saved.n) return Math.round(saved.p * 100) + '% read';
  return (entry.kind === 'pptx' ? 'Slide ' : entry.kind === 'xlsx' ? 'Sheet ' : 'Page ') + (saved.p + 1) + ' of ' + saved.n;
}
function renderRecent() {
  const box = $('recent');
  let recent = {}, pos = {};
  try { recent = JSON.parse(loadPref(RECENT_KEY, '{}')) || {}; pos = JSON.parse(loadPref('fv-pos', '{}')) || {}; } catch (e) { /* none */ }
  const byKey = new Map(state.files.map((e) => [posKey(e), e]));
  const items = Object.keys(recent).filter((k) => byKey.has(k) && !recent[k].d).sort((a, b) => recent[b].t - recent[a].t).slice(0, RECENT_SHOW);
  const searching = !!$('search').value.trim();
  box.hidden = !state.files.length || !items.length || searching;
  if (box.hidden) return;
  const hide = loadPref('fv-recent-hide', '0') === '1';
  box.classList.toggle('collapsed', hide);
  $('recentToggle').setAttribute('aria-expanded', String(!hide));
  $('recentToggle').title = hide ? 'Show recent files' : 'Hide recent files';
  $('recentList').replaceChildren(...items.map((k) => {
    const entry = byKey.get(k);
    const b = h('button', 'recent-item');
    b.type = 'button'; b.title = 'Open ' + entry.name;
    b.append(h('b', '', entry.name.replace(/\.[^.]+$/, '')), h('small', '', recentLabel(entry, pos[k])));
    b.onclick = () => openCard(entry);
    return b;
  }));
}
$('recentToggle').onclick = () => { savePref('fv-recent-hide', loadPref('fv-recent-hide', '0') === '1' ? '0' : '1'); renderRecent(); };
