'use strict';
/* Lectern — EPUB books. Loaded on demand (see VIEWER_LIB in core.js); shares the global scope with the app scripts and fmt-common.js. */

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
    this.put(this.host);
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

    // Copy first: the pictures are filled in later, and must be filled in on the copy that is shown
    const imported = document.importNode(body, true);
    for (const el of imported.querySelectorAll('*')) {
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


// Hand the viewers over to the app scripts

Object.assign(VIEWER_CLASSES, { epub: EpubViewer });
