/**
 * Online discovery.
 *
 * The archive is stubbed, so this checks our own behaviour rather than the
 * network: that both scopes exist, that results carry their licence, and above
 * all that quality is reported as the source actually provides it and the best
 * encoding of a track is the one offered.
 *
 *   node test/discover.test.mjs http://127.0.0.1:8099
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
const log = (...a) => fs.writeSync(1, a.join(' ') + '\n');
let pass=0, fail=0;
const check=(n,ok,x='')=>{if(ok){pass++;log('  ok   '+n);}else{fail++;log('  FAIL '+n+(x?' :: '+x:''));}};

const BASE = process.argv[2] || 'http://127.0.0.1:8099';



/**
 * Navigate the way the app itself does. The room is the only chrome, and it
 * only exists once there is something in the library, so these tests ask the
 * router directly rather than depending on a populated room. room.test.mjs is
 * the one that clicks the actual objects.
 */
async function open(page, view, extra = {}) {
  await page.evaluate(([v, x]) => {
    document.dispatchEvent(new CustomEvent('goto', { detail: { view: v, ...x } }));
  }, [view, extra]);
  await page.waitForTimeout(450);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});

// Stub the archive so the test does not depend on the network.
await page.route('**/advancedsearch.php*', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify({ response: { docs: [
    { identifier: 'gd1977', title: 'Barton Hall 1977', creator: 'Grateful Dead', date: '1977-05-08',
      downloads: 90210, licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/', subject: ['Live','Rock'] },
    { identifier: 'nl-002', title: 'Winter Sessions', creator: 'Blue Static', date: '2019', downloads: 12 },
  ] } }),
}));
await page.route('**/metadata/gd1977', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify({
    metadata: { title: 'Barton Hall 1977', creator: 'Grateful Dead', date: '1977-05-08',
      licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/', description: '<p>Soundboard.</p>' },
    files: [
      { name: 'gd77d1t01.flac', format: '24bit FLAC', title: 'Minglewood Blues', track: '1', length: '5:30', size: '90000000', 'audio-bits-per-sample': '24', 'audio-sample-rate': '96000' },
      { name: 'gd77d1t01.mp3', format: 'VBR MP3', title: 'Minglewood Blues', track: '1', length: '5:30', size: '8000000' },
      { name: 'gd77d1t02.flac', format: 'FLAC', title: 'Loser', track: '2', length: '7:12', size: '60000000' },
      { name: 'cover.jpg', format: 'JPEG' },
    ],
  }),
}));

await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await open(page, 'search');
await page.waitForTimeout(400);
check('search offers both scopes', (await page.locator('#search-tabs [data-scope]').count()) === 2);

await page.click('#search-tabs [data-scope="online"]');
await page.waitForTimeout(400);
await page.fill('#search-input', 'grateful dead');
await page.waitForTimeout(2200);

const rows = await page.locator('#discover-body .row').count();
check('online results appear', rows === 2, String(rows));
const firstText = await page.locator('#discover-body .row').first().textContent();
check('result shows the licence', /Public domain/.test(firstText), firstText.slice(0,80));

await page.locator('#discover-body .row').first().click();
await page.waitForTimeout(1200);
const sheet = await page.evaluate(() => document.getElementById('sheet').textContent);
check('release sheet lists tracks', /Minglewood Blues/.test(sheet) && /Loser/.test(sheet));
check('clock durations are read correctly', /5:30/.test(sheet) && /7:12/.test(sheet), sheet.slice(0, 240));
check('best quality is stated honestly', /Hi-Res FLAC 24\/96/.test(sheet), sheet.slice(0,200));
check('per-track quality shown', /FLAC lossless/.test(sheet));
check('the lossy duplicate is not offered', !/MP3 VBR/.test(sheet));

log(''); log('errors: ' + errors.length);
for (const e of [...new Set(errors)].slice(0,5)) log('  '+e);
log(pass+' passed, '+fail+' failed');
await browser.close();
process.exit(fail||errors.length?1:0);
