'use strict';
/* =====================================================================
   Lectern — "Keep place on the drive" (optional, Chrome / Edge, needs a chosen folder)

   When the switch in the More menu is on, what Lectern remembers is also written next to your files, so it travels with the drive:
     Lectern-memory.json    place in each file (pos), bookmarks (marks), zoom / fit / rotation (view), recently opened (recent), settings (set)
     Lectern-drawings.json  pen and marker drawings, per file and page
   Every entry carries a time `t`; when a folder is opened the newer entry wins. A removed entry stays as a tombstone {d:1,t}
   so it does not come back from the other computer. Files are written a moment after a change (the browser must already
   have write permission: it is asked when the switch is turned on, or on Reopen).
   Without the permission everything keeps working from this browser's own storage.
   ===================================================================== */
const MEMORY_FILE = 'Lectern-memory.json', INK_FILE = 'Lectern-drawings.json';
const SYNC_MAPS = { pos: 'fv-pos', marks: 'fv-marks', view: 'fv-view', recent: 'fv-recent' };
const SYNC_PREFS = ['fv-theme', 'fv-large', 'fv-hints', 'fv-anim'];
const INK_MAX = 60;                                  // drawn files kept in the drawings file (the oldest go first)
let driveApplying = false, driveTimer = 0, inkDirty = false, driveWarned = false;
const driveLast = { ok: 0, failed: false };      // result of the latest write, for the status line in the menu
const DriveInk = {};                                 // 'name|size' -> { t, pages: { pageKey: [strokes] } }

const driveOn = () => loadPref('fv-drive', '0') === '1' && !!state.handle;
async function driveWritable() {
  try { return !!state.handle && (await state.handle.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { return false; }
}
function driveMerge(local, remote) {
  let changed = false;
  for (const k in remote) {
    const r = remote[k];
    if (r && typeof r.t === 'number' && (!local[k] || (local[k].t || 0) < r.t)) { local[k] = r; changed = true; }
  }
  return changed;
}
const mapRead = (key) => { try { return JSON.parse(loadPref(key, '{}')) || {}; } catch (e) { return {}; } };
async function readJson(name) {
  try { return JSON.parse(await (await (await state.handle.getFileHandle(name)).getFile()).text()); } catch (e) { return null; }
}
async function writeJson(name, obj) {
  const w = await (await state.handle.getFileHandle(name, { create: true })).createWritable();
  await w.write(JSON.stringify(obj));
  await w.close();
}

function settingsNow() {
  const s = { t: +loadPref('fv-set-t', '0') };
  for (const k of SYNC_PREFS) { const v = loadPref(k, null); if (v !== null) s[k] = v; }
  return s;
}
function applySettings(s) {
  driveApplying = true;
  try {
    for (const k of SYNC_PREFS) if (typeof s[k] === 'string') savePref(k, s[k]);
    if (s['fv-theme']) setAppearance('theme', s['fv-theme']);
    if (s['fv-large'] != null) applyLarge(s['fv-large'] === '1');
    if (s['fv-hints'] != null) applyHints(s['fv-hints'] === '1');
    if (s['fv-anim'] != null) { V.pageAnim = s['fv-anim'] === '1'; if (!V.el.hidden && V.driver) updateBar(); }
    savePref('fv-set-t', String(s.t));
  } finally { setTimeout(() => { driveApplying = false; }, 800); }       // the theme change runs a moment later
}
function driveSettingChanged(key) {                  // called by savePref
  if (driveApplying || !SYNC_PREFS.includes(key)) return;
  try { localStorage.setItem('fv-set-t', String(Date.now())); } catch (e) { /* fine */ }
  drivePush();
}

// Read the files from the drive and merge them into this browser's memory
async function driveLoad() {
  if (!driveOn()) return;
  if (!(await driveWritable())) { driveWarn(); return; }
  let remote = await readJson(MEMORY_FILE);
  if (remote) {
    if (!remote.v) remote = { v: 2, pos: remote };   // v1.21.0 wrote the positions only
    for (const name in SYNC_MAPS) {
      if (!remote[name]) continue;
      const local = mapRead(SYNC_MAPS[name]);
      if (driveMerge(local, remote[name])) savePref(SYNC_MAPS[name], JSON.stringify(local));
    }
    if (remote.set && remote.set.t > +loadPref('fv-set-t', '0')) applySettings(remote.set);
  }
  const ink = await readJson(INK_FILE);
  if (ink && ink.files) driveMerge(DriveInk, ink.files);
  if (typeof Marks !== 'undefined') Marks.reload();
  if (typeof renderRecent === 'function') renderRecent();
  if (V.entry && window.Pen) Pen.restore();
}

function driveWarn() {                                // said once per session, and only when the switch is on but nothing can be written
  if (driveWarned) return;
  driveWarned = true;
  showToast('Not saved to the drive — see More', 3200);
}
function drivePush() {
  if (loadPref('fv-drive', '0') !== '1') return;
  clearTimeout(driveTimer);
  driveTimer = setTimeout(async () => {
    try {
      if (!state.handle || !(await driveWritable())) { driveWarn(); driveStatus(); return; }
      const out = { v: 2, set: settingsNow() };
      for (const name in SYNC_MAPS) out[name] = mapRead(SYNC_MAPS[name]);
      await writeJson(MEMORY_FILE, out);
      if (inkDirty) {
        const keys = Object.keys(DriveInk);
        if (keys.length > INK_MAX) keys.sort((a, b) => DriveInk[a].t - DriveInk[b].t).slice(0, keys.length - INK_MAX).forEach((k) => delete DriveInk[k]);
        await writeJson(INK_FILE, { v: 1, files: DriveInk });
        inkDirty = false;
      }
      driveLast.ok = Date.now(); driveLast.failed = false;
    } catch (e) { console.warn('Could not write to the drive:', e); driveLast.failed = true; }
    driveStatus();
  }, 1500);
}

// Drawings: Pen (modules/ink.js) hands over the strokes of the open file after every change
function driveInkSet(key, pages) {
  if (!driveOn()) return;
  DriveInk[key] = Object.keys(pages).length ? { t: Date.now(), pages } : { d: 1, t: Date.now() };
  inkDirty = true;
  drivePush();
}
const driveInkGet = (key) => (DriveInk[key] && !DriveInk[key].d ? DriveInk[key].pages : null);

// The grey line under the switch in the More menu: only visible while the switch is on
async function driveStatus() {
  const sub = $('sDriveSub');
  if (!sub) return;
  const on = loadPref('fv-drive', '0') === '1';
  sub.hidden = !on;
  if (!on) return;
  sub.replaceChildren();
  let text;
  if (!state.handle) text = 'Choose a folder first (Chrome or Edge)';
  else if (!(await driveWritable())) {
    sub.append('Needs permission ');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn-link'; b.textContent = 'Allow';
    b.onclick = async (e) => {
      e.stopPropagation();
      try { await state.handle.requestPermission({ mode: 'readwrite' }); } catch (x) { /* refused */ }
      await driveLoad(); drivePush(); driveStatus();
    };
    sub.append(b);
    return;
  } else if (driveLast.failed) text = 'Could not write — is the drive plugged in?';
  else if (driveLast.ok) text = 'Saved to the drive · ' + new Date(driveLast.ok).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  else text = 'Ready — saves as you go';
  sub.textContent = text;
}
['btnSettings', 'vMore', 'mMore'].forEach((id) => { const b = $(id); if (b) b.addEventListener('click', driveStatus); });
