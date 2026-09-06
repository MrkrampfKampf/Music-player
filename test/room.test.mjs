/**
 * The room.
 *
 * Home is the studio, so its objects are the navigation and have to work as
 * such: reachable by keyboard, routed somewhere real, and alive while music
 * plays. Nothing here is decoration.
 *
 *   node test/room.test.mjs http://127.0.0.1:8099
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import { makeFixtures } from './fixtures.mjs';
const log=(...a)=>fs.writeSync(1,a.join(' ')+'\n');
let pass=0,fail=0; const check=(n,ok,x='')=>{if(ok){pass++;log('  ok   '+n);}else{fail++;log('  FAIL '+n+(x?' :: '+x:''));}};
const BASE = process.argv[2] || 'http://127.0.0.1:8099';
const { files, cleanup } = makeFixtures();

/** The room is the only way around, so get back to it before touching an object. */
async function inRoom(page) {
  if (!(await page.isVisible('[data-view="home"]'))) {
    await page.locator('[data-back]:visible').first().click();
    await page.waitForTimeout(450);
  }
  await page.waitForSelector('.room .obj', { timeout: 8000 });
}

const browser = await chromium.launch({ args:['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport:{width:393,height:852}, deviceScaleFactor:2 });
const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(BASE + '/index.html',{waitUntil:'networkidle'});
await page.waitForTimeout(900);
await page.setInputFiles('#file-input', files);
await page.waitForTimeout(6500);
await page.locator('[data-back]:visible').first().click();
await page.waitForTimeout(1200);

const objs = await page.evaluate(() => [...document.querySelectorAll('.room .obj')].map(o => o.dataset.go));
check('the room has working objects', objs.length >= 7, JSON.stringify(objs));
check('every object routes somewhere', objs.every(Boolean));
check('all are reachable by keyboard', await page.evaluate(() =>
  [...document.querySelectorAll('.room .obj')].every(o => o.tabIndex === 0)));

// Speakers start the music.
await inRoom(page);
await page.locator('.room .obj[data-go="toggle"]').first().click();
await page.waitForTimeout(1800);
check('the speakers start the music', await page.evaluate(async()=> (await import('./js/player.js')).player.playing));
await page.waitForTimeout(1200);

// The room moves with the audio.
const moved = await page.evaluate(() => {
  const a = document.querySelector('.room .platter').style.transform;
  return new Promise(r => setTimeout(() => r(a !== document.querySelector('.room .platter').style.transform), 400));
});
check('the deck turns while it plays', moved);
const vu = await page.evaluate(() => document.querySelector('.room .needle').style.transform);
check('the meters move', /rotate/.test(vu), vu);

// The crate walks you to the library.
await inRoom(page);
await page.locator('.room .obj[data-go="library"]').click();
await page.waitForTimeout(900);
check('the crate opens the library', await page.isVisible('[data-view="library"]'));

await page.locator('[data-back]:visible').first().click(); await page.waitForTimeout(900);
await inRoom(page);
await page.locator('.room .obj[data-go="settings"]').click();
await page.waitForTimeout(800);
check('the console opens settings', await page.isVisible('[data-view="settings"]'));

await page.locator('[data-back]:visible').first().click(); await page.waitForTimeout(900);
await inRoom(page);
await page.locator('.room .obj[data-go="find"]').click();
await page.waitForTimeout(800);
const tuner = { visible: await page.isVisible('[data-view="search"]'),
  online: await page.getAttribute('#search-tabs [data-scope="online"]','aria-selected') };
check('the tuner opens online search', tuner.visible && tuner.online === 'true', JSON.stringify(tuner));

await page.locator('[data-back]:visible').first().click(); await page.waitForTimeout(900);
await page.evaluate(async()=>{ const {player}=await import('./js/player.js'); player.pause(); player.setShuffle(false); });
await inRoom(page);
await page.locator('.room .obj[data-go="shuffle"]').click();
await page.waitForTimeout(1600);
check('the guitar shuffles everything', await page.evaluate(async()=>{
  const {player}=await import('./js/player.js'); return player.shuffle && player.queue.length > 1; }));

// The objects are the interface, so their own parts have to work.
await inRoom(page);
const fader = page.locator('.room [data-band="0"]');
const before = await page.evaluate(async () => (await import('./js/settings.js')).settings.eqGains[0]);
const fb = await fader.boundingBox();
await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
await page.mouse.down();
await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2 - 26, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
const after = await page.evaluate(async () => (await import('./js/settings.js')).settings.eqGains[0]);
check('a console fader really moves the equaliser', after > before + 2, before + ' -> ' + after);
check('dragging a fader does not walk you out of the room', await page.isVisible('[data-view="home"]'));

// The tonearm is the playhead and the capo chip is the progress bar.
await page.evaluate(async () => {
  const { player } = await import('./js/player.js');
  const { library } = await import('./js/library.js');
  if (!player.current) await player.play(library.songs, 0);
  else if (!player.playing) await player.play(player.queue, player.index);
});
await page.waitForTimeout(1500);
const read = () => page.evaluate(() => ({
  arm: document.querySelector('.room [data-arm]').style.getPropertyValue('--a'),
  chip: document.querySelector('.room [data-chip]').style.getPropertyValue('--t'),
}));
const t1 = await read();
await page.waitForTimeout(1800);
const t2 = await read();
check('the tonearm tracks the playhead', t1.arm !== t2.arm, JSON.stringify([t1.arm, t2.arm]));
check('the capo chip walks down the neck', t1.chip !== t2.chip, JSON.stringify([t1.chip, t2.chip]));

// The camera walks to whatever you touch, then comes back.
await inRoom(page);
// The commanded camera, not the interpolated one: headless Chromium does not
// always tick a composited transition, but the command is what we set.
const camAt = () => page.evaluate(() => document.querySelector('.world').style.transform);
const still = await camAt();
await page.locator('.room .obj[data-go="library"]').click();
await page.waitForTimeout(120);
const walking = await camAt();
check('the camera moves toward what you touched', walking !== still, walking);
await page.waitForTimeout(900);
await page.locator('[data-back]:visible').first().click();
await page.waitForTimeout(900);

// The light switch by the door is the way through for anyone in a hurry.
await inRoom(page);
await page.click('.room-switch');
await page.waitForTimeout(250);
check('the light switch lists the room', await page.isVisible('.room-menu'));
await page.locator('.room-menu button', { hasText: 'Settings' }).click();
await page.waitForTimeout(700);
check('and it gets you there', await page.isVisible('[data-view="settings"]'));
await page.locator('[data-back]:visible').first().click();
await page.waitForTimeout(700);

log(''); log('errors: '+errors.length);
for (const e of [...new Set(errors)].slice(0,5)) log('  '+e);
log(pass+' passed, '+fail+' failed');
await browser.close();
cleanup();
process.exit(fail||errors.length?1:0);
