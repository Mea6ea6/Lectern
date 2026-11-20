/* ---------------------------------------------------------------------
   Office extras (loaded the first time a Word or Excel file is opened)

   The Word and Excel readers we use skip charts, shapes, SmartArt and (in Excel) cell colours and
   pictures. This file adds them from the original XML:
     - chartSvg()       draws a chart (bar, line, area, pie, doughnut, scatter) as an SVG picture
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
  const path = (el, ...names) => { for (const n of names) { el = kid(el, n); if (!el) return null; } return el; };
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
    const types = ['barChart', 'bar3DChart', 'lineChart', 'line3DChart', 'areaChart', 'area3DChart', 'pieChart', 'pie3DChart', 'doughnutChart', 'scatterChart', 'ofPieChart'];
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
      const kind = g.localName.replace('3D', '').replace('Chart', '');
      const grouping = attr(kid(g, 'grouping'), 'val', 'clustered');
      const dir = attr(kid(g, 'barDir'), 'val', 'col');
      const gap = num(attr(kid(g, 'gapWidth'), 'val'), 150);
      const labelsOn = attr(first(g, 'showVal'), 'val', '0') === '1' || attr(first(g, 'showVal'), 'val', '0') === 'true';
      const pctOn = attr(first(g, 'showPercent'), 'val', '0') === '1';
      kids(g, 'ser').forEach((s) => {
        const idx = sers.length, sp = kid(s, 'spPr');
        const name = readSeries(kid(s, 'tx'), resolve)[0] || ('Series ' + (idx + 1));
        const isXY = kind === 'scatter';
        const cat = readSeries(kid(s, isXY ? 'xVal' : 'cat'), resolve);
        const val = readSeries(kid(s, isXY ? 'yVal' : 'val'), resolve).map((v) => (v == null || v === '' ? null : num(v, null)));
        let color = fillOf(sp, theme);
        if (kind === 'line' || kind === 'scatter') { const ln = kid(sp, 'ln'); color = (ln && fillOf(ln, theme)) || color; }
        if (!color || color === 'none') color = PALETTE[idx % PALETTE.length];
        const dpt = {};
        kids(s, 'dPt').forEach((p) => { const c = fillOf(kid(p, 'spPr'), theme); if (c && c !== 'none') dpt[num(attr(kid(p, 'idx'), 'val'), 0)] = c; });
        const lnNode = kid(sp, 'ln'), noLine = lnNode && kid(lnNode, 'noFill');
        sers.push({ kind, grouping, dir, gap, name, cat, val, color, dpt, labels: labelsOn, pct: pctOn, group: gi, noLine, hole: num(attr(kid(g, 'holeSize'), 'val'), 55), style: attr(kid(g, 'scatterStyle'), 'val', ''), xs: isXY ? cat.map((c) => num(c, null)) : null });
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
    } else {
      // ---------------- cartesian: bar / line / area / scatter
      const isXY = kind0 === 'scatter', horiz = sers.some((s) => s.kind === 'bar' && s.dir === 'bar');
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
      sers.filter((s) => s.kind === 'line' || s.kind === 'scatter').forEach((s) => {
        const P = s.val.map((v, i) => (v == null ? null : pt(s, i))).filter(Boolean);
        const drawLine = s.kind === 'line' ? !s.noLine : (/line/i.test(s.style) && !s.noLine);
        if (drawLine && P.length > 1) parts.push('<path d="M' + P.map((p) => p.join(',')).join('L') + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" stroke-linejoin="round"/>');
        P.forEach((p, i) => parts.push('<circle cx="' + p[0] + '" cy="' + p[1] + '" r="' + (s.kind === 'scatter' ? 4.5 : 3.5) + '" fill="' + s.color + '"/>'));
        if (s.labels) s.val.forEach((v, i) => { if (v != null) { const p = pt(s, i); parts.push('<text x="' + p[0] + '" y="' + (p[1] - 8) + '" text-anchor="middle" font-size="' + fs + '" fill="#333" ' + font + '>' + esc(fmtNum(v)) + '</text>'); } });
      });
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
      for (const br of all(p, 'br')) { /* line breaks inside a paragraph */ text += '\n'; }
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
      xfs = all(kid(styles.documentElement, 'cellXfs'), 'xf').map((x) => {
        const al = kid(x, 'alignment'), f = fonts[num(x.getAttribute('fontId'), 0)] || {};
        return { bg: fills[num(x.getAttribute('fillId'), 0)] || null, bold: f.bold, italic: f.italic, color: f.color, h: al && al.getAttribute('horizontal'), v: al && al.getAttribute('vertical'), wrap: al && al.getAttribute('wrapText') === '1' };
      });
    }
    const out = {};
    for (const sh of all(wb, 'sheet')) {
      const name = sh.getAttribute('name'), rid = sh.getAttributeNS(NS.r, 'id') || sh.getAttribute('r:id'), spath = target(wrels, rid, 'xl/');
      const sf = spath && zip.file(spath);
      if (!sf) continue;
      const sx = parse(await sf.async('string')), info = { cells: new Map(), colW: {}, drawings: [] };
      for (const c of all(sx, 'c')) {
        const s = num(c.getAttribute('s'), 0), st = xfs[s];
        if (st && (st.bg || st.bold || st.italic || st.color || st.h || st.v || st.wrap)) { const p = colIndex(c.getAttribute('r')); if (p) info.cells.set(p.r + ':' + p.c, st); }
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
      let nid = 9000;
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
        parent.removeChild(gf); changed = true;
      }
      if (changed) zip.file(sn, new XMLSerializer().serializeToString(doc));
    }
    return changed;
  }

  return { chartSvg, shapesSvg, docxPrepare, xlsxDecor, themeColors, pptxDiagrams };
})();
