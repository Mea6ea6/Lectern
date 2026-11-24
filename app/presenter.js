'use strict';
/* Lectern — Presenter view: the presentation window (it owns the slide).  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, queue.js, thumbs.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, link.js, presenter.js, companion.js, start.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

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
    if (!d.hasPicture && url) { Link.pic = url; Link.picKey = Link.key; }     // a cover that was still loading is looked for again
    return url;
  } catch (err) { return ''; }                  // a picture that cannot be read is simply not shown
}
function linkPush(force) {
  if (Link.role !== 'presenter') return;
  const d = V.driver, ok = !!Link.key && !!d && $('vMsg').hidden;
  let s = { t: 'state', key: 0 };
  if (ok) {
    if (d.isMedia && !Link.alive && !force) return;
    // The files of the queue (a video or a song: the playlist), in one list for every kind of file. The second window refers to a file by its number in it.
    const rows = d.isMedia ? upNextEntries() : (queueIndexOf(V.entry) >= 0 ? queueEntries() : []);
    Link.items = rows.map((r) => r.e);
    s = { t: 'state', key: Link.key, qs: rows.slice(0, 60).map((r, i) => ({ i, n: r.title, tag: r.e.tag, k: r.e.kind, g: r.g })) };
    if (d.isMedia) s.media = { playing: d.playing, time: Math.floor(d.el.currentTime || 0), dur: d.el.duration || 0 };
    else { s.index = d.currentIndex(); s.count = d.count; }
  }
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

$('mPresenter').onclick = () => { if (presenterOn()) { closeMenu(); presenterStop(); } else presenterStart(); };
