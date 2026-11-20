'use strict';
/* Lectern — when a file can't be opened.
   - sniffViewer(): looks at the first bytes of a file, so a file saved under the wrong extension (an .rtf called .doc, a .doc called
     .docx, a .docx called .doc…) still opens with the right viewer.
   - explainError(): turns whatever went wrong into a title and a sentence a student can understand.
   - saveCopy(): lets the person save the file, to open it in another program. */

// What a file really is, judging by its first bytes (only for the Office-like extensions that are often mixed up)
async function sniffViewer(entry) {
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  if (!['doc', 'docx', 'rtf', 'ppt', 'pps', 'pptx', 'ppsx'].includes(ext) || !entry.file || !entry.file.slice) return null;
  let b;
  try { b = new Uint8Array(await entry.file.slice(0, 8).arrayBuffer()); } catch (e) { return null; }
  const zip = b[0] === 0x50 && b[1] === 0x4B, cfb = b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0;
  const rtf = String.fromCharCode(...b.slice(0, 5)) === '{\\rtf', pdf = String.fromCharCode(...b.slice(0, 4)) === '%PDF';
  const word = ['doc', 'docx', 'rtf'].includes(ext);
  if (pdf) return { viewer: 'pdf', kind: 'pdf' };
  if (word) {
    if (rtf && ext !== 'rtf') return { viewer: 'rtf', kind: 'docx' };
    if (cfb && ext !== 'doc') return { viewer: 'doc', kind: 'docx' };
    if (zip && ext !== 'docx') return { viewer: 'docx', kind: 'docx' };
  } else {
    if (cfb && ext !== 'ppt' && ext !== 'pps') return { viewer: 'ppt', kind: 'pptx' };
    if (zip && (ext === 'ppt' || ext === 'pps')) return { viewer: 'pptx', kind: 'pptx' };
  }
  return null;
}

// [title, explanation] for the message in the viewer window
function explainError(err, entry) {
  if (err && err.friendly) return err.friendly;
  const text = String((err && (err.message || err.name)) || '');
  if (err && err.name === 'PasswordException') return ['This file is password-protected', 'Protected files can’t be opened here. Save an unprotected copy and try again.'];
  if (entry && entry.size === 0) return ['This file is empty', 'It has no content. It may not have finished copying — copy it again.'];
  if ((err && err.name === 'RangeError') || /memory|allocation|array buffer|too (large|big)/i.test(text))
    return ['This file is too big for this device', 'It needs more memory than is available. Close other tabs and try again, or use a computer.'];
  if (/end of central directory|zip|corrupt|invalid (pdf|file)|bad |unexpected end|truncated|not a valid|unsupported (file|format)|can.t find end/i.test(text))
    return ['This file is damaged', 'It looks incomplete or broken — maybe it was not copied fully. Copy it again, or open it in its own program and save it once more.'];
  if (/network|fetch|failed to load|load failed/i.test(text)) return ['Part of the viewer could not be loaded', 'Check that the whole Lectern folder was copied, then try again.'];
  return ['Could not open this file', 'It may be damaged or saved in an unusual format. Try re-saving it and opening it again.'];
}

// Downloads the original file (so it can be opened in another program)
function saveCopy(entry) {
  if (!entry || !entry.file) return;
  const url = URL.createObjectURL(entry.file);
  const a = h('a'); a.href = url; a.download = entry.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
