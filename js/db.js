/**
 * IndexedDB storage layer.
 *
 * Object stores:
 *   tracks    - metadata only, keyed by uuid. Never holds the audio itself.
 *   blobs     - the actual media file, keyed by the owning track id.
 *   artwork   - cover images, keyed by a content hash so an album shares one copy.
 *   playlists - user playlists, ordered arrays of track ids.
 *   plays     - one row per listen, for recently-played and play counts.
 *   settings  - single-row key/value bag.
 *   lyrics    - .lrc or plain text, keyed by track id.
 *
 * Media lives in its own store so that listing a 5000 track library never
 * pulls a gigabyte of blobs into memory.
 */

const DB_NAME = 'resonate';
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;

      if (!db.objectStoreNames.contains('tracks')) {
        const tracks = db.createObjectStore('tracks', { keyPath: 'id' });
        tracks.createIndex('title', 'sortTitle');
        tracks.createIndex('artist', 'sortArtist');
        tracks.createIndex('album', 'sortAlbum');
        tracks.createIndex('addedAt', 'addedAt');
        tracks.createIndex('liked', 'liked');
        tracks.createIndex('kind', 'kind');
        tracks.createIndex('fingerprint', 'fingerprint');
      } else if (event.oldVersion < 2 && tx) {
        // Version 2 added the fingerprint used to spot a re-imported file.
        // Tracks imported before it simply have none and never match.
        const tracks = tx.objectStore('tracks');
        if (!tracks.indexNames.contains('fingerprint')) {
          tracks.createIndex('fingerprint', 'fingerprint');
        }
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs');
      }
      if (!db.objectStoreNames.contains('artwork')) {
        db.createObjectStore('artwork');
      }
      if (!db.objectStoreNames.contains('playlists')) {
        const pl = db.createObjectStore('playlists', { keyPath: 'id' });
        pl.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('plays')) {
        const plays = db.createObjectStore('plays', { keyPath: 'id', autoIncrement: true });
        plays.createIndex('trackId', 'trackId');
        plays.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
      if (!db.objectStoreNames.contains('lyrics')) {
        db.createObjectStore('lyrics');
      }
      if (tx) tx.oncomplete = () => {};
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked by another open tab.'));
  });
  return dbPromise;
}

function tx(stores, mode) {
  return open().then((db) => db.transaction(stores, mode));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
}

/* ------------------------------------------------------------------ tracks */

export async function putTrack(track) {
  const t = await tx(['tracks'], 'readwrite');
  t.objectStore('tracks').put(track);
  await done(t);
  return track;
}

export async function putTracks(tracks) {
  const t = await tx(['tracks'], 'readwrite');
  const store = t.objectStore('tracks');
  for (const track of tracks) store.put(track);
  await done(t);
  return tracks;
}

export async function getTrack(id) {
  const t = await tx(['tracks'], 'readonly');
  return wrap(t.objectStore('tracks').get(id));
}

export async function getTracks(ids) {
  const t = await tx(['tracks'], 'readonly');
  const store = t.objectStore('tracks');
  return Promise.all(ids.map((id) => wrap(store.get(id))));
}

export async function allTracks() {
  const t = await tx(['tracks'], 'readonly');
  return wrap(t.objectStore('tracks').getAll());
}

export async function countTracks() {
  const t = await tx(['tracks'], 'readonly');
  return wrap(t.objectStore('tracks').count());
}

/** The existing track with this fingerprint, if the file was imported before. */
export async function findByFingerprint(fingerprint) {
  if (!fingerprint) return null;
  const t = await tx(['tracks'], 'readonly');
  const found = await wrap(t.objectStore('tracks').index('fingerprint').get(fingerprint));
  return found || null;
}

/** Delete a track along with its media, lyrics, play history and playlist refs. */
export async function deleteTrack(id) {
  const t = await tx(['tracks', 'blobs', 'lyrics', 'plays', 'playlists'], 'readwrite');
  t.objectStore('tracks').delete(id);
  t.objectStore('blobs').delete(id);
  t.objectStore('lyrics').delete(id);

  const playIndex = t.objectStore('plays').index('trackId');
  playIndex.openKeyCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    t.objectStore('plays').delete(cursor.primaryKey);
    cursor.continue();
  };

  const plStore = t.objectStore('playlists');
  plStore.openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    const pl = cursor.value;
    if (pl.trackIds.includes(id)) {
      pl.trackIds = pl.trackIds.filter((x) => x !== id);
      pl.updatedAt = Date.now();
      cursor.update(pl);
    }
    cursor.continue();
  };

  await done(t);
  await pruneArtwork();
}

/* ------------------------------------------------------------------- blobs */

export async function putBlob(id, blob) {
  const t = await tx(['blobs'], 'readwrite');
  t.objectStore('blobs').put(blob, id);
  await done(t);
}

export async function getBlob(id) {
  const t = await tx(['blobs'], 'readonly');
  return wrap(t.objectStore('blobs').get(id));
}

export async function hasBlob(id) {
  const t = await tx(['blobs'], 'readonly');
  const key = await wrap(t.objectStore('blobs').getKey(id));
  return key !== undefined;
}

/* ----------------------------------------------------------------- artwork */

/** Store cover art under a content hash so a 12 track album keeps one copy. */
export async function putArtwork(blob) {
  const buf = await blob.arrayBuffer();
  const key = await hashBytes(buf);
  const t = await tx(['artwork'], 'readwrite');
  const store = t.objectStore('artwork');
  const existing = await wrap(store.getKey(key));
  if (existing === undefined) store.put(blob, key);
  await done(t);
  return key;
}

export async function getArtwork(key) {
  if (!key) return null;
  const t = await tx(['artwork'], 'readonly');
  return wrap(t.objectStore('artwork').get(key));
}

/** Drop cover images no track references any more. */
export async function pruneArtwork() {
  const t = await tx(['tracks', 'artwork'], 'readwrite');
  const tracks = await wrap(t.objectStore('tracks').getAll());
  const live = new Set(tracks.map((x) => x.artworkKey).filter(Boolean));
  const store = t.objectStore('artwork');
  const keys = await wrap(store.getAllKeys());
  for (const key of keys) if (!live.has(key)) store.delete(key);
  await done(t);
}

/**
 * A cheap identity for a media file: its size plus a hash of the first and
 * last 64 KB. Enough to recognise the same file on a repeat import without
 * reading a 400 MB album off disk to do it.
 */
export async function fileFingerprint(file) {
  try {
    const edge = 64 * 1024;
    const head = await file.slice(0, Math.min(edge, file.size)).arrayBuffer();
    const tail = file.size > edge
      ? await file.slice(Math.max(0, file.size - edge), file.size).arrayBuffer()
      : new ArrayBuffer(0);

    const merged = new Uint8Array(head.byteLength + tail.byteLength);
    merged.set(new Uint8Array(head), 0);
    merged.set(new Uint8Array(tail), head.byteLength);

    return file.size + '-' + await hashBytes(merged.buffer);
  } catch {
    return '';
  }
}

async function hashBytes(buf) {
  if (crypto.subtle && self.isSecureContext) {
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-secure context fallback: FNV-1a over a sample of the bytes.
  const view = new Uint8Array(buf);
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(view.length / 4096));
  for (let i = 0; i < view.length; i += step) {
    h ^= view[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `f${h.toString(16)}-${view.length}`;
}

/* --------------------------------------------------------------- playlists */

export async function putPlaylist(playlist) {
  const t = await tx(['playlists'], 'readwrite');
  t.objectStore('playlists').put(playlist);
  await done(t);
  return playlist;
}

export async function getPlaylist(id) {
  const t = await tx(['playlists'], 'readonly');
  return wrap(t.objectStore('playlists').get(id));
}

export async function allPlaylists() {
  const t = await tx(['playlists'], 'readonly');
  const rows = await wrap(t.objectStore('playlists').getAll());
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deletePlaylist(id) {
  const t = await tx(['playlists'], 'readwrite');
  t.objectStore('playlists').delete(id);
  await done(t);
}

/* ------------------------------------------------------------------- plays */

export async function recordPlay(trackId) {
  const t = await tx(['plays'], 'readwrite');
  t.objectStore('plays').add({ trackId, at: Date.now() });
  await done(t);
}

/** Most recent listen per track, newest first. */
export async function recentPlays(limit = 40) {
  const t = await tx(['plays'], 'readonly');
  const index = t.objectStore('plays').index('at');
  const seen = new Set();
  const out = [];
  await new Promise((resolve, reject) => {
    const req = index.openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || out.length >= limit) return resolve();
      if (!seen.has(cursor.value.trackId)) {
        seen.add(cursor.value.trackId);
        out.push(cursor.value);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return out;
}

export async function playCounts() {
  const t = await tx(['plays'], 'readonly');
  const rows = await wrap(t.objectStore('plays').getAll());
  const counts = new Map();
  for (const row of rows) counts.set(row.trackId, (counts.get(row.trackId) || 0) + 1);
  return counts;
}

export async function clearPlays() {
  const t = await tx(['plays'], 'readwrite');
  t.objectStore('plays').clear();
  await done(t);
}

/* ------------------------------------------------------------------ lyrics */

export async function putLyrics(trackId, value) {
  const t = await tx(['lyrics'], 'readwrite');
  if (value == null) t.objectStore('lyrics').delete(trackId);
  else t.objectStore('lyrics').put(value, trackId);
  await done(t);
}

export async function getLyrics(trackId) {
  const t = await tx(['lyrics'], 'readonly');
  return wrap(t.objectStore('lyrics').get(trackId));
}

/* ---------------------------------------------------------------- settings */

export async function getSetting(key, fallback = null) {
  const t = await tx(['settings'], 'readonly');
  const value = await wrap(t.objectStore('settings').get(key));
  return value === undefined ? fallback : value;
}

export async function setSetting(key, value) {
  const t = await tx(['settings'], 'readwrite');
  t.objectStore('settings').put(value, key);
  await done(t);
}

export async function allSettings() {
  const t = await tx(['settings'], 'readonly');
  const store = t.objectStore('settings');
  const keys = await wrap(store.getAllKeys());
  const values = await wrap(store.getAll());
  const out = {};
  keys.forEach((k, i) => { out[k] = values[i]; });
  return out;
}

/* ------------------------------------------------------------ maintenance */

export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    const est = await navigator.storage.estimate();
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return null;
  }
}

export async function requestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function wipeEverything() {
  const db = await open();
  const names = [...db.objectStoreNames];
  const t = db.transaction(names, 'readwrite');
  for (const name of names) t.objectStore(name).clear();
  await done(t);
}
