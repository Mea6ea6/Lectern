'use strict';
/* Lectern — Thumbnails of the cards, made one at a time.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, queue.js, thumbs.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, link.js, presenter.js, companion.js, start.js. They are plain scripts that share one global scope
   They are plain scripts that share one global scope (no modules, so it also works from a file:// address on a flash drive). */

/* ---------------------------------------------------------------------
   6. THUMBNAILS
   Made one at a time, only for cards that are on screen,
   and paused while the viewer is open.
   --------------------------------------------------------------------- */

const thumbQueue = [];
let thumbBusy = false;

const thumbObserver = new IntersectionObserver((items) => {
  for (const item of items) {
    if (!item.isIntersecting) continue;
    thumbObserver.unobserve(item.target);
    const entry = state.files.find((e) => e.id === Number(item.target.dataset.id));
    if (entry && !entry.thumbRequested) { entry.thumbRequested = true; thumbQueue.push(entry); }
  }
  runThumbQueue();
}, { rootMargin: '300px' });

async function runThumbQueue() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length && V.el.hidden) {
    const entry = thumbQueue.shift();
    try {
      if (VIEWER_LIB[entry.viewer]) await lib(VIEWER_LIB[entry.viewer]);
      const own = VIEWER_LIB[entry.viewer] && VIEWER_CLASSES[entry.viewer];
      if (own && typeof own.thumb === 'function') {   // the newer formats make their own thumbnails
        await own.thumb(entry);
      } else switch (entry.kind) {
        case 'pdf':   await thumbPdf(entry); break;
        case 'xlsx':  await thumbXlsx(entry); break;
        case 'image': thumbImage(entry); break;
        case 'text':  await thumbText(entry); break;
        case 'code':  await thumbText(entry); break;
        default:      await thumbOffice(entry);
      }
    } catch (err) {
      console.warn('Could not make a thumbnail:', entry.name, err);
    }
    putThumb(entry);
  }
  thumbBusy = false;
}

function putThumb(entry) {
  if (!entry.card || !entry.thumbNode) return;
  const thumb = entry.card.querySelector('.thumb');
  if (!thumb) return;
  thumb.replaceChildren(entry.thumbNode, ...thumb.querySelectorAll('.tag, .card-queue'));   // picture + the buttons on top
  fitPageThumbs(thumb);
}

// Shared by every PDF preview (list thumbnail, overview, presenter panel):
// draw one pdf.js page into a new canvas that is `width` pixels wide.
async function pdfCanvas(page, width) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#fff' }).promise;
  return canvas;
}

// Shared by every PPTX preview (overview, presenter panel): copy the slide that the hidden
// previewer `host` has just drawn into a box of the full slide size W x H, scaled down to
// `shownWidth` px. (A scaled copy is far cheaper than re-rendering the slide.)
function slideCopy(host, W, H, shownWidth) {
  const src = host.querySelector('.pptx-preview-slide-wrapper');
  if (!src) return null;
  const clone = src.cloneNode(true);
  clone.style.cssText += ';position:absolute;left:0;top:0;margin:0';
  const box = h('div', 'clone-host');
  box.style.width = W + 'px';
  box.style.height = H + 'px';
  box.dataset.w = W;                       // the panel's resize observer rescales from this
  box.style.transform = 'scale(' + (shownWidth / W) + ')';
  box.appendChild(clone);
  return box;
}

// PDF: draw page 1 into a small canvas
async function thumbPdf(entry) {
  await lib('pdf');
  const data = new Uint8Array(await entry.file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data }).promise;
  entry.pages = doc.numPages;
  entry.thumbNode = await pdfCanvas(await doc.getPage(1), 420);
  doc.destroy();
}

// PPTX / DOCX are zip archives: count slides, use the saved preview picture or show the first text
async function thumbOffice(entry) {
  await lib('zip');
  const zip = await JSZip.loadAsync(entry.file);
  if (entry.kind === 'pptx') {
    entry.pages = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  }
  // (DOCX page count isn't stored reliably in the file — Word computes it — so we don't show one)

  const pic = zip.file(/^docProps\/thumbnail\.(jpe?g|png)$/i)[0];
  if (pic) {
    const type = /png$/i.test(pic.name) ? 'image/png' : 'image/jpeg';
    entry.thumbUrl = URL.createObjectURL(new Blob([await pic.async('uint8array')], { type }));
    const img = new Image();
    img.src = entry.thumbUrl;
    entry.thumbNode = img;
    return;
  }

  if (entry.kind === 'docx' && entry.size < 6 * 1024 * 1024) {          // no stored picture: draw the real first page
    try { if (await thumbDocxPage(entry)) return; } catch (err) { console.warn('DOCX thumbnail:', err); }
  }

  const xmlFile = zip.file(entry.kind === 'pptx' ? 'ppt/slides/slide1.xml' : 'word/document.xml');
  if (!xmlFile) return;
  const xml = await xmlFile.async('string');
  const tag = entry.kind === 'pptx' ? 'a:t' : 'w:t';
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([^<]*)</' + tag + '>', 'g');
  const pieces = [];
  let m;
  while ((m = re.exec(xml)) && pieces.join(' ').length < 400) pieces.push(decodeXml(m[1]));
  if (!pieces.length) return;
  const snippet = h('div', 'snippet');
  snippet.appendChild(h('b', '', pieces[0]));
  snippet.appendChild(document.createTextNode(pieces.slice(1).join(' ')));
  entry.thumbNode = snippet;
}

// DOCX without a stored picture: render the document out of sight and keep a scaled copy of its first page
async function thumbDocxPage(entry) {
  await lib('docx');
  const host = h('div', 'docx-host');
  Object.assign(host.style, { position: 'fixed', left: '-20000px', top: '0', width: '1000px' });
  document.body.appendChild(host);
  try {
    await docx.renderAsync(await entry.file.arrayBuffer(), host, null,
      { className: 'docx', inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false });
    const page = host.querySelector('section.docx');
    if (!page || !page.offsetWidth || !page.offsetHeight) return false;
    placeAnchors(page);
    const W = page.offsetWidth, H = parseFloat(getComputedStyle(page).minHeight) || page.offsetHeight;
    const copy = host.cloneNode(true);                                   // keeps docx-preview's own <style> with it
    copy.style.cssText = 'width:' + W + 'px;height:' + H + 'px';
    copy.querySelectorAll('section.docx').forEach((sec, i) => { if (i) sec.remove(); });
    const box = h('div', 'page-thumb');
    box.dataset.w = W; box.dataset.h = H;
    box.style.aspectRatio = W + ' / ' + H;
    box.appendChild(copy);
    entry.thumbNode = box;
    return true;
  } finally { host.remove(); }
}
// A page-thumb is drawn at the page's natural size and scaled to fit its box (cards and the info window)
function fitPageThumbs(root) {
  (root || document).querySelectorAll('.page-thumb').forEach((box) => {
    const w = Number(box.dataset.w), width = box.clientWidth;
    if (w && width) box.style.setProperty('--s', (width / w).toFixed(4));
  });
}
if ('ResizeObserver' in window) new ResizeObserver(() => fitPageThumbs()).observe($('grid'));

// XLSX / CSV: a tiny table of the first rows (only the first rows are parsed — fast)
async function thumbXlsx(entry) {
  await lib('xlsx');
  const wb = XLSX.read(await entry.file.arrayBuffer(), { type: 'array', sheetRows: 8 });
  entry.pages = wb.SheetNames.length;
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }).slice(0, 7);
  const table = h('table', 'mini-table');
  for (const row of rows) {
    const tr = h('tr');
    for (const cell of row.slice(0, 5)) tr.appendChild(h('td', '', String(cell)));
    table.appendChild(tr);
  }
  const box = h('div', 'snippet snippet-table');
  box.appendChild(table);
  entry.thumbNode = box;
}

// Images: the picture itself
function thumbImage(entry) {
  entry.thumbUrl = URL.createObjectURL(entry.file);
  const img = new Image();
  img.src = entry.thumbUrl;
  entry.thumbNode = img;
}

// Text: the first lines
async function thumbText(entry) {
  const head = await entry.file.slice(0, 2000).arrayBuffer();
  const text = decodeText(head, entry.size > 2000).trim();
  if (!text) return;
  const lines = text.split(/\r?\n/);
  const snippet = h('div', 'snippet');
  snippet.appendChild(h('b', '', lines[0].slice(0, 80)));
  snippet.appendChild(document.createTextNode(lines.slice(1).join(' ').slice(0, 360)));
  entry.thumbNode = snippet;
}


