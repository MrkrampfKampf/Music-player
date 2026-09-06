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
import { makeFixtures, makeOneOff } from './fixtures.mjs';

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

/* -------------------------------------------------- the file picker itself */
console.log('The import controls');
{
  await page.evaluate(() => {
    document.getElementById('np').hidden = true;
    document.body.style.overflow = '';
  });
  await page.click('[data-nav="add"]');
  await page.waitForTimeout(500);

  // An accept list greys out files iOS has no type for, so there must not be one.
  const accept = await page.getAttribute('#file-input', 'accept');
  check('the picker is not filtered by type', accept === null, String(accept));
  check('the picker takes several files at once',
    (await page.getAttribute('#file-input', 'multiple')) !== null);

  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('#add-body button')].map((b) => b.textContent.trim()));
  check('there is a Spotify folder button', buttons.some((b) => /Spotify folder/i.test(b)), JSON.stringify(buttons));

  await page.click('#add-body button:has-text("Spotify folder")');
  await page.waitForTimeout(500);
  const sheet = await page.evaluate(() => {
    const host = document.getElementById('sheet-host');
    return { open: !host.hidden, steps: host.querySelectorAll('.setting').length, text: host.textContent };
  });
  check('it explains the route', sheet.open && sheet.steps === 3, JSON.stringify({ open: sheet.open, steps: sheet.steps }));
  check('it names the actual folder', /On My iPhone/.test(sheet.text) && /Spotify folder/.test(sheet.text));
  check('it warns about copying', /copies each file/.test(sheet.text));

  await page.evaluate(() => document.querySelector('.sheet-backdrop').click());
  await page.waitForTimeout(400);
}

/* ------------------------------------------------- safe-to-delete listing */
console.log('Telling the user what is safe to delete');
{
  // The player is still open from the transport checks and covers the tab bar.
  await page.evaluate(() => {
    document.getElementById('np').hidden = true;
    document.body.style.overflow = '';
  });
  await page.click('[data-nav="add"]');
  await page.waitForTimeout(500);
  await page.setInputFiles('#file-input', files);
  await page.waitForTimeout(5000);

  const panel = await page.locator('#safe-to-delete').count();
  check('the safe-to-delete panel appears', panel === 1, String(panel));

  const named = await page.evaluate(() =>
    [...document.querySelectorAll('#safe-to-delete .safe-file')].map((r) => r.textContent));
  check('every imported file is named', named.length === 5, JSON.stringify(named));
  check('the names are the real filenames',
    named.length > 0 && named.every((n) => n.endsWith('.wav')), JSON.stringify(named));

  await page.click('#safe-to-delete button');
  await page.waitForTimeout(300);
  check('the panel dismisses', (await page.locator('#safe-to-delete').count()) === 0);
}

/* ------------------------------------------------------------- re-import */
console.log('Re-importing the same folder');
{
  const before = await page.evaluate(async () => {
    const { library } = await import('./js/library.js');
    return library.tracks.length;
  });

  await page.setInputFiles('#file-input', files);
  await page.waitForTimeout(5000);

  const after = await page.evaluate(async () => {
    const { library } = await import('./js/library.js');
    return library.tracks.length;
  });
  check('re-importing adds no duplicates', after === before, before + ' -> ' + after);

  // A genuinely new file still gets in.
  const extra = makeOneOff();
  await page.setInputFiles('#file-input', [extra.path]);
  await page.waitForTimeout(3500);
  const grown = await page.evaluate(async () => {
    const { library } = await import('./js/library.js');
    return { n: library.tracks.length, has: library.tracks.some((t) => t.title === 'One Off') };
  });
  check('a new file is still imported', grown.n === before + 1 && grown.has, JSON.stringify(grown));
  extra.cleanup();

  // Clean up so the counts below match what the rest of the test expects.
  await page.evaluate(async () => {
    const { library } = await import('./js/library.js');
    const t = library.tracks.find((x) => x.title === 'One Off');
    if (t) await library.deleteTracks([t.id]);
  });
  await page.waitForTimeout(800);
}

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

process.exit(failed ? 1 : 0);
