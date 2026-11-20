'use strict';
/* Lectern — spreadsheets: xlsx, xlsm, xls, ods, csv, tsv (one sheet at a time, as a table with the cell styles, charts, pictures,
   formulas and conditional formatting). Loaded on demand (see VIEWER_LIB in core.js). */

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
      await lib('office');
      if (new Uint8Array(buf, 0, 2).join() === '80,75' && /\.xls[xm]$/i.test(file.name || '')) {
        this.decor = await OFC.xlsxDecor(buf);
        for (const name of this.names) {                           // formulas without a saved result come back as cells
          const ws = this.wb.Sheets[name], info = this.decor && this.decor[name];
          if (!ws || !info || !info.formulas.length) continue;
          let rg = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 1e9, c: 1e9 }, e: { r: 0, c: 0 } };
          for (const [ref, f, z] of info.formulas) {
            const cell = (ws[ref] = ws[ref] || { t: 'z' });
            cell.f = f;
            if (z && !cell.z) cell.z = z;
            const a = XLSX.utils.decode_cell(ref);
            rg = { s: { r: Math.min(rg.s.r, a.r), c: Math.min(rg.s.c, a.c) }, e: { r: Math.max(rg.e.r, a.r), c: Math.max(rg.e.c, a.c) } };
          }
          ws['!ref'] = XLSX.utils.encode_range(rg);
        }
      }
      OFC.fillFormulas(this.wb);
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
      host.appendChild(stateNode('This sheet is empty', ''));
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
        const im = h('img'); im.src = d.url = d.url || URL.createObjectURL(d.blob); im.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block';
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

    if (info && info.cf.length) OFC.cfPrepare(info.cf, ws);
    const table = h('table', 'sheet');
    const head = h('tr');
    head.appendChild(h('th', 'rn', ''));
    for (let c = 0; c < cols; c++) {
      const th = h('th', '', letters(c + dc));
      if (info && info.colW[c + dc]) th.style.minWidth = info.colW[c + dc] + 'px';
      head.appendChild(th);
    }
    table.appendChild(head);

    const buildRow = (row, r) => {
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
        const cf = info && info.cf.length ? OFC.cfStyle(info.cf, ws, r + range0.s.r, c + dc) : null;
        if (cf) {
          if (cf.bg) td.style.background = cf.bg;
          if (cf.bar) td.style.background = 'linear-gradient(to right, ' + cf.bar.color + ' ' + cf.bar.pct + '%, transparent ' + cf.bar.pct + '%)';
          if (cf.color) td.style.color = cf.color;
          if (cf.bold) td.style.fontWeight = '700';
          if (cf.icon) {
            const ic = h('span', 'cf-icon', cf.icon.glyph);
            ic.style.color = cf.icon.color;
            td.insertBefore(ic, td.firstChild);
            if (cf.hideValue) td.childNodes[1].textContent = '';
          }
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    };
    rows.forEach(buildRow);

    const frag = document.createDocumentFragment();
    frag.appendChild(table);
    let shown = MAX_ROWS;
    if (all.length > MAX_ROWS || cols >= MAX_COLS) {
      const note = h('div', 'sheet-note');
      const text = () => 'Showing the first ' + Math.min(all.length, shown) + ' of ' + all.length + ' rows' + (cols >= MAX_COLS ? ' and ' + cols + ' columns' : '') + '. ';
      note.textContent = text();
      if (all.length > MAX_ROWS) {
        const more = h('button', 'btn-link', 'Show ' + Math.min(MAX_ROWS, all.length - shown) + ' more rows');
        more.type = 'button';
        more.addEventListener('click', () => {
          const to = Math.min(all.length, shown + MAX_ROWS);
          for (let r = shown; r < to; r++) buildRow(all[r], r);
          shown = to;
          note.firstChild.textContent = text();
          if (shown >= all.length) more.remove(); else more.textContent = 'Show ' + Math.min(MAX_ROWS, all.length - shown) + ' more rows';
        });
        note.appendChild(more);
      }
      frag.appendChild(note);
    }
    return frag;
  }

  destroy() {
    if (this.decor) for (const name of this.names) for (const d of (this.decor[name] && this.decor[name].drawings) || []) if (d.url) URL.revokeObjectURL(d.url);
    super.destroy();
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

Object.assign(VIEWER_CLASSES, { xlsx: XlsxViewer });
