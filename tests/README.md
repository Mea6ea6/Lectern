# Tests

`node tests/run.js` serves the app, opens `Lectern.html#selftest` in headless Chromium and fails if any format does not open or a script error appears (`--shots DIR` saves a screenshot). It needs `npm i playwright`.

- `fixtures/` — one small sample per format (including a damaged and an empty file that must be refused politely).
- `build-selftest-data.py` — packs the fixtures into `app/modules/selftest-data.js` so the same check works from a flash drive. Run it after changing a fixture.
- The checks themselves are listed at the top of `app/modules/selftest.js` (what must open and what text or element must appear).
