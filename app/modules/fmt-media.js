'use strict';
/* Lectern — video and audio (the tiny player, tags, subtitles). Loaded on demand (see VIEWER_LIB in core.js); shares the global scope with the app scripts and fmt-common.js. */

/* ---------------------------------------------------------------------
   2. VIDEO AND AUDIO
   The player is deliberately tiny: play / pause and 5 seconds back or forward.
   The buttons live in the viewer bar (viewer-ui.js); this class only runs the media element.
   --------------------------------------------------------------------- */

// Loads just enough of a media file to know its length and picture size
function probeMedia(file, wantVideo) {
  return new Promise((ok) => {
    const el = document.createElement(wantVideo ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    const done = (info) => { clearTimeout(timer); el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); ok(info); };
    const timer = setTimeout(() => done(null), 6000);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => done({ duration: el.duration, width: el.videoWidth || 0, height: el.videoHeight || 0, el });
    el.onerror = () => done(null);
    el.src = url;
  });
}

/* ----- Tags and cover pictures of audio files (MP3: ID3v2, FLAC, M4A) -----
   Only the first part of the file is read; anything unusual simply gives "no tags". */
const be32 = (u, o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
const le32 = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;
const synsafe = (u, o) => (u[o] << 21) | (u[o + 1] << 14) | (u[o + 2] << 7) | u[o + 3];
const ascii = (u, a, b) => String.fromCharCode(...u.subarray(a, b));
const readBytes = async (file, from, to) => new Uint8Array(await file.slice(from, to).arrayBuffer());
const trimNul = (t) => t.replace(/\u0000+$/, '').replace(/^﻿/, '').trim();
// Text of unknown encoding: UTF-8 if it is valid, otherwise (old Russian tags) Windows-1251
function guessText(u) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch (e) { return new TextDecoder('windows-1251').decode(u); }
}
function id3Text(u) {
  if (!u.length) return '';
  const enc = u[0], b = u.subarray(1);
  if (enc === 1 || enc === 2) {
    let off = 0, le = false;
    if (b[0] === 0xFF && b[1] === 0xFE) { off = 2; le = true; } else if (b[0] === 0xFE && b[1] === 0xFF) off = 2; else le = enc === 1;
    return trimNul(new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(b.subarray(off)));
  }
  return trimNul(enc === 3 ? new TextDecoder('utf-8').decode(b) : guessText(b));
}
const picType = (data, mime) => (/png/i.test(mime) || (data[0] === 0x89 && data[1] === 0x50) ? 'image/png' : 'image/jpeg');
const picBlob = (data) => new Blob([data], { type: picType(data, '') });

async function id3Tags(file) {
  const head = await readBytes(file, 0, 10);
  if (ascii(head, 0, 3) !== 'ID3' || head[3] < 3) return null;
  const ver = head[3];
  const u = await readBytes(file, 10, 10 + Math.min(synsafe(head, 6), 12e6));
  const out = {};
  let o = (head[5] & 0x40) ? (ver === 4 ? synsafe(u, 0) : be32(u, 0) + 4) : 0;       // skip an extended header
  while (o + 10 <= u.length) {
    const id = ascii(u, o, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = ver === 4 ? synsafe(u, o + 4) : be32(u, o + 4);
    const body = u.subarray(o + 10, o + 10 + size);
    o += 10 + size;
    if (id === 'TIT2') out.title = id3Text(body);
    else if (id === 'TPE1') out.artist = id3Text(body);
    else if (id === 'TALB') out.album = id3Text(body);
    else if (id === 'APIC' && !out.cover && body.length > 20) {
      const enc = body[0];
      let i = 1;
      while (i < body.length && body[i] !== 0) i++;                       // the picture type text, ends with a zero
      const mime = ascii(body, 1, i);
      i += 2;                                                            // the zero and the picture kind
      if (enc === 1 || enc === 2) { while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) i += 2; i += 2; }
      else { while (i < body.length && body[i] !== 0) i++; i += 1; }     // the description
      const data = body.subarray(i);
      if (data.length > 100) out.cover = new Blob([data], { type: picType(data, mime) });
    }
  }
  return out;
}

async function flacTags(file) {
  const u = await readBytes(file, 0, 6e6);
  if (ascii(u, 0, 4) !== 'fLaC') return null;
  const out = {};
  let o = 4;
  while (o + 4 <= u.length) {
    const last = u[o] & 0x80, type = u[o] & 0x7f, len = (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3];
    o += 4;
    const b = u.subarray(o, o + len);
    o += len;
    if (type === 4) {                                                    // text tags
      let p = 4 + le32(b, 0);
      const n = le32(b, p); p += 4;
      for (let i = 0; i < n && p + 4 <= b.length; i++) {
        const l = le32(b, p); p += 4;
        const txt = new TextDecoder('utf-8').decode(b.subarray(p, p + l)); p += l;
        const eq = txt.indexOf('=');
        const key = txt.slice(0, eq).toUpperCase(), val = txt.slice(eq + 1);
        if (key === 'TITLE') out.title = val; else if (key === 'ARTIST') out.artist = val; else if (key === 'ALBUM') out.album = val;
      }
    } else if (type === 6 && !out.cover && b.length > 40) {              // cover picture
      let p = 4;
      p += 4 + be32(b, p);                                               // the mime type
      p += 4 + be32(b, p);                                               // the description
      p += 16;                                                           // width, height, depth, colours
      const n = be32(b, p); p += 4;
      out.cover = picBlob(b.subarray(p, p + n));
    }
    if (last) break;
  }
  return out;
}

function* boxList(u, a, b) {
  let o = a;
  while (o + 8 <= b) {
    const len = be32(u, o);
    if (len < 8) return;
    yield { type: ascii(u, o + 4, o + 8), a: o + 8, b: Math.min(o + len, b) };
    o += len;
  }
}
async function mp4Tags(file) {
  let pos = 0;
  while (pos + 8 <= file.size) {
    const h8 = await readBytes(file, pos, pos + 16);
    let len = be32(h8, 0), hdr = 8;
    if (len === 1) { len = be32(h8, 8) * 4294967296 + be32(h8, 12); hdr = 16; } else if (len === 0) len = file.size - pos;
    if (len < 8) return null;
    if (ascii(h8, 4, 8) === 'moov') {
      if (len > 40e6) return null;
      const u = await readBytes(file, pos + hdr, pos + len), out = {};
      for (const udta of boxList(u, 0, u.length)) if (udta.type === 'udta')
        for (const meta of boxList(u, udta.a, udta.b)) if (meta.type === 'meta')
          for (const ilst of boxList(u, meta.a + 4, meta.b)) if (ilst.type === 'ilst')
            for (const item of boxList(u, ilst.a, ilst.b)) for (const d of boxList(u, item.a, item.b)) if (d.type === 'data') {
              const payload = u.subarray(d.a + 8, d.b);
              if (item.type === '©nam') out.title = new TextDecoder('utf-8').decode(payload);
              else if (item.type === '©ART') out.artist = new TextDecoder('utf-8').decode(payload);
              else if (item.type === '©alb') out.album = new TextDecoder('utf-8').decode(payload);
              else if (item.type === 'covr') out.cover = picBlob(payload);
            }
      return out;
    }
    pos += len;
  }
  return null;
}

// {title, artist, album, cover (a Blob)} or null. Remembered on the entry.
function readAudioTags(entry) {
  if (!entry._tags) {
    const read = entry.ext === 'mp3' ? id3Tags : entry.ext === 'flac' ? flacTags : entry.ext === 'm4a' ? mp4Tags : null;
    entry._tags = (read ? read(entry.file) : Promise.resolve(null)).catch(() => null);
  }
  return entry._tags;
}

/* ----- Subtitles: .srt or .vtt; a text file of unknown encoding is read as UTF-8, or else as Windows-1251 ----- */
async function subtitleVtt(file) {
  const text = guessText(new Uint8Array(await file.arrayBuffer())).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (/^WEBVTT/.test(text)) return text;
  return 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// What to tell when the browser cannot play a file: the real reason is usually the container or the codec
function playHint(entry, video) {
  const ext = entry ? entry.ext : '';
  const ff = /firefox/i.test(navigator.userAgent), safari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  if (ext === 'mkv') return (ff || safari ? 'This browser does not play MKV files. ' : 'This MKV uses a codec the browser lacks. ') + 'Chrome or Edge play most of them; or convert the file to MP4 (H.264).';
  if (ext === 'mov' || ext === 'm4v') return 'The file uses a codec this browser lacks (often HEVC). Try Edge or Safari, or convert it to MP4 (H.264).';
  if (ext === 'flac' || ext === 'ogg' || ext === 'opus' || ext === 'oga') return safari ? 'Safari plays only some of these. Try Chrome, Edge or Firefox, or convert the file to MP3.' : 'The file may be damaged. Try another browser, or convert it to MP3.';
  return video ? 'The picture or sound uses a format this browser does not support. Try Chrome or Edge, or convert the file to MP4 (H.264).' : 'The sound uses a format this browser does not support. Try Chrome or Edge, or convert the file to MP3.';
}

class MediaViewer extends BaseViewer {
  constructor(...args) {
    super(...args);
    this.isMedia = true;
    this.canDraw = false;
    this.frame = 1 / 30;               // one video frame, measured while it plays
    this.hasSubs = false;
    this.onEnded = null;
  }

  async open(file) {
    this.url = URL.createObjectURL(file);
    const wantVideo = this.entry && this.entry.kind === 'video';
    const el = document.createElement(wantVideo ? 'video' : 'audio');
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    el.volume = clamp(parseFloat(loadPref('fv-vol', '1')) || 0, 0, 1);
    el.muted = loadPref('fv-muted', '0') === '1';
    this.el = el;

    await new Promise((ok, fail) => {
      el.onloadedmetadata = ok;
      el.onerror = () => fail(friendly('This browser can’t play this file', playHint(this.entry, wantVideo)));
      el.src = this.url;
    });
    el.onerror = null;

    // A video file without a picture (sound only) is shown like audio
    this.hasPicture = wantVideo && el.videoWidth > 0;
    this.canDraw = this.hasPicture;                          // the pen works on a paused picture
    ['timeupdate', 'play', 'pause', 'ended', 'seeked', 'durationchange', 'volumechange', 'ratechange', 'enterpictureinpicture', 'leavepictureinpicture'].forEach((ev) => el.addEventListener(ev, () => this.onChange()));
    el.addEventListener('ended', () => { if (this.onEnded) this.onEnded(); });
    if (this.hasPicture && el.requestVideoFrameCallback) {   // how long is one frame? (for stepping frame by frame)
      el.addEventListener('playing', () => {
        let last = null, n = 0, best = 1;
        const cb = (now, meta) => {
          if (last !== null && meta.mediaTime > last) best = Math.min(best, meta.mediaTime - last);
          last = meta.mediaTime;
          if (++n < 6 && !el.paused) el.requestVideoFrameCallback(cb); else if (best < 0.2) this.frame = best;
        };
        el.requestVideoFrameCallback(cb);
      }, { once: true });
    }

    if (this.hasPicture) {
      el.className = 'media-video';
      this.put(el);
      this.refit();
      const subs = subsFor(this.entry);
      if (subs.length) this.setSubtitles(subs[0]).catch(() => { /* a broken subtitle file is ignored */ });
    } else {
      const tags = wantVideo ? null : await readAudioTags(this.entry);
      const box = h('div', 'media-audio');
      if (tags && tags.cover) {
        const img = h('img', 'media-cover');
        img.alt = '';
        img.src = this.coverUrl = URL.createObjectURL(tags.cover);
        box.appendChild(img);
      } else box.appendChild(icon('i-music'));
      const sub = tags ? [tags.artist, tags.album].filter(Boolean).join(' · ') : '';
      box.append(h('div', 'media-title', (tags && tags.title) || (this.entry ? this.entry.base : '')), h('div', 'media-sub', sub || (wantVideo ? 'Sound only. No picture? Try Chrome or Edge.' : 'Audio')));
      this.put(box);
    }
  }

  get playing() { return !!this.el && !this.el.paused && !this.el.ended; }
  toggle() {
    const el = this.el;
    if (!el) return;
    if (el.paused || el.ended) {
      if (el.ended) el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => { /* the browser said no (no click yet): the big button stays */ });
    } else el.pause();
  }
  skip(sec) {
    const el = this.el;
    if (!el) return;
    const end = isFinite(el.duration) ? el.duration : Infinity;
    el.currentTime = clamp(el.currentTime + sec, 0, end);
  }
  seek(ratio) { const d = this.el && this.el.duration; if (d > 0 && isFinite(d)) this.el.currentTime = clamp(ratio, 0, 1) * d; }
  labelAt(ratio) { return fmtTime(clamp(ratio, 0, 1) * (this.el.duration || 0)); }
  stepFrame(dir) {                                           // one picture forward / back (pauses first)
    if (!this.hasPicture) return;
    this.el.pause();
    this.el.currentTime = clamp(this.el.currentTime + dir * this.frame, 0, this.el.duration || 0);
  }

  get volume() { return this.el.volume; }
  get muted() { return this.el.muted || this.el.volume === 0; }
  setVolume(v) {
    v = clamp(v, 0, 1);
    this.el.volume = v;
    this.el.muted = v === 0;
    savePref('fv-vol', String(v)); savePref('fv-muted', v === 0 ? '1' : '0');
  }
  setMuted(m) {
    if (!m && this.el.volume === 0) this.el.volume = 0.5;
    this.el.muted = m; savePref('fv-muted', m ? '1' : '0');
    if (!m) savePref('fv-vol', String(this.el.volume));
  }
  // Picture in picture: a small floating window (Chrome, Edge, Safari; Firefox has its own button on the video)
  get canPip() { return this.hasPicture && !!document.pictureInPictureEnabled && !!this.el.requestPictureInPicture && !this.el.disablePictureInPicture; }
  get pip() { return document.pictureInPictureElement === this.el; }
  async togglePip() {
    try { if (this.pip) await document.exitPictureInPicture(); else await this.el.requestPictureInPicture(); } catch (e) { /* the browser said no */ }
    this.onChange();
  }
  // Several sound tracks (dubbing / original): only where the browser shows them
  get audioTracks() { const t = this.el && this.el.audioTracks; return t && t.length > 1 ? Array.from(t) : []; }
  get audioTrackIndex() { return Math.max(0, this.audioTracks.findIndex((t) => t.enabled)); }
  audioTrackName(i) { const t = this.audioTracks[i]; return t ? (t.label || (t.language ? t.language.toUpperCase() : '') || 'Track ' + (i + 1)) : ''; }
  nextAudioTrack() {
    const list = this.audioTracks;
    if (list.length < 2) return;
    const to = (this.audioTrackIndex + 1) % list.length;
    list.forEach((t, i) => { t.enabled = i === to; });
    this.onChange();
  }
  get rate() { return this.el.playbackRate; }
  setRate(r) { this.el.playbackRate = clamp(r, 0.25, 2); }
  get loop() { return this.el.loop; }
  setLoop(on) { this.el.loop = !!on; }

  async setSubtitles(file) {
    const vtt = await subtitleVtt(file);
    if (!this.el) return;
    if (this.trackEl) { this.trackEl.remove(); URL.revokeObjectURL(this.trackUrl); }
    this.trackUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    const tr = document.createElement('track');
    tr.kind = 'subtitles'; tr.label = file.name; tr.src = this.trackUrl;
    this.el.appendChild(tr);
    tr.track.mode = 'showing';
    this.trackEl = tr;
    this.hasSubs = true;
    this.onChange();
  }
  get subsOn() { return !!this.trackEl && this.trackEl.track.mode === 'showing'; }
  setSubsOn(on) { if (this.trackEl) { this.trackEl.track.mode = on ? 'showing' : 'hidden'; this.onChange(); } }

  // The pen draws on one still picture: a different moment of the video is a different "page"
  inkKey() { return 'v' + Math.round((this.el ? this.el.currentTime : 0) * 20); }
  inkAnchor() { return this.el; }

  label() { return fmtTime(this.el.currentTime) + ' / ' + fmtTime(this.el.duration); }
  progress() { const d = this.el.duration; return d > 0 && isFinite(d) ? this.el.currentTime / d : 0; }
  atStart() { return this.el.currentTime < 0.05; }
  atEnd() { return this.el.ended || this.el.currentTime >= (this.el.duration || 0) - 0.05; }

  refit() {
    if (!this.hasPicture) return;
    const vw = this.el.videoWidth, vh = this.el.videoHeight;
    const free = this.free();
    const s = Math.min(free.w / vw, free.h / vh);
    this.el.style.width = Math.floor(vw * s) + 'px';
    this.el.style.height = Math.floor(vh * s) + 'px';
  }

  destroy() {
    if (this.el && this.pip) { try { document.exitPictureInPicture().catch(() => {}); } catch (e) { /* fine */ } }
    if (this.el) { try { this.el.pause(); } catch (e) { /* fine */ } this.el.removeAttribute('src'); this.el.load(); }
    if (this.url) URL.revokeObjectURL(this.url);
    if (this.trackUrl) URL.revokeObjectURL(this.trackUrl);
    if (this.coverUrl) URL.revokeObjectURL(this.coverUrl);
    super.destroy();
  }

  /* ----- card picture: the first frame of a video, the cover of a song, a note for the rest ----- */
  static async thumb(entry) {
    const video = entry.kind === 'video';
    const info = await probeMedia(entry.file, video);
    entry.duration = info ? info.duration : 0;
    if (video && info && info.width) {
      try { entry.thumbNode = await videoFrame(entry.file, info); return; } catch (e) { /* use the placeholder */ }
    }
    const box = snippetNode('', '', 'media-snip');
    const tags = video ? null : await readAudioTags(entry);
    if (tags && tags.cover) {
      box.classList.add('has-cover');
      const img = new Image();
      img.alt = ''; img.src = URL.createObjectURL(tags.cover);
      box.appendChild(img);
    } else box.appendChild(icon(video ? 'i-play' : 'i-music'));
    box.appendChild(h('span', 'media-dur', info ? fmtTime(info.duration) : (video ? 'Video' : 'Audio')));
    entry.thumbNode = box;
  }

  static async details(entry, add) {
    const video = entry.kind === 'video';
    const info = await probeMedia(entry.file, video);
    if (!info) { add('Playback', 'This browser can’t read this file'); return; }
    const tags = video ? null : await readAudioTags(entry);
    if (tags && tags.title) add('Title', tags.title);
    if (tags && tags.artist) add('Artist', tags.artist);
    if (tags && tags.album) add('Album', tags.album);
    add('Duration', fmtTime(info.duration));
    if (info.width) add('Picture', info.width + ' × ' + info.height + ' px');
  }
}

// One picture from the video (a second in, or a tenth of the way)
function videoFrame(file, info) {
  return new Promise((ok, fail) => {
    const el = document.createElement('video');
    const url = URL.createObjectURL(file);
    const end = (fn, val) => { clearTimeout(timer); el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); fn(val); };
    const timer = setTimeout(() => end(fail, new Error('timeout')), 8000);
    el.muted = true; el.preload = 'auto';
    el.onerror = () => end(fail, new Error('decode'));
    el.onloadeddata = () => { el.currentTime = Math.min(1, (info.duration || 0) / 10) || 0; };
    el.onseeked = () => {
      const w = 420, hh = Math.round(w * el.videoHeight / el.videoWidth);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = hh;
      canvas.getContext('2d').drawImage(el, 0, 0, w, hh);
      end(ok, canvas);
    };
    el.src = url;
  });
}

Object.assign(VIEWER_CLASSES, { media: MediaViewer });
