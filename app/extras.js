'use strict';
/* Lectern — Tooltips, bookmarks, speaker notes.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, list.js, viewers.js, viewer-ui.js, extras.js, presenter.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

/* =====================================================================
   Tooltips: small designed hints instead of the browser's plain ones.
   Any element with a title (or an icon-only button with an aria-label) gets one;
   it appears after a short pause (like macOS: about 0.7 s), and the next one right away.
   A title ending in "(Key)" or "(Key or Key)" shows the keys as little keycaps.
   ===================================================================== */
const Tip = (function () {
  const el = $('tip');
  const DELAY = 700;
  const canHover = window.matchMedia && matchMedia('(hover: hover)').matches;
  let timer = 0, target = null, visible = false;
  const KEYS = /^(.*?)\s*\(([^()\s]{1,10}(?:\s+or\s+[^()\s]{1,10})*)\)\s*$/;

  function adopt(root) {
    if (!root || root.nodeType !== 1) return;
    const list = root.matches('[title], button[aria-label]') ? [root] : [];
    list.push(...root.querySelectorAll('[title], button[aria-label]'));
    for (const n of list) {
      if (n.classList.contains('card')) continue;                    // the card shows its own name; the browser's hint helps with long names
      const title = n.getAttribute('title');
      if (title) {
        n.dataset.tip = title;
        n.removeAttribute('title');
        if (!n.hasAttribute('aria-label') && !n.textContent.trim()) n.setAttribute('aria-label', title.replace(/\s*\([^()]*\)\s*$/, ''));
      } else if (!n.dataset.tip && !n.textContent.trim() && n.getAttribute('aria-label')) {
        n.dataset.tip = n.getAttribute('aria-label');
      }
    }
  }
  adopt(document.body);
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') adopt(r.target); else r.addedNodes.forEach(adopt);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  function hide() {
    clearTimeout(timer);
    target = null;
    if (visible) { visible = false; el.classList.remove('show'); el.setAttribute('aria-hidden', 'true'); }
  }
  // A copy of the tooltip as it looks right now (even half faded) that fades out on its own and removes itself
  function ghostOfCurrent() {
    const cs = getComputedStyle(el), o = parseFloat(cs.opacity);
    if (!(o > 0.05)) return false;
    const g = el.cloneNode(true);
    g.removeAttribute('id'); g.classList.remove('show'); g.classList.add('tip-ghost');
    g.style.transition = 'none'; g.style.opacity = String(o); g.style.transform = cs.transform;
    document.body.appendChild(g);
    requestAnimationFrame(() => requestAnimationFrame(() => { g.style.transition = ''; g.style.opacity = '0'; }));
    setTimeout(() => g.remove(), 260);
    return true;
  }
  function show(node) {
    if (!node.isConnected || !node.matches(':hover')) return;
    const raw = node.dataset.tip || '';
    const m = raw.match(KEYS);
    const label = m ? m[1] : raw;
    const keys = m ? m[2].split(/\s+or\s+/) : [];
    if (!keys.length && label.trim().toLowerCase() === node.textContent.trim().toLowerCase()) return;   // the button already says it
    const ghosted = ghostOfCurrent();                          // the old tooltip fades out while this one fades in
    el.style.transitionDelay = ghosted ? '.07s' : '0s';
    if (ghosted) { el.style.transition = 'none'; el.style.opacity = '0'; }   // start the new one from invisible, not from the half-faded old one
    el.replaceChildren(h('span', '', label), ...keys.map((k) => h('kbd', '', k)));
    const r = node.getBoundingClientRect();
    el.style.left = '0px'; el.style.top = '0px';
    const w = el.offsetWidth, hh = el.offsetHeight;
    let y = r.top - hh - 10, below = false;
    if (y < 8) { y = r.bottom + 10; below = true; }
    el.style.setProperty('--ty', below ? '-4px' : '4px');
    el.style.left = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8) + 'px';
    el.style.top = y + 'px';
    visible = true;
    el.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => { el.style.transition = ''; el.style.opacity = ''; el.classList.add('show'); });
  }

  if (canHover) {
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t === target) return;
      hide();
      if (!t) return;
      target = t;
      timer = setTimeout(() => show(t), DELAY);                              // every new button starts the wait again

    }, true);
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) hide(); }, true);
    ['pointerdown', 'keydown', 'wheel', 'scroll', 'blur'].forEach((ev) => window.addEventListener(ev, hide, true));
  }
  return { hide };
})();

/* =====================================================================
   Bookmarks: M marks or unmarks the current page; , and . jump to the previous / next mark.
   Marks are remembered per file (name + size) on this computer; they show on the progress bar
   and in the overview.
   ===================================================================== */
const Marks = (function () {
  let all = {};
  try { all = JSON.parse(localStorage.getItem('fv-marks') || '{}') || {}; } catch (e) { all = {}; }
  let sig = '';
  const key = () => (V.entry ? V.entry.path + '|' + V.entry.size : '');
  const total = (d) => (d.pages && d.pages.length > 1 ? d.pages.length : d.count);
  const usable = () => { const d = V.driver; return !!d && !d.isMedia && $('vMsg').hidden && total(d) > 1; };
  const list = () => all[key()] || [];
  function save() {
    const keys = Object.keys(all);
    if (keys.length > 300) delete all[keys[0]];
    try { localStorage.setItem('fv-marks', JSON.stringify(all)); } catch (e) { /* private window: marks last until the page closes */ }
  }
  function ratio(d, i, n) {                                  // where the mark of page i sits on the progress bar
    if (d instanceof ScrollViewer && d.pages && d.pages[i]) {
      const st = d.stage, room = st.scrollHeight - st.clientHeight;
      const top = d.pages[i].getBoundingClientRect().top - st.getBoundingClientRect().top + st.scrollTop;
      return room > 0 ? clamp(top / room, 0, 1) : 0;
    }
    return n > 1 ? i / (n - 1) : 0;
  }
  function toggle() {
    if (!usable()) { showToast('Bookmarks need a file with pages'); return; }
    const i = V.driver.currentIndex(), k = key(), arr = list().slice();
    const at = arr.indexOf(i);
    if (at >= 0) arr.splice(at, 1); else arr.push(i);
    arr.sort((a, b) => a - b);
    if (arr.length) all[k] = arr; else delete all[k];
    save(); sig = ''; refresh();
    showToast(at >= 0 ? 'Bookmark removed' : 'Bookmarked page ' + (i + 1));
  }
  function jump(dir) {
    if (!usable()) return;
    const cur = V.driver.currentIndex(), arr = list();
    const to = dir > 0 ? arr.find((i) => i > cur) : arr.slice().reverse().find((i) => i < cur);
    if (to === undefined) { showToast(arr.length ? 'No more bookmarks' : 'No bookmarks yet — press M'); return; }
    V.driver.goTo(to);
  }
  function refresh() {
    const ok = usable(), d = V.driver;
    $('vMark').disabled = !ok;
    $('vMark').setAttribute('aria-pressed', String(ok && list().includes(d.currentIndex())));
    const arr = ok ? list() : [];
    const s = key() + '|' + arr.join(',') + '|' + (ok ? total(d) + '|' + V.view.zoom + '|' + V.view.fit + '|' + (d.stage ? d.stage.scrollHeight : 0) : '');
    if (s === sig) return;
    sig = s;
    $('vMarks').replaceChildren(...arr.map((i) => { const t = document.createElement('i'); t.style.left = (ratio(d, i, total(d)) * 100) + '%'; return t; }));
  }
  return { toggle, jump, refresh, has: (i) => list().includes(i) };
})();
$('vMark').onclick = () => Marks.toggle();

/* =====================================================================
   Speaker notes (PPTX and ODP): N opens a side panel with the notes of the slide on screen.
   ===================================================================== */
const Notes = { open: false };
function notesFill() {
  const d = V.driver;
  if (!Notes.open || !d) return;
  const i = d.currentIndex(), text = d.notesFor(i);
  $('notesTitle').textContent = 'Notes · slide ' + (i + 1);
  $('notesBody').textContent = text || 'No notes for this slide.';
  $('notesBody').classList.toggle('empty', !text);
}
function notesRefresh() {
  const d = V.driver, has = !!d && !!d.hasNotes && $('vMsg').hidden;
  $('mNotes').disabled = !has;
  if (Notes.open && !has) notesToggle(false);
  else notesFill();
}
function notesToggle(force) {
  const d = V.driver;
  if (!d || !d.hasNotes) { if (force !== false) showToast('This file has no speaker notes'); return; }
  Notes.open = force === undefined ? !Notes.open : !!force;
  $('notes').hidden = !Notes.open;
  V.el.classList.toggle('notes-open', Notes.open);
  notesFill();
}
function notesReset() {
  Notes.open = false;
  $('notes').hidden = true;
  V.el.classList.remove('notes-open');
}
$('notesClose').onclick = () => notesToggle(false);
$('mNotes').onclick = () => { closeMenu(); notesToggle(); };
