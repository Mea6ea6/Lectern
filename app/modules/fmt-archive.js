'use strict';
/* Lectern — zip listing and json. Loaded on demand (see VIEWER_LIB in core.js); shares the global scope with the app scripts and fmt-common.js. */

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
    this.put(this.host);
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

Object.assign(VIEWER_CLASSES, { zip: ZipViewer, json: JsonViewer });
