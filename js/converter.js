/**
 * Link to library.
 *
 * Two paths, tried in order:
 *
 *  1. Direct fetch. If the URL points straight at a media file and the host
 *     allows cross-origin reads, the phone downloads it on its own and nothing
 *     else is needed. Costs nothing and never re-encodes.
 *
 *  2. Converter server. Anything else goes to the server configured in
 *     Settings, which resolves the page, picks the best audio and streams it
 *     back. See server/README.md.
 *
 * The default quality is "original": whatever the source already is gets kept
 * byte for byte where the container allows. Re-encoding to MP3 is opt-in,
 * because every re-encode of already-lossy audio loses more.
 */

import { library } from './library.js';

const DIRECT_MEDIA = /\.(mp3|m4a|aac|wav|flac|ogg|opus|oga|aiff?|mp4|m4v|mov|webm)(\?|#|$)/i;

export const QUALITY = {
  original: { label: 'Original (no re-encode)', hint: 'Best quality. Keeps the source codec.' },
  mp3_320: { label: 'MP3 320 kbps', hint: 'Widest compatibility. Re-encodes.' },
  mp3_v0: { label: 'MP3 V0 (VBR ~245 kbps)', hint: 'Smaller than 320 at similar quality.' },
  m4a_256: { label: 'AAC 256 kbps (.m4a)', hint: 'Apple native. Re-encodes.' },
};

export class ConverterError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ConverterError';
    this.hint = hint || '';
  }
}

export function looksLikeDirectMedia(url) {
  try {
    return DIRECT_MEDIA.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isSpotify(url) {
  try { return /(^|\.)spotify\.com$/.test(new URL(url).hostname); } catch { return false; }
}

/** Normalise whatever the user pasted into a usable URL, or null. */
export function normaliseUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export class Converter {
  constructor(settings) {
    this.settings = settings; // { serverUrl, serverToken }
  }

  get hasServer() {
    return !!(this.settings.serverUrl || '').trim();
  }

  _endpoint(path) {
    const base = (this.settings.serverUrl || '').trim().replace(/\/+$/, '');
    return base + path;
  }

  _headers(extra = {}) {
    const headers = { ...extra };
    const token = (this.settings.serverToken || '').trim();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  /**
   * Look at a URL and report what is behind it without downloading audio.
   * @returns {Promise<{type:'track'|'playlist', items:Array}>}
   */
  async resolve(url) {
    if (isSpotify(url) && !this.hasServer) {
      throw new ConverterError(
        'Spotify links need the converter server.',
        'Spotify audio is encrypted and cannot be converted. The server reads the '
        + 'track list from the link and finds each song from an unencrypted source instead.',
      );
    }

    if (looksLikeDirectMedia(url)) {
      const head = await this._probeDirect(url);
      if (head) return { type: 'track', items: [head] };
    }

    if (!this.hasServer) {
      throw new ConverterError(
        'That link needs the converter server.',
        'Only links that point straight at a media file work without one. '
        + 'Add a server URL in Settings, or paste a direct .mp3 or .mp4 link.',
      );
    }

    const response = await this._post('/api/resolve', { url });
    return response;
  }

  /** HEAD the URL to confirm it is media and learn its size, if CORS allows. */
  async _probeDirect(url) {
    try {
      const res = await fetch(url, { method: 'HEAD', mode: 'cors' });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') || '';
      if (type && !/^(audio|video|application\/octet-stream)/.test(type)) return null;
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download');
      return {
        id: url,
        title: name.replace(/\.[^.]+$/, '').replace(/[_+]/g, ' '),
        artist: new URL(url).hostname.replace(/^www\./, ''),
        duration: 0,
        thumbnail: '',
        webpageUrl: url,
        size: parseInt(res.headers.get('content-length') || '0', 10),
        direct: true,
      };
    } catch {
      // A CORS rejection here is normal and just means the server path is used.
      return null;
    }
  }

  /**
   * Fetch one item and add it to the library.
   * @param {object} item from resolve()
   * @param {object} options { quality, liked, onProgress(loaded,total) }
   */
  async fetchToLibrary(item, options = {}) {
    const quality = options.quality || 'original';
    const onProgress = options.onProgress || (() => {});

    const { blob, filename, meta } = item.direct
      ? await this._downloadDirect(item, onProgress)
      : await this._downloadViaServer(item, quality, onProgress);

    if (!blob || blob.size === 0) {
      throw new ConverterError('The download came back empty.');
    }

    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    const track = await library.importFile(file, {
      liked: options.liked !== false,
      source: item.direct ? 'link' : 'converter',
      sourceUrl: item.webpageUrl || item.id,
      title: meta.title || item.title,
      artist: meta.artist || item.artist,
      album: meta.album || '',
    });

    // The remote thumbnail is better than nothing when the file has no art.
    if (track && !track.artworkKey && item.thumbnail) {
      try {
        const art = await fetch(item.thumbnail, { mode: 'cors' }).then((r) => (r.ok ? r.blob() : null));
        if (art && art.size) await library.setArtwork(track.id, art);
      } catch { /* thumbnails are best effort */ }
    }

    return track;
  }

  async _downloadDirect(item, onProgress) {
    const res = await fetch(item.webpageUrl, { mode: 'cors' });
    if (!res.ok) throw new ConverterError('The link returned ' + res.status + ' ' + res.statusText);
    const total = parseInt(res.headers.get('content-length') || '0', 10);
    const blob = await readWithProgress(res, total, onProgress);
    const name = decodeURIComponent(new URL(item.webpageUrl).pathname.split('/').pop() || 'download');
    return { blob, filename: name || 'download', meta: {} };
  }

  async _downloadViaServer(item, quality, onProgress) {
    const res = await fetch(this._endpoint('/api/convert'), {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url: item.webpageUrl || item.id, quality }),
    });

    if (!res.ok) throw await serverError(res);

    const total = parseInt(res.headers.get('content-length') || '0', 10);
    const meta = {
      title: decodeHeader(res.headers.get('x-media-title')),
      artist: decodeHeader(res.headers.get('x-media-artist')),
      album: decodeHeader(res.headers.get('x-media-album')),
    };
    const filename = decodeHeader(res.headers.get('x-media-filename'))
      || safeName((meta.title || item.title || 'track') + '.' + extFor(quality));

    const blob = await readWithProgress(res, total, onProgress);
    return { blob, filename, meta };
  }

  async _post(path, body) {
    let res;
    try {
      res = await fetch(this._endpoint(path), {
        method: 'POST',
        headers: this._headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ConverterError(
        'Could not reach the converter server.',
        'Check the server URL in Settings and that the server is running. '
        + 'It must be served over HTTPS for this app to call it.',
      );
    }
    if (!res.ok) throw await serverError(res);
    return res.json();
  }

  async ping() {
    if (!this.hasServer) return { ok: false, reason: 'No server configured.' };
    try {
      const res = await fetch(this._endpoint('/api/health'), { headers: this._headers() });
      if (!res.ok) return { ok: false, reason: 'Server answered ' + res.status + '.' };
      const info = await res.json();
      return { ok: true, info };
    } catch {
      return { ok: false, reason: 'No response. Check the URL and that the server uses HTTPS.' };
    }
  }
}

/* -------------------------------------------------------------- utilities */

async function readWithProgress(res, total, onProgress) {
  if (!res.body || !res.body.getReader) return res.blob();

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const type = res.headers.get('content-type') || '';
  return new Blob(chunks, { type: type.split(';')[0] });
}

async function serverError(res) {
  let message = 'The server returned ' + res.status + '.';
  let hint = '';
  try {
    const body = await res.json();
    if (body.error) message = body.error;
    if (body.hint) hint = body.hint;
  } catch { /* non JSON error body */ }
  if (res.status === 401 || res.status === 403) {
    hint = hint || 'Check the access token in Settings matches the one the server was started with.';
  }
  return new ConverterError(message, hint);
}

/** Headers are latin1 on the wire, so the server sends them base64 encoded. */
function decodeHeader(value) {
  if (!value) return '';
  try {
    const bin = atob(value);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

function extFor(quality) {
  if (quality === 'mp3_320' || quality === 'mp3_v0') return 'mp3';
  if (quality === 'm4a_256') return 'm4a';
  return 'm4a';
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
}
