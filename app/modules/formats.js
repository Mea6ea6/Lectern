'use strict';
/* =====================================================================
   Lectern — the newer formats, loaded the first time one of them is opened
   (see FORMAT_VIEWERS in app.js).  Uses the helpers and base classes of app.js.

     1. Helpers
     2. Video and audio (the tiny player)
     3. HEIC photos
     4. OpenDocument: odt, odp (ods uses the spreadsheet viewer)
     5. RTF
     6. ZIP (a list of what is inside)
     7. JSON
     8. EPUB books

   Every viewer class also has two static helpers used by the file list:
     thumb(entry)              makes the card picture (sets entry.thumbNode)
     details(entry, add)       adds rows to the "Get Info" window
   ===================================================================== */


/* ---------------------------------------------------------------------
   1. HELPERS
   --------------------------------------------------------------------- */

// An error the viewer window shows in plain words: [title, explanation]
function friendly(title, details) {
  const err = new Error(title);
  err.friendly = [title, details];
  return err;
}

function xmlDoc(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML is damaged');
  return doc;
}

// Zip files made on Windows often store Russian names in the old DOS code page (CP866) instead of UTF-8
function zipLoad(file) {
  return JSZip.loadAsync(file, {
    decodeFileName: (bytes) => {
      const u8 = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { /* not UTF-8 */ }
      try { return new TextDecoder('ibm866').decode(u8); } catch (e) { return String.fromCharCode(...u8); }
    },
  });
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, hh = Math.floor(sec / 3600);
  const two = (n) => String(n).padStart(2, '0');
  return hh ? hh + ':' + two(m) + ':' + two(s) : m + ':' + two(s);
}

function snippetNode(title, body, cls) {
  const box = h('div', 'snippet' + (cls ? ' ' + cls : ''));
  if (title) box.appendChild(h('b', '', title));
  if (body) box.appendChild(document.createTextNode(body));
  return box;
}

// A picture from the zip (png, jpg…) as a blob address. Returns '' for formats a browser can't show (emf, wmf…)
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
async function zipImageUrl(zip, path, cache) {
  const ext = getExt(path);
  if (!IMAGE_MIME[ext]) return '';
  if (cache && cache.has(path)) return cache.get(path);
  const entry = zip.file(path);
  if (!entry) return '';
  const url = URL.createObjectURL(new Blob([await entry.async('uint8array')], { type: IMAGE_MIME[ext] }));
  if (cache) cache.set(path, url);
  return url;
}
function revokeAll(cache) { if (cache) for (const url of cache.values()) URL.revokeObjectURL(url); }

// Length like "2.5cm", "10pt", "1in" -> centimetres (null if it is not a length)
function toCm(v, fallback) {
  if (v === null || v === undefined) return fallback;
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|px|pc)?$/.exec(String(v).trim());
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case 'mm': return n / 10;
    case 'in': return n * 2.54;
    case 'pt': return n * 2.54 / 72;
    case 'px': return n * 2.54 / 96;
    case 'pc': return n * 2.54 / 6;
    default: return n;
  }
}


/* ---------------------------------------------------------------------
   2. VIDEO AND AUDIO
   The player is deliberately tiny: play / pause and 5 seconds back or forward.
   The buttons live in the viewer bar (app.js); this class only runs the media element.
   --------------------------------------------------------------------- */

// Loads just enough of a media file to know its length and picture size
function probeMedia(file, wantVideo) {
  return new Promise((ok) => {
    const el = document.createElement(wantVideo ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    const done = (info) => { clearTimeout(timer); el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); ok(info); };
    const timer = setTimeout(() => done(null), 6000);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => done({ duration: el.duration, width: el.videoWidth || 0, height: el.videoHeight || 0, el });
    el.onerror = () => done(null);
    el.src = url;
  });
}

class MediaViewer extends BaseViewer {
  constructor(...args) {
    super(...args);
    this.isMedia = true;
    this.canDraw = false;
  }

  async open(file) {
    this.url = URL.createObjectURL(file);
    const wantVideo = this.entry && this.entry.kind === 'video';
    const el = document.createElement(wantVideo ? 'video' : 'audio');
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    this.el = el;

    await new Promise((ok, fail) => {
      el.onloadedmetadata = ok;
      el.onerror = () => fail(friendly(
        'This browser can’t play this file',
        'The sound or picture uses a format this browser does not support. Try Chrome or Edge, or convert the file to MP4 (H.264) or WebM.'));
      el.src = this.url;
    });
    el.onerror = null;

    // A video file without a picture (sound only) is shown like audio
    this.hasPicture = wantVideo && el.videoWidth > 0;
    ['timeupdate', 'play', 'pause', 'ended', 'seeked', 'durationchange'].forEach((ev) => el.addEventListener(ev, () => this.onChange()));

    if (this.hasPicture) {
      el.className = 'media-video';
      this.content.replaceChildren(el);
      this.refit();
    } else {
      const box = h('div', 'media-audio');
      box.appendChild(icon('i-music'));
      box.append(h('div', 'media-title', this.entry ? this.entry.base : ''), h('div', 'media-sub', wantVideo ? 'Sound only' : 'Audio'));
      this.content.replaceChildren(box);
    }
  }

  get playing() { return !!this.el && !this.el.paused && !this.el.ended; }
  toggle() {
    const el = this.el;
    if (!el) return;
    if (el.paused || el.ended) {
      if (el.ended) el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => { /* the browser said no (no click yet): the big button stays */ });
    } else el.pause();
  }
  skip(sec) {
    const el = this.el;
    if (!el) return;
    const end = isFinite(el.duration) ? el.duration : Infinity;
    el.currentTime = clamp(el.currentTime + sec, 0, end);
  }

  label() { return fmtTime(this.el.currentTime) + ' / ' + fmtTime(this.el.duration); }
  progress() { const d = this.el.duration; return d > 0 && isFinite(d) ? this.el.currentTime / d : 0; }
  atStart() { return true; }
  atEnd() { return true; }

  refit() {
    if (!this.hasPicture) return;
    const vw = this.el.videoWidth, vh = this.el.videoHeight;
    const free = this.free();
    const s = Math.min(free.w / vw, free.h / vh);
    this.el.style.width = Math.floor(vw * s) + 'px';
    this.el.style.height = Math.floor(vh * s) + 'px';
  }

  destroy() {
    if (this.el) { try { this.el.pause(); } catch (e) { /* fine */ } this.el.removeAttribute('src'); this.el.load(); }
    if (this.url) URL.revokeObjectURL(this.url);
    super.destroy();
  }

  /* ----- card picture: the first frame of a video, a note for sound ----- */
  static async thumb(entry) {
    const video = entry.kind === 'video';
    const info = await probeMedia(entry.file, video);
    entry.duration = info ? info.duration : 0;
    if (video && info && info.width) {
      try { entry.thumbNode = await videoFrame(entry.file, info); return; } catch (e) { /* use the placeholder */ }
    }
    const box = snippetNode('', '', 'media-snip');
    box.appendChild(icon(video ? 'i-play' : 'i-music'));
    box.appendChild(h('span', 'media-dur', info ? fmtTime(info.duration) : (video ? 'Video' : 'Audio')));
    entry.thumbNode = box;
  }

  static async details(entry, add) {
    const video = entry.kind === 'video';
    const info = await probeMedia(entry.file, video);
    if (!info) { add('Playback', 'This browser can’t read this file'); return; }
    add('Duration', fmtTime(info.duration));
    if (info.width) add('Picture', info.width + ' × ' + info.height + ' px');
  }
}

// One picture from the video (a second in, or a tenth of the way)
function videoFrame(file, info) {
  return new Promise((ok, fail) => {
    const el = document.createElement('video');
    const url = URL.createObjectURL(file);
    const end = (fn, val) => { clearTimeout(timer); el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); fn(val); };
    const timer = setTimeout(() => end(fail, new Error('timeout')), 8000);
    el.muted = true; el.preload = 'auto';
    el.onerror = () => end(fail, new Error('decode'));
    el.onloadeddata = () => { el.currentTime = Math.min(1, (info.duration || 0) / 10) || 0; };
    el.onseeked = () => {
      const w = 420, hh = Math.round(w * el.videoHeight / el.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = hh;
      canvas.getContext('2d').drawImage(el, 0, 0, w, hh);
      end(ok, canvas);
    };
    el.src = url;
  });
}


/* ---------------------------------------------------------------------
   3. HEIC (photos from an iPhone)
   Safari can open them itself; everywhere else a library (heic2any, loaded only now) turns them into JPEG.
   --------------------------------------------------------------------- */

async function heicToBlob(file, quality) {
  try {                                           // the browser may know HEIC already
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    return await new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('toBlob'))), 'image/jpeg', quality));
  } catch (e) { /* use the library */ }
  await lib('heic');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality });
  return Array.isArray(out) ? out[0] : out;
}

class HeicViewer extends ImageViewer {
  async open(file) {
    let blob;
    try { blob = await heicToBlob(file, 0.92); }
    catch (err) {
      console.warn(err);
      throw friendly('Could not open this HEIC photo', 'The photo may be damaged, or saved in a HEIC variant this viewer can’t read. Open it on the phone and share it as JPEG.');
    }
    return super.open(blob);
  }

  static async thumb(entry) {
    const blob = await heicToBlob(entry.file, 0.5);
    const bmp = await createImageBitmap(blob);
    const w = Math.min(420, bmp.width), hh = Math.round(w * bmp.height / bmp.width);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = hh;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, hh);
    bmp.close && bmp.close();
    entry.thumbNode = canvas;
  }

  // The size is written near the start of the file in an "ispe" box — no need to decode the photo
  static async details(entry, add) {
    const bytes = new Uint8Array(await entry.file.slice(0, 1024 * 1024).arrayBuffer());
    const dv = new DataView(bytes.buffer);
    let best = null;
    for (let i = 4; i < bytes.length - 16; i++) {
      if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {   // "ispe"
        const w = dv.getUint32(i + 8), hh = dv.getUint32(i + 12);
        if (w && hh && w < 100000 && hh < 100000 && (!best || w * hh > best.w * best.h)) best = { w, h: hh };
      }
    }
    if (best) add('Dimensions', best.w + ' × ' + best.h + ' px');
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (/^[a-z0-9 ]{4}$/i.test(brand)) add('Format brand', brand.trim());
  }
}


/* ---------------------------------------------------------------------
   3b. TIFF (scans, old photos). Browsers (except Safari) can't show them, so a small decoder
   (UTIF + pako, loaded only now) draws the first page onto a canvas and the picture is shown as a PNG.
   --------------------------------------------------------------------- */
async function tiffCanvas(file) {
  await lib('tiff');
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (!ifds.length) throw new Error('empty TIFF');
  UTIF.decodeImage(buf, ifds[0], ifds);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const canvas = document.createElement('canvas');
  canvas.width = ifds[0].width; canvas.height = ifds[0].height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), canvas.width, canvas.height), 0, 0);
  return { canvas, pages: ifds.length };
}

class TiffViewer extends ImageViewer {
  async open(file) {
    let blob;
    try {
      const { canvas } = await tiffCanvas(file);
      blob = await new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('toBlob'))), 'image/png'));
    } catch (err) {
      console.warn(err);
      throw friendly('Could not open this TIFF picture', 'The file may be damaged or use a compression this viewer doesn’t know. Open it in another program and save it as PNG or JPEG.');
    }
    return super.open(blob);
  }

  static async thumb(entry) {
    const { canvas } = await tiffCanvas(entry.file);
    const w = Math.min(420, canvas.width), hh = Math.round(w * canvas.height / canvas.width);
    const out = document.createElement('canvas');
    out.width = w; out.height = hh;
    out.getContext('2d').drawImage(canvas, 0, 0, w, hh);
    entry.thumbNode = out;
  }

  static async details(entry, add) {
    try {
      const { canvas, pages } = await tiffCanvas(entry.file);
      add('Dimensions', canvas.width + ' × ' + canvas.height + ' px');
      if (pages > 1) add('Pictures in file', pages + ' (the first is shown)');
    } catch (e) { /* no details */ }
  }
}


/* ---------------------------------------------------------------------
   4. OPENDOCUMENT (odt, odp)
   An ODF file is a zip with content.xml (the text and shapes), styles.xml and meta.xml.
   This is a compact reader for what classrooms need: text, headings, lists, tables, pictures,
   and slides made of text boxes, pictures and simple shapes. Charts, grouped transforms,
   animations and exotic shapes are not drawn.
   --------------------------------------------------------------------- */

// All the "style:style" and "text:list-style" definitions of the file, with parent styles merged in
class OdfStyles {
  constructor(docs) {
    this.styles = new Map();
    this.lists = new Map();
    this.masters = new Map();
    this.layouts = new Map();
    this.fills = new Map();       // draw:fill-image  (name -> picture path)
    this.gradients = new Map();
    this.cache = new Map();
    for (const doc of docs) {
      for (const el of doc.getElementsByTagName('style:style')) this.styles.set(el.getAttribute('style:name'), el);
      for (const el of doc.getElementsByTagName('text:list-style')) this.lists.set(el.getAttribute('style:name'), el);
      for (const el of doc.getElementsByTagName('style:master-page')) this.masters.set(el.getAttribute('style:name'), el);
      for (const el of doc.getElementsByTagName('style:page-layout')) this.layouts.set(el.getAttribute('style:name'), el);
      for (const el of doc.getElementsByTagName('draw:fill-image')) this.fills.set(el.getAttribute('draw:name'), el.getAttribute('xlink:href'));
      for (const el of doc.getElementsByTagName('draw:gradient')) this.gradients.set(el.getAttribute('draw:name'), el);
    }
  }

  // { text, para, graphic, cell, page } — every property group with the parent styles merged under it
  resolve(name) {
    if (!name) return { text: {}, para: {}, graphic: {}, cell: {}, page: {} };
    if (this.cache.has(name)) return this.cache.get(name);
    const chain = [];
    let el = this.styles.get(name);
    while (el && chain.length < 12) { chain.unshift(el); el = this.styles.get(el.getAttribute('style:parent-style-name')); }
    const out = { text: {}, para: {}, graphic: {}, cell: {}, page: {} };
    const groups = {
      'style:text-properties': 'text', 'style:paragraph-properties': 'para', 'style:graphic-properties': 'graphic',
      'style:table-cell-properties': 'cell', 'style:drawing-page-properties': 'page',
    };
    for (const style of chain) {
      for (const child of style.children) {
        const g = groups[child.nodeName];
        if (g) for (const a of child.attributes) out[g][a.name] = a.value;
      }
    }
    this.cache.set(name, out);
    return out;
  }

  isOrdered(listStyleName, level) {
    const ls = this.lists.get(listStyleName);
    if (!ls) return false;
    for (const lvl of ls.children) {
      if (lvl.getAttribute('text:level') === String(level)) return lvl.nodeName === 'text:list-level-style-number';
    }
    return false;
  }

  pageSizeCm(masterName) {
    const m = this.masters.get(masterName) || [...this.masters.values()][0];
    const layout = m && this.layouts.get(m.getAttribute('style:page-layout-name'));
    const props = layout && [...layout.children].find((c) => c.nodeName === 'style:page-layout-properties');
    const g = (a, d) => toCm(props && props.getAttribute(a), d);
    return {
      w: g('fo:page-width', 21), h: g('fo:page-height', 29.7),
      ml: g('fo:margin-left', 2), mr: g('fo:margin-right', 2), mt: g('fo:margin-top', 2), mb: g('fo:margin-bottom', 2),
    };
  }
}

const Odf = {
  async load(file) {
    if (file.size > 400 * 1024 * 1024) throw friendly('This file is too large', 'Files over 400 MB can’t be opened here.');
    const zip = await zipLoad(file);
    const get = async (name) => (zip.file(name) ? xmlDoc(await zip.file(name).async('string')) : null);
    const content = await get('content.xml');
    if (!content) throw friendly('This does not look like an OpenDocument file', 'content.xml is missing. The file may be damaged.');
    const stylesDoc = await get('styles.xml');
    const meta = await get('meta.xml');
    return { zip, content, stylesDoc, meta, styles: new OdfStyles([content, stylesDoc].filter(Boolean)), images: new Map() };
  },

  // Facts for the "Get Info" window
  details(odf, add, dateText) {
    const m = odf.meta;
    if (!m) return;
    const tag = (n) => { const e = m.getElementsByTagName(n)[0]; return e ? e.textContent : ''; };
    add('Title', tag('dc:title'));
    add('Author', tag('meta:initial-creator') || tag('dc:creator'));
    add('Last saved by', tag('dc:creator') !== tag('meta:initial-creator') ? tag('dc:creator') : '');
    add('Created', tag('meta:creation-date') ? dateText(tag('meta:creation-date')) : '');
    add('Saved in document', tag('dc:date') ? dateText(tag('dc:date')) : '');
    add('Application', tag('meta:generator'));
    const stat = m.getElementsByTagName('meta:document-statistic')[0];
    if (stat) {
      add('Pages (as saved)', Number(stat.getAttribute('meta:page-count')) || 0);
      add('Words (as saved)', Number(stat.getAttribute('meta:word-count')) || 0);
      add('Tables', Number(stat.getAttribute('meta:table-count')) || 0);
      add('Pictures', Number(stat.getAttribute('meta:image-count')) || 0);
    }
  },

  // The card picture: the thumbnail stored in the file, or the first words
  async thumb(entry, kind) {
    const zip = await zipLoad(entry.file);
    const pic = zip.file('Thumbnails/thumbnail.png');
    if (pic) {
      entry.thumbUrl = URL.createObjectURL(new Blob([await pic.async('uint8array')], { type: 'image/png' }));
      const img = new Image();
      img.src = entry.thumbUrl;
      entry.thumbNode = img;
      return zip;
    }
    const doc = zip.file('content.xml') ? xmlDoc(await zip.file('content.xml').async('string')) : null;
    const words = [];
    if (doc) {
      for (const el of doc.getElementsByTagName('*')) {
        if (el.nodeName !== 'text:p' && el.nodeName !== 'text:h') continue;
        const t = el.textContent.trim();
        if (t) words.push(t);
        if (words.join(' ').length > 400) break;
      }
    }
    if (words.length) entry.thumbNode = snippetNode(words[0], words.slice(1).join(' '));
    return zip;
  },
};

/* ----- Text, lists, tables: shared by text documents and slide text boxes ----- */
class OdfText {
  constructor(odf, cmPx) {
    this.odf = odf;
    this.cmPx = cmPx;                 // how many screen pixels one centimetre of the document is
    this.pending = [];                // pictures still being read
  }

  len(v) { const cm = toCm(v, null); return cm === null ? null : cm * this.cmPx; }
  px(v) { const n = this.len(v); return n === null ? '' : n.toFixed(2) + 'px'; }

  fontSize(v) {
    if (!v) return '';
    if (String(v).endsWith('%')) return v;
    return this.px(v);
  }

  textCss(t) {
    const css = [];
    if (t['fo:font-weight'] === 'bold' || Number(t['fo:font-weight']) >= 600) css.push('font-weight:700');
    if (t['fo:font-style'] === 'italic') css.push('font-style:italic');
    const decor = [];
    if (t['style:text-underline-style'] && t['style:text-underline-style'] !== 'none') decor.push('underline');
    if (t['style:text-line-through-style'] && t['style:text-line-through-style'] !== 'none') decor.push('line-through');
    if (decor.length) css.push('text-decoration:' + decor.join(' '));
    if (t['fo:color'] && t['fo:color'] !== 'transparent') css.push('color:' + t['fo:color']);
    const bg = t['fo:background-color'];
    if (bg && bg !== 'transparent') css.push('background:' + bg);
    const fs = this.fontSize(t['fo:font-size']);
    if (fs) css.push('font-size:' + fs);
    const pos = t['style:text-position'];
    if (pos && /^(super|sub)/.test(pos)) css.push('vertical-align:' + pos.split(' ')[0] + ';font-size:75%');
    if (t['fo:text-transform'] === 'uppercase') css.push('text-transform:uppercase');
    return css.join(';');
  }

  paraCss(p) {
    const css = [];
    const align = p['fo:text-align'];
    if (align) css.push('text-align:' + ({ start: 'left', end: 'right', center: 'center', justify: 'justify', left: 'left', right: 'right' }[align] || 'left'));
    const side = (prop, attr) => { const v = this.px(p[attr]); if (v) css.push(prop + ':' + v); };
    side('margin-top', 'fo:margin-top'); side('margin-bottom', 'fo:margin-bottom');
    side('margin-left', 'fo:margin-left'); side('margin-right', 'fo:margin-right');
    side('text-indent', 'fo:text-indent');
    const lh = p['fo:line-height'];
    if (lh && lh.endsWith('%')) css.push('line-height:' + (parseFloat(lh) / 100 * 1.25).toFixed(2));
    const bg = p['fo:background-color'];
    if (bg && bg !== 'transparent') css.push('background:' + bg);
    return css.join(';');
  }

  styleCss(name) {
    const st = this.odf.styles.resolve(name);
    return [this.textCss(st.text), this.paraCss(st.para)].filter(Boolean).join(';');
  }

  // Children of a text container (body, section, table cell, text box) become HTML blocks inside `out`
  blocks(parent, out, depth) {
    for (const node of parent.children) this.block(node, out, depth || 1);
  }

  block(node, out, depth) {
    switch (node.nodeName) {
      case 'text:p': out.appendChild(this.para(node, 'p')); break;
      case 'text:h': out.appendChild(this.para(node, 'h')); break;
      case 'text:list': out.appendChild(this.list(node, depth, null)); break;
      case 'table:table': out.appendChild(this.table(node)); break;
      case 'text:section': case 'text:index-body': case 'text:table-of-content': case 'text:alphabetical-index':
        this.blocks(node, out, depth); break;
      case 'draw:frame': { const wrap = h('p', 'odf-frame'); this.frame(node, wrap); out.appendChild(wrap); break; }
      default: break;          // declarations, change tracking, forms…
    }
  }

  para(node, kind) {
    let el;
    if (kind === 'h') el = h('h' + clamp(Number(node.getAttribute('text:outline-level')) || 1, 1, 6));
    else el = h('p');
    const css = this.styleCss(node.getAttribute('text:style-name'));
    if (css) el.style.cssText = css;
    this.inline(node, el);
    if (!el.textContent && !el.querySelector('img')) el.appendChild(document.createElement('br'));   // an empty line keeps its height
    return el;
  }

  inline(node, parent) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        const t = c.nodeValue.replace(/[\t\r\n ]+/g, ' ');
        if (t) parent.appendChild(document.createTextNode(t));
        continue;
      }
      if (c.nodeType !== 1) continue;
      switch (c.nodeName) {
        case 'text:span': case 'text:a': {
          const s = h('span', c.nodeName === 'text:a' ? 'odf-link' : '');
          const css = this.textCss(this.odf.styles.resolve(c.getAttribute('text:style-name')).text);
          if (css) s.style.cssText = css;
          this.inline(c, s);
          parent.appendChild(s);
          break;
        }
        case 'text:s': parent.appendChild(document.createTextNode(' '.repeat(Number(c.getAttribute('text:c')) || 1))); break;
        case 'text:tab': parent.appendChild(document.createTextNode('      ')); break;
        case 'text:line-break': parent.appendChild(document.createElement('br')); break;
        case 'draw:frame': this.frame(c, parent); break;
        case 'text:note': case 'office:annotation': case 'text:bookmark': case 'text:bookmark-start': case 'text:bookmark-end':
        case 'text:soft-page-break': case 'text:sequence-decls': break;
        default: this.inline(c, parent);       // fields, page numbers, ruby…
      }
    }
  }

  // A picture, a text box or a table that sits inside the text
  frame(node, parent) {
    const img = [...node.children].find((x) => x.nodeName === 'draw:image');
    if (img) {
      const el = h('img', 'odf-img');
      const w = this.len(node.getAttribute('svg:width'));
      if (w) el.style.width = w.toFixed(1) + 'px';
      this.pending.push(this.image(img.getAttribute('xlink:href')).then((url) => { if (url) el.src = url; else el.remove(); }));
      parent.appendChild(el);
      return;
    }
    const box = [...node.children].find((x) => x.nodeName === 'draw:text-box');
    if (box) { const d = h('div', 'odf-textbox'); this.blocks(box, d); parent.appendChild(d); return; }
    const tbl = [...node.children].find((x) => x.nodeName === 'table:table');
    if (tbl) parent.appendChild(this.table(tbl));
  }

  image(href) {
    const odf = this.odf;
    return href ? zipImageUrl(odf.zip, href, odf.images).catch(() => '') : Promise.resolve('');
  }

  list(node, depth, inheritedStyle) {
    const styleName = node.getAttribute('text:style-name') || inheritedStyle;
    const ordered = this.odf.styles.isOrdered(styleName, depth);
    const el = h(ordered ? 'ol' : 'ul');
    for (const item of node.children) {
      if (item.nodeName !== 'text:list-item' && item.nodeName !== 'text:list-header') continue;
      const li = h('li');
      for (const child of item.children) {
        if (child.nodeName === 'text:list') li.appendChild(this.list(child, depth + 1, styleName));
        else this.block(child, li, depth);
      }
      el.appendChild(li);
    }
    return el;
  }

  table(node) {
    const MAX_ROWS = 600, MAX_COLS = 40;
    const table = h('table', 'odf-table');
    const cols = h('colgroup');
    const rows = [];
    const walk = (parent) => {
      for (const c of parent.children) {
        if (c.nodeName === 'table:table-column') {
          const n = Math.min(Number(c.getAttribute('table:number-columns-repeated')) || 1, MAX_COLS);
          const w = this.px(this.odf.styles.resolve(c.getAttribute('table:style-name')).graphic['style:column-width'] || this.colWidth(c));
          for (let i = 0; i < n; i++) { const col = h('col'); if (w) col.style.width = w; cols.appendChild(col); }
        } else if (c.nodeName === 'table:table-row') rows.push(c);
        else if (/^table:table-(header-rows|row-group|rows)$/.test(c.nodeName)) walk(c);
      }
    };
    walk(node);
    if (cols.children.length) table.appendChild(cols);

    let count = 0;
    for (const row of rows) {
      if (count++ >= MAX_ROWS) break;
      const tr = h('tr');
      let cells = 0;
      for (const cell of row.children) {
        if (cell.nodeName !== 'table:table-cell') continue;
        const repeat = Math.min(Number(cell.getAttribute('table:number-columns-repeated')) || 1, 12);
        const empty = !cell.textContent.trim() && !cell.querySelector('draw\\:frame, draw\\:image');
        for (let r = 0; r < (empty ? Math.min(repeat, 1) : repeat); r++) {
          if (cells++ >= MAX_COLS) break;
          const td = h('td');
          const cs = Number(cell.getAttribute('table:number-columns-spanned')) || 1;
          const rs = Number(cell.getAttribute('table:number-rows-spanned')) || 1;
          if (cs > 1) td.colSpan = cs;
          if (rs > 1) td.rowSpan = rs;
          const st = this.odf.styles.resolve(cell.getAttribute('table:style-name')).cell;
          const bg = st['fo:background-color'];
          if (bg && bg !== 'transparent') td.style.background = bg;
          const border = st['fo:border'] || st['fo:border-bottom'] || st['fo:border-top'];
          if (border && border !== 'none') td.style.border = '1px solid ' + ((/#[0-9a-f]{6}/i.exec(border) || ['#999'])[0]);
          this.blocks(cell, td);
          tr.appendChild(td);
        }
      }
      table.appendChild(tr);
    }
    return table;
  }

  // Column widths are stored in automatic styles of the family "table-column"
  colWidth(col) {
    const el = this.odf.styles.styles.get(col.getAttribute('table:style-name'));
    const p = el && [...el.children].find((c) => c.nodeName === 'style:table-column-properties');
    return p ? p.getAttribute('style:column-width') : '';
  }
}

/* ----- ODT: a text document, shown on a white page ----- */
class OdtViewer extends ScrollViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true;
    this.defaultFit = 'width';
  }

  async open(file) {
    const odf = await Odf.load(file);
    this.odf = odf;
    const body = odf.content.getElementsByTagName('office:text')[0];
    if (!body) throw friendly('This is not a text document', 'The file is an OpenDocument file, but not a text document (.odt).');
    const size = odf.styles.pageSizeCm(null);
    const cmPx = 96 / 2.54;
    this.natural = Math.round(size.w * cmPx);
    const text = new OdfText(odf, cmPx);

    const page = h('div', 'odt-page');
    page.style.width = this.natural + 'px';
    page.style.padding = [size.mt, size.mr, size.mb, size.ml].map((v) => (v * cmPx).toFixed(0) + 'px').join(' ');
    text.blocks(body, page);
    await Promise.all(text.pending);

    this.host = h('div', 'odt-host');
    this.host.appendChild(page);
    this.content.replaceChildren(this.host);
    this.listenScroll();
    this.refit();
  }

  refit() {
    if (!this.host) return;
    const before = this.scrollRatio();
    const free = this.free();
    const byWidth = free.w / this.natural;
    this.host.style.zoom = Math.min(this.view.fit === 'width' ? byWidth : Math.min(byWidth, 1.2), 3) * this.view.zoom;
    this.stage.scrollTop = before * (this.stage.scrollHeight - this.stage.clientHeight);
    this.onChange();
  }

  label() { return 'Read ' + Math.round(this.scrollRatio() * 100) + '%'; }

  destroy() { if (this.odf) revokeAll(this.odf.images); super.destroy(); }

  static async thumb(entry) { await Odf.thumb(entry, 'odt'); }
  static async details(entry, add, dateText) { const odf = await Odf.load(entry.file); Odf.details(odf, add, dateText); }
}

/* ----- ODP: slides ----- */
class OdpViewer extends BoxViewer {
  constructor(...args) { super(...args); this.hasOverview = true; }

  async open(file) {
    const odf = await Odf.load(file);
    this.odf = odf;
    const pres = odf.content.getElementsByTagName('office:presentation')[0];
    this.pages = pres ? [...pres.children].filter((c) => c.nodeName === 'draw:page') : [];
    if (!this.pages.length) throw friendly('This presentation has no slides', 'The file is an OpenDocument file, but not a presentation (.odp).');
    const size = odf.styles.pageSizeCm(this.pages[0].getAttribute('draw:master-page-name'));
    this.pageCm = size;
    this.cmPx = 1280 / size.w;
    this.setupBox(1280, Math.round(1280 * size.h / size.w));
    this.total = this.pages.length;
    this.cur = 0;
    await this.show();
    this.refit();
  }

  get count() { return this.total; }
  get index() { return this.cur; }
  get thumbRatio() { return this.H / this.W; }
  label() { return 'Slide ' + (this.cur + 1) + ' of ' + this.total; }

  // Speaker notes: the text of presentation:notes on each slide
  notesFor(i) {
    const page = this.pages[i];
    const n = page && page.getElementsByTagName('presentation:notes')[0];
    if (!n) return '';
    return [...n.getElementsByTagName('text:p')].map((p) => p.textContent.trim()).filter(Boolean).join('\n');
  }
  get hasNotes() { return this.pages.some((_, i) => this.notesFor(i)); }

  async show() {
    const token = ++this.showToken || (this.showToken = 1);
    const slide = await this.buildSlide(this.cur);
    if (token !== this.showToken) return;
    this.box.replaceChildren(slide);
    this.onChange();
  }

  goTo(i) {
    i = clamp(i, 0, this.total - 1);
    if (i === this.cur) return;
    this.cur = i;
    this.onChange();       // the label changes at once; the picture follows in a moment
    this.show();
  }

  async renderThumb(i, el) {
    const slide = await this.buildSlide(i);
    const host = h('div', 'clone-host');
    host.style.width = this.W + 'px';
    host.style.height = this.H + 'px';
    host.style.transform = 'scale(' + ((el.clientWidth || 220) / this.W) + ')';
    host.appendChild(slide);
    el.replaceChildren(host);
  }

  // One slide as plain HTML: background, then the shapes of the master page, then the shapes of the slide
  async buildSlide(i) {
    const page = this.pages[i];
    const odf = this.odf;
    const root = h('div', 'odp-slide');
    root.style.width = this.W + 'px';
    root.style.height = this.H + 'px';
    const masterName = page.getAttribute('draw:master-page-name');
    const master = odf.styles.masters.get(masterName);

    await this.paintBackground(root, page, master);
    const text = new OdfText(odf, this.cmPx);
    if (master) this.shapes(master, root, text, true);
    this.shapes(page, root, text, false);
    await Promise.all(text.pending);
    return root;
  }

  async paintBackground(root, page, master) {
    const odf = this.odf;
    const own = odf.styles.resolve(page.getAttribute('draw:style-name')).page;
    const inherited = master ? odf.styles.resolve(master.getAttribute('draw:style-name')).page : {};
    const p = own['draw:fill'] ? own : inherited;
    const fill = p['draw:fill'];
    if (fill === 'solid' && p['draw:fill-color']) root.style.background = p['draw:fill-color'];
    else if (fill === 'gradient') {
      const g = odf.styles.gradients.get(p['draw:fill-gradient-name']);
      if (g) {
        const a = g.getAttribute('draw:start-color') || '#ffffff', b = g.getAttribute('draw:end-color') || '#cccccc';
        const angle = 180 - (Number(g.getAttribute('draw:angle')) || 0) / 10;
        root.style.background = 'linear-gradient(' + angle + 'deg,' + a + ',' + b + ')';
      }
    } else if (fill === 'bitmap') {
      const href = odf.styles.fills.get(p['draw:fill-image-name']);
      const url = href ? await this.image(href) : '';
      if (url) root.style.background = 'url(' + url + ') center / cover no-repeat';
    }
  }

  image(href) { return zipImageUrl(this.odf.zip, href, this.odf.images).catch(() => ''); }

  shapes(container, root, text, isMaster) {
    for (const node of container.children) {
      switch (node.nodeName) {
        case 'draw:frame': {
          const cls = node.getAttribute('presentation:class');
          if (isMaster && cls && cls !== 'graphic') break;         // placeholders on the master page are not drawn
          this.frameShape(node, root, text);
          break;
        }
        case 'draw:custom-shape': case 'draw:rect': case 'draw:ellipse': case 'draw:circle':
          this.plainShape(node, root, text); break;
        case 'draw:line': this.lineShape(node, root); break;
        case 'draw:g': this.shapes(node, root, text, isMaster); break;
        default: break;
      }
    }
  }

  place(node, el) {
    const x = this.cmPx * toCm(node.getAttribute('svg:x'), 0), y = this.cmPx * toCm(node.getAttribute('svg:y'), 0);
    const w = this.cmPx * toCm(node.getAttribute('svg:width'), 0), hh = this.cmPx * toCm(node.getAttribute('svg:height'), 0);
    el.style.left = x.toFixed(1) + 'px'; el.style.top = y.toFixed(1) + 'px';
    el.style.width = w.toFixed(1) + 'px'; el.style.height = hh.toFixed(1) + 'px';
    return w > 0 && hh > 0;
  }

  // Default look for the text inside a shape: from the shape's style
  textBox(node, box, text) {
    const st = this.odf.styles.resolve(node.getAttribute('presentation:style-name') || node.getAttribute('draw:style-name') || node.getAttribute('draw:text-style-name'));
    const css = [text.textCss(st.text), st.para['fo:text-align'] ? text.paraCss({ 'fo:text-align': st.para['fo:text-align'] }) : ''].filter(Boolean).join(';');
    box.style.cssText += ';font-size:' + (18 * 2.54 / 72 * this.cmPx).toFixed(1) + 'px;' + css;
    const va = st.graphic['draw:textarea-vertical-align'];
    if (va) { box.style.display = 'flex'; box.style.flexDirection = 'column'; box.style.justifyContent = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[va] || 'flex-start'; }
    const pad = (a) => text.px(st.graphic[a]);
    if (pad('fo:padding-left')) box.style.padding = [pad('fo:padding-top'), pad('fo:padding-right'), pad('fo:padding-bottom'), pad('fo:padding-left')].map((v) => v || '0').join(' ');
    return st;
  }

  frameShape(node, root, text) {
    const el = h('div', 'odp-shape');
    if (!this.place(node, el)) return;
    const img = [...node.children].find((c) => c.nodeName === 'draw:image');
    const box = [...node.children].find((c) => c.nodeName === 'draw:text-box');
    const tbl = [...node.children].find((c) => c.nodeName === 'table:table');
    if (img && img.getAttribute('xlink:href')) {
      const pic = h('img', 'odp-img');
      text.pending.push(this.image(img.getAttribute('xlink:href')).then((url) => { if (url) pic.src = url; else pic.remove(); }));
      el.appendChild(pic);
    } else if (box) {
      this.textBox(node, el, text);
      text.blocks(box, el);
    } else if (tbl) {
      this.textBox(node, el, text);
      el.appendChild(text.table(tbl));
    } else return;
    root.appendChild(el);
  }

  plainShape(node, root, text) {
    const el = h('div', 'odp-shape');
    if (!this.place(node, el)) return;
    const st = this.textBox(node, el, text);
    const g = st.graphic;
    if (g['draw:fill'] === 'solid' && g['draw:fill-color']) el.style.background = g['draw:fill-color'];
    if (g['draw:opacity']) el.style.opacity = String(parseFloat(g['draw:opacity']) / 100);
    if (g['draw:stroke'] && g['draw:stroke'] !== 'none') {
      const w = Math.max(1, this.cmPx * toCm(g['svg:stroke-width'], 0.02));
      el.style.border = w.toFixed(1) + 'px ' + (g['draw:stroke'] === 'dash' ? 'dashed ' : 'solid ') + (g['svg:stroke-color'] || '#3465a4');
    }
    const geom = node.getElementsByTagName('draw:enhanced-geometry')[0];
    const type = geom ? geom.getAttribute('draw:type') : '';
    if (node.nodeName === 'draw:ellipse' || node.nodeName === 'draw:circle' || type === 'ellipse') el.style.borderRadius = '50%';
    else if (type === 'round-rectangle') el.style.borderRadius = '12px';
    text.blocks(node, el);
    root.appendChild(el);
  }

  lineShape(node, root) {
    const x1 = this.cmPx * toCm(node.getAttribute('svg:x1'), 0), y1 = this.cmPx * toCm(node.getAttribute('svg:y1'), 0);
    const x2 = this.cmPx * toCm(node.getAttribute('svg:x2'), 0), y2 = this.cmPx * toCm(node.getAttribute('svg:y2'), 0);
    const g = this.odf.styles.resolve(node.getAttribute('draw:style-name')).graphic;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'odp-line');
    svg.setAttribute('width', this.W); svg.setAttribute('height', this.H);
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', g['svg:stroke-color'] || '#000');
    line.setAttribute('stroke-width', Math.max(1, this.cmPx * toCm(g['svg:stroke-width'], 0.02)));
    svg.appendChild(line);
    root.appendChild(svg);
  }

  destroy() {
    this.showToken = -1;
    if (this.odf) revokeAll(this.odf.images);
    super.destroy();
  }

  static async thumb(entry) { await Odf.thumb(entry, 'odp'); }
  static async details(entry, add, dateText) {
    const odf = await Odf.load(entry.file);
    const pres = odf.content.getElementsByTagName('office:presentation')[0];
    if (pres) add('Slides', [...pres.children].filter((c) => c.nodeName === 'draw:page').length);
    Odf.details(odf, add, dateText);
  }
}


/* ---------------------------------------------------------------------
   5. RTF
   A small reader of its own: text, bold / italic / underline, colours, alignment, tables,
   Unicode and the code pages of old Russian files. Pictures are not drawn (a note is shown).
   --------------------------------------------------------------------- */

const RTF_CHARSET_TO_CODEPAGE = { 0: 1252, 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
const RTF_SKIP_GROUPS = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'pict', 'object', 'listtable', 'listoverridetable', 'generator', 'revtbl', 'rsidtbl', 'xmlnstbl', 'themedata', 'colormapping', 'latentstyles', 'datastore',
  'fldinst', 'footnote', 'private', 'filetbl', 'userprops', 'pgptbl', 'mmathPr', 'wgrffmtfilter', 'defchp', 'defpap', 'shpinst', 'bkmkstart', 'bkmkend']);
const RTF_SYMBOLS = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ' };

function rtfDecoder(codepage) {
  const label = { 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
    1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh', 866: 'ibm866' }[codepage] || 'windows-1252';
  try { return new TextDecoder(label); } catch (e) { return new TextDecoder('windows-1252'); }
}

// Turns RTF bytes into HTML elements appended to `root`. Returns the plain text length (for statistics).
function rtfRender(bytes, root) {
  let src = '';
  for (let i = 0; i < bytes.length; i += 32768) src += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  if (!/^\s*\{\\rtf/.test(src)) throw friendly('This is not a valid RTF file', 'The file does not start like an RTF document. It may be a different format with the wrong extension.');

  let ansiCp = 1252;
  const cpMatch = /\\ansicpg(\d+)/.exec(src);
  if (cpMatch) ansiCp = Number(cpMatch[1]);
  const defaultUc = 1;
  const decoders = {};
  const decode = (cp, arr) => (decoders[cp] || (decoders[cp] = rtfDecoder(cp))).decode(Uint8Array.from(arr));

  const fonts = {};            // font number -> code page (from \fcharset)
  const colors = [];           // colour table; entry 0 (before the first ';') is "automatic"
  let state = { skip: false, b: false, i: false, u: false, s: false, color: 0, size: 0, align: '', cp: ansiCp, uc: defaultUc, intbl: false, li: 0, fi: 0, sa: 0, sb: 0, hidden: false, font: -1 };
  const stack = [];

  let paragraph = null, container = root, textLength = 0;
  let table = null, row = null, cell = null;
  let pendingBytes = [];
  let skipChars = 0;
  let curColor = null;
  let inFontTable = false, fontNo = -1;

  const closeTable = () => { table = row = cell = null; container = root; };
  const startParagraph = () => {
    if (state.intbl) {
      if (!table) { table = h('table', 'rtf-table'); root.appendChild(table); }
      if (!row) { row = h('tr'); table.appendChild(row); cell = null; }
      if (!cell) { cell = h('td'); row.appendChild(cell); }
      container = cell;
    } else if (table) closeTable();
    paragraph = h('p');
    const css = [];
    if (state.align) css.push('text-align:' + state.align);
    if (state.li) css.push('margin-left:' + (state.li / 15).toFixed(1) + 'px');
    if (state.fi) css.push('text-indent:' + (state.fi / 15).toFixed(1) + 'px');
    if (state.sa) css.push('margin-bottom:' + Math.min(state.sa / 15, 40).toFixed(1) + 'px');
    if (state.sb) css.push('margin-top:' + Math.min(state.sb / 15, 40).toFixed(1) + 'px');
    paragraph.style.cssText = css.join(';');
    container.appendChild(paragraph);
  };
  const endParagraph = () => {
    if (!paragraph) startParagraph();
    if (!paragraph.textContent && !paragraph.querySelector('br,img')) paragraph.appendChild(document.createElement('br'));
    paragraph = null;
  };
  const emit = (text) => {
    if (!text || state.skip || state.hidden) return;
    if (!paragraph) startParagraph();
    textLength += text.length;
    const plain = !state.b && !state.i && !state.u && !state.s && !state.color && !state.size;
    if (plain) { paragraph.appendChild(document.createTextNode(text)); return; }
    const span = h('span', '', text);
    const css = [];
    if (state.b) css.push('font-weight:700');
    if (state.i) css.push('font-style:italic');
    const deco = [state.u ? 'underline' : '', state.s ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) css.push('text-decoration:' + deco);
    if (state.color && colors[state.color]) css.push('color:' + colors[state.color]);
    if (state.size) css.push('font-size:' + (state.size / 2 * 96 / 72).toFixed(1) + 'px');
    span.style.cssText = css.join(';');
    paragraph.appendChild(span);
  };
  const flushBytes = () => {
    if (!pendingBytes.length) return;
    emit(decode(state.cp, pendingBytes));
    pendingBytes = [];
  };

  const n = src.length;
  let i = 0;
  let groupFirst = false;           // the next control word is the first thing in its group
  let starGroup = false;
  let colorEntry = { r: 0, g: 0, b: 0, any: false };

  while (i < n) {
    const ch = src[i];
    if (ch === '{') {
      flushBytes();
      stack.push({ ...state });
      groupFirst = true; starGroup = false;
      i++;
    } else if (ch === '}') {
      flushBytes();
      if (inFontTable && stack.length <= 2) inFontTable = false;
      if (stack.length) state = stack.pop();
      groupFirst = false;
      i++;
    } else if (ch === '\\') {
      i++;
      const c = src[i];
      if (c === undefined) break;
      if (/[a-zA-Z]/.test(c)) {
        let j = i;
        while (j < n && /[a-zA-Z]/.test(src[j])) j++;
        const word = src.slice(i, j);
        let k = j, param = null;
        if (src[k] === '-' || /\d/.test(src[k] || '')) {
          let m = k;
          if (src[m] === '-') m++;
          while (m < n && /\d/.test(src[m])) m++;
          param = parseInt(src.slice(k, m), 10);
          k = m;
        }
        if (src[k] === ' ') k++;                 // one space after a control word belongs to it
        i = k;

        if (groupFirst || starGroup) {
          if (starGroup || RTF_SKIP_GROUPS.has(word)) {
            if (word === 'fonttbl') inFontTable = true;
            if (word === 'colortbl') { state.skip = true; state.colorTable = true; colorEntry = { r: 0, g: 0, b: 0, any: false }; }
            else if (word !== 'fonttbl') state.skip = true;
            if (word === 'fonttbl') { /* parsed below, keep reading */ }
            groupFirst = false; starGroup = false;
            if (word !== 'fonttbl' && word !== 'colortbl') continue;
          }
          groupFirst = false;
        }
        if (state.skip && !state.colorTable) continue;

        if (state.colorTable) {
          if (word === 'red') { colorEntry.r = param; colorEntry.any = true; }
          else if (word === 'green') colorEntry.g = param;
          else if (word === 'blue') colorEntry.b = param;
          continue;
        }

        switch (word) {
          case 'par': case 'sect': endParagraph(); break;
          case 'pard': state.align = ''; state.li = 0; state.fi = 0; state.sa = 0; state.sb = 0; state.intbl = false; break;
          case 'plain': state.b = state.i = state.u = state.s = false; state.color = 0; state.size = 0; break;
          case 'b': flushBytes(); state.b = param !== 0; break;
          case 'i': flushBytes(); state.i = param !== 0; break;
          case 'ul': case 'uld': case 'uldb': case 'ulw': flushBytes(); state.u = param !== 0; break;
          case 'ulnone': flushBytes(); state.u = false; break;
          case 'strike': flushBytes(); state.s = param !== 0; break;
          case 'v': state.hidden = param !== 0; break;
          case 'cf': flushBytes(); state.color = param || 0; break;
          case 'fs': flushBytes(); state.size = param || 0; break;
          case 'qc': state.align = 'center'; break;
          case 'qr': state.align = 'right'; break;
          case 'qj': state.align = 'justify'; break;
          case 'ql': state.align = ''; break;
          case 'li': state.li = param || 0; break;
          case 'fi': state.fi = param || 0; break;
          case 'sa': state.sa = param || 0; break;
          case 'sb': state.sb = param || 0; break;
          case 'intbl': state.intbl = true; break;
          case 'trowd': if (table && row) { row = null; cell = null; } break;
          case 'cell': if (!paragraph && state.intbl) startParagraph(); endParagraph(); cell = null; break;
          case 'row': row = null; cell = null; break;
          case 'line': if (!paragraph) startParagraph(); paragraph.appendChild(document.createElement('br')); break;
          case 'tab': flushBytes(); emit('      '); break;
          case 'page': case 'pagebb': break;
          case 'uc': state.uc = param === null ? 1 : param; break;
          case 'ansicpg': break;
          case 'f': {
            flushBytes();
            if (inFontTable) { fontNo = param; } else { state.font = param; if (fonts[param]) state.cp = fonts[param]; }
            break;
          }
          case 'fcharset': if (inFontTable && fontNo >= 0) fonts[fontNo] = RTF_CHARSET_TO_CODEPAGE[param] || ansiCp; break;
          case 'u': {
            flushBytes();
            let code = param < 0 ? param + 65536 : param;
            emit(String.fromCharCode(code));
            skipChars = state.uc;
            break;
          }
          default:
            if (RTF_SYMBOLS[word]) { flushBytes(); emit(RTF_SYMBOLS[word]); }
        }
        if (word === 'pict' || word === 'shppict') { /* handled as skipped group */ }
      } else {
        // control symbol
        i++;
        if (c === '\'') {
          const hex = src.substr(i, 2);
          i += 2;
          if (skipChars > 0) { skipChars--; groupFirst = false; continue; }
          if (!state.skip && !state.colorTable) pendingBytes.push(parseInt(hex, 16));
        } else if (c === '*') { starGroup = true; continue; }
        else if (c === '\\' || c === '{' || c === '}') { flushBytes(); if (skipChars > 0) skipChars--; else emit(c); }
        else if (c === '~') { flushBytes(); emit(' '); }
        else if (c === '_') { flushBytes(); emit('‑'); }
        else if (c === '\n' || c === '\r') { flushBytes(); endParagraph(); }
        // '-' (optional hyphen) and others: ignored
        groupFirst = false;
      }
    } else if (ch === '\n' || ch === '\r') {
      i++;
    } else {
      // plain text up to the next special character
      let j = i;
      while (j < n && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}' && src[j] !== '\n' && src[j] !== '\r') j++;
      let chunk = src.slice(i, j);
      i = j;
      groupFirst = false;
      if (state.colorTable) {
        for (const c of chunk) if (c === ';') {
          colors.push(colorEntry.any ? 'rgb(' + colorEntry.r + ',' + colorEntry.g + ',' + colorEntry.b + ')' : null);
          colorEntry = { r: 0, g: 0, b: 0, any: false };
        }
        continue;
      }
      if (state.skip || state.hidden) continue;
      if (inFontTable) continue;
      if (skipChars > 0) { const cut = Math.min(skipChars, chunk.length); chunk = chunk.slice(cut); skipChars -= cut; }
      if (!chunk) continue;
      flushBytes();
      emit(chunk);
    }
  }
  flushBytes();
  if (paragraph) endParagraph();
  return textLength;
}

class RtfViewer extends ScrollViewer {
  constructor(...args) {
    super(...args);
    this.canFit = true;
    this.defaultFit = 'width';
  }

  async open(file) {
    if (file.size > 25 * 1024 * 1024) throw friendly('This file is too large', 'RTF files over 25 MB can’t be opened here.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const page = h('div', 'rtf-page');
    rtfRender(bytes, page);
    if (!page.textContent.trim() && !page.querySelector('table')) page.appendChild(h('p', 'rtf-empty', 'This document has no text that can be shown.'));
    this.natural = 794;
    page.style.width = this.natural + 'px';
    this.host = h('div', 'odt-host');
    this.host.appendChild(page);
    this.content.replaceChildren(this.host);
    this.listenScroll();
    this.refit();
  }

  refit() {
    if (!this.host) return;
    const before = this.scrollRatio();
    const free = this.free();
    const byWidth = free.w / this.natural;
    this.host.style.zoom = Math.min(this.view.fit === 'width' ? byWidth : Math.min(byWidth, 1.2), 3) * this.view.zoom;
    this.stage.scrollTop = before * (this.stage.scrollHeight - this.stage.clientHeight);
    this.onChange();
  }
  label() { return 'Read ' + Math.round(this.scrollRatio() * 100) + '%'; }

  static async thumb(entry) {
    const bytes = new Uint8Array(await entry.file.slice(0, 200000).arrayBuffer());
    const box = h('div');
    try { rtfRender(bytes, box); } catch (e) { return; }
    const lines = box.textContent.split(/\s{2,}|\n/).map((s) => s.trim()).filter(Boolean);
    const text = box.textContent.trim();
    if (!text) return;
    entry.thumbNode = snippetNode(text.slice(0, 80), text.slice(80, 440));
  }

  static async details(entry, add) {
    if (entry.size > 25 * 1024 * 1024) return;
    const buf = new Uint8Array(await entry.file.arrayBuffer());
    let head = '';
    for (let i = 0; i < Math.min(buf.length, 6000); i++) head += String.fromCharCode(buf[i]);
    const info = (name) => { const m = new RegExp('\\\\' + name + '\\s+([^}]*)\\}').exec(head); return m ? m[1].replace(/\\'([0-9a-f]{2})/gi, '').trim() : ''; };
    add('Title', info('title'));
    add('Author', info('author'));
    const box = h('div');
    const length = rtfRender(buf, box);
    add('Words', (box.textContent.match(/\S+/g) || []).length);
    add('Characters', length);
  }
}


/* ---------------------------------------------------------------------
   6. ZIP: shows what is inside (nothing is unpacked or run)
   --------------------------------------------------------------------- */

class ZipViewer extends ScrollViewer {
  async open(file) {
    if (file.size > 400 * 1024 * 1024) throw friendly('This archive is too large to list', 'Archives over 400 MB can’t be opened here.');
    const zip = await zipLoad(file);
    const items = [];
    zip.forEach((path, entry) => {
      const data = entry._data || {};
      items.push({ path, dir: entry.dir, size: data.uncompressedSize || 0, date: entry.date });
    });
    this.items = items;
    const files = items.filter((x) => !x.dir);
    const total = files.reduce((sum, x) => sum + x.size, 0);
    const folders = ZipViewer.countFolders(items);

    const page = h('div', 'zip-page');
    page.appendChild(h('div', 'zip-sum', files.length + ' ' + plural(files.length, ['file', 'files']) +
      ' · ' + folders + ' ' + plural(folders, ['folder', 'folders']) +
      ' · ' + formatSize(total) + ' unpacked'));
    page.appendChild(h('div', 'zip-note', 'This is only the list of what is inside. Nothing is unpacked. Unpack the archive on the computer to open the files.'));

    const MAX = 5000;
    const table = h('table', 'zip-table');
    const head = h('tr');
    head.append(h('th', '', 'Name'), h('th', 'num', 'Size'), h('th', '', 'Modified'));
    table.appendChild(head);
    for (const it of items.slice(0, MAX)) {
      const tr = h('tr', it.dir ? 'dir' : '');
      const clean = it.path.replace(/\/$/, '');
      const slash = clean.lastIndexOf('/');
      const name = h('td', 'zip-name');
      if (slash >= 0) name.appendChild(h('small', '', clean.slice(0, slash + 1)));
      name.appendChild(h('b', '', (slash >= 0 ? clean.slice(slash + 1) : clean) + (it.dir ? '/' : '')));
      tr.append(name, h('td', 'num', it.dir ? '' : formatSize(it.size)),
        h('td', '', it.date && !isNaN(it.date) ? it.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''));
      table.appendChild(tr);
    }
    page.appendChild(table);
    if (items.length > MAX) page.appendChild(h('div', 'zip-note', 'Showing the first ' + MAX + ' entries of ' + items.length + '.'));

    this.host = h('div', 'text-host');
    this.host.appendChild(page);
    this.content.replaceChildren(this.host);
    this.listenScroll();
    this.refit();
  }

  refit() {
    if (!this.host) return;
    const before = this.scrollRatio();
    this.host.style.zoom = this.view.zoom;
    this.stage.scrollTop = before * (this.stage.scrollHeight - this.stage.clientHeight);
    this.onChange();
  }
  label() { return 'Read ' + Math.round(this.scrollRatio() * 100) + '%'; }

  // Folders are often not listed on their own, so they are also counted from the paths
  static countFolders(items) {
    const set = new Set();
    for (const it of items) {
      const parts = it.path.replace(/\/$/, '').split('/');
      if (!it.dir) parts.pop();
      for (let i = 1; i <= parts.length; i++) if (parts[0] !== '') set.add(parts.slice(0, i).join('/'));
    }
    return set.size;
  }

  static async listing(entry) {
    if (entry.size > 400 * 1024 * 1024) return null;
    const zip = await zipLoad(entry.file);
    const items = [];
    zip.forEach((path, e) => items.push({ path, dir: e.dir, size: (e._data && e._data.uncompressedSize) || 0 }));
    return items;
  }

  static async thumb(entry) {
    const items = await ZipViewer.listing(entry);
    if (!items) return;
    const names = items.filter((x) => !x.dir).slice(0, 14).map((x) => x.path.split('/').pop());
    const box = h('div', 'snippet zip-snip');
    box.appendChild(h('b', '', items.filter((x) => !x.dir).length + ' ' + plural(items.filter((x) => !x.dir).length, ['file', 'files'])));
    for (const n of names) box.appendChild(h('span', '', n));
    entry.thumbNode = box;
  }

  static async details(entry, add) {
    const items = await ZipViewer.listing(entry);
    if (!items) { add('Contents', 'Too large to read here'); return; }
    const files = items.filter((x) => !x.dir);
    add('Files', files.length);
    add('Folders', ZipViewer.countFolders(items));
    add('Unpacked size', formatSize(files.reduce((sum, x) => sum + x.size, 0)));
  }
}


/* ---------------------------------------------------------------------
   7. JSON: shown as indented text (never run)
   --------------------------------------------------------------------- */

class JsonViewer extends TextViewer {
  format(text, truncated) {
    if (truncated) return { text, note: 'Only the first 2 MB are shown, as they are in the file.' };
    try { return { text: JSON.stringify(JSON.parse(text), null, 2), note: '' }; }
    catch (e) { return { text, note: 'This file is not valid JSON, so it is shown as it is.' }; }
  }

  async open(file) {
    await super.open(file);
    const page = this.host.querySelector('.text-page');
    if (page) page.classList.add('code-page');
  }

  static async thumb(entry) {
    const head = await entry.file.slice(0, 1500).arrayBuffer();
    let text = decodeText(head, entry.size > 1500).trim();
    try { if (entry.size <= 1500) text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* as it is */ }
    if (!text) return;
    const lines = text.split(/\r?\n/);
    entry.thumbNode = snippetNode(lines[0].slice(0, 60), lines.slice(1, 12).join(' ').slice(0, 300), 'code-snip');
  }

  static async details(entry, add) {
    if (entry.size > 20 * 1024 * 1024) return;
    const text = decodeText(await entry.file.arrayBuffer(), false);
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) { add('Contents', 'A list'); add('Items', data.length); }
      else if (data && typeof data === 'object') { add('Contents', 'An object'); add('Top-level keys', Object.keys(data).length); }
      else add('Contents', 'A single value');
      add('Valid JSON', 'Yes');
    } catch (e) { add('Valid JSON', 'No — shown as plain text'); }
    add('Lines', text.split(/\r?\n/).length);
  }
}


/* ---------------------------------------------------------------------
   8. EPUB books
   An EPUB is a zip of small web pages. Each section is cleaned (no scripts, no styles of its own,
   no links to the internet) and shown in Lectern's own reading style. Next / Previous scroll
   by a screen, and move to the next section at the end.
   --------------------------------------------------------------------- */

const EPUB_DROP = 'script,style,link,iframe,object,embed,form,input,button,select,textarea,audio,video,base,meta,noscript,title,head';

class EpubBook {
  static async load(file) {
    if (file.size > 400 * 1024 * 1024) throw friendly('This book is too large', 'Files over 400 MB can’t be opened here.');
    const zip = await zipLoad(file);
    const read = async (name) => (zip.file(name) ? zip.file(name).async('string') : '');
    const container = await read('META-INF/container.xml');
    const m = /full-path="([^"]+)"/.exec(container);
    if (!m) throw friendly('This does not look like an EPUB book', 'META-INF/container.xml is missing. The file may be damaged.');
    const opfPath = m[1];
    const opf = xmlDoc(await read(opfPath));
    const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const manifest = new Map();
    for (const it of opf.getElementsByTagName('item')) {
      manifest.set(it.getAttribute('id'), { href: it.getAttribute('href'), type: it.getAttribute('media-type'), props: it.getAttribute('properties') || '' });
    }
    const spine = [];
    for (const ref of opf.getElementsByTagName('itemref')) {
      const item = manifest.get(ref.getAttribute('idref'));
      if (item && /x?html/.test(item.type || '')) spine.push({ path: EpubBook.resolve(dir, item.href), title: '' });
    }
    if (!spine.length) throw friendly('This book has no readable sections', 'The EPUB file lists no text sections.');

    const meta = (tag) => { const e = opf.getElementsByTagName('dc:' + tag)[0] || opf.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ''; };
    const info = { title: meta('title'), author: meta('creator'), language: meta('language'), publisher: meta('publisher'), date: meta('date') };

    // Section titles from the table of contents (EPUB 3 "nav" or EPUB 2 "ncx")
    const titles = new Map();
    try {
      const nav = [...manifest.values()].find((x) => /\bnav\b/.test(x.props));
      const ncx = [...manifest.values()].find((x) => x.type === 'application/x-dtbncx+xml');
      if (nav) {
        const doc = new DOMParser().parseFromString(await read(EpubBook.resolve(dir, nav.href)), 'text/html');
        const base = EpubBook.resolve(dir, nav.href);
        for (const a of doc.querySelectorAll('nav a[href]')) {
          const p = EpubBook.resolve(base.slice(0, base.lastIndexOf('/') + 1), a.getAttribute('href').split('#')[0]);
          if (!titles.has(p)) titles.set(p, a.textContent.trim().replace(/\s+/g, ' '));
        }
      } else if (ncx) {
        const doc = xmlDoc(await read(EpubBook.resolve(dir, ncx.href)));
        const base = EpubBook.resolve(dir, ncx.href);
        for (const np of doc.getElementsByTagName('navPoint')) {
          const label = np.getElementsByTagName('text')[0], content = np.getElementsByTagName('content')[0];
          if (!label || !content) continue;
          const p = EpubBook.resolve(base.slice(0, base.lastIndexOf('/') + 1), content.getAttribute('src').split('#')[0]);
          if (!titles.has(p)) titles.set(p, label.textContent.trim().replace(/\s+/g, ' '));
        }
      }
    } catch (e) { /* the sections are simply numbered */ }
    spine.forEach((s, i) => { s.title = titles.get(s.path) || ''; s.n = i + 1; });

    // The cover picture (if any)
    let cover = null;
    const coverMeta = [...opf.getElementsByTagName('meta')].find((x) => x.getAttribute('name') === 'cover');
    const coverItem = [...manifest.values()].find((x) => /cover-image/.test(x.props)) || (coverMeta && manifest.get(coverMeta.getAttribute('content')));
    if (coverItem) cover = EpubBook.resolve(dir, coverItem.href);

    return { zip, spine, info, cover, dir };
  }

  // "OEBPS/text/" + "../images/a.png" -> "OEBPS/images/a.png"
  static resolve(baseDir, href) {
    if (!href) return '';
    let path = decodeURIComponent(href.split('#')[0].split('?')[0]);
    if (path.startsWith('/')) path = path.slice(1); else path = baseDir + path;
    const out = [];
    for (const part of path.split('/')) {
      if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  }
}

class EpubViewer extends ScrollViewer {
  constructor(...args) {
    super(...args);
    this.hasOverview = true;
    this.canFit = false;
    this.images = new Map();
  }

  async open(file) {
    this.book = await EpubBook.load(file);
    this.cur = 0;
    this.listenScroll();
    await this.show(0);
  }

  get count() { return this.book.spine.length; }
  get index() { return this.cur; }
  inkKey() { return 'section' + this.cur; }
  caption(i) { const s = this.book.spine[i]; return s.title || 'Section ' + s.n; }
  label() {
    const s = this.book.spine[this.cur];
    return 'Section ' + (this.cur + 1) + ' of ' + this.count + (s.title ? ' · ' + s.title : '');
  }

  async show(i) {
    const token = (this.showToken = (this.showToken || 0) + 1);
    const s = this.book.spine[i];
    const file = this.book.zip.file(s.path);
    const page = h('div', 'epub-page');
    const pending = [];
    if (!file) page.appendChild(h('p', '', 'This section is missing from the book.'));
    else this.fill(page, await file.async('string'), s.path, pending);
    await Promise.all(pending);
    if (token !== this.showToken) return;
    this.host = h('div', 'text-host');
    this.host.appendChild(page);
    this.content.replaceChildren(this.host);
    this.host.style.zoom = this.view.zoom;
    this.stage.scrollTo(0, 0);
    this.onChange();
  }

  // Turns the XHTML of one section into safe, plain markup
  fill(page, source, path, pending) {
    let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(source, 'text/html');
    const body = doc.body || doc.getElementsByTagName('body')[0];
    if (!body) { page.appendChild(h('p', '', doc.documentElement ? doc.documentElement.textContent : '')); return; }
    const baseDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';

    // Pictures wrapped in <svg> (cover pages) become normal <img>
    for (const svg of [...body.getElementsByTagName('svg')]) {
      const im = svg.getElementsByTagName('image')[0];
      if (im) {
        const img = doc.createElement('img');
        img.setAttribute('data-src', im.getAttribute('xlink:href') || im.getAttribute('href') || '');
        svg.replaceWith(img);
      } else svg.remove();
    }
    body.querySelectorAll(EPUB_DROP).forEach((el) => el.remove());

    for (const el of body.querySelectorAll('*')) {
      for (const a of [...el.attributes]) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcset' || name === 'class' || name === 'src' || name === 'href' || name.includes(':') || name === 'data-src') {
          if (name !== 'data-src' && name !== 'src' && name !== 'href') el.removeAttribute(a.name);
        }
      }
      if (el.localName === 'img') {
        const ref = el.getAttribute('data-src') || el.getAttribute('src') || '';
        el.removeAttribute('src'); el.removeAttribute('data-src');
        const p = EpubBook.resolve(baseDir, ref);
        pending.push(zipImageUrl(this.book.zip, p, this.images).then((url) => { if (url) el.setAttribute('src', url); else el.remove(); }).catch(() => el.remove()));
      } else if (el.localName === 'a') {
        const href = el.getAttribute('href') || '';
        el.removeAttribute('href');
        if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) { el.setAttribute('class', 'ext'); continue; }       // links to the internet do nothing (offline, read-only)
        const target = EpubBook.resolve(baseDir, href);
        const idx = this.book.spine.findIndex((x) => x.path === target);
        if (idx >= 0) { el.dataset.section = String(idx); el.setAttribute('class', 'int'); }
      }
    }
    const imported = document.importNode(body, true);
    page.append(...imported.childNodes);
    page.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-section]');
      if (a) { e.preventDefault(); this.goTo(Number(a.dataset.section)); }
    });
  }

  goTo(i) {
    i = clamp(i, 0, this.count - 1);
    if (i === this.cur && this.host) return;
    this.cur = i;
    this.show(i);
  }

  // Next / Previous: scroll by a screen, and change section at the end / start
  go(where) {
    const st = this.stage;
    const atBottom = st.scrollTop + st.clientHeight >= st.scrollHeight - 4;
    if (where === 'first') return this.goTo(0);
    if (where === 'last') { this.goTo(this.count - 1); return; }
    if (where === 'next') {
      if (!atBottom) st.scrollTo({ top: st.scrollTop + st.clientHeight * 0.9, behavior: 'smooth' });
      else if (this.cur < this.count - 1) this.goTo(this.cur + 1);
    } else if (where === 'prev') {
      if (st.scrollTop > 4) st.scrollTo({ top: st.scrollTop - st.clientHeight * 0.9, behavior: 'smooth' });
      else if (this.cur > 0) this.goTo(this.cur - 1);
    }
  }

  progress() { return this.count > 1 ? (this.cur + this.scrollRatio()) / this.count : this.scrollRatio(); }
  seek(ratio) {
    const t = clamp(ratio, 0, 1) * this.count;
    const i = Math.min(Math.floor(t), this.count - 1);
    if (i !== this.cur) { this.cur = i; this.show(i).then(() => { this.stage.scrollTop = (t - i) * (this.stage.scrollHeight - this.stage.clientHeight); }); }
    else this.stage.scrollTop = (t - i) * (this.stage.scrollHeight - this.stage.clientHeight);
  }
  atStart() { return this.cur === 0 && this.stage.scrollTop <= 2; }
  atEnd() { return this.cur >= this.count - 1 && this.stage.scrollTop + this.stage.clientHeight >= this.stage.scrollHeight - 2; }
  currentIndex() { return this.cur; }

  refit() {
    if (!this.host) return;
    const before = this.scrollRatio();
    this.host.style.zoom = this.view.zoom;
    this.stage.scrollTop = before * (this.stage.scrollHeight - this.stage.clientHeight);
    this.onChange();
  }

  async renderThumb(i, el) {
    const s = this.book.spine[i];
    const file = this.book.zip.file(s.path);
    let words = '';
    if (file) {
      const doc = new DOMParser().parseFromString(await file.async('string'), 'text/html');
      words = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 260);
    }
    el.replaceChildren(snippetNode(s.title || 'Section ' + s.n, words));
  }

  destroy() {
    this.showToken = -1;
    revokeAll(this.images);
    super.destroy();
  }

  static async thumb(entry) {
    const book = await EpubBook.load(entry.file);
    if (book.cover) {
      const url = await zipImageUrl(book.zip, book.cover);
      if (url) {
        entry.thumbUrl = url;
        const img = new Image();
        img.src = url;
        entry.thumbNode = img;
        return;
      }
    }
    entry.thumbNode = snippetNode(book.info.title || entry.base, book.info.author);
  }

  static async details(entry, add, dateText) {
    const book = await EpubBook.load(entry.file);
    add('Title', book.info.title);
    add('Author', book.info.author);
    add('Publisher', book.info.publisher);
    add('Language', book.info.language);
    add('Published', book.info.date ? (dateText(book.info.date) || book.info.date) : '');
    add('Sections', book.spine.length);
  }
}


// Hand the viewers over to app.js
Object.assign(VIEWER_CLASSES, {
  media: MediaViewer, heic: HeicViewer, tiff: TiffViewer, odp: OdpViewer, odt: OdtViewer, rtf: RtfViewer,
  zip: ZipViewer, json: JsonViewer, epub: EpubViewer,
});
