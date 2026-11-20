'use strict';
/* Lectern — Presenter view, start-up.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, errors.js, list.js, viewers.js, viewer-ui.js, viewer-timer.js, viewer-input.js, extras.js, presenter.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

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

const presenterOn = () => Link.role === 'presenter' && Link.alive && Link.peerRole === 'companion';
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
    showToast('The companion window is already open (More → Stop presenter view ends it)', 3500);
    return;
  }
  const w = window.open(location.href.split('#')[0] + '#companion', 'lectern-companion', 'popup,width=1180,height=780');
  if (!w) { showToast('The browser blocked the new window — allow pop-ups for this page', 4000); return; }
  Link.win = w;
  linkUi();
  showToast('Drag the companion window to your own screen, then press F here', 5000);
}

// Turn presenter view off: the companion window closes and this window is an ordinary viewer again
function presenterStop() {
  Link.send({ t: 'stop' });
  const w = Link.win;
  Link.win = null; Link.role = 'none'; Link.alive = false; Link.peerRole = ''; Link.key = 0; Link.last = '';
  if (w) setTimeout(() => { try { if (!w.closed) w.close(); } catch (e) { /* fine */ } }, 250);
  linkUi();
  showToast('Presenter view is off');
}

/* ----- Companion window ----- */
const pageTitle = document.title;
function companionLeave() {                       // the presenter window ended the link and this window could not close itself
  Link.role = 'none'; Link.alive = false; Link.rem = null; Link.pos = null;
  if (Link.peek) { Link.peek.destroy(); Link.peek = null; }
  document.title = pageTitle;
  V.el.classList.remove('pv-open'); $('pv').hidden = true;
  for (const id of ['mPresenter', 'mLaser', 'mBlack', 'mNotes', 'vInk']) $(id).hidden = false;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* fine */ }
  linkUi();
}
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
        const canvas = await pdfCanvas(await doc.getPage(i + 1), (el.clientWidth || 340) * Math.min(window.devicePixelRatio || 1, 2));
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
        const box = slideCopy(host, W, H, el.clientWidth || 340);
        if (box) el.replaceChildren(box);
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
  $('pvPos').textContent = (rem.viewer === 'pdf' ? 'Page ' : 'Slide ') + (i + 1) + ' of ' + pos.count;
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
  if (pvRender.last !== i && pvRender.last !== undefined && !prefersReducedMotion()) {
    for (const id of ['pvNow', 'pvNext']) $(id).animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  }
  pvRender.last = i;
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
    p.hidden = !st || (Link.role === 'presenter' && !st.here);       // a presenter without a companion window shows nothing
    if (!st) return;
    p.classList.toggle('off', !st.here);
    p.querySelector('.lp-text').textContent = st.text;
  });
  if (st) {
    $('pvState').classList.toggle('off', !st.here);
    $('pvStateText').textContent = st.here ? 'Connected' : 'Not connected';
  }
  $('mPresenterText').textContent = presenterOn() ? 'Stop presenter view' : 'Presenter view';
  $('mPresenter').dataset.tip = presenterOn() ? 'Close the second window (P)' : 'Presenter view: a second window (P)';
  $('mPresenter').disabled = !(presenterOn() || (V.driver && presentable()));
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
    case 'stop': if (Link.role === 'companion') { window.close(); setTimeout(companionLeave, 300); } break;
  }
}
if (Link.ch) Link.ch.onmessage = (e) => linkReceive(e.data);

setInterval(() => {
  if (Link.role !== 'none') Link.send({ t: 'ping', have: Link.rem ? Link.rem.key : 0 });
  if (Link.alive && Date.now() - Link.seen > 6000) { Link.alive = false; linkUi(); }
}, 1500);
window.addEventListener('pagehide', () => Link.send({ t: 'bye' }));
// "Hide notes" in the companion's panel (remembered)
function pvNotesOff(off) {
  $('pv').classList.toggle('notes-off', off);
  $('pvFold').setAttribute('aria-expanded', String(!off));
  $('pvFold').dataset.tip = off ? 'Show notes' : 'Hide notes';
}
pvNotesOff(loadPref('fv-pv-notes-off', '0') === '1');
$('pvFold').onclick = () => {
  const off = !$('pv').classList.contains('notes-off'), pv = $('pv');
  savePref('fv-pv-notes-off', off ? '1' : '0');
  const from = pv.offsetHeight;
  pvNotesOff(off);                                             // the whole panel shrinks to its content (or grows back)
  const to = pv.offsetHeight;
  if (!prefersReducedMotion() && from !== to && pv.animate) pv.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
};
$('mPresenter').onclick = () => { if (presenterOn()) { closeMenu(); presenterStop(); } else presenterStart(); };

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
