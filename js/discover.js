/**
 * Online discovery.
 *
 * Searches the Internet Archive's audio collections, which need no API key
 * and state their licence per item. Only items the Archive itself serves as
 * downloadable are offered; anything access-restricted is shown but not
 * offered for download.
 *
 * Quality is read from the files the source actually has. Nothing is ever
 * labelled better than what is there.
 */

import { library } from './library.js';

const SEARCH = 'https://archive.org/advancedsearch.php';
const META = 'https://archive.org/metadata/';
const DOWNLOAD = 'https://archive.org/download/';
const THUMB = 'https://archive.org/services/img/';

const AUDIO_FORMATS = /^(flac|24bit flac|wave|aiff|vbr mp3|mp3|128kbps mp3|256kbps mp3|320kbps mp3|ogg vorbis|opus|apple lossless audio)$/i;

export class DiscoverError extends Error {}

/** Rank a file by how good it actually is, so "best" means something. */
function gradeFile(file) {
  const format = String(file.format || '').toLowerCase();
  const bits = Number(file['audio-bits-per-sample'] || 0);
  const rate = Number(file['audio-sample-rate'] || 0);

  if (/24bit flac/.test(format) || (/flac/.test(format) && (bits > 16 || rate > 48000))) {
    return { rank: 5, tier: 'hi-res', label: 'Hi-Res FLAC' + (bits && rate ? ' ' + bits + '/' + Math.round(rate / 1000) : '') };
  }
  if (/flac/.test(format)) return { rank: 4, tier: 'lossless', label: 'FLAC lossless' };
  if (/apple lossless/.test(format)) return { rank: 4, tier: 'lossless', label: 'ALAC lossless' };
  if (/wave|aiff/.test(format)) return { rank: 4, tier: 'lossless', label: format.toUpperCase() + ' uncompressed' };
  if (/320kbps mp3/.test(format)) return { rank: 3, tier: 'standard', label: 'MP3 320' };
  if (/256kbps mp3/.test(format)) return { rank: 3, tier: 'standard', label: 'MP3 256' };
  if (/vbr mp3/.test(format)) return { rank: 2, tier: 'standard', label: 'MP3 VBR' };
  if (/ogg|opus/.test(format)) return { rank: 2, tier: 'standard', label: format.replace(/\b\w/g, (c) => c.toUpperCase()) };
  if (/mp3/.test(format)) return { rank: 1, tier: 'compressed', label: 'MP3 128' };
  return { rank: 0, tier: 'compressed', label: format || 'Unknown' };
}

/**
 * How long to wait for the archive before giving up.
 *
 * A dead network usually fails fast, but a captive portal or a proxy that
 * accepts the connection and then says nothing does not fail at all, and a
 * spinner that never ends is worse than an error.
 */
export const PATIENCE = 12000;

async function getJson(url, signal, patience = PATIENCE) {
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new DiscoverError('timeout')), patience);
  const stop = () => clock.abort(new DiscoverError('cancelled'));
  if (signal) signal.addEventListener('abort', stop, { once: true });

  let res;
  try {
    res = await fetch(url, { signal: clock.signal, mode: 'cors' });
  } catch (err) {
    // The caller's own abort still has to read as an abort; ours is a timeout.
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (clock.signal.aborted) throw new DiscoverError('The archive did not answer. Try again in a moment.');
    throw new DiscoverError('Could not reach the archive. Check your connection.');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
  }
  if (!res.ok) throw new DiscoverError('The archive answered ' + res.status + '.');
  return res.json();
}

/**
 * Search releases.
 * @param {string} query
 * @param {{ kind?: 'all'|'artist'|'album'|'song'|'genre', signal?: AbortSignal }} options
 */
export async function search(query, { kind = 'all', signal, patience } = {}) {
  const text = query.trim();
  if (!text) return [];

  const escaped = text.replace(/["\\]/g, ' ').trim();
  const field = {
    artist: 'creator:("' + escaped + '")',
    album: 'title:("' + escaped + '")',
    song: 'title:("' + escaped + '")',
    genre: 'subject:("' + escaped + '")',
    all: '(' + escaped + ')',
  }[kind];

  const params = new URLSearchParams();
  params.set('q', field + ' AND mediatype:(audio)');
  for (const f of ['identifier', 'title', 'creator', 'year', 'date', 'downloads', 'licenseurl', 'subject', 'collection']) {
    params.append('fl[]', f);
  }
  params.set('sort[]', 'downloads desc');
  params.set('rows', '40');
  params.set('page', '1');
  params.set('output', 'json');

  const data = await getJson(SEARCH + '?' + params, signal, patience);
  const docs = (data.response && data.response.docs) || [];

  return docs.map((doc) => ({
    id: doc.identifier,
    title: first(doc.title) || doc.identifier,
    artist: first(doc.creator) || 'Unknown artist',
    year: (String(doc.date || doc.year || '').match(/\d{4}/) || [])[0] || '',
    genre: [].concat(doc.subject || []).slice(0, 3).join(', '),
    plays: doc.downloads || 0,
    license: licenceName(doc.licenseurl),
    thumb: THUMB + doc.identifier,
  }));
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function licenceName(url) {
  const text = String(first(url) || '');
  if (!text) return '';
  if (/publicdomain|mark\/1\.0/.test(text)) return 'Public domain';
  const cc = text.match(/licenses\/([a-z-]+)\//);
  return cc ? 'CC ' + cc[1].toUpperCase() : 'See source';
}

/** Full detail for one release: its tracks and the best file for each. */
export async function release(id, signal, patience) {
  const data = await getJson(META + encodeURIComponent(id), signal, patience);
  const meta = data.metadata || {};
  const restricted = String(meta['access-restricted-item'] || '') === 'true';

  /** Group the files by track, keeping the best encoding of each. */
  const byTrack = new Map();
  for (const file of data.files || []) {
    if (!AUDIO_FORMATS.test(file.format || '')) continue;
    const key = (file.title || file.name.replace(/\.[^.]+$/, '')).trim();
    const grade = gradeFile(file);
    const entry = {
      name: file.name,
      title: file.title || key,
      track: parseInt(file.track, 10) || null,
      seconds: trackSeconds(file.length),
      size: Number(file.size) || 0,
      grade,
      url: DOWNLOAD + encodeURIComponent(id) + '/' + file.name.split('/').map(encodeURIComponent).join('/'),
    };
    const existing = byTrack.get(key);
    if (!existing || grade.rank > existing.grade.rank) byTrack.set(key, entry);
  }

  const tracks = [...byTrack.values()].sort((a, b) =>
    (a.track || 999) - (b.track || 999) || a.title.localeCompare(b.title));

  const best = tracks.reduce((top, t) => (t.grade.rank > (top ? top.rank : -1) ? t.grade : top), null);

  return {
    id,
    title: meta.title || id,
    artist: first(meta.creator) || 'Unknown artist',
    year: (String(meta.date || meta.year || '').match(/\d{4}/) || [])[0] || '',
    description: stripTags(first(meta.description) || '').slice(0, 600),
    genre: [].concat(meta.subject || []).slice(0, 5).join(', '),
    license: licenceName(meta.licenseurl),
    source: 'https://archive.org/details/' + encodeURIComponent(id),
    thumb: THUMB + id,
    restricted,
    downloadable: !restricted && tracks.length > 0,
    best,
    tracks,
  };
}

/**
 * The archive gives length either as seconds or as a clock. Clock wins when
 * there is a colon, because parseFloat would happily read "5:30" as five.
 */
function trackSeconds(value) {
  const text = String(value || '').trim();
  if (text.includes(':')) {
    const parts = text.split(':').map(Number);
    if (parts.every(Number.isFinite)) {
      return parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    }
    return 0;
  }
  const seconds = parseFloat(text);
  return Number.isFinite(seconds) ? seconds : 0;
}

function stripTags(html) {
  const div = document.createElement('div');
  div.innerHTML = String(html);
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

/**
 * Download one track straight into the library, untouched.
 * @param {object} rel from release()
 * @param {object} track one of rel.tracks
 */
export async function fetchTrack(rel, track, { onProgress, liked = false, signal } = {}) {
  let res;
  try {
    res = await fetch(track.url, { mode: 'cors', signal });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new DiscoverError('The archive would not hand that file to the app directly.');
  }
  if (!res.ok) throw new DiscoverError('Download failed with ' + res.status + '.');

  const total = Number(res.headers.get('content-length')) || track.size || 0;
  const blob = res.body && res.body.getReader
    ? await readWithProgress(res, total, onProgress)
    : await res.blob();

  const file = new File([blob], track.name.split('/').pop(), { type: blob.type || 'application/octet-stream' });

  const saved = await library.importFile(file, {
    liked,
    source: 'archive',
    sourceUrl: rel.source,
    title: track.title,
    artist: rel.artist,
    album: rel.title,
    year: rel.year ? Number(rel.year) : null,
  });
  if (!saved) throw new DiscoverError('That track is already in your library.');

  if (!saved.artworkKey) {
    try {
      const art = await fetch(rel.thumb, { mode: 'cors' }).then((r) => (r.ok ? r.blob() : null));
      if (art && art.size > 1000) await library.setArtwork(saved.id, art);
    } catch { /* artwork is optional */ }
  }
  return saved;
}

async function readWithProgress(res, total, onProgress) {
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  return new Blob(chunks, { type: (res.headers.get('content-type') || '').split(';')[0] });
}
