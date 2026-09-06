/**
 * The room.
 *
 * Home is a rendered studio and its equipment is the navigation, so the tests
 * are about the equipment: every object reachable by finger and by keyboard,
 * routed somewhere real, its own controls working as controls, and the room
 * alive while music plays. Nothing here is decoration.
 *
 * The renderer needs a GPU, so this asks headless Chromium for its software
 * one. A device without WebGL falls back to the drawn room, which is covered
 * at the end.
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
    await page.waitForTimeout(700);
  }
  await page.waitForSelector('.room .obj', { timeout: 9000 });
  await page.waitForTimeout(350);
}

const roomState = (page) => page.evaluate(async () => (await import('./js/room.js')).roomState());

const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await chromium.launch({ args:['--autoplay-policy=no-user-gesture-required', ...GL] });
const page = await browser.newPage({ viewport:{width:393,height:852}, deviceScaleFactor:2 });
const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.goto(BASE + '/index.html',{waitUntil:'networkidle'});
await page.waitForTimeout(900);
await page.setInputFiles('#file-input', files);
await page.waitForTimeout(6500);
await page.locator('[data-back]:visible').first().click();
await page.waitForTimeout(3000);

const boot = await roomState(page);
check('the studio is rendered', boot.ready && boot.webgl, JSON.stringify(boot));

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
const spinA = (await roomState(page)).platter;
await page.waitForTimeout(700);
const spinB = await roomState(page);
check('the deck turns while it plays', spinB.platter > spinA, spinA + ' -> ' + spinB.platter);
check('the meters move', spinB.meter > 0.05, String(spinB.meter));

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
const fader = page.locator('.room .ctl[data-band="0"]');
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
await page.waitForTimeout(1600);
const t1 = await roomState(page);
await page.waitForTimeout(2000);
const t2 = await roomState(page);
check('the tonearm tracks the playhead', t2.arm !== t1.arm, JSON.stringify([t1.arm, t2.arm]));
check('the capo chip walks down the neck', t2.capo !== t1.capo, JSON.stringify([t1.capo, t2.capo]));

// The camera walks to whatever you touch, then comes back.
await inRoom(page);
const still = (await roomState(page)).camera;
await page.locator('.room .obj[data-go="library"]').click();
await page.waitForTimeout(420);
const walking = (await roomState(page)).camera;
const shifted = walking.some((v, i) => Math.abs(v - still[i]) > 0.02);
check('the camera walks toward what you touched', shifted, JSON.stringify([still, walking]));
await page.waitForTimeout(1200);
await page.locator('[data-back]:visible').first().click();
await page.waitForTimeout(1200);
await inRoom(page);
const back = (await roomState(page)).camera;
check('and comes back to where it stands', back.every((v, i) => Math.abs(v - still[i]) < 0.02),
  JSON.stringify(back));

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

// A device with no WebGL still gets a room.
const plain = await browser.newPage({ viewport:{width:393,height:852} });
await plain.addInitScript(() => {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    if (String(kind).startsWith('webgl')) return null;
    return real.call(this, kind, ...rest);
  };
});
await plain.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await plain.waitForTimeout(900);
await plain.setInputFiles('#file-input', files);
await plain.waitForTimeout(6500);
await plain.locator('[data-back]:visible').first().click();
await plain.waitForTimeout(1500);
const drawn = await plain.evaluate(async () => ({
  objects: document.querySelectorAll('.room .obj').length,
  drawn: !!document.querySelector('.room .stage .world'),
  webgl: (await import('./js/room.js')).roomState().webgl,
}));
check('without WebGL the drawn room takes over',
  drawn.drawn && !drawn.webgl && drawn.objects >= 7, JSON.stringify(drawn));
await plain.close();

log(''); log('errors: '+errors.length);
for (const e of [...new Set(errors)].slice(0,5)) log('  '+e);
log(pass+' passed, '+fail+' failed');
await browser.close();
cleanup();
process.exit(fail||errors.length?1:0);
