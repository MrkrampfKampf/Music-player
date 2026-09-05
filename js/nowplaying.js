/**
 * The full-screen player: artwork, scrubber, transport, lyrics and Up Next.
 *
 * The accent colour is pulled from the current album art and written to
 * --accent on the root element, so the whole app takes on the colour of what
 * is playing, the way Apple Music does.
 */

import { player, REPEAT } from './player.js';
import { library } from './library.js';
import * as db from './db.js';
import { activeLineIndex } from './lyrics.js';
import {
  el, icon, clear, artworkUrl, accentFromArtwork, formatTime,
  bindRangePaint, paintRange, makeSortable, menuSheet, toast, artNode,
} from './ui.js';

const DEFAULT_ACCENT = '#ff2d55';

let open = false;
let scrubbing = false;
let lyricsVisible = false;
let currentLyrics = null;
let lyricNodes = [];
let lastLyricIndex = -1;

const $ = (id) => document.getElementById(id);

export function initNowPlaying() {
  const np = $('np');

  player.attachVideo($('np-video'));

  $('mini').addEventListener('click', (event) => {
    if (event.target.closest('#mini-play') || event.target.closest('#mini-next')) return;
    openPlayer();
  });
  $('mini-play').addEventListener('click', (event) => { event.stopPropagation(); player.toggle(); });
  $('mini-next').addEventListener('click', (event) => { event.stopPropagation(); player.next(); });

  // Going back is what actually closes the player, so the pushed history
  // entry is consumed rather than left behind for the next back gesture.
  $('np-close').addEventListener('click', () => history.back());
  $('np-play').addEventListener('click', () => player.toggle());
  $('np-next').addEventListener('click', () => player.next());
  $('np-prev').addEventListener('click', () => player.previous());
  $('np-shuffle').addEventListener('click', () => { player.setShuffle(!player.shuffle); paintModes(); });
  $('np-repeat').addEventListener('click', () => { player.cycleRepeat(); paintModes(); });

  $('np-like').addEventListener('click', async () => {
    if (!player.current) return;
    const liked = await library.toggleLike(player.current.id);
    player.current = library.get(player.current.id) || player.current;
    paintLike();
    toast(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
  });

  const seek = $('np-seek');
  bindRangePaint(seek);
  const beginScrub = () => { scrubbing = true; };
  const endScrub = () => {
    if (!scrubbing) return;
    scrubbing = false;
    const d = player.duration;
    if (d) player.seek((seek.value / 1000) * d);
  };
  seek.addEventListener('pointerdown', beginScrub);
  seek.addEventListener('touchstart', beginScrub, { passive: true });
  seek.addEventListener('input', () => {
    paintRange(seek);
    const d = player.duration;
    if (d) {
      $('np-elapsed').textContent = formatTime((seek.value / 1000) * d);
      $('np-remain').textContent = '-' + formatTime(Math.ceil(d - (seek.value / 1000) * d));
    }
  });
  seek.addEventListener('change', endScrub);
  seek.addEventListener('pointerup', endScrub);
  seek.addEventListener('touchend', endScrub);

  const vol = $('np-vol');
  bindRangePaint(vol);
  vol.addEventListener('input', () => { paintRange(vol); player.setVolume(vol.value / 100); });

  // iOS ignores element volume, so only show the slider where it does something.
  if (!supportsVolume()) $('np-volume').hidden = true;

  $('np-lyrics-btn').addEventListener('click', toggleLyrics);
  $('np-queue-btn').addEventListener('click', openQueue);
  $('np-speed-btn').addEventListener('click', speedMenu);
  $('np-airplay-btn').addEventListener('click', showAirplay);

  $('queue-close').addEventListener('click', () => { $('queue-sheet').hidden = true; });
  $('queue-clear').addEventListener('click', () => { player.clearQueue(); renderQueue(); });

  makeSortable($('queue-list'), {
    onReorder: (from, to) => { player.moveInQueue(from, to); renderQueue(); },
  });

  attachDragToDismiss(np);

  player.addEventListener('trackchange', onTrackChange);
  player.addEventListener('statechange', paintState);
  player.addEventListener('timeupdate', paintTime);
  player.addEventListener('queuechange', () => { if (!$('queue-sheet').hidden) renderQueue(); });
  player.addEventListener('modechange', paintModes);
  player.addEventListener('error', (event) => {
    toast('Playback problem', { detail: event.detail.message, error: true, duration: 6000 });
  });
  player.addEventListener('needsgesture', () => {
    toast('Tap play to start', { detail: 'iOS needs a tap before it will start audio.', duration: 5000 });
  });

  document.addEventListener('lyricschange', (event) => {
    if (player.current && event.detail.trackId === player.current.id) loadLyrics(player.current);
  });

  library.addEventListener('change', () => {
    if (player.current) {
      const fresh = library.get(player.current.id);
      if (fresh) { player.current = fresh; paintLike(); }
    }
  });

  paintModes();
  paintState();
}

export function isPlayerOpen() {
  return open;
}

export function openPlayer() {
  if (!player.current) return;
  const np = $('np');
  open = true;
  np.hidden = false;
  np.classList.add('opening');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => np.classList.remove('opening'));
  });
  document.body.style.overflow = 'hidden';
  history.pushState({ player: true }, '');
}

export function closePlayer() {
  const np = $('np');
  if (!open) return;
  open = false;
  np.classList.add('closing');
  document.body.style.overflow = '';
  $('queue-sheet').hidden = true;
  setTimeout(() => {
    np.hidden = true;
    np.classList.remove('closing');
    np.style.transform = '';
  }, 340);
}

/* ------------------------------------------------------------------ paint */

async function onTrackChange() {
  const track = player.current;

  if (!track) {
    $('mini').hidden = true;
    document.body.classList.add('no-mini');
    setAccent(DEFAULT_ACCENT);
    return;
  }

  $('mini').hidden = false;
  document.body.classList.remove('no-mini');

  $('mini-title').textContent = track.title;
  $('mini-sub').textContent = track.artist;
  $('np-title').textContent = track.title;
  $('np-sub').textContent = track.artist + (track.album ? ' — ' + track.album : '');

  // Video plays on its own surface; artwork steps aside.
  const isVideo = track.kind === 'video';
  $('np-art').hidden = isVideo;
  $('np-video').hidden = !isVideo;
  if (isVideo) {
    lyricsVisible = false;
    $('np-lyrics').hidden = true;
    $('np-lyrics-btn').classList.remove('on');
  }

  const url = await artworkUrl(track.artworkKey);
  $('mini-img').src = url || 'icons/icon-192.png';
  $('np-img').src = url || 'icons/icon-512.png';
  $('np-bg').style.backgroundImage = url ? 'url(' + JSON.stringify(url) + ')' : 'none';

  const accent = await accentFromArtwork(track.artworkKey);
  setAccent(accent ? accent.hex : DEFAULT_ACCENT);

  paintLike();
  paintState();
  loadLyrics(track);
  if (!$('queue-sheet').hidden) renderQueue();
}

function setAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  const rgb = hexToRgb(hex);
  if (rgb) {
    document.documentElement.style.setProperty('--accent-soft', 'rgba(' + rgb.join(',') + ',0.16)');
  }
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', getComputedStyle(document.body).backgroundColor);
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function paintState() {
  const playing = player.playing;
  const glyph = playing ? '#i-pause' : '#i-play';
  $('np-play').querySelector('use').setAttribute('href', glyph);
  $('mini-play').querySelector('use').setAttribute('href', glyph);
  $('np-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('np').classList.toggle('paused', !playing);
}

function paintTime() {
  const d = player.duration;
  const t = player.currentTime;

  if (!scrubbing) {
    const seek = $('np-seek');
    seek.value = d ? Math.round((t / d) * 1000) : 0;
    paintRange(seek);
    $('np-elapsed').textContent = formatTime(t);
    $('np-remain').textContent = d ? '-' + formatTime(Math.ceil(Math.max(0, d - t))) : '--:--';
  }

  $('mini-bar').style.width = (d ? (t / d) * 100 : 0) + '%';
  if (lyricsVisible) paintLyrics(t);
}

function paintLike() {
  const liked = !!(player.current && player.current.liked);
  const btn = $('np-like');
  btn.classList.toggle('on', liked);
  btn.querySelector('use').setAttribute('href', liked ? '#i-heart-fill' : '#i-heart');
  btn.setAttribute('aria-label', liked ? 'Remove from Liked Songs' : 'Add to Liked Songs');
}

function paintModes() {
  $('np-shuffle').classList.toggle('on', player.shuffle);

  const repeatBtn = $('np-repeat');
  repeatBtn.classList.toggle('on', player.repeat !== REPEAT.OFF);
  repeatBtn.setAttribute('aria-label', 'Repeat: ' + player.repeat);
  // Repeat-one gets a "1" badge drawn over the icon.
  let badge = repeatBtn.querySelector('.repeat-one');
  if (player.repeat === REPEAT.ONE) {
    if (!badge) {
      badge = el('span', {
        class: 'repeat-one',
        text: '1',
        style: {
          position: 'absolute', fontSize: '9px', fontWeight: '800',
          transform: 'translate(11px, 6px)', pointerEvents: 'none',
        },
      });
      repeatBtn.style.position = 'relative';
      repeatBtn.append(badge);
    }
  } else if (badge) {
    badge.remove();
  }

  $('np-speed-label').textContent = formatRate(player.playbackRate);
  $('np-speed-btn').classList.toggle('on', player.playbackRate !== 1);

  const vol = $('np-vol');
  if (vol) { vol.value = Math.round(player.volume * 100); paintRange(vol); }
}

function formatRate(rate) {
  return (Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0$/, '')) + 'x';
}

/* ----------------------------------------------------------------- lyrics */

async function loadLyrics(track) {
  currentLyrics = await db.getLyrics(track.id);
  lastLyricIndex = -1;
  if (lyricsVisible) renderLyrics();
  $('np-lyrics-btn').style.opacity = currentLyrics ? '1' : '0.55';
}

function toggleLyrics() {
  if (player.isVideo) { toast('Lyrics are for audio tracks.'); return; }
  lyricsVisible = !lyricsVisible;
  $('np-lyrics').hidden = !lyricsVisible;
  $('np-art').style.opacity = lyricsVisible ? '0' : '1';
  $('np-lyrics-btn').classList.toggle('on', lyricsVisible);
  if (lyricsVisible) renderLyrics();
}

function renderLyrics() {
  const host = clear($('np-lyrics'));
  lyricNodes = [];
  lastLyricIndex = -1;

  if (!currentLyrics) {
    host.append(el('div', { class: 'lyrics-empty' },
      el('p', { text: 'No lyrics for this song yet.', style: { margin: '0 0 14px' } }),
      el('button', {
        class: 'btn secondary',
        text: 'Import .lrc or .txt',
        onclick: () => importLyricsFor(player.current),
      })));
    return;
  }

  if (currentLyrics.kind === 'synced') {
    for (const line of currentLyrics.lines) {
      const node = el('p', { text: line.text || '♪' });
      lyricNodes.push(node);
      host.append(node);
    }
    paintLyrics(player.currentTime);
  } else {
    for (const line of currentLyrics.text.split('\n')) {
      host.append(el('p', { class: 'plain', text: line || ' ' }));
    }
  }
}

function paintLyrics(time) {
  if (!currentLyrics || currentLyrics.kind !== 'synced' || !lyricNodes.length) return;
  const index = activeLineIndex(currentLyrics.lines, time);
  if (index === lastLyricIndex) return;

  if (lastLyricIndex >= 0 && lyricNodes[lastLyricIndex]) {
    lyricNodes[lastLyricIndex].classList.remove('active');
  }
  lastLyricIndex = index;
  if (index < 0) return;

  const node = lyricNodes[index];
  if (!node) return;
  node.classList.add('active');

  const host = $('np-lyrics');
  const target = node.offsetTop - host.clientHeight * 0.38;
  host.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

function importLyricsFor(track) {
  if (!track) return;
  const input = document.getElementById('lrc-input');
  input.value = '';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const { parseLyricsFile } = await import('./lyrics.js');
    const parsed = parseLyricsFile(await file.text());
    if (!parsed) { toast('That file had no readable lyrics.', { error: true }); return; }
    await db.putLyrics(track.id, parsed);
    currentLyrics = parsed;
    renderLyrics();
    toast(parsed.kind === 'synced' ? 'Synced lyrics added' : 'Lyrics added');
  };
  input.click();
}

/* ------------------------------------------------------------------ queue */

function openQueue() {
  $('queue-sheet').hidden = false;
  renderQueue();
}

function renderQueue() {
  const list = clear($('queue-list'));
  const tracks = library.resolve(player.queue);

  if (!tracks.length) {
    list.append(el('li', { class: 'lyrics-empty', text: 'The queue is empty.', style: { padding: '30px 0', textAlign: 'center', color: 'var(--text-dim)' } }));
    return;
  }

  tracks.forEach((track, index) => {
    const item = el('li', { class: 'queue-item' + (index === player.index ? ' current' : '') });

    item.append(el('span', { class: 'drag-handle' }, icon('queue', 18)));
    item.append(artNode(track.artworkKey));

    const text = el('button', {
      class: 'row-text',
      style: { textAlign: 'left', flex: '1', minWidth: '0' },
      onclick: () => player.jumpTo(index),
    },
    el('span', { class: 'row-title', text: track.title }),
    el('span', { class: 'row-sub' }, el('span', { text: track.artist })));
    item.append(text);

    item.append(el('button', {
      class: 'icon-btn row-more',
      'aria-label': 'Remove from queue',
      onclick: () => { player.removeFromQueue(index); renderQueue(); },
    }, icon('x')));

    list.append(item);
  });
}

/* ------------------------------------------------------------------ tools */

function speedMenu() {
  const rates = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  menuSheet('Playback Speed', rates.map((rate) => ({
    label: formatRate(rate) + (rate === 1 ? ' (normal)' : ''),
    icon: 'speed',
    checked: player.playbackRate === rate,
    onSelect: () => { player.setRate(rate); paintModes(); },
  })));
}

function showAirplay() {
  const media = player.media;
  // Safari exposes a native route picker; everything else gets an explanation.
  if (media && typeof media.webkitShowPlaybackTargetPicker === 'function') {
    media.webkitShowPlaybackTargetPicker();
    return;
  }
  toast('AirPlay from Control Centre', {
    detail: 'Swipe down from the top-right of your screen and pick a speaker there. '
      + 'Web apps cannot open the picker directly on this version of iOS.',
    duration: 7000,
  });
}

function supportsVolume() {
  try {
    const probe = new Audio();
    probe.volume = 0.42;
    return Math.abs(probe.volume - 0.42) < 0.01;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- drag to dismiss */

function attachDragToDismiss(np) {
  let startY = 0;
  let dy = 0;
  let dragging = false;

  const inner = np.querySelector('.np-inner');

  inner.addEventListener('touchstart', (event) => {
    // Only start a dismiss from the top area, so lyrics and the queue scroll.
    if (event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    if (y > window.innerHeight * 0.3) return;
    if (event.target.closest('input, .np-lyrics, .queue-sheet')) return;
    startY = y;
    dy = 0;
    dragging = true;
  }, { passive: true });

  inner.addEventListener('touchmove', (event) => {
    if (!dragging) return;
    dy = event.touches[0].clientY - startY;
    if (dy < 0) dy = 0;
    np.style.transition = 'none';
    np.style.transform = 'translateY(' + dy + 'px)';
  }, { passive: true });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    np.style.transition = '';
    if (dy > 110) {
      np.style.transform = '';
      history.back();
    } else {
      np.style.transform = '';
    }
  };

  inner.addEventListener('touchend', finish);
  inner.addEventListener('touchcancel', finish);
}
