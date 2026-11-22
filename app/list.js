'use strict';
/* Lectern — The file list, details, recent files.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, queue.js, thumbs.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, presenter.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

/* ---------------------------------------------------------------------
   5. THE FILE LIST
   --------------------------------------------------------------------- */

/* ---------------------------------------------------------------------
   Folders and views.  The files keep the folder they were in (entry.dirs); with "Show folders" on, the list shows one
   folder at a time (folders first, then the files) with a path bar above. Two views: icons (cards) and list (rows).
   Searching always looks through everything.
   --------------------------------------------------------------------- */
const VIEWS = ['icons', 'list'];
state.view = VIEWS.includes(loadPref('fv-viewmode', 'icons')) ? loadPref('fv-viewmode', 'icons') : 'icons';
state.folders = loadPref('fv-folders', '1') !== '0';     // "Show folders"
state.path = [];                                          // the folder shown
const FOLDER_IDS = new Map(), FOLDER_BY_ID = new Map();
function folderId(path) {
  let id = FOLDER_IDS.get(path);
  if (!id) { id = -(FOLDER_IDS.size + 1); FOLDER_IDS.set(path, id); FOLDER_BY_ID.set(id, path); }
  return id;
}
const dirSegs = (p) => (p ? p.split('/') : []);
const underDir = (e, segs) => segs.every((s, i) => e.dirs[i] === s);

// Which folder each file is in. A folder picked the classic way (or dropped) has its own name as the first part of every path: that is the root, not a folder.
function computeDirs() {
  const segsOf = (e) => { const p = e.path.split('/'); p.pop(); return p; };
  let strip = 0, rootName = state.handle ? state.folderName : '';
  if (!state.handle && state.files.length) {
    const all = state.files.map(segsOf);
    if (all.every((x) => x.length) && new Set(all.map((x) => x[0])).size === 1) { strip = 1; rootName = all[0][0]; }
  }
  for (const e of state.files) { e.dirs = segsOf(e).slice(strip); e.dir = e.dirs.join('/'); e.rootName = rootName; }
}
const hasFolders = () => state.files.some((e) => e.dirs && e.dirs.length);
const foldersOn = () => state.folders && !state.query.trim() && hasFolders();     // the folder structure is shown (a search is always flat)

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
function sortFiles(list) {
  const sorters = {
    name: byName,
    date: (a, b) => b.modified - a.modified || byName(a, b),
    size: (a, b) => b.size - a.size || byName(a, b),
    type: (a, b) => KINDS[a.kind].order - KINDS[b.kind].order || byName(a, b),
  };
  return list.sort(sorters[state.sort]);
}
// The files that pass the filter and the search
function matchingFiles() {
  const q = state.query.trim().toLowerCase();
  return state.files.filter((e) => (!state.kinds.size || state.kinds.has(e.kind)) && (!q || e.name.toLowerCase().includes(q)));
}
// The content of one folder (dir = 'A/B' or ''): its sub-folders (with the number of matching files inside) and its own files
function listDir(dir, pool) {
  const base = dirSegs(dir), n = base.length, sub = new Map(), files = [];
  for (const e of pool) {
    if (e.dirs.length < n || !underDir(e, base)) continue;
    if (e.dirs.length === n) files.push(e);
    else {
      const name = e.dirs[n], f = sub.get(name) || { name, path: base.concat(name).join('/'), count: 0 };
      f.count++; sub.set(name, f);
    }
  }
  const folders = [...sub.values()].sort(byName).map((f) => ({ ...f, folder: true, id: folderId(f.path) }));
  return { folders, files: sortFiles(files) };
}
// Everything that has to be on the screen in icons / list view (folders first)
function currentItems() {
  const pool = matchingFiles();
  if (!foldersOn()) return sortFiles(pool);
  while (state.path.length && !state.files.some((e) => underDir(e, state.path))) state.path.pop();     // the folder is gone (another folder was chosen)
  const { folders, files } = listDir(state.path.join('/'), pool);
  return [...folders, ...files];
}
const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function folderCount(n) { return n + ' ' + plural(n, ['file', 'files']); }

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
function createFolderCard(f) {
  const card = h('div', 'card card-folder');
  card.dataset.id = f.id;
  card.title = f.name;
  const thumb = h('span', 'thumb');
  thumb.append(icon('i-folder'), h('span', 'folder-count', folderCount(f.count)));
  const foot = h('span', 'card-foot');
  const glyph = h('span', 'card-glyph'); glyph.appendChild(icon('i-folder'));
  foot.append(glyph, h('span', 'card-name', f.name));
  card.append(thumb, foot);
  card.onclick = () => openFolder(f.path);
  return card;
}

// List view: one row per file / folder
function createRow(entry) {
  const row = h('div', 'row card k-' + entry.kind);          // "card" so the queue marks and hover colours work the same
  row.dataset.id = entry.id;
  row.title = entry.name;
  const qb = h('button', 'card-queue');
  qb.type = 'button';
  qb.onclick = (e) => { e.stopPropagation(); queueToggle(entry); };
  const info = h('button', 'card-info');
  info.type = 'button'; info.title = 'Details (Space)'; info.setAttribute('aria-label', 'Details');
  info.appendChild(icon('i-info'));
  const name = h('span', 'row-name');
  name.append(h('b', '', entry.base));
  if (state.query.trim() || !foldersOn()) { const where = whereText(entry, true); if (where) name.append(h('small', '', where)); }
  row.append(qb, h('span', 'tag tag-' + entry.kind, entry.tag), name, h('span', 'row-date', shortDate(entry.modified)), h('span', 'row-size', formatSize(entry.size)), info);
  row.onclick = () => { select(entry.id, false); openCard(entry); };
  info.onclick = (e) => { e.stopPropagation(); select(entry.id, false); openInfo(entry); };
  entry.card = row; entry.qMark = undefined; markQueue(entry);
  return row;
}
function createFolderRow(f) {
  const row = h('div', 'row card card-folder');
  row.dataset.id = f.id;
  const glyph = h('span', 'row-glyph'); glyph.appendChild(icon('i-folder'));
  const chev = h('span', 'row-chev'); chev.appendChild(icon('i-next'));
  row.append(glyph, h('span', 'row-kind', 'Folder'), h('span', 'row-name', f.name), h('span', 'row-date', ''), h('span', 'row-size', folderCount(f.count)), chev);
  row.onclick = () => openFolder(f.path);
  return row;
}

function openFolder(path) {
  state.path = dirSegs(path);
  state.selectedId = null;
  state.cardsEnter = true;
  window.scrollTo(0, 0);
  render();
}
function folderUp() {
  if (!state.path.length) return;
  const left = state.path.join('/');
  state.path.pop();
  state.selectedId = folderId(left);          // the folder we came from is highlighted
  state.cardsEnter = true;
  render();
}
function renderCrumbs() {
  const nav = $('crumbs');
  const show = foldersOn();
  nav.hidden = !show;
  if (!show) return;
  const root = state.folderName || 'All files';
  const parts = [{ name: root, path: '', home: true }];
  state.path.forEach((seg, i) => parts.push({ name: seg, path: state.path.slice(0, i + 1).join('/') }));
  nav.replaceChildren(...parts.flatMap((p, i) => {
    const b = h('button', 'crumb' + (i === parts.length - 1 ? ' here' : ''));
    b.type = 'button';
    if (p.home) b.appendChild(icon('i-home'));
    b.append(h('span', '', p.name));
    b.title = i === parts.length - 1 ? 'You are here' : 'Go to ' + p.name;
    b.onclick = () => { if (i < parts.length - 1) openFolder(p.path); };
    return i ? [h('span', 'crumb-sep', '›'), b] : [b];
  }));
}

function render() {
  relinkQueue();
  const hasFiles = state.files.length > 0;
  $('empty').hidden = hasFiles;
  $('toolbar').hidden = $('searchBox').hidden = !hasFiles;
  $('footKeys').hidden = !hasFiles;
  $('footStart').hidden = hasFiles;
  $('grid').hidden = !hasFiles;

  renderStatus();
  renderChips();
  renderActions();
  renderCrumbs();

  const grid = $('grid');
  grid.classList.toggle('as-list', state.view === 'list');
  let count;
  {
    const list = currentItems();
    count = list.length;
    grid.classList.toggle('no-blur', list.length > 80);   // blur behind hundreds of cards would make scrolling heavy
    const files = list.filter((e) => !e.folder);
    grid.replaceChildren(...list.map((it) => (state.view === 'list' ? (it.folder ? createFolderRow(it) : createRow(it)) : (it.folder ? createFolderCard(it) : createCard(it)))));
    if (state.cardsEnter) {                                  // only right after files were loaded, not on every filter / search
      state.cardsEnter = false;
      list.forEach((it, i) => { const el = it.folder ? grid.children[i] : it.card; if (el) el.style.setProperty('--i', String(Math.min(i, 14))); });
      grid.classList.add('enter');
      clearTimeout(render.enterTimer);
      render.enterTimer = setTimeout(() => grid.classList.remove('enter'), 1000);
    }
    if (!list.some((it) => it.id === state.selectedId)) state.selectedId = list.length ? list[0].id : null;
    markSelected(false);
    if (state.view === 'icons') for (const e of files) thumbObserver.observe(e.card);   // thumbnails only for visible cards
  }
  $('noResults').hidden = !hasFiles || count > 0;
}

function renderActions() {
  const show = !!state.stored && !state.handle;
  document.querySelectorAll('.reopen-btn').forEach((b) => {
    b.hidden = !show;
    const label = b.querySelector('.reopen-label');
    if (label) label.textContent = state.stored ? 'Reopen “' + state.stored.name + '”' : 'Reopen last folder';
  });
  $('btnRefresh').hidden = !state.handle;
  $('btnQueue').hidden = !state.files.length && !Q.items.length;
  $('btnRecent').hidden = !state.files.length;
  $('qCount').textContent = Q.items.length ? String(Q.items.length) : '';
  // folder controls only when there is something to switch: files that really are in folders
  const folders = hasFolders();
  $('btnFolders').hidden = !folders;
    // saving next to the files needs a folder picked with the folder picker (Chrome / Edge)
  $('sDrive').hidden = !(window.showDirectoryPicker && state.handle);
  if (window.driveStatus) driveStatus();
  viewButtons();
}
function viewButtons() {
  document.querySelectorAll('#viewSeg [data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  $('btnFolders').setAttribute('aria-pressed', String(state.folders));
  $('btnFolders').dataset.tip = state.folders ? 'Folders are shown — click for one flat list' : 'Show folders';
}
function setViewMode(v, save = true) {
  if (!VIEWS.includes(v) || v === state.view) return;
  state.view = v;
  if (save) savePref('fv-viewmode', v);
  state.cardsEnter = true;
  render();
}
function setFoldersOn(on, save = true) {
  on = !!on;
  if (on === state.folders) return;
  state.folders = on;
  state.path = [];
  if (save) savePref('fv-folders', on ? '1' : '0');
  state.cardsEnter = true;
  render();
}
document.querySelectorAll('#viewSeg [data-view]').forEach((b) => { b.onclick = () => setViewMode(b.dataset.view); });
$('btnFolders').onclick = () => setFoldersOn(!state.folders);


function renderStatus() {
  if (state.note) { $('status').textContent = state.note; return; }
  if (!state.files.length) { $('status').textContent = 'Nothing open yet'; return; }
  const n = state.files.length;
  let text = (state.folderName ? state.folderName + ' · ' : '') + n + ' ' + plural(n, ['file', 'files']);
  $('status').textContent = text;
}

/* ----- Filter: a small drop-down with check boxes, so several file types can be shown together ----- */
function kindsTitle() {
  const n = state.kinds.size;
  return !n ? 'All' : n === 1 ? KINDS[[...state.kinds][0]].title : n + ' types';
}
function renderChips() {
  const present = Object.keys(KINDS).filter((k) => state.files.some((e) => e.kind === k));
  for (const k of [...state.kinds]) if (!present.includes(k)) state.kinds.delete(k);
  const focusKind = document.activeElement && $('filterMenu').contains(document.activeElement) ? document.activeElement.dataset.kind : null;
  const row = (kind, title, count, on) => {
    const b = h('button', 'dd-check k-' + (kind || 'all'));
    b.type = 'button'; b.dataset.kind = kind || ''; b.tabIndex = -1;
    b.setAttribute('role', 'menuitemcheckbox'); b.setAttribute('aria-checked', String(on));
    const box = h('span', 'dd-box'); box.appendChild(icon('i-check'));
    b.append(box, h('span', 'grow', title), h('b', '', String(count)));
    b.title = kind ? (on ? 'Hide ' : 'Show ') + title + ' files' : 'Show all files';
    return b;
  };
  $('filterMenu').replaceChildren(
    row('', 'All types', state.files.length, !state.kinds.size),
    ...present.map((k) => row(k, KINDS[k].title, state.files.filter((e) => e.kind === k).length, state.kinds.has(k))));
  $('filterVal').textContent = kindsTitle();
  if (focusKind != null) { const f = $('filterMenu').querySelector('[data-kind="' + focusKind + '"]'); if (f) f.focus(); }
}
function filterToggle(kind) {
  if (!kind) state.kinds.clear();
  else if (state.kinds.has(kind)) state.kinds.delete(kind); else state.kinds.add(kind);
  if (state.kinds.size && Object.keys(KINDS).filter((k) => state.files.some((e) => e.kind === k)).every((k) => state.kinds.has(k))) state.kinds.clear();     // everything ticked = all
  render();
}
const filterRows = () => [...$('filterMenu').querySelectorAll('button')];
function openFilterMenu() {
  $('filterMenu').hidden = false;
  $('filterBtn').setAttribute('aria-expanded', 'true');
}
function closeFilterMenu(refocus) {
  if ($('filterMenu').hidden) return;
  $('filterMenu').hidden = true;
  $('filterBtn').setAttribute('aria-expanded', 'false');
  if (refocus) $('filterBtn').focus();
}
$('filterBtn').onclick = () => { if ($('filterMenu').hidden) openFilterMenu(); else closeFilterMenu(false); };
$('filterMenu').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) filterToggle(b.dataset.kind); });       // the menu stays open: tick as many as you like
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#filterDD')) closeFilterMenu(false); });
$('filterDD').addEventListener('keydown', (e) => {
  const rows = filterRows(), i = rows.indexOf(document.activeElement);
  const handled = () => { e.preventDefault(); e.stopPropagation(); };
  if (e.key === 'Escape' && !$('filterMenu').hidden) { handled(); closeFilterMenu(true); }
  else if (e.key === 'ArrowDown') { handled(); if ($('filterMenu').hidden) openFilterMenu(); rows[(i + 1) % rows.length].focus(); }
  else if (e.key === 'ArrowUp') { handled(); if ($('filterMenu').hidden) openFilterMenu(); rows[(i - 1 + rows.length) % rows.length].focus(); }
  else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { handled(); filterToggle(rows[i].dataset.kind); }
  else if (e.key === 'Tab') closeFilterMenu(false);
});

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
  for (const card of $('grid').querySelectorAll('[data-id]')) {
    const on = Number(card.dataset.id) === state.selectedId;
    card.classList.toggle('selected', on);
    if (on && scroll) card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }
}

// The arrow keys. Icons: along the cards · list: up and down
function moveSelection(dx, dy) {
  const cards = Array.from($('grid').children).filter((c) => c.dataset.id);
  if (!cards.length) return;
  let i = cards.findIndex((c) => Number(c.dataset.id) === state.selectedId);
  if (i < 0) i = 0;
  i += dx;
  if (dy) {
    const perRow = state.view === 'list' ? 1 : (cards.filter((c) => c.offsetTop === cards[0].offsetTop).length || 1);
    i += dy * perRow;
  }
  select(Number(cards[clamp(i, 0, cards.length - 1)].dataset.id), true);
}
function selectedEntry() { return state.files.find((e) => e.id === state.selectedId); }
// Enter: a file opens, a folder is entered
function activateSelected() {
  const entry = selectedEntry();
  if (entry) { openCard(entry); return true; }
  if (state.selectedId !== null && state.selectedId < 0) {
    openFolder(FOLDER_BY_ID.get(state.selectedId));
    return true;
  }
  return false;
}
// The mouse decides what Space, Enter and Q act on: the file under the pointer is the selected one
$('grid').addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const el = e.target.closest('[data-id]');
  if (!el || !$('grid').contains(el)) return;
  const id = Number(el.dataset.id);
  if (id !== state.selectedId) select(id, false);
});


/* ---------------------------------------------------------------------
   Smooth show / hide. Everything that pops up or opens just sets `el.hidden`
   as before; for the listed elements the setter now plays an in/out animation
   (CSS classes anim-in / anim-out) and only really hides after the out-animation.
   --------------------------------------------------------------------- */
let BOOTING = true;                                     // while the page starts, things that start hidden just are hidden (no fade-out on load)
window.addEventListener('load', () => setTimeout(() => { BOOTING = false; }, 0));
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
        if (BOOTING) { native.set.call(el, v); return; }
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

// Where a file is: the chosen folder and the folders inside it  ("Lessons / Week 3")
function whereText(entry, short) {
  const parts = [...(entry.dirs || [])];
  if (!short && entry.rootName) parts.unshift(entry.rootName);
  return parts.join(' / ') || (short ? '' : 'Selected files');
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
    if (VIEWER_LIB[entry.viewer]) await lib(VIEWER_LIB[entry.viewer]);
    const own = VIEWER_LIB[entry.viewer] && VIEWER_CLASSES[entry.viewer];
    if (own && typeof own.details === 'function') {
      await own.details(entry, add, dateText);

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


/* ----- Recent files: the files opened lately from this folder (remembered with the place; travels with the drive) ----- */
const RECENT_KEY = 'fv-recent', RECENT_SHOW = 12;
const recentMap = () => { try { return JSON.parse(loadPref(RECENT_KEY, '{}')) || {}; } catch (e) { return {}; } };
function recentTouch(entry) {                       // called when a file is opened
  const map = recentMap();
  map[posKey(entry)] = { n: entry.name, t: Date.now() };
  const keys = Object.keys(map);
  if (keys.length > 40) keys.sort((a, b) => map[a].t - map[b].t).slice(0, keys.length - 40).forEach((k) => delete map[k]);
  savePref(RECENT_KEY, JSON.stringify(map));
  drivePush();
  if (!M.el.hidden && M.body.classList.contains('recent-dialog')) renderRecentDialog();
}
function recentLabel(entry, saved) {                // where you stopped
  if (!saved || saved.d) return '';
  if (entry.kind === 'video' || entry.kind === 'audio') {
    const s = Math.floor(saved.p), m = Math.floor(s / 60);
    return 'At ' + (m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0');
  }
  if (!saved.n) return Math.round(saved.p * 100) + '% read';
  return (entry.kind === 'pptx' ? 'Slide ' : entry.kind === 'xlsx' ? 'Sheet ' : 'Page ') + (saved.p + 1) + ' of ' + saved.n;
}
function agoText(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
  if (m < 60 * 24 * 7) return Math.round(m / 1440) + ' d ago';
  return shortDate(t);
}
function recentItems() {
  const recent = recentMap();
  let pos = {};
  try { pos = JSON.parse(loadPref('fv-pos', '{}')) || {}; } catch (e) { /* none */ }
  const byKey = new Map(state.files.map((e) => [posKey(e), e]));
  return Object.keys(recent).filter((k) => byKey.has(k) && !recent[k].d).sort((a, b) => recent[b].t - recent[a].t).slice(0, RECENT_SHOW)
    .map((k) => ({ key: k, entry: byKey.get(k), t: recent[k].t, saved: pos[k] }));
}
function openRecent() { if (M.el.hidden) renderRecentDialog(true); else renderRecentDialog(); }
function renderRecentDialog(first) {
  const box = h('div');
  box.appendChild(h('h2', 'modal-title', 'Recent files'));
  const items = recentItems();
  if (!items.length) {
    const ghost = h('div', 'q-list q-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) {
      const row = h('div', 'q-row'), name = h('span', 'q-name');
      name.append(h('i', 'q-bar'), h('i', 'q-bar short'));
      row.append(h('i', 'q-tag'), name);
      ghost.appendChild(row);
    }
    box.appendChild(ghost);
    box.appendChild(h('p', 'modal-text q-hint', 'Files you open will be listed here, with the place where you stopped'));
  } else {
    box.appendChild(h('p', 'modal-text', 'Click a file to open it again.'));
    const list = h('div', 'q-list');
    for (const it of items) {
      const row = h('div', 'q-row r-row');
      row.tabIndex = 0;
      row.title = 'Open ' + it.entry.name;
      const info = h('span', 'q-name');
      info.append(h('b', '', it.entry.base), h('small', '', [recentLabel(it.entry, it.saved), agoText(it.t)].filter(Boolean).join(' · ')));
      const x = h('button', 'vbtn vbtn-icon q-btn');
      x.type = 'button'; x.title = 'Remove from the list'; x.setAttribute('aria-label', 'Remove from the list'); x.appendChild(icon('i-x'));
      x.onclick = (ev) => { ev.stopPropagation(); const map = recentMap(); map[it.key] = { d: 1, t: Date.now() }; savePref(RECENT_KEY, JSON.stringify(map)); drivePush(); renderRecentDialog(); };
      const go = () => { closeModal(); openViewer(it.entry); };
      row.onclick = go;
      row.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); go(); } };
      row.append(h('span', 'tag tag-' + it.entry.kind, it.entry.tag), info, x);
      list.appendChild(row);
    }
    box.appendChild(list);
    const clear = h('button', 'btn q-clear-btn', 'Clear the list');
    clear.type = 'button'; clear.title = 'Forget which files were opened (your places in them stay)';
    clear.onclick = () => { const map = recentMap(), t = Date.now(); for (const k of Object.keys(map)) map[k] = { d: 1, t }; savePref(RECENT_KEY, JSON.stringify(map)); drivePush(); renderRecentDialog(); };
    box.appendChild(h('div', 'q-clear-row')).appendChild(clear);
  }
  const actions = h('div', 'modal-actions');
  const close = h('button', 'btn', 'Close');
  close.type = 'button'; close.title = 'Close this window (Esc)'; close.onclick = closeModal;
  actions.append(close);
  box.appendChild(actions);
  if (first) {
    openModal(box, { cls: 'queue-dialog recent-dialog' });
  } else {
    const old = M.body.querySelector('.q-list'), top = old ? old.scrollTop : 0;
    M.body.replaceChildren(box);
    const now = M.body.querySelector('.q-list');
    if (now) now.scrollTop = top;
  }
}
$('btnRecent').onclick = openRecent;

/* ----- Sticky header: slides away while scrolling down, returns at the first scroll up ----- */
(function stickyBar() {
  const bar = $('homebar');
  let last = window.scrollY, away = false, settle = 0;
  const setAway = (v) => { if (v !== away) { away = v; bar.classList.toggle('away', v); } };
  const busy = () => !$('settings').hidden || !$('sortMenu').hidden || bar.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  window.addEventListener('scroll', () => {
    if (document.body.classList.contains('viewing')) return;
    if (performance.now() < settle) { last = Math.max(0, window.scrollY); return; }       // the bar itself changed size (filters opened): not the person's scrolling
    const y = Math.max(0, window.scrollY), dy = y - last;
    last = y;
    bar.classList.toggle('stuck', y > 4);
    if (y < bar.offsetHeight) setAway(false);
    else if (dy > 6 && !busy()) setAway(true);
    else if (dy < -3) setAway(false);
  }, { passive: true });
  bar.addEventListener('focusin', () => setAway(false));
  const setH = () => { settle = performance.now() + 450; last = Math.max(0, window.scrollY); document.documentElement.style.setProperty('--hbh', bar.offsetHeight + 'px'); };
  if (window.ResizeObserver) new ResizeObserver(setH).observe(bar);
  setH();
})();
