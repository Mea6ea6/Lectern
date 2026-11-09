'use strict';
/* =====================================================================
   Lectern — pen, marker and eraser over the page (loaded on first use).

   • The file is never changed. Drawings live only in memory, per page, until the file is closed.
   • Strokes are stored relative to the page element (x and y both as a fraction of its WIDTH),
     so they follow zoom, scrolling and window size.
   • While Draw is on, the canvas catches the pointer, so the normal swipe / tap gestures are off;
     the arrows in the drawing bar (or the keys) still turn pages. Draw off = everything as before.
   ===================================================================== */

const Pen = (function () {
  const canvas = $('inkCanvas'), bar = $('inkBar');
  const ctx = canvas.getContext('2d');

  const COLORS = [
    ['#1c1c1c', 'Black'], ['#ffffff', 'White'], ['#e5322d', 'Red'],
    ['#1a73e8', 'Blue'], ['#1e9e57', 'Green'], ['#f5b400', 'Yellow'],
  ];
  // width = fraction of the page width (but never thinner than min px); alpha < 1 = see-through marker
  const TOOLS = {
    pen:    { width: 0.0035, min: 2.5, alpha: 1,    cap: 'round', color: '#e5322d' },
    marker: { width: 0.022,  min: 16,  alpha: 0.38, cap: 'butt',  color: '#f5b400' },
  };
  // thickness is a slider, 0..100 per tool (remembered per tool)
  const level = { pen: 20, marker: 27, eraser: 25 };
  const lerp = (a, b, t) => a + (b - a) * t;
  function sizeOf(tool) {
    const t = clamp(level[tool], 0, 100) / 100;
    if (tool === 'marker') return { width: lerp(0.008, 0.14, t), min: lerp(6, 80, t) };
    if (tool === 'eraser') return { radius: lerp(8, 60, t) };
    return { width: lerp(0.0015, 0.03, t), min: lerp(1.2, 22, t) };
  }

  const self = {
    on: false, tool: 'pen',
    pages: new Map(),          // key -> { strokes: [], undo: [], redo: [] }
  };
  let drawing = null;          // the stroke being drawn (or the eraser path)
  let frame = 0;

  /* ----- which page are we on, and where is it on the screen ----- */
  const key = () => (V.driver ? String(V.driver.inkKey()) : '');
  function page() {
    const k = key();
    if (!self.pages.has(k)) self.pages.set(k, { strokes: [], undo: [], redo: [] });
    return self.pages.get(k);
  }
  function rect() {                   // the page element, in canvas (viewport) coordinates
    const el = V.driver && V.driver.inkAnchor();
    const wrap = canvas.getBoundingClientRect();
    const r = el ? el.getBoundingClientRect() : wrap;
    return { x: r.left - wrap.left, y: r.top - wrap.top, w: Math.max(1, r.width) };
  }

  /* ----- drawing ----- */
  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, hh = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h: hh };
  }

  // Draws one stroke into any 2D context. o = top-left of the page, W = page width in that context's pixels
  function paintStroke(c, s, o, W) {
    const pts = s.pts;
    if (!pts.length) return;
    c.save();
    c.globalAlpha = s.alpha;
    c.strokeStyle = s.color; c.fillStyle = s.color;
    c.lineCap = s.cap; c.lineJoin = 'round';
    const lw = Math.max(s.min, s.w * W);
    c.lineWidth = lw;
    const X = (p) => o.x + p[0] * W, Y = (p) => o.y + p[1] * W;
    if (pts.length === 1) {
      c.beginPath(); c.arc(X(pts[0]), Y(pts[0]), lw / 2, 0, Math.PI * 2); c.fill();
    } else {
      c.beginPath();
      c.moveTo(X(pts[0]), Y(pts[0]));
      for (let i = 1; i < pts.length - 1; i++) {        // smooth curve through the midpoints
        const mx = (X(pts[i]) + X(pts[i + 1])) / 2, my = (Y(pts[i]) + Y(pts[i + 1])) / 2;
        c.quadraticCurveTo(X(pts[i]), Y(pts[i]), mx, my);
      }
      c.lineTo(X(pts[pts.length - 1]), Y(pts[pts.length - 1]));
      c.stroke();                                      // one path: a see-through marker doesn't darken where it crosses itself
    }
    c.restore();
  }

  function redraw() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(paintNow);
  }
  function paintNow() {
    const s = size();
    ctx.clearRect(0, 0, s.w, s.h);
    if (!self.on || !V.driver) return;
    const r = rect();
    for (const st of page().strokes) paintStroke(ctx, st, r, r.w);
    if (drawing && drawing.tool !== 'eraser') paintStroke(ctx, drawing.stroke, r, r.w);
  }

  /* ----- pointer ----- */
  function pos(e) {
    const wrap = canvas.getBoundingClientRect();
    return { x: e.clientX - wrap.left, y: e.clientY - wrap.top };
  }
  function down(e) {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const r = rect(), p = pos(e);
    const pt = [(p.x - r.x) / r.w, (p.y - r.y) / r.w];
    if (self.tool === 'eraser') {
      drawing = { tool: 'eraser', before: page().strokes.slice(), changed: false };
      erase(p);
    } else {
      const t = TOOLS[self.tool], z = sizeOf(self.tool);
      drawing = {
        tool: self.tool,
        stroke: { tool: self.tool, color: t.color, alpha: t.alpha, cap: t.cap, w: z.width, min: z.min, pts: [pt] },
      };
      redraw();
    }
  }
  function move(e) {
    if (!drawing || !e.isPrimary) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const p = pos(ev);
      if (drawing.tool === 'eraser') { erase(p); continue; }
      const r = rect();
      const pt = [(p.x - r.x) / r.w, (p.y - r.y) / r.w];
      const last = drawing.stroke.pts[drawing.stroke.pts.length - 1];
      if (Math.hypot((pt[0] - last[0]) * r.w, (pt[1] - last[1]) * r.w) >= 1.2) drawing.stroke.pts.push(pt);
    }
    redraw();
  }
  function up(e) {
    if (!drawing || !e.isPrimary) return;
    const d = drawing;
    drawing = null;
    if (d.tool === 'eraser') {
      if (d.changed) { page().undo.push(d.before); page().redo = []; trimUndo(); }
    } else {
      const pg = page();
      pg.undo.push(pg.strokes.slice()); pg.redo = []; trimUndo();
      pg.strokes.push(d.stroke);
    }
    redraw();
    refreshButtons();
  }
  function trimUndo() { const u = page().undo; while (u.length > 60) u.shift(); }

  // Rubs out only the part of a line under the eraser: the line is cut into two (or more) pieces.
  // Measured on the screen, so it feels the same at any zoom.
  function erase(p) {
    const r = rect(), pg = page(), rad = sizeOf('eraser').radius;
    const out = [];
    let touched = false;
    for (const s of pg.strokes) {
      const half = Math.max(s.min, s.w * r.w) / 2, hit = rad + Math.min(half, rad * 0.6);   // the line's own width counts a little
      const X = (pt) => r.x + pt[0] * r.w, Y = (pt) => r.y + pt[1] * r.w;
      // add points along long segments so a cut can fall between two stored points
      const pts = [s.pts[0]];
      for (let i = 1; i < s.pts.length; i++) {
        const a = s.pts[i - 1], b = s.pts[i], len = Math.hypot((b[0] - a[0]) * r.w, (b[1] - a[1]) * r.w);
        const n = Math.min(60, Math.floor(len / Math.max(2, rad / 3)));
        for (let k = 1; k <= n; k++) pts.push([a[0] + (b[0] - a[0]) * k / (n + 1), a[1] + (b[1] - a[1]) * k / (n + 1)]);
        pts.push(b);
      }
      const inside = pts.map((pt) => Math.hypot(X(pt) - p.x, Y(pt) - p.y) <= hit);
      if (!inside.some(Boolean)) { out.push(s); continue; }
      touched = true;
      let run = [];
      const flush = () => { if (run.length > 1) out.push(Object.assign({}, s, { pts: run })); run = []; };
      pts.forEach((pt, i) => { if (inside[i]) flush(); else run.push(pt); });
      flush();
    }
    if (touched) { pg.strokes = out; drawing.changed = true; redraw(); }
  }

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('lostpointercapture', up);
  // The mouse wheel still scrolls long documents under the drawing
  canvas.addEventListener('wheel', (e) => { V.stage.scrollBy(e.deltaX, e.deltaY); }, { passive: true });
  V.stage.addEventListener('scroll', () => { if (self.on) redraw(); }, { passive: true });

  /* ----- the drawing bar ----- */
  const sizeInput = $('inkSize'), sizeDot = $('inkDot');
  const colorBox = $('inkColors');
  COLORS.forEach(([hex, name]) => {
    const b = h('button', 'ink-swatch');
    b.type = 'button'; b.title = name; b.setAttribute('aria-label', name);
    b.dataset.color = hex;
    b.style.setProperty('--sw', hex);
    b.onclick = () => { setColor(hex); };
    colorBox.appendChild(b);
  });

  function setColor(hex) {
    if (self.tool === 'eraser') self.tool = 'pen';
    TOOLS[self.tool].color = hex;
    savePref('fv-ink-' + self.tool, hex);
    refreshButtons();
  }
  function setTool(tool) {
    self.tool = tool;
    savePref('fv-ink-tool', tool);
    refreshButtons();
  }
  function refreshButtons() {
    bar.querySelectorAll('[data-ink-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.inkTool === self.tool)));
    const cur = self.tool === 'eraser' ? null : TOOLS[self.tool].color;
    colorBox.classList.toggle('off', self.tool === 'eraser');
    colorBox.querySelectorAll('.ink-swatch').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === cur)));
    const pg = V.driver ? page() : { strokes: [], undo: [], redo: [] };
    $('inkUndo').disabled = !pg.undo.length;
    $('inkRedo').disabled = !pg.redo.length;
    sizeInput.value = String(level[self.tool]);
    sizeInput.style.setProperty('--fill', level[self.tool] + '%');
    const dot = sizeDot.style, dm = { pen: [2, 26], marker: [6, 26], eraser: [6, 26] }[self.tool];
    dot.width = dot.height = lerp(dm[0], dm[1], level[self.tool] / 100) + 'px';
    dot.opacity = self.tool === 'marker' ? '.45' : '1';
    const lbl = V.driver && V.driver.label ? V.driver.label() : '';
    $('inkPos').textContent = lbl.replace(/^Page /, '').replace(' of ', ' / ');
    $('inkClear').disabled = !pg.strokes.length;
    $('inkSave').disabled = !pg.strokes.length;
    canvas.style.cursor = self.tool === 'eraser' ? 'cell' : 'crosshair';
    $('vInk').setAttribute('aria-pressed', String(self.on));
  }
  bar.querySelectorAll('[data-ink-tool]').forEach((b) => { b.onclick = () => setTool(b.dataset.inkTool); });
  sizeInput.oninput = () => { level[self.tool] = +sizeInput.value; savePref('fv-ink-sz-' + self.tool, String(level[self.tool])); refreshButtons(); };

  /* ----- the bar can be dragged out of the way (by the grip on its left) ----- */
  const grip = $('inkGrip');
  let drag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const b = bar.getBoundingClientRect(), host = bar.offsetParent.getBoundingClientRect();
    drag = { dx: e.clientX - b.left, dy: e.clientY - b.top, host };
    bar.classList.add('moving');
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    const x = clamp(e.clientX - drag.dx - drag.host.left, 4, drag.host.width - bw - 4);
    const y = clamp(e.clientY - drag.dy - drag.host.top, 4, drag.host.height - bh - 4);
    bar.style.left = x + 'px'; bar.style.top = y + 'px'; bar.style.bottom = 'auto'; bar.style.transform = 'none';
  });
  const dropBar = () => { drag = null; bar.classList.remove('moving'); };
  grip.addEventListener('pointerup', dropBar);
  grip.addEventListener('pointercancel', dropBar);
  function homeBar() { bar.style.left = bar.style.top = bar.style.bottom = bar.style.transform = ''; }

  function undo() {
    const pg = page();
    if (!pg.undo.length) return;
    pg.redo.push(pg.strokes);
    pg.strokes = pg.undo.pop();
    redraw(); refreshButtons();
  }
  function redo() {
    const pg = page();
    if (!pg.redo.length) return;
    pg.undo.push(pg.strokes);
    pg.strokes = pg.redo.pop();
    redraw(); refreshButtons();
  }
  function clear() {
    const pg = page();
    if (!pg.strokes.length) return;
    pg.undo.push(pg.strokes.slice()); pg.redo = []; trimUndo();
    pg.strokes = [];
    redraw(); refreshButtons();
    showToast('Cleared — Undo brings it back');
  }
  $('inkUndo').onclick = undo;
  $('inkRedo').onclick = redo;
  $('inkClear').onclick = clear;
  $('inkDone').onclick = () => toggle();
  $('inkPrev').onclick = () => navigate('prev');
  $('inkNext').onclick = () => navigate('next');
  $('inkSave').onclick = () => save();

  /* ----- save as a picture ----- */
  // PDF pages and photos are saved together with the drawing; for everything else only the drawing is saved
  // (a slide or a Word page can't be photographed without internet-sized tools), on a transparent background.
  async function save() {
    const pg = page();
    if (!pg.strokes.length || !V.driver) return;
    const anchor = V.driver.inkAnchor();
    let out = document.createElement('canvas'), withPage = false;
    const r = rect();
    if (anchor && anchor.tagName === 'CANVAS') {                    // a PDF page: its own pixels
      out.width = anchor.width; out.height = anchor.height;
      out.getContext('2d').drawImage(anchor, 0, 0);
      withPage = true;
    } else if (anchor && anchor.querySelector && anchor.querySelector('img') && V.entry && V.entry.kind === 'image') {   // a photo
      const img = anchor.querySelector('img');
      out.width = img.naturalWidth || 1000; out.height = img.naturalHeight || 700;
      out.getContext('2d').drawImage(img, 0, 0, out.width, out.height);
      withPage = true;
    }
    if (withPage) {
      const c = out.getContext('2d');
      for (const s of pg.strokes) paintStroke(c, s, { x: 0, y: 0 }, out.width);
    } else {
      const dpr = 2, w = canvas.clientWidth, hh = canvas.clientHeight;
      out.width = w * dpr; out.height = hh * dpr;
      const c = out.getContext('2d');
      c.scale(dpr, dpr);
      for (const s of pg.strokes) paintStroke(c, s, r, r.w);
    }
    const blob = await new Promise((ok) => out.toBlob(ok, 'image/png'));
    if (!blob) { showToast('Could not save the picture'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const base = V.entry ? V.entry.base : 'drawing';
    a.download = base + ' — drawing.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    showToast(withPage ? 'Saved the page with your drawing' : 'Saved your drawing (without the page) as a transparent picture');
  }

  /* ----- on / off ----- */
  function toggle() {
    if (!self.on) {
      if (!V.driver || !V.driver.canDraw) return;
      self.on = true;
      canvas.hidden = false;
      bar.hidden = false;
      V.el.classList.add('inking');
    } else {
      self.on = false;
      drawing = null;
      homeBar();
      canvas.hidden = true;
      bar.hidden = true;
      V.el.classList.remove('inking');
    }
    refreshButtons();
    redraw();
    V.stage.focus();
  }

  // The drawings (and drawing mode) belong to one opening of one file
  function reset() {
    self.pages.clear();
    if (self.on) toggle();
    refreshButtons();
  }

  // Called by app.js whenever the page, zoom or label may have changed
  function sync() { if (self.on) { refreshButtons(); redraw(); } }

  // Remembered choices
  const t = loadPref('fv-ink-tool', 'pen');
  for (const n of ['pen', 'marker', 'eraser']) { const raw = loadPref('fv-ink-sz-' + n, ''); const v = +raw; if (raw !== '' && v >= 0 && v <= 100) level[n] = v; }
  if (t === 'pen' || t === 'marker' || t === 'eraser') self.tool = t;
  for (const name of ['pen', 'marker']) {
    const c = loadPref('fv-ink-' + name, '');
    if (COLORS.some(([hex]) => hex === c)) TOOLS[name].color = c;
  }
  refreshButtons();

  Object.assign(self, { toggle, reset, sync, redraw, undo, redo, setTool });
  return self;
})();
window.Pen = Pen;
