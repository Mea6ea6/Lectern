'use strict';
/* Lectern — Start-up.  One of the app/*.js files that Lectern.html loads in this order:
   core.js, drive.js, errors.js, list.js, queue.js, thumbs.js, viewers.js, viewer-ui.js, viewer-queue.js, viewer-timer.js, viewer-input.js, extras.js, link.js, presenter.js, companion.js, start.js. They are plain scripts that share one global scope
   (no modules, so it also works from a file:// address on a flash drive). The map of everything is at the top of core.js. */

/* ----- Start ----- */
// After a mouse click a button gives up the focus, so Space / Enter keep working on the selected file
$('home').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) b.blur(); });

/* ----- Double-clicking a file in Explorer / Finder (installed app, Chrome/Edge): "Open with Lectern" ----- */
if ('launchQueue' in window) {
  launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const files = [];
    for (const handle of params.files) files.push(await handle.getFile());
    addFiles(files, false);
    if (files.length === 1) {
      const entry = state.files.find((e) => e.file === files[0]) || state.files.find((e) => e.name === files[0].name);
      if (entry) openViewer(entry);                // one file: straight to the viewer
    }
  });
}

syncAppearanceUI();
render();
restoreFolder();

