'use strict';
/* Lectern — input in the viewer: drag, progress bar, mouse and touch, pinch zoom, keyboard. One of the app/*.js scripts (see the order in Lectern.html); it shares the global scope with the others. */

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
// With a mouse in fullscreen the bars stay out of the way: they come when the pointer goes to the bottom or top edge (both bars together),
// stay while the pointer is on them, and leave soon after it goes away. Moving the mouse in the middle does nothing.
// (A finger works differently: a tap in the middle shows or hides them.) The pointer itself hides after a moment without moving.
let hideBarsTimer = 0, cursorTimer = 0;
const barsShown = () => !V.el.classList.contains('ui-hidden');
function hideBarsSoon() {
  if (hideBarsTimer || !barsShown()) return;
  hideBarsTimer = setTimeout(() => { hideBarsTimer = 0; if (!V.uiHover && !V.menuOpen && !V.overviewOpen && V.immersive) V.el.classList.add('ui-hidden'); }, 600);
}
V.el.addEventListener('pointermove', (e) => {
  if (!V.immersive || e.pointerType !== 'mouse') return;
  V.el.classList.remove('cursor-idle');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => V.el.classList.add('cursor-idle'), 1500);
  const r = V.el.getBoundingClientRect(), shown = barsShown();
  const topH = V.el.querySelector('.vbar-top').getBoundingClientRect().height, botH = V.el.querySelector('.vbar-bottom').getBoundingClientRect().height;
  const fromBottom = r.bottom - e.clientY, fromTop = e.clientY - r.top;
  const inside = fromBottom <= Math.max(70, shown ? botH + 12 : 0) || fromTop <= Math.max(50, shown ? topH + 8 : 0);     // the bottom or top edge calls the bars, or the bars themselves
  V.uiHover = inside;
  if (inside) { clearTimeout(hideBarsTimer); hideBarsTimer = 0; showUi(); }
  else hideBarsSoon();
});
V.el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && V.immersive) { V.uiHover = false; hideBarsSoon(); } });
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
/* Two fingers are a pinch only when the distance between them really changes. On a touch board a swipe often lands as two contacts
   (finger + knuckle or palm) that travel together: that is a swipe, not a zoom, so it must not scale the page. */
V.stage.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 2 || Laser.on || (window.Pen && Pen.on)) return;
  const [a, b] = e.touches;
  pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, armed: false, swipe: false };
}, { passive: true });
V.stage.addEventListener('touchmove', (e) => {
  if (!pinch || pinch.swipe || e.touches.length !== 2) return;
  const [a, b] = e.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
  if (!pinch.armed) {
    const dd = Math.abs(d - pinch.d), dc = Math.hypot(cx - pinch.cx, cy - pinch.cy);
    if (dd > 20 && dd > dc) { pinch.armed = true; pinch.d = d || 1; zoomBegin(cx, cy); }     // the fingers moved apart / together: zoom
    else if (dc > 30) pinch.swipe = true;                                                     // they moved along together: a swipe, leave it alone
    return;
  }
  e.preventDefault();
  zoomMove(d / pinch.d);
}, { passive: false });
['touchend', 'touchcancel'].forEach((ev) => V.stage.addEventListener(ev, (e) => {
  if (!pinch || e.touches.length >= 2) return;
  const was = pinch.armed;
  pinch = null;
  if (was) { Zoomer.lastEnd = Date.now(); zoomEnd(); }
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
const starts = new Map();                  // every finger / pointer that is down: id -> where and when it started
V.stage.addEventListener('pointerdown', (e) => {
  const now = Date.now();
  starts.forEach((v, k) => { if (now - v.time > 1500) starts.delete(k); });     // a finger that lifted outside the page leaves no trace
  starts.set(e.pointerId, { x: e.clientX, y: e.clientY, time: Date.now(), primary: e.isPrimary });
});
V.stage.addEventListener('pointercancel', (e) => { starts.delete(e.pointerId); });
V.stage.addEventListener('pointerup', (e) => {
  const pointerStart = starts.get(e.pointerId);
  starts.delete(e.pointerId);
  if (!pointerStart) return;
  const dx = e.clientX - pointerStart.x;
  const dy = e.clientY - pointerStart.y;
  const touch = e.pointerType !== 'mouse';
  const held = Date.now() - pointerStart.time;
  if (Laser.on && touch) return;           // a finger is the laser: no swipes or edge taps
  if ((pinch && pinch.armed) || Date.now() - Zoomer.lastEnd < 400) return;     // the end of a pinch is not a tap
  const pageBased = V.driver && !(V.driver instanceof ScrollViewer) && !V.driver.isMedia;

  if (touch && pageBased && V.view.zoom <= 1 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    starts.clear();                                       // a second contact of the same swipe must not turn another page
    navigate(dx < 0 ? 'next' : 'prev');
    return;
  }
  if (!pointerStart.primary || pinch || starts.size) return;         // two or more contacts at once are never a tap
  // A finger on a big board is slower and less steady than a mouse click: a touch may last a little longer and wander a little
  // (not in scrolling documents, where a short drag is a scroll and must not turn a page)
  const slack = touch && (pageBased || (V.driver && V.driver.isMedia)) ? 22 : 10;
  if (held >= (touch ? 900 : 600) || Math.abs(dx) > slack || Math.abs(dy) > slack) return;
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
  V.el.style.setProperty('--bt', top.getBoundingClientRect().height + 'px');
  V.el.style.setProperty('--bb', bottom.getBoundingClientRect().height + 'px');
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

    if (V.driver && V.driver.isMedia && (e.code === 'KeyJ' || e.code === 'KeyL')) return act(() => { const k = e.code === 'KeyJ' ? -10 : 10; V.driver.skip(k); showToast(k > 0 ? '+10 s' : '−10 s'); showUi(); });
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
    case 'ArrowLeft':  e.preventDefault(); if (e.altKey) return foldersOn() ? folderUp() : undefined; return moveSelection(-1, 0);
    case 'ArrowDown':  e.preventDefault(); return moveSelection(0, 1);
    case 'ArrowUp':    e.preventDefault(); return moveSelection(0, -1);
    case ' ': {                                  // Space = details (like Quick Look)
      const entry = selectedEntry();
      if (entry) { e.preventDefault(); openInfo(entry); }
      return;
    }
    case 'Enter': {                              // Enter = open the file (a folder: go into it)
      if (activateSelected()) e.preventDefault();
      return;
    }
    case 'Backspace':                            // one folder up
      if (foldersOn() && state.path.length) { e.preventDefault(); folderUp(); }
      return;
    case '/': e.preventDefault(); $('search').focus(); return;
  }
  if (e.code === 'KeyQ') {                       // Q = add / remove the selected file in the class queue
    const entry = selectedEntry();
    if (entry) { e.preventDefault(); queueToggle(entry); }
  }
});
