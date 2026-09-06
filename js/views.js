/**
 * The browsing views: Home, Library and its tabs, Search, and the detail
 * pages for albums, artists, playlists and genres.
 */

import { library, LIKED_ID } from './library.js';
import { player } from './player.js';
import * as db from './db.js';
import {
  el, icon, clear, artNode, formatTime, formatDurationLong, plural,
  isHiRes, menuSheet, promptSheet, confirmSheet, closeSheet, toast, artworkUrl,
} from './ui.js';
import { tick, press } from './tactile.js';

let router = null;
export function setRouter(fn) { router = fn; }

/* ------------------------------------------------------------- track rows */

/**
 * One track row.
 * @param {object} track
 * @param {object[]} context the list this row belongs to, so tapping plays it
 * @param {object} options { index, showArt, showNumber, onMenu, playlistId }
 */
export function trackRow(track, context, options = {}) {
  const {
    showArt = true, showNumber = false, index = 0, playlistId = null,
    // In an album view the artist and album are already in the header, so the
    // row only names an artist when it differs from the album's.
    hideArtist = null,
  } = options;

  const row = el('button', { class: 'row', dataset: { trackId: track.id } });
  if (player.current && player.current.id === track.id) row.classList.add('playing');

  if (showNumber) {
    row.append(el('span', { class: 'row-index', text: String(track.trackNo || index + 1).padStart(2, '0') }));
  } else if (showArt) {
    row.append(artNode(track.artworkKey));
  }

  const sub = el('span', { class: 'row-sub' });
  if (isHiRes(track)) sub.append(el('span', { class: 'badge hi', text: 'Hi-Res' }));
  else if (track.lossless) sub.append(el('span', { class: 'badge', text: 'Lossless' }));

  let caption;
  if (hideArtist) caption = track.artist === hideArtist ? '' : track.artist;
  else caption = track.artist + (track.album ? ' — ' + track.album : '');
  if (caption) sub.append(el('span', { text: caption }));

  const text = el('span', { class: 'row-text' }, el('span', { class: 'row-title', text: track.title }));
  if (sub.childNodes.length) text.append(sub);
  row.append(text);

  // Dot leaders run out to the time, the way a printed track listing does.
  row.append(el('span', { class: 'leader', 'aria-hidden': 'true' }));
  row.append(el('span', { class: 'row-time num', text: formatTime(track.duration) }));

  const more = el('span', { class: 'icon-btn row-more', role: 'button', tabindex: '0', 'aria-label': 'More options' }, icon('more'));
  more.addEventListener('click', (event) => {
    event.stopPropagation();
    trackMenu(track, { playlistId, position: index });
  });
  row.append(more);

  row.addEventListener('click', () => {
    const list = context && context.length ? context : [track];
    const at = list.findIndex((t) => t.id === track.id);
    player.play(list, at < 0 ? 0 : at);
  });

  return row;
}

export function trackList(tracks, options = {}) {
  const wrap = el('div', { class: 'rows' });
  tracks.forEach((track, index) => {
    wrap.append(trackRow(track, tracks, { ...options, index }));
  });
  return wrap;
}

/* ------------------------------------------------------------- track menu */

export function trackMenu(track, { playlistId = null, position = -1 } = {}) {
  const header = el('div', { class: 'sheet-head' },
    artNode(track.artworkKey),
    el('div', { style: { minWidth: 0 } },
      el('div', { class: 'row-title', text: track.title }),
      el('div', { class: 'row-sub' }, el('span', { text: track.artist }))));

  const items = [
    {
      label: track.liked ? 'Remove from Liked Songs' : 'Add to Liked Songs',
      icon: track.liked ? 'heart-fill' : 'heart',
      onSelect: async () => {
        const liked = await library.toggleLike(track.id);
        toast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
      },
    },
    {
      label: 'Play Next',
      icon: 'queue',
      onSelect: () => { player.playNext([track]); toast('Playing next'); },
    },
    {
      label: 'Add to Queue',
      icon: 'plus',
      onSelect: () => { player.addToQueue([track]); toast('Added to queue'); },
    },
    {
      label: 'Add to Playlist',
      icon: 'library',
      onSelect: () => addToPlaylistSheet([track.id]),
    },
    track.album ? {
      label: 'Go to Album',
      icon: 'note',
      onSelect: () => {
        const album = library.albumOf(track);
        if (album) router({ view: 'album', key: album.key });
      },
    } : null,
    {
      label: 'Lyrics',
      icon: 'lyrics',
      onSelect: () => lyricsSheet(track),
    },
    {
      label: 'Song Info',
      icon: 'clock',
      onSelect: () => infoSheet(track),
    },
    {
      label: 'Edit Details',
      icon: 'eq',
      onSelect: () => editSheet(track),
    },
    {
      label: 'Save to Files',
      icon: 'download',
      onSelect: () => exportTrack(track),
    },
    playlistId && playlistId !== LIKED_ID && position >= 0 ? {
      label: 'Remove from Playlist',
      icon: 'x',
      onSelect: async () => {
        await library.removeFromPlaylist(playlistId, position);
        toast('Removed from playlist');
      },
    } : null,
    {
      label: 'Delete from Library',
      icon: 'trash',
      destructive: true,
      onSelect: async () => {
        const yes = await confirmSheet({
          title: 'Delete this song?',
          message: track.title + ' will be removed from the app and its file deleted from this device.',
          confirmLabel: 'Delete',
          destructive: true,
        });
        if (!yes) return;
        await library.deleteTracks([track.id]);
        toast('Deleted');
      },
    },
  ];

  menuSheet(null, items, header);
}

async function exportTrack(track) {
  const blob = await db.getBlob(track.id);
  if (!blob) { toast('That file is missing.', { error: true }); return; }
  const file = new File([blob], track.fileName || track.title, { type: track.mime });

  // Share is the only route that reaches the Files app from a web app on iOS.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: track.title });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: track.fileName || track.title + '.mp3' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function infoSheet(track) {
  const rows = [
    ['Title', track.title],
    ['Artist', track.artist],
    ['Album', track.album || '—'],
    ['Album artist', track.albumArtist || '—'],
    ['Genre', track.genre || '—'],
    ['Year', track.year || '—'],
    ['Track', track.trackNo ? track.trackNo + (track.trackOf ? ' of ' + track.trackOf : '') : '—'],
    ['Duration', formatTime(track.duration)],
    ['Format', track.codec || track.mime],
    ['Bitrate', track.bitrate ? Math.round(track.bitrate / 1000) + ' kbps' : '—'],
    ['Sample rate', track.sampleRate ? (track.sampleRate / 1000).toFixed(1) + ' kHz' : '—'],
    ['Bit depth', track.bitDepth ? track.bitDepth + '-bit' : '—'],
    ['Channels', track.channels === 1 ? 'Mono' : track.channels === 2 ? 'Stereo' : (track.channels || '—')],
    ['File size', formatBytesLocal(track.size)],
    ['File name', track.fileName],
    ['Added', new Date(track.addedAt).toLocaleDateString()],
    ['Plays', library.counts.get(track.id) || 0],
    track.sourceUrl ? ['Source', track.sourceUrl] : null,
  ].filter(Boolean);

  menuSheet(null, [], el('div', {},
    el('h2', { text: 'Song Info' }),
    el('div', { class: 'card-box' }, rows.map(([label, value]) => el('div', { class: 'setting' },
      el('div', { class: 'setting-text' }, el('b', { text: label })),
      el('div', {
        class: 'setting-value',
        text: String(value),
        style: { maxWidth: '58%', textAlign: 'right', wordBreak: 'break-word' },
      }))))));
}

function formatBytesLocal(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1000 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

function editSheet(track) {
  menuSheet(null, [], el('div', {}, el('h2', { text: 'Edit Details' }), buildEditForm(track)));
}

function buildEditForm(track) {
  const fields = [
    ['title', 'Title', track.title],
    ['artist', 'Artist', track.artist],
    ['album', 'Album', track.album],
    ['albumArtist', 'Album artist', track.albumArtist],
    ['genre', 'Genre', track.genre],
  ];
  const inputs = {};
  const wrap = el('div', {});

  for (const [key, label, value] of fields) {
    const input = el('input', { type: 'text', value: value || '' });
    inputs[key] = input;
    wrap.append(el('div', { class: 'field' }, el('label', { text: label }), input));
  }

  const yearInput = el('input', { type: 'number', value: track.year || '', placeholder: 'Year' });
  const trackInput = el('input', { type: 'number', value: track.trackNo || '', placeholder: 'Track no.' });
  wrap.append(el('div', { class: 'field', style: { display: 'flex', gap: '10px' } }, yearInput, trackInput));

  const artBtn = el('button', { class: 'btn secondary wide', style: { marginBottom: '10px' } },
    icon('folder'), el('span', { text: 'Change artwork' }));
  artBtn.addEventListener('click', () => {
    const input = document.getElementById('art-input');
    input.value = '';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      await library.setArtwork(track.id, file);
      toast('Artwork updated');
    };
    input.click();
  });
  wrap.append(artBtn);

  wrap.append(el('button', {
    class: 'btn wide',
    text: 'Save',
    onclick: async () => {
      await library.updateTrack(track.id, {
        title: inputs.title.value.trim() || track.title,
        artist: inputs.artist.value.trim() || 'Unknown artist',
        album: inputs.album.value.trim(),
        albumArtist: inputs.albumArtist.value.trim() || inputs.artist.value.trim(),
        genre: inputs.genre.value.trim(),
        year: parseInt(yearInput.value, 10) || null,
        trackNo: parseInt(trackInput.value, 10) || null,
      });
      toast('Saved');
      closeSheet();
    },
  }));

  return wrap;
}

async function lyricsSheet(track) {
  const stored = await db.getLyrics(track.id);
  menuSheet(null, [], el('div', {},
    el('h2', { text: 'Lyrics' }),
    el('p', {
      text: stored
        ? (stored.kind === 'synced' ? 'Synced lyrics are loaded for this song.' : 'Plain lyrics are loaded for this song.')
        : 'No lyrics yet. Import an .lrc file for synced lyrics, or a .txt for plain ones.',
      style: { color: 'var(--text-dim)', margin: '0 0 16px', lineHeight: '1.5' },
    }),
    el('button', {
      class: 'btn wide',
      text: 'Import .lrc or .txt',
      onclick: () => {
        const input = document.getElementById('lrc-input');
        input.value = '';
        input.onchange = async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          const text = await file.text();
          const { parseLyricsFile } = await import('./lyrics.js');
          const parsed = parseLyricsFile(text);
          if (!parsed) { toast('That file had no readable lyrics.', { error: true }); return; }
          await db.putLyrics(track.id, parsed);
          toast(parsed.kind === 'synced' ? 'Synced lyrics added' : 'Lyrics added');
          document.dispatchEvent(new CustomEvent('lyricschange', { detail: { trackId: track.id } }));
        };
        input.click();
      },
    }),
    stored ? el('button', {
      class: 'btn wide secondary',
      text: 'Remove lyrics',
      style: { marginTop: '10px' },
      onclick: async () => {
        await db.putLyrics(track.id, null);
        toast('Lyrics removed');
        document.dispatchEvent(new CustomEvent('lyricschange', { detail: { trackId: track.id } }));
        closeSheet();
      },
    }) : null));
}

export function addToPlaylistSheet(trackIds) {
  const lists = library.playlists.filter((p) => p.id !== LIKED_ID);
  menuSheet('Add to Playlist', [
    {
      label: 'New Playlist',
      icon: 'plus',
      onSelect: async () => {
        const name = await promptSheet({ title: 'New Playlist', label: 'Name', placeholder: 'Late night' });
        if (!name) return;
        await library.createPlaylist(name, trackIds);
        toast('Added to ' + name);
      },
    },
    ...lists.map((pl) => ({
      label: pl.name,
      icon: 'library',
      onSelect: async () => {
        await library.addToPlaylist(pl.id, trackIds);
        toast('Added to ' + pl.name);
      },
    })),
  ]);
}

/* ---------------------------------------------------------------- shelves */

function shelf(title, cards, onSeeAll) {
  if (!cards.length) return null;
  const head = el('div', { class: 'shelf-head' },
    el('h2', { class: 'section-title', text: title }),
    onSeeAll ? el('button', { class: 'text-btn', text: 'See All', onclick: onSeeAll }) : null);
  return el('section', { class: 'shelf' }, head,
    el('div', { class: 'shelf-scroll' }, cards));
}

function trackCard(track, context) {
  const card = el('button', { class: 'card' },
    artNode(track.artworkKey),
    el('span', { class: 'card-title', text: track.title }),
    el('span', { class: 'card-sub', text: track.artist }));
  card.addEventListener('click', () => {
    const list = context && context.length ? context : [track];
    player.play(list, Math.max(0, list.findIndex((t) => t.id === track.id)));
  });
  return card;
}

function albumCard(album) {
  const card = el('button', { class: 'card' },
    artNode(album.artworkKey),
    el('span', { class: 'card-title', text: album.name }),
    el('span', { class: 'card-sub', text: album.artist }));
  card.addEventListener('click', () => router({ view: 'album', key: album.key }));
  return card;
}

function artistCard(artist) {
  const card = el('button', { class: 'card round' },
    artNode(artist.artworkKey),
    el('span', { class: 'card-title', text: artist.name }),
    el('span', { class: 'card-sub', text: plural(artist.tracks.length, 'song') }));
  card.addEventListener('click', () => router({ view: 'artist', key: artist.key }));
  return card;
}

/* -------------------------------------------------------------------- home */

export async function renderHome(host) {
  clear(host);

  const greeting = document.getElementById('greeting');
  if (greeting) greeting.textContent = greetingText();

  if (!library.tracks.length) {
    host.append(emptyState({
      icon: 'note',
      title: 'Your library is empty',
      body: 'Add songs from the Files app, or paste a link on the Add tab to pull one in.',
      action: { label: 'Add music', onSelect: () => document.getElementById('file-input').click() },
    }));
    return;
  }

  const liked = library.likedTracks;
  const recentlyPlayed = await library.recentlyPlayed(12);
  const recentlyAdded = library.recentlyAdded;
  const mostPlayed = library.mostPlayed;

  // Hero: pick up where you left off, or a shuffle of everything.
  const heroTrack = recentlyPlayed[0] || recentlyAdded[0];
  if (heroTrack) {
    const hero = el('button', { class: 'hero' });
    artworkUrl(heroTrack.artworkKey).then((url) => {
      if (url && hero.isConnected) hero.prepend(el('img', { src: url, alt: '' }));
    });
    hero.append(el('div', { class: 'hero-body' },
      el('div', { class: 'hero-kicker', text: recentlyPlayed.length ? 'Pick up where you left off' : 'Recently added' }),
      el('div', { class: 'hero-title', text: heroTrack.title }),
      el('div', { class: 'hero-sub', text: heroTrack.artist })));
    hero.addEventListener('click', () => {
      const list = recentlyPlayed.length ? recentlyPlayed : recentlyAdded;
      player.play(list, Math.max(0, list.findIndex((t) => t.id === heroTrack.id)));
    });
    host.append(hero);
  }

  const quick = el('div', { class: 'detail-actions', style: { marginTop: '16px' } },
    el('button', { class: 'btn', onclick: () => player.play(library.mix(60), 0) },
      icon('shuffle', 20), el('span', { text: 'Shuffle All' })),
    el('button', { class: 'btn secondary', onclick: () => router({ view: 'playlist', key: LIKED_ID }) },
      icon('heart', 20), el('span', { text: 'Liked' })));
  host.append(quick);

  if (recentlyPlayed.length) {
    host.append(shelf('Recently Played', recentlyPlayed.map((t) => trackCard(t, recentlyPlayed))));
  }
  if (liked.length) {
    host.append(shelf('Liked Songs', liked.slice(0, 15).map((t) => trackCard(t, liked)),
      () => router({ view: 'playlist', key: LIKED_ID })));
  }
  host.append(shelf('Recently Added', recentlyAdded.slice(0, 15).map((t) => trackCard(t, recentlyAdded))));

  if (mostPlayed.length >= 3) {
    host.append(shelf('On Repeat', mostPlayed.slice(0, 15).map((t) => trackCard(t, mostPlayed))));
  }

  const albums = library.albums;
  if (albums.length >= 2) {
    host.append(shelf('Albums', albums.slice(0, 15).map(albumCard),
      () => router({ view: 'library', tab: 'albums' })));
  }
  const artists = library.artists;
  if (artists.length >= 2) {
    host.append(shelf('Artists', artists.slice(0, 15).map(artistCard),
      () => router({ view: 'library', tab: 'artists' })));
  }
}

function greetingText() {
  const hour = new Date().getHours();
  if (hour < 5) return 'Late Night';
  if (hour < 12) return 'Good Morning';
  if (hour < 18) return 'Good Afternoon';
  return 'Good Evening';
}

function emptyState({ icon: iconName, title, body, action }) {
  const node = el('div', { class: 'empty' }, icon(iconName), el('h3', { text: title }), el('p', { text: body }));
  if (action) {
    node.append(el('button', { class: 'btn', text: action.label, onclick: action.onSelect }));
  }
  return node;
}

/* ----------------------------------------------------------------- library */

export function renderLibrary(host, tab) {
  clear(host);

  if (!library.tracks.length && tab !== 'playlists') {
    host.append(emptyState({
      icon: 'note',
      title: 'Nothing here yet',
      body: 'Tap the plus button to add files from your iPhone, or use the Add tab to pull in a link.',
      action: { label: 'Add music', onSelect: () => document.getElementById('file-input').click() },
    }));
    return;
  }

  if (tab === 'songs') {
    const songs = library.songs;
    host.append(el('div', { class: 'list-head' },
      el('button', { class: 'btn', style: { flex: 1 }, onclick: () => player.play(songs, 0) },
        icon('play', 20), el('span', { text: 'Play' })),
      el('button', {
        class: 'btn secondary',
        style: { flex: 1 },
        onclick: () => { player.setShuffle(true); player.play(songs, Math.floor(Math.random() * songs.length)); },
      }, icon('shuffle', 20), el('span', { text: 'Shuffle' }))));
    host.append(trackList(songs));
    host.append(countFooter(songs));
    return;
  }

  if (tab === 'videos') {
    const videos = library.videos;
    if (!videos.length) {
      host.append(emptyState({ icon: 'note', title: 'No videos', body: 'MP4, M4V and MOV files show up here.' }));
      return;
    }
    host.append(trackList(videos));
    host.append(countFooter(videos));
    return;
  }

  if (tab === 'albums') {
    host.append(crate(library.albums));
    return;
  }

  if (tab === 'artists') {
    host.append(el('div', { class: 'grid' }, library.artists.map(artistCard)));
    return;
  }

  if (tab === 'genres') {
    host.append(el('div', { class: 'grid' }, library.genres.map((genre) => {
      const card = el('button', { class: 'card' },
        artNode(genre.artworkKey),
        el('span', { class: 'card-title', text: genre.name }),
        el('span', { class: 'card-sub', text: plural(genre.tracks.length, 'song') }));
      card.addEventListener('click', () => router({ view: 'genre', key: genre.name }));
      return card;
    })));
    return;
  }

  if (tab === 'playlists') {
    const liked = library.likedTracks;
    const rows = el('div', { class: 'rows' });

    const likedRow = el('button', { class: 'row' },
      el('span', { class: 'art', style: { background: 'linear-gradient(135deg,#7c3aed,#db2777)', display: 'grid', placeItems: 'center' } }, icon('heart-fill', 22)),
      el('span', { class: 'row-text' },
        el('span', { class: 'row-title', text: 'Liked Songs' }),
        el('span', { class: 'row-sub' }, el('span', { text: plural(liked.length, 'song') }))));
    likedRow.addEventListener('click', () => router({ view: 'playlist', key: LIKED_ID }));
    rows.append(likedRow);

    for (const pl of library.playlists.filter((p) => p.id !== LIKED_ID)) {
      const tracks = library.resolve(pl.trackIds);
      const row = el('button', { class: 'row' },
        artNode(tracks[0] && tracks[0].artworkKey),
        el('span', { class: 'row-text' },
          el('span', { class: 'row-title', text: pl.name }),
          el('span', { class: 'row-sub' }, el('span', { text: plural(tracks.length, 'song') }))));
      row.addEventListener('click', () => router({ view: 'playlist', key: pl.id }));
      rows.append(row);
    }

    host.append(el('div', { class: 'list-head' },
      el('button', {
        class: 'btn wide',
        onclick: async () => {
          const name = await promptSheet({ title: 'New Playlist', label: 'Name', placeholder: 'Late night' });
          if (!name) return;
          const pl = await library.createPlaylist(name);
          router({ view: 'playlist', key: pl.id });
        },
      }, icon('plus', 20), el('span', { text: 'New Playlist' }))));
    host.append(rows);
  }
}

function countFooter(tracks) {
  const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  return el('p', {
    text: plural(tracks.length, 'song') + ' · ' + formatDurationLong(total),
    style: { textAlign: 'center', color: 'var(--text-faint)', fontSize: '13px', padding: '20px 0 6px' },
  });
}

/**
 * A crate of records you push through with a thumb.
 *
 * The one at the front stands upright and names itself; the rest lean back
 * behind it and go dark, so depth does the work a grid would do with size.
 * Dragging moves the stack, and each sleeve that passes gives a tick, which
 * is what flipping through a real crate feels like.
 */
function crate(albums) {
  const wrap = el('div', { class: 'crate-wrap' });
  const box = el('div', { class: 'crate' });
  wrap.append(box);
  if (!albums.length) return wrap;

  let index = 0;
  let offset = 0;   // fractional position while a drag is in flight

  const cards = albums.map((album) => {
    const card = el('button', { class: 'card', 'aria-label': album.name + ', ' + album.artist },
      artNode(album.artworkKey));
    box.append(card);
    return card;
  });

  // The name belongs on the divider in front of the crate, not printed across
  // the sleeves, so it lives outside the box.
  const count = el('span', { class: 'crate-count silk' });
  box.append(count);

  const title = el('div', { class: 'crate-title' });
  const artist = el('div', { class: 'crate-artist silk' });
  wrap.append(el('div', { class: 'crate-caption' }, title, artist));

  const layout = () => {
    const position = index + offset;
    cards.forEach((card, i) => {
      const d = i - position;              // sleeves ahead are positive
      const behind = Math.max(0, d);
      const visible = d > -1.4 && d < 7;

      card.hidden = !visible;
      if (!visible) return;

      // Each one further back sits deeper, higher and leaning away.
      const z = -behind * 52;
      const y = -behind * 7;
      const x = d < 0 ? d * 240 : behind * 9;
      const rotateY = d < 0 ? -46 : -7 - behind * 1.6;
      const rotateX = 4 + behind * 0.7;

      card.style.transform =
        'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,' + z.toFixed(1) + 'px)'
        + ' rotateY(' + rotateY.toFixed(1) + 'deg) rotateX(' + rotateX.toFixed(1) + 'deg)';
      card.style.opacity = d < -0.6 ? '0' : '1';
      card.style.filter = 'brightness(' + Math.max(0.32, 1 - behind * 0.16).toFixed(2) + ')';
      card.style.zIndex = String(50 - Math.round(behind));
      card.classList.toggle('front', Math.round(position) === i);
    });

    const at = Math.min(albums.length - 1, Math.max(0, Math.round(position)));
    count.textContent = (at + 1) + ' of ' + albums.length;
    title.textContent = albums[at].name;
    artist.textContent = albums[at].artist;
  };

  cards.forEach((card, i) => {
    card.addEventListener('click', () => {
      if (dragged > 8) return;             // that was a flip, not a tap
      if (i !== index) {
        index = i;
        layout();
        tick();
        return;
      }
      press();
      router({ view: 'album', key: albums[i].key });
    });
  });

  /* ------------------------------------------------------------- flipping */

  let startX = 0;
  let dragged = 0;
  let flipping = false;
  let lastStep = 0;
  const STEP = 62;                          // pixels per sleeve

  box.addEventListener('pointerdown', (event) => {
    flipping = true;
    dragged = 0;
    lastStep = 0;
    startX = event.clientX;
    box.classList.add('dragging');
  });

  box.addEventListener('pointermove', (event) => {
    if (!flipping) return;
    const dx = event.clientX - startX;
    dragged = Math.max(dragged, Math.abs(dx));
    // Capture only once this is really a flip. Capturing on pointerdown
    // retargets the click to the crate, and a plain tap stops opening.
    if (dragged > 6 && !box.hasPointerCapture(event.pointerId)) {
      box.setPointerCapture(event.pointerId);
    }
    offset = Math.max(-index, Math.min(albums.length - 1 - index, -dx / STEP));

    const step = Math.round(offset);
    if (step !== lastStep) { lastStep = step; tick(); }
    layout();
  });

  const drop = () => {
    if (!flipping) return;
    flipping = false;
    box.classList.remove('dragging');
    index = Math.min(albums.length - 1, Math.max(0, Math.round(index + offset)));
    offset = 0;
    layout();
  };

  box.addEventListener('pointerup', drop);
  box.addEventListener('pointercancel', drop);

  layout();
  return wrap;
}

/* ------------------------------------------------------------------ search */

export function renderSearch(host, query) {
  clear(host);

  if (!query.trim()) {
    const genres = library.genres.slice(0, 12);
    if (genres.length) {
      host.append(el('h2', { class: 'section-title', text: 'Browse' }));
      host.append(el('div', { class: 'chip-row' }, genres.map((g) => el('button', {
        class: 'chip',
        text: g.name,
        onclick: () => router({ view: 'genre', key: g.name }),
      }))));
    }
    return;
  }

  const results = library.search(query);
  const total = results.tracks.length + results.albums.length + results.artists.length + results.playlists.length;

  if (!total) {
    host.append(emptyState({ icon: 'search', title: 'No results', body: 'Nothing in your library matches "' + query + '".' }));
    return;
  }

  if (results.artists.length) {
    host.append(el('h2', { class: 'section-title', text: 'Artists' }));
    host.append(el('div', { class: 'shelf-scroll' }, results.artists.map(artistCard)));
  }
  if (results.albums.length) {
    host.append(el('h2', { class: 'section-title', text: 'Albums' }));
    host.append(el('div', { class: 'shelf-scroll' }, results.albums.map(albumCard)));
  }
  if (results.playlists.length) {
    host.append(el('h2', { class: 'section-title', text: 'Playlists' }));
    const rows = el('div', { class: 'rows' });
    for (const pl of results.playlists) {
      const tracks = library.resolve(pl.trackIds);
      const row = el('button', { class: 'row' },
        artNode(tracks[0] && tracks[0].artworkKey),
        el('span', { class: 'row-text' },
          el('span', { class: 'row-title', text: pl.name }),
          el('span', { class: 'row-sub' }, el('span', { text: plural(tracks.length, 'song') }))));
      row.addEventListener('click', () => router({ view: 'playlist', key: pl.id }));
      rows.append(row);
    }
    host.append(rows);
  }
  if (results.tracks.length) {
    host.append(el('h2', { class: 'section-title', text: 'Songs' }));
    host.append(trackList(results.tracks));
  }
}

/* ------------------------------------------------------------------ detail */

export async function renderDetail(host, route) {
  clear(host);

  const back = el('div', { class: 'back-bar' },
    el('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => history.back() }, icon('back')));
  host.append(back);

  if (route.view === 'album') return renderAlbum(host, route.key);
  if (route.view === 'artist') return renderArtist(host, route.key);
  if (route.view === 'genre') return renderGenre(host, route.key);
  if (route.view === 'playlist') return renderPlaylist(host, route.key);
  return undefined;
}

async function heroBlock(host, { artworkKey, title, subtitle, meta, round = false, tracks, actions }) {
  const hero = el('div', { class: 'detail-hero' + (round ? ' round' : '') },
    artNode(artworkKey),
    el('div', { class: 'detail-title', text: title }),
    subtitle ? el('div', { class: 'detail-sub', text: subtitle }) : null,
    meta ? el('div', { class: 'detail-meta', text: meta }) : null);

  const url = await artworkUrl(artworkKey);
  if (url) hero.style.setProperty('--hero-bg', 'url(' + JSON.stringify(url) + ') center/cover');

  const buttons = el('div', { class: 'detail-actions' },
    el('button', { class: 'btn', onclick: () => player.play(tracks, 0) },
      icon('play', 20), el('span', { text: 'Play' })),
    el('button', {
      class: 'btn secondary',
      onclick: () => { player.setShuffle(true); player.play(tracks, Math.floor(Math.random() * Math.max(1, tracks.length))); },
    }, icon('shuffle', 20), el('span', { text: 'Shuffle' })));
  if (actions) buttons.append(actions);
  hero.append(buttons);

  host.append(hero);
}

async function renderAlbum(host, key) {
  const album = library.albums.find((a) => a.key === key);
  if (!album) { host.append(emptyState({ icon: 'note', title: 'Album not found', body: 'It may have been deleted.' })); return; }

  const total = album.tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  await heroBlock(host, {
    artworkKey: album.artworkKey,
    title: album.name,
    subtitle: album.artist,
    meta: [album.year, plural(album.tracks.length, 'song'), formatDurationLong(total)].filter(Boolean).join(' · '),
    tracks: album.tracks,
  });

  host.append(el('div', { class: 'detail-body' },
    trackList(album.tracks, { showNumber: true, showArt: false, hideArtist: album.artist })));
}

async function renderArtist(host, key) {
  const artist = library.artists.find((a) => a.key === key);
  if (!artist) { host.append(emptyState({ icon: 'note', title: 'Artist not found', body: 'They may have been deleted.' })); return; }

  await heroBlock(host, {
    artworkKey: artist.artworkKey,
    title: artist.name,
    meta: plural(artist.albums.size, 'album') + ' · ' + plural(artist.tracks.length, 'song'),
    round: true,
    tracks: artist.tracks,
  });

  const body = el('div', { class: 'detail-body' });
  const albums = library.albums.filter((a) => a.artist === artist.name);
  if (albums.length) {
    body.append(el('h2', { class: 'section-title', text: 'Albums' }));
    body.append(el('div', { class: 'shelf-scroll' }, albums.map(albumCard)));
  }
  body.append(el('h2', { class: 'section-title', text: 'Songs' }));
  body.append(trackList(artist.tracks));
  host.append(body);
}

async function renderGenre(host, name) {
  const genre = library.genres.find((g) => g.name === name);
  if (!genre) { host.append(emptyState({ icon: 'note', title: 'Genre not found', body: '' })); return; }

  await heroBlock(host, {
    artworkKey: genre.artworkKey,
    title: genre.name,
    meta: plural(genre.tracks.length, 'song'),
    tracks: genre.tracks,
  });
  host.append(el('div', { class: 'detail-body' }, trackList(genre.tracks)));
}

async function renderPlaylist(host, id) {
  const pl = library.playlists.find((p) => p.id === id);
  const isLiked = id === LIKED_ID;
  if (!pl && !isLiked) {
    host.append(emptyState({ icon: 'note', title: 'Playlist not found', body: 'It may have been deleted.' }));
    return;
  }

  const tracks = isLiked ? library.likedTracks : library.resolve(pl.trackIds);
  const name = isLiked ? 'Liked Songs' : pl.name;
  const total = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

  const actions = isLiked ? null : el('button', {
    class: 'icon-btn',
    'aria-label': 'Playlist options',
    onclick: () => menuSheet(name, [
      {
        label: 'Rename',
        icon: 'eq',
        onSelect: async () => {
          const next = await promptSheet({ title: 'Rename Playlist', label: 'Name', value: name });
          if (next) { await library.renamePlaylist(id, next); router({ view: 'playlist', key: id }, true); }
        },
      },
      {
        label: 'Add Songs',
        icon: 'plus',
        onSelect: () => pickTracksSheet(id),
      },
      {
        label: 'Delete Playlist',
        icon: 'trash',
        destructive: true,
        onSelect: async () => {
          const yes = await confirmSheet({
            title: 'Delete this playlist?',
            message: 'The songs stay in your library.',
            confirmLabel: 'Delete',
            destructive: true,
          });
          if (!yes) return;
          await library.deletePlaylist(id);
          history.back();
        },
      },
    ]),
  }, icon('more'));

  await heroBlock(host, {
    artworkKey: tracks[0] && tracks[0].artworkKey,
    title: name,
    meta: plural(tracks.length, 'song') + (total ? ' · ' + formatDurationLong(total) : ''),
    tracks,
    actions,
  });

  const body = el('div', { class: 'detail-body' });
  if (!tracks.length) {
    body.append(emptyState({
      icon: isLiked ? 'heart' : 'library',
      title: isLiked ? 'No liked songs yet' : 'This playlist is empty',
      body: isLiked
        ? 'Tap the heart on any song, or on the player, to save it here. Songs pulled in from a link land here too.'
        : 'Add songs from the library, or from any song menu.',
      action: isLiked ? null : { label: 'Add songs', onSelect: () => pickTracksSheet(id) },
    }));
  } else {
    body.append(trackList(tracks, { playlistId: id }));
  }
  host.append(body);
}

/** Multi-select picker for adding library songs to a playlist. */
function pickTracksSheet(playlistId) {
  const chosen = new Set();
  menuSheet(null, [], el('div', {}, (() => {
    const wrap = el('div', {});
    wrap.append(el('h2', { text: 'Add Songs' }));

    const search = el('input', { type: 'search', placeholder: 'Filter songs' });
    wrap.append(el('div', { class: 'field' }, search));

    const list = el('div', { class: 'rows', style: { maxHeight: '46vh', overflowY: 'auto' } });
    const confirm = el('button', { class: 'btn wide', text: 'Add 0 songs', disabled: true });

    const paint = () => {
      clear(list);
      const q = search.value.trim().toLowerCase();
      const songs = library.songs.filter((t) => !q || (t.title + ' ' + t.artist).toLowerCase().includes(q));
      for (const track of songs.slice(0, 200)) {
        const row = el('button', { class: 'row' },
          artNode(track.artworkKey),
          el('span', { class: 'row-text' },
            el('span', { class: 'row-title', text: track.title }),
            el('span', { class: 'row-sub' }, el('span', { text: track.artist }))),
          chosen.has(track.id) ? el('span', { class: 'check', style: { color: 'var(--accent)' } }, icon('check', 22)) : null);
        row.addEventListener('click', () => {
          if (chosen.has(track.id)) chosen.delete(track.id);
          else chosen.add(track.id);
          confirm.textContent = 'Add ' + plural(chosen.size, 'song');
          confirm.disabled = chosen.size === 0;
          paint();
        });
        list.append(row);
      }
    };

    search.addEventListener('input', paint);
    paint();

    confirm.addEventListener('click', async () => {
      await library.addToPlaylist(playlistId, [...chosen]);
      toast('Added ' + plural(chosen.size, 'song'));
      closeSheet();
      router({ view: 'playlist', key: playlistId }, true);
    });

    wrap.append(list, confirm);
    return wrap;
  })()));
}
