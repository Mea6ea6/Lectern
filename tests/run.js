#!/usr/bin/env node
/* Runs the self-check page (Lectern.html#selftest) in headless Chromium and fails if any check fails.
     node tests/run.js            (needs:  npm i playwright   and a Chromium:  npx playwright install chromium)
   Options:  --shots DIR  saves a screenshot of the finished report. */
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/$/, '/Lectern.html'));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
});
(async () => {
  const { chromium } = require('playwright');
  await new Promise((ok) => server.listen(0, ok));
  const url = 'http://localhost:' + server.address().port + '/Lectern.html#selftest';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  let out;
  try { await page.waitForFunction(() => window.__selftest && window.__selftest.done, null, { timeout: 180000 }); out = await page.evaluate(() => window.__selftest); }
  catch (e) { console.error('The self-check did not finish.'); await browser.close(); server.close(); process.exit(2); }
  const i = process.argv.indexOf('--shots');
  if (i > 0) { fs.mkdirSync(process.argv[i + 1], { recursive: true }); await page.screenshot({ path: path.join(process.argv[i + 1], 'selftest.png') }); }
  for (const r of out.env) console.log((r.ok ? '  ok   ' : r.info ? '  no   ' : '  FAIL ') + r.name);
  for (const r of out.results) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.label.padEnd(44) + String(r.ms).padStart(6) + ' ms' + (r.note ? '  ' + r.note : ''));
  if (errors.length) { console.log('\nScript errors:'); errors.forEach((e) => console.log('  ' + e)); }
  await browser.close(); server.close();
  const failed = out.failed + errors.length;
  console.log('\n' + (failed ? failed + ' problem(s)' : 'All checks passed'));
  process.exit(failed ? 1 : 0);
})();
