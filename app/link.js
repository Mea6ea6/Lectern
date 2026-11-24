'use strict';
/* Lectern — Presenter view: the link between the two windows.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, queue.js, thumbs.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, link.js, presenter.js, companion.js, start.js. They are plain scripts that share one global scope
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
  items: [],                // presenter: the files of the strip that the companion shows (by their number)
  last: '', resent: 0,
  rem: null,                // companion: the file of the presenter { key, name, viewer, ratio, notes, ready }
  pos: null,                // companion: where the presenter is { key, index, count }
  peek: null,               // companion: draws small slides
  blank: 0,                 // companion: waits a moment before it believes that the presenter shows nothing
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
      if (Link.role === 'companion') {
        clearTimeout(Link.blank);
        if (m.key) { Link.pos = m; pvRender(); }
        else Link.blank = setTimeout(() => {          // "nothing" between two files is not news: the panel waits a moment for the next one
          Link.pos = m; Link.rem = null;
          if (Link.peek) { Link.peek.destroy(); Link.peek = null; }
          pvNowKind(''); pvRender();
        }, 1200);
      }
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
