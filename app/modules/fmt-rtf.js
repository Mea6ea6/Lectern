'use strict';
/* Lectern — RTF documents. Loaded on demand (see VIEWER_LIB in core.js); shares the global scope with the app scripts and fmt-common.js. */

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
    if (!page.textContent.trim() && !page.querySelector('table')) page.appendChild(stateNode('Nothing to show', 'This document has no text that can be shown.'));
    this.natural = 794;
    page.style.width = this.natural + 'px';
    this.host = h('div', 'odt-host');
    this.host.appendChild(page);
    this.put(this.host);
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

Object.assign(VIEWER_CLASSES, { rtf: RtfViewer });
