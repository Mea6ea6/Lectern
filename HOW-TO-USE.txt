LECTERN (V.0.5) — offline viewer for presentations, PDFs, documents, spreadsheets, images and text
================================================================================================
================================================================================================
HOW TO USE
1. Put your files into the "Files" folder (or any folder on the drive).
2. Open "Lectern.html" on any computer (double-click). It opens in the browser, no installation, no internet.
3. Click "Choose folder" and pick the "Files" folder.
   - Chrome / Edge: a normal folder picker. The folder is remembered; use the refresh button to rescan
     after you copy new files to the drive.
   - Firefox: the browser asks "Upload files to this site?" — confirm (this is the browser's own dialog and cannot be disabled; dragging the folder into the window skips it). Nothing is uploaded anywhere.
   - You can also drag files or folders into the window.
4. Click a file (or select it and press Enter) to open it. Space (or the "i" button) shows file details. "Fullscreen" fills the screen; the buttons hide themselves.
================================================================================================
CONTROLS (viewer)
  Bottom bar    First / Previous / Next / Last, progress bar (click or drag to jump),
                Overview (all slides/pages as a grid), More (menu)
  More menu     Zoom, Fit (page / width), Rotate, Black screen, Keep screen on, Theme
  Fullscreen    Tap the left / right edge to turn pages, swipe left / right, tap the middle to show the buttons
  Keyboard      Right / Down / Space / Enter = next      Left / Up / Backspace = previous
                Home / End = first / last                G = overview        F = fullscreen
                B = black screen   W = white screen      R = rotate (Shift+R = left)
                + / - / 0 = zoom                         Esc = close menu / overview / viewer
================================================================================================
SUPPORTED FILES
  PPTX, PPSX (no animations or transitions)   PDF   DOCX (read-only)   XLSX, XLS, CSV
  PNG, JPG, GIF, WEBP, BMP, SVG, AVIF         TXT, MD, LOG (UTF-8 and Windows-1251)
  Old .ppt / .doc are not supported — re-save them as .pptx / .docx.
================================================================================================
FOLDER LAYOUT — keep it as is
  Lectern.html     the page you open
  app/            the program and its libraries (do not delete or rename)
  Files/          your files
================================================================================================
LICENSES
  PDF.js (Apache-2.0), docx-preview (Apache-2.0), pptx-preview (ISC), SheetJS fork @e965/xlsx (Apache-2.0),
  JSZip (MIT), Inter font (SIL OFL 1.1 — license text in app/fonts/).

V.0.4 CHANGES (earlier)
  Only the Swiss look remains (Soft style removed). File details window redesigned like "About This Mac".
  Key hints are drawn as keycaps with a soft shadow. Sort is a designed drop-down. The start card has a dashed
  outline (the only outline in the app). Side arrows have no background. All menu controls share one size.

V.0.5 CHANGES
  - Glass slider (Appearance menu and the viewer's More menu): left = frosted glass, right = solid panels.
    Backdrop, panels, bars, menus and dialogs follow it; the open document always sits on black.
  - Installable web app (PWA): works offline once opened from a web address. Chrome/Edge show an "Install" button;
    after installing, "Open with Lectern" works for PDF, PPTX, DOCX, XLSX, CSV, images and text files.
  - Libraries (PDF, Office, Excel) load only when a file needs them: the start page opens much faster.
  - Bars float over the page and the page scrolls under them (that is what the glass blurs).

PUBLISHING THE WEB VERSION (Vercel)
  1. Put this folder (Lectern.html, app/, icons/, manifest.webmanifest, sw.js, vercel.json, .vercelignore)
     into a GitHub repository. The Files folder is skipped automatically (.vercelignore).
  2. Vercel -> Add New Project -> import the repository. Framework: Other. No build command, output = root.
  3. Open the address in Chrome or Edge -> "Install". Safari: Share -> Add to Dock. Firefox can't install web apps
     on a computer, but the site still works offline after the first visit.
  4. After you change any file, run   python3 make-sw.py   once, so installed copies refresh themselves.
  The flash-drive version needs none of this: Lectern.html works as before.
