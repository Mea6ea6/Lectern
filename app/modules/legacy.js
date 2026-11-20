'use strict';
/* Lectern — old Office files: .doc (Word 97–2003) and .ppt / .pps (PowerPoint 97–2003).
   They are not zips but "compound files". SheetJS (already used for .xls) can open that container (XLSX.CFB), and
   this file reads the text out of it. Only TEXT is shown (paragraphs, simple tables, slide titles and bodies):
   no pictures, fonts or layout — that is said once in a toast. Loaded on demand (see VIEWER_LIB in core.js). */

const LEG = (() => {
  const u8 = (x) => (x instanceof Uint8Array ? x : Uint8Array.from(x));
  const dec1252 = new TextDecoder('windows-1252');
  const dec16 = new TextDecoder('utf-16le');

  function container(buf) {
    const bytes = new Uint8Array(buf);
    if (!(bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0)) throw friendly('This is not an old Office file', 'The file has the extension of an old Word or PowerPoint file, but its contents are different.');
    let cfb;
    try { cfb = XLSX.CFB.read(bytes, { type: 'array' }); } catch (e) { throw friendly('This file is damaged', 'It can’t be read. Try opening it in Word or PowerPoint and saving it again.'); }
    return { stream: (name) => { const f = XLSX.CFB.find(cfb, name); return f && f.content ? u8(f.content) : null; } };
  }

  /* ---------------- Word ---------------- */
  // Returns the document text: paragraphs are separated by \r, table cells end with \u0007
  function wordText(cf) {
    const wd = cf.stream('WordDocument');
    if (!wd || wd.length < 0x200) throw friendly('This is not a Word document', 'The file does not contain a Word document.');
    const dv = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (dv.getUint16(0, true) !== 0xA5EC && dv.getUint16(0, true) !== 0xA5DC) throw friendly('This is not a Word document', 'The file does not contain a Word document.');
    const flags = dv.getUint16(0x0A, true);
    if (flags & 0x100) throw friendly('This file is password-protected', 'Protected files can’t be opened here.');
    const nFib = dv.getUint16(2, true);
    const ccpText = dv.getInt32(0x4C, true);
    let out = '';
    const tbl = cf.stream(flags & 0x200 ? '1Table' : '0Table');
    const fcClx = nFib >= 0xC1 ? dv.getUint32(0x1A2, true) : 0, lcbClx = nFib >= 0xC1 ? dv.getUint32(0x1A6, true) : 0;
    if (tbl && lcbClx && fcClx + lcbClx <= tbl.length) {
      const tv = new DataView(tbl.buffer, tbl.byteOffset, tbl.byteLength);
      let pos = fcClx;
      while (pos < fcClx + lcbClx && tbl[pos] === 1) pos += 3 + tv.getUint16(pos + 1, true);       // skip property modifiers
      if (tbl[pos] === 2) {
        const lcb = tv.getUint32(pos + 1, true), plc = pos + 5, n = (lcb - 4) / 12 | 0;
        for (let i = 0; i < n; i++) {
          const cp0 = tv.getUint32(plc + i * 4, true), cp1 = tv.getUint32(plc + (i + 1) * 4, true);
          const fc = tv.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
          const len = cp1 - cp0;
          if (fc & 0x40000000) { const o = (fc & 0x3FFFFFFF) >>> 1; out += dec1252.decode(wd.subarray(o, o + len)); }
          else out += dec16.decode(wd.subarray(fc, fc + len * 2));
          if (out.length > 20e6) break;
        }
      }
    }
    if (!out) {                                              // Word 6/95 or a file without a piece table: plain 8-bit text
      const a = dv.getUint32(0x18, true), b = dv.getUint32(0x1C, true);
      if (b > a && b <= wd.length) out = dec1252.decode(wd.subarray(a, b));
    }
    if (ccpText > 0 && ccpText < out.length) out = out.slice(0, ccpText);
    return out;
  }

  // Text -> blocks: { p: 'paragraph' } or { table: [[cell, …], …] }
  function wordBlocks(text) {
    // Fields: "\x13 code \x14 shown \x15" keeps only the shown part
    let clean = '', depth = [];
    for (const ch of text) {
      if (ch === '\x13') depth.push(false);
      else if (ch === '\x14') { if (depth.length) depth[depth.length - 1] = true; }
      else if (ch === '\x15') depth.pop();
      else if (!depth.length || depth[depth.length - 1]) clean += ch;
    }
    clean = clean.replace(/\x01|\x08|\x05|\x02/g, '').replace(/\x0B/g, '\n').replace(/\x0C/g, '\n').replace(/\x1E/g, '-').replace(/\x1F/g, '');
    const blocks = []; let buf = '', toks = [];
    // A table is a run of cell marks (\x07). The mark that ends a row looks like an empty cell, so the number of columns is the
    // one for which every group of (columns + 1) marks ends with an empty one; uneven tables (merged cells) fall back to a guess.
    const rowsOf = (t) => {
      for (let n = 1; n < t.length; n++) {
        if (t.length % (n + 1)) continue;
        let ok = true;
        for (let i = n; i < t.length; i += n + 1) if (t[i]) { ok = false; break; }
        if (ok) { const rows = []; for (let i = 0; i < t.length; i += n + 1) rows.push(t.slice(i, i + n)); return rows; }
      }
      const rows = []; let row = [];
      for (const c of t) { if (!c && row.length) { rows.push(row); row = []; } else row.push(c); }
      if (row.length) rows.push(row);
      return rows;
    };
    const flushTable = () => { if (toks.length) { blocks.push({ table: rowsOf(toks) }); toks = []; } };
    for (const ch of clean) {
      if (ch === '\r') { flushTable(); blocks.push({ p: buf }); buf = ''; }
      else if (ch === '\x07') { toks.push(buf); buf = ''; }
      else buf += ch;
    }
    flushTable();
    if (buf) blocks.push({ p: buf });
    return blocks;
  }

  function wordHtml(buf) {
    const blocks = wordBlocks(wordText(container(buf)));
    const page = h('div', 'rtf-page');
    let blank = 0;
    for (const b of blocks) {
      if (b.table) {
        const t = h('table'); const body = h('tbody'); t.appendChild(body);
        for (const r of b.table) { const tr = h('tr'); for (const c of r) tr.appendChild(h('td', '', c.replace(/\n/g, ' '))); body.appendChild(tr); }
        page.appendChild(t); blank = 0;
      } else if (!b.p.trim()) { if (++blank < 3) page.appendChild(h('p', 'rtf-gap', ' ')); }
      else {
        blank = 0;
        const p = h('p');
        b.p.split('\n').forEach((line, i) => { if (i) p.appendChild(document.createElement('br')); p.appendChild(document.createTextNode(line)); });
        page.appendChild(p);
      }
    }
    return page;
  }

  /* ---------------- PowerPoint ---------------- */
  function pptSlides(buf) {
    const cf = container(buf);
    const s = cf.stream('PowerPoint Document');
    if (!s) throw friendly('This is not a PowerPoint file', 'The file does not contain a presentation.');
    const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const rec = (pos) => (pos + 8 > s.length ? null : { ver: s[pos] & 15, inst: (dv.getUint16(pos, true) >> 4), type: dv.getUint16(pos + 2, true), len: dv.getUint32(pos + 4, true), at: pos + 8 });
    const kids = function* (r) {                                 // the records inside a container
      let p = r.at; const end = Math.min(r.at + r.len, s.length);
      while (p + 8 <= end) { const k = rec(p); if (!k) return; yield k; p = k.at + k.len; }
    };
    const text = (r) => (r.type === 4000 ? dec16.decode(s.subarray(r.at, r.at + r.len)) : dec1252.decode(s.subarray(r.at, r.at + r.len))).replace(/\r/g, '\n').replace(/\x0B/g, '\n').replace(/[\x00-\x08\x0C\x0E-\x1F]/g, '');
    const drawingText = (r, out) => {                            // text boxes: every text atom inside a drawing
      for (const k of kids(r)) {
        if (k.type === 4000 || k.type === 4008) { const t = text(k).trim(); if (t) out.push(t); }
        else if (k.ver === 15) drawingText(k, out);
      }
    };

    // The newest document container, and the offsets of the slides (persist directory), if the file has them
    let doc = null; const scanned = [];                         // scanned: the slide containers in file order (a fallback)
    for (let p = 0; p + 8 <= s.length;) { const r = rec(p); if (!r || r.len > s.length) break; if (r.type === 1000) doc = r; else if (r.type === 1006) scanned.push(r); p = r.at + r.len; }
    if (!doc) throw friendly('This presentation can’t be read', 'The file is damaged or saved in an unusual way.');

    const persist = new Map();
    try {
      const cu = cf.stream('Current User');
      let edit = cu ? new DataView(cu.buffer, cu.byteOffset, cu.byteLength).getUint32(16, true) : 0;
      for (let guard = 0; edit && guard < 200; guard++) {
        const ue = rec(edit); if (!ue || ue.type !== 4085) break;
        const lastEdit = dv.getUint32(ue.at + 8, true), dirOff = dv.getUint32(ue.at + 12, true);
        const pd = rec(dirOff);
        if (pd && pd.type === 6002) {
          let p = pd.at; const end = pd.at + pd.len;
          while (p + 4 <= end) {
            const head = dv.getUint32(p, true), first = head & 0xFFFFF, count = head >>> 20; p += 4;
            for (let i = 0; i < count && p + 4 <= end; i++, p += 4) if (!persist.has(first + i)) persist.set(first + i, dv.getUint32(p, true));
          }
        }
        if (!lastEdit || lastEdit === edit) break;
        edit = lastEdit;
      }
    } catch (e) { /* no persist directory: only placeholder text is used */ }

    const slides = [];
    for (const r of kids(doc)) {
      if (r.type !== 4080 || r.inst !== 0) continue;                  // SlideListWithText of the slides (1 = masters, 2 = notes)
      let cur = null;
      for (const k of kids(r)) {
        if (k.type === 1011) { cur = { id: dv.getUint32(k.at, true), title: '', body: [], extra: [] }; slides.push(cur); }
        else if (k.type === 3999 && cur) cur.kind = dv.getUint32(k.at, true);
        else if ((k.type === 4000 || k.type === 4008) && cur) {
          const t = text(k).trim(); if (!t) continue;
          if ((cur.kind === 0 || cur.kind === 6) && !cur.title) cur.title = t; else cur.body.push(t);
        }
      }
    }
    slides.forEach((sl, i) => {                                    // plus the text boxes drawn on the slide itself
      const off = persist.get(sl.id);
      let r = off !== undefined ? rec(off) : null;
      if (!r || r.type !== 1006) r = scanned.length === slides.length ? scanned[i] : null;
      if (r && r.type === 1006) { try { drawingText(r, sl.extra); } catch (e) { /* skip */ } }
      sl.extra = sl.extra.filter((t) => t !== sl.title && !sl.body.includes(t));
      if (!sl.title && sl.extra.length && sl.extra[0].length < 120 && !sl.body.length) sl.title = sl.extra.shift();
    });
    if (!slides.length) throw friendly('This presentation has no slides', 'No slides were found in the file.');
    return slides;
  }

  return { wordHtml, wordText, wordBlocks, pptSlides };
})();

/* ----- .doc ----- */
class DocViewer extends RtfViewer {
  async open(file) {
    if (file.size > 40 * 1024 * 1024) throw friendly('This file is too large', 'Word files over 40 MB can’t be opened here.');
    const page = LEG.wordHtml(await file.arrayBuffer());
    if (!page.textContent.trim() && !page.querySelector('table')) page.appendChild(stateNode('Nothing to show', 'This document has no text that can be shown.'));
    this.natural = 794;
    page.style.width = this.natural + 'px';
    this.host = h('div', 'odt-host');
    this.host.appendChild(page);
    this.put(this.host);
    this.listenScroll();
    this.refit();
    showToast('Old .doc format: text only. Save as .docx to see everything.', 3600);
  }

  static async thumb(entry) {
    if (entry.size > 20 * 1024 * 1024) return;
    let page;
    try { page = LEG.wordHtml(await entry.file.arrayBuffer()); } catch (e) { return; }
    const text = page.textContent.trim();
    if (text) entry.thumbNode = snippetNode(text.slice(0, 80), text.slice(80, 440));
  }

  static async details(entry, add) {
    if (entry.size > 20 * 1024 * 1024) return;
    const page = LEG.wordHtml(await entry.file.arrayBuffer());
    const t = page.textContent;
    add('Words', (t.match(/\S+/g) || []).length);
    add('Characters', t.length);
  }
}

/* ----- .ppt / .pps ----- */
class PptViewer extends BoxViewer {
  constructor(...args) { super(...args); this.hasOverview = true; }

  async open(file) {
    if (file.size > 150 * 1024 * 1024) throw friendly('This file is too large', 'Presentations over 150 MB can’t be opened here.');
    this.slides = LEG.pptSlides(await file.arrayBuffer());
    this.total = this.slides.length;
    this.cur = 0;
    this.setupBox(1280, 720);
    this.show();
    this.refit();
    showToast('Old .ppt format: text only. Save as .pptx to see everything.', 3600);
  }

  get count() { return this.total; }
  get index() { return this.cur; }
  get thumbRatio() { return 9 / 16; }
  label() { return 'Slide ' + (this.cur + 1) + ' of ' + this.total; }

  slideNode(i) {
    const s = this.slides[i];
    const el = h('div', 'ppt-slide');
    if (s.title) el.appendChild(h('div', 'ppt-title', s.title));
    const body = h('div', 'ppt-body');
    let lines = 0;
    const add = (line) => { body.appendChild(h('p', '', line)); lines++; };
    for (const t of s.body) for (const line of t.split('\n').map((x) => x.trim()).filter(Boolean)) add(line);     // placeholder text: one line per paragraph
    for (const t of s.extra) {                                      // a text box is one block, even when its lines were wrapped
      const parts = t.split('\n').map((x) => x.trim()).filter(Boolean);
      add(parts.length > 2 && parts.every((x) => x.length <= 1) ? parts.join('') : parts.join(' '));
    }
    if (body.childNodes.length) el.appendChild(body);
    const chars = body.textContent.length;
    if (lines > 14 || chars > 700) el.classList.add('ppt-xs'); else if (lines > 7 || chars > 350) el.classList.add('ppt-s');
    return el;
  }

  show() { this.box.replaceChildren(this.slideNode(this.cur)); this.onChange(); }

  goTo(i) {
    i = clamp(i, 0, this.total - 1);
    if (i === this.cur) return;
    this.cur = i;
    this.show();
  }

  async renderThumb(i, el) {
    const host = h('div', 'clone-host');
    host.style.width = this.W + 'px';
    host.style.height = this.H + 'px';
    host.style.transform = 'scale(' + ((el.clientWidth || 220) / this.W) + ')';
    host.appendChild(this.slideNode(i));
    el.replaceChildren(host);
  }

  static async thumb(entry) {
    if (entry.size > 60 * 1024 * 1024) return;
    let slides;
    try { slides = LEG.pptSlides(await entry.file.arrayBuffer()); } catch (e) { return; }
    entry.pages = slides.length;
    const s = slides[0];
    entry.thumbNode = snippetNode(s.title || (s.body[0] || '').slice(0, 80), (s.body.join(' ') + ' ' + s.extra.join(' ')).slice(0, 360));
  }

  static async details(entry, add) {
    if (entry.size > 60 * 1024 * 1024) return;
    const slides = LEG.pptSlides(await entry.file.arrayBuffer());
    add('Slides', slides.length);
    add('Words', slides.reduce((n, s) => n + ((s.title + ' ' + s.body.join(' ') + ' ' + s.extra.join(' ')).match(/\S+/g) || []).length, 0));
  }
}

Object.assign(VIEWER_CLASSES, { doc: DocViewer, ppt: PptViewer });
