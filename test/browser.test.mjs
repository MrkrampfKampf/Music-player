/**
 * End-to-end browser test.
 *
 * Builds real tagged WAV files, drives the app in Chromium, and checks the
 * whole path: import, tag reading, artwork, grouping, playback of actual
 * audio, seeking, the queue, likes, playlists, search, the equaliser graph,
 * and that everything survives a reload.
 *
 * Needs Playwright. Serve the app first, then run this:
 *   npx http-server -p 8099 -c-1 .
 *   node test/browser.test.mjs http://127.0.0.1:8099
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const { files, cleanup } = makeFixtures();

const errors = [];
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3 });
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url().slice(0, 140) + ' :: ' + ((r.failure() || {}).errorText)));

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

/* ------------------------------------------------------------------ import */
console.log('Import');
await page.setInputFiles('#file-input', files);
await page.waitForTimeout(6000);

const lib = await page.evaluate(async () => {
  const { library } = await import('./js/library.js');
  return {
    count: library.tracks.length,
    albums: library.albums.map((a) => ({ name: a.name, artist: a.artist, n: a.tracks.length, art: !!a.artworkKey })),
    artists: library.artists.map((a) => a.name),
    genres: library.genres.map((g) => g.name),
    first: library.songs[0] && {
      title: library.songs[0].title, artist: library.songs[0].artist, album: library.songs[0].album,
      codec: library.songs[0].codec, sampleRate: library.songs[0].sampleRate, bitDepth: library.songs[0].bitDepth,
      duration: Math.round(library.songs[0].duration * 10) / 10, lossless: library.songs[0].lossless,
      trackNo: library.songs[0].trackNo, year: library.songs[0].year, art: !!library.songs[0].artworkKey,
    },
  };
});

check('imported all 5 files', lib.count === 5, 'got ' + lib.count);
check('grouped into 2 albums', lib.albums.length === 2, JSON.stringify(lib.albums));
check('Daybreak has 3 tracks', (lib.albums.find((a) => a.name === 'Daybreak') || {}).n === 3);
check('Transit has 2 tracks', (lib.albums.find((a) => a.name === 'Transit') || {}).n === 2);
check('albums carry artwork', lib.albums.every((a) => a.art));
check('2 artists', lib.artists.length === 2, JSON.stringify(lib.artists));
check('genres read from tags', lib.genres.includes('Ambient') && lib.genres.includes('Electronic'), JSON.stringify(lib.genres));
console.log('  first track:', JSON.stringify(lib.first));
check('title from ID3 in WAV', lib.first.title === 'First Light');
check('artist from ID3', lib.first.artist === 'Aurora Fields');
check('album from ID3', lib.first.album === 'Daybreak');
check('year from ID3', lib.first.year === 2024);
check('track number from ID3', lib.first.trackNo === 1);
check('artwork extracted', lib.first.art === true);
check('codec detected', lib.first.codec === 'PCM 16-bit', lib.first.codec);
check('sample rate', lib.first.sampleRate === 44100);
check('bit depth', lib.first.bitDepth === 16);
check('lossless flagged', lib.first.lossless === true);
check('duration ~6s', Math.abs(lib.first.duration - 6) < 0.2, String(lib.first.duration));

/* ----------------------------------------------------------------- library */
console.log('Library views');
await page.click('[data-nav="library"]');
await page.waitForTimeout(500);
check('songs listed', (await page.locator('[data-view="library"] .row').count()) === 5);

await page.click('#library-tabs [data-tab="albums"]');
await page.waitForTimeout(400);
check('album grid', (await page.locator('[data-view="library"] .grid .card').count()) === 2);

await page.click('#library-tabs [data-tab="artists"]');
await page.waitForTimeout(400);
check('artist grid', (await page.locator('[data-view="library"] .grid .card').count()) === 2);

/* ------------------------------------------------------------ album detail */
await page.click('#library-tabs [data-tab="albums"]');
await page.waitForTimeout(400);
await page.locator('[data-view="library"] .grid .card').first().click();
await page.waitForTimeout(700);
check('album detail opened', await page.isVisible('[data-view="detail"] .detail-hero'));
const albumTitle = await page.textContent('.detail-title');
check('album title shown', !!albumTitle, albumTitle);

/* -------------------------------------------------------------- play a song */
console.log('Playback');
await page.locator('[data-view="detail"] .row').first().click();
await page.waitForTimeout(2500);

const play1 = await page.evaluate(async () => {
  const { player } = await import('./js/player.js');
  return {
    title: player.current && player.current.title,
    playing: player.playing,
    time: player.currentTime,
    duration: Math.round(player.duration * 10) / 10,
    queue: player.queue.length,
    index: player.index,
  };
});
console.log('  ', JSON.stringify(play1));
check('a track is loaded', !!play1.title, JSON.stringify(play1));
check('audio is actually playing', play1.playing === true);
check('playhead advanced', play1.time > 0.3, String(play1.time));
check('duration decoded', play1.duration > 5, String(play1.duration));
check('queue is the album', play1.queue === 3, String(play1.queue));
check('mini player visible', await page.isVisible('#mini'));

/* ------------------------------------------------------------- now playing */
await page.click('#mini');
await page.waitForTimeout(900);
check('now playing opened', await page.isVisible('#np'));
const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
check('accent taken from artwork', accent && accent !== '#ff2d55', accent);
console.log('   accent:', accent);

/* ------------------------------------------------------------------- like */
await page.click('#np-like');
await page.waitForTimeout(700);
const liked = await page.evaluate(async () => {
  const { library } = await import('./js/library.js');
  return library.likedTracks.map((t) => t.title);
});
check('like saved to Liked Songs', liked.length === 1, JSON.stringify(liked));

/* -------------------------------------------------------------------- next */
await page.click('#np-next');
await page.waitForTimeout(2000);
const play2 = await page.evaluate(async () => {
  const { player } = await import('./js/player.js');
  return { title: player.current && player.current.title, playing: player.playing, index: player.index, time: player.currentTime };
});
console.log('  ', JSON.stringify(play2));
check('advanced to next track', play2.index === 1 && play2.title !== play1.title, JSON.stringify(play2));
check('still playing after skip', play2.playing === true);
check('new track is playing audio', play2.time > 0.2, String(play2.time));

const accent2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
check('accent follows the track', !!accent2);

/* ------------------------------------------------------------------- seek */
await page.evaluate(async () => { const { player } = await import('./js/player.js'); player.seek(3); });
await page.waitForTimeout(600);
const sought = await page.evaluate(async () => { const { player } = await import('./js/player.js'); return player.currentTime; });
check('seek works', sought > 2.8, String(sought));

/* ------------------------------------------------------------------ queue */
await page.click('#np-queue-btn');
await page.waitForTimeout(500);
check('queue sheet opens', await page.isVisible('#queue-sheet'));
check('queue lists tracks', (await page.locator('#queue-list .queue-item').count()) === 3);
await page.click('#queue-close');
await page.waitForTimeout(300);

/* --------------------------------------------------------------- shuffle */
await page.click('#np-shuffle');
await page.waitForTimeout(400);
const shuffled = await page.evaluate(async () => { const { player } = await import('./js/player.js'); return { on: player.shuffle, len: player.queue.length }; });
check('shuffle toggles', shuffled.on === true && shuffled.len === 3, JSON.stringify(shuffled));
await page.click('#np-shuffle');
await page.waitForTimeout(300);

/* ---------------------------------------------------------------- repeat */
await page.click('#np-repeat');
await page.waitForTimeout(250);
const rep = await page.evaluate(async () => { const { player } = await import('./js/player.js'); return player.repeat; });
check('repeat cycles to all', rep === 'all', rep);

/* --------------------------------------------------------------- lyrics */
await page.click('#np-lyrics-btn');
await page.waitForTimeout(500);
check('lyrics pane opens', await page.isVisible('#np-lyrics'));
await page.click('#np-lyrics-btn');
await page.waitForTimeout(300);

/* -------------------------------------------------------------- playlists */
console.log('Playlists');
await page.evaluate(async () => {
  const { library } = await import('./js/library.js');
  const pl = await library.createPlaylist('Road Trip', library.songs.slice(0, 3).map((t) => t.id));
  return pl.id;
});
await page.waitForTimeout(500);
const pls = await page.evaluate(async () => {
  const { library } = await import('./js/library.js');
  return library.playlists.map((p) => ({ name: p.name, n: p.trackIds.length }));
});
check('playlist created with tracks', pls.some((p) => p.name === 'Road Trip' && p.n === 3), JSON.stringify(pls));

/* ----------------------------------------------------------------- search */
console.log('Search');
await page.evaluate(() => { const np = document.getElementById('np'); np.hidden = true; document.body.style.overflow = ''; });
await page.click('[data-nav="search"]');
await page.waitForTimeout(400);
await page.fill('#search-input', 'night');
await page.waitForTimeout(600);
const searchRows = await page.locator('[data-view="search"] .row').count();
check('search finds Night Bus tracks', searchRows >= 2, String(searchRows));

await page.fill('#search-input', 'first light');
await page.waitForTimeout(600);
check('search finds by title', (await page.locator('[data-view="search"] .row').count()) >= 1);

/* --------------------------------------------------------------- settings */
console.log('Settings and equaliser');
await page.click('[data-nav="settings"]');
await page.waitForTimeout(500);
const eqToggle = page.locator('[data-view="settings"] .switch').nth(1);
await eqToggle.click();
await page.waitForTimeout(800);
const eqOn = await page.evaluate(async () => {
  const { player } = await import('./js/player.js');
  return { enabled: player.eqEnabled, ctx: !!player._ctx, filters: player._filters ? player._filters.length : 0 };
});
check('equaliser builds the audio graph', eqOn.enabled && eqOn.ctx && eqOn.filters === 10, JSON.stringify(eqOn));
check('eq sliders rendered', (await page.locator('.eq-band').count()) === 10);

const stillPlaying = await page.evaluate(async () => { const { player } = await import('./js/player.js'); return player.playing; });
check('audio survives the graph rebuild', stillPlaying === true);

/* ------------------------------------------------------------- persistence */
console.log('Reload and restore');
await page.waitForTimeout(1200);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const after = await page.evaluate(async () => {
  const { library } = await import('./js/library.js');
  const { player } = await import('./js/player.js');
  return {
    tracks: library.tracks.length,
    playlists: library.playlists.length,
    liked: library.likedTracks.length,
    restored: player.current && player.current.title,
    queue: player.queue.length,
    eq: player.eqEnabled,
  };
});
console.log('  ', JSON.stringify(after));
check('library survives reload', after.tracks === 5);
check('playlists survive reload', after.playlists >= 2, String(after.playlists));
check('likes survive reload', after.liked === 1);
check('session restored', !!after.restored, String(after.restored));
check('queue restored', after.queue === 3, String(after.queue));
check('eq setting restored', after.eq === true);

/* ---------------------------------------------------------------- deletion */
console.log('Delete');
const remaining = await page.evaluate(async () => {
  const { library } = await import('./js/library.js');
  await library.deleteTracks([library.songs[0].id]);
  return { tracks: library.tracks.length, playlistLen: (library.playlists.find((p) => p.name === 'Road Trip') || {}).trackIds.length };
});
check('track deleted', remaining.tracks === 4, JSON.stringify(remaining));
check('playlist reference cleaned up', remaining.playlistLen === 2, JSON.stringify(remaining));

console.log('');
console.log('--- page errors (' + errors.length + ') ---');
for (const e of [...new Set(errors)].slice(0, 20)) console.log('  ' + e);
console.log('');
console.log(pass + ' passed, ' + fail + ' failed');

await browser.close();
cleanup();
const failed = fail || errors.length;

/* ------------------------------------------------------------- fixtures */

/**
 * Write real, playable WAV files carrying an ID3 chunk with tags and cover
 * art. Building them here keeps binary test assets out of the repository and
 * means the test exercises the tag reader on bytes it did not itself produce
 * at parse time.
 */
function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-fixtures-'));

  const albums = [
    { album: 'Daybreak', artist: 'Aurora Fields', year: '2024', genre: 'Ambient', rgb: [255, 138, 76], tracks: [
      ['First Light', 392.0, 6, '1/3'], ['Second Wind', 523.25, 7, '2/3'], ['Slow Return', 329.63, 5, '3/3'] ] },
    { album: 'Transit', artist: 'Night Bus', year: '2023', genre: 'Electronic', rgb: [86, 132, 255], tracks: [
      ['Third Rail', 440.0, 6, '1/2'], ['Last Stop', 293.66, 8, '2/2'] ] },
  ];

  const files = [];
  for (const spec of albums) {
    const art = makePng(120, spec.rgb);
    for (const [title, freq, secs, trk] of spec.tracks) {
      const name = trk.split('/')[0].padStart(2, '0') + ' ' + title + '.wav';
      const target = path.join(dir, name);
      fs.writeFileSync(target, makeWav(freq, secs, {
        TIT2: title, TPE1: spec.artist, TALB: spec.album, TPE2: spec.artist,
        TRCK: trk, TYER: spec.year, TCON: spec.genre,
      }, art));
      files.push(target);
    }
  }

  files.sort();
  return { files, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makePng(size, [r, g, b]) {
  const chunk = (tag, data) => {
    const body = Buffer.concat([Buffer.from(tag), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const t = 0.55 + 0.45 * ((x + y) / (2 * size));
      row[1 + x * 3] = Math.round(r * t);
      row[2 + x * 3] = Math.round(g * t);
      row[3 + x * 3] = Math.round(b * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  // Cached on the function itself: fixtures are built before the module's
  // top-level statements run, so a module-scoped `let` would still be in its
  // temporal dead zone here.
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeWav(freq, secs, tags, art, sampleRate = 44100) {
  const NUL = Buffer.from([0]);
  const frames = Math.round(sampleRate * secs);
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const env = Math.min(1, i / (sampleRate * 0.04), (frames - i) / (sampleRate * 0.04));
    const s = (Math.sin(2 * Math.PI * freq * i / sampleRate)
      + 0.3 * Math.sin(4 * Math.PI * freq * i / sampleRate)) / 1.3;
    const v = Math.max(-32768, Math.min(32767, Math.round(17000 * env * s)));
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }

  const frame = (id, value) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(value, 'utf8'), NUL]);
    const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
    return Buffer.concat([Buffer.from(id), size, Buffer.alloc(2), body]);
  };
  const apic = () => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from('image/png'), NUL,
      Buffer.from([3]), Buffer.from('cover'), NUL, art]);
    const size = Buffer.alloc(4); size.writeUInt32BE(body.length);
    return Buffer.concat([Buffer.from('APIC'), size, Buffer.alloc(2), body]);
  };

  const frameData = Buffer.concat([
    ...Object.entries(tags).map(([id, value]) => frame(id, value)),
    apic(),
    Buffer.alloc(64),
  ]);
  const synch = Buffer.from([
    (frameData.length >> 21) & 127, (frameData.length >> 14) & 127,
    (frameData.length >> 7) & 127, frameData.length & 127,
  ]);
  let id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), synch, frameData]);
  if (id3.length % 2) id3 = Buffer.concat([id3, NUL]);

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0);
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(2, 10);
  fmt.writeUInt32LE(sampleRate, 12);
  fmt.writeUInt32LE(sampleRate * 4, 16);
  fmt.writeUInt16LE(4, 20);
  fmt.writeUInt16LE(16, 22);

  const id3Header = Buffer.alloc(8);
  id3Header.write('id3 ', 0);
  id3Header.writeUInt32LE(id3.length, 4);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0);
  dataHeader.writeUInt32LE(pcm.length, 4);

  const body = Buffer.concat([Buffer.from('WAVE'), fmt, id3Header, id3, dataHeader, pcm]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0);
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

process.exit(failed ? 1 : 0);
