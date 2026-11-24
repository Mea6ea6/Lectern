'use strict';
/* Lectern — Presenter view: the companion window (the panel with the buttons, the strip and the notes).  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, queue.js, thumbs.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, link.js, presenter.js, companion.js, start.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

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
  if (m.c === 'rm') { if (same) { upNextRemove(e, m.g); updateBar(); } return; }
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
  clearTimeout(Link.blank);
  const old = Link.peek; Link.peek = null;
  if (old) old.destroy();
  pvNowKind('');                                  // the picture of the previous file must not stay
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

// The panel: always the same order — the file now, its buttons, the files of the queue, the notes (when there are some)
let pvJob = 0, pvShown = false;
function pvNowKind(kind) {                        // the preview shows a slide ('doc') or a picture ('media'); a change of kind starts it empty
  const box = $('pvNow');
  if (box.dataset.kind === kind) return box;
  box.dataset.kind = kind; box.classList.toggle('is-pic', kind === 'media'); box.replaceChildren();
  return box;
}
function pvPic(url) {
  const box = pvNowKind('media');
  if (url) {
    let img = box.querySelector('img');
    if (!img) { img = h('img'); img.alt = ''; box.replaceChildren(img); }
    if (img.getAttribute('src') !== url) img.src = url;
  } else if (!box.querySelector('.pv-nopic')) { const n = h('div', 'pv-nopic'); n.append(icon('i-music')); box.replaceChildren(n); }
}
function pvRender() {
  if (Link.role !== 'companion') return;
  const pv = $('pv'), rem = Link.rem, pos = Link.pos && rem && Link.pos.key === rem.key ? Link.pos : null;
  const online = Link.alive && Link.peerRole === 'presenter';
  let msg = '';
  if (!online) msg = 'Waiting for the presentation window…';
  else if (Link.pos && !Link.pos.key && !rem) msg = 'Open a PDF, a PowerPoint file, a video or a song in the presentation window.';
  else if (!pos) { if (pvShown && rem) { $('pvTitle').textContent = rem.name; return; } msg = 'Loading the presentation…'; }    // between two files the panel stays as it was
  $('pvEmpty').textContent = msg;
  pv.classList.toggle('idle', !!msg);
  $('pvTitle').textContent = online && rem && rem.name ? rem.name : 'Presentation';
  pvShown = !msg;
  if (msg) { pvJob++; return; }
  const media = rem.viewer === 'media';
  pv.classList.toggle('is-media', media);
  pv.classList.toggle('no-notes', media || !rem.notes.some(Boolean));
  pvStrip(rem, pos);
  if (media) { pvJob++; pvMedia(pos.media); return; }

  const i = pos.index, last = pos.count - 1, what = rem.viewer === 'pdf' ? 'page' : 'slide';
  $('pvLabel').textContent = (rem.viewer === 'pdf' ? 'Page ' : 'Slide ') + (i + 1) + ' of ' + pos.count;
  $('pvFirst').disabled = $('pvPrev').disabled = i <= 0;
  $('pvNextBtn').disabled = $('pvLast').disabled = i >= last;
  for (const [id, text] of [['pvFirst', 'First'], ['pvPrev', 'Previous'], ['pvNextBtn', 'Next'], ['pvLast', 'Last']]) {
    const key = id === 'pvPrev' ? ' (↑)' : id === 'pvNextBtn' ? ' (↓)' : '';
    $(id).dataset.tip = text + ' ' + what + key; $(id).setAttribute('aria-label', text + ' ' + what);
  }
  $('pvNow').style.setProperty('--r', rem.ratio);
  const text = rem.notes[i] || '', box = $('pvNotes');
  box.textContent = text || 'No notes for this slide.';
  box.classList.toggle('none', !text);
  box.scrollTop = 0;

  const job = ++pvJob, eng = Link.peek, stale = () => job !== pvJob;
  const now = pvNowKind('doc');
  if (!eng) return;
  if (pvRender.last !== i && pvRender.last !== undefined && !prefersReducedMotion()) now.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  pvRender.last = i;
  eng.draw(i, now, stale);
}
// One row: the small slides of this file (documents), the other files of the queue with a gap between them. Scrolls sideways.
let pvSeen = null;
function pvStrip(rem, pos) {
  const strip = $('pvStrip'), qs = pos.qs || [], media = rem.viewer === 'media';
  const sig = rem.key + '|' + (media ? 0 : pos.count) + '|' + JSON.stringify(qs);
  if (pvStrip.sig !== sig) {
    pvStrip.sig = sig;
    if (pvSeen) pvSeen.disconnect();
    pvSeen = new IntersectionObserver((items) => {
      for (const it of items) if (it.isIntersecting) { pvSeen.unobserve(it.target); if (Link.peek) Link.peek.draw(Number(it.target.dataset.i), it.target.firstChild, () => !it.target.isConnected); }
    }, { root: strip, rootMargin: '0px 200px' });
    const ratio = rem.ratio || 0.5625, th = ratio > 1 ? 84 : 58, tw = Math.round(th / ratio);          // the size is spelled out: no layout guessing from the aspect ratio
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
    if (!media && !qs.some((f) => f.g === 'cur')) strip.appendChild(slides());
    for (const f of qs) {
      if (f.g === 'cur' && !media) { strip.appendChild(slides()); continue; }
      const tile = h('div', 'pv-file' + (f.g === 'cur' ? ' current' : '')), b = h('button', 'pv-fbtn');
      b.type = 'button';
      b.append(h('span', 'tag tag-' + f.k, f.tag), h('span', 'pv-fname', f.n));
      tile.append(b);
      if (f.g === 'cur') { b.disabled = true; b.dataset.tip = 'Now in the presentation window'; }
      else {
        b.dataset.tip = 'Open ' + f.n + ' in the presentation window';
        b.onclick = () => linkCmd('go', { i: f.i, n: f.n });
        const x = h('button', 'pv-fx'), tip = f.g === 'q' ? 'Remove from the queue' : 'Skip it: take it out of the queue';
        x.type = 'button'; x.append(icon('i-x')); x.dataset.tip = tip; x.setAttribute('aria-label', tip);
        x.onclick = () => linkCmd('rm', { i: f.i, n: f.n, g: f.g });
        tile.append(x);
      }
      strip.appendChild(tile);
    }
  }
  strip.querySelector('.pv-tile.current')?.classList.remove('current');
  const now = media ? strip.querySelector('.pv-file.current') : strip.querySelector('.pv-tile[data-i="' + pos.index + '"]');
  if (now) {
    if (!media) now.classList.add('current');
    now.scrollIntoView({ inline: 'center', block: 'nearest', behavior: pvStrip.placed && !prefersReducedMotion() ? 'smooth' : 'auto' });
    pvStrip.placed = true;
  }
}
$('pvStrip').addEventListener('wheel', (ev) => { if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) { ev.preventDefault(); $('pvStrip').scrollLeft += ev.deltaY; } }, { passive: false });
// Video / song: the picture, the time and the state, the bar (the buttons are always the same)
function pvMedia(m) {
  if (!m) return;
  if (m.pic !== undefined) pvPic(m.pic);
  $('pvMTime').textContent = fmtTime(m.time) + ' / ' + fmtTime(m.dur);
  $('pvMState').textContent = m.playing ? 'Playing' : 'Paused';
  $('pvMFill').style.width = (m.dur > 0 ? Math.min(100, m.time / m.dur * 100) : 0) + '%';
  $('pvMPlayIcon').setAttribute('href', m.playing ? '#i-pause' : '#i-play');
  $('pvMPlay').setAttribute('aria-label', m.playing ? 'Pause' : 'Play');
}
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

// The fold button of the companion's notes: the whole panel shrinks to its content (or grows back); remembered
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
