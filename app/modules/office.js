/* ---------------------------------------------------------------------
   Office extras (loaded the first time a Word or Excel file is opened)

   The Word and Excel readers we use skip charts, shapes, SmartArt and (in Excel) cell colours and
   pictures. This file adds them from the original XML:
     - chartSvg()       draws a chart (bar, line, area, pie, doughnut, scatter, bubble, radar, stock, surface) as an SVG picture
     - shapesSvg()      draws simple shapes with text (Word text boxes, shapes, SmartArt) as an SVG picture
     - docxPrepare()    turns those drawings in a .docx into ordinary pictures BEFORE the Word reader sees them
     - xlsxDecor()      reads cell colours, column widths, pictures and charts of a .xlsx
   Everything is wrapped so that a failure can never stop the file from opening.
   --------------------------------------------------------------------- */

const OFC = (() => {
  const EMU = 9525;                                           // EMU per pixel at 96 dpi
  const PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9E480E'];
  const NS = {
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
    wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const parse = (txt) => new DOMParser().parseFromString(txt, 'application/xml');
  const all = (el, name) => (el ? Array.from(el.getElementsByTagNameNS('*', name)) : []);
  const first = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
  const kids = (el, name) => (el ? Array.from(el.children).filter((k) => k.localName === name) : []);
  const kid = (el, name) => kids(el, name)[0] || null;
  const attr = (el, name, def) => { if (!el) return def; const v = el.getAttribute(name); return v != null ? v : (el.getAttribute('w:' + name) != null ? el.getAttribute('w:' + name) : def); };
  const num = (v, def) => { const n = parseFloat(v); return isNaN(n) ? def : n; };

  /* ----- colours ----- */
  function themeColors(xml) {
    const out = {};
    if (!xml) return out;
    const sch = first(parse(xml), 'clrScheme');
    for (const n of sch ? Array.from(sch.children) : []) {
      const c = n.firstElementChild;
      if (!c) continue;
      out[n.localName] = '#' + (c.getAttribute('val') && c.localName === 'srgbClr' ? c.getAttribute('val') : c.getAttribute('lastClr') || '000000');
    }
    out.tx1 = out.dk1; out.bg1 = out.lt1; out.tx2 = out.dk2; out.bg2 = out.lt2;
    return out;
  }
  function hexToHsl(hex) {
    const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let hh = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hh /= 6;
    }
    return [hh, s, l];
  }
  function hslToHex(hh, s, l) {
    const f = (p, q, t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    let r, g, b;
    if (s === 0) r = g = b = l;
    else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, hh + 1 / 3); g = f(p, q, hh); b = f(p, q, hh - 1 / 3); }
    return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
  }
  // `fill` is a colour holder (a:solidFill or similar); returns "#rrggbb" or null
  function colorOf(fill, theme) {
    const c = fill && Array.from(fill.children).find((k) => /^(srgbClr|schemeClr|sysClr|prstClr)$/.test(k.localName));
    if (!c) return null;
    let hex = null;
    if (c.localName === 'srgbClr') hex = '#' + c.getAttribute('val');
    else if (c.localName === 'sysClr') hex = '#' + (c.getAttribute('lastClr') || '000000');
    else if (c.localName === 'prstClr') hex = ({ black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080' })[c.getAttribute('val')] || '#000000';
    else hex = (theme && theme[c.getAttribute('val')]) || ({ tx1: '#000000', bg1: '#ffffff', phClr: '#4472C4' })[c.getAttribute('val')] || '#4472C4';
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
    let [hh, s, l] = hexToHsl(hex), changed = false;
    for (const m of Array.from(c.children)) {
      const v = num(m.getAttribute('val'), 100000) / 100000;
      if (m.localName === 'lumMod') { l *= v; changed = true; }
      else if (m.localName === 'lumOff') { l += v; changed = true; }
      else if (m.localName === 'tint') { l = l + (1 - l) * (1 - v); changed = true; }
      else if (m.localName === 'shade') { l *= v; changed = true; }
    }
    return changed ? hslToHex(hh, s, Math.min(1, Math.max(0, l))) : hex.toLowerCase();
  }
  const fillOf = (spPr, theme) => {                           // "#hex", "none" or null (= not stated)
    if (!spPr) return null;
    if (kid(spPr, 'noFill')) return 'none';
    const s = kid(spPr, 'solidFill');
    if (s) return colorOf(s, theme);
    const g = kid(spPr, 'gradFill');
    if (g) { const gs = first(g, 'gs'); return gs ? colorOf(gs, theme) : null; }
    return null;
  };

  /* ----- text measuring for wrapped labels ----- */
  let measureCtx = null;
  function textWidth(text, size, bold) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = (bold ? 'bold ' : '') + size + 'px Arial, Helvetica, sans-serif';
    return measureCtx.measureText(text).width;
  }
  function wrapText(text, size, maxW, bold) {
    const lines = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? line + ' ' + word : word;
        if (line && textWidth(t, size, bold) > maxW) { lines.push(line); line = word; } else line = t;
      }
      lines.push(line);
    }
    return lines;
  }

  /* =====================================================================
     CHARTS
     ===================================================================== */
  function niceScale(lo, hi, wantZero) {
    if (wantZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (lo === hi) { hi = lo + 1; }
    const raw = (hi - lo) / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
    const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step, ticks = [];
    for (let v = a; v <= b + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { min: a, max: b, ticks };
  }
  const fmtNum = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US').replace(/,/g, ' ') : String(+(+v).toFixed(2)));

  // Reads a c:cat / c:val / c:xVal / c:yVal / c:tx node into an array. `resolve` (optional) finds values for a formula without a cache
  function readSeries(node, resolve) {
    if (!node) return [];
    const cache = first(node, 'strCache') || first(node, 'numCache') || first(node, 'strLit') || first(node, 'numLit') || first(node, 'multiLvlStrCache');
    if (cache) {
      const count = num(attr(first(cache, 'ptCount'), 'val'), 0), out = new Array(count).fill(null);
      for (const p of all(cache, 'pt')) { const i = num(p.getAttribute('idx'), 0), v = first(p, 'v'); if (v) out[i] = v.textContent; if (i >= out.length) out.length = i + 1; }
      return out;
    }
    const f = first(node, 'f');
    return f && resolve ? resolve(f.textContent) : [];
  }

  function chartSvg(xml, theme, W, H, resolve) {
    const doc = parse(xml), chart = first(doc, 'chart'), plot = first(chart, 'plotArea');
    if (!plot) return null;
    const types = ['barChart', 'bar3DChart', 'lineChart', 'line3DChart', 'areaChart', 'area3DChart', 'pieChart', 'pie3DChart', 'doughnutChart', 'scatterChart', 'bubbleChart', 'radarChart', 'ofPieChart', 'stockChart', 'surfaceChart', 'surface3DChart'];
    const groups = Array.from(plot.children).filter((k) => types.includes(k.localName));
    if (!groups.length) return placeholder(chart, W, H);
    const titleNode = kid(chart, 'title'), autoDel = attr(kid(chart, 'autoTitleDeleted'), 'val', '0') === '1';
    const titleText = titleNode ? all(titleNode, 't').map((t) => t.textContent).join('') : '';
    const legendNode = kid(chart, 'legend');
    const fs = Math.max(10, Math.min(15, Math.round(H / 26)));
    const font = 'font-family="Arial, Helvetica, sans-serif"';
    const parts = [];
    const topPad = (titleText && !autoDel ? fs * 2.4 : fs * 0.8), legendH = legendNode ? fs * 2.2 : 0;

    // ---- collect series
    const sers = [];
    groups.forEach((g, gi) => {
      const kind = g.localName.replace('3D', '').replace('Chart', '');   // 'bar', 'line', … 'stock', 'surface'
      const grouping = attr(kid(g, 'grouping'), 'val', 'clustered');
      const dir = attr(kid(g, 'barDir'), 'val', 'col');
      const gap = num(attr(kid(g, 'gapWidth'), 'val'), 150);
      const labelsOn = attr(first(g, 'showVal'), 'val', '0') === '1' || attr(first(g, 'showVal'), 'val', '0') === 'true';
      const pctOn = attr(first(g, 'showPercent'), 'val', '0') === '1';
      kids(g, 'ser').forEach((s) => {
        const idx = sers.length, sp = kid(s, 'spPr');
        const name = readSeries(kid(s, 'tx'), resolve)[0] || ('Series ' + (idx + 1));
        const isXY = kind === 'scatter' || kind === 'bubble';
        const cat = readSeries(kid(s, isXY ? 'xVal' : 'cat'), resolve);
        const val = readSeries(kid(s, isXY ? 'yVal' : 'val'), resolve).map((v) => (v == null || v === '' ? null : num(v, null)));
        let color = fillOf(sp, theme);
        if (kind === 'line' || kind === 'scatter' || kind === 'radar') { const ln = kid(sp, 'ln'); color = (ln && fillOf(ln, theme)) || color; }
        if (!color || color === 'none') color = PALETTE[idx % PALETTE.length];
        const dpt = {};
        kids(s, 'dPt').forEach((p) => { const c = fillOf(kid(p, 'spPr'), theme); if (c && c !== 'none') dpt[num(attr(kid(p, 'idx'), 'val'), 0)] = c; });
        const lnNode = kid(sp, 'ln'), noLine = lnNode && kid(lnNode, 'noFill');
        sers.push({ kind, grouping, dir, gap, name, cat, val, color, dpt, labels: labelsOn, pct: pctOn, group: gi, noLine, hole: num(attr(kid(g, 'holeSize'), 'val'), 55), style: attr(kid(g, 'scatterStyle'), 'val', '') || attr(kid(g, 'radarStyle'), 'val', ''), xs: isXY ? cat.map((c) => num(c, null)) : null, sizes: kind === 'bubble' ? readSeries(kid(s, 'bubbleSize'), resolve).map((v) => num(v, 1)) : null });
      });
    });
    if (!sers.length) return placeholder(chart, W, H);
    const kind0 = sers[0].kind;

    const legendItems = [];
    // ---------------- pie / doughnut
    if (kind0 === 'pie' || kind0 === 'doughnut' || kind0 === 'ofPie') {
      const s = sers[0], vals = s.val.map((v) => Math.max(0, v || 0)), tot = vals.reduce((a, b) => a + b, 0) || 1;
      const cats = s.cat.length ? s.cat : vals.map((_, i) => String(i + 1));
      const cx = W / 2, cy = topPad + (H - topPad - legendH) / 2, R = Math.max(10, Math.min(W * 0.4, (H - topPad - legendH) / 2 - 6)), r0 = kind0 === 'doughnut' ? R * s.hole / 100 : 0;
      let a0 = -Math.PI / 2;
      vals.forEach((v, i) => {
        const a1 = a0 + (v / tot) * Math.PI * 2, col = s.dpt[i] || PALETTE[i % PALETTE.length];
        legendItems.push([cats[i], col]);
        if (v > 0) {
          const big = a1 - a0 > Math.PI ? 1 : 0, P = (a, r) => (cx + Math.cos(a) * r).toFixed(2) + ',' + (cy + Math.sin(a) * r).toFixed(2);
          const full = a1 - a0 > Math.PI * 2 - 0.001, e = full ? a1 - 0.001 : a1;
          const d = r0
            ? 'M' + P(a0, R) + 'A' + R + ',' + R + ' 0 ' + big + ' 1 ' + P(e, R) + 'L' + P(e, r0) + 'A' + r0 + ',' + r0 + ' 0 ' + big + ' 0 ' + P(a0, r0) + 'Z'
            : 'M' + cx + ',' + cy + 'L' + P(a0, R) + 'A' + R + ',' + R + ' 0 ' + big + ' 1 ' + P(e, R) + 'Z';
          parts.push('<path d="' + d + '" fill="' + col + '" stroke="#fff" stroke-width="1.5"/>');
          if (s.labels || s.pct) {
            const m = (a0 + a1) / 2, rr = r0 ? (R + r0) / 2 : R * 0.65, txt = s.pct ? Math.round(v / tot * 100) + '%' : fmtNum(v);
            parts.push('<text x="' + (cx + Math.cos(m) * rr).toFixed(1) + '" y="' + (cy + Math.sin(m) * rr + fs * 0.35).toFixed(1) + '" text-anchor="middle" font-size="' + fs + '" fill="#fff" ' + font + '>' + txt + '</text>');
          }
        }
        a0 = a1;
      });
    } else if (kind0 === 'surface') {
      // a surface chart seen from above: a grid of coloured bands (series = rows, categories = columns)
      const rows = sers, nC = Math.max(...rows.map((s) => Math.max(s.val.length, s.cat.length)), 1);
      const cats = Array.from({ length: nC }, (_, i) => (rows[0].cat[i] != null ? rows[0].cat[i] : String(i + 1)));
      let lo = Infinity, hi = -Infinity; rows.forEach((s) => s.val.forEach((v) => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      const sc = niceScale(lo, hi, false), bands = Math.max(2, Math.min(sc.ticks.length - 1, 8)), step = (sc.max - sc.min) / bands;
      const ramp = ['#3b5b92', '#4f8fc0', '#7fc4c0', '#b7dc8f', '#f2e66b', '#f5b95a', '#ee8456', '#d6504a'];
      const colorOf = (v) => ramp[Math.min(ramp.length - 1, Math.round(Math.min(bands - 1, Math.max(0, Math.floor((v - sc.min) / (step || 1)))) * (ramp.length - 1) / Math.max(1, bands - 1)))];
      const L = Math.max(...rows.map((s) => String(s.name).length), 3) * fs * 0.55 + 12, T = topPad, B = legendH + fs * 2.2, pw = W - L - 16, ph = H - T - B;
      if (pw < 20 || ph < 20) return placeholder(chart, W, H);
      const cw = pw / nC, rh = ph / rows.length;
      rows.forEach((s, ri) => {
        parts.push('<text x="' + (L - 6) + '" y="' + (T + (ri + 0.5) * rh + fs * 0.35) + '" text-anchor="end" font-size="' + fs + '" fill="#666" ' + font + '>' + esc(s.name) + '</text>');
        for (let i = 0; i < nC; i++) { const v = s.val[i]; if (v != null) parts.push('<rect x="' + (L + i * cw) + '" y="' + (T + ri * rh) + '" width="' + (cw + 0.6) + '" height="' + (rh + 0.6) + '" fill="' + colorOf(v) + '"/>'); }
      });
      const every = Math.max(1, Math.ceil(nC * (fs * 0.6 * Math.max(...cats.map((c) => String(c).length), 1) + 10) / pw));
      cats.forEach((c, i) => { if (i % every === 0) parts.push('<text x="' + (L + (i + 0.5) * cw) + '" y="' + (T + ph + fs * 1.3) + '" text-anchor="middle" font-size="' + fs + '" fill="#666" ' + font + '>' + esc(c) + '</text>'); });
      for (let b = 0; b < bands; b++) legendItems.push([fmtNum(sc.min + b * step) + '–' + fmtNum(sc.min + (b + 1) * step), ramp[Math.round(b * (ramp.length - 1) / Math.max(1, bands - 1))]]);
    } else if (kind0 === 'radar') {
      const n = Math.max(...sers.map((s) => Math.max(s.val.length, s.cat.length)), 3), cats = Array.from({ length: n }, (_, i) => (sers[0].cat[i] != null ? sers[0].cat[i] : String(i + 1)));
      let hi = 0; sers.forEach((s) => s.val.forEach((v) => { if (v != null && v > hi) hi = v; }));
      const sc = niceScale(0, hi || 1, true), cx = W / 2, cy = topPad + (H - topPad - legendH) / 2, R = Math.max(20, Math.min(W * 0.34, (H - topPad - legendH) / 2 - fs * 2));
      const ang = (i) => -Math.PI / 2 + i * Math.PI * 2 / n, pt = (i, v) => [cx + Math.cos(ang(i)) * R * v / sc.max, cy + Math.sin(ang(i)) * R * v / sc.max];
      sc.ticks.forEach((t) => { if (t > 0) parts.push('<path d="M' + cats.map((_, i) => pt(i, t).join(',')).join('L') + 'Z" fill="none" stroke="#e3e3e3"/>'); });
      cats.forEach((c, i) => {
        const e = pt(i, sc.max), l = pt(i, sc.max * 1.12);
        parts.push('<line x1="' + cx + '" y1="' + cy + '" x2="' + e[0] + '" y2="' + e[1] + '" stroke="#e3e3e3"/><text x="' + l[0] + '" y="' + (l[1] + fs * 0.35) + '" text-anchor="' + (Math.abs(l[0] - cx) < 6 ? 'middle' : l[0] > cx ? 'start' : 'end') + '" font-size="' + fs + '" fill="#555" ' + font + '>' + esc(c) + '</text>');
      });
      sers.forEach((s) => {
        legendItems.push([s.name, s.color]);
        const P = Array.from({ length: n }, (_, i) => pt(i, s.val[i] || 0));
        parts.push('<path d="M' + P.map((p) => p.join(',')).join('L') + 'Z" fill="' + (s.style === 'filled' ? s.color : 'none') + '" fill-opacity=".3" stroke="' + s.color + '" stroke-width="2.5" stroke-linejoin="round"/>');
        P.forEach((p) => parts.push('<circle cx="' + p[0] + '" cy="' + p[1] + '" r="3.5" fill="' + s.color + '"/>'));
      });
    } else {
      // ---------------- cartesian: bar / line / area / scatter
      const isXY = kind0 === 'scatter' || kind0 === 'bubble', horiz = sers.some((s) => s.kind === 'bar' && s.dir === 'bar');
      const nCat = isXY ? 0 : Math.max(...sers.map((s) => Math.max(s.val.length, s.cat.length)), 1);
      const cats = isXY ? [] : Array.from({ length: nCat }, (_, i) => (sers[0].cat[i] != null ? sers[0].cat[i] : String(i + 1)));
      // value range
      const stackedAny = sers.some((s) => (s.grouping === 'stacked' || s.grouping === 'percentStacked') && s.kind !== 'line' && s.kind !== 'scatter');
      let lo = Infinity, hi = -Infinity;
      if (isXY) { sers.forEach((s) => s.val.forEach((v) => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } })); }
      else if (stackedAny) {
        const pct = sers.some((s) => s.grouping === 'percentStacked');
        for (let i = 0; i < nCat; i++) { let pos = 0, neg = 0; sers.forEach((s) => { const v = s.val[i] || 0; if (v >= 0) pos += v; else neg += v; }); lo = Math.min(lo, neg); hi = Math.max(hi, pct ? 1 : pos); }
        if (pct) { lo = 0; hi = 1; }
      } else sers.forEach((s) => s.val.forEach((v) => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      const valAx = all(plot, 'valAx')[isXY ? 1 : 0] || all(plot, 'valAx')[0];
      const sc = valAx && first(valAx, 'scaling'), amin = sc && num(attr(first(sc, 'min'), 'val'), null), amax = sc && num(attr(first(sc, 'max'), 'val'), null);
      const scale = niceScale(amin != null ? amin : lo, amax != null ? amax : hi, !isXY || amin === 0);
      if (amin != null) scale.min = amin;
      if (amax != null) scale.max = amax;
      const pctMode = sers.some((s) => s.grouping === 'percentStacked');
      const tickLabel = (v) => (pctMode ? Math.round(v * 100) + '%' : fmtNum(v));
      let xScale = null;
      if (isXY) {
        let xl = Infinity, xh = -Infinity;
        sers.forEach((s) => s.xs.forEach((v, i) => { const x = v == null ? i + 1 : v; xl = Math.min(xl, x); xh = Math.max(xh, x); }));
        xScale = niceScale(xl, xh, false);
      }
      const wid = Math.max(...scale.ticks.map((t) => tickLabel(t).length), 2) * fs * 0.6;
      const L = (horiz ? Math.max(...cats.map((c) => String(c).length), 2) * fs * 0.55 : wid) + 14, Rt = 16, T = topPad, B = legendH + fs * 2.2;
      const pw = W - L - Rt, ph = H - T - B;
      if (pw < 20 || ph < 20) return placeholder(chart, W, H);
      const X = (v) => L + (v - (isXY ? xScale.min : scale.min)) / ((isXY ? xScale.max : scale.max) - (isXY ? xScale.min : scale.min)) * pw;
      const Y = (v) => T + ph - (v - scale.min) / (scale.max - scale.min) * ph;
      // axes + grid
      if (horiz) {
        scale.ticks.forEach((t) => { const x = L + (t - scale.min) / (scale.max - scale.min) * pw; parts.push('<line x1="' + x + '" y1="' + T + '" x2="' + x + '" y2="' + (T + ph) + '" stroke="#e3e3e3"/><text x="' + x + '" y="' + (T + ph + fs * 1.3) + '" text-anchor="middle" font-size="' + fs + '" fill="#666" ' + font + '>' + esc(tickLabel(t)) + '</text>'); });
        cats.forEach((c, i) => { const y = T + (i + 0.5) / nCat * ph; parts.push('<text x="' + (L - 6) + '" y="' + (y + fs * 0.35) + '" text-anchor="end" font-size="' + fs + '" fill="#666" ' + font + '>' + esc(c) + '</text>'); });
        parts.push('<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (T + ph) + '" stroke="#999"/>');
      } else {
        scale.ticks.forEach((t) => { const y = Y(t); parts.push('<line x1="' + L + '" y1="' + y + '" x2="' + (L + pw) + '" y2="' + y + '" stroke="' + (t === 0 ? '#999' : '#e3e3e3') + '"/><text x="' + (L - 6) + '" y="' + (y + fs * 0.35) + '" text-anchor="end" font-size="' + fs + '" fill="#666" ' + font + '>' + esc(tickLabel(t)) + '</text>'); });
        if (isXY) xScale.ticks.forEach((t) => { const x = X(t); parts.push('<line x1="' + x + '" y1="' + T + '" x2="' + x + '" y2="' + (T + ph) + '" stroke="#eee"/><text x="' + x + '" y="' + (T + ph + fs * 1.3) + '" text-anchor="middle" font-size="' + fs + '" fill="#666" ' + font + '>' + esc(fmtNum(t)) + '</text>'); });
        else {
          const every = Math.max(1, Math.ceil(nCat * (fs * 0.6 * Math.max(...cats.map((c) => String(c).length), 1) + 10) / pw));
          cats.forEach((c, i) => { if (i % every === 0) parts.push('<text x="' + (L + (i + 0.5) / nCat * pw) + '" y="' + (T + ph + fs * 1.3) + '" text-anchor="middle" font-size="' + fs + '" fill="#666" ' + font + '>' + esc(c) + '</text>'); });
        }
      }
      sers.forEach((s) => legendItems.push([s.name, s.color]));
      // bars
      const bars = sers.filter((s) => s.kind === 'bar');
      if (bars.length) {
        const stacked = bars[0].grouping === 'stacked' || bars[0].grouping === 'percentStacked', pct = bars[0].grouping === 'percentStacked';
        const slot = (horiz ? ph : pw) / nCat, nb = stacked ? 1 : bars.length, bw = slot / (1 + bars[0].gap / 100) / nb;
        for (let i = 0; i < nCat; i++) {
          let pos = 0, neg = 0, tot = 0;
          if (pct) bars.forEach((s) => { tot += Math.abs(s.val[i] || 0); });
          bars.forEach((s, bi) => {
            let v = s.val[i]; if (v == null) return;
            if (pct) v = tot ? v / tot : 0;
            const col = s.dpt[i] || s.color, off = (slot - bw * nb) / 2 + (stacked ? 0 : bi * bw);
            let v0 = 0, v1 = v;
            if (stacked) { if (v >= 0) { v0 = pos; pos += v; v1 = pos; } else { v0 = neg; neg += v; v1 = neg; } }
            if (horiz) {
              const x0 = L + (v0 - scale.min) / (scale.max - scale.min) * pw, x1 = L + (v1 - scale.min) / (scale.max - scale.min) * pw, y = T + i * slot + off;
              parts.push('<rect x="' + Math.min(x0, x1) + '" y="' + y + '" width="' + Math.abs(x1 - x0) + '" height="' + bw + '" fill="' + col + '"/>');
              if (s.labels) parts.push('<text x="' + (Math.max(x0, x1) + 4) + '" y="' + (y + bw / 2 + fs * 0.35) + '" font-size="' + fs + '" fill="#333" ' + font + '>' + esc(tickLabel(v)) + '</text>');
            } else {
              const y0 = Y(v0), y1 = Y(v1), x = L + i * slot + off;
              parts.push('<rect x="' + x + '" y="' + Math.min(y0, y1) + '" width="' + bw + '" height="' + Math.abs(y1 - y0) + '" fill="' + col + '"/>');
              if (s.labels) parts.push('<text x="' + (x + bw / 2) + '" y="' + (Math.min(y0, y1) - 4) + '" text-anchor="middle" font-size="' + fs + '" fill="#333" ' + font + '>' + esc(tickLabel(v)) + '</text>');
            }
          });
        }
      }
      // areas, lines, scatter
      const pt = (s, i) => (isXY ? [X(s.xs[i] == null ? i + 1 : s.xs[i]), Y(s.val[i])] : [L + (i + 0.5) / nCat * pw, Y(s.val[i])]);
      sers.filter((s) => s.kind === 'area').forEach((s) => {
        const P = s.val.map((v, i) => (v == null ? null : pt(s, i))).filter(Boolean);
        if (P.length > 1) parts.push('<path d="M' + P[0][0] + ',' + Y(0 > scale.min ? 0 : scale.min) + 'L' + P.map((p) => p.join(',')).join('L') + 'L' + P[P.length - 1][0] + ',' + Y(0 > scale.min ? 0 : scale.min) + 'Z" fill="' + s.color + '" fill-opacity=".55"/>');
      });
      sers.filter((s) => s.kind === 'line' || s.kind === 'scatter' || s.kind === 'bubble').forEach((s) => {
        const P = s.val.map((v, i) => (v == null ? null : pt(s, i))).filter(Boolean);
        const drawLine = s.kind === 'line' ? !s.noLine : s.kind === 'bubble' ? false : (/line/i.test(s.style) && !s.noLine);
        if (drawLine && P.length > 1) parts.push('<path d="M' + P.map((p) => p.join(',')).join('L') + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" stroke-linejoin="round"/>');
        const smax = s.sizes ? Math.max(...s.sizes, 1) : 1;
        s.val.forEach((v, i) => { if (v == null) return; const p = pt(s, i), r = s.sizes ? 5 + Math.sqrt((s.sizes[i] || 0) / smax) * Math.min(pw, ph) * 0.09 : (s.kind === 'scatter' ? 4.5 : 3.5); parts.push('<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + r.toFixed(1) + '" fill="' + s.color + '"' + (s.sizes ? ' fill-opacity=".6"' : '') + '/>'); });
        if (s.labels) s.val.forEach((v, i) => { if (v != null) { const p = pt(s, i); parts.push('<text x="' + p[0] + '" y="' + (p[1] - 8) + '" text-anchor="middle" font-size="' + fs + '" fill="#333" ' + font + '>' + esc(fmtNum(v)) + '</text>'); } });
      });
      // stock charts: a high–low line per category with open / close ticks (3 series = high, low, close; 4 = open, high, low, close)
      const st = sers.filter((s) => s.kind === 'stock');
      if (st.length >= 3) {
        const [op, hiS, loS, cl] = st.length >= 4 ? st : [null, st[0], st[1], st[2]], tick = Math.min(14, pw / nCat * 0.28);
        for (let i = 0; i < nCat; i++) {
          const hv = hiS.val[i], lv = loS.val[i], cv = cl.val[i], ov = op ? op.val[i] : null, x = L + (i + 0.5) / nCat * pw;
          if (hv == null || lv == null) continue;
          parts.push('<line x1="' + x + '" y1="' + Y(hv) + '" x2="' + x + '" y2="' + Y(lv) + '" stroke="#333" stroke-width="1.6"/>');
          if (op && ov != null && cv != null) { const up = cv >= ov; parts.push('<rect x="' + (x - tick) + '" y="' + Math.min(Y(ov), Y(cv)) + '" width="' + tick * 2 + '" height="' + Math.max(1.5, Math.abs(Y(ov) - Y(cv))) + '" fill="' + (up ? '#fff' : '#333') + '" stroke="#333" stroke-width="1.4"/>'); }
          else if (cv != null) parts.push('<line x1="' + x + '" y1="' + Y(cv) + '" x2="' + (x + tick) + '" y2="' + Y(cv) + '" stroke="#333" stroke-width="1.6"/>');
          if (!op && ov != null) parts.push('<line x1="' + (x - tick) + '" y1="' + Y(ov) + '" x2="' + x + '" y2="' + Y(ov) + '" stroke="#333" stroke-width="1.6"/>');
        }
        legendItems.length = 0;
      }
    }
    // title + legend
    if (titleText && !autoDel) parts.push('<text x="' + W / 2 + '" y="' + fs * 1.6 + '" text-anchor="middle" font-size="' + Math.round(fs * 1.25) + '" font-weight="bold" fill="#333" ' + font + '>' + esc(titleText) + '</text>');
    if (legendNode && legendItems.length) {
      const widths = legendItems.map(([n]) => textWidth(String(n), fs) + fs * 2.2), total = widths.reduce((a, b) => a + b, 0);
      let x = Math.max(6, (W - total) / 2), y = H - fs * 0.9;
      legendItems.forEach(([n, col], i) => {
        if (x + widths[i] > W) { x = 6; y -= fs * 1.5; }
        parts.push('<rect x="' + x + '" y="' + (y - fs * 0.8) + '" width="' + fs * 0.9 + '" height="' + fs * 0.9 + '" rx="2" fill="' + col + '"/><text x="' + (x + fs * 1.3) + '" y="' + y + '" font-size="' + fs + '" fill="#444" ' + font + '>' + esc(n) + '</text>');
        x += widths[i];
      });
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '"><rect width="100%" height="100%" fill="#fff"/>' + parts.join('') + '</svg>';
  }
  function placeholder(chart, W, H) {
    const t = chart ? all(chart, 't').map((x) => x.textContent).join('') : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"><rect width="100%" height="100%" fill="#f4f4f4"/><text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle" font-size="14" fill="#888" font-family="Arial, sans-serif">' + esc(t || 'Chart') + '</text></svg>';
  }

  /* =====================================================================
     SHAPES (Word text boxes, shapes, SmartArt)
     Each shape: { x, y, w, h, rot, flipH, flipV, prst, fill, line, lineW, paras:[{ text, size, bold, color, align }], anchor }
     ===================================================================== */
  function geometry(prst, w, h) {
    const P = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + 'Z';
    switch (prst) {
      case 'ellipse': return '<ellipse cx="' + w / 2 + '" cy="' + h / 2 + '" rx="' + w / 2 + '" ry="' + h / 2 + '"';
      case 'roundRect': case 'round2SameRect': case 'round1Rect': case 'snipRoundRect': { const r = Math.min(w, h) * 0.16; return '<rect width="' + w + '" height="' + h + '" rx="' + r + '"'; }
      case 'triangle': return '<path d="' + P([[w / 2, 0], [w, h], [0, h]]) + '"';
      case 'rtTriangle': return '<path d="' + P([[0, 0], [w, h], [0, h]]) + '"';
      case 'diamond': return '<path d="' + P([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) + '"';
      case 'parallelogram': return '<path d="' + P([[w * 0.2, 0], [w, 0], [w * 0.8, h], [0, h]]) + '"';
      case 'trapezoid': return '<path d="' + P([[w * 0.2, 0], [w * 0.8, 0], [w, h], [0, h]]) + '"';
      case 'hexagon': return '<path d="' + P([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]) + '"';
      case 'pentagon': case 'homePlate': return '<path d="' + P([[0, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [0, h]]) + '"';
      case 'chevron': return '<path d="' + P([[0, 0], [w * 0.7, 0], [w, h / 2], [w * 0.7, h], [0, h], [w * 0.3, h / 2]]) + '"';
      case 'rightArrow': return '<path d="' + P([[0, h * 0.25], [w * 0.6, h * 0.25], [w * 0.6, 0], [w, h / 2], [w * 0.6, h], [w * 0.6, h * 0.75], [0, h * 0.75]]) + '"';
      case 'leftArrow': return '<path d="' + P([[w, h * 0.25], [w * 0.4, h * 0.25], [w * 0.4, 0], [0, h / 2], [w * 0.4, h], [w * 0.4, h * 0.75], [w, h * 0.75]]) + '"';
      case 'upArrow': return '<path d="' + P([[w * 0.25, h], [w * 0.25, h * 0.4], [0, h * 0.4], [w / 2, 0], [w, h * 0.4], [w * 0.75, h * 0.4], [w * 0.75, h]]) + '"';
      case 'downArrow': return '<path d="' + P([[w * 0.25, 0], [w * 0.25, h * 0.6], [0, h * 0.6], [w / 2, h], [w, h * 0.6], [w * 0.75, h * 0.6], [w * 0.75, 0]]) + '"';
      case 'plus': case 'mathPlus': return '<path d="' + P([[w * 0.35, 0], [w * 0.65, 0], [w * 0.65, h * 0.35], [w, h * 0.35], [w, h * 0.65], [w * 0.65, h * 0.65], [w * 0.65, h], [w * 0.35, h], [w * 0.35, h * 0.65], [0, h * 0.65], [0, h * 0.35], [w * 0.35, h * 0.35]]) + '"';
      case 'star5': { const pts = []; for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, q = k % 2 ? 0.42 : 1; pts.push([w / 2 + Math.cos(a) * q * w / 2, h / 2 + Math.sin(a) * q * h / 2]); } return '<path d="' + P(pts) + '"'; }
      default: return '<rect width="' + w + '" height="' + h + '"';
    }
  }
  function shapesSvg(list, W, H) {
    const out = [];
    for (const s of list) {
      const w = Math.max(s.w, 0.5), h = Math.max(s.h, 0.5), cx = s.x + w / 2, cy = s.y + h / 2;
      const tf = 'translate(' + s.x + ',' + s.y + ')';
      const flip = (s.flipH || s.flipV || s.rot) ? ' transform="translate(' + cx + ',' + cy + ') rotate(' + (s.rot || 0) + ') scale(' + (s.flipH ? -1 : 1) + ',' + (s.flipV ? -1 : 1) + ') translate(' + -cx + ',' + -cy + ')"' : '';
      let g = '<g' + flip + '><g transform="' + tf + '">';
      if (s.prst === 'line' || s.prst === 'straightConnector1') {
        g += '<line x1="0" y1="0" x2="' + w + '" y2="' + h + '" stroke="' + (s.line && s.line !== 'none' ? s.line : '#444') + '" stroke-width="' + (s.lineW || 1.5) + '"/>';
      } else {
        const fill = s.fill === null || s.fill === undefined ? '#4472c4' : s.fill, stroke = s.line && s.line !== 'none' ? s.line : null;
        g += geometry(s.prst, w, h) + ' fill="' + (fill === 'none' ? 'none' : fill) + '"' + (stroke ? ' stroke="' + stroke + '" stroke-width="' + (s.lineW || 1) + '"' : '') + '/>';
      }
      // text
      const paras = (s.paras || []).filter((p) => p.text !== undefined);
      if (paras.some((p) => p.text.trim())) {
        const inset = 7, maxW = Math.max(10, w - inset * 2);
        let lines = [];
        for (const p of paras) {
          const size = p.size || 14, color = p.color || '#222';
          const wr = p.text.trim() ? wrapText(p.text, size, maxW, p.bold) : [''];
          for (const ln of wr) lines.push({ ln, size, color, bold: p.bold, align: p.align || s.align || 'l' });
        }
        const lh = (l) => l.size * 1.25, total = lines.reduce((a, l) => a + lh(l), 0);
        let y = s.anchor === 'b' ? h - inset - total : s.anchor === 't' ? inset : (h - total) / 2;
        for (const l of lines) {
          y += lh(l);
          const x = l.align === 'ctr' ? w / 2 : l.align === 'r' ? w - inset : inset, an = l.align === 'ctr' ? 'middle' : l.align === 'r' ? 'end' : 'start';
          if (l.ln) g += '<text x="' + x + '" y="' + (y - l.size * 0.27) + '" text-anchor="' + an + '" font-size="' + l.size + '" ' + (l.bold ? 'font-weight="bold" ' : '') + 'fill="' + l.color + '" font-family="Arial, Helvetica, sans-serif">' + esc(l.ln) + '</text>';
        }
      }
      out.push(g + '</g></g>');
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + out.join('') + '</svg>';
  }
  // Reads text paragraphs of a txBody / txbxContent into [{ text, size, bold, color, align }]
  function readParas(body, theme) {
    const out = [];
    for (const p of all(body, 'p')) {
      if (p.parentNode && p.parentNode.localName === 'p') continue;
      const runs = all(p, 'r').filter((r) => r.parentNode === p || true);
      let text = '', size = 0, bold = false, color = null;
      for (const r of runs) {
        const t = kid(r, 't'); if (!t) continue;
        text += t.textContent;
        const rp = kid(r, 'rPr');
        if (rp) {
          const sz = num(rp.getAttribute('sz'), 0) / 100 || num(attr(kid(rp, 'sz'), 'val'), 0) / 2;       // DrawingML: 1/100 pt · Word: half-points
          if (sz && !size) size = sz * 96 / 72;
          if (rp.getAttribute('b') === '1' || (kid(rp, 'b') && attr(kid(rp, 'b'), 'val', '1') !== '0')) bold = true;
          if (!color) { const f = kid(rp, 'solidFill'); color = f ? colorOf(f, theme) : null; const wc = kid(rp, 'color'), wv = attr(wc, 'val', null); if (!color && wv && wv !== 'auto') color = '#' + wv; }
        }
      }
      if (all(p, 'br').length) text += '\n'.repeat(all(p, 'br').length);        // line breaks inside a paragraph
      const ppr = kid(p, 'pPr'), jc = ppr && (attr(ppr, 'algn', null) || attr(kid(ppr, 'jc'), 'val', null));
      out.push({ text, size, bold, color, align: jc === 'ctr' || jc === 'center' ? 'ctr' : jc === 'r' || jc === 'right' ? 'r' : 'l' });
    }
    return out;
  }
  function xfrmOf(spPr) {
    const x = spPr && kid(spPr, 'xfrm');
    if (!x) return null;
    const off = kid(x, 'off'), ext = kid(x, 'ext'), co = kid(x, 'chOff'), ce = kid(x, 'chExt');
    return {
      x: num(attr(off, 'x'), 0) / EMU, y: num(attr(off, 'y'), 0) / EMU, w: num(attr(ext, 'cx'), 0) / EMU, h: num(attr(ext, 'cy'), 0) / EMU,
      cx: co ? num(attr(co, 'x'), 0) / EMU : null, cy: co ? num(attr(co, 'y'), 0) / EMU : null, cw: ce ? num(attr(ce, 'cx'), 0) / EMU : null, ch: ce ? num(attr(ce, 'cy'), 0) / EMU : null,
      rot: num(x.getAttribute('rot'), 0) / 60000, flipH: x.getAttribute('flipH') === '1', flipV: x.getAttribute('flipV') === '1',
    };
  }
  // Collects the shapes of a wps:wsp / wpg:wgp / dsp:drawing node, in the coordinates of the outermost box
  function collectShapes(root, theme, out, map) {
    map = map || { sx: 1, sy: 1, dx: 0, dy: 0 };
    for (const n of Array.from(root.children)) {
      const ln = n.localName;
      if (ln === 'wgp' || ln === 'grpSp') {
        const gp = kid(n, 'grpSpPr'), xf = xfrmOf(gp);
        let m = map;
        if (xf && xf.cw && xf.ch) { const sx = xf.w / xf.cw, sy = xf.h / xf.ch; m = { sx: map.sx * sx, sy: map.sy * sy, dx: map.dx + map.sx * (xf.x - xf.cx * sx), dy: map.dy + map.sy * (xf.y - xf.cy * sy) }; }
        collectShapes(n, theme, out, m);
      } else if (ln === 'wsp' || ln === 'sp' || ln === 'cxnSp') {
        const sp = kid(n, 'spPr'), xf = xfrmOf(sp);
        if (!xf) continue;
        const geom = sp && kid(sp, 'prstGeom'), body = kid(n, 'txbx') || kid(n, 'txBody');
        const lnNode = sp && kid(sp, 'ln'), style = kid(n, 'style');
        let fill = fillOf(sp, theme), line = lnNode ? (kid(lnNode, 'noFill') ? 'none' : fillOf(lnNode, theme)) : null;
        if (fill === null && style) { const fr = kid(style, 'fillRef'); if (fr && num(fr.getAttribute('idx'), 0) > 0) fill = colorOf(fr, theme); }
        if (line === null && style) { const lr = kid(style, 'lnRef'); if (lr && num(lr.getAttribute('idx'), 0) > 0) line = colorOf(lr, theme); }
        const bp = (kid(n, 'bodyPr') || (body && kid(body, 'bodyPr'))), anc = bp && bp.getAttribute('anchor');
        out.push({
          x: map.dx + xf.x * map.sx, y: map.dy + xf.y * map.sy, w: xf.w * map.sx, h: xf.h * map.sy, rot: xf.rot, flipH: xf.flipH, flipV: xf.flipV,
          prst: geom ? geom.getAttribute('prst') : (ln === 'cxnSp' ? 'line' : 'rect'), fill: ln === 'cxnSp' ? 'none' : fill, line, lineW: lnNode ? num(lnNode.getAttribute('w'), 12700) / EMU : 1,
          paras: body ? readParas(body, theme) : [], anchor: anc === 'b' ? 'b' : anc === 't' ? 't' : 'ctr',
        });
      } else if (ln === 'pic') { /* pictures inside groups are left out */ }
    }
  }

  async function svgToPng(svg, W, H, scale) {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      await new Promise((ok, fail) => { img.onload = ok; img.onerror = () => fail(new Error('svg')); img.src = url; });
      const cv = document.createElement('canvas');
      cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
      cx.drawImage(img, 0, 0, cv.width, cv.height);
      const blob = await new Promise((ok) => cv.toBlob(ok, 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    } finally { URL.revokeObjectURL(url); }
  }

  /* =====================================================================
     DOCX: replace charts, shapes and SmartArt by pictures before docx-preview reads the file
     ===================================================================== */
  async function docxPrepare(buf) {
    const zip = await JSZip.loadAsync(buf);
    const docFile = zip.file('word/document.xml');
    if (!docFile) return buf;
    let changed = false;
    const docXml = await docFile.async('string');
    const needs = /drawingml\/2006\/chart|wordprocessingShape|wordprocessingGroup|drawingml\/2006\/diagram|[-]/.test(docXml) || /Symbol|Wingdings/.test(docXml);
    if (!needs) return buf;

    // bullets in the Symbol / Wingdings fonts have no glyph on most screens
    const numFile = zip.file('word/numbering.xml');
    if (numFile) {
      let nx = await numFile.async('string'), before = nx;
      const map = { '': '•', '': '▪', '': '➢', '': '✓', '': '❖', '': '□', '': '□', '': '■' };
      nx = nx.replace(/(<w:lvlText\b[^>]*w:val=")([-])(")/g, (m, a, ch, c) => a + (map[ch] || '•') + c);
      if (nx !== before) {
        nx = nx.replace(/<w:rFonts\b[^>]*w:(?:ascii|hAnsi)="(?:Symbol|Wingdings[^"]*)"[^>]*\/>/g, '');
        zip.file('word/numbering.xml', nx); changed = true;
      }
    }

    const relsFile = zip.file('word/_rels/document.xml.rels');
    const rels = relsFile ? parse(await relsFile.async('string')) : null;
    const relTarget = (id) => { const r = rels && all(rels, 'Relationship').find((x) => x.getAttribute('Id') === id); return r ? 'word/' + r.getAttribute('Target').replace(/^\/?(word\/)?/, '') : null; };
    const theme = themeColors(zip.file('word/theme/theme1.xml') ? await zip.file('word/theme/theme1.xml').async('string') : '');
    const doc = parse(docXml);
    if (first(doc, 'parsererror')) return buf;

    // Word keeps shapes inside mc:AlternateContent; use the modern (Choice) version when we can draw it
    for (const ac of all(doc, 'AlternateContent')) {
      const ch = kid(ac, 'Choice');
      if (ch && /wps|wpg|wpc|dgm/.test(attr(ch, 'Requires', ''))) {
        const par = ac.parentNode; if (!par) continue;
        for (const k of Array.from(ch.childNodes)) par.insertBefore(k, ac);
        par.removeChild(ac); changed = true;
      }
    }

    let n = 0;
    const drawings = all(doc, 'drawing');
    for (const dr of drawings) {
      const holder = kid(dr, 'inline') || kid(dr, 'anchor');
      const gd = holder && first(holder, 'graphicData');
      if (!gd) continue;
      const uri = gd.getAttribute('uri') || '';
      const ext = kid(holder, 'extent');
      const W = Math.round(num(attr(ext, 'cx'), 0) / EMU), H = Math.round(num(attr(ext, 'cy'), 0) / EMU);
      if (W < 4 || H < 4) continue;
      let svg = null;
      try {
        if (/chart$/.test(uri)) {
          const ch = first(gd, 'chart'), id = ch && (ch.getAttributeNS(NS.r, 'id') || ch.getAttribute('r:id')), p = id && relTarget(id), f = p && zip.file(p);
          if (f) svg = chartSvg(await f.async('string'), theme, W, H);
        } else if (/wordprocessingShape$/.test(uri) || /wordprocessingGroup$/.test(uri)) {
          const list = [], top = gd.firstElementChild;
          if (top && top.localName === 'wsp') {
            // a single shape fills its whole box
            const sp = kid(top, 'spPr'), xf = xfrmOf(sp);
            const one = []; collectShapes(gd, theme, one);
            if (one.length && xf) { one[0].x = 0; one[0].y = 0; one[0].w = W; one[0].h = H; }
            list.push(...one);
          } else if (top) {
            const gx = xfrmOf(kid(top, 'grpSpPr'));
            const m = gx && gx.cw && gx.ch ? { sx: W / gx.cw, sy: H / gx.ch, dx: -gx.cx * (W / gx.cw), dy: -gx.cy * (H / gx.ch) } : { sx: 1, sy: 1, dx: 0, dy: 0 };
            collectShapes(top, theme, list, m);
          }
          if (list.length) svg = shapesSvg(list, W, H);
        } else if (/diagram$/.test(uri)) {
          const dm = first(gd, 'relIds'), dmId = dm && (dm.getAttributeNS(NS.r, 'dm') || dm.getAttribute('r:dm')), dmPath = dmId && relTarget(dmId), dmFile = dmPath && zip.file(dmPath);
          if (dmFile) {
            const ext2 = first(parse(await dmFile.async('string')), 'dataModelExt'), rid = ext2 && ext2.getAttribute('relId'), dp = rid && relTarget(rid), df = dp && zip.file(dp);
            if (df) {
              const droot = first(parse(await df.async('string')), 'spTree'), list = [];
              if (droot) collectShapes(droot, theme, list);
              if (list.length) svg = shapesSvg(list, W, H);
            }
          }
        }
      } catch (err) { console.warn('Drawing skipped', err); svg = null; }
      if (!svg) continue;
      let png;
      try { png = await svgToPng(svg, W, H, 2); } catch (err) { continue; }
      const name = 'lectern_draw' + (++n) + '.png', rid = 'rIdLectern' + n;
      zip.file('word/media/' + name, png);
      const rel = rels.createElementNS(rels.documentElement.namespaceURI, 'Relationship');
      rel.setAttribute('Id', rid); rel.setAttribute('Type', NS.r + '/image'); rel.setAttribute('Target', 'media/' + name);
      rels.documentElement.appendChild(rel);
      const pic = parse('<pic:pic xmlns:pic="' + NS.pic + '" xmlns:a="' + NS.a + '" xmlns:r="' + NS.r + '"><pic:nvPicPr><pic:cNvPr id="0" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + Math.round(W * EMU) + '" cy="' + Math.round(H * EMU) + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>').documentElement;
      gd.setAttribute('uri', NS.pic);
      gd.replaceChildren(doc.importNode(pic, true));
      changed = true;
    }
    if (n) {
      zip.file('word/_rels/document.xml.rels', new XMLSerializer().serializeToString(rels));
      const ctf = zip.file('[Content_Types].xml');
      if (ctf) {
        let ct = await ctf.async('string');
        if (!/Extension="png"/i.test(ct)) ct = ct.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
        zip.file('[Content_Types].xml', ct);
      }
    }
    if (!changed) return buf;
    zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
    return zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
  }

  /* =====================================================================
     XLSX: cell colours, column widths, pictures, charts
     ===================================================================== */
  const colIndex = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref); if (!m) return null; let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return { c: c - 1, r: +m[2] - 1 }; };

  async function xlsxDecor(buf) {
    const zip = await JSZip.loadAsync(buf);
    const wbf = zip.file('xl/workbook.xml');
    if (!wbf) return null;
    const theme = themeColors(zip.file('xl/theme/theme1.xml') ? await zip.file('xl/theme/theme1.xml').async('string') : '');
    const wb = parse(await wbf.async('string')), wrels = parse(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
    const target = (rels, id, base) => { const r = all(rels, 'Relationship').find((x) => x.getAttribute('Id') === id); if (!r) return null; const t = r.getAttribute('Target'); return t.startsWith('/') ? t.slice(1) : normalize(base + t); };
    function normalize(p) { const out = []; for (const s of p.split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return out.join('/'); }
    // styles
    const styles = zip.file('xl/styles.xml') ? parse(await zip.file('xl/styles.xml').async('string')) : null;
    let xfs = [];
    if (styles) {
      const fonts = all(kid(styles.documentElement, 'fonts'), 'font').map((f) => ({ bold: !!kid(f, 'b') && attr(kid(f, 'b'), 'val', '1') !== '0', italic: !!kid(f, 'i'), color: kid(f, 'color') ? (kid(f, 'color').getAttribute('rgb') ? '#' + kid(f, 'color').getAttribute('rgb').slice(-6) : kid(f, 'color').getAttribute('theme') != null ? colorOf(parse('<x xmlns:a="' + NS.a + '"><a:schemeClr val="' + ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'][num(kid(f, 'color').getAttribute('theme'), 1)] + '"/></x>').documentElement, theme) : null) : null }));
      const fills = all(kid(styles.documentElement, 'fills'), 'fill').map((f) => {
        const pf = kid(f, 'patternFill'), fg = pf && kid(pf, 'fgColor');
        if (!pf || attr(pf, 'patternType', 'none') !== 'solid' || !fg) return null;
        if (fg.getAttribute('rgb')) return '#' + fg.getAttribute('rgb').slice(-6);
        if (fg.getAttribute('theme') != null) {
          const base = theme[['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'][num(fg.getAttribute('theme'), 0)]] || '#ffffff', tint = num(fg.getAttribute('tint'), 0);
          if (!tint) return base;
          const [hh, s, l] = hexToHsl(base); return hslToHex(hh, s, tint > 0 ? l + (1 - l) * tint : l * (1 + tint));
        }
        if (fg.getAttribute('indexed') != null) return null;
        return null;
      });
      const fmtCodes = {};                                          // number format id -> code (custom ones from the file, the rest are built in)
      const nf = kid(styles.documentElement, 'numFmts');
      if (nf) for (const f of all(nf, 'numFmt')) fmtCodes[f.getAttribute('numFmtId')] = f.getAttribute('formatCode');
      const builtIn = (typeof XLSX !== 'undefined' && XLSX.SSF && XLSX.SSF.get_table) ? XLSX.SSF.get_table() : {};
      xfs = all(kid(styles.documentElement, 'cellXfs'), 'xf').map((x) => {
        const al = kid(x, 'alignment'), f = fonts[num(x.getAttribute('fontId'), 0)] || {}, id = x.getAttribute('numFmtId');
        return { fmt: fmtCodes[id] || (id && id !== '0' ? builtIn[id] : '') || '', bg: fills[num(x.getAttribute('fillId'), 0)] || null, bold: f.bold, italic: f.italic, color: f.color, h: al && al.getAttribute('horizontal'), v: al && al.getAttribute('vertical'), wrap: al && al.getAttribute('wrapText') === '1' };
      });
    }
    const SCHEME = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
    const xlColor = (n) => {                                  // <color rgb=".."/> or theme="n" tint=".."
      if (!n) return null;
      if (n.getAttribute('rgb')) return '#' + n.getAttribute('rgb').slice(-6).toLowerCase();
      if (n.getAttribute('theme') != null) { const base = theme[SCHEME[num(n.getAttribute('theme'), 0)]] || '#ffffff', tint = num(n.getAttribute('tint'), 0); if (!tint) return base; const [hh, sa, l] = hexToHsl(base); return hslToHex(hh, sa, tint > 0 ? l + (1 - l) * tint : l * (1 + tint)); }
      return null;
    };
    const dxfs = styles ? all(kid(styles.documentElement, 'dxfs'), 'dxf').map((d) => { const f = kid(d, 'font'), fl = kid(d, 'fill'), pf = fl && kid(fl, 'patternFill'); return { bg: pf ? xlColor(kid(pf, 'bgColor')) || xlColor(kid(pf, 'fgColor')) : null, color: f ? xlColor(kid(f, 'color')) : null, bold: !!(f && kid(f, 'b')) }; }) : [];
    const out = {};
    for (const sh of all(wb, 'sheet')) {
      const name = sh.getAttribute('name'), rid = sh.getAttributeNS(NS.r, 'id') || sh.getAttribute('r:id'), spath = target(wrels, rid, 'xl/');
      const sf = spath && zip.file(spath);
      if (!sf) continue;
      const sx = parse(await sf.async('string')), info = { cells: new Map(), colW: {}, drawings: [] };
      info.formulas = [];                      // formulas saved without a result: SheetJS drops these cells
      for (const c of all(sx, 'c')) {
        const fn = kid(c, 'f');
        if (fn && fn.textContent && !(kid(c, 'v') && kid(c, 'v').textContent)) info.formulas.push([c.getAttribute('r'), fn.textContent, (xfs[num(c.getAttribute('s'), 0)] || {}).fmt || '']);
      }
      for (const c of all(sx, 'c')) {
        const s = num(c.getAttribute('s'), 0), st = xfs[s];
        if (st && (st.bg || st.bold || st.italic || st.color || st.h || st.v || st.wrap)) { const p = colIndex(c.getAttribute('r')); if (p) info.cells.set(p.r + ':' + p.c, st); }
      }
      info.cf = [];
      for (const cfn of all(sx, 'conditionalFormatting')) {
        const ranges = parseSqref(cfn.getAttribute('sqref'));
        for (const ru of kids(cfn, 'cfRule')) {
          const type = ru.getAttribute('type'), vo = (n) => all(n, 'cfvo').map((x) => ({ type: x.getAttribute('type'), val: x.getAttribute('val') })), cols = (n) => all(n, 'color').map(xlColor);
          if (type === 'colorScale') { const cs = kid(ru, 'colorScale'); if (cs) info.cf.push({ type, ranges, cfvo: vo(cs), colors: cols(cs).map((c) => c || '#ffffff') }); }
          else if (type === 'dataBar') { const db = kid(ru, 'dataBar'); if (db) info.cf.push({ type, ranges, cfvo: vo(db).slice(0, 2), colors: [cols(db)[0] || '#638ec6'] }); }
          else if (type === 'iconSet') { const is = kid(ru, 'iconSet'); if (is) info.cf.push({ type, ranges, set: is.getAttribute('iconSet') || '3TrafficLights1', cfvo: vo(is), reverse: is.getAttribute('reverse') === '1', showValue: is.getAttribute('showValue') !== '0' }); }
          else if (type === 'cellIs') info.cf.push({ type, ranges, op: ru.getAttribute('operator'), args: kids(ru, 'formula').map((f) => num(f.textContent, NaN)), dxf: dxfs[num(ru.getAttribute('dxfId'), -1)] || null });
        }
      }
      for (const col of all(sx, 'col')) { const w = num(col.getAttribute('width'), 0); for (let i = num(col.getAttribute('min'), 1); i <= Math.min(num(col.getAttribute('max'), 1), 200); i++) info.colW[i - 1] = Math.round(w * 7 + 5); }
      // drawings
      const srels = zip.file(spath.replace(/([^/]+)$/, '_rels/$1.rels'));
      const dnode = first(sx, 'drawing');
      if (srels && dnode) {
        const sr = parse(await srels.async('string')), did = dnode.getAttributeNS(NS.r, 'id') || dnode.getAttribute('r:id'), dpath = target(sr, did, spath.replace(/[^/]+$/, ''));
        const df = dpath && zip.file(dpath);
        if (df) {
          const dx = parse(await df.async('string')), drels = zip.file(dpath.replace(/([^/]+)$/, '_rels/$1.rels')), dr = drels ? parse(await drels.async('string')) : null;
          const base = dpath.replace(/[^/]+$/, '');
          for (const an of Array.from(dx.documentElement.children)) {
            const from = kid(an, 'from'), to = kid(an, 'to');
            if (!from) continue;
            const pos = (n) => ({ c: num(first(n, 'col').textContent, 0), co: num(first(n, 'colOff').textContent, 0) / EMU, r: num(first(n, 'row').textContent, 0), ro: num(first(n, 'rowOff').textContent, 0) / EMU });
            const ext = kid(an, 'ext'), item = { from: pos(from), to: to ? pos(to) : null, w: ext ? num(ext.getAttribute('cx'), 0) / EMU : 0, h: ext ? num(ext.getAttribute('cy'), 0) / EMU : 0 };
            const cf = first(an, 'chart'), pc = first(an, 'pic');
            if (cf && dr) {
              const cid = cf.getAttributeNS(NS.r, 'id') || cf.getAttribute('r:id'), cp = target(dr, cid, base), cfile = cp && zip.file(cp);
              if (cfile) { item.kind = 'chart'; item.xml = await cfile.async('string'); }
            } else if (pc && dr) {
              const bl = first(pc, 'blip'), iid = bl && (bl.getAttributeNS(NS.r, 'embed') || bl.getAttribute('r:embed')), ip = iid && target(dr, iid, base), ifile = ip && zip.file(ip);
              if (ifile) { item.kind = 'image'; const ext3 = ip.split('.').pop().toLowerCase(); item.blob = new Blob([await ifile.async('arraybuffer')], { type: ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' })[ext3] || 'image/png' }); }
            }
            if (item.kind) info.drawings.push(item);
          }
        }
      }
      out[name] = info;
    }
    out.__theme = theme;
    return out;
  }


  /* =====================================================================
     PPTX: SmartArt graphics are replaced by the ordinary shapes PowerPoint saved next to them
     ===================================================================== */
  async function pptxDiagrams(zip) {
    let changed = false;
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    for (const sn of slides) {
      const xml = await zip.file(sn).async('string');
      if (!/drawingml\/2006\/diagram/.test(xml)) continue;
      const rf = zip.file(sn.replace(/([^/]+)$/, '_rels/$1.rels'));
      if (!rf) continue;
      const rels = parse(await rf.async('string')), doc = parse(xml);
      const relPath = (id) => { const r = all(rels, 'Relationship').find((x) => x.getAttribute('Id') === id); if (!r) return null; const t = r.getAttribute('Target'); const parts = (t.startsWith('/') ? t.slice(1) : 'ppt/slides/' + t).split('/'), out = []; for (const q of parts) { if (q === '..') out.pop(); else if (q && q !== '.') out.push(q); } return out.join('/'); };
      let nid = 9000, touched = false;
      for (const gf of all(doc, 'graphicFrame')) {
        const gd = first(gf, 'graphicData');
        if (!gd || !/diagram$/.test(gd.getAttribute('uri') || '')) continue;
        const ids = first(gd, 'relIds'), dmId = ids && (ids.getAttributeNS(NS.r, 'dm') || ids.getAttribute('r:dm')), dmP = dmId && relPath(dmId), dmF = dmP && zip.file(dmP);
        if (!dmF) continue;
        const ext = first(parse(await dmF.async('string')), 'dataModelExt'), rid = ext && ext.getAttribute('relId'), drP = rid && relPath(rid), drF = drP && zip.file(drP);
        if (!drF) continue;
        const tree = first(parse(await drF.async('string')), 'spTree'), xf = first(kid(gf, 'xfrm'), 'off') || first(gf, 'off');
        if (!tree || !xf) continue;
        const ox = num(xf.getAttribute('x'), 0), oy = num(xf.getAttribute('y'), 0), parent = gf.parentNode, frag = [];
        for (const sp of all(tree, 'sp')) {
          const spPr = kid(sp, 'spPr'), txBody = kid(sp, 'txBody');
          if (!spPr) continue;
          const off = first(spPr, 'off');
          if (off) { off.setAttribute('x', String(num(off.getAttribute('x'), 0) + ox)); off.setAttribute('y', String(num(off.getAttribute('y'), 0) + oy)); }
          const ser = new XMLSerializer();
          const inner = (n) => Array.from(n.childNodes).map((k) => ser.serializeToString(k)).join('');
          frag.push('<p:sp xmlns:p="' + P + '" xmlns:a="' + NS.a + '"><p:nvSpPr><p:cNvPr id="' + (nid++) + '" name="SmartArt"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>' + inner(spPr) + '</p:spPr>' + (txBody ? '<p:txBody>' + inner(txBody) + '</p:txBody>' : '') + '</p:sp>');
        }
        if (!frag.length) continue;
        for (const f of frag) parent.insertBefore(doc.importNode(parse(f).documentElement, true), gf);
        parent.removeChild(gf); changed = touched = true;
      }
      if (touched) zip.file(sn, new XMLSerializer().serializeToString(doc));
    }
    return changed;
  }


  // Charts the PowerPoint renderer can't draw (stock, surface, bubble, of-pie) are drawn here and put back as pictures
  async function pptxCharts(zip) {
    const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const theme = themeColors(zip.file('ppt/theme/theme1.xml') ? await zip.file('ppt/theme/theme1.xml').async('string') : '');
    let any = false, pics = 0;
    for (const sn of slides) {
      const xml = await zip.file(sn).async('string');
      if (!/drawingml\/2006\/chart/.test(xml)) continue;
      const relsName = sn.replace(/([^/]+)$/, '_rels/$1.rels'), rf = zip.file(relsName);
      if (!rf) continue;
      const rels = parse(await rf.async('string')), doc = parse(xml);
      const relPath = (id) => { const r = all(rels, 'Relationship').find((x) => x.getAttribute('Id') === id); if (!r) return null; const t = r.getAttribute('Target'); const parts = (t.startsWith('/') ? t.slice(1) : 'ppt/slides/' + t).split('/'), out = []; for (const q of parts) { if (q === '..') out.pop(); else if (q && q !== '.') out.push(q); } return out.join('/'); };
      let touched = false;
      for (const gf of all(doc, 'graphicFrame')) {
        const gd = first(gf, 'graphicData');
        if (!gd || !/chart$/.test(gd.getAttribute('uri') || '')) continue;
        const cn = first(gd, 'chart'), cid = cn && (cn.getAttributeNS(NS.r, 'id') || cn.getAttribute('r:id')), cp = cid && relPath(cid), cf = cp && zip.file(cp);
        if (!cf) continue;
        const cxml = await cf.async('string');
        const odd = /<(?:\w+:)?(stockChart|surfaceChart|surface3DChart)\b/.test(cxml) || (/<(?:\w+:)?(bubbleChart|ofPieChart)\b/.test(cxml) && !/<(?:\w+:)?(barChart|lineChart|areaChart|pieChart|scatterChart|radarChart)\b/.test(cxml));
        if (!odd) continue;
        const off = first(gf, 'off'), ext = first(gf, 'ext');
        if (!off || !ext) continue;
        const W = Math.max(120, Math.min(1600, Math.round(num(ext.getAttribute('cx'), 0) / 9525))), H = Math.max(80, Math.min(1000, Math.round(num(ext.getAttribute('cy'), 0) / 9525)));
        let png;
        try { const svg = chartSvg(cxml, theme, W, H); if (!svg) continue; png = await svgToPng(svg, W, H, 2); } catch (e) { continue; }
        const name = 'image-lectern-chart' + (++pics) + '.png', rid = 'rIdLc' + pics;
        zip.file('ppt/media/' + name, png);
        const rel = rels.createElementNS(rels.documentElement.namespaceURI, 'Relationship');
        rel.setAttribute('Id', rid); rel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'); rel.setAttribute('Target', '../media/' + name);
        rels.documentElement.appendChild(rel);
        const pic = parse('<p:pic xmlns:p="' + P + '" xmlns:a="' + NS.a + '" xmlns:r="' + NS.r + '"><p:nvPicPr><p:cNvPr id="' + (9500 + pics) + '" name="Chart"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="' + off.getAttribute('x') + '" y="' + off.getAttribute('y') + '"/><a:ext cx="' + ext.getAttribute('cx') + '" cy="' + ext.getAttribute('cy') + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>').documentElement;
        gf.parentNode.insertBefore(doc.importNode(pic, true), gf);
        gf.parentNode.removeChild(gf);
        touched = true;
      }
      if (touched) { zip.file(sn, new XMLSerializer().serializeToString(doc)); zip.file(relsName, new XMLSerializer().serializeToString(rels)); any = true; }
    }
    if (any) {
      const ctf = zip.file('[Content_Types].xml');
      if (ctf) { let ct = await ctf.async('string'); if (!/Extension="png"/i.test(ct)) { ct = ct.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'); zip.file('[Content_Types].xml', ct); } }
    }
    return any;
  }

  /* =====================================================================
     ODF charts (LibreOffice / OpenOffice): converted to the same model the Office charts use
     ===================================================================== */
  function odfChartSvg(xml, W, H) {
    const doc = parse(xml), ch = all(doc, 'chart').find((e) => e.getAttribute('chart:class') != null);
    if (!ch) return null;
    const cls = (ch.getAttribute('chart:class') || '').replace('chart:', ''), type = ({ bar: 'bar', line: 'line', area: 'area', circle: 'pie', ring: 'doughnut', scatter: 'scatter', radar: 'radar', 'filled-radar': 'radar' })[cls];
    if (!type) return placeholderText('Chart', W, H);
    // local table -> grid
    const grid = [];
    const tbl = first(first(doc, 'local-table') || doc, 'table');
    const addRows = (node) => { for (const r of all(node, 'table-row')) { const row = []; for (const c of kids(r, 'table-cell')) { const rep = num(c.getAttribute('table:number-columns-repeated'), 1), v = c.getAttribute('office:value'), t = first(c, 'p'); for (let k = 0; k < Math.min(rep, 50); k++) row.push(v != null ? v : (t ? t.textContent : '')); } grid.push(row); } };
    if (tbl) addRows(tbl);
    const cell = (a) => { const m = /\.?\$?([A-Z]+)\$?(\d+)/.exec(a || ''); if (!m) return ''; let c = 0; for (const x of m[1]) c = c * 26 + x.charCodeAt(0) - 64; return (grid[+m[2] - 1] || [])[c - 1]; };
    const range = (a) => { const parts = (a || '').split(/[:\s]/).filter(Boolean).map((x) => x.replace(/^.*\./, '').replace(/\$/g, '')); if (!parts.length) return []; const m1 = /([A-Z]+)(\d+)/.exec(parts[0]), m2 = /([A-Z]+)(\d+)/.exec(parts[parts.length - 1]); if (!m1 || !m2) return []; const ci = (t) => { let c = 0; for (const x of t) c = c * 26 + x.charCodeAt(0) - 64; return c - 1; }; const out = []; for (let r = +m1[2] - 1; r <= +m2[2] - 1; r++) for (let c = ci(m1[1]); c <= ci(m2[1]); c++) out.push((grid[r] || [])[c]); return out; };
    // colours of the series from the automatic styles
    const colorByStyle = {};
    for (const st of all(doc, 'style')) { const gp = first(st, 'graphic-properties'); if (gp) { const c = gp.getAttribute('draw:fill-color') || gp.getAttribute('svg:stroke-color'); if (c && /^#/.test(c)) colorByStyle[st.getAttribute('style:name')] = c.slice(1); } }
    const plot = first(ch, 'plot-area'), pst = plot && all(doc, 'style').find((x) => x.getAttribute('style:name') === plot.getAttribute('chart:style-name')), cp = pst && first(pst, 'chart-properties');
    const stacked = cp && (cp.getAttribute('chart:stacked') === 'true' || cp.getAttribute('chart:percentage') === 'true'), horiz = cp && cp.getAttribute('chart:vertical') === 'true';
    const title = first(first(ch, 'title') || ch, 'p'), cats = first(plot, 'categories') ? range(first(plot, 'categories').getAttribute('table:cell-range-address')) : [];
    const lit = (arr, tag) => '<c:' + tag + '><c:ptCount val="' + arr.length + '"/>' + arr.map((v, i) => '<c:pt idx="' + i + '"><c:v>' + esc(v == null ? '' : v) + '</c:v></c:pt>').join('') + '</c:' + tag + '>';
    const serXml = all(plot, 'series').map((sr, i) => {
      const vals = range(sr.getAttribute('chart:values-cell-range-address')), name = cell(sr.getAttribute('chart:label-cell-address')) || ('Series ' + (i + 1)), col = colorByStyle[sr.getAttribute('chart:style-name')];
      const sp = col ? '<c:spPr><a:solidFill><a:srgbClr val="' + col.slice(0, 6) + '"/></a:solidFill></c:spPr>' : '';
      const xr = sr.getAttribute('chart:domain') || (first(sr, 'domain') && first(sr, 'domain').getAttribute('table:cell-range-address'));
      return '<c:ser><c:tx><c:strLit><c:ptCount val="1"/><c:pt idx="0"><c:v>' + esc(name) + '</c:v></c:pt></c:strLit></c:tx>' + sp
        + (type === 'scatter' ? '<c:xVal>' + lit(range(xr), 'numLit') + '</c:xVal><c:yVal>' + lit(vals, 'numLit') + '</c:yVal>' : '<c:cat>' + lit(cats.length ? cats : vals.map((_, k) => String(k + 1)), 'strLit') + '</c:cat><c:val>' + lit(vals, 'numLit') + '</c:val>') + '</c:ser>';
    }).join('');
    const body = { bar: '<c:barChart><c:barDir val="' + (horiz ? 'bar' : 'col') + '"/><c:grouping val="' + (stacked ? 'stacked' : 'clustered') + '"/>', line: '<c:lineChart>', area: '<c:areaChart>', pie: '<c:pieChart>', doughnut: '<c:doughnutChart><c:holeSize val="55"/>', scatter: '<c:scatterChart><c:scatterStyle val="marker"/>', radar: '<c:radarChart><c:radarStyle val="marker"/>' }[type];
    const x = '<c:chartSpace xmlns:c="' + NS.c + '" xmlns:a="' + NS.a + '"><c:chart>' + (title ? '<c:title><c:tx><c:rich><a:p><a:r><a:t>' + esc(title.textContent) + '</a:t></a:r></a:p></c:rich></c:tx></c:title>' : '') + '<c:plotArea>' + body + serXml + '</c:' + body.match(/^<c:([a-zA-Z]+)/)[1] + '></c:plotArea>' + (first(ch, 'legend') ? '<c:legend/>' : '') + '</c:chart></c:chartSpace>';
    return chartSvg(x, {}, W, H);
  }
  function placeholderText(t, W, H) { return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"><rect width="100%" height="100%" fill="#f4f4f4"/><text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle" font-size="14" fill="#888" font-family="Arial, sans-serif">' + esc(t) + '</text></svg>'; }

  /* =====================================================================
     XLSX: formulas without a saved result (files made by scripts or some online editors)
     ===================================================================== */
  function fillFormulas(wb) {
    const SSF = (typeof XLSX !== 'undefined' && XLSX.SSF) || null, memo = new Map();
    let any = false;
    for (const name of wb.SheetNames) { const ws = wb.Sheets[name]; for (const k in ws) if (k[0] !== '!' && ws[k] && ws[k].f && ws[k].v === undefined) { any = true; break; } if (any) break; }
    if (!any) return 0;
    const colNum = (t) => { let c = 0; for (const ch of t) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; };
    const TOK = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|"((?:[^"]|"")*)"|((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?(?![\w(])|([A-Za-z_][\w.]*)\(|(TRUE|FALSE)|(<>|<=|>=|[-+*/^&=<>(),;%]))/y;
    function value(sn, a, stack) {
      const ws = wb.Sheets[sn]; if (!ws) throw new Error('sheet');
      const c = ws[a]; if (!c) return null;
      if (c.v !== undefined) return c.v;
      if (!c.f) return null;
      const key = sn + '!' + a;
      if (memo.has(key)) return memo.get(key);
      if (stack.has(key)) throw new Error('loop');
      stack.add(key);
      let v; try { v = evalF(c.f, sn, stack); } finally { stack.delete(key); }
      memo.set(key, v);
      return v;
    }
    function evalF(f, sn, stack) {
      const toks = []; TOK.lastIndex = 0; let pos = 0, m; f = f.replace(/^=/, '');
      while (pos < f.length) {
        TOK.lastIndex = pos; m = TOK.exec(f);
        if (!m) { if (/^\s*$/.test(f.slice(pos))) break; throw new Error('token'); }
        pos = TOK.lastIndex;
        if (m[1] !== undefined) toks.push({ t: 'n', v: parseFloat(m[1]) });
        else if (m[2] !== undefined) toks.push({ t: 's', v: m[2].replace(/""/g, '"') });
        else if (m[4] !== undefined) toks.push({ t: 'r', sh: m[3] ? m[3].slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'") : sn, c1: colNum(m[4]), r1: +m[5] - 1, c2: m[6] ? colNum(m[6]) : colNum(m[4]), r2: m[7] ? +m[7] - 1 : +m[5] - 1 });
        else if (m[8] !== undefined) toks.push({ t: 'f', v: m[8].toUpperCase() });
        else if (m[9] !== undefined) toks.push({ t: 'b', v: m[9] === 'TRUE' });
        else toks.push({ t: 'o', v: m[10] });
      }
      let i = 0;
      const nextOp = (...ops) => { const t = toks[i]; if (t && t.t === 'o' && ops.includes(t.v)) { i++; return t.v; } return null; };
      const flat = (x) => (Array.isArray(x) ? x : [x]);
      const numOf = (x) => { x = Array.isArray(x) ? x[0] : x; if (x === null || x === undefined || x === '') return 0; if (typeof x === 'boolean') return x ? 1 : 0; const n = +x; if (isNaN(n)) throw new Error('value'); return n; };
      const nums = (args) => args.flatMap(flat).filter((x) => typeof x === 'number');
      const FN = {
        SUM: (a) => nums(a).reduce((p, q) => p + q, 0), AVERAGE: (a) => { const n = nums(a); if (!n.length) throw new Error('div0'); return n.reduce((p, q) => p + q, 0) / n.length; },
        MIN: (a) => Math.min(...nums(a)), MAX: (a) => Math.max(...nums(a)), COUNT: (a) => nums(a).length, COUNTA: (a) => a.flatMap(flat).filter((x) => x !== null && x !== '').length,
        ROUND: (a) => { const d = Math.pow(10, numOf(a[1])); return Math.round(numOf(a[0]) * d) / d; }, ABS: (a) => Math.abs(numOf(a[0])), SQRT: (a) => Math.sqrt(numOf(a[0])), INT: (a) => Math.floor(numOf(a[0])),
        POWER: (a) => Math.pow(numOf(a[0]), numOf(a[1])), MOD: (a) => { const d = numOf(a[1]); return numOf(a[0]) - d * Math.floor(numOf(a[0]) / d); }, PRODUCT: (a) => nums(a).reduce((p, q) => p * q, 1),
        IF: (a) => (a[0] ? a[1] : (a.length > 2 ? a[2] : false)), AND: (a) => a.flatMap(flat).every(Boolean), OR: (a) => a.flatMap(flat).some(Boolean), NOT: (a) => !a[0],
        CONCATENATE: (a) => a.flatMap(flat).join(''), LEN: (a) => String(a[0]).length,
      };
      function primary() {
        const t = toks[i++]; if (!t) throw new Error('end');
        if (t.t === 'n' || t.t === 's' || t.t === 'b') return t.v;
        if (t.t === 'r') {
          if (t.c1 === t.c2 && t.r1 === t.r2) { const v = value(t.sh, XLSX.utils.encode_cell({ r: t.r1, c: t.c1 }), stack); return v === undefined ? null : v; }
          const out = []; for (let r = t.r1; r <= Math.min(t.r2, t.r1 + 5000); r++) for (let c = t.c1; c <= t.c2; c++) out.push(value(t.sh, XLSX.utils.encode_cell({ r, c }), stack)); return out;
        }
        if (t.t === 'f') {
          const args = []; if (!nextOp(')')) { do { args.push(cmp()); } while (nextOp(',', ';')); if (!nextOp(')')) throw new Error('paren'); }
          if (!FN[t.v]) throw new Error('fn ' + t.v); return FN[t.v](args);
        }
        if (t.t === 'o' && t.v === '(') { const v = cmp(); if (!nextOp(')')) throw new Error('paren'); return v; }
        if (t.t === 'o' && t.v === '-') return -numOf(power());
        if (t.t === 'o' && t.v === '+') return numOf(power());
        throw new Error('syntax');
      }
      function power() { let v = primary(); while (nextOp('%')) v = numOf(v) / 100; while (nextOp('^')) v = Math.pow(numOf(v), numOf(primary())); return v; }
      function mul() { let v = power(), o; while ((o = nextOp('*', '/'))) { const r = numOf(power()); if (o === '/' && r === 0) throw new Error('div0'); v = o === '*' ? numOf(v) * r : numOf(v) / r; } return v; }
      function add() { let v = mul(), o; while ((o = nextOp('+', '-'))) { const r = numOf(mul()); v = o === '+' ? numOf(v) + r : numOf(v) - r; } return v; }
      function cat() { let v = add(); while (nextOp('&')) { const r = add(); v = String(v == null ? '' : v) + String(r == null ? '' : r); } return v; }
      function cmp() { let v = cat(), o; while ((o = nextOp('=', '<>', '<', '>', '<=', '>='))) { const r = cat(); v = o === '=' ? v == r : o === '<>' ? v != r : o === '<' ? v < r : o === '>' ? v > r : o === '<=' ? v <= r : v >= r; } return v; }
      const out = cmp(); if (i < toks.length) throw new Error('extra'); return Array.isArray(out) ? out[0] : out;
    }
    let done = 0;
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      for (const k in ws) {
        const c = ws[k]; if (k[0] === '!' || !c || !c.f || c.v !== undefined) continue;
        try {
          const v = value(name, k, new Set());
          if (typeof v === 'number' && isFinite(v)) { c.v = v; c.t = 'n'; c.w = SSF ? SSF.format(c.z || 'General', v) : String(v); done++; }
          else if (typeof v === 'string') { c.v = v; c.t = 's'; c.w = v; done++; }
          else if (typeof v === 'boolean') { c.v = v; c.t = 'b'; c.w = v ? 'TRUE' : 'FALSE'; done++; }
        } catch (e) { /* leave empty */ }
      }
    }
    return done;
  }

  /* =====================================================================
     XLSX: conditional formatting (colour scales, data bars, "cell is" rules)
     ===================================================================== */
  const parseSqref = (sq) => (sq || '').split(/\s+/).filter(Boolean).map((r) => { const [a, b] = r.split(':'), p1 = colIndex(a), p2 = colIndex(b || a); return p1 && p2 ? { r0: p1.r, c0: p1.c, r1: p2.r, c1: p2.c } : null; }).filter(Boolean);
  function cfPrepare(rules, ws) {
    for (const rule of rules) {
      if (rule.vals) continue;
      const vals = [];
      for (const rg of rule.ranges) for (let r = rg.r0; r <= Math.min(rg.r1, rg.r0 + 5000); r++) for (let c = rg.c0; c <= Math.min(rg.c1, rg.c0 + 100); c++) { const cell = ws[XLSX.utils.encode_cell({ r, c })]; if (cell && typeof cell.v === 'number') vals.push(cell.v); }
      vals.sort((a, b) => a - b); rule.vals = vals;
      const at = (vo) => { if (!vals.length) return 0; const t = vo.type, v = num(vo.val, 0); if (t === 'num') return v; if (t === 'percent') return vals[0] + (vals[vals.length - 1] - vals[0]) * v / 100; if (t === 'percentile') return vals[Math.min(vals.length - 1, Math.floor(v / 100 * (vals.length - 1)))]; return t === 'max' ? vals[vals.length - 1] : vals[0]; };
      if (rule.cfvo) rule.pts = rule.cfvo.map(at);
    }
  }
  // The picture for one level of an icon set: a glyph and its colour (level 0 is the lowest)
  const ICON_COLORS = { 3: ['#d9534f', '#f0ad4e', '#3c9a5f'], 4: ['#d9534f', '#f0ad4e', '#b5c94a', '#3c9a5f'], 5: ['#d9534f', '#ee8b4a', '#f0ad4e', '#b5c94a', '#3c9a5f'] };
  function iconFor(set, lv, n) {
    const fam = String(set).replace(/^\d+/, ''), gray = /Gray|Black/.test(fam), col = gray ? ['#222', '#555', '#888', '#aaa', '#ccc'].slice(0, n).reverse()[lv] || '#666' : (ICON_COLORS[n] || ICON_COLORS[3])[Math.min(lv, (ICON_COLORS[n] || ICON_COLORS[3]).length - 1)];
    const pick = (list) => list[Math.round(lv * (list.length - 1) / Math.max(1, n - 1))];
    if (/Arrows/.test(fam)) return { glyph: pick(['▼', '◢', '▶', '◥', '▲']), color: col };
    if (/Triangles/.test(fam)) return { glyph: pick(['▼', '▬', '▲']), color: col };
    if (/Symbols/.test(fam)) return { glyph: pick(['✖', '❗', '✔']), color: col };
    if (/Flags/.test(fam)) return { glyph: '⚑', color: col };
    if (/Stars/.test(fam)) return { glyph: '★'.repeat(lv + 1) + '☆'.repeat(n - lv - 1), color: '#e0a800' };
    if (/Rating/.test(fam)) return { glyph: pick(['▁', '▃', '▅', '▆', '█']), color: '#555' };
    if (/Quarters/.test(fam)) return { glyph: pick(['○', '◔', '◑', '◕', '●']), color: '#555' };
    if (/Boxes/.test(fam)) return { glyph: pick(['▱', '▰']), color: '#555' };
    return { glyph: '●', color: col };                              // traffic lights, signs, red to black…
  }
  const mixHex = (a, b, t) => { const A = parseInt(a.slice(1), 16), B = parseInt(b.slice(1), 16), f = (s) => Math.round(((A >> s) & 255) * (1 - t) + ((B >> s) & 255) * t); return '#' + [16, 8, 0].map((s) => f(s).toString(16).padStart(2, '0')).join(''); };
  // returns { bg, color, bold, bar:{ color, pct } } or null for the cell at row r, column c
  function cfStyle(rules, ws, r, c) {
    if (!rules || !rules.length) return null;
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell || typeof cell.v !== 'number') return null;
    let out = null;
    for (const rule of rules) {
      if (!rule.ranges.some((g) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1)) continue;
      const v = cell.v;
      if (rule.type === 'colorScale' && rule.pts && rule.pts.length >= 2) {
        const P = rule.pts, C = rule.colors; let col;
        if (v <= P[0]) col = C[0]; else if (v >= P[P.length - 1]) col = C[C.length - 1];
        else { let k = 0; while (k < P.length - 2 && v > P[k + 1]) k++; col = mixHex(C[k], C[k + 1], P[k + 1] === P[k] ? 0 : (v - P[k]) / (P[k + 1] - P[k])); }
        (out = out || {}).bg = col;
      } else if (rule.type === 'dataBar' && rule.pts) {
        const lo = rule.pts[0], hi = rule.pts[1], pct = hi === lo ? 100 : Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
        (out = out || {}).bar = { color: rule.colors[0], pct };
      } else if (rule.type === 'iconSet' && rule.pts) {
        const n = rule.pts.length; let lv = 0;
        for (let k = 1; k < n; k++) if (v >= rule.pts[k]) lv = k;
        if (rule.reverse) lv = n - 1 - lv;
        (out = out || {}).icon = iconFor(rule.set, lv, n);
        if (rule.showValue === false) out.hideValue = true;
      } else if (rule.type === 'cellIs') {
        const a = rule.args, ok = { greaterThan: v > a[0], lessThan: v < a[0], equal: v === a[0], notEqual: v !== a[0], greaterThanOrEqual: v >= a[0], lessThanOrEqual: v <= a[0], between: v >= a[0] && v <= a[1], notBetween: v < a[0] || v > a[1] }[rule.op];
        if (ok && rule.dxf) out = Object.assign(out || {}, rule.dxf);
      }
    }
    return out;
  }

  return { chartSvg, shapesSvg, docxPrepare, xlsxDecor, themeColors, pptxDiagrams, pptxCharts, odfChartSvg, fillFormulas, cfPrepare, cfStyle };
})();
