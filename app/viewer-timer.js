'use strict';
/* Lectern — the speaker's timer (a pill in the bar and its dialog; silent). One of the app/*.js scripts (see the order in Lectern.html); it shares the global scope with the others. */

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
