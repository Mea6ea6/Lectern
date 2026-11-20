'use strict';
/* Lectern — Viewer drivers: PDF, PPTX, images, DOCX, text, XLSX.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, list.js, viewers.js, viewer-ui.js, extras.js, presenter.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

/* ---------------------------------------------------------------------
   7. VIEWERS
   Each file type has its own class. They all offer the same things:
     open(file)      open the file
     go(where)       'first' | 'prev' | 'next' | 'last'
     goTo(i)         jump to page/slide/sheet number i (0-based)
     seek(ratio)     jump to a place 0..1 (used by the progress bar)
     label()         text like "Slide 3 of 12"
     progress()      0..1 for the progress bar
     atStart/atEnd   are we at the beginning / the end?
     refit()         re-fit after a size / zoom / rotation change
     renderThumb()   draw one overview thumbnail
     destroy()       clean up
     inkKey()        which page the pen drawing belongs to; inkAnchor() the element it is measured against
   Shared view settings (zoom, fit, rotation) arrive as `this.view`.
   --------------------------------------------------------------------- */

class BaseViewer {
  constructor(content, stage, view) {
    // Where we draw. A viewer that was closed while its file was still loading (double click, quick Esc, next file)
    // must not draw afterwards into the screen that now belongs to another file, so writes stop once it is destroyed.
    this.dead = false;
    this.content = content;
    this.stage = stage;         // the scrollable area around it
    this.view = view;           // { zoom, fit: 'page' | 'width', rot: 0 | 90 | 180 | 270 }
    this.onChange = () => {};   // tells the window to refresh label and buttons
    this.canFit = false;
    this.canRotate = false;
    this.hasOverview = false;
    this.defaultFit = 'page';
    this.canDraw = true;        // pen / marker allowed
    this.isMedia = false;       // video / audio have their own tiny controls
  }

  // Pen drawing: which page it belongs to, and the element it is anchored to (so it follows zoom and scroll)
  inkKey() { return this.index; }
  inkAnchor() { return this.content; }

  // Space available for the page (the content has padding around it; in fullscreen it has none)
  free() {
    const cs = getComputedStyle(this.content);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    return {
      w: Math.max(100, this.stage.clientWidth - padX),
      h: Math.max(100, this.stage.clientHeight - padY),
    };
  }

  get count() { return 1; }
  get index() { return 0; }
  notesFor() { return ''; }          // speaker notes of page i (PPTX / ODP)
  get hasNotes() { return false; }
  goTo() {}
  go(where) {
    const i = this.index, last = this.count - 1;
    this.goTo(clamp({ first: 0, prev: i - 1, next: i + 1, last }[where], 0, last));
  }
  seek(ratio) { if (this.count > 1) this.goTo(Math.round(ratio * (this.count - 1))); }
  label() { return ''; }
  caption(i) { return String(i + 1); }
  progress() { return this.count > 1 ? this.index / (this.count - 1) : 1; }
  atStart() { return this.index <= 0; }
  atEnd() { return this.index >= this.count - 1; }
  currentIndex() { return this.index; }
  refit() {}
  get thumbRatio() { return 0.75; }          // height / width of an overview thumbnail
  async renderThumb() {}
  put(...nodes) { if (!this.dead) this.content.replaceChildren(...nodes); }          // every draw goes through here
  destroy() { this.content.replaceChildren(); this.dead = true; }
}

/* ----- PDF: one page at a time ----- */
class PdfViewer extends BaseViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true; this.canRotate = true; this.hasOverview = true;
  }

  async open(file) {
    await lib('pdf');
    const data = new Uint8Array(await file.arrayBuffer());
    this.doc = await pdfjsLib.getDocument({ data }).promise;
    this.total = this.doc.numPages;
    this.page = 1;
    this.shown = 0;            // the page that is really on the screen (a new one takes a moment to draw)
    this.drawId = 0;
    const first = await this.doc.getPage(1);
    const v = first.getViewport({ scale: 1 });
    this.ratio = v.height / v.width;
    await this.draw();
  }

  get count() { return this.total; }
  get index() { return this.page - 1; }
  get thumbRatio() { return this.ratio || 1.4; }
  inkKey() { return this.shown; }
  inkAnchor() { return this.content.firstElementChild; }
  label() { return 'Page ' + this.page + ' of ' + this.total; }

  goTo(i) {
    const page = clamp(i, 0, this.total - 1) + 1;
    if (page === this.page) return;
    this.page = page;
    this.onChange();
    this.draw();
  }

  async draw(keepScroll) {
    const myId = ++this.drawId;                    // if we're asked again while drawing, the older draw is dropped
    const page = await this.doc.getPage(this.page);
    if (myId !== this.drawId) return;

    const rotation = (page.rotate + this.view.rot) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const free = this.free();
    const fit = this.view.fit === 'width'
      ? free.w / base.width
      : Math.min(free.w / base.width, free.h / base.height);
    const cssScale = fit * this.view.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    // Never ask for a canvas bigger than browsers can handle
    const scale = Math.min(cssScale * dpr, 8192 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale, rotation });

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(base.width * cssScale) + 'px';
    canvas.style.height = Math.floor(base.height * cssScale) + 'px';

    if (this.task) this.task.cancel();
    this.task = page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#fff' });
    try { await this.task.promise; }
    catch (err) { if (err && err.name === 'RenderingCancelledException') return; throw err; }
    if (myId !== this.drawId) return;

    this.put(canvas);          // swap the whole picture at once — no flicker
    this.shown = this.page - 1;
    if (!keepScroll) this.stage.scrollTo(0, 0);
    this.onChange();
  }

  refit() { if (this.doc) this.draw(true); }

  async renderThumb(i, el) {
    const page = await this.doc.getPage(i + 1);
    el.replaceChildren(await pdfCanvas(page, 260 * Math.min(window.devicePixelRatio || 1, 2)));
  }

  destroy() {
    this.drawId++;
    if (this.task) this.task.cancel();
    if (this.doc) this.doc.destroy();
    super.destroy();
  }
}

/* ----- Shared base for things drawn in a box that we scale and rotate: slides and images ----- */
class BoxViewer extends BaseViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true; this.canRotate = true;
  }

  setupBox(W, H, extraClass) {
    this.W = W; this.H = H;
    this.holder = h('div', 'slide-holder' + (extraClass ? ' ' + extraClass : ''));
    this.box = h('div', 'slide-box');
    this.box.style.width = W + 'px';
    this.box.style.height = H + 'px';
    this.holder.appendChild(this.box);
    this.put(this.holder);
  }

  inkAnchor() { return this.holder; }

  refit() {
    if (!this.holder) return;
    const rot = this.view.rot;
    const swap = rot % 180 !== 0;
    const w = swap ? this.H : this.W;               // size after rotation (before scaling)
    const hh = swap ? this.W : this.H;
    const free = this.free();
    const fit = this.view.fit === 'width' ? free.w / w : Math.min(free.w / w, free.h / hh);
    const s = fit * this.view.zoom;

    this.holder.style.width = Math.floor(w * s) + 'px';
    this.holder.style.height = Math.floor(hh * s) + 'px';
    // Rotate around the corner, then slide back into view
    const move = {
      0: '',
      90: 'translate(' + this.H * s + 'px,0) rotate(90deg) ',
      180: 'translate(' + this.W * s + 'px,' + this.H * s + 'px) rotate(180deg) ',
      270: 'translate(0,' + this.W * s + 'px) rotate(270deg) ',
    }[rot];
    this.box.style.transform = move + 'scale(' + s + ')';
  }
}

/* ----- PPTX speaker notes: read straight from the file (ppt/notesSlides), one text per slide ----- */
// Some presentations (Keynote / Canva / many templates) do not paint the background themselves but point at the theme's
// "background style" (<p:bgRef idx="1003">). The slide renderer reads that as a plain colour (black here) and loses the
// picture. So before loading, such a reference is rewritten into an ordinary picture background (<p:bgPr><a:blipFill>).
// Returns true when something was changed.
async function pptxThemeBackgrounds(zip) {
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);
  const resolve = (from, target) => {                       // 'ppt/slides/' + '../media/a.png' -> 'ppt/media/a.png'
    const parts = (target.startsWith('/') ? target.slice(1) : dirOf(from) + target).split('/'), out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
    return out.join('/');
  };
  const relsPath = (part) => dirOf(part) + '_rels/' + part.slice(part.lastIndexOf('/') + 1) + '.rels';
  const readRels = async (part) => {
    const f = zip.file(relsPath(part)); if (!f) return [];
    const xml = await f.async('string'), list = [];
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const id = (m[0].match(/\bId="([^"]*)"/) || [])[1], type = (m[0].match(/\bType="([^"]*)"/) || [])[1], target = (m[0].match(/\bTarget="([^"]*)"/) || [])[1];
      if (id && target) list.push({ id, type: type || '', target: resolve(part, target) });
    }
    return list;
  };
  const kind = (rels, word) => rels.find((r) => r.type.endsWith('/' + word));
  const bgImage = {};                                         // theme part -> [image path or null, ...] for styles 1001, 1002, 1003
  const themeImages = async (theme) => {
    if (bgImage[theme]) return bgImage[theme];
    const xml = await zip.file(theme).async('string'), rels = await readRels(theme);
    const list = (xml.match(/<a:bgFillStyleLst>([\s\S]*?)<\/a:bgFillStyleLst>/) || [, ''])[1];
    const items = list.match(/<a:(solidFill|gradFill|blipFill|noFill|pattFill)\b[\s\S]*?<\/a:\1>/g) || [];
    return (bgImage[theme] = items.map((it) => {
      if (!it.startsWith('<a:blipFill')) return null;
      const id = (it.match(/r:embed="([^"]*)"/) || [])[1], r = rels.find((x) => x.id === id);
      return r ? r.target : null;
    }));
  };
  const themeOf = async (part) => {                           // slide -> layout -> master -> theme
    let cur = part;
    for (let i = 0; i < 3; i++) {
      const rels = await readRels(cur), th = kind(rels, 'theme');
      if (th) return th.target;
      const up = kind(rels, 'slideLayout') || kind(rels, 'slideMaster');
      if (!up) return null;
      cur = up.target;
    }
    return null;
  };
  let changed = false;
  const parts = Object.keys(zip.files).filter((n) => /^ppt\/(slides|slideLayouts|slideMasters)\/[^/]+\.xml$/.test(n));
  for (const part of parts) {
    let xml = await zip.file(part).async('string');
    const m = xml.match(/<p:bg>\s*<p:bgRef\b[^>]*\bidx="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/p:bgRef>)\s*<\/p:bg>/);
    if (!m || +m[1] < 1001) continue;
    const theme = await themeOf(part); if (!theme) continue;
    const img = (await themeImages(theme))[+m[1] - 1001];
    if (!img) continue;                                       // a plain colour or gradient: the renderer copes with those
    const rels = await readRels(part), id = 'rIdLecternBg';
    const relPath = relsPath(part);
    const from = dirOf(part).split('/').filter(Boolean), to = img.split('/');
    let k = 0; while (k < from.length && k < to.length - 1 && from[k] === to[k]) k++;
    const rel = from.slice(k).map(() => '..').concat(to.slice(k)).join('/');         // path of the image as seen from the part
    const entry = '<Relationship Id="' + id + '" Type="' + R_NS + '/image" Target="' + rel + '"/>';
    const old = zip.file(relPath) ? await zip.file(relPath).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    zip.file(relPath, old.replace('</Relationships>', entry + '</Relationships>'));
    xml = xml.replace(m[0], '<p:bg><p:bgPr><a:blipFill rotWithShape="1"><a:blip xmlns:r="' + R_NS + '" r:embed="' + id + '"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>');
    zip.file(part, xml);
    changed = true;
  }
  return changed;
}

async function pptxNotes(zip) {
  const text = async (n) => { const f = zip.file(n); return f ? f.async('string') : ''; };
  const dom = (x) => new DOMParser().parseFromString(x, 'application/xml');
  const resolve = (base, target) => {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/'); parts.pop();
    for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
    return parts.join('/');
  };
  const rels = async (path) => {
    const dir = path.split('/'), file = dir.pop();
    const xml = await text(dir.join('/') + '/_rels/' + file + '.rels');
    const out = [];
    if (xml) for (const r of dom(xml).getElementsByTagName('Relationship')) {
      out.push({ id: r.getAttribute('Id'), type: r.getAttribute('Type') || '', target: resolve(path, r.getAttribute('Target') || '') });
    }
    return out;
  };
  const pres = dom(await text('ppt/presentation.xml'));
  const presRels = await rels('ppt/presentation.xml');
  const notes = [];
  for (const sld of pres.getElementsByTagName('p:sldId')) {
    const slide = (presRels.find((r) => r.id === sld.getAttribute('r:id')) || {}).target;
    let note = '';
    const link = slide ? (await rels(slide)).find((r) => /\/notesSlide$/.test(r.type)) : null;
    if (link) {
      const d = dom(await text(link.target));
      for (const sp of d.getElementsByTagName('p:sp')) {
        const ph = sp.getElementsByTagName('p:ph')[0];
        if (!ph || ph.getAttribute('type') !== 'body') continue;
        note = [...sp.getElementsByTagName('a:p')]
          .map((p) => [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join(''))
          .join('\n').trim();
      }
    }
    notes.push(note);
  }
  return notes;
}

/* ----- PPTX: one slide at a time ----- */
class PptxViewer extends BoxViewer {
  constructor(...args) { super(...args); this.hasOverview = true; }

  async open(file) {
    await lib('pptx');
    this.buf = await file.arrayBuffer();

    // Slide proportions (16:9, 4:3 …) from presentation.xml
    let ratio = 9 / 16, zip = null;
    try {
      zip = await JSZip.loadAsync(this.buf);
      const xml = await zip.file('ppt/presentation.xml').async('string');
      const cx = xml.match(/<p:sldSz[^>]*\scx="(\d+)"/);
      const cy = xml.match(/<p:sldSz[^>]*\scy="(\d+)"/);
      if (cx && cy) ratio = Number(cy[1]) / Number(cx[1]);
      let edited = await pptxThemeBackgrounds(zip);
      try { await lib('office'); if (await OFC.pptxDiagrams(zip)) edited = true; } catch (err) { console.warn('SmartArt skipped', err); }
      if (edited) this.buf = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
    } catch (e) { /* assume 16:9, original file */ }

    this.setupBox(1280, Math.round(1280 * ratio));
    this.previewer = pptxPreview.init(this.box, { width: this.W, height: this.H, mode: 'slide' });
    await this.previewer.load(this.buf);
    this.total = this.previewer.slideCount;
    this.notes = zip ? await pptxNotes(zip).catch(() => []) : [];
    this.cur = 0;
    this.show();
    this.refit();
  }

  get count() { return this.total; }
  get index() { return this.cur; }
  get thumbRatio() { return this.H / this.W; }
  notesFor(i) { return (this.notes && this.notes[i]) || ''; }
  get hasNotes() { return !!this.notes && this.notes.some(Boolean); }
  label() { return 'Slide ' + (this.cur + 1) + ' of ' + this.total; }

  show() {
    this.previewer.removeCurrentSlide();
    this.previewer.renderSingleSlide(this.cur);
    this.onChange();
  }
  goTo(i) {
    i = clamp(i, 0, this.total - 1);
    if (i === this.cur) return;
    this.cur = i;
    this.show();
  }

  // Overview: slides are drawn by a second, hidden previewer so the visible slide never flickers
  async renderThumb(i, el) {
    this.thumbChain = (this.thumbChain || Promise.resolve()).then(async () => {
      if (!this.thumbPv) {
        this.thumbHost = h('div');
        Object.assign(this.thumbHost.style, { position: 'fixed', left: '-20000px', top: '0', width: this.W + 'px', height: this.H + 'px' });
        document.body.appendChild(this.thumbHost);
        this.thumbPv = pptxPreview.init(this.thumbHost, { width: this.W, height: this.H, mode: 'slide' });
        await this.thumbPv.load(this.buf);
      }
      this.thumbPv.removeCurrentSlide();
      this.thumbPv.renderSingleSlide(i);
      const box = slideCopy(this.thumbHost, this.W, this.H, el.clientWidth || 220);
      if (box) el.replaceChildren(box);
    }).catch((err) => console.warn('Thumbnail failed:', err));
    return this.thumbChain;
  }

  destroy() {
    try { if (this.previewer) this.previewer.destroy(); } catch (e) { /* fine */ }
    try { if (this.thumbPv) this.thumbPv.destroy(); } catch (e) { /* fine */ }
    if (this.thumbHost) this.thumbHost.remove();
    super.destroy();
  }
}

/* ----- Image ----- */
class ImageViewer extends BoxViewer {
  async open(file) {
    this.url = URL.createObjectURL(file);
    const img = new Image();
    img.src = this.url;
    await img.decode();
    this.setupBox(img.naturalWidth || 1000, img.naturalHeight || 700, 'image-holder');
    this.box.appendChild(img);
    this.refit();
  }
  label() { return this.W + ' × ' + this.H + ' px'; }
  destroy() { if (this.url) URL.revokeObjectURL(this.url); super.destroy(); }
}

/* ----- Shared base for scrolling content (DOCX, text) ----- */
class ScrollViewer extends BaseViewer {
  inkKey() { return 'doc'; }
  scrollRatio() {
    const max = this.stage.scrollHeight - this.stage.clientHeight;
    return max > 0 ? this.stage.scrollTop / max : 0;
  }
  // "Next" scrolls almost a screen; "first" and "last" jump
  go(where) {
    const st = this.stage;
    const step = st.clientHeight * 0.9;
    const top = { first: 0, prev: st.scrollTop - step, next: st.scrollTop + step, last: st.scrollHeight }[where];
    st.scrollTo({ top, behavior: where === 'prev' || where === 'next' ? 'smooth' : 'auto' });
  }
  seek(ratio) { this.stage.scrollTop = ratio * (this.stage.scrollHeight - this.stage.clientHeight); }
  progress() { return this.scrollRatio(); }
  atStart() { return this.stage.scrollTop <= 2; }
  atEnd() { return this.stage.scrollTop + this.stage.clientHeight >= this.stage.scrollHeight - 2; }
  listenScroll() {
    this.onScroll = () => this.onChange();
    this.stage.addEventListener('scroll', this.onScroll, { passive: true });
  }
  destroy() {
    if (this.onScroll) this.stage.removeEventListener('scroll', this.onScroll);
    super.destroy();
  }
}

/* ----- DOCX pagination -----
   docx-preview starts a new page only at a hard page break, so the text between two breaks is one very tall "page".
   This cuts such a page into real sheets (the way Word lays them out): paragraphs and table rows that do not fit are
   moved to the next sheet, a long paragraph is split between two lines (never leaving one line alone), headings stay
   with the text after them, and a dark gap is drawn between the sheets. Returns how many sheets the page became. */
const DOCX_GAP = 28;
// Pictures anchored to a paragraph ("relative to paragraph"): put them at the paragraph's top + the offset
function placeAnchors(sec) {
  const list = sec.querySelectorAll('[data-dx-para]');
  if (!list.length) return;
  const t0 = sec.getBoundingClientRect().top;
  list.forEach((a) => {
    const p = a.closest('p');
    if (p) a.style.top = 'calc(' + (p.getBoundingClientRect().top - t0) + 'px + ' + a.getAttribute('data-dx-para') + ')';
  });
}
function paginateDocx(sec, P) {
  const articles = Array.from(sec.querySelectorAll(':scope > article'));
  if (!articles.length) return 1;
  if (sec.offsetHeight <= P + 3) return 1;
  const cs = getComputedStyle(sec);
  const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
  const G = DOCX_GAP, pitch = P + G;
  if (P - padT - padB < 120) return 1;
  const secTop = () => sec.getBoundingClientRect().top;
  const rel = (el) => { const r = el.getBoundingClientRect(), t = secTop(); return { top: r.top - t, bottom: r.bottom - t }; };
  const contentTop = (k) => k * pitch + padT;
  const contentBottom = (k) => k * pitch + P - padB;

  // The lines of a paragraph, measured on the screen: [{ top, bottom }]
  function lineBoxes(el) {
    const hidden = Array.from(el.querySelectorAll('[data-dx-abs]'));
    hidden.forEach((a) => { a.dataset.dxDisp = a.style.display; a.style.display = 'none'; });
    const range = document.createRange();
    range.selectNodeContents(el);
    const t0 = secTop();
    const rects = Array.from(range.getClientRects()).filter((r) => r.height > 2).sort((a, b) => a.top - b.top || a.left - b.left);
    hidden.forEach((a) => { a.style.display = a.dataset.dxDisp; delete a.dataset.dxDisp; });
    const lines = [];
    for (const r of rects) {
      const top = r.top - t0, bottom = r.bottom - t0, last = lines[lines.length - 1];
      if (last && top < last.top + (last.bottom - last.top) * 0.6) { last.top = Math.min(last.top, top); last.bottom = Math.max(last.bottom, bottom); }
      else lines.push({ top, bottom });
    }
    // Glyph boxes of neighbouring lines can overlap (single line spacing): use evenly spaced line boxes instead
    if (lines.length > 1) {
      const gaps = lines.slice(1).map((l, i) => l.top - lines[i].top).filter((g) => g > 1).sort((a, b) => a - b);
      const d = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
      if (d) lines.forEach((l) => { if (l.bottom - l.top <= d * 1.3) { const c = (l.top + l.bottom) / 2; l.top = c - d / 2; l.bottom = c + d / 2; } });
    }
    return lines;
  }
  const mk = (tag, cls) => { const e = document.createElement(tag); e.className = cls; return e; };
  // Put `el` (with a spacer in front of it) exactly at `target` (px from the top of the section)
  function placeAt(el, spacer, target) {
    spacer.style.height = '0px';
    let t = rel(el).top;
    spacer.style.height = Math.max(0, target - t) + 'px';
    t = rel(el).top;
    if (Math.abs(t - target) > 0.5) spacer.style.height = Math.max(0, parseFloat(spacer.style.height) + target - t) + 'px';
  }

  const units = [];
  for (const art of articles) {
    if (art.style.columnCount && art.style.columnCount !== '1') { units.push({ kind: 'block', box: art, src: art, off: 0 }); continue; }   // text in columns stays whole
    for (const el of Array.from(art.children)) {
      if (el.tagName === 'TABLE') Array.from(el.rows).forEach((tr) => units.push({ kind: 'row', box: tr }));
      else units.push({ kind: el.tagName === 'P' ? 'p' : 'block', box: el, src: el, off: 0 });
    }
  }
  const isHeading = (u) => u.kind === 'p' && /heading|title|заголов/i.test(u.box.className + ' ' + (u.box.getAttribute('data-style') || ''));

  let k = 0;
  for (let i = 0; i < units.length; i++) {
    let u = units[i];
    for (let guard = 0; guard < 300; guard++) {
      const r = rel(u.box), bottom = contentBottom(k);
      const atTop = r.top <= contentTop(k) + 2;
      let fits = r.bottom <= bottom + 0.5;
      // a heading must not be the last thing on a sheet: its first line of text has to fit as well
      if (fits && isHeading(u) && i + 1 < units.length && !atTop) {
        const nx = units[i + 1], nb = nx.kind === 'p' ? (lineBoxes(nx.box)[0] || rel(nx.box)).bottom : rel(nx.box).bottom;
        if (nb > bottom + 0.5) fits = false;
      }
      if (fits) break;

      if (u.kind === 'p') {
        const all = lineBoxes(u.src), br = rel(u.box);
        const lines = all.filter((l) => l.top >= br.top - 1 && l.top < br.bottom - 1);
        const L = lines.length;
        let m = lines.filter((l) => l.bottom <= bottom + 0.5).length;
        if (L >= 4) { if (m < 2 && !atTop) m = 0; else if (L - m < 2) m = L - 2; }
        else if (!atTop) m = 0;
        if (m >= 1 && m < L) {                              // split between line m-1 and line m
          const cut = (lines[m - 1].bottom + lines[m].top) / 2;
          const hA = cut - br.top, hB = br.bottom - cut;
          const clone = u.src.cloneNode(true);
          clone.removeAttribute('id');
          clone.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
          clone.querySelectorAll('[data-dx-abs]').forEach((e) => e.remove());
          clone.classList.add('dx-clone');
          const mb = u.mb !== undefined ? u.mb : (parseFloat(getComputedStyle(u.box).marginBottom) || 0);
          Object.assign(clone.style, { marginTop: (u.off - hA) + 'px', marginBottom: '0px', boxSizing: 'border-box' });
          const wrap = mk('div', 'dx-part');
          Object.assign(wrap.style, { overflow: 'hidden', height: hB + 'px', marginBottom: mb + 'px' });
          wrap.appendChild(clone);
          const spacer = mk('div', 'dx-sp');
          Object.assign(u.box.style, { boxSizing: 'border-box', height: hA + 'px', overflow: 'hidden', marginBottom: '0px' });
          u.box.after(spacer, wrap);
          k++;
          placeAt(wrap, spacer, contentTop(k));
          u = units[i] = { kind: 'p', box: wrap, src: clone, off: u.off - hA, mb };
          continue;
        }
        if (m === 0 && atTop) break;                        // does not fit even on an empty sheet: leave it
      } else if (atTop) break;                              // taller than a whole sheet: leave it

      // move the whole unit to the next sheet
      const spacer = u.kind === 'row' ? mk('tr', 'dx-sp') : mk('div', 'dx-sp');
      if (u.kind === 'row') {
        const td = document.createElement('td');
        td.colSpan = 99; td.style.cssText = 'padding:0;border:0;height:0';
        spacer.appendChild(td);
      } else u.box.style.marginTop = '0px';
      u.box.before(spacer);
      k++;
      if (u.kind === 'row') {
        const td = spacer.firstChild;
        const t0 = rel(u.box).top;
        td.style.height = Math.max(0, contentTop(k) - t0) + 'px';
        const t1 = rel(u.box).top;
        if (Math.abs(t1 - contentTop(k)) > 0.5) td.style.height = Math.max(0, parseFloat(td.style.height) + contentTop(k) - t1) + 'px';
      } else placeAt(u.box, spacer, contentTop(k));
    }
  }
  const pages = k + 1;
  if (pages > 1) {
    sec.style.minHeight = (pages * P + k * G) + 'px';
    for (let j = 0; j < k; j++) {
      const band = mk('div', 'dx-gap');
      Object.assign(band.style, { top: (j * pitch + P) + 'px', height: G + 'px' });
      sec.appendChild(band);
    }
  }
  sec.dataset.dxPages = String(pages);
  sec.dataset.dxPitch = String(pitch);
  return pages;
}

/* ----- DOCX: one long scrolling document ----- */
class DocxViewer extends ScrollViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true; this.hasOverview = true;
    this.defaultFit = 'page';
  }

  async open(file) {
    await lib('docx');
    let buf = await file.arrayBuffer();
    // charts, shapes, SmartArt and Symbol bullets are turned into pictures / plain characters first (never fatal)
    try { await lib('office'); buf = await OFC.docxPrepare(buf); } catch (err) { console.warn('Word extras skipped', err); }
    this.host = h('div', 'docx-host');
    this.put(this.host);
    await docx.renderAsync(buf, this.host, null, {
      className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
    });
    // A Word page that is only part of a "section" (long text between two hard page breaks) is cut into real sheets
    const sections = Array.from(this.host.querySelectorAll('section.docx'));
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* fine */ }
    await Promise.all(Array.from(this.host.querySelectorAll('img')).map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
    this.natural = Math.max(...sections.map((p) => p.offsetWidth), 300);                 // page width at 100%
    const nominal = parseFloat(sections[0] && getComputedStyle(sections[0]).minHeight) || Math.min(...sections.map((p) => p.offsetHeight), 1123);
    this.pageH = Math.max(nominal, 300);
    const self = this;
    this.pages = [];
    for (const sec of sections) {
      let n = 1, pitch = this.pageH;
      try { n = paginateDocx(sec, this.pageH); } catch (err) { console.warn('Page layout failed', err); n = 1; }
      placeAnchors(sec);
      if (n > 1) pitch = Number(sec.dataset.dxPitch) || this.pageH;
      else if (sec.offsetHeight > this.pageH + 3) n = Math.ceil((sec.offsetHeight - 3) / this.pageH);   // could not be cut: count by height
      for (let k = 0; k < n; k++) {
        this.pages.push({
          sec, k, pitch,
          getBoundingClientRect() {
            const r = sec.getBoundingClientRect(), z = parseFloat(self.host.style.zoom) || 1, top = r.top + k * pitch * z;
            return { top, bottom: top + self.pageH * z, left: r.left, right: r.right, width: r.width, height: self.pageH * z };
          },
        });
      }
    }
    this.listenScroll();
    this.refit();
  }

  get count() { return this.pages ? this.pages.length : 1; }
  get thumbRatio() { return this.pageH / this.natural; }

  refit() {
    if (!this.host) return;
    const before = this.scrollRatio();
    const free = this.free();
    const byWidth = free.w / this.natural;
    const fit = this.view.fit === 'width' ? byWidth : Math.min(byWidth, free.h / (this.pageH + 24));
    this.host.style.zoom = Math.min(fit, 3) * this.view.zoom;
    this.stage.scrollTop = before * (this.stage.scrollHeight - this.stage.clientHeight);
    this.onChange();
  }

  // Which page is at the top of the screen right now
  currentIndex() {
    if (!this.pages || this.pages.length < 2) return 0;
    const edge = this.stage.getBoundingClientRect().top + this.stage.clientHeight * 0.35;
    let current = 0;
    this.pages.forEach((p, i) => { if (p.getBoundingClientRect().top <= edge) current = i; });
    return current;
  }

  label() {
    return this.pages.length > 1
      ? 'Page ' + (this.currentIndex() + 1) + ' of ' + this.pages.length
      : 'Read ' + Math.round(this.scrollRatio() * 100) + '%';
  }

  goTo(i) {
    const page = this.pages[clamp(i, 0, this.pages.length - 1)];
    if (!page) return;
    // the top bar floats over the stage: stop the page just below it
    const gap = Math.max(8, parseFloat(getComputedStyle(this.content).paddingTop) - 4);
    const top = page.getBoundingClientRect().top - this.stage.getBoundingClientRect().top + this.stage.scrollTop - gap;
    this.stage.scrollTo({ top, behavior: 'auto' });
  }

  async renderThumb(i, el) {
    const pg = this.pages[i];
    if (!pg) return;
    const wrapper = h('div', 'docx-wrapper');
    const clone = pg.sec.cloneNode(true);
    clone.style.cssText += ';margin:' + (-pg.k * pg.pitch) + 'px 0 0 0;box-shadow:none';
    wrapper.appendChild(clone);
    const host = h('div', 'clone-host docx-host');
    host.style.width = this.natural + 'px';
    host.style.height = this.pageH + 'px';
    host.style.overflow = 'hidden';
    host.style.transform = 'scale(' + ((el.clientWidth || 220) / this.natural) + ')';
    host.appendChild(wrapper);
    el.replaceChildren(host);
  }
}

/* ----- Plain text ----- */
class TextViewer extends ScrollViewer {
  async open(file) {
    const LIMIT = 2 * 1024 * 1024;                       // show the first 2 MB at most
    const buffer = await file.slice(0, LIMIT).arrayBuffer();
    this.host = h('div', 'text-host');
    const page = h('div', 'text-page');
    const text = decodeText(buffer, file.size > LIMIT);
    const shown = this.format(text, file.size > LIMIT);       // subclasses may re-format the text (JSON)
    page.textContent = shown.text;
    this.host.appendChild(page);
    if (shown.note) this.host.appendChild(h('div', 'text-note', shown.note));
    else if (file.size > LIMIT) this.host.appendChild(h('div', 'text-note', 'Only the first 2 MB are shown.'));
    this.put(this.host);
    this.listenScroll();
    this.refit();
  }
  format(text) { return { text, note: '' }; }
  refit() {
    if (!this.host) return;
    const before = this.scrollRatio();
    this.host.style.zoom = this.view.zoom;
    this.stage.scrollTop = before * (this.stage.scrollHeight - this.stage.clientHeight);
    this.onChange();
  }
  label() { return 'Read ' + Math.round(this.scrollRatio() * 100) + '%'; }
}

/* ----- XLSX / CSV: one sheet at a time as a table ----- */
class XlsxViewer extends BaseViewer {
  constructor(...args) { super(...args); this.hasOverview = true; }

  async open(file) {
    await lib('xlsx');
    const buf = await file.arrayBuffer();
    this.wb = XLSX.read(buf, { type: 'array' });
    this.names = this.wb.SheetNames;
    this.decor = null;                       // cell colours, column widths, pictures and charts (only for real .xlsx files)
    try {
      if (new Uint8Array(buf, 0, 2).join() === '80,75' && /\.xls[xm]$/i.test(file.name || '')) { await lib('office'); this.decor = await OFC.xlsxDecor(buf); }
    } catch (err) { console.warn('Excel extras skipped', err); }
    this.cur = 0;
    this.show();
  }

  get count() { return this.names.length; }
  get index() { return this.cur; }
  inkAnchor() { return this.host; }
  caption(i) { return this.names[i]; }
  label() { return 'Sheet ' + (this.cur + 1) + ' of ' + this.names.length + ' · ' + this.names[this.cur]; }
  goTo(i) {
    i = clamp(i, 0, this.names.length - 1);
    if (i === this.cur) return;
    this.cur = i;
    this.show();
  }

  show() {
    const ws = this.wb.Sheets[this.names[this.cur]];
    const host = h('div', 'sheet-host');
    this.host = host;
    if (!ws || !ws['!ref']) {
      host.appendChild(h('div', 'sheet-note', 'This sheet is empty.'));
    } else {
      host.appendChild(this.buildTable(ws));
    }
    this.put(host);
    try { this.placeObjects(host, this.names[this.cur]); } catch (err) { console.warn('Sheet pictures skipped', err); }
    this.stage.scrollTo(0, 0);
    this.refit();
    this.onChange();
  }

  // Charts and pictures of the sheet, laid over the cells they were anchored to
  placeObjects(host, name) {
    const info = this.decor && this.decor[name], table = host.querySelector('table');
    if (!info || !info.drawings.length || !table) return;
    const range = this.wb.Sheets[name]['!ref'] ? XLSX.utils.decode_range(this.wb.Sheets[name]['!ref']) : { s: { r: 0, c: 0 } };
    const ths = Array.from(table.rows[0].cells), tops = Array.from(table.rows).map((r) => r.cells[0]);
    host.style.position = 'relative';
    const at = (c, r, co, ro) => {
      const cc = clamp(c - range.s.c + 1, 1, ths.length - 1), rr = clamp(r - range.s.r + 1, 1, tops.length - 1);
      return { x: table.offsetLeft + ths[cc].offsetLeft + co, y: table.offsetTop + tops[rr].offsetTop + ro };
    };
    const resolve = (f) => {                 // values of a range such as 'Sheet 1'!$B$2:$B$7 (charts saved without a cache)
      const m = /^'?(.*?)'?!(.+)$/.exec(f.replace(/^\(|\)$/g, ''));
      const ws = m && this.wb.Sheets[m[1]];
      if (!ws) return [];
      const rg = XLSX.utils.decode_range(m[2].replace(/\$/g, '')), out = [];
      for (let r = rg.s.r; r <= rg.e.r; r++) for (let c = rg.s.c; c <= rg.e.c; c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; out.push(cell ? String(cell.v) : null); }
      return out;
    };
    for (const d of info.drawings) {
      const a = at(d.from.c, d.from.r, d.from.co, d.from.ro);
      let w = d.w, hh = d.h;
      if (d.to) { const b = at(d.to.c, d.to.r, d.to.co, d.to.ro); w = b.x - a.x; hh = b.y - a.y; }
      if (w < 20 || hh < 20) continue;
      const box = h('div', 'sheet-obj');
      box.style.cssText = 'position:absolute;left:' + a.x + 'px;top:' + a.y + 'px;width:' + w + 'px;height:' + hh + 'px';
      if (d.kind === 'chart') {
        const svg = OFC.chartSvg(d.xml, this.decor.__theme, Math.round(w), Math.round(hh), resolve);
        if (!svg) continue;
        box.innerHTML = svg;
      } else {
        const im = h('img'); im.src = URL.createObjectURL(d.blob); im.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block';
        box.appendChild(im);
      }
      host.appendChild(box);
    }
  }

  buildTable(ws) {
    const MAX_ROWS = 2000, MAX_COLS = 80;
    const all = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
    const rows = all.slice(0, MAX_ROWS);
    let cols = 0;
    for (const r of rows) cols = Math.max(cols, r.length);
    cols = Math.min(cols, MAX_COLS);
    const info = this.decor && this.decor[this.names[this.cur]];
    const range0 = XLSX.utils.decode_range(ws['!ref']);
    if (info) {                                // the table must reach the cells under pictures and charts
      for (const d of info.drawings) {
        const endR = d.to ? d.to.r + 1 : d.from.r + Math.ceil(d.h / 24) + 1, endC = d.to ? d.to.c + 1 : d.from.c + Math.ceil(d.w / 36) + 1;
        while (rows.length < Math.min(endR - range0.s.r, 400)) rows.push([]);
        cols = Math.max(cols, Math.min(endC - range0.s.c, MAX_COLS));
      }
    }

    // Merged cells: the top-left cell spans, the others are skipped
    const span = new Map(), covered = new Set();
    for (const m of ws['!merges'] || []) {
      span.set(m.s.r + ':' + m.s.c, { rows: m.e.r - m.s.r + 1, cols: m.e.c - m.s.c + 1 });
      for (let r = m.s.r; r <= m.e.r; r++)
        for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) covered.add(r + ':' + c);
    }
    // sheet_to_json starts at the first used cell; shift merges accordingly
    const range = XLSX.utils.decode_range(ws['!ref']);
    const dr = range.s.r, dc = range.s.c;

    const letters = (n) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

    const table = h('table', 'sheet');
    const head = h('tr');
    head.appendChild(h('th', 'rn', ''));
    for (let c = 0; c < cols; c++) {
      const th = h('th', '', letters(c + dc));
      if (info && info.colW[c + dc]) th.style.minWidth = info.colW[c + dc] + 'px';
      head.appendChild(th);
    }
    table.appendChild(head);

    rows.forEach((row, r) => {
      const tr = h('tr');
      tr.appendChild(h('td', 'rn', String(r + 1 + dr)));
      for (let c = 0; c < cols; c++) {
        const key = (r + dr) + ':' + (c + dc);
        if (covered.has(key)) continue;
        const td = h('td', '', row[c] === undefined ? '' : String(row[c]));
        const sp = span.get(key);
        if (sp) { td.rowSpan = sp.rows; td.colSpan = sp.cols; }
        const st = info && info.cells.get(key);
        if (st) {
          if (st.bg) td.style.background = st.bg;
          if (st.bold) td.style.fontWeight = '700';
          if (st.italic) td.style.fontStyle = 'italic';
          if (st.color) td.style.color = st.color;
          if (st.h && st.h !== 'general') td.style.textAlign = st.h === 'centerContinuous' ? 'center' : st.h;
          if (st.v) td.style.verticalAlign = st.v === 'center' ? 'middle' : st.v;
          if (st.wrap) td.style.whiteSpace = 'normal';
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    });

    const frag = document.createDocumentFragment();
    frag.appendChild(table);
    if (all.length > MAX_ROWS || cols >= MAX_COLS) {
      frag.appendChild(h('div', 'sheet-note', 'Showing the first ' + Math.min(all.length, MAX_ROWS) + ' rows and ' + cols + ' columns.'));
    }
    return frag;
  }

  refit() { if (this.host) this.host.style.zoom = this.view.zoom; }

  async renderThumb(i, el) {
    const ws = this.wb.Sheets[this.names[i]];
    const box = h('div', 'snippet');
    box.appendChild(h('b', '', this.names[i]));
    const ref = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
    box.appendChild(document.createTextNode(ref ? (ref.e.r - ref.s.r + 1) + ' rows × ' + (ref.e.c - ref.s.c + 1) + ' columns' : 'Empty'));
    el.replaceChildren(box);
  }
}

// The newer formats (odp, odt, rtf, heic, media, zip, json, epub) add themselves from app/modules/formats.js
const VIEWER_CLASSES = { pdf: PdfViewer, pptx: PptxViewer, docx: DocxViewer, xlsx: XlsxViewer, image: ImageViewer, text: TextViewer };
