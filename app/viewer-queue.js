'use strict';
/* Lectern — what plays after this file, and the class queue while viewing.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, presenter.js.
   They are plain scripts that share one global scope (no modules, so it also works from a file:// address on a flash drive). */

/* ----- Which file follows a video / song: the class queue first, else the next media file of the same folder -----
   (A queue of different kinds of files, see queueMode(), is only a list that plays from top to bottom.)
   Repeat: off / folder (start again after the last one) / one (loop). Shuffle picks a random file that has not played yet. */
const MP = { repeat: loadPref('fv-mrep', 'off'), shuffle: loadPref('fv-mshuf', '0') === '1', scope: loadPref('fv-mscope', 'folder'), anchor: null };
/* The play list: the files of the same kind from this folder, this folder with its subfolders, or everywhere.
   The person can drag the files in the "Up next" window; the order is kept while the list stays the same. */
const PL = { list: null, kind: '', scope: '', n: 0 };
function plBuild(e) {
  const base = e.dir || '';
  let pool = state.files.filter((x) => x.kind === e.kind);
  if (MP.scope === 'folder') pool = pool.filter((x) => (x.dir || '') === base);
  else if (MP.scope === 'tree' && base) pool = pool.filter((x) => (x.dir || '') === base || (x.dir || '').startsWith(base + '/'));
  const byDir = new Map();
  for (const x of pool) { const d = x.dir || ''; if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(x); }
  const dirs = [...byDir.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return dirs.flatMap((d) => sortFiles(byDir.get(d)));
}
// Shuffle really mixes the list (so the Playlist window shows the order that will play): the playing file first, the rest in random order
function plShuffle(e) {
  const rest = PL.list.filter((x) => x !== e);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  PL.list = [e, ...rest];
}
function ctxList(e) {
  if (!PL.list || !PL.list.includes(e) || PL.kind !== e.kind || PL.scope !== MP.scope || PL.n !== state.files.length) {
    PL.list = plBuild(e); PL.kind = e.kind; PL.scope = MP.scope; PL.n = state.files.length;
    if (MP.shuffle) plShuffle(e);
  }
  return PL.list;
}
/* Like Spotify: the songs put in the class queue by hand play first (after the playing one), then the playlist goes on */
function queuedAfter(e) {
  const qi = queueIndexOf(e);
  return Q.items.slice(qi + 1).map((it) => it.entry).filter((x) => x && x !== e);       // any kind: film, song, film, a slide file …
}
const playlist = ctxList;
// Where the playlist goes on after the hand-made queue is played: after the last file that came from the playlist itself
function ctxBase(e, list) {
  const a = MP.anchor;
  return queueIndexOf(e) >= 0 && a && a !== e && list.includes(a) ? list.indexOf(a) : list.indexOf(e);
}
function mediaNext(dir) {
  const e = V.entry;
  if (!e) return null;
  if (queueMode()) return dir > 0 ? queuedAfter(e)[0] || null : (queueNeighbor(-1) || {}).entry || null;     // a mixed queue is only a list: no playlist around it
  const list = ctxList(e), i = ctxBase(e, list);
  if (i < 0) return null;
  const queued = new Set(Q.items.map((it) => it.entry));
  if (dir > 0) {
    const q = queuedAfter(e);
    if (q.length) return q[0];
    if (queueIndexOf(e) >= 0 && !(MP.anchor && list.includes(MP.anchor))) return null;      // a queue that was started by itself ends with its last file
    for (let j = i + 1; j < list.length; j++) if (!queued.has(list[j])) return list[j];
    if (MP.repeat === 'all') for (let j = 0; j < i; j++) if (!queued.has(list[j])) return list[j];
    return null;
  }
  if (queueIndexOf(e) >= 0 && list[i] && list[i] !== e) return list[i];       // back from a hand-made queue song: to the one it interrupted
  if (list[i - 1]) return list[i - 1];
  return MP.repeat === 'all' && list.length > 1 ? list[list.length - 1] : null;
}
const mediaHasNext = (dir) => !!mediaNext(dir);
// Leaving a file that was put in the queue by hand (it played to the end, or the person went on): it is done, so it leaves the queue
function leaveQueued(e) {
  const i = e ? queueIndexOf(e) : -1;
  if (i >= 0 && MP.repeat !== 'all' && !queueMode()) { Q.items.splice(i, 1); queueChanged(); }
}
// The file ended: the next one starts at once
function mediaEnded(d) {
  const n = mediaNext(1);
  leaveQueued(V.entry);                          // played to the end: it leaves the class queue
  if (!n) return;
  V.autoplay = true;
  openViewer(n);
}
/* ----- The lists of what comes next: the playlist window (video / song) and the class queue window (any file) -----
   Rows have a grip (drag to change the order) and a ✕ that shows when the mouse is over the row. */
function closePops() { closeMq(); closeVol(); closeQ(); }
function closeMq() { $('mqMenu').hidden = true; $('mQueue').removeAttribute('aria-expanded'); }
function closeQ() { $('qMenu').hidden = true; $('qPos').removeAttribute('aria-expanded'); }

// The class queue as rows: the open file is marked, the others can be taken out
function queueEntries() {
  const e = V.entry;
  return Q.items.filter((it) => it.entry).map((it, k) => ({ e: it.entry, g: it.entry === e ? 'cur' : 'q', n: k + 1, title: it.entry.base || it.entry.name, sub: (it.entry.ext || '').toUpperCase() }));
}
/* What plays now and next: the playing file, then the files put in the queue by hand (a small gap after them, like in Spotify), then the rest
   of the playlist. The playlist window and the second window of the presenter view show the same rows; a mixed queue is just the queue. */
function upNextEntries() {
  const e = V.entry;
  if (!e) return [];
  if (queueMode()) return queueEntries();
  const list = ctxList(e), i = ctxBase(e, list), queued = queuedAfter(e), qset = new Set(Q.items.map((it) => it.entry));
  const all = [{ e, g: 'cur', n: list.indexOf(e) + 1 }];
  queued.forEach((x, k) => all.push({ e: x, g: 'q', n: k + 1, hideN: true, end: k === queued.length - 1 }));
  list.forEach((x, j) => { if (j > i && !qset.has(x)) all.push({ e: x, g: 'c', n: j + 1 }); });
  for (const r of all) { r.title = r.e.base || r.e.name; r.sub = MP.scope !== 'folder' && r.e.dir ? r.e.dir.split('/').pop() : ''; }
  return all;
}
// One row. it = { e (the file), g ('cur' | 'q' | 'c'), n, title, sub, hideN, end, noGrip }
function mqRow(it) {
  const row = h('div', 'mq-row' + (it.g === 'cur' ? ' current' : '') + (it.end ? ' mq-end' : ''));
  row._e = it.e; row._g = it.g;
  const t = h('span', 'mq-t'); t.append(h('b', '', it.title));
  if (it.sub) t.append(h('small', '', it.sub));
  const num = h('span', 'mq-n'), numText = h('span', 'mq-num', it.hideN ? '' : String(it.n));
  if (it.g === 'cur') numText.append(h('i', 'mq-now'));          // the dot of the playing file sits under its number
  num.append(numText);
  if (!it.noGrip) { const grip = h('span', 'mq-grip'); grip.append(icon('i-grip')); grip.dataset.tip = 'Drag to change the order'; row.append(grip); }
  row.append(num, t);
  if (it.g !== 'cur') {                                            // any file that is still to come can be taken out in advance
    const tip = it.g === 'q' ? 'Remove from the queue' : 'Skip it: take it out of the playlist';
    const x = h('button', 'mq-x'); x.type = 'button'; x.append(icon('i-x')); x.dataset.tip = tip; x.setAttribute('aria-label', tip);
    row.append(x);
  }
  return row;
}
// Take a file out: of the class queue, or (skip) out of this playlist until the list is built again
function upNextRemove(e, g) {
  if (g === 'q') { const i = queueIndexOf(e); if (i >= 0) { Q.items.splice(i, 1); queueChanged(); } }
  else if (g === 'c' && PL.list) PL.list = PL.list.filter((x) => x !== e);
}
// A click in a list: ✕ takes the file out, any other place opens it
function rowClick(ev, box, redraw, after) {
  const row = ev.target.closest('.mq-row');
  if (!row) return;
  if (ev.target.closest('.mq-x')) {
    const top = box.scrollTop;
    upNextRemove(row._e, row._g);
    redraw(); box.scrollTop = top; updateBar();
  } else if (!ev.target.closest('.mq-grip') && row._e !== V.entry) {
    if (playable(row._e)) V.autoplay = true;
    openViewer(row._e);
    if (after) after();
  }
}
// Dragging a row by its grip: a line shows where it will land; drop(group, rows of that group in their new order) changes the data
function rowDrag(ev, box, drop) {
  const grip = ev.target.closest('.mq-grip');
  if (!grip) return;
  const row = grip.parentNode;
  if (row._g === 'cur') return;                                       // the playing file stays where it is
  ev.preventDefault();
  const rows = [...box.children].filter((r) => r._e);
  const from = rows.indexOf(row);
  const same = rows.map((r, i) => (r._g === row._g ? i : -1)).filter((i) => i >= 0);
  const lo = same[0], hi = same[same.length - 1] + 1;                 // a file moves only inside its own group (queued by hand / playlist)
  const step = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : 50;
  const line = h('div', 'mq-line'), ghost = row.cloneNode(true);
  ghost.className = 'mq-row mq-ghost';
  const r0 = row.getBoundingClientRect();
  ghost.style.width = r0.width + 'px'; ghost.style.left = r0.left + 'px';
  row.classList.add('drag');
  box.append(line); document.body.append(ghost);
  let raf = 0, y = ev.clientY, slot = from;
  const frame = () => {
    const bb = box.getBoundingClientRect();
    box.scrollTop += y < bb.top + 28 ? -10 : y > bb.bottom - 28 ? 10 : 0;
    ghost.style.top = (y - r0.height / 2) + 'px';
    slot = Math.max(lo, Math.min(hi, Math.round((y - bb.top + box.scrollTop - rows[0].offsetTop - r0.height / 2) / step + 0.5)));
    line.style.top = (rows[0].offsetTop + slot * step - 2) + 'px';
    line.hidden = slot === from || slot === from + 1;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const move = (m) => { y = m.clientY; };
  const done = () => {
    cancelAnimationFrame(raf);
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', done); document.removeEventListener('pointercancel', done);
    ghost.remove(); line.remove(); row.classList.remove('drag');
    if (slot === from || slot === from + 1) return;
    box.insertBefore(row, rows[slot] || line.nextSibling);
    row.animate([{ background: 'var(--surface-3)' }, { background: 'transparent' }], { duration: 500 });
    drop(row._g, [...box.children].filter((r) => r._e && r._g === row._g));
    updateBar();
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', done); document.addEventListener('pointercancel', done);
}
// The files of the queue take the places of the queue in their new order
function reorderQueue(rows) {
  const entries = rows.map((r) => r._e);
  const slots = entries.map((x) => queueIndexOf(x)).sort((a, b) => a - b);
  const items = entries.map((x) => Q.items[queueIndexOf(x)]);
  slots.forEach((pos, k) => { Q.items[pos] = items[k]; });
  queueChanged();
}

/* ----- The playlist window: 30 rows at a time, more are added while you scroll down ----- */
const MQ = { all: [], shown: 0, CHUNK: 30 };
function mqMore() {
  const from = MQ.shown;
  if (from >= MQ.all.length) return;
  const to = Math.min(MQ.all.length, from + MQ.CHUNK);
  $('mqList').append(...MQ.all.slice(from, to).map(mqRow));
  MQ.shown = to;
}
function renderMq() {
  const e = V.entry;
  if (!e) return;
  MQ.all = upNextEntries(); MQ.shown = 0;
  const n = ctxList(e).length;
  $('mqHead').textContent = 'Playlist · ' + n + (n === 1 ? ' file' : ' files');
  $('mqList').replaceChildren();
  $('mqList').scrollTop = 0;
  mqMore();
}
$('mqList').addEventListener('scroll', () => {
  const b = $('mqList');
  if (b.scrollTop + b.clientHeight > b.scrollHeight - 160) mqMore();
}, { passive: true });
function openMq() {
  if (!V.entry) return;
  closeOverview(); closePops();
  $('vMenu').hidden = true; $('vMore').removeAttribute('aria-expanded');
  V.menuOpen = true;
  $('mqMenu').hidden = false;
  $('mQueue').setAttribute('aria-expanded', 'true');
  renderMq();
  showUi();
}
$('mQueue').onclick = () => (!$('mqMenu').hidden ? closeMenu() : openMq());
$('mqList').addEventListener('click', (ev) => rowClick(ev, $('mqList'), renderMq));
$('mqList').addEventListener('pointerdown', (ev) => rowDrag(ev, $('mqList'), (g, rows) => {
  const box = $('mqList');
  if (g === 'q') reorderQueue(rows);
  else {                                                             // the playlist: the rows that were drawn, then the rest as it was
    const e = V.entry, list = ctxList(e), i = ctxBase(e, list), qset = new Set(Q.items.map((it) => it.entry));
    const nowE = rows.map((r) => r._e), drawn = new Set(nowE);
    let k = 0;                                                       // the drawn rows take their places in the new order; everything else stays put
    PL.list = list.slice(0, i + 1).concat(list.slice(i + 1).map((x) => (qset.has(x) || !drawn.has(x) ? x : nowE[k++])));
  }
  box.querySelectorAll('.mq-end').forEach((r) => r.classList.remove('mq-end'));
  const qrows = [...box.children].filter((r) => r._g === 'q');
  if (qrows.length) qrows[qrows.length - 1].classList.add('mq-end');
  [...box.children].filter((r) => r._g === 'c').forEach((r) => { r.querySelector('.mq-num').textContent = String(PL.list.indexOf(r._e) + 1); });
}));

/* ----- The class queue window (the number "1 / 3" in the top bar): every file of the queue, whatever its kind ----- */
function renderQ() {
  const rows = queueEntries();
  $('qHead').textContent = 'Class queue · ' + rows.length + (rows.length === 1 ? ' file' : ' files');
  $('qList').replaceChildren(...rows.map(mqRow));
}
function openQ() {
  if (!V.entry) return;
  closeOverview(); closePops();
  $('vMenu').hidden = true; $('vMore').removeAttribute('aria-expanded');
  V.menuOpen = true;
  $('qMenu').hidden = false;
  $('qPos').setAttribute('aria-expanded', 'true');
  renderQ();
  const now = $('qList').querySelector('.current');
  if (now) now.scrollIntoView({ block: 'nearest' });
  showUi();
}
$('qPos').onclick = () => (!$('qMenu').hidden ? closeMenu() : openQ());
$('qList').addEventListener('click', (ev) => rowClick(ev, $('qList'), renderQ, closeMenu));
$('qList').addEventListener('pointerdown', (ev) => rowDrag(ev, $('qList'), (g, rows) => reorderQueue(rows)));

