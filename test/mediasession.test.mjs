/**
 * Lock screen controls.
 *
 * iOS decides which buttons to show from which Media Session actions a page
 * claims, and claiming the wrong ones takes away the ones people reach for.
 * There is no way to read back what is registered, so this wraps the API
 * before any page script runs and records the calls.
 *
 * Needs Playwright and the app served locally:
 *   npx http-server -p 8099 -c-1 .
 *   node test/mediasession.test.mjs http://127.0.0.1:8099
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import { makeFixtures } from './fixtures.mjs';

const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');
const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const { files, cleanup } = makeFixtures();

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; log('  ok   ' + name); }
  else { fail++; log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
page.on('pageerror', (e) => log('  [pageerror]', e.message));

// Record every setActionHandler call, before the app gets a chance to run.
await page.addInitScript(() => {
  window.__actions = [];
  const wire = () => {
    if (!navigator.mediaSession || !navigator.mediaSession.setActionHandler) return false;
    const real = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      window.__actions.push({ action, kind: typeof handler, atTrack: !!navigator.mediaSession.metadata });
      return real(action, handler);
    };
    return true;
  };
  wire();
});

await page.goto(BASE + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(2000);

/* ------------------------------------------- registered before any playback */

const early = await page.evaluate(() => window.__actions.slice());
log('  ' + JSON.stringify(early.map((a) => a.action + ':' + a.kind)));

const claimed = early.filter((a) => a.kind === 'function').map((a) => a.action);
const released = early.filter((a) => a.kind === 'object' || a.kind === 'undefined').map((a) => a.action);

check('play is claimed', claimed.includes('play'));
check('pause is claimed', claimed.includes('pause'));
check('previous track is claimed', claimed.includes('previoustrack'));
check('next track is claimed', claimed.includes('nexttrack'));
check('scrubbing is claimed', claimed.includes('seekto'));

// The whole point: iOS swaps the track skip buttons for 15 second arrows when
// these are claimed, so they must be explicitly left alone.
check('15s back is NOT claimed', !claimed.includes('seekbackward'), JSON.stringify(claimed));
check('15s forward is NOT claimed', !claimed.includes('seekforward'), JSON.stringify(claimed));
check('both are explicitly released', released.includes('seekbackward') && released.includes('seekforward'),
  JSON.stringify(released));

check('everything is wired before a track exists', early.every((a) => a.atTrack === false),
  JSON.stringify(early.map((a) => a.action + '@' + a.atTrack)));

/* -------------------------------------------------- still right while playing */

await page.setInputFiles('#file-input', files);
await page.waitForTimeout(6000);

await page.evaluate(async () => {
  const { library } = await import('./js/library.js');
  const { player } = await import('./js/player.js');
  await player.play(library.songs, 0);
});
await page.waitForTimeout(2500);

const meta = await page.evaluate(() => {
  const m = navigator.mediaSession.metadata;
  return m ? { title: m.title, artist: m.artist, album: m.album, art: m.artwork.length } : null;
});
check('lock screen shows the track', meta && meta.title === 'First Light', JSON.stringify(meta));
check('lock screen shows the artist', meta && meta.artist === 'Aurora Fields');
check('lock screen has artwork', meta && meta.art > 0);

const afterPlay = await page.evaluate(() =>
  window.__actions.filter((a) => a.kind === 'function').map((a) => a.action));
check('playing claims no extra actions', !afterPlay.includes('seekbackward') && !afterPlay.includes('seekforward'),
  JSON.stringify(afterPlay));

/* --------------------------------- one element keeps the session on iOS */

const before = await page.evaluate(async () => {
  const { player } = await import('./js/player.js');
  return { active: player._active, two: player._usesTwoElements };
});
check('a single element is used by default', before.two === false && before.active === 0, JSON.stringify(before));

await page.evaluate(async () => {
  const { player } = await import('./js/player.js');
  await player.next();
});
await page.waitForTimeout(2500);

const after = await page.evaluate(async () => {
  const { player } = await import('./js/player.js');
  return { active: player._active, playing: player.playing, index: player.index, title: player.current.title };
});
check('skipping keeps the same element', after.active === 0, JSON.stringify(after));
check('skipping actually advances and plays', after.index === 1 && after.playing === true, JSON.stringify(after));

const state = await page.evaluate(() => navigator.mediaSession.playbackState);
check('playback state is reported as playing', state === 'playing', String(state));

/* -------------------------------------------- the handlers really do work */

const acted = await page.evaluate(async () => {
  const { player } = await import('./js/player.js');
  const startIndex = player.index;
  player.pause();
  const paused = !player.playing;
  await player.resume();
  await new Promise((r) => setTimeout(r, 600));
  const resumed = player.playing;
  await player.next();
  await new Promise((r) => setTimeout(r, 900));
  return { paused, resumed, advanced: player.index === startIndex + 1, playing: player.playing };
});
check('pause then play works, not just pause', acted.paused && acted.resumed, JSON.stringify(acted));
check('next moves on and keeps playing', acted.advanced && acted.playing, JSON.stringify(acted));

log('');
log(pass + ' passed, ' + fail + ' failed');
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
