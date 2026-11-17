'use strict';
/* Lectern — The viewer window: bar, zoom, fullscreen, overview, menu, timer, keyboard.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, list.js, viewers.js, viewer-ui.js, extras.js, presenter.js. They are plain scripts that share one global scope
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
    if (FORMAT_VIEWERS.has(entry.viewer)) await lib('formats');
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

function showMessage(title, details, loading) {
  const box = $('vMsg');
  box.hidden = !title;
  box.className = 'vmsg' + (loading ? ' loading' : '');
  box.replaceChildren();
  if (title) box.appendChild(h('div', '', title));
  if (details) box.appendChild(h('small', '', details));
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
  // The page padding changes (bars float over the page), but when the whole window is already fullscreen the stage
  // keeps its size, so the resize observer stays silent: fit the content again by hand.
  requestAnimationFrame(() => { if (V.driver && !V.el.hidden) { V.driver.refit(); if (window.Pen) Pen.redraw(); } });
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
    cell.dataset.tip = 'Go to ' + (d instanceof PptxViewer ? 'slide ' : d instanceof XlsxViewer ? 'sheet ' : 'page ') + (i + 1);
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
    b.title = m === 'down' ? 'Count down from the set time' : 'Count up to the set time';
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
  start.title = 'Start the timer';
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
  cancel.title = 'Close this window (Esc)';
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
  close.title = 'Close this window (Esc)';
  close.type = 'button';
  close.onclick = closeTimerDialog;
  const stop = h('button', 'btn', 'Stop');
  stop.title = 'Stop and reset the timer';
  stop.type = 'button';
  stop.onclick = () => { timerStop(); closeTimerDialog(); };
  const pause = h('button', 'btn btn-primary', Timer.running ? 'Pause' : 'Resume');
  pause.type = 'button';
  pause.title = 'Pause or resume the timer';
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
$('mAnim').onclick = () => {
  V.pageAnim = !V.pageAnim;
  savePref('fv-anim', V.pageAnim ? '1' : '0');
  updateBar();
};
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
scrub.addEventListener('pointermove', (e) => {
  if (scrubbing) scrubTo(e);
  const d = V.driver, tip = $('scrubTip');
  if (!d || !d.isMedia || !d.labelAt) { tip.hidden = true; return; }       // the time under the pointer
  const r = scrub.getBoundingClientRect(), ratio = clamp((e.clientX - r.left - 14) / (r.width - 28), 0, 1);
  tip.textContent = d.labelAt(ratio);
  tip.style.left = clamp(e.clientX - r.left, 30, r.width - 30) + 'px';
  tip.hidden = false;
});
scrub.addEventListener('pointerleave', () => { $('scrubTip').hidden = true; });
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

// Video / audio: a click in the middle plays or pauses; a quick second click (mouse) goes fullscreen instead
function mediaTap(touch) {
  const now = Date.now();
  clearTimeout(V.mediaTapTimer);
  if (!touch && now - (V.mediaTapAt || 0) < 300) { V.mediaTapAt = 0; toggleFullscreen(); return; }
  V.mediaTapAt = now;
  V.mediaTapTimer = setTimeout(() => { if (V.driver && V.driver.isMedia) V.driver.toggle(); showUi(); }, touch ? 0 : 260);
}

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
    else mediaTap(touch);
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
    if (UpNext.open && e.key === 'Enter') return act(() => upNextClose(true));
    if (UpNext.open && e.key === 'Escape') return act(() => upNextClose(false));
    if (Resume.open && e.key === 'Enter') return act(() => resumeClose(true));
    if (Resume.open && e.key === 'Escape') return act(() => resumeClose(false));

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
        case 'ArrowUp':   return act(() => changeVolume(0.05));
        case 'ArrowDown': return act(() => changeVolume(-0.05));
        case '<': return act(() => stepRate(-1));
        case '>': return act(() => stepRate(1));
      }
      if (e.code === 'KeyF') return act(toggleFullscreen);
      if (e.code === 'KeyM') return act(toggleMute);
      if (e.code === 'KeyC') return act(toggleSubs);
      if (e.code === 'KeyD') return act(toggleInk);
      if (e.code === 'Comma') return act(() => V.driver.stepFrame(-1));
      if (e.code === 'Period') return act(() => V.driver.stepFrame(1));
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
  document.body.classList.add('kbd-nav');             // the selected card is only drawn while the keyboard is in use (see style.css)
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
      if (entry) { e.preventDefault(); openCard(entry); }
      return;
    }
    case '/': e.preventDefault(); $('search').focus(); return;
  }
  if (e.code === 'KeyQ') {                       // Q = add / remove the selected file in the class queue
    const entry = selectedEntry();
    if (entry) { e.preventDefault(); queueToggle(entry); }
  }
});
