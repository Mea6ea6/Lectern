'use strict';
/* Lectern — Presenter view, start-up.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, queue.js, thumbs.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, presenter.js. They are plain scripts that share one global scope
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
  pic: '', picKey: 0,       // presenter: the cover of the song now playing (made once)
  items: [],                // presenter: the files of the rows that the companion shows (a video / song)
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
// "Presenter view" is only offered when it can work: this browser can link two windows, and the open file is a PDF or a presentation
function syncPresenterItem() { $('mPresenter').hidden = !Link.ch || Link.role === 'companion' || !(presenterOn() || (V.driver && presentable())); }
const presentable = () => !!V.entry && !!V.driver && (V.driver.isMedia || ((V.entry.viewer === 'pdf' || V.entry.viewer === 'pptx') && V.driver.count > 0));

/* ----- Presenter window ----- */
function linkSendFile() {
  const d = V.driver, e = V.entry;
  if (Link.role !== 'presenter' || !Link.key || !d || !e) return;
  if (d.isMedia) Link.send({ t: 'file', key: Link.key, name: e.base || e.name, viewer: 'media' });          // a film or a song is not copied: only its buttons and queue are shown
  else Link.send({ t: 'file', key: Link.key, name: e.name, viewer: e.viewer, file: e.file, ratio: d.thumbRatio, notes: d.notes || [] });
}
// A file has finished opening
function linkFile() {
  if (Link.role !== 'presenter') return;
  Link.key = presentable() ? ++Link.seq : 0;
  if (Link.key && Link.alive) linkSendFile();
}
// A small picture for the second window: the frame of the video now showing, or the cover of the song (made once per file)
function mediaPic(d) {
  try {
    if (!d.hasPicture && Link.picKey === Link.key) return Link.pic;
    const cover = d.hasPicture ? null : $('content').querySelector('img.media-cover');
    const src = d.hasPicture ? d.el : cover;
    const w = d.hasPicture ? d.el.videoWidth : cover && cover.naturalWidth, hh = d.hasPicture ? d.el.videoHeight : cover && cover.naturalHeight;
    let url = '';
    if (src && w > 0) {
      const k = Math.min(1, 280 / w), c = h('canvas');
      c.width = Math.round(w * k); c.height = Math.round(hh * k);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      url = c.toDataURL('image/jpeg', 0.6);
    }
    if (!d.hasPicture) { Link.pic = url; Link.picKey = Link.key; }
    return url;
  } catch (err) { return ''; }                  // a picture that cannot be read is simply not shown
}
function linkPush(force) {
  if (Link.role !== 'presenter') return;
  const d = V.driver, ok = !!Link.key && !!d && $('vMsg').hidden;
  let s = { t: 'state', key: 0 };
  if (ok && d.isMedia) {
    if (!Link.alive && !force) return;
    const rows = upNextEntries();
    Link.items = rows.map((r) => r.e);               // the second window refers to a row by its number
    s = { t: 'state', key: Link.key, media: { playing: d.playing, time: Math.floor(d.el.currentTime || 0), dur: d.el.duration || 0, mode: queueMode() ? 'queue' : 'playlist',
      rows: rows.slice(0, 40).map((r) => ({ g: r.g, n: r.n, title: r.title, sub: r.sub, hideN: !!r.hideN, end: !!r.end })) } };
  } else if (ok) s = { t: 'state', key: Link.key, index: d.currentIndex(), count: d.count, qi: queueIndexOf(V.entry),
      qs: Q.items.map((it, i) => it.entry && { i, n: it.entry.base || it.entry.name, tag: it.entry.tag, k: it.entry.kind }).filter(Boolean).slice(0, 60) };
    Link.items = Q.items.map((it) => it.entry);       // the second window refers to a file by its number
  const sig = JSON.stringify(s);
  if (!force && sig === Link.last) return;
  Link.last = sig;
  if (s.media) s.media.pic = mediaPic(d);
  Link.send(s);
}
function linkSendAll() { linkSendFile(); linkPush(true); if (Timer.active) timerShare(); }
function presenterStart() {
  if (Link.role === 'companion') return;
  if (!Link.ch) { showToast('Presenter view needs a newer browser'); return; }
  if (!presentable()) { showToast('Presenter view works with PDF, PowerPoint, video and audio files'); return; }
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
  showToast('Drag the companion window to your own screen, then press {F} here', 5000);
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
  $('mCompanionHelp').hidden = true;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* fine */ }
  linkUi();
}
function linkCmd(c, extra) {
  if (!Link.rem || !Link.rem.key) { showToast('No presentation to control yet'); return; }
  Link.send(Object.assign({ t: 'cmd', key: Link.rem.key, c }, extra));
}
// The presentation window obeys the companion: turn the page, or (video / song) pause, jump, change the file
function remoteCmd(m) {
  const d = V.driver;
  const e = Link.items[m.i], same = !!e && (e.base || e.name) === m.n && e !== V.entry;      // the row must still be the same file
  if (m.c === 'go') { if (same) { if (playable(e)) V.autoplay = true; openViewer(e); } return; }
  if (!d.isMedia) {
    if (['next', 'prev', 'first', 'last'].includes(m.c)) d.go(m.c);
    else if (m.c === 'goto' && m.i >= 0 && m.i < d.count) d.goTo(m.i);
    return;
  }
  switch (m.c) {
    case 'toggle': d.toggle(); break;
    case 'back': d.skip(-5); break;
    case 'fwd': d.skip(5); break;
    case 'seek': d.seek(m.r); break;
    case 'prevf': queueStep(-1); break;
    case 'nextf': queueStep(1); break;
    case 'rm': if (same) { upNextRemove(e, m.g); updateBar(); } break;
  }
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
  if (m.viewer === 'media') { Link.rem = { key: m.key, name: m.name, viewer: 'media', notes: [], ready: true }; pvRender(); return; }
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
  else if (Link.pos && !Link.pos.key) msg = 'Open a PDF, a PowerPoint file, a video or a song in the presentation window.';
  else if (!pos) msg = 'Loading the presentation…';
  empty.textContent = msg;
  $('pv').classList.toggle('idle', !!msg);
  $('pvTitle').textContent = online && rem && rem.name ? rem.name : 'Presentation';
  $('pv').classList.toggle('is-media', !msg && rem.viewer === 'media');
  if (msg) { pvJob++; return; }
  if (rem.viewer === 'media') { pvJob++; pvMedia(pos.media); return; }

  const i = pos.index, last = pos.count - 1, what = rem.viewer === 'pdf' ? 'page' : 'slide';
  $('pvLabel').textContent = (rem.viewer === 'pdf' ? 'Page ' : 'Slide ') + (i + 1) + ' of ' + pos.count;
  $('pvFirst').disabled = $('pvPrev').disabled = i <= 0;
  $('pvNextBtn').disabled = $('pvLast').disabled = i >= last;
  for (const [id, text] of [['pvFirst', 'First'], ['pvPrev', 'Previous'], ['pvNextBtn', 'Next'], ['pvLast', 'Last']]) {
    const key = id === 'pvPrev' ? ' (↑)' : id === 'pvNextBtn' ? ' (↓)' : '';
    $(id).dataset.tip = text + ' ' + what + key; $(id).setAttribute('aria-label', text + ' ' + what);
  }
  $('pvNow').style.setProperty('--r', rem.ratio);
  const text = rem.notes[i] || '';
  const noNotes = !rem.notes.some(Boolean);
  const box = $('pvNotes');
  box.textContent = text || (noNotes ? 'This file has no speaker notes.' : 'No notes for this slide.');
  box.classList.toggle('none', !text);
  box.scrollTop = 0;

  // The big slide, and the row of small ones
  const job = ++pvJob, eng = Link.peek, stale = () => job !== pvJob;
  pvStrip(rem, pos, eng);
  if (!eng) return;
  if (pvRender.last !== i && pvRender.last !== undefined && !prefersReducedMotion()) $('pvNow').animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  pvRender.last = i;
  eng.draw(i, $('pvNow'), stale);
}
// One row: the small slides of this file, then the other files of the queue (a gap between the files). Scrolls sideways.
let pvSeen = null;
function pvStrip(rem, pos, eng) {
  const strip = $('pvStrip'), qs = pos.qi >= 0 ? pos.qs || [] : [];
  const sig = rem.key + '|' + pos.count + '|' + pos.qi + '|' + JSON.stringify(qs);
  if (pvStrip.sig !== sig) {
    pvStrip.sig = sig;
    if (pvSeen) pvSeen.disconnect();
    pvSeen = new IntersectionObserver((items) => {
      for (const it of items) if (it.isIntersecting) { pvSeen.unobserve(it.target); if (Link.peek) Link.peek.draw(Number(it.target.dataset.i), it.target.firstChild, () => !it.target.isConnected); }
    }, { root: strip, rootMargin: '0px 200px' });
    const th = rem.ratio > 1 ? 84 : 58, tw = Math.round(th / rem.ratio);          // the size is spelled out: no layout guessing from the aspect ratio
    strip.style.setProperty('--th', th + 'px');
    strip.replaceChildren();
    const slides = () => {
      const g = h('div', 'pv-group');
      for (let i = 0; i < pos.count; i++) {
        const t = h('button', 'pv-tile'), shot = h('span', 'pv-tshot');
        t.type = 'button'; t.dataset.i = i; t.dataset.tip = 'Show ' + (rem.viewer === 'pdf' ? 'page ' : 'slide ') + (i + 1);
        shot.style.width = tw + 'px'; shot.style.height = th + 'px';
        t.append(shot, h('b', 'num-dot pv-tnum', String(i + 1)));
        t.onclick = () => linkCmd('goto', { i });
        g.appendChild(t); pvSeen.observe(t);
      }
      return g;
    };
    if (!qs.length) strip.appendChild(slides());
    for (const f of qs) {
      if (f.i === pos.qi) { strip.appendChild(slides()); continue; }
      const t = h('button', 'pv-file');
      t.type = 'button'; t.dataset.tip = 'Open ' + f.n + ' in the presentation window';
      t.append(h('span', 'tag tag-' + f.k, f.tag), h('span', 'pv-fname', f.n));
      t.onclick = () => linkCmd('go', { i: f.i, n: f.n });
      strip.appendChild(t);
    }
  }
  const cur = strip.querySelector('.pv-tile.current');
  if (cur) cur.classList.remove('current');
  const now = strip.querySelector('.pv-tile[data-i="' + pos.index + '"]');
  if (now) {
    now.classList.add('current');
    now.scrollIntoView({ inline: 'center', block: 'nearest', behavior: pvStrip.placed && !prefersReducedMotion() ? 'smooth' : 'auto' });
    pvStrip.placed = true;
  }
}
$('pvStrip').addEventListener('wheel', (ev) => { if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) { ev.preventDefault(); $('pvStrip').scrollLeft += ev.deltaY; } }, { passive: false });
// Video / song: time, the buttons and the queue (rows are drawn again only when they change, so a click is never lost)
function pvMedia(m) {
  if (!m) return;
  if (m.pic !== undefined) { $('pvMImg').src = m.pic || ''; $('pvMPic').hidden = !m.pic; }
  $('pvMTime').textContent = fmtTime(m.time) + ' / ' + fmtTime(m.dur);
  $('pvMFill').style.width = (m.dur > 0 ? Math.min(100, m.time / m.dur * 100) : 0) + '%';
  $('pvMPlayIcon').setAttribute('href', m.playing ? '#i-pause' : '#i-play');
  $('pvMPlay').setAttribute('aria-label', m.playing ? 'Pause' : 'Play');
  $('pvQCap').textContent = 'Queue';
  const sig = JSON.stringify(m.rows);
  if (pvMedia.sig === sig) return;
  pvMedia.sig = sig;
  $('pvQList').replaceChildren(...m.rows.map((r, i) => { const row = mqRow(Object.assign({ noGrip: true }, r)); row._i = i; return row; }));
}
$('pvQList').addEventListener('click', (ev) => {
  const row = ev.target.closest('.mq-row');
  if (!row || row._g === 'cur') return;
  const n = row.querySelector('.mq-t b').textContent;
  // the presentation window compares the file name, so a list that changed in the meantime is never obeyed by mistake
  linkCmd(ev.target.closest('.mq-x') ? 'rm' : 'go', { i: row._i, n, g: row._g });
});
$('pvMPlay').onclick = () => linkCmd('toggle');
$('pvMBack').onclick = () => linkCmd('back');
$('pvMFwd').onclick = () => linkCmd('fwd');
$('pvMPrevF').onclick = () => linkCmd('prevf');
$('pvMNextF').onclick = () => linkCmd('nextf');
$('pvMBar').onclick = (ev) => { const b = $('pvMBar').getBoundingClientRect(); linkCmd('seek', { r: (ev.clientX - b.left) / b.width }); };

// When the panel changes size, slides drawn as pages of HTML are scaled again
const pvResize = new ResizeObserver((items) => {
  for (const it of items) {
    const box = it.target.querySelector('.clone-host');
    if (box) box.style.transform = 'scale(' + (it.target.clientWidth / Number(box.dataset.w || 1280)) + ')';
  }
});
pvResize.observe($('pvNow'));
$('pvPrev').onclick = () => linkCmd('prev');
$('pvNextBtn').onclick = () => linkCmd('next');
$('pvFirst').onclick = () => linkCmd('first');
$('pvLast').onclick = () => linkCmd('last');

/* ----- The welcome note of the companion window (can be switched off; More → About this window brings it back) ----- */
const COMPANION_HELP = [
  ['What this window is for', 'The presentation is in the other window, on the projector. This window stays with you: the current and the next slide, your notes and the buttons.'],
  ['Set up the screens', 'Drag this window to your own screen. In the other window press {F} to fill the projector.'],
  ['Control', 'Previous and Next, or {↑} and {↓}, turn the slides in the other window. For a video or a song: pause, ±5 seconds, the previous and the next file, and the queue.'],
  ['Which file', 'The one open in the other window. To change it, open another file there.'],
  ['What stays in the other window', 'Pen, laser, black screen and the choice of the file. The timer is shared by both windows.'],
  ['No internet needed', 'The windows talk inside the browser. Nothing is sent anywhere.'],
  ['Finish', 'In the other window: More → Stop presenter view. This window closes by itself.'],
];
function companionHelp() {
  if (Link.role !== 'companion' || !M.el.hidden) return;
  const box = h('div', 'ch-box');
  box.append(h('h2', 'modal-title', 'Companion window'), h('p', 'modal-text', 'Your private screen as the speaker. The audience does not see it.'));
  const list = h('ol', 'ch-list');
  for (const [title, text] of COMPANION_HELP) {
    const li = h('li'), p = h('span', 'ch-text');
    li.append(h('b', null, title));
    for (const part of text.split(/(\{[^}]+\})/)) {
      const m = /^\{(.+)\}$/.exec(part);
      if (m) p.append(h('kbd', null, m[1])); else p.append(part);
    }
    li.append(p); list.append(li);
  }
  box.append(list);
  const check = h('label', 'ch-check');
  const input = h('input'); input.type = 'checkbox'; input.checked = loadPref('fv-companion-help-off', '0') === '1';
  input.onchange = () => savePref('fv-companion-help-off', input.checked ? '1' : '0');
  check.append(input, h('span', 'ch-box-mark'), h('span', null, "Don't show this again"));
  const actions = h('div', 'modal-actions');
  const ok = h('button', 'btn btn-primary', 'Got it'); ok.type = 'button'; ok.onclick = closeModal;
  actions.append(ok);
  box.append(check, actions);
  openModal(box, { cls: 'companion-help', onEnter: closeModal });
}
$('mCompanionHelp').onclick = () => { closeMenu(); companionHelp(); };

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
  const pill = document.querySelector('#viewer .timer-pill');
  if (pill) {
    const away = Link.role !== 'none', home = $('vFull').parentNode;
    if (away && pill.parentNode !== home) home.insertBefore(pill, $('vFull'));
    else if (!away && pill.parentNode === home) $('vTitle').parentNode.append(pill);
  }     // presenting: the timer sits left of Fullscreen
  $('mPresenterText').textContent = presenterOn() ? 'Stop presenter view' : 'Presenter view';
  $('mPresenter').dataset.tip = presenterOn() ? 'Close the second window (P)' : 'Presenter view: a second window (P)';
  syncPresenterItem();
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
      if (Link.role === 'presenter' && m.key === Link.key && Link.key && V.driver && $('vMsg').hidden) remoteCmd(m);
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
// The fold buttons of the companion's panel (notes / queue): the whole panel shrinks to its content (or grows back); remembered
function pvFolder(btn, cls, key, what) {
  const set = (off) => { $('pv').classList.toggle(cls, off); btn.setAttribute('aria-expanded', String(!off)); btn.dataset.tip = (off ? 'Show ' : 'Hide ') + what; btn.setAttribute('aria-label', btn.dataset.tip); };
  set(loadPref(key, '0') === '1');
  btn.onclick = () => {
    const off = !$('pv').classList.contains(cls), pv = $('pv');
    savePref(key, off ? '1' : '0');
    const from = pv.offsetHeight;
    set(off);
    const to = pv.offsetHeight;
    if (!prefersReducedMotion() && from !== to && pv.animate) pv.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
  };
}
pvFolder($('pvFold'), 'notes-off', 'fv-pv-notes-off', 'notes');
pvFolder($('pvQFold'), 'queue-off', 'fv-pv-queue-off', 'the queue');
$('mPresenter').onclick = () => { if (presenterOn()) { closeMenu(); presenterStop(); } else presenterStart(); };

if (Link.role === 'companion') {
  document.title = 'Lectern · Companion';
  V.el.classList.add('pv-open');
  $('pv').hidden = false;
  for (const id of ['mPresenter', 'mLaser', 'mBlack', 'mNotes', 'vInk']) $(id).hidden = true;     // these belong to the presentation window
  $('mCompanionHelp').hidden = false;
  Link.send({ t: 'hello' });
  linkUi();
  if (loadPref('fv-companion-help-off', '0') !== '1') setTimeout(companionHelp, 400);     // the first look: what this window is for
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
