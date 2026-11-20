'use strict';
/* Lectern — OpenDocument text and presentations (odt, odp). Loaded on demand (see VIEWER_LIB in core.js); shares the global scope with the app scripts and fmt-common.js. */

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
    const obj = [...node.children].find((x) => x.nodeName === 'draw:object');
    if (obj && obj.getAttribute('xlink:href')) {
      const cw = this.len(node.getAttribute('svg:width')) || 480, ch = this.len(node.getAttribute('svg:height')) || 300, d = h('div', 'odf-chart');
      d.style.cssText = 'width:' + cw.toFixed(0) + 'px;height:' + ch.toFixed(0) + 'px;max-width:100%';
      this.pending.push(odfChartInto(this.odf.zip, obj.getAttribute('xlink:href'), d, cw, ch));
      parent.appendChild(d);
      return;
    }
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
    const obj = [...node.children].find((c) => c.nodeName === 'draw:object');
    if (obj && obj.getAttribute('xlink:href')) {
      text.pending.push(odfChartInto(text.odf.zip, obj.getAttribute('xlink:href'), el, this.cmPx * toCm(node.getAttribute('svg:width'), 0), this.cmPx * toCm(node.getAttribute('svg:height'), 0)));
    } else if (img && img.getAttribute('xlink:href')) {
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

Object.assign(VIEWER_CLASSES, { odp: OdpViewer, odt: OdtViewer });
