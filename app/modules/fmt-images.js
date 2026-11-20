'use strict';
/* Lectern — HEIC and TIFF pictures. Loaded on demand (see VIEWER_LIB in core.js); shares the global scope with the app scripts and fmt-common.js. */

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

Object.assign(VIEWER_CLASSES, { heic: HeicViewer, tiff: TiffViewer });
