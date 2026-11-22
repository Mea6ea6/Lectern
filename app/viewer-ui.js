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
  V.el.classList.remove('is-media', 'is-audio', 'is-video');

  V.entry = entry;
  recentTouch(entry);
  if (window.Pen) Pen.restore();
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
    viewRestore(entry);
    driver.onChange = updateBar;
    driver.onEnded = () => { if (V.driver === driver) mediaEnded(driver); };
    installPageGhost(driver);
    V.pending = null; clearGhosts();
    V.driver = driver;
    V.el.classList.toggle('is-media', driver.isMedia);
    await driver.open(entry.file);
    if (token === V.openToken && driver.isMedia && queueIndexOf(entry) < 0) MP.anchor = entry;
    if (token === V.openToken && driver.isMedia) { V.el.classList.toggle('is-audio', !driver.hasPicture); V.el.classList.toggle('is-video', !!driver.hasPicture); }
    if (token !== V.openToken) return;
    showMessage('');
    linkFile();
    updateBar();
    if (driver.isMedia && !$('mqMenu').hidden) renderMq();
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
  if (V.viewTimer) { clearTimeout(V.viewTimer); viewSave(); }
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
  V.el.classList.remove('is-media', 'is-audio', 'is-video');
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
function posWrite(map, fromDrive) {
  const keys = Object.keys(map);
  if (keys.length > POS_MAX) keys.sort((a, b) => map[a].t - map[b].t).slice(0, keys.length - POS_MAX).forEach((k) => delete map[k]);   // forget the oldest
  savePref(POS_KEY, JSON.stringify(map));
  if (!fromDrive) drivePush();
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
  if (finished || (media ? at < 10 : scroll ? at < .03 : at <= 0)) map[key] = { d: 1, t: Date.now() };     // at the start or at the very end there is nothing to continue
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
  let saved = trackable(d) ? posRead()[posKey(e)] : null;
  if (saved && saved.d) saved = null;
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
const UpNext = { open: false, anim: null, timer: 0, target: null };

/* ----- Which file follows a video / song: the class queue first, else the next media file of the same folder -----
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
  if (i >= 0 && MP.repeat !== 'all') { Q.items.splice(i, 1); queueChanged(); }
}
// The file ended: the next one starts at once
function mediaEnded(d) {
  const n = mediaNext(1);
  leaveQueued(V.entry);                          // played to the end: it leaves the class queue
  if (!n) return;
  V.autoplay = true;
  openViewer(n);
}
function upNextShow(entry) {
  if (!entry || UpNext.open) return;
  UpNext.target = entry;
  $('upnextText').textContent = 'Next: ' + (entry.base || entry.name);
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
  const to = UpNext.target; UpNext.target = null;
  if (go && to) { V.autoplay = true; openViewer(to); }       // the next video / song starts playing on its own
}
$('upnextYes').onclick = () => upNextClose(true);
$('upnextNo').onclick = () => upNextClose(false);

// Everything that only video / audio have: time, volume, speed, subtitles, repeat, pen
function updateMediaBar(d) {
  $('mTime').textContent = d.label();
  const muted = d.muted;
  $('mMuteIcon').setAttribute('href', muted ? '#i-mute' : '#i-volume');
  $('mMuteIcon2').setAttribute('href', muted ? '#i-mute' : '#i-volume');
  $('mMuteB').setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  $('mMuteB').dataset.tip = muted ? 'Unmute (M)' : 'Mute (M)';
  $('mVolume').value = muted ? 0 : Math.round(d.volume * 100);
  $('mVolVal').textContent = String($('mVolume').value);
  const rate = d.rate, normal = Math.abs(rate - 1) < 0.001;
  $('mSpeed').hidden = normal;                                   // the speed shows only when it is not normal
  $('mSpeed').textContent = fmtRate(rate);
  $('mSpeedVal').textContent = fmtRate(rate);
  $('mCC').hidden = !d.hasSubs;
  $('mCC').setAttribute('aria-pressed', String(d.subsOn));
  $('mSubs').setAttribute('aria-pressed', String(d.subsOn));
  $('mSubs').hidden = !d.hasSubs;
  $('mSubsFile').hidden = !d.hasPicture;
  if (d.loop !== (MP.repeat === 'one')) d.setLoop(MP.repeat === 'one');
  document.querySelectorAll('#mScope [data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === MP.scope)));
  $('mScopeRow').hidden = !hasFolders();
  const many = !!V.entry && playlist(V.entry).length > 1;
  $('mShufB').hidden = !many; $('mRepB').hidden = false;       // the same buttons for music and films
  $('mShufB').setAttribute('aria-pressed', String(MP.shuffle));
  $('mRepB').setAttribute('aria-pressed', String(MP.repeat !== 'off'));
  $('mRepB').dataset.mode = MP.repeat;
  $('mRepB').dataset.tip = 'Repeat: ' + (MP.repeat === 'off' ? 'off' : MP.repeat === 'all' ? 'the whole list' : 'this file');
  $('mPrevFile').disabled = !mediaHasNext(-1);
  $('mNextFile').disabled = !mediaHasNext(1);
  $('mPip').hidden = !d.canPip;
  $('mPip').setAttribute('aria-pressed', String(d.pip));
  const tracks = d.audioTracks;
  $('mDub').hidden = !tracks.length;
  if (tracks.length) $('mDubVal').textContent = d.audioTrackName(d.audioTrackIndex);
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
  $('vSidePrev').dataset.tip = ready && d.isMedia ? 'Back 5 seconds (←)' : 'Previous';
  $('vSideNext').dataset.tip = ready && d.isMedia ? 'Forward 5 seconds (→)' : 'Next';
  $('vSidePrev').setAttribute('aria-label', $('vSidePrev').dataset.tip); $('vSideNext').setAttribute('aria-label', $('vSideNext').dataset.tip);
  $('vOverview').disabled = !ready || !d.hasOverview || d.count < 2;
  $('vInk').disabled = !ready || !d.canDraw;
  $('vInk').setAttribute('aria-pressed', String(!!(window.Pen && Pen.on)));
  Marks.refresh();
  notesRefresh();
  if (typeof syncPresenterItem === 'function') syncPresenterItem();
  linkPush();

  // Video / audio: play button, big play button
  const media = ready && d.isMedia;
  $('mPlayIcon').setAttribute('href', media && d.playing ? '#i-pause' : '#i-play');
  $('mPlay').setAttribute('aria-label', media && d.playing ? 'Pause' : 'Play');
  $('mediaBig').hidden = !media || d.playing || !d.hasPicture || (window.Pen && Pen.on);      // sound only: the button in the bar is enough
  if (media) updateMediaBar(d);
  const lk = $('mLaser').querySelector('kbd'); if (lk) lk.hidden = media;       // in video / audio L jumps 10 seconds ahead
  updateQueueNav();
  if (window.Pen) Pen.sync();

  // “More” menu state
  $('mZoomVal').textContent = Math.round(V.view.zoom * 100) + '%';
  document.querySelectorAll('[data-fit]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.fit === V.view.fit));
    b.disabled = !ready || !d.canFit;
  });
  $('mRotL').closest('.menu-row').hidden = !(ready && d.canRotate);          // what a file can't do is not offered
  document.querySelector('[data-fit]').closest('.menu-row').hidden = !(ready && d.canFit);
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
function setZoom(value) { V.view.zoom = clamp(value, 0.25, 4); applyView(); viewSaveSoon(); }
function setFit(fit) { V.view.fit = fit; V.view.zoom = 1; applyView(); viewSaveSoon(); }
function rotate(dir) { V.view.rot = (V.view.rot + dir * 90 + 360) % 360; applyView(); viewSaveSoon(); }
/* Zoom, fit and rotation are remembered per file (name + size), like the place; the default view is not stored. */
const VIEW_KEY = 'fv-view';
function viewSaveSoon() { clearTimeout(V.viewTimer); V.viewTimer = setTimeout(viewSave, 600); }
function viewSave() {
  const e = V.entry, d = V.driver;
  V.viewTimer = 0;
  if (!e || !d || d.isMedia) return;
  let map = {}; try { map = JSON.parse(loadPref(VIEW_KEY, '{}')) || {}; } catch (x) { map = {}; }
  const v = V.view, key = posKey(e), now = Date.now();
  map[key] = v.zoom === 1 && v.fit === d.defaultFit && v.rot === 0 ? { d: 1, t: now } : { z: Math.round(v.zoom * 1000) / 1000, f: v.fit, r: v.rot, t: now };
  const keys = Object.keys(map);
  if (keys.length > POS_MAX) keys.sort((a, b) => map[a].t - map[b].t).slice(0, keys.length - POS_MAX).forEach((k) => delete map[k]);
  savePref(VIEW_KEY, JSON.stringify(map));
  drivePush();
}
function viewRestore(entry) {
  let s = null; try { s = (JSON.parse(loadPref(VIEW_KEY, '{}')) || {})[posKey(entry)]; } catch (x) { /* none */ }
  if (!s || s.d || typeof s.z !== 'number' || !['page', 'width'].includes(s.f) || ![0, 90, 180, 270].includes(s.r)) return;
  V.view.zoom = clamp(s.z, 0.25, 4); V.view.fit = s.f; V.view.rot = s.r;
}

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
// "Keep place on the drive": remembered pages are also written next to the files (Chrome / Edge, needs a chosen folder)
function applyDrive(on) { $('sDrive').setAttribute('aria-pressed', String(on)); driveStatus(); }
applyDrive(loadPref('fv-drive', '0') === '1');
$('sDrive').onclick = async () => {
  if (loadPref('fv-drive', '0') === '1') { savePref('fv-drive', '0'); applyDrive(false); return; }
  driveWarned = false;
  if (!state.handle) { showToast('Choose a folder first (Chrome or Edge)'); return; }
  let ok = false;
  try { ok = (await state.handle.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { /* refused */ }
  if (!ok) { showToast('Not allowed — the place is kept on this computer only'); return; }
  savePref('fv-drive', '1'); applyDrive(true);
  await driveLoad(); drivePush(posRead());
  showToast('Your place, bookmarks and settings now travel with the drive');
};
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

/* ----- Up next: the list of what plays after this file; drag the grip to change the order ----- */
function closeMq() { $('mqMenu').hidden = true; $('mQueue').removeAttribute('aria-expanded'); }
/* The window shows the playing file, then the songs put in the queue by hand (a small gap after them), then the rest of the
   playlist, 30 rows at a time; more rows are added while you scroll down. */
const MQ = { all: [], shown: 0, CHUNK: 30 };
function mqRow(it, withDir) {
  const x = it.e, row = h('div', 'mq-row' + (it.g === 'cur' ? ' current' : '') + (it.end ? ' mq-end' : ''));
  row._e = x; row._g = it.g;
  const grip = h('span', 'mq-grip'); grip.append(icon('i-grip')); grip.dataset.tip = 'Drag to change the order';
  const t = h('span', 'mq-t'); t.append(h('b', '', x.base || x.name));
  if (withDir && x.dir) t.append(h('small', '', x.dir.split('/').pop()));
  const num = h('span', 'mq-n'), numText = h('span', 'mq-num', it.g === 'q' ? '' : String(it.n));
  if (it.g === 'cur') numText.append(h('i', 'mq-now'));          // the dot of the playing file sits under its number
  num.append(numText);
  row.append(grip, num, t);
  if (it.g === 'q' || it.g === 'c') {                              // any file that is still to come can be taken out in advance
    const tip = it.g === 'q' ? 'Remove from the queue' : 'Skip it: take it out of the playlist';
    const x = h('button', 'mq-x'); x.type = 'button'; x.append(icon('i-x')); x.dataset.tip = tip; x.setAttribute('aria-label', tip);
    row.append(x);
  }
  return row;
}
function mqMore() {
  const from = MQ.shown;
  if (from >= MQ.all.length) return;
  const to = Math.min(MQ.all.length, from + MQ.CHUNK), withDir = MP.scope !== 'folder';
  $('mqList').append(...MQ.all.slice(from, to).map((it) => mqRow(it, withDir)));
  MQ.shown = to;
}
function renderMq() {
  const e = V.entry;
  if (!e) return;
  const list = ctxList(e), i = ctxBase(e, list), queued = queuedAfter(e), qset = new Set(Q.items.map((it) => it.entry));
  const all = [{ e, g: 'cur', n: list.indexOf(e) + 1 }];
  queued.forEach((x, k) => all.push({ e: x, g: 'q', n: k + 1, end: k === queued.length - 1 }));
  list.forEach((x, j) => { if (j > i && !qset.has(x)) all.push({ e: x, g: 'c', n: j + 1 }); });
  MQ.all = all; MQ.shown = 0;
  $('mqHead').textContent = 'Playlist · ' + list.length + (list.length === 1 ? ' file' : ' files');
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
  closeOverview(); closeVol();
  $('vMenu').hidden = true; $('vMore').removeAttribute('aria-expanded');
  V.menuOpen = true;
  $('mqMenu').hidden = false;
  $('mQueue').setAttribute('aria-expanded', 'true');
  renderMq();
  showUi();
}
$('mQueue').onclick = () => (!$('mqMenu').hidden ? closeMenu() : openMq());
$('mqList').addEventListener('click', (ev) => {
  const row = ev.target.closest('.mq-row');
  const rm = ev.target.closest('.mq-x');
  if (rm && row) {
    const top = $('mqList').scrollTop, i = queueIndexOf(row._e);
    if (row._g === 'q') { if (i >= 0) { Q.items.splice(i, 1); queueChanged(); } }
    else PL.list = PL.list.filter((x) => x !== row._e);                // skipped: it is not in this playlist any more (until the list is built again)
    renderMq(); $('mqList').scrollTop = top; updateBar();
    return;
  }
  if (!row || ev.target.closest('.mq-grip') || row._e === V.entry) return;
  V.autoplay = true;
  openViewer(row._e);
});
$('mqList').addEventListener('pointerdown', (ev) => {
  const grip = ev.target.closest('.mq-grip');
  if (!grip) return;
  const row = grip.parentNode;
  if (row._g === 'cur') return;                                       // the playing file stays where it is
  ev.preventDefault();
  const box = $('mqList');
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
    const e = V.entry, now = [...box.children].filter((r) => r._e && r._g === row._g);
    if (row._g === 'q') {                                              // the queue itself changes order
      const entries = now.map((r) => r._e);
      const slots = entries.map((x) => queueIndexOf(x)).sort((a, b) => a - b);
      const items = entries.map((x) => Q.items[queueIndexOf(x)]);
      slots.forEach((pos, k) => { Q.items[pos] = items[k]; });
      queueChanged();
    } else {                                                           // the playlist: the rows that were drawn, then the rest as it was
      const list = ctxList(e), i = ctxBase(e, list), qset = new Set(Q.items.map((it) => it.entry));
      const nowE = now.map((r) => r._e), drawn = new Set(nowE);
      let k = 0;                                                       // the drawn rows take their places in the new order; everything else stays put
      PL.list = list.slice(0, i + 1).concat(list.slice(i + 1).map((x) => (qset.has(x) || !drawn.has(x) ? x : nowE[k++])));
    }
    box.querySelectorAll('.mq-end').forEach((r) => r.classList.remove('mq-end'));
    const qrows = [...box.children].filter((r) => r._g === 'q');
    if (qrows.length) qrows[qrows.length - 1].classList.add('mq-end');
    [...box.children].filter((r) => r._g === 'q').forEach((r, k) => { r.querySelector('.mq-num').textContent = ''; });
    [...box.children].filter((r) => r._g === 'c').forEach((r) => { r.querySelector('.mq-num').textContent = String(PL.list.indexOf(r._e) + 1); });
    updateBar();
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', done); document.addEventListener('pointercancel', done);
});

/* ----- “More” menu ----- */
function openMenu() {
  closeOverview();
  closeMq(); closeVol();
  V.menuOpen = true;
  $('vMenu').hidden = false;
  $('vMore').setAttribute('aria-expanded', 'true');
  showUi();
}
function closeMenu() {
  V.menuOpen = false;
  closeMq(); closeVol();
  $('vMenu').hidden = true;
  $('vMore').removeAttribute('aria-expanded');
  showUi();
}
$('vMore').onclick = () => (V.menuOpen ? closeMenu() : openMenu());
document.addEventListener('pointerdown', (e) => {
  if (V.menuOpen && !e.target.closest('#vMenu, #vMore, #mMore, #mqMenu, #mQueue, #volPop, #mMute')) closeMenu();
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
if (!navigator.wakeLock) $('mAwake').hidden = true;           // this browser can't keep the screen on: no switch

/* ----- Buttons ----- */
// After any click the page gets the focus back, so Space and arrows keep turning pages
V.el.addEventListener('click', (e) => { if (e.target.closest('button')) V.stage.focus(); });
$('vClose').onclick = closeViewer;
$('vFull').onclick = toggleFullscreen;
$('vFirst').onclick = () => navigate('first');
$('vPrev').onclick = () => navigate('prev');
$('vNext').onclick = () => navigate('next');
$('vSidePrev').onclick = () => navigate('prev');
$('vSideNext').onclick = () => navigate('next');
$('vLast').onclick = () => navigate('last');
$('vOverview').onclick = () => (V.overviewOpen ? closeOverview() : openOverview());
$('qPrev').onclick = () => queueStep(-1);
$('qNext').onclick = () => queueStep(1);
$('mPlay').onclick = $('mediaBig').onclick = () => { if (V.driver && V.driver.isMedia) V.driver.toggle(); };
$('mBack').onclick = () => navigate('prev');
$('mFwd').onclick = () => navigate('next');
$('mMuteB').onclick = toggleMute;
function closeVol() { $('volPop').hidden = true; $('mMute').setAttribute('aria-expanded', 'false'); }
$('mMute').onclick = () => {
  if (!$('volPop').hidden) return closeMenu();
  closeOverview(); closeMq();
  $('vMenu').hidden = true; $('vMore').removeAttribute('aria-expanded');
  V.menuOpen = true;
  const pop = $('volPop'), vr = V.el.getBoundingClientRect(), br = $('mMute').getBoundingClientRect();
  pop.hidden = false;
  pop.style.right = 'auto';
  pop.style.left = Math.max(14, Math.min(vr.width - pop.offsetWidth - 14, br.left - vr.left + br.width / 2 - pop.offsetWidth / 2)) + 'px';
  $('mMute').setAttribute('aria-expanded', 'true');
  showUi();
};
$('mVolume').oninput = () => { const d = V.driver; if (d && d.isMedia) { d.setVolume($('mVolume').value / 100); $('mVolVal').textContent = $('mVolume').value; } };
$('mSpeed').onclick = $('mSpeedVal').onclick = () => { if (V.driver && V.driver.isMedia) V.driver.setRate(1); };
$('mSpeedDn').onclick = () => stepRate(-1);
$('mSpeedUp').onclick = () => stepRate(1);
$('mCC').onclick = $('mSubs').onclick = toggleSubs;
document.querySelectorAll('#mScope [data-scope]').forEach((b) => { b.onclick = () => { MP.scope = b.dataset.scope; PL.list = null; savePref('fv-mscope', MP.scope); updateBar(); if (!$('mqMenu').hidden) renderMq(); }; });
function setShuffle(on) {
  MP.shuffle = on; savePref('fv-mshuf', on ? '1' : '0');
  PL.list = null;                                  // a new list: mixed again each time shuffle is switched on, in folder order when it is off
  if (V.entry) playlist(V.entry);
  updateBar();
  if (!$('mqMenu').hidden) renderMq();
}
$('mShufB').onclick = () => setShuffle(!MP.shuffle);
$('mRepB').onclick = () => { MP.repeat = MP.repeat === 'off' ? 'all' : MP.repeat === 'all' ? 'one' : 'off'; savePref('fv-mrep', MP.repeat); updateBar(); };
$('mPrevFile').onclick = () => queueStep(-1);
$('mNextFile').onclick = () => queueStep(1);
$('mPip').onclick = () => { if (V.driver && V.driver.isMedia && V.driver.canPip) V.driver.togglePip(); };
$('mDub').onclick = () => { if (V.driver && V.driver.isMedia) V.driver.nextAudioTrack(); };
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
  try { await lib('ink'); Pen.restore(); Pen.toggle(); }
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
