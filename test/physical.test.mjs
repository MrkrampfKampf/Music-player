/**
 * The controls as physical parts.
 *
 * The deck is only convincing if its parts behave: the platter carries
 * momentum, the cue lever throws, the arm tracks a finger, keys travel. None
 * of that is visible in a screenshot, so it gets driven here.
 *
 *   npx http-server -p 8099 -c-1 .
 *   node test/physical.test.mjs http://127.0.0.1:8099
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import { makeFixtures } from './fixtures.mjs';
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');
let pass = 0, fail = 0;
const check = (n, ok, x='') => { if (ok) { pass++; log('  ok   '+n); } else { fail++; log('  FAIL '+n+(x?' :: '+x:'')); } };

const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const { files, cleanup } = makeFixtures();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.setInputFiles('#file-input', files);
await page.waitForTimeout(6500);
await page.evaluate(async () => {
  const { library } = await import('./js/library.js');
  const { player } = await import('./js/player.js');
  await player.play(library.songs, 0);
});
await page.waitForTimeout(2200);
// The player bar is gone; what is left of #mini is the keyboard route to the
// player, so open it the way a keyboard would.
await page.focus('#mini');
await page.keyboard.press('Enter');
await page.waitForTimeout(1400);

const rot = () => page.evaluate(() => {
  const t = getComputedStyle(document.getElementById('platter-spin')).transform;
  if (!t || t === 'none') return 0;
  const m = t.match(/matrix\(([^)]+)\)/);
  if (!m) return 0;
  const [a, b] = m[1].split(',').map(Number);
  return Math.round(Math.atan2(b, a) * 180 / Math.PI);
});

const r1 = await rot();
await page.waitForTimeout(500);
const r2 = await rot();
check('the platter is turning', r1 !== r2, r1 + ' -> ' + r2);

// Coast down rather than stop dead.
await page.evaluate(async () => { const { player } = await import('./js/player.js'); player.pause(); });
await page.waitForTimeout(90);
const c1 = await rot();
await page.waitForTimeout(120);
const c2 = await rot();
check('it coasts after pause instead of stopping dead', c1 !== c2, c1 + ' -> ' + c2);
await page.waitForTimeout(2000);
const s1 = await rot();
await page.waitForTimeout(400);
check('and it does come to rest', (await rot()) === s1, String(s1));

await page.evaluate(async () => { const { player } = await import('./js/player.js'); await player.resume(); });
await page.waitForTimeout(1500);

// The cue lever throws on a drag.
const cue = await page.locator('#np-play').boundingBox();
const playingBefore = await page.evaluate(async () => (await import('./js/player.js')).player.playing);
await page.mouse.move(cue.x + cue.width * 0.75, cue.y + cue.height / 2);
await page.mouse.down();
await page.mouse.move(cue.x + cue.width * 0.15, cue.y + cue.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(700);
const playingAfter = await page.evaluate(async () => (await import('./js/player.js')).player.playing);
check('dragging the cue lever back stops it', playingBefore === true && playingAfter === false,
  playingBefore + ' -> ' + playingAfter);

// Dragging the arm seeks.
await page.evaluate(async () => { const { player } = await import('./js/player.js'); await player.resume(); player.seek(0.5); });
await page.waitForTimeout(700);
const deck = await page.locator('#deck').boundingBox();
const before = await page.evaluate(async () => (await import('./js/player.js')).player.currentTime);
const arm = await page.locator('#tonearm').boundingBox();
await page.mouse.move(arm.x + arm.width * 0.30, arm.y + arm.height * 0.80);
await page.mouse.down();
await page.mouse.move(deck.x + deck.width * 0.62, deck.y + deck.height * 0.72, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(900);
const after = await page.evaluate(async () => (await import('./js/player.js')).player.currentTime);
check('dragging the tonearm seeks', Math.abs(after - before) > 0.7, before.toFixed(2) + ' -> ' + after.toFixed(2));

// Buttons depress.
const pushed = await page.evaluate(() => {
  const b = document.getElementById('np-next');
  b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const on = b.classList.contains('pushed');
  b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  return { on, off: !b.classList.contains('pushed') };
});
check('keys depress and spring back', pushed.on && pushed.off, JSON.stringify(pushed));

/* The equaliser is ten vertical faders. They are range inputs turned on their
   side, because a vertical writing mode leaves the input 26 px tall however it
   is styled and only the top of the slot answers a finger. */
await page.evaluate(async () => {
  const { closePlayer } = await import('./js/nowplaying.js');
  closePlayer();
  const { renderSettings } = await import('./js/settings.js');
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== 'settings';
  // Put the shell in the state the router would leave it in: out of the room
  // and standing at the console. Without this the panel is still the
  // click-through home layer and nothing on it can be touched.
  document.body.classList.remove('in-room');
  document.body.dataset.at = 'settings';
  await renderSettings(document.getElementById('settings-body'));
});
await page.waitForTimeout(700);
const eqSwitch = page.locator('[data-view="settings"] .setting', { hasText: 'Equaliser' }).locator('.switch');
if (await eqSwitch.count()) { await eqSwitch.first().click(); await page.waitForTimeout(600); }

// The panel is the lower part of the screen now, so the desk has to be
// scrolled to before a finger can reach it.
await page.locator('.eq-band .slot').first().scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
const slotBox = await page.locator('.eq-band .slot').first().boundingBox();
const inputBox = await page.locator('.eq-band input').first().boundingBox();
check('a fader covers the whole of its slot',
  inputBox && slotBox && inputBox.height > slotBox.height * 0.9,
  JSON.stringify({ slot: slotBox && Math.round(slotBox.height), input: inputBox && Math.round(inputBox.height) }));

const gainBefore = await page.evaluate(async () => (await import('./js/settings.js')).settings.eqGains[0]);
await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height * 0.75);
await page.mouse.down();
await page.mouse.move(slotBox.x + slotBox.width / 2, slotBox.y + slotBox.height * 0.15, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(500);
const gainAfter = await page.evaluate(async () => (await import('./js/settings.js')).settings.eqGains[0]);
check('dragging a fader moves the band it is labelled with', gainAfter > gainBefore + 2,
  gainBefore + ' -> ' + gainAfter);

log('');
log('errors: ' + errors.length);
for (const e of [...new Set(errors)].slice(0, 5)) log('  ' + e);
log(pass + ' passed, ' + fail + ' failed');
await browser.close();
cleanup();
process.exit(fail || errors.length ? 1 : 0);
