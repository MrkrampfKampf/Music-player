/**
 * Library model.
 *
 * Owns importing files, grouping tracks into albums and artists, search,
 * playlists and the Liked Songs list. Holds every track row in memory (a
 * 10,000 track library is a few megabytes of plain objects) and reloads from
 * IndexedDB whenever something changes, so views can render synchronously.
 */

import * as db from './db.js';
import { readTags, probeDuration } from './tags.js';

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|flac|ogg|oga|opus|aiff?|aifc|caf|weba)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

export const LIKED_ID = 'liked';

class Library extends EventTarget {
  constructor() {
    super();
    this.tracks = [];
    this.byId = new Map();
    this.playlists = [];
    this.counts = new Map();
    this.ready = false;
  }

  async load() {
    const [tracks, playlists, counts] = await Promise.all([
      db.allTracks(), db.allPlaylists(), db.playCounts(),
    ]);
    this.tracks = tracks;
    this.byId = new Map(tracks.map((t) => [t.id, t]));
    this.playlists = playlists;
    this.counts = counts;
    this.ready = true;
    this.dispatchEvent(new CustomEvent('change'));
  }

  get(id) {
    return this.byId.get(id) || null;
  }

  resolve(ids) {
    return ids.map((id) => this.byId.get(id)).filter(Boolean);
  }

  /* --------------------------------------------------------------- import */

  /**
   * Import files the user picked. Reports progress per file and never lets one
   * bad file abort the batch.
   * @param {File[]} files
   * @param {(done:number,total:number,name:string)=>void} onProgress
   */
  async importFiles(files, onProgress) {
    const accepted = [...files].filter(isPlayable);
    const skipped = [...files].length - accepted.length;
    const added = [];
    const failed = [];
    const duplicates = [];

    for (let i = 0; i < accepted.length; i++) {
      const file = accepted[i];
      if (onProgress) onProgress(i, accepted.length, file.name);
      try {
        const track = await this.importFile(file);
        if (track) added.push(track);
        else duplicates.push(file.name);
      } catch (err) {
        console.warn('Import failed for ' + file.name, err);
        failed.push(file.name);
      }
    }

    if (onProgress) onProgress(accepted.length, accepted.length, '');
    await this.load();
    return { added, failed, skipped, duplicates };
  }

  /**
   * Import a single File or Blob. Returns the stored track row, or null when
   * the same file is already in the library.
   *
   * Re-importing a folder is the normal way to pick up newly added music, so
   * a file that is already here is skipped rather than duplicated. Pass
   * `extra.allowDuplicate` to import a second copy on purpose.
   */
  async importFile(file, extra = {}) {
    const fingerprint = await db.fileFingerprint(file);
    if (fingerprint && !extra.allowDuplicate) {
      const existing = await db.findByFingerprint(fingerprint);
      if (existing) return null;
    }

    const kind = VIDEO_EXT.test(file.name || '') || (file.type || '').startsWith('video/') ? 'video' : 'audio';
    const meta = await readTags(file);

    // Tags carry no duration for a few formats; fall back to decoding.
    let duration = meta.duration;
    if (!duration || !Number.isFinite(duration)) duration = await probeDuration(file);

    const id = db.uuid();
    let artworkKey = null;
    if (meta.artwork && meta.artwork.size > 0) {
      try { artworkKey = await db.putArtwork(meta.artwork); } catch { /* art is optional */ }
    } else if (extra.artwork) {
      try { artworkKey = await db.putArtwork(extra.artwork); } catch { /* art is optional */ }
    }

    const title = (extra.title || meta.title || 'Unknown title').trim();
    const artist = (extra.artist || meta.artist || 'Unknown artist').trim();
    const album = (extra.album || meta.album || '').trim();

    const track = {
      id,
      kind,
      title,
      artist,
      album,
      albumArtist: (meta.albumArtist || artist).trim(),
      genre: meta.genre || '',
      year: meta.year || extra.year || null,
      trackNo: meta.trackNo || null,
      trackOf: meta.trackOf || null,
      discNo: meta.discNo || null,
      discOf: meta.discOf || null,
      duration: duration || 0,
      size: file.size,
      mime: file.type || guessMime(file.name),
      codec: meta.codec || '',
      lossless: !!meta.lossless,
      bitrate: meta.bitrate || 0,
      sampleRate: meta.sampleRate || 0,
      channels: meta.channels || 0,
      bitDepth: meta.bitDepth || 0,
      artworkKey,
      liked: extra.liked ? 1 : 0,
      fingerprint,
      source: extra.source || 'local',
      sourceUrl: extra.sourceUrl || '',
      fileName: file.name || title,
      addedAt: Date.now(),
      sortTitle: sortKey(title),
      sortArtist: sortKey(artist),
      sortAlbum: sortKey(album),
    };

    await db.putBlob(id, file instanceof Blob ? file : new Blob([file]));
    await db.putTrack(track);
    if (meta.lyrics) await db.putLyrics(id, { kind: 'plain', text: meta.lyrics });
    if (extra.liked) await this._appendToLiked(id);

    return track;
  }

  async deleteTracks(ids) {
    for (const id of ids) await db.deleteTrack(id);
    await this.load();
  }

  async updateTrack(id, patch) {
    const track = this.byId.get(id);
    if (!track) return null;
    const next = { ...track, ...patch };
    if (patch.title != null) next.sortTitle = sortKey(patch.title);
    if (patch.artist != null) next.sortArtist = sortKey(patch.artist);
    if (patch.album != null) next.sortAlbum = sortKey(patch.album);
    await db.putTrack(next);
    await this.load();
    return next;
  }

  async setArtwork(id, blob) {
    const key = await db.putArtwork(blob);
    await this.updateTrack(id, { artworkKey: key });
    await db.pruneArtwork();
  }

  /* ----------------------------------------------------------------- likes */

  async toggleLike(id) {
    const track = this.byId.get(id);
    if (!track) return false;
    const liked = track.liked ? 0 : 1;
    await db.putTrack({ ...track, liked });
    if (liked) await this._appendToLiked(id);
    else await this._removeFromLiked(id);
    await this.load();
    return !!liked;
  }

  async _appendToLiked(id) {
    const pl = await this._likedPlaylist();
    if (!pl.trackIds.includes(id)) {
      // Newest first, the way both Apple Music and Spotify order likes.
      pl.trackIds.unshift(id);
      pl.updatedAt = Date.now();
      await db.putPlaylist(pl);
    }
  }

  async _removeFromLiked(id) {
    const pl = await this._likedPlaylist();
    const next = pl.trackIds.filter((x) => x !== id);
    if (next.length !== pl.trackIds.length) {
      pl.trackIds = next;
      pl.updatedAt = Date.now();
      await db.putPlaylist(pl);
    }
  }

  async _likedPlaylist() {
    let pl = await db.getPlaylist(LIKED_ID);
    if (!pl) {
      pl = { id: LIKED_ID, name: 'Liked Songs', system: true, trackIds: [], createdAt: Date.now(), updatedAt: Date.now() };
      await db.putPlaylist(pl);
    }
    return pl;
  }

  get likedTracks() {
    const pl = this.playlists.find((p) => p.id === LIKED_ID);
    if (pl) return this.resolve(pl.trackIds);
    return this.tracks.filter((t) => t.liked).sort((a, b) => b.addedAt - a.addedAt);
  }

  /* ------------------------------------------------------------- playlists */

  async createPlaylist(name, trackIds = []) {
    const pl = {
      id: db.uuid(),
      name: name.trim() || 'New Playlist',
      system: false,
      trackIds: trackIds.slice(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await db.putPlaylist(pl);
    await this.load();
    return pl;
  }

  async renamePlaylist(id, name) {
    const pl = await db.getPlaylist(id);
    if (!pl) return;
    pl.name = name.trim() || pl.name;
    pl.updatedAt = Date.now();
    await db.putPlaylist(pl);
    await this.load();
  }

  async addToPlaylist(id, trackIds) {
    const pl = id === LIKED_ID ? await this._likedPlaylist() : await db.getPlaylist(id);
    if (!pl) return;
    const fresh = trackIds.filter((t) => !pl.trackIds.includes(t));
    if (!fresh.length) return;
    pl.trackIds.push(...fresh);
    pl.updatedAt = Date.now();
    await db.putPlaylist(pl);
    if (id === LIKED_ID) {
      for (const trackId of fresh) {
        const track = this.byId.get(trackId);
        if (track && !track.liked) await db.putTrack({ ...track, liked: 1 });
      }
    }
    await this.load();
  }

  async removeFromPlaylist(id, position) {
    const pl = await db.getPlaylist(id);
    if (!pl || position < 0 || position >= pl.trackIds.length) return;
    const [removed] = pl.trackIds.splice(position, 1);
    pl.updatedAt = Date.now();
    await db.putPlaylist(pl);
    if (id === LIKED_ID) {
      const track = this.byId.get(removed);
      if (track) await db.putTrack({ ...track, liked: 0 });
    }
    await this.load();
  }

  async reorderPlaylist(id, from, to) {
    const pl = await db.getPlaylist(id);
    if (!pl) return;
    const [moved] = pl.trackIds.splice(from, 1);
    pl.trackIds.splice(to, 0, moved);
    pl.updatedAt = Date.now();
    await db.putPlaylist(pl);
    await this.load();
  }

  async deletePlaylist(id) {
    if (id === LIKED_ID) return;
    await db.deletePlaylist(id);
    await this.load();
  }

  playlistTracks(id) {
    const pl = this.playlists.find((p) => p.id === id);
    return pl ? this.resolve(pl.trackIds) : [];
  }

  /* ---------------------------------------------------------- collections */

  get songs() {
    return this.tracks.filter((t) => t.kind === 'audio').sort(byTitle);
  }

  get videos() {
    return this.tracks.filter((t) => t.kind === 'video').sort(byTitle);
  }

  get albums() {
    const groups = new Map();
    for (const t of this.tracks) {
      if (t.kind !== 'audio') continue;
      const name = t.album || 'Singles';
      const artist = t.albumArtist || t.artist;
      const key = sortKey(name) + '|' + sortKey(artist);
      let group = groups.get(key);
      if (!group) {
        group = { key, name, artist, year: t.year, artworkKey: t.artworkKey, tracks: [] };
        groups.set(key, group);
      }
      group.tracks.push(t);
      if (!group.artworkKey && t.artworkKey) group.artworkKey = t.artworkKey;
      if (!group.year && t.year) group.year = t.year;
    }
    for (const group of groups.values()) group.tracks.sort(byDiscAndTrack);
    return [...groups.values()].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
  }

  get artists() {
    const groups = new Map();
    for (const t of this.tracks) {
      const name = t.albumArtist || t.artist || 'Unknown artist';
      const key = sortKey(name);
      let group = groups.get(key);
      if (!group) {
        group = { key, name, artworkKey: t.artworkKey, tracks: [], albums: new Set() };
        groups.set(key, group);
      }
      group.tracks.push(t);
      if (t.album) group.albums.add(t.album);
      if (!group.artworkKey && t.artworkKey) group.artworkKey = t.artworkKey;
    }
    for (const group of groups.values()) group.tracks.sort(byTitle);
    return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  get genres() {
    const groups = new Map();
    for (const t of this.tracks) {
      const name = t.genre || 'Unclassified';
      let group = groups.get(name);
      if (!group) { group = { name, tracks: [], artworkKey: t.artworkKey }; groups.set(name, group); }
      group.tracks.push(t);
      if (!group.artworkKey && t.artworkKey) group.artworkKey = t.artworkKey;
    }
    return [...groups.values()].sort((a, b) => b.tracks.length - a.tracks.length);
  }

  albumOf(track) {
    return this.albums.find((a) => a.name === (track.album || 'Singles')
      && a.artist === (track.albumArtist || track.artist)) || null;
  }

  get recentlyAdded() {
    return this.tracks.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 40);
  }

  get mostPlayed() {
    return this.tracks
      .filter((t) => this.counts.get(t.id))
      .sort((a, b) => (this.counts.get(b.id) || 0) - (this.counts.get(a.id) || 0))
      .slice(0, 40);
  }

  async recentlyPlayed(limit = 20) {
    const rows = await db.recentPlays(limit);
    return rows.map((r) => this.byId.get(r.trackId)).filter(Boolean);
  }

  /** A shuffled mix weighted towards tracks that have not been played much. */
  mix(size = 50) {
    const pool = this.tracks.filter((t) => t.kind === 'audio');
    const scored = pool.map((t) => ({
      t,
      score: Math.random() * (1 + 1 / (1 + (this.counts.get(t.id) || 0))),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, size).map((x) => x.t);
  }

  /* ---------------------------------------------------------------- search */

  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return { tracks: [], albums: [], artists: [], playlists: [] };
    const terms = q.split(/\s+/);
    const matches = (haystack) => terms.every((term) => haystack.includes(term));

    const tracks = this.tracks
      .map((t) => {
        const hay = (t.title + ' ' + t.artist + ' ' + t.album + ' ' + t.genre).toLowerCase();
        if (!matches(hay)) return null;
        // Prefer a title hit over an incidental album or genre hit.
        const rank = t.title.toLowerCase().startsWith(q) ? 0
          : t.title.toLowerCase().includes(q) ? 1
            : t.artist.toLowerCase().includes(q) ? 2 : 3;
        return { t, rank };
      })
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank || a.t.sortTitle.localeCompare(b.t.sortTitle))
      .slice(0, 100)
      .map((x) => x.t);

    const albums = this.albums.filter((a) => matches((a.name + ' ' + a.artist).toLowerCase())).slice(0, 20);
    const artists = this.artists.filter((a) => matches(a.name.toLowerCase())).slice(0, 20);
    const playlists = this.playlists.filter((p) => matches(p.name.toLowerCase())).slice(0, 20);

    return { tracks, albums, artists, playlists };
  }

  /* ---------------------------------------------------------------- export */

  /** A JSON backup of everything except the media files themselves. */
  async exportBackup() {
    const settings = await db.allSettings();
    const lyrics = {};
    for (const t of this.tracks) {
      const l = await db.getLyrics(t.id);
      if (l) lyrics[t.id] = l;
    }
    return {
      format: 'resonate-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      tracks: this.tracks.map((t) => ({ ...t })),
      playlists: this.playlists,
      lyrics,
      settings,
    };
  }
}

/* -------------------------------------------------------------- utilities */

function isPlayable(file) {
  const name = file.name || '';
  if (AUDIO_EXT.test(name) || VIDEO_EXT.test(name)) return true;
  const type = file.type || '';
  return type.startsWith('audio/') || type.startsWith('video/');
}

function guessMime(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const map = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
    oga: 'audio/ogg', opus: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff',
    caf: 'audio/x-caf', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
    webm: 'video/webm',
  };
  return map[ext] || 'application/octet-stream';
}

/** Sort key that ignores leading articles and case, the way music apps do. */
export function sortKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function byTitle(a, b) {
  return a.sortTitle.localeCompare(b.sortTitle) || a.sortArtist.localeCompare(b.sortArtist);
}

function byDiscAndTrack(a, b) {
  const disc = (a.discNo || 1) - (b.discNo || 1);
  if (disc) return disc;
  const track = (a.trackNo || 9999) - (b.trackNo || 9999);
  if (track) return track;
  return a.sortTitle.localeCompare(b.sortTitle);
}

export const library = new Library();
