'use strict';
/* Lectern — The viewer window: bar, zoom, fullscreen, overview, menu, pen and laser.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, errors.js, list.js, viewers.js, viewer-ui.js, viewer-timer.js, viewer-input.js, extras.js, presenter.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

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
  uiHover: false,       // the mouse is on a bar or at the bottom edge: the bars stay
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
  upNextClose(false);
  const auto = V.autoplay; V.autoplay = false;     // came from the "Next" countdown: start playing at once
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
  V.lastIndex = -1;                             // the first page of a file is not animated
  V.posReady = false; V.jumping = false; V.posHold = null; resumeClose(false); V.posReady = false;
  V.view = { zoom: 1, fit: 'page', rot: 0 };
  V.stage.classList.remove('zoomed');
  const from = V.openFrom; V.openFrom = null;
  const grow = !!from && !prefersReducedMotion() && !!V.el.animate;       // opened from a card: the page grows out of it
  if (grow) V.el.classList.add('from-card');                              // (instead of the plain fade, see style.css)
  V.el.hidden = false;
  if (grow) {
    const W = innerWidth, H = innerHeight;
    V.el.animate([
      { clipPath: 'inset(' + from.top + 'px ' + (W - from.right) + 'px ' + (H - from.bottom) + 'px ' + from.left + 'px round 18px)' },
      { clipPath: 'inset(0px 0px 0px 0px round 0px)' },
    ], { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished
      .catch(() => {}).then(() => V.el.classList.remove('from-card'));
  }
  document.body.classList.add('viewing');
  $('vTitle').textContent = entry.name;
  showMessage('Opening…', '', true);
  updateBar();
  V.stage.focus();
  updateWakeLock();

  try {
    const real = await sniffViewer(entry);                  // a file saved under the wrong extension still opens correctly
    if (real) { entry.viewer = real.viewer; entry.kind = real.kind; }
    if (VIEWER_LIB[entry.viewer]) await lib(VIEWER_LIB[entry.viewer]);
    if (token !== V.openToken) return;
    const driver = new VIEWER_CLASSES[entry.viewer](V.content, V.stage, V.view);
    driver.entry = entry;
    V.view.fit = driver.defaultFit;
    driver.onChange = updateBar;
    driver.onEnded = () => { if (V.driver === driver) upNextShow(); };
    installPageGhost(driver);
    V.pending = null; clearGhosts();
    V.driver = driver;
    V.el.classList.toggle('is-media', driver.isMedia);
    await driver.open(entry.file);
    if (token !== V.openToken) return;
    showMessage('');
    linkFile();
    updateBar();
    if (auto && driver.isMedia) driver.toggle(); else resumeOffer();
    if (!Resume.open && loadPref('fv-esc', '0') !== '1') { savePref('fv-esc', '1'); showToast('Press Esc to go back to your files', 3200); }     // said once, then never again
  } catch (err) {
    if (token !== V.openToken) return;
    console.error(err);
    const [title, details] = explainError(err, entry);
    showMessage(title, details, false, entry.file && entry.size ? [['Save a copy', () => saveCopy(entry)]] : null);
    updateBar();
  }
}

function closeDriver() {
  if (V.driver) { try { V.driver.destroy(); } catch (e) { /* ignore */ } }
  V.driver = null;
}

function closeViewer() {
  V.openToken++;
  upNextClose(false);
  posSave();
  V.posReady = false; resumeClose(false); V.posReady = false;
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

function showMessage(title, details, loading, actions) {
  const box = $('vMsg');
  box.hidden = !title;
  box.className = 'vmsg state' + (loading ? ' state-loading' : '');
  box.replaceChildren();
  if (title) box.append(...stateNode(title, details, { actions }).childNodes);
}

// Refreshes the label, progress bar and which buttons are enabled
// Page animation (More → Page animation): the old page slowly slides away while the new one slides in from the side it comes from.
// A copy of the old page (the "ghost") is taken the moment goTo() is called, and the move only starts when the new page is
// really on the screen (a PDF page takes a moment to draw), so nothing jumps.
V.pageAnim = loadPref('fv-anim', '1') === '1';
V.lastIndex = -1;
V.ghostLayer = null;
const PAGE_MS = 520, PAGE_EASE = 'cubic-bezier(.65,0,.35,1)';
// Old-projector style: the current page slides out to the left while the next one slides in from the right (and back when going back).
// Only transforms are animated, so the browser does it on the graphics card. A PDF page is moved as it is (no copy at all);
// other formats get a copy of the old slide.
function pageGhost(driver) {
  const src = V.content.firstElementChild;
  if (!src || !V.pageAnim || prefersReducedMotion()) return null;
  const wrap = V.stage.parentElement.getBoundingClientRect(), r = src.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const place = { left: (r.left - wrap.left) + 'px', top: (r.top - wrap.top) + 'px', width: r.width + 'px', height: r.height + 'px' };
  if (driver instanceof PdfViewer) return { el: src, place };       // it is taken off the page when the new one is drawn: we just keep it
  if (src.querySelectorAll('*').length > 3000) return null;
  const copy = src.cloneNode(true);
  const from = src.matches('canvas') ? [src] : [...src.querySelectorAll('canvas')];
  const to = copy.matches('canvas') ? [copy] : [...copy.querySelectorAll('canvas')];
  from.forEach((c, i) => { try { to[i].getContext('2d').drawImage(c, 0, 0); } catch (e) { /* a blank ghost is fine */ } });
  return { el: copy, place };
}
function clearGhosts() {
  if (V.ghostLayer) { V.ghostLayer.remove(); V.ghostLayer = null; }
  V.stage.parentElement.classList.remove('paging');
}
function installPageGhost(driver) {
  const go = driver.goTo.bind(driver);
  driver.goTo = (i) => {
    if (driver instanceof ScrollViewer || driver.isMedia) return go(i);
    const before = driver.index;
    if (!V.pending) V.pending = { ghost: pageGhost(driver) };     // keep the first one while a slow page is still drawing
    go(i);
    if (driver.index === before) V.pending = null;               // nothing changed (clamped at the end)
  };
}
function playPageMove(g, dir) {
  clearGhosts();
  let el = g.el;
  if (el.isConnected) el = el.cloneNode(true);                    // the page was not replaced after all: move a copy
  Object.assign(el.style, g.place, { position: 'absolute', margin: '0', willChange: 'transform' });
  const wrapEl = V.stage.parentElement, dist = wrapEl.clientWidth;
  const layer = h('div', 'page-ghosts');
  layer.appendChild(el);
  wrapEl.appendChild(layer);
  wrapEl.classList.add('paging');                                  // no sideways scrollbar while the new page comes from outside
  V.ghostLayer = layer;
  const opt = { duration: PAGE_MS, easing: PAGE_EASE, fill: 'both' };
  el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(' + (-dir * dist) + 'px)' }], opt);
  const inc = V.content.animate([{ transform: 'translateX(' + (dir * dist) + 'px)' }, { transform: 'translateX(0)' }], { duration: PAGE_MS, easing: PAGE_EASE });
  inc.onfinish = inc.oncancel = () => { if (V.ghostLayer === layer) clearGhosts(); };
}
function animatePage(d) {
  const idx = d.index;
  const drawn = d.shown === undefined || d.shown === idx;         // a PDF page says when it is really on the screen
  if (V.jumping) {                                                // jumping to the remembered page: no animation
    if (drawn) { V.jumping = false; V.pending = null; V.lastIndex = idx; }
    return;
  }
  if (V.lastIndex >= 0 && idx !== V.lastIndex) {
    const dir = idx > V.lastIndex ? 1 : -1;
    const ghost = V.pending && V.pending.ghost;
    if (drawn) {
      if (ghost && V.pageAnim && !prefersReducedMotion()) playPageMove(ghost, dir);
      V.pending = null;
    }
    // while the new page is still being drawn we only wait: V.lastIndex stays put so the move is played later
    if (!drawn) return;
  }
  V.lastIndex = idx;
}
/* ----- Remembering where you stopped -----
   Each file (name + size) remembers its page/slide (or scroll position). Next time it is opened a small card offers to
   continue from there; it waits RESUME_MS and then simply goes away (the file stays at the beginning). */
const RESUME_MS = 20000, POS_KEY = 'fv-pos', POS_MAX = 300;
const posKey = (e) => e.name + '|' + e.file.size;
function posRead() { try { return JSON.parse(loadPref(POS_KEY, '{}')) || {}; } catch (e) { return {}; } }
function posWrite(map) {
  const keys = Object.keys(map);
  if (keys.length > POS_MAX) keys.sort((a, b) => map[a].t - map[b].t).slice(0, keys.length - POS_MAX).forEach((k) => delete map[k]);   // forget the oldest
  savePref(POS_KEY, JSON.stringify(map));
}
const MEDIA_MIN = 120;                    // only recordings longer than two minutes are worth remembering
const trackable = (d) => !!d && (d.isMedia ? !!d.el && d.el.duration > MEDIA_MIN : (d instanceof ScrollViewer || d.count > 1));
const posNow = (d) => (d.isMedia ? d.el.currentTime : d instanceof ScrollViewer ? d.scrollRatio() : d.index);
function posSave() {
  const d = V.driver, e = V.entry;
  clearTimeout(V.posTimer); V.posTimer = 0;
  if (!V.posReady || !e || !trackable(d) || !$('vMsg').hidden) return;
  const map = posRead(), key = posKey(e);
  const scroll = d instanceof ScrollViewer, media = d.isMedia;
  const at = posNow(d);
  if (V.posHold != null) { if (media ? Math.abs(at - V.posHold) < 3 : scroll ? Math.abs(at - V.posHold) < .03 : at === V.posHold) return; V.posHold = null; }   // the offer was ignored and you have not moved yet: keep the old place
  const finished = media ? at > d.el.duration - 10 : scroll ? at > .97 : at >= d.count - 1;
  if (finished || (media ? at < 10 : scroll ? at < .03 : at <= 0)) delete map[key];     // at the start or at the very end there is nothing to continue
  else map[key] = media ? { p: Math.round(at), n: Math.round(d.el.duration), t: Date.now() }
                        : { p: scroll ? Math.round(at * 1000) / 1000 : at, n: scroll ? 0 : d.count, t: Date.now() };
  posWrite(map);
}
// not a debounce: while a video plays the time changes all the time, so it is saved every few seconds
function posSaveSoon() { if (!V.posTimer) V.posTimer = setTimeout(posSave, V.driver && V.driver.isMedia ? 3000 : 500); }
window.addEventListener('pagehide', posSave);

const Resume = { open: false, saved: null, anim: null, timer: 0 };
function resumeLabel(e, saved) {
  if (e.kind === 'video' || e.kind === 'audio') return 'Continue from ' + fmtTime(saved.p) + '?';
  if (!saved.n) return 'Continue where you stopped?';
  const unit = e.kind === 'pptx' ? 'slide' : e.kind === 'xlsx' ? 'sheet' : 'page';
  return 'Continue from ' + unit + ' ' + (saved.p + 1) + ' of ' + saved.n + '?';
}
function resumeOffer() {
  const d = V.driver, e = V.entry;
  V.posReady = false;
  const saved = trackable(d) ? posRead()[posKey(e)] : null;
  V.posHold = null;
  const same = saved && (d.isMedia ? Math.abs(saved.n - Math.round(d.el.duration)) <= 1 && saved.p > 10
                                   : d instanceof ScrollViewer ? !saved.n : saved.n === d.count && saved.p > 0 && saved.p < d.count - 1);
  if (!same) { V.posReady = true; return; }
  Resume.saved = saved;
  $('resumeText').textContent = resumeLabel(e, saved);
  $('resume').hidden = false;
  Resume.open = true;
  const bar = $('resumeBar');
  if (Resume.anim) Resume.anim.cancel();
  Resume.anim = bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: RESUME_MS, easing: 'linear', fill: 'forwards' });
  clearTimeout(Resume.timer);
  Resume.timer = setTimeout(() => resumeClose(false), RESUME_MS);
}
function resumeClose(accept) {
  if (!Resume.open) return;
  Resume.open = false;
  clearTimeout(Resume.timer);
  if (Resume.anim) { Resume.anim.cancel(); Resume.anim = null; }
  $('resume').hidden = true;
  const d = V.driver, saved = Resume.saved;
  Resume.saved = null;
  if (accept && d && saved) {
    if (d.isMedia) d.el.currentTime = saved.p;
    else if (d instanceof ScrollViewer) d.seek(saved.p);
    else if (saved.p !== d.index) { V.jumping = true; d.goTo(saved.p); }          // a jump, not a page turn: no slide animation
  }
  V.posReady = true;
  V.posHold = accept || !trackable(d) ? null : posNow(d);
}
$('resumeYes').onclick = () => resumeClose(true);
$('resumeNo').onclick = () => resumeClose(false);

/* ----- Video / audio finished: the next file of the queue starts by itself after a short countdown ----- */
const UPNEXT_MS = 8000;
const UpNext = { open: false, anim: null, timer: 0 };
function upNextShow() {
  const n = queueNeighbor(1);
  if (!n || UpNext.open) return;
  $('upnextText').textContent = 'Next: ' + (n.entry.base || n.name);
  $('upnext').hidden = false;
  UpNext.open = true;
  if (UpNext.anim) UpNext.anim.cancel();
  UpNext.anim = $('upnextBar').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: UPNEXT_MS, easing: 'linear', fill: 'forwards' });
  clearTimeout(UpNext.timer);
  UpNext.timer = setTimeout(() => upNextClose(true), UPNEXT_MS);
}
function upNextClose(go) {
  if (!UpNext.open) return;
  UpNext.open = false;
  clearTimeout(UpNext.timer);
  if (UpNext.anim) { UpNext.anim.cancel(); UpNext.anim = null; }
  $('upnext').hidden = true;
  if (go) { V.autoplay = true; queueStep(1); }              // the next video / song starts playing on its own
}
$('upnextYes').onclick = () => upNextClose(true);
$('upnextNo').onclick = () => upNextClose(false);

// Everything that only video / audio have: time, volume, speed, subtitles, repeat, pen
function updateMediaBar(d) {
  $('mTime').textContent = d.label();
  const muted = d.muted;
  $('mMuteIcon').setAttribute('href', muted ? '#i-mute' : '#i-volume');
  $('mMute').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  $('mMute').dataset.tip = muted ? 'Unmute (M)' : 'Mute (M)';
  $('mVolume').value = muted ? 0 : Math.round(d.volume * 100);
  const rate = d.rate, normal = Math.abs(rate - 1) < 0.001;
  $('mSpeed').hidden = normal;                                   // the speed shows only when it is not normal
  $('mSpeed').textContent = fmtRate(rate);
  $('mSpeedVal').textContent = fmtRate(rate);
  $('mCC').hidden = !d.hasSubs;
  $('mCC').setAttribute('aria-pressed', String(d.subsOn));
  $('mSubs').setAttribute('aria-pressed', String(d.subsOn));
  $('mSubs').disabled = !d.hasSubs;
  $('mSubsFile').disabled = !d.hasPicture;
  $('mLoop').setAttribute('aria-pressed', String(d.loop));
  $('mInk').hidden = !d.canDraw;
  $('mInk').setAttribute('aria-pressed', String(!!(window.Pen && Pen.on)));
}
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const fmtRate = (r) => (Math.round(r * 100) / 100) + '×';
function stepRate(dir) {
  const d = V.driver;
  if (!d || !d.isMedia) return;
  let i = SPEEDS.findIndex((r) => r >= d.rate - 0.001);
  if (i < 0) i = SPEEDS.length - 1;
  if (dir < 0 && SPEEDS[i] >= d.rate - 0.001 && i > 0 && Math.abs(SPEEDS[i] - d.rate) < 0.001) i--;
  else if (dir > 0 && Math.abs(SPEEDS[i] - d.rate) < 0.001) i = Math.min(SPEEDS.length - 1, i + 1);
  else if (dir < 0) i = Math.max(0, i - 1);
  d.setRate(SPEEDS[i]);
  showToast('Speed ' + fmtRate(SPEEDS[i]));
}
function changeVolume(delta) {
  const d = V.driver;
  if (!d || !d.isMedia) return;
  d.setVolume((d.muted ? 0 : d.volume) + delta);
  showToast('Volume ' + Math.round(d.volume * 100) + '%');
}
function toggleMute() {
  const d = V.driver;
  if (!d || !d.isMedia) return;
  d.setMuted(!d.muted);
  showToast(d.muted ? 'Sound off' : 'Sound on');
}
function toggleSubs() {
  const d = V.driver;
  if (!d || !d.isMedia) return;
  if (!d.hasSubs) { showToast(d.hasPicture ? 'No subtitles here — add a .srt or .vtt file in More' : 'No picture, no subtitles'); return; }
  d.setSubsOn(!d.subsOn);
  showToast(d.subsOn ? 'Subtitles on' : 'Subtitles off');
}

function updateBar() {
  const d = V.driver;
  const ready = !!d && $('vMsg').hidden;
  if (ready && d.count > 1 && !(d instanceof ScrollViewer) && !d.isMedia) animatePage(d);
  if (ready && Resume.open && !V.jumping && (d.isMedia ? d.playing : d instanceof ScrollViewer ? d.scrollRatio() > .03 : d.index > 0)) resumeClose(false);   // you are already moving: the question is no longer needed
  if (ready) posSaveSoon();
  if (UpNext.open && (!ready || !d.isMedia || !d.el.ended)) upNextClose(false);       // played again or moved away: no countdown
  $('vPos').textContent = ready ? d.label() : '';

  const p = ready ? d.progress() : 0;
  $('vProgress').style.width = Math.round(p * 100) + '%';
  $('vKnob').style.left = 'calc(14px + (100% - 28px) * ' + p + ')';
  $('vScrub').classList.toggle('disabled', !ready || d.count <= 1 && !(d instanceof ScrollViewer) && !d.isMedia);

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
  $('mPresenter').disabled = !(presenterOn() || (ready && presentable()));
  linkPush();

  // Video / audio: play button, big play button
  const media = ready && d.isMedia;
  $('mPlayIcon').setAttribute('href', media && d.playing ? '#i-pause' : '#i-play');
  $('mPlay').setAttribute('aria-label', media && d.playing ? 'Pause' : 'Play');
  $('mediaBig').hidden = !media || d.playing || !d.hasPicture || (window.Pen && Pen.on);      // sound only: the button in the bar is enough
  if (media) updateMediaBar(d);
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
  $('mAnim').setAttribute('aria-pressed', String(V.pageAnim));
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
// Moving the mouse hands control back to the pointer: the keyboard selection is hidden again
document.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') document.body.classList.remove('kbd-nav'); });
$('sFull').onclick = togglePageFullscreen;
// "Show tips": the grey help lines at the bottom of the home screens (remembered between launches)
function applyHints(on) { $('footer').hidden = !on; $('sHints').setAttribute('aria-pressed', String(on)); }
applyHints(loadPref('fv-hints', '1') === '1');
$('sHints').onclick = () => { const on = $('footer').hidden; savePref('fv-hints', on ? '1' : '0'); applyHints(on); };
// "Large interface": buttons, bars and dialogs 25% bigger for the back rows of a big room (the document itself is not touched)
function applyLarge(on) {
  document.body.classList.toggle('large-ui', on);
  $('sLarge').setAttribute('aria-pressed', String(on));
  if (V.driver && !V.el.hidden) requestAnimationFrame(() => V.driver.refit());
}
applyLarge(loadPref('fv-large', '0') === '1');
$('sLarge').onclick = () => { const on = !document.body.classList.contains('large-ui'); savePref('fv-large', on ? '1' : '0'); applyLarge(on); };
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
  V.uiHover = false;
  if (on) { showUi(); if (loadPref('fv-edge', '0') !== '1') { savePref('fv-edge', '1'); showToast('With a mouse: move it to the bottom edge to show the controls', 4200); } }
  else { clearTimeout(V.idleTimer); V.el.classList.remove('ui-hidden', 'cursor-idle'); }
  // The page padding changes (bars float over the page), but when the whole window is already fullscreen the stage
  // keeps its size, so the resize observer stays silent: fit the content again by hand.
  requestAnimationFrame(() => { if (V.driver && !V.el.hidden) { V.driver.refit(); if (window.Pen) Pen.redraw(); } });
}
function showUi() {
  V.el.classList.remove('ui-hidden');
  clearTimeout(V.idleTimer);
  if (V.immersive) {
    V.idleTimer = setTimeout(() => {
      if (!V.menuOpen && !V.overviewOpen && !V.uiHover) V.el.classList.add('ui-hidden');
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
    cell.dataset.tip = 'Go to ' + (d instanceof PptxViewer ? 'slide ' : d.entry && d.entry.viewer === 'xlsx' ? 'sheet ' : 'page ') + (i + 1);
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
  if (V.menuOpen && !e.target.closest('#vMenu, #vMore, #mMore')) closeMenu();
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
$('mMute').onclick = toggleMute;
$('mVolume').oninput = () => { const d = V.driver; if (d && d.isMedia) d.setVolume($('mVolume').value / 100); };
$('mSpeed').onclick = $('mSpeedVal').onclick = () => { if (V.driver && V.driver.isMedia) V.driver.setRate(1); };
$('mSpeedDn').onclick = () => stepRate(-1);
$('mSpeedUp').onclick = () => stepRate(1);
$('mCC').onclick = $('mSubs').onclick = toggleSubs;
$('mLoop').onclick = () => { const d = V.driver; if (d && d.isMedia) { d.setLoop(!d.loop); updateBar(); } };
$('mSubsFile').onclick = () => { closeMenu(); $('subPick').value = ''; $('subPick').click(); };
$('subPick').onchange = async () => {
  const f = $('subPick').files[0], d = V.driver;
  if (!f || !d || !d.isMedia) return;
  try { await d.setSubtitles(f); showToast('Subtitles: ' + f.name); }
  catch (err) { showToast('Could not read this subtitles file'); }
};
$('mInk').onclick = () => toggleInk();
$('mMore').onclick = () => (V.menuOpen ? closeMenu() : openMenu());

/* ----- Pen and marker (the code lives in app/modules/ink.js and loads on first use) ----- */
async function toggleInk() {
  const d0 = V.driver;
  if (d0 && d0.isMedia && !d0.canDraw) return;                  // a song has no picture to draw on
  if (d0 && d0.isMedia && d0.playing && !(window.Pen && Pen.on)) d0.toggle();   // the pen works on a paused picture
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
