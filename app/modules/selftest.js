'use strict';
/* Lectern — self-check page. Open  Lectern.html#selftest  : it opens a small sample file of every format with the real viewers and
   reports what works in THIS browser (a classroom board, a phone, another browser). Nothing is uploaded; the samples are built in
   (modules/selftest-data.js, made by tests/build-selftest-data.py). The same page is run by `node tests/run.js`. */

const SELFTEST = (() => {
  // [file, what it is, what the viewer must show] — "error" means: it must fail politely, with this word in the message
  const FILES = [
    ['page.pdf', 'PDF', { sel: 'canvas' }],
    ['shapes-smartart.pptx', 'PowerPoint: shapes, SmartArt', {}],
    ['charts-stock-surface.pptx', 'PowerPoint: stock and surface charts', {}],
    ['slides.odp', 'OpenDocument presentation', {}],
    ['slides.ppt', 'Old PowerPoint (.ppt)', { has: 'Lectern' }],
    ['charts-shapes.docx', 'Word: charts, shapes', {}],
    ['table.doc', 'Old Word (.doc) with a table', { has: 'R0C0', sel: 'table' }],
    ['rtf-named-doc.doc', 'RTF saved as .doc', { has: 'Hello' }],
    ['text.rtf', 'RTF', {}],
    ['text.odt', 'OpenDocument text', {}],
    ['styles-charts.xlsx', 'Excel: styles, charts', { sel: 'table' }],
    ['icons-formulas.xlsx', 'Excel: formulas, number formats, icons', { has: '%', sel: '.cf-icon' }],
    ['conditional.xlsx', 'Excel: conditional formatting', { sel: 'table' }],
    ['sheet.xls', 'Old Excel (.xls)', { sel: 'table' }],
    ['sheet.ods', 'OpenDocument spreadsheet', { sel: 'table' }],
    ['book.epub', 'EPUB book', {}],
    ['picture.png', 'Picture', { sel: 'img,canvas' }],
    ['notes.txt', 'Plain text', { has: 'Lectern' }],
    ['table.csv', 'CSV table', { has: 'Anna' }],
    ['data.json', 'JSON', { has: 'items' }],
    ['archive.zip', 'Zip archive', { has: 'readme' }],
    ['tone.wav', 'Audio', { media: true }],
    ['broken.docx', 'Damaged file (must be refused politely)', { error: 'damaged' }],
    ['empty.pptx', 'Empty file (must be refused politely)', { error: 'empty' }],
  ];

  const MIME = { pdf: 'application/pdf', png: 'image/png', wav: 'audio/wav', txt: 'text/plain', csv: 'text/csv', json: 'application/json' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what + ' took longer than ' + ms / 1000 + ' s')), ms))]);

  // What this browser can do (a "no" here explains most problems on an old board)
  async function environment() {
    const t = [];
    const check = (name, fn, info) => { let ok = false, note = ''; try { const r = fn(); ok = !!(r && r !== 'no'); if (typeof r === 'string') note = r; } catch (e) { ok = false; } t.push({ name, ok, info: !!info, note }); };
    check('Files open from a Blob', () => !!(window.Blob && URL.createObjectURL));
    check('Canvas drawing', () => !!document.createElement('canvas').getContext('2d'));
    check('Remembering settings', () => { localStorage.setItem('fv-selftest', '1'); localStorage.removeItem('fv-selftest'); return true; });
    check('Offline copy (service worker)', () => 'serviceWorker' in navigator, true);
    check('Full screen', () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen), true);
    check('Touch / pen input', () => !!window.PointerEvent);
    check('Modern JavaScript', () => typeof [].at === 'function' && typeof document.body.replaceChildren === 'function' && typeof structuredClone === 'function');
    const v = document.createElement('video'), a = document.createElement('audio');
    const can = (el, type) => el.canPlayType(type) || '';
    check('Video: MP4 (H.264)', () => can(v, 'video/mp4; codecs="avc1.42E01E"') && 'yes', true);
    check('Video: WebM (VP9)', () => can(v, 'video/webm; codecs="vp9"') && 'yes', true);
    check('Audio: MP3', () => can(a, 'audio/mpeg') && 'yes', true);
    check('Audio: AAC / M4A', () => can(a, 'audio/mp4; codecs="mp4a.40.2"') && 'yes', true);
    await new Promise((done) => {                       // an SVG picture must be drawable on a canvas (charts in Word and PowerPoint rely on it)
      const img = new Image();
      img.onload = () => { let ok = false; try { const c = document.createElement('canvas'); c.width = c.height = 8; c.getContext('2d').drawImage(img, 0, 0); c.toDataURL(); ok = true; } catch (e) { /* tainted */ } t.push({ name: 'Charts: SVG to picture', ok }); done(); };
      img.onerror = () => { t.push({ name: 'Charts: SVG to picture', ok: false }); done(); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>');
    });
    return t;
  }

  async function openOne(zip, [name, label, want]) {
    const t0 = performance.now(), res = { name, label, ok: false, note: '' };
    try {
      const f = zip.file(name), blob = await f.async('blob');
      const ext = name.split('.').pop().toLowerCase();
      const file = new File([blob], name, { type: MIME[ext] || '', lastModified: 1 });
      const entry = makeEntry(file, ext);
      await withTimeout(openViewer(entry), 25000, 'Opening');
      await sleep(250);
      const failed = !$('vMsg').hidden, msg = failed ? $('vMsg').innerText.replace(/\s+/g, ' ') : '';
      if (want.error) {
        res.ok = failed && msg.toLowerCase().includes(want.error);
        res.note = res.ok ? 'refused politely' : failed ? 'unexpected message: ' + msg.slice(0, 90) : 'it opened, but should have been refused';
      } else if (failed) {
        res.note = msg.slice(0, 120);
      } else {
        const text = V.content.textContent || '';
        const shown = V.driver && V.driver.isMedia ? true : !!V.content.querySelector('canvas,img,svg,table,p,pre,div') && V.content.getBoundingClientRect().height > 20;
        if (!shown) res.note = 'nothing was drawn';
        else if (want.has && !text.includes(want.has)) res.note = 'the text "' + want.has + '" is missing';
        else if (want.sel && !V.content.querySelector(want.sel)) res.note = 'expected element is missing (' + want.sel + ')';
        else res.ok = true;
      }
    } catch (e) { res.note = String(e.message || e).slice(0, 120); }
    try { closeViewer(); } catch (e) { /* ignore */ }
    res.ms = Math.round(performance.now() - t0);
    return res;
  }

  function panel() {
    const el = h('div', 'selftest');
    const z = parseInt(getComputedStyle($('viewer')).zIndex, 10);
    el.style.zIndex = isNaN(z) ? 5 : Math.max(1, z - 1);
    el.innerHTML = '<div class="st-card"><div class="st-head"><b>Self-check</b><span class="st-sum">Running…</span></div><div class="st-list"></div><div class="st-foot"><button class="btn-link" type="button" data-a="copy">Copy report</button><button class="btn-link" type="button" data-a="close">Close</button></div></div>';
    document.body.appendChild(el);
    return el;
  }

  async function run() {
    const out = window.__selftest = { done: false, results: [], env: [], failed: 0 };
    const el = panel(), list = el.querySelector('.st-list'), sum = el.querySelector('.st-sum');
    const row = (r, info) => {
      const d = h('div', 'st-row ' + (r.ok ? 'ok' : info ? 'info' : 'bad'));
      d.append(h('span', 'st-mark', r.ok ? '✓' : info ? '–' : '✕'), h('span', 'st-name', r.label || r.name), h('span', 'st-note', (r.note || '') + (r.ms ? (r.note ? ' · ' : '') + r.ms + ' ms' : '')));
      list.appendChild(d); d.scrollIntoView({ block: 'nearest' });
    };
    list.appendChild(h('div', 'st-group', 'This browser'));
    out.env = await environment();
    out.env.forEach((r) => row(r, r.info && !r.ok));
    list.appendChild(h('div', 'st-group', 'Formats'));
    const zip = await JSZip.loadAsync(SELFTEST_ZIP, { base64: true });
    for (const spec of FILES) { const r = await openOne(zip, spec); out.results.push(r); row(r); }
    const bad = out.results.filter((r) => !r.ok).length + out.env.filter((r) => !r.ok && !r.info).length;
    await sleep(600);                                  // let the viewer finish fading out
    out.failed = bad; out.done = true;
    sum.textContent = bad ? bad + ' of ' + (out.results.length + out.env.filter((r) => !r.info).length) + ' checks failed' : 'All checks passed';
    el.classList.add(bad ? 'failed' : 'passed');
    const report = () => 'Lectern self-check — ' + sum.textContent + '\n' + navigator.userAgent + '\n\n' +
      out.env.map((r) => (r.ok ? 'OK   ' : r.info ? 'no   ' : 'FAIL ') + r.name).join('\n') + '\n\n' +
      out.results.map((r) => (r.ok ? 'OK   ' : 'FAIL ') + r.label + (r.note ? ' — ' + r.note : '')).join('\n');
    el.addEventListener('click', async (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === 'close') { el.remove(); history.replaceState(null, '', location.pathname + location.search); }
      if (a === 'copy') { try { await navigator.clipboard.writeText(report()); showToast('Report copied', 1800); } catch (err) { prompt('Copy this report:', report()); } }
    });
    return out;
  }
  return { run };
})();
