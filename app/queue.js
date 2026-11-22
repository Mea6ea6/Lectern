'use strict';
/* Lectern — The class queue: the list on the home screen, the number on the cards, moving between its files while viewing.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, queue.js, thumbs.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, presenter.js.
   They are plain scripts that share one global scope (no modules, so it also works from a file:// address on a flash drive). */

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
const playable = (e) => e.kind === 'video' || e.kind === 'audio';
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
  if (!M.el.hidden && M.body.classList.contains('queue-dialog') && !M.body.classList.contains('recent-dialog')) renderQueueDialog();
  updateQueueNav();
  linkPush();                                     // the second window of the presenter view shows the queue too
}

// The little button on a card: "+" when it is not in the queue, its place number when it is
function markQueue(entry, i = queueIndexOf(entry)) {
  if (!entry.card || entry.qMark === i) return;
  entry.qMark = i;
  const btn = entry.card.querySelector('.card-queue');
  entry.card.classList.toggle('queued', i >= 0);
  if (!btn) return;
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
  const media = V.driver && V.driver.isMedia;
  const to = media ? mediaNext(dir) : (queueNeighbor(dir) || {}).entry;
  if (to && playable(to) && (media || dir > 0)) V.autoplay = true;
  if (to) { if (media && V.driver.playing) V.autoplay = true; if (media && dir > 0) leaveQueued(V.entry); openViewer(to); }
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
/* A queue of different kinds of files (a slide file, two films and a song, say) is shown as a plain list: the playlist, shuffle and repeat
   of video and audio do not apply to it, so they are not offered. */
function queueMode() {
  const e = V.entry;
  return !!e && queueIndexOf(e) >= 0 && Q.items.length > 1 && Q.items.some((it) => it.entry && it.entry.kind !== e.kind);
}
function updateQueueNav() {
  const i = V.entry ? queueIndexOf(V.entry) : -1;
  const show = i >= 0 && Q.items.length > 1;
  $('qNav').hidden = !show;
  V.el.classList.toggle('queue-mode', queueMode());
  if (!show) { if (!$('qMenu').hidden) closeMenu(); return; }
  $('qPos').textContent = (i + 1) + ' / ' + Q.items.length;
  $('qPrev').disabled = !queueNeighbor(-1);
  $('qNext').disabled = !queueNeighbor(1);
  if (!$('qMenu').hidden) renderQ();
}

/* ----- The queue window ----- */
function queueStart() {
  const first = Q.items.find((it) => it.entry);
  if (!first) return;
  closeModal();
  MP.anchor = null;
  if (playable(first.entry)) V.autoplay = true;      // songs and films start playing at once
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


